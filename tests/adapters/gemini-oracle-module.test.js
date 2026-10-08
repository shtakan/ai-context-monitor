/**
 * Phase 3 шаг 13.3 — пины кластера оракула полноты (core/gemini-oracle.js).
 *
 * Контекст. Оракул полноты вынесен из core/gemini-intercept.js в core/gemini-oracle.js
 * БЕЗ изменения логики: пять функций и один слушатель перенесены байт-в-байт, ссылки на
 * имена ядра остались ГОЛЫМИ (объявления лежат внутри `with (D) { … }`, объект связи
 * заполняет __bind из ядра), а в начало слушателя добавлен гард `if (!D)`. Пины здесь
 * четырёх родов:
 *
 *   A (состояние) — floorConfirmDebounceTimer, вердикты полноты (historyFullByQuiet,
 *     reachedStart, quietIncompleteNoStart, lastCycleEndedHidden, quietEndedClean,
 *     oracleIncompleteSeen, lastLoaderDoneReason), счётчики базы (lastBaseCount,
 *     lastBaseCountChangeAt) и входы оракула (pendingCursor, lastIngestParseFail,
 *     lastOlderNonPagAddAt, turnsMap, loaderRunningFor, quietActive, reachedStartByScroll,
 *     loaderState, lastHnvPageError, lastBaseTextLen) остаются в ЯДРЕ: их читают и пишут
 *     ingest, лоадер, пагинация, сетевые хуки и сброс при смене чата. Модуль получает их
 *     ЖИВЫМИ геттерами (и сеттерами там, где пишет). Регрессия = вторая переменная
 *     в модуле: вердикт полноты осел бы в копии, и ядро его не увидело бы.
 *   B (форвардеры) — пять имён (noteBaseCountChange, notifyLoaderState, aiCmDiagHash6,
 *     aiCmDiagTurnEdge, aiCmOrderedTurns) в ядре обязаны быть hoisted function declaration:
 *     их значения раздаются чужим __bind-блокам (diag, rpc/parse, лоадер, пагинация, архив)
 *     и вызываются из ядра (checkConvChange) — в том числе ДО строки связки. var-выражение
 *     сломало бы это. Без модуля все пять деградируют в undefined, не бросая.
 *   C (байт-идентичность) — тела обязаны остаться теми же строками, что были в ядре: шесть
 *     существующих пинов (gemini-floor-confirmed, gemini-floor-self-heal,
 *     gemini-floor-monotonic-h11, gemini-collapse-guard, o48-gemini-parse-fail-salvage,
 *     gemini-dr-report) режут их из конкатенации по маркерам и исполняют в песочнице.
 *     Здесь проверяется, что маркеры по-прежнему разрешаются, а сами тела лежат в модуле.
 *   D (API/размещение/гигиена) — блок подключения стоит между блоком архива и
 *     installNetworkHooks(), ниже поздних алиасов (> 782); API полон; повторная загрузка
 *     модуля не перетирает API; без связки слушатель не бросает, а логирует.
 *
 *   S (проводка) — модуль реально подключён и связан с ядром:
 *     S1  регистрация в core/background.js: id -v11, модуль в js[] строго между archive
 *         и ядром, -v10 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
 *     S2  bind-контракт полон: 32 имени (10 fn + 10 rw + 12 ro) переданы ядром в блоке
 *         __bind ровно с теми видами связи, а два typeof-гарда тела обязаны быть привязаны;
 *     S3  порядок в helper-конкатенации повторяет порядок js[], контракт трекается в git;
 *     S4  тела резолвят имена через `with (D)`: D.-префиксов в модуле нет, а имена ядра
 *         встречаются голыми — иначе песочницы существующих пинов перестали бы работать.
 *
 * ВАЖНО: существующие пины Gemini НЕ трогались по существу — тела перенесены байт-в-байт,
 * и это здесь доказано (блок C). Обновлены только пины регистрации (id -v10 → -v11, литерал
 * js[]), строка VF5_TAIL (1680 → 1446) и счётчики emitBaseSnapshot (ядро 3 → 1).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = require(path.join(ROOT, 'tests/helpers/gemini-intercept-source.js'));
const CONC = SRC.geminiSource;
const CORE = readFile('core/gemini-intercept.js');
const MOD = readFile('core/gemini-oracle.js');
const CONTRACT = require(path.join(ROOT, 'tools/oracle-bind-contract.js'));

/** Функции, которые модуль отдаёт наружу (порядок — как в Fn-экспорте). */
const EXPORTED = ['noteBaseCountChange', 'notifyLoaderState', 'aiCmDiagHash6',
  'aiCmDiagTurnEdge', 'aiCmOrderedTurns'];
