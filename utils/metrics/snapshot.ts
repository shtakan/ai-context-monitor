/**
 * metrics/snapshot — единственный сборщик MetricSnapshot из чтений и LimitModel.
 *
 * Вход — данные (readings, limits, completeness), выход — снимок. Никакого
 * DOM/storage/chrome: оркестрация остаётся в core/content.ts. Процент считается
 * ровно по контракту C+: tokens / displayLimit, округление как у legacy-бейджа
 * (0.1 п.п.).
 *
 * Сравнение с legacy — только диагностика dual-run; живой писатель снимка
 * (core/state.ts: aiCmCommitContextSnapshot) не меняется, пока флаг metrics
 * не включён и фаза не принята.
 */

import type { Completeness } from '../../types/canonical';
import type { LimitModel, MetricKind, MetricReading, MetricSnapshot } from '../../types/metrics';
import {
  pickMetricReading,
  qualityForReading,
  readinessForReading
} from './readiness';
import type { MetricPolicy, MetricReadiness } from './readiness';

export interface MetricSnapshotInput {
  convId: string;
  capturedAt: number;
  readings: MetricReading[];
  limitModel: LimitModel;
  completeness?: Completeness | null;
  bodyHash?: string;
  policy?: MetricPolicy;
  /** Для policy='legacy': канал, который выбрал старый путь. */
  preferredKind?: MetricKind;
}

/** Тело legacy-снимка, с которым сравнивается новый (структурный минимум). */
export interface LegacyMetricView {
  convId?: string;
  tokens?: number;
  limit?: number;
  percent?: number;
  src?: string;
  bodyHash?: string;
  baseComplete?: boolean;
}

export interface MetricDiff {
  verdict: 'same' | 'diff';
  /** Имена полей, где значения разошлись. */
  fields: string[];
}

function roundPercent(tokens: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.round((tokens / limit) * 1000) / 10;
}

/**
 * Собирает снимок. Если чтений нет — tokens/percent = 0, quality='floor',
 * readiness по полноте; потребитель обязан смотреть на readiness, а не на 0.
 */
export function buildMetricSnapshot(input: MetricSnapshotInput): MetricSnapshot {
  const readings = Array.isArray(input.readings) ? input.readings : [];
  const policy = input.policy || 'native-first';
  const reading = pickMetricReading(readings, policy, input.preferredKind);
  const tokens = reading ? reading.tokens : 0;
  const limit = (input.limitModel && input.limitModel.displayLimit > 0)
    ? input.limitModel.displayLimit : 0;
  const quality = qualityForReading(reading, input.completeness);
  const readiness: MetricReadiness = readinessForReading(reading, input.completeness);
  const completeness: Completeness = input.completeness
    ? input.completeness
    : { complete: false, reasons: [] };

  const snapshot: MetricSnapshot = {
    convId: input.convId,
    capturedAt: input.capturedAt,
    tokens: tokens,
    limit: limit,
    percent: roundPercent(tokens, limit),
    quality: quality,
    readings: readings,
    limitModel: input.limitModel,
    completeness: completeness,
    readiness: readiness
  };
  if (typeof input.bodyHash === 'string' && input.bodyHash) snapshot.bodyHash = input.bodyHash;
  else if (reading && typeof reading.bodyHash === 'string' && reading.bodyHash) snapshot.bodyHash = reading.bodyHash;
  return snapshot;
}

function normalizedHash(value: unknown): string {
  return (typeof value === 'string') ? value : '';
}

/**
 * Сравнивает новый снимок с legacy по наблюдаемым полям. `quality/readiness`
 * сравниваются только если legacy их знает (старый снимок их не несёт).
 */
export function compareMetricSnapshots(
  legacy: LegacyMetricView | null | undefined,
  next: MetricSnapshot | null | undefined
): MetricDiff {
  if (!legacy || !next) return { verdict: 'diff', fields: ['snapshot'] };
  const fields: string[] = [];
  if (typeof legacy.tokens === 'number' && legacy.tokens !== next.tokens) fields.push('tokens');
  if (typeof legacy.limit === 'number' && legacy.limit !== next.limit) fields.push('limit');
  if (typeof legacy.percent === 'number' && legacy.percent !== next.percent) fields.push('percent');
  if (typeof legacy.bodyHash === 'string' && normalizedHash(legacy.bodyHash) !== normalizedHash(next.bodyHash)) fields.push('bodyHash');
  if (typeof legacy.baseComplete === 'boolean' && legacy.baseComplete !== next.completeness.complete) fields.push('completeness');
  return { verdict: fields.length ? 'diff' : 'same', fields: fields };
}
