/**
 * Step D.1 (декомпозиция core/deepseek-intercept.js): контракт модуля диагностики.
 *
 * Кластер СЕКЦИЙ 13/13D/13B уехал в core/deepseek-diag.js. Модуль и ядро — РАЗНЫЕ IIFE
 * одного registerContentScripts-пакета (js[]: utils/debug.js -> deepseek-diag.js ->
 * deepseek-intercept.js), поэтому связь идёт ровно через один контракт:
 *
 *   ядро -> модуль: window.AiCmDeepseekDiag.__bind(deps)
 *     fn (значением): функции ядра, которые зовут тела модуля;
 *     rw (get+set):   живое состояние, которое модуль ПЕРЕЗАПИСЫВАЕТ;
 *     ro (get):       живое состояние только на чтение.
 *   модуль -> ядро: Fn.<fn> после __bind; ядро раздаёт их 16 форвардерами по прежним именам.
 *
 * Здесь пинятся:
 *   S1. Полнота контракта: литерал __bind в ядре содержит ровно 30 имён (4 fn + 3 rw +
 *       23 ro) — ни одного потерянного; каждый rw — именно пара get+set.
 *   S2. Живая связка в vm: до __bind наружу торчит ТОЛЬКО __bind (мосты O-18 ещё не
 *       подняты); после — все 26 функций, и состояние читается через аксессоры ЖИВЬЁМ.
 *   S3. rw-пары работают в обе стороны: seed-мост O-18 пишет в буфер ядра через setter,
 *       lastDiagConvId инициализируется из currentConvId ядра на связке.
 *   S4. Тени прозы: indexOf-пины прочих сьютов не сломаны — литералы остались там, где
 *       тела теперь живут (модуль) или где остались вызовы (ядро); префиксов D. в телах нет.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-diag.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 30 имён -------------------------------------------------
const CONTRACT = [
  // fn: функции ядра, вызываемые телами модуля
  ['collectTurnText', 'fn'],
  ['collectTurnReasoning', 'fn'],
  ['netSyncNeeded', 'fn'],
  ['streamKnownType', 'fn'],
  // rw: модуль перезаписывает эти имена (get + set обязателен)
  ['sseFragments', 'rw'],
  ['sseFragmentTypes', 'rw'],
  ['lastDiagConvId', 'rw'],
  // ro: только чтение
  ['turnsMap', 'ro'],
  ['currentConvId', 'ro'],
  ['histCompletion', 'ro'],
  ['historyRefetchDone', 'ro'],
  ['lastHistoryUrl', 'ro'],
  ['loggedHistory', 'ro'],
  ['loggedRealtime', 'ro'],
  ['REASONING_ENABLED', 'ro'],
  ['liveTurnOrder', 'ro'],
  ['netTurnIds', 'ro'],
  ['netSnapshotAt', 'ro'],
  ['lastTurnDoneAt', 'ro'],
  ['netSyncStats', 'ro'],
  ['sseStreamActive', 'ro'],
  ['sseTurnFinished', 'ro'],
  ['sseRequestMessageId', 'ro'],
  ['sseResponseMessageId', 'ro'],
  ['sseResyncRing', 'ro'],
  ['sseResyncCount', 'ro'],
  ['sseResyncBytes', 'ro'],
  ['sseUnknownCount', 'ro'],
  ['sseUnknownChars', 'ro'],
  ['SSE_FRAGMENT_TYPES', 'ro']
];

// ---- что модуль отдаёт наружу после __bind (S2) -------------------------------------
const EXPORTS = [
  'isDebugEnabled', 'getNavigationType', 'determineState', 'normalizeRole',
  'buildMessagesFromRaw', 'buildMessagesFromTurnsMap', 'collectUsageFieldsVerbatim',
  'fragContentLength', 'dumpTurnUsageAtHistoryLoad', 'dumpHistorySnapshot',
  'diagOn', 'diagHash6', 'diagClip', 'diagPushRing', 'diagStat', 'diagFirstDiff',
  'diagVerdict', 'diagFragState', 'diagMark', 'diagChunkRecord', 'diagHistRecord',
  'diagSnapshotNetTurns', 'diagLiveTurnRecord', 'diagDumpRings', 'diagExportHook',
  'diagResetForConv'
];

// ---- стенд vm: песочница со всеми глобусами, которые зовут тела модуля --------------
function makeSandbox(debug) {
  const logs = [];
  const sandbox = {
    console: {
      log: function () { logs.push(Array.prototype.map.call(arguments, String).join(' ')); },
      warn: function () { logs.push('WARN ' + Array.prototype.map.call(arguments, String).join(' ')); },
      error: function () { logs.push('ERR ' + Array.prototype.map.call(arguments, String).join(' ')); }
    },
    sessionStorage: {
      _v: debug ? '1' : null,
      getItem: function () { return this._v; },
      setItem: function (k, v) { this._v = v; }
    },
    performance: { getEntriesByType: function () { return [{ type: 'reload' }]; } },
    Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, String: String,
    Number: Number, Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise,
    setTimeout: setTimeout, clearTimeout: clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-diag.js' });
}

// ---- probe-ядро: живое состояние + счётчики обращений к аксессорам -------------------
function makeProbe(over) {
  const st = {
    turnsMap: {}, currentConvId: 'conv12345678', histCompletion: { historyComplete: true, reachedRoot: true, baseEmpty: false },
    historyRefetchDone: false, lastHistoryUrl: 'https://x/history', loggedHistory: true, loggedRealtime: false,
    REASONING_ENABLED: true, liveTurnOrder: [], netTurnIds: {}, netSnapshotAt: 0, lastTurnDoneAt: 0,
    netSyncStats: { calls: 0 }, sseStreamActive: false, sseTurnFinished: false,
    sseRequestMessageId: null, sseResponseMessageId: null, sseResyncRing: [], sseResyncCount: 0,
    sseResyncBytes: 0, sseUnknownCount: 0, sseUnknownChars: 0, SSE_FRAGMENT_TYPES: { THINK: 1, RESPONSE: 1 },
    sseFragments: [], sseFragmentTypes: [], lastDiagConvId: null
  };
  if (over) Object.keys(over).forEach(function (k) { st[k] = over[k]; });
  const reads = {};
  const D = {
    collectTurnText: function () { return ''; },
    collectTurnReasoning: function () { return ''; },
    netSyncNeeded: function () { return false; },
    streamKnownType: function (t) { return Object.prototype.hasOwnProperty.call(st.SSE_FRAGMENT_TYPES, String(t)); }
  };
  ['sseFragments', 'sseFragmentTypes', 'lastDiagConvId'].forEach(function (name) {
    Object.defineProperty(D, name, {
      get: function () { reads[name] = (reads[name] || 0) + 1; return st[name]; },
      set: function (v) { reads[name + ':set'] = (reads[name + ':set'] || 0) + 1; st[name] = v; },
      enumerable: true
    });
  });
  CONTRACT.forEach(function (pair) {
    const name = pair[0];
    if (pair[1] !== 'ro') return;
    Object.defineProperty(D, name, {
      get: function () { reads[name] = (reads[name] || 0) + 1; return st[name]; },
      enumerable: true
    });
  });
  return { D: D, st: st, reads: reads };
}

describe('Step D.1: core/deepseek-diag.js — контракт модуля диагностики', () => {
  test('S1: литерал __bind в ядре содержит ровно 30 имён (4 fn + 3 rw + 23 ro)', () => {
    const start = KERNEL_SRC.indexOf('aiCmDeepseekDiag.__bind({');
    expect(start).toBeGreaterThan(-1);
    const end = KERNEL_SRC.indexOf('});', start);
    const literal = KERNEL_SRC.slice(start, end);
    const lines = literal.split('\n');
    const parsed = new Map();
    lines.forEach(function (l, i) {
      const g = l.match(/^\s*get\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/);
      if (g) {
        const name = g[1];
        const setLine = lines.slice(i, i + 4).join('\n');
        parsed.set(name, new RegExp('set\\s+' + name + '\\s*\\(').test(setLine) ? 'rw' : 'ro');
        return;
      }
      const p = l.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*,?\s*$/);
      if (p && p[1] === p[2]) parsed.set(p[1], 'fn');
    });
    // полное совпадение состава и видов — ни одного потерянного/лишнего имени
    expect(parsed.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) {
      expect(parsed.get(pair[0])).toBe(pair[1]);
    });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 4, ro: 23, rw: 3 });
    // каждая передача — реально существующее в ядре имя (fn — функция, ro/rw — переменная)
    CONTRACT.forEach(function (pair) {
      if (pair[1] === 'fn') expect(KERNEL_SRC).toContain('function ' + pair[0] + '(');
      else expect(new RegExp('var\\s+' + pair[0] + '\\b').test(KERNEL_SRC)).toBe(true);
    });
  });

  test('S2: живая связка в vm — до __bind наружу только __bind, после — все 26 функций', () => {
    const box = makeSandbox(false);
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekDiag;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);
    // мосты O-18 поднимаются ИМЕННО на связке (внутри with(D)), а не на загрузке модуля
    expect(box.sandbox.__aiCmDebug).toBeUndefined();

    const probe = makeProbe();
    Fn.__bind(probe.D);

    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());
    EXPORTS.forEach(function (n) { expect(typeof Fn[n]).toBe('function'); });
    // мосты появились после связки: ручной дамп и seed доступны
    expect(typeof box.sandbox.__aiCmDebug.dumpDeepSeekO18).toBe('function');
    expect(typeof box.sandbox.__aiCmDebug.seedDeepSeekFragmentsO18).toBe('function');
  });

  test('S3: состояние читается через аксессоры живьём, rw-пара пишет в ядро', () => {
    const box = makeSandbox(true); // aiCmDebug=1: diag-пути активны
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekDiag;
    const probe = makeProbe({ currentConvId: 'liveconv99' });
    Fn.__bind(probe.D);

    // bind-строка K10 (`var lastDiagConvId = currentConvId`) пишет в ЯДРО через setter:
    // значение ядра перезаписано текущим convId, а не осталось null
    expect(probe.st.lastDiagConvId).toBe('liveconv99');
    expect(probe.reads['lastDiagConvId:set']).toBeGreaterThan(0);

    // ro-геттер: смена состояния ядра видна модулю без повторной связки
    const first = Fn.determineState();
    expect(first.reason).toContain('liveconv');   // в reason идёт префикс convId (8 символов)
    probe.st.currentConvId = 'otherconv7';
    expect(Fn.determineState().reason).toContain('othercon');

    // предикаты и чистые хелперы (тела — прежние, K10)
    expect(Fn.isDebugEnabled()).toBe(true);
    expect(Fn.diagOn()).toBe(true);
    expect(Fn.normalizeRole('USER')).toBe('user');
    expect(Fn.normalizeRole('')).toBe('unknown');
    expect(Fn.fragContentLength([{ content: 'ab' }, { content: 'c' }])).toBe(3);
    expect(Fn.collectUsageFieldsVerbatim({ prompt_tokens: 5, fragments: [], foo: 1 })).toEqual({ prompt_tokens: 5 });
    expect(Fn.diagClip('0123456789', 4)).toBe('0123');
    expect(Fn.diagStat(null)).toBe('(none)');
    expect(Fn.diagStat('ab').slice(0, 2)).toBe('2:');
    expect(Fn.diagHash6('abc')).toMatch(/^[0-9a-f]{6}$/);
    expect(Fn.diagFirstDiff('abc', 'abd')).toBe(2);
    expect(Fn.diagFirstDiff('abc', 'abc')).toBe(-1);
    expect(Fn.diagVerdict('abc', 'abc').verdict).toBe('EQUAL');
    expect(Fn.diagVerdict('abc', 'abcd').verdict).toBe('TAIL-CUT');
    expect(Fn.diagVerdict(null, 'x').verdict).toBe('ONE-SIDE');
    expect(Fn.diagFragState()).toEqual([]);

    // rw: seed-мост O-18 подменяет буфер фрагментов ЯДРА (а не копию в модуле)
    const seeded = box.sandbox.__aiCmDebug.seedDeepSeekFragmentsO18([{ type: 'RESPONSE', content: 'X' }]);
    expect(seeded).toEqual({ frags: 1, types: 'RESPONSE' });
    expect(probe.st.sseFragments).toHaveLength(1);
    expect(probe.st.sseFragments[0]).toEqual({ type: 'RESPONSE', content: 'X' });
    expect(probe.st.sseFragmentTypes).toEqual(['RESPONSE']);
    expect(probe.reads['sseFragments:set']).toBeGreaterThan(0);

    // маркер + ручной дамп колец: все свободные имена контракта доступны телам
    Fn.diagMark('d1', { a: 1 });
    expect(box.logs.join('\n')).toContain('[ai-cm-debug][O18][mark]');
    const rings = box.sandbox.__aiCmDebug.dumpDeepSeekO18('probe');
    expect(rings.sse).toBeGreaterThanOrEqual(0);
    expect(rings.marks).toBeGreaterThanOrEqual(1);
    expect(rings.liveTurns).toBe(0);
    expect(rings.netTurns).toBe(0);
    expect(box.logs.join('\n')).toContain('[ai-cm-debug][O18][rings]');
  });

  test('S4: тени прозы — indexOf-пины прочих сьютов не сломаны, префиксов D. в телах нет', () => {
    // тела уехали в модуль — пины, которые ищут их текст, читают модуль
    const inModule = [
      'function dumpHistorySnapshot(state, stateReason, ctx) {',
      'function dumpTurnUsageAtHistoryLoad(chain, chatMessages, chatSession) {',
      'function diagMark(kind, data) {',
      'function diagOn() {',
      'var DIAG_SSE_RING_MAX = 400;',
      'var lastDiagConvId = currentConvId;',
      'window.__aiCmDebug.dumpDeepSeekO18',
      'window.__aiCmDebug.seedDeepSeekFragmentsO18',
      '// ===== СЕКЦИЯ 13: ДИАГНОСТИЧЕСКИЙ ДАМП'
    ];
    inModule.forEach(function (l) { expect(MODULE_SRC).toContain(l); });
    // вызовы и функциональные секции остались в ядре — их пины не тронуты.
    // Step D.8: `diagMark('ingest-enter', {` уехал вместе с телом K5 в
    // core/deepseek-ingest.js, поэтому строка ищется в конкатенации модулей+ядра
    // (как строки K9 в сьюте D.3); остальные пины — по-прежнему в ядре.
    const inKernel = [
      'function ingestHistory(jsonBody) {',
      'function finishSseStream() {',
      'var SSE_FRAGMENT_TYPES = {',
      "if (typeof diagMark === 'function' && typeof diagOn === 'function' && diagOn()) {",
      "console.log('[deepseek-intercept] перехватчик DeepSeek v11 установлен",
      'function diagMark(kind, data) { aiCmDeepseekDiag.diagMark(kind, data); }',
      'function diagOn() { return aiCmDeepseekDiag.diagOn(); }'
    ];
    inKernel.forEach(function (l) { expect(KERNEL_SRC).toContain(l); });
    expect(DS.deepseekSource).toContain("diagMark('ingest-enter', {");
    // K10-тел в ядре больше нет (иначе пины-дубли), а тела модуля — без префиксов D.
    expect(KERNEL_SRC).not.toContain('// ===== СЕКЦИЯ 13: ДИАГНОСТИЧЕСКИЙ ДАМП');
    // объявлений состояния колец в ядре нет (упоминания в шапке-комментарии — не в счёт)
    expect(KERNEL_SRC).not.toContain('var diagSseRing');
    expect(KERNEL_SRC).not.toContain('var diagSeq');
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // размеры: кластер уехал целиком (ядро ушло ниже 2400 строк, модуль — за 900)
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(2400);
    expect(MODULE_SRC.split('\n').length).toBeGreaterThan(900);
    // порядок в js[]: модули строго перед ядром (пин дублируется wiring-сьютом;
    // Step D.2 добавил в карту core/deepseek-netsync.js, Step D.3 — core/deepseek-refetch.js,
    // Step D.4 — core/deepseek-parse.js, Step D.5 — core/deepseek-conv.js,
    // Step D.6 — core/deepseek-emit.js, Step D.7 — core/deepseek-net.js,
    // Step D.8 — core/deepseek-ingest.js; порядок = порядок js[])
    expect(DS.MODULES).toEqual(['core/deepseek-diag.js', 'core/deepseek-netsync.js', 'core/deepseek-refetch.js', 'core/deepseek-parse.js', 'core/deepseek-conv.js', 'core/deepseek-emit.js', 'core/deepseek-net.js', 'core/deepseek-ingest.js']);
    expect(DS.SOURCES.indexOf('core/deepseek-diag.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
  });

  test('S5: зоны PURE/BIND — горячие тела вне with (D), тела с состоянием ядра внутри', () => {
    const bindAt = MODULE_SRC.indexOf('  function __bind(d) {');
    const withAt = MODULE_SRC.indexOf('    with (D) {');
    expect(bindAt).toBeGreaterThan(0);
    expect(withAt).toBeGreaterThan(bindAt);
    // Горячие тела обязаны жить ВНЕ with: внутри with каждый свободный идентификатор
    // резолвится динамически, и FNV-цикл по растущему буферу деградирует ~в 40 раз
    // (микробенчмарк 200×200 КБ: 81 мс вне with против 3309 мс в with; живой замер
    // o18-frag-resync: 1.3 с → 5.1 с при возврате этих тел в with).
    ['function diagHash6(s) {', 'function diagClip(s, cap) {', 'function diagStat(t) {',
      'function diagFirstDiff(a, b) {', 'function diagVerdict(lt, nt) {',
      'function diagLiveTurnRecord(id, role, text, reason) {'].forEach(function (sig) {
      const at = MODULE_SRC.indexOf(sig);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(bindAt);
    });
    // Состояние модуля (DIAG_*-константы и 11 diag-переменных) — тоже PURE-зона.
    ['var DIAG_SSE_RING_MAX = 400;', 'var diagSeq = 0;', 'var diagOps = { APPEND: 0',
      'var diagFlag = { v: false, at: 0 };', 'var USAGE_FIELD_RE ='].forEach(function (l) {
      const at = MODULE_SRC.indexOf(l);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(bindAt);
    });
    // Тела, читающие состояние/функции ядра, обязаны быть ВНУТРИ with (D) — иначе
    // свободное имя не зарезолвится вовсе (ReferenceError на первом же вызове).
    ['function determineState() {', 'function diagMark(kind, data) {', 'function diagFragState() {',
      'function diagChunkRecord(path, op, val, before, after) {',
      'function dumpHistorySnapshot(state, stateReason, ctx) {',
      'function diagExportHook(trigger) {', 'function diagResetForConv(reason, prevConv) {'
    ].forEach(function (sig) {
      const at = MODULE_SRC.indexOf(sig);
      expect(at).toBeGreaterThan(withAt);
    });
  });
});
