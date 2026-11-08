/**
 * T1 (v1.16): ПЕРВЫЙ ЯРУС — импорт архивов истории чатов.
 *
 * Чистый модуль (без DOM / chrome.* / сети): детекция формата, парсинг четырёх
 * экспортов, нормализация сообщений, ключи chrome.storage.local и ярлыки
 * источника. Публичный API — default-экспорт Api (+ именованные export function).
 * UMD-хвост снят (Roadmap Ph2): глобальная публикация API и CJS-экспорт больше не
 * выставляются; сборка втягивает модуль статическим import из options/options.js.
 *
 * ПОДДЕРЖИВАЕМЫЕ ФОРМАТЫ (все — ЛОКАЛЬНЫЕ файлы пользователя; внешних fetch нет):
 *   1. gemini-takeout        — Google Takeout «My Activity.json» (Gemini Apps).
 *                              Массив activity-записей; чат определяется по
 *                              titleUrl = https://gemini.google.com/app/<convId>.
 *                              Промпт — в title (срезается префикс «Prompted »);
 *                              ответ модели — опционально (details[].value при
 *                              name ~ /response|answer|ответ/i, либо record.response).
 *                              Takeout штатно отдаёт ТОЛЬКО промпты: если ответа
 *                              нет, ход пользователя не выбрасывается (архив
 *                              честно считается по тому, что есть).
 *   2. chatgpt-conversations — ChatGPT conversations.json: массив диалогов
 *                              {conversation_id, title, create_time, update_time,
 *                               mapping{id:{parent,children,message}}}. Порядок
 *                              ходов берётся у utils/chatgpt-conversation-parser.ts
 *                              (orderChatGPTMapping) — своя линеаризация НЕ дублируется.
 *   3. claude-conversations  — Claude conversations.json: массив
 *                              {uuid, name, created_at, updated_at,
 *                               chat_messages:[{uuid, sender, text, content:[{type,text}], created_at}]}.
 *   4. perplexity-threads    — Perplexity export: массив
 *                              {thread:{id,slug,title,...}, entries:[...]}.
 *                              Разбор записей делегируется
 *                              utils/perplexity-parser.ts (parsePerplexityThread).
 *
 * РОЛИ: 'human'/'user'/'me'/'prompt' → user; 'assistant'/'model'/'bot'/'ai' → assistant.
 * ПРОЧЕЕ: system/tool-ходы и записи без convId в архив НЕ попадают (счётчик
 * skippedNoConvId — честная диагностика, а не выдуманный id).
 *
 * ИДЕМПОТЕНТНОСТЬ: id архивного хода детерминирован —
 * 'a:<ordinal>:<hash6(role+text)>'. Повторный импорт того же файла даёт те же id,
 * поэтому same-conv-union (см. utils/gemini-intercept-logic.js) — no-op, а не
 * удвоение истории.
 *
 * Оракул/пол/merge НЕ здесь: они живут в utils/gemini-intercept-logic.js
 * (этот модуль регистрируется в MAIN-мире Gemini, где chrome.* запрещён, и
 * используется страницей настроек для импорта).
 */

import type {
  ArchiveFormat,
  ArchiveImportMessage,
  ArchiveStoredRecord,
  ArchiveSourceRecord,
  ArchiveImportApi,
  ArchiveImportOptions,
  ArchiveImportPlan,
  ArchiveParseResult
} from '../types/archive-import';

// ------------------------------------------------------------ типы ----
/** Диалог после finalizeConversation — форма, которую ждут buildArchiveRecord и план импорта. */
export interface FinalizedConversation {
  /** Идентификатор разговора ('' — не найден). */
  convId: string;
  /** Сервис, выведенный из формата. */
  service: string;
  /** Формат источника (FORMATS.*). */
  format: string;
  /** Заголовок (фолбэк — первые 80 символов первого user-хода). */
  title: string;
  /** Время последнего хода, мс (0 — неизвестно). */
  updatedAt: number;
  /** Нормализованные ходы. */
  messages: ArchiveImportMessage[];
  /** Число принятых ходов. */
  count: number;
  /** Суммарная длина текстов ходов. */
  textLen: number;
}

/** Итог одного парсера формата: диалоги и честные счётчики пропусков. */
export interface ArchiveParseOutcome {
  conversations: FinalizedConversation[];
  skippedNoConvId: number;
  skippedEmpty: number;
  /** Код ошибки парсера (нет у gemini/claude-веток). */
  error?: string;
}

/** Инъекция зависимостей фасада парсинга (логгер и резолверы внешних парсеров). */
export interface ArchiveDeps {
  /** Логгер аномалий «пол > msgs». */
  warn?: (msg: string) => void;
  /** Линеаризация mapping ChatGPT. */
  orderChatGPTMapping?: (mapping: any) => string[];
  /** Санатор текста ChatGPT. */
  sanitizeChatGPTText?: (s: any) => string;
  /** Разбор треда Perplexity. */
  parsePerplexityThread?: (thread: any) => any;
}

/** Аномалия «пол > msgs» (LOW-3): агрегат `full` длиннее суммы отдельных ходов. */
export interface FullTextAnomaly {
  convId: string;
  code: string;
  fullLen: number;
  msgsLen: number;
  over: number;
  msgCount: number;
}

/** Черновик записи источника до вычисления ярлыка. */
export interface SourceRecordDraft {
  kind: 'archive' | 'live';
  service: string;
  format: string;
  count: number;
  textLen: number;
  importedAt: number;
  label?: string;
  fileName?: string;
}

// ------------------------------------------ структуры четырёх форматов ----
/** Activity-запись Google Takeout (Gemini Apps). */
export interface GeminiActivityRecord {
  title?: string;
  description?: string;
  titleUrl?: string;
  title_url?: string;
  time?: string;
  header?: string;
  response?: string;
  answer?: string;
  details?: GeminiActivityDetail[];
  [key: string]: unknown;
}

/** Деталь activity-записи (name/value). */
export interface GeminiActivityDetail {
  name?: string;
  value?: string;
  [key: string]: unknown;
}

/** Файл Takeout: массив записей или {items:[…]}. */
export interface GeminiTakeoutFile {
  items: GeminiActivityRecord[];
}

/** Блок контента Claude-экспорта. */
export interface ClaudeContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/** Ход Claude-экспорта. */
export interface ClaudeExportMessage {
  uuid?: string;
  sender?: string;
  text?: string;
  content?: ClaudeContentBlock[];
  created_at?: string;
  [key: string]: unknown;
}

