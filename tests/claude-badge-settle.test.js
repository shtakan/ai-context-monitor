/**
 * v61 — settle-цикл эмита метрики Claude после POST /completion.
 *
 * Дефект (живой прогон 2026-10-11, chat claude.ai-1791724274631.log):
 *   POST /completion 18:10:11.778 → ЕДИНСТВЕННЫЙ снимок на +2с (msgs=126, последний ход — user,
 *   ответа ещё нет) → badge-update 17.1% → пауза 44с → сайтовый GET 18:10:58.893 → msgs=128 →
 *   badge-update 17.2%. UUID будущего ответа приходит в ТЕЛЕ ЗАПРОСА:
 *   body-struct.turn_message_uuids kind=object subkeys=human_message_uuid|assistant_message_uuid
 *   (18:10:11.777).
 * Фикс: одноразовый +2s-снимок заменён settle-циклом по расписанию +2,+5,+10,+15,+30с, который
 *   останавливается, когда последний ход снимка — assistant с этим uuid (или, при отсутствии
 *   uuid в теле, просто assistant). GET-инициатива страницы больше не нужна.
 *
 * Пины: P1/P2/P3 — дефект, R1/R2/R3 — регрессии (v40 «ответ не читаем (не GET)» не ослаблен).
 * Тесты гоняют РЕАЛЬНЫЙ core/claude-intercept.js в jsdom (jsdom + fake timers + fake fetch).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const INTERCEPT = path.join(ROOT, 'core', 'claude-intercept.js');
const INTERCEPT_SRC = fs.readFileSync(INTERCEPT, 'utf8');

const CONV_ID = '3f2a1c5e-0000-4000-8000-000000000001';
const CHAT_URL = '/chat/' + CONV_ID;

// второй чат — для R3 (смена convId посреди settle-цикла)
const OTHER_CONV_ID = '3f2a1c5e-0000-4000-8000-000000000002';
const OTHER_CHAT_URL = '/chat/' + OTHER_CONV_ID;
const OTHER_TAIL_UUID = 'msg-00000000-0000-4000-a000-0000000000cc';
const SEED_TAIL_UUID = 'msg-00000000-0000-4000-a000-000000000004';

const ORG_PATH = '/api/organizations/org-settle/chat_conversations/';
const POST_URL = 'https://claude.ai' + ORG_PATH + CONV_ID + '/completion';

// живая форма тела POST /completion: uuid хода человека и uuid будущего ответа
const HUMAN_UUID = 'msg-00000000-0000-4000-a000-0000000000aa';
const ANSWER_UUID = 'msg-00000000-0000-4000-a000-0000000000bb';

// ---- синтетические снимки истории -----------------------------------------

function msg(uuid, sender) {
  return {
    uuid: uuid,
    sender: sender,
    parent_message_uuid: null,
    created_at: '2026-10-11T18:10:00.000Z',
    updated_at: '2026-10-11T18:10:00.000Z',
    content: [{ type: 'text', text: 'Синтетический ход ' + sender + ' ' + uuid }]
  };
}

/** снимок из n сообщений; хвост — по параметрам, предпоследний — human с HUMAN_UUID */
function snap(n, tailSender, tailUuid, convId) {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    const isTail = i === n - 1;
    let uuid;
    if (isTail) uuid = tailUuid || ('msg-tail-' + i + '-0000-4000-a000-000000000000');
    else if (i === n - 2) uuid = HUMAN_UUID;
    else uuid = 'msg-' + String(i).padStart(3, '0') + '-0000-4000-a000-000000000000';
    msgs.push(msg(uuid, isTail ? tailSender : (i % 2 === 0 ? 'human' : 'assistant')));
  }
  return { uuid: convId || CONV_ID, name: 'settle-fixture', model: 'claude-sonnet-4-6', chat_messages: msgs };
}

// ---- фейковый сервер ------------------------------------------------------

let serverCalls = [];
let snapshotFor = {};
let completionBodyRead = 0;
let lastCompletionResponse = null;

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(body); },
    clone: function () { return { json: function () { return Promise.resolve(body); }, text: function () { return Promise.resolve(''); } }; }
  };
}

/** ответ POST /completion: любое чтение тела ответа учитывается в completionBodyRead (v40-проба) */
function completionResponse() {
  const read = function () { completionBodyRead++; return Promise.resolve({}); };
  const resp = {
    __marker: 'completion-response',
    ok: true,
    status: 200,
    json: read,
    text: function () { completionBodyRead++; return Promise.resolve(''); },
    clone: function () { completionBodyRead++; return { json: read, text: function () { return Promise.resolve(''); } }; }
  };
  lastCompletionResponse = resp;
  return resp;
}

