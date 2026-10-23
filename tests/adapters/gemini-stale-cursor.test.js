/**
 * v94 (STALE PENDINGCURSOR): ранний выход `base-complete-stall` из цикла лоадера.
 *
 * ПРЕДМЕТ. План-отчёт 2026-10-23 (лог живого прогона): сервер объявил базу полной
 * (baseComplete=1 / historyFullByQuiet=1 приходит от серверной пробы probe-terminal),
 * высота скроллера перестала расти, но `pendingCursor=1` — ложная эвристика
 * `classifyOpaque` (ищет b64-строки в УЖЕ ПОЛНОМ снапшоте) — держал цикл в stall-retry
 * до `LOADER_STALL_CAP=90` итераций (~108с). Исторический выход
 * `historyFullByQuiet && reachedStart && !pendingCursor` (:469) не срабатывал именно
 * из-за живого курсора, то есть цикл крутился при уже доказанной полноте.
 *
 * ФИКС. В ветке `noGrowth >= LOADER_STABLE_NEED`, ПОСЛЕ контрольного перемера (:473, там
 * же обработка resume-роста) и ДО ветки `if (D.pendingCursor)` (:484) стоит проверка
 *   if (D.historyFullByQuiet === true && D.reachedStart === true) {
 *     doneReason = 'base-complete-stall'; break;
 *   }
 * Смысл: полнота подтверждена сервером + высота не росла LOADER_STABLE_NEED итераций =
 * курсор застоявшийся, а не живой. Рост h обрабатывается выше (resume → continue),
 * поэтому пагинация не затронута; wall-clock (90с), кап 90 и fired-гейты не тронуты;
 * причина не 'top' — вердикт полноты оракула не открывается (core/gemini-oracle.js:238).
 *
 * ПИНЫ (R-D: источник + поведение РЕАЛЬНОГО модуля в vm):
 *   D1 — источник: выход ровно один, стоит после no-growth-ветки и ДО `if (D.pendingCursor)`,
 *        требует ОБА серверных признака (и НЕ требует отсутствия курсора); кап, timeout,
 *        wall-clock и восемь fired-гейтов на месте;
 *   D2 — vm: pendingCursor=1 + полная база + замершая h → 'base-complete-stall' за 4 итерации
 *        (не 90), ни одного stall-retry, до wall-clock дело не дошло;
 *   D3 — vm: тот же сценарий, но h РАСТЁТ → ранний выход не взводится, цикл живёт до
 *        прежнего wall-clock-предела (пагинация не срезана);
 *   D4 — vm-контроль: полная база + замершая h + pendingCursor=null → 'data-complete'
 *        (новый выход не подменил исторический путь).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const LOADER_REL = 'core/gemini-loader-scroll.js';
const LOADER = fs.readFileSync(path.join(ROOT, LOADER_REL), 'utf8');

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const CONV_ID = 'c-stale-cursor';
const STALL_REASON = "doneReason = 'base-complete-stall'";
const DATA_COMPLETE = "if (D.historyFullByQuiet === true && D.reachedStart === true && !D.pendingCursor) {";

// =====================================================================================
// D1: источник — место, условие, неприкосновенность соседних контрактов
// =====================================================================================
describe('v94 stale-cursor: D1 источник', () => {
  test('D1: base-complete-stall объявлен ровно один раз, тело — break с этой причиной', () => {
    expect(countOf(LOADER, STALL_REASON)).toBe(1);
    expect(LOADER).toContain(
      "if (D.historyFullByQuiet === true && D.reachedStart === true) {\n" +
        "                doneReason = 'base-complete-stall';\n" +
        '                break;\n' +
        '              }'
    );
  });

  test('D1: выход стоит после no-growth/resume и ДО ветки D.pendingCursor', () => {
    const iNoGrowth = LOADER.indexOf('if (noGrowth >= LOADER_STABLE_NEED) {');
    const iResume = LOADER.indexOf('if (hc > lastH + LOADER_RESUME_DELTA) {');
    const iStall = LOADER.indexOf(STALL_REASON);
    const iPending = LOADER.indexOf('if (D.pendingCursor) {', iNoGrowth);

    expect(iNoGrowth).toBeGreaterThan(-1);
    expect(iResume).toBeGreaterThan(iNoGrowth);
    expect(iStall).toBeGreaterThan(iResume); // рост h обрабатывается раньше → пагинация цела
    expect(iStall).toBeLessThan(iPending); // и раньше stall-retry (иначе 90 итераций)
  });

  test('D1: условие требует ОБА серверных признака и не зависит от отсутствия курсора', () => {
    // историческая ветка data-complete (с !pendingCursor) не тронута и по-прежнему на месте
    expect(countOf(LOADER, DATA_COMPLETE)).toBe(3); // loop-head (:274) + перемер (:469) + fallback (:919)
    // новый выход не содержит !pendingCursor — он и есть исключение из инварианта
    expect(countOf(LOADER, "if (D.historyFullByQuiet === true && D.reachedStart === true) {")).toBe(1);
  });

  test('D1: кап, кап-timeout, wall-clock и fired-гейты не тронуты', () => {
    expect(countOf(LOADER, 'LOADER_STALL_CAP = 90')).toBe(1);
    expect(countOf(LOADER, "doneReason = 'timeout';")).toBe(1);
    expect(countOf(LOADER, 'LOADER_RUN_WALL_CLOCK_MS')).toBe(2);
    expect(countOf(LOADER, "'wall-clock-timeout'")).toBe(1);
    expect(countOf(LOADER, 'await sleepUntilFired(')).toBe(8);
  });
});

// =====================================================================================
// E2E: реальный модуль в vm (фейковые часы — модуль читает только Date.now())
// =====================================================================================
/**
 * opts.grow      — растёт ли scrollHeight на каждом поиске контейнера (иначе копится no-growth);
 * opts.complete  — сервер уже подтвердил полноту (historyFullByQuiet+reachedStart); default true;
 * opts.pending   — false → pendingCursor=null; иначе живой (застоявшийся) курсор 'cur-stale'.
 */
