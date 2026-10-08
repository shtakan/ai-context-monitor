/**
 * Step D.2 (декомпозиция core/deepseek-intercept.js): контракт модуля сетевого дозапроса.
 *
 * Кластер СЕКЦИИ 9C (O-18, фаза 2: liveTurnRecord / netSyncNeeded / exportComposeTurns /
 * applyExportNetSnapshot / exportNetSync + мост 'ai-cm-deepseek-net-sync') уехал в
 * core/deepseek-netsync.js. Модуль и ядро — РАЗНЫЕ IIFE одного registerContentScripts-
 * пакета (js[]: utils/debug.js -> deepseek-diag.js -> deepseek-netsync.js ->
 * deepseek-intercept.js), поэтому связь идёт ровно через один контракт:
 *
 *   ядро -> модуль: window.AiCmDeepseekNetsync.__bind(deps)
 *     fn (значением): функции ядра, которые зовут тела модуля;
 *     rw (get+set):   живое состояние, которое модуль ПЕРЕЗАПИСЫВАЕТ;
 *     ro (get):       живое состояние только на чтение.
 *   модуль -> ядро: Fn.<fn> после __bind; ядро раздаёт 2 из них форвардерами
 *   (liveTurnRecord в finishSseStream, netSyncNeeded в связке диагностики D.1).
 *
 * Здесь пинятся:
 *   S1. Полнота контракта: литерал __bind в ядре содержит ровно 26 имён (8 fn + 9 rw +
 *       9 ro) — ни одного потерянного; каждый rw — именно пара get+set.
 *   S2. Живая связка в vm: до __bind наружу торчит ТОЛЬКО __bind (мост ещё не поднят);
 *       после — все 5 функций, мост 'ai-cm-deepseek-net-sync' зарегистрирован ровно
 *       один раз, а повторная загрузка модуля не перетирает уже связанный API.
 *   S3. Байтовая идентичность тел: блоки K7 (строки 1590-1800 HEAD, кроме состояния
 *       ядра 1598-1602/1604) лежат в модуле ДОСЛОВНО (SHA-256 каждого блока снят с
 *       1e306c0 и зафиксирован здесь — git-история сьютом не читается, CI shallow);
 *       в ядре от K7 остались только надгробие, общие переменные состояния и
 *       2 форвардера.
 *   S4. rw-семантика: orderCounter/ingestMode/exportSyncTruncated пишутся в ЯДРО через
 *       сеттеры (без них `orderCounter++` молча терялся бы — sloppy), а объекты
 *       состояния (liveTurns/liveTurnOrder/netSyncStats) — те же, что у ядра.
 *   S5. Байнд fetch-контекста (FIX-NETSYNC-FETCH-BINDING): единственная точка вызова
 *       дозапроса зовёт originalFetch с this === window. Мок window.fetch ставится
 *       Object.defineProperty и объявлен STRICT — вызов с чужим this (в K7 это with-объект
 *       D, в ядре — вообще undefined) бросает Illegal invocation ровно как встроенный
 *       fetch браузера, поэтому пин ловит регресс без живого браузера. Путь ОСОБО
 *       коварен: вызов обёрнут в try/catch, поэтому дефект не бросает наружу, а молча
 *       уходит в фолбэк reason='fetch-throw' (сетевой дозапрос не уходит никогда,
 *       netSyncStats.failed растёт) — пин проверяет не «нет исключения», а факт дохода
 *       вызова с правильным this.
 */

const vm = require('vm');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-netsync.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 26 имён -------------------------------------------------
const CONTRACT = [
  // fn: функции ядра, вызываемые телами модуля (4 — форвардеры диагностики D.1)
  ['diagMark', 'fn'],
  ['diagOn', 'fn'],
  ['diagHistRecord', 'fn'],
  ['diagVerdict', 'fn'],
  ['emitBaseSnapshot', 'fn'],
  ['ingestHistory', 'fn'],
  ['historyRefetchUrl', 'fn'],
  ['getConvId', 'fn'],
  // rw: модуль перезаписывает эти имена (get + set обязателен)
  ['liveTurns', 'rw'],
  ['liveTurnOrder', 'rw'],
  ['netSnapshotAt', 'rw'],
  ['netTurnIds', 'rw'],
  ['lastTurnDoneAt', 'rw'],
  ['netSyncStats', 'rw'],
  ['orderCounter', 'rw'],
  ['ingestMode', 'rw'],
  ['exportSyncTruncated', 'rw'],
  // ro: только чтение
  ['currentConvId', 'ro'],
  ['turnsMap', 'ro'],
  ['histCompletion', 'ro'],
  ['lastAuthHeaders', 'ro'],
  ['lastBaseServerTokens', 'ro'],
  ['sseRealtimeFinalTokens', 'ro'],
  ['sseModelType', 'ro'],
  ['lastBaseChatMode', 'ro'],
  ['originalFetch', 'ro']
];

