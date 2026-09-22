/**
 * O-29 (Low): лог-спам автоэкспорта GSA — печать ТОЛЬКО на смену состояния.
 *
 * Живой симптом (PROJECT_HANDOFF.md, «GSA Live Run 2026-09-16», строки 306/308): пара
 *   [AI CM][auto-export] site=google_search latch kept reason=spa-entry convId=(threadId)
 *   [AI CM][auto-export] site=google_search skip reason=already-fired|not-complete convId=…
 * печаталась КАЖДУЮ СЕКУНДУ непрерывно (гейт aiCmDebug). Обе строки печатались на КАЖДЫЙ
 * вердикт, а не на смену состояния: already-fired/below-threshold вообще без антиспама,
 * not-complete — с прежним «один раз на разговор» (но без учёта смены состояния).
 *
 * Корень и фикс (точки):
 *   1. core/state.js — латч aiCmAutoExportLastLogState (family → сигнатура последней печати);
 *   2. core/export-manager.js — aiCmAutoExportLogOnChange (читатель/писатель латча) +
 *      aiCmAutoExportLogFiredBit (бит латча O-38 в сигнатуре) + гейт в aiCmGsaAutoExportSkipLog;
 *   3. core/widget.js — тот же гейт у строки 'latch kept reason=spa-entry' (family 'spa-entry').
 * Семейства раздельные намеренно: обе строки печатаются в ОДНОМ DRAW-цикле, поэтому один
 * общий ключ не гасил бы чередование A/B/A/B — спам остался бы.
 *
 * Исполняются РЕАЛЬНЫЕ функции: resetConversationState (core/widget.js), maybeAutoExport +
 * aiCmAutoExportConvId + aiCmGsaProbeRunningFor + aiCmGsaAutoExportSkipLog (core/export-manager.js),
 * хелперы O-29, канонический debugLog (utils/debug.js) под гейтом aiCmDebug и чистый гейт
 * shouldSkipAutoExport (utils/export-emit-pipeline.js).
 *
 * НЕ ТРОГАЕТСЯ (пины R ниже): вердикт shouldSkipAutoExport и порядок гейтов, латчи fired
 * (markAutoExportFired/resetAutoExportFired вызываются ровно там же, где прежде), пороги
 * (1..100, дефолт 90), имя/формат файла (buildGsaExportFileName), строка fired, pre-dedup
 * not-complete ('gsa:' / 'gsa27:'), пути прочих платформ (Gemini — байтово прежний).
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const { contentSource: CONTENT } = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const WIDGET_SRC = fs.readFileSync(path.join(ROOT, 'core', 'widget.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const STATE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'state.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/gsa-autoexport.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

const GSA = 'google_search';
const TID = 'SYNTHETIC-THREAD-1';      // разговор A (convId GSA = threadId)
const OTHER = 'SYNTHETIC-THREAD-2';    // разговор B
const SPA_ENTRY = 'latch kept reason=spa-entry';
const SKIP_TAG = '[AI CM][auto-export] site=google_search skip reason=';

// ---------------------------------------------------------------------------------
// Песочницы O-29: РЕАЛЬНЫЕ resetConversationState (widget) и maybeAutoExport (export-manager)
// над ОДНИМ общим ctx (как в браузере: единый лексический скоуп модулей контент-скрипта).
// ---------------------------------------------------------------------------------
const O29_HELPERS = fnDecl(MGR_SRC, 'aiCmAutoExportLogOnChange') + '\n' +
  fnDecl(MGR_SRC, 'aiCmAutoExportLogFiredBit') + '\n';

const WIDGET_SCOPE = 'with (ctx) { ' + O29_HELPERS +
  fnDecl(DEBUG_SRC, 'debugLog') + '\n' +
  fnDecl(WIDGET_SRC, 'resetConversationState') +
  '\n return { reset: resetConversationState }; }';

const GATE_SCOPE = 'with (ctx) { ' + O29_HELPERS +
  fnDecl(DEBUG_SRC, 'debugLog') + '\n' +
  fnDecl(MGR_SRC, 'aiCmAutoExportConvId') + '\n' +
  fnDecl(MGR_SRC, 'aiCmGsaProbeRunningFor') + '\n' +
  fnDecl(MGR_SRC, 'aiCmGsaAutoExportSkipLog') + '\n' +
  fnDecl(MGR_SRC, 'maybeAutoExport') +
  '\n return { run: maybeAutoExport }; }';

// Песочница БЕЗ хелперов O-29 (как чужие срез-тесты сьюта): поведение обязано быть прежним.
const WIDGET_SCOPE_NO_HELPERS = 'with (ctx) { ' +
  fnDecl(DEBUG_SRC, 'debugLog') + '\n' +
  fnDecl(WIDGET_SRC, 'resetConversationState') +
  '\n return { reset: resetConversationState }; }';

/**
 * Харнесс: общее состояние контент-скрипта + две реальные точки (reset виджета и гейт
 * автоэкспорта). over: site, tid, armed, baseComplete, pct, threshold, debug, record.
 */
