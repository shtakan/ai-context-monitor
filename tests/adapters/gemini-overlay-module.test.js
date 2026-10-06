/**
 * Phase 3 шаг 13.1 — пины кластера оверлея (core/gemini-overlay.js).
 *
 * Контекст. Кластер оверлея загрузки истории вынесен из core/gemini-intercept.js
 * в core/gemini-overlay.js БЕЗ изменения логики: тела перенесены байт-в-байт, а ссылки
 * на имена ядра получили префикс D (объект связи заполняет __bind из ядра). Поэтому
 * пины здесь трёх родов:
 *
 *   A (состояние) — aiCmScrollOverlay / aiCmOverlaySeq / aiCmRerunOverlayTimer остаются
 *     в ЯДРЕ: их читают и пишут лоадер, скрытый скролл и пагинация. Модуль получает
 *     первые два ЖИВЫМИ геттерами/сеттерами. Регрессия = копия значения, из-за которой
 *     снятие оверлея перестало бы обнулять переменную ядра (тихий баг).
 *   B (форвардеры) — aiCmSetScrollOverlay / forceRestoreVisibility в ядре обязаны быть
 *     hoisted function declaration: их значения раздаются чужим __bind-блокам (пагинация
 *     410, лоадер 541) и вызываются из ядра (checkConvChange 1319) ДО строки связки.
 *     var-выражение или const сломало бы это (TDZ/null на момент bind).
 *   C (байт-идентичность) — тела функций и слушатели pagehide/visibilitychange обязаны
 *     остаться теми же строками: существующие пины (gemini-overlay-tape:166-173,
 *     gemini-widget-theme-h22:331-336) режут их из конкатенации и исполняют в песочнице.
 *
 *   S (проводка) — модуль реально подключён и связан с ядром:
 *     S1  регистрация в core/background.js: id -v9, модуль в js[] ПЕРЕД ядром,
 *         -v8 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
 *     S2  bind-контракт полон: все 3 имени контракта переданы ядром и все 3 используются
 *         модулем (регрессия = молчаливый no-op, которого не видит ни один старый пин);
 *     S3  деградация без модуля: внятный лог и undefined вместо падения;
 *     S4  порядок в helper-конкатенации повторяет порядок js[].
 *
 * ВАЖНО: существующие пины Gemini (gemini-overlay-tape, H22, H13, O-48…O-52) НЕ трогались
 * по существу — тела перенесены байт-в-байт, и это здесь доказано (блок C). Обновлены
 * только два литерала логов overlay-on/overlay-off (getConvId идёт через объект связи)
 * и объект связи D в песочнице H22.
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
const MOD = readFile('core/gemini-overlay.js');

const EXPORTED = ['aiCmSetScrollOverlay', 'forceRestoreVisibility'];
/** Тела, уехавшие в модуль (порядок — как в исходном диапазоне ядра). */
const MOVED = ['aiCmIsGeminiHost', 'aiCmOverlayTheme', 'aiCmApplyOverlayTheme',
  'aiCmWatchOverlayTheme', 'aiCmSetScrollOverlay', 'forceRestoreVisibility'];
/** Состояние, которое ОБЯЗАНО было остаться в ядре. */
const CORE_STATE = [
  '  var aiCmScrollOverlay = null;',
  '  var aiCmOverlaySeq = 0;        // v80: поколение оверлея — seq-гвард от чужого снятия',
  '  var aiCmRerunOverlayTimer = null; // v80: разоружение pre-applied оверлея, если ре-ран не стартовал'
];

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

/** Код без комментариев/строк-прозы: проза шапки упоминает имена как прозу, а не ссылки. */
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
const CORE_CODE = codeOf(CORE);
const MOD_CODE = codeOf(MOD);

/** Все `D.<имя>` кода модуля — уникальные, отсортированные. */
function dRefsOf(src) {
  return [...new Set((src.match(/\bD\.([A-Za-z_$][\w$]*)/g) || []).map((m) => m.slice(2)))].sort();
}
function bareCount(src, name) {
  return (src.match(new RegExp('(^|[^\\w$.])' + name + '(?![\\w$])', 'g')) || []).length;
}

/** Блок `aiCmGeminiOverlay.__bind({...})` ядра — как строка. */
function bindBlockText() {
  const at = CORE.indexOf('aiCmGeminiOverlay.__bind(');
  expect(at).toBeGreaterThan(-1);
  const end = CORE.indexOf('});', at);
  expect(end).toBeGreaterThan(at);
  return CORE.slice(at, end);
}

