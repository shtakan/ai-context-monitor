/**
 * O-40: ИНСТРУМЕНТИРОВАНИЕ ЖИВОГО ЗАМЕРА + ФИКС живой формы F3.
 *
 * СИМПТОМ (живой, до фикса): sanitizeEmitMessages проходит до конца ([REASONING] снят),
 * модульный прогон на messages[0].text из JSON-артефакта снимает пару F3 (removed=1), а живой
 * txt-экспорт (deepseek-565a7cd8-2026-09-21_10-35.txt, строки 1 и 30 — теги вокруг реального
 * текста пользователя) пару СОХРАНЯЛ. Замер (o40-diag-11-19.txt.txt) показал точную причину:
 * 'o40-bds-line k=1166 firstLine=0 pair=1195 lastLine=1212 form=(нет)
 * skip=pair-not-whole-message' — пара тегов есть, но обёртывает НЕ целое сообщение.
 *
 * ФИКС (utils/export-emit-pipeline.js, ветка «Тег без измеренной формы»): если пара найдена,
 * снимаются РОВНО строки тегов — и когда пара обёртывает целое сообщение, и когда лежит ВНУТРИ
 * сообщения (текст до открывающего тега и хвост после закрывающего — байтово). Причина пропуска
 * 'pair-not-whole-message' у этой ветки БОЛЬШЕ НЕ СУЩЕСТВУЕТ; D2 ниже пинован ПОСЛЕ фикса.
 *
 * ЧТО ЗДЕСЬ ПИНИРУЕТСЯ (ровно два класса):
 *   D — под гейтом aiCmDebug на входе формы F3 печатаются диаг-строки и несут
 *       k/firstLine/pair/lastLine и причину пропуска (unpaired-tag | no-boundary), а на входе
 *       ЦЕЛОГО сообщения-инжекции причина видна через распознанную форму
 *       (form=bds-deep-code-prompt, skip=(нет), removed=1); живая форма F3 (para внутри
 *       сообщения) распознана как обёртка (form=bds-prompt-wrapper, skip=(нет), removed=1);
 *       точка входа печатает значение тумблера aiCmIncludeHiddenInExport, выбранную ветку и
 *       числа msgsIn/msgsOut.
 *   R — без гейта НИ ОДНОЙ строки; байты выхода (сообщения и blob txt/md/json) при гейте
 *       вкл/выкл идентичны; печать идёт ТОЛЬКО каноническим хелпером utils/debug.js
 *       (aiCmDiagLine) — своего формата/консоли в инструментировании нет; вызовы в чужом
 *       коде защищены typeof-гардом (срез-песочницы без хелпера видят прежнее поведение 1:1);
 *       регресс существующего набора O-40 (tests/deepseek-o40-better-deepseek-sanitation.test.js)
 *       обеспечен прогоном полного сьюта и не переписанными ожиданиями.
 *
 * Маркеры (полные имена, ищутся по префиксу '[AI CM][diag] '):
 *   o40-emit-entry — точка входа aiCmSanitizeEmitUserTexts (core/export-manager.js):
 *                    hidden=on|off, branch=includeHiddenExportBlocks|sanitizeEmitMessages|
 *                    no-pipeline, msgsIn, msgsOut;
 *   o40-emit-msg   — sanitizeEmitMessages (utils/export-emit-pipeline.js) на КАЖДОЕ сообщение:
 *                    i, len текста на входе O-40, head/tail по 40 символов (JSON-escaped),
 *                    called (факт вызова sanitizeBetterDeepSeekText), removed;
 *   o40-bds-line   — sanitizeBetterDeepSeekText на КАЖДУЮ строку-кандидат с открывающим тегом:
 *                    k, firstLine, pair, lastLine, form, skip, removed.
 *
 * Инструментирование только ЧИТАЕТ уже посчитанные значения. Единственное изменение поведения —
 * сам фикс O-40 в ветке F3 (живая форма: снимаются только строки тегов); ветки измеренных форм
 * F1-F6, точка входа и байты прочих входов не менялись (R-пины ниже).
 */
const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const buildReferenceText = require('../utils/buildReferenceText.js');

const ROOT = path.join(__dirname, '..');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');

