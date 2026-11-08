'use strict';
/**
 * M2 (QUALITY_AUDIT): страховочные setInterval в перехватчиках не должны
 * поллить в скрытой вкладке.
 *
 * Гард реализован в utils/intercept-common.ts::setIntervalVisible (tick только
 * при document.visibilityState === 'visible'), перехватчики используют его через
 * `var aiCmPoll = setIntervalVisible`. Здесь проверяется поведение гарда:
 * фейковые таймеры + подмена visibilityState — как в проде, без чтения исходника.
 */

const { loadCommon } = require('./helpers/main-intercept');

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: function () {
      return state;
    },
  });
}

describe('M2: visibility-гард страховочного поллинга', function () {
  let setIntervalVisible;

  beforeEach(function () {
    jest.useFakeTimers();
    setVisibility('visible');
    setIntervalVisible = loadCommon().setIntervalVisible;
  });

  afterEach(function () {
    jest.clearAllTimers();
    jest.useRealTimers();
    setVisibility('visible');
  });

  test('тики идут только на видимой вкладке и возобновляются при возврате', function () {
    let ticks = 0;
    const id = setIntervalVisible(function () {
      ticks++;
    }, 1000);

    jest.advanceTimersByTime(3000);
    expect(ticks).toBe(3);

    // Вкладка ушла в фон: интервал продолжает существовать, но колбэк молчит.
    setVisibility('hidden');
    jest.advanceTimersByTime(5000);
    expect(ticks).toBe(3);

    // Вернулись — тики возобновляются без пере-создания интервала.
    setVisibility('visible');
    jest.advanceTimersByTime(2000);
    expect(ticks).toBe(5);

    clearInterval(id);
  });

  test('скрытая с самого начала вкладка — колбэк не вызывается ни разу', function () {
    setVisibility('hidden');
    let calls = 0;
    const id = setIntervalVisible(function () {
      calls++;
    }, 500);

    jest.advanceTimersByTime(5000);
    expect(calls).toBe(0);

    setVisibility('visible');
    jest.advanceTimersByTime(500);
    expect(calls).toBe(1);

    clearInterval(id);
  });
});
