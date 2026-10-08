/**
 * Phase 3 шаг 12 — R-D пины кластера ingest (core/gemini-ingest.js).
 *
 * Контекст. Ingest-кластер вынесен из core/gemini-intercept.js в core/gemini-ingest.js
 * скриптом tools/apply-ingest-extraction.js (--apply): 72 зависимости передаются ядром
 * в `aiCmGeminiIngest.__bind({...})`, наружу модуль отдаёт 16 функций + `__bind`.
 * Модуль написан в стиле шага 10: тела объявлены ВНУТРИ `with (D)`, экспорт —
 * `Fn.<имя> = <имя>;` (прецедент — core/pagination/pagination.js).
 *
 * Что закрывает этот файл. Вынос не должен поменять ни один путь записи базы и ни одну
 * точку выхода снимка — иначе регрессия тихая (модуль связан, ядро зелёное, ходы
 * теряются). Поэтому пины двух родов:
 *
 *   R-D (маршруты записи базы и точка выхода):
 *     №1  до __bind наружу торчит ТОЛЬКО __bind — несвязанное состояние не утекает
 *         (функции появляются на Fn.* внутри with (D), то есть связка обязательна);
 *     №2  после __bind в API ровно 17 ключей = 16 функций + __bind;
 *     №3  форвардеры ядра aiCmIngestFwd / aiCmHandleOuterFwd / aiCmEmitBaseSnapshotFwd
 *         объявлены и подставлены в те же точки, а прямой проводки мимо них нет;
 *     №4  счётчик emitBaseSnapshot(): ядро 3 (2 вызова + 1 форвардер),
 *         конкатенация 9 = 3 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова)
 *         + 1 (archive: вызов в слушателе ai-cm-archive-restore);
 *     №5  порядок модулей в tests/helpers/gemini-intercept-source.js: ingest строго
 *         после gemini-loader-scroll.js и перед ядром — иначе в модуль уедет null
 *         (alias-зависимости дозаполняет блок __bind loader-scroll, см. шапку контракта);
 *     NOT в модуле нет `D.`-префиксов — связка идёт только через `with (D)`.
 *
 *   S (проводка):
 *     S1  регистрация в core/background.js: id -v8, js[] с ingest строго после
 *         loader-scroll и перед ядром, -v7 в unregister (MV3 не перечитывает js[]
 *         под уже зарегистрированным id);
 *     S2  bind-контракт полон: все 72 имени контракта переданы ядром в блоке __bind
 *         и все 72 реально используются модулем.
 *
 * ВАЖНО ПРО НОМЕРА СТРОК. Точки подстановки форвардеров (230/303/348/431/432) —
 * как в утверждённом плане шага. Хвостовой вызов vf5 план называет строкой 1941:
 * это номер в ДО-выносом ядре; вынос срезал ~157 строк выше него, поэтому в текущем
 * core/gemini-intercept.js вызов стоит на 1784. Пин проверяет и литерал вызова, и
 * его фактическую строку (см. R-D №3), чтобы «уехавший» вызов был виден.
 *
 * ВАЖНО: существующие пины Gemini НЕ трогались — этот файл только ДОБАВЛЯЕТ покрытие.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CONC = require(path.join(ROOT, 'tests/helpers/gemini-intercept-source.js')).geminiSource;
const CORE = readFile('core/gemini-intercept.js');
const MOD = readFile('core/gemini-ingest.js');
const ARCH = readFile('core/gemini-archive.js');
const PAG = readFile('core/pagination/pagination.js');

/** 16 экспортов модуля — в порядке `Fn.<имя> = <имя>;` (core/gemini-ingest.js:1231-1246). */
const EXPORTED = [
  'firstRc', 'logIdmap', 'ingestAttachments', 'extractModelName', 'extractTurnId',
  'extractTurnTs', 'extractTurnR1', 'handleOuter', 'rontgenPagination', 'shouldPollVf5',
  'startRefreshObserver', 'emitBaseSnapshot', 'applyStreamAliases', 'ingest',
  'sanitizeRestoredTurn', 'mergeRestoredTurns',
];

/** Объявления форвардеров (ядро, строки 645-647): имя -> точный текст. */
const FORWARDER_DEF = {
  aiCmIngestFwd: 'function aiCmIngestFwd(raw, opts) { return ingest ? ingest(raw, opts) : undefined; }',
  aiCmHandleOuterFwd: 'function aiCmHandleOuterFwd(outer, out_, src) { return handleOuter ? handleOuter(outer, out_, src) : undefined; }',
  aiCmEmitBaseSnapshotFwd: 'function aiCmEmitBaseSnapshotFwd() { return emitBaseSnapshot ? emitBaseSnapshot() : undefined; }',
};

