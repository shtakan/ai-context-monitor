/**
 * Step D.9: core/deepseek-sse.js — контракт модуля SSE (K6, СЕКЦИЯ 9 ядра).
 *
 * K6 вынесен из core/deepseek-intercept.js БАЙТ-В-БАЙТ. Кластер НЕ непрерывен: у ядра
 * остались K7 (finalizeRealtimeTurn, 760-890) и «остров» D.2 (надгробие + состояние netsync),
 * поэтому областей две — 358-1046 (R1) и 1066-1136 (R2), 760 строк, 42 411 B.
 *
 *   S1. Контракт связки: 6 fn + 18 rw + 2 ro = 26 имён; ядро объявляет 19 KEEP-имён,
 *       модуль — свои 11; 9 форвардеров ядра (function-декларации с гардом) + K7 значением.
 *   S2. Живая связка в vm: до __bind у модуля только __bind; после — ровно 9 тел; 18 rw
 *       ПИШУТ в живое состояние ядра (в sloppy-режиме запись без сеттера молча терялась бы),
 *       2 ro только читаются; перезагрузка модуля не перетирает API и не вешает второй мост.
 *   S3. Байтовая идентичность 12 блоков (заголовок СЕКЦИИ 9 + 10 спанов; спан 5 — двумя
 *       частями, т.к. он единственный смешанный) — SHA-256-пины сняты с модуля и
 *       зафиксированы здесь: git-история НЕ читается (CI клонирует shallow). Посводную
 *       сверку с базой делает gitignored tools/verify-deepseek-sse.js.
 *   S4. Живая семантика: parseSSE на реальном payload (ready/update_session/SET-фрагменты/
 *       дельта/APPEND-массив/белый список/ресинк/BATCH), consumeSseResponse с потоковым
 *       reader'ом и stale-conv гардом, begin/end/resetStreamState, sseModelSignals,
 *       ingestModelSettings (sseConfigName остаётся в ЯДРЕ — аппендикс v50), мост
 *       probe/flush и цикл «модуль → K7 в ядре → модуль».
 *   S5. Проводка: js[] (модуль строго перед ядром), id -v11 + unregister -v10, лог без
 *       скобочной формы, MODULES хелпера, счётчик release.yml, размеры, надгробия, K7.
 *
 * Ядро НЕ перечитывается дважды: `__bind` вызывается один раз (мост probe/flush
 * регистрируется внутри __bind, повторная связка повесила бы второй слушатель).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// TextDecoder/TextEncoder: в jest-окружении не глобальны, а consumeSseResponse читает
// тело ответа именно через них (инкрементальный путь v10/O-16).
const { TextDecoder, TextEncoder } = require('util');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-sse.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 6 fn + 18 rw + 2 ro = 26 имён ----------------------------
const FN_NAMES = ['finalizeRealtimeTurn', 'diagOn', 'diagFragState', 'diagMark',
  'diagChunkRecord', 'getConvId'];
const RW_NAMES = ['sseRealtimeEntryTokens', 'sseRealtimeFinalTokens', 'sseRequestMessageId',
  'sseResponseMessageId', 'sseModelType', 'sseConfigName', 'sseUserPrompt', 'sseParentMessageId',
  'sseThinkingEnabled', 'sseFragments', 'sseFragmentTypes', 'sseStreamActive', 'sseTurnFinished',
  'sseResyncRing', 'sseResyncCount', 'sseResyncBytes', 'sseUnknownCount', 'sseUnknownChars'];
const RO_NAMES = ['SSE_FRAGMENT_TYPES', 'currentConvId'];

// 19 имён состояния остаются var в ЯДРЕ; 11 объявлений уехали в модуль.
const KEEP_VARS = RW_NAMES.concat(['SSE_FRAGMENT_TYPES']);
const MODULE_VARS = ['sseLastPath', 'sseLastOp', 'sseModel', 'sseModelPresent',
  'sseConversationMode', 'sseCurrentEvent', 'SSE_RESYNC_MAX_ENTRIES', 'SSE_RESYNC_MAX_CHARS',
  'sseResyncChars', 'SSE_UNKNOWN_MAX_CHARS', 'sseUnknownParts'];

// 9 форвардеров ядра: имя → аргументы (function-декларации — хойстятся, потому что связки
// D.1/D.5/D.7 стоят ВЫШЕ связки D.9 и получают эти значения).
const FORWARDERS = [
  { name: 'sseModelSignals', args: '' },
  { name: 'ingestModelSettings', args: 'json' },
  { name: 'dispatchStreamState', args: 'reason' },
  { name: 'resetStreamState', args: '' },
  { name: 'streamKnownType', args: 't' },
  { name: 'streamFragmentText', args: 'type' },
  { name: 'streamOtherText', args: '' },
  { name: 'parseSSE', args: 'text' },
  { name: 'consumeSseResponse', args: 'resp, convId' }
];
const EXPORTS = FORWARDERS.map(function (f) { return f.name; });

// 26 тел K6 (порядок §2.2 плана): тела уехали, имена ядру не отдаются.
const BODIES = ['sseModelSignals', 'ingestModelSettings', 'streamStateSnapshot', 'dispatchStreamState',
  'beginSseStream', 'endSseStream', 'resetStreamState', 'streamLastFragment', 'streamKnownType',
  'streamTypeShape', 'processChunk', 'processChunkCore', 'parseSSELines', 'finishSseStream',
  'streamNoteMisroute', 'streamUnknownPush', 'streamLastValidFragment', 'streamResync',
  'streamContentInto', 'streamPushFragment', 'streamAppendContent', 'streamSetContent',
  'streamFragmentText', 'streamOtherText', 'parseSSE', 'consumeSseResponse'];
// Тела, которые ядро НЕ зовёт и форвардеров не получает.
const NON_FORWARDED = ['streamStateSnapshot', 'beginSseStream', 'endSseStream', 'streamLastFragment',
  'streamTypeShape', 'processChunk', 'processChunkCore', 'parseSSELines', 'finishSseStream',
  'streamNoteMisroute', 'streamUnknownPush', 'streamLastValidFragment', 'streamResync',
  'streamContentInto', 'streamPushFragment', 'streamAppendContent', 'streamSetContent'];

// ---- 12 SHA-256-пинов блоков K6 (S3), снятых с САМОГО МОДУЛЯ -------------------------
// Пин = срез модуля от start-якоря до следующего end-якоря. Проверка не читает git:
// байтовая идентичность против базы 6e65e73 доказана локальным верификатором.
const MOVED_BLOCKS = [
  {
    name: 'заголовок СЕКЦИИ 9 (358)', zone: 'pure',
    start: '  // ===== СЕКЦИЯ 9: ПАРСЕР SSE',
    end: '  var sseLastPath = null;',
    sha: '97fb1591e67b6f3c3385644a65dad5f7b0e385c90e8ad600d1b0ace891255fbc'
  },
  {
    name: 'спан 1 (359-360) sseLastPath/sseLastOp', zone: 'pure',
    start: '  var sseLastPath = null;',
    end: '  // v13: сигналы нового контракта из SSE.',
    sha: '828a869aee4608e18084b605bea38774e9c7829966b554678a79ebb714a0613b'
  },
  {
    name: 'спан 2 (366-372) комментарий v13 + sseModel/Present/ConversationMode', zone: 'pure',
    start: '  // v13: сигналы нового контракта из SSE.',
    end: "  var sseCurrentEvent = '';",
    sha: '24f6adb926c1b9074e10e3356d718338fe1d9ee4503ae22461e53082a38d0f0a'
  },
  {
    name: 'спан 3 (387) sseCurrentEvent', zone: 'pure',
    start: "  var sseCurrentEvent = '';",
    end: '  // Сырое кольцо дельт',
    sha: '95601ab31f7539fa07451e0f13c961f4d0e92f228ef100dd75a80fc57b83050f'
  },
  {
    name: 'спан 5 PURE-часть (521-525) комментарий + SSE_RESYNC_MAX_*', zone: 'pure',
    start: '  // Сырое кольцо дельт',
    end: '  var sseResyncChars = 0;',
    sha: '0d89f784f16c9d0f4c03cea527459f9e59c1d3d3188c34fc51be099e8611dd91'
  },
  {
    name: 'спан 6 (527) sseResyncChars', zone: 'pure',
    start: '  var sseResyncChars = 0;',
    end: '  // Контент фрагментов',
    sha: '06419cc09f6b0a417bbf766d7254ec4332a1e28365e9ed0e9cc56e059c48777d'
  },
  {
    name: 'спан 7 (531-534) комментарий + SSE_UNKNOWN_MAX_CHARS/sseUnknownParts', zone: 'pure',
    start: '  // Контент фрагментов',
    end: '  function __bind(d) {',
    sha: '9f348f7d4b955ad710a176a38a6b8bd072e4fd4021355b88a6de8460c906808f'
  },
  {
    // Step E.2a.1 (swallow): молчаливый catch ingestModelSettings (строка 147) стал
    // диагностируемым — `swallow(eSettings, 'deepseek:ingestModelSettings')`.
    name: 'спан 4 (393-504) sseModelSignals … streamLastFragment', zone: 'bind',
    start: '  function sseModelSignals() {',
    end: '  function streamKnownType(t) {',
    // Step E.2c-B2b-2 (swallowSoft): тот же catch переведён на канал B —
    // `swallowSoft(eSettings, 'deepseek:ingestModelSettings')`; pin пересчитан по новой версии.
    sha: 'ade80925ba90cec648dd551a3531a179880f98f0a7fcbd6497b5433576477ed3'
  },
  {
    name: 'спан 5 BIND-часть (514-520) streamKnownType/streamTypeShape', zone: 'bind',
    start: '  function streamKnownType(t) {',
    end: '  function streamNoteMisroute(op, val) {',
    sha: '004a62998bdedb83dacb924090ac1dd6331f6da99aa29ee75a53c8de2f6ab837'
  },
  {
    // Step E.2a.1 (swallow): молчаливый catch ресинка (строка 308) стал диагностируемым —
    // `swallow(e, 'deepseek:streamResync')`; механика ресинка не менялась.
    name: 'спан 8 (536-758) streamNoteMisroute … processChunkCore', zone: 'bind',
    start: '  function streamNoteMisroute(op, val) {',
    end: '  function parseSSELines(lines) {',
    // Step E.2c-B2b-2 (swallowSoft): тот же catch переведён на канал B —
    // `swallowSoft(e, 'deepseek:streamResync')`; pin пересчитан по новой версии.
    sha: '96da0517fac0ca29eb4cde7c220e7c85da5bf1f8c39608045dc13137067c3a06'
  },
  {
    // Step E.2a.1 (swallow): два молчаливых catch стали диагностируемыми — JSON.parse
    // строки SSE (строка 479, `continue` сохранён) и тело flush-моста (строка 610):
    // `swallow(e, 'deepseek:parseSSELines')` / `swallow(eFlush, 'deepseek:streamFlushBridge')`.
    name: 'спан 9 (891-1046) parseSSELines … мост probe/flush', zone: 'bind',
    start: '  function parseSSELines(lines) {',
    end: '  function parseSSE(text) {',
    // Step E.2c-B2b-2 (swallowSoft): те же два catch переведены на канал B —
    // `swallowSoft(e, 'deepseek:parseSSELines')` / `swallowSoft(eFlush, 'deepseek:streamFlushBridge')`;
    // pin пересчитан по новой версии.
    sha: 'fd85f5377696679011986218ac88ee86ecfe0a5aa1f6dbbd4b1623b5c32c6bdb'
  },
  {
    name: 'спан 10 (1065-1136) parseSSE + consumeSseResponse', zone: 'bind',
    start: '  function parseSSE(text) {',
    end: '      // Экспорт тел, которые ядро зовёт по прежним именам (9 форвардеров).',
    sha: 'a590a2669070e4d807909f1ac81d052b59d8d6cedd67fef7d2fdc04e82b6570f'
  }
];

// Маркеры тел: их НЕ должно остаться в ядре. Сигнатуры 9 форвардеров маркерами быть не
// могут — ядро держит их по прежним именам как `function NAME(args) { if (aiCmDeepseekSse) … }`.
const BODY_MARKERS = [
  '  // ===== СЕКЦИЯ 9: ПАРСЕР SSE',
  '  function streamStateSnapshot() {',
  '  function beginSseStream() {',
  '  function endSseStream() {',
  '  function streamResync(reason) {',
  '  function processChunkCore(path, op, val) {',
  '  function parseSSELines(lines) {',
  '  function finishSseStream() {',
  "    window.addEventListener('ai-cm-deepseek-stream-probe', function () {"
];

// Соседи, которые НЕ трогались (K0/K5/K9/СЕКЦИЯ 14 и надгробия прежних шагов).
const NEIGHBOURS = [
  'resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug,',
  '// ===== СЕКЦИЯ 14: ФИНАЛ =====',
  '// ===== Step D.8: K5 (INGEST) вынесен в core/deepseek-ingest.js =====',
  '// ===== Step D.7: K9 (NETWORK) вынесен в core/deepseek-net.js =====',
  '// ===== Step D.9: K6 (SSE) вынесен в core/deepseek-sse.js =====',
  '// ===== Step D.9: связка модуля SSE (core/deepseek-sse.js) =====',
  '// ===== Step D.2: сетевой дозапрос истории вынесен в core/deepseek-netsync.js ====='
];

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/** Блок модуля: срез от start-якоря до следующего end-якоря (как в verify-deepseek-sse.js). */
function blockOf(src, b) {
  const s = src.indexOf(b.start);
  expect(s).toBeGreaterThan(-1);
  const e = src.indexOf(b.end, s + b.start.length);
  expect(e).toBeGreaterThan(s);
  return src.slice(s, e);
}

