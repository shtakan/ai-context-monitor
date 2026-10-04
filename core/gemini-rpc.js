// =============================================================================
// core/gemini-rpc.js — v2.0 (Phase 3 step 5).
// RPC-СЛОЙ GEMINI: опознание ingest/stream-запросов batchexecute и метаданные НАШИХ
// RPC-запросов к истории (заголовки, at, _reqid, тело hNvQHb).
//
// Кластер вынесен из core/gemini-intercept.js. Раньше обе части жили в ОДНОМ IIFE,
// поэтому кластер обращался к состоянию ядра по именам. Теперь у модуля свой IIFE,
// и состояние ядра приходит через __bind(deps) — инжектируемые имена доступны как D.<имя>.
//
// Живое состояние ядра (activeSeq / lastAtEncoded / lastBaseUrl / lastHeaders / lastReqId)
// отдаётся НЕ копией значения, а геттерами/сеттерами: модуль и ядро читают и пишут ОДНИ И ТЕ
// ЖЕ переменные IIFE, потому что эти переменные читает не только кластер — проба полноты и
// watchdog пагинации сохраняют и восстанавливают их, а activeRefresh сравнивает seq.
//
// Тела функций перенесены без изменения логики и отступов; переписаны только ссылки
// на инжектируемые имена (D.<имя>) и ничего больше. Имена, сигнатуры и порядок
// вызовов сохранены. Оркестрация пагинации (paginateLoop, runCompletenessProbe,
// activeRefresh, watchdog) и тег запроса (captureReqTag/isStaleReqTag) осознанно
// ОСТАЛИСЬ в core/gemini-intercept.js: это разные темы, и состояние у них общее с ядром.
//
// Порядок подключения (core/background.js, registerSafe для перехватчика Gemini,
// document_start, world MAIN): utils/debug.js -> utils-парсеры -> hidden-scroll ->
// diag -> ЭТОТ ФАЙЛ -> core/gemini-intercept.js. Экспорт: window.AiCmGeminiRpc + module.exports.
// =============================================================================