// ---- что модуль отдаёт наружу после __bind (S2) -------------------------------------
const EXPORTS = ['liveTurnRecord', 'netSyncNeeded', 'exportComposeTurns',
  'applyExportNetSnapshot', 'exportNetSync'];

// ---- что ядро зовёт по прежним именам (форвардеры) ----------------------------------
const FORWARDERS = ['liveTurnRecord', 'netSyncNeeded'];

// ---- блоки K7, перенесённые в модуль дословно (S3) ----------------------------------
// Эталон — SHA-256 блока в core/deepseek-intercept.js на 1e306c0 (HEAD момента D.2),
// строки 1590-1800. Хэши сняты с git-блоба и ЗАФИКСИРОВАНЫ здесь: сьют не читает
// git-историю (CI клонирует shallow), поэтому байтовая идентичность против базы
// доказывается двумя независимыми способами — этими пинами (текущий модуль) и
// tools/verify-deepseek-netsync.js (дословное сравнение с git show, локально).
// FIX-NETSYNC-FETCH-BINDING: у блока exportNetSync пин обновлён под хотфикс
// (`originalFetch.call(window, …`); Step E.2a.1 (swallow): пины liveTurnRecord,
// exportComposeTurns, exportNetSync и bridge обновлены под инструментирование молчаливых
// catch — 4 расхождения с 1e306c0, каждое ровно в одной строке `catch` (см. записи блоков
// ниже); остальные 4 пина по-прежнему байт-в-байт равны базовым.
// Блоки вырезаются из модуля по якорям: комментарий-заголовок + тело функции.
const MOVED_BLOCKS = [
  // {name, mode: 'range'|'line'|'func', start, end|sig, sha}
  {
    name: 'NET_SYNC_TIMEOUT_DEFAULT', mode: 'range', start: '  // ===== СЕКЦИЯ 9C',
    end: '  var NET_SYNC_TIMEOUT_DEFAULT = 3000;',
    sha: 'bb3cb7afbf3291e6c64240188fac8ab24b1e64146f03e0244f0eec94113f9597'
  },
  {
    name: 'netSyncSeq', mode: 'line', start: '  var netSyncSeq = 0;',
    sha: 'dbea81badef23defe8909ecf0569031b48e95a6c3644e825a574b100e84008e1'
  },
  {
    // Step E.2a.1 (swallow): молчаливый catch записи live-текста хода (строка 88) стал
    // диагностируемым — `swallow(e, 'deepseek:liveTurnRecord')`. Расхождение с 1e306c0 ровно
    // в этой одной строке, тело функции и порядок веток не менялись.
    name: 'liveTurnRecord', mode: 'func', start: '  // LIVE-текст хода:',
    sig: '  function liveTurnRecord(id, role, text, answer, reasoning, modelSlug) {',
    sha: 'ad12ecb2091b1fd440325de2b740e4c177f6a49b45340a4d53a077bf66e08850'
  },
  {
    name: 'netSyncNeeded', mode: 'func', start: '  // Нужен ли сетевой дозапрос:',
    sig: '  function netSyncNeeded() {',
    sha: 'b34ceb65de2712e7516a79374a98e6f40b5d0e12270d23a4b72ee4b0a78f6ea9'
  },
  {
    // Step E.2a.1 (swallow): молчаливый catch композиции ходов (строка 140) стал
    // диагностируемым — `swallow(e, 'deepseek:exportComposeTurns')`; расхождение с 1e306c0
    // ровно в этой одной строке, порядок вердиктов и веток не менялся.
    name: 'exportComposeTurns', mode: 'func', start: '  // Per-turn выбор текста:',
    sig: '  function exportComposeTurns() {',
    sha: 'c0e8d19dbec8e9aed747b095279e9e27b657e568791b48bb2efa9fc0e8ff2f1e'
  },
  {
    name: 'applyExportNetSnapshot', mode: 'func', start: '  // Приёмка сетевого снимка в режиме экспорта:',
    sig: '  function applyExportNetSnapshot(json, convId) {',
    sha: 'c043516337f911a62bc6b16d75e2ffe9423f50dc40fa4e1f1511c431a2bc3552'
  },
  {
    // FIX-NETSYNC-FETCH-BINDING (хотфикс после D.8): вызов дозапроса стал
    // `originalFetch.call(window, url, {` вместо `originalFetch(url, {` (встроенный
    // window.fetch требует this === window, иначе TypeError: Illegal invocation — тот же
    // класс, что FIX-REFETCH-FETCH-BINDING в K8, аппендикс v49, и
    // FIX-PAGINATION-FETCH-BINDING, аппендикс v26).
    // Step E.2a.1 (swallow): плюс молчаливый catch ответа моста (строка 224) стал
    // диагностируемым — `swallow(eD, 'deepseek:exportNetSync-reply')`.
    name: 'exportNetSync', mode: 'func', start: '  function exportNetSync(requestId, convId, timeoutMs) {',
    sig: '  function exportNetSync(requestId, convId, timeoutMs) {',
    sha: 'e77781ccf0db225c5636a96c26ef1b06fa3a9f9ecf5e493771f776bb9a6c4303'
  },
  {
    // Step E.2a.1 (swallow): молчаливый catch тела слушателя моста (строка 266) стал
    // диагностируемым — `swallow(eNs, 'deepseek:netSyncBridge')`; сам мост, порядок
    // слушателей и таймаут не менялись.
    name: 'bridge', mode: 'range', start: "  try {\n    window.addEventListener('ai-cm-deepseek-net-sync'",
    end: '  } catch (eNetBridge) { }',
    sha: 'aa0cae309fcdaef74f06b4861356141313d8c16c25bb6d76ba1e950aad9f9de4'
  }
];

