// v2.0.34 (P0): точная детекция движка для BYOK-гейтов.
//
// Регрессия: Chrome 148+ выставляет в области расширения алиас `browser`, поэтому
// прежняя проверка `typeof browser !== 'undefined'` стала истинной и на Chrome:
// options.js прятал секции API-ключа, background.js отвечал 'byok-disabled-firefox',
// content.js молча уходил в эвристику. Единственный надёжный признак — схема URL
// расширения (moz-extension:// у Firefox, chrome-extension:// у Chrome), см. utils/platform.js.
//
// Сьют пиннит обе стороны: Chrome с алиасом `browser` → BYOK-UI виден, реальный
// Firefox → секции по-прежнему скрыты и флаг точного подсчёта сброшен.
const { aiCmIsFirefox } = require('../utils/platform.js');

/* =====================================================================================
 * 1. aiCmIsFirefox(): чистая функция
 * ===================================================================================== */

function chromeApi(prefix) {
  return { runtime: { getURL: function (p) { return prefix + (p || ''); } } };
}

describe('aiCmIsFirefox: определение движка по схеме URL расширения', () => {
  afterEach(() => {
    delete global.browser;
    delete global.chrome;
  });

  test('Chrome: chrome-extension:// → false', () => {
    global.chrome = chromeApi('chrome-extension://abcdefghijklmnop/');
    expect(aiCmIsFirefox()).toBe(false);
  });

  test('Chrome 148+: алиас browser тоже присутствует, getURL всё равно chrome-extension:// → false', () => {
    global.browser = chromeApi('chrome-extension://abcdefghijklmnop/');
    global.chrome = chromeApi('chrome-extension://abcdefghijklmnop/');
    expect(aiCmIsFirefox()).toBe(false);
  });

  test('Firefox: moz-extension:// → true', () => {
    global.browser = chromeApi('moz-extension://1234-uuid/');
    expect(aiCmIsFirefox()).toBe(true);
  });

  test('Firefox: browser и chrome с moz-схемой → true', () => {
    global.browser = chromeApi('moz-extension://1234-uuid/');
    global.chrome = chromeApi('moz-extension://1234-uuid/');
    expect(aiCmIsFirefox()).toBe(true);
  });

  test('нет ни browser, ни chrome → false', () => {
    delete global.browser;
    delete global.chrome;
    expect(aiCmIsFirefox()).toBe(false);
  });

  test('api без getURL → false', () => {
    global.chrome = { runtime: {} };
    expect(aiCmIsFirefox()).toBe(false);
  });

  test('getURL бросает исключение → false, без падения', () => {
    global.chrome = { runtime: { getURL: function () { throw new Error('boom'); } } };
    expect(aiCmIsFirefox()).toBe(false);
  });

  test('не-ext-схема (http/about) → false', () => {
    global.chrome = chromeApi('https://example.com/');
    expect(aiCmIsFirefox()).toBe(false);
    global.chrome = chromeApi('about:blank?moz-extension://');
    expect(aiCmIsFirefox()).toBe(false);
  });
});

/* =====================================================================================
 * 2. options/options.js (jsdom, реальный код страницы настроек)
 * ===================================================================================== */

const SESSION_KEY = 'aiCmApiKeySession';
const FLAG_KEY = 'ai_cm_exact_token_count';

function setupOptionsDom() {
  const ids = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent', 'stat-source',
    'model-select', 'custom-limit', 'show-widget', 'toggle-api-key',
    'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag', 'reset-limit',
    'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
    'aiCmProactive', 'aiCmProactiveNotify',
    'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh',
    'api-key-status', 'api-key-remove'
  ];
  ids.forEach(function (id) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  });
  const keyInput = document.createElement('input');
  keyInput.id = 'api-key';
  keyInput.type = 'password';
  document.body.appendChild(keyInput);
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'exact-count';
  document.body.appendChild(checkbox);
  const warning = document.createElement('span');
  warning.id = 'exact-count-warning';
  document.body.appendChild(warning);
  const versionEl = document.createElement('span');
  versionEl.className = 'version';
  document.body.appendChild(versionEl);
  // В реальной разметке оба контрола лежат в div.section — options.js ищет
  // el.closest('.section'), чтобы скрыть секцию целиком.
  ['api-key', 'exact-count'].forEach(function (id) {
    const el = document.getElementById(id);
    const section = document.createElement('div');
    section.className = 'section';
    el.parentNode.insertBefore(section, el);
    section.appendChild(el);
  });
}

