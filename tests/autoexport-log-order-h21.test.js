/**
 * H21: исторический пин порядка логов автоэкспорта — «fired» ДО «skip reason=already-fired»;
 * дубль файла при F5 устранён хотфиксом F5 (Аппендикс v38).
 *
 * Живое наблюдение (2026-09-09): в логе «skip reason=already-fired» стоял РАНЬШЕ
 * «base-complete trigger» и «fired», хотя fired в этом событии ещё не было.
 * Разбор: в одном loader-stop событии сначала идёт re-check после стопа лоадера
 * (content.js ~2442), чей пороговый гейт видит КРОСС-ТАБОВЫЙ session-латч
 * (isFiredInSession, chrome.storage.session) и пишет already-fired; затем блок
 * base-complete trigger (~2462), чей гейт читал ТОЛЬКО in-memory autoExportFired
 * и потому всё равно стрелял → «base-complete trigger» + «fired». Порядок строк
 * лога при этом инвертирован — это и пинится как исторический факт.
 *
 * Функционал (дубль при F5) был НЕКОРРЕКТЕН: in-memory латч сбрасывается F5,
 * session-латч жив, но гейт base-complete триггера его не спрашивал → второй файл
 * с суффиксом «-base-complete» (дефект Аппендикса v38, узаконенный 09.09.2026).
 * Хотфикс F5 (v38, core/export-manager.js:1822-1829): гейт триггера спрашивает те
 * же ТРИ латча (in-memory + session + once), что и пороговый путь — дубля нет.
 * Поэтому в session-latched кейсе фикстуры «base-complete trigger»/«fired» от
 * триггера больше не появляются: файр один, порядок H21 сохранён.
 *
 * Поэтому фикс — фиксация инварианта (порядок триггеров/логов не меняется):
 *   (а) каноническая сессия (свежий чат): fired стоит ДО already-fired;
 *   (б) session-latched сессия: инверсия задокументирована, дубль устранён F5 —
 *       триггер не стреляет (skip reason=already-fired без последующего fired).
 */

const fs = require('fs');
const path = require('path');

// v2.0 (этап 1/3): исходник контент-скрипта — модули + content.js в порядке manifest.json
const CORE = require('./helpers/content-source.js').contentSource;
const FIXTURE = path.join(__dirname, 'fixtures', 'autoexport-log-order-h21.txt');

const FIRED = '[AI CM][auto-export] fired convId=';
const ALREADY = '[AI CM][auto-export] skip reason=already-fired';
const TRIGGER = '[AI CM][auto-export] base-complete trigger convId=';

function fixtureSections() {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/);
  const out = { canonical: [], 'session-latched': [] };
  let cur = null;
  lines.forEach(function (line) {
    const m = /^#\s*---\s*case=([a-z-]+)/.exec(line);
    if (m) { cur = m[1]; return; }
    if (line.startsWith('#')) return;
    if (cur && line.trim()) out[cur].push(line);
  });
  return out;
}

describe('H21: fixture-сессия логов — fired ДО already-fired', () => {
  const sections = fixtureSections();

  test('каноническая сессия (свежий чат): fired РАНЬШЕ already-fired', () => {
    const log = sections.canonical.join('\n');
    const iFired = log.indexOf(FIRED);
    const iAlready = log.indexOf(ALREADY);
    expect(iFired).toBeGreaterThanOrEqual(0);
    expect(iAlready).toBeGreaterThanOrEqual(0);
    expect(iFired).toBeLessThan(iAlready);          // главный пин H21
    // ровно один файл: одна строка fired, ни одной уже-fired-до него
    expect(sections.canonical.filter(function (l) { return l.indexOf(FIRED) === 0; })).toHaveLength(1);
    expect(sections.canonical.filter(function (l) { return l.indexOf(ALREADY) === 0; })).toHaveLength(1);
    // в свежей сессии base-complete trigger не стреляет (латч уже стоит) — прежнее поведение
    expect(log).not.toContain(TRIGGER);
  });

  test('session-latched сессия: инверсия задокументирована; хотфикс F5 — дубля нет, триггер не стреляет', () => {
    const log = sections['session-latched'].join('\n');
    const iFired = log.indexOf(FIRED);
    const iAlready = log.indexOf(ALREADY);
    const iTrigger = log.indexOf(TRIGGER);
    // исторический пин H21: пороговый гейт (session-латч) логируется РАНЬШЕ блока триггера
    expect(iAlready).toBeGreaterThanOrEqual(0);
    // хотфикс F5 (v38): при живом session-латче base-complete trigger НЕ срабатывает —
    // строки «base-complete trigger» и «fired» от триггера в логе отсутствуют вовсе
    expect(iTrigger).toBe(-1);
    expect(iFired).toBe(-1);
    expect(iTrigger).toBeLessThan(iAlready);        // порядок H21 сохранён (исторический факт)
    // дубля файла с суффиксом -base-complete больше нет (дефект Аппендикса v38 устранён)
    expect(log).not.toContain('-base-complete');
    expect(sections['session-latched'].filter(function (l) { return l.indexOf(FIRED) === 0; })).toHaveLength(0);
    expect(sections['session-latched'].filter(function (l) { return l.indexOf(ALREADY) === 0; })).toHaveLength(1);
  });
});

