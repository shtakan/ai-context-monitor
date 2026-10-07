/**
 * Step D.4 (декомпозиция core/deepseek-intercept.js): контракт модуля цепочки/текста хода.
 *
 * Кластер K3+K4 (СЕКЦИЯ 5 — MODEL-хелпер getModelSlug; СЕКЦИЯ 6 — buildActiveChain
 * (walk по parent_id); СЕКЦИЯ 7 — collectTurnText / collectTurnReasoning / composeTurnText
 * плюс hidden-пометки базы DS_PP_VISIBLE_MARKER / hasInjectedUserPrompt) уехал в
 * core/deepseek-parse.js. Модуль и ядро — РАЗНЫЕ IIFE одного registerContentScripts-пакета
 * (js[]: utils/debug.js -> deepseek-diag.js -> deepseek-netsync.js -> deepseek-refetch.js ->
 * deepseek-parse.js -> deepseek-intercept.js), поэтому связь идёт ровно через один
 * контракт:
 *
 *   ядро -> модуль: window.AiCmDeepseekParse.__bind(deps)
 *     ro (get): REASONING_ENABLED — гейт v8 (O-7) в composeTurnText (в ядре он остался:
 *               его читают K5/K7 и контракт диагностики D.1);
 *               __aiCmDeepseekResolveModelSlug — K0, чистый резолвер slug по сетевым
 *               сигналам, объявлен ВНЕ IIFE ядра.
 *     fn/rw: НЕТ. K3/K4 — чистые функции: аргументы на входе, значение на выходе, состояние
 *            кластера модуль не ведёт вовсе, rw-пересечений с ядром у него нет.
 *   модуль -> ядро: Fn.<fn> после __bind; ядро раздаёт ВСЕ 6 тел форвардерами
 *   (buildActiveChain, collectTurnText, collectTurnReasoning, composeTurnText,
 *   hasInjectedUserPrompt, getModelSlug) — function declaration, хойстятся.
 *
 * Здесь пинятся:
 *   S1. Полнота контракта: литерал __bind в ядре содержит ровно 2 имени, оба ro — ни одного
 *       потерянного/лишнего; каждое имя реально существует в ядре (K0-функция и переменная).
 *   S2. Живая связка в vm: до __bind наружу торчит ТОЛЬКО __bind; после — все 6 функций,
 *       а повторная загрузка модуля не перетирает уже связанный API.
 *   S3. Байтовая идентичность тел: блоки K3+K4 (строки 524-622 HEAD, кроме пустых строк-
 *       разделителей) лежат в модуле ДОСЛОВНО (SHA-256 каждого блока снят с 4017f7a и
 *       зафиксирован здесь — git-история сьютом не читается, CI shallow); PURE-блоки —
 *       вне with (D), BIND-блоки — внутри; константы REASONING_TAG/ANSWER_TAG переехали
 *       в модуль целиком; в ядре от K3/K4 остались только надгробие и 6 форвардеров.
 *   S4. Живая семантика перенесённых тел: обход parent_id (порядок, усечение, reachedRoot,
 *       защита от циклов), сборка текста хода по type (USER→REQUEST, остальные→RESPONSE,
 *       TIP игнорируется) и reasoning (только THINK), формат [REASONING]/[ANSWER] с гейтом
 *       из ЖИВОЙ переменной ядра, hidden-маркер инъекции DeepSeek++ и slug модели через
 *       ЖИВОЙ K0-резолвер с фолбэком по thinking_enabled.
 */

const vm = require('vm');
const crypto = require('crypto');

const DS = require('../helpers/deepseek-intercept-source.js');

const MODULE_SRC = DS.moduleSource('deepseek-parse.js');
const KERNEL_SRC = DS.moduleSource('deepseek-intercept.js');

// ---- контракт связки (S1): 2 ro-имени ----------------------------------------------
const CONTRACT = [
  // ro: только чтение — модуль эти имена не перезаписывает
  ['REASONING_ENABLED', 'ro'],
  ['__aiCmDeepseekResolveModelSlug', 'ro']
];

// ---- что модуль отдаёт наружу после __bind (S2) -------------------------------------
const EXPORTS = ['buildActiveChain', 'collectTurnText', 'collectTurnReasoning',
  'composeTurnText', 'hasInjectedUserPrompt', 'getModelSlug'];

