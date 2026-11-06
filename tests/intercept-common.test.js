/**
 * R2 (audit-волна 1): setIntervalVisible из utils/intercept-common.js —
 * visibility-гард для страховочных интервалов MAIN-перехватчиков.
 * Тик при 'visible', skip при 'hidden', обход гарда через
 * opts.skipWhenHidden === false, возврат id и очистка clearInterval.
 */
const { loadCommon } = require('./helpers/main-intercept.js');

// Ph2: intercept-common.js — ESM; тестовый мост подставляет swallowSoft,
// делегирующий в window-зеркало debug.js (как и сборка, build.mjs).
const { setIntervalVisible } = loadCommon();

// Step E.2c-B2b-3d (swallowSoft): канал B из utils/debug.js — вне Node-require так же, как swallow.
window.__aiCmSwallowSoft = function () { };

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  });
}

describe('utils/intercept-common.js — setIntervalVisible', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // сброс на дефолт, чтобы тесты не зависели от порядка
    setVisibility('visible');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('тик выполняется, когда вкладка видима', () => {
    setVisibility('visible');
    let count = 0;
    setIntervalVisible(() => { count++; }, 1000);
    jest.advanceTimersByTime(5000);
    expect(count).toBe(5);
  });

  test('skip при скрытой вкладке (hidden — тиков нет)', () => {
    setVisibility('hidden');
    let count = 0;
    setIntervalVisible(() => { count++; }, 1000);
    jest.advanceTimersByTime(5000);
    expect(count).toBe(0);
  });

  test('skipWhenHidden:false игнорирует гард и тикает даже в hidden', () => {
    setVisibility('hidden');
    let count = 0;
    setIntervalVisible(() => { count++; }, 1000, { skipWhenHidden: false });
    jest.advanceTimersByTime(3000);
    expect(count).toBe(3);
  });

  test('возвращает id интервала и clearInterval останавливает тики', () => {
    setVisibility('visible');
    let count = 0;
    const id = setIntervalVisible(() => { count++; }, 1000);
    expect(id).not.toBeUndefined();
    expect(id).not.toBeNull();
    clearInterval(id);
    jest.advanceTimersByTime(5000);
    expect(count).toBe(0);
  });

  test('исключение в теле тика не роняет интервал (тихий catch)', () => {
    setVisibility('visible');
    let count = 0;
    setIntervalVisible(() => { count++; throw new Error('boom'); }, 1000);
    expect(() => jest.advanceTimersByTime(3000)).not.toThrow();
    // тик провалился в try/catch, но исключение не всплыло — таймер жив,
    // тики продолжали вызываться
    expect(count).toBe(3);
  });
});
