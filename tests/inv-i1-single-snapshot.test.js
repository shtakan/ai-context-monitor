/**
 * INV-I1 (ADR-001 / S2.2): ЕДИНЫЙ снимок — все потребители печатают одно число.
 *
 * Инвариант: tokens/percent в бейдже, панели (GET_STATS) и попапе берутся ТОЛЬКО из
 * aiCmReadContextSnapshot() через чистые мапперы aiCmWidgetDataFromSnapshot /
 * aiCmStatePatchFromSnapshot. При null-снимке ни один потребитель не печатает число
 * (ни 0, ни «0.0 %»); messageCount остаётся живым.
 *
 * Снимок намеренно «неестественный»: tokens 1000 при limit 1 000 000 → percent 7.7.
 * Пересчёт дал бы 0.1 %, поэтому напечатанные 7.7 доказывают чтение снимка, а не формулу.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const H = require('./helpers/content-source.js');
const CONTENT = H.readSource('core/content.ts');
const WIDGET_SRC = H.readSource('core/widget.ts');
const STATE = H.readExecutable('core/state.ts');

const HOST = 'chatgpt.com';
const TAB_URL = 'https://chatgpt.com/c/inv-i1';

// Рез по балансу фигурных скобок (тот же приём, что в tests/s2-snapshot-contract.test.js).
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

// {...} блока, начинающегося с marker (marker включает "{").
function blockAt(src, marker) {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced block: ' + marker);
}

// Песочница ТОЛЬКО из чистых мапперов core/state.ts — без lastTokensSnapshot и commit.
const MAPPERS = new Function(
  fnDecl(STATE, 'aiCmWidgetDataFromSnapshot') + '\n' +
  fnDecl(STATE, 'aiCmStatePatchFromSnapshot') + '\n' +
  'return { widget: aiCmWidgetDataFromSnapshot, patch: aiCmStatePatchFromSnapshot };'
)();
const api = MAPPERS;

function snapshot(over) {
  return Object.assign({
    convId: 'conv-i1',
    capturedAt: 1700000000000,
    site: 'chatgpt',
    model: 'gpt-5',
    modelName: 'GPT-5',
    src: 'dom',
    tokens: 1000,
    percent: 7.7,
    limit: 1000000,
    effectiveLimit: 1000000,
    contextLimit: 1000000,
    attachBreak: null,
    chars: 4000,
    msgs: 2,
    bodyHash: 'hash-i1',
    baseComplete: true,
    partial: false
  }, over || {});
}

// =====================================================================================
// A. Чистые мапперы: 1:1 из снимка, БЕЗ арифметики; null → null / {}
// =====================================================================================

describe('INV-I1 A: мапперы отдают снимок 1:1 и не считают percent', () => {
  test('widget: 7.7 из снимка (пересчёт 1000/1e6 дал бы 0.1)', () => {
    const d = api.widget(snapshot());
    expect(d.percentage).toBe(7.7);
    expect(d.tokenEstimate).toBe(1000);
    expect(d.displayLimit).toBe(1000000);
    expect(d.effectiveLimit).toBe(1000000);
    expect(d.contextLimit).toBe(1000000);
    expect(d.modelName).toBe('GPT-5');
    expect(d.attachBreak).toBeNull();
    expect(Math.round(d.tokenEstimate / d.effectiveLimit * 1000) / 10).toBe(0.1);
  });

  test('patch: те же 7 полей; null-снимок → пустой объект, а не нули', () => {
    const p = api.patch(snapshot());
    expect(p).toEqual({
      percentage: 7.7,
      tokenEstimate: 1000,
      displayLimit: 1000000,
      effectiveLimit: 1000000,
      contextLimit: 1000000,
      modelName: 'GPT-5',
      attachBreak: null
    });
    expect(api.widget(null)).toBeNull();
    expect(api.patch(null)).toEqual({});
    expect(api.patch(null).percentage).toBeUndefined();
    expect(api.patch(null).tokenEstimate).toBeUndefined();
  });
});

// =====================================================================================
// B. Бейдж: исполняется РЕАЛЬНАЯ ветка '} else if (badgeData)' и РЕАЛЬНЫЙ updateWidget
// =====================================================================================

function widgetEl() {
  const el = document.createElement('div');
  el.id = 'ai-context-widget';
  el.innerHTML =
    '<div class="ai-widget-circle"><svg><circle class="ai-widget-bg"></circle>' +
    '<circle class="ai-widget-fill"></circle></svg><div class="ai-widget-text">—</div>' +
    '<div class="ai-widget-tooltip"></div></div><div class="ai-widget-panel"></div>';
  document.body.appendChild(el);
  return el;
}

function makeBadge() {
  const el = widgetEl();
  const calls = [];
  const ctx = {
    currentAdapter: { siteName: 'chatgpt' },
    widgetElement: el,
    badgeData: null,
    stale: false,
    debugLog: function () { },
    aiCmRevealWidget: function () { },
    aiCmRefreshThemeIfNeeded: function () { },
    aiCmUpdateSourceIndicator: function () { },
    zoneColor: function (p) { return p < 50 ? '#22c55e' : '#ef4444'; },
    aiCmActivePct: function () { return null; },
    document: document,
    window: window
  };
  ctx.calls = calls;
  new Function('ctx', 'with (ctx) { ' + fnDecl(WIDGET_SRC, 'updateWidget') +
    '\n var realUpdateWidget = updateWidget;' +
    '\n ctx.updateWidget = function () { ctx.calls.push(Array.prototype.slice.call(arguments)); return realUpdateWidget.apply(null, arguments); }; }')(ctx);
  const branch = 'if (badgeData) ' + blockAt(CONTENT, '} else if (badgeData) {');
  const draw = new Function('ctx', 'with (ctx) { ' + branch + ' }');
  return { ctx: ctx, el: el, calls: calls, draw: draw };
}

describe('INV-I1 B: бейдж печатает число снимка; null → не печатает ничего', () => {
  test('бейдж: 7.7% и 1000 из снимка (не 0.1%)', () => {
    const b = makeBadge();
    b.ctx.badgeData = api.widget(snapshot());
    b.draw(b.ctx);
    expect(b.calls).toHaveLength(1);
    expect(b.el.querySelector('.ai-widget-text').textContent).toBe('7.7%');
    expect(b.el.querySelector('.ai-widget-tooltip').textContent).toContain((1000).toLocaleString());
    expect(b.el.querySelector('.ai-widget-text').textContent).not.toContain('0.1');
  });

  test('null-снимок: updateWidget не вызван, «0»/«0.0 %» не напечатаны', () => {
    const b = makeBadge();
    b.ctx.badgeData = api.widget(null);
    b.draw(b.ctx);
    expect(b.calls).toHaveLength(0);
    expect(b.el.querySelector('.ai-widget-text').textContent).toBe('—');
    expect(b.el.querySelector('.ai-widget-text').textContent).not.toContain('0');
  });
});

// =====================================================================================
// C. Панель: исполняется РЕАЛЬНЫЙ if (message.type === 'GET_STATS') из core/content.ts
// =====================================================================================

const STATS_BLOCK = blockAt(CONTENT, "if (message.type === 'GET_STATS') {");

function runStats(snap, msgs) {
  let response = null;
  const ctx = {
    message: { type: 'GET_STATS' },
    currentAdapter: { siteName: 'chatgpt', extractMessages: function () { return msgs; } },
    isInitialized: true,
    baseSeen: true,
    baseComplete: true,
    resolveCurrentModel: function () { return 'gpt-5'; },
    aiCmReadContextSnapshot: function () { return snap ? Object.assign({}, snap) : null; },
    aiCmStatePatchFromSnapshot: api.patch,
    ModelConfig: { getModel: function () { return { name: 'GPT-5' }; } },
    sendResponse: function (r) { response = r; }
  };
  new Function('ctx', 'with (ctx) { ' + STATS_BLOCK + ' }')(ctx);
  return response;
}

describe('INV-I1 C: панель отдаёт tokenCount/percentage/contextLimit из снимка', () => {
  test('снимок: 1000 / 7.7 / 1 000 000, messageCount живой', () => {
    const res = runStats(snapshot(), [{}, {}]);
    expect(res.data.tokenCount).toBe(1000);
    expect(res.data.percentage).toBe(7.7);
    expect(res.data.contextLimit).toBe(1000000);
    expect(res.data.messageCount).toBe(2);
    expect(res.data.modelName).toBe('GPT-5');
  });

  test('null-снимок: числа null (потребитель покажет «—»), messageCount живой', () => {
    const res = runStats(null, [{}, {}, {}]);
    expect(res.data.tokenCount).toBeNull();
    expect(res.data.percentage).toBeNull();
    expect(res.data.contextLimit).toBeNull();
    expect(res.data.messageCount).toBe(3);
  });
});

// =====================================================================================
// D. Попап: НАСТОЯЩИЙ options/options.js читает state, собранный из маппера
// =====================================================================================

const DOM_IDS = [
  'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent',
  'model-select', 'custom-limit', 'show-widget', 'api-key', 'toggle-api-key',
  'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
  'export-hint', 'stale-warning', 'export-diag', 'reset-limit',
  'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
  'aiCmProactive', 'aiCmProactiveNotify',
  'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh'
];

function setupDom() {
  const versionEl = document.createElement('span');
  versionEl.className = 'version';
  document.body.appendChild(versionEl);
  DOM_IDS.forEach(function (id) {
    const isNumber = id === 'aiCmProactiveLow' || id === 'aiCmProactiveMedium' || id === 'aiCmProactiveHigh';
    const el = isNumber ? document.createElement('input') : document.createElement('div');
    el.id = id;
    if (isNumber) el.type = 'number';
    if (id === 'aiCmAutoExportPct') el.value = '90';
    if (id === 'export-md' || id === 'export-json' || id === 'export-pdf' || id === 'export-txt') el.disabled = true;
    document.body.appendChild(el);
  });
}

function createChromeMock(initialLocal) {
  const store = Object.assign({}, initialLocal || {});
  const listeners = [];
  return {
    chrome: {
      runtime: { getManifest: function () { return { version: '2.1.1' }; }, getURL: function () { return 'print.html'; }, lastError: null, sendMessage: function () { } },
      storage: {
        sync: { get: function (keys, cb) { cb({}); }, set: function () { } },
        local: {
          get: function (keys, cb) {
            if (typeof keys === 'string') keys = [keys];
            const out = {};
            (keys || []).forEach(function (k) { out[k] = store[k]; });
            cb(out);
          },
          set: function (obj, cb) { Object.assign(store, obj); if (cb) cb(); },
          remove: function (keys, cb) {
            (typeof keys === 'string' ? [keys] : keys || []).forEach(function (k) { delete store[k]; });
            if (cb) cb();
          }
        },
        session: { get: function () { return Promise.resolve({}); }, set: function () { return Promise.resolve(); }, remove: function () { return Promise.resolve(); } },
        onChanged: { addListener: function (fn) { listeners.push(fn); } }
      },
      tabs: {
        query: function (q, cb) { cb([{ id: 1, url: TAB_URL }]); },
        create: function () { },
        sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
      }
    },
    listeners: listeners
  };
}

function mountOptions(initialLocal) {
  const m = createChromeMock(initialLocal);
  global.chrome = m.chrome;
  require('./helpers/load-options.js').loadOptions();
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return m;
}

function popupState() {
  const p = api.patch(snapshot());
  return {
    host: HOST,
    site: 'chatgpt',
    model: p.modelName,
    tokens: p.tokenEstimate,
    limit: p.displayLimit,
    percent: p.percentage,
    updatedAt: Date.now(),
    stale: false,
    netBaseMsgs: 2
  };
}

beforeEach(function () {
  jest.resetModules();
  document.body.innerHTML = '';
  setupDom();
  window.buildReferenceText = require('./helpers/load-esm.js').loadEsm('utils/buildReferenceText.ts');
  window.AiCmExportBuilders = require('./helpers/load-esm.js').loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
});

afterEach(function () {
  delete global.chrome;
});

describe('INV-I1 D: попап печатает то же число снимка; без снимка — «—», не 0', () => {
  test('попап: 7.7% / 1,000 / 1,000,000 из state, собранного маппером', () => {
    mountOptions({ ['aiCmState:' + HOST]: popupState() });
    expect(document.getElementById('stat-percent').textContent).toBe('7.7%');
    expect(document.getElementById('stat-tokens').textContent).toBe((1000).toLocaleString());
    expect(document.getElementById('stat-limit').textContent).toBe((1000000).toLocaleString());
  });

  test('нет снимка: числа нет (ни 0, ни «0.0 %»)', () => {
    mountOptions({});
    expect(document.getElementById('stat-percent').textContent).toBe('—');
    expect(document.getElementById('stat-tokens').textContent).toBe('—');
    expect(document.getElementById('stat-limit').textContent).toBe('—');
    expect(document.getElementById('stat-percent').textContent).not.toBe('0%');
  });
});
