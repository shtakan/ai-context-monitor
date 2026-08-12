/**
 * Чистая функция парсинга истории Perplexity (GET треда).
 * Работает в браузере (window.parsePerplexityThread) и в Node (module.exports).
 * Переиспользуется боевым кодом (core/perplexity-intercept.js) и тестами.
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
            }
          }
        }
      }
    } catch (e) {
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

  // Универсальный экспорт: браузер и Node
  if (typeof window !== 'undefined') {
    window.parsePerplexityThread = parsePerplexityThread;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parsePerplexityThread: parsePerplexityThread };
  }
})();