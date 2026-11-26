'use strict';
/**
 * 2.4 Stage 4: чистые предикаты бейджа, порога и автоэкспорта.
 *
 * Порядок веток бейджа и guard'ов сохранён байтово; вызовы updateWidget/
 * sendMessage/setTimeout остаются в content.ts/content-autoexport.ts.
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

const POLICY_SRC = moduleSource('content-threshold-policy.ts');
const api = new Function('ctx',
  'with (ctx) { ' + fnDecl(POLICY_SRC, 'resolveBadgePolicy') + '\n' +
  fnDecl(POLICY_SRC, 'resolveThresholdPolicy') + '\n' +
  fnDecl(POLICY_SRC, 'resolveAutoExportSchedulePolicy') + '\n' +
  ' return { badge: resolveBadgePolicy, threshold: resolveThresholdPolicy, schedule: resolveAutoExportSchedulePolicy }; }'
)({});

function badge(over) {
  return Object.assign({
    badgeSuppressed: false,
    baseSeen: true,
    adapterBaseSeen: false,
    loaderFreeze: false,
    badgeHold: false,
    byokHeuristicHold: false,
    hasWidgetData: true
  }, over || {});
}

describe('2.4 Stage 4: resolveBadgePolicy — порядок удержаний', function () {
  test('SPA-супрессия сильнее loader/hold/byok', function () {
    expect(api.badge(badge({ badgeSuppressed: true, baseSeen: false, loaderFreeze: true, badgeHold: true })))
      .toEqual({ draw: false, reason: 'spa-suppress' });
  });

  test('loader-freeze сильнее badge-hold/byok', function () {
    expect(api.badge(badge({ loaderFreeze: true, badgeHold: true, byokHeuristicHold: true })))
      .toEqual({ draw: false, reason: 'loader-freeze' });
  });

  test('badge-hold сильнее byok', function () {
    expect(api.badge(badge({ badgeHold: true, byokHeuristicHold: true })))
      .toEqual({ draw: false, reason: 'badge-hold' });
  });

  test('byok-hold без данных: byok приоритетнее no-data', function () {
    expect(api.badge(badge({ byokHeuristicHold: true, hasWidgetData: false })))
      .toEqual({ draw: false, reason: 'byok-hold' });
  });

  test('нет данных — no-data, без updateWidget', function () {
    expect(api.badge(badge({ hasWidgetData: false })))
      .toEqual({ draw: false, reason: 'no-data' });
  });

  test('все чисто — draw', function () {
    expect(api.badge(badge({}))).toEqual({ draw: true, reason: 'draw' });
  });

  test('adapterBaseSeen снимает SPA-супрессию', function () {
    expect(api.badge(badge({ badgeSuppressed: true, baseSeen: false, adapterBaseSeen: true })))
      .toEqual({ draw: true, reason: 'draw' });
  });
});

describe('2.4 Stage 4: resolveThresholdPolicy — sendThresholdPct', function () {
  test('расширение невалидно — skip extension-invalid', function () {
    expect(api.threshold({ extensionValid: false, proactiveEnabled: true, percentage: 50 }))
      .toEqual({ send: false, reason: 'extension-invalid' });
  });

  test('проактивные пороги выключены — skip proactive-off', function () {
    expect(api.threshold({ extensionValid: true, proactiveEnabled: false, percentage: 50 }))
      .toEqual({ send: false, reason: 'proactive-off' });
  });

  test('невалидный/отрицательный процент — skip invalid-pct', function () {
    expect(api.threshold({ extensionValid: true, proactiveEnabled: true, percentage: -1 }).reason).toBe('invalid-pct');
    expect(api.threshold({ extensionValid: true, proactiveEnabled: true, percentage: NaN }).reason).toBe('invalid-pct');
    expect(api.threshold({ extensionValid: true, proactiveEnabled: true, percentage: '50' }).reason).toBe('invalid-pct');
  });

  test('валидный pct — send', function () {
    expect(api.threshold({ extensionValid: true, proactiveEnabled: true, percentage: 0 }))
      .toEqual({ send: true, reason: '' });
  });
});

describe('2.4 Stage 4: resolveAutoExportSchedulePolicy — aiCmScheduleAutoExport', function () {
  test('автоэкспорт выключен — skip disabled', function () {
    expect(api.schedule({ enabled: false, percentage: 99 })).toEqual({ schedule: false, reason: 'disabled' });
  });

  test('невалидный процент — skip invalid-pct', function () {
    [-1, NaN, Infinity, '99'].forEach(function (pct) {
      expect(api.schedule({ enabled: true, percentage: pct }).reason).toBe('invalid-pct');
    });
  });

  test('валидный процент — schedule', function () {
    expect(api.schedule({ enabled: true, percentage: 0 })).toEqual({ schedule: true, reason: '' });
    expect(api.schedule({ enabled: true, percentage: 99 })).toEqual({ schedule: true, reason: '' });
  });
});