/** Диалог Claude-экспорта (conversations.json). */
export interface ClaudeExportConversation {
  uuid?: string;
  id?: string;
  name?: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeExportMessage[];
  [key: string]: unknown;
}

/** Диалог ChatGPT-экспорта (conversations.json). */
export interface ChatGPTExportConversation {
  conversation_id?: string;
  id?: string;
  title?: string;
  create_time?: number | string;
  update_time?: number | string;
  mapping?: Record<string, any>;
  [key: string]: unknown;
}

/** Тред Perplexity-экспорта. */
export interface PerplexityThreadRecord {
  id?: string;
  slug?: string;
  title?: string;
  entries?: any[];
  updated_at?: number | string;
  [key: string]: unknown;
}

/** Элемент Perplexity-экспорта: {thread, entries[,…]}. */
export interface PerplexityExportItem {
  thread?: PerplexityThreadRecord;
  entries?: any[];
  id?: string;
  slug?: string;
  title?: string;
  updated_at?: number | string;
  [key: string]: unknown;
}

/** @type {string} Префикс ключа записи первого яруса в chrome.storage.local. */
var ARCHIVE_KEY_PREFIX = 'aiCmArchive:';
/** @type {string} Префикс ключа записи-индикатора источника. */
var CONV_SOURCE_KEY_PREFIX = 'aiCmConvSource:';

/** @type {'archive'} Ярус источника: импортированный архив. */
var SOURCE_ARCHIVE: 'archive' = 'archive';
/** @type {'live'} Ярус источника: сеть/DOM текущего чата. */
var SOURCE_LIVE: 'live' = 'live';

/** @type {number} Версия схемы архивной записи. */
var ARCHIVE_RECORD_VERSION = 1;

// Идентификаторы форматов (они же — значения meta.format).
/**
 * Идентификаторы поддерживаемых форматов (значения — ArchiveFormat).
 * @type {{GEMINI_TAKEOUT: ArchiveFormat, CHATGPT_CONVERSATIONS: ArchiveFormat,
 *         CLAUDE_CONVERSATIONS: ArchiveFormat, PERPLEXITY_THREADS: ArchiveFormat}}
 */
var FORMATS = {
  GEMINI_TAKEOUT: 'gemini-takeout',
  CHATGPT_CONVERSATIONS: 'chatgpt-conversations',
  CLAUDE_CONVERSATIONS: 'claude-conversations',
  PERPLEXITY_THREADS: 'perplexity-threads'
} as const;

/** @type {Record<string, string>} Формат → имя сервиса (gemini/chatgpt/claude/perplexity). */
var SERVICE_BY_FORMAT: Record<string, string> = {};
SERVICE_BY_FORMAT[FORMATS.GEMINI_TAKEOUT] = 'gemini';
SERVICE_BY_FORMAT[FORMATS.CHATGPT_CONVERSATIONS] = 'chatgpt';
SERVICE_BY_FORMAT[FORMATS.CLAUDE_CONVERSATIONS] = 'claude';
SERVICE_BY_FORMAT[FORMATS.PERPLEXITY_THREADS] = 'perplexity';

/** @type {Record<string, string>} Формат → человекочитаемый ярлык (describeSource). */
var FORMAT_LABEL: Record<string, string> = {};
FORMAT_LABEL[FORMATS.GEMINI_TAKEOUT] = 'Gemini Takeout';
FORMAT_LABEL[FORMATS.CHATGPT_CONVERSATIONS] = 'ChatGPT conversations.json';
FORMAT_LABEL[FORMATS.CLAUDE_CONVERSATIONS] = 'Claude export';
FORMAT_LABEL[FORMATS.PERPLEXITY_THREADS] = 'Perplexity threads';

// Бюджеты chrome.storage.local (квота local ~10 МБ). Превышение — запись
// отклоняется С ДИАГНОСТИКОЙ (молчаливое усечение истории запрещено).
/** @type {number} Потолок одной записи, байты (2 МБ). */
var MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;
/** @type {number} Суммарный потолок импорта, байты (8 МБ). */
var MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** @type {number} Потолок ходов в одном диалоге. */
var MAX_MESSAGES_PER_CONVERSATION = 5000;

// LOW-1 (аудит перед релизом): потолок ЧТЕНИЯ файла архива. Архив читается
// FileReader'ом ЦЕЛИКОМ в память, поэтому FileReader.readAsText запрещён для
// файлов больше порога: пользователь получает понятную ошибку ДО чтения, а не
// подвисание вкладки настроек на многогигабайтном экспорте. Порог — константа
// (единственный источник правды; options.js берёт её отсюда, не дублирует).
/** @type {number} Потолок ЧТЕНИЯ файла архива, байты (50 МБ). */
var MAX_ARCHIVE_SIZE = 50 * 1024 * 1024; // 50 МБ

// ---------------------------------------------------------------- ключи ----
/**
 * Ключ chrome.storage.local для записи первого яруса.
 * @param {string|number|null|undefined} convId Идентификатор разговора.
 * @returns {string} 'aiCmArchive:<convId>' (null/undefined → пустой хвост).
 */
export function archiveStorageKey(convId: string | number | null | undefined): string {
  return ARCHIVE_KEY_PREFIX + String(convId == null ? '' : convId);
}
/**
 * Ключ chrome.storage.local для записи-индикатора источника.
 * @param {string|number|null|undefined} convId Идентификатор разговора.
 * @returns {string} 'aiCmConvSource:<convId>' (null/undefined → пустой хвост).
 */
export function convSourceStorageKey(convId: string | number | null | undefined): string {
  return CONV_SOURCE_KEY_PREFIX + String(convId == null ? '' : convId);
}

// ------------------------------------------------------------ утилиты ----
/**
 * Нормализация текста: CRLF → LF, обрезка хвостовых пробелов, trim.
 * @param {string|null|undefined} v Сырой текст.
 * @returns {string} Нормализованный текст; '' — вход не строка.
 */
