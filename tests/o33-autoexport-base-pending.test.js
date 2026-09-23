/**
 * O-33 (Medium): автоэкспорт по частичной DOM-базе ДО сетевого снимка (ChatGPT/deepseek).
 *
 * Живой артефакт (Логи O-1 F5 09-30…09-36):
 *   09:30:28.273 svc-emit-trace site=chatgpt convId= msgs=2 domMsgs=2 netMsgs=0 histWritePath=adapter;
 *   09:36:06.492 svc-emit-trace site=chatgpt convId=6a59cfa1… msgs=5 domMsgs=5 netMsgs=0 histWritePath=adapter;
 *   09:36:06.866 badge-recv msgs=71 → 09:30:34.756 fired (histSource=memory, база 71).
 * До снимка гейт считал DOM-базу (baseSeen=false) полнотой (дизъюнкт `!baseSeen ||`) — файл мог
 * уйти по частичной DOM-оценке (msgs=5) вместо полной сетевой базы.
 *
 * Продуктовое решение (a):
 *   1. utils/export-emit-pipeline.js: из completeOk убран дизъюнкт `!baseSeen ||` — полнота
 *      ТОЛЬКО по сетевому baseComplete (Gemini-семантика прежняя);
 *   2. новая причина base-pending: не-Gemini, baseSeen=false, enabled=true, cid ≠ '', pct ≥ 0
 *      (все предшествующие гейты пройдены, кроме completeOk); вердикт выносится ПОСЛЕ пороговых
 *      гейтов — при pct ниже порога причина прежняя (below-threshold / -unreliable), новых строк
 *      лога не прибавляется (живой F5#2 09:36:06.494: `skip reason=below-threshold pct=0.6`);
 *   3. латч fired на base-pending НЕ ставится и НЕ сбрасывается (resetFired:false) — поздний
 *      честный экспорт по полной сетевой базе состоится;
 *   4. лог причины — ровно одна строка на СМЕНУ состояния (урок O-29) каноническим
 *      aiCmDiagLine под гейтом aiCmDebug (прецедент O-27/O-32).
 *
 * Исполняются РЕАЛЬНЫЕ функции: shouldSkipAutoExport (utils/export-emit-pipeline.js),
 * maybeAutoExport + aiCmAutoExportStartDownload + doAutoExportDownload + aiCmWriteAutoExportFile
 * + aiCmAutoExportBasePendingLog (core/export-manager.js), канонический aiCmDiagLine
 * (utils/debug.js) и реальные сборщики байтов (utils/export-text-builders.js).
 *
 * НЕ ТРОГАЕТСЯ (пины R1–R6 ниже): байты и маски всех форматов (buildAutoExportFileName, O-11),
 * латч и реестр имён, сегментация базы GSA (O-31), гарды O-27 (shouldSkipGsaPageGuard,
 * isGarbageBody, пост-гард downloadBlob: xssi-prefix/empty-name), пороги 70/85/95, щит O-1
 * (core/content.js:1647), Gemini baseComplete/архив/лоадер, адаптеры Claude/Perplexity,
 * тихий `if (!cid) return;` в core/export-manager.js.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const { contentSource: CONTENT } = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const BUILDERS_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/gsa-autoexport.test.js, tests/chatgpt-o1-badge-hold.test.js).
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

// —— Точные формы живых входов (артефакты O-1 F5 09:30 / 09:36) ——
const CID = '6a59cfa1-8e8c-83ed-8ba7-995740b83dd9'; // convId ChatGPT из URL /c/<id>
const MODEL = 'GPT-5';
const THRESH_LIVE = 1;                                // живой порог прогона 09:30/09:36 (pct=0.6 и pct=0 → below-threshold)
const DOM_MSGS = ['DOM-1', 'DOM-2', 'DOM-3', 'DOM-4', 'DOM-5']; // fat-DOM база: msgs=5 (09:36:06.492)
const NET_TEXTS = [];
for (let i = 0; i < 71; i++) NET_TEXTS.push('СЕТЬ-' + i);        // badge-recv msgs=71 (09:36:06.867)
const NET_MSGS = NET_TEXTS.map(function (t, i) {
  return { role: (i % 2 === 0) ? 'user' : 'assistant', text: t };
});
const DIAG_PREFIX = '[AI CM][diag] auto-export';

// ---------------------------------------------------------------------------------
// Песочница O-33: РЕАЛЬНЫЙ fire-путь (maybeAutoExport → doAutoExportDownload →
// aiCmWriteAutoExportFile) + РЕАЛЬНЫЙ лог-хелпер причины + канонический aiCmDiagLine.
// ---------------------------------------------------------------------------------
const O33_SCOPE = 'with (ctx) { ' +
  fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
  fnDecl(MGR_SRC, 'aiCmAutoExportConvId') + '\n' +
  fnDecl(MGR_SRC, 'aiCmAutoExportBasePendingLog') + '\n' +
  fnDecl(MGR_SRC, 'aiCmExportBaseSource') + '\n' +
  fnDecl(MGR_SRC, 'aiCmAutoExportStartDownload') + '\n' +
  fnDecl(MGR_SRC, 'doAutoExportDownload') + '\n' +
  fnDecl(MGR_SRC, 'maybeAutoExport') + '\n' +
  ' return { run: maybeAutoExport }; }';
const makeO33 = new Function('ctx', O33_SCOPE);

/**
 * Харнесс: состояние content-скрипта как в браузере (общий лексический скоуп модулей).
 * over: site, convId, threshold, pct, baseSeen, baseComplete, msgs, baseTexts, debug.
 */
