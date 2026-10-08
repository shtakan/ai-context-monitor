/**
 * Юнит-тесты utils/debug.js — канонического гейта/логгера проекта.
 *
 * ПОЧЕМУ ИСХОДНИК ГРУЗИТСЯ ЧЕРЕЗ eval, А НЕ require:
 * utils/debug.js не имеет IIFE и module.exports — это классический content-script:
 * объявления (var DEBUG, __aiCmLogRing, function debugLog, …) обязаны попадать в
 * ГЛОБАЛЬНУЮ область того мира, куда файл подключён манифестом. В Node/Jest модульная
 * обёртка (function (exports, require, module, __filename, __dirname) { … }) делает их
 * локальными для модуля и снаружи недостижимыми (require('../utils/debug.js') возвращает
 * пустой объект) — проверено пробой. Поэтому файл читается и исполняется как есть в
 * текущем контексте: работает ровно боевая семантика (глобальные var + замыкание + try/catch
 * вокруг window/sessionStorage/document), а покрытие строк считается по РЕАЛЬНОМУ
 * инструментированному файлу (Jest инструментирует его модульным трансформом, а eval
 * исполняет тот же исходник).
 *
 * Покрываемые группы (карта задачи 1.1 «покрытие core/utils/adapters ≥80%»):
 *   __aiCmStringifyArg, ring-буфер (__aiCmPushLogRing / __aiCmGetLogRing), debugLog,
 *   aiCmDiagOn, aiCmDiagDocKind, aiCmDiagHead, aiCmDiagStack, aiCmDiagLine,
 *   aiCmDiagDownload, aiCmDiagDownloadBlocked, __aiCmSetDebugLogs.
 *
 * Гейты/поведение НЕ меняются: тесты только вызывают функции и читают их вывод.
 */

const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

const DEBUG_PATH = path.join(__dirname, '..', 'utils', 'debug.js');
const DEBUG_SRC = fs.readFileSync(DEBUG_PATH, 'utf8');

// Контракт-страховка: файл обязан остаться классическим скриптом (иначе загрузка и
// покрытие этого теста теряют смысл — сначала ломается семантика MAIN-мира).
if (/^\s*(export|import)\b/m.test(DEBUG_SRC)) {
  throw new Error('utils/debug.js перестал быть классическим скриптом (ESM?)');
}

// Экспорт-хвост ТОЛЬКО для теста. В файле его нет и быть не должно — добавляется
// на лету, к боевому исходнику не прикасаемся.
const EXPORT_TAIL = `
;globalThis.__aiCmDebugTestApi = {
  setDebugLogs: __aiCmSetDebugLogs,
  stringifyArg: __aiCmStringifyArg,
  pushLogRing: __aiCmPushLogRing,
  getLogRing: __aiCmGetLogRing,
  debugLog: debugLog,
  swallow: swallow,
  diagOn: aiCmDiagOn,
  diagDocKind: aiCmDiagDocKind,
  diagHead: aiCmDiagHead,
  diagStack: aiCmDiagStack,
  diagLine: aiCmDiagLine,
  diagDownload: aiCmDiagDownload,
  diagDownloadBlocked: aiCmDiagDownloadBlocked
};
`;

// Прямой (indirect) eval: код исполняется в глобальной области, поэтому var/function
// объявления файла становятся глобальными — ровно как при подключении content-script.
// Перед исполнением исходник инструментируется istanbul (тот же инструментатор, что несёт
// Jest): глобального __coverage__ у рантайма jest для НЕ-модульного (eval) кода нет, поэтому
// счётчики этого файла иначе не попали бы в отчёт покрытия. Инструментируется ТОЛЬКО
// тестовый экземпляр — боевой utils/debug.js не меняется.
if (!globalThis.__coverage__) globalThis.__coverage__ = {};
const instrumenter = createInstrumenter({
  coverageVariable: '__coverage__',
  esModules: false,
  compact: false,
  produceSourceMap: false,
  autoWrap: true,
  preserveComments: true
});
const INSTRUMENTED_SRC = instrumenter.instrumentSync(DEBUG_SRC + EXPORT_TAIL, DEBUG_PATH);
(0, eval)(INSTRUMENTED_SRC);

const Api = globalThis.__aiCmDebugTestApi;

let savedLocation;
let savedTextDecoder;
let consoleLog;
let consoleWarn;
let consoleError;
let consoleInfo;

// jsdom-глобал location — accessor без сеттера: обычное присваивание молча теряется
// (проверено пробой), поэтому подменяем/снимаем его через defineProperty/delete.
function setLocation(value) {
  Object.defineProperty(globalThis, 'location', {
    value: value,
    configurable: true,
    writable: true,
    enumerable: true
  });
}