function fakeFetch(input) {
  const url = String(typeof input === 'string' ? input : (input && input.url) || '');
  serverCalls.push(url);
  if (url.indexOf('/completion') !== -1) return Promise.resolve(completionResponse());
  if (url.indexOf('/api/organizations') !== -1 && url.indexOf('/chat_conversations/') === -1) {
    return Promise.resolve(jsonResponse([{ uuid: 'org-settle' }]));
  }
  if (url.indexOf('/chat_conversations/') !== -1) {
    const conv = url.indexOf(OTHER_CONV_ID) !== -1 ? OTHER_CONV_ID : CONV_ID;
    return Promise.resolve(jsonResponse(snapshotFor[conv]));
  }
  return Promise.resolve(jsonResponse(null));
}

function historyUrls(convId) {
  return serverCalls.filter(function (u) {
    if (u.indexOf('/chat_conversations/') === -1) return false;
    if (u.indexOf('/completion') !== -1) return false;
    return convId ? u.indexOf(convId) !== -1 : true;
  });
}
function historyCount(convId) { return historyUrls(convId).length; }

// ---- харнесс --------------------------------------------------------------

const emitSpy = jest.fn();

function flush(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 12); i++) p = p.then(function () {});
  return p;
}

function lastDetail() {
  const calls = emitSpy.mock.calls;
  return calls.length ? calls[calls.length - 1][0].detail : null;
}

function postCompletion(bodyObj) {
  return window.fetch(POST_URL, { method: 'POST', body: JSON.stringify(bodyObj) });
}

function liveBody() {
  return { prompt: 'вопрос', turn_message_uuids: { human_message_uuid: HUMAN_UUID, assistant_message_uuid: ANSWER_UUID } };
}

// ---- v65: СЖАТАЯ ветка тела POST /completion (gzip/deflate) ----------------
// jsdom не реализует fetch-примитивы (DecompressionStream/Response/TextDecoder),
// поэтому РЕАЛЬНЫЙ decompressProbe в тестах не доходит до декодирования. Даём
// минимальные фейки поверх node:zlib — проверяется настоящий код интерцептора.
function installDecompressionGlobals() {
  function decode(raw, format) {
    if (format === 'gzip') return zlib.gunzipSync(raw);
    if (format === 'deflate') return zlib.inflateSync(raw);
    if (format === 'deflate-raw') return zlib.inflateRawSync(raw);
    throw new Error('unsupported format ' + format);
  }
  function FakeDecompressionStream(format) { this.format = format; }
  function FakeResponse(input) {
    if (input && input.__aicmPiped) { // new Response(stream).text()
      this.__piped = input.__aicmPiped;
      this.body = null;
      return;
    }
    const bytes = Buffer.from(input); // new Response(u8).body.pipeThrough(ds)
    this.body = {
      pipeThrough: function (ds) { return { __aicmPiped: { bytes: bytes, format: ds.format } }; }
    };
  }
  FakeResponse.prototype.text = function () {
    if (this.__piped) {
      return Promise.resolve(decode(this.__piped.bytes, this.__piped.format).toString('utf8'));
    }
    return Promise.resolve('');
  };
  global.DecompressionStream = FakeDecompressionStream;
  global.Response = FakeResponse;
  window.DecompressionStream = FakeDecompressionStream;
  window.Response = FakeResponse;
}

/** сжатое тело POST: живой JSON → gzip|deflate (≥64 байт — порог decompressProbe) */
function compressedBody(obj, format) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  const packed = format === 'deflate' ? zlib.deflateSync(raw) : zlib.gzipSync(raw);
  return new Uint8Array(packed);
}

function postCompletionCompressed(obj, format) {
  return window.fetch(POST_URL, { method: 'POST', body: compressedBody(obj, format) });
}

/** прокрутить 0мс-переходы decompressProbe между пробуемыми форматами (gzip→deflate) */
async function decompTick() {
  for (let i = 0; i < 6; i++) {
    jest.advanceTimersByTime(0);
    await flush();
  }
}

