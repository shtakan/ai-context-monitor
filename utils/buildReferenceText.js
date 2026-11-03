/**
 * Сборка plain-text «эталона» для сверки расширения с ручной копией чата.
 * Чистая функция, без зависимостей от DOM или браузера:
 *   - работает в браузере (window.buildReferenceText) и в Node (module.exports).
 *
 * Формат:
 *   - сообщения строго по порядку исходного массива;
 *   - текст каждого сообщения с консервативной зачисткой markdown-разметки,
 *     приближающей к браузерному рендеру (см. cleanText);
 *   - сообщения разделяются ровно одной пустой строкой;
 *   - без BOM, переводы строк LF.
 *
 * Зачистка (только явные маркеры, текст без разметки не меняется):
 *   - маркеры заголовков "#{1,6} " в начале строки;
 *   - маркеры неупорядоченных списков "* ", "- ", "+ " в начале строки
 *     (нумерованные "N. " сохраняются);
 *   - жирность/курсив: "**", "__" и одиночные "*" / "_" вокруг слов;
 *   - цитата "> " в начале строки (символы типа ⚠ остаются);
 *   - строки-разделители "---";
 *   - ссылки [text](url) -> text;
 *   - обратные кавычки "`".
 */

(function () {
  'use strict';

  /**
   * Сообщение источника для эталона: читается только текстовое поле.
   * По форме совместимо с Message/ExportMessage (types/message.d.ts,
   * types/export.d.ts), но требует лишь text.
   * @typedef {Object} ReferenceMessage
   * @property {string|null} [text] Текст сообщения; null/undefined → ''.
   */

  /**
   * Инлайн-зачистка одной строки (после построчных правил).
   * @param {string} s Строка после cleanLine.
   * @returns {string} Строка без ссылок, жирности, курсива и обратных кавычек.
   */
  function cleanInline(s) {
    // Ссылки [text](url) -> text (url без пробелов и скобок)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1');
    // Жирность: двойные маркеры ** и __
    s = s.replace(/(\*\*|__)/g, '');
    // Курсив: одиночные * вокруг непустого текста, не примыкающие к словам снаружи
    s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![\w*])/g, '$1');
    // Курсив: одиночные _ вокруг непустого текста, не примыкающие к словам снаружи
    s = s.replace(/(?<![\w_])\_([^_\n]+)\_(?![\w_])/g, '$1');
    // Обратные кавычки
    s = s.replace(/`/g, '');
    return s;
  }

  /**
   * Построчные правила: только маркеры в самом начале строки.
   * @param {string|null|undefined} line Сырая строка сообщения.
   * @returns {string} Строка без ведущих маркеров заголовка, цитаты и списка.
   */
  function cleanLine(line) {
    var s = String(line == null ? '' : line);
    // Заголовки: "# " ... "###### "
    s = s.replace(/^#{1,6}\s+/, '');
    // Цитата: "> " (символ-эмодзи/предупреждения после маркера сохраняется)
    s = s.replace(/^>\s?/, '');
    // Неупорядоченные списки: "* ", "- ", "+ "
    s = s.replace(/^[-*+]\s+/, '');
    return s;
  }

  /**
   * Зачистка текста одного сообщения: построчные правила + инлайн-разметка.
   * Строки-разделители "---" удаляются целиком.
   * @param {string|null|undefined} text Текст сообщения.
   * @returns {string} Очищенный текст (LF, без завершающих переводов строк).
   */
  function cleanText(text) {
    var lines = String(text).split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      // Строка-разделитель "---" удаляется целиком
      if (/^-{3,}$/.test(trimmed)) continue;
      out.push(cleanInline(cleanLine(line)));
    }
    return out.join('\n');
  }

  /**
   * Собирает plain-text «эталон» из сообщений снимка.
   * @param {ReferenceMessage[]|null|undefined} messages Сообщения в порядке исходного массива.
   * @returns {string} Текст сообщений, разделённых ровно одной пустой строкой (LF, без BOM).
   */
  function buildReferenceText(messages) {
    var list = Array.isArray(messages) ? messages : [];
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      /** @type {ReferenceMessage} */
      var msg = list[i] || {};
      parts.push(cleanText(msg.text == null ? '' : msg.text));
    }
    return parts.join('\n\n');
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = buildReferenceText;
  if (typeof window !== 'undefined') window.buildReferenceText = buildReferenceText;
})();