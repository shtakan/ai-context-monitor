/**
 * Фикс бага Perplexity (5/5): первое сообщение пустого треда → виджет «Загрузка контекста...».
 * Причина: vf5 без адреса (lastHistoryUrl пуст, шаблон не выучен) — тихий выход;
 * bootstrap Accept=json на свежем треде получает HTML/RSC → вечный латч bootstrapAcceptJsonFailed.
 * Фикс: (1) ветка !url в activeRefresh вызывает bootstrapSnapshot и снимает loggedActiveStatus;
 * (2) латч заменён retry-автоматом 2с/4с/8с (3 ретрая) по образцу scheduleActiveRetry.
 * «НЕ трогать»: gemini-intercept.js, content.js, claude-intercept.js, perplexity-parser.js,
 * manifest.json, utils/.
 */
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'perplexity-intercept.js'), 'utf8');

const SLUG = 'abc123';
const THREAD_JSON = JSON.stringify({
  entries: [{ thread_url_slug: SLUG, text: 'привет' }],
  thread_metadata: { slug: SLUG },
});
const HTML_BODY = '<!DOCTYPE html><html><body>RSC-payload</body></html>';

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

function flush() { return Promise.resolve(); }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

/** Ставит мок window.fetch с диспетчером handler(url, method, init) → Response. */
function installFetch(handler) {
  const fetchMock = jest.fn(function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    return Promise.resolve(handler(url, method, init || {}));
  });
  window.fetch = fetchMock;
  return fetchMock;
}

/** Полная установка перехватчика на свежем «треде» /search/abc123. */
function installIntercept(handler) {
  window.history.pushState({}, '', '/search/' + SLUG);
  window.parsePerplexityThread = PARSER;
  const fetchMock = installFetch(handler);
  const events = [];
  const onHist = function (ev) { events.push(ev.detail); };
  window.addEventListener('ai-cm-full-history', onHist);
  delete window.__aiCmPerplexityInterceptInstalled;
  // eslint-disable-next-line no-eval
  eval(src);
  return { fetchMock: fetchMock, events: events, cleanup: function () { window.removeEventListener('ai-cm-full-history', onHist); } };
}

/** POST /rest/sse/perplexity_ask — триггер vf5 после стрима. */
function simulateAsk() {
  return window.fetch('https://www.perplexity.ai/rest/sse/perplexity_ask', { method: 'POST', body: '{}' });
}

let debugLogs;

beforeEach(() => {
  jest.useFakeTimers();
  debugLogs = [];
  global.debugLog = function (level, msg) { debugLogs.push(String(msg)); };
  global.__aiCmSetDebugLogs = function () {};
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete global.debugLog;
  delete global.__aiCmSetDebugLogs;
});

const acceptCalls = (fetchMock) => fetchMock.mock.calls.filter(function (c) {
  const init = c[1] || {};
  return !!(init.headers && init.headers.Accept === 'application/json');
});
const guardCalls = (fetchMock) => fetchMock.mock.calls.filter(function (c) {
  return String(c[0]).indexOf('__aicm_perplexity__=1') !== -1;
});