beforeAll(async () => {
  jest.useFakeTimers();
  window.history.pushState({}, '', CHAT_URL);
  window.fetch = fakeFetch;
  global.fetch = fakeFetch;
  global.debugLog = jest.fn();
  global.__aiCmSetDebugLogs = jest.fn();
  global.__aiCmDebugLogs = false;
  window.addEventListener('ai-cm-full-history', emitSpy);
  snapshotFor[CONV_ID] = snap(4, 'assistant', SEED_TAIL_UUID);
  snapshotFor[OTHER_CONV_ID] = snap(4, 'assistant', OTHER_TAIL_UUID, OTHER_CONV_ID);
  installDecompressionGlobals(); // v65: сжатая ветка тела POST достижима в jsdom
  require(INTERCEPT);
  jest.advanceTimersByTime(1600); // bootstrap-снимок (1500мс)
  await flush();
});

describe('v61: settle-цикл эмита после POST /completion', () => {
  test('P1 (дефект): снимок msgs=126 с последним ходом user не закрывает цикл — попытки идут до msgs=128 с ответом assistant', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q');

    await postCompletion(liveBody());
    await flush();

    jest.advanceTimersByTime(2000); // +2с — post-send таймер = первая попытка
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 1);
    expect(lastDetail().count).toBe(126);
    expect(lastDetail().messages[lastDetail().messages.length - 1].role).not.toBe('assistant');

    jest.advanceTimersByTime(3000); // +5с — вторая попытка (цикл НЕ закрылся на 126)
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);
    expect(lastDetail().count).toBe(126);

    snapshotFor[CONV_ID] = snap(128, 'assistant', ANSWER_UUID); // ответ появился
    jest.advanceTimersByTime(5000); // +10с — третья попытка
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 3);
    const d = lastDetail();
    expect(d.count).toBe(128);
    expect(d.messageIds[d.messageIds.length - 1]).toBe(ANSWER_UUID);
    // последний ход assistant → settle → цикл остановлен, попыток +15/+30 больше нет
    jest.advanceTimersByTime(60000);
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 3);
  });

  test('P2 (дефект, живая форма): settle по assistant_message_uuid из тела POST /completion', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q');

    await postCompletion(liveBody());
    await flush();
    jest.advanceTimersByTime(2000); // +2с — ответа ещё нет
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 1);
    expect(lastDetail().count).toBe(126);

    // ход assistant, но это НЕ uuid из тела POST → settle не наступает
    const WRONG_UUID = 'msg-00000000-0000-4000-a000-0000000000ee';
    snapshotFor[CONV_ID] = snap(127, 'assistant', WRONG_UUID);
    jest.advanceTimersByTime(3000); // +5с
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);
    expect(lastDetail().count).toBe(127);

    // тот самый assistant_message_uuid из тела POST /completion → settle
    snapshotFor[CONV_ID] = snap(128, 'assistant', ANSWER_UUID);
    jest.advanceTimersByTime(5000); // +10с
    await flush();
    const d = lastDetail();
    expect(d.count).toBe(128);
    expect(d.messageIds[d.messageIds.length - 1]).toBe(ANSWER_UUID); // uuid цели из тела POST
    expect(d.messageIds[d.messageIds.length - 2]).toBe(HUMAN_UUID); // human_message_uuid из того же тела
    // settle → слоты +15/+30 не срабатывают
    jest.advanceTimersByTime(60000);
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 3);
  });

  test('P3 (дефект): ответ становится виден только на +15с — цикл добирает сам, без GET-инициативы страницы', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q');
    await postCompletion(liveBody());
    await flush();

    jest.advanceTimersByTime(2000); // +2с
    await flush();
    jest.advanceTimersByTime(3000); // +5с
    await flush();
    jest.advanceTimersByTime(5000); // +10с
    await flush();
    expect(lastDetail().count).toBe(126);

    // ответ готов на сервере, но снимок «запаздывает» — доберём на +15с
    snapshotFor[CONV_ID] = snap(128, 'assistant', ANSWER_UUID);
    jest.advanceTimersByTime(5000); // +15с — четвёртая попытка
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 4); // все 4 GET — свои, страница их не инициировала
    expect(lastDetail().count).toBe(128);
    expect(lastDetail().messageIds[lastDetail().messageIds.length - 1]).toBe(ANSWER_UUID);

    jest.advanceTimersByTime(60000);
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 4);
  });

  test('P3b (дефект): ответа нет вовсе — ровно 5 попыток по расписанию +2/+5/+10/+15/+30 и стоп, без зацикливания', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q'); // ответ так и не появится

    await postCompletion(liveBody());
    await flush();
    jest.advanceTimersByTime(2000); // +2с
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 1);
    jest.advanceTimersByTime(3000); // +5с
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);
    jest.advanceTimersByTime(5000); // +10с
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 3);
    jest.advanceTimersByTime(5000); // +15с
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 4);
    jest.advanceTimersByTime(15000); // +30с — пятая и последняя попытка
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 5);
    expect(lastDetail().count).toBe(126);

    jest.advanceTimersByTime(300000); // дальше — тишина: цикл не зацикливается
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 5);
  });

  test('R1 (регрессия): нет assistant_message_uuid в теле → фолбэк на lastMsg.role === assistant', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q');

    await postCompletion({ prompt: 'тело без turn_message_uuids' }); // uuid цели не известен
    await flush();
    jest.advanceTimersByTime(2000); // +2с — ход user, не settle
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 1);
    expect(lastDetail().count).toBe(126);

    snapshotFor[CONV_ID] = snap(128, 'assistant', 'msg-00000000-0000-4000-a000-0000000000dd');
    jest.advanceTimersByTime(3000); // +5с — ход assistant, settle по роли
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);
    expect(lastDetail().count).toBe(128);
    expect(lastDetail().messages[lastDetail().messages.length - 1].role).toBe('assistant');

    jest.advanceTimersByTime(60000);
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);

    // source-пин фолбэка
    expect(INTERCEPT_SRC).toContain('var settled = isAssistant && (!settle_target_uuid || lastId === settle_target_uuid);');
    expect(INTERCEPT_SRC).toContain("settle_target_uuid = (tm && typeof tm.assistant_message_uuid === 'string') ? tm.assistant_message_uuid : '';");
  });

  test('R2 (регрессия): v40 — одноразовый +2s-вызов ушёл, тело POST-ОТВЕТА по-прежнему не читается', async () => {
    // (а) source-пины v40 и расписания
    const skipLines = INTERCEPT_SRC.match(/ответ не читаем \(не GET\)/g) || [];
    expect(skipLines.length).toBe(1);
    // v40-блок целиком (единственное место, где решается «ответ не читаем»)
    const v40 = "var canReadStream = (_mth === 'GET' || _mth === 'HEAD');\n"
      + '    if (!canReadStream && (isHistory || isCompletion)) {\n'
      + "      traceLog('intercept-skip ' + _mth + ' ' + String(m.full || '').slice(0, 80) + ' — ответ не читаем (не GET)');\n"
      + '      isHistory = false;\n'
      + '      isCompletion = false;\n'
      + '    }';
    expect(INTERCEPT_SRC).toContain(v40);
    // тело ответа читает только v40-гейт: новая цель settle берётся из request-body
    const cap = INTERCEPT_SRC.slice(
      INTERCEPT_SRC.indexOf('function captureSettleTarget('),
      INTERCEPT_SRC.indexOf('function settleStop(')
    );
    expect(cap).toContain('JSON.parse(rawText)');
    expect(cap).toContain('turn_message_uuids');
    expect(cap).not.toContain('clone(');
    expect(cap).not.toContain('.json()');
    expect(cap).not.toContain('Response');
    // (б) source-пины замены точки +2с на settle-цикл
    expect(INTERCEPT_SRC).not.toContain("activeRefresh('после отправки')");
    expect(INTERCEPT_SRC).toContain('settleSchedule(urlConvAtSched);');
    expect(INTERCEPT_SRC).toContain('var SETTLE_DELAYS = [2000, 5000, 10000, 15000, 30000];');

    // (в) живая проба: интерцептор POST-ответ не потребляет и возвращает его странице как есть
    const base = completionBodyRead;
    snapshotFor[CONV_ID] = snap(128, 'assistant', ANSWER_UUID);
    const resp = await postCompletion(liveBody());
    await flush();
    expect(completionBodyRead).toBe(base); // ни json(), ни text(), ни clone()
    expect(resp.__marker).toBe('completion-response');
    expect(resp.ok).toBe(true);
    expect(resp).toBe(lastCompletionResponse);

    jest.advanceTimersByTime(2000); // закрыть цикл, чтобы не мешал R3
    await flush();
  });

  test('R3 (регрессия): смена convId посреди settle-цикла — таймер отменён, чужой снимок не эмитится', async () => {
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q');
    const baseOld = historyCount(CONV_ID);

    await postCompletion(liveBody());
    await flush();
    jest.advanceTimersByTime(2000); // +2с — цикл активен, следующая попытка на +5с
    await flush();
    expect(historyCount(CONV_ID)).toBe(baseOld + 1);

    const emittedBefore = emitSpy.mock.calls.length; // всё, что было до смены треда, — законно
    window.history.pushState({}, '', OTHER_CHAT_URL); // смена треда → settleReset('смена чата')
    jest.advanceTimersByTime(3000); // была бы попытка +5с по СТАРОМУ чату
    await flush();
    expect(historyCount(CONV_ID)).toBe(baseOld + 1); // таймер отменён, старого GET нет

    jest.advanceTimersByTime(2000); // bootstrap нового чата (1500мс)
    await flush();
    jest.advanceTimersByTime(60000);
    await flush();
    expect(historyCount(CONV_ID)).toBe(baseOld + 1);
    expect(lastDetail().convId).toBe(OTHER_CONV_ID);
    for (let i = emittedBefore; i < emitSpy.mock.calls.length; i++) {
      expect(emitSpy.mock.calls[i][0].detail.convId).not.toBe(CONV_ID); // чужой снимок не эмитится
    }

    // source-пин обёртки guards сброса (сами guards не изменены)
    expect(INTERCEPT_SRC).toContain("settleReset('смена чата'); resetForNewConversation();");
    expect(INTERCEPT_SRC).toContain('var newId = getConvId();');
  });
});

