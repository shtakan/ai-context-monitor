/** @jest-environment node */
/**
 * O-22 (ФИКС F4): payload-точный гард ПОВТОРНОГО диспатча ai-cm-full-history.
 *
 * Дефект (живой лог 2026-09-18 21:31:12): один и тот же снимок ушёл ТРИ раза за ~10 мс
 * (site=S1172, count=10, ops APPEND:1765/SET:2, frags THINK 5437#809dbd +
 * RESPONSE 1592#c40b57) — ISOLATED-дедуп (histKey=baseCount|textLen, content.js:1760)
 * гасил только ЗАПИСЬ storage (verdict=dedup-skip), а события и вся работа слушателя
 * повторялись. Механизм тройки воспроизводится здесь без правок: финал хода приходит
 * трижды (BATCH FINISHED → event:close → конец тела) с НЕИЗМЕННОЙ базой.
 *
 * Фикс: в ЕДИНОЙ точке (начало тела emitBaseSnapshot, сразу после маркера o22-dispatch-fn)
 * снимок получает сигнатуру из полей области видимости, которые ЦЕЛИКОМ определяют payload
 * события: convId, состав/тексты ходов (id, order, role, modelSlug, длина+отпечаток FNV-1a
 * текста и reasoning), serverTokens, chatMode, вложения и вердикт полноты. Совпала с
 * последней ОПУБЛИКОВАННОЙ → return до dispatchEvent (+ строка o22-dispatch-skip под гейтом),
 * иначе диспатч как прежде. Сброс — на смене convId (convId входит в сигнатуру) и на
 * событии ai-cm-conversation-changed.
 *
 * Сверка выбранных полей по живому логу 21:29–21:31 (три группы диспатчей):
 *   21:29:23 S692 convId=2d0090f5 count=8  ops 0/0        frags []
 *   21:31:12 S1172 ×3 (тройка)               count=10 ops APPEND:1765/SET:2
 *                                            frags THINK 5437#809dbd + RESPONSE 1592#c40b57
 *   21:31:29 S692 convId=8d94ee93 count=52 ops 0/0        frags []
 * → convId+count+ops/frags идентичны внутри тройки и различны между всеми тремя группами;
 *   те же поля (через тексты ходов, собранные из этих же фрагментов, и через svc-emit
 *   histKey=10|18451 в трёх строках 21:31:12) входят в сигнатуру.
 *
 * ЭТАЛОНЫ (GOLDEN_*): payload'ы одиночных путей сняты с РАБОЧЕЙ КОПИИ ДО ФИКСА
 * (HEAD 27df84a) на этом же стенде — пин «байты до/после идентичны».
 *
 * Стенд: РЕАЛЬНЫЙ core/deepseek-intercept.js в jsdom (как deepseek-o18-frag-resync),
 * управляемые history_messages и SSE-тело.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const INTERCEPT_PATH = path.join(ROOT, 'core', 'deepseek-intercept.js');
const INTERCEPT_SRC = fs.readFileSync(INTERCEPT_PATH, 'utf8');

// ---- эталонные payload'ы, снятые ДО фикса (HEAD 27df84a) ----
const GOLDEN_S692_LOAD = String.raw`{"convId":"convO22a","text":"Вопрос 1\nОтвет 1\nВопрос 2\nОтвет 2","count":4,"lastMessageText":"Ответ 2","modelSlug":"deepseek-v3","modelMode":"default","messageTexts":["Вопрос 1","Ответ 1","Вопрос 2","Ответ 2"],"messageIds":["u1","a1","u2","a2"],"messages":[{"role":"user","text":"Вопрос 1","reasoning":""},{"role":"assistant","text":"Ответ 1","reasoning":""},{"role":"user","text":"Вопрос 2","reasoning":""},{"role":"assistant","text":"Ответ 2","reasoning":""}],"reasoningTexts":["","","",""],"reasoningTurns":0,"attachTokens":0,"attachBreak":{"imgTokens":0,"docTokens":0,"imgCount":0,"docCount":0},"historyComplete":true,"reachedRoot":true,"baseEmpty":false,"serverTokens":1000}`;
const GOLDEN_S692_SPA = String.raw`{"convId":"convO22b","text":"Новый вопрос\nНовый ответ","count":2,"lastMessageText":"Новый ответ","modelSlug":"deepseek-v3","modelMode":"default","messageTexts":["Новый вопрос","Новый ответ"],"messageIds":["u1","a1"],"messages":[{"role":"user","text":"Новый вопрос","reasoning":""},{"role":"assistant","text":"Новый ответ","reasoning":""}],"reasoningTexts":["",""],"reasoningTurns":0,"attachTokens":0,"attachBreak":{"imgTokens":0,"docTokens":0,"imgCount":0,"docCount":0},"historyComplete":true,"reachedRoot":true,"baseEmpty":false,"serverTokens":900}`;
const GOLDEN_S1172_FIRST = String.raw`{"convId":"convO22c","text":"Вопрос\n[REASONING]\nдумаю\n\n[ANSWER]\n","count":2,"lastMessageText":"[REASONING]\nдумаю\n\n[ANSWER]\n","modelSlug":"deepseek-r1","modelMode":"expert","messageTexts":["Вопрос","[REASONING]\nдумаю\n\n[ANSWER]\n"],"messageIds":["u1","a1"],"messages":[{"role":"user","text":"Вопрос","reasoning":""},{"role":"assistant","text":"[REASONING]\nдумаю\n\n[ANSWER]\n","reasoning":"думаю","hiddenReasoning":"думаю"}],"reasoningTexts":["","думаю"],"reasoningTurns":1,"attachTokens":0,"attachBreak":{"imgTokens":0,"docTokens":0,"imgCount":0,"docCount":0},"historyComplete":false,"reachedRoot":false,"baseEmpty":false,"serverTokens":9000}`;

// ---- SSE/history-стенд ----
function line(obj) { return 'data: ' + JSON.stringify(obj) + '\n'; }
function ev(n) { return 'event: ' + n + '\n'; }
const BLANK = '\n';
function fragDelta(v) { return line({ p: 'response/fragments', o: 'APPEND', v: v }) + BLANK; }
// дельта КОНТЕНТА последнего фрагмента (путь -1/content) — так растёт текст живого хода
function fragAppendContent(v) { return line({ p: 'response/fragments/-1/content', o: 'APPEND', v: v }) + BLANK; }
function readyChunk(reqId, respId, mode) {
  return ev('ready') + line({ request_message_id: reqId, response_message_id: respId, model_type: mode }) + BLANK;
}
function initChunk(reqId, respId, think, mode) {
  return ev('message') + line({ v: { response: { accumulated_token_usage: 1000, model_type: mode, fragments: [{ type: 'THINK', content: think }] } } }) + BLANK;
}
function finishChunk(tokens) {
  return line({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: tokens }, { p: 'quasi_status', v: 'FINISHED' }] }) + BLANK;
}
function closeChunk() { return ev('close') + line({}) + BLANK; }

function makeChunkedResponse() {
  const enc = new TextEncoder();
  let ctrl = null;
  const stream = new ReadableStream({ start(c) { ctrl = c; } });
  const resp = {
    ok: true, status: 200,
    json: () => Promise.resolve({}), text: () => Promise.resolve(''),
    clone: () => ({ body: stream, text: () => Promise.resolve('') })
  };
  return { resp, push: (s) => ctrl.enqueue(enc.encode(s)), end: () => ctrl.close() };
}
const flush = (t) => { let p = Promise.resolve(); for (let i = 0; i < (t || 200); i++) p = p.then(() => { }); return p; };
async function settle(t) {
  await new Promise((r) => setImmediate(r));
  await flush(t || 200);
  await new Promise((r) => setImmediate(r));
  await flush(60);
}

// Цепочка u,a,u,a... (как в живом прогоне: history_messages + accumulated_token_usage)
function histFixture(pairs) {
  const msgs = [];
  for (let i = 0; i < pairs.length; i++) {
    msgs.push({
      message_id: 'u' + (i + 1), parent_id: i === 0 ? null : 'a' + i, role: 'USER', thinking_enabled: false,
      inserted_at: '2026-09-18T21:0' + i + ':01.000Z', accumulated_token_usage: 100 + i * 100,
      fragments: [{ type: 'REQUEST', content: pairs[i][0] }]
    });
    msgs.push({
      message_id: 'a' + (i + 1), parent_id: 'u' + (i + 1), role: 'ASSISTANT', thinking_enabled: false,
      inserted_at: '2026-09-18T21:0' + i + ':00.500Z', accumulated_token_usage: 900 + i * 100,
      fragments: [{ type: 'RESPONSE', content: pairs[i][1] }]
    });
  }
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'a' + pairs.length, model_type: 'default', is_empty: false },
        chat_messages: msgs
      }
    }
  };
}

function makeStand(convId, debug) {
  const vc = new VirtualConsole();
  const logs = [];
  ['log', 'warn', 'error'].forEach((k) => vc.on(k, (...a) => logs.push(a.map(String).join(' '))));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chat.deepseek.com/a/chat/s/' + convId,
    runScripts: 'dangerously',
    virtualConsole: vc
  });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  if (debug !== false) window.sessionStorage.setItem('aiCmDebug', '1');
  const streams = [];
  let historyBody = null;
  window.fetch = (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.indexOf('completion') !== -1) {
      const c = makeChunkedResponse();
      streams.push(c);
      return Promise.resolve(c.resp);
    }
    const body = (url.indexOf('history_messages') !== -1) ? historyBody : null;
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(body), text: () => Promise.resolve(''),
      clone: () => ({ json: () => Promise.resolve(body), text: () => Promise.resolve('') })
    });
  };
  window.eval(INTERCEPT_SRC);
  const emits = [];
  window.addEventListener('ai-cm-full-history', (e) => emits.push(e.detail));
  return {
    window, dom, logs, streams, emits,
    setHistory: (b) => { historyBody = b; },
    markLines: (kind) => logs.filter((l) => l.indexOf(kind) !== -1),
    json: () => emits.map((d) => JSON.stringify(d))
  };
}

function historyUrl(cid) { return 'http://localhost/api/v0/chat/history_messages?chat_session_id=' + cid + '&cache_version=abc'; }

async function loadHistory(stand, cid, fixture) {
  stand.setHistory(fixture);
  await stand.window.fetch(historyUrl(cid));
  await settle(120);
}

// Живой ход: ready → THINK → RESPONSE → …
async function openTurn(stand, cid) {
  await stand.window.fetch('https://chat.deepseek.com/api/v1/chat/completion?x=1', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Вопрос', chat_session_id: cid, thinking_enabled: true })
  });
  const s = stand.streams[stand.streams.length - 1];
  s.push(readyChunk('u1', 'a1', 'expert'));
  await settle(20);
  s.push(initChunk('u1', 'a1', 'думаю', 'expert'));
  s.push(fragDelta(['RESPONSE']));
  return s;
}

describe('O-22 (F4): payload-точный гард повторного диспатча в единой точке emitBaseSnapshot', () => {
  test('D: тройка идентичных диспатчей (BATCH → close → конец тела) → 1 событие + 2 строки o22-dispatch-skip', async () => {
    const stand = makeStand('convO22c');
    const s = await openTurn(stand, 'convO22c');
    s.push(finishChunk(9000));
    s.push(closeChunk());
    await settle(120);
    s.end();
    await settle(120);

    // маркеры входа «измерения-2» на месте: глушится событие, а не измерение
    expect(stand.markLines('o22-dispatch-fn').length).toBe(3);
    // ISOLATED-слушатель получил РОВНО одно событие (F4: было три)
    expect(stand.emits.length).toBe(1);
    expect(stand.json()[0]).toBe(GOLDEN_S1172_FIRST);

    const skips = stand.markLines('o22-dispatch-skip');
    expect(skips.length).toBe(2);
    const parsed = skips.map((l) => JSON.parse(l.slice(l.indexOf('{'))));
    expect(parsed.every((m) => m.site === 'emitBaseSnapshot')).toBe(true);
    expect(parsed[0].sig).toMatch(/^[0-9a-f]{6}$/);
    expect(parsed[0].sig).toBe(parsed[1].sig);          // у тройки одна и та же сигнатура
    expect(parsed[0].count).toBe(2);
    expect(parsed[0].sigLen).toBeGreaterThan(0);
    stand.dom.window.close();
  });

  test('R: гейт вкл/выкл — байты события идентичны, строки skip только под гейтом', async () => {
    const run = async (debug) => {
      const stand = makeStand('convO22c', debug);
      const s = await openTurn(stand, 'convO22c');
      s.push(finishChunk(9000));
      s.push(closeChunk());
      await settle(120);
      s.end();
      await settle(120);
      const out = { json: stand.json(), skip: stand.markLines('o22-dispatch-skip').length, fn: stand.markLines('o22-dispatch-fn').length };
      stand.dom.window.close();
      return out;
    };
    const on = await run(true);
    const off = await run(false);
    expect(on.json).toEqual([GOLDEN_S1172_FIRST]);
    expect(off.json).toEqual(on.json);   // гард не зависит от aiCmDebug
    expect(on.skip).toBe(2);
    expect(off.skip).toBe(0);            // диагностика — только под гейтом
    expect(on.fn).toBe(3);
    expect(off.fn).toBe(0);
  });

  test('R: S692 загрузка истории — одиночный путь байтово прежний (эталон до фикса)', async () => {
    const stand = makeStand('convO22a');
    await loadHistory(stand, 'convO22a', histFixture([['Вопрос 1', 'Ответ 1'], ['Вопрос 2', 'Ответ 2']]));
    expect(stand.emits.length).toBe(1);
    expect(stand.json()[0]).toBe(GOLDEN_S692_LOAD);
    expect(stand.markLines('o22-dispatch-skip').length).toBe(0);
    stand.dom.window.close();
  });

  test('R: S692 SPA-смена чата — первый диспатч новой базы не глушится, оба payload прежние', async () => {
    const stand = makeStand('convO22a');
    await loadHistory(stand, 'convO22a', histFixture([['Вопрос 1', 'Ответ 1'], ['Вопрос 2', 'Ответ 2']]));
    stand.window.history.pushState({}, '', '/a/chat/s/convO22b');
    await loadHistory(stand, 'convO22b', histFixture([['Новый вопрос', 'Новый ответ']]));

    expect(stand.emits.length).toBe(2);      // сброс на смене convId: второй снимок опубликован
    expect(stand.json()).toEqual([GOLDEN_S692_LOAD, GOLDEN_S692_SPA]);
    expect(stand.markLines('o22-dispatch-skip').length).toBe(0);
    stand.dom.window.close();
  });

  test('R: последовательные диспатчи с изменённой базой (текст/хэш фрагментов/serverTokens) НЕ глушатся', async () => {
    const stand = makeStand('convO22e');
    const s = await openTurn(stand, 'convO22e');
    s.push(finishChunk(9000));                 // финал №1: база А
    await settle(120);
    s.push(fragAppendContent('Ещё'));           // текст хода меняется
    s.push(finishChunk(9500));                 // финал №2: база Б (+ serverTokens 9500)
    await settle(120);
    s.push(fragAppendContent(' и ещё'));        // текст хода меняется снова
    s.push(closeChunk());                      // финал №3: база В
    await settle(120);
    s.end();                                   // финал №4: база В (идентична) → глушится
    await settle(120);

    expect(stand.emits.length).toBe(3);        // изменённая база диспатчится всегда
    const texts = stand.emits.map((d) => d.text);
    const tokens = stand.emits.map((d) => d.serverTokens);
    expect(new Set(texts).size).toBe(3);
    expect(new Set(tokens).size).toBeGreaterThan(1);
    expect(stand.markLines('o22-dispatch-skip').length).toBe(1);
    stand.dom.window.close();
  });

  test('R: S560 ре-эмит полноты 0→1 (та же база, другой вердикт) НЕ глушится, повтор — глушится', async () => {
    const stand = makeStand('convO22h');
    const s = await openTurn(stand, 'convO22h');
    s.push(fragAppendContent('Ответ'));
    s.push(finishChunk(9000));                  // live-эмит: historyComplete=false
    await settle(120);
    expect(stand.emits.length).toBe(1);

    // Авторитетно пустая история (SPA-чат): turnsMap НЕ перестраивается, меняется только
    // вердикт полноты → S560 ре-эмитит ту же базу (O-17: content.js узнаёт о полноте из EMIT).
    const empty = { code: 0, data: { biz_data: { chat_session: { is_empty: true, model_type: 'expert' }, chat_messages: [] } } };
    await loadHistory(stand, 'convO22h', empty);
    expect(stand.emits.length).toBe(2);

    const a = Object.assign({}, stand.emits[0]);
    const b = Object.assign({}, stand.emits[1]);
    expect([a.historyComplete, a.reachedRoot, a.baseEmpty]).toEqual([false, false, false]);
    expect([b.historyComplete, b.reachedRoot, b.baseEmpty]).toEqual([true, false, true]);
    delete a.historyComplete; delete a.reachedRoot; delete a.baseEmpty;
    delete b.historyComplete; delete b.reachedRoot; delete b.baseEmpty;
    expect(a).toEqual(b);                        // различие ровно одно: вердикт полноты

    // Тот же S560-диспатч ещё раз (база и вердикт не менялись) — вот его гард и глушит
    await loadHistory(stand, 'convO22h', empty);
    expect(stand.emits.length).toBe(2);
    expect(stand.markLines('o22-dispatch-skip').length).toBe(1);
    expect(stand.markLines('o22-dispatch-site').some((l) => l.indexOf('"site":"S560"') !== -1)).toBe(true);
    stand.dom.window.close();
  });

  test('сброс на событии ai-cm-conversation-changed: тот же снимок публикуется заново', async () => {
    const stand = makeStand('convO22f');
    const s = await openTurn(stand, 'convO22f');
    s.push(finishChunk(9000));
    await settle(120);
    s.push(closeChunk());                       // тот же снимок → пропуск
    await settle(120);
    expect(stand.emits.length).toBe(1);
    expect(stand.markLines('o22-dispatch-skip').length).toBe(1);

    // ISOLATED-сторона при SPA-переходе (resetConversationState) шлёт это событие в MAIN
    stand.window.dispatchEvent(new stand.window.CustomEvent('ai-cm-conversation-changed'));
    await settle(20);
    s.end();                                    // финал того же снимка — но гард сброшен
    await settle(120);

    expect(stand.emits.length).toBe(2);
    expect(stand.json()[0]).toBe(stand.json()[1]);
    stand.dom.window.close();
  });
});

describe('O-22 (F4): source-пины единой точки и сохранности измерений', () => {
  test('гард стоит в emitBaseSnapshot ДО dispatchEvent и после маркера o22-dispatch-fn', () => {
    const iFn = INTERCEPT_SRC.indexOf("diagMark('o22-dispatch-fn'");
    const iGuard = INTERCEPT_SRC.indexOf('var dispatchSig = buildDispatchSignature(');
    const iSkip = INTERCEPT_SRC.indexOf("diagMark('o22-dispatch-skip'");
    const iEmit = INTERCEPT_SRC.indexOf("window.dispatchEvent(new CustomEvent('ai-cm-full-history'");
    expect(iFn).toBeGreaterThan(0);
    expect(iGuard).toBeGreaterThan(iFn);
    expect(iSkip).toBeGreaterThan(iGuard);
    expect(iSkip).toBeLessThan(iEmit);
    // ровно одна точка skip на весь файл — гард покрывает все сайты через общий emit
    expect(INTERCEPT_SRC.split("diagMark('o22-dispatch-skip'").length - 1).toBe(1);
    // ранний return происходит ДО dispatchEvent, а строка skip — под гейтом diagOn()
    const skipBlock = INTERCEPT_SRC.slice(
      INTERCEPT_SRC.indexOf('if (dispatchSig !== null'),
      INTERCEPT_SRC.indexOf('lastBaseServerTokens = serverTokens;', INTERCEPT_SRC.indexOf('if (dispatchSig !== null')));
    expect(skipBlock).toContain('lastDispatchSig');
    expect(skipBlock).toContain('diagOn()');
    expect(skipBlock).toContain('return lastDispatchResult;');
  });

  test('маркеры измерения-2 и точки диспатча всех сайтов на месте', () => {
    // 1 объявление + 4 сайта вызова (S560/S692/S1172/S1467) — единая точка не расщеплена
    expect(INTERCEPT_SRC.split('emitBaseSnapshot(').length - 1).toBe(5);
    expect(INTERCEPT_SRC.split("diagMark('o22-dispatch-site'").length - 1).toBe(4);
    ['S560', 'S692', 'S1172', 'S1467'].forEach((site) => {
      expect(INTERCEPT_SRC).toContain("site: '" + site + "'");
    });
    // слушательские маркеры O-22 (o22-listener-entry / o22-call725) — на ISOLATED-стороне
    const CONTENT = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
    expect(CONTENT).toContain('o22-listener-entry');
    expect(CONTENT).toContain('o22-call725');
    expect(CONTENT).toContain('o22-histkey-dedup');
    // ISOLATED-дедуп storage не тронут (окрестность content.js:1760)
    expect(CONTENT).toContain("var histKey = baseCount + '|' + (baseText ? baseText.length : 0);");
    expect(CONTENT).toContain('verdict: (histKey !== lastHistoryWroteKey) ? \'write\' : \'dedup-skip\'');
  });

  test('сигнатура включает все поля payload события', () => {
    const fnSrc = INTERCEPT_SRC.slice(INTERCEPT_SRC.indexOf('function buildDispatchSignature'),
      INTERCEPT_SRC.indexOf('function emitBaseSnapshot'));
    // состав/тексты ходов и параметры эмита
    ['turnsMap', 't.order', 't.role', 't.modelSlug', 'diagHash6(tx)', 'diagHash6(rs)'].forEach((f) => {
      expect(fnSrc).toContain(f);
    });
    ['attachTokens', 'attachBreak.imgTokens', 'attachBreak.docTokens', 'histCompletion.historyComplete',
      'histCompletion.reachedRoot', 'histCompletion.baseEmpty'].forEach((f) => {
        expect(fnSrc).toContain(f);
      });
    // запись сигнатуры — только на реально опубликованном снимке
    expect(INTERCEPT_SRC).toContain('lastDispatchSig = dispatchSig;');
    expect(INTERCEPT_SRC).toContain("window.addEventListener('ai-cm-conversation-changed', function () { lastDispatchSig = null; });");
  });
});
