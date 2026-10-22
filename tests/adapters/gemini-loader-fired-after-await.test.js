/**
 * v90.1 (FIRED-AFTER-AWAIT): латч export-fired читается после КАЖДОГО await цикла лоадера.
 *
 * ПРЕДМЕТ. v88.2 (`sleepUntilFired`, tests/adapters/gemini-loader-sleep-until-fired.test.js)
 * обрывает только САМ СОН: цикл просыпается максимум через 150 мс после автоэкспорта, но
 * дальше продолжает текущую итерацию — читает h, ведёт no-growth, уходит в контрольный
 * перемер, в ветки 'data-complete'/'top' и в перезапуск collapse-guard. План-отчёт
 * 2026-10-21 фиксировал именно это: если между await и следующей логикой есть работа,
 * выход по латчу случается только после неё (в отчёте — сетевой await ~4с, из-за чего
 * полоски/оверлей жили ещё 5с). На HEAD cd450ad сетевых await в теле цикла нет (ingest
 * синхронный, paginateLoop не ожидается), поэтому наблюдаемый дефект — не задержка, а
 * ПРИЧИНА выхода: fired посреди контрольного перемера превращался в 'top' и открывал
 * полноту оракула (stableCheck74 требует done=top, core/gemini-oracle.js:228).
 *
 * ФИКС. После каждого из восьми `await sleepUntilFired(...)` в теле цикла стоит гейт
 * `doneReason='export-done'; break;` — читается до любой следующей логики, включая голый
 * `continue`. Итого в файле 10 вхождений GATE_OPEN: 2 блочных (loop-head, collapse-guard)
 * + 8 пост-await. Новых guard'ов не потребовалось: наружный `sc` гарантированно не null
 * (предцикловой поиск возвращается раньше), поэтому done-лог и restore не тронуты.
 *
 * ПИНЫ (R-D: исходник + поведение на реальном коде модуля в vm):
 *   S1 — после каждого из восьми await первым исполняемым стейтментом идёт гейт;
 *   S2 — счёт гейтов: 10 всего = 2 блочных + 8 пост-await, все внутри while (true);
 *        loop-head остаётся первым (до iter++), collapse-guard — последним блочным;
 *   S3 — контракт v88.2 не сдвинут: хелпер один, окно 150 мс, восемь await, два D.sleep;
 *   R3 — E2E: fired посреди контрольного перемера (ветка с самой длинной пост-await-логикой)
 *        → reason='export-done', после fired нет ни одной итерации цикла;
 *   R4 — E2E-контроль: без fired тот же сценарий даёт 'top' — тест не тавтологичен;
 *   R5 — E2E: fired в ветке «скроллер недоступен» → выход на первом же пост-await гейте
 *        (одна итерация ожидания вместо тридцати), reason='export-done', без аварийного лога.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const LOADER_REL = 'core/gemini-loader-scroll.js';
const LOADER = fs.readFileSync(path.join(ROOT, LOADER_REL), 'utf8');

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/** Полный текст гейта одной строкой (как он записан в исходнике после каждого await). */
const GATE_LINE =
  "if (typeof aiCmFiredByConv !== 'undefined' && aiCmFiredByConv[convId]) { doneReason = 'export-done'; break; }";
/** Открывающая часть гейта — маркер для счёта вхождений (совпадает с пинами v88.1/v88.2). */
const GATE_OPEN = "if (typeof aiCmFiredByConv !== 'undefined' && aiCmFiredByConv[convId]) {";

const loopBody = () => {
  const start = LOADER.indexOf('while (true) {');
  const end = LOADER.indexOf('D.lastLoaderDoneReason = doneReason;');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return LOADER.slice(start, end);
};

// =====================================================================================
// S1/S2: источник — гейт после каждого await, счёт и порядок
// =====================================================================================
describe('v90.1 fired-after-await: S1 гейт после каждого await цикла', () => {
  test('S1: после каждого из восьми await первым исполняемым стейтментом идёт гейт export-done', () => {
    const parts = loopBody().split('await sleepUntilFired(');
    expect(parts).toHaveLength(9); // 8 await → 8 хвостов
    parts.slice(1).forEach((tail, i) => {
      const next = tail
        .split('\n')
        .slice(1)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('//'));
      expect({ await: i + 1, next: next[0] }).toEqual({ await: i + 1, next: GATE_LINE });
    });
  });

  test('S1: каждый гейт завершает итерацию немедленно — break, причина ровно export-done', () => {
    expect(countOf(LOADER, GATE_LINE)).toBe(8);
    // 'export-done' присваивается только гейтами (8 пост-await + 2 блочных) — иных источников нет
    expect(countOf(LOADER, "doneReason = 'export-done';")).toBe(10);
    // тело цикла после гейта продолжается только собственным break (или закрытием ветки) —
    // ни одного «гейт с последующей логикой» между await и выходом нет
    expect(loopBody()).not.toContain('break; } else');
  });
});

