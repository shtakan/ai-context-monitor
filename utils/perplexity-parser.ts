/**
 * Чистая функция парсинга истории Perplexity (GET треда).
 * ESM-модуль (Roadmap Ph2): потребители импортируют именованные экспорты
 *   import { parsePerplexityThread } from './perplexity-parser.ts' (core/perplexity-intercept.js,
 *   options/options.js, тесты).
 * Источник ассистентских сообщений: entry.blocks (workflow/web_results) и, при
 * их отсутствии, fallback entry.text — живой REST /rest/thread/{slug} отдаёт
 * JSON-строку шагов: FINAL-шаг → content.answer (JSON-строка) → поле answer.
 */

import { swallowSoft } from './debug.js';

/** Роль автора сообщения в истории Perplexity. */
export type PerplexityRole = 'user' | 'assistant';

/** Сообщение истории Perplexity. */
export interface PerplexityThreadMessage {
  /** Роль автора: user/assistant. */
  role: PerplexityRole;
  /** Текст сообщения. */
  text: string;
}

/**
 * Вложение записи треда: строка-адрес либо объект с адресом в url/src.
 * Приходит и в entry.attachments, и в web_results (см. isAttachmentUrl).
 */
export interface PerplexityAttachment {
  url?: string;
  src?: string;
}

/** Источник web_result_block (name/snippet/url) — цитата в блоке ответа. */
export interface PerplexityWebResult {
  name?: string;
  snippet?: string;
  url?: string;
}

/** Блок ответа ассистента: workflow_block (шаги) и/или web_result_block (источники). */
export interface PerplexityBlock {
  workflow_block?: PerplexityWorkflowBlock;
  web_result_block?: PerplexityWebResultBlock;
}

/** workflow_block: шаги пайплайна, у шага — items с payload.text_payload.text. */
export interface PerplexityWorkflowBlock {
  steps?: PerplexityWorkflowStep[];
}

/** Шаг workflow-пайплайна. */
export interface PerplexityWorkflowStep {
  items?: PerplexityWorkflowItem[];
}

/** Элемент шага; ассистентский текст несёт type WORKFLOW_ITEM_TEXT. */
export interface PerplexityWorkflowItem {
  type?: string;
  payload?: { text_payload?: { text?: string } };
}

/** web_result_block: источники ответа. */
export interface PerplexityWebResultBlock {
  web_results?: PerplexityWebResult[];
}

/**
 * Запись треда в REST-ответе GET /rest/thread/{slug}: поле читается терпимо
 * (ключи с пробелами, лишние поля игнорируются).
 */
export interface PerplexityThreadEntry {
  query_str?: string;
  display_model?: string;
  user_selected_model?: string;
  thread_url_slug?: string;
  attachments?: Array<PerplexityAttachment | string>;
  blocks?: PerplexityBlock[];
  /** JSON-строка массива шагов (REST-ответ без blocks). */
  text?: string;
  [key: string]: unknown;
}

/** Тело REST-ответа истории: { entries: [...] }. */
export interface PerplexityThreadPayload {
  entries?: PerplexityThreadEntry[];
  [key: string]: unknown;
}

/**
 * Кадр SSE-потока Perplexity: сервер отдаёт data: {blocks:[...]} теми же блоками,
 * что и REST-запись треда, поэтому типизируется общей частью.
 */
export interface PerplexitySseFrame {
  blocks?: PerplexityBlock[];
  [key: string]: unknown;
}

/** Результат parsePerplexityThread. */
export interface PerplexityThreadResult {
  /** Все куски через перевод строки. */
  text: string;
  /** Число собранных сообщений. */
  count: number;
  /** Текст последнего собранного сообщения. */
  lastText: string;
  /** Модель из display_model/user_selected_model. */
  modelSlug: string;
  /** Куски в порядке следования. */
  pieces: string[];
  /** Идентификаторы кусков (entryId_user / entryId_assistant). */
  ids: string[];
  /** Сообщения {role, text}. */
  messages: PerplexityThreadMessage[];
  /** Дубликат modelSlug (совместимость). */
  model: string;
}

