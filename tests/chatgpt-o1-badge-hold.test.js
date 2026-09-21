/**
 * O-1 (Medium): badge-hold ChatGPT после F5 — взвод на старте документа независимо от
 * convId, событийное отпускание (первая запись базы ИЛИ фолбэк 10 c), одноразовость.
 *
 * Точные формы входов — из живого артефакта «Логи O-1 F5 09-30–09-36.txt»:
 *   F5#1 (окна 09:30:28.273 / .29.842 / .32.260, строки 122–137): старт с ПУСТЫМ convId,
 *     адаптерный эмит (msgs=2 / msgs=4, netMsgs=0, histWritePath=adapter), и уже на нём
 *     печаталась DOM-догадка `badge-update pct=0% tokens=23 model=GPT-5.5` → щит обязан
 *     держать её до записи базы (convId в URL ни при чём);
 *   F5#2 (окна 09:36:04.490 / .06.492, строки 205–210): старт с convId в URL, адаптерный
 *     эмит msgs=5 domMsgs=5 netMsgs=0 → badge-update нет; первый update — 09:36:06.886
 *     `pct=39.8% tokens=50992 model=GPT-5` ПОСЛЕ badge-recv (запись базы).
 *
 * Контракт, который здесь удостоверяется:
 *   D1 старт с пустым convId + адаптерный эмит (!baseSeen, msgs=2/4, netMsgs=0) →
 *      ни одного badge-update до отпускания; причина взвода — armed-empty-convid;
 *   D2 старт с convId в URL → hold, ни одного badge-update до baseSeen (armed);
 *   D3 baseSeen позже 2500 мс, но раньше 10 c → DOM-значения на бейдж не попали;
 *   D4 baseSeen не пришёл вовсе → отпускание ровно в 10 c, badge-update разрешён;
 *   R1 после отпускания добавление сообщений обновляет бейдж без задержек, щит не
 *      перевзводится (одноразовость aiCmBadgeHoldSpent);
 *   R2 SPA-путь conv-changed (badgeSuppressed + resetConversationState) прежний;
 *   R3 maybeAutoExport и его skip-строки не изменены (O-33 — отдельная задача);
 *   R4 маркеры регресс-наборов O-11/O-31/O-27/O-15…O-20 живы;
 *   R5 диагностика (point=badge-hold) — только под гейтом aiCmDebug; при выключенном
 *      гейте ни одной новой строки, поток badge-update идентичен;
 *   P2a начальный плейсхолдер разметки виджета — «—» (не DOM-догадка 0.0%), новых
 *      состояний и индикаторов «загрузка» не введено.
 *
 * Исполняются РЕАЛЬНЫЕ функции: utils/debug.js (канонический aiCmDiagLine + гейт),
 * core/content.js (щит: aiCmBadgeHoldDiag/Release/Active/ArmBadgeHoldFallback),
 * core/widget.js (updateWidget — единственная печать badge-update, createWidget,
 * resetConversationState). DRAW-исполнитель воспроизводит ветвление processAndSend
 * (badgeSuppressed → loaderFreeze → щит → updateWidget), порядок ветвей пинится тестом.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const H = require('./helpers/content-source.js');
const CONTENT = H.contentSource;
const WIDGET_SRC = H.moduleSource('core/widget.js');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const BUILDERS_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');

// Рез по балансу фигурных скобок (как в tests/diag-o27-o32-instrumentation.test.js).
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

const DIAG_PREFIX = '[AI CM][diag]';
const BADGE_PREFIX = '[AI CM][trace] badge-update';

// Значения ровно те, что в живом артефакте:
// DOM/адаптерный эмит F5#1 (09:30:28.292) и запись базы F5#2 (09:36:06.886).
const DOM_VALUES = { pct: 0, tokens: 23, model: 'GPT-5.5' };
const BASE_VALUES = { pct: 39.8, tokens: 50992, model: 'GPT-5' };
const CONV = '6a59cfa1-8e8c-83ed-8ba7-995740b83dd9';

// ---------------------------------------------------------------------------------
// Песочница щита: РЕАЛЬНЫЕ функции щита + канонический диагностический хелпер
// ---------------------------------------------------------------------------------
// Константа фолбэка и состояние щита — объявлениями из исходника (не литералами теста)
const FALLBACK_DECL = (CONTENT.match(/var AI_CM_BADGE_HOLD_FALLBACK_MS = \d+;/) || [])[0];
expect(FALLBACK_DECL).toBe('var AI_CM_BADGE_HOLD_FALLBACK_MS = 10000;');
const HOLD_STATE_DECL = (CONTENT.match(/var aiCmBadgeHoldUntil = 0;[\s\S]*?var aiCmBadgeHoldTimer = null;/) || [])[0];
expect(HOLD_STATE_DECL).toContain('var aiCmBadgeHoldSpent = false;');

const HOLD_SCOPE = 'with (ctx) { ' + FALLBACK_DECL + '\n' + HOLD_STATE_DECL + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
  fnDecl(CONTENT, 'aiCmBadgeHoldDiag') + '\n' +
  fnDecl(CONTENT, 'aiCmBadgeHoldRelease') + '\n' +
  fnDecl(CONTENT, 'aiCmBadgeHoldActive') + '\n' +
  fnDecl(CONTENT, 'aiCmArmBadgeHoldFallback') + '\n' +
  ' return { active: aiCmBadgeHoldActive, release: aiCmBadgeHoldRelease }; }';
const makeHold = new Function('ctx', HOLD_SCOPE);

function widgetEl() {
  const el = document.createElement('div');
  el.id = 'ai-context-widget';
  el.innerHTML =
    '<div class="ai-widget-circle"><svg><circle class="ai-widget-bg"></circle>' +
    '<circle class="ai-widget-fill"></circle></svg><div class="ai-widget-text">—</div>' +
    '<div class="ai-widget-tooltip"></div></div><div class="ai-widget-panel"></div>';
  document.body.appendChild(el);
  return el;
}

/**
 * Харнесс O-1: один общий ctx для реального щита (content.js) и реального updateWidget
 * (widget.js). `draw()` повторяет ветвление DRAW из processAndSend, `baseArrives()` —
 * запись базы (baseSeen=true, как content.js:507 в слушателе ai-cm-full-history).
 */