describe('v90.1 fired-after-await: S2 счёт гейтов и их порядок', () => {
  test('S2: 10 гейтов = 2 блочных (loop-head + collapse-guard) + 8 пост-await, все внутри цикла', () => {
    expect(countOf(LOADER, GATE_OPEN)).toBe(10);
    expect(countOf(loopBody(), GATE_OPEN)).toBe(10); // все гейты — в теле while (true)

    // loop-head гейт остался ПЕРВЫМ и стоит до iter++ (порядок v88.1 не сдвинут)
    const firstGate = LOADER.indexOf(GATE_OPEN);
    expect(firstGate).toBeGreaterThan(-1);
    expect(firstGate).toBeLessThan(LOADER.indexOf('iter++;'));

    // collapse-guard гейт — последний блочный: его блок содержит v88.1-лог подавления ретрая
    const lastGate = LOADER.lastIndexOf(GATE_OPEN);
    expect(lastGate).toBeGreaterThan(LOADER.indexOf('// v1.14.2 (COLLAPSE-GUARD): collapse ≠ top'));
    expect(LOADER.slice(lastGate, lastGate + 600)).toContain('collapse-retry suppressed reason=export-done');
    expect(LOADER.slice(lastGate - 900, lastGate)).toContain('fired уже состоялся');
  });
});

// =====================================================================================
// S3: контракт v88.2 не сдвинут
// =====================================================================================
describe('v90.1 fired-after-await: S3 контракт прерываемого сна не изменён', () => {
  test('S3: хелпер один, окно 150 мс, восемь await и два прямых D.sleep — как в v88.2', () => {
    expect(countOf(LOADER, 'async function sleepUntilFired(')).toBe(1);
    expect(LOADER).toContain('Math.min(150, ms - (Date.now() - start))');
    expect(countOf(LOADER, 'await sleepUntilFired(')).toBe(8);
    expect(countOf(LOADER, 'await D.sleep(')).toBe(2);
    // wall-clock fail-safe (v1.17) не тронут: объявление + единственный guard
    expect(countOf(LOADER, 'LOADER_RUN_WALL_CLOCK_MS')).toBe(2);
  });
});

// =====================================================================================
// E2E: реальный модуль в vm
// =====================================================================================
const CONV_ID = 'c-fired-after-await';

/**
 * Загрузка модуля в vm. Часы — фейковые (модуль читает только Date.now()), D.sleep двигает
 * их на ЗАПРОШЕННУЮ длительность. fired приходит window-событием (как из export-manager.js).
 *
 * opts.grow         — растёт ли scrollHeight при каждом поиске (иначе копится no-growth);
 * opts.fire         — 'recheck' (на контрольном перемере) | 'first' (первая пауза) | 'never';
 * opts.scrollerGone — после предциклового поиска контейнер «исчезает» (в цикле find → null).
 */
