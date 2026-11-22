/**
 * O-14 (Low, фикс): попап не должен показывать старый снимок после RESET.
 *
 * Механизм бага (инспекция): core/widget.ts resetConversationState() чистил только
 * состояние виджета, но не chrome.storage.local → ключи aiCmState / aiCmState:<host>
 * (пишет core/content.ts при badge-update) оставались с данными СТАРОГО чата; читатель
 * попапа (options/options.js, chrome.storage.onChanged) обрабатывал только newValue —
 * removed игнорировался, экран держал последний снимок.
 *
 * Контур O-14:
 *   A (core/widget.ts): в конце resetConversationState() удаляются РОВНО aiCmState и
 *     aiCmState:<host> (тот же host, что в записи content.js); aiCmHistory*, sync-ключи,
 *     selectedModel/customLimit не трогаются.
 *   B (options/options.js): ветка removed для aiCmState/aiCmState:<host> → showNoData(...)
 *     + гашение stale-предупреждения; ветка newValue — байтово прежняя.
 *
 *   D1 структурный пин: remove ровно двух ключей живёт в resetConversationState;
 *   D2 интеграция (jsdom + НАСТОЯЩИЙ options.js): removed → «нет данных» + stale скрыт;
 *      чужой хост → экран вкладки не трогаем;
 *   D3 поведенческий: реальный resetConversationState со storage-моком — удалены ровно
 *      два ключа, чужие ключи и sync на месте;
 *   R1 O-1 R2-совместимость: reset не падает и не меняет своего контракта;
 *   R2 пин ветки newValue (truthy) — прежние строки на месте;
 *   R3 не тронуты aiCmHistory*, sync-ключи и прочие local-ключи.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const H = require('./helpers/content-source.js');
const WIDGET_SRC = H.readSource('core/widget.ts');
const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');

const HOST = 'chatgpt.com';
const TAB_URL = 'https://chatgpt.com/c/abc-def';
const OTHER_HOST = 'claude.ai';

// Рез по балансу фигурных скобок (как в tests/chatgpt-o1-badge-hold.test.js).
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

function liveState() {
  return {
    host: HOST,
    site: 'chatgpt',
    model: 'gpt-5',
    tokens: 50992,
    limit: 128000,
    windowLimit: 1050000,
    accountLimit: null,
    limitPlan: null,
    limitWarnings: ['account-limit-unknown'],
    percent: 39.8,
    updatedAt: Date.now(),
    stale: true
  };
}

// =====================================================================================
// A. core/widget.ts — resetConversationState удаляет ровно снимок попапа
// =====================================================================================

// Резолвер расширения в песочнице читается из того же скоупа, что и chrome
// (content.js увидёт глобальный `chrome`) — кладём мок в ctx и в with-скоуп
// (как isExtensionValid в реальном content-скоупе: !!chrome.runtime.id).
const RESET_SCOPE_SRC = 'with (ctx) { ' +
  'function isExtensionValid() { try { return !!chrome.runtime.id; } catch (e) { return false; } } ' +
  fnDecl(WIDGET_SRC, 'resetConversationState') +
  '\n return { reset: resetConversationState }; }';

function makeWidgetSandbox() {
  const store = {
    aiCmState: liveState(),
    ['aiCmState:' + HOST]: liveState(),
    ['aiCmState:' + OTHER_HOST]: { host: OTHER_HOST, stale: false },
    aiCmHistory: [{ convId: 'old', text: 'история старого чата' }],
    ['aiCmHistory:' + HOST]: [{ convId: 'old', text: 'история старого чата' }]
  };

  const removed = [];
  const setCalls = [];
  const syncCalls = [];

  const ctx = {
    runtime: { id: 'test-ext-id' },
    window: { location: { hostname: HOST }, AiCmExportEmitPipeline: null, __aiCmTraceSeq: 0 },
    chrome: {
      runtime: { id: 'test-ext-id' },       // content-скоуп: isExtensionValid() = !!chrome.runtime.id
      storage: {
        local: {
          get: function () { },
          set: function (obj) { setCalls.push(obj); Object.assign(store, obj); },
          remove: function (keys) {
            removed.push(keys);
            (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
          }
        },
        sync: { get: function () { }, set: function (o) { syncCalls.push(o); } }
      }
    },
    getCurrentConvId: function () { return 'old-conv' },
    debugLog: function () { },
    aiCmDiagDocKind: null,
    aiCmDomThreadId: function () { return ''; },
    aiCmDiagLine: null,
    aiCmDiagStack: null,
    aiCmI18nMessage: null,
    zoneColor: function (p) { return p < 50 ? '#22c55e' : (p < 80 ? '#eab308' : '#ef4444'); },
    scheduleStaleCheck: function () { },
    currentAdapter: { siteName: 'chatgpt' },
    widgetElement: null,
    stale: false
  };
  ctx.ctx = ctx; // названо как в харнессе O-1 R2 (sandbox scope)
  return {
    store: store, removed: removed, setCalls: setCalls, syncCalls: syncCalls,
    ctx: ctx,
    api: new Function('ctx', RESET_SCOPE_SRC)(ctx)
  };
}

describe('O-14 D1: структурный пин — remove живёт в resetConversationState', () => {
  test('D1: в конце resetConversationState удаляются ровно aiCmState и aiCmState:<host>', () => {
    const decl = fnDecl(WIDGET_SRC, 'resetConversationState');
    expect(decl).toContain("chrome.storage.local.remove(['aiCmState', 'aiCmState:' + window.location.hostname])");
    // host берётся из того же источника, что в записи core/content.ts (statePatch-ключ)
    const contentSrc = fs.readFileSync(path.join(ROOT, 'core', 'content.ts'), 'utf8');
    expect(contentSrc).toContain("statePatch['aiCmState:' + window.location.hostname] = stateSnapshot;");
    // никакой другой чистки storage в resetConversationState не появилось
    expect(decl.match(/storage\.local\.remove/g)).toHaveLength(1);
    expect(decl).not.toContain("chrome.storage.sync.remove");
    // в код-строках функции нет обращений к истории (комментарий не в счёт)
    const declCode = decl.replace(/\/\/[^\n]*/g, '');
    expect(declCode).not.toContain('aiCmHistory');
    expect(declCode).not.toContain('selectedModel');
    expect(declCode).not.toContain('customLimit');
  });
});

