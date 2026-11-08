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

  var aiCmGeminiState = (typeof window !== 'undefined' && window.AiCmGeminiState) || null;
  if (!aiCmGeminiState) {
    debugLog('log', '[gemini-intercept] core/gemini-state.js не подключён — перехватчик Gemini не установлен');
    return;
  }
  with (aiCmGeminiState) {

  // ===== v2.0 (Phase 3 step 5): ЯДРО СОСТОЯНИЯ (ВЫНЕСЕНО В core/gemini-state.js) =====
  // Все объявления состояния (101 имя: сетевые оригиналы, turns-база, пагинация, оракул,
  // лоадер, архив, оверлей, активность, эпоха чата) живут в модуле и читаются/пишутся здесь
  // через `with (aiCmGeminiState)` — те же имена, та же переменная, без теневых копий.

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
      // v86 (ro): состояние полноты базы для гейта подавления оверлея автоскролла.
      // Только чтение — модуль их не пишет, источник правды остаётся в ядре.
      get historyFullByQuiet() { return historyFullByQuiet; },
      get reachedStart() { return reachedStart; },
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
  // ===== v2.0 (Phase 3 step 1): кластер диагностики вынесен в core/gemini-diag.js =====
  // Модуль подключён в core/background.js ПЕРЕД этим файлом и отдаёт свой API на window.
  // Уехали ТОЛЬКО диагностические функции (DIAG_TOKENS-сканер и логи холодного старта):
  // отпечатки ходов (aiCmDiagHash6/aiCmDiagTurnEdge/aiCmOrderedTurns) остались здесь — они
  // питают H9-гейт полноты (serverFirstHash/dbFirstHash), а не только логи. Инжектируем три
  // функции ядра и ЧТЕНИЕ convEpoch; записей в состояние ядра у модуля нет. Алиасы сохраняют
  // прежние имена, поэтому вызовы внутри ядра (fetch/XHR-хуки, ingest, tape-путь) не тронуты.
  var aiCmGeminiDiag = (typeof window !== 'undefined' && window.AiCmGeminiDiag) || null;
  var diagCanScan = null;
  var diagIsStream = null;
  var diagScanResponse = null;
  var aiCmEnsureColdWindow = null;
  var aiCmColdStartIngestLog = null;
  if (aiCmGeminiDiag) {
    aiCmGeminiDiag.__bind({
      // Функции ядра (декларации хойстятся — значения доступны на момент bind).
      getConvId: getConvId,
      aiCmOrderedTurns: aiCmOrderedTurns,
      aiCmDiagTurnEdge: aiCmDiagTurnEdge,
      // Живое состояние ядра: геттеры/сеттеры, чтобы чтение и запись модуля
      // видели ОДНИ И ТЕ ЖЕ переменные IIFE (не копии значений).
      get convEpoch() { return convEpoch; },
    });
    diagCanScan = aiCmGeminiDiag.diagCanScan;
    diagIsStream = aiCmGeminiDiag.diagIsStream;
    diagScanResponse = aiCmGeminiDiag.diagScanResponse;
    aiCmEnsureColdWindow = aiCmGeminiDiag.aiCmEnsureColdWindow;
    aiCmColdStartIngestLog = aiCmGeminiDiag.aiCmColdStartIngestLog;
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с тем же id: MV3 не перечитывает js[] под существующим id).
    // Деградация мягкая: диагностика выключается, функциональные пути не задеты —
    // отпечатки ходов и счётчики сканирования считаются в ядре.
    debugLog('log', '[gemini-intercept] core/gemini-diag.js не подключён — ' +
      'диагностика токенов и логи холодного старта недоступны (проверьте регистрацию content script)');
    diagCanScan = function () { return false; };
    diagIsStream = function () { return false; };
    diagScanResponse = function () { };
    aiCmEnsureColdWindow = function () { };
    aiCmColdStartIngestLog = function () { };
  }
  // ===== v2.0 (Phase 3 step 5): кластер RPC вынесен в core/gemini-rpc.js =====
  // Модуль подключён в core/background.js ПЕРЕД этим файлом и отдаёт свой API на window.
  // Уехали ДВЕ группы, объединённые темой RPC: (A) опознание ingest/stream-запросов
  // batchexecute (isHistoryRpc/isIngestRpc/streamRpcidOf/provisionalStreamIngest…) и
  // (B) метаданные НАШИХ RPC-запросов к истории (captureHeadersFromInit/convIdFromBody/
  // rememberSiteMeta/buildActiveBody*/buildActiveUrl). Оркестрация пагинации
  // (paginateLoop, runCompletenessProbe, watchdog, activeRefresh) осталась здесь — она лишь
  // пользуется buildActive* через алиасы. Инжектируем две функции ядра и ЖИВОЕ состояние
  // activeSeq/lastAtEncoded/lastBaseUrl/lastHeaders/lastReqId (геттеры+сеттеры): эти пять
  // переменных читает и восстанавливает не только кластер, поэтому копией их отдавать нельзя.
  var aiCmGeminiRpc = (typeof window !== 'undefined' && window.AiCmGeminiRpc) || null;
  var isHistoryRpc = null;
  var isConversationFeedRpc = null;
  var isIngestRpc = null;
  var extractRpcIdsFromUrl = null;
  var streamRpcidOf = null;
  var isStreamIngestRpc = null;
  var streamGetLogic = null;
  var provisionalStreamIngest = null;
  var captureHeadersFromInit = null;
  var parseAtFromBody = null;
  var parseReqIdFromUrl = null;
  var convIdFromBody = null;
  var diagCursorFromBody = null;
  var shadowCursorFromRest = null;
  var rememberSiteMeta = null;
  var captureModelSlugFromBody = null;
  var buildActiveBodyWith = null;
  var buildActiveBody = null;
  var buildActiveUrl = null;
  if (aiCmGeminiRpc) {
    aiCmGeminiRpc.__bind({
      // Функции ядра (декларации хойстятся — значения доступны на момент bind).
      getConvId: getConvId,
      ingest: aiCmIngestFwd,
      // Живое состояние ядра: геттеры/сеттеры, чтобы чтение и запись модуля
      // видели ОДНИ И ТЕ ЖЕ переменные IIFE (не копии значений).
      get activeSeq() { return activeSeq; }, set activeSeq(v) { activeSeq = v; },
      get lastAtEncoded() { return lastAtEncoded; }, set lastAtEncoded(v) { lastAtEncoded = v; },
      get lastBaseUrl() { return lastBaseUrl; }, set lastBaseUrl(v) { lastBaseUrl = v; },
      get lastHeaders() { return lastHeaders; }, set lastHeaders(v) { lastHeaders = v; },
      get lastReqId() { return lastReqId; }, set lastReqId(v) { lastReqId = v; },
    });
    isHistoryRpc = aiCmGeminiRpc.isHistoryRpc;
    isConversationFeedRpc = aiCmGeminiRpc.isConversationFeedRpc;
    isIngestRpc = aiCmGeminiRpc.isIngestRpc;
    extractRpcIdsFromUrl = aiCmGeminiRpc.extractRpcIdsFromUrl;
    streamRpcidOf = aiCmGeminiRpc.streamRpcidOf;
    isStreamIngestRpc = aiCmGeminiRpc.isStreamIngestRpc;
    streamGetLogic = aiCmGeminiRpc.streamGetLogic;
    provisionalStreamIngest = aiCmGeminiRpc.provisionalStreamIngest;
    captureHeadersFromInit = aiCmGeminiRpc.captureHeadersFromInit;
    parseAtFromBody = aiCmGeminiRpc.parseAtFromBody;
    parseReqIdFromUrl = aiCmGeminiRpc.parseReqIdFromUrl;
    convIdFromBody = aiCmGeminiRpc.convIdFromBody;
    diagCursorFromBody = aiCmGeminiRpc.diagCursorFromBody;
    shadowCursorFromRest = aiCmGeminiRpc.shadowCursorFromRest;
    rememberSiteMeta = aiCmGeminiRpc.rememberSiteMeta;
    buildActiveBodyWith = aiCmGeminiRpc.buildActiveBodyWith;
    buildActiveBody = aiCmGeminiRpc.buildActiveBody;
    buildActiveUrl = aiCmGeminiRpc.buildActiveUrl;
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id).
    // Деградация мягкая: опознание RPC и метаданные запроса выключаются, но ядро
    // остаётся рабочим — ingest-путь и лоадер живут без этого кластера, а пагинация
    // и так защищена гейтом no-meta (lastAtEncoded/lastBaseUrl/lastHeaders пусты).
    debugLog('log', '[gemini-intercept] core/gemini-rpc.js не подключён — ' +
      'опознание RPC и метаданные запроса недоступны (проверьте регистрацию content script)');
    isHistoryRpc = function () { return false; };
    isConversationFeedRpc = function () { return false; };
    isIngestRpc = function () { return false; };
    extractRpcIdsFromUrl = function () { return ''; };
    streamRpcidOf = function () { return ''; };
    isStreamIngestRpc = function () { return false; };
    streamGetLogic = function () { return null; };
    provisionalStreamIngest = function () { return 0; };
    captureHeadersFromInit = function () { return {}; };
    parseAtFromBody = function () { return ''; };
    parseReqIdFromUrl = function () { return 0; };
    convIdFromBody = function () { return ''; };
    diagCursorFromBody = function () { };
    shadowCursorFromRest = function () { return null; };
    rememberSiteMeta = function () { };
    captureModelSlugFromBody = function () { return ''; };
    buildActiveBodyWith = function () { return ''; };
    buildActiveBody = function () { return ''; };
    buildActiveUrl = function () { return ''; };
  }
  // v2.0.20: слаг модели из тела сети → content.js. Этот файл исполняется в MAIN world
  // (core/background.js: world:'MAIN'), а detectedModelSlug — переменная ИЗОЛИРОВАННОГО мира
  // (core/state.js:87, пишется core/content.js:686 и core/widget.js:192): напрямую из MAIN world
  // она недоступна, поэтому мост — событие на window, ровно как ai-cm-full-history.
  // Чистое извлечение — core/gemini-rpc.js:captureModelSlugFromBody (без зависимостей).
  if (aiCmGeminiRpc) {
    captureModelSlugFromBody = function (str) {
      var slug = aiCmGeminiRpc.captureModelSlugFromBody(str);
      if (slug) {
        try { window.dispatchEvent(new CustomEvent('ai-cm-model-slug', { detail: { slug: slug } })); } catch (e) { }
      }
      return slug;
    };
  }
  // ===== v2.0 (Phase 3 step 6): кластер парсеров кадра вынесен в core/gemini-parse.js =====
  // Модуль подключён в core/background.js ПЕРЕД этим файлом и отдаёт свой API на window.
  // Уехала группа «входные байты → ходы»: parseByBytes/parseByLines/parseBatchExecute вместе с
  // tolerant-salvage обрезанного кадра (isTurnLikeSpan/noteJsonChild/closeTruncatedJson/
  // unescapeJsonLiteralPrefix/extractTruncatedInner/handleSalvagedOuter/salvagePartialFrame).
  // Оркестрация хода (handleOuter) ОСТАЛАСЬ здесь и инжектируется модулю: парсеры лишь зовут её,
  // когда кадр разобран. Живое состояние отдаём геттерами/сеттерами, а не значениями:
  // lastFrameParseFail читают ingest и диагностика ядра, а четыре флага полноты
  // (historyFullByQuiet/reachedStart/quietDecisionMade/quietIncompleteNoStart) читает и пишет
  // оркестрация пагинации в ядре — копии значений разошлись бы с оригиналом.
  var aiCmGeminiParse = (typeof window !== 'undefined' && window.AiCmGeminiParse) || null;
  var parseByBytes = null;
  var parseByLines = null;
  var parseBatchExecute = null;
  var handleSalvagedOuter = null;
  var salvagePartialFrame = null;
  if (aiCmGeminiParse) {
    aiCmGeminiParse.__bind({
      // handleOuter — функция ядра (декларация хойстится: значение доступно на момент bind).
      handleOuter: aiCmHandleOuterFwd,
      // lastFrameParseFail — читает ingest (O-48) и диагностика: сеттер обязателен.
      get lastFrameParseFail() { return lastFrameParseFail; }, set lastFrameParseFail(v) { lastFrameParseFail = v; },
      // Флаги полноты: их читает и пишет оркестрация в ядре, а трогает — только
      // handleSalvagedOuter, когда откатывает полноту на восстановленном (обрезанном) кадре.
      get historyFullByQuiet() { return historyFullByQuiet; }, set historyFullByQuiet(v) { historyFullByQuiet = v; },
      get reachedStart() { return reachedStart; }, set reachedStart(v) { reachedStart = v; },
      get quietDecisionMade() { return quietDecisionMade; }, set quietDecisionMade(v) { quietDecisionMade = v; },
      get quietIncompleteNoStart() { return quietIncompleteNoStart; }, set quietIncompleteNoStart(v) { quietIncompleteNoStart = v; },
    });
    parseByBytes = aiCmGeminiParse.parseByBytes;
    parseByLines = aiCmGeminiParse.parseByLines;
    parseBatchExecute = aiCmGeminiParse.parseBatchExecute;
    handleSalvagedOuter = aiCmGeminiParse.handleSalvagedOuter;
    salvagePartialFrame = aiCmGeminiParse.salvagePartialFrame;
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний registration
    // с прежним id: MV3 не перечитывает js[] под существующим id). Деградация мягкая — без
    // падений, но парсинг кадров при этом выключен ЦЕЛИКОМ (не только tolerant-salvage):
    // parseBatchExecute отдаёт пустой список ходов, и ingest получает 0 ходов. Увидели это
    // сообщение в консоли — перезагрузите расширение (или поднимите id в core/background.js).
    debugLog('log', '[gemini-intercept] core/gemini-parse.js не подключён — ' +
      'парсинг кадров batchexecute недоступен (проверьте регистрацию content script)');
    parseByBytes = function () { };
    parseByLines = function () { };
    parseBatchExecute = function () { return []; };
    handleSalvagedOuter = function () { };
    salvagePartialFrame = function () { return 0; };
  }

  // ===== v2.0 (Phase 3 step 9): SSE-кластер (перехват сети) вынесен в core/gemini-sse.js =====
  // Модуль подключён в core/background.js ПЕРЕД этим файлом и отдаёт свой API на window.
  // Уехала ТОЛЬКО установка врапперов: подмена window.fetch (batchexecute: метаданные запроса,
  // гард stale-conv на ответе, stream-ingest, DIAG_TOKENS-скан, тихий catch) и подмена
  // OriginalXHR.prototype.open/setRequestHeader/send. Ингест, оркестрация пагинации,
  // диагностика и опознание RPC остались в ядре и своих модулях: функции приходят в модуль
  // значениями, а ЖИВОЕ состояние — геттерами/сеттерами (currentConvId/convEpoch/
  // autoScrollBlocked/autoScrollUnblockTimer/diagScannedCount), потому что его читает и пишет
  // не только кластер (pushState-сброс, лоадер, ingest) — копия значения разошлась бы с
  // оригиналом. Алиас installNetworkHooks сохраняет прежнее МЕСТО установки врапперов.
  var aiCmGeminiSse = (typeof window !== 'undefined' && window.AiCmGeminiSse) || null;
  var installNetworkHooks = null;
  if (aiCmGeminiSse) {
    aiCmGeminiSse.__bind({
      // Функции ядра (декларации хойстятся — значения доступны на момент bind).
      ingest: aiCmIngestFwd,
      getConvId: getConvId,
      // Алиасы соседних модулей (rpc/diag): к этому моменту уже назначены выше.
      isHistoryRpc: isHistoryRpc,
      isIngestRpc: isIngestRpc,
      convIdFromBody: convIdFromBody,
      captureHeadersFromInit: captureHeadersFromInit,
      rememberSiteMeta: rememberSiteMeta,
      captureModelSlugFromBody: captureModelSlugFromBody,
      isStreamIngestRpc: isStreamIngestRpc,
      streamRpcidOf: streamRpcidOf,
      provisionalStreamIngest: provisionalStreamIngest,
      diagCanScan: diagCanScan,
      diagIsStream: diagIsStream,
      diagScanResponse: diagScanResponse,
      // Оригиналы сети, снятые ядром в начале его IIFE: модуль патчит ими прототипы.
      originalFetch: originalFetch,
      OriginalXHR: OriginalXHR,
      originalXHROpen: originalXHROpen,
      originalXHRSend: originalXHRSend,
      originalSetHeader: originalSetHeader,
      // Живое состояние ядра: геттеры/сеттеры, чтобы чтение и запись модуля
      // видели ОДНИ И ТЕ ЖЕ переменные IIFE (не копии значений).
      get currentConvId() { return currentConvId; },
      get convEpoch() { return convEpoch; },
      get autoScrollBlocked() { return autoScrollBlocked; }, set autoScrollBlocked(v) { autoScrollBlocked = v; },
      get autoScrollUnblockTimer() { return autoScrollUnblockTimer; }, set autoScrollUnblockTimer(v) { autoScrollUnblockTimer = v; },
      get diagScannedCount() { return diagScannedCount; }, set diagScannedCount(v) { diagScannedCount = v; },
      get DIAG_MAX_SCANNED() { return DIAG_MAX_SCANNED; },
    });
    installNetworkHooks = aiCmGeminiSse.installNetworkHooks;
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id).
    // Деградация мягкая: страница работает как обычно, но пассивные снимки (fetch/XHR)
    // в ingest не попадают — история собирается активными путями (vf5/пагинация/лоадер).
    debugLog('log', '[gemini-intercept] core/gemini-sse.js не подключён — ' +
      'перехват сети (fetch/XHR) недоступен, пассивные снимки не ингестятся (проверьте регистрацию content script)');
    installNetworkHooks = function () { };
  }

  // ===== v2.0 (Phase 3 step 10): кластер пагинации подключён из core/pagination/pagination.js =====
  // Модуль отдан в js[] core/background.js ПОСЛЕ core/gemini-sse.js и ПЕРЕД этим файлом.
  // Функции приходят значениями (декларации ядра хойстятся — bind выполняется ниже их
  // объявлений, а ссылки на них в теле __bind разрешаются на момент вызова). Состояние —
  // геттерами/сеттерами: почти каждая переменная читается и пишется вне кластера (ingest,
  // rontgenPagination, notifyLoaderState, loadFullHistoryInvisibly, emitBaseSnapshot),
  // поэтому копия значения разошлась бы с оригиналом ровно там, где ошибается полнота.
  // ro-хватает геттера: кластер их не пишет (проверено tools/analyze-pagination-bind.js).
  var aiCmGeminiPagination = (typeof window !== 'undefined' && window.AiCmGeminiPagination) || null;
  var classifyOpaque = null;
  var edges8 = null;
  var walkOpaque = null;
  var findCursors = null;
  var extractCursor = null;
  var classifyOpaqueWide = null;
  var extractCursorWide = null;
  var refreshMinOrderTracking = null;
  var paginateLoop = null;
  var finishQuiet = null;
  var runCompletenessProbe = null;
  var runCompletenessWatchdog = null;
  var finishWatchdogDecision = null;
  if (aiCmGeminiPagination) {
    aiCmGeminiPagination.__bind({
      // Функции ядра.
      originalFetch: originalFetch,
      scheduleAutoScroll: scheduleAutoScroll,
      shadowCursorFromRest: shadowCursorFromRest,
      buildActiveBodyWith: buildActiveBodyWith,
      buildActiveUrl: buildActiveUrl,
      parseBatchExecute: parseBatchExecute,
      loadFloor: loadFloor,
      getConvId: getConvId,
      captureReqTag: captureReqTag,
      isStaleReqTag: isStaleReqTag,
      baseSize: baseSize,
      aiCmDiagHash6: aiCmDiagHash6,
      aiCmDiagTurnEdge: aiCmDiagTurnEdge,
      aiCmOrderedTurns: aiCmOrderedTurns,
      aiCmSetScrollOverlay: aiCmSetScrollOverlay,
      maybeStartLoader: aiCmMaybeStartLoaderFwd,
      activeRefresh: activeRefresh,
      aiCmArchiveTierApply: aiCmArchiveTierApply,
      emitBaseSnapshot: aiCmEmitBaseSnapshotFwd,
      ingest: aiCmIngestFwd,
      // Живое состояние: геттеры/сеттеры.
      get quietActive() { return quietActive; }, set quietActive(v) { quietActive = v; },
      get historyFullByQuiet() { return historyFullByQuiet; }, set historyFullByQuiet(v) { historyFullByQuiet = v; },
      get reachedStart() { return reachedStart; }, set reachedStart(v) { reachedStart = v; },
      get reachedStartByScroll() { return reachedStartByScroll; }, set reachedStartByScroll(v) { reachedStartByScroll = v; },
      get quietPaginated() { return quietPaginated; }, set quietPaginated(v) { quietPaginated = v; },
      get quietDecisionMade() { return quietDecisionMade; }, set quietDecisionMade(v) { quietDecisionMade = v; },
      get quietIncompleteNoStart() { return quietIncompleteNoStart; }, set quietIncompleteNoStart(v) { quietIncompleteNoStart = v; },
      get lastCycleEndedHidden() { return lastCycleEndedHidden; }, set lastCycleEndedHidden(v) { lastCycleEndedHidden = v; },
      get pendingCursor() { return pendingCursor; }, set pendingCursor(v) { pendingCursor = v; },
      get lastHeadToken() { return lastHeadToken; }, set lastHeadToken(v) { lastHeadToken = v; },
      get lastGoodWideCur() { return lastGoodWideCur; }, set lastGoodWideCur(v) { lastGoodWideCur = v; },
      get lastGoodProbeMeta() { return lastGoodProbeMeta; }, set lastGoodProbeMeta(v) { lastGoodProbeMeta = v; },
      get lastOlderNonPagAddAt() { return lastOlderNonPagAddAt; }, set lastOlderNonPagAddAt(v) { lastOlderNonPagAddAt = v; },
      get minOrderSeen() { return minOrderSeen; }, set minOrderSeen(v) { minOrderSeen = v; },
      get cursorEpoch() { return cursorEpoch; }, set cursorEpoch(v) { cursorEpoch = v; },
      get olderHistorySeen() { return olderHistorySeen; }, set olderHistorySeen(v) { olderHistorySeen = v; },
      get loggedMultiCursor() { return loggedMultiCursor; }, set loggedMultiCursor(v) { loggedMultiCursor = v; },
      get lastPagStepBroken() { return lastPagStepBroken; }, set lastPagStepBroken(v) { lastPagStepBroken = v; },
      get pagErrorRetries() { return pagErrorRetries; }, set pagErrorRetries(v) { pagErrorRetries = v; },
      get quietErrStreak() { return quietErrStreak; }, set quietErrStreak(v) { quietErrStreak = v; },
      get nativeEscalationFor() { return nativeEscalationFor; }, set nativeEscalationFor(v) { nativeEscalationFor = v; },
      get quietEndedClean() { return quietEndedClean; }, set quietEndedClean(v) { quietEndedClean = v; },
      get lastHeaders() { return lastHeaders; }, set lastHeaders(v) { lastHeaders = v; },
      get lastAtEncoded() { return lastAtEncoded; }, set lastAtEncoded(v) { lastAtEncoded = v; },
      get lastBaseUrl() { return lastBaseUrl; }, set lastBaseUrl(v) { lastBaseUrl = v; },
      get aiCmRerunOverlayTimer() { return aiCmRerunOverlayTimer; }, set aiCmRerunOverlayTimer(v) { aiCmRerunOverlayTimer = v; },
      // Только чтение: кластер не присваивает (ro) — сеттер не нужен.
      get turnsMap() { return turnsMap; },
      get lastBaseTextLen() { return lastBaseTextLen; },
      get lastCursorSource() { return lastCursorSource; },
      get serverFirstHash() { return serverFirstHash; },
      get completenessWatchdogRetries() { return completenessWatchdogRetries; },
      get watchdogFiredMap() { return watchdogFiredMap; },
      get PAGINATE_CAP() { return PAGINATE_CAP; },
      get PAGINATE_TIME_CAP_MS() { return PAGINATE_TIME_CAP_MS; },
      get paginationRun() { return paginationRun; },
      get lastPaginateOpaqueCandidates() { return lastPaginateOpaqueCandidates; },
      get lastPaginateOuter() { return lastPaginateOuter; },
      get lastAllStrings() { return lastAllStrings; },
      get lastFailedSkeleton() { return lastFailedSkeleton; },
      get lastHnvPageError() { return lastHnvPageError; },
      get PAGINATE_ERROR_RETRY_CAP() { return PAGINATE_ERROR_RETRY_CAP; },
      get PAGINATE_ERROR_BACKOFF_MS() { return PAGINATE_ERROR_BACKOFF_MS; },
      get lastFrameParseFail() { return lastFrameParseFail; },
      get nativeEscalationUsedMap() { return nativeEscalationUsedMap; },
      get loaderDoneMap() { return loaderDoneMap; },
      get loaderRunningFor() { return loaderRunningFor; },
      get oracleIncompleteSeen() { return oracleIncompleteSeen; },
      get parserVersion() { return parserVersion; },
      get tapeWasUsedInThisColdStart() { return tapeWasUsedInThisColdStart; },
      get loaderState() { return loaderState; },
      get aiCmScrollOverlay() { return aiCmScrollOverlay; },
    });
    classifyOpaque = aiCmGeminiPagination.classifyOpaque;
    edges8 = aiCmGeminiPagination.edges8;
    walkOpaque = aiCmGeminiPagination.walkOpaque;
    findCursors = aiCmGeminiPagination.findCursors;
    extractCursor = aiCmGeminiPagination.extractCursor;
    classifyOpaqueWide = aiCmGeminiPagination.classifyOpaqueWide;
    extractCursorWide = aiCmGeminiPagination.extractCursorWide;
    refreshMinOrderTracking = aiCmGeminiPagination.refreshMinOrderTracking;
    paginateLoop = aiCmGeminiPagination.paginateLoop;
    finishQuiet = aiCmGeminiPagination.finishQuiet;
    runCompletenessProbe = aiCmGeminiPagination.runCompletenessProbe;
    runCompletenessWatchdog = aiCmGeminiPagination.runCompletenessWatchdog;
    finishWatchdogDecision = aiCmGeminiPagination.finishWatchdogDecision;
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id). Деградация
    // мягкая: докачивание полной истории и контроль полноты выключены, активные пути
    // (vf5/лоадер скрытого скролла) продолжают собирать базу как обычно.
    debugLog('log', '[gemini-intercept] core/pagination/pagination.js не подключён — ' +
      'тихая пагинация и контроль полноты (probe/watchdog) недоступны (проверьте регистрацию content script)');
    classifyOpaque = function () { return false; };
    edges8 = function (s) { return String(s); };
    walkOpaque = function () { };
    findCursors = function (node, out) { if (out) out.length = 0; };
    extractCursor = function () { return null; };
    classifyOpaqueWide = function () { return false; };
    extractCursorWide = function () { return null; };
    refreshMinOrderTracking = function () { };
    paginateLoop = function () { };
    finishQuiet = function () { };
    runCompletenessProbe = function () { };
    runCompletenessWatchdog = function () { };
    finishWatchdogDecision = function () { };
  }

  // ===== v2.0 (Phase 3 step 11): кластер лоадера подключён из core/gemini-loader-scroll.js =====
  // Модуль идёт в js[] core/background.js ПОСЛЕ core/pagination/pagination.js и ПЕРЕД этим
  // файлом. Блок стоит ЗДЕСЬ, а не рядом с алиасами скрытого скролла (строка ~120): часть
  // зависимостей — это не объявления, а значения, которые заполняют чужие __bind-блоки.
  // findScrollContainer (var, строка 123), extractCursorWide (403), paginateLoop (405) и
  // runCompletenessProbe (407) объявлены как `var ... = null;` и получают значение в блоках
  // скрытого скролла и пагинации — выше строки 520 четыре зависимости уехали бы в модуль как
  // null. Функции (kind=fn) передаются значениями: их объявления хойстятся и к моменту
  // __bind уже существуют. Состояние передаётся ЖИВЫМИ геттерами/сеттерами: прогон лоадера
  // читается и пишется и здесь (stable-stop оракул, сброс бюджета коллапс-ретраев при смене
  // чата, активный vf5-путь), и копия разошлась бы с оригиналом там, где ошибается полнота.
  // Состояние прогона (loaderState, lastLoaderDoneReason, collapseRetries,
  // loaderRetryUsedMap) вынесено в core/gemini-state.js (см. баннер ниже по файлу).
  // Автозапуск отдаётся пагинации ФОРВАРДЕРОМ: её __bind выполняется раньше (строка 411),
  // поэтому прямое `maybeStartLoader: maybeStartLoader` зафиксировало бы null.
  var aiCmGeminiLoaderScroll = (typeof window !== 'undefined' && window.AiCmGeminiLoaderScroll) || null;
  var maybeStartLoader = null;
  var loadFullHistoryInvisibly = null; // ядро его не вызывает: консольный хэндл ставит сам модуль
  function aiCmMaybeStartLoaderFwd() { return maybeStartLoader ? maybeStartLoader() : undefined; }
  if (aiCmGeminiLoaderScroll) {
    aiCmGeminiLoaderScroll.__bind({
      // Функции ядра.
      aiCmArchiveFor: aiCmArchiveFor,
      aiCmArchiveLiveProven: aiCmArchiveLiveProven,
      aiCmDiagTurnEdge: aiCmDiagTurnEdge,
      aiCmLiveTurnCount: aiCmLiveTurnCount,
      aiCmOrderedTurns: aiCmOrderedTurns,
      aiCmSetScrollOverlay: aiCmSetScrollOverlay,
      baseSize: baseSize,
      extractCursorWide: extractCursorWide,
      findScrollContainer: findScrollContainer,
      getConvId: getConvId,
      loadFloor: loadFloor,
      notifyLoaderState: notifyLoaderState,
      paginateLoop: paginateLoop,
      runCompletenessProbe: runCompletenessProbe,
      saveFloor: saveFloor,
      selfHealFloor: selfHealFloor,
      sleep: sleep,
      // Живое состояние: геттеры/сеттеры.
      get aiCmOverlaySeq() { return aiCmOverlaySeq; },
      set aiCmOverlaySeq(v) { aiCmOverlaySeq = v; },
      get aiCmScrollOverlay() { return aiCmScrollOverlay; },
      set aiCmScrollOverlay(v) { aiCmScrollOverlay = v; },
      get collapseRetries() { return collapseRetries; },
      set collapseRetries(v) { collapseRetries = v; },
      get historyFullByQuiet() { return historyFullByQuiet; },
      set historyFullByQuiet(v) { historyFullByQuiet = v; },
      get isLowConfidenceBase() { return isLowConfidenceBase; },
      set isLowConfidenceBase(v) { isLowConfidenceBase = v; },
      get lastCleanEndBaseCount() { return lastCleanEndBaseCount; },
      set lastCleanEndBaseCount(v) { lastCleanEndBaseCount = v; },
      get lastCycleEndedHidden() { return lastCycleEndedHidden; },
      set lastCycleEndedHidden(v) { lastCycleEndedHidden = v; },
      get lastLoaderDoneReason() { return lastLoaderDoneReason; },
      set lastLoaderDoneReason(v) { lastLoaderDoneReason = v; },
      get loaderRetryUsedMap() { return loaderRetryUsedMap; },
      set loaderRetryUsedMap(v) { loaderRetryUsedMap = v; },
      get loaderRunningFor() { return loaderRunningFor; },
      set loaderRunningFor(v) { loaderRunningFor = v; },
      get loaderState() { return loaderState; },
      set loaderState(v) { loaderState = v; },
      get pendingCursor() { return pendingCursor; },
      set pendingCursor(v) { pendingCursor = v; },
      get quietActive() { return quietActive; },
      set quietActive(v) { quietActive = v; },
      get quietDecisionMade() { return quietDecisionMade; },
      set quietDecisionMade(v) { quietDecisionMade = v; },
      get quietIncompleteNoStart() { return quietIncompleteNoStart; },
      set quietIncompleteNoStart(v) { quietIncompleteNoStart = v; },
      get reachedStart() { return reachedStart; },
      set reachedStart(v) { reachedStart = v; },
      get vf5OverlapSinceLoaderStart() { return vf5OverlapSinceLoaderStart; },
      set vf5OverlapSinceLoaderStart(v) { vf5OverlapSinceLoaderStart = v; },
      // Только чтение: кластер эти имена не присваивает (ro) — сеттер не нужен.
      get cacheRestoredMap() { return cacheRestoredMap; },
      get cursorEpoch() { return cursorEpoch; },
      get lastAtEncoded() { return lastAtEncoded; },
      get lastBaseCountChangeAt() { return lastBaseCountChangeAt; },
      get lastBaseTextLen() { return lastBaseTextLen; },
      get lastBaseUrl() { return lastBaseUrl; },
      get lastGoodProbeMeta() { return lastGoodProbeMeta; },
      get lastGoodWideCur() { return lastGoodWideCur; },
      get lastHeaders() { return lastHeaders; },
      get lastHnvPageError() { return lastHnvPageError; },
      get lastOlderNonPagAddAt() { return lastOlderNonPagAddAt; },
      get lastPaginateOuter() { return lastPaginateOuter; },
      get loaderDoneMap() { return loaderDoneMap; },
      get nativeEscalationFor() { return nativeEscalationFor; },
      get olderHistorySeen() { return olderHistorySeen; },
      get oracleIncompleteSeen() { return oracleIncompleteSeen; },
      get oracleRerunUsedMap() { return oracleRerunUsedMap; },
      get parserVersion() { return parserVersion; },
      get quietEndedClean() { return quietEndedClean; },
      get serverFirstHash() { return serverFirstHash; },
      get tapeWasUsedInThisColdStart() { return tapeWasUsedInThisColdStart; },
    });
    maybeStartLoader = aiCmGeminiLoaderScroll.maybeStartLoader;
    loadFullHistoryInvisibly = aiCmGeminiLoaderScroll.loadFullHistoryInvisibly;
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id). Деградация
    // заметная: скрытый доскролл полной истории и его автозапуск выключены — база
    // собирается активными путями (vf5 / тихая пагинация) без докрутки до начала чата.
    debugLog('log', '[gemini-intercept] core/gemini-loader-scroll.js не подключён — ' +
      'скрытый доскролл полной истории и его автозапуск недоступны (проверьте регистрацию content script)');
    maybeStartLoader = function () { };
  }



  // ===== v2.0 (Phase 3 step 12): ingest-кластер подключён из core/gemini-ingest.js =====
  // Объявления кластера удалены из ядра; их место занял объект связи ниже.
  // Блок стоит ПОСЛЕ ветки else лоадера (строка 631), потому что 11 поздних
  // алиасов дозаполняются блоками ранних модулей — только к этому месту все они живые.
  // Состояние передаётся ЖИВЫМИ геттерами/сеттерами: кластер пишет в эти переменные,
  // и при передаче копией (обычным свойством) ядро читало бы устаревшее значение.
  // Phase 3 (payload, шаг 1): структурные предикаты и хелперы payload вынесены в
  // core/gemini-payload.js. Модуль ЧИСТЫЙ (без состояния и без __bind), поэтому связка
  // ingest-модуля — просто ссылки на функции, а не контракт с геттерами.
  var aiCmGeminiPayload = (typeof window !== 'undefined' && window.AiCmGeminiPayload) || null;
  // Мягкая деградация: у профиля мог остаться прежний registration (MV3 не перечитывает
  // js[] под тем же id) — тогда модуля нет. Заглушки повторяют форму контракта, чтобы
  // __bind ingest не упал на чтении свойства null, а снимок деградировал заметно.
  if (!aiCmGeminiPayload) {
    debugLog('log', '[gemini-intercept] core/gemini-payload.js не подключён — ' +
      'структурные предикаты и сборщики payload недоступны (проверьте регистрацию content script)');
  }
  var aiCmPayload = aiCmGeminiPayload || {
    buildJsonSkeleton: function () { return null; },
    structureMap: function () { },
    collectAttachments: function () { },
    collectContent: function () { }
  };
  var aiCmGeminiIngest = (typeof window !== 'undefined' && window.AiCmGeminiIngest) || null;
  var aiCmGeminiFiles = (typeof window !== 'undefined' && window.AiCmGeminiFiles) || null;
  var ingest = null;
  var handleOuter = null;
  var emitBaseSnapshot = null;
  var mergeRestoredTurns = null;
  // Форвардеры: ядро зовёт их, а они проксируют в модуль ПОСЛЕ привязки.
  function aiCmIngestFwd(raw, opts) { return ingest ? ingest(raw, opts) : undefined; }
  function aiCmHandleOuterFwd(outer, out_, src) { return handleOuter ? handleOuter(outer, out_, src) : undefined; }
  function aiCmEmitBaseSnapshotFwd() { return emitBaseSnapshot ? emitBaseSnapshot() : undefined; }
  if (aiCmGeminiIngest) {
    aiCmGeminiIngest.__bind({
      // Функции ядра (значением).
      buildJsonSkeleton: aiCmPayload.buildJsonSkeleton,
      getConvId: getConvId,
      structureMap: aiCmPayload.structureMap,
      collectAttachments: aiCmPayload.collectAttachments,
      collectContent: aiCmPayload.collectContent,
      activeRefresh: activeRefresh,
      aiCmArchiveTierApply: aiCmArchiveTierApply,
      sanitizeMessagesForEmit: sanitizeMessagesForEmit,
      loadFloor: loadFloor,
      saveFloor: saveFloor,
      baseSize: baseSize,
      aiCmDiagHash6: aiCmDiagHash6,
      noteBaseCountChange: noteBaseCountChange,
      // Поздние алиасы: var ... = null, дозаполнены блоками ранних модулей.
      extractCursor: extractCursor,
      classifyOpaque: classifyOpaque,
      edges8: edges8,
      walkOpaque: walkOpaque,
      aiCmEnsureColdWindow: aiCmEnsureColdWindow,
      parseBatchExecute: parseBatchExecute,
      maybeStartLoader: maybeStartLoader,
      refreshMinOrderTracking: refreshMinOrderTracking,
      aiCmColdStartIngestLog: aiCmColdStartIngestLog,
      paginateLoop: paginateLoop,
      scheduleAutoScroll: scheduleAutoScroll,
      // Живое состояние: геттеры/сеттеры.
      get attachSeen() { return attachSeen; },
      set attachSeen(v) { attachSeen = v; },
      get attachBreak() { return attachBreak; },
      set attachBreak(v) { attachBreak = v; },
      get attachTokens() { return attachTokens; },
      set attachTokens(v) { attachTokens = v; },
      get lastHnvPageError() { return lastHnvPageError; },
      set lastHnvPageError(v) { lastHnvPageError = v; },
      get lastFailedSkeleton() { return lastFailedSkeleton; },
      set lastFailedSkeleton(v) { lastFailedSkeleton = v; },
      get loggedRontgen() { return loggedRontgen; },
      set loggedRontgen(v) { loggedRontgen = v; },
      get lastPaginateOuter() { return lastPaginateOuter; },
      set lastPaginateOuter(v) { lastPaginateOuter = v; },
      get pendingCursor() { return pendingCursor; },
      set pendingCursor(v) { pendingCursor = v; },
      get lastCursorSource() { return lastCursorSource; },
      set lastCursorSource(v) { lastCursorSource = v; },
      get cursorEpoch() { return cursorEpoch; },
      set cursorEpoch(v) { cursorEpoch = v; },
      get olderHistorySeen() { return olderHistorySeen; },
      set olderHistorySeen(v) { olderHistorySeen = v; },
      get historyFullByQuiet() { return historyFullByQuiet; },
      set historyFullByQuiet(v) { historyFullByQuiet = v; },
      get reachedStart() { return reachedStart; },
      set reachedStart(v) { reachedStart = v; },
      get quietIncompleteNoStart() { return quietIncompleteNoStart; },
      set quietIncompleteNoStart(v) { quietIncompleteNoStart = v; },
      get quietDecisionMade() { return quietDecisionMade; },
      set quietDecisionMade(v) { quietDecisionMade = v; },
      get lastPaginateOpaqueCandidates() { return lastPaginateOpaqueCandidates; },
      set lastPaginateOpaqueCandidates(v) { lastPaginateOpaqueCandidates = v; },
      get lastAllStrings() { return lastAllStrings; },
      set lastAllStrings(v) { lastAllStrings = v; },
      get loggedStructure() { return loggedStructure; },
      set loggedStructure(v) { loggedStructure = v; },
      get lastVf5ActivityAt() { return lastVf5ActivityAt; },
      set lastVf5ActivityAt(v) { lastVf5ActivityAt = v; },
      get lastActiveAt() { return lastActiveAt; },
      set lastActiveAt(v) { lastActiveAt = v; },
      get quietActive() { return quietActive; },
      set quietActive(v) { quietActive = v; },
      get turnsMap() { return turnsMap; },
      set turnsMap(v) { turnsMap = v; },
      get lastOrderedIds() { return lastOrderedIds; },
      set lastOrderedIds(v) { lastOrderedIds = v; },
      get lastBaseTextLen() { return lastBaseTextLen; },
      set lastBaseTextLen(v) { lastBaseTextLen = v; },
      get isLowConfidenceBase() { return isLowConfidenceBase; },
      set isLowConfidenceBase(v) { isLowConfidenceBase = v; },
      get loggedErr() { return loggedErr; },
      set loggedErr(v) { loggedErr = v; },
      get lastIngestParseFail() { return lastIngestParseFail; },
      set lastIngestParseFail(v) { lastIngestParseFail = v; },
      get vf5OverlapSinceLoaderStart() { return vf5OverlapSinceLoaderStart; },
      set vf5OverlapSinceLoaderStart(v) { vf5OverlapSinceLoaderStart = v; },
      get convEpoch() { return convEpoch; },
      set convEpoch(v) { convEpoch = v; },
      get tapeWasUsedInThisColdStart() { return tapeWasUsedInThisColdStart; },
      set tapeWasUsedInThisColdStart(v) { tapeWasUsedInThisColdStart = v; },
      get orderCounter() { return orderCounter; },
      set orderCounter(v) { orderCounter = v; },
      get prependCursor() { return prependCursor; },
      set prependCursor(v) { prependCursor = v; },
      get reachedStartByScroll() { return reachedStartByScroll; },
      set reachedStartByScroll(v) { reachedStartByScroll = v; },
      get serverFirstHash() { return serverFirstHash; },
      set serverFirstHash(v) { serverFirstHash = v; },
      get lastHeadToken() { return lastHeadToken; },
      set lastHeadToken(v) { lastHeadToken = v; },
      get lastGoodWideCur() { return lastGoodWideCur; },
      set lastGoodWideCur(v) { lastGoodWideCur = v; },
      get lastGoodProbeMeta() { return lastGoodProbeMeta; },
      set lastGoodProbeMeta(v) { lastGoodProbeMeta = v; },
      get quietPaginated() { return quietPaginated; },
      set quietPaginated(v) { quietPaginated = v; },
      get lastCycleEndedHidden() { return lastCycleEndedHidden; },
      set lastCycleEndedHidden(v) { lastCycleEndedHidden = v; },
      get loggedOk() { return loggedOk; },
      set loggedOk(v) { loggedOk = v; },
      get loggedAttach() { return loggedAttach; },
      set loggedAttach(v) { loggedAttach = v; },
      // Только чтение: кластер эти имена не присваивает — сеттер не нужен.
      get idmapCalls() { return idmapCalls; },
      get scrollRecentUntil() { return scrollRecentUntil; },
      get loaderRunningFor() { return loaderRunningFor; },
      get loaderDoneMap() { return loaderDoneMap; },
      get lastFrameParseFail() { return lastFrameParseFail; },
      get loaderRetryUsedMap() { return loaderRetryUsedMap; },
      get parserVersion() { return parserVersion; },
    });
    ingest = aiCmGeminiIngest.ingest;
    handleOuter = aiCmGeminiIngest.handleOuter;
    emitBaseSnapshot = aiCmGeminiIngest.emitBaseSnapshot;
    mergeRestoredTurns = aiCmGeminiIngest.mergeRestoredTurns;
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id).
    // Деградация заметная: приём снимков базы выключен целиком, в консоли внятный лог.
    debugLog('log', '[gemini-intercept] core/gemini-ingest.js не подключён — ' +
      'приём снимков базы и выход снимка недоступны (проверьте регистрацию content script)');
    ingest = function () { };
    handleOuter = function () { };
    emitBaseSnapshot = function () { };
    mergeRestoredTurns = function () { };
  }
  // v2.0 (Gemini files): модуль скачивания вложений. Биндим ПОСЛЕ ingest-кластера:
  // emitSnapshot — форвардер окончательного снимка (модуль зовёт его после текста
  // файла), originalFetch — нативный fetch MAIN-мира, getConvId — граница чата.
  if (aiCmGeminiFiles && typeof aiCmGeminiFiles.__bind === 'function') {
    try {
      aiCmGeminiFiles.__bind({
        emitSnapshot: aiCmEmitBaseSnapshotFwd,
        getConvId: getConvId,
        originalFetch: originalFetch,
        diagLine: function (tag, fields) {
          try {
            debugLog('log', '[gemini-files] ' + String(tag || '') + ' ' + JSON.stringify(fields || {}));
          } catch (eDiagGF) { }
        }
      });
    } catch (eBindGF) {
      debugLog('log', '[gemini-intercept] gemini-files __bind не удался: ' + (eBindGF && eBindGF.message || eBindGF));
    }
  }
  // v33: флаг «Подробные логи» транслируется из content.js (ISOLATED) через CustomEvent
  // (в MAIN-мире chrome.storage недоступен — как в остальных перехватчиках)
  try { window.addEventListener('ai-cm-debug-logs', function (ev) { __aiCmSetDebugLogs(!!(ev && ev.detail)); }); } catch (e) { }

  // ===== v2.0 (Phase 3 step 5): накопители вложений и база turns — в core/gemini-state.js =====

  // ===== v2.0 (Phase 3 step 5): счётчики диагностики, рентген id и автоскролл — в core/gemini-state.js =====

  // ===== v2.0 (Phase 3 step 5): тихая пагинация и головной курсор — в core/gemini-state.js =====
  // ===== v2.0 (Phase 3 step 5): retain-last-good, счётчик базы и floor-confirmed — в core/gemini-state.js =====
  // ===== v2.0 (Phase 3 step 13.3): ОРАКУЛ ПОЛНОТЫ (ВЫНЕСЕН В core/gemini-oracle.js) =====
  // Здесь были источник полноты floor-confirmed (stableFloorConfirm), v74-трекер
  // изменения счётчика базы (noteBaseCountChange) с debounce-триггером 5500мс. Оба тела
  // живут в модуле, подключение — блоком __bind НИЖЕ (после блока архива и до
  // installNetworkHooks — как у предыдущих шагов).
  // Состояние (floorConfirmDebounceTimer) живёт в core/gemini-state.js и уезжает в модуль
  // живой парой геттер/сеттер: таймер, поставленный модулем, виден ядру той же переменной.
  // Логика сюда НЕ возвращается: правки оракула — в core/gemini-oracle.js.
  var aiCmGeminiOracle = (typeof window !== 'undefined' && window.AiCmGeminiOracle) || null;

  // Форвардеры — ИМЕННО function declaration: объявления хойстятся, поэтому вызов
  // notifyLoaderState из checkConvChange (ниже по файлу) и передачи значений в чужие
  // __bind-блоки выше этой строки (diag, rpc/parse, лоадер, пагинация, архив) не тронуты —
  // к моменту любого из них имя уже существует. Без модуля деградация безмолвная:
  // undefined вместо вердикта, ни один вызов не бросает.
  function noteBaseCountChange() { return aiCmGeminiOracle ? aiCmGeminiOracle.noteBaseCountChange() : undefined; }
  function notifyLoaderState(convId, running) { return aiCmGeminiOracle ? aiCmGeminiOracle.notifyLoaderState(convId, running) : undefined; }
  function aiCmDiagHash6(id, text) { return aiCmGeminiOracle ? aiCmGeminiOracle.aiCmDiagHash6(id, text) : undefined; }
  function aiCmDiagTurnEdge(turns, which) { return aiCmGeminiOracle ? aiCmGeminiOracle.aiCmDiagTurnEdge(turns, which) : undefined; }
  function aiCmOrderedTurns() { return aiCmGeminiOracle ? aiCmGeminiOracle.aiCmOrderedTurns() : undefined; }
  // ===== v2.0 (Phase 3 step 5): поколение курсора и счётчики пагинации — в core/gemini-state.js =====
  // ===== v2.0 (Phase 3 step 5): 1177-эскалация, clean-end и парс-фейлы — в core/gemini-state.js =====
  // ===== v2.0 (Phase 3 step 5): виртуальный F5, активность vf5 и блокировка автоскролла — в core/gemini-state.js =====

  // ===== v2.0 (Phase 3 step 5): карты лоадера и кэш-лента — в core/gemini-state.js =====
  // ===== v2.0 (Phase 3 step 5): состояние архива T1 — в core/gemini-state.js =====

  // ===== v2.0 (Phase 3 step 13.3): ОРАКУЛ ПОЛНОТЫ (ВЫНЕСЕН В core/gemini-oracle.js) =====
  // Здесь была notifyLoaderState (v42/v53/v78) с вложенным stableCheck74: состояние
  // лоадера наружу по convId (событие ai-cm-loader-state), loader-stable-stop, ветка
  // O-48 parse-fail, clean-end-подтверждение и самоунижение устаревшего пола. Тело живёт
  // в core/gemini-oracle.js, вызов из checkConvChange идёт через форвардер выше.
  // Логика сюда НЕ возвращается: правки оракула — в модуле.


  // ---- v27/vXX: пол (floor) через localStorage с версионированием по PARSER_VERSION ----
  // Ключ включает версию парсера; при несовпадении версии сохранённый пол игнорируется
  // и перезаписывается. Реализация вынесена в utils/gemini-intercept-logic.js.
  // parserVersion — в core/gemini-state.js (Phase 3, шаг 5); значение уточняется ниже.
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
      var m = location.pathname.match(/\/app\/(?!prompts(?:\/|$)|new(?:\/|$)|apikey(?:\/|$))([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  currentConvId = getConvId(); // v17: состояние — в core/gemini-state.js (Phase 3, шаг 5)

  // ===== v2.0 (Phase 3 step 5): epoch чата и флаги базы — в core/gemini-state.js =====
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
    // Phase 3 (D3-regression): сброс МУТАЦИЕЙ, а не пересозданием объектов. turnsMap/attachSeen/
    // attachBreak экспортирует core/gemini-state.js через window.AiCmGeminiState ПО ССЫЛКЕ —
    // присваивание свежего литерала подменяло бы ссылку только в объекте-состоянии, а держатели
    // старого объекта (модули через bind, снапшоты диагностики) продолжали бы писать в него:
    // новая карта оставалась пустой и бейдж не рос. delete по ключам сохраняет идентичность.
    Object.keys(turnsMap).forEach(function (k) { delete turnsMap[k]; });
    Object.keys(attachSeen).forEach(function (k) { delete attachSeen[k]; });
    attachTokens = 0;
    attachBreak.imgTokens = 0;
    attachBreak.docTokens = 0;
    attachBreak.imgCount = 0;
    attachBreak.docCount = 0;
    // Вложения принадлежат ОДНОМУ разговору: очередь и тексты не переезжают
    // в следующий чат (epoch модуля отбрасывает ответы, пришедшие после сброса).
    try {
      if (aiCmGeminiFiles && typeof aiCmGeminiFiles.gfReset === 'function') aiCmGeminiFiles.gfReset(getConvId());
    } catch (eResetGF) { }
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
    Object.keys(oracleIncompleteSeen).forEach(function (k) { delete oracleIncompleteSeen[k]; }); // v1.6 (D15): сброс при смене чата (мутация: объект экспортирован по ссылке)
    Object.keys(oracleRerunUsedMap).forEach(function (k) { delete oracleRerunUsedMap[k]; });   // v1.6 (D15)
    // v1.6 (D19): покинутый чат снимается с «уже восстановлено» — при SPA-возврате
    // лента обязана ре-мержиться (база=тейп∪сеть, голова истинная, пол не ниже сети).
    // Внутри одного непрерывного визита гард остаётся (skip reason=already-restored).
    cacheRestoredMap.clear(); // Set (v77) — как has/add в tape-restore listener, без try/catch
    // T1 (v1.16): первый ярус — смена чата: снимаем признак «архив влит» (при SPA-возврате
    // архив обязан ре-мержиться в новую базу), сами данные архива по convId не теряем —
    // они приходят от content.js и ключуются convId.
    archiveMergedMap.clear();
    // T1 (v1.16): база этого чата очищена (turnsMap опустошён) → признак «архив применён»
    // снимается, иначе при SPA-возврате архив не сможет повторно взвести
    // archive-complete (вердикт переоценится в emitBaseSnapshot после ре-мержа).
    try {
      var __cidArcReset = getConvId();
      if (__cidArcReset && archiveTierByConv[__cidArcReset]) {
        archiveTierByConv[__cidArcReset].completeApplied = false;
        archiveTierByConv[__cidArcReset].verdictLogged = '';
      }
    } catch (eArcReset) { swallowSoft(eArcReset, 'gemini:resetForNewConversation-archive-latch'); }
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
    // v68: сброс счётчиков прогона пагинации при смене чата (conv-changed → перезапуск лоадера).
    // Phase 3 (D3-regression): счётчики копируются в СУЩЕСТВУЮЩИЙ paginationRun — объект
    // экспортирован из core/gemini-state.js по ссылке, пересоздание рвало бы связку.
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.resetPaginationCounters) {
      var __prReset = window.GeminiInterceptLogic.resetPaginationCounters(paginationRun) || { pageCount: 0, startTs: 0 };
      paginationRun.pageCount = __prReset.pageCount || 0;
      paginationRun.startTs = __prReset.startTs || 0;
    } else {
      paginationRun.pageCount = 0;
      paginationRun.startTs = 0;
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

  // ===== v2.0 (Phase 3, шаг 3): SPA-ЖИЗНЕННЫЙ ЦИКЛ ЧАТА (ВЫНЕСЕН В core/gemini-spa-lifecycle.js) =====
  // Здесь были checkConvChange (сравнение свежего convId с текущим: сброс состояния,
  // инвалидация done-флага покинутого чата, автозапуск лоадера нового чата и 3-секундный
  // фолбэк бейджа) и перехваты, которые взводят детектор: history.pushState /
  // history.replaceState, window 'popstate' и document 'scroll' (scrollRecentUntil).
  // Тела живут ВНУТРИ `with (D)` BIND-зоны модуля и обращаются к состоянию ядра по
  // контракту __bind (как оракул/ingest/пагинация); связка стоит ровно на месте прежнего
  // кода, поэтому момент установки патчей history не изменился.
  // resetForNewConversation, getConvId, captureReqTag/isStaleReqTag и состояние
  // (currentConvId, convEpoch, loaderDoneMap, loaderRunningFor, scrollRecentUntil)
  // ОСТАЛИСЬ в ядре: их читают/пишут ingest, сетевые хуки, лоадер, пагинация и оракул.
  // Контракт: 7 fn значением + 3 rw-пары (currentConvId, loaderRunningFor, scrollRecentUntil)
  // + 1 ro-геттер (loaderDoneMap: тело только удаляет ключ). loaderBadgeTimer уехал вместе
  // с телом — объявления в ядре больше нет, теневой копии нет.
  var aiCmGeminiSpaLifecycle = (typeof window !== 'undefined' && window.AiCmGeminiSpaLifecycle) || null;
  if (aiCmGeminiSpaLifecycle) {
    aiCmGeminiSpaLifecycle.__bind({
      // fn: функции ядра, которые зовут тела модуля — передаются значением (хойстятся или
      // дозаполнены выше: maybeStartLoader — поздний алиас лоадера, его связка стоит выше).
      activeRefresh: activeRefresh,
      baseSize: baseSize,
      forceRestoreVisibility: forceRestoreVisibility,
      getConvId: getConvId,
      maybeStartLoader: maybeStartLoader,
      notifyLoaderState: notifyLoaderState,
      resetForNewConversation: resetForNewConversation,
      // ro: тело только удаляет ключ — мутация по ссылке видна ядру, сеттер не нужен.
      get loaderDoneMap() { return loaderDoneMap; },
      // rw: живое состояние, которое тела ПЕРЕЗАПИСЫВАЮТ (get + set).
      get currentConvId() { return currentConvId; },
      set currentConvId(v) { currentConvId = v; },
      get loaderRunningFor() { return loaderRunningFor; },
      set loaderRunningFor(v) { loaderRunningFor = v; },
      get scrollRecentUntil() { return scrollRecentUntil; },
      set scrollRecentUntil(v) { scrollRecentUntil = v; }
    });
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id).
    // Деградация заметная: SPA-смена чата не сбрасывает состояние и не перезапускает
    // лоадер — база двух чатов смешалась бы. Ровно поэтому id обязан смениться.
    debugLog('log', '[gemini-intercept] core/gemini-spa-lifecycle.js не подключён — ' +
      'SPA-смена чата не сбрасывает состояние и не перезапускает лоадер (проверьте регистрацию content script)');
  }

  function baseSize() { return Object.keys(turnsMap).length; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ===== v2.0 (Phase 3 step 13.3): ОРАКУЛ ПОЛНОТЫ (ВЫНЕСЕН В core/gemini-oracle.js) =====
  // Здесь были отпечатки краёв базы (aiCmDiagHash6 / aiCmDiagTurnEdge / aiCmOrderedTurns)
  // и регистрация window.__aiCmGeminiTurnsSnapshot. Отпечатки питают H9-гейт полноты
  // (serverFirstHash / dbFirstHash), поэтому живут в модуле, а не в диагностике; снимок
  // забирает объединённую базу через aiCmBaseExportInfo. Логика сюда НЕ возвращается.

  // ===== v2.0 (Phase 3, шаг 1): СТРУКТУРНЫЕ ПРЕДИКАТЫ И PAYLOAD (ВЫНЕСЕНЫ В core/gemini-payload.js) =====
  // Здесь были фильтры мусора (isIdLike/isFileLike/isUrlLike/isTokenLike/isMimeLike,
  // UI_BLACKLIST, isJunk, isThinking), структурный сбор вложений (collectAttachmentUrls,
  // collectAttachments), сбор текста хода (collectContent), карта структуры (structureMap)
  // и скелет непарсящейся страницы (buildJsonSkeleton). Модуль подключён в js[] ПЕРЕД
  // core/gemini-ingest.js: ingest получает четыре сборщика связкой, ядро — алиасом
  // aiCmPayload. Логика сюда НЕ возвращается: правки предикатов — в core/gemini-payload.js.

  // ================= приватный рентген id хода =================
  // ===== v2.0 (Phase 3 step 12): firstRc+logIdmap перенесено в core/gemini-ingest.js =====
  // ================================================================

  // ===== v2.0 (Phase 3 step 12): ingestAttachments перенесено в core/gemini-ingest.js =====

  // ===== v2.0 (Phase 3 step 12): extract* перенесено в core/gemini-ingest.js =====


  // ===== v2.0 (Phase 3 step 12): handleOuter перенесено в core/gemini-ingest.js =====

  // ===== v2.0 (Phase 3 step 12): rontgenPagination перенесено в core/gemini-ingest.js =====
  // ===== v2.0 (Phase 3 step 10): кластер пагинации вынесен в core/pagination/pagination.js =====
  // Здесь были extractCursor/classifyOpaque(+Wide)/findCursors/edges8/
  // refreshMinOrderTracking (core:1461-1570), paginateLoop (2612-2992), finishQuiet
  // (2993-3035), runCompletenessProbe (3037-3196), runCompletenessWatchdog
  // (3198-3275) и finishWatchdogDecision (3277-3310). Модуль подключён в
  // core/background.js ПЕРЕД этим файлом, связка (__bind + алиасы) — в блоке выше
  // (сразу после блока core/gemini-sse.js). Логика сюда НЕ возвращается: правки
  // пагинации — в модуле.

  // ===== v2.0 (Phase 3 step 6): кластер парсеров кадра вынесен в core/gemini-parse.js =====
  // Здесь были parseByBytes/parseByLines/parseBatchExecute и tolerant-salvage обрезанного кадра
  // (isTurnLikeSpan/noteJsonChild/closeTruncatedJson/unescapeJsonLiteralPrefix/
  // extractTruncatedInner/handleSalvagedOuter/salvagePartialFrame). Модуль подключён в
  // core/background.js ПЕРЕД этим файлом, связка (__bind + алиасы) — в блоке выше (сразу после
  // блока core/gemini-rpc.js). Логика сюда НЕ возвращается: правки парсеров — в модуле.

  // ================= v4y: ЛОАДЕР ПОЛНОЙ ИСТОРИИ (ВЫНЕСЕН В gemini-loader-scroll.js) =================
  // Тело кластера — баннер-описание, константы окна скролла и капа ретраев, пороги
  // вовлечения/скрытия/паузы, loadFullHistoryInvisibly со всеми вложенными помощниками,
  // ожидание сигнала «старшая история», автозапуск по открытию чата, слушатель возврата
  // видимости и консольный хэндл ручного запуска — живёт в модуле, подключение ниже.
  // Логика сюда НЕ возвращается: любые правки лоадера делаются в core/gemini-loader-scroll.js.
  // Сводное состояние прогона (loaderState и т.д.) вынесено в core/gemini-state.js: его
  // читают и пишут само ядро и пагинация, поэтому модуль получает живые геттеры/сеттеры.

  // ================= v75/v80: видимость БЕЗ скрытия DOM чата (фикс O1) =================
  // Грубое скрытие контейнера (opacity/display/visibility) ломало виртуализацию Gemini.
  // Прозрачный оверлей v75 оставлял пользователя свидетелем страховочного скролла:
  // чисто-белый (opacity=0 скроллера в v78-fallback) и «начало чата» (unhide до возврата
  // позиции). v80 (стандарт v1.14.0): НЕПРОЗРАЧНЫЙ overlay на body под тему сервиса —
  // фон + спиннер + подпись «Загрузка истории…», класс ai-cm-*. Корневые элементы чата
  // НЕ трогаются вовсе — виртуализация продолжает рендерить старшие окна; скроллер не
  // скрывается. Снятие: после loader-stop + восстановления позиции + двух rAF; безусловно
  // — на visibilitychange/pagehide/conv-switch. safety-timeout не нужен — скрывать нечего.
  // ===== v2.0 (Phase 3 step 13.1): ОВЕРЛЕЙ (ВЫНЕСЕН В core/gemini-overlay.js) =====
  // Тела кластера — определение хоста, палитра под тему сервиса, наблюдатель темы,
  // постановка/снятие оверлея, страховка видимости и слушатели pagehide/visibilitychange —
  // живут в модуле, подключение ниже. Логика сюда НЕ возвращается: правки оверлея
  // делаются в core/gemini-overlay.js.
  // Состояние (aiCmScrollOverlay/aiCmOverlaySeq/aiCmRerunOverlayTimer) вынесено вместе с
  // ядром в core/gemini-state.js: его читают и пишут пагинация, лоадер и скрытый скролл,
  // поэтому модуль получает два нужных ему имени ЖИВЫМИ геттерами/сеттерами, а не копиями.
  // Третье имя (aiCmRerunOverlayTimer) модулю не нужно вовсе — им распоряжается пагинация.
  var aiCmGeminiOverlay = (typeof window !== 'undefined' && window.AiCmGeminiOverlay) || null;

  // Форвардеры — ИМЕННО function declaration: объявления хойстятся, поэтому все прежние
  // вызовы aiCmSetScrollOverlay/forceRestoreVisibility в ядре и в чужих __bind-блоках
  // (пагинация, лоадер, скрытый скролл) не тронуты — к моменту любого из них имя уже
  // существует. Без модуля оба возвращают undefined и ни один вызов не бросает.
  function aiCmSetScrollOverlay(on, reason, expectSeq) {
    return aiCmGeminiOverlay ? aiCmGeminiOverlay.aiCmSetScrollOverlay(on, reason, expectSeq) : undefined;
  }
  function forceRestoreVisibility(reason) {
    return aiCmGeminiOverlay ? aiCmGeminiOverlay.forceRestoreVisibility(reason) : undefined;
  }

  if (aiCmGeminiOverlay) {
    aiCmGeminiOverlay.__bind({
      // Функции ядра (декларации хойстятся — значения доступны на момент bind).
      getConvId: getConvId,
      // Живое состояние ядра: геттеры/сеттеры, чтобы чтение и запись модуля
      // видели ОДНИ И ТЕ ЖЕ переменные IIFE (не копии значений).
      get aiCmScrollOverlay() { return aiCmScrollOverlay; },
      set aiCmScrollOverlay(v) { aiCmScrollOverlay = v; },
      get aiCmOverlaySeq() { return aiCmOverlaySeq; },
      set aiCmOverlaySeq(v) { aiCmOverlaySeq = v; }
    });
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id).
    // Деградация мягкая: оверлея нет, но ядро, лоадер и пагинация работают как обычно.
    debugLog('log', '[gemini-intercept] core/gemini-overlay.js не подключён — оверлей загрузки истории недоступен');
  }

  // ===== v2.0 (Phase 3, шаг 4): АКТИВНЫЙ vf5-ДОЗАПРОС + EMIT-ОБЁРТКА (ВЫНЕСЕНЫ В core/gemini-active-refresh.js) =====
  // Здесь были activeRefresh (активный POST на /app/<conv> последними at/url/headers)
  // и sanitizeMessagesForEmit (дедуп массива на выходе эмита). Тела живут ВНУТРИ
  // `with (D)` BIND-зоны модуля; связка — сразу за форвардерами, на месте прежнего
  // объявления. Состояние (activeDisabled/activeBusy/loggedActiveStatus и
  // lastAtEncoded/lastBaseUrl/lastHeaders) — в core/gemini-state.js: его переписывает
  // resetForNewConversation и захват сайтметы — модуль получает rw-пары и ro-геттеры.
  // Снапшот (emitBaseSnapshot) уехал ещё в шаге 12, buildDetail в Gemini-ядре не было.
  var aiCmGeminiActiveRefresh = (typeof window !== 'undefined' && window.AiCmGeminiActiveRefresh) || null;

  // Форвардеры — ИМЕННО function declaration: объявления хойстятся, поэтому чужие
  // __bind-блоки (пагинация, ingest, SPA-фолбэк, архив) и вызовы из ядра не тронуты.
  function activeRefresh(reason, rebuild) {
    return aiCmGeminiActiveRefresh ? aiCmGeminiActiveRefresh.activeRefresh(reason, rebuild) : undefined;
  }
  function sanitizeMessagesForEmit(messages) {
    return aiCmGeminiActiveRefresh ? aiCmGeminiActiveRefresh.sanitizeMessagesForEmit(messages) : messages;
  }

  if (aiCmGeminiActiveRefresh) {
    aiCmGeminiActiveRefresh.__bind({
      // fn (8): функции и значения ядра — декларации хойстятся.
      getConvId: getConvId,
      captureReqTag: captureReqTag,
      isStaleReqTag: isStaleReqTag,
      buildActiveUrl: buildActiveUrl,
      buildActiveBody: buildActiveBody,
      originalFetch: originalFetch,
      aiCmIngestFwd: aiCmIngestFwd,
      debugLog: debugLog,
      // rw (3): живое состояние — get + set, иначе запись модуля молча теряется.
      get activeDisabled() { return activeDisabled; },
      set activeDisabled(v) { activeDisabled = v; },
      get activeBusy() { return activeBusy; },
      set activeBusy(v) { activeBusy = v; },
      get loggedActiveStatus() { return loggedActiveStatus; },
      set loggedActiveStatus(v) { loggedActiveStatus = v; },
      // ro (3): захват сайтметы переприсваивает эти имена — сеттера нет.
      get lastAtEncoded() { return lastAtEncoded; },
      get lastBaseUrl() { return lastBaseUrl; },
      get lastHeaders() { return lastHeaders; }
    });
  } else {
    // Модуль не подключён (старый registration под прежним id: MV3 не перечитывает js[]).
    // Деградация мягкая: дозапрос отложен навсегда (пассив+DOM), эмит без дедупа.
    debugLog('log', '[gemini-intercept] core/gemini-active-refresh.js не подключён — активный vf5-дозапрос недоступен');
  }

  // v40: обёртка над чистой логикой shouldPollVf5 (utils/gemini-intercept-logic.js).
  // Не планировать следующий vf5, когда история полная (baseComplete) и тихая пагинация
  // дошла до начала (reachedStart), а активности не было последние 60с.
  // ===== v2.0 (Phase 3 step 12): shouldPollVf5 перенесено в core/gemini-ingest.js =====

  // ===== v2.0 (Phase 3 step 12): startRefreshObserver перенесено в core/gemini-ingest.js =====

  // ===== v2.0 (Phase 3, шаг 4): sanitizeMessagesForEmit перенесено в core/gemini-active-refresh.js =====
  // Дедуп и его поведение не изменились: тело в модуле, форвардер — выше, на месте
  // прежней связки, поэтому __bind ingest и архива видят функцию как раньше.

  // ================= единый эмит снимка базы =================
  // ===== v2.0 (Phase 3 step 13.2): АРХИВ (ВЫНЕСЕН В core/gemini-archive.js) =====
  // Тела кластера — восемь функций первого яруса полноты (архив, оракул
  // archive-complete, пол архива, сводка объединённой базы) и три слушателя
  // (ai-cm-restored-history, ai-cm-archive-restore, ai-cm-cache-refresh) — живут в
  // модуле, подключение ниже. Логика сюда НЕ возвращается: правки архива делаются
  // в core/gemini-archive.js.
  // Состояние (turnsMap/archiveTierByConv/archiveMergedMap/cacheRestoredMap/
  // loaderDoneMap/loaderRunningFor/parserVersion/quietActive и три вердикта полноты)
  // вынесено в core/gemini-state.js: его читают и пишут ingest, лоадер, пагинация и
  // сброс при смене чата, поэтому модуль получает нужные ему имена ЖИВЫМИ
  // геттерами/сеттерами, а не копиями. sanitizeMessagesForEmit тоже остаётся: ingest.
  // Блок стоит НИЖЕ строки 782 намеренно: emitBaseSnapshot, mergeRestoredTurns и
  // refreshMinOrderTracking — ПОЗДНИЕ алиасы (`var ... = null`), их дозаполняют блоки
  // ingest (770-771) и пагинации (494); выше в модуль уехали бы null.
  var aiCmGeminiArchive = (typeof window !== 'undefined' && window.AiCmGeminiArchive) || null;

  // Форвардеры — ИМЕННО function declaration: объявления хойстятся, поэтому все
  // прежние вызовы из ядра (stableFloorConfirm 881-885, notifyLoaderState 1010,
  // self-heal 1076-1111, снапшот turns 1416) и из чужих __bind-блоков (пагинация 430,
  // лоадер 544-547) не тронуты — к моменту любого из них имя уже существует.
  // Без модуля деградация безмолвная: aiCmArchiveFor → null, aiCmArchiveLiveProven →
  // true (прежние гейты), aiCmLiveTurnCount → baseSize(), остальные → undefined/null.
  // Ни один вызов не бросает.
  function aiCmArchiveFor(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveFor(convId) : null; }
  function aiCmArchiveLiveProven(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveLiveProven(convId) : true; }
  function aiCmLiveTurnCount(arch) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmLiveTurnCount(arch) : baseSize(); }
  function aiCmArchiveTierApply() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveTierApply() : undefined; }
  function aiCmBaseExportInfo() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmBaseExportInfo() : null; }

  if (aiCmGeminiArchive) {
    aiCmGeminiArchive.__bind({
      // Функции ядра (11): декларации хойстятся — значения доступны на момент bind.
      activeRefresh: activeRefresh,
      aiCmDiagTurnEdge: aiCmDiagTurnEdge,
      baseSize: baseSize,
      getConvId: getConvId,
      loadFloor: loadFloor,
      noteBaseCountChange: noteBaseCountChange,
      sanitizeMessagesForEmit: sanitizeMessagesForEmit,
      saveFloor: saveFloor,
      emitBaseSnapshot: emitBaseSnapshot,
      mergeRestoredTurns: mergeRestoredTurns,
      refreshMinOrderTracking: refreshMinOrderTracking,
      // Только чтение (8): сеттер не нужен — модуль эти переменные не переприсваивает
      // (мутации объектов по ссылке видны ядру и без сеттера).
      get archiveMergedMap() { return archiveMergedMap; },
      get archiveTierByConv() { return archiveTierByConv; },
      get cacheRestoredMap() { return cacheRestoredMap; },
      get loaderDoneMap() { return loaderDoneMap; },
      get loaderRunningFor() { return loaderRunningFor; },
      get parserVersion() { return parserVersion; },
      get quietActive() { return quietActive; },
      get turnsMap() { return turnsMap; },
      // Живое состояние (3): get + set — запись из модуля обязана дойти до ядра.
      get historyFullByQuiet() { return historyFullByQuiet; },
      set historyFullByQuiet(v) { historyFullByQuiet = v; },
      get reachedStart() { return reachedStart; },
      set reachedStart(v) { reachedStart = v; },
      get tapeWasUsedInThisColdStart() { return tapeWasUsedInThisColdStart; },
      set tapeWasUsedInThisColdStart(v) { tapeWasUsedInThisColdStart = v; }
    });
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id).
    // Деградация мягкая: архивного яруса нет, база собирается живыми путями
    // (vf5/пагинация/лоадер), гейты полноты работают как до T1.
    debugLog('log', '[gemini-intercept] core/gemini-archive.js не подключён — архивный ярус недоступен');
  }
  // ===== v2.0 (Phase 3 step 13.3): ОРАКУЛ ПОЛНОТЫ (ВЫНЕСЕН В core/gemini-oracle.js) =====
  // Тела оракула — stableFloorConfirm/noteBaseCountChange (floor-confirmed + debounce),
  // notifyLoaderState со вложенным stableCheck74 (loader-stable-stop, O-48 parse-fail,
  // clean-end, самоунижение пола), отпечатки aiCmDiagHash6/aiCmDiagTurnEdge/aiCmOrderedTurns
  // и мост ai-cm-turns-snap-request — живут в модуле, подключение ниже.
  // Состав объекта связи — tools/oracle-bind-contract.js: 10 функций значением, 10 имён
  // с геттером и сеттером (оракул переприсваивает вердикты полноты и таймер debounce),
  // 12 только на чтение (в том числе lastHnvPageError и lastBaseTextLen: их typeof-гарды
  // в stableCheck74 обязаны видеть живое значение, иначе pageError/provenLen деградируют).
  // Форвардеры и var aiCmGeminiOracle объявлены ВЫШЕ (строка ~866) — до первого вызова
  // notifyLoaderState из checkConvChange, поэтому здесь остаётся только связка.
  // Блок стоит НИЖЕ строки 782 намеренно: emitBaseSnapshot — ПОЗДНИЙ алиас
  // (`var ... = null`), его дозаполняет блок ingest (770-771); выше в модуль уехал бы null.
  if (aiCmGeminiOracle) {
    aiCmGeminiOracle.__bind({
      // fn (10): функции ядра — передаются значением (декларации хойстятся).
      getConvId: getConvId,
      baseSize: baseSize,
      loadFloor: loadFloor,
      selfHealFloor: selfHealFloor,
      emitBaseSnapshot: emitBaseSnapshot,
      // Форвардеры архива: оракул переоценивает ярус архива на стопе лоадера.
      aiCmArchiveFor: aiCmArchiveFor,
      aiCmArchiveLiveProven: aiCmArchiveLiveProven,
      aiCmLiveTurnCount: aiCmLiveTurnCount,
      aiCmArchiveTierApply: aiCmArchiveTierApply,
      aiCmBaseExportInfo: aiCmBaseExportInfo,
      // rw (10): живое состояние — get + set. Без сеттера вердикт модуля потерялся бы.
      get historyFullByQuiet() { return historyFullByQuiet; },
      set historyFullByQuiet(v) { historyFullByQuiet = v; },
      get reachedStart() { return reachedStart; },
      set reachedStart(v) { reachedStart = v; },
      get quietIncompleteNoStart() { return quietIncompleteNoStart; },
      set quietIncompleteNoStart(v) { quietIncompleteNoStart = v; },
      get lastCycleEndedHidden() { return lastCycleEndedHidden; },
      set lastCycleEndedHidden(v) { lastCycleEndedHidden = v; },
      get quietEndedClean() { return quietEndedClean; },
      set quietEndedClean(v) { quietEndedClean = v; },
      get oracleIncompleteSeen() { return oracleIncompleteSeen; },
      set oracleIncompleteSeen(v) { oracleIncompleteSeen = v; },
      get lastLoaderDoneReason() { return lastLoaderDoneReason; },
      set lastLoaderDoneReason(v) { lastLoaderDoneReason = v; },
      get lastBaseCount() { return lastBaseCount; },
      set lastBaseCount(v) { lastBaseCount = v; },
      get lastBaseCountChangeAt() { return lastBaseCountChangeAt; },
      set lastBaseCountChangeAt(v) { lastBaseCountChangeAt = v; },
      get floorConfirmDebounceTimer() { return floorConfirmDebounceTimer; },
      set floorConfirmDebounceTimer(v) { floorConfirmDebounceTimer = v; },
      // ro (12): только чтение — сеттера нет, модуль эти имена не переприсваивает
      // (мутации объектов по ссылке видны ядру и без сеттера).
      get pendingCursor() { return pendingCursor; },
      get lastIngestParseFail() { return lastIngestParseFail; },
      get lastOlderNonPagAddAt() { return lastOlderNonPagAddAt; },
      get turnsMap() { return turnsMap; },
      get lastOrderedIds() { return lastOrderedIds; },
      get parserVersion() { return parserVersion; },
      get loaderRunningFor() { return loaderRunningFor; },
      get quietActive() { return quietActive; },
      get reachedStartByScroll() { return reachedStartByScroll; },
      get loaderState() { return loaderState; },
      // Два typeof-гарда внутри stableCheck74 обязаны видеть ЖИВЫЕ значения (см. шапку
      // контракта): иначе pageError всегда false (H10 слабеет) и provenLen=0 (понижение
      // пола записало бы устаревшую длину). Оба имени — только на чтение.
      get lastHnvPageError() { return lastHnvPageError; },
      get lastBaseTextLen() { return lastBaseTextLen; }
    });
  } else {
    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
    // registration с прежним id: MV3 не перечитывает js[] под существующим id).
    // Деградация мягкая: оракул полноты молчит (floor-confirmed и loader-stable-stop не
    // взводятся, снапшот ходов пуст), база собирается живыми путями, но полнота
    // подтверждается только ветками ingest/пагинации.
    debugLog('log', '[gemini-intercept] core/gemini-oracle.js не подключён — оракул полноты недоступен');
  }

  // ===== v2.0 (Phase 3 step 12): emitBaseSnapshot перенесено в core/gemini-ingest.js =====

  // v52: stream-alias — при поступлении снапшота (passive/vf5) стримовские записи с временным
  // rc_*-id (pageMode='stream') замещаются снапшотными r_*-id того же turnId+role (FIFO по order).
  // ===== v2.0 (Phase 3 step 12): applyStreamAliases перенесено в core/gemini-ingest.js =====

  // ================= ingest =================
  // ===== v2.0 (Phase 3 step 12): ingest перенесено в core/gemini-ingest.js =====

  // ===== v2.0 (Phase 3 step 9): SSE-кластер (перехват сети) вынесен в core/gemini-sse.js =====
  // Здесь были подмена window.fetch (batchexecute: rememberSiteMeta на запросе, гард stale-conv
  // по convId/эпохе на ответе, stream-ingest, DIAG_TOKENS-скан, тихий catch) и подмена
  // OriginalXHR.prototype.open/setRequestHeader/send (тот же набор ветвей). Модуль подключён
  // ПЕРЕД этим файлом, связка (__bind + алиас) — в блоке выше, сразу после блока
  // core/gemini-parse.js. Вызов ниже сохраняет прежнее МЕСТО установки врапперов, поэтому и
  // момент установки, и порядок патчей относительно остальных слушателей ядра не менялись.
  // Логика сюда НЕ возвращается: правки перехвата сети — в модуле.
  installNetworkHooks();

  // ===== v2.0 (Phase 3 step 13.2): АРХИВ (ВЫНЕСЕН В core/gemini-archive.js) =====
  // Здесь были три слушателя кластера архива: приём ленты кэша (ai-cm-restored-history),
  // приём нормализованных ходов архива (ai-cm-archive-restore) и уточнение канонического
  // снимка после кэша (ai-cm-cache-refresh). Все три живут в core/gemini-archive.js и
  // регистрируются на загрузке модуля; каждая ветка начинается гардом `if (!D)`, поэтому
  // до связки событие игнорируется с внятным логом, а не бросает ReferenceError.
  // Логика сюда НЕ возвращается: правки приёма архива и ленты — в модуле.

  // v4x: при чтении ленты повторно применяем sanitizeFinalMessages к каждому ходу.
  // ===== v2.0 (Phase 3 step 12): sanitizeRestoredTurn перенесено в core/gemini-ingest.js =====

  // ===== v2.0 (Phase 3 step 12): mergeRestoredTurns перенесено в core/gemini-ingest.js =====

  // ===== v2.0 (Phase 3 step 2): ДАМП ДИАГНОСТИКИ (ВЫНЕСЕН В core/gemini-diag-dump.js) =====
  // Мост ai-cm-diag-request/response живёт в модуле (внутри `with (D)`), там же его правки;
  // связка — геттеры: turnsMap/lastOrderedIds/lastFailedSkeleton переприсваиваются в ядре.
  var aiCmGeminiDiagDump = (typeof window !== 'undefined' && window.AiCmGeminiDiagDump) || null;
  if (aiCmGeminiDiagDump) {
    aiCmGeminiDiagDump.__bind({
      get turnsMap() { return turnsMap; },
      get lastOrderedIds() { return lastOrderedIds; },
      get lastFailedSkeleton() { return lastFailedSkeleton; }
    });
  } else {
    debugLog('log', '[gemini-intercept] core/gemini-diag-dump.js не подключён — дамп диагностики недоступен');
  }

  // ===== v2.0 (Phase 3 step 13.3): ОРАКУЛ ПОЛНОТЫ (ВЫНЕСЕН В core/gemini-oracle.js) =====
  // Здесь был слушатель ai-cm-turns-snap-request (мост дампов экспорта в ISOLATED-мир).
  // Он живёт в модуле и начинается гардом `if (!D)`, поэтому до связки событие
  // игнорируется с внятным логом, а не бросает ReferenceError.
  // Логика сюда НЕ возвращается: правки моста — в модуле.

  // v4y: холодное открытие (F5 на /app/<id>) → автозапуск лоадера полной истории.
  // Скроллер может появиться позже — poll внутри loadFullHistoryInvisibly до 10с.
  try { setTimeout(function () { maybeStartLoader(); }, 1000); } catch (e) { }

  debugLog('log', '[gemini-intercept] перехватчик Gemini v28 установлен (структурный сбор вложений v23 + фикс курсора + сброс при смене чата + тихая пагинация из vf5 + гард пассивки по convId (fetch Request-объекты тоже) + защита автоскролла + virtual-f5 + historyComplete в emit + подавление чужих unhandled fetch + пересборка ветки при realtime-vf5 + пол (floor) через localStorage + диагностика opaque-кандидатов + сохранение/восстановление ленты через content.js)');
  } // закрывает with (aiCmGeminiState)

})();
