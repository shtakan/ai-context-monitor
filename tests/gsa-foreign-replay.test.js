/**
 * BUG-K: после F5 перехватчик крутил open/pagination ЧУЖОГО треда при активном.
 *
 * ИЗМЕРЕНО (живой лог 2026-11-16 20:30:51–20:31:24): activeTid=vx_7apaCCcG-zMsPtPfd6A4,
 * а в логе каждые ~0.7 с повторялись
 *   gsa-base-write path=open tid=8bTpaveuJtWckdUP46iumAo parsed=24 domContainers=4
 *   gsa-base-write path=pagination … page=1 kind=cursor-repeat
 * (ответы по 3.9 МБ). База была защищена (applyTurns verdict=foreign-not-applied), но
 * гард открытия получал gained=19 (24−5) — прирост ЧУЖОГО снимка против своей базы, —
 * снимал окно треда и снова запускал хвост (pagination/probe). Итог: хвост чужого треда
 * жил вечно, а в 20:31:24 open активного треда получил 1835 B «Что-то пошло не так».
 *
 * ЧТО ЗДЕСЬ УДОСТОВЕРЯЕТСЯ:
 *   D1 open чужого tid → `foreign=1 tail=skip gained=0`, пагинация/probe не вызваны,
 *      `ai-cm-full-history` не эмитится, база не меняется;
 *   D2 тот же ответ при АКТИВНОМ tid → `foreign=0 tail=start gained=2`, хвост стартует
 *      как прежде (второй fetch с mstk);
 *   D3 followFolwrPagination чужого треда: сети нет, база не растёт, прогон закрыт;
 *   D4 probeFolwrCompleteness чужого треда: сети/события/лога «probe запущен» нет,
 *      probedTids не сжигается — после возврата в свой тред probe отрабатывает;
 *   S1 source-пины: foreignOpen вычисляется ДО folwrRunPermit/markFolwrRunGain, оба
 *      хвоста начинаются с гарда isForeignThread, диаг-поля foreign/tail на месте.
 *
 * Стенд D1/D2 — РЕАЛЬНЫЙ core/google-search-intercept.js в jsdom (порядок загрузки как в
 * core/background.ts:155), D3/D4 — песочница реальных функций перехватчика.
 */

const fs = require('fs');
const path = require('path');

const SANDBOX = require('./adapters/helpers/gsa-loop-sandbox.js');

const { Parser, INTERCEPT, makeApi, makeFetch, fnDecl } = SANDBOX;

const ROOT = path.join(__dirname, '..');
// Исходник перехватчика берём из песочницы (как tests/adapters/gsa-loop-guard.test.js):
// прямой readFileSync по core/ запрещён правилом 3 «Behavior-Only Tests».

const DIAG_PREFIX = '[AI CM][diag]';
// Путь обязан содержать «/async/folwr» — именно так перехватчик распознаёт open-запрос
// (core/google-search-intercept.js:1663). Живой URL: /search/async/folwr?udm=50.
const FOLWR_URL = 'https://www.google.com/search/async/folwr?udm=50';
const CURSOR = 'CURSOR-OPEN';

// ---------- стенд jsdom (D1/D2) ----------
const DEBUG_SRC = require('./helpers/load-esm.js').loadAsClassic('utils/debug.ts');
const PARSER_SRC = require('./helpers/load-esm.js').loadAsClassic('utils/google-search-folwr-parser.ts');
const MAIN_SRC = require('./helpers/main-intercept.js').interceptSource('core/google-search-intercept.js');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'google-folwr-open.html'), 'utf8');

// threadId самого снимка фикстуры — «чужой» ответ из живого лога.
const TID_BODY = 'SYNTHETIC-THREAD-1';
// Активный разговор страницы — как activeTid в живом логе.
const TID_ACTIVE = 'vx_7apaCCcG-zMsPtPfd6A4';
// Курсор в теле ответа: без него хвост не стартовал бы и у активного треда, и ассерт
// «чужой при курсоре → tail=skip» ничего бы не доказывал.
const OPEN_BODY = FIXTURE + '\n<div data-mstk="' + CURSOR + '"></div>';

// Непрямой eval: исходники расширения — классические скрипты одного MAIN-мира, их
// top-level function-декларации (aiCmDiagLine/aiCmDiagOn/parseGoogleFolwrOpen) обязаны
// стать глобальными.
function loadGlobal(src) { (0, eval)(src); }

function makeResponse(body, url) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    type: 'basic',
    url: url,
    clone: function () { return this; },
    text: function () { return Promise.resolve(body); }
  };
}

