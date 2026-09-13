/**
 * M-12 (v1.19.2): гейт сниффинг→EMIT в core/perplexity-intercept.js — снимок истории
 * эмитится в бейдж/историю ТОЛЬКО если его slug доказуемо совпал со slug страницы
 * (/search/<id> или /thread/<id>).
 *
 * Дефект 13.09 17:24 (домашняя страница perplexity.ai — URL без slug): гейт «нет slug — не тред»
 * стоял только на bootstrap; пассивный сниффинг (fetch/XHR) ловил снимки ЧУЖИХ тредов
 * (e2ffa178, 193399cd, bf464421…) и каждый перерисовывал бейдж (2.7→0.8→0.4→…), а также
 * уходил в запись истории (history-write идёт по тому же событию ai-cm-full-history).
 *
 * Проверки:
 *   (а) страница без slug + снимок треда → НЕТ EMIT → нет badge-DRAW и нет history-write;
 *   (б) страница со slug + снимок ДРУГОГО треда → НЕТ EMIT (чужой снимок не эмитится);
 *   (в) страница со slug + совпадающий снимок → EMIT прежний (байтово тот же контракт),
 *       lastHistoryUrl/шаблон выучены → виртуальный F5 работает как раньше;
 *   (г) тот же гейт на XHR-ветке сниффинга (единая точка processHistoryData);
 *   (д) bootstrap и виртуальный F5 не тронуты (маркеры + прежнее поведение на треде).
 *
 * «НЕ трогать»: bootstrap, виртуальный F5, парсер, content.js, прочие перехватчики.
 */
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'perplexity-intercept.js'), 'utf8');

const OWN = '5fe65fcb';        // slug страницы
const FOREIGN = 'e2ffa178';    // чужой тред из лога дефекта

function threadJson(slug, text) {
  return JSON.stringify({
    entries: [{ thread_url_slug: slug, text: text || ('ход треда ' + slug) }],
    thread_metadata: { slug: slug },
  });
}

// Снимок без slug в теле (ни thread_metadata.slug, ни единогласного entries[*].thread_url_slug)
function threadJsonNoSlug(text) {
  return JSON.stringify({
    entries: [{ query_str: 'вопрос', text: text || 'ответ' }],
    thread_metadata: { title: 'без slug' },
  });
}

const PARSER = function (data) {
  const entries = (data && data.entries) || [];
  const text = entries.map(function (e) { return e.text; }).join('\n');
  return { text: text, count: entries.length, model: 'sonar', lastText: text, pieces: [text], ids: ['1'], messages: [] };
};

function okResp(body) {
  return {
    ok: true,
    status: 200,
    text: function () { return Promise.resolve(body); },
    json: function () { return Promise.resolve(JSON.parse(body)); },
    body: { getReader: function () { return { read: function () { return Promise.resolve({ done: true, value: undefined }); } }; } },
    clone: function () { return this; },
  };
}

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

/** Мок fetch с диспетчером handler(url, method, init) → Response. */
function installFetch(handler) {
  const fetchMock = jest.fn(function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    return Promise.resolve(handler(url, method, init || {}));
  });
  window.fetch = fetchMock;
  return fetchMock;
}

/** Мок XMLHttpRequest: send() синхронно зовёт loadend-слушатель перехватчика. */
function installXhrStub(body, responseURL) {
  const sent = [];
  function FakeXHR() { this.listeners = {}; }
  FakeXHR.prototype.open = function (method, url) { this.__m = method; this.__u = url; };
  FakeXHR.prototype.addEventListener = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  };
  FakeXHR.prototype.send = function () {
    this.responseText = body;
    this.responseURL = responseURL || this.__u;
    sent.push(String(this.__u));
    const arr = this.listeners['loadend'] || [];
    for (let i = 0; i < arr.length; i++) arr[i].call(this);
  };
  window.XMLHttpRequest = FakeXHR;
  return sent;
}