// ---- что ядро зовёт по прежним именам (форвардеры) ----------------------------------
// Все 6 тел кластера: ядру нужны и разбор базы (buildActiveChain, collectTurn*),
// и композиция хода (composeTurnText), и hidden-пометка (hasInjectedUserPrompt),
// и slug модели (getModelSlug).
const FORWARDERS = EXPORTS;

// ---- блоки K3+K4, перенесённые в модуль дословно (S3) -------------------------------
// Эталон — SHA-256 блока в core/deepseek-intercept.js на 4017f7a (HEAD момента D.4),
// строки 524-622 (пустые строки-разделители между блоками в модуль не уезжают).
// Хэши сняты с git-блоба и ЗАФИКСИРОВАНЫ здесь: сьют не читает git-историю (CI клонирует
// shallow), поэтому байтовая идентичность против базы доказывается двумя независимыми
// способами — этими пинами (текущий модуль) и tools/verify-deepseek-parse.js
// (дословное сравнение с git show, локально).
// Блок = [якорь начала] + тела перечисленных функций (до закрывающей скобки последней).
const MOVED_BLOCKS = [
  {
    name: 'buildActiveChain (СЕКЦИЯ 6)', start: '  // ===== СЕКЦИЯ 6: АКТИВНАЯ ЦЕПОЧКА',
    sigs: ['  function buildActiveChain(chatSession, messagesById) {'],
    sha: '325403fe5e9982b8a81453c1eaf1207e0920e92e787f03690f541f4d8247a385'
  },
  {
    name: 'collectTurnText (СЕКЦИЯ 7)', start: '  // ===== СЕКЦИЯ 7: СБОР ТЕКСТА ХОДА',
    sigs: ['  function collectTurnText(fragments, role) {'],
    sha: '83dc72e9e00c3fc84e4af2063a9a7c618a0edca6fde7779a0cc4eab443bad412'
  },
  {
    name: 'collectTurnReasoning', start: '  // v8 (O-7): reasoning хода — фрагменты',
    sigs: ['  function collectTurnReasoning(fragments, role) {'],
    sha: '7d0397475feab86068694f66e8524ee5eba6dd4dffc57b32a0f60456995f5e1d'
  },
  {
    name: 'DS_PP_VISIBLE_MARKER + hasInjectedUserPrompt', start: '  // v13 (O-7): HIDDEN-ПОМЕТКИ БАЗЫ',
    sigs: ['  function hasInjectedUserPrompt(text) {'],
    sha: '3b12c5e55c02024f4b47f58ea464844228eb1860cdf9afc8b262d1da3e9255fc'
  },
  {
    name: 'getModelSlug (СЕКЦИЯ 5)', start: '  // ===== СЕКЦИЯ 5: МОДЕЛЬ',
    sigs: ['  function getModelSlug(thinkingEnabled, signals) {'],
    sha: '19c6ec9a78cb21ca01419040dbb5876afd24c5250074b412f9753c24f5dcde38'
  },
  {
    name: 'composeTurnText', start: '  // v8 (O-7): формат экспортного текста хода с reasoning:',
    sigs: ['  function composeTurnText(answer, reasoning) {'],
    sha: '8c408a25839ed5998f4f350a3b15c7695d8b1c50ed21437cee11a13d4480bc64'
  }
];

// Зоны (S3): PURE — тела без зависимости от ядра, BIND — читают ядро.
// Три первых тела зовутся в ГОРЯЧИХ циклах (обход ходов чата на ingest, обход фрагментов
// на финализации потока) — они обязаны жить ВНЕ with (D): внутри with каждый свободный
// идентификатор резолвится динамически, и цикл деградирует (урок D.1: 81 мс -> 3309 мс).
const PURE_BODIES = ['buildActiveChain', 'collectTurnText', 'collectTurnReasoning',
  'hasInjectedUserPrompt'];
const BIND_BODIES = ['getModelSlug', 'composeTurnText'];

// ---- константы кластера: уехали из СЕКЦИИ 1 ядра в модуль (S3) ----------------------
const MOVED_CONSTS = [
  "  var REASONING_TAG = '[REASONING]';",
  "  var ANSWER_TAG = '[ANSWER]';"
];

// Уникальные строки тел: их НЕ должно остаться в ядре (форвардеры — только вызовы).
const BODY_MARKERS = [
  '    var currentId = chatSession.current_message_id;',
  "    var types = (role === 'USER') ? ['REQUEST'] : ['RESPONSE'];",
  "      if (f && f.type === 'THINK' && typeof f.content === 'string') {",
  "    if (!REASONING_ENABLED || !reasoning) return answer;",
  "  var DS_PP_VISIBLE_MARKER = 'deepseek-pp-visible-user-prompt:start';",
  '    var networkSlug = __aiCmDeepseekResolveModelSlug(signals);',
  '  // ===== СЕКЦИЯ 6: АКТИВНАЯ ЦЕПОЧКА (walk по parent_id, ловушка №1) =====',
  '  // v7: sort по inserted_at УБРАН. WHY:'
];