export function normalizeText(v: string | null | undefined): string {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * Схлопывание любых пробельных последовательностей в один пробел.
 * @param {unknown} v Сырое значение (приводится к строке).
 * @returns {string} Однострочный текст без краевых пробелов.
 */
export function collapseWs(v: unknown): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

// djb2 → 6 hex-символов. Нужен только для детерминированного id.
/**
 * Стабильный хеш djb2, 6 hex-символов (для детерминированного id хода).
 * @param {unknown} s Значение, от которого считается хеш.
 * @returns {string} Ровно 6 hex-символов (последние 6 разрядов djb2).
 */
export function hash6(s: unknown): string {
  var str = String(s == null ? '' : s);
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  var hex = (h >>> 0).toString(16);
  while (hex.length < 6) hex = '0' + hex;
  return hex.slice(-6);
}

/**
 * Приведение роли источника к роли архива.
 * 'human'/'user'/'me'/'prompt'/'you' → user; 'assistant'/'model'/'bot'/'ai'/… → assistant.
 * @param {string|null|undefined} role Сырая роль из экспорта.
 * @returns {'user'|'assistant'|''} Роль архива; '' — system/tool/неизвестная.
 */
export function normalizeRole(role: string | null | undefined): 'user' | 'assistant' | '' {
  var r = collapseWs(role).toLowerCase();
  if (r === 'user' || r === 'human' || r === 'me' || r === 'prompt' || r === 'you') return 'user';
  if (r === 'assistant' || r === 'model' || r === 'bot' || r === 'ai' || r === 'gpt' || r === 'gemini' || r === 'claude') return 'assistant';
  return '';
}

/**
 * Время источника → мс. Числа: секунды (<1e12) переводятся в мс; строки — Date.parse
 * с отдельной попыткой для 6-значных долей секунды (Claude/Python-экспорты).
 * @param {string|number|null|undefined} v Сырое время (ISO-строка или эпоха).
 * @returns {number} Время в мс; 0 — распарсить не удалось.
 */
export function toMs(v: string | number | null | undefined): number {
  if (typeof v === 'number' && isFinite(v)) {
    // ChatGPT/Claude отдают секунды (create_time), архивы Perplexity — мс.
    return v > 1e12 ? Math.round(v) : Math.round(v * 1000);
  }
  if (typeof v === 'string' && v) {
    var t = Date.parse(v);
    if (!isNaN(t)) return t;
    // Claude/Python-экспорты отдают 6-значные доли секунды
    // ("2024-05-01T10:00:00.000000+00:00") — Date.parse их не всегда берёт.
    var trimmed = v.replace(/(\.\d{3})\d+/, '$1');
    if (trimmed !== v) {
      t = Date.parse(trimmed);
      if (!isNaN(t)) return t;
    }
  }
  return 0;
}

/**
 * Список диалогов из корня экспорта: массив, {conversations:[…]} или одиночный объект.
 * @param {any} json Разобранный JSON файла архива.
 * @returns {Array<any>} Диалоги в порядке файла; [] — вход непригоден.
 */
export function arrayifyConversations(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.conversations)) return json.conversations;
  return [json];
}

// -------- резолверы внешних парсеров (переиспользование, без дублей) --------
// Порядок: явная инъекция (deps) → require (Node/бандлер) → window-глобал
// (страница расширения, где require отсутствует). require ПЕРЕД window —
// детерминизм: в jsdom-тестах глобал мог быть выставлен предыдущим модулем.
/**
 * Резолвер orderChatGPTMapping: явная инъекция → require → window-глобал.
 * @param {{orderChatGPTMapping?: Function}} [deps] Инъекция зависимостей (тесты/страница).
 * @returns {Function|null} Функция линеаризации mapping; null — парсер недоступен.
 */
export function resolveOrderChatGPTMapping(deps?: ArchiveDeps): ((mapping: any) => string[]) | null {
  if (deps && typeof deps.orderChatGPTMapping === 'function') return deps.orderChatGPTMapping;
  try {
    if (typeof require === 'function') {
      var m = require('./chatgpt-conversation-parser.ts');
      if (m && typeof m.orderChatGPTMapping === 'function') return m.orderChatGPTMapping;
    }
  } catch (eR) { }
  try {
    if (typeof window !== 'undefined' && window.ChatGPTConversationParser &&
        typeof window.ChatGPTConversationParser.orderChatGPTMapping === 'function') {
      return window.ChatGPTConversationParser.orderChatGPTMapping;
    }
  } catch (eW) { }
  return null;
}

/**
 * Резолвер sanitizeChatGPTText: явная инъекция → require → window-глобал;
 * при недоступности возвращается тождественная функция (текст не портится).
 * @param {{sanitizeChatGPTText?: (s: string) => string}} [deps] Инъекция зависимостей.
 * @returns {(s: string) => string} Санатор текста (никогда не null).
 */
export function resolveSanitizeChatGPT(deps?: ArchiveDeps): (s: any) => string {
  if (deps && typeof deps.sanitizeChatGPTText === 'function') return deps.sanitizeChatGPTText;
  try {
    if (typeof require === 'function') {
      var m = require('./chatgpt-conversation-parser.ts');
      if (m && typeof m.sanitizeChatGPTText === 'function') return m.sanitizeChatGPTText;
    }
  } catch (eR) { }
  try {
    if (typeof window !== 'undefined' && window.ChatGPTConversationParser &&
        typeof window.ChatGPTConversationParser.sanitizeChatGPTText === 'function') {
      return window.ChatGPTConversationParser.sanitizeChatGPTText;
    }
  } catch (eW) { }
  return function (s) { return s; };
}

/**
 * Резолвер parsePerplexityThread: явная инъекция → require → window-глобал.
 * @param {{parsePerplexityThread?: Function}} [deps] Инъекция зависимостей.
 * @returns {Function|null} Функция разбора треда Perplexity; null — парсер недоступен.
 */
export function resolveParsePerplexityThread(deps?: ArchiveDeps): ((thread: any) => any) | null {
  if (deps && typeof deps.parsePerplexityThread === 'function') return deps.parsePerplexityThread;
  try {
    if (typeof require === 'function') {
      var m = require('./perplexity-parser.ts');
      if (m && typeof m.parsePerplexityThread === 'function') return m.parsePerplexityThread;
    }
  } catch (eR) { }
  try {
    if (typeof window !== 'undefined' && typeof window.parsePerplexityThread === 'function') {
      return window.parsePerplexityThread;
    }
  } catch (eW) { }
  return null;
}

// ------------------------------------------------------- нормализация ----
/**
 * Приводит сырое сообщение к { id, role, text, ts }.
 * @param {Record<string, any>} raw Сырая запись хода из экспорта.
 * @param {number} ordinal Позиция в диалоге (для детерминированного id).
 * @returns {ArchiveImportMessage|null} null — роль/текст непригодны (system/tool/пусто).
 */
