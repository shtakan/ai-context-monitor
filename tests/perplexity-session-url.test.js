/**
 * v2.0.35 (приёмка Фазы 3, шаг 1): Perplexity /session/<uuid> — третья живая форма диалога.
 *
 * Дефект живой приёмки: Perplexity переехал на /session/<uuid> (id — hex с дефисами).
 * isOnDialogPage() знал только /search/ и /thread/, getConvId() — только search|thread,
 * slugFromThreadUrl() — только search|thread|rest/thread|api/thread, extractConvIdFromUrl()
 * — только /search/<id> и /thread/<id>. Следствие: страница диалога, но convId='' →
 * гейт M-12 «нет slug страницы — не тред» глушил эмит снимка (бейдж «—», история не
 * пишется), а автоэкспорт выходил на «нет cid» при зелёных гейтах.
 *
 * Проверки:
 *   (1) extractConvIdFromUrl('/session/<uuid>') → <uuid>; мусорный/короткий хвост → '';
 *   (2) перехватчик: страница /session/<uuid> + совпадающий снимок → EMIT (convId взят из пути);
 *   (3) slugFromThreadUrl: тело без slug + URL /rest/session/<uuid> → EMIT (slug из URL);
 *   (4) чужой снимок на /session/ — по-прежнему НЕ эмитится (гейт не ослаблен);
 *   (5) M-12 fallback: slug страницы не извлекается, но в DOM есть сообщения → EMIT разрешён;
 *       после удаления DOM-узлов тот же снимок снова отклоняется (fallback строго DOM-gated);
 *   (6) адаптер: isOnDialogPage() знает /session/.
 */
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

const ROOT = path.join(__dirname, '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'perplexity-intercept.js'), 'utf8');
const ADAPTER_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'perplexity-adapter.js'), 'utf8');
const { interceptSource } = require('./helpers/main-intercept.js');
const P = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.js');

const SESSION = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'; // /session/<uuid> приёмки
const FOREIGN = 'e2ffa178';                                 // чужой тред из лога M-12

function threadJson(slug, text) {
  return JSON.stringify({
    entries: [{ thread_url_slug: slug, text: text || ('ход треда ' + slug) }],
    thread_metadata: { slug: slug },
  });
}

// Снимок без slug в теле: ни thread_metadata.slug, ни единогласного entries[*].thread_url_slug
function threadJsonNoSlug(text) {
  return JSON.stringify({
    entries: [{ query_str: 'вопрос', text: text || 'ответ' }],
    thread_metadata: { title: 'без slug' },
  });
}

const PARSER = function (data) {
  const entries = (data && data.entries) || [];
  const text = entries.map(function (e) { return e.text; }).join('\n');
  return {
    text: text, count: entries.length, model: 'sonar',
    lastText: text, pieces: [text], ids: ['1'], messages: [],
  };
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

function installFetch(handler) {
  const fetchMock = jest.fn(function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    return Promise.resolve(handler(url, method, init || {}));
  });
  window.fetch = fetchMock;
  return fetchMock;
}

function installIntercept(pathname, handler) {
  window.history.pushState({}, '', pathname);
  window.parsePerplexityThread = PARSER;
  const fetchMock = installFetch(handler);
  const events = [];
  const onHist = function (ev) { events.push(ev.detail); };
  window.addEventListener('ai-cm-full-history', onHist);
  delete window.__aiCmPerplexityInterceptInstalled;
  eval(interceptSource('core/perplexity-intercept.js'));
  return {
    fetchMock: fetchMock,
    events: events,
    cleanup: function () { window.removeEventListener('ai-cm-full-history', onHist); },
  };
}

let debugLogs;
let consoleLines;

beforeEach(() => {
  jest.useFakeTimers();
  debugLogs = [];
  consoleLines = [];
  global.debugLog = function (level, msg) { debugLogs.push(String(msg)); };
  global.__aiCmSetDebugLogs = function () { };
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
  document.body.innerHTML = '';
});

const hasLog = (needle) => debugLogs.some(function (m) { return m.indexOf(needle) !== -1; });

// ---- (1) каноничный экстрактор convId: /session/<uuid> ----
describe('extractConvIdFromUrl — Perplexity /session/<uuid>', () => {
  test('/session/<uuid> → <uuid> (hex + дефисы, 8+ символов)', () => {
    expect(P.extractConvIdFromUrl('/session/' + SESSION)).toBe(SESSION);
    expect(P.extractConvIdFromUrl('/session/0a1b2c3d4e5f')).toBe('0a1b2c3d4e5f');
    // старые формы не сломаны
    expect(P.extractConvIdFromUrl('/search/5fe65fcb1a2b')).toBe('5fe65fcb1a2b');
    expect(P.extractConvIdFromUrl('/thread/some-slug-99')).toBe('some-slug-99');
  });

  test('короткий/не-id хвост /session/ → пусто (не плодим ложные cid)', () => {
    expect(P.extractConvIdFromUrl('/session')).toBe('');
    expect(P.extractConvIdFromUrl('/session/abc')).toBe('');
    expect(P.extractConvIdFromUrl('/session/new')).toBe('');
    expect(P.extractConvIdFromUrl('/session?x=1')).toBe('');
  });
});