// ---- (а) баг-сценарий: пустой тред, vf5 без адреса ----
describe('баг-сценарий: пустой тред → vf5 без адреса вызывает bootstrapSnapshot и учит шаблон', () => {
  test('первое сообщение: bootstrap вызван, Accept=json выучил шаблон, повторный vf5 работает', async () => {
    let acceptAttempt = 0;
    const ctx = installIntercept(function (url, method, init) {
      if (init.headers && init.headers.Accept === 'application/json') {
        acceptAttempt++;
        // попытка 1 — HTML/RSC (свежий тред), попытка 2 — уже успешный JSON
        return okResp(acceptAttempt === 1 ? HTML_BODY : THREAD_JSON);
      }
      return okResp(THREAD_JSON); // ask-SSE и любые GET
    });
    try {
      // пользователь отправляет первое сообщение в пустом треде
      await simulateAsk();
      await settle();
      jest.advanceTimersByTime(800); // scheduleActive после стрима
      await settle();

      // раньше: тихий выход «нет адреса снимка». Теперь: bootstrapSnapshot запущен
      expect(debugLogs.some(function (m) { return m.indexOf('нет адреса снимка → bootstrapSnapshot') !== -1; })).toBe(true);
      expect(acceptCalls(ctx.fetchMock).length).toBeGreaterThanOrEqual(1); // HTML-ответ не убил bootstrap

      // retry backoff 2с: вторая попытка Accept=json возвращает JSON
      jest.advanceTimersByTime(2000);
      await settle();

      // шаблон выучен → vf5 (повторное сообщение/страховка) получает адрес и работает
      await simulateAsk();
      await settle();
      jest.advanceTimersByTime(800);
      await settle();

      expect(guardCalls(ctx.fetchMock).length).toBeGreaterThanOrEqual(1); // vf5 реально сходил по адресу
      expect(ctx.events.length).toBeGreaterThanOrEqual(1); // снимок дошёл — виджет НЕ завис
      expect(ctx.events[ctx.events.length - 1].count).toBe(1);
      expect(ctx.events[ctx.events.length - 1].historyComplete).toBe(true);
    } finally { ctx.cleanup(); }
  });
});

// ---- (б) bootstrap retry: backoff 2с/4с/8с вместо вечного латча ----
describe('bootstrap retry: первый Accept=json не-JSON → ретраи с backoff → успех на 3-й попытке', () => {
  test('3 попытки: HTML, HTML, JSON; задержки 2000мс и 4000мс; после успеха автомат сброшен (REST-fallback недоступен)', async () => {
    let acceptAttempt = 0;
    const ctx = installIntercept(function (url, method, init) {
      if (init.headers && init.headers.Accept === 'application/json') {
        acceptAttempt++;
        return okResp(acceptAttempt < 3 ? HTML_BODY : THREAD_JSON);
      }
      if (url.indexOf('/rest/thread/') !== -1) return { ok: false, status: 500 }; // REST-fallback недоступен
      return okResp(THREAD_JSON);
    });
    try {
      jest.advanceTimersByTime(1500); await settle(); // стартовый bootstrap-таймер
      expect(acceptCalls(ctx.fetchMock).length).toBe(1); // попытка 1: HTML

      jest.advanceTimersByTime(2000); await settle(); // retry #1 (backoff 2с)
      expect(acceptCalls(ctx.fetchMock).length).toBe(2); // попытка 2: HTML

      jest.advanceTimersByTime(4000); await settle(); // retry #2 (backoff 4с)
      expect(acceptCalls(ctx.fetchMock).length).toBe(3); // попытка 3: JSON — успех

      expect(ctx.events.length).toBe(1); // снимок дошёл до виджета
      expect(ctx.events[0].count).toBe(1);

      // успех снял retry-состояние: лишних Accept-запросов больше нет
      jest.advanceTimersByTime(30000);
      await settle();
      expect(acceptCalls(ctx.fetchMock).length).toBe(3);
    } finally { ctx.cleanup(); }
  });

  test('Accept=json вернул HTML → REST-fallback /rest/thread/{slug} даёт снимок немедленно', async () => {
    const ctx = installIntercept(function (url, method, init) {
      if (init.headers && init.headers.Accept === 'application/json') return okResp(HTML_BODY);
      if (url.indexOf('/rest/thread/') !== -1) return okResp(THREAD_JSON);
      return okResp(THREAD_JSON);
    });
    try {
      jest.advanceTimersByTime(1500); await settle(); // стартовый bootstrap-таймер
      const restCalls = ctx.fetchMock.mock.calls.filter(function (c) { return String(c[0]).indexOf('/rest/thread/') !== -1 && !((c[1] || {}).headers && c[1].headers.Accept); });
      expect(restCalls.length).toBe(1); // fallback сработал сразу после не-JSON
      expect(ctx.events.length).toBe(1); // снимок от REST-fallback дошёл до виджета
      expect(ctx.events[0].count).toBe(1);
      expect(ctx.events[0].historyComplete).toBe(true);
      // после успеха новых Accept-запросов нет
      jest.advanceTimersByTime(30000); await settle();
      expect(acceptCalls(ctx.fetchMock).length).toBe(1);
    } finally { ctx.cleanup(); }
  });

  test('3 неудачи (Accept=HTML, REST недоступен) → автомат сдаётся, новых Accept-запросов нет', async () => {
    let acceptAttempt = 0;
    const ctx = installIntercept(function (url, method, init) {
      if (init.headers && init.headers.Accept === 'application/json') { acceptAttempt++; return okResp(HTML_BODY); }
      if (url.indexOf('/rest/thread/') !== -1) return { ok: false, status: 500 }; // REST-fallback недоступен
      return okResp(THREAD_JSON);
    });
    try {
      jest.advanceTimersByTime(1500); await settle(); // попытка 1
      jest.advanceTimersByTime(2000); await settle(); // попытка 2
      jest.advanceTimersByTime(4000); await settle(); // попытка 3
      expect(acceptCalls(ctx.fetchMock).length).toBe(3);
      jest.advanceTimersByTime(8000); await settle(); // 4-й не должен случиться
      expect(acceptCalls(ctx.fetchMock).length).toBe(3);
      expect(debugLogs.some(function (m) { return m.indexOf('retry Accept=json') !== -1; })).toBe(true);
    } finally { ctx.cleanup(); }
  });
});


