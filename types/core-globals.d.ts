/**
 * Ambient-контракт общего лексического скоупа content-скриптов (шаг 5 Фазы 1).
 *
 * core/*.js — классические скрипты манифеста MV3 (content_scripts[0].js), они делят
 * ОДИН глобальный лексический скоуп: объявления из core/state.ts, core/widget.ts,
 * core/base-handler.js, core/hybrid-tail.js, core/export-manager.js и utils-глобали
 * (ModelConfig, Tokenizer) видны соседям по имени. TypeScript при allowJs+checkJs
 * компилирует каждый файл изолированно и такие имена не видит (TS2304). Этот файл
 * описывает ШВУ между модулями, не меняя ни байта рантайма:
 *
 *   1. state-переменные из core/state.ts (реестр + UMD-зеркало AiCmState);
 *   2. кросс-модульные функции соседних core-модулей (widget, base-handler, hybrid-tail, export-manager);
 *   3. utils-глобали общего скоупа (ModelConfig, Tokenizer);
 *   4. importScripts — MV3 service worker (core/background.js).
 *
 * ПРАВИЛО НЕДУБЛИРОВАНИЯ: имена, объявленные В САМОМ файле-владельце (self-declared,
 * например aiCmAdapterBaseCount/aiCmAdapterBaseSeen в content.js или countTokensPending
 * в state.js/background.js), здесь НЕ декларируются — TS видит их объявления напрямую.
 * ИСКЛЮЧЕНИЕ — core/content.js после ESM-пилота (Ph2, шаг 3): файл начинается со
 * статического import'а, поэтому TS считает его модулем и его top-level объявления
 * больше не попадают в общий скоуп; для соседей они объявлены в секции ниже.
 * Только кросс-файловые чтения. Интерсепторы (gemini/deepseek/claude/google-search/
 * perplexity/qwen-intercept.js) НЕ типизируются — Фаза 3.
 */

// --- core/content.js: ESM-пилот (Roadmap Ph2, шаг 3) ---------------------------
// core/content.js импортирует utils/platform.js, поэтому TypeScript компилирует его как
// модуль: top-level function/var перестают быть глобалами общего скоупа, и
// core/widget.ts, core/base-handler.js, core/export-manager.js получают TS2304.
// Рантайм не меняется: build.mjs втягивает платформу в тот же бандл esbuild, и в
// content.js всё по-прежнему живёт в одной области видимости (это же пиннит
// tests/build-integrity.test.js). Объявления ниже — шов для соседей по бандлу.

/** Валиден ли контекст расширения (chrome.runtime.id); false в осиротевшем документе. */
declare function isExtensionValid(): boolean;

/** Google Search AI: документ действительно является чат-страницей (threadId/чат-контейнер). */
declare function aiCmGsaChatPageMarker(): boolean;

/** Число сообщений разговора convId в архиве (0, если записи нет). */
declare function aiCmArchiveCountFor(convId: string): number;

/** Отправлен ли в SW маркер готовности контента для текущего документа. */
declare var aiCmContentReadySent: boolean;

/** Таймер отложенного EMIT после сетевого события (null — таймера нет). */
declare var aiCmRequestEmitTimer: any;

/** Сброс признака полноты сети AI Studio (вызов из resetConversationState). */
declare function aiCmNetReadyAistudioReset(): boolean;

/** Сброс кэша предыдущего разговора AI Studio при смене чата. */
declare function aiCmAistudioHistoryCacheClear(): boolean;

// --- Service Worker (MV3) ----------------------------------------------------

/** MV3 service worker: доступен в core/background.js для подключения перехватчиков. */
declare function importScripts(...urls: string[]): void;

// --- utils-глобали общего скоупа ----------------------------------------------
// utils/model-config.js (строка 6) и utils/tokenizer.ts (строка 13) объявляют
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

// Ph2, шаг tokenizer.js: utils/tokenizer.ts переведён на ES-модуль (UMD-хвост снят),
// отдельного classic-скрипта в манифесте больше нет — глобального Tokenizer в рантайме
// не существует. Его единственный потребитель core/content.js получает объект статическим
// import'ом, поэтому глобальное объявление здесь снято: типы и рантайм совпадают.

/**
 * utils/export-text-builders.js: публичное API сборщиков экспорта (default-экспорт Api).
 * В бандле это ESM-биндинг, который втягивает core/content.js; core/export-manager.js и
 * adapters/qwen-adapter.js склеены в тот же модуль (import хойстится), поэтому второго
 * import'а в них нет — объявление закрывает их типы. В срезах-песочницах биндинга нет:
 * потребители резолвят его через typeof-гард.
 */
