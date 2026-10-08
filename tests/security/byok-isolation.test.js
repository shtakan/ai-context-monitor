/**
 * Шаг A.1 (security): изоляция BYOK-ключа и O3-латча already-fired в Service Worker.
 *
 * Контекст: до Шага A.1 core/background.js открывал chrome.storage.session ВСЕМ
 * контент-скриптам (setAccessLevel 'TRUSTED_AND_UNTRUSTED_CONTEXTS'), поэтому
 * BYOK-ключ ('aiCmApiKeySession') был читаем кодом любого сайта в общей куче
 * контент-скриптов, а кросс-табовый латч O3 читался/писался вкладками напрямую.
 * После Шага A.1 session-хранилище доступно только доверенным контекстам (SW и
 * extension-страницы), а контент-скрипты ходят в SW сообщениями:
 *   'aiCm-get-byok-key'   — единственная точка выхода ключа из SW (P5);
 *   'aiCm-latch-get' | 'aiCm-latch-set' | 'aiCm-latch-remove' | 'aiCm-latch-get-all'
 *                          — O3-латч already-fired (семантика v1.14.1 сохранена).
 *
 * Пины этого файла:
 *   P1 — setAccessLevel вызывается ТОЛЬКО с 'TRUSTED_CONTEXTS' (валидное значение
 *        Chrome — было несуществующее 'TRUSTED_CONTEXTS_ONLY', см. аппендикс v54),
 *        плюс R-пин: значение принадлежит allow-list'у Chrome;
 *   P2 — ноль обращений к chrome.storage.session в контент-скриптах;
 *   P3 — ключ BYOK приходит в контент из SW (aiCmReadByokKey → 'aiCm-get-byok-key');
 *   P4 — O3-латч читается/пишется/снимается через SW-канал (поведенческий прогон SW);
 *   P5 — 'aiCm-get-byok-key' — единственный обработчик, отдающий значение ключа.
 *
 * Тест НЕ трогает A.2 (postMessage/origin) и не проверяет его: это отдельный подшаг.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BG_SRC = read('core/background.js');
const CONTENT_SRC = require('../helpers/content-source.js').contentSource;
const MANIFEST = JSON.parse(read('manifest.json'));

const SESSION_KEY = 'aiCmApiKeySession';
const FIRED_PREFIX = 'aiCmFired:';
const UNTRUSTED_LEVEL = 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
// FIX-SETACCESSLEVEL (аппендикс v54): было TRUSTED_CONTEXTS_ONLY — Chrome отклоняет;
// текст ошибки: "Value must be one of TRUSTED_AND_UNTRUSTED_CONTEXTS, TRUSTED_CONTEXTS".
// Allow-list ниже — единственные валидные значения accessLevel; TRUSTED_LEVEL (намерение
// Шага A.1 — сжать session до доверенных контекстов) обязан ему принадлежать.
const VALID_ACCESS_LEVELS = ['TRUSTED_CONTEXTS', 'TRUSTED_AND_UNTRUSTED_CONTEXTS'];
const TRUSTED_LEVEL = 'TRUSTED_CONTEXTS';

// Обращение к session-API (после 'session' идёт точка/скобка), а не упоминание в
// комментарии-пояснении Шага A.1: пины P2/P4 обязаны видеть именно ВЫЗОВ.
const SESSION_CALL = /chrome\.storage\.session\s*[.(]/;

/**
 * Маскирует комментарии и строковые литералы пробелами (структура строк сохранена),
 * чтобы пины «нет обращения к API» не ловили прозу о самом запрете. Тот же приём,
 * что в tests/no-bare-console-error.test.js (maskNonCode) — здесь усечённый сканер.
 */
function maskNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2); blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        if (quote !== '`' && src[j] === '\n') break; // незакрытая строка — не уходим за строку
        j++;
      }
      blank(i, j); i = j; continue;
    }
    i++;
  }
  return out.join('');
}

/* =====================================================================================
 * Загрузка реального core/background.js в vm-песочницу (тот же приём, что в
 * tests/byok-session.test.js): все chrome.* API замоканы, вызовы видны тесту.
 * ===================================================================================== */

function pick(store, keys) {
  if (keys == null) return Object.assign({}, store);
  const list = typeof keys === 'string' ? [keys] : keys;
  const out = {};
  list.forEach((k) => { if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]; });
  return out;
}