function dropLocation() {
  delete globalThis.location;
}

function restoreLocation() {
  if (savedLocation === undefined) dropLocation();
  else setLocation(savedLocation);
}

beforeAll(() => {
  savedLocation = globalThis.location;
  savedTextDecoder = globalThis.TextDecoder;
});

afterAll(() => {
  restoreLocation();
  if (savedTextDecoder === undefined) delete globalThis.TextDecoder;
  else globalThis.TextDecoder = savedTextDecoder;
});

beforeEach(() => {
  // Сброс рантайм-состояния модуля между тестами (флаг, ring-буфер, гейт, window-флаг).
  Api.setDebugLogs(false);
  try { globalThis.__aiCmLogRing = []; } catch (e) { /* ring пересоздан */ }
  delete globalThis.__aiCmDebugLogs;
  try { window.sessionStorage.clear(); } catch (e) { /* sessionStorage недоступен */ }
  restoreLocation();

  consoleLog = jest.spyOn(console, 'log').mockImplementation(function () { });
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(function () { });
  consoleError = jest.spyOn(console, 'error').mockImplementation(function () { });
  consoleInfo = jest.spyOn(console, 'info').mockImplementation(function () { });
});

afterEach(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
  consoleError.mockRestore();
  consoleInfo.mockRestore();
  restoreLocation();
  try { window.sessionStorage.clear(); } catch (e) { /* sessionStorage недоступен */ }
  delete globalThis.__aiCmDebugLogs;
  Api.setDebugLogs(false);
});

// =====================================================================================
// __aiCmSetDebugLogs — флаг отладки и window-зеркало
// =====================================================================================
describe('utils/debug.js: __aiCmSetDebugLogs — флаг и window-зеркало', () => {
  test('true включает флаг и зеркалит window.__aiCmDebugLogs', () => {
    Api.setDebugLogs(true);
    expect(window.__aiCmDebugLogs).toBe(true);
    Api.setDebugLogs(false);
    expect(window.__aiCmDebugLogs).toBe(false);
  });

  test('значение приводится к boolean (!!v)', () => {
    Api.setDebugLogs('1');
    expect(window.__aiCmDebugLogs).toBe(true);
    Api.setDebugLogs(0);
    expect(window.__aiCmDebugLogs).toBe(false);
  });
});