/**
 * Разбор JSON истории Perplexity в сообщения: user — query_str, assistant — блоки
 * workflow/web_results, а при их отсутствии fallback entry.text (FINAL-шаг → answer).
 * @param json Распарсенный JSON ответа истории Perplexity (REST-тред или его кадр SSE).
 */
export function parsePerplexityThread(json: unknown): PerplexityThreadResult {
  /**
   * Чтение поля с учётом пробелов в ключах объекта.
   * @param obj Объект ответа.
   * @param name Имя поля (сравнивается после trim).
   * @returns Значение поля или undefined.
   */
  function getTrim(obj: unknown, name: string): any {
    if (!obj || typeof obj !== 'object') return undefined;
    var rec = obj as Record<string, unknown>;
    var keys = Object.keys(rec);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].trim() === name) return rec[keys[i]];
    }
    return undefined;
  }

  /**
   * Признак загруженного в Perplexity вложения: S3-хост ppl-ai-file-upload, путь /attachments/.
   * Такие элементы приходят и в entry.attachments, и в web_results (цитаты картинок),
   * но веб-источниками не являются.
   * @param url Адрес элемента.
   * @returns true для вложения пользователя.
   */
  function isAttachmentUrl(url: unknown): boolean {
    if (typeof url !== 'string' || !url) return false;
    return url.indexOf('ppl-ai-file-upload') !== -1 && url.indexOf('/attachments/') !== -1;
  }

  /**
   * Признак изображения среди вложений (расширение файла в пути без query/hash).
   * @param url Адрес вложения.
   * @returns true для картинки.
   */
  function isImageAttachment(url: string): boolean {
    if (!isAttachmentUrl(url)) return false;
    var path = String(url).split('#')[0].split('?')[0];
    return /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(path);
  }

  /**
   * Адрес без query/hash: подписанные X-Amz-параметры истекают и не должны попадать в экспорт.
   * @param url Адрес вложения.
   * @returns Адрес без query и hash.
   */
  function stripUrlQuery(url: string): string {
    return String(url).split('#')[0].split('?')[0];
  }

  /**
   * Адреса изображений пользователя из entry.attachments (порядок сохраняется, дубли убираются).
   * web_results сюда не входят: цитата картинки из прошлого сообщения не принадлежит текущему.
   * @param entry Запись треда.
   * @returns Адреса без query/hash.
   */
  function collectEntryImages(entry: unknown): string[] {
    var out = [];
    var atts = getTrim(entry, 'attachments');
    if (!Array.isArray(atts)) return out;
    for (var a = 0; a < atts.length; a++) {
      var att = atts[a];
      var url = '';
      if (typeof att === 'string') url = att;
      else if (att && typeof att === 'object') url = getTrim(att, 'url') || getTrim(att, 'src') || '';
      if (!isImageAttachment(url)) continue;
      var clean = stripUrlQuery(url);
      if (out.indexOf(clean) === -1) out.push(clean);
    }
    return out;
  }

  /**
   * Базовое имя файла из адреса вложения.
   * @param url Адрес без query/hash.
   * @returns Имя файла.
   */
  function basenameOf(url: string): string {
    var parts = String(url || '').split('/');
    return parts[parts.length - 1] || '';
  }

  var model = '';
  var pieces: string[] = [];
  var ids: string[] = [];
  var count = 0;
  var lastText = '';
  var messages: PerplexityThreadMessage[] = [];

  try {
    var entries = getTrim(json, 'entries');
    if (!Array.isArray(entries)) entries = [];

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || typeof entry !== 'object') continue;

      var queryStr = getTrim(entry, 'query_str') || '';
      var displayModel = getTrim(entry, 'display_model') || '';
      var userSelectedModel = getTrim(entry, 'user_selected_model') || '';
      var threadUrlSlug = getTrim(entry, 'thread_url_slug') || '';

      var entryModel = displayModel || userSelectedModel || '';
      if (entryModel) model = entryModel;

      var entryId = threadUrlSlug || ('entry' + i);

      // Сообщение пользователя. Картинки-вложения этого запроса помечаются
      // [Image: src] там же, где в UI нарисованы чипы вложений — под текстом.
      var entryImages = collectEntryImages(entry);
      if (queryStr && typeof queryStr === 'string' && queryStr.trim()) {
        var userText = queryStr.trim();
        for (var im = 0; im < entryImages.length; im++) {
          userText += '\n[Image: ' + entryImages[im] + ']';
        }
        pieces.push(userText);
        ids.push(entryId + '_user');
        count++;
        lastText = userText;
        messages.push({ role: 'user', text: userText });
      }

      var entryImageNames = [];
      for (var inm = 0; inm < entryImages.length; inm++) {
        entryImageNames.push(basenameOf(entryImages[inm]));
      }

      // Сообщение ассистента: сбор из блоков
      var blocks = getTrim(entry, 'blocks');
      var assistantPushed = false;
      if (Array.isArray(blocks)) {
        var assistantTextParts = [];
        for (var j = 0; j < blocks.length; j++) {
          var block = blocks[j];
          if (!block || typeof block !== 'object') continue;

          // workflow_block: WORKFLOW_ITEM_TEXT
          var wfBlock = getTrim(block, 'workflow_block');
          if (wfBlock && typeof wfBlock === 'object') {
            var steps = getTrim(wfBlock, 'steps');
            if (Array.isArray(steps)) {
              for (var s = 0; s < steps.length; s++) {
                var step = steps[s];
                if (!step || typeof step !== 'object') continue;
                var items = getTrim(step, 'items');
                if (Array.isArray(items)) {
                  for (var it = 0; it < items.length; it++) {
                    var item = items[it];
                    if (!item || typeof item !== 'object') continue;
                    if (getTrim(item, 'type') === 'WORKFLOW_ITEM_TEXT') {
                      var payload = getTrim(item, 'payload');
                      if (payload && typeof payload === 'object') {
                        var textPayload = getTrim(payload, 'text_payload');
                        if (textPayload && typeof textPayload === 'object') {
                          var text = getTrim(textPayload, 'text');
                          if (typeof text === 'string' && text.trim()) {
                            assistantTextParts.push(text.trim());
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          // web_result_block: источники
          var wrBlock = getTrim(block, 'web_result_block');
          if (wrBlock && typeof wrBlock === 'object') {
            var webResults = getTrim(wrBlock, 'web_results');
            if (Array.isArray(webResults)) {
              for (var w = 0; w < webResults.length; w++) {
                var wr = webResults[w];
                if (!wr || typeof wr !== 'object') continue;
                var wrName = getTrim(wr, 'name') || '';
                var wrSnippet = getTrim(wr, 'snippet') || '';
                var wrUrl = getTrim(wr, 'url');
                // Загруженные картинки — не веб-источники: их метка стоит в сообщении
                // пользователя, поэтому [source] сюда не попадает.
                if (isAttachmentUrl(wrUrl)) continue;
                if (!wrUrl && wrName && !wrSnippet && entryImageNames.indexOf(basenameOf(String(wrName))) !== -1) continue;
                if (wrName || wrSnippet) {
                  var wrText = (wrName ? wrName + ': ' : '') + (wrSnippet || '');
                  if (wrText.trim()) assistantTextParts.push('[source] ' + wrText.trim());
                }
              }
            }
          }
        }

        if (assistantTextParts.length > 0) {
          var assistantText = assistantTextParts.join('\n').trim();
          if (assistantText) {
            pieces.push(assistantText);
            ids.push(entryId + '_assistant');
            count++;
            lastText = assistantText;
            messages.push({ role: 'assistant', text: assistantText });
            assistantPushed = true;
          }
        }
      }

      // Fallback для живого REST /rest/thread/{slug}: blocks в ответе нет,
      // ответ лежит в entry.text — JSON-строка массива шагов. FINAL-шаг несёт
      // content.answer (JSON-строка) с полем answer. Двойной JSON.parse в try/catch.
      if (!assistantPushed) {
        var entryText = getTrim(entry, 'text');
        if (typeof entryText === 'string' && entryText.trim()) {
          var stepsJson = null;
          try { stepsJson = JSON.parse(entryText); } catch (e1) { stepsJson = null; }
          var stepItems = null;
          if (Array.isArray(stepsJson)) stepItems = stepsJson;
          else if (stepsJson && typeof stepsJson === 'object') {
            stepItems = Object.keys(stepsJson).map(function (k) { return stepsJson[k]; });
          }
          var answerText = '';
          if (stepItems) {
            for (var si = 0; si < stepItems.length; si++) {
              var stepItem = stepItems[si];
              if (!stepItem || typeof stepItem !== 'object') continue;
              if (getTrim(stepItem, 'step_type') !== 'FINAL') continue;
              var stepContent = getTrim(stepItem, 'content');
              var contentObj = null;
              if (typeof stepContent === 'string') {
                try { contentObj = JSON.parse(stepContent); } catch (e2) { contentObj = null; }
              } else if (stepContent && typeof stepContent === 'object') {
                contentObj = stepContent;
              }
              if (!contentObj) continue;
              var answerRaw = getTrim(contentObj, 'answer');
              if (typeof answerRaw === 'string' && answerRaw.trim()) {
                var answerObj = null;
                try { answerObj = JSON.parse(answerRaw); } catch (e3) { answerObj = null; }
                if (answerObj && typeof answerObj === 'object') {
                  var answerField = getTrim(answerObj, 'answer');
                  if (typeof answerField === 'string') answerText = answerField;
                } else if (typeof answerObj === 'string') {
                  answerText = answerObj;
                }
              } else if (answerRaw && typeof answerRaw === 'object') {
                var answerField2 = getTrim(answerRaw, 'answer');
                if (typeof answerField2 === 'string') answerText = answerField2;
              }
              if (answerText) break;
            }
          }
          answerText = answerText.trim();
          if (answerText) {
            pieces.push(answerText);
            ids.push(entryId + '_assistant');
            count++;
            lastText = answerText;
            messages.push({ role: 'assistant', text: answerText });
          }
        }
      }
    }
  } catch (e) {
    swallowSoft(e, 'perplexity-utils:parsePerplexityThread');
    // возвращаем пустой результат при ошибке
  }

  return {
    text: pieces.join('\n'),
    count: count,
    lastText: lastText,
    modelSlug: model,
    pieces: pieces,
    ids: ids,
    messages: messages,
    model: model
  };
}

/**
 * v2.0.34: Perplexity дописывает в адрес истории limit=20&offset=0&from_first=false —
 * это урезанный снимок (последние 20 записей). Для шаблона полной истории такие
 * параметры выкидываем, остальные (with_parent_info и т.п.) и #hash сохраняем.
 * @param urlStr Адрес истории Perplexity.
 * @returns Адрес без limit/offset/from_first, с сохранёнными прочими параметрами и #hash.
 */
export function stripPerplexityHistoryTruncation(urlStr: string | null | undefined): string {
  var src = String(urlStr || '');
  if (!src) return src;
  var hash = '';
  var h = src.indexOf('#');
  if (h !== -1) { hash = src.slice(h); src = src.slice(0, h); }
  var q = src.indexOf('?');
  if (q === -1) return src + hash;
  var base = src.slice(0, q);
  var parts = src.slice(q + 1).split('&');
  var kept = [];
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var name = parts[i].split('=')[0];
    if (name === 'limit' || name === 'offset' || name === 'from_first') continue;
    kept.push(parts[i]);
  }
  return base + (kept.length ? '?' + kept.join('&') : '') + hash;
}
