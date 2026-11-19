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

// BIG-04 (2.1.5): vf5-cursor-continue приносит уже принятую пару с другим r-id.
// Дедуп по содержимому пары (не по id), но только в хвосте базы.
const pairDedupe = new Function(
  fn('aiCmGeminiPairHash') + '\n' + fn('aiCmGeminiPairDedupe') + '\nreturn aiCmGeminiPairDedupe;'
)();

describe('BIG-04: дедуп пары user+assistant по содержимому (Gemini)', () => {
  const base = [
    { id: 'r_prev_u', role: 'user', text: 'Продолжай' },
    { id: 'r_prev_a', role: 'assistant', text: 'Продолжение ответа' },
    { id: 'r_ctrl_u', role: 'user', text: 'Контроль 2.1.5: ответь одним словом OK' },
    { id: 'r_ctrl_a', role: 'assistant', text: 'OK' }
  ];

  test('копия пары с другим id не добавляется', () => {
    const incoming = [
      { id: 'r_prev_u2', role: 'user', text: 'Продолжай' },
      { id: 'r_prev_a2', role: 'assistant', text: 'Продолжение ответа' },
      { id: 'r_copy_u', role: 'user', text: 'Контроль 2.1.5: ответь одним словом OK' },
      { id: 'r_copy_a', role: 'assistant', text: 'OK' }
    ];
    const out = pairDedupe(base, incoming);
    // Всё окно — повторная ингестия: дублируются и «Продолжай», и контроль-пара.
    expect(out.skipped).toBe(4);
    expect(out.skip.r_copy_u).toBe(1);
    expect(out.skip.r_copy_a).toBe(1);
    expect(out.skip.r_prev_u2).toBe(1);
    expect(out.skip.r_prev_a2).toBe(1);
  });

  test('другой ответ — не дубль', () => {
    const incoming = [
      { id: 'r_new_u', role: 'user', text: 'Контроль 2.1.5: ответь одним словом OK' },
      { id: 'r_new_a', role: 'assistant', text: 'OK!' }
    ];
    const out = pairDedupe(base, incoming);
    expect(out.skipped).toBe(0);
  });

  test('одинаковый вопрос с разными ответами сохраняется', () => {
    const incoming = [
      { id: 'r_test_u', role: 'user', text: 'Test.' },
      { id: 'r_test_a', role: 'assistant', text: 'Systems operational.' }
    ];
    const out = pairDedupe(base, incoming);
    expect(out.skipped).toBe(0);
  });

  test('вне хвоста базы (старше 16) не дедуплицируется', () => {
    const old = [
      { id: 'r_old_u', role: 'user', text: 'Контроль 2.1.5: ответь одним словом OK' },
      { id: 'r_old_a', role: 'assistant', text: 'OK' }
    ];
    const filler = [];
    for (let i = 0; i < 16; i++) {
      filler.push({ id: 'f' + i, role: i % 2 ? 'assistant' : 'user', text: 'fill ' + i });
    }
    const out = pairDedupe(old.concat(filler), [
      { id: 'r_re_u', role: 'user', text: 'Контроль 2.1.5: ответь одним словом OK' },
      { id: 'r_re_a', role: 'assistant', text: 'OK' }
    ]);
    expect(out.skipped).toBe(0);
  });

  test('пустой текст не участвует', () => {
    const out = pairDedupe(base, [
      { id: 'e1', role: 'user', text: '   ' },
      { id: 'e2', role: 'assistant', text: '' }
    ]);
    expect(out.skipped).toBe(0);
  });
});
