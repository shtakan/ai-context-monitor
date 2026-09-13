/**
 * M-14 (v1.19.3): SPA домашняя→тред без F5 — bootstrap обязан идти по адресу с ПОЛНЫМ набором
 * query-параметров (with_parent_info / supported_block_use_cases), а не по голому /rest/thread/{slug}.
 *
 * Дефект: после SPA-перехода домашняя→тред bootstrap учил голый `/rest/thread/{slug}` и получал
 * урезанный снимок (textLen 5764, 1.4%); сниффинг собственного запроса страницы с полным набором
 * даёт textLen 11164, 2.6%. Причина: гейт M-12 отбрасывает чужие снимки ДО выучивания шаблона,
 * полный адрес с домашней больше не приезжает, а SPA-клик переиспользует кэш (нового сниффинга
 * нет до F5). Фикс M-14: в ОБЕИХ ветках отклонения гейта M-12 адрес отклонённого снимка
 * (id-сегмент → {slug}) выучивается как шаблон — только адрес, данные не эмитятся, состояние
 * (snapshotReceived/lastHistoryUrl) не трогается; REST-fallback bootstrap строится с той же
 * константой полного набора.
 *
 * Проверки:
 *   (а) SPA home→thread без F5: base/textLen равен сниффинг-эталону; пин «textLen полного набора
 *       ≠ textLen голого REST» (фикстуры не вырождены, запрошен именно полный адрес);
 *   (б) гейт M-12 прежний: снимок чужого треда не эмитится ни на домашней, ни на треде, состояние
 *       не тронуто — bootstrap всё равно идёт и попадает в СВОЙ тред;
 *   (в) REST-fallback bootstrap (шаблона нет) — тот же полный набор параметров вместо голого адреса;
 *   (г) маркеры источника + «не трогать»: латчи/backoff, M-13 settings-путь, имена файлов.
 */
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'perplexity-intercept.js'), 'utf8');

const OWN = '5fe65fcb';       // slug своего треда
const FOREIGN = 'e2ffa178';   // чужой тред из лога дефекта
const FULL_QUERY = '?with_parent_info=true&supported_block_use_cases=true';

// Фикстура «полный набор»: две записи с блоками (в бою — textLen 11164, 2.6%).
function fullThreadJson(slug) {
  return JSON.stringify({
    entries: [
      { thread_url_slug: slug, text: 'ход 1 [' + slug + '] ' + 'полный-набор '.repeat(40) },
      { thread_url_slug: slug, text: 'ход 2 [' + slug + '] ' + 'блоки '.repeat(60) },
    ],
    thread_metadata: { slug: slug },
  });
}

// Фикстура «голый REST»: тот же тред, но снимок урезан (в бою — textLen 5764, 1.4%).
function bareThreadJson(slug) {
  return JSON.stringify({
    entries: [{ thread_url_slug: slug, text: 'ход 1 [' + slug + '] урезанный' }],
    thread_metadata: { slug: slug },
  });
}

const HTML_BODY = '<!DOCTYPE html><html><body>RSC-payload</body></html>';

const PARSER = function (data) {
  const entries = (data && data.entries) || [];
  const text = entries.map(function (e) { return e.text; }).join('\n');
  return { text: text, count: entries.length, model: 'sonar', lastText: text, pieces: [text], ids: ['1'], messages: [] };
};

// Эталон сниффинга (полный набор) и контроль урезанного адреса — из тех же фикстур.
const FULL_TEXT_LEN = PARSER(JSON.parse(fullThreadJson(OWN))).text.length;
const BARE_TEXT_LEN = PARSER(JSON.parse(bareThreadJson(OWN))).text.length;

