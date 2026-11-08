/**
 * Phase 3 (D3-regression): resetForNewConversation сбрасывает состояние МУТАЦИЕЙ.
 *
 * ДЕФЕКТ. core/gemini-intercept.js раньше делал `turnsMap = {}` / `attachSeen = {}` /
 * `attachBreak = {...}` / `oracleIncompleteSeen = {}` / `oracleRerunUsedMap = {}` /
 * `paginationRun = {...}`. Ядро исполняется внутри `with (window.AiCmGeminiState)`
 * (core/gemini-intercept.js:116), а core/gemini-state.js экспортирует эти имена ОДНИМ
 * объектом ПО ССЫЛКЕ (core/gemini-state.js:239-341: `turnsMap: turnsMap,` и т.д.).
 * Присваивание подменяло ссылку только в объекте-состоянии: держатели старого объекта
 * (модули через bind, снапшоты диагностики) продолжали писать в осиротевшую карту,
 * новая оставалась пустой → бейдж не рос после смены чата.
 *
 * ФИКС. `Object.keys(x).forEach(k => delete x[k])` для карт, полевое обнуление для
 * attachBreak, копирование счётчиков в существующий paginationRun. Примитивы
 * (attachTokens и прочие) остаются прямым присваиванием — это безопасно.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (реальный код, не копия): тело функции режется из исходника
 * (конвенция gemini-floor-self-heal / gemini-collapse-guard) и исполняется в `with (ctx)`;
 * ссылки, снятые ДО вызова, обязаны остаться теми же объектами, но опустеть.
 */

const GIL = require('../helpers/load-esm.js').loadEsmModule('utils/gemini-intercept-logic.ts');

const CORE_GEMINI = require('../helpers/gemini-intercept-source.js').geminiSource;

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

const RESET_SRC = fnDecl(CORE_GEMINI, 'resetForNewConversation');

// Реальный resetForNewConversation, созданный внутри `with (ctx)`:
// свободные имена резолвятся в свойства ctx динамически — как в браузере.
function makeReset(ctx) {
  return new Function('ctx', 'with (ctx) { return (' + RESET_SRC + '); }')(ctx);
}

function makeWindow(gil) {
  return {
    dispatched: 0,
    dispatchEvent: function () { ctxWindow.dispatched++; return true; },
    GeminiInterceptLogic: gil || null
  };
}

// window-стаб: счётчик dispatchEvent нужен, чтобы доказать, что событие смены чата ушло
let ctxWindow = null;

function makeCtx(overrides) {
  ctxWindow = makeWindow(GIL);
  const base = {
    // примитивы
    convEpoch: 7,
    tapeWasUsedInThisColdStart: true,
    vf5OverlapSinceLoaderStart: true,
    isLowConfidenceBase: true,
    attachTokens: 128,
    orderCounter: 42,
    prependCursor: 3,
    loggedOk: true,
    loggedErr: true,
    loggedStructure: true,
    loggedRontgen: true,
    loggedAttach: true,
    loggedMultiCursor: true,
    lastPaginateOpaqueCandidates: [{ a: 1 }],
    lastFailedSkeleton: { b: 2 },
    idmapCalls: 5,
    pendingCursor: 'cur-1',
    olderHistorySeen: true,
    quietActive: true,
    historyFullByQuiet: true,
    reachedStart: true,
    reachedStartByScroll: true,
    serverFirstHash: 'hash-1',
    lastHeadToken: 'tok-1',
    lastGoodWideCur: { c: 3 },
    lastGoodProbeMeta: { d: 4 },
    lastOlderNonPagAddAt: 123,
    minOrderSeen: 5,
    lastBaseCount: 9,
    lastBaseCountChangeAt: 456,
    lastLoaderDoneReason: 'top',
    collapseRetries: 2,
    lastPagStepBroken: true,
    lastHnvPageError: true,
    pagErrorRetries: 3,
    quietEndedClean: true,
    lastCleanEndBaseCount: 9,
    quietErrStreak: 2,
    nativeEscalationFor: 'conv-x',
    quietPaginated: true,
    quietDecisionMade: true,
    quietIncompleteNoStart: true,
    lastCycleEndedHidden: true,
    autoScrollStarted: true,
    conversationOpenedAt: 1,
    lastActiveAt: 2,
    lastVf5ActivityAt: 3,
    loggedActiveStatus: true,
    autoScrollBlocked: false,
    autoScrollUnblockTimer: 11,
    currentConvId: '',
    // ОБЪЕКТЫ, которые обязаны сохранить идентичность
    turnsMap: { turnA: 1, turnB: 2 },
    attachSeen: { 'file-1': 1, 'file-2': 1 },
    attachBreak: { imgTokens: 10, docTokens: 4, imgCount: 2, docCount: 1 },
    oracleIncompleteSeen: { 'conv-1': 1 },
    oracleRerunUsedMap: { 'conv-1': true },
    paginationRun: { pageCount: 3, startTs: 999 },
    cacheRestoredMap: new Set(['conv-1']),
    archiveMergedMap: new Map([['conv-1', 1]]),
    archiveTierByConv: {},
    // зависимости
    window: ctxWindow,
    aiCmGeminiFiles: { gfReset: function () { } },
    getConvId: function () { return ''; },
    debugLog: function () { },
    swallowSoft: function () { },
    setTimeout: function () { return 1; },
    clearTimeout: function () { },
    CustomEvent: function (type) { this.type = type; }
  };
  return Object.assign(base, overrides || {});
}