// =====================================================================================
// __aiCmStringifyArg — приведение аргумента лога к строке
// =====================================================================================
describe('utils/debug.js: __aiCmStringifyArg', () => {
  test('строка возвращается как есть (без кавычек и JSON.stringify)', () => {
    expect(Api.stringifyArg('простой текст')).toBe('простой текст');
    expect(Api.stringifyArg('')).toBe('');
    expect(Api.stringifyArg('{"a":1}')).toBe('{"a":1}');
  });

  test('объект сериализуется через JSON.stringify', () => {
    expect(Api.stringifyArg({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(Api.stringifyArg([1, 2, 3])).toBe('[1,2,3]');
    expect(Api.stringifyArg(null)).toBe('null');
    expect(Api.stringifyArg(42)).toBe('42');
    expect(Api.stringifyArg(true)).toBe('true');
  });

  test('JSON.stringify вернул undefined (функция/символ) → String(arg)', () => {
    const fn = function named() { };
    expect(Api.stringifyArg(fn)).toBe(String(fn));
    expect(Api.stringifyArg(Symbol('s'))).toBe(String(Symbol('s')));
  });

  test('строка длиннее 500 символов обрезается и получает «…»', () => {
    const long = 'a'.repeat(700);
    const out = Api.stringifyArg(long);
    // Строки резак не трогает (ранний return) — проверяем через объект, чей JSON длиннее 500.
    expect(out).toBe(long);

    const outObj = Api.stringifyArg({ k: 'b'.repeat(700) });
    expect(outObj.length).toBe(501);
    expect(outObj.endsWith('…')).toBe(true);
    expect(outObj.slice(0, 500)).toBe(JSON.stringify({ k: 'b'.repeat(700) }).slice(0, 500));
  });

  test('ровно 500 символов НЕ обрезается (граница строго >500)', () => {
    // JSON объекта {"k":"<498 симв>"} ровно 500 символов
    const json500 = JSON.stringify({ k: 'c'.repeat(492) });
    expect(json500.length).toBe(500);
    expect(Api.stringifyArg(JSON.parse(json500))).toBe(json500);
  });

  test('циклическая ссылка → String(arg) из catch-блока', () => {
    const cyc = { name: 'cyc' };
    cyc.self = cyc;
    expect(Api.stringifyArg(cyc)).toBe(String(cyc));
  });

  test('BigInt внутри объекта → String(arg) из catch-блока (JSON.stringify бросает)', () => {
    const withBig = { n: 1n };
    expect(Api.stringifyArg(withBig)).toBe(String(withBig));
  });
});

// =====================================================================================
// Ring-буфер: __aiCmPushLogRing / __aiCmGetLogRing
// =====================================================================================
describe('utils/debug.js: ring-буфер логов (≤200 строк, FIFO)', () => {
  test('push добавляет строку в массив; getLogRing отдаёт накопленное', () => {
    Api.pushLogRing('первая');
    Api.pushLogRing('вторая');
    expect(Api.getLogRing()).toEqual(['первая', 'вторая']);
  });

  test('на 200 элементах ещё ничего не вытесняется', () => {
    for (let i = 0; i < 200; i++) Api.pushLogRing('line-' + i);
    const ring = Api.getLogRing();
    expect(ring).toHaveLength(200);
    expect(ring[0]).toBe('line-0');
    expect(ring[199]).toBe('line-199');
  });

  test('при >200 элементах shift удаляет самый старый (FIFO): 260 push → 200 строк, голова сдвинута на 60', () => {
    for (let i = 0; i < 260; i++) Api.pushLogRing('line-' + i);
    const ring = Api.getLogRing();
    expect(ring).toHaveLength(200);
    expect(ring[0]).toBe('line-60');
    expect(ring[199]).toBe('line-259');
    expect(ring).not.toContain('line-59');
  });

  test('getLogRing возвращает КОПИЮ: мутация копии не влияет на оригинал', () => {
    Api.pushLogRing('оригинал');
    const copy = Api.getLogRing();
    copy.push('мусор');
    copy[0] = 'перезаписано';
    expect(Api.getLogRing()).toEqual(['оригинал']);
  });

  test('не-строки буфер принимает как есть (вызовы debugLog всегда дают строку)', () => {
    Api.pushLogRing(123);
    expect(Api.getLogRing()).toEqual([123]);
  });

  test('пустой буфер → пустой массив (без обращений к несуществующим элементам)', () => {
    expect(Api.getLogRing()).toEqual([]);
  });
});

// =====================================================================================
// debugLog — уровни и гейт
// =====================================================================================
describe('utils/debug.js: debugLog — warn/error всегда, log/info только при DEBUG', () => {
  test("level='error' → console.error вызывается ВСЕГДА (даже при выключенном DEBUG)", () => {
    Api.setDebugLogs(false);
    Api.debugLog('error', 'провал', { code: 1 });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('провал', { code: 1 });
    expect(consoleLog).not.toHaveBeenCalled();
  });

  test("level='warn' → console.warn вызывается ВСЕГДА (даже при выключенном DEBUG)", () => {
    Api.setDebugLogs(false);
    Api.debugLog('warn', 'предупреждение');
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith('предупреждение');
    expect(consoleLog).not.toHaveBeenCalled();
  });

  test("level='log' при DEBUG=false → console.log НЕ вызывается", () => {
    Api.setDebugLogs(false);
    Api.debugLog('log', 'тихий лог');
    expect(consoleLog).not.toHaveBeenCalled();
  });

  test("level='log' при DEBUG=true (через __aiCmSetDebugLogs) → console.log вызывается", () => {
    Api.setDebugLogs(true);
    Api.debugLog('log', 'громкий лог', 7);
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith('громкий лог', 7);
  });

  test("level='info' подчиняется тому же правилу, что 'log'", () => {
    Api.setDebugLogs(false);
    Api.debugLog('info', 'инфо выкл');
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();

    Api.setDebugLogs(true);
    Api.debugLog('info', 'инфо вкл');
    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(consoleInfo).toHaveBeenCalledWith('инфо вкл');
  });

  test("известный уровень 'debug' при DEBUG=true печатается своим методом console.debug", () => {
    const consoleDebug = jest.spyOn(console, 'debug').mockImplementation(function () { });
    Api.setDebugLogs(true);
    Api.debugLog('debug', 'отладка');
    expect(consoleDebug).toHaveBeenCalledWith('отладка');
    consoleDebug.mockRestore();
  });

  test("неизвестный level при DEBUG=true падает на console.log (фолбэк console[level] || console.log)", () => {
    const consoleTrace = jest.spyOn(console, 'trace').mockImplementation(function () { });
    Api.setDebugLogs(true);
    Api.debugLog('trace', 'трассировка');
    // console.trace существует → уходит ИМЕННО в него, а не в console.log
    expect(consoleTrace).toHaveBeenCalledWith('трассировка');
    expect(consoleLog).not.toHaveBeenCalled();
    consoleTrace.mockRestore();
  });

  test('window.__aiCmDebugLogs === true включает вывод, даже если DEBUG сброшен', () => {
    Api.setDebugLogs(false);
    window.__aiCmDebugLogs = true;              // чекбокс «Подробные логи» из другого мира
    Api.debugLog('log', 'через window-флаг');
    expect(consoleLog).toHaveBeenCalledWith('через window-флаг');
  });

  test('каждый вызов debugLog добавляет строку в ring-буфер (аргументы через пробел)', () => {
    Api.setDebugLogs(false);
    Api.debugLog('log', 'строка', { a: 1 }, 42);
    Api.debugLog('error', 'ошибка', 'код');
    expect(Api.getLogRing()).toEqual(['строка {"a":1} 42', 'ошибка код']);
  });

  test('debugLog не падает на циклическом аргументе и всё равно кладёт строку в ring', () => {
    const cyc = { x: 1 };
    cyc.loop = cyc;
    expect(() => Api.debugLog('log', cyc)).not.toThrow();
    expect(Api.getLogRing()).toHaveLength(1);
  });
});

// =====================================================================================
// aiCmDiagOn — единый гейт инструментирования
// =====================================================================================
describe('utils/debug.js: aiCmDiagOn — гейт aiCmDebug', () => {
  test("sessionStorage.getItem('aiCmDebug') === '1' → true", () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    delete window.__aiCmDebugLogs;
    expect(Api.diagOn()).toBe(true);
  });

  test('sessionStorage с другим значением гейт не открывает', () => {
    window.sessionStorage.setItem('aiCmDebug', '0');
    delete window.__aiCmDebugLogs;
    expect(Api.diagOn()).toBe(false);
  });

  test('window.__aiCmDebugLogs === true → true (без sessionStorage)', () => {
    window.sessionStorage.clear();
    window.__aiCmDebugLogs = true;
    expect(Api.diagOn()).toBe(true);
  });

  test('window.__aiCmDebugLogs === "true" (строка) гейт НЕ открывает — строгое === true', () => {
    window.sessionStorage.clear();
    window.__aiCmDebugLogs = 'true';
    expect(Api.diagOn()).toBe(false);
  });

  test('оба выключены → false', () => {
    window.sessionStorage.clear();
    delete window.__aiCmDebugLogs;
    expect(Api.diagOn()).toBe(false);
  });

  test('sessionStorage бросает (недоступен) → fallback на window.__aiCmDebugLogs', () => {
    // jsdom-хранилище — Proxy без подменяемых методов: getItem бросает через свойство самого объекта
    const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: function () {
        return {
          getItem: function () { throw new Error('SecurityError: storage disabled'); }
        };
      }
    });
    try {
      window.__aiCmDebugLogs = true;
      expect(Api.diagOn()).toBe(true);

      delete window.__aiCmDebugLogs;
      expect(Api.diagOn()).toBe(false);
    } finally {
      if (realStorage) Object.defineProperty(globalThis, 'sessionStorage', realStorage);
    }
  });
});

