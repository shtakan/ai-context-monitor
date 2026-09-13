/**
 * M-4 (фаза 3): i18n-фундамент — _locales ru/en + механика подстановки.
 * M-4.2: полная поддержка en для ДИНАМИЧЕСКИХ (не разметочных) пользовательских строк.
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
 *      с русским фолбэком для окружений без chrome.i18n;
 *   6) M-4.2: динамические строки content.js/options.js/print.js/export-text-builders.js
 *      объявлены ключами локали (content_* / options_* / print_* / export_md_*), а
 *      русские литералы в коде — ровно фолбэки локали (пин по литералам + пины jsdom).
 *
 * Пины прежних сьютов (русские тексты, aria-имена, title, ссылки футера) не
 * ослабляются: разметка хранит русский текст как фолбэк, подстановка затирает
 * его только при непустом сообщении локали; фолбэк динамических строк байтово равен
 * прежнему русскому литералу.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const optionsHtml = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const printHtml = fs.readFileSync(path.join(ROOT, 'print', 'print.html'), 'utf8');
const optionsJs = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const printJs = fs.readFileSync(path.join(ROOT, 'print', 'print.js'), 'utf8');
const exportBuildersJs = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');
const i18nApplySrc = fs.readFileSync(path.join(ROOT, 'options', 'i18n-apply.js'), 'utf8');

const ru = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'ru', 'messages.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));

// Источники динамических строк M-4.2 (файл → исходник).
const DYNAMIC_SOURCES = [
  ['core/content.js', contentJs],
  ['options/options.js', optionsJs],
  ['print/print.js', printJs],
  ['utils/export-text-builders.js', exportBuildersJs]
];

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

  test('нет мёртвых ключей: каждый ключ локали используется разметкой, options.js или динамикой M-4.2', () => {
    const used = {};
    declaredKeys().forEach(function (key) { used[key] = true; });
    DYNAMIC_SOURCES.forEach(function (pair) {
      Object.keys(ru).forEach(function (key) {
        // ключи объявлены в исходниках как строковые литералы: aiCmI18nMessage('key', ...) / t('key', ...)
        if (pair[1].indexOf("'" + key + "'") !== -1) used[key] = true;
      });
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

/* =====================================================================================
 * 6. M-4.2: динамические строки — ключи локали и байтовые ru-фолбэки
 * ===================================================================================== */

// Зоны новых ключей M-4.2 (паритет ru/en проверяется по всему словарю выше,
// здесь — что зоны вообще наполнены и что ключи реально используются кодом).
const NEW_KEY_ZONES = ['content_', 'print_role_', 'print_doc_title', 'print_meta_', 'print_empty_body', 'export_md_', 'options_archive_', 'options_stale_'];

