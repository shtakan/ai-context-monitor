// BYOK-sync: галочка «точный подсчёт токенов» не должна переживать пустой ключ.
//
// Контур:
//   * ключ Google AI Studio хранится ТОЛЬКО в chrome.storage.session и стирается при
//     перезапуске браузера/расширения (M-7, security v54 — контракт не меняется);
//   * флаг точного подсчёта (ai_cm_exact_token_count) лежит в chrome.storage.local и
//     перезапуск переживает;
//   * итог прежнего поведения: после перезапуска ключ пуст, галочка включена, а расчёт
//     молча уходит в эвристику — пользователь думает, что видит точный API-счёт.
//
// Сьют пиннит исправление: options.js гасит флаг при пустом ключе (и пишет false в local
// только в этот момент), а content.js трактует exactCountEnabled как false в рантайме,
// не трогая storage.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const RU = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'ru', 'messages.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));

const SESSION_KEY = 'aiCmApiKeySession';
const FLAG_KEY = 'ai_cm_exact_token_count';
const WARNING = 'Ключ API не найден. Введите ключ заново, чтобы включить точный подсчёт';

/* =====================================================================================
 * 1. options/options.js — галочка гаснет без ключа (jsdom, реальный код страницы)
 * ===================================================================================== */

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
  // Галочка точного подсчёта — настоящий input[type=checkbox] (как в options.html)
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'exact-count';
  document.body.appendChild(checkbox);
  // Подсказка под галочкой — span.hint[role=status] (как в options.html)
  const warning = document.createElement('span');
  warning.id = 'exact-count-warning';
  document.body.appendChild(warning);
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