function o29(over) {
  const o = over || {};
  // logs — ЕДИНЫЙ поток вывода: сюда пишет реальный debugLog через console.* (гейт aiCmDebug)
  // и заглушка единственной точки записи файла (строка fired).
  const logs = [];
  const fired = [];   // вызовы единственной точки записи файла (doAutoExportDownload)
  const st = {
    tid: (o.tid !== undefined) ? o.tid : TID,
    baseComplete: (o.baseComplete !== undefined) ? o.baseComplete : true
  };

  const ctx = {
    // ---- гейт и общее состояние (core/state.js) ----
    DEBUG: (o.debug === true),
    autoExportSettings: { enabled: true, pct: (o.threshold !== undefined) ? o.threshold : 90, fmt: 'txt' },
    autoExportPctBySite: {},
    autoExportLastConvId: '',
    autoExportLastPct: -1,
    autoExportFired: {},
    aiCmAutoExportFiredOnce: Object.create(null),
    aiCmAutoExportLastLogState: Object.create(null),   // O-29: family → сигнатура
    notCompleteLogged: {},
    sessionFiredCache: {},
    aiCmLoaderRunningByConv: {},
    aiCmCursorLiveByConv: {},
    aiCmArchiveCountFor: function () { return 0; },
    // ---- база снимка ----
    baseSeen: true,
    baseComplete: st.baseComplete,
    baseCount: 4,
    baseText: 'база',
    lastBaseTexts: ['a', 'b'],
    lastDetailMessages: null,
    lastThreadId: st.tid,
    lastEmitConvId: st.tid,
    lastResolvedModelId: 'gemini-2.5-flash',
    lastSnapshotModelName: 'Gemini (Search AI)',
    maxTokenCount: 1000,
    // ---- адаптер/идентификаторы ----
    currentAdapter: { siteName: o.site || GSA },
    getCurrentConvId: function () { return o.urlCid || ''; },   // у GSA URL-id нет
    aiCmDomThreadId: function () { return st.tid; },        // threadId из DOM (GSA)
    aiCmGsaChatPageMarker: function () { return true; },
    aiCmGsaProbeByThread: {},
    aiCmGsaProbeRunning: false,
    // ---- состояние виджета (resetConversationState) ----
    window: {
      __aiCmDebugLogs: false,
      __aiCmTraceSeq: 0,
      location: { hostname: 'www.google.com' },
      AiCmExportEmitPipeline: P
    },
    chrome: {
      runtime: { id: 'test-ext-id' },
      storage: {
        local: { remove: function () { } },
        session: { remove: function () { }, set: function () { } }
      }
    },
    isExtensionValid: function () { return true; },
    scheduleStaleCheck: function () { },
    zoneColor: function (p) { return p < 50 ? '#22c55e' : (p < 80 ? '#eab308' : '#ef4444'); },
    widgetElement: null,
    stale: false,
    badgeSuppressed: false,
    adapterBaseSeen: false,
    lastWidgetData: null,
    aiCmRequestEmitTimer: null,
    aiCmContentReadySent: false,
    aiCmDiagLine: null,
    aiCmDiagDocKind: null,
    aiCmDiagStack: null,
    aiCmI18nMessage: null,
    aiCmLateCheckByConv: {},
    aiCmBaseConfirmedByConv: {},
    aiCmLowConfidenceByConv: {},
    trimProbe: {},
    preTrimExportFired: {},
    trimRetryByConv: {},
    lastBounded: false,
    baseIdSet: null,
    baseSkelSet: null,
    baseAnchors: null,
    lastTailSig: null,
    lastBaseIds: [],
    aiCmBasePrepared: null,
    lastHistoryWroteKey: null,
    detectedModelSlug: '',
    netAttachTokens: 0,
    netAttachBreak: null,
    netServerTokens: 0,
    netEffectiveLen: 0,
    lastCountTokensText: '',
    lastCountTokensCache: 0,
    lastPercentage: -1,
    restoredTapeLoaded: false,
    cacheRefreshPlanned: {},
    restoreDone: false,
    tapeRestoreSeen: {},
    aiCmRestoredDispatched: {},
    aiCmArchiveLoadStarted: {},
    aiCmArchiveRestoredDispatched: {},
    aiCmArchiveCountByConv: {},
    // ---- лог/диагностика ----
    // ВАЖНО: debugLog НЕ кладём в ctx — его объявляет сама песочница (fnDecl utils/debug.js);
    // свойство ctx перекрыло бы объявление в with-скоупе и вызов упал бы на null.
    __aiCmStringifyArg: function (a) { return String(a); },
    console: {
      log: function (m) { logs.push(String(m)); },
      info: function (m) { logs.push(String(m)); },
      debug: function (m) { logs.push(String(m)); },
      warn: function (m) { logs.push(String(m)); },
      error: function (m) { logs.push(String(m)); }
    },
    // ---- ЕДИНСТВЕННАЯ точка записи файла (1:1 с реальной: латч site+convId, O-11/O-38) ----
    doAutoExportDownload: function (cid, pct, reason) {
      fired.push({ cid: cid, pct: pct, reason: reason });
      logs.push('[AI CM][auto-export] fired convId=' + cid);
      P.markAutoExportFired(ctx.autoExportFired, ctx.currentAdapter.siteName, cid);
      ctx.aiCmAutoExportFiredOnce[ctx.currentAdapter.siteName + '|' + cid] = 1;
    }
  };

  const widgetApi = new Function('ctx', WIDGET_SCOPE)(ctx);
  const gateApi = new Function('ctx', GATE_SCOPE)(ctx);
  const widgetApiNoHelpers = new Function('ctx', WIDGET_SCOPE_NO_HELPERS)(ctx);

  return {
    ctx: ctx,
    logs: logs,
    fired: fired,
    reset: widgetApi.reset,
    run: gateApi.run,
    resetNoHelpers: widgetApiNoHelpers.reset,
    // SPA-вход: сброс состояния виджета (O-29 — точка строки spa-entry)
    spaEntry: function () { widgetApi.reset(); },
    // снимок GSA после SPA-входа приносит threadId разговора (content.js: lastThreadId)
    snapshotArrives: function (tid) {
      if (tid !== undefined) st.tid = tid;
      ctx.lastThreadId = st.tid;
      ctx.lastEmitConvId = st.tid;
    },
    setThread: function (tid) { st.tid = tid; },
    setBaseComplete: function (v) { st.baseComplete = v; ctx.baseComplete = (v === true); },
    setDebug: function (on) {
      ctx.DEBUG = (on === true);
      ctx.window.__aiCmDebugLogs = (on === true);
    },
    // латч O-38 взведён (файл этого разговора уже был)
    arm: function (tid) {
      const c = tid || st.tid;
      P.markAutoExportFired(ctx.autoExportFired, ctx.currentAdapter.siteName, c);
      ctx.aiCmAutoExportFiredOnce[ctx.currentAdapter.siteName + '|' + c] = 1;
    },
    lines: function (needle) {
      return logs.filter(function (l) { return l.indexOf(needle) !== -1; });
    },
    skipLines: function (reason) {
      return logs.filter(function (l) {
        return l.indexOf(SKIP_TAG + reason + ' convId=') === 0;
      });
    },
    // ЖИВОЙ DRAW-ЦИКЛ: сначала сброс состояния виджета (spa-entry), затем снимок GSA
    // (threadId + база разговора, content.js: badge-recv) и гейт автоэкспорта
    // (maybeAutoExport) — ровно та пара строк, что спамила каждую секунду.
    drawCycle: function (percentage) {
      widgetApi.reset();
      ctx.lastThreadId = st.tid;   // снимок GSA приносит threadId после сброса
      ctx.lastEmitConvId = st.tid;
      ctx.baseSeen = true;
      ctx.baseComplete = st.baseComplete;
      ctx.baseCount = 4;
      ctx.baseText = 'база';
      gateApi.run(percentage);
    }
  };
}

