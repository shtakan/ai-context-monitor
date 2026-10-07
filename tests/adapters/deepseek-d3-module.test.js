/**
 * Step D.3 (декомпозиция core/deepseek-intercept.js): контракт модуля REFETCH/URL-гигиены.
 *
 * Кластер K8 (СЕКЦИЯ 10 — гард перекрёста chat_session_id vs currentConvId:
 * convIdFromHistoryUrl / convIdFromCompletionBody / guardCheck; СЕКЦИЯ 10B — хелперы
 * MERGE-дозапроса: collectHeaders / stripCacheParams / historyRefetchUrl /
 * historyUrlForConv / refetchFullHistory / scheduleHistoryRefetch + таймер
 * historyRefetchTimer) уехал в core/deepseek-refetch.js. Модуль и ядро — РАЗНЫЕ IIFE
 * одного registerContentScripts-пакета (js[]: utils/debug.js -> deepseek-diag.js ->
 * deepseek-netsync.js -> deepseek-refetch.js -> deepseek-intercept.js), поэтому связь
 * идёт ровно через один контракт:
 *
 *   ядро -> модуль: window.AiCmDeepseekRefetch.__bind(deps)
 *     fn (значением): функции ядра, которые зовут тела модуля;
 *     rw (get+set):   состояние refetch-гигиены, которое пишут и ядро, и модуль;
 *     ro (get):       живое состояние только на чтение.
 *   модуль -> ядро: Fn.<fn> после __bind; ядро раздаёт 7 из 9 функций форвардерами
 *   (convIdFromHistoryUrl, convIdFromCompletionBody, guardCheck, collectHeaders,
 *   historyRefetchUrl, refetchFullHistory, scheduleHistoryRefetch); stripCacheParams и
 *   historyUrlForConv наружу не выдаются — их зовут только тела модуля.
 *
 * Здесь пинятся:
 *   S1. Полнота контракта: литерал __bind в ядре содержит ровно 8 имён (2 fn + 3 rw +
 *       3 ro) — ни одного потерянного; каждый rw — именно пара get+set.
 *   S2. Живая связка в vm: до __bind наружу торчит ТОЛЬКО __bind; после — все 9 функций,
 *       а повторная загрузка модуля не перетирает уже связанный API.
 *   S3. Байтовая идентичность тел: блоки K8 (строки 1680-1796 HEAD, кроме пустых строк-
 *       разделителей) лежат в модуле ДОСЛОВНО (SHA-256 каждого блока снят с 2fb6ffe и
 *       зафиксирован здесь — git-история сьютом не читается, CI shallow); PURE-блоки —
 *       вне with (D), BIND-блоки — внутри; в ядре от K8 остались только надгробие,
 *       состояние refetch-гигиены и 7 форвардеров.
 *   S4. Живая семантика перенесённых тел: URL-гигиена (stripCacheParams/historyUrlForConv),
 *       гард перекрёста (guardCheck), канонический URL (historyRefetchUrl), таймер
 *       scheduleHistoryRefetch (1000 мс, clearTimeout, условия lastLoadedConvId/
 *       lastAuthHeaders) и refetchFullHistory (cross-conv гард + ingest принятого снимка).
 *       Плюс rw-семантика: чтение состояния идёт из ЖИВЫХ переменных ядра (запись K9
 *       видна модулю), а не из копий, снятых на момент связки.
 */

const vm = require('vm');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-refetch.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 8 имён --------------------------------------------------
const CONTRACT = [
  // fn: функции ядра, вызываемые телами модуля
  ['diagMark', 'fn'],
  ['ingestHistory', 'fn'],
  // rw: модуль — владелец семантики refetch-состояния; пишут и ядро (K5/K9/K11), и модуль
  ['lastAuthHeaders', 'rw'],
  ['lastHistoryUrl', 'rw'],
  ['historyRefetchDone', 'rw'],
  // ro: только чтение
  ['currentConvId', 'ro'],
  ['lastLoadedConvId', 'ro'],
  ['originalFetch', 'ro']
];

