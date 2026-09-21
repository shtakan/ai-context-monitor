/**
 * O-35 (B2-терминал, 2026-09-19): ПИНЫ ФИКСА «холодный старт на пустом чате → SPA на /c/<id>».
 *
 * ДЕФЕКТ (живой лог 17:49-17:50, read-only): пустой чат → DRAW-ПРОПУСК (isInitialized=false);
 * SPA на чат с /c/<id> → qwen-spa: conv-changed-recv / reset-done / reshoot initialized=0,
 * dispatched=1 — и «тишина»: ноль строк qwen-adapter / svc-emit-trace / history-write. Попап
 * «Откройте поддерживаемый сайт», кнопки экспорта неактивны, бейдж «—». F5/deep-link работает.
 *
 * КОРЕНЬ (подтверждён инспекцией = вариант b): после SPA единственный мост к контуру —
 * конечная лесенка reshoot 500/1500/3000 мс. DOM нового чата отрисовался позже неё →
 * все tryInit дали not-found, а разбудить контур дальше НЕЧЕМ: периодического тика у контура
 * нет, observer не заведён (startObserving зовёт только tryInit). Вариант (c) исключён
 * порядком строк: svc-emit-trace печатается ВЫШЕ DRAW-гарда, значит его отсутствие в логе
 * означает «processAndSend не вызван вовсе», а не падение внутри прохода. Вариант (a) исключён
 * тем, что единственный оператор до tryInit — aiCmAssignAdapterByHost() (`new QwenAdapter()`,
 * конструктор без DOM/состояния), и тот же вызов уже отработал на холодном старте (иначе не
 * было бы ни текущего адаптера qwen, ни строк qwen-spa).
 *
 * ФИКС: (1) терминальный шаг реактивации aiCmQwenTerminalReshoot (6000 мс, ровно один таймер и
 * ровно один проход processAndSend) фиксирует размер DOM-базы адаптера в aiCmAdapterBaseCount;
 * (2) гард processAndSend пропускает путь «адаптерная база готова, isInitialized ещё нет»
 * (&& !aiCmAdapterBaseSeen()).
 *
 * ПИНЫ НИЖЕ (R-D, только на новые пути):
 *   D1/D2/D3 — дефект-пины (ФЛИП ФИКСА): терминал доносит базу до aiCmHistory (source=adapter)
 *              и aiCmState без F5, порядок «фиксация базы → проход», локализация корня (b);
 *   R1/R4    — терминал срабатывает РОВНО один раз (пустой DOM / исключение адаптера),
 *              периодики и вторых писателей isInitialized не появляется;
 *   R2       — поведенческие вердикты РЕАЛЬНОГО текста условия гарда: пустой путь прежний,
 *              F5/готовый чат и полная сетевая база — как раньше;
 *   R3       — F5/готовый чат: ветка awake не взводит терминал (байты и число проходов прежние),
 *              лесенка 500/1500/3000 остаётся прежней, терминал — четвёртый отдельный таймер.
 */

const fs = require('fs');
const path = require('path');
const H = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = H.contentSource;
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');

const CHAT_ID = 'cda86f26-0155-4243-a134-777d909a936b';
const OTHER_CHAT_ID = 'be4e7956-0000-1111-2222-333333333333';
const DIAG_PREFIX = '[AI CM][diag] qwen-init ';

// Рез по балансу фигурных скобок (стиль tests/qwen-gate-diag-o35.test.js).
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

function diagLines() {
  const spy = console.log;
  if (!spy || !spy.mock || !spy.mock.calls) return [];
  return spy.mock.calls.map(function (a) { return String(a[0]); })
    .filter(function (s) { return s.indexOf(DIAG_PREFIX) === 0; });
}
/** Строка события ровно с этим event= (граневой пробел — 'reshoot-terminal' ≠ '…-throw'). */
function diagLine(event) {
  return diagLines().filter(function (s) {
    return s.indexOf(' event=' + event + ' ') !== -1;
  })[0];
}

/** 156 сообщений — «msgs=156» из живой консоли 14:48:51.318 (порядок величины адаптерной базы). */
function adapterBatch(n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push({ role: (i % 2) ? 'assistant' : 'user', content: 'm' + i });
  return arr;
}

/**
 * Стенд реактивации: РЕАЛЬНЫЕ aiCmQwenSpaReshoot + aiCmQwenTerminalReshoot + aiCmAdapterBaseSeen
 * (тот же канал строк qwen-init, те же таймеры). Сеть/расширения не трогаем.
 */
