/**
 * Базовый класс для всех адаптеров сайтов.
 * Определяет общий интерфейс, который должен реализовать каждый адаптер.
 * 
 * Паттерн: Strategy (Стратегия)
 * Каждый адаптер — это стратегия извлечения диалогов из DOM конкретного сайта.
 *
 * Типизация (шаг 4 Фазы 1): формы берутся из types/adapter.d.ts. Литеральный
 * `import type` здесь невозможен — файл грузится как классический скрипт контента
 * (manifest.json) и склеивается исходником в new Function() песочницами тестов,
 * поэтому типы подключаются JSDoc-ссылкой import() (комментарии, рантайм не меняется).
 */

/**
 * Сообщение в форме адаптера — контракт Adapter.extractMessages()
 * (types/adapter.d.ts). НЕ путать с Message из types/message.d.ts: там поле text.
 *
 * Имя с префиксом — НЕ по вкусу, а по необходимости: файлы адаптеров не являются
 * модулями (обычные скрипты, склеиваемые исходником), поэтому при allowJs все
 * typedef-имена попадают в одну общую область и одноимённые дают TS2300. Поэтому
 * каждый адаптер заводит свой алиас на ОДНО и то же имя типа из types/adapter.d.ts.
 * @typedef {import('../types/adapter').ExtractedMessage} BaseExtractedMessage
 */

/**
 * Контракт адаптера, который реализует BaseAdapter (types/adapter.d.ts).
 * @typedef {import('../types/adapter').Adapter} BaseAdapterContract
 */

/**
 * Родитель для поиска: Document (весь документ) либо Element (поддерево).
 * Изначально аннотировали как Element — tsc ругался, что у Document нет
 * attributes/classList/className и ещё 116 свойств (TS2740).
 * @typedef {Document|Element} ParentNode
 */

/** BaseAdapter — реализация контракта BaseAdapterContract (types/adapter.d.ts). */
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
   * @returns {BaseExtractedMessage[]}
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
   * @param {ParentNode} [parent] - Document по умолчанию
   * @returns {Element|null}
   */
  _safeQuerySelector(selector, parent = document) {
    try {
      return parent.querySelector(selector);
    } catch (e) {
      aiCmDiagWarn('adapter:base:safeQuerySelector', `Ошибка селектора "${selector}":`, e);
      return null;
    }
  }

  /**
   * Безопасный querySelectorAll с проверкой.
   * Ветка ошибки возвращает пустой массив, а не NodeList: у NodeList есть .item(),
   * у массива нет (TS2741). Потребители берут только .length и срез в массив
   * (Array.prototype.slice.call в qwen-adapter.js:143), поэтому обе формы годятся.
   * @param {string} selector
   * @param {ParentNode} [parent] - Document по умолчанию
   * @returns {NodeList|Element[]}
   */
  _safeQuerySelectorAll(selector, parent = document) {
    try {
      return parent.querySelectorAll(selector);
    } catch (e) {
      aiCmDiagWarn('adapter:base:safeQuerySelectorAll', `Ошибка селектора "${selector}":`, e);
      return [];
    }
  }
}

// Экспортируем для использования в других скриптах
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BaseAdapter;
}