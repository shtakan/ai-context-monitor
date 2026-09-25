/**
 * D-O41 (UX): АВТО-ON ТУМБЛЕРА `aiCmIncludeHiddenInExport` ПРИ НАЛИЧИИ REASONING В ИСТОЧНИКЕ.
 * ПЕРЕСМОТР 2026-09-25: Qwen и DeepSeek ИСКЛЮЧЕНЫ из авто-ON.
 *
 * Спецификация владельца (D-O41 — 2026-09-24, вариант «в» мировых стандартов: WYSIWYG +
 * smart defaults; пересмотр — 2026-09-25):
 *   1. Правило (пересмотр): effectiveToggle = (userToggle === OFF && sourceHasReasoning === true
 *      && site !== 'qwen' && site !== 'deepseek') ? ON : userToggle;
 *   2. sourceHasReasoning = true, если в источнике экспорта ≥1 сообщение с НЕПУСТЫМ полем
 *      reasoning ИЛИ ≥1 секция [REASONING] в тексте (служебное hiddenReasoning нарочно НЕ
 *      считается: иначе OFF-путь O-7 не исполнялся бы ни на одном DeepSeek++-чате);
 *   3. у Qwen/DeepSeek OFF = force-exclude (как OFF-зачистка O-7/S1–S5 у DeepSeek): их сетевой
 *      источник ВСЕГДА несёт секции [REASONING], поэтому авто-ON срабатывал бы на каждом их чате
 *      и делал бы явный OFF физически недостижимым; ON у них — include, как прежде;
 *   4. у остальных сервисов (Gemini/Perplexity/ChatGPT/Claude/GSA) авто-ON работает как в D-O41;
 *   5. точка применения — ДО единственной точки выхода рендера (withReasoningSections,
 *      utils/export-text-builders.js:48): OFF-зачистка S1–S5 (O-7) исполняется РОВНО при
 *      эффективном OFF;
 *   6. UI: tooltip тумблера в options + обеих локалях.
 *
 * Контур пинов:
 *   S1 — чистая точка правила: hasReasoningInSource/effectiveReasoningToggle в пайплайне
 *        (формула пересмотра — в одной чистой функции, третьим аргументом site);
 *   S2 — проводка: ЕДИНСТВЕННАЯ точка чтения тумблера aiCmHiddenExportEffectiveOn
 *        (core/export-manager.js) передаёт site из currentAdapter; её зовут точка санации и
 *        точка сбора; OFF-литералы и OFF-путь S1–S5 не переписаны;
 *   S3 — таблицы истинности обеих чистых функций (включая ось site);
 *   Q1 — Qwen + reasoning + OFF → файл БЕЗ [REASONING] (0 секций, только вопрос и ответ);
 *   Q2 — Qwen + reasoning + ON  → файл С [REASONING] (include-путь прежний);
 *   Q3 — DeepSeek + reasoning + OFF → файл БЕЗ [REASONING] (регресс O-7 в силе);
 *   Q4 — Gemini (и прочие сервисы) + reasoning + OFF → файл С [REASONING] (авто-ON D-O41);
 *   D2 — источник БЕЗ reasoning + OFF → 0 секций у ЛЮБОГО сервиса (force-exclude);
 *   D3 — источник с reasoning + ON → [REASONING] (сырой режим),
 *   D4 — источник без reasoning + ON/OFF → байты файла идентичны;
 *   D5 — UI: tooltip тумблера (обе локали + разметка options);
 *   R1 — регресс O-7: DeepSeek-тул-мусор при OFF и sourceHasReasoning=false НЕ возвращается;
 *        отдельно пинится пересмотр — при reasoning в источнике у DeepSeek OFF ТОЖЕ исполняет
 *        S1–S5 (раньше авто-ON отменял зачистку, теперь OFF снова «только вопросы и ответы»);
 *   R2 — регресс O-39: история Qwen с 53 размышлениями → на ON-пути [REASONING]/[ANSWER] = 53/53;
 *   R3 — Gemini/AI Studio: ветка prepareExportMessages не тронута, txt байтово прежний ON/OFF.
 *
 * НЕ ТРОГАЕТСЯ: CHANGELOG/версия (релизный коммит отдельно), сборщики txt/md, OFF-зачистка
 * S1–S5 (O-7) и её чистые функции, база/метрики/бейдж (они по-прежнему считаются по базовому
 * тексту и от тумблера не зависят; граница DOM-ветки точки сбора — вне scope, см.
 * tests/qwen-reasoning-export-o37.test.js).
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
// Пункт 6 спецификации — строки дословно.
const TITLE_RU = 'Reasoning автоматически включается при наличии в источнике; тумблер принудительно исключает';
const TITLE_EN = 'Reasoning auto-included when present in source; toggle forces exclude';

const QUESTION = 'привет';
const REASONING = 'Пользователь здоровается. Отвечу приветствием и предложу помощь.';
const ANSWER = 'Привет! Чем помочь?';
const SECTIONED = '[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER;

// Сервисы АВТО-ON (пункт 4 спецификации) и сервисы force-exclude (пункт 3).
const FORCE_EXCLUDE_SITES = ['qwen', 'deepseek'];
const AUTO_ON_SITES = ['gemini', 'perplexity', 'chatgpt', 'claude', 'google_search'];
// Эталонный сервис авто-ON для D-пинов (buildTxtFromHistory без ролевых маркеров qwen).
const AUTO_ON_SITE = 'claude';

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
  const site = o.site || AUTO_ON_SITE;
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
  return Builders.buildTxtFromHistory({ site: site || AUTO_ON_SITE, messages: msgs });
}

function mdOf(msgs, site) {
  return Builders.buildMdFromHistory({ site: site || AUTO_ON_SITE, messages: msgs }, 'X');
}

/** Снимок сетевого пути: секции в тексте + поле reasoning (живой путь O-39/Qwen). */
function qwenSectioned() {
  return [
    { role: 'user', text: QUESTION, id: 'u1' },
    { role: 'assistant', text: SECTIONED, id: 'a1', reasoning: REASONING, hiddenReasoning: REASONING }
  ];
}

