/**
 * visible-scroll-guard (v97) — пины «Варианта б»: при СНЯТОМ оверлее лоадер не скроллит
 * страницу «в открытую».
 *
 * ПРЕДМЕТ. Живая жалоба: при холодном старте пользователь видел прыжки страницы
 * (мгновенный уход к началу чата и возврат). Источник — ветка страховочного скролла
 * (fallback-real-scroll): `sc.setTop(0)` + пауза 800 мс. Пока оверлей висит, прыжка не
 * видно; но оверлей снимался по 5-секундному UI-пределу (или был подавлен тейпом), и
 * следующий же фолбэк-скролл прокручивал УЖЕ ВИДИМЫЙ чат.
 *
 * ЧТО ПИНУЕТСЯ (три правки в core/gemini-loader-scroll.js):
 *
 *   D1  секретность скролла: реальный `sc.setTop(0)` остался РОВНО ОДИН и стоит под
 *       `if (D.aiCmScrollOverlay)`. Без оверлея вместо него работает приём rAF-ветки
 *       (v75): `scrollTop = 0` → синтетический scroll → `scrollTop = scrollHeight` в
 *       ОДНОМ кадре — браузер не успевает отрисовать промежуточное состояние.
 *       Пагинация в этом режиме не гарантирована (v78), это осознанный компромисс:
 *       лучше не догрузить старшие окна, чем дёрнуть страницей открытый чат.
 *   D2  гейт видимого скролла — по ФАКТУ маскировки: `if (!hiddenEl && !D.aiCmScrollOverlay)`.
 *       Нет ни DOM-маркера скрытия этого прогона, ни оверлея — скроллить нельзя вообще
 *       (ждём hide, кап — LOADER_MAX_ITER). Оверлей, поднятый централизованно
 *       (pre-applied loader-restart), тоже маскирует ленту -> под ним скроллить можно.
 *   D3  удержание оверлея: 5-секундный UI-предел НЕ снимает оверлей, пока прогон реально
 *       скроллит (`scrollEngaged` / `usedFallbackScroll`) и полнота не объявлена
 *       (`doneReason === 'max'`). Предел удержания — wall-clock прогона
 *       (LOADER_RUN_WALL_CLOCK_MS), он не тронут. Снятие по base-complete-early осталось
 *       БЕЗ условия удержания: полнота — законный повод открыть чат.
 *
 * R1  поведение в vm (оверлей живёт): каждый `setTop(0)` прогона случился ПРИ оверлее;
 *     ui-timeout не звонился даже после 5с; прогон дошёл до data-complete.
 *   R2  поведение в vm (оверлей снят посреди прогона): после снятия ни одного `setTop(0)`,
 *     скролл идёт только кадровым приёмом (el.scrollTop 0 → scrollHeight), с логом
 *     `fallback-scroll-invisible reason=no-overlay`; прогон жив, done штатный.
 *   R3  поведение в vm (тейп, оверлея не было вовсе): тот же кадровый приём, `setTop(0)`
 *     ноль раз — прыжок открытого чата не воспроизводится и в этом классе прогонов.
 *   R4  поведение в vm (нет маскировки): скролла нет вообще, цикл ждёт hide и упирается в
 *     кап `not-hidden-wait-cap` (v71 не сломан).
 *   R5  поведение в vm (pre-applied оверлей без hide): гейт по факту маскировки пропускает
 *     скролл под оверлеем — ожидание hide не включается.
 *
 * ГРАНИЦА: логика скрытого скролла (core/gemini-hidden-scroll.js) не тронута — она уже
 * работала верно (в v97 не менялась ни на байт).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TARGET_REL = 'core/gemini-loader-scroll.js';
const TARGET = readFile(TARGET_REL);
const HIDDEN_SCROLL_REL = 'core/gemini-hidden-scroll.js';

const CONV_ID = 'c-visible-scroll';

const SETTOP_SRC = 'try { sc.setTop(0); } catch (eSt1)';
const GATE_SRC = 'if (!hiddenEl && !D.aiCmScrollOverlay) {';
const HOLD_SRC = "usedFallbackScroll === true) && doneReason === 'max'";
const INVISIBLE_LOG = 'fallback-scroll-invisible reason=no-overlay';

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const LINES = TARGET.split('\n');

/** Индекс первой строки, удовлетворяющей предикату (или -1). */
function lineNo(pred) {
  for (let i = 0; i < LINES.length; i++) {
    if (pred(LINES[i], i)) return i;
  }
  return -1;
}

