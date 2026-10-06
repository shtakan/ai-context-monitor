/**
 * Phase 3 шаг 10 — R-D пины кластера пагинации (core/pagination/pagination.js).
 *
 * Что закрывает этот файл. Кластер пагинации вынесен из core/gemini-intercept.js
 * без изменения поведения, поэтому пины здесь двух родов:
 *
 *   D (маршруты записи базы) — каждый путь, которым кластер кладёт ходы в базу,
 *   обязан остаться в модуле и остаться тем же вызовом, каким был до выноса:
 *     D1  paginateLoop      → ingest(..., { fromActivePaginate: true }) — единственный
 *                             вызов записи базы внутри кластера;
 *     D2  shadow-probe      → parseBatchExecute под save/restore pendingCursor/
 *                             cursorEpoch/olderHistorySeen: probe НЕ имеет права
 *                             мутировать состояние пагинации, иначе следующий шаг
 *                             уйдёт не туда (объявление — v72diag);
 *     D3  runCompletenessProbe → тот же save/restore + восстановление retained-метаданных
 *                             (H9b) сразу после сборки запроса;
 *     D4  vf5/точка выхода   → emitBaseSnapshot() в finishQuiet и в probe-terminal;
 *     D5  контроль полноты   → watchdog сбрасывает loaderDoneMap, снимает полноту и
 *                             перезапускает лоадер (≤3) — иначе deadlock не разрывается;
 *     D6  одна точка записи  → прямых присваиваний в turnsMap в модуле нет.
 *
 *   S (проводка) — модуль реально подключён и связан с ядром:
 *     S1  регистрация в core/background.js: id -v6, js[] 10 файлов, модуль ПЕРЕД ядром,
 *         -v5 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
 *     S2  bind-контракт полон: 71 зависимость передана и все 71 используются
 *         (регрессия = молчаливый no-op, который ни один старый пин не видит);
 *     S3  проза модуля не затеняет литералы существующих пинов (иначе пин меряет шапку);
 *     S4  деградация без модуля: внятный лог и 13 заглушек вместо функций;
 *     S5  модуль связывается вживую: API, with(D), запись идёт в переменные ЯДРА;
 *     S6  модуль не попал под strict/innerHTML.
 *
 * ВАЖНО: существующие пины Gemini (O-48…O-52, H13, archive-oracle) НЕ трогались —
 * ради этого тела перенесены байт-в-байт с голыми идентификаторами и `with (D)`.
 * Этот файл только ДОБАВЛЯЕТ покрытие маршрутов, которых раньше не было.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CONC = require(path.join(ROOT, 'tests/helpers/gemini-intercept-source.js')).geminiSource;
const CORE = readFile('core/gemini-intercept.js');
const MOD = readFile('core/pagination/pagination.js');

const EXPORTED = [
  'classifyOpaque', 'edges8', 'walkOpaque', 'findCursors', 'extractCursor',
  'classifyOpaqueWide', 'extractCursorWide', 'refreshMinOrderTracking',
  'paginateLoop', 'finishQuiet', 'runCompletenessProbe',
  'runCompletenessWatchdog', 'finishWatchdogDecision',
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

/** Заменяет комментарии пробелами, сохраняя длину и переводы строк. */
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(Math.max(0, m.length - p.length)));
}

