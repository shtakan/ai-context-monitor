/**
 * R2 (audit-волна 1): setIntervalVisible из utils/intercept-common.ts —
 * visibility-гард для страховочных интервалов MAIN-перехватчиков.
 * Тик при 'visible', skip при 'hidden', обход гарда через
 * opts.skipWhenHidden === false, возврат id и очистка clearInterval.
 */
const { loadCommon } = require('./helpers/main-intercept.js');

// Ph2: intercept-common.ts — ESM; тестовый мост подставляет swallowSoft,
// делегирующий в window-зеркало debug.js (как и сборка, build.mjs).
const { setIntervalVisible, fetchGuarded, isOnFreezeError } = loadCommon();

// Step E.2c-B2b-3d (swallowSoft): канал B из utils/debug.ts — вне Node-require так же, как swallow.
window.__aiCmSwallowSoft = function () { };

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  });
}

describe('utils/intercept-common.ts — setIntervalVisible', () => {
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

/**
 * Живая приёмка 2026-11-09: Chrome синхронно бросает из нативного fetch
 * «Only fetch keepalive is allowed during onfreeze», когда страница уходит в
 * bfcache. Бросок приходил из ДАЛЬНЕГО вызова в обёртке перехватчика и всплывал
 * в консоль uncaught (core/claude-intercept.js). fetchGuarded гасит ровно этот
 * случай, остальные ошибки пробрасывает без изменений.
 */
describe('utils/intercept-common.ts — fetchGuarded (onfreeze)', () => {
  function onfreezeError() {
    return new DOMException(
      'Only fetch keepalive is allowed during onfreeze',
      'InvalidStateError'
    );
  }

  test('isOnFreezeError узнаёт текст Chrome и не трогает чужие ошибки', () => {
    expect(isOnFreezeError(onfreezeError())).toBe(true);
    expect(isOnFreezeError(new Error('Only fetch keepalive is allowed during ONFREEZE'))).toBe(true);
    expect(isOnFreezeError(new Error('Illegal invocation'))).toBe(false);
    expect(isOnFreezeError('network down')).toBe(false);
    expect(isOnFreezeError(null)).toBe(false);
    expect(isOnFreezeError(undefined)).toBe(false);
  });

  test('обычный вызов проходит насквозь: тот же промис, this и аргументы', async () => {
    const marker = Promise.resolve('ok');
    const calls = [];
    const nativeFetch = function (input, init) {
      calls.push({ self: this, input: input, init: init });
      return marker;
    };
    const ctx = { site: 'claude' };
    const out = fetchGuarded(nativeFetch, ctx, ['https://x/api', { method: 'POST' }]);
    expect(out).toBe(marker);
    expect(calls[0].self).toBe(ctx);
    expect(calls[0].input).toBe('https://x/api');
    expect(calls[0].init).toEqual({ method: 'POST' });
    await expect(out).resolves.toBe('ok');
  });

  test('array-like arguments обёртки тоже принимается', async () => {
    function hostFetch() {
      return fetchGuarded(function () {
        return Promise.resolve(Array.prototype.slice.call(arguments));
      }, this, arguments);
    }
    await expect(hostFetch('a', 'b')).resolves.toEqual(['a', 'b']);
  });

  test('onfreeze-бросок не вылетает наружу — возвращается rejected promise', async () => {
    const nativeFetch = function () { throw onfreezeError(); };
    let out;
    expect(() => { out = fetchGuarded(nativeFetch, null, ['https://x']); }).not.toThrow();
    await expect(out).rejects.toThrow(/onfreeze/i);
  });

  test('другая синхронная ошибка по-прежнему пробрасывается (поведение не менялось)', () => {
    const nativeFetch = function () { throw new TypeError('Illegal invocation'); };
    expect(() => fetchGuarded(nativeFetch, null, ['https://x'])).toThrow('Illegal invocation');
  });
});
