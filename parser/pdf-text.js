// parser/pdf-text.js — чистые функции сборки текста из pdf.js.
//
// Файл не зависит от pdf.js и от DOM: его грузят и offscreen-документ Chrome
// (parser/offscreen.html), и event page Firefox (manifest background.scripts),
// и Node-тесты. Контракт: window/self.AiCmPdfText + module.exports.
//
// Зачем отдельный файл: раскладка «items → текст» — единственное место, где
// теряется или дублируется содержимое PDF, и она обязана быть покрыта юнит-тестами
// без воркера pdf.js. Рендеринг/шрифты сюда не входят (disableFontFace: true).
(function (root) {
  'use strict';

  // Жёсткий кап хоста: провайдер просит меньше (200 000), но хост не отдаёт больше
  // 400 000 символов ни при каких параметрах — защита от «PDF на 500 страниц».
  var HARD_CAP = 400000;
  var MAX_PAGES_DEFAULT = 500;
  var LINE_GAP = 2;      // px: сдвиг baseline больше — новая строка
  var WORD_GAP = 1;      // px: разрыв больше — пробел между item'ами

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  function num(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  // Пробел между соседними item'ами нужен не всегда: pdf.js отдаёт куски строки
  // без пробелов, а сами пробелы уже входят в str. Решение принимается по трём
  // признакам: конец/начало строки, разрыв по x и пунктуация.
  function needsSpace(prevStr, nextStr, gap) {
    if (!prevStr || !nextStr) return false;
    if (/\s$/.test(prevStr) || /^\s/.test(nextStr)) return false;
    if (/^[.,;:!?)\]}]/.test(nextStr)) return false;
    if (/[(\[{]$/.test(prevStr)) return false;
    return gap > WORD_GAP;
  }

  function itemGap(prev, item) {
    if (!prev || !prev.transform || !item || !item.transform) return 0;
    var prevEnd = prev.transform[4] + (typeof prev.width === 'number' ? prev.width : 0);
    var nextStart = item.transform[4];
    if (typeof prevEnd !== 'number' || typeof nextStart !== 'number') return 0;
    return nextStart - prevEnd;
  }

  function itemY(item) {
    if (!item || !item.transform || typeof item.transform[5] !== 'number') return null;
    return item.transform[5];
  }

  // items одной страницы → текст. Перевод строки: hasEOL (pdf.js 4) либо сдвиг
  // baseline больше LINE_GAP. Между строками пробелы не копятся.
  function itemsToText(items) {
    if (!Array.isArray(items)) return '';
    var out = '';
    var prev = null;
    var prevY = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.str !== 'string' || it.str === '') continue;
      var y = itemY(it);
      // hasEOL помечает item, который ЗАВЕРШАЕТ строку, поэтому перевод строки
      // ставится перед следующим куском, а не перед текущим.
      var newLine = (prev !== null && prev.hasEOL === true) ||
        (prevY !== null && y !== null && Math.abs(y - prevY) > LINE_GAP);
      if (newLine) {
        if (out && out.charAt(out.length - 1) !== '\n') out += '\n';
      } else if (prev && needsSpace(prev.str, it.str, itemGap(prev, it))) {
        out += ' ';
      }
      out += it.str;
      if (y !== null) prevY = y;
      prev = it;
    }
    return out;
  }

  // Нормализация: CRLF → LF, хвостовые пробелы, не больше одной пустой строки.
  function cleanText(text) {
    var t = str(text).replace(/\r\n?/g, '\n');
    t = t.replace(/[ \t]+\n/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    t = t.replace(/^\n+/, '');
    return t.replace(/\s+$/, '');
  }

  // Жёсткий кап вместе с пометкой об обрезке: длина результата НЕ превышает limit.
  function capText(text, maxChars) {
    var limit = num(maxChars) || HARD_CAP;
    if (limit > HARD_CAP) limit = HARD_CAP;
    var s = str(text);
    if (s.length <= limit) return { text: s, truncated: false, cut: 0 };
    var cut = s.length - limit;
    var suffix = '\n…[обрезано ' + cut + ']';
    var keep = limit - suffix.length;
    if (keep < 0) keep = 0;
    return { text: s.slice(0, keep) + suffix, truncated: true, cut: cut };
  }

  // Страница может прийти как строка, как массив items или как { text } / { items }.
  function pageToText(page) {
    if (typeof page === 'string') return page;
    if (Array.isArray(page)) return itemsToText(page);
    if (page && typeof page === 'object') {
      if (typeof page.text === 'string') return page.text;
      if (Array.isArray(page.items)) return itemsToText(page.items);
    }
    return '';
  }

  // Страницы → { text, pages, truncated }. Порог maxPages обрезает И текст, И обход:
  // результат помечается truncated, чтобы потребитель не считал PDF прочитанным целиком.
  function collectPages(pages, opts) {
    var o = opts || {};
    var maxChars = num(o.maxChars) || HARD_CAP;
    if (maxChars > HARD_CAP) maxChars = HARD_CAP;
    var maxPages = num(o.maxPages) || MAX_PAGES_DEFAULT;
    var list = Array.isArray(pages) ? pages : [];
    var limit = Math.min(list.length, maxPages);
    var parts = [];
    var used = 0;
    var done = 0;
    for (var i = 0; i < limit; i++) {
      var pageText = cleanText(pageToText(list[i]));
      done++;
      if (pageText === '') continue;
      if (used > 0) used += 1; // разделитель '\n'
      parts.push(pageText);
      used += pageText.length;
      if (used >= maxChars) break;
    }
    var capped = capText(parts.join('\n'), maxChars);
    var truncated = capped.truncated || done < list.length || list.length > maxPages;
    return { text: capped.text, pages: done, truncated: truncated };
  }

  var api = {
    HARD_CAP: HARD_CAP,
    MAX_PAGES: MAX_PAGES_DEFAULT,
    itemsToText: itemsToText,
    cleanText: cleanText,
    capText: capText,
    pageToText: pageToText,
    collectPages: collectPages
  };

  root.AiCmPdfText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof self !== 'undefined' ? self : globalThis));