function makeO1(over) {
  const o = over || {};
  const logs = [];
  const consoleLogs = [];
  const st = {
    convId: o.convId || '',
    revealed: 0,
    draws: 0,
    lastValues: null,
    applied: []
  };
  const el = widgetEl();

  const ctx = {
    currentAdapter: { siteName: o.site || 'chatgpt' },
    baseSeen: false,
    baseText: '',
    badgeSuppressed: false,
    // v54: состояние «база принята адаптером» — у chatgpt его взводит только адаптерная
    // запись истории; в харнессе O-1 (сетевой/адаптерный эмит без записи истории) оно
    // остаётся false — поведение щита и SPA-держания не меняется. Читается той же ветвью
    // DRAW, что и badgeSuppressed (порядок ветвей прежний).
    adapterBaseSeen: false,
    aiCmLoaderFreeze: false,
    widgetElement: el,
    stale: false,
    lastWidgetData: null,
    getCurrentConvId: function () { return st.convId; },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    aiCmRevealWidget: function () { st.revealed++; if (el.style.display === 'none') el.style.display = ''; },
    aiCmRefreshThemeIfNeeded: function () { },
    aiCmUpdateSourceIndicator: function () { },
    zoneColor: function (p) { return p < 50 ? '#22c55e' : (p < 80 ? '#eab308' : '#ef4444'); },
    aiCmActivePct: function () { return null; },
    document: document,
    window: window
  };

  // РЕАЛЬНЫЙ updateWidget (core/widget.js) — единственная печать badge-update
  new Function('ctx', 'with (ctx) { ' + fnDecl(WIDGET_SRC, 'updateWidget') +
    '\n ctx.updateWidget = updateWidget; }')(ctx);
  // РЕАЛЬНЫЙ щит (core/content.js)
  const api = makeHold(ctx);
  // РЕАЛЬНЫЙ канонический хелпер печатает только под гейтом aiCmDebug
  jest.spyOn(console, 'log').mockImplementation(function (m) { consoleLogs.push(String(m)); });

  // processAndSend (content.js:1591) — предпоследний шаг этого же харнесса
  ctx.processAndSend = function () { draw(); };

  function draw() {
    st.draws++;
    if (ctx.badgeSuppressed && !ctx.baseSeen && !ctx.adapterBaseSeen) return; // v1.8.1 (SPA) + v54: база не принята
    if (ctx.aiCmLoaderFreeze) return;                         // v30.9: скрытая загрузка — накопление
    if (api.active()) return;                                 // O-1: щит держит бейдж
    const v = ctx.baseSeen ? BASE_VALUES : DOM_VALUES;        // база, иначе DOM/адаптер
    st.lastValues = v;
    st.applied.push(v);
    ctx.updateWidget(v.pct, v.tokens, 128000, 128000, 128000, v.model, null);
  }

  function baseArrives() {                                    // ai-cm-full-history → baseSeen=true (content.js:507)
    ctx.baseSeen = true;
    ctx.baseText = 'x'.repeat(1000);
    draw();
  }

  // как createWidget (widget.js:416): щит активен → контейнер снят с отрисовки
  if (api.active()) el.style.display = 'none';

  return {
    ctx: ctx,
    api: api,
    st: st,
    el: el,
    draw: draw,
    baseArrives: baseArrives,
    badgeUpdates: function () { return logs.filter(function (l) { return l.indexOf(BADGE_PREFIX) === 0; }); },
    diagLines: function () { return consoleLogs.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; }); },
    holdDiag: function () {
      return consoleLogs.filter(function (l) { return l.indexOf(DIAG_PREFIX + ' badge-hold') === 0; });
    },
    traced: function () { return logs; }
  };
}

