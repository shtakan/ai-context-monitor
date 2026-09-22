/**
 * O-24 (F6): ЗАЦИКЛЕННЫЙ svc-emit ПОСЛЕ already-fired — гарды холостого processAndSend.
 *
 * ДЕФЕКТ (измерение 2026-09-22, read-only): точка инициации — дебаунс MutationObserver
 * (core/content.js, startObserving), триггер — DOM-мутации вне расширения при НЕИЗМЕННОЙ
 * базе (histKey стабилен). Повторного эмита ai-cm-full-history нет (дедуп истории работает),
 * шум = дорогие холостые прогоны processAndSend() (токенизация, виджет, SW) с каденсом 1–2 с.
 * Функциональное гашение корректно (already-fired + дедуп истории); проблема — ресурсная
 * избыточность. Один из корней самоподхвата: updateWidget() пишет textContent ВНУТРИ
 * #ai-context-widget, а observer наблюдает document.body{subtree,characterData} — виджет
 * взводил следующий проход собственным обновлением.
 *
 * ФИКС (core/content.js): (1) aiCmIsWidgetNode + фильтр в hasNewText (target и addedNodes);
 * (2) aiCmDomTextSig = baseCount|длина эффективного текста — та же формула, что у канала
 * v55 ai-cm-dom-emit-request (общая переменная aiCmLastDomEmitSig, привязка к convId через
 * aiCmLastDomEmitConvId); (3) гард срабатывает только при взведённом латче O-38
 * (aiCmAutoExportFiredOnce, 'site|convId') — до первого fired поведение прежнее.
 *
 * ПИНЫ (R-D):
 *   D1 — воспроизведение цикла: неизменная база + внешняя мутация → после первого fired
 *        повторные батчи процесс НЕ взводят (ровно один прогон, дальше 0);
 *   D2 — легитимный эмит: новый ход меняет базу → sig меняется → processAndSend вызван;
 *   D3 — мутации внутри #ai-context-widget не триггерят hasNewText (гул виджета не взводит
 *        новый проход), а внешний ход взводит;
 *   R1 — до первого fired (латч пуст) холостой батч ведёт себя прежним путём (пересчёт);
 *   R2 — латч другого чата/сервиса не запирает текущий; пустой convId не латчится (GSA);
 *   R3 — смена convId сбрасывает сигнатуру (SPA-переход не запирается);
 *   R4 — база ещё не принята (baseSeen=false) → сигнатура по счётчику, поведение прежнее;
 *   R5 — прежние пороги hasNewText (короткий childList, attributes) не двигаются;
 *   R6/R7/R8 — исходники: точки фикса, единственность писателя sig, байты канала v55,
 *        гейт диагностики, проводка aiCmLastDomEmitConvId в state.js.
 *
 * Стенд: РЕАЛЬНЫЙ core/content.js (startObserving + aiCmIsWidgetNode + aiCmDomTextSig,
 * вырезанные из источника по балансу скобок) в реальном jsdom с внешним лексическим
 * контекстом — вместо переписывания логики в тесте.
 */

const H = require('./helpers/content-source.js');

const CONTENT = H.contentSource;

const CHAT_ID = '49846f0e-32fb-4e2a-8da7-1c0b3a2f0b6e';
const OTHER_CHAT_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';
const OTHER_SITE = 'chatgpt';
const BASE_TEXT = 'база длиной 36 символов ровно тут!'; // 36 знаков — проверяем арифметику sig

/** Рез объявления по балансу фигурных скобок (стиль tests/qwen-spa-terminal-o35.test.js). */
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

