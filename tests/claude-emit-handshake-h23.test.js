/**
 * H23: гонка «ответ истории раньше слушателя» (claude.ai, живой лог 2026-09-09).
 *
 * Наблюдение: MAIN-перехватчик (document_start) распарсил снимок 120 сообщений в
 * 13:08:51.404, content.js (ISOLATED, document_idle) зарегистрировал слушатель
 * ai-cm-full-history в 13:08:52.506 → fire-once emit потерян: svc-emit-trace msgs=0,
 * DRAW-ПРОПУСК, виджет 0.0% и попап «Откройте поддерживаемый сайт» до F5 (13:11:24);
 * после F5 всё работает (emit-channel=received → pct=53.6% → fired).
 *
 * Эти тесты грузят РЕАЛЬНЫЙ core/claude-intercept.js в jsdom и гоняют его через
 * подменённый window.fetch (bootstrap → emitSnapshot → ai-cm-full-history). Порядок
 * шагов в файле — это и есть таймлайн гонки:
 *   1) bootstrap-эмит уходит, когда слушателя ЕЩЁ НЕТ (тест «гонка»);
 *   2) content.js регистрирует слушатель и диспатчит 'ai-cm-content-ready' → MAIN
 *      ре-эмитит РЕТЕЙН (тот же detail, без перепарса);
 *   3) 'ai-cm-request-emit' (3с-фолбэк content.js) отвечает тем же ретейном;
 *   4) SPA-смена чата обнуляет ретейн (чужой снимок не ре-эмитится).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INTERCEPT = path.join(ROOT, 'core', 'claude-intercept.js');
const CONTENT_SRC = require('./helpers/content-source.js').contentSource;
const INTERCEPT_SRC = fs.readFileSync(INTERCEPT, 'utf8');

const CONV = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'claude-conversation.json'), 'utf8'));
const CONV_ID = CONV.uuid;
const CHAT_URL = '/chat/' + CONV_ID;
const OTHER_CHAT_URL = '/chat/conv-00000000-0000-4000-a000-0000000000ff';

// ---- jsdom-харнесс: подменённый window.fetch играет роль сервера ----
let serverCalls = [];
let spy = null;

function fakeResponse(jsonBody) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(jsonBody),
    clone: () => ({
      json: () => Promise.resolve(jsonBody),
      text: () => Promise.resolve(JSON.stringify(jsonBody))
    })
  };
}

function fakeFetch(input) {
  const url = String(typeof input === 'string' ? input : (input && input.url) || '');
  serverCalls.push(url);
  if (url.indexOf('/chat_conversations/') !== -1) return Promise.resolve(fakeResponse(CONV));
  if (url.indexOf('/api/organizations') !== -1) return Promise.resolve(fakeResponse([{ uuid: 'org-h23' }]));
  return Promise.resolve(fakeResponse(null));
}

// прогон микрозадач: bootstrap timer → fetch → json() → parse → emit
function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 80); i++) p = p.then(() => { });
  return p;
}

function historyCalls() {
  return serverCalls.filter(function (u) { return u.indexOf('/chat_conversations/') !== -1; });
}

beforeAll(() => {
  jest.useFakeTimers();
  // путь задаём ДО require — currentConvId читается из location при инициализации
  window.history.pushState({}, '', CHAT_URL);
  window.fetch = fakeFetch;
  global.fetch = fakeFetch;
  // MAIN-мир получает эти глобалы из utils/debug.js (в тестах — заглушки)
  global.debugLog = jest.fn();
  global.__aiCmSetDebugLogs = jest.fn();
  global.__aiCmDebugLogs = false;
  require(INTERCEPT);
});

describe('H23 (a) гонка: снимок ушёл ДО регистрации слушателя', () => {
  test('bootstrap-эмит состоялся без слушателя; зарегистрированный позже слушатель его НЕ видит', async () => {
    // bootstrap-таймер перехватчика (1500мс от document_start) срабатывает раньше,
    // чем content.js (document_idle) успевает подписаться — слушателя ещё нет
    jest.advanceTimersByTime(1600);
    await flush(80);
    expect(historyCalls().length).toBeGreaterThanOrEqual(1); // снимок реально запрошен у сервера

    // теперь content.js зарегистрировал слушатель (поздняя подписка)
    spy = jest.fn();
    window.addEventListener('ai-cm-full-history', spy);
    expect(spy).not.toHaveBeenCalled(); // emit потерян — воспроизведение H23
  });

  test('content-ready → MAIN ре-эмитит ретейн: полный пейлоад снимка доходит', () => {
    window.dispatchEvent(new CustomEvent('ai-cm-content-ready'));
    expect(spy).toHaveBeenCalledTimes(1);
    const detail = spy.mock.calls[0][0].detail;
    expect(detail.count).toBe(4);
    expect(detail.convId).toBe(CONV_ID);
    expect(detail.historyComplete).toBe(true);
    expect(detail.messageIds).toHaveLength(4);
    expect(detail.messageTexts).toHaveLength(4);
    expect(detail.text).toContain('Синтетический вопрос номер один');
    expect(detail.text).toContain('Синтетический ответ два с тулзами');
    expect(detail.text).toContain('[tool: web_search]'); // tool_use → компактный маркер
    expect(detail.modelSlug).toBe('claude-sonnet-4-6');
  });
});

describe('H23 (b) идемпотентность ре-эмита', () => {
  test('повторные handshake-события отдают ТОТ ЖЕ detail (без перепарса и без двойного учёта)', () => {
    const before = spy.mock.calls.length;
    window.dispatchEvent(new CustomEvent('ai-cm-content-ready'));
    window.dispatchEvent(new CustomEvent('ai-cm-content-ready'));
    expect(spy.mock.calls.length).toBe(before + 2);
    // тот же объект: parseHistoryWithEffects повторно НЕ вызывался
    // (иначе attachTokens/collectAttachments могли бы изменить пейлоад)
    const first = spy.mock.calls[before - 1][0].detail;
    const second = spy.mock.calls[before][0].detail;
    const third = spy.mock.calls[before + 1][0].detail;
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.attachTokens).toBe(0);
    expect(first.count).toBe(4);
  });

  test('request-emit (3с-фолбэк content.js) отвечает тем же ретейном', () => {
    const before = spy.mock.calls.length;
    window.dispatchEvent(new CustomEvent('ai-cm-request-emit'));
    expect(spy.mock.calls.length).toBe(before + 1);
    expect(spy.mock.calls[before][0].detail).toBe(spy.mock.calls[0][0].detail);
  });
});

describe('H23 (c) SPA-смена чата: ретейн чужого чата не ре-эмитится', () => {
  test('после перехода в другой чат content-ready молчит (ретейн сброшен reset-ом)', () => {
    const before = spy.mock.calls.length;
    window.history.pushState({}, '', OTHER_CHAT_URL); // checkConvChange → resetForNewConversation
    window.dispatchEvent(new CustomEvent('ai-cm-content-ready'));
    window.dispatchEvent(new CustomEvent('ai-cm-request-emit'));
    expect(spy.mock.calls.length).toBe(before);
  });

  test('возврат в чат: новый снимок снова становится ретейном и ре-эмитится по ready', async () => {
    const before = spy.mock.calls.length;
    window.history.pushState({}, '', CHAT_URL);
    jest.advanceTimersByTime(1600); // bootstrap нового (прежнего) чата
    await flush(80);
    expect(spy.mock.calls.length).toBe(before + 1); // штатный эмит уже подписанного слушателя
    window.dispatchEvent(new CustomEvent('ai-cm-content-ready'));
    expect(spy.mock.calls.length).toBe(before + 2);
    expect(spy.mock.calls[before + 1][0].detail.count).toBe(4);
    expect(spy.mock.calls[before + 1][0].detail.convId).toBe(CONV_ID);
  });
});

describe('H23 (d) пины контракта (каналы только CustomEvent, миры не меняются)', () => {
  test('MAIN: ретейн последнего detail + слушатели content-ready/request-emit', () => {
    expect(INTERCEPT_SRC).toContain('var lastEmitDetail = null;');
    expect(INTERCEPT_SRC).toContain('var lastEmitDetailConvId = \'\';');
    expect(INTERCEPT_SRC).toContain('lastEmitDetail = detail;');
    expect(INTERCEPT_SRC).toContain('lastEmitDetail = null; // H23: ретейн старого чата не ре-эмитится в новый чат');
    expect(INTERCEPT_SRC).toContain("window.addEventListener('ai-cm-content-ready', function () { reEmitLastSnapshot('content-ready'); });");
    expect(INTERCEPT_SRC).toContain("window.addEventListener('ai-cm-request-emit', function () { reEmitLastSnapshot('request-emit'); });");
    // канал — CustomEvent в обоих направлениях, никаких новых миров/postMessage
    expect(INTERCEPT_SRC).not.toContain("window.postMessage({ source: 'ai-cm-h23'");
  });

  test('content.js: content-ready после создания адаптера + 3с-фолбэк request-emit', () => {
    const iAdapter = CONTENT_SRC.indexOf("debugLog('log', 'Адаптер:', currentAdapter.siteName);");
    const iReady = CONTENT_SRC.indexOf('aiCmDispatchContentReady();');
    expect(iAdapter).toBeGreaterThanOrEqual(0);
    expect(iReady).toBeGreaterThan(iAdapter); // строго после создания адаптера
    expect(CONTENT_SRC).toContain("window.dispatchEvent(new CustomEvent('ai-cm-content-ready'));");
    expect(CONTENT_SRC).toContain("window.dispatchEvent(new CustomEvent('ai-cm-request-emit'));");
    expect(CONTENT_SRC).toContain('}, 3000);');
    // гард байтовой идентичности: если снимок уже дошёл — handshake не выполняется
    expect(CONTENT_SRC).toContain('content-ready пропущен — emit уже дошёл');
    // фолбэк молчит, если ре-эмит уже дошёл
    expect(CONTENT_SRC).toContain('// badge-recv уже был (ре-эмит сработал) — повторный запрос не нужен');
  });

  test('H23 не выходит за claude: прочие сервисы байтово прежние', () => {
    expect(CONTENT_SRC).toContain("var AI_CM_H23_SITES = ['claude'];");
    expect(CONTENT_SRC).toContain('if (!aiCmH23Site()) return; // прочие сервисы — байтово прежнее поведение');
    // handshake-событие H23 объявлено ТОЛЬКО в claude-intercept.js (MAIN) и content.js
    const others = ['core/gemini-intercept.js', 'core/deepseek-intercept.js', 'core/perplexity-intercept.js',
      'core/google-search-intercept.js', 'core/page-intercept.js', 'adapters/gemini-adapter.js',
      'adapters/chatgpt-adapter.js', 'adapters/deepseek-adapter.js', 'adapters/perplexity-adapter.js',
      'adapters/google-search-adapter.js', 'adapters/claude-adapter.js'];
    others.forEach(function (rel) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).not.toContain('ai-cm-content-ready');
      expect(src).not.toContain('ai-cm-request-emit');
    });
    // GSA-handshake (другой контракт) не тронут
    const gsa = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
    expect(gsa).toContain("window.addEventListener('ai-cm-google-search-ready', function () {");
  });

  test('гейты автоэкспорта и tape/paste-матчинг не изменены (H23 — только ре-эмит события)', () => {
    // автоэкспорт: те же единственные точки вызова, отдельного триггера нет
    expect(CONTENT_SRC).toContain("doAutoExportDownload(cid, pctBc64, 'base-complete');");
    expect(CONTENT_SRC).toContain("doAutoExportDownload(cid, percentage, 'threshold');");
    expect(CONTENT_SRC).toContain('function maybeAutoExport(');
    expect(CONTENT_SRC).toContain('shouldSkipAutoExport');
    // гейт DRAW-ПРОПУСК и гейт полноты базы не тронуты
    expect(CONTENT_SRC).toContain('if (!isInitialized && !(baseSeen && baseComplete)) {');
    expect(CONTENT_SRC).toContain('const newBaseComplete = !!detail.historyComplete;');
    // tape-restore и paste-capture (Claude) на месте
    expect(CONTENT_SRC).toContain("window.dispatchEvent(new CustomEvent('ai-cm-restored-history',");
    expect(CONTENT_SRC).toContain("window.postMessage({ source: 'ai-cm-paste', text: String(t).slice(0, 500000) }, window.origin);");
    // ре-эмит не перепарсит снимок: emitSnapshot вызывается только из 4 прежних точек
    const calls = INTERCEPT_SRC.match(/emitSnapshot\(/g) || [];
    expect(calls.length).toBe(5); // 4 вызова + 1 объявление функции
  });
});
