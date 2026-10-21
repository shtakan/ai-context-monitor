/**
 * Инвариант автоэкспорта: fired ⟹ baseComplete=1 && pendingCursor=0 && firstMsgHash == tape.
 *
 * Зачем этот файл (шаг 0 пачки v88.1): перед тем как глушить скролл-цикл и collapse-retry
 * по латчу fired, надо доказать, что fired вообще не может случиться на живом
 * continuation-курсоре. Иначе «ранний выход по fired» закрепляет выгрузку усечённой базы:
 * файл уже записан, три латча (autoExportFired / sessionFiredCache / aiCmAutoExportFiredOnce)
 * взведены, и поздний честный экспорт блокируется как already-fired до конца сессии страницы.
 *
 * Что здесь пинуется (R-D):
 *   D  — воспроизведение: пороговый путь (maybeAutoExport ← badge-update content.js:2318)
 *        при baseComplete=1 и ЖИВОМ курсоре (aiCmCursorLiveByConv[cid]=1, loaderRunning=0)
 *        не должен выдавать файл.
 *   R1 — loader-stop re-check (export-manager.js:1793) с pendingCursor=1 — не стреляет.
 *   R2 — триггер base-complete (export-manager.js:1820) с живым курсором — не стреляет.
 *   R3 — контроль: курсор ушёл, база полная → ровно один файл (гейт не сломан в другую
 *        сторону: инвариант не должен глушить штатный fired).
 *   D2 — fired-латч → цикл скролла завершается reason='export-done' на первой же итерации,
 *        ДО iter++/скролла/hide/stall-retry (реальный блок кода из gemini-loader-scroll.js).
 *   D3 — при fired collapse-guard НЕ планирует 8с-перезапуск (reason='export-done',
 *        collapseRetries не растёт, таймер не ставится); контроль — без латча прежний путь.
 *   E2E — мост: fired в export-manager.js диспатчит ai-cm-auto-export-fired с тем же convId,
 *        который слушает загрузчик (иначе латч в MAIN-мире не взвёлся бы никогда).
 *
 * Живая форма состояния (не синтетика): аппендикс v88 §2 — «baseComplete=1 приходил на
 * 9-й секунде, но живой continuation-курсор (pendingCursor=1) держал цикл в stall-retry
 * до 34 с»; собственный лог fired в export-manager.js:1725 печатает pendingCursor=1
 * рядом с baseComplete=1. Тот же факт печатает stall-retry в gemini-loader-scroll.js:437.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const LOADER_REL = 'core/gemini-loader-scroll.js';
const LOADER_SRC = fs.readFileSync(path.join(ROOT, LOADER_REL), 'utf8');

const CID = 'e292103e4b521dae'; // живой convId Gemini из fixture H21 (тот же, что в gemini-autoexport-threshold.test.js)

/**
 * РЕАЛЬНЫЙ core/export-manager.js целиком в песочнице состояния контент-скрипта.
 * window — фейковый (перехватываем addEventListener/dispatchEvent и downloadBlob),
 * пайплайн и сборщики — настоящие. Состояние — ровно то, что в проде живёт в
 * core/state.js и core/gemini-intercept.js (имена и формы совпадают).
 */