function slugOf(url) {
  const m = String(url).match(/\/(?:search|thread|rest\/thread|api\/thread)\/([^\/?#]+)/);
  return m ? m[1] : '';
}

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

/** Мок fetch: Accept=json → HTML/RSC (свежий тред); полный набор → полный снимок; иначе → урезанный. */
function defaultHandler(url, method, init) {
  const u = String(url);
  if (init.headers && init.headers.Accept === 'application/json') return okResp(HTML_BODY);
  const slug = slugOf(u) || OWN;
  return okResp(u.indexOf('with_parent_info') !== -1 ? fullThreadJson(slug) : bareThreadJson(slug));
}

// Перехватчик живёт в window и не снимается: прежние установки (прошлые тесты) при pushState
// получают смену треда и тоже ходят за снимком в СВОЙ мок. Гасим прежние моки, иначе их EMIT
// попадает в общий listener и портит счётчики событий текущего теста.
const mockRegistry = [];
const deadResp = {
  ok: false, status: 500,
  json: function () { return Promise.resolve(null); },
  text: function () { return Promise.resolve(''); },
  clone: function () { return this; },
};

function installFetch(handler) {
  mockRegistry.forEach(function (m) {
    m.mockImplementation(function () { return Promise.resolve(deadResp); });
  });
  const fetchMock = jest.fn(function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    return Promise.resolve(handler(url, method, init || {}));
  });
  mockRegistry.push(fetchMock);
  window.fetch = fetchMock;
  return fetchMock;
}

/** Установка перехватчика на странице pathname с заданным fetch-диспетчером. */
function installIntercept(pathname, handler) {
  window.history.pushState({}, '', pathname);
  window.parsePerplexityThread = PARSER;
  const fetchMock = installFetch(handler || defaultHandler);
  const events = [];
  const onHist = function (ev) { events.push(ev.detail); };
  window.addEventListener('ai-cm-full-history', onHist);
  delete window.__aiCmPerplexityInterceptInstalled;
  // eslint-disable-next-line no-eval
  eval(SRC);
  return { fetchMock: fetchMock, events: events, cleanup: function () { window.removeEventListener('ai-cm-full-history', onHist); } };
}

function sniff(url) { return window.fetch(url); }
function simulateAsk() {
  return window.fetch('https://www.perplexity.ai/rest/sse/perplexity_ask', { method: 'POST', body: '{}' });
}
const restCalls = (fetchMock, slug) => fetchMock.mock.calls.filter(function (c) {
  return String(c[0]).indexOf('/rest/thread/' + (slug || '')) !== -1;
});
const guardCalls = (fetchMock) => fetchMock.mock.calls.filter(function (c) {
  return String(c[0]).indexOf('__aicm_perplexity__=1') !== -1;
});
const hasLog = (m) => debugLogs.some(function (s) { return s.indexOf(m) !== -1; });

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
});

// ---- (а) SPA домашняя→тред без F5: bootstrap == сниффинг-эталон ----
describe('M-14 (а): SPA домашняя→тред без F5 — снимок полного набора', () => {
  test('пин фикстур: textLen полного набора ≠ textLen голого REST', () => {
    expect(FULL_TEXT_LEN).toBeGreaterThan(BARE_TEXT_LEN);
    expect(BARE_TEXT_LEN).toBeGreaterThan(0);
  });

  test('сниффинг-эталон: свой запрос страницы с полным набором → EMIT ровно FULL_TEXT_LEN', async () => {
    const ctx = installIntercept('/search/' + OWN);
    try {
      await sniff('https://www.perplexity.ai/rest/thread/' + OWN + FULL_QUERY);
      await settle();
      expect(ctx.events.length).toBe(1);
      expect(ctx.events[0].text.length).toBe(FULL_TEXT_LEN);
      expect(ctx.events[0].text.length).not.toBe(BARE_TEXT_LEN); // не урезанный снимок
    } finally { ctx.cleanup(); }
  });

  test('домашняя → отклонённый чужой снимок выучивает адрес → SPA-клик в тред → bootstrap == эталон', async () => {
    const ctx = installIntercept('/');
    try {
      // домашняя: чужой снимок ПОЛНОГО набора — гейт M-12 отклоняет (EMIT нет), но адрес выучивается
      await sniff('https://www.perplexity.ai/rest/thread/' + FOREIGN + FULL_QUERY);
      await settle();
      expect(ctx.events.length).toBe(0);
      expect(hasLog('нет slug страницы — не тред')).toBe(true);
      expect(hasLog('шаблон выучен из URL отклонённого снимка')).toBe(true);
      expect(hasLog('rest/thread/{slug}' + FULL_QUERY)).toBe(true); // шаблон — с полным набором

      // SPA-клик (без F5): pushState домашняя → /search/<свой slug>
      window.history.pushState({}, '', '/search/' + OWN);
      await settle();
      jest.advanceTimersByTime(1500); // bootstrap-таймер смены треда
      await settle();

      // bootstrap ушёл по выученному адресу полного набора и попал в СВОЙ тред
      const boot = restCalls(ctx.fetchMock, OWN);
      expect(boot.length).toBe(1);
      expect(String(boot[0][0])).toContain('with_parent_info=true');
      expect(String(boot[0][0])).toContain('supported_block_use_cases=true');
      expect(String(boot[0][0])).toContain(OWN);
      expect(String(boot[0][0])).not.toContain(FOREIGN);

      expect(ctx.events.length).toBe(1);
      expect(ctx.events[0].text.length).toBe(FULL_TEXT_LEN);  // == сниффинг-эталон
      expect(ctx.events[0].text.length).not.toBe(BARE_TEXT_LEN);
      expect(ctx.events[0].text).toContain(OWN);
      expect(consoleLines.some(function (m) { return m.indexOf('полный снимок (bootstrap)') !== -1; })).toBe(true);
    } finally { ctx.cleanup(); }
  });
});

