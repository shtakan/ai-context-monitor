/**
 * O-34 (N1, Low): остаточные значения бейджа на URL без /c/<id>.
 *
 * Дефект (наблюдение N1): переход с /c/<id1> на URL без разговора (корень чата, /gpts,
 * новый чат) НЕ сбрасывал состояние — бейдж/виджет/снимок попапа держали значения прошлой
 * сессии. Корень: решение о сбросе в MAIN-перехватчике строилось на предикате
 * `shouldResetChatConversation(prev, next)`, который отвечает false, когда next пуст
 * («сброс только при появлении НОВОГО НЕПУСТОГО id»). Из-за этого checkConvChange не звал
 * resetForNewConversation → не диспатчилось 'ai-cm-conversation-changed' → ISOLATED не
 * выполнял resetConversationState/BADGE_RESET. Второй путь того же дефекта: прямой вход на
 * URL без /c/<id> — смены истории нет вовсе, а per-tab бейдж SW и снимок попапа живут на
 * уровне вкладки и переживают навигацию в ней же.
 *
 * Фикс (две точки, каждая — существующий механизм сброса):
 *   1) utils/chatgpt-conversation-parser.js:shouldResetConversationOnNav — решение для
 *      НАВИГАЦИИ (надмножество прежнего предиката: смена контекста, включая ПОТЕРЮ id);
 *      core/page-intercept.js:checkConvChange использует его;
 *   2) core/content.js:aiCmResetStaleStateOnChatlessChatGptUrl — холодный вход на URL без
 *      /c/<id> (гейт chatgpt) сам зовёт resetConversationState + BADGE_RESET; вызов стоит
 *      в initialize() после выбора адаптера и ДО создания виджета.
 *
 * Контракт, который здесь удостоверяется:
 *   D1 переход /c/id1 → URL без /c/<id>: реальный MAIN-путь сбрасывает контекст, реальный
 *      ISOLATED-слушатель гасит состояние (baseCount=0, tokens=0, suppression) и per-tab
 *      бейдж (BADGE_RESET); после сброса дорисовки остатков нет;
 *   D2 прямой вход на URL без /c/<id>: состояние пустое, снимок попапа удалён, дорисовки
 *      нет; гейт — только chatgpt (прочие сервисы не тронуты);
 *   R1 SPA-переход между двумя валидными чатами работает как прежде: одно событие сброса,
 *      новый convId, прежняя семантика решения на непустом новом id;
 *   R2 холостые переходы (тот же id, та же пустота) не сбрасывают ничего, полный круг
 *      даёт ровно по одному сбросу на смену контекста; событие с тем же convId состояние
 *      сбрасывает (контракт O-22), но бейдж-сброс не дублирует;
 *   R3 пины проводки и границ: export-manager.js/tokenizer.js/manifest.json не тронуты.
 *
 * Исполняются РЕАЛЬНЫЕ функции: utils/chatgpt-conversation-parser.js
 * (getConvIdFromPath/shouldResetConversationOnNav — для MAIN и для прежнего предиката),
 * utils/export-emit-pipeline.js (extractConvIdFromUrl — id со стороны ISOLATED, как в
 * content.js:getCurrentConvId), core/page-intercept.js (getConvId/resetForNewConversation/
 * checkConvChange), слушатель 'ai-cm-conversation-changed' из core/content.js,
 * core/content.js:aiCmResetStaleStateOnChatlessChatGptUrl, core/widget.js
 * (resetConversationState — единственный механизм сброса состояния, updateWidget —
 * единственная печать badge-update). Стрелки MAIN→ISOLATED идут через реальный CustomEvent
 * jsdom: harness диспатчит событие из настоящего resetForNewConversation.
 *
 * НЕ ТРОГАЕТСЯ (пины R3): прежний предикат shouldResetChatConversation (его контракт
 * закреплён tests/adapters/chatgpt-conversation-parser.test.js и сохранён 1:1),
 * utils/tokenizer.js, core/export-manager.js, manifest.json.
 */

const fs = require('fs');
const path = require('path');

