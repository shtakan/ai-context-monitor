/**
 * Базовый класс для всех адаптеров сайтов.
 * Определяет общий интерфейс, который должен реализовать каждый адаптер.
 *
 * Паттерн: Strategy (Стратегия)
 * Каждый адаптер — это стратегия извлечения диалогов из DOM конкретного сайта.
 *
 * Типизация (Фаза 1, шаг 2): типы объявлены ПРЯМО ЗДЕСЬ, а не через `import type`.
 * Файл остаётся классическим скриптом контента: manifest.json грузит его отдельным
 * <script>, а тесты склеивают исходники в один new Function()-скоуп
 * (tests/qwen-adapter.test.js, tests/qwen-container-drop-o37.test.js). Верхнеуровневый
 * import/export превратил бы файл в модуль, и BaseAdapter/Message пропали бы из общей
 * лексической области, на которую опираются core/content.js и остальные адаптеры.
 * Поэтому интерфейсы объявлены в скриптовой области видимости — ровно там же, где класс.
 */

/**
 * Сообщение в форме адаптера — контракт Adapter.extractMessages().
 * НЕ путать с Message из types/message.d.ts: там нормализованная форма с полем text.
 */
interface Message {
  /** Роль реплики: 'user', 'assistant' (у части сайтов — свои значения). */
  role: string;
  /** Текст реплики. Именно content, а не text (см. types/adapter.d.ts). */
  content: string;
  /** Доп. поля конкретного сайта (id узла, модель, служебные флаги). */
  [extra: string]: unknown;
}

/**
 * Опции извлечения — необязательный аргумент extractMessages().
 * Сегодняшние адаптеры аргумент не читают (поведение не меняется), форма нужна
 * вызывающей стороне и наследникам, которым понадобится ограничить выборку.
 */
interface ExtractOptions {
  /** Включать скрытые узлы (display:none/aria-hidden) в выборку. */
  includeHidden?: boolean;
  /** Верхняя граница числа сообщений (0/undefined — без ограничения). */
  limit?: number;
}

/**
 * Публичный контракт адаптера сайта (зеркало types/adapter.d.ts::Adapter).
 * База реализует его, наследники переопределяют методы.
 */
interface Adapter {
  /** Название сайта (у базы 'base', наследники переопределяют). */
  siteName: string;
  /** Селектор контейнера с диалогами. */
  dialogContainerSelector: string;
  /** Селектор сообщений пользователя. */
  userMessageSelector: string;
  /** Селектор сообщений модели. */
  modelMessageSelector: string;
  /** Находимся ли мы на странице диалога этого сайта. */
  isOnDialogPage(): boolean;
  /** Извлекает все сообщения из диалога. */
  extractMessages(options?: ExtractOptions): Message[];
  /** Собирает полный текст диалога для оценки токенов. */
  getFullDialogText(): string;
  /** Количество сообщений в диалоге. */
  getMessageCount(): number;
  /** Название модели ИИ по DOM (если возможно) или null. */
  detectModel(): string | null;
}

/** BaseAdapter — реализация контракта Adapter. */
class BaseAdapter implements Adapter {
  /** Название сайта (будет переопределено в наследниках). */
  siteName: string;
  /** Селектор контейнера с диалогами (переопределить в наследнике). */
  dialogContainerSelector: string;
  /** Селектор сообщений пользователя (переопределить). */
  userMessageSelector: string;
  /** Селектор сообщений модели (переопределить). */
  modelMessageSelector: string;

  constructor() {
    this.siteName = 'base';

    this.dialogContainerSelector = '';

    this.userMessageSelector = '';
    this.modelMessageSelector = '';
  }

  /**
   * Проверяет, находимся ли мы на странице диалога этого сайта.
   */
  isOnDialogPage(): boolean {
    throw new Error('Метод isOnDialogPage() должен быть переопределён');
  }

  /**
   * Извлекает все сообщения из диалога.
   * Аргумент опций не читается — поведение то же, что до типизации.
   */
  extractMessages(_options?: ExtractOptions): Message[] {
    throw new Error('Метод extractMessages() должен быть переопределён');
  }

  /**
   * Собирает полный текст диалога для оценки токенов.
   */
  getFullDialogText(): string {
    const messages = this.extractMessages();
    return messages.map(msg => msg.content).join('\\n');
  }

  /**
   * Возвращает количество сообщений в диалоге.
   */
  getMessageCount(): number {
    return this.extractMessages().length;
  }

  /**
   * Определяет модель ИИ по DOM (если возможно).
   * @returns название модели или null
   */
  detectModel(): string | null {
    return null; // По умолчанию не умеем определять
  }

  /**
   * Безопасное получение текста из элемента.
   */
  _getTextContent(element: Element | null): string {
    return element ? element.textContent.trim() : '';
  }

  /**
   * Безопасный querySelector с проверкой.
   * @param parent - Document по умолчанию
   */
  _safeQuerySelector(selector: string, parent: Document | Element = document): Element | null {
    try {
      return parent.querySelector(selector);
    } catch (e) {
      aiCmDiagWarn('adapter:base:safeQuerySelector', `Ошибка селектора "${selector}":`, e);
      return null;
    }
  }

  /**
   * Безопасный querySelectorAll с проверкой.
   * Ветка ошибки возвращает пустой массив: у NodeList есть .item(), у массива нет,
   * поэтому форма возврата — объединение, а потребители берут только .length и срез
   * в массив (Array.prototype.slice.call в qwen-adapter.ts), где годятся обе формы.
   * @param parent - Document по умолчанию
   */
  _safeQuerySelectorAll(selector: string, parent: Document | Element = document): NodeListOf<Element> | Element[] {
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
