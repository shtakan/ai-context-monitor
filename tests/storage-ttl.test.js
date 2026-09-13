// M-8 (фаза 3, первая задача): TTL per-host истории — core/background.js + core/content.js.
//
// Аудит: записи 'aiCmHistory:<host>' (chrome.storage.local, per-host) не имели срока
// жизни — хранилище росло неограниченно месяцами. Контур:
//   * core/background.js — prune перебирает ключи 'aiCmHistory:*' и удаляет записи с ts
//     старше TTL (30 дней); вызов на chrome.runtime.onStartup и chrome.runtime.onInstalled,
//     ленивый вызов при записи того же ключа (chrome.storage.onChanged, area=local);
//   * core/content.js — каждая запись 'aiCmHistory:<host>' несёт аддитивное поле
//     ts = Date.now(); глобальный ключ 'aiCmHistory' пишется ПРЕЖНЕЙ формой (не трогаем).
//
// Сьют грузит РЕАЛЬНЫЙ core/background.js в vm-песочницу (как background-counttokens.test.js),
// storage-мок — stateful (store/removed), поэтому проверяется исполняемый prune, а не текст.
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BG_SRC = fs.readFileSync(path.join(ROOT, 'core', 'background.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');

const DAY_MS = 86400000;
const TTL_MS = 2592000000; // 30 дней — значение пинуется ниже против core/background.js

// === Stateful storage-мок: get(null) отдаёт весь store, remove реально удаляет ===
function makeStorage(initial) {
  const store = Object.assign({}, initial || {});
  const removed = [];
  const changedListeners = [];
  let getCalls = 0;
  const local = {
    get: function (keys, cb) {
      getCalls++;
      if (typeof cb !== 'function') return undefined;
      const out = {};
      if (keys == null) {
        Object.assign(out, store);
      } else {
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
        });
      }
      cb(out);
      return undefined;
    },
    set: function (obj, cb) {
      Object.assign(store, obj);
      if (typeof cb === 'function') cb();
      return undefined;
    },
    remove: function (keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(store, k)) {
          delete store[k];
          removed.push(k);
        }
      });
      if (typeof cb === 'function') cb();
      return undefined;
    }
  };
  return {
    store: store,
    removed: removed,
    listeners: changedListeners,
    getCalls: function () { return getCalls; },
    onChanged: { addListener: function (fn) { changedListeners.push(fn); } },
    local: local
  };
}

// === Песочница SW: тот же минимум chrome API, что и в background-counttokens.test.js ===
function loadBackground(storage) {
  const logs = [];
  const listeners = { message: [], installed: [], startup: [] };
  const sandbox = {
    console: {
      log: (...a) => logs.push(['log', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')])
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    JSON,
    Math,
    Map,
    Set,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    AbortController,
    fetch: () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') }),
    importScripts: () => { },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '1.19.0' }),
        getURL: (p) => 'chrome-extension://test/' + p,
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
        onStartup: { addListener: (fn) => listeners.startup.push(fn) },
        lastError: null
      },
      storage: {
        local: storage.local,
        onChanged: storage.onChanged,
        session: {
          get: (keys, cb) => { if (cb) cb({}); },
          set: (obj, cb) => { if (cb) cb(); },
          setAccessLevel: () => { }
        },
        sync: { set: () => { } }
      },
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
    listeners,
    logsText: () => logs.map((e) => e[1]).join('\n')
  };
}

// Рез объявления функции по балансу фигурных скобок (как в tests/gsa-autoexport.test.js).
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

function historyFixture(now) {
  return {
    'aiCmHistory:old.example': { host: 'old.example', convId: 'c-old', site: 'chatgpt', ts: now - 31 * DAY_MS, messages: [] },
    'aiCmHistory:fresh.example': { host: 'fresh.example', convId: 'c-fresh', site: 'claude', ts: now - 1 * DAY_MS, messages: [] },
    // запись прежней версии (без ts) — «форма записи сохраняется», не удаляем
    'aiCmHistory:legacy.example': { host: 'legacy.example', convId: 'c-legacy', site: 'gemini', messages: [] },
    // глобальный ключ (last-writer-wins) — семантика прежняя, prune его не трогает
    aiCmHistory: { host: 'old.example', convId: 'c-old', site: 'chatgpt', ts: now - 400 * DAY_MS, messages: [] },
    // чужой префикс — sweep его не читает
    'aiCmState:old.example': { host: 'old.example', percent: 10 }
  };
}

