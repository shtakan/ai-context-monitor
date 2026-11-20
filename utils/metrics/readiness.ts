/**
 * metrics/readiness — выбор чтения по политике платформы и подача числа.
 *
 * Правила (ARCHITECTURE-2.2 §3.3):
 *  - выбор источника фиксирует политика платформы, а не глобальный max();
 *  - floor не показывается как факт (I7): readiness=provisional, пока число
 *    не точное/не reported и покрытие не полное;
 *  - полнота и точность — разные оси: complete=true не делает floor точным.
 *
 * Модуль чистый: вход — данные, выход — данные.
 */

import type { Completeness } from '../../types/canonical';
import type { MetricKind, MetricQuality, MetricReading } from '../../types/metrics';

/** Политика выбора чтения. Имена платформ сюда не попадают — только поведение. */
export type MetricPolicy = 'native-first' | 'server-first' | 'reload-fuller' | 'legacy';

export type MetricReadiness = 'no-data' | 'collecting' | 'provisional' | 'settled';

const ORDER: Record<Exclude<MetricPolicy, 'reload-fuller' | 'legacy'>, MetricKind[]> = {
  'native-first': ['native', 'server', 'base', 'dom', 'estimate'],
  'server-first': ['server', 'native', 'base', 'dom', 'estimate']
};

function findKind(readings: MetricReading[], kind: MetricKind): MetricReading | null {
  for (let i = 0; i < readings.length; i++) {
    if (readings[i] && readings[i].kind === kind) return readings[i];
  }
  return null;
}

function firstPresent(readings: MetricReading[], order: MetricKind[]): MetricReading | null {
  for (let i = 0; i < order.length; i++) {
    const found = findKind(readings, order[i]);
    if (found) return found;
  }
  return null;
}

/**
 * Выбирает одно чтение.
 *
 * `preferredKind` — для legacy-паритета: старый снимок уже назвал источник
 * (src=server|net|dom), и dual-run обязан сравнить тот же канал, а не
 * подменить его «лучшим».
 */
export function pickMetricReading(
  readings: MetricReading[] | null | undefined,
  policy: MetricPolicy,
  preferredKind?: MetricKind
): MetricReading | null {
  const list = Array.isArray(readings) ? readings : [];
  if (list.length === 0) return null;

  if (policy === 'legacy') {
    if (preferredKind) {
      const preferred = findKind(list, preferredKind);
      if (preferred) return preferred;
    }
    return firstPresent(list, ['native', 'server', 'base', 'dom', 'estimate']);
  }

  if (policy === 'reload-fuller') {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r && r.coverage === 'full' && r.kind !== 'estimate') return r;
    }
    return firstPresent(list, ['native', 'server', 'base', 'dom', 'estimate']);
  }

  return firstPresent(list, ORDER[policy] || ORDER['native-first']);
}

/**
 * Качество числа: stale сильнее точности (устаревшее число нельзя подавать
 * как факт), иначе — точность самого чтения. Нет чтения → floor.
 */
export function qualityForReading(
  reading: MetricReading | null | undefined,
  completeness?: Completeness | null
): MetricQuality {
  if (completeness && Array.isArray(completeness.reasons) && completeness.reasons.indexOf('stale') !== -1) {
    return 'stale';
  }
  if (!reading) return 'floor';
  if (reading.precision === 'exact') return 'exact';
  if (reading.precision === 'reported') return 'reported';
  if (reading.precision === 'derived') return 'derived';
  return 'floor';
}

/**
 * Готовность бейджа. AI Studio не должна залипать в `collecting` при живой
 * метрике: если чтение есть, но база неполная — это provisional, а не сбор.
 */
export function readinessForReading(
  reading: MetricReading | null | undefined,
  completeness?: Completeness | null
): MetricReadiness {
  if (!reading) {
    return (completeness && completeness.complete === false) ? 'collecting' : 'no-data';
  }
  // settled — только для факта: native exact или server reported. derived (base/dom
  // по символам) — оценка, даже при complete=true: F1 живой приёмки 2.2 показал
  // 683 при фактических 3 484. floor — тем более provisional (I7).
  if (reading.precision === 'derived' || reading.precision === 'floor') return 'provisional';
  if (reading.coverage !== 'full') return 'provisional';
  if (completeness && completeness.complete === true) return 'settled';
  return 'provisional';
}
