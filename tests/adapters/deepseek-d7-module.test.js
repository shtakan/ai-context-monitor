/**
 * Step D.7 (декомпозиция core/deepseek-intercept.js): контракт модуля NETWORK.
 *
 * Кластер K9 (СЕКЦИИ 11/12 ядра — обёртка window.fetch и обёртки
 * XMLHttpRequest.prototype.open/send/setRequestHeader + копилки авторизации и истории)
 * уехал в core/deepseek-net.js. Модуль и ядро — РАЗНЫЕ IIFE одного registerContentScripts-
 * пакета (js[]: utils/debug.js -> deepseek-diag.js -> deepseek-netsync.js ->
 * deepseek-refetch.js -> deepseek-parse.js -> deepseek-conv.js -> deepseek-emit.js ->
 * deepseek-net.js -> deepseek-intercept.js), поэтому связь идёт ровно через один контракт:
 *
 *   ядро -> модуль: window.AiCmDeepseekNet.__bind(deps)
 *     fn (11): collectHeaders/convIdFromHistoryUrl/convIdFromCompletionBody/guardCheck/
 *              refetchFullHistory — форвардеры D.3 (core/deepseek-refetch.js);
 *              diagOn/diagHistRecord — форвардеры D.1 (core/deepseek-diag.js);
 *              ingestHistory — тело K5 (СЕКЦИЯ 8); parseSSE/consumeSseResponse/
 *              ingestModelSettings — тела K6/K10 (СЕКЦИИ 9/9D).
 *     rw (6):  копилки и параметры потока, которые тела K9 ПЕРЕЗАПИСЫВАЮТ:
 *              lastAuthHeaders/lastHistoryUrl/lastLoadedConvId (состояние refetch-гигиены,
 *              его читают K8) и sseUserPrompt/sseParentMessageId/sseThinkingEnabled
 *              (параметры нового потока, их читает K6 на SSE-финализации). Без сеттера
 *              запись в sloppy-режиме молча терялась бы: копилка осталась бы прежней,
 *              MERGE-дозапрос ушёл бы по чужому URL (v6/v11/O-17), а ход потерял бы промпт.
 *     ro (5):  originalFetch/OriginalXHR/originalXHROpen/originalXHRSend/currentConvId —
 *              модуль их только читает (мутация прототипа XHR и подмена window.fetch идут
 *              по ссылке/через сам объект, а не переприсваиванием имени).
 *   модуль -> ядро: НИЧЕГО. Форвардеров у D.7 нет: прежние имена кластера (window.fetch и
 *   OriginalXHR.prototype.*) читает САЙТ, а не ядро. Поэтому Fn после связки содержит
 *   ровно __bind — это отдельный пин (S2), а не отсутствие проверки.
 *
 * Здесь пинятся:
 *   S1. Полнота контракта: литерал __bind в ядре содержит ровно 22 имени
 *       (11 fn + 6 rw + 5 ro), ни одного потерянного/лишнего; каждая fn-передача —
 *       function declaration ядра, каждое rw/ro-имя объявлено var в ядре и НЕ объявлено
 *       повторно в модуле (иначе появилась бы ВТОРАЯ переменная).
 *   S2. Живая связка в vm: до __bind наружу торчит ТОЛЬКО __bind и обёртки НЕ поставлены;
 *       полная связка подменяет window.fetch и методы прототипа XHR, а обёрнутый fetch
 *       ходит в originalFetch ядра ровно один раз (нет самозамыкания), пишет в ЖИВЫЕ
 *       rw-аксессоры ядра и доводит историю до guardCheck/ingestHistory; повторная
 *       загрузка модуля не перетирает уже связанный API.
 *   S3. Байтовая идентичность тел: 4 блока K9 (СЕКЦИИ 11/12 HEAD 9aca03a, строки 1411-1628)
 *       лежат в модуле ДОСЛОВНО (SHA-256 каждого блока зафиксирован здесь — git-история
 *       сьютом не читается, CI shallow); заголовки секций — в PURE-зоне, оба тела —
 *       в BIND-зоне внутри `with (D)`; объявления-оригиналы и состояние копилок остались
 *       в ядре; префиксов D. нет; надгробие и связка на месте.
 *   S4. Живая семантика K9: fetch-хук (история → guard/ingest, MERGE-путь → refetch,
 *       completion → параметры потока, settings → ingestModelSettings) и XHR-хук (зеркало
 *       fetch + setRequestHeader-копилка, load → ingest/parseSSE/settings).
 *   S5. Проводка: js[] строго после deepseek-emit.js и перед ядром, id -v10 + unregister -v9,
 *       helper MODULES, счётчик release.yml, размеры ядра/модуля, K0 не тронут.
 */

