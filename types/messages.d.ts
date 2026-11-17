/**
 * Контракты сообщений границы Service Worker (C1: background ↔ content/print).
 *
 * Источник форм — фактические ветки chrome.runtime.onMessage в core/background.ts и
 * места отправки: core/content.ts (COUNT_TOKENS, THRESHOLD_PCT, BADGE_RESET),
 * core/state.ts (aiCm-get-byok-key, aiCm-latch-*), print/print.js (close-print-tab).
 *
 * THRESHOLD_PCT.data несёт site (core/content.ts:3374), которого нет в локальном
 * AiCmThresholdData SW: checkThresholds читает только pct/convId, поэтому site
 * объявлен здесь как факт отправки, а не как поле потребителя.
 *
 * Модуль самодостаточен: импортов нет (каждый тип читается независимо).
 */

/** Отправитель сообщения — второй аргумент onMessage-листенера SW. */
export interface AiCmSwSender {
  /** Extension-id отправителя (проверка aiCmTrustedSender). */
  id?: string;
  /** URL отправителя; SW его не читает, но форма приходит от chrome. */
  url?: string;
  /** Таб-источник: без tab.id SW не отвечает на latch/byok-каналы. */
  tab?: { id?: number | null; windowId?: number | null };
}

/** COUNT_TOKENS: запрос точного подсчёта токенов через BYOK (core/content.ts:1949). */
export interface AiCmSwCountTokensRequest {
  type: 'COUNT_TOKENS';
  /** Текст диалога; пустой текст отвечает { totalTokens: 0 } без сети. */
  text: string;
  /** Модель Gemini; при отсутствии SW берёт 'gemini-flash-latest'. */
  model?: string;
  /** Разговор: часть debounce-ключа tabId:convId:model (core/background.ts:1056). */
  convId?: string | number;
  /** Признак отмены предшественника; в ключ не входит (эхо в ответе). */
  debounced?: number;
}

/** THRESHOLD_PCT: порог контекста для бейджа/уведомлений (core/content.ts:3372). */
export interface AiCmSwThresholdPctRequest {
  type: 'THRESHOLD_PCT';
  /** Данные порога; site приходит от content, потребитель читает pct/convId. */
  data: { pct?: number; convId?: string | number; site?: string };
}

/** BADGE_RESET: гашение per-tab бейджа старого разговора (core/content.ts:349/419). */
export interface AiCmSwBadgeResetRequest {
  type: 'BADGE_RESET';
}

/** close-print-tab: закрыть таб печати из print/print.js:190. */
export interface AiCmSwClosePrintTabRequest {
  type: 'close-print-tab';
}

/** aiCm-get-byok-key: факт наличия BYOK-ключа, значение наружу не уходит. */
export interface AiCmSwByokKeyRequest {
  type: 'aiCm-get-byok-key';
}

/** aiCm-latch-get: взведён ли латч 'service|convId' в session-хранилище SW. */
export interface AiCmSwLatchGetRequest {
  type: 'aiCm-latch-get';
  service: string;
  convId?: string | number;
}

/** aiCm-latch-set: взвести латч (значение 1). */
export interface AiCmSwLatchSetRequest {
  type: 'aiCm-latch-set';
  service: string;
  convId?: string | number;
}

/** aiCm-latch-remove: снять латч (удалить ключ). */
export interface AiCmSwLatchRemoveRequest {
  type: 'aiCm-latch-remove';
  service: string;
  convId?: string | number;
}

/** aiCm-latch-get-all: карта всех взведённых ключей для гидратации вкладки. */
export interface AiCmSwLatchGetAllRequest {
  type: 'aiCm-latch-get-all';
}

/** Любое сообщение, разбираемое onMessage; ветвление по type сужает payload. */
export type AiCmSwRequest =
  | AiCmSwCountTokensRequest
  | AiCmSwThresholdPctRequest
  | AiCmSwBadgeResetRequest
  | AiCmSwClosePrintTabRequest
  | AiCmSwByokKeyRequest
  | AiCmSwLatchGetRequest
  | AiCmSwLatchSetRequest
  | AiCmSwLatchRemoveRequest
  | AiCmSwLatchGetAllRequest;

