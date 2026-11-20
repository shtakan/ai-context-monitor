/**
 * 2.2 / фаза 2: dual-run метрики AI Studio.
 *
 * Новый шов (utils/metrics/*) собирает MetricSnapshot из уже снятых значений,
 * старый путь (core/content.ts + core/state.ts) продолжает писать снимок
 * байтово как раньше. Этот модуль только сравнивает и логирует — ни снимок,
 * ни бейдж, ни файл не меняются. Включение:
 *   sessionStorage['aiCmV2Metrics']='1' или chrome.storage.local.aiCmV2.metrics=true.
 */

import { collectMetricReadings } from '../utils/metrics/sources';
import type { MetricProbe } from '../utils/metrics/sources';
import { resolveLimitModel } from '../utils/metrics/limits';
import type { LimitProbe } from '../utils/metrics/limits';
import { buildMetricSnapshot, compareMetricSnapshots } from '../utils/metrics/snapshot';
import type { LegacyMetricView, MetricDiff } from '../utils/metrics/snapshot';
import type { MetricSnapshot } from '../types/metrics';
import type { Completeness } from '../types/canonical';
import { debugLog, swallowSoft } from '../utils/debug';

/** Legacy-снимок, который уже посчитал старый путь. */
export interface AiCmV2LegacyMetric extends LegacyMetricView {
  partial?: boolean;
}

/** Проба: чтения + лимиты + платформа. Читается в content.ts, сюда приходит данными. */
export interface AiCmV2MetricsProbe extends MetricProbe, LimitProbe {
  site?: string;
  partial?: boolean;
}

export interface AiCmV2MetricsResult {
  snapshot: MetricSnapshot;
  diff: MetricDiff;
}

let storageFlag = false;
let storageRequested = false;
let lastSignature = '';

function sessionFlag(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('aiCmV2Metrics') === '1';
  } catch (eSession) {
    return false;
  }
}

/** Включён ли dual-run метрики. sessionStorage — живой тумблер, storage — один раз. */
export function aiCmV2MetricsEnabled(): boolean {
  if (!storageRequested) loadStorageFlag();
  return sessionFlag() || storageFlag;
}

function loadStorageFlag(): void {
  if (storageRequested) return;
  storageRequested = true;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get('aiCmV2', function (data: Record<string, any>) {
      const cfg = data && data.aiCmV2;
      storageFlag = !!(cfg && cfg.metrics === true);
      if (storageFlag) debugLog('log', '[AI CM][v2-metrics] flag=on source=storage');
    });
  } catch (eFlag) {
    swallowSoft(eFlag, 'content:v2-metrics-flag');
  }
}

function preferredKindOf(src: string | undefined): 'server' | 'base' | 'dom' | undefined {
  if (src === 'server') return 'server';
  if (src === 'net') return 'base';
  if (src === 'dom') return 'dom';
  return undefined;
}

function completenessOf(probe: AiCmV2MetricsProbe): Completeness {
  const complete = probe.baseComplete === true && probe.partial !== true;
  // Причина — только когда известно, что база неполная; полный тред не носит причин.
  const reasons: Completeness['reasons'] = complete ? [] : ['incomplete'];
  return { complete: complete, reasons: reasons };
}

function readingsList(snapshot: MetricSnapshot): string {
  return snapshot.readings.map(function (r) { return r.kind + ':' + r.tokens; }).join(',') || '-';
}

/**
 * Сравнивает новый снимок с legacy. Возвращает null, если флаг выключен или
 * сайт не AI Studio (пилот фазы 2). Никогда не бросает и не меняет legacy.
 */
export function aiCmV2MetricsDualRun(
  legacy: AiCmV2LegacyMetric | null | undefined,
  probe: AiCmV2MetricsProbe | null | undefined
): AiCmV2MetricsResult | null {
  if (!aiCmV2MetricsEnabled()) return null;
  if (!legacy || !probe || probe.site !== 'aistudio') return null;
  loadStorageFlag();
  try {
    const readings = collectMetricReadings(probe);
    const limitModel = resolveLimitModel(probe);
    const completeness = completenessOf(probe);
    const snapshot = buildMetricSnapshot({
      convId: (typeof legacy.convId === 'string' && legacy.convId) ? legacy.convId : (probe.convId || ''),
      capturedAt: probe.capturedAt,
      readings: readings,
      limitModel: limitModel,
      completeness: completeness,
      bodyHash: probe.bodyHash || legacy.bodyHash,
      policy: 'native-first'
    });
    const diff = compareMetricSnapshots(legacy, snapshot);
    const sig = [
      probe.site, snapshot.tokens, snapshot.limit, snapshot.percent,
      snapshot.quality, snapshot.readiness,
      diff.verdict, diff.fields.join(',')
    ].join('|');
    if (sig !== lastSignature) {
      lastSignature = sig;
      debugLog('log', '[AI CM][v2-metrics] ' + diff.verdict + ' site=aistudio' +
        ' fields=' + (diff.fields.join(',') || '-') +
        ' legacy=' + (typeof legacy.tokens === 'number' ? legacy.tokens : '?') +
        '/' + (typeof legacy.limit === 'number' ? legacy.limit : '?') +
        '/' + (typeof legacy.percent === 'number' ? legacy.percent : '?') +
        ' new=' + snapshot.tokens + '/' + snapshot.limit + '/' + snapshot.percent +
        ' quality=' + snapshot.quality + ' readiness=' + snapshot.readiness +
        ' readings=' + readingsList(snapshot));
    }
    return { snapshot: snapshot, diff: diff };
  } catch (eDual) {
    swallowSoft(eDual, 'content:v2-metrics-dualrun');
    return null;
  }
}

/** Только для тестов: сброс флагов и антиспам-подписи. */
export function resetAiCmV2MetricsForTests(): void {
  storageFlag = false;
  storageRequested = false;
  lastSignature = '';
}

/** Источник legacy-канала для preferredKind (экспорт для тестов/диагностики). */
export function aiCmV2PreferredKind(src: string | undefined): 'server' | 'base' | 'dom' | undefined {
  return preferredKindOf(src);
}
