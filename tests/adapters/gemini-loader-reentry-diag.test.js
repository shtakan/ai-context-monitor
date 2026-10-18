/**
 * loader-reentry (v2.0.17) — пины диагностики автозапуска лоадера Gemini.
 *
 * ПРЕДМЕТ. В core/gemini-loader-scroll.js (maybeStartLoader) добавлена ровно одна
 * диаг-строка `auto-start-reentry` и карта `loaderRunAtMap` (convId → Date.now() последнего
 * реального старта). Цель — ИЗМЕРИТЬ повторный вход автозапуска (сколько мс прошло с
 * предыдущего прогона), а не исправить его. Поэтому здесь пинятся четыре вещи:
 *
 *   D1  источник: литерал 'auto-start-reentry' и карта loaderRunAtMap (объявление + два
 *       использования: чтение в строке, запись в ветке латча). Запись стоит ровно между
 *       `D.loaderDoneMap[convId] = true;` и `D.loaderRunningFor = convId;` — в одном блоке
 *       с латчем, как и требовалось: карта не может разойтись с latchem по ветке.
 *   D2  гейт: вызов имеет ровно ту же форму, что соседние диаг-строки файла —
 *       `debugLog('log', '[AI CM][Gemini][loader] …')`, без собственного try/catch: уровень
 *       'log' печатает только utils/debug.js под флагом, а сам вызов стоит ДО проверки латча
 *       и ничего не присваивает, поэтому изменить поток управления не может.
 *   D3  поведение: модуль грузится в vm (как в gemini-overlay-module.test.js), получает
 *       макет зависимостей через __bind, maybeStartLoader не бросает, латч loaderDoneMap
 *       выставляется как прежде (синхронно, в ветке старта), а карта живёт: первый вход
 *       печатает sinceLastRunMs=-1, повторный после снятия латча — sinceLastRunMs>=0.
 *   R1  гигиена: 'loaderRunAtMap' не встречается нигде, кроме TARGET, — ни в core/**, ни в
 *       adapters/**. Карта не утекает в другие модули и не читается чужим кодом.
 *   R2  без гейта строка не печатается: уровень 'log' (а не 'error'/'warn', которые
 *       utils/debug.js печатает ВСЕГДА) + поведенческая проверка — при закрытом гейте
 *       модуль не отдаёт ни одной строки.
 *
 * Логика гардов (v17/v20/v59), латчи loaderDoneMap/loaderRunningFor и ветки
 * cache-complete/data-complete не менялись — это доказывается тем, что существующие
 * пин-сьюты (gemini-overlay-module, gemini-archive-module, gemini-oracle-module,
 * gemini-collapse-guard, archive-export-gate) остаются зелёными без правок.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TARGET_REL = 'core/gemini-loader-scroll.js';
const TARGET = readFile(TARGET_REL);
const CORE = readFile('core/gemini-intercept.js');

const CONV_ID = 'c-reentry';
const DIAG_MARK = '[AI CM][Gemini][loader] auto-start-reentry';

/** Все .js файлы каталога рекурсивно (пути от корня репозитория, через '/'). */
function collectJs(dir, acc) {
  const abs = path.join(ROOT, dir);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dir + '/' + ent.name;
    if (ent.isDirectory()) collectJs(rel, acc);
    else if (ent.name.endsWith('.js')) acc.push(rel);
  }
  return acc;
}

/** Число непересекающихся вхождений подстроки. */
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * Загрузка TARGET в отдельный vm-контекст — как это делает реальный content script:
 * модуль — IIFE, зависимости приходят через __bind, debugLog — глобальная функция
 * utils/debug.js. Гейт 'log' воспроизведён ровно как в utils/debug.js:55-71: пока
 * gateOn не выставлен, строка не печатается.
 */
function loadTarget() {
  const calls = [];
  const state = { gateOn: false };
  const pageWindow = {};
  const ctx = vm.createContext({
    window: pageWindow,
    document: { visibilityState: 'visible', addEventListener() { } },
    console,
    setTimeout,
    clearTimeout,
    debugLog(level, line) {
      if (level === 'error' || level === 'warn') { calls.push({ level, line }); return; }
      if (!state.gateOn) return;
      calls.push({ level, line });
    }
  });
  vm.runInContext(TARGET, ctx, { filename: TARGET_REL });
  return { api: pageWindow.AiCmGeminiLoaderScroll, calls, state, pageWindow };
}