// ---- (в) байтово-идентично: непустой тред ----
describe('байтово-идентично: непустой тред (снимок пойман пассивно) — vf5 как прежде', () => {
  test('vf5 идёт по lastHistoryUrl, bootstrap Accept=json не вызывается, ретраев нет', async () => {
    const ctx = installIntercept(function (url, method, init) {
      if (init.headers && init.headers.Accept === 'application/json') return okResp(HTML_BODY);
      return okResp(THREAD_JSON);
    });
    try {
      // непустой тред: пассивный сниффинг GET истории (как на живой странице)
      await window.fetch('https://www.perplexity.ai/api/thread/' + SLUG + '?cursor=0');
      await settle();
      expect(ctx.events.length).toBe(1); // снимок пойман пассивно, как прежде

      // стартовый bootstrap-таймер (1500мс): snapshotReceived → «не нужен», Accept НЕ вызывается
      jest.advanceTimersByTime(1500);
      await settle();
      expect(acceptCalls(ctx.fetchMock).length).toBe(0);

      // vf5 после стрима: адрес есть → прямой запрос с guard-токеном, без bootstrap
      await simulateAsk();
      await settle();
      jest.advanceTimersByTime(800);
      await settle();

      expect(guardCalls(ctx.fetchMock).length).toBe(1);
      expect(ctx.events.length).toBe(2); // пассивный + виртуальный F5
      expect(debugLogs.some(function (m) { return m.indexOf('нет адреса снимка') !== -1; })).toBe(false);
      expect(debugLogs.some(function (m) { return m.indexOf('bootstrapSnapshot (выучить шаблон)') !== -1; })).toBe(false);
    } finally { ctx.cleanup(); }
  });
});

// ---- «НЕ трогать»: файлы вне задачи не изменены (контрольные маркеры) ----
describe('НЕ трогать: маркеры неизменности остальных файлов', () => {
  const root = path.join(__dirname, '..');
  test('gemini-intercept.js: маркер autoscroll-арбитра на месте', () => {
    const s = fs.readFileSync(path.join(root, 'core', 'gemini-intercept.js'), 'utf8');
    expect(s).toContain('[gemini-autoscroll]');
  });
  test('content.js: маркер deferred-flush на месте', () => {
    const s = fs.readFileSync(path.join(root, 'core', 'content.js'), 'utf8');
    expect(s).toContain("aiCmFlushDeferredHistWrite(cid79, 'base-complete')");
  });
  test('claude-intercept.js и perplexity-parser.js на месте', () => {
    expect(fs.readFileSync(path.join(root, 'core', 'claude-intercept.js'), 'utf8').length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(root, 'utils', 'perplexity-parser.js'), 'utf8').length).toBeGreaterThan(0);
  });
});
