/**
 * ПЕТЛЯ GSA (наблюдения владельца, вердикт High) — гард прогонов на тред + re-entrancy
 * виртуального скролла.
 *
 * ИЗМЕРЕНО (живой лог 2026-09-23, режим diag): КАЖДЫЙ перехваченный GET /async/folwr
 * запускал НОВЫЙ прогон. Капы FOLWR_MAX_PAGES = 12 и FOLWR_PROBE_MAX_STEPS = 10
 * ограничивали ОДИН прогон, а не тред и не время; гард «один раз на тред» был ТОЛЬКО у
 * probe (probedTids), у пагинации аналога не было; нулевой прирост уходил в
 * virtualScrollBackfill('pagination-empty') БЕЗ re-entrancy-гарда (до ~16 с невидимого
 * скролла на каждый нулевой прогон). Механизм по коду: 400 мс = FOLWR_PAGE_DELAY_MS;
 * тела 1.36–1.97 МБ повторялись каденсом 400 мс. Данные петлёй не страдают
 * (O-31/O-32/v1.27) — шум сетевой/ресурсный.
 *
 * ЧТО ЗДЕСЬ УДОСТОВЕРЯЕТСЯ:
 *   D1 два прогона пагинации на ОДИН тред в пределах 2 с → второй suppressed, база не выросла;
 *   D2 прогон на тред A, смена на B, возврат на A в пределах 2 с → suppressed (окно привязано
 *      к треду, а не к «последнему прогону вообще»);
 *   D3 virtualScrollBackfill вызван дважды параллельно → второй skip-active (re-entrancy);
 *   D4 tick() внутри backfill после смены треда → abort, scrollTop не меняется;
 *   R1 легитимный прогон после окна ≥ 2 с → start, база растёт (8 → 10);
 *   R2 регресс O-27/O-31/O-32/O-43 — гарды, сегментация и канонический инвариант целы;
 *   S1–S3 source-пины: folwrRunAtMap / vsActive / диаг-строки.
 *
 * Исполняются РЕАЛЬНЫЕ функции перехватчика (срез по балансу скобок + `with (ctx)`,
 * песочница — tests/adapters/helpers/gsa-loop-sandbox.js). Источник правды базы —
 * РЕАЛЬНЫЙ парсер utils/google-search-folwr-parser.js (не моки).
 */

const path = require('path');
const SANDBOX = require('./helpers/gsa-loop-sandbox.js');

const { Parser, INTERCEPT, makeApi, makeFetch } = SANDBOX;

const TID_A = 'GSA-LOOP-A';
const TID_B = 'GSA-LOOP-B';
const FOLWR_URL = 'https://www.google.com/search?udm=50&async=folwr';
// Формат канонического хелпера utils/debug.js:162 — '[AI CM][diag] ' + tag + ' ' + key=value…
const DIAG_PREFIX = '[AI CM][diag]';

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}
const TURNS_8 = [
  turn('t1', 'Вопрос 1', 'Ответ 1'),
  turn('t2', 'Вопрос 2', 'Ответ 2'),
  turn('t3', 'Вопрос 3', 'Ответ 3'),
  turn('t4', 'Вопрос 4', 'Ответ 4'),
  turn('t5', 'Вопрос 5', 'Ответ 5'),
  turn('t6', 'Вопрос 6', 'Ответ 6'),
  turn('t7', 'Вопрос 7', 'Ответ 7'),
  turn('t8', 'Вопрос 8', 'Ответ 8')
];
// Вторая страница: ходы 9–10 (легитимный прирост R1).
const TURNS_9_10 = [
  turn('t9', 'Вопрос 9', 'Ответ 9'),
  turn('t10', 'Вопрос 10', 'Ответ 10')
];