/** Исполняет РЕАЛЬНЫЙ форвардер ядра в песочнице с заданным объектом связи. */
function runForwarder(name, args, overlayApi) {
  const src = fnSource(CORE, name);
  expect(src).not.toBeNull();
  const ctx = vm.createContext({ aiCmGeminiOverlay: overlayApi, args: args, out: 'UNSET' });
  vm.runInContext('out = (' + src + ').apply(null, args);', ctx);
  return ctx.out;
}

describe('Phase 3 шаг 13.1: A-пины — состояние оверлея осталось в ЯДРЕ', () => {
  test('A1: три переменные состояния объявлены в ядре байт-в-байт и НЕ перенесены в модуль', () => {
    CORE_STATE.forEach((lit) => expect(CORE).toContain(lit));
    // строки состояния стоят ОДНИМ блоком сразу перед баннером выноса
    const at = CORE.indexOf(CORE_STATE[0]);
    expect(CORE.slice(at, at + CORE_STATE.join('\n').length)).toBe(CORE_STATE.join('\n'));
    // модуль ни одну из них не объявляет: иначе появилась бы ВТОРАЯ переменная, и ядро
    // (лоадер/пагинация) читало бы старую — снятие оверлея перестало бы работать
    ['aiCmScrollOverlay', 'aiCmOverlaySeq', 'aiCmRerunOverlayTimer'].forEach((n) => {
      expect(MOD_CODE).not.toMatch(new RegExp('\\bvar\\s+' + n + '\\b'));
      expect(MOD_CODE).not.toMatch(new RegExp('\\blet\\s+' + n + '\\b'));
      expect(MOD_CODE).not.toMatch(new RegExp('\\bconst\\s+' + n + '\\b'));
    });
    // …и вообще не упоминает их без префикса (единственный путь — объект связи)
    ['aiCmScrollOverlay', 'aiCmOverlaySeq'].forEach((n) => expect(bareCount(MOD_CODE, n)).toBe(0));
    expect(MOD_CODE).not.toContain('aiCmRerunOverlayTimer');
  });

  test('A2: блок __bind отдаёт состояние ЖИВЫМИ геттерами/сеттерами, а не копиями', () => {
    const block = bindBlockText();
    ['aiCmScrollOverlay', 'aiCmOverlaySeq'].forEach((n) => {
      expect(block).toContain('get ' + n + '() { return ' + n + '; }');
      expect(block).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });
    // getConvId — функция ядра значением (объявления хойстятся, значение уже есть)
    expect(block).toContain('getConvId: getConvId,');
    // aiCmRerunOverlayTimer модулю не нужен: лишний геттер расширил бы поверхность связи
    expect(block).not.toContain('aiCmRerunOverlayTimer');
    // связка идёт ПОСЛЕ объявления состояния: геттеры замкнуты на инициализированные
    // переменные, а не на undefined-на-момент-hoisting
    expect(CORE.indexOf('aiCmGeminiOverlay.__bind(')).toBeGreaterThan(CORE.indexOf(CORE_STATE[1]));
  });

  test('A3: модуль обращается к ядру РОВНО по контракту — ни одного свободного имени', () => {
    const contract = require(path.join(ROOT, 'tools/overlay-bind-contract.js'));
    const names = contract.map(([n]) => n).sort();
    expect(dRefsOf(MOD_CODE)).toEqual(names);
    names.forEach((n) => expect(bareCount(MOD_CODE, n)).toBe(0));
  });
});

