// core/gemini-intercept.js  (v26 = v25 + пол (floor) через sessionStorage, чтобы индикатор
// не падал после F5/переоткрытия, когда загрузочный снапшот содержит меньше ходов, чем живая сессия;
// floor сохраняется при каждом EMIT с historyFullByQuiet=true, восстанавливается при загрузке)
// Перехватчик Gemini в МИРЕ САЙТА (world: "MAIN"), document_start. Регистрация — background.js.
// В этом шаге меняется ТОЛЬКО этот файл. content.js (v1.18) / background / manifest / адаптеры / model-config — НЕ ТРОГАТЬ.
//
// v18 (фикс запуска тихой пагинации): в v17 при добавлении сброса чата была потеряна строка
//   `pendingCursor = extractCursor(turns);` в handleOuter. Из-за этого extractCursor (которая находит
//   opaque-курсор в ответе — рентген его видел: turn1 len=305 "tCt4BAee…") НИКОГДА не вызывалась,
//   pendingCursor всегда оставался null, и тихий цикл не стартовал → всегда фолбэк на автоскролл →
//   недетерминированная полная история → разница % между переключением чата и F5.
//   Фикс: добавлена одна строка в handleOuter после рентгена. Теперь pendingCursor заполняется реальным
//   курсором из ответа, тихий цикл стартует и идёт по цепочке курсоров, собирая полную историю детерминированно
//   (без автоскролла). Это должно устранить разницу переключение/F5, потому что оба сценария будут собирать
//   историю по серверным курсорам, а не по DOM-скроллу.
//
// v17 (фикс «перекрёстного накопления» между чатами): Gemini — SPA, переключение чатов идёт без
//   перезагрузки страницы через history.pushState/replaceState (+popstate). Накопители перехватчика
//   (turnsMap/attachSeen/attachTokens/счётчики/флаги) раньше жили всю жизнь страницы и перетекали из чата A
//   в чат B при переключении → индикатор стартовал на B с чужим багажом (завышенное первое показание).
//   Теперь: оборачиваем pushState/replaceState, слушаем popstate; при смене convId в /app/<id> вызываем
//   resetForNewConversation() — чистим накопители и диспатчим 'ai-cm-conversation-changed' для виджета.
//   Сброс срабатывает ТОЛЬКО при смене id чата (не на любой pushState), поэтому внутри одного чата ничего
//   не моргает. При полной загрузке (F5/закладка) скрипт и так стартует чистым — логика закрывает именно SPA-зазор.
//   Метаданные сайта (заголовки/at) НЕ сбрасываем — они валидны для любого чата; convId для активного запроса
//   берётся из location.pathname в getConvId(), поэтому virtual-f5 автоматически бьёт в новый чат.
//
// v19: детерминированная полная история при SPA-переключении. При переключении чата сайт не всегда шлёт
//   загрузочный hNvQHb (пассивный снимок), поэтому тихая пагинация раньше стартовала недетерминированно.
//   Когда пассивного снимка нет, vf5-ответ содержит opaque-курсор (pendingCursor), но блок запуска
//   пагинации проверял !fromVirtualF5 — поэтому курсор игнорировался, и база оставалась vf5-хвостом
//   с неполными вложениями (наблюдено 37.8% при переключении против 41.7% после F5).
//   Теперь: в ingest добавлен отдельный блок для fromVirtualF5 — если история ещё не собрана
//   (!historyFullByQuiet), тихий цикл не активен (!quietActive) и в ответе есть курсор (pendingCursor),
//   запускаем paginateLoop. quietDecisionMade взводится сразу, чтобы пассивная ветка не стартовала
//   второй параллельный цикл при задержке пассивного ответа. Это закрывает лотерею: vf5 сам доберёт
//   старшее по курсору.
//
// v20: гард по convId на пассивную ловлю hNvQHb + защита автоскролла в переходном окне.
//   При переключении чата ответ на запрос старого чата может прийти после resetForNewConversation()
//   и лечь в базу нового чата (лишний ход, чужие вложения, завышенный процент). Vf5 этой болезнью
//   не страдает (строит запрос по getConvId из текущего location), но пассивная ловля (fetch/XHR)
//   вызывает ingest без проверки convId. Теперь: из тела запроса извлекаем reqConvId (двойной
//   JSON.parse: decode f.req → outer[0][0][1] → inner-строка → slots[0] без 'c_'), сохраняем
//   в замыкании/this.__aiCm, в обработчике ответа перед ingest сравниваем с currentConvId;
//   при несовпадении ответ игнорируется целиком. Дополнительно: флаг autoScrollBlocked запрещает
//   автоскролл после сброса чата, пока не придёт первый валидный (гарднутый) снимок нового чата;
//   таймаут 5000 мс принудительно снимает блокировку, чтобы индикатор не завис на 0% при кешевом
//   роутинге без сети.
//
// v21: закрытие слепоты fetch-гарда для Request-объектов. В v20 тело запроса извлекалось только
//   из init.body (строка); когда запрос — Request-объект (input instanceof Request), bodyStr
//   оставался '', convIdFromBody('') → '', и null-деградация пропускала чужой ответ.
//   Теперь: клонируем Request и читаем тело клона через .text() параллельно originalFetch
//   (не задерживая сетевой запрос); результат в reqConvIdPromise всегда резолвится строкой
//   (catch → ''). В обработчике ответа гард ждёт reqConvIdPromise.then() перед ingest.
//   Добавлен точный диагностический лог «гард слеп» с путём/input/init.body/cloneTextLen.
//
// v25: пересборка ветки при realtime-vf5. При vf5 после действий пользователя
//   (activeRefresh с rebuild=true) turnsMap сбрасывается перед обработкой vf5-блока,
//   и ветка собирается заново одной цепочкой — без «солянки» из старых+новых ходов.
//   Стоп-кран: если vf5-блок не содержит курсора (extractCursor=null) — пересборка
//   отменяется, поведение остаётся прежним (докидывание поверх).
//   Досбор хвоста после тихой пагинации (finishQuiet→activeRefresh) идёт c
//   rebuild=false, сохраняя текущее поведение.

// v24: подавление ложной кнопки «Ошибки» на плитке расширения (chrome://extensions).
//   Причина: обёртка window.fetch подменяет оригинал, поэтому ЛЮБОЙ fetch страницы создаёт
//   промис внутри нашей обёртки. Когда чужой запрос страницы отклоняется без обработчика
//   (Failed to fetch при навигации/переключении/обрыве стрима), браузер видит unhandled
//   rejection и, поскольку промис создан в обёртке, приписывает ошибку расширению.
//   Решение: (1) тихий .catch на промисе originalFetch — снимает unhandled-сигнал для
//   чужих прерванных запросов, не меняя поведения страницы; (2) устранение висячего
//   Promise.reject(err) в onRejected нашей цепочки .then (замена на пустую функцию),
//   который создавал вторичный висячий reject-промис со стеком обёртки.

