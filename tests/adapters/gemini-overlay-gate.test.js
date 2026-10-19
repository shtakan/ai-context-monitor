/**
 * overlay-gate (v86) — пины гейта «данные уже в базе» и окна удержания оверлея 3с.
 *
 * ПРЕДМЕТ. При автоскролле к началу истории Gemini поднимался непрозрачный
 * полноэкранный оверлей `#ai-cm-scroll-overlay` (core/gemini-hidden-scroll.js,
 * блок `if (sc.mode === 'el' && sc.el)` в `autoScrollCollect()`). Оверлей в конвейере
 * данных НЕ участвует: сбор идёт через triggerUp/settleBottom, а сам оверлей — только
 * декорация «Загрузка истории…» поверх чата. Отсюда две правки:
 *
 *   1) ШАГ 3: подъём оверлея обёрнут в `if (!autoscrollDataPresent())` — если база уже
 *      собрана (тихая пагинация дошла до начала / подтверждено начало / пол из
 *      localStorage покрыт), экран не затемняется вообще; пишется
 *      `overlay-suppressed reason=autoscroll-data-present`.
 *   2) ШАГ 4: оверлей, который всё-таки подняли, не держится дольше 3с — после
 *      settleBottom в цикле стоит `if (hiddenEl && (autoscrollDataPresent() ||
 *      (Date.now() - __ovShownAt > 3000))) __restoreAutoscrollVisibility();`.
 *      Окно отсчитывается от ФАКТА ПОДЪЁМА (@__ovShownAt), а не от открытия чата:
 *      важно, сколько экран реально закрыт, а не сколько живёт вкладка.
 *
 * ПИНЫ.
 *   D1  источник: `autoscrollDataPresent` присутствует в модуле и экспортирован в Api;
 *       единственный `aiCmSetScrollOverlay(true, 'autoscroll')` стоит ПОД
 *       `if (!autoscrollDataPresent()) {`; в ветке подавления подъёма нет, а лог
 *       `overlay-suppressed reason=autoscroll-data-present` присутствует ровно один раз.
 *   D2  источник: таймаут `Date.now() - __ovShownAt > 3000` присутствует и загейчен
 *       `hiddenEl &&`; `__ovShownAt` объявлена (0 = не поднимали), выставляется в момент
 *       подъёма и читается в условии; окно НЕ отсчитывается от `conversationOpenedAt`
 *       (в гейте и в условии окна нет этого поля, константы AUTOSCROLL_DATA_TIMEOUT нет).
 *   D3  поведение: мок D с `baseSize() >= expectedTurnsFromStorage()` → оверлей НЕ
 *       включается (и есть лог подавления); мок с `baseSize() < пола` → включается.
 *       Дополнительно: `historyFullByQuiet` / `reachedStart` тоже подавляют, а
 *       `expectedTurnsFromStorage()` всегда возвращает ЧИСЛО (undefined/строка/мусор → 0).
 *   D4  поведение: поднятый оверлей снимается в цикле — по данным (база добралась до
 *       пола) и по возрасту (3с), причём прогон после снятия продолжается (retry-паузы
 *       и следующий проход цикла), а `__restoreAutoscrollVisibility()` идемпотентна.
 *   R1  регресс: соседние контракты не сдвинуты — 30-секундный UI-таймаут лоадера
 *       (tests/adapters/gemini-overlay-ui-timeout.test.js) и main-anchor
 *       (tests/adapters/gemini-scroll-stall-fix.test.js) на месте; сьюты зелёные
 *       в общем прогоне, их пины в этом файле только документируются текстом.
 *
 * ПОЧЕМУ ГЕЙТ НЕ МОЖЕТ СЛОМАТЬ СБОР. Единственное, что он делает, — решает, поднимать
 * ли декоративный оверлей. Ветка данных (triggerUp → settleBottom → измерение прироста)
 * выполняется в любом случае; это пин D4.
 *
 * ЛИНЕЙНАЯ НЕЙТРАЛЬНОСТЬ НАМЕРЕННО НАРУШЕНА. `tests/catch-hygiene.test.js` пинит НОМЕРА
 * строк молчаливых catch из `tests/fixtures/catch-whitelist.json`; вставки в
 * core/gemini-hidden-scroll.js сдвинули номера, записи whitelist для файла пересчитаны.
 * Ни один catch не добавлен и не удалён — изменились только номера.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HIDDEN_REL = 'core/gemini-hidden-scroll.js';
const HIDDEN = readFile(HIDDEN_REL);
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const LINES = HIDDEN.split('\n');
const lineIdx = (needle) => LINES.findIndex((l) => l.indexOf(needle) !== -1);

/** Тело `expectedTurnsFromStorage()` — от объявления до закрывающей скобки на отступе 2. */
const FLOOR_FN = (() => {
  const start = HIDDEN.indexOf('function expectedTurnsFromStorage()');
  const end = HIDDEN.indexOf('\n  }', start);
  return HIDDEN.slice(start, end + 4);
})();

