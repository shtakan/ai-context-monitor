// =====================================================================================
// core/gemini-state.js — глобальное состояние перехватчика Gemini (Фаза 3, шаг 5).
//
// Кластер 6 «Ядро состояния» вынесен из core/gemini-intercept.js байтовым переносом:
// 101 объявление (var → свойства одного объекта) со своими комментариями. Значения,
// инициализаторы и порядок — прежние; Date.now()/new Set()/{} вычисляются один раз при
// загрузке скрипта, как и раньше.
//
// Почему объект, а не top-level var: файл исполняется в MAIN-мире страницы (world:'MAIN'),
// где любое top-level объявление становится именем на window самого Gemini — 101 generic-
// имя дало бы коллизии с сайтом. Поэтому состояние живёт в одном объекте
// window.AiCmGeminiState, а ядро читает и пишет его через `with (aiCmGeminiState) { … }`:
// те же имена, та же переменная, без теневых копий — запись из ядра или из любого __bind-
// модуля сразу видна всем.
//
// Классический (не module) скрипт. Порядок в js[] регистрации world:'MAIN' в
// core/background.js: … -> core/gemini-active-refresh.js -> core/gemini-state.js ->
// core/gemini-intercept.js. Без этого файла ядро не устанавливается (мягкий лог).
// =====================================================================================
(function () {
  if (typeof window === 'undefined') return;
  if (window.AiCmGeminiState) return;
  // ===== v2.0 (Phase 3 step 5): ядро состояния (перенесено из core/gemini-intercept.js) =====
  var originalFetch = window.fetch;
  var OriginalXHR = window.XMLHttpRequest;
  var originalXHROpen = OriginalXHR ? OriginalXHR.prototype.open : null;
  var originalXHRSend = OriginalXHR ? OriginalXHR.prototype.send : null;
  var originalSetHeader = OriginalXHR ? OriginalXHR.prototype.setRequestHeader : null;

  // ---- накопители вложений (глобально, на всю сессию; сбрасываются при смене чата) ----
  // ===== v2.0 (Phase 3 step 12): consts-media перенесено в core/gemini-ingest.js =====
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
  // ===== v2.0 (Phase 3 step 12): DEBUG_STRUCTURE перенесено в core/gemini-ingest.js =====
  var loggedRontgen = false;

  // v2.0 (Phase 3 step 1 + step 5): счётчик и лимит сканирования — это состояние, поэтому
  // они переехали сюда вместе с кластером. Сама диагностика (diagCanScan/diagIsStream/
  // diagScanResponse и их константы) уехала в core/gemini-diag.js и приходит в ядро
  // через bind-алиасы.
  var diagScannedCount = 0;
  var DIAG_MAX_SCANNED = 200;

  // ---- v16: приватный рентген id хода ----
  var idmapCalls = 0;
  // ===== v2.0 (Phase 3 step 12): IDMAP_MAX перенесено в core/gemini-ingest.js =====

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
  // ===== v2.0 (Phase 3 step 12): REFRESH_MIN_MS перенесено в core/gemini-ingest.js =====
  var loggedActiveStatus = false;
  // ===== v2.0 (Phase 3 step 12): observer-mut перенесено в core/gemini-ingest.js =====
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

  var parserVersion = '';

  var currentConvId = ''; // v17: заполняется в ядре вызовом getConvId() (Phase 3, шаг 5)

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

  var aiCmScrollOverlay = null;
  var aiCmOverlaySeq = 0;        // v80: поколение оверлея — seq-гвард от чужого снятия
  var aiCmRerunOverlayTimer = null; // v80: разоружение pre-applied оверлея, если ре-ран не стартовал

  // ===== экспорт: 101 имя одним объектом (единая точка правды для ядра и модулей) =====
  window.AiCmGeminiState = {
    originalFetch: originalFetch,
    OriginalXHR: OriginalXHR,
    originalXHROpen: originalXHROpen,
    originalXHRSend: originalXHRSend,
    originalSetHeader: originalSetHeader,
    attachSeen: attachSeen,
    attachTokens: attachTokens,
    attachBreak: attachBreak,
    loggedAttach: loggedAttach,
    turnsMap: turnsMap,
    lastOrderedIds: lastOrderedIds,
    lastBaseTextLen: lastBaseTextLen,
    orderCounter: orderCounter,
    prependCursor: prependCursor,
    loggedOk: loggedOk,
    loggedErr: loggedErr,
    loggedStructure: loggedStructure,
    loggedRontgen: loggedRontgen,
    diagScannedCount: diagScannedCount,
    DIAG_MAX_SCANNED: DIAG_MAX_SCANNED,
    idmapCalls: idmapCalls,
    autoScrollStarted: autoScrollStarted,
    conversationOpenedAt: conversationOpenedAt,
    DOM_READY_MAX_WAIT: DOM_READY_MAX_WAIT,
    MIN_HISTORY_ELEMENTS: MIN_HISTORY_ELEMENTS,
    quietActive: quietActive,
    historyFullByQuiet: historyFullByQuiet,
    reachedStart: reachedStart,
    reachedStartByScroll: reachedStartByScroll,
    quietPaginated: quietPaginated,
    quietDecisionMade: quietDecisionMade,
    quietIncompleteNoStart: quietIncompleteNoStart,
    lastCycleEndedHidden: lastCycleEndedHidden,
    pendingCursor: pendingCursor,
    lastCursorSource: lastCursorSource,
    serverFirstHash: serverFirstHash,
    lastHeadToken: lastHeadToken,
    lastGoodWideCur: lastGoodWideCur,
    lastGoodProbeMeta: lastGoodProbeMeta,
    completenessWatchdogRetries: completenessWatchdogRetries,
    watchdogFiredMap: watchdogFiredMap,
    lastOlderNonPagAddAt: lastOlderNonPagAddAt,
    minOrderSeen: minOrderSeen,
    lastBaseCount: lastBaseCount,
    lastBaseCountChangeAt: lastBaseCountChangeAt,
    floorConfirmDebounceTimer: floorConfirmDebounceTimer,
    cursorEpoch: cursorEpoch,
    olderHistorySeen: olderHistorySeen,
    loggedMultiCursor: loggedMultiCursor,
    PAGINATE_CAP: PAGINATE_CAP,
    PAGINATE_TIME_CAP_MS: PAGINATE_TIME_CAP_MS,
    paginationRun: paginationRun,
    lastPaginateOpaqueCandidates: lastPaginateOpaqueCandidates,
    lastPaginateOuter: lastPaginateOuter,
    lastAllStrings: lastAllStrings,
    lastFailedSkeleton: lastFailedSkeleton,
    lastPagStepBroken: lastPagStepBroken,
    lastHnvPageError: lastHnvPageError,
    pagErrorRetries: pagErrorRetries,
    PAGINATE_ERROR_RETRY_CAP: PAGINATE_ERROR_RETRY_CAP,
    PAGINATE_ERROR_BACKOFF_MS: PAGINATE_ERROR_BACKOFF_MS,
    lastFrameParseFail: lastFrameParseFail,
    lastIngestParseFail: lastIngestParseFail,
    quietErrStreak: quietErrStreak,
    nativeEscalationUsedMap: nativeEscalationUsedMap,
    nativeEscalationFor: nativeEscalationFor,
    quietEndedClean: quietEndedClean,
    lastCleanEndBaseCount: lastCleanEndBaseCount,
    lastHeaders: lastHeaders,
    lastAtEncoded: lastAtEncoded,
    lastBaseUrl: lastBaseUrl,
    lastReqId: lastReqId,
    activeSeq: activeSeq,
    activeDisabled: activeDisabled,
    activeBusy: activeBusy,
    lastActiveAt: lastActiveAt,
    lastVf5ActivityAt: lastVf5ActivityAt,
    loggedActiveStatus: loggedActiveStatus,
    scrollRecentUntil: scrollRecentUntil,
    autoScrollBlocked: autoScrollBlocked,
    autoScrollUnblockTimer: autoScrollUnblockTimer,
    loaderDoneMap: loaderDoneMap,
    loaderRunningFor: loaderRunningFor,
    oracleIncompleteSeen: oracleIncompleteSeen,
    oracleRerunUsedMap: oracleRerunUsedMap,
    cacheRestoredMap: cacheRestoredMap,
    archiveTierByConv: archiveTierByConv,
    archiveMergedMap: archiveMergedMap,
    parserVersion: parserVersion,
    currentConvId: currentConvId,
    convEpoch: convEpoch,
    tapeWasUsedInThisColdStart: tapeWasUsedInThisColdStart,
    vf5OverlapSinceLoaderStart: vf5OverlapSinceLoaderStart,
    isLowConfidenceBase: isLowConfidenceBase,
    loaderState: loaderState,
    lastLoaderDoneReason: lastLoaderDoneReason,
    collapseRetries: collapseRetries,
    loaderRetryUsedMap: loaderRetryUsedMap,
    aiCmScrollOverlay: aiCmScrollOverlay,
    aiCmOverlaySeq: aiCmOverlaySeq,
    aiCmRerunOverlayTimer: aiCmRerunOverlayTimer
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.AiCmGeminiState;
}());