/**
 * Ответ COUNT_TOKENS: поля опциональны, потому что путей ответа много —
 * cache-hit { ok, totalTokens, tokens, cached: 1, debounced: 0 }, сеть
 * { ok, totalTokens, tokens, cached: 0, debounced }, отказы { ok: false, reason }
 * и { error }.
 */
export interface AiCmSwCountTokensResponse {
  ok?: boolean;
  totalTokens?: number;
  tokens?: number;
  cached?: number;
  debounced?: number;
  error?: string;
  reason?: string;
}

/** Ответ aiCm-get-byok-key: только факт наличия ключа. */
export interface AiCmSwByokKeyResponse {
  hasKey: boolean;
}

/** Ответ aiCm-latch-get. */
export interface AiCmSwLatchFiredResponse {
  fired: boolean;
}

/** Ответ aiCm-latch-set / aiCm-latch-remove. */
export interface AiCmSwLatchOkResponse {
  ok: boolean;
}

/** Ответ aiCm-latch-get-all: 'aiCmFired:*' → значение (инвариант ровно 1). */
export interface AiCmSwLatchMapResponse {
  map: Record<string, number>;
}

/**
 * Форма ответа по типу запроса. void — канал без ответа (sendResponse не зовётся):
 * THRESHOLD_PCT, BADGE_RESET и close-print-tab.
 */
export interface AiCmSwResponseMap {
  COUNT_TOKENS: AiCmSwCountTokensResponse;
  THRESHOLD_PCT: void;
  BADGE_RESET: void;
  'close-print-tab': void;
  'aiCm-get-byok-key': AiCmSwByokKeyResponse;
  'aiCm-latch-get': AiCmSwLatchFiredResponse;
  'aiCm-latch-set': AiCmSwLatchOkResponse;
  'aiCm-latch-remove': AiCmSwLatchOkResponse;
  'aiCm-latch-get-all': AiCmSwLatchMapResponse;
}

/** Любой ответ SW. */
export type AiCmSwResponse = AiCmSwResponseMap[keyof AiCmSwResponseMap];

/** Ответ, соответствующий конкретному запросу T (ключ — литерал type). */
export type AiCmSwResponseFor<T extends AiCmSwRequest> = AiCmSwResponseMap[T['type']];

/**
 * Запросы с ответом (канал sendResponse). COUNT_TOKENS сюда не входит: контент
 * шлёт его callback-формой chrome.runtime.sendMessage, а fire-and-forget каналы
 * (THRESHOLD_PCT, BADGE_RESET, close-print-tab) ответа не имеют вовсе.
 */
export type AiCmSwAskRequest = Extract<AiCmSwRequest, {
  type: 'aiCm-get-byok-key' | 'aiCm-latch-get' | 'aiCm-latch-set' | 'aiCm-latch-remove' | 'aiCm-latch-get-all';
}>;

// ===== C2: content ↔ popup/options и broadcast content → SW =====

/**
 * Сообщение, разбираемое onMessage-листенером content-скрипта (core/content.ts:3514).
 * Первые три канала payload не несут; GET_STATS — ветка чтения снимка метрики,
 * отправителя в репозитории у неё нет (ветка остаётся ради совместимости).
 */
export type AiCmContentRequest =
  | { type: 'aiCmDiag' }
  | { type: 'aiCmExportCurrent' }
  | { type: 'aiCm-byok-key-changed' }
  | { type: 'GET_STATS' };

/** Метаданные aiCmHistory для дампа диагностики (core/content.ts:3692). */
export interface AiCmDiagHistoryMeta {
  host: string;
  model: string;
  tokens: number;
  percent: number;
  count: number;
}