const PREFIX = '[AI CM][diag] ';
const TAG_ENTRY = 'o40-emit-entry';
const TAG_MSG = 'o40-emit-msg';
const TAG_LINE = 'o40-bds-line';

const BDS_OPEN = '<BetterDeepSeek>';
const BDS_CLOSE = '</BetterDeepSeek>';
const DEEP_CODE_HEAD = '[DEEP_CODE_MODE_ACTIVE]';

// =====================================================================================
// ФИКСТУРЫ: те же байтовые опоры артефакта, что в tests/deepseek-o40-...test.js
// (компактные, но структурно 1:1 — заголовочная строка формы + граница закрытия/усечения).
// =====================================================================================
const USER_PROMPT = [
  'ИНСТРУКЦИЯ ДЛЯ ИИ-АРХИТЕКТОРА (ПРОТОКОЛ ПРАВДЫ)',
  'Ты — ведущий архитектор и аудитор проекта ai-context-monitor.'
].join('\n');

// F3 (артефакт 949-978): пара тегов обёртывает ЦЕЛОЕ сообщение — реальный текст пользователя.
const F3 = BDS_OPEN + '\n' + USER_PROMPT + '\n' + BDS_CLOSE;

// ЖИВОЙ симптом: та же пара F3, но сообщение ДЛИННЕЕ пары (после закрывающего тега — тело
// тул-результата). До фикса O-40 такую пару не трогал (skip=pair-not-whole-message); после
// фикса снимаются РОВНО строки тегов, хвост — байтово.
const LIVE_TAIL = '<local_file_read>\n' +
  '{"path": "C:/Users/oleg/Desktop/Prompts/ai-context-monitor-v2.0.10/PROJECT_HANDOFF.md"}\n' +
  '</local_file_read>';
const LIVE_F3 = F3 + '\n\n' + LIVE_TAIL;
// Ожидание после фикса: теги сняты, текст пользователя и хвост — байтово.
const LIVE_F3_EXPECT = USER_PROMPT + '\n\n' + LIVE_TAIL;
// Тот же живой замер, но с телом сообщения И ДО пары (диаг-лог o40-diag-11-19.txt.txt:
// k=1166 > firstLine=0 и pair=1195 < lastLine=1212 — то же соотношение индексов).
const LIVE_HEAD = 'тело сообщения перед инъекцией';

// F1 (артефакт 1-257): ЦЕЛОЕ сообщение-инжекция — открывающий тег + измеренная опорная строка.
const F1 = BDS_OPEN + '\n' + DEEP_CODE_HEAD + '\nDeepCode mode is ENABLED.\n' + BDS_CLOSE;
// F2 (артефакт 259-947) и F4 (980-982): целые сообщения-инжекции других измеренных форм.
const F2 = BDS_OPEN + '\n' + 'You are Better DeepSeek. You have access to specialized tools.\n' +
  'The system prompt has ended. User prompt:\n' + BDS_CLOSE;
const F4 = BDS_OPEN + "\nUser's System Date & Time: 19.09.2026, 20:40:27\n" + BDS_CLOSE;
// F5/F6 (артефакт 999-1191 / 1223-1415): спан внутри конверта <original_task>, усечён эхом.
const F5 = '<original_task>\n' + BDS_OPEN + '\n' + DEEP_CODE_HEAD + '\n...[truncated]\n</original_task>';
const F6 = '<original_task>\n' + BDS_OPEN + '\n' + DEEP_CODE_HEAD + '\n...[truncated]\n</original_task>';

const PLAIN = 'Обычный ответ ассистента без инъекций.';

/** Последняя строка текста (для точных ожиданий pair/lastLine). */
const F3_LAST = F3.split('\n').length - 1;                 // 3
const LIVE_LAST = LIVE_F3.split('\n').length - 1;          // 7

// =====================================================================================
// Канонический гейт: РЕАЛЬНЫЕ aiCmDiagOn/aiCmDiagLine из utils/debug.js, объявленные в
// песочнице как в контент-скрипте (общий глобальный мир; sessionStorage aiCmDebug / чекбокс
// window.__aiCmDebugLogs). Пайплайн (require) ищет aiCmDiagLine свободным идентификатором.
// =====================================================================================
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

