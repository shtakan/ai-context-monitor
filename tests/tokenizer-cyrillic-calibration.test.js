const Tokenizer = require('../utils/tokenizer');

// Служебные и смысловые слова разной длины — имитация типового русского чата.
// Средняя длина кириллической серии ~6 букв (как в живом чате калибровки: 161025 кир / 26312 слов).
const WORDS = ['и', 'в', 'не', 'на', 'что', 'это', 'пример', 'работа', 'система', 'контекст',
  'проверка', 'история', 'точность', 'калибровка', 'мониторинг', 'модель', 'данные', 'запрос',
  'сообщение', 'пользователь', 'ответ', 'юридический', 'документ', 'который', 'только', 'при'];

describe('Tokenizer — кириллическая калибровка (BYOK serverTokens)', () => {
  test('типовой русский текст 148k кириллицы НЕ завышает: в пределах server-пропорции ±15%', () => {
    // Живой эталон: полный текст 216881 симв (кириллицы 161025) → serverTokens = 63713.
    // Для 148k кириллицы пропорциональная цель ≈ 63713 * 148/161 = 58560.
    // Старая эвристика (делитель 1.8) давала здесь ~1.81× выше (≈115k) — вне окна.
    const target = 58560;
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
    const tokens = Tokenizer.countTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(target * 0.75);
    expect(tokens).toBeLessThanOrEqual(target * 1.15);
  });

  test('сплошная кириллица (один run): ~1 токен на 4 символа', () => {
    const tokens = Tokenizer.countTokens('а'.repeat(100000));
    expect(Math.abs(tokens - 25000)).toBeLessThan(4);
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