/**
 * Дамп диагностики, который content собирает в ответ на aiCmDiag
 * (core/content.ts:3712). Поля — ровно то, что строит обработчик.
 */
export interface AiCmDiagPayload {
  /** ISO-время сборки дампа. */
  generatedAt: string;
  /** URL страницы в момент дампа. */
  url: string;
  /** Копия ring-буфера логов этого мира (types/debug.d.ts: __aiCmGetLogRing). */
  logsContent: string[];
  /** Метаданные aiCmHistory; null — для хоста записи нет. */
  aiCmHistoryMeta: AiCmDiagHistoryMeta | null;
  /** Превью истории: '<role>|<первые 60 символов>' (core/content.ts:3709). */
  historyPreviews: string[];
  /** Ответ MAIN-перехватчика ('ai-cm-diag-response') либо null. */
  intercept: unknown;
}

/** Ответ aiCmDiag: конверт ok+diag (core/content.ts:3720). */
export interface AiCmDiagResponse {
  ok: true;
  diag: AiCmDiagPayload;
}

/**
 * Ручной снимок текущего разговора — тело ответа content на aiCmExportCurrent
 * (core/content.ts:3557). Это НЕ проводной конверт: content отвечает
 * { data: manualSnapshot } (core/content.ts:3625), см. AiCmExportCurrentResponse.
 */
export interface AiCmManualSnapshot {
  host: string;
  convId: string;
  site: string;
  model: string;
  tokens: number;
  limit: number;
  percent: number;
  /** Источник числа (dom|net|max|server|hold), если он известен. */
  src?: string;
  updatedAt: number;
  isLowConfidenceBase: boolean;
  sourceTier?: string;
  partial?: boolean;
  partialReason?: 'incomplete' | 'stale' | 'shrank';
  /** Режим проекции файла (S5.1); появляется только после проекции. */
  bodyProjection?: string;
  /**
   * Сообщения файла. Фактически это AiCmExportMessage[] (role/text — строки,
   * role и text обязательны), поэтому объявленная здесь форма — надмножество.
   */
  messages: Array<{ role?: string; text?: string }>;
}

/** Проводной ответ aiCmExportCurrent: снимок в конверте data (core/content.ts:3625). */
export interface AiCmExportCurrentResponse {
  data: AiCmManualSnapshot;
}

/** Данные панели статистики (core/content.ts:3658); null-поля — снимка ещё нет. */
export interface AiCmContentStatsPayload {
  site: string;
  modelName: string;
  tokenCount: number | null;
  contextLimit: number | null;
  percentage: number | null;
  messageCount: number;
}

/** Ответ GET_STATS: data=null — адаптер не готов (core/content.ts:3671). */
export interface AiCmContentStatsResponse {
  data: AiCmContentStatsPayload | null;
}

/** Ответ по типу запроса; void — канал без ответа (aiCm-byok-key-changed). */
export interface AiCmContentResponseMap {
  aiCmDiag: AiCmDiagResponse;
  aiCmExportCurrent: AiCmExportCurrentResponse;
  'aiCm-byok-key-changed': void;
  GET_STATS: AiCmContentStatsResponse;
}

/** Любой ответ content-скрипта (без void-каналов). */
export type AiCmContentResponse =
  | AiCmDiagResponse
  | AiCmExportCurrentResponse
  | AiCmContentStatsResponse;

/** Ответ, соответствующий конкретному запросу T (ключ — литерал type). */
export type AiCmContentResponseFor<T extends AiCmContentRequest> = AiCmContentResponseMap[T['type']];

/**
 * Broadcast content → SW: снимок метрики для бейджа (core/content.ts:3314).
 * SW сообщение молча игнорирует — здесь описан только отправитель.
 */
export interface AiCmBroadcast {
  type: 'CONTEXT_UPDATE';
  data: {
    site: string;
    model: string;
    modelName: string;
    tokenCount: number;
    contextLimit: number;
    percentage: number;
    messageCount: number;
    timestamp: number;
  };
}
