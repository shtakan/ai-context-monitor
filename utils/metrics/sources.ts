/**
 * metrics/sources — сбор MetricReading из УЖЕ СНЯТЫХ значений.
 *
 * Шов metrics (ARCHITECTURE-2.2 §3.3, фаза 2): модуль чистый, DOM/storage/
 * chrome не читает. Чтение native-счётчика, сети, базы и DOM остаётся в
 * core/content.ts; сюда приходит плоский probe, обратно — массив чтений.
 * Выбор чтения (политика платформы) — в metrics/snapshot.ts, а не здесь:
 * sources не имеет права решать, какой источник главнее.
 */

import type { MetricKind, MetricPrecision, MetricReading } from '../../types/metrics';

/** Одно уже измеренное значение канала. 0/undefined — канала нет. */
export interface MetricProbe {
  convId?: string | null;
  capturedAt: number;

  /** Счётчик платформы (AI Studio: span.v3-token-count-value). */
  nativeTokens?: number;
  /** usage из сетевого ответа / счётчик шапки, не native. */
  serverTokens?: number;
  /** Доверенная база расширения (baseComplete/baseSeen). */
  baseTokens?: number;
  /** Оценка по видимому DOM (может быть виртуализирована). */
  domTokens?: number;
  /** Эвристика токенизатора по каноническому тексту. */
  estimateTokens?: number;

  bodyHash?: string;
  /** Полнота базы: влияет на coverage base/server, не на точность числа. */
  baseComplete?: boolean;

  /** Человекочитаемые имена источников для поля source. */
  nativeSource?: string;
  serverSource?: string;
  baseSource?: string;
  domSource?: string;
  estimateSource?: string;
}

/** Нормализация числа: только конечное положительное, округлённое. */
function positiveInt(value: unknown): number {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/**
 * Собирает чтения в стабильном порядке каналов: native → server → base → dom
 * → estimate. Отсутствующие/нулевые каналы не попадают в массив.
 */
export function collectMetricReadings(probe: MetricProbe | null | undefined): MetricReading[] {
  const out: MetricReading[] = [];
  if (!probe) return out;
  const convId = (typeof probe.convId === 'string' && probe.convId) ? probe.convId : null;
  const capturedAt = (typeof probe.capturedAt === 'number' && isFinite(probe.capturedAt)) ? probe.capturedAt : 0;
  const baseFull = probe.baseComplete === true;

  function add(kind: MetricKind, tokens: number, precision: MetricPrecision, coverage: 'full' | 'partial', source: string): void {
    if (tokens <= 0) return;
    const reading: MetricReading = {
      kind: kind,
      tokens: tokens,
      precision: precision,
      coverage: coverage,
      convId: convId,
      capturedAt: capturedAt,
      source: source
    };
    if (probe && typeof probe.bodyHash === 'string' && probe.bodyHash) reading.bodyHash = probe.bodyHash;
    out.push(reading);
  }

  add('native', positiveInt(probe.nativeTokens), 'exact', 'full',
    probe.nativeSource || 'native');
  add('server', positiveInt(probe.serverTokens), 'reported', baseFull ? 'full' : 'partial',
    probe.serverSource || 'server');
  add('base', positiveInt(probe.baseTokens), 'derived', baseFull ? 'full' : 'partial',
    probe.baseSource || 'base');
  // DOM всегда partial: платформа виртуализирует ленту, видимый хвост не равен треду.
  add('dom', positiveInt(probe.domTokens), 'derived', 'partial',
    probe.domSource || 'dom');
  add('estimate', positiveInt(probe.estimateTokens), 'floor', 'partial',
    probe.estimateSource || 'estimate');

  return out;
}