describe('Phase 3 шаг 13.1: B-пины — форвардеры ядра (hoisting + делегирование)', () => {
  test('B1: оба форвардера — function declaration, ровно по одному объявлению', () => {
    EXPORTED.forEach((n) => {
      // именно declaration в начале строки с отступом 2: такое объявление хойстится
      expect(CORE).toMatch(new RegExp('\\n  function ' + n + '\\('));
      expect((CORE_CODE.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || [])).toHaveLength(1);
    });
    // тело перенесённой функции в ядре осталось ровно одно — форвардер (см. блок C)
    expect(fnSource(CORE, 'forceRestoreVisibility')).toBe(
      'function forceRestoreVisibility(reason) {\n' +
      '    return aiCmGeminiOverlay ? aiCmGeminiOverlay.forceRestoreVisibility(reason) : undefined;\n' +
      '  }'
    );
    expect(fnSource(CORE, 'aiCmSetScrollOverlay')).toBe(
      'function aiCmSetScrollOverlay(on, reason, expectSeq) {\n' +
      '    return aiCmGeminiOverlay ? aiCmGeminiOverlay.aiCmSetScrollOverlay(on, reason, expectSeq) : undefined;\n' +
      '  }'
    );
  });

  test('B2: форвардер делегирует в модуль и возвращает его результат', () => {
    const calls = [];
    const apiObj = {
      aiCmSetScrollOverlay: (on, reason, seq) => { calls.push(['set', on, reason, seq]); return 'SET-RESULT'; },
      forceRestoreVisibility: (reason) => { calls.push(['restore', reason]); return 'RESTORE-RESULT'; }
    };
    expect(runForwarder('aiCmSetScrollOverlay', [true, 'loader', 7], apiObj)).toBe('SET-RESULT');
    expect(runForwarder('forceRestoreVisibility', ['pagehide'], apiObj)).toBe('RESTORE-RESULT');
    expect(calls).toEqual([['set', true, 'loader', 7], ['restore', 'pagehide']]);
  });

  test('B3: без модуля форвардеры деградируют мягко — undefined и без исключения', () => {
    expect(runForwarder('aiCmSetScrollOverlay', [true, 'loader'], null)).toBeUndefined();
    expect(runForwarder('forceRestoreVisibility', ['pagehide'], null)).toBeUndefined();
    // undefined-объект связи (модуль не подключён вовсе) — тот же мягкий путь
    expect(runForwarder('aiCmSetScrollOverlay', [true, 'loader'], undefined)).toBeUndefined();
    expect(runForwarder('forceRestoreVisibility', ['pagehide'], undefined)).toBeUndefined();
  });

  test('B4: хойстинг реален — значение, взятое ДО связки, зовёт модуль', () => {
    // Три чужих __bind-блока получают функцию ЗНАЧЕНИЕМ: скрытый скролл (132), пагинация
    // (427) и лоадер (549). Все три биндуются РАНЬШЕ строки связки оверлея (~1619), поэтому
    // вызов через них обязан работать уже после связки — это и есть смысл function declaration.
    expect((CORE_CODE.match(/aiCmSetScrollOverlay: aiCmSetScrollOverlay,/g) || [])).toHaveLength(3);
    const fwd = fnSource(CORE, 'aiCmSetScrollOverlay');
    const ctx = vm.createContext({});
    // Порядок ровно как в ядре: значение берут ДО объявления, связка — ПОСЛЕ.
    vm.runInContext([
      'var captured = aiCmSetScrollOverlay;',
      "var aiCmGeminiOverlay = { aiCmSetScrollOverlay: function () { return 'FROM-MODULE'; } };",
      fwd,
      "out = captured(true, 'loader', 1);"
    ].join('\n'), ctx);
    expect(ctx.out).toBe('FROM-MODULE');
    // а до связки тот же захваченный указатель деградирует мягко, не бросая
    const ctx2 = vm.createContext({});
    vm.runInContext([
      'var captured = aiCmSetScrollOverlay;',
      'var aiCmGeminiOverlay = null;',
      fwd,
      "out = captured(true, 'loader', 1);"
    ].join('\n'), ctx2);
    expect(ctx2.out).toBeUndefined();
  });
});