declare const AiCmExportBuilders: import('./export').ExportBuildersApi;

/**
 * utils/export-emit-pipeline.ts (Ph2: ESM) — публичный API пайплайна экспорта.
 * В бандле это ESM-биндинг, который втягивает core/content.js; core/export-manager.js,
 * core/base-handler.js и core/widget.ts склеены в тот же модуль (import хойстится),
 * поэтому второго import'а в них нет — объявление закрывает их типы. В срезах-песочницах
 * биндинга нет: потребители резолвят его через typeof-гард.
 */
declare const AiCmExportEmitPipeline: import('./export').ExportPipelineApi;

// --- core/base-handler.js: кросс-модульные функции ----------------------------

/** Канонический текст базы (prepareExportMessages текущего снимка); typeof-гард у читателей. */
declare function aiCmMetricBaseText(fallback: string): string;

/** base-handler.js: история из последнего принятого снимка сети ([{role,text}]). */
declare function buildHistoryMessages(): Array<{ role: string; text: string; [k: string]: unknown }>;

/**
 * base-handler.js (Step D.10, A-лайт): полная цепочка перед композицией файла —
 * дождаться текста вложений (до 2000 мс) → сетевой дозапрос истории (O-18) → колбэк.
 * Старый порядок «сеть → файл» сохранён: ожидание вложений добавлено ПЕРЕД ним.
 * typeof-гард у читателей (content.js/export-manager.js) — в срез-песочницах без
 * этой функции вызов деградирует до aiCmExportNetSyncThen.
 */
declare function aiCmExportFilesThenNetSync(
  convId: string | null,
  cb: (() => void) | null,
  netTimeoutMs?: number
): void;

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

/**
 * export-manager.js: Two-Tier (v89) — метка достоверности источника файла по сводке
 * объединённой базы ('[MERGED: ARCHIVE+LIVE]' / '[ARCHIVE]' / '[BEST-EFFORT: LIVE CAPTURE]').
 * undefined — не Gemini, моста нет или MAIN не ответил; typeof-гард у читателей.
 */
declare function aiCmGetSourceTier(): string | undefined;

/** export-manager.js: сетевая синхронизация перед экспортом — сайт или null. */
declare function aiCmExportNetSyncSite(): string | null;

/** export-manager.js: сетевая синхронизация перед экспортом — колбэк по завершении. */
declare function aiCmExportNetSyncThen(convId: string | null, cb: (() => void) | null, timeoutMs?: number): void;

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
declare function aiCmCurrentBaseSnapshot(cid: string | null): unknown[] | null;
declare function aiCmScheduleLateAutoExportRetry(cid: string): boolean;
declare function aiCmResyncMetricsAfterFlush(cid: string, reason?: string): boolean;
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
/** Шаг A.1 (security): карта session-латча ('aiCmFired:service|convId' → 1); читается из widget.js. */
declare let sessionFiredCache: Record<string, number>;
/** Шаг A.1 (security): дожидается гидратации sessionFiredCache из SW; читается из content.js. */
declare function aiCmLatchCacheReady(): Promise<Record<string, number>>;

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
declare function aiCmDiagLine(marker: string, data?: unknown): boolean;
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

// Ph2 (R1): utils/debug.ts переведён на ESM, поэтому его объявления больше не попадают
// в глобальную область вывода tsc автоматически. Но в MAIN-мире классический артефакт
// dist/utils/debug.js по-прежнему публикует эти функции глобально (см. writeDebugClassic
// в build.mjs), поэтому глобальный контракт объявляется здесь явно.
declare function swallow(error: unknown, tag: string): void;
declare function swallowSoft(error: unknown, tag: string): void;
declare function aiCmDiagWarn(tag: string, message: string, detail?: unknown): void;
declare function aiCmDiagDownload(trigger: string, content: unknown, fileName: string, extra?: unknown): boolean;
declare function aiCmDiagDownloadBlocked(trigger: string, content: unknown, fileName: string, reason: string, extra?: unknown): boolean;
declare function __aiCmSetDebugLogs(v: boolean): void;
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

// Интерсепторы и парсеры — Фаза 3 (ambient any по прецеденту types/globals.d.ts).
// Адаптеры (GoogleSearchAdapter, QwenAdapter, …) здесь больше НЕ объявляются: шаг 2
// миграции TypeScript перевёл adapters/*.js в adapters/*.ts, и классы теперь реальные
// глобальные объявления скриптовой области — ambient-зеркало давало TS2451.
declare const GeminiDomParser: any;
declare const GeminiInterceptLogic: any;