function loadManager(over) {
  const o = over || {};
  const logs = [];
  const downloads = [];
  const listeners = {};
  const events = [];
  const win = {
    location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app/' + CID },
    AiCmExportEmitPipeline: P,
    AiCmExportBuilders: {
      buildTxtFromHistory: function (hist) {
        return hist.messages.map(function (m) { return m.role + '::' + m.text; }).join('\n');
      },
      buildMdFromHistory: function (hist) {
        return hist.messages.map(function (m) { return m.text; }).join('\n');
      },
      buildJsonFromHistory: Builders.buildJsonFromHistory,
      downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); },
      aiCmDiagDownload: function () { return false; }
    },
    addEventListener: function (type, cb) { (listeners[type] = listeners[type] || []).push(cb); },
    dispatchEvent: function (ev) { events.push({ type: ev && ev.type, detail: ev && ev.detail }); return true; }
  };
  const ctx = {
    window: win,
    // ---- адаптер/сайт ----
    currentAdapter: { siteName: 'gemini' },
    siteName: 'gemini',
    // ---- настройки автоэкспорта ----
    autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' },
    autoExportPctBySite: {},
    // ---- состояние базы (сетевой снимок принят) ----
    baseSeen: true,
    baseComplete: true,
    baseText: 'база',
    baseCount: 42,
    lastBaseTexts: ['вопрос', 'ответ'],
    lastEmitConvId: CID,
    lastThreadId: '',
    lastResolvedModelId: 'gemini-2.5-flash',
    lastSnapshotModelName: 'Gemini 2.5 Flash',
    maxTokenCount: 63000,
    // ---- латчи/курсоры ----
    autoExportFired: {},
    autoExportLastConvId: '',
    autoExportLastPct: 95,
    aiCmLoaderRunningByConv: {},
    aiCmCursorLiveByConv: {},
    aiCmBaseConfirmedByConv: {},
    aiCmLateCheckByConv: {},
    aiCmLowConfidenceByConv: {},
    aiCmAutoExportFiredOnce: Object.create(null),
    aiCmPendingHistWrite: null,
    sessionFiredCache: {},
    notCompleteLogged: {},
    aiCmAutoExportSkipReasonState: { reason: '' },
    // ---- хелперы/внешние зависимости ----
    getCurrentConvId: function () { return CID; },
    buildHistoryMessages: function () {
      return [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: 'ответ' }];
    },
    aiCmArchiveCountFor: function () { return 0; },
    aiCmGeminiTurnsSnapshotSync: function () { return null; },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    aiCmFlushDeferredHistWrite: function () { },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    swallow: function () { },
    swallowSoft: function () { },
    console: { error: function () { }, log: function () { }, warn: function () { } },
    ModelConfig: { getModel: function () { return { name: 'Gemini 2.5 Flash' }; } },
    aiCmAutoExportBasePendingLog: function () { },
    chrome: {
      storage: {
        session: {
          // промис НЕ резолвится: модульный кэш остаётся тем {}, что создан при загрузке,
          // и тест мутирует его напрямую (детерминированно, без гонок микротасок)
          get: function () { return new Promise(function () { }); },
          set: function () { },
          remove: function (k) { delete ctx.sessionFiredCache[k]; }
        },
        onChanged: { addListener: function () { } }
      }
    }
  };
  Object.assign(ctx, o.ctx || {});
  new Function('ctx', 'with (ctx) { ' + MGR_SRC + '\n }')(ctx);
  return {
    ctx: ctx,
    win: win,
    logs: logs,
    downloads: downloads,
    listeners: listeners,
    events: events,
    manager: win.AiCmExportManager,
    line: function (needle) { return logs.filter(function (l) { return l.indexOf(needle) !== -1; }); },
    fire: function (detail) {
      const cbs = listeners['ai-cm-loader-state'] || [];
      expect(cbs.length).toBeGreaterThan(0);
      cbs.forEach(function (cb) { cb({ detail: detail }); });
    }
  };
}

/** Живая форма loader-stop Gemini: done + база объявлена полной + курсор продолжения. */
function loaderStop(over) {
  return Object.assign({
    convId: CID, running: false, pendingCursor: false,
    baseComplete: true, reachedStart: true
  }, over || {});
}

describe('Инвариант автоэкспорта: fired ⟹ pendingCursor=0', function () {
  // ===================================================================================
  // D: воспроизведение дыры — пороговый путь стреляет при живом continuation-курсуре
  // ===================================================================================
  test('Автоэкспорт не может сработать, если pendingCursor > 0', function () {
    // Живая форма (v88 §2): база объявлена полной, курсор продолжения ещё жив,
    // лоадер уже остановлен (running=false → aiCmLoaderRunningByConv пуст).
    const h = loadManager({
      ctx: {
        autoExportLastPct: 95,                   // порог 90 перекрыт
        aiCmCursorLiveByConv: { [CID]: 1 }       // pendingCursor=1 в MAIN-мире
      }
    });
    // Тот же вызов, что делает content.js на КАЖДОМ badge-update (:2318).
    h.manager.maybeAutoExport(95);

    expect(h.downloads).toEqual([]);                        // файла быть не может
    expect(h.line('[AI CM][auto-export] fired convId=')).toEqual([]);
    expect(h.ctx.autoExportFired).toEqual({});               // латч не взведён
    expect(h.ctx.aiCmAutoExportFiredOnce[('gemini|' + CID)]).toBeUndefined();
  });

  // ===================================================================================
  // R1: loader-stop re-check — уже закрыто (export-manager.js:1793)
  // ===================================================================================
  test('R1: loader-stop с pendingCursor=1 — файла нет, латч не взведён', function () {
    const h = loadManager({ ctx: { autoExportLastPct: 95 } });
    h.fire(loaderStop({ pendingCursor: true }));

    expect(h.downloads).toEqual([]);
    expect(h.ctx.autoExportFired).toEqual({});
    // ровно одна строка отказа, с обоими инвариантами в detail-полях
    const kept = h.line('loader-stop с неполной базой');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('pendingCursor=1');
    expect(kept[0]).toContain('baseComplete=1');
    // одноразовый поздний re-check спланирован, но не выстреливает при живом курсоре
    expect(h.ctx.aiCmLateCheckByConv[CID]).toBe(1);
  });

  // ===================================================================================
  // R2: триггер base-complete (export-manager.js:1820) — гейт по курсору
  // ===================================================================================
  test('R2: триггер base-complete при живом курсоре не стреляет', function () {
    const h = loadManager({ ctx: { autoExportLastPct: 95 } });
    // два события: второе приходит уже с записанным aiCmCursorLiveByConv[cid]=1
    h.fire(loaderStop({ running: true, pendingCursor: true }));
    h.fire(loaderStop({ pendingCursor: true }));

    expect(h.downloads).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('base-complete trigger');
    expect(h.ctx.autoExportFired).toEqual({});
  });

  // ===================================================================================
  // R3: контроль — инвариант не глушит штатный fired
  // ===================================================================================
  test('R3: курсор ушёл и база полная — ровно один файл', function () {
    const h = loadManager({ ctx: { autoExportLastPct: 95 } });
    h.fire(loaderStop({ pendingCursor: false }));

    expect(h.downloads).toHaveLength(1);
    expect(h.line('[AI CM][auto-export] fired convId=')).toHaveLength(1);
    // in-memory латч keyed 'service|convId' (utils/export-emit-pipeline.js:latchKey)
    expect(h.ctx.autoExportFired['gemini|' + CID]).toBe(1);
    expect(h.ctx.aiCmAutoExportFiredOnce['gemini|' + CID]).toBe(1);
    // повторный вызов на том же convId — already-fired, второго файла нет
    h.manager.maybeAutoExport(95);
    expect(h.downloads).toHaveLength(1);
  });
});

