/**
 * O-51b (High): решение о сбросе базы принимается по id-СВИДЕТЕЛЬСТВУ, а не по форме снапшота.
 * Пустое свидетельство сброс НЕ разрешает (fail-closed) — иначе легитимный по форме reset
 * уничтожает накопленную базу.
 *
 * Живая приёмка 2026-09-25 16:31:33.906 (чат 8f1343975188be5d): vf5-снимок с 20 ходами из 36
 * дал `action=reset reason=full-rebuild-vf5-no-cursor` при `overlapCount=20 disjointFlag=false` —
 * база схлопнулась 36 → 20, метрика 39.1% → 10.8%, pre-trim файл потерял старшие ходы.
 * Лог-свидетель: `[gemini-ingest-trace] src=vf5 блоков_ходов=20 ids=[r_8e8344d306a9776a_user,…,
 * r_adbb95f952e42aee_assistant]` — id в трейсе ЕСТЬ, но в критерий пересборки они не попадали:
 * `rebuildExistingIds`/`rebuildIncomingIds` заполнялись только на vf5-ветке и оставались пустыми,
 * а пустой вход `isSubsetIds` → false → «снапшот не подмножество» → разрушительный reset.
 *
 * Фикс O-51b (core/gemini-intercept.js:ingest + utils/gemini-intercept-logic.js):
 *   1) ЕДИНАЯ точка извлечения id (`collectTurnIds`): ОДНИ И ТЕ ЖЕ массивы идут и в трейс
 *      `[gemini-ingest-trace] … ids=[…]`, и в `shouldFullRebuild({existingIds, incomingIds})`;
 *      трейс дополнительно печатает `baseIds=` и `idEvidence=` (видно, было ли свидетельство);
 *   2) fail-closed: если свидетельство негодно (массивы пусты или без живых id), а база непуста —
 *      сброс запрещён, причина `reason=vf5-no-id-evidence-no-reset`; фолбэк — на content-критерий
 *      O-51 `shouldDisjointReset`, который по O-51b тоже больше не считает «нулевым пересечением»
 *      отсутствие id (пустой вход не доказывает чужой сеанс);
 *   3) фолбэк без модуля логики снова повторяет контракт v32 целиком: vf5-снапшот с курсором
 *      продолжения пересборку не запускает (раньше проверка курсора терялась вместе с модулем).
 *
 * Пины:
 *   D1 снапшот-подмножество с РЕАЛЬНЫМИ id из трейса 16:31:33.906 → `reason=vf5-subset-no-reset`,
 *      сброса нет (turnsMap/orderCounter/convEpoch целы);
 *   D2 база сохраняет ВСЕ 36 сообщений (20 снимка + 16 старших), новых ходов 0;
 *   G  пустое id-свидетельство сброс не разрешает: база 36 цела (в т.ч. против fail-open модуля
 *      старой сборки), пустая база — прежнее поведение (терять нечего);
 *   R1 регресс O-48/O-49/O-50/O-51/O-52 цел: инвентарь пинов 16/15/10/11/12 и ключевые строки
 *      фиксов на месте; vf5 с курсором → merge (и с модулем логики, и без него);
 *   R2 легитимные сбросы работают: снапшот с НОВЫМИ id → `full-rebuild-vf5-no-cursor`;
 *      disjoint cross-conv (нулевое пересечение) → `action=disjoint-reset` + `convEpoch++`.
 *
 * Тесты исполняют РЕАЛЬНЫЙ код core/gemini-intercept.js (извлечённый блок решателя
 * `disjointGuardSrc … refreshMinOrderTracking`) и РЕАЛЬНЫЙ модуль utils/gemini-intercept-logic.js
 * — не копии логики. НЕ ТРОГАЕТСЯ: tolerant-salvage O-48, единая точка сбора O-49, символьный
 * срез O-50, санация O-20/O-40/O-42, D-O41, badge-метрика O-47, CHANGELOG/версия.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CORE = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');
const LOGIC_PATH = path.join(ROOT, 'utils', 'gemini-intercept-logic.js');
const LOGIC_SRC = fs.readFileSync(LOGIC_PATH, 'utf8');
const LOGIC = require(LOGIC_PATH);

if (typeof window !== 'undefined') window.GeminiInterceptLogic = LOGIC;

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

// ---- извлечение РЕАЛЬНОГО решателя + merge из core/gemini-intercept.js ----
// Границы: disjoint-guard → O-51b id-свидетельство → shouldFullRebuild → fail-closed guard →
// tape-protect → reset → merge-decision diag IIFE → merge по id → refreshMinOrderTracking.
function extractDecideAndMerge() {
  const START = "var disjointGuardSrc = (src === 'vf5' || src === 'passive');";
  const END_MARK = "new-turns +' + added";
  const i = CORE.indexOf(START);
  expect(i).toBeGreaterThan(-1);
  const mark = CORE.indexOf(END_MARK, i);
  expect(mark).toBeGreaterThan(-1);
  const logEnd = CORE.indexOf('\n', CORE.indexOf(';', mark));
  const j = CORE.indexOf('\n', logEnd + 1);
  expect(j).toBeGreaterThan(logEnd);
  const block = CORE.slice(i, j);
  expect(block).toContain('var rebuildIncomingIds = collectTurnIds(parsed);');
  expect(block).toContain('noIdEvidenceNoReset');
  expect(block).toContain("reason = 'vf5-no-id-evidence-no-reset'");
  return block;
}
const SNIPPET = extractDecideAndMerge();
const MERGE_DECLS = fnDecl(CORE, 'refreshMinOrderTracking');

// ---- реальные id из трейса 16:31:33.906 ----
// Края приведены ДОСЛОВНО из лога приёмки; промежуточные 18 восстановлены в том же формате
// (в handoff лог усечён многоточием: `ids=[r_8e8344d306a9776a_user,…,r_adbb95f952e42aee_assistant]`).
const TRACE_FIRST_ID = 'r_8e8344d306a9776a_user';
const TRACE_LAST_ID = 'r_adbb95f952e42aee_assistant';
const SNAPSHOT_LEN = 20; // блоков_ходов=20
const BASE_LEN = 36;     // existingMsgs=36, из них 20 — те же id (overlapCount=20, disjointFlag=false)

function roleSuffix(idx) { return idx % 2 === 0 ? '_user' : '_assistant'; }
function midId(idx) { return 'r_' + (idx + 10).toString(16).padStart(8, '0') + 'c0ffeeb4' + roleSuffix(idx); }
function olderId(idx) { return 'r_' + (idx + 160).toString(16).padStart(8, '0') + 'a51b0b1e' + roleSuffix(idx); }

/** id входящего vf5-снапшота: 20 ходов, все уже собраны в базе (подмножество). */
function snapshotIds() {
  const ids = [];
  for (let i = 0; i < SNAPSHOT_LEN; i++) {
    if (i === 0) ids.push(TRACE_FIRST_ID);
    else if (i === SNAPSHOT_LEN - 1) ids.push(TRACE_LAST_ID);
    else ids.push(midId(i));
  }
  return ids;
}
/** база 36 ходов: 16 старших (их и терял reset) + 20 ходов снапшота. */
function olderBaseIds() { const a = []; for (let i = 0; i < BASE_LEN - SNAPSHOT_LEN; i++) a.push(olderId(i)); return a; }
function baseIds() { return olderBaseIds().concat(snapshotIds()); }
function freshIds(from, to) { const a = []; for (let i = from; i < to; i++) a.push(midId(i)); return a; }

