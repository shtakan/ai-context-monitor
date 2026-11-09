/**
 * v66 (дефект, живая приёмка 2026-11-09, «Логи2.txt»): бейдж Claude замирает после
 * ответа до F5.
 *
 * Механика дефекта (лог): settle target=01a1bf18 из тела POST /completion есть, а дальше
 * `post-send refresh=skipped(reason=no-url)` — и ни одного `settle attempt`. Причина:
 * SPA-смена чата обнуляет lastHistoryUrl (resetForNewConversation), пассивного GET
 * нового чата до ответа может не быть, а оба гейта («post-send» и «settle attempt»)
 * требовали именно ретейн lastHistoryUrl, хотя activeRefresh умеет строить адрес из
 * lastOrgPrefix + currentConvId. В итоге единственный снимок после ответа приходил
 * сайтовым GET (меньше базы) и, т.к. historyComplete=true, ЗАМЕНЯЛ значение бейджа
 * (7.1% → 7%) — до F5.
 *
 * Пины: D1 — сквозной дефект (снимок после ответа обязан уйти САМ, цикл обязан
 * закрыться по assistant_message_uuid из POST), D2 — пины источника на оба гейта и на
 * каноническую форму построенного URL.
 * Тесты гоняют РЕАЛЬНЫЙ core/claude-intercept.js в jsdom (fake timers + fake fetch).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'claude-intercept.js'), 'utf8');
const { interceptSource } = require('./helpers/main-intercept.js');

const CONV_ID = '4b7e2d1a-0000-4000-8000-000000000001';
const CHAT_URL = '/chat/' + CONV_ID;

// второй чат: сюда приходит SPA-переход ПОСЛЕ загрузки (bootstrap первого чата уже был)
const NEXT_CONV_ID = '4b7e2d1a-0000-4000-8000-000000000002';
const NEXT_CHAT_URL = '/chat/' + NEXT_CONV_ID;

const ORG_PATH = '/api/organizations/org-spa/chat_conversations/';
const NEXT_POST_URL = 'https://claude.ai' + ORG_PATH + NEXT_CONV_ID + '/completion';

const SEED_TAIL_UUID = 'msg-00000000-0000-4000-a000-000000000004';
const NEXT_TAIL_UUID = 'msg-00000000-0000-4000-a000-0000000000cc';
const HUMAN_UUID = 'msg-00000000-0000-4000-a000-0000000000aa';
const ANSWER_UUID = 'msg-00000000-0000-4000-a000-0000000000bb';

const GUARD = '__aicm_claude__'; // маркер активного (своего) запроса снимка

// ---- синтетические снимки истории -----------------------------------------

function msg(uuid, sender) {
  return {
    uuid: uuid,
    sender: sender,
    parent_message_uuid: null,
    created_at: '2026-11-09T11:57:00.000Z',
    updated_at: '2026-11-09T11:57:00.000Z',
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
  return { uuid: convId || CONV_ID, name: 'spa-fixture', model: 'claude-sonnet-4-6', chat_messages: msgs };
}

// ---- фейковый сервер ------------------------------------------------------

let serverCalls = [];
let snapshotFor = {};
let completionBodyRead = 0;

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
  return {
    __marker: 'completion-response',
    ok: true,
    status: 200,
    json: read,
    text: function () { completionBodyRead++; return Promise.resolve(''); },
    clone: function () { completionBodyRead++; return { json: read, text: function () { return Promise.resolve(''); } }; }
  };
}

function fakeFetch(input) {
  const url = String(typeof input === 'string' ? input : (input && input.url) || '');
  serverCalls.push(url);
  if (url.indexOf('/completion') !== -1) return Promise.resolve(completionResponse());
  if (url.indexOf('/api/organizations') !== -1 && url.indexOf('/chat_conversations/') === -1) {
    return Promise.resolve(jsonResponse([{ uuid: 'org-spa' }]));
  }
  if (url.indexOf('/chat_conversations/') !== -1) {
    const conv = url.indexOf(NEXT_CONV_ID) !== -1 ? NEXT_CONV_ID : CONV_ID;
    return Promise.resolve(jsonResponse(snapshotFor[conv]));
  }
  return Promise.resolve(jsonResponse(null));
}

/** все истории-запросы (без /completion) */
function historyUrls(convId) {
  return serverCalls.filter(function (u) {
    if (u.indexOf('/chat_conversations/') === -1) return false;
    if (u.indexOf('/completion') !== -1) return false;
    return convId ? u.indexOf(convId) !== -1 : true;
  });
}

/** только АКТИВНЫЕ запросы снимка (с guard-маркером) — их делает сам перехватчик */
function activeUrls(convId) {
  return historyUrls(convId).filter(function (u) { return u.indexOf(GUARD) !== -1; });
}
function activeCount(convId) { return activeUrls(convId).length; }

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

