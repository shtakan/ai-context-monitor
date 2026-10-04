/**
 * Ambient-контракт общего лексического скоупа content-скриптов (шаг 5 Фазы 1).
 *
 * core/*.js — классические скрипты манифеста MV3 (content_scripts[0].js), они делят
 * ОДИН глобальный лексический скоуп: объявления из core/state.js, core/widget.js,
 * core/base-handler.js, core/hybrid-tail.js, core/export-manager.js и utils-глобали
 * (ModelConfig, Tokenizer) видны соседям по имени. TypeScript при allowJs+checkJs
 * компилирует каждый файл изолированно и такие имена не видит (TS2304). Этот файл
 * описывает ШВУ между модулями, не меняя ни байта рантайма:
 *
 *   1. state-переменные из core/state.js (реестр + UMD-зеркало AiCmState);
 *   2. кросс-модульные функции соседних core-модулей (widget, base-handler, hybrid-tail, export-manager);
 *   3. utils-глобали общего скоупа (ModelConfig, Tokenizer);
 *   4. importScripts — MV3 service worker (core/background.js).
 *
 * ПРАВИЛО НЕДУБЛИРОВАНИЯ: имена, объявленные В САМОМ файле-владельце (self-declared,
 * например aiCmAdapterBaseCount/aiCmAdapterBaseSeen в content.js или countTokensPending
 * в state.js/background.js), здесь НЕ декларируются — TS видит их объявления напрямую.
 * Только кросс-файловые чтения. Интерсепторы (gemini/deepseek/claude/google-search/
 * perplexity/qwen-intercept.js) НЕ типизируются — Фаза 3.
 */

// --- Service Worker (MV3) ----------------------------------------------------

/** MV3 service worker: доступен в core/background.js для подключения перехватчиков. */
declare function importScripts(...urls: string[]): void;

// --- utils-глобали общего скоупа ----------------------------------------------
// utils/model-config.js (строка 6) и utils/tokenizer.js (строка 13) объявляют
// const в общем скоупе; module.exports — только для Node-ветки тестов.

/** utils/model-config.js: реестр моделей (computeDisplayLimit, resolveModelId, getModel и др.). */
declare const ModelConfig: {
  computeDisplayLimit(modelId: string, pct?: number | null): number;
  resolvePopupModelId(raw: unknown): string | null;
  resolveLimitPct(raw: unknown): number | null;
  resolveModelId(raw: unknown): string | null;
  getModel(modelId: string): { name?: string; [k: string]: unknown } | null;
  getFamilyDefaultModelId(family: string, variant?: string): string | null;
  getDefaultModel(siteName: string): string | null;
  getContextLimit(modelId: string): number;
  getEffectiveLimit(modelId: string): number;
  getGeminiApiModelId(modelId: string): string;
};

/** utils/tokenizer.js: оценка токенов (countTokens, estimateDialogTokens). */
declare const Tokenizer: {
  countTokens(text: string): number;
  estimateDialogTokens(dialogText: string, messageCount?: number): number;
};

// --- core/widget.js: кросс-модульные функции ---------------------------------

/** Идентификатор сервиса по URL ('chatgpt' | 'deepseek' | 'gemini' | 'google_search' | ...). */
declare function getServiceKey(): string;

/** core/widget.js: полный сброс conversation-state (таймеры, виджет, кэши). */
declare function resetConversationState(): void;

/** core/widget.js: перерисовка виджета (создаёт при отсутствии). */
declare function updateWidget(
  percentage: number,
  tokens: number,
  effectiveLimit: number,
  contextLimit: number,
  displayLimit: number,
  modelName: string,
  attachBreak?: { imgTokens: number; docTokens: number; imgCount: number; docCount: number } | null
): void;

/** core/widget.js: создание DOM-виджета. */
declare function createWidget(): void;

/** core/widget.js: тема виджета (chatgpt/deepseek/gemini/google_search). */
declare const THEME_CONFIGS: Record<string, { font: string; light: Record<string, string>; dark: Record<string, string> }>;

