/**
 * Phase 3 шаг 13.2 — пины кластера архива (core/gemini-archive.js).
 *
 * Контекст. Кластер архива (первый ярус полноты T1) вынесен из core/gemini-intercept.js
 * в core/gemini-archive.js БЕЗ изменения логики: восемь функций и три слушателя перенесены
 * байт-в-байт, ссылки на имена ядра получили префикс D (объект связи заполняет __bind из
 * ядра), а в начало каждого слушателя добавлен гард `if (!D)`. Пины здесь четырёх родов:
 *
 *   A (состояние) — 11 имён состояния (turnsMap, archiveTierByConv, archiveMergedMap,
 *     cacheRestoredMap, loaderDoneMap, loaderRunningFor, parserVersion, quietActive и три
 *     вердикта полноты historyFullByQuiet/reachedStart/tapeWasUsedInThisColdStart) остаются
 *     в ЯДРЕ: их читают и пишут ingest, лоадер, пагинация, сброс при смене чата и мост
 *     content.js. Модуль получает их ЖИВЫМИ геттерами (и сеттерами там, где пишет).
 *     Регрессия = копия значения: оракул архива объявил бы полноту, а ядро её не увидело.
 *   B (форвардеры) — пять имён (aiCmArchiveFor, aiCmArchiveLiveProven, aiCmLiveTurnCount,
 *     aiCmArchiveTierApply, aiCmBaseExportInfo) в ядре обязаны быть hoisted function
 *     declaration: их значения раздаются чужим __bind-блокам (пагинация 430, лоадер 544-547,
 *     ingest 657) и вызываются из ядра (stableFloorConfirm, notifyLoaderState, self-heal,
 *     снапшот turns) — в том числе ДО строки связки. var-выражение сломало бы это.
 *   C (байт-идентичность) — тела и слушатели обязаны остаться теми же строками: пины
 *     archive-export-gate/union/oracle и oracle-archive-complete режут их из конкатенации
 *     и исполняют в песочнице. Единственные изменения — префиксы D и гарды !D.
 *   D (размещение и API) — блок подключения стоит НИЖЕ трёх поздних алиасов (строка > 782),
 *     API полон, модуль гигиеничен и повторная загрузка не перетирает Api.
 *
 *   S (проводка) — модуль реально подключён и связан с ядром:
 *     S1  регистрация в core/background.js: id -v11 (шаг 13.3), модуль в js[] строго между overlay
 *         и ядром, -v10 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
 *     S2  bind-контракт полон: все 22 имени контракта переданы ядром и все 22 используются
 *         модулем (регрессия = молчаливый no-op, которого не видит ни один старый пин);
 *     S3  порядок в helper-конкатенации повторяет порядок js[];
 *     S4  поздний алиас emitBaseSnapshot отдан архиву ЗНАЧЕНИЕМ — и это законно ровно
 *         потому, что блок стоит ниже заполнения алиасов (см. D5).
 *
 * ВАЖНО: существующие пины Gemini НЕ трогались по существу — тела перенесены байт-в-байт,
 * и это здесь доказано (блок C). Обновлены только песочницы tests/archive/*.test.js
 * (объект связи D) и три текстовых пина состояния в archive-oracle.test.js (D.*).
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
const MOD = readFile('core/gemini-archive.js');
const CONTRACT = require(path.join(ROOT, 'tools/archive-bind-contract.js'));

/** Функции, которые модуль отдаёт наружу (порядок — как в Api). */
const EXPORTED = ['aiCmArchiveFor', 'aiCmArchiveLiveProven', 'aiCmLiveTurnCount',
  'aiCmArchiveTierApply', 'aiCmBaseExportInfo'];
/** Тела, уехавшие в модуль и НЕ оставшиеся в ядре даже форвардером. */
const INTERNAL = ['aiCmBuildBaseMessages', 'aiCmArchiveOnlyBase', 'aiCmArchiveGrewBeyondArchive'];
/** Состояние, которое ОБЯЗАНО было остаться в ядре (объявления — как в файле). */
const CORE_STATE = [
  '  var turnsMap = {};',
  '  var quietActive = false;',
  '  var historyFullByQuiet = false;',
  '  var reachedStart = false; // тихая пагинация дошла до начала (курсора больше нет)',
  '  var loaderDoneMap = {};   // convId → true (один запуск на чат за сессию страницы)',
  '  var loaderRunningFor = null;',
  '  var cacheRestoredMap = new Set();',
  '  var archiveTierByConv = {};',
  '  var archiveMergedMap = new Set();',
  "  var parserVersion = '';",
  '  var tapeWasUsedInThisColdStart = false;'
];
/** Слушатели, уехавшие вместе с кластером. */
const LISTENERS = ['ai-cm-restored-history', 'ai-cm-archive-restore', 'ai-cm-cache-refresh'];
const GUARD = "if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }";

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
/** Код без комментариев И строковых литералов: упоминание имени в тексте лога — не ссылка.
 *  В модуле есть ровно такой случай: `'… (reachedStart=true) → …'` (сообщение tape-restore),
 *  которое подстановка по AST обязана была не трогать. */
