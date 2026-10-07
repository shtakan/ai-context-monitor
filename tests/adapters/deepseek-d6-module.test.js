/**
 * Step D.6 (декомпозиция core/deepseek-intercept.js): контракт модуля EMIT.
 *
 * Кластер K2 (СЕКЦИЯ 4 ядра — buildDispatchSignature, emitBaseSnapshot, clipTurnText,
 * turnsSnapshot и мост ai-cm-turns-snap-request → ai-cm-turns-snap-response) уехал
 * в core/deepseek-emit.js. Модуль и ядро — РАЗНЫЕ IIFE одного registerContentScripts-
 * пакета (js[]: utils/debug.js -> deepseek-diag.js -> deepseek-netsync.js ->
 * deepseek-refetch.js -> deepseek-parse.js -> deepseek-conv.js -> deepseek-emit.js ->
 * deepseek-intercept.js), поэтому связь идёт ровно через один контракт:
 *
 *   ядро -> модуль: window.AiCmDeepseekEmit.__bind(deps)
 *     fn (7): diagHash6 — FNV-1a отпечаток текста хода в сигнатуре O-22 (PURE-тело
 *             модуля D.1); diagMark/diagOn — маркеры o22-dispatch-fn / o22-dispatch-skip;
 *             diagExportHook — измерение O-18 на мосте turns-snap; isDebugEnabled —
 *             гейт лога нестандартной роли; getConvId — форвардер D.5 (detail.convId);
 *             hasInjectedUserPrompt — форвардер D.4 (hidden-пометка базы).
 *     rw (4): состояние emit-гарда O-22, которое тело emitBaseSnapshot ПЕРЕЗАПИСЫВАЕТ:
 *             lastBaseServerTokens, lastBaseChatMode (параметры последнего эмита для
 *             ре-эмита полноты 0→1), lastDispatchSig, lastDispatchResult (сигнатура и
 *             результат реально опубликованного снимка). Без сеттера запись в sloppy-
 *             режиме молча терялась бы — гард повторного диспатча перестал бы глушить
 *             одинаковые снимки.
 *     ro (5): turnsMap, attachTokens, attachBreak, histCompletion, currentConvId —
 *             модуль их только читает (мутация полей histCompletion и записей turnsMap
 *             идёт по ссылке и видна ядру без сеттера).
 *   модуль -> ядро: Fn.<fn> после __bind; ядро раздаёт 1 из 4 тел форвардером
 *   (emitBaseSnapshot — function declaration, хойстится: 3 сайта вызова в ядре и
 *   fn-передача в контракт D.2 не тронуты). buildDispatchSignature/clipTurnText/
 *   turnsSnapshot наружу не выдаются: их зовут только тела этого же модуля
 *   (включая мост turns-snap).
 *
 * Здесь пинятся:
 *   S1. Полнота контракта: литерал __bind в ядре содержит ровно 16 имён
 *       (7 fn + 4 rw + 5 ro), ни одного потерянного/лишнего; каждое имя реально
 *       существует в ядре (fn — function declaration, rw/ro — var) и НЕ объявлено
 *       повторно в модуле (иначе появилась бы ВТОРАЯ переменная).
 *   S2. Живая связка в vm: до __bind наружу торчит ТОЛЬКО __bind; полная связка
 *       оживляет все 4 тела, мост регистрируется ровно один раз, emitBaseSnapshot
 *       пишет в ЖИВЫЕ rw-аксессоры ядра и публикует событие ai-cm-full-history;
 *       повторный снимок глушится гардом O-22 и возвращает lastDispatchResult;
 *       повторная загрузка модуля не перетирает уже связанный API.
 *   S3. Байтовая идентичность тел: 5 блоков K2 (СЕКЦИЯ 4 HEAD d6a74c2, строки 307-489)
 *       лежат в модуле ДОСЛОВНО (SHA-256 каждого блока зафиксирован здесь — git-история
 *       сьютом не читается, CI shallow); заголовок СЕКЦИИ 4 в PURE-зоне, все тела —
 *       в BIND-зоне внутри `with (D)`; состояние и O-22-слушатель остались в ядре;
 *       префиксов D. нет.
 *   S4. Живая семантика K2: состав сигнатуры (порядок ключей turnsMap не влияет,
 *       тексты/роли/модель/reasoning влияют), clipTurnText, turnsSnapshot (поля
 *       сводки + фолбэк convId через getConvId), мост turns-snap (ответ + diagExportHook).
 *   S5. Проводка: js[] строго после deepseek-conv.js и перед ядром, helper MODULES,
 *       размеры ядра/модуля, K0 не тронут. Счётчик/лог регистрации с Step D.7 —
 *       -v9 + unregister -v9 (актуальный пин — в deepseek-d7-module.test.js).
 */