/**
 * Хвостовая точка выхода vf5 — единственный вызов ingest из ядра после выноса
 * (план: строка 1941 в до-выносом ядре; факт: 1784, см. шапку файла).
 */
const VF5_TAIL = 'aiCmIngestFwd(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });';

/** Номера строк (1-based) всех вхождений литерала. */
function linesOf(src, lit) {
  return src.split('\n').reduce((acc, line, i) => (line.indexOf(lit) !== -1 ? acc.concat(i + 1) : acc), []);
}

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

/** Грузит РЕАЛЬНЫЙ модуль в свежий vm-контекст и возвращает его API до связки. */
function loadModule() {
  const pageWindow = {};
  const ctx = vm.createContext({ window: pageWindow, console, setTimeout, clearTimeout, Promise });
  vm.runInContext(MOD, ctx, { filename: 'core/gemini-ingest.js' });
  return { pageWindow, ctx, api: pageWindow.AiCmGeminiIngest };
}

describe('Phase 3 шаг 12: R-D пины кластера ingest (core/gemini-ingest.js)', () => {
  test('R-D №1: до __bind наружу торчит ТОЛЬКО __bind — несвязанное состояние не утекает', () => {
    const { pageWindow, ctx, api } = loadModule();
    expect(api).toBeTruthy();
    expect(typeof api.__bind).toBe('function');
    // Функции появляются на Fn.* ВНУТРИ with (D): без связки их нет вообще.
    expect(Object.keys(api)).toEqual(['__bind']);
    EXPORTED.forEach((n) => expect(api[n]).toBeUndefined());

    // повторная загрузка не перетирает API (иначе второй скрипт обнулил бы первый bind)
    vm.runInContext(MOD, ctx, { filename: 'core/gemini-ingest.js (повторно)' });
    expect(pageWindow.AiCmGeminiIngest).toBe(api);

    // ни одна константа/переменная модуля не утекла в глобаль модуля
    expect(ctx.IMAGE_DEFAULT_TOKENS).toBeUndefined();
    expect(ctx.DOC_EST_TOKENS).toBeUndefined();
    expect(ctx.IDMAP_MAX).toBeUndefined();
    expect(ctx.D).toBeUndefined();
  });

  test('R-D №2: после __bind API = 16 функций + __bind (17 ключей)', () => {
    // `__bind({})` не бросает: тело with (D) — только декларации и присваивания Fn.*,
    // ни один оператор верхнего уровня не требует зависимости.
    const { api } = loadModule();
    expect(() => api.__bind({})).not.toThrow();
    const keys = Object.keys(api).sort();
    expect(keys).toHaveLength(17);
    expect(keys).toEqual(['__bind'].concat(EXPORTED).sort());
    EXPORTED.forEach((n) => expect(typeof api[n]).toBe('function'));

    // экспорт идёт ровно стилем шага 10: `Fn.<имя> = <имя>;` внутри with (D)
    const body = MOD.slice(MOD.indexOf('function __bind(d) {'), MOD.indexOf('Fn.__bind = __bind;'));
    EXPORTED.forEach((n) => expect(body).toContain('Fn.' + n + ' = ' + n + ';'));
  });

  test('R-D №3: форвардеры ядра стоят в тех же точках подстановки (230/303/348/431/432)', () => {
    Object.keys(FORWARDER_DEF).forEach((n) => {
      expect(CORE).toContain(FORWARDER_DEF[n]);
    });
    // точки подстановки — в блоках __bind ранних модулей (rpc / sse / главный блок)
    expect(linesOf(CORE, 'ingest: aiCmIngestFwd,')).toEqual([230, 348, 432]);
    expect(linesOf(CORE, 'handleOuter: aiCmHandleOuterFwd,')).toEqual([303]);
    expect(linesOf(CORE, 'emitBaseSnapshot: aiCmEmitBaseSnapshotFwd,')).toEqual([431]);

    // алиасы ядра заполняются из модуля сразу после __bind — форвардер обязан быть
    // подставлен ДО того, как ранние блоки начнут звать ingest (иначе null-вызов)
    expect(CORE).toContain('ingest = aiCmGeminiIngest.ingest;');
    expect(CORE).toContain('handleOuter = aiCmGeminiIngest.handleOuter;');
    expect(CORE).toContain('emitBaseSnapshot = aiCmGeminiIngest.emitBaseSnapshot;');
    expect(CORE).toContain('mergeRestoredTurns = aiCmGeminiIngest.mergeRestoredTurns;');
    expect(CORE.indexOf('ingest: aiCmIngestFwd,')).toBeLessThan(CORE.indexOf('aiCmGeminiIngest.__bind'));

    // прямой проводки мимо форвардера нет: иначе поздняя связка отдала бы null.
    // Phase 3 step 13.2: пин emitBaseSnapshot СУЖЕН до блока ingest. Блок архива
    // стоит НИЖЕ заполнения алиасов (770-771) и вправе отдать alias ЗНАЧЕНИЕМ — там он уже
    // не null; этот случай закрыт отдельным пином в tests/adapters/gemini-archive-module.test.js.
    expect(CORE).not.toContain('ingest: ingest,');
    expect(CORE).not.toContain('handleOuter: handleOuter,');
    const ingestBindAt = CORE.indexOf('aiCmGeminiIngest.__bind(');
    expect(ingestBindAt).toBeGreaterThan(-1);
    const ingestBind = CORE.slice(ingestBindAt, CORE.indexOf('});', ingestBindAt));
    expect(ingestBind).not.toContain('emitBaseSnapshot: emitBaseSnapshot,');

    // хвостовая точка выхода vf5 — ровно один вызов, ровно с этими опциями
    expect(CORE.match(new RegExp(VF5_TAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    // план называет 1941 (до-выносом ядро); после выноса ingest — 1784; после выноса
    // кластера оверлея (Phase 3 step 13.1: −143 строки диапазона 1597-1739 и +39 строк
    // блока подключения ВЫШЕ этой точки) — 1680; после выноса оракула (Phase 3 step 13.3:
    // −266 строк диапазонов 866-909, 1001-1155, 1372-1436 и +32 строки секции форвардеров
    // ВЫШЕ этой точки) — 1446. Пин держит ФАКТ, чтобы «уехавший» вызов был виден, а не молча
    // остался зелёным, и чтобы следующий перенос кода выше по файлу снова потребовал ревью
    // строки, а не прошёл незамеченным.
    expect(linesOf(CORE, VF5_TAIL)).toEqual([1446]);
  });

  test('R-D №4: счётчик emitBaseSnapshot() — ядро 1, конкатенация 9', () => {
    // ядро: 1 форвардер aiCmEmitBaseSnapshotFwd. Третий вызов (слушатель ai-cm-archive-restore)
    // на шаге 13.2 уехал в core/gemini-archive.js, а два ядерных вызова (floor-confirm и
    // self-heal) на шаге 13.3 уехали в core/gemini-oracle.js — там они и считаются ниже.
    expect(CORE.match(/emitBaseSnapshot\(\)/g)).toHaveLength(1);
    expect(CORE.match(/try \{ emitBaseSnapshot\(\); \}/g) || []).toHaveLength(0);
    // архив: 1 вызов (пере-эмит после вливания ходов архива)
    expect(ARCH.match(/emitBaseSnapshot\(\)/g)).toHaveLength(1);
    // оракул: 2 вызова (floor-confirmed и loader-stable-stop), оба под try
    const ORACLE = readFile('core/gemini-oracle.js');
    expect(ORACLE.match(/emitBaseSnapshot\(\)/g)).toHaveLength(2);
    expect(ORACLE.match(/try \{ emitBaseSnapshot\(\); \}/g)).toHaveLength(2);
    // пагинация отдаёт свои 2 вызова (finishQuiet / runCompletenessProbe)
    expect(PAG.match(/emitBaseSnapshot\(\)/g)).toHaveLength(2);
    // ingest: 1 декларация `function emitBaseSnapshot()` + 2 вызова (ingest и mergeRestoredTurns)
    expect(MOD.match(/emitBaseSnapshot\(\)/g)).toHaveLength(3);
    expect(linesOf(MOD, 'function emitBaseSnapshot()')).toEqual([459]);
    // E.2a.2a: тело catch инструментировано swallow (LOG-точка P0). Расхождение с
    // до-E.2a.2a эталоном — ровно эта одна строка; сам вызов emitBaseSnapshot() и
    // его try-обёртка не менялись, поэтому R-D маршрут записи базы прежний.
    // Step E.2c-B2b-3a (swallowSoft): тот же catch переведён на канал B —
    // `swallowSoft(e, 'gemini:mergeRestoredTurns-emit')`.
    expect(fnSource(MOD, 'mergeRestoredTurns')).toContain('try { emitBaseSnapshot(); } catch (e) { swallowSoft(e, \'gemini:mergeRestoredTurns-emit\'); }');
    // арифметика конкатенации: 1 (ядро-форвардер) + 2 (пагинация) + 3 (ingest) + 1 (архив) + 2 (оракул) = 9
    expect(CONC.match(/emitBaseSnapshot\(\)/g)).toHaveLength(9);
  });

  test('R-D №5: ingest строго после loader-scroll и перед ядром в helper-конкатенации', () => {
    const SRC = require(path.join(ROOT, 'tests/helpers/gemini-intercept-source.js'));
    // alias-зависимости (extractCursor, classifyOpaque, parseBatchExecute, paginateLoop…)
    // дозаполняет блок __bind РАННЕГО модуля loader-scroll (см. шапку контракта),
    // поэтому ingest обязан грузиться после него, но до ядра, которое его связывает.
    expect(SRC.MODULES).toContain('core/gemini-ingest.js');
    expect(SRC.MODULES.indexOf('core/gemini-ingest.js'))
      .toBeGreaterThan(SRC.MODULES.indexOf('core/gemini-loader-scroll.js'));
    expect(SRC.SOURCES.indexOf('core/gemini-ingest.js'))
      .toBeLessThan(SRC.SOURCES.indexOf('core/gemini-intercept.js'));
    // конкатенация склеивается в том же порядке, что и js[] в манифесте
    expect(CONC.indexOf(MOD)).toBeGreaterThan(CONC.indexOf(readFile('core/gemini-loader-scroll.js')));
    expect(CONC.indexOf(MOD)).toBeLessThan(CONC.indexOf(CORE));
  });

  test('R-D NOT: в модуле нет `D.`-префиксов — связка идёт только через with (D)', () => {
    // Стиль шага 10: свободные имена резолвятся объектом связки. `D.имя` означало бы,
    // что часть зависимостей берётся в обход with (D) — то есть мимо контракта.
    expect(MOD).not.toMatch(/(?<![\w$.])D\s*\./);
    expect(MOD).toContain('with (D) {');
    // гигиена модуля: with несовместим со strict, innerHTML запрещён privacy-правилом
    expect(MOD).not.toMatch(/^\s*'use strict'/m);
    expect(MOD).not.toMatch(/innerHTML\s*=/);
  });
});

describe('Phase 3 шаг 12: S-пины проводки модуля', () => {
  test('S1: регистрация в core/background.js — id -v11 (шаг 13.3), ingest, overlay, archive и oracle перед ядром, -v10 снят', () => {
    const bg = readFile('core/background.js');
    expect(bg).toContain("'ai-cm-gemini-intercept-v11'");
    expect(bg).toContain("'core/gemini-ingest.js'");
    // js[] собран ровно в этом порядке: sse → pagination → loader-scroll → ingest → ядро
    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-oracle.js', 'core/gemini-intercept.js'");
    // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при загрузке
    expect(bg.indexOf("'core/gemini-loader-scroll.js'")).toBeLessThan(bg.indexOf("'core/gemini-ingest.js'"));
    expect(bg.indexOf("'core/gemini-ingest.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
    // MV3 не перечитывает js[] под существующим id — прежний id обязан быть снят
    expect(bg).toContain("'ai-cm-gemini-intercept-v10'");
  });

  test('S2: bind-контракт полон — 72 имени переданы ядром и все 72 используются модулем', () => {
    const contract = require(path.join(ROOT, 'tools/ingest-bind-contract.js'));
    const names = contract.map(([name]) => name);
    expect(contract).toHaveLength(72);
    expect(new Set(names).size).toBe(72); // дубликат = имя передаётся дважды, контракт врёт

    // каждое имя контракта реально упоминается в теле модуля
    const unused = names.filter((n) => (MOD.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length === 0);
    expect(unused).toEqual([]);

    // …и передаётся ядром в __bind. Проверяем ИМЕННО блок __bind: имя может
    // встречаться в ядре и вне связки — это не передача.
    const bindAt = CORE.indexOf('aiCmGeminiIngest.__bind');
    expect(bindAt).toBeGreaterThan(-1);
    const block = CORE.slice(bindAt, CORE.indexOf('} else {', bindAt));
    const notProvided = names.filter((n) => !new RegExp('(?:^|[\\s,{])' + n + '\\s*[:,(]', 'm').test(block));
    expect(notProvided).toEqual([]);

    // rw-зависимости обязаны быть ЖИВЫМИ (get+set): присваивание в accessor без
    // сеттера в sloppy-with не бросает — ядро молча осталось бы со старым значением
    const rw = contract.filter(([, kind]) => kind === 'rw').map(([name]) => name);
    expect(rw.filter((n) => !new RegExp('get\\s+' + n + '\\s*\\(\\)').test(block))).toEqual([]);
    expect(rw.filter((n) => !new RegExp('set\\s+' + n + '\\s*\\(').test(block))).toEqual([]);
    // ro-зависимости — только чтение: сеттер означал бы, что модуль пишет в них
    const ro = contract.filter(([, kind]) => kind === 'ro').map(([name]) => name);
    expect(ro.filter((n) => new RegExp('set\\s+' + n + '\\s*\\(').test(block))).toEqual([]);
  });
});