/** Все ключи, на которые код ссылается как aiCmI18nMessage('key', ...) / i18n('key', ...) / t('key', ...). */
function referencedKeys() {
  const re = /\b(?:aiCmI18nMessage|i18n|t)\(\s*'([a-z][a-z0-9_]*)'/g;
  const found = [];
  DYNAMIC_SOURCES.forEach(function (pair) {
    let m;
    while ((m = re.exec(pair[1])) !== null) found.push({ file: pair[0], key: m[1] });
  });
  return found;
}

describe('M-4.2: динамические строки объявлены ключами обеих локалей', () => {
  test('новые зоны ключей наполнены', () => {
    const keys = Object.keys(ru);
    NEW_KEY_ZONES.forEach(function (zone) {
      const hits = keys.filter(function (k) { return k.indexOf(zone) === 0; });
      expect([zone, hits.length > 0]).toEqual([zone, true]);
    });
    // M-4.2 добавил полный набор динамических ключей (а не «пара штук»)
    expect(keys.filter(function (k) { return k.indexOf('content_') === 0; }).length).toBeGreaterThanOrEqual(20);
    expect(keys.filter(function (k) { return k.indexOf('export_md_') === 0; }).length).toBe(7);
  });

  test('паритет новых ключей: каждый ключ динамики есть и в ru, и в en', () => {
    const refs = referencedKeys();
    expect(refs.length).toBeGreaterThan(50);
    refs.forEach(function (ref) {
      expect([ref.file, ref.key, Object.prototype.hasOwnProperty.call(ru, ref.key)]).toEqual([ref.file, ref.key, true]);
      expect([ref.file, ref.key, Object.prototype.hasOwnProperty.call(en, ref.key)]).toEqual([ref.file, ref.key, true]);
    });
    // и обратно: ключи зон M-4.2 действительно используются кодом (нет «мёртвых»)
    const refKeys = {};
    refs.forEach(function (ref) { refKeys[ref.key] = true; });
    Object.keys(ru).forEach(function (key) {
      if (key.indexOf('content_') === 0 || key.indexOf('export_md_') === 0) {
        expect([key, refKeys[key] === true]).toEqual([key, true]);
      }
    });
  });

  test('ru-фолбэк непараметрических вызовов байтово равен сообщению локали', () => {
    const re = /\b(?:aiCmI18nMessage|i18n|t)\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*[,)]/g;
    let checked = 0;
    DYNAMIC_SOURCES.forEach(function (pair) {
      let m;
      while ((m = re.exec(pair[1])) !== null) {
        checked++;
        expect([pair[0], m[1], m[2]]).toEqual([pair[0], m[1], message(ru, m[1])]);
        expect(message(en, m[1])).not.toBe('');
      }
    });
    expect(checked).toBeGreaterThan(20);
  });

  test('print_role_user / print_role_assistant — в обеих локалях, значения заданы', () => {
    expect(message(ru, 'print_role_user')).toBe('Пользователь');
    expect(message(ru, 'print_role_assistant')).toBe('Ассистент');
    expect(message(en, 'print_role_user')).toBe('User');
    expect(message(en, 'print_role_assistant')).toBe('Assistant');
  });

  test('хардкод ролей в print.js убран: рендер идёт через ключи', () => {
    expect(printJs).toContain("aiCmI18nMessage('print_role_user', 'Пользователь')");
    expect(printJs).toContain("aiCmI18nMessage('print_role_assistant', 'Ассистент')");
    expect(printJs).not.toContain("role === 'user' ? 'Пользователь' : 'Ассистент'");
  });

  test('json-схема export-text-builders.js не тронута (имена полей = формат данных)', () => {
    expect(exportBuildersJs).toContain('platform: (platform || \'AI Chat\'),');
    expect(exportBuildersJs).toContain('exportedAt: new Date().toISOString(),');
    expect(exportBuildersJs).not.toContain("aiCmI18nMessage('platform'");
  });
});

/* =====================================================================================
 * 7. M-4.2: пин «вне логов и фолбэков локали пользовательских ru-литералов нет»
 * ===================================================================================== */

// Мини-лексер: замаскировать комментарии/строки/шаблоны/регулярки и собрать литералы
// (в шаблонах интерполяции заменяются на $1..$N — так фолбэк-шаблон сравнивается с
// сообщением локали байтово). Без этого пина регулярка `/[^']+/g` и кириллица в
// комментариях давали бы ложные срабатывания.
const BT = String.fromCharCode(96);