export function normalizeMessage(raw: any, ordinal: number): ArchiveImportMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  var role = normalizeRole(raw.role != null ? raw.role : raw.sender);
  if (!role) return null;
  var text = normalizeText(raw.text != null ? raw.text : raw.content);
  if (!text) return null;
  return {
    id: (typeof raw.id === 'string' && raw.id) ? raw.id : ('a:' + (ordinal || 0) + ':' + hash6(role + '\u0000' + text)),
    role: role,
    text: text,
    ts: (typeof raw.ts === 'number' && isFinite(raw.ts)) ? raw.ts : toMs(raw.created_at != null ? raw.created_at : raw.time)
  };
}

/**
 * Финализация диалога: нормализация ходов, заголовок-фолбэк, согласованные счётчики.
 * @param {Record<string, any>} conv Диалог из парсера формата.
 * @returns {FinalizedConversation} Диалог, готовый к записи/плану импорта.
 */
export function finalizeConversation(conv: any): FinalizedConversation {
  var messages = [];
  var textLen = 0;
  var raw = (conv && Array.isArray(conv.messages)) ? conv.messages : [];
  for (var i = 0; i < raw.length; i++) {
    var m = normalizeMessage(raw[i], messages.length);
    if (!m) continue;
    if (messages.length >= MAX_MESSAGES_PER_CONVERSATION) break;
    messages.push(m);
    textLen += m.text.length;
  }
  var title = normalizeText(conv && conv.title);
  if (!title) {
    for (var t = 0; t < messages.length; t++) {
      if (messages[t].role === 'user') { title = collapseWs(messages[t].text).slice(0, 80); break; }
    }
  }
  return {
    convId: String((conv && conv.convId) || ''),
    service: (conv && conv.service) || '',
    format: (conv && conv.format) || '',
    title: title,
    updatedAt: (conv && typeof conv.updatedAt === 'number' && isFinite(conv.updatedAt)) ? conv.updatedAt : 0,
    messages: messages,
    count: messages.length,
    textLen: textLen
  };
}

// ----------------------------------------------------- определение формата ----
/**
 * Похожа ли запись на activity-строку Google Takeout (Gemini Apps).
 * @param {Record<string, any>|null|undefined} item Элемент массива activity.
 * @returns {boolean} true — titleUrl ведёт на gemini.google.com/app/<convId>
 *   либо header равен 'Gemini Apps'.
 */
