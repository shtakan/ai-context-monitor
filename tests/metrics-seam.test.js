'use strict';

/**
 * 2.2 / фаза 2: чистый шов metrics (sources → limits → readiness → snapshot)
 * и dual-run AI Studio. Живой путь не меняется: тесты проверяют данные,
 * выбор политики и диагностическое сравнение с legacy.
 */

const { collectMetricReadings } = require('../utils/metrics/sources.ts');
const { resolveLimitModel } = require('../utils/metrics/limits.ts');
const {
  pickMetricReading,
  qualityForReading,
  readinessForReading
} = require('../utils/metrics/readiness.ts');
const {
  buildMetricSnapshot,
  compareMetricSnapshots
} = require('../utils/metrics/snapshot.ts');
const {
  aiCmV2MetricsDualRun,
  aiCmV2MetricsEnabled,
  resetAiCmV2MetricsForTests
} = require('../core/metrics-dualrun.ts');

function reading(kind, tokens, precision, coverage) {
  return {
    kind: kind,
    tokens: tokens,
    precision: precision,
    coverage: coverage,
    convId: 'c1',
    capturedAt: 1,
    source: kind
  };
}

describe('metrics/sources: чтения из уже снятых значений', () => {
  test('AI Studio: native → server → base → dom → estimate, точность и coverage', function () {
    const out = collectMetricReadings({
      convId: 'c1',
      capturedAt: 123,
      nativeTokens: 39604,
      serverTokens: 38600,
      baseTokens: 39000,
      domTokens: 35000,
      estimateTokens: 34000,
      baseComplete: true,
      bodyHash: 'h1'
    });
    expect(out.map(function (r) { return r.kind; })).toEqual(['native', 'server', 'base', 'dom', 'estimate']);
    expect(out[0]).toMatchObject({
      tokens: 39604, precision: 'exact', coverage: 'full', convId: 'c1', capturedAt: 123, bodyHash: 'h1', source: 'native'
    });
    expect(out[1]).toMatchObject({ precision: 'reported', coverage: 'full' });
    expect(out[2]).toMatchObject({ precision: 'derived', coverage: 'full' });
    expect(out[3]).toMatchObject({ precision: 'derived', coverage: 'partial' });
    expect(out[4]).toMatchObject({ precision: 'floor', coverage: 'partial' });
  });

  test('нулевые/нечисловые каналы не попадают; неполная база даёт partial', function () {
    const out = collectMetricReadings({
      capturedAt: 1,
      nativeTokens: 0,
      serverTokens: NaN,
      baseTokens: 3115,
      domTokens: -1,
      baseComplete: false
    });
    expect(out.map(function (r) { return r.kind; })).toEqual(['base']);
    expect(out[0]).toMatchObject({ tokens: 3115, coverage: 'partial' });
    expect(collectMetricReadings(null)).toEqual([]);
  });
});

describe('metrics/limits: окно, порог показа и лимит плана разделены', () => {
  test('AI Studio: окно 1M, порог 128k — два разных факта', function () {
    const model = resolveLimitModel({
      modelId: 'gemini-3.8-flash',
      modelWindow: 1048576,
      displayLimit: 128000,
      fallbackLimit: 128000,
      windowSource: 'catalog',
      displaySource: 'fallback'
    });
    expect(model.modelWindow).toBe(1048576);
    expect(model.displayLimit).toBe(128000);
    expect(model.accountLimit).toBeNull();
    expect(model.sources).toEqual(['catalog', 'fallback']);
  });

  test('лимит плана урезает окно: displayLimit = min(window, account)', function () {
    const model = resolveLimitModel({ modelWindow: 200000, accountLimit: 100000 });
    expect(model.displayLimit).toBe(100000);
    expect(model.modelWindow).toBe(200000);
    expect(model.sources).toEqual(['catalog', 'api']);
  });

  test('нет окна: fallback становится видимым порогом', function () {
    const model = resolveLimitModel({ fallbackLimit: 128000 });
    expect(model.modelWindow).toBe(128000);
    expect(model.displayLimit).toBe(128000);
    expect(model.sources).toEqual(['fallback']);
  });
});

describe('metrics/readiness: политика и запрет floor как факта', () => {
  const readings = [
    reading('native', 39604, 'exact', 'full'),
    reading('server', 38600, 'reported', 'full'),
    reading('base', 39000, 'derived', 'full'),
    reading('dom', 35000, 'derived', 'partial')
  ];

  test('native-first выбирает native; legacy с preferredKind — названный канал', function () {
    expect(pickMetricReading(readings, 'native-first').kind).toBe('native');
    expect(pickMetricReading(readings, 'legacy', 'dom').kind).toBe('dom');
    expect(pickMetricReading([], 'native-first')).toBeNull();
  });

  test('reload-fuller предпочитает полное покрытие частичному', function () {
    const partialNative = reading('native', 100, 'exact', 'partial');
    const fullBase = reading('base', 200, 'derived', 'full');
    expect(pickMetricReading([partialNative, fullBase], 'reload-fuller').kind).toBe('base');
  });

  test('floor никогда не settled; exact + complete = settled', function () {
    const floor = reading('estimate', 1000, 'floor', 'full');
    const exact = reading('native', 1000, 'exact', 'full');
    const complete = { complete: true, reasons: [] };
    const incomplete = { complete: false, reasons: ['incomplete'] };
    expect(qualityForReading(floor, complete)).toBe('floor');
    expect(readinessForReading(floor, complete)).toBe('provisional');
    expect(qualityForReading(exact, complete)).toBe('exact');
    expect(readinessForReading(exact, complete)).toBe('settled');
    expect(readinessForReading(exact, incomplete)).toBe('provisional');
    expect(readinessForReading(null, incomplete)).toBe('collecting');
    expect(readinessForReading(null, complete)).toBe('no-data');
  });

  test('stale сильнее точности', function () {
    const exact = reading('native', 1000, 'exact', 'full');
    expect(qualityForReading(exact, { complete: true, reasons: ['stale'] })).toBe('stale');
  });
});

