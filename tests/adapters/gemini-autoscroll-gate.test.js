/**
 * autoscroll-gate (v2.0.21) — автоскролл не запускается, если автоэкспорт уже выстрелил.
 *
 * ПРЕДМЕТ. PLAN-отчёт по живому прогону: `done reason=data-complete` пришёл на 86 мс РАНЬШЕ
 * `fired`, поэтому гейт `export-done` в лоадере не сработал, а через 284 мс после fired
 * стартовал `autoScrollCollect()` (точка вызова — core/pagination/pagination.js:593 →
 * `scheduleAutoScroll()`) и крутил скролл 17.8 с, вызывая перерисовку скелетонов Gemini.
 * Файл уже записан автоэкспортом — догрузка старших окон его не исправит, значит скролл
 * после fired не нужен вообще.
 *
 * ЧТО СДЕЛАНО. В core/gemini-hidden-scroll.js латч `aiCmFiredByConv` заводится локально
 * и навешивается на тот же window-CustomEvent `ai-cm-auto-export-fired`, что диспатчит
 * core/export-manager.js:1796 (detail.convId). У лоадера свой латч в своём IIFE, этому
 * модулю он не виден — поэтому слушатель свой, формат события общий. Гейт стоит:
 *   1) первым шагом `autoScrollCollect()` — fired ДО старта → `skip reason=export-fired`;
 *   2) в начале каждой итерации внутреннего цикла скролла — fired ВО ВРЕМЯ прогона →
 *      `stoppedBy = 'export-fired'`, break. После этого не выполняются settleBottom
 *      (возврат в низ = визуальный эффект) и retry-перезапуск.
 *
 * ПИНЫ.
 *   D1 источник: `aiCmFiredByConv` в модуле ≥ 2 (приёмка grep), гейт присутствует в
 *      `autoScrollCollect()` ДО поиска контейнера и первого triggerUp; в цикле гейт
 *      рвёт прогон reason=export-fired; латч слушает окно-событие под typeof-guard
 *      (соседние vm-сьюты грузят модуль с `window` без addEventListener).
 *   D2 поведение (vm): `aiCmFiredByConv[convId] = 1` → `autoScrollCollect()` сразу
 *      возвращает undefined, «старт» не пишется, скролл/оверлей/сон не трогаются.
 *   D3 поведение (vm): fired этого чата НЕ было → прогон работает как прежде
 *      («старт»/«конец», triggerUp + settleBottom, оверлей поднят и снят).
 *
 * ЛИНЕЙНАЯ НЕЙТРАЛЬНОСТЬ СОХРАНЕНА. Новые строки вставлены только за счёт сжатия
 * соседних комментариев, поэтому номера молчаливых catch (whitelist:
 * tests/fixtures/catch-whitelist.json) не сдвинулись и сам whitelist не правился.
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

/** Тело `autoScrollCollect()` — от объявления до блока латча (тот стоит перед экспортом). */
const COLLECT_FN = (() => {
  const start = HIDDEN.indexOf('async function autoScrollCollect()');
  const end = HIDDEN.indexOf('// ---- v2.0.21: латч', start);
  return HIDDEN.slice(start, end);
})();

/** Форма гейта, общая для входа в функцию и для шага цикла. */
const GATE = "aiCmFiredByConv[D.getConvId() || '']";

/**
 * Загрузка core/gemini-hidden-scroll.js в vm-контекст как content script.
 * Зависимости ядра — через __bind; часы фейковые, D.sleep двигает их, поэтому прогон
 * autoScrollCollect не занимает реального времени. `pageWindow` умеет addEventListener —
 * именно так тест проверяет, что латч заводится от боевого window-события, а не из мока.
 */