// --- core/base-handler.js: кросс-модульные функции ----------------------------

/** Канонический текст базы (prepareExportMessages текущего снимка); typeof-гард у читателей. */
declare function aiCmMetricBaseText(fallback: string): string;

/** base-handler.js: история из последнего принятого снимка сети ([{role,text}]). */
declare function buildHistoryMessages(): Array<{ role: string; text: string; [k: string]: unknown }>;

// --- core/hybrid-tail.js: кросс-модульные функции ----------------------------

/** Нормализация строки для сравнения скелетов (lowercase + сжатие разделителей). */
declare function normalize(s: string): string;

/** Снятие markdown-разметки (ссылки, код). */
declare function stripMd(s: string): string;

/** hybrid-tail.js: поиск узлов сообщений в DOM. */
declare function findMessageNodes(): { nodes: Element[]; sel: string };

/** hybrid-tail.js: эффективный полный текст диалога (база + DOM-хвост). */
declare function getEffectiveText(): string;

/** hybrid-tail.js: эффективное число сообщений (база + DOM-хвост). */
declare function getEffectiveCount(fallbackCount: number): number;

// --- core/export-manager.js: кросс-модульные функции -------------------------

/** Автоэкспорт при достижении порога; typeof-гард у читателей. */
declare function maybeAutoExport(percentage: number): void;

/** export-manager.js: единая точка сбора сообщений файла (санация O-20/O-40/O-42, роли O-39). */
declare function aiCmCollectExportSource(): Array<{ role: string; text: string; reasoning?: string }> | null;

/** export-manager.js: Санация текста Gemini перед экспортом. */
declare function sanitizeGeminiText(s: string): string;

/** export-manager.js: снимок Gemini-тёрнов для экспортной базы (convId/messages/...). */
declare function aiCmGeminiTurnsSnapshotSync(): unknown | null;

/** export-manager.js: сетевая синхронизация перед экспортом — сайт или null. */
declare function aiCmExportNetSyncSite(): string | null;

/** export-manager.js: сетевая синхронизация перед экспортом — колбэк по завершении. */
declare function aiCmExportNetSyncThen(convId: string | null, cb: (() => void) | null, timeoutMs?: number): void;

// --- core/state.js: реестр state-переменных ----------------------------------
// Классические let/var из core/state.js (строки 23–229), читаемые соседями.
// Типы — по факту инициализации в state.js: null => T | null; {} => Record.

