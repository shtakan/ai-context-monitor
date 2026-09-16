/**
 * O-27/O-32 (диагностика, режим ИЗМЕРЕНИЯ): пин инструментирования точек скачивания,
 * точек записи базы GSA и точек сброса состояния.
 *
 * Контракт, который здесь удостоверяется:
 *   1. все новые строки живут ТОЛЬКО под гейтом aiCmDebug (sessionStorage 'aiCmDebug'
 *      === '1' ИЛИ чекбокс «Подробные логи» → window.__aiCmDebugLogs): при выключенном
 *      флаге — ни одной строки `[AI CM][diag]`;
 *   2. поведение и байты экспорта прежние: downloadBlob отдаёт в Blob РОВНО тот content,
 *      что получил (сравнение содержимого blob при включённом и выключенном гейте);
 *      писатели базы GSA в песочнице дают байтово тот же снимок с гейтом и без;
 *   3. точки покрыты: download (autoexport / Ctrl+Shift+D / options / print-pdf) и
 *      gsa-base-write (open / pagination / probe / XHR / passive-folif-чанк) + gsa-state
 *      (сброс/несброс с типом документа captcha/чат/поиск);
 *   4. гейты и валидаторы не тронуты: `maybeAutoExport` по-прежнему зовёт чистый
 *      shouldSkipAutoExport, в export-manager.js ровно один вызов downloadBlob, у GSA
 *      нет собственного скачивания (ни createObjectURL, ни a.download).
 *   5. O-27 (защитный фикс): в ЕДИНСТВЕННОЙ точке скачивания (downloadBlob) отказ по форме
 *      мусора/пустому имени — отказ есть поведение (файл не выдаётся), а строка
 *      `[AI CM][diag] download-blocked reason=…` печатается только под гейтом aiCmDebug
 *      (канонический хелпер utils/debug.js: aiCmDiagDownloadBlocked).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const BUILDERS_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const PRINT_SRC = fs.readFileSync(path.join(ROOT, 'print', 'print.js'), 'utf8');
const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const CONTENT = require('./helpers/content-source.js').contentSource;

const Parser = require('../utils/google-search-folwr-parser.js');

// Рез по балансу фигурных скобок (как в tests/gsa-o27-captcha-base-guard.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

const DIAG_PREFIX = '[AI CM][diag]';
const CAPTCHA_BODY = ')]}\' [""]';
// Живой артефакт O-27: `f.txt` = XSSI-префикс Google (4 символа) + перевод строки +
// пустой payload `[""]` + перевод строки.
const F_TXT = ")]}'\n[\"\"]\n";

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}
const TURNS_A = [
  turn('a1', 'Вопрос A1', 'Ответ A1'),
  turn('a2', 'Вопрос A2', 'Ответ A2'),
  turn('a3', 'Вопрос A3', 'Ответ A3'),
  turn('a4', 'Вопрос A4', 'Ответ A4')
];

// =====================================================================================
// (1) Точка скачивания downloadBlob (попуп/options + автоэкспорт): гейт и байты
// =====================================================================================
describe('O-27/O-32: downloadBlob — гейт aiCmDebug, поля строки и неизменные байты', () => {
  let logs;
  let blobs;

  beforeEach(() => {
    jest.resetModules();
    logs = [];
    blobs = [];
    jest.spyOn(console, 'log').mockImplementation(function (m) { logs.push(String(m)); });
    global.URL.createObjectURL = jest.fn(function (blob) { blobs.push(blob); return 'blob:mock'; });
    global.URL.revokeObjectURL = jest.fn();
    try { window.sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
    window.__aiCmDebugLogs = false;
  });

  afterEach(() => { jest.restoreAllMocks(); });

  function loadBuilders() { return require('../utils/export-text-builders.js'); }
  function diagLines() { return logs.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; }); }
  function blobText(blob) {
    return new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.readAsText(blob);
    });
  }

  test('гейт выключен → ни одной строки [AI CM][diag], байты ровно те же', async () => {
    const B = loadBuilders();
    const content = 'Вопрос\n\nОтвет';
    B.downloadBlob(content, 'a.txt', 'text/plain;charset=utf-8', 'options-txt');
    expect(diagLines()).toEqual([]);
    expect(blobs).toHaveLength(1);
    await expect(blobText(blobs[0])).resolves.toBe(content);
  });

  test('sessionStorage aiCmDebug=1 → одна строка точки: триггер, файл, база, URL, threadId, src', async () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    const B = loadBuilders();
    const content = 'x'.repeat(500);
    B.downloadBlob(content, 'chat.txt', 'text/plain;charset=utf-8', 'options-txt',
      { threadId: 'TID-1', site: 'google_search' });
    const lines = diagLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('download trigger=options-txt');
    expect(lines[0]).toContain('file=chat.txt');
    expect(lines[0]).toContain('bytes100=' + 'x'.repeat(100) + '…'); // первые 100 символов базы
    expect(lines[0]).toContain('len=500');
    expect(lines[0]).toContain('url=');
    expect(lines[0]).toContain('threadId=TID-1');
    expect(lines[0]).toContain('site=google_search');
    expect(lines[0]).toContain('src=');
    // байты экспорта не изменены даже при включённом гейте
    await expect(blobText(blobs[0])).resolves.toBe(content);
  });

  test('гейт ВКЛ: отказ точки скачивания логируется как download-blocked с причиной', async () => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    const B = loadBuilders();
    // (1) пустое имя файла — файл не выдаётся, строка с reason=empty-name
    expect(B.downloadBlob('Вопрос\n\nОтвет', '', 'text/plain;charset=utf-8', 'options-txt')).toBe(false);
    expect(blobs).toHaveLength(0);
    let lines = diagLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[AI CM][diag] download-blocked reason=empty-name');
    expect(lines[0]).toContain('file=пустое');
    // (2) XSSI-префикс в первых байтах контента — файл не выдаётся, reason=xssi-prefix
    expect(B.downloadBlob(F_TXT, 'f.txt', 'text/plain;charset=utf-8', 'autoexport')).toBe(false);
    expect(blobs).toHaveLength(0);
    lines = diagLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('[AI CM][diag] download-blocked reason=xssi-prefix');
    expect(lines[1]).toContain('file=f.txt');
    expect(lines[1]).toContain('len=' + F_TXT.length);
    // (3) гейт ВЫКЛ: отказ тот же (файл не выдан), но НИ ОДНОЙ НОВОЙ строки
    const beforeOff = diagLines().length;
    window.sessionStorage.removeItem('aiCmDebug');
    const B2 = loadBuilders();
    expect(B2.downloadBlob('Вопрос', '', 'text/plain;charset=utf-8', 'options-txt')).toBe(false);
    expect(blobs).toHaveLength(0);
    expect(diagLines()).toHaveLength(beforeOff);
  });

  test('чекбокс «Подробные логи» (window.__aiCmDebugLogs) — тот же гейт', () => {
    window.__aiCmDebugLogs = true;
    const B = loadBuilders();
    B.downloadBlob('base', 'f.txt', 'text/plain;charset=utf-8', 'options-md');
    expect(diagLines()).toHaveLength(1);
    expect(diagLines()[0]).toContain('trigger=options-md');
    expect(diagLines()[0]).toContain('file=f.txt');
  });
});

// =====================================================================================
// (2) Точки записи базы GSA: форма хода, валидация, вердикт — только под гейтом
// =====================================================================================
function makeDiag(over) {
  const scope = 'with (ctx) { ' +
    fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagDocKind') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagHead') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagStack') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
    ' return { on: aiCmDiagOn, line: aiCmDiagLine, kind: aiCmDiagDocKind, head: aiCmDiagHead }; }';
  const ctx = Object.assign({
    sessionStorage: null,              // гейт ВЫКЛ по умолчанию
    window: {},
    location: { href: 'https://www.google.com/search?udm=50', hostname: 'www.google.com' },
    document: { querySelector: function () { return null; } },
    console: { log: function () { } }
  }, over || {});
  return new Function('ctx', scope)(ctx);
}

const GSA_FNS = [
  'messagesFromTurns',
  'isRawXssiPayload',
  'isUsableTurn',
  'hasUsableTurns',
  'isGarbageBody',
  'buildDetail',
  'emitDetail',
  'cacheSet',
  'isForeignThread',
  'segmentTurnsOf',
  'activateThread',
  'absorbForeignSnapshot',
  'applyTurns',
  'mergeStreamTurns',
  'mergeTurns',
  'gsaDiagTurnsShape',
  'gsaDiagBaseWrite',
  'gsaDiagState'
];
const GSA_SCOPE = 'with (ctx) { ' + GSA_FNS.map(function (n) { return fnDecl(INTERCEPT_SRC, n); }).join('\n') +
  '\n return { ' + GSA_FNS.map(function (n) { return n + ': ' + n; }).join(', ') + ' }; }';
const makeGsa = new Function('ctx', GSA_SCOPE);

function gsaCtx(gate, sink) {
  const diag = makeDiag({
    sessionStorage: gate ? { getItem: function (k) { return k === 'aiCmDebug' ? '1' : null; } } : null,
    console: { log: function (m) { sink.push(String(m)); } }
  });
  const ctx = {
    MAX_CACHE_ENTRIES: 10,
    threadCache: new Map(),
    lastFullTurns: [],
    lastFullMessages: [],
    lastFullSnapshot: null,
    seenKeys: {},
    currentThreadId: '',
    emittedThreadId: '',
    baseThreadId: '',
    detectedModelSlug: 'gemini-2.5-flash',
    domTid: 'TID-A',
    lastDiagSwitchSig: '',            // антиспам диагностических строк опроса DOM
    console: { log: function () { } },
    debugLog: function () { },
    aiCmDiagOn: diag.on,
    aiCmDiagLine: diag.line,
    aiCmDiagDocKind: diag.kind,
    aiCmDiagHead: diag.head,
    window: { GoogleFolwrUtils: Parser, dispatchEvent: function () { } }
  };
  ctx.readDomThreadId = function () { return ctx.domTid; };
  return ctx;
}

describe('O-27/O-32: точки записи базы GSA — форма хода и вердикт валидации', () => {
  test('гейт ВКЛ: accept-путь несёт path/verdict/shape/validation', () => {
    const sink = [];
    const ctx = gsaCtx(true, sink);
    makeGsa(ctx).applyTurns(TURNS_A, 'TID-A', true);
    const lines = sink.filter(function (l) { return l.indexOf(DIAG_PREFIX + ' gsa-base-write') === 0; });
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join('\n');
    expect(joined).toContain('path=applyTurns');
    expect(joined).toContain('verdict=accept');
    expect(joined).toContain('shape=turns=4 empty=0');
    expect(joined).toContain('validation=hasUsableTurns=true');
    expect(joined).toContain('tid=TID-A');
  });

  test('гейт ВКЛ: мусор captcha отвергнут — reject, база не тронута (как в O-27)', () => {
    const sink = [];
    const ctx = gsaCtx(true, sink);
    // (1) ТОЧНАЯ форма мусора (защитный фикс O-27): тело XSSI-префикса при 0 непустых ходах —
    // reject с отдельной причиной reason=xssi-prefix; форма хода видна (empty=1).
    makeGsa(ctx).applyTurns([turn('x', null, null)], 'TID-A', true, F_TXT);
    const joined = sink.filter(function (l) { return l.indexOf(DIAG_PREFIX + ' gsa-base-write') === 0; }).join('\n');
    expect(joined).toContain('verdict=reject');
    expect(joined).toContain('reason=xssi-prefix');
    expect(joined).toContain('shape=turns=1 empty=1');
    expect(ctx.lastFullSnapshot).toBeNull();

    // (2) сужение гарда: ход с НЕПУСТЫМ текстом по тексту больше не отклоняется (форму
    // решает ТЕЛО вместе с разбором) — длина текста видна в форме хода
    const sinkText = [];
    const ctxText = gsaCtx(true, sinkText);
    makeGsa(ctxText).applyTurns([turn('x', CAPTCHA_BODY, null)], 'TID-A', false);
    const textJoined = sinkText.filter(function (l) { return l.indexOf(DIAG_PREFIX + ' gsa-base-write') === 0; }).join('\n');
    expect(textJoined).toContain('verdict=accept');
    expect(textJoined).toContain('validation=hasUsableTurns=true');
    expect(textJoined).toContain('userLen=' + CAPTCHA_BODY.length); // форма хода: длина текста видна

    // (3) контейнер хода БЕЗ содержимого: форма хода пустая (empty=1), вердикт тот же reject
    const sinkEmpty = [];
    const ctxEmpty = gsaCtx(true, sinkEmpty);
    makeGsa(ctxEmpty).applyTurns([turn('e1', null, null)], 'TID-A', true);
    const emptyJoined = sinkEmpty.filter(function (l) { return l.indexOf(DIAG_PREFIX + ' gsa-base-write') === 0; }).join('\n');
    expect(emptyJoined).toContain('shape=turns=1 empty=1');
    expect(emptyJoined).toContain('verdict=reject');
    expect(emptyJoined).toContain('validation=hasUsableTurns=false');
    expect(ctxEmpty.lastFullSnapshot).toBeNull();
  });

  test('гейт ВЫКЛ: ни одной строки, снимок байтово тот же (поведение прежнее)', () => {
    const sinkOff = [];
    const ctxOff = gsaCtx(false, sinkOff);
    makeGsa(ctxOff).applyTurns(TURNS_A, 'TID-A', true);

    const sinkOn = [];
    const ctxOn = gsaCtx(true, sinkOn);
    makeGsa(ctxOn).applyTurns(TURNS_A, 'TID-A', true);

    expect(sinkOff.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; })).toEqual([]);
    expect(JSON.stringify(ctxOff.lastFullSnapshot)).toBe(JSON.stringify(ctxOn.lastFullSnapshot));
    expect(JSON.stringify(ctxOff.lastFullMessages)).toBe(JSON.stringify(ctxOn.lastFullMessages));
  });

  test('пути записи перечислены: open / pagination / probe / XHR / пассивный чанк folif', () => {
    expect(INTERCEPT_SRC).toContain("gsaDiagBaseWrite('open'");
    expect(INTERCEPT_SRC).toContain("gsaDiagBaseWrite('pagination'");
    expect(INTERCEPT_SRC).toContain("gsaDiagBaseWrite('probe'");
    expect(INTERCEPT_SRC).toContain("gsaDiagBaseWrite('xhr'");
    expect(INTERCEPT_SRC).toContain("'passive-folwr'");
    expect(INTERCEPT_SRC).toContain("'passive-folif'");
    expect(INTERCEPT_SRC).toContain("gsaDiagBaseWrite('scroll-backfill'");
    // тело без ходов (мусор captcha) логируется первыми 100 символами
    expect(INTERCEPT_SRC).toContain("'no-turns-parsed'");
  });

  test('сброс состояния: активный тред и опрос DOM логируют тип документа и причину', () => {
    expect(INTERCEPT_SRC).toContain("gsaDiagState('activateThread', 'reset', 'active-thread-switch'");
    expect(INTERCEPT_SRC).toContain("gsaDiagState('checkThreadSwitch', 'switching', 'thread-id-switch'");
    expect(INTERCEPT_SRC).toContain("gsaDiagState('checkThreadSwitch', 'no-reset'");
    expect(CONTENT).toContain("aiCmGsaDiagState('reset-stale'");
    expect(CONTENT).toContain("aiCmGsaDiagState('reset-stale', 'no-reset', 'chat-page')");
    expect(CONTENT).toContain("aiCmGsaDiagState('emit-thread-switch', 'reset', 'thread-id-change'");
    // тип документа (captcha/чат/поиск) считается чистой функцией без побочных эффектов
    const kind = makeDiag({ location: { href: 'https://www.google.com/sorry/index', hostname: 'www.google.com' } }).kind;
    expect(kind()).toBe('captcha');
    expect(makeDiag({ location: { href: 'https://www.google.com/search?q=1', hostname: 'www.google.com' } }).kind()).toBe('search');
  });
});

// =====================================================================================
// (3) Source-пины: гейт, четыре точки скачивания, отсутствие обходов
// =====================================================================================
describe('O-27/O-32: source-пины инструментирования', () => {
  test('utils/debug.js: единый гейт aiCmDebug и печать только через него', () => {
    const gate = fnDecl(DEBUG_SRC, 'aiCmDiagOn');
    expect(gate).toContain("sessionStorage.getItem('aiCmDebug') === '1'");
    expect(gate).toContain('window.__aiCmDebugLogs === true');
    const line = fnDecl(DEBUG_SRC, 'aiCmDiagLine');
    expect(line.indexOf('aiCmDiagOn()')).toBeLessThan(line.indexOf('console.log'));
    const dl = fnDecl(DEBUG_SRC, 'aiCmDiagDownload');
    expect(dl.indexOf('aiCmDiagOn()')).toBeLessThan(dl.indexOf('aiCmDiagLine('));
    // поля строки точки скачивания: триггер, имя файла, первые 100 символов, URL, threadId, src
    ['trigger:', 'file:', 'bytes100:', 'url:', 'threadId:', 'src:'].forEach(function (f) {
      expect(dl).toContain(f);
    });
  });

  test('пустое имя файла печатается словом «пустое» и в каноническом, и в popup-хелпере', () => {
    expect(fnDecl(DEBUG_SRC, 'aiCmDiagDownload')).toContain("'пустое'");
    expect(fnDecl(BUILDERS_SRC, 'diagDownload')).toContain("'пустое'");
  });

  test('builders: строка скачивания — ровно в одной функции, в контент-скрипте приоритет у debug.js', () => {
    expect(fnDecl(BUILDERS_SRC, 'downloadBlob')).toContain('diagDownload(');
    expect(fnDecl(BUILDERS_SRC, 'diagDownload')).toContain('diagOn()');
    expect(fnDecl(BUILDERS_SRC, 'diagDownload')).toContain('typeof aiCmDiagDownload === ');
    // новый префикс диагностики — ровно одно место печати в файле
    expect((BUILDERS_SRC.match(/\[AI CM\]\[diag\]/g) || []).length).toBe(1);
    // downloadBlob по-прежнему ставит имя файла как раньше и не меняет content
    const dl = fnDecl(BUILDERS_SRC, 'downloadBlob');
    expect(dl).toContain('new Blob([content], { type: mimeType })');
    expect(dl).toContain('a.download = fileName;');
  });

  test('O-27 (защитный фикс): строка отказа download-blocked живёт в обоих хелперах', () => {
    // канонический (контент-скрипт): tag 'download-blocked', reason — ПЕРВОЕ поле строки
    const blocked = fnDecl(DEBUG_SRC, 'aiCmDiagDownloadBlocked');
    expect(blocked).toContain('aiCmDiagOn()');
    expect(blocked.indexOf('aiCmDiagOn()')).toBeLessThan(blocked.indexOf('aiCmDiagLine('));
    expect(blocked).toContain("aiCmDiagLine('download-blocked'");
    expect(blocked.indexOf('reason:')).toBeLessThan(blocked.indexOf('trigger:'));
    // popup/options-фолбэк: та же строка через общий DIAG_PREFIX
    const local = fnDecl(BUILDERS_SRC, 'diagDownloadBlocked');
    expect(local).toContain('typeof aiCmDiagDownloadBlocked === ');
    expect(local).toContain('diagOn()');
    expect(local).toContain("+ ' download-blocked reason='");
    // причина отказа: контент (xssi-prefix) проверяется первым, затем пустое имя
    const reason = fnDecl(BUILDERS_SRC, 'downloadBlockReason');
    expect(reason).toContain("return 'xssi-prefix';");
    expect(reason).toContain("return 'empty-name';");
    expect(reason.indexOf('xssi-prefix')).toBeLessThan(reason.indexOf('empty-name'));
    expect(fnDecl(BUILDERS_SRC, 'startsWithXssiPrefix')).toContain('charCodeAt(0) === 41');
    // гард стоит в ЕДИНСТВЕННОЙ точке скачивания ДО выдачи файла
    const dl = fnDecl(BUILDERS_SRC, 'downloadBlob');
    expect(dl).toContain('downloadBlockReason(content, fileName)');
    expect(dl.indexOf('downloadBlockReason(content, fileName)')).toBeLessThan(dl.indexOf('new Blob([content]'));
  });

  test('четыре точки скачивания: autoexport / Ctrl+Shift+D / options / print-pdf', () => {
    const auto = fnDecl(MGR_SRC, 'doAutoExportDownload');
    expect(auto).toContain("aiCmDiagDownload('autoexport'");
    expect(auto.indexOf("aiCmDiagDownload('autoexport'"))
      .toBeLessThan(auto.indexOf('aiCmAutoExportStartDownload(content, file, fmt)'));
    expect(CONTENT).toContain("aiCmDiagDownload('hotkey-json-dump'");
    expect(OPTIONS_SRC).toContain("'options-md'");
    expect(OPTIONS_SRC).toContain("'options-json'");
    expect(OPTIONS_SRC).toContain("'options-txt'");
    expect(OPTIONS_SRC).toContain("'options-diag'");
    expect(PRINT_SRC).toContain("printDiag('print-pdf'");
    expect(PRINT_SRC).toContain("printDiag('print-pdf-empty'");
    const printDiagFn = fnDecl(PRINT_SRC, 'printDiag');
    expect(printDiagFn).toContain('printDiagOn()');
    expect(printDiagFn.indexOf('printDiagOn()')).toBeLessThan(printDiagFn.indexOf('console.log'));
    // имя файла печати = document.title (пустой — словом «пустое»)
    expect(printDiagFn).toContain("'пустое'");
  });

  test('гейты и валидаторы не тронуты: один downloadBlob, shouldSkipAutoExport жив, у GSA нет скачивания', () => {
    expect(MGR_SRC.split('.downloadBlob(').length - 1).toBe(1);
    expect(fnDecl(CONTENT, 'maybeAutoExport')).toContain('P.shouldSkipAutoExport({');
    expect(fnDecl(INTERCEPT_SRC, 'applyTurns')).toContain('if (!hasUsableTurns(turns))');
    expect(fnDecl(INTERCEPT_SRC, 'mergeTurns')).toContain('if (!hasUsableTurns(newTurns))');
    expect(INTERCEPT_SRC).not.toContain('createObjectURL');
    expect(INTERCEPT_SRC).not.toContain('a.download');
    expect(INTERCEPT_SRC).not.toContain('downloadBlob');
  });

  test('вызовы diag-хелперов в пиннутых функциях защищены typeof (срез-песочницы тестов)', () => {
    expect(fnDecl(INTERCEPT_SRC, 'applyTurns')).toContain("typeof gsaDiagBaseWrite === 'function'");
    expect(fnDecl(INTERCEPT_SRC, 'mergeTurns')).toContain("typeof gsaDiagBaseWrite === 'function'");
    expect(fnDecl(INTERCEPT_SRC, 'activateThread')).toContain("typeof gsaDiagState === 'function'");
    expect(fnDecl(INTERCEPT_SRC, 'gsaDiagBaseWrite')).toContain("typeof aiCmDiagOn !== 'function'");
    expect(fnDecl(INTERCEPT_SRC, 'gsaDiagState')).toContain("typeof aiCmDiagOn !== 'function'");
    // content-сторона: новые вызовы не ломают песочницы без utils/debug.js
    expect(fnDecl(CONTENT, 'aiCmGsaDiagState')).toContain("typeof aiCmDiagLine === 'function'");
    expect(fnDecl(CONTENT, 'aiCmGsaResetStaleStateOnChatlessDoc')).toContain('resetConversationState()');
  });
});