function makeHarness(opts) {
  const o = opts || {};
  const log = [];        // debugLog: { level, line, at }
  const listeners = {};  // window.addEventListener: type -> [fn]
  const sleeps = [];
  const overlay = [];    // aiCmSetScrollOverlay: { on, reason, at }
  const tops = [];       // записи scrollTop (triggerUp = 0, settleBottom = height)
  let now = 1000000;
  let topVal = 0;
  let convId = 'c-autoscroll-gate';

  const el = {
    tagName: 'INFINITE-SCROLLER',
    className: 'chat-history',
    id: '',
    clientHeight: 900,
    overflowY: 'auto',
    style: {},
    // v88: findScrollContainer требует структурный якорь chat-history
    closest() { return { tagName: 'INFINITE-SCROLLER', className: 'chat-history' }; },
    dispatchEvent() { return true; },
    get scrollHeight() { return 5000; },
    get scrollTop() { return topVal; },
    set scrollTop(v) { topVal = v; tops.push(v); }
  };
  const main = { querySelectorAll: (sel) => (sel === '*' ? [el] : []) };
  const history = new Array(12).fill(null).map(() => ({})); // > MIN_HISTORY_ELEMENTS
  const doc = {
    querySelector: (sel) => (sel === 'main' ? main : null),
    querySelectorAll: () => history,
    body: {},
    documentElement: { scrollHeight: 1000 },
    scrollingElement: null,
    addEventListener() { }
  };
  const pageWindow = {
    innerHeight: 900,
    dispatchEvent() { },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() { }
  };

  const ctx = vm.createContext({
    window: pageWindow,
    document: doc,
    console,
    getComputedStyle: (e) => ({ overflowY: e.overflowY }),
    setTimeout() { return 0; },
    clearTimeout() { },
    Date: { now: () => now },
    Event: function Ev(type) { this.type = type; },
    CustomEvent: function CEv(type, init) { this.type = type; this.detail = init && init.detail; },
    WheelEvent: function WEv(type, init) { this.type = type; this.detail = init; },
    debugLog(level, line) { log.push({ level, line: String(line), at: now }); }
  });
  vm.runInContext(HIDDEN, ctx, { filename: HIDDEN_REL });
  const api = pageWindow.AiCmGeminiHiddenScroll;

  // Чистая логика readiness недоступна (как в vm-сьюте overlay-gate): гейт сразу ready.
  pageWindow.GeminiInterceptLogic = {
    newDomReadiness: () => ({ samples: [] }),
    advanceReadiness: () => ({ ready: true, reason: 'test-ready' })
  };

  const deps = {
    getConvId: () => convId,
    loadFloor: () => (o.floor === undefined ? null : o.floor),
    sleep(ms) {
      sleeps.push(now);
      now += Math.round((ms || 0) * (o.timeScale === undefined ? 1 : o.timeScale));
      return Promise.resolve();
    },
    baseSize: () => 3,
    aiCmSetScrollOverlay(on, reason) { overlay.push({ on: !!on, reason, at: now }); },
    autoScrollStarted: false,
    autoScrollBlocked: false,
    conversationOpenedAt: now,
    DOM_READY_MAX_WAIT: 5000,
    MIN_HISTORY_ELEMENTS: 10,
    pendingCursor: null,
    quietActive: false,
    parserVersion: 'v2.0.21-test',
    cacheRestoredMap: new Map(),
    historyFullByQuiet: false,
    reachedStart: false,
    swallowSoft() { }
  };
  api.__bind(deps);

  /** Боевой канал fired: window-CustomEvent с detail.convId (как export-manager.js:1796). */
  function fire(cid) {
    const hs = listeners['ai-cm-auto-export-fired'] || [];
    for (const fn of hs) fn({ detail: { convId: cid, reason: 'data-complete' } });
  }

  return { api, deps, log, listeners, fire, sleeps, overlay, tops, el };
}

const linesOf = (h) => h.log.map((c) => c.line);
const has = (h, needle) => linesOf(h).filter((l) => l.indexOf(needle) !== -1);

/** Общие ожидания штатного прогона (fired не было). */
function expectNormalRun(h) {
  expect(has(h, '[gemini-autoscroll] старт:')).toHaveLength(1);
  expect(has(h, '[gemini-autoscroll] конец:')).toHaveLength(1);
  expect(has(h, 'skip reason=export-fired')).toHaveLength(0);
  expect(h.tops).toContain(0);    // triggerUp
  expect(h.tops).toContain(5000); // settleBottom
}

