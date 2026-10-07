/**
 * Step D.8 (декомпозиция core/deepseek-intercept.js): контракт модуля INGEST.
 *
 * Кластер K5 (СЕКЦИЯ 8 ядра — ingestHistory: приёмка авторитетного сетевого снимка
 * history_messages, сборка turnsMap ПОХОДОВО, детектор усечения цепочки с однократным
 * тихим дозапросом, авторитетно пустая база v11/O-17, MERGE-ветка пустого кеша и режим
 * экспортного дозапроса v12/O-18) уехал в core/deepseek-ingest.js. Модуль и ядро —
 * РАЗНЫЕ IIFE одного registerContentScripts-пакета (js[]: utils/debug.js ->
 * deepseek-diag.js -> deepseek-netsync.js -> deepseek-refetch.js -> deepseek-parse.js ->
 * deepseek-conv.js -> deepseek-emit.js -> deepseek-net.js -> deepseek-ingest.js ->
 * deepseek-intercept.js), поэтому связь идёт ровно через один контракт:
 *
 *   ядро -> модуль: window.AiCmDeepseekIngest.__bind(deps)
 *     fn (15): diagOn/diagMark/diagHistRecord/diagSnapshotNetTurns/isDebugEnabled/
 *              determineState/dumpHistorySnapshot/dumpTurnUsageAtHistoryLoad — форвардеры
 *              D.1 (core/deepseek-diag.js); refetchFullHistory — форвардер D.3
 *              (core/deepseek-refetch.js); buildActiveChain/collectTurnText/
 *              collectTurnReasoning/composeTurnText/getModelSlug — форвардеры D.4
 *              (core/deepseek-parse.js); emitBaseSnapshot — форвардер D.6
 *              (core/deepseek-emit.js). Все — function declaration ядра, хойстятся.
 *     rw (10): состояние кластера, которое тело ПЕРЕЗАПИСЫВАЕТ — turnsMap (turnsMap = {}),
 *              orderCounter (orderCounter = 0 и orderCounter++), histCompletion (поля
 *              объекта), netSnapshotAt (Date.now()), netTurnIds ({}), loggedHistory (true),
 *              lastLoadedConvId (currentConvId), historyRefetchDone (true) — плюс режим
 *              экспортного ingest ingestMode (читается) и exportSyncTruncated
 *              (поднимается телом K5, снимается телом D.2). Без сеттера запись
 *              в sloppy-режиме молча терялась бы: база не пересобиралась бы, вердикт
 *              полноты не поднимался бы, а экспорт принял бы усечённый снимок за
 *              авторитетный.
 *     ro (8): currentConvId/lastHistoryUrl/lastAuthHeaders (ядро владеет ими вместе с
 *             D.2/D.3/D.7), sseConfigName (K6 ещё НЕ вынесен — переменная остаётся в ядре
 *             до D.9), REASONING_ENABLED/MODEL_WINDOW_DEFAULT (гейт v8/O-7 и окно модели),
 *             lastBaseServerTokens/lastBaseChatMode (ре-эмит полноты 0→1).
 *   модуль -> ядро: ТОЛЬКО ingestHistory (форвардер ядра — function declaration, хойстится:
 *   fn-передачи `ingestHistory: ingestHistory` в контрактах D.2 и D.7 не тронуты).
 *
 * Здесь пинятся:
 *   S1. Полнота контракта: литерал __bind в ядре содержит ровно 33 имени
 *       (15 fn + 10 rw + 8 ro), ни одного потерянного/лишнего; каждая fn-передача —
 *       хойстящийся форвардер ядра, каждое rw/ro-имя объявлено var в ядре и НЕ объявлено
 *       повторно в модуле (иначе появилась бы ВТОРАЯ переменная).
 *   S2. Живая связка в vm: до __bind наружу торчит ТОЛЬКО __bind и тела нет; полная связка
 *       отдаёт одно тело; записи тела доезжают до ЖИВЫХ rw-аксессоров ядра (не в копию),
 *       ro-геттеры читаются, повторная загрузка модуля не перетирает связанный API.
 *   S3. Байтовая идентичность тел: 2 блока K5 (заголовок СЕКЦИИ 8 и тело ingestHistory,
 *       строки 340-614 HEAD 2623b3a) лежат в модуле ДОСЛОВНО (SHA-256 каждого блока
 *       зафиксирован здесь — git-история сьютом не читается, CI shallow); заголовок — в
 *       PURE-зоне, тело — в BIND-зоне внутри `with (D)`; объявления состояния остались
 *       в ядре; префиксов D. нет; надгробие и связка на месте.
 *   S4. Живая семантика K5: полная цепочка (turnsMap по ходам, порядок, per-turn slug,
 *       дедуп, склейка reasoning, снимок сети, полнота, однократный лог/дамп), MERGE-ветка
 *       → дозапрос, усечение → дозапрос, усечение в режиме export-sync → отказ, пустая
 *       авторитетная база → вердикт полноты и ре-эмит, отказы на невалидном ответе.
 *   S5. Проводка: js[] строго после deepseek-net.js и перед ядром, id -v10 + unregister -v9,
 *       helper MODULES, счётчик release.yml, размеры ядра/модуля, K0 не тронут.
 */