// =====================================================================================
// D2/D3 (v88.1): ранний выход из цикла скролла по fired-латчу
// =====================================================================================
// Гейт курсора (D выше) закрывает инвариант fired ⟹ pendingCursor=0. Вторая половина правки —
// следствие: раз файл записан по полной базе, крутить скролл дальше бессмысленно. Загрузчик
// живёт в MAIN-мире и ISOLATED-латч aiCmAutoExportFiredOnce не видит, поэтому fired приходит
// window-событием ai-cm-auto-export-fired (E2E ниже) и лежит в модульной карте aiCmFiredByConv.
// Здесь пинятся ОБА потребителя этой карты на РЕАЛЬНОМ коде core/gemini-loader-scroll.js
// (конвенция runTopPoint: исполняется вырезанное тело, а не копия логики):
//   D2 — loop-head выход reason='export-done', проверка ПЕРВОЙ после wall-clock;
//   D3 — collapse-guard не планирует 8с-перезапуск при fired.
const GATE_OPEN = "if (typeof aiCmFiredByConv !== 'undefined' && aiCmFiredByConv[convId]) {";
const COLLAPSE_FROM = '// v1.14.2 (COLLAPSE-GUARD): collapse ≠ top';
const COLLAPSE_TO = "doneReason = 'top'; // v78";

/** Полный `if (...) { ... }` из исходника (вместе с условием), marker — его открывающая строка. */
function extractIf(src, marker, fromIndex) {
  const i = src.indexOf(marker, fromIndex || 0);
  expect(i).toBeGreaterThan(-1);
  const open = i + marker.length - 1; // позиция '{'
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error('несбалансированный блок: ' + marker);
}

/** Исполняет стейтмент внутри while (true); after=true ⇔ гейт пропустил (break не случился). */
function runGate(stmt, over) {
  const ctx = { convId: 'conv-x', doneReason: 'max', after: false };
  ctx.__afterGate = function () { ctx.after = true; };
  Object.assign(ctx, over || {});
  new Function('ctx', 'with (ctx) { while (true) {\n' + stmt + '\n__afterGate(); break; } }')(ctx);
  return { doneReason: ctx.doneReason, after: ctx.after };
}

/** Контекст фрагмента collapse-guard: ровно те имена, что читает тело (ср. runTopPoint). */
function collapseCtx(over) {
  const ctx = {
    logs: [],
    timers: [],
    debugLog: function (kind, msg) { ctx.logs.push(String(msg)); },
    swallowSoft: function () { },
    swallow: function () { },
    doneReason: 'max',
    collapseRetries: 0,
    convId: 'conv-test',
    maxScrollHSeen: 100933,
    usedFallbackScroll: false,
    sc: { height: function () { return 744; } },
    baseSize: function () { return 80; },
    getConvId: function () { return 'conv-test'; },
    loadFloor: function () { return { count: 124 }; },
    maybeStartLoader: function () { ctx.restartCalls = (ctx.restartCalls || 0) + 1; },
    loaderDoneMap: {},
    setTimeout: function (fn, ms) { ctx.timers.push({ fn: fn, ms: ms }); return ctx.timers.length; },
    clearTimeout: function () { },
    window: {}
  };
  ctx.D = ctx; // тело читает зависимости модуля как D.<имя>
  return Object.assign(ctx, over || {});
}