/** Текущий адаптер сайта (adapters/base-adapter.js). */
declare let currentAdapter: BaseAdapter | null;
/** MutationObserver диалога. */
declare let observer: MutationObserver | null;
/** Флаг первичной инициализации content.js. */
declare let isInitialized: boolean;
/** Последний показанный процент. */
declare let lastPercentage: number;
/** Таймер отложенного обновления виджета. */
declare let updateTimer: ReturnType<typeof setTimeout> | null;
/** Корневой элемент виджета. */
declare let widgetElement: HTMLElement | null;
/** Последние данные виджета (кэш для отложенного рендера). */
declare let lastWidgetData: {
  percentage: number;
  tokenEstimate: number;
  effectiveLimit: number;
  contextLimit: number;
  displayLimit: number;
  modelName: string;
  attachBreak: { imgTokens: number; docTokens: number; imgCount: number; docCount: number } | null;
} | null;
/** Подавление badge-обновлений до первого снимка нового чата (v1.8.1). */
declare let badgeSuppressed: boolean;
/** Максимум токенов, посчитанный по базе/сети. */
declare let maxTokenCount: number;
/** Флаг однократного восстановления ленты при загрузке чата (v28). */
declare let restoredTapeLoaded: boolean;
/** Флаг завершения восстановления — разрешает сохранение ленты (v30). */
declare let restoreDone: boolean;
/** convId → true — планирование уточнения после кэша (v30.6). */
declare let cacheRefreshPlanned: Record<string, boolean>;
/** convId → true — лента чата уже восстановлена в сессии страницы (v77/O2). */
declare let tapeRestoreSeen: Record<string, boolean>;
/** convId → account index на момент последнего tape load (v82/D8; строка — getAccountIndex()). */
declare let aiCmTapeAccountIdx: Record<string, string>;
/** convId → true — ai-cm-restored-history уже диспатчен (v82/D9-A). */
declare let aiCmRestoredDispatched: Record<string, boolean>;
/** Сводный текст базы. */
declare let baseText: string;
/** Число сообщений базы. */
declare let baseCount: number;
/** База хоть раз получена (сеть). */
declare let baseSeen: boolean;
/** «База принята по convId» для DOM-адаптера (O-35, брат-флаг baseSeen). */
declare let adapterBaseSeen: boolean;
/** База получена полностью (сеть, без тихой пагинации). */
declare let baseComplete: boolean;
/** Последний DOM-хвост нашёл границу (монотонный максимум). */
declare let lastBounded: boolean;
/** Антиспам: сигнатура последней печати «[hybrid-tail]». */
declare let lastTailSig: string | null;
/** Антиспам: сигнатура последней печати «📥 база полной истории». */
declare let lastBaseSig: string | null;
/** Антиспам: сигнатура последней печати «[content-trace] EMIT принят». */
declare let lastEmitSig: string | null;
/** Антиспам: сигнатура последней печати «[content-trace] DRAW». */
declare let lastDrawSig: string | null;
/** Антиспам: последняя напечатанная строка «[hybrid-tail]». */
declare let lastHybridTailSig: string | null;
/** O-32: антиспам строки gsa-metric-src. */
declare let lastMetricSig: string | null;
/** Антиспам skip reason=not-complete — один раз на convId (v30.5). */
declare let notCompleteLogged: Record<string, number>;
/** Заморозка бейджа на время скрытой загрузки лоадером Gemini (v30.8). */
declare let aiCmLoaderFreeze: boolean;
/** Множество id сообщений базы. */
declare let baseIdSet: Set<string> | null;
/** id сообщений базы последнего снимка. */
declare let lastBaseIds: string[];
/** Тексты сообщений базы последнего снимка (единый источник экспорта). */
declare let lastBaseTexts: string[];
/** Множество скелетов сообщений базы. */
declare let baseSkelSet: Set<string> | null;
/** Массив якорей базы (обрезки скелетов). */
declare let baseAnchors: string[] | null;
/** Признак устаревания базы (сетевого снимка нет 12с). */
declare let stale: boolean;
/** Таймер отложенной проверки устаревания. */
declare let staleTimer: ReturnType<typeof setTimeout> | null;
/** [{role,text}] из последнего detail.messages (или null). */
declare let lastDetailMessages: Array<{
  role?: string;
  text?: string;
  id?: unknown;
  reasoning?: string;
  r1?: unknown;
  turnId?: unknown;
  [k: string]: unknown;
}> | null;
/** Сигнатура 'baseCount|textLen' последней записи aiCmHistory. */
declare let lastHistoryWroteKey: string | null;
/** threadId последнего применённого снимка Google (сброс при SPA-возврате). */
declare let lastThreadId: string | null;
/** Slug модели, определённый по DOM/сети. */
declare let detectedModelSlug: string;
/** Последний id модели, разрешённый из сети. */
declare let lastResolvedModelId: string | null;
/** v47: имя модели СНИМКА (сеть/тэйп/адаптер). */
declare let lastSnapshotModelName: string;
/** Вложения: токены из сети (Gemini). */
declare let netAttachTokens: number;
/** Вложения: признак обрыва (частичная догрузка). */
declare let netAttachBreak: { imgTokens: number; docTokens: number; imgCount: number; docCount: number } | null;
/** Server-side токены (DeepSeek accumulated_token_usage). */
declare let netServerTokens: number;
/** O-35 (B1): серверный usage Qwen из стрима (output/reasoning/total). */
declare let netQwenUsage: { outputTokens?: number; reasoningTokens?: number; total?: number } | null;
/** Эффективная длина последнего сетевого расчёта. */
declare let netEffectiveLen: number;
/** Включён ли точный подсчёт (countTokens API). */
declare let exactCountEnabled: boolean;
/** Gemini API-ключ (BYOK, M-7 — только chrome.storage.session). */
declare let geminiApiKey: string;
/** Последний текст точного подсчёта (dedupe-ключ). */
declare let lastCountTokensText: string;
/** Кэш точного подсчёта (последнее число токенов). */
declare let lastCountTokensCache: number;
/** Таймер дебаунса точного подсчёта. */
declare let countTokensTimer: ReturnType<typeof setTimeout> | null;
/** Safe-percentage (порог виджета; null = Авто). */
declare let safePct: number | null;
/** H19: сырое selectedModel из попапа ('auto' = Автоопределение). */
declare let popupRawModel: string | null;
/** H19: сырое customLimit из попапа. */
declare let popupRawPct: number | null;
/** H19: канонический id выбранной модели; null = Автоопределение. */
declare let popupModelId: string | null;
/** H19: 1..100; null = Авто (поле пустое). */
declare let popupLimitPct: number | null;
/** v55: сигнатура последнего DOM-эмита. */
declare let aiCmLastDomEmitSig: string | null;
/** O-24 (F6): чат, которому принадлежит aiCmLastDomEmitSig. */
declare let aiCmLastDomEmitConvId: string | null;
/** v34: convId последнего принятого снимка (гард экспорта). */
declare let lastEmitConvId: string;
/** v37: convId последнего снимка (сброс монотонного максимума). */
declare let lastSnapConvId: string;
/** convId → запись источника (для попапа/виджета). */
declare let aiCmConvSourceByConv: Record<string, { kind: string; label: string; format?: string; count?: number } | null>;
/** convId → true — чтение архива уже запущено (page-session). */
declare let aiCmArchiveLoadStarted: Record<string, boolean>;
/** convId → true — ai-cm-archive-restore уже диспатчен. */
declare let aiCmArchiveRestoredDispatched: Record<string, boolean>;
/** T1-fix#2 (v1.16.2): convId → count архивных ходов (гейт экспорта). */
declare let aiCmArchiveCountByConv: Record<string, number>;
/** Ярлык источника для тултипа виджета. */
declare let aiCmSourceLabelNow: string;
/** v1.8: настройки автоэкспорта (aiCmAutoExport/aiCmAutoExportPct/aiCmAutoExportFmt). */
declare let autoExportSettings: { enabled: boolean; pct: number; fmt: string };
/** M-13c: антиспам строки «флаг enabled отсутствует». */
declare let aiCmAutoExportFlagMissingLogged: boolean;
/** convId → 1 — автоэкспорт один раз на чат. */
declare let autoExportFired: Record<string, number>;
/** O-38: модульный латч «один раз на чат» ('site|convId' → 1); переживает resetConversationState. */
declare let aiCmAutoExportFiredOnce: Record<string, number>;
/** O-29: family → сигнатура последней напечатанной лог-строки автоэкспорта. */
declare let aiCmAutoExportLastLogState: Record<string, string>;
/** S2: per-site порог автоэкспорта (siteName → 1..100). */
declare let autoExportPctBySite: Record<string, number>;
/** O-43: монотонный латч сетевой полноты GSA ('site|threadId' → 1). */
declare let aiCmGsaNetworkCompleteLatch: Record<string, number>;
/** O-43: threadId, для которого латч был сброшен последним. */
declare let aiCmGsaNetworkCompleteThreadId: string | null;
/** Сброс fired при смене чата. */
declare let autoExportLastConvId: string;
/** v42: convId → 1, пока лоадер Gemini бежит по чату. */
declare let aiCmLoaderRunningByConv: Record<string, number>;
/** v42: последний pct для однократного re-check на стопе лоадера. */
declare let autoExportLastPct: number;
/** v52: отложенная запись aiCmHistory ({convId, timer}) или null. */
declare let aiCmPendingHistWrite: { convId: string; timer: ReturnType<typeof setTimeout> } | null;
/** v53: convId → true — курсор лоадера жив (автоэкспорт не стреляет). */
declare let aiCmCursorLiveByConv: Record<string, boolean | number>;
/** v1.13.1: convId → 1 — база подтверждённо полная (reachedStart=true). */
declare let aiCmBaseConfirmedByConv: Record<string, number>;
/** v63: convId → true/1 — база подтверждена (sanity-фолбэк без proof = true; reachedStart = 1). */
declare let aiCmLowConfidenceByConv: Record<string, boolean | number>;
/** v53: convId → true — ждём поздний re-check (гасится после фактического re-check). */
declare let aiCmLateCheckByConv: Record<string, number>;
/** v54: trimProbe[cid] = {maxCount, firstIds, suspectPending} — эталон последнего ПОЛНОГО снимка. */
declare let trimProbe: Record<string, unknown>;
/** v54: cid → 1 — pre-trim экспорт один раз на чат. */
declare let preTrimExportFired: Record<string, number>;
/** v54: счётчик ретраев инвариантов полноты (≤5 по 2с). */
declare let trimRetryByConv: Record<string, number>;