// ---- что модуль отдаёт наружу после __bind (S2) -------------------------------------
const EXPORTS = ['convIdFromHistoryUrl', 'convIdFromCompletionBody', 'guardCheck',
  'collectHeaders', 'stripCacheParams', 'historyRefetchUrl', 'historyUrlForConv',
  'refetchFullHistory', 'scheduleHistoryRefetch'];

// ---- что ядро зовёт по прежним именам (форвардеры) ----------------------------------
const FORWARDERS = ['convIdFromHistoryUrl', 'convIdFromCompletionBody', 'guardCheck',
  'collectHeaders', 'historyRefetchUrl', 'refetchFullHistory', 'scheduleHistoryRefetch'];

// ---- блоки K8, перенесённые в модуль дословно (S3) ----------------------------------
// Эталон — SHA-256 блока в core/deepseek-intercept.js на 2fb6ffe (HEAD момента D.3),
// строки 1680-1796 (пустые строки-разделители между блоками в модуль не уезжают).
// Хэши сняты с git-блоба и ЗАФИКСИРОВАНЫ здесь: сьют не читает git-историю (CI клонирует
// shallow), поэтому байтовая идентичность против базы доказывается двумя независимыми
// способами — этими пинами (текущий модуль) и tools/verify-deepseek-refetch.js
// (дословное сравнение с git show, локально).
// Блок = [якорь начала] + тела перечисленных функций (до закрывающей скобки последней).
const MOVED_BLOCKS = [
  {
    name: 'convIdFromHistoryUrl', start: '  // ===== СЕКЦИЯ 10: ГАРД ПЕРЕКРЁСТА',
    sigs: ['  function convIdFromHistoryUrl(url) {'],
    sha: '9e0153a1fbd915465a1c720fedbe035260eb39952179a8ca76312382777f971c'
  },
  {
    name: 'convIdFromCompletionBody', start: '  function convIdFromCompletionBody(bodyStr) {',
    sigs: ['  function convIdFromCompletionBody(bodyStr) {'],
    sha: '6b8fd7d2315d9ea37063a8555a20b57d911dd53be5a009fe654718ee96b2e75d'
  },
  {
    name: 'collectHeaders+stripCacheParams', start: '  // ===== СЕКЦИЯ 10B: ХЕЛПЕРЫ ДЛЯ MERGE-ДОЗАПРОСА =====',
    sigs: ['  function collectHeaders(input, init) {', '  function stripCacheParams(url) {'],
    sha: 'b0614cf9ebbae6b6ba0500c37dfec5286736f2af2d45805aacb8f8e8382c941c'
  },
  {
    name: 'historyUrlForConv', start: '  // URL пригоден для дозапроса, только если он про историю И про ЭТОТ чат.',
    sigs: ['  function historyUrlForConv(url, convId) {'],
    sha: '4b6d487bd964379864084dcf12909b1b34e18ea15741d8075db7b718913f5eb2'
  },
  {
    name: 'guardCheck', start: '  function guardCheck(reqConvId) {',
    sigs: ['  function guardCheck(reqConvId) {'],
    sha: '6933ce90adf51b98f56ec01113fd93451f6673def7ad8991b0bd642625e456fb'
  },
  {
    name: 'historyRefetchUrl', start: '  // v11 (O-17): КАНОНИЧЕСКИЙ URL полной истории текущего чата',
    sigs: ['  function historyRefetchUrl() {'],
    sha: '04012249c4b42d341f8451121c92d134b1990b03c3745a6a2816cd3177b8f658'
  },
  {
    name: 'refetchFullHistory', start: '  // Тихий повторный запрос полной истории БЕЗ cache_version/cache_reset_at',
    sigs: ['  function refetchFullHistory(originalUrl, authHeaders, convId) {'],
    sha: 'a130ce174b206f9f14839c350de5f47ea614f6053aef417dfd7bd71e01ddaf8f'
  },
  {
    name: 'scheduleHistoryRefetch', start: '  // Таймер-дозапрос после смены чата (если сайт не прислал историю сам)',
    sigs: ['  function scheduleHistoryRefetch() {'],
    sha: '6e101a8d4fb8374ff445bf59024da6c68bcd04715e304126b415516fea45b77b'
  }
];

