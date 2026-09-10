/**
 * H8 (регрессионный контур): isChatHome(hostname, pathname) + гейт
 * stale-предупреждения в options/options.js.
 *
 * Баг: на home-страницах чат-сайтов (диалог не открыт → baseSeen вечно false,
 * а DOM-эвристика extractMessages()>0) content.js взводит stale — попап ложно
 * показывал «Интеграция могла устареть». Точка показа одна — updateStaleWarning.
 *
 * Фикс: предупреждение показывается ТОЛЬКО на странице реального диалога
 * (isChatHome() === true); на home и неизвестных хостах — display:none.
 *
 * Проверки:
 *   - isChatHome: home '/' → false, диалог → true (все 5 сайтов);
 *   - неизвестный хост → false (поведение как прежде);
 *   - интеграционно: loadStats (DOMContentLoaded) и live onChanged прокидывают
 *     hostname/pathname активной вкладки в updateStaleWarning.
 */

const buildReferenceText = require('../utils/buildReferenceText.js');

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
    if (isNumber) { el.type = 'number'; }
    if (id === 'aiCmAutoExportPct') el.value = '90';
    if (id === 'export-md' || id === 'export-json' || id === 'export-pdf' || id === 'export-txt') {
      el.disabled = true;
    }
    document.body.appendChild(el);
  });
}

function createChromeMock(initialLocal, activeTabUrl) {
  const store = Object.assign({}, initialLocal || {});
  const listeners = [];
  return {
    chrome: {
      runtime: {
        getManifest: function () { return { version: '1.14.1' }; },
        getURL: function () { return 'print.html'; },
        lastError: null,
        sendMessage: function () { }
      },
      storage: {
        sync: {
          get: function (keys, cb) { cb({}); },
          set: function () { }
        },
        local: {
          get: function (keys, cb) {
            if (typeof keys === 'string') keys = [keys];
            const out = {};
            (keys || []).forEach(function (k) { out[k] = store[k]; });
            cb(out);
          },
          set: function (obj, cb) {
            Object.assign(store, obj);
            if (cb) cb();
          },
          remove: function (keys, cb) {
            (typeof keys === 'string' ? [keys] : keys || []).forEach(function (k) { delete store[k]; });
            if (cb) cb();
          }
        },
        session: {
          get: function () { return Promise.resolve({}); },
          set: function () { return Promise.resolve(); },
          remove: function () { return Promise.resolve(); }
        },
        onChanged: {
          addListener: function (fn) { listeners.push(fn); }
        }
      },
      tabs: {
        query: function (q, cb) {
          cb(activeTabUrl ? [{ id: 1, url: activeTabUrl }] : []);
        },
        create: function () { },
        sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
      }
    },
    listeners: listeners
  };
}

function loadOptions() {
  require('../options/options.js');
}


beforeEach(() => {
  jest.resetModules(); // гарантирует повторное исполнение options.js для каждого теста
  document.body.innerHTML = '';
  setupDom();
  window.buildReferenceText = buildReferenceText;
  window.AiCmExportBuilders = require('../utils/export-text-builders.js');
  global.chrome = createChromeMock({}).chrome; // дефолт; гейт-тесты переопределяют ниже
});

afterEach(() => {
  delete global.chrome;
});

