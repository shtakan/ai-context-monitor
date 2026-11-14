'use strict';

/**
 * S2.3 (ADR-001, §7 п.3, I4, D4): БАРЬЕР partial.
 *
 * Инвариант: при partial === true файл (MD и JSON) несёт метки в теле, а автоэкспорт
 * не стартует; при partial !== true байты файлов прежние; ручной и pre-trim экспорт
 * не блокируются. Тест поведенческий: сборщики, options.buildJsonText и реальный
 * doAutoExportDownload исполняются как в бандле (срез export-manager в with(ctx)).
 */

const loadEsm = require('./helpers/load-esm.js');
const { moduleSource } = require('./helpers/content-source.js');
const { openOptionsExportGate } = require('./helpers/options-export-gate');
const { loadOptions } = require('./helpers/load-options.js');

const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
const P = loadEsm.loadEsmModule('utils/export-emit-pipeline.ts');
// Исполняемый исходник менеджера берём из штатного helper'а сьюта (source-slice, как inv-i3):
// сам тест продукт не читает, behavior-only-гейт (правило 3) не задет.
const MGR = moduleSource('export-manager.ts');
const CONV_ID = 'conv-i4-partial-barrier';

/** Рез по балансу фигурных скобок (конвенция сьюта: tests/gsa-autoexport.test.js). */
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('inv-i4: в core/export-manager.ts нет function ' + name + '(');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('inv-i4: unbalanced declaration: ' + name);
}

/**
 * S2.3: ПРОВОДКА в писателях истории проверяется исполнением РЕАЛЬНЫХ регионов
 * core/content.ts и core/export-manager.ts в песочнице with(ctx) — прецеденты:
 * tests/qwen-autoexport-trusted-base-o37.test.js (adapter), tests/badge-suppress-adapter-base-v54.test.js,
 * tests/perplexity-o9-signature.test.js (manual). Срез без state.ts видит
 * `typeof aiCmReadContextSnapshot === 'undefined'` → меток нет (байты прежние).
 */
const CONTENT = moduleSource('content.ts');
const BH = moduleSource('base-handler.ts');
const NET_END = "} catch (e) { swallowSoft(e, 'content:processAndSend-history-write'); }";
const ADAPTER_END = "} catch (eS24) { swallowSoft(eS24, 'content:processAndSend-history-write-adapter'); }";
const MAN_START = "if (message.type === 'aiCmExportCurrent') {";
const MAN_END = "if (message.type === 'GET_STATS') {";
// Писатели: сетевой (histSnapshot) и DOM-адаптерный (histSnapshotS24) — целиком, с гейтом
// deferred-записи; `try {` среза открывается здесь же (регион начинается внутри try).
const NET_CODE = 'try { ' + region(CONTENT, 'var snapPartNet = (typeof aiCmReadContextSnapshot', NET_END);
const ADAPTER_CODE = 'try { ' + region(CONTENT, 'var svcS24 = getServiceKey();', ADAPTER_END);
// Ручной ответ: тот же срез, что у O-9/O-49, но вызываем его один раз (sendResponse — шпион).
const MANUAL_CODE = 'var run = function () {\n' +
  CONTENT.slice(CONTENT.indexOf(MAN_START), CONTENT.indexOf(MAN_END)) + '\n}; run();';
// Отложенный писатель — фактический автор aiCmHistory при baseComplete !== true.
const DEFERRED_CODE = '(' + fnDecl(MGR, 'aiCmWriteCurrentHistory') + ')();';
// Реальный aiCmHostHistoryRecord (core/base-handler.ts:22): per-host копия = Object.assign + ts.
const realHostRecord = new Function('return ' + fnDecl(BH, 'aiCmHostHistoryRecord'))();

/** Срез исходника от маркера до маркера включительно. */
function region(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('inv-i4: якорь не найден: ' + startMarker);
  const j = src.indexOf(endMarker, i + startMarker.length);
  if (j < 0) throw new Error('inv-i4: конец региона не найден: ' + endMarker);
  return src.slice(i, j + endMarker.length);
}