const vm = require('vm');
const crypto = require('crypto');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-emit.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 7 fn + 4 rw + 5 ro = 16 имён ------------------------------
const FN_NAMES = ['diagHash6', 'diagMark', 'diagOn', 'diagExportHook', 'isDebugEnabled',
  'getConvId', 'hasInjectedUserPrompt'];
const RW_NAMES = ['lastBaseServerTokens', 'lastBaseChatMode', 'lastDispatchSig', 'lastDispatchResult'];
const RO_NAMES = ['turnsMap', 'attachTokens', 'attachBreak', 'histCompletion', 'currentConvId'];

// ---- что модуль отдаёт наружу после __bind (S2) -------------------------------------
const EXPORTS = ['buildDispatchSignature', 'emitBaseSnapshot', 'clipTurnText', 'turnsSnapshot'];
// Ядро раздаёт по прежнему имени только то тело, которое само зовёт.
const FORWARDERS = ['emitBaseSnapshot'];
const NOT_FORWARDED = ['buildDispatchSignature', 'clipTurnText', 'turnsSnapshot'];

// ---- блоки K2, перенесённые в модуль дословно (S3) ----------------------------------
// Эталон — SHA-256 блока в core/deepseek-intercept.js на d6a74c2 (HEAD момента D.6),
// строки 307-489. Хэши сняты с блока и ЗАФИКСИРОВАНЫ здесь: сьют не читает git-историю
// (CI клонирует shallow), поэтому байтовая идентичность против базы доказывается двумя
// независимыми способами — этими пинами (текущий модуль) и tools/verify-deepseek-emit.js
// (дословное сравнение с git show, локально). Блок = срез от start-якоря до end-якоря.
const MOVED_BLOCKS = [
  {
    name: 'СЕКЦИЯ 4 + O-22 (заголовок)', zone: 'pure',
    start: '  // ===== СЕКЦИЯ 4: EMIT', end: '  function __bind(d) {',
    sha: 'b79e9e88a3c8a6fa700d102c13c0274f095dd1f0e2e53fd7e9e272e6bc1b1ea8'
  },
  {
    name: 'buildDispatchSignature', zone: 'bind',
    start: '  function buildDispatchSignature(convId, serverTokens, chatMode) {',
    end: '  function emitBaseSnapshot(serverTokens, chatMode) {',
    sha: '99dbef0585eb154fd3a8103417795ed0be4bd5cc7bd1d10e140d3b58579bf0bd'
  },
  {
    name: 'emitBaseSnapshot', zone: 'bind',
    start: '  function emitBaseSnapshot(serverTokens, chatMode) {',
    end: '  // v11 (O-17): сводка turnsMap',
    sha: '18aa304b8aa1e47fbb355ee227d24a970f4d6040fb7c6ed4190d87886c59076a'
  },
  {
    name: 'clipTurnText + turnsSnapshot', zone: 'bind',
    start: '  // v11 (O-17): сводка turnsMap',
    end: "  try {\n    window.addEventListener('ai-cm-turns-snap-request'",
    sha: 'd58de4f9772d6e20e523c69f6ab656d7be3ce140a601e10dc1df9c6dd777c234'
  },
  {
    name: 'мост turns-snap', zone: 'bind',
    start: "  try {\n    window.addEventListener('ai-cm-turns-snap-request'",
    end: '      Fn.buildDispatchSignature = buildDispatchSignature;',
    sha: '86b138620d0b39aad4d1917d4345dd8392268a27c76433be7d386b3534ad6511'
  }
];

