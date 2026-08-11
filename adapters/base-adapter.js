/**
 * Базовый класс для всех адаптеров сайтов.
 * Определяет общий интерфейс, который должен реализовать каждый адаптер.
 * 
 * Паттерн: Strategy (Стратегия)
 * Каждый адаптер — это стратегия извлечения диалогов из DOM конкретного сайта.
 */
class BaseAdapter {
  constructor() {
    // Название сайта (будет переопределено в наследниках)
    this.siteName = 'base';
    
    // Селектор контейнера с диалогами (переопределить в наследнике)
    this.dialogContainerSelector = '';
    
    // Селекторы для сообщений пользователя и модели (переопределить)
    this.userMessageSelector = '';
    this.modelMessageSelector = '';
  }

  /**
   * Проверяет, находимся ли мы на странице диалога этого сайта.
   * @returns {boolean}
   */
  isOnDialogPage() {
    throw new Error('Метод isOnDialogPage() должен быть переопределён');
  }

  /**
   * Извлекает все сообщения из диалога.
   * @returns {Array<{role: string, content: string}>}
   */
  extractMessages() {
    throw new Error('Метод extractMessages() должен быть переопределён');
  }

  /**
   * Собирает полный текст диалога для оценки токенов.
   * @returns {string}
   */
  getFullDialogText() {
    const messages = this.extractMessages();
    return messages.map(msg => msg.content).join('\n');
  }

  /**
   * Возвращает количество сообщений в диалоге.
   * @returns {number}
   */
  getMessageCount() {
    return this.extractMessages().length;
  }

  /**
   * Определяет модель ИИ по DOM (если возможно).
   * @returns {string|null} - название модели или null
   */
  detectModel() {
    return null; // По умолчанию не умеем определять
  }

  /**
   * Безопасное получение текста из элемента.
   * @param {Element} element
   * @returns {string}
   */
  _getTextContent(element) {
    return element ? element.textContent.trim() : '';
  }

  /**
   * Безопасный querySelector с проверкой.
   * @param {string} selector
   * @param {Element} parent
   * @returns {Element|null}
   */
  _safeQuerySelector(selector, parent = document) {
    try {
      return parent.querySelector(selector);
    } catch (e) {
      console.warn(`Ошибка селектора "${selector}":`, e);
      return null;
    }
  }

  /**
   * Безопасный querySelectorAll с проверкой.
   * @param {string} selector
   * @param {Element} parent
   * @returns {NodeList}
   */
  _safeQuerySelectorAll(selector, parent = document) {
    try {
      return parent.querySelectorAll(selector);
    } catch (e) {
      console.warn(`Ошибка селектора "${selector}":`, e);
      return [];
    }
  }
}

// Экспортируем для использования в других скриптах
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BaseAdapter;
}