/** живая форма тела POST /completion: uuid хода человека и uuid будущего ответа */
function liveBody() {
  return { prompt: 'вопрос', turn_message_uuids: { human_message_uuid: HUMAN_UUID, assistant_message_uuid: ANSWER_UUID } };
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
  snapshotFor[NEXT_CONV_ID] = snap(4, 'assistant', NEXT_TAIL_UUID, NEXT_CONV_ID);
  (0, eval)(interceptSource('core/claude-intercept.js'));
  jest.advanceTimersByTime(1600); // bootstrap первого чата: lastHistoryUrl = адрес CONV_ID
  await flush();
});

describe('v66: снимок после ответа при пустом lastHistoryUrl (SPA-смена чата)', () => {
  test('D1 (дефект): после SPA-перехода и POST /completion снимок уходит сам, цикл закрывается по uuid из POST', async () => {
    // SPA-переход ПОСЛЕ загрузки: resetForNewConversation() обнуляет lastHistoryUrl
    window.history.pushState({}, '', NEXT_CHAT_URL);
    await flush();
    expect(activeCount(NEXT_CONV_ID)).toBe(0);

    // SPA-гонка (v36-сценарий): bootstrap нового чата получает тело ДРУГОГО чата → игнор,
    // lastHistoryUrl остаётся пустым — ровно состояние живой приёмки (no-url).
    snapshotFor[NEXT_CONV_ID] = snap(4, 'assistant', NEXT_TAIL_UUID, CONV_ID);

    await window.fetch(NEXT_POST_URL, { method: 'POST', body: JSON.stringify(liveBody()) });
    await flush();

    // +1500 bootstrap (чужое тело → tape-restore ignored) и +2000 post-send таймер
    jest.advanceTimersByTime(2000);
    await flush();

    expect(activeCount(NEXT_CONV_ID)).toBe(1); // до фикса здесь 0 (no-url) и тишина до F5
    const firstUrl = activeUrls(NEXT_CONV_ID)[0];
    // форма адреса — как у bootstrap/страницы, иначе снимок приходит другой формы
    expect(firstUrl).toContain('tree=True');
    expect(firstUrl).toContain('rendering_mode=messages');
    expect(firstUrl).toContain('render_all_tools=true');
    expect(firstUrl).toContain('consistency=eventual');

    // ответа ещё нет: хвост снимка — human, цель (assistant_message_uuid) не достигнута
    snapshotFor[NEXT_CONV_ID] = snap(6, 'human', HUMAN_UUID + '-q', NEXT_CONV_ID);
    jest.advanceTimersByTime(3000); // +5с — вторая попытка того же цикла
    await flush();
    expect(activeCount(NEXT_CONV_ID)).toBe(2);
    const mid = lastDetail();
    expect(mid.convId).toBe(NEXT_CONV_ID); // база ушла в бейдж ИМЕННО нового чата
    expect(mid.count).toBe(6);
    expect(mid.messages[mid.messages.length - 1].role).not.toBe('assistant');

    // ответ пришёл: хвост — assistant с assistant_message_uuid из тела POST
    snapshotFor[NEXT_CONV_ID] = snap(8, 'assistant', ANSWER_UUID, NEXT_CONV_ID);
    jest.advanceTimersByTime(5000); // +10с — третья попытка закрывает цикл
    await flush();
    expect(activeCount(NEXT_CONV_ID)).toBe(3);
    const d = lastDetail();
    expect(d.count).toBe(8);
    expect(d.messageIds[d.messageIds.length - 1]).toBe(ANSWER_UUID);

    // settled → +15с/+30с попыток больше нет
    jest.advanceTimersByTime(60000);
    await flush();
    expect(activeCount(NEXT_CONV_ID)).toBe(3);
    // v40 не ослаблен: тело ответа POST /completion по-прежнему не читается
    expect(completionBodyRead).toBe(0);
  });

  test('D2 (пин источника): оба гейта «нет URL» принимают lastOrgPrefix, URL строится канонической формы', () => {
    const gate = 'refreshBusy || (!lastHistoryUrl && !lastOrgPrefix)';
    // post-send гейт + попытка settle-цикла
    expect(INTERCEPT_SRC.split(gate).length - 1).toBe(2);
    // префикс org учится из самого completion-POST (пассивного GET может не быть)
    expect(INTERCEPT_SRC).toContain("var orgAt = String(url).indexOf('/api/organizations/')");
    // построенный снимок — той же формы, что страница/bootstrap
    expect(INTERCEPT_SRC).toContain(
      "lastOrgPrefix + currentConvId + '?tree=True&rendering_mode=messages&render_all_tools=true&consistency=eventual'"
    );
  });
});
