/**
 * M-13 (v1.19.2): настройки автоэкспорта — целостность флага enabled.
 *
 * Дефект 13.09 17:33 (тред /search/5fe65fcb, галка автоэкспорта включена, порог 20,
 * baseComplete=true, convId непустой, сеансовый латч жив): ни одной строки модуля
 * автоэкспорта. Единственный тихий путь — `if (!s || s.enabled !== true) return;` в
 * maybeAutoExport: флаг enabled потерялся в chrome.storage после частичной записи порога
 * из попапа (~17:12), при этом попап рисовал галку включённой.
 *
 * Проверки:
 *   (а) round-trip попапа: сохранение порога/формата/галки пишет ПОЛНЫЙ объект
 *       {enabled, pct, fmt} — enabled=true не теряется (реальный options/options.js в jsdom);
 *   (б) инициализация попапа — строго из chrome.storage, без дефолтов, расходящихся
 *       с хранилищем (нет ключей → storage дозаписывается полным объектом);
 *   (в) content.js loadAutoExportSettings(): нет булева enabled → enabled=false
 *       И строка «[AI CM][auto-export] настройки: флаг enabled отсутствует — автоэкспорт выключен»;
 *   (г) реальный maybeAutoExport: enabled=true, pct ниже порога, cid непустой →
 *       строка skip reason=below-threshold (файла нет, латч не ставится);
 *   (д) аудит: единственная запись ключей настроек — options.js, и она полная.
 *
 * «НЕ трогать»: гейты shouldSkipAutoExport, латчи, GSA threadId-путь, gemini-путь,
 * имена файлов экспорта, ветка perplexity /search/<id> (M-11).
 */