function lexSource(src) {
  const n = src.length;
  const masked = src.split('');
  const literals = [];
  const frames = [];
  let i = 0, line = 1, mode = 'code', braceDepth = 0, lastSig = '';
  const REGEX_PREV = '(,=:[!&|?{};+-*%~^<>';
  const REGEX_KEYWORDS = {
    'return': 1, 'typeof': 1, 'case': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1,
    'void': 1, 'instanceof': 1, 'do': 1, 'else': 1, 'yield': 1, 'await': 1
  };
  function blank(k) { if (k < n && src[k] !== '\n') masked[k] = ' '; }
  function openFrame(quote, kind, atLine) { frames.push({ quote: quote, kind: kind, line: atLine, buf: '', from: mode }); }
  function closeFrame() { const f = frames.pop(); if (f) literals.push({ line: f.line, text: f.buf, kind: f.kind }); return f; }
  function top() { return frames.length ? frames[frames.length - 1] : null; }
  function regexAllowed() {
    if (lastSig === '' || REGEX_PREV.indexOf(lastSig) !== -1) return true;
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    const end = j;
    while (j >= 0 && /[A-Za-z$_]/.test(src[j])) j--;
    return REGEX_KEYWORDS[src.slice(j + 1, end + 1)] === 1;
  }
  function skipRegex() {
    blank(i); i++;
    let inClass = false;
    while (i < n) {
      const rc = src[i];
      if (rc === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (rc === '\n') break;
      if (rc === '[') inClass = true;
      else if (rc === ']') inClass = false;
      else if (rc === '/' && !inClass) { blank(i); i++; break; }
      blank(i); i++;
    }
    lastSig = 'x';
  }
  while (i < n) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '\n') line++;
    if (mode === 'code' || mode === 'tmpl-code') {
      if (ch === '/' && nx === '/') { blank(i); blank(i + 1); mode = (mode === 'code') ? 'comment-line' : 'tmpl-comment-line'; i += 2; continue; }
      if (ch === '/' && nx === '*') { blank(i); blank(i + 1); mode = (mode === 'code') ? 'comment-block' : 'tmpl-comment-block'; i += 2; continue; }
      if (ch === '/' && regexAllowed()) { skipRegex(); continue; }
      if (ch === "'" || ch === '"') { openFrame(ch, 'string', line); blank(i); lastSig = ch; mode = (ch === "'") ? 'str-single' : 'str-double'; i++; continue; }
      if (ch === BT) { openFrame(BT, 'template', line); blank(i); lastSig = BT; mode = 'tmpl'; i++; continue; }
      if (mode === 'tmpl-code') {
        if (ch === '{') braceDepth++;
        else if (ch === '}') { braceDepth--; if (braceDepth === 0) mode = 'tmpl'; }
      }
      if (!/\s/.test(ch)) lastSig = ch;
      i++; continue;
    }
    if (mode === 'comment-line' || mode === 'tmpl-comment-line') {
      if (ch === '\n') mode = (mode === 'comment-line') ? 'code' : 'tmpl-code'; else blank(i);
      i++; continue;
    }
    if (mode === 'comment-block' || mode === 'tmpl-comment-block') {
      if (ch === '*' && nx === '/') { blank(i); blank(i + 1); mode = (mode === 'comment-block') ? 'code' : 'tmpl-code'; i += 2; continue; }
      blank(i); i++; continue;
    }
    if (mode === 'str-single' || mode === 'str-double') {
      const q = mode === 'str-single' ? "'" : '"';
      if (ch === '\\') { const ts = top(); if (ts) ts.buf += (src[i + 1] || ''); blank(i); blank(i + 1); i += 2; continue; }
      if (ch === q) { const fs = closeFrame(); blank(i); mode = (fs && fs.from) ? fs.from : 'code'; i++; continue; }
      const ts2 = top(); if (ts2) ts2.buf += ch;
      blank(i); i++; continue;
    }
    if (mode === 'tmpl') {
      if (ch === '\\') { const tt = top(); if (tt) tt.buf += (src[i + 1] || ''); blank(i); blank(i + 1); i += 2; continue; }
      if (ch === BT) { const ft = closeFrame(); blank(i); mode = (ft && ft.from) ? ft.from : 'code'; i++; continue; }
      if (ch === '$' && nx === '{') {
        blank(i); blank(i + 1);
        const host = top();
        if (host) { host.interp = (host.interp || 0) + 1; host.buf += '$' + host.interp; }
        mode = 'tmpl-code'; braceDepth = 1; i += 2; continue;
      }
      const tt2 = top(); if (tt2) tt2.buf += ch;
      blank(i); i++; continue;
    }
    i++;
  }
  while (frames.length) closeFrame();
  return { masked: masked.join(''), literals: literals };
}

function lineOfIndex(src, idx) {
  let c = 1;
  for (let k = 0; k < idx && k < src.length; k++) if (src[k] === '\n') c++;
  return c;
}

/** Номера строк, занятые вызовами логов (debugLog/console.*), с балансировкой скобок. */
function logCallLines(src) {
  const masked = lexSource(src).masked;
  const lines = {};
  const re = /(?:debugLog|\bconsole\s*\.\s*(?:log|warn|error|info|debug))\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0, k = open;
    for (; k < masked.length; k++) {
      const c = masked[k];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    const from = lineOfIndex(src, m.index);
    const to = lineOfIndex(src, Math.min(k, masked.length - 1));
    for (let L = from; L <= to; L++) lines[L] = true;
  }
  return lines;
}