const vm = require('vm');
const crypto = require('crypto');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-net.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 11 fn + 6 rw + 5 ro = 22 имени ----------------------------
const FN_NAMES = ['collectHeaders', 'convIdFromHistoryUrl', 'convIdFromCompletionBody',
  'guardCheck', 'refetchFullHistory', 'diagOn', 'diagHistRecord', 'ingestHistory',
  'parseSSE', 'consumeSseResponse', 'ingestModelSettings'];
const RW_NAMES = ['lastAuthHeaders', 'lastHistoryUrl', 'lastLoadedConvId', 'sseUserPrompt',
  'sseParentMessageId', 'sseThinkingEnabled'];
const RO_NAMES = ['originalFetch', 'OriginalXHR', 'originalXHROpen', 'originalXHRSend',
  'currentConvId'];

// ---- что модуль отдаёт наружу после __bind (S2) -------------------------------------
// D.7 — единственный шаг декомпозиции БЕЗ форвардеров: ядро тела кластера не зовёт.
const EXPORTS = [];

// ---- блоки K9, перенесённые в модуль дословно (S3) ----------------------------------
// Эталон — SHA-256 блока в core/deepseek-intercept.js на 9aca03a (HEAD момента D.7),
// строки 1411-1628. Хэши сняты с блока и ЗАФИКСИРОВАНЫ здесь: сьют не читает git-историю
// (CI клонирует shallow), поэтому байтовая идентичность против базы доказывается двумя
// независимыми способами — этими пинами (текущий модуль) и tools/verify-deepseek-net.js
// (дословное сравнение с git show, локально). Пин = срез МОДУЛЯ от start-якоря до
// end-якоря; у XHR-хука end-якорь захватывает закрывающие скобки каркаса (`    }` / `  }`)
// — это часть регионального пина, а не тела: дословность самого тела (1518-1628)
// проверяет верификатор по строкам блоба.
const MOVED_BLOCKS = [
  {
    name: 'СЕКЦИЯ 11 (заголовок)', zone: 'pure',
    start: '  // ===== СЕКЦИЯ 11: ПЕРЕХВАТ FETCH',
    end: '  // ===== СЕКЦИЯ 12: ПЕРЕХВАТ XHR',
    sha: '6f901efe1d3d73a113c1dba1e83f60cf60b2b47d973364352b02cf8ec79370fd'
  },
  {
    // Step E.2a.1 (swallow): пять молчаливых catch fetch-хука (строки 85, 116, 151, 164, 178)
    // стали диагностируемыми (`swallow(e, 'deepseek:fetch-*')`); прочие строки блока — байт-в-байт.
    name: 'fetch-хук', zone: 'bind',
    start: '  if (typeof originalFetch === \'function\') {',
    end: '  if (originalXHROpen && originalXHRSend) {',
    sha: '74f419a71c6c94b4be91aa5b3cf490ca00b5d0e858b5770084d0db88c86b3361'
  },
  {
    name: 'СЕКЦИЯ 12 (заголовок)', zone: 'pure',
    start: '  // ===== СЕКЦИЯ 12: ПЕРЕХВАТ XHR',
    end: '  function __bind(d) {',
    sha: 'c47550a7587b228d9722b6fe09deacbadd65814c38a6a0f9e10f614287dd25c3'
  },
  {
    // Step E.2a.1 (swallow): пять молчаливых catch XHR-хука (строки 211, 243, 277, 290, 292)
    // стали диагностируемыми (`swallow(e, 'deepseek:xhr-*')`); прочие строки блока — байт-в-байт.
    name: 'XHR-хук', zone: 'bind',
    start: '  if (originalXHROpen && originalXHRSend) {',
    end: '    }\n  }\n  Fn.__bind = __bind;',
    sha: 'ec491bd94fc007c57c2d206355300b27b38e110768e6637a0d24f5d54dceed5b'
  }
];

