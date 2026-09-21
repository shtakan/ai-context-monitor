/**
 * R-1 (v1.19): версионная гигиена перед упаковкой.
 *
 * Пины source-level (стиль manifest-smoke.test.js / docs-hygiene.test.js) — только чтение:
 *  1) manifest.version === версия ВЕРХНЕЙ записи CHANGELOG.md (парсинг реального файла,
 *     формат Keep a Changelog: «## [x.y.z] - YYYY-MM-DD»); версия — строго литерал 2.0.8,
 *     чтобы пин не «съезжал» молча вслед за манифестом;
 *  2) package.json === package-lock.json (root + packages[""]) === manifest.json;
 *  3) все места вывода версии согласованы с манифестом: футер docs/index.html,
 *     tools/edge-listing-metadata.txt (и никакого хардкода прежних версий в них);
 *  4) jsdom-пин: реальный options/options.js при загрузке рендерит футер «v<версия>»,
 *     взятую из chrome.runtime.getManifest() (сентинел, отличный от версии манифеста, —
 *     хардкод в коде футера такой пин провалит).
 *
 * Код расширения, локали, экспорт и workflow не изменяются — здесь только чтение.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const changelog = read('CHANGELOG.md');
const docsHtml = read('docs/index.html');
const optionsJs = read('options/options.js');
const optionsHtml = read('options/options.html');

// CI-хотфикс (релиз 1.19.x): tools/ — gitignored-артефакт (см. .gitignore), в чистом чекауте
// его нет. Пин версии листинга тогда уходит в ЯВНЫЙ skip с причиной в выводе; все прочие
// проверки файла (манифест/CHANGELOG/пакеты/docs/options.js) остаются строгими.
const LISTING_PATH = path.join(ROOT, 'tools', 'edge-listing-metadata.txt');
const HAS_LISTING = fs.existsSync(LISTING_PATH);
const listing = HAS_LISTING ? fs.readFileSync(LISTING_PATH, 'utf8') : '';

if (!HAS_LISTING) {
  console.log('[version-hygiene] SKIP: tools/edge-listing-metadata.txt отсутствует ' +
    '(gitignored, чистый чекаут) — пин версии листинга Edge пропущен');
}

const HEADING_RE = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
const headingOf = function (line) {
  const m = HEADING_RE.exec(line);
  return m ? { raw: line, version: m[1], date: m[2] } : null;
};
const topEntry = headingOf(changelog.split(/\r?\n/).find(function (l) { return l.indexOf('## [') === 0; }));

// Сентинел для jsdom-пина: заведомо не равен ни одной релизной версии проекта.
const SENTINEL_VERSION = '9.9.9-probe';

/* =====================================================================================
 * 1. manifest.json === верхняя запись CHANGELOG.md
 * ===================================================================================== */

