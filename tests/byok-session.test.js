// M-7 (фаза 3): BYOK-ключ Google AI Studio — хранение ТОЛЬКО в chrome.storage.session
// ('aiCmApiKeySession') + миграция прежнего plaintext-ключа из chrome.storage.local.
//
// Контур этого сьюта:
//   * options/options.js (jsdom, реальный код страницы настроек): сохранение ключа не
//     пишет plaintext в chrome.storage.local (spy), пишет в chrome.storage.session;
//     статус-строка «Ключ: задан / не задан» — по факту session; кнопка «Убрать ключ»
//     очищает session; прежний plaintext из local переносится в session при открытии;
//   * core/background.js (vm-песочница, реальный код SW): миграция на onInstalled и
//     onStartup ([AI CM][byok] migrated plaintext→session), COUNT_TOKENS без ключа в
//     session → {ok:false, reason:'no-key'} БЕЗ сети, COUNT_TOKENS с ключом в session → сеть;
//   * source-пины: options.html (hint «до перезапуска браузера» + «Убрать ключ»),
//     privacy.html (ред. rev. 3 + «в памяти сессии»).
//
// Существующие сьюты и их моки не изменяются — файл только добавляется.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BG_SRC = fs.readFileSync(path.join(ROOT, 'core', 'background.js'), 'utf8');
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const PRIVACY_HTML = fs.readFileSync(path.join(ROOT, 'privacy', 'privacy.html'), 'utf8');

const SESSION_KEY = 'aiCmApiKeySession';
// Известные имена plaintext-ключа прежних версий — те же, что стирают код и тесты.
const LEGACY_KEYS = [
  'ai_cm_gemini_api_key',
  'ai_cm_api_key',
  'ai_cm_byok_key',
  'aiCmGeminiApiKey',
  'aiCmApiKey',
  'gemini_api_key'
];

/* =====================================================================================
 * 1. options/options.js — сохранение ключа, статус, «Убрать ключ», миграция (jsdom)
 * ===================================================================================== */

function setupOptionsDom() {
  const ids = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent', 'stat-source',
    'model-select', 'custom-limit', 'show-widget', 'toggle-api-key',
    'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag', 'reset-limit',
    'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
    'aiCmProactive', 'aiCmProactiveNotify',
    'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh',
    // M-7: статус-строка и кнопка «Убрать ключ»
    'api-key-status', 'api-key-remove'
  ];
  ids.forEach(function (id) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  });
  // Сам ключ — реальный input type=password (как в options.html)
  const keyInput = document.createElement('input');
  keyInput.id = 'api-key';
  keyInput.type = 'password';
  document.body.appendChild(keyInput);
  const versionEl = document.createElement('span');
  versionEl.className = 'version';
  document.body.appendChild(versionEl);
}

function pick(store, keys) {
  const out = {};
  if (keys == null) { Object.assign(out, store); return out; }
  (typeof keys === 'string' ? [keys] : keys).forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
  });
  return out;
}

function createOptionsChromeMock(initialLocal, initialSession) {
  const localStore = Object.assign({}, initialLocal || {});
  const sessionStore = Object.assign({}, initialSession || {});
  const localSets = [];
  const localRemoves = [];
  const sessionSets = [];
  const sessionRemoves = [];
  const changedListeners = [];
  return {
    localStore: localStore,
    sessionStore: sessionStore,
    localSets: localSets,
    localRemoves: localRemoves,
    sessionSets: sessionSets,
    sessionRemoves: sessionRemoves,
    listeners: changedListeners,
    chrome: {
      runtime: {
        getManifest: function () { return { version: '1.18.0' }; },
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
            if (typeof cb === 'function') cb(pick(localStore, keys));
            return undefined;
          },
          getKeys: function (cb) { cb(Object.keys(localStore)); },
          set: function (obj, cb) {
            localSets.push(Object.assign({}, obj));
            Object.assign(localStore, obj);
            if (cb) cb();
          },
          remove: function (keys, cb) {
            const list = (typeof keys === 'string' ? [keys] : keys || []);
            localRemoves.push(list.slice());
            list.forEach(function (k) { delete localStore[k]; });
            if (cb) cb();
          }
        },
        // Как в options-thresholds.test.js: session отдаёт промис (MV3-стиль)
        session: {
          get: function (keys) { return Promise.resolve(pick(sessionStore, keys)); },
          set: function (obj, cb) {
            sessionSets.push(Object.assign({}, obj));
            Object.assign(sessionStore, obj);
            if (cb) cb();
            return Promise.resolve();
          },
          remove: function (keys, cb) {
            const list = (typeof keys === 'string' ? [keys] : keys || []);
            sessionRemoves.push(list.slice());
            list.forEach(function (k) { delete sessionStore[k]; });
            if (cb) cb();
            return Promise.resolve();
          }
        },
        onChanged: { addListener: function (fn) { changedListeners.push(fn); } }
      },
      tabs: {
        query: function (q, cb) { cb([]); },
        create: function () { },
        sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
      }
    }
  };
}