function loadBackground(opts) {
  opts = opts || {};
  const listeners = { message: [] };
  const localStore = Object.assign({}, opts.local || {});
  const sessionStore = Object.assign({}, opts.session || {});
  const accessLevelCalls = [];

  const storage = {
    localStore: localStore,
    sessionStore: sessionStore,
    accessLevelCalls: accessLevelCalls,
    sync: { get: (k, cb) => { if (cb) cb({}); }, set: () => { } },
    local: {
      get: (keys, cb) => { if (typeof cb === 'function') cb(pick(localStore, keys)); },
      set: (obj, cb) => { Object.assign(localStore, obj); if (cb) cb(); },
      remove: (keys, cb) => {
        (typeof keys === 'string' ? [keys] : keys || []).forEach((k) => { delete localStore[k]; });
        if (cb) cb();
      }
    },
    session: {
      // get(null) → всё хранилище сессии: ровно то, что раньше читал контент-скрипт.
      get: (keys, cb) => { if (typeof cb === 'function') cb(pick(sessionStore, keys)); },
      set: (obj, cb) => { Object.assign(sessionStore, obj); if (cb) cb(); },
      remove: (keys, cb) => {
        (typeof keys === 'string' ? [keys] : keys || []).forEach((k) => { delete sessionStore[k]; });
        if (cb) cb();
      },
      setAccessLevel: (arg) => { accessLevelCalls.push(arg); }
    },
    onChanged: { addListener: () => { } }
  };

  const sandbox = {
    console: { log: () => { }, warn: () => { }, error: () => { } },
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (...a) => globalThis.clearInterval(...a),
    Date, JSON, Math, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    AbortController,
    fetch: opts.fetch || (() => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') })),
    importScripts: () => { },
    chrome: {
      runtime: {
        id: 'test-extension-id',
        getManifest: () => ({ version: '2.0.13' }),
        getURL: (p) => 'chrome-extension://test-extension-id/' + p,
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        onInstalled: { addListener: () => { } },
        onStartup: { addListener: () => { } },
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
      tabs: { get: () => { }, update: () => { }, remove: () => { }, query: (q, cb) => { if (cb) cb([]); }, sendMessage: () => { } },
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
    // Как chrome.runtime.sendMessage: ответ отдаёт слушатель, вернувший true
    // (асинхронный канал sendResponse). Промис резолвится ПЕРВЫМ ответом; если
    // обработчик ответа не даёт (синхронные каналы) — undefined после его промиса.
    send: (message, sender) => new Promise((resolve) => {
      let answered = false;
      const respond = (resp) => { if (!answered) { answered = true; resolve(resp); } };
      listeners.message.forEach((fn) => {
        try {
          const ret = fn(message, sender || { id: 'test-extension-id', tab: { id: 1 } }, respond);
          if (ret && typeof ret.then === 'function') ret.then(() => respond(undefined), () => respond(undefined));
        } catch (e) { respond(undefined); }
      });
      // Ни один слушатель не ответил и не отдал промис (напр. неизвестный тип).
      Promise.resolve().then(() => { if (!answered && !listeners.message.length) respond(undefined); });
      setTimeout(() => respond(undefined), 50);
    })
  };
}

/* =====================================================================================
 * P1 — accessLevel сжат до доверенных контекстов
 * ===================================================================================== */

describe('Шаг A.1 / P1: chrome.storage.session доступен только доверенным контекстам', () => {
  test('setAccessLevel вызван ровно с TRUSTED_CONTEXTS, недоверенный уровень в SW отсутствует', () => {
    const bg = loadBackground();

    expect(bg.storage.accessLevelCalls).toHaveLength(1);
    expect(bg.storage.accessLevelCalls[0]).toEqual({ accessLevel: TRUSTED_LEVEL });
    // Недоверенный уровень вычищен из SW КОДА целиком (иначе доступ к ключу из
    // контент-скриптов можно вернуть одной правкой значения). В комментариях-пояснениях
    // Шага A.1 он назван — поэтому смотрим только на исполняемые строки.
    const bgCode = BG_SRC.split('\n').filter((l) => l.trim().indexOf('//') !== 0).join('\n');
    expect(bgCode).not.toContain("'" + UNTRUSTED_LEVEL + "'");
    expect(bgCode).toContain("'" + TRUSTED_LEVEL + "'");
  });

  // R-пин (FIX-SETACCESSLEVEL-INVALID-VALUE, аппендикс v54): значение, реально ушедшее
  // в chrome.storage.session.setAccessLevel (реальный core/background.js в vm-песочнице),
  // обязано принадлежать allow-list'у Chrome. Пин выше держит «именно TRUSTED_CONTEXTS»
  // по намерению A.1; этот ловит любое значение-мусор, которое Chrome отклоняет
  // TypeError'ом на параметре accessOptions (так и прожил незамеченным TRUSTED_CONTEXTS_ONLY).
  test('значение accessLevel принадлежит allow-list Chrome (TRUSTED_CONTEXTS | TRUSTED_AND_UNTRUSTED_CONTEXTS)', () => {
    const bg = loadBackground();

    expect(bg.storage.accessLevelCalls).toHaveLength(1);
    const passed = bg.storage.accessLevelCalls[0] && bg.storage.accessLevelCalls[0].accessLevel;
    if (VALID_ACCESS_LEVELS.indexOf(passed) === -1) {
      throw new Error('invalid accessLevel value: ' + JSON.stringify(passed) +
        ' — Chrome: "Value must be one of ' + VALID_ACCESS_LEVELS.join(', ') + '"');
    }
    expect(VALID_ACCESS_LEVELS).toContain(passed);
  });
});

/* =====================================================================================
 * P2 — в контент-скриптах нет ни одного обращения к chrome.storage.session
 * ===================================================================================== */

describe('Шаг A.1 / P2: контент-скрипты не ходят в chrome.storage.session напрямую', () => {
  // Контент-сборка = все файлы core/, utils/, adapters/ (manifest content_scripts +
  // runtime-registered MAIN-перехватчики из background.js). core/background.js — SW,
  // он и есть владелец session-хранилища; options/ и print/ — extension-страницы
  // (trusted-контекст), их BYOK-путь Шагом A.1 не менялся.
  const contentScriptFiles = [];
  ['core', 'utils', 'adapters'].forEach((dir) => {
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach((ent) => {
      if (!ent.isFile() || !ent.name.endsWith('.js')) return;
      const rel = dir + '/' + ent.name;
      if (rel === 'core/background.js') return;
      contentScriptFiles.push(rel);
    });
  });

  test('исходники контент-скриптов: ноль chrome.storage.session, но SW его использует', () => {
    expect(contentScriptFiles.length).toBeGreaterThanOrEqual(20);
    // Манифест действительно грузит эти каталоги как контент-скрипты (страховка от
    // переезда файлов: пин должен ломаться, если контент начнут собирать из другого места).
    const manifestJs = MANIFEST.content_scripts.reduce((acc, cs) => acc.concat(cs.js || []), []);
    expect(manifestJs.length).toBeGreaterThan(0);
    manifestJs.forEach((rel) => expect(contentScriptFiles).toContain(rel));

    const offenders = [];
    contentScriptFiles.forEach((rel) => {
      if (SESSION_CALL.test(maskNonCode(read(rel)))) offenders.push(rel);
    });
    expect(offenders).toEqual([]);

    // (b) граница приёмки: в собранном контент-бандле тоже ноль (npm run build — до jest).
    const distContent = path.join(ROOT, 'dist', 'content.js');
    if (fs.existsSync(distContent)) {
      expect(SESSION_CALL.test(maskNonCode(fs.readFileSync(distContent, 'utf8')))).toBe(false);
    }
    // SW — единственный владелец: там обращение есть (иначе пин P2 вырождается).
    expect(SESSION_CALL.test(maskNonCode(BG_SRC))).toBe(true);
  });
});

/* =====================================================================================
 * P3 — ключ BYOK приходит в контент из SW
 * ===================================================================================== */

describe('Шаг A.1 / P3: контент получает ключ BYOK у SW, а не из хранилища', () => {
  test('aiCmReadByokKey спрашивает SW и берёт ключ из ответа aiCm-get-byok-key', () => {
    // Контент: единственный путь чтения ключа — сообщение SW.
    expect(CONTENT_SRC).toContain("aiCmSwAsk({ type: 'aiCm-get-byok-key' })");
    expect(CONTENT_SRC).toContain('function aiCmReadByokKey(');
    // key из ответа SW; local остаётся только переходным фолбэком окна миграции M-7.
    expect(CONTENT_SRC).toContain("var v = (resp && typeof resp.key === 'string') ? resp.key : '';");
    // R4: ключ ждут ДО tryInit (иначе первый COUNT_TOKENS уходит без ключа).
    expect(CONTENT_SRC).toContain('await loadByokSettingsAsync();');
    expect(CONTENT_SRC).toContain('function loadByokSettingsAsync() {');
    expect(CONTENT_SRC).toContain('var aiCmByokKeyPromise = null;');
    // Вызов ключа — ДО tryInit и ДО гидратации кэша латча (порядок R4/R1).
    const contentNow = CONTENT_SRC;
    const iKey = contentNow.indexOf('await loadByokSettingsAsync();');
    const iLatch = contentNow.indexOf('await aiCmLatchCacheReady();');
    const iTryInit = contentNow.indexOf('await tryInit()');
    expect(iKey).toBeGreaterThan(-1);
    expect(iLatch).toBeGreaterThan(iKey);
    expect(iTryInit).toBeGreaterThan(iLatch);
  });

  test('SW отдаёт ключ контент-скрипту (обработчик aiCm-get-byok-key)', async () => {
    const bg = loadBackground({ session: { [SESSION_KEY]: 'AIza-session-key' } });
    const resp = await bg.send({ type: 'aiCm-get-byok-key' });
    expect(resp).toEqual({ key: 'AIza-session-key' });
  });

  test('SW отдаёт пустую строку без ключа (без legacy в local) — фолбэк контента остаётся прежним', async () => {
    const bg = loadBackground({ session: {} });
    const resp = await bg.send({ type: 'aiCm-get-byok-key' });
    expect(resp).toEqual({ key: '' });
  });
});

/* =====================================================================================
 * P4 — O3-латч already-fired живёт за SW-каналом
 * ===================================================================================== */

describe('Шаг A.1 / P4: O3-латч читается/пишется/снимается через SW', () => {
  const firedKey = FIRED_PREFIX + 'gemini|c1';

  test('контент: обёртки aiCm-latch-* вместо chrome.storage.session, кэш гидрируется из SW (R1)', () => {
    const exportManager = read('core/export-manager.js');
    const widget = read('core/widget.js');
    const state = read('core/state.js');
    // Именно ОБРАЩЕНИЕ к API, а не упоминание в комментариях-пояснениях Шага A.1
    // (почему обращения больше нет): код отделяем маской комментариев/литералов.
    [exportManager, widget, state].forEach((src) => {
      expect(SESSION_CALL.test(maskNonCode(src))).toBe(false);
    });
    // Запись/снятие — только через SW-обёртки (объявлены в state.js: грузится раньше
    // export-manager.js, чей IIFE гидратации вызывает их при загрузке).
    expect(state).toContain('function aiCmLatchSet(service, convId)');
    expect(state).toContain('function aiCmLatchRemove(service, convId)');
    expect(state).toContain('function aiCmLatchGetAll()');
    expect(exportManager).toContain('aiCmLatchSet(siteO3, cid);');
    expect(widget).toContain('aiCmLatchRemove(siteD14, cidD14);');
    // R1: гидратация кэша асинхронная → initialize() её дожидается (иначе синхронная
    // проверка вердикта прошла бы по пустому кэшу и вторая вкладка экспортировала бы чат).
    expect(exportManager).toContain('function aiCmLatchCacheReady()');
    expect(CONTENT_SRC).toContain('await aiCmLatchCacheReady()');
  });

  test('SW: get/set/remove/get-all работают, ключ латча тот же, что у контента (utils/export-emit-pipeline.js)', async () => {
    const bg = loadBackground({ session: { [firedKey]: 1, 'aiCmThr:c1': [90], [SESSION_KEY]: 'k' } });

    // get: взведённый чат и «чужой» чат того же сервиса.
    expect(await bg.send({ type: 'aiCm-latch-get', service: 'gemini', convId: 'c1' })).toEqual({ fired: true });
    expect(await bg.send({ type: 'aiCm-latch-get', service: 'gemini', convId: 'c2' })).toEqual({ fired: false });

    // set: ключ ровно как firedSessionKey() контента, значение ровно 1 (инвариант === 1).
    const setResp = await bg.send({ type: 'aiCm-latch-set', service: 'deepseek', convId: 'c9' });
    expect(setResp).toEqual({ ok: true });
    const P = require('../../utils/export-emit-pipeline.js');
    expect(bg.storage.sessionStore[P.firedSessionKey('deepseek', 'c9')]).toBe(1);
    expect(await bg.send({ type: 'aiCm-latch-get', service: 'deepseek', convId: 'c9' })).toEqual({ fired: true });

    // remove: латч снят (семантика сброса L1 при гистерезисе/новом входе).
    expect(await bg.send({ type: 'aiCm-latch-remove', service: 'deepseek', convId: 'c9' })).toEqual({ ok: true });
    expect(bg.storage.sessionStore[P.firedSessionKey('deepseek', 'c9')]).toBeUndefined();
    expect(await bg.send({ type: 'aiCm-latch-get', service: 'deepseek', convId: 'c9' })).toEqual({ fired: false });

    // get-all: гидратация кэша вкладки — ТОЛЬКО ключи латча, чужие session-записи
    // (пороговый латч aiCmThr:, BYOK-ключ) наружу не уходят.
    const all = await bg.send({ type: 'aiCm-latch-get-all' });
    expect(all).toEqual({ map: { [firedKey]: 1 } });

    // Без service/convId — нейтральный отказ, хранилище не трогаем.
    expect(await bg.send({ type: 'aiCm-latch-set', service: '', convId: 'c1' })).toEqual({ ok: false });
    expect(bg.storage.sessionStore[firedKey]).toBe(1); // существующий латч не снесён
  });
});

/* =====================================================================================
 * P5 — 'aiCm-get-byok-key' единственная точка выхода ключа из SW
 * ===================================================================================== */

describe('Шаг A.1 / P5: ключ выходит из SW только через aiCm-get-byok-key', () => {
  test('в SW ровно один читатель session и одно сообщение с ключом в ответе', () => {
    const byokSessionReads = BG_SRC.split('chrome.storage.session.get([AI_CM_BYOK_SESSION_KEY]').length - 1;
    expect(byokSessionReads).toBe(1); // aiCmSessionByokGet — единственный читатель ключа
    // Оба потребителя ключа (COUNT_TOKENS для сети и сообщение для контента) зовут
    // aiCmReadByokApiKey(): объявление + две точки вызова. Комментарии-пояснения Шага A.1
    // упоминают имена, поэтому считаем только исполняемые строки.
    const bgCodeLines = BG_SRC.split('\n').filter((l) => l.trim().indexOf('//') !== 0);
    const readCalls = bgCodeLines.filter((l) => /(^|\W)await aiCmReadByokApiKey\(\);/.test(l));
    expect(readCalls).toHaveLength(2);
    // Обёртка объявлена ровно один раз (единственная точка выхода ключа контенту)…
    expect(BG_SRC.split('async function aiCmGetByokKeyForContent()').length - 1).toBe(1);
    // …и зовётся ровно из одной ветки onMessage — aiCm-get-byok-key.
    expect(bgCodeLines.filter((l) => l.indexOf('aiCmGetByokKeyForContent()') !== -1)).toHaveLength(2);
    // Сообщение объявлено ровно один раз — как контракт канала.
    expect(BG_SRC.split("message.type === 'aiCm-get-byok-key'").length - 1).toBe(1);
    // Наружу уходит только сам ключ: ни в одном ответе SW нет обёртки с именем ключа.
    expect(BG_SRC).not.toContain('apiKey:');
    expect(BG_SRC).not.toContain('geminiApiKey');
  });

  test('ключ не отдаёт ни один другой канал SW (латч/пороги/бейдж)', async () => {
    const bg = loadBackground({
      session: { [SESSION_KEY]: 'AIza-session-key', [FIRED_PREFIX + 'gemini|c1']: 1 },
      local: { ai_cm_exact_token_count: true }
    });
    // Латч-каналы отвечают только про латч: ключа в их ответах нет ни в каком поле.
    for (const msg of [
      { type: 'aiCm-latch-get', service: 'gemini', convId: 'c1' },
      { type: 'aiCm-latch-get', service: 'gemini', convId: 'nope' },
      { type: 'aiCm-latch-get-all' },
      { type: 'aiCm-latch-set', service: 'gemini', convId: 'c2' },
      { type: 'aiCm-latch-remove', service: 'gemini', convId: 'c2' }
    ]) {
      const resp = await bg.send(msg);
      expect(JSON.stringify(resp)).not.toContain('AIza-session-key');
    }
    // Синхронные/чужие типы сообщений ответа с ключом не порождают.
    expect(await bg.send({ type: 'unknown-type' })).toBeUndefined();
  });
});
