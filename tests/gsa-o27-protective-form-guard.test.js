/**
 * O-27 (защитный фикс по форме мусора) — пины правила R-D: каждый путь записи базы и
 * ЕДИНСТВЕННАЯ точка скачивания.
 *
 * Живой артефакт: файл `f.txt` = `)]}'\n[""]\n` — XSSI-префикс Google с ПУСТЫМ payload,
 * скачан на captcha-странице с ПУСТЫМ именем файла. Логи (прогон 18:47, `Логи..txt`)
 * доказывают, что на легитимном теле GSA валидатор НИЧЕГО не отклоняет во всех путях
 * (open / applyTurns / probe): `shape=turns=5 empty=0`, `validation=hasUsableTurns=true`.
 *
 * Контракт защитного фикса:
 *   (1) гард базы СУЖЕН до точной формы мусора: ход непригоден, если его текст пуст, ИЛИ
 *       тело начинается XSSI-префиксом `)]}'` при отсутствии полезного payload (разбор в 0
 *       непустых ходов). Легитимное тело — в т.ч. начинающееся тем же префиксом, но с
 *       ходами, — пишется байтово прежним путём;
 *   (2) пост-гард в ЕДИНСТВЕННОЙ точке скачивания (`utils/export-text-builders.js:
 *       downloadBlob`, через неё идёт и `aiCmAutoExportStartDownload`): файл не выдаётся и
 *       печатается `[AI CM][diag] download-blocked reason=xssi-prefix|empty-name`, если
 *       первые байты контента начинаются с `)]}'` ИЛИ имя файла пустое/не задано. Отказ
 *       ловит любой триггер (автоэкспорт, options, печать), строка — только под гейтом
 *       aiCmDebug.
 *
 * Пины: (а) легитимное тело → база/экспорт байтово прежние, download разрешён; (б) XSSI-тело
 * → база не пишется, baseComplete не взводится, download blocked reason=xssi-prefix;
 * (в) пустое имя → blocked reason=empty-name; (г) регресс O-11 / O-31 / O-15…O-20;
 * (д) диаг-строки только под гейтом aiCmDebug, байты blob при гейте вкл/выкл идентичны.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = require('../utils/export-emit-pipeline.js');
const Parser = require('../utils/google-search-folwr-parser.js');
const CONTENT = require('./helpers/content-source.js').contentSource;

const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const BUILDERS_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const FOLWR_FIXTURE = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'google-folwr-open.html'), 'utf8');

const TID = 'SYNTHETIC-THREAD-1';
// Живой артефакт O-27: `f.txt` — XSSI-префикс Google + пустой payload (0 непустых ходов).
const F_TXT = ")]}'\n[\"\"]\n";
const NAME_OK = 'ai-context-monitor-google_search-Gemini-Search-AI-2026-09-16-18-47.txt';

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

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}
// Валидная база разговора: 4 хода (8 сообщений).
const TURNS_A = [
  turn('a1', 'Вопрос A1', 'Ответ A1'),
  turn('a2', 'Вопрос A2', 'Ответ A2'),
  turn('a3', 'Вопрос A3', 'Ответ A3'),
  turn('a4', 'Вопрос A4', 'Ответ A4')
];

// =====================================================================================
// Песочница РЕАЛЬНЫХ функций перехватчика (MAIN-мир) — писатели базы
// =====================================================================================
const SCOPE_FNS = [
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
  'parseTurns',
  'parseWithParser',
  'gsaDiagTurnsShape'
];
const SCOPE = 'with (ctx) { ' + SCOPE_FNS.map((n) => fnDecl(INTERCEPT, n)).join('\n') +
  '\n return { ' + SCOPE_FNS.map((n) => n + ': ' + n).join(', ') + ' }; }';
const makeIntercept = new Function('ctx', SCOPE);

function interceptCtx(over) {
  const events = [];
  const logs = [];
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
    domTid: '',
    logs: logs,
    console: { log: function () { } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    window: {
      GoogleFolwrUtils: Parser,
      parseGoogleFolwrOpen: Parser.parseGoogleFolwrOpen,
      dispatchEvent: function (ev) { events.push(ev.detail); }
    }
  };
  ctx.readDomThreadId = function () { return ctx.domTid; };
  Object.assign(ctx, over || {});
  return { ctx: ctx, events: events, logs: logs, api: makeIntercept(ctx) };
}

const snapshotOf = (ctx) => JSON.stringify({
  turns: ctx.lastFullTurns,
  messages: ctx.lastFullMessages,
  text: ctx.lastFullSnapshot.text,
  count: ctx.lastFullSnapshot.count,
  historyComplete: ctx.lastFullSnapshot.historyComplete,
  messageIds: ctx.lastFullSnapshot.messageIds
});

// Легитимное тело формы из живых логов (turns=5 empty=0): фикстура + 3 хода = 5
// контейнеров хода, у каждого непустой вопрос и ответ (ни одного пустого хода).
function legitFiveTurnBody() {
  const extra = [3, 4, 5].map((n) =>
    '<div class="CKgc1d" data-scope-id="turn" jsuid="turn-' + n + '">' +
    '<h2 class="iMqumd">Вы сказали: "Вопрос ' + n + '?"</h2></div>' +
    '<div class="n6owBd awi2gc">Ответ ' + n + '</div>').join('');
  return FOLWR_FIXTURE.replace(/<\/div><\/div>\s*$/, extra + '</div></div>');
}

// =====================================================================================
// (а) Легитимное тело: база и экспорт байтово прежние, download не блокируется
// =====================================================================================
describe('R-D (а): легитимное тело — база/экспорт байтово прежние, download разрешён', () => {
  test('прод-фикстура: снимок байтово прежний, форма гарда не срабатывает', () => {
    const h = interceptCtx({ domTid: TID });
    const parsed = h.api.parseWithParser(FOLWR_FIXTURE);
    expect(h.api.isGarbageBody(FOLWR_FIXTURE, parsed.turns)).toBe(false);
    expect(h.api.hasUsableTurns(parsed.turns)).toBe(true);
    h.api.applyTurns(parsed.turns, TID, true, FOLWR_FIXTURE);
    const after = snapshotOf(h.ctx);

    // «до-фиксовое» поведение: гард формы мусора выключен
    const pre = interceptCtx({ domTid: TID, isGarbageBody: function () { return false; } });
    const parsedPre = pre.api.parseWithParser(FOLWR_FIXTURE);
    pre.api.applyTurns(parsedPre.turns, TID, true, FOLWR_FIXTURE);

    expect(after).toBe(snapshotOf(pre.ctx));
    expect(h.ctx.lastFullSnapshot.count).toBe(4);
    expect(h.ctx.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.events).toHaveLength(1);
  });

  test('тело из логов (turns=5 empty=0): форма совпадает с живой строкой, снимок не тронут', () => {
    const body = legitFiveTurnBody();
    const h = interceptCtx({ domTid: TID });
    const parsed = h.api.parseWithParser(body);
    // ровно как в живом логе (`gsa-base-write path=open … shape=turns=5 empty=0`): длины
    // текстов там принадлежат живому телу 1 355 398 B, которого нет в репозитории, поэтому
    // пиннится ФОРМА (число ходов и отсутствие пустых), а не байты того прогона
    expect(h.api.gsaDiagTurnsShape(parsed.turns)).toContain('turns=5 empty=0');
    expect(h.api.isGarbageBody(body, parsed.turns)).toBe(false);

    h.api.applyTurns(parsed.turns, TID, true, body);
    const after = snapshotOf(h.ctx);
    const pre = interceptCtx({ domTid: TID, isGarbageBody: function () { return false; } });
    pre.api.applyTurns(pre.api.parseWithParser(body).turns, TID, true, body);
    expect(after).toBe(snapshotOf(pre.ctx));
    expect(h.ctx.lastFullSnapshot.count).toBe(10);       // 5 ходов = 10 сообщений (как msgs=10 в логе)
    expect(h.ctx.lastFullSnapshot.historyComplete).toBe(true);
  });

  test('экспорт легитимной базы: txt бaimтово тот же, download не блокируется', async () => {
    const B = loadBuilders();
    const h = interceptCtx({ domTid: TID });
    const body = legitFiveTurnBody();
    h.api.applyTurns(h.api.parseWithParser(body).turns, TID, true, body);

    const hist = { model: 'gemini-2.5-flash', tokens: 1882, limit: 0, percent: 1.5, messages: h.ctx.lastFullMessages };
    const content = B.buildTxtFromHistory(hist);

    // байты экспорта «до гарда»: тот же сборщик по тому же снимку (гард контент не трогает)
    const Bpre = loadBuilders();
    const contentPre = Bpre.buildTxtFromHistory({ messages: h.ctx.lastFullMessages, model: 'gemini-2.5-flash', tokens: 1882, limit: 0, percent: 1.5 });
    expect(content).toBe(contentPre);
    expect(B.aiCmDownloadBlockReason(content, NAME_OK)).toBeNull();

    expect(B.downloadBlob(content, NAME_OK, 'text/plain;charset=utf-8', 'autoexport')).toBe(true);
    expect(blobs).toHaveLength(1);
    await expect(blobText(blobs[0])).resolves.toBe(content);
  });
});

// =====================================================================================
// (б) XSSI-тело: база не пишется, baseComplete не взводится, download blocked
// =====================================================================================
describe('R-D (б): XSSI-тело `)]}\'\\n[""]\\n` — база не пишется, download blocked reason=xssi-prefix', () => {
  test('пути записи базы (open/пагинация/probe — applyTurns; passive/XHR — mergeTurns) отвергают', () => {
    // разбор живого тела даёт 0 ходов (реальный путь open/пагинация/probe/XHR)
    const parsed = interceptCtx({ domTid: TID }).api.parseWithParser(F_TXT);
    expect(parsed.turns).toHaveLength(0);

    // applyTurns — единый путь open/пагинации/probe: и пустой разбор, и точная форма мусора
    const h1 = interceptCtx({ domTid: TID });
    h1.api.applyTurns(parsed.turns, TID, true, F_TXT);              // open (complete=true)
    expect(h1.ctx.lastFullSnapshot).toBeNull();
    expect(h1.events).toHaveLength(0);                              // baseComplete взводить нечем
    h1.api.applyTurns([turn('x', null, null)], TID, true, F_TXT);   // контейнер без содержимого
    expect(h1.ctx.lastFullSnapshot).toBeNull();
    expect(h1.events).toHaveLength(0);

    // mergeTurns — единый путь passive folwr/folif и XHR
    const h2 = interceptCtx({ domTid: TID });
    h2.api.mergeTurns(parsed.turns, true, TID, F_TXT);
    expect(h2.ctx.lastFullSnapshot).toBeNull();
    expect(h2.ctx.lastFullTurns).toHaveLength(0);
    h2.api.mergeTurns([turn('x', '   ', '')], false, TID, F_TXT);
    expect(h2.ctx.lastFullSnapshot).toBeNull();
    expect(h2.logs.join('\n')).toContain('O-27: форма мусора');

    // мусор не портит уже накопленную базу разговора
    const h3 = interceptCtx({ domTid: TID });
    h3.api.applyTurns(TURNS_A, TID, true, 'legit-body');
    const emitted = h3.events.length;
    h3.api.mergeTurns([turn('x', null, null)], true, TID, F_TXT);
    expect(h3.ctx.lastFullMessages).toHaveLength(8);
    expect(h3.events.length).toBe(emitted);
  });

  test('download точки скачивания: blocked reason=xssi-prefix, файл не выдан', () => {
    const B = loadBuilders();
    window.sessionStorage.setItem('aiCmDebug', '1');
    expect(B.aiCmDownloadBlockReason(F_TXT, NAME_OK)).toBe('xssi-prefix');
    expect(B.downloadBlob(F_TXT, NAME_OK, 'text/plain;charset=utf-8', 'autoexport')).toBe(false);
    expect(blobs).toHaveLength(0);
    const lines = diagLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[AI CM][diag] download-blocked reason=xssi-prefix');
    expect(lines[0]).toContain('trigger=autoexport');
    expect(lines[0]).toContain('file=' + NAME_OK);
  });

  test('живой путь автоэкспорта: aiCmAutoExportStartDownload с XSSI-контентом файла не выдаёт', () => {
    const B = loadBuilders();
    const h = autoExportCtx(B);
    const name = h.run(F_TXT, 'ai-context-monitor-google_search-x.txt', 'txt');
    expect(name).toBe('ai-context-monitor-google_search-x.txt'); // имя вернулось (контракт точки)
    expect(blobs).toHaveLength(0);                              // но файл не выдан
  });

  test('source-пины: сырое тело доезжает до ОБОИХ писателей на всех сетевых путях', () => {
    // open / pagination / probe-step / probe-finish — через applyTurns с телом
    expect(INTERCEPT).toContain('applyTurns(mergedTurns, tid, historyComplete, txt);');
    expect((INTERCEPT.match(/applyTurns\(merged, tid, false, txt\);/g) || []).length).toBe(2);
    expect(INTERCEPT).toContain('applyTurns(merged.length > 0 ? merged : lastFullTurns, tid, true, lastBody);');
    // passive folwr/folif и XHR — через mergeTurns с телом
    expect(INTERCEPT).toContain('mergeTurns(parsed.turns, isFull, parsed.threadId, txt);');
    expect(INTERCEPT).toContain('mergeTurns(parsed.turns, isFullXhr, parsed.threadId, txt);');
    // DOM-добор (scroll-backfill) тела не имеет — форма мусора там не решается
    expect(INTERCEPT).toContain('applyTurns(mergeFn(lastFullTurns, domTurns), tid, false);');
    // обе точки приёма базы выходят ДО записи; форма мусора — отдельная причина
    expect(fnDecl(INTERCEPT, 'applyTurns')).toContain('if (isGarbageBody(bodyText, turns))');
    expect(fnDecl(INTERCEPT, 'mergeTurns')).toContain('if (isGarbageBody(bodyText, newTurns))');
    expect(fnDecl(INTERCEPT, 'applyTurns')).toContain("reason: 'xssi-prefix'");
    expect(fnDecl(INTERCEPT, 'mergeTurns')).toContain("reason: 'xssi-prefix'");
    // baseComplete content.js берёт ТОЛЬКО из эмитированного detail
    expect(CONTENT).toContain('const newBaseComplete = !!detail.historyComplete;');
  });
});

// =====================================================================================
// (в) Пустое имя файла: blocked reason=empty-name (любой триггер)
// =====================================================================================
describe('R-D (в): пустое/не заданное имя файла — download blocked reason=empty-name', () => {
  test('имя "" и имя undefined — файл не выдан, причина empty-name', () => {
    const B = loadBuilders();
    window.sessionStorage.setItem('aiCmDebug', '1');
    const content = 'Вопрос\n\nОтвет';
    expect(B.aiCmDownloadBlockReason(content, '')).toBe('empty-name');
    expect(B.aiCmDownloadBlockReason(content, '   ')).toBe('empty-name');
    expect(B.aiCmDownloadBlockReason(content, undefined)).toBe('empty-name');
    expect(B.downloadBlob(content, '', 'text/plain;charset=utf-8', 'options-txt')).toBe(false);
    expect(B.downloadBlob(content, undefined, 'text/plain;charset=utf-8', 'options-txt')).toBe(false);
    expect(blobs).toHaveLength(0);
    const lines = diagLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[AI CM][diag] download-blocked reason=empty-name');
    expect(lines[0]).toContain('file=пустое');
    expect(lines[1]).toContain('[AI CM][diag] download-blocked reason=empty-name');
  });

  test('живой путь автоэкспорта с пустым именем: файл не выдан, реестр имён не тронут', () => {
    const B = loadBuilders();
    const h = autoExportCtx(B);
    h.run('Вопрос\n\nОтвет', '', 'txt');
    expect(blobs).toHaveLength(0);
    expect(h.used).toEqual({});                                  // пустое имя в реестр не пишется
    expect(h.run('Вопрос\n\nОтвет', NAME_OK, 'txt')).toBe(NAME_OK);
    expect(blobs).toHaveLength(1);                               // легитимный вызов проходит
  });

  test('жалоба живой captcha (оба условия): решающая причина — форма мусора', () => {
    const B = loadBuilders();
    // живой `f.txt`: XSSI-тело И пустое имя одновременно → reason=xssi-prefix (контент первым)
    expect(B.aiCmDownloadBlockReason(F_TXT, '')).toBe('xssi-prefix');
    expect(B.downloadBlob(F_TXT, '', 'text/plain;charset=utf-8', 'autoexport')).toBe(false);
    expect(blobs).toHaveLength(0);
  });
});

// =====================================================================================
// (г) Регресс: O-11 / O-31 / O-15…O-20
// =====================================================================================
describe('R-D (г): регрессионный контур O-11 / O-31 / O-15…O-20 зелёный', () => {
  test('O-11: два файра в одну минуту → второе имя с дисамбигуатором -2', () => {
    const B = loadBuilders();
    const h = autoExportCtx(B);
    const one = 'ai-context-monitor-google_search-Gemini-Search-AI-2026-09-16-18-47.txt';
    expect(h.run('Первый файл', one, 'txt')).toBe(one);
    expect(h.run('Второй файл', one, 'txt')).toBe(one.replace(/\.txt$/, '-2.txt'));
    expect(blobs).toHaveLength(2);
    expect(h.used[one]).toBe(1);
    expect(h.used[one.replace(/\.txt$/, '-2.txt')]).toBe(1);
  });

  test('O-31: ходы чужого разговора в активную базу не пишутся (сегментация жива)', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';
    h.api.applyTurns(TURNS_A, 'TID-A', true, 'body-a');
    h.ctx.domTid = 'TID-B';
    const emitted = h.events.length;
    h.api.applyTurns([turn('b1', 'Вопрос B1', 'Ответ B1')], 'TID-B', true, 'body-b');
    h.api.applyTurns(TURNS_A, 'TID-A', true, 'body-a2');           // поздний ответ старого разговора
    expect(h.ctx.lastFullMessages).toHaveLength(2);
    expect(h.events.length).toBe(emitted + 1);
    expect(h.ctx.threadCache.get('TID-A').turns).toHaveLength(4);
  });

  test('O-15…O-20: экспорт DeepSeek-стиля (BOM + текст) проходит точку скачивания', async () => {
    const B = loadBuilders();
    const txt = '\uFEFF' + 'Пользователь:\nвопрос\n\nАссистент:\nответ\n';
    expect(B.aiCmDownloadBlockReason(txt, 'deepseek-chat-2026-09-16.txt')).toBeNull();
    expect(B.downloadBlob(txt, 'deepseek-chat-2026-09-16.txt', 'text/plain;charset=utf-8', 'autoexport')).toBe(true);
    // байты blob читаем побайтово: readAsText снимает BOM, а он — часть контракта txt-экспорта
    const bytes = await blobBytes(blobs[0]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xEF, 0xBB, 0xBF]);
    expect(Buffer.from(bytes).toString('utf8')).toBe(txt);
  });

  test('наборы O-11/O-15…O-20/O-31 на месте (исполняются npm test)', () => {
    const files = [
      'tests/gsa-autoexport-o11-name-collision.test.js',
      'tests/gsa-o31-thread-segmentation.test.js',
      'tests/gsa-o27-captcha-base-guard.test.js',
      'tests/diag-o27-o32-instrumentation.test.js',
      'tests/adapters/deepseek-o15-pairing.test.js',
      'tests/adapters/deepseek-o16-stream-export.test.js',
      'tests/adapters/deepseek-o17-spa-chat.test.js',
      'tests/adapters/deepseek-o18-export-net-sync.test.js',
      'tests/adapters/deepseek-o18-frag-resync.test.js'
    ];
    for (const f of files) expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
  });
});

// =====================================================================================
// (д) Диаг-строки только под гейтом; байты blob при гейте вкл/выкл идентичны
// =====================================================================================
describe('R-D (д): гейт aiCmDebug — строки только под гейтом, байты blob идентичны', () => {
  test('гейт ВЫКЛ → ни одной диаг-строки; гейт ВКЛ → строка; байты те же', async () => {
    const content = 'Вопрос\n\nОтвет';
    const Boff = loadBuilders();
    expect(Boff.downloadBlob(content, NAME_OK, 'text/plain;charset=utf-8', 'autoexport')).toBe(true);
    expect(diagLines()).toEqual([]);

    window.sessionStorage.setItem('aiCmDebug', '1');
    const Bon = loadBuilders();
    expect(Bon.downloadBlob(content, NAME_OK, 'text/plain;charset=utf-8', 'autoexport')).toBe(true);
    const lines = diagLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[AI CM][diag] download trigger=autoexport');

    expect(blobs).toHaveLength(2);
    const off = await blobBytes(blobs[0]);
    const on = await blobBytes(blobs[1]);
    expect(Array.from(on)).toEqual(Array.from(off));
    expect(Buffer.from(on).toString('utf8')).toBe(content);
  });

  test('канонический хелпер utils/debug.js печатает ту же строку и уважает гейт', () => {
    const sinkOff = [];
    const sinkOn = [];
    makeDiag(false, sinkOff).blocked('autoexport', F_TXT, 'f.txt', 'xssi-prefix', {});
    expect(sinkOff).toEqual([]);
    const diagOn = makeDiag(true, sinkOn);
    expect(diagOn.blocked('autoexport', F_TXT, 'f.txt', 'xssi-prefix', { mime: 'txt' })).toBe(true);
    expect(sinkOn).toHaveLength(1);
    expect(sinkOn[0]).toContain('[AI CM][diag] download-blocked reason=xssi-prefix');
    expect(sinkOn[0]).toContain('trigger=autoexport');
    expect(sinkOn[0]).toContain('file=f.txt');
    expect(sinkOn[0]).toContain('src=');
    // строка отказа — ровно в одном месте каждого файла-носителя
    expect((BUILDERS_SRC.match(/\[AI CM\]\[diag\]/g) || []).length).toBe(1);
    expect(fnDecl(DEBUG_SRC, 'aiCmDiagDownloadBlocked')).toContain("aiCmDiagLine('download-blocked'");
    // источник отказа — ЕДИНСТВЕННАЯ точка скачивания; в export-manager.js ровно один её вызов
    expect(MGR_SRC.split('.downloadBlob(').length - 1).toBe(1);
    expect(fnDecl(BUILDERS_SRC, 'downloadBlob')).toContain('downloadBlockReason(content, fileName)');
  });
});

// =====================================================================================
// Общие хелперы сьюта (загрузка сборщиков, песочница автоэкспорта, diag-песочница)
// =====================================================================================
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
function diagLines() { return logs.filter(function (l) { return l.indexOf('[AI CM][diag]') === 0; }); }
function blobText(blob) {
  return new Promise(function (resolve) {
    const reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.readAsText(blob);
  });
}
// Побайтовое чтение blob (readAsText снимает BOM, а он — часть контракта txt-экспорта).
function blobBytes(blob) {
  return new Promise(function (resolve) {
    const reader = new FileReader();
    reader.onload = function () { resolve(new Uint8Array(reader.result)); };
    reader.readAsArrayBuffer(blob);
  });
}

// Песочница РЕАЛЬНОЙ единственной точки старта скачивания автоэкспорта (ISOLATED-мир):
// реестр имён O-11 + Bdl.downloadBlob (реальный сборщик с пост-гардом O-27).
function autoExportCtx(B) {
  const used = {};
  const scope = 'with (ctx) { ' + fnDecl(CONTENT, 'aiCmAutoExportStartDownload') +
    '\n return { run: aiCmAutoExportStartDownload }; }';
  const ctx = {
    aiCmAutoExportNamesUsed: used,
    window: { AiCmExportBuilders: B, AiCmExportEmitPipeline: P }
  };
  return { ctx: ctx, used: used, run: new Function('ctx', scope)(ctx).run };
}

// Песочница канонических диаг-хелперов utils/debug.js (единый гейт aiCmDebug).
function makeDiag(gate, sink) {
  const scope = 'with (ctx) { ' +
    fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagHead') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagStack') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagDownloadBlocked') + '\n' +
    ' return { blocked: aiCmDiagDownloadBlocked, line: aiCmDiagLine }; }';
  const ctx = {
    sessionStorage: gate ? { getItem: function (k) { return k === 'aiCmDebug' ? '1' : null; } } : null,
    window: {},
    location: { href: 'https://www.google.com/search?udm=50', hostname: 'www.google.com' },
    document: { querySelector: function () { return null; } },
    console: { log: function (m) { sink.push(String(m)); } }
  };
  return new Function('ctx', scope)(ctx);
}