beforeEach(() => {
  try { window.sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
  window.__aiCmDebugLogs = false;
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  document.body.innerHTML = '';
});

// =====================================================================================
// D1/D2: взвод щита на старте документа (независимо от convId) — форма F5#1 и F5#2
// =====================================================================================
describe('O-1 D1/D2: щит взводится на старте документа chatgpt независимо от convId', () => {
  test('D1 (F5#1 09:30:28–32): пустой convId + адаптерный эмит → ни одного badge-update до отпускания', () => {
    jest.useFakeTimers();
    const h = makeO1({ convId: '' });
    expect(h.api.active()).toBe(true);          // щит взведён на старте документа
    expect(h.el.style.display).toBe('none');   // виджет скрыт с создания

    h.draw();                                   // 09:30:28.273 адаптерный эмит msgs=2, netMsgs=0
    jest.advanceTimersByTime(1570);
    h.draw();                                   // 09:30:29.842 msgs=4, netMsgs=0
    jest.advanceTimersByTime(2420);
    h.draw();                                   // 09:30:32.260 msgs=4, netMsgs=0
    expect(h.badgeUpdates()).toEqual([]);       // DOM-догадки pct=0% tokens=23 на бейдж не попали
    expect(h.st.applied).toEqual([]);
    expect(h.st.revealed).toBe(0);              // виджет не показан

    window.sessionStorage.setItem('aiCmDebug', '1');
    const probe = makeO1({ convId: '' });       // причина взвода различима в диагностике
    expect(probe.holdDiag()).toHaveLength(1);
    expect(probe.holdDiag()[0]).toContain('badge-hold point=badge-hold reason=armed-empty-convid site=chatgpt');
  });

  test('D2 (F5#2 09:36:04–06): старт с convId в URL → hold до baseSeen, затем база', () => {
    jest.useFakeTimers();
    window.sessionStorage.setItem('aiCmDebug', '1');
    const h = makeO1({ convId: CONV });
    expect(h.holdDiag()[0]).toContain('badge-hold point=badge-hold reason=armed site=chatgpt convId=' + CONV);

    h.draw();                                   // 09:36:04.490 старт документа
    jest.advanceTimersByTime(2002);
    h.draw();                                   // 09:36:06.492 адаптерный эмит msgs=5 netMsgs=0
    expect(h.badgeUpdates()).toEqual([]);       // до записи базы бейдж не обновляется

    jest.advanceTimersByTime(400);
    h.baseArrives();                            // 09:36:06.867 badge-recv → baseSeen
    const ups = h.badgeUpdates();
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain('badge-update pct=39.8% tokens=50992 model=GPT-5');
    expect(h.holdDiag().join('\n')).toContain('reason=released-baseSeen');
    expect(h.st.revealed).toBeGreaterThan(0);  // виджет показан первым же валидным расчётом
  });
});

// =====================================================================================
// D3/D4: условие отпускания — запись базы ИЛИ жёсткий фолбэк 10 c
// =====================================================================================
describe('O-1 D3/D4: отпускание по baseSeen или фолбэку 10 c (жёсткого лимита 2500 мс нет)', () => {
  test('D3: baseSeen пришёл позже 2500 мс, но раньше 10 c → DOM-значения на бейдж не попали', () => {
    jest.useFakeTimers();
    const h = makeO1({ convId: CONV });
    h.draw();
    jest.advanceTimersByTime(2600);             // прежний жёсткий лимит 2500 мс давно прошёл
    h.draw();
    expect(h.api.active()).toBe(true);          // щит всё ещё держит (событийная семантика)
    expect(h.badgeUpdates()).toEqual([]);

    jest.advanceTimersByTime(400);              // t≈3000
    h.baseArrives();
    const ups = h.badgeUpdates();
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain('pct=39.8% tokens=50992 model=GPT-5');
    expect(ups.join('\n')).not.toContain('pct=0% tokens=23');    // DOM-догадка не дошла до бейджа
    expect(h.st.applied).toEqual([BASE_VALUES]);
  });

  test('D4: baseSeen не пришёл вовсе → отпускание ровно в 10 c, badge-update разрешён', () => {
    jest.useFakeTimers();
    window.sessionStorage.setItem('aiCmDebug', '1');
    const h = makeO1({ convId: '' });
    h.draw();
    jest.advanceTimersByTime(9999);
    h.draw();
    expect(h.api.active()).toBe(true);          // 9999 мс — щит держит
    expect(h.badgeUpdates()).toEqual([]);

    jest.advanceTimersByTime(1);                // ровно 10 000 мс — фолбэк aiCmArmBadgeHoldFallback
    const ups = h.badgeUpdates();
    expect(ups).toHaveLength(1);                // дальше прежнее поведение (рисунок по DOM-базе)
    expect(ups[0]).toContain('badge-update pct=0% tokens=23 model=GPT-5.5');
    expect(h.holdDiag().join('\n')).toContain('reason=released-fallback');
    // фолбэк зовёт aiCmRevealWidget явно (2) + сам показ в updateWidget того же прохода (1)
    expect(h.st.revealed).toBe(2);
    expect(h.api.active()).toBe(false);         // щит снят (одноразово)
    expect(h.el.style.display).toBe('');
  });
});

// =====================================================================================
// R1: после отпускания — без задержек и без повторного взвода
// =====================================================================================
describe('O-1 R1: после отпускания щит не перевзводится, бейдж обновляется сразу', () => {
  test('R1: добавление сообщений после отпускания обновляет бейдж без задержек', () => {
    jest.useFakeTimers();
    window.sessionStorage.setItem('aiCmDebug', '1');
    const h = makeO1({ convId: CONV });
    h.draw();
    jest.advanceTimersByTime(1200);
    h.baseArrives();                            // released-baseSeen
    const n1 = h.badgeUpdates().length;
    expect(n1).toBe(1);

    jest.advanceTimersByTime(900); h.draw();    // новое сообщение — обновление сразу
    jest.advanceTimersByTime(900); h.draw();
    expect(h.badgeUpdates().length).toBe(n1 + 2);
    expect(h.api.active()).toBe(false);         // щит не перевзведён

    jest.advanceTimersByTime(20000);            // висящий фолбэк-таймер документа — no-op
    expect(h.badgeUpdates().length).toBe(n1 + 2);
    expect(h.st.revealed).toBe(3);              // ровно по одному показу на updateWidget
    expect(h.holdDiag().filter(function (l) { return l.indexOf('reason=armed') !== -1; })).toHaveLength(1);
    expect(h.holdDiag()).toHaveLength(2);       // взвод (armed) + отпускание (released-baseSeen)
  });
});

// =====================================================================================
// R2: SPA-путь conv-changed (badgeSuppressed + resetConversationState) прежний
// =====================================================================================
const RESET_SCOPE = 'with (ctx) { ' +
  fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagDocKind') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagStack') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
  fnDecl(WIDGET_SRC, 'resetConversationState') + '\n' +
  ' return { reset: resetConversationState }; }';