// ---- объявления, которые ОСТАЛИСЬ в ядре (S3) ----------------------------------------
const KERNEL_KEPT = [
  '  var originalFetch = window.fetch;',
  '  var OriginalXHR = window.XMLHttpRequest;',
  '  var originalXHROpen = OriginalXHR ? OriginalXHR.prototype.open : null;',
  '  var originalXHRSend = OriginalXHR ? OriginalXHR.prototype.send : null;',
  '  var lastAuthHeaders = {};',
  "  var lastLoadedConvId = '';",
  "  var lastHistoryUrl = '';          // v6: URL последнего history-запроса для дозапроса при усечении",
  "  var sseUserPrompt = '';",
  '  var sseParentMessageId = null;',
  '  var sseThinkingEnabled = null;'
];

// Уникальные строки тел: их НЕ должно остаться в ядре (форвардеров у D.7 нет).
const BODY_MARKERS = [
  '  // ===== СЕКЦИЯ 11: ПЕРЕХВАТ FETCH (v5: тихий catch + устранение висячих Promise.reject) =====',
  '  // ===== СЕКЦИЯ 12: ПЕРЕХВАТ XHR (зеркалит fetch, +setRequestHeader-копилка) =====',
  '      promise.catch(function () { /* тихо: снимаем ложный unhandled для чужих прерванных запросов */ });',
  "      var isHistory = (url.indexOf('history_messages') !== -1);",
  '    var originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;',
  '    OriginalXHR.prototype.send = function (body) {',
  "          if (loadUrl.indexOf('client/settings') !== -1) {"
];

// ---- объявления/вызовы, которые обязаны остаться в ядре (S2/S3) ----------------------
const KERNEL_CALLS = [
  '      ingestHistory: ingestHistory,',
  '      consumeSseResponse: consumeSseResponse,',
  '      get originalFetch() { return originalFetch; }'
];

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/** Блок K9 из исходника: срез от start-якоря до следующего end-якоря. */
function blockOf(src, b) {
  const s = src.indexOf(b.start);
  expect(s).toBeGreaterThan(-1);
  const e = src.indexOf(b.end, s + b.start.length);
  expect(e).toBeGreaterThan(s);
  return src.slice(s, e);
}

// ---- разбор литерала __bind ядра (единственный источник правды для стенда) ----------
function kernelBindKinds() {
  const start = KERNEL_SRC.lastIndexOf('aiCmDeepseekNet.__bind({');
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

// ---- стенд vm: песочница с window/XMLHttpRequest -------------------------------------
function makeSandbox() {
  const logs = [];
  const calls = { opened: 0, sent: 0, headers: 0 };
  function FakeXHR() { this.__listeners = {}; this.status = 0; this.responseText = ''; }
  FakeXHR.prototype.open = function () {
    calls.opened++;
    this.__openArgs = [].slice.call(arguments);
  };
  FakeXHR.prototype.send = function () {
    calls.sent++;
    this.__sent = true;
  };
  FakeXHR.prototype.setRequestHeader = function (name, value) {
    calls.headers++;
    this.__hdr = this.__hdr || {};
    this.__hdr[name] = value;
  };
  FakeXHR.prototype.addEventListener = function (name, fn) {
    (this.__listeners[name] = this.__listeners[name] || []).push(fn);
  };
  FakeXHR.prototype.fire = function (name) {
    (this.__listeners[name] || []).forEach(function (fn) { fn.call(this, {}); }, this);
  };
  const sandbox = {
    console: {
      log: function () { logs.push([].join.call(arguments, ' ')); },
      warn: function () { logs.push('WARN ' + [].join.call(arguments, ' ')); },
      error: function () { logs.push('ERR ' + [].join.call(arguments, ' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise, Date: Date,
    setTimeout: function () { return 0; }, clearTimeout: function () { },
    XMLHttpRequest: FakeXHR,
    location: { pathname: '/a/chat/s/convNet', origin: 'https://chat.deepseek.com' },
    CustomEvent: function (name, init) { this.type = name; this.detail = init && init.detail; }
  };
  sandbox.window = sandbox;
  // «страничный» fetch ДО связки: тело кластера обязано подменить ровно его
  sandbox.fetch = function pageFetch() { throw new Error('page fetch must be replaced by the wrapper'); };
  sandbox.__xhr = calls;
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs, calls: calls };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-net.js' });
}

/** Ответ сервера истории в формате DeepSeek (полная цепочка / пустая MERGE-база). */
function historyBody(emptyMerge) {
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'm1', model_type: 'default', is_empty: emptyMerge ? undefined : false },
        chat_messages: emptyMerge ? [] : [
          { message_id: 'm1', parent_id: null, role: 'USER', fragments: [{ type: 'REQUEST', content: 'вопрос' }] }
        ]
      }
    }
  };
}

