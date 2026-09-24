/**
 * O-21 (ДИАГНОСТИКА, режим ИЗМЕРЕНИЯ): инструментирование DOM-экстрактора DeepSeek.
 *
 * Живой симптом O-21: под соседним расширением (Better DeepSeek) DOM-экстрактор отдавал
 * msgs=3 при сетевых msgs=6. Живые артефакты утеряны, механизм — неподтверждённая гипотеза,
 * поэтому инструментирование обязано быть ЧИСТЫМ ИЗМЕРЕНИЕМ. Контракт, который здесь
 * удостоверяется:
 *
 *   1. строка `[AI CM][diag] o21-dom-extract` печатается ТОЛЬКО под гейтом aiCmDebug
 *      (sessionStorage 'aiCmDebug' === '1' ИЛИ чекбокс «Подробные логи» →
 *      window.__aiCmDebugLogs): гейт выключен → ноль строк и ноль счётчиков;
 *   2. строка несёт счётчики totalFound/extracted/skipNested/skipReasoningOnly/skipEmpty/
 *      skipNoRealContent, сэмпл классов первых ТРЁХ узлов и детекцию инъекций соседа
 *      (маркеры BetterDeepSeek/BDS:/better-deepseek/bds- в первых 50 КБ HTML);
 *   3. строка `[AI CM][diag] o21-source-select` печатается в ЕДИНОЙ точке выбора источника
 *      базы (core/export-manager.js:aiCmCollectExportSource) и несёт domMsgs/netMsgs/
 *      sourceSelected/reason; маркер SCOPED по сайту — чужие сайты строку не получают;
 *   4. БАЙТЫ ПОВЕДЕНИЯ ПРЕЖНИЕ: messages/роли/hiddenReasoning из extractMessages() при
 *      включённом и выключенном гейте идентичны (инструментирование — только чтение);
 *   5. печать идёт каноническим хелпером utils/debug.js:aiCmDiagLine — не своим форматом.
 *
 * Песочницы берут РЕАЛЬНЫЕ aiCmDiagOn/aiCmDiagLine. Адаптер грузится в JSDOM вместе с
 * настоящим utils/debug.js (как в content_scripts манифеста), поэтому гейт, канал печати и
 * адаптер делят ОДИН глобальный мир — ровно как в браузере.
 */

const fs = require('fs');
const path = require('path');

// jsdom-окружение jest не даёт TextEncoder/TextDecoder — без полифилла require('jsdom')
// падает на whatwg-url ещё до старта сьюта (конвенция проекта: tests/qwen-stream-frames.test.js).
const utilEnc = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = utilEnc.TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = utilEnc.TextDecoder;