describe('metrics/snapshot: один снимок из чтений', () => {
  function snap(over) {
    return buildMetricSnapshot(Object.assign({
      convId: 'c1',
      capturedAt: 10,
      readings: [
        reading('native', 39604, 'exact', 'full'),
        reading('dom', 35000, 'derived', 'partial')
      ],
      limitModel: { modelWindow: 1048576, displayLimit: 128000, accountLimit: null, plan: null, sources: ['catalog', 'fallback'] },
      completeness: { complete: true, reasons: [] },
      bodyHash: 'body-hash',
      policy: 'native-first'
    }, over || {}));
  }

  test('AI Studio 39 604 / 128 000 = 30.9 %, quality=exact, readiness=settled', function () {
    const out = snap();
    expect(out.tokens).toBe(39604);
    expect(out.limit).toBe(128000);
    expect(out.percent).toBe(30.9);
    expect(out.quality).toBe('exact');
    expect(out.readiness).toBe('settled');
    expect(out.bodyHash).toBe('body-hash');
    expect(out.limitModel.modelWindow).toBe(1048576);
  });

  test('нет чтений: нули + floor, readiness по полноте (не факт)', function () {
    const out = snap({ readings: [], completeness: { complete: false, reasons: ['incomplete'] } });
    expect(out.tokens).toBe(0);
    expect(out.limit).toBe(128000);
    expect(out.percent).toBe(0);
    expect(out.quality).toBe('floor');
    expect(out.readiness).toBe('collecting');
  });

  test('compare: same по наблюдаемым полям, diff называет поле', function () {
    const legacy = { convId: 'c1', tokens: 39604, limit: 128000, percent: 30.9, bodyHash: 'body-hash', baseComplete: true };
    expect(compareMetricSnapshots(legacy, snap()).verdict).toBe('same');
    const diff = compareMetricSnapshots(Object.assign({}, legacy, { tokens: 3115, percent: 2.4 }), snap());
    expect(diff.verdict).toBe('diff');
    expect(diff.fields).toEqual(['tokens', 'percent']);
  });
});

describe('dual-run metrics: флаг, пилот AI Studio, сравнение с legacy', () => {
  const probe = {
    site: 'aistudio',
    convId: 'c1',
    capturedAt: 10,
    nativeTokens: 39604,
    serverTokens: 38600,
    baseTokens: 39604,
    baseComplete: true,
    partial: false,
    bodyHash: 'body-hash',
    modelId: 'gemini-3.8-flash',
    modelWindow: 1048576,
    displayLimit: 128000,
    fallbackLimit: 128000,
    windowSource: 'catalog',
    displaySource: 'fallback'
  };
  const legacy = {
    convId: 'c1',
    tokens: 39604,
    limit: 128000,
    percent: 30.9,
    src: 'server',
    bodyHash: 'body-hash',
    baseComplete: true
  };

  test('без флага dual-run не считается', function () {
    sessionStorage.removeItem('aiCmV2Metrics');
    resetAiCmV2MetricsForTests();
    expect(aiCmV2MetricsEnabled()).toBe(false);
    expect(aiCmV2MetricsDualRun(legacy, probe)).toBeNull();
  });

  test('флаг sessionStorage: same для совпадающего legacy', function () {
    sessionStorage.setItem('aiCmV2Metrics', '1');
    resetAiCmV2MetricsForTests();
    const out = aiCmV2MetricsDualRun(legacy, probe);
    expect(out).not.toBeNull();
    expect(out.diff.verdict).toBe('same');
    expect(out.snapshot.tokens).toBe(39604);
    expect(out.snapshot.percent).toBe(30.9);
    expect(out.snapshot.quality).toBe('exact');
    sessionStorage.removeItem('aiCmV2Metrics');
    resetAiCmV2MetricsForTests();
  });

  test('расхождение названо; прочие сайты в пилот не входят', function () {
    sessionStorage.setItem('aiCmV2Metrics', '1');
    resetAiCmV2MetricsForTests();
    const diff = aiCmV2MetricsDualRun(Object.assign({}, legacy, { tokens: 3115, percent: 2.4 }), probe);
    expect(diff.diff.verdict).toBe('diff');
    expect(diff.diff.fields).toContain('tokens');
    expect(aiCmV2MetricsDualRun(legacy, Object.assign({}, probe, { site: 'gemini' }))).toBeNull();
    sessionStorage.removeItem('aiCmV2Metrics');
    resetAiCmV2MetricsForTests();
  });
});
