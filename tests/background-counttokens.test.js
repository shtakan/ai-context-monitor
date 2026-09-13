// M-9: гигиена COUNT_TOKENS в core/background.js — таймаут с отменой, debounce, кэш.
// Сьют грузит РЕАЛЬНЫЙ core/background.js в vm-песочницу (chrome-мок + мок fetch),
// поэтому проверяется исполняемый код SW, а не его текстовый отпечаток.
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BG_SRC = fs.readFileSync(path.join(ROOT, 'core', 'background.js'), 'utf8');

const CACHE_MAX = 200;

// === Песочница SW: минимум chrome API, нужный background.js при загрузке ===
// ВАЖНО: setTimeout/clearTimeout берём из globalThis ПО ССЫЛКЕ (не как значения
// модуля) — так SW внутри песочницы попадает на фейковые таймеры Jest, и
// advanceTimersByTimeAsync управляет debounce/таймаутом детерминированно.
function loadBackground(opts) {
  opts = opts || {};
  const logs = [];
  const listeners = { message: [], installed: [], startup: [] };

  const sandbox = {
    console: {
      log: (...a) => logs.push(['log', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')])
    },
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (...a) => globalThis.clearInterval(...a),
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
    fetch: opts.fetch || jest.fn(() => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') })),
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
        local: {
          get: (keys, cb) => cb({ ai_cm_gemini_api_key: 'test-key' }),
          set: (obj, cb) => { if (cb) cb(); }
        },
        session: {
          get: (keys, cb) => cb({}),
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
    logs,
    logsText: () => logs.map((e) => e[1]).join('\n'),
    // Полный путь как в SW: onMessage-листенер → handleCountTokens(message, sender) → sendResponse
    send: (message, sender) => new Promise((resolve) => {
      listeners.message.forEach((fn) => fn(message, sender || { tab: { id: 1 } }, resolve));
    })
  };
}

// Прокрутка фейковых таймеров + микрозадач (fetch → json → resolve)
async function advance(ms) {
  await jest.advanceTimersByTimeAsync(ms);
}

let fetchMock;
let bg;

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ totalTokens: 42 }),
    text: () => Promise.resolve('')
  }));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('M-9: COUNT_TOKENS — таймаут с отменой, debounce, кэш (core/background.js)', () => {
  test('timeout: fetch не резолвится → через 10 с {ok:false, reason:"timeout"} и строка abort', async () => {
    // fetch висит до отмены: уважает signal и реджектит AbortError, как настоящий fetch
    const hanging = jest.fn((url, o) => new Promise((resolve, reject) => {
      const sig = o && o.signal;
      if (sig && sig.aborted) {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        reject(e);
        return;
      }
      if (sig && sig.addEventListener) {
        sig.addEventListener('abort', () => {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          reject(e);
        });
      }
    }));
    bg = loadBackground({ fetch: hanging });

    const p = bg.send({ type: 'COUNT_TOKENS', text: 'таймаут-текст', model: 'gemini-flash-latest' });

    await advance(800);  // истёк debounce → запрос ушёл в сеть
    expect(hanging).toHaveBeenCalledTimes(1);

    await advance(5000); // 5 с — таймаут ещё не наступил
    expect(hanging.mock.calls[0][1].signal.aborted).toBe(false);

    await advance(5000); // суммарно 10 с → abort
    const res = await p;

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('timeout');
    expect(hanging.mock.calls[0][1].signal.aborted).toBe(true);
    // после таймаута кандидаты не перебираются — один запрос и выход
    expect(hanging).toHaveBeenCalledTimes(1);
    expect(bg.logsText()).toContain('[AI CM][countTokens] abort reason=timeout model=gemini-flash-latest');
    // фолбэк content.js: поле error присутствует (аддитивно к reason)
    expect(res.error).toBe('timeout');
  });

  test('debounce: два COUNT_TOKENS по одному ключу через 100 мс → 1 fetch, выполнен второй payload', async () => {
    bg = loadBackground({ fetch: fetchMock });
    const sender = { tab: { id: 7 } };

    const p1 = bg.send({ type: 'COUNT_TOKENS', text: 'первый-payload', model: 'gemini-flash-latest', convId: 'c1' }, sender);
    await advance(100);
    const p2 = bg.send({ type: 'COUNT_TOKENS', text: 'второй-payload', model: 'gemini-flash-latest', convId: 'c1' }, sender);

    await advance(800); // окно второго запроса
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents[0].parts[0].text).toBe('второй-payload');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.totalTokens).toBe(42); // отменённый запрос отвечает результатом выполненного
    expect(r2.totalTokens).toBe(42);
    // строка результата: cached=0, debounced=1 (факт отмены предшествующего запроса)
    expect(bg.logsText()).toContain('cached=0 debounced=1');
  });

  test('cache: одинаковые content+model дважды → 1 fetch, второй ответ cached=1', async () => {
    bg = loadBackground({ fetch: fetchMock });
    const msg = { type: 'COUNT_TOKENS', text: 'кэшируемый-текст', model: 'gemini-flash-latest' };

    const p1 = bg.send(msg);
    await advance(800);
    const r1 = await p1;
    expect(r1.totalTokens).toBe(42);
    expect(r1.cached).toBe(0);

    const r2 = await bg.send(msg); // без прокрутки таймеров: кэш отвечает немедленно
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r2.ok).toBe(true);
    expect(r2.tokens).toBe(42);
    expect(r2.totalTokens).toBe(42);
    expect(r2.cached).toBe(1);
  });

  // M-8 (вшивка A): пробел M-9 — cache-hit отвечал без строки наблюдаемости, и по логам
  // попадание кэша нельзя было отличить от сетевого ответа. Пин: ровно одна строка
  // '[AI CM][countTokens] cache-hit ... cached=1 debounced=0' на пути cache-hit.
  test('M-8: cache-hit пишет строку наблюдаемости (spy console.log)', async () => {
    bg = loadBackground({ fetch: fetchMock });
    const msg = { type: 'COUNT_TOKENS', text: 'cache-hit-наблюдаемость', model: 'gemini-flash-latest' };

    const p1 = bg.send(msg);
    await advance(800);
    await p1; // прогрев кэша — сетевой путь (cached=0), в логе ok-строка

    const spy = jest.spyOn(bg.sandbox.console, 'log');
    const r2 = await bg.send(msg); // попадание: ответ немедленный, сеть не дёргается
    expect(r2.cached).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      '[AI CM][countTokens] cache-hit model=gemini-flash-latest tokens=42 cached=1 debounced=0'
    );
    spy.mockRestore();
  });

  test('ёмкость: 201 различный ключ → size Map ≤ 200 (вытеснение FIFO)', async () => {
    bg = loadBackground({ fetch: fetchMock });
    const pending = [];
    for (let i = 0; i < CACHE_MAX + 1; i++) {
      // Уникальный convId → уникальный debounce-ключ, иначе все 201 схлопнулись бы в одно
      // окно (это покрыто тестом debounce). Здесь проверяем именно ёмкость кэша.
      pending.push(bg.send({
        type: 'COUNT_TOKENS',
        text: 'уникальный-текст-' + i,
        model: 'gemini-flash-latest',
        convId: 'conv-' + i
      }));
    }
    // Одно окно debounce: все запросы уходят в сеть, порядок резолва = порядок вставки в кэш
    await advance(800);
    await Promise.all(pending);
    expect(fetchMock).toHaveBeenCalledTimes(CACHE_MAX + 1); // кэш не мешал уникальным ключам

    const cache = bg.sandbox.countTokensCache;
    expect(cache).toBeInstanceOf(Map);
    expect(cache.size).toBeLessThanOrEqual(CACHE_MAX);
    expect(cache.size).toBe(CACHE_MAX); // 201-я запись вытеснила самую старую
    // FIFO: первый ключ вытеснен, последний — на месте
    expect(cache.has('gemini-flash-latest:' + bg.sandbox.countTokensHash('уникальный-текст-0'))).toBe(false);
    expect(cache.has('gemini-flash-latest:' + bg.sandbox.countTokensHash('уникальный-текст-' + CACHE_MAX))).toBe(true);
  });

  test('разные ключи (разные tabId/convId) не debounce-ятся между собой', async () => {
    bg = loadBackground({ fetch: fetchMock });

    // Разный текст у разных ключей: если бы ключ схлопывал запросы, второй (другой
    // payload) не ушёл бы в сеть вовсе. Ожидаем ровно 2 fetch и ни одной отмены.
    const pA = bg.send({ type: 'COUNT_TOKENS', text: 'текст-таба-A', model: 'gemini-flash-latest', convId: 'conv-A' }, { tab: { id: 1 } });
    await advance(100);
    const pB = bg.send({ type: 'COUNT_TOKENS', text: 'текст-таба-B', model: 'gemini-flash-latest', convId: 'conv-B' }, { tab: { id: 2 } });

    await advance(800);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sentTexts = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).contents[0].parts[0].text);
    expect(sentTexts.sort()).toEqual(['текст-таба-A', 'текст-таба-B']);

    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA.totalTokens).toBe(42);
    expect(rB.totalTokens).toBe(42);
    expect(bg.sandbox.countTokensPending.size).toBe(0); // очередь debounce пуста
    expect(bg.logsText()).not.toContain('debounced=1'); // отмены предшественника не было
  });
});