// ---- состояние, которое ОСТАЛОСЬ в ядре (S3) ----------------------------------------
const KERNEL_KEPT = [
  '  var turnsMap = {};          // ключ = String(message_id)',
  '  var attachTokens = 0;',
  '  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };',
  '  var histCompletion = { historyComplete: false, reachedRoot: false, baseEmpty: false };',
  '  var lastBaseServerTokens = 0;',
  "  var lastBaseChatMode = '';",
  '  var lastDispatchSig = null;',
  '  var lastDispatchResult = null;',
  "    window.addEventListener('ai-cm-conversation-changed', function () { lastDispatchSig = null; });"
];

// Уникальные строки тел: их НЕ должно остаться в ядре (форвардер — только вызов модуля).
const BODY_MARKERS = [
  '  // ===== СЕКЦИЯ 4: EMIT (контракт как в gemini v21, + serverTokens, + modelMode) =====',
  '      turns.sort();   // снимок — это состав, а не порядок ключей turnsMap (порядок detail задаёт t.order)',
  "    serverTokens = (typeof serverTokens === 'number' && serverTokens > 0) ? serverTokens : 0;",
  '    var dispatchSig = buildDispatchSignature(',
  '  function clipTurnText(t) {',
  '  function turnsSnapshot() {',
  "    window.addEventListener('ai-cm-turns-snap-request', function () {"
];

// ---- вызовы в ядре, которые обязаны остаться на месте (S2/S3) -----------------------
// Step D.8: два первых сайта вызова (ре-эмит полноты 0→1 и приёмка снимка) жили внутри
// тела K5 (СЕКЦИЯ 8) и уехали в core/deepseek-ingest.js БАЙТ-В-БАЙТ — они проверяются по
// конкатенации (INGEST_CALLS). Резолв не изменился: ядро раздаёт тот же форвардер
// emitBaseSnapshot контрактом __bind модуля INGEST.
const KERNEL_CALLS = [
  '    var em = emitBaseSnapshot(serverTokens, chatMode);',
  '      emitBaseSnapshot: emitBaseSnapshot,'
];

const INGEST_CALLS = [
  '            emitBaseSnapshot(lastBaseServerTokens, lastBaseChatMode);',
  '      var em = emitBaseSnapshot(lastAccumulated, chatMode);'
];

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/** Блок K2 из исходника: срез от start-якоря до следующего end-якоря. */
function blockOf(src, b) {
  const s = src.indexOf(b.start);
  expect(s).toBeGreaterThan(-1);
  const e = src.indexOf(b.end, s);
  expect(e).toBeGreaterThan(s);
  return src.slice(s, e);
}

// ---- разбор литерала __bind ядра (единственный источник правды для стенда) ----------
function kernelBindKinds() {
  const start = KERNEL_SRC.lastIndexOf('aiCmDeepseekEmit.__bind({');
  expect(start).toBeGreaterThan(-1);
  const literal = KERNEL_SRC.slice(start, KERNEL_SRC.indexOf('});', start));
  const lines = literal.split('\n');
  const kinds = new Map();
  lines.forEach(function (l, i) {
    const g = l.match(/^\s*get\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/);
    if (g) {
      const name = g[1];
      kinds.set(name, new RegExp('set\\s+' + name + '\\s*\\(').test(lines.slice(i, i + 4).join('\n')) ? 'rw' : 'ro');
      return;
    }
    const p = l.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*,?\s*$/);
    if (p && p[1] === p[2]) kinds.set(p[1], 'fn');
  });
  return kinds;
}

const KINDS = kernelBindKinds();
const CONTRACT = FN_NAMES.map(function (n) { return [n, 'fn']; })
  .concat(RW_NAMES.map(function (n) { return [n, 'rw']; }))
  .concat(RO_NAMES.map(function (n) { return [n, 'ro']; }));

