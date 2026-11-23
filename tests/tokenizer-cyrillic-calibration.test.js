const fs = require('fs');
const path = require('path');
// Ph2: utils/tokenizer.ts — ES-модуль, поэтому CJS require('...') больше не работает
// (SyntaxError на `export`). Грузим его тем же резолвером графа, что и остальной ESM-пилот.
const Tokenizer = require('./helpers/load-esm.js').loadEsm('utils/tokenizer.ts');

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

describe('Tokenizer — калибровка v3 (18 живых точек, линейная модель)', () => {
  // ЖИВЫЕ замеры API countTokens, под которые калиброван эстиматор (не оценки эвристики):
  //   A) 112 854 симв → 29 517 токенов = 0.2615 ток/симв (Gemini, лог 24-10-24);
  //   B) 216 881 симв (кириллицы 161 025) → 63 713 токенов = 0.2938 ток/симв (DeepSeek BYOK).
  //
  // v3 — линейная модель без per-run Math.ceil: cyr/3.58 + latin/4.611 +
  // digit/0.8045 + punct*0.78665 + cjk/1.8 + other*1.07511, округление одно — в конце.
  // Точка A остаётся приёмочной: модель даёт ≈28 808 токенов (−2.4 % к API).
  // Старая пара (делитель 1.8 + per-run Math.ceil) давала 0.520 ток/симв — завышение ×1.99;
  // главный вклад вносило ПООЧЕРЁДНОЕ округление прогонов вверх, а не сам делитель.
  test('ПРИЁМКА: 112 854 симв → ≈29 517 токенов (живой замер Gemini, ±10%)', () => {
    const text = buildChatText(112854);
    expect(text.length).toBe(112854);
    const tokens = Tokenizer.countTokens(text);
    // Модель v3: 28 808 токенов (0.2553 ток/симв) — −2.4% к API.
    expect(Math.abs(tokens - 29517) / 29517).toBeLessThanOrEqual(0.10);
    // и «типичный кириллический текст» = ~0.26 ток/симв, а не 0.52
    const ratio = tokens / text.length;
    expect(ratio).toBeGreaterThan(0.245);
    expect(ratio).toBeLessThan(0.285);
  });

  test('типовой русский текст 148k кириллицы: линейная формула без per-run ceil', () => {
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
    const f = Tokenizer.countTokenizerFeatures(text);
    const model = f.cyr / 3.58 + f.latin / 4.611 + f.digit / 0.8045 +
      f.punct * 0.78665 + f.cjk / 1.8 + f.other * 1.07511;
    const tokens = Tokenizer.countTokens(text);
    // Дробное накопление даёт ровно эту пропорцию — расхождение только финальный ceil.
    expect(Math.abs(tokens - model)).toBeLessThan(1.5);
    expect(tokens / text.length).toBeLessThan(0.28);
  });

  test('сплошная кириллица: ~1 токен на 3.58 символа', () => {
    const tokens = Tokenizer.countTokens('а'.repeat(100000));
    expect(Math.abs(tokens - Math.ceil(100000 / 3.58))).toBeLessThan(2);
    expect(Tokenizer.CYRILLIC_CHARS_PER_TOKEN).toBe(3.58);
  });

  test('короткие кириллические слова не округляются вверх поштучно', () => {
    // 'и в' = 2 кириллических символа: 2/3.58 = 0.56 → 1 токен.
    expect(Tokenizer.countTokens('и в')).toBe(1);
    // 'привет' = 6/3.58 = 1.68 → 2
    expect(Tokenizer.countTokens('привет')).toBe(2);
  });

  test('латиница: ~1 токен на 4.611 символа', () => {
    expect(Tokenizer.countTokens('abcd')).toBe(1);
  });

  test('CJK: ceil(n/1.8) — не тронут калибровкой', () => {
    expect(Tokenizer.countTokens('中文中')).toBe(2);
    expect(Tokenizer.countTokenizerFeatures('中').cjk).toBe(1);
    expect(Tokenizer.countTokenizerFeatures('ひ').cjk).toBe(1);
    expect(Tokenizer.countTokenizerFeatures('한').cjk).toBe(1);
  });

  test('пунктуация с «»/— учитывается как punct, не other', () => {
    const f = Tokenizer.countTokenizerFeatures('. - , « » —');
    expect(f.punct).toBe(6);
    expect(f.other).toBe(0);
  });

  test('калибровка ГЛОБАЛЬНА: фолбэк content.js использует тот же делитель, ceil по прогону снят', () => {
    const tkSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'tokenizer.ts'), 'utf8');
    // per-run Math.ceil для кириллицы больше не существует (корень завышения ×1.99)
    expect(tkSrc).not.toContain('Math.ceil(cyrillicCount /');
    expect(tkSrc).toContain('CYRILLIC_CHARS_PER_TOKEN: 3.58');
    expect(tkSrc).toContain('f.cyr / TOKENIZER_V3.CYRILLIC_CHARS_PER_TOKEN');
    // фолбэк aiCmEstimateTokensTilde (песочницы без Tokenizer) обязан нести тот же коэффициент
    const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'content.ts'), 'utf8');
    expect(contentSrc).toContain('Math.ceil(cyr / ' + Tokenizer.CYRILLIC_CHARS_PER_TOKEN + ')');
  });
});
