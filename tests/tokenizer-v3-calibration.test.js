/**
 * 2026-11-24: production-токенизатор переключён на линейную калибровку v3.
 *
 * 18 чистых точек Gemini countTokens: 9 обычных чатов, полный Unicode-чат,
 * 4 плотные таблицы и 4 чата с высокой долей кириллицы (18_62 + 18_63a/b/c).
 * Свободный член 0, округление одно — в конце.
 *
 * Константы: CYR 3.58, LATIN 4.611, DIGIT 0.8045, PUNCT 0.78665,
 * OTHER 1.07511, CJK 1.8 (нет данных).
 *
 * Replay: MAPE < 4 %, max < 8 %. Holdout 18_62 @ 5.3K — < 6 %.
 * Старая эвристика на этих же точках давала MAPE 12.42 %, max 44.18 %.
 */

const T = require('./helpers/load-esm.js').loadEsmModule('utils/tokenizer.ts');
const DATA = require('./fixtures/tokenizer-calibration-18.json');

function errorPct(pred, exact) {
  return Math.abs(pred - exact) / exact;
}

describe('Tokenizer v3: production-калибровка по 18 точкам', () => {
  test('production-константы v3 на месте', () => {
    expect(T.Tokenizer.CYRILLIC_CHARS_PER_TOKEN).toBeCloseTo(3.58, 4);
    expect(T.TOKENIZER_V3.CYRILLIC_CHARS_PER_TOKEN).toBeCloseTo(3.58, 4);
    expect(T.TOKENIZER_V3.LATIN_CHARS_PER_TOKEN).toBeCloseTo(4.611, 3);
    expect(T.TOKENIZER_V3.DIGIT_CHARS_PER_TOKEN).toBeCloseTo(0.8045, 4);
    expect(T.TOKENIZER_V3.PUNCT_TOKENS_PER_CHAR).toBeCloseTo(0.78665, 4);
    expect(T.TOKENIZER_V3.OTHER_TOKENS_PER_CHAR).toBeCloseTo(1.07511, 4);
    expect(T.TOKENIZER_V3.CONST_TOKENS).toBe(0);
  });

  test('replay 18 точек: MAPE < 4 %, максимум < 8 %', () => {
    expect(DATA.points.length).toBe(18);
    const errors = DATA.points.map((p) => {
      const pred = T.estimateTokensFromFeatures({
        cyr: p.cyr, latin: p.latin, digit: p.digit,
        cjk: p.cjk, punct: p.punct, other: p.other
      });
      return errorPct(pred, p.exact);
    });
    const mape = errors.reduce((a, b) => a + b, 0) / errors.length;
    const max = Math.max(...errors);
    expect(mape).toBeLessThan(0.04);
    expect(max).toBeLessThan(0.08);
  });

  test('holdout 18_62 @ 5.3K: ошибка < 6 %', () => {
    expect(DATA.holdout.length).toBe(1);
    const p = DATA.holdout[0];
    const pred = T.estimateTokensFromFeatures({
      cyr: p.cyr, latin: p.latin, digit: p.digit,
      cjk: p.cjk, punct: p.punct, other: p.other
    });
    expect(errorPct(pred, p.exact)).toBeLessThan(0.06);
  });

  test('countTokens — та же линейная модель, без per-run ceil', () => {
    expect(T.countTokens('')).toBe(0);
    expect(T.countTokens('     ')).toBe(0);
    expect(T.countTokens('Привет, мир!')).toBeGreaterThan(0);
    expect(T.countTokens('a')).toBeGreaterThanOrEqual(0);

    const text = '«Да» — нет! A1 中 🙂\nПример таблицы: 12,34 | 56,78';
    const f = T.Tokenizer.countTokenizerFeatures(text);
    expect(T.countTokens(text)).toBe(T.estimateTokensFromFeatures(f));
  });

  test('корзины v3: «»/— — пунктуация, не other', () => {
    const f = T.Tokenizer.countTokenizerFeatures('«Да» — нет! A1 中');
    expect(f).toEqual({ cyr: 5, latin: 1, digit: 1, cjk: 1, punct: 4, other: 0 });
  });

  test('18 точек покрывают прозу, высокую кириллицу и плотные таблицы', () => {
    const hasProse = DATA.points.some((p) => p.digit / p.chars < 0.02);
    const hasHighCyr = DATA.points.some((p) => p.cyr / p.chars > 0.7);
    const hasTable = DATA.points.some((p) => p.digit / p.chars > 0.25);
    expect(hasProse).toBe(true);
    expect(hasHighCyr).toBe(true);
    expect(hasTable).toBe(true);
  });
});