function turnsOf(ids) {
  return ids.map((id) => ({ id: id, text: 'ход ' + id, modelName: 'Gemini', role: /_user$/.test(id || '') ? 'user' : 'assistant', ts: 0, r1: null }));
}
function turnsWithoutIds(count) {
  return turnsOf(snapshotIds().slice(0, count)).map((t) => Object.assign({}, t, { id: undefined }));
}
function baseTurnsMap() {
  const map = {};
  baseIds().forEach((id, idx) => {
    map[id] = {
      text: 'ход ' + id, modelName: 'Gemini', order: idx, pageMode: 'passive',
      ts: 0, role: idx % 2 ? 'assistant' : 'user', turnId: id, r1: null
    };
  });
  return map;
}

function makeCtx(overrides) {
  const ctx = {
    logs: [],
    loaderRestarts: 0,
    // входящий vf5-снапшот без курсора продолжения (форма «полная история»)
    src: 'vf5',
    fromVirtualF5: true,
    wasFull: true,
    pendingCursor: null,
    parsed: turnsOf(snapshotIds()), // 20 ходов из 36 — все id уже собраны
    preTurns: null,
    fromActivePaginate: false,
    shouldRebuild: false,
    // состояние базы
    turnsMap: baseTurnsMap(),
    orderCounter: BASE_LEN,
    prependCursor: -1,
    convEpoch: 1,
    tapeWasUsedInThisColdStart: false,
    vf5OverlapSinceLoaderStart: false,
    isLowConfidenceBase: false,
    olderHistorySeen: false,
    historyFullByQuiet: true,
    reachedStart: true,
    reachedStartByScroll: false,
    serverFirstHash: '',
    lastHeadToken: null,
    lastGoodWideCur: null,
    lastGoodProbeMeta: null,
    quietActive: false,
    quietPaginated: false,
    quietDecisionMade: false,
    quietIncompleteNoStart: false,
    lastCycleEndedHidden: false,
    attachSeen: {},
    attachTokens: 0,
    attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
    loaderRunningFor: null,
    loaderDoneMap: {},
    loaderRetryUsedMap: {},
    minOrderSeen: Infinity,
    lastOlderNonPagAddAt: 0,
    baseSize: function () { return Object.keys(ctx.turnsMap).length; },
    getConvId: function () { return 'conv-8f1343975188be5d'; },
    maybeStartLoader: function () { ctx.loaderRestarts++; },
    applyStreamAliases: function () { },
    aiCmDiagHash6: function () { return ''; },
    noteBaseCountChange: function () { },
    emitOnlyIfAdded: false,
    setTimeout: function () { },
    debugLog: function (level, msg) { ctx.logs.push(String(msg)); }
  };
  ctx.window = { GeminiInterceptLogic: LOGIC };
  return Object.assign(ctx, overrides || {});
}

