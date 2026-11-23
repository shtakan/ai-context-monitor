/**
 * Приблизительный токенизатор для оценки количества токенов в тексте.
 * 
 * Точный подсчёт токенов без API невозможен, поэтому используем эмпирические правила:
 * - Для английского языка: ~1 токен ≈ 4 символа
 * - Для русского языка: ~1 токен ≈ 3.3 символа (0.30 ток/симв)
 * - Для смешанного текста: усреднённая оценка
 * 
 * Эти оценки основаны на поведении токенизаторов GPT/Gemini.
 * Погрешность может составлять ±20%, но для мониторинга заполнения контекста этого достаточно.
 */

// Кириллица: 1 токен ≈ 3.3 символа. ГЛОБАЛЬНАЯ калибровка O-23 (влияет на все сервисы:
// ChatGPT/Claude/Perplexity и любые fallback-режимы без серверных токенов).
//
// Опорные ЖИВЫЕ замеры API countTokens (не оценки):
//   1) 112 854 симв → 29 517 токенов = 0.2615 ток/симв (Gemini, лог 24-10);
//   2) 216 881 симв (из них 161 025 кириллицы) → 63 713 токенов = 0.2938 ток/симв (DeepSeek BYOK).
// При делителе 3.3 с накоплением ДРОБИ по прогонам обе точки сходятся в пределах ±7%
// (для «типичного» кириллического текста: 0.26-0.27 ток/симв).
//
// Почему делитель ВЫРОС, а не упал (формулировка «снизить делитель» арифметически обратна):
// делитель — это символов на токен, поэтому рост коэффициента симв/токен снижает оценку.
// Прежняя пара (делитель 1.8 + per-run Math.ceil) давала 0.520 ток/симв — завышение ×1.99.
// Главный вклад в переоценку давал не делитель, а ПОШТУЧНОЕ округление прогонов вверх:
// слово из 6 букв — 6/1.8 = 3.33 → 4 токена (+20%), короткие слова — до +100%.
// Поэтому кириллица теперь копит дробь, а округление делается ОДИН раз в конце countTokens.
// Арифметика и пины — tests/tokenizer-cyrillic-calibration.test.js (+ O-23).
/** Класс символа для эвристики countTokens (выбор правила «символов на токен»). */
type CharType = 'cyrillic' | 'cjk' | 'latin' | 'digit' | 'space' | 'punctuation' | 'other';

/** Калибровка O-23: символов на токен для кириллицы. */
const CYRILLIC_CHARS_PER_TOKEN = 3.3;

/**
 * Экспериментальная линейная калибровка v2 (14 чистых точек Gemini, 2026-11-23).
 *
 * В отличие от production-`countTokens`, здесь НЕТ per-run `Math.ceil`:
 * токены копятся линейно по классам символов, округление одно — в конце.
 * Пространства бесплатны, как и в текущей модели.
 *
 * Кандидат получен МНК по 14 точкам (9 обычных + Unicode + 3 плотные таблицы).
 * Свободный член намеренно 0: с CONST=-7.43 короткие тексты уходили в ноль.
 * Без CONST: replay MAPE 1.85 %, max 5.41 %, нечётная половина 1.23 %.
 * Production-путь пока НЕ переключён: сначала replay-тест и живая проверка.
 */
export const TOKENIZER_V2 = {
  CYRILLIC_CHARS_PER_TOKEN: 3.9343,
  LATIN_CHARS_PER_TOKEN: 3.8414,
  DIGIT_CHARS_PER_TOKEN: 0.7959,
  PUNCT_TOKENS_PER_CHAR: 0.7205,
  CJK_CHARS_PER_TOKEN: 1.8,
  OTHER_TOKENS_PER_CHAR: 1.0741,
  CONST_TOKENS: 0
} as const;

/** Агрегаты классов символов для replay-проверки линейной модели. */
export interface TokenizerFeatureCounts {
  cyr: number;
  latin: number;
  digit: number;
  cjk: number;
  punct: number;
  other: number;
}

/** Линейная оценка токенов по агрегатам классов (чистая функция). */
export function estimateTokensFromFeatures(f: TokenizerFeatureCounts): number {
  const raw =
    f.cyr / TOKENIZER_V2.CYRILLIC_CHARS_PER_TOKEN +
    f.latin / TOKENIZER_V2.LATIN_CHARS_PER_TOKEN +
    f.digit / TOKENIZER_V2.DIGIT_CHARS_PER_TOKEN +
    f.punct * TOKENIZER_V2.PUNCT_TOKENS_PER_CHAR +
    f.cjk / TOKENIZER_V2.CJK_CHARS_PER_TOKEN +
    f.other * TOKENIZER_V2.OTHER_TOKENS_PER_CHAR +
    TOKENIZER_V2.CONST_TOKENS;
  return Math.max(0, Math.ceil(raw));
}

/**
 * Классификация символов для v2 — ровно те же корзины, что пишет
 * `o23-calibration` в core/content.ts: полный кириллический блок,
 * CJK, ASCII-латиница/цифры, пробелы, пунктуация с «»/—, остальное — other.
 *
 * Отдельная от production `_getCharType` намеренно: там пунктуация без «»/—
 * и кириллица только русская, менять её до переключения нельзя (бейдж).
 * Благодаря общей классификации shadow-строка `v2=` и фит считают одно и то же.
 */
export function countTokenizerFeatures(text: string): TokenizerFeatureCounts {
  const f: TokenizerFeatureCounts = { cyr: 0, latin: 0, digit: 0, cjk: 0, punct: 0, other: 0 };
  if (!text) return f;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[\u0400-\u04FF]/.test(ch)) f.cyr++;
    else if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch)) f.cjk++;
    else if (/[A-Za-z]/.test(ch)) f.latin++;
    else if (/[0-9]/.test(ch)) f.digit++;
    else if (/\s/.test(ch)) continue;
    else if (/[.,!?;:()\[\]{}"'«»\-—]/.test(ch)) f.punct++;
    else f.other++;
  }
  return f;
}