// ===========================================================================
// v65 — known gap аппендикса v61 §4 п.2: цель settle захватывалась ТОЛЬКО на
// строковой ветке тела POST /completion. При gzip/deflate-теле UUID не
// захватывался и settle-цикл уходил в фолбэк «последний ход assistant»
// (дефект закрывался, UUID-сверка терялась). Фикс: тот же захват на сжатой
// ветке (decompressProbe). Расписание/фолбэк/точка сверки НЕ тронуты.
// ===========================================================================
describe('v65: settle-цель из СЖАТОГО тела POST /completion (gzip/deflate)', () => {
  beforeEach(async () => {
    window.history.pushState({}, '', CHAT_URL); // предыдущий тест мог увести в другой тред
    jest.advanceTimersByTime(2000); // bootstrap чата
    await flush();
    snapshotFor[CONV_ID] = snap(4, 'assistant', SEED_TAIL_UUID);
  });

  test('P-gzip-1 (дефект): gzip-тело POST → settle по assistant_message_uuid из сжатого JSON', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q');

    await postCompletionCompressed(liveBody(), 'gzip');
    await decompTick(); // сжатая ветка декодирована ДО +2с
    jest.advanceTimersByTime(2000); // +2с — первая попытка, ответа ещё нет
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 1);
    expect(lastDetail().count).toBe(126);

    // ход assistant, но НЕ uuid из сжатого тела → settle не наступает (uuid захвачен)
    snapshotFor[CONV_ID] = snap(127, 'assistant', 'msg-00000000-0000-4000-a000-0000000000ef');
    jest.advanceTimersByTime(3000); // +5с
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);
    expect(lastDetail().count).toBe(127);

    snapshotFor[CONV_ID] = snap(128, 'assistant', ANSWER_UUID); // тот самый uuid ответа
    jest.advanceTimersByTime(5000); // +10с
    await flush();
    const d = lastDetail();
    expect(d.count).toBe(128);
    expect(d.messageIds[d.messageIds.length - 1]).toBe(ANSWER_UUID);
    expect(d.messageIds[d.messageIds.length - 2]).toBe(HUMAN_UUID);

    jest.advanceTimersByTime(60000); // settle → слоты +15/+30 не срабатывают
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 3);
  });

  test('P-gzip-2 (дефект): сжатое тело — то же расписание +2/+5/+10/+15/+30, ровно ≤5 попыток', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q'); // ответ так и не появится

    await postCompletionCompressed(liveBody(), 'gzip');
    await decompTick();
    const steps = [2000, 3000, 5000, 5000, 15000]; // абс. слоты +2/+5/+10/+15/+30
    for (let i = 0; i < steps.length; i++) {
      jest.advanceTimersByTime(steps[i]);
      await flush();
      expect(historyCount(CONV_ID)).toBe(base + i + 1);
    }
    expect(lastDetail().count).toBe(126);

    jest.advanceTimersByTime(300000); // дальше — тишина: цикл не зацикливается
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 5);
  });

  test('P-gzip-3 (дефект): сжатое тело без turn_message_uuids → фолбэк «последний ход assistant» сохранён', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q');

    await postCompletionCompressed({ prompt: 'сжатое тело без turn_message_uuids' }, 'gzip');
    await decompTick();
    jest.advanceTimersByTime(2000); // +2с — ход user, не settle
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 1);
    expect(lastDetail().count).toBe(126);

    snapshotFor[CONV_ID] = snap(128, 'assistant', 'msg-00000000-0000-4000-a000-0000000000dd');
    jest.advanceTimersByTime(3000); // +5с — ход assistant → settle по роли
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);
    expect(lastDetail().count).toBe(128);
    expect(lastDetail().messages[lastDetail().messages.length - 1].role).toBe('assistant');

    jest.advanceTimersByTime(60000);
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);
  });

  test('P-deflate-1 (дефект): deflate-тело POST → симметричный захват цели settle', async () => {
    const base = historyCount(CONV_ID);
    snapshotFor[CONV_ID] = snap(126, 'human', HUMAN_UUID + '-q');

    await postCompletionCompressed(liveBody(), 'deflate');
    await decompTick(); // gzip-проба падает → deflate (0мс-переходы)
    jest.advanceTimersByTime(2000); // +2с
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 1);
    expect(lastDetail().count).toBe(126);

    snapshotFor[CONV_ID] = snap(127, 'assistant', 'msg-00000000-0000-4000-a000-0000000000f1');
    jest.advanceTimersByTime(3000); // +5с — чужой assistant-uuid, не settle
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 2);

    snapshotFor[CONV_ID] = snap(128, 'assistant', ANSWER_UUID);
    jest.advanceTimersByTime(5000); // +10с — uuid из deflate-тела → settle
    await flush();
    expect(lastDetail().count).toBe(128);
    expect(lastDetail().messageIds[lastDetail().messageIds.length - 1]).toBe(ANSWER_UUID);

    jest.advanceTimersByTime(60000);
    await flush();
    expect(historyCount(CONV_ID)).toBe(base + 3);
  });

  test('R-1 (регрессия): строковая ветка — байтово прежняя, второго вызова в ней нет', () => {
    const stringBranch = "      } else if (scanText != null) {\n"
      + '        jsonOk = processPostBody(url, scanText);\n'
      + "        if (kind === 'string' && jsonOk === 1) { traceBodyStruct(url, scanText); captureSettleTarget(url, scanText); } // v41/v61: структура чат-POST + цель settle\n"
      + '      }';
    expect(INTERCEPT_SRC).toContain(stringBranch); // E.4-пины: строка не изменена
    // в самом capturePostBody второй захват не появился (сжатый — в decompressProbe)
    const captureBody = INTERCEPT_SRC.slice(
      INTERCEPT_SRC.indexOf('function capturePostBody('),
      INTERCEPT_SRC.indexOf('function asUint8View(')
    );
    expect((captureBody.match(/captureSettleTarget\(/g) || []).length).toBe(1);
    expect(captureBody).not.toContain('captureSettleTarget(url, text);');
  });

  test('S-1 (source-пин): captureSettleTarget вызывается из сжатой И строковой ветвей', () => {
    const all = INTERCEPT_SRC.match(/captureSettleTarget/g) || [];
    expect(all.length).toBe(3); // объявление + 2 вызова (строковый + сжатый)
    expect(INTERCEPT_SRC).toContain('captureSettleTarget(url, scanText);'); // строковая
    expect(INTERCEPT_SRC).toContain('captureSettleTarget(url, text);'); // сжатая
    const probe = INTERCEPT_SRC.slice(
      INTERCEPT_SRC.indexOf('function decompressProbe('),
      INTERCEPT_SRC.indexOf('function processPostBody(')
    );
    expect(probe).toContain('traceDecompStruct(text);');
    expect(probe).toContain('captureSettleTarget(url, text);'); // внутри сжатой ветки
    // вызов — живая строка кода, а не закомментированный текст
    const liveLine = probe.split('\n').filter(function (l) { return l.indexOf('captureSettleTarget(url, text);') !== -1; });
    expect(liveLine.length).toBe(1);
    expect(liveLine[0].trim().indexOf('//')).not.toBe(0);
    // неизменность расписания, фолбэка и точки сверки (:1314)
    expect(INTERCEPT_SRC).toContain('var SETTLE_DELAYS = [2000, 5000, 10000, 15000, 30000];');
    expect(INTERCEPT_SRC).toContain('var settled = isAssistant && (!settle_target_uuid || lastId === settle_target_uuid);');
  });
});