const DEBUG_API = new Function(
  fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
  ' return { on: aiCmDiagOn, line: aiCmDiagLine };')();

beforeAll(() => {
  global.aiCmDiagOn = DEBUG_API.on;
  global.aiCmDiagLine = DEBUG_API.line;
});

afterAll(() => {
  try { delete global.aiCmDiagOn; } catch (e1) { }
  try { delete global.aiCmDiagLine; } catch (e2) { }
});

beforeEach(() => {
  window.buildReferenceText = buildReferenceText;
  gateOff();
  jest.spyOn(console, 'log').mockImplementation(() => { });
});

afterEach(() => {
  jest.restoreAllMocks();
  gateOff();
});

function gateOn() { window.sessionStorage.setItem('aiCmDebug', '1'); }
function gateOff() {
  try { window.sessionStorage.removeItem('aiCmDebug'); } catch (eS) { }
  try { delete window.__aiCmDebugLogs; } catch (eW) { }
}

/** Все диаг-строки текущего прогона (только префикс канонического хелпера). */
function diagLines() {
  const spy = console.log;
  if (!spy || !spy.mock || !spy.mock.calls) return [];
  return spy.mock.calls.map((a) => String(a[0])).filter((s) => s.indexOf(PREFIX) === 0);
}

function linesOf(tag) {
  return diagLines().filter((s) => s.indexOf(PREFIX + tag + ' ') === 0);
}

function onlyLine(tag) {
  const l = linesOf(tag);
  expect(l).toHaveLength(1);
  return l[0];
}

/** JSON-escaped head/tail — ровно то, что печатает инструментирование. */
function head40(text) { return JSON.stringify(String(text).slice(0, 40)); }
function tail40(text) { const s = String(text); return JSON.stringify(s.slice(Math.max(0, s.length - 40))); }

