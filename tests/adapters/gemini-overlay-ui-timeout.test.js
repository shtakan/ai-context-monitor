/**
 * overlay-ui-timeout (v2.0.17 → v87.1) — пины UI-снятия оверлея лоадера.
 *
 * ПРЕДМЕТ. В core/gemini-loader-scroll.js три связанные правки:
 *   1) LOADER_STALL_CAP возвращён к 90 (кап ретраев скролла при живом continuation-курсоре):
 *      снижение 90→20 рисковало оборвать загрузку полной истории на истинно холодном старте;
 *   2) в цикле while (true), сразу после iter++, добавлен UI-таймаут: по его срабатыванию
 *      оверлей снимается (пользователь видит чат), а фоновый цикл ПРОДОЛЖАЕТСЯ до
 *      LOADER_RUN_WALL_CLOCK_MS (90с) или до штатного doneReason. v87.1: предел снижен
 *      30000→5000 мс — живая приёмка 2026-10-20 показала оверлей, висевший 34с;
 *   3) v87.1 (base-complete-early): база объявлена полной → оверлей снимается НЕМЕДЛЕННО
 *      (`D.aiCmSetScrollOverlay(false, 'base-complete-early')`), не дожидаясь UI-предела.
 *      В том же логе baseComplete=1 пришёл через 9с, но живой pendingCursor=1 держал цикл
 *      в stall-retry, и экран оставался закрытым до срабатывания таймаута.
 * Пинятся ровно те свойства, ради которых правка сделана:
 *
 *   D1  кап: 'LOADER_STALL_CAP = 90' ровно один, '= 20' — ноль, исторический
 *       комментарий v53 (0362260d / pct=56.2) снова на месте — кап вернулся ОСОЗНАННО,
 *       вместе с обоснованием, а не просто числом.
 *   D2  место вставки: вызов стоит ВНУТРИ while (true), ПОСЛЕ iter++ и ДО первого в
 *       цикле чтения D.pendingCursor (т.е. на каждой итерации, до любых решений о
 *       полноте/скролле); wall-clock guard (90с) остаётся первой строкой цикла.
 *   D3  фон не останавливается: в строке таймаута нет break/return; ветка
 *       страховочного скролла после таймаута не поднимает оверлей заново (латч
 *       D.aiCmUiOverlayTimedOut, живёт в D — фрагменты цикла исполняются и в
 *       песочницах, где нет модульных замыканий) — иначе снятие и повторный подъём
 *       случились бы в одном тике и правка была бы визуально пустой; wall-clock
 *       guard (90с) не тронут.
 *   D4  v87.1 base-complete-early: проверка полноты базы стоит в том же цикле (после
 *       UI-предела), снимает оверлей причиной 'base-complete-early' только когда он
 *       реально виден, и взводит тот же латч — restore после этого работает вхолостую,
 *       а не поднимает экран обратно. Ветка data-complete (её гейты base|начало|курсор)
 *       не тронута: снятие оверлея — видимость UI, а не вердикт полноты.
 *   R1  проверенный соседний код не сдвинут: main-anchor (sc = D.findScrollContainer()),
 *       __applyHide/__restoreLoader и контракт скрытия в core/gemini-overlay.js
 *       (снятие без expectSeq убирает оверлей всегда) — на месте. Соседние сьюты
 *       (gemini-loader-reentry-diag, gemini-scroll-stall-fix) остаются зелёными.
 *   R2  поведение в vm: на макете D с фейковыми часами цикл доходит до UI-предела (5с),
 *       снимает оверлей РОВНО ОДИН РАЗ (reason=ui-timeout), после снятия не поднимает его
 *       заново и продолжает работать (ещё есть sleep/итерации) до штатного done
 *       reason=data-complete; если оверлея не было (лента восстановлена тейпом) —
 *       таймаут не зовётся вовсе.
 *   R3  v87.1 поведение base-complete-early: при baseComplete=1 и ЖИВОМ pendingCursor
 *       (сценарий лога 2026-10-20) оверлей снимается раньше 5с и вместо таймаута, после
 *       снятия не поднимается, а прогон доходит до своего терминального done — wall-clock
 *       (90с) остаётся жёстким пределом.
 *
 * Почему 5с, а не wall-clock: приёмка 2026-10-18 показала, что кап=20 даёт быструю
 * загрузку на F5/SPA, но не покрывает истинный холодный старт (>12ч), а wall-clock=90с
 * сам по себе не помогает пользователю, пока сервер отдаёт данные 10–15с — всё это время
 * оверлей блокирует экран. Отсюда два независимых предела: UI-видимость (30с → 5с) и
 * жёсткий предел самого прогона (90с).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TARGET_REL = 'core/gemini-loader-scroll.js';
const TARGET = readFile(TARGET_REL);
const OVERLAY_REL = 'core/gemini-overlay.js';
const OVERLAY = readFile(OVERLAY_REL);

const CONV_ID = 'c-ui-timeout';
const UI_TIMEOUT_CALL = "D.aiCmSetScrollOverlay(false, 'ui-timeout')";
const EARLY_CALL = "D.aiCmSetScrollOverlay(false, 'base-complete-early')";
const EARLY_REASON = 'base-complete-early';

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

const GUARD_IDX = lineNo((l) => l.indexOf(UI_TIMEOUT_CALL) !== -1);
const EARLY_IDX = lineNo((l) => l.indexOf(EARLY_CALL) !== -1);

/**
 * Загрузка TARGET в отдельный vm-контекст. Часы подменены: модуль читает время только
 * через Date.now() (new Date/performance в файле отсутствуют), поэтому фейковые часы
 * двигаются ровно на длительность D.sleep — цикл прогоняется целиком, без реального
 * ожидания. Отложенные таймеры (collapse-ретраи, kickBack) заглушены: тест про цикл,
 * а не про пост-обработку.
 */
