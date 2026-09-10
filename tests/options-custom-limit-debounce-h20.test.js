/**
 * H20: дебаунс поля «Лимит контекста» (options/options.js, id="custom-limit").
 *
 * Живой баг (2026-09-09): ввод «50» писал в chrome.storage.sync КАЖДЫЙ keystroke,
 * поэтому промежуточное «5» на миг становилось лимитом 5% от Авто-порога
 * (gemini-2.5-flash: 128 000 × 5% = 6 400) → ложное уведомление
 * «Заполнение 400.4%» (25 624 / 6 400).
 *
 * Фикс: запись только после ~500мс тишины (clearTimeout + setTimeout), при этом
 *   (а) ввод «50» за 200мс → РОВНО одна запись (не три);
 *   (б) «5» + пауза 600мс + «0» → две записи: сначала 5, затем 50;
 *   (в) пустое поле → null (по дебаунсу);
 *   (г) кнопка «Авто» (reset-limit) и change с пустым полем — мгновенно, с гашением
 *       висящего таймера (дебаунс не откладывает сброс).
 * Гейты/оракулы/тему H22 не трогаем; запись selectedModel по-прежнему мгновенная.
 */

const fs = require('fs');
const path = require('path');

const OPTIONS_JS = path.join(__dirname, '..', 'options', 'options.js');

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
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  });
  const versionEl = document.createElement('span');
  versionEl.className = 'version';
  document.body.appendChild(versionEl);
}

function createChromeMock(initialSync) {
  const syncSets = [];
  return {
    chrome: {
      runtime: {
        getManifest: function () { return { version: '1.15.2' }; },
        getURL: function () { return 'print.html'; },
        lastError: null,
        sendMessage: function () { }
      },
      storage: {
        sync: {
          get: function (keys, cb) { cb(Object.assign({}, initialSync || {})); },
          set: function (obj) { syncSets.push(Object.assign({}, obj)); }
        },
        local: {
          get: function (keys, cb) { cb({}); },
          set: function () { },
          remove: function () { }
        },
        session: {
          get: function () { return Promise.resolve({}); },
          set: function () { return Promise.resolve(); },
          remove: function () { return Promise.resolve(); }
        },
        onChanged: { addListener: function () { } }
      },
      tabs: {
        query: function (q, cb) { cb([]); },
        create: function () { },
        sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
      }
    },
    syncSets: syncSets
  };
}

function limitWrites(m) {
  return m.syncSets.filter(function (o) { return Object.prototype.hasOwnProperty.call(o, 'customLimit'); });
}

describe('H20: статический пин дебаунса в options.js', () => {
  const src = fs.readFileSync(OPTIONS_JS, 'utf8');

  test('константа 500мс, clearTimeout + setTimeout, литерал записи сохранён', () => {
    expect(src).toContain('var CUSTOM_LIMIT_DEBOUNCE_MS = 500;');
    expect(src).toContain('clearTimeout(customLimitWriteTimer);');
    expect(src).toContain('customLimitWriteTimer = setTimeout(function () {');
    expect(src).toContain('chrome.storage.sync.set({ customLimit: value });');
  });

  test('сброс «Авто» и change с пустым полем гасят таймер (мгновенная запись null)', () => {
    expect(src).toContain('aiCmCancelCustomLimitWrite(); // H20: гасим висящий дебаунс — сброс мгновенный');
    expect(src).toContain('aiCmCancelCustomLimitWrite(); // H20: пустое поле — мгновенный null, без дебаунса');
    // дебаунс стоит ТОЛЬКО на input-обработчике поля лимита
    expect(src).toContain("customLimit && customLimit.addEventListener('input', function () {");
    expect(src).toContain('chrome.storage.sync.set({ selectedModel: modelSelect.value });');
  });
});

