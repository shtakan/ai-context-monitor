/**
 * Чистая функция парсинга полной HTML-истории Google Search AI (GET /async/folwr).
 * Работает в браузере (window.parseGoogleFolwrOpen) и в Node (module.exports).
 *
 * Маркеры (из живой диагностики google-folwr-table.txt):
 *   - Контейнер реплики: <div class="CKgc1d" data-scope-id="turn"> — содержит ТОЛЬКО вопрос
 *     (h2.iMqumd) и пустые div; сам текст ответа лежит ВНЕ turn-контейнера.
 *   - Вопрос пользователя: <h2 class="iMqumd"> (формат: Вы сказали: "...")
 *   - Ответ модели: блоки-чанки <div class="n6owBd awi2gc"> лежат ВНЕ turn,
 *     в соседних контейнерах <div data-sn-op="2" data-target-container-id="...">.
 *   - Подзаголовки: <div role="heading" aria-level="3|4"> (классы otQkpb / AdPoic) — тоже ВНЕ turn.
 *   - Таблица: <table class="NRefec"><tr><th>…</th></tr><tr><td>…</td></tr></table>, тоже ВНЕ turn.
 *   - Фолбэк ответа: <div data-subtree="aimfl">
 *   - Фолбэк вопроса: комментарии <!--TgQPHd|...-->
 *
 * Алгоритм: контент-узлы ответа (чанки + подзаголовки + таблицы) собираются ГЛОБАЛЬНО,
 * затем распределяются по turn-контейнерам по document-позиции (compareDocumentPosition),
 * поэтому узлы, лежащие между turn'ами, попадают в нужный ход. Таблицы конвертируются
 * в markdown-строки («| ячейка | ячейка |»), подзаголовки — в текст.
 *
 * Возврат: { threadId, turns: [{id, userText, assistantText}], messages: [{role, text}], text, count }
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

  // Очистка текста ответа с сохранением переводов строк (markdown-строки таблиц не схлопываются).
  function sanitizeAssistant(s) {
    if (!s) return '';
    return String(s)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .split('\n')
      .map(function (ln) { return ln.trim(); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Ячейка таблицы: текст без внутренних тегов, без мусорных узлов.
  function tableCellText(cellEl) {
    var clone = cellEl.cloneNode(true);
    clone.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
    return stripTags(decodeEntities(clone.innerHTML)).trim();
  }

  // Таблица → markdown-строки: каждая строка таблицы = "| ячейка | ячейка |", строки через '\n'.
  function tableToMarkdown(tableEl) {
    var rows = tableEl.querySelectorAll('tr');
    var lines = [];
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll('th, td');
      var cellTexts = [];
      for (var c = 0; c < cells.length; c++) {
        cellTexts.push(tableCellText(cells[c]));
      }
      if (cellTexts.length === 0) continue;
      lines.push('| ' + cellTexts.join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  function isQuestionHeading(el) {
    return el.tagName === 'H2' && el.className && String(el.className).indexOf('iMqumd') !== -1;
  }

  // Распределяем глобальные контент-узлы ответа по turn-контейнерам: узел относится к последнему
  // предшествующему ему ходу (compareDocumentPosition FOLLOWING). Возвращает массив answerParts по turn.
  function assignContentToTurns(turnsArr, contentNodes) {
    var answers = [];
    for (var ti = 0; ti < turnsArr.length; ti++) answers[ti] = [];

    for (var n = 0; n < contentNodes.length; n++) {
      var node = contentNodes[n];
      var assigned = -1;
      for (var t2 = 0; t2 < turnsArr.length; t2++) {
        if (turnsArr[t2].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
          assigned = t2;
        } else {
          break;
        }
      }
      if (assigned < 0) continue;

      var part = null;
      if (node.tagName === 'TABLE') {
        var md = tableToMarkdown(node);
        if (md) part = md;
      } else {
        var cl = node.cloneNode(true);
        cl.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
        var ct = (cl.textContent || '').trim();
        if (ct) part = ct;
      }
      if (part) answers[assigned].push(part);
    }

    return answers;
  }

  function readThreadId(doc) {
    try {
      var el = doc.querySelector('[data-session-thread-id]');
      if (el) {
        var v = el.getAttribute('data-session-thread-id');
        return v ? v.trim() : '';
      }
    } catch (e) { }
    return '';
  }

  function parseGoogleFolwrOpen(htmlText) {
    var turns = [];
    var messages = [];

    if (!htmlText || typeof htmlText !== 'string') {
      return { threadId: '', turns: turns, messages: messages, text: '', count: 0 };
    }

    var doc;
    try {
      doc = new DOMParser().parseFromString(htmlText, 'text/html');
    } catch (e) {
      return { threadId: '', turns: turns, messages: messages, text: '', count: 0 };
    }

    var threadId = readThreadId(doc);
    var turnEls = doc.querySelectorAll('[data-scope-id="turn"]');
    var allAimfl = doc.querySelectorAll('[data-subtree="aimfl"]');
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

    // Глобальный список контент-узлов ответа (в document-порядке). Вопросы h2.iMqumd исключаем.
    var contentNodes = [];
    var allContentEls = doc.querySelectorAll('.n6owBd.awi2gc, table, [role="heading"], h2, h3, h4');
    for (var ci = 0; ci < allContentEls.length; ci++) {
      var el = allContentEls[ci];
      if (isQuestionHeading(el)) continue;
      contentNodes.push(el);
    }

    var answers = assignContentToTurns(turnsArr, contentNodes);

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

      var assistantText = answers[i].length > 0 ? answers[i].join('\n\n') : null;

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
      if (!folifAnswer && contentNodes.length > 0) {
        // используем первый контент-узел (чанк/заголовок/таблица)
        var firstNode = contentNodes[0];
        if (firstNode.tagName === 'TABLE') {
          folifAnswer = tableToMarkdown(firstNode);
        } else {
          var c2 = firstNode.cloneNode(true);
          c2.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
          folifAnswer = (c2.textContent || '').trim() || null;
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
      if (t2.assistantText) messages.push({ role: 'assistant', text: sanitizeAssistant(t2.assistantText) });
    }

    var text = '';
    for (var mi = 0; mi < messages.length; mi++) {
      text += (mi > 0 ? '\n' : '') + messages[mi].text;
    }

    return { threadId: threadId, turns: turns, messages: messages, text: text, count: messages.length };
  }

  // Универсальный экспорт: браузер и Node
  if (typeof window !== 'undefined') {
    window.parseGoogleFolwrOpen = parseGoogleFolwrOpen;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseGoogleFolwrOpen: parseGoogleFolwrOpen };
  }
})();