function o33(over) {
  const o = over || {};
  const logs = [];        // debugLog (автоэкспортные строки)
  const diag = [];        // console.log под гейтом aiCmDebug (ctx.console)
  const downloads = [];   // единая точка скачивания (Bdl.downloadBlob)
  const st = {
    convId: (o.convId !== undefined) ? o.convId : CID,
    msgs: (o.msgs || DOM_MSGS).slice()
  };
  const ctx = {
    // ---- состояние (core/state.js) ----
    autoExportSettings: { enabled: (o.enabled !== undefined) ? o.enabled : true, pct: (o.threshold !== undefined) ? o.threshold : THRESH_LIVE, fmt: 'txt' },
    autoExportPctBySite: {},
    autoExportLastConvId: '',
    autoExportLastPct: -1,
    autoExportFired: {},
    aiCmAutoExportNamesUsed: {},   // O-11: реестр занятых имён (единственная точка старта)
    notCompleteLogged: {},
    sessionFiredCache: {},
    aiCmLoaderRunningByConv: {},
    aiCmCursorLiveByConv: {},
    aiCmLowConfidenceByConv: {},
    aiCmArchiveCountFor: function () { return 0; },
    // ---- O-33: объект состояния «предыдущая причина вердикта» (лог только на смене) ----
    aiCmAutoExportSkipReasonState: { reason: '' },
    // ---- база снимка ----
    baseSeen: (o.baseSeen === true),
    baseComplete: (o.baseComplete === true),
    baseCount: (o.msgs || DOM_MSGS).length,
    baseText: '',
    lastBaseTexts: (o.baseTexts || []).slice(),
    lastDetailMessages: null,
    lastThreadId: o.threadId || '',
    lastEmitConvId: st.convId,
    lastResolvedModelId: 'gpt-5',
    lastSnapshotModelName: '',
    maxTokenCount: 1000,
    currentAdapter: {
      siteName: o.site || 'chatgpt',
      extractMessages: function () {
        return st.msgs.map(function (t, i) {
          return { role: (i % 2 === 0) ? 'user' : 'assistant', text: t };
        });
      }
    },
    getCurrentConvId: function () { return st.convId; },
    buildHistoryMessages: function () { return st.msgs.slice(); },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    aiCmGsaChatPageMarker: function () { return o.gsaChatPage !== false; },
    ModelConfig: { getModel: function () { return { name: MODEL }; } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    // aiCmDiagLine печатает через console.log — тот же ctx-скоуп (как в браузере):
    // строки попадают в diag только при включённом гейте aiCmDebug.
    console: {
      log: function (m) { diag.push(String(m)); },
      error: function () { }
    },
    chrome: { storage: { session: { set: function () { }, remove: function () { } } } },
    window: {
      __aiCmDebugLogs: (o.debug === true),
      location: { hostname: 'chatgpt.com' },
      AiCmExportEmitPipeline: P,
      AiCmExportBuilders: {
        // РЕАЛЬНЫЕ сборщики байтов (utils/export-text-builders.js) — байты файла не подменяются
        buildTxtFromHistory: Builders.buildTxtFromHistory,
        buildMdFromHistory: Builders.buildMdFromHistory,
        buildJsonFromHistory: Builders.buildJsonFromHistory,
        downloadBlob: function (content, file, mime) {
          downloads.push({ content: content, file: file, mime: mime });
        }
      }
    }
  };
  const api = makeO33(ctx);

  return {
    ctx: ctx,
    logs: logs,
    diag: diag,
    downloads: downloads,
    run: api.run,
    // badge-recv: запись базы снимка (content.js:485/507) — база становится сетевой
    baseArrives: function (msgs, texts) {
      ctx.baseSeen = true;
      ctx.baseComplete = true;
      ctx.baseCount = (msgs || NET_MSGS).length;
      ctx.lastBaseTexts = (texts || NET_TEXTS).slice();
      ctx.lastDetailMessages = null;
      st.msgs = (msgs || NET_MSGS).slice();
    },
    // сетевое молчание после сброса состояния (resetConversationState) — снова DOM-база
    baseGone: function (msgs) {
      ctx.baseSeen = false;
      ctx.baseComplete = false;
      ctx.baseCount = (msgs || DOM_MSGS).length;
      ctx.lastBaseTexts = [];
      ctx.lastDetailMessages = null;
      st.msgs = (msgs || DOM_MSGS).slice();
    },
    setDebug: function (on) { ctx.window.__aiCmDebugLogs = (on === true); },
    basePendingDiag: function () {
      return diag.filter(function (l) {
        return l.indexOf(DIAG_PREFIX) === 0 && l.indexOf('reason=base-pending') !== -1;
      });
    },
    latchKeys: function () { return Object.keys(ctx.autoExportFired); }
  };
}

beforeEach(() => {
  try { window.sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});
afterEach(() => jest.restoreAllMocks());

function mockNow() {
  jest.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026);
  jest.spyOn(Date.prototype, 'getMonth').mockReturnValue(7); // август
  jest.spyOn(Date.prototype, 'getDate').mockReturnValue(31);
  jest.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
  jest.spyOn(Date.prototype, 'getMinutes').mockReturnValue(5);
}

// =====================================================================================
// D1: fat-DOM файр-форма (msgs=5, pct=5.0, threshold=1, histWritePath=adapter)
// =====================================================================================
describe('O-33 D1: DOM-база до сетевого снимка → skip base-pending, файра нет, латч не поставлен', () => {
  const D1 = {
    enabled: true, percentage: 5.0, threshold: THRESH_LIVE,
    baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
    isGemini: false, site: 'chatgpt'
  };

  test('чистый гейт: base-pending + resetFired:false (латч не ставится и не сбрасывается)', () => {
    expect(P.shouldSkipAutoExport(D1)).toEqual({ skip: true, reason: 'base-pending', resetFired: false });
  });

  test('реальный maybeAutoExport: файла нет, латч не поставлен, строка base-pending ровно одна', () => {
    const h = o33({ debug: true, baseSeen: false, baseComplete: false, msgs: DOM_MSGS });
    h.run(5.0);
    expect(h.downloads).toEqual([]);                    // файла нет
    expect(h.latchKeys()).toEqual([]);                  // латч fired не поставлен
    expect(h.basePendingDiag()).toHaveLength(1);
    expect(h.basePendingDiag()[0]).toContain('reason=base-pending');
    expect(h.basePendingDiag()[0]).toContain('convId=' + CID);
    expect(h.basePendingDiag()[0]).toContain('pct=5');
    // новые строки debugLog причиной base-pending не порождаются (общий skip-лог прежний)
    expect(h.logs).toEqual([]);
  });

  test('латч, поставленный ранее, причиной base-pending НЕ снимается', () => {
    const h = o33({ baseSeen: false, baseComplete: false, msgs: DOM_MSGS });
    P.markAutoExportFired(h.ctx.autoExportFired, 'chatgpt', CID); // уже экспортировали этот чат
    h.run(5.0);
    expect(h.downloads).toEqual([]);
    expect(P.getAutoExportFired(h.ctx.autoExportFired, 'chatgpt', CID)).toBe(true); // латч жив
  });

  test('ниже порога — причина прежняя (below-threshold-unreliable), base-pending не подменяет', () => {
    // тот же DOM-вход, но порог 30: 5.0 < 30−10 → прежняя ветка v82 (D5), латч не трогаем
    const h = o33({ baseSeen: false, baseComplete: false, msgs: DOM_MSGS, threshold: 30 });
    h.run(5.0);
    expect(h.downloads).toEqual([]);
    expect(h.basePendingDiag()).toEqual([]);
    expect(P.shouldSkipAutoExport(Object.assign({}, D1, { threshold: 30 })).reason).toBe('below-threshold-unreliable');
  });
});

// =====================================================================================
// D2: живой F5#2 (09:36:04–06): DOM-окно pct=0.6 → below-threshold; после badge-recv — файр
// =====================================================================================
describe('O-33 D2: живой F5#2 — pct=0.6 ниже порога даёт below-threshold, затем файр по сети', () => {
  test('pct=0.6, threshold ∈ [1,10] → below-threshold (порог :376 раньше base-pending)', () => {
    [1, 5, 10].forEach(function (thr) {
      const v = P.shouldSkipAutoExport({
        enabled: true, percentage: 0.6, threshold: thr,
        baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
        isGemini: false, site: 'chatgpt'
      });
      expect(v).toEqual({ skip: true, reason: 'below-threshold', resetFired: false });
      expect(v.reason).not.toBe('base-pending');
    });
  });

  test('реальный путь: ниже порога 0.6 → строка below-threshold (как в живом логе), файла нет', () => {
    const h = o33({ baseSeen: false, baseComplete: false, msgs: DOM_MSGS, threshold: THRESH_LIVE });
    h.run(0.6);
    expect(h.downloads).toEqual([]);
    expect(h.basePendingDiag()).toEqual([]);
    expect(h.logs.join('\n')).toContain('[AI CM][auto-export] skip reason=below-threshold convId=' + CID + ' pct=0.6');
  });

  test('после badge-recv (baseSeen=true, netMsgs=71) → файр по полной сетевой базе, histSource=memory', () => {
    mockNow();
    const h = o33({ baseSeen: false, baseComplete: false, msgs: DOM_MSGS, threshold: THRESH_LIVE });
    h.run(0.6);                                        // 09:36:06.494 — ниже порога, файла нет
    h.baseArrives(NET_MSGS, NET_TEXTS);                // 09:36:06.867 badge-recv msgs=71
    h.run(39.8);                                       // 09:30:34.756-подобный fired (histSource=memory)
    expect(h.downloads).toHaveLength(1);
    const d = h.downloads[0];
    // имя — из ЕДИНСТВЕННОГО источника имён (buildAutoExportFileName, O-11)
    const expectedName = P.buildAutoExportFileName({
      mask: 'convId', service: 'chatgpt', convId: CID, reason: 'threshold',
      isLowConfidence: false, fmt: 'txt', taken: null
    });
    expect(d.file).toBe(expectedName);
    expect(d.file).toBe('chatgpt-6a59cfa1-2026-08-31_09-05.txt');
    expect(h.ctx.aiCmAutoExportNamesUsed[d.file]).toBe(1); // имя зарезервировано единственной точкой старта
    // байты — из реального сборщика по СЕТЕВОЙ базе (71 ход), частичная DOM-база не участвует
    const hist = {
      site: 'chatgpt', model: MODEL, tokens: h.ctx.maxTokenCount,
      limit: 0, percent: 39.8, messages: NET_MSGS
    };
    expect(d.content).toBe('\uFEFF' + Builders.buildTxtFromHistory(hist));
    expect(d.content).toContain('СЕТЬ-70');
    expect(d.content).not.toContain('DOM-1');
    expect(h.logs.join('\n')).toContain('histSource=memory');
    expect(h.basePendingDiag()).toEqual([]);           // смена состояния произошла — файр, не base-pending
  });
});

// =====================================================================================
// D3: живой F5#1 (09:30:28–32): cid='', msgs=2/4, pct=0 → тихий `!cid` return
// =====================================================================================
describe('O-33 D3: пустой convId — тихий ранний return (не часть O-33), файра нет', () => {
  test('живая форма: cid="", baseSeen=false, msgs=2/4, pct=0, threshold=1 → below-threshold, без base-pending', () => {
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 0, threshold: THRESH_LIVE,
      baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
      isGemini: false, site: 'chatgpt'
    });
    expect(v).toEqual({ skip: true, reason: 'below-threshold', resetFired: false });
    const h = o33({ convId: '', baseSeen: false, baseComplete: false, msgs: ['a', 'b'], threshold: THRESH_LIVE, debug: true });
    h.run(0);
    expect(h.downloads).toEqual([]);
    expect(h.basePendingDiag()).toEqual([]);
  });

  test('гейты пройдены, но cid="" → тихий `if (!cid) return;` (байтово прежний, вне O-33)', () => {
    expect(MGR_SRC).toContain('if (!cid) return;');
    const mgr = fnDecl(MGR_SRC, 'maybeAutoExport');
    // порядок прежний: гейт → `!cid`-выход → doAutoExportDownload
    expect(mgr.indexOf('P.shouldSkipAutoExport({')).toBeLessThan(mgr.indexOf('if (!cid) return;'));
    expect(mgr.indexOf('if (!cid) return;')).toBeLessThan(mgr.indexOf("doAutoExportDownload(cid, percentage, 'threshold');"));
    const h = o33({ convId: '', baseSeen: true, baseComplete: true, baseTexts: NET_TEXTS, msgs: NET_MSGS, threshold: THRESH_LIVE });
    h.run(95); // все гейты зелёные
    expect(h.downloads).toEqual([]);
    expect(h.basePendingDiag()).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

// =====================================================================================
// R1: пост-baseSeen файр — байты/имя/латч байтово прежние (в т.ч. при гейте aiCmDebug on/off)
// =====================================================================================
describe('O-33 R1: файр после сетевого снимка не изменён (байты, имя, латч)', () => {
  function fireHarness(debug) {
    mockNow();
    const h = o33({ debug: debug, baseSeen: true, baseComplete: true, baseTexts: NET_TEXTS, msgs: NET_MSGS, threshold: THRESH_LIVE });
    h.run(95);
    return h;
  }

  test('частный случай: baseComplete=false + baseSeen=false → не-Gemini блокируется (не стреляет)', () => {
    // контрольная точка: без сетевого снимка файла нет ни при каком pct (сердце O-33)
    const h = o33({ baseSeen: false, baseComplete: false, msgs: DOM_MSGS, threshold: THRESH_LIVE });
    h.run(95);
    expect(h.downloads).toEqual([]);
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: THRESH_LIVE, baseComplete: false, baseSeen: false,
      loaderRunning: false, fired: false, isGemini: false
    }).reason).toBe('base-pending');
  });

  test('файр: текст из buildHistoryMessages, имя из buildAutoExportFileName, латч ставится', () => {
    const h = fireHarness(false);
    expect(h.downloads).toHaveLength(1);
    expect(h.latchKeys()).toEqual([P.latchKey('chatgpt', CID)]);        // латч core/export-manager.js:1027-1029
    expect(h.logs.join('\n')).toContain('[AI CM][auto-export] fired convId=' + CID);
    // второй вход в тот же чат — already-fired (семантика прежняя)
    h.run(96);
    expect(h.downloads).toHaveLength(1);
    expect(h.logs.join('\n')).toContain('skip reason=already-fired convId=' + CID);
  });

  test('байты и имя при гейте aiCmDebug вкл/выкл идентичны (диагностика не влияет на файл)', () => {
    const off = fireHarness(false);
    const on = fireHarness(true);
    expect(on.downloads).toHaveLength(1);
    expect(on.downloads[0].file).toBe(off.downloads[0].file);
    expect(on.downloads[0].content).toBe(off.downloads[0].content);
    expect(on.downloads[0].mime).toBe(off.downloads[0].mime);
    expect(on.latchKeys()).toEqual(off.latchKeys());
  });
});