/** Колбэк observer'а из РЕАЛЬНОГО startObserving: от `new MutationObserver(` до закрывающей скобки. */
function observerCallbackSrc(src) {
  const fn = fnDecl(src, 'startObserving');
  const start = fn.indexOf('new MutationObserver(');
  expect(start).toBeGreaterThan(-1);
  const open = fn.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < fn.length; i++) {
    if (fn[i] === '(') depth++;
    else if (fn[i] === ')') {
      depth--;
      if (depth === 0) return fn.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced observer callback');
}

/**
 * Стенд observer'а: реальные aiCmIsWidgetNode/aiCmSiteConvFired/aiCmDomTextSig и колбэк
 * startObserving в настоящем jsdom. ctx — внешний лексический контекст (как общий скоуп
 * контент-скриптов манифеста: модули и content.js видят объявления друг друга).
 */
function makeObserver(ctx) {
  const scope = 'with (ctx) {\n' +
    'var AI_CM_WIDGET_ELEMENT_ID = "ai-context-widget";\n' +
    fnDecl(CONTENT, 'aiCmIsWidgetNode') + '\n' +
    fnDecl(CONTENT, 'aiCmSiteConvFired') + '\n' +
    fnDecl(CONTENT, 'aiCmDomTextSig') + '\n' +
    'var cb = ' + observerCallbackSrc(CONTENT) + ';\n' +
    'return cb;\n}';
  const cb = new Function('ctx', scope)(ctx);
  return {
    fire: function (mutations) {
      let error = null;
      try { cb(mutations); } catch (e) { error = (e && e.stack) || String(e); }
      return error;
    }
  };
}

/** Мир чата: база/текст/латч — НЕЗАВИСИМЫЕ объекты на каждый вызов (тесты не текут). */
function chatCtx(opts) {
  const o = opts || {};
  const state = {
    convId: (o.convId === undefined) ? CHAT_ID : o.convId,
    site: o.site || 'deepseek',
    baseCount: (o.baseCount === undefined) ? 128 : o.baseCount,
    baseSeen: (o.baseSeen === undefined) ? true : o.baseSeen,
    baseText: (o.baseText === undefined) ? BASE_TEXT : o.baseText,
    effective: (o.effective === undefined) ? BASE_TEXT : o.effective,
    fired: Object.assign(Object.create(null), o.fired || {}),
    calls: 0
  };
  return {
    state: state,
    ctx: {
      window: window,
      document: window.document,
      location: window.location,
      aiCmLastDomEmitConvId: null,
      aiCmLastDomEmitSig: null,
      aiCmAutoExportFiredOnce: state.fired,
      updateTimer: null,
      mutationCount: 0,
      currentAdapter: { siteName: state.site },
      get baseCount() { return state.baseCount; },
      get baseSeen() { return state.baseSeen; },
      get baseText() { return state.baseText; },
      getEffectiveText: function () { return state.effective; },
      getCurrentConvId: function () { return state.convId; },
      debugLog: function () { },
      aiCmDiagLine: function () { },
      processAndSend: function () { state.calls++; }
    }
  };
}

/** Мутация — настоящий объект: гард читает target/addedNodes, а не литерал. */
function mut(type, target, addedNodes) {
  return { type: type, target: target, addedNodes: addedNodes || [] };
}

/** Внешний «шумовой» узел чата (вне виджета) с текстом длиннее 10 символов. */
function chatNode(text) {
  const d = window.document.createElement('div');
  return d;
}

/** Виджет расширения и его узел (как пишет updateWidget → percentText.textContent). */
function widgetFixture() {
  let w = window.document.getElementById('ai-context-widget');
  if (!w) {
    w = window.document.createElement('div');
    w.id = 'ai-context-widget';
    window.document.body.appendChild(w);
  }
  const pt = window.document.createElement('span');
  pt.className = 'ai-widget-text';
  pt.textContent = '12.3%';
  w.appendChild(pt);
  return { w: w, pt: pt };
}

beforeAll(function () {
  window.history.replaceState({}, '', '/a/chat/s/' + CHAT_ID);
});

beforeEach(function () {
  jest.useFakeTimers();
});

afterEach(function () {
  jest.useRealTimers();
  const old = window.document.getElementById('ai-context-widget');
  if (old) old.remove();
});

// =====================================================================================
// D: дефект-пины (цикл при неизменной базе — гасится; новый ход — проходит)
// =====================================================================================
describe('O-24 (F6): D-пины сигнатурного гарда в MutationObserver', function () {
  test('D1: неизменная база + внешняя мутация + already-fired → холостого processAndSend нет', function () {
    const st = chatCtx({});
    st.state.fired['deepseek|' + CHAT_ID] = 1;   // автоэкспорт этого чата уже снят (латч O-38)
    const obs = makeObserver(st.ctx);
    const noise = [mut('characterData', window.document.createTextNode('внешняя мутация страницы'))];

    expect(obs.fire(noise)).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);              // первый батч после fired — проход как прежде
    expect(st.ctx.aiCmLastDomEmitSig).toBe('128|' + BASE_TEXT.length);
    expect(st.ctx.aiCmLastDomEmitConvId).toBe(CHAT_ID);

    // ТОТ ЖЕ батч (база/текст не менялись) — шум страницы/соседа: каденс 1–2 с в живом логе
    expect(obs.fire(noise)).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(obs.fire(noise)).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);              // ФЛИП: было 3 холостых прогона — стал 1
    expect(jest.getTimerCount()).toBe(0);        // и дебаунс не перевзведён
  });

  test('D2: новый ход меняет базу → sig меняется → легитимный processAndSend вызван', function () {
    const st = chatCtx({ effective: 'ход 1' });
    st.state.fired['deepseek|' + CHAT_ID] = 1;
    const obs = makeObserver(st.ctx);

    expect(obs.fire([mut('characterData', window.document.createTextNode('шум'))])).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);
    expect(st.ctx.aiCmLastDomEmitSig).toBe('128|5');

    // Новый ход: база выросла (baseCount 128 → 130) и эффективный текст длиннее
    st.state.baseCount = 130;
    st.state.effective = 'ход 1 и новый ответ модели';
    const long = window.document.createElement('div');
    long.textContent = 'Новый ответ ассистента';
    expect(obs.fire([mut('childList', window.document.body, [long])])).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(2);              // легитимный путь цел
    expect(st.ctx.aiCmLastDomEmitSig).toBe('130|26');

    // ...и только ПОСЛЕ прохода тот же новый батч снова глушится
    expect(obs.fire([mut('characterData', window.document.createTextNode('шум'))])).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(2);
  });

  test('D3: мутации внутри #ai-context-widget не триггерят hasNewText (гул виджета)', function () {
    const st = chatCtx({ effective: 'база' });
    st.state.fired['deepseek|' + CHAT_ID] = 1;
    const wf = widgetFixture();
    const obs = makeObserver(st.ctx);

    // 0) containment-контракт хелпера: предок виджета (body/documentElement) — НЕ виджет.
    // Инвертированное containment (el.contains(w)) ложно относило бы к виджету весь body
    // и глушило ЛЮБУЮ внешнюю мутацию — этот пин ловит такую инверсию.
    const helperScope = 'with (ctx) { var AI_CM_WIDGET_ELEMENT_ID = "ai-context-widget";\n' +
      fnDecl(CONTENT, 'aiCmIsWidgetNode') + '\nreturn aiCmIsWidgetNode; }';
    const isWidget = new Function('ctx', helperScope)({ document: window.document, window: window });
    expect(isWidget(wf.w)).toBe(true);
    expect(isWidget(wf.pt)).toBe(true);
    expect(isWidget(wf.pt.firstChild)).toBe(true);          // текстовый узел виджета
    expect(isWidget(window.document.body)).toBe(false);     // предок виджета — НЕ виджет
    expect(isWidget(window.document.documentElement)).toBe(false);
    expect(isWidget(null)).toBe(false);

    // 1) только виджет: characterData самого виджета/его узла + childList внутри виджета
    expect(obs.fire([mut('characterData', wf.w.firstChild)])).toBeNull();
    expect(obs.fire([mut('characterData', wf.pt.firstChild)])).toBeNull();
    expect(obs.fire([mut('childList', wf.w, [window.document.createTextNode('тултип 12.3%')])])).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(0);              // ФЛИП: раньше каждый гул виджета звал процесс
    expect(jest.getTimerCount()).toBe(0);

    // 2) внешний ход чата — взводит
    const long = window.document.createElement('div');
    long.textContent = 'Ответ ассистента';
    expect(obs.fire([mut('childList', window.document.body, [long])])).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);

    // 3) виджет перерисовался ПОСЛЕ прохода — нового цикла нет
    wf.pt.firstChild.nodeValue = '15.0%';
    expect(obs.fire([mut('characterData', wf.pt.firstChild)])).toBeNull();
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);
  });
});