/** Минимум символов для якоря (state.js; в state.js — const, здесь let для UMD-сеттера). */
declare let ANCHOR_MIN: number;

/** N первых id снимка для сравнения голов трим-детектора (state.js). */
declare let TRIM_HEAD_IDS_N: number;

// --- Швы между core-модулями: остальные кросс-файловые имена ------------------
// base-handler.js (используется content.js/export-manager.js)
declare function aiCmHostHistoryRecord(snapshot: unknown): unknown;
declare function aiCmLogIntraDedupe(role: string, blocks: unknown): void;
declare function aiCmDedupeExportSource(
  messages: Array<{ role?: string; text?: string; id?: unknown; [k: string]: unknown }>
): { messages: Array<{ role?: string; text?: string; id?: unknown; [k: string]: unknown }>; removed: number };
declare function aiCmLogDedupeRemoved(removed: number): void;
declare function aiCmPreparedText(messages: unknown[]): string;
declare function aiCmDiagHash6(id: string, text: string): string;
declare function aiCmDumpTurnsSnapshot(tag: string, cid: string | null, msgs: unknown[]): void;
declare function aiCmLogNetSyncResult(convId: string | null, info: unknown): void;
declare function scheduleStaleCheck(): void;
declare let lastDedupeLogSig: string | null;
declare let aiCmBasePrepared: Array<{ role?: string; text?: string; id?: unknown; [k: string]: unknown }> | null;
declare let aiCmNetSyncSeq: number;