const vm = require('vm');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-ingest.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 15 fn + 10 rw + 8 ro = 33 имени --------------------------
const FN_NAMES = ['diagOn', 'diagMark', 'diagHistRecord', 'diagSnapshotNetTurns',
  'isDebugEnabled', 'determineState', 'dumpHistorySnapshot', 'dumpTurnUsageAtHistoryLoad',
  'refetchFullHistory', 'buildActiveChain', 'collectTurnText', 'collectTurnReasoning',
  'composeTurnText', 'getModelSlug', 'emitBaseSnapshot'];
const RW_NAMES = ['turnsMap', 'orderCounter', 'histCompletion', 'netSnapshotAt', 'netTurnIds',
  'loggedHistory', 'lastLoadedConvId', 'historyRefetchDone', 'ingestMode', 'exportSyncTruncated'];
const RO_NAMES = ['currentConvId', 'lastHistoryUrl', 'lastAuthHeaders', 'sseConfigName',
  'REASONING_ENABLED', 'MODEL_WINDOW_DEFAULT', 'lastBaseServerTokens', 'lastBaseChatMode'];

// Кто из модулей реализует каждую fn-передачу (форвардеры ядра хойстятся).
const FN_IMPL = {
  diagOn: 'aiCmDeepseekDiag', diagMark: 'aiCmDeepseekDiag', diagHistRecord: 'aiCmDeepseekDiag',
  diagSnapshotNetTurns: 'aiCmDeepseekDiag', isDebugEnabled: 'aiCmDeepseekDiag',
  determineState: 'aiCmDeepseekDiag', dumpHistorySnapshot: 'aiCmDeepseekDiag',
  dumpTurnUsageAtHistoryLoad: 'aiCmDeepseekDiag',
  refetchFullHistory: 'aiCmDeepseekRefetch',
  buildActiveChain: 'aiCmDeepseekParse', collectTurnText: 'aiCmDeepseekParse',
  collectTurnReasoning: 'aiCmDeepseekParse', composeTurnText: 'aiCmDeepseekParse',
  getModelSlug: 'aiCmDeepseekParse',
  emitBaseSnapshot: 'aiCmDeepseekEmit'
};

// ---- что модуль отдаёт наружу после __bind (S2) -------------------------------------
const EXPORTS = ['ingestHistory'];

// ---- блоки K5, перенесённые в модуль дословно (S3) ----------------------------------
// Эталон — SHA-256 блока в core/deepseek-intercept.js на 2623b3a (HEAD момента D.8),
// строки 340-614. Хэши сняты с блока и ЗАФИКСИРОВАНЫ здесь: сьют не читает git-историю
// (CI клонирует shallow), поэтому байтовая идентичность против базы доказывается двумя
// независимыми способами — этими пинами (текущий модуль) и tools/verify-deepseek-ingest.js
// (дословное сравнение с git show, локально). Пин = срез МОДУЛЯ от start-якоря до
// end-якоря; оба end-якоря захватывают пустую строку-разделитель каркаса — это часть
// регионального пина, а не тела: дословность самих строк (340-345 и 348-614) проверяет
// верификатор по строкам блоба.
const MOVED_BLOCKS = [
  {
    name: 'СЕКЦИЯ 8 (заголовок)', zone: 'pure',
    start: '  // ===== СЕКЦИЯ 8: ПАРСИНГ history_messages =====',
    end: '  function __bind(d) {',
    sha: '30979d2087ac127186133b1a2c4ba73a75064eabdb1f5051a623ddaa926dc9d7'
  },
  {
    name: 'ingestHistory (тело)', zone: 'bind',
    start: '  function ingestHistory(jsonBody) {',
    end: '      Fn.ingestHistory = ingestHistory;',
    sha: '6c4110824a0e522f76f163eb2c22964ec7b56caab27547e9bfdd7e298e6381f6'
  }
];

// ---- объявления состояния, которые ОСТАЛИСЬ в ядре (S3) ------------------------------
const KERNEL_KEPT = [
  '  var turnsMap = {};',
  '  var orderCounter = 0;',
  '  var histCompletion = { historyComplete: false, reachedRoot: false, baseEmpty: false };',
  '  var netSnapshotAt = 0;',
  '  var netTurnIds = {};',
  '  var loggedHistory = false;',
  "  var lastLoadedConvId = '';",
  '  var historyRefetchDone = false;',
  "  var ingestMode = '';",
  '  var exportSyncTruncated = false;',
  "  var lastHistoryUrl = '';",
  '  var lastAuthHeaders = {};',
  '  var sseConfigName = null;',
  '  var REASONING_ENABLED = true;',
  '  var MODEL_WINDOW_DEFAULT = 131072;',
  '  var lastBaseServerTokens = 0;',
  "  var lastBaseChatMode = '';",
  '  var currentConvId = '
];

// Уникальные строки тела K5: их НЕ должно остаться в ядре (тело уехало целиком).
const BODY_MARKERS = [
  '  // ===== СЕКЦИЯ 8: ПАРСИНГ history_messages =====',
  "      diagMark('ingest-enter', {",
  "      diagHistRecord(jsonBody, 'ingestHistory');",
  '      var baseEmptyAuthoritative = (chatMessages.length === 0) &&',
  "        diagMark('ingest-branch-MERGE-refetch', { chainLen: 0, chatMessages: 0 });   // O-18 (ИЗМЕРЕНИЕ)",
  '      turnsMap = {};',
  '            order: orderCounter++,',
  "      diagSnapshotNetTurns('ingestHistory');",
  '      netSnapshotAt = Date.now();',
  '      var em = emitBaseSnapshot(lastAccumulated, chatMode);',
  "            capturePoint: 'ingestHistory',",
  '          dumpTurnUsageAtHistoryLoad(chain, chatMessages, chatSession);',
  "            site: 'S560', ts: Date.now(),",
  "            site: 'S692', ts: Date.now(),",
  '      var chainResult = buildActiveChain(chatSession, messagesById);',
  '          histCompletion.historyComplete = true;'
];