// ---- состояние/константы, которые ОСТАЛИСЬ в ЯДРЕ -----------------------------------
// REASONING_ENABLED читают оставшиеся секции (K5/K7) и контракт диагностики D.1 —
// вынести его вместе с K4 значило бы тронуть K5/K11 (запрещено рамками шага).
const KERNEL_KEPT = [
  '  var REASONING_ENABLED = true;',
  "  // REASONING_TAG/ANSWER_TAG переехали в core/deepseek-parse.js (Step D.4): их читает",
  '  // только composeTurnText, тело которого живёт в модуле.'
];

// ---- вызовы в ядре, которые обязаны остаться на месте (S3) --------------------------
const KERNEL_CALLS = [
  'var chainResult = buildActiveChain(chatSession, messagesById);',
  'var text = collectTurnText(fragments, ch.role);',
  "var chReasoning = REASONING_ENABLED ? collectTurnReasoning(fragments, ch.role) : '';",
  'text: composeTurnText(text, mergedReasoning),',
  "tailTurn.text = composeTurnText(tailTurn.answer || '', tailTurn.reasoning);",
  "var sseReasoning = REASONING_ENABLED ? streamFragmentText('THINK') : '';",
  'if (t.role === \'user\' && hasInjectedUserPrompt(t.text)) turnMsg.hiddenInjection = true;',
  'modelSlug: getModelSlug(ch.thinking_enabled === true, chatModelSignals),'
];

