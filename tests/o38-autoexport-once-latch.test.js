/**
 * O-38: модульный латч автоэкспорта — переживает resetConversationState.
 *
 * Дефект (живой лог 2026-09-20): SPA-возврат в уже экспортированный чат qwen
 * давал повторный файр (файл qwen-7fec9bd3-2026-09-20_11-29.txt) через 5с
 * после первого. Корень: resetConversationState() сбрасывает autoExportFired
 * и sessionFiredCache для целевого convId (D14: «новый вход = один новый fired»),
 * но латч должен переживать SPA-возврат в тот же чат.
 *
 * Фикс: модульный латч aiCmAutoExportFiredOnce (state.js) — keyed site|convId,
 * устанавливается в doAutoExportDownload, проверяется в maybeAutoExport.
 * НЕ сбрасывается в resetConversationState (widget.js о нём не знает).
 * F5/новый instance — пуст (прежнее поведение).
 *
 * Правило R-D (каждый путь записи базы + точка выхода):
 *   D (defect) — воспроизведение: fire → reset → fire → reset → возврат = skip already-fired
 *   R (regression) — шесть платформ байтово прежние (гейт/латч/имя не меняются);
 *                    F5 (новый instance) — латч пуст, первый файр штатный.
 *   Gate pin — shouldSkipAutoExport получает fired=true из once-латча.
 */

const path = require('path');

// ===== Песочница state.js (общий скоуп контент-скрипта) =====
function buildSandbox() {
  const state = require('../core/state.ts');
  const pipeline = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.ts');

  // Сброс состояния песочницы
  state.autoExportFired = {};
  state.aiCmAutoExportFiredOnce = Object.create(null);
  state.autoExportSettings = { enabled: true, pct: 90, fmt: 'txt' };
  state.autoExportLastConvId = '';
  state.autoExportLastPct = -1;

  return { state, pipeline };
}

// ===== D: воспроизведение дефекта — SPA-возврат в уже экспортированный чат =====
describe('O-38 D: SPA-возврат в экспортированный чат — skip already-fired', () => {
  test('qwen: fire → reset → fire того же convId — второй файр заблокирован', () => {
    const { state, pipeline } = buildSandbox();
    const site = 'qwen';
    const cid = '7fec9bd3';

    // Первый файр штатный (порог превышен, база готова)
    const v1 = pipeline.shouldSkipAutoExport({
      enabled: true, percentage: 21.4, threshold: 1,
      baseComplete: false, baseSeen: false, loaderRunning: false,
      fired: false, isGemini: false,
      domBaseTrusted: true, site: site
    });
    expect(v1.skip).toBe(false);

    // Устанавливаем все три латча (как doAutoExportDownload)
    pipeline.markAutoExportFired(state.autoExportFired, site, cid);
    state.aiCmAutoExportFiredOnce[site + '|' + cid] = 1;

    // resetConversationState (widget.js) сбрасывает autoExportFired и session-латч
    // НО НЕ ТРОГАЕТ aiCmAutoExportFiredOnce
    pipeline.resetAutoExportFired(state.autoExportFired, site, cid);
    // sessionFiredCache.remove() тоже сбрасывается (имитация)

    expect(pipeline.getAutoExportFired(state.autoExportFired, site, cid)).toBe(false);

    // SPA-возврат: гейт проверяет все три латча
    const firedCheck = pipeline.getAutoExportFired(state.autoExportFired, site, cid) ||
      (state.aiCmAutoExportFiredOnce && state.aiCmAutoExportFiredOnce[site + '|' + cid] === 1);
    expect(firedCheck).toBe(true);

    const v2 = pipeline.shouldSkipAutoExport({
      enabled: true, percentage: 21.4, threshold: 1,
      baseComplete: false, baseSeen: false, loaderRunning: false,
      fired: firedCheck, isGemini: false,
      domBaseTrusted: true, site: site
    });
    expect(v2.skip).toBe(true);
    expect(v2.reason).toBe('already-fired');
  });

  test('qwen: двойной reset → возврат — латч survives оба reset', () => {
    const { state, pipeline } = buildSandbox();
    const site = 'qwen';
    const cid = '7fec9bd3';

    // Первый файр
    pipeline.markAutoExportFired(state.autoExportFired, site, cid);
    state.aiCmAutoExportFiredOnce[site + '|' + cid] = 1;

    // Первый reset (SPA уход)
    pipeline.resetAutoExportFired(state.autoExportFired, site, cid);

    // Второй файр другого чата
    const cid2 = 'f5a9eb94';
    pipeline.markAutoExportFired(state.autoExportFired, site, cid2);
    state.aiCmAutoExportFiredOnce[site + '|' + cid2] = 1;

    // Второй reset (SPA возврат к первому чату)
    pipeline.resetAutoExportFired(state.autoExportFired, site, cid2);

    // Проверка: первый чат всё ещё заблокирован
    const fired1 = pipeline.getAutoExportFired(state.autoExportFired, site, cid) ||
      (state.aiCmAutoExportFiredOnce && state.aiCmAutoExportFiredOnce[site + '|' + cid] === 1);
    expect(fired1).toBe(true);

    // Второй чат тоже заблокирован
    const fired2 = pipeline.getAutoExportFired(state.autoExportFired, site, cid2) ||
      (state.aiCmAutoExportFiredOnce && state.aiCmAutoExportFiredOnce[site + '|' + cid2] === 1);
    expect(fired2).toBe(true);
  });
});