function runReset() {
  const consoleLogs = [];
  jest.spyOn(console, 'log').mockImplementation(function (m) { consoleLogs.push(String(m)); });
  const el = widgetEl();
  const zeroed = ['baseIdSet', 'baseSkelSet', 'baseAnchors', 'lastTailSig', 'lastDetailMessages', 'aiCmBasePrepared', 'lastHistoryWroteKey', 'lastThreadId', 'lastSnapshotModelName', 'lastResolvedModelId', 'aiCmRequestEmitTimer'];
  const ctx = {
    currentAdapter: { siteName: 'chatgpt' },
    window: { AiCmExportEmitPipeline: null, __aiCmTraceSeq: 0 },
    widgetElement: el,
    getCurrentConvId: function () { return CONV; },
    debugLog: function () { },
    aiCmDiagDocKind: null,
    aiCmDomThreadId: function () { return ''; },
    aiCmDiagLine: null,
    aiCmDiagStack: null,
    aiCmI18nMessage: null,
    zoneColor: function (p) { return p < 50 ? '#22c55e' : (p < 80 ? '#eab308' : '#ef4444'); },
    scheduleStaleCheck: function () { },
    stale: false,
    baseText: 'base-of-old-conv',
    baseCount: 71,
    baseSeen: true,
    baseComplete: true,
    lastBounded: true,
    maxTokenCount: 50992,
    lastBaseIds: ['a'],
    lastBaseTexts: ['a'],
    lastPercentage: 39.8,
    detectedModelSlug: 'gpt-5',
    netAttachTokens: 5355,
    netAttachBreak: { imgCount: 7, imgTokens: 5355, docCount: 0, docTokens: 0 },
    netServerTokens: 0,
    netEffectiveLen: 0,
    lastCountTokensText: '',
    lastCountTokensCache: 0,
    restoredTapeLoaded: true,
    cacheRefreshPlanned: {},
    restoreDone: true,
    tapeRestoreSeen: { x: 1 },
    aiCmRestoredDispatched: { x: 1 },
    aiCmArchiveLoadStarted: { x: 1 },
    aiCmArchiveRestoredDispatched: { x: 1 },
    aiCmArchiveCountByConv: { x: 1 },
    lastEmitConvId: CONV,
    autoExportLastPct: 39.8,
    autoExportFired: { old: 1 },
    aiCmLateCheckByConv: { x: 1 },
    aiCmCursorLiveByConv: { x: 1 },
    aiCmBaseConfirmedByConv: { x: 1 },
    aiCmLowConfidenceByConv: { x: 1 },
    trimProbe: { x: 1 },
    preTrimExportFired: { x: 1 },
    trimRetryByConv: { x: 1 },
    badgeSuppressed: false,
    adapterBaseSeen: true, // v54: признак прошлого разговора — reset обязан его снять
    lastWidgetData: { pct: 39.8 },
    aiCmContentReadySent: true
  };
  zeroed.forEach(function (k) { if (!(k in ctx)) ctx[k] = null; });
  const api = new Function('ctx', RESET_SCOPE)(ctx);
  api.reset();
  return { ctx: ctx, el: el, consoleLogs: consoleLogs, api: api };
}