// =====================================================================================
// D-ПИНЫ (pipeline): строка на каждое сообщение и на каждую строку-кандидат
// =====================================================================================
describe('O-40 D: диаг-строки o40-emit-msg / o40-bds-line', () => {
  test('D1: F3 целым сообщением — строка на сообщение (i/len/head/tail/called/removed)', () => {
    gateOn();
    const res = P.sanitizeEmitMessages([{ role: 'user', text: F3, id: 'u-f3' }]);
    expect(res.messages[0].text).toBe(USER_PROMPT);        // поведение O-40 прежнее
    const msg = onlyLine(TAG_MSG);
    expect(msg).toContain('i=0');
    expect(msg).toContain('len=' + F3.length);
    expect(msg).toContain('head=' + head40(F3));
    expect(msg).toContain('tail=' + tail40(F3));
    expect(msg).toContain('called=1');
    expect(msg).toContain('removed=1');
  });

  test('D1: F3 целым сообщением — строка-кандидат с k/firstLine/pair/lastLine и формой обёртки', () => {
    gateOn();
    P.sanitizeEmitMessages([{ role: 'user', text: F3, id: 'u-f3' }]);
    const line = onlyLine(TAG_LINE);
    expect(line).toContain('k=0');
    expect(line).toContain('firstLine=0');
    expect(line).toContain('pair=' + F3_LAST);
    expect(line).toContain('lastLine=' + F3_LAST);
    expect(line).toContain('form=' + P.bdsWrapperFormId);  // обёртка F3 — распознанная форма
    expect(line).toContain('skip=(нет)');
    expect(line).toContain('removed=1');                   // итог removed в каждой строке
  });

  test('D2: живой симптом ПОСЛЕ фикса — пара F3 внутри сообщения: теги сняты, хвост байтово', () => {
    gateOn();
    const res = P.sanitizeEmitMessages([{ role: 'user', text: LIVE_F3, id: 'u-live' }]);
    expect(res.bdsRemoved).toBe(1);                        // фикс O-40: форма распознана
    expect(res.bdsForms).toEqual([P.bdsWrapperFormId]);
    expect(res.messages[0].text).toBe(LIVE_F3_EXPECT);     // сняты РОВНО строки тегов
    expect(res.messages[0].text).not.toContain(BDS_OPEN);
    expect(res.messages[0].text).not.toContain(BDS_CLOSE);
    expect(res.messages[0].text.slice(-LIVE_TAIL.length)).toBe(LIVE_TAIL);
    const line = onlyLine(TAG_LINE);
    expect(line).toContain('k=0');
    expect(line).toContain('firstLine=0');
    expect(line).toContain('pair=' + F3_LAST);
    expect(line).toContain('lastLine=' + LIVE_LAST);       // lastLine > pair — хвост после пары
    expect(line).toContain('form=' + P.bdsWrapperFormId);  // пара распознана как обёртка F3
    expect(line).toContain('skip=(нет)');                  // 'pair-not-whole-message' больше нет
    expect(line).toContain('removed=1');
    // строка на сообщение несёт тот же факт: O-40 вызвана, removed=1, head/tail — по ВХОДУ
    const msg = onlyLine(TAG_MSG);
    expect(msg).toContain('called=1');
    expect(msg).toContain('removed=1');
    expect(msg).toContain('tail=' + tail40(LIVE_F3));
  });

  test('D2: диаг-лог живого замера (k>firstLine и pair<lastLine) — форма распознана, пропуска нет', () => {
    gateOn();
    const text = LIVE_HEAD + '\n' + F3 + '\n' + LIVE_TAIL;
    const tailLines = LIVE_TAIL.split('\n').length;
    const res = P.sanitizeEmitMessages([{ role: 'user', text: text, id: 'u-live2' }]);
    expect(res.bdsRemoved).toBe(1);
    expect(res.messages[0].text).toBe(LIVE_HEAD + '\n' + USER_PROMPT + '\n' + LIVE_TAIL);
    const line = onlyLine(TAG_LINE);
    expect(line).toContain('k=1');                                   // k > firstLine
    expect(line).toContain('firstLine=0');
    expect(line).toContain('pair=' + (1 + F3_LAST));                 // закрывающий тег пары
    expect(line).toContain('lastLine=' + (1 + F3_LAST + tailLines)); // pair < lastLine
    expect(line).toContain('form=' + P.bdsWrapperFormId);
    expect(line).toContain('skip=(нет)');
    expect(line).toContain('removed=1');
  });

  test('D3: целое сообщение-инжекция — причина через распознанную форму, вырезка одна', () => {
    gateOn();
    const res = P.sanitizeEmitMessages([{ role: 'user', text: F1, id: 'u-f1' }]);
    expect(res.bdsForms).toEqual(['bds-deep-code-prompt']);
    expect(res.dropped).toBe(1);                           // целая инжекция снята существующим S5
    expect(res.messages).toHaveLength(0);
    const line = onlyLine(TAG_LINE);
    expect(line).toContain('k=0');
    expect(line).toContain('firstLine=0');
    expect(line).toContain('lastLine=' + (F1.split('\n').length - 1));
    expect(line).toContain('form=bds-deep-code-prompt');
    expect(line).toContain('skip=(нет)');
    expect(line).toContain('removed=1');
    const msg = onlyLine(TAG_MSG);
    expect(msg).toContain('called=1');
    expect(msg).toContain('removed=1');
  });

  test('D4: непарный тег → skip=unpaired-tag (k=1, pair=-1)', () => {
    gateOn();
    const text = 'до инъекции\n' + BDS_OPEN + '\n' + USER_PROMPT;
    const res = P.sanitizeEmitMessages([{ role: 'user', text: text, id: 'u-unpaired' }]);
    expect(res.bdsRemoved).toBe(0);
    expect(res.messages[0].text).toBe(text);
    const line = onlyLine(TAG_LINE);
    expect(line).toContain('k=1');
    expect(line).toContain('firstLine=0');
    expect(line).toContain('pair=-1');
    expect(line).toContain('form=(нет)');
    expect(line).toContain('skip=unpaired-tag');
    expect(line).toContain('removed=0');
  });

  test('D4: измеренная опора без границы блока → skip=no-boundary (форма распознана)', () => {
    gateOn();
    const text = BDS_OPEN + '\n' + DEEP_CODE_HEAD + '\nтекст без закрывающего тега';
    const res = P.sanitizeEmitMessages([{ role: 'user', text: text, id: 'u-nobound' }]);
    expect(res.bdsRemoved).toBe(0);
    const line = onlyLine(TAG_LINE);
    expect(line).toContain('k=0');
    expect(line).toContain('pair=-1');
    expect(line).toContain('form=bds-deep-code-prompt');
    expect(line).toContain('skip=no-boundary');
    expect(line).toContain('removed=0');
  });

  test('D5: несколько строк-кандидатов в одном тексте — строка на каждую, removed — итог', () => {
    gateOn();
    const text = F1 + '\n\n' + F5;                         // два измеренных блока (F1 и спан F5)
    const res = P.sanitizeEmitMessages([{ role: 'user', text: text, id: 'u-two' }]);
    expect(res.bdsRemoved).toBe(2);
    const lines = linesOf(TAG_LINE);
    expect(lines).toHaveLength(2);
    lines.forEach((l) => {
      expect(l).toContain('form=bds-deep-code-prompt');
      expect(l).toContain('removed=2');                    // итог один и тот же в обеих строках
    });
    expect(lines[0]).toContain('k=0');
    expect(lines[1]).toContain('k=6');
  });
});