describe('Phase 3 шаг 10: D-пины маршрутов записи базы (core/pagination/pagination.js)', () => {
  test('D1: шаг пагинации пишет в базу единственным вызовом ingest — тем же, что до выноса', () => {
    const body = fnSource(MOD, 'paginateLoop');
    expect(body).toContain('var added = ingest(txt, { emitOnlyIfAdded: true, fromActivePaginate: true });');
    // во всём кластере ровно ОДИН вызов ingest: пагинация не завела второй конвейер записи
    expect(MOD.match(/ingest\(/g)).toHaveLength(1);
    // ingest различает источники по src — пагинация обязана остаться src='pag'
    expect(CONC).toContain("var src = srcOverride || (fromVirtualF5 ? 'vf5' : (fromActivePaginate ? 'pag' : 'passive'));");
  });

  test('D2: shadow-probe НЕ мутирует состояние пагинации (save/restore на месте)', () => {
    const body = fnSource(MOD, 'paginateLoop');
    expect(body).toContain('var savedCursorSh = pendingCursor;');
    expect(body).toContain('var savedEpochSh = cursorEpoch;');
    expect(body).toContain('var savedOlderSh = olderHistorySeen;');
    expect(body).toContain("var shParsed = parseBatchExecute(shTxt, 'sh');");
    // восстановление идёт ВСЛЕД за парсом, до любой ветки по результату
    const parseAt = body.indexOf("parseBatchExecute(shTxt, 'sh')");
    const restoreAt = body.indexOf('pendingCursor = savedCursorSh;');
    expect(restoreAt).toBeGreaterThan(parseAt);
    expect(body.indexOf('olderHistorySeen = savedOlderSh;')).toBeGreaterThan(restoreAt);
    // и это остаётся ДИАГНОСТИКОЙ: probe только логирует (v72diag — «состояние НЕ меняем»)
    expect(body).toContain("debugLog('log', '[AI CM][cursor-diag] shadow-probe result ходов='");
    expect(body).not.toContain('shadow-probe запись');
  });

  test('D3: probe-ответ парсится с тем же save/restore, retained-метаданные возвращаются', () => {
    const body = fnSource(MOD, 'runCompletenessProbe');
    expect(body).toContain('var savedCursorP = pendingCursor, savedEpochP = cursorEpoch, savedOlderP = olderHistorySeen;');
    expect(body).toContain("var pParsed = parseBatchExecute(pTxt, 'pb');");
    expect(body.indexOf('pendingCursor = savedCursorP')).toBeGreaterThan(body.indexOf("parseBatchExecute(pTxt, 'pb')"));
    // H9b: подменённые на время запроса метаданные возвращаются сразу после сборки запроса
    expect(body).toContain('lastAtEncoded = __pMetaSavedH9b.a;');
    expect(body).toContain('lastBaseUrl = __pMetaSavedH9b.b;');
    expect(body).toContain('lastHeaders = __pMetaSavedH9b.h;');
    const reqAt = body.indexOf('buildActiveBodyWith(wideCur)');
    expect(body.indexOf('lastAtEncoded = __pMetaSavedH9b.a;')).toBeGreaterThan(reqAt);
  });

  test('D4: точка выхода снимка базы — emitBaseSnapshot, ровно два вызова, оба в кластере', () => {
    expect(MOD.match(/emitBaseSnapshot\(\)/g)).toHaveLength(2);
    expect(fnSource(MOD, 'finishQuiet')).toContain('if (success) { try { emitBaseSnapshot(); } catch (e) { } }');
    expect(fnSource(MOD, 'runCompletenessProbe')).toContain('try { emitBaseSnapshot(); } catch (eE) { }');
    // Phase 3 step 12: три вызова (747, 988, 3157) уехали из ядра в core/gemini-ingest.js,
    // поэтому в ядре 4 = 3 вызова + 1 форвардер aiCmEmitBaseSnapshotFwd (шаг 12, TDZ),
    // а в конкатенации 9 = 4 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова).
    expect(CORE.match(/emitBaseSnapshot\(\)/g)).toHaveLength(4);
    expect(CONC.match(/emitBaseSnapshot\(\)/g)).toHaveLength(9);
  });

  test('D5: контроль полноты разрывает deadlock — сброс loaderDoneMap, снятие полноты, ≤3 ретрая', () => {
    const quiet = fnSource(MOD, 'finishQuiet');
    expect(quiet).toContain('try { runCompletenessWatchdog(getConvId()); } catch (eW) { }');
    // решение по итогам сверки — в finishWatchdogDecision (единая точка, а не три копии)
    const wd = fnSource(MOD, 'runCompletenessWatchdog');
    const dec = fnSource(MOD, 'finishWatchdogDecision');
    expect(dec).toContain('delete loaderDoneMap[convId];');
    expect(dec).toContain('if (completenessWatchdogRetries[convId] <= 3) {');
    expect(dec).toContain('try { maybeStartLoader(); } catch (eR) { }');
    // watchdog-fail снимает полноту — иначе «полная» база осталась бы на усечённой
    expect(dec).toContain('historyFullByQuiet = false;');
    expect(dec).toContain('reachedStart = false;');
    expect(dec).toContain('quietDecisionMade = false;');
    // и потолок ретраев держится в watchdog, а не в решении
    expect(wd).toContain('if (retries >= 3) {');
    expect(wd).toContain("'[AI CM][completeness] watchdog=capped retries='");
  });

  test('D6: кластер НЕ стал второй точкой записи — прямых присваиваний в turnsMap нет', () => {
    // единственное упоминание turnsMap в модуле — чтение минимума order; запись ходов идёт
    // через ingest. Прямая запись означала бы второй конвейер мимо ingest (см. D1).
    const rmt = fnSource(MOD, 'refreshMinOrderTracking');
    expect(rmt).toContain('var o = turnsMap[k] && turnsMap[k].order;');
    expect(MOD).not.toMatch(/turnsMap\[[^\]]+\]\s*=\s*(?!=)/);
  });
});