// Сторож асинхронных провалов песочницы: ошибка внутри .then() цепочки прогона видна только
// так — промис-цепочка никуда не возвращается из followFolwrPagination и ловится её
// собственным .catch, поэтому без сторожа тест остался бы зелёным при сломанном прогоне
// (ровно так уже была пропущена ReferenceError внутри шага пагинации).
// Провал expect() сторож не трогает: assertion и так падает тестом, а «запомненный» —
// всплывал бы в afterEach СЛЕДУЮЩЕГО теста как чужая ошибка.
let asyncErrors = [];
const realThen = Promise.prototype.then;
beforeAll(() => {
  Promise.prototype.then = function (onOk, onErr) {
    return realThen.call(this, onOk, function (e) {
      const name = String((e && e.name) || '');
      const stack = String((e && e.stack) || '');
      if (name === 'JestAssertionError' || name === 'AssertionError' || stack.indexOf('expect(') !== -1) {
        throw e;
      }
      asyncErrors.push(e);
      if (onErr) return onErr(e);
      throw e;
    });
  };
});
afterAll(() => { Promise.prototype.then = realThen; });
beforeEach(() => { asyncErrors = []; });
afterEach(() => {
  const errs = asyncErrors.slice();
  asyncErrors = [];
  expect(errs.map(function (e) { return String((e && e.stack) || e); })).toEqual([]);
});

// Дождаться фактического конца прогона: голый цикл `await Promise.resolve()` цепочку не
// дожидается (fetch → text → merge → finish идут через свой стек микрозадач), и тест уходил
// бы в пятисекундный таймаут вместо внятного expect. Ждём по счётчику «в полёте», а
// прокачку очереди делаем через ДОПАТЧЕННЫЙ then (иначе сам await становится звеном цепи).
function tick() {
  return new Promise(function (r) { realThen.call(Promise.resolve(), r); });
}
async function flush() {
  for (let i = 0; i < 12; i++) await tick();
}
async function waitRunDone(api, key) {
  for (let i = 0; i < 300 && api.folwrRunLiveMap[key]; i++) await tick();
  return api.folwrRunLiveMap[key] === undefined;
}
// Прогон идёт, пока ключ треда есть в folwrRunLiveMap: ждём снятия счётчика, а не
// фиксированное число микрозадач (иначе гонка и пятисекундный таймаут вместо expect).
async function settle(h, tid) {
  await waitRunDone(h.api, (tid || TID_A) + '|');
  await flush();
}