// =====================================================================================
// D-ПИНЫ (точка входа): тумблер, ветка, числа сообщений
// =====================================================================================
const EMIT_INPUT = [
  { role: 'user', text: F1, id: 'u-f1' },                  // целая инжекция → уйдёт по S5
  { role: 'user', text: F3, id: 'u-f3' },                  // обёртка → текст пользователя
  { role: 'user', text: LIVE_F3, id: 'u-live' },           // пара внутри сообщения → сняты теги, хвост байтово
  { role: 'assistant', text: PLAIN, id: 'a-plain' }
];

/**
 * Песочница точки входа: РЕАЛЬНЫЕ функции core/export-manager.js (sanitizeGeminiText →
 * aiCmSanitizeEmitUserTexts → aiCmCollectExportSource). Канонические aiCmDiagOn/aiCmDiagLine
 * НЕ объявляются локально — разрешаются из общего глобального мира (как в контент-скрипте),
 * поэтому гейт и запись строк идут тем же каналом, что у пайплайна.
 */
const EMITTER_SCOPE = 'with (ctx) { ' +
  'var aiCmIncludeHiddenInExport = false;' +
  'var aiCmSanitizeSkipLogged = {};' +           // карта антиспама O-20 — module-level в export-manager.js
  fnDecl(MGR_SRC, 'sanitizeGeminiText') + '\n' +
  fnDecl(MGR_SRC, 'aiCmSanitizeDebugOn') + '\n' +
  fnDecl(MGR_SRC, 'aiCmLogSanitizeSkip') + '\n' +
  fnDecl(MGR_SRC, 'aiCmEmitEntryDiag') + '\n' +
  fnDecl(MGR_SRC, 'aiCmSanitizeEmitUserTexts') + '\n' +
  fnDecl(MGR_SRC, 'aiCmCollectExportSource') + '\n' +
  ' return { emit: aiCmCollectExportSource, setHidden: function (v) { aiCmIncludeHiddenInExport = (v === true); } }; }';
const makeEmitterFn = new Function('ctx', EMITTER_SCOPE);

function makeEmitter(opts) {
  const o = opts || {};
  const logs = [];
  const ctx = {
    window: {
      AiCmExportEmitPipeline: (o.noPipeline === true) ? null : P
    },
    console: {
      log: function (m) { logs.push(String(m)); },
      warn: function () { }, error: function () { }, info: function () { }, debug: function () { }
    },
    lastBaseTexts: [],
    lastDetailMessages: null,
    baseSeen: true,
    currentAdapter: { siteName: 'deepseek', extractMessages: function () { return []; } }
  };
  const api = makeEmitterFn(ctx);
  return {
    ctx: ctx,
    logs: logs,
    setHidden: api.setHidden,
    run: function (messages) {
      const msgs = messages || EMIT_INPUT;
      ctx.lastBaseTexts = msgs.map(function (m) { return m.text; });
      ctx.lastDetailMessages = msgs;
      return api.emit();
    }
  };
}

