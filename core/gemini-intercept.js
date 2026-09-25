// v69 (единый источник правды полноты): полнота базы определяется ОДНИМ оракулом —
//   completenessOracle: (серверный курсор пагинации исчерпан, подтверждён probe) И
//   (firstMsgHash базы == firstMsgHash первой страницы сервера). DOM-эвристики
//   (scrollEngaged/topReached/hide-applied) больше НЕ взводят baseComplete — только
//   диагностические логи. Watchdog после каждого data-complete делает probe первой
//   страницы; несовпадение firstMsgHash → дозапуск лоадера (≤3 ретраев). Фикс бага
//   «холодное открытие → неполная история без ручного скролла»: полнота перестала
//   зависеть от нескольких независимых эвристик.

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
//
// v59 (фикс кросс-чат загрязнения): convEpoch/capturedConvId — тег КАЖДОГО запроса,
//   чей ответ идёт в ingest, фиксируется В МОМЕНТ ОТПРАВКИ (vf5/pag — captureReqTag,
//   passive fetch/XHR — issuedAtConvId + issuedAtEpoch), а при обработке ответа
//   сравнивается с ТЕКУЩИМ getConvId()/convEpoch. Не совпало → НЕ ингестировать,
//   лог '[AI CM][ingest] drop stale-conv reqConv=... curConv=... src=...'.
//   Раньше vf5/pag ингестили без тега вообще (утечка src=vf5: ходы старого чата
//   ложились в базу нового после SPA-перехода), passive-гард сравнивал только convId.
//   Epoch инкрементируется в resetForNewConversation (сброс базы на SPA-смене
//   выполняется синхронно в pushState/replaceState-обёртках — ДО прилёта старых
//   ответов). Не ломает: дедуп turnsMap по messageId, reachedStart-гейты,
//   скролл-подтверждение, пороги/бейджи/trim.
//
// v60 (disjoint-reset, смена сеанса/аккаунта): stale-conv v59 сравнивает только convId,
//   который при смене аккаунта Google на том же сайте НЕ меняется — merge-by-id
//   (vf5, passive-снапшоты, rebuild vf5 с курсором) подмешивал ходы чужого сеанса.
//   Контентный критерий: в путях vf5/passive (НЕ pag — страницы пагинации легитимно
//   не пересекаются с базой) перед merge, если turnsMap непуст и входящий снапшот
//   имеет НОЛЬ пересечений id с turnsMap — считать сменой сеанса: полный сброс базы
//   + convEpoch++, лог '[AI CM][session] disjoint-reset convId=... src=...', затем
//   ingest как новую базу. Пересечение ненулевое — прежний merge-by-id без изменений.

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

  // ===== v2.0 (этап 2/3): кластер скрытого скролла вынесен в core/gemini-hidden-scroll.js =====
  // Модуль подключён в core/background.js ПЕРЕД этим файлом и отдаёт свой API на window.
  // Состояние ядра передаём геттерами/сеттерами (см. ниже) — модуль и ядро работают с
  // одними и теми же переменными, а не с копиями. Алиасы сохраняют прежние имена,
  // поэтому все вызовы внутри ядра (loadFullHistoryInvisibly, finishQuiet, ingest) не тронуты.
  var aiCmHiddenScroll = (typeof window !== 'undefined' && window.AiCmGeminiHiddenScroll) || null;
  var findScrollContainer = null;
  var scheduleAutoScroll = null;
  if (aiCmHiddenScroll) {
    aiCmHiddenScroll.__bind({
      // Функции ядра (декларации хойстятся — значения доступны на момент bind).
      getConvId: getConvId,
      loadFloor: loadFloor,
      sleep: sleep,
      baseSize: baseSize,
      aiCmSetScrollOverlay: aiCmSetScrollOverlay,
      // Живое состояние ядра: геттеры/сеттеры, чтобы чтение и запись модуля
      // видели ОДНИ И ТЕ ЖЕ переменные IIFE (не копии значений).
      get autoScrollStarted() { return autoScrollStarted; }, set autoScrollStarted(v) { autoScrollStarted = v; },
      get autoScrollBlocked() { return autoScrollBlocked; }, set autoScrollBlocked(v) { autoScrollBlocked = v; },
      get conversationOpenedAt() { return conversationOpenedAt; }, set conversationOpenedAt(v) { conversationOpenedAt = v; },
      get DOM_READY_MAX_WAIT() { return DOM_READY_MAX_WAIT; },
      get MIN_HISTORY_ELEMENTS() { return MIN_HISTORY_ELEMENTS; },
      get pendingCursor() { return pendingCursor; }, set pendingCursor(v) { pendingCursor = v; },
      get quietActive() { return quietActive; }, set quietActive(v) { quietActive = v; },
      get parserVersion() { return parserVersion; }, set parserVersion(v) { parserVersion = v; },
      get cacheRestoredMap() { return cacheRestoredMap; },
    });
    findScrollContainer = aiCmHiddenScroll.findScrollContainer;
    scheduleAutoScroll = aiCmHiddenScroll.scheduleAutoScroll;
  } else {
    // Модуль не подключён (например, у уже установленного расширения Chrome не
    // перечитал содержимое registration с тем же id). Лога не глушим, но и не падаем:
    // лоадер сам обрабатывает no-scroller, поэтому деградация мягкая.
    debugLog('log', '[gemini-intercept] core/gemini-hidden-scroll.js не подключён — ' +
      'скрытый скролл и автостарт лоадера недоступны (проверьте регистрацию content script)');
    findScrollContainer = function () { return null; };
    scheduleAutoScroll = function () { };
  }

  // v33: флаг «Подробные логи» транслируется из content.js (ISOLATED) через CustomEvent
  // (в MAIN-мире chrome.storage недоступен — как в остальных перехватчиках)
  try { window.addEventListener('ai-cm-debug-logs', function (ev) { __aiCmSetDebugLogs(!!(ev && ev.detail)); }); } catch (e) { }

  // ---- накопители вложений (глобально, на всю сессию; сбрасываются при смене чата) ----
  var IMAGE_DEFAULT_TOKENS = 516;
  var DOC_EST_TOKENS = 2500;
  var attachSeen = {};
  var attachTokens = 0;
  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
  var loggedAttach = false;

  var turnsMap = {};
  var lastOrderedIds = []; // последний финальный порядок id из emitBaseSnapshot (для дампа диагностики)
  var lastBaseTextLen = 0; // фактический textLen последнего эмитнутого снимка базы (для перезаписи пола)
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
  // v2.0 (этап 2/3): логика скролла и её константы (AUTO_*, DOM_READY_INTERVAL) переехали
  // в core/gemini-hidden-scroll.js; здесь остаётся только состояние, общее с ядром.
  var autoScrollStarted = false;
  // ---- v4x: готовность DOM перед автоскроллом + retry ----
  var conversationOpenedAt = Date.now(); // время открытия чата (для диагностики auto-scroll)
  var DOM_READY_MAX_WAIT = 5000;         // таймаут ожидания готовности DOM
  var MIN_HISTORY_ELEMENTS = 10;         // порог готовности по числу элементов истории

  // ---- тихая пагинация (сбрасывается при смене чата) ----
  var quietActive = false;
  var historyFullByQuiet = false;
  var reachedStart = false; // тихая пагинация дошла до начала (курсора больше нет)
  var reachedStartByScroll = false; // v61diag: reachedStart, установленная confirmed-by-scroll лоадера (только диагностика)
  var quietPaginated = false;
  var quietDecisionMade = false;
  // v1.13.1: доверие к полноте базы. quietIncompleteNoStart — тихий цикл завершился
  // «курсор пропал», но reachedStart=false (начало не подтверждено) → база НЕПОЛНАЯ.
  // lastCycleEndedHidden — последний цикл пагинации/лоадера завершился при скрытой
  // вкладке (Win+L): доверие к baseComplete при возврате видимости сбрасывается.
  var quietIncompleteNoStart = false;
  var lastCycleEndedHidden = false;
  var pendingCursor = null;
  var lastCursorSource = ''; // v1.6 (D16): последний источник continuation-курсора (passive/vf5/pag/fbb/none)
  // v69: completeness oracle + watchdog (единый источник правды полноты)
  var serverFirstHash = '';      // firstMsgHash головы с сервера (последняя страница пагинации)
  var lastHeadToken = null;      // токен, чей ответ пришёл без continuation-курсора (голова)
  // H9b (retain-last-good): wide-курсор живёт в ЕДИНСТВЕННОМ волатильном слоте
  // lastPaginateOuter (пишется на каждом успешном парсе hNvQHb), и оборванный финальный
  // шаг тихой пагинации перезаписывает его битой/терминальной страницей (без opaque-строк)
  // ровно когда нужен контрольный probe → wideCursor=no. Здесь — last-good: фиксируется
  // ТОЛЬКО на здоровом шаге пагинации (added>0 ИЛИ живой курсор, шаг не сломан, src='pag'),
  // сломанный шаг НЕ перезаписывает; подаётся ВХОДОМ запроса probe (oracle (b) и
  // fallback-top), источником complete (probe-terminal) НЕ является.
  var lastGoodWideCur = null;    // H9b: { conv, cur, ts } — wide-курсор последнего здорового шага
  var lastGoodProbeMeta = null;  // H9b: { conv, atEncoded, baseUrl, headers, ts } — метаданные запроса
  var completenessWatchdogRetries = {}; // convId → число дозапусков лоадера (≤3)
  var watchdogFiredMap = {};     // convId → true (не гонять probe параллельно)
  // v73: трекинг «старших» добавлений вне пагинации (passive/vf5/tape) —
  // инвалидация scroll-proof оракула (независимое подтверждение начала).
  var lastOlderNonPagAddAt = 0;  // момент последнего старшего добавления вне 'pag'
  var minOrderSeen = Infinity;   // минимум order по базе (монотонно убывает)
  // v74: трекинг стабильности счётчика базы (для loader-stable-stop)
  var lastBaseCount = -1;
  var lastBaseCountChangeAt = 0;
  // v82 (контекст-перенос, живой pendingCursor + мёртвый лоадер): независимый источник
  // полноты floor-confirmed. Чат с floor и живым курсором, где лоадер скипнут
  // (already-done/cache-complete) и не даёт done reason=top → stableCheck74 из
  // notifyLoaderState(false) молчит → baseComplete=false вечно и автоэкспорт не стреляет.
  // Полнота по полу: база стабильна >=5с И не ниже пола → подтверждаем сами, без лоадера.
  var floorConfirmDebounceTimer = null; // v82: debounce 5500мс (устанавливается в noteBaseCountChange)
  function stableFloorConfirm() {
    try {
      var convIdFc = getConvId();
      if (!convIdFc || historyFullByQuiet || loaderRunningFor || quietActive) return;
      if (!(lastBaseCount > 0)) return;
      var floorFc = null;
      try { floorFc = loadFloor(convIdFc); } catch (eFcL) { }
      if (!floorFc || !(floorFc.count > 0)) return;
      if (lastBaseCount < floorFc.count) return;
      // T1-fix#2 (v1.16.2): пол этого чата поднят АРХИВОМ (его count), поэтому «база не
      // ниже пола» доказывает ровно вклад архива, а не догруженную живую историю.
      // Live-прогон: архив 4 хода → floor=4 → через 5.5с тишины confirm → автоэкспорт
      // уходил с одной архивной частью (живой хвост ещё не успел прийти).
      // typeof-гард: helper объявлен всегда; в извлечённых sandbox-телах его нет —
      // поведение прежнее (байтово), как и для чатов без архива.
      if (typeof aiCmArchiveLiveProven === 'function' && !aiCmArchiveLiveProven(convIdFc)) {
        debugLog('log', '[AI CM][completeness] oracle=incomplete reason=archive-live-pending(floor-confirm) convId=' + convIdFc +
          ' msgs=' + lastBaseCount + ' floor=' + floorFc.count +
          ' archiveMsgs=' + (((aiCmArchiveFor(convIdFc) || {}).count) || 0) +
          ' liveMsgs=' + aiCmLiveTurnCount());
        return;
      }
      var nowFc = Date.now();
      if ((nowFc - lastBaseCountChangeAt) < 5000) return;
      if ((nowFc - lastOlderNonPagAddAt) < 5000) return;
      historyFullByQuiet = true;
      reachedStart = true;
      quietIncompleteNoStart = false;
      try { delete oracleIncompleteSeen[convIdFc]; } catch (eFcO) { }
      debugLog('log', '[AI CM][completeness] oracle=complete reason=floor-confirmed convId=' + convIdFc +
        ' msgs=' + lastBaseCount + ' floor=' + floorFc.count);
      try { emitBaseSnapshot(); } catch (eFcE) { }
    } catch (eFcX) { }
  }
  function noteBaseCountChange() {
    var n74 = baseSize();
    if (n74 !== lastBaseCount) { lastBaseCount = n74; lastBaseCountChangeAt = Date.now(); }
    // v82: debounce-триггер floor-confirmed — после 5.5с тишины по базе перепроверяем полноту
    // по полу. clearTimeout отменяет предыдущий; stableCheck74 и его setTimeout(5000) не меняются.
    try {
      if (floorConfirmDebounceTimer) { clearTimeout(floorConfirmDebounceTimer); floorConfirmDebounceTimer = null; }
      floorConfirmDebounceTimer = setTimeout(stableFloorConfirm, 5500);
    } catch (eFcT) { }
  }
  // v53: поколение курсора — каждый history-write с continuation-курсором инкрементит;
  // лоадер по смене поколения сбрасывает счётчики стабилизации (noGrowth) и столла (stallRetry),
  // т.е. любой history-write с курсором «оживляет» цикл.
  var cursorEpoch = 0;
  // v46: сигнал «есть старшая история» — в начальном history-RPC (hNvQHb) найден
  // opaque continuation-курсор (extractCursor). Сбрасывается только при смене чата.
  var olderHistorySeen = false;
  var loggedMultiCursor = false;
  var PAGINATE_CAP = 25;   // v68: страховочный потолок ≤ 25 страниц (было 60); warn при достижении
  var PAGINATE_TIME_CAP_MS = 60000; // v68: страховочный потолок ≤ 60 секунд на прогон
  // v68: состояние прогона пагинации (страница/время) — сбрасывается при смене чата
  var paginationRun = { pageCount: 0, startTs: 0 };
  var lastPaginateOpaqueCandidates = null;
  var lastPaginateOuter = null; // последний outer для дампа в paginateLoop
  var lastAllStrings = []; // дамп всех строк длиной 20..2000 из последнего outer
  var lastFailedSkeleton = null; // скелет последней непарсящейся страницы (для дампа диагностики)
  // H9: последний шаг тихой пагинации «сломан» (added=0, курсора нет, страница не распарсилась
  // ИЛИ opaque-кандидатов 0) → scroll-top-proof (a) из serverFirstHash последней «живой» страницы
  // циркулярен и НЕ используется. Сброс при реальном добавлении/живом курсоре и при новом прогоне.
  var lastPagStepBroken = false;
  // v1.15 (BUG «холодное открытие без полной истории»): страница hNvQHb вернула НЕ данные,
  // а ошибку (inner !== string, напр. BardErrorInfo code 1177: «попробуйте позже»). Такая
  // страница НЕ является концом истории: курсор прошлого шага жив, окно надо повторить.
  var lastHnvPageError = false;   // выставлен handleOuter при распознании ошибки
  var pagErrorRetries = 0;        // ретраев окна в текущем тихом прогоне (сброс при depth 0)
  var PAGINATE_ERROR_RETRY_CAP = 3;    // максимум повторов одного окна после ошибки
  var PAGINATE_ERROR_BACKOFF_MS = 2000; // база растущей паузы (2000*N мс)
  // O-48 (Gemini parseByBytes fail на длинных JSON-ответах >900KB): обрыв JSON-кадра
  // batchexecute перестаёт быть «тихой» телеметрией. Диаг-числа (declaredN/availableBytes/
  // reEncodedLen/rawLen) отделяют клэмп объявленной длины от разъезда единиц среза.
  // O-50 (2026-09-25, живой лог 15:20:35) уточнил корень: единица среза — СИМВОЛ, а не байт
  // (declaredN ≈ rawLen минус заголовок при clamped=0), см. parseByBytes ниже.
  // Заполняет parseByBytes/parseByLines; читает СРАЗУ после
  // своего parseBatchExecute тот, кто его вызвал (ingest/probe/watchdog).
  var lastFrameParseFail = null;
  // O-48: последний parse-fail именно ingest-парса (src пассива/vf5/pag/stream). Обрезанный
  // кадр — НЕ доказательство терминальной страницы: оракул loader-stable-stop не подтверждает
  // по такой базе полноту (окно 120с — в пределах одного холодного прогона).
  var lastIngestParseFail = null;
  // v1.16 (1177-BYPASS): серия подряд идущих ошибок-страниц в прогоне (для снижения темпа —
  // 1177 = троттлинг старых окон) и пер-чат флаг «эскалация на нативный скролл выполнена»
  // (защита от вечной петли: на один чат эскалация срабатывает один раз).
  var quietErrStreak = 0;
  var nativeEscalationUsedMap = {}; // convId → true — 1177→нативный скролл уже эскалирован
  var nativeEscalationFor = null;   // convId — лоадер сейчас бежит ПО ЭСКАЛАЦИИ (hide разрешён)
  // v1.15: тихая пагинация завершилась ЧИСТО (без ошибки-страницы и без живого курсора) —
  // сеть честно отдала «старших страниц больше нет». Разрешает лоадеру подтвердить полноту
  // на физическом верхе даже при base < устаревшего пола (чат ужат/укорочен на сервере).
  var quietEndedClean = false;
  var lastCleanEndBaseCount = -1; // база на момент первого collapse после чистого конца (сравнение на повторе)
  // ---- виртуальный F5 для хвоста ----
  var lastHeaders = null;
  var lastAtEncoded = '';
  var lastBaseUrl = '';
  var lastReqId = 0;
  var activeSeq = 0;
  var activeDisabled = false;
  var activeBusy = false;
  var lastActiveAt = 0;
  var lastVf5ActivityAt = Date.now(); // v40: последняя активность (DOM-мутации/пассивный batchexecute/смена чата)
  var REFRESH_MIN_MS = 4000;
  var loggedActiveStatus = false;
  var observerStarted = false;
  var mutTimer = null;
  var scrollRecentUntil = 0; // подавление rebuild-сброса пока идёт скролл (мутации от рендера)

  // ---- v20: защита автоскролла в переходном окне ----
  var autoScrollBlocked = false;
  var autoScrollUnblockTimer = null;

  // ---- v4y: автозапуск лоадера полной истории (loadFullHistoryInvisibly) ----
  // Запуск НЕ зависит от wasFull/baseComplete/historyFullByQuiet/rebuild-флагов:
  // эвристика полноты ложно-положительна на холодном открытии (wasFull=true при ~20 блоках),
  // из-за чего лоадер молчал. Критерий запуска — только convId + идемпотентность за сессию.
  var loaderDoneMap = {};   // convId → true (один запуск на чат за сессию страницы)
  var loaderRunningFor = null;
  var loaderBadgeTimer = null; // v4z: отложенный фолбэк бейджа после смены чата
  var oracleIncompleteSeen = {}; // v1.6 (D15): convId → true — оракул сказал incomplete (для обхода cache-complete)
  var oracleRerunUsedMap = {};   // v1.6 (D15): convId → true — единственный ре-ран лоадера уже использован
  // v30.6: convId, для которых в текущей сессии принята кэш-лента (ai-cm-restored-history).
  // При кэш-ленте лоадер не нужен — история уже в базе. v77: Set — has/add; защита от
  // повторного tape-restore в рамках жизни страницы.
  var cacheRestoredMap = new Set();

  // T1 (v1.16): ПЕРВЫЙ ЯРУС — архив. Записи {count, textLen} по convId, полученные
  // событием ai-cm-archive-restore от content.js (ISOLATED читает chrome.storage.local:
  // MAIN-мир chrome.* не касается — инвариант мировой изоляции). Архив — независимое
  // доказательство полноты (archive-complete) и авторитет для пола (монотонно вверх).
  var archiveTierByConv = {};
  // convId, для которых архив уже влит в базу в этой сессии страницы (дедуп merge).
  var archiveMergedMap = new Set();

  // v42: состояние лоадера наружу ПО convId. content.js живёт в ISOLATED-мире и не видит
  // MAIN-глобалы, поэтому канал — window-CustomEvent (тот же механизм, что ai-cm-loader-freeze).
  function notifyLoaderState(convId, running) {
    try {
      if (!running) {
        lastCycleEndedHidden = (document.visibilityState !== 'visible'); // v1.13.1
        // T1-fix (v1.16.1): живой ярус остановился — переоцениваем оракул архива ДО
        // dispatch ниже, чтобы свежая полнота уехала в том же ai-cm-loader-state
        // (иначе после стопа лоадера emit может не прийти и экспорт не триггернётся).
        try { aiCmArchiveTierApply(); } catch (eArcLs) { }
        // v74 (баг A): стабильный loader-stop — независимое подтверждение полноты.
        // pendingCursor нет И счётчик базы не менялся ≥5с И старших добавлений вне
        // пагинации ≥5с → полнота сразу (вместо 60с-задержки и [LOW CONFIDENCE]_).
        var stableCheck74 = function () {
          try {
            var now74 = Date.now();
            if (!convId || pendingCursor || historyFullByQuiet) return;
            if (!(lastBaseCount > 0)) return;
            // O-48: база, в которую НЕ долился оборванный JSON-кадр, полной не объявляется.
            // «Курсора нет» на обрезанном ответе — не доказательство терминальной страницы;
            // отдельный reason='parse-fail' в прогрессе лоадера (бюджет полноты не тратится,
            // рестарта нет) — итог честный: неполная база + [LOW CONFIDENCE].
            var __pf74 = (typeof lastIngestParseFail === 'undefined') ? null : lastIngestParseFail;
            if (__pf74 && __pf74.convId === convId && (now74 - (__pf74.ts || 0)) < 120000) {
              debugLog('log', '[AI CM][completeness] oracle=incomplete reason=parse-fail convId=' + convId +
                ' src=' + __pf74.src + ' declaredN=' + __pf74.declaredN +
                ' availableBytes=' + __pf74.availableBytes + ' clamped=' + (__pf74.clamped ? '1' : '0') +
                ' salvagedTurns=' + __pf74.salvaged + ' msgs=' + lastBaseCount +
                ' (обрыв кадра: stable-stop НЕ подтверждает полноту)');
              return;
            }
            var sf78 = null;
            try { sf78 = loadFloor(convId); } catch (eSf78) { }
            var floorCount78 = (sf78 && sf78.count) || 0;
            // v1.15 (BUG «холодное открытие без полной истории»): сеть ЧИСТО завершила
            // пагинацию (quietEndedClean: без ошибки-страницы и без живого курсора), но
            // скролл-лоадер не дошёл до done reason=top (маленький/схлопнутый скроллер,
            // напр. холодный старт с восстановленной лентой: h=864, hide не применяется,
            // visible-scroll запрещён → done reason=not-hidden-wait-cap). Если база при этом
            // не ниже пола — подтверждаем полноту (top не достижим, а догонять нечего).
            // Инвариант 3в: clean-end-подтверждение ТОЛЬКО при floor>0 — при floor=0 (класс
            // первого визита) пол не задан, «не ниже пола» тривиально и ранний confirm без
            // физического верха был бы ложной полнотой (см. SPA-прогон 1984298f: done=collapse
            // msgs=80 floor=0 до ручного скролла). Первый визит подтверждается ТОЛЬКО top.
            var cleanEnd78 = false;
            try {
              cleanEnd78 = (typeof quietEndedClean !== 'undefined' && quietEndedClean === true &&
                floorCount78 > 0 &&
                (typeof pendingCursor === 'undefined' ? true : !pendingCursor));
            } catch (e78q) { cleanEnd78 = false; }
            // v1.16.5 (T1-fix#5): САМОУНИЖЕНИЕ УСТАРЕВШЕГО ПОЛА. cleanEnd78 — доказательство
            // того, что сеть отдала всю историю (quietEndedClean, курсора продолжения нет),
            // а reachedStart при этом может оставаться 0: физического верха лоадер не нашёл.
            // Если база НИЖЕ пола, пол снят с УЖЕ УКОРОЧЕННОЙ на сервере истории — держать его
            // нельзя: base < floor вечно уводит оракул в incomplete (loader-max-not-top /
            // below-floor) → полнота не подтверждается, экспорт остаётся в deferred, а
            // completeness-оракул гоняет loader-restart по кругу, хотя окно вырасти не может.
            // Решение — ТОЛЬКО через формальный вердикт (selfHealFloorVerdict), запись — через
            // единственную точку понижения (selfHealFloor → writeSelfHealedFloor).
            // HWM saveFloor/archiveFloorRecord и H9/H10-гейты не тронуты: понижение возможно
            // лишь при доказанном чистом конце + подтверждающем повторе (база стабильна ≥5с),
            // а при архиве без доказанного живого яруса оно запрещено (archive-pending-live).
            // Блок стоит ДО ветки lastLoaderDoneReason !== 'top': иначе deadlock-ветка
            // loader-max-not-top вернулась бы раньше, чем пол успел самоунизиться.
            if (cleanEnd78 && floorCount78 > 0 && lastBaseCount > 0 && lastBaseCount < floorCount78) {
              var __shv74 = null;
              try {
                if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                    typeof window.GeminiInterceptLogic.selfHealFloorVerdict === 'function') {
                  __shv74 = window.GeminiInterceptLogic.selfHealFloorVerdict({
                    cleanEnd: true,
                    pendingCursor: (typeof pendingCursor === 'undefined') ? null : pendingCursor,
                    quietActive: (typeof quietActive === 'undefined') ? false : (quietActive === true),
                    pageError: (typeof lastHnvPageError === 'undefined') ? false : (lastHnvPageError === true),
                    loaderRunning: (typeof loaderRunningFor === 'undefined') ? false : !!loaderRunningFor,
                    archivePending: !!(typeof aiCmArchiveFor === 'function' && aiCmArchiveFor(convId) &&
                      typeof aiCmArchiveLiveProven === 'function' && !aiCmArchiveLiveProven(convId)),
                    baseCount: lastBaseCount,
                    floorCount: floorCount78,
                    floorLen: (sf78 && sf78.effectiveLen) || 0,
                    provenLen: (typeof lastBaseTextLen === 'undefined') ? 0 : lastBaseTextLen,
                    reachedStart: reachedStart === true,
                    confirmations: (lastBaseCountChangeAt && (now74 - lastBaseCountChangeAt) >= 5000) ? 1 : 0
                  });
                }
              } catch (eShv74) { __shv74 = null; }
              if (__shv74 && __shv74.lower === true) {
                var __shW74 = null;
                try { __shW74 = selfHealFloor(convId, __shv74.count, __shv74.effectiveLen, __shv74.source); } catch (eShW74) { __shW74 = null; }
                floorCount78 = __shv74.count; // ветки ниже читают САМОИЗЛЕЧЕННЫЙ пол
                debugLog('log', '[AI CM][completeness] floor self-healed (clean-end) convId=' + convId +
                  ' floorWas=' + __shv74.floorWas + ' floorNow=' + floorCount78 +
                  ' msgs=' + lastBaseCount + ' reachedStart=' + (reachedStart === true ? '1' : '0') +
                  ' source=' + __shv74.source + (__shW74 ? '' : ' (write skipped)'));
              }
            }
            // v78: loader-stable-stop подтверждает полноту ТОЛЬКО когда скролл-лоадер дошёл до
            // физического верха (done reason=top) И база не ниже пола. Иначе — incomplete,
            // baseComplete остаётся 0 и экспорт остаётся deferred (гейт в content.js).
            // v1.15: исключение — чистый конец сети при базе >= пола (см. cleanEnd78 выше).
            if (lastLoaderDoneReason !== 'top') {
              // T1-fix#2 (v1.16.2): clean-end-подтверждение опирается на ПОЛ, а пол мог быть
              // поднят самим архивом (floorCount78 > 0 выполняется его вкладом) — без
              // доказанного живого роста это доказательство архива, а не живого яруса.
              // Ветка done reason=top (реальный live-доказательство) НЕ трогается.
              if (cleanEnd78 && lastBaseCount >= floorCount78 &&
                  typeof aiCmArchiveLiveProven === 'function' && !aiCmArchiveLiveProven(convId)) {
                debugLog('log', '[AI CM][completeness] oracle=incomplete reason=archive-live-pending(clean-end) convId=' + convId +
                  ' msgs=' + lastBaseCount + ' floor=' + floorCount78 +
                  ' archiveMsgs=' + (((aiCmArchiveFor(convId) || {}).count) || 0) +
                  ' liveMsgs=' + aiCmLiveTurnCount());
                return;
              }
              if (!(cleanEnd78 && lastBaseCount >= floorCount78)) {
                debugLog('log', '[AI CM][completeness] oracle=incomplete reason=loader-max-not-top convId=' + convId +
                  ' done=' + lastLoaderDoneReason + ' msgs=' + lastBaseCount + ' floor=' + floorCount78 +
                  (cleanEnd78 ? ' cleanEnd=1' : ''));
                return;
              }
              debugLog('log', '[AI CM][completeness] oracle=clean-end-stable convId=' + convId +
                ' done=' + lastLoaderDoneReason + ' msgs=' + lastBaseCount + ' floor=' + floorCount78 +
                ' (чистый конец сети, top не достижим — подтверждаю полноту)');
            }
            if (lastBaseCount < floorCount78) {
              debugLog('log', '[AI CM][completeness] oracle=incomplete reason=below-floor convId=' + convId +
                ' msgs=' + lastBaseCount + ' floor=' + floorCount78);
              return;
            }
            if (lastBaseCountChangeAt && (now74 - lastBaseCountChangeAt) < 5000) return;
            if ((now74 - lastOlderNonPagAddAt) < 5000) return;
            historyFullByQuiet = true;
            reachedStart = true;
            quietIncompleteNoStart = false;
            try { delete oracleIncompleteSeen[convId]; } catch (eD15s) { } // v1.6 (D15): успешный stable-stop — флаг снят
            debugLog('log', '[AI CM][completeness] oracle=complete reason=loader-stable-stop convId=' + convId +
              ' msgs=' + lastBaseCount + ' floor=' + floorCount78);
            try { emitBaseSnapshot(); } catch (eEs74) { }
          } catch (e74b) { }
        };
        stableCheck74();
        setTimeout(stableCheck74, 5000); // повторная проверка через 5с тишины
      }
      // v53: наружу также курсор и полноту базы — гейт автоэкспорта (content.js) по ним
      // решает, можно ли стрелять при стопе лоадера (живой курсор/неполная база → нельзя).
      // v1.13.1: наружу также reachedStart — content.js отличает подтверждённую полноту
      // (baseComplete при reachedStart=true) от ложной (курсор пропал без начала).
      window.dispatchEvent(new CustomEvent('ai-cm-loader-state', { detail: {
        convId: convId,
        running: !!running,
        pendingCursor: !!pendingCursor,
        baseComplete: historyFullByQuiet === true,
        reachedStart: reachedStart === true
      } }));
    } catch (e) { }
  }


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
  // v1.16.5 (T1-fix#5): ЕДИНСТВЕННАЯ точка ПОНИЖЕНИЯ пола — отдельная от saveFloor (HWM
  // «пол двигается только вверх» не тронут). Вызывается только по доказательству чистого
  // конца истории: вердикт selfHealFloorVerdict (оракул полноты) либо уже доказанная
  // clean-end ветка collapse-гарда лоадера. Возвращает запись пола или null.
  function selfHealFloor(convId, count, effectiveLen, source) {
    if (typeof window === 'undefined' || !window.GeminiInterceptLogic) return null;
    if (typeof window.GeminiInterceptLogic.writeSelfHealedFloor !== 'function') return null;
    return window.GeminiInterceptLogic.writeSelfHealedFloor(
      convId, parserVersion, count, effectiveLen, source, localStorage);
  }

  // ================= v17: отслеживание смены чата в SPA =================
  function getConvId() {
    try {
      var m = location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  var currentConvId = getConvId();

  // v59: epoch чата — инкремент при каждой SPA-смене (resetForNewConversation)
  var convEpoch = 0;
  // v62: флаг «лента восстановлена из кэша в этом холодном старте» — true ТОЛЬКО при
  // tape-restore action=used; сбрасывается при каждом convEpoch++ (смена чата/сеанса).
  var tapeWasUsedInThisColdStart = false;
  // v62: флаг «после старта лоадера был ingest src=vf5 с overlapCount>0» — доказательство,
  // что база собрана из последовательности, а не из одного случайного passive-снапшота.
  var vf5OverlapSinceLoaderStart = false;
  // v63: база подтверждена только через sanity-фолбэк (без proof tape/vf5-overlap) —
  // экспорт разрешён, но помечается [LOW CONFIDENCE]_ в имени файла.
  var isLowConfidenceBase = false;
  // v59: тег запроса — convId/epoch на момент ОТПРАВКИ (привязка ответа к запросу)
  function captureReqTag() { return { conv: getConvId(), epoch: convEpoch }; }
  // v59: гард при обработке ответа — тег запроса vs ТЕКУЩИЙ convId/epoch.
  // Не совпало → НЕ ингестировать (ответ уходил для другого чата/эпохи).
  function isStaleReqTag(tag, src) {
    if (!tag) return false;
    var cur = getConvId();
    if ((tag.conv && tag.conv !== cur) || tag.epoch !== convEpoch) {
      debugLog('log', '[AI CM][ingest] drop stale-conv reqConv=' + (tag.conv || '(none)') + ' curConv=' + (cur || '(none)') + ' src=' + src);
      // v61diag: merge-decision для дропа устаревшего ответа (решение не меняется)
      debugLog('log', '[AI CM][merge-decision] action=drop incomingSrc=' + src + ' incomingConvId=' + (tag.conv || '(none)') +
        ' existingMsgs=' + baseSize() + ' incomingMsgs=0 overlapCount=0 disjointFlag=false reason=stale-conv');
      return true;
    }
    return false;
  }

  function resetForNewConversation() {
    convEpoch++; // v59: старые ответы (тег с прошлой эпохой) больше не ингестируются
    tapeWasUsedInThisColdStart = false; // v62: новая эпоха — кэш прошлой ленты больше не считается
    vf5OverlapSinceLoaderStart = false; // v62: новая эпоха — vf5-overlap прошлой ленты не считается
    isLowConfidenceBase = false; // v63: новая эпоха — low-confidence прошлой ленты не считается
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
    olderHistorySeen = false; // v46
    quietActive = false;
    historyFullByQuiet = false;
    reachedStart = false;
    reachedStartByScroll = false; // v61diag
    serverFirstHash = ''; // v69
    lastHeadToken = null; // v69
    lastGoodWideCur = null; // H9b: retained last-good не переносится на другой чат
    lastGoodProbeMeta = null; // H9b
    lastOlderNonPagAddAt = 0; // v73
    minOrderSeen = Infinity; // v73
    lastBaseCount = -1; // v74
    lastBaseCountChangeAt = 0; // v74
    oracleIncompleteSeen = {}; // v1.6 (D15): сброс при смене чата
    oracleRerunUsedMap = {};   // v1.6 (D15)
    // v1.6 (D19): покинутый чат снимается с «уже восстановлено» — при SPA-возврате
    // лента обязана ре-мержиться (база=тейп∪сеть, голова истинная, пол не ниже сети).
    // Внутри одного непрерывного визита гард остаётся (skip reason=already-restored).
    cacheRestoredMap.clear(); // Set (v77) — как has/add в tape-restore listener, без try/catch
    // T1 (v1.16): первый ярус — смена чата: снимаем признак «архив влит» (при SPA-возврате
    // архив обязан ре-мержиться в новую базу), сами данные архива по convId не теряем —
    // они приходят от content.js и ключуются convId.
    archiveMergedMap.clear();
    // T1 (v1.16): база этого чата очищена (turnsMap={}) → признак «архив применён»
    // снимается, иначе при SPA-возврате архив не сможет повторно взвести
    // archive-complete (вердикт переоценится в emitBaseSnapshot после ре-мержа).
    try {
      var __cidArcReset = getConvId();
      if (__cidArcReset && archiveTierByConv[__cidArcReset]) {
        archiveTierByConv[__cidArcReset].completeApplied = false;
        archiveTierByConv[__cidArcReset].verdictLogged = '';
      }
    } catch (eArcReset) { }
    lastLoaderDoneReason = ''; // v78: done-reason прошлого чата не должен открывать stable-stop оракул
    collapseRetries = 0; // v1.14.2 (COLLAPSE-GUARD): смена convId — новый бюджет коллапс-ретраев
    lastPagStepBroken = false; // H9: смена convId — сброс флага «последний шаг тихой пагинации сломан»
    lastHnvPageError = false;  // v1.15: смена чата — сброс маркера ошибки-страницы
    pagErrorRetries = 0;       // v1.15: смена чата — новый бюджет ретраев окна
    quietEndedClean = false;   // v1.15: смена чата — новый цикл «чистого конца» не переносится
    lastCleanEndBaseCount = -1; // v1.15
    quietErrStreak = 0; // v1.16 (1177-PACE): смена чата — серия ошибок-страниц не переносится
    nativeEscalationFor = null; // v1.16 (1177-BYPASS): смена чата — маркер эскалации снимается
    quietPaginated = false;
    quietDecisionMade = false;
    // v68: сброс счётчиков прогона пагинации при смене чата (conv-changed → перезапуск лоадера)
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.resetPaginationCounters) {
      paginationRun = window.GeminiInterceptLogic.resetPaginationCounters(paginationRun);
    } else {
      paginationRun = { pageCount: 0, startTs: 0 };
    }
    quietIncompleteNoStart = false;  // v1.13.1
    lastCycleEndedHidden = false;    // v1.13.1
    autoScrollStarted = false;
    conversationOpenedAt = Date.now();
    lastActiveAt = Date.now();
    lastVf5ActivityAt = Date.now(); // v40: смена чата — активность
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
      var oldId = currentConvId;
      currentConvId = newId;
      try { forceRestoreVisibility('conv-switch'); } catch (eVis70) { } // v70: SPA-переход не оставляет скрытый контейнер
      resetForNewConversation();
      // v4z: инвалидация done-флага покинутого чата — при возврате лоадер обязан
      // перезапуститься (DOM уничтожен, «already-done» переживать навигацию не должен)
      try { delete loaderDoneMap[oldId]; } catch (e) { }
      if (loaderRunningFor === oldId) { loaderRunningFor = null; notifyLoaderState(oldId, false); }
      // v4z: SPA-переход на /app/<id> → автозапуск лоадера полной истории нового чата
      try { maybeStartLoader(); } catch (e) { }
      // v4z: фолбэк бейджа — если история за 3с не пришла (badge-recv после возврата
      // отсутствует), форсируем существующий virtual-F5/activeRefresh
      if (loaderBadgeTimer) { clearTimeout(loaderBadgeTimer); loaderBadgeTimer = null; }
      loaderBadgeTimer = setTimeout(function () {
        loaderBadgeTimer = null;
        if (getConvId() !== newId || !newId) return;
        if (baseSize() > 0) return;
        debugLog('log', '[AI CM][Gemini][loader] fallback-refresh convId=' + newId);
        try { activeRefresh('фолбэк бейджа после смены чата', false); } catch (e) { }
      }, 3000);
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
    // LOW-4 (аудит перед релизом): passive:true — обработчик только ЗАПИСЫВАЕТ время
    // скролла (scrollRecentUntil) и никогда не вызывает preventDefault, поэтому браузер
    // не обязан ждать его завершения перед прокруткой (нет scroll-jank). capture:true
    // сохранён: скролл контейнера ленты не всплывает до document — фаза захвата
    // единственная точка, где событие здесь видно.
    document.addEventListener('scroll', function () {
      scrollRecentUntil = Date.now() + 2000;
    }, { capture: true, passive: true });
  } catch (e) { }
  // =====================================================================

  function baseSize() { return Object.keys(turnsMap).length; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ================= v61diag: диагностика холодного старта (ТОЛЬКО добавление логов, стейт-машина не тронута) =================
  // FNV-1a 32-bit от id||text → первые 6 hex-символов как отпечаток хода.
  function aiCmDiagHash6(id, text) {
    try {
      var s = String(id || '') + '\u0000' + String(text || '');
      var h = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return ('000000' + h.toString(16)).slice(-6);
    } catch (e) { return '000000'; }
  }
  function aiCmDiagTurnEdge(turns, which) {
    if (!turns || !turns.length) return { hash: '-', text: '' };
    var t = turns[which === 'last' ? turns.length - 1 : 0];
    return {
      hash: aiCmDiagHash6(t && t.id, t && t.text),
      text: String((t && t.text) || '').slice(0, 80).replace(/\s+/g, ' ')
    };
  }
  // Диагностический срез ходов по v33-глобальному order (на эмит не влияет).
  function aiCmOrderedTurns() {
    var ids = Object.keys(turnsMap);
    ids.sort(function (a, b) { return (turnsMap[a].order || 0) - (turnsMap[b].order || 0); });
    return ids.map(function (id) { return { id: id, text: turnsMap[id].text || '' }; });
  }
  // Окно холодного старта: первый ingest любого src после инициализации контент-скрипта
  // или после роста convEpoch (SPA-переход на новый convId). Длительность наблюдения — 60 секунд.
  var coldStartWindowStart = 0;
  var coldStartEpoch = -1;
  var coldStartConvId = '';
  var coldStartSourcesSeen = [];
  var coldStartEndTimer = null;
  function aiCmEnsureColdWindow() {
    if (coldStartEpoch === convEpoch) return;
    coldStartEpoch = convEpoch;
    coldStartWindowStart = Date.now();
    coldStartConvId = getConvId();
    coldStartSourcesSeen = [];
    if (coldStartEndTimer) { try { clearTimeout(coldStartEndTimer); } catch (e) { } coldStartEndTimer = null; }
    coldStartEndTimer = setTimeout(function () {
      var turns = aiCmOrderedTurns();
      var fe = aiCmDiagTurnEdge(turns, 'first');
      var le = aiCmDiagTurnEdge(turns, 'last');
      debugLog('log', '[AI CM][cold-start] window-end convId=' + (coldStartConvId || '(none)') +
        ' sourcesSeen=[' + coldStartSourcesSeen.join(',') + '] totalMsgs=' + turns.length +
        ' firstMsgHash=' + fe.hash + ' lastMsgHash=' + le.hash);
    }, 60000);
  }
  function aiCmColdStartIngestLog(src, snapshotTurns, msgsAdded, cacheHit) {
    if (!coldStartWindowStart || (Date.now() - coldStartWindowStart) > 60000) return;
    if (coldStartSourcesSeen.indexOf(src) === -1) coldStartSourcesSeen.push(src);
    var fe = aiCmDiagTurnEdge(snapshotTurns, 'first');
    var le = aiCmDiagTurnEdge(snapshotTurns, 'last');
    debugLog('log', '[AI CM][cold-start] src=' + src + ' convId=' + (getConvId() || '(none)') +
      ' msgsAdded=' + msgsAdded + ' firstMsgHash=' + fe.hash + ' lastMsgHash=' + le.hash +
      ' firstText="' + fe.text + '" lastText="' + le.text + '"' +
      ' cacheHit=' + (cacheHit ? 'true' : 'false') + ' ageMs=' + (Date.now() - coldStartWindowStart));
  }
  // Сводка по turnsMap для дампов в момент экспорта; content.js (ISOLATED) получает её
  // синхронно через CustomEvent-мост ai-cm-turns-snap-request/response. Также доступна
  // из консоли MAIN-мира: window.__aiCmGeminiTurnsSnapshot().
  try {
    if (!window.__aiCmGeminiTurnsSnapshot) {
      window.__aiCmGeminiTurnsSnapshot = function () {
        var turns = aiCmOrderedTurns();
        var fe = aiCmDiagTurnEdge(turns, 'first');
        var le = aiCmDiagTurnEdge(turns, 'last');
        // T1-fix#3 (v1.16.3): плюс ОБЪЕДИНЁННАЯ база (архив + live) — источник файла
        // автоэкспорта; content.js берёт её, если последний EMIT отстал от базы.
        var baseInfo = (typeof aiCmBaseExportInfo === 'function') ? aiCmBaseExportInfo() : null;
        return {
          convId: getConvId(),
          msgs: turns.length,
          firstMsgHash: fe.hash,
          lastMsgHash: le.hash,
          firstText: fe.text,
          lastText: le.text,
          baseComplete: historyFullByQuiet === true,
          reachedStart: reachedStart === true,
          confirmedByScroll: reachedStartByScroll === true,
          scrollEngaged: loaderState.scrollEngaged === true, // v66: скрытый скролл вовлечён?
          baseMsgs: baseInfo ? baseInfo.baseMsgs : turns.length,
          liveCount: baseInfo ? baseInfo.liveCount : null,
          archiveCount: baseInfo ? baseInfo.archiveCount : 0,
          liveProven: baseInfo ? baseInfo.liveProven : true,
          messages: (baseInfo && Array.isArray(baseInfo.messages)) ? baseInfo.messages : []
        };
      };
    }
  } catch (e) { }
  // ==== конец v61diag ====

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
  // ---- v52: stream-ingest (I4z33b = ход пользователя, Bsxleb = ход модели; ветка ДО isIngestRpc) ----
  // batchexecute-запросы генерации не проходят isIngestRpc. Walker'ы — в utils/gemini-intercept-logic.js
  // (extractStreamUserTurn / extractStreamModelTurn). Дедуп — через turnsMap внутри существующего ingest;
  // курсор пагинации, loader и основной пайплайн (src=passive/vf5/pag) НЕ трогаем.
  var STREAM_USER_RPCIDS = { I4z33b: 1 };
  var STREAM_MODEL_RPCIDS = { Bsxleb: 1 };
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
      return ingest('', {
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

  // ---- фильтры мусора ----

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
  function logIdmap(t, src, textlen, preview) {
    var r0 = (Array.isArray(t) && Array.isArray(t[0]) && typeof t[0][1] === 'string') ? t[0][1] : '';
    var r1 = (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][1] === 'string') ? t[1][1] : '';
    var rc = firstRc(t);
    var ts = 0;
    try { if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][0] === 'number' && t[1][0] > 1000000000) ts = t[1][0]; } catch (e) { }
    // v1.6 (D15a-2): preview — первые 40 символов текста хода (для поиска «Составь промт…» по id)
    var txt = String(preview || '').replace(/\s+/g, ' ').slice(0, 40);
    debugLog('log', '[gemini-idmap] src=' + src + ' ts=' + ts + ' r0=' + (r0 ? r0.slice(0, 6) : '-') + ' r1=' + (r1 ? r1.slice(0, 6) : '-') +
      ' rc=' + (rc ? rc.slice(0, 6) : '-') + ' textlen=' + textlen + ' txt=' + JSON.stringify(txt));
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
      // v1.15: маркер ошибки-страницы сбрасывается для КАЖДОЙ новой hNvQHb-страницы.
      // Страница-ошибка (inner не строка / BardErrorInfo) НЕ является концом истории:
      // курсор прошлого шага жив — окно повторяем (ретрай в paginateLoop), а не гасим цикл.
      lastHnvPageError = false;
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return;
      if (outer[0][1] !== 'hNvQHb') return;
      var inner = outer[0][2];
      if (typeof inner !== 'string') {
        // v1.15: распознаём ошибку Bard (inner=null + BardErrorInfo в метаданных wrb-блока,
        // пример: code 1177) и сообщаем пагинации, что это НЕ терминальная страница.
        var isErr1177 = false;
        try {
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
              typeof window.GeminiInterceptLogic.isBardErrorPage === 'function') {
            isErr1177 = window.GeminiInterceptLogic.isBardErrorPage(outer);
          } else {
            var __s1177 = JSON.stringify(outer[0]).slice(0, 2000);
            isErr1177 = __s1177.indexOf('type.googleapis.com') !== -1 ||
              __s1177.indexOf('BardError') !== -1 || __s1177.indexOf('ErrorInfo') !== -1;
          }
        } catch (e1177) { isErr1177 = false; }
        lastHnvPageError = isErr1177;
        lastFailedSkeleton = buildJsonSkeleton(outer, 0);
        debugLog('log', '[gemini-skeleton] сохранён src=' + src + ' (inner не строка)' +
          (isErr1177 ? ' → BARD-ERROR PAGE (окно будет повторено)' : ''));
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
      // v1.6 (D16): диагностика источника курсора (откуда взят токен пагинации)
      if (pendingCursor) lastCursorSource = src;
      else if (src === 'pag' || src === 'vf5' || src === 'passive') lastCursorSource = 'none:' + src;
      // v53: любой history-write с курсором — новое поколение (сбрасывает счётчики лоадера)
      if (pendingCursor) cursorEpoch++;
      // v46: сигнал «есть старшая история» для гейта старта лоадера
      if (pendingCursor) olderHistorySeen = true;
      // v74 (баг B): первый снимок БЕЗ continuation-курсора (olderHistorySeen=false) —
      // сервер отдал терминальную страницу (страница без курсора = неполная/последняя),
      // старшей истории нет → полнота сразу. Только для пассивных снимков (passive/vf5):
      // pag-страницы и диагностические парсы ('pb'/'sh'/'wd') оракул не минуют.
      // O-48: блок НЕ переписан (байтовый пин «прежние пути полноты»). На ВОССТАНОВЛЕННОМ
      // (обрезанном) кадре взведённая здесь полнота откатывается вызывающим —
      // см. handleSalvagedOuter (отсутствие курсора в обрывке ничего не доказывает, D1).
      if ((src === 'passive' || src === 'vf5') && !pendingCursor && !olderHistorySeen &&
          Array.isArray(turns) && turns.length > 0 && !historyFullByQuiet) {
        historyFullByQuiet = true;
        reachedStart = true;
        quietIncompleteNoStart = false;
        quietDecisionMade = true; // фолбэк-автоскролл не нужен — история полная
        debugLog('log', '[AI CM][completeness] oracle=complete reason=no-older-history turns=' + turns.length +
          ' convId=' + (getConvId() || '(none)'));
      }
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
        // v72diag: rest-строки (outer[0].slice(3)) для КАЖДОЙ страницы hNvQHb — кандидаты
        // курсора ВНЕ turns (walkOpaque ограничен 40..600; курсор может быть длиннее).
        try {
          var restDiag = arr0.slice(3);
          for (var rdi = 0; rdi < restDiag.length; rdi++) {
            (function walkRest(node) {
              if (typeof node === 'string') {
                if (node.length < 8) return;
                var isB64 = /^[A-Za-z0-9+/=]+$/.test(node);
                debugLog('log', '[AI CM][cursor-diag] rest[' + rdi + '] len=' + node.length +
                  ' b64=' + (isB64 ? 'yes' : 'no') +
                  ' head=' + JSON.stringify(node.slice(0, 12)) +
                  ' tail=' + JSON.stringify(node.slice(-12)) +
                  (isB64 && node.length >= 40 ? ' → CANDIDATE' : '') +
                  ' convId=' + (getConvId() || '(none)') + ' src=' + src);
                return;
              }
              if (Array.isArray(node)) for (var ri = 0; ri < node.length; ri++) walkRest(node[ri]);
            })(restDiag[rdi]);
          }
        } catch (eRd) { }
      } catch (e) { lastPaginateOpaqueCandidates = null; }
      if (DEBUG_STRUCTURE && !loggedStructure) {
        loggedStructure = true;
        var sm = []; structureMap(turns, 0, sm, { n: 0 });
        debugLog('log', '[gemini-intercept] рентген структуры хода #0 (глубина:длина:тип): ' + sm.join(' | '));
      }
      var doIdmap = (idmapCalls < IDMAP_MAX);
      var _nonEmpty = 0, _empty = 0, _skippedIds = [];
      var realTurns = (Array.isArray(turns[0]) && Array.isArray(turns[0][0])) ? turns[0] : turns;
      // v1.6 (D13): DR stateless — обновляем DR-контент парсера из этих realTurns;
      // splitTurnMessages в цикле ниже заменит голые ссылки (immersive/подтверждение)
      // на текст отчёта/плана. Пересборки стабильны (нет синтетического хода).
      try {
        if (typeof window !== 'undefined' && window.GeminiBatchexecuteParser &&
            typeof window.GeminiBatchexecuteParser.extractDrTexts === 'function' &&
            typeof window.GeminiBatchexecuteParser.__setDrTexts === 'function') {
          window.GeminiBatchexecuteParser.__setDrTexts(window.GeminiBatchexecuteParser.extractDrTexts(realTurns));
        }
      } catch (eD13) { debugLog('log', '[gemini-intercept] parse-top fail (eD13/DR): ' + (eD13 && eD13.message || eD13)); }
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
        if (doIdmap) {
          try {
            var previewTxt = '';
            for (var pv = 0; pv < segs.length; pv++) {
              if (segs[pv] && segs[pv].text) { previewTxt = segs[pv].text; break; }
            }
            logIdmap(t, src, (segs && segs.length) ? segs.map(function (x) { return (x && x.text) ? x.text.length : 0; }).reduce(function (a, b) { return a + b; }, 0) : 0, previewTxt);
          } catch (e) { }
        }
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
    } catch (e) { debugLog('log', '[gemini-intercept] parse-top fail (handleOuter): ' + (e && e.message || e)); /* один кривой блок не ломает остальные */ }
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
  // H13 (inner-cursor): канон opaque-экстракции курсора — window.GeminiInterceptLogic.*
  // (utils/gemini-intercept-logic.js); здесь — делегация + inline-дубль (конвенция
  // probeTerminalGate/pagStepBroken). H13: потолок классификатора 600→2000 — токены
  // глубоких окон (e292: len=705/849 в turns[1] parsed-inner) реальны, отсечение 600
  // было ложным negative; фильтры мусора (image/png-строки, не-b64) сохранены.
  function classifyOpaque(s) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.classifyOpaque === 'function') {
      return window.GeminiInterceptLogic.classifyOpaque(s);
    }
    if (typeof s !== 'string') return false;
    if (s.length < 40 || s.length > 2000) return false;
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
  // H13: канон в GeminiInterceptLogic.extractCursor — opaque-кандидаты по всему turns
  // (включая turns[1] parsed-inner), приоритет — ДЛИННЕЙШИЙ (равные: последний, как до H13).
  function extractCursor(turns) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.extractCursor === 'function') {
      return window.GeminiInterceptLogic.extractCursor(turns);
    }
    var c = [];
    if (Array.isArray(turns)) { for (var i = 0; i < turns.length; i++) findCursors(turns[i], c); }
    if (!c.length) return null;
    if (c.length > 1 && !loggedMultiCursor) {
      loggedMultiCursor = true;
      debugLog('log', '[gemini-paginate] найдено ' + c.length + ' opaque-кандидатов в ответе (беру длиннейший): ' + c.map(edges8).join(' | '));
    }
    var bestC = c[c.length - 1];
    for (var bj = 0; bj < c.length; bj++) { if (c[bj].length > bestC.length) bestC = c[bj]; }
    return bestC;
  }
  // v73/H13: фиксированная ШИРОКАЯ экстракция курсора — строки 8..2000
  // (потолок classifyOpaque 600 снят), base64-подобные, без '$AVuibg'. Канон — в utils.
  function classifyOpaqueWide(s) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.classifyOpaqueWide === 'function') {
      return window.GeminiInterceptLogic.classifyOpaqueWide(s);
    }
    if (typeof s !== 'string') return false;
    if (s.length < 8 || s.length > 2000) return false;
    if (!/^[A-Za-z0-9+/=]+$/.test(s)) return false;
    if (s.indexOf('$AVuibg') === 0) return false;
    return true;
  }
  // H13 (inner-cursor): зоны wide-скана — (1) inner: outer[0][2] → JSON.parse → turns
  // (слот курсора turns[1]; e292: токены len=705/849 жили ТОЛЬКО там, rest их не нёс →
  // probe объявлял ложный терминал), (2) rest: outer[0].slice(3) как было. Порядок зон —
  // inner ПЕРВОЙ; приоритет — ДЛИННЕЙШИЙ b64-кандидат (classifyOpaqueWide). Канон —
  // в GeminiInterceptLogic.extractCursorWide, ниже inline-дубль.
  function extractCursorWide(outer) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.extractCursorWide === 'function') {
      return window.GeminiInterceptLogic.extractCursorWide(outer);
    }
    var bestW = null;
    function scanWideZone(zone) {
      (function walkW(n) {
        if (typeof n === 'string') {
          if (classifyOpaqueWide(n) && (!bestW || n.length > bestW.length)) bestW = n;
          return;
        }
        if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) walkW(n[i]); }
      })(zone);
    }
    try {
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return null;
      var innerParsedW = null;
      try {
        var innerStrW = outer[0][2];
        if (typeof innerStrW === 'string') {
          var parsedInnerW = JSON.parse(innerStrW);
          if (Array.isArray(parsedInnerW)) innerParsedW = parsedInnerW;
        }
      } catch (eH13WIn) { innerParsedW = null; }
      if (innerParsedW) scanWideZone(innerParsedW);
      scanWideZone(outer[0].slice(3));
      return bestW;
    } catch (eH13W) { return null; }
  }
  // v73: пересчёт минимума order; понижение минимума вне 'pag' инвалидирует scroll-proof
  function refreshMinOrderTracking(src) {
    var minOrd = Infinity;
    for (var k in turnsMap) {
      var o = turnsMap[k] && turnsMap[k].order;
      if (typeof o === 'number' && o < minOrd) minOrd = o;
    }
    if (minOrd !== Infinity && minOrd < minOrderSeen) {
      if (src !== 'pag') lastOlderNonPagAddAt = Date.now();
      minOrderSeen = minOrd;
    }
  }

  // ---- парсер кадров batchexecute (O-50: единица префикса длины — СИМВОЛ декодированной строки) ----
  // O-50 (лог-свидетель 2026-09-25 15:20:35): префикс длины кадра дан в СИМВОЛАХ payload'а
  // (`declaredN=1093974` = `rawLen(1094077)` минус заголовок, `clamped=0`), а legacy-код
  // перекодировал raw в UTF-8-байты (TextEncoder) и резал n БАЙТ: на кириллице n символов не
  // равно n байт (`reEncodedLen(1258177)` / `rawLen(1094077)` ~ 1.15), срез уезжал ВЛЕВО и
  // JSON.parse получал обрезанный кадр при clamped=0 («Unterminated string»). Вариант «сеть
  // отдала обрыв» опровергнут числами. Теперь границы кадров — В СИМВОЛЬНОМ пространстве:
  // `bytes` ниже на основном пути — вид КОДОВ символов (Uint16Array, длина == raw.length),
  // payload берётся `raw.slice(pos, end)`; TextEncoder на этом пути не участвует вовсе.
  // Совместимость: тела, размеченные в БАЙТАХ (legacy-сборки/фикстуры), распознаются
  // СТРУКТУРНОЙ проверкой разметки (framingStrictScore, без JSON.parse) ДО цикла: если она
  // подтверждает в байтовом пространстве БОЛЬШЕ кадров, чем в символьном, пространство
  // переключается на UTF-8-байты (TextEncoder/TextDecoder — только там, только чтение; при
  // недоступности глобалов остаётся символьное). Иначе — символьное (приоритет O-50: обрыв
  // последнего кадра и ASCII-тела дают равные счёты, выбор остаётся символьным).
  // Диаг-числа O-48 (declaredN/availableBytes/reEncodedLen/rawLen/clamped/salvagedTurns)
  // считаются в БАЙТАХ: availableBytes/reEncodedLen — арифметикой utf8Len (без перекодировки
  // кадра), поэтому пины O-48 (16) и gemini-partial-frame-parse остаются целыми.
  function parseByBytes(raw, out, src) {
    if (typeof raw !== 'string') raw = '';
    var rawLen = raw.length;
    var reEncodedLenMemo = -1;
    // Длина строки в байтах UTF-8 — арифметика по кодам символов (без TextEncoder).
    function utf8Len(s) {
      if (typeof s !== 'string' || !s) return 0;
      var total = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) total += 1;
        else if (c < 0x800) total += 2;
        else if (c >= 0xD800 && c <= 0xDBFF && (i + 1) < s.length) {
          var d = s.charCodeAt(i + 1);
          if (d >= 0xDC00 && d <= 0xDFFF) { total += 4; i++; } else total += 3;
        } else total += 3;
      }
      return total;
    }
    function reEncodedLenOfRaw() {
      if (reEncodedLenMemo < 0) reEncodedLenMemo = utf8Len(raw);
      return reEncodedLenMemo;
    }
    // Вид кодов символов: длина равна числу символов строки (СИМВОЛЬНОЕ пространство среза).
    function charCodeView(s) {
      var a = new Uint16Array(s.length);
      for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      return a;
    }
    // Структурная проверка разметки БЕЗ JSON.parse: кадры идут «цифры длины, LF, payload, LF,
    // ...» и объявленные длины сходятся с границами. Возвращает {score: число подтверждённых
    // кадров, complete: разметка сошлась до конца тела}; обрыв тела или разъезд единиц
    // останавливают счёт. По паре этих чисел выбирается пространство среза.
    function framingStrictScore(seq) {
      var res = { score: 0, complete: false };
      if (!seq || !seq.length) return res;
      var p = 0;
      if (seq.length >= 4 && seq[0] === 0x29 && seq[1] === 0x5D && seq[2] === 0x7D && seq[3] === 0x27) p = 4;
      var g = 0;
      while (p < seq.length && g++ < 200) {
        while (p < seq.length && (seq[p] < 48 || seq[p] > 57)) p++;
        if (p >= seq.length) break;
        var m = 0;
        while (p < seq.length && seq[p] >= 48 && seq[p] <= 57) { m = m * 10 + (seq[p] - 48); p++; }
        if (m <= 0) return res;
        if (p >= seq.length || seq[p] !== 0x0A) return res;
        p++;
        if ((p + m) > seq.length) return res;
        p += m;
        res.score++;
        if (p < seq.length) {
          if (seq[p] !== 0x0A) return res;
          p++;
        }
      }
      res.complete = (p >= seq.length);
      return res;
    }
    var charCodes = charCodeView(raw);
    var charFit = framingStrictScore(charCodes);
    var bytes = charCodes;
    var hasUtf8 = false;
    var dec = null;
    if (!charFit.complete) {
      var utf8Try = null;
      var utf8Dec = null;
      try { utf8Try = new TextEncoder().encode(raw); utf8Dec = new TextDecoder('utf-8'); } catch (eLegacy) { utf8Try = null; utf8Dec = null; }
      if (utf8Try && utf8Dec && framingStrictScore(utf8Try).score > charFit.score) {
        bytes = utf8Try; hasUtf8 = true; dec = utf8Dec;
      }
    }
    var pos = 0;
    if (bytes.length >= 4 && bytes[0] === 0x29 && bytes[1] === 0x5D && bytes[2] === 0x7D && bytes[3] === 0x27) pos = 4;
    var guard = 0;
    while (pos < bytes.length && guard++ < 200) {
      while (pos < bytes.length && (bytes[pos] < 48 || bytes[pos] > 57)) pos++;
      if (pos >= bytes.length) break;
      var n = 0;
      while (pos < bytes.length && bytes[pos] >= 48 && bytes[pos] <= 57) { n = n * 10 + (bytes[pos] - 48); pos++; }
      if (n <= 0) { pos++; continue; }
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      var posPayload = pos;                    // O-48: начало payload'а (для availableBytes)
      var clamped = (pos + n) > bytes.length;  // O-48: объявленная длина больше доступного — клэмп
      var end = pos + n; if (end > bytes.length) end = bytes.length;
      // O-50: срез кадра в СИМВОЛЬНОМ пространстве (string.slice) — основной путь;
      // legacy-разметка в байтах (hasUtf8) берёт срез из UTF-8-вида.
      var payloadStr = hasUtf8 ? dec.decode(bytes.subarray(pos, end)) : raw.slice(pos, end);
      pos = end;
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      if (payloadStr.indexOf('hNvQHb') !== -1) {
        try { handleOuter(JSON.parse(payloadStr), out, src); } catch (e) {
          // O-48: tolerant-salvage — завершённые ходы и курсор из обрезанного текста ДО
          // JSON.parse failure (штатный handleOuter, только по восстановленному префиксу).
          var salvaged = 0;
          if (typeof salvagePartialFrame === 'function') { try { salvaged = salvagePartialFrame(payloadStr, out, src); } catch (eSv) { salvaged = 0; } }
          var availBytes = hasUtf8 ? (bytes.length - posPayload) : utf8Len(raw.slice(posPayload));
          lastFrameParseFail = {
            where: 'parseByBytes', msg: (e && e.message || String(e)),
            declaredN: n, availableBytes: availBytes, reEncodedLen: reEncodedLenOfRaw(),
            rawLen: rawLen, clamped: clamped === true, salvaged: salvaged
          };
          debugLog('log', '[gemini-intercept] parse-top fail (parseByBytes): ' + (e && e.message || e) +
            ' declaredN=' + n + ' availableBytes=' + availBytes + ' reEncodedLen=' + reEncodedLenOfRaw() +
            ' rawLen=' + rawLen + ' clamped=' + (clamped ? 1 : 0) + ' salvagedTurns=' + salvaged);
        }
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
      try { handleOuter(JSON.parse(ln), out, src); } catch (e) {
        lastFrameParseFail = {
          where: 'parseByLines', msg: (e && e.message || String(e)),
          declaredN: ln.length, availableBytes: ln.length, reEncodedLen: 0,
          rawLen: (typeof raw === 'string') ? raw.length : 0, clamped: false, salvaged: 0
        };
        debugLog('log', '[gemini-intercept] parse-top fail (parseByLines): ' + (e && e.message || e));
      }
    }
  }
  function parseBatchExecute(raw, src) {
    var out = { turns: [], total: 0 };
    lastFrameParseFail = null; // O-48: обрыв фиксируется НА КАЖДЫЙ парс — читает вызвавший
    parseByBytes(raw, out, src);
    if (!out.turns.length) parseByLines(raw, out, src);
    return out.turns;
  }

  // ================= O-48: tolerant-salvage обрезанного кадра =================
  // Кадр, оборванный КЛЭМПОМ объявленной длины (или сетью на середине строки), JSON.parse
  // не проходит целиком — но завершённые ходы уже лежат в его тексте ДО точки обрыва.
  // Восстанавливаем максимальный СИНТАКСИЧЕСКИ ЦЕЛЫЙ префикс: незавершённый элемент
  // отбрасывается ЦЕЛИКОМ, открытые контейнеры закрываются. Гарантия «нет частичных ходов»:
  // точка отреза — граница последнего ПОЛНОСТЬЮ закрытого элемента СПИСКА ХОДОВ
  // (turn-like: массив минимум из 3 полей, первое поле — не строка). Завершённых ходов нет —
  // возвращаем '' (ничего не рвём, поведение прежнее). Лимиты парсера НЕ поднимаются:
  // кадр обрезан на входе, а не отброшен потолком.
  // Форма хода Gemini (utils/gemini-batchexecute-parser.js): [null, [ids…], [[вопрос]],
  // [[[ответ]]], [ts]] — inner-массивы хода этому предикату не удовлетворяют (короче или
  // начинаются со строки), поэтому список ходов читается однозначно.
  function isTurnLikeSpan(span) {
    if (!span || span.kind !== 'arr' || span.closed !== true) return false;
    if (!(span.count >= 3)) return false;
    return span.firstIsString !== true;
  }
  // Учёт ЗАВЕРШЁННОГО значения на верхушке стека открытых контейнеров.
  function noteJsonChild(stack, endIdx, child) {
    var top = stack[stack.length - 1];
    if (!top) return;
    top.count++;
    top.lastEnd = endIdx;
    if (top.count === 1) top.firstIsString = (child.kind === 'str');
    if (top.kind === 'arr' && isTurnLikeSpan(child)) top.lastTurnEnd = endIdx;
  }
  function closeTruncatedJson(s) {
    if (typeof s !== 'string' || s.length < 2) return '';
    var stack = [];
    var inStr = false, esc = false;
    for (var i = 0; i < s.length; i++) {
      var cc = s.charCodeAt(i); // 34 '"', 91 '[', 123 '{', 92 '\\', 93 ']', 125 '}'
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (cc === 92) { esc = true; continue; }
        if (cc === 34) { inStr = false; noteJsonChild(stack, i, { kind: 'str' }); }
        continue;
      }
      if (cc === 34) { inStr = true; continue; }
      if (cc === 91 || cc === 123) {
        stack.push({ kind: (cc === 91 ? 'arr' : 'obj'), at: i, closeCode: (cc === 91 ? 93 : 125),
          closed: false, count: 0, firstIsString: null, lastEnd: -1, lastTurnEnd: -1 });
        continue;
      }
      if (cc === 93 || cc === 125) {
        if (!stack.length) return ''; // несогласованная скобка — не чиним
        var doneSpan = stack.pop();
        doneSpan.closed = true;
        doneSpan.end = i;
        noteJsonChild(stack, i, doneSpan);
        continue;
      }
      if (cc === 58 || cc === 44 || cc === 32 || cc === 9 || cc === 10 || cc === 13) continue; // : , \s
      // литерал (число/true/false/null): тянем до ближайшего разделителя
      var j = i;
      while (j + 1 < s.length && /[0-9A-Za-z+\-.]/.test(s.charAt(j + 1))) j++;
      if (j + 1 >= s.length) { i = j; break; } // литерал у самого обрыва — НЕ завершён
      noteJsonChild(stack, j, { kind: 'lit' });
      i = j;
    }
    // Список ходов — самый ВНЕШНИЙ открытый контейнер, у которого есть завершённый ход.
    var cut = -1, cutDepth = -1;
    for (var f = 0; f < stack.length; f++) {
      if (stack[f].kind === 'arr' && stack[f].lastTurnEnd >= 0) { cut = stack[f].lastTurnEnd + 1; cutDepth = f; break; }
    }
    if (cut < 0 || cutDepth < 0) return '';
    var repaired = s.slice(0, cut).replace(/[\s,]+$/, '');
    for (var k = cutDepth; k >= 0; k--) repaired += String.fromCharCode(stack[k].closeCode);
    return repaired;
  }
  // Терпимый разархиватор JSON-литерала: обрыв внутри \uXXXX или одиночный '\' в хвосте
  // отбрасываются (не бросаем), кавычка-терминатор не обязательна.
  function unescapeJsonLiteralPrefix(raw) {
    var res = '';
    for (var i = 0; i < raw.length; i++) {
      var c = raw.charAt(i);
      if (c !== '\\') { res += c; continue; }
      if (i + 1 >= raw.length) break;
      var e = raw.charAt(i + 1); i++;
      if (e === 'n') res += '\n';
      else if (e === 't') res += '\t';
      else if (e === 'r') res += '\r';
      else if (e === 'b') res += '\b';
      else if (e === 'f') res += '\f';
      else if (e === 'u') {
        if (i + 4 >= raw.length) break;
        var hex = raw.substr(i + 1, 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        res += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else res += e; // \" \\ \/ и прочие однобайтовые escape'ы
    }
    return res;
  }
  // Inner-строка ходов (outer[0][2]) из ЧАСТИЧНОГО кадра: маркер "hNvQHb", затем ровно `,"`
  // (никаких догадок — при иной форме возвращаем ''), затем до кавычки-терминатора или конца.
  function extractTruncatedInner(payloadStr) {
    var marker = payloadStr.indexOf('"hNvQHb"');
    if (marker === -1) return '';
    var q = payloadStr.indexOf('"', marker + 8);
    if (q === -1) return '';
    if (!/^\s*,\s*$/.test(payloadStr.slice(marker + 8, q))) return '';
    var raw = '';
    for (var i = q + 1; i < payloadStr.length; i++) {
      var c = payloadStr.charAt(i);
      if (c === '\\') { raw += c; if (i + 1 < payloadStr.length) { raw += payloadStr.charAt(i + 1); i++; } continue; }
      if (c === '"') break;
      raw += c;
    }
    return unescapeJsonLiteralPrefix(raw);
  }
  // Штатный handleOuter на ВОССТАНОВЛЕННОМ кадре + сохранение честности полноты: кадр обрезан,
  // поэтому флаги полноты откатываются к состоянию до вызова (страховка к v74-гарду выше).
  // Всё остальное (pendingCursor/olderHistorySeen/cursorEpoch/диагностика) — штатный путь.
  function handleSalvagedOuter(outer, out, src) {
    var wasFull = historyFullByQuiet, wasReached = reachedStart;
    var wasQuiet = quietDecisionMade, wasNoStart = quietIncompleteNoStart;
    try { handleOuter(outer, out, src); } catch (eSalv) { }
    // Кадр обрезан → его «нет курсора» и «нет старших» НЕ доказывают терминальную страницу:
    // откатываем все четыре флага полноты к состоянию до вызова (v74-ветка handleOuter
    // остаётся байтово нетронутой — гарантия держится на откате, а не на её правке).
    historyFullByQuiet = wasFull;
    reachedStart = wasReached;
    quietDecisionMade = wasQuiet;
    quietIncompleteNoStart = wasNoStart;
    debugLog('log', '[AI CM][salvage] обрезанный кадр: handleOuter вызван на восстановленном префиксе' +
      ' (ходов в out=' + out.turns.length + ', src=' + src + ') — полнота НЕ взводится');
  }
  // Возвращает число восстановленных ходов (0 — ничего не восстановлено, поведение прежнее).
  function salvagePartialFrame(payloadStr, out, src) {
    if (typeof payloadStr !== 'string' || payloadStr.indexOf('hNvQHb') === -1) return 0;
    var before = out.turns.length;
    // (1) обрыв в служебной части кадра (inner цел, оборваны rest/хвост) — чиним сам кадр
    var outerText = closeTruncatedJson(payloadStr);
    if (outerText) {
      var outerVal = null;
      try { outerVal = JSON.parse(outerText); } catch (eOuter) { outerVal = null; }
      if (outerVal) handleSalvagedOuter(outerVal, out, src);
    }
    // (2) обрыв ВНУТРИ строки ходов — восстанавливаем список завершённых ходов и отдаём
    //     штатному handleOuter (курсор/ids/r1/model извлекаются тем же путём, что у целого)
    if (out.turns.length === before) {
      var innerFixed = closeTruncatedJson(extractTruncatedInner(payloadStr));
      if (!innerFixed) return 0;
      handleSalvagedOuter([['wrb.fr', 'hNvQHb', innerFixed]], out, src);
    }
    return out.turns.length - before;
  }

  // ================= v4y: ЛОАДЕР ПОЛНОЙ ИСТОРИИ + АВТОЗАПУСК =================
  // Тело повторяет рабочий консольный сниппет loadFullHistoryInvisibly:
  // невидимый скролл вверх (scrollTop=0) до стабилизации scrollHeight,
  // шаг 800мс, максимум 30 итераций, восстановление сохранённой позиции
  // (v80: видимость обеспечивает overlay на body, DOM чата не скрывается).
  // Логи — под флагом «Подробные логи» (debugLog); ошибки — всегда в консоль.
  var LOADER_MAX_ITER = 30;
  var LOADER_STEP_MS = 1200;    // v4z: окно пагинации медленное — 800мс давало ложную стабилизацию
  var LOADER_FIND_TRIES = 20;   // poll появления скроллера до 10с
  var LOADER_FIND_WAIT = 500;
  var LOADER_STABLE_NEED = 3;   // v30.7: три негро-стящих чтения до контрольного замера
  var LOADER_RECHECK_MS = 2000; // v4z: контрольный перемер после «стабилизации»
  var LOADER_RESUME_DELTA = 200; // v4z: вырос больше — возобновить цикл
  // v53: кап ретраев скролла при живом continuation-курсоре (h не растёт, курсор есть).
  // Холодный старт (простой >12ч) медленный — поднят до 90 (шаг ~1с → до ~90с).
  // Исчерпание капа → done reason=timeout. Раньше (30) лоадер стопился преждевременно
  // при ещё живой истории (логи 0362260d: pct=56.2 терялись до ручного скролла).
  var LOADER_STALL_CAP = 90;
  var LOADER_HIDE_MIN_H = 8000;
  // v66: доказательство вовлечения скрытого скролла. scrollEngaged=true при ЛЮБОМ из:
  //   1) hide-applied (скроллер прятался — значит лента реально прокручивалась);
  //   2) scrollH вырос за прогон на >= MIN_SCROLL_H_FOR_ENGAGEMENT пикселей;
  //   3) scrollTop менялся (были не у верха / положение сдвигалось).
  // data-complete / reachedStart / topReached доверять ТОЛЬКО при scrollEngaged:
  // холодный старт с невовлечённым скроллом (iter h=864 без роста, scrollTop=0)
  // давал ложный data-complete и high-confidence фрагмент (лог 15:40).
  // v67: порог роста scrollH за прогон для признания скрытого скролла вовлечённым —
  // отсеивает фоновые сдвиги верстки Gemini при холодной загрузке (мелкие перерисовки
  // дают сдвиги в десятки px; реальная подгрузка старших окон истории — в тысячи px).
  var MIN_SCROLL_H_FOR_ENGAGEMENT = 2000;
  // v67: сводное состояние текущего/последнего прогона лоадера (нужно snapshot-at-fired;
  // лоадер одиночный — loaderRunningFor, поэтому мутируем один модульный объект).
  var loaderState = {
    scrollEngaged: false, // скрытый скролл вовлечён (hide-applied ИЛИ рост scrollH ИЛИ смена scrollTop)
    hideApplied: false,   // скроллер был спрятан в этом прогоне
    topReached: false,    // v65/v66: физический верх (scrollTop<=8) при вовлечённом скролле
    startH: 0,            // scrollH на старте прогона
    maxHSeen: 0,          // максимум scrollH за прогон
    prevTopRead: -1       // предыдущее чтение scrollTop (детект смены)
  };
  var lastLoaderDoneReason = ''; // v78: done-reason последнего прогона лоадера — гейт stable-stop оракула
  var collapseRetries = 0; // v1.14.2 (COLLAPSE-GUARD): бюджет перезапусков лоадера при коллапсе скроллера (макс 2); сброс при смене convId и при base>=floor
  var loaderRetryUsedMap = {}; // v66: convId → true — единственный повторный прогон лоадера уже израсходован
  // v45: минимальный число известных ходов по текущему convId для скрытия скроллера.
  // Обоснование: порог 50 ходов надёжно отделяет «короткий, но высокий» чат (мало msgs,
  // большая scrollHeight — пример f47e2edd h=11893) от реально длинной истории; у длинных
  // чатов после частичной подгрузки msgs обычно уже >50, поэтому скрытие не блокируется.
  var LOADER_HIDE_MIN_MSGS = 50;
  var SCROLL_PAUSE_HIDDEN_MS = 800; // v30.9: пауза между итерациями ПОСЛЕ скрытия скроллера // v30.7: скрытие ТОЛЬКО при scrollHeight>8000 — короткие чаты не прячем

  // ================= v75/v80: видимость БЕЗ скрытия DOM чата (фикс O1) =================
  // Грубое скрытие контейнера (opacity/display/visibility) ломало виртуализацию Gemini.
  // Прозрачный оверлей v75 оставлял пользователя свидетелем страховочного скролла:
  // чисто-белый (opacity=0 скроллера в v78-fallback) и «начало чата» (unhide до возврата
  // позиции). v80 (стандарт v1.14.0): НЕПРОЗРАЧНЫЙ overlay на body под тему сервиса —
  // фон + спиннер + подпись «Загрузка истории…», класс ai-cm-*. Корневые элементы чата
  // НЕ трогаются вовсе — виртуализация продолжает рендерить старшие окна; скроллер не
  // скрывается. Снятие: после loader-stop + восстановления позиции + двух rAF; безусловно
  // — на visibilitychange/pagehide/conv-switch. safety-timeout не нужен — скрывать нечего.
  var aiCmScrollOverlay = null;
  var aiCmOverlaySeq = 0;        // v80: поколение оверлея — seq-гвард от чужого снятия
  var aiCmRerunOverlayTimer = null; // v80: разоружение pre-applied оверлея, если ре-ран не стартовал
  // H22: тема оверлея следует in-app теме Gemini («Настройки → Тема»), а не только
  // prefers-color-scheme. Признак 1 — класс-токены theme-host.dark-theme / .light-theme на
  // html/body (CSS страницы: gemini-dom-sample.html:75 `:where(.theme-host):where(.dark-theme)`);
  // признак 2 — computed-яркость НЕПРОЗРАЧНОГО фона (lum<100 → dark). Хосты кроме Gemini и
  // светлый фон сохраняют прежнюю цепочку байтово (светлый фон не понижает до light).
  function aiCmIsGeminiHost() {
    try { return /(^|\.)gemini\.google\.com$/i.test(location.hostname); } catch (eH0) { return false; }
  }
  function aiCmOverlayTheme() {
    var dark = null;
    if (aiCmIsGeminiHost()) {
      try {
        var cls = ((document.documentElement && document.documentElement.className) || '') + ' ' +
                  ((document.body && document.body.className) || '');
        if (/(^|\s)dark-theme(\s|$)/.test(cls)) dark = true;
        else if (/(^|\s)light-theme(\s|$)/.test(cls)) dark = false;
      } catch (eTh0) { }
      if (dark === null) {
        try {
          var hostElG = document.querySelector('.theme-host.dark-theme, .theme-host.light-theme');
          if (hostElG) dark = hostElG.classList.contains('dark-theme');
        } catch (eTh0b) { }
      }
      if (dark === null) {
        try {
          var probes = [document.body, document.documentElement];
          for (var pi = 0; pi < probes.length; pi++) {
            var probeG = probes[pi];
            var cG = probeG ? (getComputedStyle(probeG).backgroundColor || '') : '';
            var mG = cG.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/);
            if (!mG) continue;
            var isTransparentG = (mG[4] !== undefined && parseFloat(mG[4]) === 0);
            if (!isTransparentG && (0.2126 * (+mG[1]) + 0.7152 * (+mG[2]) + 0.0722 * (+mG[3])) < 100) { dark = true; break; }
          }
        } catch (eTh1) { }
      }
    } else {
      try {
        var probe = document.documentElement || document.body;
        var c = probe ? (getComputedStyle(probe).backgroundColor || '') : '';
        var m = c.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/);
        if (m) {
          var isTransparent = (m[4] !== undefined && parseFloat(m[4]) === 0);
          if (!isTransparent) dark = (0.2126 * (+m[1]) + 0.7152 * (+m[2]) + 0.0722 * (+m[3])) < 100;
        }
      } catch (eTh1b) { }
    }
    if (dark === null) {
      try { dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (eTh2) { dark = false; }
    }
    return dark ? { name: 'dark', bg: '#1e1f20', fg: '#e3e3e3', ring: '#37393b' }
                : { name: 'light', bg: '#f0f4f9', fg: '#1f1f1f', ring: '#c4c7c5' };
  }
  // H22: живой пересчёт палитры поднятого оверлея при смене темы (класс/style/data-theme на
  // html/body ИЛИ prefers-color-scheme). Наблюдатель живёт только пока оверлей поднят.
  var aiCmOverlayThemeWatcher = null;
  function aiCmApplyOverlayTheme() {
    if (!aiCmScrollOverlay) return;
    try {
      var th = aiCmOverlayTheme();
      aiCmScrollOverlay.style.background = th.bg;
      var sp = aiCmScrollOverlay.querySelector('.ai-cm-loader-spinner');
      if (sp) { sp.style.borderColor = th.ring; sp.style.borderTopColor = th.fg; }
      var lb = aiCmScrollOverlay.querySelector('.ai-cm-loader-label');
      if (lb) lb.style.color = th.fg;
    } catch (eAt) { }
  }
  function aiCmWatchOverlayTheme(on) {
    try {
      if (on) {
        if (aiCmOverlayThemeWatcher) return;
        var reapply = function () { aiCmApplyOverlayTheme(); };
        var obs = new MutationObserver(reapply);
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        // H22: тема сервиса может жить на элементе-хосте .theme-host — следим и за ним
        var hostElW = null;
        try { hostElW = document.querySelector('.theme-host'); } catch (eQw) { }
        if (hostElW && hostElW !== document.documentElement && hostElW !== document.body) {
          obs.observe(hostElW, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        }
        var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        if (mql && mql.addEventListener) mql.addEventListener('change', reapply);
        aiCmOverlayThemeWatcher = { obs: obs, mql: mql, reapply: reapply };
      } else if (aiCmOverlayThemeWatcher) {
        aiCmOverlayThemeWatcher.obs.disconnect();
        if (aiCmOverlayThemeWatcher.mql && aiCmOverlayThemeWatcher.mql.removeEventListener) {
          aiCmOverlayThemeWatcher.mql.removeEventListener('change', aiCmOverlayThemeWatcher.reapply);
        }
        aiCmOverlayThemeWatcher = null;
      }
    } catch (eWt) { }
  }
  function aiCmSetScrollOverlay(on, reason, expectSeq) {
    try {
      if (on) {
        if (!aiCmScrollOverlay && typeof document !== 'undefined' && document.body) {
          var th = aiCmOverlayTheme();
          aiCmScrollOverlay = document.createElement('div');
          aiCmScrollOverlay.id = 'ai-cm-scroll-overlay';
          aiCmScrollOverlay.className = 'ai-cm-loader-overlay';
          aiCmScrollOverlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;background:' + th.bg + ';display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
          var sp = document.createElement('div');
          sp.className = 'ai-cm-loader-spinner';
          sp.style.cssText = 'width:36px;height:36px;border-radius:50%;border:3px solid ' + th.ring + ';border-top-color:' + th.fg + ';animation:aiCmOverlaySpin 0.9s linear infinite;';
          var lb = document.createElement('div');
          lb.className = 'ai-cm-loader-label';
          lb.style.cssText = 'font:400 14px "Google Sans",Roboto,Arial,sans-serif;color:' + th.fg + ';user-select:none;';
          lb.textContent = 'Загрузка истории…';
          var st = document.createElement('style');
          st.className = 'ai-cm-loader-style';
          st.textContent = '@keyframes aiCmOverlaySpin{to{transform:rotate(360deg)}}';
          aiCmScrollOverlay.appendChild(st);
          aiCmScrollOverlay.appendChild(sp);
          aiCmScrollOverlay.appendChild(lb);
          document.body.appendChild(aiCmScrollOverlay);
          aiCmOverlaySeq++;
          debugLog('log', '[AI CM][visibility] overlay-on reason=' + reason + ' theme=' + th.name + ' convId=' + (getConvId() || '(none)'));
          aiCmWatchOverlayTheme(true); // H22: следить за сменой темы, пока оверлей поднят
        }
      } else if (aiCmScrollOverlay) {
        // v80: seq-гвард — не снимаем оверлей, если его уже пересоздал более новый прогон
        if (typeof expectSeq === 'number' && expectSeq !== aiCmOverlaySeq) return;
        if (aiCmScrollOverlay.parentNode) aiCmScrollOverlay.parentNode.removeChild(aiCmScrollOverlay);
        aiCmScrollOverlay = null;
        aiCmWatchOverlayTheme(false); // H22: наблюдатель темы больше не нужен
        debugLog('log', '[AI CM][visibility] overlay-off reason=' + reason + ' convId=' + (getConvId() || '(none)'));
      }
    } catch (e) { }
  }
  // v70-совместимость: страховка видимости теперь только снимает оверлей
  // (SPA conv-switch, pagehide, visibilitychange). Скрытия DOM больше нет — таймер не нужен.
  function forceRestoreVisibility(reason) {
    aiCmSetScrollOverlay(false, 'force-' + reason);
  }
  try {
    window.addEventListener('pagehide', function () { forceRestoreVisibility('pagehide'); });
  } catch (ePh) { }
  try {
    // v80 (O1): безусловное снятие оверлея при любом изменении видимости вкладки —
    // оверлей не должен переживать уход со страницы/блокировку экрана.
    document.addEventListener('visibilitychange', function () { forceRestoreVisibility('visibilitychange'); });
  } catch (eVc80) { }

  async function loadFullHistoryInvisibly() {
    var convId = getConvId();
    vf5OverlapSinceLoaderStart = false; // v62: vf5-overlap отсчитывается от старта лоадера
    isLowConfidenceBase = false; // v63: low-confidence отсчитывается от старта лоадера
    try {
      var sc = null;
      for (var t = 0; t < LOADER_FIND_TRIES; t++) {
        sc = findScrollContainer();
        if (sc) break;
        await sleep(LOADER_FIND_WAIT);
      }
      if (!sc) {
        debugLog('log', '[AI CM][Gemini][loader] skip reason=no-scroller convId=' + (convId || '(none)'));
        return;
      }

      debugLog('log', '[AI CM][Gemini][loader] start convId=' + convId + ' scrollH=' + sc.height());
      var prevSmooth = '';
      if (sc.mode === 'el') { try { prevSmooth = sc.el.style.scrollBehavior; sc.el.style.scrollBehavior = 'auto'; } catch (e) { } }
      var hiddenEl = null;
      var savedTop = sc.top();
      // v80 (O1): расстояние-до-низа ВЬЮПОРТА на момент ПЕРВОГО скролла (захват в
      // __applyHide, атомарно с height/client/top): префикс-догрузка истории растит
      // scrollHeight сверху, абсолютный scrollTop после неё указал бы в середину.
      // Якорь «прокрутка от низа» устойчив к дрейфу clientH при раннем hide (раскладка
      // ещё не устоялась): позиция «внизу» (0) восстанавливается ровно в 0.
      // -1 = скролла не было.
      var distBottom80 = -1;
      // v66/v67: сброс сводного состояния прогона (трекинг вовлечения скрытого скролла)
      loaderState.scrollEngaged = false;
      loaderState.hideApplied = false;
      loaderState.topReached = false;
      loaderState.startH = sc.height();
      loaderState.maxHSeen = loaderState.startH;
      loaderState.prevTopRead = -1;

      // v30.4: скрытие НЕ выставляем заранее — только по решению в цикле (__applyHide).
      // v80: DOM контейнера НЕ трогаем — непрозрачный оверлей на body (см. шапку v75/v80).
      function __applyHide() {
        if (hiddenEl || sc.mode !== 'el' || !sc.el) return;
        hiddenEl = true; // v75: маркер «оверлей применён» (скрытия DOM больше нет)
        // v80 (O1): атомарный захват позиции ДО первого скролла (прокрутка от низа вьюпорта)
        try { distBottom80 = Math.max(0, sc.height() - sc.client() - sc.top()); } catch (eD80) { distBottom80 = 0; }
        // v81 (O1 white-screen, вариант A): в этом холодном старте восстановлена лента
        // (tapeWasUsedInThisColdStart=true) — оверлей НЕ показываем: тейп уже отрисовал
        // полную историю, непрозрачный экран поверх ленты давал «белый экран».
        if (tapeWasUsedInThisColdStart === true) {
          debugLog('log', '[AI CM][visibility] overlay-suppressed reason=tape-present convId=' + (getConvId() || '(none)'));
        } else {
          aiCmSetScrollOverlay(true, 'loader');
          debugLog('log', '[AI CM][visibility] hide reason=loader-overlay h=' + (sc.height ? sc.height() : '?') + ' convId=' + (getConvId() || '(none)'));
        }
        // v66: hide-applied — доказательство вовлечения скрытого скролла
        loaderState.scrollEngaged = true;
        loaderState.hideApplied = true;
        // v30.8: сообщаем content.js — бейдж замораживается на время скрытой загрузки
        try { window.dispatchEvent(new CustomEvent('ai-cm-loader-freeze', { detail: { on: true } })); } catch (e2) { }
      }
      function __restoreLoader() {
        // v30.8: разморозка бейджа при любом выходе из лоадера (включая finally)
        try { window.dispatchEvent(new CustomEvent('ai-cm-loader-freeze', { detail: { on: false } })); } catch (eF) { }
        // v80 (O1): позиция сохраняется как «прокрутка от низа вьюпорта», захваченная в
        // __applyHide (перед первым скроллом). Для холодного открытия/F5/SPA-входа
        // (старт в низу) восстановление = ровно низ чата, независимо от дрейфа clientH;
        // если скролла не было — тоже низ (как в v79).
        var distBottomRest80 = (distBottom80 >= 0) ? distBottom80 : 0;
        function applyRestoreTop80() {
          try {
            var sn = (sc && sc.height() > 0) ? sc : findScrollContainer();
            if (sn && sn.height() > 0) sn.setTop(Math.max(0, sn.height() - sn.client() - distBottomRest80));
          } catch (eR80) { }
        }
        if (hiddenEl) {
          // v79/v80: возврат позиции ДО снятия оверлея — убирает «мгновение начала чата».
          applyRestoreTop80();
        }
        // v80 (O1-B): оверлей снимаем строго после ДВУХ rAF — кадр с восстановленной
        // позицией уже отрисован. seq-гвард: не снимаем оверлей более нового прогона.
        // Снимаем ВСЕГДА (не только при hiddenEl): оверлей мог быть pre-applied
        // (loader-restart) без hide — иначе протечка непрозрачного экрана.
        var seqAtEnd80 = aiCmOverlaySeq;
        var __overlayOff80 = function () {
          aiCmSetScrollOverlay(false, 'loader-done', seqAtEnd80);
          debugLog('log', '[AI CM][visibility] restore reason=loader-done convId=' + (getConvId() || '(none)'));
        };
        try {
          requestAnimationFrame(function () { requestAnimationFrame(__overlayOff80); });
        } catch (eRaf80) { __overlayOff80(); }
        if (sc.mode === 'el') { try { sc.el.style.scrollBehavior = prevSmooth; } catch (e) { } }
        // v30.4: возврат позиции на свеже-запрошенном скроллере; повтор через 250мс —
        // после пере-якорения списка Gemini. v80: к сохранённой позиции, не жёстко в низ.
        function kickBack() {
          applyRestoreTop80();
        }
        try {
          requestAnimationFrame(function () {
            setTimeout(function () { kickBack(); setTimeout(kickBack, 250); }, 250);
          });
        } catch (e) { kickBack(); }
      }

      try {
        var lastH = -1;
        var noGrowth = 0;
        var anyGrowth = false;
        var doneReason = 'max';
        var stallRetry = 0; // v52: ретраи скролла при неполном снимке
        var usedFallbackScroll = false; // v1.6 (D14): в прогоне был v78 fallback-real-scroll
        var notHiddenWait = 0; // v71: итераций ожидания hide (видимый скролл запрещён)
        var lastEpoch = -1;  // v53: последнее виденное поколение курсора
        var iter = 0;
        var maxScrollHSeen = sc.height(); // v1.14.2 (COLLAPSE-GUARD): пер-ран максимум scrollHeight — сброс в старте прогона
        // H9 (untrusted-top): снапшот поколения курсора на старте прогона. Если за время
        // прогона пришёл history-write с continuation-курсором (cursorEpoch вырос), значит
        // старшая история существует и есть (hadCursor=true). При floor=0 и no-growth такой
        // «вершок» на схлопнутом скроллере недостоверен (см. untrustedTopVerdict ниже).
        var cursorEpochAtRunStart = cursorEpoch;
        while (true) {
          iter++;
          // v53: любой history-write с continuation-курсором сбрасывает счётчики
          // стабилизации и столла — «новое поколение» курсора оживляет цикл.
          if (cursorEpoch !== lastEpoch) {
            lastEpoch = cursorEpoch;
            noGrowth = 0;
            stallRetry = 0;
            anyGrowth = false;
            lastH = -1;
            debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' cursor-epoch=' + lastEpoch + ' → счётчики сброшены (курсор жив) convId=' + convId);
          }
          // v30.7 / v52/v53: data-complete ТОЛЬКО при реальной полноте снимка (нет курсора
          // продолжения); при живом курсоре путь ЗАПРЕЩЁН (инвариант — только stall-retry).
          // v1.13.1: полнота подтверждена ТОЛЬКО при reachedStart=true — baseComplete от
          // тихой пагинации без начала (курсор пропал на скрытой вкладке) недостоверен.
          // v68: полнота — ТОЛЬКО по серверному курсору (старших страниц больше нет),
          // НЕ по DOM-скроллу: data-complete независимо от scrollEngaged/скрытого скроллера.
          if (historyFullByQuiet === true && reachedStart === true && !pendingCursor) {
            doneReason = 'data-complete';
            break;
          }
          // v30: SPA может заменить scroller между итерациями — старая ссылка мертва,
          // height() читается как 0. Перезапрашиваем элемент КАЖДУЮ итерацию; если
          // элемент null или scrollHeight=0 — итерация не засчитывается (lastH/noGrowth
          // не трогаем), ждём появления в рамках общего лимита итераций.
          var scNow = findScrollContainer();
          if (!scNow || !(scNow.height() > 0)) {
            debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' скроллер недоступен (null/scrollH=0) — ожидание в рамках лимита');
            await sleep(LOADER_STEP_MS);
            continue;
          }
          sc = scNow;
          // v1.14.2 (COLLAPSE-GUARD): per-run максимум scrollHeight (сброс — в старте
          // прогона, на каждой итерации max) — эталон высоты для детекта коллапса
          // скроллера: текущая высота стала значительно ниже виденного максимума.
          var __hCg0 = sc.height();
          if (__hCg0 > maxScrollHSeen) maxScrollHSeen = __hCg0;
          // v66/v67: трекинг вовлечения скрытого скролла (рост высоты / смена scrollTop)
          var __hNow0 = sc.height();
          if (__hNow0 > loaderState.maxHSeen) {
            loaderState.maxHSeen = __hNow0;
            if (!loaderState.scrollEngaged && (loaderState.maxHSeen - loaderState.startH) >= MIN_SCROLL_H_FOR_ENGAGEMENT) {
              loaderState.scrollEngaged = true;
            }
          }
          var __tNow66 = sc.top();
          if (!loaderState.scrollEngaged && (__tNow66 > 8 || (loaderState.prevTopRead !== -1 && __tNow66 !== loaderState.prevTopRead))) {
            loaderState.scrollEngaged = true; // были не у верха / scrollTop сдвинулся — скроллер реально прокручивается
          }
          loaderState.prevTopRead = __tNow66;
          // v30.7: скрытие ТОЛЬКО при h>8000 (длинный чат); короткие не прячем и не прыгаем
          // v45: И msgs>=LOADER_HIDE_MIN_MSGS — «короткие, но высокие» чаты (f47e2edd h=11893,
          // мало ходов) не прячем → нет белого мгновения при быстрой загрузке.
          // v1.6 (D16): bootstrap короткого контейнера — при старшей истории (olderHistorySeen)
          // + оракул incomplete + начало не достигнуто (reachedStart=false) скрываем/скроллим
          // НЕЗАВИСИМО от порога 8000 (оверлей уже маскирует UI). Без этого hide не включается
          // при scrollH=1140 → not-hidden-wait-cap → база неполная (80), старший сегмент остаётся
          // на сервере, oracle=incomplete, deferred as-is [LOW CONFIDENCE]_. Порог 8000 остаётся
          // для коротких чатов БЕЗ признаков старшей истории (все ходы в экране — лоадер не нужен).
          var __hNow = sc.height();
          var __msgsNow = baseSize(); // тот же источник, что кормит badge/history-write
          // v1.6 (D16): hide-bootstrap — чистая функция; короткий контейнер (h<=8000) скрываем
          // при старшей истории + oracle incomplete + начало не достигнуто (см. shouldHideScroller).
          var hideVerdict = { hide: false, bootstrapShort: false };
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
              typeof window.GeminiInterceptLogic.shouldHideScroller === 'function') {
            hideVerdict = window.GeminiInterceptLogic.shouldHideScroller({
              scrollH: __hNow,
              minHideH: LOADER_HIDE_MIN_H,
              olderHistorySeen: !!olderHistorySeen,
              reachedStart: reachedStart === true,
              oracleIncomplete: !!oracleIncompleteSeen[convId]
            });
          } else {
            hideVerdict = { hide: __hNow > LOADER_HIDE_MIN_H, bootstrapShort: false };
          }
          if (!hiddenEl && hideVerdict.hide) {
            // v1.16 (1177-BYPASS): лоадер по эскалации (nativeEscalationFor===convId) скрывает
            // и скроллит ДАЖЕ при msgs < LOADER_HIDE_MIN_MSGS — это обход 1177, тихий цикл
            // уже не может продолжать, и старшие окна доберёт только нативный скролл сайта.
            var escRun116 = !!(convId && nativeEscalationFor === convId);
            // v1.16 (OLDER-UNSTARTED): «короткая по числу ходов, но высокая» история (msgs<порог,
            // scrollH>8000) с подтверждённой старшей историей и недостигнутым началом — скрываем
            // и скроллим тоже (иначе not-hidden-wait-cap ~60с пустого ожидания, см. de4b9f5f:
            // 22 хода, h=26384, quiet-clean-end, hide-skipped few-msgs навсегда).
            var olderUnstarted116 = !!(hideVerdict.hide && olderHistorySeen === true && reachedStart !== true);
            if (__msgsNow >= LOADER_HIDE_MIN_MSGS || hideVerdict.bootstrapShort || escRun116 || olderUnstarted116) {
              __applyHide();
              debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' hide-applied h=' + __hNow + ' msgs=' + __msgsNow +
                (hideVerdict.bootstrapShort ? ' reason=bootstrap-short' : (escRun116 ? ' reason=1177-bypass' : (olderUnstarted116 ? ' reason=older-unstarted' : ''))));
            } else {
              debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' hide-skipped reason=few-msgs h=' + __hNow + ' msgs=' + __msgsNow);
            }
          }
          // v71: скролл (setTop(0) + синтетический scroll) выполняем ТОЛЬКО если контейнер
          // скрыт (hiddenEl). Видимый скролл вверх — источник дёргания/беления чата при
          // холодном открытии (hide-skipped reason=few-msgs h=14938 msgs=20): ждём, пока
          // база доберёт LOADER_HIDE_MIN_MSGS и hide применится; кап ожидания — LOADER_MAX_ITER.
          if (!hiddenEl) {
            notHiddenWait++;
            // v1.16 (CLEAN-END-UNSCROLLABLE): hide так и не применился (msgs<порога при
            // коротком контейнере, скролл видимым запрещён), но тихая пагинация завершилась
            // ЧИСТО (quietEndedClean: серверный курсор исчерпан без ошибок-страниц) и база не
            // ниже пола — догонять нечего, окно не вырастет. Завершаем прогон сразу, чтобы
            // оракул clean-end-stable подтвердил полноту на стопе, а не крутить LOADER_MAX_ITER
            // итераций «visible-scroll-skipped» (~60с пустого ожидания + [LOW CONFIDENCE]_).
            // Инвариант 3в: ТОЛЬКО при floor>0 (класс первого визита floor=0 НЕ подтверждается —
            // ранний стоп без физического верха был бы ложной полнотой на первом визите).
            var __nhClean = false;
            var __floorNh = 0;
            try {
              try { __floorNh = (loadFloor(convId) || {}).count || 0; } catch (eNhF) { }
              var __qcNh = (typeof quietEndedClean === 'undefined') ? false : (quietEndedClean === true);
              var __pcNh = (typeof pendingCursor === 'undefined') ? null : pendingCursor;
              __nhClean = __qcNh && !__pcNh && !reachedStart && __floorNh > 0 && baseSize() > 0 && baseSize() >= __floorNh;
            } catch (eNh) { __nhClean = false; }
            if (__nhClean) {
              doneReason = 'clean-end-unscrollable'; // ≠ 'top' → стабильный стоп подтвердит clean-end-stable
              debugLog('log', '[AI CM][Gemini][loader] early-stop reason=clean-end-unscrollable convId=' + convId +
                ' msgs=' + baseSize() + ' floor=' + __floorNh + ' wait=' + notHiddenWait + '/' + LOADER_MAX_ITER);
              break;
            }
            if (notHiddenWait >= LOADER_MAX_ITER) {
              doneReason = 'not-hidden-wait-cap';
              break;
            }
            debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' visible-scroll-skipped reason=not-hidden' +
              ' h=' + __hNow + ' msgs=' + __msgsNow + ' wait=' + notHiddenWait + '/' + LOADER_MAX_ITER + ' convId=' + convId);
            await sleep(LOADER_STEP_MS);
            continue;
          }
          // v75: программный скролл БЕЗ изменения CSS-видимости: в одном кадре (rAF)
          // scrollTop=0 → синтетический scroll → мгновенный возврат вниз. Пользователь
          // скачка не видит (промежуточное состояние не отрисовывается), DOM-видимость
          // контейнера не трогается — виртуализация Gemini продолжает рендерить.
          // v78: rAF-возврат в том же кадре НЕ триггерил пагинацию Gemini → лоадер доходил
          // до max, не собрав историю. Теперь rAF-режим ТОЛЬКО когда база уже полная;
          // иначе — страховочный реальный скрытый скролл (v80: БЕЗ opacity на скроллере,
          // экран закрыт непрозрачным overlay): scrollTop=0 + dispatch('scroll') + пауза —
          // старшие окна реально рендерятся, пагинация Gemini срабатывает.
          if (historyFullByQuiet === true) {
            (function (el75) {
              try {
                requestAnimationFrame(function () {
                  try { el75.scrollTop = 0; } catch (eS1) { }
                  // v4z: синтетический scroll — подталкиваем IntersectionObserver-пагинацию
                  try { el75.dispatchEvent(new Event('scroll')); } catch (eS2) { }
                  try { el75.scrollTop = el75.scrollHeight; } catch (eS3) { } // возврат вниз ДО отрисовки кадра
                });
              } catch (eRaf) { }
            })(sc.el);
            await sleep(SCROLL_PAUSE_HIDDEN_MS);
          } else {
            // v78→v80: страховочный лоадер (фолбэк после loader-restart / неполная база):
            // реальный скрытый скролл к верху. v80 (O1-A): САМ СКРОЛЛЕР НЕ СКРЫВАЕМ
            // (opacity/pointerEvents удалены — они и давали чисто-белый экран и «начало
            // чата» на unhide); экран закрыт непрозрачным overlay на body, виртуализация
            // списка продолжает рендерить старшие окна.
            usedFallbackScroll = true; // v1.6 (D14): прогон использовал страховочный скролл
            // v80: оверлей мог быть снят force-restore (visibilitychange/conv-switch) —
            // возвращаем, пока страховочный скролл активен. v81 (O1 white-screen A):
            // при восстановленной ленте оверлей НЕ поднимаем (тейп уже виден).
            if (tapeWasUsedInThisColdStart === true) {
              if (!aiCmScrollOverlay) {
                debugLog('log', '[AI CM][visibility] overlay-suppressed reason=tape-present convId=' + (getConvId() || '(none)'));
              }
            } else if (!aiCmScrollOverlay) {
              aiCmSetScrollOverlay(true, 'loader-fallback');
            }
            debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' fallback-real-scroll (база неполная, rAF-возврат не триггерит пагинацию) convId=' + convId);
            try { sc.setTop(0); } catch (eSt1) { }
            try { sc.el.dispatchEvent(new Event('scroll')); } catch (eSt2) { }
            await sleep(SCROLL_PAUSE_HIDDEN_MS);
          }
          var h = sc.height();
          if (!(h > 0)) continue; // v30.7: нулевое чтение не засчитываем
          debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' h=' + h +
            ' scrollEngaged=' + (loaderState.scrollEngaged ? '1' : '0') +
            ' hide=' + (loaderState.hideApplied ? 'applied' : 'not-applied') +
            ' latch=' + (loaderDoneMap[convId] ? 'done' : 'reset') + (loaderRetryUsedMap[convId] ? '-retry-used' : ''));
          if (lastH !== -1 && !(h > lastH + LOADER_RESUME_DELTA)) {
            noGrowth++;
            if (noGrowth >= LOADER_STABLE_NEED) {
              // v4z: контрольный перемер через 2с — две no-growth могли попасть в летящий запрос
              await sleep(LOADER_RECHECK_MS);
              // v53: за время перемера мог прийти новый history-write с курсором — сброс счётчиков
              if (cursorEpoch !== lastEpoch) {
                lastEpoch = cursorEpoch;
                noGrowth = 0;
                stallRetry = 0;
                anyGrowth = false;
                lastH = -1;
                await sleep(LOADER_STEP_MS);
                continue;
              }
              // v1.13.1: требуем reachedStart=true — baseComplete без подтверждённого
              // начала (тихая пагинация оборвалась на скрытой вкладке) недостоверен.
              // v68: полнота — ТОЛЬКО по серверному курсору, не по DOM-скроллу
              if (historyFullByQuiet === true && reachedStart === true && !pendingCursor) {
                doneReason = 'data-complete';
                break;
              }
              var hc = sc.height();
              if (hc > lastH + LOADER_RESUME_DELTA) {
                debugLog('log', '[AI CM][Gemini][loader] reason=resume h=' + lastH + '→' + hc);
                noGrowth = 0;
                lastH = hc;
                anyGrowth = true;
                continue;
              }
              // v53: ИНВАРИАНТ — пока в последнем history-ответе есть continuation-курсор,
              // ЗАПРЕЩЕНО завершаться по stable / no-growth / data-complete. Только stall-retry
              // (скролл к верху, шаг ~1с) до LOADER_STALL_CAP; исчерпание капа → done reason=timeout.
              if (pendingCursor) {
                stallRetry++;
                if (stallRetry < LOADER_STALL_CAP) {
                  debugLog('log', '[AI CM][Gemini][loader] stall-retry ' + stallRetry + '/' + LOADER_STALL_CAP +
                    ' (курсор жив — продолжаю скроллить) convId=' + convId +
                    ' pendingCursor=1 baseComplete=' + (historyFullByQuiet === true ? '1' : '0'));
                  noGrowth = 0;
                  await sleep(LOADER_STEP_MS);
                  continue;
                }
                doneReason = 'timeout';
                break;
              }
              // v65: «железное условие» физического верха. Стабильность высоты среди
              // истории (height-stable + pendingCursor=0) НЕ признак конца: старшие окна
              // истории могли ещё не отрендериться. Остановка раньше max-iter допустима
              // ТОЛЬКО при topReached (scrollTop <= 8px). Пока не наверху — продолжаем
              // скролл и сбрасываем счётчики no-growth.
              // v66: topReached доверяем ТОЛЬКО при scrollEngaged — на невовлечённом
              // скроллере scrollTop=0 тривиален (ложный «верх» на холодном старте).
              loaderState.topReached = loaderState.scrollEngaged && sc.top() <= 8;
              if (!loaderState.topReached) {
                debugLog('log', '[AI CM][Gemini][loader] v65 top-not-reached scrollTop=' + sc.top() +
                  ' (height-stable среди истории — не конец, продолжаю скролл) convId=' + convId);
                noGrowth = 0;
                lastH = -1;
                anyGrowth = false;
                await sleep(LOADER_STEP_MS);
                continue;
              }
              // v1.14.2 (COLLAPSE-GUARD): collapse ≠ top. Если Gemini схлопнул скроллер
              // во время скрытого прогона (03.09 11:35: 100933→744), scrollTop≤8px
              // тривиален — физического верха НЕТ. doneReason='top' присваиваем только
              // когда высота не коллапсировала: h < max(3000, 0.5*maxScrollHSeen)
              // при базе ниже сохранённого пола → doneReason='collapse' + перезапуск.
              var __floorCg = 0;
              try { __floorCg = (loadFloor(convId) || {}).count || 0; } catch (eCg0) { }
              var __cvCollapsed = false;
              if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                  typeof window.GeminiInterceptLogic.collapseGuardVerdict === 'function') {
                __cvCollapsed = window.GeminiInterceptLogic.collapseGuardVerdict({
                  scrollH: sc.height(),
                  maxScrollHSeen: maxScrollHSeen,
                  baseCount: baseSize(),
                  floorCount: __floorCg
                }).collapsed;
              } else {
                __cvCollapsed = (sc.height() < Math.max(3000, maxScrollHSeen * 0.5) && baseSize() < __floorCg);
              }
              if (__cvCollapsed) {
                // v1.15 (BUG «холодное открытие без полной истории»): если тихая пагинация
                // ЗАВЕРШИЛАСЬ ЧИСТО (сеть: «старших страниц больше нет», ошибки не было),
                // а скроллер схлопнут на физическом верхе — это НЕ «collapsed, ждём больше»,
                // а устаревший пол (чат ужат/укорочен на сервере с прошлой полной сборки).
                // Крутить collapse-ретраи против пола бессмысленно: окно не вырастет. Один
                // подтверждающий повтор (8с, вдруг подъедет поздний нативный fetch) — и если
                // база не выросла, подтверждаем верх как done reason=top и переписываем пол.
                // typeof-защита: collapse-guard runTopPoint исполняет фрагмент в песочнице
                // без модульных глобалов v1.15 (quietEndedClean/pendingCursor/quietActive/...).
                var __cleanEndCg = false;
                try {
                  if (typeof quietEndedClean !== 'undefined' && quietEndedClean === true) {
                    var __pcCg = (typeof pendingCursor === 'undefined') ? null : pendingCursor;
                    var __cqCg = (typeof quietActive === 'undefined') ? false : !!quietActive;
                    var __heCg = (typeof lastHnvPageError === 'undefined') ? false : !!lastHnvPageError;
                    // v1.16: чистое завершение сети само по себе не лечит «устаревший пол» на
                    // первом визите (floor=0): самоизлечение пола осмысленно только когда есть
                    // пол от прошлой полной сборки (инвариант 3в, класс первого визита).
                    var __floorOkCg = (typeof __floorCg === 'number' && __floorCg > 0);
                    if (!__pcCg && !__cqCg && !__heCg && __floorOkCg && baseSize() > 0) __cleanEndCg = true;
                  }
                } catch (eCgClean) { __cleanEndCg = false; }
                if (__cleanEndCg && collapseRetries >= 1 &&
                    typeof lastCleanEndBaseCount !== 'undefined' && baseSize() === lastCleanEndBaseCount) {
                  try {
                    if (__floorCg > baseSize() && convId && typeof parserVersion !== 'undefined' && parserVersion &&
                        typeof localStorage !== 'undefined' && typeof lastBaseTextLen !== 'undefined') {
                      // v1.16.5 (T1-fix#5): понижение пола идёт ТОЛЬКО через формальный механизм
                      // самоунижения (вердикт selfHealFloorVerdict + единственная точка записи
                      // selfHealFloor → writeSelfHealedFloor). Прямого localStorage.setItem пола
                      // здесь больше нет: подтверждающий повтор уже состоялся (collapseRetries>=1
                      // + база не изменилась), поэтому confirmations=1.
                      // typeof-защита: runTopPoint исполняет фрагмент в песочнице без модульных
                      // глобалов (selfHealFloor там не объявлен).
                      if (typeof selfHealFloor === 'function') {
                        var __shvCg = null;
                        try {
                          if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                              typeof window.GeminiInterceptLogic.selfHealFloorVerdict === 'function') {
                            __shvCg = window.GeminiInterceptLogic.selfHealFloorVerdict({
                              cleanEnd: true,
                              pendingCursor: (typeof __pcCg === 'undefined') ? null : __pcCg,
                              quietActive: (typeof __cqCg === 'undefined') ? false : __cqCg,
                              pageError: (typeof __heCg === 'undefined') ? false : __heCg,
                              loaderRunning: (typeof loaderRunningFor === 'undefined') ? false : !!loaderRunningFor,
                              archivePending: !!(typeof aiCmArchiveFor === 'function' && aiCmArchiveFor(convId) &&
                                typeof aiCmArchiveLiveProven === 'function' && !aiCmArchiveLiveProven(convId)),
                              baseCount: baseSize(),
                              floorCount: __floorCg,
                              floorLen: (loadFloor(convId) || {}).effectiveLen || 0,
                              provenLen: lastBaseTextLen,
                              reachedStart: reachedStart === true,
                              confirmations: 1
                            });
                          }
                        } catch (eShvCg) { __shvCg = null; }
                        if (__shvCg && __shvCg.lower === true) {
                          selfHealFloor(convId, __shvCg.count, __shvCg.effectiveLen, __shvCg.source);
                        }
                      }
                    }
                  } catch (eCgF) { }
                  debugLog('log', '[AI CM][Gemini][loader] clean-end top confirmed (устаревший пол самоизлечен) convId=' + convId +
                    ' msgs=' + baseSize() + ' floorWas=' + __floorCg + ' scrollH=' + sc.height() +
                    ' selfHeal=' + ((__shvCg && __shvCg.source) || 'skipped'));
                  doneReason = 'top'; // v1.15: чистый конец сети + физический верх → stable-stop оракул
                  break;
                }
                if (__cleanEndCg && collapseRetries === 0) {
                  if (typeof lastCleanEndBaseCount !== 'undefined') lastCleanEndBaseCount = baseSize();
                  debugLog('log', '[AI CM][Gemini][loader] clean-end collapse candidate convId=' + convId +
                    ' msgs=' + baseSize() + ' floor=' + __floorCg + ' — подтверждающий повтор через 8с');
                }
                doneReason = 'collapse'; // v1.14.2: НЕ 'top' — stable-stop оракул и fallback-top остаются закрытыми
                if (collapseRetries < 2) {
                  collapseRetries++;
                  debugLog('log', '[AI CM][Gemini][loader] collapse-guard: скроллер схлопнут scrollH=' + sc.height() +
                    ' maxSeen=' + maxScrollHSeen + ' msgs=' + baseSize() + ' floor=' + __floorCg +
                    ' — перезапуск лоадера через 8с retry=' + collapseRetries + '/2 convId=' + convId);
                  var __convIdAtCollapse = convId;
                  setTimeout(function () {
                    try {
                      if (getConvId() !== __convIdAtCollapse) return; // смена чата — ретрай не нужен
                      loaderDoneMap[__convIdAtCollapse] = false; // снятие латча — разрешаем перезапуск
                      maybeStartLoader();
                    } catch (eCg1) { }
                  }, 8000);
                } else {
                  if (__cleanEndCg && typeof lastCleanEndBaseCount !== 'undefined' && baseSize() === lastCleanEndBaseCount) {
                    try {
                      if (__floorCg > baseSize() && convId && typeof parserVersion !== 'undefined' && parserVersion &&
                          typeof localStorage !== 'undefined' && typeof lastBaseTextLen !== 'undefined') {
                        debugLog('log', '[AI CM][Gemini][loader] clean-end floor-write via saveFloor (H11) convId=' + convId + ' proposed=' + baseSize() + ' floorWas=' + __floorCg);
                        saveFloor(convId, baseSize(), lastBaseTextLen);
                      }
                    } catch (eCgF2) { }
                    debugLog('log', '[AI CM][Gemini][loader] clean-end top confirmed (exhausted retries) convId=' + convId +
                      ' msgs=' + baseSize() + ' floorWas=' + __floorCg);
                    doneReason = 'top';
                  } else {
                    debugLog('log', '[AI CM][Gemini][loader] collapse-guard: ретраи исчерпаны 2/2 — incomplete as-is convId=' + convId);
                  }
                }
                break;
              }
              // H9 (untrusted-top): первый визит floor=0 — collapse-guard при floor=0 молчит
              // (baseCount < 0 никогда), но тихая пагинация оборвалась и курсор в истории был
              // (hadCursor), а скроллер за прогон НЕ вырос (no-growth, схлопнутая высота).
              // Такой doneReason='top' ложный (физического верха нет). → 'collapse' тем же
              // ретрай-путём (≤2), иначе incomplete as-is (stable-stop/fallback-top закрыты).
              // typeof-защита: collapse-guard runTopPoint исполняет этот фрагмент в песочнице
              // без модульных глобалов (serverFirstHash/olderHistorySeen/cursorEpoch).
              var __hadCursorH9 = false;
              try {
                __hadCursorH9 = !!((typeof serverFirstHash !== 'undefined' && serverFirstHash) ||
                  (typeof olderHistorySeen !== 'undefined' && olderHistorySeen) ||
                  (typeof cursorEpoch !== 'undefined' && typeof cursorEpochAtRunStart !== 'undefined' &&
                   cursorEpoch !== cursorEpochAtRunStart));
              } catch (eH90) { __hadCursorH9 = false; }
              var __anyGrowthH9 = false;
              try { __anyGrowthH9 = (typeof anyGrowth !== 'undefined') ? !!anyGrowth : false; } catch (eH9g) { __anyGrowthH9 = false; }
              var __untTop = null;
              if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                  typeof window.GeminiInterceptLogic.untrustedTopVerdict === 'function') {
                __untTop = window.GeminiInterceptLogic.untrustedTopVerdict({
                  floorCount: __floorCg,
                  hadCursor: __hadCursorH9,
                  anyGrowth: __anyGrowthH9,
                  maxScrollHSeen: maxScrollHSeen,
                  viewportH: (typeof sc !== 'undefined' && sc && typeof sc.client === 'function') ? sc.client() : 0
                });
              }
              if (__untTop && __untTop.untrusted === true) {
                doneReason = 'collapse'; // H9: НЕ 'top'
                if (collapseRetries < 2) {
                  collapseRetries++;
                  debugLog('log', '[AI CM][Gemini][loader] untrusted-top ' + (__untTop.reason || '') +
                    ' scrollH=' + (sc && sc.height ? sc.height() : '?') + ' maxSeen=' + maxScrollHSeen + ' msgs=' + baseSize() +
                    ' floor=' + __floorCg + ' hadCursor=' + (__hadCursorH9 ? '1' : '0') +
                    ' — перезапуск лоадера через 8с retry=' + collapseRetries + '/2 convId=' + convId);
                  var __convIdAtUntrust = convId;
                  setTimeout(function () {
                    try {
                      if (getConvId() !== __convIdAtUntrust) return; // смена чата — ретрай не нужен
                      loaderDoneMap[__convIdAtUntrust] = false; // снятие латча — разрешаем перезапуск
                      maybeStartLoader();
                    } catch (eH91) { }
                  }, 8000);
                } else {
                  debugLog('log', '[AI CM][Gemini][loader] untrusted-top: ретраи исчерпаны 2/2 — incomplete as-is convId=' + convId);
                }
                break;
              }
              doneReason = 'top'; // v78: физический верх подтверждён (topReached+scrollEngaged) — единственный done-reason, который взводит stable-stop оракул
              break;
            }
          } else {
            noGrowth = 0;
            if (lastH !== -1) anyGrowth = true;
          }
          lastH = h;
          // v53: лимит итераций НЕ прерывает активный курсор-скролл на холодном старте —
          // иначе лоадер стопнулся бы раньше, чем сервер отдал полный снапшот.
          if (iter >= LOADER_MAX_ITER && !pendingCursor) {
            doneReason = 'max';
            break;
          }
        }
        // v68: полнота определяется ТОЛЬКО серверной пагинацией (paginateLoop по курсору);
        // DOM-скролл больше НЕ взводит и НЕ сбрасывает baseComplete/reachedStart.
        lastLoaderDoneReason = doneReason; // v78: гейт stable-stop оракула
        // v1.6 (D14): SPA-вход в известный чат — страховочный v78-скролл дошёл до верха
        // (topReached при empty*3). Выставляем состояния, которые stableCheck74 ждёт от
        // main-loader done reason=top: reachedStart=true; historyFullByQuiet=true при
        // base>=floor; диспатч ai-cm-loader-state с baseComplete=true — deferred-экспорт
        // (content.js) не висит бесконечно, латч автоэкспорта стреляет один раз.
        // v1.6 (D15): гейт — baseComplete через fallback-top ТОЛЬКО при pendingCursor==null
        // И лоадер не в итерациях (loaderRunningFor===null) И база стабильна ≥5с.
        // Иначе ждём: повторная проверка через 5с. fired не может произойти, пока
        // лоадер продолжает итерации (вторая проходка догружает историю до 124).
        if (doneReason === 'top' && usedFallbackScroll) { // v1.14.2: 'collapse' сюда не попадает — fallback-top объявляет полноту только при настоящем верхе
          function applyFallbackComplete() {
            try {
              var baseNowD14 = baseSize();
              var floorD14b = loadFloor(convId);
              var floorCountD14b = (floorD14b && floorD14b.count) || 0;
              // v1.6 (D15-C): гейт below-floor применяется и к done=top фолбэка —
              // base < сохранённого пола НЕ даёт loader-stable-stop (ложный верх).
              if (baseNowD14 < floorCountD14b) {
                debugLog('log', '[AI CM][completeness] fallback-top skip reason=below-floor convId=' + convId +
                  ' msgs=' + baseNowD14 + ' floor=' + floorCountD14b);
                return;
              }
              // v1.14.1 (FB-PROBE): base>=floor — круговая проверка (floor мог быть сохранён
              // из такой же ложной полноты), поэтому fallback-top объявляет полноту ТОЛЬКО
              // после серверного подтверждения (v73-probe: 0 новых старших ходов, курсор
              // исчерпан). Без метаданных сети/курсора полнота НЕ объявляется — экспорт
              // не стреляет по усечённой базе; состояние бейджа не трогаем (v78-пол
              // по-прежнему защищает от просадки).
              var fbHash = '';
              try { fbHash = aiCmDiagTurnEdge(aiCmOrderedTurns(), 'first').hash; } catch (eFbH) { }
              var fbWideCur = null;
              try { fbWideCur = extractCursorWide(lastPaginateOuter); } catch (eFbC) { }
              // H9b (retain-last-good): живой wide-курсор пуст (оборванный шаг перезаписал
              // lastPaginateOuter) → retained last-good того же convId (вход probe, не complete).
              if (!fbWideCur && lastGoodWideCur && lastGoodWideCur.conv &&
                  lastGoodWideCur.conv === (getConvId() || '')) {
                fbWideCur = lastGoodWideCur.cur;
                debugLog('log', '[AI CM][completeness] retained-wide-cur fed reason=fallback-top' +
                  ' convId=' + (getConvId() || '(none)') + ' msgs=' + baseNowD14);
              }
              var fbMeta = { atEncoded: lastAtEncoded, baseUrl: lastBaseUrl, headers: lastHeaders };
              // H9b: живой слот метаданных пуст — добираем из retained (same-convId); гарды
              // isStaleReqTag по ответу probe остаются — чужой conv ответ не примет.
              if ((!fbMeta.atEncoded || !fbMeta.baseUrl || !fbMeta.headers) &&
                  lastGoodProbeMeta && lastGoodProbeMeta.conv &&
                  lastGoodProbeMeta.conv === (getConvId() || '')) {
                if (!fbMeta.atEncoded) fbMeta.atEncoded = lastGoodProbeMeta.atEncoded;
                if (!fbMeta.baseUrl) fbMeta.baseUrl = lastGoodProbeMeta.baseUrl;
                if (!fbMeta.headers) fbMeta.headers = lastGoodProbeMeta.headers;
                debugLog('log', '[AI CM][completeness] retained-meta fed reason=fallback-top' +
                  ' convId=' + (getConvId() || '(none)') + ' msgs=' + baseNowD14);
              }
              var fbProbeReady = true;
              if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.fallbackProbeReady) {
                fbProbeReady = window.GeminiInterceptLogic.fallbackProbeReady(fbMeta, fbWideCur);
              } else {
                fbProbeReady = Boolean(fbMeta.atEncoded && fbMeta.baseUrl && fbMeta.headers && fbWideCur);
              }
              if (!fbProbeReady) {
                debugLog('log', '[AI CM][completeness] fallback-top wait reason=probe-unavailable' +
                  ' meta=' + ((lastAtEncoded && lastBaseUrl && lastHeaders) ? 'yes' : 'no') +
                  ' wideCursor=' + (fbWideCur ? 'yes' : 'no') +
                  ' convId=' + convId + ' msgs=' + baseNowD14 + ' floor=' + floorCountD14b);
                return;
              }
              debugLog('log', '[AI CM][completeness] fallback-top probe-start' +
                ' convId=' + convId + ' msgs=' + baseNowD14 + ' floor=' + floorCountD14b);
              runCompletenessProbe(fbHash, fbWideCur, { onTerminal: function () {
                try { delete oracleIncompleteSeen[convId]; } catch (eFbO) { }
                try {
                  window.dispatchEvent(new CustomEvent('ai-cm-loader-state', { detail: {
                    convId: convId,
                    running: false,
                    pendingCursor: false,
                    baseComplete: true,
                    reachedStart: true
                  } }));
                } catch (eFbD) { }
              } });
            } catch (eD14x) { }
          }
          function fallbackStableNow() {
            var nowD15 = Date.now();
            if (pendingCursor) return false; // живой pag-курсор — история ещё не вся
            if (loaderRunningFor) return false; // активный прогон лоадера — не в итерациях нельзя судить
            if (lastBaseCountChangeAt && (nowD15 - lastBaseCountChangeAt) < 5000) return false; // база менялась <5с
            if (lastOlderNonPagAddAt && (nowD15 - lastOlderNonPagAddAt) < 5000) return false;
            return true;
          }
          try {
            if (fallbackStableNow()) {
              applyFallbackComplete();
            } else {
              debugLog('log', '[AI CM][completeness] fallback-top wait reason=' +
                (pendingCursor ? 'pending-cursor' : (loaderRunningFor ? 'loader-running' : 'base-unstable')) +
                ' convId=' + convId + ' msgs=' + baseSize());
              setTimeout(function () {
                try {
                  if (getConvId() !== convId) return;
                  if (!fallbackStableNow()) return; // всё ещё ждём — stableCheck74/повторы решат
                  applyFallbackComplete();
                } catch (eD15t) { }
              }, 5000);
            }
          } catch (eD14y) { }
        }
        debugLog('log', '[AI CM][Gemini][loader] done reason=' + doneReason +
          ' scrollH=' + sc.height() + ' convId=' + convId +
          ' baseComplete=' + (historyFullByQuiet === true ? '1' : '0') +
          ' pendingCursor=' + (pendingCursor ? '1' : '0') +
          ' msgs=' + baseSize() +
          ' scrollEngaged=' + (loaderState.scrollEngaged ? '1' : '0') +
          ' latch=' + (loaderDoneMap[getConvId() || convId] ? 'done' : 'reset') +
          (loaderRetryUsedMap[getConvId() || convId] ? '-retry-used' : ''));
      } finally {
        __restoreLoader();
      }
    } catch (e) {
      console.error('[AI CM][Gemini][loader] ошибка лоадера:', e);
    }
  }

  // Точка автозапуска: каждое открытие чата (холодный F5 и SPA-переход на /app/<id>),
  // после появления скроллера. Один раз на convId за сессию; холодное открытие
  // (флага в loaderDoneMap нет) — всегда.
  // v30.6: единственные читаемые флаги полноты — cacheRestoredMap[convId] (принята кэш-лента)
  // и historyFullByQuiet (сеть дала полную историю): при них лоадер пропускается целиком.
  // v46: ожидание сигнала «старшая история» до решения о старте.
  var LOADER_SIGNAL_WAIT_TRIES = 20; // v46: до 20 попыток по 1с — дождаться первого history-RPC
  var LOADER_SIGNAL_WAIT_MS = 1000;
  function maybeStartLoader() {
    var tries = 0;
    function tick() {
      var convId = getConvId();
      if (!convId) {
        if (++tries < 10) { setTimeout(tick, 1000); }
        return;
      }
      if (loaderDoneMap[convId]) {
        debugLog('log', '[AI CM][Gemini][loader] skip reason=already-done convId=' + convId +
          (loaderRetryUsedMap[convId] ? ' retry-used=1' : ' retry-used=0')); // v66: состояние латча
        return;
      }
      // v1.14.2 (COLLAPSE-GUARD): база добрала сохранённый пол — бюджет коллапс-ретраев больше не нужен
      var __floorMs = 0;
      try { __floorMs = (loadFloor(convId) || {}).count || 0; } catch (eCg2) { }
      if (baseSize() >= __floorMs) collapseRetries = 0;
      // v30.6: история уже полная — лоадер не нужен (иначе прячет скроллер на 8–10с).
      // v1.6 (D15): при oracle=incomplete (восстановленная лента + неполная сеть) обходим
      // cache-complete РОВНО ОДИН раз на вход — страховочный v78-скролл доведёт базу до
      // done=top+base>=floor → baseComplete=true (D14-fallback) → авто-fired без [LOW CONFIDENCE]_.
      if (cacheRestoredMap.has(convId)) {
        var bypassD15 = false;
        if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
            typeof window.GeminiInterceptLogic.shouldBypassCacheComplete === 'function') {
          bypassD15 = window.GeminiInterceptLogic.shouldBypassCacheComplete(oracleIncompleteSeen, oracleRerunUsedMap, convId);
        }
        if (bypassD15) {
          try { delete oracleIncompleteSeen[convId]; } catch (eB1) { } // флаг снят — повторных обходов нет
          try { oracleRerunUsedMap[convId] = true; } catch (eB2) { }   // маркер «один ре-ран использован»
          debugLog('log', '[AI CM][Gemini][loader] cache-complete bypass reason=oracle-incomplete convId=' + convId);
          // продолжаем к запуску лоадера ниже (не return)
        } else {
          loaderDoneMap[convId] = true;
          debugLog('log', '[AI CM][Gemini][loader] skip reason=cache-complete convId=' + convId);
          return;
        }
      }
      // v52: skip data-complete только при реальной полноте (курсора продолжения нет) —
      // иначе лоадер должен доскроллить историю (холодный открытие, частичный снимок).
      // v1.13.1: требуется reachedStart=true — baseComplete без начала недостоверен
      // (тихая пагинация могла оборваться при блокировке экрана).
      if (historyFullByQuiet === true && reachedStart === true && !pendingCursor) {
        loaderDoneMap[convId] = true;
        debugLog('log', '[AI CM][Gemini][loader] skip reason=data-complete convId=' + convId);
        return;
      }
      // v46: ждём первый распарсенный history-RPC (сигнал «есть старшая история»),
      // чтобы не решить преждевременно — ответ мог ещё не прийти.
      // T1-fix#2 (v1.16.2): «база непустая» ≠ «живой RPC распарсен» — архив вливает свои
      // ходы в ту же базу ДО прихода живого снапшота. Ждём сигнал по ЖИВЫМ ходам
      // (для чата без архива aiCmLiveTurnCount() === baseSize() — прежнее поведение).
      var liveMsgs = aiCmLiveTurnCount();
      if (!olderHistorySeen && liveMsgs === 0) {
        if (++tries < LOADER_SIGNAL_WAIT_TRIES) {
          // cold-debug: редкие отметки ожидания первого history-RPC (старт мог опередить сеть)
          if (tries === 1 || tries === 10 || tries === 19) {
            debugLog('log', '[AI CM][cold-debug] loader-wait-signal convId=' + convId +
              ' msgs=' + baseSize() + ' liveMsgs=' + liveMsgs + ' olderHistorySeen=0 try=' + tries + '/' + LOADER_SIGNAL_WAIT_TRIES +
              ' loaderRunning=' + (loaderRunningFor || 'none'));
          }
          setTimeout(tick, LOADER_SIGNAL_WAIT_MS); return;
        }
      }
      // v46: курсора продолжения в начальном ответе нет → старшей истории нет,
      // догружать нечего. Скроллинг лоадера на коротких чатах белил экран (f47e2edd).
      // v1.6 (D15): при единственном ре-ране (oracle-incomplete bypass) гейт пропускается.
      if (!olderHistorySeen && !oracleRerunUsedMap[convId]) {
        if (aiCmArchiveFor(convId) && liveMsgs === 0) {
          // T1-fix#2 (v1.16.2): «нет старшей истории» здесь выведено из НЕПУСТОЙ базы, а база
          // непуста ТОЛЬКО вкладом архива (живой RPC ещё не распарсен) — решение недостоверно.
          // Латч done НЕ ставим: ниже запускаем лоадер, чтобы догрузить живой ярус.
          debugLog('log', '[AI CM][Gemini][loader] no-older-history отложен: база = только архив convId=' + convId +
            ' msgs=' + baseSize() + ' liveMsgs=0');
        } else {
          loaderDoneMap[convId] = true;
          debugLog('log', '[AI CM][Gemini][loader] loader-skipped reason=no-older-history convId=' + convId + ' msgs=' + baseSize());
          return;
        }
      }
      if (loaderRunningFor === convId) return;
      // cold-debug: фактический старт прогона лоадера — решение и состояние на этот момент
      try {
        debugLog('log', '[AI CM][cold-debug] loader-run-start convId=' + convId +
          ' msgs=' + baseSize() +
          ' olderHistorySeen=' + (olderHistorySeen ? '1' : '0') +
          ' historyFullByQuiet=' + (historyFullByQuiet ? '1' : '0') +
          ' reachedStart=' + (reachedStart ? '1' : '0') +
          ' pendingCursor=' + (pendingCursor ? '1' : '0') +
          ' cacheRestored=' + (cacheRestoredMap.has(convId) ? '1' : '0') +
          ' floor=' + __floorMs + ' tries=' + tries);
      } catch (eRs) { }
      loaderDoneMap[convId] = true;
      loaderRunningFor = convId;
      notifyLoaderState(convId, true); // v42: наружу «лоадер бежит по convId»
      loadFullHistoryInvisibly().then(function () {
        if (loaderRunningFor === convId) loaderRunningFor = null;
        notifyLoaderState(convId, false); // v42: наружу «лоадер остановлен» — триггер re-check экспорта
      }).catch(function (e) {
        // v43: reject внешнего промиса — финализируем флаг, чтобы не завис «бегущий» лоадер;
        // внутренние ошибки лоадер уже залогировал сам — тихо и без дублей.
        if (loaderRunningFor === convId) loaderRunningFor = null;
        notifyLoaderState(convId, false);
        try { debugLog('log', '[AI CM][Gemini][loader] promise rejected convId=' + convId + ' err=' + (e && e.message || e)); } catch (eL) { }
      });
    }
    tick();
  }

  // v1.13.1: возврат видимости вкладки (Win+L → разблокировка). Если база была помечена
  // полной без подтверждённого начала (reachedStart=false) ИЛИ последний цикл
  // пагинации/лоадера завершился во время hidden — сбрасываем доверие к baseComplete
  // и перезапускаем тихую пагинацию/лоадер, чтобы докрутить остаток до реального начала.
  document.addEventListener('visibilitychange', function () {
    try {
      if (document.visibilityState !== 'visible') return;
      var convIdVis = getConvId();
      if (!convIdVis) return;
      var distrust = (historyFullByQuiet === true && reachedStart !== true) ||
        quietIncompleteNoStart || lastCycleEndedHidden;
      if (!distrust) return;
      historyFullByQuiet = false;      // сброс доверия к baseComplete
      quietIncompleteNoStart = false;
      lastCycleEndedHidden = false;
      quietDecisionMade = false;       // разрешаем повторное решение о старте тихого цикла
      delete loaderDoneMap[convIdVis]; // лоадер обязан перезапуститься
      console.log('[AI CM][loader] resume-on-visible convId=' + convIdVis +
        ' msgs=' + baseSize() + ' pendingCursor=' + (pendingCursor ? '1' : '0'));
      if (!quietActive) {
        if (pendingCursor) {
          quietActive = true;
          quietDecisionMade = true;
          paginateLoop(pendingCursor, 0);
        } else {
          maybeStartLoader();
        }
      }
    } catch (eVis) {
      try { console.error('[AI CM][loader] resume-on-visible error:', eVis); } catch (e2) { }
    }
  });

  // Ручной запуск из консоли — тот же код, что и автозапуск.
  try { window.__aiCmGeminiLoadFullHistory = loadFullHistoryInvisibly; } catch (e) { }

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
          ' convId=' + (getConvId() || '(none)'));
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
    // v68: сервер-авторитетный прогон — счётчики страницы/времени живут в paginationRun
    // (сброс при смене чата). Потолок ≤ 25 страниц ИЛИ 60с — при достижении база НЕполная + warn.
    if (depth === 0) {
      paginationRun.pageCount = 0;
      paginationRun.startTs = Date.now();
      lastPagStepBroken = false; // H9: новый прогон тихой пагинации — сброс флага «последний шаг сломан»
      pagErrorRetries = 0; // v1.15: новый прогон — новый бюджет ретраев окна после ошибки-страницы
      quietEndedClean = false; // v1.15: чистый конец определяется по шагам ЭТОГО прогона
      quietErrStreak = 0; // v1.16 (1177-PACE): новый прогон — серия ошибок-страниц с нуля
    }
    // v1.15: convId на момент отправки шага (смена чата отменяет отложенный ретрай окна)
    var __pagLoopConv = getConvId();
    paginationRun.pageCount++;
    lastHeadToken = token; // v69: токен текущей страницы — по завершении цикла это голова
    if (!lastAtEncoded || !lastBaseUrl || !lastHeaders) { finishQuiet(false, 'no-meta'); return; }
    // v59: тег шага пагинации на момент отправки — устаревший шаг прекращает цикл
    var reqTagPag = captureReqTag();
    var headers = {};
    for (var k in lastHeaders) headers[k] = lastHeaders[k];
    originalFetch(buildActiveUrl(), {
      method: 'POST',
      headers: headers,
      body: buildActiveBodyWith(token),
      credentials: 'include'
    })
      .then(function (resp) {
        if (!resp || !resp.ok) { finishQuiet(false, 'status' + (resp ? resp.status : 'none')); return null; }
        return resp.text();
      })
      .then(function (txt) {
        if (!txt) return;
        // v59: страница, уходившая для старого чата — тихо прекращаем цикл
        // (не ингестируем, не трогаем reachedStart/historyFullByQuiet нового чата)
        if (isStaleReqTag(reqTagPag, 'pag')) return;
        var added = ingest(txt, { emitOnlyIfAdded: true, fromActivePaginate: true });
        if (added > 0) quietPaginated = true;
        var next = pendingCursor;
        var totalNow = baseSize();
        // v1.16 (1177-PACE): серия ошибок-страниц копится (снижает темп продолжения);
        // успешная страница (добавила ходы или принесла курсор) сбрасывает серию.
        if (lastHnvPageError === true) quietErrStreak++;
        else if (added > 0 || next) quietErrStreak = 0;
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
        // v1.15 (BUG «холодное открытие без полной истории»): убран опасный fbb-фолбэк —
        // «курсор» из ПЕРВОГО вхождения fbb-строки в сыром тексте. fbb-строки здесь — это
        // ПРЕФИКСЫ ID ходов (см. isIdLike), а не континуационный курсор: подстановка такого
        // токена в запрос окна стабильно возвращает ошибку Bard (1177) вместо следующей
        // страницы → тихая пагинация обрывалась, лоадер уходил в collapse и база оставалась
        // неполной. Продолжаем цикл ТОЛЬКО по настоящему opaque-курсору (extractCursor);
        // его отсутствие — честный сигнал «старших страниц в этом ответе больше нет».
        // H9 (last-step-broken): на каждом шаге тихого цикла отмечаем, сломан ли он —
        // added=0, курсора нет, страница не распарсилась (скелет) ИЛИ opaque-кандидатов 0.
        // При added>0 или живом курсоре pagStepBroken вернёт false (сброс флага). Флаг гейтит
        // scroll-top-proof (a): serverFirstHash последней «живой» страницы при оборванном
        // финальном шаге циркулярен и не является независимым подтверждением полноты.
        {
          var __candsH9 = 0;
          if (lastPaginateOpaqueCandidates && Array.isArray(lastPaginateOpaqueCandidates.cands)) {
            __candsH9 = lastPaginateOpaqueCandidates.cands.length;
          }
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
              typeof window.GeminiInterceptLogic.pagStepBroken === 'function') {
            lastPagStepBroken = window.GeminiInterceptLogic.pagStepBroken({
              added: added,
              nextCursor: !!next,
              failedSkeleton: lastFailedSkeleton,
              opaqueCandidates: __candsH9
            });
          } else {
            lastPagStepBroken = (added === 0 && !next && (lastFailedSkeleton || __candsH9 === 0));
          }
        }
        // H9b (retain-last-good): фиксация retained ТОЛЬКО на здоровом шаге тихой пагинации
        // (шаг не сломан И (added>0 ИЛИ живой курсор)); probe-парсы ('pb'/'sh'/'wd') этот блок
        // не проходят — он живёт в шагах цикла src='pag'. Сломанный финальный шаг (added=0,
        // курсора нет) сюда не попадает → lastPaginateOuter, перезаписанный битой/терминальной
        // страницей, НЕ трогает retained: wide-курсор и метаданные последнего здорового шага
        // остаются входом для контрольного probe (монотонное правило updateProbeMetaRetain:
        // stepOk=false → keep prev; stepOk=true → replace; мусор не принимается).
        if (!lastPagStepBroken && (added > 0 || next)) {
          try {
            var rCurH9b = null;
            try { rCurH9b = extractCursorWide(lastPaginateOuter); } catch (eRcH9b) { rCurH9b = null; }
            // H9b: wide-экстракция (rest + inner-turns, H13) может не найти кандидата
            // (битый/терминальный outer) — берём «живой» курсор шага: next
            // (continuation ЭТОГО шага) либо, на финальном здоровом шаге, токен запроса
            // lastHeadToken (курсор, который привёл к голове). Оба — настоящие
            // opaque-токены цепочки (не fbb-префиксы). Монотонно:
            // retained двигается только ВПЕРЁД по здоровым шагам (см. гейт выше).
            if (!rCurH9b && next) rCurH9b = next;
            if (!rCurH9b && lastHeadToken) rCurH9b = lastHeadToken;
            if (rCurH9b) lastGoodWideCur = { conv: __pagLoopConv || '', cur: rCurH9b, ts: Date.now() };
          } catch (eRwH9b) { }
          try {
            if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                typeof window.GeminiInterceptLogic.updateProbeMetaRetain === 'function') {
              var rMetaH9b = { conv: __pagLoopConv || '', atEncoded: lastAtEncoded, baseUrl: lastBaseUrl, headers: lastHeaders };
              var rUpdH9b = window.GeminiInterceptLogic.updateProbeMetaRetain(lastGoodProbeMeta, rMetaH9b, true);
              if (rUpdH9b) lastGoodProbeMeta = rUpdH9b;
            }
          } catch (eRmH9b) { }
        }
        // v1.15 (BUG «холодное открытие без полной истории»): страница вернула ОШИБКУ Bard
        // (inner не строка / BardErrorInfo, см. isBardErrorPage) — это НЕ конец истории.
        // Курсор прошлого окна (token) жив: повторяем запрос того же окна с растущей паузой,
        // не гася тихий цикл и не роняя reachedStart/historyFullByQuiet в неполноту.
        var __errRetry = null;
        try {
          var __errPage1177 = (lastHnvPageError === true);
          if (__errPage1177 && added === 0 && !next) {
            if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                typeof window.GeminiInterceptLogic.paginateErrorRetryDecision === 'function') {
              __errRetry = window.GeminiInterceptLogic.paginateErrorRetryDecision({
                errPage: __errPage1177, hasCursor: !!next, added: added, retries: pagErrorRetries
              });
            } else {
              __errRetry = (pagErrorRetries < PAGINATE_ERROR_RETRY_CAP)
                ? { retry: true, backoffMs: PAGINATE_ERROR_BACKOFF_MS * (pagErrorRetries + 1) }
                : { retry: false };
            }
          }
        } catch (eEr1177) { __errRetry = null; }
        if (__errRetry && __errRetry.retry === true) {
          pagErrorRetries++;
          var __retryDelay = (typeof __errRetry.backoffMs === 'number' && __errRetry.backoffMs > 0)
            ? __errRetry.backoffMs : PAGINATE_ERROR_BACKOFF_MS;
          debugLog('log', '[AI CM][cold-debug] pag-error-retry окно повторяется depth=' + depth +
            ' retry=' + pagErrorRetries + '/' + PAGINATE_ERROR_RETRY_CAP +
            ' backoff=' + __retryDelay + 'ms msgs=' + totalNow +
            ' convId=' + (getConvId() || '(none)') +
            ' token=' + (typeof token === 'string' ? token.slice(0, 8) + '…' + token.slice(-8) : '?'));
          setTimeout(function () {
            try {
              if (getConvId() !== __pagLoopConv) return;   // чат сменился — отложенный ретрай не нужен
              if (!quietActive || historyFullByQuiet === true) return; // цикл остановлен/полнота уже есть
              paginateLoop(token, depth + 1);
            } catch (eErT) { }
          }, __retryDelay);
          return;
        }
        // v1.16 (1177-BYPASS): ретраи окна исчерпаны, а страница всё ещё ошибка Bard (1177) —
        // продолжать цепочку тем же токеном бессмысленно, «старших страниц больше нет» тоже
        // объявлять НЕЛЬЗЯ (курсор прошлого окна жив, сервер просто не отдаёт глубокое окно
        // этому запросу). Эскалируем на НАТИВНЫЙ скрытый скролл (loadFullHistoryInvisibly):
        // сам сайт Gemini запросит старшие окна своими континуационными токенами и в своём
        // темпе (scrollTop=0 + синтетический scroll под оверлеем), их ответы (src=passive)
        // сливаются в базу. Один раз на чат (nativeEscalationUsedMap) — вечного цикла нет.
        var __esc1177 = null;
        try {
          var __escPage1177 = (lastHnvPageError === true);
          if (__escPage1177 && added === 0 && !next &&
              typeof window !== 'undefined' && window.GeminiInterceptLogic &&
              typeof window.GeminiInterceptLogic.paginateErrorEscalation === 'function') {
            __esc1177 = window.GeminiInterceptLogic.paginateErrorEscalation({
              errPage: __escPage1177,
              hasCursor: !!next,
              added: added,
              retries: pagErrorRetries,
              cap: PAGINATE_ERROR_RETRY_CAP,
              loaderRunning: !!(loaderRunningFor && loaderRunningFor === (getConvId() || '')),
              nativeEscalationUsed: !!(getConvId() && nativeEscalationUsedMap[getConvId()])
            });
          }
        } catch (eEsc1177) { __esc1177 = null; }
        if (__esc1177 && __esc1177.escalate === true) {
          var __escConv = getConvId();
          quietActive = false; // тихий цикл сворачиваем — дальше рулит лоадер (нативный скролл)
          try { quietIncompleteNoStart = false; } catch (eEscQ) { }
          try { nativeEscalationUsedMap[__escConv] = true; } catch (eEscM) { }
          try { nativeEscalationFor = __escConv; } catch (eEscF) { }
          debugLog('log', '[AI CM][1177-bypass] escalate-native-scroll reason=' + (__esc1177.reason || 'err1177') +
            ' convId=' + (__escConv || '(none)') + ' msgs=' + totalNow +
            ' errRetries=' + pagErrorRetries + '/' + PAGINATE_ERROR_RETRY_CAP +
            ' — старшие окна доберёт нативный скролл сайта (обход 1177)');
          // лоадер обязан перезапуститься, минуя латчи already-done / cache-complete
          try { delete loaderDoneMap[__escConv]; } catch (eEscL) { }
          try { oracleIncompleteSeen[__escConv] = true; } catch (eEscO) { }
          try { maybeStartLoader(); } catch (eEscS) { }
          return;
        }
        // v68: сервер-авторитетное решение о следующем шаге. Полнота — ТОЛЬКО по курсору
        // («старших страниц больше нет»), НЕ по DOM-росту; потолок ≤ 25 страниц ИЛИ 60с.
        var step;
        if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.paginateStepDecision) {
          step = window.GeminiInterceptLogic.paginateStepDecision({
            hasCursor: !!next,
            pages: paginationRun.pageCount,
            elapsedMs: paginationRun.startTs ? (Date.now() - paginationRun.startTs) : 0,
            added: added,
            failedSkeleton: lastFailedSkeleton
          }, { pageCap: PAGINATE_CAP, timeCapMs: PAGINATE_TIME_CAP_MS });
        } else {
          var fbRs = added > 0;
          step = {
            action: next ? 'continue' : 'complete',
            reason: next ? 'cursor-alive' : (fbRs ? 'end' : 'no-start'),
            reachedStart: fbRs,
            baseComplete: fbRs,
            warn: ''
          };
        }
        // v1.15: фиксируем «чистый конец» — завершающий шаг БЕЗ ошибки-страницы (курсора нет)
        // И НЕ оборванный: lastPagStepBroken===false (H9). Сломанный финальный шаг (added=0 +
        // скелет/0 opaque-кандидатов) не даёт права считать сеть «честно закончившейся», поэтому
        // quietEndedClean=true требует необорванного финального шага (инвариант 3а).
        // Позже лоадер на физическом верхе при схлопнутом скроллере сможет подтвердить полноту
        // даже при base < устаревшего пола (чат ужат на сервере), не крутя collapse-ретраи вечно.
        if (step.action === 'complete') {
          quietEndedClean = (lastHnvPageError === false) && lastPagStepBroken !== true;
          if (quietEndedClean) {
            debugLog('log', '[AI CM][cold-debug] quiet-clean-end convId=' + (getConvId() || '(none)') +
              ' msgs=' + totalNow + ' src=' + (lastCursorSource || 'none') + ' added=' + added);
          }
        } else if (step.action === 'cap') {
          quietEndedClean = false;
        }
        if (step.action === 'continue') {
          // v1.16 (1177-PACE): после серии ошибок-страниц (троттлинг старых окон) между
          // продолжениями цепочки — пауза; в штатном режиме (quietErrStreak=0) паузы нет,
          // поведение рабочей цепочки не меняется.
          var __paceMs1177 = 0;
          try {
            if (quietErrStreak > 0 && typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                typeof window.GeminiInterceptLogic.paginatePaceDelayMs === 'function') {
              __paceMs1177 = window.GeminiInterceptLogic.paginatePaceDelayMs(depth, true);
            }
          } catch (ePace1177) { __paceMs1177 = 0; }
          if (__paceMs1177 > 0) {
            var __paceConv1177 = getConvId();
            debugLog('log', '[AI CM][1177-bypass] pace-window ms=' + __paceMs1177 +
              ' errStreak=' + quietErrStreak + ' depth=' + depth + ' convId=' + (__paceConv1177 || '(none)'));
            setTimeout(function () {
              try {
                if (getConvId() !== __paceConv1177) return; // чат сменился — шаг не нужен
                if (!quietActive || historyFullByQuiet === true) return;
                paginateLoop(next, depth + 1);
              } catch (ePaceT) { }
            }, __paceMs1177);
          } else {
            paginateLoop(next, depth + 1);
          }
          return;
        }
        if (step.action === 'cap') {
          console.warn('[AI CM][paginate] ' + (step.warn || ('потолок достигнут reason=' + step.reason)) +
            ' pages=' + paginationRun.pageCount +
            ' elapsed=' + (paginationRun.startTs ? (Date.now() - paginationRun.startTs) : 0) + 'ms' +
            ' msgs=' + totalNow + ' курсор=' + (next ? '1' : '0'));
          finishQuiet(false, step.reason);
          return;
        }
        // action === 'complete': решение принимает НЕЦИРКУЛЯРНЫЙ оракул полноты (v73).
        // Гейт (предварительный): serverFirstHash установлен И dbFirstHash !== serverFirstHash
        //   → гарантированно incomplete (reason=circular-mismatch). Совпадение само по себе
        //   НЕ источник complete (голова базы и есть страница, с которой сверяем — циркулярно).
        // Источники complete — ТОЛЬКО независимые (серверно-авторитетные):
        //   (b) probe: запрос с курсором широкой экстракции (rest + inner-turns
        //       outer[0][2]→turns[1], H13; потолок 2000 вместо 600): 0 новых старших
        //       ходов и курсора нет → complete.
        // Иначе: historyFullByQuiet=false, reachedStart=false → лоадер-фолбэк (maybeStartLoader),
        // полноту выставляет лоадер. step.reachedStart (added>0/protobuf) — только диагностика.
        var dbFirstHash = aiCmDiagTurnEdge(aiCmOrderedTurns(), 'first').hash;
        var retriesC73 = completenessWatchdogRetries[getConvId()] || 0;
        reachedStartByScroll = false; // v61diag: reachedStart от независимых источников, не от скролла-эвристики
        debugLog('log', '[gemini-paginate] шаг ' + depth + ': +ходов=' + added + ' всего=' + totalNow + ', курсора нет → нециркулярный оракул (v73) src=' +
          (lastCursorSource || 'none') + ' olderHistorySeen=' + (olderHistorySeen ? '1' : '0'));
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
        // v72diag: ОДИН теневой probe — курсор мог жить в rest оборвавшего шага (вне turns).
        // Состояние (turnsMap/pendingCursor/historyFullByQuiet/reachedStart) НЕ меняем — только лог.
        if (!next && lastPaginateOuter) {
          var shadowCur = shadowCursorFromRest(lastPaginateOuter);
          if (shadowCur) {
            debugLog('log', '[AI CM][cursor-diag] shadow-probe fired rest-candidate len=' + shadowCur.length +
              ' head=' + JSON.stringify(shadowCur.slice(0, 12)) +
              ' tail=' + JSON.stringify(shadowCur.slice(-12)) +
              ' convId=' + (getConvId() || '(none)'));
            (function () {
              var reqTagSh = captureReqTag();
              var shHeaders = {};
              for (var sk in lastHeaders) shHeaders[sk] = lastHeaders[sk];
              originalFetch(buildActiveUrl(), {
                method: 'POST', headers: shHeaders, body: buildActiveBodyWith(shadowCur), credentials: 'include'
              }).then(function (shResp) {
                if (!shResp || !shResp.ok) {
                  debugLog('log', '[AI CM][cursor-diag] shadow-probe status=' + (shResp ? shResp.status : 'none'));
                  return null;
                }
                return shResp.text();
              }).then(function (shTxt) {
                if (!shTxt || isStaleReqTag(reqTagSh, 'sh')) return;
                // parseBatchExecute → handleOuter меняет pendingCursor/cursorEpoch/olderHistorySeen:
                // сохраняем и восстанавливаем — состояние пагинации не трогаем.
                var savedCursorSh = pendingCursor;
                var savedEpochSh = cursorEpoch;
                var savedOlderSh = olderHistorySeen;
                var shParsed = parseBatchExecute(shTxt, 'sh');
                var shadowCursorFound = pendingCursor;
                pendingCursor = savedCursorSh;
                cursorEpoch = savedEpochSh;
                olderHistorySeen = savedOlderSh;
                var shFe = aiCmDiagTurnEdge(shParsed, 'first');
                var shLe = aiCmDiagTurnEdge(shParsed, 'last');
                debugLog('log', '[AI CM][cursor-diag] shadow-probe result ходов=' + shParsed.length +
                  ' firstText="' + shFe.text + '" lastText="' + shLe.text + '"' +
                  ' cursorFound=' + (shadowCursorFound ? 'yes' : 'no') +
                  ' convId=' + (getConvId() || '(none)'));
              }).catch(function (shErr) {
                debugLog('log', '[AI CM][cursor-diag] shadow-probe error=' + (shErr && shErr.message || shErr));
              });
            })();
          }
        }
        // v73: нециркулярное решение о полноте (гейт → (b) probe; scroll-top-proof удалён — H12/A5b)
        if (serverFirstHash && dbFirstHash !== serverFirstHash) {
          reachedStart = false;
          debugLog('log', '[AI CM][completeness] oracle=incomplete reason=circular-mismatch' +
            ' firstHash=' + dbFirstHash + ' serverFirstHash=' + serverFirstHash + ' retries=' + retriesC73);
          console.log('[AI CM][paginate] incomplete reason=circular-mismatch (added=' + added + ' всего=' + totalNow + ')');
          finishQuiet(false, 'circular-mismatch');
        } else {
          // H12 (A5b): scroll-top-proof удалён — циркулярный оракул; полнота только из серверно-авторитетных точек (ARCHITECTURE_STANDARDS.md)
          // H9 (last-step-broken): финальный шаг тихой пагинации сломан (added=0, курсора нет,
          // скелет/0 кандидатов) → даже при topReached+scrollEngaged scroll-top-proof больше
          // НЕ объявляется (удалён, H12) — уходим в (b) probe / loader-restart; if ниже —
          // диагностика сломанного финального шага (гейт lastPagStepBroken сохранён).
          if (lastPagStepBroken && loaderState.topReached === true && loaderState.scrollEngaged === true &&
              lastOlderNonPagAddAt < (paginationRun.startTs || 0)) {
            debugLog('log', '[gemini-paginate] scroll-top-proof suppressed: last step broken' +
              ' added=' + added + ' serverFirstHash=' + serverFirstHash + ' dbFirstHash=' + dbFirstHash +
              ' retries=' + retriesC73);
          }
          // (b) контрольный probe; решение — в колбэке runCompletenessProbe
          var wideCur = extractCursorWide(lastPaginateOuter);
          // H9b (retain-last-good): оборванный финальный шаг перезаписал lastPaginateOuter
          // битой/терминальной страницей → живой wide-курсор пуст; подаём retained last-good
          // того же convId (ВХОД запроса probe — complete решается только по ответу probe).
          if (!wideCur && lastGoodWideCur && lastGoodWideCur.conv && lastGoodWideCur.conv === (getConvId() || '')) {
            wideCur = lastGoodWideCur.cur;
            debugLog('log', '[AI CM][completeness] retained-wide-cur fed reason=oracle-b' +
              ' convId=' + (getConvId() || '(none)') + ' firstHash=' + dbFirstHash);
          }
          reachedStart = false;
          finishQuiet(false, 'await-probe');
          runCompletenessProbe(dbFirstHash, wideCur);
        }
      })
      .catch(function (err) {
        // v59: устаревший шаг не трогает состояние нового чата
        if (isStaleReqTag(reqTagPag, 'pag')) return;
        debugLog('log', '[gemini-paginate] ошибка шага ' + depth + ': ' + err);
        finishQuiet(false, 'err');
      });
  }
  function finishQuiet(success, reason) {
    quietActive = false;
    // v1.13.1: цикл завершён — фиксируем видимость вкладки на момент завершения
    // (Win+L во время тихой пагинации → результат цикла недостоверен).
    lastCycleEndedHidden = (typeof document !== 'undefined' && document.visibilityState !== 'visible');
    if (success) {
      historyFullByQuiet = true;
      if (reachedStart === true) {
        quietIncompleteNoStart = false; // начало подтверждено — доверие восстановлено
      } else if (reason !== 'end') {
        quietIncompleteNoStart = true;  // 'cap'/'no-meta' без подтверждённого начала — база неполная
      }
      // v69: watchdog — явный probe первой страницы после data-complete; несовпадение
      // firstMsgHash → дозапуск лоадера (≤3 ретраев).
      try { runCompletenessWatchdog(getConvId()); } catch (eW) { }
    }
    debugLog('log', '[gemini-paginate] тихий цикл завершён: success=' + success + ' reason=' + reason +
      ' quietPaginated=' + quietPaginated + ' ходов в базе=' + baseSize() +
      (success ? ' (ПОЛНАЯ история собрана СЕТЬЮ, без скролла)' : ''));
    if (success) { try { emitBaseSnapshot(); } catch (e) { } }
    if (success && quietPaginated) {
      try { activeRefresh('досбор хвоста после тихой пагинации'); } catch (e) { }
    }
    // v41: при baseComplete=true (голова собрана сетью, цепочка непрерывна) автоскролл
    // НЕ запускаем — он даёт белый экран на скрытом контейнере и крутится до empty*3
    // из-за устаревшего пола в localStorage. Пол перезаписываем фактическим count.
    if (success) {
      var fqId = getConvId();
      if (fqId && parserVersion && typeof localStorage !== 'undefined') {
        try {
          var fk = 'ai-cm-gemini-floor-' + parserVersion + '-' + fqId;
          localStorage.setItem(fk, JSON.stringify({ count: baseSize(), effectiveLen: lastBaseTextLen, ts: Date.now(), version: parserVersion }));
        } catch (e) { }
      }
      debugLog('log', '[gemini-paginate] фолбэк пропущен: история полная по сети (baseComplete=true)');
    } else if (!quietPaginated) {
      debugLog('log', '[gemini-paginate] тихий цикл не добавил ходов → фолбэк: запускаю автоскролл');
      scheduleAutoScroll();
    }
    // T1-fix (v1.16.1): тихий цикл завершился — гейт live-loading снят, переоцениваем
    // оракул архива ПОСЛЕ собственных решений цикла (порядок веток выше не меняем).
    try { aiCmArchiveTierApply(); } catch (eArcFq) { }
  }

  // ================= v73: контрольный probe полноты (независимый источник (b)) =================
  // Запрос с курсором ШИРОКОЙ экстракции (rest, строки 8..2000) из оборвавшего ответа.
  // Ответ: 0 новых старших ходов И курсора нет → complete; иначе → лоадер-фолбэк.
  // Состояние пагинации (pendingCursor/cursorEpoch/olderHistorySeen/turnsMap) НЕ меняем.
  function runCompletenessProbe(dbFirstHash, wideCur, optsP) {
    var convId = getConvId();
    var retriesP = completenessWatchdogRetries[convId] || 0;
    function probeIncomplete(reason) {
      debugLog('log', '[AI CM][completeness] oracle=incomplete reason=' + reason +
        ' firstHash=' + dbFirstHash + ' retries=' + retriesP + ' convId=' + convId);
      debugLog('log', '[AI CM][completeness] loader-restart reason=incomplete-oracle convId=' + convId);
      // v1.6 (D14): оракул авторитетнее кэш-эвристики — снимаем латч loaderDoneMap,
      // иначе maybeStartLoader упрётся в skip reason=already-done (cache-complete от
      // tape-restore) и страховочный скролл/прогон полноты не перезапустится.
      try { delete loaderDoneMap[convId]; } catch (eD14p) { }
      try { oracleIncompleteSeen[convId] = true; } catch (eD15i) { } // v1.6 (D15): флаг для обхода cache-complete
      debugLog('log', '[AI CM][completeness] latch-cleared for rerun convId=' + convId);
      // v80 (O1-C): ре-ран лоадера (D14/D15) — тоже ПОД оверлеем: закрываем экран заранее,
      // чтобы между loader-stop и повторным hide-apply не мелькал чат. Разоружение — если
      // ре-ран не стартовал/не взял оверлей, снимаем по таймауту (протечки нет: свой
      // __restoreLoader ре-рана снимает оверлей в любом случае). v81 (O1 white-screen A):
      // при восстановленной ленте (tapeWasUsedInThisColdStart) pre-apply НЕ делаем — тейп
      // уже отрисован, оверлей давал «белый экран».
      try {
        if (getConvId() === convId) {
          if (tapeWasUsedInThisColdStart === true) {
            debugLog('log', '[AI CM][visibility] overlay-suppressed reason=tape-present convId=' + (getConvId() || '(none)'));
          } else {
            aiCmSetScrollOverlay(true, 'loader-restart');
          }
          if (aiCmRerunOverlayTimer) { clearTimeout(aiCmRerunOverlayTimer); aiCmRerunOverlayTimer = null; }
          aiCmRerunOverlayTimer = setTimeout(function () {
            aiCmRerunOverlayTimer = null;
            if (aiCmScrollOverlay && !loaderRunningFor) aiCmSetScrollOverlay(false, 'rerun-overlay-disarm');
          }, 4000);
        }
      } catch (eO80) { }
      try { maybeStartLoader(); } catch (eR) { } // латч loaderDoneMap гейтирует повторный прогон
    }
    // H9b (retain-last-good): retained — ТОЛЬКО вход запроса probe (complete решается
    // исключительно по ответу: probe-terminal). Оборванный финальный шаг пагинации
    // перезаписал lastPaginateOuter битой/терминальной страницей → живой wide-курсор пуст:
    // берём last-good того же convId. Метаданные запроса при пустом живом слоте — из
    // retained (same-convId; ответ всё равно гейтится isStaleReqTag → старый conv не
    // пройдёт). Глобалы подменяем ТОЛЬКО на время синхронной сборки запроса и сразу
    // восстанавливаем — probe-парс не мутирует состояние пагинации.
    var __pMetaSavedH9b = null;
    try {
      if (!wideCur && lastGoodWideCur && lastGoodWideCur.conv &&
          lastGoodWideCur.conv === (getConvId() || '')) {
        wideCur = lastGoodWideCur.cur;
        debugLog('log', '[AI CM][completeness] probe retained-wide-cur convId=' + (getConvId() || '(none)'));
      }
      if ((!lastAtEncoded || !lastBaseUrl || !lastHeaders) && lastGoodProbeMeta &&
          lastGoodProbeMeta.conv && lastGoodProbeMeta.conv === (getConvId() || '')) {
        __pMetaSavedH9b = { a: lastAtEncoded, b: lastBaseUrl, h: lastHeaders };
        lastAtEncoded = lastGoodProbeMeta.atEncoded || lastAtEncoded;
        lastBaseUrl = lastGoodProbeMeta.baseUrl || lastBaseUrl;
        lastHeaders = lastGoodProbeMeta.headers || lastHeaders;
        debugLog('log', '[AI CM][completeness] probe retained-meta convId=' + (getConvId() || '(none)'));
      }
    } catch (eRmH9bp) { }
    if (!wideCur) { probeIncomplete('no-wide-cursor'); return; }
    if (!lastAtEncoded || !lastBaseUrl || !lastHeaders) { probeIncomplete('no-meta'); return; }
    var reqTagP = captureReqTag();
    var pHeaders = {};
    for (var k in lastHeaders) pHeaders[k] = lastHeaders[k];
    var pFetchPromH9b = originalFetch(buildActiveUrl(), {
      method: 'POST', headers: pHeaders, body: buildActiveBodyWith(wideCur), credentials: 'include'
    });
    // H9b: запрос уже сформирован (url/body/headers собраны синхронно) — восстанавливаем
    // живой слот метаданных, если он был подменён retained (см. выше).
    if (__pMetaSavedH9b) {
      try {
        lastAtEncoded = __pMetaSavedH9b.a;
        lastBaseUrl = __pMetaSavedH9b.b;
        lastHeaders = __pMetaSavedH9b.h;
      } catch (eRsH9b) { }
      __pMetaSavedH9b = null;
    }
    pFetchPromH9b
      .then(function (pResp) {
        if (!pResp || !pResp.ok) { probeIncomplete('probe-status' + (pResp ? pResp.status : 'none')); return null; }
        return pResp.text();
      })
      .then(function (pTxt) {
        if (!pTxt || isStaleReqTag(reqTagP, 'pb')) { if (pTxt) probeIncomplete('probe-stale'); return; }
        // parseBatchExecute → handleOuter мутирует диагностику/курсор: сохраняем и восстанавливаем
        var savedCursorP = pendingCursor, savedEpochP = cursorEpoch, savedOlderP = olderHistorySeen;
        var pParsed = parseBatchExecute(pTxt, 'pb');
        var pParseFailed = !!lastFrameParseFail; // O-48: кадр probe-ответа оборван
        var pCursorWide = extractCursorWide(lastPaginateOuter); // outer probe-ответа
        pendingCursor = savedCursorP; cursorEpoch = savedEpochP; olderHistorySeen = savedOlderP;
        // O-48: обрыв кадра probe — НЕ терминал (0 новых ходов и «нет курсора» на обрезанном
        // ответе ничего не доказывают) и НЕ повод гнать лоадер по кругу: отдельный reason,
        // полнота не объявляется (ложная полнота запрещена, [LOW CONFIDENCE] остаётся честным).
        if (pParseFailed) {
          debugLog('log', '[AI CM][completeness] oracle=incomplete reason=parse-fail (probe)' +
            ' firstHash=' + dbFirstHash + ' retries=' + retriesP + ' convId=' + convId +
            ' (кадр probe оборван — терминал НЕ объявляется, рестарт лоадера не запускается)');
          return;
        }
        var newOlder = 0;
        for (var pi = 0; pi < pParsed.length; pi++) {
          var pid = pParsed[pi] && pParsed[pi].id;
          if (pid && !turnsMap[pid]) newOlder++;
        }
        if (newOlder === 0 && !pCursorWide) {
          // H10 (probe-terminal gate): пол авторитетнее ответа probe. Терминальный ответ
          // окна-ДУБЛЯ (e292: newOlder=0 + курсор в turns вне rest-скана extractCursorWide →
          // cursorFound=no) ложно взводил complete на усечённой базе (80 < floor=108);
          // ошибка-страница pb (lastHnvPageError) — complete по не-данным. block →
          // probeIncomplete(reason) → loader-restart (утренний путь докрутки до начала).
          var __ptGate = null;
          var __ptFloor = 0;
          try { __ptFloor = (loadFloor(convId) || {}).count || 0; } catch (ePtF) { }
          try {
            if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                typeof window.GeminiInterceptLogic.probeTerminalGate === 'function') {
              __ptGate = window.GeminiInterceptLogic.probeTerminalGate({
                floorCount: __ptFloor,
                baseCount: baseSize(),
                pbError: lastHnvPageError === true
              });
            } else {
              // inline-дубль правила (логика-скрипт недоступен): пол-гейт + pb-error-гейт
              if (__ptFloor > 0 && baseSize() < __ptFloor) {
                __ptGate = { block: true, reason: 'below-floor-probe-terminal' };
              } else if (lastHnvPageError === true) {
                __ptGate = { block: true, reason: 'pb-error-page' };
              }
            }
          } catch (ePtG) { __ptGate = null; }
          if (__ptGate && __ptGate.block) {
            debugLog('log', '[AI CM][completeness] probe-terminal blocked reason=' + __ptGate.reason +
              ' msgs=' + baseSize() + ' floor=' + __ptFloor +
              ' pbError=' + (lastHnvPageError === true ? '1' : '0') + ' convId=' + convId);
            probeIncomplete(__ptGate.reason);
            return;
          }
          historyFullByQuiet = true;
          reachedStart = true;
          quietIncompleteNoStart = false;
          lastCycleEndedHidden = (typeof document !== 'undefined' && document.visibilityState !== 'visible');
          debugLog('log', '[AI CM][completeness] oracle=complete reason=probe-terminal' +
            ' firstHash=' + dbFirstHash + ' newOlder=0 cursorFound=no retries=' + retriesP + ' convId=' + convId);
          try { emitBaseSnapshot(); } catch (eE) { }
          // H9b: терминальный ответ — retained last-good отработал (был входом запроса);
          // сброс, чтобы не перетекать в следующий цикл/чат (прочие сбросы — смена чата).
          lastGoodWideCur = null;
          lastGoodProbeMeta = null;
          if (optsP && typeof optsP.onTerminal === 'function') { try { optsP.onTerminal(); } catch (eCbt) { } }
        } else {
          probeIncomplete('probe-non-terminal newOlder=' + newOlder + ' cursorFound=' + (pCursorWide ? 'yes' : 'no'));
        }
      })
      .catch(function (pErr) {
        probeIncomplete('probe-error ' + (pErr && pErr.message || pErr));
      });
  }

  // ================= v69: completeness watchdog =================
  // После каждого data-complete (finishQuiet success) выполняем явный probe первой страницы:
  // повторно тянем голову по lastHeadToken и сверяем firstMsgHash. Несовпадение → дозапуск
  // лоадера (≤3 ретраев на чат). DOM-эвристики не участвуют — только факт сети.
  function runCompletenessWatchdog(convId) {
    if (!convId) return;
    if (watchdogFiredMap[convId]) return; // probe уже идёт
    var retries = completenessWatchdogRetries[convId] || 0;
    if (retries >= 3) {
      debugLog('log', '[AI CM][completeness] watchdog=capped retries=' + retries + ' convId=' + convId);
      return;
    }
    var dbFirstHash = aiCmDiagTurnEdge(aiCmOrderedTurns(), 'first').hash;
    // Без метаданных сети или без токена головы сетевой probe невозможен — сверяем по
    // уже захваченному serverFirstHash (курсор считаем исчерпанным, т.к. оракул уже прошёл).
    if (!lastAtEncoded || !lastBaseUrl || !lastHeaders || !lastHeadToken) {
      finishWatchdogDecision(convId, dbFirstHash, serverFirstHash, true, retries);
      return;
    }
    watchdogFiredMap[convId] = true;
    var reqTagW = captureReqTag();
    var headers = {};
    for (var k in lastHeaders) headers[k] = lastHeaders[k];
    originalFetch(buildActiveUrl(), {
      method: 'POST',
      headers: headers,
      body: buildActiveBodyWith(lastHeadToken),
      credentials: 'include'
    })
      .then(function (resp) {
        if (!resp || !resp.ok) {
          debugLog('log', '[AI CM][completeness] watchdog=error reason=status' + (resp ? resp.status : 'none') + ' convId=' + convId);
          watchdogFiredMap[convId] = false;
          return null;
        }
        return resp.text();
      })
      .then(function (txt) {
        if (!txt) { watchdogFiredMap[convId] = false; return; }
        // v59: ответ уходил для старого чата/эпохи — игнорируем probe
        if (isStaleReqTag(reqTagW, 'wd')) { watchdogFiredMap[convId] = false; return; }
        var probeFirstHash = '';
        var probeCursorExhausted = false;
        var probeParseFailed = false; // O-48: обрыв JSON-кадра probe-страницы
        try {
          // parseBatchExecute вызывает handleOuter (диагностические побочки + pendingCursor),
          // но НЕ трогает turnsMap — база не мутируется. Курсор пагинации (D2) не мутируем:
          // состояние probe читаем локально и возвращаем живой pendingCursor на место.
          var savedCursorW = pendingCursor;
          var probeParsed = parseBatchExecute(txt, 'wd');
          probeParseFailed = !!lastFrameParseFail; // O-48: обрыв ≠ «курсора нет»
          var probeCursorFound = pendingCursor;    // курсор probe-страницы (null = её курсор исчерпан)
          pendingCursor = savedCursorW;
          var ordered = probeParsed;
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.orderPageByR1) {
            var r1w = window.GeminiInterceptLogic.orderPageByR1(probeParsed);
            if (r1w && r1w.ok && Array.isArray(r1w.ids) && r1w.ids.length === probeParsed.length) {
              var byIdW = {};
              for (var wi = 0; wi < probeParsed.length; wi++) byIdW[probeParsed[wi].id] = probeParsed[wi];
              var reW = [];
              for (var wj = 0; wj < r1w.ids.length; wj++) { if (byIdW[r1w.ids[wj]]) reW.push(byIdW[r1w.ids[wj]]); }
              if (reW.length === probeParsed.length) ordered = reW;
            }
          }
          if (ordered.length) probeFirstHash = aiCmDiagHash6(ordered[0].id, ordered[0].text);
          probeCursorExhausted = !probeCursorFound;
        } catch (e) {
          probeFirstHash = '';
          probeCursorExhausted = false;
          probeParseFailed = true; // O-48: исключение парса — тот же класс обрыва кадра
        }
        finishWatchdogDecision(convId, dbFirstHash, probeFirstHash, probeCursorExhausted, retries, probeParseFailed);
      })
      .catch(function (err) {
        debugLog('log', '[AI CM][completeness] watchdog=error err=' + (err && err.message || err) + ' convId=' + convId);
        watchdogFiredMap[convId] = false;
      });
  }

  function finishWatchdogDecision(convId, dbFirstHash, probeFirstHash, probeCursorExhausted, retries, probeParseFailed) {
    var ok = (probeCursorExhausted === true) && !!dbFirstHash && !!probeFirstHash && dbFirstHash === probeFirstHash;
    if (ok) {
      completenessWatchdogRetries[convId] = 0;
      debugLog('log', '[AI CM][completeness] watchdog=ok firstHash=' + dbFirstHash + ' serverFirstHash=' + probeFirstHash + ' retries=' + retries + ' convId=' + convId);
      watchdogFiredMap[convId] = false;
      return;
    }
    // O-48 (D3): обрыв JSON-кадра probe-страницы — отдельный reason='parse-fail'. Это НЕ
    // неполнота базы (на обрезанном ответе «курсора нет» ничего не доказывает) и НЕ повод
    // гнать лоадер по кругу: бюджет полноты не тратится, рестарт не запускается, полнота
    // не объявляется — итог честный ([LOW CONFIDENCE] по 60с-таймауту, D1).
    if (probeParseFailed === true) {
      debugLog('log', '[AI CM][completeness] watchdog=fail reason=parse-fail firstHash=' + dbFirstHash +
        ' serverFirstHash=' + probeFirstHash + ' retries=' + (retries || 0) + ' convId=' + convId +
        ' (кадр probe оборван: ретрай лоадера НЕ запускается, полнота НЕ объявляется)');
      watchdogFiredMap[convId] = false;
      return;
    }
    completenessWatchdogRetries[convId] = (retries || 0) + 1;
    var reason = (probeCursorExhausted === false) ? 'cursor-alive' : 'first-hash-mismatch';
    debugLog('log', '[AI CM][completeness] watchdog=fail reason=' + reason + ' firstHash=' + dbFirstHash + ' serverFirstHash=' + probeFirstHash + ' retries=' + completenessWatchdogRetries[convId] + ' convId=' + convId);
    // Дозапуск лоадера (≤3): сбрасываем полноту и разрешаем повторный прогон.
    historyFullByQuiet = false;
    reachedStart = false;
    reachedStartByScroll = false;
    quietIncompleteNoStart = false;
    quietDecisionMade = false;
    delete loaderDoneMap[convId];
    if (completenessWatchdogRetries[convId] <= 3) {
      try { maybeStartLoader(); } catch (eR) { }
    }
    watchdogFiredMap[convId] = false;
  }

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
        ingest(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });
      })
      .catch(function (err) {
        if (!loggedActiveStatus) loggedActiveStatus = true;
        activeDisabled = true;
        debugLog('log', '[gemini-virtual-f5] ошибка активного запроса: ' + err + ' → остаёмся на пассиве+DOM');
      })
      .finally(function () { activeBusy = false; });
  }

  // v40: обёртка над чистой логикой shouldPollVf5 (utils/gemini-intercept-logic.js).
  // Не планировать следующий vf5, когда история полная (baseComplete) и тихая пагинация
  // дошла до начала (reachedStart), а активности не было последние 60с.
  function shouldPollVf5(now) {
    if (typeof window === 'undefined' || !window.GeminiInterceptLogic || !window.GeminiInterceptLogic.shouldPollVf5) {
      return true;
    }
    return window.GeminiInterceptLogic.shouldPollVf5({
      baseComplete: historyFullByQuiet,
      reachedStart: reachedStart,
      lastActivityAt: lastVf5ActivityAt
    }, now);
  }

  function startRefreshObserver() {
    if (observerStarted) return;
    observerStarted = true;
    lastActiveAt = Date.now();
    lastVf5ActivityAt = Date.now();
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
        lastVf5ActivityAt = Date.now(); // v40: DOM-мутация — активность, сброс тишины
        clearTimeout(mutTimer);
        mutTimer = setTimeout(function () {
          if (Date.now() < scrollRecentUntil) return; // мутации от скролла — не rebuild
          var now = Date.now();
          // v55: DOM-догон. Срабатывание дебаунса = 2.5с без новых мутаций = стриминг
          // ответа завершён. Просим content.js (ISOLATED) сделать ЛОКАЛЬНЫЙ пересчёт
          // токенов (baseText + DOM-хвост, существующий tokenEstimate) и переэмитить
          // базу — БЕЗ сетевого запроса. Это снимает «лаг в одну реплику» независимо
          // от rpcids. Гарды: активная вкладка, лоадер не бежит (не ломать пол),
          // тихая пагинация не активна. Stream-ingest (rpcid I4z33b/Bsxleb) остаётся
          // запасным источником — здесь мы его не заменяем, а дублируем локально.
          var convIdDe = getConvId();
          if (convIdDe &&
              loaderRunningFor !== convIdDe &&
              !quietActive &&
              document.visibilityState === 'visible') {
            try { window.dispatchEvent(new CustomEvent('ai-cm-dom-emit-request')); } catch (eDe) { }
          }
          if (!shouldPollVf5(now)) {
            debugLog('log', '[gemini-virtual-f5] vf5-поллер в тишине — полная история без активности 60с, пропускаю');
            return;
          }
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

  // ================= единый эмит снимка базы =================
  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (оракул и пол) ============
  // Метаданные архива по convId кладёт слушатель ai-cm-archive-restore (ниже, рядом
  // с tape-restore): content.js (ISOLATED) читает chrome.storage.local и передаёт
  // нормализованные ходы — MAIN-мир chrome.* не касается (инвариант мировой изоляции).
  //
  // aiCmArchiveTierApply() вызывается из emitBaseSnapshot, то есть переоценивается на
  // КАЖДОМ изменении базы. archive-complete объявляется ровно тогда, когда живая база
  // доросла до архивного count — не в момент импорта. H9-гейты (untrustedTopVerdict /
  // pagStepBroken) и H10 (пол авторитетнее ответа probe) НЕ ослабляются: архив — это
  // ДОПОЛНИТЕЛЬНАЯ терминальная точка со своими гейтами (convId, count, пол).
  // T1-fix (v1.16.1): плюс гейт ЖИВОГО яруса (loaderRunning / loaderDone / active /
  // grewBeyondArchive) — архивные ходы лежат в той же базе, поэтому «count дорос»
  // без живых доказательств означал ложную полноту и автоэкспорт одной архивной части.
  function aiCmArchiveFor(convId) {
    if (!convId) return null;
    return archiveTierByConv[convId] || null;
  }

  // T1-fix#3 (v1.16.3): сообщения ОБЪЕДИНЁННОЙ базы (архив + live) — тем же порядком и с
  // той же санацией, что уходят в EMIT (порядок строит ТА ЖЕ чистая orderExportMessages —
  // дубля логики D15 нет). Нужны экспорту: content.js (ISOLATED) не видит turnsMap, а
  // последний EMIT мог быть снят ДО вливания живой истории (архив читается из storage
  // первым) — файл уходил одной архивной частью (live-прогон: 4 архивных хода при базе 114).
  function aiCmBuildBaseMessages() {
    try {
      var orderItems = [];
      var mapIds = Object.keys(turnsMap);
      for (var i = 0; i < mapIds.length; i++) {
        var rec = turnsMap[mapIds[i]];
        if (!rec) continue;
        orderItems.push({
          id: mapIds[i], turnId: rec.turnId || null, r1: rec.r1 || null,
          order: rec.order || 0, role: rec.role, archive: rec.archiveAdded === true
        });
      }
      var ids = null;
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
          typeof window.GeminiInterceptLogic.orderExportMessages === 'function') {
        var exp = window.GeminiInterceptLogic.orderExportMessages(orderItems);
        if (exp && exp.ids) ids = exp.ids;
      }
      if (!ids) {
        ids = mapIds.slice().sort(function (a, b) {
          return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
        });
      }
      var messages = [];
      for (var j = 0; j < ids.length; j++) {
        var m = turnsMap[ids[j]];
        if (!m) continue;
        messages.push({ role: (m.role === 'user') ? 'user' : 'assistant', text: m.text, id: ids[j] });
      }
      return sanitizeMessagesForEmit(messages);
    } catch (eBbm) { return null; }
  }

  // T1-fix#3: сводка ОБЪЕДИНЁННОЙ базы для экспорта. Уезжает в ISOLATED синхронным мостом
  // ai-cm-turns-snap-request/response (движение ONLY через CustomEvent — мировая изоляция):
  // baseMsgs — сколько ходов в базе, liveCount — сколько из них НЕ влито архивом,
  // archiveCount — count импортированного архива, messages — сами ходы базы.
  function aiCmBaseExportInfo() {
    try {
      var convId = getConvId();
      var arch = aiCmArchiveFor(convId);
      var msgs = aiCmBuildBaseMessages();
      var info = {
        convId: convId,
        baseMsgs: msgs ? msgs.length : baseSize(),
        liveCount: aiCmLiveTurnCount(arch),
        archiveCount: (arch && arch.count) || 0,
        liveProven: aiCmArchiveLiveProven(convId),
        messages: msgs || []
      };
      return info;
    } catch (eBei) { return null; }
  }

  // T1-fix#2 (v1.16.2): живые ходы базы — ходы, НЕ влитые архивом (addedIds).
  // Архив лежит в ТОЙ ЖЕ базе (same-conv-union), поэтому baseSize() сам по себе не
  // отличает «живой ярус уже что-то дал» от «в базе пока только архив».
  function aiCmLiveTurnCount(arch) {
    try {
      var a = arch || aiCmArchiveFor(getConvId());
      if (!a || !a.addedIds) return baseSize(); // merge архива не было — вся база живая
      var ids = Object.keys(turnsMap);
      var n = 0;
      for (var i = 0; i < ids.length; i++) { if (a.addedIds[ids[i]] !== true) n++; }
      return n;
    } catch (eLtc) { return baseSize(); }
  }

  // База = ТОЛЬКО архив: ни одного живого хода. В этом состоянии ни латч loaderDoneMap
  // (его ставят и «скип»-ветки лоадера: no-older-history / cache-complete / data-complete),
  // ни пол, поднятый самим архивом, не доказывают догруженную живую историю.
  function aiCmArchiveOnlyBase(convId) {
    try {
      var a = aiCmArchiveFor(convId || getConvId());
      if (!a || !(a.count > 0)) return false;
      return aiCmLiveTurnCount(a) === 0;
    } catch (eAob) { return false; }
  }

  // Доказательство живого яруса для ПОЛ-подтверждений: архив поднимает пол своим count,
  // поэтому «база не ниже пола» доказывает лишь сам архив, а счётчик базы — его же вклад.
  // Живым доказательством считается только рост сверх архива со стыком живого окна
  // (нет пропуска середины: см. aiCmArchiveGrewBeyondArchive). Архива нет → прежние гейты.
  function aiCmArchiveLiveProven(convId) {
    try {
      var a = aiCmArchiveFor(convId || getConvId());
      if (!a || !(a.count > 0)) return true;
      if (aiCmLiveTurnCount(a) === 0) return false;
      return aiCmArchiveGrewBeyondArchive(a);
    } catch (eAlp) { return false; }
  }

  // T1-fix (v1.16.1): доказательство «база подтверждённо выросла СВЕРХ архива».
  // Архивные ходы лежат в ТОЙ ЖЕ базе (same-conv-union), поэтому baseCount > archiveCount
  // сам по себе ещё не значит, что живая история догружена (пассивный снимок мог дать
  // только свежее окно). Рост считается подтверждённым ТОЛЬКО когда:
  //   а) ходов, пришедших НЕ из архива, строго больше, чем весь архив (addedIds), И
  //   б) живое окно СТЫКУЕТСЯ с архивом — у них есть общий ход (keys по role+text),
  //      то есть между архивом и живым окном нет пропуска середины.
  // Иначе вердикт ждёт завершённого прогона лоадера (loaderDoneMap).
  function aiCmArchiveGrewBeyondArchive(arch) {
    try {
      var addedIds = arch && arch.addedIds;
      var keys = arch && arch.keys;
      if (!addedIds || !keys) return false; // merge архива ещё не было — роста быть не может
      var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
      if (!logic || typeof logic.archiveContentKey !== 'function') return false;
      var ids = Object.keys(turnsMap);
      var liveCount = 0;
      var overlap = false;
      for (var i = 0; i < ids.length; i++) {
        if (addedIds[ids[i]] === true) continue; // ход, влитый ИМЕННО архивом
        liveCount++;
        if (!overlap) {
          var k = null;
          try { k = logic.archiveContentKey(turnsMap[ids[i]]); } catch (eK) { k = null; }
          if (k && keys[k] === true) overlap = true;
        }
      }
      if (!overlap) return false;
      return liveCount > arch.count;
    } catch (eGba) { return false; }
  }

  function aiCmArchiveTierApply() {
    try {
      var convId = getConvId();
      var arch = aiCmArchiveFor(convId);
      if (!arch) return;
      var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
      if (!logic || typeof logic.archiveCompleteVerdict !== 'function') return;
      var sf = null;
      try { sf = loadFloor(convId); } catch (eSf) { }
      var floorCount = (sf && sf.count) || 0;
      // T1-fix (v1.16.1): снимок ЖИВОГО яруса — без него «база доросла до архива»
      // выполняется вкладом самого архива и объявляет ложную полноту (автоэкспорт
      // уходил с одной архивной частью, живой хвост не успевал догрузиться).
      // Дорогое доказательство роста считаем только пока лоадер не отработал.
      var loaderDone = loaderDoneMap[convId] === true;
      // T1-fix#2 (v1.16.2): база из одного архива доказательств живого яруса не даёт —
      // латч loaderDoneMap ставят и «скип»-ветки лоадера БЕЗ прогона (архив делает базу
      // непустой ещё до прихода живого RPC, из-за чего лоадер и пропускался).
      var archiveOnly = aiCmArchiveOnlyBase(convId);
      var live = {
        loaderRunning: loaderRunningFor === convId,
        loaderDone: loaderDone && !archiveOnly,
        active: quietActive === true,
        grewBeyondArchive: (loaderDone || archiveOnly) ? false : aiCmArchiveGrewBeyondArchive(arch)
      };
      var verdict = logic.archiveCompleteVerdict({
        archiveConvId: arch.convId,
        currentConvId: convId,
        archiveCount: arch.count,
        baseCount: baseSize(),
        floorCount: floorCount,
        live: live
      });
      if (verdict.complete !== true) {
        if (arch.verdictLogged !== verdict.reason) {
          arch.verdictLogged = verdict.reason;
          debugLog('log', '[AI CM][completeness] archive-complete withheld reason=' + verdict.reason +
            ' convId=' + convId + ' msgs=' + baseSize() + ' archiveMsgs=' + arch.count + ' floor=' + floorCount +
            ' loaderRunning=' + (live.loaderRunning ? '1' : '0') + ' loaderDone=' + (loaderDone ? '1' : '0') +
            ' liveActive=' + (live.active ? '1' : '0') + ' grew=' + (live.grewBeyondArchive ? '1' : '0') +
            ' archiveOnly=' + (archiveOnly ? '1' : '0'));
        }
        return;
      }
      if (arch.completeApplied === true) return; // одноразовый взвод/лог на чат
      arch.completeApplied = true;
      historyFullByQuiet = true;
      // Архив по построению содержит ГОЛОВУ разговора → начало достигнуто. Это
      // НЕ отключает H9/H10-гейты на их собственных путях (probe/loader/collapse) —
      // здесь фиксируется независимо доказанная полнота первого яруса.
      reachedStart = true;
      debugLog('log', '[AI CM][completeness] oracle=complete reason=archive-complete convId=' + convId +
        ' msgs=' + baseSize() + ' archiveMsgs=' + arch.count + ' floor=' + floorCount +
        ' format=' + (arch.format || '?'));
    } catch (eArc) { }
  }

  function emitBaseSnapshot() {
    // T1 (v1.16): первый ярус — архив. Переоценка archive-complete на каждом EMIT:
    // база могла дорасти до архивного count уже после импорта. Гейты H9/H10 не тронуты.
    try { aiCmArchiveTierApply(); } catch (eArcEmit) { }
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
        role: ot.role,
        // T1-fix#4 (v1.16.4): ход влит архивом → чистая orderExportMessages уведёт его
        // в ГОЛОВУ файла (архив = старшая история). У чатов без архива поля нет —
        // порядок байтово прежний.
        archive: ot.archiveAdded === true
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
    // v4x: финальный порядок — единая функция экспорта (D15): r1-цепочка ТОЛЬКО когда
    // её голова = серверной (первый user-ход); при рваной r1-перемычке (nullR1Count>=1)
    // приоритет — серверный порядок (orderByArrival / order). Авто == ручной побайтово.
    var ids = null;
    var usedR1 = false;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.orderExportMessages === 'function') {
      var expD15 = window.GeminiInterceptLogic.orderExportMessages(orderItems);
      if (expD15 && expD15.ids) {
        ids = expD15.ids;
        usedR1 = (expD15.mode === 'chain-r1');
      }
    }
    if (!ids) {
      if (orderItems.length) {
        debugLog('log', '[gemini-order] порядок не построен, фолбэк (сортировка по order)');
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
    lastBaseTextLen = text.length;
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
        debugLog('log', '[gemini-intercept] пол применён: count=' + ids.length +
          ' (сохранённый=' + savedFloor.count + '), effectiveLen=' + effectiveLen +
          ' (сохранённый=' + savedFloor.effectiveLen + '), floorApplied=true, floorValue=' + floorValue);
      }
      if (window.GeminiInterceptLogic.shouldSaveFloor(baseComplete, reachedStart)) {
        // передаём РЕАЛЬНЫЕ text.length и ids.length — saveFloor сама решит, обновлять ли
        saveFloor(fid, ids.length, text.length);
      }
    }
    // v78: жёсткий пол — при floorCount > baseCount бейдж/токены НЕ опускаются ниже пола
    // даже при baseComplete=true (ложная полнота loader-стопа не должна ронять бейдж:
    // 90.7% → 53.4% на base=80 < floor=124). Применяется независимо от resolveFloor.
    if (savedFloor && savedFloor.count > ids.length && effectiveLen < savedFloor.effectiveLen) {
      effectiveLen = savedFloor.effectiveLen;
      floorApplied = true;
      floorValue = savedFloor.effectiveLen;
      debugLog('log', '[gemini-intercept] пол гарантирован (v78): count=' + ids.length +
        ' (сохранённый=' + savedFloor.count + '), effectiveLen поднят до ' + effectiveLen +
        ' floorApplied=true baseComplete=' + baseComplete);
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
          reachedStart: reachedStart === true, // v1.13.1: подтверждение полноты для гейта экспорта
          isLowConfidenceBase: isLowConfidenceBase === true, // v63: sanity-фолбэк без proof — префикс [LOW CONFIDENCE]_
          floorApplied: floorApplied,
          floorValue: floorValue
        }
      }));
    } catch (e) { }
    return { count: ids.length, textLen: text.length, effectiveLen: effectiveLen, lastModelName: lastModelName, floorApplied: floorApplied, floorValue: floorValue };
  }

  // v52: stream-alias — при поступлении снапшота (passive/vf5) стримовские записи с временным
  // rc_*-id (pageMode='stream') замещаются снапшотными r_*-id того же turnId+role (FIFO по order).
  function applyStreamAliases(parsed) {
    try {
      if (!Array.isArray(parsed) || !parsed.length) return;
      for (var pi = 0; pi < parsed.length; pi++) {
        var p = parsed[pi];
        if (!p || !p.id || !/^r_[0-9a-f]+_(user|assistant)$/.test(String(p.id))) continue;
        var pRole = (p.role === 'user') ? 'user' : 'assistant';
        var candKey = null, candOrder = Infinity;
        for (var k in turnsMap) {
          var rec = turnsMap[k];
          if (!rec || rec.pageMode !== 'stream' || rec.aliasResolved) continue;
          if ((rec.role || '') !== pRole) continue;
          var o = (typeof rec.order === 'number') ? rec.order : Infinity;
          if (o < candOrder) { candOrder = o; candKey = k; }
        }
        if (!candKey) continue;
        var candRec = turnsMap[candKey];
        delete turnsMap[candKey];
        candRec.aliasResolved = true;
        if (turnsMap[p.id]) {
          debugLog('log', '[AI CM][stream-alias] ' + candKey.slice(0, 24) + ' удалён (уже есть ' + p.id.slice(0, 24) + ') convId=' + getConvId() + ' turnId=' + (p.turnId || '-'));
        } else {
          turnsMap[p.id] = candRec;
          debugLog('log', '[AI CM][stream-alias] ' + candKey.slice(0, 24) + ' → ' + p.id.slice(0, 24) + ' convId=' + (getConvId() || '(none)') + ' turnId=' + (p.turnId || '-'));
        }
      }
    } catch (e) { }
  }

  // ================= ingest =================
  function ingest(raw, opts) {
    opts = opts || {};
    var emitOnlyIfAdded = !!opts.emitOnlyIfAdded;
    var fromVirtualF5 = !!opts.fromVirtualF5;
    var fromActivePaginate = !!opts.fromActivePaginate;
    var shouldRebuild = !!opts.rebuild;
    // v52: stream-ingest — предвыбранные walker'ом ходы (opts.turns), метка источника (srcOverride),
    // запрет трогать курсор/пагинацию (preservePagination). Без этих opts поведение прежнее.
    var preTurns = Array.isArray(opts.turns) ? opts.turns : null;
    var srcOverride = (typeof opts.srcOverride === 'string' && opts.srcOverride) ? opts.srcOverride : '';
    var preservePagination = !!opts.preservePagination;
    var src = srcOverride || (fromVirtualF5 ? 'vf5' : (fromActivePaginate ? 'pag' : 'passive'));
    if (src === 'passive') lastVf5ActivityAt = Date.now(); // v40: пассивный batchexecute — активность
    try { aiCmEnsureColdWindow(); } catch (e) { } // v61diag: окно холодного старта (первый ingest или рост convEpoch)
    // cold-debug (баг «холодное открытие без полной истории»): снапшот флагов ДО парсинга —
    // что перехватчик ПОЛУЧИЛ (rawLen) и в каком состоянии стейт-машина принимает решение.
    if (typeof raw === 'string' && raw.indexOf('hNvQHb') !== -1) {
      try {
        var __cdCid = getConvId() || '';
        debugLog('log', '[AI CM][cold-debug] ingest-enter src=' + src + ' convId=' + (__cdCid || '(none)') +
          ' rawLen=' + raw.length +
          ' baseSize=' + baseSize() +
          ' historyFullByQuiet=' + (historyFullByQuiet ? '1' : '0') +
          ' reachedStart=' + (reachedStart ? '1' : '0') +
          ' olderHistorySeen=' + (olderHistorySeen ? '1' : '0') +
          ' pendingCursor=' + (pendingCursor ? '1' : '0') +
          ' quietActive=' + (quietActive ? '1' : '0') +
          ' loaderRunning=' + (loaderRunningFor === __cdCid ? 'this' : (loaderRunningFor || 'none')) +
          ' doneMap=' + (__cdCid && loaderDoneMap[__cdCid] ? '1' : '0'));
      } catch (eCd1) { }
    }
    var wasFull = historyFullByQuiet;
    // O-48 (D2): курсор продолжения сохраняется ДО парса. Парс страницы (handleOuter)
    // перезаписывает pendingCursor ответом; при обрыве JSON-кадра нового курсора нет, а
    // старый уже уничтожен строкой ниже — цепочка пагинации рвалась, база не дозревала
    // (60с-таймаут → [LOW CONFIDENCE]). Тот же паттерн, что у shadow-probe/probe-парсов.
    var savedPendingCursor = pendingCursor;
    if (!preservePagination) pendingCursor = null; // v52: стрим-инжест не трогает курсор пагинации

    var parsed;
    var ingestParseFail = null; // O-48: обрыв JSON-кадра этого парса (читаем сразу после)
    if (preTurns) {
      parsed = preTurns;
    } else {
      try { parsed = parseBatchExecute(raw, src); }
      catch (e) {
        if (!loggedErr) { loggedErr = true; debugLog('log', '[gemini-intercept] ошибка парсинга batchexecute:', e); }
        if (!preservePagination) pendingCursor = savedPendingCursor; // O-48 (D2)
        return 0;
      }
      ingestParseFail = lastFrameParseFail;
    }
    // O-48 (D2): обрыв кадра или ноль ходов — нового курсора нет, сохранённый жив: возвращаем.
    if (!preTurns && !preservePagination && (ingestParseFail || !parsed.length)) {
      pendingCursor = savedPendingCursor;
    }
    if (ingestParseFail) {
      lastIngestParseFail = {
        convId: getConvId() || '', src: src, ts: Date.now(),
        where: ingestParseFail.where, declaredN: ingestParseFail.declaredN,
        availableBytes: ingestParseFail.availableBytes, reEncodedLen: ingestParseFail.reEncodedLen,
        rawLen: ingestParseFail.rawLen, clamped: ingestParseFail.clamped === true,
        salvaged: ingestParseFail.salvaged || 0
      };
      // O-48 (D3): обрыв — отдельный reason, НЕ маскируется под first-hash-mismatch и не
      // объявляет полноту. Честный итог неполного кадра — неполная база + LOW CONFIDENCE.
      debugLog('log', '[AI CM][completeness] oracle=incomplete reason=parse-fail src=' + src +
        ' convId=' + (getConvId() || '(none)') +
        ' declaredN=' + ingestParseFail.declaredN + ' availableBytes=' + ingestParseFail.availableBytes +
        ' reEncodedLen=' + ingestParseFail.reEncodedLen + ' rawLen=' + ingestParseFail.rawLen +
        ' clamped=' + (ingestParseFail.clamped ? '1' : '0') +
        ' salvagedTurns=' + (ingestParseFail.salvaged || 0) +
        ' pendingCursor=' + (pendingCursor ? 'alive' : 'none') + ' (полнота НЕ взводится)');
    }
    if (!parsed.length) {
      // cold-debug: что РЕАЛЬНО вернул сервер на «пустой» hNvQHb-странице (обрыв пагинации)
      if (typeof raw === 'string' && raw.indexOf('hNvQHb') !== -1) {
        try {
          debugLog('log', '[AI CM][cold-debug] empty-hNvQHb src=' + src + ' rawLen=' + raw.length +
            ' convId=' + (getConvId() || '(none)') +
            ' raw=' + JSON.stringify(raw.slice(0, 400)));
        } catch (eEh) { }
      }
      if (!preTurns && !loggedErr) { loggedErr = true; debugLog('log', '[gemini-intercept] batchexecute распознан, но ходов не найдено'); }
      return 0;
    }

    // v60: disjoint-reset — контентный критерий смены сеанса/аккаунта. Гард ТОЛЬКО для
    // путей vf5 и passive-снапшотов (pag/тихая пагинация легитимно не пересекается с
    // базой — её страницы СТАРШЕ). База непуста и НОЛЬ пересечений id с входящим
    // снапшотом → чужой сеанс: полный сброс + ingest как новая база. Решение принимаем
    // ДО блока v32 — покрывает и «merge по id без сброса» (vf5 с курсором продолжения),
    // и passive-снапшоты. Пересечение ненулевое → merge-by-id без изменений (v32-блок).
    var disjointGuardSrc = (src === 'vf5' || src === 'passive');
    // v61diag: данные для merge-decision лога (решение НЕ меняется)
    var diagExistingBefore = baseSize();
    var diagDisjointReset = false;
    var diagOverlap = 0;
    for (var dgi = 0; dgi < parsed.length; dgi++) {
      var dgid = parsed[dgi] && parsed[dgi].id;
      if (dgid && turnsMap[dgid]) diagOverlap++;
    }
    // v62: фиксация vf5-overlap — доказательство достоверности базы для confirmed-by-scroll
    if (src === 'vf5' && diagOverlap > 0) vf5OverlapSinceLoaderStart = true;
    // v66: латч already-done — сброс при НОВЫХ непересекающихся данных после done
    // (pag/vf5 с overlapCount=0 при непустой базе): разрешаем ровно один повторный прогон.
    if (!loaderRunningFor && (src === 'pag' || src === 'vf5') && diagOverlap === 0 && diagExistingBefore > 0) {
      var curConvLatch66 = getConvId();
      if (curConvLatch66 && loaderDoneMap[curConvLatch66] && !loaderRetryUsedMap[curConvLatch66]) {
        loaderRetryUsedMap[curConvLatch66] = true;
        delete loaderDoneMap[curConvLatch66];
        debugLog('log', '[AI CM][loader] v66 latch-reset reason=new-disjoint-data src=' + src +
          ' convId=' + curConvLatch66 + ' overlap=0 (ровно один повторный прогон)');
        setTimeout(function () { try { maybeStartLoader(); } catch (eL66) { } }, 2000);
      }
    }
    if (disjointGuardSrc && baseSize() > 0) {
      var disjointReset = false;
      // v64: снапшот vf5/passive принадлежит чату из URL (incomingConvId === currentConvId):
      // disjoint-reset ЗАПРЕЩЁН — непересекающиеся окна одного чата мерджатся union по id
      // (same-conv-union). Сброс разрешён ТОЛЬКО при incomingConvId !== currentConvId
      // (страховка cross-conv; основной путь там — stale-conv drop v59, не трогается).
      // stale-conv drop, convEpoch-сбросы, tape-restore, trim, пороги — без изменений.
      var diagSameConv = !!getConvId();
      if (diagSameConv) {
        disjointReset = false;
      } else {
      var disjointIdsBase = Object.keys(turnsMap);
      var disjointIdsIn = [];
      for (var dri = 0; dri < parsed.length; dri++) disjointIdsIn.push(parsed[dri] && parsed[dri].id);
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldDisjointReset) {
        disjointReset = window.GeminiInterceptLogic.shouldDisjointReset({ src: src, existingIds: disjointIdsBase, incomingIds: disjointIdsIn });
      } else {
        disjointReset = true;
        var drSeen = {};
        for (var drs = 0; drs < disjointIdsBase.length; drs++) drSeen[disjointIdsBase[drs]] = true;
        for (var drj = 0; drj < disjointIdsIn.length; drj++) {
          if (disjointIdsIn[drj] && drSeen[disjointIdsIn[drj]]) { disjointReset = false; break; }
        }
      }
      } // v64: else (cross-conv страховка)
      if (disjointReset) {
        diagDisjointReset = true; // v61diag
        convEpoch++; // v60: старые ответы (тег с прошлой эпохой) больше не ингестируются
        tapeWasUsedInThisColdStart = false; // v62: сброс базы = новая эпоха, кэш не считается
        vf5OverlapSinceLoaderStart = false; // v62: сброс базы = старый vf5-overlap не считается
        isLowConfidenceBase = false; // v63: сброс базы = low-confidence не перетекает
        turnsMap = {};
        orderCounter = 0;
        prependCursor = -1;
        olderHistorySeen = false;
        historyFullByQuiet = false;
        reachedStart = false;
        reachedStartByScroll = false; // v61diag
        serverFirstHash = ''; // v69
        lastHeadToken = null; // v69
        lastGoodWideCur = null; // H9b: retained last-good не переживает сброс базы
        lastGoodProbeMeta = null; // H9b
        quietActive = false;
        quietPaginated = false;
        quietDecisionMade = false;
        quietIncompleteNoStart = false;
        lastCycleEndedHidden = false;
        attachSeen = {};
        attachTokens = 0;
        attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
        debugLog('log', '[AI CM][session] disjoint-reset convId=' + (getConvId() || '(none)') + ' src=' + src);
        // pendingCursor НЕ трогаем: курсор входящего снапшота нужен пагинации новой базы
      }
    }

    // v32/vXX: полная пересборка vf5 допустима ТОЛЬКО если пейлоад НЕ содержит курсора
    // продолжения (действительно полная история). При наличии курсора это частичная история —
    // merge по id без сброса (turnsMap дедуплицирует). Решение принимаем ПОСЛЕ парсинга,
    // когда pendingCursor (курсор из этого пейлоада) уже известен.
    // O-51 (монотонный union): пересборка запрещена ЕЩЁ и тогда, когда входящий снапшот —
    // ПОДМНОЖЕСТВО уже собранной базы (все его id известны). Такой снапшот не добавляет ни
    // одного хода, зато сброс turnsMap уничтожает накопленное — живой прогон 2026-09-25 на
    // чате 8f1343975188be5d: база 36 → 20 ходов, метрика 39% → 10%. Усечённый
    // (виртуализированный) vf5-ответ без курсора и «полная история» по форме неразличимы —
    // решает content-критерий по id (`isSubsetIds`). Следствие запрета — stable merge
    // (merge-by-id ниже): база сохраняется ЦЕЛИКОМ, ходы снапшота, которых в ней нет,
    // добавляются из его хвоста.
    var rebuildExistingIds = [];
    var rebuildIncomingIds = [];
    if (fromVirtualF5) {
      if (baseSize() > 0) rebuildExistingIds = Object.keys(turnsMap);
      for (var rbi = 0; rbi < parsed.length; rbi++) rebuildIncomingIds.push(parsed[rbi] && parsed[rbi].id);
    }
    var incomingIsSubsetOfBase = false;
    if (rebuildExistingIds.length && rebuildIncomingIds.length) {
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.isSubsetIds) {
        incomingIsSubsetOfBase = window.GeminiInterceptLogic.isSubsetIds(rebuildIncomingIds, rebuildExistingIds);
      } else {
        // фолбэк (модуль логики недоступен/стар): тот же критерий по образцу shouldDisjointReset
        var rebuildSeen = {};
        for (var rbs = 0; rbs < rebuildExistingIds.length; rbs++) {
          if (rebuildExistingIds[rbs]) rebuildSeen[rebuildExistingIds[rbs]] = true;
        }
        incomingIsSubsetOfBase = true;
        for (var rbj = 0; rbj < rebuildIncomingIds.length; rbj++) {
          var rbid = rebuildIncomingIds[rbj];
          if (!rbid || !rebuildSeen[rbid]) { incomingIsSubsetOfBase = false; break; }
        }
      }
    }
    var fullRebuildFromVf5 = false;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic) {
      fullRebuildFromVf5 = window.GeminiInterceptLogic.shouldFullRebuild({
        fromVirtualF5: fromVirtualF5, wasFull: wasFull, hasCursor: !!pendingCursor,
        existingIds: rebuildExistingIds, incomingIds: rebuildIncomingIds
      });
    } else {
      fullRebuildFromVf5 = !!(fromVirtualF5 && wasFull);
    }
    // O-51: страховка уровня вызова — даже если модуль логики стар и не знает про
    // подмножество, сброс по снапшоту-подмножеству НЕ выполняется (data-safety важнее формы).
    if (fullRebuildFromVf5 && incomingIsSubsetOfBase) fullRebuildFromVf5 = false;
    // v75 (D-head): после tape-restore в этом холодном старте полная пересборка vf5 запрещена —
    // сброс turnsMap уничтожил бы восстановленную голову тейпа (restored-ходы с order<0),
    // а повторный tape-restore заблокирован cacheRestoredMap → merge по id без сброса.
    if (tapeWasUsedInThisColdStart === true && fullRebuildFromVf5) {
      debugLog('log', '[AI CM][merge-decision] action=merge incomingSrc=vf5 reason=tape-protect-no-rebuild existingMsgs=' + baseSize() + ' incomingMsgs=' + parsed.length);
      fullRebuildFromVf5 = false;
    }
    if (fullRebuildFromVf5) {
      turnsMap = {};
      orderCounter = 0;
      prependCursor = -1;
      debugLog('log', '[gemini-rebuild] полная пересборка из vf5 (без курсора), ходов: ' + parsed.length);
    } else if (fromVirtualF5 && wasFull && pendingCursor) {
      debugLog('log', '[gemini-rebuild] vf5 содержит курсор продолжения → merge по id без сброса (turnsMap дедуплицирует)');
    }
    // v61diag: merge-decision — только фиксация решения, логика не меняется
    (function () {
      var action = 'merge';
      var reason = 'merge-by-id';
      if (diagDisjointReset) { action = 'disjoint-reset'; reason = 'zero-id-overlap'; }
      else if (fullRebuildFromVf5) { action = 'reset'; reason = 'full-rebuild-vf5-no-cursor'; }
      // O-51: снапшот — подмножество базы, форма при этом «полная история без курсора»:
      // сброс ЗАПРЕЩЁН, идёт stable merge (причина называется честно, а не «merge-by-id»).
      else if (incomingIsSubsetOfBase && fromVirtualF5 && wasFull && !pendingCursor &&
               tapeWasUsedInThisColdStart !== true) { reason = 'vf5-subset-no-reset'; }
      else if (disjointGuardSrc && diagExistingBefore > 0 && diagOverlap === 0 && !!getConvId()) { reason = 'same-conv-union'; } // v64
      else if (fromVirtualF5 && wasFull && pendingCursor) { reason = 'vf5-cursor-continue'; }
      else if (diagExistingBefore === 0) { reason = 'empty-base'; }
      // v64: для same-conv-union — дельта окна входящего снапшота (новые id сверх пересечения)
      var diagWindowDelta = (reason === 'same-conv-union')
        ? ' windowDelta=+' + Math.max(0, parsed.length - diagOverlap) : '';
      debugLog('log', '[AI CM][merge-decision] action=' + action + ' incomingSrc=' + src +
        ' incomingConvId=' + (getConvId() || '(none)') +
        ' existingMsgs=' + diagExistingBefore + ' incomingMsgs=' + parsed.length +
        ' overlapCount=' + diagOverlap + ' disjointFlag=' + (diagOverlap === 0 ? 'true' : 'false') +
        ' reason=' + reason + diagWindowDelta);
    })();
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

    // v52: stream-alias — ДО мерджа снапшота: замещаем стримовские rc_*-записи постоянными r_*.
    if ((fromVirtualF5 || src === 'passive') && !preTurns) applyStreamAliases(parsed);

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
    // v69: захват firstMsgHash головы сервера — каждая страница пагинации перезаписывает
    // эту переменную; по завершении цикла в ней голова (первое сообщение первой страницы).
    if (fromActivePaginate && pageSeq.length) {
      serverFirstHash = aiCmDiagHash6(pageSeq[0].id, pageSeq[0].text);
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
        // v1.14.1 (SHRINK-GUARD): сетевой ход перезаписывает restored-ход того же id
        // только если входящий текст НЕ короче (решение в GeminiInterceptLogic.decideRestoredMerge).
        // Обрезанные сетевые копии уже известных ходов не затирают полные тексты из ленты.
        var recRest = turnsMap[p.id];
        var dRm = null;
        if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.decideRestoredMerge) {
          dRm = window.GeminiInterceptLogic.decideRestoredMerge(recRest, p);
        } else {
          var oldLenRm = (recRest.text || '').length;
          var newLenRm = (p.text || '').length;
          dRm = (newLenRm >= oldLenRm)
            ? { replace: true, r1: null, turnId: null }
            : { replace: false, r1: (!recRest.r1 && p.r1) ? p.r1 : null, turnId: (!recRest.turnId && p.turnId) ? p.turnId : null };
        }
        if (dRm.replace) {
          turnsMap[p.id] = { text: p.text, modelName: p.modelName, order: pageOrders[i], pageMode: src, ts: p.ts || 0, role: (p.role === 'user') ? 'user' : 'assistant', turnId: p.turnId || null, r1: p.r1 || null };
        } else {
          if (dRm.r1) recRest.r1 = dRm.r1;
          if (dRm.turnId) recRest.turnId = dRm.turnId;
          debugLog('log', '[AI CM][ingest] shrink-guard kept-restored id=' + String(p.id).slice(0, 24) +
            ' restoredLen=' + ((recRest.text || '').length) + ' netLen=' + ((p.text || '').length) + ' src=' + src +
            ' convId=' + (getConvId() || '(none)'));
        }
      } else if (!turnsMap[p.id].r1 && p.r1) {
        if (!turnsMap[p.id].pageMode) turnsMap[p.id].pageMode = src;
        turnsMap[p.id].r1 = p.r1;
        if (!turnsMap[p.id].turnId && p.turnId) turnsMap[p.id].turnId = p.turnId;
      }
    }
    refreshMinOrderTracking(src); // v73: старшие добавления вне пагинации (инвалидация scroll-proof)
    noteBaseCountChange(); // v74: стабильность счётчика базы
    var em = null;
    var shouldEmit = !emitOnlyIfAdded || added > 0;
    // v50: явный инкрементальный лог — Chrome-проверка попадания НОВЫХ ходов в turnsMap
    // (новые обмены открытого чата, приходящие инкрементальным фидом без hNvQHb в URL).
    if (added > 0) {
      debugLog('log', '[AI CM][ingest] new-turns +' + added + ' convId=' + (getConvId() || '(none)') + ' src=' + src + ' total=' + baseSize());
    }
    // v61diag: cold-start лог каждого ingest в первые 60с окна (края входящего снапшота)
    try { aiCmColdStartIngestLog(src, pageSeq, added, pageSeq.length > 0 && diagOverlap === pageSeq.length); } catch (e) { }
    if (shouldEmit) em = emitBaseSnapshot();
    var emCount = em ? em.count : baseSize();
    var emLen = em ? em.textLen : 0;
    var emModel = em ? em.lastModelName : '';
    if (!loggedOk) {
      loggedOk = true;
      debugLog('log', '[gemini-intercept] ✓ распознано ходов: ' + emCount + ' (новых: ' + added +
        '), символов: ' + emLen + ', модель из данных: ' + (emModel || '?') + ' [' + src + ']');
    } else if (added > 0) {
      debugLog('log', '[gemini-intercept] + добавлено ходов: ' + added + ', всего: ' + emCount + ', символов: ' + emLen + ' [' + src + ']');
    }
    if (!loggedAttach && attachTokens > 0) {
      loggedAttach = true;
      debugLog('log', '[gemini-intercept] 📎 вложения учтены (дедуп по имени, глобально): картинок=' +
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
      debugLog('log', '[gemini-paginate] курсор найден в vf5-ответе (len=' + pendingCursor.length + ', ' + edges8(pendingCursor) +
        ') → запускаю тихий цикл пагинации БЕЗ скролла (vf5-инициирован)');
      paginateLoop(pendingCursor, 0);
    }

    if (!fromVirtualF5 && !fromActivePaginate && src !== 'stream' && baseSize() > 0 && !quietDecisionMade) {
      quietDecisionMade = true;
      if (pendingCursor) {
        quietActive = true;
        debugLog('log', '[gemini-paginate] курсор найден в снимке (len=' + pendingCursor.length + ', ' + edges8(pendingCursor) +
          ') → запускаю тихий цикл пагинации БЕЗ скролла');
        paginateLoop(pendingCursor, 0);
      } else {
        debugLog('log', '[gemini-paginate] курсора в снимке нет → тихий путь недоступен, фолбэк: автоскролл');
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
      // v44: convId чата В МОМЕНТ ОТПРАВКИ запроса — синхронная привязка ответа к чату,
      // не зависящая от парсинга тела (закрывает дыру «гард слеп» на SPA-навигации).
      // v50: применяем и к инкрементальному фиду (isIngestRpc), а не только к истории.
      var issuedAtConvId = '';
      var issuedAtEpoch = -1; // v59: эпоха на момент отправки
      if (isIngestRpc(url)) {
        issuedAtConvId = getConvId();
        issuedAtEpoch = convEpoch; // v59
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

      // v52: stream-ingest — ветка ДО isIngestRpc: ответы генерации (I4z33b/Bsxleb), clone, не мешаем странице
      if (isStreamIngestRpc(url)) {
        promise.then(function (resp) {
          try {
            if (resp && resp.ok) {
              resp.clone().text().then(function (t) {
                provisionalStreamIngest(t, streamRpcidOf(url));
              }).catch(function () { });
            }
          } catch (e) { }
          return resp;
        }, function () { /* тихо */ });
      }
      if (isIngestRpc(url)) {
        promise.then(function (resp) {
          try {
            if (resp && resp.ok) {
              resp.clone().text().then(function (txt) {
                // v21: гард ждёт reqConvIdPromise (обычно уже разрешён)
                reqConvIdPromise.then(function (reqConvId) {
                  // v44/v59: чужой снимок — convId запроса ≠ текущий, ИЛИ «гард слеп» (reqConvId
                  // пуст), но запрос уходил для другого чата/эпохи (SPA-навигация до прибытия ответа).
                  var staleShot = (reqConvId && reqConvId !== currentConvId) ||
                    (!reqConvId && issuedAtConvId !== '' && issuedAtConvId !== currentConvId) ||
                    (!reqConvId && issuedAtEpoch !== convEpoch); // v59
                  if (staleShot) {
                    debugLog('log', '[AI CM][ingest] drop stale-conv reqConv=' + (reqConvId || issuedAtConvId || '(none)') + ' curConv=' + (currentConvId || '(none)') + ' src=passive');
                    return;
                  }
                  if (!reqConvId) {
                    // v21: точный диагностический лог при слепоте
                    debugLog('log', '[gemini-intercept] гард слеп (reqConvId пуст) путь=fetch input=' + diagInputType +
                      ' init.body=' + diagInitBody + ' — пропускаем только чужие (выпуск для ' + issuedAtConvId + ')');
                  }
                  // первый валидный ответ нового чата снимает блокировку автоскролла
                  if (autoScrollBlocked) {
                    autoScrollBlocked = false;
                    if (autoScrollUnblockTimer) { clearTimeout(autoScrollUnblockTimer); autoScrollUnblockTimer = null; }
                    debugLog('log', '[gemini-intercept] автоскролл разблокирован — получен первый валидный снимок чата ' + currentConvId);
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
      if (isIngestRpc(url) && typeof body === 'string') {
        info.reqConvId = convIdFromBody(body);
      }
      // v44: convId чата В МОМЕНТ ОТПРАВКИ — фолбэк атрибуции, когда тело не распарсилось
      if (isIngestRpc(url)) {
        info.issuedAtConvId = getConvId();
        info.issuedAtEpoch = convEpoch; // v59: эпоха на момент отправки
      }
      // v52: stream-ingest (XHR) — ветка ДО isIngestRpc: ответы генерации (I4z33b/Bsxleb)
      if (isStreamIngestRpc(url)) {
        var selfStream = this;
        this.addEventListener('load', function () {
          try {
            if (selfStream.status >= 200 && selfStream.status < 300 && selfStream.responseText) {
              provisionalStreamIngest(selfStream.responseText, streamRpcidOf(url));
            }
          } catch (e) { }
        });
      }
      if (isIngestRpc(url)) {
        var self = this;
        this.addEventListener('load', function () {
          try {
            if (self.status >= 200 && self.status < 300 && self.responseText) {
              // v20: гард — ответ от старого чата игнорируем
              var rcv = self.__aiCm && self.__aiCm.reqConvId;
              var icv = self.__aiCm && self.__aiCm.issuedAtConvId; // v44: выпуск запроса (фолбэк атрибуции)
              var iep = (self.__aiCm && typeof self.__aiCm.issuedAtEpoch === 'number') ? self.__aiCm.issuedAtEpoch : -1; // v59
              // v44/v59: чужой снимок — convId запроса ≠ текущий, ИЛИ «гард слеп», но запрос
              // уходил для другого чата/эпохи (SPA-навигация до прибытия ответа).
              var staleShot = (rcv && rcv !== currentConvId) ||
                (!rcv && icv && icv !== currentConvId) ||
                (!rcv && iep !== convEpoch); // v59
              if (staleShot) {
                debugLog('log', '[AI CM][ingest] drop stale-conv reqConv=' + (rcv || icv || '(none)') + ' curConv=' + (currentConvId || '(none)') + ' src=passive');
                return;
              }
              if (!rcv) {
                // v21: точный диагностический лог при слепоте (XHR)
                debugLog('log', '[gemini-intercept] гард слеп (reqConvId пуст) путь=xhr input=send body=' +
                  (typeof body === 'string' ? 'string len=' + body.length : (body ? typeof body : 'absent')) +
                  ' — пропускаем только чужие (выпуск для ' + icv + ')');
              }
              // первый валидный ответ нового чата снимает блокировку автоскролла
              if (autoScrollBlocked) {
                autoScrollBlocked = false;
                if (autoScrollUnblockTimer) { clearTimeout(autoScrollUnblockTimer); autoScrollUnblockTimer = null; }
                debugLog('log', '[gemini-intercept] автоскролл разблокирован — получен первый валидный XHR-снимок чата ' + currentConvId);
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
    if (!detail || !detail.turns) return; // v77: пустую ленту обрабатываем ниже (hwm-protect) с логом
    var restoredTurns = detail.turns;
    var restoredConvId = detail.convId || '';
    var current = getConvId();

    // гард: принимаем только для текущего чата
    if (restoredConvId !== current) {
      debugLog('log', '[gemini-restore] пропущена лента для чужого чата (restored=' + restoredConvId + ', current=' + current + ')');
      // v61diag: усиленный tape-restore лог (stale — кэш чужого чата)
      var diagStaleFe = aiCmDiagTurnEdge(detail.turns, 'first');
      var diagStaleLe = aiCmDiagTurnEdge(detail.turns, 'last');
      debugLog('log', '[AI CM][tape-restore] convId=' + (current || '(none)') + ' cacheConvId=' + restoredConvId +
        ' action=stale cachedMsgs=' + detail.turns.length +
        ' firstMsgHash=' + diagStaleFe.hash + ' lastMsgHash=' + diagStaleLe.hash);
      return;
    }

    // v77: повторная лента для ЭТОГО convId в рамках сессии — уже применена, не читаем
    // и не мерджим (защита O2 от повторного tape-restore поверх живых данных).
    if (current && cacheRestoredMap.has(current)) {
      debugLog('log', '[AI CM][tape-restore] skip reason=already-restored convId=' + current +
        ' cachedMsgs=' + detail.turns.length);
      return;
    }
    // v77 (HWM): кэш пуст — НЕ затираем текущее состояние и не трогаем счётчик токенов.
    if (!detail.turns.length) {
      debugLog('log', '[AI CM][tape-restore] skip reason=hwm-protect convId=' + (current || '(none)') +
        ' cachedMsgs=0 baseMsgs=' + baseSize());
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

    // v30.6: лента для текущего чата принята → лоадер полной истории не нужен
    // (maybeStartLoader читает cacheRestoredMap и делает skip reason=cache-complete).
    // v77: add ТОЛЬКО после успешного merge (см. ниже cacheRestoredMap.add).

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

    // v77: high-water-mark защита на уровне source — живые ходы сети НЕ перезатираются
    // (mergeRestoredTurns дедуплицирует по id и дополняет недостающие, не удаляя базу).
    mergeRestoredTurns(restoredTurns);
    if (current) cacheRestoredMap.add(current); // v77: Set.add ТОЛЬКО после успешного вливания
    refreshMinOrderTracking('restored'); // v73: tape-добавления старших ходов инвалидируют scroll-proof
    noteBaseCountChange(); // v74
    tapeWasUsedInThisColdStart = true; // v62: лента кэша принята в ЭТОМ холодном старте — confirmed-by-scroll разрешён
    // v61diag: усиленный tape-restore лог (лента принята и влита)
    (function () {
      var fe = aiCmDiagTurnEdge(restoredTurns, 'first');
      var le = aiCmDiagTurnEdge(restoredTurns, 'last');
      debugLog('log', '[AI CM][tape-restore] convId=' + (current || '(none)') + ' cacheConvId=' + restoredConvId +
        ' action=used cachedMsgs=' + restoredTurns.length +
        ' firstMsgHash=' + fe.hash + ' lastMsgHash=' + le.hash);
    })();
  });

  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (приём от content.js) ============
  // content.js (ISOLATED) читает chrome.storage.local (aiCmArchive:<convId>) и передаёт
  // УЖЕ НОРМАЛИЗОВАННЫЕ ходы архива. Паттерн тот же, что у tape-restore: MAIN-мир
  // chrome.* не касается. Порядок применения:
  //   1) same-conv-union — вливаем ТОЛЬКО недостающие архивные ходы (сеть авторитетна);
  //   2) архивный count авторитетен для пола (монотонно ВВЕРХ — HWM не ломается);
  //   3) метаданные яруса → оракул archive-complete переоценивается в emitBaseSnapshot.
  window.addEventListener('ai-cm-archive-restore', function (ev) {
    var detail = ev && ev.detail;
    if (!detail || !detail.convId) return;
    var convId = String(detail.convId);
    var current = getConvId();
    if (convId !== current) {
      debugLog('log', '[AI CM][archive-restore] skip reason=stale convId=' + (current || '(none)') +
        ' archiveConvId=' + convId);
      return;
    }
    var messages = Array.isArray(detail.messages) ? detail.messages : [];
    var count = (typeof detail.count === 'number' && detail.count > 0) ? detail.count : messages.length;
    if (!count || !messages.length) {
      debugLog('log', '[AI CM][archive-restore] skip reason=empty convId=' + convId);
      return;
    }
    var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
    var ids = Object.keys(turnsMap);
    var i;

    // 1) same-conv-union архивных ходов с текущей базой
    var addedCount = 0;
    // T1-fix (v1.16.1): доказательства для гейта живого яруса — ключи контента архива
    // (стык с живым окном) и id ходов, влитых ИМЕННО архивом (иначе вклад архива
    // неотличим от живых ходов в общей базе).
    var archKeys = null;
    var archAddedIds = null;
    if (!archiveMergedMap.has(convId) && logic && typeof logic.archiveMergeTurns === 'function') {
      var netItems = [];
      var maxOrder = 0;
      for (i = 0; i < ids.length; i++) {
        var nt = turnsMap[ids[i]];
        netItems.push({ id: ids[i], role: nt.role, text: nt.text });
        if ((nt.order || 0) > maxOrder) maxOrder = nt.order || 0;
      }
      var merged = logic.archiveMergeTurns(netItems, messages) || { items: [], duplicateCount: 0 };
      if (typeof logic.archiveContentKey === 'function') {
        archKeys = {};
        for (i = 0; i < messages.length; i++) {
          archKeys[logic.archiveContentKey(messages[i])] = true;
        }
      }
      archAddedIds = {};
      for (i = 0; i < merged.items.length; i++) {
        var it = merged.items[i];
        if (turnsMap[it.id]) continue;
        // pageMode 'restored' + r1=null — как у tape-restore: порядок пересчитывает
        // chain-r1, старший сегмент докладывается перед хвостовым окном сети.
        // T1-fix#4 (v1.16.4): archiveAdded=true — ЕДИНСТВЕННАЯ метка «ход влит архивом T1».
        // По ней чистая orderExportMessages ставит архив в ГОЛОВУ файла (order не трогаем:
        // aiCmOrderedTurns → dbFirstHash H9-гейта полноты обязан остаться прежним).
        turnsMap[it.id] = {
          text: it.text, modelName: '', order: maxOrder + 1 + i,
          pageMode: 'restored', ts: 0, archiveAdded: true,
          role: it.role, turnId: it.turnId, r1: null
        };
        archAddedIds[it.id] = true;
        addedCount++;
      }
      archiveMergedMap.add(convId); // Set.add ТОЛЬКО после успешного merge
      debugLog('log', '[AI CM][archive-restore] convId=' + convId + ' archiveMsgs=' + count +
        ' added=' + addedCount + ' dup=' + (merged.duplicateCount || 0) +
        ' baseMsgs=' + baseSize() + ' format=' + (detail.format || '?'));
    }

    // 2) Архивный count авторитетен для пола (понижение запрещено — HWM)
    var archFloor = null;
    try {
      if (logic && typeof logic.archiveFloorRecord === 'function') {
        archFloor = logic.archiveFloorRecord(
          loadFloor(convId),
          count,
          (typeof detail.textLen === 'number') ? detail.textLen : 0
        );
        if (archFloor) {
          saveFloor(convId, archFloor.count, archFloor.effectiveLen);
          noteBaseCountChange();
          debugLog('log', '[AI CM][archive-restore] floor source=archive convId=' + convId +
            ' count=' + archFloor.count + ' textLen=' + archFloor.effectiveLen);
        }
      }
    } catch (eAf) { }

    // 3) Метаданные яруса для оракула. Повторный dispatch (storage.onChanged) merge не
    //    повторяет — доказательства (keys/addedIds) и латчи переносим из прежней записи,
    //    иначе повторный dispatch обнулял бы гейт живого яруса.
    var prevTier = archiveTierByConv[convId] || null;
    archiveTierByConv[convId] = {
      convId: convId,
      count: count,
      textLen: (typeof detail.textLen === 'number') ? detail.textLen : 0,
      format: detail.format || '',
      service: detail.service || '',
      keys: archKeys || (prevTier && prevTier.keys) || null,
      addedIds: archAddedIds || (prevTier && prevTier.addedIds) || null,
      completeApplied: !!(prevTier && prevTier.completeApplied),
      verdictLogged: (prevTier && prevTier.verdictLogged) || ''
    };

    if (addedCount > 0 || archFloor) {
      if (addedCount > 0) { try { refreshMinOrderTracking('archive'); } catch (eRo) { } }
      try { emitBaseSnapshot(); } catch (eEm) { }
    }
    try { aiCmArchiveTierApply(); } catch (eAp) { }
  });

  // v30.6: content.js после применения кэш-ленты планирует ОДНО уточнение канонического
  // значения активным снимком через 2с (activeRefresh). Гард по convId — чат мог
  // смениться, пока шёл таймер.
  try {
    window.addEventListener('ai-cm-cache-refresh', function (ev) {
      var detail = ev && ev.detail;
      var want = (detail && detail.convId) || '';
      var current = getConvId();
      if (want && current && want !== current) {
        debugLog('log', '[gemini-cache-refresh] пропущен: чат сменился (want=' + want + ', current=' + current + ')');
        return;
      }
      debugLog('log', '[AI CM][Gemini][cache-refresh] уточнение после кэша convId=' + (current || want || '(none)'));
      activeRefresh('уточнение после кэша');
    });
  } catch (e) { }

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
    // v61diag: tape-мердж учитывается в окне холодного старта как src=tape
    try { aiCmEnsureColdWindow(); aiCmColdStartIngestLog('tape', missing, missing.length, false); } catch (e) { }
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

  // v61diag: синхронный мост — content.js (ISOLATED) запрашивает сводку turnsMap
  // для дампов в момент экспорта (snapshot-at-fired / snapshot-at-manual).
  try {
    window.addEventListener('ai-cm-turns-snap-request', function () {
      try {
        var diagSnap = (typeof window.__aiCmGeminiTurnsSnapshot === 'function') ? window.__aiCmGeminiTurnsSnapshot() : null;
        window.dispatchEvent(new CustomEvent('ai-cm-turns-snap-response', { detail: diagSnap }));
      } catch (e) { }
    });
  } catch (e) { }

  // v4y: холодное открытие (F5 на /app/<id>) → автозапуск лоадера полной истории.
  // Скроллер может появиться позже — poll внутри loadFullHistoryInvisibly до 10с.
  try { setTimeout(function () { maybeStartLoader(); }, 1000); } catch (e) { }

  debugLog('log', '[gemini-intercept] перехватчик Gemini v28 установлен (структурный сбор вложений v23 + фикс курсора + сброс при смене чата + тихая пагинация из vf5 + гард пассивки по convId (fetch Request-объекты тоже) + защита автоскролла + virtual-f5 + historyComplete в emit + подавление чужих unhandled fetch + пересборка ветки при realtime-vf5 + пол (floor) через localStorage + диагностика opaque-кандидатов + сохранение/восстановление ленты через content.js)');
})();
