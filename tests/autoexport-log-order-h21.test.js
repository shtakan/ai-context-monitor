/**
 * H21: порядок логов автоэкспорта — «fired» ДО «skip reason=already-fired».
 *
 * Живое наблюдение (2026-09-09): в логе «skip reason=already-fired» стоял РАНЬШЕ
 * «base-complete trigger» и «fired», хотя fired в этом событии ещё не было.
 * Разбор: в одном loader-stop событии сначала идёт re-check после стопа лоадера
 * (content.js ~2442), чей пороговый гейт видит КРОСС-ТАБОВЫЙ session-латч
 * (isFiredInSession, chrome.storage.session) и пишет already-fired; затем блок
 * base-complete trigger (~2462), чей гейт читает ТОЛЬКО in-memory autoExportFired
 * и потому всё равно стреляет → «base-complete trigger» + «fired». Итог корректен
 * (ровно один файл), инверсия — только в порядке строк лога.
 *
 * Поэтому фикс — фиксация инварианта (гейты/порядок триггеров не меняются):
 *   (а) каноническая сессия (свежий чат): fired стоит ДО already-fired;
 *   (б) session-latched сессия: инверсия задокументирована, fired по-прежнему один.
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

  test('session-latched сессия: инверсия задокументирована, файл всё равно один', () => {
    const log = sections['session-latched'].join('\n');
    expect(log.indexOf(ALREADY)).toBeLessThan(log.indexOf(FIRED)); // наблюдаемая аномалия
    expect(log).toContain(TRIGGER);
    expect(sections['session-latched'].filter(function (l) { return l.indexOf(FIRED) === 0; })).toHaveLength(1);
  });
});

describe('H21: пин порядка в core/content.js', () => {
  const src = CORE;

  test('латч fired пишется и логируется ДО любого последующего already-fired', () => {
    // (1) в doAutoExportDownload: сначала markAutoExportFired (+ session-патч), затем лог fired
    const iMark = src.indexOf('PDl.markAutoExportFired(autoExportFired,');
    const iSessionPatch = src.indexOf('chrome.storage.session.set(PDl.sessionFiredPatch(siteO3, cid));');
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
    // base-complete гейт: только in-memory (это и есть причина инверсии)
    expect(src).toContain('return Pbc.getAutoExportFired(autoExportFired, (currentAdapter && currentAdapter.siteName) || \'\', cid);');
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