/** Допустимые ru-литералы: сообщение локали или его фиксированный кусок между $1..$9. */
function localeLiterals(locale) {
  const allowed = {};
  Object.keys(locale).forEach(function (key) {
    const msg = String(locale[key].message);
    allowed[msg] = key;
    msg.split(/\$\d/g).forEach(function (part) { if (part) allowed[part] = key; });
  });
  return allowed;
}

// Логи/диагностика, структурно не попадающие в аргументы вызова лога:
//   * diag-объект DOM-хвоста (getEffectiveText) уходит ТОЛЬКО в debugLog('[hybrid-tail] …');
//   * путь детектора модели — значения для console.log('[model-detect] …');
//   * внутренняя Error-строка doAutoExportDownload (catch → console.error).
const LOG_PAYLOAD_LITERALS = [
  'нет базы', 'селектор не дал узлов: ', 'кэш базы пуст → фолбэк по базе',
  ' узлов=', ' стоп=', 'нет(все в окне — новые)', ' хвост=', 'да', 'нет',
  'порог ', 'попап', 'сеть', 'дефолт', '→дефолт(не распознан)',
  'utils/export-text-builders.js не загружен'
];
// Содержимое экспорт-файла диагностики (данные, а не UI) — не переводится (M-4.2, п.6).
const EXPORT_DATA_LITERALS = ['нет активной вкладки', 'content script не ответил: ', 'пустой ответ'];

describe('M-4.2: литералы — пользовательских ru-строк вне логов и фолбэков локали нет', () => {
  test('лексер различает литералы, комментарии, регулярки и интерполяции шаблонов', () => {
    const fixture =
      '// комментарий с кириллицей\n' +
      "var a = 'строка';\n" +
      'var re = /' + BT + '+/g;\n' +
      'var t = ' + BT + 'шапка: ${x} шт' + BT + ';\n';
    const lits = lexSource(fixture).literals;
    const texts = lits.map(function (l) { return l.text; });
    expect(texts).toContain('строка');
    expect(texts).toContain('шапка: $1 шт');
    expect(texts.filter(function (t) { return t.indexOf('комментарий') !== -1; })).toEqual([]);
    // регулярка с обратными кавычками не должна «съедать» остаток файла
    expect(lits.length).toBe(2);
  });

  test('вызовы логов определяются вместе с многострочными аргументами', () => {
    const src = "debugLog('log', 'первая ' +\n  'вторая строка');\nvar x = 'вне лога';";
    const lines = logCallLines(src);
    expect(lines[1]).toBe(true);
    expect(lines[2]).toBe(true);
    expect(lines[3]).toBeUndefined();
  });

  test('в content.js / options.js / print.js / export-text-builders.js ru-литералы = ровно фолбэки локали', () => {
    const allowed = localeLiterals(ru);
    const whitelist = {};
    LOG_PAYLOAD_LITERALS.concat(EXPORT_DATA_LITERALS).forEach(function (v) { whitelist[v] = true; });
    const offenders = [];
    DYNAMIC_SOURCES.forEach(function (pair) {
      const src = pair[1];
      const logs = logCallLines(src);
      lexSource(src).literals.forEach(function (lit) {
        if (!/[\u0400-\u04FF]/.test(lit.text)) return;   // интересует только кириллица
        if (logs[lit.line]) return;                      // whitelist логовых вызовов
        if (allowed[lit.text]) return;                   // фолбэк локали (или его кусок)
        if (whitelist[lit.text]) return;                 // логи/диагностика вне аргументов вызова
        offenders.push(pair[0] + ':' + lit.line + ' :: ' + JSON.stringify(lit.text));
      });
    });
    expect(offenders).toEqual([]);
  });

  test('пин не холостой: литералы в этих файлах вообще находятся', () => {
    const total = DYNAMIC_SOURCES.reduce(function (acc, pair) {
      return acc + lexSource(pair[1]).literals.length;
    }, 0);
    expect(total).toBeGreaterThan(1000);
  });
});

