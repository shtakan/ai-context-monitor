/**
 * D-O41 (UX): АВТО-ON ТУМБЛЕРА `aiCmIncludeHiddenInExport` ПРИ НАЛИЧИИ REASONING В ИСТОЧНИКЕ.
 *
 * Спецификация владельца (согласована 2026-09-24, вариант «в» мировых стандартов:
 * WYSIWYG + smart defaults):
 *   1. Правило: effectiveToggle = (userToggle === OFF && sourceHasReasoning === true)
 *      ? ON : userToggle;
 *   2. sourceHasReasoning = true, если в источнике экспорта ≥1 сообщение с НЕПУСТЫМ полем
 *      reasoning ИЛИ ≥1 секция [REASONING] в тексте;
 *   3. точка применения — ДО единственной точки выхода рендера (withReasoningSections,
 *      utils/export-text-builders.js:48): OFF-зачистка S1–S5 (O-7) исполняется РОВНО при
 *      эффективном OFF без reasoning в источнике;
 *   4. UI: tooltip тумблера в options + обеих локалях;
 *   5. override: явный OFF при sourceHasReasoning=false — force-exclude (прежний OFF-путь);
 *      при sourceHasReasoning=true — игнорируется (авто-ON всегда).
 *
 * Контур пинов:
 *   S1 — чистая точка правила: hasReasoningInSource/effectiveReasoningToggle в пайплайне
 *        (hiddenReasoning НАРОЧНО не считается — иначе OFF-зачистка O-7 ушла бы у каждого
 *        DeepSeek++-чата);
 *   S2 — проводка: ЕДИНСТВЕННАЯ точка чтения тумблера aiCmHiddenExportEffectiveOn
 *        (core/export-manager.js), её зовут точка санации и точка сбора; OFF-литералы и
 *        OFF-путь S1–S5 не переписаны;
 *   S3 — таблицы истинности обеих чистых функций;
 *   D1 — источник С reasoning + OFF → файл СОДЕРЖИТ [REASONING] (поле данных и секция текста);
 *   D2 — источник БЕЗ reasoning + OFF → 0 секций [REASONING];
 *   D3 — источник С reasoning + ON → [REASONING] (прежний ON-путь не сломан; байты = D1);
 *   D4 — источник БЕЗ reasoning + ON/OFF → байты файла идентичны (авто-ON не срабатывает);
 *   D5 — UI: tooltip тумблера (обе локали + разметка options);
 *   R1 — регресс O-7: DeepSeek-тул-мусор при OFF и sourceHasReasoning=false НЕ возвращается
 *        (S3/S4/S5 живут); отдельно пинится следствие правила 5 — при reasoning в источнике
 *        OFF идёт сырым путём, поэтому S1–S5 не исполняется;
 *   R2 — регресс O-39: история Qwen с 53 размышлениями → [REASONING]/[ANSWER] = 53/53;
 *   R3 — Gemini/AI Studio: ветка prepareExportMessages не тронута, txt байтово прежний ON/OFF.
 *
 * НЕ ТРОГАЕТСЯ: CHANGELOG/версия (релизный коммит отдельно), сборщики txt/md, OFF-зачистка
 * S1–S5 (O-7) и её чистые функции, база/метрики/бейдж (они по-прежнему считаются по базовому
 * тексту и от тумблера не зависят).
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

const MGR_SRC = read('core/export-manager.js');
const PIPELINE_SRC = read('utils/export-emit-pipeline.js');
const BASE_HANDLER_SRC = read('core/base-handler.js');
const OPTIONS_HTML = read('options/options.html');
const I18N_APPLY_SRC = read('options/i18n-apply.js');
const ru = JSON.parse(read('_locales/ru/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));

const SETTING_KEY = 'aiCmIncludeHiddenInExport';
const TITLE_KEY = 'options_export_hidden_title';
// Пункт 4 спецификации — строки дословно.
const TITLE_RU = 'Reasoning автоматически включается при наличии в источнике; тумблер принудительно исключает';
const TITLE_EN = 'Reasoning auto-included when present in source; toggle forces exclude';

const QUESTION = 'привет';
const REASONING = 'Пользователь здоровается. Отвечу приветствием и предложу помощь.';
const ANSWER = 'Привет! Чем помочь?';
const SECTIONED = '[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER;

/** Тело функции по балансу скобок (конвенция source-пинов проекта). */
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

