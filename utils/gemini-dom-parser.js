/**
 * Чистый DOM-парсер текста ответа Gemini.
 * ES-модуль (Roadmap Ph2): публичный API — named-экспорты, потребитель — core/hybrid-tail.js.
 *
 * Назначение: текст ответа Gemini в DOM может содержать блоки мышления и визуально
 * скрытые контейнеры (cdk-visually-hidden, cdk-live-announcer), а также токены
 * вложений $AXzLiR..., которые раздувают счётчик токенов и попадают в историю/экспорт.
 * Одновременно ответ может содержать HTML-таблицы, текст которых раньше не попадал
 * в счётчик/экспорт.
 *
 * extractGeminiResponse(root):
 *   - обходит узлы root в документном порядке;
 *   - пропускает (вместе с потомками) скрытые блоки и контейнеры мышления,
 *     включая целиком панель мышления (элемент, содержащий кнопку/заголовок
 *     Thinking / Thought / Thought for / Думал);
 *   - вырезает токены вложений $AXzLiR...;
 *   - каждую HTML-таблицу конвертирует в markdown-строки и вставляет в текст;
 *   - остальной текст склеивает в абзацы, сохраняя порядок следования.
 *
 * Возврат: { text, count, parts }
 *   text  - итоговый текст (абзацы и markdown-таблицы через перевод строки);
 *   count - число собранных кусков (абзацев или таблиц);
 *   parts - массив кусков в порядке следования.
 */

/**
 * Результат extractGeminiResponse.
 * @typedef {Object} GeminiDomResponse
 * @property {string} text Итоговый текст (абзацы и markdown-таблицы через перевод строки).
 * @property {number} count Число собранных кусков (абзацев или таблиц).
 * @property {string[]} parts Куски в порядке следования.
 */

/** @type {RegExp} Признак контейнера мышления в class/id. */
var THINK_RE = /think|thought/i;
/** @type {RegExp} Заголовок мышления (Thinking / Thought / Думал). */
var THINKING_LABEL_RE = /thinking|\bthought\b|\bдумал\b/i;
/** @type {RegExp} Токен вложения Gemini ($AXzLiR…). */
var ATTACH_TOKEN_RE = /\$AXzLiR[A-Za-z0-9+\/=]+/g;

/**
 * Вырезает токены вложений $AXzLiR… и схлопывает пробельные символы.
 * @param {string} s Текст с токенами вложений.
 * @returns {string} Текст без токенов; пробелы схлопнуты.
 */
export function stripAttachmentTokens(s) {
  if (typeof s !== 'string') return s;
  return s.replace(ATTACH_TOKEN_RE, ' ').replace(/[ \t\f\v]+/g, ' ');
}

/**
 * Склейка значений атрибутов элемента в одну строку.
 * @param {any} el DOM-элемент.
 * @param {string[]} names Имена атрибутов в порядке чтения.
 * @returns {string} Значения найденных атрибутов через пробел.
 */
function attrString(el, names) {
  var out = '';
  for (var i = 0; i < names.length; i++) {
    try {
      var v = el.getAttribute ? el.getAttribute(names[i]) : null;
      if (v) out += ' ' + v;
    } catch (e) { }
  }
  return out;
}

/**
 * class и id элемента одной строкой — для поиска признаков по подстроке.
 * @param {any} el DOM-элемент.
 * @returns {string} Значения className и id через пробел ('' при ошибке).
 */
function classNameId(el) {
  try { return String(el.className || '') + ' ' + String(el.id || ''); } catch (e) { return ''; }
}

/**
 * Визуально скрытый контейнер Angular CDK (cdk-visually-hidden / cdk-live-announcer).
 * @param {any} el DOM-элемент.
 * @returns {boolean} true — элемент скрыт техническими классами CDK.
 */
function isHiddenContainer(el) {
  var h = classNameId(el).toLowerCase();
  return h.indexOf('cdk-visually-hidden') !== -1 || h.indexOf('cdk-live-announcer') !== -1;
}

/**
 * Контейнер мышления: признак в class/id или в aria-label/title.
 * @param {any} el DOM-элемент.
 * @returns {boolean} true — контейнер относится к блоку мышления.
 */
function isThinkingContainer(el) {
  if (THINK_RE.test(classNameId(el))) return true;
  var label = attrString(el, ['aria-label', 'title']);
  return THINKING_LABEL_RE.test(label);
}

/**
 * Заголовок мышления у кнопки/элемента: aria-label / title / текст кнопки.
 * @param {any} el DOM-элемент.
 * @returns {string} Склеенный заголовок для проверки THINKING_LABEL_RE.
 */
function thinkingControlLabel(el) {
  var label = attrString(el, ['aria-label', 'title']);
  if (el.tagName && String(el.tagName).toLowerCase() === 'button') {
    try { label += ' ' + (el.textContent || ''); } catch (e) { }
  }
  return label;
}

/**
 * Панель мышления: элемент, содержащий кнопку/заголовок мышления, но не таблицу.
 * Применяется к узлам-контейнерам (не к корню обхода), чтобы пропустить всю панель.
 * @param {any} node DOM-узел.
 * @returns {boolean} true — поддерево целиком относится к мышлению.
 */
function containsThinkingControl(node) {
  var found = false;
  (function scan(n, depth) {
    if (found || depth > 4) return;
    if (!n || n.nodeType !== 1) return;
    if (THINKING_LABEL_RE.test(thinkingControlLabel(n))) { found = true; return; }
    var ch = n.childNodes;
    for (var i = 0; i < ch.length; i++) scan(ch[i], depth + 1);
  })(node, 0);
  return found;
}