describe('O-40 D: диаг-строка o40-emit-entry (тумблер, ветка, числа)', () => {
  test('D6: OFF — hidden=off, branch=sanitizeEmitMessages, msgsIn/msgsOut', () => {
    gateOn();
    const e = makeEmitter();
    const out = e.run();
    expect(out).toHaveLength(3);                            // F1 снят по S5
    const line = onlyLine(TAG_ENTRY);
    expect(line).toContain('hidden=off');
    expect(line).toContain('branch=sanitizeEmitMessages');
    expect(line).toContain('msgsIn=' + EMIT_INPUT.length);
    expect(line).toContain('msgsOut=3');
  });

  test('D7: ON — hidden=on, branch=includeHiddenExportBlocks, длина массива сохранена', () => {
    gateOn();
    const e = makeEmitter();
    e.setHidden(true);
    const out = e.run();
    expect(out).toHaveLength(EMIT_INPUT.length);            // сырой режим ничего не снимает
    const line = onlyLine(TAG_ENTRY);
    expect(line).toContain('hidden=on');
    expect(line).toContain('branch=includeHiddenExportBlocks');
    expect(line).toContain('msgsIn=' + EMIT_INPUT.length);
    expect(line).toContain('msgsOut=' + EMIT_INPUT.length);
    // ON-путь обходит санацию: строк O-40 из пайплайна нет
    expect(linesOf(TAG_MSG)).toHaveLength(0);
    expect(linesOf(TAG_LINE)).toHaveLength(0);
  });

  test('D7: пайплайна нет — ветка no-pipeline, массив не тронут', () => {
    gateOn();
    const e = makeEmitter({ noPipeline: true });
    const out = e.run();
    expect(out).toHaveLength(EMIT_INPUT.length);
    const line = onlyLine(TAG_ENTRY);
    expect(line).toContain('branch=no-pipeline');
    expect(line).toContain('msgsIn=' + EMIT_INPUT.length);
    expect(line).toContain('msgsOut=' + EMIT_INPUT.length);
  });
});

