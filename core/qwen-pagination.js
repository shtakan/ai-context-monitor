// =============================================================================
// core/qwen-pagination.js — O-53: курсорная пагинация истории chat.qwen.ai (вариант B).
//
// Замер probe (2026-10-29, чат ab45dc99-cbab-435e-b0d3-f0440f6422df):
//   data.chat.history.pagination = { enabled, oldest_id, newest_id,
//                                    has_more_older, has_more_newer, path_count }
// oldest_id — UUID-курсор СТАРШЕЙ страницы, has_more_older — авторитетный флаг «старше
// есть». Проверено: GET /api/v2/chats/{id}?direction=up&limit=10&cursor=<oldest_id>
// отдаёт ДРУГУЮ (более старую) страницу; курсор эксклюзивный (сам не повторяется), но
// на границе страниц может прийти соседний по parentId ход — дедуп по ключу всё равно нужен.
//
// Модуль ЧИСТЫЙ: никакой сети и состояния — только URL, разбор payload, решение о шаге
// и перенумерация ходов. Подключается отдельным content-script ПЕРЕД
// core/qwen-intercept.js (window.AiCmQwenPagination) и как CommonJS для тестов.
// =============================================================================
(function () {
  if (typeof window !== 'undefined' && window.AiCmQwenPagination) return;

  // Курсор Qwen — UUID (поле pagination.oldest_id, а не generic next_cursor).
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // limit=10 — ровно столько турнов (пар user+assistant) отдаёт сайт на страницу.
  var PAGE_LIMIT = 10;
  // Страховочные потолки одного прогона (как у Gemini, но короче: страницы Qwen тяжёлые).
  var DEFAULT_PAGE_CAP = 10;
  var DEFAULT_TIME_CAP_MS = 30000;
  var PAGE_DEPTH_CAP = 6;
  var MESSAGE_DEPTH_CAP = 8;
  // Generic-имена курсора — на случай дрейфа схемы (сейчас их в payload нет).
  var CURSOR_NAMES = ['next_cursor', 'nextCursor', 'cursor', 'page_token', 'next_page_token'];
  // R1 (v111): «мягкий финал» пагинации — база НЕПОЛНАЯ, но продолжать нечем/незачем:
  //   time-cap / page-cap — исчерпан наш страховочный потолок при живом курсоре;
  //   no-gain — страница не дала ходов (граница истории при живом курсоре).
  // Это не фатальная ошибка (error/cursor-loop): автоэкспорт разрешён с [LOW CONFIDENCE]_.
  // Классификация причин живёт ТОЛЬКО здесь — в пайплайн/export-manager уходит булев.
  var SOFT_PARTIAL_REASONS = ['time-cap', 'page-cap', 'no-gain'];

  function isUuid(v) {
    return typeof v === 'string' && UUID_RE.test(v);
  }

  // R1: причина финала пагинации относится к «мягким» (см. SOFT_PARTIAL_REASONS).
  function isSoftPartialReason(reason) {
    return SOFT_PARTIAL_REASONS.indexOf(String(reason || '')) !== -1;
  }

  // Обход JSON в порядке появления ключей; visit(node) === false останавливает обход.
  // Массивы не посещаются (visit только для объектов), но их элементы — да.
  function walkObjects(root, maxDepth, visit) {
    var seen = [];
    var stopped = false;
    function walk(node, depth) {
      if (stopped || !node || typeof node !== 'object' || depth > maxDepth) return;
      if (seen.indexOf(node) !== -1) return;
      seen.push(node);
      if (!Array.isArray(node) && visit(node) === false) { stopped = true; return; }
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length && !stopped; i++) {
        var child = node[keys[i]];
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    }
    walk(root, 0);
  }

  // URL следующей (более старой) страницы. Пустой курсор — базовая страница как есть.
  // Базовый URL уже несёт direction=up&limit=10 — параметры перезаписываются, не дублируются.
  function historyPageUrl(baseUrl, cursor) {
    var base = String(baseUrl == null ? '' : baseUrl);
    var cur = (typeof cursor === 'string') ? cursor : '';
    if (!cur) return base;
    try {
      var u = new URL(base);
      u.searchParams.set('cursor', cur);
      u.searchParams.set('direction', 'up');
      u.searchParams.set('limit', String(PAGE_LIMIT));
      return u.toString();
    } catch (eUrl) {
      // Фолбэк без конструктора URL: база может уже нести query — собираем её заново.
      var cut = base.indexOf('?');
      var path = (cut === -1) ? base : base.slice(0, cut);
      return path + '?direction=up&limit=' + PAGE_LIMIT + '&cursor=' + encodeURIComponent(cur);
    }
  }

  // Единственный авторитетный источник: data.chat.history.pagination.
  // { found, hasMoreOlder: true|false|null, oldest: <uuid|''> }
  function paginationInfo(payload) {
    var out = { found: false, hasMoreOlder: null, oldest: '' };
    walkObjects(payload, PAGE_DEPTH_CAP, function (obj) {
      var hasFlag = (typeof obj.has_more_older === 'boolean');
      var hasOldest = (typeof obj.oldest_id === 'string');
      if (!hasFlag && !hasOldest) return undefined;
      out.found = true;
      if (hasFlag) out.hasMoreOlder = obj.has_more_older;
      if (hasOldest) out.oldest = isUuid(obj.oldest_id) ? obj.oldest_id : '';
      return false;
    });
    return out;
  }

  // Курсор следующей страницы: '' означает «дальше не идём».
  //   1) pagination.oldest_id (UUID) при has_more_older !== false;
  //   2) иначе — generic-имена с UUID-значением (дрейф схемы), has_more === false — вето.
  function nextCursorOf(payload) {
    var info = paginationInfo(payload);
    if (info.found) {
      if (info.hasMoreOlder === false) return '';
      return info.oldest;
    }
    var generic = '';
    var genericHasMore = null;
    walkObjects(payload, PAGE_DEPTH_CAP, function (obj) {
      for (var i = 0; i < CURSOR_NAMES.length; i++) {
        var v = obj[CURSOR_NAMES[i]];
        if (!isUuid(v)) continue;
        generic = v;
        if (typeof obj.has_more === 'boolean') genericHasMore = obj.has_more;
        if (typeof obj.hasMore === 'boolean') genericHasMore = obj.hasMore;
        return false;
      }
      return undefined;
    });
    if (generic && genericHasMore === false) return '';
    return generic;
  }

  // Фолбэк, когда pagination в payload нет вовсе (дрейф схемы): самый старый id страницы.
  // Опора — timestamp (у user-сообщений он есть); без timestamp — первый по порядку обхода.
  function oldestMessageId(payload) {
    var bestId = '';
    var bestTs = null;
    var firstId = '';
    walkObjects(payload, MESSAGE_DEPTH_CAP, function (obj) {
      var role = obj.role;
      if (role !== 'user' && role !== 'assistant') return undefined;
      var id = isUuid(obj.id) ? obj.id : '';
      if (!id) return undefined;
      if (!firstId) firstId = id;
      var ts = (typeof obj.timestamp === 'number' && isFinite(obj.timestamp)) ? obj.timestamp : null;
      if (ts === null) return undefined;
      if (bestTs === null || ts < bestTs) { bestTs = ts; bestId = id; }
      return undefined;
    });
    return bestId || firstId;
  }

  // Решение о следующем шаге — тот же контракт, что у Gemini
  // (utils/gemini-intercept-logic.js:959-985): потолки → продолжение по курсору → конец.
  // state = { hasCursor, pages, elapsedMs, added, failedPage }
  // Возвращает { action: 'continue'|'complete'|'cap', reason, reachedStart, baseComplete, warn }.
  function pageStepDecision(state, caps) {
    caps = caps || {};
    var pageCap = (typeof caps.pageCap === 'number' && caps.pageCap > 0) ? caps.pageCap : DEFAULT_PAGE_CAP;
    var timeCapMs = (typeof caps.timeCapMs === 'number' && caps.timeCapMs > 0) ? caps.timeCapMs : DEFAULT_TIME_CAP_MS;
    var hasCursor = !!(state && state.hasCursor);
    var pages = (state && typeof state.pages === 'number') ? state.pages : 0;
    var elapsedMs = (state && typeof state.elapsedMs === 'number') ? state.elapsedMs : 0;
    var added = (state && typeof state.added === 'number') ? state.added : 0;
    var failedPage = !!(state && state.failedPage);

    if (pages >= pageCap) {
      return { action: 'cap', reason: 'page-cap', reachedStart: false, baseComplete: false, warn: 'страховочный потолок страниц достигнут (' + pageCap + ')' };
    }
    if (elapsedMs >= timeCapMs) {
      return { action: 'cap', reason: 'time-cap', reachedStart: false, baseComplete: false, warn: 'страховочный потолок времени достигнут (' + timeCapMs + 'мс)' };
    }
    if (hasCursor) {
      return { action: 'continue', reason: 'cursor-alive', reachedStart: false, baseComplete: false, warn: '' };
    }
    // Конец старших страниц. У Qwen «добавил 0 ходов» на корневой странице — норма
    // (все её ходы уже в базе), поэтому added не обнуляет честный конец: решает курсор.
    var rs = !failedPage;
    return { action: 'complete', reason: (rs ? 'end' : 'no-start'), reachedStart: rs, baseComplete: rs, warn: '' };
  }

  // Перенумерация ходов страницы: более старая страница получает МЕНЬШИЕ order
  // (сортировка turns по order даёт oldest→newest). created — [{turn, created}] или turns.
  // Возвращает новый «пол» (минимальный занятый order) для следующей страницы.
  function assignPageOrders(created, floor) {
    var list = Array.isArray(created) ? created : [];
    var n = list.length;
    var start = (typeof floor === 'number' && isFinite(floor)) ? floor : 0;
    var base = start - n;
    for (var i = 0; i < n; i++) {
      var item = list[i];
      var turn = (item && typeof item === 'object' && item.turn) ? item.turn : item;
      if (turn && typeof turn === 'object') turn.order = base + i;
    }
    return base;
  }

  var Fn = {
    UUID_RE: UUID_RE,
    PAGE_LIMIT: PAGE_LIMIT,
    DEFAULT_PAGE_CAP: DEFAULT_PAGE_CAP,
    DEFAULT_TIME_CAP_MS: DEFAULT_TIME_CAP_MS,
    SOFT_PARTIAL_REASONS: SOFT_PARTIAL_REASONS,
    isUuid: isUuid,
    isSoftPartialReason: isSoftPartialReason,
    historyPageUrl: historyPageUrl,
    paginationInfo: paginationInfo,
    nextCursorOf: nextCursorOf,
    oldestMessageId: oldestMessageId,
    pageStepDecision: pageStepDecision,
    assignPageOrders: assignPageOrders
  };

  if (typeof window !== 'undefined') window.AiCmQwenPagination = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
})();