function makeHarness(opts) {
  const options = opts || {};
  const clock = { now: 1000000 };
  const clockStart = clock.now;
  const calls = [];    // debugLog: { level, line, at }
  const overlay = [];  // aiCmSetScrollOverlay: { on, reason, expectSeq, at }
  const finds = [];    // findScrollContainer: [at]
  const sleeps = [];   // sleep: [at]

  function Ev(type) { this.type = type; }
  function CustomEv(type, init) {
    this.type = type;
    this.detail = (init && init.detail) || null;
  }

  const pageWindow = { dispatchEvent() { } };
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
    debugLog(level, line) {
      calls.push({ level, line: String(line), at: clock.now });
    }
  });

  const container = {
    mode: 'el',
    el: { style: {}, dispatchEvent() { } },
    // Высота растёт вместе с числом обращений поиска скроллера (+300 за итерацию):
    // цикл видит «рост» и не уходит в no-growth/top ветки до проверяемого таймаута.
    // options.freezeHeightAfterFind замораживает рост после указанного поиска — так
    // воспроизводится сценарий лога 2026-10-20: база полная, курсор жив, высота стабильна
    // → цикл уходит в stall-retry и живёт до ui-timeout/wall-clock.
    height() {
      const n = (options.freezeHeightAfterFind || 0) > 0
        ? Math.min(finds.length, options.freezeHeightAfterFind)
        : finds.length;
      return 20000 + 300 * n;
    },
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
    baseSize() { return 120; }, // >= LOADER_HIDE_MIN_MSGS (50)
    loadFloor() { return { count: 0 }; },
    olderHistorySeen: true,
    reachedStart: false,
    historyFullByQuiet: false,
    // v87.1: алиас признака полноты. Боевой депс его не отдаёт (там historyFullByQuiet),
    // поэтому ветка проверяется отдельным пином — модуль обязан читать оба имени.
    baseComplete: options.baseCompleteAlias === true,
    pendingCursor: null,
    quietEndedClean: false,
    tapeWasUsedInThisColdStart: options.tapePresent === true,
    aiCmScrollOverlay: null,
    aiCmOverlaySeq: 0,
    aiCmSetScrollOverlay(on, reason, expectSeq) {
      overlay.push({ on: !!on, reason: reason, expectSeq: expectSeq, at: clock.now });
      deps.aiCmScrollOverlay = on ? { reason: reason } : null;
    },
    findScrollContainer() {
      finds.push(clock.now);
      // Шестое обращение (пятая итерация) объявляет полноту — цикл штатно
      // завершается data-complete на следующей итерации (D4/R3: options.completeAtFind).
      if (finds.length >= (options.completeAtFind || 6)) {
        deps.historyFullByQuiet = true;
        deps.reachedStart = true;
        // holdCursor — сценарий лога: база полная, но continuation-курсор продолжает жить.
        deps.pendingCursor = options.holdCursor === true ? 'cur-hold' : null;
      }
      return container;
    },
    sleep() {
      sleeps.push(clock.now);
      clock.now += options.stepMs || 12000;
      return Promise.resolve();
    },
    vf5OverlapSinceLoaderStart: false,
    isLowConfidenceBase: false
  };

  vm.runInContext(TARGET, ctx, { filename: TARGET_REL });
  const api = pageWindow.AiCmGeminiLoaderScroll;
  api.__bind(deps);
  return { api, deps, calls, overlay, finds, sleeps, clock, clockStart };
}