// =====================================================================================
// R2: лог-гигиена O-29 — 10 DRAW-циклов с одинаковым входом → ровно одна строка
// =====================================================================================
describe('O-33 R2: base-pending логируется только на смене состояния (урок O-29)', () => {
  test('10 последовательных DRAW (baseSeen=false, pct=5.0, threshold=1) → ровно ОДНА строка', () => {
    const h = o33({ debug: true, baseSeen: false, baseComplete: false, msgs: DOM_MSGS, threshold: THRESH_LIVE });
    for (let i = 0; i < 10; i++) h.run(5.0);
    expect(h.basePendingDiag()).toHaveLength(1);
    expect(h.downloads).toEqual([]);
    expect(h.latchKeys()).toEqual([]);
  });

  test('смена состояния (файр) → следующий base-pending снова даёт одну строку, латч не сброшен', () => {
    mockNow();
    const h = o33({ debug: true, baseSeen: false, baseComplete: false, msgs: DOM_MSGS, threshold: THRESH_LIVE });
    h.run(5.0);
    h.run(5.0);
    expect(h.basePendingDiag()).toHaveLength(1);
    h.baseArrives(NET_MSGS, NET_TEXTS);   // состояние сменилось: база пришла → файр
    h.run(95);
    expect(h.downloads).toHaveLength(1);
    h.baseGone(DOM_MSGS);                  // снова DOM-база (SPA-сброс)
    h.run(5.0);
    expect(h.basePendingDiag()).toHaveLength(2);
    h.run(5.0);
    expect(h.basePendingDiag()).toHaveLength(2);  // повтор той же причины — молчание
    expect(h.downloads).toHaveLength(1);          // второго файла нет
  });

  test('гейт aiCmDebug выкл/вкл: поведение и вердикт идентичны, строк нет при выключенном гейте', () => {
    const off = o33({ debug: false, baseSeen: false, baseComplete: false, msgs: DOM_MSGS, threshold: THRESH_LIVE });
    const on = o33({ debug: true, baseSeen: false, baseComplete: false, msgs: DOM_MSGS, threshold: THRESH_LIVE });
    for (let i = 0; i < 10; i++) { off.run(5.0); on.run(5.0); }
    expect(off.diag).toEqual([]);                 // гейт выключен → ни одной новой строки
    expect(on.basePendingDiag()).toHaveLength(1);
    expect(off.downloads).toEqual(on.downloads);  // оба без файла
    expect(off.latchKeys()).toEqual(on.latchKeys());
  });
});

