/**
 * 2.2 / сетевой снимок нового чата.
 *
 * Полевой факт (DSH recon, 2026-11-23): новый чат Gemini не отправляет hNvQHb,
 * но history-снимок можно вызвать сразу после ответа, если взять шаблон
 * batchexecute у любого send/feed-запроса, а at/bl/f.sid — из WIZ_global_data.
 * Здесь фиксируется контракт:
 *   1) rememberSiteMeta принимает ЛЮБОЙ batchexecute, не только hNvQHb;
 *   2) buildActiveUrl превращает его в hNvQHb и подставляет текущий source-path;
 *   3) ensureActiveMeta добирает at/bl/f.sid из window.WIZ_global_data;
 *   4) buildActiveBody использует этот at, если history-запроса ещё не было.
 */

const Rpc = require('../core/gemini-rpc.js');

function makeState(convId) {
  return {
    activeSeq: 0,
    lastAtEncoded: '',
    lastBaseUrl: '',
    lastHeaders: null,
    lastReqId: 0,
    getConvId: function () { return convId || 'conv1'; }
  };
}

function decodeFreq(body) {
  const m = body.match(/(?:^|&)f\.req=([^&]*)/);
  expect(m).toBeTruthy();
  return JSON.parse(decodeURIComponent(m[1]));
}

describe('сетевой шаблон hNvQHb для нового чата', () => {
  afterEach(() => {
    Rpc.__bind(makeState());
    delete window.WIZ_global_data;
    window.history.replaceState({}, '', '/');
  });

  test('1) rememberSiteMeta запоминает at/base/headers с не-history batchexecute', () => {
    const state = makeState();
    Rpc.__bind(state);

    const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=VxUbXb&source-path=%2Fapp%2Fconv1&bl=BL&f.sid=SID&hl=ru&_reqid=4321&rt=c';
    Rpc.rememberSiteMeta(url, { 'x-same-domain': '1' }, 'f.req=%5B%5D&at=AT-1&');

    expect(Rpc.isBatchexecuteRpc(url)).toBe(true);
    expect(Rpc.isHistoryRpc(url)).toBe(false);
    expect(state.lastAtEncoded).toBe('AT-1');
    expect(state.lastBaseUrl).toBe(url);
    expect(state.lastReqId).toBe(4321);
    expect(state.lastHeaders['x-same-domain']).toBe('1');
  });

  test('2) заголовки соседних RPC не затирают уже снятые заголовки истории', () => {
    const state = makeState();
    state.lastHeaders = { 'x-same-domain': '1', 'x-goog-ext-525001261-jspb': 'token' };
    Rpc.__bind(state);

    Rpc.rememberSiteMeta(
      'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=aPya6c&_reqid=7',
      { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      'f.req=%5B%5D&at=AT-2&'
    );

    expect(state.lastHeaders['x-goog-ext-525001261-jspb']).toBe('token');
    expect(state.lastHeaders['content-type']).toContain('application/x-www-form-urlencoded');
  });

  test('3) buildActiveUrl: rpcids → hNvQHb, source-path → текущий чат, _reqid сдвинут', () => {
    const state = makeState('conv1');
    state.lastBaseUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=VxUbXb&source-path=%2Fapp%2FOLD&bl=BL&f.sid=SID&hl=ru&_reqid=1000&rt=c';
    state.lastReqId = 1000;
    Rpc.__bind(state);
    window.history.replaceState({}, '', '/app/NEW');

    const url = Rpc.buildActiveUrl();

    expect(url).toContain('rpcids=hNvQHb');
    expect(url).toContain('source-path=%2Fapp%2FNEW');
    expect(url).toContain('_reqid=1007');
    expect(url).not.toContain('rpcids=VxUbXb');
  });

  test('4) ensureActiveMeta добирает шаблон из WIZ_global_data без единого hNvQHb', () => {
    const state = makeState('conv9');
    Rpc.__bind(state);
    window.WIZ_global_data = { SNlM0e: 'WIZ-AT', cfb2h: 'WIZ-BL', FdrFJe: 'WIZ-SID' };
    window.history.replaceState({}, '', '/app/conv9');

    expect(Rpc.ensureActiveMeta()).toBe(true);
    expect(state.lastAtEncoded).toBe('WIZ-AT');
    expect(state.lastBaseUrl).toContain('rpcids=hNvQHb');
    expect(state.lastBaseUrl).toContain('source-path=%2Fapp%2Fconv9');
    expect(state.lastBaseUrl).toContain('bl=WIZ-BL');
    expect(state.lastBaseUrl).toContain('f.sid=WIZ-SID');
    expect(state.lastHeaders['x-same-domain']).toBe('1');
  });

  test('5) buildActiveBody берёт WIZ at и точную hNvQHb-форму с c_<convId>', () => {
    const state = makeState('conv42');
    Rpc.__bind(state);
    window.WIZ_global_data = { SNlM0e: 'WIZ-AT' };

    const body = Rpc.buildActiveBody();

    expect(body).toContain('&at=WIZ-AT&');
    const outer = decodeFreq(body);
    expect(outer[0][0][0]).toBe('hNvQHb');
    expect(JSON.parse(outer[0][0][1])).toEqual(['c_conv42', 10, null, 1, [0], [4], null, 1]);
  });
});
