/**
 * Step D.5 (декомпозиция core/deepseek-intercept.js): контракт модуля CONV ID.
 *
 * Кластер K1 (СЕКЦИЯ 3 ядра — CONV ID + детектор смены чата: getConvId, сброс состояния
 * resetForNewConversation, checkConvChange и патчи history.pushState/replaceState/popstate)
 * уехал в core/deepseek-conv.js. Модуль и ядро — РАЗНЫЕ IIFE одного registerContentScripts-
 * пакета (js[]: utils/debug.js -> deepseek-diag.js -> deepseek-netsync.js ->
 * deepseek-refetch.js -> deepseek-parse.js -> deepseek-conv.js -> deepseek-intercept.js),
 * поэтому связь идёт ровно через один контракт:
 *
 *   ядро -> модуль: window.AiCmDeepseekConv.__bind(deps)
 *     fn (3): diagResetForConv — диагностический сброс колец O-18 (function declaration
 *             ядра, хойстится: значение доступно на момент связки);
 *             resetStreamState — K6 (SSE: тела ещё в ядре);
 *             scheduleHistoryRefetch — форвардер модуля D.3.
 *     rw (19): состояние сброса, которое тело ПЕРЕЗАПИСЫВАЕТ: без сеттера запись в
 *             sloppy-режиме молча терялась бы (currentConvId, lastDiagConvId, turnsMap,
 *             orderCounter, attachTokens, attachBreak, loggedOk, loggedHistory,
 *             loggedRealtime, lastLoadedConvId, lastHistoryUrl, historyRefetchDone,
 *             lastBaseServerTokens, lastBaseChatMode, liveTurns, liveTurnOrder,
 *             netSnapshotAt, netTurnIds, lastTurnDoneAt).
 *     ro (1): histCompletion — тело мутирует ПОЛЯ объекта, а не переприсваивает имя;
 *             мутация по ссылке видна ядру без сеттера.
 *   модуль -> ядро: Fn.<fn> после __bind; ядро раздаёт 2 из 3 тел форвардерами
 *   (getConvId, resetForNewConversation) — function declaration, хойстятся. checkConvChange
 *   наружу не выдаётся: его зовут только патчи и popstate-слушатель самого модуля.
 *
 * Здесь пинятся:
 *   S1. Полнота контракта: литерал __bind в ядре содержит ровно 23 имени (3 fn + 19 rw +
 *       1 ro), ни одного потерянного/лишнего; каждое имя реально существует в ядре.
 *   S2. Живая связка в vm: до __bind наружу торчит ТОЛЬКО __bind; РАННЯЯ связка
 *       __bind({}) даёт 3 функции (нужна: ядро зовёт getConvId на загрузке), но сброс
 *       на ней не исполняется (guard полноты связки); ПОЛНАЯ связка оживляет сброс;
 *       повторная загрузка модуля не перетирает уже связанный API.
 *   S3. Байтовая идентичность тел: блоки K1 (СЕКЦИЯ 3 HEAD 6c899fd, строки 244-338) лежат
 *       в модуле ДОСЛОВНО (SHA-256 каждого блока снят с 6c899fd и зафиксирован здесь —
 *       git-история сьютом не читается, CI shallow); объявления (lastAuthHeaders …
 *       histCompletion), O-22-слушатель и currentConvId остались в ядре; префиксов D. нет.
 *   S4. Живая семантика K1: getConvId (оба шаблона пути /a/chat/s/<id> и /a/chat/<id>),
 *       checkConvChange (смена чата → сброс), дедупликация (тот же convId → без сброса),
 *       resetForNewConversation (полный сброс состояния + событие + scheduleHistoryRefetch
 *       + запись в ЖИВЫЕ rw-аксессоры ядра), патчи pushState/replaceState/popstate.
 *   S5. Проводка: js[] строго после deepseek-parse.js и перед ядром, id -v7 + unregister -v6,
 *       helper MODULES, размеры ядра/модуля, K0 не тронут.
 */

const vm = require('vm');
const crypto = require('crypto');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-conv.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 3 fn + 19 rw + 1 ro = 23 имени ---------------------------
const FN_NAMES = ['diagResetForConv', 'resetStreamState', 'scheduleHistoryRefetch'];
const RW_NAMES = ['currentConvId', 'lastDiagConvId', 'turnsMap', 'orderCounter', 'attachTokens',
  'attachBreak', 'loggedOk', 'loggedHistory', 'loggedRealtime', 'lastLoadedConvId',
  'lastHistoryUrl', 'historyRefetchDone', 'lastBaseServerTokens', 'lastBaseChatMode',
  'liveTurns', 'liveTurnOrder', 'netSnapshotAt', 'netTurnIds', 'lastTurnDoneAt'];