// ---- (б) гейт M-12 прежний: чужой снимок не эмитится, состояние не тронуто ----
describe('M-14 (б): гейт M-12 прежний — чужой снимок не эмитится (даже с полным набором)', () => {
  test('тред: чужой снимок полного набора → 0 EMIT + лог «чужой снимок», шаблон выучен', async () => {
    const ctx = installIntercept('/search/' + OWN);
    try {
      await sniff('https://www.perplexity.ai/rest/thread/' + FOREIGN + FULL_QUERY);
      await settle();
      expect(ctx.events.length).toBe(0);
      expect(hasLog('чужой снимок (slug=' + FOREIGN + ' != slug страницы ' + OWN + ')')).toBe(true);
      expect(hasLog('шаблон выучен из URL отклонённого снимка')).toBe(true);
    } finally { ctx.cleanup(); }
  });

  test('состояние не тронуто: после отклонённого чужого снимка bootstrap идёт и берёт СВОЙ тред', async () => {
    const ctx = installIntercept('/search/' + OWN);
    try {
      await sniff('https://www.perplexity.ai/rest/thread/' + FOREIGN + FULL_QUERY);
      await settle();
      expect(ctx.events.length).toBe(0);

      jest.advanceTimersByTime(1500); // стартовый bootstrap-таймер: snapshotReceived остался false
      await settle();

      expect(ctx.events.length).toBe(1);                       // эмит только своего треда
      expect(ctx.events[0].text).toContain(OWN);
      expect(ctx.events[0].text).not.toContain(FOREIGN);
      expect(ctx.events[0].text.length).toBe(FULL_TEXT_LEN);   // и только в полном наборе
      const boot = restCalls(ctx.fetchMock, OWN);
      expect(boot.length).toBe(1);
      expect(String(boot[0][0])).toContain(FULL_QUERY);
    } finally { ctx.cleanup(); }
  });

  test('виртуальный F5 по выученному шаблону: guard-адрес с полным набором → снимок своего треда', async () => {
    const ctx = installIntercept('/search/' + OWN);
    try {
      await sniff('https://www.perplexity.ai/rest/thread/' + FOREIGN + FULL_QUERY);
      await settle();
      expect(ctx.events.length).toBe(0);

      await simulateAsk();
      await settle();
      jest.advanceTimersByTime(800); // scheduleActive после стрима
      await settle();

      const guards = guardCalls(ctx.fetchMock);
      expect(guards.length).toBe(1);
      expect(String(guards[0][0])).toContain('/rest/thread/' + OWN);
      expect(String(guards[0][0])).toContain('with_parent_info=true');
      expect(ctx.events.length).toBe(1);
      expect(ctx.events[0].text).toContain(OWN);
      expect(ctx.events[0].text.length).toBe(FULL_TEXT_LEN);
    } finally { ctx.cleanup(); }
  });

  test('чужой снимок БЕЗ полного набора адрес не учит (голый /rest/thread/{slug} шаблоном не становится)', async () => {
    const ctx = installIntercept('/');
    try {
      await sniff('https://www.perplexity.ai/rest/thread/' + FOREIGN);
      await settle();
      expect(ctx.events.length).toBe(0);
      expect(hasLog('шаблон выучен из URL отклонённого снимка')).toBe(false);
      expect(hasLog('rest/thread/{slug}?')).toBe(false);
    } finally { ctx.cleanup(); }
  });
});