// Зоны (S3): PURE — тела без зависимости от ядра, BIND — читают живое состояние ядра.
const PURE_BODIES = ['convIdFromHistoryUrl', 'convIdFromCompletionBody', 'collectHeaders',
  'stripCacheParams', 'historyUrlForConv'];
const BIND_BODIES = ['guardCheck', 'historyRefetchUrl', 'refetchFullHistory', 'scheduleHistoryRefetch'];

// Уникальные строки тел: их НЕ должно остаться в ядре (форвардеры — только вызовы).
const BODY_MARKERS = [
  "var m = url.match(/[?&]chat_session_id=([A-Za-z0-9_-]+)/);",
  'var obj = JSON.parse(bodyStr);',
  "console.log('[deepseek-intercept] пропущен ответ (convId запроса ' + reqConvId + ' != текущий ' + currentConvId + ')');",
  'var src = (init && init.headers) || (input && input.headers ? input.headers : null);',
  "u.searchParams.delete('cache_version');",
  "return location.origin + '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(currentConvId);",
  "if (typeof url !== 'string' || url.indexOf('history_messages') === -1) return '';",
  "diagMark('refetch-full-history', { conv: String(convId).slice(0, 8) });   // O-18 (ИЗМЕРЕНИЕ)",
  "console.log('[deepseek-intercept] история не пришла после смены чата → тихий дозапрос по таймеру (convId=' + currentConvId + ')');"
];

// ---- состояние, которое осталось в ЯДРЕ (его пишут K5/K9/K11) -----------------------
const KERNEL_KEPT = [
  '  var lastAuthHeaders = {};',
  "  var lastLoadedConvId = '';",
  "  var lastHistoryUrl = '';          // v6: URL последнего history-запроса для дозапроса при усечении",
  '  var historyRefetchDone = false;   // v6: флаг «один дозапрос за загрузку чата»'
];

// ---- состояние, которое ПЕРЕЕХАЛО в модуль ------------------------------------------
const MOVED_STATE = '  var historyRefetchTimer = null;';

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

