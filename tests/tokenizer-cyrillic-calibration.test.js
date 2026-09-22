const Tokenizer = require('../utils/tokenizer');

// Служебные и смысловые слова разной длины — имитация типового русского чата.
// Средняя длина кириллической серии ~6 букв (как в живом чате калибровки: 161025 кир / 26312 слов).
const WORDS = ['и', 'в', 'не', 'на', 'что', 'это', 'пример', 'работа', 'система', 'контекст',
  'проверка', 'история', 'точность', 'калибровка', 'мониторинг', 'модель', 'данные', 'запрос',
  'сообщение', 'пользователь', 'ответ', 'юридический', 'документ', 'который', 'только', 'при'];

describe('Tokenizer — кириллическая калибровка (O-23: делитель 1.8)', () => {
  // O-23 (F5): делитель кириллицы изменён 4.0 → 1.8 (utils/tokenizer.js:countTokens).
  // ГРАНИЦА (зафиксирована, не выдаётся за точность): прежний делитель 4.0 был подогнан
  // под один живой BYOK-прогон (216881 симв, из них 161025 кириллицы → serverTokens 63713,
  // т.е. ~2.5 симв/ток по кириллице). Решение владельца O-23 — реальный коэффициент ≈1.8;
  // относительно BYOK-эталона новая модель даёт завышение ~1.67× на этом же тексте.
  // Пины ниже фиксируют НОВУЮ модель (пропорция 1.8), а не BYOK-эталон; арифметика пар
  // tokens~ против serverTokens — tests/o23-tokens-calibration.test.js.
  test('типовой русский текст 148k кириллицы: пропорция 1.8 (±ceil-инфляция по словам)', () => {
    // Живой эталон для справки: полный текст 216881 симв (кириллицы 161025) → serverTokens 63713.
    // Старый пин требовал ≤ 58560 (делитель 4.0) — перекалиброван под делитель 1.8.
    let text = '';
    let cyr = 0;
    let n = 0;
    while (cyr < 148000) {
      const w = WORDS[n % WORDS.length];
      text += w + (n % 5 === 4 ? '. ' : ' ');
      cyr += w.length;
      n++;
    }
    // лёгкая пунктуация в конце
    text += ', '.repeat(4000) + '!';
    // пропорциональная модель: кириллица/1.8 + пунктуация 0.43 ток/симв (пробелы не считаются)
    const model = cyr / 1.8 + 4000 * 0.43 + 1; // ',' × 4000 (0.43 ток) + '!' (1 ток)
    const tokens = Tokenizer.countTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(model * 0.85);
    // per-word ceil добавляет ~16% к пропорции — верхняя граница 1.25×
    expect(tokens).toBeLessThanOrEqual(model * 1.25);
  });

  test('сплошная кириллица (один run): ~1 токен на 1.8 символа', () => {
    const tokens = Tokenizer.countTokens('а'.repeat(100000));
    expect(Math.abs(tokens - Math.ceil(100000 / 1.8))).toBeLessThan(4);
  });

  test('латиница не изменилась: ~1 токен на 4 символа', () => {
    expect(Tokenizer.countTokens('abcd')).toBe(1);
  });

  test('CJK: ceil(n/1.8)', () => {
    expect(Tokenizer.countTokens('中文中')).toBe(2);
    expect(Tokenizer._getCharType('中')).toBe('cjk');
    expect(Tokenizer._getCharType('ひ')).toBe('cjk');
    expect(Tokenizer._getCharType('한')).toBe('cjk');
  });

  test('пунктуация учитывается как 0.43 ток/симв', () => {
    expect(Tokenizer._getCharType('.')).toBe('punctuation');
    expect(Tokenizer._getCharType('-')).toBe('punctuation');
    expect(Tokenizer._getCharType(',')).toBe('punctuation');
  });
});
