/**
 * M-4 (фаза 3): i18n-фундамент — _locales ru/en + механика подстановки.
 *
 * Контур сьюта (файл только добавляется, прежние сьюты не изменяются):
 *   1) manifest.json: default_locale === 'ru', остальные ключи не тронуты;
 *   2) _locales/ru|en/messages.json — валидный JSON, паритет множеств ключей,
 *      en — реальный перевод (не копия ru: отличаются ≥90% ключей);
 *   3) статическая разметка options.html и print.html: каждый атрибут
 *      data-i18n / -placeholder / -title / -aria-label ссылается на ключ,
 *      который есть в ОБЕИХ локалях; оба файла подключают options/i18n-apply.js;
 *      мёртвых ключей в локалях нет;
 *   4) механика (jsdom, реальный options/i18n-apply.js): textContent, placeholder,
 *      title и aria-label заполняются из chrome.i18n.getMessage, а без chrome.i18n
 *      русский фолбэк разметки остаётся нетронутым;
 *   5) options/options.js: строки статуса ключа — через chrome.i18n.getMessage
 *      с русским фолбэком для окружений без chrome.i18n.
 *
 * Пины прежних сьютов (русские тексты, aria-имена, title, ссылки футера) не
 * ослабляются: разметка хранит русский текст как фолбэк, подстановка затирает
 * его только при непустом сообщении локали.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const optionsHtml = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const printHtml = fs.readFileSync(path.join(ROOT, 'print', 'print.html'), 'utf8');
const optionsJs = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const i18nApplySrc = fs.readFileSync(path.join(ROOT, 'options', 'i18n-apply.js'), 'utf8');

const ru = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'ru', 'messages.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));

// Атрибуты разметки, которыми объявляются ключи локали (механика i18n-apply.js).
const I18N_ATTRS = ['data-i18n', 'data-i18n-placeholder', 'data-i18n-title', 'data-i18n-aria-label'];

/** Значения атрибута attr во всём HTML (в порядке появления). */
function valuesOf(html, attr) {
  const re = new RegExp(attr + '="([^"]+)"', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/** Все ключи, объявленные разметкой (оба файла, все четыре атрибута). */
function declaredKeys() {
  const keys = [];
  [optionsHtml, printHtml].forEach(function (html) {
    I18N_ATTRS.forEach(function (attr) {
      valuesOf(html, attr).forEach(function (key) { keys.push(key); });
    });
  });
  return keys;
}

function message(locale, key) {
  return locale[key] && locale[key].message;
}

/* =====================================================================================
 * 1. manifest: default_locale + неприкосновенность остальных ключей
 * ===================================================================================== */

describe('M-4: manifest.json — default_locale ru', () => {
  test('default_locale === "ru"', () => {
    expect(manifest.default_locale).toBe('ru');
  });

  test('инварианты manifest не тронуты: MV3, версия, permissions, host_permissions', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe('1.18.0');
    expect(manifest.permissions).toEqual(['scripting', 'storage', 'notifications']);
    expect(manifest.host_permissions).toHaveLength(9);
    expect(manifest.background.service_worker).toBe('core/background.js');
    expect(manifest.action.default_popup).toBe('options/options.html');
  });
});

/* =====================================================================================
 * 2. _locales: структура, паритет ключей, реальный перевод en
 * ===================================================================================== */

describe('M-4: _locales/ru и _locales/en — структура и паритет', () => {
  test('оба messages.json не пусты и каждый ключ — объект с непустым message', () => {
    [['ru', ru], ['en', en]].forEach(function (pair) {
      const name = pair[0];
      const locale = pair[1];
      const keys = Object.keys(locale);
      expect([name, keys.length > 0]).toEqual([name, true]);
      keys.forEach(function (key) {
        expect([name, key, typeof locale[key].message]).toEqual([name, key, 'string']);
        expect([name, key, locale[key].message.trim().length > 0]).toEqual([name, key, true]);
        // имя ключа допустимо для chrome.i18n: [a-z0-9_], не начинается с цифры
        expect([name, key, /^[a-z][a-z0-9_]*$/.test(key)]).toEqual([name, key, true]);
      });
    });
  });

  test('множества ключей ru и en совпадают полностью (без пропусков и лишних)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  test('en — реальный перевод: значения отличаются от ru минимум в 90% ключей', () => {
    const keys = Object.keys(ru);
    const identical = keys.filter(function (key) {
      return message(ru, key) === message(en, key);
    });
    const differRatio = (keys.length - identical.length) / keys.length;
    expect(differRatio).toBeGreaterThanOrEqual(0.9);
    // идентичными остаются только непереводимые брендовые строки
    identical.forEach(function (key) {
      expect(message(ru, key)).toBe('AI Context Monitor');
    });
  });

  test('ru-значения ключей разметки покрывают статику options и print', () => {
    const keys = Object.keys(ru);
    expect(keys.filter(function (k) { return k.indexOf('options_') === 0; }).length)
      .toBeGreaterThanOrEqual(40);
    expect(keys.filter(function (k) { return k.indexOf('print_') === 0; }).length)
      .toBeGreaterThanOrEqual(3);
  });
});