describe('H21: пин порядка в core/content.js', () => {
  const src = CORE;

  test('латч fired пишется и логируется ДО любого последующего already-fired', () => {
    // (1) в doAutoExportDownload: сначала markAutoExportFired (+ session-латч), затем лог fired
    // Шаг A.1 (security): запись session-латча ушла из вкладки в SW — пин смотрит на
    // SW-канал aiCmLatchSet (прямой chrome.storage.session из контент-скрипта убран).
    const iMark = src.indexOf('PDl.markAutoExportFired(autoExportFired,');
    const iSessionPatch = src.indexOf('aiCmLatchSet(siteO3, cid);');
    const iFiredLog = src.indexOf("'[AI CM][auto-export] fired convId='");
    expect(iMark).toBeGreaterThanOrEqual(0);
    expect(iSessionPatch).toBeGreaterThan(iMark);
    expect(iFiredLog).toBeGreaterThan(iSessionPatch);
  });

  test('строка already-fired в пороговом пути стоит в исходнике РАНЬШЕ base-complete trigger', () => {
    // та же последовательность, что и в логе: сначала maybeAutoExport (session-латч),
    // затем блок base-complete trigger
    const iAlready = src.indexOf("debugLog('log', '[AI CM][auto-export] skip reason=already-fired convId=' + cid);");
    const iTriggerLog = src.indexOf("debugLog('log', '[AI CM][auto-export] base-complete trigger convId=' + cid +");
    expect(iAlready).toBeGreaterThanOrEqual(0);
    expect(iTriggerLog).toBeGreaterThan(iAlready);
  });

  test('асимметрия латчей зафиксирована комментарием H21 (гейты не тронуты)', () => {
    expect(src).toContain('H21 (порядок логов инвертирован, функционал корректен — гейты не менялись)');
    expect(src).toContain('Пин порядка логов: tests/autoexport-log-order-h21.test.js.');
    // пороговый путь: in-memory ИЛИ session-латч
    expect(src).toContain('P.isFiredInSession(sessionFiredCache, siteName, cid)');
    // хотфикс F5 (v38): base-complete гейт — дизъюнкция ТРЁХ латчей, тождественная пороговому
    // пути (in-memory ИЛИ session ИЛИ once). До хотфикса гейт читал ТОЛЬКО in-memory латч —
    // при F5 in-memory сброшен, но session-латч жив → дубль «-base-complete» (falsified
    // приёмка 13.2: step-13.2-artifacts.md:103 ложно заявила «повторный экспорт запрещён» —
    // дубль происходил; после хотфикса F5 — устранён).
    expect(src).toContain('F5 (v38): base-complete триггер — дизъюнкция трёх латчей, тождественная пороговому пути');
    expect(src).toContain('return Pbc.getAutoExportFired(autoExportFired, siteBc, cid) ||');
    expect(src).toContain('Pbc.isFiredInSession(sessionFiredCache, siteBc, cid)');
    expect(src).toContain('aiCmAutoExportFiredOnce[siteBc + \'|\' + cid] === 1');
    // автоэкспорт-гейты и триггеры не изменены
    expect(src).toContain('function maybeAutoExport(');
    expect(src).toContain('shouldSkipAutoExport');
    expect(src).toContain("doAutoExportDownload(cid, pctBc64, 'base-complete');");
    expect(src).toContain('doAutoExportDownload(cid, percentage, \'threshold\');');
  });

  test('поведенческий пин латча: после fired следующий гейт даёт already-fired', () => {
    const P = require('../utils/export-emit-pipeline.js');
    const store = {};
    // fired-путь: латч ставится, затем пишется лог fired
    P.markAutoExportFired(store, 'gemini', 'e292103e4b521dae');
    expect(P.getAutoExportFired(store, 'gemini', 'e292103e4b521dae')).toBe(true);
    // последующий re-check того же чата → already-fired (значит fired был РАНЬШЕ)
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 91.2, threshold: 90,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'gemini', 'e292103e4b521dae'), isGemini: true
    })).toEqual({ skip: true, reason: 'already-fired', resetFired: false });
    // и кросс-табовый session-патч даёт тот же вердикт во второй вкладке
    const patch = P.sessionFiredPatch('gemini', 'e292103e4b521dae');
    expect(P.isFiredInSession(patch, 'gemini', 'e292103e4b521dae')).toBe(true);
    expect(P.isFiredInSession(patch, 'chatgpt', 'e292103e4b521dae')).toBe(false);
  });
});