describe('O-1 R2: SPA-держание (conv-changed) не тронуто', () => {
  test('R2: реальный resetConversationState даёт прежнее состояние и прежнюю строку диагностики', () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    const r = runReset();
    expect(r.ctx.badgeSuppressed).toBe(true);                    // до первого badge-recv нового convId
    expect(r.ctx.adapterBaseSeen).toBe(false);                   // v54: база нового convId ещё не принята
    expect(r.ctx.lastWidgetData).toBeNull();
    expect(r.ctx.baseSeen).toBe(false);
    expect(r.ctx.baseText).toBe('');
    expect(r.ctx.baseCount).toBe(0);
    expect(r.ctx.maxTokenCount).toBe(0);
    expect(r.ctx.lastEmitConvId).toBe('');
    expect(r.ctx.autoExportLastPct).toBe(-1);
    expect(r.el.querySelector('.ai-widget-text').textContent).toBe('—');
    expect(r.el.querySelector('.ai-widget-tooltip').textContent).toContain('Загрузка контекста...');
    const diag = r.consoleLogs.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; }).join('\n');
    expect(diag).toContain('gsa-state point=resetConversationState verdict=reset reason=caller-see-src');
    expect(diag).toContain('site=chatgpt');
  });

  test('R2: щит документного уровня и SPA-механизм не переплетены', () => {
    const hold = fnDecl(CONTENT, 'aiCmBadgeHoldActive') + fnDecl(CONTENT, 'aiCmBadgeHoldRelease');
    expect(hold).not.toContain('badgeSuppressed');
    expect(hold).not.toContain('resetConversationState');
    expect(fnDecl(WIDGET_SRC, 'resetConversationState')).not.toContain('aiCmBadgeHold');
    // v54: взвода adapterBaseSeen в reset нет — только сброс (единственный писатель — запись
    // базы адаптером в content.js); щит O-1 в это состояние не заглядывает вовсе
    expect(fnDecl(WIDGET_SRC, 'resetConversationState')).toContain('adapterBaseSeen = false;');
    expect(hold).not.toContain('adapterBaseSeen');
    // SPA-гейт в DRAW остался ПЕРВОЙ ветвью; v54 (O-35): к baseSeen добавлен только
    // признак «база принята адаптером» — пока ни сети, ни adapter-записи нет, держание
    // прежнее (для chatgpt это ровно прежние состояния: щит отпускает запись базы)
    const draw = fnDecl(CONTENT, 'processAndSend');
    expect(draw).toContain('var badgeSuppressActive = (badgeSuppressed && !baseSeen && !adapterBaseSeen);');
    expect(draw).toContain('if (badgeSuppressActive) {');
    const drawSrc = WIDGET_SRC;
    expect(drawSrc).toContain('badgeSuppressed = true; // v1.8.1: до первого badge-recv нового convId бейдж не обновляем');
  });

  test('R2: порядок ветвления DRAW — SPA-супрессия → freeze лоадера → щит → updateWidget', () => {
    // именно этот порядок воспроизводит draw() харнесса; менять его нельзя без изменения
    // поведения SPA-держания (badgeSuppressed) и скрытой загрузки (aiCmLoaderFreeze)
    const draw = fnDecl(CONTENT, 'processAndSend');
    const iSupp = draw.indexOf('var badgeSuppressActive = (badgeSuppressed && !baseSeen && !adapterBaseSeen);');
    const iSuppIf = draw.indexOf('if (badgeSuppressActive) {');
    const iFreeze = draw.indexOf('} else if (aiCmLoaderFreeze) {');
    const iHold = draw.indexOf('} else if (aiCmBadgeHoldActive()) {');
    const iUpd = draw.indexOf('updateWidget(percentage, maxTokenCount, effectiveLimit');
    expect(iSupp).toBeGreaterThan(-1);
    expect(iSuppIf).toBeGreaterThan(iSupp);
    expect(iFreeze).toBeGreaterThan(iSuppIf);
    expect(iHold).toBeGreaterThan(iFreeze);
    expect(iUpd).toBeGreaterThan(iHold);
  });
});