function mountOptions(local, session) {
  const m = createOptionsChromeMock(local, session);
  global.chrome = m.chrome;
  jest.resetModules();
  require('../options/options.js');
  return m;
}

function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

describe('M-7: options.js — ключ пишется только в chrome.storage.session', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setupOptionsDom();
    window.buildReferenceText = require('../utils/buildReferenceText.js');
    window.AiCmExportBuilders = require('../utils/export-text-builders.js');
  });

  afterEach(() => {
    delete global.chrome;
  });

  test('сохранение: local.set не вызывается с plaintext-ключом, session.set получает aiCmApiKeySession', async () => {
    const m = mountOptions({}, {});
    await flush();

    const input = document.getElementById('api-key');
    input.value = 'AIza-SECRET-KEY';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    // plaintext-ключ НЕ попал в chrome.storage.local ни в каком виде
    const localPatches = JSON.stringify(m.localSets);
    expect(localPatches).not.toContain('AIza-SECRET-KEY');
    m.localSets.forEach(function (o) {
      LEGACY_KEYS.forEach(function (k) { expect(o).not.toHaveProperty(k); });
    });

    // ключ записан ТОЛЬКО в session под именем aiCmApiKeySession
    expect(m.sessionSets).toEqual([{ aiCmApiKeySession: 'AIza-SECRET-KEY' }]);
    expect(m.sessionStore.aiCmApiKeySession).toBe('AIza-SECRET-KEY');
    // прежние plaintext-имена в local удаляются сразу при сохранении
    expect(m.localRemoves.length).toBeGreaterThanOrEqual(1);
    expect(m.localRemoves[m.localRemoves.length - 1]).toEqual(LEGACY_KEYS);
  });

  test('статус-строка: «Ключ: задан» по факту session, «Ключ: не задан» без ключа', async () => {
    const withKey = mountOptions({}, { aiCmApiKeySession: 'k-from-session' });
    await flush();
    expect(document.getElementById('api-key-status').textContent).toBe('Ключ: задан');
    expect(document.getElementById('api-key').value).toBe('k-from-session');

    document.body.innerHTML = '';
    setupOptionsDom();
    mountOptions({}, {});
    await flush();
    expect(document.getElementById('api-key-status').textContent).toBe('Ключ: не задан');
    expect(document.getElementById('api-key').value).toBe('');
  });

  test('кнопка «Убрать ключ» очищает session и переводит статус в «не задан»', async () => {
    const m = mountOptions({}, { aiCmApiKeySession: 'k-to-remove' });
    await flush();

    document.getElementById('api-key-remove')
      .dispatchEvent(new window.Event('click', { bubbles: true }));

    expect(m.sessionRemoves).toEqual([[SESSION_KEY]]);
    expect(m.sessionStore[SESSION_KEY]).toBeUndefined();
    expect(document.getElementById('api-key').value).toBe('');
    expect(document.getElementById('api-key-status').textContent).toBe('Ключ: не задан');
  });

  test('миграция при открытии настроек: plaintext из local → session, из local удалён', async () => {
    const m = mountOptions({ ai_cm_gemini_api_key: 'legacy-plain-key' }, {});
    await flush();

    expect(m.sessionStore[SESSION_KEY]).toBe('legacy-plain-key');
    expect(m.localStore.ai_cm_gemini_api_key).toBeUndefined();
    expect(m.localRemoves[m.localRemoves.length - 1]).toEqual(LEGACY_KEYS);
    expect(document.getElementById('api-key-status').textContent).toBe('Ключ: задан');
    expect(document.getElementById('api-key').value).toBe('legacy-plain-key');
  });
});