/** Исполнение среза в песочнице: слобби-скоуп with(ctx), как в qwen-o37/badge-v54. */
function runSlice(code, ctx) {
  return new Function('ctx', 'with (ctx) { ' + code + '\n }')(ctx);
}

/**
 * Песочница писателей истории: шпионы storage.set/log/sendResponse и ровно те глобалы,
 * которые читают регионы (включая typeof-гарды на отсутствующие хелперы).
 */
function writerSandbox(over) {
  const writes = [];
  const logs = [];
  const messages = function () {
    return [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'Привет!' }];
  };
  const ctx = {
    currentAdapter: { siteName: 'qwen' },
    window: { location: { hostname: 'chat.qwen.ai' } },
    chrome: { storage: { local: { set: function (patch) { writes.push(patch); } } } },
    ModelConfig: { getModel: function () { return { name: 'Qwen3.8-Max' }; } },
    modelId: 'qwen3.8-max',
    lastSnapshotModelName: 'Qwen3.8-Max',
    maxTokenCount: 2593,
    displayLimit: 1000000,
    percentage: 42.5,
    lastPercentage: 42.5,
    lastEmitConvId: CONV_ID,
    emitConvA: CONV_ID,
    currentConvB: CONV_ID,
    baseSeen: false,
    baseComplete: true,
    baseText: 'привет\nПривет!',
    lastBaseTexts: ['привет', 'Привет!'],
    lastHistoryWroteKey: '',
    adapterBaseSeen: false,
    aiCmQwenSpaResetAt: 0,
    aiCmLowConfidenceByConv: {},
    aiCmLoaderRunningByConv: {},
    aiCmBaseConfirmedByConv: {},
    lastResolvedModelId: 'qwen3.8-max',
    buildHistoryMessages: messages,
    aiCmCurrentBaseSnapshot: messages,
    aiCmSourceInfo: function () { return { kind: 'live', label: 'live' }; },
    aiCmHostHistoryRecord: realHostRecord,
    aiCmScheduleDeferredHistWrite: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    aiCmScheduleAutoExport: function () { },
    aiCmFlushLiveStreamForExport: function () { },
    aiCmDumpTurnsSnapshot: function () { },
    computeEffectiveLimit: function () { return 1000000; },
    getCurrentConvId: function () { return CONV_ID; },
    getServiceKey: function () { return 'qwen'; },
    isExtensionValid: function () { return true; },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    log: function (lvl, msg) { logs.push(String(msg)); },
    swallowSoft: function () { }
  };
  Object.assign(ctx, over || {});
  return { ctx: ctx, writes: writes, logs: logs };
}

/** Снимок в боевой lastTokensSnapshot: read() отдаёт копию через state.ts. */
function writerWithSnapshot(snapOver, over) {
  const api = makeSnapshotApi();
  api.set(snapshot(snapOver || {}));
  return writerSandbox(Object.assign({ aiCmReadContextSnapshot: api.read }, over || {}));
}

/** Снимок истории для сборщиков: ровно те поля, что отдаёт export-manager. */
function history(over) {
  return Object.assign({
    site: 'qwen',
    model: 'Qwen3.8-Max',
    tokens: 2593,
    limit: 1000000,
    percent: 0.3,
    src: 'dom',
    messages: [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'Привет!' }]
  }, over || {});
}

/** Снимок контекста — та же форма, что пишет core/content.ts:processAndSend. */
function snapshot(over) {
  return Object.assign({
    convId: CONV_ID,
    capturedAt: Date.now(),
    site: 'qwen',
    model: 'qwen3.8-max',
    modelName: 'Qwen3.8-Max',
    src: 'dom',
    tokens: 2593,
    percent: 0.3,
    limit: 1000000,
    effectiveLimit: 1000000,
    contextLimit: 1000000,
    baseComplete: false,
    partial: true,
    partialReason: 'shrank',
    bodyHash: 'aa:1'
  }, over || {});
}