function countOccurrences(s, needle) {
  return s.split(needle).length - 1;
}

// =====================================================================================
// Песочница: РЕАЛЬНЫЙ регион core/export-manager.js (sanitizeGeminiText →
// aiCmHiddenExportEffectiveOn → aiCmSanitizeEmitUserTexts → O-37/C-хелперы →
// aiCmCollectExportSource) + переключатель тумблера (в песочнице переменная локальна).
// Приём — как в tests/qwen-o7-reasoning-toggle.test.js / deepseek-o7-hidden-export.test.js.
// =====================================================================================
function makeEmitter(opts) {
  const o = opts || {};
  const site = o.site || 'qwen';
  const start = MGR_SRC.indexOf('function sanitizeGeminiText(s)');
  const end = MGR_SRC.indexOf('// T1-fix#3');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const src = MGR_SRC.slice(start, end) +
    '\nctx.__emit = aiCmCollectExportSource;' +
    '\nctx.__setHidden = function (v) { aiCmIncludeHiddenInExport = (v === true); };';
  const ctx = {
    window: { AiCmExportEmitPipeline: P },
    sessionStorage: { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } },
    console: { log: function () { }, warn: function () { }, error: function () { }, info: function () { }, debug: function () { } },
    lastBaseTexts: [],
    lastDetailMessages: null,
    baseSeen: o.baseSeen !== false,
    currentAdapter: o.adapter || { siteName: site, extractMessages: function () { return []; } }
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  return {
    ctx: ctx,
    /** Тумблер (пользовательское значение) + сетевой прогон точки сбора. */
    run: function (messages, hidden) {
      ctx.__setHidden(hidden === true);
      ctx.lastBaseTexts = messages.map(function (m) { return String(m.text == null ? '' : m.text); });
      ctx.lastDetailMessages = messages;
      return ctx.__emit();
    }
  };
}

function txtOf(msgs, site) {
  return Builders.buildTxtFromHistory({ site: site || 'qwen', messages: msgs });
}

function mdOf(msgs, site) {
  return Builders.buildMdFromHistory({ site: site || 'qwen', messages: msgs }, 'X');
}

/** Снимок Qwen сетевого пути: секции в тексте + поле reasoning (живой путь O-39). */
function qwenSectioned() {
  return [
    { role: 'user', text: QUESTION, id: 'u1' },
    { role: 'assistant', text: SECTIONED, id: 'a1', reasoning: REASONING, hiddenReasoning: REASONING }
  ];
}

/** Снимок Qwen сетевого пути: только поле reasoning, текст — bare-ответ. */
function qwenFieldOnly() {
  return [
    { role: 'user', text: QUESTION, id: 'u1' },
    { role: 'assistant', text: ANSWER, id: 'a1', reasoning: REASONING }
  ];
}

/** Источник БЕЗ reasoning: ни поля, ни секции. */
function plainSource() {
  return [
    { role: 'user', text: 'вопрос без размышления', id: 'u1' },
    { role: 'assistant', text: 'ответ без размышления', id: 'a1' }
  ];
}

// O-7 (S3/S4) тул-мусор DeepSeek++ — источник БЕЗ reasoning: OFF-путь обязан его снять.
const TOOL_RESULTS_USER = '[TOOL_RESULTS]\n' +
  '<memory_update_result>{"ok":true,"name":"memory_update"}</memory_update_result>\n' +
  '[/TOOL_RESULTS]\n\nContinue answering based on the tool results above.';
const TOOL_CALL_BLOCK = '<browser_type>\n{"text": "привет"}\n</browser_type>';
const TOOL_PROSE_BEFORE = 'Начинаю разбор улова.';
const TOOL_PROSE_AFTER = 'Готово, смотрю дальше.';

function toolJunkSource() {
  return [
    { role: 'user', text: TOOL_RESULTS_USER, id: 'u-tools' },
    { role: 'assistant', text: TOOL_PROSE_BEFORE + '\n\n' + TOOL_CALL_BLOCK + '\n\n' + TOOL_PROSE_AFTER, id: 'a-tools' }
  ];
}

