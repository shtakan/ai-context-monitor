/**
 * Чистая функция парсинга истории Perplexity (GET треда).
 * Работает в браузере (window.parsePerplexityThread) и в Node (module.exports).
 * Переиспользуется боевым кодом (core/perplexity-intercept.js) и тестами.
 * Источник ассистентских сообщений: entry.blocks (workflow/web_results) и, при
 * их отсутствии, fallback entry.text — живой REST /rest/thread/{slug} отдаёт
 * JSON-строку шагов: FINAL-шаг → content.answer (JSON-строка) → поле answer.
 *
 * @param {object} json - распарсенный JSON ответа истории Perplexity
 * @returns {{ model: string, messages: Array<{role: string, text: string}>, pieces: string[], ids: string[], count: number, lastText: string, modelSlug: string }}
 */

(function () {
  function parsePerplexityThread(json) {
    // getTrim: чтение поля с учётом пробелов в ключах
    function getTrim(obj, name) {
      if (!obj || typeof obj !== 'object') return undefined;
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].trim() === name) return obj[keys[i]];
      }
      return undefined;
    }

    var model = '';
    var pieces = [];
    var ids = [];
    var count = 0;
    var lastText = '';
    var messages = [];

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

        // Сообщение пользователя
        if (queryStr && typeof queryStr === 'string' && queryStr.trim()) {
          pieces.push(queryStr.trim());
          ids.push(entryId + '_user');
          count++;
          lastText = queryStr.trim();
          messages.push({ role: 'user', text: queryStr.trim() });
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

  // v2.0.34: Perplexity дописывает в адрес истории limit=20&offset=0&from_first=false —
  // это урезанный снимок (последние 20 записей). Для шаблона полной истории такие
  // параметры выкидываем, остальные (with_parent_info и т.п.) и #hash сохраняем.
  function stripPerplexityHistoryTruncation(urlStr) {
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

  // Универсальный экспорт: браузер и Node
  if (typeof window !== 'undefined') {
    window.parsePerplexityThread = parsePerplexityThread;
    // v2.0.34: новый хелпер не объявлен в types/globals.d.ts — приводим window к any локально.
    /** @type {any} */ (window).stripPerplexityHistoryTruncation = stripPerplexityHistoryTruncation;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parsePerplexityThread: parsePerplexityThread,
      stripPerplexityHistoryTruncation: stripPerplexityHistoryTruncation
    };
  }
})();