function makeHarness(opts) {
  opts = opts || {};
  const clock = { now: 1000000 };
  const clockStart = clock.now;
  const calls = []; // debugLog → { level, line, at }
  const windows = []; // D.sleep → { ms, at }
  let finds = 0;

  function Ev(type) { this.type = type; }
  function CustomEv(type, init) { this.type = type; this.detail = (init && init.detail) || null; }

  const pageWindow = { addEventListener() { }, dispatchEvent() { } };
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
    baseSize() { return 120; }, // >= LOADER_HIDE_MIN_MSGS: hide применяется (h>8000)
    loadFloor() { return { count: 0 }; },
    olderHistorySeen: true,
    reachedStart: opts.complete !== false,
    historyFullByQuiet: opts.complete !== false,
    pendingCursor: opts.pending === false ? null : 'cur-stale',
    quietEndedClean: false,
    tapeWasUsedInThisColdStart: false,
    aiCmScrollOverlay: null,
    aiCmUiOverlayTimedOut: false,
    aiCmOverlaySeq: 0,
    aiCmSetScrollOverlay(on, reason) { deps.aiCmScrollOverlay = on ? { reason: reason } : null; },
    findScrollContainer() { finds++; return container; },
    sleep(ms) { windows.push({ ms: ms, at: clock.now }); clock.now += ms; return Promise.resolve(); },
    vf5OverlapSinceLoaderStart: false,
    isLowConfidenceBase: false
  };

  vm.runInContext(LOADER, ctx, { filename: LOADER_REL });
  const api = pageWindow.AiCmGeminiLoaderScroll;
  api.__bind(deps);
  return { api, deps, calls, windows, clock, clockStart };
}

const doneLogs = (h) => h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] done reason=') !== -1);
// только итерационный лог высоты (не «iter N cursor-epoch…» и не «iter N hide-applied…»)
const iterLogs = (h) => h.calls.filter(
  (c) => c.line.indexOf('[AI CM][Gemini][loader] iter ') !== -1 && c.line.indexOf(' scrollEngaged=') !== -1
);
const stallLogs = (h) => h.calls.filter((c) => c.line.indexOf('stall-retry') !== -1);
const errorLogs = (h) => h.calls.filter((c) => c.line.indexOf('ошибка лоадера') !== -1);

describe('v94 stale-cursor: D2 ложный курсор при полной базе → ранний выход', () => {
  test('D2: complete + h замерла + pendingCursor=1 → base-complete-stall за 4 итерации', async () => {
    const h = makeHarness({ grow: false });
    await h.api.loadFullHistoryInvisibly();

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=base-complete-stall');
    expect(h.deps.lastLoaderDoneReason).toBe('base-complete-stall');

    // цикл прерван сразу по факту стабильности высоты, а не на 90-м stall-retry
    expect(iterLogs(h)).toHaveLength(4);
    expect(iterLogs(h).length).toBeLessThanOrEqual(4);
    expect(stallLogs(h)).toEqual([]);
    // и это не аварийный путь: ни ошибок лоадера, ни 90-секундного предела
    expect(errorLogs(h)).toHaveLength(0);
    expect(done[0].at - h.clockStart).toBeLessThan(90000);
    expect(h.windows.filter((w) => w.ms === 800).length).toBeLessThan(90);
  });
});

describe('v94 stale-cursor: D3 рост высоты не срезается', () => {
  test('D3: complete + h РАСТЁТ + pendingCursor=1 → цикл продолжается до wall-clock', async () => {
    const h = makeHarness({ grow: true });
    await h.api.loadFullHistoryInvisibly();

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).not.toContain('base-complete-stall');
    expect(h.deps.lastLoaderDoneReason).not.toBe('base-complete-stall');
    // пагинация действительно шла — итераций заметно больше порога стабильности
    expect(iterLogs(h).length).toBeGreaterThan(4);
    expect(errorLogs(h)).toHaveLength(0);
    // прежний контракт: курсор живой → ни LOADER_MAX_ITER, ни стабильность, только wall-clock
    expect(done[0].line).toContain('done reason=wall-clock-timeout');
  });
});

describe('v94 stale-cursor: D4 контроль — исторический data-complete цел', () => {
  test('D4: complete + замершая h + pendingCursor=null → data-complete (не новый выход)', async () => {
    const h = makeHarness({ grow: false, pending: false });
    await h.api.loadFullHistoryInvisibly();

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=data-complete');
    expect(done[0].line).not.toContain('base-complete-stall');
    expect(h.deps.lastLoaderDoneReason).toBe('data-complete');
    expect(errorLogs(h)).toHaveLength(0);
  });
});