/** История Qwen из n ходов «вопрос → ответ с размышлением» (регресс O-39, R2). */
function qwenHistory(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const nn = String(i).padStart(2, '0');
    out.push({ role: 'user', text: 'вопрос ' + nn });
    out.push({ role: 'assistant', text: 'ответ ' + nn, reasoning: 'размышление ' + nn });
  }
  return out;
}

// =====================================================================================
// S1/S3: ЧИСТАЯ ТОЧКА ПРАВИЛА — hasReasoningInSource / effectiveReasoningToggle
// =====================================================================================
describe('D-O41 S1/S3: чистая точка правила в пайплайне', () => {
  test('S1: функции объявлены и отданы наружу; признак читает ТОЛЬКО поле reasoning и секцию', () => {
    expect(PIPELINE_SRC).toContain('function hasReasoningInSource(messages)');
    expect(PIPELINE_SRC).toContain('function effectiveReasoningToggle(userToggle, sourceHasReasoning)');
    expect(PIPELINE_SRC).toContain('hasReasoningInSource: hasReasoningInSource,');
    expect(PIPELINE_SRC).toContain('effectiveReasoningToggle: effectiveReasoningToggle,');
    expect(typeof P.hasReasoningInSource).toBe('function');
    expect(typeof P.effectiveReasoningToggle).toBe('function');
    const fn = fnDecl(PIPELINE_SRC, 'hasReasoningInSource');
    expect(fn).toContain("typeof m.reasoning === 'string'");
    expect(fn).toContain('text.indexOf(SECTION_REASONING_TAG) !== -1');
    // Служебное поле захвата НАРОЧНО не считается: иначе авто-ON разворачивал бы каждый
    // DeepSeek++-чат в сырой режим и OFF-зачистка S1–S5 не исполнялась бы никогда.
    expect(fn).not.toContain('hiddenReasoning');
    // Формула правила — в одной чистой функции, без чтения chrome/DOM.
    const eff = fnDecl(PIPELINE_SRC, 'effectiveReasoningToggle');
    expect(eff).toContain('if (userToggle === true) return true;');
    expect(eff).not.toContain('hiddenReasoning');
  });

  test('S3: hasReasoningInSource — поле, секция, пустое/пробельное значение, мусор', () => {
    expect(P.hasReasoningInSource(qwenFieldOnly())).toBe(true);
    expect(P.hasReasoningInSource(qwenSectioned())).toBe(true);
    // секция в тексте БЕЗ поля reasoning (сетевой путь: размышление только секциями)
    expect(P.hasReasoningInSource([
      { role: 'assistant', text: SECTIONED }
    ])).toBe(true);
    expect(P.hasReasoningInSource(plainSource())).toBe(false);
    expect(P.hasReasoningInSource([{ role: 'assistant', text: ANSWER, reasoning: '' }])).toBe(false);
    expect(P.hasReasoningInSource([{ role: 'assistant', text: ANSWER, reasoning: '   ' }])).toBe(false);
    // поле захвата — не основание для авто-ON (см. S1)
    expect(P.hasReasoningInSource([{ role: 'assistant', text: ANSWER, hiddenReasoning: REASONING }])).toBe(false);
    expect(P.hasReasoningInSource([])).toBe(false);
    expect(P.hasReasoningInSource(null)).toBe(false);
    expect(P.hasReasoningInSource([null, 'x', 7])).toBe(false);
  });

  test('S3: effectiveReasoningToggle — таблица истинности правила владельца', () => {
    // ON пользователя — ON при любом источнике
    expect(P.effectiveReasoningToggle(true, false)).toBe(true);
    expect(P.effectiveReasoningToggle(true, true)).toBe(true);
    // OFF пользователя: источник с reasoning → авто-ON; без reasoning → force-exclude
    expect(P.effectiveReasoningToggle(false, true)).toBe(true);
    expect(P.effectiveReasoningToggle(false, false)).toBe(false);
    // не задан тумблер = OFF (как в загрузчике настроек), результат всегда boolean
    expect(P.effectiveReasoningToggle(undefined, true)).toBe(true);
    expect(P.effectiveReasoningToggle(undefined, false)).toBe(false);
    expect(P.effectiveReasoningToggle(false, undefined)).toBe(false);
    expect(P.effectiveReasoningToggle('true', true)).toBe(true);
  });
});

