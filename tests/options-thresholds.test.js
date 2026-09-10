/**
 * S2 (бэклог «Настраиваемые пороги»): юнит-тесты UI options/options.js для
 * 'aiCmProactiveThresholds' = [low, medium, high] (1–100, строго возрастают).
 * Проверки:
 *   - загрузка дефолта [70,85,95] при отсутствии сохранённого значения;
 *   - загрузка валидного сохранённого значения;
 *   - битое сохранённое значение / битый ввод → фолбэк [70,85,95] + console.warn;
 *   - валидный ввод сохраняется в chrome.storage.local;
 *   - внешний onChanged обновляет поля (если не в фокусе).
 * Плюс покрытие валидатора/чтения utils/gemini-intercept-logic.js (та же цепочка).
 */

const buildReferenceText = require('../utils/buildReferenceText.js');

function setupDom() {
  const ids = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent',
    'model-select', 'custom-limit', 'show-widget', 'api-key', 'toggle-api-key',
    'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag', 'reset-limit',
    'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
    'aiCmProactive', 'aiCmProactiveNotify',
    'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh'
  ];
  ids.forEach(function (id) {
    const isNumber = id === 'aiCmProactiveLow' || id === 'aiCmProactiveMedium' || id === 'aiCmProactiveHigh';
    const el = isNumber ? document.createElement('input') : document.createElement('div');
    el.id = id;
    if (isNumber) { el.type = 'number'; }
    if (id === 'aiCmAutoExportPct') el.value = '90';
    document.body.appendChild(el);
  });
  const versionEl = document.createElement('span');
  versionEl.className = 'version';
  document.body.appendChild(versionEl);
}

function createChromeMock(initialLocal) {
  const store = Object.assign({}, initialLocal || {});
  const localSets = [];
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
            localSets.push(Object.assign({}, obj));
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
        query: function (q, cb) { cb([]); },
        create: function () { },
        sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
      }
    },
    localSets: localSets,
    listeners: listeners
  };
}

function loadOptions() {
  require('../options/options.js');
}