// ---- (2) страница /session/<uuid>: convId извлекается, снимок эмитится ----
describe('перехватчик: страница /session/<uuid> — снимок своего треда эмитится', () => {
  test('GET истории на /session/<uuid> → 1 EMIT (до фикса convId был пуст)', async () => {
    const ctx = installIntercept('/session/' + SESSION, function () { return okResp(threadJson(SESSION)); });
    try {
      await window.fetch('https://www.perplexity.ai/api/thread/' + SESSION + '?cursor=0');
      await settle();
      expect(ctx.events.length).toBe(1);
      expect(ctx.events[0].count).toBe(1);
      expect(ctx.events[0].text).toContain('ход треда ' + SESSION);
      expect(consoleLines.some(function (m) { return m.indexOf('снимок истории пойман') !== -1; })).toBe(true);
      // гейт прошёл по СОВПАДЕНИЮ, а не по fallback: DOM пуст
      expect(hasLog('M-12 fallback')).toBe(false);
    } finally { ctx.cleanup(); }
  });
});

// ---- (3) slug из URL /rest/session/<uuid> (тело без slug) ----
describe('slugFromThreadUrl: /rest/session/<uuid>', () => {
  test('снимок без slug в теле + URL /rest/session/<uuid> → EMIT (slug из сетевого URL)', async () => {
    const ctx = installIntercept('/session/' + SESSION, function () { return okResp(threadJsonNoSlug()); });
    try {
      await window.fetch('https://www.perplexity.ai/rest/session/' + SESSION + '?with_parent_info=true');
      await settle();
      expect(ctx.events.length).toBe(1);
    } finally { ctx.cleanup(); }
  });
});

// ---- (4) гейт не ослаблен: чужой снимок на /session/ по-прежнему отбрасывается ----
describe('M-12 на /session/: чужой снимок отброшен', () => {
  test('снимок треда ' + FOREIGN + ' на странице /session/<uuid> → 0 EMIT', async () => {
    const ctx = installIntercept('/session/' + SESSION, function () { return okResp(threadJson(FOREIGN)); });
    try {
      await window.fetch('https://www.perplexity.ai/api/thread/' + FOREIGN + '?cursor=0');
      await settle();
      expect(ctx.events.length).toBe(0);
      expect(hasLog('чужой снимок (slug=' + FOREIGN + ' != slug страницы ' + SESSION + ')')).toBe(true);
    } finally { ctx.cleanup(); }
  });
});

// ---- (5) M-12 fallback: нет slug страницы, но в DOM есть сообщения ----
describe('M-12 fallback: DOM-сообщения разрешают эмит без slug страницы', () => {
  test('домашняя страница + 2 узла .prose в DOM → EMIT; DOM пуст → снова отказ', async () => {
    document.body.innerHTML = '<div class="prose">вопрос</div><div class="prose">ответ</div>';
    const ctx = installIntercept('/', function () { return okResp(threadJsonNoSlug()); });
    try {
      await window.fetch('https://www.perplexity.ai/api/thread/' + FOREIGN + '?cursor=0');
      await settle();
      expect(ctx.events.length).toBe(1); // fallback сработал: страница живая
      expect(hasLog('эмит разрешён (M-12 fallback)')).toBe(true);
      expect(hasLog('нет slug страницы — не тред')).toBe(false);

      // DOM опустел (ушли с диалога) → тот же снимок больше не эмитится
      document.body.innerHTML = '';
      await window.fetch('https://www.perplexity.ai/api/thread/' + FOREIGN + '?cursor=0');
      await settle();
      expect(ctx.events.length).toBe(1);
      expect(hasLog('нет slug страницы — не тред')).toBe(true);
    } finally { ctx.cleanup(); }
  });
});

// ---- (6) адаптер и статическая разводка ----
describe('perplexity-adapter: /session/ — страница диалога', () => {
  test('isOnDialogPage() знает /session/, прежние формы сохранены', () => {
    const i = ADAPTER_SRC.indexOf('isOnDialogPage()');
    expect(i).toBeGreaterThan(-1);
    const body = ADAPTER_SRC.slice(i, i + 900);
    expect(body).toContain("path.indexOf('/session/') === 0");
    expect(body).toContain("path.indexOf('/search/') === 0");
    expect(body).toContain("path.indexOf('/thread/') === 0");
  });

  test('перехватчик: session в getConvId и в обеих regex slug (v2.0.35)', () => {
    expect(INTERCEPT_SRC).toContain("type === 'session'");
    expect(INTERCEPT_SRC).toContain('(?:search|thread|session|rest\\/thread|rest\\/session|api\\/thread)');
    // M-12 запрет остался ровно в одном месте (пин m12 не ослаблен)
    expect(INTERCEPT_SRC.match(/снимок не эмитим/g).length).toBe(1);
  });
});