// =====================================================================================
// S2: ПРОВОДКА — ЕДИНСТВЕННАЯ ТОЧКА ЧТЕНИЯ ТУМБЛЕРА
// =====================================================================================
describe('D-O41 S2: единственная точка чтения тумблера и целый OFF-путь O-7', () => {
  test('S2: тумблер читается ровно в aiCmHiddenExportEffectiveOn; обе точки на неё замкнуты', () => {
    const helper = fnDecl(MGR_SRC, 'aiCmHiddenExportEffectiveOn');
    expect(helper).toContain('aiCmIncludeHiddenInExport === true');
    expect(helper).toContain('P.hasReasoningInSource(messages)');
    expect(helper).toContain('P.effectiveReasoningToggle(userOn,');
    // Хелпера нет (срез-песочница) → пользовательское значение: конвенция typeof-гардов.
    expect(helper).toContain("typeof P.hasReasoningInSource !== 'function'");

    const entry = fnDecl(MGR_SRC, 'aiCmSanitizeEmitUserTexts');
    expect(entry).toContain("typeof aiCmHiddenExportEffectiveOn === 'function'");
    expect(entry).toContain('aiCmHiddenExportEffectiveOn(messages)');
    expect(entry).toContain('if (hiddenExportEffective) {');
    // OFF-путь и его литералы прежние (S1–S5 / O-20 / O-40 в пайплайне не переписаны)
    expect(entry).toContain('var res = P.sanitizeEmitMessages(messages);');
    expect(entry).toContain('aiCmLogSanitizeSkip(res && res.skipped);');
    expect(entry).toContain('return (res && Array.isArray(res.messages)) ? res.messages : messages;');
    expect(entry).toContain('if (aiCmIncludeHiddenInExport === true) {');
    // авто-ON проверяется ДО OFF-пути (правило 3: S1–S5 — только при эффективном OFF)
    expect(entry.indexOf('if (hiddenExportEffective) {'))
      .toBeLessThan(entry.indexOf('var res = P.sanitizeEmitMessages(messages);'));

    const collect = fnDecl(MGR_SRC, 'aiCmCollectExportSource');
    expect(collect).toContain("var hiddenExportOn = (typeof aiCmIncludeHiddenInExport !== 'undefined') && aiCmIncludeHiddenInExport === true;");
    expect(collect).toContain('hiddenExportOn = aiCmHiddenExportEffectiveOn(out);');
    expect(collect).toContain('if (!hiddenExportOn && reasoningExportSite && reasoningExportSite()) {');
    expect(collect).toContain('delete out[ri].reasoning;');
  });

  test('S2: дигностика точки входа печатает ЭФФЕКТИВНОЕ значение (авто-ON виден как hidden=on)', () => {
    const diag = fnDecl(MGR_SRC, 'aiCmEmitEntryDiag');
    expect(diag).toContain('effectiveOn === undefined');
    expect(diag).toContain('hidden: hiddenOn ? \'on\' : \'off\',');
  });

  test('S2: пайплайн OFF-зачистки не знает о тумблере (санация остаётся чистой)', () => {
    const san = fnDecl(PIPELINE_SRC, 'sanitizeEmitMessages');
    expect(san).not.toContain('aiCmIncludeHiddenInExport');
    expect(san).not.toContain('effectiveReasoningToggle');
    expect(san).toContain('var bare = stripReasoningSections(raw);');
    expect(PIPELINE_SRC).toContain('function stripReasoningSections(text)');
    expect(PIPELINE_SRC).toContain('function isToolResultsOnlyText(text)');
    expect(PIPELINE_SRC).toContain('function stripToolCallBlocks(text)');
  });
});