describe('H20: jsdom — ввод в поле лимита → дебаунс 500мс', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    document.body.innerHTML = '';
    setupDom();
    window.AiCmExportBuilders = require('../utils/export-text-builders.js');
    window.buildReferenceText = require('../utils/buildReferenceText.js');
  });

  afterEach(() => {
    delete global.chrome;
    jest.useRealTimers();
  });

  function mount(initialSync) {
    const m = createChromeMock(initialSync);
    global.chrome = m.chrome;
    require('../options/options.js');
    return { m: m, el: document.getElementById('custom-limit') };
  }

  function type(el, value) {
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  test('ввод «50» за 200мс → РОВНО одна запись в sync (не три)', () => {
    const h = mount({});
    type(h.el, '5');                       // keystroke 1
    jest.advanceTimersByTime(100);
    type(h.el, '50');                      // keystroke 2
    jest.advanceTimersByTime(100);
    type(h.el, '50');                      // keystroke 3 (значение то же)
    expect(limitWrites(h.m)).toHaveLength(0);   // ни одной записи до паузы
    jest.advanceTimersByTime(600);
    const writes = limitWrites(h.m);
    expect(writes).toHaveLength(1);             // ровно одна, а не три
    expect(writes[0].customLimit).toBe(50);
    // «5» (400.4% от 6 400) в sync НЕ попало вовсе
    expect(writes.some(function (w) { return w.customLimit === 5; })).toBe(false);
  });

  test('«5» + пауза 600мс + «0» → две записи: сначала 5, затем 50', () => {
    const h = mount({});
    type(h.el, '5');
    jest.advanceTimersByTime(600);
    expect(limitWrites(h.m).map(function (w) { return w.customLimit; })).toEqual([5]);
    type(h.el, '50');
    jest.advanceTimersByTime(600);
    expect(limitWrites(h.m).map(function (w) { return w.customLimit; })).toEqual([5, 50]);
  });

  test('пустое поле → null (по дебаунсу, не мгновенно)', () => {
    const h = mount({ customLimit: 50 });
    type(h.el, '');
    expect(limitWrites(h.m)).toHaveLength(0);
    jest.advanceTimersByTime(600);
    expect(limitWrites(h.m)).toHaveLength(1);
    expect(limitWrites(h.m)[0].customLimit).toBeNull();
  });

  test('кнопка «Авто» — мгновенный null без дебаунса, висящий таймер погашен', () => {
    const h = mount({ customLimit: 50 });
    type(h.el, '5');                                  // взводим дебаунс
    document.getElementById('reset-limit').dispatchEvent(new window.Event('click', { bubbles: true }));
    const writes = limitWrites(h.m);
    expect(writes).toHaveLength(1);                   // мгновенно, без advanceTimers
    expect(writes[0].customLimit).toBeNull();
    expect(String(h.el.value)).toBe('');
    expect(h.el.placeholder).toBe('Авто');
    jest.advanceTimersByTime(2000);
    expect(limitWrites(h.m)).toHaveLength(1);         // отложенная «5» не прилетела
  });

  test('change с пустым полем → мгновенный null + гашение таймера', () => {
    const h = mount({});
    type(h.el, '5');
    h.el.value = '';
    h.el.dispatchEvent(new window.Event('change', { bubbles: true }));
    const writes = limitWrites(h.m);
    expect(writes).toHaveLength(1);
    expect(writes[0].customLimit).toBeNull();
    jest.advanceTimersByTime(2000);
    expect(limitWrites(h.m)).toHaveLength(1);
  });

  test('дебаунс не задевает другие поля: selectedModel пишется мгновенно', () => {
    const h = mount({});
    const sel = document.getElementById('model-select');
    sel.value = 'gemini-1.5-pro';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(h.m.syncSets).toHaveLength(1);
    expect(h.m.syncSets[0].selectedModel).toBe('gemini-1.5-pro');
  });

  test('только одно уведомление-триггера: последнее значение = финальный лимит (50)', () => {
    const h = mount({});
    '50'.split('').forEach(function (ch, i) {
      type(h.el, '50'.slice(0, i + 1));
      jest.advanceTimersByTime(50);
    });
    jest.advanceTimersByTime(600);
    const writes = limitWrites(h.m);
    expect(writes).toHaveLength(1);
    expect(writes[0].customLimit).toBe(50);
  });
});