// =====================================================================================
// aiCmDiagDocKind — тип документа для логов сброса состояния
// =====================================================================================
describe('utils/debug.js: aiCmDiagDocKind — captcha / chat / search', () => {
  function setLocation(href, hostname) {
    Object.defineProperty(globalThis, 'location', {
      value: { href: href, hostname: hostname, host: hostname },
      configurable: true,
      writable: true,
      enumerable: true
    });
  }

  test("location.href содержит '/sorry/' → 'captcha'", () => {
    setLocation('https://www.google.com/sorry/index?continue=x', 'www.google.com');
    expect(Api.diagDocKind()).toBe('captcha');
  });

  test("document.querySelector('#captcha-form') на google-хосте → 'captcha'", () => {
    setLocation('https://www.google.com/search?q=x', 'www.google.com');
    document.body.innerHTML = '<form id="captcha-form"></form>';
    expect(Api.diagDocKind()).toBe('captcha');
  });

  test("форма с action*=sorry на google-хосте → 'captcha'", () => {
    setLocation('https://google.com/search?q=x', 'google.com');
    document.body.innerHTML = '<form action="/sorry/index"></form>';
    expect(Api.diagDocKind()).toBe('captcha');
  });

  test("iframe recaptcha на google-хосте → 'captcha'", () => {
    setLocation('https://google.com/search?q=x', 'google.com');
    document.body.innerHTML = '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>';
    expect(Api.diagDocKind()).toBe('captcha');
  });

  test("document.querySelector('[data-session-thread-id]') → 'chat'", () => {
    setLocation('https://www.google.com/search?q=x', 'www.google.com');
    document.body.innerHTML = '<div data-session-thread-id="abc-123"></div>';
    expect(Api.diagDocKind()).toBe('chat');
  });

  test("узел [data-session-thread-id] с пустым значением → 'search' (не chat)", () => {
    setLocation('https://google.com/search?q=x', 'google.com');
    document.body.innerHTML = '<div data-session-thread-id="   "></div>';
    expect(Api.diagDocKind()).toBe('search');
  });

  test("[data-scope-id=\"turn\"] без thread-id → 'chat'", () => {
    setLocation('https://google.com/search?q=x', 'google.com');
    document.body.innerHTML = '<div data-scope-id="turn"></div>';
    expect(Api.diagDocKind()).toBe('chat');
  });

  test("[data-subtree=\"aimfl\"] без thread-id → 'chat'", () => {
    setLocation('https://google.com/search?q=x', 'google.com');
    document.body.innerHTML = '<div data-subtree="aimfl"></div>';
    expect(Api.diagDocKind()).toBe('chat');
  });

  test("host === 'google.com' без captcha и без признаков чата → 'search'", () => {
    setLocation('https://google.com/search?q=x', 'google.com');
    document.body.innerHTML = '';
    expect(Api.diagDocKind()).toBe('search');
  });

  test("host === 'www.google.com' без признаков → 'search'", () => {
    setLocation('https://www.google.com/search?q=x', 'www.google.com');
    document.body.innerHTML = '';
    expect(Api.diagDocKind()).toBe('search');
  });

  test("не-google хост без признаков → fallback 'chat'", () => {
    setLocation('https://chat.qwen.ai/c/abc', 'chat.qwen.ai');
    document.body.innerHTML = '';
    expect(Api.diagDocKind()).toBe('chat');
  });

  test('location недоступен (throw) → пустые href/host, fallback chat', () => {
    setLocation({
      get href() { throw new Error('no location'); },
      get hostname() { throw new Error('no location'); }
    });
    document.body.innerHTML = '';
    expect(Api.diagDocKind()).toBe('chat');
  });

  test('document.querySelector бросает → исключение проглатывается, host решает исход', () => {
    setLocation('https://google.com/search?q=x', 'google.com');
    const qs = jest.spyOn(document, 'querySelector').mockImplementation(function () {
      throw new Error('document unavailable');
    });
    expect(Api.diagDocKind()).toBe('search');
    qs.mockRestore();
  });
});