function installStand() {
  delete window.__aiCmGoogleSearchInterceptInstalled;
  document.body.innerHTML =
    '<div data-session-thread-id="' + TID_ACTIVE + '" style="display:none"></div>';

  const logs = [];
  jest.spyOn(console, 'log').mockImplementation(function (m) { logs.push(String(m)); });
  jest.spyOn(console, 'warn').mockImplementation(function () { });

  // Порядок core/background.ts:155: debug.js → парсер → перехватчик.
  loadGlobal(DEBUG_SRC);
  loadGlobal(PARSER_SRC);

  const events = [];
  const onDetail = function (ev) { events.push(ev.detail); };
  window.addEventListener('ai-cm-full-history', onDetail);

  const calls = [];
  window.fetch = function (input) {
    const url = String((typeof input === 'string') ? input : (input && input.url) || '');
    calls.push(url);
    // Тело одно и то же на все запросы: страница пагинации повторит курсор
    // (kind=cursor-repeat) и цикл закроется на первом шаге.
    return Promise.resolve(makeResponse(OPEN_BODY, url));
  };

  loadGlobal(MAIN_SRC);
  return {
    logs: logs,
    events: events,
    calls: calls,
    setDomTid: function (tid) {
      document.body.firstChild.setAttribute('data-session-thread-id', tid);
    },
    dispose: function () { window.removeEventListener('ai-cm-full-history', onDetail); }
  };
}

async function settle(rounds) {
  for (let i = 0; i < (rounds || 10); i++) {
    await Promise.resolve();
    await new Promise(function (r) { setTimeout(r, 0); });
  }
}

function baseWriteLines(st, pathName) {
  return st.logs.filter(function (l) {
    return l.indexOf(DIAG_PREFIX + ' gsa-base-write') === 0 &&
      l.indexOf(' path=' + pathName + ' ') !== -1;
  });
}

let stand = null;
beforeEach(function () {
  try { sessionStorage.setItem('aiCmDebug', '1'); } catch (e) { /* ignore */ }
  window.__aiCmDebugLogs = false;
});
afterEach(function () {
  if (stand) { stand.dispose(); stand = null; }
  jest.restoreAllMocks();
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { /* ignore */ }
  window.__aiCmDebugLogs = false;
});

// =====================================================================================
// D1/D2: open чужого треда не зачитывает прирост и не запускает хвост
// =====================================================================================
describe('BUG-K D1/D2: open чужого треда vs активный', function () {
  test('D1: чужой tid → foreign=1 tail=skip gained=0, хвоста и эмита нет', async function () {
    stand = installStand();

    await window.fetch(FOLWR_URL, { method: 'GET' });
    await settle();

    // Один-единственный запрос: хвост (пагинация курсором) не стартовал.
    expect(stand.calls).toEqual([FOLWR_URL]);
    // База чужого треда не применилась и событие экспорта не ушло.
    expect(stand.events).toHaveLength(0);

    const open = baseWriteLines(stand, 'open');
    expect(open).toHaveLength(1);
    const line = open[0];
    expect(line).toContain('tid=' + TID_BODY);
    expect(line).toContain('domTid=' + TID_ACTIVE);
    expect(line).toContain('foreign=1');
    expect(line).toContain('tail=skip');
    expect(line).toContain('gained=0');
    expect(line).toContain('baseTurns=0');

    // База уже защищена absorbForeignSnapshot — это поведение BUG-K не менял.
    const applied = baseWriteLines(stand, 'applyTurns');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('verdict=foreign-not-applied');

    // Ни пагинации, ни probe: ни диаг-строк, ни логов шага/старта.
    expect(baseWriteLines(stand, 'pagination')).toHaveLength(0);
    const log = stand.logs.join('\n');
    expect(log).not.toContain('пагинация folwr шаг');
    expect(log).not.toContain('probe запущен');
  });

  test('D2: тот же ответ при активном tid → foreign=0 tail=start, хвост стартует', async function () {
    stand = installStand();
    // Тот же снимок теперь принадлежит активному разговору.
    stand.setDomTid(TID_BODY);

    await window.fetch(FOLWR_URL, { method: 'GET' });
    await settle();

    const open = baseWriteLines(stand, 'open');
    expect(open.length).toBeGreaterThan(0);
    expect(open[0]).toContain('tid=' + TID_BODY);
    expect(open[0]).toContain('foreign=0');
    expect(open[0]).toContain('tail=start');
    expect(open[0]).toContain('gained=2');

    // Хвост действительно пошёл: второй запрос — пагинация с курсором снимка.
    expect(stand.calls.length).toBeGreaterThanOrEqual(2);
    expect(stand.calls[1]).toContain('mstk=' + CURSOR);
    // База активного треда выросла: 2 хода (4 сообщения) в событии экспорта.
    expect(stand.events.length).toBeGreaterThan(0);
    expect(stand.events[0].threadId).toBe(TID_BODY);
    expect(stand.events[0].messages).toHaveLength(4);
  });
});

