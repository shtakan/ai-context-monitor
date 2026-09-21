/**
 * O-37 (C): REASONING СЕРВИСА БЕЗ СЕТИ ДОЕЗЖАЕТ ДО ЭКСПОРТА (txt и md).
 *
 * Живой факт 21:59 (chat=4cf29053): стрим дал размышление (qwen-stream-end reasoningFrames=2
 * reasoningLen=214, usage reasoning=68), строка reasoning есть в ПОПАПЕ, а в txt/md секции
 * [REASONING] нет (ASSISTANT-блок = bare-ответ 277 знаков).
 *
 * Корень (шаг 1, инспекция; подтверждён чтением кода):
 *   - текст thinking summary живёт в СЕТЕВОМ снимке полями detail.messages[].reasoning и
 *     hiddenReasoning (core/qwen-intercept.js:449-453), а в DOM-базе — полем захвата
 *     hiddenReasoning (adapters/qwen-adapter.js:217); попап-строка показывает СЕРВЕРНЫЙ usage
 *     (qwenUsage.reasoningTokens), поэтому она есть независимо от экспорта;
 *   - рендер экспорта (utils/export-text-builders.js:messageTextWithReasoning) читает ТОЛЬКО
 *     поле reasoning, которого у сообщения сервиса без сети нет («поле, которое сообщение не
 *     заполняет»);
 *   - и главное: до рендера сообщения пересобираются в {role,text} (точка сбора экспорта,
 *     сетевая ветка), а OFF-путь O-7 (sanitizeEmitMessages → stripReasoningSections) урезает
 *     секции [REASONING]…[ANSWER]… до части [ANSWER] — то есть размышление снимается ещё ДО
 *     рендера, независимо от того, что оно было и в тексте, и в поле снимка.
 *
 * Фикс: единая нормализация на выходе точки сбора (utils/export-emit-pipeline.js:
 * applyReasoningExportFields, гейт — флаг сайта из core/export-manager.js): размышление
 * переезжает в ОТДЕЛЬНОЕ поле reasoning (из поля захвата или разбором пары секций
 * splitReasoningSections) ДО санации, а рендер маркерного пути (qwen) собирает секции
 * [REASONING]/[ANSWER] контрактом O-35. Нет размышления — нет секции (норма). Прочие
 * платформы не задеты: флаг сайта false → массив не трогается, байты прежние.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const { contentSource: CONTENT } = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const CONTENT_ONLY = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const WIDGET_SRC = fs.readFileSync(path.join(ROOT, 'core', 'widget.js'), 'utf8');
const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/o33-autoexport-base-pending.test.js).
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

// Живые числа артефакта 21:59 (chat=4cf29053): reasoningLen=214, ответ 277 знаков.
const REASONING = 'Пользователь здоровается и просит короткий ответ без лишних деталей. ' +
  'Отвечу приветствием и предложу помощь — этого достаточно.';
const ANSWER = 'Привет! Чем помочь?';
const SECTIONED = '[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER;
const CID = '4cf29053-7f1e-4c6a-9f2b-0f4a1c2d3e4f';

// ---------------------------------------------------------------------------------
// Песочница точки сбора экспорта: РЕАЛЬНЫЙ core/export-manager.js-регион
// (sanitizeGeminiText → aiCmSanitizeEmitUserTexts → O-37/C-хелперы → aiCmCollectExportSource).
// ---------------------------------------------------------------------------------
function makeEmitter(opts) {
  const o = opts || {};
  const start = MGR_SRC.indexOf('function sanitizeGeminiText(s)');
  const end = MGR_SRC.indexOf('// T1-fix#3');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const src = MGR_SRC.slice(start, end) + '\nctx.__emit = aiCmCollectExportSource;' +
    // O-7 (тумблер): в песочнице переменная локальна — переключатель наружу.
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
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  // hidden: true — песочница в режиме ON. Пины, чей инвариант «размышление доезжает до файла,
  // секции не теряются», живут на ON-пути: OFF-путь теперь очищает поле reasoning (O-7);
  // OFF-контракт покрыт tests/qwen-o7-reasoning-toggle.test.js.
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

const ADAPTER_MESSAGES = [
  { role: 'user', content: 'привет' },
  { role: 'assistant', content: ANSWER, hiddenReasoning: REASONING }
];

beforeEach(() => { });

// =====================================================================================
// C-D: фикстура qwen-сообщения с текстом размышления → txt и md
// =====================================================================================
describe('O-37 C-D: txt/md qwen — [REASONING] с текстом размышления и [ANSWER] с ответом', () => {
  test('txt: поле захвата hiddenReasoning (DOM-база qwen) даёт секции', () => {
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', model: 'Qwen3.8-Max', messages: [
        { role: 'user', text: 'привет' },
        { role: 'assistant', text: ANSWER, hiddenReasoning: REASONING }
      ]
    });
    expect(txt).toBe('USER:\nпривет\n\nASSISTANT:\n[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
    expect((txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
  });

  test('md: то же размышление уходит секциями после маркера роли', () => {
    const md = Builders.buildMdFromHistory({
      site: 'qwen', model: 'Qwen3.8-Max', messages: [
        { role: 'user', text: 'привет' },
        { role: 'assistant', text: ANSWER, hiddenReasoning: REASONING }
      ]
    }, 'Qwen');
    expect(md).toContain('### ASSISTANT\n\n[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
    expect(md).not.toContain('hiddenReasoning');
  });

  test('txt: сырой объект адаптера (.content вместо .text) — ответ не теряется', () => {
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', messages: [{ role: 'assistant', content: ANSWER, hiddenReasoning: REASONING }]
    });
    expect(txt).toBe('ASSISTANT:\n[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
  });

  test('txt: сетевая форма (поле reasoning) — контракт O-35 не сломан', () => {
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', messages: [{ role: 'assistant', text: ANSWER, reasoning: REASONING }]
    });
    expect(txt).toBe('ASSISTANT:\n[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
  });

  test('txt: размышление УЖЕ в тексте (секции сетевого пути) не дублируется', () => {
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', messages: [{ role: 'assistant', text: SECTIONED, reasoning: REASONING }]
    });
    expect(txt).toBe('ASSISTANT:\n' + SECTIONED);
    expect((txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
  });
});

// =====================================================================================
// C-D: РЕАЛЬНАЯ точка сбора экспорта (обе ветки) — размышление доезжает до файла
// =====================================================================================
describe('O-37 C-D: точка сбора экспорта — размышление нормализуется ДО санации OFF-пути', () => {
  test('DOM-ветка qwen (baseSeen=false): поле захвата → поле reasoning → txt с секциями', () => {
    const e = makeEmitter({ site: 'qwen', adapter: { siteName: 'qwen', extractMessages: function () { return ADAPTER_MESSAGES.slice(); } } });
    const msgs = e.run([], null);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].text).toBe(ANSWER);                 // текст — bare-ответ
    expect(msgs[1].reasoning).toBe(REASONING);         // размышление — отдельным полем
    expect(msgs[1].hiddenReasoning).toBeUndefined();   // служебное поле захвата снято
    const txt = Builders.buildTxtFromHistory({ site: 'qwen', messages: msgs });
    expect(txt).toBe('USER:\nпривет\n\nASSISTANT:\n[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
  });

  test('сетевая ветка qwen (живой 21:59): секции текста разбираются, ON-путь их не теряет', () => {
    const e = makeEmitter({ site: 'qwen', baseSeen: true, hidden: true, adapter: { siteName: 'qwen', extractMessages: function () { return []; } } });
    const msgs = e.run(
      ['привет', SECTIONED],
      [{ role: 'user', text: 'привет', id: 'u1' }, { role: 'assistant', text: SECTIONED, id: 'a1' }]
    );
    // ON (тумблер ВКЛ): секции разобраны в поле reasoning, текст — bare-ответ, секции файла
    // собирает рендер (O-35). OFF-путь (поле reasoning снимается → [REASONING] нет) запинен
    // отдельно в tests/qwen-o7-reasoning-toggle.test.js.
    expect(msgs[1].text).toBe(ANSWER);
    expect(msgs[1].reasoning).toBe(REASONING);
    const txt = Builders.buildTxtFromHistory({ site: 'qwen', messages: msgs });
    expect(txt).toContain('[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
    expect((txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
  });

  test('размышления нет — норма: ни поля, ни секции (txt и md)', () => {
    const e = makeEmitter({ site: 'qwen', adapter: { siteName: 'qwen', extractMessages: function () { return [{ role: 'user', content: 'привет' }, { role: 'assistant', content: ANSWER }]; } } });
    const msgs = e.run([], null);
    expect(msgs[1].reasoning).toBeUndefined();
    const txt = Builders.buildTxtFromHistory({ site: 'qwen', messages: msgs });
    expect(txt).toBe('USER:\nпривет\n\nASSISTANT:\n' + ANSWER);
    expect(txt).not.toContain('[REASONING]');
    expect(Builders.buildMdFromHistory({ site: 'qwen', messages: msgs }, 'Qwen')).not.toContain('[REASONING]');
  });
});

// =====================================================================================
// C-R: DeepSeek и прочие платформы — байты прежние
// =====================================================================================
describe('O-37 C-R: DeepSeek и пять прочих платформ не задеты', () => {
  test('DeepSeek через точку сбора: поле захвата НЕ становится секциями (OFF-путь прежний)', () => {
    const e = makeEmitter({
      site: 'deepseek',
      adapter: { siteName: 'deepseek', extractMessages: function () { return ADAPTER_MESSAGES.slice(); } }
    });
    const msgs = e.run([], null);
    expect(msgs[1].reasoning).toBeUndefined();
    expect(msgs[1].hiddenReasoning).toBeUndefined();
    expect(Builders.buildTxtFromHistory({ messages: msgs })).toBe('привет\n\n' + ANSWER);
  });

  test('DeepSeek сетевой путь: секции урезаются OFF-путём как раньше (без [REASONING])', () => {
    const e = makeEmitter({ site: 'deepseek', baseSeen: true, adapter: { siteName: 'deepseek', extractMessages: function () { return []; } } });
    const msgs = e.run(['вопрос', SECTIONED], [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: SECTIONED }]);
    expect(msgs[1].text).toBe(ANSWER);
    expect(msgs[1].reasoning).toBeUndefined();
    expect(Builders.buildTxtFromHistory({ messages: msgs })).toBe('вопрос\n\n' + ANSWER);
  });

  test('сборщики: поле захвата у шести платформ секций не создаёт (R1)', () => {
    ['chatgpt', 'gemini', 'deepseek', 'claude', 'perplexity', 'google_search'].forEach(function (site) {
      const txt = Builders.buildTxtFromHistory({
        site: site, messages: [{ role: 'assistant', text: ANSWER, hiddenReasoning: REASONING }]
      });
      expect(txt).toBe(ANSWER);
      expect(txt).not.toContain('[REASONING]');
      const md = Builders.buildMdFromHistory({ site: site, messages: [{ role: 'assistant', text: ANSWER, hiddenReasoning: REASONING }] }, 'X');
      expect(md).not.toContain('[REASONING]');
    });
  });

  test('попап-строка reasoning не меняется: источник — серверный usage, не новое поле', () => {
    expect(WIDGET_SRC).toContain('netQwenUsage.reasoningTokens');
    expect(WIDGET_SRC).toContain('netQwenUsage.outputTokens');
    expect(OPTIONS_SRC).not.toContain('qwenUsage');
    expect(CONTENT_ONLY).toContain("netQwenUsage = (detail.qwenUsage && typeof detail.qwenUsage === 'object') ? detail.qwenUsage : null;");
  });
});

// =====================================================================================
// Чистые функции контракта
// =====================================================================================
describe('O-37 C: чистые функции (splitReasoningSections / applyReasoningExportFields)', () => {
  test('splitReasoningSections: round-trip пары и идемпотентность', () => {
    const pair = P.splitReasoningSections(SECTIONED);
    expect(pair).toEqual({ reasoning: REASONING, answer: ANSWER });
    expect(pair.answer).toBe(ANSWER);
    // на своём выходе повторный вызов ничего не меняет
    expect(P.splitReasoningSections(pair.answer)).toEqual({ reasoning: '', answer: ANSWER });
    expect(P.splitReasoningSections('[REASONING]\r\nр\r\n\r\n[ANSWER]\r\nо')).toEqual({ reasoning: 'р', answer: 'о' });
  });

  test('splitReasoningSections: без пары текст возвращается байтово', () => {
    ['', 'обычный ответ', '[ANSWER] без пары', '[REASONING] без второй половины'].forEach(function (s) {
      expect(P.splitReasoningSections(s)).toEqual({ reasoning: '', answer: s });
    });
  });

  test('applyReasoningExportFields: флаг сайта false → массив и объекты те же (R1)', () => {
    const messages = [{ role: 'assistant', text: ANSWER, hiddenReasoning: REASONING }];
    const res = P.applyReasoningExportFields(messages, false);
    expect(res).toEqual({ changed: 0 });
    expect(messages[0]).toEqual({ role: 'assistant', text: ANSWER, hiddenReasoning: REASONING });
    expect(messages[0].reasoning).toBeUndefined();
  });

  test('applyReasoningExportFields: флаг сайта true → поле захвата становится reasoning, текст чистится', () => {
    const messages = [
      { role: 'user', text: 'привет' },
      { role: 'assistant', text: ANSWER, hiddenReasoning: REASONING },
      { role: 'assistant', text: SECTIONED }
    ];
    const res = P.applyReasoningExportFields(messages, true);
    expect(res).toEqual({ changed: 2 });
    expect(messages[0]).toEqual({ role: 'user', text: 'привет' });         // без размышления — не тронут
    expect(messages[1].reasoning).toBe(REASONING);
    expect(messages[1].hiddenReasoning).toBeUndefined();
    expect(messages[2].text).toBe(ANSWER);                                  // секции разобраны
    expect(messages[2].reasoning).toBe(REASONING);
    // идемпотентна: повторный прогон ничего не меняет
    expect(P.applyReasoningExportFields(messages, true)).toEqual({ changed: 0 });
  });
});

// =====================================================================================
// Source-пины проводки C
// =====================================================================================
describe('O-37 C: проводка (source-пины)', () => {
  test('сборщики: маркерный путь читает reasoning, иначе поле захвата; база текста — как у рендера', () => {
    const fn = fnDecl(fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8'), 'reasoningOfMessageForExport');
    expect(fn).toContain('reasoningOfMessage(msg)');
    expect(fn).toContain("typeof msg.hiddenReasoning === 'string'");
    expect(fnDecl(fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8'), 'markersMessageTextWithReasoning'))
      .toContain('withReasoningSections(messageTextForMarkers(msg)');
    expect(Builders.aiCmReasoningOfMessageForExport({ hiddenReasoning: REASONING }, true)).toBe(REASONING);
    expect(Builders.aiCmReasoningOfMessageForExport({ hiddenReasoning: REASONING }, false)).toBe('');
  });

  test('точка сбора: нормализация — реальный хелпер пайплайна typeof-гардом (фолбэк-песочницы живы)', () => {
    const fn = fnDecl(MGR_SRC, 'aiCmCollectExportSource');
    expect(fn).toContain('var prepareReasoning = (typeof aiCmPrepareReasoningForExport === \'function\') ? aiCmPrepareReasoningForExport : null;');
    expect(fn).toContain('if (prepareReasoning) prepareReasoning(out);');
    expect(fn).toContain('if (prepareReasoning) prepareReasoning(norm);');
    expect(fnDecl(MGR_SRC, 'aiCmPrepareReasoningForExport')).toContain('P.applyReasoningExportFields(messages, aiCmReasoningExportSite());');
    // единственная точка санации и её три вызова не переписаны (пин O-20)
    expect(fn).toContain('return aiCmSanitizeEmitUserTexts(out);');
    expect(fn).toContain('if (norm.length > 0 && hasRoles) return aiCmSanitizeEmitUserTexts(norm);');
  });

  test('предикат сайта — в export-manager.js (в пайплайне имён платформ нет)', () => {
    expect(fnDecl(MGR_SRC, 'aiCmReasoningExportSite')).toContain("currentAdapter.siteName === 'qwen'");
    expect(PIPELINE_SRC).not.toContain('qwen');
    expect(PIPELINE_SRC).not.toContain('Qwen');
    // флаг сайта — единственный вход нормализации: без него хелпер выходит сразу
    expect(fnDecl(PIPELINE_SRC, 'applyReasoningExportFields')).toContain('if (enabled !== true || !Array.isArray(messages)) return { changed: 0 };');
  });

  test('диагностических строк фикс C не добавляет (гейт не расширен, вывод детерминирован)', () => {
    ['aiCmReasoningExportSite', 'aiCmPrepareReasoningForExport'].forEach(function (name) {
      const fn = fnDecl(MGR_SRC, name);
      expect(fn).not.toContain('console.');
      expect(fn).not.toContain('aiCmDiagLine');
    });
    const apply = fnDecl(PIPELINE_SRC, 'applyReasoningExportFields');
    expect(apply).not.toContain('console.');
  });
});