// =====================================================================================
// D1: кап ретраев скролла возвращён к 90 (+ исторический комментарий, а не число)
// =====================================================================================
describe('ui-timeout: D1 кап LOADER_STALL_CAP = 90', () => {
  test('D1: кап ровно один и равен 90; снижения до 20 больше нет', () => {
    expect(countOf(TARGET, 'LOADER_STALL_CAP = 90')).toBe(1);
    expect(countOf(TARGET, 'LOADER_STALL_CAP = 20')).toBe(0);
    expect(countOf(TARGET, 'var LOADER_STALL_CAP = 90;')).toBe(1);
  });

  test('D1: исторический комментарий v53 восстановлен (обоснование холодного старта)', () => {
    // ровно текст из 338b527: иначе кап 90 — просто число без причины
    expect(TARGET).toContain('// v53: кап ретраев скролла при живом continuation-курсоре (h не растёт, курсор есть).');
    expect(TARGET).toContain('// Холодный старт (простой >12ч) медленный — поднят до 90 (шаг ~1с → до ~90с).');
    expect(TARGET).toContain('// при ещё живой истории (логи 0362260d: pct=56.2 терялись до ручного скролла).');
    // комментарий про wall-clock остался (это отдельный, не откатываемый guard)
    expect(TARGET).toContain('// v1.17 (wall-clock): жёсткий предел одного прогона — fail-safe, не зависящий от LOADER_MAX_ITER/pendingCursor.');
    expect(TARGET).toContain('var LOADER_RUN_WALL_CLOCK_MS = 90000;');
    // кап 90 не превратился в 90с по времени: миллисекунды стопа живут отдельной константой
    expect(countOf(TARGET, 'LOADER_STALL_CAP')).toBeGreaterThanOrEqual(4); // объявление + 3 использования
  });
});

// =====================================================================================
// D2: место вставки — в цикле, после iter++, до решений о полноте
// =====================================================================================
describe('ui-timeout: D2 место вставки в цикле', () => {
  test('D2: вызов внутри while (true), после iter++, до первого чтения pendingCursor', () => {
    const whileIdx = lastLineBefore(GUARD_IDX, (l) => l.indexOf('while (true) {') !== -1);
    const wallIdx = lineNo((l) => l.indexOf("doneReason = 'wall-clock-timeout'") !== -1);
    const iterIdx = lineNo((l) => /^\s*iter\+\+;\s*$/.test(l));
    const pendingIdx = lineNo((l) => l.indexOf('D.pendingCursor') !== -1);

    expect(GUARD_IDX).toBeGreaterThan(-1);
    expect(whileIdx).toBeGreaterThan(-1);
    expect(whileIdx).toBeLessThan(wallIdx); // wall-clock остался первой строкой цикла
    expect(wallIdx).toBeLessThan(iterIdx);
    expect(iterIdx).toBeLessThan(GUARD_IDX); // сразу после iter++
    expect(GUARD_IDX).toBeLessThan(pendingIdx); // до любых решений о полноте
    // и это действительно следующая строка за iter++ (без промежуточной логики)
    expect(GUARD_IDX - iterIdx).toBeLessThanOrEqual(3);
  });

  test('D2: условие — 5с от старта прогона И оверлей реально виден', () => {
    const guard = LINES[GUARD_IDX];
    expect(guard).toContain('Date.now() - runStartAt > 5000');
    expect(guard).toContain('D.aiCmScrollOverlay');
    // v87.1: предел снижен 30000→5000 — старого значения в файле не осталось
    expect(countOf(TARGET, '30000')).toBe(0);
    // 5000 — только UI-предел; прогонный предел остался 90000
    expect(countOf(TARGET, '5000')).toBe(4); // 3 прежних (D15-гейт ×2, таймер) + UI-предел
    expect(countOf(TARGET, '90000')).toBe(1);
    // текст таймаута ('ui-timeout') — ровно один во всём файле
    expect(countOf(TARGET, 'ui-timeout')).toBe(1);
  });
});