// =====================================================================================
// R-ПИНЫ: без гейта — ноль строк; байты при гейте вкл/выкл идентичны; канал ровно один
// =====================================================================================
describe('O-40 R: гейт, байты, канал печати', () => {
  test('R1: гейт ВЫКЛ → ни одной диаг-строки (пайплайн и точка входа)', () => {
    gateOff();
    P.sanitizeEmitMessages([
      { role: 'user', text: F1, id: 'u-f1' },
      { role: 'user', text: F3, id: 'u-f3' },
      { role: 'user', text: LIVE_F3, id: 'u-live' },
      { role: 'user', text: 'до\n' + BDS_OPEN + '\n' + USER_PROMPT, id: 'u-unpaired' },
      { role: 'user', text: BDS_OPEN + '\n' + DEEP_CODE_HEAD, id: 'u-nobound' }
    ]);
    expect(diagLines()).toEqual([]);
    makeEmitter().run();
    expect(diagLines()).toEqual([]);
  });

  test('R1: гейт ВКЛ через чекбокс (window.__aiCmDebugLogs) — те же строки', () => {
    const e = makeEmitter();
    window.__aiCmDebugLogs = true;
    e.run();
    expect(onlyLine(TAG_ENTRY)).toContain('branch=sanitizeEmitMessages');
  });

  test('R2: байты выхода пайплайна при гейте вкл/выкл идентичны (сообщения и blob)', () => {
    const input = [
      { role: 'user', text: F1, id: 'u-f1' },
      { role: 'user', text: F3, id: 'u-f3' },
      { role: 'user', text: LIVE_F3, id: 'u-live' },
      { role: 'assistant', text: PLAIN, id: 'a-plain' }
    ];
    gateOff();
    const off = P.sanitizeEmitMessages(input.map((m) => Object.assign({}, m)));
    expect(diagLines()).toEqual([]);
    gateOn();
    const on = P.sanitizeEmitMessages(input.map((m) => Object.assign({}, m)));
    expect(diagLines().length).toBeGreaterThan(0);
    expect(JSON.stringify(on.messages)).toBe(JSON.stringify(off.messages));
    expect(on.bdsRemoved).toBe(off.bdsRemoved);
    expect(on.dropped).toBe(off.dropped);

    // три формата из одного эмита: байты blob не зависят от гейта
    const hist = {
      host: 'chat.deepseek.com', convId: '565a7cd8', site: 'deepseek', model: 'DeepSeek-V3',
      tokens: 4210, limit: 131072, percent: 3.2, messages: off.messages
    };
    const txtOff = Builders.buildTxtFromHistory(hist);
    const mdOff = Builders.buildMdFromHistory(hist, 'DeepSeek');
    const jsonOff = Builders.buildJsonFromHistory(hist, 'DeepSeek');
    const histOn = Object.assign({}, hist, { messages: on.messages });
    // штамп времени экспорта — единственная переменная часть сборщиков; сравниваем байты без него
    const stripStamp = (s) => String(s)
      .replace(/Дата экспорта: [^\n]*/g, 'Дата экспорта: <stamp>')
      .replace(/"exportedAt": "[^"]*"/g, '"exportedAt": "<stamp>"');
    expect(stripStamp(Builders.buildTxtFromHistory(histOn))).toBe(stripStamp(txtOff));
    expect(stripStamp(Builders.buildMdFromHistory(histOn, 'DeepSeek'))).toBe(stripStamp(mdOff));
    expect(stripStamp(Builders.buildJsonFromHistory(histOn, 'DeepSeek'))).toBe(stripStamp(jsonOff));
    expect(txtOff).toContain(USER_PROMPT);
    // ФИКС O-40: живая пара F3 внутри сообщения теряет РОВНО строки тегов — в txt ни одного
    // тега, при этом текст пользователя и хвост живого сообщения на месте (байтово)
    expect(txtOff).not.toContain(BDS_OPEN);
    expect(txtOff).not.toContain(BDS_CLOSE);
    expect(txtOff).toContain('<local_file_read>');
  });

  test('R2: точка входа — байты сообщений при гейте вкл/выкл идентичны', () => {
    gateOff();
    const eOff = makeEmitter();
    const off = eOff.run();
    expect(diagLines()).toEqual([]);
    gateOn();
    const eOn = makeEmitter();
    const on = eOn.run();
    expect(diagLines().length).toBeGreaterThan(0);
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  test('R3: печать идёт ТОЛЬКО каноном aiCmDiagLine — своего формата/консоли нет', () => {
    const seen = [];
    const canon = global.aiCmDiagLine;
    global.aiCmDiagLine = function (tag, fields) { seen.push({ tag: tag, fields: fields }); return true; };
    try {
      gateOn();
      P.sanitizeEmitMessages([{ role: 'user', text: F3, id: 'u-f3' }]);
      expect(diagLines()).toEqual([]);                     // в консоль инструментирование не пишет
      // строки-кандидаты печатаются при вызове O-40, строка на сообщение — сразу после него
      expect(seen.map((c) => c.tag)).toEqual([TAG_LINE, TAG_MSG]);
      expect(seen[0].fields).toMatchObject({
        k: 0, firstLine: 0, pair: F3_LAST, lastLine: F3_LAST,
        form: P.bdsWrapperFormId, skip: '(нет)', removed: 1
      });
      expect(seen[1].fields).toMatchObject({ i: 0, called: 1, removed: 1 });
      // точка входа — тем же каналом (никакого собственного формата)
      seen.length = 0;
      makeEmitter().run();
      expect(diagLines()).toEqual([]);
      const entry = seen.filter((c) => c.tag === TAG_ENTRY);
      expect(entry).toHaveLength(1);
      expect(entry[0].fields).toMatchObject({ hidden: 'off', branch: 'sanitizeEmitMessages' });
      // через канон идут только маркеры инструментирования этой точки — своего формата нет.
      // O-21 добавил в aiCmCollectExportSource ЧЕТВЁРТЫЙ маркер (o21-source-select — выбор
      // источника базы DOM/network), и он печатается ТЕМ ЖЕ каноническим каналом aiCmDiagLine.
      // Поэтому allow-list расширен ровно на него; инвариант пина не ослаблен: любой иной тег
      // по-прежнему означает, что у инструментирования появился собственный формат/консоль.
      seen.forEach((c) => expect([TAG_ENTRY, TAG_MSG, TAG_LINE, 'o21-source-select']).toContain(c.tag));
    } finally {
      global.aiCmDiagLine = canon;
    }
  });

  test('R3: хелпера гейта нет (срез-песочница) → поведение прежнее и ни одной строки', () => {
    const canon = global.aiCmDiagLine;
    const canonOn = global.aiCmDiagOn;
    delete global.aiCmDiagLine;
    delete global.aiCmDiagOn;
    try {
      gateOn();
      const res = P.sanitizeEmitMessages([
        { role: 'user', text: F1, id: 'u-f1' },
        { role: 'user', text: F3, id: 'u-f3' }
      ]);
      expect(res.bdsRemoved).toBe(2);
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].text).toBe(USER_PROMPT);
      expect(diagLines()).toEqual([]);
    } finally {
      global.aiCmDiagLine = canon;
      global.aiCmDiagOn = canonOn;
    }
  });

  test('R4: source-пины — инструментирование в тех же функциях и только через typeof-гард', () => {
    const msgFn = fnDecl(PIPELINE_SRC, 'sanitizeEmitMessages');
    const bdsFn = fnDecl(PIPELINE_SRC, 'sanitizeBetterDeepSeekText');
    expect(msgFn).toContain("bdsDiagLine('o40-emit-msg'");
    expect(bdsFn).toContain("bdsDiagLine('o40-bds-line'");
    [msgFn, bdsFn, fnDecl(PIPELINE_SRC, 'bdsDiagLine')].forEach((fn) => {
      expect(fn).not.toContain('console.');
      expect(fn).not.toContain('document.');
    });
    // канал ровно один: гейт спрашивается каноническим хелпером, не своим флагом
    const diagHelper = fnDecl(PIPELINE_SRC, 'bdsDiagLine');
    expect(diagHelper).toContain("typeof aiCmDiagLine !== 'function'");
    expect(diagHelper).toContain('aiCmDiagLine(tag, fields)');
    // точка входа: хелпер под typeof-гардом (срез-песочницы видят прежнее поведение)
    const entryFn = fnDecl(MGR_SRC, 'aiCmSanitizeEmitUserTexts');
    expect(entryFn).toContain('if (typeof aiCmEmitEntryDiag === \'function\') aiCmEmitEntryDiag(');
    expect(entryFn).toContain("aiCmEmitEntryDiag('no-pipeline'");
    expect(entryFn).toContain("aiCmEmitEntryDiag('includeHiddenExportBlocks'");
    expect(entryFn).toContain("aiCmEmitEntryDiag('sanitizeEmitMessages'");
    // пины существующего OFF-пути не переписаны (O-20/O-7/O-40 в той же точке)
    expect(entryFn).toContain('var res = P.sanitizeEmitMessages(messages);');
    expect(entryFn).toContain('aiCmLogSanitizeSkip(res && res.skipped);');
    expect(entryFn).toContain('return (res && Array.isArray(res.messages)) ? res.messages : messages;');
    expect(entryFn).toContain('if (aiCmIncludeHiddenInExport === true) {');
    // пины S3-S5 и таблицы форм не тронуты (O-7/O-40-наборы остаются зелёными)
    expect(PIPELINE_SRC).toContain("if (m.role === 'user' && isToolResultsOnlyText(raw)) { dropped++; continue; }");
    expect(PIPELINE_SRC).toContain('var BDS_INJECTION_FORMS = [');
  });

  test('R5: регресс O-40 — шесть модульных входов снимаются ровно как до инструментирования', () => {
    const input = [
      { role: 'user', text: F1, id: 'u-f1' },
      { role: 'user', text: F2, id: 'u-f2' },
      { role: 'user', text: F3, id: 'u-f3' },
      { role: 'user', text: F4, id: 'u-f4' },
      { role: 'user', text: F5, id: 'u-f5' },
      { role: 'user', text: F6, id: 'u-f6' },
      { role: 'assistant', text: PLAIN, id: 'a-plain' }
    ];
    const res = P.sanitizeEmitMessages(input);
    expect(res.bdsRemoved).toBe(6);
    expect(res.bdsForms).toEqual([
      'bds-deep-code-prompt', 'bds-tool-system-prompt', 'bds-prompt-wrapper',
      'bds-system-datetime', 'bds-deep-code-prompt', 'bds-deep-code-prompt'
    ]);
    expect(res.messages.map((m) => m.id)).toEqual(['u-f3', 'u-f5', 'u-f6', 'a-plain']);
    expect(res.messages[0].text).toBe(USER_PROMPT);
  });
});