describe('Ранний выход из цикла скролла по fired (v88.1)', function () {
  test('D2: fired-латч → doneReason=export-done на первой итерации, до iter++/скролла', function () {
    const first = LOADER_SRC.indexOf(GATE_OPEN);
    expect(first).toBeGreaterThan(-1);
    // ровно два потребителя латча: loop-head (D2) и collapse-guard (D3)
    expect(LOADER_SRC.split(GATE_OPEN).length - 1).toBe(2);

    // порядок в теле while (true): wall-clock → гейт fired → iter++ → первый гейт полноты
    const wall = LOADER_SRC.indexOf('if (Date.now() - runStartAt > LOADER_RUN_WALL_CLOCK_MS)');
    const iterInc = LOADER_SRC.indexOf('iter++;', wall);
    const dataComplete = LOADER_SRC.indexOf("doneReason = 'data-complete';", wall);
    expect(wall).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(wall);
    expect(iterInc).toBeGreaterThan(first);
    expect(dataComplete).toBeGreaterThan(iterInc);

    // поведение: латч взведён → выход с собственной причиной, тело цикла не продолжается
    const stmt = extractIf(LOADER_SRC, GATE_OPEN, first);
    const fired = runGate(stmt, { aiCmFiredByConv: { 'conv-x': 1 } });
    expect(fired.doneReason).toBe('export-done');
    expect(fired.after).toBe(false);

    // контроль: латча нет → гейт пропускает, причина прежняя (цикл живёт)
    const alive = runGate(stmt, { aiCmFiredByConv: {} });
    expect(alive.doneReason).toBe('max');
    expect(alive.after).toBe(true);
  });

  test('D3: при fired collapse-guard не планирует retry (reason=export-done)', function () {
    const from = LOADER_SRC.indexOf(COLLAPSE_FROM);
    const to = LOADER_SRC.indexOf(COLLAPSE_TO);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = LOADER_SRC.slice(from, to) + "\ndoneReason = 'top'; break;";
    const run = function (ctx) {
      new Function('ctx', 'with (ctx) { (function () { while (true) {\n' + body + '\n} })(); }')(ctx);
      return ctx;
    };

    // fired: перезапуск не нужен — файл уже записан по полной базе
    const fired = run(collapseCtx({ aiCmFiredByConv: { 'conv-test': 1 } }));
    expect(fired.doneReason).toBe('export-done');
    expect(fired.collapseRetries).toBe(0);
    expect(fired.timers).toEqual([]);
    expect(fired.restartCalls || 0).toBe(0);
    expect(fired.logs.join('\n')).toContain('collapse-retry suppressed reason=export-done');

    // контроль: без латча — прежний путь (collapse + ровно один ретрай через 8с)
    const ctl = run(collapseCtx({ aiCmFiredByConv: {} }));
    expect(ctl.doneReason).toBe('collapse');
    expect(ctl.collapseRetries).toBe(1);
    expect(ctl.timers).toHaveLength(1);
    expect(ctl.timers[0].ms).toBe(8000);
  });

  test('E2E: fired шлёт ai-cm-auto-export-fired с текущим convId, загрузчик слушает то же имя', function () {
    const h = loadManager({ ctx: { autoExportLastPct: 95 } });
    h.fire(loaderStop({ pendingCursor: false }));
    expect(h.downloads).toHaveLength(1);

    const evs = h.events.filter(function (e) { return e.type === 'ai-cm-auto-export-fired'; });
    expect(evs).toHaveLength(1);
    expect(evs[0].detail && evs[0].detail.convId).toBe(CID);

    // приёмник в MAIN-мире: то же имя события и латч по detail.convId
    expect(LOADER_SRC).toContain("window.addEventListener('ai-cm-auto-export-fired'");
    expect(LOADER_SRC).toContain('aiCmFiredByConv[cidFired] = 1;');

    // без fired события нет — латч не должен гасить цикл впустую
    const quiet = loadManager({ ctx: { autoExportLastPct: 50 } });
    quiet.manager.maybeAutoExport(50);
    expect(quiet.events.filter(function (e) { return e.type === 'ai-cm-auto-export-fired'; })).toHaveLength(0);
  });
});
