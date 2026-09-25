/**
 * O-7 (Qwen): OFF-ТУМБЛЕР ГАСИТ [REASONING] В ЭКСПОРТЕ.
 *
 * Дефект (живой симптом владельца): при ВЫКЛЮЧЕННОМ тумблере «Включать reasoning и инъекции
 * DeepSeek++ в экспорт» (chrome.storage.local aiCmIncludeHiddenInExport, default OFF)
 * в txt/md Qwen всё равно попадали секции [REASONING]…[ANSWER]….
 *
 * Корень (порядок внутри core/export-manager.js:aiCmCollectExportSource):
 *   1) aiCmPrepareReasoningForExport(out) → applyReasoningExportFields ДО санации переводит
 *      размышление хода в ОТДЕЛЬНОЕ поле reasoning (из поля захвата hiddenReasoning или
 *      разбором пары секций из текста);
 *   2) OFF-путь санации (sanitizeEmitMessages) режет секции в тексте до части [ANSWER]
 *      и снимает hidden-поля — но поле reasoning ему неизвестно и остаётся;
 *   3) сборщики файла (utils/export-text-builders.js:messageTextWithReasoning) видят
 *      msg.reasoning и БЕЗУСЛОВНО дописывают секции заново.
 * Итог: тумблер OFF, а [REASONING] в файле есть.
 *
 * Фикс (core/export-manager.js, сразу ПОСЛЕ prepareReasoning(out)): на OFF-пути и только
 * для сайта, чей DESIGN-источник — DOM-адаптер (aiCmReasoningExportSite() → qwen), поле
 * reasoning снимается с сообщений точки сбора (служебные hidden-поля и так снимает OFF-путь
 * санации). Тогда OFF-файл = вопросы и ответы, ON-файл = секции на месте.
 *
 * Контур пинов:
 *   D1 — Qwen, сетевой снимок (поле reasoning + секции в тексте), OFF → счётчик [REASONING] 0
 *        в txt И md; текст хода — bare-ответ; поля reasoning в выходе нет;
 *   D2 — то же для снимка БЕЗ секций в тексте (поле reasoning отдельно), OFF → 0;
 *   D3 — OFF/ON на ОДНОМ входе: меняется ровно поле reasoning и вид файла (D/R-контракт);
 *   R1 — Qwen ON → [REASONING] в txt/md ровно одна пара (секции не потеряны);
 *   R2 — source-пины: блок стоит в aiCmCollectExportSource под гейтом тумблера и сайта;
 *   R3 — DeepSeek: OFF и ON работают КАК РАНЬШЕ (OFF — bare-ответ, ON — hidden-блок в тексте);
 *   R4 — прочие платформы (ChatGPT/Gemini/Claude/Perplexity/GSA): OFF и ON байтово идентичны,
 *        поля reasoning не появляется — тумблер их не задел.
 *
 * НЕ ТРОГАЕТСЯ: база/метрики (lastBaseTexts, tokens/percent/бейдж), логика O-20/O-40/O-42,
 * сборщики txt/md, DOM-ветка точки сбора (её OFF-контракт — вне scope этого фикса).
 *
 * D-O41 (2026-09-24, UX): у тумблера появился АВТО-ON — при наличии reasoning в ИСТОЧНИКЕ
 * (непустое поле reasoning ИЛИ секция [REASONING] в тексте) OFF пользователя игнорируется, и
 * источник идёт СЫРЫМ путём. Для Qwen это ровно те снимки, на которых стоят пины D1/D2 ниже.
 *
 * D-O41 ПЕРЕСМОТР (2026-09-25): авто-ON отменён ДЛЯ QWEN И DEEPSEEK — у обоих размышление
 * лежит в самом источнике сетевого пути, поэтому авто-ON срабатывал бы на каждом их чате и
 * делал бы явный OFF физически недостижимым. Для Qwen OFF снова значит force-exclude (ровно
 * контракт O-7 этого сьюта, пины D1/D2/D3), ON — include (пин R1). Полный контур пересмотра —
 * tests/d-o41-reasoning-auto-on.test.js (Q1–Q4, R1–R2); авто-ON у прочих сервисов — там же.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');

const REASONING = 'Пользователь здоровается и просит короткий ответ без лишних деталей. ' +
  'Отвечу приветствием и предложу помощь — этого достаточно.';
const ANSWER = 'Привет! Чем помочь?';
const QUESTION = 'привет';
const SECTIONED = '[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER;

const OTHER_SITES = ['chatgpt', 'gemini', 'claude', 'perplexity', 'google_search'];

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

/** Метка «Дата экспорта» в md — единственная недетерминированная часть. */
function normStamp(s) {
  return s.replace(/Дата экспорта: [^\n]+/g, 'Дата экспорта: <STAMP>');
}