// ---- разбор литерала __bind ядра (единственный источник правды для S1/S2) ------------
function kernelBindKinds() {
  const start = KERNEL_SRC.lastIndexOf('aiCmDeepseekSse.__bind({');
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

// ---- стенд vm ------------------------------------------------------------------------
const WHITELIST = { THINK: 1, RESPONSE: 1, REQUEST: 1, TIP: 1, SEARCH: 1, TEMPLATE_RESPONSE: 1 };

function makeSandbox() {
  const logs = [];
  const events = [];
  const listeners = {};
  function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }
  const win = {
    dispatchEvent: function (ev) { events.push(ev); return true; },
    addEventListener: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener: function () { }
  };
  const sandbox = {
    console: {
      log: function () { logs.push([].join.call(arguments, ' ')); },
      warn: function () { logs.push('WARN ' + [].join.call(arguments, ' ')); },
      error: function () { logs.push('ERR ' + [].join.call(arguments, ' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Date: Date, Promise: Promise,
    TextDecoder: TextDecoder, TextEncoder: TextEncoder, Uint8Array: Uint8Array,
    CustomEvent: CustomEvent,
    setTimeout: function (fn) { return 0; }, clearTimeout: function () { }
  };
  // window — ОТДЕЛЬНЫЙ объект: модуль зовёт window.dispatchEvent/addEventListener,
  // а песочница остаётся без DOM (K6 его не трогает).
  sandbox.window = win;
  vm.createContext(sandbox);
  return { sandbox: sandbox, window: win, logs: logs, events: events, listeners: listeners };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-sse.js' });
}

function reasons(box) {
  return box.events.filter(function (e) { return e.type === 'ai-cm-deepseek-stream-state'; })
    .map(function (e) { return e.detail.reason; });
}
function marksOf(probe) {
  return probe.calls.marks.map(function (m) { return m[0]; });
}

/** Фейковый ядр: живые rw/ro-аксессоры + счётчики fn-вызовов + K7-заглушка (S2/S4). */
function makeProbe(Fn) {
  const st = {
    sseRealtimeEntryTokens: 0,
    sseRealtimeFinalTokens: 0,
    sseRequestMessageId: null,
    sseResponseMessageId: null,
    sseModelType: null,
    sseConfigName: 'Instant',
    sseUserPrompt: 'вопрос пользователя',
    sseParentMessageId: 'parent-1',
    sseThinkingEnabled: false,
    sseFragments: [],
    sseFragmentTypes: [],
    sseStreamActive: false,
    sseTurnFinished: false,
    sseResyncRing: [],
    sseResyncCount: 0,
    sseResyncBytes: 0,
    sseUnknownCount: 0,
    sseUnknownChars: 0,
    SSE_FRAGMENT_TYPES: WHITELIST,
    currentConvId: 'convD9'
  };
  const writes = {};
  const reads = {};
  const calls = {
    finalizeRealtimeTurn: 0, diagOn: 0, diagFragState: 0, diagMark: 0, diagChunkRecord: 0,
    getConvId: 0, marks: [], chunks: [], turns: [], resets: 0
  };
  const D = {};
  const fns = {
    // K7 живёт в ЯДРЕ: он читает буфер ЧЕРЕЗ ТЕЛА МОДУЛЯ (цикл «модуль → K7 → модуль»).
    finalizeRealtimeTurn: function () {
      calls.finalizeRealtimeTurn++;
      var answer = Fn.streamFragmentText('RESPONSE');
      var reasoning = Fn.streamFragmentText('THINK');
      var other = Fn.streamOtherText();
      calls.turns.push({ answer: answer, reasoning: reasoning, other: other });
      Fn.dispatchStreamState('finalize');
    },
    diagOn: function () { calls.diagOn++; return true; },
    diagFragState: function () { calls.diagFragState++; return { n: st.sseFragments.length }; },
    diagMark: function (kind, data) { calls.diagMark++; calls.marks.push([kind, data]); },
    diagChunkRecord: function (p, o, v, before, after) {
      calls.diagChunkRecord++; calls.chunks.push([p, o, v, before, after]);
    },
    getConvId: function () { calls.getConvId++; return st.currentConvId; }
  };
  FN_NAMES.forEach(function (n) { Object.defineProperty(D, n, { get: function () { return fns[n]; }, enumerable: true }); });
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

function resetProbe(probe) {
  const st = probe.st;
  st.sseRealtimeEntryTokens = 0;
  st.sseRealtimeFinalTokens = 0;
  st.sseRequestMessageId = null;
  st.sseResponseMessageId = null;
  st.sseModelType = null;
  st.sseConfigName = 'Instant';
  st.sseUserPrompt = 'вопрос пользователя';
  st.sseParentMessageId = 'parent-1';
  st.sseThinkingEnabled = false;
  st.sseFragments = [];
  st.sseFragmentTypes = [];
  st.sseStreamActive = false;
  st.sseTurnFinished = false;
  st.sseResyncRing = [];
  st.sseResyncCount = 0;
  st.sseResyncBytes = 0;
  st.sseUnknownCount = 0;
  st.sseUnknownChars = 0;
  st.currentConvId = 'convD9';
  Object.keys(probe.writes).forEach(function (k) { delete probe.writes[k]; });
  Object.keys(probe.reads).forEach(function (k) { delete probe.reads[k]; });
  const c = probe.calls;
  Object.keys(c).forEach(function (k) { if (Array.isArray(c[k])) c[k].length = 0; else c[k] = 0; });
}

// ---- реалистичный payload потока DeepSeek (v13) ---------------------------------------
// ready → update_session → первый response-объект с SET-фрагментами → дельта последнего
// фрагмента → APPEND-массив (валидный TIP + тип вне белого списка SEARCHX) → «типоподобная»
// строка BSCRIPT (десинхрон: байты контента, а не тип) → финальный BATCH.
const SSE_PAYLOAD = [
  'event: ready',
  'data: {"request_message_id":"req1","response_message_id":"resp1","model_type":"default"}',
  '',
  'event: update_session',
  'data: {"v":{"response":{"model":"","conversation_mode":"DEFAULT"}}}',
  '',
  'data: {"v":{"response":{"accumulated_token_usage":123,"model_type":"default","fragments":[{"type":"THINK","content":"думаю"},{"type":"RESPONSE","content":"Привет"}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"!"}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"TIP","content":"подсказка"},{"type":"SEARCHX","content":"хвост"}]}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":"BSCRIPT"}',
  '',
  'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":456},{"p":"quasi_status","v":"FINISHED"}]}'
].join('\n');

/** Фейковый Response: clone() → потоковый body + текстовый фолбэк (реальный путь v10/O-16). */
function fakeResponse(chunks, onRead) {
  const enc = new TextEncoder();
  const bytes = chunks.map(function (c) { return enc.encode(c); });
  let cancelled = false, reads = 0;
  return {
    clone: function () {
      let i = 0;
      return {
        body: {
          getReader: function () {
            return {
              read: function () {
                reads++;
                if (onRead) onRead(reads);
                return Promise.resolve(i < bytes.length ? { done: false, value: bytes[i++] } : { done: true });
              },
              cancel: function () { cancelled = true; return Promise.resolve(); }
            };
          }
        },
        text: function () { return Promise.resolve(chunks.join('')); }
      };
    },
    stats: function () { return { reads: reads, cancelled: cancelled }; }
  };
}

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }

describe('Step D.9: core/deepseek-sse.js — контракт модуля SSE (K6)', () => {
  test('S1: литерал __bind в ядре содержит ровно 26 имён (6 fn + 18 rw + 2 ro)', function () {
    expect(KINDS.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) { expect(KINDS.get(pair[0])).toBe(pair[1]); });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 6, ro: 2, rw: 18 });

    // 19 KEEP-имён реально объявлены `var` в ЯДРЕ: иначе сеттер писал бы в никуда,
    // а геттер читал бы НЕЯВНЫЙ ГЛОБАЛ (урок D.5/D.8), и состояние потока терялось бы молча.
    KEEP_VARS.forEach(function (n) {
      expect(KERNEL_SRC).toMatch(new RegExp('^ {2}var\\s+' + n + '\\s*=', 'm'));
    });
    expect(KERNEL_SRC).toContain('  var currentConvId = ');
    // Модуль НЕ объявляет ни одного из 19 имён — иначе появилась бы ВТОРАЯ переменная.
    KEEP_VARS.concat(RO_NAMES).forEach(function (n) {
      expect(MODULE_SRC).not.toMatch(new RegExp('\\bvar\\s+' + n + '\\b'));
    });
    // 11 module-owned объявлений уехали вместе с телами (ссылок вне выреза нет).
    MODULE_VARS.forEach(function (n) {
      expect(MODULE_SRC).toMatch(new RegExp('(?:^|\\n)\\s*var\\s+' + n + '\\b'));
      expect(KERNEL_SRC).not.toMatch(new RegExp('^ {2}var\\s+' + n + '\\s*=', 'm'));
    });

    // Тела аксессоров: ro — чтение имени ядра, rw — get + set.
    const literal = KERNEL_SRC.slice(KERNEL_SRC.lastIndexOf('aiCmDeepseekSse.__bind({'),
      KERNEL_SRC.indexOf('});', KERNEL_SRC.lastIndexOf('aiCmDeepseekSse.__bind({')));
    RO_NAMES.forEach(function (n) {
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
      expect(literal).not.toContain('set ' + n + '(');
    });
    RW_NAMES.forEach(function (n) {
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
      expect(literal).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });

    // 9 форвардеров — ровно `function`-декларации с гардом (хойстятся для связок выше).
    FORWARDERS.forEach(function (f) {
      expect(KERNEL_SRC).toContain('  function ' + f.name + '(' + f.args + ') { if (aiCmDeepseekSse) return aiCmDeepseekSse.' + f.name + '(' + f.args + '); }');
      expect(MODULE_SRC).toContain('Fn.' + f.name + ' = ' + f.name + ';');
    });
    // и ни одного тела без форвардера ядро наружу не просит
    NON_FORWARDED.forEach(function (n) {
      expect(KERNEL_SRC).not.toMatch(new RegExp('^ {2}function ' + n + '\\(', 'm'));
      expect(MODULE_SRC).toContain('  function ' + n + '(');
    });
    // K7 остался в ядре и передан ЗНАЧЕНИЕМ (не форвардером — обратная зависимость).
    expect(KERNEL_SRC).toContain('      finalizeRealtimeTurn: finalizeRealtimeTurn,');
    expect(KERNEL_SRC).toContain('  function finalizeRealtimeTurn() {');
    expect(KERNEL_SRC).not.toContain('aiCmDeepseekSse.finalizeRealtimeTurn(');
    expect(MODULE_SRC).not.toContain('function finalizeRealtimeTurn(');
    // K0 остался в ядре и по-прежнему экспортируется наружу (контрактный тест v13).
    expect(KERNEL_SRC).toContain('resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug');
    // 26 тел — в модуле, и ни одного в ядре как объявления (кроме 4 имён форвардеров).
    BODIES.forEach(function (n) {
      expect(MODULE_SRC).toContain('  function ' + n + '(');
    });
    // модуль отдаёт наружу ровно 9 тел + __bind
    expect(MODULE_SRC.match(/^\s*Fn\.([A-Za-z_$][\w$]*) = \1;$/gm).length).toBe(10);   // 9 тел + __bind
    expect(MODULE_SRC).toContain('  Fn.__bind = __bind;');
  });

  test('S2: живая связка в vm — 18 rw пишут в живое ядро, 2 ro только читают, цикл модуль↔K7', function () {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.window.AiCmDeepseekSse;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);
    EXPORTS.forEach(function (n) { expect(Fn[n]).toBeUndefined(); });   // до связки тел нет вовсе

    const probe = makeProbe(Fn);
    Fn.__bind(probe.D);
    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());
    EXPORTS.forEach(function (n) { expect(typeof Fn[n]).toBe('function'); });

    // --- живой прогон: полный payload через ФОРВАРДЕР по прежнему имени -----------------
    Fn.parseSSE(SSE_PAYLOAD);

    // rw: записи доехали до ЖИВОГО состояния ядра (не в копию модуля)
    expect(probe.st.sseRequestMessageId).toBe('req1');
    expect(probe.st.sseResponseMessageId).toBe('resp1');
    expect(probe.st.sseModelType).toBe('default');
    expect(probe.st.sseRealtimeEntryTokens).toBe(123);
    expect(probe.st.sseRealtimeFinalTokens).toBe(456);
    expect(probe.st.sseStreamActive).toBe(false);           // endSseStream в конце parseSSE
    expect(probe.st.sseTurnFinished).toBe(false);
    expect(probe.st.sseFragments.map(function (f) { return f.type; }))
      .toEqual(['THINK', 'RESPONSE', 'TIP']);
    expect(probe.st.sseFragmentTypes).toEqual(['THINK', 'RESPONSE', 'TIP']);
    expect(probe.st.sseFragments[1].content).toBe('Привет!');
    // КАЖДАЯ rw-пара обязательна: без сеттера запись в sloppy-режиме молча терялась бы
    expect(probe.writes.sseFragments).toBeGreaterThan(0);
    expect(probe.writes.sseRequestMessageId).toBeGreaterThan(0);
    expect(probe.writes.sseStreamActive).toBeGreaterThan(0);
    expect(probe.writes.sseUserPrompt).toBeGreaterThan(0);   // begin/reset переписывает

    // цикл «модуль → K7 в ядре → модуль»: K7 зовёт тела модуля теми же именами
    expect(probe.calls.finalizeRealtimeTurn).toBe(2);        // BATCH quasi_status + финал тела
    expect(probe.calls.turns[0].answer).toBe('Привет!');
    expect(probe.calls.turns[0].reasoning).toBe('думаю');
    expect(reasons(box)).toEqual(['begin', 'finalize', 'finalize', 'end']);

    // ro: читаются живые имена ядра, но НИКОГДА не пишутся телом модуля
    expect(probe.reads.SSE_FRAGMENT_TYPES).toBeGreaterThan(0);   // streamKnownType
    expect(probe.reads.currentConvId).toBeGreaterThan(0);        // snapshot/sameConv
    expect(probe.writes.SSE_FRAGMENT_TYPES).toBeUndefined();
    expect(probe.writes.currentConvId).toBeUndefined();
    expect(MODULE_SRC).not.toMatch(/[^.\w]SSE_FRAGMENT_TYPES\s*=(?!=)/);
    expect(MODULE_SRC).not.toMatch(/[^.\w]currentConvId\s*=(?!=)/);

    // перезагрузка модуля: гард возвращает тот же Fn и НЕ вешает второй мост probe/flush
    expect(box.listeners['ai-cm-deepseek-stream-probe'].length).toBe(1);
    loadModule(box);
    expect(box.window.AiCmDeepseekSse).toBe(Fn);
    expect(typeof Fn.parseSSE).toBe('function');
    expect(box.listeners['ai-cm-deepseek-stream-probe'].length).toBe(1);
    // ядро связывает модуль РОВНО один раз: повторный __bind удвоил бы слушатель моста
    expect(KERNEL_SRC.match(/aiCmDeepseekSse\.__bind\(\{/g).length).toBe(1);
  });

  test('S3: 12 блоков K6 перенесены дословно (SHA-256-пины модуля); в ядре — надгробие и K7', function () {
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      expect(sha256(body)).toBe(b.sha);
      // вырезано из ядра: ни одного блока K6 в ядре не осталось
      expect(KERNEL_SRC.indexOf(body)).toBe(-1);
    });
    // зоны: PURE-блоки — вне with (D), BIND-блоки — внутри
    const bindAt = MODULE_SRC.indexOf('  function __bind(d) {');
    const withAt = MODULE_SRC.indexOf('    with (D) {');
    expect(bindAt).toBeGreaterThan(-1);
    expect(withAt).toBeGreaterThan(bindAt);
    MOVED_BLOCKS.forEach(function (b) {
      const at = MODULE_SRC.indexOf(b.start);
      const end = MODULE_SRC.indexOf(b.end, at);
      // PURE-блоки целиком лежат ДО `function __bind` (последний кончается ровно на нём);
      // BIND-блоки начинаются ПОСЛЕ `with (D) {` — иначе свободные имена ядра не резолвятся.
      if (b.zone === 'pure') { expect(at).toBeLessThan(bindAt); expect(end).toBeLessThanOrEqual(bindAt); }
      else expect(at).toBeGreaterThan(withAt);
    });

    // заголовок СЕКЦИИ 9 уехал: в ядре его нет, в модуле — есть
    expect(KERNEL_SRC).not.toContain('// ===== СЕКЦИЯ 9: ПАРСЕР SSE');
    expect(MODULE_SRC).toContain('  // ===== СЕКЦИЯ 9: ПАРСЕР SSE (постфактум и ИНКРЕМЕНТАЛЬНО, ловушка №2) =====');
    // тело K7 (760-890) — ТОЛЬКО в ядре
    expect(KERNEL_SRC).toContain('  function finalizeRealtimeTurn() {');
    expect(MODULE_SRC).not.toContain('function finalizeRealtimeTurn(');
    expect(KERNEL_SRC).toContain('      finalizeRealtimeTurn: finalizeRealtimeTurn,');
    // маркеры тел K6 в ядре отсутствуют
    BODY_MARKERS.forEach(function (m) { expect(KERNEL_SRC).not.toContain(m); });
    // надгробие D.9 на месте, прежние надгробия целы
    NEIGHBOURS.forEach(function (l) { expect(KERNEL_SRC).toContain(l); });
    // «остров» D.2 между областями K6 остался в ядре (K6 не непрерывен!)
    expect(KERNEL_SRC).toContain('// ===== Step D.2: сетевой дозапрос истории вынесен в core/deepseek-netsync.js =====');
    expect(KERNEL_SRC).toContain('  var netSnapshotAt = 0;');
    expect(MODULE_SRC).not.toContain('var netSnapshotAt');
    // 26 module-owned/19 KEEP: состояния в модуле нет
    MODULE_VARS.forEach(function (n) { expect(MODULE_SRC).toMatch(new RegExp('var\\s+' + n + '\\b')); });
  });

  test('S4: живая семантика — parseSSE, белый список/ресинк, consumeSseResponse, K7 и мост', function () {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.window.AiCmDeepseekSse;
    const probe = makeProbe(Fn);
    Fn.__bind(probe.D);

    // --- (a) parseSSE: белый список, ресинк, счётчики, сброс -----------------------------
    Fn.parseSSE(SSE_PAYLOAD);
    // незнакомый тип НЕ заводится фрагментом; контент спасён аварийным бакетом
    expect(probe.st.sseUnknownCount).toBe(1);
    expect(probe.st.sseUnknownChars).toBe('хвост'.length);
    // «типоподобная» строка BSCRIPT — это БАЙТЫ контента (десинхрон): ресинк вернул их
    // в последний ВАЛИДНЫЙ фрагмент (TIP), кольцо опустошено, счётчики инкрементнуты
    expect(probe.st.sseFragments[2]).toEqual({ type: 'TIP', content: 'подсказкаBSCRIPT' });
    expect(probe.st.sseResyncCount).toBe(1);
    expect(probe.st.sseResyncBytes).toBe('BSCRIPT'.length);
    expect(probe.st.sseResyncRing).toEqual([]);
    expect(Fn.streamFragmentText('RESPONSE')).toBe('Привет!');
    expect(Fn.streamOtherText()).toBe('подсказкаBSCRIPTхвост');
    expect(marksOf(probe)).toEqual(expect.arrayContaining(
      ['stream-reset', 'sse-begin', 'frag-unknown-type', 'frag-resync', 'sse-finish', 'sse-end']));

    // sseModelSignals: module-owned model/modelPresent/conversationMode + ядровые
    // sseModelType/sseConfigName (configName НЕ уехал — его читает ro-геттер D.8)
    expect(Fn.sseModelSignals()).toEqual({
      modelPresent: true, model: '', modelType: 'default',
      conversationMode: 'DEFAULT', configName: 'Instant'
    });

    // ingestModelSettings: пишет sseConfigName в ЖИВОЕ состояние ЯДРА (аппендикс v50)
    Fn.ingestModelSettings({
      data: { biz_data: { settings: { model_configs: { value: [
        { name: 'Instant-v2', model_type: 'default', enabled: true }
      ] } } } }
    });
    expect(probe.writes.sseConfigName).toBe(1);
    expect(probe.st.sseConfigName).toBe('Instant-v2');
    expect(Fn.sseModelSignals().configName).toBe('Instant-v2');

    // resetStreamState: тела модуля обнуляют состояние ЯДРА и чистое module-owned
    resetProbe(probe);
    Fn.parseSSE(SSE_PAYLOAD);
    Fn.resetStreamState();
    expect(probe.st.sseFragments).toEqual([]);
    expect(probe.st.sseFragmentTypes).toEqual([]);
    expect(probe.st.sseRequestMessageId).toBeNull();
    expect(probe.st.sseResponseMessageId).toBeNull();
    expect(probe.st.sseRealtimeEntryTokens).toBe(0);
    expect(probe.st.sseRealtimeFinalTokens).toBe(0);
    // КУМУЛЯТИВНЫЕ счётчики ресинка/мусора сбросом потока НЕ обнуляются (так в байт-в-байт
    // перенесённом теле): сброс чистит кольцо и бакет, но не историю отказов за сессию.
    expect(probe.st.sseResyncCount).toBe(1);
    expect(probe.st.sseResyncBytes).toBe('BSCRIPT'.length);
    expect(probe.st.sseUnknownCount).toBe(1);
    expect(probe.st.sseResyncRing).toEqual([]);
    expect(probe.st.sseUnknownChars).toBe(0);
    expect(probe.st.sseStreamActive).toBe(false);
    expect(marksOf(probe)).toContain('stream-reset');
    // поля ЗАПРОСА сброшены (beginSseStream вернёт их из снимка — проверка ниже)
    expect(probe.st.sseUserPrompt).toBe('');

    // --- (b) мост probe/flush: снимок наружу и принудительный финал ---------------------
    box.events.length = 0;
    box.listeners['ai-cm-deepseek-stream-probe'][0]();
    const probeReply = box.events.filter(function (e) {
      return e.type === 'ai-cm-deepseek-stream-probe-response';
    });
    expect(probeReply.length).toBe(1);
    expect(probeReply[0].detail).toEqual({ convId: 'convD9', active: false, turnFinished: false });
    // flush при НЕактивном стриме — no-op
    resetProbe(probe);
    box.listeners['ai-cm-deepseek-stream-flush'][0]();
    expect(probe.calls.finalizeRealtimeTurn).toBe(0);
    expect(reasons(box)).toEqual([]);

    // --- (c) consumeSseResponse: инкрементальный путь + stale-conv гард -----------------
    return (async function () {
      // (c1) ЧУЖОЙ чат: beginSseStream прошёл, но чтение отменено — ходы не подмешиваются
      resetProbe(probe);
      probe.st.currentConvId = 'convD9';
      box.events.length = 0;
      const other = fakeResponse([SSE_PAYLOAD]);
      Fn.consumeSseResponse(other, 'convOTHER');
      await flush();
      expect(other.stats().cancelled).toBe(true);
      expect(probe.st.sseFragments).toEqual([]);
      expect(probe.calls.finalizeRealtimeTurn).toBe(0);
      expect(reasons(box)).toEqual(['begin', 'end']);

      // (c2) СВОЙ чат: построчный разбор по мере чтения чанков
      resetProbe(probe);
      box.events.length = 0;
      const lines = SSE_PAYLOAD.split('\n');
      const chunks = [];
      for (let i = 0; i < lines.length; i += 3) { chunks.push(lines.slice(i, i + 3).join('\n') + '\n'); }
      const own = fakeResponse(chunks);
      Fn.consumeSseResponse(own, 'convD9');
      await flush();
      expect(probe.st.sseFragments.map(function (f) { return f.type; }))
        .toEqual(['THINK', 'RESPONSE', 'TIP']);
      expect(probe.st.sseFragments[1].content).toBe('Привет!');
      expect(probe.calls.finalizeRealtimeTurn).toBeGreaterThanOrEqual(1);
      expect(reasons(box)).toEqual(['begin', 'finalize', 'finalize', 'end']);
      expect(probe.st.sseStreamActive).toBe(false);

      // (c3) flush ПОСРЕДИ активного стрима (экспортёр спрашивает состояние и закрывает буфер)
      resetProbe(probe);
      box.events.length = 0;
      const mid = fakeResponse([lines.slice(0, 6).join('\n') + '\n', lines.slice(6).join('\n')], function (n) {
        if (n === 1) box.listeners['ai-cm-deepseek-stream-flush'][0]();
      });
      Fn.consumeSseResponse(mid, 'convD9');
      await flush();
      expect(marksOf(probe)).toContain('sse-finish');
      expect(reasons(box)).toContain('flush');
      expect(probe.calls.finalizeRealtimeTurn).toBeGreaterThanOrEqual(1);
      expect(probe.st.sseStreamActive).toBe(false);
    }());
  });

  test('S5: проводка — js[] перед ядром, id -v11 + unregister -v10, размеры и K7 в ядре', function () {
    // порядок: модуль строго ПЕРЕД ядром (контракт __bind нужен на момент связки)
    expect(DS.SOURCES.indexOf('core/deepseek-sse.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
    expect(DS.SOURCES.indexOf('core/deepseek-ingest.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-sse.js'));
    expect(DS.MODULES).toContain('core/deepseek-sse.js');
    expect(DS.MODULES[DS.MODULES.length - 1]).toBe('core/deepseek-sse.js');
    expect(DS.MODULES.length).toBe(9);
    expect(KERNEL_SRC).toContain('aiCmDeepseekSse');

    const bg = DS.readSource('core/background.js');
    expect(bg).toContain("js: ['utils/debug.js', 'core/deepseek-diag.js', 'core/deepseek-netsync.js', 'core/deepseek-refetch.js', 'core/deepseek-parse.js', 'core/deepseek-conv.js', 'core/deepseek-emit.js', 'core/deepseek-net.js', 'core/deepseek-ingest.js', 'core/deepseek-sse.js', 'core/deepseek-intercept.js']");
    expect(bg).toContain("ids.indexOf('ai-cm-deepseek-intercept-v11') === -1");
    expect(bg).toContain("await registerSafe('ai-cm-deepseek-intercept-v11'");
    expect(bg).toContain("id: 'ai-cm-deepseek-intercept-v11'");
    expect(bg).toContain("unregisterContentScripts({ ids: ['ai-cm-deepseek-intercept-v10'] })");
    // id -v11 встречается ровно 4 раза (шапка + guard + registerSafe + id), -v10 — только в unregister
    expect((bg.match(/ai-cm-deepseek-intercept-v11/g) || [])).toHaveLength(4);
    expect((bg.match(/ai-cm-deepseek-intercept-v10/g) || [])).toHaveLength(1);
    // лог DeepSeek без «(vN)»-формы: скобочную форму глобально запрещают Gemini-пины
    expect(bg).toContain('перехватчик DeepSeek v11 зарегистрирован');
    expect(bg).not.toContain('перехватчик DeepSeek (v11) зарегистрирован');

    // release.yml: счётчик MAIN-world файлов равен факту (35 = 5 бандлов + 30 модулей/ядер)
    const yml = DS.readSource('.github/workflows/release.yml');
    expect((yml.match(/35 MAIN-world/g) || [])).toHaveLength(2);
    expect(yml).not.toContain('34 MAIN-world');

    // размеры: ядро 1657 → 1169, модуль 702 (пины D.7/D.8/D.9)
    expect(KERNEL_SRC.split('\n').length).toBe(1169);
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(1700);
    expect(MODULE_SRC.trimEnd().split('\n').length).toBe(702);
    expect(MODULE_SRC.trimEnd().split('\n').length).toBeGreaterThan(600);

    // модуль: UTF-8 без BOM, LF, хвостовой \n; каркас и гард повторной загрузки
    const buf = fs.readFileSync(path.join(DS.ROOT, 'core/deepseek-sse.js'));
    expect(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF).toBe(false);
    expect(MODULE_SRC.indexOf('\r')).toBe(-1);
    expect(MODULE_SRC.endsWith('\n')).toBe(true);
    ['window.AiCmDeepseekSse = Fn;', 'Fn.__bind = __bind;', 'module.exports = Fn;',
      "if (typeof window !== 'undefined' && window.AiCmDeepseekSse) return;"].forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
    });
    // префиксов D. в телах модуля нет (with (D), ES3 Annex B)
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // связки модулей идут в порядке шагов, D.9 — последняя
    const order = ['aiCmDeepseekDiag.__bind({', 'aiCmDeepseekNetsync.__bind({', 'aiCmDeepseekRefetch.__bind({',
      'aiCmDeepseekParse.__bind({', 'aiCmDeepseekConv.__bind({', 'aiCmDeepseekEmit.__bind({',
      'aiCmDeepseekNet.__bind({', 'aiCmDeepseekIngest.__bind({', 'aiCmDeepseekSse.__bind({'];
    const at = order.map(function (l) { return KERNEL_SRC.lastIndexOf(l); });
    at.forEach(function (v, i) { expect(v).toBeGreaterThan(-1); if (i) expect(at[i - 1]).toBeLessThan(v); });

    // 9 форвардеров объявлены ПОСЛЕ связки D.9 (в конце IIFE), но связки D.1/D.5/D.7 стоят
    // ВЫШЕ и получают их ЗНАЧЕНИЯ — это работает ТОЛЬКО потому, что форвардеры суть
    // `function`-декларации и хойстятся. Проверяем хойстинг живьём: значения снимаются
    // ДО объявлений, внутри отдельной функции (ровно как на момент связки D.5).
    const fwdLines = FORWARDERS.map(function (f) {
      const line = '  function ' + f.name + '(' + f.args + ') { if (aiCmDeepseekSse) return aiCmDeepseekSse.' + f.name + '(' + f.args + '); }';
      expect(KERNEL_SRC).toContain(line);
      return line;
    });
    const hoistScript = '(function () {\n' +
      '  var captured = { ' + FORWARDERS.map(function (f) { return f.name + ': ' + f.name; }).join(', ') + ' };\n' +
      fwdLines.join('\n') + '\n' +
      '  return captured;\n}())';
    const captured = vm.runInNewContext(hoistScript, { aiCmDeepseekSse: null }, { filename: 'hoist' });
    FORWARDERS.forEach(function (f) { expect(typeof captured[f.name]).toBe('function'); });

    // живой прогон через ХОЙСТНУТЫЕ форвардеры, привязанные к настоящему модулю:
    // ядро зовёт K6 по прежним именам, а тело исполняется в модуле
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.window.AiCmDeepseekSse;
    const probe = makeProbe(Fn);
    Fn.__bind(probe.D);
    const live = vm.runInNewContext(hoistScript, { aiCmDeepseekSse: Fn }, { filename: 'hoist-live' });
    live.parseSSE(SSE_PAYLOAD);
    expect(probe.st.sseFragments.map(function (f) { return f.type; }))
      .toEqual(['THINK', 'RESPONSE', 'TIP']);
    expect(live.streamFragmentText('RESPONSE')).toBe('Привет!');
    expect(live.streamKnownType('RESPONSE')).toBe(true);
    expect(live.streamKnownType('BSCRIPT')).toBe(false);
    expect(probe.calls.finalizeRealtimeTurn).toBe(2);
    // гард: ядро грузится и БЕЗ модуля (контрактные тесты K0/слагов, одиночный require) —
    // форвардеры не бросают и возвращают undefined. Берём СОБСТВЕННУЮ строку объявления
    // ядра: aiCmDeepseekSse = (typeof window !== 'undefined' && window.AiCmDeepseekSse) || null
    const decl = "  var aiCmDeepseekSse = (typeof window !== 'undefined' && window.AiCmDeepseekSse) || null;";
    expect(KERNEL_SRC).toContain(decl);
    const bare = vm.runInNewContext('(function () {\n' + decl + '\n' + fwdLines.join('\n') + '\n' +
      '  return { ' + FORWARDERS.map(function (f) { return f.name + ': ' + f.name; }).join(', ') + ' };\n}())',
      {}, { filename: 'hoist-bare' });
    FORWARDERS.forEach(function (f) { expect(bare[f.name]()).toBeUndefined(); });
  });
});
