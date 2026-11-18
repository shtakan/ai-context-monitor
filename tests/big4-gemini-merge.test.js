'use strict';

/**
 * BIG-04 (2.1.5): один ответ Gemini = один assistant-блок.
 * DSH подтвердил: DOM=1 контейнер ответа на ход, файл 2.1.4 = 6 assistant.
 * Фикс — склейка подряд идущих сегментов одной роли в ingest.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'gemini-ingest.js'), 'utf8');

function fn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('BIG-04: в core/gemini-ingest.js нет function ' + name + '(');
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('BIG-04: unbalanced declaration: ' + name);
}

const merge = new Function(fn('aiCmMergeTurnSegments') + '\nreturn aiCmMergeTurnSegments;')();

describe('BIG-04: склейка сегментов хода Gemini', () => {
  test('несколько assistant подряд → один assistant с разделителем', () => {
    const out = merge([
      { role: 'assistant', text: 'Первый слой.' },
      { role: 'assistant', text: 'Второй слой.' },
      { role: 'assistant', text: 'Третий слой.' }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(out[0].text).toBe('Первый слой.\n\nВторой слой.\n\nТретий слой.');
  });

  test('user + несколько assistant → ровно два сообщения', () => {
    const out = merge([
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: 'A' },
      { role: 'assistant', text: 'B' }
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[1].text).toBe('A\n\nB');
  });

  test('пустые и whitespace-сегменты отбрасываются', () => {
    const out = merge([
      { role: 'assistant', text: '  ' },
      { role: 'assistant', text: 'A' },
      { role: 'assistant', text: '' }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('A');
  });

  test('не-массив возвращается как есть', () => {
    expect(merge(null)).toBe(null);
    expect(merge([])).toEqual([]);
  });
});