function createChromeMock(initialLocal, initialSession) {
  const localStore = Object.assign({}, initialLocal || {});
  const sessionStore = Object.assign({}, initialSession || {});
  const localSets = [];
  const sessionRemoves = [];
  return {
    localStore: localStore,
    sessionStore: sessionStore,
    localSets: localSets,
    sessionRemoves: sessionRemoves,
    chrome: {
      runtime: {
        getManifest: function () { return { version: '2.0.30' }; },
        getURL: function () { return 'print.html'; },
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
        // Как в MV3: session.get отдаёт промис, если колбэк не передан.
        session: {
          get: function (keys) { return Promise.resolve(pick(sessionStore, keys)); },
          set: function (obj, cb) {
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

function mountOptions(local, session) {
  const m = createChromeMock(local, session);
  global.chrome = m.chrome;
  jest.resetModules();
  require('../options/options.js');
  return m;
}

function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function flagCheckbox() {
  return document.getElementById('exact-count');
}

function warningEl() {
  return document.getElementById('exact-count-warning');
}

describe('BYOK-sync: options.js — без ключа флаг точного подсчёта гаснет', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setupOptionsDom();
    window.buildReferenceText = require('../utils/buildReferenceText.js');
    window.AiCmExportBuilders = require('../utils/export-text-builders.js');
  });

  afterEach(() => {
    delete global.chrome;
  });

  test('ключ отсутствует + флаг true → галочка снята, local=false, подсказка показана', async () => {
    const m = mountOptions({ [FLAG_KEY]: true }, {});
    await flush();

    expect(flagCheckbox().checked).toBe(false);
    expect(m.localStore[FLAG_KEY]).toBe(false);
    expect(m.localSets).toContainEqual({ [FLAG_KEY]: false });
    expect(warningEl().textContent).toBe(WARNING);
  });

  test('ключ есть → галочка остаётся включённой, подсказки нет, local не переписан', async () => {
    const m = mountOptions({ [FLAG_KEY]: true }, { [SESSION_KEY]: 'AIza-session-key' });
    await flush();

    expect(flagCheckbox().checked).toBe(true);
    expect(warningEl().textContent).toBe('');
    expect(m.localSets.filter((o) => Object.prototype.hasOwnProperty.call(o, FLAG_KEY))).toEqual([]);
  });

  test('флаг уже false → подсказки нет и запись в local не выполняется', async () => {
    const m = mountOptions({ [FLAG_KEY]: false }, {});
    await flush();

    expect(flagCheckbox().checked).toBe(false);
    expect(warningEl().textContent).toBe('');
    expect(m.localSets.filter((o) => Object.prototype.hasOwnProperty.call(o, FLAG_KEY))).toEqual([]);
  });

  test('«Убрать ключ» при включённой галочке снимает её и пишет false в local', async () => {
    const m = mountOptions({}, { [SESSION_KEY]: 'AIza-session-key' });
    await flush();
    flagCheckbox().checked = true;

    document.getElementById('api-key-remove')
      .dispatchEvent(new window.Event('click', { bubbles: true }));

    expect(m.sessionRemoves).toEqual([[SESSION_KEY]]);
    expect(flagCheckbox().checked).toBe(false);
    expect(m.localStore[FLAG_KEY]).toBe(false);
    expect(warningEl().textContent).toBe(WARNING);
  });

  test('включить галочку без ключа нельзя: change сразу гасит её и показывает подсказку', async () => {
    const m = mountOptions({ [FLAG_KEY]: false }, {});
    await flush();

    flagCheckbox().checked = true;
    flagCheckbox().dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(flagCheckbox().checked).toBe(false);
    expect(m.localStore[FLAG_KEY]).toBe(false);
    expect(warningEl().textContent).toBe(WARNING);
  });
});

/* =====================================================================================
 * 2. Разметка и локали: подсказка под чекбоксом
 * ===================================================================================== */

describe('BYOK-sync: options.html / локали — подсказка под галочкой', () => {
  test('span#exact-count-warning[role=status] стоит в секции с чекбоксом', () => {
    const doc = new DOMParser().parseFromString(OPTIONS_HTML, 'text/html');
    const warning = doc.getElementById('exact-count-warning');
    expect(warning).not.toBeNull();
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.classList.contains('hint')).toBe(true);
    // Пустая подсказка в разметке: текст приходит из локали в рантайме (без кириллицы в HTML)
    expect(warning.textContent.trim()).toBe('');
    expect(warning.parentElement.querySelector('#exact-count')).not.toBeNull();
  });

  test('ключ options_exact_count_nokey есть в ru и en, ru = фолбэк options.js', () => {
    expect(RU.options_exact_count_nokey.message).toBe(WARNING);
    expect(EN.options_exact_count_nokey.message.length).toBeGreaterThan(0);
    expect(/[А-Яа-яЁё]/.test(EN.options_exact_count_nokey.message)).toBe(false);
    // options.js использует ровно ту же строку как фолбэк при недоступном chrome.i18n
    const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
    expect(OPTIONS_SRC).toContain(WARNING);
  });
});

/* =====================================================================================
 * 3. core/content.js — пустой ключ делает exactCountEnabled ложным в рантайме
 * ===================================================================================== */

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

describe('BYOK-sync: content.js — без ключа флаг точного счёта ложен и в рантайме', () => {
  test('aiCmByokFlag(false) гасит exactCountEnabled, aiCmByokFlag(true) его не трогает', () => {
    const fnSrc = extractFunction(CONTENT_SRC, 'aiCmByokFlag');
    expect(fnSrc.length).toBeGreaterThan(0);

    const noKey = { exactCountEnabled: true };
    vm.createContext(noKey);
    vm.runInContext(fnSrc, noKey, { filename: 'core/content.js#aiCmByokFlag' });
    expect(noKey.aiCmByokFlag(false)).toBe('');
    expect(noKey.exactCountEnabled).toBe(false);

    const withKey = { exactCountEnabled: true };
    vm.createContext(withKey);
    vm.runInContext(fnSrc, withKey, { filename: 'core/content.js#aiCmByokFlag' });
    expect(withKey.aiCmByokFlag(true)).toBe('1');
    expect(withKey.exactCountEnabled).toBe(true);
  });

  test('все потребители флага дополнительно требуют наличия ключа (страховка)', () => {
    // Точный подсчёт, удержание эвристики и сетевой путь COUNT_TOKENS — все под двойным
    // условием exactCountEnabled && geminiApiKey, поэтому пустой ключ не включает API-счёт.
    const guards = CONTENT_SRC.match(/!exactCountEnabled \|\| !geminiApiKey/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    expect(CONTENT_SRC).toContain('isGeminiSvc && exactCountEnabled && geminiApiKey');
  });

  test('контент не обращается к chrome.storage.session (security v54 не нарушена)', () => {
    // Упоминания в комментариях допустимы, вызовов API — нет.
    expect(/chrome\.storage\.session\s*\.\s*(get|set|remove|clear)\b/.test(CONTENT_SRC)).toBe(false);
  });
});