// =====================================================================================
// R3: Gemini — семантика прежняя (not-complete по baseComplete), байтово
// =====================================================================================
describe('O-33 R3: Gemini не затронут (not-complete/файр как прежде)', () => {
  test('baseComplete=false (baseSeen=true) → not-complete; baseSeen=false → тоже not-complete', () => {
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, baseComplete: false, baseSeen: true,
      loaderRunning: false, fired: false, isGemini: true
    })).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, baseComplete: false, baseSeen: false,
      loaderRunning: false, fired: false, isGemini: true
    })).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('baseComplete=true → файр; реальный путь Gemini: строка not-complete не изменилась', () => {
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, baseComplete: true, baseSeen: true,
      loaderRunning: false, fired: false, isGemini: true
    })).toEqual({ skip: false, reason: null, resetFired: false });
    const h = o33({ site: 'gemini', baseSeen: true, baseComplete: false, baseTexts: NET_TEXTS, msgs: NET_MSGS, threshold: 90 });
    h.run(95);
    expect(h.downloads).toEqual([]);
    expect(h.logs.join('\n')).toContain('[AI CM][auto-export] skip reason=not-complete convId=' + CID + ' pct=95');
    expect(h.basePendingDiag()).toEqual([]);   // у Gemini причины base-pending нет
  });
});