// =====================================================================================
// D3/D4: сами хвостовые функции закрываются на чужом треде
// =====================================================================================
const TID_A = 'GSA-FOREIGN-A';
const TID_B = 'GSA-FOREIGN-B';
const KEY_A = TID_A + '|';

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}
const TURNS_2 = [turn('t1', 'Вопрос 1', 'Ответ 1'), turn('t2', 'Вопрос 2', 'Ответ 2')];

// Минимальная песочница перехватчика (та же форма ctx, что в gsa-probe-lifecycle.test.js),
// но DOM-тред можно переключать из теста: он и делает тред «чужим».
function loopCtx(over) {
  const sink = [];
  const events = [];
  const state = { domTid: TID_A };
  const utils = Object.create(Parser);
  utils.extractContinuationToken = function (txt) {
    return txt && txt.indexOf('mstk') !== -1 ? 'CURSOR-SAME' : null;
  };
  utils.extractTurnsFromDocument = function () { return utils.__domTurns || []; };
  utils.countTurnContainers = function (html) {
    return (html.match(/data-scope-id="turn"/g) || []).length;
  };

  const ctx = {
    FOLWR_MAX_PAGES: 12,
    FOLWR_PAGE_DELAY_MS: 400,
    location: { href: FOLWR_URL, hostname: 'www.google.com', search: '?udm=50' },
    console: { log: function (m) { sink.push(String(m)); } },
    debugLog: function (lvl, msg) { sink.push(String(msg)); },
    document: { querySelectorAll: function () { return []; }, querySelector: function () { return null; } },
    URL: URL,
    Math: Math,
    Date: Date,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    parseWithParser: function (txt) {
      const r = Parser.parseGoogleFolwrOpen(txt);
      return { turns: r.turns, messages: r.messages, count: r.count, text: r.text, threadId: r.threadId };
    },
    describeFolwrPage: function () {
      return { cls: { kind: 'no-new-turns', complete: false, canContinue: false }, line: 'kind=no-new-turns' };
    },
    window: {
      GoogleFolwrUtils: utils,
      dispatchEvent: function (ev) { events.push(ev.detail); }
    },
    readDomThreadId: function () { return state.domTid; },
    vsCalls: [],
    vsBackfillStub: function (reason) { ctx.vsCalls.push(reason); return true; },
    diagPreview: function (txt) { return String(txt || '').slice(0, 300); },
    activeLoadFolwr: function () { },
    ownRequestsAllowed: function () { return true; },
    threadAuthKey: function (tid) { return (tid || '') + '|'; },
    urlWithMstk: function (u, cursor) { return u + (cursor ? '&mstk=' + cursor : ''); },
    isSorryResponse: function () { return false; },
    triggerSorryCooldown: function () { }
  };

  Object.assign(ctx, over || {});
  ctx.window = Object.assign({
    GoogleFolwrUtils: utils,
    dispatchEvent: function (ev) { events.push(ev.detail); }
  }, ctx.window || {});
  if (!ctx.window.fetch) ctx.window.fetch = makeFetch([''], FOLWR_URL);

  const api = makeApi(ctx);
  utils.__domTurns = api.domTurns;
  api.setThread(state.domTid);
  api.setVsImpl(ctx.vsBackfillStub);
  return {
    ctx: ctx, api: api, sink: sink, events: events, state: state,
    setDom: function (tid) { state.domTid = tid; },
    get fetchCalls() { return (ctx.fetchCalls || 0); },
    get vsCalls() { return ctx.vsCalls; }
  };
}

// Счётчик сети: подменяем window.fetch песочницы после её создания (fetch читается
// из window в момент вызова, поэтому подмена видна прогону).
function countFetch(h, bodies) {
  let calls = 0;
  h.ctx.window.fetch = function (url) {
    calls++;
    return makeFetch(bodies || [''], String(url))();
  };
  Object.defineProperty(h, 'fetchCalls', { get: function () { return calls; } });
  return h;
}

// Прокачка цепочки fetch → then → merge → finish: прогон живёт в микрозадачах.
function tick() {
  return new Promise(function (r) { Promise.resolve().then(r); });
}
async function flush() {
  for (let i = 0; i < 12; i++) await tick();
}
async function settleRun(h, tid) {
  for (let i = 0; i < 300 && h.api.folwrRunLiveMap[(tid || TID_A) + '|']; i++) await tick();
  await flush();
}