describe('Phase 3 шаг 13.1: C-пины — тела перенесены байт-в-байт', () => {
  test('C1: все шесть перенесённых функций живут в модуле и отсутствуют в ядре', () => {
    MOVED.forEach((n) => {
      expect(fnSource(MOD, n)).not.toBeNull();
      if (EXPORTED.indexOf(n) === -1) {
        expect(CORE_CODE).not.toMatch(new RegExp('function\\s+' + n + '\\s*\\('));
      }
    });
    // наблюдатель темы уехал вместе с кластером
    expect(MOD).toContain('var aiCmOverlayThemeWatcher = null;');
    expect(CORE_CODE).not.toMatch(/aiCmOverlayThemeWatcher\s*=/);
  });

  test('C2: снятие оверлея и слушатели pagehide/visibilitychange байтово прежние', () => {
    expect(fnSource(MOD, 'forceRestoreVisibility')).toBe(
      'function forceRestoreVisibility(reason) {\n' +
      "    aiCmSetScrollOverlay(false, 'force-' + reason);\n" +
      '  }'
    );
    expect(MOD).toContain("window.addEventListener('pagehide', function () { forceRestoreVisibility('pagehide'); });");
    expect(MOD).toContain("document.addEventListener('visibilitychange', function () { forceRestoreVisibility('visibilitychange'); });");
    // внутренний вызов идёт к ТЕЛУ модуля, а не через объект связи: иначе снятие зависело бы
    // от того, успел ли ядро отдать форвардер
    expect(MOD_CODE).not.toContain('D.aiCmSetScrollOverlay');
    expect(MOD_CODE).not.toContain('D.forceRestoreVisibility');
  });

  test('C3: внутренние вызовы кластера не переписаны на объект связи', () => {
    ['aiCmIsGeminiHost', 'aiCmOverlayTheme', 'aiCmApplyOverlayTheme', 'aiCmWatchOverlayTheme']
      .forEach((n) => expect(MOD_CODE).not.toContain('D.' + n));
    // тело aiCmOverlayTheme по-прежнему зовёт aiCmIsGeminiHost свободным именем
    expect(fnSource(MOD, 'aiCmOverlayTheme')).toContain('if (aiCmIsGeminiHost()) {');
    // пересчёт палитры зовёт aiCmOverlayTheme свободным именем
    expect(fnSource(MOD, 'aiCmApplyOverlayTheme')).toContain('var th = aiCmOverlayTheme();');
    expect(fnSource(MOD, 'aiCmWatchOverlayTheme')).toContain('var reapply = function () { aiCmApplyOverlayTheme(); };');
  });

  test('C4: единственное изменение литералов — getConvId в двух логах оверлея', () => {
    // ровно два обращения к функции ядра, оба в логах, оба через объект связи
    expect((MOD_CODE.match(/D\.getConvId\(\)/g) || [])).toHaveLength(2);
    expect(MOD).toContain("convId=' + (D.getConvId() || '(none)'));");
    // остальная часть логов байтово прежняя (пин H22 держит её в конкатенации)
    expect(MOD).toContain("'[AI CM][visibility] overlay-on reason=' + reason + ' theme=' + th.name + ' convId='");
    expect(MOD).toContain("'[AI CM][visibility] overlay-off reason=' + reason + ' convId='");
    // прочие имена ядра — только через объект связи
    expect((MOD_CODE.match(/D\.aiCmScrollOverlay/g) || []).length).toBeGreaterThan(0);
    expect((MOD_CODE.match(/D\.aiCmOverlaySeq/g) || [])).toHaveLength(2);
  });

  test('C5: H22-пины темы на месте (наблюдатель поднимается/снимается вместе с оверлеем)', () => {
    expect(CONC).toContain('var aiCmOverlayThemeWatcher = null;');
    expect(CONC).toContain('aiCmWatchOverlayTheme(true); // H22');
    expect(CONC).toContain('aiCmWatchOverlayTheme(false); // H22');
    expect(MOD).toContain('aiCmWatchOverlayTheme(true); // H22');
    expect(MOD).toContain('aiCmWatchOverlayTheme(false); // H22');
  });
});