describe('O-14 D3/R3: реальный resetConversationState — удалён ровно снимок попапа', () => {
  test('D3: reset удаляет aiCmState и aiCmState:<host>, прочие local-ключи живы', () => {
    const s = makeWidgetSandbox();
    s.api.reset();

    expect(s.removed).toHaveLength(1);
    expect(s.removed[0]).toEqual(['aiCmState', 'aiCmState:' + HOST]);
    expect(s.store['aiCmState']).toBeUndefined();
    expect(s.store['aiCmState:' + HOST]).toBeUndefined();
    // чужие снимки и история не тронуты (R3)
    expect(s.store['aiCmState:' + OTHER_HOST]).toBeTruthy();
    expect(s.store['aiCmHistory']).toBeTruthy();
    expect(s.store['aiCmHistory:' + HOST]).toBeTruthy();
    expect(s.syncCalls).toHaveLength(0);          // sync-ключи (selectedModel/customLimit) не тронуты
    expect(s.setCalls).toHaveLength(0);           // записей в local reset не делает
  });

  test('R1: reset по-прежнему сбрасывает состояние виджета (O-1 R2-контракт)', () => {
    const s = makeWidgetSandbox();
    s.ctx.baseText = 'base-old';
    s.ctx.baseCount = 71;
    s.ctx.baseSeen = true;
    s.ctx.badgeSuppressed = false;
    s.ctx.lastWidgetData = { pct: 39.8 };

    s.api.reset();

    expect(s.ctx.baseText).toBe('');
    expect(s.ctx.baseCount).toBe(0);
    expect(s.ctx.baseSeen).toBe(false);
    expect(s.ctx.badgeSuppressed).toBe(true);
    expect(s.ctx.lastWidgetData).toBeNull();
  });

  test('R1: отсутствие chrome (jsdom-песочница) не роняет reset', () => {
    const s = makeWidgetSandbox();
    s.ctx.chrome = undefined;               // песочница без chrome: isExtensionValid() → false
    expect(function () { s.api.reset(); }).not.toThrow();
    expect(s.removed).toHaveLength(0);      // remove не вызывается — прежнее поведение без расширения
  });
});