function fakeResponse(jsonBody, text) {
  return {
    ok: true,
    clone: function () {
      return {
        json: function () { return Promise.resolve(jsonBody); },
        text: function () { return Promise.resolve(text || ''); }
      };
    }
  };
}

/** Полный набор зависимостей ядра: живые rw/ro + fn-счётчики (S2/S4). */
function makeProbe(box, over) {
  const st = {
    lastAuthHeaders: {},
    lastHistoryUrl: '',
    lastLoadedConvId: '',
    sseUserPrompt: '',
    sseParentMessageId: null,
    sseThinkingEnabled: null,
    originalFetch: function (input, init) {
      st.__fetchCalls.push({ url: String(typeof input === 'string' ? input : (input && input.url) || ''), init: init });
      return Promise.resolve(fakeResponse(st.__fetchBody, st.__fetchText));
    },
    OriginalXHR: box.sandbox.XMLHttpRequest,
    originalXHROpen: box.sandbox.XMLHttpRequest.prototype.open,
    originalXHRSend: box.sandbox.XMLHttpRequest.prototype.send,
    currentConvId: 'convNet',
    __fetchCalls: [], __fetchBody: null, __fetchText: '', __guard: true
  };
  if (over) Object.keys(over).forEach(function (k) { st[k] = over[k]; });
  const writes = {};
  const reads = {};
  const calls = {
    collectHeaders: 0, convIdFromHistoryUrl: 0, convIdFromCompletionBody: 0, guardCheck: 0,
    refetchFullHistory: 0, diagOn: 0, diagHistRecord: 0, ingestHistory: 0, parseSSE: 0,
    consumeSseResponse: 0, ingestModelSettings: 0,
    refetchArgs: [], ingestArgs: [], sseArgs: [], settingsArgs: [], marks: [], histRecords: []
  };
  const D = {};
  const fns = {
    collectHeaders: function (input, init) {
      calls.collectHeaders++;
      const h = (init && init.headers) || (input && input.headers) || {};
      return h;
    },
    convIdFromHistoryUrl: function (url) {
      calls.convIdFromHistoryUrl++;
      const m = /chat_session_id=([^&]+)/.exec(String(url || ''));
      return m ? m[1] : '';
    },
    convIdFromCompletionBody: function (bodyStr) {
      calls.convIdFromCompletionBody++;
      try { return JSON.parse(bodyStr).chat_session_id || ''; } catch (e) { return ''; }
    },
    guardCheck: function (reqConvId) { calls.guardCheck++; return st.__guard && !!reqConvId; },
    refetchFullHistory: function (url, authHeaders, convId) { calls.refetchFullHistory++; calls.refetchArgs.push([url, authHeaders, convId]); },
    diagOn: function () { calls.diagOn++; return true; },
    diagHistRecord: function (json, src) { calls.diagHistRecord++; calls.histRecords.push(src); },
    ingestHistory: function (json) { calls.ingestHistory++; calls.ingestArgs.push(json); },
    parseSSE: function (text) { calls.parseSSE++; calls.sseArgs.push(text); },
    consumeSseResponse: function (resp, convId) { calls.consumeSseResponse++; calls.sseArgs.push(convId); },
    ingestModelSettings: function (json) { calls.ingestModelSettings++; calls.settingsArgs.push(json); }
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
  return { D: D, st: st, writes: writes, reads: reads, calls: calls };
}

function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 40); i++) p = p.then(function () { });
  return p;
}