/** Индекс последней строки до limit, удовлетворяющей предикату (или -1). */
function lastLineBefore(limit, pred) {
  for (let i = limit - 1; i >= 0; i--) {
    if (pred(LINES[i], i)) return i;
  }
  return -1;
}

const SETTOP_IDX = lineNo((l) => l.indexOf(SETTOP_SRC) !== -1);
const GATE_IDX = lineNo((l) => l.indexOf(GATE_SRC) !== -1);
const HOLD_IDX = lineNo((l) => l.indexOf(HOLD_SRC) !== -1);

/**
 * Загрузка TARGET в vm-контекст. Часы двигаются только через D.sleep, поэтому сценарий
 * прогона детерминирован и не требует реального ожидания. Скроллер — обёртка с двумя
 * каналами записи:
 *   setTops  — вызовы sc.setTop() (реальный скролл «в открытую»);
 *   elWrites — записи в el.scrollTop (кадровый приём rAF-ветки).
 * Предмет приёмки — именно `setTop(0)` (прыжок к НАЧАЛУ чата). Ненулевые setTop в прогоне
 * тоже есть — это штатное возвращение позиции в __restoreLoader/applyRestoreTop80
 * (`height - client - distBottom`), то есть «остаться у дна», а не «дёрнуть к началу»;
 * они не результат прокрутки при сборе и исключаются фильтром `v === 0`.
 * У каждой записи записан факт видимости оверлея НА МОМЕНТ записи — именно он и есть
 * предмет приёмки «нет setTop(0) без оверлея».
 */
function makeHarness(opts) {
  const o = opts || {};
  const clock = { now: 1000000 };
  const clockStart = clock.now;
  const calls = [];    // debugLog: { line, at }
  const overlay = [];  // aiCmSetScrollOverlay: { on, reason, at }
  const finds = [];    // findScrollContainer: [at]
  const setTops = [];  // sc.setTop(v): { v, at, overlay }
  const elWrites = []; // el.scrollTop = v: { v, at, overlay }

  function Ev(type) { this.type = type; }
  function CustomEv(type, init) {
    this.type = type;
    this.detail = (init && init.detail) || null;
  }

  const pageWindow = { dispatchEvent() { } };
  const pageDocument = { visibilityState: 'visible', addEventListener() { } };

  const el = {
    style: {},
    dispatchCount: 0,
    scrollHeight: o.elScrollHeight || 40000,
    _top: 0,
    _writes: elWrites,
    dispatchEvent() { el.dispatchCount++; }
  };
  Object.defineProperty(el, 'scrollTop', {
    get() { return el._top; },
    set(v) { el._top = v; elWrites.push({ v: v, at: clock.now, overlay: !!deps.aiCmScrollOverlay }); }
  });

  const container = {
    mode: 'el',
    el: el,
    // Высота растёт вместе с числом поисков скроллера (+300 за итерацию): цикл видит рост
    // и не уходит в no-growth/top ветки раньше штатной полноты.
    height() {
      const n = (o.freezeHeightAfterFind || 0) > 0
        ? Math.min(finds.length, o.freezeHeightAfterFind)
        : finds.length;
      return (o.baseHeight || 20000) + 300 * n;
    },
    client() { return 800; },
    top() { return 0; },
    setTop(v) {
      setTops.push({ v: v, at: clock.now, overlay: !!deps.aiCmScrollOverlay });
      el._top = v; // прямой запрос: elWrites считает только кадровый приём
    }
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
    baseSize() { return (o.baseSize || 120); },
    loadFloor() { return { count: 0 }; },
    olderHistorySeen: o.olderHistorySeen === true,
    reachedStart: false,
    historyFullByQuiet: false,
    baseComplete: false,
    pendingCursor: null,
    quietEndedClean: false,
    tapeWasUsedInThisColdStart: o.tapePresent === true,
    // pre-applied оверлей (напр. loader-restart) — маскировка есть, а hide в этом прогоне нет
    aiCmScrollOverlay: o.preAppliedOverlay === true ? { reason: 'loader-restart' } : null,
    aiCmOverlaySeq: 0,
    aiCmSetScrollOverlay(on, reason, expectSeq) {
      overlay.push({ on: !!on, reason: reason, expectSeq: expectSeq, at: clock.now });
      deps.aiCmScrollOverlay = on ? { reason: reason } : null;
    },
    findScrollContainer() {
      finds.push(clock.now);
      // Снятие оверлея «как по 5-секундному пределу»: маска исчезла, прогон продолжается.
      if (o.dropOverlayAfterFind && finds.length >= o.dropOverlayAfterFind) {
        deps.aiCmScrollOverlay = null;
        deps.aiCmUiOverlayTimedOut = true;
      }
      if (finds.length >= (o.completeAtFind || 6)) {
        deps.historyFullByQuiet = true;
        deps.reachedStart = true;
      }
      return container;
    },
    sleep() {
      clock.now += o.stepMs || 2000;
      return Promise.resolve();
    },
    vf5OverlapSinceLoaderStart: false,
    isLowConfidenceBase: false
  };

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

  vm.runInContext(TARGET, ctx, { filename: TARGET_REL });
  const api = pageWindow.AiCmGeminiLoaderScroll;
  api.__bind(deps);
  return { api, deps, calls, overlay, finds, setTops, elWrites, el, clock, clockStart };
}

