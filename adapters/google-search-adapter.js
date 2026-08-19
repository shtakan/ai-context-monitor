class GoogleSearchAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'google_search';
    this._lastNetworkModel = '';
    console.log('[GoogleSearchAdapter] Инициализирован (v2: AI-режим)');

    if (typeof window !== 'undefined') {
      var self = this;
      try {
        window.addEventListener('ai-cm-full-history', function (ev) {
          var detail = ev && ev.detail;
          if (detail && detail.modelSlug) {
            self._lastNetworkModel = detail.modelSlug;
          }
        });
        // handshake: сигналим перехватчику (MAIN world), что content.js уже подписан на ai-cm-full-history
        window.dispatchEvent(new CustomEvent('ai-cm-google-search-ready'));
      } catch (e) {}
    }
  }

  isOnDialogPage() {
    var hasTurns = document.querySelector('[data-scope-id="turn"]') !== null;
    var hasAimfl = document.querySelector('[data-subtree="aimfl"]') !== null;
    var hasInput = document.querySelector('textarea, [contenteditable="true"]') !== null;
    var result = hasTurns || hasAimfl || hasInput;
    console.log('[GoogleSearchAdapter] Страница диалога: ' + result);
    return result;
  }

  extractMessages() {
    try {
      var turns = document.querySelectorAll('[data-scope-id="turn"]');
      if (!turns || turns.length === 0) {
        console.log('[GoogleSearchAdapter] Turn-контейнеров не найдено');
        return [];
      }

      // Собираем вопросы из h2.iMqumd внутри turn'ов
      var questions = [];
      for (var i = 0; i < turns.length; i++) {
        var h2 = turns[i].querySelector('h2.iMqumd');
        var qText = null;
        if (h2) {
          var raw = h2.textContent.trim();
          var match = raw.match(/^Вы сказали:\s*"([\s\S]*)"$/);
          if (match) {
            qText = match[1].trim();
          } else {
            qText = raw;
          }
        }
        questions.push(qText);
      }

      // Распределяем блоки .n6owBd.awi2gc по turn'ам
      var answerBlocks = [];
      for (var ti = 0; ti < turns.length; ti++) {
        answerBlocks[ti] = [];
      }

      var blocks = document.querySelectorAll('.n6owBd.awi2gc');
      for (var b = 0; b < blocks.length; b++) {
        var block = blocks[b];
        var assignedIdx = -1;
        for (var ti2 = 0; ti2 < turns.length; ti2++) {
          if (turns[ti2].compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) {
            assignedIdx = ti2;
          } else {
            break;
          }
        }
        if (assignedIdx >= 0 && assignedIdx < turns.length) {
          var clone = block.cloneNode(true);
          clone.querySelectorAll('script, style, button, svg').forEach(function(el) { el.remove(); });
          var blockText = clone.textContent.trim();
          if (blockText) {
            answerBlocks[assignedIdx].push(blockText);
          }
        }
      }

      // Собираем ответы
      var answers = [];
      for (var ti3 = 0; ti3 < turns.length; ti3++) {
        var joined = answerBlocks[ti3].length > 0 ? answerBlocks[ti3].join('\n\n') : null;
        // Фолбэк: [data-subtree="aimfl"] по индексу
        if (!joined) {
          var allAimfl = document.querySelectorAll('[data-subtree="aimfl"]');
          if (allAimfl[ti3]) {
            var aimText = allAimfl[ti3].textContent.trim();
            if (aimText) joined = aimText;
          }
        }
        answers.push(joined);
      }

      // Формируем сообщения: user → assistant, по порядку
      var messages = [];
      for (var k = 0; k < Math.min(questions.length, answers.length); k++) {
        if (questions[k]) {
          messages.push({ role: 'user', content: questions[k] });
        }
        if (answers[k]) {
          messages.push({ role: 'assistant', content: answers[k] });
        }
      }

      console.log('[GoogleSearchAdapter] Извлечено ' + messages.length + ' сообщений');
      return messages;
    } catch (error) {
      console.error('[GoogleSearchAdapter] Ошибка:', error);
      return [];
    }
  }

  getFullDialogText() {
    return this.extractMessages().map(function(msg) { return msg.content; }).join('\n');
  }

  detectModel() {
    // Модель берём ТОЛЬКО из сети (активный/пассивный ответ, detail.modelSlug).
    // Дефект: раньше фолбэк отдавал DOM-догадку gemini-2.5-flash, хотя в сети
    // ходит 1.5-pro/1.5-flash. Для GSA 2.5-flash не возвращаем никогда.
    if (this._lastNetworkModel) return this._lastNetworkModel;
    return '';
  }
}