// ---- стенд vm: песочница с window/CustomEvent ---------------------------------------
function makeSandbox(startPath) {
  const logs = [];
  const listeners = [];
  const dispatched = [];
  const sandbox = {
    console: {
      log: function () { logs.push([].join.call(arguments, ' ')); },
      warn: function () { logs.push('WARN ' + [].join.call(arguments, ' ')); },
      error: function () { logs.push('ERR ' + [].join.call(arguments, ' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise, Date: Date,
    setTimeout: function () { return 0; }, clearTimeout: function () { },
    location: { pathname: startPath || '/a/chat/s/convEmit', origin: 'https://chat.deepseek.com' },
    CustomEvent: function (name, init) { this.type = name; this.detail = init && init.detail; }
  };
  sandbox.window = sandbox;
  sandbox.__listeners = listeners;
  sandbox.__events = [];
  sandbox.__dispatched = dispatched;
  sandbox.addEventListener = function (name, fn) {
    listeners.push({ name: name, fn: fn });
    sandbox.__events.push(name);
  };
  sandbox.__dispatch = function (name, payload) {
    listeners.filter(function (h) { return h.name === name; })
      .forEach(function (h) { h.fn(payload); });
    return true;
  };
  sandbox.dispatchEvent = function (ev) {
    dispatched.push(ev);
    return sandbox.__dispatch(ev && ev.type, ev);
  };
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs, dispatched: dispatched, listeners: listeners };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-emit.js' });
}

/** Полный набор зависимостей ядра: живые rw/ro + fn-счётчики (S2/S4). */
function makeProbe(over) {
  const st = {
    turnsMap: {},
    attachTokens: 0,
    attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
    histCompletion: { historyComplete: false, reachedRoot: false, baseEmpty: false },
    currentConvId: 'convEmit',
    lastBaseServerTokens: 0, lastBaseChatMode: '', lastDispatchSig: null, lastDispatchResult: null,
    __hashCalls: 0, __marks: [], __exportHooks: [], __debug: false, __convId: 'convEmit'
  };
  if (over) Object.keys(over).forEach(function (k) { st[k] = over[k]; });
  const writes = {};
  const calls = { marks: 0, exportHooks: 0 };
  const D = {};
  const fns = {
    diagHash6: function (s) { st.__hashCalls++; return 'h' + String(s == null ? '' : s).length; },
    diagMark: function (kind, payload) { calls.marks++; st.__marks.push([kind, payload]); },
    diagOn: function () { return st.__debug; },
    diagExportHook: function (reason) { calls.exportHooks++; st.__exportHooks.push(reason); },
    isDebugEnabled: function () { return st.__debug; },
    getConvId: function () { return st.__convId; },
    hasInjectedUserPrompt: function (text) { return String(text || '').indexOf('<BetterDeepSeek>') !== -1; }
  };
  FN_NAMES.forEach(function (n) {
    Object.defineProperty(D, n, { get: function () { return fns[n]; }, enumerable: true });
  });
  RW_NAMES.forEach(function (n) {
    Object.defineProperty(D, n, {
      get: function () { return st[n]; },
      set: function (v) { writes[n] = (writes[n] || 0) + 1; st[n] = v; },
      enumerable: true
    });
  });
  RO_NAMES.forEach(function (n) {
    Object.defineProperty(D, n, { get: function () { return st[n]; }, enumerable: true });
  });
  return { D: D, st: st, writes: writes, calls: calls };
}

/** Два хода базы: user + assistant с reasoning (reasoningTurns = 1). */
function twoTurns() {
  return {
    m1: { order: 1, role: 'user', text: 'Вопрос', modelSlug: '' },
    m2: { order: 2, role: 'assistant', text: '[REASONING]\nдумаю\n\n[ANSWER]\nОтвет', reasoning: 'думаю', modelSlug: 'deepseek-v4.1-flash' }
  };
}

describe('Step D.6: core/deepseek-emit.js — контракт модуля EMIT', () => {
  test('S1: литерал __bind в ядре содержит ровно 16 имён (7 fn + 4 rw + 5 ro)', function () {
    expect(KINDS.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) { expect(KINDS.get(pair[0])).toBe(pair[1]); });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 7, ro: 5, rw: 4 });
    // каждая fn-передача — реально существующая в ядре функция (хойстится к моменту связки)
    FN_NAMES.forEach(function (n) { expect(KERNEL_SRC).toContain('function ' + n + '('); });
    // rw/ro-состояние реально объявлено в ядре (иначе сеттер писал бы в никуда,
    // а геттер читал бы НЕЯВНЫЙ ГЛОБАЛ — урок D.5 на lastDispatchSig)
    RW_NAMES.concat(RO_NAMES).forEach(function (n) {
      expect(KERNEL_SRC).toMatch(new RegExp('^ {2}var\\s+' + n + '\\s*=', 'm'));
    });
    // модуль не объявляет их заново: иначе появилась бы ВТОРАЯ переменная, и ядро
    // читало бы старую (снимок/полнота терялись бы молча)
    RW_NAMES.concat(RO_NAMES).forEach(function (n) {
      expect(MODULE_SRC).not.toMatch(new RegExp('\\bvar\\s+' + n + '\\b'));
    });
    // тело ro-геттера — ровно чтение имени ядра
    const literal = KERNEL_SRC.slice(KERNEL_SRC.lastIndexOf('aiCmDeepseekEmit.__bind({'),
      KERNEL_SRC.indexOf('});', KERNEL_SRC.lastIndexOf('aiCmDeepseekEmit.__bind({')));
    RO_NAMES.forEach(function (n) {
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
    });
    RW_NAMES.forEach(function (n) {
      expect(literal).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });
    // K0 остался в ядре и по-прежнему экспортируется наружу (контрактный тест v13)
    expect(KERNEL_SRC).toContain('resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug');
    expect(KERNEL_SRC).toContain('function __aiCmDeepseekResolveModelSlug(signals) {');
  });

  test('S2: живая связка в vm — 4 тела, мост, запись в rw-аксессоры и гард O-22', function () {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekEmit;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);

    const probe = makeProbe();
    probe.st.turnsMap = twoTurns();
    probe.st.attachTokens = 42;
    probe.st.attachBreak = { imgTokens: 7, docTokens: 3, imgCount: 1, docCount: 2 };
    probe.st.histCompletion = { historyComplete: true, reachedRoot: true, baseEmpty: false };
    Fn.__bind(probe.D);
    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());
    EXPORTS.forEach(function (n) { expect(typeof Fn[n]).toBe('function'); });

    // мост turns-snap регистрируется на связке — ровно один раз
    expect(box.sandbox.__events.filter(function (n) { return n === 'ai-cm-turns-snap-request'; }).length).toBe(1);

    // публикация снимка: событие + запись в ЖИВЫЕ rw-аксессоры ядра
    const res = Fn.emitBaseSnapshot(500, 'expert');
    expect(res.count).toBe(2);
    expect(res.serverTokens).toBe(500);
    expect(res.lastModel).toBe('deepseek-v4.1-flash');
    expect(res.reasoningTurns).toBe(1);
    expect(res.textLen).toBeGreaterThan(0);
    expect(probe.st.lastBaseServerTokens).toBe(500);
    expect(probe.st.lastBaseChatMode).toBe('expert');
    expect(probe.st.lastDispatchSig).toEqual(expect.any(String));
    expect(probe.st.lastDispatchResult).toBe(res);            // rw: ядро видит тот же объект
    expect(probe.writes.lastDispatchSig).toBeGreaterThan(0);
    expect(probe.writes.lastBaseServerTokens).toBeGreaterThan(0);
    const ev = box.dispatched.filter(function (e) { return e.type === 'ai-cm-full-history'; });
    expect(ev).toHaveLength(1);
    expect(ev[0].detail.convId).toBe('convEmit');            // getConvId (fn ядра) — через bind
    expect(ev[0].detail.count).toBe(2);
    expect(ev[0].detail.modelMode).toBe('expert');
    expect(ev[0].detail.serverTokens).toBe(500);
    expect(ev[0].detail.attachTokens).toBe(42);
    expect(ev[0].detail.attachBreak).toEqual({ imgTokens: 7, docTokens: 3, imgCount: 1, docCount: 2 });
    expect(ev[0].detail.historyComplete).toBe(true);
    expect(ev[0].detail.reachedRoot).toBe(true);
    expect(ev[0].detail.baseEmpty).toBe(false);
    expect(ev[0].detail.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(ev[0].detail.reasoningTexts).toEqual(['', 'думаю']);
    expect(ev[0].detail.reasoningTurns).toBe(1);
    expect(ev[0].detail.messageIds).toEqual(['m1', 'm2']);
    expect(ev[0].detail.lastMessageText).toBe('[REASONING]\nдумаю\n\n[ANSWER]\nОтвет');
    expect(ev[0].detail.messageTexts).toEqual(['Вопрос', '[REASONING]\nдумаю\n\n[ANSWER]\nОтвет']);
    expect(ev[0].detail.text).toBe('Вопрос\n[REASONING]\nдумаю\n\n[ANSWER]\nОтвет');

    // гард O-22: тот же снимок повторно → ранний возврат lastDispatchResult без события
    probe.st.__debug = true;
    const res2 = Fn.emitBaseSnapshot(500, 'expert');
    expect(res2).toBe(res);
    expect(box.dispatched.filter(function (e) { return e.type === 'ai-cm-full-history'; })).toHaveLength(1);
    expect(probe.st.__marks.filter(function (m) { return m[0] === 'o22-dispatch-skip'; })).toHaveLength(1);
    expect(probe.st.__marks.filter(function (m) { return m[0] === 'o22-dispatch-fn'; })).toHaveLength(1);

    // смена базы → сигнатура другая → снимок публикуется
    probe.st.turnsMap.m3 = { order: 3, role: 'user', text: 'Ещё вопрос', modelSlug: '' };
    const res3 = Fn.emitBaseSnapshot(500, 'expert');
    expect(res3).not.toBe(res);
    expect(box.dispatched.filter(function (e) { return e.type === 'ai-cm-full-history'; })).toHaveLength(2);
    expect(probe.st.__marks.filter(function (m) { return m[0] === 'o22-dispatch-fn'; })).toHaveLength(2);
    expect(probe.st.__marks.filter(function (m) { return m[0] === 'o22-dispatch-skip'; })).toHaveLength(1);

    // повторная загрузка модуля не перетирает уже связанный API
    loadModule(box);
    expect(box.sandbox.AiCmDeepseekEmit).toBe(Fn);
    expect(typeof Fn.emitBaseSnapshot).toBe('function');
  });

  test('S3: тела K2 перенесены дословно (SHA-256 блоков); в ядре — надгробие и форвардер', function () {
    // Байтовая идентичность: SHA-256 каждого блока в модуле равен эталону с d6a74c2.
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      expect(sha256(body)).toBe(b.sha);
    });
    // зоны: заголовок СЕКЦИИ 4 — ВНЕ with (D), все тела — ВНУТРИ (иначе свободные имена
    // ядра не резолвятся: лексический скоуп объявления, урок D.5/D.1)
    const bindAt = MODULE_SRC.indexOf('  function __bind(d) {');
    const withAt = MODULE_SRC.indexOf('    with (D) {');
    const fnFillAt = MODULE_SRC.indexOf('      Fn.buildDispatchSignature =');
    expect(bindAt).toBeGreaterThan(0);
    expect(withAt).toBeGreaterThan(bindAt);
    expect(fnFillAt).toBeGreaterThan(withAt);
    const pureZone = MODULE_SRC.slice(0, bindAt);
    const bindZone = MODULE_SRC.slice(withAt, fnFillAt);
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      if (b.zone === 'pure') expect(pureZone).toContain(body);
      else expect(bindZone).toContain(body);
    });
    // маркеры тел: живут в модуле, в ядре их нет (иначе пины-дубли)
    BODY_MARKERS.forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
      expect(KERNEL_SRC).not.toContain(l);
    });
    // надгробие на месте, заголовка СЕКЦИИ 4 в ядре больше нет
    expect(KERNEL_SRC).toContain('// ===== Step D.6: K2 (EMIT) вынесен в core/deepseek-emit.js =====');
    expect(KERNEL_SRC).not.toContain('// ===== СЕКЦИЯ 4: EMIT');
    // состояние и O-22-слушатель ОСТАЛИСЬ в ядре (их ведут/пишут K5/K6/K9/K11 и слушатель)
    KERNEL_KEPT.forEach(function (line) {
      expect(KERNEL_SRC).toContain(line);
      expect(MODULE_SRC).not.toContain(line);
    });
    // форвардеры — function declaration (хойстятся: вызовы выше по файлу видят имя)
    FORWARDERS.forEach(function (n) {
      expect(KERNEL_SRC).toContain('\n  function ' + n + '(');
      expect(KERNEL_SRC).toContain('aiCmDeepseekEmit.' + n + '(');
      expect(MODULE_SRC).toContain('      Fn.' + n + ' = ' + n + ';');
    });
    NOT_FORWARDED.forEach(function (n) {
      expect(KERNEL_SRC).not.toContain('aiCmDeepseekEmit.' + n + '(');
      expect(MODULE_SRC).toContain('      Fn.' + n + ' = ' + n + ';');
    });
    const fwdCount = (KERNEL_SRC.match(/^ {2}function emitBaseSnapshot\(/gm) || []).length;
    expect(fwdCount).toBe(1);
    // префиксов D. в телах модуля нет (with (D), ES3 Annex B)
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // вызовы в ядре не сдвинуты
    KERNEL_CALLS.forEach(function (l) { expect(KERNEL_SRC).toContain(l); });
    // два сайта вызова внутри вынесенного тела K5 (Step D.8) — по конкатенации
    INGEST_CALLS.forEach(function (l) { expect(DS.deepseekSource).toContain(l); });
    // размеры: K2 уехал целиком (ядро ушло ниже 2000 строк, модуль — за 250)
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(2000);
    expect(MODULE_SRC.split('\n').length).toBeGreaterThan(250);
  });

  test('S4: сигнатура, сводка turnsMap, clipTurnText и мост turns-snap — живая семантика', function () {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekEmit;
    const probe = makeProbe();
    probe.st.turnsMap = twoTurns();
    probe.st.histCompletion = { historyComplete: true, reachedRoot: true, baseEmpty: false };
    Fn.__bind(probe.D);

    // ---- buildDispatchSignature: состав, а не порядок ключей ----
    const sig = Fn.buildDispatchSignature('convEmit', 100, 'default');
    expect(typeof sig).toBe('string');
    expect(sig.indexOf('convEmit') === 0).toBe(true);
    expect(sig).toContain('100');
    expect(sig).toContain('default');
    // тот же состав в другом порядке ключей → ТА ЖЕ сигнатура (turns.sort())
    probe.st.turnsMap = { m2: twoTurns().m2, m1: twoTurns().m1 };
    expect(Fn.buildDispatchSignature('convEmit', 100, 'default')).toBe(sig);
    // изменение текста/роли/reasoning/serverTokens/вложений/полноты → другая сигнатура
    const variants = [
      function () { probe.st.turnsMap.m1.text = 'Вопрос!'; },
      function () { probe.st.turnsMap.m1.role = 'unknown'; },
      function () { probe.st.turnsMap.m2.reasoning = 'думаю иначе'; },
      function () { probe.st.turnsMap.m2.modelSlug = ''; },
      function () { probe.st.attachTokens = 5; },
      function () { probe.st.attachBreak.imgTokens = 1; },
      function () { probe.st.histCompletion.historyComplete = false; },
      function () { probe.st.histCompletion.baseEmpty = true; }
    ];
    variants.forEach(function (mutate, i) {
      const before = twoTurns();
      probe.st.turnsMap = before;
      const base = Fn.buildDispatchSignature('convEmit', 100, 'default');
      mutate();
      expect(Fn.buildDispatchSignature('convEmit', 100, 'default')).not.toBe(base, 'вариант ' + i);
      probe.st.attachTokens = 0;
      probe.st.attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
      probe.st.histCompletion = { historyComplete: true, reachedRoot: true, baseEmpty: false };
    });
    // хеш текста берётся у ядра (diagHash6 — fn-передача), а не своей копией FNV
    const hashBefore = probe.st.__hashCalls;
    Fn.buildDispatchSignature('convEmit', 100, 'default');
    expect(probe.st.__hashCalls).toBeGreaterThan(hashBefore);
    expect(MODULE_SRC).not.toContain('2166136261');   // FNV-база живёт в core/deepseek-diag.js

    // ---- clipTurnText ----
    expect(Fn.clipTurnText({ text: 'a\n\nb   c' })).toBe('a b c');
    expect(Fn.clipTurnText({ text: 'x'.repeat(200) })).toHaveLength(80);
    expect(Fn.clipTurnText(null)).toBe('');
    expect(Fn.clipTurnText({})).toBe('');

    // ---- turnsSnapshot: поля сводки (v11/O-17) ----
    probe.st.turnsMap = {
      m1: { order: 1, role: 'user', text: 'Первый вопрос' },
      m2: { order: 2, role: 'assistant', text: 'Первый ответ' },
      m3: { order: 3, role: 'user', text: 'Второй вопрос' }
    };
    const snap = Fn.turnsSnapshot();
    expect(snap).toEqual({
      convId: 'convEmit',
      msgs: 3,
      firstText: 'Первый вопрос',
      lastText: 'Второй вопрос',
      baseComplete: true,
      reachedStart: true,
      confirmedByScroll: false,
      scrollEngaged: false,
      baseMsgs: 3,
      liveCount: 3,
      archiveCount: 0
    });
    // фолбэк convId: currentConvId пуст → getConvId (fn ядра)
    probe.st.currentConvId = '';
    probe.st.__convId = 'convFallback';
    expect(Fn.turnsSnapshot().convId).toBe('convFallback');
    probe.st.currentConvId = 'convEmit';
    // неполная база → baseComplete/reachedStart = false
    probe.st.histCompletion = { historyComplete: false, reachedRoot: false, baseEmpty: false };
    expect(Fn.turnsSnapshot().baseComplete).toBe(false);
    expect(Fn.turnsSnapshot().reachedStart).toBe(false);

    // ---- мост turns-snap: ответ + измерение O-18 ----
    box.sandbox.__dispatch('ai-cm-turns-snap-request', {});
    const resp = box.dispatched.filter(function (e) { return e.type === 'ai-cm-turns-snap-response'; });
    expect(resp).toHaveLength(1);
    expect(resp[0].detail.msgs).toBe(3);
    expect(resp[0].detail.convId).toBe('convEmit');
    expect(probe.st.__exportHooks).toEqual(['turns-snap-request']);
  });

  test('S5: проводка — js[] после conv и перед ядром, id -v11 + unregister -v10, helper', function () {
    // модуль строго перед ядром и строго после conv
    expect(DS.SOURCES.indexOf('core/deepseek-emit.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
    expect(DS.SOURCES.indexOf('core/deepseek-conv.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-emit.js'));
    expect(DS.MODULES).toContain('core/deepseek-emit.js');
    // регистрация ядра: js[] с модулем. Steps D.7-D.9 сдвинули регистрацию дальше
    // (-v11 + снятие -v10, добавлены core/deepseek-net.js … deepseek-sse.js) —
    // актуальные значения пинованы в deepseek-d8-module.test.js; здесь проверяется,
    // что модуль D.6 остался в js[] и ядро его читает.
    expect(KERNEL_SRC).toContain('aiCmDeepseekEmit');
    const bg = DS.readSource('core/background.js');
    expect(bg).toContain("js: ['utils/debug.js', 'core/deepseek-diag.js', 'core/deepseek-netsync.js', 'core/deepseek-refetch.js', 'core/deepseek-parse.js', 'core/deepseek-conv.js', 'core/deepseek-emit.js', 'core/deepseek-net.js', 'core/deepseek-ingest.js', 'core/deepseek-sse.js', 'core/deepseek-intercept.js']");
    expect(bg).toContain("ids.indexOf('ai-cm-deepseek-intercept-v11') === -1");
    expect(bg).toContain("unregisterContentScripts({ ids: ['ai-cm-deepseek-intercept-v10'] })");
    expect(bg).toContain('перехватчик DeepSeek v11 зарегистрирован');
    // модуль: UTF-8 без BOM, LF, хвостовой \n; каркас
    const buf = require('fs').readFileSync(require('path').join(DS.ROOT, 'core/deepseek-emit.js'));
    expect(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF).toBe(false);
    expect(MODULE_SRC.indexOf('\r')).toBe(-1);
    expect(MODULE_SRC.endsWith('\n')).toBe(true);
    ['window.AiCmDeepseekEmit = Fn;', 'Fn.__bind = __bind;', 'module.exports = Fn;'].forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
    });
  });
});
