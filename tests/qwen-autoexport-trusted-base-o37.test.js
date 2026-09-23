/**
 * O-37 (A): ДОВЕРИЕ БАЗЕ АДАПТЕРА В ГЕЙТЕ АВТОЭКСПОРТА (сервис без сети — qwen).
 *
 * Живой лог-основание (21:47:18 / 21:58:03 / 22:03:50 / 22:07:44):
 *   [AI CM][diag] auto-export point=maybeAutoExport verdict=skip reason=base-pending
 *   site=qwen pct=63.7 / 63.8 baseSeen=0 baseComplete=0 — при пороге 30 файла нет НИ РАЗУ.
 *
 * Корень (ИЗМЕРЕН чтением кода): гейт O-33 (shouldSkipAutoExport) требовал СЕТЕВОЙ снимок
 * (baseSeen=1). У qwen старого чата сети нет никогда: базу пишет DOM-адаптер
 * (`history-write source=adapter` → adapterBaseSeen=1, O-35/v54), но гейт этот признак не
 * читал, и на каждом DRAW возвращался base-pending. Доверие aiCmQwenExportBaseTrusted
 * (O-36/D1) было простёрто только на РУЧНОЙ снимок экспорта.
 *
 * Фикс: гейт получает поле domBaseTrusted (его заполняет content.js-предикат
 * aiCmAutoExportTrustedBase: qwen + adapterBaseSeen для ТЕКУЩЕГО convId) → причина base-pending
 * не возвращается; дальше решают порог и латч. Порядок причин и вердикты прочих сайтов не
 * меняются (поле не передано → поведение 1:1, пины O-33 зелёные).
 *
 * Исполняются РЕАЛЬНЫЕ функции: shouldSkipAutoExport (utils/export-emit-pipeline.js),
 * maybeAutoExport → doAutoExportDownload → aiCmWriteAutoExportFile (core/export-manager.js),
 * aiCmAutoExportTrustedBase + aiCmAutoExportTrustedBaseDiag (core/content.js), канонический
 * aiCmDiagLine (utils/debug.js) и реальные сборщики байтов (utils/export-text-builders.js).
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const { contentSource: CONTENT } = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const CONTENT_ONLY = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');

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

// Живые числа владельца: порог 30, pct 63.7/63.8 (артефакт 21:47–22:07) и convId 4cf29053.
const CID = '4cf29053-7f1e-4c6a-9f2b-0f4a1c2d3e4f';
const LIVE_PCT = 63.8;
const LIVE_THRESHOLD = 30;
const ADAPTER_MSGS = [
  { role: 'user', text: 'привет' },
  { role: 'assistant', text: 'Привет! Чем помочь?' }
];
const DIAG_PREFIX = '[AI CM][diag] auto-export';

// ---------------------------------------------------------------------------------
// Песочница A: РЕАЛЬНЫЙ пороговый путь (maybeAutoExport → doAutoExportDownload →
// aiCmWriteAutoExportFile) + РЕАЛЬНЫЙ предикат доверия и его диагностика.
// ---------------------------------------------------------------------------------
const SCOPE = 'with (ctx) { ' +
  fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
  fnDecl(CONTENT_ONLY, 'aiCmAutoExportTrustedBase') + '\n' +
  fnDecl(CONTENT_ONLY, 'aiCmAutoExportTrustedBaseDiag') + '\n' +
  fnDecl(MGR_SRC, 'aiCmAutoExportConvId') + '\n' +
  fnDecl(MGR_SRC, 'aiCmAutoExportBasePendingLog') + '\n' +
  fnDecl(MGR_SRC, 'aiCmExportBaseSource') + '\n' +
  fnDecl(MGR_SRC, 'aiCmAutoExportStartDownload') + '\n' +
  fnDecl(MGR_SRC, 'doAutoExportDownload') + '\n' +
  fnDecl(MGR_SRC, 'maybeAutoExport') + '\n' +
  ' return { run: maybeAutoExport }; }';
const makeScope = new Function('ctx', SCOPE);

/**
 * Харнесс: состояние content-скрипта как в браузере (общий лексический скоуп модулей).
 * over: site, adapterBaseSeen, baseSeen, baseComplete, threshold, msgs, debug.
 */