// =====================================================================================
// aiCmDiagHead — голова строки/базы одной строкой
// =====================================================================================
describe('utils/debug.js: aiCmDiagHead — превью значения', () => {
  test('undefined/null → «(пусто)»', () => {
    expect(Api.diagHead(undefined)).toBe('(пусто)');
    expect(Api.diagHead(null)).toBe('(пусто)');
    expect(Api.diagHead(undefined, 10)).toBe('(пусто)');
  });

  test('пустая строка → «(пусто)»', () => {
    expect(Api.diagHead('')).toBe('(пусто)');
  });

  test('строка из пробелов/переводов строк → «(пусто/пробелы)»', () => {
    expect(Api.diagHead('   ')).toBe('(пусто/пробелы)');
    expect(Api.diagHead('\n\t  \r\n')).toBe('(пусто/пробелы)');
  });

  test('переводы строк схлопываются в один пробел, края обрезаются', () => {
    expect(Api.diagHead('  первая\nвторая\tтретья  ')).toBe('первая вторая третья');
  });

  test('строка длиннее 100 символов обрезается и получает «…»', () => {
    const long = 'я'.repeat(150);
    const out = Api.diagHead(long);
    expect(out).toBe('я'.repeat(100) + '…');
  });

  test('ровно 100 символов НЕ обрезается (граница строго >lim)', () => {
    const exactly = 'z'.repeat(100);
    expect(Api.diagHead(exactly)).toBe(exactly);
  });

  test('кастомный n обрезает по n', () => {
    expect(Api.diagHead('abcdefghij', 4)).toBe('abcd…');
    expect(Api.diagHead('abcdefghij', 10)).toBe('abcdefghij');
  });

  test('невалидный n (0, отрицательный, не-число) → дефолтные 100', () => {
    expect(Api.diagHead('x'.repeat(120), 0)).toBe('x'.repeat(100) + '…');
    expect(Api.diagHead('x'.repeat(120), -5)).toBe('x'.repeat(100) + '…');
    expect(Api.diagHead('x'.repeat(120), '3')).toBe('x'.repeat(100) + '…');
    expect(Api.diagHead('x'.repeat(120), null)).toBe('x'.repeat(100) + '…');
  });

  test('не-строка приводится через String', () => {
    expect(Api.diagHead(12345)).toBe('12345');
    expect(Api.diagHead({ a: 1 })).toBe('[object Object]');
  });

  test('исключение при приведении → «(ошибка)»', () => {
    const bad = {
      toString: function () { throw new Error('toString сломан'); }
    };
    expect(Api.diagHead(bad)).toBe('(ошибка)');
  });
});