/* =====================================================================================
 * 2. core/background.js — миграция plaintext→session и COUNT_TOKENS из session (vm)
 * ===================================================================================== */

function loadBackground(opts) {
  opts = opts || {};
  const logs = [];
  const listeners = { message: [], installed: [], startup: [] };
  const localStore = Object.assign({}, opts.local || {});
  const sessionStore = Object.assign({}, opts.session || {});
  const removals = [];
  const sessionSets = [];
  const storage = {
    localStore: localStore,
    sessionStore: sessionStore,
    removals: removals,
    sessionSets: sessionSets,
    sync: { set: function () { } },
    local: {
      get: function (keys, cb) {
        if (typeof cb !== 'function') return undefined;
        cb(pick(localStore, keys));
        return undefined;
      },
      set: function (obj, cb) { Object.assign(localStore, obj); if (cb) cb(); },
      remove: function (keys, cb) {
        const list = (typeof keys === 'string' ? [keys] : keys || []);
        list.forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(localStore, k)) { delete localStore[k]; removals.push(k); }
        });
        if (cb) cb();
      }
    },
    session: {
      get: function (keys, cb) {
        if (typeof cb !== 'function') return undefined;
        cb(pick(sessionStore, keys));
        return undefined;
      },
      set: function (obj, cb) {
        sessionSets.push(Object.assign({}, obj));
        Object.assign(sessionStore, obj);
        if (cb) cb();
      },
      remove: function (keys, cb) {
        (typeof keys === 'string' ? [keys] : keys || []).forEach(function (k) { delete sessionStore[k]; });
        if (cb) cb();
      },
      setAccessLevel: function () { }
    }
  };

  const sandbox = {
    console: {
      log: (...a) => logs.push(['log', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')])
    },
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (...a) => globalThis.clearInterval(...a),
    Date, JSON, Math, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    AbortController,
    fetch: opts.fetch || jest.fn(() => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') })),
    importScripts: () => { },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '1.18.0' }),
        getURL: (p) => 'chrome-extension://test/' + p,
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
        onStartup: { addListener: (fn) => listeners.startup.push(fn) },
        lastError: null
      },
      storage: storage,
      scripting: {
        getRegisteredContentScripts: () => Promise.resolve([]),
        registerContentScripts: () => Promise.resolve(),
        unregisterContentScripts: () => Promise.resolve()
      },
      action: { setBadgeText: () => { }, setBadgeBackgroundColor: () => { } },
      notifications: { create: () => { }, onButtonClicked: { addListener: () => { } } },
      tabs: { get: () => { }, update: () => { }, remove: () => { } },
      windows: { update: () => { } }
    }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.navigator = { userAgent: 'jest-sw' };
  vm.createContext(sandbox);
  vm.runInContext(BG_SRC, sandbox, { filename: 'core/background.js' });

  return {
    sandbox,
    storage,
    listeners,
    logsText: () => logs.map((e) => e[1]).join('\n'),
    send: (message, sender) => new Promise((resolve) => {
      listeners.message.forEach((fn) => fn(message, sender || { tab: { id: 1 } }, resolve));
    })
  };
}

describe('M-7: background.js — миграция plaintext→session (onInstalled/onStartup)', () => {
  test('onInstalled: ключ из local перенесён в session, из local удалён, лог миграции', () => {
    const bg = loadBackground({ local: { ai_cm_gemini_api_key: 'legacy-plain-key', other: 1 } });

    expect(bg.listeners.installed.length).toBe(1);
    bg.listeners.installed[0]();

    expect(bg.storage.sessionStore[SESSION_KEY]).toBe('legacy-plain-key');
    expect(bg.storage.sessionSets).toContainEqual({ aiCmApiKeySession: 'legacy-plain-key' });
    expect(bg.storage.localStore.ai_cm_gemini_api_key).toBeUndefined();
    expect(bg.storage.removals).toContain('ai_cm_gemini_api_key');
    expect(bg.storage.localStore.other).toBe(1); // чужие ключи не тронуты
    expect(bg.logsText()).toContain('[AI CM][byok] migrated plaintext→session');
  });

  test('onStartup: тот же перенос; повторный запуск без plaintext — миграции нет (идемпотентно)', () => {
    const bg = loadBackground({ local: { ai_cm_gemini_api_key: 'legacy-plain-key' } });

    bg.listeners.startup[0]();
    expect(bg.storage.sessionStore[SESSION_KEY]).toBe('legacy-plain-key');
    expect(bg.storage.removals).toEqual(['ai_cm_gemini_api_key']);

    bg.listeners.startup[0](); // ключа в local уже нет
    expect(bg.storage.sessionSets.length).toBe(1);
    expect(bg.storage.removals).toEqual(['ai_cm_gemini_api_key']);
  });
});

