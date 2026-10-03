/**
 * Типы адаптера сайта (предметная область adapters/).
 *
 * Формы выведены из adapters/base-adapter.js: свойства конструктора и публичные методы
 * BaseAdapter. Внутренние underscore-хелперы (_getTextContent, _safeQuerySelector,
 * _safeQuerySelectorAll) — деталь реализации базового класса, в контракт не входят.
 *
 * Важно: extractMessages() возвращает ExtractedMessage (поле content), а не нормализованный
 * Message из types/message.d.ts (поле text) — это разные формы, поэтому импорта здесь нет.
 */

/** Сообщение в форме адаптера: возвращается BaseAdapter.extractMessages(). */
export interface ExtractedMessage {
  role: string;
  content: string;
}

/** Публичный интерфейс адаптера сайта (паттерн Strategy). */
export interface Adapter {
  /** Название сайта (BaseAdapter: 'base', переопределяется в наследниках). */
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
  extractMessages(): ExtractedMessage[];

  /** Собирает полный текст диалога для оценки токенов. */
  getFullDialogText(): string;

  /** Количество сообщений в диалоге. */
  getMessageCount(): number;

  /** Название модели ИИ по DOM (если возможно) или null. */
  detectModel(): string | null;
}
