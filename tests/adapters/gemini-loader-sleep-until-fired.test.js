/**
 * v88.2 (SLEEP-UNTIL-FIRED): прерываемый сон цикла лоадера Gemini.
 *
 * ПРЕДМЕТ. В core/gemini-loader-scroll.js цикл `while (true)` уже выходит по fired-латчу
 * `aiCmFiredByConv` (v88.1, reason='export-done'), но проверка стоит только в НАЧАЛЕ
 * итерации. Внутри итерации цикл спал одним `D.sleep()` на 800–2000 мс, поэтому после
 * автоэкспорта визуальные эффекты (hide/скролл/оверлей) продолжались до конца паузы.
 * Фикс: хелпер `sleepUntilFired(ms, convId)` режет паузу на окна по 150 мс и перед каждым
 * окном читает латч — путь до выхода не длиннее 150 мс. Гейт loop-head не тронут.
 *
 * ПИНЫ (R-D: исходник + поведение, конвенция «исполняется реальный код», а не копия):
 *   D1 — хелпер ровно один, окно 150 мс, чанк = min(150, остаток), чтение латча с typeof-гардом;
 *   D2 — в цикле не осталось ни одного `await D.sleep(...)`: восемь мест переведены на хелпер,
 *        единственный `D.sleep` — преднамеренный предцикловой поллинг скроллера;
 *   D3 — поведение: пауза режется на окна ≤150 мс, сумма окон = запрошенной паузе;
 *   D4 — поведение: латч взведён посреди паузы → возврат максимум через одно окно (≤150 мс);
 *   D5 — поведение: латч взведён ДО входа → хелпер не спит ни разу;
 *   D6 — поведение: латч недоступен (песочница) → typeof-гард, пауза отсыпается целиком, без throw;
 *   D7 — поведение: нулевая/отрицательная пауза → ни одного вызова D.sleep;
 *   R1 — E2E: fired приходит window-событием посреди реальной паузы цикла → прогон
 *        завершается reason='export-done' не позже чем через 150 мс фейковых часов,
 *        ни одно окно D.sleep в прогоне не длиннее 150 мс;
 *   R2 — соседний контракт не сдвинут: блочных гейтов цикла по-прежнему два (loop-head +
 *        collapse-guard; брас-less чтение внутри хелпера гейтом не считается). v90.1 добавил
 *        восемь пост-await гейтов того же текста — их счёт и позиции пинит
 *        tests/adapters/gemini-loader-fired-after-await.test.js.
 *
 * Часы подменены (модуль читает время только через Date.now()), D.sleep двигает фейковые
 * часы на ЗАПРОШЕННУЮ длительность — именно так проверяется нарезка на окна (в отличие от
 * gemini-overlay-ui-timeout, где D.sleep двигает часы на шаг сценария).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const LOADER_REL = 'core/gemini-loader-scroll.js';
const LOADER = fs.readFileSync(path.join(ROOT, LOADER_REL), 'utf8');

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/** Тело хелпера из реального исходника (объявление + закрывающая скобка на отступе 2). */
const HELPER = (() => {
  const start = LOADER.indexOf('  async function sleepUntilFired(');
  expect(start).toBeGreaterThan(-1);
  const end = LOADER.indexOf('\n  }\n', start);
  expect(end).toBeGreaterThan(start);
  return LOADER.slice(start, end + 4);
})();

/** Компиляция вырезанного хелпера: D, латч и часы — параметры (как в песочницах модуля). */
function compileHelper(deps, latch, clock) {
  const factory = new Function('D', 'aiCmFiredByConv', 'Date', 'return (' + HELPER + ');');
  return factory(deps, latch, { now: () => clock.now });
}

/** Фейковый D.sleep: двигает часы на запрошенную длительность, копит окна. */
function sleepRecorder(clock, windows, hook) {
  return function (ms) {
    windows.push(ms);
    if (typeof hook === 'function') hook(windows.length, clock);
    clock.now += ms;
    return Promise.resolve();
  };
}