(function () {
  if (window.__aiCmGeminiInterceptInstalled) return;
  window.__aiCmGeminiInterceptInstalled = true;

  var originalFetch = window.fetch;
  var OriginalXHR = window.XMLHttpRequest;
  var originalXHROpen = OriginalXHR ? OriginalXHR.prototype.open : null;
  var originalXHRSend = OriginalXHR ? OriginalXHR.prototype.send : null;
  var originalSetHeader = OriginalXHR ? OriginalXHR.prototype.setRequestHeader : null;

  // ---- накопители вложений (глобально, на всю сессию; сбрасываются при смене чата) ----
  var IMAGE_DEFAULT_TOKENS = 516;
  var DOC_EST_TOKENS = 2500;
  var attachSeen = {};
  var attachTokens = 0;
  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
  var loggedAttach = false;

  var turnsMap = {};
  var lastOrderedIds = []; // последний финальный порядок id из emitBaseSnapshot (для дампа диагностики)
  var orderCounter = 0;
  var prependCursor = -1; // v33: глобальный указатель отрицательных order для старших страниц
  var loggedOk = false;
  var loggedErr = false;
  var loggedStructure = false;
  var DEBUG_STRUCTURE = false;
  var loggedRontgen = false;

  // ---- v28: DIAG_TOKENS — диагностический поиск счётчиков токенов в ответах Gemini ----
  var DIAG_TOKENS = true;
  var diagMatchCounts = {};
  var diagScannedCount = 0;
  var DIAG_MAX_SCANNED = 200;
  var DIAG_MAX_PER_KEYWORD = 10;
  var DIAG_MAX_BODY = 2 * 1024 * 1024;
  var DIAG_KEYWORDS = [
    "usage_metadata", "usageMetadata", "promptTokenCount",
    "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount",
    "cachedContentTokenCount", "tokenCount", "totalTokens"
  ];
  function diagCanScan(url, contentType) {
    try {
      if (!url) return false;
      var urlLower = url.toLowerCase();
      var ctLower = (contentType || '').toLowerCase();
      if (ctLower.indexOf('json') !== -1 || ctLower.indexOf('text/') !== -1) return true;
      if (urlLower.indexOf('/api/') !== -1 || urlLower.indexOf('batchexecute') !== -1 || urlLower.indexOf('stream') !== -1) return true;
      return false;
    } catch (e) { return false; }
  }
  function diagIsStream(url, contentType) {
    try {
      var ctLower = (contentType || '').toLowerCase();
      if (ctLower.indexOf('text/event-stream') !== -1) return true;
      if (ctLower.indexOf('application/x-ndjson') !== -1) return true;
      var urlLower = (url || '').toLowerCase();
      if (urlLower.indexOf('stream') !== -1 && urlLower.indexOf('batchexecute') === -1) return true;
      return false;
    } catch (e) { return false; }
  }
  function diagScanResponse(txt, url, isStream) {
    if (!DIAG_TOKENS) return;
    try {
      if (typeof txt !== 'string' || !txt) return;
      var scanLen = txt.length < DIAG_MAX_BODY ? txt.length : DIAG_MAX_BODY;
      var scanText = txt.substring(0, scanLen);
      for (var k = 0; k < DIAG_KEYWORDS.length; k++) {
        var kw = DIAG_KEYWORDS[k];
        if (!diagMatchCounts[kw]) diagMatchCounts[kw] = 0;
        if (diagMatchCounts[kw] >= DIAG_MAX_PER_KEYWORD) continue;
        var idx = 0;
        while (diagMatchCounts[kw] < DIAG_MAX_PER_KEYWORD) {
          var pos = scanText.indexOf(kw, idx);
          if (pos === -1) break;
          var start = Math.max(0, pos - 40);
          var end = Math.min(scanText.length, pos + kw.length + 40);
          var near = scanText.substring(start, end);
          near = near.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
          debugLog('log', '[gemini-token-diag] url=' + url + ' size=' + txt.length + ' stream=' + (isStream ? 'true' : 'false') +
            ' found="' + kw + '" near=' + JSON.stringify(near));
          diagMatchCounts[kw]++;
          idx = pos + kw.length;
        }
      }
    } catch (e) { }
  }

  // ---- v16: приватный рентген id хода ----
  var idmapCalls = 0;
  var IDMAP_MAX = 6;

  // ---- автоскролл (сбрасывается при смене чата, чтобы собрал историю нового чата) ----
  var autoScrollStarted = false;
  var AUTO_STEP_WAIT = 1500;
  var AUTO_FIND_TRIES = 6;
  var AUTO_FIND_WAIT = 700;
  var AUTO_EMPTY_NEED = 3;
  var AUTO_HARD_CAP = 250;
  var AUTO_SETTLE_TRIES = 4;
  var AUTO_SETTLE_WAIT = 250;

  // ---- тихая пагинация (сбрасывается при смене чата) ----
  var quietActive = false;
  var historyFullByQuiet = false;
  var reachedStart = false; // тихая пагинация дошла до начала (курсора больше нет)
  var quietPaginated = false;
  var quietDecisionMade = false;
  var pendingCursor = null;
  var loggedMultiCursor = false;
  var PAGINATE_CAP = 60;
  var lastPaginateOpaqueCandidates = null;
  var lastPaginateOuter = null; // последний outer для дампа в paginateLoop
  var lastAllStrings = []; // дамп всех строк длиной 20..2000 из последнего outer
  var lastFailedSkeleton = null; // скелет последней непарсящейся страницы (для дампа диагностики)
  // ---- виртуальный F5 для хвоста ----
  var lastHeaders = null;
  var lastAtEncoded = '';
  var lastBaseUrl = '';
  var lastReqId = 0;
  var activeSeq = 0;
  var activeDisabled = false;
  var activeBusy = false;
  var lastActiveAt = 0;
  var REFRESH_MIN_MS = 4000;
  var loggedActiveStatus = false;
  var observerStarted = false;
  var mutTimer = null;
  var scrollRecentUntil = 0; // подавление rebuild-сброса пока идёт скролл (мутации от рендера)

  // ---- v20: защита автоскролла в переходном окне ----
  var autoScrollBlocked = false;
  var autoScrollUnblockTimer = null;

  // ---- v27/vXX: пол (floor) через localStorage с версионированием по PARSER_VERSION ----
  // Ключ включает версию парсера; при несовпадении версии сохранённый пол игнорируется
  // и перезаписывается. Реализация вынесена в utils/gemini-intercept-logic.js.
  var parserVersion = '';
  try {
    if (typeof window !== 'undefined' && window.GeminiBatchexecuteParser && window.GeminiBatchexecuteParser.PARSER_VERSION) {
      parserVersion = window.GeminiBatchexecuteParser.PARSER_VERSION;
    }
  } catch (e) { }
  function loadFloor(convId) {
    if (typeof window === 'undefined' || !window.GeminiInterceptLogic) return null;
    return window.GeminiInterceptLogic.loadFloor(convId, parserVersion, localStorage);
  }
  function saveFloor(convId, count, effectiveLen) {
    if (typeof window === 'undefined' || !window.GeminiInterceptLogic) return;
    window.GeminiInterceptLogic.saveFloor(convId, parserVersion, count, effectiveLen, localStorage);
  }

  // ================= v17: отслеживание смены чата в SPA =================
  function getConvId() {
    try {
      var m = location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  var currentConvId = getConvId();

  function resetForNewConversation() {
    turnsMap = {};
    attachSeen = {};
    attachTokens = 0;
    attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
    orderCounter = 0;
    prependCursor = -1;
    loggedOk = false;
    loggedErr = false;
    loggedStructure = false;
    loggedRontgen = false;
    loggedAttach = false;
    loggedMultiCursor = false;
    lastPaginateOpaqueCandidates = null;
    lastFailedSkeleton = null;
    idmapCalls = 0;
    pendingCursor = null;
    quietActive = false;
    historyFullByQuiet = false;
    reachedStart = false;
    quietPaginated = false;
    quietDecisionMade = false;
    autoScrollStarted = false;
    lastActiveAt = Date.now();
    loggedActiveStatus = false;
    // v20: блокируем автоскролл до первого валидного снимка нового чата
    autoScrollBlocked = true;
    if (autoScrollUnblockTimer) { clearTimeout(autoScrollUnblockTimer); autoScrollUnblockTimer = null; }
    autoScrollUnblockTimer = setTimeout(function () {
      if (autoScrollBlocked) {
        autoScrollBlocked = false;
        debugLog('log', '[gemini-intercept] таймаут автоскролл-блокировки → разблокирован (кешевый роутинг без сети?)');
      }
    }, 5000);
    debugLog('log', '[gemini-intercept] смена чата → состояние перехватчика сброшено (convId=' + (currentConvId || '(не чат)') + ')');
    try { window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed')); } catch (e) { }
  }

  function checkConvChange() {
    var newId = getConvId();
    if (newId !== currentConvId) {
      currentConvId = newId;
      resetForNewConversation();
    }
  }

  try {
    var origPush = history.pushState;
    if (origPush) {
      history.pushState = function () {
        var r = origPush.apply(this, arguments);
        try { checkConvChange(); } catch (e) { }
        return r;
      };
    }
    var origReplace = history.replaceState;
    if (origReplace) {
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        try { checkConvChange(); } catch (e) { }
        return r;
      };
    }
    window.addEventListener('popstate', function () { try { checkConvChange(); } catch (e) { } });
    document.addEventListener('scroll', function () {
      scrollRecentUntil = Date.now() + 2000;
    }, true);
  } catch (e) { }
  // =====================================================================

  function baseSize() { return Object.keys(turnsMap).length; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function tagInfo(el) {
    var cn = '';
    try { cn = String(el.className || '').trim().split(/\s+/).slice(0, 2).join('.'); } catch (e) { }
    return el.tagName.toLowerCase() + (cn ? '.' + cn : '');
  }

  function isHistoryRpc(url) {
    return !!url && url.indexOf('batchexecute') !== -1 && url.indexOf('hNvQHb') !== -1;
  }
  function extractRpcIdsFromUrl(url) {
    try {
      var m = url.match(/[?&]rpcids=([^&]+)/);
      if (m) {
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
      }
    } catch (e) { }
    return '';
  }

  // ---- фильтры мусора ----
  function isIdLike(s) { return typeof s === 'string' && /^(c_|r_|rc_|fbb[0-9a-f]|[0-9a-f]{16})/.test(s); }
  function isFileLike(s) { return typeof s === 'string' && /\.(pdf|png|jpe?g|gif|docx?|txt|webp|csv|xlsx?)(\b|$)/i.test(s); }
  function isUrlLike(s) { return typeof s === 'string' && /^https?:\/\//i.test(s); }
  function isTokenLike(s) { return typeof s === 'string' && /^\$?AVuib/.test(s); }
  function isMimeLike(s) { return typeof s === 'string' && /^(image|application|video|audio)\//i.test(s); }
  var UI_BLACKLIST = {
    'DE': 1, 'ru': 1, 'mk': 1, 'generic': 1, 'personal_context': 1, 'google': 1,
    'Ищу в интернете': 1, 'Персональный контекст': 1, 'Google Search': 1, 'true': 1, 'false': 1
  };
  function isJunk(s) {
    if (typeof s !== 'string') return true;
    if (s.length === 0) return true;
    if (UI_BLACKLIST[s]) return true;
    return isIdLike(s) || isFileLike(s) || isUrlLike(s) || isTokenLike(s) || isMimeLike(s);
  }
  function isThinking(s) {
    if (typeof s !== 'string' || s.length < 30) return false;
    var cyr = 0, lat = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x0400 && c <= 0x04FF) cyr++;
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) lat++;
    }
    if (cyr > 0) return false;
    if (lat < 30) return false;
    return s.indexOf('**') !== -1;
  }

  // ================= приватный рентген id хода =================
  function firstRc(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string' && /^rc_[0-9a-f]+$/.test(n)) { found = n; return; }
      else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found;
  }
  function logIdmap(t, src, textlen) {
    var r0 = (Array.isArray(t) && Array.isArray(t[0]) && typeof t[0][1] === 'string') ? t[0][1] : '';
    var r1 = (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][1] === 'string') ? t[1][1] : '';
    var rc = firstRc(t);
    var ts = 0;
    try { if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][0] === 'number' && t[1][0] > 1000000000) ts = t[1][0]; } catch (e) { }
    debugLog('log', '[gemini-idmap] src=' + src + ' ts=' + ts + ' r0=' + (r0 ? r0.slice(0, 6) : '-') + ' r1=' + (r1 ? r1.slice(0, 6) : '-') +
      ' rc=' + (rc ? rc.slice(0, 6) : '-') + ' textlen=' + textlen);
  }
  // ================================================================

  // ---- v23: структурный сбор вложений (только по сигнатуре блока, без текстовых эвристик) ----
  // Сигнатура блока вложения (0-based индексы внутри Array):
  //   [2]=string имяФайла, [3]=string URL c "googleusercontent",
  //   [5]=string начинается с "$AVuibg", [11]=string MIME "image/..." или "application/...",
  //   [15]=Array [width,height,bytes] (вспомогательный маркер, не обязательный).
  //   Рекурсивно обходим дерево — НЕ привязываемся к жёстким индексам пути.
  function collectAttachments(node, localSeen, items) {
    if (!Array.isArray(node)) return;
    // проверяем: является ли этот массив блоком вложения?
    if (typeof node[2] === 'string' && typeof node[3] === 'string' &&
      typeof node[5] === 'string' && typeof node[11] === 'string' &&
      node[3].indexOf('googleusercontent') !== -1 &&
      node[5].indexOf('$AVuibg') === 0 &&
      /^(image|application|video|audio)\//.test(node[11])) {
      var name = node[2];
      var mime = node[11];
      if (!localSeen.has(name)) {
        localSeen.add(name);
        items.push({ name: name, mime: mime });
      }
      return; // блок вложения — лист, не идём глубже
    }
    // иначе рекурсивно обходим детей
    for (var i = 0; i < node.length; i++) {
      if (Array.isArray(node[i])) collectAttachments(node[i], localSeen, items);
    }
  }
  function ingestAttachments(items) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (attachSeen[it.name]) continue;
      attachSeen[it.name] = 1;
      var tt;
      if (it.mime && it.mime.indexOf('image/') === 0) {
        tt = IMAGE_DEFAULT_TOKENS;
        attachBreak.imgTokens += tt;
        attachBreak.imgCount++;
      } else if (it.mime && (it.mime === 'application/pdf' ||
        it.mime.indexOf('wordprocessingml') !== -1 ||
        it.mime.indexOf('spreadsheetml') !== -1 ||
        it.mime.indexOf('presentationml') !== -1 ||
        it.mime.indexOf('officedocument') !== -1)) {
        tt = DOC_EST_TOKENS;
        attachBreak.docTokens += tt;
        attachBreak.docCount++;
      } else {
        // прочие MIME — считаем по умолчанию как изображение (516)
        tt = IMAGE_DEFAULT_TOKENS;
        attachBreak.imgTokens += tt;
        attachBreak.imgCount++;
      }
      attachTokens += tt;
    }
  }

  // ---- рекурсивный сбор текста хода ----
  function collectContent(node, out) {
    if (typeof node === 'string') {
      if (!isJunk(node) && !isThinking(node) && !isMimeLike(node)) out.push(node);
      return;
    }
    if (!Array.isArray(node)) return;
    for (var k = 0; k < node.length; k++) collectContent(node[k], out);
  }
  function structureMap(node, depth, out, counter) {
    if (counter.n >= 40) return;
    if (typeof node === 'string') {
      var kind = isJunk(node) ? 'junk' : (isThinking(node) ? 'think' : 'TEXT');
      out.push(depth + ':' + node.length + ':' + kind); counter.n++; return;
    }
    if (!Array.isArray(node)) return;
    for (var i = 0; i < node.length; i++) structureMap(node[i], depth + 1, out, counter);
  }
  var MODEL_NAME_RE = /^\s*(?:Gemini\s*[\d.]?|\d+(?:\.\d+)?\s+(?:Flash|Pro|Ultra|Gemini))/i;
  function extractModelName(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string') {
        if (n.length < 60 && n.indexOf('\n') < 0 && MODEL_NAME_RE.test(n)) { found = n.trim(); return; }
      } else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found || '';
  }
  function extractTurnId(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string' && /^r_[0-9a-f]+$/.test(n)) { found = n; return; }
      else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found;
  }
  function extractTurnTs(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][0] === 'number' && t[1][0] > 1000000000) return t[1][0];
    } catch (e) { }
    return 0;
  }
  // v35: r1 = id соседа НОВЕЕ (t[1][1], подтверждено логами idmap).
  function extractTurnR1(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][1] === 'string') return t[1][1];
    } catch (e) { }
    return null;
  }

  // Скелет непарсящейся страницы: рекурсивно до глубины 6.
  // массив → {"arr": <len>, "items": [...]}; строка → "s<len>: <до 30 символов>";
  // число/булевы/null — как есть. items ограничены 8 элементами для компактности.
  function buildJsonSkeleton(node, depth) {
    if (node === null || node === undefined) return null;
    var t = typeof node;
    if (t === 'string') return 's' + node.length + ': ' + node.slice(0, 30);
    if (t === 'number' || t === 'boolean') return node;
    if (Array.isArray(node)) {
      var items = [];
      if (depth < 6) {
        var cap = Math.min(node.length, 8);
        for (var i = 0; i < cap; i++) {
          items.push(buildJsonSkeleton(node[i], depth + 1));
        }
      }
      return { arr: node.length, items: items };
    }
    return null;
  }

  function handleOuter(outer, out, src) {
    try {
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return;
      if (outer[0][1] !== 'hNvQHb') return;
      var inner = outer[0][2];
      if (typeof inner !== 'string') {
        lastFailedSkeleton = buildJsonSkeleton(outer, 0);
        debugLog('log', '[gemini-skeleton] сохранён src=' + src + ' (inner не строка)');
        return;
      }
      var turns = JSON.parse(inner);
      if (!Array.isArray(turns)) {
        lastFailedSkeleton = buildJsonSkeleton(outer, 0);
        debugLog('log', '[gemini-skeleton] сохранён src=' + src + ' (turns не массив)');
        return;
      }
      if (!loggedRontgen) { loggedRontgen = true; try { rontgenPagination(outer, turns); } catch (e) { } }
      // сохраняем outer для дампа в paginateLoop (диагностика формата курсора)
      lastPaginateOuter = outer;
      // v18: извлекаем opaque-курсор из ответа и сохраняем в pendingCursor для запуска тихой пагинации.
      //   Эта строка была потеряна в v17 при добавлении сброса чата → тихий цикл никогда не стартовал.
      pendingCursor = extractCursor(turns);
      // v27: сбор ВСЕХ opaque-кандидатов в lastPaginateOpaqueCandidates (как rontgenPagination,
      // но на каждом вызове handleOuter) для диагностики обрыва тихой пагинации
      try {
        var arr0 = outer[0];
        var rest = arr0.slice(3);
        var restTypes = rest.map(function (x) { return x === null ? 'null' : (Array.isArray(x) ? 'arr' : typeof x); });
        var turnsLen = Array.isArray(turns) ? turns.length : ('не_массив:' + typeof turns);
        var lastDesc = '?';
        if (Array.isArray(turns) && turns.length) {
          var le = turns[turns.length - 1];
          if (le === null) lastDesc = 'null';
          else if (Array.isArray(le)) lastDesc = 'массив(ход?) len=' + le.length;
          else if (typeof le === 'string') lastDesc = 'СТРОКА len=' + le.length + (classifyOpaque(le) ? ' → OPAQUE "' + edges8(le) + '"' : ' → текст/прочее(не opaque)');
          else lastDesc = typeof le;
        }
        var cands = [];
        walkOpaque(rest, 'rest', cands);
        if (Array.isArray(turns)) {
          for (var wi = 0; wi < turns.length; wi++) walkOpaque(turns[wi], 'turn' + wi, cands);
        }
        lastPaginateOpaqueCandidates = {
          arr0len: arr0.length,
          restTypes: restTypes,
          turnsLen: turnsLen,
          lastDesc: lastDesc,
          cands: cands
        };
        // сбор всех строк длиной 20..2000 из текущего outer для диагностики формата курсора
        var allStrs = [];
        (function walkAll(node) {
          if (allStrs.length >= 40) return;
          if (typeof node === 'string') {
            if (node.length >= 20 && node.length <= 2000)
              allStrs.push('len=' + node.length +
                ' head=' + JSON.stringify(node.slice(0, 24)) +
                ' tail=' + JSON.stringify(node.slice(-24)));
            return;
          }
          if (Array.isArray(node)) for (var i = 0; i < node.length; i++) walkAll(node[i]);
        })(outer);
        lastAllStrings = allStrs;
      } catch (e) { lastPaginateOpaqueCandidates = null; }
      if (DEBUG_STRUCTURE && !loggedStructure) {
        loggedStructure = true;
        var sm = []; structureMap(turns, 0, sm, { n: 0 });
        debugLog('log', '[gemini-intercept] рентген структуры хода #0 (глубина:длина:тип): ' + sm.join(' | '));
      }
      var doIdmap = (idmapCalls < IDMAP_MAX);
      var _nonEmpty = 0, _empty = 0, _skippedIds = [];
      var realTurns = (Array.isArray(turns[0]) && Array.isArray(turns[0][0])) ? turns[0] : turns;
      // v38: raw внутри страницы идёт «новые→старые». Обходим С КОНЦА, чтобы
      // по возрастанию order (assignPageOrders) итог был «старые→новые»;
      // внутри хода user стоит раньше assistant → получает меньший order.
      for (var i = realTurns.length - 1; i >= 0; i--) {
        var t = realTurns[i];
        if (!Array.isArray(t)) continue;
        var localSeen = new Set(); var items = [];
        collectAttachments(t, localSeen, items);
        ingestAttachments(items);
        var modelName = extractModelName(t);
        var turnId = extractTurnId(t) || ('idx' + out.total++);
        var turnTs = extractTurnTs(t);
        var r1 = extractTurnR1(t);
        // v30/v31: текст хода и роли собираем через чистый сетевой парсер
        // (utils/gemini-batchexecute-parser.js): вычищаем $AXzLiR-токены и сегменты «мышления»,
        // разделяем вопрос пользователя и ответ модели, сохраняем таблицы.
        var segs = [];
        if (typeof window !== 'undefined' && window.GeminiBatchexecuteParser) {
          try { segs = window.GeminiBatchexecuteParser.splitTurnMessages(t); } catch (e) { segs = []; }
        }
        if (!segs || !segs.length) {
          // fallback: прежний сбор одним текстом (без ролей)
          var fb = []; collectContent(t, fb);
          var fbt = fb.join('\n').trim();
          if (fbt) segs = [{ role: 'assistant', text: fbt }];
        }
        var anyNonEmpty = false;
        for (var s = 0; s < segs.length; s++) {
          var seg = segs[s];
          var stxt = (seg && seg.text) ? seg.text.trim() : '';
          if (!stxt) continue;
          anyNonEmpty = true;
          var role = (seg.role === 'user') ? 'user' : 'assistant';
          var mid = turnId + '_' + role;
          out.turns.push({ id: mid, text: stxt, modelName: modelName, ts: turnTs, role: role, turnId: turnId, r1: r1 });
        }
        if (doIdmap) { try { logIdmap(t, src, (segs && segs.length) ? segs.map(function (x) { return (x && x.text) ? x.text.length : 0; }).reduce(function (a, b) { return a + b; }, 0) : 0); } catch (e) { } }
        if (anyNonEmpty) { _nonEmpty++; }
        else { _empty++; _skippedIds.push(turnId); }
      }
      if (_nonEmpty === 0) {
        lastFailedSkeleton = buildJsonSkeleton(outer, 0);
        debugLog('log', '[gemini-skeleton] сохранён src=' + src + ' (0 извлечённых ходов, outer len=' + (Array.isArray(outer) ? outer.length : '?') + ')');
      }
      // NOTE: успешные страницы НЕ сбрасывают lastFailedSkeleton — последний скелет
      // непарсящейся страницы должен дожить до дампа диагностики.
      debugLog('log', '[gemini-ingest-trace] handleOuter src=' + src + ' ходов_всего=' + turns.length +
        ' непустых=' + _nonEmpty + ' пропущено(пустой_text)=' + _empty +
        (_empty > 0 ? ' пропущ_ids=[' + _skippedIds.join(',') + ']' : ''));
    } catch (e) { /* один кривой блок не ломает остальные */ }
  }

  function rontgenPagination(outer, turns) {
    try {
      var arr0 = outer[0];
      var rest = arr0.slice(3);
      var restTypes = rest.map(function (x) { return x === null ? 'null' : (Array.isArray(x) ? 'arr' : typeof x); });
      var turnsLen = Array.isArray(turns) ? turns.length : ('не_массив:' + typeof turns);
      var lastDesc = '?';
      if (Array.isArray(turns) && turns.length) {
        var le = turns[turns.length - 1];
        if (le === null) lastDesc = 'null';
        else if (Array.isArray(le)) lastDesc = 'массив(ход?) len=' + le.length;
        else if (typeof le === 'string') lastDesc = 'СТРОКА len=' + le.length + (classifyOpaque(le) ? ' → OPAQUE "' + edges8(le) + '"' : ' → текст/прочее(не opaque)');
        else lastDesc = typeof le;
      }
      var cands = [];
      walkOpaque(rest, 'rest', cands);
      if (Array.isArray(turns)) {
        for (var i = 0; i < turns.length; i++) walkOpaque(turns[i], 'turn' + i, cands);
      }
      debugLog('log', '[gemini-rontgen] outer[0].len=' + arr0.length +
        ' | rest(после inner)=[' + restTypes.join(',') + ']' +
        ' | turns.len=' + turnsLen +
        ' | lastTurn=' + lastDesc +
        ' | opaque-кандидаты(НЕ переписка — рус.текст фильтр не проходит): ' +
        (cands.length ? cands.join('  ||  ') : '(НЕТ ни на уровне rest, ни внутри ходов)'));
    } catch (e) { debugLog('log', '[gemini-rontgen] ошибка:', e); }
  }
  function classifyOpaque(s) {
    if (typeof s !== 'string') return false;
    if (s.length < 40 || s.length > 600) return false;
    if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(s)) return false;
    if (s.indexOf('$AVuibg') === 0) return false;
    return true;
  }
  function edges8(s) { return s.slice(0, 8) + '…' + s.slice(-8); }
  function walkOpaque(node, path, out) {
    if (out.length > 30) return;
    if (typeof node === 'string') {
      if (classifyOpaque(node)) out.push(path + ' len=' + node.length + ' "' + edges8(node) + '"');
      return;
    }
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walkOpaque(node[i], path + '[' + i + ']', out);
    }
  }
  function findCursors(node, out) {
    if (out.length > 8) return;
    if (typeof node === 'string') { if (classifyOpaque(node)) out.push(node); return; }
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) findCursors(node[i], out); }
  }
  function extractCursor(turns) {
    var c = [];
    if (Array.isArray(turns)) { for (var i = 0; i < turns.length; i++) findCursors(turns[i], c); }
    if (!c.length) return null;
    if (c.length > 1 && !loggedMultiCursor) {
      loggedMultiCursor = true;
      debugLog('log', '[gemini-paginate] найдено ' + c.length + ' opaque-кандидатов в ответе (беру последний): ' + c.map(edges8).join(' | '));
    }
    return c[c.length - 1];
  }

  // ---- байтовый парсер (длина в байтах UTF-8) ----
  function parseByBytes(raw, out, src) {
    var bytes;
    try { bytes = new TextEncoder().encode(raw); } catch (e) { return; }
    var pos = 0;
    if (bytes.length >= 4 && bytes[0] === 0x29 && bytes[1] === 0x5D && bytes[2] === 0x7D && bytes[3] === 0x27) pos = 4;
    var dec = new TextDecoder('utf-8');
    var guard = 0;
    while (pos < bytes.length && guard++ < 200) {
      while (pos < bytes.length && (bytes[pos] < 48 || bytes[pos] > 57)) pos++;
      if (pos >= bytes.length) break;
      var n = 0;
      while (pos < bytes.length && bytes[pos] >= 48 && bytes[pos] <= 57) { n = n * 10 + (bytes[pos] - 48); pos++; }
      if (n <= 0) { pos++; continue; }
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      var end = pos + n; if (end > bytes.length) end = bytes.length;
      var payloadStr = dec.decode(bytes.subarray(pos, end));
      pos = end;
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      if (payloadStr.indexOf('hNvQHb') !== -1) {
        try { handleOuter(JSON.parse(payloadStr), out, src); } catch (e) { }
      }
    }
  }
  function parseByLines(raw, out, src) {
    var lines = raw.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln || ln === ')]}\'') continue;
      var c0 = ln.charAt(0);
      if (c0 !== '[' && c0 !== '{') continue;
      if (ln.indexOf('hNvQHb') === -1) continue;
      try { handleOuter(JSON.parse(ln), out, src); } catch (e) { }
    }
  }
  function parseBatchExecute(raw, src) {
    var out = { turns: [], total: 0 };
    parseByBytes(raw, out, src);
    if (!out.turns.length) parseByLines(raw, out, src);
    return out.turns;
  }

  // ---- ВИРТУАЛЬНЫЙ СКРОЛЛ: обёртка над контейнером или window ----
  function makeScroller(el) {
    if (!el) {
      var de = document.scrollingElement || document.documentElement;
      return {
        mode: 'window', el: de, tag: 'window',
        top: function () { return de.scrollTop; },
        setTop: function (v) { de.scrollTop = v; },
        client: function () { return window.innerHeight; },
        height: function () { return de.scrollHeight; }
      };
    }
    return {
      mode: 'el', el: el, tag: tagInfo(el),
      top: function () { return el.scrollTop; },
      setTop: function (v) { el.scrollTop = v; },
      client: function () { return el.clientHeight; },
      height: function () { return el.scrollHeight; }
    };
  }

  function findScrollContainer() {
    var HINT = /conversation|message|chat-turn|response|scroll|turn-list|infinite|virtual/i;
    var all = document.querySelectorAll('*');
    var hinted = null, best = null, bestH = -1;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === document.body || el === document.documentElement) continue;
      var st = '';
      try { st = getComputedStyle(el).overflowY; } catch (e) { continue; }
      if (st !== 'auto' && st !== 'scroll' && st !== 'overlay') continue;
      var sh = el.scrollHeight, ch = el.clientHeight;
      if (sh <= ch + 50) continue;
      var hay = '';
      try { hay = (el.className || '') + ' ' + (el.id || ''); } catch (e) { }
      if (HINT.test(hay)) { if (!hinted || sh > hinted.height()) hinted = makeScroller(el); }
      if (sh > bestH) { bestH = sh; best = makeScroller(el); }
    }
    if (hinted) return hinted;
    if (best) return best;
    var de = document.scrollingElement || document.documentElement;
    if (de.scrollHeight > window.innerHeight + 50) return makeScroller(null);
    return null;
  }

  function rontgenScroll() {
    var all = document.querySelectorAll('*');
    var arr = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var sh = el.scrollHeight, ch = el.clientHeight;
      if (sh > ch + 50) {
        var st = ''; try { st = getComputedStyle(el).overflowY; } catch (e) { st = '?'; }
        arr.push({ d: sh - ch, t: tagInfo(el), ov: st });
      }
    }
    arr.sort(function (a, b) { return b.d - a.d; });
    var top = arr.slice(0, 8).map(function (x) { return x.t + '(ov=' + x.ov + ',+' + x.d + ')'; });
    var de = document.scrollingElement || document.documentElement;
    debugLog('log', '[gemini-autoscroll] РЕНТГЕН скролла: windowScrollH=' + de.scrollHeight + ' innerH=' + window.innerHeight +
      ' | топ переполненных (тег ov=overflow +переполнение): ' + (top.join(' || ') || '(нет)') +
      '  ← если ov=hidden у ленты, скролл не нативный (JS) и scrollTop не сработает');
  }

  function triggerUp(sc) {
    try {
      sc.setTop(0);
      var target = (sc.mode === 'el') ? sc.el : window;
      try {
        target.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, deltaMode: 0, bubbles: true, cancelable: true }));
      } catch (e) { }
      try { target.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) { }
    } catch (e) { }
  }

  async function settleBottom(sc) {
    for (var i = 0; i < AUTO_SETTLE_TRIES; i++) {
      try { sc.setTop(sc.height()); } catch (e) { }
      await sleep(AUTO_SETTLE_WAIT);
    }
  }

  function scheduleAutoScroll() {
    if (autoScrollStarted) return;
    // v20: блокировка автоскролла до первого валидного снимка нового чата
    if (autoScrollBlocked) {
      debugLog('log', '[gemini-autoscroll] заблокирован до первого валидного снимка нового чата');
      return;
    }
    autoScrollStarted = true;
    setTimeout(autoScrollCollect, 1200);
  }

  async function autoScrollCollect() {
    // v20: двойная страховка — если флаг всё ещё взведён (например, вызвано напрямую)
    if (autoScrollBlocked) {
      debugLog('log', '[gemini-autoscroll] заблокирован (проверка в autoScrollCollect)');
      return;
    }
    try {
      var sc = null;
      for (var attempt = 0; attempt < AUTO_FIND_TRIES; attempt++) {
        sc = findScrollContainer();
        if (sc) break;
        await sleep(AUTO_FIND_WAIT);
      }
      if (!sc) {
        debugLog('log', '[gemini-autoscroll] скролл-контейнер не найден за ' + AUTO_FIND_TRIES + ' попыток → автоскролл пропущен (рентген ниже)');
        rontgenScroll();
        return;
      }
      if (sc.height() <= sc.client() + 50) {
        debugLog('log', '[gemini-autoscroll] история помещается без скролла (' + sc.tag + ' scrollH=' + sc.height() +
          ' ≈ clientH=' + sc.client() + ') → автоскролл не нужен');
        return;
      }
      var startSize = baseSize();
      var startH = sc.height();
      var prevSmooth = '';
      if (sc.mode === 'el') { try { prevSmooth = sc.el.style.scrollBehavior; sc.el.style.scrollBehavior = 'auto'; } catch (e) { } }
      debugLog('log', '[gemini-autoscroll] старт: ' + sc.tag + ' [' + sc.mode + '] scrollH=' + startH +
        ' clientH=' + sc.client() + ', ходов на старте=' + startSize);

      var emptyStreak = 0;
      var lastH = startH, lastB = startSize;
      var stoppedBy = 'hard-cap';
      var i = 0;
      for (i = 0; i < AUTO_HARD_CAP; i++) {
        triggerUp(sc);
        await sleep(AUTO_STEP_WAIT);
        var curH = sc.height(), curB = baseSize();
        var grew = (curH > lastH) || (curB > lastB);
        if (grew) emptyStreak = 0; else emptyStreak++;
        if (grew) {
          debugLog('log', '[gemini-autoscroll] шаг ' + i + ': scrollH ' + lastH + '→' + curH +
            ', ходов ' + lastB + '→' + curB + ', empty=' + emptyStreak);
        }
        lastH = curH; lastB = curB;
        if (emptyStreak >= AUTO_EMPTY_NEED) { stoppedBy = 'empty*' + AUTO_EMPTY_NEED; break; }
      }

      await settleBottom(sc);
      if (sc.mode === 'el') { try { sc.el.style.scrollBehavior = prevSmooth; } catch (e) { } }
      debugLog('log', '[gemini-autoscroll] ✓ готово: ходов ' + startSize + ' → ' + baseSize() +
        ' (итераций=' + (i + 1) + ', стоп=' + stoppedBy + '; вся история из сети без ручного скролла; возврат в низ)');
    } catch (e) {
      debugLog('log', '[gemini-autoscroll] ошибка автоскролла (НЕ критично, ловля работает):', e);
    }
  }

  // ================= ВИРТУАЛЬНЫЙ F5 ДЛЯ ХВОСТА + ТИХАЯ ПАГИНАЦИЯ =================
  function captureHeadersFromInit(input, init) {
    var h = {};
    try {
      if (typeof Request !== 'undefined' && input instanceof Request && input.headers && typeof input.headers.forEach === 'function') {
        input.headers.forEach(function (v, k) { h[k] = v; });
      }
    } catch (e) { }
    try {
      if (init && init.headers) {
        var hh = init.headers;
        if (hh && typeof hh.forEach === 'function') { hh.forEach(function (v, k) { h[k] = v; }); }
        else if (Array.isArray(hh)) { for (var i = 0; i < hh.length; i++) if (hh[i] && hh[i][0]) h[hh[i][0]] = hh[i][1]; }
        else if (typeof hh === 'object') { for (var k in hh) h[k] = hh[k]; }
      }
    } catch (e) { }
    return h;
  }
  function parseAtFromBody(bodyStr) {
    if (typeof bodyStr !== 'string') return '';
    var m = bodyStr.match(/(?:^|&)at=([^&]*)/);
    return m ? m[1] : '';
  }
  function parseReqIdFromUrl(url) {
    var m = url.match(/[?&]_reqid=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // v20: извлечение convId из тела batchexecute POST-запроса.
  // Структура (см. buildActiveBodyWith): f.req=<encoded> → decode → JSON → outer-массив,
  // где outer[0][0] = ['hNvQHb', <inner-СТРОКА>, null, 'generic']; inner-строка =
  // JSON.stringify(slots), где slots[0] = 'c_<convId>'. Двойной JSON.parse с try/catch.
  function convIdFromBody(bodyStr) {
    try {
      if (typeof bodyStr !== 'string') return '';
      // извлекаем значение f.req=...&at=...
      var m = bodyStr.match(/(?:^|&)f\.req=([^&]*)/);
      if (!m) return '';
      var decoded = decodeURIComponent(m[1]);
      var outer = JSON.parse(decoded);
      var innerStr = outer[0][0][1];  // вторая ячейка в ['hNvQHb', innerStr, null, 'generic']
      var slots = JSON.parse(innerStr);
      var raw = slots[0];
      // slots[0] имеет вид 'c_<convId>' — отрезаем префикс 'c_'
      if (typeof raw === 'string' && raw.indexOf('c_') === 0) return raw.slice(2);
      return '';
    } catch (e) { return ''; }
  }

  function rememberSiteMeta(url, headers, bodyStr) {
    if (!isHistoryRpc(url)) return;
    if (headers) {
      var keys = Object.keys(headers);
      if (keys.length) lastHeaders = headers;
    }
    var at = parseAtFromBody(bodyStr);
    if (at) lastAtEncoded = at;
    lastBaseUrl = url;
    var rid = parseReqIdFromUrl(url);
    if (rid) lastReqId = rid;
  }

  function buildActiveBodyWith(token) {
    var convId = getConvId();
    var slots = ['c_' + convId, 10, token, 1, [0], [4], null, 1];
    var inner = JSON.stringify(slots);
    var outer = [[['hNvQHb', inner, null, 'generic']]];
    return 'f.req=' + encodeURIComponent(JSON.stringify(outer)) + '&at=' + lastAtEncoded + '&';
  }
  function buildActiveBody() { return buildActiveBodyWith(null); }
  function buildActiveUrl() {
    activeSeq++;
    var base = lastReqId || 1000000;
    var next = base + activeSeq * 7;
    if (/_reqid=\d+/.test(lastBaseUrl)) return lastBaseUrl.replace(/_reqid=\d+/, '_reqid=' + next);
    return lastBaseUrl + (lastBaseUrl.indexOf('?') === -1 ? '?' : '&') + '_reqid=' + next;
  }

  function paginateLoop(token, depth) {
    if (depth > PAGINATE_CAP) { finishQuiet(true, 'cap'); return; }
    if (!lastAtEncoded || !lastBaseUrl || !lastHeaders) { finishQuiet(quietPaginated, 'no-meta'); return; }
    var headers = {};
    for (var k in lastHeaders) headers[k] = lastHeaders[k];
    originalFetch(buildActiveUrl(), {
      method: 'POST',
      headers: headers,
      body: buildActiveBodyWith(token),
      credentials: 'include'
    })
      .then(function (resp) {
        if (!resp || !resp.ok) { finishQuiet(quietPaginated, 'status' + (resp ? resp.status : 'none')); return null; }
        return resp.text();
      })
      .then(function (txt) {
        if (!txt) return;
        var added = ingest(txt, { emitOnlyIfAdded: true, fromActivePaginate: true });
        if (added > 0) quietPaginated = true;
        var next = pendingCursor;
        var totalNow = baseSize();
        // v27: диагностика opaque-кандидатов на каждом шаге пагинации
        if (lastPaginateOpaqueCandidates) {
          var cands = lastPaginateOpaqueCandidates.cands;
          debugLog('log', '[gemini-paginate] шаг ' + depth + ': +ходов=' + added + ' всего=' + totalNow +
            ' | outer[0].len=' + lastPaginateOpaqueCandidates.arr0len +
            ' | rest=[' + lastPaginateOpaqueCandidates.restTypes.join(',') + ']' +
            ' | turns.len=' + lastPaginateOpaqueCandidates.turnsLen +
            ' | lastTurn=' + lastPaginateOpaqueCandidates.lastDesc +
            ' | opaque-кандидаты: ' + (cands.length ? cands.join('  ||  ') : '(кандидатов 0)'));
        } else {
          debugLog('log', '[gemini-paginate] шаг ' + depth + ': +ходов=' + added + ' всего=' + totalNow + ' | lastPaginateOpaqueCandidates=null (handleOuter не заполнил)');
        }
        if (next) {
          paginateLoop(next, depth + 1);
        } else {
          // v28: fallback — ищем fbb-токен в сыром тексте ответа, если стандартный opaque-курсор не найден
          var fbbMatch = txt.match(/fbb[0-9a-f]{10,}/i);
          if (fbbMatch) {
            paginateLoop(fbbMatch[0], depth + 1);
            return;
          }
          // v4x: достигли начала ТОЛЬКО если последний шаг добавил ходов и не упёрся в protobuf-страницу.
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.effectiveReachedStart) {
            reachedStart = window.GeminiInterceptLogic.effectiveReachedStart(true, added, lastFailedSkeleton);
          } else {
            reachedStart = added > 0;
          }
          console.log('[gemini-paginate] шаг ' + depth + ': +ходов=' + added + ' всего=' + totalNow + ', курсора нет → достигнут начало диалога (reachedStart=' + reachedStart + ')');
          debugLog('log', '[paginate-dump] строки оборвавшегося ответа: ' +
            (lastAllStrings.length ? lastAllStrings.join(' | ') : '(нет)'));
          // v27: дополнительный полный рентген для шага, оборвавшего цикл
          if (lastPaginateOpaqueCandidates) {
            var c = lastPaginateOpaqueCandidates;
            debugLog('log', '[gemini-paginate] ⚠ РЕНТГЕН ОБОРВАВШЕГО ШАГА depth=' + depth +
              ': outer[0].len=' + c.arr0len +
              ' | rest=[' + c.restTypes.join(',') + ']' +
              ' | turns.len=' + c.turnsLen +
              ' | lastTurn=' + c.lastDesc +
              ' | opaque-кандидаты: ' + (c.cands.length ? c.cands.join('  ||  ') : '(кандидатов 0)'));
          }
          finishQuiet(true, 'end');
        }
      })
      .catch(function (err) {
        debugLog('log', '[gemini-paginate] ошибка шага ' + depth + ': ' + err);
        finishQuiet(quietPaginated, 'err');
      });
  }
  function finishQuiet(success, reason) {
    quietActive = false;
    if (success) historyFullByQuiet = true;
    console.log('[gemini-paginate] тихий цикл завершён: success=' + success + ' reason=' + reason +
      ' quietPaginated=' + quietPaginated + ' ходов в базе=' + baseSize() +
      (success ? ' (ПОЛНАЯ история собрана СЕТЬЮ, без скролла)' : ''));
    if (success) { try { emitBaseSnapshot(); } catch (e) { } }
    if (success && quietPaginated) {
      try { activeRefresh('досбор хвоста после тихой пагинации'); } catch (e) { }
    }
    console.log('[gemini-paginate] тихий цикл завершён → запускаю автоскролл для досбора старой истории');
    if (!quietPaginated) {
      console.log('[gemini-paginate] тихий цикл не добавил ходов → фолбэк: запускаю автоскролл');
      scheduleAutoScroll();
    }
  }

  function activeRefresh(reason, rebuild) {
    if (activeDisabled || activeBusy) return;
    var convId = getConvId();
    if (!convId || !lastAtEncoded || !lastBaseUrl || !lastHeaders) {
      if (!loggedActiveStatus) { loggedActiveStatus = true; console.log('[gemini-virtual-f5] активный запрос отложен: нет convId/at/url/заголовков пока'); }
      return;
    }
    activeBusy = true;
    var headers = {};
    for (var k in lastHeaders) headers[k] = lastHeaders[k];
    originalFetch(buildActiveUrl(), {
      method: 'POST',
      headers: headers,
      body: buildActiveBody(),
      credentials: 'include'
    })
      .then(function (resp) {
        if (!loggedActiveStatus) {
          loggedActiveStatus = true;
          console.log('[gemini-virtual-f5] первый активный запрос: статус ' + (resp ? resp.status : 'none') + ' (convId=' + convId + ', ' + reason + ')');
        }
        if (!resp || !resp.ok) {
          activeDisabled = true;
          debugLog('log', '[gemini-virtual-f5] не прошёл (статус ' + (resp ? resp.status : 'none') +
            ') → остаёмся на пассиве+DOM');
          return null;
        }
        return resp.text();
      })
      .then(function (txt) {
        if (!txt) return;
        ingest(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });
      })
      .catch(function (err) {
        if (!loggedActiveStatus) loggedActiveStatus = true;
        activeDisabled = true;
        debugLog('log', '[gemini-virtual-f5] ошибка активного запроса: ' + err + ' → остаёмся на пассиве+DOM');
      })
      .finally(function () { activeBusy = false; });
  }

  function startRefreshObserver() {
    if (observerStarted) return;
    observerStarted = true;
    lastActiveAt = Date.now();
    try {
      var obs = new MutationObserver(function (mutations) {
        var hasNew = false;
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          var tgt = m.target;
          try { if (tgt && tgt.closest && tgt.closest('#ai-context-widget')) continue; } catch (e) { }
          if (m.type === 'characterData') { hasNew = true; break; }
          if (m.type === 'childList') {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j];
              if (n.nodeType === 1 && (n.textContent || '').trim().length > 10) { hasNew = true; break; }
            }
          }
          if (hasNew) break;
        }
        if (!hasNew) return;
        clearTimeout(mutTimer);
        mutTimer = setTimeout(function () {
          if (Date.now() < scrollRecentUntil) return; // мутации от скролла — не rebuild
          var now = Date.now();
          if (now - lastActiveAt < REFRESH_MIN_MS) return;
          lastActiveAt = now;
          activeRefresh('после мутаций (realtime)', true);
        }, 2500);
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) {
      debugLog('log', '[gemini-virtual-f5] не удалось поставить observer-триггер:', e);
    }
  }

  // v4x: санация мышления и строгий дедуп финального массива сообщений.
  function sanitizeMessagesForEmit(messages) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.sanitizeFinalMessages) {
      var parser = (typeof window !== 'undefined' && window.GeminiBatchexecuteParser) ? window.GeminiBatchexecuteParser : null;
      return window.GeminiInterceptLogic.sanitizeFinalMessages(messages, {
        isThinkingAssistant: (parser && parser.isThinkingAssistant) ? function (s) { return parser.isThinkingAssistant(s); } : null,
        stripLeadingThinking: (parser && parser.stripLeadingThinking) ? function (s) { return parser.stripLeadingThinking(s); } : null
      });
    }
    return messages;
  }

  // ================= единый эмит снимка базы =================
  function emitBaseSnapshot() {
    // v35: финальный порядок по связному списку r1 (детерминирован, не зависит от
    // порядка прибытия страниц). Фолбэк — сортировка по order (прежнее поведение).
    var orderItems = [];
    var mapIds = Object.keys(turnsMap);
    // v36 диагностика head: «ход» = turnId||id (как в orderByR1Chain).
    var diagR1Targets = {};   // значения r1 (id более новых соседей)
    var diagTurnSeen = {};    // turnId -> true
    var diagTurnNull = {};    // turnId -> true, если у хода r1 === null/undefined
    for (var oi = 0; oi < mapIds.length; oi++) {
      var oid = mapIds[oi];
      var ot = turnsMap[oid];
      orderItems.push({
        id: oid,
        turnId: ot.turnId || null,
        r1: ot.r1 || null,
        order: ot.order || 0,
        role: ot.role
      });
      var oTk = ot.turnId || oid;
      if (ot.r1) diagR1Targets[ot.r1] = true;
      if (!(oTk in diagTurnSeen)) {
        diagTurnSeen[oTk] = true;
        diagTurnNull[oTk] = !ot.r1;
      } else if (ot.r1) {
        diagTurnNull[oTk] = false;
      }
    }
    var nullR1Count = 0;
    var headCandidates = [];
    var diagTurns = Object.keys(diagTurnSeen);
    for (var dti = 0; dti < diagTurns.length; dti++) {
      var dTk = diagTurns[dti];
      if (diagTurnNull[dTk]) nullR1Count++;
      if (!diagR1Targets[dTk]) headCandidates.push(dTk);
    }
    // v4x: финальный порядок — строго по r1-цепочке объединения (голова = r1=null либо
    // id, на который никто не ссылается как на r1). Несвязанный остаток докладывается
    // по arrival внутри orderByR1Chain. Приоритет порядка restored-ленты убран полностью.
    var ids = null;
    var usedR1 = false;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic) {
      if (window.GeminiInterceptLogic.orderByR1Chain) {
        var chain = window.GeminiInterceptLogic.orderByR1Chain(orderItems);
        if (chain.ok) { ids = chain.ids; usedR1 = true; }
      }
      if (!ids && window.GeminiInterceptLogic.orderByArrival) {
        var arr = window.GeminiInterceptLogic.orderByArrival(orderItems);
        if (arr.ok) ids = arr.ids;
      }
    }
    if (!ids) {
      if (orderItems.length) {
        debugLog('log', '[gemini-order] r1-цепочка и порядок прибытия разорваны, фолбэк (сортировка по order)');
      }
      ids = mapIds.slice().sort(function (a, b) {
        return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
      });
    }
    lastOrderedIds = ids.slice();

    // v39: самопроверка r1-инверсий (r1 = сосед СТАРШЕ, должен идти раньше).
    var inversions = 0;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.countR1Inversions) {
      var invItems = [];
      for (var ivi = 0; ivi < ids.length; ivi++) {
        var ivRec = turnsMap[ids[ivi]];
        invItems.push({ id: ids[ivi], turnId: ivRec ? ivRec.turnId : null, r1: ivRec ? ivRec.r1 : null });
      }
      inversions = window.GeminiInterceptLogic.countR1Inversions(invItems);
    }
    debugLog('log', '[gemini-order-check] inversions=' + inversions);

    // Диагностика порядка/покрытия одним логом (см. ТЗ).
    var mapTurns = mapIds.length;
    var chainLen = ids.length;
    var inChain = {};
    for (var ci = 0; ci < ids.length; ci++) inChain[ids[ci]] = true;
    var disconnected = [];
    for (var di = 0; di < mapIds.length; di++) {
      if (!inChain[mapIds[di]]) disconnected.push(mapIds[di]);
    }
    var disconnectedCount = Math.max(0, mapTurns - chainLen);
    var firstUser = '';
    for (var fu = 0; fu < ids.length; fu++) {
      var fud = turnsMap[ids[fu]];
      if (fud && fud.role === 'user') { firstUser = (fud.text || '').slice(0, 60); break; }
    }
    var lastId = ids.length ? ids[ids.length - 1] : null;
    var lastText = lastId && turnsMap[lastId] ? (turnsMap[lastId].text || '').slice(-60) : '';
    var orderLog = '[gemini-order] mode=' + (usedR1 ? 'chain-r1' : 'arrival') +
      ' mapTurns=' + mapTurns +
      ' chainLen=' + chainLen +
      ' disconnected=' + disconnectedCount +
      ' nullR1Count=' + nullR1Count +
      ' headCandidates=' + (headCandidates.length ? headCandidates.join(',') : 'нет head') +
      ' firstUser=' + JSON.stringify(firstUser) +
      ' lastText=' + JSON.stringify(lastText);
    if (disconnectedCount > 0 || mapTurns !== chainLen) {
      var dd = [];
      for (var dk = 0; dk < disconnected.length && dk < 3; dk++) {
        var did = disconnected[dk];
        dd.push(did + '(r1=' + (turnsMap[did] ? String(turnsMap[did].r1 || '') : '') + ')');
      }
      if (dd.length) orderLog += ' detached=[' + dd.join(',') + ']';
    }
    debugLog('log', orderLog);

    var pieces = []; var lastModelName = '';
    for (var j = 0; j < ids.length; j++) {
      var t = turnsMap[ids[j]];
      pieces.push(t.text);
      if (t.modelName) lastModelName = t.modelName;
    }
    // v31: сообщения с ролями (user/assistant) для экспорта истории
    var messages = [];
    for (var mi = 0; mi < ids.length; mi++) {
      var tm = turnsMap[ids[mi]];
      messages.push({ role: (tm.role === 'user') ? 'user' : 'assistant', text: tm.text, id: ids[mi] });
    }
    // v4x: санация мышления и строгий дедуп ПЕРЕД эмиссией и сохранением.
    // messageTexts/messageIds пересобираем из санированного messages, чтобы
    // historyPreviews и экспорт не содержали блоков мышления и дублей.
    messages = sanitizeMessagesForEmit(messages);
    // v4x: возвращаем r1/turnId к санированным сообщениям, чтобы лента (tape) сохраняла
    // связный список порядка и после восстановления мерджилась по r1-цепочке.
    for (var mr = 0; mr < messages.length; mr++) {
      var mrid = messages[mr].id;
      var mrec = turnsMap[mrid];
      if (mrec) {
        messages[mr].r1 = mrec.r1 || null;
        messages[mr].turnId = mrec.turnId || null;
      }
    }
    pieces = [];
    var cleanIds = [];
    for (var cj = 0; cj < messages.length; cj++) {
      pieces.push(messages[cj].text);
      if (messages[cj].id != null) cleanIds.push(messages[cj].id);
    }
    ids = cleanIds;
    var text = pieces.join('\n');
    var effectiveLen = text.length;
    var floorApplied = false;
    var floorValue = 0;

    // v29: диагностика полноты базы ДО применения пола
    var fid = getConvId();
    var savedFloor = fid ? loadFloor(fid) : null;
    var baseComplete = historyFullByQuiet;
    debugLog('log', '[gemini-base-diag] count=' + ids.length + ' textLen=' + text.length +
      ' baseComplete=' + baseComplete + ' floorCount=' + (savedFloor ? savedFloor.count : '-'));

    // v27/vXX: пол применяем ТОЛЬКО как защиту от просадки при НЕполной загрузке
    // (baseComplete=false). При baseComplete=true effectiveLen = фактический textLen базы,
    // пол НЕ применяется. Обновляем пол только когда база полная (baseComplete) и
    // тихая пагинация дошла до начала (reachedStart).
    if (fid && typeof window !== 'undefined' && window.GeminiInterceptLogic) {
      var resolved = window.GeminiInterceptLogic.resolveFloor(text.length, ids.length, savedFloor, baseComplete);
      effectiveLen = resolved.effectiveLen;
      floorApplied = resolved.floorApplied;
      floorValue = resolved.floorValue;
      if (floorApplied) {
        console.log('[gemini-intercept] пол применён: count=' + ids.length +
          ' (сохранённый=' + savedFloor.count + '), effectiveLen=' + effectiveLen +
          ' (сохранённый=' + savedFloor.effectiveLen + '), floorApplied=true, floorValue=' + floorValue);
      }
      if (window.GeminiInterceptLogic.shouldSaveFloor(baseComplete, reachedStart)) {
        // передаём РЕАЛЬНЫЕ text.length и ids.length — saveFloor сама решит, обновлять ли
        saveFloor(fid, ids.length, text.length);
      }
    }

    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: {
          convId: fid,
          text: text,
          count: ids.length,
          effectiveLen: effectiveLen,
          lastMessageText: pieces.length ? pieces[pieces.length - 1] : '',
          modelSlug: lastModelName || '',
          messageTexts: pieces,
          messageIds: ids,
          messages: messages,
          attachTokens: attachTokens,
          attachBreak: { imgTokens: attachBreak.imgTokens, docTokens: attachBreak.docTokens, imgCount: attachBreak.imgCount, docCount: attachBreak.docCount },
          historyComplete: historyFullByQuiet,
          floorApplied: floorApplied,
          floorValue: floorValue
        }
      }));
    } catch (e) { }
    return { count: ids.length, textLen: text.length, effectiveLen: effectiveLen, lastModelName: lastModelName, floorApplied: floorApplied, floorValue: floorValue };
  }

  // ================= ingest =================
  function ingest(raw, opts) {
    opts = opts || {};
    var emitOnlyIfAdded = !!opts.emitOnlyIfAdded;
    var fromVirtualF5 = !!opts.fromVirtualF5;
    var fromActivePaginate = !!opts.fromActivePaginate;
    var shouldRebuild = !!opts.rebuild;
    var src = fromVirtualF5 ? 'vf5' : (fromActivePaginate ? 'pag' : 'passive');
    var wasFull = historyFullByQuiet;
    pendingCursor = null;

    var parsed;
    try { parsed = parseBatchExecute(raw, src); }
    catch (e) {
      if (!loggedErr) { loggedErr = true; console.warn('[gemini-intercept] ошибка парсинга batchexecute:', e); }
      return 0;
    }
    if (!parsed.length) {
      if (!loggedErr) { loggedErr = true; debugLog('log', '[gemini-intercept] batchexecute распознан, но ходов не найдено'); }
      return 0;
    }

    // v32/vXX: полная пересборка vf5 допустима ТОЛЬКО если пейлоад НЕ содержит курсора
    // продолжения (действительно полная история). При наличии курсора это частичная история —
    // merge по id без сброса (turnsMap дедуплицирует). Решение принимаем ПОСЛЕ парсинга,
    // когда pendingCursor (курсор из этого пейлоада) уже известен.
    var fullRebuildFromVf5 = false;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic) {
      fullRebuildFromVf5 = window.GeminiInterceptLogic.shouldFullRebuild({ fromVirtualF5: fromVirtualF5, wasFull: wasFull, hasCursor: !!pendingCursor });
    } else {
      fullRebuildFromVf5 = !!(fromVirtualF5 && wasFull);
    }
    if (fullRebuildFromVf5) {
      turnsMap = {};
      orderCounter = 0;
      prependCursor = -1;
      console.log('[gemini-rebuild] полная пересборка из vf5 (без курсора), ходов: ' + parsed.length);
    } else if (fromVirtualF5 && wasFull && pendingCursor) {
      console.log('[gemini-rebuild] vf5 содержит курсор продолжения → merge по id без сброса (turnsMap дедуплицирует)');
    }
    debugLog('log', '[gemini-ingest-trace] src=' + src + ' блоков_ходов=' + parsed.length +
      ' ids=[' + parsed.map(function (x) { return x.id; }).join(',') + ']');

    // v25: пересборка ветки при realtime-vf5 (после действий пользователя).
    // Парсинг уже выполнен — handleOuter установил pendingCursor (или оставил null).
    // Стоп-кран: если курсора нет — пересборка отменяется, turnsMap не сбрасывается.
    // v26: пересборка только пока история ещё не полная (wasFull=false);
    // после полной сборки vf5 только докидывает ходы поверх, не перетирает базу.
    var doRebuild = shouldRebuild && !wasFull;
    debugLog('log', '[gemini-rebuild] src=' + src + ' wasFull=' + wasFull +
      ' rebuild=' + doRebuild + ' baseSizeBefore=' + baseSize());
    if (doRebuild) {
      if (!pendingCursor) {
        debugLog('log', '[gemini-rebuild] pendingCursor в vf5-блоке = null → пересборка отменена, оставлено прежнее поведение');
      } else {
        debugLog('log', '[gemini-rebuild] курсор есть — докидываем vf5-ходы к накопленной базе (дедуп по id), курсор=' + edges8(pendingCursor) +
          ' было_ходов=' + baseSize());
        historyFullByQuiet = false;
        quietActive = false;
        quietPaginated = false;
        quietDecisionMade = false;
        // turnsMap и orderCounter не сбрасываем — vf5-ходы добавляются к уже накопленной базе
      }
    }

    // v33: глобальный порядок страниц. Страницы пагинации — «старше» (prepend, отрицательный
    // order), passive/vf5 — «свежие» (append). order хранит глобальную позицию.
    // v39: внутри страницы порядок строим по r1-цепочке (old→new), иначе — порядок прибытия.
    var pageSeq = parsed;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.orderPageByR1) {
      var r1pg = window.GeminiInterceptLogic.orderPageByR1(parsed);
      if (r1pg && Array.isArray(r1pg.ids) && r1pg.ids.length === parsed.length) {
        var byIdPage = {};
        for (var pb = 0; pb < parsed.length; pb++) byIdPage[parsed[pb].id] = parsed[pb];
        var reorderedPage = [];
        for (var pr = 0; pr < r1pg.ids.length; pr++) {
          var prec = byIdPage[r1pg.ids[pr]];
          if (prec) reorderedPage.push(prec);
        }
        if (reorderedPage.length === parsed.length) pageSeq = reorderedPage;
      }
    }
    var pageMode = fromActivePaginate ? 'older' : 'fresh';
    var orderState = { orderCounter: orderCounter, prependCursor: prependCursor };
    var pageOrders = [];
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.assignPageOrders) {
      pageOrders = window.GeminiInterceptLogic.assignPageOrders(pageSeq.length, pageMode, orderState);
    } else {
      for (var oi = 0; oi < pageSeq.length; oi++) pageOrders.push(orderCounter++);
    }
    orderCounter = orderState.orderCounter;
    prependCursor = orderState.prependCursor;

    var added = 0;
    for (var i = 0; i < pageSeq.length; i++) {
      var p = pageSeq[i];
      if (!turnsMap[p.id]) {
        turnsMap[p.id] = { text: p.text, modelName: p.modelName, order: pageOrders[i], pageMode: src, ts: p.ts || 0, role: (p.role === 'user') ? 'user' : 'assistant', turnId: p.turnId || null, r1: p.r1 || null };
        added++;
      } else if (turnsMap[p.id].pageMode === 'restored') {
        // v4x: сетевой ход ПЕРЕЗАПИСЫВАЕТ restored-ход того же id (текст и r1).
        turnsMap[p.id] = { text: p.text, modelName: p.modelName, order: pageOrders[i], pageMode: src, ts: p.ts || 0, role: (p.role === 'user') ? 'user' : 'assistant', turnId: p.turnId || null, r1: p.r1 || null };
      } else if (!turnsMap[p.id].r1 && p.r1) {
        if (!turnsMap[p.id].pageMode) turnsMap[p.id].pageMode = src;
        turnsMap[p.id].r1 = p.r1;
        if (!turnsMap[p.id].turnId && p.turnId) turnsMap[p.id].turnId = p.turnId;
      }
    }
    var em = null;
    var shouldEmit = !emitOnlyIfAdded || added > 0;
    if (shouldEmit) em = emitBaseSnapshot();
    var emCount = em ? em.count : baseSize();
    var emLen = em ? em.textLen : 0;
    var emModel = em ? em.lastModelName : '';
    if (!loggedOk) {
      loggedOk = true;
      console.log('[gemini-intercept] ✓ распознано ходов: ' + emCount + ' (новых: ' + added +
        '), символов: ' + emLen + ', модель из данных: ' + (emModel || '?') + ' [' + src + ']');
    } else if (added > 0) {
      console.log('[gemini-intercept] + добавлено ходов: ' + added + ', всего: ' + emCount + ', символов: ' + emLen + ' [' + src + ']');
    }
    if (!loggedAttach && attachTokens > 0) {
      loggedAttach = true;
      console.log('[gemini-intercept] 📎 вложения учтены (дедуп по имени, глобально): картинок=' +
        attachBreak.imgCount + ' (≈' + attachBreak.imgTokens + ' ток, по 2 тайла), файлов=' +
        attachBreak.docCount + ' (≈' + attachBreak.docTokens + ' ток, оценочно) → всего вложений ≈' + attachTokens + ' токенов');
    }

    if (!observerStarted && baseSize() > 0) {
      startRefreshObserver();
    }

    // v19: разрешаем тихую пагинацию из vf5-ответа при переключении чата.
    // При SPA-переключении сайт не всегда шлёт пассивный загрузочный hNvQHb;
    // тогда база остаётся vf5-хвостом с неполными вложениями (наблюдено 37.8% против 41.7% F5).
    // Теперь vf5 сам запускает paginateLoop по курсору из ответа, если история ещё не собрана.
    // quietDecisionMade взводим сразу, чтобы пассивная ветка не запустила второй параллельный цикл.
    if (fromVirtualF5 && !historyFullByQuiet && !quietActive && pendingCursor && baseSize() > 0) {
      quietActive = true;
      quietDecisionMade = true;
      console.log('[gemini-paginate] курсор найден в vf5-ответе (len=' + pendingCursor.length + ', ' + edges8(pendingCursor) +
        ') → запускаю тихий цикл пагинации БЕЗ скролла (vf5-инициирован)');
      paginateLoop(pendingCursor, 0);
    }

    if (!fromVirtualF5 && !fromActivePaginate && baseSize() > 0 && !quietDecisionMade) {
      quietDecisionMade = true;
      if (pendingCursor) {
        quietActive = true;
        console.log('[gemini-paginate] курсор найден в снимке (len=' + pendingCursor.length + ', ' + edges8(pendingCursor) +
          ') → запускаю тихий цикл пагинации БЕЗ скролла');
        paginateLoop(pendingCursor, 0);
      } else {
        console.log('[gemini-paginate] курсора в снимке нет → тихий путь недоступен, фолбэк: автоскролл');
        scheduleAutoScroll();
      }
    }

    return added;
  }

  // ---- подмена fetch (v24: тихий catch на промисе originalFetch + устранение висячего Promise.reject) ----
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { }

      // v21: диагностические метки для лога «гард слеп»
      var diagInputType = (typeof input === 'string') ? 'url-string' : ((typeof Request !== 'undefined' && input instanceof Request) ? 'Request' : 'other');
      var diagInitBody = (init && init.body) ? (typeof init.body === 'string' ? 'string' : 'other') : 'absent';

      if (isHistoryRpc(url)) {
        var hdrs = captureHeadersFromInit(input, init);
        var bodyStr = '';
        try {
          if (typeof Request !== 'undefined' && input instanceof Request) {
            input.clone().text().then(function (t) { rememberSiteMeta(url, hdrs, t); }).catch(function () { });
          } else if (init && typeof init.body === 'string') { bodyStr = init.body; }
        } catch (e) { }
        rememberSiteMeta(url, hdrs, bodyStr);
      }

      // v21: строим reqConvIdPromise — всегда резолвится строкой, никогда не реджектится
      var reqConvIdPromise = Promise.resolve('');
      if (isHistoryRpc(url)) {
        if (init && typeof init.body === 'string') {
          // строковое тело — синхронно
          reqConvIdPromise = Promise.resolve(convIdFromBody(init.body));
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          // Request-объект — клонируем и читаем тело параллельно originalFetch
          try {
            var cloned = input.clone();
            reqConvIdPromise = cloned.text().then(function (t) {
              return convIdFromBody(t);
            }).catch(function () { return ''; });
          } catch (e) {
            reqConvIdPromise = Promise.resolve('');
          }
        }
      }

      var promise;
      try { promise = originalFetch.apply(this, arguments); } catch (e) { return Promise.reject(e); }

      // v24: тихий catch — снимает ложный unhandled rejection для чужих прерванных запросов
      // (Failed to fetch при навигации/переключении/обрыве стрима), не меняя поведения страницы
      promise.catch(function () { /* тихо: снимаем ложный unhandled для чужих прерванных запросов */ });

      if (isHistoryRpc(url)) {
        promise.then(function (resp) {
          try {
            if (resp && resp.ok) {
              resp.clone().text().then(function (txt) {
                // v21: гард ждёт reqConvIdPromise (обычно уже разрешён)
                reqConvIdPromise.then(function (reqConvId) {
                  if (reqConvId && reqConvId !== currentConvId) {
                    console.log('[gemini-intercept] пропущен устаревший снимок (convId запроса ' + reqConvId + ' != текущий ' + currentConvId + ')');
                    return;
                  }
                  if (!reqConvId) {
                    // v21: точный диагностический лог при слепоте
                    console.log('[gemini-intercept] гард слеп (reqConvId пуст) путь=fetch input=' + diagInputType +
                      ' init.body=' + diagInitBody + ' — ответ пропущен без проверки');
                  }
                  // первый валидный ответ нового чата снимает блокировку автоскролла
                  if (autoScrollBlocked) {
                    autoScrollBlocked = false;
                    if (autoScrollUnblockTimer) { clearTimeout(autoScrollUnblockTimer); autoScrollUnblockTimer = null; }
                    console.log('[gemini-intercept] автоскролл разблокирован — получен первый валидный снимок чата ' + currentConvId);
                  }
                  ingest(txt, {});
                });
              }).catch(function () { });
            }
          } catch (e) { }
          return resp;
        }, function () { /* v24: тихо — не создаём висячий Promise.reject */ });
      }
      // v28: DIAG_TOKENS — диагностический перехват ВСЕХ ответов Gemini (не только history RPC)
      promise.then(function (resp) {
        try {
          if (!resp || !resp.ok) return;
          var ct = '';
          try { ct = resp.headers.get('content-type') || ''; } catch (e) { }
          if (!diagCanScan(url, ct)) return;
          if (diagScannedCount < DIAG_MAX_SCANNED) {
            diagScannedCount++;
            debugLog('log', '[gemini-token-diag-scan] url=' + url +
              ' ct=' + ct + ' stream=' + (diagIsStream(url, ct) ? 'true' : 'false'));
          }
          var isStream = diagIsStream(url, ct);
          resp.clone().text().then(function (txt) {
            diagScanResponse(txt, url, isStream);
          }).catch(function () { });
        } catch (e) { }
        return resp;
      }, function () { });
      return promise;
    };
  }

  // ---- подмена XHR (v21: гард по convId, без изменений относительно v20) ----
  if (originalXHROpen && originalXHRSend) {
    OriginalXHR.prototype.open = function (method, url) {
      try { this.__aiCm = { method: String(method).toUpperCase(), url: String(url), headers: {} }; } catch (e) { }
      return originalXHROpen.apply(this, arguments);
    };
    if (originalSetHeader) {
      OriginalXHR.prototype.setRequestHeader = function (k, v) {
        try { if (this.__aiCm) this.__aiCm.headers[k] = v; } catch (e) { }
        return originalSetHeader.apply(this, arguments);
      };
    }
    OriginalXHR.prototype.send = function (body) {
      var info = this.__aiCm || {}; var url = info.url || '';
      if (isHistoryRpc(url)) {
        rememberSiteMeta(url, info.headers || {}, typeof body === 'string' ? body : '');
      }
      // v20: сохраняем reqConvId в this.__aiCm для использования в load-обработчике
      if (isHistoryRpc(url) && typeof body === 'string') {
        info.reqConvId = convIdFromBody(body);
      }
      if (isHistoryRpc(url)) {
        var self = this;
        this.addEventListener('load', function () {
          try {
            if (self.status >= 200 && self.status < 300 && self.responseText) {
              // v20: гард — ответ от старого чата игнорируем
              var rcv = self.__aiCm && self.__aiCm.reqConvId;
              if (rcv && rcv !== currentConvId) {
                console.log('[gemini-intercept] пропущен устаревший снимок (convId запроса ' + rcv + ' != текущий ' + currentConvId + ')');
                return;
              }
              if (!rcv) {
                // v21: точный диагностический лог при слепоте (XHR)
                console.log('[gemini-intercept] гард слеп (reqConvId пуст) путь=xhr input=send body=' +
                  (typeof body === 'string' ? 'string len=' + body.length : (body ? typeof body : 'absent')) +
                  ' — ответ пропущен без проверки');
              }
              // первый валидный ответ нового чата снимает блокировку автоскролла
              if (autoScrollBlocked) {
                autoScrollBlocked = false;
                if (autoScrollUnblockTimer) { clearTimeout(autoScrollUnblockTimer); autoScrollUnblockTimer = null; }
                console.log('[gemini-intercept] автоскролл разблокирован — получен первый валидный XHR-снимок чата ' + currentConvId);
              }
              ingest(self.responseText, {});
            }
          } catch (e) { }
        });
      }
      // v28: DIAG_TOKENS — диагностический перехват ВСЕХ XHR-ответов (не только history RPC)
      try {
        var self2 = this;
        this.addEventListener('load', function () {
          try {
            if (self2.status >= 200 && self2.status < 300 && self2.responseText) {
              var ct2 = '';
              try { ct2 = self2.getResponseHeader('content-type') || ''; } catch (e) { }
              if (diagCanScan(url, ct2)) {
                if (diagScannedCount < DIAG_MAX_SCANNED) {
                  diagScannedCount++;
                  debugLog('log', '[gemini-token-diag-scan] url=' + url +
                    ' ct=' + ct2 + ' stream=' + (diagIsStream(url, ct2) ? 'true' : 'false'));
                }
                var isStream2 = diagIsStream(url, ct2);
                diagScanResponse(self2.responseText, url, isStream2);
              }
            }
          } catch (e) { }
        });
      } catch (e) { }
      return originalXHRSend.apply(this, arguments);
    };
  }

  // ---- v28: слияние сохранённой ленты (из content.js) со свежей сетевой ----
  // Контент-скрипт (content.js) восстанавливает ленту из chrome.storage.local
  // и передаёт её сюда событием ai-cm-restored-history. Свежие сетевые ходы
  // перезаписывают сохранённые по id; сохранённые ходы, которых нет в сети, ДОПОЛНЯЮТ базу.
  window.addEventListener('ai-cm-restored-history', function (ev) {
    var detail = ev && ev.detail;
    if (!detail || !detail.turns || !detail.turns.length) return;
    var restoredTurns = detail.turns;
    var restoredConvId = detail.convId || '';
    var current = getConvId();

    // гард: принимаем только для текущего чата
    if (restoredConvId !== current) {
      debugLog('log', '[gemini-restore] пропущена лента для чужого чата (restored=' + restoredConvId + ', current=' + current + ')');
      return;
    }

    // v4x: версия записи ленты должна совпадать с текущей версией парсера,
    // иначе игнорируем запись без миграции.
    var restoreMeta = detail.meta || {};
    var restoreVersion = (typeof restoreMeta.version === 'string') ? restoreMeta.version : '';
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldAcceptTape) {
      if (!window.GeminiInterceptLogic.shouldAcceptTape({ meta: { version: restoreVersion } }, parserVersion)) {
        debugLog('log', '[gemini-restore] tape ignored: version=' + (restoreVersion || '(none)'));
        return;
      }
    }

    // v4x: мерджим restored-ленту, пока пагинация НЕ дошла до начала (reachedStart=false),
    // НЕЗАВИСИМО от baseComplete/historyFullByQuiet.
    var mergeRestored = true;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldMergeRestoredTurns) {
      mergeRestored = window.GeminiInterceptLogic.shouldMergeRestoredTurns(reachedStart);
    } else {
      mergeRestored = (reachedStart !== true);
    }
    if (!mergeRestored) {
      debugLog('log', '[gemini-restore] достигнут начало диалога (reachedStart=true) → восстановление из хранилища пропущено');
      return;
    }

    mergeRestoredTurns(restoredTurns);
  });

  // v4x: при чтении ленты повторно применяем sanitizeFinalMessages к каждому ходу.
  function sanitizeRestoredTurn(rt) {
    var arr = [{
      role: (rt && rt.role === 'user') ? 'user' : 'assistant',
      text: (rt && rt.text != null) ? String(rt.text) : '',
      id: (rt && rt.id != null) ? String(rt.id) : null
    }];
    var clean = sanitizeMessagesForEmit(arr);
    if (!clean || !clean.length) return null;
    var c = clean[0];
    if (!c || !c.text || !c.text.trim()) return null;
    return { id: c.id, text: c.text, role: c.role, r1: (rt && rt.r1) || null };
  }

  function mergeRestoredTurns(restoredTurns) {
    // v4x: сеть авторитетна по id — restored добавляется ТОЛЬКО для недостающих id.
    // Финальный порядок строит orderByR1Chain по объединению (в emitBaseSnapshot);
    // приоритет порядка restored-ленты убран полностью, несвязанный остаток — по arrival.
    var i, rt, m;
    var missing = [];
    var maxOrder = 0;
    var netIds = Object.keys(turnsMap);
    for (i = 0; i < netIds.length; i++) {
      var no = turnsMap[netIds[i]].order || 0;
      if (no > maxOrder) maxOrder = no;
    }
    for (i = 0; i < restoredTurns.length; i++) {
      rt = restoredTurns[i];
      if (!rt || !rt.id) continue;
      if (turnsMap[rt.id]) continue; // сеть авторитетна
      var clean = sanitizeRestoredTurn(rt);
      if (!clean) continue;
      var turnId = String(clean.id).replace(/_(user|assistant)$/, '');
      var rr1 = clean.r1 ? String(clean.r1).replace(/_(user|assistant)$/, '') : null;
      missing.push({ id: clean.id, text: clean.text, role: clean.role, turnId: turnId, r1: rr1 });
    }
    if (!missing.length) {
      debugLog('log', '[gemini-restore] merged 0 missing ids (version=' + parserVersion + ')');
      return;
    }
    for (i = 0; i < missing.length; i++) {
      m = missing[i];
      turnsMap[m.id] = {
        text: m.text, modelName: '', order: maxOrder + 1 + i,
        pageMode: 'restored', ts: 0,
        role: (m.role === 'user') ? 'user' : 'assistant',
        turnId: m.turnId, r1: m.r1
      };
    }
    debugLog('log', '[gemini-restore] merged ' + missing.length + ' missing ids (version=' + parserVersion + ')');
    try { emitBaseSnapshot(); } catch (e) { }
  }

  // ================= ДАМП ДИАГНОСТИКИ =================
  // content.js (ISOLATED-мир) диспатчит 'ai-cm-diag-request'; перехватчик (MAIN-мир)
  // отвечает 'ai-cm-diag-response' с полным состоянием порядка/логов.
  try {
    window.addEventListener('ai-cm-diag-request', function () {
      try {
        var turnDump = [];
        var mapKeys = Object.keys(turnsMap);
        for (var di = 0; di < mapKeys.length; di++) {
          var dk = mapKeys[di];
          var dRec = turnsMap[dk];
          turnDump.push({
            id: dk,
            order: dRec.order,
            pageMode: dRec.pageMode || '',
            r1: dRec.r1 || null,
            role: dRec.role,
            preview: String(dRec.text || '').slice(0, 60).replace(/\s+/g, ' ')
          });
        }
        var orderedPreviews = [];
        for (var op = 0; op < lastOrderedIds.length; op++) {
          var oid = lastOrderedIds[op];
          var oRec = turnsMap[oid];
          orderedPreviews.push((oRec ? (oRec.role + '|') : '?|') + (oRec ? String(oRec.text || '').slice(0, 60).replace(/\s+/g, ' ') : oid));
        }
        var response = {
          logsIntercept: (typeof __aiCmGetLogRing === 'function') ? __aiCmGetLogRing() : [],
          turns: turnDump,
          orderedPreviews: orderedPreviews,
          failedPageSkeleton: lastFailedSkeleton || null
        };
        window.dispatchEvent(new CustomEvent('ai-cm-diag-response', { detail: response }));
      } catch (e) { }
    });
  } catch (e) { }

  console.log('[gemini-intercept] перехватчик Gemini v28 установлен (структурный сбор вложений v23 + фикс курсора + сброс при смене чата + тихая пагинация из vf5 + гард пассивки по convId (fetch Request-объекты тоже) + защита автоскролла + virtual-f5 + historyComplete в emit + подавление чужих unhandled fetch + пересборка ветки при realtime-vf5 + пол (floor) через localStorage + диагностика opaque-кандидатов + сохранение/восстановление ленты через content.js)');
})();