// =====================================================================================
// R: регресс-пины (до fired, без автоэкспорта, прежние пороги hasNewText)
// =====================================================================================
describe('O-24 (F6): R-пины (поведение до fired и без автоэкспорта прежнее)', function () {
  test('R1: латч пуст (автоэкспорт ещё не срабатывал) → холостой батч идёт прежним путём', function () {
    const st = chatCtx({ effective: 'база' });   // fired пуст: до порога поведение не меняем
    const obs = makeObserver(st.ctx);
    const noise = [mut('characterData', window.document.createTextNode('шум страницы'))];

    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);
    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(2);              // сигнатурный гард один НЕ глушит
    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(3);
  });

  test('R2: латч другого чата/сервиса не запирает текущий; пустой convId не латчится', function () {
    const st = chatCtx({ effective: 'база' });
    st.state.fired['deepseek|' + OTHER_CHAT_ID] = 1;    // латч другого разговора
    st.state.fired[OTHER_SITE + '|' + CHAT_ID] = 1;     // латч другого сервиса
    const obs = makeObserver(st.ctx);
    const noise = [mut('characterData', window.document.createTextNode('шум'))];

    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(2);              // ключ site|convId строгий

    // GSA: надёжного id в URL нет (convId='') — «чата нет» → гард не применяется
    const gsa = chatCtx({ convId: '', site: 'google_search', effective: 'база' });
    gsa.state.fired['google_search|'] = 1;
    const obs2 = makeObserver(gsa.ctx);
    obs2.fire([mut('characterData', window.document.createTextNode('шум'))]);
    jest.advanceTimersByTime(3000);
    obs2.fire([mut('characterData', window.document.createTextNode('шум'))]);
    jest.advanceTimersByTime(3000);
    expect(gsa.state.calls).toBe(2);
  });

  test('R3: смена чата сбрасывает сигнатуру (SPA-переход не запирается)', function () {
    const st = chatCtx({ effective: 'база' });
    st.state.fired['deepseek|' + CHAT_ID] = 1;
    const obs = makeObserver(st.ctx);
    const noise = [mut('characterData', window.document.createTextNode('шум'))];

    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);              // тот же чат, та же база → глушится

    // SPA-переход в другой чат: сигнатура байтов та же, но у неё свой convId
    st.state.convId = OTHER_CHAT_ID;
    st.state.fired['deepseek|' + OTHER_CHAT_ID] = 1;
    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(2);
    expect(st.ctx.aiCmLastDomEmitConvId).toBe(OTHER_CHAT_ID);

    // и в НОВОМ чате повтор того же батча снова глушится
    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(2);
  });

  test('R4: база ещё не принята (baseSeen=false) → сигнатура по счётчику, поведение прежнее', function () {
    const st = chatCtx({ baseSeen: false, baseText: '', baseCount: 0, effective: '' });
    st.state.fired['deepseek|' + CHAT_ID] = 1;
    const obs = makeObserver(st.ctx);
    const noise = [mut('characterData', window.document.createTextNode('шум'))];

    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);
    expect(st.ctx.aiCmLastDomEmitSig).toBe('0|0');   // базы нет — длина эффективного текста 0
    obs.fire(noise);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(1);                  // пустой хвост без базы — тот же гард
  });

  test('R5: прежние пороги hasNewText не двигаются (короткий childList, attributes)', function () {
    const st = chatCtx({ effective: 'база' });
    st.state.fired['deepseek|' + CHAT_ID] = 1;
    const obs = makeObserver(st.ctx);
    const short = window.document.createElement('div');
    short.textContent = 'коротко';
    const noiseTarget = window.document.createElement('div');
    noiseTarget.textContent = 'внешняя мутация страницы';

    obs.fire([mut('childList', window.document.body, [short])]);
    obs.fire([mut('attributes', noiseTarget)]);
    jest.advanceTimersByTime(3000);
    expect(st.state.calls).toBe(0);              // >10 символов и attributes:false — прежние
  });
});