const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const buildReferenceText = require('../utils/buildReferenceText.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = require('./helpers/content-source.js').contentSource;
const OPTIONS_JS = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');

// Рез по балансу фигурных скобок (стиль tests/gsa-autoexport.test.js).
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

// =====================================================================================
// (а)/(б): реальный options/options.js в jsdom — полная запись и инициализация из storage
// =====================================================================================
describe('M-13 (а)/(б): options.js — полный объект настроек автоэкспорта', () => {
  const DOM_IDS = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent', 'stat-source',
    'model-select', 'custom-limit', 'show-widget', 'api-key', 'toggle-api-key',
    'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag', 'reset-limit', 'privacy-link', 'help-link',
    'aiCmProactive', 'aiCmProactiveNotify',
    'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh'
  ];

  function setupDom() {
    document.body.innerHTML = '';
    DOM_IDS.forEach(function (id) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    });
    // Реальные контролы автоэкспорта: чекбокс, порог, формат (как в options.html)
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'aiCmAutoExport';
    document.body.appendChild(cb);

    const pct = document.createElement('input');
    pct.type = 'number';
    pct.id = 'aiCmAutoExportPct';
    document.body.appendChild(pct);

    const fmt = document.createElement('select');
    fmt.id = 'aiCmAutoExportFmt';
    ['txt', 'md', 'json'].forEach(function (v) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      fmt.appendChild(opt);
    });
    document.body.appendChild(fmt);

    const versionEl = document.createElement('span');
    versionEl.className = 'version';
    document.body.appendChild(versionEl);
  }

  function createChromeMock(initialLocal) {
    const store = Object.assign({}, initialLocal || {});
    const localSets = [];
    return {
      chrome: {
        runtime: {
          getManifest: function () { return { version: '1.19.2' }; },
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
          onChanged: { addListener: function () { } }
        },
        tabs: {
          query: function (q, cb) { cb([]); },
          create: function () { },
          sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
        }
      },
      store: store,
      localSets: localSets
    };
  }

  const AUTO_KEYS = ['aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt'];
  const autoWrites = (m) => m.localSets.filter(function (o) {
    return AUTO_KEYS.some(function (k) { return k in o; });
  });
  const fireChange = function (id) {
    const el = document.getElementById(id);
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  beforeEach(() => {
    jest.resetModules();
    setupDom();
    window.buildReferenceText = buildReferenceText;
    window.AiCmExportBuilders = Builders;
  });

  afterEach(() => { delete global.chrome; });

  test('(а) сохранение порога из попапа сохраняет enabled=true (сценарий дефекта 17:12)', () => {
    const m = createChromeMock({ aiCmAutoExport: true, aiCmAutoExportPct: 20, aiCmAutoExportFmt: 'md' });
    global.chrome = m.chrome;
    require('../options/options.js');

    // форма инициализирована из storage: галка видна включённой, как было в дефекте
    expect(document.getElementById('aiCmAutoExport').checked).toBe(true);
    expect(String(document.getElementById('aiCmAutoExportPct').value)).toBe('20');
    expect(document.getElementById('aiCmAutoExportFmt').value).toBe('md');

    // пользователь меняет порог 20 → 30 в попапе
    const pctEl = document.getElementById('aiCmAutoExportPct');
    pctEl.value = '30';
    fireChange('aiCmAutoExportPct');

    const last = autoWrites(m).pop();
    expect(last).toEqual({ aiCmAutoExport: true, aiCmAutoExportPct: 30, aiCmAutoExportFmt: 'md' });
    // флаг в хранилище жив: content.js прочитает enabled=true (M-13c)
    expect(m.store.aiCmAutoExport).toBe(true);
    expect(m.store.aiCmAutoExportPct).toBe(30);
  });

  test('(а) смена формата и снятие галки тоже пишут полный объект — ни одно поле не теряется', () => {
    const m = createChromeMock({ aiCmAutoExport: true, aiCmAutoExportPct: 20, aiCmAutoExportFmt: 'txt' });
    global.chrome = m.chrome;
    require('../options/options.js');

    const fmtEl = document.getElementById('aiCmAutoExportFmt');
    fmtEl.value = 'json';
    fireChange('aiCmAutoExportFmt');
    expect(autoWrites(m).pop()).toEqual({ aiCmAutoExport: true, aiCmAutoExportPct: 20, aiCmAutoExportFmt: 'json' });

    const cb = document.getElementById('aiCmAutoExport');
    cb.checked = false;
    fireChange('aiCmAutoExport');
    expect(autoWrites(m).pop()).toEqual({ aiCmAutoExport: false, aiCmAutoExportPct: 20, aiCmAutoExportFmt: 'json' });
  });

  test('(а) частичной записи нет: КАЖДАЯ запись настроек содержит все три ключа', () => {
    const m = createChromeMock({ aiCmAutoExport: true, aiCmAutoExportPct: 20, aiCmAutoExportFmt: 'txt' });
    global.chrome = m.chrome;
    require('../options/options.js');

    const pctEl = document.getElementById('aiCmAutoExportPct');
    pctEl.value = '55';
    fireChange('aiCmAutoExportPct');
    const fmtEl = document.getElementById('aiCmAutoExportFmt');
    fmtEl.value = 'md';
    fireChange('aiCmAutoExportFmt');
    fireChange('aiCmAutoExport');

    const writes = autoWrites(m);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    writes.forEach(function (w) {
      expect(Object.keys(w).sort()).toEqual(AUTO_KEYS.slice().sort());
      expect(typeof w.aiCmAutoExport).toBe('boolean');
    });
  });

  test('(б) полный валидный storage → форма = storage, лишней записи при открытии нет', () => {
    const m = createChromeMock({ aiCmAutoExport: true, aiCmAutoExportPct: 42, aiCmAutoExportFmt: 'json' });
    global.chrome = m.chrome;
    require('../options/options.js');

    expect(document.getElementById('aiCmAutoExport').checked).toBe(true);
    expect(String(document.getElementById('aiCmAutoExportPct').value)).toBe('42');
    expect(document.getElementById('aiCmAutoExportFmt').value).toBe('json');
    expect(autoWrites(m)).toEqual([]); // storage уже согласован с формой — писать нечего
  });

  test('(б) storage без ключей → форма нормализована И storage дозаписан полным объектом', () => {
    const m = createChromeMock({});
    global.chrome = m.chrome;
    require('../options/options.js');

    expect(document.getElementById('aiCmAutoExport').checked).toBe(false);
    expect(String(document.getElementById('aiCmAutoExportPct').value)).toBe('90');
    expect(document.getElementById('aiCmAutoExportFmt').value).toBe('txt');
    // расхождения формы и хранилища нет: записан ПОЛНЫЙ объект, а не «ничего»
    expect(autoWrites(m)).toEqual([{ aiCmAutoExport: false, aiCmAutoExportPct: 90, aiCmAutoExportFmt: 'txt' }]);
    expect(m.store.aiCmAutoExport).toBe(false);
    expect(m.store.aiCmAutoExportPct).toBe(90);
    expect(m.store.aiCmAutoExportFmt).toBe('txt');
  });

  test('(б) битый storage (pct=999, fmt=zzz, enabled=строка) → нормализация в форме и в storage', () => {
    const m = createChromeMock({ aiCmAutoExport: 'нет', aiCmAutoExportPct: 999, aiCmAutoExportFmt: 'zzz' });
    global.chrome = m.chrome;
    require('../options/options.js');

    expect(document.getElementById('aiCmAutoExport').checked).toBe(false); // строка ≠ true
    expect(String(document.getElementById('aiCmAutoExportPct').value)).toBe('100');
    expect(document.getElementById('aiCmAutoExportFmt').value).toBe('txt');
    expect(autoWrites(m).pop()).toEqual({ aiCmAutoExport: false, aiCmAutoExportPct: 100, aiCmAutoExportFmt: 'txt' });
  });
});

