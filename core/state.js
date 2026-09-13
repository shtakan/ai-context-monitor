// =============================================================================
// core/state.js — v2.0 (этап 1/3): декомпозиция core/content.js.
// СОСТОЯНИЕ (единый реестр глобального состояния контент-скрипта).
//
// Сюда вынесено РАНТАЙМ-СОСТОЯНИЕ, которое делят content.js и модули: база + хвост
// (гибрид), бейдж/виджет, экспорт и автоэкспорт, модель/токены, архив-источник.
// Объявления перенесены байтово — без переименований и смены инициализаторов.
// Классические content-скрипты делят один глобальный лексический скоуп, поэтому
// модули и content.js читают эти имена как прежде.
// Конфиги/константы подсистем (STORAGE_PREFIX, THEME_CONFIGS, AI_CM_H23_SITES и т.п.)
// остались у владельцев: state.js — только изменяемое состояние.
// Исключение: aiCmLastSeenConvId остаётся в content.js — его инициализатор вызывает
// getCurrentConvId() из content.js, а модули исполняются РАНЬШЕ content.js (иначе
// ReferenceError на загрузке страницы).
//
// Порядок подключения (manifest.json, content_scripts[0].js):
//   utils/* → adapters/* → core/state.js → core/widget.js → core/base-handler.js
//   → core/hybrid-tail.js → core/export-manager.js → core/content.js
// Перенос БЕЗ изменения логики: тела функций, сигнатуры, имена и строковые
// литералы байтово прежние (декомпозиция, а не переписывание).
// =============================================================================

let currentAdapter = null;
let observer = null;
let isInitialized = false;
let lastPercentage = -1;
let updateTimer = null;
let widgetElement = null;
let lastWidgetData = null;
let badgeSuppressed = false; // v1.8.1: true после RESET — до первого снимка нового чата бейдж не рисуем
let maxTokenCount = 0;
let restoredTapeLoaded = false; // v28: флаг однократного восстановления ленты при загрузке чата
let restoreDone = false; // v30: флаг завершения восстановления — разрешает сохранение ленты только после restore
let cacheRefreshPlanned = {}; // v30.6: convId → true — планирование уточнения после кэша один раз на чат за сессию
let tapeRestoreSeen = {}; // v77: convId → true — лента для этого чата уже восстановлена в этой сессии страницы (O2)
var aiCmTapeAccountIdx = {}; // v82 (D8): convId → account index на момент последнего tape load
var aiCmRestoredDispatched = {}; // v82 (D9-A): convId → true — ai-cm-restored-history уже диспатчен (page-session)
// ========== ГИБРИД: БАЗА (сеть) + ХВОСТ (DOM по кэшу базы) ==========
let baseText = '';
let baseCount = 0;
let baseSeen = false;
let baseComplete = false; // сеть дала ПОЛНУЮ историю (тихая пагинация) → индикатор берёт число из базы, не из DOM
let lastBounded = false;  // последний DOM-хвост нашёл границу (стабильный источник для монотонного максимума)
let lastTailSig = null;
let lastBaseSig = null;   // антиспам: сигнатура последней печати «📥 база полной истории»
let lastEmitSig = null;   // антиспам: сигнатура последней печати «[content-trace] EMIT принят»
let lastDrawSig = null;   // антиспам: сигнатура последней печати «[content-trace] DRAW»
let lastHybridTailSig = null; // антиспам: последняя напечатанная строка «[hybrid-tail]»
// v30.5: антиспам для skip reason=not-complete — печатаем не чаще 1 раза на convId,
// пока не пришла полная база. Сбрасывается вместе с fired при смене чата.
let notCompleteLogged = {};
// v30.8: заморозка бейджа на время скрытой загрузки лоадером Gemini
var aiCmLoaderFreeze = false;
let baseIdSet = null;
var lastBaseIds = [];
var lastBaseTexts = [];
let baseSkelSet = null;
let baseAnchors = null;
const ANCHOR_MIN = 40;
// ========== САМОДИАГНОСТИКА: флаг stale (интеграция могла устареть) ==========
let stale = false;      // сетевого снимка нет 12с, хотя диалог с сообщениями в DOM есть
let staleTimer = null;
// ========== ЭКСПОРТ ИСТОРИИ (aiCmHistory) ==========
// Роли сообщений берём из detail.messages перехватчика (если есть);
// иначе — фолбэк: первое сообщение user, далее чередование user/assistant.
let lastDetailMessages = null; // [{role,text}] из последнего detail.messages (или null)
let lastHistoryWroteKey = null; // сигнатура 'baseCount|textLen' последней записи aiCmHistory
let lastThreadId = null; // threadId последнего применённого снимка Google (для сброса при SPA-возврате)