describe('Step D.7: core/deepseek-net.js — контракт модуля NETWORK', () => {
  test('S1: литерал __bind в ядре содержит ровно 22 имени (11 fn + 6 rw + 5 ro)', function () {
    expect(KINDS.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) { expect(KINDS.get(pair[0])).toBe(pair[1]); });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 11, ro: 5, rw: 6 });
    // каждая fn-передача — реально существующая в ядре функция (хойстится к моменту связки)
    FN_NAMES.forEach(function (n) { expect(KERNEL_SRC).toContain('function ' + n + '('); });
    // rw/ro-состояние реально объявлено в ядре (иначе сеттер писал бы в никуда,
    // а геттер читал бы НЕЯВНЫЙ ГЛОБАЛ — урок D.5 на lastDispatchSig/currentConvId)
    RW_NAMES.concat(RO_NAMES).forEach(function (n) {
      expect(KERNEL_SRC).toMatch(new RegExp('^ {2}var\\s+' + n + '\\s*=', 'm'));
    });
    // модуль не объявляет их заново: иначе появилась бы ВТОРАЯ переменная, и ядро
    // читало бы старую (копилка авторизации/URL и параметры потока терялись бы молча)
    RW_NAMES.concat(RO_NAMES).forEach(function (n) {
      expect(MODULE_SRC).not.toMatch(new RegExp('\\bvar\\s+' + n + '\\b'));
    });
    // тело ro-геттера — ровно чтение имени ядра; rw-пара — get + set
    const literal = KERNEL_SRC.slice(KERNEL_SRC.lastIndexOf('aiCmDeepseekNet.__bind({'),
      KERNEL_SRC.indexOf('});', KERNEL_SRC.lastIndexOf('aiCmDeepseekNet.__bind({')));
    RO_NAMES.forEach(function (n) {
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
    });
    RW_NAMES.forEach(function (n) {
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
      expect(literal).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });
    // K0 остался в ядре и по-прежнему экспортируется наружу (контрактный тест v13)
    expect(KERNEL_SRC).toContain('resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug');
    expect(KERNEL_SRC).toContain('function __aiCmDeepseekResolveModelSlug(signals) {');
    // ядро не зовёт ни одного тела K9: форвардеров у D.7 нет
    FN_NAMES.forEach(function (n) { expect(KERNEL_SRC).not.toContain('aiCmDeepseekNet.' + n + '('); });
  });

  test('S2: живая связка в vm — обёртки встают только после __bind, fetch не замыкается сам на себя', async function () {
    const box = makeSandbox();
    const fakeFetch = box.sandbox.fetch;
    const protoOpen = box.sandbox.XMLHttpRequest.prototype.open;
    const protoSend = box.sandbox.XMLHttpRequest.prototype.send;
    const protoHdr = box.sandbox.XMLHttpRequest.prototype.setRequestHeader;

    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekNet;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);
    // ДО связки обёрток нет: кластер ставит их телом при __bind, а не на загрузке модуля
    expect(box.sandbox.fetch).toBe(fakeFetch);
    expect(box.sandbox.XMLHttpRequest.prototype.open).toBe(protoOpen);
    expect(box.sandbox.XMLHttpRequest.prototype.send).toBe(protoSend);

    const probe = makeProbe(box);
    probe.st.__fetchBody = historyBody(false);
    Fn.__bind(probe.D);
    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());   // наружу — ничего
    expect(box.sandbox.fetch).not.toBe(fakeFetch);
    expect(box.sandbox.XMLHttpRequest.prototype.open).not.toBe(protoOpen);
    expect(box.sandbox.XMLHttpRequest.prototype.send).not.toBe(protoSend);
    expect(box.sandbox.XMLHttpRequest.prototype.setRequestHeader).not.toBe(protoHdr);

    // fetch-хук: обёртка ходит в originalFetch ядра РОВНО один раз (нет самозамыкания)
    await box.sandbox.fetch('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=convNet',
      { method: 'GET', headers: { Authorization: 'Bearer tok' } });
    await flush();
    expect(probe.st.__fetchCalls).toHaveLength(1);
    expect(probe.calls.collectHeaders).toBe(1);
    expect(probe.calls.convIdFromHistoryUrl).toBe(1);
    expect(probe.calls.guardCheck).toBeGreaterThan(0);
    expect(probe.calls.ingestHistory).toBe(1);
    expect(probe.st.lastAuthHeaders).toEqual({ Authorization: 'Bearer tok' });   // rw: запись в ЯДРО
    expect(probe.writes.lastAuthHeaders).toBe(1);
    expect(probe.st.lastHistoryUrl).toContain('chat_session_id=convNet');
    expect(probe.writes.lastHistoryUrl).toBe(1);
    expect(probe.reads.originalFetch).toBeGreaterThan(0);   // живой ro-аксессор, а не копия

    // повторная загрузка модуля не перетирает уже связанный API и не оборачивает дважды
    const wrapper = box.sandbox.fetch;
    loadModule(box);
    expect(box.sandbox.AiCmDeepseekNet).toBe(Fn);
    expect(box.sandbox.fetch).toBe(wrapper);
  });

  test('S3: тела K9 перенесены дословно (SHA-256 блоков); в ядре — надгробие и связка', function () {
    // Байтовая идентичность: SHA-256 каждого блока в модуле равен эталону с 9aca03a.
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      expect(sha256(body)).toBe(b.sha);
    });
    // зоны: заголовки СЕКЦИЙ 11/12 — ВНЕ with (D), оба тела — ВНУТРИ (иначе свободные
    // имена ядра не резолвятся: лексический скоуп объявления, урок D.5/D.1)
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
    // маркеры тел: живут в модуле, в ядре их нет (форвардеров у D.7 нет — тела уехали целиком)
    BODY_MARKERS.forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
      expect(KERNEL_SRC).not.toContain(l);
    });
    // надгробие на месте, заголовков секций 11/12 в ядре больше нет
    expect(KERNEL_SRC).toContain('// ===== Step D.7: K9 (NETWORK) вынесен в core/deepseek-net.js =====');
    expect(KERNEL_SRC).not.toContain('// ===== СЕКЦИЯ 11: ПЕРЕХВАТ FETCH');
    expect(KERNEL_SRC).not.toContain('// ===== СЕКЦИЯ 12: ПЕРЕХВАТ XHR');
    // К9 вырезан из ядра непрерывно: соседи (K8-надгробие D.3 и СЕКЦИЯ 14) не тронуты
    expect(KERNEL_SRC).toContain('// ===== Step D.3: K8 (REFETCH/URL-гигиена) вынесен в core/deepseek-refetch.js =====');
    expect(KERNEL_SRC).toContain('// ===== СЕКЦИЯ 14: ФИНАЛ =====');
    // объявления-оригиналы и состояние копилок ОСТАЛИСЬ в ядре
    KERNEL_KEPT.forEach(function (line) {
      expect(KERNEL_SRC).toContain(line);
      expect(MODULE_SRC).not.toContain(line);
    });
    // связка D.7 — последняя в IIFE и читает window.AiCmDeepseekNet до __bind
    const iifeEnd = KERNEL_SRC.lastIndexOf('\n})();');
    const netBindAt = KERNEL_SRC.lastIndexOf('aiCmDeepseekNet.__bind({');
    const emitBindAt = KERNEL_SRC.indexOf('aiCmDeepseekEmit.__bind({');
    expect(netBindAt).toBeGreaterThan(0);
    expect(netBindAt).toBeLessThan(iifeEnd);
    expect(emitBindAt).toBeLessThan(netBindAt);
    expect(KERNEL_SRC).toContain("var aiCmDeepseekNet = (typeof window !== 'undefined' && window.AiCmDeepseekNet) || null;");
    // связка стоит ПОСЛЕ захвата originalFetch (иначе обёртка замкнулась бы сама на себя)
    expect(KERNEL_SRC.indexOf('var originalFetch = window.fetch;')).toBeLessThan(netBindAt);
    KERNEL_CALLS.forEach(function (l) { expect(KERNEL_SRC).toContain(l); });
    // префиксов D. в телах модуля нет (with (D), ES3 Annex B)
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // размеры: K9 уехал целиком (ядро ушло ниже 1900 строк, модуль — за 280)
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(1900);
    expect(MODULE_SRC.split('\n').length).toBeGreaterThan(280);
  });

  test('S4: fetch-хук и XHR-хук — живая семантика (история, MERGE, стрим, settings)', async function () {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekNet;
    const probe = makeProbe(box);
    Fn.__bind(probe.D);
    const base = 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=convNet';

    // ---- 1. fetch: полная история → guardCheck + ingestHistory, копилки записаны ----
    probe.st.__fetchBody = historyBody(false);
    await box.sandbox.fetch(base, { headers: { Authorization: 'Bearer f' } });
    await flush();
    expect(probe.calls.ingestHistory).toBe(1);
    expect(probe.calls.diagHistRecord).toBe(0);          // пустая MERGE-ветка не сработала
    expect(probe.calls.refetchFullHistory).toBe(0);
    expect(probe.calls.consumeSseResponse).toBe(0);

    // ---- 2. fetch: пустая база при is_empty!==true → MERGE-дозапрос ----
    probe.st.__fetchBody = historyBody(true);
    await box.sandbox.fetch(base, { headers: { Authorization: 'Bearer f' } });
    await flush();
    expect(probe.calls.refetchFullHistory).toBe(1);
    expect(probe.calls.ingestHistory).toBe(1);            // ingest не вызывался: ушёл дозапрос
    expect(probe.calls.refetchArgs[0][2]).toBe('convNet');                 // convId из URL
    expect(probe.calls.refetchArgs[0][1]).toEqual({ Authorization: 'Bearer f' });
    expect(probe.st.lastLoadedConvId).toBe('convNet');                     // rw: «ответ текущего чата обработан»
    expect(probe.writes.lastLoadedConvId).toBe(1);
    expect(probe.calls.diagHistRecord).toBe(1);
    expect(probe.calls.histRecords).toEqual(['fetch-history:emptyMERGE']);

    // ---- 3. fetch: чужой чат (guardCheck=false) → конвейер не запускается ----
    probe.st.__guard = false;
    await box.sandbox.fetch(base, { headers: {} });
    await flush();
    expect(probe.calls.refetchFullHistory).toBe(1);
    expect(probe.calls.ingestHistory).toBe(1);
    probe.st.__guard = true;

    // ---- 4. fetch: completion POST → параметры потока и стрим ----
    probe.st.__fetchBody = {};
    await box.sandbox.fetch('https://chat.deepseek.com/api/v0/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Вопрос', parent_message_id: 'pm9', thinking_enabled: true, chat_session_id: 'convNet' })
    });
    await flush();
    expect(probe.st.sseUserPrompt).toBe('Вопрос');
    expect(probe.st.sseParentMessageId).toBe('pm9');
    expect(probe.st.sseThinkingEnabled).toBe(true);
    expect(probe.writes.sseUserPrompt).toBe(1);
    expect(probe.writes.sseParentMessageId).toBe(1);
    expect(probe.writes.sseThinkingEnabled).toBe(1);
    // fetch-ветка читает convId прямо из payload (convIdFromCompletionBody — путь XHR)
    expect(probe.calls.consumeSseResponse).toBe(1);

    // ---- 5. fetch: settings → ingestModelSettings (тихий разбор, только чтение) ----
    probe.st.__fetchBody = { data: { biz_data: { settings: { model_configs: { value: [{ name: 'Instant', model_type: 'default' }] } } } } };
    await box.sandbox.fetch('https://chat.deepseek.com/api/v0/client/settings?scope=model', {});
    await flush();
    expect(probe.calls.ingestModelSettings).toBe(1);

    // ---- 6. XHR: setRequestHeader-копилка + completion ----
    const XHR = box.sandbox.XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completions');
    xhr.setRequestHeader('Authorization', 'Bearer xhr');
    xhr.send(JSON.stringify({ prompt: 'Из XHR', parent_message_id: 'pmX', thinking_enabled: false, chat_session_id: 'convNet' }));
    expect(box.calls.opened).toBe(1);                     // оригинальный open вызван
    expect(box.calls.sent).toBe(1);                       // оригинальный send вызван
    expect(box.calls.headers).toBe(1);
    expect(probe.st.lastAuthHeaders).toEqual({ Authorization: 'Bearer xhr' });
    expect(probe.st.sseUserPrompt).toBe('Из XHR');
    expect(probe.st.sseParentMessageId).toBe('pmX');
    expect(probe.st.sseThinkingEnabled).toBe(false);
    expect(probe.calls.convIdFromCompletionBody).toBe(1);   // XHR-ветка парсит тело сама
    xhr.status = 200;
    xhr.responseText = 'data: {"v":1}';
    xhr.fire('load');
    expect(probe.calls.parseSSE).toBe(1);
    expect(probe.calls.sseArgs).toContain('data: {"v":1}');

    // ---- 7. XHR: история → ingestHistory + lastHistoryUrl; MERGE-ветка с дозапросом ----
    const xhr2 = new XHR();
    xhr2.open('GET', base + '&cache_version=7');
    xhr2.send();
    expect(probe.st.lastHistoryUrl).toContain('cache_version=7');
    xhr2.status = 200;
    xhr2.responseText = JSON.stringify(historyBody(false));
    xhr2.fire('load');
    expect(probe.calls.ingestHistory).toBe(2);
    expect(probe.calls.histRecords).toEqual(['fetch-history:emptyMERGE']);

    const xhr3 = new XHR();
    xhr3.open('GET', base);
    xhr3.send();
    xhr3.status = 200;
    xhr3.responseText = JSON.stringify(historyBody(true));
    xhr3.fire('load');
    expect(probe.calls.refetchFullHistory).toBe(2);
    expect(probe.calls.refetchArgs[1][2]).toBe('convNet');
    expect(probe.calls.histRecords).toEqual(['fetch-history:emptyMERGE', 'xhr-history:emptyMERGE']);

    // ---- 8. XHR: settings → ingestModelSettings; не-2xx и пустое тело игнорируются ----
    const xhr4 = new XHR();
    xhr4.open('GET', 'https://chat.deepseek.com/api/v0/client/settings?scope=model');
    xhr4.send();
    xhr4.status = 500;
    xhr4.responseText = '{"data":{}}';
    xhr4.fire('load');
    expect(probe.calls.ingestModelSettings).toBe(1);
    xhr4.status = 200;
    xhr4.responseText = '';
    xhr4.fire('load');
    expect(probe.calls.ingestModelSettings).toBe(1);
    xhr4.status = 200;
    xhr4.responseText = '{"data":{}}';
    xhr4.fire('load');
    expect(probe.calls.ingestModelSettings).toBe(2);

    // ---- 9. XHR без open: send уходит в оригинал, копилки не трогаются ----
    const xhr5 = new XHR();
    const writesBefore = JSON.stringify(probe.writes);
    xhr5.send();
    expect(box.calls.sent).toBe(5);
    expect(JSON.stringify(probe.writes)).toBe(writesBefore);
  });

  test('S5: проводка — js[] после emit и перед ядром, id -v11 + unregister -v10, helper', function () {
    // модуль строго перед ядром и строго после emit
    expect(DS.SOURCES.indexOf('core/deepseek-net.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
    expect(DS.SOURCES.indexOf('core/deepseek-emit.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-net.js'));
    expect(DS.MODULES).toContain('core/deepseek-net.js');
    // регистрация ядра: id -v11, снятие -v10, js[] с модулем, лог (v11)
    expect(KERNEL_SRC).toContain('aiCmDeepseekNet');
    const bg = DS.readSource('core/background.js');
    expect(bg).toContain("js: ['utils/debug.js', 'core/deepseek-diag.js', 'core/deepseek-netsync.js', 'core/deepseek-refetch.js', 'core/deepseek-parse.js', 'core/deepseek-conv.js', 'core/deepseek-emit.js', 'core/deepseek-net.js', 'core/deepseek-ingest.js', 'core/deepseek-sse.js', 'core/deepseek-intercept.js']");
    expect(bg).toContain("ids.indexOf('ai-cm-deepseek-intercept-v11') === -1");
    expect(bg).toContain("unregisterContentScripts({ ids: ['ai-cm-deepseek-intercept-v10'] })");
    expect(bg).toContain('перехватчик DeepSeek v11 зарегистрирован');
    // release.yml: счётчик MAIN-world файлов равен факту (33 = 5 бандлов + 28 модулей/ядер)
    const yml = DS.readSource('.github/workflows/release.yml');
    expect((yml.match(/35 MAIN-world/g) || [])).toHaveLength(2);
    expect(yml).not.toContain('34 MAIN-world');
    // модуль: UTF-8 без BOM, LF, хвостовой \n; каркас
    const buf = require('fs').readFileSync(require('path').join(DS.ROOT, 'core/deepseek-net.js'));
    expect(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF).toBe(false);
    expect(MODULE_SRC.indexOf('\r')).toBe(-1);
    expect(MODULE_SRC.endsWith('\n')).toBe(true);
    ['window.AiCmDeepseekNet = Fn;', 'Fn.__bind = __bind;', 'module.exports = Fn;'].forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
    });
    // гард повторной загрузки модуля (как у D.1-D.6)
    expect(MODULE_SRC).toContain('if (typeof window !== \'undefined\' && window.AiCmDeepseekNet) return;');
  });
});