// ===== R: регресс — шесть платформ байтово прежние =====
describe('O-38 R: регресс — шесть платформ', () => {
  const sites = ['chatgpt', 'gemini', 'deepseek', 'google_search', 'claude', 'perplexity'];

  test.each(sites)('%s: первый файр — skip=false, после fire — skip=true (already-fired)', (site) => {
    const { state, pipeline } = buildSandbox();
    const cid = site === 'google_search' ? 'thread-abc' : 'conv-123';

    // До файра
    const v1 = pipeline.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: false, isGemini: site === 'gemini', site: site
    });
    expect(v1.skip).toBe(false);

    // Файр + once-латч
    pipeline.markAutoExportFired(state.autoExportFired, site, cid);
    state.aiCmAutoExportFiredOnce[site + '|' + cid] = 1;

    const firedCheck = pipeline.getAutoExportFired(state.autoExportFired, site, cid) ||
      (state.aiCmAutoExportFiredOnce && state.aiCmAutoExportFiredOnce[site + '|' + cid] === 1);

    const v2 = pipeline.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: firedCheck, isGemini: site === 'gemini', site: site
    });
    expect(v2.skip).toBe(true);
    expect(v2.reason).toBe('already-fired');
  });

  test.each(sites)('%s: изоляция по сайту — латч одного сайта не блокирует другой', (site) => {
    const { state, pipeline } = buildSandbox();
    const cid = 'same-id-123';

    pipeline.markAutoExportFired(state.autoExportFired, site, cid);
    state.aiCmAutoExportFiredOnce[site + '|' + cid] = 1;

    // Другой сайт с тем же convId — НЕ заблокирован
    const otherSite = site === 'chatgpt' ? 'claude' : 'chatgpt';
    const firedOther = pipeline.getAutoExportFired(state.autoExportFired, otherSite, cid) ||
      (state.aiCmAutoExportFiredOnce && state.aiCmAutoExportFiredOnce[otherSite + '|' + cid] === 1);
    expect(firedOther).toBe(false);
  });

  test.each(sites)('%s: F5 (новый instance) — once-латч пуст, первый файр штатный', (site) => {
    // Эмуляция F5: новый instance state.js — aiCmAutoExportFiredOnce = Object.create(null)
    const { state, pipeline } = buildSandbox();
    const cid = site === 'google_search' ? 'thread-xyz' : 'conv-f5';

    // Новый instance — латч пуст
    expect(Object.keys(state.aiCmAutoExportFiredOnce).length).toBe(0);

    const v = pipeline.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: false, isGemini: site === 'gemini', site: site
    });
    expect(v.skip).toBe(false);
  });
});

// ===== Gate pin: shouldSkipAutoExport получает fired из once-латча =====
describe('O-38 Gate: shouldSkipAutoExport fired из once-латча', () => {
  test('once-латч = 1, autoExportFired пуст → fired=true, reason=already-fired', () => {
    const pipeline = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.ts');
    const onceLatch = Object.create(null);
    onceLatch['qwen|7fec9bd3'] = 1;

    // fired = false (autoExportFired пуст) + once-латч = true
    const fired = false || (onceLatch['qwen|7fec9bd3'] === 1);
    expect(fired).toBe(true);

    const v = pipeline.shouldSkipAutoExport({
      enabled: true, percentage: 21.4, threshold: 1,
      baseComplete: false, baseSeen: false, loaderRunning: false,
      fired: fired, isGemini: false,
      domBaseTrusted: true, site: 'qwen'
    });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('already-fired');
  });

  test('once-латч пуст, autoExportFired пуст → fired=false, skip=false', () => {
    const pipeline = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.ts');
    const onceLatch = Object.create(null);

    const fired = false || (onceLatch['qwen|new-conv'] === 1);
    expect(fired).toBe(false);

    const v = pipeline.shouldSkipAutoExport({
      enabled: true, percentage: 21.4, threshold: 1,
      baseComplete: false, baseSeen: false, loaderRunning: false,
      fired: fired, isGemini: false,
      domBaseTrusted: true, site: 'qwen'
    });
    expect(v.skip).toBe(false);
  });
});