// =====================================================================================
// aiCmDiagStack — источник вызова
// =====================================================================================
describe('utils/debug.js: aiCmDiagStack — кадры стека', () => {
  test('skip=0 пропускает 1 кадр (сам вызов) и НЕ содержит собственных кадров aiCmDiag', () => {
    const st = Api.diagStack(0);
    expect(typeof st).toBe('string');
    expect(st.length).toBeGreaterThan(0);
    expect(st).not.toContain('aiCmDiag');
  });

  test('skip=2 пропускает 3 кадра — результат отличается от skip=0', () => {
    const st0 = Api.diagStack(0);
    const st2 = Api.diagStack(2);
    expect(typeof st2).toBe('string');
    expect(st2).not.toBe(st0);
  });

  test('фильтрует кадры, содержащие aiCmDiag (на любой глубине)', () => {
    const deep = Api.diagStack(0);
    expect(deep.indexOf('aiCmDiag')).toBe(-1);
  });

  test('не более 4 кадров — максимум 3 разделителя " <- "', () => {
    const st = Api.diagStack(0);
    const frames = st ? st.split(' <- ') : [];
    expect(frames.length).toBeLessThanOrEqual(4);
  });

  test('skip больше глубины стека → пустая строка (без исключения)', () => {
    expect(Api.diagStack(9999)).toBe('');
  });

  test('skip не-число/отрицательный трактуется как 0 (та же ГЛУБИНА кадров)', () => {
    // Сравнивать строки нельзя: в каждой строке свой номер строки вызова. Сравниваем
    // количество кадров и то, что кадр вызывающего теста (не внутренний) присутствует.
    const countFrames = function (st) { return st ? st.split(' <- ').length : 0; };
    const base = Api.diagStack(0);
    expect(base).toContain('tests');
    expect(countFrames(Api.diagStack('нет'))).toBe(countFrames(base));
    expect(countFrames(Api.diagStack(-3))).toBe(countFrames(base));
    expect(countFrames(Api.diagStack(null))).toBe(countFrames(base));
  });

  test('все кадры — однострочные (переводы строк схлопнуты)', () => {
    const st = Api.diagStack(0);
    expect(st).not.toContain('\n');
  });
});

// =====================================================================================
// aiCmDiagLine — печать строки диагностики
// =====================================================================================
describe('utils/debug.js: aiCmDiagLine — печать под гейтом', () => {
  test('гейт выключен → return false, console.log НЕ вызывается', () => {
    window.sessionStorage.clear();
    delete window.__aiCmDebugLogs;
    expect(Api.diagLine('tag', { a: 1 })).toBe(false);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  test('гейт включён → return true и формат «[AI CM][diag] tag key=value»', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    expect(Api.diagLine('download', { trigger: 'manual', len: 42 })).toBe(true);
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith('[AI CM][diag] download trigger=manual len=42');
  });

  test('null/undefined значения полей печатаются как «(нет)»', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagLine('reset', { convId: null, threadId: undefined, site: '' });
    expect(consoleLog).toHaveBeenCalledWith('[AI CM][diag] reset convId=(нет) threadId=(нет) site=');
  });

  test('fields отсутствуют/не объект → печатается только tag (пустой хвост)', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagLine('только-тег');
    expect(consoleLog).toHaveBeenCalledWith('[AI CM][diag] только-тег ');
  });

  test('собственные поля объекта печатаются, унаследованные — нет', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    const proto = { inherited: 'нет' };
    const fields = Object.create(proto);
    fields.own = 'да';
    Api.diagLine('proto', fields);
    expect(consoleLog).toHaveBeenCalledWith('[AI CM][diag] proto own=да');
  });

  test('значения приводятся через String (числа и объекты)', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagLine('types', { n: 3, b: false, o: { a: 1 } });
    expect(consoleLog).toHaveBeenCalledWith('[AI CM][diag] types n=3 b=false o=[object Object]');
  });

  test('гейт открыт через window-флаг (без sessionStorage) — тот же формат', () => {
    window.__aiCmDebugLogs = true;
    expect(Api.diagLine('win', { k: 'v' })).toBe(true);
    expect(consoleLog).toHaveBeenCalledWith('[AI CM][diag] win k=v');
  });
});