// =====================================================================================
// D1/D2: источник — хелпер и его подключение в цикл
// =====================================================================================
describe('v88.2 sleepUntilFired: D1 источник хелпера', () => {
  test('D1: хелпер объявлен ровно один раз, рядом с циклом (до loadFullHistoryInvisibly)', () => {
    expect(countOf(LOADER, 'function sleepUntilFired(')).toBe(1);
    const helperIdx = LOADER.indexOf('async function sleepUntilFired(');
    const loadIdx = LOADER.indexOf('async function loadFullHistoryInvisibly(');
    expect(helperIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(helperIdx);
  });

  test('D1: окно 150 мс и чанк min(150, остаток) — длинной паузы внутри не остаётся', () => {
    expect(HELPER).toContain('Math.min(150, ms - (Date.now() - start))');
    expect(HELPER).toContain('await D.sleep(');
    // ровно одно окно на итерацию хелпера; иных sleep внутри нет
    expect(countOf(HELPER, 'D.sleep(')).toBe(1);
    // чтение латча с typeof-гардом (песочницы без модульных замыканий)
    expect(HELPER).toContain("typeof aiCmFiredByConv !== 'undefined' && aiCmFiredByConv[convId]");
    // гейт хелпера брас-less — не выглядит вторым гейтом цикла (см. R2)
    expect(HELPER).toContain('aiCmFiredByConv[convId]) return;');
  });
});

describe('v88.2 sleepUntilFired: D2 все паузы цикла переведены на хелпер', () => {
  test('D2: девять мест цикла используют хелпер, второго способа спать в цикле нет', () => {
    expect(countOf(LOADER, 'await sleepUntilFired(')).toBe(9);
    // оставшиеся прямые D.sleep — только два законных: преднамеренный предцикловой поллинг
    // скроллера и одно окно внутри самого хелпера; в теле цикла прямых D.sleep нет
    expect(countOf(LOADER, 'await D.sleep(')).toBe(2);
    const findWaitIdx = LOADER.indexOf('await D.sleep(LOADER_FIND_WAIT);');
    expect(findWaitIdx).toBeGreaterThan(-1);
    expect(findWaitIdx).toBeLessThan(LOADER.indexOf('while (true) {'));
    const helperSleepIdx = LOADER.indexOf('await D.sleep(Math.min(150');
    expect(helperSleepIdx).toBeGreaterThan(-1);
    expect(helperSleepIdx).toBeLessThan(LOADER.indexOf('while (true) {'));
  });

  test('D2: каждое окно цикла получает convId (латч привязан к чату)', () => {
    const calls = LOADER.split('await sleepUntilFired(').slice(1);
    expect(calls).toHaveLength(9);
    for (const tail of calls) expect(tail).toContain(', convId);');

    // все девять окон лежат ВНУТРИ цикла (между while (true) и пост-цикловым стопом):
    // с v90.1 после каждого окна стоит собственный fired-гейт (см.
    // tests/adapters/gemini-loader-fired-after-await.test.js), loop-head остаётся первым
    const loopStart = LOADER.indexOf('while (true) {');
    const loopEnd = LOADER.indexOf('D.lastLoaderDoneReason = doneReason;');
    expect(loopStart).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);
    let at = LOADER.indexOf('await sleepUntilFired(');
    while (at !== -1) {
      expect(at).toBeGreaterThan(loopStart);
      expect(at).toBeLessThan(loopEnd);
      at = LOADER.indexOf('await sleepUntilFired(', at + 1);
    }
    expect(countOf(LOADER, 'await sleepUntilFired(LOADER_STEP_MS, convId);')).toBe(5);
    expect(countOf(LOADER, 'await sleepUntilFired(SCROLL_PAUSE_HIDDEN_MS, convId);')).toBe(2);
    expect(countOf(LOADER, 'await sleepUntilFired(LOADER_RECHECK_MS, convId);')).toBe(2);
  });
});