// =====================================================================================
// Песочница: РЕАЛЬНЫЙ core/export-manager.js-регион (sanitizeGeminiText →
// aiCmSanitizeEmitUserTexts → aiCmReasoningExportSite/aiCmPrepareReasoningForExport →
// aiCmCollectExportSource) + переключатель тумблера (в песочнице переменная локальна).
// Приём взят из tests/deepseek-o7-hidden-export.test.js.
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
    /** Тумблер OFF/ON + сетевой прогон точки сбора (тексты = тексты сообщений снимка). */
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

function mdOf(msgs, site, platform) {
  return Builders.buildMdFromHistory({ site: site || 'qwen', messages: msgs }, platform || 'Qwen');
}

/** Снимок Qwen сетевого пути: размышление отдельным полем + СЕКЦИИ в тексте хода (живой O-39). */
function qwenSnapshotSectioned() {
  return [
    { role: 'user', text: QUESTION, id: 'u1' },
    { role: 'assistant', text: SECTIONED, id: 'a1', reasoning: REASONING, hiddenReasoning: REASONING }
  ];
}

/** Снимок Qwen сетевого пути: размышление отдельным полем, текст хода — bare-ответ. */
function qwenSnapshotFieldOnly() {
  return [
    { role: 'user', text: QUESTION, id: 'u1' },
    { role: 'assistant', text: ANSWER, id: 'a1', reasoning: REASONING }
  ];
}

// =====================================================================================
// D1/D2 (O-7 + D-O41 пересмотр): OFF + REASONING В ИСТОЧНИКЕ → force-exclude у Qwen
// (авто-ON не срабатывает: иначе явный OFF был бы недостижим — размышление всегда в источнике)
// =====================================================================================
describe('O-7/Qwen D1: OFF-тумблер гасит [REASONING] даже при reasoning в источнике', () => {
  test('D1 сетевой снимок с секциями в тексте (живой O-39) → 0 секций, текст хода — bare-ответ', () => {
    const e = makeEmitter({ site: 'qwen' });
    const msgs = e.run(qwenSnapshotSectioned(), false);      // тумблер OFF (default)

    expect(msgs).toHaveLength(2);
    // OFF-путь: нормализованное поле reasoning снято точкой сбора, секции текста урезаны
    // OFF-санацией (stripReasoningSections), служебное поле захвата снято там же.
    expect(Object.prototype.hasOwnProperty.call(msgs[1], 'reasoning')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(msgs[1], 'hiddenReasoning')).toBe(false);
    expect(msgs[1].text).toBe(ANSWER);
    expect(msgs[0].text).toBe(QUESTION);                     // ход пользователя не тронут

    const txt = txtOf(msgs);
    expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
    expect(countOccurrences(txt, '[REASONING]')).toBe(0);
    expect(countOccurrences(txt, '[ANSWER]')).toBe(0);
    expect(txt).not.toContain(REASONING);

    const md = mdOf(msgs);
    expect(countOccurrences(md, '[REASONING]')).toBe(0);
    expect(countOccurrences(md, '[ANSWER]')).toBe(0);
    expect(md).not.toContain(REASONING);
  });

  test('D2 снимок с полем reasoning без секций в тексте → OFF: поля нет, секций нет', () => {
    const e = makeEmitter({ site: 'qwen' });
    const msgs = e.run(qwenSnapshotFieldOnly(), false);
    expect(Object.prototype.hasOwnProperty.call(msgs[1], 'reasoning')).toBe(false);
    expect(msgs[1].text).toBe(ANSWER);
    expect(txtOf(msgs)).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
    expect(countOccurrences(txtOf(msgs), '[REASONING]')).toBe(0);
    expect(countOccurrences(mdOf(msgs), '[REASONING]')).toBe(0);
  });
});