/* =====================================================================================
 * 3. Разметка: покрытие ключами и подключение механики
 * ===================================================================================== */

describe('M-4: разметка options.html и print.html', () => {
  test('каждый data-i18n*-атрибут присутствует в ОБЕИХ локалях', () => {
    const keys = declaredKeys();
    expect(keys.length).toBeGreaterThan(0);
    keys.forEach(function (key) {
      expect([key, Object.prototype.hasOwnProperty.call(ru, key)]).toEqual([key, true]);
      expect([key, Object.prototype.hasOwnProperty.call(en, key)]).toEqual([key, true]);
    });
  });

  test('покрыты все четыре вида подстановки: text/placeholder/title/aria-label', () => {
    I18N_ATTRS.forEach(function (attr) {
      const total = valuesOf(optionsHtml, attr).length + valuesOf(printHtml, attr).length;
      expect([attr, total > 0]).toEqual([attr, true]);
    });
  });

  test('префиксы ключей соответствуют файлу: options_* в options, print_* в print', () => {
    I18N_ATTRS.forEach(function (attr) {
      valuesOf(optionsHtml, attr).forEach(function (key) {
        expect(key.indexOf('options_')).toBe(0);
      });
      valuesOf(printHtml, attr).forEach(function (key) {
        expect(key.indexOf('print_')).toBe(0);
      });
    });
  });

  test('нет мёртвых ключей: каждый ключ локали используется разметкой или options.js', () => {
    const used = {};
    declaredKeys().forEach(function (key) { used[key] = true; });
    Object.keys(ru).forEach(function (key) {
      // динамические строки статусов объявлены в options.js (M-4, п.4)
      if (optionsJs.indexOf("'" + key + "'") !== -1) used[key] = true;
    });
    const unused = Object.keys(ru).filter(function (key) { return used[key] !== true; });
    expect(unused).toEqual([]);
  });

  test('options.html подключает options/i18n-apply.js', () => {
    expect(optionsHtml).toContain('<script src="i18n-apply.js"></script>');
    expect(fs.existsSync(path.join(ROOT, 'options', 'i18n-apply.js'))).toBe(true);
  });

  test('print.html подключает общий ../options/i18n-apply.js', () => {
    expect(printHtml).toContain('<script src="../options/i18n-apply.js"></script>');
  });
});

/* =====================================================================================
 * 4. Механика: реальный options/i18n-apply.js в jsdom
 * ===================================================================================== */

describe('M-4: механика options/i18n-apply.js', () => {
  afterEach(function () {
    document.body.innerHTML = '';
    delete global.chrome;
  });

  function chromeMock(locale) {
    return {
      i18n: locale ? {
        getMessage: function (key) { return locale[key] ? locale[key].message : ''; }
      } : undefined
    };
  }

  function boot(mock) {
    global.chrome = mock;
    // Классический скрипт страницы: IIFE без module.exports (в new Function module нет).
    new Function(i18nApplySrc)();
    // На случай ранней стадии загрузки jsdom (иначе boot уже выполнен — идемпотентно).
    document.dispatchEvent(new Event('DOMContentLoaded'));
  }

  const MARKUP =
    '<span id="i18n-text" data-i18n="options_stat_site">Сайт:</span>' +
    '<input id="i18n-placeholder" data-i18n-placeholder="options_limit_placeholder" placeholder="Авто">' +
    '<button id="i18n-title" data-i18n-title="options_proactive_low_title" title="Низкий порог — зелёный">x</button>' +
    '<select id="i18n-aria" data-i18n-aria-label="options_autoexport_fmt_aria" aria-label="Формат файла автоэкспорта"><option>txt</option></select>' +
    '<span id="i18n-unknown" data-i18n="options_key_that_does_not_exist">Русский фолбэк</span>' +
    '<span id="i18n-plain">Без ключа</span>';

  test('заполняет textContent/placeholder/title/aria-label сообщениями локали', () => {
    document.body.innerHTML = MARKUP;
    boot(chromeMock(en));

    expect(document.getElementById('i18n-text').textContent).toBe(en.options_stat_site.message);
    expect(document.getElementById('i18n-placeholder').getAttribute('placeholder'))
      .toBe(en.options_limit_placeholder.message);
    expect(document.getElementById('i18n-title').getAttribute('title'))
      .toBe(en.options_proactive_low_title.message);
    expect(document.getElementById('i18n-aria').getAttribute('aria-label'))
      .toBe(en.options_autoexport_fmt_aria.message);
  });

  test('ru-подстановка байтово равна тексту разметки (локаль по умолчанию)', () => {
    document.body.innerHTML = MARKUP;
    boot(chromeMock(ru));
    expect(document.getElementById('i18n-text').textContent).toBe('Сайт:');
    expect(document.getElementById('i18n-placeholder').getAttribute('placeholder')).toBe('Авто');
  });

  test('неизвестный ключ и узел без ключа не трогаются; повторный вызов идемпотентен', () => {
    document.body.innerHTML = MARKUP;
    boot(chromeMock(en));
    boot(chromeMock(en));
    expect(document.getElementById('i18n-unknown').textContent).toBe('Русский фолбэк');
    expect(document.getElementById('i18n-plain').textContent).toBe('Без ключа');
    expect(document.getElementById('i18n-text').textContent).toBe(en.options_stat_site.message);
  });

  test('без chrome.i18n русский фолбэк разметки остаётся (страница не пустеет)', () => {
    document.body.innerHTML = MARKUP;
    delete global.chrome;
    new Function(i18nApplySrc)();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(document.getElementById('i18n-text').textContent).toBe('Сайт:');
    expect(document.getElementById('i18n-placeholder').getAttribute('placeholder')).toBe('Авто');
    expect(document.getElementById('i18n-title').getAttribute('title')).toBe('Низкий порог — зелёный');
    expect(document.getElementById('i18n-aria').getAttribute('aria-label')).toBe('Формат файла автоэкспорта');
  });
});