function pick(store, keys) {
  const out = {};
  if (keys == null) { Object.assign(out, store); return out; }
  (typeof keys === 'string' ? [keys] : keys).forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
  });
  return out;
}

function createChromeMock(urlScheme, initialLocal, initialSession) {
  const localStore = Object.assign({}, initialLocal || {});
  const sessionStore = Object.assign({}, initialSession || {});
  const localSets = [];
  return {
    localStore: localStore,
    sessionStore: sessionStore,
    localSets: localSets,
    chrome: {
      runtime: {
        getManifest: function () { return { version: '2.0.33' }; },
        getURL: function (p) { return urlScheme + (p || ''); },
        lastError: null,
        sendMessage: function () { }
      },
      storage: {
        sync: { get: function (keys, cb) { cb({}); }, set: function () { } },
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
          remove: function (keys, cb) { if (cb) cb(); }
        },
        session: {
          get: function (keys) { return Promise.resolve(pick(sessionStore, keys)); },
          set: function (obj, cb) {
            Object.assign(sessionStore, obj);
            if (cb) cb();
            return Promise.resolve();
          },
          remove: function (keys, cb) {
            (typeof keys === 'string' ? [keys] : keys || []).forEach(function (k) {
              delete sessionStore[k];
            });
            if (cb) cb();
            return Promise.resolve();
          }
        },
        onChanged: { addListener: function () { } }
      },
      tabs: {
        query: function (q, cb) { cb([]); },
        create: function () { },
        sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
      }
    }
  };
}

function mountOptions(urlScheme, local, session, withBrowserAlias) {
  const m = createChromeMock(urlScheme, local, session);
  global.chrome = m.chrome;
  // Chrome 148+ выставляет алиас browser ДО исполнения скриптов расширения —
  // повторяем порядок, чтобы детекция проверялась на момент загрузки options.js.
  if (withBrowserAlias) global.browser = m.chrome;
  jest.resetModules();
  require('../options/options.js');
  return m;
}

function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function sectionOf(id) {
  return document.getElementById(id).closest('.section');
}

describe('options.js: BYOK-UI по движку (Chrome 148+ больше не скрывает ключ)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setupOptionsDom();
    window.buildReferenceText = require('../utils/buildReferenceText.js');
    window.AiCmExportBuilders = require('../utils/export-text-builders.js');
  });

  afterEach(() => {
    delete global.browser;
    delete global.chrome;
  });

  test('Chrome с алиасом browser: секции видимы, флаг точного подсчёта не сброшен', async () => {
    // Именно этот случай ломал BYOK: оба глобала есть, но URL — chrome-extension://.
    const m = mountOptions(
      'chrome-extension://abcdefghijklmnop/',
      { [FLAG_KEY]: true },
      { [SESSION_KEY]: 'AIza-session-key' },
      true
    );
    await flush();

    expect(sectionOf('api-key').hidden).toBe(false);
    expect(sectionOf('api-key').style.display).not.toBe('none');
    expect(sectionOf('exact-count').hidden).toBe(false);
    expect(document.getElementById('exact-count').checked).toBe(true);
    expect(m.localSets.filter(function (o) {
      return Object.prototype.hasOwnProperty.call(o, FLAG_KEY);
    })).toEqual([]);
  });

  test('Firefox: секции скрыты, включённый флаг сброшен в local', async () => {
    const m = mountOptions(
      'moz-extension://1234-uuid/',
      { [FLAG_KEY]: true },
      { [SESSION_KEY]: 'AIza-session-key' }
    );
    await flush();

    expect(sectionOf('api-key').hidden).toBe(true);
    expect(sectionOf('api-key').style.display).toBe('none');
    expect(sectionOf('exact-count').hidden).toBe(true);
    expect(m.localStore[FLAG_KEY]).toBe(false);
  });
});