// hybrid-tail.js (используется content.js/export-manager.js)
declare function nodeIsBase(node: Element, skel: string): boolean;
declare function shouldUseGeminiDomParser(): boolean;
declare function computeTailFromDom(): { text: string; count: number; bounded: boolean; sel: string; diag: unknown };
declare function aiCmTailMetricBase(fallback: string): string;

// widget.js (используется content.js/export-manager.js)
declare function safePctKey(): string;
declare function aiCmRingBounds(): [number, number];
declare function zoneColor(p: number): string;
declare function aiCmActivePct(): number | null;
declare function computeEffectiveLimit(modelId: string | null): number;
declare function aiCmSetPopupOverrides(rawModel: unknown, rawPct: unknown): void;
declare function aiCmRefreshPopupOverrides(): void;
declare function aiCmLoadPopupOverrides(): void;
declare function updatePanel(): void;
declare function snapCurrentPct(): void;
declare function setSafePctFromInput(v: unknown): void;
declare function resetSafePct(): void;
declare function stepSafePct(delta: number): void;
declare function aiCmInAppTheme(): 'dark' | 'light' | null;
declare function isDarkMode(): boolean;
declare function applyNativeStyles(container: HTMLElement): void;
declare function aiCmRefreshThemeIfNeeded(): boolean;
declare function aiCmStartThemePoll(): void;
declare function aiCmStopThemePoll(): void;
declare function aiCmRevealWidget(): void;
declare function aiCmComputeWidgetSafeBottom(container: HTMLElement | null): number;
declare function aiCmUpdateWidgetSafeBottom(container: HTMLElement | null): number;
declare function aiCmStartWidgetSafeBottomWatch(container: HTMLElement | null): void;
declare function aiCmStopWidgetSafeBottomWatch(): void;
declare function aiCmRestartWidgetSafeBottomWatch(): void;
declare function aiCmSetWidgetPanelOpen(open: boolean, restoreFocus?: boolean): boolean;
declare function aiCmToggleWidgetPanel(restoreFocus?: boolean): void;
declare function aiCmBindWidgetA11y(): void;
declare function aiCmSetWidgetA11yLabel(circleEl: Element | null, percentage: number): void;
declare function aiCmRepaintRing(): void;
declare function aiCmLoadRingThresholds(): void;