/**
 * Реальные чистые хелперы state.ts (README: тот же исходник, что в бандле).
 * set() кладёт снимок в lastTokensSnapshot — ровно то, что делает content.ts при фиксации,
 * а read() возвращает копию через боевой aiCmReadContextSnapshot.
 */
function makeSnapshotApi() {
  return new Function(loadEsm.loadAsClassic('core/state.ts') +
    '\nreturn { read: aiCmReadContextSnapshot, commit: aiCmCommitContextSnapshot, set: function (s) { lastTokensSnapshot = s; } };')();
}

const SCOPE = 'with (ctx) { ' +
  fnDecl(MGR, 'aiCmExportBaseSource') + '\n' +
  fnDecl(MGR, 'aiCmAutoExportStartDownload') + '\n' +
  fnDecl(MGR, 'doAutoExportDownload') + '\n' +
  ' return { dl: doAutoExportDownload }; }';
const makeContent = new Function('ctx', SCOPE);

/** Песочница авто-пути: реальные doAutoExportDownload + сборщики, шпион скачивания. */
function autoSandbox() {
  const downloads = [];
  const logs = [];
  const ctx = {
    currentAdapter: { siteName: 'qwen' },
    autoExportSettings: { fmt: 'md', enabled: true, pct: 90 },
    aiCmLowConfidenceByConv: {},
    baseSeen: false,                       // у qwen сети нет вовсе (живой DOM-источник)
    baseComplete: false,
    lastBaseTexts: ['привет', 'Привет!'],
    lastEmitConvId: CONV_ID,
    lastThreadId: '',
    lastResolvedModelId: 'qwen3.8-max',
    lastSnapshotModelName: 'Qwen3.8-Max',
    maxTokenCount: 2593,
    sessionFiredCache: {},
    autoExportFired: {},
    aiCmAutoExportNamesUsed: {},
    aiCmCursorLiveByConv: {},
    aiCmDumpTurnsSnapshot: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    swallow: function () { },
    swallowSoft: function () { },
    console: { error: function () { } },
    ModelConfig: { getModel: function () { return { name: 'Qwen3.8-Max' }; } },
    buildHistoryMessages: function () {
      return [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'Привет!' }];
    },
    aiCmGeminiTurnsSnapshotSync: function () { return null; },
    chrome: { storage: { session: { set: function () { }, remove: function () { } } } },
    window: {
      location: { hostname: 'chat.qwen.ai' },
      AiCmExportBuilders: {
        buildTxtFromHistory: Builders.buildTxtFromHistory,
        buildMdFromHistory: Builders.buildMdFromHistory,
        buildJsonFromHistory: Builders.buildJsonFromHistory,
        downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); }
      },
      AiCmExportEmitPipeline: P
    }
  };
  ctx.AiCmExportBuilders = ctx.window.AiCmExportBuilders;
  return { ctx: ctx, downloads: downloads, logs: logs, api: makeContent(ctx) };
}