function makeHarness(opts) {
  opts = opts || {};
  const clock = { now: 1000000 };
  const calls = [];   // debugLog: { level, line, at }
  const windows = []; // D.sleep: { ms, at }
  let firedAt = -1;
  let firedHandler = null;
  let finds = 0;

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
    debugLog(level, line) { calls.push({ level: level, line: String(line), at: clock.now }); }
  });

  const container = {
    mode: 'el',
    el: { style: {}, dispatchEvent() { } },
    height() { return opts.grow ? 20000 + 300 * finds : 20000; },
    client() { return 800; },
    top() { return 0; },
    setTop() { }
  };

  function fire() {
    if (firedAt >= 0 || typeof firedHandler !== 'function') return;
    firedAt = clock.now;
    firedHandler({ detail: { convId: CONV_ID, reason: 'threshold' } });
  }

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
    baseSize() { return 120; }, // >= LOADER_HIDE_MIN_MSGS: hide применится (h>8000)
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
      deps.aiCmScrollOverlay = on ? { reason: reason } : null;
    },
    findScrollContainer() {
      finds++;
      if (opts.scrollerGone && finds > 1) return null;
      return container;
    },
    sleep(ms) {
      windows.push({ ms: ms, at: clock.now });
      const prev = calls[calls.length - 1];
      if (opts.fire === 'first' && windows.length === 1) fire();
      // контрольный перемер — первая пауза, начатая сразу после итерационного h-лога
      // (no-growth>=3); иные логи с ' h=' (hide-applied) отсекаются по 'scrollEngaged='
      if (opts.fire === 'recheck' && prev && prev.at === clock.now &&
          prev.line.indexOf('[AI CM][Gemini][loader] iter ') !== -1 &&
          prev.line.indexOf('scrollEngaged=') !== -1) fire();
      clock.now += ms;
      return Promise.resolve();
    },
    vf5OverlapSinceLoaderStart: false,
    isLowConfidenceBase: false
  };

  vm.runInContext(LOADER, ctx, { filename: LOADER_REL });
  const api = pageWindow.AiCmGeminiLoaderScroll;
  api.__bind(deps);
  return { api, deps, calls, windows, clock, getFiredAt: () => firedAt };
}

const doneLogs = (h) => h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] done reason=') !== -1);
const errorLogs = (h) => h.calls.filter((c) => c.line.indexOf('ошибка лоадера') !== -1);
const iterLogs = (h) => h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] iter ') !== -1);

describe('v90.1 fired-after-await: R3 fired посреди перемера → export-done', () => {
  test('R3: fired на контрольном перемере → reason=export-done; после fired ни одной итерации', async () => {
    const h = makeHarness({ grow: false, fire: 'recheck' });
    await h.api.loadFullHistoryInvisibly();

    const firedAt = h.getFiredAt();
    expect(firedAt).toBeGreaterThan(0);
    // сценарий действительно дошёл до перемера: без него no-growth-путь не проверить
    expect(iterLogs(h).length).toBeGreaterThanOrEqual(4);

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=export-done');
    expect(done[0].line).not.toContain('done reason=top');
    expect(h.deps.lastLoaderDoneReason).toBe('export-done');
    expect(errorLogs(h)).toHaveLength(0);

    // причина сменилась НЕ после лишней работы: после fired нет ни одного итерационного лога
    // (без пост-await гейта цикл успевал прочитать h/no-growth и уйти в ветку 'top');
    // h-лог, после которого случился fired, имеет тот же тик — он строго не «после»
    expect(iterLogs(h).filter((c) => c.at > firedAt)).toEqual([]);
    // и ни одно окно сна не началось после fired (хелпер вернулся, цикл вышел)
    expect(h.windows.filter((w) => w.at > firedAt)).toEqual([]);
    // задержка fired → done не превышает окно нарезки v88.2
    expect(done[0].at - firedAt).toBeLessThanOrEqual(150);
  });
});

describe('v90.1 fired-after-await: R4 контроль без fired', () => {
  test('R4: тот же сценарий без fired даёт top — R3 пинит именно эффект гейта', async () => {
    const h = makeHarness({ grow: false, fire: 'never' });
    await h.api.loadFullHistoryInvisibly();

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=top');
    expect(h.deps.lastLoaderDoneReason).toBe('top');
    expect(errorLogs(h)).toHaveLength(0);
  });
});

describe('v90.1 fired-after-await: R5 fired в ветке «скроллер недоступен»', () => {
  test('R5: скроллер исчез + fired → выход на первом же пост-await гейте, а не через 30 итераций', async () => {
    const h = makeHarness({ fire: 'first', scrollerGone: true });
    await h.api.loadFullHistoryInvisibly();

    expect(h.getFiredAt()).toBeGreaterThan(0);
    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=export-done');
    expect(h.deps.lastLoaderDoneReason).toBe('export-done');
    expect(errorLogs(h)).toHaveLength(0);

    // ровно одна итерация «ожидания скроллера»: гейт обрывает цикл, а не 30 итераций до 'max'
    expect(h.calls.filter((c) => c.line.indexOf('скроллер недоступен') !== -1)).toHaveLength(1);
    expect(iterLogs(h).filter((c) => c.line.indexOf('iter 2 ') !== -1)).toEqual([]);
    expect(done[0].at - h.getFiredAt()).toBeLessThanOrEqual(150);
  });
});