/** Макет объекта связи D: ровно те имена, которые читает путь старта maybeStartLoader. */
function makeDeps(overrides) {
  return Object.assign({
    getConvId() { return CONV_ID; },
    loaderDoneMap: {},
    loaderRetryUsedMap: {},
    cacheRestoredMap: new Map(),
    oracleIncompleteSeen: {},
    oracleRerunUsedMap: {},
    loadFloor() { return { count: 0 }; },
    baseSize() { return 3; },
    aiCmLiveTurnCount() { return 3; },
    aiCmArchiveFor() { return false; },
    olderHistorySeen: true,
    historyFullByQuiet: false,
    reachedStart: false,
    pendingCursor: null,
    loaderRunningFor: null,
    loaderState: {},
    collapseRetries: 0,
    notifyLoaderState() { },
    findScrollContainer() { return null; },
    sleep() { return Promise.resolve(); },
    vf5OverlapSinceLoaderStart: false,
    isLowConfidenceBase: false
  }, overrides || {});
}

// =====================================================================================
// D1-D2: источник и форма гейта
// =====================================================================================
describe('loader-reentry: D1 источник TARGET', () => {
  test('D1: литерал auto-start-reentry и карта loaderRunAtMap на месте', () => {
    expect(countOf(TARGET, 'auto-start-reentry')).toBeGreaterThanOrEqual(1);
    // declare + чтение в строке + запись в ветке латча => минимум три
    expect(countOf(TARGET, 'loaderRunAtMap')).toBeGreaterThanOrEqual(2);
    expect(TARGET).toContain('var loaderRunAtMap = {};');
    expect(TARGET).toContain("'" + DIAG_MARK + " convId='");
    // карта объявлена в TARGET, а не в ядре и не в чужом модуле
    expect(CORE).not.toContain('loaderRunAtMap');
  });

  test('D1: запись карты — в ОДНОМ блоке с латчем (между done и runningFor)', () => {
    const anchor = 'D.loaderDoneMap[convId] = true;\n' +
      '      loaderRunAtMap[convId] = Date.now(); // loader-reentry (v2.0.17): время последнего реального старта\n' +
      '      D.loaderRunningFor = convId;';
    expect(TARGET).toContain(anchor);
    // и запись ровно одна: скип-ветки (cache-complete/data-complete/no-older-history)
    // латч ставят, но прогон не стартуют — карту они не трогают
    expect(countOf(TARGET, 'loaderRunAtMap[convId] = Date.now()')).toBe(1);
  });
});