// =====================================================================================
// D3 (O-7 + D-O41 пересмотр): OFF/ON на одном входе РАЗЛИЧАЮТСЯ (тумблер снова управляет)
// =====================================================================================
describe('O-7/Qwen D3: OFF и ON на источнике с reasoning дают разные файлы', () => {
  test('D3 один и тот же вход: OFF — вопросы и ответы, ON — секции; поля и байты расходятся', () => {
    const off = makeEmitter({ site: 'qwen' }).run(qwenSnapshotSectioned(), false);
    const on = makeEmitter({ site: 'qwen' }).run(qwenSnapshotSectioned(), true);

    expect(on[1].reasoning).toBe(REASONING);                 // ON: поле-данные сохранено
    expect(on[1].text).toBe(SECTIONED);                      // ON: текст хода как есть
    expect(off[1].reasoning).toBeUndefined();                // OFF: поля нет
    expect(off[1].text).toBe(ANSWER);                        // OFF: секции урезаны
    expect(JSON.stringify(off)).not.toBe(JSON.stringify(on));
    expect(countOccurrences(txtOf(off), '[REASONING]')).toBe(0);
    expect(countOccurrences(txtOf(on), '[REASONING]')).toBe(1);
    expect(countOccurrences(txtOf(on), '[ANSWER]')).toBe(1);
    // Прочие поля снимка (роль/id) обоими путями сохранены.
    expect(off[1].role).toBe('assistant');
    expect(on[1].role).toBe('assistant');
  });
});

// =====================================================================================
// R1: ON-ТУМБЛЕР — СЕКЦИИ НА МЕСТЕ
// =====================================================================================
describe('O-7/Qwen R1: ON-тумблер — reasoning в экспорте есть (ровно одна пара)', () => {
  test('R1 ON: txt и md несут ровно одну пару секций в порядке [REASONING] → [ANSWER]', () => {
    const e = makeEmitter({ site: 'qwen' });
    const msgs = e.run(qwenSnapshotSectioned(), true);

    const txt = txtOf(msgs);
    expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
    expect(countOccurrences(txt, '[REASONING]')).toBe(1);
    expect(countOccurrences(txt, '[ANSWER]')).toBe(1);
    expect(txt.indexOf('[REASONING]')).toBeLessThan(txt.indexOf('[ANSWER]'));

    const md = mdOf(msgs);
    expect(md).toContain('### ASSISTANT\n\n' + SECTIONED);
    expect(countOccurrences(md, '[REASONING]')).toBe(1);
    expect(countOccurrences(md, '[ANSWER]')).toBe(1);
    expect(md).toContain(REASONING);
  });
});

// =====================================================================================
// R2: SOURCE-ПИНЫ ОФФ-ПУТИ
// =====================================================================================
describe('O-7/Qwen R2: source-пины OFF-очистки', () => {
  test('R2 блок стоит в точке сбора под гейтом тумблера И сайта, снимает поле reasoning', () => {
    const fn = fnDecl(MGR_SRC, 'aiCmCollectExportSource');
    // typeof-гарды обеих опор — конвенция срез-песочниц (fnDecl): в них ни переменной
    // тумблера, ни предиката сайта нет, и блок обязан не исполняться (поведение 1:1).
    expect(fn).toContain("var hiddenExportOn = (typeof aiCmIncludeHiddenInExport !== 'undefined') && aiCmIncludeHiddenInExport === true;");
    expect(fn).toContain("var reasoningExportSite = (typeof aiCmReasoningExportSite === 'function') ? aiCmReasoningExportSite : null;");
    expect(fn).toContain('if (!hiddenExportOn && reasoningExportSite && reasoningExportSite()) {');
    expect(fn).toContain('delete out[ri].reasoning;');
    // Гейт сайта — ровно сервис с DOM-источником (qwen); прочие платформы не задеты.
    expect(fnDecl(MGR_SRC, 'aiCmReasoningExportSite')).toContain("currentAdapter.siteName === 'qwen'");
    // Инвариант O-7: экспорт-менеджер не знает служебных hidden-полей (их ведёт пайплайн).
    expect(fn).not.toContain('hiddenReasoning');
    // Порядок: очистка идёт ПОСЛЕ нормализации reasoning и ДО единственной точки санации.
    expect(fn.indexOf('if (prepareReasoning) prepareReasoning(out);'))
      .toBeLessThan(fn.indexOf('if (!hiddenExportOn && reasoningExportSite && reasoningExportSite()) {'));
    expect(fn.indexOf('if (!hiddenExportOn && reasoningExportSite && reasoningExportSite()) {'))
      .toBeLessThan(fn.indexOf('return aiCmSanitizeEmitUserTexts(out);'));
  });
});