describe('R-1: manifest.version синхронизирован с верхней записью CHANGELOG.md', () => {
  test('верхняя запись CHANGELOG парсится и имеет формат Keep a Changelog', () => {
    expect(topEntry).not.toBeNull();
    expect(topEntry.raw).toBe('## [' + topEntry.version + '] - ' + topEntry.date);
  });

  test('manifest.version === версия верхней записи CHANGELOG.md', () => {
    expect(manifest.version).toBe(topEntry.version);
  });

  test('manifest.version === 2.0.11 (литерал: пин не следует за манифестом молча)', () => {
    expect(manifest.version).toBe('2.0.11');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(topEntry.version).toBe('2.0.11');
    expect(topEntry.date).toBe('2026-09-21');
  });

  test('версия монотонна: старшая компонента не ниже прежней (1.18.0)', () => {
    const parts = manifest.version.split('.').map(Number);
    const previous = [1, 18, 0];
    expect(parts.length).toBe(3);
    parts.forEach(function (p) { expect(Number.isInteger(p)).toBe(true); });
    const greater = parts[0] > previous[0] ||
      (parts[0] === previous[0] && (parts[1] > previous[1] ||
      (parts[1] === previous[1] && parts[2] >= previous[2])));
    expect(greater).toBe(true);
  });

  test('CHANGELOG: прежние записи не переписаны; новая 2.0.11 стоит выше 2.0.9, а та — выше 2.0.8, а та — выше 2.0.7, а та — выше 2.0.6, а та — выше 2.0.5, а та — выше 2.0.4, а та — выше 2.0.3, а та — выше 2.0.2, а та — выше 2.0.1, а та — выше 2.0.0, а та — выше 1.19.3 (M-14)', () => {
    const headings = changelog.split(/\r?\n/).filter(function (l) { return l.indexOf('## [') === 0; });
    expect(headings.filter(function (h) { return h.indexOf('## [1.19.3] - 2026-09-13') === 0; }).length).toBe(1);
    expect(headings.filter(function (h) { return h.indexOf('## [1.19.2] - 2026-09-13') === 0; }).length).toBe(1);
    expect(headings.filter(function (h) { return h.indexOf('## [1.19.1] - 2026-09-13') === 0; }).length).toBe(1);
    expect(headings.filter(function (h) { return h.indexOf('## [1.18.0] - 2026-09-12') === 0; }).length).toBe(1);
    const iNew = headings.findIndex(function (h) { return h.indexOf('## [2.0.11]') === 0; });
    const iV209 = headings.findIndex(function (h) { return h.indexOf('## [2.0.9]') === 0; });
    const iV208 = headings.findIndex(function (h) { return h.indexOf('## [2.0.8]') === 0; });
    const iV207 = headings.findIndex(function (h) { return h.indexOf('## [2.0.7]') === 0; });
    const iV206 = headings.findIndex(function (h) { return h.indexOf('## [2.0.6]') === 0; });
    const iV205 = headings.findIndex(function (h) { return h.indexOf('## [2.0.5]') === 0; });
    const iV204 = headings.findIndex(function (h) { return h.indexOf('## [2.0.4]') === 0; });
    const iV203 = headings.findIndex(function (h) { return h.indexOf('## [2.0.3]') === 0; });
    const iV202 = headings.findIndex(function (h) { return h.indexOf('## [2.0.2]') === 0; });
    const iV201 = headings.findIndex(function (h) { return h.indexOf('## [2.0.1]') === 0; });
    const iV200 = headings.findIndex(function (h) { return h.indexOf('## [2.0.0]') === 0; });
    const iM14 = headings.findIndex(function (h) { return h.indexOf('## [1.19.3]') === 0; });
    const iM12 = headings.findIndex(function (h) { return h.indexOf('## [1.19.2]') === 0; });
    const iPrev = headings.findIndex(function (h) { return h.indexOf('## [1.19.1]') === 0; });
    expect(iNew).toBeGreaterThanOrEqual(0);                  // запись v2.0.11 на месте
    expect(iNew).toBeLessThan(iV209);                        // 2.0.11 выше 2.0.9
    expect(iV209).toBeLessThan(iV208);                       // 2.0.9 выше 2.0.8
    expect(iV208).toBeLessThan(iV207);                       // 2.0.8 выше 2.0.7
    expect(iV207).toBeLessThan(iV206);                       // 2.0.7 выше 2.0.6
    expect(iV206).toBeLessThan(iV205);                       // 2.0.6 выше 2.0.5
    expect(iV205).toBeLessThan(iV204);                       // 2.0.5 выше 2.0.4
    expect(iV204).toBeLessThan(iV203);                       // 2.0.4 выше 2.0.3
    expect(iV203).toBeLessThan(iV202);                       // 2.0.3 выше 2.0.2
    expect(iV202).toBeLessThan(iV201);                       // 2.0.2 выше 2.0.1
    expect(iV201).toBeLessThan(iV200);                       // 2.0.1 выше 2.0.0
    expect(iV200).toBeLessThan(iM14);                        // 2.0.0 выше 1.19.3
    expect(iM14).toBeLessThan(iM12);                         // запись M-14 не переписана
    expect(iM12).toBeLessThan(iPrev);                        // прежний порядок не переписан
    expect(changelog).toContain('M-14');                     // запись называет свой шаг
    expect(changelog).toContain('with_parent_info');         // и существо фикса (полный набор параметров)
  });
});