function loopCtx(over) {
  const sink = [];
  const events = [];
  const state = { domTid: TID_A }; // читается хелпером readDomThreadId (геттер, а не снимок)

  const scroller = {
    scrollHeight: 1000,
    clientHeight: 100, // findChatScroller: scrollHeight > clientHeight + 50
    scrollTop: 500,
    style: { opacity: '1' }
  };
  const doc = {
    querySelectorAll: function (sel) {
      return sel === '[data-scope-id="turn"]' ? [scroller] : [];
    },
    querySelector: function () { return scroller; }
  };

  const utils = Object.create(Parser);
  // Нулевая страница пагинации по умолчанию: разбор даёт 0 новых ходов (только тот же
  // курсор) — это и есть форма петли (нулевой прирост → фолбэк виртуального скролла).
  utils.extractContinuationToken = function (txt) {
    return txt && txt.indexOf('mstk') !== -1 ? 'CURSOR-SAME' : null;
  };
  // DOM-добор базы (Вариант Б): включается тестом через api.domTurns.
  utils.extractTurnsFromDocument = function () { return utils.__domTurns || []; };
  utils.countTurnContainers = function (html) { return (html.match(/data-scope-id="turn"/g) || []).length; };

  const ctx = {
    // Константы одного прогона (объявлены в модуле — в срез-песочницу не попадают).
    FOLWR_MAX_PAGES: 12,
    FOLWR_PAGE_DELAY_MS: 400,
    location: { href: FOLWR_URL, hostname: 'www.google.com', search: '?udm=50' },
    console: { log: function (m) { sink.push(String(m)); } },
    debugLog: function (lvl, msg) { sink.push(String(msg)); },
    document: doc,
    URL: URL,
    Math: Math,
    Date: Date,
    setTimeout: function (f, ms) { return setTimeout(f, ms); },
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
    // Свидетель вызовов Варианта Б — по имени, которое НЕ занято функцией песочницы:
    // заглушка с именем virtualScrollBackfill перекрыла бы реальную функцию (bare-
    // идентификатор внутри `with (ctx)` разрешается в пользу ctx).
    vsCalls: [],
    vsBackfillStub: function (reason) { ctx.vsCalls.push(reason); return true; },
    // diagPreview из исходника НЕ режется: его тело содержит литерал `")]}'"`, на котором
    // счётчик скобок fnDecl обманывается. В песочницу идёт эквивалентная заглушка — на гард
    // прогонов и на базу она не влияет (используется только в строке debugLog).
    diagPreview: function (txt) { return String(txt || '').slice(0, 300); },
    activeLoadFolwr: function () { },
    ownRequestsAllowed: function () { return true; },
    threadAuthKey: function (tid) { return (tid || '') + '|'; },
    urlWithMstk: function (u) { return u; },
    isSorryResponse: function () { return false; },
    triggerSorryCooldown: function () { }
  };

  const diag = {
    on: function () { return ctx.diagGate === true; },
    // Как реальный utils/debug.js: гейт aiCmDebug решает, печатать ли строку.
    line: function (point, fields) {
      if (!diag.on()) return false;
      const pairs = [];
      Object.keys(fields || {}).forEach(function (k) { pairs.push(k + '=' + fields[k]); });
      const line = DIAG_PREFIX + ' ' + point + ' ' + pairs.join(' ');
      sink.push(line);
      return true;
    },
    kind: function () { return 'chat'; }
  };
  ctx.aiCmDiagOn = diag.on;
  ctx.aiCmDiagLine = diag.line;
  ctx.aiCmDiagDocKind = diag.kind;
  // Гейт включён: три новые диаг-строки проверяются по факту печати; выключенный гейт
  // проверяется отдельным пином S3.
  ctx.diagGate = true;

  Object.assign(ctx, over || {});
  // Значения по умолчанию задаются ПОСЛЕ over: переопределение одного поля window не должно
  // сносить остальные (в браузере окно одно).
  ctx.window = Object.assign({
    GoogleFolwrUtils: utils,
    dispatchEvent: function (ev) { events.push(ev.detail); }
  }, ctx.window || {});
  if (!ctx.window.fetch) ctx.window.fetch = makeFetch([], FOLWR_URL);

  const api = makeApi(ctx);
  // DOM-добор включается через массив, который читает хелпер песочницы.
  utils.__domTurns = api.domTurns;
  api.setScroller(scroller);
  // Как в браузере: currentThreadId инициализируется чтением DOM (core/google-search-
  // intercept.js: `currentThreadId = readDomThreadId()`), поэтому активный тред известен с
  // самого старта. Иначе virtualScrollBackfill взял бы tid='' и гард треда не сработал.
  api.setThread(state.domTid);
  // Вариант Б для тестов пагинации (D1/D2/R1): реальная прокрутка подменяется свидетелем —
  // она стартует по setTimeout и живёт 800 мс, что несовместимо с прокачкой микрозадач.
  // Сам re-entrancy-гард скролла проверяется на РЕАЛЬНОЙ функции в D3/D4.
  api.setVsImpl(ctx.vsBackfillStub);
  return {
    ctx: ctx, api: api, sink: sink, events: events, scroller: scroller, state: state,
    utils: utils, get vsCalls() { return ctx.vsCalls; }
  };
}

function diagLines(sink, point) {
  return sink.filter(function (l) { return l.indexOf(DIAG_PREFIX + ' ' + point + ' ') === 0; });
}