// =====================================================================================
// B. options/options.js — ветка removed в chrome.storage.onChanged
// =====================================================================================

const DOM_IDS = [
  'stat-site', 'stat-model', 'stat-tokens', 'stat-window', 'stat-limit', 'stat-account', 'stat-percent',
  'model-select', 'custom-limit', 'show-widget', 'api-key', 'toggle-api-key',
  'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
  'export-hint', 'stale-warning', 'saturation-warning', 'export-diag', 'reset-limit',
  'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
  'aiCmProactive', 'aiCmProactiveNotify',
  'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh',
  'gemini-plan'
];

function setupDom() {
  const versionEl = document.createElement('span');
  versionEl.className = 'version';
  document.body.appendChild(versionEl);
  DOM_IDS.forEach(function (id) {
    const isNumber = id === 'aiCmProactiveLow' || id === 'aiCmProactiveMedium' || id === 'aiCmProactiveHigh';
    const isSelect = id === 'gemini-plan' || id === 'model-select';
    const el = isSelect ? document.createElement('select') : (isNumber ? document.createElement('input') : document.createElement('div'));
    el.id = id;
    if (isNumber) el.type = 'number';
    if (id === 'aiCmAutoExportPct') el.value = '90';
    if (id === 'gemini-plan') {
      ['auto', 'free', 'ai-plus', 'ai-pro', 'ultra'].forEach(function (value) {
        const opt = document.createElement('option');
        opt.value = value;
        el.appendChild(opt);
      });
    }
    if (id === 'export-md' || id === 'export-json' || id === 'export-pdf' || id === 'export-txt') el.disabled = true;
    document.body.appendChild(el);
  });
}

function createChromeMock(initialLocal, activeTabUrl, tabWithoutUrl, initialSync) {
  const store = Object.assign({}, initialLocal || {});
  const syncStore = Object.assign({}, initialSync || {});
  const syncSets = [];
  const listeners = [];
  return {
    chrome: {
      runtime: { getManifest: function () { return { version: '2.0.10' }; }, getURL: function () { return 'print.html'; }, lastError: null, sendMessage: function () { } },
      storage: {
        sync: {
          get: function (keys, cb) {
            const out = {};
            (keys || []).forEach(function (k) { out[k] = syncStore[k]; });
            cb(out);
          },
          set: function (obj) { syncSets.push(obj); Object.assign(syncStore, obj); }
        },
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
        query: function (q, cb) {
          cb(tabWithoutUrl ? [{ id: 1 }] : (activeTabUrl ? [{ id: 1, url: activeTabUrl }] : []));
        },
        create: function () { },
        sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
      }
    },
    store: store,
    syncStore: syncStore,
    syncSets: syncSets,
    listeners: listeners
  };
}

function mountOptions(initialLocal, activeTabUrl, tabWithoutUrl, initialSync) {
  const m = createChromeMock(initialLocal, activeTabUrl, tabWithoutUrl, initialSync);
  global.chrome = m.chrome;
  require('./helpers/load-options.js').loadOptions();
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return m;
}

function fireChanged(m, changes) {
  m.listeners.forEach(function (fn) { fn(changes, 'local'); });
}

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = '';
  setupDom();
  window.buildReferenceText = require('./helpers/load-esm.js').loadEsm('utils/buildReferenceText.ts');
  window.AiCmExportBuilders = require('./helpers/load-esm.js').loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
});