// ---- вызовы, которые обязаны остаться в ядре (S2/S3) --------------------------------
const KERNEL_CALLS = [
  '      ingestHistory: ingestHistory,',
  "      diagSnapshotNetTurns: diagSnapshotNetTurns,",
  '      get sseConfigName() { return sseConfigName; }',
  '      get ingestMode() { return ingestMode; },',
  '      get exportSyncTruncated() { return exportSyncTruncated; },'
];

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/** Блок K5 из исходника: срез от start-якоря до следующего end-якоря. */
function blockOf(src, b) {
  const s = src.indexOf(b.start);
  expect(s).toBeGreaterThan(-1);
  const e = src.indexOf(b.end, s + b.start.length);
  expect(e).toBeGreaterThan(s);
  return src.slice(s, e);
}

// ---- разбор литерала __bind ядра (единственный источник правды для стенда) ----------
function kernelBindKinds() {
  const start = KERNEL_SRC.lastIndexOf('aiCmDeepseekIngest.__bind({');
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

// ---- стенд vm: песочница без DOM (K5 его не трогает) --------------------------------
function makeSandbox() {
  const logs = [];
  const sandbox = {
    console: {
      log: function () { logs.push([].join.call(arguments, ' ')); },
      warn: function () { logs.push('WARN ' + [].join.call(arguments, ' ')); },
      error: function () { logs.push('ERR ' + [].join.call(arguments, ' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Date: Date,
    setTimeout: function () { return 0; }, clearTimeout: function () { }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-ingest.js' });
}

/** Фейковый ядр: живые rw/ro-аксессоры + счётчики fn-вызовов (S2/S4). */
function makeProbe() {
  const st = {
    turnsMap: {},
    orderCounter: 0,
    histCompletion: { historyComplete: false, reachedRoot: false, baseEmpty: false },
    netSnapshotAt: 0,
    netTurnIds: {},
    loggedHistory: false,
    lastLoadedConvId: '',
    historyRefetchDone: false,
    ingestMode: '',
    exportSyncTruncated: false,
    currentConvId: 'convD8',
    lastHistoryUrl: 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=convD8',
    lastAuthHeaders: { Authorization: 'Bearer d8' },
    sseConfigName: 'Instant',
    REASONING_ENABLED: true,
    MODEL_WINDOW_DEFAULT: 131072,
    lastBaseServerTokens: 777,
    lastBaseChatMode: 'default',
    __debug: false
  };
  const writes = {};
  const reads = {};
  const calls = {
    diagOn: 0, diagMark: 0, diagHistRecord: 0, diagSnapshotNetTurns: 0, isDebugEnabled: 0,
    determineState: 0, dumpHistorySnapshot: 0, dumpTurnUsageAtHistoryLoad: 0,
    refetchFullHistory: 0, buildActiveChain: 0, collectTurnText: 0, collectTurnReasoning: 0,
    composeTurnText: 0, getModelSlug: 0, emitBaseSnapshot: 0,
    marks: [], refetchArgs: [], histRecords: [], snapshots: [], emits: [], dumps: [], usage: []
  };
  const D = {};
  const fns = {
    diagOn: function () { calls.diagOn++; return true; },
    diagMark: function (kind, data) { calls.diagMark++; calls.marks.push([kind, data]); },
    diagHistRecord: function (json, src) { calls.diagHistRecord++; calls.histRecords.push(src); },
    diagSnapshotNetTurns: function (reason) { calls.diagSnapshotNetTurns++; calls.snapshots.push(reason); },
    isDebugEnabled: function () { calls.isDebugEnabled++; return st.__debug === true; },
    determineState: function () { calls.determineState++; return { state: 'ST', reason: 'RS', navType: 'NV' }; },
    dumpHistorySnapshot: function (state, reason, ctx) { calls.dumpHistorySnapshot++; calls.dumps.push([state, reason, ctx]); },
    dumpTurnUsageAtHistoryLoad: function (chain, chatMessages, chatSession) {
      calls.dumpTurnUsageAtHistoryLoad++; calls.usage.push([chain.length, chatMessages.length, !!chatSession]);
    },
    refetchFullHistory: function (url, authHeaders, convId) {
      calls.refetchFullHistory++; calls.refetchArgs.push([url, authHeaders, convId]);
    },
    // Реалистичная копия D.4: walk по parent_id от current_message_id, truncated —
    // если родитель отсутствует в кеше, reachedRoot — если дошли до parent_id == null.
    buildActiveChain: function (chatSession, messagesById) {
      calls.buildActiveChain++;
      const chain = [];
      let truncated = false, reachedRoot = false, id = chatSession.current_message_id, guard = 0;
      while (id != null && guard++ < 1000) {
        const m = messagesById[id];
        if (!m) { truncated = true; break; }
        chain.unshift(m);
        if (m.parent_id == null) { reachedRoot = true; break; }
        id = m.parent_id;
      }
      return { chain: chain, truncated: truncated, reachedRoot: reachedRoot };
    },
    collectTurnText: function (fragments, role) {
      calls.collectTurnText++;
      const want = (role === 'USER') ? 'REQUEST' : 'RESPONSE';
      return fragments.filter(function (f) { return f.type === want; })
        .map(function (f) { return f.content; }).join('');
    },
    collectTurnReasoning: function (fragments) {
      calls.collectTurnReasoning++;
      return fragments.filter(function (f) { return f.type === 'THINK'; })
        .map(function (f) { return f.content; }).join('');
    },
    composeTurnText: function (answer, reasoning) {
      calls.composeTurnText++;
      return reasoning ? '[REASONING]' + reasoning + '\n[ANSWER]' + (answer || '') : String(answer || '');
    },
    getModelSlug: function (thinkingEnabled) {
      calls.getModelSlug++;
      return thinkingEnabled ? 'deepseek-reasoner' : 'deepseek-v3';
    },
    emitBaseSnapshot: function (serverTokens, chatMode) {
      calls.emitBaseSnapshot++; calls.emits.push([serverTokens, chatMode]);
      return {
        count: Object.keys(st.turnsMap).length, textLen: 42, lastModel: 'deepseek-v3',
        reasoningTurns: 1
      };
    }
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
    Object.defineProperty(D, n, {
      get: function () { reads[n] = (reads[n] || 0) + 1; return st[n]; },
      enumerable: true
    });
  });
  return { D: D, st: st, writes: writes, reads: reads, calls: calls, fns: fns };
}

/** Сброс состояния и счётчиков пробника между сценариями (аксессоры не меняются). */
function resetProbe(probe) {
  const st = probe.st;
  st.turnsMap = {};
  st.orderCounter = 0;
  st.histCompletion = { historyComplete: false, reachedRoot: false, baseEmpty: false };
  st.netSnapshotAt = 0;
  st.netTurnIds = {};
  st.loggedHistory = false;
  st.lastLoadedConvId = '';
  st.historyRefetchDone = false;
  st.ingestMode = '';
  st.exportSyncTruncated = false;
  st.__debug = false;
  Object.keys(probe.writes).forEach(function (k) { delete probe.writes[k]; });
  Object.keys(probe.reads).forEach(function (k) { delete probe.reads[k]; });
  const c = probe.calls;
  Object.keys(c).forEach(function (k) { if (Array.isArray(c[k])) c[k].length = 0; else c[k] = 0; });
}

// ---- фикстуры истории ----------------------------------------------------------------
function msg(id, parent, role, text, opts) {
  const o = opts || {};
  const fragments = [];
  if (o.reasoning) fragments.push({ type: 'THINK', content: o.reasoning });
  if (text) fragments.push({ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content: text });
  return {
    message_id: id, parent_id: parent, role: role, thinking_enabled: !!o.thinking,
    inserted_at: o.ts || 0, accumulated_token_usage: o.acc || 0, fragments: fragments
  };
}

function historyBody(messages, session) {
  return {
    code: 0,
    data: { biz_data: { chat_session: session, chat_messages: messages } }
  };
}

/** Полная цепочка u1-a1-u2-a2 (a2 — thinking), корень достигнут. */
function fullChain() {
  return [
    msg('u1', null, 'USER', 'Вопрос 1', { ts: 1, acc: 100 }),
    msg('a1', 'u1', 'ASSISTANT', 'Ответ 1', { ts: 2, acc: 500 }),
    msg('u2', 'a1', 'USER', 'Вопрос 2', { ts: 3, acc: 900 }),
    msg('a2', 'u2', 'ASSISTANT', 'Ответ 2', { ts: 4, acc: 2000, thinking: true })
  ];
}

function fullSession() {
  return { current_message_id: 'a2', model_type: 'default', is_empty: false, conversation_mode: 'DEFAULT' };
}

function fullBody() { return historyBody(fullChain(), fullSession()); }

/** Усечённая цепочка: корень u1 в кеш не попал (parent_id ссылается в пустоту). */
function truncatedBody() {
  const msgs = [
    msg('a1', 'u1', 'ASSISTANT', 'Ответ 1', { acc: 500 }),
    msg('u2', 'a1', 'USER', 'Вопрос 2', { acc: 900 }),
    msg('a2', 'u2', 'ASSISTANT', 'Ответ 2', { acc: 2000 })
  ];
  return historyBody(msgs, { current_message_id: 'a2', model_type: 'default', is_empty: false });
}

describe('Step D.8: core/deepseek-ingest.js — контракт модуля INGEST', () => {
  test('S1: литерал __bind в ядре содержит ровно 33 имени (15 fn + 10 rw + 8 ro)', function () {
    expect(KINDS.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) { expect(KINDS.get(pair[0])).toBe(pair[1]); });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 15, ro: 8, rw: 10 });
    // каждая fn-передача — реально существующий форвардер ядра (хойстится к моменту связки)
    FN_NAMES.forEach(function (n) {
      expect(KERNEL_SRC).toContain('function ' + n + '(');
      expect(KERNEL_SRC).toContain(FN_IMPL[n] + '.' + n + '(');
    });
    // rw/ro-состояние реально объявлено в ядре (иначе сеттер писал бы в никуда,
    // а геттер читал бы НЕЯВНЫЙ ГЛОБАЛ — урок D.5 на lastDispatchSig/currentConvId)
    RW_NAMES.concat(RO_NAMES).forEach(function (n) {
      expect(KERNEL_SRC).toMatch(new RegExp('^ {2}var\\s+' + n + '\\s*=', 'm'));
    });
    // модуль не объявляет их заново: иначе появилась бы ВТОРАЯ переменная, и ядро
    // читало бы старую (база, полнота, снимок сети и режим экспорта терялись бы молча)
    RW_NAMES.concat(RO_NAMES).forEach(function (n) {
      expect(MODULE_SRC).not.toMatch(new RegExp('\\bvar\\s+' + n + '\\b'));
    });
    // тело ro-геттера — ровно чтение имени ядра; rw-пара — get + set
    const literal = KERNEL_SRC.slice(KERNEL_SRC.lastIndexOf('aiCmDeepseekIngest.__bind({'),
      KERNEL_SRC.indexOf('});', KERNEL_SRC.lastIndexOf('aiCmDeepseekIngest.__bind({')));
    RO_NAMES.forEach(function (n) {
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
    });
    RW_NAMES.forEach(function (n) {
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
      expect(literal).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });
    // единственный форвардер D.8 — ingestHistory: остальные 14 имён ядро у модуля
    // не запрашивает (их читает только тело K5)
    expect(KERNEL_SRC).toContain('function ingestHistory(jsonBody) { if (aiCmDeepseekIngest) return aiCmDeepseekIngest.ingestHistory(jsonBody); }');
    FN_NAMES.forEach(function (n) {
      expect(KERNEL_SRC).not.toContain('aiCmDeepseekIngest.' + n + '(');
    });
    expect(MODULE_SRC).toContain('      Fn.ingestHistory = ingestHistory;');
    // K0 остался в ядре и по-прежнему экспортируется наружу (контрактный тест v13)
    expect(KERNEL_SRC).toContain('resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug');
    expect(KERNEL_SRC).toContain('function __aiCmDeepseekResolveModelSlug(signals) {');
  });

  test('S2: живая связка в vm — тело работает через живые rw/ro ядра, перезагрузка не перетирает API', function () {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekIngest;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);
    expect(Fn.ingestHistory).toBeUndefined();          // до связки тела нет вовсе

    const probe = makeProbe();
    Fn.__bind(probe.D);
    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());
    expect(typeof Fn.ingestHistory).toBe('function');

    // полная цепочка проходит тело целиком
    Fn.ingestHistory(fullBody());
    expect(probe.calls.buildActiveChain).toBe(1);
    expect(probe.calls.diagHistRecord).toBe(1);
    expect(probe.calls.collectTurnText).toBeGreaterThan(0);
    expect(probe.calls.diagSnapshotNetTurns).toBe(1);
    expect(probe.calls.emitBaseSnapshot).toBe(1);
    expect(probe.calls.marks.map(function (m) { return m[0]; }))
      .toEqual(expect.arrayContaining(['ingest-enter', 'ingest-branch-ACCEPT']));

    // rw: записи доехали до ЖИВОГО состояния ядра (не в копию модуля)
    expect(probe.writes.turnsMap).toBe(1);
    expect(Object.keys(probe.st.turnsMap)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(probe.st.orderCounter).toBe(4);
    expect(probe.writes.orderCounter).toBeGreaterThanOrEqual(5);   // сброс + 4 × ++
    expect(probe.writes.netSnapshotAt).toBe(1);
    expect(probe.st.netSnapshotAt).toBeGreaterThan(0);
    expect(probe.writes.netTurnIds).toBe(1);
    expect(probe.st.netTurnIds).toEqual({ u1: 1, a1: 1, u2: 1, a2: 1 });
    expect(probe.writes.loggedHistory).toBe(1);
    expect(probe.st.loggedHistory).toBe(true);
    expect(probe.writes.lastLoadedConvId).toBe(1);
    expect(probe.st.lastLoadedConvId).toBe('convD8');
    expect(probe.st.histCompletion).toEqual({ historyComplete: true, reachedRoot: true, baseEmpty: false });

    // ro: читаются живые имена ядра — окно модели, гейт reasoning, convId и settings
    ['currentConvId', 'sseConfigName', 'REASONING_ENABLED', 'MODEL_WINDOW_DEFAULT']
      .forEach(function (n) { expect(probe.reads[n]).toBeGreaterThan(0); });

    // повторная загрузка модуля не перетирает уже связанный API
    loadModule(box);
    expect(box.sandbox.AiCmDeepseekIngest).toBe(Fn);
    expect(typeof Fn.ingestHistory).toBe('function');
    // повторная связка (новый D) тоже не ломает тело
    const probe2 = makeProbe();
    Fn.__bind(probe2.D);
    Fn.ingestHistory(fullBody());
    expect(probe2.calls.emitBaseSnapshot).toBe(1);
    expect(Object.keys(probe2.st.turnsMap)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  test('S3: тело K5 перенесено дословно (SHA-256 блоков); в ядре — надгробие, var\'ы и связка', function () {
    // Байтовая идентичность: SHA-256 каждого блока в модуле равен эталону с 2623b3a.
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      expect(sha256(body)).toBe(b.sha);
    });
    // зоны: заголовок СЕКЦИИ 8 — ВНЕ with (D), тело — ВНУТРИ (иначе свободные имена
    // ядра не резолвятся: лексический скоуп объявления, урок D.5/D.1)
    const bindAt = MODULE_SRC.indexOf('  function __bind(d) {');
    const withAt = MODULE_SRC.indexOf('    with (D) {');
    const fnFillAt = MODULE_SRC.indexOf('  Fn.__bind = __bind;');
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
    // маркеры тел: живут в модуле, в ядре их нет (тело уехало целиком)
    BODY_MARKERS.forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
      expect(KERNEL_SRC).not.toContain(l);
    });
    // надгробие на месте, заголовка СЕКЦИИ 8 в ядре больше нет
    expect(KERNEL_SRC).toContain('// ===== Step D.8: K5 (INGEST) вынесен в core/deepseek-ingest.js =====');
    expect(KERNEL_SRC).not.toContain('// ===== СЕКЦИЯ 8: ПАРСИНГ history_messages =====');
    // K5 вырезан из ядра непрерывно: соседи (K2-надгробие D.6 и СЕКЦИЯ 9) не тронуты
    expect(KERNEL_SRC).toContain('// ===== Step D.6: K2 (EMIT) вынесен в core/deepseek-emit.js =====');
    // Step D.9: заголовок СЕКЦИИ 9 уехал в core/deepseek-sse.js вместе с телами K6
    // (байт-в-байт), в ядре осталось надгробие — пин перецеплен на конкатенацию.
    expect(KERNEL_SRC).not.toContain('// ===== СЕКЦИЯ 9: ПАРСЕР SSE');
    expect(DS.moduleSource('deepseek-sse.js')).toContain('// ===== СЕКЦИЯ 9: ПАРСЕР SSE');
    // объявления состояния ОСТАЛИСЬ в ядре (иначе ядро читало бы НЕЯВНЫЕ ГЛОБАЛЫ)
    KERNEL_KEPT.forEach(function (line) {
      expect(KERNEL_SRC).toContain(line);
      expect(MODULE_SRC).not.toContain(line);
    });
    // связка D.8 — последняя в IIFE и читает window.AiCmDeepseekIngest до __bind
    const iifeEnd = KERNEL_SRC.lastIndexOf('\n})();');
    const ingestBindAt = KERNEL_SRC.lastIndexOf('aiCmDeepseekIngest.__bind({');
    const netBindAt = KERNEL_SRC.lastIndexOf('aiCmDeepseekNet.__bind({');
    expect(ingestBindAt).toBeGreaterThan(0);
    expect(ingestBindAt).toBeLessThan(iifeEnd);
    expect(netBindAt).toBeLessThan(ingestBindAt);
    expect(KERNEL_SRC).toContain("var aiCmDeepseekIngest = (typeof window !== 'undefined' && window.AiCmDeepseekIngest) || null;");
    KERNEL_CALLS.forEach(function (l) { expect(KERNEL_SRC).toContain(l); });
    // префиксов D. в теле модуля нет (with (D), ES3 Annex B)
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // размеры: K5 уехал целиком (ядро ушло ниже 1700 строк, модуль — за 350)
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(1700);
    expect(MODULE_SRC.split('\n').length).toBeGreaterThan(350);
  });

  test('S4: живая семантика ingestHistory — приёмка, MERGE, усечение, export-sync, пустая база', function () {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekIngest;
    const probe = makeProbe();
    Fn.__bind(probe.D);

    // ---- 1. полная цепочка: turnsMap ПОХОДОВО, порядок, per-turn slug, снимок сети ----
    Fn.ingestHistory(fullBody());
    const t = probe.st.turnsMap;
    expect(Object.keys(t)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(t.u1.text).toBe('Вопрос 1');
    expect(t.u1.role).toBe('user');
    expect(t.u1.order).toBe(0);
    expect(t.a1.text).toBe('Ответ 1');
    expect(t.a1.modelSlug).toBe('deepseek-v3');            // thinking_enabled=false
    expect(t.a2.modelSlug).toBe('deepseek-reasoner');      // thinking_enabled=true
    expect([t.u1.order, t.a1.order, t.u2.order, t.a2.order]).toEqual([0, 1, 2, 3]);
    expect(probe.st.histCompletion).toEqual({ historyComplete: true, reachedRoot: true, baseEmpty: false });
    // аккумулятор берётся максимумом по цепочке, а не последним ходом
    expect(probe.calls.emits).toEqual([[2000, 'default']]);
    // однократный лог: второй принятый снимок уже не логируется
    Fn.ingestHistory(fullBody());
    expect(probe.calls.emits).toHaveLength(2);
    expect(box.logs.filter(function (l) { return l.indexOf('история загружена') !== -1; })).toHaveLength(1);
    expect(probe.writes.loggedHistory).toBe(1);
    // диагностический дамп — только под флагом aiCmDebug
    expect(probe.calls.dumpHistorySnapshot).toBe(0);
    expect(probe.calls.dumpTurnUsageAtHistoryLoad).toBe(0);
    resetProbe(probe);
    probe.st.__debug = true;
    Fn.ingestHistory(fullBody());
    expect(probe.calls.dumpHistorySnapshot).toBe(1);
    expect(probe.calls.dumps[0][0]).toBe('ST');
    expect(probe.calls.dumps[0][1]).toBe('RS');
    expect(probe.calls.dumps[0][2].capturePoint).toBe('ingestHistory');
    expect(probe.calls.dumps[0][2].lastAccumulated).toBe(2000);
    expect(probe.calls.dumps[0][2].chatMode).toBe('default');
    expect(probe.calls.dumpTurnUsageAtHistoryLoad).toBe(1);
    expect(probe.calls.usage[0]).toEqual([4, 4, true]);

    // ---- 2. дедуп: один и тот же message_id в цепочке обрабатывается ОДИН раз ---------
    resetProbe(probe);
    const realChain = probe.fns.buildActiveChain;
    probe.fns.buildActiveChain = function () {
      const c = fullChain();
      return { chain: [c[0], c[1], c[1], c[2], c[3]], truncated: false, reachedRoot: true };
    };
    Fn.ingestHistory(fullBody());
    probe.fns.buildActiveChain = realChain;
    expect(Object.keys(probe.st.turnsMap)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(probe.st.orderCounter).toBe(4);                 // дубль не съел номер хода
    expect([probe.st.turnsMap.u1.order, probe.st.turnsMap.a1.order,
      probe.st.turnsMap.u2.order, probe.st.turnsMap.a2.order]).toEqual([0, 1, 2, 3]);

    // ---- 3. reasoning без ответа: приклеивается к следующему assistant-ходу ----------
    resetProbe(probe);
    Fn.ingestHistory(historyBody([
      msg('u1', null, 'USER', 'Вопрос', { acc: 100 }),
      msg('t1', 'u1', 'ASSISTANT', '', { reasoning: 'размышление', acc: 300 }),
      msg('a1', 't1', 'ASSISTANT', 'Ответ', { acc: 500 })
    ], { current_message_id: 'a1', model_type: 'default', is_empty: false }));
    expect(Object.keys(probe.st.turnsMap)).toEqual(['u1', 'a1']);   // хода t1 нет
    expect(probe.st.turnsMap.a1.reasoning).toBe('размышление');
    expect(probe.st.turnsMap.a1.text).toBe('[REASONING]размышление\n[ANSWER]Ответ');

    // ---- 4. «висячий» reasoning в конце цепочки — в последний assistant-ход -----------
    resetProbe(probe);
    Fn.ingestHistory(historyBody([
      msg('u1', null, 'USER', 'Вопрос', { acc: 100 }),
      msg('a1', 'u1', 'ASSISTANT', 'Ответ', { acc: 500 }),
      msg('t2', 'a1', 'ASSISTANT', '', { reasoning: 'хвост', acc: 700 })
    ], { current_message_id: 't2', model_type: 'default', is_empty: false }));
    expect(Object.keys(probe.st.turnsMap)).toEqual(['u1', 'a1']);
    expect(probe.st.turnsMap.a1.reasoning).toBe('хвост');
    expect(probe.st.turnsMap.a1.text).toBe('[REASONING]хвост\n[ANSWER]Ответ');

    // ---- 5. MERGE-ответ (пустой кеш без авторитетной пустоты) → тихий дозапрос --------
    resetProbe(probe);
    Fn.ingestHistory(historyBody([], { current_message_id: 'm1', model_type: 'default' }));
    expect(probe.calls.refetchFullHistory).toBe(1);
    expect(probe.calls.refetchArgs[0]).toEqual([
      probe.st.lastHistoryUrl, probe.st.lastAuthHeaders, 'convD8']);
    expect(probe.writes.historyRefetchDone).toBe(1);
    expect(probe.st.historyRefetchDone).toBe(true);
    expect(probe.writes.turnsMap).toBeUndefined();          // база не тронута
    expect(probe.calls.emitBaseSnapshot).toBe(0);
    // ro-имена дозапроса читаются ЖИВЫЕ (URL/заголовки/convId — аргументы вызова)
    expect(probe.reads.lastHistoryUrl).toBeGreaterThan(0);
    expect(probe.reads.lastAuthHeaders).toBeGreaterThan(0);
    expect(probe.reads.currentConvId).toBeGreaterThan(0);
    expect(probe.calls.marks.map(function (m) { return m[0]; })).toContain('ingest-branch-MERGE-refetch');

    // ---- 6. усечённая цепочка → однократный дозапрос, база не тронута ------------------
    resetProbe(probe);
    Fn.ingestHistory(truncatedBody());
    expect(probe.calls.refetchFullHistory).toBe(1);
    expect(probe.st.historyRefetchDone).toBe(true);
    expect(probe.st.turnsMap).toEqual({});
    expect(probe.calls.emitBaseSnapshot).toBe(0);
    expect(probe.calls.marks.map(function (m) { return m[0]; })).toContain('ingest-branch-TRUNCATED-refetch');
    // повторный усечённый ответ дозапроса не запускает (флаг уже поднят) — снимок принят
    resetProbe(probe);
    probe.st.historyRefetchDone = true;
    Fn.ingestHistory(truncatedBody());
    expect(probe.calls.refetchFullHistory).toBe(0);
    expect(probe.st.histCompletion).toEqual({ historyComplete: false, reachedRoot: false, baseEmpty: false });
    expect(Object.keys(probe.st.turnsMap)).toEqual(['a1', 'u2', 'a2']);

    // ---- 7. режим export-sync: усечённый снимок НЕ принимается ------------------------
    resetProbe(probe);
    probe.st.historyRefetchDone = true;
    probe.st.ingestMode = 'export-sync';
    Fn.ingestHistory(truncatedBody());
    expect(probe.writes.exportSyncTruncated).toBe(1);
    expect(probe.st.exportSyncTruncated).toBe(true);
    expect(probe.calls.refetchFullHistory).toBe(0);
    expect(probe.st.turnsMap).toEqual({});                  // прежний live-путь
    expect(probe.calls.emitBaseSnapshot).toBe(0);
    expect(probe.calls.marks.map(function (m) { return m[0]; })).toContain('ingest-branch-TRUNCATED-export-sync');

    // ---- 8. авторитетно пустая база: полнота = true, живая база НЕ стирается ----------
    resetProbe(probe);
    probe.st.turnsMap = { x1: { text: 'live', order: 0, role: 'user' } };
    Fn.ingestHistory(historyBody([], { current_message_id: null, is_empty: true }));
    expect(probe.st.histCompletion).toEqual({ historyComplete: true, reachedRoot: false, baseEmpty: true });
    expect(probe.st.turnsMap).toEqual({ x1: { text: 'live', order: 0, role: 'user' } });
    // ре-эмит полноты 0→1 поверх уже собранных live-ходов — с ПАРАМЕТРАМИ прошлого эмита
    expect(probe.calls.emits).toEqual([[777, 'default']]);
    expect(probe.calls.marks.map(function (m) { return m[0]; })).toContain('o22-dispatch-site');
    const s560 = probe.calls.marks.filter(function (m) { return m[0] === 'o22-dispatch-site'; })[0][1];
    expect(s560.site).toBe('S560');
    expect(s560.count).toBe(1);
    expect(probe.writes.turnsMap).toBeUndefined();
    // пустая база без live-ходов — эмита нет (нечего публиковать), вердикт тот же
    resetProbe(probe);
    Fn.ingestHistory(historyBody([], { current_message_id: null, is_empty: true }));
    expect(probe.calls.emitBaseSnapshot).toBe(0);
    expect(probe.st.histCompletion.historyComplete).toBe(true);
    // маркер S692 — точка диспатча принятого снимка
    resetProbe(probe);
    Fn.ingestHistory(fullBody());
    const s692 = probe.calls.marks.filter(function (m) { return m[0] === 'o22-dispatch-site'; })[0][1];
    expect(s692.site).toBe('S692');
    expect(s692.count).toBe(4);

    // ---- 9. невалидный ответ: ни одного касания состояния ----------------------------
    resetProbe(probe);
    [{ code: 1 }, { code: 0 }, { code: 0, data: {} },
      { code: 0, data: { biz_data: { chat_session: {}, chat_messages: 'x' } } }]
      .forEach(function (bad) { Fn.ingestHistory(bad); });
    expect(probe.calls.diagMark).toBe(0);
    expect(Object.keys(probe.writes)).toEqual([]);
    expect(probe.calls.buildActiveChain).toBe(0);
    expect(probe.calls.emitBaseSnapshot).toBe(0);
  });

  test('S5: проводка — js[] после net и перед ядром, id -v11 + unregister -v10, helper', function () {
    // модуль строго перед ядром и строго после net
    expect(DS.SOURCES.indexOf('core/deepseek-ingest.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
    expect(DS.SOURCES.indexOf('core/deepseek-net.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-ingest.js'));
    expect(DS.MODULES).toContain('core/deepseek-ingest.js');
    // регистрация ядра: id -v11, снятие -v10, js[] с модулем, лог (v11)
    expect(KERNEL_SRC).toContain('aiCmDeepseekIngest');
    const bg = DS.readSource('core/background.js');
    expect(bg).toContain("js: ['utils/debug.js', 'core/deepseek-diag.js', 'core/deepseek-netsync.js', 'core/deepseek-refetch.js', 'core/deepseek-parse.js', 'core/deepseek-conv.js', 'core/deepseek-emit.js', 'core/deepseek-net.js', 'core/deepseek-ingest.js', 'core/deepseek-sse.js', 'core/deepseek-intercept.js']");
    expect(bg).toContain("ids.indexOf('ai-cm-deepseek-intercept-v11') === -1");
    expect(bg).toContain("unregisterContentScripts({ ids: ['ai-cm-deepseek-intercept-v10'] })");
    // лог регистрации бампнут, но БЕЗ «(vN)»-формы: её глобально запрещают Gemini-пины
    // (сдвиг их id -v10 → -v11), а не DeepSeek — версия в логе сохранена
    expect(bg).toContain('перехватчик DeepSeek v11 зарегистрирован');
    expect(bg).not.toContain('(v10) зарегистрирован');
    // release.yml: счётчик MAIN-world файлов равен факту (35 = 5 бандлов + 30 модулей/ядер)
    const yml = DS.readSource('.github/workflows/release.yml');
    expect((yml.match(/35 MAIN-world/g) || [])).toHaveLength(2);
    expect(yml).not.toContain('34 MAIN-world');
    // модуль: UTF-8 без BOM, LF, хвостовой \n; каркас
    const buf = fs.readFileSync(path.join(DS.ROOT, 'core/deepseek-ingest.js'));
    expect(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF).toBe(false);
    expect(MODULE_SRC.indexOf('\r')).toBe(-1);
    expect(MODULE_SRC.endsWith('\n')).toBe(true);
    ['window.AiCmDeepseekIngest = Fn;', 'Fn.__bind = __bind;', 'module.exports = Fn;'].forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
    });
    // гард повторной загрузки модуля (как у D.1-D.7)
    expect(MODULE_SRC).toContain("if (typeof window !== 'undefined' && window.AiCmDeepseekIngest) return;");
  });
});