// export-manager.js (используется content.js/widget.js/base-handler.js)
declare function aiCmSanitizeDebugOn(): boolean;
declare function aiCmEmitEntryDiag(...args: unknown[]): void;
declare function aiCmHiddenExportEffectiveOn(messages: unknown[]): boolean;
declare function aiCmSanitizeEmitUserTexts(messages: unknown[]): unknown[];
declare function aiCmReasoningExportSite(): string | null;
declare function aiCmPrepareReasoningForExport(messages: unknown[]): unknown[];
declare function aiCmExportBaseSource(convId: string | null, localMsgs: unknown[]): unknown;
declare function autoExportPerSiteKey(siteName: string): string;
declare function loadAutoExportPerSitePct(): void;
declare function aiCmTryLateAutoExport(cid: string): void;
declare function detectTrimStateFallback(prevProbe: unknown, snapshot: unknown): unknown;
declare function geminiDetectTrim(detail: unknown): unknown;
declare function maybeTrimExport(cid: string): void;
declare function aiCmCancelDeferredHistWrite(cid: string | null): void;
declare function aiCmUnionFileMessages(cid: string, localMsgs: unknown[], isLowConfidence?: boolean): unknown[];
declare function aiCmWriteCurrentHistory(): void;
declare function aiCmFlushDeferredHistWrite(cid: string, reason?: string): void;
declare function aiCmScheduleDeferredHistWrite(cid: string): void;
declare function loadAutoExportSettings(): void;
declare function loadExportHiddenSetting(): void;
declare function aiCmAutoExportConvId(): string;
declare function aiCmGsaNetworkCompleteReset(threadId?: string | null): boolean;
declare function aiCmGsaNetworkCompleteSet(threadId?: string | null): boolean;
declare function aiCmGsaNetworkCompleteIs(site: string, cid: string | null): boolean;
declare function aiCmGsaProbeRunningFor(cid: string | null): boolean;
declare function aiCmAutoExportLogOnChange(family: string, key: string): boolean;
declare function aiCmAutoExportLogFiredBit(site: string, cid: string | null): number;
declare function aiCmGsaAutoExportSkipLog(reason: string, cid: string | null): void;
declare function aiCmDeepseekStreamProbe(): void;
declare function aiCmDeepseekStreamActiveFor(cid: string | null): boolean;
declare function aiCmFlushLiveStreamForExport(cid: string): void;
declare function aiCmDeferAutoExportOnLiveStream(cid: string, percentage: number): void;
declare function aiCmAutoExportBasePendingLog(cid: string | null, percentage: number): void;
declare function aiCmAutoExportDecisionDiag(...args: unknown[]): void;
declare function aiCmEffectiveAutoExportThreshold(siteName: string): number;
declare function aiCmAutoExportStartDownload(content: string, file: string, fmt: string): void;
declare function doAutoExportDownload(cid: string, percentage: number, reason: string): void;