// =====================================================================================
// R3: DeepSeek — ТУМБЛЕР РАБОТАЕТ КАК РАНЬШЕ
// =====================================================================================
describe('O-7/Qwen R3: DeepSeek не задет — OFF/ON прежние (D-O41 пересмотр: тот же force-exclude)', () => {
  const DS_SNAPSHOT = [
    { role: 'user', text: 'вопрос', id: 'u1' },
    { role: 'assistant', text: SECTIONED, id: 'a1', hiddenReasoning: REASONING }
  ];
  // Источник БЕЗ reasoning (нет секций в тексте и нет поля reasoning): OFF-путь и здесь прежний.
  const DS_SNAPSHOT_PLAIN = [
    { role: 'user', text: 'вопрос', id: 'u1' },
    { role: 'assistant', text: ANSWER, id: 'a1', hiddenReasoning: REASONING }
  ];

  test('R3 DeepSeek OFF (источник без reasoning): hidden снят, секций нет — байты прежние', () => {
    const msgs = makeEmitter({ site: 'deepseek' }).run(DS_SNAPSHOT_PLAIN, false);
    expect(msgs[1].text).toBe(ANSWER);
    expect(msgs[1].reasoning).toBeUndefined();
    expect(msgs[1].hiddenReasoning).toBeUndefined();
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).toBe('вопрос\n\n' + ANSWER);
    expect(countOccurrences(txt, '[REASONING]')).toBe(0);
  });

  test('R3 DeepSeek OFF + секции источника: force-exclude — секции урезаны до [ANSWER]', () => {
    // D-O41 пересмотр (2026-09-25): DeepSeek в паре с Qwen — OFF значит принудительное
    // исключение reasoning; авто-ON у него не срабатывает.
    const msgs = makeEmitter({ site: 'deepseek' }).run(DS_SNAPSHOT, false);
    expect(msgs[1].text).toBe(ANSWER);                        // OFF-санация урезала секции
    expect(msgs[1].reasoning).toBeUndefined();
    expect(msgs[1].hiddenReasoning).toBeUndefined();         // служебное поле снято OFF-путём
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).toBe('вопрос\n\n' + ANSWER);
    expect(countOccurrences(txt, '[REASONING]')).toBe(0);
    expect(txt).not.toContain(REASONING);
  });

  test('R3 DeepSeek ON: hidden-блок в тексте → секции прежние (без правок OFF-пути)', () => {
    const msgs = makeEmitter({ site: 'deepseek' }).run(DS_SNAPSHOT, true);
    expect(msgs[1].hiddenReasoning).toBeUndefined();          // служебное поле уже в тексте
    expect(msgs[1].text).toBe(SECTIONED);
    const txt = txtOf(msgs, 'deepseek');
    expect(txt).toBe('вопрос\n\n' + SECTIONED);
    expect(countOccurrences(txt, '[REASONING]')).toBe(1);
    expect(countOccurrences(txt, '[ANSWER]')).toBe(1);
  });
});

// =====================================================================================
// R4: ПРОЧИЕ ПЛАТФОРМЫ — OFF И ON БАЙТОВО ИДЕНТИЧНЫ
// =====================================================================================
describe('O-7/Qwen R4: ChatGPT/Gemini/Claude/Perplexity/GSA — OFF и ON байтово идентичны', () => {
  OTHER_SITES.forEach(function (site) {
    test('R4 ' + site + ': OFF = ON побайтово, поля reasoning не появляется', () => {
      const snapshot = [
        { role: 'user', text: 'вопрос ' + site, id: 'u1' },
        { role: 'assistant', text: 'ответ ' + site, id: 'a1' }
      ];
      const off = makeEmitter({ site: site }).run(snapshot, false);
      const on = makeEmitter({ site: site }).run(snapshot, true);

      off.forEach(function (m) {
        expect(Object.prototype.hasOwnProperty.call(m, 'reasoning')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(m, 'hiddenReasoning')).toBe(false);
      });
      expect(on).toEqual(off);

      const txtOff = txtOf(off, site);
      const txtOn = txtOf(on, site);
      expect(txtOn).toBe(txtOff);
      expect(txtOff).toBe('вопрос ' + site + '\n\nответ ' + site);
      expect(countOccurrences(txtOff, '[REASONING]')).toBe(0);

      const mdOff = normStamp(mdOf(off, site, site));
      const mdOn = normStamp(mdOf(on, site, site));
      expect(mdOn).toBe(mdOff);
      expect(countOccurrences(mdOff, '[REASONING]')).toBe(0);
      expect(mdOff).toContain('## Пользователь\n\nвопрос ' + site);
      expect(mdOff).toContain('## Ассистент\n\nответ ' + site);
    });
  });
});