const H = require('./helpers/content-source.js');
const PARSER = require('../utils/chatgpt-conversation-parser.js');
const Pipeline = require('../utils/export-emit-pipeline.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = H.contentSource;                                  // модули + content.js (единый скоуп)
const WIDGET_SRC = H.moduleSource('core/widget.js');
const PARSER_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'chatgpt-conversation-parser.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'page-intercept.js'), 'utf8');
const BG_SRC = fs.readFileSync(path.join(ROOT, 'core', 'background.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const TOKENIZER_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'tokenizer.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/o33-autoexport-base-pending.test.js).
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

// Анонимный слушатель 'ai-cm-conversation-changed' (core/content.js) — второе плечо сброса.
function listenerFnSrc() {
  const marker = "window.addEventListener('ai-cm-conversation-changed', function () {";
  const start = CONTENT.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const fnStart = CONTENT.indexOf('function () {', start);
  let depth = 0;
  for (let i = CONTENT.indexOf('{', fnStart); i < CONTENT.length; i++) {
    if (CONTENT[i] === '{') depth++;
    else if (CONTENT[i] === '}') {
      depth--;
      if (depth === 0) return CONTENT.slice(fnStart, i + 1);
    }
  }
  throw new Error('unbalanced ai-cm-conversation-changed listener');
}

const ID1 = '6a59cfa1-8e8c-83ed-8ba7-995740b83dd9';
const ID2 = '7fec9bd3-1c4a-4f2b-9d17-2b0c3f4a5b6c';
const HOST = 'chatgpt.com';
const BADGE_PREFIX = '[AI CM][trace] badge-update';
const SNAPSHOT_KEYS = ['aiCmState', 'aiCmState:' + HOST];

const listeners = [];

beforeEach(() => {
  window.ChatGPTConversationParser = PARSER; // MAIN-мир манифеста: utils/chatgpt-conversation-parser.js
});

afterEach(() => {
  listeners.splice(0).forEach(function (l) {
    try { window.removeEventListener('ai-cm-conversation-changed', l); } catch (e) { }
  });
  try { delete window.ChatGPTConversationParser; } catch (e) { }
  document.body.innerHTML = '';
});

// =====================================================================================
// MAIN-мир: РЕАЛЬНЫЕ getConvId / resetForNewConversation / checkConvChange
// =====================================================================================
const NAV_SCOPE = 'with (ctx) { ' +
  fnDecl(PAGE_SRC, 'getConvId') + '\n' +
  fnDecl(PAGE_SRC, 'resetForNewConversation') + '\n' +
  fnDecl(PAGE_SRC, 'checkConvChange') + '\n' +
  ' return { check: checkConvChange, getConvId: getConvId, reset: resetForNewConversation }; }';
const makeNavApi = new Function('ctx', NAV_SCOPE);

// =====================================================================================
// ISOLATED-мир: РЕАЛЬНЫЙ слушатель смены разговора (core/content.js)
// =====================================================================================
const LISTENER_FN = listenerFnSrc();
const makeListenerFn = new Function('ctx', 'with (ctx) { var fn = ' + LISTENER_FN + '; return fn; }');

// =====================================================================================
// Состояние контент-скрипта: РЕАЛЬНЫЙ resetConversationState (core/widget.js)
// =====================================================================================
const RESET_SCOPE = 'with (ctx) { ' + fnDecl(WIDGET_SRC, 'resetConversationState') +
  '\n return { reset: resetConversationState }; }';
const makeResetApi = new Function('ctx', RESET_SCOPE);

const ZEROED_VARS = ['baseIdSet', 'baseSkelSet', 'baseAnchors', 'lastTailSig', 'lastDetailMessages',
  'aiCmBasePrepared', 'lastHistoryWroteKey', 'lastThreadId', 'lastSnapshotModelName',
  'lastResolvedModelId', 'aiCmRequestEmitTimer'];

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
 * Стенд «состояние прошлого разговора + РЕАЛЬНЫЙ resetConversationState».
 * Значения взяты из живого артефакта O-1 F5#2 (msgs=71, tokens=50992, pct=39.8).
 */
function makeOldChatState(over) {
  const o = over || {};
  const el = widgetEl();
  const removed = [];
  const ctx = {
    // ---- окружение ----
    currentAdapter: { siteName: o.site || 'chatgpt' },
    window: { AiCmExportEmitPipeline: null, __aiCmTraceSeq: 0, location: { hostname: HOST } },
    widgetElement: el,
    getCurrentConvId: function () { return (o.convId !== undefined) ? o.convId : ID1; },
    debugLog: function () { },
    isExtensionValid: function () { return true; },
    chrome: { storage: { local: { remove: function (keys) { removed.push(keys); } } } },
    scheduleStaleCheck: function () { },
    zoneColor: function () { return '#22c55e'; },
    // ---- состояние ПРОШЛОГО разговора (после приёма снимка /c/<id>) ----
    stale: false,
    baseText: 'база прошлого разговора',
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
    netAttachBreak: { imgTokens: 5355, docTokens: 0, imgCount: 7, docCount: 0 },
    netServerTokens: 0,
    netEffectiveLen: 0,
    lastCountTokensText: '',
    lastCountTokensCache: 0,
    restoredTapeLoaded: true,
    cacheRefreshPlanned: { x: 1 },
    restoreDone: true,
    tapeRestoreSeen: { x: 1 },
    aiCmRestoredDispatched: { x: 1 },
    aiCmArchiveLoadStarted: { x: 1 },
    aiCmArchiveRestoredDispatched: { x: 1 },
    aiCmArchiveCountByConv: { x: 1 },
    lastEmitConvId: ID1,
    autoExportLastPct: 39.8,
    autoExportFired: {},
    aiCmLateCheckByConv: { x: 1 },
    aiCmCursorLiveByConv: { x: 1 },
    aiCmBaseConfirmedByConv: { x: 1 },
    aiCmLowConfidenceByConv: { x: 1 },
    trimProbe: { x: 1 },
    preTrimExportFired: { x: 1 },
    trimRetryByConv: { x: 1 },
    badgeSuppressed: false,
    adapterBaseSeen: true,
    lastWidgetData: { percentage: 39.8, tokenEstimate: 50992 },
    aiCmContentReadySent: true
  };
  ZEROED_VARS.forEach(function (k) { if (!(k in ctx)) ctx[k] = null; });
  const api = makeResetApi(ctx);
  return { ctx: ctx, el: el, removed: removed, reset: api.reset };
}

// =====================================================================================
// Отрисовка: РЕАЛЬНЫЙ updateWidget + ветвление DRAW (первая ветвь — супрессия v54/O-1)
// =====================================================================================
const DRAW_SCOPE = 'with (ctx) { ' + fnDecl(WIDGET_SRC, 'updateWidget') +
  '\n ctx.updateWidget = updateWidget; }';

function makeDraw(over) {
  const o = over || {};
  const logs = [];
  const el = widgetEl();
  const ctx = {
    currentAdapter: { siteName: o.site || 'chatgpt' },
    baseSeen: o.baseSeen === true,
    badgeSuppressed: o.badgeSuppressed === true,
    adapterBaseSeen: o.adapterBaseSeen === true,
    aiCmLoaderFreeze: false,
    baseCount: o.baseCount || 0,
    lastBaseTexts: [],
    widgetElement: el,
    stale: false,
    lastWidgetData: null,
    aiCmSourceLabelNow: '',
    getCurrentConvId: function () { return o.convId || ''; },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    aiCmRevealWidget: function () { },
    aiCmRefreshThemeIfNeeded: function () { },
    aiCmUpdateSourceIndicator: function () { },
    zoneColor: function () { return '#22c55e'; },
    aiCmActivePct: function () { return null; },
    document: document,
    window: window
  };
  new Function('ctx', DRAW_SCOPE)(ctx);
  function draw(percentage, tokens) {
    // ветвление processAndSend (core/content.js): SPA-супрессия → freeze лоадера → updateWidget
    if (ctx.badgeSuppressed && !ctx.baseSeen && !ctx.adapterBaseSeen) return;
    if (ctx.aiCmLoaderFreeze) return;
    ctx.updateWidget(percentage, tokens, 128000, 128000, 128000, 'GPT-5', null);
  }
  return {
    ctx: ctx,
    el: el,
    draw: draw,
    badgeUpdates: function () {
      return logs.filter(function (l) { return l.indexOf(BADGE_PREFIX) === 0; });
    }
  };
}

// =====================================================================================
// Полный SPA-стенд: MAIN (парсер + page-intercept) → CustomEvent → ISOLATED (listener)
// =====================================================================================
function makeSpa(startConvId, startPath, over) {
  const o = over || {};
  const st = makeOldChatState({ convId: startConvId, site: o.site });
  const resets = [];
  const badgeResets = [];
  const cancels = [];

  // ISOLATED-сторона: id читается из URL тем же путём, что content.js:getCurrentConvId
  const isoCtx = {
    currentAdapter: { siteName: o.site || 'chatgpt' },
    location: { href: 'https://' + HOST + startPath, pathname: startPath },
    convId: startConvId,
    aiCmLastSeenConvId: startConvId,
    aiCmAdapterBaseCount: 71,                       // остаток адаптерной базы прошлого чата
    aiCmQwenSpaResetAt: 0,
    getCurrentConvId: function () { return Pipeline.extractConvIdFromUrl(isoCtx.location.pathname) || ''; },
    // РЕАЛЬНЫЙ сброс состояния + запись факта вызова с convId НА МОМЕНТ события
    resetConversationState: function () { resets.push(isoCtx.convId); st.reset(); },
    aiCmCancelDeferredHistWrite: function (v) { cancels.push(v); return true; },
    aiCmQwenSpaReshoot: function () { },
    aiCmGsaDiagState: function () { },
    debugLog: function () { },
    chrome: { runtime: { sendMessage: function (m) { badgeResets.push(m && m.type); return Promise.resolve(); } } }
  };
  const listener = makeListenerFn(isoCtx);
  window.addEventListener('ai-cm-conversation-changed', listener);
  listeners.push(listener);

  // MAIN-сторона: реальный getConvId (парсер) + реальный resetForNewConversation (диспатч события)
  const mainCtx = {
    window: window,
    location: { pathname: startPath },
    currentConvId: startConvId,
    debugLog: function () { },
    scheduleSwitchRefetch: function () { },
    scheduleFallback: function () { },
    lastSnapshotUrl: 'https://' + HOST + '/backend-api/conversation/' + startConvId,
    lastLoadedConvId: startConvId,
    dirty: true,
    refreshBusy: false,
    activeDisabled: false,
    loggedActiveStatus: false,
    attachSeen: { x: 1 },
    attachTokens: 765,
    attachBreak: { imgTokens: 765, docTokens: 0, imgCount: 1, docCount: 0 },
    loggedAttach: true,
    activeRetryCount: 2
  };
  const nav = makeNavApi(mainCtx);

  return {
    st: st,
    isoCtx: isoCtx,
    mainCtx: mainCtx,
    resets: resets,
    badgeResets: badgeResets,
    cancels: cancels,
    // навигация: путь меняется на ОБЕИХ сторонах (как location в браузере)
    go: function (pathname) {
      mainCtx.location.pathname = pathname;
      isoCtx.location.pathname = pathname;
      isoCtx.convId = Pipeline.extractConvIdFromUrl(pathname) || '';
      nav.check();
    },
    // принудительный диспатч события без смены пути (для пинов контракта слушателя)
    dispatch: function () {
      window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed'));
    }
  };
}

// =====================================================================================
// Холодный вход: РЕАЛЬНЫЙ aiCmResetStaleStateOnChatlessChatGptUrl (core/content.js)
// =====================================================================================
const CHATLESS_SCOPE = 'with (ctx) { ' +
  fnDecl(CONTENT, 'aiCmResetStaleStateOnChatlessChatGptUrl') +
  '\n return { run: aiCmResetStaleStateOnChatlessChatGptUrl }; }';
const makeChatlessApi = new Function('ctx', CHATLESS_SCOPE);

function makeChatless(over) {
  const o = over || {};
  const pathname = (o.pathname !== undefined) ? o.pathname : '/';
  const st = makeOldChatState({ site: o.site, convId: Pipeline.extractConvIdFromUrl(pathname) || '' });
  const resets = [];
  const badgeResets = [];
  const logs = [];
  const ctx = {
    currentAdapter: { siteName: o.site || 'chatgpt' },
    location: { href: 'https://' + HOST + pathname, pathname: pathname },
    getCurrentConvId: function () { return Pipeline.extractConvIdFromUrl(ctx.location.pathname) || ''; },
    resetConversationState: function () { resets.push(ctx.location.pathname); st.reset(); },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    chrome: { runtime: { sendMessage: function (m) { badgeResets.push(m && m.type); return Promise.resolve(); } } }
  };
  const api = makeChatlessApi(ctx);
  return { st: st, ctx: ctx, resets: resets, badgeResets: badgeResets, logs: logs, run: api.run };
}

// =====================================================================================
// D1: /c/id1 → URL без /c/<id> — SPA-переход обязан сбросить состояние и бейдж
// =====================================================================================
describe('O-34 D1: переход с /c/<id> на URL без /c/<id> сбрасывает состояние и бейдж', () => {
  test('D1-корень: прежний предикат на потерю id отвечает false — остатки прошлого чата ЖИВУТ', () => {
    expect(PARSER.shouldResetChatConversation(ID1, '')).toBe(false); // корень дефекта N1
    // потому остаточные значения прошлого разговора остаются на бейдже (до фикса):
    const d = makeDraw({ badgeSuppressed: false, baseSeen: true, adapterBaseSeen: true });
    d.draw(39.8, 50992);
    expect(d.badgeUpdates()).toHaveLength(1);
    expect(d.badgeUpdates()[0]).toContain('badge-update pct=39.8% tokens=50992');
  });

  test('D1: реальный MAIN-путь → реальный слушатель: сброс контекста, состояния и per-tab бейджа', () => {
    const h = makeSpa(ID1, '/c/' + ID1);
    expect(h.isoCtx.aiCmLastSeenConvId).toBe(ID1);

    h.go('/');

    // MAIN: контекст обновлён (id потерян) и событие ушло (реальный resetForNewConversation)
    expect(h.mainCtx.currentConvId).toBe('');
    // ISOLATED: resetConversationState вызван РОВНО один раз, с пустым convId
    expect(h.resets).toEqual(['']);
    // per-tab бейдж SW гасится той же точкой, что и на SPA-смене разговора
    expect(h.badgeResets).toEqual(['BADGE_RESET']);
    expect(h.isoCtx.aiCmLastSeenConvId).toBe('');
    expect(h.isoCtx.aiCmAdapterBaseCount).toBe(0);        // метка «Источник» нового документа пуста
    expect(h.cancels).toEqual(['']);                      // висящий deferred-таймер старого чата снят

    // состояние прошлой сессии обнулено РЕАЛЬНЫМ resetConversationState
    expect(h.st.ctx.baseCount).toBe(0);
    expect(h.st.ctx.baseText).toBe('');
    expect(h.st.ctx.baseSeen).toBe(false);
    expect(h.st.ctx.maxTokenCount).toBe(0);
    expect(h.st.ctx.lastEmitConvId).toBe('');
    expect(h.st.ctx.autoExportLastPct).toBe(-1);
    expect(h.st.ctx.badgeSuppressed).toBe(true);          // до первого снимка нового контекста
    expect(h.st.ctx.adapterBaseSeen).toBe(false);
    expect(h.st.ctx.lastWidgetData).toBeNull();
    expect(h.st.el.querySelector('.ai-widget-text').textContent).toBe('—');
    // снимок попапа (O-14) снят: остаточных «71 / 50992 / 39.8%» нет
    expect(h.st.removed).toEqual([SNAPSHOT_KEYS]);
  });

  test('D1: после сброса дорисовки остатков нет (супрессия — первая ветвь DRAW)', () => {
    const h = makeSpa(ID1, '/c/' + ID1);
    h.go('/');
    const d = makeDraw({
      badgeSuppressed: h.st.ctx.badgeSuppressed,
      baseSeen: h.st.ctx.baseSeen,
      adapterBaseSeen: h.st.ctx.adapterBaseSeen
    });
    d.draw(0, h.st.ctx.maxTokenCount);                    // расчёт по DOM нового URL
    expect(d.badgeUpdates()).toEqual([]);                 // ни одной дорисовки
    expect(d.el.querySelector('.ai-widget-text').textContent).toBe('—');
  });

  test('D1: SW-точка бейджа — обработчик BADGE_RESET чистит per-tab текст (background.js)', () => {
    expect(BG_SRC).toContain("message.type === 'BADGE_RESET'");
    expect(BG_SRC).toContain("chrome.action.setBadgeText({ text: '', tabId: tabIdR });");
  });
});

// =====================================================================================
// D2: прямой вход на URL без /c/<id> — состояние пустое, дорисовки нет
// =====================================================================================
describe('O-34 D2: прямой вход на URL без /c/<id> даёт пустое состояние без дорисовки', () => {
  test('D2: SPA-плечо молчит (смены истории нет) — вход закрывает холодный хелпер', () => {
    const h = makeSpa('', '/');
    h.go('/');                                            // «переход» на тот же корень
    expect(h.resets).toEqual([]);                         // событие не диспатчится — SPA-путь не помогает
    expect(h.badgeResets).toEqual([]);
  });

  test('D2: реальный хелпер на chatgpt без /c/<id> гасит состояние и бейдж ровно один раз', () => {
    const h = makeChatless({ pathname: '/' });
    expect(h.run()).toBe(true);
    expect(h.resets).toEqual(['/']);
    expect(h.badgeResets).toEqual(['BADGE_RESET']);
    // состояние пустое: 0 сообщений, 0 токенов, снимок попапа удалён
    expect(h.st.ctx.baseCount).toBe(0);
    expect(h.st.ctx.maxTokenCount).toBe(0);
    expect(h.st.ctx.lastPercentage).toBe(-1);
    expect(h.st.ctx.baseSeen).toBe(false);
    expect(h.st.ctx.lastWidgetData).toBeNull();
    expect(h.st.removed).toEqual([SNAPSHOT_KEYS]);
    expect(h.st.el.querySelector('.ai-widget-text').textContent).toBe('—');
    expect(h.logs.join('\n')).toContain('O-34: URL без /c/<id>');
  });

  test('D2: на URL С разговором (/c/<id>) хелпер — no-op (холодный старт чата не тронут)', () => {
    const h = makeChatless({ pathname: '/c/' + ID1 });
    expect(h.run()).toBe(false);
    expect(h.resets).toEqual([]);
    expect(h.badgeResets).toEqual([]);
    expect(h.st.removed).toEqual([]);                     // снимок валидного чата не удаляется
  });

  test('D2: гейт — только chatgpt; прочие сервисы байтово прежние (id в URL не обязателен)', () => {
    ['gemini', 'google_search', 'claude', 'deepseek', 'perplexity'].forEach(function (site) {
      const h = makeChatless({ site: site, pathname: '/' });
      expect(h.run()).toBe(false);
      expect(h.resets).toEqual([]);
      expect(h.badgeResets).toEqual([]);
    });
  });

  test('D2: дорисовки нет — супрессия взведена, контроль без неё рисует (стенд не вырожден)', () => {
    const h = makeChatless({ pathname: '/' });
    h.run();
    const suppressed = makeDraw({
      badgeSuppressed: h.st.ctx.badgeSuppressed,
      baseSeen: h.st.ctx.baseSeen,
      adapterBaseSeen: h.st.ctx.adapterBaseSeen
    });
    suppressed.draw(0, 0);
    expect(suppressed.badgeUpdates()).toEqual([]);
    expect(suppressed.el.querySelector('.ai-widget-text').textContent).toBe('—');

    const control = makeDraw({ badgeSuppressed: false, baseSeen: false, adapterBaseSeen: false });
    control.draw(39.8, 50992);
    expect(control.badgeUpdates()).toHaveLength(1);       // контроль: без супрессии отрисовка есть
  });

  test('D2-проводка: initialize зовёт хелпер после выбора адаптера и ДО создания виджета', () => {
    const init = fnDecl(CONTENT, 'initialize');
    const iAdapter = init.indexOf('aiCmAssignAdapterByHost();');
    const iCall = init.indexOf('aiCmResetStaleStateOnChatlessChatGptUrl();');
    const iCreate = init.indexOf('createWidget();');
    const iReady = init.indexOf('aiCmDispatchContentReady();');
    expect(iAdapter).toBeGreaterThan(-1);
    expect(iCall).toBeGreaterThan(iAdapter);              // адаптер уже известен (гейт по siteName)
    expect(iCreate).toBeGreaterThan(iCall);               // виджет создаётся ПОСЛЕ сброса
    expect(iReady).toBeGreaterThan(iCall);
    // typeof-гард — конвенция сьюта для срез-песочниц частичного скоупа (initialize-стенд O-35)
    expect(init).toContain("if (typeof aiCmResetStaleStateOnChatlessChatGptUrl === 'function') {");
    const fn = fnDecl(CONTENT, 'aiCmResetStaleStateOnChatlessChatGptUrl');
    expect(fn).toContain("currentAdapter.siteName !== 'chatgpt'");
    expect(fn).toContain('if (getCurrentConvId()) return false;');
    expect(fn).toContain('resetConversationState();');
    expect(fn).toContain("chrome.runtime.sendMessage({ type: 'BADGE_RESET' })");
  });
});

// =====================================================================================
// R1: SPA-переход между двумя валидными чатами — как прежде
// =====================================================================================
describe('O-34 R1: смена валидного id работает как прежде', () => {
  test('R1: /c/id1 → /c/id2: одно событие сброса, новый convId, бейдж-сброс, состояние очищено', () => {
    const h = makeSpa(ID1, '/c/' + ID1);
    h.go('/c/' + ID2);
    expect(h.mainCtx.currentConvId).toBe(ID2);
    expect(h.resets).toEqual([ID2]);                      // один сброс, convId — новый
    expect(h.badgeResets).toEqual(['BADGE_RESET']);
    expect(h.isoCtx.aiCmLastSeenConvId).toBe(ID2);
    expect(h.st.ctx.baseCount).toBe(0);
    expect(h.st.ctx.maxTokenCount).toBe(0);
    expect(h.st.ctx.badgeSuppressed).toBe(true);
    expect(h.st.removed).toEqual([SNAPSHOT_KEYS]);
  });

  test('R1: на НЕПУСТОМ новом id решение 1:1 прежнему предикату (байтовая идентичность)', () => {
    [[ID1, ID2], [ID1, ID1], ['', ID2], ['abc', 'def'], ['abc', 'abc']].forEach(function (pair) {
      const prev = pair[0], next = pair[1];
      expect(PARSER.shouldResetConversationOnNav(prev, next))
        .toBe(PARSER.shouldResetChatConversation(prev, next));
    });
  });

  test('R1: событие со сменой id ведёт себя как прежде — контракт слушателя не тронут', () => {
    const h = makeSpa(ID1, '/c/' + ID1);
    const iso = listenerFnSrc();
    // порядок в слушателе: отмена deferred старого чата → BADGE_RESET → новый aiCmLastSeenConvId
    const iCancel = iso.indexOf('aiCmCancelDeferredHistWrite');
    const iBadge = iso.indexOf("chrome.runtime.sendMessage({ type: 'BADGE_RESET' })");
    const iSeen = iso.indexOf('aiCmLastSeenConvId = newCid;');
    expect(iCancel).toBeGreaterThan(-1);
    expect(iBadge).toBeGreaterThan(iCancel);
    expect(iSeen).toBeGreaterThan(iBadge);
    // и сам механизм сброса остался на месте (reset вызывается безусловно — контракт O-22)
    expect(iso).toContain('resetConversationState();');
    expect(iso).toContain('aiCmAdapterBaseCount = 0;');
    h.go('/c/' + ID2);
    expect(h.resets).toHaveLength(1);
  });
});

// =====================================================================================
// R2: холостые переходы не сбрасывают; полный круг — по одному сбросу на смену
// =====================================================================================
describe('O-34 R2: холостые SPA-переходы не сбрасывают, полный круг — по одному сбросу', () => {
  test('R2: тот же id и та же пустота → ни сброса, ни события, ни бейдж-сброса', () => {
    const h = makeSpa(ID1, '/c/' + ID1);
    h.go('/c/' + ID1);
    h.go('/c/' + ID1);
    expect(h.resets).toEqual([]);
    expect(h.badgeResets).toEqual([]);
    expect(h.mainCtx.currentConvId).toBe(ID1);

    const root = makeSpa('', '/');
    root.go('/');
    root.go('/gpts');
    expect(root.resets).toEqual([]);                       // '' → '' — тот же контекст
    expect(root.badgeResets).toEqual([]);
  });

  test('R2: круг /c/id1 → /c/id2 → /c/id1 → / → /c/id1 — ровно по одному сбросу на смену', () => {
    const h = makeSpa(ID1, '/c/' + ID1);
    h.go('/c/' + ID2);   // 1
    h.go('/c/' + ID1);   // 2
    h.go('/');           // 3
    h.go('/c/' + ID1);   // 4
    expect(h.resets).toEqual([ID2, ID1, '', ID1]);
    expect(h.badgeResets).toEqual(['BADGE_RESET', 'BADGE_RESET', 'BADGE_RESET', 'BADGE_RESET']);
    expect(h.mainCtx.currentConvId).toBe(ID1);
    expect(h.isoCtx.aiCmLastSeenConvId).toBe(ID1);
  });

  test('R2: событие с тем же convId состояние сбрасывает (контракт O-22), бейдж не трогает', () => {
    const h = makeSpa(ID1, '/c/' + ID1);
    h.dispatch();
    expect(h.resets).toEqual([ID1]);                      // resetConversationState безусловен
    expect(h.badgeResets).toEqual([]);                    // повторный BADGE_RESET не шлётся
  });

  test('R2: механизм прежнего перехода не переписан (resetForNewConversation байтово прежний)', () => {
    const reset = fnDecl(PAGE_SRC, 'resetForNewConversation');
    expect(reset).toContain("window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed'));");
    expect(reset).toContain('scheduleSwitchRefetch();');
    expect(reset).toContain('scheduleFallback(currentConvId, 2000);');
    expect(reset).toContain("(currentConvId || '(не чат)')");
    expect(reset).toContain('lastLoadedConvId = \'\';');
  });
});

// =====================================================================================
// R3: проводка и границы — «не трогать» соблюдено
// =====================================================================================
describe('O-34 R3: пины проводки и границ', () => {
  test('R3: MAIN использует решение с учётом потери id; прежний предикат остался в API', () => {
    const check = fnDecl(PAGE_SRC, 'checkConvChange');
    expect(check).toContain('P.shouldResetConversationOnNav(currentConvId, newId)');
    expect(check).not.toContain('shouldReset = !!newId &&');
    expect(check).toContain('shouldReset = (newId !== currentConvId);');   // фолбэк без утилиты
    expect(typeof PARSER.shouldResetConversationOnNav).toBe('function');
    expect(typeof PARSER.shouldResetChatConversation).toBe('function');
    // старый контракт не переписан (пин tests/adapters/chatgpt-conversation-parser.test.js)
    expect(PARSER.shouldResetChatConversation('abc', '')).toBe(false);
    expect(PARSER.shouldResetChatConversation('', '')).toBe(false);
    expect(PARSER.shouldResetChatConversation('abc', 'def')).toBe(true);
  });

  test('R3: новое решение живёт ровно в двух точках (парсер + перехватчик), дублей нет', () => {
    const files = [
      'utils/chatgpt-conversation-parser.js', 'core/page-intercept.js', 'core/content.js',
      'core/widget.js', 'core/state.js', 'core/export-manager.js', 'utils/export-emit-pipeline.js',
      'utils/tokenizer.js', 'manifest.json'
    ];
    const withSymbol = files.filter(function (rel) {
      return fs.readFileSync(path.join(ROOT, rel), 'utf8').indexOf('shouldResetConversationOnNav') !== -1;
    });
    expect(withSymbol).toEqual(['utils/chatgpt-conversation-parser.js', 'core/page-intercept.js']);
    const withHelper = files.filter(function (rel) {
      return fs.readFileSync(path.join(ROOT, rel), 'utf8').indexOf('aiCmResetStaleStateOnChatlessChatGptUrl') !== -1;
    });
    expect(withHelper).toEqual(['core/content.js']);
  });

  test('R3: utils/tokenizer.js и core/export-manager.js не тронуты; manifest.json не менялся', () => {
    [TOKENIZER_SRC, MGR_SRC].forEach(function (src) {
      expect(src).not.toContain('shouldResetConversationOnNav');
      expect(src).not.toContain('aiCmResetStaleStateOnChatlessChatGptUrl');
      expect(src).not.toContain('BADGE_RESET');
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const js = manifest.content_scripts[0].js;
    expect(js).not.toContain('core/page-intercept.js');   // MAIN-перехватчик — программная регистрация
    expect(js[js.length - 1]).toBe('core/content.js');     // порядок контент-скриптов прежний
    // парсер и перехватчик едут ОДНИМ пакетом: новое решение доступно checkConvChange
    expect(BG_SRC).toContain("js: ['utils/debug.js', 'utils/chatgpt-conversation-parser.js', " +
      "'utils/intercept-common.js', 'core/page-intercept.js']");
    expect(BG_SRC).toContain("world: 'MAIN'");
  });
});