// =====================================================================================
// D1: ИСТОЧНИК С REASONING + OFF → [REASONING] В ФАЙЛЕ
// =====================================================================================
describe('D-O41 D1: OFF + reasoning в источнике → авто-ON, секции в файле', () => {
  test('D1 поле reasoning (текст — bare-ответ): рендер собирает ровно одну пару секций', () => {
    const msgs = makeEmitter({ site: 'qwen' }).run(qwenFieldOnly(), false);   // тумблер OFF
    expect(msgs[1].reasoning).toBe(REASONING);
    const txt = txtOf(msgs);
    expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
    expect(countOccurrences(txt, '[REASONING]')).toBe(1);
    expect(countOccurrences(txt, '[ANSWER]')).toBe(1);
    expect(countOccurrences(mdOf(msgs), '[REASONING]')).toBe(1);
  });

  test('D1 секция в тексте (сетевой путь): OFF не урезает источник, дубля нет', () => {
    const msgs = makeEmitter({ site: 'qwen' }).run(qwenSectioned(), false);
    expect(msgs[1].text).toBe(SECTIONED);                       // источник как есть
    expect(msgs[1].hiddenReasoning).toBeUndefined();            // служебное поле снято
    const txt = txtOf(msgs);
    expect(countOccurrences(txt, '[REASONING]')).toBe(1);
    expect(countOccurrences(txt, REASONING)).toBe(1);
  });

  test('D1 DeepSeek (секции источника, поля reasoning нет): OFF → сырой путь, [REASONING] в txt', () => {
    const msgs = makeEmitter({ site: 'deepseek' }).run([
      { role: 'user', text: 'вопрос', id: 'u1' },
      { role: 'assistant', text: SECTIONED, id: 'a1' }
    ], false);
    expect(msgs[1].text).toBe(SECTIONED);
    expect(msgs[1].reasoning).toBeUndefined();                  // O-37/C нормализует только DOM-сервис
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).toBe('вопрос\n\n' + SECTIONED);
    expect(countOccurrences(txt, '[REASONING]')).toBe(1);
  });
});

// =====================================================================================
// D2: ИСТОЧНИК БЕЗ REASONING + OFF → 0 СЕКЦИЙ (force-exclude)
// =====================================================================================
describe('D-O41 D2: OFF без reasoning в источнике — секций нет (force-exclude)', () => {
  test('D2 txt/md: 0 секций [REASONING], тексты — как раньше', () => {
    const msgs = makeEmitter({ site: 'qwen' }).run(plainSource(), false);
    msgs.forEach(function (m) {
      expect(Object.prototype.hasOwnProperty.call(m, 'reasoning')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(m, 'hiddenReasoning')).toBe(false);
    });
    const txt = txtOf(msgs);
    expect(txt).toBe('USER:\nвопрос без размышления\n\nASSISTANT:\nответ без размышления');
    expect(countOccurrences(txt, '[REASONING]')).toBe(0);
    expect(countOccurrences(mdOf(msgs), '[REASONING]')).toBe(0);
  });

  test('D2 тумблер не читает hiddenReasoning как основание: поле захвата снято, секций нет', () => {
    // DOM-источник DeepSeek: размышление лежит ТОЛЬКО в служебном поле захвата —
    // это не «reasoning в источнике» (S1), OFF обязан остаться OFF-путём.
    const msgs = makeEmitter({ site: 'deepseek' }).run([
      { role: 'assistant', text: ANSWER, id: 'a1', hiddenReasoning: REASONING }
    ], false);
    expect(msgs[0].hiddenReasoning).toBeUndefined();
    expect(msgs[0].reasoning).toBeUndefined();
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).toBe(ANSWER);
    expect(countOccurrences(txt, '[REASONING]')).toBe(0);
    expect(countOccurrences(txt, REASONING)).toBe(0);
  });
});