describe('M-8: prune TTL истории — core/background.js', () => {
  test('константа TTL = 30 дней (2592000000) и вызовы в onStartup/onInstalled', () => {
    expect(TTL_MS).toBe(2592000000);
    expect(BG_SRC).toContain('var AI_CM_HISTORY_TTL_MS = 2592000000;');
    // оба обработчика регистрируются и вызывают prune (порядок: prune до ensureInterceptor)
    const installed = BG_SRC.slice(BG_SRC.indexOf('chrome.runtime.onInstalled.addListener'), BG_SRC.indexOf('if (chrome.runtime.onStartup)'));
    const startup = BG_SRC.slice(BG_SRC.indexOf('if (chrome.runtime.onStartup)'), BG_SRC.indexOf('chrome.runtime.onMessage.addListener'));
    expect(installed).toContain('aiCmPruneHistory();');
    expect(startup).toContain('aiCmPruneHistory();');
  });

  test('onStartup: 31 день → удалена, 1 день → жива, без ts и глобальный ключ не тронуты', () => {
    const now = Date.now();
    const storage = makeStorage(historyFixture(now));
    const bg = loadBackground(storage);

    expect(bg.listeners.startup.length).toBe(1);
    expect(bg.listeners.installed.length).toBe(1);

    bg.listeners.startup[0]();

    expect(storage.removed).toEqual(['aiCmHistory:old.example']);
    expect(storage.store['aiCmHistory:old.example']).toBeUndefined();
    expect(storage.store['aiCmHistory:fresh.example']).toBeTruthy();
    expect(storage.store['aiCmHistory:legacy.example']).toBeTruthy(); // ts нет → не удаляем
    expect(storage.store.aiCmHistory).toBeTruthy();                   // глобальный ключ не тронут
    expect(storage.store['aiCmState:old.example']).toBeTruthy();      // чужой префикс не тронут
    expect(bg.logsText()).toContain('[AI CM][storage] prune removed=1');
  });

  test('onInstalled: тот же prune-контур (31 день → удалена)', () => {
    const now = Date.now();
    const storage = makeStorage({
      'aiCmHistory:old.example': { host: 'old.example', ts: now - 31 * DAY_MS },
      'aiCmHistory:fresh.example': { host: 'fresh.example', ts: now - 2 * DAY_MS }
    });
    const bg = loadBackground(storage);

    bg.listeners.installed[0]();

    expect(storage.removed).toEqual(['aiCmHistory:old.example']);
    expect(storage.store['aiCmHistory:fresh.example']).toBeTruthy();
    expect(bg.logsText()).toContain('[AI CM][storage] prune removed=1');
  });

  test('просрочки нет → removed=0, remove не вызывается', () => {
    const now = Date.now();
    const storage = makeStorage({
      'aiCmHistory:fresh.example': { host: 'fresh.example', ts: now - 3 * DAY_MS }
    });
    const bg = loadBackground(storage);

    bg.listeners.startup[0]();

    expect(storage.removed).toEqual([]);
    expect(bg.logsText()).toContain('[AI CM][storage] prune removed=0');
  });

  test('ленивый вызов: запись per-host ключа истории в local запускает prune', () => {
    const now = Date.now();
    const storage = makeStorage(historyFixture(now));
    const bg = loadBackground(storage);

    expect(storage.listeners.length).toBe(1);
    const before = storage.getCalls();

    storage.listeners[0]({ 'aiCmHistory:fresh.example': { newValue: { ts: now } } }, 'local');

    expect(storage.getCalls()).toBeGreaterThan(before); // sweep пошёл
    expect(storage.removed).toEqual(['aiCmHistory:old.example']);
    expect(bg.logsText()).toContain('[AI CM][storage] prune removed=1');
  });

  test('ленивый вызов не срабатывает на чужой ключ и на sync-область', () => {
    const now = Date.now();
    const storage = makeStorage(historyFixture(now));
    const bg = loadBackground(storage);
    const before = storage.getCalls();

    storage.listeners[0]({ 'aiCmState:old.example': { newValue: { percent: 1 } } }, 'local');
    storage.listeners[0]({ 'aiCmHistory:old.example': { newValue: { ts: now } } }, 'sync');
    storage.listeners[0](null, 'local');

    expect(storage.getCalls()).toBe(before);
    expect(storage.removed).toEqual([]);
  });
});

describe('M-8: запись истории несёт ts — core/content.js', () => {
  test('все per-host записи идут через aiCmHostHistoryRecord (3 точки)', () => {
    const writes = CONTENT_SRC.match(
      /histPatch\w*\['aiCmHistory:' \+ window\.location\.hostname\] = aiCmHostHistoryRecord\(histSnapshot\w*\);/g
    ) || [];
    expect(writes.length).toBe(3);
    // ни одной «сырой» per-host записи без ts не осталось
    expect(CONTENT_SRC).not.toMatch(/\['aiCmHistory:' \+ window\.location\.hostname\] = histSnapshot\w*;/);
  });

  test('хелпер: ts = Date.now() аддитивно, глобальный snapshot не мутируется', () => {
    const helper = fnDecl(CONTENT_SRC, 'aiCmHostHistoryRecord');
    const make = new Function('Date', 'snapshot', helper + '\n return aiCmHostHistoryRecord(snapshot);');
    const snapshot = { host: 'chatgpt.com', convId: 'c1', site: 'chatgpt', messages: [{ role: 'user', text: 'x' }] };
    const rec = make({ now: function () { return 1726000000000; } }, snapshot);

    expect(rec.ts).toBe(1726000000000);
    expect(rec.host).toBe('chatgpt.com');
    expect(rec.messages).toBe(snapshot.messages);
    expect(rec).not.toBe(snapshot);
    expect(snapshot.ts).toBeUndefined(); // глобальная форма (тот же snapshot) не изменилась
  });

  test('НЕ трогать: глобальный ключ пишется прежней формой', () => {
    expect(CONTENT_SRC).toContain('var histPatch = { aiCmHistory: histSnapshot };');
    expect(CONTENT_SRC).toContain('var histPatchS24 = { aiCmHistory: histSnapshotS24 };');
  });
});