/**
 * Полная установка перехватчика. pathname — URL страницы, handler — диспетчер fetch-мока,
 * historyWrite — «запись истории»: в бою это делает content.js по тому же событию
 * ai-cm-full-history (deferred history-write), здесь — счётчик, чтобы пиновать «историю не пишем».
 */
function installIntercept(pathname, handler, xhr) {
  window.history.pushState({}, '', pathname);
  window.parsePerplexityThread = PARSER;
  const fetchMock = installFetch(handler);
  const xhrSent = xhr ? installXhrStub(xhr.body, xhr.responseURL) : null;
  const events = [];
  const historyWrites = [];
  const onHist = function (ev) {
    events.push(ev.detail);
    historyWrites.push(ev.detail && ev.detail.convId ? ev.detail.convId : '(no-convId)');
  };
  window.addEventListener('ai-cm-full-history', onHist);
  delete window.__aiCmPerplexityInterceptInstalled;
  // eslint-disable-next-line no-eval
  eval(SRC);
  return {
    fetchMock: fetchMock,
    events: events,
    historyWrites: historyWrites,
    xhrSent: xhrSent,
    cleanup: function () { window.removeEventListener('ai-cm-full-history', onHist); },
  };
}

function fetchJson(url) { return window.fetch(url); }
function simulateAsk() {
  return window.fetch('https://www.perplexity.ai/rest/sse/perplexity_ask', { method: 'POST', body: '{}' });
}
const guardCalls = (fetchMock) => fetchMock.mock.calls.filter(function (c) {
  return String(c[0]).indexOf('__aicm_perplexity__=1') !== -1;
});

let debugLogs;
let consoleLines;

