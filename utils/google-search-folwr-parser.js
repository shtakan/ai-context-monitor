/**
 * Чистая функция парсинга полной HTML-истории Google Search AI (GET /async/folwr).
 * Работает в браузере (window.parseGoogleFolwrOpen) и в Node (module.exports).
 *
 * Маркеры (из живой диагностики google-folwr-open.txt):
 *   - Контейнер реплики: <div class="CKgc1d" data-scope-id="turn">
 *   - Вопрос пользователя: <h2 class="iMqumd"> (формат: Вы сказали: "...")
 *   - Ответ модели: блоки-чанки <div class="n6owBd awi2gc"> (склеиваются)
 *   - Фолбэк ответа: <div data-subtree="aimfl">
 *   - Фолбэк вопроса: комментарии <!--TgQPHd|...-->
 *
 * Возврат: { turns: [{id, userText, assistantText}], messages: [{role, text}], text, count }
 * Тесты используют messages (role/text); text и count — конкатенация и число сообщений.
 */

(function () {
  function decodeEntities(s) {
    if (!s) return '';
    var out = String(s);
    out = out.replace(new RegExp('&' + 'quot;', 'g'), '"');
    out = out.replace(new RegExp('&' + 'amp;', 'g'), '&');
    out = out.replace(new RegExp('&' + '#39;', 'g'), "'");
    out = out.replace(new RegExp('&' + 'lt;', 'g'), '<');
    out = out.replace(new RegExp('&' + 'gt;', 'g'), '>');
    out = out.replace(new RegExp('&' + 'nbsp;', 'g'), ' ');
    out = out.replace(/&#(\d+);/g, function (m, d) {
      try { return String.fromCharCode(parseInt(d, 10)); } catch (e) { return m; }
    });
    return out;
  }

  function stripTags(html) {
    if (!html) return '';
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseGoogleFolwrOpen(htmlText) {
    var turns = [];
    var messages = [];

    if (!htmlText || typeof htmlText !== 'string') {
      return { turns: turns, messages: messages, text: '', count: 0 };
    }

    var doc;
    try {
      doc = new DOMParser().parseFromString(htmlText, 'text/html');
    } catch (e) {
      return { turns: turns, messages: messages, text: '', count: 0 };
    }

    var turnEls = doc.querySelectorAll('[data-scope-id="turn"]');
    var allAimfl = doc.querySelectorAll('[data-subtree="aimfl"]');
    var allN6 = doc.querySelectorAll('.n6owBd.awi2gc');
    var turnsArr = Array.prototype.slice.call(turnEls);

    // Фолбэк вопросов из комментариев TgQPHd
    var tgQuestions = [];
    try {
      var tgRe = /<!--TgQPHd\|[\s\S]*?-->/g;
      var m;
      while ((m = tgRe.exec(htmlText)) !== null) {
        var c = decodeEntities(m[0]);
        var longRe = /"([^"]{20,})"/g;
        var lm;
        var found = null;
        while ((lm = longRe.exec(c)) !== null) {
          var cand = lm[1];
          if (cand.indexOf('\\u0026') !== -1) continue;
          if (cand.indexOf('OLOoOd') !== -1) continue;
          if (cand.indexOf('dRog6c') !== -1) continue;
          if (cand.indexOf('TgQPHd') !== -1) continue;
          if (!/[а-яёА-ЯЁ]/.test(cand) && cand.indexOf(' ') === -1) continue;
          found = cand;
          break;
        }
        tgQuestions.push(found);
      }
    } catch (e) { /* тихо */ }

    for (var i = 0; i < turnsArr.length; i++) {
      var turn = turnsArr[i];

      // Вопрос пользователя из h2.iMqumd
      var question = null;
      var h2 = turn.querySelector('h2.iMqumd');
      if (h2) {
        var raw = (h2.textContent || '').trim();
        var qm = raw.match(/^Вы сказали:\s*"([\s\S]*)"$/);
        question = qm ? qm[1].trim() : raw;
      }

      // Ответ модели: чанки .n6owBd.awi2gc внутри хода (приоритет)
      var answerParts = [];
      var nested = turn.querySelectorAll('.n6owBd.awi2gc');
      for (var n = 0; n < nested.length; n++) {
        var nb = nested[n].cloneNode(true);
        nb.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
        var nt = (nb.textContent || '').trim();
        if (nt) answerParts.push(nt);
      }

      // Если внутри нет — распределяем глобальные блоки по позиции (compareDocumentPosition)
      if (answerParts.length === 0) {
        for (var b = 0; b < allN6.length; b++) {
          var block = allN6[b];
          var assignedIdx = -1;
          for (var ti2 = 0; ti2 < turnsArr.length; ti2++) {
            if (turnsArr[ti2].compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) {
              assignedIdx = ti2;
            } else {
              break;
            }
          }
          if (assignedIdx === i) {
            var bclone = block.cloneNode(true);
            bclone.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
            var bt = (bclone.textContent || '').trim();
            if (bt) answerParts.push(bt);
          }
        }
      }

      var assistantText = answerParts.length > 0 ? answerParts.join('\n\n') : null;

      // Фолбэк ответа из aimfl: сначала вложенный в ход, затем глобальный по индексу
      if (!assistantText) {
        var nestedAimfl = turn.querySelector('[data-subtree="aimfl"]');
        if (nestedAimfl) {
          var nat = (nestedAimfl.textContent || '').trim();
          if (nat) assistantText = nat;
        }
      }
      if (!assistantText && allAimfl[i]) {
        var at = (allAimfl[i].textContent || '').trim();
        if (at) assistantText = at;
      }

      // Фолбэк вопроса из TgQPHd
      if (!question && tgQuestions[i]) question = tgQuestions[i];

      turns.push({
        id: (turn.getAttribute && turn.getAttribute('jsuid')) || ('idx' + i),
        userText: question || null,
        assistantText: assistantText || null
      });
    }

    // Если turn-контейнеров нет вовсе — фолбэк folif-стиля
    if (turns.length === 0) {
      var folifAnswer = null;
      for (var aa = 0; aa < allAimfl.length; aa++) {
        var at2 = (allAimfl[aa].textContent || '').trim();
        if (at2) { folifAnswer = at2; break; }
      }
      if (!folifAnswer) {
        for (var bb = 0; bb < allN6.length; bb++) {
          var c2 = allN6[bb].cloneNode(true);
          c2.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
          var ntext = (c2.textContent || '').trim();
          if (ntext) { folifAnswer = ntext; break; }
        }
      }
      var folifQuestion = tgQuestions.length > 0 ? tgQuestions[0] : null;
      if (folifQuestion || folifAnswer) {
        turns.push({ id: 'folif_' + Date.now(), userText: folifQuestion, assistantText: folifAnswer });
      }
    }

    // Собрать messages + text
    for (var t = 0; t < turns.length; t++) {
      var t2 = turns[t];
      if (t2.userText) messages.push({ role: 'user', text: stripTags(decodeEntities(t2.userText)) });
      if (t2.assistantText) messages.push({ role: 'assistant', text: stripTags(decodeEntities(t2.assistantText)) });
    }

    var text = '';
    for (var mi = 0; mi < messages.length; mi++) {
      text += (mi > 0 ? '\n' : '') + messages[mi].text;
    }

    return { turns: turns, messages: messages, text: text, count: messages.length };
  }

  // Универсальный экспорт: браузер и Node
  if (typeof window !== 'undefined') {
    window.parseGoogleFolwrOpen = parseGoogleFolwrOpen;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseGoogleFolwrOpen: parseGoogleFolwrOpen };
  }
})();