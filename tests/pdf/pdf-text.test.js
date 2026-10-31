'use strict';

// Чистые функции сборки текста (parser/pdf-text.js) — грузятся и в offscreen
// Chrome, и в event page Firefox, и в Node. Тесты фиксируют контракт
// «items → текст», который иначе проверяется только живым pdf.js.

const path = require('path');

const T = require(path.join(__dirname, '..', '..', 'parser', 'pdf-text.js'));

function item(str, x, y, extra) {
  return Object.assign({
    str: str,
    width: 20,
    transform: [1, 0, 0, 1, x, y],
    hasEOL: false
  }, extra || {});
}

describe('pdf-text: items → текст страницы', () => {
  test('куски одной строки склеиваются пробелом по разрыву x', () => {
    const text = T.itemsToText([item('Hello', 0, 100), item('world', 30, 100)]);
    expect(text).toBe('Hello world');
  });

  test('hasEOL начинает новую строку, сдвиг baseline больше 2px — тоже', () => {
    const byEol = T.itemsToText([
      item('first', 0, 100, { hasEOL: true }),
      item('second', 0, 100)
    ]);
    expect(byEol).toBe('first\nsecond');

    const byGap = T.itemsToText([item('top', 0, 100), item('bottom', 0, 88)]);
    expect(byGap).toBe('top\nbottom');
  });

  test('пунктуация не отрывается пробелом, открывающая скобка тоже', () => {
    expect(T.itemsToText([item('Итого', 0, 100, { width: 40 }), item('.', 60, 100)]))
      .toBe('Итого.');
    expect(T.itemsToText([item('(', 0, 100, { width: 4 }), item('x)', 30, 100)]))
      .toBe('(x)');
  });

  test('пустые и нестроковые items пропускаются, не-массив даёт пустую строку', () => {
    expect(T.itemsToText([
      null,
      { width: 1, transform: [1, 0, 0, 1, 0, 0] },
      { str: '', transform: [1, 0, 0, 1, 0, 0] },
      item('живой', 0, 100)
    ])).toBe('живой');
    expect(T.itemsToText(null)).toBe('');
    expect(T.itemsToText('строка')).toBe('');
  });
});

describe('pdf-text: нормализация и кап', () => {
  test('cleanText переводит CRLF в LF и схлопывает пустые строки', () => {
    expect(T.cleanText('a  \r\n\r\n\r\nb')).toBe('a\n\nb');
    expect(T.cleanText('\n\nтекст   ')).toBe('текст');
    expect(T.cleanText('')).toBe('');
  });

  test('capText обрезает по лимиту и помечает обрезку', () => {
    const full = 'x'.repeat(300);
    const capped = T.capText(full, 200);
    expect(capped.truncated).toBe(true);
    expect(capped.cut).toBe(100);
    expect(capped.text.length).toBe(200);
    expect(capped.text).toContain('обрезано 100');

    const small = T.capText('коротко', 200);
    expect(small).toEqual({ text: 'коротко', truncated: false, cut: 0 });
  });

  test('capText не отдаёт больше жёсткого капа хоста', () => {
    const long = 'y'.repeat(500000);
    const capped = T.capText(long, 10000000);
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(T.HARD_CAP);
  });

  test('pageToText понимает строку, массив items, {text} и {items}', () => {
    expect(T.pageToText('готовая строка')).toBe('готовая строка');
    expect(T.pageToText([item('a', 0, 100)])).toBe('a');
    expect(T.pageToText({ text: 'из поля text' })).toBe('из поля text');
    expect(T.pageToText({ items: [item('b', 0, 100)] })).toBe('b');
    expect(T.pageToText(null)).toBe('');
    expect(T.pageToText({})).toBe('');
  });
});

describe('pdf-text: страницы → документ', () => {
  test('страницы склеиваются переводом строки', () => {
    const res = T.collectPages(['Первая', 'Вторая'], {});
    expect(res).toEqual({ text: 'Первая\nВторая', pages: 2, truncated: false });
  });

  test('maxPages обрезает обход и помечает результат', () => {
    const res = T.collectPages(['1', '2', '3'], { maxPages: 2 });
    expect(res.pages).toBe(2);
    expect(res.text).toBe('1\n2');
    expect(res.truncated).toBe(true);
  });

  test('maxChars обрезает текст и помечает результат', () => {
    const res = T.collectPages(['a'.repeat(120), 'b'.repeat(120)], { maxChars: 100 });
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(100);
  });

  test('скан без текстового слоя даёт пустой текст без обрезки', () => {
    const res = T.collectPages(['', null, { items: [] }], {});
    expect(res.text).toBe('');
    expect(res.pages).toBe(3);
    expect(res.truncated).toBe(false);
  });

  test('не-массив страниц — пустой результат', () => {
    expect(T.collectPages(null, {})).toEqual({ text: '', pages: 0, truncated: false });
  });
});
