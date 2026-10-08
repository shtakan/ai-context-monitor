/**
 * Step E.2c-A: R-D пины канала B — swallowSoft / aiCmDiagWarn + SW-зеркало.
 *
 *   D1 — swallowSoft НЕ вызывает console.error ни при каком гейте;
 *   D2 — гейт выключен: строка уходит в ring, в консоль — ничего;
 *   D3 — гейт включён: ровно одна строка через aiCmDiagLine (console.log) + ring;
 *   D4 — срез-песочница БЕЗ utils/debug.js: вызов не бросает (typeof-гард);
 *   D5 — aiCmDiagWarn: под гейтом ровно один console.warn, вне гейта — ни одного, ring всегда;
 *   R1 — swallow (utils/debug.js:85-90) не изменилась: источник байт-в-байт + поведение;
 *   R2 — SW-зеркало в core/background.js: функции есть, console.error в них нет;
 *   S1 — window.__aiCmSwallowSoft === swallowSoft.
 *
 * Исходник грузится целиком и исполняется косвенным eval как классический скрипт —
 * ровно как в tests/debug.test.js (instrumentation здесь не нужна: пины проверяют
 * поведение, а не покрытие). Мок console — не замена реальной формы, а сама цель
 * пинов D1/D2/D3/D5: проверяется, что хелпер НЕ печатает там, где не должен.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DEBUG_PATH = path.join(ROOT, 'utils', 'debug.js');
const BG_PATH = path.join(ROOT, 'core', 'background.js');
const DEBUG_SRC = fs.readFileSync(DEBUG_PATH, 'utf8');
const BG_SRC = fs.readFileSync(BG_PATH, 'utf8');
const DEBUG_LINES = DEBUG_SRC.split('\n');

const EXPORT_TAIL = `
;globalThis.__aiCmSoftTestApi = {
  swallowSoft: typeof swallowSoft === 'function' ? swallowSoft : null,
  aiCmDiagWarn: typeof aiCmDiagWarn === 'function' ? aiCmDiagWarn : null,
  swallow: typeof swallow === 'function' ? swallow : null,
  diagOn: typeof aiCmDiagOn === 'function' ? aiCmDiagOn : null,
  setDebugLogs: typeof __aiCmSetDebugLogs === 'function' ? __aiCmSetDebugLogs : null,
  getLogRing: typeof __aiCmGetLogRing === 'function' ? __aiCmGetLogRing : null,
  pushLogRing: typeof __aiCmPushLogRing === 'function' ? __aiCmPushLogRing : null
};
`;

(0, eval)(DEBUG_SRC + EXPORT_TAIL);
const Api = globalThis.__aiCmSoftTestApi;

/** Срез объявления функции: от `function <name>(` до закрывающей `}` в колонке 0. */
function fnSlice(src, name) {
  const at = src.indexOf('function ' + name + '(');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end + 2);
}

let consoleLog, consoleWarn, consoleError;

beforeEach(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(function () { });
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(function () { });
  consoleError = jest.spyOn(console, 'error').mockImplementation(function () { });
  globalThis.__aiCmLogRing = [];
  delete globalThis.__aiCmDebugLogs;
  try { window.sessionStorage.clear(); } catch (e) { }
  Api.setDebugLogs(false);
});

afterEach(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
  consoleError.mockRestore();
  globalThis.__aiCmLogRing = [];
  delete globalThis.__aiCmDebugLogs;
  try { window.sessionStorage.clear(); } catch (e) { }
  Api.setDebugLogs(false);
});

function gateOn() {
  try { window.sessionStorage.setItem('aiCmDebug', '1'); } catch (e) { }
}

