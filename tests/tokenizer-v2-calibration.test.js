/**
 * 2026-11-23: экспериментальная линейная калибровка Tokenizer v2.
 *
 * 14 чистых точек Gemini (9 обычных + Unicode/цифровой + 3 плотные таблицы).
 * Кандидат без CONST: CYR 3.9343, LATIN 3.8414, DIGIT 0.7959, PUNCT 0.7205,
 * OTHER 1.0741. CONST=0, иначе короткие тексты уходили в ноль.
 * Production-путь НЕ переключён: `Tokenizer.countTokens` по-прежнему 3.3/4/3/0.43/1.
 *
 * Replay фиксирует, что линейная модель воспроизводит exact на всех 14 точках
 * (MAPE < 3 %, max < 7 %). Живая проверка и переключение — отдельным шагом.
 */

const T = require('./helpers/load-esm.js').loadEsmModule('utils/tokenizer.ts');
const DATA = require('./fixtures/tokenizer-calibration-14.json');

function errorPct(pred, exact) {
  return Math.abs(pred - exact) / exact;
}

describe('Tokenizer v2: линейная калибровка по 14 точкам', () => {
  test('production-путь не переключён: старые константы на месте', () => {
    expect(T.Tokenizer.CYRILLIC_CHARS_PER_TOKEN).toBe(3.3);
    expect(T.TOKENIZER_V2.CYRILLIC_CHARS_PER_TOKEN).toBeCloseTo(3.9343, 4);
    expect(T.TOKENIZER_V2.DIGIT_CHARS_PER_TOKEN).toBeCloseTo(0.7959, 4);
    expect(T.TOKENIZER_V2.CONST_TOKENS).toBe(0);
  });

  test('replay 14 точек: MAPE < 3 %, максимум < 7 %', () => {
    expect(DATA.points.length).toBe(14);
    const errors = DATA.points.map((p) => {
      const pred = T.estimateTokensFromFeatures({
        cyr: p.cyr, latin: p.latin, digit: p.digit,
        cjk: p.cjk, punct: p.punct, other: p.other
      });
      return errorPct(pred, p.exact);
    });
    const mape = errors.reduce((a, b) => a + b, 0) / errors.length;
    const max = Math.max(...errors);
    expect(mape).toBeLessThan(0.03);
    expect(max).toBeLessThan(0.07);
  });

  test('countTokensV2 считает по тем же классам и не уходит в минус', () => {
    expect(T.countTokensV2('')).toBe(0);
    expect(T.countTokensV2('     ')).toBe(0);
    expect(T.countTokensV2('Привет, мир!')).toBeGreaterThan(0);
    // Линейная модель не должна давать отрицательных значений на коротком тексте.
    expect(T.countTokensV2('a')).toBeGreaterThanOrEqual(0);
  });

  test('replay-точки покрывают и прозу, и плотные таблицы', () => {
    const hasProse = DATA.points.some((p) => p.digit / p.chars < 0.02);
    const hasTable = DATA.points.some((p) => p.digit / p.chars > 0.25);
    expect(hasProse).toBe(true);
    expect(hasTable).toBe(true);
  });
});