const RO_NAMES = ['histCompletion'];

// ---- что модуль отдаёт наружу после __bind (S2) -------------------------------------
const EXPORTS = ['getConvId', 'resetForNewConversation', 'checkConvChange'];
// Ядро раздаёт по прежним именам только те тела, которые само зовёт.
const FORWARDERS = ['getConvId', 'resetForNewConversation'];
const NOT_FORWARDED = ['checkConvChange'];

// ---- блоки K1, перенесённые в модуль дословно (S3) ----------------------------------
// Эталон — SHA-256 блока в core/deepseek-intercept.js на 6c899fd (HEAD момента D.5),
// строки 244-338. Хэши сняты с git-блоба и ЗАФИКСИРОВАНЫ здесь: сьют не читает
// git-историю (CI клонирует shallow), поэтому байтовая идентичность против базы
// доказывается двумя независимыми способами — этими пинами (текущий модуль) и
// tools/verify-deepseek-conv.js (дословное сравнение с git show, локально).
const MOVED_BLOCKS = [
  {
    name: 'СЕКЦИЯ 3 + getConvId', start: '  // ===== СЕКЦИЯ 3: CONV ID',
    sigs: ['  function getConvId() {'],
    sha: '0d0d833299fb6b987d58443fb37feeefc51b6963670a74574bcff469d0bd3f3f'
  },
  {
    name: 'resetForNewConversation', start: '  function resetForNewConversation() {',
    sigs: ['  function resetForNewConversation() {'],
    sha: '90834ca75c42cda451350600694bcf6246959250ae5e7e299b820f1e497bab57'
  },
  {
    name: 'checkConvChange', start: '  function checkConvChange() {',
    sigs: ['  function checkConvChange() {'],
    sha: '682571a79383b629744b180735efc89fe32212ac396fb8807ac6d7dbd16f18f9'
  },
  {
    name: 'патчи pushState/replaceState/popstate', start: '  try {\n    var origPush',
    sigs: ["    window.addEventListener('popstate',"],
    // блок дословно совпадает с ядром 6c899fd 320-338
    sha: '187de08f974c28b28bf537e49ff78820143ea8a16b47758f1df49bf2eab85c50'
  }
];

// ---- состояние, которое ОСТАЛОСЬ в ядре (S3) ----------------------------------------
const KERNEL_KEPT = [
  '  var lastAuthHeaders = {};',
  '  var lastDispatchSig = null;',
  '  var lastDispatchResult = null;',
  '  var histCompletion = { historyComplete: false, reachedRoot: false, baseEmpty: false };',
  '  // O-22 (ФИКС F4): сигнатура последнего РЕАЛЬНО опубликованного снимка и его возвращаемое'
];

// Уникальные строки тел: их НЕ должно остаться в ядре (форвардеры — только вызовы).
const BODY_MARKERS = [
  "      var m = location.pathname.match(/\\/a\\/chat\\/s\\/([A-Za-z0-9_-]+)/);",
  "    if (newId !== currentConvId) {",
  "    diagResetForConv('conv-change', lastDiagConvId);",
  "    history.pushState = function () {",
  "    window.addEventListener('popstate', function () { try { checkConvChange(); } catch (e) { } });",
  '  // ===== СЕКЦИЯ 3: CONV ID + ДЕТЕКТОР СМЕНЫ ЧАТА'
];