function codeNoStrings(src) {
  return codeOf(src)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => ' '.repeat(m.length));
}
const MOD_REF = codeNoStrings(MOD);

/** Все `D.<имя>` кода модуля — уникальные, отсортированные. */
function dRefsOf(src) {
  return [...new Set((src.match(/\bD\.([A-Za-z_$][\w$]*)/g) || []).map((m) => m.slice(2)))].sort();
}
function bareCount(src, name) {
  return (src.match(new RegExp('(^|[^\\w$.])' + name + '(?![\\w$])', 'g')) || []).length;
}
function lineOf(src, lit) {
  return src.split('\n').findIndex((l) => l.indexOf(lit) !== -1) + 1;
}

/** Блок `aiCmGeminiArchive.__bind({...})` ядра — как строка. */
function bindBlockText() {
  const at = CORE.indexOf('aiCmGeminiArchive.__bind(');
  expect(at).toBeGreaterThan(-1);
  const end = CORE.indexOf('});', at);
  expect(end).toBeGreaterThan(at);
  return CORE.slice(at, end);
}

/** Исполняет РЕАЛЬНЫЙ форвардер ядра в песочнице с заданным объектом связи. */
function runForwarder(name, args, archiveApi, baseSizeFn) {
  const src = fnSource(CORE, name);
  expect(src).not.toBeNull();
  const ctx = vm.createContext({
    aiCmGeminiArchive: archiveApi,
    baseSize: baseSizeFn || function () { return 0; },
    args: args,
    out: 'UNSET'
  });
  vm.runInContext('out = (' + src + ').apply(null, args);', ctx);
  return ctx.out;
}

/** Грузит РЕАЛЬНЫЙ модуль в свежий vm-контекст и возвращает его API + живые обработчики. */
function loadModule() {
  const pageWindow = {
    listeners: [],
    handlers: {},
    addEventListener: function (t, fn) { this.listeners.push(t); this.handlers[t] = fn; }
  };
  const ctx = vm.createContext({ window: pageWindow, console, setTimeout, clearTimeout });
  vm.runInContext(MOD, ctx, { filename: 'core/gemini-archive.js' });
  return { pageWindow, ctx, api: pageWindow.AiCmGeminiArchive };
}