/** Тело, уехавшее в модуль и НЕ оставшееся в ядре даже форвардером (его зовёт таймер debounce). */
const INTERNAL = ['stableFloorConfirm'];
/** Все шесть тел, перенесённых в модуль. */
const MOVED = INTERNAL.concat(EXPORTED);
/** Состояние, которое ОБЯЗАНО было остаться в ядре (объявления — как в файле). */
const CORE_STATE = [
  '  var turnsMap = {};',
  '  var quietActive = false;',
  '  var historyFullByQuiet = false;',
  '  var reachedStart = false; // тихая пагинация дошла до начала (курсора больше нет)',
  '  var reachedStartByScroll = false; // v61diag: reachedStart, установленная confirmed-by-scroll лоадера (только диагностика)',
  '  var quietIncompleteNoStart = false;',
  '  var lastCycleEndedHidden = false;',
  '  var pendingCursor = null;',
  '  var lastOlderNonPagAddAt = 0;  // момент последнего старшего добавления вне \'pag\'',
  '  var lastBaseCount = -1;',
  '  var lastBaseCountChangeAt = 0;',
  '  var floorConfirmDebounceTimer = null; // v82: debounce 5500мс (устанавливается в noteBaseCountChange)',
  '  var lastHnvPageError = false;   // выставлен handleOuter при распознании ошибки',
  '  var lastIngestParseFail = null;',
  '  var quietEndedClean = false;',
  '  var lastLoaderDoneReason = \'\'; // v78: done-reason последнего прогона лоадера — гейт stable-stop оракула',
  '  var loaderState = {',
  "  var parserVersion = '';",
  '  var lastBaseTextLen = 0; // фактический textLen последнего эмитнутого снимка базы (для перезаписи пола)',
  '  var lastOrderedIds = []; // последний финальный порядок id из emitBaseSnapshot (для дампа диагностики)',
];
/** Имена контракта, которых тела оракула НЕ читают буквально (шапка контракта, S2). */
const KNOWN_UNUSED = ['lastOrderedIds', 'parserVersion'];
/** Состав контракта по видам связи (S2): фиксированная величина шага 13.3. */
const COMPOSITION_OF_CONTRACT = [
  ['getConvId', 'fn'], ['baseSize', 'fn'], ['loadFloor', 'fn'], ['selfHealFloor', 'fn'],
  ['emitBaseSnapshot', 'fn'], ['aiCmArchiveFor', 'fn'], ['aiCmArchiveLiveProven', 'fn'],
  ['aiCmLiveTurnCount', 'fn'], ['aiCmArchiveTierApply', 'fn'], ['aiCmBaseExportInfo', 'fn'],
  ['historyFullByQuiet', 'rw'], ['reachedStart', 'rw'], ['quietIncompleteNoStart', 'rw'],
  ['lastCycleEndedHidden', 'rw'], ['quietEndedClean', 'rw'], ['oracleIncompleteSeen', 'rw'],
  ['lastLoaderDoneReason', 'rw'], ['lastBaseCount', 'rw'], ['lastBaseCountChangeAt', 'rw'],
  ['floorConfirmDebounceTimer', 'rw'],
  ['pendingCursor', 'ro'], ['lastIngestParseFail', 'ro'], ['lastOlderNonPagAddAt', 'ro'],
  ['turnsMap', 'ro'], ['lastOrderedIds', 'ro'], ['parserVersion', 'ro'], ['loaderRunningFor', 'ro'],
  ['quietActive', 'ro'], ['reachedStartByScroll', 'ro'], ['loaderState', 'ro'],
  ['lastHnvPageError', 'ro'], ['lastBaseTextLen', 'ro']
];
/** Слушатель, уехавший вместе с кластером. */
const LISTENER = 'ai-cm-turns-snap-request';
const GUARD = "if (!D) { debugLog('error', '[gemini-oracle] D is null, event ignored'); return; }";
/** Свободные глобалы MAIN-мира: их typeof-гарды контрактом не покрываются. */
const GLOBAL_NAMES = ['window', 'document', 'module', 'self', 'globalThis'];

/** Вырезает `function <name>(…) { … }` по балансу скобок. */
function fnSource(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}

/** Код без комментариев: проза шапки и баннеров упоминает имена как прозу, а не ссылки. */
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
const CORE_CODE = codeOf(CORE);
const MOD_CODE = codeOf(MOD);

function bareCount(src, name) {
  return (src.match(new RegExp('(^|[^\\w$.])' + name + '(?![\\w$])', 'g')) || []).length;
}
function lineOf(src, lit) {
  return src.split('\n').findIndex((l) => l.indexOf(lit) !== -1) + 1;
}

/** Блок `aiCmGeminiOracle.__bind({...})` ядра — как строка. */
function bindBlockText() {
  const at = CORE.indexOf('aiCmGeminiOracle.__bind(');
  expect(at).toBeGreaterThan(-1);
  const end = CORE.indexOf('\n  } else {', at);
  expect(end).toBeGreaterThan(at);
  return CORE.slice(at, end);
}

/** Грузит РЕАЛЬНЫЙ модуль в свежий vm-контекст и возвращает его API + живые обработчики. */
function loadModule() {
  const pageWindow = {
    listeners: [],
    handlers: {},
    dispatched: [],
    addEventListener: function (t, fn) { this.listeners.push(t); this.handlers[t] = fn; },
    dispatchEvent: function (ev) { this.dispatched.push(ev); }
  };
  const timers = { pending: [], cleared: 0 };
  const logs = [];
  const ctx = vm.createContext({
    window: pageWindow,
    console,
    document: { visibilityState: 'visible' },
    CustomEvent: function (type, opts) { this.type = type; this.detail = opts && opts.detail; },
    setTimeout: function (fn, ms) { timers.pending.push({ fn: fn, ms: ms }); return timers.pending.length; },
    clearTimeout: function () { timers.cleared++; },
    debugLog: function (level, msg) { logs.push([level, msg]); }
  });
  vm.runInContext(MOD, ctx, { filename: 'core/gemini-oracle.js' });
  return { pageWindow, ctx, api: pageWindow.AiCmGeminiOracle, timers, logs };
}

/** Исполняет РЕАЛЬНЫЙ форвардер ядра в песочнице с заданным модулем. */
function runForwarder(name, args, oracleApi, baseSizeFn) {
  const src = fnSource(CORE, name);
  expect(src).not.toBeNull();
  const ctx = vm.createContext({
    aiCmGeminiOracle: oracleApi,
    baseSize: baseSizeFn || function () { return 0; },
    args: args,
    out: 'UNSET'
  });
  vm.runInContext('out = (' + src + ').apply(null, args);', ctx);
  return ctx.out;
}