// ---- вызовы в ядре, которые обязаны остаться на месте (S2/S3) -----------------------
const KERNEL_CALLS = [
  "var currentConvId = aiCmDeepseekConv ? aiCmDeepseekConv.getConvId() : '';",
  "convId: (typeof getConvId === 'function') ? (getConvId() || currentConvId || '') : (currentConvId || '')",
  'var sameConv = function () { return !convId || convId === currentConvId; };'
];

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/** Конец описания функции: индекс сразу за закрывающей скобкой тела. */
function braceEnd(src, sigAt) {
  let depth = 0;
  for (let i = src.indexOf('{', sigAt); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced declaration');
}

/** Блок K1 из исходника: якорь начала + тела функций (до конца последней). */
function blockOf(src, b) {
  const s = src.indexOf(b.start);
  expect(s).toBeGreaterThan(-1);
  let end = -1;
  b.sigs.forEach(function (sig) {
    const f = src.indexOf(sig, s);
    expect(f).toBeGreaterThan(-1);
    end = braceEnd(src, f);
  });
  return src.slice(s, end);
}

// ---- разбор литерала __bind ядра (единственный источник правды для стенда) ----------
function kernelBindKinds() {
  // Ранняя связка — __bind({}); интересна ПОЛНАЯ (последняя в файле).
  const start = KERNEL_SRC.lastIndexOf('aiCmDeepseekConv.__bind({');
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

// ---- стенд vm: песочница с location/history/window ---------------------------------
function makeSandbox(startPath) {
  const logs = [];
  const sandbox = {
    console: {
      log: function () { logs.push([].join.call(arguments, ' ')); },
      warn: function () { logs.push('WARN ' + [].join.call(arguments, ' ')); },
      error: function () { logs.push('ERR ' + [].join.call(arguments, ' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise, Date: Date,
    setTimeout: function () { return 0; }, clearTimeout: function () { },
    location: { pathname: startPath || '/a/chat/s/convOrder', origin: 'https://chat.deepseek.com' },
    history: {
      pushState: function () { },
      replaceState: function () { }
    },
    CustomEvent: function (name, init) { this.type = name; this.detail = init && init.detail; }
  };
  sandbox.window = sandbox;
  const resets = [];
  const listeners = [];
  sandbox.__resets = resets;
  sandbox.addEventListener = function (name, fn) { listeners.push({ name: name, fn: fn }); sandbox.__events.push(name); };
  sandbox.__listeners = listeners;
  sandbox.__events = [];
  sandbox.__dispatch = function (name, payload) {
    listeners.filter(function (h) { return h.name === name; })
      .forEach(function (h) { h.fn(payload); });
    return true;
  };
  sandbox.dispatchEvent = function (ev) {
    if (ev && ev.type === 'ai-cm-conversation-changed') resets.push(ev);
    return sandbox.__dispatch(ev && ev.type, ev);
  };
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs, resets: resets };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-conv.js' });
}

/** Полный набор зависимостей ядра: живые rw/ro + fn-счётчики (S2/S4). */
function makeProbe(over) {
  const st = {
    diagResetForConv: function (reason, prev) { st.__diagCalls.push({ reason: reason, prev: prev }); },
    resetStreamState: function () { st.__streamCalls++; },
    scheduleHistoryRefetch: function () { st.__refetchCalls++; },
    __diagCalls: [], __streamCalls: 0, __refetchCalls: 0
  };
  RW_NAMES.forEach(function (n) {
    if (n === 'turnsMap' || n === 'attachBreak' || n === 'liveTurns' || n === 'netTurnIds' || n === 'liveTurnOrder') st[n] = {};
    else if (n === 'orderCounter' || n === 'attachTokens' || n === 'lastBaseServerTokens' || n === 'netSnapshotAt' || n === 'lastTurnDoneAt') st[n] = 0;
    else if (n === 'loggedOk' || n === 'loggedHistory' || n === 'loggedRealtime' || n === 'historyRefetchDone') st[n] = true;
    else st[n] = '';
  });
  st.currentConvId = 'convOrder';
  st.histCompletion = { historyComplete: true, reachedRoot: true, baseEmpty: false };
  if (over) Object.keys(over).forEach(function (k) { st[k] = over[k]; });
  const writes = {};
  const calls = { diag: [], stream: 0, refetch: 0 };
  const D = {};
  FN_NAMES.forEach(function (n) {
    Object.defineProperty(D, n, {
      get: function () {
        if (n === 'diagResetForConv') return function (reason, prev) { calls.diag.push([reason, prev]); return st.diagResetForConv(reason, prev); };
        if (n === 'resetStreamState') return function () { calls.stream++; };
        return function () { calls.refetch++; };
      },
      enumerable: true
    });
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

describe('Step D.5: core/deepseek-conv.js — контракт модуля CONV ID + детектора смены чата', () => {
  test('S1: литерал __bind в ядре содержит ровно 23 имени (3 fn + 19 rw + 1 ro)', function () {
    expect(KINDS.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) { expect(KINDS.get(pair[0])).toBe(pair[1]); });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 3, ro: 1, rw: 19 });
    // каждая fn-передача — реально существующая в ядре функция (хойстится к моменту связки)
    FN_NAMES.forEach(function (n) { expect(KERNEL_SRC).toContain('function ' + n + '('); });
    // rw-состояние реально объявлено в ядре (иначе сеттер писал бы в никуда)
    RW_NAMES.forEach(function (n) { expect(KERNEL_SRC).toMatch(new RegExp('^ {2}var\\s+' + n + '\\s*=', 'm')); });
    expect(KERNEL_SRC).toMatch(/var\s+histCompletion\b/);
    // последняя запись литерала — без хвостовой запятой: проверяем тело ro-геттера
    const literal = KERNEL_SRC.slice(KERNEL_SRC.lastIndexOf('aiCmDeepseekConv.__bind({'),
      KERNEL_SRC.indexOf('});', KERNEL_SRC.lastIndexOf('aiCmDeepseekConv.__bind({')));
    RO_NAMES.forEach(function (n) {
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
    });
    // K0 остался в ядре и по-прежнему экспортируется наружу (контрактный тест v13)
    expect(KERNEL_SRC).toContain('resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug');
    expect(KERNEL_SRC).toContain('function __aiCmDeepseekResolveModelSlug(signals) {');
  });

  test('S2: живая связка в vm — ранняя связка даёт функции, полная оживляет сброс', function () {
    const box = makeSandbox('/a/chat/s/convOrder');
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekConv;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);

    // ранняя связка (её зовёт ядро на загрузке, чтобы получить getConvId до инициализации
    // currentConvId): функции доступны сразу, но сброс ещё не может читать состояние ядра
    const probeEarly = makeProbe();
    Fn.__bind({});
    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());
    EXPORTS.forEach(function (n) { expect(typeof Fn[n]).toBe('function'); });
    expect(Fn.getConvId()).toBe('convOrder');            // getConvId состояния ядра не читает
    expect(Fn.resetForNewConversation()).toBeUndefined(); // guard полноты связки: no-op
    expect(probeEarly.calls.stream).toBe(0);              // холостого сброса НЕ было

    // полная связка (в конце IIFE ядра): 23 имени, сброс оживает
    const probe = makeProbe();
    Fn.__bind(probe.D);
    probe.st.attachTokens = 777;
    expect(Fn.resetForNewConversation()).toBeUndefined();
    expect(probe.calls.stream).toBe(1);                  // resetStreamState вызван
    expect(probe.calls.refetch).toBe(1);                 // scheduleHistoryRefetch вызван
    expect(probe.st.attachTokens).toBe(0);               // живой rw-аксессор записан
    expect(probe.st.turnsMap).toEqual({});
    // повторная загрузка модуля не перетирает уже связанный API
    loadModule(box);
    expect(box.sandbox.AiCmDeepseekConv).toBe(Fn);
    expect(typeof Fn.resetForNewConversation).toBe('function');
  });

  test('S3: тела K1 перенесены дословно (SHA-256 блоков); в ядре — надгробие и 2 форвардера', function () {
    // Байтовая идентичность: SHA-256 каждого блока в модуле равен эталону с 6c899fd.
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      expect(sha256(body)).toBe(b.sha);
    });
    // маркеры тел: живут в модуле, в ядре их нет (иначе пины-дубли)
    BODY_MARKERS.forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
      expect(KERNEL_SRC).not.toContain(l);
    });
    // надгробие на месте, заголовка СЕКЦИИ 3 в ядре больше нет
    expect(KERNEL_SRC).toContain('// ===== Step D.5: K1 (CONV ID + ДЕТЕКТОР СМЕНЫ ЧАТА) вынесен в core/deepseek-conv.js =====');
    expect(KERNEL_SRC).not.toContain('// ===== СЕКЦИЯ 3: CONV ID');
    // объявления и O-22-слушатель ОСТАЛИСЬ в ядре (их читают K3-K11)
    KERNEL_KEPT.forEach(function (line) {
      expect(KERNEL_SRC).toContain(line);
      expect(MODULE_SRC).not.toContain(line);
    });
    // currentConvId остался в ядре (контракты D.1/D.2 + оставшиеся секции)
    expect(KERNEL_SRC).toContain("var currentConvId = aiCmDeepseekConv ? aiCmDeepseekConv.getConvId() : '';");
    expect(MODULE_SRC).not.toMatch(/var\s+currentConvId\b/);
    // форвардеры — function declaration (хойстятся: вызовы выше по файлу видят имя)
    FORWARDERS.forEach(function (n) {
      expect(KERNEL_SRC).toContain('\n  function ' + n + '(');
      expect(KERNEL_SRC).toContain('aiCmDeepseekConv.' + n + '(');
      expect(MODULE_SRC).toContain('      Fn.' + n + ' = ' + n + ';');
    });
    NOT_FORWARDED.forEach(function (n) {
      expect(KERNEL_SRC).not.toContain('aiCmDeepseekConv.' + n + '(');
      expect(MODULE_SRC).toContain('      Fn.' + n + ' = ' + n + ';');
    });
    const fwdCount = (KERNEL_SRC.match(/^ {2}function (?:getConvId|resetForNewConversation)\(/gm) || []).length;
    expect(fwdCount).toBe(2);
    // guard полноты связки — единственная добавленная строка тела сброса
    expect(MODULE_SRC).toContain('    if (!D || Object.keys(D).length === 0) { return; }   // ранняя связка: ядро ещё не отдало состояние');
    // префиксов D. в телах модуля нет (with (D), ES3 Annex B)
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // вызовы в ядре не сдвинуты
    KERNEL_CALLS.forEach(function (l) { expect(KERNEL_SRC).toContain(l); });
    // размеры: K1 уехал целиком (ядро ушло ниже 2120 строк, модуль — за 150)
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(2120);
    expect(MODULE_SRC.split('\n').length).toBeGreaterThan(150);
  });

  test('S4: getConvId / checkConvChange / resetForNewConversation — живая семантика K1', function () {
    const box = makeSandbox('/a/chat/s/convOrder');
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekConv;
    const probe = makeProbe();
    Fn.__bind(probe.D);

    // ---- getConvId: оба шаблона пути + мусорные URL → '' ----
    expect(Fn.getConvId()).toBe('convOrder');
    box.sandbox.location.pathname = '/a/chat/plainConv';
    expect(Fn.getConvId()).toBe('plainConv');
    box.sandbox.location.pathname = '/a/chat/s/with-dash_underscore';
    expect(Fn.getConvId()).toBe('with-dash_underscore');
    box.sandbox.location.pathname = '/';
    expect(Fn.getConvId()).toBe('');
    // '/a/chat/s/<пусто>': первый шаблон требует минимум один символ id, поэтому его
    // не находит, а второй ловит 's' как обычный /a/chat/<id> — поведение байтово прежнее.
    box.sandbox.location.pathname = '/a/chat/s/';
    expect(Fn.getConvId()).toBe('s');
    box.sandbox.location.pathname = '/a/chat/s/convOrder';

    // ---- checkConvChange: тот же convId → сброса нет ----
    Fn.checkConvChange();
    expect(probe.calls.stream).toBe(0);
    expect(probe.st.currentConvId).toBe('convOrder');

    // ---- смена чата → сброс состояния и запись в ЖИВЫЕ rw-аксессоры ядра ----
    probe.st.turnsMap = { old: {} };
    probe.st.orderCounter = 42;
    probe.st.attachTokens = 999;
    probe.st.loggedOk = true;
    probe.st.lastLoadedConvId = 'convOrder';
    probe.st.lastHistoryUrl = 'https://x/history_messages?chat_session_id=convOrder';
    probe.st.historyRefetchDone = true;
    // lastDiagConvId — переменная ЯДРА (её ведёт связка D.1): тело сброса читает её как prevConv
    // и ПЕРЕЗАПИСЫВАЕТ текущим convId. Ставим прошлое значение ДО сброса.
    probe.st.lastDiagConvId = 'convOrder';
    box.sandbox.location.pathname = '/a/chat/s/convNext';
    Fn.checkConvChange();
    expect(probe.st.currentConvId).toBe('convNext');         // rw: ядро видит новый convId
    expect(probe.writes.lastDiagConvId).toBeGreaterThan(0);   // rw: запись в живой аксессор
    expect(probe.st.lastDiagConvId).toBe('convNext');        // prevConv переписан новым convId
    expect(probe.st.turnsMap).toEqual({});
    expect(probe.st.orderCounter).toBe(0);
    expect(probe.st.attachTokens).toBe(0);
    expect(probe.st.attachBreak).toEqual({ imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 });
    expect(probe.st.loggedOk).toBe(false);
    expect(probe.st.lastLoadedConvId).toBe('');
    expect(probe.st.lastHistoryUrl).toBe('');
    expect(probe.st.historyRefetchDone).toBe(false);
    expect(probe.st.histCompletion).toEqual({ historyComplete: false, reachedRoot: false, baseEmpty: false });
    expect(probe.calls.diag).toEqual([['conv-change', 'convOrder']]);  // prevConv = прошлый convId
    expect(probe.calls.stream).toBe(1);
    expect(probe.calls.refetch).toBe(1);

    // ---- тот же convId повторно → сброса нет (дедупликация) ----
    Fn.checkConvChange();
    expect(probe.calls.stream).toBe(1);
    expect(probe.calls.diag.length).toBe(1);

    // ---- патчи истории: pushState/replaceState взводят детектор, popstate — слушатель ----
    expect(box.sandbox.__events.filter(function (n) { return n === 'popstate'; }).length).toBe(1);
    // свежая песочница: «нативные» методы уже стоят в истории до загрузки модуля
    // (порядок «модуль → ядро» в js[] это и гарантирует в браузере).
    const box2 = makeSandbox('/a/chat/s/convOrder');
    box2.sandbox.history.pushState = function (st, t, url) {
      box2.sandbox.location.pathname = String(url);
      return 'native-ok';
    };
    box2.sandbox.history.replaceState = function (st, t, url) {
      box2.sandbox.location.pathname = String(url);
      return 'native-replaced';
    };
    loadModule(box2);
    const Fn2 = box2.sandbox.AiCmDeepseekConv;
    const probe2 = makeProbe();
    Fn2.__bind(probe2.D);
    expect(Fn2.getConvId()).toBe('convOrder');
    expect(box2.sandbox.history.pushState({}, '', '/a/chat/s/convPushed')).toBe('native-ok');
    expect(probe2.st.currentConvId).toBe('convPushed');       // детектор взведён патчем pushState
    expect(probe2.calls.stream).toBe(1);                      // и состояние сброшено
    expect(box2.sandbox.history.replaceState({}, '', '/a/chat/s/convReplaced')).toBe('native-replaced');
    expect(probe2.st.currentConvId).toBe('convReplaced');     // патч replaceState тоже взводит детектор
    expect(probe2.calls.stream).toBe(2);
    // popstate-слушатель взводит тот же детектор
    box2.sandbox.location.pathname = '/a/chat/s/convPopped';
    box2.sandbox.__dispatch('popstate', {});
    expect(probe2.st.currentConvId).toBe('convPopped');
    expect(probe2.calls.stream).toBe(3);

    // ---- событие смены разговора и лог сброса (контракт с emit-гардом O-22) ----
    expect(box2.resets.length).toBeGreaterThan(0);
    expect(box2.resets[0].type).toBe('ai-cm-conversation-changed');
    expect(box2.logs.some(function (l) {
      return l.indexOf('смена чата → состояние перехватчика сброшено (convId=convPopped)') !== -1;
    })).toBe(true);
  });

  test('S5: проводка — js[] после parse и перед ядром, id -v7 + unregister -v6, helper', function () {
    // модуль строго перед ядром и строго после parse
    expect(DS.SOURCES.indexOf('core/deepseek-conv.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
    expect(DS.SOURCES.indexOf('core/deepseek-parse.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-conv.js'));
    expect(DS.MODULES).toContain('core/deepseek-conv.js');
    // регистрация ядра: id -v7, снятие -v6, js[] с модулем, лог (v7)
    expect(KERNEL_SRC).toContain('aiCmDeepseekConv');
    const bg = DS.readSource('core/background.js');
    expect(bg).toContain("js: ['utils/debug.js', 'core/deepseek-diag.js', 'core/deepseek-netsync.js', 'core/deepseek-refetch.js', 'core/deepseek-parse.js', 'core/deepseek-conv.js', 'core/deepseek-intercept.js']");
    expect(bg).toContain("ids.indexOf('ai-cm-deepseek-intercept-v7') === -1");
    expect(bg).toContain("unregisterContentScripts({ ids: ['ai-cm-deepseek-intercept-v6'] })");
    expect(bg).toContain('(v7) зарегистрирован');
    // модуль: UTF-8 без BOM, LF, хвостовой \n; каркас
    const buf = require('fs').readFileSync(require('path').join(DS.ROOT, 'core/deepseek-conv.js'));
    expect(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF).toBe(false);
    expect(MODULE_SRC.indexOf('\r')).toBe(-1);
    expect(MODULE_SRC.endsWith('\n')).toBe(true);
    ['window.AiCmDeepseekConv = Fn;', 'Fn.__bind = __bind;', 'module.exports = Fn;'].forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
    });
  });
});