function stand(over) {
  const o = over || {};
  const logs = [];
  const diag = [];
  const downloads = [];
  const ctx = {
    autoExportSettings: { enabled: true, pct: (o.threshold !== undefined) ? o.threshold : LIVE_THRESHOLD, fmt: 'txt' },
    autoExportPctBySite: {},
    autoExportLastConvId: '',
    autoExportLastPct: -1,
    autoExportFired: {},
    aiCmAutoExportNamesUsed: {},
    notCompleteLogged: {},
    sessionFiredCache: {},
    aiCmLoaderRunningByConv: {},
    aiCmCursorLiveByConv: {},
    aiCmLowConfidenceByConv: {},
    aiCmArchiveCountFor: function () { return 0; },
    aiCmAutoExportSkipReasonState: { reason: '' },
    baseSeen: (o.baseSeen === true),
    baseComplete: (o.baseComplete === true),
    baseCount: ADAPTER_MSGS.length,
    baseText: '',
    lastBaseTexts: ['привет', 'Привет! Чем помочь?'],
    lastDetailMessages: null,
    lastThreadId: '',
    lastEmitConvId: CID,
    lastResolvedModelId: 'qwen3.8-max',
    lastSnapshotModelName: 'Qwen3.8-Max',
    maxTokenCount: 81672,
    adapterBaseSeen: (o.adapterBaseSeen === true),
    currentAdapter: {
      siteName: o.site || 'qwen',
      extractMessages: function () { return ADAPTER_MSGS.slice(); }
    },
    getCurrentConvId: function () { return CID; },
    buildHistoryMessages: function () { return ADAPTER_MSGS.slice(); },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    aiCmGsaChatPageMarker: function () { return true; },
    ModelConfig: { getModel: function () { return { name: 'Qwen3.8-Max' }; } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    console: { log: function (m) { diag.push(String(m)); }, error: function () { } },
    chrome: { storage: { session: { set: function () { }, remove: function () { } } } },
    window: {
      __aiCmDebugLogs: (o.debug === true),
      location: { hostname: 'chat.qwen.ai' },
      AiCmExportEmitPipeline: P,
      AiCmExportBuilders: {
        buildTxtFromHistory: Builders.buildTxtFromHistory,
        buildMdFromHistory: Builders.buildMdFromHistory,
        buildJsonFromHistory: Builders.buildJsonFromHistory,
        downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); }
      }
    }
  };
  const api = makeScope(ctx);
  return {
    ctx: ctx,
    logs: logs,
    diag: diag,
    downloads: downloads,
    run: api.run,
    trustedDiag: function () {
      return diag.filter(function (l) {
        return l.indexOf(DIAG_PREFIX) === 0 && l.indexOf('adapterBaseSeen=') !== -1;
      });
    }
  };
}

