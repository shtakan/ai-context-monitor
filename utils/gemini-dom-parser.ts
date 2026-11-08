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

/** Результат extractGeminiResponse. */
export interface GeminiDomResponse {
  /** Итоговый текст (абзацы и markdown-таблицы через перевод строки). */
  text: string;
  /** Число собранных кусков (абзацев или таблиц). */
  count: number;
  /** Куски в порядке следования. */
  parts: string[];
}

/** Признак контейнера мышления в class/id. */
var THINK_RE: RegExp = /think|thought/i;
/** Заголовок мышления (Thinking / Thought / Думал). */
var THINKING_LABEL_RE: RegExp = /thinking|\bthought\b|\bдумал\b/i;
/** Токен вложения Gemini ($AXzLiR…). */
var ATTACH_TOKEN_RE: RegExp = /\$AXzLiR[A-Za-z0-9+\/=]+/g;

/**
 * Вырезает токены вложений $AXzLiR… и схлопывает пробельные символы.
 * @param s Текст с токенами вложений.
 * @returns Текст без токенов; пробелы схлопнуты.
 */
export function stripAttachmentTokens(s: string): string {
  if (typeof s !== 'string') return s;
  return s.replace(ATTACH_TOKEN_RE, ' ').replace(/[ \t\f\v]+/g, ' ');
}

/**
 * Склейка значений атрибутов элемента в одну строку.
 * @param el DOM-элемент.
 * @param names Имена атрибутов в порядке чтения.
 * @returns Значения найденных атрибутов через пробел.
 */
function attrString(el: Element, names: string[]): string {
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
 * @param el DOM-элемент.
 * @returns Значения className и id через пробел ('' при ошибке).
 */
function classNameId(el: Element): string {
  try { return String(el.className || '') + ' ' + String(el.id || ''); } catch (e) { return ''; }
}

/**
 * Визуально скрытый контейнер Angular CDK (cdk-visually-hidden / cdk-live-announcer).
 * @param el DOM-элемент.
 * @returns true — элемент скрыт техническими классами CDK.
 */
function isHiddenContainer(el: Element): boolean {
  var h = classNameId(el).toLowerCase();
  return h.indexOf('cdk-visually-hidden') !== -1 || h.indexOf('cdk-live-announcer') !== -1;
}

/**
 * Контейнер мышления: признак в class/id или в aria-label/title.
 * @param el DOM-элемент.
 * @returns true — контейнер относится к блоку мышления.
 */
function isThinkingContainer(el: Element): boolean {
  if (THINK_RE.test(classNameId(el))) return true;
  var label = attrString(el, ['aria-label', 'title']);
  return THINKING_LABEL_RE.test(label);
}

/**
 * Заголовок мышления у кнопки/элемента: aria-label / title / текст кнопки.
 * @param el DOM-элемент.
 * @returns Склеенный заголовок для проверки THINKING_LABEL_RE.
 */
function thinkingControlLabel(el: Element): string {
  var label = attrString(el, ['aria-label', 'title']);
  if (el.tagName && String(el.tagName).toLowerCase() === 'button') {
    try { label += ' ' + (el.textContent || ''); } catch (e) { }
  }
  return label;
}

/**
 * Панель мышления: элемент, содержащий кнопку/заголовок мышления, но не таблицу.
 * Применяется к узлам-контейнерам (не к корню обхода), чтобы пропустить всю панель.
 * @param node DOM-узел.
 * @returns true — поддерево целиком относится к мышлению.
 */
function containsThinkingControl(node: Node): boolean {
  var found = false;
  (function scan(n: Node, depth: number): void {
    if (found || depth > 4) return;
    if (!n || n.nodeType !== 1) return;
    if (THINKING_LABEL_RE.test(thinkingControlLabel(n as Element))) { found = true; return; }
    var ch = n.childNodes;
    for (var i = 0; i < ch.length; i++) scan(ch[i], depth + 1);
  })(node, 0);
  return found;
}

/**
 * Есть ли внутри узла таблица (такие узлы не считаем панелью мышления).
 * @param node DOM-узел.
 * @returns true — внутри есть table.
 */
function containsTable(node: Node): boolean {
  var el = node as Element;
  try { return !!el.querySelector && !!el.querySelector('table'); } catch (e) { return false; }
}

/**
 * Панель мышления целиком (скрытый блок, контейнер мышления или контейнер с
 * заголовком мышления). Контейнер с таблицей панелью не считается — иначе потеряется
 * markdown-таблица.
 * @param node DOM-узел.
 * @returns true — узел (вместе с потомками) пропускается при обходе.
 */
function isThinkingPanel(node: Element): boolean {
  if (isHiddenContainer(node) || isThinkingContainer(node)) return true;
  // Контейнер с таблицей не считаем панелью мышления, чтобы не потерять markdown-таблицу.
  if (containsTable(node)) return false;
  return containsThinkingControl(node);
}

/**
 * Текст ячейки таблицы без внутренних тегов, мусорных узлов и токенов вложений.
 * @param el Ячейка (td/th) или её клон.
 * @returns Однострочный текст ячейки.
 */
function cleanCell(el: Element): string {
  var clone: Element;
  try { clone = el.cloneNode(true) as Element; } catch (e) { return ''; }
  try {
    clone.querySelectorAll('script, style, button, svg').forEach(function (x) { x.remove(); });
  } catch (e) { }
  try { return stripAttachmentTokens((clone.textContent || '').replace(/\s+/g, ' ').trim()); } catch (e) { return ''; }
}

/**
 * Таблица в markdown-строки: каждая строка = "| ячейка | ячейка |", строки через перевод строки.
 * @param tableEl DOM-элемент table.
 * @returns Markdown-таблица ('' при ошибке доступа к строкам).
 */
export function tableToMarkdown(tableEl: Element): string {
  var rows: ArrayLike<Element> = [];
  try { rows = tableEl.querySelectorAll('tr'); } catch (e) { rows = []; }
  var lines: string[] = [];
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r].querySelectorAll('th, td');
    var cellTexts: string[] = [];
    for (var c = 0; c < cells.length; c++) {
      cellTexts.push(cleanCell(cells[c]));
    }
    if (cellTexts.length === 0) continue;
    lines.push('| ' + cellTexts.join(' | ') + ' |');
  }
  return lines.join('\n');
}