// =====================================================================================
// (в): content.js loadAutoExportSettings — нормализация флага + обязательная строка лога
// =====================================================================================
describe('M-13 (в): content.js — нет булева enabled → enabled=false + строка (тишины нет)', () => {
  const SCOPE = 'with (ctx) { ' + fnDecl(CONTENT, 'loadAutoExportSettings') + '\n return { run: loadAutoExportSettings }; }';
  const makeRun = new Function('ctx', SCOPE);

  function settingsCtx(stored, over) {
    const logs = [];
    const ctx = {
      // стартовое «включено»: нормализация обязана его сбросить, а не оставить как есть
      autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' },
      aiCmAutoExportFlagMissingLogged: false,
      isExtensionValid: function () { return true; },
      chrome: {
        storage: {
          local: {
            get: function (keys, cb) {
              const out = {};
              (keys || []).forEach(function (k) { out[k] = stored[k]; });
              cb(out);
            }
          },
          onChanged: { addListener: function () { } }
        }
      },
      console: {
        log: function (msg) { logs.push(String(msg)); },
        error: function () { }
      },
      debugLog: function () { }
    };
    Object.assign(ctx, over || {});
    return { ctx: ctx, logs: logs, run: makeRun(ctx).run };
  }

  test('флага нет вовсе → enabled=false + точная строка лога', () => {
    const h = settingsCtx({ aiCmAutoExportPct: 20, aiCmAutoExportFmt: 'txt' });
    h.run();
    expect(h.ctx.autoExportSettings.enabled).toBe(false);
    expect(h.ctx.autoExportSettings.pct).toBe(20);
    expect(h.logs).toContain('[AI CM][auto-export] настройки: флаг enabled отсутствует — автоэкспорт выключен');
  });

  test('флаг не булев (строка/число/null) → тоже enabled=false + строка', () => {
    ['true', 1, null].forEach(function (bad) {
      const h = settingsCtx({ aiCmAutoExport: bad, aiCmAutoExportPct: 20 });
      h.run();
      expect(h.ctx.autoExportSettings.enabled).toBe(false);
      expect(h.logs.length).toBe(1);
    });
  });

  test('enabled=true из storage → enabled=true, строки про отсутствие флага нет', () => {
    const h = settingsCtx({ aiCmAutoExport: true, aiCmAutoExportPct: 20, aiCmAutoExportFmt: 'md' });
    h.run();
    expect(h.ctx.autoExportSettings.enabled).toBe(true);
    expect(h.ctx.autoExportSettings.pct).toBe(20);
    expect(h.ctx.autoExportSettings.fmt).toBe('md');
    expect(h.logs).toEqual([]);
  });

  test('enabled=false из storage → enabled=false без строки (это не потеря флага)', () => {
    const h = settingsCtx({ aiCmAutoExport: false, aiCmAutoExportPct: 20 });
    h.run();
    expect(h.ctx.autoExportSettings.enabled).toBe(false);
    expect(h.logs).toEqual([]);
  });

  test('антиспам: повторные загрузки без флага дают одну строку; после возврата флага — снова видно', () => {
    const h = settingsCtx({ aiCmAutoExportPct: 20 });
    h.run();
    h.run();
    h.run();
    expect(h.logs.length).toBe(1);
    // флаг вернулся (попап записал полный объект) → следующий эпизод снова логируется
    h.ctx.autoExportSettings.enabled = true;
    let stored = { aiCmAutoExport: true, aiCmAutoExportPct: 20 };
    h.ctx.chrome.storage.local.get = function (keys, cb) {
      const out = {};
      (keys || []).forEach(function (k) { out[k] = stored[k]; });
      cb(out);
    };
    h.run();
    expect(h.ctx.autoExportSettings.enabled).toBe(true);
    stored = { aiCmAutoExportPct: 20 };
    h.run();
    expect(h.ctx.autoExportSettings.enabled).toBe(false);
    expect(h.logs.length).toBe(2);
  });

  test('source-пины: проверка типа + строка + полное чтение pct/fmt не изменены', () => {
    const fn = fnDecl(CONTENT, 'loadAutoExportSettings');
    expect(fn).toContain("if (typeof data.aiCmAutoExport !== 'boolean') {");
    expect(fn).toContain("console.log('[AI CM][auto-export] настройки: флаг enabled отсутствует — автоэкспорт выключен');");
    expect(CONTENT).toContain("autoExportSettings.fmt = (fmtRaw === 'md' || fmtRaw === 'json') ? fmtRaw : 'txt';");
    expect(CONTENT).toContain("autoExportSettings.pct = (!isNaN(p) && p >= 1 && p <= 100) ? p : 90;");
  });
});

