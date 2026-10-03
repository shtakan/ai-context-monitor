/**
 * Типы сообщения диалога (нормализованная форма экспортного конвейера).
 *
 * Формы выведены из utils/export-emit-pipeline.js:
 *   - normalizeExportMessages(raw) — приведение источника к { role, text };
 *   - dedupeMessages(messages) — перенос id хода при схлопывании дублей (E-2.1);
 *   - applyReasoningExportFields(messages, enabled) — поле reasoning (O-37);
 *   - hasHiddenFields(message) / hiddenReasoningOf(message) — служебные поля захвата (O-7).
 *
 * Модуль самодостаточен: импортов нет (осознанно — каждый тип читается независимо).
 */

/** Роль хода в нормализованной форме: 'human' (парсер Claude) приводится к 'user'. */
export type MessageRole = 'user' | 'assistant';

/** Сообщение диалога после нормализации (форма { role, text }). */
export interface Message {
  /** Нормализованная роль (normalizeExportMessages: 'user' | 'human' → 'user'). */
  role: MessageRole;

  /** Текст сообщения (входные text || content). Пустые тексты отбрасывает нормализатор. */
  text: string;

  /** Идентификатор хода. Переносится dedupeMessages/dedupeCrossRawCopies при m.id != null. */
  id?: string | number;

  /** Размышление отдельным полем (applyReasoningExportFields, контракт O-35/O-37). */
  reasoning?: string;

  /** Размышление скрытого DOM-захвата (O-7). В text НЕ входит, в экспорт — по тумблеру. */
  hiddenReasoning?: string;

  /** Служебное поле захвата инъекций (hasHiddenFields). Форма в прочитанном коде не раскрыта. */
  hiddenInjection?: unknown;
}