/** Тело гейта `autoscrollDataPresent()` — отдельно от соседних функций. */
const GATE_FN = (() => {
  const start = HIDDEN.indexOf('function autoscrollDataPresent()');
  const end = HIDDEN.indexOf('\n  }', start);
  return HIDDEN.slice(start, end + 4);
})();

const RAISE = "D.aiCmSetScrollOverlay(true, 'autoscroll');";
const RAISE_IDX = lineIdx(RAISE);

/**
 * Загрузка core/gemini-hidden-scroll.js в vm-контекст как content script: IIFE,
 * зависимости через __bind, debugLog — глобальная функция utils/debug.js.
 * Часы подменены (модуль читает время только через Date.now()), D.sleep двигает
 * фейковые часы, поэтому прогон autoScrollCollect не ждёт реального времени.
 */
function makeHarness(opts) {
  const o = opts || {};
  const clock = { now: 1000000 };
  const calls = [];   // debugLog: { level, line, at }
  const overlay = []; // aiCmSetScrollOverlay: { on, reason, at }
  const tops = [];    // записи scrollTop (triggerUp = 0, settleBottom = height)
  const sleeps = [];  // D.sleep: [at]

  let topVal = 0;
  const el = {
    tagName: 'INFINITE-SCROLLER',
    className: 'infinite-scroller chat-history',
    id: '',
    clientHeight: 900,
    overflowY: 'auto',
    style: {},
    dispatchEvent() { return true; },
    // высота либо стабильна (быстрый выход по empty*3), либо растёт на каждом шаге
    get scrollHeight() { return o.growHeight ? 5000 + tops.length * 100 : 5000; },
    get scrollTop() { return topVal; },
    set scrollTop(v) { topVal = v; tops.push(v); }
  };
  const main = { querySelectorAll: (sel) => (sel === '*' ? [el] : []) };
  const history = new Array(12).fill(null).map(() => ({})); // > MIN_HISTORY_ELEMENTS: readiness сразу ok
  const doc = {
    querySelector: (sel) => (sel === 'main' ? main : null),
    querySelectorAll: () => history,
    body: {},
    documentElement: { scrollHeight: 1000 },
    scrollingElement: null,
    visibilityState: 'visible',
    addEventListener() { }
  };
  const pageWindow = { innerHeight: 900, dispatchEvent() { } };

  const ctx = vm.createContext({
    window: pageWindow,
    document: doc,
    console,
    getComputedStyle: (e) => ({ overflowY: e.overflowY }),
    setTimeout() { return 0; },
    clearTimeout() { },
    requestAnimationFrame(cb) { cb(); return 0; },
    Date: { now: () => clock.now },
    Event: function Ev(type) { this.type = type; },
    CustomEvent: function CEv(type, init) { this.type = type; this.detail = init && init.detail; },
    WheelEvent: function WEv(type, init) { this.type = type; this.detail = init; },
    debugLog(level, line) { calls.push({ level, line: String(line), at: clock.now }); }
  });
  vm.runInContext(HIDDEN, ctx, { filename: HIDDEN_REL });
  const api = pageWindow.AiCmGeminiHiddenScroll;

  let baseCalls = 0;
  const deps = {
    getConvId: () => 'c-v86-overlay-gate',
    loadFloor: () => (o.floor === undefined ? null : o.floor),
    sleep(ms) { sleeps.push(clock.now); clock.now += Math.round((ms || 0) * (o.timeScale === undefined ? 1 : o.timeScale)); return Promise.resolve(); },
    baseSize() {
      baseCalls++;
      if (typeof o.baseSize === 'function') return o.baseSize(baseCalls);
      return o.baseSize === undefined ? 3 : o.baseSize;
    },
    aiCmSetScrollOverlay(on, reason, expectSeq) {
      overlay.push({ on: !!on, reason: reason, expectSeq: expectSeq, at: clock.now });
    },
    autoScrollStarted: false,
    autoScrollBlocked: false,
    conversationOpenedAt: clock.now,
    DOM_READY_MAX_WAIT: 5000,
    MIN_HISTORY_ELEMENTS: 10,
    pendingCursor: null,
    quietActive: false,
    parserVersion: 'v86-test',
    cacheRestoredMap: new Map(),
    historyFullByQuiet: o.historyFullByQuiet === true,
    reachedStart: o.reachedStart === true
  };
  api.__bind(deps);
  return { api, deps, calls, overlay, tops, sleeps, clock, el };
}

