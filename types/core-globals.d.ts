/**
 * Ambient-контракт общего лексического скоупа content-скриптов (шаг 5 Фазы 1).
 *
 * core/*.js (content.js, background.js, page-intercept.js) — классические скрипты
 * манифеста MV3 (content_scripts[0].js); core/*.ts (state, widget, base-handler,
 * hybrid-tail, export-manager) вливаются в тот же бандл. Все они делят ОДИН
 * глобальный лексический скоуп: объявления из этих файлов и utils-глобали
 * (ModelConfig, Tokenizer) видны соседям по имени. TypeScript при allowJs+checkJs
 * компилирует каждый файл изолированно и такие имена не видит (TS2304). Этот файл
 * описывает ШВУ между модулями, не меняя ни байта рантайма:
 *
 *   1. state-переменные из core/state.ts (реестр + UMD-зеркало AiCmState);
 *   2. кросс-модульные функции соседних core-модулей (widget, base-handler, hybrid-tail, export-manager);
 *   3. utils-глобали общего скоупа (ModelConfig, Tokenizer);
 *   4. importScripts — MV3 service worker (core/background.ts).
 *
 * ПРАВИЛО НЕДУБЛИРОВАНИЯ: имена, объявленные В САМОМ файле-владельце (self-declared,
 * например aiCmAdapterBaseCount/aiCmAdapterBaseSeen в content.js или countTokensPending
 * в state.ts/background.js), здесь НЕ декларируются — TS видит их объявления напрямую.
 * ИСКЛЮЧЕНИЕ — core/content.js после ESM-пилота (Ph2, шаг 3): файл начинается со
 * статического import'а, поэтому TS считает его модулем и его top-level объявления
 * больше не попадают в общий скоуп; для соседей они объявлены в секции ниже.
 * Только кросс-файловые чтения. Интерсепторы (gemini/deepseek/claude/google-search/
 * perplexity/qwen-intercept.js) НЕ типизируются — Фаза 3.
 */

// --- core/content.js: ESM-пилот (Roadmap Ph2, шаг 3) ---------------------------
// core/content.js импортирует utils/platform.js, поэтому TypeScript компилирует его как
// модуль: top-level function/var перестают быть глобалами общего скоупа, и
// core/widget.ts, core/base-handler.ts, core/export-manager.ts получают TS2304.
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

/** MV3 service worker: доступен в core/background.ts для подключения перехватчиков. */
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

// --- core/hybrid-tail.ts: кросс-модульные функции ----------------------------
// hybrid-tail.ts начинается с top-level import'а (utils/gemini-dom-parser.ts), поэтому TS
// считает его модулем: top-level имена не попадают в общий скоуп конкатенации, и для
// соседей (content.js, export-manager.ts) они объявлены здесь.

/** Нормализация строки для сравнения скелетов (lowercase + сжатие разделителей). */
declare function normalize(s: string): string;

/** Снятие markdown-разметки (ссылки, код). */
declare function stripMd(s: string): string;

/** hybrid-tail.ts: поиск узлов сообщений в DOM. */
declare function findMessageNodes(): { nodes: Element[]; sel: string };

/** hybrid-tail.ts: эффективный полный текст диалога (база + DOM-хвост). */
declare function getEffectiveText(): string;

/** hybrid-tail.ts: эффективное число сообщений (база + DOM-хвост). */
declare function getEffectiveCount(fallbackCount: number): number;

/** hybrid-tail.ts: сообщения, из которых строится ровно getEffectiveText(); null — канонического тела нет. */
declare function getEffectiveMessages(): AiCmExportMessage[] | null;

// --- Швы между core-модулями: остальные кросс-файловые имена ------------------

// hybrid-tail.ts (используется content.js/export-manager.ts)
declare function nodeIsBase(node: Element, skel: string): boolean;
declare function shouldUseGeminiDomParser(): boolean;
declare function computeTailFromDom(): { text: string; count: number; bounded: boolean; sel: string; messages: AiCmExportMessage[]; diag: unknown };
declare function aiCmTailMetricBase(fallback: string): string;

// core/content.js (используется widget.ts/export-manager.ts/base-handler.ts)
declare function aiCmResyncMetricsAfterFlush(cid: string, reason?: string): boolean;

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
// S4/I6: канонический id чата для снимка метрики — ОДНА формула на запись и чтение
// (core/state.ts: aiCmCanonicalConvId = aiCmAutoExportConvId() || getCurrentConvId() || '').
declare function aiCmCanonicalConvId(): string;
declare function aiCmAssignAdapterByHost(): BaseAdapter | null;
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
declare function __aiCmGetLogRing(): string[];

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
  /** core/gemini-diag-dump.ts: UMD-зеркало дампа диагностики (MAIN-мир). */
  AiCmGeminiDiagDump?: any;
}

// Интерсепторы и парсеры — Фаза 3 (ambient any по прецеденту types/globals.d.ts).
// Адаптеры (GoogleSearchAdapter, QwenAdapter, …) здесь больше НЕ объявляются: шаг 2
// миграции TypeScript перевёл adapters/*.js в adapters/*.ts, и классы теперь реальные
// глобальные объявления скриптовой области — ambient-зеркало давало TS2451.
declare const GeminiDomParser: any;
declare const GeminiInterceptLogic: any;