// =====================================================================================
// (г): реальный maybeAutoExport — ниже порога при включённом флаге и непустом cid
// =====================================================================================
describe('M-13 (г): maybeAutoExport — порог 20, факт ниже, cid непустой → skip reason=below-threshold', () => {
  const CID = 'perplexity-conv-5fe65fcb';
  const SCOPE = 'with (ctx) { ' +
    fnDecl(CONTENT, 'aiCmAutoExportConvId') + '\n' +
    fnDecl(CONTENT, 'maybeAutoExport') + '\n' +
    ' return { run: maybeAutoExport }; }';
  const makeRun = new Function('ctx', SCOPE);

  function gateCtx(over) {
    const logs = [];
    const fired = [];
    const ctx = {
      autoExportSettings: { enabled: true, pct: 20, fmt: 'txt' },
      autoExportLastConvId: '',
      autoExportPctBySite: {},
      autoExportFired: {},
      autoExportLastPct: -1,
      notCompleteLogged: {},
      sessionFiredCache: {},
      aiCmLoaderRunningByConv: {},
      aiCmCursorLiveByConv: {},
      aiCmArchiveCountFor: function () { return 0; },
      baseSeen: true,
      baseComplete: true,
      baseCount: 4,
      lastThreadId: '',
      currentAdapter: { siteName: 'perplexity' },
      getCurrentConvId: function () { return CID; },
      lastEmitConvId: CID,
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      doAutoExportDownload: function (cid, pct, reason) { fired.push({ cid: cid, pct: pct, reason: reason }); },
      chrome: { storage: { session: { remove: function () { }, set: function () { } } } },
      window: { AiCmExportEmitPipeline: P }
    };
    Object.assign(ctx, over || {});
    return { ctx: ctx, logs: logs, fired: fired, run: makeRun(ctx).run };
  }

  test('enabled=true, pct 12 < порога 20, cid непустой → строка skip reason=below-threshold, файла нет', () => {
    const h = gateCtx({});
    h.run(12);
    expect(h.fired.length).toBe(0);
    expect(h.logs.join('\n')).toContain('[AI CM][auto-export] skip reason=below-threshold convId=' + CID + ' pct=12');
  });

  test('M-11 не тронут: порог взят из автоматического convId (/search/<id>) — cid непустой', () => {
    const h = gateCtx({});
    expect(h.run).toBeDefined();
    h.run(12);
    // причина skip названа именно из-за порога: cid вычислен (иначе был бы тихий выход до гейта)
    expect(h.logs.join('\n')).toContain('convId=' + CID);
    expect(P.extractConvIdFromUrl('/search/5fe65fcb')).toBe('5fe65fcb'); // ветка M-11 жива
  });

  test('порог достигнут при включённом флаге → файл скачивается (гейты не тронуты)', () => {
    const h = gateCtx({});
    h.run(25);
    expect(h.fired).toEqual([{ cid: CID, pct: 25, reason: 'threshold' }]);
  });

  test('enabled=false → тихий выход ДО гейта (прежняя семантика «фича выключена»)', () => {
    const h = gateCtx({ autoExportSettings: { enabled: false, pct: 20, fmt: 'txt' } });
    h.run(25);
    expect(h.fired.length).toBe(0);
    expect(h.logs).toEqual([]);
  });
});