// =====================================================================================
// D1: два прогона на один тред в пределах 2 с → второй suppressed, база не дублируется
// =====================================================================================
describe('Петля GSA D1: один прогон пагинации на тред за окно', () => {
  test('второй прогон того же треда внутри 2 с подавлен — сети и скролла нет', async () => {
    const now = 1700000000000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const h = loopCtx({});
      // База: снимок folwr-open 8 ходов уже применён (путь open).
      h.api.applyTurns(TURNS_8, TID_A, false, 'body-open');

      // Прогон 1: страница пагинации без прироста → фолбэк Вариант Б (виртуальный скролл).
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      await settle(h);
      expect(h.vsCalls).toEqual(['pagination-empty']); // Вариант Б действительно дошёл до скролла
      expect(h.api.folwrRunAtMap[TID_A + '|']).toBe(now);
      // Метка «тред не растёт» ставится только со ВТОРОГО прогона (первому сравнивать не с чем).
      expect(h.api.folwrNoGainMap[TID_A + '|']).toBeUndefined();

      // Прогон 2: тот же тред, 400 мс спустя (каденс петли из живого лога).
      spy.mockReturnValue(now + 400);
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      expect(h.vsCalls).toEqual(['pagination-empty']); // второго скролла НЕТ
      expect(h.api.folwrRunLiveMap[TID_A + '|']).toBeUndefined(); // в полёте ничего не осталось

      // Прогон 3: 800 мс — тот же вердикт (каденс 400 мс окно не пробивает).
      spy.mockReturnValue(now + 800);
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      expect(h.vsCalls).toEqual(['pagination-empty']);

      // Прогон 4 — ЗА окном 2 с (3 с): прогон стартует и снова без прироста → ставится
      // метка «тред не растёт» (с этого момента тред держится дольше — до 30 с).
      spy.mockReturnValue(now + 3000);
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      await settle(h);
      expect(h.api.folwrNoGainMap[TID_A + '|']).toBe(now + 3000);
      expect(h.vsCalls).toEqual(['pagination-empty', 'pagination-empty']);

      // Прогон 5 — сразу после нулевого: подавлен расширенным окном, а не только 2 с.
      spy.mockReturnValue(now + 3100);
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      expect(h.api.folwrRunLiveMap[TID_A + '|']).toBeUndefined();
      expect(h.vsCalls).toHaveLength(2); // третьего скролла НЕТ

      // База не выросла и не задвоилась: те же 8 ходов, каждый ровно один раз.
      expect(h.api.lastFullTurns).toHaveLength(8);
      expect(h.api.lastFullTurns.map(function (t) { return t.id; })).toEqual(
        ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
      );

      // Диагностика: 2 start + 3 suppress, поля строки на месте.
      const gate = diagLines(h.sink, 'gsa-loop-guard');
      expect(gate).toHaveLength(5);
      expect(gate[0]).toContain('gsa-loop-guard path=pagination');
      expect(gate[0]).toContain('threadId=' + TID_A);
      expect(gate[0]).toContain('gained=0');
      expect(gate[0]).toContain('verdict=start');
      expect(gate[1]).toContain('verdict=suppress');
      expect(gate[1]).toContain('reason=cooldown');
      expect(gate[2]).toContain('verdict=suppress');
      expect(gate[3]).toContain('verdict=start');
      expect(gate[4]).toContain('verdict=suppress');
      expect(gate[4]).toContain('reason=no-gain-cooldown');
      // sincePrevRunMs — реальная дельта стартов прогонов (0 / 400 / 800 / 3000 / 100).
      expect(gate[0]).toContain('sincePrevRunMs=-1');
      expect(gate[1]).toContain('sincePrevRunMs=400');
      expect(gate[2]).toContain('sincePrevRunMs=800');
      expect(gate[3]).toContain('sincePrevRunMs=3000');
      expect(gate[4]).toContain('sincePrevRunMs=100');
    } finally { spy.mockRestore(); }
  });

  test('прогон уже в полёте — второй прогон того же треда не стартует', () => {
    const now = 1700000100000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const h = loopCtx({});
      // fetch, который никогда не завершается: прогон держит счётчик в полёте.
      h.ctx.window.fetch = function () { return new Promise(function () { }); };
      h.api.applyTurns(TURNS_8, TID_A, false, 'body-open');
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      expect(h.api.folwrRunLiveMap[TID_A + '|']).toBe(1);
      expect(h.api.inFlight[TID_A + '|']).toBe(true);

      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      const gate = diagLines(h.sink, 'gsa-loop-guard');
      expect(gate).toHaveLength(2);
      expect(gate[1]).toContain('verdict=suppress');
      expect(gate[1]).toContain('reason=run-in-flight');
      expect(gate[1]).toContain('inFlight=1');
      expect(h.api.folwrRunLiveMap[TID_A + '|']).toBe(1); // счётчик не удвоился
    } finally { spy.mockRestore(); }
  });
});