afterEach(() => {
  delete global.chrome;
});

describe('O-14 D2: попап на removed-событие не держит старый снимок (jsdom, реальный options.js)', () => {
  test('D2: removed aiCmState:<host> → «нет данных» + stale скрыт', () => {
    const m = mountOptions({ ['aiCmState:' + HOST]: liveState() }, TAB_URL);
    expect(document.getElementById('stat-model').textContent).toBe('gpt-5');

    fireChanged(m, { ['aiCmState:' + HOST]: { oldValue: liveState() } });

    expect(document.getElementById('stat-site').textContent).toContain('Нет данных');
    expect(document.getElementById('stat-model').textContent).toBe('—');
    expect(document.getElementById('stat-tokens').textContent).toBe('—');
    expect(document.getElementById('stat-window').textContent).toBe('—');
    expect(document.getElementById('stat-limit').textContent).toBe('—');
    expect(document.getElementById('stat-account').textContent).toBe('—');
    expect(document.getElementById('stat-percent').textContent).toBe('—');
    const warn = document.getElementById('stale-warning');
    expect(warn.style.display).toBe('none');
    expect(warn.textContent).toBe('');
  });

  test('D2: removed глобального aiCmState своего хоста → тоже «нет данных»', () => {
    const m = mountOptions({ aiCmState: liveState() }, TAB_URL);
    fireChanged(m, { aiCmState: { oldValue: liveState() } });
    expect(document.getElementById('stat-model').textContent).toBe('—');
    expect(document.getElementById('stat-site').textContent).toContain('Нет данных');
  });

  test('D2: removed чужого хоста → экран активной вкладки не трогаем', () => {
    const m = mountOptions({ ['aiCmState:' + HOST]: liveState() }, TAB_URL);
    fireChanged(m, { ['aiCmState:' + OTHER_HOST]: { oldValue: { host: OTHER_HOST } } });
    expect(document.getElementById('stat-model').textContent).toBe('gpt-5');

    fireChanged(m, { aiCmState: { oldValue: { host: OTHER_HOST } } });
    expect(document.getElementById('stat-model').textContent).toBe('gpt-5');
  });

  test('2.2/фаза 5: окно модели и лимит аккаунта — отдельные строки попапа', () => {
    mountOptions({ ['aiCmState:' + HOST]: liveState() }, TAB_URL);
    expect(document.getElementById('stat-window').textContent).toBe((1050000).toLocaleString());
    expect(document.getElementById('stat-limit').textContent).toBe((128000).toLocaleString());
    expect(document.getElementById('stat-account').textContent).toBe('неизвестен');
  });

  test('BIG-02: баннер платформы → 100% и предупреждение в попапе', () => {
    const saturated = Object.assign(liveState(), {
      tokens: 63077,
      limit: 128000,
      percent: 100,
      saturated: true
    });
    mountOptions({ ['aiCmState:' + HOST]: saturated }, TAB_URL);
    expect(document.getElementById('stat-percent').textContent).toBe('100%');
    expect(document.getElementById('saturation-warning').style.display).toBe('block');
    expect(document.getElementById('saturation-warning').textContent).toContain('контекст заполнен');
  });

  test('2.2/фаза 5: тариф Gemini загружается и пишется в sync', () => {
    const m = mountOptions({}, TAB_URL, false, { aiCmGeminiPlan: 'free' });
    const plan = document.getElementById('gemini-plan');
    expect(plan.value).toBe('free');
    plan.value = 'ai-plus';
    plan.dispatchEvent(new Event('change'));
    expect(m.syncSets).toContainEqual({ aiCmGeminiPlan: 'ai-plus' });
  });

  test('D2: после removed новый снимок (newValue) снова печатается — кэш не залип', () => {
    const m = mountOptions({ ['aiCmState:' + HOST]: liveState() }, TAB_URL);
    fireChanged(m, { ['aiCmState:' + HOST]: { oldValue: liveState() } });
    expect(document.getElementById('stat-model').textContent).toBe('—');

    const fresh = Object.assign(liveState(), { model: 'gpt-5.5', stale: false, updatedAt: Date.now() + 1 });
    fireChanged(m, { ['aiCmState:' + HOST]: { newValue: fresh } });
    expect(document.getElementById('stat-model').textContent).toBe('gpt-5.5');
  });
});