describe('Phase 3 шаг 13.2: A-пины — состояние архива осталось в ЯДРЕ', () => {
  test('A1: 11 переменных состояния объявлены в ядре байт-в-байт и НЕ перенесены в модуль', () => {
    CORE_STATE.forEach((lit) => expect(CORE).toContain(lit));
    const names = CONTRACT.filter(([, kind]) => kind === 'ro' || kind === 'rw').map(([n]) => n);
    expect(names).toHaveLength(11);
    names.forEach((n) => {
      // модуль не объявляет их заново: иначе появилась бы ВТОРАЯ переменная, и ядро
      // (ingest/лоадер/пагинация) читало бы старую — вердикт полноты терялся бы молча
      expect(MOD_CODE).not.toMatch(new RegExp('\\bvar\\s+' + n + '\\b'));
      expect(MOD_CODE).not.toMatch(new RegExp('\\blet\\s+' + n + '\\b'));
      expect(MOD_CODE).not.toMatch(new RegExp('\\bconst\\s+' + n + '\\b'));
    });
    // …и вообще не упоминают их без префикса: единственный путь — объект связи
    // (строка-лог с `reachedStart=true` ссылкой не является и потому не считается)
    names.forEach((n) => expect(bareCount(MOD_REF, n)).toBe(0));
  });

  test('A2: блок __bind отдаёт состояние ЖИВЫМИ геттерами/сеттерами, а не копиями', () => {
    const block = bindBlockText();
    const rw = CONTRACT.filter(([, kind]) => kind === 'rw').map(([n]) => n);
    const ro = CONTRACT.filter(([, kind]) => kind === 'ro').map(([n]) => n);
    expect(rw.sort()).toEqual(['historyFullByQuiet', 'reachedStart', 'tapeWasUsedInThisColdStart']);
    expect(ro).toHaveLength(8);
    rw.forEach((n) => {
      expect(block).toContain('get ' + n + '() { return ' + n + '; }');
      expect(block).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });
    ro.forEach((n) => {
      expect(block).toContain('get ' + n + '() { return ' + n + '; }');
      expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\('));
    });
    // связка идёт ПОСЛЕ объявления состояния: геттеры замкнуты на инициализированные
    // переменные, а не на undefined-на-момент-hoisting
    expect(CORE.indexOf('aiCmGeminiArchive.__bind(')).toBeGreaterThan(CORE.indexOf(CORE_STATE[0]));
  });

  test('A3: модуль обращается к ядру РОВНО по контракту — ни одного свободного имени', () => {
    const names = CONTRACT.map(([n]) => n).sort();
    expect(dRefsOf(MOD_CODE)).toEqual(names);
    names.forEach((n) => expect(bareCount(MOD_REF, n)).toBe(0));
    // вызовы ВНУТРИ кластера не переписаны на объект связи
    const internal = ['aiCmArchiveFor', 'aiCmArchiveOnlyBase', 'aiCmArchiveGrewBeyondArchive',
      'aiCmBuildBaseMessages', 'aiCmLiveTurnCount', 'aiCmArchiveLiveProven',
      'aiCmArchiveTierApply', 'aiCmBaseExportInfo'];
    internal.forEach((n) => expect(MOD_CODE).not.toContain('D.' + n));
    expect(fnSource(MOD, 'aiCmBaseExportInfo')).toContain('var arch = aiCmArchiveFor(convId);');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('var archiveOnly = aiCmArchiveOnlyBase(convId);');
    expect(fnSource(MOD, 'aiCmArchiveLiveProven')).toContain('return aiCmArchiveGrewBeyondArchive(a);');
  });

  test('A4: запись вердикта из модуля доходит до ЖИВЫХ переменных ядра (rw вживую)', () => {
    // «ядро» песочницы: те же имена, что объявлены в core/gemini-intercept.js
    const live = { historyFullByQuiet: false, reachedStart: false, turnsMap: {} };
    const tier = {
      c1: {
        convId: 'c1', count: 4, keys: {}, completeApplied: false, verdictLogged: '',
        addedIds: { a: true, b: true, c: true, d: true }
      }
    };
    ['a', 'b', 'c', 'd'].forEach((id) => { live.turnsMap[id] = { role: 'user', text: 'x' }; });
    const logic = {
      archiveCompleteVerdict: () => ({ complete: true, reason: 'archive-complete' }),
      archiveContentKey: (m) => m.role + '|' + m.text
    };
    const D = {
      getConvId: () => 'c1',
      baseSize: () => Object.keys(live.turnsMap).length,
      loadFloor: () => null,
      archiveTierByConv: tier,
      loaderDoneMap: {},
      loaderRunningFor: null,
      quietActive: false,
      turnsMap: live.turnsMap,
      get historyFullByQuiet() { return live.historyFullByQuiet; },
      set historyFullByQuiet(v) { live.historyFullByQuiet = v; },
      get reachedStart() { return live.reachedStart; },
      set reachedStart(v) { live.reachedStart = v; }
    };
    const sandbox = loadModule();
    sandbox.ctx.debugLog = function () { };
    sandbox.pageWindow.GeminiInterceptLogic = logic;
    sandbox.api.__bind(D);
    expect(sandbox.api.aiCmArchiveFor('c1')).toBe(tier.c1); // база ядра видна модулю
    sandbox.api.aiCmArchiveTierApply();
    // вердикт complete=true обязан дойти до переменных ЯДРА, а не до копий
    expect(live.historyFullByQuiet).toBe(true);
    expect(live.reachedStart).toBe(true);
    expect(tier.c1.completeApplied).toBe(true);
    // одноразовость взвода: повторный вызов не переписывает вердикты (архив уже применён)
    live.historyFullByQuiet = false;
    live.reachedStart = false;
    sandbox.api.aiCmArchiveTierApply();
    expect(live.historyFullByQuiet).toBe(false);
    expect(live.reachedStart).toBe(false);
  });
});

describe('Phase 3 шаг 13.2: B-пины — форвардеры ядра (hoisting + делегирование)', () => {
  test('B1: все пять форвардеров — function declaration, ровно по одному объявлению', () => {
    EXPORTED.forEach((n) => {
      expect(CORE).toMatch(new RegExp('\\n  function ' + n + '\\('));
      expect((CORE_CODE.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || [])).toHaveLength(1);
    });
    expect(fnSource(CORE, 'aiCmArchiveFor')).toBe(
      'function aiCmArchiveFor(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveFor(convId) : null; }'
    );
    expect(fnSource(CORE, 'aiCmArchiveLiveProven')).toBe(
      'function aiCmArchiveLiveProven(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveLiveProven(convId) : true; }'
    );
    expect(fnSource(CORE, 'aiCmLiveTurnCount')).toBe(
      'function aiCmLiveTurnCount(arch) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmLiveTurnCount(arch) : baseSize(); }'
    );
    expect(fnSource(CORE, 'aiCmArchiveTierApply')).toBe(
      'function aiCmArchiveTierApply() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveTierApply() : undefined; }'
    );
    expect(fnSource(CORE, 'aiCmBaseExportInfo')).toBe(
      'function aiCmBaseExportInfo() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmBaseExportInfo() : null; }'
    );
  });

  test('B2: форвардер делегирует в модуль и возвращает его результат', () => {
    const calls = [];
    const apiObj = {
      aiCmArchiveFor: (c) => { calls.push(['for', c]); return { count: 4 }; },
      aiCmArchiveLiveProven: (c) => { calls.push(['proven', c]); return 'PROVEN'; },
      aiCmLiveTurnCount: (a) => { calls.push(['live', a]); return 7; },
      aiCmArchiveTierApply: () => { calls.push(['tier']); return 'TIER'; },
      aiCmBaseExportInfo: () => { calls.push(['info']); return { baseMsgs: 4 }; }
    };
    expect(runForwarder('aiCmArchiveFor', ['c1'], apiObj)).toEqual({ count: 4 });
    expect(runForwarder('aiCmArchiveLiveProven', ['c1'], apiObj)).toBe('PROVEN');
    expect(runForwarder('aiCmLiveTurnCount', [{ count: 4 }], apiObj)).toBe(7);
    expect(runForwarder('aiCmArchiveTierApply', [], apiObj)).toBe('TIER');
    expect(runForwarder('aiCmBaseExportInfo', [], apiObj)).toEqual({ baseMsgs: 4 });
    expect(calls).toEqual([['for', 'c1'], ['proven', 'c1'], ['live', { count: 4 }], ['tier'], ['info']]);
  });

  test('B3: без модуля форвардеры деградируют мягко (прежние гейты) и не бросают', () => {
    // null — модуль не подключён вовсе; undefined — ветка else не выполнялась
    [null, undefined].forEach((api) => {
      expect(runForwarder('aiCmArchiveFor', ['c1'], api)).toBeNull();
      // «архива нет» = true: ровно так вели себя гейты H10/floor-confirm ДО T1
      expect(runForwarder('aiCmArchiveLiveProven', ['c1'], api)).toBe(true);
      expect(runForwarder('aiCmArchiveTierApply', [], api)).toBeUndefined();
      expect(runForwarder('aiCmBaseExportInfo', [], api)).toBeNull();
    });
    // aiCmLiveTurnCount без модуля обязан вернуть ТЕКУЩИЙ размер базы, а не 0/null
    expect(runForwarder('aiCmLiveTurnCount', [null], null, () => 114)).toBe(114);
  });

  test('B4: хойстинг реален — значение, взятое ДО связки, зовёт модуль', () => {
    // Четыре чужих __bind-блока получают форвардеры ЗНАЧЕНИЕМ: пагинация (aiCmArchiveTierApply),
    // лоадер (aiCmArchiveFor/aiCmArchiveLiveProven/aiCmLiveTurnCount), ingest
    // (aiCmArchiveTierApply) и оракул полноты — блок шага 13.3 (все пять имён сразу).
    // Три из них биндуются РАНЬШЕ строки связки архива — именно это и доказывает хойстинг;
    // блок оракула стоит НИЖЕ неё (оракул переоценивает ярус архива на стопе лоадера).
    expect((CORE_CODE.match(/aiCmArchiveTierApply: aiCmArchiveTierApply,/g) || [])).toHaveLength(3);
    expect((CORE_CODE.match(/aiCmArchiveFor: aiCmArchiveFor,/g) || [])).toHaveLength(2);
    expect((CORE_CODE.match(/aiCmArchiveLiveProven: aiCmArchiveLiveProven,/g) || [])).toHaveLength(2);
    expect((CORE_CODE.match(/aiCmLiveTurnCount: aiCmLiveTurnCount,/g) || [])).toHaveLength(2);
    const archiveBindAt = CORE_CODE.indexOf('aiCmGeminiArchive.__bind(');
    expect(archiveBindAt).toBeGreaterThan(-1);
    const hits = (re) => {
      const out = [];
      let m;
      const rx = new RegExp(re.source, 'g');
      while ((m = rx.exec(CORE_CODE)) !== null) out.push(m.index);
      return out;
    };
    expect(hits(/aiCmArchiveTierApply: aiCmArchiveTierApply,/).filter((i) => i < archiveBindAt)).toHaveLength(2);
    expect(hits(/aiCmArchiveTierApply: aiCmArchiveTierApply,/).filter((i) => i > archiveBindAt)).toHaveLength(1);
    expect(hits(/aiCmArchiveFor: aiCmArchiveFor,/).filter((i) => i < archiveBindAt)).toHaveLength(1);
    expect(hits(/aiCmArchiveFor: aiCmArchiveFor,/).filter((i) => i > archiveBindAt)).toHaveLength(1);
    const fwd = fnSource(CORE, 'aiCmArchiveTierApply');
    // Порядок ровно как в ядре: значение берут ДО объявления, связка — ПОСЛЕ.
    const ctx = vm.createContext({});
    vm.runInContext([
      'var captured = aiCmArchiveTierApply;',
      "var aiCmGeminiArchive = { aiCmArchiveTierApply: function () { return 'FROM-MODULE'; } };",
      fwd,
      'out = captured();'
    ].join('\n'), ctx);
    expect(ctx.out).toBe('FROM-MODULE');
    // а до связки тот же захваченный указатель деградирует мягко, не бросая
    const ctx2 = vm.createContext({});
    vm.runInContext([
      'var captured = aiCmArchiveTierApply;',
      'var aiCmGeminiArchive = null;',
      fwd,
      'out = captured();'
    ].join('\n'), ctx2);
    expect(ctx2.out).toBeUndefined();
  });
});

describe('Phase 3 шаг 13.2: C-пины — тела и слушатели перенесены байт-в-байт', () => {
  test('C1: восемь тел живут в модуле; три внутренних уехали из ядра целиком', () => {
    EXPORTED.concat(INTERNAL).forEach((n) => expect(fnSource(MOD, n)).not.toBeNull());
    INTERNAL.forEach((n) => expect(CORE_CODE).not.toMatch(new RegExp('function\\s+' + n + '\\s*\\(')));
    // тела экспортированных в ядре остались ровно форвардерами (см. B1) — тела нет
    EXPORTED.forEach((n) => expect(fnSource(MOD, n).length).toBeGreaterThan(fnSource(CORE, n).length));
  });

  test('C2: три слушателя уехали в модуль и каждый начинается гардом !D', () => {
    LISTENERS.forEach((ev) => {
      expect(MOD).toContain("window.addEventListener('" + ev + "'");
      // гард — ПЕРВАЯ строка тела: до чтения ev.detail и до любого обращения к D
      const at = MOD.indexOf("window.addEventListener('" + ev + "'");
      const brace = MOD.indexOf('{', at);
      const first = MOD.slice(brace + 1).split('\n')[1].trim();
      expect(first).toBe(GUARD);
    });
    expect((MOD.match(/if \(!D\) \{ debugLog\('error', '\[gemini-archive\] D is null, event ignored'\); return; \}/g) || []))
      .toHaveLength(3);
    // уникальность в КОНКАТЕНАЦИИ: копии в ядре не осталось (пин archive-export-union:686)
    expect(CONC.split('archiveAdded: true').length - 1).toBe(1);
    expect(CORE).not.toContain("window.addEventListener('ai-cm-archive-restore'");
    expect(CORE).not.toContain("window.addEventListener('ai-cm-restored-history'");
    expect(CORE).not.toContain("window.addEventListener('ai-cm-cache-refresh'");
    // байтовые требования чужих пинов: литерал регистрации и закрытие `\n  });`
    expect(CONC).toContain("window.addEventListener('ai-cm-archive-restore'");
    expect(MOD).toContain('\n  });');
  });

  test('C3: единственное изменение логики — префиксы D; строки-логи не переписаны', () => {
    // лог tape-restore содержит имя состояния ВНУТРИ строки-литерала: подстановка по AST
    // его не трогает (слепая замена по регулярке испортила бы текст сообщения)
    expect(MOD).toContain("'[gemini-restore] достигнут начало диалога (reachedStart=true) → восстановление из хранилища пропущено'");
    expect(MOD_CODE).not.toContain('D.reachedStart=true');
    // характерные литералы кластера байтово прежние
    ['[AI CM][archive-restore] convId=',
      '[AI CM][completeness] oracle=complete reason=archive-complete convId=',
      '[AI CM][tape-restore] convId=',
      '[AI CM][Gemini][cache-refresh] уточнение после кэша convId=',
      'floor source=archive convId='].forEach((lit) => expect(MOD).toContain(lit));
    // свойства объектов и ключи литералов не тронуты
    expect(MOD).toContain('archiveAdded: true');
    expect(MOD).toContain('pageMode: \'restored\'');
    expect(MOD).toContain('completeApplied: !!(prevTier && prevTier.completeApplied)');
  });

  test('C4: ключевые тела модуля байтово прежние — префикс D только у имён ядра', () => {
    // выборка покрывает все восемь тел: границу «D. только у внешнего имени» видно по
    // тому, что вызовы ВНУТРИ кластера (aiCmArchiveFor/aiCmLiveTurnCount) остались голыми
    expect(fnSource(MOD, 'aiCmArchiveFor')).toBe(
      'function aiCmArchiveFor(convId) {\n' +
      '    if (!convId) return null;\n' +
      '    return D.archiveTierByConv[convId] || null;\n' +
      '  }'
    );
    expect(fnSource(MOD, 'aiCmArchiveOnlyBase')).toBe(
      'function aiCmArchiveOnlyBase(convId) {\n' +
      '    try {\n' +
      '      var a = aiCmArchiveFor(convId || D.getConvId());\n' +
      '      if (!a || !(a.count > 0)) return false;\n' +
      '      return aiCmLiveTurnCount(a) === 0;\n' +
      '    } catch (eAob) { return false; }\n' +
      '  }'
    );
    expect(fnSource(MOD, 'aiCmLiveTurnCount')).toContain('if (!a || !a.addedIds) return D.baseSize();');
    expect(fnSource(MOD, 'aiCmLiveTurnCount')).toContain('var ids = Object.keys(D.turnsMap);');
    expect(fnSource(MOD, 'aiCmArchiveLiveProven')).toContain('return aiCmArchiveGrewBeyondArchive(a);');
    expect(fnSource(MOD, 'aiCmArchiveGrewBeyondArchive')).toContain('return liveCount > arch.count;');
    expect(fnSource(MOD, 'aiCmArchiveGrewBeyondArchive')).toContain('if (!overlap) return false;');
    expect(fnSource(MOD, 'aiCmBuildBaseMessages')).toContain('return D.sanitizeMessagesForEmit(messages);');
    expect(fnSource(MOD, 'aiCmBaseExportInfo')).toContain('liveProven: aiCmArchiveLiveProven(convId),');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('var archiveOnly = aiCmArchiveOnlyBase(convId);');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('loaderDone: loaderDone && !archiveOnly');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('loaderRunning: D.loaderRunningFor === convId');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('var loaderDone = D.loaderDoneMap[convId] === true;');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('active: D.quietActive === true');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('D.historyFullByQuiet = true;');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('D.reachedStart = true;');
    // прочие три записи состояния — в слушателях (rw-имена)
    expect(MOD).toContain('D.tapeWasUsedInThisColdStart = true;');
    expect(MOD).toContain('D.cacheRestoredMap.add(current);');
    expect(MOD).toContain('D.archiveMergedMap.add(convId);');
    expect(MOD).toContain('D.noteBaseCountChange();');
    expect(MOD).toContain('D.saveFloor(convId, archFloor.count, archFloor.effectiveLen);');
  });
});

describe('Phase 3 шаг 13.2: D-пины — API, размещение связки, гигиена', () => {
  test('D1: модуль отдаёт ровно 6 имён и публикует их на window', () => {
    expect(MOD).toContain("if (typeof window !== 'undefined' && window.AiCmGeminiArchive) return;");
    expect(MOD).toContain('  var D = null;');
    expect(MOD).toContain('  function __bind(d) { D = d; }');
    expect(MOD).toContain('    __bind: __bind,');
    EXPORTED.forEach((n) => expect(MOD).toContain('    ' + n + ': ' + n));
    expect(MOD).toContain("if (typeof window !== 'undefined') window.AiCmGeminiArchive = Api;");
    // в MAIN-мире `module` не определён: голый module.exports бросил бы ReferenceError
    expect(MOD).toContain("if (typeof module !== 'undefined' && module.exports) module.exports = Api;");
    expect(Object.keys(require(path.join(ROOT, 'core/gemini-archive.js'))).sort())
      .toEqual(['__bind'].concat(EXPORTED).sort());
  });

  test('D2: гигиена модуля — без with, без strict, без innerHTML, без console.error', () => {
    expect(MOD_CODE).not.toMatch(/\bwith\s*\(/);
    expect(MOD).not.toMatch(/^\s*'use strict'/m);
    expect(MOD_CODE).not.toMatch(/innerHTML\s*=/);
    expect(MOD_CODE).not.toMatch(/console\s*\.\s*error\s*\(/);
    // в MAIN-мире chrome.* недоступен: модуль обязан остаться без него
    expect(MOD_CODE).not.toContain('chrome.');
  });

  test('D3: повторная загрузка модуля не перетирает API и не вешает слушателей дважды', () => {
    const first = loadModule();
    const api = first.api;
    expect(api).toBeTruthy();
    expect(Object.keys(api).sort()).toEqual(['__bind'].concat(EXPORTED).sort());
    expect(first.pageWindow.listeners.slice().sort())
      .toEqual(['ai-cm-archive-restore', 'ai-cm-cache-refresh', 'ai-cm-restored-history']);
    vm.runInContext(MOD, first.ctx, { filename: 'core/gemini-archive.js (повторно)' });
    expect(first.pageWindow.AiCmGeminiArchive).toBe(api);
    expect(first.pageWindow.listeners).toHaveLength(3); // re-entry guard сработал
    // без связки слушатель не бросает: гард !D гасит событие с внятным логом
    expect(() => first.pageWindow.listeners && api.__bind({})).not.toThrow();
  });

  test('D4: гард !D гасит событие до связки (без ReferenceError в чужом стеке)', () => {
    const sandbox = loadModule();
    const logs = [];
    sandbox.ctx.debugLog = function (level, msg) { logs.push([level, msg]); };
    const ev = { detail: { turns: [{ role: 'user', text: 'x' }], convId: 'c1' } };
    // до __bind D === null: каждый слушатель обязан выйти на ПЕРВОЙ строке с логом error
    LISTENERS.forEach((t) => {
      expect(typeof sandbox.pageWindow.handlers[t]).toBe('function');
      expect(() => sandbox.pageWindow.handlers[t](ev)).not.toThrow();
    });
    expect(logs).toHaveLength(3);
    logs.forEach(([level, msg]) => {
      expect(level).toBe('error');
      expect(msg).toBe('[gemini-archive] D is null, event ignored');
    });
    // после связки гард молчит и обработчик доходит до тела: чат «чужой» → ветка stale
    sandbox.api.__bind({ getConvId: () => 'other', aiCmDiagTurnEdge: () => ({ hash: 'h' }) });
    logs.length = 0;
    expect(() => sandbox.pageWindow.handlers['ai-cm-restored-history'](ev)).not.toThrow();
    expect(logs).toHaveLength(2);
    expect(logs[0][0]).toBe('log');
    expect(logs[0][1]).toContain('пропущена лента для чужого чата');
  });

  test('D5: блок подключения стоит НИЖЕ поздних алиасов (строка > 782)', () => {
    const bindLine = lineOf(CORE, 'aiCmGeminiArchive.__bind(');
    expect(bindLine).toBeGreaterThan(782);
    // три ПОЗДНИХ алиаса — `var ... = null`, дозаполняются блоками ingest (770-771)
    // и пагинации (494); выше них в модуль уехали бы null вместо функций
    ['emitBaseSnapshot = aiCmGeminiIngest.emitBaseSnapshot;',
      'mergeRestoredTurns = aiCmGeminiIngest.mergeRestoredTurns;',
      'refreshMinOrderTracking = aiCmGeminiPagination.refreshMinOrderTracking;'].forEach((lit) => {
      const at = lineOf(CORE, lit);
      expect(at).toBeGreaterThan(0);
      expect(bindLine).toBeGreaterThan(at);
    });
    // S4: поэтому поздний алиас отдан архиву ЗНАЧЕНИЕМ — и это законно (ср. суженный пин
    // в tests/adapters/gemini-ingest-module.test.js: блок ingest обязан отдавать форвардер).
    // Шаг 13.3 добавил ВТОРОЙ такой блок — оракул полноты: он тоже стоит ниже заполнения
    // алиасов и потому вправе получить emitBaseSnapshot значением. Больше таких блоков нет.
    expect(bindBlockText()).toContain('emitBaseSnapshot: emitBaseSnapshot,');
    expect(CORE_CODE.match(/emitBaseSnapshot: emitBaseSnapshot,/g)).toHaveLength(2);
    const oracleBindAt = CORE_CODE.indexOf('aiCmGeminiOracle.__bind({');
    expect(oracleBindAt).toBeGreaterThan(CORE_CODE.indexOf('aiCmGeminiArchive.__bind('));
    expect(CORE_CODE.slice(oracleBindAt).match(/emitBaseSnapshot: emitBaseSnapshot,/g)).toHaveLength(1);
    // баннер-указатель на месте бывшего диапазона слушателей
    expect(CORE).toContain('// ===== v2.0 (Phase 3 step 13.2): АРХИВ (ВЫНЕСЕН В core/gemini-archive.js) =====');
    expect((CORE.match(/Phase 3 step 13\.2\): АРХИВ \(ВЫНЕСЕН/g) || [])).toHaveLength(2);
  });

  test('D6: без модуля ядро деградирует мягко — внятный лог, а не падение', () => {
    const at = CORE.indexOf("debugLog('log', '[gemini-intercept] core/gemini-archive.js не подключён");
    expect(at).toBeGreaterThan(-1);
    const elseBranch = CORE.slice(at, CORE.indexOf('\n  }', at));
    expect(elseBranch).toContain('архивный ярус недоступен');
    expect(elseBranch).not.toContain('throw');
    expect(elseBranch).not.toMatch(/function\s/);
  });
});

describe('Phase 3 шаг 13.2: S-пины проводки модуля', () => {
  test('S1: регистрация в core/background.js — id -v11, модуль между overlay и ядром, -v10 снят', () => {
    const bg = readFile('core/background.js');
    expect(bg).toContain("'ai-cm-gemini-intercept-v11'");
    expect(bg).toContain("'core/gemini-archive.js'");
    // js[] собран ровно в этом порядке: … loader-scroll → ingest → overlay → archive → oracle → ядро
    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-oracle.js', 'core/gemini-intercept.js'");
    // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при своей загрузке
    expect(bg.indexOf("'core/gemini-overlay.js'")).toBeLessThan(bg.indexOf("'core/gemini-archive.js'"));
    expect(bg.indexOf("'core/gemini-archive.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
    // MV3 не перечитывает js[] под существующим id — прежний id обязан быть снят
    expect(bg).toContain("'ai-cm-gemini-intercept-v10'");
    expect(bg).toContain("'ai-cm-gemini-intercept-v9'");
    expect(bg).toContain("'ai-cm-gemini-intercept-v8'");
    // лог регистрации бампнут вместе с id
    expect(bg).toContain('(v11) зарегистрирован');
    expect(bg).not.toContain('(v10) зарегистрирован');
    // лог обязан стоять РЯДОМ со своей регистрацией, а не быть унаследованным текстом
    expect(bg.indexOf("await registerSafe('ai-cm-gemini-intercept-v11'"))
      .toBeLessThan(bg.indexOf('(v11) зарегистрирован'));
  });

  test('S2: bind-контракт полон — ни одна зависимость кластера не потеряна', () => {
    // 22 имени — зафиксированная величина шага; падение = молчаливый no-op в модуле
    expect(CONTRACT).toHaveLength(22);
    const names = CONTRACT.map(([n]) => n);
    expect(new Set(names).size).toBe(22);
    // полный состав контракта — фиксированная величина шага (11 fn + 8 ro + 3 rw)
    expect(names.slice().sort()).toEqual([
      'activeRefresh', 'aiCmDiagTurnEdge', 'archiveMergedMap', 'archiveTierByConv', 'baseSize',
      'cacheRestoredMap', 'emitBaseSnapshot', 'getConvId', 'historyFullByQuiet', 'loadFloor',
      'loaderDoneMap', 'loaderRunningFor', 'mergeRestoredTurns', 'noteBaseCountChange',
      'parserVersion', 'quietActive', 'reachedStart', 'refreshMinOrderTracking',
      'sanitizeMessagesForEmit', 'saveFloor', 'tapeWasUsedInThisColdStart', 'turnsMap'
    ]);
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(([, k]) => { kinds[k]++; });
    expect(kinds).toEqual({ fn: 11, ro: 8, rw: 3 });
    // каждое имя контракта реально используется телом модуля (через объект связи)
    const unused = names.filter((n) => !new RegExp('D\\.' + n + '\\b').test(MOD_CODE));
    expect(unused).toEqual([]);
    // …и передаётся ядром в __bind. Проверяем ИМЕННО блок __bind: имя может встречаться
    // в ядре и вне связки — это не передача.
    const block = bindBlockText();
    const notProvided = names.filter((n) => !new RegExp('(?:^|[\\s,{])' + n + '\\s*[:,(]', 'm').test(block));
    expect(notProvided).toEqual([]);
    // ro-имена не получают сеттера (модуль их не переприсваивает), rw — получают
    const rw = CONTRACT.filter(([, k]) => k === 'rw').map(([n]) => n);
    const ro = CONTRACT.filter(([, k]) => k === 'ro').map(([n]) => n);
    rw.forEach((n) => expect(block).toMatch(new RegExp('set\\s+' + n + '\\s*\\(')));
    ro.forEach((n) => expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\(')));
    // fn-имена передаются значением и сеттера не получают
    CONTRACT.filter(([, k]) => k === 'fn').forEach(([n]) => {
      expect(block).toContain(n + ': ' + n + ',');
      expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\('));
    });
  });

  test('S3: порядок в helper-конкатенации повторяет порядок js[]', () => {
    expect(SRC.MODULES).toContain('core/gemini-archive.js');
    expect(SRC.MODULES.indexOf('core/gemini-archive.js'))
      .toBeGreaterThan(SRC.MODULES.indexOf('core/gemini-overlay.js'));
    expect(SRC.SOURCES.indexOf('core/gemini-archive.js'))
      .toBeLessThan(SRC.SOURCES.indexOf('core/gemini-intercept.js'));
    expect(CONC.indexOf(MOD)).toBeLessThan(CONC.indexOf(CORE));
    // контракт обязан трекаться в git: tools/* под .gitignore, нужна негация
    expect(readFile('.gitignore')).toContain('!tools/archive-bind-contract.js');
  });

  test('S4: пин строки vf5 не сдвинулся — оба диапазона лежат НИЖЕ него', () => {
    // шаг 13.2 правил только строки > 1712, но шаг 13.3 вынес оракул (диапазоны 866-909,
    // 1001-1155, 1372-1436) — точка выхода vf5 поднялась 1680 → 1446. Пин держит ФАКТ:
    // следующий перенос кода выше этой точки снова потребует ревью строки, а не пройдёт молча.
    const VF5_TAIL = 'aiCmIngestFwd(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });';
    const hits = CORE.split('\n').reduce((acc, l, i) => (l.indexOf(VF5_TAIL) !== -1 ? acc.concat(i + 1) : acc), []);
    expect(hits).toEqual([1446]);
    expect(lineOf(CORE, 'aiCmGeminiArchive.__bind(')).toBeGreaterThan(1446);
  });
});
