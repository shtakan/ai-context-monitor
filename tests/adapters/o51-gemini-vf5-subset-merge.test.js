/**
 * O-51 (High): vf5-subset reset — монотонный union в решателе базы Gemini.
 *
 * Живой прогон 2026-09-25 (чат 8f1343975188be5d): база 36 ходов → 20, метрика 39% → 10%.
 * Корень: `fullRebuildFromVf5` (v32) сбрасывал `turnsMap` по ФОРМЕ снапшота — «vf5 без
 * курсора продолжения = полная история». Усечённый (виртуализированный) vf5-ответ той же
 * формы (20 ходов из 36, все id уже собраны) сбрасывал накопленное и не добавлял ни одного
 * нового хода: reason `full-rebuild-vf5-no-cursor` (core/gemini-intercept.js:4430 прежней
 * нумерации). Форма и «полная история» неразличимы — различает только пересечение множеств id.
 *
 * Фикс: content-критерий «снапшот ⊆ база» (`isSubsetIds` в utils/gemini-intercept-logic.js),
 * при котором пересборка ЗАПРЕЩЕНА и идёт stable merge (merge-by-id: база сохраняется
 * целиком, ходы снапшота, которых в базе нет, добавляются из его хвоста). Плюс страховка
 * уровня вызова в ingest (модуль логики стар/недоступен) и честный reason в merge-decision.
 *
 * Пины:
 *   D1 снапшот-подмножество НЕ вызывает reset: чистая функция (`isSubsetIds` +
 *      `shouldFullRebuild` с id) И реальный решатель ingest (turnsMap не сброшен,
 *      reason=vf5-subset-no-reset вместо full-rebuild-vf5-no-cursor);
 *   D2 база сохраняет ВСЕ 36 ходов: ходы, которых нет во входящем снапшоте, живы; новых
 *      ходов 0 (снапшот не принёс ничего); монотонность union — при отказе сброса по другой
 *      причине (tape-protect) новые id снапшота ДОБАВЛЯЮТСЯ к базе из его хвоста (36 → 38);
 *   R1 регресс O-48/O-49/O-50 цел: байтовый клэмп, guard ≤ 200, символьный срез O-50,
 *      одна точка JSON.parse/handleOuter, счётчики пинов 16/15/10 в файлах не тронуты;
 *   R2 легитимные сбросы работают: vf5-снапшот с НОВЫМИ id (не подмножество) → прежний
 *      `full-rebuild-vf5-no-cursor` (turnsMap сброшен); disjointFlag=true (нулевое пересечение
 *      id, cross-conv) → `action=disjoint-reset` (база сброшена, convEpoch++);
 *   S  source-пины проводки: `isSubsetIds` зовётся из ingest, есть фолбэк без модуля логики,
 *      критерий не подменён счётным сравнением длины.
 *
 * Тесты исполняют РЕАЛЬНЫЙ код core/gemini-intercept.js (извлечённый блок решателя
 * `disjointGuardSrc … refreshMinOrderTracking`) и РЕАЛЬНЫЙ модуль utils/gemini-intercept-logic.js
 * — не копии логики. НЕ ТРОГАЕТСЯ: tolerant-salvage O-48, единая точка сбора O-49,
 * символьный срез O-50, санация O-20/O-40/O-42, D-O41, badge-метрика O-47, CHANGELOG/версия.
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
// Границы: disjoint-guard → O-51-критерий → fullRebuildFromVf5 → tape-protect → reset →
// merge-decision diag IIFE → merge по id → refreshMinOrderTracking → лог new-turns.
function extractDecideAndMerge() {
  const START = "var disjointGuardSrc = (src === 'vf5' || src === 'passive');";
  const END_MARK = "new-turns +' + added";
  const i = CORE.indexOf(START);
  expect(i).toBeGreaterThan(-1);
  const mark = CORE.indexOf(END_MARK, i);
  expect(mark).toBeGreaterThan(-1);
  const logEnd = CORE.indexOf('\n', CORE.indexOf(';', mark)); // конец строки лога new-turns
  const j = CORE.indexOf('\n', logEnd + 1);                  // + закрывающая скобка if (added > 0)
  expect(j).toBeGreaterThan(logEnd);
  const block = CORE.slice(i, j);
  expect(block).toContain('incomingIsSubsetOfBase');
  expect(block).toContain('reason = \'vf5-subset-no-reset\'');
  expect(block).toContain('reason = \'full-rebuild-vf5-no-cursor\'');
  return block;
}
const SNIPPET = extractDecideAndMerge();
const MERGE_DECLS = fnDecl(CORE, 'refreshMinOrderTracking');

// ---- модель базы 36 ходов (живой прогон: 36 → 20) ----
const BASE_SIZE = 36;
function idOf(i) { return 'r_' + String(i).padStart(4, '0') + '_assistant'; }
function baseIds() { const a = []; for (let i = 0; i < BASE_SIZE; i++) a.push(idOf(i)); return a; }
function tailIds(from) { const a = []; for (let i = from; i < BASE_SIZE; i++) a.push(idOf(i)); return a; }
function freshIds(from, to) { const a = []; for (let i = from; i < to; i++) a.push(idOf(i)); return a; }
function turnsOf(ids) {
  return ids.map((id) => ({ id: id, text: 'ход ' + id, modelName: 'Gemini', role: 'assistant', ts: 0, r1: null }));
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
    // входящий снапшот (vf5 без курсора продолжения по умолчанию)
    src: 'vf5',
    fromVirtualF5: true,
    wasFull: true,
    pendingCursor: null,
    parsed: turnsOf(tailIds(16)), // 20 ходов хвоста базы — все id уже собраны
    preTurns: null,
    fromActivePaginate: false,
    shouldRebuild: false, // v25/v26: realtime-пересборка ветки (opts.rebuild) — не предмет O-51
    // состояние базы
    turnsMap: baseTurnsMap(),
    orderCounter: BASE_SIZE,
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

describe('O-51 (D1): снапшот-подмножество не имеет права на reset — чистая функция', () => {
  test('D1: isSubsetIds — контракт множеств (подмножество / новое / пусто / без id)', () => {
    const existing = baseIds();
    expect(LOGIC.isSubsetIds(tailIds(16), existing)).toBe(true);        // 20 из 36 — подмножество
    expect(LOGIC.isSubsetIds(existing, existing)).toBe(true);           // вся база — подмножество
    expect(LOGIC.isSubsetIds(freshIds(100, 120), existing)).toBe(false); // новых 20 — не подмножество
    expect(LOGIC.isSubsetIds(tailIds(16).concat(['r_new']), existing)).toBe(false); // хвост + новый
    expect(LOGIC.isSubsetIds([], existing)).toBe(false);                // пустой вход
    expect(LOGIC.isSubsetIds(tailIds(16), [])).toBe(false);             // пустая база
    expect(LOGIC.isSubsetIds([undefined, undefined], existing)).toBe(false); // снапшот без id
    expect(LOGIC.isSubsetIds(tailIds(16).concat(tailIds(16)), existing)).toBe(true); // дубли
    expect(LOGIC.isSubsetIds(null, existing)).toBe(false);
  });

  test('D1: shouldFullRebuild с id — подмножество запрещает reset, новый ход разрешает', () => {
    const opts = { fromVirtualF5: true, wasFull: true, hasCursor: false, existingIds: baseIds() };
    expect(LOGIC.shouldFullRebuild(Object.assign({ incomingIds: tailIds(16) }, opts))).toBe(false);
    expect(LOGIC.shouldFullRebuild(Object.assign({ incomingIds: freshIds(100, 120) }, opts))).toBe(true);
    expect(LOGIC.shouldFullRebuild(Object.assign({ incomingIds: tailIds(16).concat(['r_new']) }, opts))).toBe(true);
    // контракт без id не изменился (v32): курсор/не-vf5/не-full
    expect(LOGIC.shouldFullRebuild({ fromVirtualF5: true, wasFull: true, hasCursor: true })).toBe(false);
    expect(LOGIC.shouldFullRebuild({ fromVirtualF5: true, wasFull: true, hasCursor: false })).toBe(true);
    expect(LOGIC.shouldFullRebuild({ fromVirtualF5: false, wasFull: true, hasCursor: false })).toBe(false);
    expect(LOGIC.shouldFullRebuild({ fromVirtualF5: true, wasFull: false, hasCursor: false })).toBe(false);
  });
});

describe('O-51 (D1+D2): реальный решатель ingest — база 36 не стирается снапшотом 20', () => {
  test('D1: reason=vf5-subset-no-reset вместо full-rebuild-vf5-no-cursor, turnsMap НЕ сброшен', () => {
    const ctx = runDecideAndMerge(makeCtx({}));
    const log = ctx.logs.join('\n');

    // решение: merge, причина названа честно; сброса нет
    expect(log).toContain('reason=vf5-subset-no-reset');
    expect(log).not.toContain('reason=full-rebuild-vf5-no-cursor');
    expect(log).toContain('action=merge incomingSrc=vf5');
    // числа в логе — из живого сценария (36 собрано, 20 пришло, 20 пересеклось)
    expect(log).toContain('existingMsgs=36 incomingMsgs=20 overlapCount=20');
    expect(log).toContain('disjointFlag=false');
    // счётчики базы не сброшены (reset откатил бы orderCounter в 0 и стёр порядок ходов)
    expect(ctx.turnsMap[idOf(0)].order).toBe(0);
    expect(ctx.turnsMap[idOf(35)].order).toBe(35);
    expect(ctx.orderCounter).toBeGreaterThanOrEqual(BASE_SIZE);
    expect(ctx.prependCursor).toBe(-1);
    expect(ctx.convEpoch).toBe(1);
  });

  test('D2: база сохраняет ВСЕ 36 ходов, новых не появляется (снапшот не принёс ничего)', () => {
    const ctx = runDecideAndMerge(makeCtx({}));
    const ids = Object.keys(ctx.turnsMap);

    expect(ids).toHaveLength(BASE_SIZE);
    // ходы, которых НЕТ во входящем снапшоте (первые 16), живы и не тронуты
    for (let i = 0; i < 16; i++) {
      expect(ctx.turnsMap[idOf(i)]).toBeDefined();
      expect(ctx.turnsMap[idOf(i)].text).toBe('ход ' + idOf(i));
    }
    // ходы снапшота тоже на месте → потеря невозможна ни с одной стороны
    tailIds(16).forEach((id) => expect(ctx.turnsMap[id]).toBeDefined());
    // новых ходов 0: снапшот — подмножество, добавлять нечего
    expect(ctx.logs.join('\n')).not.toContain('new-turns +');
  });

  test('D2 (монотонность union): отказ сброса по другой причине → хвост снапшота ДОБАВЛЯЕТСЯ', () => {
    // tape-protect блокирует пересборку независимо от O-51: критерий — merge (не reset),
    // и ходы снапшота, которых в базе нет, вливаются из его хвоста (36 + 2 = 38).
    const snapshot = turnsOf(tailIds(16).concat(['r_new_a', 'r_new_b']));
    const ctx = runDecideAndMerge(makeCtx({
      tapeWasUsedInThisColdStart: true,
      parsed: snapshot
    }));
    const log = ctx.logs.join('\n');

    expect(log).toContain('reason=tape-protect-no-rebuild');
    expect(log).not.toContain('reason=full-rebuild-vf5-no-cursor');
    expect(Object.keys(ctx.turnsMap)).toHaveLength(BASE_SIZE + 2);
    expect(ctx.turnsMap['r_new_a']).toBeDefined();
    expect(ctx.turnsMap['r_new_b']).toBeDefined();
    for (let i = 0; i < BASE_SIZE; i++) expect(ctx.turnsMap[idOf(i)]).toBeDefined();
    expect(log).toContain('new-turns +2');
  });
});

describe('O-51 (R2): легитимные сбросы работают как прежде', () => {
  test('R2: vf5-снапшот с НОВЫМИ id (не подмножество) → прежний полный reset', () => {
    const ctx = runDecideAndMerge(makeCtx({ parsed: turnsOf(freshIds(100, 120)) }));
    const log = ctx.logs.join('\n');

    expect(log).toContain('reason=full-rebuild-vf5-no-cursor');
    expect(log).not.toContain('reason=vf5-subset-no-reset');
    expect(Object.keys(ctx.turnsMap)).toHaveLength(20);
    expect(ctx.orderCounter).toBe(20); // сброшен в 0, затем 20 свежих ходов
    expect(ctx.prependCursor).toBe(-1);
  });

  test('R2: disjointFlag=true (нулевое пересечение id, cross-conv) → disjoint-reset базы', () => {
    const ctx = runDecideAndMerge(makeCtx({
      parsed: turnsOf(freshIds(100, 120)),
      getConvId: function () { return ''; } // cross-conv: v64-шорткат не действует
    }));
    const log = ctx.logs.join('\n');

    expect(log).toContain('action=disjoint-reset');
    expect(log).toContain('disjoint-reset convId=(none)');
    expect(ctx.convEpoch).toBe(2);
    expect(Object.keys(ctx.turnsMap)).toHaveLength(20); // сброс + ingest чужого снапшота
    expect(log).not.toContain('reason=vf5-subset-no-reset');
  });

  test('R1 (не трогать): vf5 с курсором продолжения — merge по id, O-51 не вмешивается', () => {
    const ctx = runDecideAndMerge(makeCtx({ pendingCursor: 'cursor-xyz' }));
    const log = ctx.logs.join('\n');

    expect(log).toContain('reason=vf5-cursor-continue');
    expect(log).not.toContain('reason=vf5-subset-no-reset');
    expect(log).not.toContain('reason=full-rebuild-vf5-no-cursor');
    expect(Object.keys(ctx.turnsMap)).toHaveLength(BASE_SIZE);
  });
});

describe('O-51 (S/R1): source-пины проводки и инвентарь регресса O-48/O-49/O-50', () => {
  test('S: ingest зовёт isSubsetIds и имеет фолбэк без модуля логики', () => {
    const ingest = fnDecl(CORE, 'ingest');
    expect(ingest).toContain('window.GeminiInterceptLogic.isSubsetIds(rebuildIncomingIds, rebuildExistingIds)');
    expect(ingest).toContain('if (fullRebuildFromVf5 && incomingIsSubsetOfBase) fullRebuildFromVf5 = false;');
    expect(ingest).toContain('existingIds: rebuildExistingIds, incomingIds: rebuildIncomingIds');
    // фолбэк: критерий решается и без модуля (страховка от старой сборки логики)
    expect(ingest).toContain('incomingIsSubsetOfBase = true;');
    expect(ingest).toContain('if (!rbid || !rebuildSeen[rbid]) { incomingIsSubsetOfBase = false; break; }');
    // критерий по ПЕРЕСЕЧЕНИЮ id, а не по числу ходов (счётное сравнение — корень дефекта)
    expect(ingest).not.toContain('parsed.length < baseSize()');
    expect(ingest).not.toContain('parsed.length <= diagExistingBefore');
    expect(LOGIC_SRC).toContain('isSubsetIds: isSubsetIds');
  });

  test('R1: решатель по-прежнему исполняет reset только по vf5-форме и disjoint-критерию', () => {
    expect(LOGIC_SRC).toContain('shouldDisjointReset: shouldDisjointReset');
    expect(LOGIC_SRC).toContain('shouldFullRebuild: shouldFullRebuild');
    expect(SNIPPET).toContain('tape-protect-no-rebuild');
    expect(SNIPPET).toContain("reason = 'vf5-cursor-continue'");
    expect(SNIPPET).toContain('zero-id-overlap');
  });

  test('R1: инвентарь — пины O-48 (16), O-49 (15), O-50 (10) в файлах не тронуты', () => {
    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const o48 = read('tests/adapters/o48-gemini-parse-fail-salvage.test.js');
    const o49 = read('tests/adapters/o49-gemini-deepresearch-lowconfidence.test.js');
    const o50 = read('tests/adapters/o50-gemini-char-frame-slice.test.js');
    expect((o48.match(/^\s*test\(/gm) || []).length).toBe(16);
    expect((o49.match(/^\s*test\(/gm) || []).length).toBe(15);
    expect((o50.match(/^\s*test\(/gm) || []).length).toBe(10);
    // O-48: байтовый клэмп/лимиты и tolerant-salvage целы
    const parse = fnDecl(CORE, 'parseByBytes');
    expect(parse).toContain('var end = pos + n; if (end > bytes.length) end = bytes.length;');
    expect(parse).toContain('while (pos < bytes.length && guard++ < 200) {');
    expect(parse).toContain('salvagePartialFrame(payloadStr, out, src)');
    // O-50: срез кадра — в символьном пространстве, TextEncoder только в legacy-ветке
    expect(parse).toContain('raw.slice(pos, end)');
    expect(parse).toContain('framingStrictScore(utf8Try).score > charFit.score');
    // O-49: единая точка сбора на пути записи снимка не переписана
    expect(read('core/export-manager.js')).toContain('aiCmCollectExportSource');
  });
});
