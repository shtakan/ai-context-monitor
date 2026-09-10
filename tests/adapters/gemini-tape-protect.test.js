/**
 * v75 (D-head): tape-protect для fullRebuildFromVf5.
 *
 * Из core/gemini-intercept.js извлекается РЕАЛЬНЫЙ блок кода — от
 * `if (disjointReset) {` (disjoint-reset, diagDisjointReset) до конца
 * merge-decision diag IIFE — и исполняется в песочнице с `with`.
 * Это гарантирует, что тесты гоняют исходный код, а не копию логики.
 *
 * Проверяем:
 *   а) tapeWasUsedInThisColdStart=true + vf5 wasFull=true без курсора →
 *      turnsMap НЕ сбрасывается (restored-ходы с order<0 живы), reason=tape-protect-no-rebuild;
 *   б) tapeWasUsedInThisColdStart=false + то же условие → прежний reset (turnsMap={});
 *   в) «НЕ трогать»: merge-by-id (есть курсор) и disjoint-reset ведут себя как раньше.
 */
const fs = require('fs');
const path = require('path');

const coreSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
  'utf8'
);

// --- извлечение блока из реального исходника ---
function extractBlock() {
  const START = 'if (disjointGuardSrc && baseSize() > 0) {';
  const END_MARK = 'merge-decision — только фиксация решения, логика не меняется';
  const END = '})();';
  const i = coreSrc.indexOf(START);
  expect(i).toBeGreaterThan(-1); // маркер старта найден
  const j = coreSrc.indexOf(END_MARK, i);
  expect(j).toBeGreaterThan(-1); // маркер конца найден
  const k = coreSrc.indexOf(END, j);
  expect(k).toBeGreaterThan(-1);
  return coreSrc.slice(i, k + END.length);
}

// --- песочница: блок исполняется с with(ctx) ---
function runBlock(snippet, ctx) {
  ctx.debugLog = ctx.debugLog || function (level, msg) { ctx.logs.push(String(msg)); };
  ctx.baseSize = function () { return Object.keys(ctx.turnsMap).length; };
  ctx.window.GeminiInterceptLogic.shouldDisjointReset = function () { return ctx.disjointResetDecision; };
  const fn = new Function('ctx', 'with (ctx) {\n' + snippet + '\n}');
  fn(ctx);
  return ctx;
}

function baseCtx(overrides) {
  return Object.assign({
    logs: [],
    // disjoint-reset вход (неактивен по умолчанию; решает shouldDisjointReset)
    disjointResetDecision: false,
    // состояние базы (как после tape-restore: restored-ходы с отрицательным order)
    turnsMap: { m_old: true, m_new: true },
    orderCounter: 7,
    prependCursor: 3,
    tapeWasUsedInThisColdStart: false,
    convEpoch: 1,
    vf5OverlapSinceLoaderStart: false,
    isLowConfidenceBase: false,
    olderHistorySeen: true,
    historyFullByQuiet: false,
    reachedStart: false,
    reachedStartByScroll: false,
    serverFirstHash: 'h1',
    lastHeadToken: 't1',
    quietActive: false,
    quietPaginated: false,
    quietDecisionMade: false,
    quietIncompleteNoStart: false,
    lastCycleEndedHidden: false,
    attachSeen: {},
    attachTokens: 0,
    attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
    // входящие
    fromVirtualF5: true,
    wasFull: true,
    pendingCursor: null,
    parsed: [{ id: 'a' }, { id: 'b' }],
    diagDisjointReset: false,
    diagExistingBefore: 5,
    diagOverlap: 2,
    disjointGuardSrc: true, // как в core: src === 'vf5'
    src: 'vf5',
    getConvId: function () { return 'conv-1'; },
    baseSize: function () { return Object.keys(ctx.turnsMap).length; },
    window: {
      GeminiInterceptLogic: {
        // сигнатура как в utils/gemini-intercept-logic.js: shouldFullRebuild
        shouldFullRebuild: function (opts) {
          return !!(opts.fromVirtualF5 && opts.wasFull && !opts.hasCursor);
        },
        // сигнатура как в utils/gemini-intercept-logic.js: shouldDisjointReset
        shouldDisjointReset: function () { return ctx.disjointResetDecision; }
      }
    }
  }, overrides || {});
}