function runDecideAndMerge(ctx) {
  const body = MERGE_DECLS + '\n' + SNIPPET;
  const fn = new Function('ctx', 'with (ctx) {\n' + body + '\n}');
  fn(ctx);
  return ctx;
}
function logOf(ctx) { return ctx.logs.join('\n'); }

describe('O-51b (D1+D2): vf5-снапшот-подмножество с реальными id из трейса не сбрасывает базу', () => {
  test('D1: трейс и критерий — одни и те же id; reason=vf5-subset-no-reset вместо reset', () => {
    const ctx = runDecideAndMerge(makeCtx({}));
    const log = logOf(ctx);

    // свидетельство трейса: id снимка попали в решение (те же массивы), свидетельство годно
    expect(log).toContain('[gemini-ingest-trace] src=vf5 блоков_ходов=20 ids=[' +
      TRACE_FIRST_ID + ',' + midId(1) + ',' + midId(2));
    expect(log).toContain(',' + TRACE_LAST_ID + '] baseIds=36 idEvidence=1');
    // решение: merge, причина названа честно, разрушительный reset не выполнен
    expect(log).toContain('action=merge incomingSrc=vf5');
    expect(log).toContain('reason=vf5-subset-no-reset');
    expect(log).not.toContain('reason=full-rebuild-vf5-no-cursor');
    expect(log).not.toContain('reason=vf5-no-id-evidence-no-reset');
    // числа — из живой приёмки: 36 собрано, 20 пришло, 20 пересеклось, форма «без курсора»
    expect(log).toContain('existingMsgs=36 incomingMsgs=20 overlapCount=20 disjointFlag=false');
    // счётчики базы не сброшены
    expect(ctx.turnsMap[olderBaseIds()[0]].order).toBe(0);
    expect(ctx.turnsMap[TRACE_LAST_ID].order).toBe(BASE_LEN - 1);
    expect(ctx.orderCounter).toBeGreaterThanOrEqual(BASE_LEN);
    expect(ctx.prependCursor).toBe(-1);
    expect(ctx.convEpoch).toBe(1);
  });

  test('D2: база сохраняет ВСЕ 36 сообщений (20 снимка + 16 старших), новых ходов 0', () => {
    const ctx = runDecideAndMerge(makeCtx({}));
    const ids = Object.keys(ctx.turnsMap);

    expect(ids).toHaveLength(BASE_LEN);
    olderBaseIds().forEach((id) => {
      expect(ctx.turnsMap[id]).toBeDefined();               // 16 старших живы
      expect(ctx.turnsMap[id].text).toBe('ход ' + id);
    });
    snapshotIds().forEach((id) => expect(ctx.turnsMap[id]).toBeDefined());
    expect(logOf(ctx)).not.toContain('new-turns +');        // снапшот не принёс ничего нового
  });
});