/* =====================================================================================
 * 5. options.js: строки статуса ключа через chrome.i18n
 * ===================================================================================== */

describe('M-4: options.js — статус ключа через chrome.i18n.getMessage', () => {
  const OPTIONS_IDS = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent', 'stat-source',
    'model-select', 'custom-limit', 'show-widget', 'toggle-api-key',
    'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag', 'reset-limit',
    'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
    'aiCmProactive', 'aiCmProactiveNotify',
    'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh',
    'api-key-status', 'api-key-remove',
    'archive-file', 'archive-import', 'archive-refresh', 'archive-status', 'archive-list'
  ];

  function setupDom() {
    document.body.innerHTML = '';
    OPTIONS_IDS.forEach(function (id) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    });
    const keyInput = document.createElement('input');
    keyInput.id = 'api-key';
    keyInput.type = 'password';
    document.body.appendChild(keyInput);
    const versionEl = document.createElement('span');
    versionEl.className = 'version';
    document.body.appendChild(versionEl);
  }

  function chromeStub(locale, sessionStore) {
    return {
      runtime: {
        getManifest: function () { return { version: '1.18.0' }; },
        getURL: function () { return 'print.html'; },
        lastError: null,
        sendMessage: function () { }
      },
      i18n: locale ? {
        getMessage: function (key) { return locale[key] ? locale[key].message : ''; }
      } : undefined,
      storage: {
        sync: { get: function (keys, cb) { cb({}); }, set: function () { } },
        local: {
          get: function (keys, cb) { if (typeof cb === 'function') cb({}); },
          getKeys: function (cb) { cb([]); },
          set: function (obj, cb) { if (cb) cb(); },
          remove: function (keys, cb) { if (cb) cb(); }
        },
        session: {
          get: function (keys) { return Promise.resolve(Object.assign({}, sessionStore || {})); },
          set: function (obj, cb) { if (cb) cb(); return Promise.resolve(); },
          remove: function (keys, cb) { if (cb) cb(); return Promise.resolve(); }
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

  function mountOptions(locale, sessionStore) {
    global.chrome = chromeStub(locale, sessionStore);
    jest.resetModules();
    require('../options/options.js');
  }

  function flush() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  afterEach(function () {
    document.body.innerHTML = '';
    delete global.chrome;
  });

  test('источник строк статуса — ключи локали, а не литералы в коде', () => {
    expect(optionsJs).toContain('chrome.i18n.getMessage');
    expect(optionsJs).toContain("'options_byok_status_set'");
    expect(optionsJs).toContain("'options_byok_status_unset'");
    // русский фолбэк сохранён (окружения без chrome.i18n — прежнее поведение)
    expect(optionsJs).toContain("'Ключ: задан'");
    expect(optionsJs).toContain("'Ключ: не задан'");
  });

  test('ключ есть в session → статус = en-сообщение «Key: set»', async () => {
    setupDom();
    mountOptions(en, { aiCmApiKeySession: 'k-from-session' });
    await flush();
    expect(document.getElementById('api-key-status').textContent).toBe(en.options_byok_status_set.message);
  });

  test('ключа нет → статус = en-сообщение «Key: not set»', async () => {
    setupDom();
    mountOptions(en, {});
    await flush();
    expect(document.getElementById('api-key-status').textContent).toBe(en.options_byok_status_unset.message);
  });

  test('без chrome.i18n статус байтово прежний: «Ключ: не задан»', async () => {
    setupDom();
    mountOptions(null, {});
    await flush();
    expect(document.getElementById('api-key-status').textContent).toBe('Ключ: не задан');
  });
});