// =====================================================================================
// R4: GSA — O-27-гейт байтово прежний; GSA-причины не подменяются
// =====================================================================================
describe('O-33 R4: GSA (O-27) не тронут', () => {
  test('shouldSkipGsaPageGuard: те же три причины и порядок', () => {
    expect(P.shouldSkipGsaPageGuard({ site: 'google_search', chatPageMarker: false })).toEqual({ skip: true, reason: 'not-chat-page' });
    expect(P.shouldSkipGsaPageGuard({ site: 'google_search', msgCount: 0 })).toEqual({ skip: true, reason: 'no-messages' });
    expect(P.shouldSkipGsaPageGuard({ site: 'google_search', baseTextLen: 0 })).toEqual({ skip: true, reason: 'empty-base' });
    expect(P.shouldSkipGsaPageGuard({ site: 'google_search' })).toEqual({ skip: false, reason: null });
    expect(P.shouldSkipGsaPageGuard({ site: 'chatgpt', chatPageMarker: false, msgCount: 0 })).toEqual({ skip: false, reason: null });
  });

  test('GSA-гейт: O-27-причины приоритетнее; not-complete при baseSeen=true прежний', () => {
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, baseComplete: true, baseSeen: true,
      loaderRunning: false, fired: false, isGemini: false,
      site: 'google_search', chatPageMarker: false, msgCount: 8, baseTextLen: 13270
    })).toEqual({ skip: true, reason: 'not-chat-page', resetFired: false });
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, baseComplete: false, baseSeen: true,
      loaderRunning: false, fired: false, isGemini: false,
      site: 'google_search', chatPageMarker: true, msgCount: 8, baseTextLen: 13270
    })).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('GSA-строка skip-лога байтово прежняя (not-complete/probe-running/O-27-ключи)', () => {
    const gsaLog = fnDecl(MGR_SRC, 'aiCmGsaAutoExportSkipLog');
    expect(gsaLog).toContain("if (reason === 'not-complete' || reason === 'probe-running') {");
    expect(gsaLog).toContain("var k27 = 'gsa27:' + reason + ':' + cid;");
    expect(gsaLog).toContain("'[AI CM][auto-export] site=google_search skip reason=' + reason");
  });
});