// =====================================================================================
// D3–D7: поведение вырезанного хелпера (реальный код)
// =====================================================================================
describe('v88.2 sleepUntilFired: D3–D7 поведение', () => {
  test('D3: пауза 1999 мс режется на окна ≤150 мс, сумма окон равна паузе', async () => {
    const clock = { now: 0 };
    const windows = [];
    const fn = compileHelper({ sleep: sleepRecorder(clock, windows) }, Object.create(null), clock);
    await fn(1999, 'conv-d3');

    expect(windows.length).toBeGreaterThan(1);
    for (const ms of windows) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(150);
    }
    expect(windows.reduce((a, b) => a + b, 0)).toBe(1999);
    expect(clock.now).toBe(1999);
  });

  test('D4: латч взведён посреди паузы → возврат за одно окно (≤150 мс)', async () => {
    const clock = { now: 0 };
    const windows = [];
    const latch = Object.create(null);
    const fn = compileHelper(
      { sleep: sleepRecorder(clock, windows, (n) => { if (n === 2) latch['conv-d4'] = 1; }) },
      latch,
      clock
    );
    await fn(5000, 'conv-d4');

    // проверка стоит ПЕРЕД окном: после взвода (конец 2-го окна) — ни одного лишнего
    expect(windows).toHaveLength(2);
    expect(clock.now).toBeLessThanOrEqual(300);
    expect(clock.now).toBeLessThan(5000);
  });

  test('D5: латч взведён до входа → хелпер не спит ни разу', async () => {
    const clock = { now: 0 };
    const windows = [];
    const latch = { 'conv-d5': 1 };
    const fn = compileHelper({ sleep: sleepRecorder(clock, windows) }, latch, clock);
    await fn(1200, 'conv-d5');

    expect(windows).toEqual([]);
    expect(clock.now).toBe(0);
  });

  test('D6: латч недоступен (песочница) → typeof-гард, пауза целиком, без throw', async () => {
    const clock = { now: 0 };
    const windows = [];
    const fn = compileHelper({ sleep: sleepRecorder(clock, windows) }, undefined, clock);
    await expect(fn(800, 'conv-d6')).resolves.toBeUndefined();

    expect(windows.reduce((a, b) => a + b, 0)).toBe(800);
    expect(clock.now).toBe(800);
  });

  test('D7: нулевая пауза → ни одного D.sleep (нет пустого тика)', async () => {
    const clock = { now: 0 };
    const windows = [];
    const fn = compileHelper({ sleep: sleepRecorder(clock, windows) }, Object.create(null), clock);
    await fn(0, 'conv-d7');

    expect(windows).toEqual([]);
    expect(clock.now).toBe(0);
  });
});

// =====================================================================================
// R1: E2E — fired посреди реальной паузы цикла; выход ≤150 мс
// =====================================================================================
const CONV_ID = 'c-sleep-until-fired';

/**
 * Загрузка реального модуля в vm: окно-шина (window-событие fired) захватывается
 * слушателем модуля, D.sleep двигает часы на ЗАПРОШЕННУЮ длительность. Скроллер растёт
 * на каждом поиске (+300 px > LOADER_RESUME_DELTA), поэтому цикл живёт итерациями, а не
 * уходит в ветки no-growth/data-complete; fired приходит на 2-м окне первой паузы.
 */
function makeHarness() {
  const clock = { now: 1000000 };
  const clockStart = clock.now;
  const calls = [];    // debugLog: { level, line, at }
  const windows = [];  // D.sleep: [ms]
  const overlay = [];  // aiCmSetScrollOverlay: { on, reason, at }
  let firedAt = -1;
  let firedHandler = null;

  function Ev(type) { this.type = type; }
  function CustomEv(type, init) { this.type = type; this.detail = (init && init.detail) || null; }

  const pageWindow = {
    addEventListener(type, fn) { if (type === 'ai-cm-auto-export-fired') firedHandler = fn; },
    dispatchEvent() { }
  };
  const pageDocument = { visibilityState: 'visible', addEventListener() { } };

  const ctx = vm.createContext({
    window: pageWindow,
    document: pageDocument,
    console,
    setTimeout() { return 0; },
    clearTimeout() { },
    requestAnimationFrame(cb) { cb(); return 0; },
    Date: { now: () => clock.now },
    Event: Ev,
    CustomEvent: CustomEv,
    swallowSoft() { },
    swallow() { },
    debugLog(level, line) { calls.push({ level, line: String(line), at: clock.now }); }
  });

  const container = {
    mode: 'el',
    el: { style: {}, dispatchEvent() { } },
    height() { return 20000 + 300 * finds.length; },
    client() { return 800; },
    top() { return 0; },
    setTop() { }
  };
  const finds = [];

  const deps = {
    getConvId() { return CONV_ID; },
    cursorEpoch: 0,
    loaderState: {},
    loaderDoneMap: {},
    loaderRetryUsedMap: {},
    cacheRestoredMap: new Map(),
    oracleIncompleteSeen: {},
    oracleRerunUsedMap: {},
    collapseRetries: 0,
    loaderRunningFor: null,
    notifyLoaderState() { },
    baseSize() { return 120; }, // >= LOADER_HIDE_MIN_MSGS: скрытие применится
    loadFloor() { return { count: 0 }; },
    olderHistorySeen: true,
    reachedStart: false,
    historyFullByQuiet: false,
    pendingCursor: null,
    quietEndedClean: false,
    tapeWasUsedInThisColdStart: false,
    aiCmScrollOverlay: null,
    aiCmUiOverlayTimedOut: false,
    aiCmOverlaySeq: 0,
    aiCmSetScrollOverlay(on, reason, expectSeq) {
      overlay.push({ on: !!on, reason: reason, expectSeq: expectSeq, at: clock.now });
      deps.aiCmScrollOverlay = on ? { reason: reason } : null;
    },
    findScrollContainer() { finds.push(clock.now); return container; },
    sleep(ms) {
      windows.push(ms);
      // fired приходит ровно посреди первой паузы: окно уже началось, часы ещё не сдвинуты
      if (firedAt < 0 && windows.length === 2 && typeof firedHandler === 'function') {
        firedAt = clock.now;
        firedHandler({ detail: { convId: CONV_ID, reason: 'threshold' } });
      }
      clock.now += ms;
      return Promise.resolve();
    },
    vf5OverlapSinceLoaderStart: false,
    isLowConfidenceBase: false
  };

  vm.runInContext(LOADER, ctx, { filename: LOADER_REL });
  const api = pageWindow.AiCmGeminiLoaderScroll;
  api.__bind(deps);
  return { api, deps, calls, overlay, windows, clock, clockStart, getFiredAt: () => firedAt };
}

