// =============================================================================
// core/gemini-diag.js — v2.0 (Phase 3 step 1).
// ДИАГНОСТИКА GEMINI: скан ответов на счётчики токенов (DIAG_TOKENS-сканер) и логи
// окна холодного старта (первый ingest любого src или рост convEpoch).
//
// Кластер вынесен из core/gemini-intercept.js. Раньше обе части жили в ОДНОМ IIFE,
// поэтому кластер обращался к состоянию ядра по именам. Теперь у модуля свой IIFE,
// и состояние ядра приходит через __bind(deps) — инжектируемые имена доступны как D.<имя>.
//
// Живое состояние ядра отдаётся НЕ копией значения, а геттером: модуль и ядро читают
// одну и ту же переменную IIFE. Записей в состояние ядра у кластера нет — только чтение,
// поэтому сеттеров в deps не требуется.
//
// Тела функций перенесены без изменения логики и отступов; переписаны только ссылки
// на инжектируемые имена (D.<имя>) и ничего больше. Имена, сигнатуры и порядок
// вызовов сохранены. Отпечатки ходов (aiCmDiag* / aiCmOrderedTurns), счётчик сканирования
// ядра и мост window-снимка ходов осознанно ОСТАЛИСЬ в core/gemini-intercept.js:
// их отпечатки питают H9-гейт полноты, а не только логи, и вынос потребовал бы второй
// копии формулы. Связное ядро (network/parser/pagination/loader) живёт там же.
//
// Порядок подключения (core/background.js, registerSafe для перехватчика Gemini,
// document_start, world MAIN): utils/debug.js -> utils-парсеры -> hidden-scroll ->
// ЭТОТ ФАЙЛ -> core/gemini-intercept.js. Экспорт: window.AiCmGeminiDiag + module.exports.
// =============================================================================

(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiDiag) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  function __bind(d) { D = d; }

  // ---- v28: DIAG_TOKENS — диагностический поиск счётчиков токенов в ответах Gemini ----
  var DIAG_TOKENS = true;
  var diagMatchCounts = {};
  var DIAG_MAX_PER_KEYWORD = 10;
  var DIAG_MAX_BODY = 2 * 1024 * 1024;
  var DIAG_KEYWORDS = [
    "usage_metadata", "usageMetadata", "promptTokenCount",
    "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount",
    "cachedContentTokenCount", "tokenCount", "totalTokens"
  ];
  // Окно холодного старта: первый ingest любого src после инициализации контент-скрипта
  // или после роста convEpoch (SPA-переход на новый convId). Длительность наблюдения — 60 секунд.
  var coldStartWindowStart = 0;
  var coldStartEpoch = -1;
  var coldStartConvId = '';
  var coldStartSourcesSeen = [];
  var coldStartEndTimer = null;

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

  function aiCmEnsureColdWindow() {
    if (coldStartEpoch === D.convEpoch) return;
    coldStartEpoch = D.convEpoch;
    coldStartWindowStart = Date.now();
    coldStartConvId = D.getConvId();
    coldStartSourcesSeen = [];
    if (coldStartEndTimer) { try { clearTimeout(coldStartEndTimer); } catch (e) { } coldStartEndTimer = null; }
    coldStartEndTimer = setTimeout(function () {
      var turns = D.aiCmOrderedTurns();
      var fe = D.aiCmDiagTurnEdge(turns, 'first');
      var le = D.aiCmDiagTurnEdge(turns, 'last');
      debugLog('log', '[AI CM][cold-start] window-end convId=' + (coldStartConvId || '(none)') +
        ' sourcesSeen=[' + coldStartSourcesSeen.join(',') + '] totalMsgs=' + turns.length +
        ' firstMsgHash=' + fe.hash + ' lastMsgHash=' + le.hash);
    }, 60000);
  }

  function aiCmColdStartIngestLog(src, snapshotTurns, msgsAdded, cacheHit) {
    if (!coldStartWindowStart || (Date.now() - coldStartWindowStart) > 60000) return;
    if (coldStartSourcesSeen.indexOf(src) === -1) coldStartSourcesSeen.push(src);
    var fe = D.aiCmDiagTurnEdge(snapshotTurns, 'first');
    var le = D.aiCmDiagTurnEdge(snapshotTurns, 'last');
    debugLog('log', '[AI CM][cold-start] src=' + src + ' convId=' + (D.getConvId() || '(none)') +
      ' msgsAdded=' + msgsAdded + ' firstMsgHash=' + fe.hash + ' lastMsgHash=' + le.hash +
      ' firstText="' + fe.text + '" lastText="' + le.text + '"' +
      ' cacheHit=' + (cacheHit ? 'true' : 'false') + ' ageMs=' + (Date.now() - coldStartWindowStart));
  }

  // ---- экспорт (UMD-паттерн: браузер + Node для тестов) ----
  var Api = {
    __bind: __bind,
    diagCanScan: diagCanScan,
    diagIsStream: diagIsStream,
    diagScanResponse: diagScanResponse,
    aiCmEnsureColdWindow: aiCmEnsureColdWindow,
    aiCmColdStartIngestLog: aiCmColdStartIngestLog,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmGeminiDiag = Api;
})();