// =====================================================================================
// R3: maybeAutoExport и гейты автоэкспорта не тронуты (O-33 — отдельная задача)
// =====================================================================================
describe('O-1 R3: автоэкспорт не тронут', () => {
  test('R3: maybeAutoExport вне ветвления щита, его skip-строки и латч прежние', () => {
    const draw = fnDecl(CONTENT, 'processAndSend');
    expect(draw).toContain('maybeAutoExport(percentage);');
    const badgeBranch = draw.indexOf('} else if (aiCmBadgeHoldActive()) {');
    expect(badgeBranch).toBeGreaterThan(-1);
    expect(draw.indexOf('maybeAutoExport(percentage);')).toBeGreaterThan(badgeBranch);
    expect(fnDecl(CONTENT, 'maybeAutoExport')).toContain('P.shouldSkipAutoExport({');
    // skip-строки автоэкспорта — на месте
    expect(MGR_SRC).toContain("skip reason=already-fired convId=");
    expect(MGR_SRC).toContain("skip reason=below-threshold convId=");
    expect(MGR_SRC).toContain("skip reason=not-complete convId=");
    // O-1 не заходит в автоэкспорт-контур вообще
    expect(MGR_SRC).not.toContain('aiCmBadgeHold');
    expect(MGR_SRC).not.toContain('AI_CM_BADGE_HOLD');
    expect(PIPELINE_SRC).not.toContain('aiCmBadgeHold');
    expect(PIPELINE_SRC).not.toContain('AI_CM_BADGE_HOLD');
  });

  test('R3: щит — только chatgpt, адаптеры и перехватчики прочих платформ не тронуты', () => {
    expect(fnDecl(CONTENT, 'aiCmBadgeHoldActive')).toContain("siteName !== 'chatgpt'");
    ['core/claude-intercept.js', 'core/deepseek-intercept.js',
      'core/google-search-intercept.js', 'core/gemini-intercept.js'
    ].forEach(function (rel) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).not.toContain('aiCmBadgeHold');
      expect(src).not.toContain('AI_CM_BADGE_HOLD');
    });
  });
});