/** Живое состояние «ядра» для runtime-пинов (A4): те же имена, что объявлены в ядре. */
function liveState() {
  const now = Date.now();
  const live = {
    historyFullByQuiet: false,
    reachedStart: false,
    quietIncompleteNoStart: true,
    lastCycleEndedHidden: false,
    quietEndedClean: false,
    oracleIncompleteSeen: { c1: true },
    lastLoaderDoneReason: 'top',
    lastBaseCount: 120,
    lastBaseCountChangeAt: now - 6000,
    floorConfirmDebounceTimer: null,
    logs: [],
    emits: 0,
    tierApplies: 0,
    baseExportInfo: 0
  };
  live.D = {
    getConvId: () => 'c1',
    baseSize: () => live.lastBaseCount,
    loadFloor: () => ({ count: 120, effectiveLen: 5000 }),
    selfHealFloor: () => null,
    emitBaseSnapshot: () => { live.emits++; },
    aiCmArchiveFor: () => null,
    aiCmArchiveLiveProven: () => true,
    aiCmLiveTurnCount: () => live.lastBaseCount,
    aiCmArchiveTierApply: () => { live.tierApplies++; },
    aiCmBaseExportInfo: () => { live.baseExportInfo++; return { baseMsgs: 1, liveCount: 1, archiveCount: 0, liveProven: true, messages: [] }; },
    get pendingCursor() { return null; },
    get lastIngestParseFail() { return null; },
    get lastOlderNonPagAddAt() { return now - 6000; },
    get turnsMap() { return { a: { order: 1, text: 'x' } }; },
    get lastOrderedIds() { return ['a']; },
    get parserVersion() { return 'g-oracle'; },
    get loaderRunningFor() { return null; },
    get quietActive() { return false; },
    get reachedStartByScroll() { return false; },
    get loaderState() { return { scrollEngaged: true }; },
    get lastHnvPageError() { return false; },
    get lastBaseTextLen() { return 4321; },
    get historyFullByQuiet() { return live.historyFullByQuiet; },
    set historyFullByQuiet(v) { live.historyFullByQuiet = v; },
    get reachedStart() { return live.reachedStart; },
    set reachedStart(v) { live.reachedStart = v; },
    get quietIncompleteNoStart() { return live.quietIncompleteNoStart; },
    set quietIncompleteNoStart(v) { live.quietIncompleteNoStart = v; },
    get lastCycleEndedHidden() { return live.lastCycleEndedHidden; },
    set lastCycleEndedHidden(v) { live.lastCycleEndedHidden = v; },
    get quietEndedClean() { return live.quietEndedClean; },
    set quietEndedClean(v) { live.quietEndedClean = v; },
    get oracleIncompleteSeen() { return live.oracleIncompleteSeen; },
    set oracleIncompleteSeen(v) { live.oracleIncompleteSeen = v; },
    get lastLoaderDoneReason() { return live.lastLoaderDoneReason; },
    set lastLoaderDoneReason(v) { live.lastLoaderDoneReason = v; },
    get lastBaseCount() { return live.lastBaseCount; },
    set lastBaseCount(v) { live.lastBaseCount = v; },
    get lastBaseCountChangeAt() { return live.lastBaseCountChangeAt; },
    set lastBaseCountChangeAt(v) { live.lastBaseCountChangeAt = v; },
    get floorConfirmDebounceTimer() { return live.floorConfirmDebounceTimer; },
    set floorConfirmDebounceTimer(v) { live.floorConfirmDebounceTimer = v; }
  };
  return live;
}