// =====================================================================================
// D3/D4: ON-ПУТЬ (регресс) И БАЙТОВОЕ РАВЕНСТВО OFF=ON БЕЗ REASONING
// =====================================================================================
describe('D-O41 D3/D4: ON-путь не сломан; без reasoning OFF и ON байтово равны', () => {
  test('D3 источник с reasoning + ON: файл содержит [REASONING], байты = авто-ON', () => {
    const on = makeEmitter({ site: 'qwen' }).run(qwenSectioned(), true);
    const auto = makeEmitter({ site: 'qwen' }).run(qwenSectioned(), false);
    const txtOn = txtOf(on);
    expect(countOccurrences(txtOn, '[REASONING]')).toBe(1);
    expect(countOccurrences(txtOn, '[ANSWER]')).toBe(1);
    expect(txtOn).toBe(txtOf(auto));                            // D1-путь = ON-путь байтово
    expect(JSON.stringify(on)).toBe(JSON.stringify(auto));
  });

  test('D4 источник без reasoning + ON/OFF: байты файла идентичны (авто-ON не срабатывает)', () => {
    const off = makeEmitter({ site: 'qwen' }).run(plainSource(), false);
    const on = makeEmitter({ site: 'qwen' }).run(plainSource(), true);
    // «Дата экспорта»/exportedAt — единственная недетерминированная часть сборщиков
    // (два последовательных вызова могут пересечь миллисекундную границу): нормализуем её,
    // сравнивая именно БАЙТЫ файла по обеим ветками тумблера.
    const stamp = (s) => String(s)
      .replace(/Дата экспорта: [^\n]*/g, 'Дата экспорта: <STAMP>')
      .replace(/"exportedAt": "[^"]*"/g, '"exportedAt": "<STAMP>"');
    expect(txtOf(on)).toBe(txtOf(off));
    expect(stamp(mdOf(on, 'qwen'))).toBe(stamp(mdOf(off, 'qwen')));
    expect(stamp(Builders.buildJsonFromHistory({ site: 'qwen', messages: on })))
      .toBe(stamp(Builders.buildJsonFromHistory({ site: 'qwen', messages: off })));
    expect(countOccurrences(txtOf(off), '[REASONING]')).toBe(0);
    // На чистом источнике обе ветки сообщения не меняют (OFF-санация — no-op, сырой путь — 1:1):
    // точка сбора строит объекты заново, поэтому сравниваем содержимое, а не ссылки.
    expect(on).toEqual(off);
  });
});

// =====================================================================================
// D5: UI — TOOLTIP ТУМБЛЕРА
// =====================================================================================
describe('D-O41 D5: tooltip тумблера в options и обеих локалях', () => {
  test('D5 локали: ключ есть в ru и en, строки — дословно из спецификации', () => {
    expect(ru[TITLE_KEY].message).toBe(TITLE_RU);
    expect(en[TITLE_KEY].message).toBe(TITLE_EN);
    expect(TITLE_RU).not.toBe(TITLE_EN);
  });

  test('D5 разметка: tooltip на тумблере, механизм подстановки поддерживает title', () => {
    const tag = /<input[^>]*id="aiCmIncludeHiddenInExport"[^>]*>/.exec(OPTIONS_HTML)[0];
    expect(tag).toContain('type="checkbox"');
    expect(tag).toContain('data-i18n-title="' + TITLE_KEY + '"');
    expect(tag).toContain('title="' + TITLE_RU + '"');           // fallback разметки = ru-словарь
    expect(OPTIONS_HTML).toContain('data-i18n="options_export_hidden_label"');
    expect(I18N_APPLY_SRC).toContain("{ key: 'data-i18n-title', target: 'title' }");
  });
});

// =====================================================================================
// R1: РЕГРЕСС O-7 — ТУЛ-МУСОР ПРИ OFF БЕЗ REASONING НЕ ВОЗВРАЩАЕТСЯ
// =====================================================================================
describe('D-O41 R1: OFF-зачистка O-7 (S1–S5) цела при sourceHasReasoning=false', () => {
  test('R1 тул-результаты (S3) и XML-вызовы (S4) в файл не едут; пустых ходов нет (S5)', () => {
    const input = toolJunkSource();
    expect(P.hasReasoningInSource(input)).toBe(false);            // условие пина R1
    const msgs = makeEmitter({ site: 'deepseek' }).run(input, false);
    expect(msgs).toHaveLength(1);                                 // user-ход из одних [TOOL_RESULTS] снят (S3)
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].text).toBe(TOOL_PROSE_BEFORE + '\n\n' + TOOL_PROSE_AFTER);
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).not.toContain('[TOOL_RESULTS]');
    expect(txt).not.toContain('Continue answering based on the tool results above.');
    expect(txt).not.toContain('<browser_type>');
    expect(txt).not.toContain('{\"text\": \"привет\"}');
    expect(txt).toContain(TOOL_PROSE_BEFORE);
    expect(txt).toContain(TOOL_PROSE_AFTER);
  });

  test('R1 следствие правила 5: при reasoning в источнике OFF идёт сырым путём (S1–S5 не зовётся)', () => {
    // Пинится ЧЕСТНО: OFF пользователя при sourceHasReasoning=true игнорируется, поэтому
    // санация S1–S5 на таком источнике не исполняется — это цена «WYSIWYG + авто-ON».
    const input = toolJunkSource();
    input[1].text = input[1].text + '\n\n' + SECTIONED;           // в источнике появилось размышление
    expect(P.hasReasoningInSource(input)).toBe(true);
    const msgs = makeEmitter({ site: 'deepseek' }).run(input, false);
    expect(msgs).toHaveLength(2);                                 // сырой путь: ничего не снято
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).toContain('[TOOL_RESULTS]');
    expect(txt).toContain('<browser_type>');
    expect(txt).toContain('[REASONING]');
  });
});