// content.js (используется widget.js/export-manager.js/base-handler.js)
declare function aiCmI18nMessage(key: string, fallback: string, substitutions?: unknown[]): string;
declare function aiCmEstimateTokensTilde(text: string, attachTokens?: number): number;
declare function aiCmMetricServerTokens(svc: string | null): number;
declare function aiCmSourceInfo(): { kind: string; label: string } | null;
declare function aiCmUpdateSourceIndicator(): void;
declare function aiCmDomTextSig(): string;
declare function aiCmSiteConvFired(): boolean;
declare function requestExactTokens(fullText: string, modelId: string | null): void;
declare function processAndSend(): void;
declare function sendThresholdPct(pct: number): void;
declare function handleAiCmDiag(sendResponse: (response?: unknown) => void): boolean;
declare function applyDebugLogs(v: unknown): void;
declare function aiCmDispatchContentReady(): void;
declare function getCurrentConvId(): string | null;
declare function aiCmAssignAdapterByHost(): BaseAdapter | null;
declare function detectSelectedModelFromDom(snapModelId: string | null): { modelId: string | null; fam: string | null; variant: string | null };
declare function resolveCurrentModel(): { modelId: string | null; fam: string | null; variant: string | null };
declare function geminiParserVersion(): string;
declare function getAccountIndex(): string;
declare function geminiTapeKey(convId: string): string;
declare function aiCmIsWidgetNode(node: Node | null): boolean;
declare function aiCmH23Site(): boolean;
declare function aiCmLoadArchiveTier(convId: string, reason: string): void;
declare function logTextProbe(label: string, text: string): void;
declare function aiCmBadgeHoldActive(): boolean;
declare function aiCmDomThreadId(): string | null;
declare function aiCmDiagLine(marker: string, data?: unknown): void;
declare function aiCmDiagDocKind(): string;
declare function aiCmDiagStack(depth?: number): string;
declare function aiCmDiagOn(): boolean;
declare function aiCmQwenInitDiag(marker: string, data?: unknown): void;
declare function aiCmQwenInitErrText(e: unknown): string;
declare function aiCmQwenExportBaseTrusted(): boolean;
declare function aiCmAutoExportTrustedBase(): boolean;
declare function aiCmAutoExportTrustedBaseDiag(...args: unknown[]): void;
declare function aiCmLoadProactiveFlag(): void;
declare function debugLog(level: string, ...args: unknown[]): void;
declare const aiCmIncludeHiddenInExport: boolean;

// Window-поля: трассировка/UMD-глобали (прецедент types/globals.d.ts — any до Фазы 3).
// Файл — НЕ module (нет import/export), поэтому interface Window объявляется напрямую
// (без declare global) — глобальное слияние интерфейсов, как в globals.d.ts:46.
interface Window {
  /** O-22: счётчик трассировки RESET/DRAW. */
  __aiCmTraceSeq?: number;
  /** v81 Step1: событие ai-cm-full-history дошло до content.js. */
  __aiCmEmitChannelSeen?: boolean;
  /** page-intercept.js: гвард повторной установки IIFE. */
  __aiCmInterceptInstalled?: boolean;
  /** UMD-зеркала модулей (инструменты/отладка/тесты); типизация — Фаза 3. */
  AiCmState?: any;
  AiCmWidget?: any;
  AiCmBaseHandler?: any;
  AiCmHybridTail?: any;
  AiCmExportManager?: any;
}

// Интерсепторы и парсеры — Фаза 3 (ambient any по прецеденту types/globals.d.ts)
declare const GeminiDomParser: any;
declare const GeminiInterceptLogic: any;
declare const GoogleSearchAdapter: any;
declare const QwenAdapter: any;
