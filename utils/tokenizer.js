/**
 * Приблизительный токенизатор для оценки количества токенов в тексте.
 * 
 * Точный подсчёт токенов без API невозможен, поэтому используем эмпирические правила:
 * - Для английского языка: ~1 токен ≈ 4 символа
 * - Для русского языка: ~1 токен ≈ 1.5-2 символа (кириллица занимает больше токенов)
 * - Для смешанного текста: усреднённая оценка
 * 
 * Эти оценки основаны на поведении токенизаторов GPT/Gemini.
 * Погрешность может составлять ±20%, но для мониторинга заполнения контекста этого достаточно.
 */

const Tokenizer = {
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
        // Кириллица: делитель 4.0 (≈2 токена на русское слово средней длины).
        // Калибровано по живому serverTokens BYOK на реальном чате: 216881 симв
        // (из них 161025 кириллицы) → 63713 ток. per-run ceil на коротких словах
        // компенсируется делителем; иначе (2.33) систематическое завышение ~1.81×.
        let cyrillicCount = 0;
        while (i < text.length && this._getCharType(text[i]) === 'cyrillic') {
          cyrillicCount++;
          i++;
        }
        tokens += Math.ceil(cyrillicCount / 4);
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