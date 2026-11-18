'use strict';

/**
 * BIG-03 (2.1.5): запись истории получает идентичность треда.
 * До фикса сетевой путь писал convId=(none), и provenance-гард читателя
 * (histConvId !== cid) не срабатывал.
 */

const { contentSource } = require('./helpers/content-source.js');

const SRC = contentSource;

function fn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('BIG-03: в core/content.ts нет function ' + name + '(');
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('BIG-03: unbalanced declaration: ' + name);
}

function make(canonical, fromUrl) {
  return new Function('aiCmCanonicalConvId', 'getCurrentConvId',
    fn('aiCmHistoryConvId') + '\nreturn aiCmHistoryConvId();')(canonical, fromUrl);
}

describe('BIG-03: aiCmHistoryConvId', () => {
  test('канонический id приоритетнее URL', () => {
    expect(make(() => 'thread-1', () => 'url-1')).toBe('thread-1');
  });

  test('без канонического — fallback на URL', () => {
    expect(make(() => '', () => 'url-1')).toBe('url-1');
  });

  test('оба пустые — пустая строка (не выдумываем)', () => {
    expect(make(() => '', () => '')).toBe('');
  });

  test('функции недоступны — пустая строка', () => {
    expect(make(undefined, undefined)).toBe('');
  });
});