function runTerminalStand(opts) {
  const o = opts || {};
  jest.useFakeTimers();
  const calls = { detect: 0, init: 0, send: 0, observes: 0 };
  const ctx = {
    window: window,
    location: window.location,
    currentAdapter: {
      siteName: o.site || 'qwen',
      extractMessages: function () {
        if (o.adapterThrows) throw new Error('adapter-boom');
        return o.adapterMsgs || [];
      }
    },
    isInitialized: !!o.initialized,
    // состояние процесса: «ложимся спать» ровно так же, как на пустом чате
    baseSeen: false,
    baseCount: 0,
    lastBaseTexts: [],
    aiCmAdapterBaseCount: 0,
    baseSeenForSend: -1,          // значение aiCmAdapterBaseCount В МОМЕНТ прохода (порядок)
    aiCmAssignAdapterByHost: function () { calls.detect++; },
    // «DOM ещё не отрисован на лесенке»: tryInit не поднимает контур (isInitialized=false)
    tryInit: function () { calls.init++; },
    startObserving: function () { calls.observes++; },
    processAndSend: function () { calls.send++; ctx.baseSeenForSend = ctx.aiCmAdapterBaseCount; },
    getCurrentConvId: function () { return OTHER_CHAT_ID; },
    aiCmDiagStack: function () { return ''; }
  };
  const scope = 'with (ctx) { ' + fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' + fnDecl(CONTENT, 'aiCmQwenInitErrText') + '\n' +
    fnDecl(CONTENT, 'aiCmQwenInitDiag') + '\n' + fnDecl(CONTENT, 'aiCmAdapterBaseSeen') + '\n' +
    fnDecl(CONTENT, 'aiCmQwenSpaReshoot') + '\n' + fnDecl(CONTENT, 'aiCmQwenTerminalReshoot') +
    '\n return { reshoot: aiCmQwenSpaReshoot, terminal: aiCmQwenTerminalReshoot }; }';
  const api = new Function('ctx', scope)(ctx);
  return { api: api, ctx: ctx, calls: calls };
}

beforeAll(function () {
  window.history.replaceState({}, '', '/c/' + CHAT_ID);
});

beforeEach(function () {
  jest.spyOn(console, 'log').mockImplementation(function () { });
  sessionStorage.setItem('aiCmDebug', '1');
});

