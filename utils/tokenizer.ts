/**
 * Приблизительный токенизатор для оценки количества токенов в тексте.
 *
 * Production-модель — линейная калибровка v3 по 18 живым замерам Gemini
 * countTokens (2026-11-24): 9 обычных чатов, полный Unicode-чат, 4 табличных
 * и 4 чата с высокой долей кириллицы.
 *
 *   tokens = cyr / 3.58
 *          + latin / 4.611
 *          + digit / 0.8045
 *          + punct * 0.78665
 *          + cjk / 1.8
 *          + other * 1.07511
 *
 * Свободный член 0: с CONST=-7.43 короткие тексты уходили в ноль.
 * Округление одно — в конце (никакого per-run Math.ceil).
 *
 * Точность на 18 точках: MAPE 3.08 %, max 7.38 %, LOO max 7.69 %.
 * Старая эвристика (3.3 / 4 / 3 / 0.43 + per-run ceil) давала MAPE 12.42 %,
 * max 44.18 % — в основном из-за плотных таблиц.
 *
 * Высококириллическая проза неоднородна (3.6–4.0 символа/токен), поэтому
 * на отдельных чатах возможен уход до ~8 %. Это осознанный компромисс:
 * таблицы и смешанные чаты выигрывают радикально.
 *
 * Пины: tests/tokenizer-v3-calibration.test.js (18 точек),
 * tests/tokenizer-cyrillic-calibration.test.js (живой замер 112 854),
 * tests/o23-tokens-calibration.test.js (O-23 fallback/инварианты).
 */

export const TOKENIZER_V3 = {
  CYRILLIC_CHARS_PER_TOKEN: 3.58,
  LATIN_CHARS_PER_TOKEN: 4.611,
  DIGIT_CHARS_PER_TOKEN: 0.8045,
  PUNCT_TOKENS_PER_CHAR: 0.78665,
  CJK_CHARS_PER_TOKEN: 1.8,
  OTHER_TOKENS_PER_CHAR: 1.07511,
  CONST_TOKENS: 0
} as const;

/** Агрегаты классов символов для линейной модели. */
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
    f.cyr / TOKENIZER_V3.CYRILLIC_CHARS_PER_TOKEN +
    f.latin / TOKENIZER_V3.LATIN_CHARS_PER_TOKEN +
    f.digit / TOKENIZER_V3.DIGIT_CHARS_PER_TOKEN +
    f.punct * TOKENIZER_V3.PUNCT_TOKENS_PER_CHAR +
    f.cjk / TOKENIZER_V3.CJK_CHARS_PER_TOKEN +
    f.other * TOKENIZER_V3.OTHER_TOKENS_PER_CHAR +
    TOKENIZER_V3.CONST_TOKENS;
  return Math.max(0, Math.ceil(raw));
}

/**
 * Классификация символов — ровно те же корзины, что пишет
 * `o23-calibration` в core/content.ts: полный кириллический блок,
 * CJK, ASCII-латиница/цифры, пробелы (бесплатны), пунктуация с «»/—,
 * остальное — other. Общая классификация для фита и production-пути.
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
  /** Калиброванный делитель кириллицы (для фолбэка/диагностики). */
  CYRILLIC_CHARS_PER_TOKEN: TOKENIZER_V3.CYRILLIC_CHARS_PER_TOKEN,

  /** Приблизительный подсчёт токенов в тексте (production-модель v3). */
  countTokens(text: string): number {
    if (!text || text.length === 0) return 0;
    return estimateTokensFromFeatures(countTokenizerFeatures(text));
  },

  /** Агрегаты классов для диагностики/калибровки. */
  countTokenizerFeatures(text: string): TokenizerFeatureCounts {
    return countTokenizerFeatures(text);
  },

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
// втягивает esbuild статическим import'ом из core/content.js. Публичный контракт:
// объект Tokenizer (countTokens/estimateDialogTokens/CYRILLIC_CHARS_PER_TOKEN)
// плюс named-экспорты для новых потребителей.

/** Приблизительный подсчёт токенов (named-экспорт, делегирует Tokenizer.countTokens). */
export function countTokens(text: string): number {
  return Tokenizer.countTokens(text);
}

/** Токены диалога с накладными расходами (named-экспорт, делегирует Tokenizer.estimateDialogTokens). */
export function estimateDialogTokens(dialogText: string, messageCount: number = 1): number {
  return Tokenizer.estimateDialogTokens(dialogText, messageCount);
}

export default Tokenizer;