const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const ADAPTER_DIR = path.join(ROOT, 'adapters');
const ADAPTER_SRC = fs.readFileSync(path.join(ADAPTER_DIR, 'deepseek-adapter.js'), 'utf8');
const BASE_ADAPTER_SRC = fs.readFileSync(path.join(ADAPTER_DIR, 'base-adapter.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const P = require(path.join(ROOT, 'utils', 'export-emit-pipeline.js'));

const PREFIX = '[AI CM][diag] ';
const TAG_EXTRACT = PREFIX + 'o21-dom-extract';
const TAG_SELECT = PREFIX + 'o21-source-select';

/** Рез по балансу фигурных скобок (конвенция пинов этого репозитория). */
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

// =====================================================================================
// (1) DOM-экстрактор: счётчики, сэмпл классов, детекция инъекций соседа
// =====================================================================================
//
// Фикстура собрана так, чтобы КАЖДАЯ ветка пропуска была представлена ровно один раз, и
// сумма счётчиков сходилась с totalFound:
//   #1 user-пузырь                     → extracted
//   #2 assistant-пузырь                → extracted
//   #3 .ds-markdown.ds-message внутри #2 → skipNested (родитель — ds-message)
//   #4 ds-think без ds-markdown         → skipReasoningOnly (reasoning, не ход)
//   #5 текст «.» без букв/цифр          → skipNoRealContent (артефакт интерфейса)
//   #6 пустой пузырь                    → skipEmpty (content === '')
// totalFound = 6, extracted = 2, пропусков = 4.
const DOM_HTML = `<!DOCTYPE html><html><body>
  <div class="ds-message ds-user d29f3d7d"><div class="fbb737a4">Как выбрать ноутбук?</div></div>
  <div class="ds-message ds-assistant"><div class="ds-markdown ds-message"><p class="ds-markdown-paragraph">Смотрите на экран и клавиатуру.</p></div></div>
  <div class="ds-message ds-think">Размышления: сначала вспомню про рассеяние.</div>
  <div class="ds-message ds-user"><div class="qq">.</div></div>
  <div class="ds-message ds-user"></div>
</body></html>`;

// Тот же DOM + маркеры соседа Better DeepSeek в первом экране HTML (инъекция как факт).
// Набор маркеров задан ТОЧНО: 'BetterDeepSeek' (текст) и 'bds-' (id корня). 'BDS:' и
// 'better-deepseek' в фикстуру НЕ заведены — пин ловит и ложные срабатывания.
const DOM_HTML_INJECTED = DOM_HTML.replace(
  '<div class="ds-message ds-user d29f3d7d">',
  '<div id="bds-root">BetterDeepSeek</div>\n  <div class="ds-message ds-user d29f3d7d">'
);

/**
 * Грузит реальные base-adapter + deepseek-adapter в JSDOM вместе с настоящим utils/debug.js.
 * Гейт выставляется ДО первого вызова extractMessages(); лог конструктора отбрасывается.
 */
function loadAdapter(opts) {
  const o = opts || {};
  const dom = new JSDOM(o.html || DOM_HTML, {
    url: 'https://chat.deepseek.com/a/chat/s/convO21',
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole()
  });
  const logs = [];
  // Канал печати канонического aiCmDiagLine — console.log ТОГО ЖЕ мира (как в браузере).
  dom.window.console.log = function (m) { logs.push(String(m)); };
  // Настоящий utils/debug.js целиком: даёт и debugLog, и канонические aiCmDiagOn/aiCmDiagLine.
  dom.window.eval(DEBUG_SRC);
  dom.window.eval(BASE_ADAPTER_SRC + '\n' + ADAPTER_SRC + '\nwindow.DeepSeekAdapter = DeepSeekAdapter;');
  if (o.gate === 'session') dom.window.sessionStorage.setItem('aiCmDebug', '1');
  if (o.gate === 'checkbox') dom.window.__aiCmDebugLogs = true;
  const adapter = new dom.window.DeepSeekAdapter();
  logs.length = 0;                       // «Инициализирован» из конструктора — не предмет O-21
  return { dom: dom, logs: logs, adapter: adapter };
}

/** Строки канонического канала (только префикс aiCmDiagLine). */
function diagAll(logs) { return logs.filter(function (s) { return s.indexOf(PREFIX) === 0; }); }
function linesOf(logs, tag) {
  return diagAll(logs).filter(function (s) { return s.indexOf(tag + ' ') === 0; });
}
function onlyLine(logs, tag) {
  const l = linesOf(logs, tag);
  expect(l).toHaveLength(1);
  return l[0];
}

describe('O-21: гейт aiCmDebug — строка o21-dom-extract только под гейтом', () => {
  test('гейт ВЫКЛ → ни одной строки и ни одного счётчика', () => {
    const d = loadAdapter({ gate: 'off' });
    const msgs = d.adapter.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(diagAll(d.logs)).toEqual([]);          // молчание канонического канала целиком
    expect(linesOf(d.logs, TAG_EXTRACT)).toHaveLength(0);
  });

  test('гейт ВКЛ через sessionStorage aiCmDebug=1 → счётчики всех веток пропуска', () => {
    const d = loadAdapter({ gate: 'session' });
    d.adapter.extractMessages();
    const line = onlyLine(d.logs, TAG_EXTRACT);
    expect(line).toContain('site=deepseek');
    expect(line).toContain('totalFound=6');
    expect(line).toContain('extracted=2');
    expect(line).toContain('skipNested=1');
    expect(line).toContain('skipReasoningOnly=1');
    expect(line).toContain('skipEmpty=1');
    expect(line).toContain('skipUnknown=0');
    expect(line).toContain('skipNoRealContent=1');
  });

  test('гейт ВКЛ через чекбокс «Подробные логи» (window.__aiCmDebugLogs) — те же счётчики', () => {
    const d = loadAdapter({ gate: 'checkbox' });
    d.adapter.extractMessages();
    const line = onlyLine(d.logs, TAG_EXTRACT);
    expect(line).toContain('totalFound=6');
    expect(line).toContain('extracted=2');
    expect(line).toContain('skipNested=1');
  });

  test('сэмпл классов — первые ТРИ узла выборки (классы DeepSeek ротируются)', () => {
    const d = loadAdapter({ gate: 'session' });
    d.adapter.extractMessages();
    const line = onlyLine(d.logs, TAG_EXTRACT);
    expect(line).toContain('classesSample=ds-message ds-user d29f3d7d | ds-message ds-assistant | ds-markdown ds-message');
  });

  test('инъекции соседа не найдены → neighborInjections=(нет)', () => {
    const d = loadAdapter({ gate: 'session' });
    d.adapter.extractMessages();
    expect(onlyLine(d.logs, TAG_EXTRACT)).toContain('neighborInjections=(нет)');
  });

  test('маркеры Better DeepSeek в первых 50 КБ HTML → neighborInjections перечислены', () => {
    const d = loadAdapter({ gate: 'session', html: DOM_HTML_INJECTED });
    d.adapter.extractMessages();
    const line = onlyLine(d.logs, TAG_EXTRACT);
    // 'BetterDeepSeek' — по тексту, 'bds-' — по id инъектированного корня; 'BDS:' и
    // 'better-deepseek' (строка-маркер) в фикстуре не заведены и в списке быть не должны.
    expect(line).toContain('neighborInjections=BetterDeepSeek,bds-');
    expect(line).not.toContain('BDS:');
  });

  test('сумма счётчиков сходится с totalFound (ни один узел не потерян в измерении)', () => {
    const d = loadAdapter({ gate: 'session' });
    const msgs = d.adapter.extractMessages();
    const line = onlyLine(d.logs, TAG_EXTRACT);
    const num = (k) => Number((line.match(new RegExp(k + '=(\\d+)')) || [])[1]);
    const skip = num('skipNested') + num('skipReasoningOnly') + num('skipEmpty') +
      num('skipUnknown') + num('skipNoRealContent');
    expect(num('extracted') + skip).toBe(num('totalFound'));
    expect(num('extracted')).toBe(msgs.length);
  });
});

describe('O-21: байты поведения прежние (инструментирование — только чтение)', () => {
  test('messages/роли/hiddenReasoning при гейте вкл и выкл идентичны', () => {
    const off = loadAdapter({ gate: 'off' }).adapter.extractMessages();
    const on = loadAdapter({ gate: 'session' }).adapter.extractMessages();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  test('O-7 регресс: состав/роли/склейка reasoning не изменились', () => {
    const d = loadAdapter({ gate: 'session' });
    const msgs = d.adapter.extractMessages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs.map((m) => m.content)).toEqual([
      'Как выбрать ноутбук?',
      'Смотрите на экран и клавиатуру.'
    ]);
    // «висячий» reasoning отдельного узла приклеен к последнему assistant-ходу (O-7/O-15),
    // служебная шапка «Размышления:» снята, в content он НЕ входит.
    expect(msgs[1].hiddenReasoning).toBe('сначала вспомню про рассеяние.');
    expect(msgs[1].content).not.toContain('рассеяние');
    // артефакт «.» и пустой пузырь сообщениями не стали
    expect(msgs.some((m) => m.content === '.')).toBe(false);
    expect(msgs).toHaveLength(2);
  });
});

// =====================================================================================
// (2) Выбор источника базы DOM vs network: core/export-manager.js:aiCmCollectExportSource
// =====================================================================================
//
// Песочница точки входа: РЕАЛЬНЫЕ функции core/export-manager.js (sanitizeGeminiText →
// aiCmSanitizeEmitUserTexts → aiCmCollectExportSource) с каноническими aiCmDiagOn/aiCmDiagLine
// (границы и набор — как в O-40-сьюте, где эта песочница уже проверена).
const DEBUG_API = new Function(
  fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
  ' return { on: aiCmDiagOn, line: aiCmDiagLine };')();

const EMITTER_SCOPE = 'with (ctx) { ' +
  'var aiCmIncludeHiddenInExport = false;' +
  'var aiCmSanitizeSkipLogged = {};' +
  fnDecl(MGR_SRC, 'sanitizeGeminiText') + '\n' +
  fnDecl(MGR_SRC, 'aiCmSanitizeDebugOn') + '\n' +
  fnDecl(MGR_SRC, 'aiCmLogSanitizeSkip') + '\n' +
  fnDecl(MGR_SRC, 'aiCmEmitEntryDiag') + '\n' +
  fnDecl(MGR_SRC, 'aiCmSanitizeEmitUserTexts') + '\n' +
  fnDecl(MGR_SRC, 'aiCmCollectExportSource') + '\n' +
  ' return { emit: aiCmCollectExportSource }; }';
const makeEmitterFn = new Function('ctx', EMITTER_SCOPE);

function gateOn() { window.sessionStorage.setItem('aiCmDebug', '1'); }
function gateOff() {
  try { window.sessionStorage.removeItem('aiCmDebug'); } catch (eS) { }
  try { delete window.__aiCmDebugLogs; } catch (eW) { }
}

function diagLines() {
  const spy = console.log;
  if (!spy || !spy.mock || !spy.mock.calls) return [];
  return spy.mock.calls.map((a) => String(a[0])).filter((s) => s.indexOf(PREFIX) === 0);
}
function selectLines() {
  return diagLines().filter((s) => s.indexOf(TAG_SELECT + ' ') === 0);
}

function makeEmitter(opts) {
  const o = opts || {};
  const ctx = {
    // РЕАЛЬНЫЙ пайплайн (как в контент-скрипте): pickExportSource(true,*) → 'network'.
    // Без него исполнялся бы фолбэк-тернарник, который для (baseSeen=true, texts=[]) даёт
    // 'adapter' — то есть НЕ продакшн-путь. Пин держим на продакшн-ветке.
    window: { AiCmExportEmitPipeline: (o.noPipeline === true) ? null : P },
    console: { log: function () { }, warn: function () { }, error: function () { }, info: function () { }, debug: function () { } },
    lastBaseTexts: (o.texts || []),
    lastDetailMessages: null,
    baseSeen: (o.baseSeen === true),
    aiCmDiagOn: DEBUG_API.on,
    aiCmDiagLine: DEBUG_API.line,
    currentAdapter: {
      siteName: (o.site || 'deepseek'),
      extractMessages: function () { return new Array(o.domMsgs || 0); }
    }
  };
  return { ctx: ctx, emit: makeEmitterFn(ctx).emit };
}

describe('O-21: строка o21-source-select в точке выбора источника базы', () => {
  beforeEach(() => {
    gateOff();
    jest.spyOn(console, 'log').mockImplementation(() => { });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    gateOff();
  });

  test('сеть победила: domMsgs/netMsgs/sourceSelected/reason видны рядом', () => {
    gateOn();
    makeEmitter({ baseSeen: true, texts: ['a', 'b', 'c', 'd', 'e', 'f'], domMsgs: 3 }).emit();
    const line = selectLines();
    expect(line).toHaveLength(1);
    expect(line[0]).toContain('site=deepseek');
    expect(line[0]).toContain('domMsgs=3');       // живая пара O-21: DOM 3 при сети 6
    expect(line[0]).toContain('netMsgs=6');
    expect(line[0]).toContain('sourceSelected=network');
    expect(line[0]).toContain('reason=baseSeen+networkTexts');
  });

  test('DOM-ветка: baseSeen=false → sourceSelected=dom, reason=no-baseSeen', () => {
    gateOn();
    makeEmitter({ baseSeen: false, texts: [], domMsgs: 2 }).emit();
    const line = selectLines();
    expect(line).toHaveLength(1);
    expect(line[0]).toContain('domMsgs=2');
    expect(line[0]).toContain('netMsgs=0');
    expect(line[0]).toContain('sourceSelected=dom');
    expect(line[0]).toContain('reason=no-baseSeen');
  });

  test('сеть ожидалась, но текстов нет → sourceSelected=network, reason=baseSeen-no-networkTexts', () => {
    gateOn();
    makeEmitter({ baseSeen: true, texts: [], domMsgs: 4 }).emit();
    const line = selectLines();
    expect(line).toHaveLength(1);
    expect(line[0]).toContain('sourceSelected=network');
    expect(line[0]).toContain('reason=baseSeen-no-networkTexts');
  });

  test('фолбэк без пайплайна расходится с продакшн-ветвью — источник отражает РЕАЛЬНУЮ ветку', () => {
    // Без window.AiCmExportEmitPipeline исполняется тернарник-фолбэк: для (baseSeen=true,
    // texts=[]) он даёт 'adapter', тогда как продакшн pickExportSource — 'network'. Поэтому
    // песочница выше держит РЕАЛЬНЫЙ пайплайн: sourceSelected обязан отражать ту ветку,
    // которая реально выбрала источник, а не фолбэк срез-песочницы. Пин фиксирует расхождение.
    gateOn();
    makeEmitter({ baseSeen: true, texts: [], domMsgs: 4, noPipeline: true }).emit();
    const line = selectLines();
    expect(line).toHaveLength(1);
    expect(line[0]).toContain('sourceSelected=dom');
    expect(line[0]).toContain('reason=baseSeen-no-networkTexts');
  });

  test('гейт ВЫКЛ → ни одной строки o21-source-select', () => {
    gateOff();
    makeEmitter({ baseSeen: true, texts: ['a'], domMsgs: 1 }).emit();
    expect(selectLines()).toEqual([]);
  });

  test('SCOPED по сайту: чужой сайт строку не получает', () => {
    gateOn();
    makeEmitter({ site: 'claude', baseSeen: true, texts: ['a'], domMsgs: 1 }).emit();
    expect(selectLines()).toEqual([]);
  });

  test('read-only: байты выхода не зависят от гейта (вкл/выкл идентичны)', () => {
    gateOff();
    const off = makeEmitter({ baseSeen: true, texts: ['a', 'b'], domMsgs: 2 }).emit();
    gateOn();
    const on = makeEmitter({ baseSeen: true, texts: ['a', 'b'], domMsgs: 2 }).emit();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });
});

// =====================================================================================
// (3) Source-пины: канал печати, гейт, отсутствие «мёртвого» гейта, границы правки
// =====================================================================================
describe('O-21: source-пины инструментирования', () => {
  test('печать идёт каноном aiCmDiagLine (своего формата/консоли нет)', () => {
    expect(ADAPTER_SRC).toContain("aiCmDiagLine('o21-dom-extract'");
    expect(MGR_SRC).toContain("aiCmDiagLine('o21-source-select'");
    // ни одного собственного console.* в блоках O-21
    expect(ADAPTER_SRC).not.toContain("console.log('[AI CM][o21");
    expect(MGR_SRC).not.toContain("console.log('[AI CM][o21");
  });

  test('гейт — канонический aiCmDiagOn, а НЕ несуществующий window.aiCmDebug', () => {
    expect(ADAPTER_SRC).toContain("(typeof aiCmDiagOn === 'function') ? aiCmDiagOn() : false");
    expect(MGR_SRC).toContain("typeof aiCmDiagOn === 'function' && aiCmDiagOn()");
    // «мёртвый» гейт window.aiCmDebug не заведён нигде в проекте: он не выставляется ни одним
    // файлом, поэтому инструментирование по нему молчало бы всегда (отвергнутая версия).
    expect(ADAPTER_SRC).not.toContain('window.aiCmDebug');
    expect(MGR_SRC).not.toContain('window.aiCmDebug');
  });

  test('умолчание без хелперов: срез-песочница без aiCmDiagOn/aiCmDiagLine молчит', () => {
    const dom = new JSDOM(DOM_HTML, {
      url: 'https://chat.deepseek.com/a/chat/s/convO21',
      runScripts: 'dangerously',
      virtualConsole: new VirtualConsole()
    });
    const logs = [];
    dom.window.console.log = function (m) { logs.push(String(m)); };
    dom.window.eval('var debugLog = function () {};\n' + BASE_ADAPTER_SRC + '\n' + ADAPTER_SRC +
      '\nwindow.DeepSeekAdapter = DeepSeekAdapter;');
    const msgs = new dom.window.DeepSeekAdapter().extractMessages();
    expect(diagAll(logs)).toEqual([]);            // typeof-гард: хелперов нет → ни строки
    expect(msgs).toHaveLength(2);                 // и поведение прежнее
  });

  test('границы правки: логика извлечения/выбора источника не переписана', () => {
    // extractMessages по-прежнему решает ОДНИМ предикатом (не разложен на early-return),
    // а выбор источника — прежним pickExportSource: O-21 не добавил ни одной ветки выбора.
    expect(ADAPTER_SRC).toContain(
      'if (content && content.length > 0 && role !== \'unknown\' && this._hasRealContent(content)) {'
    );
    expect(MGR_SRC).toContain('P.pickExportSource(baseSeen === true, texts.length > 0)');
    // новые счётчики живут ТОЛЬКО в адаптере DeepSeek — прочие адаптеры не тронуты
    expect(fs.readFileSync(path.join(ADAPTER_DIR, 'gemini-adapter.js'), 'utf8')).not.toContain('o21-');
    expect(ADAPTER_SRC).not.toContain('netMsgs');
  });
});