// =====================================================================================
// D3: фон НЕ останавливается; оверлей не поднимается заново; wall-clock не тронут
// =====================================================================================
describe('ui-timeout: D3 фон продолжается, wall-clock цел', () => {
  test('D3: в строке таймаута нет break/return', () => {
    expect(GUARD_IDX).toBeGreaterThan(-1);
    expect(LINES[GUARD_IDX]).not.toMatch(/\bbreak\b|\breturn\b/);
    // латч выставлен в той же строке (иначе фолбэк поднимет оверлей обратно)
    expect(LINES[GUARD_IDX]).toContain('D.aiCmUiOverlayTimedOut = true');
  });

  test('D3: фолбэк-ветка загейчена латчем — оверлей не возвращается после таймаута', () => {
    expect(countOf(TARGET, '!D.aiCmScrollOverlay && !D.aiCmUiOverlayTimedOut')).toBe(1);
    // латч сбрасывается рядом с runStartAt (один прогон — одно снятие)
    expect(countOf(TARGET, 'D.aiCmUiOverlayTimedOut = false;')).toBe(1);
    // v87.1: взводов стало два — UI-предел и base-complete-early (оба гасят фолбэк)
    expect(countOf(TARGET, 'D.aiCmUiOverlayTimedOut = true')).toBe(2);
    expect(LINES[EARLY_IDX + 1]).toContain('D.aiCmUiOverlayTimedOut = true');
    // модульной переменной-латча нет: фрагменты цикла исполняются и в песочницах
    expect(countOf(TARGET, 'var uiOverlayTimedOut')).toBe(0);
    // и он не сбрасывается посреди прогона
    expect(countOf(TARGET, 'D.aiCmUiOverlayTimedOut = false')).toBe(1);
  });

  test('D3: wall-clock guard (90с) остался единственным временным break\'ом', () => {
    expect(TARGET).toContain(
      "if (Date.now() - runStartAt > LOADER_RUN_WALL_CLOCK_MS) { doneReason = 'wall-clock-timeout'; break; }"
    );
    expect(countOf(TARGET, 'LOADER_RUN_WALL_CLOCK_MS')).toBe(2); // объявление + guard
  });
});

// =====================================================================================
// D4 (v87.1): base-complete-early — снятие оверлея, когда база объявлена полной
// =====================================================================================
describe('ui-timeout: D4 base-complete-early в цикле', () => {
  test('D4: снятие стоит в том же цикле, ПОСЛЕ UI-предела, до решений о полноте', () => {
    const pendingIdx = lineNo((l) => l.indexOf('D.pendingCursor') !== -1);
    const varIdx = lastLineBefore(EARLY_IDX, (l) => l.indexOf('var __baseCompleteNow87') !== -1);

    expect(EARLY_IDX).toBeGreaterThan(-1);
    expect(EARLY_IDX).toBeGreaterThan(GUARD_IDX); // после строки UI-предела (он остаётся первым)
    expect(EARLY_IDX).toBeLessThan(pendingIdx); // до любых решений о полноте
    expect(varIdx).toBeGreaterThan(GUARD_IDX);
    expect(varIdx - GUARD_IDX).toBeLessThanOrEqual(12); // блок стоит вплотную к таймауту
    // это действительно снятие (on=false) с собственной причиной, а не подъём оверлея
    expect(LINES[EARLY_IDX]).toContain(EARLY_CALL);
    // причина больше нигде не используется — одна точка снятия
    expect(countOf(TARGET, EARLY_REASON)).toBeGreaterThanOrEqual(1);
    expect(countOf(TARGET, "'base-complete-early'")).toBe(1);
  });

  test('D4: снятие безусловное и не останавливает цикл', () => {
    // без expectSeq — иначе «чужой» прогон оставил бы экран закрытым
    expect(LINES[EARLY_IDX]).not.toContain('expectSeq');
    // никакого break/return: цикл живёт до wall-clock/doneReason, как и после UI-таймаута
    expect(LINES[EARLY_IDX]).not.toMatch(/\bbreak\b|\breturn\b/);
    expect(LINES[EARLY_IDX - 1]).not.toMatch(/\bbreak\b|\breturn\b/);
  });

  test('D4: снимаем только видимый оверлей; полнота — по логу baseComplete=1', () => {
    const varIdx = lastLineBefore(EARLY_IDX, (l) => l.indexOf('var __baseCompleteNow87') !== -1);
    const condIdx = lastLineBefore(EARLY_IDX, (l) => l.indexOf('__baseCompleteNow87 &&') !== -1);

    expect(varIdx).toBeGreaterThan(-1);
    expect(condIdx).toBeGreaterThan(-1);
    // условие: оверлей реально виден (иначе снятие вхолостую)
    expect(LINES[condIdx]).toContain('D.aiCmScrollOverlay');
    // признак полноты: боевой D.historyFullByQuiet (он же печатается как baseComplete=1
    // в строке stall-retry) + алиас D.baseComplete
    expect(LINES[varIdx]).toContain('D.historyFullByQuiet === true');
    expect(LINES[varIdx]).toContain('D.baseComplete === true');
    // reachedStart НЕ требуется: снятие оверлея — видимость UI, а не вердикт полноты
    expect(LINES[varIdx]).not.toContain('reachedStart');
    // гейты ветки data-complete не тронуты — она осталась единственным вердиктом полноты
    // (три точки: начало цикла, стабилизация высоты, fallback-top) — все с теми же условиями
    expect(countOf(TARGET, 'D.historyFullByQuiet === true && D.reachedStart === true && !D.pendingCursor')).toBe(3);
  });
});