// =====================================================================================
// D2: окно привязано к ТРЕДУ (возврат в A через B окно A не обнуляет)
// =====================================================================================
describe('Петля GSA D2: окно привязано к треду, а не к «последнему прогону вообще»', () => {
  test('A → B → A в пределах 2 с: прогон A подавлен, прогон B стартует', async () => {
    const now = 1700001000000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const h = loopCtx({});
      // Прогон 1 на тред A.
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-A', 0);
      await settle(h);
      const afterA = diagLines(h.sink, 'gsa-loop-guard');
      expect(afterA).toHaveLength(1);
      expect(afterA[0]).toContain('threadId=' + TID_A);
      expect(afterA[0]).toContain('verdict=start');

      // SPA-переход на тред B, прогон B — стартует (окно своё, тред другой).
      h.api.setThread(TID_B);
      spy.mockReturnValue(now + 300);
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_B, 'CURSOR-B', 0);
      await settle(h);
      const afterB = diagLines(h.sink, 'gsa-loop-guard');
      expect(afterB[1]).toContain('threadId=' + TID_B);
      expect(afterB[1]).toContain('verdict=start');
      expect(afterB[1]).toContain('sincePrevRunMs=-1'); // у треда B своей истории прогонов нет

      // Возврат на тред A в пределах 2 с от ЕГО прогона — ПОДАВЛЕН: окно A не обнулилось
      // прогоном B (гард не сбрасывает словарь на смене треда).
      h.api.setThread(TID_A);
      spy.mockReturnValue(now + 600);
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-A', 0);
      await settle(h);
      const afterReturn = diagLines(h.sink, 'gsa-loop-guard');
      expect(afterReturn).toHaveLength(3);
      expect(afterReturn[2]).toContain('threadId=' + TID_A);
      expect(afterReturn[2]).toContain('verdict=suppress');
      expect(afterReturn[2]).toContain('sincePrevRunMs=600');
      // Сети/скролла по возврату нет: Вариант Б вызван ровно дважды (A и B), не трижды.
      expect(h.vsCalls).toHaveLength(2);
    } finally { spy.mockRestore(); }
  });
});