describe('O-51b (G): пустое id-свидетельство сброс НЕ разрешает (fail-closed)', () => {
  test('G1: 20 ходов снапшота БЕЗ id + база 36 → reason=vf5-no-id-evidence-no-reset, база цела', () => {
    const ctx = runDecideAndMerge(makeCtx({ parsed: turnsWithoutIds(SNAPSHOT_LEN) }));
    const log = logOf(ctx);

    expect(log).toContain('idEvidence=0');
    expect(log).toContain('reason=vf5-no-id-evidence-no-reset');
    expect(log).not.toContain('reason=full-rebuild-vf5-no-cursor');
    expect(log).not.toContain('reason=vf5-subset-no-reset');
    // инвариант: собранная база не уничтожена (ходы без id не могут её переписать)
    olderBaseIds().forEach((id) => expect(ctx.turnsMap[id]).toBeDefined());
    snapshotIds().forEach((id) => expect(ctx.turnsMap[id]).toBeDefined());
    expect(ctx.orderCounter).toBeGreaterThanOrEqual(BASE_LEN);
    expect(ctx.convEpoch).toBe(1);
  });

  test('G2: страховка уровня вызова — fail-open модуль старой сборки сброс не разрешает', () => {
    // модуль логики без O-51b-гарда: на пустом свидетельстве отдаёт true и на subset, и на disjoint
    const staleModule = {
      shouldFullRebuild: function () { return true; },
      shouldDisjointReset: function () { return true; }
    };
    const ctx = runDecideAndMerge(makeCtx({
      parsed: turnsWithoutIds(SNAPSHOT_LEN),
      window: { GeminiInterceptLogic: staleModule }
    }));
    const log = logOf(ctx);

    expect(log).toContain('reason=vf5-no-id-evidence-no-reset');
    expect(log).not.toContain('reason=full-rebuild-vf5-no-cursor');
    olderBaseIds().forEach((id) => expect(ctx.turnsMap[id]).toBeDefined());
    expect(logOf(ctx)).not.toContain('action=disjoint-reset');
  });

  test('G3: пустая база — прежнее поведение: сброс разрешён (терять нечего)', () => {
    const ctx = runDecideAndMerge(makeCtx({
      parsed: turnsWithoutIds(SNAPSHOT_LEN),
      turnsMap: {},
      orderCounter: 0
    }));
    const log = logOf(ctx);

    expect(log).toContain('reason=full-rebuild-vf5-no-cursor');
    expect(log).not.toContain('reason=vf5-no-id-evidence-no-reset');
    expect(Object.keys(ctx.turnsMap).length).toBeLessThan(BASE_LEN);
  });
});

