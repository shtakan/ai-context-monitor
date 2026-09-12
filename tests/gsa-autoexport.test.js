/**
 * v1.18 (F1–F6): автоэкспорт по порогу для Google Search AI (site=google_search).
 *
 * Фича формализована на ДВА сайта — Gemini (прежний путь байтово) и GSA:
 *   F1 проводка полноты: вердикт probe-классификатора (classifyFolwrContinuation,
 *      complete=true) уходит в baseComplete ОДНОЙ точкой (buildDetail.historyComplete →
 *      content.js `const newBaseComplete = !!detail.historyComplete;`), гейт читает его;
 *      дублирующего классификатора в content.js нет;
 *   F2 latch = site + convId, для GSA convId = threadId; SPA-возврат латч НЕ снимает
 *      (перехватчик эмитит кэш треда с historyComplete=true — второго файла быть не должно);
 *   F3 подпись секции options.html + общий селектор формата (txt/md/json);
 *   F4 имя файла GSA — по шаблону РУЧНОГО экспорта (ai-context-monitor-<site>-<model>-<stamp>),
 *      [LOW CONFIDENCE]_ только при baseComplete=0;
 *   F5 логи [AI CM][auto-export] site=google_search с причинами fired / skip reason=…
 *      (not-complete | probe-running | below-threshold | already-fired);
 *   F7 модель снапшота GSA в имени файла (реальная модель: сеть → DOM → дефолт сайта
 *      «Gemini (Search AI)»), фолбэк 'model' — только при реально пустой модели;
 *      заполнение lastSnapshotModelName для GSA — ОДНА точка (resolveCurrentModel).
 *
 * НЕ ТРОГАЕТСЯ: resolveExportSource и reason 'non-gemini', T1-архивы и их гейты, H9/H10,
 * saveFloor/selfHealFloor, классификатор GSA и селекторы GSA, путь автоэкспорта Gemini.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const OPTIONS_JS = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');

// Рез по балансу фигурных скобок (как в tests/archive/archive-export-union.test.js).
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
const TID = 'SYNTHETIC-THREAD-1';

// =====================================================================================
// F1: проводка полноты (probe-вердикт → baseComplete → гейт), одна точка
// =====================================================================================
describe('F1: probe-полнота GSA доходит до гейта одной точкой', () => {
  test('intercept: probe complete=true → applyTurns(..., true) → historyComplete снимка', () => {
    // единственный путь вердикта: finish(complete=true) применяет базу с historyComplete=true
    expect(INTERCEPT).toContain('applyTurns(merged.length > 0 ? merged : lastFullTurns, tid, true);');
    expect(INTERCEPT).toContain('historyComplete: historyComplete !== false');
    // probe-путь не заводит второго вердикта: классификатор вызывается только в describeFolwrPage
    expect(INTERCEPT).toContain('pageInfo.cls.complete');
    expect(INTERCEPT).toContain('classifyFolwrContinuation');
  });

  test('content.js: baseComplete из detail — единственное присваивание, классификатор не дублируется', () => {
    expect(CONTENT).toContain('const newBaseComplete = !!detail.historyComplete;');
    // флага-дубликата GSA-полноты в content.js нет
    expect(CONTENT).not.toContain('classifyFolwrContinuation');
    expect(CONTENT).not.toContain('pageInfo.cls.complete');
    // тот же baseComplete читает гейт автоэкспорта
    expect(CONTENT).toContain('baseComplete: baseComplete === true,');
    expect(CONTENT).toContain('shouldSkipAutoExport({');
  });

  test('probe-running: состояние probe уходит наружу CustomEvent-ом и уточняет причину skip', () => {
    expect(INTERCEPT).toContain('function emitProbeState(');
    expect(INTERCEPT).toContain("new CustomEvent('ai-cm-gsa-probe-state'");
    expect(INTERCEPT).toContain('emitProbeState(true, tid);');
    expect(INTERCEPT).toContain('emitProbeState(false, tid);');
    expect(CONTENT).toContain("window.addEventListener('ai-cm-gsa-probe-state'");
    expect(CONTENT).toContain('P.notCompleteReason({ site: siteName, probeRunning: aiCmGsaProbeRunningFor(cid) })');
  });
});

// =====================================================================================
// F2: convId = threadId (GSA) и латч site+convId
// =====================================================================================
describe('F2: convId автоэкспорта GSA и латч site+convId', () => {
  test('resolveAutoExportConvId: URL-id приоритетен; GSA → threadId; прочие без id → ""', () => {
    expect(P.resolveAutoExportConvId('gemini', 'url-id', 'tid-1')).toBe('url-id');
    expect(P.resolveAutoExportConvId(GSA, '', TID)).toBe(TID);
    expect(P.resolveAutoExportConvId(GSA, null, null)).toBe('');
    expect(P.resolveAutoExportConvId('claude', '', 'tid-1')).toBe(''); // id не выдумываем
  });

  test('ключ латча включает site: GSA и Gemini с одним id не блокируют друг друга', () => {
    const store = {};
    P.markAutoExportFired(store, GSA, TID);
    expect(P.getAutoExportFired(store, GSA, TID)).toBe(true);
    expect(P.getAutoExportFired(store, 'gemini', TID)).toBe(false);
    expect(P.latchKey(GSA, TID)).toBe(GSA + '|' + TID);
    expect(P.latchKey(GSA, TID)).not.toBe(P.latchKey('gemini', TID));
    // разные треды GSA изолированы (раньше все делили пустой convId)
    expect(P.getAutoExportFired(store, GSA, 'other-thread')).toBe(false);
  });

  test('content.js: maybeAutoExport берёт cid через aiCmAutoExportConvId (GSA → threadId)', () => {
    const body = fnDecl(CONTENT, 'maybeAutoExport');
    expect(body).toContain('var cid = aiCmAutoExportConvId();');
    const helper = fnDecl(CONTENT, 'aiCmAutoExportConvId');
    expect(helper).toContain('P.resolveAutoExportConvId(site, urlCid, lastThreadId || \'\')');
    expect(helper).not.toContain('chrome.');
  });

  test('SPA-возврат с уже снятым латчем: GSA-латч жив → повторного fired нет', () => {
    const resetBody = fnDecl(CONTENT, 'resetConversationState');
    // D14-сброс латча для GSA отключён: сначала ветка google_search, только потом сброс
    const iGsa = resetBody.indexOf("siteD14 === 'google_search'");
    const iReset = resetBody.indexOf('P14.resetAutoExportFired(autoExportFired, siteD14, cidD14);');
    expect(iGsa).toBeGreaterThan(-1);
    expect(iReset).toBeGreaterThan(iGsa);
    expect(resetBody).toContain('latch kept reason=spa-entry');
    // поведенчески: латч остался → гейт даёт already-fired
    const store = {};
    P.markAutoExportFired(store, GSA, TID);
    const v = P.shouldSkipAutoExport(gsaState({
      fired: P.getAutoExportFired(store, GSA, TID)
    }));
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('already-fired');
  });
});

// =====================================================================================
// F6: гейты GSA (тот же чистый shouldSkipAutoExport, что у Gemini)
// =====================================================================================
function gsaState(over) {
  return Object.assign({
    enabled: true, percentage: 95, threshold: 90,
    baseComplete: true, baseSeen: true, loaderRunning: false,
    fired: false, isGemini: false
  }, over || {});
}

describe('F6: гейты автоэкспорта GSA', () => {
  test('неполная база (baseComplete=0) → skip reason=not-complete, латч не ставится', () => {
    const v = P.shouldSkipAutoExport(gsaState({ baseComplete: false }));
    expect(v).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('полная база и pct ≥ порога → fired (skip=false), затем уже-fired по латчу', () => {
    const store = {};
    const first = P.shouldSkipAutoExport(gsaState({ fired: P.getAutoExportFired(store, GSA, TID) }));
    expect(first).toEqual({ skip: false, reason: null, resetFired: false });
    // fired состоялся (латч site+convId)
    P.markAutoExportFired(store, GSA, TID);
    const second = P.shouldSkipAutoExport(gsaState({ fired: P.getAutoExportFired(store, GSA, TID) }));
    expect(second.skip).toBe(true);
    expect(second.reason).toBe('already-fired'); // повторный fired в том же разговоре запрещён
  });

  test('ниже порога, но не ниже −10 п.п. → skip reason=below-threshold', () => {
    const v = P.shouldSkipAutoExport(gsaState({ percentage: 85, threshold: 90 }));
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('below-threshold');
    expect(v.resetFired).toBe(false);
  });

  test('ниже порога на 10 п.п. и более → гистерезис со сбросом латча', () => {
    const v = P.shouldSkipAutoExport(gsaState({ percentage: 79, threshold: 90, fired: true }));
    expect(v.reason).toBe('below-threshold-hysteresis');
    expect(v.resetFired).toBe(true);
  });

  test('notCompleteReason: probe в полёте → probe-running, иначе not-complete', () => {
    expect(P.notCompleteReason({ site: GSA, probeRunning: true })).toBe('probe-running');
    expect(P.notCompleteReason({ site: GSA, probeRunning: false })).toBe('not-complete');
    expect(P.notCompleteReason({ site: 'gemini', probeRunning: true })).toBe('not-complete');
    expect(P.notCompleteReason(null)).toBe('not-complete');
  });
});

// =====================================================================================
// F4: имя файла GSA (шаблон ручного экспорта) и форматы селектора
// =====================================================================================
describe('F4: имя файла автоэкспорта GSA и форматы txt/md/json', () => {
  afterEach(() => jest.restoreAllMocks());

  function mockNow() {
    jest.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026);
    jest.spyOn(Date.prototype, 'getMonth').mockReturnValue(7); // август
    jest.spyOn(Date.prototype, 'getDate').mockReturnValue(31);
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
    jest.spyOn(Date.prototype, 'getMinutes').mockReturnValue(5);
  }

  test('шаблон ручного экспорта: ai-context-monitor-google_search-<model>-<stamp>.<fmt>', () => {
    mockNow();
    expect(P.buildGsaExportFileName(GSA, 'Gemini 2.5 Flash', false, 'txt'))
      .toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.txt');
    expect(P.buildGsaExportFileName(GSA, 'Gemini 2.5 Flash', false, 'md'))
      .toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.md');
    expect(P.buildGsaExportFileName(GSA, 'Gemini 2.5 Flash', false, 'json'))
      .toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.json');
  });

  test('[LOW CONFIDENCE]_ только при baseComplete=0 (isLowConfidence=true)', () => {
    mockNow();
    expect(P.buildGsaExportFileName(GSA, 'm', true, 'txt')).toMatch(/^\[LOW CONFIDENCE\]_ai-context-monitor-google_search-/);
    expect(P.buildGsaExportFileName(GSA, 'm', false, 'txt')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('пустая модель → сегмент model (как в ручном buildFileName)', () => {
    mockNow();
    expect(P.buildGsaExportFileName(GSA, '', false, 'txt'))
      .toBe('ai-context-monitor-google_search-model-2026-08-31-09-05.txt');
  });

  test('общий buildExportFileName тоже знает json-расширение', () => {
    expect(P.buildExportFileName('gemini', 'cid', 'threshold', false, 'json')).toMatch(/\.json$/);
    expect(P.buildExportFileName(GSA, 'cid', 'threshold', false, 'json')).toMatch(/\.json$/);
  });

  test('buildJsonFromHistory — та же схема, что у ручной кнопки .json', () => {
    const parsed = JSON.parse(Builders.buildJsonFromHistory({
      model: 'Gemini 2.5 Flash', tokens: 10, limit: 0, percent: 95,
      messages: [{ role: 'user', text: 'вопрос' }]
    }, 'Google Search AI'));
    expect(parsed.platform).toBe('Google Search AI');
    expect(parsed.model).toBe('Gemini 2.5 Flash');
    expect(parsed.tokens).toBe(10);
    expect(parsed.percent).toBe(95);
    expect(parsed.messages).toEqual([{ role: 'user', text: 'вопрос' }]);
    expect(typeof parsed.exportedAt).toBe('string');
  });
});

// ——— реальный doAutoExportDownload (ISOLATED) для GSA: файл, латч, логи, форматы ———
describe('F4/F5: doAutoExportDownload GSA (реальный код)', () => {
  const SCOPE = 'with (ctx) { ' +
    fnDecl(CONTENT, 'aiCmExportBaseSource') + '\n' +
    fnDecl(CONTENT, 'doAutoExportDownload') + '\n' +
    ' return { dl: doAutoExportDownload }; }';
  const makeContent = new Function('ctx', SCOPE);

  const MSGS = [
    { role: 'user', text: 'Сколько будет два плюс два?' },
    { role: 'assistant', text: 'Четыре.' }
  ];

  function gsaCtx(fmt, over) {
    const downloads = [];
    const logs = [];
    const ctx = {
      currentAdapter: { siteName: GSA },
      autoExportSettings: { fmt: fmt, enabled: true },
      aiCmLowConfidenceByConv: {},
      baseSeen: true,
      baseComplete: true,
      lastBaseTexts: MSGS.map((m) => m.text),
      lastResolvedModelId: 'gemini-2.5-flash',
      lastSnapshotModelName: 'Gemini 2.5 Flash',
      maxTokenCount: 1000,
      sessionFiredCache: {},
      autoExportFired: {},
      aiCmCursorLiveByConv: {},
      aiCmDumpTurnsSnapshot: function () { },
      aiCmCancelDeferredHistWrite: function () { },
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      console: { error: function () { } },
      ModelConfig: { getModel: function () { return { name: 'Gemini 2.5 Flash' }; } },
      chrome: { storage: { session: { set: function () { }, remove: function () { } } } },
      buildHistoryMessages: function () { return MSGS.slice(); },
      aiCmGeminiTurnsSnapshotSync: function () { return null; },
      window: {
        AiCmExportBuilders: {
          buildTxtFromHistory: function (hist) { return hist.messages.map((m) => m.role + '::' + m.text).join('\n'); },
          buildMdFromHistory: function (hist) { return hist.messages.map((m) => m.text).join('\n'); },
          buildJsonFromHistory: Builders.buildJsonFromHistory,
          downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); }
        },
        AiCmExportEmitPipeline: P
      }
    };
    Object.assign(ctx, over || {});
    return { ctx: ctx, downloads: downloads, logs: logs, api: makeContent(ctx) };
  }

  test('txt: файл по ручному шаблону, без [LOW CONFIDENCE]_, латч site+threadId, tagged-лог fired', () => {
    const h = gsaCtx('txt');
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads.length).toBe(1);
    const file = h.downloads[0].file;
    expect(file).toMatch(/^ai-context-monitor-google_search-Gemini-2\.5-Flash-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/);
    expect(file).not.toMatch(/^\[LOW CONFIDENCE\]_/);
    expect(h.downloads[0].content.charAt(0)).toBe('\uFEFF'); // txt эталон — с BOM
    expect(h.downloads[0].mime).toBe('text/plain;charset=utf-8');
    expect(P.getAutoExportFired(h.ctx.autoExportFired, GSA, TID)).toBe(true);
    const joined = h.logs.join('\n');
    expect(joined).toContain('[AI CM][auto-export] fired convId=' + TID); // прежняя строка не тронута
    expect(joined).toContain('[AI CM][auto-export] site=google_search fired convId=' + TID);
  });

  test('md: расширение .md и mime text/markdown', () => {
    const h = gsaCtx('md');
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads[0].file).toMatch(/\.md$/);
    expect(h.downloads[0].mime).toBe('text/markdown');
  });

  test('json: расширение .json, валидный json, mime application/json', () => {
    const h = gsaCtx('json');
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads.length).toBe(1);
    expect(h.downloads[0].file).toMatch(/\.json$/);
    expect(h.downloads[0].mime).toBe('application/json');
    const parsed = JSON.parse(h.downloads[0].content);
    expect(parsed.messages.length).toBe(2);
    expect(parsed.platform).toBe(GSA); // платформа = siteName текущего адаптера
  });

  test('baseComplete=0 → префикс [LOW CONFIDENCE]_ (маркировка честности)', () => {
    const h = gsaCtx('txt', { baseComplete: false });
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads.length).toBe(1);
    expect(h.downloads[0].file).toMatch(/^\[LOW CONFIDENCE\]_ai-context-monitor-google_search-/);
    expect(h.logs.join('\n')).toContain('lowConfidence=1');
  });

  test('Gemini-путь не тронут: имя файла по-прежнему service-convId (байтово)', () => {
    const h = gsaCtx('txt', {
      currentAdapter: { siteName: 'gemini' },
      aiCmLowConfidenceByConv: {}
    });
    h.api.dl('0362260d', 95, 'threshold');
    expect(h.downloads[0].file).toMatch(/^gemini-0362260d-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
    expect(h.logs.join('\n')).not.toContain('site=google_search');
  });

  // ——— F7: в имени файла GSA — реальная модель снапшота, а не фолбэк 'model' ———
  test('F7: модель снапшота GSA в имени файла (Gemini (Search AI) → Gemini-Search-AI)', () => {
    const h = gsaCtx('txt', { lastSnapshotModelName: 'Gemini (Search AI)' });
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads[0].file)
      .toMatch(/^ai-context-monitor-google_search-Gemini-Search-AI-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/);
    expect(h.downloads[0].file).not.toContain('-model-');
    // tagged-строка fired несёт модель
    expect(h.logs.join('\n')).toContain(' model=Gemini (Search AI)');
  });

  test('F7: фолбэк model — только при реально пустой модели снапшота', () => {
    const h = gsaCtx('txt', { lastSnapshotModelName: '' });
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads[0].file)
      .toMatch(/^ai-context-monitor-google_search-model-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/);
    expect(h.logs.join('\n')).toContain(' model= lowConfidence=');
  });

  test('F7: модель GSA не протекает в Gemini-путь (имя файла байтово прежнее)', () => {
    const h = gsaCtx('txt', {
      currentAdapter: { siteName: 'gemini' },
      lastSnapshotModelName: 'Gemini (Search AI)'
    });
    h.api.dl('0362260d', 95, 'threshold');
    expect(h.downloads[0].file).toMatch(/^gemini-0362260d-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
  });
});

// =====================================================================================
// F7: модель снапшота для site=google_search — ОДНА точка (resolveCurrentModel)
// =====================================================================================
describe('F7: заполнение модели снапшота GSA (реальный resolveCurrentModel)', () => {
  const ModelConfig = require('../utils/model-config.js');
  const SCOPE = 'with (ctx) { ' + fnDecl(CONTENT, 'resolveCurrentModel') +
    ' return { run: resolveCurrentModel }; }';
  const makeResolve = new Function('ctx', SCOPE);

  function modelCtx(over) {
    const ctx = {
      ModelConfig: ModelConfig,
      currentAdapter: { siteName: GSA, detectModel: function () { return ''; } },
      detectedModelSlug: '',
      popupModelId: null,
      popupRawModel: '',
      geminiUiModelByFamily: {},
      lastResolvedModelId: null,
      lastModelSourceSig: '',
      lastSnapshotModelName: '',
      debugLog: function () { },
      console: { log: function () { } },
      window: { location: { hostname: 'www.google.com' } }
    };
    Object.assign(ctx, over || {});
    return ctx;
  }

  test('GSA без сетевого slug: модель = дефолт сайта (та же, что у бейджа), не пусто', () => {
    const ctx = modelCtx({});
    expect(makeResolve(ctx).run()).toBe('gemini-search-default');
    expect(ctx.lastSnapshotModelName).toBe('Gemini (Search AI)');
  });

  test('GSA со сетевым slug: приоритет у сети (поведение v47 сохранено)', () => {
    const ctx = modelCtx({ detectedModelSlug: 'gemini-2.5-flash' });
    makeResolve(ctx).run();
    expect(ctx.lastSnapshotModelName).toBe('Gemini 2.5 Flash');
  });

  test('GSA + оверрайд попапа: имя модели снапшота совпадает с моделью бейджа', () => {
    const ctx = modelCtx({ popupModelId: 'gemini-2.5-pro' });
    expect(makeResolve(ctx).run()).toBe('gemini-2.5-pro');
    expect(ctx.lastSnapshotModelName).toBe('Gemini 2.5 Pro');
  });

  test('прочие сайты не заполняются: Gemini-путь байтово прежний (пусто)', () => {
    const ctx = modelCtx({
      currentAdapter: { siteName: 'gemini', detectModel: function () { return ''; } }
    });
    makeResolve(ctx).run();
    expect(ctx.lastSnapshotModelName).toBe('');
  });

  test('заполнение — одна точка: дубля модели в doAutoExportDownload нет', () => {
    const body = fnDecl(CONTENT, 'resolveCurrentModel');
    expect(body).toContain("currentAdapter.siteName === 'google_search'");
    expect(body).toContain('lastSnapshotModelName = ModelConfig.getModel(modelId)?.name || modelId;');
    // присваиваний ровно три: сброс при смене чата (v47), slug-ветка (v47), GSA-фолбэк (v1.18 F7)
    expect((CONTENT.match(/^\s*lastSnapshotModelName = /gm) || []).length).toBe(3);
    expect(fnDecl(CONTENT, 'doAutoExportDownload')).not.toContain('lastSnapshotModelName = ModelConfig');
  });
});

// =====================================================================================
// F2/F5/F6: РЕАЛЬНЫЙ maybeAutoExport (ISOLATED) для GSA — cid/вердикт/логи
// =====================================================================================
describe('F2/F5/F6: реальный maybeAutoExport GSA (тихий вызов гейта)', () => {
  const SCOPE = 'with (ctx) { ' +
    fnDecl(CONTENT, 'aiCmAutoExportConvId') + '\n' +
    fnDecl(CONTENT, 'aiCmGsaProbeRunningFor') + '\n' +
    fnDecl(CONTENT, 'aiCmGsaAutoExportSkipLog') + '\n' +
    fnDecl(CONTENT, 'maybeAutoExport') + '\n' +
    ' return { run: maybeAutoExport }; }';
  const makeRun = new Function('ctx', SCOPE);

  function gateCtx(over) {
    const logs = [];
    const fired = [];
    const ctx = {
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
      baseComplete: true,
      baseCount: 4,
      lastThreadId: TID,
      currentAdapter: { siteName: GSA },
      getCurrentConvId: function () { return ''; }, // у GSA URL-id нет
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      // 1:1 с реальной единственной точкой записи файла: латч site+convId
      doAutoExportDownload: function (cid, pct, reason) {
        fired.push({ cid: cid, pct: pct, reason: reason });
        P.markAutoExportFired(ctx.autoExportFired, GSA, cid);
      },
      chrome: { storage: { session: { remove: function () { }, set: function () { } } } },
      window: { AiCmExportEmitPipeline: P }
    };
    Object.assign(ctx, over || {});
    return { ctx: ctx, logs: logs, fired: fired, run: makeRun(ctx).run };
  }

  test('полная база + порог → fired с convId=threadId (GSA), затем already-fired', () => {
    const h = gateCtx({});
    h.run(95);
    expect(h.fired).toEqual([{ cid: TID, pct: 95, reason: 'threshold' }]);
    // повторный вызов в том же разговоре: латч site+threadId запрещает второй fired
    h.run(96);
    expect(h.fired.length).toBe(1);
    const joined = h.logs.join('\n');
    expect(joined).toContain('[AI CM][auto-export] site=google_search skip reason=already-fired convId=' + TID);
  });

  test('baseComplete=0 + probe в полёте → skip probe-running, файла нет', () => {
    const h = gateCtx({
      baseComplete: false,
      aiCmGsaProbeByThread: (function () { const m = {}; m[TID] = 1; return m; })(),
      aiCmGsaProbeRunning: true
    });
    h.run(95);
    expect(h.fired.length).toBe(0);
    expect(h.logs.join('\n')).toContain('[AI CM][auto-export] site=google_search skip reason=probe-running convId=' + TID);
  });

  test('baseComplete=0 без probe → skip not-complete (ярлык не подменяет вердикт)', () => {
    const h = gateCtx({ baseComplete: false });
    h.run(95);
    expect(h.fired.length).toBe(0);
    expect(h.logs.join('\n')).toContain('skip reason=not-complete');
  });

  test('ниже порога → skip below-threshold, файла нет', () => {
    const h = gateCtx({});
    h.run(85);
    expect(h.fired.length).toBe(0);
    expect(h.logs.join('\n')).toContain('[AI CM][auto-export] site=google_search skip reason=below-threshold convId=' + TID);
  });

  test('прочие сайты (Gemini-путь) логи не тегируются site=google_search', () => {
    const h = gateCtx({ currentAdapter: { siteName: 'chatgpt' }, lastThreadId: '', getCurrentConvId: function () { return 'conv-1'; } });
    h.run(85);
    expect(h.fired.length).toBe(0);
    expect(h.logs.join('\n')).not.toContain('site=google_search');
  });
});

// =====================================================================================
// F5: логи (source-level пины строк)
// =====================================================================================
describe('F5: логи автоэкспорта GSA', () => {
  test('skip-лог GSA содержит site=google_search и причину', () => {
    expect(CONTENT).toContain("'[AI CM][auto-export] site=google_search skip reason=' + reason");
    expect(CONTENT).toContain('probeRunning=');
    // общая (Gemini) строка not-complete не изменена
    expect(CONTENT).toContain("'[AI CM][auto-export] skip reason=not-complete convId=' + cid + ' pct=' + percentage");
    expect(CONTENT).toContain("'[AI CM][auto-export] skip reason=already-fired convId=' + cid);");
    expect(CONTENT).toContain("'[AI CM][auto-export] skip reason=below-threshold convId=' + cid + ' pct=' + percentage");
  });

  test('fired-лог GSA содержит site=google_search (общий fired-лог сохранён)', () => {
    expect(CONTENT).toContain("'[AI CM][auto-export] site=google_search fired convId=' + cid");
    expect(CONTENT).toContain("'[AI CM][auto-export] fired convId=' + cid + ' pct=' + percentage + ' file=' + file");
  });
});

// =====================================================================================
// F3: UI — подпись секции и общий селектор формата
// =====================================================================================
describe('F3: подпись секции автоэкспорта в options.html', () => {
  test('подпись секции: «Автоэкспорт чатов (Gemini, Google Search AI)»', () => {
    expect(OPTIONS_HTML).toContain('Автоэкспорт чатов (Gemini, Google Search AI)');
    expect(OPTIONS_HTML).not.toContain('Автоэкспорт чата Gemini');
  });

  test('тумблер, порог и селектор формата — общие (одна секция), форматы txt/md/json', () => {
    const iStart = OPTIONS_HTML.indexOf('id="auto-export-section"');
    const iEnd = OPTIONS_HTML.indexOf('id="proactive-section"');
    expect(iStart).toBeGreaterThan(-1);
    expect(iEnd).toBeGreaterThan(iStart);
    const sec = OPTIONS_HTML.slice(iStart, iEnd);
    expect(sec).toContain('id="aiCmAutoExport"');
    expect(sec).toContain('id="aiCmAutoExportPct"');
    expect(sec).toContain('id="aiCmAutoExportFmt"');
    expect(sec).toContain('<option value="txt">txt</option>');
    expect(sec).toContain('<option value="md">md</option>');
    expect(sec).toContain('<option value="json">json</option>');
  });

  test('options.js сохраняет json-формат (нормализация значения)', () => {
    expect(OPTIONS_JS).toContain('function normalizeAutoExportFmt(');
    expect(OPTIONS_JS).toContain("aiCmAutoExportFmt: normalizeAutoExportFmt(autoExportFmtSelect.value)");
    expect(OPTIONS_JS).toContain('normalizeAutoExportFmt(data.aiCmAutoExportFmt)');
  });

  test('content.js читает json из общего селектора формата', () => {
    expect(CONTENT).toContain("autoExportSettings.fmt = (fmtRaw === 'md' || fmtRaw === 'json') ? fmtRaw : 'txt';");
  });
});

// =====================================================================================
// Регрессионный контур: «не трогать» остаётся нетронутым
// =====================================================================================
describe('регрессионный контур v1.18: запрещённые к изменению места', () => {
  test('resolveExportSource и reason non-gemini не тронуты', () => {
    expect(P.resolveExportSource({ isGemini: false })).toEqual({ action: 'local', reason: 'non-gemini' });
    expect(P.resolveExportSource({ isGemini: true, bridge: true, archiveCount: 4, liveCount: 0 }))
      .toEqual({ action: 'block', reason: 'archive-only-base' });
  });

  test('GSA-архив не включён в архивное объединение (Gemini-only)', () => {
    const body = fnDecl(CONTENT, 'aiCmExportBaseSource');
    expect(body).toContain("site !== 'gemini'");
    expect(body).toContain('return null;');
  });

  test('классификатор GSA не изменён (те же kind-вердикты)', () => {
    const { classifyFolwrContinuation } = require('../utils/google-search-folwr-parser');
    expect(classifyFolwrContinuation({ ok: true, status: 200, bodyLength: 30, newTurns: 0, cursor: 'C1', sentCursor: 'C1' }))
      .toMatchObject({ kind: 'cursor-repeat', complete: true, canContinue: false });
    expect(classifyFolwrContinuation({ ok: true, status: 200, bodyLength: 4200, newTurns: 0, cursor: null, sentCursor: 'C1' }))
      .toMatchObject({ kind: 'no-new-turns', complete: true });
  });

  test('H9/H10-гейты и пол (gemini-intercept-logic) не тронуты', () => {
    const Logic = require('../utils/gemini-intercept-logic.js');
    expect(typeof Logic.resolveFloor).toBe('function');
    expect(typeof Logic.shouldSaveFloor).toBe('function');
    expect(Logic.shouldSaveFloor(true, true)).toBe(true);
    expect(Logic.shouldSaveFloor(false, true)).toBe(false);
    // пол НЕ применяется при baseComplete=true (поведение 1:1)
    expect(Logic.resolveFloor(5000, 10, { count: 20, effectiveLen: 9000 }, true))
      .toEqual({ effectiveLen: 5000, floorApplied: false, floorValue: 0 });
    expect(Logic.resolveFloor(5000, 10, { count: 20, effectiveLen: 9000 }, false))
      .toEqual({ effectiveLen: 9000, floorApplied: true, floorValue: 9000 });
  });
});