// =====================================================================================
// R5/R6: соседние наборы и «не трогать» — маркеры на месте
// =====================================================================================
describe('O-33 R5: O-11/O-31/O-27/O-15…O-20/O-28/O-9 — маркеры и байты соседей', () => {
  test('O-11 (имена/латч), O-31 (сегментация), O-27 (гарды скачивания) не тронуты', () => {
    expect(typeof P.latchKey).toBe('function');                       // O-11
    expect(typeof P.disambiguateFileName).toBe('function');           // O-11
    expect(typeof P.buildAutoExportFileName).toBe('function');        // O-11
    expect(fnDecl(PIPELINE_SRC, 'buildAutoExportFileName')).toContain('disambiguateFileName(');
    expect(CONTENT).toContain('function aiCmSnapshotIsCurrentThread('); // O-31
    expect(fnDecl(BUILDERS_SRC, 'downloadBlockReason')).toContain("return 'xssi-prefix';"); // O-27
    expect(BUILDERS_SRC).toContain("if (fileName === undefined || fileName === null || String(fileName).trim() === '') return 'empty-name';"); // O-27
    // архивный (T1-fix#2) и лоадерный гейты Gemini не тронуты
    const gate = fnDecl(PIPELINE_SRC, 'shouldSkipAutoExport');
    expect(gate).toContain("reason: 'archive-pending-live'");
    expect(gate).toContain("reason: 'loader-running'");
    // пороги не тронуты: кламп 1..100 и дефолт 90
    expect(gate).toContain('? s.threshold : 90');
    expect(P.effectiveAutoExportThreshold(90, undefined)).toBe(90);
    expect(P.effectiveAutoExportThreshold(90, 50)).toBe(50);
  });

  test('O-33-гейт: дизъюнкт убран, базовые причины и их порядок зафиксированы', () => {
    const gate = fnDecl(PIPELINE_SRC, 'shouldSkipAutoExport');
    // O-43: к baseComplete добавлен (через ||) монотонный латч сетевой полноты GSA;
    // дизъюнкт по baseSeen (O-33) по-прежнему отсутствует, base-pending — тот же.
    expect(gate).toContain('var completeOk = (s.baseComplete === true) || networkCompleteLatch;');
    expect(PIPELINE_SRC).not.toContain('!s.baseSeen');
    const iGsa = gate.indexOf('shouldSkipGsaPageGuard(s)');
    const iNotComplete = gate.indexOf("reason: 'not-complete'");
    const iThr = gate.indexOf('if (s.percentage < threshold) return');
    const iBasePending = gate.indexOf("reason: 'base-pending'");
    const iFired = gate.indexOf("reason: 'already-fired'");
    expect(iGsa).toBeGreaterThan(-1);
    expect(iGsa).toBeLessThan(iNotComplete);      // GSA-гард :322-336 — раньше (O-27)
    expect(iNotComplete).toBeLessThan(iThr);      // not-complete :357 прежний (Gemini/частичная сеть)
    expect(iThr).toBeLessThan(iBasePending);      // base-pending после порогов :372-376 (F5#2: below-threshold)
    expect(iBasePending).toBeLessThan(iFired);    // латч :377 — последним
  });

  test('O-33-лог: канонический aiCmDiagLine под гейтом, вызов typeof-гардом, латч не трогается', () => {
    const helper = fnDecl(MGR_SRC, 'aiCmAutoExportBasePendingLog');
    expect(helper).toContain("if (typeof aiCmDiagLine !== 'function') return;");
    expect(helper).toContain("aiCmDiagLine('auto-export'");
    expect(helper).toContain("reason: 'base-pending'");
    expect(MGR_SRC).toContain("var aiCmAutoExportSkipReasonState = { reason: '' };");
    const mgr = fnDecl(MGR_SRC, 'maybeAutoExport');
    expect(mgr).toContain("if (verdict.reason === 'base-pending') {");
    expect(mgr).toContain('typeof aiCmAutoExportBasePendingLog === \'function\'');
    expect(mgr).toContain("skipReasonState.reason !== 'base-pending'");
    // ветка base-pending — ДО GSA-ветки лога (единый вердикт) и без единого касания латча
    expect(mgr.indexOf("verdict.reason === 'base-pending'")).toBeLessThan(mgr.indexOf('aiCmGsaAutoExportSkipLog(gsaReason'));
    const bp = mgr.slice(mgr.indexOf("verdict.reason === 'base-pending'"), mgr.indexOf('aiCmGsaAutoExportSkipLog(gsaReason'));
    expect(bp).not.toContain('markAutoExportFired');
    expect(bp).not.toContain('resetAutoExportFired');
  });

  test('R6: щит O-1 вне автоэкспорт-контура, maybeAutoExport — прежний вызов вне ветвления щита', () => {
    expect(MGR_SRC).not.toContain('aiCmBadgeHold');
    expect(MGR_SRC).not.toContain('AI_CM_BADGE_HOLD');
    expect(PIPELINE_SRC).not.toContain('aiCmBadgeHold');
    expect(PIPELINE_SRC).not.toContain('AI_CM_BADGE_HOLD');
    const draw = fnDecl(CONTENT, 'processAndSend');
    expect(draw).toContain('maybeAutoExport(percentage);');
    const iHold = draw.indexOf('} else if (aiCmBadgeHoldActive()) {');
    expect(iHold).toBeGreaterThan(-1);
    expect(draw.indexOf('maybeAutoExport(percentage);')).toBeGreaterThan(iHold);
  });
});
