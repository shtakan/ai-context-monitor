'use strict';
/**
 * 2.4 Stage 3: чистое решение снимка метрики (core/content-snapshot-policy.ts).
 *
 * Фиксируется «какие tokens/percent/model-limit отдать» без DOM/state:
 * tokenSnap + limitModel + baseSource/baseComplete + saturated + activePct.
 */
const { moduleSource } = require('./helpers/content-source.js');

function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

const POLICY_SRC = moduleSource('content-snapshot-policy.ts');
const resolveSnapshotPolicy = new Function('ctx',
  'with (ctx) { ' + fnDecl(POLICY_SRC, 'resolveSnapshotPolicy') + '\n return resolveSnapshotPolicy; }'
)({});

function input(over) {
  return Object.assign({
    tokenSnap: { tokens: 10000, serverTokens: 0 },
    limitModel: { windowKnown: true, modelWindow: 128000, displayLimit: 128000 },
    baseSource: 'net',
    baseComplete: true,
    contextSaturated: false,
    activePct: null,
    lastPercentage: -1,
    applyLimitPct: function (limit) { return limit; }
  }, over || {});
}

describe('2.4 Stage 3: resolveSnapshotPolicy — чистая метрика', function () {
  test('обычный чат: tokens/limit → 7.8 %, src=net, hasChanged', function () {
    const p = resolveSnapshotPolicy(input());
    expect(p).toMatchObject({
      tokenEstimate: 10000, metricServerTokens: 0, metricValueSrc: 'net',
      contextLimit: 128000, effectiveLimit: 128000, displayLimit: 128000,
      percentage: 7.8, snapshotPercentage: 7.8, hasChanged: true
    });
  });

  test('тот же процент: hasChanged=false', function () {
    const p = resolveSnapshotPolicy(input({ lastPercentage: 7.8 }));
    expect(p.hasChanged).toBe(false);
    expect(p.snapshotPercentage).toBe(7.8);
  });

  test('context-saturated: snapshot=100, токены не подменяются', function () {
    const p = resolveSnapshotPolicy(input({ tokenSnap: { tokens: 2686, serverTokens: 0 }, contextSaturated: true, lastPercentage: 2.1 }));
    expect(p).toMatchObject({ tokenEstimate: 2686, snapshotPercentage: 100, hasChanged: true });
  });

  test('serverTokens>0: src=server, токены остаются tokenSnap.tokens', function () {
    const p = resolveSnapshotPolicy(input({ tokenSnap: { tokens: 47412, serverTokens: 47412 }, baseSource: 'server' }));
    expect(p).toMatchObject({ tokenEstimate: 47412, metricServerTokens: 47412, metricValueSrc: 'server', percentage: 37 });
  });

  test('неполная/dom-база: src=dom', function () {
    const p = resolveSnapshotPolicy(input({ baseSource: 'dom', baseComplete: false }));
    expect(p.metricValueSrc).toBe('dom');
  });

  test('окно неизвестно: contextLimit=0, display-limit остаётся', function () {
    const p = resolveSnapshotPolicy(input({ limitModel: { windowKnown: false, modelWindow: 0, displayLimit: 128000 } }));
    expect(p.contextLimit).toBe(0);
    expect(p.displayLimit).toBe(128000);
  });

  test('ручной порог применяется через applyLimitPct', function () {
    const p = resolveSnapshotPolicy(input({
      activePct: 50,
      applyLimitPct: function (limit, pct) { return pct ? limit * pct / 100 : limit; }
    }));
    expect(p.effectiveLimit).toBe(128000);
    expect(p.displayLimit).toBe(64000);
    expect(p.percentage).toBe(15.6);
  });

  test('нулевой display-limit: percentage=0, без деления', function () {
    const p = resolveSnapshotPolicy(input({ limitModel: { windowKnown: true, modelWindow: 0, displayLimit: 0 } }));
    expect(p.displayLimit).toBe(0);
    expect(p.percentage).toBe(0);
    expect(p.snapshotPercentage).toBe(0);
  });
});
