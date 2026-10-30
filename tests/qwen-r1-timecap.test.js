/**
 * R1 (v111): мягкий финал пагинации Qwen.
 *
 * Контекст: базовая страница Qwen — 10 последних турнов, старше — только по курсору (O-53).
 * Прогон может закончиться не только честным концом (reason='end'): при исчерпании НАШЕГО
 * страховочного потолка (time-cap/page-cap) или странице без прироста при живом курсоре
 * (no-gain) база остаётся неполной, но продолжать нечем. До R1 любой не-'end' навсегда
 * блокировал автоэкспорт (O-54: not-complete на каждом следующем эмите).
 *
 * Контракт R1: причина классифицируется ТОЛЬКО в core/qwen-pagination.js
 * (SOFT_PARTIAL_REASONS / isSoftPartialReason); дальше по пайплайну идёт булев:
 *   pqFinish → detail.partialSoft → aiCmPartialSoftByConv[chatId] (content.js) →
 *   4-й аргумент aiCmHistoryPaginationIncomplete → historyIncomplete=false в гейте →
 *   lowConfD в doAutoExportDownload → префикс [LOW CONFIDENCE]_.
 * Фатальные причины (error/cursor-loop) и промежуточный in-progress остаются жёсткими:
 * O-54 не ослаблен, экспорт посреди пагинации по-прежнему невозможен.
 *
 * Здесь: truth table, предикат, песочницы реального emitSnapshot/buildSignature/
 * doAutoExportDownload и source-пины всех шести файлов.
 */

const fs = require('fs');
const path = require('path');

const P = require('../core/qwen-pagination.js');
const Gate = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
const PAGINATION_SRC = read('core/qwen-pagination.js');
const INTERCEPT_SRC = read('core/qwen-intercept.js');
const STATE_SRC = read('core/state.js');
const WIDGET_SRC = read('core/widget.js');
const CONTENT_SRC = read('core/content.js');
const MGR_SRC = read('core/export-manager.js');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/qwen-pagination.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('declaration not found: ' + name);
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

const CHAT = 'cda86f26-0155-4243-a134-777d909a936b';

describe('R1: truth table SOFT_PARTIAL_REASONS', function () {
  test('мягкие причины — time-cap/page-cap/no-gain; всё остальное жёсткое', function () {
    expect(P.SOFT_PARTIAL_REASONS).toEqual(['time-cap', 'page-cap', 'no-gain']);
    const soft = ['time-cap', 'page-cap', 'no-gain'];
    const hard = ['end', 'error', 'cursor-loop', 'in-progress', 'no-start', ''];
    soft.forEach(function (reason) {
      expect(P.isSoftPartialReason(reason)).toBe(true);
    });
    hard.forEach(function (reason) {
      expect(P.isSoftPartialReason(reason)).toBe(false);
    });
  });

  test('нет-причина (null/undefined/объект) — не мягкая', function () {
    expect(P.isSoftPartialReason(null)).toBe(false);
    expect(P.isSoftPartialReason(undefined)).toBe(false);
    expect(P.isSoftPartialReason({})).toBe(false);
    expect(P.isSoftPartialReason(0)).toBe(false);
  });

  test('pageStepDecision отдаёт ровно те причины, что классифицируются', function () {
    expect(P.pageStepDecision({ hasCursor: true, pages: 10 }).reason).toBe('page-cap');
    expect(P.pageStepDecision({ hasCursor: true, elapsedMs: 30000 }).reason).toBe('time-cap');
    expect(P.isSoftPartialReason(P.pageStepDecision({ hasCursor: true, pages: 10 }).reason)).toBe(true);
    expect(P.isSoftPartialReason(P.pageStepDecision({ hasCursor: true, elapsedMs: 30000 }).reason)).toBe(true);
    expect(P.isSoftPartialReason(P.pageStepDecision({ hasCursor: false }).reason)).toBe(false);
  });
});