// ===== Пин порядка: resetConversationState НЕ трогает once-латч =====
describe('O-38: resetConversationState НЕ сбрасывает once-латч', () => {
  test('widget.js resetAutoExportFired — autoExportFired пуст, once-латч жив', () => {
    const { state, pipeline } = buildSandbox();
    const site = 'qwen';
    const cid = '7fec9bd3';

    // Устанавливаем оба латча
    pipeline.markAutoExportFired(state.autoExportFired, site, cid);
    state.aiCmAutoExportFiredOnce[site + '|' + cid] = 1;

    // Имитация resetConversationState (widget.js v82 D14)
    pipeline.resetAutoExportFired(state.autoExportFired, site, cid);

    // autoExportFired сброшен
    expect(pipeline.getAutoExportFired(state.autoExportFired, site, cid)).toBe(false);
    // once-латч жив
    expect(state.aiCmAutoExportFiredOnce[site + '|' + cid]).toBe(1);
  });
});

// ===== O-38 (3): РЕАЛЬНЫЙ D14-блок core/widget.ts — SPA-вход в экспортированный чат =====
// Дефект (Phase 3): resetConversationState() снимал латчи для ЛЮБОГО SPA-входа, включая
// возврат в уже экспортированный чат → повторный файл того же разговора. Гейт выше
// (once-латч) спасал не всегда: латч L1/session снимался ДО гейта, а diag/иные читатели
// видят именно autoExportFired. Теперь D14 не снимает латчи, если once-латч site|convId
// взведён (тот же признак, что и у aiCmSiteConvFired в core/content.js).
describe('O-38 (3): SPA-переход в тот же экспортированный чат — второй файр запрещён', () => {
  const { moduleSource } = require('./helpers/content-source.js');
  const WIDGET_SRC = moduleSource('core/widget.ts');
  const D14_START = "var cidD14 = getCurrentConvId() || '';";
  const D14_END = '} catch (eD14c) { }';
  const CONTENT_SRC = moduleSource('core/content.js');

  // Реальный aiCmSiteConvFired() из core/content.js — единственный читатель once-латча,
  // который вызывает D14 (имя латча в resetConversationState не появляется: инвариант O-43).
  function fnDecl(src, name) {
    const start = src.indexOf('function ' + name + '(');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced declaration: ' + name);
  }

  const SITE_CONV_FIRED_SRC = fnDecl(CONTENT_SRC, 'aiCmSiteConvFired');

  // Срез тела `try { … } catch (eD14c) { }` из настоящего resetConversationState.
  function d14Source() {
    const i = WIDGET_SRC.indexOf(D14_START);
    expect(i).toBeGreaterThan(-1);
    const j = WIDGET_SRC.indexOf(D14_END, i);
    expect(j).toBeGreaterThan(i);
    // `try {` восстанавливаем сами: срез начинается с тела try, а кончается его catch.
    return 'try {\n' + WIDGET_SRC.slice(i, j + D14_END.length);
  }

  function makeCtx(state, pipeline, cid, overrides) {
    const ctx = {
      getCurrentConvId: function () { return cid; },
      currentAdapter: { siteName: 'qwen' },
      AiCmExportEmitPipeline: pipeline,
      window: { AiCmExportEmitPipeline: pipeline },
      autoExportFired: state.autoExportFired,
      aiCmAutoExportFiredOnce: state.aiCmAutoExportFiredOnce,
      sessionFiredCache: {},
      latchRemoveCalls: [],
      logs: [],
      aiCmLatchRemove: function (site, conv) { ctx.latchRemoveCalls.push(site + '|' + conv); },
      debugLog: function (lvl, msg) { ctx.logs.push(msg); }
    };
    return Object.assign(ctx, overrides || {});
  }

  function runD14(ctx) {
    const fn = new Function('ctx', 'with (ctx) { var aiCmSiteConvFired = ' + SITE_CONV_FIRED_SRC + ';\n' + d14Source() + ' }');
    fn(ctx);
    return ctx;
  }

  test('уже экспортирован: L1 + session-латч переживают SPA-вход, гейт → already-fired', () => {
    const { state, pipeline } = buildSandbox();
    const site = 'qwen';
    const cid = '7fec9bd3';

    // Первый файл (doAutoExportDownload): взводим L1-латч и once-латч
    pipeline.markAutoExportFired(state.autoExportFired, site, cid);
    state.aiCmAutoExportFiredOnce[site + '|' + cid] = 1;

    const ctx = makeCtx(state, pipeline, cid);
    const sessionKey = pipeline.firedSessionKey(site, cid);
    ctx.sessionFiredCache[sessionKey] = 1;

    runD14(ctx); // SPA-переход в ТОТ ЖЕ чат

    // латчи НЕ сняты (до фикса эти три ожидания падали)
    expect(pipeline.getAutoExportFired(state.autoExportFired, site, cid)).toBe(true);
    expect(state.aiCmAutoExportFiredOnce[site + '|' + cid]).toBe(1);
    expect(ctx.sessionFiredCache[sessionKey]).toBe(1);
    expect(ctx.latchRemoveCalls).toEqual([]);
    expect(ctx.logs.join('\n')).toContain('latch kept reason=already-exported');

    // повторного файра быть не может: гейт видит взведённый латч
    const fired = pipeline.getAutoExportFired(state.autoExportFired, site, cid) ||
      (state.aiCmAutoExportFiredOnce[site + '|' + cid] === 1);
    const v = pipeline.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: fired, isGemini: false, domBaseTrusted: true, site: site
    });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('already-fired');
  });

  test('двойной SPA-вход подряд — латчи не снимаются ни на одном входе', () => {
    const { state, pipeline } = buildSandbox();
    const site = 'qwen';
    const cid = '7fec9bd3';

    pipeline.markAutoExportFired(state.autoExportFired, site, cid);
    state.aiCmAutoExportFiredOnce[site + '|' + cid] = 1;

    const ctx = makeCtx(state, pipeline, cid);
    runD14(ctx);
    runD14(ctx);

    expect(pipeline.getAutoExportFired(state.autoExportFired, site, cid)).toBe(true);
    expect(ctx.latchRemoveCalls).toEqual([]);
  });

  test('неэкспортированный чат: прежняя семантика D14 сохранена — латчи снимаются', () => {
    const { state, pipeline } = buildSandbox();
    const site = 'qwen';
    const cid = 'conv-new';
    const other = 'conv-prev';

    // взведён латч ДРУГОГО чата — его трогать нельзя
    pipeline.markAutoExportFired(state.autoExportFired, site, other);
    state.aiCmAutoExportFiredOnce[site + '|' + other] = 1;
    // целевой чат: in-memory латч выставлен (эмулируем состояние до сброса)
    pipeline.markAutoExportFired(state.autoExportFired, site, cid);

    const ctx = makeCtx(state, pipeline, cid);
    const sessionKey = pipeline.firedSessionKey(site, cid);
    ctx.sessionFiredCache[sessionKey] = 1;

    runD14(ctx); // SPA-вход в чат, который ещё НЕ экспортировали

    expect(pipeline.getAutoExportFired(state.autoExportFired, site, cid)).toBe(false);
    expect(ctx.sessionFiredCache[sessionKey]).toBeUndefined();
    expect(ctx.latchRemoveCalls).toEqual([site + '|' + cid]);
    // чужой (уже экспортированный) чат не тронут
    expect(pipeline.getAutoExportFired(state.autoExportFired, site, other)).toBe(true);
  });

  test('source-pin: D14 сверяется с once-латчём и сохраняет пином m13 строку сброса', () => {
    const src = d14Source();
    // resetConversationState НЕ упоминает имя латча (инвариант O-43: сбросом не снимается),
    // признак приходит из aiCmSiteConvFired() (core/content.js) под typeof-гардом.
    expect(src).not.toContain('aiCmAutoExportFiredOnce');
    expect(src).toContain('aiCmSiteConvFired');
    expect(src).toContain('latch kept reason=already-exported');
    expect(src).toContain('P14.resetAutoExportFired(autoExportFired, siteD14, cidD14);');
    // хелпер — настоящий: единственный читатель once-латча по site|convId
    expect(SITE_CONV_FIRED_SRC).toContain("aiCmAutoExportFiredOnce[site + '|' + cid] === 1");
  });
});