const doneLogs = (h) =>
  h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] done reason=') !== -1);

// =====================================================================================
// D1: реальный скролл «в открытую» остался ровно один и только под оверлеем
// =====================================================================================
describe('visible-scroll-guard: D1 скролл только под оверлеем', () => {
  test('D1: sc.setTop(0) в файле ровно один — под `if (D.aiCmScrollOverlay)`', () => {
    expect(SETTOP_IDX).toBeGreaterThan(-1);
    expect(countOf(TARGET, 'sc.setTop(0)')).toBe(1);

    // строка-гейт: ровно `if (D.aiCmScrollOverlay) {` — без латча и без условия полноты
    const guardIdx = lastLineBefore(SETTOP_IDX, (l) => /^\s*if \(D\.aiCmScrollOverlay\) \{\s*$/.test(l));
    expect(guardIdx).toBeGreaterThan(-1);
    expect(SETTOP_IDX - guardIdx).toBe(1); // вызов — первая строка ветки
  });

  test('D1: ветка else — кадровый приём rAF-ветки, без setTop и без паузы', () => {
    const guardIdx = lastLineBefore(SETTOP_IDX, (l) => /^\s*if \(D\.aiCmScrollOverlay\) \{\s*$/.test(l));
    const elseIdx = lineNo((l, i) => i > SETTOP_IDX && /^\s*\} else \{\s*$/.test(l));
    expect(elseIdx).toBeGreaterThan(SETTOP_IDX);
    expect(elseIdx - SETTOP_IDX).toBeLessThanOrEqual(3); // ровно две строки старой ветки

    // в else — та же тройка, что в rAF-ветке v75: 0 -> dispatch scroll -> scrollHeight
    const zeroIdx = lineNo((l) => l.indexOf('el97.scrollTop = 0;') !== -1);
    const dispIdx = lineNo((l) => l.indexOf("el97.dispatchEvent(new Event('scroll'))") !== -1);
    const bottomIdx = lineNo((l) => l.indexOf('el97.scrollTop = el97.scrollHeight;') !== -1);
    expect(zeroIdx).toBeGreaterThan(elseIdx);
    expect(dispIdx).toBeGreaterThan(zeroIdx);
    expect(bottomIdx).toBeGreaterThan(dispIdx);

    // в else-ветке нет ни setTop, ни повторного подъёма оверлея
    const elseBlock = LINES.slice(elseIdx, bottomIdx + 4).join('\n');
    expect(elseBlock).not.toContain('sc.setTop(0)');
    expect(elseBlock).not.toContain('aiCmSetScrollOverlay');

    // обе тройки (v75 rAF-ветка и v97 else) существуют независимо
    expect(countOf(TARGET, '.scrollTop = 0;')).toBe(2);
    expect(countOf(TARGET, 'scrollTop = el75.scrollHeight;')).toBe(1);
    expect(countOf(TARGET, 'scrollTop = el97.scrollHeight;')).toBe(1);
    // и вход в этот режим залогирован собственной причиной
    expect(countOf(TARGET, INVISIBLE_LOG)).toBe(1);
  });

  test('D1: комментарий фиксирует компромисс (пагинация не гарантирована)', () => {
    expect(TARGET).toContain('v97 (VISIBLE-SCROLL-GUARD): скролл «в открытую» запрещён.');
    expect(TARGET).toContain('лучше не догрузить');
  });
});

// =====================================================================================
// D2: гейт видимого скролла — по факту маскировки
// =====================================================================================
describe('visible-scroll-guard: D2 гейт по факту маскировки', () => {
  test('D2: условие — нет hiddenEl И нет оверлея (старая форма `if (!hiddenEl)` ушла)', () => {
    expect(GATE_IDX).toBeGreaterThan(-1);
    expect(countOf(TARGET, GATE_SRC)).toBe(1);
    expect(countOf(TARGET, 'if (!hiddenEl) {')).toBe(0);
    // гейт остался гейтом ожидания hide: следующая строка — счётчик ожидания
    expect(LINES[GATE_IDX + 1]).toContain('notHiddenWait++');
  });

  test('D2: ветка ожидания не тронута (v71 + clean-end-unscrollable + кап)', () => {
    expect(countOf(TARGET, 'visible-scroll-skipped reason=not-hidden')).toBe(1);
    expect(countOf(TARGET, "doneReason = 'clean-end-unscrollable';")).toBe(1);
    expect(countOf(TARGET, "doneReason = 'not-hidden-wait-cap';")).toBe(1);
    // гейт стоит ПЕРЕД скроллом: ожидание не даёт ни одной записи в скроллер
    expect(GATE_IDX).toBeLessThan(SETTOP_IDX);
    expect(TARGET).toContain('v97 (MASK-GATE): гейт — по ФАКТУ маскировки');
  });
});

// =====================================================================================
// D3: удержание оверлея при активном скролле
// =====================================================================================
describe('visible-scroll-guard: D3 удержание оверлея (OVERLAY-HOLD)', () => {
  test('D3: 5с-предел не снимает оверлей при scrollEngaged/usedFallbackScroll и незавершённом прогоне', () => {
    expect(HOLD_IDX).toBeGreaterThan(-1);
    const guard = LINES[HOLD_IDX];
    expect(guard).toContain('Date.now() - runStartAt > 5000');
    expect(guard).toContain('D.aiCmScrollOverlay');
    expect(guard).toContain('D.loaderState.scrollEngaged === true');
    expect(guard).toContain(HOLD_SRC);
    // снятие и латч остались в той же строке, break/return не появились
    expect(guard).toContain("D.aiCmSetScrollOverlay(false, 'ui-timeout')");
    expect(guard).toContain('D.aiCmUiOverlayTimedOut = true');
    expect(guard).not.toMatch(/\bbreak\b|\breturn\b/);
  });

  test('D3: wall-clock остаётся жёстким пределом удержания', () => {
    expect(countOf(TARGET, 'LOADER_RUN_WALL_CLOCK_MS')).toBe(2); // объявление + guard
    expect(TARGET).toContain('var LOADER_RUN_WALL_CLOCK_MS = 90000;');
    // держим не дольше прогона: отдельного таймера удержания нет
    expect(countOf(TARGET, 'ui-timeout')).toBe(1);
  });

  test('D3: снятие по полноте базы условием удержания НЕ загейчено', () => {
    const earlyIdx = lineNo((l) => l.indexOf("D.aiCmSetScrollOverlay(false, 'base-complete-early')") !== -1);
    expect(earlyIdx).toBeGreaterThan(-1);
    // условие снятия — только видимость оверлея и факт полноты (см. ui-timeout D4)
    const condIdx = lastLineBefore(earlyIdx, (l) => l.indexOf('__baseCompleteNow87 &&') !== -1);
    expect(condIdx).toBeGreaterThan(-1);
    expect(LINES[condIdx]).not.toContain('scrollEngaged');
    expect(LINES[condIdx]).not.toContain('usedFallbackScroll');
  });

  test('D3: скрытый скролл (core/gemini-hidden-scroll.js) не тронут по контракту', () => {
    const hs = readFile(HIDDEN_SCROLL_REL);
    expect(hs).toContain('function makeScroller(');
    expect(hs).toContain('setTop: function (v) { el.scrollTop = v; }');
    expect(hs).toContain('function triggerUp(sc)');
    // и лоадер по-прежнему ходит в него через единственный фасад
    expect(countOf(TARGET, 'D.findScrollContainer()')).toBeGreaterThanOrEqual(1);
  });
});

// =====================================================================================
// R1: поведение — оверлей живёт, все скроллы под ним, ui-timeout молчит
// =====================================================================================
describe('visible-scroll-guard: R1 оверлей живёт весь скролл', () => {
  test('R1: ни одного setTop(0) без оверлея; ui-timeout не звонится; done=data-complete', async () => {
    const h = makeHarness({ stepMs: 2000, completeAtFind: 10 });

    await h.api.loadFullHistoryInvisibly();

    // скролл «в открытую» был и он весь — под маской
    const ups = h.setTops.filter((c) => c.v === 0);
    expect(ups.length).toBeGreaterThanOrEqual(5);
    for (const c of ups) {
      expect(c.overlay).toBe(true); // КРИТЕРИЙ ПРИЁМКИ: нет setTop(0) без оверлея
    }
    // 5-секундный предел пройден — и именно поэтому проверка содержательна
    expect(ups[ups.length - 1].at - h.clockStart).toBeGreaterThan(5000);

    // UI-предел молчит: держим до реального конца скролла (v97 OVERLAY-HOLD)
    expect(h.overlay.filter((c) => c.reason === 'ui-timeout')).toHaveLength(0);
    // оверлей поднимался ровно один раз — штатным hide
    expect(h.overlay.filter((c) => c.on).map((c) => c.reason)).toEqual(['loader']);
    // снятие — по полноте базы, затем штатный loader-done; без прыжков в открытую ленту
    expect(h.overlay.filter((c) => !c.on).map((c) => c.reason)).toEqual(['base-complete-early', 'loader-done']);

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=data-complete');
    // кадровый приём в этом сценарии не нужен: под маской скроллим реально
    expect(h.calls.filter((c) => c.line.indexOf(INVISIBLE_LOG) !== -1)).toHaveLength(0);
  });
});

// =====================================================================================
// R2: оверлей снят посреди прогона — дальше только кадровый приём
// =====================================================================================
describe('visible-scroll-guard: R2 оверлей снят посреди прогона', () => {
  test('R2: после снятия оверлея setTop(0) не зовётся, скролл идёт кадровым приёмом', async () => {
    const h = makeHarness({ stepMs: 2000, completeAtFind: 8, dropOverlayAfterFind: 3 });

    await h.api.loadFullHistoryInvisibly();

    // до снятия — реальный скролл, и он под маской
    const ups = h.setTops.filter((c) => c.v === 0);
    expect(ups.length).toBeGreaterThanOrEqual(1);
    for (const c of ups) expect(c.overlay).toBe(true);

    // после снятия — ни одной прокрутки к началу чата (иначе пользователь увидел бы прыжок)
    const dropAt = ups[ups.length - 1].at;
    expect(h.setTops.filter((c) => c.v === 0 && c.at > dropAt)).toHaveLength(0);

    // кадровый приём: пары 0 -> scrollHeight, каждая пара в одном кадре (rAF синхронный)
    const writes = h.elWrites.filter((w) => w.at >= dropAt);
    expect(writes.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < writes.length; i += 2) {
      expect(writes[i].v).toBe(0);
      expect(writes[i].overlay).toBe(false);
      expect(writes[i + 1].v).toBe(h.el.scrollHeight);
    }
    // синтетический scroll толкает пагинацию и в кадровом режиме
    expect(h.el.dispatchCount).toBeGreaterThanOrEqual(2);
    // причина видна в логе — режим не «тихий»
    expect(h.calls.filter((c) => c.line.indexOf(INVISIBLE_LOG) !== -1).length).toBeGreaterThanOrEqual(4);

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=data-complete');
  });
});

// =====================================================================================
// R3: тейп — оверлея не было вовсе, прыжка тоже нет
// =====================================================================================
describe('visible-scroll-guard: R3 тейп (оверлей подавлен)', () => {
  test('R3: без оверлея setTop(0) ноль раз, работает кадровый приём', async () => {
    const h = makeHarness({ stepMs: 2000, completeAtFind: 8, tapePresent: true });

    await h.api.loadFullHistoryInvisibly();

    expect(h.overlay.filter((c) => c.on)).toHaveLength(0); // оверлей подавлен тейпом
    expect(h.setTops.filter((c) => c.v === 0)).toHaveLength(0); // и скролла к началу нет
    expect(h.elWrites.length).toBeGreaterThanOrEqual(4);
    expect(h.elWrites[0].v).toBe(0);
    expect(h.elWrites[1].v).toBe(h.el.scrollHeight);
    expect(h.calls.filter((c) => c.line.indexOf(INVISIBLE_LOG) !== -1).length).toBeGreaterThanOrEqual(2);

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=data-complete');
  });
});

// =====================================================================================
// R4: маскировки нет — скролла нет вовсе (v71 не сломан)
// =====================================================================================
describe('visible-scroll-guard: R4 нет маскировки — нет скролла', () => {
  test('R4: короткий чат без оверлея не скроллит и упирается в not-hidden-wait-cap', async () => {
    const h = makeHarness({ stepMs: 100, baseHeight: 5000, baseSize: 20, completeAtFind: 999 });

    await h.api.loadFullHistoryInvisibly();

    expect(h.setTops).toHaveLength(0);
    expect(h.elWrites).toHaveLength(0); // никакого скролла, даже кадрового
    const skipped = h.calls.filter((c) => c.line.indexOf('visible-scroll-skipped reason=not-hidden') !== -1);
    expect(skipped.length).toBe(29); // LOADER_MAX_ITER - 1: на 30-м — break до лога
    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=not-hidden-wait-cap');
  });
});

// =====================================================================================
// R5: pre-applied оверлей без hide — маска есть, скролл разрешён
// =====================================================================================
describe('visible-scroll-guard: R5 pre-applied оверлей', () => {
  test('R5: под централизованно поднятым оверлеем скроллим, ожидание hide не включается', async () => {
    const h = makeHarness({
      stepMs: 2000, baseHeight: 5000, baseSize: 20, completeAtFind: 3, preAppliedOverlay: true
    });

    await h.api.loadFullHistoryInvisibly();

    // гейт пропустил: маскировка есть, хотя hide в этом прогоне не применялся
    expect(h.deps.loaderState.hideApplied).toBe(false);
    const ups = h.setTops.filter((c) => c.v === 0);
    expect(ups.length).toBeGreaterThanOrEqual(1);
    for (const c of ups) expect(c.overlay).toBe(true);
    // ветка ожидания hide не включалась
    expect(h.calls.filter((c) => c.line.indexOf('visible-scroll-skipped') !== -1)).toHaveLength(0);
    // кадровый приём v75 мог сработать на итерации полноты — но и он только под маской
    for (const w of h.elWrites) expect(w.overlay).toBe(true);

    const done = doneLogs(h);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=data-complete');
  });
});
