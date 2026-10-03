/**
 * Типы записи архива диалогов (хранилище aiCmHistory).
 *
 * Форма выведена из tests/storage-ttl.test.js, функция historyFixture(): записи вида
 * 'aiCmHistory:<host>' со значениями { host, convId, site, ts, messages }.
 *
 * Модуль самодостаточен: импортов нет. Сообщение архивной формы ({ role, content }) —
 * это форма адаптера (ExtractedMessage), а НЕ нормализованный Message из types/message.d.ts
 * (там поле text). Формы разные, смешивать нельзя.
 */

/** Сообщение в архивной форме (локальный alias: циклический импорт не создаём). */
export type ArchiveMessage = { role: string; content: string };

/** Запись архива диалогов, сохраняемая в chrome.storage. */
export interface ArchiveRecord {
  /** Домен сайта. */
  host: string;

  /** Идентификатор разговора. */
  convId: string;

  /** Идентификатор сервиса ('chatgpt', 'claude', 'gemini', …; не литеральный union). */
  site: string;

  /**
   * UNIX-время в миллисекундах.
   * Опционально: запись прежней версии (без ts) — валидная legacy-форма, не ошибка
   * (prune TTL такие записи не удаляет, см. historyFixture).
   */
  ts?: number;

  /** Массив сообщений в архивной форме. */
  messages: ArchiveMessage[];
}
