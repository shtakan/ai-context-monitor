/**
 * Изолированный хелпер парсера ответа Google Search AI (folwr).
 * Выделен из core/google-search-intercept.js, не зависит от DOM/браузерного API.
 * @param {object} folwrJson - распарсенный JSON ответа /folwr
 * @returns {{ messages: Array<{role:string, content:string}>, model: string, tokens: number }}
 */

function parseSearchAIFolwr(folwrJson) {
  var messages = [];
  var model = '';
  var tokens = 0;

  try {
    if (!folwrJson || typeof folwrJson !== 'object') {
      return { messages: [], model: 'gemini-1.5-flash', tokens: 0 };
    }

    // Извлечение модели
    if (folwrJson.model) {
      model = folwrJson.model;
    } else if (folwrJson.settings && folwrJson.settings.model) {
      model = folwrJson.settings.model;
    }

    // Ходы: массив с userText / assistantText (как в google-search-intercept)
    var turns = folwrJson.turns;
    if (!Array.isArray(turns)) {
      turns = folwrJson.items || folwrJson.results || [];
    }

    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (!t || typeof t !== 'object') continue;

      if (t.userText && typeof t.userText === 'string' && t.userText.trim()) {
        messages.push({ role: 'user', content: t.userText.trim() });
      }
      if (t.assistantText && typeof t.assistantText === 'string' && t.assistantText.trim()) {
        messages.push({ role: 'assistant', content: t.assistantText.trim() });
      }
    }

    // Оценка токенов по длине
    var totalChars = 0;
    for (var j = 0; j < messages.length; j++) {
      totalChars += messages[j].content.length;
    }
    tokens = Math.ceil(totalChars / 4);
  } catch (e) {
    // пустой результат при ошибке
  }

  if (!model) model = 'gemini-1.5-flash';
  return { messages: messages, model: model, tokens: tokens };
}

module.exports = { parseSearchAIFolwr };