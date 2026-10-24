const fs = require('fs');
const path = require('path');
const Tokenizer = require('../utils/tokenizer');

// Служебные и смысловые слова разной длины — имитация типового русского чата.
// Средняя длина кириллической серии ≈6.4 буквы (как в живом чате калибровки 161025 кир / ~25 тыс. слов).
const WORDS = ['и', 'в', 'не', 'на', 'что', 'это', 'пример', 'работа', 'система', 'контекст',
  'проверка', 'история', 'точность', 'калибровка', 'мониторинг', 'модель', 'данные', 'запрос',
  'сообщение', 'пользователь', 'ответ', 'юридический', 'документ', 'который', 'только', 'при'];

/** Собирает ровно `targetLen` символов типового русского текста (слова + пробелы + точки). */
function buildChatText(targetLen) {
  let text = '';
  let n = 0;
  while (text.length < targetLen) {
    const w = WORDS[n % WORDS.length];
    text += w + (n % 5 === 4 ? '. ' : ' ');
    n++;
  }
  return text.slice(0, targetLen);
}

describe('Tokenizer — ГЛОБАЛЬНАЯ кириллическая калибровка (O-23: 3.3 симв/токен)', () => {
  // ЖИВЫЕ замеры API countTokens, под которые калиброван делитель (не оценки эвристики):
  //   A) 112 854 симв → 29 517 токенов = 0.2615 ток/симв (Gemini, лог 24-10-24);
  //   B) 216 881 симв (кириллицы 161 025) → 63 713 токенов = 0.2938 ток/симв (DeepSeek BYOK).
  //
  // Прежняя пара (делитель 1.8 + per-run Math.ceil) давала на тексте A 0.520 ток/симв —
  // завышение ×1.99. Основной вклад давало ПООЧЕРЁДНОЕ округление прогонов вверх
  // (слово из 6 букв: 6/1.8 = 3.33 → 4 токена, +20%; короткие слова — до +100%), поэтому
  // кириллица теперь копит ДРОБЬ, а округление одно — в конце countTokens.
  //
  // ГРАНИЦА (зафиксирована, не выдаётся за точность): точки A и B расходятся на ~12% между
  // собой (разные токенизаторы Gemini и DeepSeek). Делитель 3.3 калиброван по A (задача
  // 24-10-24) и остаётся в ±10% от B: для B-подобного текста модель даёт ≈ −12% (он
  // НЕДОоценивается). Для DeepSeek это безопасно: эвристика там только fallback при
  // serverTokens=0 — авторитетны точные серверные числа (O-23/R2, o23-tokens-calibration).
  test('ПРИЁМКА: 112 854 симв → ≈29 517 токенов (живой замер Gemini, ±10%)', () => {
    const text = buildChatText(112854);
    expect(text.length).toBe(112854);
    const tokens = Tokenizer.countTokens(text);
    // Измерено на этой калибровке: 29 959 токенов (0.2655 ток/симв) — +1.5% к API.
    expect(Math.abs(tokens - 29517) / 29517).toBeLessThanOrEqual(0.10);
    // и «типичный кириллический текст» = ~0.26 ток/симв, а не 0.52
    const ratio = tokens / text.length;
    expect(ratio).toBeGreaterThan(0.245);
    expect(ratio).toBeLessThan(0.285);
  });

  test('типовой русский текст 148k кириллицы: пропорция 3.3 без per-run ceil', () => {
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
    // Пропорциональная модель: кириллица/3.3 + ВСЯ пунктуация 0.43 ток/симв (пробелы не считаются):
    // точки из шаблона '. ' внутри цикла + 4000 запятых + '!' (1 ток).
    // Дробное накопление кириллицы даёт ровно эту пропорцию — расхождение только финальный ceil.
    const dots = (text.match(/\./g) || []).length;
    const commas = (text.match(/,/g) || []).length;
    const bangs = (text.match(/!/g) || []).length;
    const model = cyr / 3.3 + (dots + commas) * 0.43 + bangs * 1;
    const tokens = Tokenizer.countTokens(text);
    // Измерено: cyr 148006 / dots 4781 / commas 4000 / bangs 1 → model 48627.13, tokens 48627.
    expect(Math.abs(tokens - model)).toBeLessThan(1.5);
    expect(tokens / text.length).toBeLessThan(0.28);
  });

  test('сплошная кириллица (один run): ~1 токен на 3.3 символа', () => {
    const tokens = Tokenizer.countTokens('а'.repeat(100000));
    expect(Math.abs(tokens - Math.ceil(100000 / 3.3))).toBeLessThan(2);
    expect(Tokenizer.CYRILLIC_CHARS_PER_TOKEN).toBe(3.3);
  });

  test('короткие кириллические слова больше НЕ округляются вверх поштучно', () => {
    // 'и в' = 2 кириллических прогона по 1 символу: 1/3.3 + 1/3.3 = 0.61 → 1 токен.
    // При прежнем per-run ceil было 1 + 1 = 2 (завышение ×2 на коротких словах).
    expect(Tokenizer.countTokens('и в')).toBe(1);
    // 'привет' = 6/3.3 = 1.82 → 2 (было ceil(6/1.8) = 4)
    expect(Tokenizer.countTokens('привет')).toBe(2);
  });

  test('латиница не изменилась: ~1 токен на 4 символа', () => {
    expect(Tokenizer.countTokens('abcd')).toBe(1);
  });

  test('CJK: ceil(n/1.8) — не тронут калибровкой', () => {
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

  test('калибровка ГЛОБАЛЬНА: фолбэк content.js использует тот же делитель, ceil по прогону снят', () => {
    const tkSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'tokenizer.js'), 'utf8');
    // per-run Math.ceil для кириллицы больше не существует (корень завышения ×1.99)
    expect(tkSrc).not.toContain('Math.ceil(cyrillicCount /');
    expect(tkSrc).toContain('tokens += cyrillicCount / CYRILLIC_CHARS_PER_TOKEN;');
    // фолбэк aiCmEstimateTokensTilde (песочницы без Tokenizer) обязан нести тот же коэффициент
    const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'content.js'), 'utf8');
    expect(contentSrc).toContain('Math.ceil(cyr / ' + Tokenizer.CYRILLIC_CHARS_PER_TOKEN + ')');
    expect(contentSrc).not.toContain('Math.ceil(cyr / 1.8)');
  });
});
