/**
 * Контракт шва messages (ARCHITECTURE-2.2 §3.2).
 *
 * Целевая форма канонического треда: вход — CaptureBatch[], выход — один
 * CanonicalThread с полнотой и провенансом. Файл только декларирует формы,
 * к живому пути не подключён (до фазы 1 AI Studio, затем Gemini/Qwen).
 *
 * Владелец платформенных литералов — types/capture.d.ts; здесь они
 * импортируются как типы, чтобы PlatformId/CaptureKind не разошлись.
 *
 * Правила messages (обязательны для всех платформ):
 *  1. Роль — из структуры (author.role, класс узла, тип контента), не из текста.
 *     Текстовые эвристики допустимы только для восстановления user-хода.
 *  2. tool/file/system/UI не становятся assistant.text: они либо отбрасываются
 *     (со счётчиком droppedNodes), либо едут в kind tool/file/artifact/source.
 *  3. Один ход = один user + один assistant. Соседние assistant-сегменты одного
 *     хода склеиваются '\n\n'; граница хода — user-узел или смена turnId,
 *     а не пауза.
 *  4. reasoning — отдельное поле. В text он попадает только на проекции и ровно
 *     один раз (контракт [REASONING]/[ANSWER] сохраняется).
 *  5. Дедуп по id, затем по (turnId, role, нормализованный текст). Хвост после
 *     SPA не добавляется, если такой блок уже есть; порядок не переставляется.
 *  6. Live и reload — два представления одного треда. reconcile() выбирает
 *     более полное по id/ordinal, при равенстве — по приоритету источника
 *     (net > passive > dom); расхождение текста идёт в диагностику, а не
 *     смешивается половинами.
 *  7. Никаких молчаливых потерь: каждый отброшенный узел увеличивает
 *     droppedNodes, каждый невосстановленный user-ход — missingUserTurns.
 */

import type { CaptureKind, PlatformId } from './capture';

/**
 * Тип канонического сообщения. В отличие от RawNodeType здесь нет 'reasoning'
 * (размышление — поле сообщения) и 'message' — это основной вид.
 */
export type MessageKind =
  | 'message'
  | 'tool'
  | 'file'
  | 'artifact'
  | 'source'
  | 'ui'
  | 'system';

/** Роль хода после структурной классификации. */
export type Role = 'user' | 'assistant';

/**
 * Словарь причин неполноты (S2.3/ADR-001). Новые причины добавляются только
 * здесь; файл несёт metric-partial: 1 и причину (инвариант I4).
 */
export type PartialReason =
  | 'incomplete'
  | 'stale'
  | 'shrank'
  | 'missing-user-text'
  | 'stopped'
  | 'truncated';

/**
 * Полнота треда. Отдельная ось от точности метрики (см. MetricQuality):
 * quality=floor может быть при complete=true и наоборот.
 */
export interface Completeness {
  complete: boolean;
  reasons: PartialReason[];

  /** Сколько tool/file-узлов отброшено или вынесено в секции. */
  droppedNodes?: number;

  /** Сколько user-ходов восстановить не удалось. */
  missingUserTurns?: number;
}

/**
 * Откуда пришло сообщение. Один CanonicalMessage может иметь несколько
 * провенансов (live + reload), поэтому в сообщении это массив.
 */
export interface Provenance {
  kind: CaptureKind;
  capturedAt: number;
  convId: string | null;
}

/**
 * Каноническое сообщение: только содержательный текст плюс отдельные поля
 * reasoning/artifact. tool/file/source сюда не попадают.
 */
export interface CanonicalMessage {
  /** Стабильный id: платформенный, иначе (turnId, seq, role, hash). */
  id: string;

  /** id хода, к которому относится сообщение. */
  turnId: string;

  /** Порядок внутри хода/треда (не DOM-индекс). */
  seq: number;

  role: Role;
  kind: MessageKind;

  /** Только содержательный текст. Tool/file/source сюда не попадают. */
  text: string;

  /** Размышление отдельным полем (правило 4). */
  reasoning?: string;

  /** Артефакт (Claude artifacts, сгенерированные файлы) отдельной секцией. */
  artifact?: { name: string; mime?: string; content?: string };

  /** Все источники, из которых собрано сообщение (live/reload/archive). */
  provenance: Provenance[];

  /** Хэш нормализованного текста: дедуп и проверка воспроизводимости (I2). */
  hash: string;
}

/**
 * Ход треда. user/assistant могут быть null: assistant — пока ответ не пришёл,
 * user — если вопрос восстановить не удалось (учитывается в Completeness).
 */
export interface CanonicalTurn {
  id: string;
  user: CanonicalMessage | null;
  assistant: CanonicalMessage | null;

  /** Сегменты ответа до склейки — нужны для диагностики и artifacts. */
  segments?: CanonicalMessage[];
}

/**
 * Канонический тред — единственный вход для metrics и export.
 *
 * messages — плоский хронологический список тех же сообщений, что в turns;
 * он нужен потребителям, которые не работают с ходами (снимок/файл), и обязан
 * быть согласован с turns (инвариант I3).
 */
export interface CanonicalThread {
  convId: string | null;
  platform: PlatformId;
  model?: string;
  turns: CanonicalTurn[];
  messages: CanonicalMessage[];
  completeness: Completeness;
}
