/** @jest-environment node */
/**
 * O-18 (фаза 2): ресинхронизация парсера фрагментов DeepSeek.
 *
 * ПЕРВОПРИЧИНА (измерено фазой 1, дамп прогона 19-12): строка-дельта пути
 * response/fragments различалась по ФОРМЕ (`/^[A-Z][A-Z_]{2,}$/`), а не по белому списку
 * имён протокола. Любой контент-чанк из заглавных латинских букв и '_' длиной >= 3
 * принимался за ОБЪЯВЛЕНИЕ ТИПА нового фрагмента. Живой прогон: ответ содержал JS-код с
 * `DEFAULT_SUBSCRIPTION`, сервер разрезал слово как «…|| DEFAULT_SU» | «BSCRIPT» | «ION» →
 * «BSCRIPT» и «ION» стали ТИПАМИ, весь дальнейший текст ушёл в мусорные фрагменты
 * (в дампе: BSCRIPT/ION/OFF/REEN/UMENT/URL/DOM/ARS), а streamFragmentText('RESPONSE')
 * читает только RESPONSE — файл экспорта оборвался на «…DEFAULT_SU» (live=5942 против
 * полного ответа на странице).
 *
 * Стенд: РЕАЛЬНЫЙ core/deepseek-intercept.js в jsdom, управляемое SSE-тело (чанки подаются
 * вручную), флаг sessionStorage.aiCmDebug='1' для дампов колец.
 *
 * Проверки:
 *  1) сигнатура живого прогона воспроизводится и ЛЕЧИТСЯ: текст хода не обрывается;
 *  2) типоподобные слова ответа (OFFSCREEN_DOCUMENT/PARSER/URL/DOM) остаются контентом;
 *  3) легальные типы протокола не тронуты; незнакомый тип из массива не заводит фрагмент,
 *     но и не теряет контент (аварийный фолбэк);
 *  4) наследство старого буфера (мусорный «тип» + ушедшие в него байты) лечится ресинком
 *     из сырого кольца с последней валидной границы;
 *  5) в буфере НЕТ типов вне белого списка (приёмка «frags вне белого списка отсутствуют»);
 *  6) source-пины механики (белый список, ресинк, единая точка записи контента).
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'deepseek-intercept.js'), 'utf8');
// Фикстура: сырьё прогона 19-12 (tools/fixtures, gitignored) либо синтезированный эквивалент
// той же сигнатуры (чистый checkout) — см. tests/helpers/o18-fixture.js.
const O18 = require('../helpers/o18-fixture.js');
const FIXTURE = O18.sseRing;

const CID = FIXTURE.source.conv.slice(0, 8);
const WHITELIST = ['THINK', 'RESPONSE', 'REQUEST', 'TIP', 'SEARCH', 'TEMPLATE_RESPONSE'];
// Правило СТАРОГО парсера (до фикса) — по нему контент-чанк становился именем типа.
const OLD_TYPE_RULE = /^[A-Z][A-Z_]{2,}$/;

function line(obj) { return 'data: ' + JSON.stringify(obj) + '\n'; }
function ev(name) { return 'event: ' + name + '\n'; }
const BLANK = '\n';

function fragDelta(v) { return line({ p: 'response/fragments', o: 'APPEND', v: v }) + BLANK; }
function fragSet(v) { return line({ p: 'response/fragments', o: 'SET', v: v }) + BLANK; }
function readyChunk(reqId, respId) {
  return ev('ready') + line({ request_message_id: reqId, response_message_id: respId, model_type: 'expert' }) + BLANK;
}
function initChunk(reqId, respId, think) {
  return ev('message') + line({
    v: { response: { accumulated_token_usage: 1000, model_type: 'expert', fragments: [{ type: 'THINK', content: think }] } }
  }) + BLANK;
}
function finishChunk() {
  return line({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 9000 }, { p: 'quasi_status', v: 'FINISHED' }] }) + BLANK;
}
function closeChunk() { return ev('close') + line({}) + BLANK; }

function makeChunkedResponse() {
  const enc = new TextEncoder();
  let ctrl = null;
  const stream = new ReadableStream({ start(c) { ctrl = c; } });
  const resp = {
    ok: true, status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    clone: () => ({ body: stream, text: () => Promise.resolve('') })
  };
  return { resp, push: (s) => ctrl.enqueue(enc.encode(s)), end: () => ctrl.close() };
}

const flush = (times) => {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 120); i++) p = p.then(() => { });
  return p;
};
async function settle(times) {
  await new Promise((r) => setImmediate(r));
  await flush(times || 200);
  await new Promise((r) => setImmediate(r));
  await flush(60);
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
  window.fetch = (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.indexOf('completion') !== -1) {
      const c = makeChunkedResponse();
      streams.push(c);
      return Promise.resolve(c.resp);
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(null), text: () => Promise.resolve(''),
      clone: () => ({ json: () => Promise.resolve(null), text: () => Promise.resolve('') })
    });
  };
  window.eval(INTERCEPT_SRC);
  const emits = [];
  window.addEventListener('ai-cm-full-history', (e) => emits.push(e.detail));
  return { window, dom, logs, streams, emits, last: () => emits[emits.length - 1] || {} };
}

// Полный прогон одного хода: ready → THINK → [RESPONSE] → дельты → терминал → close.
async function runTurn(stand, opts) {
  const o = opts || {};
  await stand.window.fetch('https://chat.deepseek.com/api/v1/chat/completion?x=1', {
    method: 'POST',
    body: JSON.stringify({ prompt: o.prompt || 'Вопрос', chat_session_id: o.convId || CID, thinking_enabled: true })
  });
  const st = stand.streams[stand.streams.length - 1];
  st.push(readyChunk(o.reqId || 'u1', o.respId || 'a1'));
  if (o.seedAfterReady) {
    // Сид ставится ПОСЛЕ ready: старт потока (beginSseStream) обнуляет буфер целиком.
    await settle(20);
    o.seedAfterReady(stand);
  }
  if (!o.skipInit) {
    st.push(initChunk(o.reqId || 'u1', o.respId || 'a1', o.think || ''));
    if (o.think) st.push(fragDelta(['RESPONSE']));
  }
  for (const d of (o.deltas || [])) st.push(fragDelta(d));
  for (const c of (o.chunks || [])) st.push(c);
  st.push(finishChunk());
  st.push(closeChunk());
  await settle();
  st.end();
  await settle();
  return st;
}

// Дампы колец печатаются на экспортный probe — берём из них состояние буфера ПОСЛЕ чанка.
// `before` первого чанка может нести наследство старого буфера (его и лечит ресинк),
// поэтому инвариант «типов вне белого списка нет» проверяется по `after` каждого чанка
// пути fragments и по строке [O18][WHITELIST] (итоговый буфер).
async function dumpFragTypes(stand) {
  stand.window.dispatchEvent(new stand.window.CustomEvent('ai-cm-turns-snap-request'));
  await settle(20);
  const types = new Set();
  const ringsLine = stand.logs.filter((l) => l.indexOf('[O18][rings] {') !== -1).pop();
  if (ringsLine) {
    const payload = JSON.parse(ringsLine.slice(ringsLine.indexOf('{')));
    for (const e of (payload.sse || [])) {
      if (String(e.path || '').indexOf('fragments') === -1) continue;
      for (const f of (e.after || [])) types.add(f.type);
    }
  }
  return types;
}

afterEach(() => { });

describe('O-18: десинхрон парсера фрагментов — сигнатура живого прогона 19-12', () => {
  test('«…DEFAULT_SU» | «BSCRIPT» | «ION»: текст хода не обрывается, типы только из белого списка', async () => {
    const stand = makeStand(CID);
    // Живой прогон: ответ — JS-код с DEFAULT_SUBSCRIPTION, сервер разрезал слово на чанки.
    // Префикс (1511 дельт из файла экспорта) + триггер + сырое кольцо дампа (400 дельт).
    const deltas = FIXTURE.prefixDeltas.concat(FIXTURE.triggerChunks, FIXTURE.ringDeltas);
    await runTurn(stand, { deltas, think: FIXTURE.think });

    const asst = stand.last().messageTexts[1] || '';
    expect(asst).toBe('[REASONING]\n' + FIXTURE.think + '\n\n[ANSWER]\n' + FIXTURE.expectedAnswer);
    // До фикса здесь было: ...DEFAULT_SU (обрыв) — проверяем саму точку шва и хвост кольца.
    expect(asst).toContain('DEFAULT_SUBSCRIPTION');
    expect(asst.endsWith(FIXTURE.ringText)).toBe(true);

    // Ресинк состоялся и именно на мусорных токенах контента.
    const logs = stand.logs.join('\n');
    expect(logs).toContain('десинхрон парсера фрагментов (type-out-of-whitelist:BSCRIPT)');
    expect(logs).toContain('десинхрон парсера фрагментов (type-out-of-whitelist:ION)');
    // Строки дампа не знают типов вне белого списка ни на одном чанке.
    const types = await dumpFragTypes(stand);
    expect(stand.logs.join('\n')).toContain('[O18][WHITELIST] frags вне белого списка: нет');
    expect([...types].filter((t) => t && WHITELIST.indexOf(t) === -1)).toEqual([]);
    expect(types.has('RESPONSE')).toBe(true);
    stand.dom.window.close();
  });

  test('типоподобные СЛОВА ответа (OFFSCREEN_DOCUMENT/PARSER/URL/DOM) остаются контентом', async () => {
    const stand = makeStand(CID);
    const words = FIXTURE.reconstructedWords;
    const flattened = Object.keys(words).reduce((acc, k) => acc.concat(words[k]), []);
    // Все 8 «типов» из дампа матчатся правилом СТАРОГО парсера — это и есть механизм дефекта.
    FIXTURE.bogusTypesFromDump.forEach((t) => expect(OLD_TYPE_RULE.test(t)).toBe(true));
    const expected = Object.keys(words).join('');

    await runTurn(stand, { deltas: flattened.concat(['\n']), think: 'кратко' });
    const asst = stand.last().messageTexts[1] || '';
    expect(asst).toContain(expected);
    const types = await dumpFragTypes(stand);
    expect([...types].filter((t) => t && WHITELIST.indexOf(t) === -1)).toEqual([]);
    expect(stand.logs.join('\n')).toContain('[O18][WHITELIST] frags вне белого списка: нет');
    stand.dom.window.close();
  });

  test('легальные типы протокола не тронуты: строковые объявления и массивы работают как раньше', async () => {
    const stand = makeStand(CID);
    await runTurn(stand, {
      think: 'думаю',
      chunks: [
        fragDelta(['TIP']),                                    // строковое объявление типа из белого списка
        fragDelta([{ type: 'TIP', content: 'подсказка ' }]),    // массив: тип + первая порция
        line({ p: 'response/fragments/-1/content', o: 'APPEND', v: 'хвост' }) + BLANK,
        fragSet([{ type: 'THINK', content: 'думаю' }, { type: 'RESPONSE', content: 'Ответ.' }])
      ]
    });
    const d = stand.last();
    expect(d.messageTexts[1]).toBe('[REASONING]\nдумаю\n\n[ANSWER]\nОтвет.');
    expect(d.reasoningTexts[1]).toBe('думаю');
    stand.dom.window.close();
  });

  test('незнакомый тип ИЗ МАССИВА фрагментом не становится, но контент не теряется (фолбэк)', async () => {
    const stand = makeStand(CID);
    await runTurn(stand, {
      think: '',
      chunks: [fragSet([{ type: 'SEARCH_RESULTS', content: 'незнакомый протокол: текст ответа' }])]
    });
    const d = stand.last();
    // RESPONSE-фрагментов в потоке нет вовсе → аварийный фолбэк отдаёт текст как раньше.
    expect(d.messageTexts[1]).toBe('незнакомый протокол: текст ответа');
    const types = await dumpFragTypes(stand);
    expect([...types].filter((t) => t && WHITELIST.indexOf(t) === -1)).toEqual([]);
    expect(stand.logs.join('\n')).toContain('имя фрагмента вне белого списка ("SEARCH_RESULTS")');
    stand.dom.window.close();
  });

  test('наследство старого буфера: мусорный «тип» и его байты лечатся ресинком из сырого кольца', async () => {
    const stand = makeStand(CID);
    // Буфер старой версии: RESPONSE + мусорный «DOM» последним (в него уходил контент).
    const tail = ['СЕРЕДИНА ', 'И ХВОСТ ОТВЕТА.'];
    await runTurn(stand, {
      skipInit: true,
      deltas: tail,
      seedAfterReady: (s) => {
        const seeded = s.window.__aiCmDebug.seedDeepSeekFragmentsO18([
          { type: 'RESPONSE', content: 'НАЧАЛО ' }, { type: 'DOM', content: '' }
        ]);
        expect(seeded.types).toBe('RESPONSE,DOM');
      }
    });
    const asst = stand.last().messageTexts[1] || '';
    // Контент вернулся в RESPONSE: ни одного байта не потеряно, мусорного типа нет.
    expect(asst).toBe('НАЧАЛО ' + tail.join(''));
    expect(stand.logs.join('\n')).toContain('десинхрон парсера фрагментов (content-into-invalid-fragment)');
    const types = await dumpFragTypes(stand);
    expect([...types].filter((t) => t && WHITELIST.indexOf(t) === -1)).toEqual([]);
    stand.dom.window.close();
  });
  test('аварийный бакет не течёт между ходами: новый поток не наследует контент незнакомого типа', async () => {
    const stand = makeStand(CID);
    // Ход 1: в потоке только незнакомый тип → аварийный фолбэк отдаёт его текст.
    await runTurn(stand, { skipInit: true, chunks: [fragSet([{ type: 'SEARCH_RESULTS', content: 'текст хода 1' }])] });
    expect(stand.last().messageTexts[1]).toBe('текст хода 1');
    // Ход 2 (новый поток того же чата): снова нет RESPONSE → фолбэк обязан отдать ТОЛЬКО
    // контент текущего потока (байты хода 1 не наследуются).
    await runTurn(stand, { skipInit: true, respId: 'a2', reqId: 'u2', chunks: [fragSet([{ type: 'DEEP_RESEARCH', content: 'текст хода 2' }])] });
    const d = stand.last();
    expect(d.messageTexts[3]).toBe('текст хода 2');
    expect(d.messageTexts[3]).not.toContain('текст хода 1');
    stand.dom.window.close();
  });
});

describe('O-18: source-пины механики (белый список + ресинк)', () => {
  test('типы только из белого списка; мусорный токен не заводит фрагмент, а лечится ресинком', () => {
    expect(INTERCEPT_SRC).toContain('var SSE_FRAGMENT_TYPES = {');
    expect(INTERCEPT_SRC).toContain('function streamKnownType(t) {');
    expect(INTERCEPT_SRC).toContain('function streamTypeShape(v) {');
    expect(INTERCEPT_SRC).toContain('function streamResync(reason) {');
    expect(INTERCEPT_SRC).toContain('function streamContentInto(op, val) {');
    expect(INTERCEPT_SRC).toContain('function streamNoteMisroute(op, val) {');
    // прежняя форма-only классификация удалена: тип ставится только при совпадении с белым списком
    expect(INTERCEPT_SRC).not.toContain("if (/^[A-Z][A-Z_]{2,}$/.test(val)) { streamPushFragment(val, ''); return; }");
    expect(INTERCEPT_SRC).toContain("streamResync('type-out-of-whitelist:' + val.slice(0, 24));");
    // байты контента пишутся только в валидный фрагмент (единая точка)
    expect(INTERCEPT_SRC).toContain("streamResync('content-into-invalid-fragment');");
    expect(INTERCEPT_SRC).toContain('if (!streamKnownType(itemType)) { streamUnknownPush(itemType,');
    // K4 («длиннее побеждает») и K7 (финал/flush) не тронуты
    expect(INTERCEPT_SRC).toContain('var nextAnswer = (answerText && answerText.length >= exAnswer.length) ? answerText : exAnswer;');
    expect(INTERCEPT_SRC).toContain('function finishSseStream() {');
  });
});
