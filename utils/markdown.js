/**
 * Лёгкий markdown в HTML конвертер для печатной формы (экспорт PDF).
 * Чистая логика, без зависимостей от DOM или браузера:
 *   - работает в браузере (window.MarkdownRenderer) и в Node (module.exports).
 *
 * Поддерживает: заголовки от H1 до H6, жирный (двойные звёздочки), курсив
 * (одинарные звёздочки или подчёркивания), инлайн-код, ссылки [text](url),
 * списки (в том числе строки вида "- Метка: текст"), markdown-таблицы
 * (строки с разделителем) и code-ограждения из трёх обратных кавычек.
 * Остальной текст экранируется: HTML не проходит. Кириллица не страдает.
 */

(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&' + 'amp;')
      .replace(/</g, '&' + 'lt;')
      .replace(/>/g, '&' + 'gt;')
      .replace(/"/g, '&' + 'quot;');
  }

  // Инлайн-разметка: инлайн-код, жирный, курсив, ссылки.
  // Работает на уже экранированной строке (HTML не может пролезть внутрь).
  function inline(text) {
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

  // Строка-разделитель таблицы: только | - : и пробелы, содержит хотя бы один минус
  function isTableSeparator(line) {
    if (!line) return false;
    var c = line.charAt(0);
    if (c !== '|' && c !== '-' && c !== ':') return false;
    return /^[\s|:—-]+$/.test(line) && /-/.test(line);
  }

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

  // Собирает таблицу, начиная со строки lines[i] (содержит | и есть разделитель ниже).
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

  function renderMarkdown(md) {
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

  var MarkdownRenderer = {
    render: renderMarkdown,
    inline: inline,
    escapeHtml: escapeHtml
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MarkdownRenderer;
  if (typeof window !== 'undefined') window.MarkdownRenderer = MarkdownRenderer;
})();