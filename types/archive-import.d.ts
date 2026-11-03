/**
 * Типы импорта архивов истории (utils/archive-import.js).
 *
 * Модуль самодостаточен: импортов нет. Это НЕ форма ArchiveRecord из
 * types/archive.d.ts (там запись aiCmHistory:{host,convId,site,ts,messages});
 * здесь — форма первого яруса T1: запись aiCmArchive:<convId>, которую строит
 * buildArchiveRecord (utils/archive-import.js:630-645). Формы разные, смешивать
 * нельзя.
 */

/**
 * Идентификатор поддерживаемого формата архива — значения FORMATS
 * (utils/archive-import.js:58-63); они же попадают в meta.format/record.format.
 */
export type ArchiveFormat =
  | 'gemini-takeout'
  | 'chatgpt-conversations'
  | 'claude-conversations'
  | 'perplexity-threads';

/**
 * Нормализованный ход архивного диалога (normalizeMessage,
 * utils/archive-import.js:214-226): id детерминирован
 * ('a:<ordinal>:<hash6(role+text)>'), роль уже приведена к user/assistant,
 * текст нормализован (CRLF → LF, обрезка хвостовых пробелов).
 */
export interface ArchiveImportMessage {
  /** Детерминированный id хода ('a:<ordinal>:<hash6>'). */
  id: string;

  /** Роль после normalizeRole: только 'user' | 'assistant'. */
  role: 'user' | 'assistant';

  /** Нормализованный текст. */
  text: string;

  /** Время хода в мс (0, если источник времени не дал). */
  ts: number;
}

/**
 * Запись первого яруса, сохраняемая в chrome.storage.local по ключу
 * 'aiCmArchive:<convId>' (buildArchiveRecord, utils/archive-import.js:630-645).
 */
export interface ArchiveStoredRecord {
  /** Версия схемы записи (ARCHIVE_RECORD_VERSION = 1). */
  v: number;

  /** Идентификатор разговора (пустой сюда не попадает — план отбрасывает). */
  convId: string;

  /** Сервис, выведенный из формата (SERVICE_BY_FORMAT). */
  service: string;

  /** Формат источника (FORMATS.*); при сборке из разбора — ArchiveFormat. */
  format: string;

  /** Заголовок диалога (при отсутствии — первые 80 символов первого user-хода). */
  title: string;

  /** Число принятых ходов. */
  count: number;

  /** Суммарная длина текстов ходов. */
  textLen: number;

  /** Нормализованные ходы. */
  messages: ArchiveImportMessage[];

  /** Время импорта, мс. */
  importedAt: number;

  /** Имя исходного файла ('' — не задано). */
  fileName: string;
}

/**
 * Запись-индикатор источника для попапа/виджета
 * (buildConvSourceRecord / buildLiveSourceRecord,
 * utils/archive-import.js:651-680), ключ 'aiCmConvSource:<convId>'.
 * label вычисляется describeSource и всегда присутствует в возвращаемой записи.
 */
export interface ArchiveSourceRecord {
  /** Ярус источника: 'archive' — импортированный архив, 'live' — сеть/DOM. */
  kind: 'archive' | 'live';

  /** Имя сервиса. */
  service: string;

  /** Формат архива; у live-записи — ''. */
  format: string;

  /** Число ходов. */
  count: number;

  /** Суммарная длина текста. */
  textLen: number;

  /** Время импорта, мс (у live-записи 0). */
  importedAt: number;

  /** Человекочитаемый ярлык (describeSource). */
  label: string;

  /** Имя исходного файла, если было передано. */
  fileName?: string;
}

/** Отброшенная запись плана импорта (planArchiveImport, :716-751). */
export interface ArchiveImportSkip {
  /** convId записи ('' — id не найден). */
  convId: string;

  /** Причина: 'no-conv-id' | 'empty' | 'too-large' | 'budget-exceeded'. */
  reason: string;

  /** Размер записи в байтах (0 для no-conv-id/empty). */
  bytes: number;
}

/** Опции бюджета импорта (planArchiveImport, :716-721). */
export interface ArchiveImportOptions {
  /** Потолок одной записи, байты (по умолчанию MAX_CONVERSATION_BYTES = 2 МБ). */
  maxConversationBytes?: number;

  /** Суммарный потолок, байты (по умолчанию MAX_TOTAL_BYTES = 8 МБ). */
  maxTotalBytes?: number;

  /** Имя исходного файла. */
  fileName?: string;

  /** Время импорта, мс (по умолчанию Date.now()). */
  importedAt?: number;
}

/**
 * План записи импорта (planArchiveImport, utils/archive-import.js:711-751):
 * принятые записи, отброшенные с причинами и суммарный размер принятых.
 * Записи сверх per-conversation/общего бюджета НЕ усекаются молча — они
 * попадают в skipped с причиной.
 */
export interface ArchiveImportPlan {
  /** Записи, прошедшие бюджеты и готовые к записи. */
  accepted: ArchiveStoredRecord[];

  /** Отброшенные записи с причиной и размером. */
  skipped: ArchiveImportSkip[];

  /** Суммарный размер принятых записей, байты. */
  bytes: number;
}

/**
 * Результат разбора архива (parseArchive/parseArchiveText,
 * utils/archive-import.js:584-626). Ошибка не бросается наружу: ok=false +
 * error-код ('unknown-format' | 'invalid-json' | код парсера).
 */
export interface ArchiveParseResult {
  ok: boolean;

  /** Определённый формат либо null. */
  format: string | null;

  /** Сервис, выведенный из формата ('' при неизвестном). */
  service: string;

  /** Код ошибки либо null при успехе. */
  error: string | null;

  /** Разобранные диалоги в форме finalizeConversation. */
  conversations: unknown[];

  /** Записи без convId (честная диагностика, не выдуманный id). */
  skippedNoConvId: number;

  /** Записи без пригодных ходов. */
  skippedEmpty: number;
}

/**
 * Публичный API utils/archive-import.js (window.AiCmArchiveImport) в объёме,
 * который читают вызывающие: детекция/разбор, план импорта, сборка записей.
 * Форма Api целиком — utils/archive-import.js:753-793.
 */
export interface ArchiveImportApi {
  detectArchiveFormat(json: unknown): string | null;
  parseArchive(json: unknown, deps?: unknown): ArchiveParseResult;
  parseArchiveText(text: string, deps?: unknown): ArchiveParseResult;
  planArchiveImport(conversations: unknown[], opts?: ArchiveImportOptions): ArchiveImportPlan;
  buildArchiveRecord(conversation: unknown, extra?: { fileName?: string; importedAt?: number }): ArchiveStoredRecord;
  describeSource(record: unknown): string;
  serviceOfFormat(format: string): string;
  [key: string]: any;
}
