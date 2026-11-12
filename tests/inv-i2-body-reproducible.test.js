'use strict';

/**
 * I2a (ADR-001 / S1.1): каноническое тело воспроизводимо.
 *
 * Инвариант: текст, длина и bodyHash — функции ОДНОГО массива сообщений.
 * Тест намеренно не читает исходники: только поведение публичного модуля.
 */

const {
  canonicalBody,
  canonicalBodyText,
  fnv1a32
} = require('../utils/canonical-body.ts');

describe('I2: каноническое тело', () => {
  test('текст — тексты сообщений через \\n, порядок сохранён', () => {
    const msgs = [
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: 'ответ' },
      { role: 'user', text: 'ещё вопрос' }
    ];
    expect(canonicalBodyText(msgs)).toBe('вопрос\nответ\nещё вопрос');
    expect(canonicalBody('conv-1', msgs).text).toBe('вопрос\nответ\nещё вопрос');
  });

  test('порядок сообщений меняет и текст, и хэш', () => {
    const first = [
      { role: 'user', text: 'первый' },
      { role: 'assistant', text: 'второй' }
    ];
    const reversed = [first[1], first[0]];
    const a = canonicalBody('conv-1', first);
    const b = canonicalBody('conv-1', reversed);
    expect(a.text).not.toBe(b.text);
    expect(a.bodyHash).not.toBe(b.bodyHash);
  });

  test('пустой и отсутствующий текст дают пустые сегменты', () => {
    expect(canonicalBodyText([])).toBe('');
    expect(canonicalBodyText([{}, { text: '' }, { text: null }, { text: undefined }])).toBe('\n\n\n');
    expect(canonicalBodyText(null)).toBe('');
    expect(canonicalBody('conv-1', [{}, { text: '' }]).chars).toBe(1);
  });

  test('chars === text.length, msgs === list.length', () => {
    const msgs = [
      { role: 'user', text: 'Привет' },
      { role: 'assistant', text: '' },
      { role: 'user', text: 'мир' }
    ];
    const body = canonicalBody('conv-1', msgs);
    expect(body.chars).toBe(body.text.length);
    expect(body.chars).toBe(11);
    expect(body.msgs).toBe(msgs.length);
    expect(body.messages).toBe(msgs);
  });

  test('роль участвует в хэше, но не в тексте', () => {
    const asUser = canonicalBody('conv-1', [{ role: 'user', text: 'одинаковый текст' }]);
    const asAssistant = canonicalBody('conv-1', [{ role: 'assistant', text: 'одинаковый текст' }]);
    expect(asUser.text).toBe(asAssistant.text);
    expect(asUser.chars).toBe(asAssistant.chars);
    expect(asUser.bodyHash).not.toBe(asAssistant.bodyHash);
  });

  test('convId участвует в хэше', () => {
    const msgs = [{ role: 'user', text: 'одинаковый текст' }];
    const a = canonicalBody('conv-1', msgs);
    const b = canonicalBody('conv-2', msgs);
    expect(a.text).toBe(b.text);
    expect(a.bodyHash).not.toBe(b.bodyHash);
  });

  test('одинаковый вход воспроизводит тот же bodyHash', () => {
    const msgs = [{ role: 'user', text: 'а' }, { role: 'assistant', text: 'б' }];
    const a = canonicalBody('conv-1', msgs);
    const b = canonicalBody('conv-1', msgs.map(function (m) { return { role: m.role, text: m.text }; }));
    expect(a.bodyHash).toBe(b.bodyHash);
    expect(a.text).toBe(b.text);
    expect(a.chars).toBe(b.chars);
    expect(a.msgs).toBe(b.msgs);
  });

  test('bodyHash — <8 hex>:<chars>', () => {
    const body = canonicalBody('conv-1', [{ role: 'user', text: 'abc' }]);
    expect(body.bodyHash).toMatch(/^[0-9a-f]{8}:3$/);
  });

  test('fnv1a32 детерминирован и различает строки', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('a')).toBe(fnv1a32('a'));
    expect(fnv1a32('a')).not.toBe(fnv1a32('b'));
  });
});