describe('O-14 R2: ветка newValue байтово прежняя, removed-ветка не ломает прочие изменения', () => {
  test('R2: прежние строки читателя onChanged на месте', () => {
    expect(OPTIONS_SRC).toContain("if (changes.aiCmState && changes.aiCmState.newValue) candidates.push(changes.aiCmState.newValue);");
    expect(OPTIONS_SRC).toContain("if (key.indexOf('aiCmState:') === 0 && changes[key] && changes[key].newValue) {");
    expect(OPTIONS_SRC).toContain("var best = null;");
    expect(OPTIONS_SRC).toContain("if (s.host === tabHost && (!best || (s.updatedAt || 0) > (best.updatedAt || 0))) best = s;");
    // removed-ветка — ровно один вызов showNoData и гашение stale
    expect(OPTIONS_SRC).toContain("updateStaleWarning(null, tabHost, '');");
  });

  test('R2: изменение не-aiCmState ключей экран не трогает', () => {
    const m = mountOptions({ ['aiCmState:' + HOST]: liveState() }, TAB_URL);
    fireChanged(m, { selectedModel: { newValue: 'gpt-5' } });
    expect(document.getElementById('stat-model').textContent).toBe('gpt-5');
  });
});

describe('BUG-11: состояния UI попапа', () => {
  test('живой поддерживаемый сайт без данных → «Нет данных», не «Откройте…»', () => {
    mountOptions({}, 'https://gemini.google.com/app/abc');
    expect(document.getElementById('stat-site').textContent).toBe('Нет данных');
  });

  test('неподдерживаемый хост → «Откройте поддерживаемый сайт»', () => {
    mountOptions({}, 'https://example.com/page');
    expect(document.getElementById('stat-site').textContent).toContain('Откройте поддерживаемый сайт');
  });

  test('T2: Chrome не отдал url (чужой хост) → «Откройте…», не «Нет активной вкладки»', () => {
    mountOptions({}, null, true);
    expect(document.getElementById('stat-site').textContent).toContain('Откройте поддерживаемый сайт');
    expect(document.getElementById('stat-site').textContent).not.toContain('Нет активной вкладки');
  });

  test('0 токенов (лёгкий/пустой тред) → «—», а не «0%»', () => {
    mountOptions({
      ['aiCmState:' + HOST]: {
        host: HOST, site: 'chatgpt', model: 'gpt-5', tokens: 0, limit: 128000,
        percent: 0, updatedAt: Date.now(), stale: false
      }
    }, TAB_URL);
    expect(document.getElementById('stat-tokens').textContent).toBe('—');
    expect(document.getElementById('stat-percent').textContent).toBe('—');
    expect(document.getElementById('stat-limit').textContent).not.toBe('—');
  });

  test('Perplexity: тултип про квоту поиска, а не контекст', () => {
    const host = 'www.perplexity.ai';
    mountOptions({
      ['aiCmState:' + host]: {
        host: host, site: 'perplexity', model: 'Sonar', tokens: 1000, limit: 128000,
        percent: 0.8, updatedAt: Date.now(), stale: false
      }
    }, 'https://www.perplexity.ai/search/abc');
    const pct = document.getElementById('stat-percent');
    const lim = document.getElementById('stat-limit');
    expect(pct.textContent).toBe('0.8%');
    expect(pct.title).toMatch(/квот|quota|контекст|context/i);
    expect(lim.title).toMatch(/квот|quota|контекст|context/i);
  });
});
