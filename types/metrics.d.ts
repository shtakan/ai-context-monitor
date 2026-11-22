/**
 * Контракт шва metrics (ARCHITECTURE-2.2 §3.3).
 *
 * Целевая форма метрики: вход — CanonicalThread + MetricReading[] + LimitModel,
 * выход — один MetricSnapshot. Файл только декларирует формы; живой путь
 * (core/state.ts + core/content.ts) не меняется до фазы 2 (пилот AI Studio).
 *
 * Полнота берётся из messages (types/canonical.d.ts) как есть: полнота и
 * точность — разные оси и не выводятся друг из друга.
 *
 * Правила metrics:
 *  1. Один писатель, один читатель (ADR-001): пишет aiCmCommitContextSnapshot,
 *     читают бейдж/панель/история/экспорт.
 *  2. Иерархия native > server > base > dom > estimate, но выбор фиксируется
 *     политикой платформы, а не глобальным max(). Примеры: AI Studio — native;
 *     Qwen — последний input serverTokens (кумулятивен); Perplexity — reload
 *     полнее live.
 *  3. Точность обязательна: floor не может быть единственным числом бейджа —
 *     либо ~N, либо «оценка» в тултипе + readiness=provisional.
 *  4. Лимиты разделены: modelWindow, displayLimit, accountLimit — три поля,
 *     три подписи. 128 000 не подставляется вместо окна 1M.
 *  5. Модель — только из slug/селектора/сети; текст треда не источник модели.
 *  6. percent = tokens / displayLimit (вариант C+); авто-100 % по баннеру не
 *     вводится.
 *  7. Полнота и точность — разные оси (quality=floor при complete=true — норма).
 */

import type { Completeness } from './canonical';

/**
 * Канал, из которого получено число:
 *  - `native` — счётчик самой платформы (AI Studio span.v3-token-count-value);
 *  - `server` — usage из сетевого ответа (prompt_tokens/GenerateContent);
 *  - `base` — доверенная база (baseComplete/история расширения);
 *  - `dom` — вычисление по видимому DOM;
 *  - `estimate` — эвристика токенизатора.
 */
export type MetricKind = 'native' | 'server' | 'base' | 'dom' | 'estimate';

/** Как получено число: точное, заявленное сервером, производное, нижняя граница. */
export type MetricPrecision = 'exact' | 'reported' | 'derived' | 'floor';

/**
 * Итоговое качество снимка. Надмножество MetricPrecision: добавляет `stale`,
 * когда число устарело относительно текущего треда. `floor` не показывается
 * как точное значение (инвариант I7).
 */
export type MetricQuality = 'exact' | 'reported' | 'derived' | 'floor' | 'stale';

/**
 * Одно чтение метрики. Несколько чтений одного треда живут рядом, выбор
 * делает политика платформы в metrics/snapshot, а не max().
 */
export interface MetricReading {
  kind: MetricKind;
  tokens: number;
  precision: MetricPrecision;

  /** Полное или частичное покрытие треда данным чтением. */
  coverage: 'full' | 'partial';

  convId: string | null;

  /** Хэш тела, к которому относится чтение (I2). */
  bodyHash?: string;

  capturedAt: number;

  /** Человекочитаемый источник: 'span.v3-token-count-value', 'usage.prompt_tokens', … */
  source: string;
}

/**
 * Источник значения лимита. Порядок приоритета (2.2, фаза 5):
 * API → каталог платформ/планов → настройки → fallback.
 */
export type LimitSource = 'api' | 'catalog' | 'settings' | 'fallback';

/**
 * Покомпонентный источник полей LimitModel. `null` — поле неизвестно,
 * а не «взято из fallback»: это разные факты.
 */
export interface LimitProvenance {
  modelWindow: LimitSource | null;
  displayLimit: LimitSource | null;
  accountLimit: LimitSource | null;
  plan: LimitSource | null;
}

/**
 * Модель лимитов. Три подписи в UI/файле соответствуют трём разным фактам:
 * окно модели, порог показа и лимит плана (инвариант I9).
 */
export interface LimitModel {
  modelId?: string;

  /** Окно модели в токенах (например, 1 048 576). */
  modelWindow: number;

  /** true — окно известно (API/каталог); false — подставлен запасной порог. */
  windowKnown?: boolean;

  /** Порог показа: min(modelWindow, accountLimit) либо ручной порог. */
  displayLimit: number;

  /** Лимит плана, если платформа его сообщает. */
  accountLimit?: number | null;

  plan?: string | null;

  /**
   * Источники числовых значений (окно/лимит/порог) — в порядке фактического
   * использования. Источник тарифа — отдельно в `provenance.plan`.
   */
  sources: LimitSource[];

  /** Источник каждого поля: отделяет «неизвестно» от «fallback». */
  provenance?: LimitProvenance;

  /**
   * Машиночитаемые пометки для UI/файла:
   * `plan-unknown`, `account-limit-unknown`, `window-unknown`, `fallback-display`.
   */
  warnings?: string[];

  /** Человекочитаемая пометка каталога: что известно и чего нет. */
  sourceNote?: string;
}

/**
 * Снимок метрики — то, что читают бейдж, панель, история и экспорт.
 *
 * readiness управляет подачей числа: `no-data` — числа нет; `collecting` —
 * идёт сбор; `provisional` — есть только floor/частичное покрытие (показывать
 * как оценку); `settled` — число можно показывать как факт.
 */
export interface MetricSnapshot {
  convId: string;
  capturedAt: number;
  tokens: number;
  limit: number;
  percent: number;
  quality: MetricQuality;
  readings: MetricReading[];
  limitModel: LimitModel;
  completeness: Completeness;
  bodyHash?: string;

  /** Готовность бейджа: floor не показывается как окончательное число. */
  readiness: 'no-data' | 'collecting' | 'provisional' | 'settled';
}