const raisesOf = (h) => h.overlay.filter((c) => c.on);
const offsOf = (h) => h.overlay.filter((c) => !c.on);
const suppressedOf = (h) => h.calls.filter((c) => c.line.indexOf('overlay-suppressed') !== -1);
const restoreOf = (h) => h.calls.filter((c) => c.line.indexOf('restore reason=autoscroll-done') !== -1);

// =====================================================================================
// D1: источник — подъём оверлея под гейтом
// =====================================================================================
describe('v86: D1 источник — подъём оверлея обёрнут в гейт', () => {
  test('D1: autoscrollDataPresent присутствует в модуле и экспортирован', () => {
    expect(HIDDEN).toContain('function autoscrollDataPresent()');
    expect(countOf(HIDDEN, 'autoscrollDataPresent')).toBeGreaterThanOrEqual(3);
    expect(HIDDEN).toContain('autoscrollDataPresent: autoscrollDataPresent,');
  });

  test('D1: raise стоит под if (!autoscrollDataPresent()) {', () => {
    const guard = lineIdx('if (!autoscrollDataPresent()) {');
    expect(guard).toBeGreaterThan(-1);
    expect(RAISE_IDX).toBeGreaterThan(guard);
    // raise — ПЕРВАЯ функциональная строка под guard'ом (между ними только маркер и __ovShownAt)
    const between = LINES.slice(guard + 1, RAISE_IDX).map((l) => l.trim());
    expect(between).toEqual([
      'hiddenEl = true; // v75: маркер «оверлей применён»',
      "__ovShownAt = Date.now(); // v86: отсчёт окна удержания оверлея (3с)"
    ]);
  });

  test('D1: raise ровно один во всём файле; в ветке подавления подъёма нет', () => {
    expect(countOf(HIDDEN, RAISE)).toBe(1);
    expect(countOf(HIDDEN, 'overlay-suppressed reason=autoscroll-data-present')).toBe(1);
    // else-ветка содержит только лог подавления
    const elseIdx = LINES.findIndex((l, i) => i > RAISE_IDX && l.trim() === '} else {');
    expect(elseIdx).toBeGreaterThan(-1);
    const elseBody = LINES.slice(elseIdx + 1, LINES.findIndex((l, i) => i > elseIdx && l.trim() === '}'));
    expect(elseBody).toHaveLength(1);
    expect(elseBody[0]).toContain("debugLog('log', '[AI CM][visibility] overlay-suppressed");
    expect(elseBody.join('')).not.toContain('aiCmSetScrollOverlay');
  });
});