describe('M-7: background.js — COUNT_TOKENS читает ключ из session', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('ключа нет ни в session, ни в local → {ok:false, reason:"no-key"} и fetch не вызван', async () => {
    const fetchMock = jest.fn();
    const bg = loadBackground({ fetch: fetchMock, local: {}, session: {} });

    const p = bg.send({ type: 'COUNT_TOKENS', text: 'без-ключа', model: 'gemini-flash-latest' });
    await jest.advanceTimersByTimeAsync(900); // debounce-окно пройдено
    const res = await p;

    expect(res).toEqual({ ok: false, reason: 'no-key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('ключ в session → сеть идёт, ключ уходит в x-goog-api-key', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ totalTokens: 42 }),
      text: () => Promise.resolve('')
    }));
    const bg = loadBackground({ fetch: fetchMock, local: {}, session: { aiCmApiKeySession: 'session-key' } });

    const p = bg.send({ type: 'COUNT_TOKENS', text: 'с-ключом', model: 'gemini-flash-latest' });
    await jest.advanceTimersByTimeAsync(900);
    const res = await p;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('session-key');
    expect(res.ok).toBe(true);
    expect(res.totalTokens).toBe(42);
  });
});

/* =====================================================================================
 * 3. Source-пины UI/политики: options.html и privacy.html
 * ===================================================================================== */

describe('M-7: options.html — hint о session-only и кнопка «Убрать ключ»', () => {
  test('input остался type=password, eye-тогл на месте', () => {
    const doc = new DOMParser().parseFromString(OPTIONS_HTML, 'text/html');
    const input = doc.getElementById('api-key');
    expect(input).not.toBeNull();
    expect(input.getAttribute('type')).toBe('password');
    expect(doc.getElementById('toggle-api-key')).not.toBeNull();
  });

  test('hint про хранение до перезапуска браузера + chrome.storage.session', () => {
    expect(OPTIONS_HTML).toContain('до перезапуска браузера');
    expect(OPTIONS_HTML).toContain('chrome.storage.session');
    expect(OPTIONS_HTML).toContain('После перезапуска введите заново');
  });

  test('статус-строка и кнопка «Убрать ключ» присутствуют', () => {
    const doc = new DOMParser().parseFromString(OPTIONS_HTML, 'text/html');
    expect(doc.getElementById('api-key-status')).not.toBeNull();
    const btn = doc.getElementById('api-key-remove');
    expect(btn).not.toBeNull();
    expect(btn.textContent.trim()).toBe('Убрать ключ');
  });
});

describe('M-7: privacy.html — редакция rev. 3 и session-only формулировка', () => {
  test('таблица редакций содержит rev. 3 от 2026-09-12', () => {
    expect(PRIVACY_HTML).toContain('rev. 3');
    expect(PRIVACY_HTML).toContain('История редакций');
    expect(PRIVACY_HTML).toContain('2026-09-12 (ред. 3)');
  });

  test('абзац BYOK: ключ хранится в памяти сессии и не пишется на диск', () => {
    expect(PRIVACY_HTML).toContain('в памяти сессии');
    expect(PRIVACY_HTML).toContain('не записывается на диск');
    expect(PRIVACY_HTML).toContain('aiCmApiKeySession');
    // структура прежних обязательных разделов не потеряна
    expect(PRIVACY_HTML).toContain('BYOK-ключ Google AI Studio');
    expect(PRIVACY_HTML).toContain('generativelanguage.googleapis.com');
  });
});