describe('v75 D-head: tape-protect против fullRebuildFromVf5', () => {
  const snippet = extractBlock();

  it('а) tape-restore в этом холодном старте + vf5 wasFull без курсора → turnsMap НЕ сбрасывается', () => {
    const ctx = runBlock(snippet, baseCtx({ tapeWasUsedInThisColdStart: true }));
    // restored-ходы живы, счётчики не сброшены
    expect(ctx.turnsMap).toEqual({ m_old: true, m_new: true });
    expect(ctx.orderCounter).toBe(7);
    expect(ctx.prependCursor).toBe(3);
    // guard сработал: лог tape-protect, merge-decision — merge без reset
    const joined = ctx.logs.join('\n');
    expect(joined).toContain('reason=tape-protect-no-rebuild');
    expect(joined).not.toContain('reason=full-rebuild-vf5-no-cursor');
    expect(joined).toContain('action=merge incomingSrc=vf5');
  });

  it('б) tape-restore НЕ было (флаг=false) + vf5 wasFull без курсора → прежний полный reset', () => {
    const ctx = runBlock(snippet, baseCtx({ tapeWasUsedInThisColdStart: false }));
    expect(ctx.turnsMap).toEqual({});
    expect(ctx.orderCounter).toBe(0);
    expect(ctx.prependCursor).toBe(-1);
    const joined = ctx.logs.join('\n');
    expect(joined).toContain('reason=full-rebuild-vf5-no-cursor');
    expect(joined).not.toContain('tape-protect-no-rebuild');
  });

  it('в-1) НЕ трогать merge-by-id: vf5 с курсором → merge без сброса, guard не вмешивается', () => {
    const ctx = runBlock(snippet, baseCtx({
      tapeWasUsedInThisColdStart: true,
      pendingCursor: 'cursor-xyz' // курсор → shouldFullRebuild=false
    }));
    // turnsMap цел (merge-by-id дедуплицирует, сброс не выполняется)
    expect(ctx.turnsMap).toEqual({ m_old: true, m_new: true });
    expect(ctx.orderCounter).toBe(7);
    const joined = ctx.logs.join('\n');
    expect(joined).toContain('reason=vf5-cursor-continue');
    expect(joined).not.toContain('reason=full-rebuild-vf5-no-cursor');
    // guard НЕ должен логировать tape-protect, т.к. fullRebuildFromVf5=false
    expect(joined).not.toContain('tape-protect-no-rebuild');
  });

  it('в-2) НЕ трогать disjoint-reset: нулевое пересечение сбрасывает базу даже после tape-restore', () => {
    const ctx = runBlock(snippet, baseCtx({
      disjointResetDecision: true, // пересечение по id = 0 → disjoint-reset
      tapeWasUsedInThisColdStart: true,
      getConvId: function () { return ''; } // cross-conv: else-ветка v64, reset разрешён
    }));
    expect(ctx.diagDisjointReset).toBe(true);
    expect(ctx.convEpoch).toBe(2);
    // disjoint-reset сбрасывает и флаг tape (новая эпоха), и базу — прежнее поведение
    expect(ctx.tapeWasUsedInThisColdStart).toBe(false);
    expect(ctx.turnsMap).toEqual({});
    expect(ctx.orderCounter).toBe(0);
    const joined = ctx.logs.join('\n');
    expect(joined).toContain('action=disjoint-reset');
    expect(joined).toContain('disjoint-reset convId=(none)');
    // guard НЕ сработал (флаг уже сброшен disjoint-reset'ом)
    expect(joined).not.toContain('tape-protect-no-rebuild');
  });
});

