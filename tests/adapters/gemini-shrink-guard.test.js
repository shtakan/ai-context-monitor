/**
 * v1.14.1 (SHRINK-GUARD): сетевой ход НЕ затирает restored-ход того же id, если его
 * текст короче. Ответы сервера для старых чатов бывают обрезанными («РЕНТГЕН
 * ОБОРВАВШЕГО ШАГА»): пагинация возвращала одни и те же 20 свежих ходов с усечёнными
 * текстами, и безгардовое замещение сжимало базу (textLen 147811→124495 при том же
 * числе ходов) — баг неполного экспорта чата e292103e (2026-09-02).
 *
 * Решение вынесено в чистый хелпер GeminiInterceptLogic.decideRestoredMerge(prev, incoming),
 * который используется в core/gemini-intercept.js (ingest по pageMode==='restored').
 *
 * Проверяем:
 *   а) входящий текст длиннее → replace;
 *   б) входящий текст той же длины → replace;
 *   в) входящий текст короче → keep + дозаполнение r1/turnId, когда их не было;
 *   г) при коротком входящем существующие r1/turnId НЕ перетираются;
 *   д) null/пустые тексты → без исключений;
 *   е) core реально вызывает хелпер.
 */
const path = require('path');
const fs = require('fs');

const GIL = require('../../utils/gemini-intercept-logic.js');

describe('Gemini v1.14.1 SHRINK-GUARD: decideRestoredMerge не даёт сжать базу', () => {
  test('входящий длиннее → replace', () => {
    const d = GIL.decideRestoredMerge(
      { text: 'короткий', r1: 'r1-old', turnId: 't-old' },
      { text: 'полный длинный текст хода', r1: 'r1-new', turnId: 't-new' }
    );
    expect(d.replace).toBe(true);
  });

  test('входящий той же длины → replace (идентичный повтор не ломает базу)', () => {
    const d = GIL.decideRestoredMerge(
      { text: 'abcd', r1: null },
      { text: 'abcd', r1: 'r1-new' }
    );
    expect(d.replace).toBe(true);
  });

  test('входящий короче → keep, дозаполняются пустые r1/turnId', () => {
    const d = GIL.decideRestoredMerge(
      { text: 'полный длинный текст хода', r1: null, turnId: null },
      { text: 'abc', r1: 'r1-net', turnId: 't-net' }
    );
    expect(d.replace).toBe(false);
    expect(d.r1).toBe('r1-net');
    expect(d.turnId).toBe('t-net');
  });

  test('входящий короче → существующие r1/turnId НЕ перетираются', () => {
    const d = GIL.decideRestoredMerge(
      { text: 'полный длинный текст хода', r1: 'r1-old', turnId: 't-old' },
      { text: 'abc', r1: 'r1-net', turnId: 't-net' }
    );
    expect(d.replace).toBe(false);
    expect(d.r1).toBeNull();
    expect(d.turnId).toBeNull();
  });

  test('пустой входящий при пустом restored → replace (равные длины)', () => {
    const d = GIL.decideRestoredMerge({ text: '' }, { text: '' });
    expect(d.replace).toBe(true);
  });

  test('null-входы → без исключений, короткий входящий не замещает', () => {
    expect(() => GIL.decideRestoredMerge(null, null)).not.toThrow();
    const d = GIL.decideRestoredMerge({ text: 'длинный restored текст' }, null);
    expect(d.replace).toBe(false);
  });

  test('core/gemini-intercept.js реально гейтит restored-merge через decideRestoredMerge', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
      'utf8'
    );
    expect(src).toContain('decideRestoredMerge');
    expect(src).toContain('shrink-guard kept-restored');
  });
});