// =====================================================================================
// D1: источник — гейт export-fired на входе и внутри цикла скролла
// =====================================================================================
describe('v2.0.21: D1 источник — гейт aiCmFiredByConv в автоскролле', () => {
  test('D1: счётчик aiCmFiredByConv в модуле ≥ 2 (критерий приёмки grep)', () => {
    expect(countOf(HIDDEN, 'aiCmFiredByConv')).toBeGreaterThanOrEqual(2);
    // гейтов именно два: вход в функцию + шаг внутреннего цикла
    expect(countOf(COLLECT_FN, GATE)).toBe(2);
  });

  test('D1: вход в autoScrollCollect гейтится ДО blocked-проверки и поиска контейнера', () => {
    const gate = COLLECT_FN.indexOf(GATE);
    expect(gate).toBeGreaterThan(-1);
    expect(COLLECT_FN).toContain("if (typeof aiCmFiredByConv !== 'undefined' && " + GATE + ')');
    expect(COLLECT_FN).toContain("'[AI CM][autoscroll] skip reason=export-fired'");
    // fired ДО старта: гейт первый шаг функции, до любой работы с DOM
    expect(gate).toBeLessThan(COLLECT_FN.indexOf('if (D.autoScrollBlocked) {'));
    expect(gate).toBeLessThan(COLLECT_FN.indexOf('findScrollContainer();'));
    expect(gate).toBeLessThan(COLLECT_FN.indexOf('triggerUp(sc);'));
  });

  test('D1: fired ВО ВРЕМЯ прогона рвёт цикл reason=export-fired и глушит settle/retry', () => {
    expect(COLLECT_FN).toContain("{ stoppedBy = 'export-fired'; break; }");
    const loopGate = COLLECT_FN.indexOf("{ stoppedBy = 'export-fired'; break; }");
    expect(loopGate).toBeGreaterThan(COLLECT_FN.indexOf('for (i = 0; i < AUTO_HARD_CAP; i++) {'));
    expect(loopGate).toBeLessThan(COLLECT_FN.indexOf('triggerUp(sc);', loopGate));
    // после fired не возвращаемся в низ (визуальный эффект) и не перезапускаем скролл
    expect(COLLECT_FN).toContain("if (stoppedBy !== 'export-fired') await settleBottom(sc);");
    expect(COLLECT_FN).toContain("stoppedBy !== 'export-fired' && retryNeededAutoscroll");
  });

  test('D1: латч заводится от window-события ai-cm-auto-export-fired под typeof-guard', () => {
    expect(HIDDEN).toContain("window.addEventListener('ai-cm-auto-export-fired'");
    expect(HIDDEN).toContain('var aiCmFiredByConv = Object.create(null);');
    expect(lineIdx('if (typeof window !== \'undefined\' && window.addEventListener) {'))
      .toBeLessThan(lineIdx("window.addEventListener('ai-cm-auto-export-fired'"));
    // без convId латч не взводится (событие чужого чата не блокирует текущий)
    expect(lineIdx('var cidFired = (dFired && dFired.convId) ? String(dFired.convId) : \'\';'))
      .toBeLessThan(lineIdx('aiCmFiredByConv[cidFired] = 1;'));
  });
});

// =====================================================================================
// D2: поведение — fired уже пришёл → автоскролл не стартует
// =====================================================================================
describe('v2.0.21: D2 поведение — после fired автоскролл не запускается', () => {
  test('D2: aiCmFiredByConv[convId]=1 → мгновенный return без «старт» и без скролла', async () => {
    const h = makeHarness();
    h.fire('c-autoscroll-gate'); // ровно тот convId, что отдаёт D.getConvId()
    expect(h.listeners['ai-cm-auto-export-fired']).toHaveLength(1);

    const res = await h.api.autoScrollCollect();

    expect(res).toBeUndefined();
    expect(has(h, 'skip reason=export-fired')).toHaveLength(1);
    expect(has(h, 'старт:')).toHaveLength(0);
    expect(has(h, 'конец:')).toHaveLength(0);
    expect(h.tops).toHaveLength(0);      // ни triggerUp, ни settleBottom
    expect(h.overlay).toHaveLength(0);   // оверлей не поднимали/не снимали
    expect(h.sleeps).toHaveLength(0);    // ни одного шага скролла
  });

  test('D2: латч привязан к чату — fired чужого convId не блокирует текущий', async () => {
    const h = makeHarness();
    h.fire('c-other-conversation');

    const res = await h.api.autoScrollCollect();

    expect(res).toBeUndefined();
    expectNormalRun(h);
  });
});

// =====================================================================================
// D3: поведение — fired не было → прежнее поведение
// =====================================================================================
describe('v2.0.21: D3 поведение — без fired прогон работает как прежде', () => {
  test('D3: aiCmFiredByConv пуст → скролл, оверлей и финальный лог на месте', async () => {
    const h = makeHarness();
    expect(h.listeners['ai-cm-auto-export-fired']).toHaveLength(1); // латч слушает, но пуст

    const res = await h.api.autoScrollCollect();

    expect(res).toBeUndefined();
    expectNormalRun(h);
    // оверлей: поднят и штатно снят (v86-поведение не затронуто)
    expect(h.overlay.filter((c) => c.on)).toHaveLength(1);
    expect(h.overlay.filter((c) => !c.on)).toHaveLength(1);
    // выход по пустым шагам, а не по гейту
    expect(has(h, 'стоп=empty*3')).toHaveLength(1);
  });
});
