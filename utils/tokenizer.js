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
        // Кириллица: ~1 токен на 1-2 символа
        let cyrillicCount = 0;
        while (i < text.length && this._getCharType(text[i]) === 'cyrillic') {
          cyrillicCount++;
          i++;
        }
        tokens += Math.ceil(cyrillicCount / 1.8);
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
        // Пунктуация: обычно отдельный токен, но зависит от контекста
        tokens += 0.5;
        i++;
        continue;
      }
      
      // Прочие символы (эмодзи, спецсимволы) — 1 токен каждый
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