export const Tokenizer = {
  CYRILLIC_CHARS_PER_TOKEN: CYRILLIC_CHARS_PER_TOKEN,

  /** Определяет класс символа для выбора эвристики. */
  _getCharType(char: string): CharType {
    if (/[а-яёА-ЯЁ]/.test(char)) return 'cyrillic';
    if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(char)) return 'cjk';
    if (/[a-zA-Z]/.test(char)) return 'latin';
    if (/[0-9]/.test(char)) return 'digit';
    if (/\s/.test(char)) return 'space';
    if (/[.,!?;:()\[\]{}"'«»\-—]/.test(char)) return 'punctuation';
    return 'other';
  },

  /** Приблизительный подсчёт токенов в тексте. */
  countTokens(text: string): number {
    if (!text || text.length === 0) return 0;
    
    let tokens = 0;
    let i = 0;
    
    while (i < text.length) {
      const char = text[i];
      const type = this._getCharType(char);
      
      if (type === 'space') {
        // Пробелы обычно объединяются с соседними токенами
        i++;
        continue;
      }
      
      if (type === 'cyrillic') {
        // Кириллица: 3.3 симв/токен — живая калибровка O-23 (см. шапку файла).
        // Дробное накопление ОБЯЗАТЕЛЬНО: per-run Math.ceil на коротких словах завышал
        // прогон на 20-100% и вместе с делителем 1.8 давал 0.52 ток/симв при реальных 0.26.
        // Округление одно — в конце countTokens. Пины: tests/tokenizer-cyrillic-calibration.test.js,
        // tests/o23-tokens-calibration.test.js (R6/F-общий).
        let cyrillicCount = 0;
        while (i < text.length && this._getCharType(text[i]) === 'cyrillic') {
          cyrillicCount++;
          i++;
        }
        tokens += cyrillicCount / CYRILLIC_CHARS_PER_TOKEN;
        continue;
      }
      
      if (type === 'cjk') {
        // CJK: ~1 токен на 1.8 символа (0.55 ток/симв)
        let cjkCount = 0;
        while (i < text.length && this._getCharType(text[i]) === 'cjk') {
          cjkCount++;
          i++;
        }
        tokens += Math.ceil(cjkCount / 1.8);
        continue;
      }

      if (type === 'latin') {
        // Латиница: ~1 токен на 4 символа
        let latinCount = 0;
        while (i < text.length && this._getCharType(text[i]) === 'latin') {
          latinCount++;
          i++;
        }
        tokens += Math.ceil(latinCount / 4);
        continue;
      }
      
      if (type === 'digit') {
        // Цифры: ~1 токен на 3 символа
        let digitCount = 0;
        while (i < text.length && this._getCharType(text[i]) === 'digit') {
          digitCount++;
          i++;
        }
        tokens += Math.ceil(digitCount / 3);
        continue;
      }
      
      if (type === 'punctuation') {
        // Пунктуация: 0.43 ток/симв — соразмерно кириллице (присоединяется к токенам)
        tokens += 0.43;
        i++;
        continue;
      }
      
      // Прочие символы (эмодзи, спецсимволы, markdown-служебные) — 1 токен каждый
      tokens += 1;
      i++;
    }
    
    // Округляем до целого
    return Math.ceil(tokens);
  },

  /**
   * Экспериментальный линейный счётчик v2. Не используется production-путём
   * (content.ts остаётся на countTokens), пока не пройдены replay и живая проверка.
   */
  countTokensV2(text: string): number {
    if (!text || text.length === 0) return 0;
    return estimateTokensFromFeatures(countTokenizerFeatures(text));
  },

  /** Агрегаты классов для v2/shadow (те же корзины, что в o23-calibration). */
  countTokenizerFeatures(text: string): TokenizerFeatureCounts {
    return countTokenizerFeatures(text);
  },

  // countTokensFast удалён в v1.1 — дублировал логику countTokens и не вызывался нигде.

  /**
   * Оценивает токены в диалоге с учётом структуры чата:
   * текст плюс накладные расходы на форматирование сообщений.
   */
  estimateDialogTokens(dialogText: string, messageCount: number = 1): number {
    const textTokens = this.countTokens(dialogText);
    
    // Накладные расходы на форматирование чата (~4 токена на сообщение)
    const overhead = messageCount * 4;
    
    return textTokens + overhead;
  }
};

// --- Экспорт: ES-модуль (Roadmap Ph2) ----------------------------------------------
// UMD-хвост (CJS-экспорт) снят: модуль больше не classic-скрипт манифеста, его
// втягивает esbuild статическим import'ом из core/content.js. Публичный контракт не
// изменился — объект Tokenizer (countTokens/estimateDialogTokens/CYRILLIC_CHARS_PER_TOKEN)
// по-прежнему единственный источник калибровки; named-экспорты ниже — те же функции,
// для новых потребителей, которым не нужен namespace.

/** Приблизительный подсчёт токенов (named-экспорт, делегирует Tokenizer.countTokens). */
export function countTokens(text: string): number {
  return Tokenizer.countTokens(text);
}

/** Экспериментальный линейный счётчик v2 (named-экспорт). */
export function countTokensV2(text: string): number {
  return Tokenizer.countTokensV2(text);
}

/** Токены диалога с накладными расходами (named-экспорт, делегирует Tokenizer.estimateDialogTokens). */
export function estimateDialogTokens(dialogText: string, messageCount: number = 1): number {
  return Tokenizer.estimateDialogTokens(dialogText, messageCount);
}

export default Tokenizer;