describe('Phase 3 шаг 10: S-пины проводки модуля', () => {
  test('S1: регистрация в core/background.js — id -v9 (шаг 13.1), модуль перед ядром, -v8 в unregister', () => {
    const bg = readFile('core/background.js');
    expect(bg).toContain("'ai-cm-gemini-intercept-v6'");
    expect(bg).toContain("'core/pagination/pagination.js'");
    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-intercept.js'");
    // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при загрузке
    expect(bg.indexOf("'core/pagination/pagination.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
    // MV3 не перечитывает js[] под существующим id — прежний id обязан быть снят
    expect(bg).toContain("'ai-cm-gemini-intercept-v5'");
  });

  test('S2: bind-контракт полон — ни одна зависимость кластера не потеряна', () => {
    const contract = require(path.join(ROOT, 'tools/pagination-bind-contract.js'));
    const names = contract.map(([name]) => name);
    // каждое имя контракта реально упоминается в теле модуля (однократно — норма:
    // половина зависимостей нужна ровно в одной строке)
    const unused = names.filter((n) => (MOD.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length === 0);
    expect(unused).toEqual([]);
    // …и передаётся ядром в __bind (как значение, геттер или сеттер). Проверяем ИМЕННО
    // блок __bind: имя может встречаться в ядре и вне связки — это не передача.
    const bindAt = CORE.indexOf('aiCmGeminiPagination.__bind');
    const block = CORE.slice(bindAt, CORE.indexOf('} else {', bindAt));
    const notProvided = names.filter((n) => !new RegExp('(?:^|[\\s,{])' + n + '\\s*[:,(]', 'm').test(block));
    expect(notProvided).toEqual([]);
    // 71 имя — зафиксированная величина шага; падение = молчаливый no-op
    expect(contract).toHaveLength(71);
    // rw-зависимости обязаны быть ЖИВЫМИ (геттер+сеттер), иначе запись модуля разошлась бы
    // с ядром ровно там, где ошибается полнота
    const rw = contract.filter(([, kind]) => kind === 'rw').map(([name]) => name);
    const copied = rw.filter((n) => !new RegExp('get\\s+' + n + '\\s*\\(\\)').test(block));
    expect(copied).toEqual([]);
    const ro = contract.filter(([, kind]) => kind === 'ro').map(([name]) => name);
    const overWired = ro.filter((n) => new RegExp('set\\s+' + n + '\\s*\\(').test(block));
    expect(overWired).toEqual([]);
  });

  test('S3: проза модуля не затеняет литералы существующих пинов', () => {
    // Тот же механизм, что в tools/check-pagination-comment-shadows.js, но локально и без
    // git: проверяем литералы, которые ищутся первым вхождением по ВСЕЙ конкатенации.
    const blanked = blankComments(CONC);
    const LIT = [
      'paginateErrorEscalation',                            // gemini-err1177-bypass.test.js:105 (порядок)
      '[AI CM][1177-bypass] escalate-native-scroll',         // …:106
      '[AI CM][cold-debug] pag-error-retry окно повторяется', // …:104
      'function finishQuiet(success, reason) {',             // gemini-floor-confirmed.test.js:227
    ];
    // Сознательно НЕ включён литерал '// v68: сервер-авторитетное решение…' из того же
    // теста (:107): это МАРКЕРНЫЙ пин по комментарию в коде (та же договорённость, что
    // '// v1.14.2 (COLLAPSE-GUARD)' в gemini-collapse-guard.test.js:77). Для таких
    // литералов первым вхождением и должна быть ПРОЗА — проверять тут нечего.
    // Зато он остаётся в tools/check-pagination-comment-shadows.js как «тень была и раньше».
    const shadows = LIT.filter((lit) => {
      const raw = CONC.indexOf(lit);
      return raw !== -1 && blanked.indexOf(lit) !== raw; // первое вхождение — комментарий
    });
    expect(shadows).toEqual([]);
  });

  test('S4: без модуля ядро деградирует мягко — внятный лог и 13 заглушек', () => {
    const start = CORE.indexOf("debugLog('log', '[gemini-intercept] core/pagination/pagination.js не подключён");
    expect(start).toBeGreaterThan(-1);
    // ветка else заканчивается на её собственном закрывающем `}` (двухотступном)
    const elseBranch = CORE.slice(start, CORE.indexOf('\n  }\n', start));
    expect(elseBranch).toContain('core/pagination/pagination.js не подключён');
    // каждая из 13 функций объявлена в ветке else — иначе вызов был бы ReferenceError
    const missing = EXPORTED.filter((n) => !new RegExp('\\n\\s+' + n + '\\s*=\\s*function').test(elseBranch));
    expect(missing).toEqual([]);
    // и ветка ограничена заглушками: 2 строки комментария + лог + 13 присваиваний
    expect(elseBranch.split('\n').length).toBeLessThan(25);
    expect(elseBranch).not.toContain('throw');
  });

  test('S5: модуль связывается вживую — API, with(D), запись идёт в переменные ЯДРА', () => {
    const pageWindow = {};
    const ctx = vm.createContext({ window: pageWindow, console, setTimeout, clearTimeout, Promise });
    vm.runInContext(MOD, ctx, { filename: 'core/pagination/pagination.js' });
    const api = pageWindow.AiCmGeminiPagination;
    expect(api).toBeTruthy();
    expect(typeof api.__bind).toBe('function');
    // ДО __bind наружу торчит только __bind: функции появляются на Fn.* ВНУТРИ with (D),
    // то есть связка — обязательный шаг, а не украшение (см. шапку модуля).
    expect(Object.keys(api)).toEqual(['__bind']);
    EXPORTED.forEach((n) => expect(api[n]).toBeUndefined());

    // повторная загрузка не перетирает API (иначе второй скрипт отключил бы первый bind)
    vm.runInContext(MOD, ctx, { filename: 'core/pagination/pagination.js (повторно)' });
    expect(pageWindow.AiCmGeminiPagination).toBe(api);

    // __bind ставит зависимости и отдаёт рабочие функции; пишем живую переменную
    const live = { minOrderSeen: 0, lastOlderNonPagAddAt: 0, turnsMap: {} };
    const dep = function () { return undefined; };
    api.__bind(Object.assign({
      get minOrderSeen() { return live.minOrderSeen; },
      set minOrderSeen(v) { live.minOrderSeen = v; },
      get lastOlderNonPagAddAt() { return live.lastOlderNonPagAddAt; },
      set lastOlderNonPagAddAt(v) { live.lastOlderNonPagAddAt = v; },
      turnsMap: live.turnsMap,
    }, new Proxy({}, { get: () => dep })));

    // ПОСЛЕ связки наружу торчат все 13 функций
    EXPORTED.forEach((n) => expect(typeof api[n]).toBe('function'));

    // refreshMinOrderTracking обязан писать в ПЕРЕМЕННУЮ ЯДРА, а не в копию
    // минимум берётся из turnsMap ЯДРА, поэтому наполняем именно его
    live.turnsMap.t1 = { order: 1 };
    live.turnsMap.t3 = { order: 3 };
    live.minOrderSeen = 9; // выше любого минимума → условие понижения сработает
    api.refreshMinOrderTracking('pag');
    expect(live.minOrderSeen).toBe(1);
    // понижение вне 'pag' — единственный источник lastOlderNonPagAddAt (scroll-proof)
    live.minOrderSeen = 9;
    api.refreshMinOrderTracking('passive');
    expect(live.minOrderSeen).toBe(1);
    expect(live.lastOlderNonPagAddAt).toBeGreaterThan(0);
    // и ни одна инжектированная зависимость не утёкла в глобаль модуля
    expect(ctx.PAGINATE_CAP).toBeUndefined();
    expect(ctx.emitBaseSnapshot).toBeUndefined();
  });

  test('S6: модуль не попал под запрещённые конструкции', () => {
    expect(MOD).not.toMatch(/^\s*'use strict'/m); // with несовместим со strict
    expect(MOD).not.toMatch(/innerHTML\s*=/);     // privacy-гигиена
    expect(MOD).toContain('with (D) {');
    expect(MOD).toContain('if (typeof window !== \'undefined\' && window.AiCmGeminiPagination) return;');
  });
});