// =====================================================================================
// D3: virtualScrollBackfill дважды параллельно → второй skip-active
// =====================================================================================
describe('Петля GSA D3: re-entrancy невидимого скролла', () => {
  test('второй вход при активном скролле → skip-active, второго скролла нет', () => {
    jest.useFakeTimers();
    try {
      const h = loopCtx({});
      h.api.applyTurns(TURNS_8, TID_A, false, 'body-open');
      h.scroller.scrollTop = 500;

      const first = h.api.realVs('pagination-empty');
      expect(first).toBe(true);
      expect(h.api.vsActive).toBe(TID_A);         // флаг активного скролла — ключ треда
      expect(h.scroller.style.opacity).toBe('0'); // контейнер скрыт на время скролла

      // Второй вызов (следующий перехваченный /async/folwr того же треда) — skip-active.
      const second = h.api.realVs('pagination-empty');
      expect(second).toBe(false);
      expect(h.api.vsActive).toBe(TID_A); // флаг не перезаписан вторым входом

      const reentry = diagLines(h.sink, 'gsa-vs-reentry');
      expect(reentry).toHaveLength(1);
      expect(reentry[0]).toContain('verdict=skip-active');
      expect(reentry[0]).toContain('active=' + TID_A);
      expect(reentry[0]).toContain('reason=pagination-empty');

      // Третий вход тоже подавлен (гард держится, пока скролл не завершён).
      expect(h.api.realVs('pagination-empty')).toBe(false);
      expect(diagLines(h.sink, 'gsa-vs-reentry')).toHaveLength(2);
      expect(h.api.vsActive).toBe(TID_A);
    } finally { jest.useRealTimers(); }
  });

  test('после завершения скролла флаг снят и следующий скролл снова возможен', () => {
    jest.useFakeTimers();
    try {
      const h = loopCtx({});
      h.api.applyTurns(TURNS_8, TID_A, false, 'body-open');
      expect(h.api.realVs('first')).toBe(true);
      // Три итерации с неизменной высотой → стоп по VS_STALL_LIMIT, флаг снят.
      jest.advanceTimersByTime(800 * 3 + 50);
      expect(h.api.vsActive).toBeNull();
      expect(h.sink.indexOf('[ai-cm-google-search] виртуальный скролл завершён: итого=8 ходов')).toBeGreaterThan(-1);
      expect(h.api.realVs('second')).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});

// =====================================================================================
// D4: смена треда внутри скролла → abort, scrollTop не трогается
// =====================================================================================
describe('Петля GSA D4: смена треда внутри backfill', () => {
  test('tick() после смены треда → abort, scrollTop не меняется, флаг снят', () => {
    jest.useFakeTimers();
    try {
      const h = loopCtx({});
      h.api.applyTurns(TURNS_8, TID_A, false, 'body-open');
      h.scroller.scrollTop = 500;
      expect(h.api.realVs('pagination-empty')).toBe(true);
      expect(h.scroller.scrollTop).toBe(0); // первый tick законно ушёл в начало

      // Пользователь ушёл в другой разговор, пока скролл спал (VS_STEP_WAIT_MS = 800 мс).
      h.scroller.scrollTop = 640;
      h.api.switchThread(TID_B);
      jest.advanceTimersByTime(900);

      expect(h.scroller.scrollTop).toBe(640); // чужой тред в начало НЕ уехал
      expect(h.api.vsActive).toBeNull();      // скролл завершён (аварийно)
      const mismatch = diagLines(h.sink, 'gsa-vs-thread-mismatch');
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0]).toContain('expected=' + TID_A);
      expect(mismatch[0]).toContain('actual=' + TID_B);
      expect(mismatch[0]).toContain('verdict=abort');
    } finally { jest.useRealTimers(); }
  });
});

// =====================================================================================
// R1: легитимный прогон после окна ≥ 2 с → start, база растёт
// =====================================================================================
describe('Петля GSA R1: легитимный прогон после окна', () => {
  test('через 2.5 с прогон стартует, страница с новыми ходами растит базу 8 → 10', async () => {
    const now = 1700002000000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const h = loopCtx({});
      h.api.applyTurns(TURNS_8, TID_A, false, 'body-open');
      // Прогон 1 — без прироста (нулевая страница).
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      await settle(h);
      expect(h.api.lastFullTurns).toHaveLength(8);

      // 2.5 с спустя: сайт отдал страницу с ходами 9–10 (легитимный досбор истории).
      spy.mockReturnValue(now + 2500);
      h.ctx.parseWithParser = function () {
        return { turns: TURNS_9_10, messages: [], count: 2, text: '', threadId: TID_A };
      };
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-2', 0);
      await settle(h);

      expect(h.api.lastFullTurns).toHaveLength(10);
      expect(h.api.lastFullTurns.map(function (t) { return t.id; }).slice(-2)).toEqual(['t9', 't10']);
      const gate = diagLines(h.sink, 'gsa-loop-guard');
      expect(gate[1]).toContain('verdict=start');
      expect(gate[1]).toContain('sincePrevRunMs=2500');
      // Прирост снял окно треда (markFolwrRunGain): no-gain-метка снята.
      expect(h.api.folwrNoGainMap[TID_A + '|']).toBeUndefined();
      expect(h.api.folwrGainSeenAtMap[TID_A + '|']).toBe(now + 2500);
      // DOM-добор полноту не выдумывает (O-32-инвариант держится на пути гарда).
      expect(h.events[h.events.length - 1].historyComplete).toBe(false);
    } finally { spy.mockRestore(); }
  });

  test('снимок открытия с НОВЫМИ ходами окно не теряет (growth-priority)', async () => {
    const now = 1700003000000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const h = loopCtx({});
      h.api.applyTurns(TURNS_8, TID_A, false, 'body-open');
      // Два прогона без прироста (2-й — за окном 2 с): ставится 30-секундная метка
      // «тред не растёт».
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      await settle(h);
      spy.mockReturnValue(now + 2500);
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
      await settle(h);
      expect(h.api.folwrNoGainMap[TID_A + '|']).toBe(now + 2500);

      // 1 с спустя (внутри ВСЕХ окон) пришёл снимок открытия с новыми ходами 9–10:
      // гард роста не блокирует — новый ход пользователя данных не теряет.
      spy.mockReturnValue(now + 1000);
      const gate = h.api.folwrRunPermit('open', TID_A, TID_A + '|', { gained: 2, growthPriority: true, recordNoGain: false });
      expect(gate.permit).toBe(true);
      const line = diagLines(h.sink, 'gsa-loop-guard').pop();
      expect(line).toContain('path=open');
      expect(line).toContain('gained=2');
      expect(line).toContain('verdict=start');
      expect(line).toContain('reason=gain-priority');
    } finally { spy.mockRestore(); }
  });
});