afterEach(function () {
  jest.useRealTimers();
  jest.restoreAllMocks();
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

// =====================================================================================
// D: дефект-пины фикса (холодный старт на пустом чате → SPA на /c/<id>)
// =====================================================================================
describe('O-35 B2-терминал: D-пины (SPA-пересъём базы без F5)', function () {
  test('D1 ФЛИП ФИКСА: лесенка исчерпана → терминал снимает DOM-базу и делает РОВНО один проход processAndSend', function () {
    const st = runTerminalStand({ adapterMsgs: adapterBatch(156) });
    st.api.reshoot();
    // 0 мс + 500 + 1500 + 3000: четыре попытки tryInit, терминала ещё нет (горизонт лесенки)
    jest.advanceTimersByTime(3000);
    expect(st.calls).toEqual({ detect: 1, init: 4, send: 0, observes: 0 });
    expect(st.ctx.isInitialized).toBe(false);
    expect(st.ctx.aiCmAdapterBaseCount).toBe(0);        // база ещё не снята — терминала не было
    // 6000 мс: терминальный шаг
    jest.advanceTimersByTime(3000);
    expect(st.calls.send).toBe(1);                      // ровно один проход
    expect(st.ctx.aiCmAdapterBaseCount).toBe(156);      // база зафиксирована под гард
    expect(st.ctx.baseSeenForSend).toBe(156);           // ПОРЯДОК: фиксация ДО processAndSend
    expect(st.ctx.baseSeen).toBe(false);                // сетевой базы по-прежнему нет (SPA-открытие)
    expect(st.ctx.isInitialized).toBe(false);           // второй писатель isInitialized не заведён
    expect(st.calls.observes).toBe(0);                 // наблюдатель не подменён терминалом
    const term = diagLine('reshoot-terminal');
    expect(term).toBeTruthy();
    expect(term).toContain('adapterMsgs=156');
    expect(term).toContain('ready=1');                  // вердикт реального aiCmAdapterBaseSeen()
    expect(diagLine('reshoot-terminal-throw')).toBeUndefined();
    // «только один раз»: ни периодики, ни второго терминала
    jest.advanceTimersByTime(120000);
    expect(st.calls.send).toBe(1);
    expect(st.calls.init).toBe(4);
  });

  test('D2 ФЛИП ФИКСА: цепочка фикса — размер адаптерной базы → гард → history-write source=adapter → снимок aiCmState', function () {
    const term = fnDecl(CONTENT, 'aiCmQwenTerminalReshoot');
    // 1) база фиксируется ДО прохода (иначе новый пропускной путь гарда недостижим)
    expect(term).toContain('aiCmAdapterBaseCount = (termMsgs > 0) ? termMsgs : 0;');
    expect(term.indexOf('aiCmAdapterBaseCount = (termMsgs')).toBeLessThan(term.indexOf('processAndSend();'));
    // 2) ровно один проход и никаких вторых контуров/состояний
    expect((term.match(/processAndSend\(\);/g) || []).length).toBe(1);
    expect(term).not.toContain('startObserving');
    expect(term).not.toContain('isInitialized = true');
    expect(term).not.toContain('setTimeout');
    // единственный писатель isInitialized остаётся tryInit (content.js:1065)
    expect((CONTENT.match(/isInitialized = true;/g) || []).length).toBe(1);
    // 3) база уходит в aiCmHistory ТОЛЬКО ниже гарда — новый путь гарда её пропускает
    const draw = fnDecl(CONTENT, 'processAndSend');
    const iGuard = draw.indexOf('&& !aiCmAdapterBaseSeen()) {');
    const iWrite = draw.indexOf('history-write source=adapter');
    expect(iGuard).toBeGreaterThan(-1);
    expect(iWrite).toBeGreaterThan(iGuard);
    expect(draw).toContain("histPatchS24['aiCmHistory:' + window.location.hostname]");
    // 4) v54: та же ветка отпускает SPA-супрессию бейджа → число вместо «—»
    expect(draw).toContain('adapterBaseSeen = true;');
    expect(draw).toContain('var badgeSuppressActive = (badgeSuppressed && !baseSeen && !adapterBaseSeen);');
  });

  test('D3: локализация корня (b): svc-emit-trace печатается ВЫШЕ гарда — «тишина» в логе = processAndSend не вызван', function () {
    const draw = fnDecl(CONTENT, 'processAndSend');
    const iTrace = draw.indexOf('[AI CM][svc-emit-trace]');
    const iGuard = draw.indexOf('&& !aiCmAdapterBaseSeen()) {');
    expect(iTrace).toBeGreaterThan(-1);
    expect(iGuard).toBeGreaterThan(-1);
    // Порядок строк — доказательство: отсутствие svc-emit-trace в живом логе 17:49-17:50
    // означало «проход не входил вовсе» (вариант b), а не падение внутри прохода (вариант c).
    expect(iTrace).toBeLessThan(iGuard);
    // Корень (a) — исключение до tryInit — не подтверждён: до tryInit только детект адаптера,
    // а в reactivation-ветке НЕТ голого catch вокруг него (исключение логируется, а не глотается).
    const resh = fnDecl(CONTENT, 'aiCmQwenSpaReshoot');
    expect(resh.indexOf('aiCmAssignAdapterByHost();')).toBeLessThan(resh.indexOf('tryInit();'));
    expect(resh).toContain("aiCmQwenInitDiag('reshoot-throw'");
    // терминал — ЗА лесенкой и только в ветке «спит»
    expect(resh.indexOf('aiCmQwenTerminalReshoot();')).toBeGreaterThan(resh.indexOf('}, 3000);'));
  });
});

// =====================================================================================
// R: регресс-пины (только новые пути; прежние вердикты не двигаются)
// =====================================================================================
describe('O-35 B2-терминал: R-пины (один раз, пустой путь прежний, F5 без изменений)', function () {
  test('R1: пустой DOM → терминальный проход ровно один раз, адаптерная база НЕ фиксируется (путь прежний)', function () {
    const st = runTerminalStand({ adapterMsgs: [] });
    st.api.reshoot();
    jest.advanceTimersByTime(3000);
    expect(st.calls.send).toBe(0);
    jest.advanceTimersByTime(3000);
    expect(st.calls.send).toBe(1);                      // ровно один терминальный проход
    expect(st.ctx.aiCmAdapterBaseCount).toBe(0);        // база не выдумана
    expect(st.ctx.baseSeenForSend).toBe(0);
    const term = diagLine('reshoot-terminal');
    expect(term).toContain('adapterMsgs=0');
    expect(term).toContain('ready=0');                  // адаптерной базы нет → гард вернёт проход
    jest.advanceTimersByTime(120000);
    expect(st.calls.send).toBe(1);                      // периодики нет: «только один раз»
  });

  test('R2: вердикты РЕАЛЬНОГО условия гарда — новый путь проходит, пустой/F5/сеть — как раньше', function () {
    const draw = fnDecl(CONTENT, 'processAndSend');
    const line = draw.split('\n').filter(function (l) {
      return l.indexOf('if (!isInitialized && !(baseSeen && baseComplete)') !== -1;
    })[0];
    expect(line).toBeTruthy();
    const cond = line.slice(line.indexOf('if (') + 4, line.lastIndexOf(') {'));
    const skip = new Function('isInitialized', 'baseSeen', 'baseComplete', 'aiCmAdapterBaseSeen',
      'return !!(' + cond + ');');
    const noBase = function () { return false; };
    const hasBase = function () { return true; };
    // холодный старт пустого чата и пустой DOM после SPA: адаптерной базы нет → DRAW-ПРОПУСК
    expect(skip(false, false, false, noBase)).toBe(true);
    // НОВЫЙ путь (D1): терминал зафиксировал адаптерную базу → проход НЕ пропускается
    expect(skip(false, false, false, hasBase)).toBe(false);
    // F5/готовый чат: контур поднят → проход как раньше
    expect(skip(true, false, false, noBase)).toBe(false);
    // полная сетевая база → проход как раньше
    expect(skip(false, true, true, noBase)).toBe(false);
    // ФЛИП ФИКСА: прежняя формула на новом пути давала DRAW-ПРОПУСК — это и был дефект
    const oldSkip = new Function('isInitialized', 'baseSeen', 'baseComplete',
      'return !!(!isInitialized && !(baseSeen && baseComplete));');
    expect(oldSkip(false, false, false)).toBe(true);
  });

  test('R3: F5/готовый чат — ветка awake не взводит терминал; лесенка 500/1500/3000 и число проходов прежние', function () {
    const st = runTerminalStand({ initialized: true, adapterMsgs: adapterBatch(156) });
    st.api.reshoot();
    expect(st.calls).toEqual({ detect: 1, init: 0, send: 1, observes: 0 });  // штатный processAndSend
    expect(st.ctx.isInitialized).toBe(true);
    jest.advanceTimersByTime(120000);
    expect(st.calls).toEqual({ detect: 1, init: 0, send: 1, observes: 0 });  // терминала нет вовсе
    expect(st.ctx.aiCmAdapterBaseCount).toBe(0);        // и базу терминал не трогал
    expect(diagLine('reshoot-terminal')).toBeUndefined();
    // исходник: ветка awake не содержит терминала, а таймеры реактивации — прежние + один новый
    const resh = fnDecl(CONTENT, 'aiCmQwenSpaReshoot');
    const iAsleep = resh.indexOf('if (!isInitialized) {');
    const iTerm = resh.indexOf('aiCmQwenTerminalReshoot();');
    const iAwake = resh.indexOf('} else {');
    expect(iAsleep).toBeGreaterThan(-1);
    expect(iTerm).toBeGreaterThan(iAsleep);
    expect(iTerm).toBeLessThan(iAwake);
    const timers = (resh.match(/\}, (\d+)\);/g) || []).map(function (s) { return s.replace(/\D/g, ''); });
    expect(timers).toEqual(['500', '1500', '3000', '6000']);
    expect(resh).toContain("}, 500);");
    expect(resh).toContain("}, 1500);");
    expect(resh).toContain("}, 3000);");
    expect(resh).toContain('}, 6000);');
  });

  test('R4: исключение адаптера в терминале не ломает контур: строка есть, база не фиксируется, проход один', function () {
    const st = runTerminalStand({ adapterThrows: true });
    st.api.reshoot();
    jest.advanceTimersByTime(3000);
    expect(st.calls.send).toBe(0);
    jest.advanceTimersByTime(3000);
    expect(st.calls.send).toBe(1);                      // контур не оборван исключением
    expect(st.ctx.aiCmAdapterBaseCount).toBe(0);        // «адаптерной базы нет» — как при пустом DOM
    expect(diagLine('reshoot-terminal-throw')).toContain('error=Error: adapter-boom');
    expect(diagLine('reshoot-terminal')).toContain('adapterMsgs=-2');
    jest.advanceTimersByTime(120000);
    expect(st.calls.send).toBe(1);                      // и повторных попыток не появляется
    expect(st.calls.init).toBe(4);                      // лесенка не перевзводится
  });

  test('R5: гейт выключен → терминал не печатает ни строки, а вызовы processAndSend те же (G1/G2)', function () {
    sessionStorage.removeItem('aiCmDebug');
    const off = runTerminalStand({ adapterMsgs: adapterBatch(3) });
    off.api.reshoot();
    jest.advanceTimersByTime(6000);
    expect(diagLines()).toEqual([]);
    expect(off.calls.send).toBe(1);
    expect(off.ctx.aiCmAdapterBaseCount).toBe(3);
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    sessionStorage.setItem('aiCmDebug', '1');
    const on = runTerminalStand({ adapterMsgs: adapterBatch(3) });
    on.api.reshoot();
    jest.advanceTimersByTime(6000);
    expect(on.calls).toEqual(off.calls);                // байты/вызовы не зависят от гейта
    expect(on.ctx.aiCmAdapterBaseCount).toBe(off.ctx.aiCmAdapterBaseCount);
    expect(diagLine('reshoot-terminal')).toBeTruthy();
  });
});
