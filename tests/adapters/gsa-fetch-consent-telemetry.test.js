/**
 * Наблюдение (ii) живой приёмки GSA 2026-09-26 11:27–11:34 — телеметрия consent-редиректа
 * на fetch-ответе folwr/folif (семья O-27).
 *
 * ИЗМЕРЕНО (живая приёмка 11:27–11:34): наш fetch folwr упёрся в CORS/303 consent-редирект
 * Google — гарды O-27/O-31/O-32 выстояли (мусорного экспорта и краша нет), НО событие было
 * НЕВИДИМО в логах: ни одной диаг-строки о редиректе. Повторное измерение 2026-09-27
 * 19:05–19:07 воспроизведения не дало (consent-состояние Google уже сохранено в cookies;
 * маркеры consent/redirect/fetch/telemetry/O-27 = 0 совпадений), поэтому граница приёмки —
 * как у O-27 captcha: воспроизведение по требованию невозможно, верификация при СЛЕДУЮЩЕМ
 * естественном срабатывании.
 *
 * ЧТО ЗДЕСЬ УДОСТОВЕРЯЕТСЯ (пины):
 *   D1 response.redirected=true → диаг-строка `gsa-fetch-telemetry`, verdict=consent-redirect-candidate;
 *   D2 response.type='opaqueredirect' → строка есть, verdict=consent-redirect-candidate;
 *   D3 status=303 → строка есть, verdict=consent-redirect-candidate;
 *   D4 status=200/redirected=false/type='basic' → строка есть, verdict=normal;
 *   R1 гейт aiCmDebug выключен → НИ ОДНОЙ диаг-строки; хелперов диагностики нет →
 *      typeof-гард: ни строки, ни исключения;
 *   R2 байты txt-снимка при гейте вкл/выкл идентичны (регресс O-27/O-31/O-32);
 *   S1 source-пин: строка печатается ровно ПОСЛЕ получения response и ДО чтения тела
 *      (resp.clone().text()), внутри блока folwr/folif; поля и вердикт — по контракту.
 *
 * Стенд: РЕАЛЬНЫЙ файл core/google-search-intercept.js + РЕАЛЬНЫЕ utils/debug.js,
 * utils/google-search-folwr-parser.js и utils/intercept-common.js в jsdom — порядок и
 * способ загрузки ровно как в core/background.js:155 (MAIN-мир, классические скрипты в
 * одном глобальном скоупе; поэтому исходники исполняются непрямым eval, а не new Function).
 * «Сервер» — подменённый window.fetch; диаг-строки ловятся на console.log.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const PARSER_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'google-search-folwr-parser.js'), 'utf8');
const COMMON_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'intercept-common.js'), 'utf8');
// Живой артефакт базы GSA (4 сообщения / 2 хода, threadId SYNTHETIC-THREAD-1).
const FIXTURE = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'google-folwr-open.html'), 'utf8');

const TID = 'SYNTHETIC-THREAD-1';
const DIAG_PREFIX = '[AI CM][diag]';
const TELEMETRY = DIAG_PREFIX + ' gsa-fetch-telemetry';
// Детектор перехватчика — литеральные подстроки '/folwr' и '/folif' (не '/async/folwr',
// иначе это блок активной загрузки open и телеметрия folwr/folif не печатается).
const URL_FOLWR = 'https://www.google.com/search?udm=50&src=/folwr';
const URL_FOLIF = 'https://www.google.com/search?udm=50&src=/folif';
// Конечный хост после consent-редиректа (response.url — именно КОНЕЧНЫЙ URL).
const CONSENT_HOST = 'consent.google.com';

// ---------- стенд ----------
// Непрямой eval: исходники расширения — классические скрипты одного MAIN-мира, их
// top-level function-декларации (aiCmDiagLine/aiCmDiagOn, parseGoogleFolwrOpen) обязаны
// стать глобальными — `new Function(src)()` сделал бы их локальными и typeof-гард молчал бы.
function loadGlobal(src) { (0, eval)(src); }

function makeResponse(opts) {
  const o = opts || {};
  const body = (o.body === undefined) ? '' : o.body;
  return {
    ok: o.ok !== false,
    status: (o.status === undefined) ? 200 : o.status,
    redirected: o.redirected === true,
    type: o.type || 'basic',
    url: o.url || URL_FOLWR,
    clone: function () { return this; },
    text: function () { return Promise.resolve(body); }
  };
}

function installStand(opts) {
  const o = opts || {};
  // Свежий перехватчик на стенд (в браузере латч ставится один раз).
  delete window.__aiCmGoogleSearchInterceptInstalled;
  document.body.innerHTML =
    '<div data-session-thread-id="' + TID + '" style="display:none"></div>';

  const logs = [];
  jest.spyOn(console, 'log').mockImplementation(function (m) { logs.push(String(m)); });
  jest.spyOn(console, 'warn').mockImplementation(function () { });

  // Порядок core/background.js:155: debug.js → парсер → intercept-common → перехватчик.
  loadGlobal(DEBUG_SRC);
  loadGlobal(PARSER_SRC);
  loadGlobal(COMMON_SRC);

  const events = [];
  window.addEventListener('ai-cm-full-history', function (ev) { events.push(ev.detail); });

  const calls = [];
  window.fetch = function (input) {
    const url = String((typeof input === 'string') ? input : (input && input.url) || '');
    calls.push(url);
    const spec = Object.assign({ url: url }, o.response || {});
    return Promise.resolve(makeResponse(spec));
  };

  loadGlobal(INTERCEPT_SRC);
  return {
    logs: logs,
    events: events,
    calls: calls,
    telemetry: function () {
      return logs.filter(function (l) { return l.indexOf(TELEMETRY) === 0; });
    }
  };
}

// Прокачка цепочки fetch → then → clone().text() → mergeTurns → emitDetail.
async function settle(rounds) {
  for (let i = 0; i < (rounds || 8); i++) {
    await Promise.resolve();
    await new Promise(function (r) { setTimeout(r, 0); });
  }
}

function fetchUrl(url) {
  return window.fetch(url, { method: 'GET' });
}

beforeEach(function () {
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
  window.__aiCmDebugLogs = false;
});

afterEach(function () {
  jest.restoreAllMocks();
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
  window.__aiCmDebugLogs = false;
});

// =====================================================================================
// D1–D4: строка печатается под гейтом и называет вердикт по трём признакам редиректа
// =====================================================================================
describe('GSA consent-редирект (D1–D4): телеметрия fetch под гейтом aiCmDebug', function () {
  test('D1: response.redirected=true → verdict=consent-redirect-candidate, поля на месте', async function () {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = installStand({ response: { redirected: true, status: 200, type: 'basic', url: 'https://' + CONSENT_HOST + '/m?continue=x' } });
    await fetchUrl(URL_FOLWR);
    await settle();

    const lines = st.telemetry();
    expect(lines).toHaveLength(1);
    const l = lines[0];
    expect(l).toContain('point=folwr');
    expect(l).toContain('threadId=' + TID);
    expect(l).toContain('redirected=true');
    expect(l).toContain('status=200');
    expect(l).toContain('type=basic');
    expect(l).toContain('finalUrlHost=' + CONSENT_HOST);
    expect(l).toContain('verdict=consent-redirect-candidate');
    // ответ отдан странице КАК ЕСТЬ (read-only телеметрия)
    expect(st.calls).toEqual([URL_FOLWR]);
  });

  test('D2: response.type=opaqueredirect → verdict=consent-redirect-candidate', async function () {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = installStand({ response: { redirected: false, status: 0, ok: false, type: 'opaqueredirect', url: URL_FOLWR } });
    await fetchUrl(URL_FOLIF);
    await settle();

    const lines = st.telemetry();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('point=folif');
    expect(lines[0]).toContain('redirected=false');
    expect(lines[0]).toContain('status=0');
    expect(lines[0]).toContain('type=opaqueredirect');
    expect(lines[0]).toContain('verdict=consent-redirect-candidate');
  });

  test('D3: status=303 → verdict=consent-redirect-candidate', async function () {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = installStand({ response: { redirected: false, status: 303, ok: false, type: 'basic', url: URL_FOLWR } });
    await fetchUrl(URL_FOLWR);
    await settle();

    const lines = st.telemetry();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('status=303');
    expect(lines[0]).toContain('redirected=false');
    expect(lines[0]).toContain('type=basic');
    expect(lines[0]).toContain('verdict=consent-redirect-candidate');
  });

  test('D4: status=200/redirected=false/type=basic → verdict=normal', async function () {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = installStand({ response: { body: FIXTURE, redirected: false, status: 200, type: 'basic', url: URL_FOLWR } });
    await fetchUrl(URL_FOLWR);
    await settle();

    const lines = st.telemetry();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('redirected=false');
    expect(lines[0]).toContain('status=200');
    expect(lines[0]).toContain('type=basic');
    expect(lines[0]).toContain('finalUrlHost=www.google.com');
    expect(lines[0]).toContain('verdict=normal');
    // антипод: вердикт не «липнет» к нормальному ответу
    expect(lines[0]).not.toContain('consent-redirect-candidate');
  });
});

// =====================================================================================
// R1: гейт выключен → ни одной строки; хелперов нет → typeof-гард
// =====================================================================================
describe('GSA consent-редирект (R1): гейт aiCmDebug и typeof-гард', function () {
  test('гейт выключен → ни одной диаг-строки, fetch-путь работает как прежде', async function () {
    const st = installStand({ response: { redirected: true, status: 200, url: 'https://' + CONSENT_HOST + '/m' } });
    const resp = await fetchUrl(URL_FOLWR);
    await settle();

    expect(resp).toBeTruthy();
    expect(st.telemetry()).toEqual([]);
    expect(st.logs.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; })).toEqual([]);
    expect(st.calls).toEqual([URL_FOLWR]);
  });

  test('хелперов диагностики нет → ни строки, ни исключения (typeof-гард)', async function () {
    // Как в срез-песочницах: канонические хелперы не загружены (MAIN-мир без debug.js).
    delete window.aiCmDiagLine;
    delete window.aiCmDiagOn;
    const st = installStand({ response: { redirected: true, status: 200, url: 'https://' + CONSENT_HOST + '/m' } });
    await expect(fetchUrl(URL_FOLWR)).resolves.toBeTruthy();
    await settle();
    expect(st.telemetry()).toEqual([]);
    expect(st.logs.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; })).toEqual([]);
  });
});

// =====================================================================================
// R2: байты txt-снимка при гейте вкл/выкл идентичны (регресс O-27/O-31/O-32)
// =====================================================================================
describe('GSA consent-редирект (R2): телеметрия не меняет байты снимка', function () {
  test('снимок ai-cm-full-history байтово тот же с гейтом и без', async function () {
    const off = installStand({ response: { body: FIXTURE, redirected: false, status: 200, url: URL_FOLWR } });
    await fetchUrl(URL_FOLWR);
    await settle(12);
    expect(off.events).toHaveLength(1);
    const offBytes = JSON.stringify(off.events[0]);
    jest.restoreAllMocks();

    sessionStorage.setItem('aiCmDebug', '1');
    const on = installStand({ response: { body: FIXTURE, redirected: false, status: 200, url: URL_FOLWR } });
    await fetchUrl(URL_FOLWR);
    await settle(12);
    expect(on.events).toHaveLength(1);
    const onBytes = JSON.stringify(on.events[0]);

    expect(on.telemetry()).toHaveLength(1);          // гейт действительно включён
    expect(onBytes).toBe(offBytes);                  // байты снимка не зависят от диагностики
    expect(on.events[0].text).toBe(off.events[0].text);
    expect(on.events[0].threadId).toBe(TID);
    // O-31/O-32: разговор и канонические ходы те же
    expect(on.events[0].count).toBe(off.events[0].count);
    expect(on.events[0].messages.length).toBe(off.events[0].messages.length);
  });
});

// =====================================================================================
// S1: source-пин точки вставки и контракта полей
// =====================================================================================
describe('GSA consent-редирект (S1): source-пин точки и контракта', function () {
  test('строка печатается после получения response и ДО чтения тела', function () {
    const wrapAt = INTERCEPT_SRC.indexOf('window.fetch = function (input, init)');
    const diagAt = INTERCEPT_SRC.indexOf("aiCmDiagLine('gsa-fetch-telemetry'");
    const cloneAt = INTERCEPT_SRC.indexOf('resp.clone().text()', diagAt);
    expect(wrapAt).toBeGreaterThan(-1);
    expect(diagAt).toBeGreaterThan(wrapAt);
    expect(cloneAt).toBeGreaterThan(diagAt);

    // блок пассивного folwr/folif, а не ветка открытия /async/folwr
    const blockAt = INTERCEPT_SRC.lastIndexOf('(isFolwr || isFolif) && !isOpenFolwr', diagAt);
    const thenAt = INTERCEPT_SRC.lastIndexOf('promise.then(function (resp) {', diagAt);
    expect(blockAt).toBeGreaterThan(-1);
    expect(thenAt).toBeGreaterThan(blockAt);
    expect(thenAt).toBeLessThan(diagAt);

    // строка стоит ДО ветки разбора тела (resp.ok) — редирект виден и без тела
    const okAt = INTERCEPT_SRC.indexOf('if (resp && resp.ok) {', diagAt);
    expect(okAt).toBeGreaterThan(diagAt);

    // typeof-гард + гейт: без хелпера строки нет, поведение прежнее
    const guardAt = INTERCEPT_SRC.lastIndexOf("if (typeof aiCmDiagLine === 'function' && aiCmDiagOn())", diagAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(diagAt);
  });

  test('контракт полей и признаков вердикта зафиксирован в исходнике', function () {
    const diagAt = INTERCEPT_SRC.indexOf("aiCmDiagLine('gsa-fetch-telemetry'");
    const call = INTERCEPT_SRC.slice(diagAt, INTERCEPT_SRC.indexOf('});', diagAt));
    ['point:', 'threadId:', 'redirected:', 'status:', 'type:', 'finalUrlHost:', 'verdict:']
      .forEach(function (f) { expect(call).toContain(f); });
    expect(call).toContain("(fetchRedirected === true || fetchType === 'opaqueredirect' || fetchStatus === 303)");
    expect(call).toContain("'consent-redirect-candidate'");
    expect(call).toContain("'normal'");
    // host конечного URL вычисляется из response.url ДО печати строки (гарантированно без
    // исключения: try/catch + фолбэк на URL запроса, если response.url пуст)
    const preludeAt = INTERCEPT_SRC.lastIndexOf('var fetchFinalUrl =', diagAt);
    expect(preludeAt).toBeGreaterThan(-1);
    expect(preludeAt).toBeLessThan(diagAt);
    expect(INTERCEPT_SRC.slice(preludeAt, diagAt)).toContain('new URL(fetchFinalUrl).host');
    // point называет ровно две точки контракта
    expect(call).toContain("point: isFull ? 'folwr' : 'folif'");
    // строка печатается ровно один раз (одна точка вставки)
    expect(INTERCEPT_SRC.split("aiCmDiagLine('gsa-fetch-telemetry'").length - 1).toBe(1);
  });
});