// =====================================================================================
// R2: РЕГРЕСС O-39 — 53/53 НА ИСТОРИИ QWEN
// =====================================================================================
describe('D-O41 R2: история Qwen с 53 размышлениями — 53/53 секций', () => {
  test('R2 sourceHasReasoning=true: [REASONING]/[ANSWER] = 53/53 (авто-ON и ON совпадают)', () => {
    const history = qwenHistory(53);
    const auto = makeEmitter({ site: 'qwen' }).run(history, false);   // тумблер OFF → авто-ON
    const on = makeEmitter({ site: 'qwen' }).run(history, true);
    expect(auto).toHaveLength(106);
    expect(auto.filter(function (m) { return m.reasoning; })).toHaveLength(53);
    const txtAuto = txtOf(auto);
    const txtOn = txtOf(on);
    expect(countOccurrences(txtAuto, '[REASONING]')).toBe(53);
    expect(countOccurrences(txtAuto, '[ANSWER]')).toBe(53);
    expect(countOccurrences(txtOn, '[REASONING]')).toBe(53);
    expect(countOccurrences(txtOn, '[ANSWER]')).toBe(53);
    expect(txtAuto).toBe(txtOn);
    expect(countOccurrences(mdOf(auto), '[REASONING]')).toBe(53);
  });
});

// =====================================================================================
// R3: GEMINI/AI STUDIO — ВЕТКА prepareExportMessages НЕ ТРОНУТА
// =====================================================================================
describe('D-O41 R3: Gemini/AI Studio байтово прежний при ON и OFF', () => {
  const GEMINI = [
    { role: 'user', text: 'Вопрос Gemini' },
    { role: 'assistant', text: 'Ответ Gemini' }
  ];

  test('R3 txt байтово одинаков при ON/OFF; секций reasoning не появляется', () => {
    const off = makeEmitter({ site: 'gemini' }).run(GEMINI, false);
    const on = makeEmitter({ site: 'gemini' }).run(GEMINI, true);
    expect(P.hasReasoningInSource(GEMINI)).toBe(false);
    expect(txtOf(off, 'gemini')).toBe('Вопрос Gemini\n\nОтвет Gemini');
    expect(txtOf(on, 'gemini')).toBe(txtOf(off, 'gemini'));
    expect(countOccurrences(txtOf(off, 'gemini'), '[REASONING]')).toBe(0);
  });

  test('R3 source-пины: ветка Gemini/AI Studio по-прежнему идёт через prepareExportMessages', () => {
    const dedupe = fnDecl(BASE_HANDLER_SRC, 'aiCmDedupeExportSource');
    expect(dedupe).toContain("if (site !== 'gemini' && site !== 'aistudio') {");
    expect(dedupe).toContain('P.prepareExportMessages(messages, aiCmLogIntraDedupe)');
    expect(PIPELINE_SRC).toContain('function prepareExportMessages(raw, onMessageDedupe)');
    // D-O41 в подготовку Gemini-ветки не вмешивается
    const prep = fnDecl(PIPELINE_SRC, 'prepareExportMessages');
    expect(prep).not.toContain('effectiveReasoningToggle');
    expect(prep).not.toContain('hasReasoningInSource');
  });
});