(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiRpc) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  function __bind(d) { D = d; }

  // ---- v52: stream-ingest (I4z33b = ход пользователя, Bsxleb = ход модели; ветка ДО isIngestRpc) ----
  // batchexecute-запросы генерации не проходят isIngestRpc. Walker'ы — в utils/gemini-intercept-logic.js
  // (extractStreamUserTurn / extractStreamModelTurn). Дедуп — через turnsMap внутри существующего ingest;
  // курсор пагинации, loader и основной пайплайн (src=passive/vf5/pag) НЕ трогаем.
  var STREAM_USER_RPCIDS = { I4z33b: 1 };
  var STREAM_MODEL_RPCIDS = { Bsxleb: 1 };

  function isHistoryRpc(url) {
    return !!url && url.indexOf('batchexecute') !== -1 && url.indexOf('hNvQHb') !== -1;
  }

  // v50: инкрементальный фид текущего чата. В открытом чате новый ход (user+ответ) приходит
  // batchexecute-запросом БЕЗ маркера hNvQHb в URL (источник — source-path .../app/<convId>),
  // поэтому isHistoryRpc() его не ловил → новые ходы не попадали в turnsMap (бейдж заморожен).
  // Здесь ловим такой фид для перехватчика инжеста, но НЕ трогаем rememberSiteMeta (база лоадера
  // строится по-прежнему только из hNvQHb-истории) и не сбрасываем wasFull-мердж по id.
  function isConversationFeedRpc(url) {
    if (!url || url.indexOf('batchexecute') === -1) return false;
    if (url.indexOf('hNvQHb') !== -1) return false; // история уже обрабатывается isHistoryRpc
    var u = url;
    try { u = decodeURIComponent(url); } catch (e) { }
    return u.indexOf('/app/') !== -1;
  }

  // объединяющий предикат для инжеста новых ходов (история + инкрементальный фид текущего чата)
  function isIngestRpc(url) {
    return isHistoryRpc(url) || isConversationFeedRpc(url);
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

  function streamRpcidOf(url) {
    var ids = extractRpcIdsFromUrl(url);
    if (!ids) return '';
    var parts = ids.split(',');
    for (var i = 0; i < parts.length; i++) {
      var p = String(parts[i]).trim();
      if (STREAM_USER_RPCIDS[p] || STREAM_MODEL_RPCIDS[p]) return p;
    }
    return '';
  }

  function isStreamIngestRpc(url) { return !!streamRpcidOf(url); }

  function streamGetLogic() {
    try {
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.extractStreamUserTurn) return window.GeminiInterceptLogic;
      if (typeof self !== 'undefined' && self.GeminiInterceptLogic && self.GeminiInterceptLogic.extractStreamUserTurn) return self.GeminiInterceptLogic;
    } catch (e) { }
    return null;
  }

  function provisionalStreamIngest(raw, rpcid) {
    try {
      if (!STREAM_USER_RPCIDS[rpcid] && !STREAM_MODEL_RPCIDS[rpcid]) return 0;
      var P = streamGetLogic();
      if (!P) return 0;
      var t = null;
      if (STREAM_USER_RPCIDS[rpcid]) t = P.extractStreamUserTurn(raw);
      else t = P.extractStreamModelTurn(raw);
      if (!t || !t.id || !t.text) return 0;
      debugLog('log', '[AI CM][stream-ingest] rpcid=' + rpcid + ' role=' + t.role + ' id=' + t.id + ' textLen=' + t.text.length);
      var netRole = (t.role === 'me' || t.role === 'user') ? 'user' : 'assistant';
      return D.ingest('', {
        turns: [{
          id: String(t.id) + '_' + netRole,
          text: t.text,
          modelName: '',
          ts: Date.now(),
          role: netRole,
          turnId: t.turnId || null,
          r1: null
        }],
        srcOverride: 'stream',
        preservePagination: true,
        emitOnlyIfAdded: true
      });
    } catch (e) { return 0; }
  }

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

  // v72diag: курсор из ТЕЛА запроса hNvQHb (slots[2] после двойного JSON.parse) —
  // так выглядит курсор самого UI при ручном скролле. Только лог, состояние не трогаем.
  function diagCursorFromBody(bodyStr) {
    try {
      if (typeof bodyStr !== 'string' || !bodyStr) return;
      var params = new URLSearchParams(bodyStr);
      var freq = params.get('f.req');
      if (!freq) return;
      var diagOuter = JSON.parse(freq);
      var diagInner = diagOuter[0][0][1];
      if (typeof diagInner !== 'string') return;
      var diagSlots = JSON.parse(diagInner);
      var diagCur = diagSlots[2];
      if (typeof diagCur === 'string' && diagCur.length) {
        debugLog('log', '[AI CM][cursor-diag] req-cursor len=' + diagCur.length +
          ' head=' + JSON.stringify(diagCur.slice(0, 12)) +
          ' tail=' + JSON.stringify(diagCur.slice(-12)) +
          ' b64=' + (/^[A-Za-z0-9+/=]+$/.test(diagCur) ? 'yes' : 'no') +
          ' convId=' + (D.getConvId() || '(none)'));
      }
    } catch (e) { }
  }

  // v72diag: кандидат курсора из rest оборвавшего шага (base64, len>=40, вне turns)
  function shadowCursorFromRest(outer) {
    try {
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return null;
      var shRest = outer[0].slice(3);
      var found = null;
      (function walk(n) {
        if (found) return;
        if (typeof n === 'string') {
          if (n.length >= 40 && /^[A-Za-z0-9+/=]+$/.test(n)) found = n;
          return;
        }
        if (Array.isArray(n)) for (var i = 0; i < n.length; i++) walk(n[i]);
      })(shRest);
      return found;
    } catch (e) { return null; }
  }

  function rememberSiteMeta(url, headers, bodyStr) {
    if (!isHistoryRpc(url)) return;
    diagCursorFromBody(bodyStr); // v72diag: курсор тела запроса (только лог)
    if (headers) {
      var keys = Object.keys(headers);
      if (keys.length) D.lastHeaders = headers;
    }
    var at = parseAtFromBody(bodyStr);
    if (at) D.lastAtEncoded = at;
    D.lastBaseUrl = url;
    var rid = parseReqIdFromUrl(url);
    if (rid) D.lastReqId = rid;
  }

  function buildActiveBodyWith(token) {
    var convId = D.getConvId();
    var slots = ['c_' + convId, 10, token, 1, [0], [4], null, 1];
    var inner = JSON.stringify(slots);
    var outer = [[['hNvQHb', inner, null, 'generic']]];
    return 'f.req=' + encodeURIComponent(JSON.stringify(outer)) + '&at=' + D.lastAtEncoded + '&';
  }

  function buildActiveBody() { return buildActiveBodyWith(null); }

  function buildActiveUrl() {
    D.activeSeq++;
    var base = D.lastReqId || 1000000;
    var next = base + D.activeSeq * 7;
    if (/_reqid=\d+/.test(D.lastBaseUrl)) return D.lastBaseUrl.replace(/_reqid=\d+/, '_reqid=' + next);
    return D.lastBaseUrl + (D.lastBaseUrl.indexOf('?') === -1 ? '?' : '&') + '_reqid=' + next;
  }

  // ---- экспорт (UMD-паттерн: браузер + Node для тестов) ----
  var Api = {
    __bind: __bind,
    isHistoryRpc: isHistoryRpc,
    isConversationFeedRpc: isConversationFeedRpc,
    isIngestRpc: isIngestRpc,
    extractRpcIdsFromUrl: extractRpcIdsFromUrl,
    streamRpcidOf: streamRpcidOf,
    isStreamIngestRpc: isStreamIngestRpc,
    streamGetLogic: streamGetLogic,
    provisionalStreamIngest: provisionalStreamIngest,
    captureHeadersFromInit: captureHeadersFromInit,
    parseAtFromBody: parseAtFromBody,
    parseReqIdFromUrl: parseReqIdFromUrl,
    convIdFromBody: convIdFromBody,
    diagCursorFromBody: diagCursorFromBody,
    shadowCursorFromRest: shadowCursorFromRest,
    rememberSiteMeta: rememberSiteMeta,
    buildActiveBodyWith: buildActiveBodyWith,
    buildActiveBody: buildActiveBody,
    buildActiveUrl: buildActiveUrl,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmGeminiRpc = Api;
})();