// Ссылки на объекты ДО вызова: mutation обязана сохранить их идентичность.
function refsOf(ctx) {
  return {
    turnsMap: ctx.turnsMap,
    attachSeen: ctx.attachSeen,
    attachBreak: ctx.attachBreak,
    oracleIncompleteSeen: ctx.oracleIncompleteSeen,
    oracleRerunUsedMap: ctx.oracleRerunUsedMap,
    paginationRun: ctx.paginationRun,
    cacheRestoredMap: ctx.cacheRestoredMap,
    archiveMergedMap: ctx.archiveMergedMap
  };
}

describe('D3-regression: resetForNewConversation мутирует состояние, а не пересоздаёт объекты', () => {
  test('turnsMap/attachSeen сохраняют идентичность и ОПУСТОШАЮТСЯ (старая ссылка видит delete)', () => {
    const ctx = makeCtx();
    const refs = refsOf(ctx);

    makeReset(ctx)();

    expect(ctx.turnsMap).toBe(refs.turnsMap);
    expect(ctx.attachSeen).toBe(refs.attachSeen);
    expect(Object.keys(ctx.turnsMap)).toEqual([]);
    expect(Object.keys(ctx.attachSeen)).toEqual([]);
    // держатель СТАРОЙ ссылки видит сброс — значит, объект не подменён
    expect(refs.turnsMap).toEqual({});
    expect(refs.attachSeen).toEqual({});
  });

  test('attachBreak: та же ссылка, все четыре поля обнулены', () => {
    const ctx = makeCtx();
    const refs = refsOf(ctx);

    makeReset(ctx)();

    expect(ctx.attachBreak).toBe(refs.attachBreak);
    expect(ctx.attachBreak).toEqual({ imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 });
    expect(Object.keys(ctx.attachBreak).sort()).toEqual(['docCount', 'docTokens', 'imgCount', 'imgTokens']);
    expect(refs.attachBreak.imgTokens).toBe(0);
  });

  test('oracleIncompleteSeen/oracleRerunUsedMap: идентичность сохранена, карты пусты', () => {
    const ctx = makeCtx();
    const refs = refsOf(ctx);

    makeReset(ctx)();

    expect(ctx.oracleIncompleteSeen).toBe(refs.oracleIncompleteSeen);
    expect(ctx.oracleRerunUsedMap).toBe(refs.oracleRerunUsedMap);
    expect(Object.keys(ctx.oracleIncompleteSeen)).toEqual([]);
    expect(Object.keys(ctx.oracleRerunUsedMap)).toEqual([]);
  });

  test('cacheRestoredMap/archiveMergedMap: те же экземпляры Set/Map, очищены', () => {
    const ctx = makeCtx();
    const refs = refsOf(ctx);

    makeReset(ctx)();

    expect(ctx.cacheRestoredMap).toBe(refs.cacheRestoredMap);
    expect(ctx.archiveMergedMap).toBe(refs.archiveMergedMap);
    expect(ctx.cacheRestoredMap.size).toBe(0);
    expect(ctx.archiveMergedMap.size).toBe(0);
  });

  test('paginationRun: идентичность сохранена, счётчики обнулены (ветка с GeminiInterceptLogic)', () => {
    const ctx = makeCtx();
    const refs = refsOf(ctx);

    makeReset(ctx)();

    expect(ctx.paginationRun).toBe(refs.paginationRun);
    expect(ctx.paginationRun.pageCount).toBe(0);
    expect(ctx.paginationRun.startTs).toBe(0);
  });

  test('paginationRun: ветка БЕЗ GeminiInterceptLogic тоже мутирует существующий объект', () => {
    const w = makeWindow(null);
    const ctx = makeCtx({ window: w });
    const refs = refsOf(ctx);

    makeReset(ctx)();

    expect(ctx.paginationRun).toBe(refs.paginationRun);
    expect(ctx.paginationRun).toEqual({ pageCount: 0, startTs: 0 });
  });

  test('примитивы сбрасываются прямым присваиванием (attachTokens и др.)', () => {
    const ctx = makeCtx();

    makeReset(ctx)();

    expect(ctx.convEpoch).toBe(8);
    expect(ctx.attachTokens).toBe(0);
    expect(ctx.orderCounter).toBe(0);
    expect(ctx.prependCursor).toBe(-1);
    expect(ctx.loggedOk).toBe(false);
    expect(ctx.loggedAttach).toBe(false);
    expect(ctx.lastBaseCount).toBe(-1);
    expect(ctx.minOrderSeen).toBe(Infinity);
    expect(ctx.lastLoaderDoneReason).toBe('');
    expect(ctx.collapseRetries).toBe(0);
    expect(ctx.autoScrollBlocked).toBe(true);
    expect(ctx.autoScrollUnblockTimer).toBe(1);
    // событие смены чата по-прежнему диспатчится
    expect(ctx.window.dispatched).toBe(1);
  });

  test('source-pin: пересозданий объектов в resetForNewConversation больше нет', () => {
    expect(RESET_SRC).not.toMatch(/turnsMap\s*=\s*\{\s*\}/);
    expect(RESET_SRC).not.toMatch(/attachSeen\s*=\s*\{\s*\}/);
    expect(RESET_SRC).not.toMatch(/attachBreak\s*=\s*\{/);
    expect(RESET_SRC).not.toMatch(/oracleIncompleteSeen\s*=\s*\{\s*\}/);
    expect(RESET_SRC).not.toMatch(/oracleRerunUsedMap\s*=\s*\{\s*\}/);
    expect(RESET_SRC).not.toMatch(/paginationRun\s*=\s*\{/);
    expect(RESET_SRC).toContain('Object.keys(turnsMap).forEach(function (k) { delete turnsMap[k]; });');
    expect(RESET_SRC).toContain('Object.keys(attachSeen).forEach(function (k) { delete attachSeen[k]; });');
    // примитив остался прямым присваиванием — это и требуется
    expect(RESET_SRC).toContain('attachTokens = 0;');
  });
});