describe('R1: предикат неполноты с 4-м аргументом (core/export-manager.js)', function () {
  const fn = new Function('ctx',
    'with (ctx) { ' + fnDecl(MGR_SRC, 'aiCmHistoryPaginationIncomplete') +
    '\n return aiCmHistoryPaginationIncomplete; }')({});

  test('soft-final снимает блокировку, прочие причины — нет', function () {
    expect(fn('qwen', true, false, true)).toBe(false);
    expect(fn('qwen', true, false, false)).toBe(true);
    expect(fn('qwen', true, false, undefined)).toBe(true);   // старый 3-аргументный вызов
    expect(fn('qwen', true, true, true)).toBe(false);        // полнота важнее флага
  });

  test('строго qwen-only: чужая платформа с partialSoft=true не разрешается', function () {
    ['gemini', 'deepseek', 'chatgpt', 'claude', 'google_search', 'perplexity'].forEach(function (site) {
      expect(fn(site, true, false, true)).toBe(false);
    });
  });
});

describe('R1: гейт автоэкспорта видит только булев historyIncomplete', function () {
  const STATE = {
    enabled: true,
    percentage: 95,
    threshold: 90,
    loaderRunning: false,
    fired: false,
    isGemini: false,
    domBaseTrusted: true,
    site: 'qwen',
    baseSeen: true,
    baseComplete: false
  };

  test('мягкий финал: historyIncomplete=false → файл разрешён', function () {
    expect(Gate.shouldSkipAutoExport(Object.assign({}, STATE, { historyIncomplete: false })))
      .toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('середина пагинации: historyIncomplete=true → O-54 держит (not-complete)', function () {
    expect(Gate.shouldSkipAutoExport(Object.assign({}, STATE, { historyIncomplete: true })))
      .toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('фатальная ошибка (historyIncomplete=true) — файла нет, как до R1', function () {
    // error/cursor-loop не в soft-списке → предикат отдаёт true → гейт блокирует.
    expect(fnIncomplete('qwen', true, false, false)).toBe(true);
    expect(Gate.shouldSkipAutoExport(Object.assign({}, STATE, { historyIncomplete: true })))
      .toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  function fnIncomplete(site, baseSeen, baseComplete, partialSoft) {
    return new Function('ctx',
      'with (ctx) { ' + fnDecl(MGR_SRC, 'aiCmHistoryPaginationIncomplete') +
      '\n return aiCmHistoryPaginationIncomplete; }')({})(site, baseSeen, baseComplete, partialSoft);
  }
});

describe('R1: emitSnapshot — partialSoft аддитивен и не ослабляет O-54', function () {
  function makeEmitStore() {
    const ctx = {
      turns: [],
      userTurns: [],
      dispatchSig: null,
      lastDispatchResult: false,
      currentChatId: 'chat-r1',
      lastReqChatId: '',
      dispatched: [],
      buildSignature: function () { return null; },
      composeTurnText: function (answer) { return answer; },
      userTextOf: function () { return ''; },
      diagLine: function () {},
      diagTag: function () {},
      diagUrl: function () { return ''; },
      swallow: function () {},
      CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; }
    };
    ctx.window = { dispatchEvent: function (ev) { ctx.dispatched.push(ev); return true; } };
    const SCOPE = 'with (ctx) { ' + fnDecl(INTERCEPT_SRC, 'recordTurn') + '\n' +
      fnDecl(INTERCEPT_SRC, 'emitSnapshot') +
      '\n return { recordTurn: recordTurn, emitSnapshot: emitSnapshot }; }';
    const api = new Function('ctx', SCOPE)(ctx);
    ctx.turns = [{ key: 'q1', order: 0, text: 'A' }];
    return { ctx: ctx, emitSnapshot: api.emitSnapshot };
  }

  test('мягкий финал: historyComplete=false, partialSoft=true, partial.reason сохранён', function () {
    const store = makeEmitStore();
    store.emitSnapshot({
      complete: false,
      partial: { pages: 3, reason: 'time-cap' },
      partialSoft: true
    });
    const detail = store.ctx.dispatched[0].detail;
    expect(detail.historyComplete).toBe(false);
    expect(detail.partial).toEqual({ pages: 3, reason: 'time-cap' });
    expect(detail.partialSoft).toBe(true);
  });

  test('фатальная ошибка: тот же неполный снимок, но partialSoft=false', function () {
    const store = makeEmitStore();
    store.emitSnapshot({ complete: false, partial: { pages: 1, reason: 'error' } });
    expect(store.ctx.dispatched[0].detail.partialSoft).toBe(false);
  });

  test('честный конец и живой SSE: partialSoft=false даже при флаге в аргументе', function () {
    const store = makeEmitStore();
    store.emitSnapshot({ complete: true, partialSoft: true });
    expect(store.ctx.dispatched[0].detail.partialSoft).toBe(false);
    expect(store.ctx.dispatched[0].detail.partial).toBe(null);
  });
});

describe('R1: buildSignature — s:-сегмент защищает soft-финал от дедупа', function () {
  function buildSig(serverTokens, complete, soft) {
    const ctx = { turns: [], currentChatId: 'chat-r1' };
    const fn = new Function('ctx',
      'with (ctx) { ' + fnDecl(INTERCEPT_SRC, 'buildSignature') +
      '\n return buildSignature; }')(ctx);
    return fn(serverTokens, complete, soft);
  }

  test('s:1 отличается от s:0 при тех же ходах и complete=false (R-1 плана)', function () {
    const intermediate = buildSig(0, false, false);
    const softFinal = buildSig(0, false, true);
    expect(intermediate).toContain('|c:0|s:0');
    expect(softFinal).toContain('|c:0|s:1');
    expect(softFinal).not.toBe(intermediate);
  });

  test('обратная совместимость: без 3-го аргумента — s:0, как у промежуточного снимка', function () {
    expect(buildSig(0, false)).toBe(buildSig(0, false, false));
    expect(buildSig(0, true, true)).toContain('|c:1|s:1');
  });
});

describe('R1: source-пины пайплайна (классификация → булев → имя файла)', function () {
  test('core/qwen-pagination.js — единственный владелец классификации', function () {
    expect(PAGINATION_SRC).toContain("var SOFT_PARTIAL_REASONS = ['time-cap', 'page-cap', 'no-gain'];");
    expect(PAGINATION_SRC).toContain('function isSoftPartialReason(reason) {');
    expect(PAGINATION_SRC).toContain("return SOFT_PARTIAL_REASONS.indexOf(String(reason || '')) !== -1;");
    expect(PAGINATION_SRC).toContain('SOFT_PARTIAL_REASONS: SOFT_PARTIAL_REASONS,');
    expect(PAGINATION_SRC).toContain('isSoftPartialReason: isSoftPartialReason,');
  });

  test('core/qwen-intercept.js — soft в pqFinish, s:-сегмент и partialSoft в снимке', function () {
    expect(INTERCEPT_SRC).toContain('var pqApi = qwenPaginationApi();');
    expect(INTERCEPT_SRC).toContain('? pqApi.isSoftPartialReason(reason) === true : false;');
    expect(INTERCEPT_SRC).toContain('partialSoft: (!honest && soft)');
    expect(INTERCEPT_SRC).toContain('function buildSignature(serverTokens, complete, soft) {');
    expect(INTERCEPT_SRC).toContain("parts.push('s:' + (soft === true ? 1 : 0));");
    expect(INTERCEPT_SRC).toContain('buildSignature(serverTokens, s.complete, (s.partialSoft === true && complete === false))');
    expect(INTERCEPT_SRC).toContain('partialSoft: complete ? false : (s.partialSoft === true),');
  });

  test('core/state.js + core/widget.js — реестр по разговору и сброс при смене чата', function () {
    expect(STATE_SRC).toContain('var aiCmPartialSoftByConv = {};');
    expect(STATE_SRC).toContain("Object.defineProperty(Api, 'aiCmPartialSoftByConv', { enumerable: true,");
    expect(WIDGET_SRC).toContain('try { aiCmPartialSoftByConv = {}; } catch (eResetPs63) { }');
  });

  test('core/content.js — запись по detail.chatId вне if (emitConvId)', function () {
    expect(CONTENT_SRC).toContain('var softKey63 = detail.chatId || emitConvId ||');
    expect(CONTENT_SRC).toContain('aiCmPartialSoftByConv[softKey63] = (detail.partialSoft === true);');
    // Qwen не отдаёт convId: ключ обязан начинаться с chatId, иначе ветка не исполнится
    const iWrite = CONTENT_SRC.indexOf('aiCmPartialSoftByConv[softKey63]');
    const iIfConv = CONTENT_SRC.lastIndexOf('if (emitConvId) {', iWrite);
    const iClose = CONTENT_SRC.indexOf('\n  }\n', iIfConv);
    expect(iWrite).toBeGreaterThan(iClose);          // запись ПОСЛЕ закрытия if (emitConvId)
  });

  test('core/export-manager.js — 4-й аргумент предиката и qwen-ветка lowConfD', function () {
    expect(MGR_SRC).toContain('function aiCmHistoryPaginationIncomplete(site, baseSeen, baseComplete, partialSoft) {');
    expect(MGR_SRC).toContain("return site === 'qwen' && baseSeen === true && baseComplete !== true && partialSoft !== true;");
    expect(MGR_SRC).toContain('aiCmHistoryPaginationIncomplete(siteName, baseSeen === true, baseComplete === true,');
    expect(MGR_SRC).toContain("(siteNameD === 'qwen') ? (baseComplete !== true &&");
    // прочие платформы не получили qwen-флага
    expect(MGR_SRC).not.toContain("(siteNameD === 'deepseek')");
  });
});

describe('R1: авто-дорога doAutoExportDownload — qwen soft-final даёт [LOW CONFIDENCE]_', function () {
  const SCOPE = 'with (ctx) { ' +
    fnDecl(MGR_SRC, 'aiCmExportBaseSource') + '\n' +
    fnDecl(MGR_SRC, 'aiCmAutoExportStartDownload') + '\n' +
    fnDecl(MGR_SRC, 'doAutoExportDownload') + '\n' +
    ' return { dl: doAutoExportDownload }; }';
  const makeContent = new Function('ctx', SCOPE);

  function ctxFor(over) {
    const downloads = [];
    const logs = [];
    const ctx = {
      currentAdapter: { siteName: 'qwen' },
      autoExportSettings: { fmt: 'txt', enabled: true, pct: 90 },
      aiCmLowConfidenceByConv: {},
      // R1: реестр мягкого финала (в бою его заводит core/state.js и пишет core/content.js)
      aiCmPartialSoftByConv: {},
      baseSeen: true,
      baseComplete: false,             // soft-final: honest=false, полноты нет
      lastBaseTexts: ['привет', 'Привет!'],
      lastEmitConvId: CHAT,
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
        return [
          { role: 'user', text: 'привет' },
          { role: 'assistant', text: 'Привет!' }
        ];
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
        AiCmExportEmitPipeline: Gate
      }
    };
    Object.assign(ctx, over || {});
    return { ctx: ctx, downloads: downloads, logs: logs, api: makeContent(ctx) };
  }

  test('реестр[cid]=true при baseComplete=false → имя с префиксом [LOW CONFIDENCE]_', function () {
    const h = ctxFor();
    h.ctx.aiCmPartialSoftByConv[CHAT] = true;
    h.api.dl(CHAT, 42.5, 'threshold');
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0].file).toMatch(/^\[LOW CONFIDENCE\]_qwen-cda86f26-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
  });

  test('реестр[cid]=false → поведение O-36 прежнее, имени без префикса', function () {
    const h = ctxFor();
    h.ctx.aiCmPartialSoftByConv[CHAT] = false;
    h.api.dl(CHAT, 42.5, 'threshold');
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0].file).toMatch(/^qwen-cda86f26-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
    expect(h.downloads[0].file).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('чужой cid не получает префикс (реестр читается строго по cid)', function () {
    const h = ctxFor();
    h.ctx.aiCmPartialSoftByConv['какой-то-другой-чат'] = true;
    h.api.dl(CHAT, 42.5, 'threshold');
    expect(h.downloads[0].file).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('без реестра в песочнице (typeof-гард) — прежний путь без префикса', function () {
    const h = ctxFor();
    delete h.ctx.aiCmPartialSoftByConv;
    h.api.dl(CHAT, 42.5, 'threshold');
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0].file).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });
});
