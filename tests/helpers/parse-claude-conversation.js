/**
 * Изолированный хелпер парсера истории Claude (GET /chat_conversations/).
 * Логика извлечена из core/claude-intercept.js (parseHistory).
 * @param {object} json - распарсенный JSON ответа истории Claude
 * @returns {{ model: string, messages: Array<{role: string, text: string}> }}
 */

function parseClaudeConversation(json) {
  var messages = [];
  var model = '';

  try {
    if (!json || typeof json !== 'object') {
      return { model: '', messages: [] };
    }

    model = json.model || '';

    var chatMessages = json.chat_messages;
    if (!Array.isArray(chatMessages)) {
      return { model: model, messages: [] };
    }

    for (var i = 0; i < chatMessages.length; i++) {
      var msg = chatMessages[i];
      if (!msg || !msg.content) continue;
      var sender = msg.sender || '';
      if (sender === 'system') continue;

      var blocks = msg.content;
      if (!Array.isArray(blocks)) continue;

      var textParts = [];
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        if (!b || typeof b !== 'object') continue;

        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text);
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          textParts.push(b.thinking);
        } else if (b.type === 'tool_use') {
          textParts.push(JSON.stringify(b));
        } else if (b.type === 'tool_result') {
          textParts.push(JSON.stringify(b));
        }
      }

      var text = textParts.join('\n').trim();
      if (text) {
        messages.push({
          role: sender === 'assistant' ? 'assistant' : 'human',
          text: text
        });
      }
    }
  } catch (e) {
    // возвращаем пустой результат при ошибке
  }

  return { model: model, messages: messages };
}

module.exports = { parseClaudeConversation };