// =====================================================================================
// R2: регресс O-27 / O-31 / O-32 / O-43 — гарды и инварианты целы
// =====================================================================================
describe('Петля GSA R2: регресс O-27/O-31/O-32/O-43', () => {
  test('O-27: форма мусора и тело без непустых ходов базой не становятся', () => {
    const h = loopCtx({});
    h.api.applyTurns([], TID_A, true, ")]}'\n[\"\"]\n");
    expect(h.api.lastFullTurns).toHaveLength(0);
    h.api.applyTurns([{ id: 'x', userText: '', assistantText: '  ' }], TID_A, true, 'ok-body');
    expect(h.api.lastFullTurns).toHaveLength(0);
  });

  test('O-31: чужой тред не дописывается в активную базу (сегментация цела)', () => {
    const h = loopCtx({});
    h.api.setThread(TID_A);
    h.ctx.__setDomTid ? h.ctx.__setDomTid(TID_A) : null;
    h.api.applyTurns(TURNS_8, TID_A, false, 'open-A');
    expect(h.api.lastFullTurns).toHaveLength(8);
    // Снимок ЧУЖОГО треда: DOM по-прежнему на A → в активную базу не идёт.
    h.state.domTid = TID_A;
    h.api.applyTurns(TURNS_9_10, TID_B, false, 'open-B');
    expect(h.api.lastFullTurns).toHaveLength(8);
    expect(h.api.lastFullTurns.map(function (t) { return t.id; })).not.toContain('t9');
  });

  test('O-32: монотонность — повторное применение того же снимка базу не раздувает', () => {
    const h = loopCtx({});
    h.api.applyTurns(TURNS_8, TID_A, false, 'open-1');
    h.api.applyTurns(TURNS_8, TID_A, false, 'open-2');
    expect(h.api.lastFullTurns).toHaveLength(8);
    expect(h.api.lastFullTurns.map(function (t) { return t.id; })).toEqual(
      ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
    );
  });

  test('O-43: снимок с явным вердиктом полноты не подменяется', () => {
    const h = loopCtx({});
    const detail = h.api.buildDetail(TURNS_8, null, TID_A, true);
    expect(detail.historyComplete).toBe(true);
    expect(h.api.buildDetail(TURNS_8, null, TID_A, undefined).historyComplete).toBe(false);
    expect(h.api.buildDetail(TURNS_8, null, TID_A, false).historyComplete).toBe(false);
  });

  test('капы одного прогона не тронуты (12 страниц / 10 шагов probe / 400 мс)', () => {
    expect(INTERCEPT).toContain('var FOLWR_MAX_PAGES = 12;');
    expect(INTERCEPT).toContain('var FOLWR_PROBE_MAX_STEPS = 10;');
    expect(INTERCEPT).toContain('var probedTids = {};');
    expect(INTERCEPT).toContain('var FOLWR_PAGE_DELAY_MS = 400;');
  });
});