beforeEach(() => {
  try { window.sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

// =====================================================================================
// A-D: чистый гейт — доверенная база адаптера
// =====================================================================================
describe('O-37 A-D: shouldSkipAutoExport — domBaseTrusted (база адаптера сервиса без сети)', () => {
  const QWEN_BASE = {
    enabled: true, percentage: LIVE_PCT, threshold: LIVE_THRESHOLD,
    baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
    isGemini: false, site: 'qwen', domBaseTrusted: true
  };

  test('живой вход 21:47–22:07: qwen + база адаптера, pct 63.8 ≥ порога 30 → гейт пропускает', () => {
    expect(P.shouldSkipAutoExport(QWEN_BASE)).toEqual({ skip: false, reason: null, resetFired: false });
    // причина base-pending при доверенной базе НЕ возвращается ни в одном варианте входа
    expect(P.shouldSkipAutoExport(QWEN_BASE).reason).not.toBe('base-pending');
  });

  test('pct ниже порога → причина пороговая (НЕ base-pending); глубже на 10 п.п. — ось гистерезиса прежняя', () => {
    const v = P.shouldSkipAutoExport(Object.assign({}, QWEN_BASE, { percentage: 25 }));
    expect(v).toEqual({ skip: true, reason: 'below-threshold', resetFired: false });
    expect(v.reason).not.toBe('base-pending');
    // pct глубоко ниже порога: латч не трогаем (baseSeen=false — прежняя ось v82/D5)
    expect(P.shouldSkipAutoExport(Object.assign({}, QWEN_BASE, { percentage: 5 })))
      .toEqual({ skip: true, reason: 'below-threshold-unreliable', resetFired: false });
  });

  test('повторный DRAW после файра → already-fired (повторных файров нет)', () => {
    expect(P.shouldSkipAutoExport(Object.assign({}, QWEN_BASE, { fired: true })))
      .toEqual({ skip: true, reason: 'already-fired', resetFired: false });
  });
});

// =====================================================================================
// A-R: шесть платформ и qwen-сеть — вердикты и порядок причин прежние
// =====================================================================================
describe('O-37 A-R: прочие сайты не задеты — поле не передано, вердикты 1:1', () => {
  const SIX = ['chatgpt', 'gemini', 'deepseek', 'claude', 'perplexity', 'google_search'];

  test('DOM-база до сетевого снимка у пяти не-Gemini сайтов → base-pending прежний (O-33 жив)', () => {
    ['chatgpt', 'deepseek', 'claude', 'perplexity'].forEach(function (site) {
      expect(P.shouldSkipAutoExport({
        enabled: true, percentage: 63.8, threshold: 30,
        baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
        isGemini: false, site: site
      })).toEqual({ skip: true, reason: 'base-pending', resetFired: false });
    });
  });

  test('шесть платформ: без поля domBaseTrusted порядок причин и вердикты прежние', () => {
    SIX.forEach(function (site) {
      // порог пройден, полноты нет: Gemini → not-complete, прочие → base-pending
      const v = P.shouldSkipAutoExport({
        enabled: true, percentage: 95, threshold: 30,
        baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
        isGemini: site === 'gemini', site: site
      });
      expect(v.reason).toBe(site === 'gemini' ? 'not-complete' : 'base-pending');
      // ниже порога — пороговая причина у не-Gemini (порядок причин O-33 не сдвинулся);
      // Gemini без подтверждённой полноты и здесь остаётся not-complete (поведение прежнее)
      expect(P.shouldSkipAutoExport({
        enabled: true, percentage: 5, threshold: 30,
        baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
        isGemini: site === 'gemini', site: site
      }).reason).toBe(site === 'gemini' ? 'not-complete' : 'below-threshold-unreliable');
    });
  });

  test('qwen-сеть и «базы адаптера ещё нет» — вердикты прежние (поле только добавляет доверие)', () => {
    // qwen с СЕТЕВОЙ базой (baseSeen=1): частичная сеть → not-complete, как у всех не-Gemini
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 30,
      baseComplete: false, baseSeen: true, loaderRunning: false, fired: false,
      isGemini: false, site: 'qwen'
    })).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
    // domBaseTrusted === false (adapterBaseSeen ещё не взведён) → base-pending как раньше
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 63.8, threshold: 30,
      baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
      isGemini: false, site: 'qwen', domBaseTrusted: false
    })).toEqual({ skip: true, reason: 'base-pending', resetFired: false });
  });
});