// =====================================================================================
// R1: проверенный соседний код не сдвинут
// =====================================================================================
describe('ui-timeout: R1 main-anchor и контракт скрытия не тронуты', () => {
  test('R1: findScrollContainer / __applyHide / __restoreLoader на месте', () => {
    expect(countOf(TARGET, 'sc = D.findScrollContainer();')).toBe(1);
    expect(countOf(TARGET, 'function __applyHide()')).toBe(1);
    expect(countOf(TARGET, 'function __restoreLoader()')).toBe(1);
    // штатное снятие по завершении прогона — как было (с seq-гвардом)
    expect(TARGET).toContain("D.aiCmSetScrollOverlay(false, 'loader-done', seqAtEnd80);");
  });

  test('R1: контракт скрытия в overlay — без expectSeq оверлей снимается всегда', () => {
    // именно поэтому вызов таймаута без третьего аргумента гарантированно убирает оверлей
    expect(countOf(OVERLAY, 'function aiCmSetScrollOverlay(on, reason, expectSeq)')).toBe(1);
    expect(OVERLAY).toContain('if (typeof expectSeq === \'number\' && expectSeq !== D.aiCmOverlaySeq) return;');
    expect(OVERLAY).toContain('D.aiCmScrollOverlay = null;');
  });
});

// =====================================================================================
// R2: поведение — UI-предел (5с) снимает оверлей один раз, фон живёт дальше
// =====================================================================================
describe('ui-timeout: R2 поведение в vm', () => {
  test('R2: через 5с оверлей снят один раз, фон доходит до штатного done', async () => {
    const h = makeHarness();
    expect(h.api && typeof h.api.loadFullHistoryInvisibly).toBe('function');

    await h.api.loadFullHistoryInvisibly();

    const uiTimeouts = h.overlay.filter((c) => c.reason === 'ui-timeout');
    expect(uiTimeouts).toHaveLength(1);
    expect(uiTimeouts[0].on).toBe(false);
    // без expectSeq — снятие безусловное (не «чужой» прогон)
    expect(uiTimeouts[0].expectSeq).toBeUndefined();
    // сработал именно 5-секундный предел (v87.1), а не 90-секундный wall-clock
    expect(uiTimeouts[0].at - h.clockStart).toBeGreaterThanOrEqual(5000);
    expect(uiTimeouts[0].at - h.clockStart).toBeLessThan(90000);

    // до таймаута оверлей поднимался (иначе проверять нечего)
    const raises = h.overlay.filter((c) => c.on);
    expect(raises.map((c) => c.reason)).toEqual(['loader']);

    // ключевое: после снятия оверлей НЕ поднимается заново ни в том же тике, ни позже
    expect(h.overlay.filter((c) => c.on && c.at >= uiTimeouts[0].at)).toHaveLength(0);

    // фон продолжает работать: после снятия прошли ещё сон и итерации цикла
    expect(h.sleeps.filter((at) => at >= uiTimeouts[0].at).length).toBeGreaterThanOrEqual(1);
    expect(h.finds.filter((at) => at > uiTimeouts[0].at).length).toBeGreaterThanOrEqual(1);

    // и прогон закончился штатно (не wall-clock и не аварийным логом)
    const done = h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] done reason=') !== -1);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=data-complete');
    expect(h.calls.filter((c) => c.line.indexOf('ошибка лоадера') !== -1)).toHaveLength(0);
  });

  test('R2: если оверлея не было (тейп), таймаут не зовёт скрытие вхолостую', async () => {
    const h = makeHarness({ tapePresent: true });

    await h.api.loadFullHistoryInvisibly();

    // __applyHide подавлен тейпом — оверлея в прогоне не было вообще
    expect(h.overlay.filter((c) => c.on)).toHaveLength(0);
    expect(h.overlay.filter((c) => c.reason === 'ui-timeout')).toHaveLength(0);
    // и base-complete-early тоже не зовётся вхолостую
    expect(h.overlay.filter((c) => c.reason === EARLY_REASON)).toHaveLength(0);
    // прогон при этом дошёл до конца — условие таймаута не сломало цикл
    const done = h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] done reason=') !== -1);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=data-complete');
  });
});