// =====================================================================================
// aiCmDiagDownload / aiCmDiagDownloadBlocked — единые точки лога скачивания
// =====================================================================================
describe('utils/debug.js: aiCmDiagDownload', () => {
  beforeEach(() => {
    setLocation({ href: 'https://chat.qwen.ai/c/abc', hostname: 'chat.qwen.ai' });
  });

  test('гейт выключен → return false, ни одной строки', () => {
    window.sessionStorage.clear();
    delete window.__aiCmDebugLogs;
    expect(Api.diagDownload('manual', 'база', 'file.txt', {})).toBe(false);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  test('гейт включён → return true, строка download с полями trigger/file/url', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    expect(Api.diagDownload('autoexport', 'тело базы', 'chat.txt', {
      mime: 'text/plain', threadId: 'abc', site: 'qwen', reason: 'timer'
    })).toBe(true);

    const line = consoleLog.mock.calls[0][0];
    expect(line).toContain('[AI CM][diag] download ');
    expect(line).toContain('trigger=autoexport');
    expect(line).toContain('file=chat.txt');
    expect(line).toContain('bytes100=тело базы');
    expect(line).toContain('len=9');
    expect(line).toContain('mime=text/plain');
    expect(line).toContain('url=https://chat.qwen.ai/c/abc');
    expect(line).toContain('threadId=abc');
    expect(line).toContain('site=qwen');
    expect(line).toContain('reason=timer');
    expect(line).toContain('src=');
  });

  test('пустое/отсутствующее fileName → «пустое» (пустая строка и null)', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagDownload('manual', 'база', '', {});
    expect(consoleLog.mock.calls[0][0]).toContain('file=пустое');

    consoleLog.mockClear();
    Api.diagDownload('manual', 'база', null, {});
    expect(consoleLog.mock.calls[0][0]).toContain('file=пустое');

    consoleLog.mockClear();
    Api.diagDownload('manual', 'база', undefined, {});
    expect(consoleLog.mock.calls[0][0]).toContain('file=пустое');
  });

  test('trigger не задан → «(нет)»', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagDownload('', 'база', 'f.txt', {});
    expect(consoleLog.mock.calls[0][0]).toContain('trigger=(нет)');
  });

  test('undefined content → len=0 и bytes100=(пусто)', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagDownload('manual', undefined, 'f.txt', {});
    const line = consoleLog.mock.calls[0][0];
    expect(line).toContain('len=0');
    expect(line).toContain('bytes100=(пусто)');
  });

  test('null content → len=0 (не «4»)', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagDownload('manual', null, 'f.txt', {});
    expect(consoleLog.mock.calls[0][0]).toContain('len=0');
  });

  test('extra не задан → поля mime/threadId/site/reason = «(нет)», падения нет', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    expect(Api.diagDownload('manual', 'база', 'f.txt')).toBe(true);
    const line = consoleLog.mock.calls[0][0];
    expect(line).toContain('mime=(нет)');
    expect(line).toContain('threadId=(нет)');
    expect(line).toContain('site=(нет)');
  });

  test('location недоступен → url пустой, строка всё равно печатается', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    setLocation({ get href() { throw new Error('no location'); } });
    expect(Api.diagDownload('manual', 'база', 'f.txt', {})).toBe(true);
    expect(consoleLog.mock.calls[0][0]).toContain('url= ');
  });
});

describe('utils/debug.js: aiCmDiagDownloadBlocked', () => {
  beforeEach(() => {
    setLocation({ href: 'https://www.google.com/sorry/index', hostname: 'www.google.com' });
  });

  test('гейт выключен → return false, ни одной строки', () => {
    window.sessionStorage.clear();
    delete window.__aiCmDebugLogs;
    expect(Api.diagDownloadBlocked('autoexport', ')]}\'', '', 'xssi-prefix', {})).toBe(false);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  test('гейт включён → return true, reason идёт ПЕРВЫМ полем после тега', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    expect(Api.diagDownloadBlocked('autoexport', ")]}'\n[\"\"]", 'f.txt', 'xssi-prefix', {})).toBe(true);

    const line = consoleLog.mock.calls[0][0];
    expect(line).toContain('[AI CM][diag] download-blocked ');
    expect(line).toContain('reason=xssi-prefix trigger=autoexport');
    expect(line.indexOf('reason=')).toBeLessThan(line.indexOf('trigger='));
    expect(line).toContain('file=f.txt');
    expect(line).toContain('url=https://www.google.com/sorry/index');
    expect(line).toContain('src=');
  });

  test('reason не задан → «(нет)», но по-прежнему первым полем', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagDownloadBlocked('autoexport', 'база', 'f.txt', '', {});
    const line = consoleLog.mock.calls[0][0];
    expect(line).toContain('reason=(нет) trigger=autoexport');
  });

  test('пустое fileName → «пустое» (живой путь автоэкспорта на captcha)', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagDownloadBlocked('autoexport', 'база', '', 'empty-name', {});
    expect(consoleLog.mock.calls[0][0]).toContain('file=пустое');
  });

  test('undefined content → len=0 и bytes100=(пусто)', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    Api.diagDownloadBlocked('autoexport', undefined, 'f.txt', 'empty-name', {});
    const line = consoleLog.mock.calls[0][0];
    expect(line).toContain('len=0');
    expect(line).toContain('bytes100=(пусто)');
  });

  test('extra не задан → падения нет, поля = «(нет)»', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    expect(Api.diagDownloadBlocked('autoexport', 'база', 'f.txt', 'empty-name')).toBe(true);
    const line = consoleLog.mock.calls[0][0];
    expect(line).toContain('mime=(нет)');
    expect(line).toContain('threadId=(нет)');
    expect(line).toContain('site=(нет)');
  });

  test('location недоступен → url пустой, строка печатается', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    setLocation({ get href() { throw new Error('no location'); } });
    expect(Api.diagDownloadBlocked('autoexport', 'база', 'f.txt', 'empty-name', {})).toBe(true);
    expect(consoleLog.mock.calls[0][0]).toContain('url= ');
  });
});