/* =====================================================================================
 * 8. M-4.2: print.js в jsdom — роли/шапка рендерятся из chrome.i18n
 * ===================================================================================== */

describe('M-4.2: print.js — роли и шапка печатной формы из chrome.i18n', () => {
  const HISTORY = {
    host: 'gemini.google.com',
    convId: '72c88213f2e812e1',
    site: 'gemini',
    model: 'Gemini 2.5 Pro',
    tokens: 1234,
    limit: 1000000,
    percent: 1.2,
    updatedAt: 1780000000000,
    messages: [
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: 'ответ' }
    ]
  };

  /** Мок chrome с честной подстановкой $1..$9 (как chrome.i18n.getMessage(key, [...])) */
  function chromeMock(locale) {
    return {
      i18n: locale ? {
        getMessage: function (key, substitutions) {
          const entry = locale[key];
          if (!entry) return '';
          let text = entry.message;
          if (substitutions) {
            const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
            subs.forEach(function (value, index) {
              text = text.split('$' + (index + 1)).join(String(value));
            });
          }
          return text;
        }
      } : undefined,
      tabs: {
        get: function (id, cb) { cb({ id: id, url: 'https://gemini.google.com/app/72c88213f2e812e1' }); },
        sendMessage: function (id, msg, cb) { cb({ data: HISTORY }); }
      },
      storage: { local: { get: function (keys, cb) { cb({ aiCmHistory: HISTORY }); } } },
      runtime: { lastError: null, sendMessage: function () { } }
    };
  }

  /** Реальный print/print.js в текущем jsdom-window (как tests/print/print-hygiene-e2). */
  function renderPrint(locale) {
    jest.useFakeTimers();
    document.body.innerHTML =
      '<div class="print-wrap"><div id="print-banner"></div>' +
      '<div id="print-content"></div>' +
      '<div class="empty-state" id="empty-state" style="display:none;"></div></div>';
    document.title = '';
    const escape = function (s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    window.MarkdownRenderer = {
      escapeHtml: escape,
      render: function (text) { return '<p>' + escape(text) + '</p>'; }
    };
    window.print = function () { };
    const params = { get: function (name) { return (name === 'tab') ? '7' : null; } };
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'document', 'chrome', 'console', 'setTimeout', 'clearTimeout', 'URLSearchParams', printJs);
    try {
      fn(window, document, chromeMock(locale), console,
        function (cb, ms) { return setTimeout(cb, ms); },
        function (id) { return clearTimeout(id); },
        function () { return params; });
      jest.advanceTimersByTime(200);
      return document.getElementById('print-content').innerHTML;
    } finally {
      delete window.MarkdownRenderer;
      jest.useRealTimers();
    }
  }

  afterEach(function () {
    document.body.innerHTML = '';
    document.title = '';
    jest.useRealTimers();
  });

  test('en-локаль: роли User/Assistant и англоязычная шапка', () => {
    const html = renderPrint(en);
    expect(html).toContain('<div class="msg-role">' + en.print_role_user.message + '</div>');
    expect(html).toContain('<div class="msg-role">' + en.print_role_assistant.message + '</div>');
    expect(html).toContain('<h1>' + en.print_doc_title.message + '</h1>');
    expect(html).toContain('<b>' + en.print_meta_platform.message + '</b> Gemini');
    expect(html).not.toContain('Пользователь');
    expect(html).not.toContain('Ассистент');
  });

  test('ru-локаль: роли Пользователь/Ассистент байтово прежние', () => {
    const html = renderPrint(ru);
    expect(html).toContain('<div class="msg-role">Пользователь</div>');
    expect(html).toContain('<div class="msg-role">Ассистент</div>');
    expect(html).toContain('<h1>AI Context Monitor — история диалога</h1>');
    expect(html).toContain('<b>Платформа:</b> Gemini');
  });

  test('без chrome.i18n: те же русские фолбэки (форма не пустеет и не ломается)', () => {
    const html = renderPrint(null);
    expect(html).toContain('<div class="msg-role">Пользователь</div>');
    expect(html).toContain('<div class="msg-role">Ассистент</div>');
    expect(html).toContain('вопрос');
    expect(html).toContain('ответ');
  });
});