describe('Phase 3 шаг 13.1: D-пины — API, гигиена, деградация', () => {
  test('D1: модуль отдаёт ровно 3 имени и публикует их на window', () => {
    expect(MOD).toContain("if (typeof window !== 'undefined' && window.AiCmGeminiOverlay) return;");
    expect(MOD).toContain('  var D = null;');
    expect(MOD).toContain('  function __bind(d) { D = d; }');
    expect(MOD).toContain('    __bind: __bind,');
    EXPORTED.forEach((n) => expect(MOD).toContain('    ' + n + ': ' + n));
    expect(MOD).toContain("if (typeof window !== 'undefined') window.AiCmGeminiOverlay = Api;");
    // в MAIN-мире `module` не определён: голый module.exports бросил бы ReferenceError
    expect(MOD).toContain("if (typeof module !== 'undefined' && module.exports) module.exports = Api;");
  });

  test('D2: гигиена модуля — без with, без strict, без innerHTML', () => {
    expect(MOD_CODE).not.toMatch(/\bwith\s*\(/); // каркас IIFE + префиксы D, with не нужен
    expect(MOD).not.toMatch(/^\s*'use strict'/m);
    expect(MOD_CODE).not.toMatch(/innerHTML\s*=/);
    expect(MOD_CODE).not.toMatch(/console\s*\.\s*error\s*\(/);
  });

  test('D3: повторная загрузка модуля не перетирает API', () => {
    const pageWindow = {};
    const ctx = vm.createContext({
      window: pageWindow, console, setTimeout, clearTimeout,
      MutationObserver: function () { this.observe = function () { }; this.disconnect = function () { }; },
      document: { documentElement: {}, body: null }
    });
    vm.runInContext(MOD, ctx, { filename: 'core/gemini-overlay.js' });
    const api = pageWindow.AiCmGeminiOverlay;
    expect(api).toBeTruthy();
    expect(Object.keys(api).sort()).toEqual(['__bind'].concat(EXPORTED).sort());
    vm.runInContext(MOD, ctx, { filename: 'core/gemini-overlay.js (повторно)' });
    expect(pageWindow.AiCmGeminiOverlay).toBe(api);
    // мнемоника: без связки __bind не бросает — функции кластера уже настоящие
    expect(() => api.__bind({})).not.toThrow();
  });

  test('D4: без модуля ядро деградирует мягко — внятный лог, а не падение', () => {
    const at = CORE.indexOf("debugLog('log', '[gemini-intercept] core/gemini-overlay.js не подключён");
    expect(at).toBeGreaterThan(-1);
    const elseBranch = CORE.slice(at, CORE.indexOf('\n  }', at));
    expect(elseBranch).toContain('оверлей загрузки истории недоступен');
    // ветка ограничена логом: ни throw, ни заглушек-присваиваний (форвардеры уже объявлены)
    expect(elseBranch).not.toContain('throw');
    expect(elseBranch).not.toMatch(/function\s/);
  });
});

describe('Phase 3 шаг 13.1: S-пины проводки модуля', () => {
  test('S1: регистрация в core/background.js — id -v9, модуль перед ядром, -v8 снят', () => {
    const bg = readFile('core/background.js');
    expect(bg).toContain("'ai-cm-gemini-intercept-v9'");
    expect(bg).toContain("'core/gemini-overlay.js'");
    // js[] собран ровно в этом порядке: … loader-scroll → ingest → overlay → ядро
    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-intercept.js'");
    // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при своей загрузке
    expect(bg.indexOf("'core/gemini-ingest.js'")).toBeLessThan(bg.indexOf("'core/gemini-overlay.js'"));
    expect(bg.indexOf("'core/gemini-overlay.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
    // MV3 не перечитывает js[] под существующим id — прежний id обязан быть снят
    expect(bg).toContain("'ai-cm-gemini-intercept-v8'");
    expect(bg).toContain("'ai-cm-gemini-intercept-v7'");
    // лог регистрации бампнут вместе с id
    expect(bg).toContain('(v9) зарегистрирован');
    expect(bg).not.toContain('(v8) зарегистрирован');
  });

  test('S2: bind-контракт полон — ни одна зависимость кластера не потеряна', () => {
    const contract = require(path.join(ROOT, 'tools/overlay-bind-contract.js'));
    const names = contract.map(([n]) => n);
    // 3 имени — зафиксированная величина шага; падение = молчаливый no-op в модуле
    expect(contract).toHaveLength(3);
    expect(names.sort()).toEqual(['aiCmOverlaySeq', 'aiCmScrollOverlay', 'getConvId']);

    // каждое имя контракта реально используется телом модуля (через объект связи)
    const unused = names.filter((n) => !new RegExp('D\\.' + n + '\\b').test(MOD_CODE));
    expect(unused).toEqual([]);

    // …и передаётся ядром в __bind. Проверяем ИМЕННО блок __bind: имя может встречаться
    // в ядре и вне связки — это не передача.
    const block = bindBlockText();
    const notProvided = names.filter((n) => !new RegExp('(?:^|[\\s,{])' + n + '\\s*[:,(]', 'm').test(block));
    expect(notProvided).toEqual([]);

    // rw-зависимости обязаны быть ЖИВЫМИ (геттер+сеттер), иначе запись модуля потерялась бы
    const rw = contract.filter(([, kind]) => kind === 'rw').map(([n]) => n);
    expect(rw.sort()).toEqual(['aiCmOverlaySeq', 'aiCmScrollOverlay']);
    rw.forEach((n) => {
      expect(block).toMatch(new RegExp('get\\s+' + n + '\\s*\\(\\)'));
      expect(block).toMatch(new RegExp('set\\s+' + n + '\\s*\\('));
    });
    // fn-зависимости передаются значением и не получают сеттера
    const fn = contract.filter(([, kind]) => kind === 'fn').map(([n]) => n);
    expect(fn).toEqual(['getConvId']);
    fn.forEach((n) => expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\(')));
    expect(contract.filter(([, kind]) => kind === 'ro')).toEqual([]);
  });

  test('S3: порядок в helper-конкатенации повторяет порядок js[]', () => {
    expect(SRC.MODULES).toContain('core/gemini-overlay.js');
    expect(SRC.MODULES.indexOf('core/gemini-overlay.js'))
      .toBeGreaterThan(SRC.MODULES.indexOf('core/gemini-ingest.js'));
    expect(SRC.SOURCES.indexOf('core/gemini-overlay.js'))
      .toBeLessThan(SRC.SOURCES.indexOf('core/gemini-intercept.js'));
    expect(CONC.indexOf(MOD)).toBeLessThan(CONC.indexOf(CORE));
  });
});