// =====================================================================================
// R4: маркеры регресс-наборов O-11/O-31/O-27/O-15…O-20 живы
// =====================================================================================
describe('O-1 R4: регресс-маркеры соседних задач на месте', () => {
  test('R4: O-11 (латч/имена), O-31 (сегментация), O-27 (гарды), экспорт-байты', () => {
    const P = require('../utils/export-emit-pipeline.js');
    expect(typeof P.latchKey).toBe('function');                    // O-11
    expect(typeof P.disambiguateFileName).toBe('function');        // O-11
    expect(typeof P.shouldSkipAutoExport).toBe('function');        // O-11/O-27
    expect(typeof P.shouldSkipGsaPageGuard).toBe('function');      // O-27
    expect(CONTENT).toContain('function aiCmSnapshotIsCurrentThread('); // O-31
    expect(fnDecl(CONTENT, 'aiCmGsaResetStaleStateOnChatlessDoc')).toContain('resetConversationState()');
    expect(fnDecl(BUILDERS_SRC, 'downloadBlockReason')).toContain("return 'xssi-prefix';"); // O-27
    expect(fnDecl(BUILDERS_SRC, 'downloadBlob')).toContain('new Blob([content], { type: mimeType })');
    expect(fnDecl(DEBUG_SRC, 'aiCmDiagDownloadBlocked')).toContain("aiCmDiagLine('download-blocked'");
  });
});