// ========== ДЕТЕКТОР МОДЕЛИ (сеть) ==========
let detectedModelSlug = '';
let lastResolvedModelId = null;
// v47: имя модели СНИМКА (сеть/тэйп/адаптер) — для экспорта, который остаётся
// привязан к модели, писавшей ответы, а не к выбранной в UI.
let lastSnapshotModelName = '';
// ========== ВЛОЖЕНИЯ (Gemini; для ChatGPT = 0, нейтрально) ==========
let netAttachTokens = 0;
let netAttachBreak = null;
// ========== СЕРВЕРНЫЙ ЧИСЛИТЕЛЬ (DeepSeek accumulated_token_usage; для ChatGPT/Gemini = 0) ==========
let netServerTokens = 0;
let netEffectiveLen = 0;
// ========== BYOK: точный подсчёт токенов через Gemini countTokens API ==========
// M-7: ключ Google AI Studio хранится ТОЛЬКО в chrome.storage.session
// ('aiCmApiKeySession') — в память сессии браузера, на диск не пишется. Доступ
// контент-скриптам открыт в background.js (chrome.storage.session.setAccessLevel).
let exactCountEnabled = false;
let geminiApiKey = '';
let lastCountTokensText = '';
let lastCountTokensCache = 0;
let countTokensTimer = null;
let countTokensPending = false; // защита от повторного запроса пока предыдущий в полёте

// ========== БЕЗОПАСНЫЙ ПОРОГ (регулятор; определения целиком, со стрелками) ==========
let safePct = null;
// H19: оверрайды попапа (chrome.storage.sync) — раньше писались и НЕ читались.
let popupRawModel = null;  // сырое selectedModel из попапа ('auto' = Автоопределение)
let popupRawPct = null;    // сырое customLimit из попапа («Лимит контекста» = % от Авто)
let popupModelId = null;   // канонический id выбранной модели; null = Автоопределение
let popupLimitPct = null;  // 1..100; null = Авто (поле пустое)

// v55: DOM-догон — локальный пересчёт токенов по запросу перехватчика Gemini
// ('ai-cm-dom-emit-request' после тихого дебаунса DOM-мутаций ~2.5с, т.е. когда
// стриминг ответа завершён). Без сетевого запроса: baseText + DOM-хвост через
// существующий tokenEstimate (processAndSend → getEffectiveText). Убирает «лаг
// в одну реплику»: процент растёт сразу после стриминга, а не со следующим
// снапшотом. Гарды: есть база, вкладка активна, лоадер не бежит (не ломать пол);
// пересчёт только при (baseComplete || lastBounded) — иначе монотонный максимум
// мог бы быть затёрт DOM-оценкой. Дедуп с последующим сетевым снапшотом даёт
// существующий монотонный максимум (двойного роста быть не должно).
var aiCmLastDomEmitSig = null;

let lastEmitConvId = ''; // v34: convId последнего принятого снимка (гард экспорта)
let lastSnapConvId = ''; // v37: convId последнего снимка для сброса монотонного максимума

