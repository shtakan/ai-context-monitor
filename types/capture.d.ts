/**
 * Контракт шва capture (ARCHITECTURE-2.2 §3.1).
 *
 * Это ЦЕЛЕВАЯ форма, а не описание текущего кода: файл не подключается к
 * рантайму и не заменяет старые типы (types/adapter.d.ts, types/export.d.ts,
 * types/message.d.ts). До фазы 6 старый путь живёт рядом.
 *
 * Владелец PlatformId/CaptureKind/RawNodeType — этот файл. canonical.d.ts
 * импортирует PlatformId/CaptureKind как типы (не копирует), чтобы один факт
 * рождался один раз.
 *
 * Правила capture (обязательны для адаптеров и MAIN-перехватчиков):
 *  1. Источник не решает, что попадёт в тело ответа. Он классифицирует узел
 *     (nodeType) и отдаёт его с провенансом; состав тела — забота messages.
 *  2. convId и routeKey обязательны для любого батча, кроме native-counter
 *     (там достаточно convId). Батч без идентичности не принимается.
 *  3. Порядок задаёт ordinal. DOM-индекс, порядок прихода SSE и порядок
 *     mapping не являются порядком экспорта.
 *  4. complete — заявление источника, а не приговор: messages вправе понизить
 *     полноту, но не повысить её без второго подтверждения.
 */

/**
 * Платформа-источник. Ровно восемь поддерживаемых сайтов; `gsa` — Google
 * Search AI, `aistudio` — Google AI Studio.
 */
export type PlatformId =
  | 'chatgpt'
  | 'gemini'
  | 'aistudio'
  | 'deepseek'
  | 'claude'
  | 'perplexity'
  | 'qwen'
  | 'gsa';

/**
 * Канал захвата. Различает провенанс одного и того же треда:
 *  - `dom` — видимые узлы страницы;
 *  - `net` — сетевой ответ/SSE/mapping;
 *  - `passive` — пассивный перехват (без собственного запроса);
 *  - `loader` — догрузка по скроллу/пагинации;
 *  - `archive` — импортированный архив;
 *  - `native-counter` — счётчик токенов платформы (число без текста);
 *  - `files` — вложения/файлы, отданные платформой.
 */
export type CaptureKind =
  | 'dom'
  | 'net'
  | 'passive'
  | 'loader'
  | 'archive'
  | 'native-counter'
  | 'files';

/**
 * Классификация сырого узла ДО канонизации. `reasoning` — отдельный тип:
 * размышление не является текстом ответа и позже едет в поле CanonicalMessage.reasoning.
 * `ui`/`system` — служебные поверхности (баннеры, ошибки, эхо запроса).
 */
export type RawNodeType =
  | 'message'
  | 'tool'
  | 'file'
  | 'artifact'
  | 'reasoning'
  | 'source'
  | 'ui'
  | 'system';

/**
 * Идентичность и провенанс батча. routeKey — нормализованный ключ маршрута
 * (`prompts/<id>`, `c/<id>`, `search?thread=<id>`), а не сырой URL: он должен
 * переживать SPA-переходы и query-шум.
 */
export interface CaptureRef {
  platform: PlatformId;
  kind: CaptureKind;

  /** id треда платформы; null только до его получения (архив/файлы). */
  convId: string | null;

  /** Нормализованный ключ маршрута: prompts/<id>, c/<id>, search?thread=<id>. */
  routeKey: string;

  /** Момент захвата, мс epoch. */
  capturedAt: number;
}

/**
 * Сырое сообщение источника. Поля опциональны осознанно: сеть, DOM и архив
 * отдают разные подмножества, а классификацию выполняет capture, не messages.
 */
export interface RawMessage {
  /** Платформенный id узла/хода, если он есть. */
  id?: string | number;

  /** Сырая роль (author.role, класс узла, 'human'): приводит messages. */
  role?: string;

  /** Сырой текст узла (до очистки от tool/source/UI-маркеров). */
  text?: string;

  /** Порядковый номер внутри источника; не DOM-индекс. */
  ordinal?: number;

  /** Классификация узла: message/tool/file/artifact/reasoning/source/ui/system. */
  nodeType?: RawNodeType;

  /** Дополнительные поля источника (turnId, model, attachments, …). */
  meta?: Record<string, unknown>;
}

/**
 * Единица передачи от источника к шву messages.
 *
 * `v: 1` — версия формы батча; повышается только вместе с контрактом.
 * `dropped` — счётчики отброшенного для диагностики (не для текста файла).
 * `diagnostics` — произвольные факты источника (route, fetch state, …);
 * потребители не обязаны их понимать.
 */
export interface CaptureBatch extends CaptureRef {
  v: 1;

  /** Заявление источника о полноте; messages может только понизить его. */
  complete: boolean;

  messages: RawMessage[];

  /** Счётчики отброшенного — для диагностики, не для текста. */
  dropped?: Partial<Record<RawNodeType, number>>;

  diagnostics?: Record<string, unknown>;
}
