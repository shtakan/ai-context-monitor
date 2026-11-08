/**
 * S5-исключение: ассистентский ход, у которого после удаления секций [REASONING]/[ANSWER]
 * текст ответа пуст, но поле reasoning непустое, НЕ выбрасывается из экспорта.
 *
 * ЖИВОЙ ДЕФЕКТ (Firefox): live-ход финализировался с пустым answer, но с цепочкой
 * размышлений — текст хода = '[REASONING]\n<chain>\n\n[ANSWER]\n'. OFF-путь O-7 урезает
 * секции до части [ANSWER] → текст становится ''; прежний S5 снимал сообщение целиком →
 * последнее сообщение терялось (шаг 2).
 *
 * ПРАВИЛО: S5 не снимает ход, если role === 'assistant' и message.reasoning.trim() !== ''.
 * Поле захвата hiddenReasoning НЕ в счёт: stripHiddenFields снимает его ДО S5, и OFF-путь
 * намеренно исключает скрытый reasoning. Пустой user-ход с reasoning по-прежнему снимается
 * (роль обязательна), пустой ассистентский ход БЕЗ reasoning — тоже (машинный мусор).
 */

const P = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.ts');

const CHAIN = 'Сначала проверяю аргументы, затем собираю историю и замечаю гонку пустого ответа.';
// Ровно форма composeTurnText при пустом answer: секции есть, части [ANSWER] нет.
const REASONING_ONLY_TEXT = '[REASONING]\n' + CHAIN + '\n\n[ANSWER]\n';
const EMPTY_TEXT = '';

function sanitize(messages) {
  return P.sanitizeEmitMessages(messages);
}

describe('S5: reasoning-only assistant-ход не выпадает из экспорта', () => {
  test('ход с секциями [REASONING] и пустым [ANSWER] остаётся (текст урезан, reasoning цел)', () => {
    const msg = { role: 'assistant', text: REASONING_ONLY_TEXT, reasoning: CHAIN };
    const res = sanitize([msg]);
    expect(res.dropped).toBe(0);
    expect(res.messages).toHaveLength(1);
    // секции урезаны OFF-путём, ответ пуст — но ход не снят
    expect(res.messages[0].text).toBe(EMPTY_TEXT);
    // reasoning доехал до выхода: это и есть содержимое хода
    expect(res.messages[0].reasoning).toBe(CHAIN);
    expect(res.messages[0].role).toBe('assistant');
  });

  test('ход с пустым текстом и непустым reasoning остаётся', () => {
    const res = sanitize([{ role: 'assistant', text: '', reasoning: 'рассуждение' }]);
    expect(res.dropped).toBe(0);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].text).toBe('');
    expect(res.messages[0].reasoning).toBe('рассуждение');
  });

  test('смешанный массив: пустой ассистентский ход с reasoning не сдвигает остальные', () => {
    const res = sanitize([
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: REASONING_ONLY_TEXT, reasoning: CHAIN },
      { role: 'assistant', text: 'финальный ответ' }
    ]);
    expect(res.dropped).toBe(0);
    expect(res.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'assistant']);
    expect(res.messages[0].text).toBe('вопрос');
    expect(res.messages[1].text).toBe('');
    expect(res.messages[1].reasoning).toBe(CHAIN);
    expect(res.messages[2].text).toBe('финальный ответ');
  });

  test('контроль: пустой ассистентский ход БЕЗ reasoning по-прежнему снимается', () => {
    const res = sanitize([{ role: 'assistant', text: '' }]);
    expect(res.dropped).toBe(1);
    expect(res.messages).toHaveLength(0);
  });

  test('контроль: reasoning из одних пробелов не удерживает пустой ход', () => {
    const res = sanitize([{ role: 'assistant', text: '', reasoning: '   \n\t ' }]);
    expect(res.dropped).toBe(1);
    expect(res.messages).toHaveLength(0);
  });

  test('контроль: пустой USER-ход с reasoning снимается (роль обязательна)', () => {
    const res = sanitize([{ role: 'user', text: '', reasoning: 'не пользовательский reasoning' }]);
    expect(res.dropped).toBe(1);
    expect(res.messages).toHaveLength(0);
  });

  test('контроль: роль не assistant (unknown) с reasoning — ход не удерживается', () => {
    const res = sanitize([{ role: 'unknown', text: '', reasoning: 'r' }]);
    expect(res.dropped).toBe(1);
    expect(res.messages).toHaveLength(0);
  });

  test('hidden-поле захвата не удерживает ход: stripHiddenFields снимает hiddenReasoning', () => {
    const res = sanitize([{ role: 'assistant', text: '', hiddenReasoning: 'скрытое размышление' }]);
    expect(res.dropped).toBe(1);
    expect(res.messages).toHaveLength(0);
  });

  test('непустой ход возвращается тем же объектом (идентичность O-20 не нарушена)', () => {
    const msg = { role: 'assistant', text: 'обычный ответ без секций', reasoning: 'r' };
    const res = sanitize([msg]);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]).toBe(msg);
    expect(res.dropped).toBe(0);
  });

  test('пустой текст без reasoning по-прежнему «пуст» для isEmptyExportText', () => {
    // сама предикатная функция не менялась — исключение живёт в условии S5
    expect(P.isEmptyExportText('')).toBe(true);
    expect(P.isEmptyExportText('  \n\t ')).toBe(true);
    expect(P.isEmptyExportText('x')).toBe(false);
  });
});