// =====================================================================================
// D2: источник — окно 3с от момента подъёма
// =====================================================================================
describe('v86: D2 источник — окно 3с по __ovShownAt', () => {
  test('D2: условие Date.now() - __ovShownAt > 3000 присутствует и загейчено hiddenEl', () => {
    const cond = lineIdx('Date.now() - __ovShownAt > 3000');
    expect(cond).toBeGreaterThan(-1);
    const line = LINES[cond];
    expect(line).toContain('if (hiddenEl && (autoscrollDataPresent() || (Date.now() - __ovShownAt > 3000))) {');
    expect(line).not.toContain('hiddenEl =');
  });

  test('D2: __ovShownAt — объявлена (0), выставляется при подъёме, читается в условии', () => {
    expect(countOf(HIDDEN, '__ovShownAt')).toBeGreaterThanOrEqual(3);
    const decl = LINES[lineIdx('var __ovShownAt = 0;')];
    expect(decl).toContain('var __ovShownAt = 0;');
    const assign = LINES[lineIdx('__ovShownAt = Date.now();')];
    expect(assign).toContain('__ovShownAt = Date.now();');
    // объявление — в начале autoScrollCollect, до __restoreAutoscrollVisibility
    expect(lineIdx('var __ovShownAt = 0;')).toBeGreaterThan(lineIdx('var hiddenEl = null;'));
    expect(lineIdx('var __ovShownAt = 0;')).toBeLessThan(lineIdx('function __restoreAutoscrollVisibility()'));
  });

  test('D2: окно НЕ отсчитывается от открытия чата (гейт без conversationOpenedAt/константы)', () => {
    expect(GATE_FN).not.toContain('conversationOpenedAt');
    expect(GATE_FN).not.toContain('__ovShownAt');
    expect(countOf(HIDDEN, 'AUTOSCROLL_DATA_TIMEOUT')).toBe(0);
  });
});

// =====================================================================================
// D3: поведение — гейт по данным
// =====================================================================================
describe('v86: D3 поведение — оверлей только на пустой базе', () => {
  test('D3: baseSize >= пол → оверлей не включается, причина в логе', async () => {
    const h = makeHarness({ floor: { count: 5 }, baseSize: 7 });
    await h.api.autoScrollCollect();
    expect(raisesOf(h)).toHaveLength(0);
    const sup = suppressedOf(h);
    expect(sup).toHaveLength(1);
    expect(sup[0].line).toContain('overlay-suppressed reason=autoscroll-data-present');
    expect(sup[0].line).toContain('convId=c-v86-overlay-gate');
    expect(restoreOf(h)).toHaveLength(0); // снимать нечего
  });

  test('D3: baseSize < пола → оверлей включается (прежнее поведение)', async () => {
    const h = makeHarness({ floor: { count: 5 }, baseSize: 2 });
    await h.api.autoScrollCollect();
    const raises = raisesOf(h);
    expect(raises).toHaveLength(1);
    expect(raises[0].reason).toBe('autoscroll');
    expect(suppressedOf(h)).toHaveLength(0);
    expect(restoreOf(h)).toHaveLength(1); // штатное снятие на выходе
  });

  test('D3: historyFullByQuiet / reachedStart тоже подавляют подъём', async () => {
    const quiet = makeHarness({ historyFullByQuiet: true });
    await quiet.api.autoScrollCollect();
    expect(raisesOf(quiet)).toHaveLength(0);
    expect(suppressedOf(quiet)).toHaveLength(1);

    const start = makeHarness({ reachedStart: true });
    await start.api.autoScrollCollect();
    expect(raisesOf(start)).toHaveLength(0);
    expect(suppressedOf(start)).toHaveLength(1);
  });

  test('D3: expectedTurnsFromStorage() всегда ЧИСЛО (undefined/строка/мусор → 0)', () => {
    const cases = [
      [{ count: 7 }, 7],
      [{ count: '9' }, 9],
      [{ count: undefined }, 0],
      [{}, 0],
      [null, 0],
      [{ count: 'junk' }, 0],
      [{ count: -3 }, 0]
    ];
    for (const [floor, expected] of cases) {
      const h = makeHarness({ floor });
      expect(h.api.expectedTurnsFromStorage()).toBe(expected);
    }
    expect(FLOOR_FN).toContain('Number(sf.count)');
    expect(FLOOR_FN).toContain('isFinite(n) && n > 0');
    expect(FLOOR_FN).not.toContain('sf.count) ? sf.count');
  });
});

