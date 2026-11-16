/**
 * BUG-I: жизненный цикл probe GSA — watchdog, busy-ретрай и TTL флага probe-running.
 *
 * Живой симптом (тред nOX6apueFdSqxc8P2ZzpkQY, 18:04): `probe запущен` есть, `probe завершён`
 * нет, `probe-running=1` на экспорте, JSON partial=true/incomplete — снимок удержан навсегда.
 * Корни: `step` при `activeFolwrInFlight[key]` делал `return` без `finish`; у fetch не было
 * таймаута; неизвестный непустой cid падал в глобальный флаг.
 *
 * Здесь исполняются РЕАЛЬНЫЕ функции перехватчика (песочница tests/adapters/helpers/
 * gsa-loop-sandbox.js) и РЕАЛЬНЫЙ `aiCmGsaProbeRunningFor` (срез core/export-manager.ts).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SANDBOX = require('./adapters/helpers/gsa-loop-sandbox.js');
const { readCore } = require('./helpers/core-src.js');

const { Parser, makeApi, makeFetch } = SANDBOX;

const ROOT = path.join(__dirname, '..');
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const MGR = readCore('core/export-manager.ts',
  fs.readFileSync(path.join(ROOT, 'core', 'export-manager.ts'), 'utf8'));

const TID = 'GSA-PROBE-LIFECYCLE';
const KEY = TID + '|';
const FOLWR_URL = 'https://www.google.com/search?udm=50&async=folwr';

// Рез по балансу фигурных скобок (как в tests/gsa-autoexport.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

// Минимальная песочница перехватчика — та же форма ctx, что в tests/gsa-turn-order.test.js.
function loopCtx(over) {
  const sink = [];
  const events = [];
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
    readDomThreadId: function () { return TID; },
    vsCalls: [],
    vsBackfillStub: function (reason) { ctx.vsCalls.push(reason); return true; },
    diagPreview: function (txt) { return String(txt || '').slice(0, 300); },
    activeLoadFolwr: function () { },
    ownRequestsAllowed: function () { return true; },
    threadAuthKey: function (tid) { return (tid || '') + '|'; },
    urlWithMstk: function (u) { return u; },
    isSorryResponse: function () { return false; },
    triggerSorryCooldown: function () { }
  };

  Object.assign(ctx, over || {});
  ctx.window = Object.assign({
    GoogleFolwrUtils: utils,
    dispatchEvent: function (ev) { events.push(ev.detail); }
  }, ctx.window || {});
  if (!ctx.window.fetch) ctx.window.fetch = makeFetch([], FOLWR_URL);

  const api = makeApi(ctx);
  utils.__domTurns = api.domTurns;
  api.setThread(TID);
  api.setVsImpl(ctx.vsBackfillStub);
  return { ctx: ctx, api: api, sink: sink, events: events };
}

function runningFlags(events) {
  return events.filter(function (e) { return e && e.threadId === TID; })
    .map(function (e) { return e.running; });
}

describe('BUG-I: probe lifecycle', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('fetch не резолвится → watchdog завершает probe, снимает флаг и очищает probedTids', () => {
    const h = loopCtx({
      window: { fetch: function () { return new Promise(function () { }); } }
    });

    h.api.probeFolwrCompleteness(FOLWR_URL, [], TID, 'CURSOR-1', 0, []);
    expect(runningFlags(h.events)).toEqual([true]);
    expect(h.api.inFlight[KEY]).toBe(true);
    expect(h.api.folwrRunLiveMap[KEY]).toBeTruthy();

    jest.advanceTimersByTime(5000);

    // finish выполнен watchdog-ом: флаг снят ОДНОЙ точкой emitProbeState(false), прогон закрыт.
    expect(runningFlags(h.events)).toEqual([true, false]);
    expect(h.api.inFlight[KEY]).toBe(false);
    expect(h.api.folwrRunLiveMap[KEY]).toBeFalsy();
    expect(h.sink.join('\n')).toContain('probe завершён: reason=watchdog-timeout');
    // база не перезаписана неполным прогоном
    expect(h.api.lastFullTurns).toEqual([]);
    // probedTids очищен: следующий open может повторить probe (раньше — «уже выполнялся»)
    h.api.probeFolwrCompleteness(FOLWR_URL, [], TID, 'CURSOR-2', 0, []);
    const starts = h.sink.filter(function (l) { return l.indexOf('probe запущен') !== -1; });
    expect(starts.length).toBe(2);
    expect(h.sink.join('\n')).not.toContain('probe пропущен: уже выполнялся');
  });

  test('busy-ветка: занятый ключ → ограниченный ретрай, затем finish(inflight-suppressed)', () => {
    let fetchCalls = 0;
    const h = loopCtx({
      window: { fetch: function () { fetchCalls++; return makeFetch([''], FOLWR_URL)(); } }
    });
    h.api.inFlight[KEY] = true; // тот же тред уже в полёте (собственный probe-запрос)

    h.api.probeFolwrCompleteness(FOLWR_URL, [], TID, 'CURSOR-1', 0, []);
    // первый шаг сразу видит busy → ретраи по FOLWR_PAGE_DELAY_MS до капа
    jest.advanceTimersByTime(400 * 6);

    expect(fetchCalls).toBe(0);
    expect(runningFlags(h.events)).toEqual([true, false]);
    expect(h.api.inFlight[KEY]).toBe(false);
    expect(h.api.folwrRunLiveMap[KEY]).toBeFalsy();
    expect(h.sink.join('\n')).toContain('probe завершён: reason=inflight-suppressed');
  });

  test('источник: watchdog/капы и единая точка снятия флага', () => {
    expect(INTERCEPT).toContain('var PROBE_WATCHDOG_MS = 5000;');
    expect(INTERCEPT).toContain("finish('watchdog-timeout', false)");
    expect(INTERCEPT).toContain('clearTimeout(watchdog);');
    expect(INTERCEPT).toContain('if (complete !== true) delete probedTids[tid];');
    expect(INTERCEPT).toContain("finish('inflight-suppressed', false)");
    expect(INTERCEPT).toContain('var BUSY_RETRY_MAX = 5;');
  });
});

describe('BUG-I: TTL флага probe-running (aiCmGsaProbeRunningFor)', () => {
  const SCOPE = 'with (ctx) { ' + fnDecl(MGR, 'aiCmGsaProbeRunningFor') +
    ' return { f: aiCmGsaProbeRunningFor }; }';
  const makeRun = new Function('ctx', SCOPE);

  function run(byThread, globalRunning, cid) {
    return makeRun({
      aiCmGsaProbeByThread: byThread,
      aiCmGsaProbeRunning: globalRunning,
      PROBE_TTL_MS: 15000,
      Date: Date
    }).f(cid);
  }

  test('свежий timestamp → true, просроченный → false', () => {
    expect(run({ [TID]: Date.now() }, false, TID)).toBe(true);
    expect(run({ [TID]: Date.now() - 15000 }, false, TID)).toBe(false);
    expect(run({ [TID]: Date.now() - 15001 }, false, TID)).toBe(false);
  });

  test('неизвестный непустой cid при глобальном true → false (без глобального фолбэка)', () => {
    expect(run({}, true, 'UNKNOWN-THREAD')).toBe(false);
    expect(run({ [TID]: 0 }, true, TID)).toBe(false);
  });

  test('пустой cid → глобальный флаг (поведение прежнее)', () => {
    expect(run({}, true, '')).toBe(true);
    expect(run({}, false, '')).toBe(false);
    expect(run({}, true, null)).toBe(true);
  });

  test('источник: запись timestamp/0 и константа TTL', () => {
    expect(MGR).toContain('var PROBE_TTL_MS = 15000;');
    expect(MGR).toContain('aiCmGsaProbeByThread[d.threadId] = aiCmGsaProbeRunning ? Date.now() : 0;');
    expect(MGR).toContain('return v > 0 && (Date.now() - v) < PROBE_TTL_MS;');
  });
});
