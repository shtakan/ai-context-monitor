// =============================================================================
// core/gemini-active-refresh.js — Phase 3, шаг 4 (декомпозиция core/gemini-intercept.js).
// K: АКТИВНЫЙ vf5-ДОЗАПРОС (activeRefresh) + EMIT-ОБЁРТКА (sanitizeMessagesForEmit).
// До выноса — строки 1375-1418 и 1427-1439 ядра (HEAD f82ac45); перенесены байт-в-байт.
//
// ЧТО ДЕЛАЕТ activeRefresh. По activeDisabled/activeBusy решает, можно ли слать активный
// POST на /app/<convId> с ПОСЛЕДНИМИ at/url/headers (их запомнил захват сайтметы). Нет
// convId/at/url/headers — один раз логирует «отложен» и выходит. Ответ: !ok/ошибка →
// activeDisabled=true (дальше живём на пассиве+DOM); успех → гард isStaleReqTag('vf5') от
// ответа ушедшему чату и aiCmIngestFwd(txt, { emitOnlyIfAdded, fromVirtualF5, rebuild }) —
// та самая стыковка с ingest, на которой держатся пины o51/o51b (vf5-subset-merge,
// vf5-id-evidence). Тег запроса снимается ДО отправки: ответ на чужой чат не ингестится.
//
// ЧТО ДЕЛАЕТ sanitizeMessagesForEmit. Строгий дедуп финального массива сообщений БЕЗ
// thinking-эвристик: парсер уже применил isThinkingAssistant/stripLeadingThinking к
// fallback-пути, канонический ответ («I'm …») трогать нельзя. Без
// window.GeminiInterceptLogic.sanitizeFinalMessages возвращает массив как есть.
//
// ПОЧЕМУ ВЫНЕСЕНО. Шаг 4 плана — кластер активного дозапроса и emit-обёрток. Его
// «отправка снапшотов» уехала раньше: тело emitBaseSnapshot целиком живёт в
// core/gemini-ingest.js (шаг 12), а buildDetail в Gemini-ядре не существовал вовсе —
// он есть только в core/google-search-intercept.js (GSA). Здесь остаётся то, что
// действительно принадлежит кластеру: сам дозапрос и дедуп выходящего массива.
// Форвардеры aiCmIngestFwd/aiCmEmitBaseSnapshotFwd/aiCmHandleOuterFwd НЕ переезжают: их
// значения раздают __bind-блоки rpc/parse/sse/pagination, стоящие ВЫШЕ места связки.
//
// БАЙТ-ИДЕНТИЧНОСТЬ. Тела перенесены БАЙТ-В-БАЙТ (с прежними отступами) и без префикса
// D.: они объявлены ВНУТРИ `with (D) { … }` BIND-зоны — как в core/gemini-oracle.js,
// core/gemini-ingest.js и core/gemini-spa-lifecycle.js. Функция, объявленная ВНЕ with, не
// видит bind-имена (её замыкание создано без with-окружения) и падает на первом свободном
// имени (activeDisabled, getConvId). Сьюты режут конкатенацию и исполняют тела в
// песочнице `with (ctx)` без ключа D — префикс D. сломал бы резолв.
//
// СОСТОЯНИЕ ОСТАЁТСЯ В ЯДРЕ. activeDisabled/activeBusy/loggedActiveStatus — rw-пары:
// loggedActiveStatus сбрасывает resetForNewConversation (он остался в ядре после шага 3),
// activeDisabled/activeBusy переписывают сами тела. lastAtEncoded/lastBaseUrl/lastHeaders —
// ro-геттеры: захват сайтметы переприсваивает их в ядре, копия значения была бы мёртвой.
// originalFetch — значение: нативный fetch, снятый ДО подмены window.fetch модулем SSE.
//
// ПОРЯДОК ПОДКЛЮЧЕНИЯ (core/background.js, registerSafe 'ai-cm-gemini-intercept-v16',
// document_start, world MAIN): … core/gemini-diag-dump.js -> core/gemini-spa-lifecycle.js
// -> ЭТОТ ФАЙЛ -> core/gemini-intercept.js. Связка стоит ровно на месте прежнего
// объявления activeRefresh (ядро зовёт __bind там же), поэтому момент, с которого вызовы
// пагинации/ingest/архива/SPA-фолбэка начинают работать, не изменился. Без модуля
// форвардеры возвращают undefined (дозапрос отложен) и messages как есть (эмит без
// дедупа) — ни один вызов не бросает.
// Экспорт: window.AiCmGeminiActiveRefresh + module.exports.
// =============================================================================
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiActiveRefresh) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  var Fn = {};

  function __bind(d) {
    D = d;
    with (D) {
  // ---- BIND-зона: активный дозапрос vf5 и дедуп выходящего массива ----
  function activeRefresh(reason, rebuild) {
    if (activeDisabled || activeBusy) return;
    var convId = getConvId();
    // v59: тег запроса на момент отправки — гард при обработке ответа
    var reqTagVf5 = captureReqTag();
    if (!convId || !lastAtEncoded || !lastBaseUrl || !lastHeaders) {
      if (!loggedActiveStatus) { loggedActiveStatus = true; debugLog('log', '[gemini-virtual-f5] активный запрос отложен: нет convId/at/url/заголовков пока'); }
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
          debugLog('log', '[gemini-virtual-f5] первый активный запрос: статус ' + (resp ? resp.status : 'none') + ' (convId=' + convId + ', ' + reason + ')');
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
        // v59: ответ vf5, уходивший для старого чата (SPA-переход до прибытия), не ингестируем
        if (isStaleReqTag(reqTagVf5, 'vf5')) return;
        aiCmIngestFwd(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });
      })
      .catch(function (err) {
        if (!loggedActiveStatus) loggedActiveStatus = true;
        activeDisabled = true;
        debugLog('log', '[gemini-virtual-f5] ошибка активного запроса: ' + err + ' → остаёмся на пассиве+DOM');
      })
      .finally(function () { activeBusy = false; });
  }

  // v1.5.2: строгий дедуп финального массива сообщений БЕЗ thinking-эвристик.
  // isThinkingAssistant/stripLeadingThinking уже применены в parser только к
  // fallback-пути (collectTurnText) — канонический ответ здесь НЕ трогаем, чтобы не
  // удалить английский ответ, начинающийся с "I'm …".
  function sanitizeMessagesForEmit(messages) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.sanitizeFinalMessages) {
      return window.GeminiInterceptLogic.sanitizeFinalMessages(messages, {
        isThinkingAssistant: function () { return false; },
        stripLeadingThinking: function (s) { return s; }
      });
    }
    return messages;
  }

      Fn.activeRefresh = activeRefresh;
      Fn.sanitizeMessagesForEmit = sanitizeMessagesForEmit;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmGeminiActiveRefresh = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