// =====================================================================================
// R5: диагностика (point=badge-hold) — только под гейтом aiCmDebug
// =====================================================================================
describe('O-1 R5: диагностика щита под гейтом aiCmDebug', () => {
  test('R5: гейт выключен → ни одной строки, поток badge-update идентичен', () => {
    jest.useFakeTimers();
    const off = makeO1({ convId: '' });
    off.draw();
    jest.advanceTimersByTime(10000);
    expect(off.diagLines()).toEqual([]);                       // ни одной новой строки
    expect(off.badgeUpdates()).toHaveLength(1);

    jest.useRealTimers();
    jest.useFakeTimers();
    window.sessionStorage.setItem('aiCmDebug', '1');
    const on = makeO1({ convId: '' });
    on.draw();
    jest.advanceTimersByTime(10000);
    expect(on.holdDiag().length).toBeGreaterThan(0);
    expect(on.badgeUpdates()).toEqual(off.badgeUpdates());     // поведение щита то же
    expect(on.st.revealed).toBe(off.st.revealed);
  });

  test('R5: канонический хелпер, четыре причины, печать только через гейт', () => {
    const diag = fnDecl(CONTENT, 'aiCmBadgeHoldDiag');
    expect(diag).toContain("aiCmDiagLine('badge-hold'");
    expect(diag).toContain("point: 'badge-hold'");
    expect(diag).toContain("typeof aiCmDiagLine !== 'function'");   // срез-песочницы тестов
    expect(diag).not.toContain('console.');
    const src = fnDecl(CONTENT, 'aiCmBadgeHoldActive') + fnDecl(CONTENT, 'aiCmBadgeHoldRelease') +
      fnDecl(CONTENT, 'aiCmArmBadgeHoldFallback');
    ["'armed'", "'armed-empty-convid'", "'released-baseSeen'", "'released-fallback'"].forEach(function (r) {
      expect(src).toContain(r);
    });
    // гейт берётся из канонического aiCmDiagOn (sessionStorage aiCmDebug === '1' / чекбокс)
    expect(fnDecl(DEBUG_SRC, 'aiCmDiagOn')).toContain("sessionStorage.getItem('aiCmDebug') === '1'");
  });

  test('R5: одноразовость на документ и снятая жёсткая семантика 2500 мс', () => {
    const act = fnDecl(CONTENT, 'aiCmBadgeHoldActive');
    expect(act.indexOf('aiCmBadgeHoldSpent')).toBeLessThan(act.indexOf('baseSeen')); // spent — первым
    expect((CONTENT.match(/aiCmBadgeHoldSpent = true/g) || []).length).toBe(1);      // единственная точка
    expect(act).not.toContain('if (!getCurrentConvId()) return false;');             // пустой convId не выключает
    expect(CONTENT).not.toContain('AI_CM_BADGE_HOLD_MS');
    expect(CONTENT).toContain('var AI_CM_BADGE_HOLD_FALLBACK_MS = 10000;');
    expect(fnDecl(CONTENT, 'aiCmArmBadgeHoldFallback')).toContain('AI_CM_BADGE_HOLD_FALLBACK_MS)');
  });
});

// =====================================================================================
// P2a: начальный плейсхолдер виджета до первого updateWidget
// =====================================================================================
function runCreateWidget(holdActive) {
  const ctx = {
    document: document,
    window: window,
    widgetElement: null,
    __w: null,
    applyNativeStyles: function () { },
    updatePanel: function () { },
    processAndSend: function () { },
    aiCmStartThemePoll: function () { },
    // слушатели виджета (createWidget навешивает их сразу) — заглушки
    snapCurrentPct: function () { },
    resetSafePct: function () { },
    stepSafePct: function () { },
    setSafePctFromInput: function () { },
    aiCmBadgeHoldActive: function () { return !!holdActive; }
  };
  new Function('ctx', 'with (ctx) { ' + fnDecl(WIDGET_SRC, 'createWidget') +
    '\n createWidget(); ctx.__w = widgetElement; }')(ctx);
  return ctx;
}

describe('O-1 P2a: начальный плейсхолдер виджета — «—», а не DOM-догадка', () => {
  test('P2a: разметка печатает «—»; имени модели, tokens и pct в начальном DOM нет', () => {
    expect(WIDGET_SRC).toContain('<div class="ai-widget-text">—</div>');
    expect(WIDGET_SRC).not.toContain('<div class="ai-widget-text">0.0%</div>');
    const off = runCreateWidget(false);
    const el = off.__w;
    expect(el.querySelector('.ai-widget-text').textContent).toBe('—');
    const txt = el.textContent;
    expect(txt).not.toContain('0.0%');
    expect(txt).not.toContain('GPT');
    expect(txt).not.toContain('токен');
    // индикатор «загрузка» не новый: прежние ровно два места с прежним ключом
    expect((WIDGET_SRC.match(/\('content_widget_loading'/g) || []).length).toBe(2);
    expect(WIDGET_SRC).toContain("content_widget_loading', 'Загрузка контекста...'");
    expect(el.querySelector('.ai-widget-tooltip').textContent).toContain('Загрузка контекста...');
  });

  test('P2a: при активном щите контейнер скрыт; плейсхолдер показа не рисует значение', () => {
    const on = runCreateWidget(true);
    expect(on.__w.style.display).toBe('none');
    expect(on.__w.querySelector('.ai-widget-text').textContent).toBe('—');
  });
});