var aiCmConvSourceByConv = {};          // convId → запись источника (для попапа/виджета)
var aiCmArchiveLoadStarted = {};        // convId → true — чтение архива уже запущено (page-session)
var aiCmArchiveRestoredDispatched = {}; // convId → true — ai-cm-archive-restore уже диспатчен
var aiCmArchiveCountByConv = {};        // T1-fix#2 (v1.16.2): convId → count архивных ходов (гейт экспорта)
var aiCmSourceLabelNow = '';            // ярлык источника для тултипа виджета

// ========== v1.8: АВТОЭКСПОРТ ЧАТА ПРИ ПОРОГЕ ==========
// Настройки: aiCmAutoExport / aiCmAutoExportPct / aiCmAutoExportFmt (chrome.storage.local).
// Сборка текста — тем же сборщиком, что использует ручная кнопка выбранного формата
// (utils/export-text-builders.js). Без флага консоль тихая; ошибки — console.error.
var autoExportSettings = { enabled: false, pct: 90, fmt: 'txt' };
// v1.19.2 (M-13c): антиспам строки «флаг enabled отсутствует» — одна строка на эпизод
// (loadAutoExportSettings вызывается и на старте, и на каждый onChanged этих трёх ключей).
var aiCmAutoExportFlagMissingLogged = false;
var autoExportFired = {};        // convId -> 1 (один раз на чат)
// S2: per-site порог автоэкспорта: ключ 'aiCmAutoExportPct_<siteName>' (например
// aiCmAutoExportPct_chatgpt) переопределяет глобальный aiCmAutoExportPct для этого
// сайта. Кэш заполняется асинхронно (initialize + onChanged); запись отсутствует →
// в maybeAutoExport фолбэк на глобальный порог.
var autoExportPctBySite = {};    // siteName -> число 1..100; undefined = фолбэк на глобальный

var autoExportLastConvId = '';   // сброс fired при смене чата
// v42: convId → 1, пока лоадер Gemini (MAIN-мир) бежит по этому чату; канал — ai-cm-loader-state
var aiCmLoaderRunningByConv = {};
var autoExportLastPct = -1;      // v42: последний pct для однократного re-check на стопе лоадера
// v52: отложенная запись aiCmHistory (питает ручной экспорт попапа из chrome.storage.local).
// Если в момент снимка лоадер Gemini ещё бежит ИЛИ база не полная — не пишем сразу,
// иначе попап может скачать частичную историю (дыра в середине). Одноразово ждём
// события (baseComplete && !loader), таймаут-фолбэк 20с → пишем как есть.
var aiCmPendingHistWrite = null; // { convId, timer }
// v53: курсор продолжения лоадера Gemini по convId на момент стопа (из ai-cm-loader-state
// detail.pendingCursor). Пока курсор жив — автоэкспорт НЕ стреляет (даже при baseComplete).
var aiCmCursorLiveByConv = {};
// v1.13.1: convId → 1 — база подтверждённо полная (baseComplete при reachedStart=true от
// перехватчика Gemini). До подтверждения deferred-запись истории висит и НЕ флашится по
// loader-stop; фолбэк — «счётчик стабилен при видимой вкладке» (таймаут defer при visible).
var aiCmBaseConfirmedByConv = {};
// v63: convId → true — база подтверждена только sanity-фолбэком (low confidence);
// читается при записи histSnapshot (поле isLowConfidenceBase → префикс имени файла).
var aiCmLowConfidenceByConv = {};
// v53: convId → 1 — «ждём поздний re-check, когда база впервые станет полной».
// Одноразовый: гасится после фактического re-check (см. aiCmTryLateAutoExport).
var aiCmLateCheckByConv = {};
// v54: детектор обрезки истории в Gemini + спасательный pre-trim экспорт.
// trimProbe[cid] = { maxCount, firstIds, suspectPending } — эталон последнего ПОЛНОГО
// снимка (обновляется только при detail.historyComplete === true).
var trimProbe = {};
var preTrimExportFired = {};     // v54: cid -> 1 — pre-trim экспорт один раз на чат; Независим от autoExportFired
var trimRetryByConv = {};        // v54: cid -> счётчик ретраев инвариантов полноты (≤5 по 2с)
// N первых id снимка для сравнения голов детектором обрезки (синхронно с util).
var TRIM_HEAD_IDS_N = 10;