describe('O-51b (R1/R2): регресс цел, легитимные сбросы работают', () => {
  test('R1: vf5 с курсором продолжения → merge по id, база 36 цела', () => {
    const ctx = runDecideAndMerge(makeCtx({ pendingCursor: 'cursor-xyz' }));
    const log = logOf(ctx);

    expect(log).toContain('reason=vf5-cursor-continue');
    expect(log).not.toContain('reason=full-rebuild-vf5-no-cursor');
    expect(Object.keys(ctx.turnsMap)).toHaveLength(BASE_LEN);
  });

  test('R1 (O-51b-фикс): без модуля логики курсор продолжения тоже запрещает пересборку', () => {
    const ctx = runDecideAndMerge(makeCtx({ pendingCursor: 'cursor-xyz', window: {} }));
    const log = logOf(ctx);

    expect(log).toContain('reason=vf5-cursor-continue');
    expect(log).not.toContain('reason=full-rebuild-vf5-no-cursor');
    expect(Object.keys(ctx.turnsMap)).toHaveLength(BASE_LEN);
    expect(ctx.turnsMap[olderBaseIds()[0]]).toBeDefined();
  });

  test('R2: без модуля логики vf5 без курсора с НОВЫМИ id → прежний полный reset', () => {
    const ctx = runDecideAndMerge(makeCtx({ parsed: turnsOf(freshIds(100, 120)), window: {} }));
    const log = logOf(ctx);

    expect(log).toContain('reason=full-rebuild-vf5-no-cursor');
    expect(Object.keys(ctx.turnsMap)).toHaveLength(SNAPSHOT_LEN);
    expect(ctx.orderCounter).toBe(SNAPSHOT_LEN); // фолбэк тоже отдаёт счётчик порядка (O-51b-фикс 3b)
  });

  test('R2: снапшот с НОВЫМИ id (не подмножество) → легитимный полный reset', () => {
    const ctx = runDecideAndMerge(makeCtx({ parsed: turnsOf(freshIds(100, 120)) }));
    const log = logOf(ctx);

    expect(log).toContain('reason=full-rebuild-vf5-no-cursor');
    expect(log).not.toContain('reason=vf5-no-id-evidence-no-reset');
    expect(Object.keys(ctx.turnsMap)).toHaveLength(SNAPSHOT_LEN);
    expect(ctx.orderCounter).toBe(SNAPSHOT_LEN);
  });

  test('R2: disjoint cross-conv (нулевое пересечение) → action=disjoint-reset + convEpoch++', () => {
    const ctx = runDecideAndMerge(makeCtx({
      parsed: turnsOf(freshIds(100, 120)),
      getConvId: function () { return ''; } // cross-conv: v64-шорткат не действует
    }));
    const log = logOf(ctx);

    expect(log).toContain('action=disjoint-reset');
    expect(ctx.convEpoch).toBe(2);
    expect(Object.keys(ctx.turnsMap)).toHaveLength(SNAPSHOT_LEN);
  });

  test('R2 (модуль): shouldDisjointReset больше не считает пустые id «нулевым пересечением»', () => {
    // было fail-open: incoming без живых id → «пересечения нет» → сброс ЛЮБОЙ базы
    expect(LOGIC.shouldDisjointReset({ src: 'vf5', existingIds: ['r_a_user'], incomingIds: [undefined, undefined] })).toBe(false);
    expect(LOGIC.shouldDisjointReset({ src: 'vf5', existingIds: [undefined, undefined], incomingIds: ['r_x_user'] })).toBe(false);
    expect(LOGIC.shouldDisjointReset({ src: 'passive', existingIds: ['r_a_user'], incomingIds: ['', null] })).toBe(false);
    // легитимные вердикты целы: чужой сеанс / пересечение / тот же чат / пустые массивы
    expect(LOGIC.shouldDisjointReset({ src: 'vf5', existingIds: ['r_a_user'], incomingIds: ['r_x_user'] })).toBe(true);
    expect(LOGIC.shouldDisjointReset({ src: 'vf5', existingIds: ['r_a_user'], incomingIds: ['r_a_user'] })).toBe(false);
    expect(LOGIC.shouldDisjointReset({ src: 'vf5', existingIds: ['r_a_user'], incomingIds: ['r_x_user'], incomingConvId: 'c1', currentConvId: 'c1' })).toBe(false);
    expect(LOGIC.shouldDisjointReset({ src: 'vf5', existingIds: [], incomingIds: ['r_x_user'] })).toBe(false);
    expect(LOGIC.shouldDisjointReset({ src: 'pag', existingIds: ['r_a_user'], incomingIds: ['r_x_user'] })).toBe(false);
    expect(LOGIC_SRC).toContain('if (!liveExisting || !liveIncoming) return false;');
  });

  test('R1 (S-пины): проводка id-свидетельства в ingest и инвентарь пинов O-48…O-52', () => {
    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const ingest = fnDecl(CORE, 'ingest');

    // единая точка извлечения id: трейс и критерий питаются одними массивами
    expect(ingest).toContain('var rebuildExistingIds = baseSize() > 0 ? Object.keys(turnsMap) : [];');
    expect(ingest).toContain('var rebuildIncomingIds = collectTurnIds(parsed);');
    expect(ingest).toContain('function collectTurnIds(list)');
    expect(ingest).toContain('function hasUsableTurnIds(ids)');
    expect(ingest).toContain('var rebuildIdsUsable = hasUsableTurnIds(rebuildExistingIds) && hasUsableTurnIds(rebuildIncomingIds);');
    // в критерий уходят те же id, что печатает трейс
    expect(ingest).toContain('existingIds: rebuildExistingIds, incomingIds: rebuildIncomingIds');
    expect(ingest).toContain("' блоков_ходов=' + parsed.length +\n      ' ids=[' + rebuildIncomingIds.join(',') + ']'");
    expect(ingest).toContain("' idEvidence=' + (rebuildIdsUsable ? '1' : '0')");
    // старое извлечение «только на vf5-ветке» (пустые массивы → ложный reset) убрано
    expect(ingest).not.toContain('if (baseSize() > 0) rebuildExistingIds = Object.keys(turnsMap);');
    expect(ingest).not.toContain('rebuildIncomingIds.push(parsed[rbi] && parsed[rbi].id);');
    expect(ingest).not.toContain('parsed.map(function (x) { return x.id; }).join');
    // fail-closed guard и честная причина
    expect(ingest).toContain('if (fullRebuildFromVf5 && baseSize() > 0 && !rebuildIdsUsable) {');
    expect(ingest).toContain("reason = 'vf5-no-id-evidence-no-reset'");
    // O-51-страховка уровня вызова не тронута
    expect(ingest).toContain('if (fullRebuildFromVf5 && incomingIsSubsetOfBase) fullRebuildFromVf5 = false;');
    // O-51b-фикс 3: фолбэк без модуля логики снова учитывает курсор (контракт v32 целиком)
    expect(ingest).toContain('fullRebuildFromVf5 = !!(fromVirtualF5 && wasFull && !pendingCursor);');
    expect(ingest).not.toContain('fullRebuildFromVf5 = !!(fromVirtualF5 && wasFull);');
    // O-51b-фикс 3b: фолбэк без модуля не откатывает счётчик порядка страницы
    expect(ingest).toContain('orderState.orderCounter = orderCounter;');
    // модуль логики: отклонение негодного свидетельства
    expect(LOGIC_SRC).toContain('isSubsetIds: isSubsetIds');
    expect(LOGIC_SRC).toContain('shouldFullRebuild: shouldFullRebuild');
    expect(LOGIC_SRC).toContain('shouldDisjointReset: shouldDisjointReset');

    // инвентарь пинов закрытых задач не тронут (O-48/O-49/O-50/O-51/O-52)
    const count = (rel) => (read(rel).match(/^\s*test\(/gm) || []).length;
    expect(count('tests/adapters/o48-gemini-parse-fail-salvage.test.js')).toBe(16);
    expect(count('tests/adapters/o49-gemini-deepresearch-lowconfidence.test.js')).toBe(15);
    expect(count('tests/adapters/o50-gemini-char-frame-slice.test.js')).toBe(10);
    expect(count('tests/adapters/o51-gemini-vf5-subset-merge.test.js')).toBe(11);
    expect(count('tests/adapters/o52-gemini-json-boundary.test.js')).toBe(12);
    // ключевые строки фиксов соседей целы
    const parse = fnDecl(CORE, 'parseByBytes');
    expect(parse).toContain('var end = pos + n; if (end > bytes.length) end = bytes.length;'); // O-48
    expect(parse).toContain('raw.slice(pos, end)');                                             // O-50
    expect(parse).toContain('extractJsonPayload');                                              // O-52
    expect(read('core/export-manager.js')).toContain('aiCmCollectExportSource');                // O-49
  });
});