// =====================================================================================
// Source-пины: точки фикса, единственность писателя, байты существующих путей
// =====================================================================================
describe('O-24 (F6): source-пины точек фикса', function () {
  test('R6: фильтр виджета стоит в hasNewText и покрывает и target, и addedNodes', function () {
    const fn = fnDecl(CONTENT, 'startObserving');
    const iHasNew = fn.indexOf('const hasNewText = mutations.some');
    const iTarget = fn.indexOf('if (aiCmIsWidgetNode(mutation.target)) return false;');
    const iAdded = fn.indexOf('if (aiCmIsWidgetNode(node)) continue;');
    const iCharData = fn.indexOf("return mutation.type === 'characterData';");
    expect(iHasNew).toBeGreaterThan(-1);
    expect(iTarget).toBeGreaterThan(iHasNew);
    expect(iAdded).toBeGreaterThan(iTarget);
    expect(iCharData).toBeGreaterThan(iAdded);
    // виджет определяется по своему id из одной константы
    expect(fnDecl(CONTENT, 'aiCmIsWidgetNode')).toContain("closest('#' + AI_CM_WIDGET_ELEMENT_ID)");
    expect(CONTENT).toContain("var AI_CM_WIDGET_ELEMENT_ID = 'ai-context-widget';");
    // константа ровно одна и совпадает с id, который ставит widget.js
    expect((CONTENT.match(/var AI_CM_WIDGET_ELEMENT_ID = 'ai-context-widget';/g) || []).length).toBe(1);
    expect(H.readSource('core/widget.js')).toContain("container.id = 'ai-context-widget';");
  });

  test('R7: сигнатурный гард стоит МЕЖДУ hasNewText и дебаунсом, дебаунс прежний', function () {
    const fn = fnDecl(CONTENT, 'startObserving');
    const iHasNew = fn.indexOf('if (hasNewText) {');
    const iSig = fn.indexOf('const sig = aiCmDomTextSig();');
    const iGuard = fn.indexOf('if (sig === aiCmLastDomEmitSig && aiCmSiteConvFired()) {');
    const iWrite = fn.indexOf('aiCmLastDomEmitSig = sig;');
    const iCount = fn.indexOf('mutationCount++;');
    const iDelay = fn.indexOf('const delay = Math.min(800 + (mutationCount * 300), 3000);');
    const iSend = fn.indexOf('processAndSend();');
    expect(iHasNew).toBeGreaterThan(-1);
    expect(iSig).toBeGreaterThan(iHasNew);
    expect(iGuard).toBeGreaterThan(iSig);
    expect(iWrite).toBeGreaterThan(iGuard);
    expect(iCount).toBeGreaterThan(iWrite);
    expect(iDelay).toBeGreaterThan(iCount);
    expect(iSend).toBeGreaterThan(iDelay);
    // дебаунс-контракт прежний: тот же timer/та же формула задержки/тот же единственный вызов
    expect(fn).toContain('clearTimeout(updateTimer);');
    expect(fn).toContain('updateTimer = setTimeout(() => {');
    expect((fn.match(/processAndSend\(\);/g) || []).length).toBe(1);
    // observer по-прежнему на document.body с теми же флагами (attributes выключены)
    expect(fn).toContain('observer.observe(document.body, {');
    expect(fn).toContain('childList: true, subtree: true, characterData: true, attributes: false');
  });

  test('R8: сигнатура observer\'а = сигнатура канала v55; латч O-38 только читается', function () {
    // формула гарда
    expect(fnDecl(CONTENT, 'aiCmDomTextSig'))
      .toContain("(typeof baseCount === 'number' ? baseCount : 0) + '|' + eff.length;");
    // формула канала v55 (ai-cm-dom-emit-request) — БАЙТОВО прежняя, не тронута фиксом
    expect(CONTENT).toContain("var sig = baseCount + '|' + (probe ? probe.length : 0);");
    expect(CONTENT).toContain('if (sig === aiCmLastDomEmitSig) return;');
    expect(CONTENT).toContain('aiCmLastDomEmitSig = sig;');
    // писателей aiCmLastDomEmitSig в content.js ровно три: канал v55, observer O-24 и его
    // сброс на смене чата; state.js — только объявление и UMD-аксессор
    const content = H.readSource(H.CONTENT_JS);
    expect((content.match(/aiCmLastDomEmitSig = /g) || []).length).toBe(3);
    expect((content.match(/aiCmLastDomEmitSig = sig;/g) || []).length).toBe(2);
    // латч читается как O-38 (site|convId) и observer его НЕ мутирует
    const fired = fnDecl(CONTENT, 'aiCmSiteConvFired');
    expect(fired).toContain("aiCmAutoExportFiredOnce[site + '|' + cid] === 1");
    expect(fired).not.toContain('aiCmAutoExportFiredOnce[' + 'site + ' + "'|' + cid] = 1;");
    expect(CONTENT).toContain("var aiCmAutoExportFiredOnce = Object.create(null);  // 'site|convId' -> 1");
    expect(CONTENT).toContain("aiCmAutoExportFiredOnce[siteOnce + '|' + cid] = 1;");
  });

  test('R9: диагностика гарда — только под гейтом aiCmDebug, до return', function () {
    const fn = fnDecl(CONTENT, 'startObserving');
    const iGuard = fn.indexOf('if (sig === aiCmLastDomEmitSig && aiCmSiteConvFired()) {');
    const csv = fn.indexOf("aiCmDiagLine('o24-dom-emit-guard'");
    const iReturn = fn.indexOf('return;', csv);
    expect(csv).toBeGreaterThan(iGuard);
    expect(iReturn).toBeGreaterThan(csv);
    expect(fn.slice(csv - 60, csv)).toContain("if (typeof aiCmDiagLine === 'function')");
    expect(fn).toContain("verdict: 'skip-sig-unchanged'");
    // строка печатается ДО return: её наличие в живом логе = гашение сработало
    expect(fn.slice(0, csv)).toContain('aiCmDomTextSig');
    // ни одного нового console.log вне гейта: строк диагностики в observer'е нет
    expect(fn).not.toContain('console.log');
  });

  test('R10: проводка aiCmLastDomEmitConvId в state.js: объявление + UMD-аксессор', function () {
    const state = H.readSource('core/state.js');
    expect(state).toContain('var aiCmLastDomEmitConvId = null;');
    expect(state).toContain("Object.defineProperty(Api, 'aiCmLastDomEmitConvId'");
    // прежняя переменная и её аксессор на месте (регресс канала v55)
    expect(state).toContain('var aiCmLastDomEmitSig = null;');
    expect(state).toContain("Object.defineProperty(Api, 'aiCmLastDomEmitSig'");
  });
});