beforeEach(() => {
  try { window.sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

// =====================================================================================
// D: воспроизведение живого спама — 10 одинаковых состояний → ОДНА строка на семейство
// =====================================================================================
describe('O-29 D1: GSA skip already-fired — 10 вердиктов одного состояния → одна строка', () => {
  test('D1: латч взведён, pct ≥ порога → 10 вызовов гейта дают РОВНО одну строку already-fired', () => {
    const h = o29({ debug: true, armed: true });
    h.arm();
    for (let i = 0; i < 10; i++) h.run(95);
    expect(h.skipLines('already-fired')).toHaveLength(1);
    expect(h.skipLines('already-fired')[0]).toContain('convId=' + TID);
    // файла (и повторного латча) нет — гейт/латч не тронуты
    expect(h.fired).toEqual([]);
  });

  test('D2: ЖИВАЯ ПАРА (spa-entry + already-fired) в 10 DRAW-циклах → по одной строке каждого семейства', () => {
    const h = o29({ debug: true, armed: true });
    h.arm();
    for (let i = 0; i < 10; i++) h.drawCycle(95);
    // спам-пара: 10 циклов = 10 сбросов + 10 вердиктов
    expect(h.lines(SPA_ENTRY)).toHaveLength(1);
    expect(h.skipLines('already-fired')).toHaveLength(1);
    // семейства раздельные: одно гашение НЕ гасит другое (иначе чередование A/B/A/B)
    expect(h.logs.filter(function (l) { return l.indexOf('[AI CM][auto-export]') === 0; })).toHaveLength(2);
    expect(h.fired).toEqual([]);
  });

  test('D3: not-complete (baseComplete=0) — 10 вызовов → одна строка', () => {
    const h = o29({ debug: true, baseComplete: false });
    for (let i = 0; i < 10; i++) h.run(95);
    expect(h.skipLines('not-complete')).toHaveLength(1);
    expect(h.skipLines('not-complete')[0]).toContain('probeRunning=0');
  });

  test('D4: probe-running (probe в полёте) — 10 вызовов → одна строка', () => {
    const h = o29({ debug: true, baseComplete: false });
    h.ctx.aiCmGsaProbeByThread[TID] = 1;
    h.ctx.aiCmGsaProbeRunning = true;
    for (let i = 0; i < 10; i++) h.run(95);
    expect(h.skipLines('probe-running')).toHaveLength(1);
  });

  test('D5: below-threshold (без латча) — 10 вызовов → одна строка', () => {
    const h = o29({ debug: true, threshold: 90 });
    for (let i = 0; i < 10; i++) h.run(85);
    expect(h.skipLines('below-threshold')).toHaveLength(1);
  });

  test('D6: не-чат документ GSA (O-27 not-chat-page) — одна строка, pre-dedup прежний', () => {
    const h = o29({ debug: true });
    h.ctx.aiCmGsaChatPageMarker = function () { return false; };
    for (let i = 0; i < 10; i++) h.run(95);
    expect(h.skipLines('not-chat-page')).toHaveLength(1);
    // ключ O-27 прежний (не тронут фиксом O-29)
    expect(h.ctx.notCompleteLogged['gsa27:not-chat-page:' + TID]).toBe(1);
  });
});

// =====================================================================================
// R: легитимные строки — на смену состояния (первый skip после fired, not-complete→complete)
// =====================================================================================
describe('O-29 R1: смена состояния логируется (not-complete → файр → already-fired)', () => {
  test('R1: каждая смена состояния даёт РОВНО одну строку, повтор — молчание', () => {
    const h = o29({ debug: true, baseComplete: false });
    h.run(95);                                   // состояние 1: not-complete
    h.run(95); h.run(95);                        // повтор — молчание
    expect(h.skipLines('not-complete')).toHaveLength(1);
    // база стала полной → файр (смена состояния, Latch O-38 взведён)
    h.setBaseComplete(true);
    h.run(95);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toEqual({ cid: TID, pct: 95, reason: 'threshold' });
    h.run(96);                                   // состояние 2: ПЕРВЫЙ skip после fired
    expect(h.skipLines('already-fired')).toHaveLength(1);
    h.run(97); h.run(98);                        // повтор — молчание
    expect(h.skipLines('already-fired')).toHaveLength(1);
    expect(h.fired).toHaveLength(1);
  });

  test('R2: возврат к not-complete ПОСЛЕ файра — снова одна строка (бит латча в сигнатуре)', () => {
    const h = o29({ debug: true, baseComplete: true, armed: true });
    h.arm();
    h.run(95);                                   // already-fired (состояние с латчем)
    expect(h.skipLines('already-fired')).toHaveLength(1);
    // сеть замолчала (SPA-сброс) → база снова неполная: причина и бит латча другие
    h.setBaseComplete(false);
    h.ctx.notCompleteLogged = {};                // как в реальном пути: смена разговора/сброс
    h.run(95);
    expect(h.skipLines('not-complete')).toHaveLength(1);
    h.run(95);
    expect(h.skipLines('not-complete')).toHaveLength(1);
  });

  test('R3: смена разговора — строка снова печатается (сигнатура включает convId)', () => {
    const h = o29({ debug: true, armed: true });
    h.arm();
    h.run(95);
    h.run(95);
    expect(h.skipLines('already-fired')).toHaveLength(1);
    h.setThread(OTHER);
    h.ctx.lastThreadId = OTHER;
    h.arm(OTHER);
    h.run(95);
    expect(h.skipLines('already-fired')).toHaveLength(2);
    expect(h.skipLines('already-fired')[1]).toContain('convId=' + OTHER);
  });
});

describe('O-29 R2: строка latch kept reason=spa-entry — только на смену состояния SPA-входа', () => {
  test('R4: 10 SPA-входов одного разговора без файра → одна строка', () => {
    const h = o29({ debug: true });
    for (let i = 0; i < 10; i++) h.spaEntry();
    expect(h.lines(SPA_ENTRY)).toHaveLength(1);
    expect(h.lines(SPA_ENTRY)[0]).toContain('site=google_search');
    expect(h.lines(SPA_ENTRY)[0]).toContain('convId=(threadId)');   // печатаемый текст прежний
  });

  test('R5: первый SPA-вход ПОСЛЕ файра — снова одна строка (бит латча O-38)', () => {
    const h = o29({ debug: true });
    h.spaEntry();
    h.spaEntry();
    expect(h.lines(SPA_ENTRY)).toHaveLength(1);
    h.arm();                       // файр этого разговора состоялся (латч жив → второй файл запрещён)
    h.spaEntry();
    expect(h.lines(SPA_ENTRY)).toHaveLength(2);   // состояние сменилось: латч взведён
    h.spaEntry();
    expect(h.lines(SPA_ENTRY)).toHaveLength(2);   // повтор того же состояния — молчание
  });

  test('R6: смена разговора (SPA-переход A→B) — строка печатается по новому convId', () => {
    const h = o29({ debug: true });
    h.spaEntry();
    h.spaEntry();
    expect(h.lines(SPA_ENTRY)).toHaveLength(1);
    h.setThread(OTHER);
    h.spaEntry();
    expect(h.lines(SPA_ENTRY)).toHaveLength(2);
    h.spaEntry();
    expect(h.lines(SPA_ENTRY)).toHaveLength(2);
  });

  test('R7: не-GSA (Gemini) — ветка GSA не выполняется, строки нет', () => {
    const h = o29({ debug: true, site: 'gemini' });
    for (let i = 0; i < 5; i++) h.spaEntry();
    expect(h.lines(SPA_ENTRY)).toHaveLength(0);
    expect(h.lines('[AI CM][auto-export] site=google_search')).toHaveLength(0);
  });

  test('R8: срез-песочница БЕЗ хелперов O-29 — прежнее поведение и никаких исключений', () => {
    const h = o29({ debug: true });
    for (let i = 0; i < 3; i++) h.resetNoHelpers();
    expect(h.lines(SPA_ENTRY)).toHaveLength(3);   // фолбэк typeof-гарда: как до фикса
  });
});

// =====================================================================================
// R: гейт aiCmDebug, латчи, байты и соседние платформы
// =====================================================================================
describe('O-29 R3: диагностика только под гейтом; латчи/файр/вердикт не тронуты', () => {
  test('R9: гейт aiCmDebug ВЫКЛ — ни одной новой строки (10 DRAW-циклов)', () => {
    const h = o29({ debug: false, armed: true });
    h.arm();
    for (let i = 0; i < 10; i++) h.drawCycle(95);
    expect(h.logs).toEqual([]);
    expect(h.fired).toEqual([]);
  });

  test('R10: гейт ВКЛ — ровно две строки (по одной на семейство), состояние/латч идентичны', () => {
    const off = o29({ debug: false, armed: true });
    const on = o29({ debug: true, armed: true });
    off.arm(); on.arm();
    for (let i = 0; i < 10; i++) { off.drawCycle(95); on.drawCycle(95); }
    expect(off.logs).toEqual([]);                                   // выключенный гейт молчит
    expect(on.lines(SPA_ENTRY)).toHaveLength(1);
    expect(on.skipLines('already-fired')).toHaveLength(1);
    // включение диагностики НЕ меняет ни вердикт, ни латчи, ни вызовы точки записи файла
    expect(on.fired).toEqual(off.fired);
    expect(on.ctx.autoExportFired).toEqual(off.ctx.autoExportFired);
    expect(on.ctx.aiCmAutoExportFiredOnce).toEqual(off.ctx.aiCmAutoExportFiredOnce);
  });

  test('R11: гейт логирования не трогает латчи (в хелперах нет mark/reset fired)', () => {
    const onChange = fnDecl(MGR_SRC, 'aiCmAutoExportLogOnChange');
    const firedBit = fnDecl(MGR_SRC, 'aiCmAutoExportLogFiredBit');
    expect(onChange).not.toContain('markAutoExportFired');
    expect(onChange).not.toContain('resetAutoExportFired');
    expect(firedBit).not.toContain('markAutoExportFired');
    expect(firedBit).not.toContain('resetAutoExportFired');
    expect(onChange).not.toContain('doAutoExportDownload');
    expect(firedBit).not.toContain('doAutoExportDownload');
  });

  test('R12: Gemini-путь не тронут: строка already-fired как прежде (без GSA-тега и без гашения)', () => {
    const GCID = 'conv-gemini-1';                     // у Gemini convId — из URL
    const h = o29({ debug: true, site: 'gemini', urlCid: GCID });
    h.arm(GCID);
    for (let i = 0; i < 10; i++) h.run(95);
    const gemini = h.logs.filter(function (l) {
      return l.indexOf('[AI CM][auto-export] skip reason=already-fired convId=' + GCID) === 0;
    });
    expect(gemini).toHaveLength(10);                 // поведение соседней платформы 1:1
    expect(h.logs.join('\n')).not.toContain('site=google_search');
  });
});

// =====================================================================================
// Структурные пины: точки фикса и «не трогать»
// =====================================================================================
describe('O-29 R4: структурные пины точек фикса и запрещённых к изменению мест', () => {
  test('P1: state.js — латч объявлен и выведен UMD-аксессором (прецедент O-24)', () => {
    expect(STATE_SRC).toContain('var aiCmAutoExportLastLogState = Object.create(null);');
    expect(STATE_SRC).toContain("Object.defineProperty(Api, 'aiCmAutoExportLastLogState'");
  });

  test('P2: export-manager.js — хелперы O-29 и вызов гейта в GSA-строке', () => {
    expect(MGR_SRC).toContain('function aiCmAutoExportLogOnChange(family, key) {');
    expect(MGR_SRC).toContain('function aiCmAutoExportLogFiredBit(site, cid) {');
    const gsaLog = fnDecl(MGR_SRC, 'aiCmGsaAutoExportSkipLog');
    expect(gsaLog).toContain("aiCmAutoExportLogOnChange('gsa-skip'");
    expect(gsaLog).toContain("'google_search|' + cid + '|' + reason + '|fired=' + firedBit");
    // канонический текст строки не изменён
    expect(gsaLog).toContain("'[AI CM][auto-export] site=google_search skip reason=' + reason");
    expect(gsaLog).toContain('probeRunning=');
    // прежний pre-dedup не тронут
    expect(gsaLog).toContain("if (reason === 'not-complete' || reason === 'probe-running') {");
    expect(gsaLog).toContain("var k27 = 'gsa27:' + reason + ':' + cid;");
    // гейт стоит ПОСЛЕ pre-dedup и ПЕРЕД печатью
    expect(gsaLog.indexOf('gsa27:')).toBeLessThan(gsaLog.indexOf("aiCmAutoExportLogOnChange('gsa-skip'"));
    expect(gsaLog.indexOf("aiCmAutoExportLogOnChange('gsa-skip'")).toBeLessThan(gsaLog.indexOf("debugLog('log', '[AI CM][auto-export] site=google_search skip reason="));
  });

  test('P3: widget.js — гейт в GSA-ветке, печатаемый текст прежний, ветка D14 не тронута', () => {
    const reset = fnDecl(WIDGET_SRC, 'resetConversationState');
    expect(reset).toContain("aiCmAutoExportLogOnChange('spa-entry'");
    expect(reset).toContain('latch kept reason=spa-entry');
    expect(reset).toContain("(cidD14 || '(threadId)')");
    // гейт — внутри GSA-ветки, до ветки сброса латча прочих сервисов
    const iGsa = reset.indexOf("siteD14 === 'google_search'");
    const iGate = reset.indexOf("aiCmAutoExportLogOnChange('spa-entry'");
    const iElse = reset.indexOf('} else if (P14 && typeof P14.resetAutoExportFired', iGsa);
    expect(iGsa).toBeGreaterThan(-1);
    expect(iGate).toBeGreaterThan(iGsa);
    expect(iElse).toBeGreaterThan(iGate);
    // латч GSA по-прежнему НЕ снимается (v1.18 F2): сброса для google_search нет
    const gsaBranch = reset.slice(iGsa, iElse);
    expect(gsaBranch).not.toContain('resetAutoExportFired');
    expect(gsaBranch).not.toContain('markAutoExportFired');
    // ветка сброса латча прочих сервисов (D14) осталась после GSA-ветки
    expect(reset.indexOf('P14.resetAutoExportFired(autoExportFired, siteD14, cidD14);')).toBeGreaterThan(iElse);
  });

  test('P4: вердикт гейта и порядок причин не тронуты (shouldSkipAutoExport как прежде)', () => {
    const gate = fnDecl(PIPELINE_SRC, 'shouldSkipAutoExport');
    expect(gate).toContain('var completeOk = (s.baseComplete === true);');
    expect(gate).toContain('? s.threshold : 90');
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, baseComplete: true, baseSeen: true,
      loaderRunning: false, fired: true, isGemini: false,
      site: GSA, chatPageMarker: true, msgCount: 4, baseTextLen: 10
    })).toEqual({ skip: true, reason: 'already-fired', resetFired: false });
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, baseComplete: false, baseSeen: true,
      loaderRunning: false, fired: false, isGemini: false,
      site: GSA, chatPageMarker: true, msgCount: 4, baseTextLen: 10
    })).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('P5: строки fired/not-complete/порогов и имя GSA-файла байтово прежние', () => {
    expect(MGR_SRC).toContain("'[AI CM][auto-export] site=google_search fired convId=' + cid");
    expect(MGR_SRC).toContain("'[AI CM][auto-export] fired convId=' + cid + ' pct=' + percentage + ' file=' + file");
    expect(MGR_SRC).toContain("'[AI CM][auto-export] skip reason=not-complete convId=' + cid + ' pct=' + percentage");
    expect(MGR_SRC).toContain("'[AI CM][auto-export] skip reason=already-fired convId=' + cid);");
    expect(MGR_SRC).toContain("'[AI CM][auto-export] skip reason=below-threshold convId=' + cid + ' pct=' + percentage");
    expect(typeof P.buildGsaExportFileName).toBe('function');
    expect(CONTENT).toContain('function maybeAutoExport(');
    expect(fnDecl(MGR_SRC, 'maybeAutoExport')).toContain('P.shouldSkipAutoExport({');
  });

  test('P6: латч O-38 — единственная точка взвода не сдвинута (maybeAutoExport её не трогает)', () => {
    const mgr = fnDecl(MGR_SRC, 'maybeAutoExport');
    // в самом гейте-обёртке нет ни установки, ни снятия латча
    expect(mgr).not.toContain('markAutoExportFired');
    // снятие латча (гистерезис) — прежняя единственная точка
    expect(mgr).toContain('P.resetAutoExportFired(autoExportFired, siteName, cid);');
  });
});