describe('Phase 3 шаг 13.3: A-пины — состояние оракула осталось в ЯДРЕ', () => {
  test('A1: переменные состояния объявлены в ядре байт-в-байт и НЕ перенесены в модуль', () => {
    CORE_STATE.forEach((lit) => expect(CORE).toContain(lit));
    const names = CONTRACT.map(([n]) => n);
    expect(names).toHaveLength(32);
    names.forEach((n) => {
      // модуль не объявляет их заново: иначе появилась бы ВТОРАЯ переменная, и ядро
      // (ingest/лоадер/пагинация) читало бы старую — вердикт полноты терялся бы молча
      expect(MOD_CODE).not.toMatch(new RegExp('\\bvar\\s+' + n + '\\b'));
      expect(MOD_CODE).not.toMatch(new RegExp('\\blet\\s+' + n + '\\b'));
      expect(MOD_CODE).not.toMatch(new RegExp('\\bconst\\s+' + n + '\\b'));
    });
  });

  test('A2: блок __bind отдаёт состояние ЖИВЫМИ геттерами/сеттерами, а не копиями', () => {
    const block = bindBlockText();
    const rw = CONTRACT.filter(([, kind]) => kind === 'rw').map(([n]) => n);
    const ro = CONTRACT.filter(([, kind]) => kind === 'ro').map(([n]) => n);
    const fn = CONTRACT.filter(([, kind]) => kind === 'fn').map(([n]) => n);
    expect(rw).toHaveLength(10);
    expect(ro).toHaveLength(12);
    expect(fn).toHaveLength(10);
    rw.forEach((n) => {
      expect(block).toContain('get ' + n + '() { return ' + n + '; }');
      expect(block).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });
    ro.forEach((n) => {
      expect(block).toContain('get ' + n + '() { return ' + n + '; }');
      expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\('));
    });
    fn.forEach((n) => expect(block).toContain(n + ': ' + n + ','));
    // связка идёт ПОСЛЕ объявления состояния: геттеры замкнуты на инициализированные
    // переменные, а не на undefined-на-момент-hoisting
    expect(CORE.indexOf('aiCmGeminiOracle.__bind(')).toBeGreaterThan(CORE.indexOf(CORE_STATE[0]));
    // таймер debounce объявлен В ЯДРЕ (строка выше связки) — иначе геттер/сеттер ссылались
    // бы на необъявленное имя и бросали ReferenceError
    expect(lineOf(CORE, 'var floorConfirmDebounceTimer = null;'))
      .toBeLessThan(lineOf(CORE, 'aiCmGeminiOracle.__bind('));
  });

  test('A4: вердикт и таймер из модуля доходят до ЖИВЫХ переменных ядра (rw вживую)', () => {
    const live = liveState();
    const sandbox = loadModule();
    sandbox.api.__bind(live.D);

    // noteBaseCountChange: метка изменения базы + debounce 5500мс в ЖИВУЮ переменную ядра
    sandbox.api.noteBaseCountChange();
    expect(live.floorConfirmDebounceTimer).toBe(1); // setTimeout-стаб вернул 1
    expect(sandbox.timers.pending).toHaveLength(1);
    expect(sandbox.timers.pending[0].ms).toBe(5500);
    expect(sandbox.timers.pending[0].fn.name).toBe('stableFloorConfirm');

    // повторный вызов отменяет прежний таймер (clearTimeout по живому значению)
    sandbox.api.noteBaseCountChange();
    expect(sandbox.timers.cleared).toBe(1);

    // истечение debounce на стабильной базе: floor-confirmed взводит полноту В ЯДРЕ
    sandbox.timers.pending[1].fn();
    expect(live.historyFullByQuiet).toBe(true);
    expect(live.reachedStart).toBe(true);
    expect(live.quietIncompleteNoStart).toBe(false);
    expect(live.oracleIncompleteSeen.c1).toBeUndefined();
    expect(live.emits).toBe(1);
    const joined = live.logs.concat(sandbox.logs).map((x) => String(x[1])).join('\n');
    expect(joined).toContain('oracle=complete reason=floor-confirmed');
  });

  test('A5: notifyLoaderState пишет вердикты в ядро и объявляет состояние наружу по convId', () => {
    const live = liveState();
    const sandbox = loadModule();
    sandbox.api.__bind(live.D);
    sandbox.api.notifyLoaderState('c1', false);
    // ре-оценка яруса архива ДО dispatch (T1-fix) и вердикт loader-stable-stop (done='top')
    expect(live.tierApplies).toBe(1);
    expect(live.historyFullByQuiet).toBe(true);
    expect(live.reachedStart).toBe(true);
    expect(live.emits).toBe(1);
    const ev = sandbox.pageWindow.dispatched.filter((e) => e.type === 'ai-cm-loader-state');
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toEqual({ convId: 'c1', running: false, pendingCursor: false, baseComplete: true, reachedStart: true });
  });

  test('A6: снимок turnsMap отдаёт объединённую базу и живые вердикты ядра', () => {
    const live = liveState();
    const sandbox = loadModule();
    sandbox.api.__bind(live.D);
    const snap = sandbox.pageWindow.__aiCmGeminiTurnsSnapshot();
    expect(snap.convId).toBe('c1');
    expect(snap.msgs).toBe(1);
    expect(snap.baseComplete).toBe(false);
    expect(snap.confirmedByScroll).toBe(false);
    expect(snap.scrollEngaged).toBe(true);          // живой loaderState ядра
    expect(snap.baseMsgs).toBe(1);                  // объединённая база архива
    expect(live.baseExportInfo).toBe(1);
    // снимок идемпотентен: повторная загрузка модуля не перетирает хэндл консоли
    const handle = sandbox.pageWindow.__aiCmGeminiTurnsSnapshot;
    vm.runInContext(MOD, sandbox.ctx, { filename: 'core/gemini-oracle.js (повторно)' });
    expect(sandbox.pageWindow.__aiCmGeminiTurnsSnapshot).toBe(handle);
  });
});

describe('Phase 3 шаг 13.3: B-пины — форвардеры ядра (hoisting + делегирование)', () => {
  test('B1: все пять форвардеров — function declaration, ровно по одному объявлению', () => {
    EXPORTED.forEach((n) => {
      expect(CORE).toMatch(new RegExp('\\n  function ' + n + '\\('));
      expect((CORE_CODE.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || [])).toHaveLength(1);
      // форвардер — ровно одна строка; тела в ядре нет
      expect(fnSource(CORE, n).split('\n')).toHaveLength(1);
    });
    expect(fnSource(CORE, 'noteBaseCountChange')).toBe(
      'function noteBaseCountChange() { return aiCmGeminiOracle ? aiCmGeminiOracle.noteBaseCountChange() : undefined; }'
    );
    expect(fnSource(CORE, 'notifyLoaderState')).toBe(
      'function notifyLoaderState(convId, running) { return aiCmGeminiOracle ? aiCmGeminiOracle.notifyLoaderState(convId, running) : undefined; }'
    );
    expect(fnSource(CORE, 'aiCmDiagHash6')).toBe(
      'function aiCmDiagHash6(id, text) { return aiCmGeminiOracle ? aiCmGeminiOracle.aiCmDiagHash6(id, text) : undefined; }'
    );
    expect(fnSource(CORE, 'aiCmDiagTurnEdge')).toBe(
      'function aiCmDiagTurnEdge(turns, which) { return aiCmGeminiOracle ? aiCmGeminiOracle.aiCmDiagTurnEdge(turns, which) : undefined; }'
    );
    expect(fnSource(CORE, 'aiCmOrderedTurns')).toBe(
      'function aiCmOrderedTurns() { return aiCmGeminiOracle ? aiCmGeminiOracle.aiCmOrderedTurns() : undefined; }'
    );
    // var-объявления модуля в ядре нет: только guard-константа
    expect(CORE_CODE).toContain('var aiCmGeminiOracle = (typeof window !== \'undefined\' && window.AiCmGeminiOracle) || null;');
    // форвардеры объявлены ВЫШЕ первого вызова notifyLoaderState (checkConvChange)
    expect(lineOf(CORE, 'function notifyLoaderState(convId, running)'))
      .toBeLessThan(lineOf(CORE, 'notifyLoaderState(oldId, false);'));
  });

  test('B2: форвардер делегирует в модуль и возвращает его результат', () => {
    const calls = [];
    const apiObj = {
      noteBaseCountChange: () => { calls.push(['note']); return 'NOTE'; },
      notifyLoaderState: (c, r) => { calls.push(['loader', c, r]); return 'LOADER'; },
      aiCmDiagHash6: (id, t) => { calls.push(['hash', id, t]); return 'HASH'; },
      aiCmDiagTurnEdge: (t, w) => { calls.push(['edge', t, w]); return 'EDGE'; },
      aiCmOrderedTurns: () => { calls.push(['ordered']); return 'ORDERED'; }
    };
    expect(runForwarder('noteBaseCountChange', [], apiObj)).toBe('NOTE');
    expect(runForwarder('notifyLoaderState', ['c1', true], apiObj)).toBe('LOADER');
    expect(runForwarder('aiCmDiagHash6', ['id1', 'txt'], apiObj)).toBe('HASH');
    expect(runForwarder('aiCmDiagTurnEdge', [[{ id: 'a' }], 'first'], apiObj)).toBe('EDGE');
    expect(runForwarder('aiCmOrderedTurns', [], apiObj)).toBe('ORDERED');
    expect(calls).toEqual([['note'], ['loader', 'c1', true], ['hash', 'id1', 'txt'],
      ['edge', [{ id: 'a' }], 'first'], ['ordered']]);
  });

  test('B3: без модуля форвардеры деградируют мягко (undefined) и не бросают', () => {
    [null, undefined].forEach((api) => {
      expect(runForwarder('noteBaseCountChange', [], api)).toBeUndefined();
      expect(runForwarder('notifyLoaderState', ['c1', false], api)).toBeUndefined();
      expect(runForwarder('aiCmDiagHash6', ['id', 'text'], api)).toBeUndefined();
      expect(runForwarder('aiCmDiagTurnEdge', [[], 'first'], api)).toBeUndefined();
      expect(runForwarder('aiCmOrderedTurns', [], api)).toBeUndefined();
    });
  });

  test('B4: хойстинг реален — значение, взятое ДО объявления модуля, зовёт его', () => {
    // Чужие __bind-блоки (diag, rpc/parse, лоадер, пагинация, архив) получают форвардеры
    // ЗНАЧЕНИЕМ и биндуются ВЫШЕ объявления var aiCmGeminiOracle — как и checkConvChange,
    // который зовёт notifyLoaderState. Порядок ровно как в ядре: значение берут до связки.
    const fwd = fnSource(CORE, 'notifyLoaderState');
    const ctx = vm.createContext({});
    vm.runInContext([
      'var captured = notifyLoaderState;',
      "var aiCmGeminiOracle = { notifyLoaderState: function (c, r) { return 'FROM-MODULE:' + c + ':' + r; } };",
      fwd,
      "out = captured('c9', true);"
    ].join('\n'), ctx);
    expect(ctx.out).toBe('FROM-MODULE:c9:true');
    // а до связки тот же захваченный указатель деградирует мягко, не бросая
    const ctx2 = vm.createContext({});
    vm.runInContext([
      'var captured = notifyLoaderState;',
      'var aiCmGeminiOracle = null;',
      fwd,
      "out = captured('c9', true);"
    ].join('\n'), ctx2);
    expect(ctx2.out).toBeUndefined();
  });
});

describe('Phase 3 шаг 13.3: C-пины — тела и слушатель перенесены байт-в-байт', () => {
  test('C1: шесть тел живут в модуле; в ядре их нет (кроме однотипных форвардеров)', () => {
    MOVED.forEach((n) => {
      expect(fnSource(MOD, n)).not.toBeNull();
      expect(CONC).toContain('function ' + n + '(');
    });
    INTERNAL.forEach((n) => expect(CORE_CODE).not.toMatch(new RegExp('function\\s+' + n + '\\s*\\(')));
    // stableCheck74 объявлен ВНУТРИ notifyLoaderState: уехал вместе с ней
    expect(MOD).toContain('var stableCheck74 = function () {');
    expect(CORE).not.toContain('var stableCheck74');
    expect(MOD).toContain('setTimeout(stableCheck74, 5000); // повторная проверка через 5с тишины');
  });

  test('C2: тела байтово прежние — ключевые строки с прежними отступами', () => {
    // отступы — часть контракта: пины режут тела из конкатенации и ищут литералы с пробелами
    const lines = [
      '      if (!convIdFc || historyFullByQuiet || loaderRunningFor || quietActive) return;',
      '      if (typeof aiCmArchiveLiveProven === \'function\' && !aiCmArchiveLiveProven(convIdFc)) {',
      '    if (n74 !== lastBaseCount) { lastBaseCount = n74; lastBaseCountChangeAt = Date.now(); }',
      '      if (floorConfirmDebounceTimer) { clearTimeout(floorConfirmDebounceTimer); floorConfirmDebounceTimer = null; }',
      '      floorConfirmDebounceTimer = setTimeout(stableFloorConfirm, 5500);',
      '        lastCycleEndedHidden = (document.visibilityState !== \'visible\'); // v1.13.1',
      '            if (lastLoaderDoneReason !== \'top\') {',
      '            if (lastBaseCountChangeAt && (now74 - lastBaseCountChangeAt) < 5000) return;',
      // E.2a.2a: тело catch инструментировано swallow (LOG-точка P0). Расхождение с
      // до-E.2a.2a эталоном — ровно эта одна строка; отступы, вызов и try сохранены.
      '            try { emitBaseSnapshot(); } catch (eEs74) { swallow(eEs74, \'gemini:stableCheck74-emit\'); }',
      '        stableCheck74();',
      '          scrollEngaged: loaderState.scrollEngaged === true, // v66: скрытый скролл вовлечён?'
    ];
    lines.forEach((l) => expect(MOD).toContain(l));
    // характерные литералы кластера — прежние
    ['oracle=complete reason=floor-confirmed',
      'oracle=complete reason=loader-stable-stop',
      'oracle=incomplete reason=below-floor',
      'oracle=incomplete reason=loader-max-not-top',
      'oracle=incomplete reason=parse-fail',
      'reason=archive-live-pending(clean-end)',
      'floor self-healed (clean-end)',
      'clean-end-stable',
      "if (!window.__aiCmGeminiTurnsSnapshot) {",
      'confirmedByScroll: reachedStartByScroll === true,'
    ].forEach((lit) => expect(MOD).toContain(lit));
    // содержимое мелких тел — целиком (отступы входят в контракт байт-идентичности)
    expect(fnSource(MOD, 'aiCmDiagTurnEdge')).toBe(
      'function aiCmDiagTurnEdge(turns, which) {\n' +
      '    if (!turns || !turns.length) return { hash: \'-\', text: \'\' };\n' +
      '    var t = turns[which === \'last\' ? turns.length - 1 : 0];\n' +
      '    return {\n' +
      '      hash: aiCmDiagHash6(t && t.id, t && t.text),\n' +
      '      text: String((t && t.text) || \'\').slice(0, 80).replace(/\\s+/g, \' \')\n' +
      '    };\n' +
      '  }'
    );
    expect(fnSource(MOD, 'aiCmOrderedTurns')).toBe(
      'function aiCmOrderedTurns() {\n' +
      '    var ids = Object.keys(turnsMap);\n' +
      '    ids.sort(function (a, b) { return (turnsMap[a].order || 0) - (turnsMap[b].order || 0); });\n' +
      '    return ids.map(function (id) { return { id: id, text: turnsMap[id].text || \'\' }; });\n' +
      '  }'
    );
    expect(fnSource(MOD, 'aiCmDiagHash6')).toContain('var h = 0x811c9dc5;');
    expect(fnSource(MOD, 'aiCmDiagHash6')).toContain('h = Math.imul(h, 0x01000193) >>> 0;');
    expect(fnSource(MOD, 'aiCmDiagHash6')).toContain("return ('000000' + h.toString(16)).slice(-6);");
  });

  test('C3: слушатель уехал в модуль и начинается гардом !D', () => {
    expect(MOD).toContain("window.addEventListener('" + LISTENER + "'");
    const at = MOD.indexOf("window.addEventListener('" + LISTENER + "'");
    const brace = MOD.indexOf('{', at);
    const first = MOD.slice(brace + 1).split('\n')[1].trim();
    expect(first).toBe(GUARD);
    expect(CORE).not.toContain("window.addEventListener('" + LISTENER + "'");
    // мост остался ровно один во всей конкатенации (копии в ядре нет)
    expect(CONC.split("window.addEventListener('" + LISTENER + "'").length - 1).toBe(1);
    expect(MOD).toContain("new CustomEvent('ai-cm-turns-snap-response', { detail: diagSnap })");
  });

  test('C4: маркеры извлечения существующих пинов разрешаются в модуле, а не в ядре', () => {
    // Песочницы шести пинов режут тела ИЗ КОНКАТЕНАЦИИ по этим маркерам и исполняют их
    // в with (ctx). Если маркер начнёт находиться в ЯДРЕ (или пропадёт), пины покраснеют.
    const markers = [
      'function stableFloorConfirm() {',
      'function noteBaseCountChange() {',
      'var stableCheck74 = function () {',
      'function notifyLoaderState(convId, running) {',
      'function aiCmDiagHash6(id, text) {',
      'function aiCmDiagTurnEdge(turns, which) {'
    ];
    markers.forEach((m) => {
      const inConc = CONC.indexOf(m);
      expect(inConc).toBeGreaterThan(-1);
      expect(CONC.indexOf(MOD)).toBeLessThan(inConc);   // маркер найден ИМЕННО в модуле
      expect(CONC.indexOf(CORE)).toBeGreaterThan(inConc); // …и до начала ядра
    });
    // в ЯДРЕ тел нет: от пяти экспортированных имён остались однострочные форвардеры (B1),
    // а stableFloorConfirm не осталось вовсе — его зовёт таймер debounce внутри модуля
    INTERNAL.forEach((n) => expect(CORE).not.toContain('function ' + n + '('));
    // порядок тел в модуле: stableFloorConfirm идёт ПЕРЕД notifyLoaderState — пин
    // gemini-floor-confirmed:211-222 требует именно этого отношения
    expect(MOD.indexOf('function stableFloorConfirm()')).toBeLessThan(MOD.indexOf('function notifyLoaderState('));
  });
});

describe('Phase 3 шаг 13.3: D-пины — API, размещение связки, гигиена', () => {
  test('D1: модуль отдаёт ровно 6 имён и публикует их на window', () => {
    expect(MOD).toContain("if (typeof window !== 'undefined' && window.AiCmGeminiOracle) return;");
    expect(MOD).toContain('  var D = null;');
    expect(MOD).toContain('  var Fn = {};');
    expect(MOD).toContain('  Fn.__bind = __bind;');
    EXPORTED.forEach((n) => expect(MOD).toContain('      Fn.' + n + ' = ' + n + ';'));
    expect(MOD).toContain("if (typeof window !== 'undefined') window.AiCmGeminiOracle = Fn;");
    // в MAIN-мире `module` не определён: голый module.exports бросил бы ReferenceError
    // (проверка — как в сьютах pagination/ingest: require() самого модуля невозможен,
    // babel-jest парсит файл в strict-режиме, где `with` — SyntaxError; поэтому грузим vm-ом)
    expect(MOD).toContain("if (typeof module !== 'undefined' && module.exports) module.exports = Fn;");
    const api = loadModule().api;
    expect(api).toBeTruthy();
    // до связки Fn несёт ТОЛЬКО точку входа: тела объявлены внутри with (D) и становятся
    // видны ровно на __bind (та же механика, что у pagination/ingest)
    expect(Object.keys(api)).toEqual(['__bind']);
    api.__bind(liveState().D);
    expect(Object.keys(api).sort()).toEqual(['__bind'].concat(EXPORTED).sort());
  });

  test('D2: гигиена модуля — без strict, без innerHTML, без console.error, без chrome.*', () => {
    expect(MOD).not.toMatch(/^\s*'use strict'/m);
    expect(MOD_CODE).not.toMatch(/innerHTML\s*=/);
    expect(MOD_CODE).not.toMatch(/console\s*\.\s*error\s*\(/);
    // в MAIN-мире chrome.* недоступен: модуль обязан остаться без него
    expect(MOD_CODE).not.toContain('chrome.');
    // D.-префиксов нет: тела резолвят имена через with (D) (см. S4)
    expect(MOD_CODE).not.toMatch(/(?<![\w$.])D\s*\./);
  });

  test('D3: повторная загрузка модуля не перетирает API и не вешает слушателя дважды', () => {
    const first = loadModule();
    const api = first.api;
    expect(api).toBeTruthy();
    api.__bind(liveState().D); // Fn заполняется связкой (см. D1)
    expect(Object.keys(api).sort()).toEqual(['__bind'].concat(EXPORTED).sort());
    expect(first.pageWindow.listeners).toEqual([LISTENER]);
    const handler = first.pageWindow.handlers[LISTENER];
    vm.runInContext(MOD, first.ctx, { filename: 'core/gemini-oracle.js (повторно)' });
    expect(first.pageWindow.AiCmGeminiOracle).toBe(api);
    expect(first.pageWindow.handlers[LISTENER]).toBe(handler);
    expect(first.pageWindow.listeners).toHaveLength(1); // re-entry guard сработал
  });

  test('D4: гард !D гасит событие до связки (без ReferenceError в чужом стеке)', () => {
    const sandbox = loadModule();
    // до __bind слушателя ещё нет вовсе (он регистрируется связкой) — мост молчит
    expect(sandbox.pageWindow.handlers[LISTENER]).toBeUndefined();
    // …а если связка дала пустой объект (теоретический случай), гард обязан погасить событие
    sandbox.api.__bind({});
    const handler = sandbox.pageWindow.handlers[LISTENER];
    expect(typeof handler).toBe('function');
    expect(() => handler({ detail: {} })).not.toThrow();
    const guardLogs = sandbox.logs.filter((l) => String(l[1]).indexOf('[gemini-oracle] D is null') !== -1);
    // D не null (связка прошла) → гард молчит; проверяем сам текст гарда в исходнике
    expect(guardLogs).toHaveLength(0);
    expect(MOD).toContain(GUARD);
  });

  test('D5: блок подключения стоит между блоком архива и installNetworkHooks()', () => {
    const archiveBind = lineOf(CORE, 'aiCmGeminiArchive.__bind(');
    const oracleBind = lineOf(CORE, 'aiCmGeminiOracle.__bind({');
    const hooks = lineOf(CORE, 'installNetworkHooks();');
    expect(archiveBind).toBeGreaterThan(0);
    expect(oracleBind).toBeGreaterThan(archiveBind);
    expect(hooks).toBeGreaterThan(oracleBind);
    // ниже поздних алиасов (> 782) и ниже точки выхода vf5 (1446) — иначе в модуль уехал бы null
    expect(oracleBind).toBeGreaterThan(782);
    const VF5_TAIL = 'aiCmIngestFwd(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });';
    expect(oracleBind).toBeGreaterThan(lineOf(CORE, VF5_TAIL));
    // баннеры-указатели на месте бывших диапазонов: секция форвардеров, notifyLoaderState,
    // отпечатки+снимок, мост и сам блок подключения
    expect((CORE.match(/Phase 3 step 13\.3\): ОРАКУЛ ПОЛНОТЫ \(ВЫНЕСЕН/g) || [])).toHaveLength(5);
  });

  test('D6: без модуля ядро деградирует мягко — внятный лог, а не падение', () => {
    const at = CORE.indexOf("debugLog('log', '[gemini-intercept] core/gemini-oracle.js не подключён");
    expect(at).toBeGreaterThan(-1);
    const elseBranch = CORE.slice(at, CORE.indexOf('\n  }', at));
    expect(elseBranch).toContain('оракул полноты недоступен');
    expect(elseBranch).not.toContain('throw');
    expect(elseBranch).not.toMatch(/function\s/);
  });
});

describe('Phase 3 шаг 13.3: S-пины проводки модуля', () => {
  test('S1: регистрация в core/background.js — id -v11, модуль между archive и ядром, -v10 снят', () => {
    const bg = readFile('core/background.js');
    expect(bg).toContain("'ai-cm-gemini-intercept-v11'");
    expect(bg).toContain("'core/gemini-oracle.js'");
    // js[] собран ровно в этом порядке: … overlay → archive → oracle → ядро
    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-oracle.js', 'core/gemini-intercept.js'");
    // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при своей загрузке
    expect(bg.indexOf("'core/gemini-archive.js'")).toBeLessThan(bg.indexOf("'core/gemini-oracle.js'"));
    expect(bg.indexOf("'core/gemini-oracle.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
    // MV3 не перечитывает js[] под существующим id — прежний id обязан быть снят
    expect(bg).toContain("'ai-cm-gemini-intercept-v10'");
    expect(bg).toContain("'ai-cm-gemini-intercept-v9'");
    // лог регистрации бампнут вместе с id и стоит рядом со своей регистрацией
    expect(bg).toContain('(v11) зарегистрирован');
    expect(bg).not.toContain('(v10) зарегистрирован');
    expect(bg.indexOf("await registerSafe('ai-cm-gemini-intercept-v11'"))
      .toBeLessThan(bg.indexOf('(v11) зарегистрирован'));
    // release.yml держит счётчик MAIN-world файлов равным факту (27 → 28; Step D.2 —
    // модуль сетевого дозапроса DeepSeek core/deepseek-netsync.js добавлен в js[];
    // 28 → 29 — Step D.3, кластер REFETCH/URL-гигиены core/deepseek-refetch.js;
    // 29 → 30 — Step D.4, кластер цепочки/текста хода core/deepseek-parse.js;
    // 30 → 31 — Step D.5, кластер CONV ID + детектора смены чата core/deepseek-conv.js;
    // 31 → 32 — Step D.6, кластер EMIT core/deepseek-emit.js;
    // 32 → 33 — Step D.7, кластер NETWORK core/deepseek-net.js;
    // 33 → 34 — Step D.8, кластер INGEST core/deepseek-ingest.js)
    const yml = readFile('.github/workflows/release.yml');
    expect((yml.match(/35 MAIN-world/g) || [])).toHaveLength(2);
    expect(yml).not.toContain('34 MAIN-world');
  });

  test('S2: bind-контракт полон — 32 имени (10 fn + 10 rw + 12 ro), ни одной потерянной привязки', () => {
    expect(CONTRACT).toHaveLength(32);
    const names = CONTRACT.map(([n]) => n);
    expect(new Set(names).size).toBe(32);
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(([, k]) => { kinds[k]++; });
    expect(kinds).toEqual({ fn: 10, ro: 12, rw: 10 });
    // состав контракта — фиксированная величина шага
    expect(names.slice().sort()).toEqual([
      'aiCmArchiveFor', 'aiCmArchiveLiveProven', 'aiCmArchiveTierApply', 'aiCmBaseExportInfo',
      'aiCmLiveTurnCount', 'baseSize', 'emitBaseSnapshot', 'floorConfirmDebounceTimer',
      'getConvId', 'historyFullByQuiet', 'lastBaseCount', 'lastBaseCountChangeAt',
      'lastBaseTextLen', 'lastCycleEndedHidden', 'lastHnvPageError', 'lastIngestParseFail',
      'lastLoaderDoneReason', 'lastOlderNonPagAddAt', 'lastOrderedIds', 'loadFloor',
      'loaderRunningFor', 'loaderState', 'oracleIncompleteSeen', 'parserVersion',
      'pendingCursor', 'quietActive', 'quietEndedClean', 'quietIncompleteNoStart',
      'reachedStart', 'reachedStartByScroll', 'selfHealFloor', 'turnsMap'
    ]);
    COMPOSITION_OF_CONTRACT.forEach(([n, k]) => {
      const rec = CONTRACT.filter(([name]) => name === n);
      expect(rec).toEqual([[n, k]]);
    });
    // …и передаётся ядром в __bind. Проверяем ИМЕННО блок __bind: имя может встречаться
    // в ядре и вне связки — это не передача.
    const block = bindBlockText();
    const notProvided = names.filter((n) => !new RegExp('(?:^|[\\s,{])' + n + '\\s*[:,(]', 'm').test(block));
    expect(notProvided).toEqual([]);
    // ДВА typeof-гарда тел обязаны быть привязаны: без них pageError навсегда false
    // (H10 слабеет при ошибке страницы), а provenLen=0 (понижение пола записало бы
    // устаревшую длину). Оба — только на чтение.
    const guarded = [...MOD_CODE.matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*[!=]==?\s*'undefined'/g)]
      .map((m) => m[1])
      .filter((n) => GLOBAL_NAMES.indexOf(n) === -1);
    expect(guarded.length).toBeGreaterThan(0);
    [...new Set(guarded)].forEach((n) => expect(names).toContain(n));
    ['lastHnvPageError', 'lastBaseTextLen'].forEach((n) => {
      expect(guarded).toContain(n);
      expect(block).toContain('get ' + n + '() { return ' + n + '; }');
      expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\('));
    });
    // два имени контракта телами не читаются — ровно те, что заявлены в шапке контракта
    const unused = names.filter((n) => !new RegExp('(^|[^\\w$.])' + n + '(?![\\w$])').test(MOD_CODE));
    expect(unused.sort()).toEqual(KNOWN_UNUSED.slice().sort());
  });

  test('S3: порядок в helper-конкатенации повторяет порядок js[], контракт трекается в git', () => {
    expect(SRC.MODULES).toContain('core/gemini-oracle.js');
    expect(SRC.MODULES.indexOf('core/gemini-oracle.js'))
      .toBeGreaterThan(SRC.MODULES.indexOf('core/gemini-archive.js'));
    expect(SRC.SOURCES.indexOf('core/gemini-oracle.js'))
      .toBeLessThan(SRC.SOURCES.indexOf('core/gemini-intercept.js'));
    expect(CONC.indexOf(MOD)).toBeLessThan(CONC.indexOf(CORE));
    // контракт обязан трекаться в git: tools/* под .gitignore, нужна негация
    expect(readFile('.gitignore')).toContain('!tools/oracle-bind-contract.js');
  });

  test('S4: тела резолвят имена через with (D) — D.-префиксов нет, имена ядра голые', () => {
    expect(MOD_CODE).toContain('with (D) {');
    expect(MOD_CODE).not.toMatch(/(?<![\w$.])D\s*\./);
    // доказательство «голых» имён: строки тел читают состояние ядра без префикса
    ['historyFullByQuiet = true;', 'reachedStart = true;', 'quietIncompleteNoStart = false;',
      'floorConfirmDebounceTimer = setTimeout(stableFloorConfirm, 5500);',
      'var ids = Object.keys(turnsMap);'].forEach((lit) => expect(MOD).toContain(lit));
    ['D.historyFullByQuiet', 'D.reachedStart', 'D.turnsMap', 'D.stableFloorConfirm',
      'D.lastHnvPageError', 'D.lastBaseTextLen'].forEach((lit) => expect(MOD_CODE).not.toContain(lit));
    // with несовместим со strict: директива в модуле запрещена (проверено и в D2)
    expect(MOD).not.toMatch(/^\s*'use strict'/m);
    // …и ровно один with на модуль: связка идёт одним объектом, а не несколькими
    expect((MOD_CODE.match(/\bwith\s*\(/g) || [])).toHaveLength(1);
  });
});
