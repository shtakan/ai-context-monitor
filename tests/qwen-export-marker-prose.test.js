/**
 * O-58: ЛИТЕРАЛЬНЫЕ [REASONING]/[ANSWER] В ПРОЗЕ QWEN НЕ РЕЖУТСЯ.
 *
 * Дефект: модель пишет в тексте ответа сами слова-маркеры — «Согласен на 100%…
 * [REASONING]… [ANSWER]…». Старый splitReasoningSections искал пару через indexOf и
 * признавал парой ЛЮБЫЕ два литерала: всё до [REASONING] (префикс ответа) и «рассуждение»
 * между маркерами терялись, ход переупаковывался в секции, а в экспорт уезжал только хвост
 * после [ANSWER].
 *
 * Корень: структурного критерия не было — позиция маркеров в тексте не проверялась.
 * Фикс (utils/export-emit-pipeline.js:splitReasoningSections): пара признаётся ТОЛЬКО
 * канонической формой composeTurnText — [REASONING] в начале текста (допустимы ведущие
 * пустые строки) и [ANSWER] сразу после перевода строки-разделителя. Иначе возвращается
 * { reasoning:'', answer:s } байтово, а под гейтом aiCmDebug пишется диаг-строка
 * reasoning-marker-in-prose.
 *
 * Пины:
 *   D1 — проза Qwen с литералами: split/apply/ON-экспорт сохраняют текст целиком, секций нет;
 *   D2 — канонический ход (в т.ч. CRLF и ведущие пустые строки) по-прежнему парсится;
 *   R1 — DeepSeek-экспорт (канонический формат) байтово прежний;
 *   D3 — диаг-строка только под гейтом и только на литералах в прозе.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('./helpers/load-esm.js').loadEsmGlobal('utils/export-text-builders.js', 'AiCmExportBuilders');

const ROOT = path.join(__dirname, '..');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта).
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

// Песочница точки сбора экспорта: РЕАЛЬНЫЙ регион core/export-manager.js (конвенция
// tests/qwen-reasoning-export-o37.test.js). Только ЧТЕНИЕ кода менеджера — он не меняется.
function makeEmitter(opts) {
  const o = opts || {};
  const start = MGR_SRC.indexOf('function sanitizeGeminiText(s)');
  const end = MGR_SRC.indexOf('// T1-fix#3');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const src = MGR_SRC.slice(start, end) + '\nctx.__emit = aiCmCollectExportSource;' +
    '\nctx.__setHidden = function (v) { aiCmIncludeHiddenInExport = (v === true); };';
  const ctx = {
    window: { AiCmExportEmitPipeline: P },
    sessionStorage: { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } },
    console: { log: function () { }, warn: function () { }, error: function () { }, info: function () { }, debug: function () { } },
    lastBaseTexts: [],
    lastDetailMessages: null,
    baseSeen: o.baseSeen === true,
    currentAdapter: o.adapter || { siteName: o.site || 'qwen', extractMessages: function () { return []; } }
  };
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  if (o.hidden === true) ctx.__setHidden(true);
  return {
    ctx: ctx,
    run: function (texts, detailMessages) {
      ctx.lastBaseTexts = texts || [];
      ctx.lastDetailMessages = detailMessages || null;
      return ctx.__emit();
    }
  };
}

// Песочница ЧИСТОГО региона пайплайна: SECTION-теги + splitReasoningSections (+ diagTag).
// Нужна, чтобы подменить канонический aiCmDiagLine шпионом и проверить гейт по факту вызова.
const SPLIT_REGION_START = "var SECTION_REASONING_TAG = '[REASONING]';";
const SPLIT_REGION_END = 'function applyReasoningExportFields';

function makeSplitSandbox(diagLine) {
  const start = PIPELINE_SRC.indexOf(SPLIT_REGION_START);
  const end = PIPELINE_SRC.indexOf(SPLIT_REGION_END);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const src = PIPELINE_SRC.slice(start, end);
  const ctx = {};
  if (diagLine) ctx.aiCmDiagLine = diagLine;
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src +
    '\nctx.split = splitReasoningSections;\n})(); }');
  fn(ctx);
  return { split: ctx.split, ctx: ctx };
}

const REASONING = 'Пользователь просит короткий ответ и сравнивает форматы. ' +
  'Достаточно одного абзаца без лишних деталей.';
const ANSWER = 'Берите формат A: он короче и дешевле.';
const CANONICAL = '[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER;

// Проза Qwen: оба литерала есть, но [REASONING] стоит НЕ в начале и [ANSWER] — не после \n\n.
const PROSE = 'Согласен на 100%: разметку удобно описывать словами. ' +
  'Обычно [REASONING] — это черновик рассуждений, а [ANSWER] — финальный текст. ' +
  'Но если маркеры попали в прозу, резать ответ нельзя.';

// =====================================================================================
// D1: литералы в прозе — текст сохраняется целиком, секций не появляется
// =====================================================================================
describe('O-58 D1: [REASONING]/[ANSWER] в прозе Qwen не режут текст', () => {
  test('D1: splitReasoningSections возвращает прозу байтово (пары нет)', () => {
    // Ловушка старого кода: литералы стоят в прозе, но indexOf-пара находился.
    expect(PROSE.indexOf('[REASONING]')).toBeGreaterThan(0);
    expect(PROSE.indexOf('[ANSWER]')).toBeGreaterThan(PROSE.indexOf('[REASONING]'));
    const pair = P.splitReasoningSections(PROSE);
    expect(pair).toEqual({ reasoning: '', answer: PROSE });
    expect(pair.answer).toBe(PROSE);
    expect(pair.reasoning).toBe('');
  });

  test('D1: applyReasoningExportFields не трогает сообщение и его объект', () => {
    const msg = { role: 'assistant', text: PROSE };
    const messages = [{ role: 'user', text: 'вопрос' }, msg];
    const res = P.applyReasoningExportFields(messages, true);
    expect(res).toEqual({ changed: 0 });
    expect(messages[1]).toBe(msg);                 // копии нет
    expect(msg.reasoning).toBeUndefined();         // секции не появились
    expect(msg.text).toBe(PROSE);                  // ни одного потерянного байта
  });

  test('D1: ON-экспорт qwen — проза доезжает целиком, ровно один литерал каждого маркера', () => {
    const e = makeEmitter({ site: 'qwen', baseSeen: true, hidden: true });
    const msgs = e.run(['вопрос', PROSE], [
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: PROSE }
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].text).toBe(PROSE);
    expect(msgs[1].reasoning).toBeUndefined();
    const txt = Builders.buildTxtFromHistory({ site: 'qwen', messages: msgs });
    expect(txt).toBe('USER:\nвопрос\n\nASSISTANT:\n' + PROSE);
    // Маркеры в файле — только те, что написала модель в прозе; ни одной синтезированной секции.
    expect((txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect((txt.match(/\[ANSWER\]/g) || [])).toHaveLength(1);
  });
});

// =====================================================================================
// D2: канонический ход по-прежнему парсится (структурный критерий не сломал норму)
// =====================================================================================
describe('O-58 D2: канонический [REASONING] в начале — это пара', () => {
  test('D2: splitReasoningSections — round-trip, CRLF, ведущие пустые строки, идемпотентность', () => {
    expect(P.splitReasoningSections(CANONICAL)).toEqual({ reasoning: REASONING, answer: ANSWER });
    expect(P.splitReasoningSections('\n\n' + CANONICAL)).toEqual({ reasoning: REASONING, answer: ANSWER });
    expect(P.splitReasoningSections('[REASONING]\r\nр\r\n\r\n[ANSWER]\r\nо')).toEqual({ reasoning: 'р', answer: 'о' });
    expect(P.splitReasoningSections(ANSWER)).toEqual({ reasoning: '', answer: ANSWER });
  });

  test('D2: ON-экспорт qwen — канонический ход рендерится секциями ровно один раз', () => {
    const e = makeEmitter({ site: 'qwen', baseSeen: true, hidden: true });
    const msgs = e.run(['вопрос', CANONICAL], [
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: CANONICAL }
    ]);
    expect(msgs[1].text).toBe(ANSWER);
    expect(msgs[1].reasoning).toBe(REASONING);
    const txt = Builders.buildTxtFromHistory({ site: 'qwen', messages: msgs });
    expect(txt).toBe('USER:\nвопрос\n\nASSISTANT:\n' + CANONICAL);
    expect((txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
  });
});

// =====================================================================================
// R1: DeepSeek (канонический формат) — байты прежние
// =====================================================================================
describe('O-58 R1: DeepSeek-экспорт байтово прежний', () => {
  test('R1: сетевой канонический ход DeepSeek — OFF-путь даёт прежние байты', () => {
    const e = makeEmitter({ site: 'deepseek', baseSeen: true });
    const msgs = e.run(['вопрос', CANONICAL], [
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: CANONICAL }
    ]);
    expect(msgs[1].text).toBe(ANSWER);
    expect(msgs[1].reasoning).toBeUndefined();
    const txt = Builders.buildTxtFromHistory({ messages: msgs });
    expect(txt).toBe('вопрос\n\n' + ANSWER);
    expect(txt).not.toContain('[REASONING]');
  });

  test('R1: структурная пара принимает ровно ту форму, которую пишет composeTurnText', () => {
    // Обе платформы собирают ход одинаково (core/qwen-intercept.js:419, core/deepseek-parse.js:173)
    // — каноническая форма разбирается, а обрезанный/односторонний литерал — нет.
    expect(P.splitReasoningSections(CANONICAL)).toEqual({ reasoning: REASONING, answer: ANSWER });
    expect(P.splitReasoningSections('[REASONING]' + REASONING + '\n\n[ANSWER]\n' + ANSWER))
      .toEqual({ reasoning: '', answer: '[REASONING]' + REASONING + '\n\n[ANSWER]\n' + ANSWER });
  });
});

// =====================================================================================
// D3: диаг-строка — только под гейтом aiCmDebug и только на литералах в прозе
// =====================================================================================
describe('O-58 D3: диаг-строка reasoning-marker-in-prose', () => {
  test('D3: source-пин — вызов в split под typeof-гардом diagTag', () => {
    const split = fnDecl(PIPELINE_SRC, 'splitReasoningSections');
    expect(split).toContain("diagTag('reasoning-marker-in-prose'");
    const tag = fnDecl(PIPELINE_SRC, 'diagTag');
    expect(tag).toContain("typeof aiCmDiagLine !== 'function'");
    expect(tag).toContain('catch (eDiag) { return false; }');
  });

  test('D3: литералы в прозе → одна строка с длиной и позициями', () => {
    const calls = [];
    const sb = makeSplitSandbox(function (tag, fields) { calls.push({ tag: tag, fields: fields }); return true; });
    expect(sb.split(PROSE)).toEqual({ reasoning: '', answer: PROSE });
    expect(calls).toHaveLength(1);
    expect(calls[0].tag).toBe('reasoning-marker-in-prose');
    expect(calls[0].fields.len).toBe(PROSE.length);
    expect(calls[0].fields.r).toBe(PROSE.indexOf('[REASONING]'));
    expect(calls[0].fields.a).toBe(PROSE.indexOf('[ANSWER]'));
  });

  test('D3: каноническая пара и текст без маркеров — ни одной строки', () => {
    const calls = [];
    const spy = function (tag, fields) { calls.push({ tag: tag, fields: fields }); return true; };
    expect(makeSplitSandbox(spy).split(CANONICAL)).toEqual({ reasoning: REASONING, answer: ANSWER });
    expect(makeSplitSandbox(spy).split('обычный ответ')).toEqual({ reasoning: '', answer: 'обычный ответ' });
    expect(makeSplitSandbox(spy).split('[REASONING] без второй половины'))
      .toEqual({ reasoning: '', answer: '[REASONING] без второй половины' });
    expect(calls).toHaveLength(0);
  });

  test('D3: гейт выключен / хелпера нет (срез-песочница) — split работает без строк и без throw', () => {
    const off = makeSplitSandbox(function () { return false; });
    expect(off.split(PROSE)).toEqual({ reasoning: '', answer: PROSE });
    const none = makeSplitSandbox(null);
    expect(none.split(PROSE)).toEqual({ reasoning: '', answer: PROSE });
    expect(none.split(CANONICAL)).toEqual({ reasoning: REASONING, answer: ANSWER });
  });
});
