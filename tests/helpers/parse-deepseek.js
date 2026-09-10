/**
 * Изолированный хелпер парсера ответа DeepSeek API.
 * Выделен из core/deepseek-intercept.js, не зависит от DOM/браузерного API.
 * @param {object} batchJson - распарсенный JSON ответа chat_completion
 * @returns {{ messages: Array<{role:string, content:string, model:string}>, model: string, tokens: number }}
 */

function parseDeepSeekResponse(batchJson) {
  var messages = [];
  var model = '';
  var tokens = 0;

  try {
    if (!batchJson || typeof batchJson !== 'object') {
      return { messages: [], model: 'DeepSeek-V3', tokens: 0 };
    }

    // history_messages — массив сообщений в линейном порядке (обход по parent_id)
    var historyMessages = batchJson.data && batchJson.data.history_messages;
    if (!Array.isArray(historyMessages)) {
      historyMessages = batchJson.history_messages || [];
    }

    // accumulated_token_usage (числитель процента)
    if (batchJson.data && batchJson.data.accumulated_token_usage &&
        typeof batchJson.data.accumulated_token_usage === 'number') {
      tokens = batchJson.data.accumulated_token_usage;
    } else if (typeof batchJson.accumulated_token_usage === 'number') {
      tokens = batchJson.accumulated_token_usage;
    }

    // Модель определяется походово: thinking_enabled → r1, иначе v3
    // Берём из первого сообщения с thinking_enabled
    for (var i = 0; i < historyMessages.length; i++) {
      var hm = historyMessages[i];
      if (!hm) continue;
      if (hm.thinking_enabled === true) {
        model = 'DeepSeek-R1';
        break;
      }
    }
    if (!model) model = 'DeepSeek-V3';

    // Собираем сообщения в порядке parent_id-цепи (как buildActiveChain в deepseek-intercept)
    var messagesById = {};
    var rootIds = [];
    for (var j = 0; j < historyMessages.length; j++) {
      var m = historyMessages[j];
      if (!m || !m.id) continue;
      messagesById[String(m.id)] = m;
      if (!m.parent_id || m.parent_id === 0) {
        rootIds.push(String(m.id));
      }
    }

    // Обход от корней (user-сообщения — root_id = 0)
    var visited = {};
    function walk(msgId) {
      if (!msgId || visited[msgId]) return;
      visited[msgId] = true;
      var msg = messagesById[msgId];
      if (!msg) return;
      if (msg.role === 'user' || msg.role === 'assistant') {
        var content = msg.content || '';
        if (typeof content !== 'string') content = '';
        if (content.trim()) {
          messages.push({
            role: msg.role,
            content: content.trim(),
            model: msg.thinking_enabled ? 'DeepSeek-R1' : 'DeepSeek-V3'
          });
        }
      }
      // Дети
      for (var cid in messagesById) {
        if (messagesById[cid].parent_id && String(messagesById[cid].parent_id) === msgId) {
          walk(cid);
        }
      }
    }

    // Сортируем rootIds чтобы найти user-сообщения (parent_id=0, root)
    if (rootIds.length > 0) {
      for (var k = 0; k < rootIds.length; k++) {
        walk(rootIds[k]);
      }
    } else {
      // Если нет корней — просто идём по массиву
      for (var l = 0; l < historyMessages.length; l++) {
        var mm = historyMessages[l];
        if (mm && (mm.role === 'user' || mm.role === 'assistant')) {
          var ct = (mm.content || '').trim();
          if (ct) {
            messages.push({
              role: mm.role,
              content: ct,
              model: mm.thinking_enabled ? 'DeepSeek-R1' : 'DeepSeek-V3'
            });
          }
        }
      }
    }
  } catch (e) {
    // ошибка — пустой результат
  }

  if (!model) model = 'DeepSeek-V3';
  return { messages: messages, model: model, tokens: tokens };
}

module.exports = { parseDeepSeekResponse };