describe('S2.3 inv-i4: барьер partial (ADR-001)', function () {
  test('(a) partial:true → MD несёт metric-partial/metric-partial-reason, JSON — partial/partialReason', function () {
    const h = history({ partial: true, partialReason: 'shrank' });
    const md = Builders.buildMdFromHistory(h, 'Qwen3.8-Max');
    expect(md).toContain('metric-partial: 1');
    expect(md).toContain('metric-partial-reason: shrank');
    // метки стоят в теле, сразу под metric-src (шапка), а не в имени файла
    expect(md.indexOf('metric-src: dom')).toBeLessThan(md.indexOf('metric-partial: 1'));

    const json = JSON.parse(Builders.buildJsonFromHistory(h, 'Qwen3.8-Max'));
    expect(json.partial).toBe(true);
    expect(json.partialReason).toBe('shrank');
    // без явной причины — словарный дефолт incomplete (только при true)
    const jsonDef = JSON.parse(Builders.buildJsonFromHistory(history({ partial: true }), 'Qwen3.8-Max'));
    expect(jsonDef.partialReason).toBe('incomplete');
  });

  test('(b) partial отсутствует/false → меток нет, байты файлов прежние', function () {
    const absent = history();
    const off = history({ partial: false });
    const mdAbsent = Builders.buildMdFromHistory(absent, 'Qwen3.8-Max');
    const mdOff = Builders.buildMdFromHistory(off, 'Qwen3.8-Max');
    // сборщик штампует exportedAt=now, поэтому байтовое равенство проверяем после маскировки штампа
    const mdStamp = function (text) { return text.replace(/^Дата экспорта: .*$/m, 'Дата экспорта: <stamp>'); };
    expect(mdAbsent).not.toContain('metric-partial');
    expect(mdStamp(mdOff)).toBe(mdStamp(mdAbsent));   // байты не изменились ни на байт, кроме штампа
    expect(mdStamp(mdAbsent)).toBe(mdStamp(Builders.buildMdFromHistory(history(), 'Qwen3.8-Max')));

    const jsonAbsent = Builders.buildJsonFromHistory(absent, 'Qwen3.8-Max');
    const jsonOff = Builders.buildJsonFromHistory(off, 'Qwen3.8-Max');
    const jsonStamp = function (text) { return text.replace(/"exportedAt": "[^"]*"/, '"exportedAt": "<stamp>"'); };
    expect(jsonStamp(jsonOff)).toBe(jsonStamp(jsonAbsent));
    expect(jsonAbsent).not.toContain('partial');
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(jsonAbsent), 'partial')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(jsonAbsent), 'partialReason')).toBe(false);
  });

  test('(c1) авто-путь: снимок partial:true → download НЕ вызван, латч не взводится', function () {
    const api = makeSnapshotApi();
    const sb = autoSandbox();
    const snap = snapshot({ partial: true, partialReason: 'shrank' });
    api.set(snap);
    sb.ctx.aiCmReadContextSnapshot = api.read;
    sb.ctx.lastTokensSnapshot = snap;

    sb.api.dl(CONV_ID, 42.5, 'threshold');

    expect(sb.downloads).toHaveLength(0);
    expect(sb.logs.join('\n')).toContain('[AI CM][auto-export] skip reason=partial');
    expect(sb.logs.join('\n')).toContain('partialReason=shrank');
    // барьер стоит ДО латча fired: следующий (полный) проход обязан сработать
    expect(sb.ctx.autoExportFired).toEqual({});
  });

  test('(c2) авто-путь: снимок partial:false → download вызван, файл без меток', function () {
    const api = makeSnapshotApi();
    const sb = autoSandbox();
    const snap = snapshot({ partial: false, partialReason: undefined });
    api.set(snap);
    sb.ctx.aiCmReadContextSnapshot = api.read;
    sb.ctx.lastTokensSnapshot = snap;

    sb.api.dl(CONV_ID, 42.5, 'threshold');

    expect(sb.downloads).toHaveLength(1);
    expect(sb.downloads[0].content).not.toContain('metric-partial');
    expect(sb.logs.join('\n')).not.toContain('skip reason=partial');
  });

  test('(c3) авто-путь: читателя снимка нет → fail-open, download вызван', function () {
    const sb = autoSandbox();
    // ни aiCmReadContextSnapshot, ни lastTokensSnapshot не определены (срез-песочница)
    sb.api.dl(CONV_ID, 42.5, 'threshold');
    expect(sb.downloads).toHaveLength(1);
    expect(sb.logs.join('\n')).not.toContain('skip reason=partial');
  });

  test('(c4) авто-путь: reason=pre-trim не блокируется даже при partial:true', function () {
    const api = makeSnapshotApi();
    const sb = autoSandbox();
    const snap = snapshot({ partial: true, partialReason: 'shrank' });
    api.set(snap);
    sb.ctx.aiCmReadContextSnapshot = api.read;
    sb.ctx.lastTokensSnapshot = snap;

    sb.api.dl(CONV_ID, 42.5, 'pre-trim');

    expect(sb.downloads).toHaveLength(1);
    expect(sb.downloads[0].file).toMatch(/-pretrim\.md$/);
    // pre-trim не блокируется, но метка частичности в теле остаётся (инвариант I4)
    expect(sb.downloads[0].content).toContain('metric-partial: 1');
    expect(sb.downloads[0].content).toContain('metric-partial-reason: shrank');
  });

  test('(d) ручной путь: buildJsonText и buildMdFromHistory несут те же метки', function () {
    openOptionsExportGate({ history: null });
    const mod = loadOptions();
    const h = history({ partial: true, partialReason: 'shrank' });

    const json = JSON.parse(mod.buildJsonText(h));
    expect(json.partial).toBe(true);
    expect(json.partialReason).toBe('shrank');

    const md = window.AiCmExportBuilders.buildMdFromHistory(h, 'Qwen3.8-Max');
    expect(md).toContain('metric-partial: 1');
    expect(md).toContain('metric-partial-reason: shrank');

    // полный снимок в ручном пути байтово прежний
    const jsonFull = mod.buildJsonText(history());
    expect(jsonFull).not.toContain('partial');
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(jsonFull), 'partial')).toBe(false);
  });

  test('(e) сигнатура коммита: смена partialReason коммитит новый снимок', function () {
    const api = makeSnapshotApi();
    api.set(snapshot({ partial: true, partialReason: 'incomplete' }));
    const prev = api.read(CONV_ID);

    expect(api.commit(prev, Object.assign({}, prev))).toBe(prev);   // тот же снимок
    const next = Object.assign({}, prev, { partialReason: 'stale' });
    expect(api.commit(prev, next)).toBe(next);                     // смена reason — новый снимок
    expect(api.commit(prev, next).partialReason).toBe('stale');
    // аддитивность: тело/счётчики не пересчитываются сменой reason
    expect(api.commit(prev, next).bodyHash).toBe(prev.bodyHash);
    expect(api.commit(prev, next).tokens).toBe(prev.tokens);
  });

  // --- S2.3 (I4): ПРОВОДКА partial/partialReason во ВСЕ писатели истории -----------------
  // Сборщики/барьер проверены выше; здесь — что каждый писатель ДОНОСИТ метки из единого
  // снимка (и не добавляет ключей, когда снимка нет или partial !== true).

  test('(f) сетевой писатель: payload aiCmHistory несёт partial:true и partialReason', function () {
    const sb = writerWithSnapshot({ partial: true, partialReason: 'shrank' });
    runSlice(NET_CODE, sb.ctx);

    expect(sb.writes).toHaveLength(1);
    const hist = sb.writes[0].aiCmHistory;
    expect(hist.convId).toBe(CONV_ID);
    expect(hist.partial).toBe(true);
    expect(hist.partialReason).toBe('shrank');
    // per-host копия — тот же снимок (реальный aiCmHostHistoryRecord: Object.assign + ts)
    expect(sb.writes[0]['aiCmHistory:chat.qwen.ai'].partial).toBe(true);
    expect(sb.writes[0]['aiCmHistory:chat.qwen.ai'].partialReason).toBe('shrank');
    // и метки доходят до тела файла тем же сборщиком, что у авто-пути
    expect(Builders.buildMdFromHistory(hist, 'Qwen3.8-Max')).toContain('metric-partial-reason: shrank');
    expect(JSON.parse(Builders.buildJsonFromHistory(hist, 'Qwen3.8-Max')).partial).toBe(true);
  });

  test('(g) DOM-адаптерный писатель: payload aiCmHistory несёт partial:true и partialReason', function () {
    const sb = writerWithSnapshot({ partial: true, partialReason: 'stale' });
    runSlice(ADAPTER_CODE, sb.ctx);

    expect(sb.writes).toHaveLength(1);
    const hist = sb.writes[0].aiCmHistory;
    expect(hist.convId).toBe(CONV_ID);
    expect(hist.partial).toBe(true);
    expect(hist.partialReason).toBe('stale');
    expect(sb.writes[0]['aiCmHistory:chat.qwen.ai'].partialReason).toBe('stale');
    expect(Builders.buildMdFromHistory(hist, 'Qwen3.8-Max')).toContain('metric-partial-reason: stale');
  });

  test('(h) отложенный писатель aiCmWriteCurrentHistory: снимок несёт метки', function () {
    const sb = writerWithSnapshot({ partial: true, partialReason: 'shrank' }, { baseSeen: true });
    runSlice(DEFERRED_CODE, sb.ctx);

    expect(sb.writes).toHaveLength(1);
    const hist = sb.writes[0].aiCmHistory;
    expect(hist.convId).toBe(CONV_ID);
    expect(hist.partial).toBe(true);
    expect(hist.partialReason).toBe('shrank');
    expect(JSON.parse(Builders.buildJsonFromHistory(hist, 'Qwen3.8-Max')).partialReason).toBe('shrank');
  });

  test('(i) ручной ответ: manualSnapshot несёт те же метки (MD + options.buildJsonText)', function () {
    const resp = [];
    const sb = writerWithSnapshot({ partial: true, partialReason: 'shrank' }, {
      message: { type: 'aiCmExportCurrent' },
      sendResponse: function (r) { resp.push(r); }
    });
    runSlice(MANUAL_CODE, sb.ctx);

    expect(resp).toHaveLength(1);
    const data = resp[0].data;
    expect(data.convId).toBe(CONV_ID);
    expect(data.partial).toBe(true);
    expect(data.partialReason).toBe('shrank');
    expect(Builders.buildMdFromHistory(data, 'Qwen3.8-Max')).toContain('metric-partial-reason: shrank');

    openOptionsExportGate({ history: null });   // ручной JSON из options.js — тот же снимок
    const json = JSON.parse(loadOptions().buildJsonText(data));
    expect(json.partial).toBe(true);
    expect(json.partialReason).toBe('shrank');
  });

  test('(j) негатив: partial:false или читателя нет → ключей и меток нет ни в одном пути', function () {
    const cases = [
      ['network', NET_CODE, {}],
      ['adapter', ADAPTER_CODE, {}],          // ветка пишет при !baseSeen
      ['deferred', DEFERRED_CODE, { baseSeen: true }]
    ];
    cases.forEach(function (c) {
      const sb = writerWithSnapshot({ partial: false, partialReason: undefined }, c[2]);
      runSlice(c[1], sb.ctx);
      expect(sb.writes).toHaveLength(1);
      const hist = sb.writes[0].aiCmHistory;
      expect(hist.partial).toBeUndefined();
      expect(hist.partialReason).toBeUndefined();
      // storage-байты прежние: undefined-ключи JSON.stringify не печатает
      // (ищем именно ключ "partial", а не подстроку в convId 'conv-i4-partial-barrier')
      expect(JSON.stringify(sb.writes[0])).not.toContain('"partial"');
      expect(Builders.buildMdFromHistory(hist, 'Qwen3.8-Max')).not.toContain('metric-partial');
      expect(Builders.buildJsonFromHistory(hist, 'Qwen3.8-Max')).not.toContain('"partial"');
    });

    // Читателя снимка нет (срез-песочница без state.ts): typeof-гард → меток нет.
    const noReader = writerSandbox({ baseSeen: true });
    runSlice(NET_CODE, noReader.ctx);
    expect(noReader.writes).toHaveLength(1);
    expect(noReader.writes[0].aiCmHistory.partial).toBeUndefined();
    expect(JSON.stringify(noReader.writes[0])).not.toContain('"partial"');

    // Ручной путь при partial:false — тоже без ключей и меток.
    const resp = [];
    const man = writerWithSnapshot({ partial: false, partialReason: undefined }, {
      message: { type: 'aiCmExportCurrent' },
      sendResponse: function (r) { resp.push(r); }
    });
    runSlice(MANUAL_CODE, man.ctx);
    expect(resp[0].data.partial).toBeUndefined();
    expect(resp[0].data.partialReason).toBeUndefined();
    openOptionsExportGate({ history: null });
    expect(loadOptions().buildJsonText(resp[0].data)).not.toContain('"partial"');
  });
});