// =====================================================================================
// R3 (v87.1): baseComplete при ЖИВОМ курсоре — оверлей снят раньше UI-предела
// =====================================================================================
describe('base-complete-early: R3 поведение в vm', () => {
  test('R3: база полная + pendingCursor жив → снятие до 5с, ui-timeout не звонится', async () => {
    // Сценарий лога 2026-10-20: база объявлена полной на 3-м поиске скроллера, высота
    // после этого стабильна (stall-retry), курсор продолжения продолжает жить.
    const h = makeHarness({ stepMs: 800, completeAtFind: 3, holdCursor: true, freezeHeightAfterFind: 3 });

    await h.api.loadFullHistoryInvisibly();

    const early = h.overlay.filter((c) => c.reason === EARLY_REASON);
    expect(early).toHaveLength(1);
    expect(early[0].on).toBe(false);
    expect(early[0].expectSeq).toBeUndefined(); // безусловное снятие — не «чужой» прогон

    // ключевое: сработало ДО UI-предела и вместо него
    expect(early[0].at - h.clockStart).toBeLessThan(5000);
    expect(h.overlay.filter((c) => c.reason === 'ui-timeout')).toHaveLength(0);

    // оверлей поднимался только штатно и только один раз
    expect(h.overlay.filter((c) => c.on).map((c) => c.reason)).toEqual(['loader']);
    // после снятия не поднимается (латч не даёт фолбэку вернуть экран)
    expect(h.overlay.filter((c) => c.on && c.at >= early[0].at)).toHaveLength(0);

    // флаг открытого оверлея сброшен, латч взведён — restore работает вхолостую
    expect(h.deps.aiCmScrollOverlay).toBeNull();
    expect(h.deps.aiCmUiOverlayTimedOut).toBe(true);

    // цикл при этом НЕ остановлен: stall-retry с живым курсором продолжился после снятия
    const stalls = h.calls.filter((c) => c.line.indexOf('stall-retry') !== -1);
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].line).toContain('baseComplete=1');
    expect(stalls[0].at).toBeGreaterThanOrEqual(early[0].at);

    // и жёсткий предел прогона цел: дошли до wall-clock (90с), а не до аварии
    const done = h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] done reason=') !== -1);
    expect(done).toHaveLength(1);
    expect(done[0].line).toContain('done reason=wall-clock-timeout');
    expect(h.calls.filter((c) => c.line.indexOf('ошибка лоадера') !== -1)).toHaveLength(0);
  });

  test('R3: алиас D.baseComplete тоже снимает оверлей (без historyFullByQuiet)', async () => {
    const h = makeHarness({ stepMs: 800, completeAtFind: 999, holdCursor: true, baseCompleteAlias: true });

    await h.api.loadFullHistoryInvisibly();

    expect(h.deps.historyFullByQuiet).toBe(false); // сработал именно алиас
    const early = h.overlay.filter((c) => c.reason === EARLY_REASON);
    expect(early).toHaveLength(1);
    expect(early[0].on).toBe(false);
    expect(h.overlay.filter((c) => c.reason === 'ui-timeout')).toHaveLength(0);
    // база не полная по historyFullByQuiet — ветка data-complete не сработала (вердикт цел)
    const done = h.calls.filter((c) => c.line.indexOf('[AI CM][Gemini][loader] done reason=') !== -1);
    expect(done).toHaveLength(1);
    expect(done[0].line).not.toContain('done reason=data-complete');
  });
});