describe('loader-reentry: D2 гейт диагностики', () => {
  test('D2: форма гейта совпадает с формой соседних диаг-строк файла', () => {
    const at = TARGET.indexOf("debugLog('log', '" + DIAG_MARK);
    expect(at).toBeGreaterThan(-1);
    // соседние строки файла печатаются ровно так же (debugLog уровня + PRESET префикс)
    const sameForm = TARGET.match(/debugLog\('(?:log|error|warn)', '\[AI CM\]\[Gemini\]\[loader\]/g) || [];
    expect(sameForm.length).toBeGreaterThan(20);
  });

  test('D2: вызов стоит ДО проверки латча и не обёрнут в свой try/catch', () => {
    // блок диагностики закрывается сразу перед входом в латч — порядок зафиксирован
    expect(TARGET).toContain("' src=spa');\n" +
      '      if (D.loaderDoneMap[convId]) {');
    // собственной обёртки нет — форма одна с соседними диаг-строками файла
    expect(TARGET).not.toContain('catch (eRe)');
    const diagAt = TARGET.indexOf("'" + DIAG_MARK);
    const latchAt = TARGET.indexOf('if (D.loaderDoneMap[convId]) {');
    expect(diagAt).toBeGreaterThan(-1);
    expect(latchAt).toBeGreaterThan(-1);
    expect(diagAt).toBeLessThan(latchAt);
    // диаг-строка не печатает себя сама и не зовёт console напрямую
    expect(TARGET).not.toContain("console.log('" + DIAG_MARK);
    expect(TARGET).not.toContain("console.log('[AI CM][Gemini][loader] auto-start-reentry");
  });
});

// =====================================================================================
// D3: поведение — латч как прежде, карта живая (измеряет повторный вход)
// =====================================================================================
describe('loader-reentry: D3 поведение в vm', () => {
  test('D3: maybeStartLoader не бросает, латч выставляется как прежде', () => {
    const env = loadTarget();
    expect(env.api).toBeTruthy();
    expect(typeof env.api.maybeStartLoader).toBe('function');
    expect(typeof env.api.__bind).toBe('function');

    const deps = makeDeps();
    expect(() => env.api.__bind(deps)).not.toThrow();
    expect(() => env.api.maybeStartLoader()).not.toThrow();

    // прежнее поведение латча: done + running выставляются синхронно в ветке старта
    expect(deps.loaderDoneMap[CONV_ID]).toBe(true);
    expect(deps.loaderRunningFor).toBe(CONV_ID);
    // и ни один скип-путь не сработал (иначе старт не состоялся бы)
    expect(deps.collapseRetries).toBe(0);
  });

  test('D3: первый вход sinceLastRunMs=-1, повторный после снятия латча — >= 0', () => {
    const env = loadTarget();
    env.state.gateOn = true; // гейт открыт — строки видны в calls

    const deps = makeDeps();
    env.api.__bind(deps);
    env.api.maybeStartLoader();

    const first = env.calls.filter((c) => c.line.indexOf(DIAG_MARK) !== -1);
    expect(first.length).toBe(1);
    expect(first[0].level).toBe('log');
    expect(first[0].line).toContain('convId=' + CONV_ID);
    expect(first[0].line).toContain('sinceLastRunMs=-1'); // карты ещё нет
    expect(first[0].line).toContain('src=spa');            // сигнатуры с src нет — литерал
    // остальные поля формата на месте
    expect(first[0].line).toMatch(/^\[AI CM\]\[Gemini\]\[loader\] auto-start-reentry convId=\S+ sinceLastRunMs=-?\d+ src=\S+$/);

    // SPA-возврат в тот же чат: ядро снимает done-флаг (checkConvChange) — повторный вход
    delete deps.loaderDoneMap[CONV_ID];
    deps.loaderRunningFor = null;
    expect(() => env.api.maybeStartLoader()).not.toThrow();

    const all = env.calls.filter((c) => c.line.indexOf(DIAG_MARK) !== -1);
    expect(all.length).toBe(2);
    const m = /sinceLastRunMs=(-?\d+)/.exec(all[1].line);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(0); // карта записана прошлым стартом
    expect(deps.loaderDoneMap[CONV_ID]).toBe(true);
  });
});

// =====================================================================================
// R1-R2: гигиена карты и молчание без гейта
// =====================================================================================
describe('loader-reentry: R1 карта не читается вне TARGET', () => {
  test('R1: loaderRunAtMap есть только в TARGET (core/** и adapters/**)', () => {
    const files = collectJs('core', []).concat(collectJs('adapters', []));
    const hits = files.filter((rel) => countOf(readFile(rel), 'loaderRunAtMap') > 0);
    expect(hits).toEqual([TARGET_REL]);
    // для контроля: ядро (владелец латчей) карту не упоминает вовсе
    expect(countOf(CORE, 'loaderRunAtMap')).toBe(0);
  });
});

describe('loader-reentry: R2 без гейта строка не печатается', () => {
  test('R2: уровень log (не error/warn) — иначе utils/debug.js печатает всегда', () => {
    const at = TARGET.indexOf("'" + DIAG_MARK);
    expect(at).toBeGreaterThan(39);
    expect(TARGET.slice(at - 40, at)).toContain("debugLog('log', ");
    expect(TARGET.slice(at - 40, at)).not.toContain("debugLog('error'");
    expect(TARGET.slice(at - 40, at)).not.toContain("debugLog('warn'");
    // гейт жив: 'log' под флагом, 'error'/'warn' — всегда (utils/debug.js:61-71)
    const dbg = readFile('utils/debug.js');
    expect(dbg).toContain("if (level === 'error' || level === 'warn') {");
    expect(dbg).toContain('var enabled = DEBUG;');
    expect(dbg).toContain('if (enabled) {');
  });

  test('R2: при закрытом гейте модуль не отдаёт строку сам', () => {
    const env = loadTarget();
    const deps = makeDeps();
    env.api.__bind(deps);

    env.state.gateOn = false;
    env.api.maybeStartLoader();
    expect(env.calls.filter((c) => c.line.indexOf(DIAG_MARK) !== -1)).toHaveLength(0);

    // тот же вход при открытом гейте — строка появляется (значит печать идёт ТОЛЬКО гейтом)
    env.state.gateOn = true;
    delete deps.loaderDoneMap[CONV_ID];
    deps.loaderRunningFor = null;
    env.api.maybeStartLoader();
    expect(env.calls.filter((c) => c.line.indexOf(DIAG_MARK) !== -1)).toHaveLength(1);
  });
});