/** Снимок сетевого пути: только поле reasoning, текст — bare-ответ. */
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
    expect(PIPELINE_SRC).toContain('function effectiveReasoningToggle(userToggle, sourceHasReasoning, site)');
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
    expect(eff).toContain("if (site === 'qwen' || site === 'deepseek') return false;");
    expect(eff).not.toContain('hiddenReasoning');
    expect(eff).not.toContain('chrome');
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

  test('S3: effectiveReasoningToggle — таблица истинности правила владельца (пересмотр)', () => {
    // ON пользователя — ON при любом источнике и любом сервисе (include-путь)
    expect(P.effectiveReasoningToggle(true, false, 'qwen')).toBe(true);
    expect(P.effectiveReasoningToggle(true, true, 'qwen')).toBe(true);
    expect(P.effectiveReasoningToggle(true, true, 'gemini')).toBe(true);
    expect(P.effectiveReasoningToggle(true, false)).toBe(true);
    // OFF + reasoning: у прочих сервисов авто-ON…
    AUTO_ON_SITES.forEach(function (site) {
      expect([site, P.effectiveReasoningToggle(false, true, site)]).toEqual([site, true]);
    });
    // …у Qwen/DeepSeek (пункт 3) — force-exclude: авто-ON не срабатывает
    FORCE_EXCLUDE_SITES.forEach(function (site) {
      expect([site, P.effectiveReasoningToggle(false, true, site)]).toEqual([site, false]);
    });
    // OFF без reasoning — force-exclude у ЛЮБОГО сервиса
    AUTO_ON_SITES.concat(FORCE_EXCLUDE_SITES).forEach(function (site) {
      expect([site, P.effectiveReasoningToggle(false, false, site)]).toEqual([site, false]);
    });
    // не задан тумблер = OFF (как в загрузчике настроек), результат всегда boolean
    expect(P.effectiveReasoningToggle(undefined, true, 'gemini')).toBe(true);
    expect(P.effectiveReasoningToggle(undefined, true, 'qwen')).toBe(false);
    expect(P.effectiveReasoningToggle(undefined, false)).toBe(false);
    expect(P.effectiveReasoningToggle(false, undefined, 'gemini')).toBe(false);
    expect(P.effectiveReasoningToggle('true', true, 'gemini')).toBe(true);
    // site не передан (прежние вызовы/срез-песочницы) → поведение исходного D-O41 (авто-ON)
    expect(P.effectiveReasoningToggle(false, true)).toBe(true);
    expect(P.effectiveReasoningToggle(false, true, '')).toBe(true);
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
    expect(helper).toContain("currentAdapter.siteName");
    expect(helper).toContain('P.effectiveReasoningToggle(userOn, P.hasReasoningInSource(messages) === true, site)');
    // Хелпера нет (срез-песочница) → пользовательское значение: конвенция typeof-гардов.
    expect(helper).toContain("typeof P.hasReasoningInSource !== 'function'");
    // адаптера нет → пустой site → правило прочих сервисов (авто-ON), поведение прежнее 1:1
    expect(helper).toContain('? currentAdapter.siteName : \'\'');

    const entry = fnDecl(MGR_SRC, 'aiCmSanitizeEmitUserTexts');
    expect(entry).toContain("typeof aiCmHiddenExportEffectiveOn === 'function'");
    expect(entry).toContain('aiCmHiddenExportEffectiveOn(messages)');
    expect(entry).toContain('if (hiddenExportEffective) {');
    // OFF-путь и его литералы прежние (S1–S5 / O-20 / O-40 в пайплайне не переписаны)
    expect(entry).toContain('var res = P.sanitizeEmitMessages(messages);');
    expect(entry).toContain('aiCmLogSanitizeSkip(res && res.skipped);');
    expect(entry).toContain('return (res && Array.isArray(res.messages)) ? res.messages : messages;');
    expect(entry).toContain('if (aiCmIncludeHiddenInExport === true) {');
    // авто-ON проверяется ДО OFF-пути (правило 5: S1–S5 — только при эффективном OFF)
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
// Q1/Q2: QWEN — OFF = force-exclude, ON = include
// =====================================================================================
describe('D-O41 Q1/Q2: Qwen — OFF гасит reasoning, ON его отдаёт', () => {
  test('Q1 Qwen + reasoning (поле и секции) + OFF → 0 секций [REASONING], только вопрос и ответ', () => {
    [qwenSectioned(), qwenFieldOnly()].forEach(function (source, i) {
      const msgs = makeEmitter({ site: 'qwen' }).run(source, false);      // тумблер OFF
      expect([i, msgs[1].text]).toEqual([i, ANSWER]);                     // секции урезаны, дубля нет
      expect(msgs[1].reasoning).toBeUndefined();                          // поле-данные снято
      expect(Object.prototype.hasOwnProperty.call(msgs[1], 'hiddenReasoning')).toBe(false);
      const txt = txtOf(msgs, 'qwen');
      expect([i, countOccurrences(txt, '[REASONING]')]).toEqual([i, 0]);
      expect([i, countOccurrences(txt, '[ANSWER]')]).toEqual([i, 0]);
      expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
      expect(txt).not.toContain(REASONING);
      expect(countOccurrences(mdOf(msgs, 'qwen'), '[REASONING]')).toBe(0);
    });
    // антипин: тот же источник при ON секции несёт (тумблер снова управляет, авто-ON нет)
    expect(countOccurrences(txtOf(makeEmitter({ site: 'qwen' }).run(qwenSectioned(), true), 'qwen'), '[REASONING]')).toBe(1);
  });

  test('Q2 Qwen + reasoning + ON → [REASONING] в файле (include-путь прежний)', () => {
    const msgs = makeEmitter({ site: 'qwen' }).run(qwenFieldOnly(), true);
    expect(msgs[1].reasoning).toBe(REASONING);
    const txt = txtOf(msgs, 'qwen');
    expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
    expect(countOccurrences(txt, '[REASONING]')).toBe(1);
    expect(countOccurrences(txt, '[ANSWER]')).toBe(1);
    expect(txt.indexOf('[REASONING]')).toBeLessThan(txt.indexOf('[ANSWER]'));
    expect(countOccurrences(mdOf(msgs, 'qwen'), '[REASONING]')).toBe(1);
  });
});

// =====================================================================================
// Q3/Q4: DEEPSEEK — force-exclude; ПРОЧИЕ СЕРВИСЫ — авто-ON (D-O41 в силе)
// =====================================================================================
describe('D-O41 Q3/Q4: DeepSeek — force-exclude; Gemini и прочие — авто-ON', () => {
  test('Q3 DeepSeek + reasoning + OFF → 0 секций (регресс O-7 в силе, авто-ON не срабатывает)', () => {
    const source = [
      { role: 'user', text: QUESTION, id: 'u1' },
      { role: 'assistant', text: SECTIONED, id: 'a1' }
    ];
    const msgs = makeEmitter({ site: 'deepseek' }).run(source, false);
    expect(msgs[1].text).toBe(ANSWER);                                  // stripReasoningSections OFF-пути
    expect(msgs[1].reasoning).toBeUndefined();
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).toBe(QUESTION + '\n\n' + ANSWER);
    expect(countOccurrences(txt, '[REASONING]')).toBe(0);
    expect(txt).not.toContain(REASONING);
    // ON-путь того же источника (include) — секции на месте
    const onTxt = txtOf(makeEmitter({ site: 'deepseek' }).run(source, true), 'deepseek');
    expect(countOccurrences(onTxt, '[REASONING]')).toBe(1);
  });

  AUTO_ON_SITES.forEach(function (site) {
    test('Q4 ' + site + ' + reasoning + OFF → авто-ON D-O41: [REASONING] в файле', () => {
      expect(P.hasReasoningInSource(qwenFieldOnly())).toBe(true);
      const byField = makeEmitter({ site: site }).run(qwenFieldOnly(), false);
      expect([site, byField[1].reasoning]).toEqual([site, REASONING]);
      expect(countOccurrences(txtOf(byField, site), '[REASONING]')).toBe(1);
      // источник с секциями в тексте: OFF не урезает источник, дубля нет
      const bySection = makeEmitter({ site: site }).run(qwenSectioned(), false);
      expect([site, bySection[1].text]).toEqual([site, SECTIONED]);
      expect([site, bySection[1].hiddenReasoning]).toEqual([site, undefined]);
      const txt = txtOf(bySection, site);
      expect([site, countOccurrences(txt, '[REASONING]')]).toEqual([site, 1]);
      expect([site, countOccurrences(txt, REASONING)]).toEqual([site, 1]);
      // ON-путь байтово совпадает с авто-ON (пункт 4: OFF и ON дают один и тот же файл)
      expect(txtOf(makeEmitter({ site: site }).run(qwenSectioned(), true), site)).toBe(txt);
    });
  });
});

// =====================================================================================
// D2: ИСТОЧНИК БЕЗ REASONING + OFF → 0 СЕКЦИЙ (force-exclude у любого сервиса)
// =====================================================================================
describe('D-O41 D2: OFF без reasoning в источнике — секций нет (force-exclude)', () => {
  test('D2 txt/md: 0 секций [REASONING], тексты — как раньше', () => {
    const msgs = makeEmitter({ site: AUTO_ON_SITE }).run(plainSource(), false);
    msgs.forEach(function (m) {
      expect(Object.prototype.hasOwnProperty.call(m, 'reasoning')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(m, 'hiddenReasoning')).toBe(false);
    });
    const txt = txtOf(msgs);
    expect(txt).toBe('вопрос без размышления\n\nответ без размышления');
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
  test('D3 источник с reasoning + ON: файл содержит [REASONING]; авто-ON сервисов = ON', () => {
    const on = makeEmitter({ site: AUTO_ON_SITE }).run(qwenSectioned(), true);
    const auto = makeEmitter({ site: AUTO_ON_SITE }).run(qwenSectioned(), false);
    const txtOn = txtOf(on);
    expect(countOccurrences(txtOn, '[REASONING]')).toBe(1);
    expect(countOccurrences(txtOn, '[ANSWER]')).toBe(1);
    expect(txtOn).toBe(txtOf(auto));                            // авто-ON-путь = ON-путь байтово
    expect(JSON.stringify(on)).toBe(JSON.stringify(auto));
  });

  test('D4 источник без reasoning + ON/OFF: байты файла идентичны (авто-ON не срабатывает)', () => {
    const off = makeEmitter({ site: AUTO_ON_SITE }).run(plainSource(), false);
    const on = makeEmitter({ site: AUTO_ON_SITE }).run(plainSource(), true);
    // «Дата экспорта»/exportedAt — единственная недетерминированная часть сборщиков
    // (два последовательных вызова могут пересечь миллисекундную границу): нормализуем её,
    // сравнивая именно БАЙТЫ файла по обеим ветками тумблера.
    const stamp = (s) => String(s)
      .replace(/Дата экспорта: [^\n]*/g, 'Дата экспорта: <STAMP>')
      .replace(/"exportedAt": "[^"]*"/g, '"exportedAt": "<STAMP>"');
    expect(txtOf(on)).toBe(txtOf(off));
    expect(stamp(mdOf(on))).toBe(stamp(mdOf(off)));
    expect(stamp(Builders.buildJsonFromHistory({ site: AUTO_ON_SITE, messages: on })))
      .toBe(stamp(Builders.buildJsonFromHistory({ site: AUTO_ON_SITE, messages: off })));
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
// R1: РЕГРЕСС O-7 — ТУЛ-МУСОР ПРИ OFF НЕ ВОЗВРАЩАЕТСЯ
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

  test('R1 пересмотр: при reasoning в источнике OFF у DeepSeek ТОЖЕ исполняет S1–S5', () => {
    // D-O41 (2026-09-24) игнорировал явный OFF при reasoning в источнике → санация S1–S5 на
    // таком источнике не исполнялась. ПЕРЕСМОТР (2026-09-25): DeepSeek в паре force-exclude,
    // поэтому OFF снова = «только вопросы и ответы»: тул-мусор вырезан, секции урезаны.
    const input = toolJunkSource();
    input[1].text = input[1].text + '\n\n' + SECTIONED;           // в источнике появилось размышление
    expect(P.hasReasoningInSource(input)).toBe(true);
    const msgs = makeEmitter({ site: 'deepseek' }).run(input, false);
    expect(msgs).toHaveLength(1);                                 // S3: ход из одних тул-результатов снят
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).not.toContain('[TOOL_RESULTS]');
    expect(txt).not.toContain('<browser_type>');
    expect(txt).not.toContain('[REASONING]');                    // и секции урезаны OFF-путём
    expect(txt).toContain(TOOL_PROSE_BEFORE);
    expect(txt).toContain(TOOL_PROSE_AFTER);
  });
});

// =====================================================================================
// R2: РЕГРЕСС O-39 — 53/53 НА ИСТОРИИ QWEN (ON-ПУТЬ)
// =====================================================================================
describe('D-O41 R2: история Qwen с 53 размышлениями — 53/53 секций на ON-пути', () => {
  test('R2 ON: [REASONING]/[ANSWER] = 53/53 (регресс O-39 не сломан)', () => {
    const history = qwenHistory(53);
    const on = makeEmitter({ site: 'qwen' }).run(history, true);
    expect(on).toHaveLength(106);
    expect(on.filter(function (m) { return m.reasoning; })).toHaveLength(53);
    const txtOn = txtOf(on, 'qwen');
    expect(countOccurrences(txtOn, '[REASONING]')).toBe(53);
    expect(countOccurrences(txtOn, '[ANSWER]')).toBe(53);
    expect(countOccurrences(mdOf(on, 'qwen'), '[REASONING]')).toBe(53);
  });

  test('R2 честная граница пересмотра: OFF на той же истории даёт 0 секций (force-exclude Qwen)', () => {
    const off = makeEmitter({ site: 'qwen' }).run(qwenHistory(53), false);
    expect(off.filter(function (m) { return m.reasoning; })).toHaveLength(0);
    const txtOff = txtOf(off, 'qwen');
    expect(countOccurrences(txtOff, '[REASONING]')).toBe(0);
    expect(countOccurrences(txtOff, '[ANSWER]')).toBe(0);
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
    // D-O41 (и его пересмотр) в подготовку Gemini-ветки не вмешивается
    const prep = fnDecl(PIPELINE_SRC, 'prepareExportMessages');
    expect(prep).not.toContain('effectiveReasoningToggle');
    expect(prep).not.toContain('hasReasoningInSource');
  });
});