// =====================================================================================
// A-D: РЕАЛЬНЫЙ пороговый файр по базе адаптера + латч + диагностика
// =====================================================================================
describe('O-37 A-D: реальный maybeAutoExport — один файр по базе адаптера, латч, лог', () => {
  test('qwen: adapterBaseSeen=1, pct 63.8, порог 30 → ровно один файл, латч стоит, fired-строка', () => {
    const h = stand({ adapterBaseSeen: true });
    h.run(LIVE_PCT);
    expect(h.downloads).toHaveLength(1);
    const d = h.downloads[0];
    expect(d.file).toMatch(/^qwen-4cf29053-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
    expect(d.content).toBe('\uFEFF' + Builders.buildTxtFromHistory({
      site: 'qwen', model: '', tokens: h.ctx.maxTokenCount, limit: 0, percent: LIVE_PCT,
      messages: ADAPTER_MSGS
    }));
    expect(P.getAutoExportFired(h.ctx.autoExportFired, 'qwen', CID)).toBe(true);
    expect(h.logs.join('\n')).toContain('fired convId=' + CID + ' pct=' + LIVE_PCT);
    // ни одной строки base-pending: причина при доверенной базе не возвращается
    expect(h.diag.filter(function (l) { return l.indexOf('reason=base-pending') !== -1; })).toEqual([]);
  });

  test('повторный DRAW → already-fired: второго файла и второго латча нет', () => {
    const h = stand({ adapterBaseSeen: true });
    h.run(LIVE_PCT);
    h.run(LIVE_PCT);
    expect(h.downloads).toHaveLength(1);
    expect(h.logs.join('\n')).toContain('skip reason=already-fired convId=' + CID);
  });

  test('adapterBaseSeen=0 (базы нет) → файла нет и латч не поставлен (пин O-33 жив)', () => {
    const h = stand({ adapterBaseSeen: false });
    h.run(LIVE_PCT);
    expect(h.downloads).toEqual([]);
    expect(Object.keys(h.ctx.autoExportFired)).toEqual([]);
  });

  test('достоверная база соседнего сайта файр не открывает: chatgpt без сети → base-pending, файла нет', () => {
    const h = stand({ site: 'chatgpt', adapterBaseSeen: true, baseSeen: false, baseComplete: false, debug: true });
    h.run(LIVE_PCT);
    expect(h.downloads).toEqual([]);
    expect(Object.keys(h.ctx.autoExportFired)).toEqual([]);
    expect(h.diag.filter(function (l) { return l.indexOf('reason=base-pending') !== -1; })).toHaveLength(1);
  });

  test('ГЕЙТ aiCmDebug: выключен → ни строки; включён → ровно одна строка с trigger/adapterBaseSeen; байты идентичны', () => {
    const offStand = stand({ adapterBaseSeen: true, debug: false });
    offStand.run(LIVE_PCT);
    expect(offStand.trustedDiag()).toEqual([]);
    const onStand = stand({ adapterBaseSeen: true, debug: true });
    onStand.run(LIVE_PCT);
    const hit = onStand.trustedDiag();
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('point=maybeAutoExport');
    expect(hit[0]).toContain('verdict=fire');
    expect(hit[0]).toContain('trigger=threshold');
    expect(hit[0]).toContain('site=qwen');
    expect(hit[0]).toContain('adapterBaseSeen=1');
    expect(hit[0]).toContain('baseSeen=0');
    expect(hit[0]).toContain('baseComplete=0');
    expect(hit[0]).toContain('convId=' + CID);
    expect(hit[0]).toContain('pct=' + LIVE_PCT);
    // байты выхода при гейте вкл/выкл идентичны (диагностика только читает)
    expect(onStand.downloads[0].content).toBe(offStand.downloads[0].content);
    expect(onStand.downloads[0].file).toBe(offStand.downloads[0].file);
    // хелпер молчит при чужом сайте/без базы адаптера (broadcast не расширен)
    const other = stand({ site: 'deepseek', adapterBaseSeen: true, debug: true });
    other.run(LIVE_PCT);
    expect(other.trustedDiag()).toEqual([]);
    const noBase = stand({ adapterBaseSeen: false, debug: true });
    noBase.run(LIVE_PCT);
    expect(noBase.trustedDiag()).toEqual([]);
  });
});

// =====================================================================================
// Source-пины проводки (R: признак адаптера в автоэкспорт-контур не «протёк»)
// =====================================================================================
describe('O-37 A: проводка и границы (source-пины)', () => {
  test('content.js: предикат доверия — qwen И база адаптера ТЕКУЩЕГО чата (тот же смысл, что D1)', () => {
    const fn = fnDecl(CONTENT_ONLY, 'aiCmAutoExportTrustedBase');
    expect(fn).toContain("currentAdapter.siteName === 'qwen'");
    expect(fn).toContain('adapterBaseSeen === true');
    expect(fn).toContain('return false;');
    // предикат ручного экспорта (O-36/D1) не переписан
    expect(fnDecl(CONTENT_ONLY, 'aiCmQwenExportBaseTrusted')).toContain('adapterBaseSeen === true');
  });

  test('export-manager.js: поле передаётся typeof-гардом; сам признак в модуль не проникает (пин v54)', () => {
    const mgr = fnDecl(MGR_SRC, 'maybeAutoExport');
    expect(mgr).toContain('domBaseTrusted:');
    expect(mgr).toContain("typeof aiCmAutoExportTrustedBase === 'function'");
    expect(MGR_SRC).not.toContain('adapterBaseSeen');
    expect(PIPELINE_SRC).not.toContain('adapterBaseSeen');
  });

  test('export-emit-pipeline.js: гейт читает domBaseTrusted, порядок причин не переписан', () => {
    const gate = fnDecl(PIPELINE_SRC, 'shouldSkipAutoExport');
    expect(gate).toContain('var domBaseTrusted = (s.domBaseTrusted === true);');
    // O-43: та же ось полноты + монотонный латч сетевой полноты GSA (для qwen поле не
    // передаётся → ветка domBaseTrusted прежняя 1:1).
    expect(gate).toContain('var completeOk = (s.baseComplete === true) || networkCompleteLatch;');
    expect(gate).toContain('var baseReady = completeOk || domBaseTrusted;');
    expect(gate).toContain('var basePending = (s.isGemini !== true && s.baseSeen !== true && !domBaseTrusted && !networkCompleteLatch);');
    // порядок причин: not-complete → порог → base-pending → already-fired
    const iNotComplete = gate.indexOf("reason: 'not-complete'");
    const iThr = gate.indexOf('if (s.percentage < threshold) return');
    const iBasePending = gate.indexOf("reason: 'base-pending'");
    const iFired = gate.indexOf("reason: 'already-fired'");
    expect(iNotComplete).toBeLessThan(iThr);
    expect(iThr).toBeLessThan(iBasePending);
    expect(iBasePending).toBeLessThan(iFired);
  });

  test('диагностика A — только под aiCmDebug и только на файре: вызов typeof-гардом в точке скачивания', () => {
    const w = fnDecl(MGR_SRC, 'doAutoExportDownload');
    expect(w).toContain("typeof aiCmAutoExportTrustedBaseDiag === 'function'");
    expect(w).toContain('aiCmAutoExportTrustedBaseDiag(reason, cid, percentage);');
    const diagFn = fnDecl(CONTENT_ONLY, 'aiCmAutoExportTrustedBaseDiag');
    expect(diagFn).toContain("if (typeof aiCmDiagLine !== 'function') return false;");
    expect(diagFn).toContain("aiCmDiagLine('auto-export'");
    expect(diagFn).toContain('adapterBaseSeen:');
    // своей печати (console.*) у хелпера нет — только канонический принтер под гейтом
    expect(diagFn).not.toContain('console.');
  });

  test('R-пин границы: второй триггер base-complete (v64) и спасательный pre-trim не тронуты', () => {
    const trigger = fnDecl(PIPELINE_SRC, 'shouldSkipBaseCompleteTrigger');
    expect(trigger).toContain("reason: 'below-threshold-base-complete'");
    expect(PIPELINE_SRC).toContain('function shouldSkipBaseCompleteTrigger(state)');
    // pre-trim: своя причина файла в единственной точке старта скачивания — прежняя
    expect(MGR_SRC).toContain("reason === 'pre-trim' ? '-pretrim' : ''");
    expect(MGR_SRC).toContain("if (reason !== 'pre-trim') {");
    // гейт автоэкспорта не переписан целиком: причины archive-pending-live/loader-running живы
    const gate = fnDecl(PIPELINE_SRC, 'shouldSkipAutoExport');
    expect(gate).toContain("reason: 'archive-pending-live'");
    expect(gate).toContain("reason: 'loader-running'");
    expect(gate).toContain('? s.threshold : 90');
  });
});
