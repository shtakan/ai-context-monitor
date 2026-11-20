'use strict';

/**
 * K1/K2 приёмки 2.2: каноническое равенство экспортов и roleHash.
 * Тест не читает исходники продукта — только чистые функции tools/accept-compare.js.
 */

const {
  compareExports,
  roleHashOf,
  stripFields,
  stableStringify
} = require('../tools/accept-compare.js');

function baseExport() {
  return {
    platform: 'aistudio',
    model: 'Gemini 3.8 Flash',
    exportedAt: '2026-11-20T06:25:21.943Z',
    tokens: 43384,
    messages: [
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: 'ответ' },
      { role: 'user', text: 'ещё вопрос' },
      { role: 'assistant', text: 'ещё ответ' }
    ]
  };
}

describe('accept-compare: K1/K2', () => {
  test('exportedAt игнорируется: K1 и K2 равны', function () {
    const a = baseExport();
    const b = baseExport();
    b.exportedAt = '2026-11-20T07:03:52.099Z';
    const result = compareExports(a, b);
    expect(result.k1).toBe(true);
    expect(result.k2).toBe(true);
    expect(result.firstDiff).toBeNull();
    expect(result.sha256.a).toBe(result.sha256.b);
  });

  test('сдвиг ролей: K1 и K2 падают, roleHash различается', function () {
    const a = baseExport();
    const b = baseExport();
    b.messages[1].role = 'user';
    const result = compareExports(a, b);
    expect(result.k1).toBe(false);
    expect(result.k2).toBe(false);
    expect(result.roles.hashA).not.toBe(result.roles.hashB);
    expect(result.firstDiff).toContain('messages[1].role');
  });

  test('добавленное сообщение: падают оба критерия', function () {
    const a = baseExport();
    const b = baseExport();
    b.messages.push({ role: 'user', text: 'лишнее' });
    const result = compareExports(a, b);
    expect(result.k1).toBe(false);
    expect(result.k2).toBe(false);
    expect(result.messages).toEqual({ a: 4, b: 5 });
  });

  test('roleHash зависит только от последовательности ролей', function () {
    const a = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }];
    const b = [{ role: 'user', text: 'совсем другой' }, { role: 'assistant', text: 'текст' }];
    const c = [{ role: 'assistant', text: 'a' }, { role: 'user', text: 'b' }];
    expect(roleHashOf(a)).toBe(roleHashOf(b));
    expect(roleHashOf(a)).not.toBe(roleHashOf(c));
  });

  test('roleReport одного экспорта (--role-hash): счётчики и хэш', function () {
    const { roleReport } = require('../tools/accept-compare.js');
    const doc = baseExport();
    expect(roleReport(doc)).toEqual({
      messages: 4,
      user: 2,
      assistant: 2,
      roleHash: roleHashOf(doc.messages)
    });
  });

  test('stripFields/stableStringify не зависят от порядка ключей', function () {
    const a = { x: 1, y: { b: 2, a: 1 }, exportedAt: 'a' };
    const b = { y: { a: 1, b: 2 }, x: 1, exportedAt: 'b' };
    expect(stableStringify(stripFields(a, ['exportedAt']))).toBe(stableStringify(stripFields(b, ['exportedAt'])));
  });
});