describe('v88.2 sleepUntilFired: R1 E2E выход по export-done ≤150 мс', () => {
  test('R1: fired посреди паузы → reason=export-done, задержка ≤150 мс, окон >150 мс нет', async () => {
    const h = makeHarness();
    await h.api.loadFullHistoryInvisibly();

    const firedAt = h.getFiredAt();
    expect(firedAt).toBeGreaterThan(0);

    // ровно один long-run: выход по своей причине, без аварийного лога
    const done = h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] done reason=') !== -1);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=export-done');
    expect(h.calls.filter((c) => c.line.indexOf('ошибка лоадера') !== -1)).toHaveLength(0);
    expect(h.deps.lastLoaderDoneReason).toBe('export-done');

    // ключевое: от fired до выхода — не больше одного окна
    const latency = done[0].at - firedAt;
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThanOrEqual(150);

    // и ни одно окно D.sleep в прогоне не длиннее окна нарезки
    expect(h.windows.length).toBeGreaterThan(0);
    for (const ms of h.windows) expect(ms).toBeLessThanOrEqual(150);

    // оверлей поднимался штатно и снят restore'ом после выхода (не остаётся на экране)
    expect(h.overlay.filter((c) => c.on).map((c) => c.reason)).toEqual(['loader']);
    expect(h.overlay.filter((c) => c.reason === 'loader-done')).toHaveLength(1);
  });
});

// =====================================================================================
// R2: блочные гейты цикла не сдвинуты (брас-less чтение в хелпере — не гейт)
// =====================================================================================
describe('v88.2 sleepUntilFired: R2 соседний контракт не сдвинут', () => {
  const GATE_OPEN = "if (typeof aiCmFiredByConv !== 'undefined' && aiCmFiredByConv[convId]) {";

  test('R2: 11 гейтов = 2 блочных (loop-head + collapse-guard) + 9 пост-await (v90.1 + v95)', () => {
    // v90.1 (FIRED-AFTER-AWAIT) добавил по гейту после каждого из восьми await — тот же текст,
    // та же причина 'export-done', тот же break. v95 (BASE-COMPLETE-EARLY-BREAK) добавил девятый:
    // после контрольного перемера в ветке base-complete-stall-early. Адресность (гейт первым
    // стейтментом после каждого await; loop-head первым, collapse-guard последним) и поведение —
    // tests/adapters/gemini-loader-fired-after-await.test.js (S1/S2, R3–R5).
    expect(countOf(LOADER, GATE_OPEN)).toBe(11);
    // хелпер читает латч брас-less — в счёт гейтов цикла он не попадает
    expect(countOf(LOADER, 'aiCmFiredByConv[convId]) return;')).toBe(1);
  });

  test('R2: wall-clock fail-safe и его единственная точка break не тронуты', () => {
    expect(LOADER).toContain(
      "if (Date.now() - runStartAt > LOADER_RUN_WALL_CLOCK_MS) { doneReason = 'wall-clock-timeout'; break; }"
    );
    expect(countOf(LOADER, 'LOADER_RUN_WALL_CLOCK_MS')).toBe(2); // объявление + guard
  });
});