// Контракт D.1 (диагностика) получает K4-функции ЗНАЧЕНИЕМ — теперь это форвардеры D.4:
// связка обязана остаться валидной (иначе диагностика потеряет счётчики хода молча).
const DIAG_BIND_PASSES = [
  '      collectTurnText: collectTurnText,',
  '      collectTurnReasoning: collectTurnReasoning,'
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

/** Блок K3+K4 из исходника: якорь начала + тела функций (до конца последней). */
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
// потерянный геттер не сломал бы S4 — проба навесила бы свой.
function kernelBindKinds() {
  const start = KERNEL_SRC.indexOf('aiCmDeepseekParse.__bind({');
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
function makeSandbox() {
  const logs = [];
  const sandbox = {
    console: {
      log: function () { logs.push(Array.prototype.map.call(arguments, String).join(' ')); },
      warn: function () { logs.push('WARN ' + Array.prototype.map.call(arguments, String).join(' ')); },
      error: function () { logs.push('ERR ' + Array.prototype.map.call(arguments, String).join(' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise, Date: Date
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs };
}

function loadModule(box) {
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-parse.js' });
}

// ---- probe-ядро: живое состояние + счётчики обращений к аксессорам -------------------
function makeProbe(over) {
  const st = {
    REASONING_ENABLED: true,
    __aiCmDeepseekResolveModelSlug: function () { return ''; }
  };
  if (over) Object.keys(over).forEach(function (k) { st[k] = over[k]; });
  const reads = {};
  const calls = { signals: [] };
  const D = {};
  CONTRACT.forEach(function (pair) {
    const name = pair[0];
    Object.defineProperty(D, name, {
      get: function () { reads[name] = (reads[name] || 0) + 1; return st[name]; },
      enumerable: true
    });
  });
  return { D: D, st: st, reads: reads, calls: calls };
}

/** Ход чата для стенда: { message_id, parent_id, role, thinking_enabled } */
function msg(id, parentId, role) {
  return { message_id: id, parent_id: parentId, role: role || 'ASSISTANT' };
}

describe('Step D.4: core/deepseek-parse.js — контракт модуля цепочки/текста хода', () => {
  test('S1: литерал __bind в ядре содержит ровно 2 имени (0 fn + 0 rw + 2 ro)', () => {
    // полное совпадение состава и видов — ни одного потерянного/лишнего имени
    expect(KINDS.size).toBe(CONTRACT.length);
    CONTRACT.forEach(function (pair) {
      expect(KINDS.get(pair[0])).toBe(pair[1]);
    });
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(function (pair) { kinds[pair[1]]++; });
    expect(kinds).toEqual({ fn: 0, ro: 2, rw: 0 });
    // каждая передача — реально существующее в ядре имя: переменная и K0-функция
    expect(KERNEL_SRC).toMatch(/var\s+REASONING_ENABLED\b/);
    expect(KERNEL_SRC).toContain('function __aiCmDeepseekResolveModelSlug(signals) {');
    // оба имени — именно ro-геттеры (сеттеров у кластера нет: писать модулю нечего);
    // последняя запись литерала — без хвостовой запятой, поэтому проверяем тело геттера
    const literal = KERNEL_SRC.slice(KERNEL_SRC.indexOf('aiCmDeepseekParse.__bind({'),
      KERNEL_SRC.indexOf('});', KERNEL_SRC.indexOf('aiCmDeepseekParse.__bind({')));
    CONTRACT.forEach(function (pair) {
      expect(literal).toContain('get ' + pair[0] + '() { return ' + pair[0] + '; }');
    });
    expect(literal).not.toMatch(/\bset\s+[A-Za-z_$]/);
    // K0 остался в ядре и по-прежнему экспортируется наружу (контрактный тест v13)
    expect(KERNEL_SRC).toContain('resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug');
  });

  test('S2: живая связка в vm — до __bind наружу только __bind, после — 6 функций', () => {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekParse;
    expect(Fn).toBeTruthy();
    expect(Object.keys(Fn)).toEqual(['__bind']);

    const probe = makeProbe();
    Fn.__bind(probe.D);

    expect(Object.keys(Fn).sort()).toEqual(['__bind'].concat(EXPORTS).sort());
    EXPORTS.forEach(function (n) { expect(typeof Fn[n]).toBe('function'); });
    // повторная загрузка модуля не перетирает уже связанный API
    loadModule(box);
    expect(box.sandbox.AiCmDeepseekParse).toBe(Fn);
  });

  test('S3: тела K3+K4 перенесены дословно (SHA-256 блоков); в ядре — надгробие и 6 форвардеров', () => {
    // Байтовая идентичность: SHA-256 каждого блока в модуле равен эталону с 4017f7a.
    MOVED_BLOCKS.forEach(function (b) {
      const body = blockOf(MODULE_SRC, b);
      expect(sha256(body)).toBe(b.sha);
    });
    // маркеры тел: живут в модуле, в ядре их нет (иначе пины-дубли)
    BODY_MARKERS.forEach(function (l) {
      expect(MODULE_SRC).toContain(l);
      expect(KERNEL_SRC).not.toContain(l);
    });
    // заголовков секций 5/6/7 в ядре больше нет + надгробие на месте
    ['// ===== СЕКЦИЯ 5: МОДЕЛЬ', '// ===== СЕКЦИЯ 6: АКТИВНАЯ ЦЕПОЧКА',
      '// ===== СЕКЦИЯ 7: СБОР ТЕКСТА ХОДА'].forEach(function (l) {
      expect(KERNEL_SRC).not.toContain(l);
    });
    expect(KERNEL_SRC).toContain('// ===== Step D.4: K3+K4 (MODEL-хелпер, цепочка, текст хода) вынесены в core/deepseek-parse.js =====');
    // REASONING_ENABLED остался в ядре и не продублирован в модуле; теги уехали в модуль
    KERNEL_KEPT.forEach(function (line) {
      expect(KERNEL_SRC).toContain(line);
      expect(MODULE_SRC).not.toContain(line);
    });
    MOVED_CONSTS.forEach(function (line) {
      expect(MODULE_SRC).toContain(line);
      expect(KERNEL_SRC).not.toContain(line);
    });
    // модуль: константы лежат в PURE-зоне (вне with), их читает composeTurnText
    const withAt = MODULE_SRC.indexOf('    with (D) {');
    expect(withAt).toBeGreaterThan(0);
    MOVED_CONSTS.forEach(function (line) {
      const at = MODULE_SRC.indexOf(line);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(withAt);
    });
    // форвардеры — function declaration (хойстятся: вызовы выше по файлу видят имя)
    FORWARDERS.forEach(function (n) {
      expect(KERNEL_SRC).toContain('\n  function ' + n + '(');
      expect(KERNEL_SRC).toContain('aiCmDeepseekParse.' + n + '(');
      expect(MODULE_SRC).toContain('      Fn.' + n + ' = ' + n + ';');
    });
    // ни одно тело кластера наружу не спрятано: контракт = все 6 тел
    const fwdCount = (KERNEL_SRC.match(/^ {2}function (?:buildActiveChain|collectTurnText|collectTurnReasoning|composeTurnText|hasInjectedUserPrompt|getModelSlug)\(/gm) || []).length;
    expect(fwdCount).toBe(6);
    // вызовы в ядре не сдвинуты: склейка базы, композиция ходов, SSE-финализация, hidden-пометка
    KERNEL_CALLS.forEach(function (l) { expect(KERNEL_SRC).toContain(l); });
    // контракт D.1 не сломан: диагностика получает те же имена (теперь — форвардеры D.4)
    DIAG_BIND_PASSES.forEach(function (l) { expect(KERNEL_SRC).toContain(l); });
    // префиксов D. в телах модуля нет (with (D), ES3 Annex B)
    expect(MODULE_SRC).not.toMatch(/\bD\.[A-Za-z_$]/);
    // зоны: PURE-тела ВНЕ with (D), BIND-тела — внутри
    PURE_BODIES.forEach(function (n) {
      const at = MODULE_SRC.indexOf('function ' + n + '(');
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(withAt);
    });
    BIND_BODIES.forEach(function (n) {
      const at = MODULE_SRC.indexOf('function ' + n + '(');
      expect(at).toBeGreaterThan(withAt);
    });
    // состав js[]: модуль строго перед ядром, refetch — перед ним
    expect(DS.SOURCES.indexOf('core/deepseek-parse.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-intercept.js'));
    expect(DS.SOURCES.indexOf('core/deepseek-refetch.js'))
      .toBeLessThan(DS.SOURCES.indexOf('core/deepseek-parse.js'));
    // размеры: K3+K4 уехали целиком (после D.5 ядро — 2106 строк, модуль — за 170)
    expect(KERNEL_SRC.split('\n').length).toBeLessThan(2120);
    expect(MODULE_SRC.split('\n').length).toBeGreaterThan(170);
  });

  test('S4: цепочка, текст хода и reasoning — поведение перенесённых тел байт-в-байт', () => {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekParse;
    const probe = makeProbe();
    Fn.__bind(probe.D);

    // ---- buildActiveChain: порядок строго по parent_id (не по inserted_at) ----
    const m1 = msg('m1', null, 'USER');
    const m2 = msg('m2', 'm1', 'ASSISTANT');
    const m3 = msg('m3', 'm2', 'USER');
    const byId = { m1: m1, m2: m2, m3: m3 };
    const full = Fn.buildActiveChain({ current_message_id: 'm3' }, byId);
    expect(full.chain.map(function (m) { return m.message_id; })).toEqual(['m1', 'm2', 'm3']);
    expect(full.truncated).toBe(false);
    expect(full.reachedRoot).toBe(true);          // дошли до узла без parent_id

    // усечение: parent_id есть, а сообщения нет → truncated, reachedRoot=false
    const cut = Fn.buildActiveChain({ current_message_id: 'm3' }, { m3: msg('m3', 'gone') });
    expect(cut.chain.map(function (m) { return m.message_id; })).toEqual(['m3']);
    expect(cut.truncated).toBe(true);
    expect(cut.reachedRoot).toBe(false);

    // цикл: защита по visited (обход завершается, порядок — от корня цикла)
    const c1 = msg('c1', 'c2'), c2 = msg('c2', 'c1');
    const loop = Fn.buildActiveChain({ current_message_id: 'c1' }, { c1: c1, c2: c2 });
    expect(loop.chain.map(function (m) { return m.message_id; })).toEqual(['c2', 'c1']);
    expect(loop.truncated).toBe(false);
    expect(loop.reachedRoot).toBe(false);        // цикл, а не корень

    // пустая цепочка: current_message_id = null
    const empty = Fn.buildActiveChain({ current_message_id: null }, byId);
    expect(empty.chain).toEqual([]);
    expect(empty.truncated).toBe(false);
    expect(empty.reachedRoot).toBe(false);

    // ---- collectTurnText: тип выбирается по роли, TIP игнорируется ----
    const frags = [
      { type: 'REQUEST', content: '  вопрос ' },
      { type: 'TIP', content: 'подсказка' },
      { type: 'THINK', content: 'размышление' },
      { type: 'RESPONSE', content: ' ответ  ' }
    ];
    expect(Fn.collectTurnText(frags, 'USER')).toBe('вопрос');
    expect(Fn.collectTurnText(frags, 'ASSISTANT')).toBe('ответ');
    expect(Fn.collectTurnText([{ type: 'RESPONSE', content: 42 }], 'ASSISTANT')).toBe('');
    expect(Fn.collectTurnText([], 'ASSISTANT')).toBe('');
    // склейка фрагментов одного типа — конкатенация без разделителя, затем trim
    expect(Fn.collectTurnText([{ type: 'RESPONSE', content: 'a' }, { type: 'RESPONSE', content: 'b' }], 'ASSISTANT'))
      .toBe('ab');

    // ---- collectTurnReasoning: только THINK, у USER хода reasoning нет ----
    expect(Fn.collectTurnReasoning(frags, 'ASSISTANT')).toBe('размышление');
    expect(Fn.collectTurnReasoning(frags, 'USER')).toBe('');
    // null-фрагмент не роняет проход (f && в условии тела)
    expect(Fn.collectTurnReasoning([null, { type: 'THINK', content: 't' }], 'ASSISTANT')).toBe('t');
    expect(Fn.collectTurnReasoning([{ type: 'THINK', content: 7 }], 'ASSISTANT')).toBe('');

    // ---- composeTurnText: формат [REASONING]/[ANSWER] и гейт из ЖИВОЙ переменной ----
    expect(Fn.composeTurnText('ответ', 'думал')).toBe('[REASONING]\nдумал\n\n[ANSWER]\nответ');
    expect(Fn.composeTurnText('ответ', '')).toBe('ответ');          // нет reasoning — текст прежний
    expect(Fn.composeTurnText('ответ', null)).toBe('ответ');
    probe.st.REASONING_ENABLED = false;                             // запись в ядре видна модулю
    expect(Fn.composeTurnText('ответ', 'думал')).toBe('ответ');      // гейт v8 (O-7) выключен
    expect(probe.reads.REASONING_ENABLED).toBeGreaterThan(0);        // читается живое имя, не копия
    probe.st.REASONING_ENABLED = true;
    expect(Fn.composeTurnText('ответ', 'думал')).toBe('[REASONING]\nдумал\n\n[ANSWER]\nответ');

    // ---- hasInjectedUserPrompt: маркер DeepSeek++ в user-ходе ----
    expect(Fn.hasInjectedUserPrompt('a deepseek-pp-visible-user-prompt:start b')).toBe(true);
    expect(Fn.hasInjectedUserPrompt('обычный текст')).toBe(false);
    expect(Fn.hasInjectedUserPrompt(null)).toBe(false);
    expect(Fn.hasInjectedUserPrompt(42)).toBe(false);
  });

  test('S5: getModelSlug — сетевые сигналы K0 через живой ro-геттер, фолбэк по thinking_enabled', () => {
    const box = makeSandbox();
    loadModule(box);
    const Fn = box.sandbox.AiCmDeepseekParse;
    const probe = makeProbe();
    Fn.__bind(probe.D);

    // (a) сетевые сигналы: K0-резолвер зовётся СИГНАЛАМИ хода и его ответ побеждает
    probe.st.__aiCmDeepseekResolveModelSlug = function (signals) {
      probe.calls.signals.push(signals);
      return signals && signals.modelType === 'default' ? 'deepseek-v4.1-flash' : '';
    };
    expect(Fn.getModelSlug(true, { modelType: 'default', conversationMode: 'DEFAULT' })).toBe('deepseek-v4.1-flash');
    expect(Fn.getModelSlug(false, { modelType: 'default', conversationMode: 'DEFAULT' })).toBe('deepseek-v4.1-flash');
    expect(probe.calls.signals).toEqual([
      { modelType: 'default', conversationMode: 'DEFAULT' },
      { modelType: 'default', conversationMode: 'DEFAULT' }
    ]);
    expect(probe.reads.__aiCmDeepseekResolveModelSlug).toBe(2);      // живой геттер, не копия на bind

    // (c) пустой ответ резолвера → прежний фолбэк по thinking_enabled
    expect(Fn.getModelSlug(true, { modelType: 'expert' })).toBe('deepseek-r1');
    expect(Fn.getModelSlug(false, { modelType: 'expert' })).toBe('deepseek-v3');
    expect(Fn.getModelSlug(undefined, undefined)).toBe('deepseek-v3');
    expect(Fn.getModelSlug('yes')).toBe('deepseek-v3');              // строгое === true

    // подмена K0 ПОСЛЕ связки видна модулю — доказательство аксессора (а не значения)
    probe.st.__aiCmDeepseekResolveModelSlug = function () { return 'deepseek-v4.1-flash'; };
    expect(Fn.getModelSlug(false)).toBe('deepseek-v4.1-flash');
  });
});
