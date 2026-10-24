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
const CYRILLIC_CHARS_PER_TOKEN = 3.3;

const Tokenizer = {
  CYRILLIC_CHARS_PER_TOKEN: CYRILLIC_CHARS_PER_TOKEN,

  /**
   * Определяет тип символа.
   */
  _getCharType(char) {
    if (/[а-яёА-ЯЁ]/.test(char)) return 'cyrillic';
    if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(char)) return 'cjk';
    if (/[a-zA-Z]/.test(char)) return 'latin';
    if (/[0-9]/.test(char)) return 'digit';
    if (/\s/.test(char)) return 'space';
    if (/[.,!?;:()\[\]{}"'«»\-—]/.test(char)) return 'punctuation';
    return 'other';
  },

  /**
   * Приблизительный подсчёт токенов в тексте.
   * @param {string} text - текст для оценки
   * @returns {number} - приблизительное количество токенов
   */
  countTokens(text) {
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

  // countTokensFast удалён в v1.1 — дублировал логику countTokens и не вызывался нигде.

  /**
   * Оценивает токены в диалоге с учётом структуры чата.
   * Учитывает накладные расходы на форматирование сообщений.
   * @param {string} dialogText - полный текст диалога
   * @param {number} messageCount - количество сообщений
   * @returns {number}
   */
  estimateDialogTokens(dialogText, messageCount = 1) {
    const textTokens = this.countTokens(dialogText);
    
    // Накладные расходы на форматирование чата (~4 токена на сообщение)
    const overhead = messageCount * 4;
    
    return textTokens + overhead;
  }
};

// Экспорт
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Tokenizer;
}