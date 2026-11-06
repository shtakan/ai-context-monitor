/**
 * Лёгкий markdown в HTML конвертер для печатной формы (экспорт PDF).
 * Чистая логика, без зависимостей от DOM или браузера:
 *   - ES-модуль: экспорт escapeHtml/inline/render + default MarkdownRenderer.
 *
 * Поддерживает: заголовки от H1 до H6, жирный (двойные звёздочки), курсив
 * (одинарные звёздочки или подчёркивания), инлайн-код, ссылки [text](url),
 * списки (в том числе строки вида "- Метка: текст"), markdown-таблицы
 * (строки с разделителем) и code-ограждения из трёх обратных кавычек.
 * Остальной текст экранируется: HTML не проходит. Кириллица не страдает.
 */

/**
 * Экранирует HTML-спецсимволы (& < > ") в тексте.
 * @param {unknown} s Любое значение; null/undefined → ''.
 * @returns {string} Экранированная строка.
 */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;');
}

/**
 * Инлайн-разметка: инлайн-код, жирный, курсив, ссылки.
 * Работает на уже экранированной строке (HTML не может пролезть внутрь).
 * @param {unknown} text Исходный текст строки.
 * @returns {string} HTML строки.
 */
export function inline(text) {
  var src = escapeHtml(text);
  return src.replace(
    /(`[^`\n]+`)|(\*{2}[^*\n]+\*{2})|(\*[^*\s\n][^*\n]*\*)|(_[^_\s\n][^_\n]*_)|(\[[^\]]+\]\(([^)\s]+)\))/g,
    function (m, code, bold, italic, underline, link, url) {
      if (code) return '<code>' + code.slice(1, -1) + '</code>';
      if (bold) return '<strong>' + bold.slice(2, -2) + '</strong>';
      if (italic) return '<em>' + italic.slice(1, -1) + '</em>';
      if (underline) return '<em>' + underline.slice(1, -1) + '</em>';
      if (link) {
        var u = String(url || '').trim();
        // Только безопасные протоколы
        if (/^(https?:|mailto:|#|\/)/i.test(u)) {
          var label = link.slice(1, link.indexOf(']('));
          return '<a href="' + escapeHtml(u) + '">' + label + '</a>';
        }
        return m;
      }
      return m;
    }
  );
}

/**
 * Строка-разделитель таблицы: только | - : и пробелы, содержит хотя бы один минус.
 * @param {string|null|undefined} line Проверяемая строка.
 * @returns {boolean} true — строка является разделителем markdown-таблицы.
 */
function isTableSeparator(line) {
  if (!line) return false;
  var c = line.charAt(0);
  if (c !== '|' && c !== '-' && c !== ':') return false;
  return /^[\s|:—-]+$/.test(line) && /-/.test(line);
}

/**
 * Рендерит одну строку markdown-таблицы в <tr>.
 * @param {string|null|undefined} line Строка таблицы (с ведущим/хвостовым | или без).
 * @param {'th'|'td'} tag Тег ячейки: шапка таблицы или тело.
 * @returns {string} HTML-фрагмент строки `<tr>…</tr>`.
 */
function parseRow(line, tag) {
  var s = String(line || '').trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  var cells = s.split('|');
  var out = '<tr>';
  for (var c = 0; c < cells.length; c++) {
    out += '<' + tag + '>' + inline(cells[c].trim()) + '</' + tag + '>';
  }
  return out + '</tr>';
}

/**
 * Собирает таблицу, начиная со строки lines[i] (содержит | и есть разделитель ниже).
 * @param {string[]} lines Все строки документа.
 * @param {number} i Индекс строки заголовка таблицы.
 * @returns {{ html: string, nextIndex: number }} HTML таблицы и индекс первой строки после неё.
 */
function renderTable(lines, i) {
  var head = parseRow(lines[i], 'th');
  var body = [];
  var j = i + 2; // пропускаем строку-разделитель
  while (j < lines.length) {
    var t = (lines[j] || '').trim();
    if (t === '' || t.indexOf('|') === -1) break;
    body.push(parseRow(lines[j], 'td'));
    j++;
  }
  return {
    html: '<table><thead>' + head + '</thead>' +
      (body.length ? '<tbody>' + body.join('') + '</tbody>' : '') + '</table>',
    nextIndex: j
  };
}

var LIST_RE = /^([-*+]|\d+[.)])\s+(.*)$/;
var HEADING_RE = /^(#{1,6})\s+(.*)$/;
var FENCE_RE = /^```/;

/**
 * Конвертирует markdown в HTML печатной формы.
 * @param {unknown} md Исходный markdown; не-строка → ''.
 * @returns {string} HTML документа.
 */
export function render(md) {
  if (typeof md !== 'string') return '';
  var lines = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var trimmed = (lines[i] || '').trim();

    // Code-ограждение
    if (FENCE_RE.test(trimmed)) {
      var lang = trimmed.slice(3).trim();
      var codeLines = [];
      i++;
      while (i < lines.length && !FENCE_RE.test((lines[i] || '').trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // закрывающая строка с тремя кавычками
      out.push('<pre' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '') + '>' +
        '<code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
      continue;
    }

    // Заголовок
    var hm = trimmed.match(HEADING_RE);
    if (hm) {
      var level = hm[1].length;
      out.push('<h' + level + '>' + inline(hm[2]) + '</h' + level + '>');
      i++;
      continue;
    }

    // Таблица: строка начинается с | , следующая — разделитель
    if (trimmed.charAt(0) === '|' && isTableSeparator((lines[i + 1] || '').trim())) {
      var tbl = renderTable(lines, i);
      out.push(tbl.html);
      i = tbl.nextIndex;
      continue;
    }

    // Список (ul/ol), включая строки вида "- Метка: текст"
    var lm = trimmed.match(LIST_RE);
    if (lm) {
      var ordered = /\d+[.)]/.test(lm[1]);
      var tag = ordered ? 'ol' : 'ul';
      var items = [];
      while (i < lines.length) {
        var t2 = (lines[i] || '').trim();
        if (t2 === '') break;
        var m2 = t2.match(LIST_RE);
        if (!m2) break;
        items.push('<li>' + inline(m2[2]) + '</li>');
        i++;
      }
      out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
      continue;
    }

    // Пустая строка
    if (trimmed === '') { i++; continue; }

    // Параграф: собираем до пустой строки или начала нового блока
    var paraLines = [lines[i]];
    i++;
    while (i < lines.length) {
      var t3 = (lines[i] || '').trim();
      if (t3 === '') break;
      if (HEADING_RE.test(t3) || FENCE_RE.test(t3)) break;
      if (LIST_RE.test(t3)) break;
      if (t3.charAt(0) === '|' && isTableSeparator((lines[i + 1] || '').trim())) break;
      paraLines.push(lines[i]);
      i++;
    }
    out.push('<p>' + inline(paraLines.join('\n')) + '</p>');
  }
  return out.join('\n');
}

/**
 * Публичный API рендерера (default-экспорт ES-модуля).
 * @typedef {Object} MarkdownRendererApi
 * @property {(md: unknown) => string} render Markdown → HTML.
 * @property {(text: unknown) => string} inline Инлайн-разметка одной строки.
 * @property {(s: unknown) => string} escapeHtml Экранирование HTML-спецсимволов.
 */

/** @type {MarkdownRendererApi} */
var MarkdownRenderer = {
  render: render,
  inline: inline,
  escapeHtml: escapeHtml
};

export default MarkdownRenderer;
