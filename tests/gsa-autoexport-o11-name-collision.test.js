/**
 * O-11: две маски имён автоэкспорта + коллизия имён на GSA (convId пуст).
 *
 * ДЕФЕКТ (воспроизведён до фикса, одна минута — реальные имена):
 *   point1 buildExportFileName(service, convId, …) → google_search-noconv-<YYYY-MM-DD_HH-MM>.txt
 *   point2 buildGsaExportFileName(site, model, …)  #1 == #2
 *          → ai-context-monitor-google_search-<model>-<YYYY-MM-DD-HH-MM>.txt
 * Имя автоэкспорта строили ДВЕ независимые маски; у GSA в URL нет convId, а маска 2
 * имеет МИНУТНУЮ гранулярность: два автоэкспорта в одну минуту давали ОДНО имя файла —
 * вторая копия ложилась поверх первой (потеря копии).
 *
 * ФИКС:
 *  1. маска имени ровно ОДНА — buildAutoExportFileName(spec); прежние две точки стали
 *     тонкими обёртками (имена прочих платформ и шаблон ручного экспорта GSA байтово прежние);
 *  2. гард коллизии: занятое имя (файл уже выдан / второй экспорт в ту же минуту) получает
 *     дисамбигуатор -2, -3, … перед расширением; на GSA с пустым convId уникальны ОБЕ копии;
 *  3. convId НЕ выдумывается — уникальность даёт дисамбигуатор, а не синтетический id.
 *
 * Сьют-пины: GSA два автоэкспорта в одну минуту → два РАЗНЫХ имени, обе копии целы;
 * прочие платформы — имена байтово прежние; шаблон ручного экспорта не изменился (M-10/F4).
 *
 * НЕ ТРОГАЕТСЯ: байты файлов экспорта, гейты автоэкспорта, парсеры perplexity/deepseek.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = require('./helpers/content-source.js').contentSource;
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const OPTIONS_JS = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');

// Рез по балансу фигурных скобок (как в tests/gsa-autoexport.test.js).
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

const GSA = 'google_search';
const TID = 'SYNTHETIC-THREAD-1';
const MODEL = 'Gemini 2.5 Flash';
const NAME_RE = /^ai-context-monitor-google_search-Gemini-2\.5-Flash-2026-08-31-09-05\.txt$/;

// Фиксированное «сейчас» (2026-08-31 09:05) — имена детерминированы, граница минуты
// между двумя экспортами не может сделать тест флейки.
function mockNow() {
  jest.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026);
  jest.spyOn(Date.prototype, 'getMonth').mockReturnValue(7); // август
  jest.spyOn(Date.prototype, 'getDate').mockReturnValue(31);
  jest.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
  jest.spyOn(Date.prototype, 'getMinutes').mockReturnValue(5);
}

// =====================================================================================
// 1) Репро дефекта: две маски и ОДНО имя на GSA в одну минуту
// =====================================================================================
describe('O-11: две маски имён автоэкспорта (репро дефекта)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('маска без гарда: два автоэкспорта GSA в одну минуту → ОДНО имя (копия терялась)', () => {
    mockNow();
    // point1 — общая маска (convId): на GSA convId пуст → noconv
    const point1 = P.buildExportFileName(GSA, '', 'threshold', false, 'txt');
    expect(point1).toBe('google_search-noconv-2026-08-31_09-05.txt');
    // point2 — маска ручного шаблона GSA: два вызова в одну минуту байтово равны
    const point2a = P.buildGsaExportFileName(GSA, MODEL, false, 'txt');
    const point2b = P.buildGsaExportFileName(GSA, MODEL, false, 'txt');
    expect(point2a).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.txt');
    expect(point2a).toBe(point2b); // коллизия: одно имя на две копии
    // единственное, что разводит копии, — гард (дисамбигуатор), шаблон при этом прежний
    const taken = {};
    taken[point2a] = 1;
    expect(P.buildGsaExportFileName(GSA, MODEL, false, 'txt', taken))
      .toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-2.txt');
  });

  test('одна функция-источник: обе прежние точки — тонкие обёртки, литерал шаблона один', () => {
    expect(typeof P.buildAutoExportFileName).toBe('function');
    expect(PIPELINE_SRC).toContain('function buildAutoExportFileName(spec)');
    // шаблон ручного экспорта ('ai-context-monitor-') печатается РОВНО в одном месте
    expect((PIPELINE_SRC.match(/'ai-context-monitor-'/g) || []).length).toBe(1);
    const gsa = fnDecl(PIPELINE_SRC, 'buildGsaExportFileName');
    const generic = fnDecl(PIPELINE_SRC, 'buildExportFileName');
    expect(gsa).toContain('buildAutoExportFileName(');
    expect(generic).toContain('buildAutoExportFileName(');
    expect(gsa).not.toContain("'ai-context-monitor-'");
    expect(generic).not.toContain("'ai-context-monitor-'");
    // сигнатуры прежние (пины существуют в других сьютах и в вызовах export-manager)
    expect(P.buildExportFileName.length).toBe(5);
    expect(P.buildGsaExportFileName.length).toBe(4);
  });

  test('convId не выдумывается: threadId GSA в имя файла не попадает', () => {
    mockNow();
    const n = P.buildGsaExportFileName(GSA, MODEL, false, 'txt');
    expect(n).not.toContain(TID);
    expect(n).not.toContain('noconv');
    expect(n).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.txt');
  });
});

// =====================================================================================
// 2) Гард коллизии на уровне единственного источника
// =====================================================================================
describe('O-11: гард коллизии (дисамбигуатор -2, -3, …)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('занятое имя → -2, -3; первая копия не переименовывается', () => {
    mockNow();
    const first = P.buildGsaExportFileName(GSA, MODEL, false, 'md');
    const taken = {};
    taken[first] = 1;
    const second = P.buildGsaExportFileName(GSA, MODEL, false, 'md', taken);
    expect(second).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-2.md');
    taken[second] = 1;
    expect(P.buildGsaExportFileName(GSA, MODEL, false, 'md', taken))
      .toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-3.md');
  });

  test('набор занятых имён: массив и Set; расширение и [LOW CONFIDENCE]_ сохранены', () => {
    mockNow();
    const base = P.buildGsaExportFileName(GSA, MODEL, false, 'md');
    const arr = [base, base.replace(/\.md$/, '-2.md')];
    expect(P.buildGsaExportFileName(GSA, MODEL, false, 'md', arr))
      .toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-3.md');
    const set = new Set([base]);
    expect(P.buildGsaExportFileName(GSA, MODEL, false, 'md', set))
      .toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-2.md');
    const lc = P.buildGsaExportFileName(GSA, 'm', true, 'json');
    expect(lc).toBe('[LOW CONFIDENCE]_ai-context-monitor-google_search-m-2026-08-31-09-05.json');
    const lcTaken = {};
    lcTaken[lc] = 1;
    expect(P.buildGsaExportFileName(GSA, 'm', true, 'json', lcTaken))
      .toBe('[LOW CONFIDENCE]_ai-context-monitor-google_search-m-2026-08-31-09-05-2.json');
  });

  test('общая маска: гард работает и там (та же единственная функция-источник)', () => {
    mockNow();
    const base = P.buildExportFileName('gemini', 'abcdefgh12345678', 'threshold', false, 'txt');
    expect(base).toBe('gemini-abcdefgh-2026-08-31_09-05.txt');
    const taken = {};
    taken[base] = 1;
    expect(P.buildExportFileName('gemini', 'abcdefgh12345678', 'threshold', false, 'txt', taken))
      .toBe('gemini-abcdefgh-2026-08-31_09-05-2.txt');
    // суффикс причины остаётся ПЕРЕД расширением, дисамбигуатор идёт за ним
    const pre = P.buildExportFileName('gemini', 'abcdefgh12345678', 'pre-trim', false, 'txt');
    expect(pre).toBe('gemini-abcdefgh-2026-08-31_09-05-pretrim.txt');
    const t2 = {};
    t2[pre] = 1;
    expect(P.buildExportFileName('gemini', 'abcdefgh12345678', 'pre-trim', false, 'txt', t2))
      .toBe('gemini-abcdefgh-2026-08-31_09-05-pretrim-2.txt');
  });
});

// =====================================================================================
// 3) Конец-в-конец: РЕАЛЬНЫЙ doAutoExportDownload (единственная точка записи файла)
// =====================================================================================
describe('O-11: два автоэкспорта GSA в одну минуту — обе копии целы (реальный код)', () => {
  const SCOPE = 'with (ctx) { ' +
    fnDecl(CONTENT, 'aiCmExportBaseSource') + '\n' +
    fnDecl(CONTENT, 'aiCmAutoExportStartDownload') + '\n' +
    fnDecl(CONTENT, 'doAutoExportDownload') + '\n' +
    ' return { dl: doAutoExportDownload }; }';
  const makeContent = new Function('ctx', SCOPE);

  const MSGS_A = [
    { role: 'user', text: 'ПЕРВЫЙ вопрос' },
    { role: 'assistant', text: 'ПЕРВЫЙ ответ' }
  ];
  const MSGS_B = [
    { role: 'user', text: 'ВТОРОЙ вопрос' },
    { role: 'assistant', text: 'ВТОРОЙ ответ' }
  ];

  function ctxFor(over) {
    const downloads = [];
    const logs = [];
    const state = { msgs: MSGS_A };
    const ctx = {
      currentAdapter: { siteName: GSA },
      autoExportSettings: { fmt: 'txt', enabled: true },
      aiCmLowConfidenceByConv: {},
      baseSeen: true,
      baseComplete: true,
      lastBaseTexts: MSGS_A.map((m) => m.text),
      lastEmitConvId: '',
      lastThreadId: '',
      lastResolvedModelId: 'gemini-2.5-flash',
      lastSnapshotModelName: MODEL,
      maxTokenCount: 1000,
      sessionFiredCache: {},
      autoExportFired: {},
      aiCmAutoExportNamesUsed: {}, // O-11: реестр занятых имён (как в core/export-manager.js)
      aiCmCursorLiveByConv: {},
      aiCmDumpTurnsSnapshot: function () { },
      aiCmCancelDeferredHistWrite: function () { },
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      console: { error: function () { } },
      ModelConfig: { getModel: function () { return { name: MODEL }; } },
      chrome: { storage: { session: { set: function () { }, remove: function () { } } } },
      buildHistoryMessages: function () { return state.msgs.slice(); },
      aiCmGeminiTurnsSnapshotSync: function () { return null; },
      window: {
        location: { hostname: 'www.google.com' },
        AiCmExportBuilders: {
          buildTxtFromHistory: function (hist) { return hist.messages.map((m) => m.role + '::' + m.text).join('\n'); },
          buildMdFromHistory: function (hist) { return hist.messages.map((m) => m.text).join('\n'); },
          buildJsonFromHistory: Builders.buildJsonFromHistory,
          downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); }
        },
        AiCmExportEmitPipeline: P
      }
    };
    Object.assign(ctx, over || {});
    const api = makeContent(ctx);
    return {
      ctx: ctx, downloads: downloads, logs: logs, api: api,
      // смена разговора: cid стреляющего треда + его история (как новая вкладка/тред GSA)
      setConv: function (cid, msgs) {
        state.msgs = msgs || state.msgs;
        ctx.lastEmitConvId = cid;
        ctx.lastThreadId = cid;
        ctx.lastBaseTexts = state.msgs.map((m) => m.text);
      },
      dl: api.dl
    };
  }

  afterEach(() => jest.restoreAllMocks());

  test('без гарда (реестр не передан) два экспорта в одну минуту → ОДНО имя (дефект виден)', () => {
    mockNow();
    const h = ctxFor({ aiCmAutoExportNamesUsed: null });
    h.dl('', 95, 'threshold');
    h.dl('', 95, 'threshold');
    expect(h.downloads.length).toBe(2);
    // обе копии уходят под одним именем — вторая ложится поверх первой
    expect(h.downloads[0].file).toBe(h.downloads[1].file);
  });

  test('фикс: convId пуст, две копии в одну минуту → два РАЗНЫХ имени, обе целы', () => {
    mockNow();
    const h = ctxFor({});
    h.dl('', 95, 'threshold');
    h.dl('', 95, 'threshold');
    expect(h.downloads.length).toBe(2);
    const f1 = h.downloads[0].file;
    const f2 = h.downloads[1].file;
    expect(f1).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.txt');
    expect(f2).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-2.txt');
    expect(f1).not.toBe(f2);
    // обе копии целы: тело на месте, txt-эталон с BOM, ничего не затёрто
    h.downloads.forEach((d) => {
      expect(d.content).toContain('ПЕРВЫЙ вопрос');
      expect(d.content.charAt(0)).toBe('\uFEFF');
      expect(d.mime).toBe('text/plain;charset=utf-8');
    });
    // реестр занятых имён заполнен обоими итоговыми именами (для следующих экспортов)
    expect(Object.keys(h.ctx.aiCmAutoExportNamesUsed).sort()).toEqual([f1, f2].sort());
  });

  test('фикс: два РАЗНЫХ GSA-треда в одну минуту → две копии с разными телами', () => {
    mockNow();
    const h = ctxFor({});
    h.setConv('THREAD-1', MSGS_A);
    h.dl('THREAD-1', 95, 'threshold');
    h.setConv('THREAD-2', MSGS_B);
    h.dl('THREAD-2', 95, 'threshold');
    expect(h.downloads.length).toBe(2);
    expect(h.downloads[0].file).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.txt');
    expect(h.downloads[1].file).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-2.txt');
    expect(h.downloads[0].content).toContain('ПЕРВЫЙ вопрос');
    expect(h.downloads[1].content).toContain('ВТОРОЙ вопрос');
    // никакой подмены тел: каждая копия несёт свой разговор
    expect(h.downloads[0].content).not.toContain('ВТОРОЙ');
    expect(h.downloads[1].content).not.toContain('ПЕРВЫЙ');
  });

  test('прочие платформы: имена байтово прежние; повтор того же чата → -2, а не затирание', () => {
    mockNow();
    const h = ctxFor({
      currentAdapter: { siteName: 'gemini' },
      lastSnapshotModelName: ''
    });
    h.setConv('0362260d', MSGS_A);
    h.dl('0362260d', 95, 'threshold');
    h.setConv('abcdef12', MSGS_B);
    h.dl('abcdef12', 95, 'threshold');
    expect(h.downloads[0].file).toBe('gemini-0362260d-2026-08-31_09-05.txt');
    expect(h.downloads[1].file).toBe('gemini-abcdef12-2026-08-31_09-05.txt');
    // тот же чат во второй раз (аварийный повтор вне латча): копия не теряется
    h.setConv('0362260d', MSGS_A);
    h.dl('0362260d', 95, 'threshold');
    expect(h.downloads[2].file).toBe('gemini-0362260d-2026-08-31_09-05-2.txt');
    // GSA-теги логов не протекли
    expect(h.logs.join('\n')).not.toContain('site=google_search');
  });
});

// =====================================================================================
// 3-б) O-11 (раунд 2): fire-путь (maybeAutoExport → единственная точка скачивания).
// Живой прогон GSA 10:49: два файра РАЗНЫХ чатов в одну минуту (18 c разрыв) дали
// ОДИНАКОВОЕ имя файла — Chrome сам добавил « (1)». Здесь тот же сценарий через реальный
// fire-путь: последовательный вызов дважды, второй файл = первое имя + '-2'.
// =====================================================================================
describe('O-11-2: два файра разных чатов в одну минуту (fire-путь, живой лог 10:49)', () => {
  const FIRE_SCOPE = 'with (ctx) { ' +
    fnDecl(CONTENT, 'aiCmAutoExportConvId') + '\n' +
    fnDecl(CONTENT, 'aiCmGsaProbeRunningFor') + '\n' +
    fnDecl(CONTENT, 'aiCmGsaAutoExportSkipLog') + '\n' +
    fnDecl(CONTENT, 'maybeAutoExport') + '\n' +
    fnDecl(CONTENT, 'aiCmExportBaseSource') + '\n' +
    fnDecl(CONTENT, 'aiCmAutoExportStartDownload') + '\n' +
    fnDecl(CONTENT, 'doAutoExportDownload') + '\n' +
    ' return { fire: maybeAutoExport }; }';
  const makeFire = new Function('ctx', FIRE_SCOPE);

  const MSGS_A = [
    { role: 'user', text: 'ПЕРВЫЙ вопрос' },
    { role: 'assistant', text: 'ПЕРВЫЙ ответ' }
  ];
  const MSGS_B = [
    { role: 'user', text: 'ВТОРОЙ вопрос' },
    { role: 'assistant', text: 'ВТОРОЙ ответ' }
  ];

  function fireCtx(over) {
    const downloads = [];
    const logs = [];
    const state = { cid: 'THREAD-A', msgs: MSGS_A };
    const ctx = {
      autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' },
      autoExportPctBySite: {},
      autoExportLastConvId: '',
      autoExportLastPct: -1,
      autoExportFired: {},
      aiCmAutoExportNamesUsed: {}, // O-11: реестр занятых имён (как в core/export-manager.js)
      notCompleteLogged: {},
      sessionFiredCache: {},
      aiCmGsaProbeByThread: {},
      aiCmGsaProbeRunning: false,
      aiCmLoaderRunningByConv: {},
      aiCmCursorLiveByConv: {},
      aiCmArchiveCountFor: function () { return 0; },
      aiCmLowConfidenceByConv: {},
      baseSeen: true,
      baseComplete: true,
      baseCount: 4,
      lastEmitConvId: state.cid,
      lastThreadId: state.cid,
      lastBaseTexts: MSGS_A.map((m) => m.text),
      lastResolvedModelId: 'gemini-2.5-flash',
      lastSnapshotModelName: MODEL,
      maxTokenCount: 1000,
      currentAdapter: { siteName: GSA },
      getCurrentConvId: function () { return ''; }, // у GSA URL-id нет — cid = threadId
      buildHistoryMessages: function () { return state.msgs.slice(); },
      aiCmDumpTurnsSnapshot: function () { },
      aiCmCancelDeferredHistWrite: function () { },
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      console: { error: function () { } },
      ModelConfig: { getModel: function () { return { name: MODEL }; } },
      chrome: { storage: { session: { set: function () { }, remove: function () { } } } },
      window: {
        location: { hostname: 'www.google.com' },
        AiCmExportBuilders: {
          buildTxtFromHistory: function (hist) { return hist.messages.map((m) => m.role + '::' + m.text).join('\n'); },
          buildMdFromHistory: function (hist) { return hist.messages.map((m) => m.text).join('\n'); },
          buildJsonFromHistory: Builders.buildJsonFromHistory,
          downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); }
        },
        AiCmExportEmitPipeline: P
      }
    };
    Object.assign(ctx, over || {});
    const api = makeFire(ctx);
    return {
      ctx: ctx, downloads: downloads, logs: logs, fire: api.fire,
      // смена разговора GSA: cid стреляющего треда + его история (новый чат в той же вкладке)
      setConv: function (cid, msgs) {
        state.cid = cid;
        state.msgs = msgs || state.msgs;
        ctx.lastEmitConvId = cid;
        ctx.lastThreadId = cid;
        ctx.lastBaseTexts = state.msgs.map((m) => m.text);
      }
    };
  }

  afterEach(() => jest.restoreAllMocks());

  test('живой сценарий: второй файр в ту же минуту → второе имя = первое + "-2"', () => {
    mockNow();
    const h = fireCtx({});
    h.setConv('3yyqar0d', MSGS_A);
    h.fire(95); // 10:49:05 — первый чат
    h.setConv('kSqqasn1', MSGS_B);
    h.fire(95); // ~10:49:23 — второй чат, та же минута
    expect(h.downloads.length).toBe(2);
    const f1 = h.downloads[0].file;
    const f2 = h.downloads[1].file;
    expect(f1).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.txt');
    expect(f2).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-2.txt');
    expect(f2).toBe(f1.replace(/\.txt$/, '-2.txt')); // «второе имя = первое + -2»
    // обе копии целы и каждая несёт свой разговор (« (1)» от Chrome больше не нужен)
    expect(h.downloads[0].content).toContain('ПЕРВЫЙ');
    expect(h.downloads[1].content).toContain('ВТОРОЙ');
    expect(h.downloads[0].content.charAt(0)).toBe('\uFEFF');
    expect(h.downloads[1].content.charAt(0)).toBe('\uFEFF');
    // в логе — две fired-строки с РАЗНЫМИ именами (как требует живой лог)
    const firedLines = h.logs.filter((l) => l.indexOf('[AI CM][auto-export] fired convId=') === 0);
    expect(firedLines.length).toBe(2);
    expect(firedLines[0]).toContain('file=' + f1);
    expect(firedLines[1]).toContain('file=' + f2);
    expect(Object.keys(h.ctx.aiCmAutoExportNamesUsed).sort()).toEqual([f1, f2].sort());
  });

  test('резерв имени синхронен ДО старта скачивания: повторный вход ИЗ downloadBlob получает -2', () => {
    mockNow();
    const h = fireCtx({});
    // downloadBlob первого файра сам синхронно запускает второй файр (повторный вход/
    // асинхронный дозапрос O-18 успел в момент старта записи): имя первого файла уже
    // зарезервировано, поэтому второй обязан получить -2, а не то же имя.
    h.ctx.window.AiCmExportBuilders.downloadBlob = function (content, file, mime) {
      h.downloads.push({ content: content, file: file, mime: mime });
      if (h.downloads.length === 1) {
        h.setConv('THREAD-B', MSGS_B);
        h.fire(95);
      }
    };
    h.setConv('THREAD-A', MSGS_A);
    h.fire(95);
    expect(h.downloads.length).toBe(2);
    expect(h.downloads[0].file).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05.txt');
    expect(h.downloads[1].file).toBe('ai-context-monitor-google_search-Gemini-2.5-Flash-2026-08-31-09-05-2.txt');
    expect(h.downloads[0].file).not.toBe(h.downloads[1].file);
  });
});

// =====================================================================================
// 3-в) O-11 (раунд 2): пины единственной точки старта скачивания автоэкспорта.
// Точка — aiCmAutoExportStartDownload: (1) консультация реестра, (2) синхронный резерв
// имени ДО старта, (3) B.downloadBlob. Все сайты (в т.ч. GSA) приходят в неё одним путём.
// =====================================================================================
describe('O-11-2: пины единственной точки старта скачивания (все сайты, включая GSA)', () => {
  afterEach(() => jest.restoreAllMocks());

  const single = fnDecl(CONTENT, 'aiCmAutoExportStartDownload');
  const body = fnDecl(CONTENT, 'doAutoExportDownload');
  const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
  const GSA_SRC = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
  const GSA_ADAPTER_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'google-search-adapter.js'), 'utf8');

  test('точка: консультация реестра → СИНХРОННЫЙ резерв имени → старт скачивания', () => {
    const iConsult = single.indexOf('Pdl.isFileNameTaken(used, file)');
    const iDisamb = single.indexOf('Pdl.disambiguateFileName(file, used)');
    const iReserve = single.indexOf('used[file] = 1');
    const iDownload = single.indexOf('Bdl.downloadBlob(content, file');
    expect(iConsult).toBeGreaterThan(-1);
    expect(iDisamb).toBeGreaterThan(-1);
    expect(iReserve).toBeGreaterThan(-1);
    expect(iDownload).toBeGreaterThan(-1);
    expect(iReserve).toBeLessThan(iDownload); // регистрация ДО старта, не после
    expect(iConsult).toBeLessThan(iReserve);
    // байты/формат/маска: mime выбирается по fmt ровно как раньше
    expect(single).toContain("fmt === 'md' ? 'text/markdown' : (fmt === 'json' ? 'application/json' : 'text/plain;charset=utf-8')");
  });

  test('doAutoExportDownload не скачивает сам: ровно один старт через точку (все сайты)', () => {
    expect(body).not.toContain('B.downloadBlob');
    expect(body.split('aiCmAutoExportStartDownload(content, file, fmt)').length - 1).toBe(1);
    // в export-manager.js вызов downloadBlob ровно один — в единственной точке
    expect(MGR_SRC.split('.downloadBlob(').length - 1).toBe(1);
    expect(fnDecl(CONTENT, 'aiCmAutoExportStartDownload')).toContain('Bdl.downloadBlob(content, file');
  });

  test('все триггеры автоэкспорта ведут в doAutoExportDownload (порог / base-complete / pre-trim)', () => {
    expect(MGR_SRC).toContain("doAutoExportDownload(cid, percentage, 'threshold')");
    expect(MGR_SRC).toContain("doAutoExportDownload(cid, pctBc64, 'base-complete');");
    expect(MGR_SRC).toContain("doAutoExportDownload(cid, pct, 'pre-trim');");
  });

  test('GSA-путь (перехватчик и адаптер) собственного скачивания не имеет — обхода реестра нет', () => {
    expect(GSA_SRC).not.toContain('downloadBlob');
    expect(GSA_SRC).not.toContain('createObjectURL');
    expect(GSA_SRC).not.toContain('a.download');
    expect(GSA_ADAPTER_SRC).not.toContain('downloadBlob');
    expect(GSA_ADAPTER_SRC).not.toContain('createObjectURL');
    // имя GSA строится тем же единственным источником и с тем же реестром
    expect(body).toContain('P.buildGsaExportFileName(siteNameD, gsaModelD, lowConfD, fmt, namesUsedD);');
  });

  test('M-10/F4 байтово прежние: маска GSA и имя прочих сервисов не изменились', () => {
    mockNow();
    expect(P.buildGsaExportFileName(GSA, MODEL, false, 'txt')).toMatch(NAME_RE);
    expect(P.buildGsaExportFileName(GSA, 'Gemini (Search AI)', false, 'md'))
      .toBe('ai-context-monitor-google_search-Gemini-Search-AI-2026-08-31-09-05.md');
    expect(P.buildExportFileName('gemini', '0362260d', 'threshold', false, 'txt'))
      .toBe('gemini-0362260d-2026-08-31_09-05.txt');
    expect(P.buildExportFileName('deepseek', 'abcdef12', 'base-complete', false, 'json'))
      .toBe('deepseek-abcdef12-2026-08-31_09-05-base-complete.json');
  });
});

// =====================================================================================
// 4) Пин M-10/F4: шаблон РУЧНОГО экспорта не изменился
// =====================================================================================
describe('O-11: шаблон ручного экспорта байтово прежний (M-10/F4)', () => {
  afterEach(() => jest.restoreAllMocks());

  // Реальный buildFileName ручного пути (options/options.js) в песочнице: pad2 и
  // cachedHistory передаются снаружи (аргумент hist всегда задан — фолбэк не нужен).
  const buildManual = new Function(
    'pad2', 'cachedHistory',
    fnDecl(OPTIONS_JS, 'buildFileName') + '\n return buildFileName;'
  )(function (n) { return (n < 10 ? '0' : '') + n; }, null);

  test('источник ручного пути (options.js buildFileName) — байтово прежняя строка', () => {
    expect(OPTIONS_JS).toContain("var lowConfPrefix = (hist && hist.isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';");
    expect(OPTIONS_JS).toContain("return lowConfPrefix + 'ai-context-monitor-' + safeSite + '-' + safeModel + '-' + stamp + '.' + ext;");
  });

  test('имя автоэкспорта GSA == имя ручного экспорта (тот же шаблон, один в один)', () => {
    mockNow();
    const hist = { site: GSA, model: 'Gemini (Search AI)' };
    expect(buildManual('txt', hist)).toBe('ai-context-monitor-google_search-Gemini-Search-AI-2026-08-31-09-05.txt');
    expect(P.buildGsaExportFileName(GSA, 'Gemini (Search AI)', false, 'txt')).toBe(buildManual('txt', hist));
    expect(P.buildGsaExportFileName(GSA, 'Gemini (Search AI)', false, 'md')).toBe(buildManual('md', hist));
    expect(P.buildGsaExportFileName(GSA, 'Gemini (Search AI)', false, 'json')).toBe(buildManual('json', hist));
    // [LOW CONFIDENCE]_ — та же семантика (baseComplete=0 / isLowConfidenceBase=true)
    expect(P.buildGsaExportFileName(GSA, 'm', true, 'txt'))
      .toBe(buildManual('txt', { site: GSA, model: 'm', isLowConfidenceBase: true }));
    expect(P.buildGsaExportFileName(GSA, 'm', false, 'txt')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
    // пустая модель → 'model' (как в ручном пути)
    expect(P.buildGsaExportFileName(GSA, '', false, 'txt')).toBe(buildManual('txt', { site: GSA, model: '' }));
  });

  test('шаблон ручного экспорта на месте: NAME_RE-геометрия имени GSA не изменилась', () => {
    mockNow();
    expect(P.buildGsaExportFileName(GSA, MODEL, false, 'txt')).toMatch(NAME_RE);
  });
});
