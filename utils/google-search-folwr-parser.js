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
 *   - O-45: КОД-ОКНА (python/js) — отдельные контейнеры вне чанка прозы (или внутри него):
 *     <pre>, <code> (многострочный), блочная обёртка class …code-block…; метка языка —
 *     соседний короткий ASCII-узел («python»). Рендерятся markdown-фенсом ```lang\n<код>\n```
 *     (renderCodeBlock) — код и маркеры языка попадают в файл целиком.
 *
 * Алгоритм: контент-узлы ответа (чанки + подзаголовки + таблицы + код-окна) собираются
 * ГЛОБАЛЬНО, затем распределяются по turn-контейнерам по document-позиции
 * (compareDocumentPosition), поэтому узлы, лежащие между turn'ами, попадают в нужный ход.
 * Таблицы конвертируются в markdown-строки («| ячейка | ячейка |»), подзаголовки — в текст,
 * код-окна — в ```lang-фенсы (многострочный код не схлопывается, отступы сохраняются).
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

  // ---- O-45: markdown-фенсы ```…``` (окна кода) ----
  // Всё, что ВНУТРИ фенса, — это код: его нельзя схлопывать по пробелам и срезать отступы по
  // строкам, иначе многострочное окно кода превратится в одну строку и форматирование погибнет.
  // Фенс может быть ДЛИННЕЕ трёх кавычек (если внутри кода есть ```), поэтому квантификатор
  // {3,} и обратная ссылка: закрывающий фенс — ровно той же длины, что открывающий.
  var FENCE_RE = /(`{3,})[\s\S]*?\1/g;

  // Применяет fn к сегментам ВНЕ фенсов; сами фенсы возвращаются байтово как есть.
  function mapOutsideFences(s, fn) {
    var str = String(s == null ? '' : s);
    var out = '';
    var last = 0;
    var m;
    FENCE_RE.lastIndex = 0;
    while ((m = FENCE_RE.exec(str)) !== null) {
      out += fn(str.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + fn(str.slice(last));
  }

  function stripTagsSeg(seg) {
    return String(seg)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
  }

  // O-45: текст без тегов, но фенсы (окна кода) не трогаются — раньше `\s+` → ' ' схлопывал
  // многострочный код в одну строку. Для строки без фенсов результат байтово прежний.
  function stripTags(html) {
    if (!html) return '';
    return mapOutsideFences(html, stripTagsSeg).replace(/^\s+/, '').replace(/\s+$/, '');
  }

  function sanitizeAssistantSeg(seg) {
    return String(seg)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .split('\n')
      .map(function (ln) { return ln.trim(); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  // Очистка текста ответа с сохранением переводов строк (markdown-строки таблиц не схлопываются).
  // O-45: сегменты внутри фенсов (окна кода) проходят КАК ЕСТЬ — построчный trim и схлопывание
  // пробелов уничтожили бы отступы кода; для текста без фенсов результат байтово прежний.
  function sanitizeAssistant(s) {
    if (!s) return '';
    return mapOutsideFences(s, sanitizeAssistantSeg).replace(/^\s+/, '').replace(/\s+$/, '');
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

  // ---- O-45: КОД-БЛОКИ (окна кода) в ответе ----
  // Спецификация: файл экспорта содержит полный текст код-блока ВМЕСТЕ с маркерами языка
  // (```lang\n<код>\n```). Дефект (живой прогон GSA, threadId gGezatSZK426i-gPxITekAw):
  // база = 796 знаков прозы, код (python/js), его метка языка и кнопка «Скопировать код»
  // отсутствовали — в отборе контент-узлов ответа код-контейнеров не было ВООБЩЕ, а
  // generic-ветка читала textContent (многострочный код схлопнулся бы в одну строку и
  // потерял бы маркеры языка). Здесь: отбор код-контейнеров + рендер в фенс ОДНИМ хелпером,
  // который переиспользуют сетевой путь (parseGoogleFolwrOpen), DOM-добор (extractTurnsFromDocument)
  // и DOM-путь адаптера (adapters/google-search-adapter.js).
  var CODE_CONTAINER_SEL = 'pre, code, [class*="code-block"], [class*="codeBlock"], [class*="codeblock"]';
  // Метка языка — ASCII-токен (python, js, bash, c++…). Кириллическая проза меткой не является,
  // иначе соседний абзац («Пример:») уехал бы в маркер языка.
  var CODE_LANG_RE = /^[A-Za-z][A-Za-z0-9+#._-]{0,19}$/;

  function classOf(el) {
    try { return String((el && el.className) || ''); } catch (e) { return ''; }
  }

  // Узел ПОХОЖ на код по тегу/классу (без решения «блок это или инлайн»).
  function isCodeLikeNode(el) {
    if (!el || !el.tagName) return false;
    var tag = String(el.tagName).toUpperCase();
    return tag === 'PRE' || tag === 'CODE' || /code-?block/i.test(classOf(el));
  }

  // Текст кода: textContent с СОХРАНЕНИЕМ переносов строк; сервисная обвязка окна кода
  // (кнопка «Скопировать код», script/style/svg) снимается, <br> становится переносом строки,
  // а если переносов нет и строк-детей несколько (в живом DOM строки кода — отдельные div'ы) —
  // собираем по строке на элемент. Краевые пустые строки и хвостовые пробелы не значимы.
  function codeTextOf(el) {
    if (!el || typeof el.cloneNode !== 'function') return '';
    var clone;
    try { clone = el.cloneNode(true); } catch (e) { return ''; }
    try {
      var junk = clone.querySelectorAll('script, style, button, svg');
      for (var i = 0; i < junk.length; i++) {
        if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
      }
      var brs = clone.querySelectorAll('br');
      var doc = clone.ownerDocument || (typeof document !== 'undefined' ? document : null);
      for (var b = 0; b < brs.length; b++) {
        if (brs[b].parentNode && doc && doc.createTextNode) {
          brs[b].parentNode.replaceChild(doc.createTextNode('\n'), brs[b]);
        }
      }
    } catch (e2) { /* узел без DOM-API (срез-песочница) */ }
    var txt = '';
    try { txt = String(clone.textContent || ''); } catch (e3) { txt = ''; }
    // Переносов нет, но дети — БЛОЧНЫЕ элементы (в живом DOM строка кода бывает отдельным div):
    // собираем по строке на элемент. Инлайновые дети (подсветка синтаксиса в span'ах) строк
    // не образуют — однострочный код со span'ами остаётся одной строкой.
    if (txt.indexOf('\n') === -1 && clone.children && clone.children.length > 1) {
      var allBlock = true;
      for (var k = 0; k < clone.children.length; k++) {
        if (!/^(DIV|P|LI|TR|SECTION|ARTICLE|FIGURE|BLOCKQUOTE|H[1-6])$/.test(String(clone.children[k].tagName || '').toUpperCase())) {
          allBlock = false;
          break;
        }
      }
      if (allBlock) {
        var lines = [];
        for (var k2 = 0; k2 < clone.children.length; k2++) {
          lines.push(String(clone.children[k2].textContent || ''));
        }
        var joined = lines.join('\n');
        if (joined.replace(/\s+/g, '')) txt = joined;
      }
    }
    return txt.replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\s+$/, '');
  }

  // Носитель текста кода: самый глубокий <pre>/<code> внутри контейнера — обёртка окна кода
  // может нести ещё и метку языка, и обвязку, в тело кода они попадать не должны.
  function codeBodyElement(el) {
    try {
      var inner = el.querySelectorAll ? el.querySelectorAll('pre, code') : null;
      if (inner && inner.length) return inner[inner.length - 1];
    } catch (e) { }
    return el;
  }

  // Метка языка окна кода: (1) явный аргумент, (2) атрибут/класс контейнера (language-python,
  // code-lang="python"), (3) СОСЕДНИЙ узел-метка ПЕРЕД окном кода — так устроен живой DOM GSA:
  // отдельный StaticText «python» → узел code с текстом кода. Меткой считается только короткий
  // ASCII-токен (CODE_LANG_RE): прозаический сосед метку не подменяет.
  function detectCodeLang(el, langHint) {
    if (langHint != null && CODE_LANG_RE.test(String(langHint).trim())) return String(langHint).trim();
    var attrNames = ['code-lang', 'data-lang', 'data-code-lang'];
    try {
      for (var a = 0; a < attrNames.length; a++) {
        var v = (el && el.getAttribute) ? el.getAttribute(attrNames[a]) : null;
        if (v && CODE_LANG_RE.test(String(v).trim())) return String(v).trim();
      }
    } catch (e) { }
    var m = classOf(el).match(/(?:^|[\s_-])(?:language|lang)[-_]([A-Za-z][A-Za-z0-9+#._-]{0,19})/);
    if (m && CODE_LANG_RE.test(m[1])) return m[1];
    var cur = el;
    for (var up = 0; cur && up < 4; up++) {
      var prev = cur.previousSibling;
      for (var hops = 0; prev && hops < 3; hops++) {
        var t = '';
        try { t = String(prev.textContent || '').trim(); } catch (e2) { t = ''; }
        if (t) {
          if (CODE_LANG_RE.test(t)) return t;
          break;
        }
        prev = prev.previousSibling;
      }
      cur = cur.parentNode;
    }
    return '';
  }

  // Код-БЛОК, а не инлайн-фрагмент: <pre>; <code> с переносом строки или меткой языка; блочная
  // обёртка окна кода (class …code-block…). Инлайн <code> в прозе («Код <code>nums.sort()</code>»)
  // блоком НЕ считается — он остаётся инлайн-текстом, а не превращается в фенс.
  function isCodeBlockElement(el) {
    if (!el || !el.tagName) return false;
    var tag = String(el.tagName).toUpperCase();
    if (/code-?block/i.test(classOf(el))) return true;
    if (tag === 'PRE') return true;
    if (tag !== 'CODE') return false;
    if (/(?:^|[\s_-])(?:language|lang)[-_]/.test(classOf(el))) return true;
    return codeTextOf(el).indexOf('\n') !== -1;
  }

  // Код-блок → markdown-фенс СО ЗНАКОМ ЯЗЫКА (спецификация O-45): ```lang\n<код>\n```.
  // Без метки — пустой язык: ```\n<код>\n```. Если внутри кода есть тройные кавычки, фенс
  // удлиняется (CommonMark), иначе окно кода развалилось бы на середине.
  function renderCodeBlock(node, langHint) {
    if (!node) return '';
    var body = codeBodyElement(node);
    var text = codeTextOf(body);
    if (!text) text = codeTextOf(node);
    if (!text) return '';
    var lang = detectCodeLang(node, langHint) || detectCodeLang(body, langHint);
    var fence = '```';
    while (text.indexOf(fence) !== -1) fence += '`';
    return fence + lang + '\n' + text + '\n' + fence;
  }

  // Текст контент-узла ответа: код-контейнер → фенс; обычный узел (чанк прозы, заголовок…) —
  // его текст, в котором код-окна ПОДМЕНЕНЫ фенсами: окно кода, лежащее внутри чанка,
  // не теряется и не схлопывается. Инлайн <code> не трогаем.
  function answerTextOf(node) {
    if (!node) return '';
    if (isCodeBlockElement(node)) return renderCodeBlock(node);
    if (typeof node.cloneNode !== 'function') return '';
    var clone;
    try { clone = node.cloneNode(true); } catch (e) { return ''; }
    try {
      var junk = clone.querySelectorAll('script, style, button, svg');
      for (var i = 0; i < junk.length; i++) {
        if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
      }
      var found = clone.querySelectorAll ? clone.querySelectorAll(CODE_CONTAINER_SEL) : [];
      var outer = [];
      for (var f = 0; f < found.length; f++) {
        if (!isCodeBlockElement(found[f])) continue;
        var nested = false;
        for (var o = 0; o < outer.length; o++) {
          if (outer[o].contains && outer[o].contains(found[f])) { nested = true; break; }
        }
        if (!nested) outer.push(found[f]);
      }
      var doc = clone.ownerDocument || (typeof document !== 'undefined' ? document : null);
      // С конца: после подмены внешнего контейнера вложенные уже неактуальны.
      for (var c = outer.length - 1; c >= 0; c--) {
        var fenced = renderCodeBlock(outer[c]);
        if (!fenced || !outer[c].parentNode || !doc || !doc.createTextNode) continue;
        outer[c].parentNode.replaceChild(doc.createTextNode('\n' + fenced + '\n'), outer[c]);
      }
    } catch (e2) { /* узел без DOM-API (срез-песочница) */ }
    var txt = '';
    try { txt = String(clone.textContent || ''); } catch (e3) { txt = ''; }
    return txt.trim();
  }

  // Узлы ответа DOM-пути в document-порядке: чанки прозы .n6owBd.awi2gc + САМОСТОЯТЕЛЬНЫЕ
  // код-окна между ними (вложенные и инлайн <code> отбрасываются). Один и тот же отбор
  // используют DOM-добор перехватчика (extractTurnsFromDocument) и адаптер — иначе сетевой
  // и DOM-пути разошлись бы по составу кода.
  function answerDomNodes(root) {
    var doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    var nodes = doc.querySelectorAll('.n6owBd.awi2gc, ' + CODE_CONTAINER_SEL);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isCodeLikeNode(el) && !isCodeBlockElement(el)) continue;
      var nested = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j].contains && out[j].contains(el)) { nested = true; break; }
      }
      if (nested) continue;
      out.push(el);
    }
    return out;
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
    var raw = doc.querySelectorAll('.n6owBd.awi2gc, table, [role="heading"], h2, h3, h4, ul, ol, li, [role="list"], [role="listitem"], ' + CODE_CONTAINER_SEL);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var el = raw[i];
      if (isQuestionHeading(el)) continue;
      // O-45: самостоятельным контент-узлом становится только КОД-БЛОК; одиночный инлайн <code>
      // блоком не является (в прозе он уже покрыт родительским чанком) — поведение прежнее.
      if (isCodeLikeNode(el) && !isCodeBlockElement(el)) continue;
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
        // O-45: код-окно → фенс ```lang … ``` (и код ВНУТРИ чанка тоже), иначе textContent.
        // Многострочный код не схлопывается и не теряет маркеры языка.
        var ct = answerTextOf(node).trim();
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
        // используем первый контент-узел (чанк/заголовок/таблица/код-окно)
        var firstNode = contentNodes[0];
        if (firstNode.tagName === 'TABLE') {
          folifAnswer = tableToMarkdown(firstNode);
        } else {
          // O-45: общий рендер узла (код-окно → фенс), как в assignContentToTurns.
          folifAnswer = answerTextOf(firstNode).trim() || null;
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
      // O-45: тот же отбор, что у сетевого пути — чанки прозы + САМОСТОЯТЕЛЬНЫЕ код-окна между
      // ними (answerDomNodes); текст узла — общим хелпером answerTextOf (код → ```lang … ```).
      // Раньше окно кода ВНЕ чанка не собиралось и в DOM-доборе: код терялся и здесь.
      var blocks = answerDomNodes(doc);
      for (var b = 0; b < blocks.length; b++) {
        var blk = blocks[b];
        var assigned = -1;
        for (var t2 = 0; t2 < turnsArr.length; t2++) {
          if (turnsArr[t2].compareDocumentPosition(blk) & Node.DOCUMENT_POSITION_FOLLOWING) assigned = t2;
          else break;
        }
        if (assigned >= 0 && assigned < turnsArr.length) {
          var txt = answerTextOf(blk).trim();
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

  // ---- v1.17: классификация страницы ПРОДОЛЖЕНИЯ по СОДЕРЖИМОМУ, а не по длине ----
  // Живой дефект (новый формат Google Search AI): в ответе folwr ВСЕГДА есть data-mstk,
  // но это сессионный токен продолжения диалога (/async/folif), а НЕ курсор «догрузить
  // старые ходы». Запрос folwr с этим mstk отдаёт короткое или пустое тело.
  // Прежний гейт `txt.length <= 100000` объявлял такую страницу «пустой» ДО разбора →
  // probe завершался с ПОЛНАЯ=false, а content.js навсегда оставался с baseComplete=false.
  // Теперь решение принимается по факту разбора: сколько НОВЫХ ходов дал ответ и есть ли
  // НОВЫЙ (отличный от отправленного) курсор.
  //
  // input: { ok, status, bodyLength, newTurns, cursor, sentCursor }
  // Возврат: { kind, complete, canContinue, status, ok, bodyLength, newTurns, cursor,
  //            cursorRepeated, log }
  //   kind: 'http-error' | 'empty-body' | 'cursor-repeat' | 'no-new-turns' | 'new-turns'
  //   complete=true   → истории больше нет, базу можно объявить ПОЛНОЙ;
  //   canContinue=true → имеет смысл запрашивать следующую страницу (только 'new-turns').
  function classifyFolwrContinuation(input) {
    var i = input || {};
    var ok = i.ok === true;
    var status = (i.status == null) ? 0 : i.status;
    var bodyLength = (typeof i.bodyLength === 'number' && i.bodyLength >= 0) ? i.bodyLength : 0;
    var newTurns = (typeof i.newTurns === 'number' && i.newTurns > 0) ? i.newTurns : 0;
    var cursor = i.cursor ? String(i.cursor) : null;
    var sentCursor = i.sentCursor ? String(i.sentCursor) : null;
    var cursorRepeated = !!(cursor && sentCursor && cursor === sentCursor);

    var kind, complete, canContinue;
    if (!ok) {
      kind = 'http-error'; complete = false; canContinue = false;
    } else if (bodyLength === 0) {
      // 200 и ноль байт — сервер не дал продолжения; повторов не делаем.
      kind = 'empty-body'; complete = true; canContinue = false;
    } else if (cursorRepeated) {
      // Тот же курсор → следующий запрос вернёт ту же страницу: гасим цикл.
      kind = 'cursor-repeat'; complete = true; canContinue = false;
    } else if (newTurns > 0) {
      kind = 'new-turns'; complete = false; canContinue = true;
    } else {
      kind = 'no-new-turns'; complete = true; canContinue = false;
    }

    return {
      kind: kind,
      complete: complete,
      canContinue: canContinue,
      status: status,
      ok: ok,
      bodyLength: bodyLength,
      newTurns: newTurns,
      cursor: cursor,
      cursorRepeated: cursorRepeated,
      log: 'kind=' + kind + ' status=' + status + ' ok=' + (ok ? 1 : 0) +
        ' len=' + bodyLength + 'B ходов=+' + newTurns +
        ' курсор=' + (cursor ? ('есть(' + (cursorRepeated ? 'повтор' : 'новый') + ')') : 'нет')
    };
  }

  // Универсальный экспорт: браузер и Node
  if (typeof window !== 'undefined') {
    window.parseGoogleFolwrOpen = parseGoogleFolwrOpen;
    window.GoogleFolwrUtils = {
      countTurnContainers: countTurnContainers,
      extractTurnsFromDocument: extractTurnsFromDocument,
      mergeTurnsByKey: mergeTurnsByKey,
      extractContinuationToken: extractContinuationToken,
      mergeTurnsById: mergeTurnsById,
      classifyFolwrContinuation: classifyFolwrContinuation,
      // O-45: общий рендер код-блоков (```lang … ```) и отбор узлов DOM-пути —
      // переиспользуются адаптером (adapters/google-search-adapter.js) и тестами.
      renderCodeBlock: renderCodeBlock,
      answerTextOf: answerTextOf,
      answerDomNodes: answerDomNodes,
      isCodeBlockElement: isCodeBlockElement
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseGoogleFolwrOpen: parseGoogleFolwrOpen,
      countTurnContainers: countTurnContainers,
      extractTurnsFromDocument: extractTurnsFromDocument,
      mergeTurnsByKey: mergeTurnsByKey,
      extractContinuationToken: extractContinuationToken,
      mergeTurnsById: mergeTurnsById,
      classifyFolwrContinuation: classifyFolwrContinuation,
      renderCodeBlock: renderCodeBlock,
      answerTextOf: answerTextOf,
      answerDomNodes: answerDomNodes,
      isCodeBlockElement: isCodeBlockElement
    };
  }
})();