// =====================================================================================
// D4: поведение — оверлей снимается в цикле, прогон продолжается
// =====================================================================================
describe('v86: D4 поведение — окно 3с и снятие по данным', () => {
  test('D4: по возрасту — 3с снимают оверлей, retry-паузы продолжаются', async () => {
    // пол 5, база стоит на 1: гейт поднимает оверлей, данные не приходят,
    // каждый внешний проход цикла = empty*3 (4.5с) + settleBottom (1с) → окно истекает.
    const h = makeHarness({ floor: { count: 5 }, baseSize: 1 });
    await h.api.autoScrollCollect();

    const raises = raisesOf(h);
    expect(raises).toHaveLength(1);
    const offs = offsOf(h);
    expect(offs).toHaveLength(1);
    expect(offs[0].reason).toBe('autoscroll-done');
    const livedMs = offs[0].at - raises[0].at;
    expect(livedMs).toBeGreaterThan(3000);
    expect(livedMs).toBeLessThan(9000);
    // прогон после снятия жив: есть retry-лог и финальный «конец»
    expect(h.calls.filter((c) => c.line.indexOf('→ retry ') !== -1).length).toBeGreaterThanOrEqual(1);
    expect(h.calls.filter((c) => c.line.indexOf('[gemini-autoscroll] конец:') !== -1)).toHaveLength(1);
    // снятие ровно одно, хотя цикл проходил ещё несколько раз (идемпотентность restore)
    expect(restoreOf(h)).toHaveLength(1);
  });

  test('D4: по данным — база добралась до пола, оверлей снят раньше 3с', async () => {
    // Часы ускорены (timeScale): прогон целиком занимает < 3с, поэтому снятие может быть
    // ТОЛЬКО по признаку данных, а не по окну. База 1 до проверки (гейт пускает оверлей),
    // на 7-м обращении (проверка после settleBottom) — уже 5 = пол.
    const h = makeHarness({
      floor: { count: 5 },
      timeScale: 0.05,
      baseSize: (call) => (call >= 7 ? 5 : 1)
    });
    await h.api.autoScrollCollect();

    expect(raisesOf(h)).toHaveLength(1);
    const offs = offsOf(h);
    expect(offs).toHaveLength(1);
    const livedMs = offs[0].at - raisesOf(h)[0].at;
    expect(livedMs).toBeLessThan(3000); // снял именно признак данных, а не окно
    expect(h.calls.filter((c) => c.line.indexOf('[gemini-autoscroll] конец:') !== -1)).toHaveLength(1);
  });

  test('D4: конвейер данных не затронут — triggerUp и settleBottom отработали', async () => {
    const h = makeHarness({ historyFullByQuiet: true });
    await h.api.autoScrollCollect();
    expect(h.tops).toContain(0);    // triggerUp
    expect(h.tops).toContain(5000); // settleBottom
    expect(h.calls.filter((c) => c.line.indexOf('[gemini-autoscroll] старт:') !== -1)).toHaveLength(1);
    expect(h.calls.filter((c) => c.line.indexOf('ошибка автоскролла') !== -1)).toHaveLength(0);
  });
});

// =====================================================================================
// R1: соседние контракты не сдвинуты
// =====================================================================================
describe('v86: R1 соседние контракты целы', () => {
  test('R1: 30-секундный UI-таймаут лоадера на месте (gemini-overlay-ui-timeout)', () => {
    const loader = readFile('core/gemini-loader-scroll.js');
    expect(countOf(loader, "D.aiCmSetScrollOverlay(false, 'ui-timeout')")).toBe(1);
    expect(loader).toContain('Date.now() - runStartAt > 30000');
    expect(countOf(loader, 'LOADER_STALL_CAP = 90')).toBe(1);
  });

  test('R1: main-anchor и hint скролл-контейнера на месте (gemini-scroll-stall-fix)', () => {
    expect(countOf(HIDDEN, "document.querySelectorAll('*')")).toBe(0);
    expect(HIDDEN).toContain("var root = document.querySelector('main');");
    expect(countOf(HIDDEN, 'makeScroller(null)')).toBe(0);
  });

  test('R1: публичные экспорты модуля не переименованы', () => {
    const api = makeHarness().api;
    for (const name of ['__bind', 'findScrollContainer', 'triggerUp', 'settleBottom',
      'scheduleAutoScroll', 'expectedTurnsFromStorage', 'retryNeededAutoscroll',
      'autoScrollCollect', 'autoscrollDataPresent']) {
      expect(typeof api[name]).toBe('function');
    }
  });

  test('R1: v75-пропуск cache-hit остаётся первым гардом autoScrollCollect()', () => {
    expect(lineIdx('skip reason=cache-hit-no-pagination')).toBeLessThan(lineIdx('sc = findScrollContainer();'));
    expect(countOf(HIDDEN, "D.aiCmSetScrollOverlay(false, 'autoscroll-done')")).toBe(1);
  });
});
