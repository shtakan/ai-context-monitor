'use strict';

/**
 * 2.2/фаза 2, пункт 4: бейдж читает readiness/quality нового снимка.
 * derived/floor/provisional → «~N%» (I7: оценка не подаётся как факт).
 * Без полей (legacy/флаг off) текст байтово прежний.
 */

const { moduleSource } = require('./helpers/content-source.js');
const WIDGET = moduleSource('widget.ts');

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

function makeWidgetEl() {
  const el = document.createElement('div');
  el.id = 'ai-context-widget';
  el.innerHTML =
    '<div class="ai-widget-circle"><svg><circle class="ai-widget-bg"></circle>' +
    '<circle class="ai-widget-fill"></circle></svg><span class="ai-widget-text">—</span>' +
    '<div class="ai-widget-tooltip"></div></div><div class="ai-widget-panel"></div>';
  document.body.appendChild(el);
  return el;
}

function makeUpdater(lastWidgetData) {
  const ctx = {
    widgetElement: makeWidgetEl(),
    stale: false,
    baseCount: 1,
    lastBaseTexts: ['x'],
    lastWidgetData: lastWidgetData,
    zoneColor: function () { return '#22c55e'; },
    aiCmActivePct: function () { return null; },
    aiCmRefreshThemeIfNeeded: function () { },
    aiCmUpdateSourceIndicator: function () { },
    aiCmSourceLabelNow: '',
    aiCmI18nMessage: function (key, fallback) { return fallback; },
    debugLog: function () { },
    __update: null
  };
  new Function('ctx', 'with (ctx) { ' + fnDecl(WIDGET, 'updateWidget') + '\n ctx.__update = updateWidget; }')(ctx);
  return ctx;
}

function textOf(ctx) {
  return ctx.widgetElement.querySelector('.ai-widget-text').textContent;
}

afterEach(function () {
  document.body.innerHTML = '';
});

describe('metrics: бейдж и readiness', () => {
  test('provisional → ~0.5% (derived base, F1)', function () {
    const ctx = makeUpdater({ quality: 'derived', readiness: 'provisional' });
    ctx.__update(0.5, 683, 128000, 1048576, 128000, 'Gemini 3.8 Flash', null);
    expect(textOf(ctx)).toBe('~0.5%');
  });

  test('floor → ~, collecting → ~', function () {
    const floor = makeUpdater({ quality: 'floor', readiness: 'provisional' });
    floor.__update(2.7, 3484, 128000, 1048576, 128000, 'Gemini', null);
    expect(textOf(floor)).toBe('~2.7%');

    const collecting = makeUpdater({ readiness: 'collecting' });
    collecting.__update(2.7, 3484, 128000, 1048576, 128000, 'Gemini', null);
    expect(textOf(collecting)).toBe('~2.7%');
  });

  test('settled/exact и legacy без полей — прежний текст', function () {
    const exact = makeUpdater({ quality: 'exact', readiness: 'settled' });
    exact.__update(2.7, 3484, 128000, 1048576, 128000, 'Gemini', null);
    expect(textOf(exact)).toBe('2.7%');

    const legacy = makeUpdater(null);
    legacy.__update(2.7, 3484, 128000, 1048576, 128000, 'Gemini', null);
    expect(textOf(legacy)).toBe('2.7%');
  });

  test('source: решение — из lastWidgetData, не из магической платформы', function () {
    expect(WIDGET).toContain("lastWidgetData.readiness === 'provisional'");
    expect(WIDGET).toContain("lastWidgetData.quality === 'derived'");
    expect(WIDGET).toContain("+ percentage.toFixed(1) + '%'");
  });
});