export function looksLikeGeminiActivity(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  var url = String(item.titleUrl || item.title_url || '');
  if (/gemini\.google\.com\/app\//.test(url)) return true;
  return collapseWs(item.header).toLowerCase() === 'gemini apps';
}

/**
 * Определяет формат архива. Возвращает значение FORMATS.* или null
 * (неизвестный/пустой вход — импорт отклоняется с диагностикой, а не
 * «угадывается»).
 * @param {any} json Разобранный JSON файла архива.
 * @returns {ArchiveFormat|null} Формат архива; null — не распознан.
 */
export function detectArchiveFormat(json: any): ArchiveFormat | null {
  var items = arrayifyConversations(json);
  if (!items.length) return null;
  var limit = Math.min(items.length, 20);
  for (var i = 0; i < limit; i++) {
    var it = items[i];
    if (!it || typeof it !== 'object') continue;
    if (it.mapping && typeof it.mapping === 'object') return FORMATS.CHATGPT_CONVERSATIONS;
    if (Array.isArray(it.chat_messages)) return FORMATS.CLAUDE_CONVERSATIONS;
    if (Array.isArray(it.entries) || (it.thread && Array.isArray(it.thread.entries))) return FORMATS.PERPLEXITY_THREADS;
    if (looksLikeGeminiActivity(it)) return FORMATS.GEMINI_TAKEOUT;
  }
  return null;
}

/**
 * Сервис (ключ настроек/хранилища) по формату архива.
 * @param {ArchiveFormat|string} format Формат архива.
 * @returns {string} Ключ сервиса ('gemini'|'chatgpt'|'claude'|'perplexity'); '' — неизвестен.
 */
export function serviceOfFormat(format: ArchiveFormat | string): string {
  return SERVICE_BY_FORMAT[format] || '';
}

// ------------------------------------------ цикл «пол > msgs» (аномалия) ----
// LOW-3 (аудит перед релизом): независимая проверка согласованности архива.
// Если в записи диалога есть агрегат `full` (полный текст), он НЕ МОЖЕТ быть
// длиннее суммы отдельных сообщений `messages`: агрегат — это те же ходы.
// full.length > sum(messages[].text.length) означает, что часть истории есть
// только в агрегате (или ходы потеряны при нормализации) — это аномалия, и она
// сообщается предупреждением, а не замалчивается. Импорт при этом НЕ падает:
// источник правды — messages (что реально попадёт в контекст/пол).
/**
 * Текст хода из сырой записи экспорта (`text` или алиас `content`).
 * @param {Record<string, any>|null|undefined} m Сырой ход.
 * @returns {string} Нормализованный текст; '' — пусто/непригодно.
 */
export function messageTextOf(m: any): string {
  if (!m || typeof m !== 'object') return '';
  return normalizeText(m.text != null ? m.text : m.content);
}

/**
 * Отдельные ходы диалога: `messages` (нормализованный) или алиасы экспортов.
 * @param {Record<string, any>} conv Диалог из архива.
 * @returns {Array<any>} Сырые ходы; [] — ходов нет.
 */
export function aggregateMessageList(conv: any): any[] {
  if (Array.isArray(conv.messages)) return conv.messages;
  if (Array.isArray(conv.chat_messages)) return conv.chat_messages;   // Claude export
  if (Array.isArray(conv.entries)) return conv.entries;               // Perplexity export
  return [];
}

/**
 * Проверяет одну запись диалога на аномалию «агрегат `full` длиннее суммы ходов».
 * @param {Record<string, any>|null|undefined} conv Запись диалога.
 * @returns {FullTextAnomaly|null} Описание аномалии; null — согласовано/неприменимо.
 */
export function detectFullTextAnomaly(conv: any): FullTextAnomaly | null {
  if (!conv || typeof conv !== 'object') return null;
  if (typeof conv.full !== 'string') return null;
  var fullText = normalizeText(conv.full);
  if (!fullText) return null;
  var raw = aggregateMessageList(conv);
  var msgsLen = 0;
  for (var i = 0; i < raw.length; i++) msgsLen += messageTextOf(raw[i]).length;
  if (fullText.length <= msgsLen) return null;
  return {
    convId: String(conv.convId || conv.conversation_id || conv.uuid || conv.id || ''),
    code: 'full-longer-than-messages',
    fullLen: fullText.length,
    msgsLen: msgsLen,
    over: fullText.length - msgsLen,
    msgCount: raw.length
  };
}

/**
 * Все аномалии «пол > msgs» в архиве (чистая функция, без логов).
 * @param {any} json Разобранный JSON архива.
 * @returns {FullTextAnomaly[]} Найденные аномалии в порядке файла.
 */
export function collectFullTextAnomalies(json: any): FullTextAnomaly[] {
  var items = arrayifyConversations(json);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var a = detectFullTextAnomaly(items[i]);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Логирует аномалии «пол > msgs». Возвращает массив аномалий; логирование
 * инъектируется (deps.warn) — в тестах перехватывается без шума в консоли.
 * @param {any} json Разобранный JSON архива.
 * @param {{warn?: (msg: string) => void}} [deps] Инъекция логгера.
 * @returns {FullTextAnomaly[]} Найденные аномалии (для отчёта/тестов).
 */
export function reportFullTextAnomalies(json: any, deps?: ArchiveDeps): FullTextAnomaly[] {
  var d: ArchiveDeps = deps || {};
  var warn = (typeof d.warn === 'function') ? d.warn
    : ((typeof console !== 'undefined' && console && typeof console.warn === 'function')
      ? function (msg) { console.warn(msg); } : null);
  var anomalies = collectFullTextAnomalies(json);
  if (warn) {
    for (var i = 0; i < anomalies.length; i++) {
      var a = anomalies[i];
      warn('[AI CM][archive] аномалия full>messages convId=' + (a.convId || '-') +
        ' full=' + a.fullLen + ' msgs=' + a.msgsLen + ' over=' + a.over +
        ' msgsCount=' + a.msgCount);
    }
  }
  return anomalies;
}

/**
 * convId из ссылки вида gemini.google.com/app/<id> (служебные пути /app/new,
 * /app/prompts, /app/apikey отбрасываются).
 * @param {string|null|undefined} url Ссылка из titleUrl.
 * @returns {string} convId; '' — ссылка не диалоговая.
 */
export function extractConvIdFromUrl(url: string | null | undefined): string {
  var m = String(url == null ? '' : url).match(/\/app\/(?!prompts(?:\/|$)|new(?:\/|$)|apikey(?:\/|$))([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

// ------------------------------------------------- Gemini Takeout (1/4) ----
/** @type {RegExp} Префикс промпта в заголовке activity-записи. */
var GEMINI_PROMPT_PREFIX = /^(prompted|asked|you asked|said|запрос:?|вы спросили:?|запрос\s)\s*/i;
/** @type {RegExp} Имя детали activity-записи, содержащей ответ модели. */
var GEMINI_RESPONSE_DETAIL = /^(response|answer|ответ|ответ модели|model response)$/i;

/**
 * Текст пользовательского хода из activity-записи (title/description без префикса).
 * @param {Record<string, any>} rec Activity-запись Google Takeout.
 * @returns {string} Текст промпта; '' — пусто.
 */
export function geminiActivityUserText(rec: GeminiActivityRecord): string {
  var title = normalizeText(rec.title != null ? rec.title : rec.description);
  if (!title) return '';
  return normalizeText(title.replace(GEMINI_PROMPT_PREFIX, ''));
}

/**
 * Текст ответа модели из activity-записи: `response`/`answer` либо деталь
 * details[] с именем вида "response"/"ответ модели".
 * @param {Record<string, any>} rec Activity-запись Google Takeout.
 * @returns {string} Текст ответа; '' — ответа нет.
 */
export function geminiActivityAssistantText(rec: GeminiActivityRecord): string {
  var direct = normalizeText(rec.response != null ? rec.response : rec.answer);
  if (direct) return direct;
  var details = rec.details;
  if (!Array.isArray(details)) return '';
  for (var i = 0; i < details.length; i++) {
    var d = details[i];
    if (!d || typeof d !== 'object') continue;
    if (!GEMINI_RESPONSE_DETAIL.test(collapseWs(d.name))) continue;
    var val = normalizeText(d.value);
    if (val) return val;
  }
  return '';
}

/**
 * Google Takeout «My Activity.json» (Gemini Apps) → диалоги, сгруппированные
 * по convId из titleUrl. Записи без convId пропускаются (skippedNoConvId).
 * @param {any} json Разобранный JSON файла Takeout.
 * @returns {ArchiveParseOutcome} Диалоги и счётчики пропусков.
 */
export function parseGeminiTakeout(json: any): ArchiveParseOutcome {
  var items = Array.isArray(json) ? json : ((json && Array.isArray(json.items)) ? json.items : []);
  var order = [];
  var byConv = {};
  var skippedNoConvId = 0;
  var skippedEmpty = 0;

  for (var i = 0; i < items.length; i++) {
    var rec = items[i];
    if (!rec || typeof rec !== 'object') { skippedEmpty++; continue; }
    var convId = extractConvIdFromUrl(rec.titleUrl != null ? rec.titleUrl : rec.title_url);
    if (!convId) { skippedNoConvId++; continue; }
    var ts = toMs(rec.time);
    var userText = geminiActivityUserText(rec);
    var assistantText = geminiActivityAssistantText(rec);
    if (!userText && !assistantText) { skippedEmpty++; continue; }
    if (!byConv[convId]) {
      byConv[convId] = {
        convId: convId,
        service: SERVICE_BY_FORMAT[FORMATS.GEMINI_TAKEOUT],
        format: FORMATS.GEMINI_TAKEOUT,
        title: '',
        updatedAt: 0,
        messages: []
      };
      order.push(convId);
    }
    var conv = byConv[convId];
    if (userText) conv.messages.push({ role: 'user', text: userText, ts: ts });
    if (assistantText) conv.messages.push({ role: 'assistant', text: assistantText, ts: ts });
    if (ts > conv.updatedAt) conv.updatedAt = ts;
    if (!conv.title && userText) conv.title = collapseWs(userText).slice(0, 80);
  }

  var out = [];
  for (var k = 0; k < order.length; k++) out.push(finalizeConversation(byConv[order[k]]));
  return { conversations: out, skippedNoConvId: skippedNoConvId, skippedEmpty: skippedEmpty };
}

// -------------------------------------------- ChatGPT conversations (2/4) ----
/**
 * ChatGPT Conversations.json → диалоги (линеаризация mapping через
 * orderChatGPTMapping, санация текста через sanitizeChatGPTText).
 * @param {any} json Разобранный JSON экспорта ChatGPT.
 * @param {ArchiveDeps} [deps] Инъекция парсеров.
 * @returns {ArchiveParseOutcome} Диалоги и счётчики пропусков;
 *   error='chatgpt-parser-unavailable' — резолверы недоступны.
 */
export function parseChatGPTArchive(json: any, deps?: ArchiveDeps): ArchiveParseOutcome {
  var orderFn = resolveOrderChatGPTMapping(deps);
  if (!orderFn) return { conversations: [], error: 'chatgpt-parser-unavailable', skippedNoConvId: 0, skippedEmpty: 0 };
  var sanitize = resolveSanitizeChatGPT(deps);
  var items = arrayifyConversations(json);
  var out = [];
  var skippedNoConvId = 0;
  var skippedEmpty = 0;

  for (var i = 0; i < items.length; i++) {
    var c = items[i];
    if (!c || typeof c !== 'object' || !c.mapping || typeof c.mapping !== 'object') { skippedEmpty++; continue; }
    var convId = String(c.conversation_id || c.id || '');
    if (!convId) { skippedNoConvId++; continue; }
    var keys = orderFn(c.mapping);
    var messages = [];
    for (var k = 0; k < keys.length; k++) {
      var node = c.mapping[keys[k]];
      var msg = node && node.message;
      if (!msg || !msg.content) continue;
      var role = normalizeRole(msg.author && msg.author.role);
      if (!role) continue; // system/tool
      var parts = Array.isArray(msg.content.parts) ? msg.content.parts : [];
      var pieces = [];
      for (var p = 0; p < parts.length; p++) {
        if (typeof parts[p] === 'string') {
          var s = sanitize(parts[p]);
          if (normalizeText(s)) pieces.push(normalizeText(s));
        } else if (parts[p] && typeof parts[p] === 'object' && typeof parts[p].text === 'string') {
          var s2 = sanitize(parts[p].text);
          if (normalizeText(s2)) pieces.push(normalizeText(s2));
        }
      }
      var text = normalizeText(pieces.join('\n'));
      if (!text) continue;
      messages.push({ role: role, text: text, ts: toMs(msg.create_time) });
    }
    out.push(finalizeConversation({
      convId: convId,
      service: SERVICE_BY_FORMAT[FORMATS.CHATGPT_CONVERSATIONS],
      format: FORMATS.CHATGPT_CONVERSATIONS,
      title: c.title,
      updatedAt: toMs(c.update_time != null ? c.update_time : c.create_time),
      messages: messages
    }));
  }
  return { conversations: out, skippedNoConvId: skippedNoConvId, skippedEmpty: skippedEmpty };
}

// --------------------------------------------- Claude conversations (3/4) ----
/**
 * Текст хода Claude: только блоки `content[].type === 'text'` (thinking/tool_use
 * не попадают в контекстное окно), фолбэк — msg.text.
 * @param {Record<string, any>} msg Сырой ход Claude-экспорта.
 * @returns {string} Нормализованный текст; '' — текста нет.
 */
export function claudeMessageText(msg: ClaudeExportMessage): string {
  var parts = [];
  if (Array.isArray(msg.content)) {
    for (var i = 0; i < msg.content.length; i++) {
      var b = msg.content[i];
      if (!b || typeof b !== 'object') continue;
      // В контекстное окно попадает только текстовый блок; thinking/tool_use
      // не учитываются (иначе count/пол архива раздуваются не-контекстным шумом).
      if (b.type === 'text' && typeof b.text === 'string') {
        var t = normalizeText(b.text);
        if (t) parts.push(t);
      }
    }
  }
  if (!parts.length) {
    var fallback = normalizeText(msg.text);
    if (fallback) parts.push(fallback);
  }
  return normalizeText(parts.join('\n'));
}

/**
 * Claude conversations.json → диалоги (chat_messages, sender → роль архива).
 * @param {any} json Разобранный JSON экспорта Claude.
 * @returns {ArchiveParseOutcome} Диалоги и счётчики пропусков.
 */
export function parseClaudeArchive(json: any): ArchiveParseOutcome {
  var items = arrayifyConversations(json);
  var out = [];
  var skippedNoConvId = 0;
  var skippedEmpty = 0;
  for (var i = 0; i < items.length; i++) {
    var c = items[i];
    if (!c || typeof c !== 'object' || !Array.isArray(c.chat_messages)) { skippedEmpty++; continue; }
    var convId = String(c.uuid || c.id || '');
    if (!convId) { skippedNoConvId++; continue; }
    var messages = [];
    for (var k = 0; k < c.chat_messages.length; k++) {
      var msg = c.chat_messages[k];
      if (!msg || typeof msg !== 'object') continue;
      var role = normalizeRole(msg.sender);
      if (!role) continue; // system
      var text = claudeMessageText(msg);
      if (!text) continue;
      messages.push({
        id: (typeof msg.uuid === 'string' && msg.uuid) ? msg.uuid : undefined,
        role: role,
        text: text,
        ts: toMs(msg.created_at)
      });
    }
    var providerDate = String(c.updated_at || c.created_at || '');
    out.push(finalizeConversation({
      convId: convId,
      service: SERVICE_BY_FORMAT[FORMATS.CLAUDE_CONVERSATIONS],
      format: FORMATS.CLAUDE_CONVERSATIONS,
      title: c.name || c.title,
      updatedAt: toMs(providerDate),
      messages: messages
    }));
  }
  return { conversations: out, skippedNoConvId: skippedNoConvId, skippedEmpty: skippedEmpty };
}

// -------------------------------------------- Perplexity threads (4/4) ----
/**
 * Perplexity threads → диалоги (разбор треда делегируется parsePerplexityThread).
 * @param {any} json Разобранный JSON экспорта Perplexity.
 * @param {ArchiveDeps} [deps] Инъекция парсера тредов.
 * @returns {ArchiveParseOutcome} Диалоги и счётчики пропусков;
 *   error='perplexity-parser-unavailable' — резолвер недоступен.
 */
export function parsePerplexityArchive(json: any, deps?: ArchiveDeps): ArchiveParseOutcome {
  var parseThread = resolveParsePerplexityThread(deps);
  if (!parseThread) return { conversations: [], error: 'perplexity-parser-unavailable', skippedNoConvId: 0, skippedEmpty: 0 };
  var items = arrayifyConversations(json);
  var out = [];
  var skippedNoConvId = 0;
  var skippedEmpty = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || typeof it !== 'object') { skippedEmpty++; continue; }
    var thread = (it.thread && typeof it.thread === 'object') ? it.thread : it;
    var entries = Array.isArray(it.entries) ? it.entries : (Array.isArray(thread.entries) ? thread.entries : null);
    if (!entries) { skippedEmpty++; continue; }
    var convId = String(thread.id || thread.slug || it.id || it.slug || '');
    if (!convId) { skippedNoConvId++; continue; }
    var parsed = parseThread({ entries: entries }) || {};
    var msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    var messages = [];
    for (var k = 0; k < msgs.length; k++) {
      var m = msgs[k];
      if (!m || typeof m !== 'object') continue;
      var role = normalizeRole(m.role);
      var text = normalizeText(m.text);
      if (!role || !text) continue;
      messages.push({ role: role, text: text, ts: 0 });
    }
    out.push(finalizeConversation({
      convId: convId,
      service: SERVICE_BY_FORMAT[FORMATS.PERPLEXITY_THREADS],
      format: FORMATS.PERPLEXITY_THREADS,
      title: thread.title || it.title,
      updatedAt: toMs(thread.updated_at || it.updated_at),
      messages: messages
    }));
  }
  return { conversations: out, skippedNoConvId: skippedNoConvId, skippedEmpty: skippedEmpty };
}

// --------------------------------------------------------- фасад парсинга ----
/**
 * Разбирает архив любого поддерживаемого формата (диспетчеризация по
 * detectArchiveFormat), попутно логируя аномалии «пол > msgs».
 * @param {any} json Разобранный JSON файла архива.
 * @param {ArchiveDeps} [deps] Инъекция логгера/парсеров.
 * @returns {ArchiveParseResult} Итог разбора: ok/format/service/error и счётчики.
 */
export function parseArchive(json: any, deps?: ArchiveDeps): ArchiveParseResult {
  // LOW-3: аномалия «пол > msgs» логируется на КАЖДОМ разборе архива —
  // импорт не падает, но расхождение агрегата и ходов не замалчивается.
  reportFullTextAnomalies(json, deps);
  var format = detectArchiveFormat(json);
  if (!format) {
    return { ok: false, format: null, service: '', error: 'unknown-format', conversations: [], skippedNoConvId: 0, skippedEmpty: 0 };
  }
  var res;
  if (format === FORMATS.GEMINI_TAKEOUT) res = parseGeminiTakeout(json);
  else if (format === FORMATS.CHATGPT_CONVERSATIONS) res = parseChatGPTArchive(json, deps);
  else if (format === FORMATS.CLAUDE_CONVERSATIONS) res = parseClaudeArchive(json);
  else res = parsePerplexityArchive(json, deps);

  if (res.error) {
    return { ok: false, format: format, service: serviceOfFormat(format), error: res.error, conversations: [], skippedNoConvId: 0, skippedEmpty: 0 };
  }
  return {
    ok: true,
    format: format,
    service: serviceOfFormat(format),
    error: null,
    conversations: res.conversations || [],
    skippedNoConvId: res.skippedNoConvId || 0,
    skippedEmpty: res.skippedEmpty || 0
  };
}

/**
 * То же из текста файла (JSON.parse с диагностикой, без исключений наружу).
 * @param {string|null|undefined} text Содержимое файла архива.
 * @param {ArchiveDeps} [deps] Инъекция логгера/парсеров.
 * @returns {ArchiveParseResult} error='invalid-json' — файл не JSON.
 */
export function parseArchiveText(text: string | null | undefined, deps?: ArchiveDeps): ArchiveParseResult {
  var json = null;
  try {
    json = JSON.parse(String(text == null ? '' : text));
  } catch (e) {
    return { ok: false, format: null, service: '', error: 'invalid-json', conversations: [], skippedNoConvId: 0, skippedEmpty: 0 };
  }
  return parseArchive(json, deps);
}

// ------------------------------------------------------------- запись ----
/**
 * Запись для chrome.storage.local по ключу archiveStorageKey(convId).
 * @param {Record<string, any>} conversation Диалог из парсера (finalize внутри).
 * @param {{importedAt?: number, fileName?: string}} [extra] Метаданные импорта.
 * @returns {ArchiveStoredRecord} Нормализованная запись первого яруса.
 */
export function buildArchiveRecord(conversation: any, extra?: { importedAt?: number; fileName?: string }): ArchiveStoredRecord {
  var conv = finalizeConversation(conversation);
  var x = extra || {};
  return {
    v: ARCHIVE_RECORD_VERSION,
    convId: conv.convId,
    service: conv.service,
    format: conv.format,
    title: conv.title,
    count: conv.count,
    textLen: conv.textLen,
    messages: conv.messages,
    importedAt: (typeof x.importedAt === 'number') ? x.importedAt : Date.now(),
    fileName: String(x.fileName || '')
  };
}

/**
 * Запись для chrome.storage.local по ключу convSourceStorageKey(convId) —
 * индикатор источника в попапе/виджете.
 * @param {Record<string, any>} [archiveRecord] Запись первого яруса.
 * @param {{fileName?: string}} [extra] Метаданные импорта.
 * @returns {ArchiveSourceRecord} Запись-индикатор (label вычислен describeSource).
 */
export function buildConvSourceRecord(archiveRecord: any, extra?: { fileName?: string }): ArchiveSourceRecord {
  var r = archiveRecord || {};
  var x = extra || {};
  var rec: SourceRecordDraft = {
    kind: SOURCE_ARCHIVE,
    service: String(r.service || ''),
    format: String(r.format || ''),
    count: (typeof r.count === 'number') ? r.count : 0,
    textLen: (typeof r.textLen === 'number') ? r.textLen : 0,
    importedAt: (typeof r.importedAt === 'number') ? r.importedAt : Date.now()
  };
  rec.label = describeSource(rec);
  if (x.fileName) rec.fileName = String(x.fileName);
  return rec as ArchiveSourceRecord;
}

/**
 * Запись источника для «живого» второго яруса (архива по чату нет).
 * @param {{service?: string, count?: number, textLen?: number}} [extra] Данные живого чата.
 * @returns {ArchiveSourceRecord} Запись-индикатор live-источника.
 */
export function buildLiveSourceRecord(extra?: { service?: string; count?: number; textLen?: number }): ArchiveSourceRecord {
  var x = extra || {};
  var rec: SourceRecordDraft = {
    kind: SOURCE_LIVE,
    service: String(x.service || ''),
    format: '',
    count: (typeof x.count === 'number') ? x.count : 0,
    textLen: (typeof x.textLen === 'number') ? x.textLen : 0,
    importedAt: 0
  };
  rec.label = describeSource(rec);
  return rec as ArchiveSourceRecord;
}

/**
 * Человекочитаемый ярлык источника для попапа/виджета.
 * @param {SourceRecordDraft|null|undefined} record Запись источника (draft или полная).
 * @returns {string} Ярлык: 'архив: <формат> · N сообщ.' / 'live (сеть/DOM)' / '—'.
 */
export function describeSource(record: SourceRecordDraft | null | undefined): string {
  if (!record || typeof record !== 'object') return '—';
  if (record.kind === SOURCE_LIVE) return 'live (сеть/DOM)';
  if (record.kind !== SOURCE_ARCHIVE) return '—';
  var fmt = FORMAT_LABEL[record.format] || record.format || 'архив';
  var n = (typeof record.count === 'number' && record.count > 0) ? (' · ' + record.count + ' сообщ.') : '';
  return 'архив: ' + fmt + n;
}

/**
 * Короткий бейдж для виджета.
 * @param {SourceRecordDraft|null|undefined} record Запись источника.
 * @returns {string} '📦 архив' / '⚡ live' / '' — источник не определён.
 */
export function sourceBadge(record: SourceRecordDraft | null | undefined): string {
  if (!record || typeof record !== 'object') return '';
  if (record.kind === SOURCE_ARCHIVE) return '📦 архив';
  if (record.kind === SOURCE_LIVE) return '⚡ live';
  return '';
}

/**
 * Относится ли запись архива именно к этому разговору.
 * @param {Record<string, any>|null|undefined} record Запись первого яруса.
 * @param {string|null|undefined} convId Идентификатор разговора.
 * @returns {boolean} true — convId записи совпадает с переданным.
 */
export function isArchiveRecordFor(record: any, convId: string | null | undefined): boolean {
  if (!record || typeof record !== 'object') return false;
  if (!convId) return false;
  return String(record.convId || '') === String(convId);
}

// ------------------------------------------------------------- бюджеты ----
/**
 * Размер записи в байтах (JSON); Infinity — запись не сериализуется.
 * @param {any} rec Запись для chrome.storage.local.
 * @returns {number} Длина JSON-строки; Infinity — циклическая/битая структура.
 */
export function recordBytes(rec: unknown): number {
  try { return JSON.stringify(rec).length; } catch (e) { return Infinity; }
}

/**
 * Планирует запись импорта: отбрасывает пустые/слишком большие записи и
 * соблюдает суммарный бюджет chrome.storage.local.
 * @param {Array<any>} conversations Диалоги после разбора (FinalizedConversation).
 * @param {ArchiveImportOptions} [opts] Лимиты и метаданные файла.
 * @returns {ArchiveImportPlan} accepted/skipped и суммарный размер в байтах.
 */
export function planArchiveImport(conversations: any[], opts?: ArchiveImportOptions): ArchiveImportPlan {
  var o = opts || {};
  var perConv = (typeof o.maxConversationBytes === 'number') ? o.maxConversationBytes : MAX_CONVERSATION_BYTES;
  var total = (typeof o.maxTotalBytes === 'number') ? o.maxTotalBytes : MAX_TOTAL_BYTES;
  var fileName = o.fileName || '';
  var importedAt = (typeof o.importedAt === 'number') ? o.importedAt : Date.now();
  var accepted = [];
  var skipped = [];
  var used = 0;
  var list = Array.isArray(conversations) ? conversations : [];

  for (var i = 0; i < list.length; i++) {
    var conv = list[i];
    if (!conv || !conv.convId) {
      skipped.push({ convId: '', reason: 'no-conv-id', bytes: 0 });
      continue;
    }
    if (!conv.messages || !conv.messages.length) {
      skipped.push({ convId: conv.convId, reason: 'empty', bytes: 0 });
      continue;
    }
    var rec = buildArchiveRecord(conv, { fileName: fileName, importedAt: importedAt });
    var bytes = recordBytes(rec);
    if (bytes > perConv) {
      skipped.push({ convId: conv.convId, reason: 'too-large', bytes: bytes });
      continue;
    }
    if (used + bytes > total) {
      skipped.push({ convId: conv.convId, reason: 'budget-exceeded', bytes: bytes });
      continue;
    }
    used += bytes;
    accepted.push(rec);
  }
  return { accepted: accepted, skipped: skipped, bytes: used };
}

var Api: ArchiveImportApi = {
  ARCHIVE_KEY_PREFIX: ARCHIVE_KEY_PREFIX,
  CONV_SOURCE_KEY_PREFIX: CONV_SOURCE_KEY_PREFIX,
  ARCHIVE_RECORD_VERSION: ARCHIVE_RECORD_VERSION,
  FORMATS: FORMATS,
  SERVICE_BY_FORMAT: SERVICE_BY_FORMAT,
  FORMAT_LABEL: FORMAT_LABEL,
  SOURCE_ARCHIVE: SOURCE_ARCHIVE,
  SOURCE_LIVE: SOURCE_LIVE,
  MAX_CONVERSATION_BYTES: MAX_CONVERSATION_BYTES,
  MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
  MAX_MESSAGES_PER_CONVERSATION: MAX_MESSAGES_PER_CONVERSATION,
  MAX_ARCHIVE_SIZE: MAX_ARCHIVE_SIZE,
  archiveStorageKey: archiveStorageKey,
  convSourceStorageKey: convSourceStorageKey,
  normalizeText: normalizeText,
  normalizeRole: normalizeRole,
  normalizeMessage: normalizeMessage,
  hash6: hash6,
  toMs: toMs,
  detectArchiveFormat: detectArchiveFormat,
  serviceOfFormat: serviceOfFormat,
  detectFullTextAnomaly: detectFullTextAnomaly,
  collectFullTextAnomalies: collectFullTextAnomalies,
  reportFullTextAnomalies: reportFullTextAnomalies,
  extractConvIdFromUrl: extractConvIdFromUrl,
  parseGeminiTakeout: parseGeminiTakeout,
  parseChatGPTArchive: parseChatGPTArchive,
  parseClaudeArchive: parseClaudeArchive,
  parsePerplexityArchive: parsePerplexityArchive,
  parseArchive: parseArchive,
  parseArchiveText: parseArchiveText,
  buildArchiveRecord: buildArchiveRecord,
  buildConvSourceRecord: buildConvSourceRecord,
  buildLiveSourceRecord: buildLiveSourceRecord,
  describeSource: describeSource,
  sourceBadge: sourceBadge,
  isArchiveRecordFor: isArchiveRecordFor,
  recordBytes: recordBytes,
  planArchiveImport: planArchiveImport
};

export default Api;