// =====================================================================================
// swallow(error, tag) — Step E.2a: молчаливый catch → диагностируемый, поток не меняется
// =====================================================================================
describe('utils/debug.js: swallow — тонкая обёртка над debugLog(error)', () => {
  test('пишет строку с тегом в ring и в console.error ВСЕГДА (DEBUG выключен)', () => {
    Api.setDebugLogs(false);
    expect(Api.swallow(new Error('boom'), 'deepseek:parseSSELines')).toBeUndefined();

    expect(consoleError).toHaveBeenCalledTimes(1);
    const args = consoleError.mock.calls[0];
    expect(args[0]).toBe('[swallow][deepseek:parseSSELines]');
    expect(args[1]).toBeInstanceOf(Error);

    const ring = Api.getLogRing();
    expect(ring[ring.length - 1]).toContain('[swallow][deepseek:parseSSELines]');
    // Error в ring даёт '{}' — существующая семантика __aiCmStringifyArg (JSON.stringify);
    // в console.error объект уходит как есть (стек сохраняется). E.2a это не меняет.
    expect(ring[ring.length - 1]).toBe('[swallow][deepseek:parseSSELines] {}');
  });

  test('тег не задан → unlabeled; возврат undefined и без броска', () => {
    expect(Api.swallow(new Error('x'))).toBeUndefined();
    expect(consoleError.mock.calls[0][0]).toBe('[swallow][unlabeled]');
  });

  test('typeof-гард: без debugLog (срез-песочница) вызов тихий, без ReferenceError', () => {
    const saved = globalThis.debugLog;
    try {
      delete globalThis.debugLog;
      expect(typeof globalThis.debugLog).toBe('undefined');
      expect(Api.swallow(new Error('silent'), 'deepseek:xhr-load')).toBeUndefined();
    } finally {
      globalThis.debugLog = saved;
    }
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('битый логгер не пробрасывает исключение в исходный catch', () => {
    const saved = globalThis.debugLog;
    try {
      globalThis.debugLog = function () { throw new Error('logger broken'); };
      expect(() => Api.swallow(new Error('e'), 'deepseek:fetch-url')).not.toThrow();
    } finally {
      globalThis.debugLog = saved;
    }
  });

  test('window-зеркало __aiCmSwallow указывает на тот же хелпер', () => {
    expect(typeof window.__aiCmSwallow).toBe('function');
    expect(window.__aiCmSwallow).toBe(Api.swallow);
  });
});

// =====================================================================================
// Локальный дубль в SW (Step E.2a): importScripts в MV3 non-module SW невозможен,
// поэтому core/background.js несёт свою копию хелпера — контракт тот же, но БЕЗ
// console.error: core/ сканируется tests/no-bare-console-error.test.js.
// =====================================================================================
describe('core/background.js: локальный дубль swallow для Service Worker', () => {
  const BG_PATH = path.join(__dirname, '..', 'core', 'background.js');
  const BG_SRC = fs.readFileSync(BG_PATH, 'utf8');
  const declAt = BG_SRC.indexOf('function swallow(');
  const SW_BODY = declAt > -1 ? BG_SRC.slice(declAt, BG_SRC.indexOf('\n}', declAt)) : '';

  test('объявлен сразу после локального debugLog и повторяет контракт контент-версии', () => {
    const dlAt = BG_SRC.indexOf('function debugLog(level)');
    expect(dlAt).toBeGreaterThan(-1);
    expect(declAt).toBeGreaterThan(dlAt);
    expect(SW_BODY).toContain("typeof debugLog !== 'function'");
    expect(SW_BODY).toContain("'[swallow][' + (tag || 'unlabeled') + ']'");
    expect(SW_BODY).toContain("debugLog('error'");
  });

  test('в SW-дубле нет bare console.error (иначе падает no-bare-console-error)', () => {
    expect(SW_BODY).not.toMatch(/console\s*\.\s*error/);
  });
});