// =====================================================================================
// S1–S3: source-пины
// =====================================================================================
describe('Петля GSA S1–S3: source-пины', () => {
  const { fnDecl } = SANDBOX;

  test('S1: словарь прогонов на тред и пороги окна объявлены', () => {
    expect(INTERCEPT).toContain('var folwrRunAtMap = {};');
    expect(INTERCEPT).toContain('var folwrRunLiveMap = {};');
    expect(INTERCEPT).toContain('var FOLWR_RUN_MIN_COOLDOWN_MS = 2000;');
    expect(INTERCEPT).toContain('var FOLWR_NO_GAIN_COOLDOWN_MS = 30000;');
    // гард стоит на всех трёх путях: open / pagination / probe
    expect(INTERCEPT).toContain("beginFolwrRun('pagination'");
    expect(INTERCEPT).toContain("beginFolwrRun('probe'");
    expect(INTERCEPT).toContain("folwrRunPermit('open'");
    // сброс окна — только на реальном приросте базы
    expect(fnDecl(INTERCEPT, 'markFolwrRunGain')).toContain('delete folwrRunAtMap[key];');
  });

  test('S2: re-entrancy-флаг скролла и проверка треда внутри tick', () => {
    expect(INTERCEPT).toContain('var vsActive = null;');
    expect(INTERCEPT).toContain('if (vsActive) {');
    const vs = fnDecl(INTERCEPT, 'virtualScrollBackfill');
    expect(vs).toContain('vsActive = tid');
    expect(vs).toContain('vsActive = null;');
    // проверка «тред сменился» стоит ПЕРЕД scrollTop = 0
    const atGuard = vs.indexOf('tidNow !== (tid ||');
    const atScroll = vs.indexOf('scroller.scrollTop = 0;');
    expect(atGuard).toBeGreaterThan(-1);
    expect(atScroll).toBeGreaterThan(-1);
    expect(atGuard).toBeLessThan(atScroll);
    // O-32-пин (tests/o32-gsa-canonical-thread-invariant.test.js) держится: DOM-добор
    // полноту НЕ выдумывает.
    expect(vs).toContain('applyTurns(mergeFn(lastFullTurns, domTurns), tid, false);');
  });

  test('S3: диаг-строки — ровно три точки, все под typeof-гардом aiCmDiagLine', async () => {
    expect(INTERCEPT).toContain("aiCmDiagLine('gsa-loop-guard'");
    expect(INTERCEPT).toContain('aiCmDiagLine(point, f)');
    expect(INTERCEPT).toContain("'gsa-vs-reentry'");
    expect(INTERCEPT).toContain("'gsa-vs-thread-mismatch'");
    // строка гарда несёт обязательные поля контракта
    const diagFn = fnDecl(INTERCEPT, 'gsaDiagLoopGuard');
    ['path:', 'threadId:', 'sincePrevRunMs:', 'gained:', 'verdict:', 'reason:'].forEach(function (f) {
      expect(diagFn).toContain(f);
    });
    // (а) гейт aiCmDebug ВЫКЛЮЧЕН: ни одной строки гарда, поведение прогона прежнее
    const off = loopCtx({});
    off.ctx.diagGate = false;
    off.api.applyTurns(TURNS_8, TID_A, false, 'body-open');
    off.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
    await settle(off);
    expect(diagLines(off.sink, 'gsa-loop-guard')).toHaveLength(0);
    expect(off.vsCalls).toEqual(['pagination-empty']); // прогон при этом работает как прежде
    expect(off.api.folwrRunAtMap[TID_A + '|']).toBeGreaterThan(0);

    // (б) хелперов диагностики в срез-песочнице НЕТ: строка не печатается, исключения нет
    // (typeof-гард) — ровно как в срезах tests/o32-gsa-canonical-thread-invariant.test.js.
    const h = loopCtx({});
    delete h.ctx.aiCmDiagLine;
    delete h.ctx.aiCmDiagOn;
    expect(function () {
      h.api.followFolwrPagination(FOLWR_URL, TURNS_8, TID_A, 'CURSOR-1', 0);
    }).not.toThrow();
    await settle(h);
    expect(diagLines(h.sink, 'gsa-loop-guard')).toHaveLength(0);
  });
});