beforeEach(() => {
  jest.useFakeTimers();
  debugLogs = [];
  consoleLines = [];
  global.debugLog = function (level, msg) { debugLogs.push(String(msg)); };
  global.__aiCmSetDebugLogs = function () { };
  // «снимок истории пойман» и «📥 полный снимок» идут напрямую в console.log перехватчика
  jest.spyOn(console, 'log').mockImplementation(function () {
    consoleLines.push(Array.prototype.join.call(arguments, ' '));
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete global.debugLog;
  delete global.__aiCmSetDebugLogs;
});

// ---- (а) страница без slug: снимок треда не эмитится (badge не перерисовывается, история не пишется) ----
describe('M-12 (а): домашняя страница perplexity.ai (без slug) — сниффинг не эмитит', () => {
  test('чужой снимок на странице «/» → 0 EMIT, 0 history-write, виджет держит «—»', async () => {
    // ровно сценарий дефекта: главная без slug, пассивный GET истории чужого треда
    const ctx = installIntercept('/', function (url, method, init) {
      if (init.headers && init.headers.Accept === 'application/json') return okResp('<html>RSC</html>');
      return okResp(threadJson(FOREIGN));
    });
    try {
      await fetchJson('https://www.perplexity.ai/api/thread/' + FOREIGN + '?cursor=0');
      await settle();
      jest.advanceTimersByTime(1500); // стартовый bootstrap-таймер: «нет slug — не тред»
      await settle();

      expect(ctx.events.length).toBe(0);        // EMIT нет → бейдж не перерисовывается
      expect(ctx.historyWrites.length).toBe(0); // history-write (content.js) не запускается
      expect(debugLogs.some(function (m) { return m.indexOf('нет slug страницы — не тред') !== -1; })).toBe(true);
      expect(debugLogs.some(function (m) { return m.indexOf('bootstrap: нет slug — не тред') !== -1; })).toBe(true);
      expect(consoleLines.some(function (m) { return m.indexOf('снимок истории пойман') !== -1; })).toBe(false);
    } finally { ctx.cleanup(); }
  });

  test('серия чужих снимков (e2ffa178, 193399cd, bf464421) → ни одного EMIT', async () => {
    const ctx = installIntercept('/', function () { return okResp(threadJson(FOREIGN)); });
    try {
      const foreigns = ['e2ffa178', '193399cd', 'bf464421'];
      for (let i = 0; i < foreigns.length; i++) {
        await fetchJson('https://www.perplexity.ai/api/thread/' + foreigns[i] + '?cursor=0');
        await settle();
      }
      expect(ctx.events.length).toBe(0);
      expect(ctx.historyWrites.length).toBe(0);
    } finally { ctx.cleanup(); }
  });
});

// ---- (б) страница со slug + снимок ДРУГОГО треда: не эмитим ----
describe('M-12 (б): страница /search/<id> — чужой снимок отброшен', () => {
  test('снимок треда e2ffa178 на странице /search/5fe65fcb → 0 EMIT + лог «чужой снимок»', async () => {
    const ctx = installIntercept('/search/' + OWN, function () { return okResp(threadJson(FOREIGN)); });
    try {
      await fetchJson('https://www.perplexity.ai/api/thread/' + FOREIGN + '?cursor=0');
      await settle();
      expect(ctx.events.length).toBe(0);
      expect(ctx.historyWrites.length).toBe(0);
      expect(debugLogs.some(function (m) { return m.indexOf('чужой снимок (slug=' + FOREIGN + ' != slug страницы ' + OWN + ')') !== -1; })).toBe(true);
    } finally { ctx.cleanup(); }
  });

  test('снимок без slug (ни тело, ни URL) → не эмитим: slug не доказан', async () => {
    const ctx = installIntercept('/search/' + OWN, function () { return okResp(threadJsonNoSlug()); });
    try {
      await fetchJson('https://www.perplexity.ai/api/history?cursor=0');
      await settle();
      expect(ctx.events.length).toBe(0);
      expect(debugLogs.some(function (m) { return m.indexOf('slug=(не определён)') !== -1; })).toBe(true);
    } finally { ctx.cleanup(); }
  });

  test('/thread/<slug> (старая форма URL) гейтуется так же: совпал → EMIT, чужой → нет', async () => {
    let body = threadJson(OWN);
    const ctx = installIntercept('/thread/' + OWN, function () { return okResp(body); });
    try {
      await fetchJson('https://www.perplexity.ai/rest/thread/' + OWN);
      await settle();
      expect(ctx.events.length).toBe(1);
      body = threadJson(FOREIGN);
      await fetchJson('https://www.perplexity.ai/rest/thread/' + FOREIGN);
      await settle();
      expect(ctx.events.length).toBe(1); // чужой не добавился
    } finally { ctx.cleanup(); }
  });
});

// ---- (в) страница со slug + совпадающий снимок: EMIT прежний ----
describe('M-12 (в): совпадающий снимок — EMIT байтово прежний, vf5 работает', () => {
  test('пассивный снимок своего треда → EMIT + выученный lastHistoryUrl → vf5 по guard-адресу', async () => {
    const ctx = installIntercept('/search/' + OWN, function () { return okResp(threadJson(OWN)); });
    try {
      await fetchJson('https://www.perplexity.ai/api/thread/' + OWN + '?cursor=0');
      await settle();
      expect(ctx.events.length).toBe(1); // снимок пойман пассивно, как прежде
      expect(ctx.events[0].count).toBe(1);
      expect(ctx.events[0].historyComplete).toBe(true);
      expect(ctx.events[0].text).toContain('ход треда ' + OWN);
      expect(consoleLines.some(function (m) { return m.indexOf('снимок истории пойман (fetch)') !== -1; })).toBe(true);

      // vf5 после стрима: адрес снимка выучен (lastHistoryUrl), bootstrap не нужен
      await simulateAsk();
      await settle();
      jest.advanceTimersByTime(800);
      await settle();
      expect(guardCalls(ctx.fetchMock).length).toBe(1);
      expect(ctx.events.length).toBe(2);
    } finally { ctx.cleanup(); }
  });

  test('тело без slug, но URL ответа = /rest/thread/<slug страницы> → EMIT (URL — улика)', async () => {
    const ctx = installIntercept('/search/' + OWN, function () { return okResp(threadJsonNoSlug()); });
    try {
      await fetchJson('https://www.perplexity.ai/rest/thread/' + OWN);
      await settle();
      expect(ctx.events.length).toBe(1);
    } finally { ctx.cleanup(); }
  });
});

// ---- (г) XHR-ветка: тот же гейт (единая точка processHistoryData) ----
describe('M-12 (г): XHR-сниффинг гейтуется тем же правилом', () => {
  test('XHR чужого треда на странице без slug → 0 EMIT', async () => {
    const ctx = installIntercept('/', function () { return okResp('{}'); }, { body: threadJson(FOREIGN) });
    try {
      const xhr = new window.XMLHttpRequest();
      xhr.open('GET', 'https://www.perplexity.ai/api/thread/' + FOREIGN);
      xhr.send();
      await settle();
      expect(ctx.xhrSent.length).toBe(1);
      expect(ctx.events.length).toBe(0);
      expect(ctx.historyWrites.length).toBe(0);
    } finally { ctx.cleanup(); }
  });

  test('XHR своего треда на /search/<id> → EMIT (прежнее поведение)', async () => {
    const ctx = installIntercept('/search/' + OWN, function () { return okResp('{}'); }, { body: threadJson(OWN) });
    try {
      const xhr = new window.XMLHttpRequest();
      xhr.open('GET', 'https://www.perplexity.ai/api/thread/' + OWN);
      xhr.send();
      await settle();
      expect(ctx.events.length).toBe(1);
    } finally { ctx.cleanup(); }
  });
});

// ---- (д) «НЕ трогать»: bootstrap и виртуальный F5 на месте и прежние ----
describe('M-12 (д): bootstrap и виртуальный F5 не тронуты', () => {
  test('маркеры прежних путей в источнике', () => {
    expect(SRC).toContain("if (!currentConvId) { debugLog('log', '[perplexity-intercept] bootstrap: нет slug — не тред'); return; }");
    expect(SRC).toContain("debugLog('log', '[perplexity-vf5] нет адреса снимка → bootstrapSnapshot (выучить шаблон)');");
    expect(SRC).toContain('function bootstrapRestSnapshot()');
    expect(SRC).toContain('historyUrlTemplate.replace(\'{slug}\', currentConvId)');
    // гейт живёт ровно в одной точке — processHistoryData (обе ветки сниффинга идут через неё)
    expect(SRC.match(/снимок не эмитим/g).length).toBe(1);
    expect(SRC).toContain('if (hasEntriesAndMetadata(data)) processHistoryData(data, url, source);');            // fetch
    expect(SRC).toContain("if (hasEntriesAndMetadata(data)) processHistoryData(data, respUrl || url, 'XHR');"); // XHR
  });

  test('bootstrap на треде со slug работает как прежде: снимок доходит до виджета', async () => {
    const ctx = installIntercept('/search/' + OWN, function (url, method, init) {
      if (init.headers && init.headers.Accept === 'application/json') return okResp(threadJson(OWN));
      return okResp(threadJson(OWN));
    });
    try {
      jest.advanceTimersByTime(1500); // стартовый bootstrap-таймер
      await settle();
      expect(ctx.events.length).toBe(1);
      expect(ctx.events[0].count).toBe(1);
    } finally { ctx.cleanup(); }
  });
});

// ---- «НЕ трогать»: прочие перехватчики не изменены ----
describe('M-12: аудит прочих интерцепторов — паттерн найден только у Perplexity', () => {
  const at = function (rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); };
  test('ChatGPT/Claude/DeepSeek/Gemini: у пассивной ловли снимка есть гард по convId', () => {
    expect(at('core/page-intercept.js')).toContain('if (expectedConvId && expectedConvId !== currentConvId) {');
    expect(at('core/claude-intercept.js')).toContain('if (isStaleSnapshotBody(data, String(when || \'passive\'))) return;');
    expect(at('core/deepseek-intercept.js')).toContain('if (resp && resp.ok && guardCheck(historyConvId)) {');
    expect(at('core/gemini-intercept.js')).toContain('var staleShot = (reqConvId && reqConvId !== currentConvId) ||');
  });
});
