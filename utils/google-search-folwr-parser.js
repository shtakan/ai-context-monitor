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

  // v1.5.2: чип «Самые популярные результаты веб-поиска по этой теме:» и связанные
  // запросы (чужая пользовательская реплика) приходят ПОСЛЕ последнего ответа и раньше
  // приклеивались к ходу ассистента через assignContentToTurns. Отсекаем их по тексту:
  // заголовок чипа веб-поиска и «Вы сказали:»-реплику, не привязанную к turn-контейнеру
  // (настоящий вопрос всегда h2.iMqumd внутри turn, поэтому в contentNodes он не попадает).
  var WEB_SEARCH_CHIP_RE = /(?:Самые популярные результаты веб-поиска по этой теме|People also search|Related searches|Похожие запросы|Связанные запросы)/i;
  var FOREIGN_QUESTION_RE = /^Вы сказали:\s*"/;

  function nodeText(node) {
    try { return (node.textContent || '').trim(); } catch (e) { return ''; }
  }

  // v1.5.2: заголовок чипа веб-поиска в folwr начинает блок «связанных запросов»,
  // который идёт ПОСЛЕ последнего ответа модели и ранее приклеивался к ходу ассистента.
  function isWebSearchChipNode(node) {
    return WEB_SEARCH_CHIP_RE.test(nodeText(node));
  }

  // Чужая пользовательская реплика вне turn-контейнера (настоящий вопрос — h2.iMqumd внутри turn).
  function isForeignQuestionNode(node) {
    return FOREIGN_QUESTION_RE.test(nodeText(node));
  }

  // Текст маркированного/нумерованного списка: каждый li — markdown-пунктом.
  // Формат: «- **Метка**: текст» (метка — первый bold/strong в пункте), без метки — «- текст».
  // Вложенные списки превращаются в текст родительского li, поэтому все пункты
  // входят в итоговый текст в исходном порядке.
  function listItemToMarkdown(liEl) {
    var clone = liEl.cloneNode(true);
    clone.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
    var label = null;
    var b = clone.querySelector('strong, b');
    if (b) {
      label = (b.textContent || '').replace(/\s+/g, ' ').trim();
      b.remove();
    }
    var rest = stripTags(decodeEntities(clone.innerHTML)).trim();
    if (label) {
      return '- **' + label + '**' + (rest ? ': ' + rest : '');
    }
    return rest ? '- ' + rest : '';
  }
  function listToText(listEl) {
    var items = listEl.querySelectorAll('li');
    var lines = [];
    for (var r = 0; r < items.length; r++) {
      var t = listItemToMarkdown(items[r]);
      if (t) lines.push(t);
    }
    return lines.join('\n');
  }

  // ВСЕ контент-узлы ответа в document-порядке, включая маркированные/нумерованные списки
  // и вложенные блоки. Вложенные узлы отбрасываем (дедуп по вложенности), чтобы текст не
  // дублировался: если список лежит ВНУТРИ чанка .n6owBd.awi2gc — чанк уже содержит его текст;
  // если список — самостоятельный узел между заголовком и финальным абзацем — он попадает сюда
  // как отдельный контент-узел и больше не теряется.
  function gatherAnswerContentNodes(doc) {
    var raw = doc.querySelectorAll('.n6owBd.awi2gc, table, [role="heading"], h2, h3, h4, ul, ol, li, [role="list"], [role="listitem"]');
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var el = raw[i];
      if (isQuestionHeading(el)) continue;
      var nested = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j].contains && out[j].contains(el)) { nested = true; break; }
      }
      if (nested) continue;
      out.push(el);
    }
    return out;
  }

  // Распределяем глобальные контент-узлы ответа по turn-контейнерам: узел относится к последнему
  // предшествующему ему ходу (compareDocumentPosition FOLLOWING). Возвращает массив answerParts по turn.
  function assignContentToTurns(turnsArr, contentNodes) {
    var answers = [];
    var skipAfterChip = [];
    for (var ti = 0; ti < turnsArr.length; ti++) { answers[ti] = []; skipAfterChip[ti] = false; }

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
      // v1.5.2: не вклеиваем чужую пользовательскую реплику.
      if (isForeignQuestionNode(node)) continue;
      // v1.5.2: чип веб-поиска («Самые популярные результаты…») начинает блок связанных
      // запросов текущего хода; сам чип и следующие за ним связанные запросы — UI-артефакты,
      // а не ответ модели. Закрываем этот ход до следующего turn-контейнера, НО не обрезаем
      // остальные ходы (глобальный cutoff раньше терял все ответы, когда чип шёл в начале).
      if (isWebSearchChipNode(node)) { skipAfterChip[assigned] = true; continue; }
      if (skipAfterChip[assigned]) continue;

      var part = null;
      if (node.tagName === 'TABLE') {
        var md = tableToMarkdown(node);
        if (md) part = md;
      } else if (node.tagName === 'UL' || node.tagName === 'OL') {
        var lt = listToText(node);
        if (lt) part = lt;
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

    // Глобальный список контент-узлов ответа (в document-порядке), включая списки и вложенные блоки.
    // Вопросы h2.iMqumd исключаем; вложенные узлы дедуплицируем, чтобы не дублировать текст.
    var contentNodes = gatherAnswerContentNodes(doc);

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

  // ---- Полнота (v1.5.2, дефект «folwr обрезан»): сравнение счётчиков + досбор из DOM ----
  // folwr может вернуть меньше ходов, чем реально видно в DOM (переписка длиннее).
  // Критерий «ПОЛНАЯ» — только при совпадении счётчика turn-контейнеров folwr и DOM;
  // иначе — досбор: merge хвоста/головы из DOM в снимок folwr.

  // Число turn-контейнеров в HTML-строке (снимок folwr).
  function countTurnContainers(htmlText) {
    if (!htmlText || typeof htmlText !== 'string') return 0;
    try {
      var doc = new DOMParser().parseFromString(htmlText, 'text/html');
      return doc.querySelectorAll('[data-scope-id="turn"]').length;
    } catch (e) { return 0; }
  }

  // Извлекает ходы из ЖИВОГО DOM (тот же формат, что GoogleSearchAdapter.extractMessages).
  // Используется для досбора, когда folwr отдал меньше ходов, чем видно на странице.
  function extractTurnsFromDocument(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    var turns = [];
    try {
      var turnEls = doc.querySelectorAll('[data-scope-id="turn"]');
      var allAimfl = doc.querySelectorAll('[data-subtree="aimfl"]');
      var turnsArr = Array.prototype.slice.call(turnEls);

      var questions = [];
      for (var i = 0; i < turnsArr.length; i++) {
        var h2 = turnsArr[i].querySelector('h2.iMqumd');
        var q = null;
        if (h2) {
          var raw = (h2.textContent || '').trim();
          var m = raw.match(/^Вы сказали:\s*"([\s\S]*)"$/);
          q = m ? m[1].trim() : raw;
        }
        questions.push(q);
      }

      var answers = [];
      for (var t = 0; t < turnsArr.length; t++) answers[t] = [];
      var blocks = doc.querySelectorAll('.n6owBd.awi2gc');
      for (var b = 0; b < blocks.length; b++) {
        var blk = blocks[b];
        var assigned = -1;
        for (var t2 = 0; t2 < turnsArr.length; t2++) {
          if (turnsArr[t2].compareDocumentPosition(blk) & Node.DOCUMENT_POSITION_FOLLOWING) assigned = t2;
          else break;
        }
        if (assigned >= 0 && assigned < turnsArr.length) {
          var clone = blk.cloneNode(true);
          clone.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
          var txt = (clone.textContent || '').trim();
          if (txt) answers[assigned].push(txt);
        }
      }

      for (var k = 0; k < turnsArr.length; k++) {
        var joined = answers[k].length ? answers[k].join('\n\n') : null;
        if (!joined && allAimfl[k]) {
          var at = (allAimfl[k].textContent || '').trim();
          if (at) joined = at;
        }
        turns.push({
          id: (turnsArr[k].getAttribute && turnsArr[k].getAttribute('jsuid')) || ('idx' + k),
          userText: questions[k] || null,
          assistantText: joined || null
        });
      }
    } catch (e) { }
    return turns;
  }

  // Токен продолжения (курсор пагинации) в ответе folwr: атрибут data-mstk на скрытых
  // div'ах-контейнерах следующих порций. Возвращает строку курсора или null.
  function extractContinuationToken(htmlText) {
    if (!htmlText || typeof htmlText !== 'string') return null;
    try {
      var doc = new DOMParser().parseFromString(htmlText, 'text/html');
      var els = doc.querySelectorAll('[data-mstk]');
      var last = null;
      for (var i = 0; i < els.length; i++) {
        var v = els[i].getAttribute('data-mstk');
        if (v) last = v.trim();
      }
      return last;
    } catch (e) { return null; }
  }

  // Слияние ходов по id (turn.id) — для тихой пагинации чанков folwr, где один и тот же ход
  // может повториться на границе порций. Более новый ход не перезаписывает; дубли по id убираются.
  function mergeTurnsById(baseTurns, extraTurns) {
    baseTurns = Array.isArray(baseTurns) ? baseTurns : [];
    extraTurns = Array.isArray(extraTurns) ? extraTurns : [];
    var byId = {};
    var out = [];
    function add(t) {
      if (!t) return;
      var id = (t.id != null) ? String(t.id) : ('x' + out.length);
      if (Object.prototype.hasOwnProperty.call(byId, id)) return;
      byId[id] = true;
      out.push({ id: id, userText: t.userText || null, assistantText: t.assistantText || null });
    }
    var i;
    for (i = 0; i < baseTurns.length; i++) add(baseTurns[i]);
    for (i = 0; i < extraTurns.length; i++) add(extraTurns[i]);
    return out;
  }

  // Досбор: сливает ходы folwr и DOM, дедуплицируя по (userText||) + '||' + (assistantText||).
  function mergeTurnsByKey(baseTurns, extraTurns) {
    baseTurns = Array.isArray(baseTurns) ? baseTurns : [];
    extraTurns = Array.isArray(extraTurns) ? extraTurns : [];
    var seen = {};
    var out = [];
    function add(t) {
      if (!t) return;
      var key = (t.userText || '') + '||' + (t.assistantText || '');
      if (key === '||' || seen[key]) return;
      seen[key] = true;
      out.push({ id: (t.id != null) ? t.id : ('x' + out.length), userText: t.userText || null, assistantText: t.assistantText || null });
    }
    for (var i = 0; i < baseTurns.length; i++) add(baseTurns[i]);
    for (var j = 0; j < extraTurns.length; j++) add(extraTurns[j]);
    return out;
  }

  // Универсальный экспорт: браузер и Node
  if (typeof window !== 'undefined') {
    window.parseGoogleFolwrOpen = parseGoogleFolwrOpen;
    window.GoogleFolwrUtils = {
      countTurnContainers: countTurnContainers,
      extractTurnsFromDocument: extractTurnsFromDocument,
      mergeTurnsByKey: mergeTurnsByKey,
      extractContinuationToken: extractContinuationToken,
      mergeTurnsById: mergeTurnsById
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseGoogleFolwrOpen: parseGoogleFolwrOpen,
      countTurnContainers: countTurnContainers,
      extractTurnsFromDocument: extractTurnsFromDocument,
      mergeTurnsByKey: mergeTurnsByKey,
      extractContinuationToken: extractContinuationToken,
      mergeTurnsById: mergeTurnsById
    };
  }
})();