// ========== v2.0 (этап 1/3): UMD-экспорт модуля ==========
// Паттерн как у utils/export-emit-pipeline.js: window.<Api> + module.exports.
// Рабочий путь ничего не импортирует: content-скрипты манифеста делят один
// глобальный лексический скоуп, поэтому объявления выше видны всем модулям и
// content.js по прежним именам. Api — для инструментов, отладки и тестов.
(function () {
  var Api = {};
  Object.defineProperty(Api, 'currentAdapter', { enumerable: true,
    get: function () { return currentAdapter; },
    set: function (value) { currentAdapter = value; } });
  Object.defineProperty(Api, 'observer', { enumerable: true,
    get: function () { return observer; },
    set: function (value) { observer = value; } });
  Object.defineProperty(Api, 'isInitialized', { enumerable: true,
    get: function () { return isInitialized; },
    set: function (value) { isInitialized = value; } });
  Object.defineProperty(Api, 'lastPercentage', { enumerable: true,
    get: function () { return lastPercentage; },
    set: function (value) { lastPercentage = value; } });
  Object.defineProperty(Api, 'updateTimer', { enumerable: true,
    get: function () { return updateTimer; },
    set: function (value) { updateTimer = value; } });
  Object.defineProperty(Api, 'widgetElement', { enumerable: true,
    get: function () { return widgetElement; },
    set: function (value) { widgetElement = value; } });
  Object.defineProperty(Api, 'lastWidgetData', { enumerable: true,
    get: function () { return lastWidgetData; },
    set: function (value) { lastWidgetData = value; } });
  Object.defineProperty(Api, 'badgeSuppressed', { enumerable: true,
    get: function () { return badgeSuppressed; },
    set: function (value) { badgeSuppressed = value; } });
  Object.defineProperty(Api, 'maxTokenCount', { enumerable: true,
    get: function () { return maxTokenCount; },
    set: function (value) { maxTokenCount = value; } });
  Object.defineProperty(Api, 'restoredTapeLoaded', { enumerable: true,
    get: function () { return restoredTapeLoaded; },
    set: function (value) { restoredTapeLoaded = value; } });
  Object.defineProperty(Api, 'restoreDone', { enumerable: true,
    get: function () { return restoreDone; },
    set: function (value) { restoreDone = value; } });
  Object.defineProperty(Api, 'cacheRefreshPlanned', { enumerable: true,
    get: function () { return cacheRefreshPlanned; },
    set: function (value) { cacheRefreshPlanned = value; } });
  Object.defineProperty(Api, 'tapeRestoreSeen', { enumerable: true,
    get: function () { return tapeRestoreSeen; },
    set: function (value) { tapeRestoreSeen = value; } });
  Object.defineProperty(Api, 'aiCmTapeAccountIdx', { enumerable: true,
    get: function () { return aiCmTapeAccountIdx; },
    set: function (value) { aiCmTapeAccountIdx = value; } });
  Object.defineProperty(Api, 'aiCmRestoredDispatched', { enumerable: true,
    get: function () { return aiCmRestoredDispatched; },
    set: function (value) { aiCmRestoredDispatched = value; } });
  Object.defineProperty(Api, 'baseText', { enumerable: true,
    get: function () { return baseText; },
    set: function (value) { baseText = value; } });
  Object.defineProperty(Api, 'baseCount', { enumerable: true,
    get: function () { return baseCount; },
    set: function (value) { baseCount = value; } });
  Object.defineProperty(Api, 'baseSeen', { enumerable: true,
    get: function () { return baseSeen; },
    set: function (value) { baseSeen = value; } });
  Object.defineProperty(Api, 'baseComplete', { enumerable: true,
    get: function () { return baseComplete; },
    set: function (value) { baseComplete = value; } });
  Object.defineProperty(Api, 'lastBounded', { enumerable: true,
    get: function () { return lastBounded; },
    set: function (value) { lastBounded = value; } });
  Object.defineProperty(Api, 'lastTailSig', { enumerable: true,
    get: function () { return lastTailSig; },
    set: function (value) { lastTailSig = value; } });
  Object.defineProperty(Api, 'lastBaseSig', { enumerable: true,
    get: function () { return lastBaseSig; },
    set: function (value) { lastBaseSig = value; } });
  Object.defineProperty(Api, 'lastEmitSig', { enumerable: true,
    get: function () { return lastEmitSig; },
    set: function (value) { lastEmitSig = value; } });
  Object.defineProperty(Api, 'lastDrawSig', { enumerable: true,
    get: function () { return lastDrawSig; },
    set: function (value) { lastDrawSig = value; } });
  Object.defineProperty(Api, 'lastHybridTailSig', { enumerable: true,
    get: function () { return lastHybridTailSig; },
    set: function (value) { lastHybridTailSig = value; } });
  Object.defineProperty(Api, 'notCompleteLogged', { enumerable: true,
    get: function () { return notCompleteLogged; },
    set: function (value) { notCompleteLogged = value; } });
  Object.defineProperty(Api, 'aiCmLoaderFreeze', { enumerable: true,
    get: function () { return aiCmLoaderFreeze; },
    set: function (value) { aiCmLoaderFreeze = value; } });
  Object.defineProperty(Api, 'baseIdSet', { enumerable: true,
    get: function () { return baseIdSet; },
    set: function (value) { baseIdSet = value; } });
  Object.defineProperty(Api, 'lastBaseIds', { enumerable: true,
    get: function () { return lastBaseIds; },
    set: function (value) { lastBaseIds = value; } });
  Object.defineProperty(Api, 'lastBaseTexts', { enumerable: true,
    get: function () { return lastBaseTexts; },
    set: function (value) { lastBaseTexts = value; } });
  Object.defineProperty(Api, 'baseSkelSet', { enumerable: true,
    get: function () { return baseSkelSet; },
    set: function (value) { baseSkelSet = value; } });
  Object.defineProperty(Api, 'baseAnchors', { enumerable: true,
    get: function () { return baseAnchors; },
    set: function (value) { baseAnchors = value; } });
  Object.defineProperty(Api, 'ANCHOR_MIN', { enumerable: true,
    get: function () { return ANCHOR_MIN; },
    set: function (value) { ANCHOR_MIN = value; } });
  Object.defineProperty(Api, 'stale', { enumerable: true,
    get: function () { return stale; },
    set: function (value) { stale = value; } });
  Object.defineProperty(Api, 'staleTimer', { enumerable: true,
    get: function () { return staleTimer; },
    set: function (value) { staleTimer = value; } });
  Object.defineProperty(Api, 'lastDetailMessages', { enumerable: true,
    get: function () { return lastDetailMessages; },
    set: function (value) { lastDetailMessages = value; } });
  Object.defineProperty(Api, 'lastHistoryWroteKey', { enumerable: true,
    get: function () { return lastHistoryWroteKey; },
    set: function (value) { lastHistoryWroteKey = value; } });
  Object.defineProperty(Api, 'lastThreadId', { enumerable: true,
    get: function () { return lastThreadId; },
    set: function (value) { lastThreadId = value; } });
  Object.defineProperty(Api, 'detectedModelSlug', { enumerable: true,
    get: function () { return detectedModelSlug; },
    set: function (value) { detectedModelSlug = value; } });
  Object.defineProperty(Api, 'lastResolvedModelId', { enumerable: true,
    get: function () { return lastResolvedModelId; },
    set: function (value) { lastResolvedModelId = value; } });
  Object.defineProperty(Api, 'lastSnapshotModelName', { enumerable: true,
    get: function () { return lastSnapshotModelName; },
    set: function (value) { lastSnapshotModelName = value; } });
  Object.defineProperty(Api, 'netAttachTokens', { enumerable: true,
    get: function () { return netAttachTokens; },
    set: function (value) { netAttachTokens = value; } });
  Object.defineProperty(Api, 'netAttachBreak', { enumerable: true,
    get: function () { return netAttachBreak; },
    set: function (value) { netAttachBreak = value; } });
  Object.defineProperty(Api, 'netServerTokens', { enumerable: true,
    get: function () { return netServerTokens; },
    set: function (value) { netServerTokens = value; } });
  Object.defineProperty(Api, 'netEffectiveLen', { enumerable: true,
    get: function () { return netEffectiveLen; },
    set: function (value) { netEffectiveLen = value; } });
  Object.defineProperty(Api, 'exactCountEnabled', { enumerable: true,
    get: function () { return exactCountEnabled; },
    set: function (value) { exactCountEnabled = value; } });
  Object.defineProperty(Api, 'geminiApiKey', { enumerable: true,
    get: function () { return geminiApiKey; },
    set: function (value) { geminiApiKey = value; } });
  Object.defineProperty(Api, 'lastCountTokensText', { enumerable: true,
    get: function () { return lastCountTokensText; },
    set: function (value) { lastCountTokensText = value; } });
  Object.defineProperty(Api, 'lastCountTokensCache', { enumerable: true,
    get: function () { return lastCountTokensCache; },
    set: function (value) { lastCountTokensCache = value; } });
  Object.defineProperty(Api, 'countTokensTimer', { enumerable: true,
    get: function () { return countTokensTimer; },
    set: function (value) { countTokensTimer = value; } });
  Object.defineProperty(Api, 'countTokensPending', { enumerable: true,
    get: function () { return countTokensPending; },
    set: function (value) { countTokensPending = value; } });
  Object.defineProperty(Api, 'safePct', { enumerable: true,
    get: function () { return safePct; },
    set: function (value) { safePct = value; } });
  Object.defineProperty(Api, 'popupRawModel', { enumerable: true,
    get: function () { return popupRawModel; },
    set: function (value) { popupRawModel = value; } });
  Object.defineProperty(Api, 'popupRawPct', { enumerable: true,
    get: function () { return popupRawPct; },
    set: function (value) { popupRawPct = value; } });
  Object.defineProperty(Api, 'popupModelId', { enumerable: true,
    get: function () { return popupModelId; },
    set: function (value) { popupModelId = value; } });
  Object.defineProperty(Api, 'popupLimitPct', { enumerable: true,
    get: function () { return popupLimitPct; },
    set: function (value) { popupLimitPct = value; } });
  Object.defineProperty(Api, 'aiCmLastDomEmitSig', { enumerable: true,
    get: function () { return aiCmLastDomEmitSig; },
    set: function (value) { aiCmLastDomEmitSig = value; } });
  Object.defineProperty(Api, 'lastEmitConvId', { enumerable: true,
    get: function () { return lastEmitConvId; },
    set: function (value) { lastEmitConvId = value; } });
  Object.defineProperty(Api, 'lastSnapConvId', { enumerable: true,
    get: function () { return lastSnapConvId; },
    set: function (value) { lastSnapConvId = value; } });
  Object.defineProperty(Api, 'aiCmConvSourceByConv', { enumerable: true,
    get: function () { return aiCmConvSourceByConv; },
    set: function (value) { aiCmConvSourceByConv = value; } });
  Object.defineProperty(Api, 'aiCmArchiveLoadStarted', { enumerable: true,
    get: function () { return aiCmArchiveLoadStarted; },
    set: function (value) { aiCmArchiveLoadStarted = value; } });
  Object.defineProperty(Api, 'aiCmArchiveRestoredDispatched', { enumerable: true,
    get: function () { return aiCmArchiveRestoredDispatched; },
    set: function (value) { aiCmArchiveRestoredDispatched = value; } });
  Object.defineProperty(Api, 'aiCmArchiveCountByConv', { enumerable: true,
    get: function () { return aiCmArchiveCountByConv; },
    set: function (value) { aiCmArchiveCountByConv = value; } });
  Object.defineProperty(Api, 'aiCmSourceLabelNow', { enumerable: true,
    get: function () { return aiCmSourceLabelNow; },
    set: function (value) { aiCmSourceLabelNow = value; } });
  Object.defineProperty(Api, 'autoExportSettings', { enumerable: true,
    get: function () { return autoExportSettings; },
    set: function (value) { autoExportSettings = value; } });
  Object.defineProperty(Api, 'aiCmAutoExportFlagMissingLogged', { enumerable: true,
    get: function () { return aiCmAutoExportFlagMissingLogged; },
    set: function (value) { aiCmAutoExportFlagMissingLogged = value; } });
  Object.defineProperty(Api, 'autoExportFired', { enumerable: true,
    get: function () { return autoExportFired; },
    set: function (value) { autoExportFired = value; } });
  Object.defineProperty(Api, 'autoExportPctBySite', { enumerable: true,
    get: function () { return autoExportPctBySite; },
    set: function (value) { autoExportPctBySite = value; } });
  Object.defineProperty(Api, 'autoExportLastConvId', { enumerable: true,
    get: function () { return autoExportLastConvId; },
    set: function (value) { autoExportLastConvId = value; } });
  Object.defineProperty(Api, 'aiCmLoaderRunningByConv', { enumerable: true,
    get: function () { return aiCmLoaderRunningByConv; },
    set: function (value) { aiCmLoaderRunningByConv = value; } });
  Object.defineProperty(Api, 'autoExportLastPct', { enumerable: true,
    get: function () { return autoExportLastPct; },
    set: function (value) { autoExportLastPct = value; } });
  Object.defineProperty(Api, 'aiCmPendingHistWrite', { enumerable: true,
    get: function () { return aiCmPendingHistWrite; },
    set: function (value) { aiCmPendingHistWrite = value; } });
  Object.defineProperty(Api, 'aiCmCursorLiveByConv', { enumerable: true,
    get: function () { return aiCmCursorLiveByConv; },
    set: function (value) { aiCmCursorLiveByConv = value; } });
  Object.defineProperty(Api, 'aiCmBaseConfirmedByConv', { enumerable: true,
    get: function () { return aiCmBaseConfirmedByConv; },
    set: function (value) { aiCmBaseConfirmedByConv = value; } });
  Object.defineProperty(Api, 'aiCmLowConfidenceByConv', { enumerable: true,
    get: function () { return aiCmLowConfidenceByConv; },
    set: function (value) { aiCmLowConfidenceByConv = value; } });
  Object.defineProperty(Api, 'aiCmLateCheckByConv', { enumerable: true,
    get: function () { return aiCmLateCheckByConv; },
    set: function (value) { aiCmLateCheckByConv = value; } });
  Object.defineProperty(Api, 'trimProbe', { enumerable: true,
    get: function () { return trimProbe; },
    set: function (value) { trimProbe = value; } });
  Object.defineProperty(Api, 'preTrimExportFired', { enumerable: true,
    get: function () { return preTrimExportFired; },
    set: function (value) { preTrimExportFired = value; } });
  Object.defineProperty(Api, 'trimRetryByConv', { enumerable: true,
    get: function () { return trimRetryByConv; },
    set: function (value) { trimRetryByConv = value; } });
  Object.defineProperty(Api, 'TRIM_HEAD_IDS_N', { enumerable: true,
    get: function () { return TRIM_HEAD_IDS_N; },
    set: function (value) { TRIM_HEAD_IDS_N = value; } });
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmState = Api;
})();
