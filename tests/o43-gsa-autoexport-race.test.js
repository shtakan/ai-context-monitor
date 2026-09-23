/**
 * O-43: race автоэкспорта GSA — memory-снимок уходил в файл раньше сетевого дозревания.
 *
 * ИЗМЕРЕНО (живой прогон O-43, GSA под гейтом aiCmDebug): файл писался по базе 22 msgs за
 * 262 мс до сетевой базы 32 msgs; окно между первым memory-состоянием и полным сетевым
 * вердиктом — 264–504 мс (и не ограничено сверху: +400 мс на страницу пагинации,
 * FOLWR_PAGE_DELAY_MS). Корень (чтение живых логов): не отсутствие сети, а РЕГРЕССИЯ
 * вердикта полноты — сетевой эмит с historyComplete=true (probe-классификатор folwr:
 * kind=cursor-repeat|no-new-turns) перекрывается последующими эмитами ТОГО ЖЕ треда с
 * historyComplete=0 (handshake-переэмит + повторный open-путь после probe), поэтому
 * переменная baseComplete (core/content.js) снова false, а гейт автоэкспорта снова даёт
 * not-complete. Delay-N-ms и гейт «histSource=network» этого не лечат.
 *
 * РЕШЕНИЕ: монотонный латч сетевой полноты — 'site|threadId' → 1 (core/state.js:
 * aiCmGsaNetworkCompleteLatch). Взвод — приём сетевого снимка с detail.historyComplete===true
 * (core/content.js, слушатель 'ai-cm-full-history'); НЕ снимается эмитами historyComplete=0;
 * сброс — только на смене треда (core/widget.js:resetConversationState по data-session-thread-id);
 * чтение — core/export-manager.js:maybeAutoExport → state.gsaNetworkCompleteLatch →
 * utils/export-emit-pipeline.js:shouldSkipAutoExport.
 *
 * НЕ ТРОГАЕТСЯ (пины R ниже): mergeTurns/applyTurns, пороги и гистерезис −10 п.п., имена и
 * байты файла, латч fired (O-38) и латч spa-entry (O-29), формулировки причин skip, вердикты
 * шести платформ при отсутствии поля, GSA threadId-сегментация (O-31) и captcha-гард (O-27).
 *
 * Исполняются РЕАЛЬНЫЕ функции: shouldSkipAutoExport (utils/export-emit-pipeline.js),
 * aiCmGsaNetworkCompleteReset/Set/Is + maybeAutoExport (core/export-manager.js),
 * resetConversationState (core/widget.js) — в песочнице с РЕАЛЬНЫМ объектом состояния
 * (require core/state.js), как в browser'е (общий лексический скоуп контент-скриптов).
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const STATE = require('../core/state.js');
const HELPER = require('./helpers/content-source.js');

const ROOT = HELPER.ROOT;
const CONTENT = HELPER.contentSource;
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const WIDGET_SRC = fs.readFileSync(path.join(ROOT, 'core', 'widget.js'), 'utf8');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');

// Рез по балансу фигурных скобок (как в tests/gsa-autoexport.test.js).
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
const TID = 'O43-THREAD-A';
const TID2 = 'O43-THREAD-B';

// =====================================================================================
// Песочница 1: РЕАЛЬНЫЙ латч + РЕАЛЬНЫЕ писатель/читатель (export-manager.js) + РЕАЛЬНЫЙ
// сброс (widget.js). Состояние объявляется ВНУТРИ песочницы и отдаётся наружу через
// Object.defineProperty-аксессоры — ровно как в core/state.js. Так воспроизводится общий
// лексический скоуп контент-скриптов: если положить состояние в ctx, with-скоуп перекроет
// лексическую привязку, и присваивание внутри среза уйдёт в ctx (а хелпер прочтёт
// лексическую переменную) — «слот сброса» перестал бы обновляться, чего в браузере нет.
// aiCmAutoExportConvId обязан быть в срезе: его зовёт писатель (в браузере виден по общему скоупу).
// =====================================================================================
const SCOPE = 'with (ctx) {' +
  ' var aiCmGsaNetworkCompleteLatch = Object.create(null);' +
  ' var aiCmGsaNetworkCompleteThreadId = null;' +
  fnDecl(MGR_SRC, 'aiCmAutoExportConvId') + '\n' +
  fnDecl(MGR_SRC, 'aiCmGsaNetworkCompleteReset') + '\n' +
  fnDecl(MGR_SRC, 'aiCmGsaNetworkCompleteSet') + '\n' +
  fnDecl(MGR_SRC, 'aiCmGsaNetworkCompleteIs') + '\n' +
  // РЕАЛЬНЫЙ resetConversationState (widget.js) — в ТОЙ ЖЕ компиляции: иначе его присваивание
  // слоту ушло бы в собственную копию переменной (отдельный new Function = отдельный скоуп).
  fnDecl(WIDGET_SRC, 'resetConversationState') + '\n' +
  ' var Api = {};' +
  " Object.defineProperty(Api, 'latch', { enumerable: true, get: function () { return aiCmGsaNetworkCompleteLatch; } });" +
  " Object.defineProperty(Api, 'slot', { enumerable: true, get: function () { return aiCmGsaNetworkCompleteThreadId; } });" +
  ' Api.reset = resetConversationState;' +
  ' Api.set = aiCmGsaNetworkCompleteSet;' +
  ' Api.is = aiCmGsaNetworkCompleteIs;' +
  ' Api.resetLatch = aiCmGsaNetworkCompleteReset;' +
  ' return Api; }';
const makeApi = new Function('ctx', SCOPE);

// Состояние content-скрипта: РЕАЛЬНЫЙ resetConversationState (widget.js) + минимум полей и
// заглушек, которые он читает. Латч — общий с песочницей (аксессор Api.latch).
function contentState(over) {
  const logs = [];
  const ctx = Object.assign({
    currentAdapter: { siteName: GSA },
    lastThreadId: TID,
    getCurrentConvId: function () { return ''; }, // у GSA URL-id нет
    aiCmDiagLine: function () { },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    window: {
      AiCmExportEmitPipeline: P,
      __aiCmDebugLogs: false,
      __aiCmTraceSeq: 0,
      location: { hostname: 'www.google.com' }
    },
    chrome: {
      runtime: { sendMessage: function () { return Promise.resolve(); } },
      storage: { local: { remove: function () { } }, session: { remove: function () { }, set: function () { } } }
    },
    isExtensionValid: function () { return true; },
    scheduleStaleCheck: function () { },
    zoneColor: function (p) { return p < 50 ? '#22c55e' : '#eab308'; },
    widgetElement: null,
    stale: false,
    badgeSuppressed: false,
    adapterBaseSeen: false,
    lastWidgetData: null,
    aiCmRequestEmitTimer: null,
    aiCmContentReadySent: false,
    aiCmDiagDocKind: null,
    aiCmDiagStack: null,
    aiCmI18nMessage: null,
    aiCmLateCheckByConv: {},
    aiCmCursorLiveByConv: {},
    aiCmBaseConfirmedByConv: {},
    aiCmLowConfidenceByConv: {},
    trimProbe: {},
    preTrimExportFired: {},
    trimRetryByConv: {},
    aiCmBasePrepared: null,
    autoExportLastPct: -1,
    maxTokenCount: 0,
    lastCountTokensText: '',
    lastCountTokensCache: 0,
    lastResolvedModelId: null,
    lastSnapshotModelName: ''
  }, over || {});
  const api = makeApi(ctx);
  // threadId «снаффнутого DOM»: аксессор, а не функция-свойство — резолвится в with-скоупе
  // на каждом обращении (свойство-функция не находится лексически и дала бы ReferenceError).
  Object.defineProperty(ctx, 'aiCmDomThreadId', {
    enumerable: true, configurable: true,
    get: function () { return function () { return (typeof ctx.__domTid === 'string') ? ctx.__domTid : TID; }; }
  });
  // Сброс — как в браузере, ДО первого сетевого эмита этого треда: bring-up разговора
  // (resetConversationState вызывается на входе, сетевой эмит приходит после него).
  api.reset();
  return {
    ctx: ctx, set: api.set, is: api.is, reset: api.reset, latch: api.latch, logs: logs,
    // слот «тред последнего сброса» — геттером: значение меняется на каждом сбросе
    get slot() { return api.slot; }
  };
}

beforeEach(function () {
  // Латч живёт в песочнице каждого теста (как в новом instance контент-скрипта), но STATE
  // из core/state.js — модульный singleton прогона: чистим его карту для D4 (гейт читает
  // именно её), чтобы порядок тестов не влиял на вердикт.
  for (const k in STATE.aiCmGsaNetworkCompleteLatch) delete STATE.aiCmGsaNetworkCompleteLatch[k];
});

// =====================================================================================
// D1: эмит historyComplete=1 → латч взведён → автоэкспорт разрешён
// =====================================================================================
describe('O-43 D1: сетевой эмит с historyComplete=true взводит латч', () => {
  test('D1: взвод по (site, threadId); ключ включает сайт', function () {
    const h = contentState({});
    expect(h.is(GSA, TID)).toBe(false);                 // до эмита полноты нет
    expect(h.set(TID)).toBe(true);                      // приём снимка с historyComplete=true
    expect(h.is(GSA, TID)).toBe(true);                  // ключ site|threadId
    expect(h.latch[GSA + '|' + TID]).toBe(1);
    expect(h.is(GSA, TID2)).toBe(false);                // чужой тред латчем не покрыт
    expect(h.is('gemini', TID)).toBe(false);            // и чужой сервис тоже
  });

  test('D1: взведённый латч разрешает файл, когда baseComplete уже регрессировал', function () {
    const h = contentState({});
    h.set(TID);
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: false,               // ← регрессия вердикта (эмит historyComplete=0)
      baseSeen: true, loaderRunning: false, fired: false, isGemini: false,
      site: GSA, chatPageMarker: true, msgCount: 20, baseTextLen: 29527,
      gsaNetworkCompleteLatch: h.is(GSA, TID)
    });
    expect(v).toEqual({ skip: false, reason: null, resetFired: false });
  });
});

// =====================================================================================
// D2: последующий эмит historyComplete=0 → латч НЕ сброшен → файл всё ещё разрешён
// =====================================================================================
describe('O-43 D2: регрессия вердикта полноты латч не снимает', () => {
  test('D2: N эмитов с historyComplete=false (handshake/open-путь) — латч жив', function () {
    const h = contentState({});
    h.set(TID);
    // поздние эмиты того же треда полноты НЕ дают: взвода нет, снятия тоже нет
    for (let i = 0; i < 5; i++) expect(h.is(GSA, TID)).toBe(true);
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: false, baseSeen: true, loaderRunning: false, fired: false, isGemini: false,
      site: GSA, chatPageMarker: true, msgCount: 20, baseTextLen: 29527,
      gsaNetworkCompleteLatch: h.is(GSA, TID)
    });
    expect(v.skip).toBe(false);                        // файл разрешён (регрессия проигнорирована)
    expect(v.reason).not.toBe('not-complete');
    // без латча та же регрессия даёт ровно прежний вердикт (поле не влияет, когда false)
    const legacy = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: false, baseSeen: true, loaderRunning: false, fired: false, isGemini: false,
      site: GSA, chatPageMarker: true, msgCount: 20, baseTextLen: 29527,
      gsaNetworkCompleteLatch: false
    });
    expect(legacy).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('D2: неполный эмит НЕ взводит латч (нет ложной полноты вперёд)', function () {
    const h = contentState({});
    expect(h.is(GSA, TID)).toBe(false);                // эмит с historyComplete=0 — взвода нет
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: false, baseSeen: true, loaderRunning: false, fired: false, isGemini: false,
      site: GSA, chatPageMarker: true, msgCount: 10, baseTextLen: 12000,
      gsaNetworkCompleteLatch: h.is(GSA, TID)
    });
    expect(v).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('D2: кэш треда на SPA-возврате пере-взводит латч (historyComplete кэша не false)', function () {
    // единственный путь вердикта полноты — buildDetail: historyComplete: historyComplete !== false
    expect(fnDecl(INTERCEPT_SRC, 'buildDetail')).toContain('historyComplete: historyComplete !== false');
    const h = contentState({});
    h.set(TID); // эмит кэша треда после activateThread → detail.historyComplete=true
    expect(h.is(GSA, TID)).toBe(true);
  });
});

// =====================================================================================
// D3: смена треда → латч сброшен
// =====================================================================================
describe('O-43 D3: сброс латча — только смена треда', () => {
  test('D3: реальный resetConversationState с другим threadId снимает латч', function () {
    const h = contentState({});
    h.set(TID);
    expect(h.is(GSA, TID)).toBe(true);
    h.ctx.__domTid = TID2;                                // DOM снаффнул новый разговор
    expect(h.ctx.aiCmDomThreadId()).toBe(TID2);           // диагностика: DOM видит новый тред
    h.reset();
    expect(h.is(GSA, TID)).toBe(false);                   // полнота прошлого треда не перетекает
    expect(Object.keys(h.latch).length).toBe(0);
    expect(h.slot).toBe(TID2);
  });

  test('D3: холостой сброс (тот же threadId) латч НЕ снимает — иначе один поздний эмит с historyComplete=0 запретил бы честный файл', function () {
    const h = contentState({});
    h.set(TID);
    h.reset();                                           // conv-changed без смены id / не-чат документ
    expect(h.is(GSA, TID)).toBe(true);
    expect(h.slot).toBe(TID);
  });

  test('D3: после смены треда (регрессия у нового) файл снова ждёт сеть, затем полный эмит разрешает', function () {
    const h = contentState({});
    h.set(TID);
    h.ctx.__domTid = TID2;
    h.reset();
    const gate = function () {
      return P.shouldSkipAutoExport({
        enabled: true, percentage: 95, threshold: 90,
        baseComplete: false, baseSeen: true, loaderRunning: false, fired: false, isGemini: false,
        site: GSA, chatPageMarker: true, msgCount: 20, baseTextLen: 29527,
        gsaNetworkCompleteLatch: h.is(GSA, TID2)
      });
    };
    expect(gate()).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
    h.ctx.lastThreadId = TID2;
    h.set(TID2);                                         // сеть отдала полный снимок нового треда
    expect(gate().skip).toBe(false);
  });
});

// =====================================================================================
// D4/R1: полный контур — РЕАЛЬНЫЙ maybeAutoExport → гейт → единственная точка файла
// =====================================================================================
describe('O-43 D4/R1: реальный maybeAutoExport — файл по латчу, не по регрессировавшей baseComplete', () => {
  const MGR_SCOPE = 'with (ctx) { ' +
    fnDecl(MGR_SRC, 'aiCmAutoExportConvId') + '\n' +
    fnDecl(MGR_SRC, 'aiCmGsaNetworkCompleteIs') + '\n' +
    fnDecl(MGR_SRC, 'aiCmGsaProbeRunningFor') + '\n' +
    fnDecl(MGR_SRC, 'aiCmGsaAutoExportSkipLog') + '\n' +
    fnDecl(MGR_SRC, 'maybeAutoExport') + '\n' +
    ' return { run: maybeAutoExport }; }';
  const makeRun = new Function('ctx', MGR_SCOPE);

  function gateCtx(over) {
    const fired = [];
    const logs = [];
    const ctx = Object.assign({
      autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' },
      autoExportLastConvId: '',
      autoExportPctBySite: {},
      autoExportFired: {},
      autoExportLastPct: -1,
      notCompleteLogged: {},
      sessionFiredCache: {},
      aiCmGsaProbeByThread: {},
      aiCmGsaProbeRunning: false,
      aiCmLoaderRunningByConv: {},
      aiCmCursorLiveByConv: {},
      aiCmArchiveCountFor: function () { return 0; },
      baseSeen: true,
      baseComplete: false,                 // регрессия: полный эмит уже был, вердикт снова 0
      baseCount: 20,
      baseText: 'x'.repeat(29527),
      lastThreadId: TID,
      lastBaseTexts: ['a', 'b'],
      currentAdapter: { siteName: GSA },
      getCurrentConvId: function () { return ''; },
      aiCmGsaNetworkCompleteLatch: STATE.aiCmGsaNetworkCompleteLatch,
      aiCmDiagLine: function () { },
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      doAutoExportDownload: function (cid, pct, reason) {
        fired.push({ cid: cid, pct: pct, reason: reason });
        P.markAutoExportFired(ctx.autoExportFired, GSA, cid);
      },
      chrome: { storage: { session: { remove: function () { }, set: function () { } } } },
      window: { AiCmExportEmitPipeline: P }
    }, over || {});
    return { ctx: ctx, fired: fired, logs: logs, run: makeRun(ctx).run };
  }

  test('D4: латч взведён → fired с convId=threadId и причиной threshold', function () {
    const h = gateCtx({});
    STATE.aiCmGsaNetworkCompleteLatch[GSA + '|' + TID] = 1; // взвод приёмом полного снимка
    h.run(95);
    expect(h.fired).toEqual([{ cid: TID, pct: 95, reason: 'threshold' }]);
  });
  test('D4: без латча тот же вызов файла не даёт (регрессия = прежняя причина not-complete)', function () {
    const h = gateCtx({});
    h.run(95);
    expect(h.fired.length).toBe(0);
    expect(h.logs.join('\n')).toContain('[AI CM][auto-export] site=google_search skip reason=not-complete convId=' + TID);
  });

  test('R1: легитимный файр по латчу — порог соблюдён, второй файл запрещён латчем fired', function () {
    const h = gateCtx({});
    STATE.aiCmGsaNetworkCompleteLatch[GSA + '|' + TID] = 1;
    h.run(89);                                   // ниже порога: латч полноты порога не отменяет
    expect(h.fired.length).toBe(0);
    h.run(95);
    expect(h.fired.length).toBe(1);
    h.run(97);                                   // второй файл того же разговора — запрещён
    expect(h.fired.length).toBe(1);
    expect(h.logs.join('\n')).toContain('[AI CM][auto-export] site=google_search skip reason=already-fired convId=' + TID);
  });

  test('R1: прочие сервисы латч не читают (Gemini-путь: вердикт прежний)', function () {
    const h = gateCtx({
      currentAdapter: { siteName: 'gemini' },
      lastThreadId: '',
      getCurrentConvId: function () { return 'conv-1'; }
    });
    STATE.aiCmGsaNetworkCompleteLatch[GSA + '|' + TID] = 1; // латч GSA взведён
    h.run(95);
    expect(h.fired.length).toBe(0);              // gemini: baseComplete=false → not-complete, как было
    expect(h.logs.join('\n')).not.toContain('site=google_search');
  });
});

// =====================================================================================
// R2: регресс O-11/O-31/O-27 + чистые вердикты шести платформ (поле не передано)
// =====================================================================================
function gsaState(over) {
  return Object.assign({
    enabled: true, percentage: 95, threshold: 90,
    baseComplete: true, baseSeen: true, loaderRunning: false,
    fired: false, isGemini: false
  }, over || {});
}

describe('O-43 R2: прежние контуры не тронуты', () => {
  test('R2 (O-11): имена файлов и общие вердикты гейта байтово прежние', function () {
    expect(P.buildGsaExportFileName(GSA, 'Gemini 2.5 Flash', false, 'txt', new Date(2026, 7, 31, 9, 5)))
      .toMatch(/^ai-context-monitor-google_search-Gemini-2\.5-Flash-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/);
    expect(P.shouldSkipAutoExport(gsaState({}))).toEqual({ skip: false, reason: null, resetFired: false });
    expect(P.shouldSkipAutoExport(gsaState({ baseComplete: false })))
      .toEqual({ skip: true, reason: 'not-complete', resetFired: false });
    expect(P.shouldSkipAutoExport(gsaState({ percentage: 85 })).reason).toBe('below-threshold');
    expect(P.shouldSkipAutoExport(gsaState({ percentage: 79 })))
      .toEqual({ skip: true, reason: 'below-threshold-hysteresis', resetFired: true });
    expect(P.shouldSkipAutoExport(gsaState({ fired: true })).reason).toBe('already-fired');
    // поле gsaNetworkCompleteLatch, равное false, вердикта не меняет (обратная совместимость)
    expect(P.shouldSkipAutoExport(gsaState({ gsaNetworkCompleteLatch: false })))
      .toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('R2 (O-27): captcha-гард страницы GSA приоритетнее латча', function () {
    const cap = gsaState({
      baseComplete: false, gsaNetworkCompleteLatch: true,
      site: GSA, chatPageMarker: false, msgCount: 0, baseTextLen: 0
    });
    expect(P.shouldSkipAutoExport(cap)).toEqual({ skip: true, reason: 'not-chat-page', resetFired: false });
    expect(P.shouldSkipAutoExport(Object.assign({}, cap, { chatPageMarker: true, msgCount: 0 })).reason).toBe('no-messages');
    expect(P.shouldSkipAutoExport(Object.assign({}, cap, { chatPageMarker: true, msgCount: 3, baseTextLen: 0 })).reason).toBe('empty-base');
  });

  test('R2 (O-27): выставленный латч не даёт cause base-pending (сеть по разговору уже была)', function () {
    const v = P.shouldSkipAutoExport(gsaState({
      baseComplete: false, baseSeen: false, gsaNetworkCompleteLatch: true
    }));
    expect(v.reason).not.toBe('base-pending');
    expect(v).toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('R2 (O-31): threadId-сегментация перехватчика не тронута', function () {
    expect(INTERCEPT_SRC).toContain('function isForeignThread(tid)');
    expect(INTERCEPT_SRC).toContain("absorbForeignSnapshot(tid, turns, historyComplete)");
    expect(INTERCEPT_SRC).toContain("'foreign-not-applied'");
    // латч O-43 — только ISOLATED-мир (state.js/export-manager.js/content.js)
    const iso = ['core/state.js', 'core/widget.js', 'core/export-manager.js', 'core/content.js'];
    for (const rel of iso) {
      expect(fs.readFileSync(path.join(ROOT, rel), 'utf8')).toContain('aiCmGsaNetworkComplete');
    }
  });

  test('R2: латч fired (O-38) и spa-entry (O-29) не тронуты', function () {
    const reset = fnDecl(WIDGET_SRC, 'resetConversationState');
    const iGsa = reset.indexOf("siteD14 === 'google_search'");
    expect(iGsa).toBeGreaterThan(-1);
    expect(reset.indexOf('latch kept reason=spa-entry')).toBeGreaterThan(iGsa);
    expect((reset.match(/aiCmAutoExportFiredOnce/g) || []).length).toBe(0); // O-38-латч сбросом не снимается
    expect(fnDecl(MGR_SRC, 'maybeAutoExport')).toContain('aiCmAutoExportFiredOnce[siteName + \'|\' + cid] === 1');
    // count = 1 (core/export-manager.js + core/state.js объявление проверяем отдельно ниже)
    expect((MGR_SRC.match(/function aiCmGsaNetworkCompleteReset\(/g) || []).length).toBe(1);
  });
});

// =====================================================================================
// Пины точек: взвод ровно в приёме полного снимка; чтение ровно в отправке state гейта
// =====================================================================================
describe('O-43: точки взвода и чтения (единственные)', () => {
  test('взвод: только при detail.historyComplete===true, внутри слушателя ai-cm-full-history', function () {
    const iComplete = CONTENT.indexOf('const newBaseComplete = !!detail.historyComplete;');
    const iSet = CONTENT.indexOf('aiCmGsaNetworkCompleteSet(detail.threadId');
    expect(iComplete).toBeGreaterThan(-1);
    expect(iSet).toBeGreaterThan(iComplete);                       // после вердикта полноты
    expect(CONTENT.slice(iComplete, iSet)).toContain('if (newBaseComplete');
    // вызов ровно один (второе вхождение имени — шапка-комментарий этого файла в content.js)
    expect((CONTENT.match(/aiCmGsaNetworkCompleteSet\(/g) || []).length).toBe(2);
    expect(fnDecl(MGR_SRC, 'aiCmGsaNetworkCompleteSet')).toContain("if (site !== 'google_search') return false;");
  });

  test('сброс: только resetConversationState (по факту смены threadId)', function () {
    const reset = fnDecl(WIDGET_SRC, 'resetConversationState');
    expect(reset).toContain('aiCmGsaNetworkCompleteReset(');
    expect(reset).toContain('aiCmDomThreadId()');
    expect((WIDGET_SRC.match(/aiCmGsaNetworkCompleteReset\(/g) || []).length).toBe(1); // один сброс
    // гейт не сбрасывает латч: resetFired относится к латчу fired (O-38/O-33), не к полноте
    expect((MGR_SRC.match(/aiCmGsaNetworkCompleteReset\(/g) || []).length).toBe(1);    // только объявление
  });

  test('чтение: ровно в state гейта и ровно для google_search', function () {
    const mgr = fnDecl(MGR_SRC, 'maybeAutoExport');
    expect(mgr).toContain('aiCmGsaNetworkCompleteIs(siteName, cid)');
    expect(mgr).toContain('gsaNetworkCompleteLatch: gsaNetworkLatch');
    // поле живёт в GSA-ветке: у прочих сервисов остаётся undefined
    const iGsa = mgr.indexOf("if (siteName === 'google_search') {");
    expect(iGsa).toBeGreaterThan(-1);
    expect(mgr.slice(iGsa, mgr.indexOf('if (P && typeof P.shouldSkipAutoExport'))).toContain('gsaNetworkLatch =');
    expect(mgr.slice(0, iGsa)).not.toContain('gsaNetworkLatch =');
  });

  test('латч объявлен в core/state.js и экспортирован (UMD Api)', function () {
    const stateSrc = fs.readFileSync(path.join(ROOT, 'core', 'state.js'), 'utf8');
    expect(stateSrc).toContain('var aiCmGsaNetworkCompleteLatch = Object.create(null);');
    expect(stateSrc).toContain("Object.defineProperty(Api, 'aiCmGsaNetworkCompleteLatch'");
    expect(typeof STATE.aiCmGsaNetworkCompleteLatch).toBe('object');
  });
});