describe('options.js — isChatHome(hostname, pathname) (H8)', () => {
  function loadApi() {
    return require('../options/options.js');
  }

  test('chatgpt: "/" (home) → false; "/c/…" (диалог) → true', () => {
    const api = loadApi();
    expect(api.isChatHome('chatgpt.com', '/')).toBe(false);
    expect(api.isChatHome('chatgpt.com', '/c/abc-def')).toBe(true);
    expect(api.isChatHome('www.chatgpt.com', '/c/abc-def')).toBe(true);
    expect(api.isChatHome('CHATGPT.COM', '/c/abc-def')).toBe(true);
  });

  test('chatgpt: /g/… и /share/… — тоже открытый диалог', () => {
    const api = loadApi();
    expect(api.isChatHome('chatgpt.com', '/g/g-123')).toBe(true);
    expect(api.isChatHome('chatgpt.com', '/share/abc-123')).toBe(true);
  });

  test('gemini: "/" (home) → false; "/app/…" (диалог) → true', () => {
    const api = loadApi();
    expect(api.isChatHome('gemini.google.com', '/')).toBe(false);
    expect(api.isChatHome('gemini.google.com', '/app/xyz789')).toBe(true);
  });

  test('claude: "/chat/…" → true; "/new" и "/" → false', () => {
    const api = loadApi();
    expect(api.isChatHome('claude.ai', '/chat/uuid-claude')).toBe(true);
    expect(api.isChatHome('claude.ai', '/new')).toBe(false);
    expect(api.isChatHome('claude.ai', '/')).toBe(false);
  });

  test('perplexity: "/search/…" и "/follow/…" → true; "/" → false', () => {
    const api = loadApi();
    expect(api.isChatHome('perplexity.ai', '/search/xyz')).toBe(true);
    expect(api.isChatHome('perplexity.ai', '/follow/xyz')).toBe(true);
    expect(api.isChatHome('perplexity.ai', '/')).toBe(false);
  });

  test('deepseek: "/a/…" → true; "/" → false', () => {
    const api = loadApi();
    expect(api.isChatHome('chat.deepseek.com', '/a/x')).toBe(true);
    expect(api.isChatHome('chat.deepseek.com', '/a/chat/s/xyz')).toBe(true);
    expect(api.isChatHome('chat.deepseek.com', '/')).toBe(false);
  });

  test('неизвестный хост / пустой вход → false (поведение как прежде)', () => {
    const api = loadApi();
    expect(api.isChatHome('example.com', '/c/x')).toBe(false);
    expect(api.isChatHome('www.google.com', '/search?q=1')).toBe(false);
    expect(api.isChatHome('', '/c/x')).toBe(false);
    expect(api.isChatHome(null, '/c/x')).toBe(false);
    expect(api.isChatHome(undefined, undefined)).toBe(false);
  });
});

function staleState(overrides) {
  return Object.assign({
    host: 'chatgpt.com',
    site: 'chatgpt',
    model: 'gpt-5',
    tokens: 1000,
    limit: 100000,
    percent: 1,
    updatedAt: 1,
    stale: true
  }, overrides || {});
}

describe('options.js — гейт stale-предупреждения по URL активной вкладки (H8)', () => {
  test('loadStats: stale=true на chatgpt home "/" → предупреждение СКРЫТО', () => {
    const m = createChromeMock({ 'aiCmState:chatgpt.com': staleState() }, 'https://chatgpt.com/');
    global.chrome = m.chrome;
    loadOptions();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const el = document.getElementById('stale-warning');
    expect(el.style.display).toBe('none');
    expect(el.textContent).toBe('');
  });

  test('loadStats: stale=true на диалоге chatgpt "/c/…" → предупреждение ВИДНО', () => {
    const m = createChromeMock({ 'aiCmState:chatgpt.com': staleState() }, 'https://chatgpt.com/c/abc-def');
    global.chrome = m.chrome;
    loadOptions();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const el = document.getElementById('stale-warning');
    expect(el.style.display).toBe('block');
    expect(el.textContent).toContain('Интеграция с ChatGPT');
  });

  test('loadStats: stale=false даже на диалоге → скрыто', () => {
    const m = createChromeMock({ 'aiCmState:chatgpt.com': staleState({ stale: false }) }, 'https://chatgpt.com/c/abc-def');
    global.chrome = m.chrome;
    loadOptions();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const el = document.getElementById('stale-warning');
    expect(el.style.display).toBe('none');
    expect(el.textContent).toBe('');
  });

  test('live onChanged: stale=true на claude "/chat/…" → предупреждение ВИДНО', () => {
    const m = createChromeMock({}, 'https://claude.ai/chat/uuid1');
    global.chrome = m.chrome;
    loadOptions();

    const change = { 'aiCmState:claude.ai': { newValue: staleState({ host: 'claude.ai', site: 'claude' }) } };
    m.listeners.forEach(function (fn) { fn(change, 'local'); });

    const el = document.getElementById('stale-warning');
    expect(el.style.display).toBe('block');
    expect(el.textContent).toContain('Интеграция с Claude');
  });

  test('live onChanged: stale=true на claude "/new" (home) → предупреждение СКРЫТО', () => {
    const m = createChromeMock({}, 'https://claude.ai/new');
    global.chrome = m.chrome;
    loadOptions();

    const change = { 'aiCmState:claude.ai': { newValue: staleState({ host: 'claude.ai', site: 'claude' }) } };
    m.listeners.forEach(function (fn) { fn(change, 'local'); });

    const el = document.getElementById('stale-warning');
    expect(el.style.display).toBe('none');
    expect(el.textContent).toBe('');
  });
});

