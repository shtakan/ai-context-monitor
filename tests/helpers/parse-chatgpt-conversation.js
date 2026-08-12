/**
 * Изолированный хелпер парсера ответа ChatGPT conversation API.
 * Выделен из core/page-intercept.js, не зависит от DOM/браузерного API.
 * @param {object} json - распарсенный JSON ответа /backend-api/conversation/<id>
 * @returns {{ messages: Array<{role:string, content:string}>, model: string, tokens: number }}
 */

function parseChatGPTConversation(json) {
  var messages = [];
  var model = '';
  var tokens = 0;

  try {
    if (!json || typeof json !== 'object') {
      return { messages: [], model: 'gpt-4o', tokens: 0 };
    }

    // model_slug
    if (json.model_slug) {
      model = json.model_slug;
    }

    // tokens (из mapping или поля tokens)
    if (typeof json.tokens === 'number') {
      tokens = json.tokens;
    }

    // mapping: обход дерева сообщений
    var mapping = json.mapping || {};
    var ids = Object.keys(mapping);

    // Сообщения в порядке creation_time и собираем content
    var sortedIds = ids.filter(function (id) {
      var m = mapping[id];
      return m && m.message && m.message.content && m.message.content.parts;
    }).sort(function (a, b) {
      var ca = (mapping[a].message.create_time || 0);
      var cb = (mapping[b].message.create_time || 0);
      return ca - cb;
    });

    for (var i = 0; i < sortedIds.length; i++) {
      var node = mapping[sortedIds[i]];
      var msg = node.message;
      if (!msg) continue;

      var role = msg.author && msg.author.role;
      if (role === 'system' || role === 'tool') continue;

      // Собираем части контента
      var parts = msg.content.parts || [];
      var contentPieces = [];
      for (var j = 0; j < parts.length; j++) {
        if (typeof parts[j] === 'string') {
          contentPieces.push(parts[j]);
        }
      }
      var content = contentPieces.join('\n').trim();
      if (content) {
        messages.push({
          role: role === 'assistant' ? 'assistant' : 'user',
          content: content
        });
      }
    }
  } catch (e) {
    // возвращаем пустой результат при ошибке
  }

  if (!model) model = 'gpt-4o';
  return { messages: messages, model: model, tokens: tokens };
}

module.exports = { parseChatGPTConversation };