/**
 * Есть ли внутри узла таблица (такие узлы не считаем панелью мышления).
 * @param {any} node DOM-узел.
 * @returns {boolean} true — внутри есть table.
 */
function containsTable(node) {
  try { return !!node.querySelector && !!node.querySelector('table'); } catch (e) { return false; }
}

/**
 * Панель мышления целиком (скрытый блок, контейнер мышления или контейнер с
 * заголовком мышления). Контейнер с таблицей панелью не считается — иначе потеряется
 * markdown-таблица.
 * @param {any} node DOM-узел.
 * @returns {boolean} true — узел (вместе с потомками) пропускается при обходе.
 */
function isThinkingPanel(node) {
  if (isHiddenContainer(node) || isThinkingContainer(node)) return true;
  // Контейнер с таблицей не считаем панелью мышления, чтобы не потерять markdown-таблицу.
  if (containsTable(node)) return false;
  return containsThinkingControl(node);
}

/**
 * Текст ячейки таблицы без внутренних тегов, мусорных узлов и токенов вложений.
 * @param {any} el Ячейка (td/th) или её клон.
 * @returns {string} Однострочный текст ячейки.
 */
function cleanCell(el) {
  var clone;
  try { clone = el.cloneNode(true); } catch (e) { return ''; }
  try {
    clone.querySelectorAll('script, style, button, svg').forEach(function (x) { x.remove(); });
  } catch (e) { }
  try { return stripAttachmentTokens((clone.textContent || '').replace(/\s+/g, ' ').trim()); } catch (e) { return ''; }
}

/**
 * Таблица в markdown-строки: каждая строка = "| ячейка | ячейка |", строки через перевод строки.
 * @param {any} tableEl DOM-элемент table.
 * @returns {string} Markdown-таблица ('' при ошибке доступа к строкам).
 */
export function tableToMarkdown(tableEl) {
  var rows = [];
  try { rows = tableEl.querySelectorAll('tr'); } catch (e) { rows = []; }
  var lines = [];
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r].querySelectorAll('th, td');
    var cellTexts = [];
    for (var c = 0; c < cells.length; c++) {
      cellTexts.push(cleanCell(cells[c]));
    }
    if (cellTexts.length === 0) continue;
    lines.push('| ' + cellTexts.join(' | ') + ' |');
  }
  return lines.join('\n');
}

/** @type {Record<string, number>} Теги, завершающие текущий текстовый кусок. */
var BLOCK_TAGS = {
  'P': 1, 'DIV': 1, 'SECTION': 1, 'ARTICLE': 1, 'UL': 1, 'OL': 1,
  'LI': 1, 'H1': 1, 'H2': 1, 'H3': 1, 'H4': 1, 'H5': 1, 'H6': 1,
  'BLOCKQUOTE': 1, 'PRE': 1, 'BR': 1, 'HR': 1, 'HEADER': 1, 'FOOTER': 1,
  'MAIN': 1, 'ASIDE': 1, 'TR': 1, 'THEAD': 1, 'TBODY': 1
};

/**
 * DOM-парсер ответа Gemini: обход в документном порядке, пропуск скрытых блоков и
 * панелей мышления, вырезание токенов вложений, конвертация таблиц в markdown.
 * @param {any} root Корневой DOM-узел ответа.
 * @returns {GeminiDomResponse} Текст, число кусков и сами куски.
 */
export function extractGeminiResponse(root) {
  var parts = [];
  var buf = [];

  /** Сбрасывает накопленный буфер в parts (склейка + схлопывание пробелов). */
  function flush() {
    if (!buf.length) return;
    var s = buf.join(' ');
    buf = [];
    s = s.replace(/\s+/g, ' ').trim();
    if (s) parts.push(s);
  }

  /**
   * Кладёт текстовый кусок в буфер после зачистки токенов и пробелов.
   * @param {string} str Текст узла.
   * @returns {void}
   */
  function pushText(str) {
    if (typeof str !== 'string') return;
    var t = stripAttachmentTokens(str.replace(/\s+/g, ' ').trim());
    if (t) buf.push(t);
  }

  /**
   * Рекурсивный обход узла: текст → буфер, таблица → markdown, панель мышления → пропуск.
   * @param {any} node Текущий DOM-узел.
   * @returns {void}
   */
  function walk(node) {
    if (!node) return;
    var type = node.nodeType;
    if (type === 3) { // TEXT_NODE
      pushText(node.nodeValue || '');
      return;
    }
    if (type !== 1) return; // только элементы

    // скрытые блоки / контейнеры мышления / панели мышления пропускаем вместе с потомками
    if (isThinkingPanel(node)) {
      flush();
      return;
    }

    var tag = (node.tagName || '').toUpperCase();

    // таблица в markdown, потомков не обходим (чтобы не задвоить текст)
    if (tag === 'TABLE') {
      flush();
      var md = tableToMarkdown(node);
      if (md) parts.push(md);
      return;
    }

    // границы блока завершают текущий текстовый кусок
    if (BLOCK_TAGS[tag]) flush();

    var children = node.childNodes;
    for (var i = 0; i < children.length; i++) {
      walk(children[i]);
    }

    if (BLOCK_TAGS[tag]) flush();
  }

  // не обходим сам корень как кандидата на пропуск панели — только его детей
  if (root) {
    var rootChildren = root.childNodes;
    for (var i = 0; i < rootChildren.length; i++) {
      walk(rootChildren[i]);
    }
  }
  flush();

  var text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text, count: parts.length, parts: parts };
}