describe('Step E.2c-A: swallowSoft — канал B', () => {
  test('A1/A2: хелперы объявлены в utils/debug.js и в SW-дубле core/background.js', () => {
    expect(DEBUG_SRC).toContain('function swallowSoft(error, tag) {');
    expect(DEBUG_SRC).toContain('function aiCmDiagWarn(tag, message, detail) {');
    expect(BG_SRC).toContain('function swallowSoft(error, tag) {');
    expect(BG_SRC).toContain('function aiCmDiagWarn(tag, message, detail) {');
  });

  test('D1: console.error не вызывается НИКОГДА (ни вне гейта, ни под гейтом)', () => {
    Api.swallowSoft(new Error('boom'), 'deepseek:parseSSELines');
    gateOn();
    Api.swallowSoft(new Error('boom'), 'deepseek:parseSSELines');
    window.__aiCmDebugLogs = true;
    Api.swallowSoft(new Error('boom'), 'deepseek:parseSSELines');
    expect(consoleError).toHaveBeenCalledTimes(0);
    expect(DEBUG_SRC.slice(DEBUG_SRC.indexOf('function swallowSoft('), DEBUG_SRC.indexOf('\n}', DEBUG_SRC.indexOf('function swallowSoft(')))).not.toMatch(/console\s*\.\s*error/);
  });

  test('D2: гейт выключен → строка в ring, в консоль не печатается ничего', () => {
    Api.swallowSoft(new Error('boom'), 'deepseek:parseSSELines');
    expect(Api.getLogRing()).toEqual(['[swallow-soft][deepseek:parseSSELines] boom']);
    expect(consoleLog).toHaveBeenCalledTimes(0);
    expect(consoleWarn).toHaveBeenCalledTimes(0);
    expect(consoleError).toHaveBeenCalledTimes(0);
  });

  test('D2b: tag по умолчанию — unlabeled; не-Error значение не бросает', () => {
    Api.swallowSoft('строка, а не Error');
    Api.swallowSoft(null);
    expect(Api.getLogRing()).toEqual([
      '[swallow-soft][unlabeled] строка, а не Error',
      '[swallow-soft][unlabeled] null'
    ]);
  });

  test('D3: гейт включён → ровно одна строка через aiCmDiagLine (console.log) + ring', () => {
    gateOn();
    Api.swallowSoft(new Error('boom'), 'demo');
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(consoleLog.mock.calls[0][0]).toBe('[AI CM][diag] swallow-soft tag=demo err=Error: boom');
    expect(consoleWarn).toHaveBeenCalledTimes(0);
    expect(consoleError).toHaveBeenCalledTimes(0);
    expect(Api.getLogRing()).toEqual(['[swallow-soft][demo] boom']);
  });

  test('D3b: второй источник гейта — window.__aiCmDebugLogs === true', () => {
    window.__aiCmDebugLogs = true;
    Api.swallowSoft(new Error('boom'), 'demo');
    expect(consoleLog).toHaveBeenCalledTimes(1);
  });

  test('D4: срез-песочница БЕЗ utils/debug.js — вызов не бросает (typeof-гард)', () => {
    const ctx = vm.createContext({
      console: {
        log: function () { throw new Error('песочница не должна печатать'); },
        warn: function () { throw new Error('песочница не должна печатать'); },
        error: function () { throw new Error('песочница не должна печатать'); }
      }
    });
    vm.runInContext(fnSlice(DEBUG_SRC, 'swallowSoft') +
      '\nthis.refs = [typeof aiCmDiagLine, typeof __aiCmPushLogRing, typeof aiCmDiagOn];' +
      '\nthis.result = swallowSoft(new Error("boom"), "sandbox");', ctx);
    expect(ctx.refs).toEqual(['undefined', 'undefined', 'undefined']);
    expect(ctx.result).toBeUndefined();
  });

  test('D4b: песочница с ring, но без aiCmDiagLine — строка в ring, печати нет', () => {
    const ring = [];
    const ctx = vm.createContext({
      ring: ring,
      __aiCmPushLogRing: function (line) { ring.push(line); }
    });
    vm.runInContext(fnSlice(DEBUG_SRC, 'swallowSoft') +
      '\nthis.result = swallowSoft(new Error("boom"), "sandbox");', ctx);
    expect(ring).toEqual(['[swallow-soft][sandbox] boom']);
    expect(ctx.result).toBeUndefined();
  });

  test('D5: aiCmDiagWarn — вне гейта 0 console.warn, под гейтом ровно 1, ring всегда', () => {
    Api.aiCmDiagWarn('deepseek:emit', 'фрагмент вне белого списка', { type: 'x' });
    expect(consoleWarn).toHaveBeenCalledTimes(0);
    expect(consoleLog).toHaveBeenCalledTimes(0);
    expect(Api.getLogRing()).toEqual(['[ai-cm-warn][deepseek:emit] фрагмент вне белого списка {"type":"x"}']);
    gateOn();
    Api.aiCmDiagWarn('deepseek:emit', 'фрагмент вне белого списка', { type: 'x' });
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn.mock.calls[0][0]).toBe('[AI CM][warn][deepseek:emit] фрагмент вне белого списка');
    expect(consoleWarn.mock.calls[0][1]).toEqual({ type: 'x' });
    expect(consoleError).toHaveBeenCalledTimes(0);
    expect(Api.getLogRing()).toHaveLength(2);
  });

  test('D5b: aiCmDiagWarn без detail — один аргумент и короткая ring-строка', () => {
    gateOn();
    Api.aiCmDiagWarn('pagination', 'потолок достигнут');
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn.mock.calls[0]).toEqual(['[AI CM][warn][pagination] потолок достигнут']);
    expect(Api.getLogRing()).toEqual(['[ai-cm-warn][pagination] потолок достигнут']);
  });

  test('R1: swallow (utils/debug.js:85-90) не изменилась — источник байт-в-байт', () => {
    const pinned = [
      'function swallow(error, tag) {',
      '  try {',
      "    if (typeof debugLog !== 'function') return;   // песочница без utils/debug.js: тихо и без броска",
      "    debugLog('error', '[swallow][' + (tag || 'unlabeled') + ']', error);",
      '  } catch (eSwallow) { /* сам логгер не должен бросать: swallow безопасен всегда */ }',
      '}'
    ].join('\n');
    expect(fnSlice(DEBUG_SRC, 'swallow')).toBe(pinned);
    // Номер строки catch — часть контракта: его построчно пинует tests/fixtures/catch-whitelist.json (:89).
    expect(DEBUG_LINES[84]).toBe('function swallow(error, tag) {');
    expect(DEBUG_LINES[88]).toContain('catch (eSwallow)');
  });

  test('R1b: поведение swallow прежнее — ring + console.error всегда', () => {
    Api.swallow(new Error('boom'), 'deepseek:parseSSELines');
    expect(Api.getLogRing()).toEqual(['[swallow][deepseek:parseSSELines] {}']);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe('[swallow][deepseek:parseSSELines]');
    expect(consoleLog).toHaveBeenCalledTimes(0);
  });

  test('R2: SW-зеркало в core/background.js — есть оба хелпера, console.error нет', () => {
    const swSoft = fnSlice(BG_SRC, 'swallowSoft');
    const swWarn = fnSlice(BG_SRC, 'aiCmDiagWarn');
    expect(swSoft).not.toMatch(/console\s*\.\s*error/);
    expect(swWarn).not.toMatch(/console\s*\.\s*error/);
    expect(swSoft).toContain("typeof debugLog !== 'function'");
    expect(swWarn).toContain("typeof debugLog !== 'function'");
    expect(swSoft).toContain('aiCmHistWinDebugOn');
    expect(swWarn).toContain('aiCmHistWinDebugOn');
    // SW не может звать хелперы utils/debug.js — только свой латч и свой debugLog.
    expect(swSoft).not.toContain('aiCmDiagLine');
    expect(swWarn).not.toContain('aiCmDiagOn');
    expect(swSoft).not.toContain('__aiCmPushLogRing');
    expect(BG_SRC).toContain('var aiCmHistWinDebugOn = false;');
  });

  test('S1: window.__aiCmSwallowSoft === swallowSoft (зеркало, прецедент window.__aiCmSwallow)', () => {
    expect(typeof window.__aiCmSwallowSoft).toBe('function');
    expect(window.__aiCmSwallowSoft).toBe(Api.swallowSoft);
    expect(window.__aiCmSwallow).toBe(Api.swallow);
    expect(DEBUG_SRC).toContain('window.__aiCmSwallowSoft = swallowSoft;');
  });
});