/** Теги, завершающие текущий текстовый кусок. */
var BLOCK_TAGS: Record<string, number> = {
  'P': 1, 'DIV': 1, 'SECTION': 1, 'ARTICLE': 1, 'UL': 1, 'OL': 1,
  'LI': 1, 'H1': 1, 'H2': 1, 'H3': 1, 'H4': 1, 'H5': 1, 'H6': 1,
  'BLOCKQUOTE': 1, 'PRE': 1, 'BR': 1, 'HR': 1, 'HEADER': 1, 'FOOTER': 1,
  'MAIN': 1, 'ASIDE': 1, 'TR': 1, 'THEAD': 1, 'TBODY': 1
};

/**
 * DOM-парсер ответа Gemini: обход в документном порядке, пропуск скрытых блоков и
 * панелей мышления, вырезание токенов вложений, конвертация таблиц в markdown.
 * @param root Корневой DOM-узел ответа.
 * @returns Текст, число кусков и сами куски.
 */
export function extractGeminiResponse(root: Node): GeminiDomResponse {
  var parts: string[] = [];
  var buf: string[] = [];

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
   * @param str Текст узла.
   */
  function pushText(str: string): void {
    if (typeof str !== 'string') return;
    var t = stripAttachmentTokens(str.replace(/\s+/g, ' ').trim());
    if (t) buf.push(t);
  }

  /**
   * Рекурсивный обход узла: текст → буфер, таблица → markdown, панель мышления → пропуск.
   * @param node Текущий DOM-узел.
   */
  function walk(node: Node): void {
    if (!node) return;
    var type = node.nodeType;
    if (type === 3) { // TEXT_NODE
      pushText(node.nodeValue || '');
      return;
    }
    if (type !== 1) return; // только элементы

    // дальше узел — элемент: tagName/querySelector есть только у Element
    var el = node as Element;

    // скрытые блоки / контейнеры мышления / панели мышления пропускаем вместе с потомками
    if (isThinkingPanel(el)) {
      flush();
      return;
    }

    var tag = (el.tagName || '').toUpperCase();

    // таблица в markdown, потомков не обходим (чтобы не задвоить текст)
    if (tag === 'TABLE') {
      flush();
      var md = tableToMarkdown(el);
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