describe('R-1: package.json и package-lock.json — та же версия, что в манифесте', () => {
  test('package.json === manifest.json', () => {
    expect(pkg.version).toBe(manifest.version);
  });

  test('package-lock.json: корень и packages[""] совпадают с манифестом', () => {
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[''].version).toBe(manifest.version);
  });

  test('прежние версии 2.0.8, 2.0.7, 2.0.6, 2.0.5, 2.0.4, 2.0.3, 2.0.2, 2.0.1, 2.0.0, 1.19.3, 1.19.2, 1.19.1 и 1.18.0 в манифесте/пакете/локе не остались', () => {
    [manifest, pkg, lock].forEach(function (doc) {
      expect(JSON.stringify(doc)).not.toContain('1.18.0');
      expect(JSON.stringify(doc)).not.toContain('1.19.1');
      expect(JSON.stringify(doc)).not.toContain('1.19.2');
      expect(JSON.stringify(doc)).not.toContain('1.19.3');
    });
    // 2.0.0/2.0.1/2.0.2/2.0.3/2.0.4/2.0.5/2.0.6/2.0.7 нельзя искать по всему локу: это версии транзитивных зависимостей
    // (convert-source-map, isexe, merge-stream, @tootallnate/once, is-stream и др.) —
    // пин только по корневым полям.
    [manifest, pkg].forEach(function (doc) {
      expect(JSON.stringify(doc)).not.toContain('2.0.0');
      // граница версии: «2.0.11» не должно ловиться как «2.0.1» (префиксная коллизия)
      expect(JSON.stringify(doc)).not.toMatch(/2\.0\.1(?!\d)/);
      expect(JSON.stringify(doc)).not.toContain('2.0.2');
      expect(JSON.stringify(doc)).not.toContain('2.0.3');
      expect(JSON.stringify(doc)).not.toContain('2.0.4');
      expect(JSON.stringify(doc)).not.toContain('2.0.5');
      expect(JSON.stringify(doc)).not.toContain('2.0.6');
      expect(JSON.stringify(doc)).not.toContain('2.0.7');
      expect(JSON.stringify(doc)).not.toContain('2.0.8');
    });
    expect(lock.version).not.toBe('2.0.0');
    expect(lock.packages[''].version).not.toBe('2.0.0');
    expect(lock.version).not.toBe('2.0.1');
    expect(lock.packages[''].version).not.toBe('2.0.1');
    expect(lock.version).not.toBe('2.0.2');
    expect(lock.packages[''].version).not.toBe('2.0.2');
    expect(lock.version).not.toBe('2.0.3');
    expect(lock.packages[''].version).not.toBe('2.0.3');
    expect(lock.version).not.toBe('2.0.4');
    expect(lock.packages[''].version).not.toBe('2.0.4');
    expect(lock.version).not.toBe('2.0.5');
    expect(lock.packages[''].version).not.toBe('2.0.5');
    expect(lock.version).not.toBe('2.0.6');
    expect(lock.packages[''].version).not.toBe('2.0.6');
    expect(lock.version).not.toBe('2.0.7');
    expect(lock.packages[''].version).not.toBe('2.0.7');
    expect(lock.version).not.toBe('2.0.8');
    expect(lock.packages[''].version).not.toBe('2.0.8');
  });
});

/* =====================================================================================
 * 2. Единый источник версии: манифест, а не хардкод
 * ===================================================================================== */