// ---- (в) REST-fallback bootstrap: полный набор параметров вместо голого адреса ----
describe('M-14 (в): REST-fallback bootstrap — та же константа полного набора', () => {
  test('Accept=json отдал HTML → fallback идёт по адресу с полным набором (голого адреса нет)', async () => {
    const ctx = installIntercept('/search/' + OWN);
    try {
      jest.advanceTimersByTime(1500); // стартовый bootstrap-таймер
      await settle();

      const full = ctx.fetchMock.mock.calls.filter(function (c) {
        return String(c[0]) === location.origin + '/rest/thread/' + OWN + FULL_QUERY;
      });
      expect(full.length).toBe(1);                                   // ровно полный адрес
      const bare = ctx.fetchMock.mock.calls.filter(function (c) {
        return String(c[0]).indexOf('/rest/thread/' + OWN) !== -1 && String(c[0]).indexOf('with_parent_info') === -1;
      });
      expect(bare.length).toBe(0);                                   // голого /rest/thread/{slug} больше нет

      expect(ctx.events.length).toBe(1);
      expect(ctx.events[0].text.length).toBe(FULL_TEXT_LEN);         // снимок целиком, не урезанный
      expect(ctx.events[0].text.length).not.toBe(BARE_TEXT_LEN);
      expect(hasLog('bootstrap: REST-fallback (' + location.origin + '/rest/thread/' + OWN + FULL_QUERY + ')')).toBe(true);

      // после успеха адрес выучен шаблоном (дальше vf5 не деградирует до голого REST)
      await simulateAsk();
      await settle();
      jest.advanceTimersByTime(800);
      await settle();
      const guards = guardCalls(ctx.fetchMock);
      expect(guards.length).toBe(1);
      expect(String(guards[0][0])).toContain(FULL_QUERY);
    } finally { ctx.cleanup(); }
  });
});

// ---- (г) источник: маркеры M-14 + «не трогать» ----
describe('M-14 (г): маркеры источника и неприкосновенные пути', () => {
  const read = function (rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); };

  test('выучивание шаблона стоит в ОБЕИХ ветках отклонения гейта M-12, до return', () => {
    const calls = SRC.match(/learnTemplateFromRejectedUrl\(url\); \/\/ M-14/g) || [];
    expect(calls.length).toBe(2);
    expect(SRC).toContain('var FULL_HISTORY_QUERY = \'?with_parent_info=true&supported_block_use_cases=true\';');
    expect(SRC).toContain("location.origin + '/rest/thread/' + currentConvId + FULL_HISTORY_QUERY");
    expect(SRC).toContain('if (historyUrlTemplate) return false;'); // уже выученный шаблон не перетираем
    // гейт M-12 жив ровно в одной точке и не расширен
    expect(SRC.match(/снимок не эмитим/g).length).toBe(1);
    expect(SRC).toContain("if (!currentConvId) { debugLog('log', '[perplexity-intercept] bootstrap: нет slug — не тред'); return; }");
  });

  test('латчи и backoff не тронуты', () => {
    expect(SRC).toContain('if (bootstrapAcceptJsonRetryCount >= 3) {');
    expect(SRC).toContain('activeRetryDelay = Math.min(activeRetryDelay * 2, 120000);');
    expect(SRC).toContain("var guardToken = '__aicm_perplexity__';");
    expect(SRC).toContain('function scheduleActiveRetry()');
  });

  test('M-13 settings-путь и остальные адаптеры не тронуты, имена файлов прежние', () => {
    expect(read('options/options.js')).toContain('// v1.19.2 (M-13a)');
    expect(read('core/content.js')).toContain('флаг enabled отсутствует — автоэкспорт выключен');
    expect(read('core/page-intercept.js')).toContain('if (expectedConvId && expectedConvId !== currentConvId) {');
    expect(read('core/deepseek-intercept.js')).toContain('if (resp && resp.ok && guardCheck(historyConvId)) {');
    ['core/perplexity-intercept.js', 'utils/perplexity-parser.js', 'tests/perplexity-sniff-slug-gate-m12.test.js']
      .forEach(function (rel) { expect(fs.existsSync(path.join(__dirname, '..', rel))).toBe(true); });
  });
});