// =====================================================================================
// (д): аудит записей ключей настроек — единственная точка и она полная
// =====================================================================================
describe('M-13 (д): аудит — кто пишет ключи настроек автоэкспорта', () => {
  test('options.js: одна функция записи, полный объект, вызовы только из трёх контролов', () => {
    expect(OPTIONS_JS).toContain('function aiCmAutoExportWriteFull() {');
    // частичных записей не осталось: ни одного storage.local.set с одним ключом настроек
    expect(OPTIONS_JS).not.toContain('chrome.storage.local.set({ aiCmAutoExport:');
    expect(OPTIONS_JS).not.toContain('chrome.storage.local.set({ aiCmAutoExportPct:');
    expect(OPTIONS_JS).not.toContain('chrome.storage.local.set({ aiCmAutoExportFmt:');
    const calls = OPTIONS_JS.match(/addEventListener\('(?:change|blur)', aiCmAutoExportWriteFull\)/g) || [];
    expect(calls.length).toBe(4); // checkbox/change, pct/change, pct/blur, fmt/change
    // M-11/F3-пин сохранён: формат нормализуется из формы
    expect(OPTIONS_JS).toContain('aiCmAutoExportFmt: normalizeAutoExportFmt(autoExportFmtSelect.value)');
  });

  test('content.js ключи настроек только читает (запись — не его дело)', () => {
    expect(CONTENT).not.toMatch(/chrome\.storage\.local\.set\(\{\s*aiCmAutoExport/);
    expect(CONTENT).toContain("chrome.storage.local.get(['aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt']");
  });

  test('«НЕ трогать»: разметка секции и гейты на месте', () => {
    expect(OPTIONS_HTML).toContain('id="aiCmAutoExport"');
    expect(OPTIONS_HTML).toContain('id="aiCmAutoExportPct"');
    expect(OPTIONS_HTML).toContain('id="aiCmAutoExportFmt"');
    expect(CONTENT).toContain('function maybeAutoExport(');
    expect(CONTENT).toContain('shouldSkipAutoExport');
    expect(CONTENT).toContain("if (!s || s.enabled !== true) return;");
    expect(CONTENT).toContain('P14.resetAutoExportFired(autoExportFired, siteD14, cidD14);');
  });
});