// ---- состояние K7, которое ОСТАЛОСЬ в ядре (его читают/пишут K5/K6 и диагностика) ----
const KERNEL_KEPT = [
  '  var liveTurns = {};          // v12: LIVE-текст ходов (SSE) — переживает приёмку сети',
  '  var liveTurnOrder = [];',
  '  var netSnapshotAt = 0;       // время приёмки авторитетного сетевого снимка',
  '  var netTurnIds = {};         // какие ходы пришли ИЗ СЕТИ (последний принятый снимок)',
  '  var lastTurnDoneAt = 0;      // время последнего завершённого хода (финализация потока)',
  '  var netSyncStats = { calls: 0, fetched: 0, ok: 0, fresh: 0, empty: 0, failed: 0, timeout: 0, oneSide: 0 };'
];

function sha256(s) { return require('crypto').createHash('sha256').update(s, 'utf8').digest('hex'); }

/** Конец описания функции: индекс сразу за закрывающей скобкой тела. */
function braceEnd(src, sigAt) {
  let depth = 0;
  for (let i = src.indexOf('{', sigAt); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced declaration');
}

/** Блок K7 из исходника: 'line' — строка, 'range' — до end-якоря, 'func' — до конца тела. */
function blockOf(src, b) {
  const s = src.indexOf(b.start);
  expect(s).toBeGreaterThan(-1);
  if (b.mode === 'line') return src.slice(s, s + b.start.length);
  if (b.mode === 'func') {
    const f = src.indexOf(b.sig, s);
    expect(f).toBeGreaterThan(-1);
    return src.slice(s, braceEnd(src, f));
  }
  const e = src.indexOf(b.end, s);
  expect(e).toBeGreaterThan(-1);
  return src.slice(s, e + b.end.length);
}

// ---- разбор литерала __bind ядра (единственный источник правды для стенда) ----------
// Стенд обязан повторять РЕАЛЬНЫЙ контракт ядра, а не список из этого файла: иначе
// пропавший сеттер (ro вместо rw) не сломал бы S4 — проба навесила бы свой.
function kernelBindKinds() {
  const start = KERNEL_SRC.indexOf('aiCmDeepseekNetsync.__bind({');
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

// ---- стенд vm: песочница со всеми глобусами, которые зовут тела модуля --------------
function makeSandbox() {
  const logs = [];
  const listeners = {};
  const sandbox = {
    console: {
      log: function () { logs.push(Array.prototype.map.call(arguments, String).join(' ')); },
      warn: function () { logs.push('WARN ' + Array.prototype.map.call(arguments, String).join(' ')); },
      error: function () { logs.push('ERR ' + Array.prototype.map.call(arguments, String).join(' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise, Date: Date,
    setTimeout: setTimeout, clearTimeout: clearTimeout, CustomEvent: function (n, o) { this.type = n; this.detail = (o || {}).detail; },
    addEventListener: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    dispatchEvent: function () { return true; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs, listeners: listeners };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-netsync.js' });
}

// ---- probe-ядро: живое состояние + счётчики обращений к аксессорам -------------------
function makeProbe(over) {
  const st = {
    liveTurns: {}, liveTurnOrder: [], netSnapshotAt: 0, netTurnIds: {}, lastTurnDoneAt: 0,
    netSyncStats: { calls: 0, fetched: 0, ok: 0, fresh: 0, empty: 0, failed: 0, timeout: 0, oneSide: 0 },
    orderCounter: 7, ingestMode: '', exportSyncTruncated: false,
    currentConvId: 'conv12345678', turnsMap: {},
    histCompletion: { historyComplete: true, reachedRoot: true, baseEmpty: false },
    lastAuthHeaders: { authorization: 'Bearer x' }, lastBaseServerTokens: 0,
    sseRealtimeFinalTokens: 0, sseModelType: null, lastBaseChatMode: '', originalFetch: null
  };
  if (over) Object.keys(over).forEach(function (k) { st[k] = over[k]; });
  const reads = {};
  const calls = { mark: 0, hist: 0, emit: 0, ingest: 0, fetchUrl: 0, conv: 0, verdict: 0, on: 0 };
  const D = {
    diagMark: function () { calls.mark++; },
    diagOn: function () { calls.on++; return false; },
    diagHistRecord: function () { calls.hist++; },
    diagVerdict: function (lt, nt) { calls.verdict++; return { verdict: String(lt) === String(nt) ? 'EQUAL' : 'TAIL-CUT' }; },
    emitBaseSnapshot: function () { calls.emit++; },
    ingestHistory: function (json) {
      calls.ingest++;
      // как ядро: снимок сети принят → netSnapshotAt/netTurnIds + ходы в turnsMap
      const msgs = json.data.biz_data.chat_messages;
      st.netSnapshotAt = 1000;
      st.netTurnIds = {};
      msgs.forEach(function (m) {
        st.netTurnIds[String(m.message_id)] = 1;
        st.turnsMap[String(m.message_id)] = {
          text: m.fragments[0].content, answer: '', reasoning: '', order: st.orderCounter++,
          ts: 1, role: m.role === 'USER' ? 'user' : 'assistant'
        };
      });
      if (json.truncated) st.exportSyncTruncated = true;   // режим export-sync: усечение
    },
    historyRefetchUrl: function () { calls.fetchUrl++; return 'https://x/api/v0/chat/history_messages?chat_session_id=' + st.currentConvId; },
    getConvId: function () { calls.conv++; return st.currentConvId; }
  };
  CONTRACT.forEach(function (pair) {
    const name = pair[0];
    if (pair[1] === 'ro') {
      Object.defineProperty(D, name, {
        get: function () { reads[name] = (reads[name] || 0) + 1; return st[name]; }, enumerable: true
      });
      return;
    }
    if (pair[1] === 'rw') {
      // сеттер навешивается ТОЛЬКО если он есть в литерале ядра (rw) — иначе поведение
      // как у getter-only аксессора: sloppy-запись молча теряется (см. kernelBindKinds)
      const desc = {
        get: function () { reads[name] = (reads[name] || 0) + 1; return st[name]; },
        enumerable: true
      };
      if (KINDS.get(name) === 'rw') {
        desc.set = function (v) { reads[name + ':set'] = (reads[name + ':set'] || 0) + 1; st[name] = v; };
      }
      Object.defineProperty(D, name, desc);
    }
  });
  return { D: D, st: st, reads: reads, calls: calls };
}

const KINDS = kernelBindKinds();

/** Дренаж микротасков: exportNetSync завершает приёмку сетевого снимка в .then(). */
function flush() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

describe('Step D.2: core/deepseek-netsync.js — контракт модуля сетевого дозапроса', () => {
  test('S1: литерал __bind в ядре содержит ровно 26 имён (8 fn + 9 rw + 9 ro)', () => {
    // полное совпадение состава и видов — ни одного потерянного/лишнего имени
    expect(KINDS.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) {
      expect(KINDS.get(pair[0])).toBe(pair[1]);
    });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 8, ro: 9, rw: 9 });
    // каждая передача — реально существующее в ядре имя (fn — функция, ro/rw — переменная)
    CONTRACT.forEach(function (pair) {
      if (pair[1] === 'fn') expect(KERNEL_SRC).toContain('function ' + pair[0] + '(');
      else expect(new RegExp('var\\s+' + pair[0] + '\\b').test(KERNEL_SRC)).toBe(true);
    });
  });

  test('S2: живая связка в vm — до __bind наружу только __bind, после — 5 функций и мост', () => {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekNetsync;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);
    // мост поднимается ИМЕННО на связке (внутри with(D)), а не на загрузке модуля
    expect(box.listeners['ai-cm-deepseek-net-sync']).toBeUndefined();

    const probe = makeProbe();
    Fn.__bind(probe.D);

    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());
    EXPORTS.forEach(function (n) { expect(typeof Fn[n]).toBe('function'); });
    expect(box.listeners['ai-cm-deepseek-net-sync']).toHaveLength(1);
    // повторная загрузка модуля не перетирает уже связанный API
    loadModule(box);
    expect(box.sandbox.AiCmDeepseekNetsync).toBe(Fn);
  });

  test('S3: тела K7 перенесены дословно (SHA-256 блоков); в ядре — состояние, надгробие, 2 форвардера', () => {
    // Байтовая идентичность: SHA-256 каждого блока в модуле равен эталону с 1e306c0.
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      expect(sha256(body)).toBe(b.sha);
    });
    // состояние дозапроса осталось в ядре (его читают/пишут K5/K6 и диагностика) и
    // при этом объявлено ровно один раз — копий в модуле нет (иначе разошлись бы)
    KERNEL_KEPT.forEach(function (line) {
      expect(KERNEL_SRC).toContain(line);
      expect(MODULE_SRC).not.toContain(line);
    });
    // тел K7 в ядре больше нет
    ['function exportComposeTurns() {', 'function applyExportNetSnapshot(json, convId) {',
      'function exportNetSync(requestId, convId, timeoutMs) {',
      "window.addEventListener('ai-cm-deepseek-net-sync'",
      'var NET_SYNC_TIMEOUT_DEFAULT = 3000;', 'var netSyncSeq = 0;'].forEach(function (l) {
      expect(KERNEL_SRC).not.toContain(l);
    });
    // форвардеры — function declaration (хойстятся: вызовы выше по файлу видят имя)
    FORWARDERS.forEach(function (n) {
      expect(KERNEL_SRC).toContain('function ' + n + '(');
      expect(KERNEL_SRC).toContain('aiCmDeepseekNetsync.' + n + '(');
    });
    // вызовы в ядре не сдвинуты: liveTurnRecord — в finishSseStream, netSyncNeeded — в diag-связке
    expect(KERNEL_SRC).toContain("liveTurnRecord(String(sseRequestMessageId), 'user', sseUserPrompt, sseUserPrompt, '', '');");
    expect(KERNEL_SRC).toContain('netSyncNeeded: netSyncNeeded,');
    // префиксов D. в телах модуля нет (with (D), ES3 Annex B)
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // состав js[]: модуль строго перед ядром, диагностика — перед ним
    expect(DS.SOURCES.indexOf('core/deepseek-netsync.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
    expect(DS.SOURCES.indexOf('core/deepseek-diag.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-netsync.js'));
    // размеры: K7 уехал целиком (ядро ушло ниже 2250 строк, модуль — за 250)
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(2250);
    expect(MODULE_SRC.split('\n').length).toBeGreaterThan(250);
  });

  test('S4: rw-семантика — запись в ЯДРО, а не в копию (orderCounter, ingestMode, состояние)', () => {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekNetsync;
    const probe = makeProbe();
    Fn.__bind(probe.D);

    // liveTurnRecord пишет в liveTurns/liveTurnOrder ЯДРА (объекты те же, не копии)
    Fn.liveTurnRecord('u1', 'user', 'вопрос', 'вопрос', '', 'deepseek-v3');
    expect(Object.keys(probe.st.liveTurns)).toEqual(['u1']);
    expect(probe.st.liveTurns.u1.text).toBe('вопрос');
    expect(probe.st.liveTurnOrder).toEqual(['u1']);
    // «длиннее побеждает» (O-16): усечённая ревизия не вытесняет полную
    Fn.liveTurnRecord('u1', 'user', 'во', 'во', '', '');
    expect(probe.st.liveTurns.u1.text).toBe('вопрос');

    // netSyncNeeded: live-ход есть, сети не было → true; свежий снимок сети → false
    expect(Fn.netSyncNeeded()).toBe(true);
    probe.st.netSnapshotAt = 5000;
    probe.st.netTurnIds = { u1: 1 };
    probe.st.lastTurnDoneAt = 1000;
    expect(Fn.netSyncNeeded()).toBe(false);
    probe.st.lastTurnDoneAt = 9000;          // снимок старше последнего хода
    expect(Fn.netSyncNeeded()).toBe(true);

    // applyExportNetSnapshot: форсированный ingest в режиме export-sync, затем per-turn выбор;
    // ONE-SIDE доливка идёт через сеттер orderCounter (без него порядок в файле замер бы)
    const snapshot = {
      code: 0,
      data: {
        biz_data: {
          chat_session: { current_message_id: 'a1' },
          chat_messages: [{ message_id: 'a1', parent_id: null, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: 'ответ сети' }] }]
        }
      }
    };
    probe.st.liveTurns.a2 = { role: 'assistant', text: 'ответ live', answer: '', reasoning: '', modelSlug: '', ts: 1 };
    probe.st.liveTurnOrder.push('a2');
    const res = Fn.applyExportNetSnapshot(snapshot, probe.st.currentConvId);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('merged');
    expect(res.verdicts['ONE-SIDE']).toBeGreaterThan(0);
    // Точный пин сеттера orderCounter: старт 7 → ingest дал ходу a1 order=7 (счётчик 8) →
    // ONE-SIDE-доливка u1 (order=8, счётчик 9) → a2 (order=9, счётчик 10). Если бы
    // `orderCounter++` в модуле писал в копию (или молча терялся из-за ro-геттера),
    // счётчик ядра замер бы на 8, а ходы в файле получили бы одинаковый order.
    expect(probe.st.turnsMap.a1.order).toBe(7);
    expect(probe.st.turnsMap.u1.order).toBe(8);
    expect(probe.st.turnsMap.a2.order).toBe(9);
    expect(probe.st.orderCounter).toBe(10);
    expect(probe.reads['orderCounter:set']).toBeGreaterThanOrEqual(2);
    expect(probe.st.ingestMode).toBe('');                       // режим снят в finally
    expect(probe.reads['ingestMode:set']).toBeGreaterThan(0);
    expect(probe.calls.ingest).toBe(1);
    expect(probe.calls.emit).toBe(1);
    expect(probe.calls.hist).toBe(1);
    // ONE-SIDE-ход долит live-текстом, сетевой ход остался сетевым
    expect(probe.st.turnsMap.a2.text).toBe('ответ live');
    expect(probe.st.turnsMap.a1.text).toBe('ответ сети');

    // усечённый снимок не принимается — exportSyncTruncated читается из ЯДРА (сеттер ingestHistory)
    probe.st.exportSyncTruncated = false;
    const trunc = JSON.parse(JSON.stringify(snapshot));
    trunc.truncated = true;
    const res2 = Fn.applyExportNetSnapshot(trunc, probe.st.currentConvId);
    expect(res2.ok).toBe(false);
    expect(res2.reason).toBe('truncated');
    expect(probe.reads['exportSyncTruncated']).toBeGreaterThan(0);
  });

  // FIX-NETSYNC-FETCH-BINDING (тот же класс, что FIX-REFETCH-FETCH-BINDING, аппендикс v49,
  // и FIX-PAGINATION-FETCH-BINDING, аппендикс v26): встроенный window.fetch — функция со
  // [[ThisMode]] = strict, поэтому вызов «голым» именем (originalFetch(url, opts)) уходит
  // с ЧУЖИМ this (внутри with (D) спецификация даёт this = with-объект D, в ядре — вообще
  // undefined) → TypeError «Failed to execute 'fetch' on 'Window': Illegal invocation»;
  // sloppy-подстановки globalThis у нативных функций НЕТ. Особенность K7: вызов обёрнут в
  // try/catch, поэтому исключение НЕ выходит наружу, а молча превращается в фолбэк
  // reason='fetch-throw' — сетевой дозапрос истории в момент экспорта (O-18, фаза 2) не
  // уходит никогда, а netSyncStats.failed растёт. Поэтому пин проверяет не отсутствие
  // исключения, а сам факт дохода вызова до window.fetch.
  test('S5: FIX-NETSYNC-FETCH-BINDING — originalFetch зовётся с this === window', async () => {
    const box = makeSandbox();
    const seen = [];
    const snapshot = {
      code: 0,
      data: {
        biz_data: {
          chat_session: { current_message_id: 'a1' },
          chat_messages: [{ message_id: 'a1', parent_id: null, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: 'ответ сети' }] }]
        }
      }
    };
    // Мок window.fetch ставится через Object.defineProperty и объявлен STRICT (строгость
    // лексическая: функция, созданная в strict-коде, strict). Он бросает ровно тот же
    // TypeError, что браузер, если this !== window, и записывает фактический this.
    box.sandbox.REC = seen;
    box.sandbox.SNAP = JSON.stringify(snapshot);
    const fetchMock = vm.runInContext(
      '(function () { "use strict"; return function (url, opts) {' +
      '  REC.push({ self: this, isWindow: this === window });' +
      '  if (this !== window) throw new TypeError("Failed to execute \'fetch\' on \'Window\': Illegal invocation");' +
      '  return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(SNAP)); } });' +
      '}; }())', box.sandbox, { filename: 'window.fetch (strict mock)' });
    Object.defineProperty(box.sandbox, 'fetch', { value: fetchMock, writable: true, configurable: true });

    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekNetsync;
    const probe = makeProbe();
    probe.st.originalFetch = box.sandbox.fetch;   // как ядро: ро-геттер отдаёт снимок window.fetch
    Fn.__bind(probe.D);

    // предусловие дозапроса: live-ход есть, авторитетного снимка сети нет
    Fn.liveTurnRecord('u1', 'user', 'вопрос', 'вопрос', '', '');
    expect(Fn.netSyncNeeded()).toBe(true);

    Fn.exportNetSync('req1', probe.st.currentConvId);

    expect(seen).toHaveLength(1);                       // вызов дошёл до window.fetch
    // this === window проверяется ВНУТРИ реалма песочницы: снаружи contextified-глобал
    // отдаётся прокси, и строгое сравнение с объектом-песочницей дало бы ложный минус.
    const innerWindow = vm.runInContext('window', box.sandbox);
    expect(seen[0].isWindow).toBe(true);                // this === window там, где идёт вызов
    expect(seen[0].self).toBe(innerWindow);             // тот же глобальный объект
    expect(seen[0].self).not.toBeUndefined();           // не bare-вызов (this не потерян)
    expect(probe.st.netSyncStats.failed).toBe(0);       // и не фолбэк reason='fetch-throw'
    expect(box.logs.join('\n')).not.toContain('не удался');   // ветка .catch дозапроса не сработала
    await flush();
    expect(probe.calls.ingest).toBe(1);                 // снимок доехал до ingestHistory ядра
    expect(probe.st.netSyncStats.ok).toBe(1);
    expect(probe.st.netSnapshotAt).toBeGreaterThan(0);  // снимок сети принят

    // source-пин: единственная точка вызова дозапроса — с явным window-контекстом
    expect(MODULE_SRC).toContain('originalFetch.call(window, url, {');
    expect(MODULE_SRC).not.toContain('originalFetch(url');
    // в модуле ровно одна точка вызова originalFetch (комментарии её не дают: regex
    // требует точку или скобку сразу после имени, поэтому bare-вызов не вернулся бы
    // незамеченным)
    expect(MODULE_SRC.match(/originalFetch[.(]/g)).toHaveLength(1);
  });
});