function inputValue(id) {
  const el = document.getElementById(id);
  return el ? String(el.value) : null;
}
function fireChange(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error('нет элемента ' + id);
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

let warnSpy = null;

beforeEach(() => {
  jest.resetModules(); // гарантирует повторное исполнение options.js для каждого теста
  document.body.innerHTML = '';
  setupDom();
  window.buildReferenceText = buildReferenceText;
  window.AiCmExportBuilders = require('../utils/export-text-builders.js');
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (warnSpy) warnSpy.mockRestore();
  delete global.chrome;
});
describe('options.js — проактивные пороги (S2: aiCmProactiveThresholds)', () => {
  test('нет сохранённого значения → поля показывают дефолт 70/85/95', () => {
    const m = createChromeMock({});
    global.chrome = m.chrome;
    loadOptions();
    expect(inputValue('aiCmProactiveLow')).toBe('70');
    expect(inputValue('aiCmProactiveMedium')).toBe('85');
    expect(inputValue('aiCmProactiveHigh')).toBe('95');
  });

  test('валидное сохранённое значение [60,80,90] → поля 60/80/90', () => {
    const m = createChromeMock({ aiCmProactiveThresholds: [60, 80, 90] });
    global.chrome = m.chrome;
    loadOptions();
    expect(inputValue('aiCmProactiveLow')).toBe('60');
    expect(inputValue('aiCmProactiveMedium')).toBe('80');
    expect(inputValue('aiCmProactiveHigh')).toBe('90');
  });

  test('битое сохранённое значение (не возрастает) → фолбэк [70,85,95] + console.warn', () => {
    const m = createChromeMock({ aiCmProactiveThresholds: [80, 70, 95] });
    global.chrome = m.chrome;
    loadOptions();
    expect(inputValue('aiCmProactiveLow')).toBe('70');
    expect(inputValue('aiCmProactiveMedium')).toBe('85');
    expect(inputValue('aiCmProactiveHigh')).toBe('95');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[AI CM][thresholds]'), expect.any(Array));
  });

  test('битое сохранённое значение (вне диапазона 1–100) → фолбэк + console.warn', () => {
    const m = createChromeMock({ aiCmProactiveThresholds: [0, 50, 150] });
    global.chrome = m.chrome;
    loadOptions();
    expect(inputValue('aiCmProactiveLow')).toBe('70');
    expect(inputValue('aiCmProactiveHigh')).toBe('95');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[AI CM][thresholds]'), expect.any(Array));
  });

  test('валидный ввод [20,55,90] сохраняется в chrome.storage.local', () => {
    const m = createChromeMock({});
    global.chrome = m.chrome;
    loadOptions();
    document.getElementById('aiCmProactiveLow').value = '20';
    document.getElementById('aiCmProactiveMedium').value = '55';
    document.getElementById('aiCmProactiveHigh').value = '90';
    fireChange('aiCmProactiveLow');
    fireChange('aiCmProactiveMedium');
    fireChange('aiCmProactiveHigh');
    const last = m.localSets[m.localSets.length - 1];
    expect(last.aiCmProactiveThresholds).toEqual([20, 55, 90]);
    expect(inputValue('aiCmProactiveLow')).toBe('20');
    expect(inputValue('aiCmProactiveHigh')).toBe('90');
  });

  test('битый ввод (не возрастает: 90/80/95) → фолбэк [70,85,95] + console.warn + запись дефолта', () => {
    const m = createChromeMock({});
    global.chrome = m.chrome;
    loadOptions();
    document.getElementById('aiCmProactiveLow').value = '90';
    document.getElementById('aiCmProactiveMedium').value = '80';
    document.getElementById('aiCmProactiveHigh').value = '95';
    fireChange('aiCmProactiveMedium');
    const last = m.localSets[m.localSets.length - 1];
    expect(last.aiCmProactiveThresholds).toEqual([70, 85, 95]);
    expect(inputValue('aiCmProactiveLow')).toBe('70');
    expect(inputValue('aiCmProactiveMedium')).toBe('85');
    expect(inputValue('aiCmProactiveHigh')).toBe('95');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[AI CM][thresholds]'), expect.any(Array));
  });

  test('битый ввод (диапазон: 0/85/95) → фолбэк [70,85,95] + console.warn', () => {
    const m = createChromeMock({});
    global.chrome = m.chrome;
    loadOptions();
    document.getElementById('aiCmProactiveLow').value = '0';
    fireChange('aiCmProactiveLow');
    const last = m.localSets[m.localSets.length - 1];
    expect(last.aiCmProactiveThresholds).toEqual([70, 85, 95]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[AI CM][thresholds]'), expect.any(Array));
  });

  test('внешний onChanged (валидное значение) обновляет поля', () => {
    const m = createChromeMock({});
    global.chrome = m.chrome;
    loadOptions();
    // Пробуем каждый зарегистрированный onChanged-слушатель: обновление сделает
    // только тот, что подписан на aiCmProactiveThresholds.
    const change = { aiCmProactiveThresholds: { newValue: [55, 66, 77] } };
    m.listeners.forEach(function (fn) { fn(change, 'local'); });
    expect(inputValue('aiCmProactiveLow')).toBe('55');
    expect(inputValue('aiCmProactiveMedium')).toBe('66');
    expect(inputValue('aiCmProactiveHigh')).toBe('77');
  });
});

describe('utils/gemini-intercept-logic.js — normalize/getProactiveThresholds (S2)', () => {
  const L = require('../utils/gemini-intercept-logic.js');

  test('normalizeProactiveThresholds: валидные и битые значения', () => {
    expect(L.normalizeProactiveThresholds([60, 80, 90])).toEqual([60, 80, 90]);
    expect(L.normalizeProactiveThresholds(['60', '80', '90'])).toEqual([60, 80, 90]);
    expect(L.normalizeProactiveThresholds([70, 85, 95])).toEqual([70, 85, 95]);
    // не возрастает
    expect(L.normalizeProactiveThresholds([80, 70, 95])).toBeNull();
    // диапазон
    expect(L.normalizeProactiveThresholds([0, 85, 95])).toBeNull();
    expect(L.normalizeProactiveThresholds([70, 85, 101])).toBeNull();
    // не-массив / мало элементов
    expect(L.normalizeProactiveThresholds(null)).toBeNull();
    expect(L.normalizeProactiveThresholds('70')).toBeNull();
    expect(L.normalizeProactiveThresholds([70, 85])).toBeNull();
  });

  test('getProactiveThresholds: storage недоступен → дефолт [70,85,95]', async () => {
    const prev = global.chrome;
    delete global.chrome;
    const t = await L.getProactiveThresholds();
    expect(t).toEqual([70, 85, 95]);
    if (prev) global.chrome = prev; else delete global.chrome;
  });

  test('getProactiveThresholds: валидное значение из storage → как есть', async () => {
    global.chrome = {
      storage: {
        local: {
          get: function (keys, cb) { cb({ aiCmProactiveThresholds: [60, 80, 90] }); }
        }
      }
    };
    const t = await L.getProactiveThresholds();
    expect(t).toEqual([60, 80, 90]);
    delete global.chrome;
  });

  test('getProactiveThresholds: битое значение из storage → дефолт [70,85,95]', async () => {
    const w2 = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.chrome = {
      storage: {
        local: {
          get: function (keys, cb) { cb({ aiCmProactiveThresholds: [90, 80, 95] }); }
        }
      }
    };
    const t = await L.getProactiveThresholds();
    expect(t).toEqual([70, 85, 95]);
    expect(w2).toHaveBeenCalledWith(expect.stringContaining('[AI CM][thresholds]'), expect.any(Array));
    w2.mockRestore();
    delete global.chrome;
  });
});