describe('R-1: единый источник версии — chrome.runtime.getManifest().version', () => {
  // Пин листинга требует gitignored-артефакт tools/: без него — явный skip (см. шапку файла).
  const testListing = HAS_LISTING ? test : test.skip;

  test('options.js берёт версию из манифеста (без хардкода версии)', () => {
    expect(optionsJs).toContain('chrome.runtime.getManifest()');
    expect(optionsJs).toContain("versionEl.textContent = 'v' + manifest.version");
    expect(optionsJs).not.toMatch(/versionEl\.textContent\s*=\s*['"]\d/);  // футер не хардкодит версию-число
    expect(optionsHtml).toContain('<span class="version"></span>');        // футер пуст в разметке
    expect(optionsHtml).not.toMatch(/class="version"[^<]*\d+\.\d+\.\d+/);  // версии в разметке нет
  });

  test('футер docs/index.html показывает версию манифеста (не прежнюю и не 1.0.0)', () => {
    expect(docsHtml).toContain('Версия</span> ' + manifest.version);
    expect(docsHtml).not.toContain('Версия</span> 1.0.0');
    expect(docsHtml).not.toContain('Версия</span> 2.0.8');
    expect(docsHtml).not.toContain('Версия</span> 2.0.7');
    expect(docsHtml).not.toContain('Версия</span> 2.0.6');
    expect(docsHtml).not.toContain('Версия</span> 2.0.5');
    expect(docsHtml).not.toContain('Версия</span> 2.0.4');
    expect(docsHtml).not.toContain('Версия</span> 2.0.3');
    expect(docsHtml).not.toContain('Версия</span> 2.0.2');
    // граница версии: «Версия</span> 2.0.11» не должно ловиться как «2.0.1»
    expect(docsHtml).not.toMatch(/Версия<\/span> 2\.0\.1(?!\d)/);
    expect(docsHtml).not.toContain('Версия</span> 1.19.3');
    expect(docsHtml).not.toContain('Версия</span> 1.19.2');
    expect(docsHtml).not.toContain('Версия</span> 1.19.1');
    expect(docsHtml).not.toContain('Версия</span> 1.18.0');
  });

  testListing('метаданные листинга Edge: версия совпадает с манифестом', () => {
    expect(listing).toContain('Версия расширения: ' + manifest.version + ' (manifest.json)');
    expect(listing).not.toContain('Версия расширения: 2.0.8');
    expect(listing).not.toContain('Версия расширения: 2.0.7');
    expect(listing).not.toContain('Версия расширения: 2.0.6');
    expect(listing).not.toContain('Версия расширения: 2.0.5');
    expect(listing).not.toContain('Версия расширения: 2.0.4');
    expect(listing).not.toContain('Версия расширения: 2.0.3');
    expect(listing).not.toContain('Версия расширения: 2.0.2');
    // граница версии: «Версия расширения: 2.0.11» не должно ловиться как «2.0.1»
    expect(listing).not.toMatch(/Версия расширения: 2\.0\.1(?!\d)/);
    expect(listing).not.toContain('Версия расширения: 1.19.3');
    expect(listing).not.toContain('Версия расширения: 1.19.2');
    expect(listing).not.toContain('Версия расширения: 1.19.1');
    expect(listing).not.toContain('Версия расширения: 1.18.0');
  });

  if (!HAS_LISTING) {
    // Явная запись пропуска в выводе: «зелёный» не должен читаться как «проверено».
    test.skip('tools/edge-listing-metadata.txt отсутствует в чистом чекауте ' +
      '(.gitignore: tools/) — пин версии листинга Edge пропущен, а не пройден', () => {});
  }

  test('числовые литералы версии остаются только в комментариях (не в исполняемом коде)', () => {
    // static HTML (docs/index.html) обязан нести версию текстом и пиноваться выше;
    // исполняемый код версию не хардкодит — единственный источник chrome.runtime.getManifest().
    const literals = optionsJs.split(/\r?\n/).filter(function (line) {
      return /\d+\.\d+\.\d+/.test(line) && line.trim().indexOf('//') !== 0;
    });
    expect(literals).toEqual([]);
    expect(docsHtml).toContain(manifest.version);
  });
});

/* =====================================================================================
 * 3. jsdom-пин: реальный options.js рендерит версию из chrome.runtime.getManifest()
 * ===================================================================================== */

describe('R-1: футер options рендерит версию из манифеста (jsdom, реальный options.js)', () => {
  // Минимальный DOM — тот же набор, что в options-thresholds.test.js / options-stale-home.test.js.
  const OPTIONS_IDS = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent', 'stat-source',
    'model-select', 'custom-limit', 'show-widget', 'toggle-api-key',
    'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag', 'reset-limit',
    'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
    'aiCmProactive', 'aiCmProactiveNotify',
    'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh',
    'api-key-status', 'api-key-remove'
  ];

  function setupDom() {
    document.body.innerHTML = '';
    OPTIONS_IDS.forEach(function (id) {
      const isNumber = id === 'aiCmProactiveLow' || id === 'aiCmProactiveMedium' || id === 'aiCmProactiveHigh';
      const el = isNumber ? document.createElement('input') : document.createElement('div');
      el.id = id;
      if (isNumber) { el.type = 'number'; }
      document.body.appendChild(el);
    });
    const keyInput = document.createElement('input');
    keyInput.id = 'api-key';
    keyInput.type = 'password';
    document.body.appendChild(keyInput);
    // Реальный футер разметки: пустой span.version, который заполняет options.js.
    const versionEl = document.createElement('span');
    versionEl.className = 'version';
    document.body.appendChild(versionEl);
  }

  /** chrome-мок с ПОДКОНТРОЛЬНОЙ версией манифеста (сентинел — не релизная версия). */
  function chromeMock(version) {
    return {
      runtime: {
        getManifest: function () { return { version: version }; },
        getURL: function () { return 'print.html'; },
        lastError: null,
        sendMessage: function () { }
      },
      storage: {
        sync: { get: function (keys, cb) { cb({}); }, set: function () { } },
        local: {
          get: function (keys, cb) { if (typeof cb === 'function') cb({}); },
          getKeys: function (cb) { cb([]); },
          set: function (obj, cb) { if (cb) cb(); },
          remove: function (keys, cb) { if (cb) cb(); }
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
    };
  }

  beforeEach(function () {
    jest.resetModules();                       // повторное исполнение options.js в каждом тесте
    document.body.innerHTML = '';
    setupDom();
    window.buildReferenceText = require('../utils/buildReferenceText.js');
    window.AiCmExportBuilders = require('../utils/export-text-builders.js');
  });

  afterEach(function () {
    document.body.innerHTML = '';
    delete global.chrome;
  });

  test('футер рендерит «v» + версию из chrome.runtime.getManifest() (сентинел ≠ версия манифеста)', () => {
    expect(SENTINEL_VERSION).not.toBe(manifest.version);      // пин не вакуумный
    global.chrome = chromeMock(SENTINEL_VERSION);
    require('../options/options.js');
    expect(document.querySelector('.version').textContent).toBe('v' + SENTINEL_VERSION);
  });

  test('подмена версии манифеста переносится в футер (источник — манифест, не литерал)', () => {
    const other = '7.7.7-test';
    global.chrome = chromeMock(other);
    require('../options/options.js');
    expect(document.querySelector('.version').textContent).toBe('v' + other);
    // литерала версии в коде футера нет — только 'v' + manifest.version
    expect(optionsJs).not.toContain(other);
  });

  test('в манифесте версия реальная, а не сентинел/пустое значение', () => {
    expect(manifest.version).not.toBe(SENTINEL_VERSION);
    expect(manifest.version.length).toBeGreaterThan(0);
  });
});