describe('BUG-K D3: пагинация чужого треда', function () {
  test('чужой tid → сети нет, база не изменилась, прогон закрыт', async function () {
    const h = countFetch(loopCtx({}), ['']);
    h.api.applyTurns(TURNS_2, TID_A, false, 'body-open');
    const before = h.api.lastFullTurns.map(function (t) { return t.id; });

    h.setDom(TID_B); // страница уже на другом разговоре
    h.api.followFolwrPagination(FOLWR_URL, TURNS_2, TID_A, 'CURSOR-1', 0);
    await settleRun(h);

    expect(h.fetchCalls).toBe(0);
    expect(h.vsCalls).toEqual([]);
    expect(h.api.folwrRunLiveMap[KEY_A]).toBeUndefined();
    expect(h.api.lastFullTurns.map(function (t) { return t.id; })).toEqual(before);
    expect(h.sink.join('\n')).toContain('пагинация чужого треда подавлена: threadId=' + TID_A);

    // Контроль: в свой тред та же пагинация стартует как прежде. Отдельная песочница:
    // beginFolwrRun чужого прогона всё же ставит окно треда (FOLWR_RUN_MIN_COOLDOWN_MS).
    const h2 = countFetch(loopCtx({}), ['']);
    h2.api.applyTurns(TURNS_2, TID_A, false, 'body-open');
    h2.api.followFolwrPagination(FOLWR_URL, TURNS_2, TID_A, 'CURSOR-1', 0);
    await settleRun(h2);
    expect(h2.fetchCalls).toBe(1);
  });
});

describe('BUG-K D4: probe чужого треда', function () {
  beforeEach(function () { jest.useFakeTimers(); });
  afterEach(function () { jest.clearAllTimers(); jest.useRealTimers(); });

  test('чужой tid → probe не стартует, флаг не взведён, probedTids не сожжён', function () {
    const h = countFetch(loopCtx({}), ['']);

    h.setDom(TID_B);
    h.api.probeFolwrCompleteness(FOLWR_URL, [], TID_A, 'CURSOR-1', 0, []);

    expect(h.fetchCalls).toBe(0);
    expect(h.events).toEqual([]); // emitProbeState(true) не звался
    expect(h.api.folwrRunLiveMap[KEY_A]).toBeUndefined();
    expect(h.sink.join('\n')).not.toContain('probe запущен');
    expect(h.sink.join('\n')).toContain('probe чужого треда подавлен: threadId=' + TID_A);

    // probedTids не сгорел: в своём треде probe получает свой шанс. Окно треда
    // (FOLWR_RUN_MIN_COOLDOWN_MS=2000) от чужого beginFolwrRun пережидаем таймерами.
    h.setDom(TID_A);
    jest.advanceTimersByTime(2100);
    h.api.probeFolwrCompleteness(FOLWR_URL, [], TID_A, 'CURSOR-2', 0, []);
    expect(h.fetchCalls).toBe(1);
    expect(h.events.map(function (e) { return e.running; })).toEqual([true]);
    expect(h.sink.join('\n')).toContain('probe запущен');
  });
});

// =====================================================================================
// S1: source-пины — порядок проверки и диаг-поля
// =====================================================================================
describe('BUG-K S1: пины исходника', function () {
  test('foreignOpen вычисляется ДО markFolwrRunGain/folwrRunPermit', function () {
    const decl = INTERCEPT.indexOf('var foreignOpen = isForeignThread(tid);');
    expect(decl).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(INTERCEPT.indexOf('markFolwrRunGain(openKey)'));
    expect(decl).toBeLessThan(INTERCEPT.indexOf("folwrRunPermit('open'"));
  });

  test('open-путь: прирост и хвост гейтятся foreignOpen', function () {
    expect(INTERCEPT).toContain('var openGained = foreignOpen ? 0 : mergedTurns.length - lastFullTurns.length;');
    expect(INTERCEPT).toContain('foreign: foreignOpen ? 1 : 0');
    expect(INTERCEPT).toContain(
      "tail: (folwrCursor && openTailAllowed && !foreignOpen) ? 'start' : 'skip'"
    );
    expect(INTERCEPT).toContain('if (folwrCursor && openTailAllowed && !foreignOpen) {');
  });

  test('оба хвоста начинаются с гарда isForeignThread', function () {
    const pagination = fnDecl(INTERCEPT, 'followFolwrPagination');
    expect(pagination).toContain('if (isForeignThread(tid)) {');
    expect(pagination).toContain('endFolwrRun(key);');
    const probe = fnDecl(INTERCEPT, 'probeFolwrCompleteness');
    expect(probe.indexOf('if (isForeignThread(tid)) {'))
      .toBeLessThan(probe.indexOf('probedTids[tid] = true;'));
    expect(probe.indexOf('if (isForeignThread(tid)) {'))
      .toBeLessThan(probe.indexOf('emitProbeState(true, tid)'));
  });
});