/** Блок K8 из исходника: якорь начала + тела функций (до конца последней). */
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
// Стенд обязан повторять РЕАЛЬНЫЙ контракт ядра, а не список из этого файла: иначе
// пропавший сеттер (ro вместо rw) не сломал бы S4 — проба навесила бы свой.
function kernelBindKinds() {
  const start = KERNEL_SRC.indexOf('aiCmDeepseekRefetch.__bind({');
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

// ---- стенд vm: песочница со всеми глобусами, которые зовут тела модуля --------------
const SNAPSHOT = { code: 0, data: { biz_data: { chat_session: {}, chat_messages: [] } } };

function makeSandbox() {
  const logs = [];
  const timers = [];
  const cleared = [];
  let seq = 0;
  const sandbox = {
    console: {
      log: function () { logs.push(Array.prototype.map.call(arguments, String).join(' ')); },
      warn: function () { logs.push('WARN ' + Array.prototype.map.call(arguments, String).join(' ')); },
      error: function () { logs.push('ERR ' + Array.prototype.map.call(arguments, String).join(' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise, Date: Date,
    URL: URL, encodeURIComponent: encodeURIComponent,
    location: { origin: 'https://chat.deepseek.com', pathname: '/a/chat/s/conv12345678' },
    // таймеры перехватываем вручную: стенд детерминирован без jest.useFakeTimers
    setTimeout: function (fn, ms) { const id = ++seq; timers.push({ id: id, fn: fn, ms: ms }); return id; },
    clearTimeout: function (id) { cleared.push(id); },
    CustomEvent: function (n, o) { this.type = n; this.detail = (o || {}).detail; },
    addEventListener: function () { }, dispatchEvent: function () { return true; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs, timers: timers, cleared: cleared };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-refetch.js' });
}

// ---- probe-ядро: живое состояние + счётчики обращений к аксессорам -------------------
function makeProbe(over) {
  const st = {
    lastAuthHeaders: { authorization: 'Bearer x' },
    lastHistoryUrl: '',
    historyRefetchDone: false,
    currentConvId: 'conv12345678',
    lastLoadedConvId: '',
    originalFetch: null
  };
  if (over) Object.keys(over).forEach(function (k) { st[k] = over[k]; });
  const reads = {};
  const calls = { marks: [], ingest: 0, fetch: [] };
  st.originalFetch = function (url, opts) {
    calls.fetch.push({ url: url, opts: opts });
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(SNAPSHOT); } });
  };
  const D = {
    diagMark: function (kind, data) { calls.marks.push({ kind: kind, data: data }); },
    ingestHistory: function () { calls.ingest++; }
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

/** Дренаж микротасков: refetchFullHistory завершает ingest в .then(). */
function flush() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

describe('Step D.3: core/deepseek-refetch.js — контракт модуля REFETCH/URL-гигиены', () => {
  test('S1: литерал __bind в ядре содержит ровно 8 имён (2 fn + 3 rw + 3 ro)', () => {
    // полное совпадение состава и видов — ни одного потерянного/лишнего имени
    expect(KINDS.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) {
      expect(KINDS.get(pair[0])).toBe(pair[1]);
    });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 2, ro: 3, rw: 3 });
    // каждая передача — реально существующее в ядре имя (fn — функция, ro/rw — переменная)
    CONTRACT.forEach(function (pair) {
      if (pair[1] === 'fn') expect(KERNEL_SRC).toContain('function ' + pair[0] + '(');
      else expect(new RegExp('var\\s+' + pair[0] + '\\b').test(KERNEL_SRC)).toBe(true);
    });
    // каждый rw — ИМЕННО пара get+set (без сеттера запись из модуля молча терялась бы)
    ['lastAuthHeaders', 'lastHistoryUrl', 'historyRefetchDone'].forEach(function (n) {
      const literal = KERNEL_SRC.slice(KERNEL_SRC.indexOf('aiCmDeepseekRefetch.__bind({'),
        KERNEL_SRC.indexOf('});', KERNEL_SRC.indexOf('aiCmDeepseekRefetch.__bind({')));
      expect(literal).toContain('get ' + n + '() { return ' + n + '; }');
      expect(literal).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });
  });

  test('S2: живая связка в vm — до __bind наружу только __bind, после — 9 функций', () => {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekRefetch;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);

    const probe = makeProbe();
    Fn.__bind(probe.D);

    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());
    EXPORTS.forEach(function (n) { expect(typeof Fn[n]).toBe('function'); });
    // повторная загрузка модуля не перетирает уже связанный API
    loadModule(box);
    expect(box.sandbox.AiCmDeepseekRefetch).toBe(Fn);
  });

  test('S3: тела K8 перенесены дословно (SHA-256 блоков); в ядре — надгробие, состояние, 7 форвардеров', () => {
    // Байтовая идентичность: SHA-256 каждого блока в модуле равен эталону с 2fb6ffe.
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      expect(sha256(body)).toBe(b.sha);
    });
    // маркеры тел: живут в модуле, в ядре их нет (иначе пины-дубли)
    BODY_MARKERS.forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
      expect(KERNEL_SRC).not.toContain(l);
    });
    // K8-заголовков секций в ядре больше нет
    ['// ===== СЕКЦИЯ 10: ГАРД ПЕРЕКРЁСТА', '// ===== СЕКЦИЯ 10B: ХЕЛПЕРЫ ДЛЯ MERGE-ДОЗАПРОСА']
      .forEach(function (l) { expect(KERNEL_SRC).not.toContain(l); });
    expect(KERNEL_SRC).toContain('// ===== Step D.3: K8 (REFETCH/URL-гигиена) вынесен в core/deepseek-refetch.js =====');
    // состояние refetch-гигиены осталось в ядре (его пишут K5/K9/K11) и не продублировано
    KERNEL_KEPT.forEach(function (line) {
      expect(KERNEL_SRC).toContain(line);
      expect(MODULE_SRC).not.toContain(line);
    });
    // таймер переехал ЦЕЛИКОМ: объявление есть в модуле и его нет в ядре
    expect(MODULE_SRC).toContain(MOVED_STATE);
    expect(KERNEL_SRC).not.toContain('var historyRefetchTimer');
    // форвардеры — function declaration (хойстятся: вызовы выше по файлу видят имя)
    FORWARDERS.forEach(function (n) {
      expect(KERNEL_SRC).toContain('function ' + n + '(');
      expect(KERNEL_SRC).toContain('aiCmDeepseekRefetch.' + n + '(');
    });
    // наружу не выдаются только те, кого ядро не зовёт
    ['stripCacheParams', 'historyUrlForConv'].forEach(function (n) {
      expect(KERNEL_SRC).not.toContain('aiCmDeepseekRefetch.' + n + '(');
      expect(MODULE_SRC).toContain('Fn.' + n + ' = ' + n + ';');
    });
    // вызовы в ядре не сдвинуты: fetch/XHR-перехватчики, ingestHistory, сброс чата.
    // Step D.7: fetch-хук и XHR-копилка (K9) уехали в core/deepseek-net.js, поэтому три
    // строки перехватчиков ищутся в конкатенации модулей+ядра (как у gemini/D.5),
    // остальные — по-прежнему в ядре.
    // Step D.8: тела K5 в ядре больше нет, поэтому вызов дозапроса
    // `refetchFullHistory(lastHistoryUrl, lastAuthHeaders, currentConvId)` (две ветки
    // детектора усечения — MERGE и оборванная цепочка) тоже ищется в конкатенации.
    ['var allH = collectHeaders(input, init);',
      'if (resp && resp.ok && guardCheck(historyConvId)) {',
      'info.completionConvId = convIdFromCompletionBody(bodyStr);',
      'refetchFullHistory(lastHistoryUrl, lastAuthHeaders, currentConvId);',
      'scheduleHistoryRefetch();',
      'historyRefetchUrl: historyRefetchUrl,'].forEach(function (l) {
      const src = (l.indexOf('collectHeaders(input') !== -1 || l.indexOf('guardCheck(historyConvId)') !== -1 ||
        l.indexOf('convIdFromCompletionBody') !== -1 || l.indexOf('refetchFullHistory(lastHistoryUrl') !== -1)
        ? DS.deepseekSource : KERNEL_SRC;
      expect(src).toContain(l);
    });
    // префиксов D. в телах модуля нет (with (D), ES3 Annex B)
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // зоны: PURE-тела ВНЕ with (D), BIND-тела — внутри
    const withAt = MODULE_SRC.indexOf('    with (D) {');
    expect(withAt).toBeGreaterThan(0);
    PURE_BODIES.forEach(function (n) {
      const at = MODULE_SRC.indexOf('function ' + n + '(');
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(withAt);
    });
    BIND_BODIES.forEach(function (n) {
      const at = MODULE_SRC.indexOf('function ' + n + '(');
      expect(at).toBeGreaterThan(withAt);
    });
    // PURE-тела не читают состояние ядра: их единственные внешние имена — глобусы
    // (JSON/Object/Array/URL/location/encodeURIComponent) и тела PURE-зоны модуля
    expect(MODULE_SRC.indexOf('var historyRefetchTimer = null;')).toBeLessThan(withAt);
    // состав js[]: модуль строго перед ядром, netsync — перед ним
    expect(DS.SOURCES.indexOf('core/deepseek-refetch.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
    expect(DS.SOURCES.indexOf('core/deepseek-netsync.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-refetch.js'));
    // размеры: K8 уехал целиком (ядро ушло ниже 2160 строк, модуль — за 180)
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(2160);
    expect(MODULE_SRC.split('\n').length).toBeGreaterThan(180);
  });

  test('S4: URL-гигиена и гард перекрёста — поведение перенесённых тел байт-в-байт', () => {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekRefetch;
    const probe = makeProbe();
    Fn.__bind(probe.D);

    // convId из URL истории и из тела completion
    expect(Fn.convIdFromHistoryUrl('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=abc-1_2&cache_version=3')).toBe('abc-1_2');
    expect(Fn.convIdFromHistoryUrl('https://chat.deepseek.com/api/v0/chat/history_messages')).toBe('');
    expect(Fn.convIdFromCompletionBody('{"chat_session_id":"cid9"}')).toBe('cid9');
    expect(Fn.convIdFromCompletionBody('{битый')).toBe('');
    expect(Fn.convIdFromCompletionBody(null)).toBe('');

    // заголовки: Headers-подобный (forEach) и Object-источник + пустой вход.
    // Array-ветка тела недостижима ДЛЯ настоящего массива (у массива есть forEach —
    // он и выигрывает по порядку проверок); это свойство перенесено байт-в-байт и
    // здесь пиновано как есть, чтобы шаг D.3 не «улучшил» поведение молча.
    const h = new Map([['Authorization', 'Bearer z']]);
    h.forEach = Map.prototype.forEach.bind(h);
    expect(Fn.collectHeaders({ headers: h }, null)).toEqual({ Authorization: 'Bearer z' });
    expect(Fn.collectHeaders(null, { headers: [['Authorization', 'Bearer a'], ['x', 'y']] }))
      .toEqual({ 0: ['Authorization', 'Bearer a'], 1: ['x', 'y'] });
    expect(Fn.collectHeaders({ headers: { authorization: 'Bearer o' } }, null)).toEqual({ authorization: 'Bearer o' });
    expect(Fn.collectHeaders(null, null)).toEqual({});

    // URL-гигиена: cache-параметры снимаются, чужой чат — не наш URL
    const dirty = 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=c1&cache_version=7&cache_reset_at=9';
    expect(Fn.stripCacheParams(dirty)).toBe('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=c1');
    expect(Fn.historyUrlForConv(dirty, 'c1')).toBe('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=c1');
    expect(Fn.historyUrlForConv(dirty, 'other')).toBe('');            // чужой чат — отказ
    expect(Fn.historyUrlForConv('https://x/api/v0/chat/other', 'c1')).toBe('');

    // гард перекрёста: пустой convId пропускается, чужой — блокируется с логом
    expect(Fn.guardCheck('')).toBe(true);
    expect(Fn.guardCheck('conv12345678')).toBe(true);
    expect(Fn.guardCheck('nope')).toBe(false);
    expect(box.logs.join('\n')).toContain('пропущен ответ (convId запроса nope != текущий conv12345678)');

    // канонический URL строится из ЖИВОГО currentConvId ядра
    expect(Fn.historyRefetchUrl()).toBe('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=conv12345678');
    probe.st.currentConvId = 'convOther99';
    expect(Fn.historyRefetchUrl()).toBe('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=convOther99');
  });

  test('S5: refetchFullHistory/scheduleHistoryRefetch — таймер, cross-conv гард, живое состояние ядра', async () => {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekRefetch;
    const probe = makeProbe();
    Fn.__bind(probe.D);

    // cross-conv гард: чужой convId — ни одного сетевого вызова
    Fn.refetchFullHistory('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=OTHER', {}, 'OTHER');
    expect(probe.calls.fetch).toHaveLength(0);
    expect(probe.calls.ingest).toBe(0);

    // запись K9 в ЖИВУЮ переменную ядра видна модулю (аксессор, а не копия на момент bind)
    probe.st.lastAuthHeaders = { Authorization: 'Bearer fresh' };

    // таймер: 1000 мс, первый id снимается повторным вызовом (clearTimeout)
    Fn.scheduleHistoryRefetch();
    expect(box.timers).toHaveLength(1);
    expect(box.timers[0].ms).toBe(1000);
    Fn.scheduleHistoryRefetch();
    expect(box.timers).toHaveLength(2);
    expect(box.cleared.filter(function (id) { return id !== null; })).toEqual([box.timers[0].id]);

    // условия не выполнены (история уже принята) → дозапроса нет
    probe.st.lastLoadedConvId = probe.st.currentConvId;
    box.timers[1].fn();
    expect(probe.calls.fetch).toHaveLength(0);

    // условия выполнены: lastLoadedConvId пуст + есть Authorization → канонический URL
    probe.st.lastLoadedConvId = '';
    Fn.scheduleHistoryRefetch();
    box.timers[2].fn();
    expect(probe.calls.fetch).toHaveLength(1);
    expect(probe.calls.fetch[0].url).toBe('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=conv12345678');
    expect(probe.calls.fetch[0].opts).toEqual({ method: 'GET', headers: { Authorization: 'Bearer fresh' } });
    expect(probe.calls.marks).toEqual([{ kind: 'refetch-full-history', data: { conv: 'conv1234' } }]);
    await flush();
    expect(probe.calls.ingest).toBe(1);                 // снимок принят ingestHistory ядра
    expect(box.logs.join('\n')).toContain('тихий дозапрос по таймеру (convId=conv12345678)');

    // без Authorization дозапроса нет (условие тела не тронуто)
    probe.st.lastAuthHeaders = {};
    Fn.scheduleHistoryRefetch();
    const before = probe.calls.fetch.length;
    box.timers[box.timers.length - 1].fn();
    expect(probe.calls.fetch).toHaveLength(before);

    // ПЕРЕДАННЫЙ URL чужого чата заменяется каноническим (URL-гигиена O-17):
    // в сеть уходит ТОЛЬКО URL текущего чата и БЕЗ cache-параметров
    probe.st.lastAuthHeaders = { Authorization: 'Bearer fresh' };
    Fn.refetchFullHistory('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=OTHER&cache_version=5',
      probe.st.lastAuthHeaders, probe.st.currentConvId);
    expect(probe.calls.fetch).toHaveLength(before + 1);
    expect(probe.calls.fetch[before].url).toBe('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=conv12345678');
    await flush();
    expect(probe.calls.ingest).toBe(2);

    // СВОЙ URL сохраняется, но чистится от cache_version/cache_reset_at
    const dirtyOwn = 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=conv12345678&cache_version=5&cache_reset_at=6';
    Fn.refetchFullHistory(dirtyOwn, probe.st.lastAuthHeaders, probe.st.currentConvId);
    expect(probe.calls.fetch[probe.calls.fetch.length - 1].url)
      .toBe('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=conv12345678');
    await flush();
    expect(probe.calls.ingest).toBe(3);

    // rw-контракт: kernel-сторонняя запись идёт через сеттер, значение живёт в ЯДРЕ
    probe.D.lastHistoryUrl = 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=conv12345678';
    probe.D.historyRefetchDone = true;
    expect(probe.reads['lastHistoryUrl:set']).toBe(1);
    expect(probe.reads['historyRefetchDone:set']).toBe(1);
    expect(probe.st.lastHistoryUrl).toContain('chat_session_id=conv12345678');
    expect(probe.st.historyRefetchDone).toBe(true);
    expect(probe.reads['lastAuthHeaders']).toBeGreaterThan(0);   // чтение живой переменной, не копии
  });
});
