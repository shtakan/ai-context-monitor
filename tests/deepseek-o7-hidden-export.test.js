/**
 * O-7 (Medium): тумблер «Включать reasoning и инъекции DeepSeek++ в экспорт».
 *
 * Продуктовое решение владельца:
 *   default OFF = ТЕКУЩЕЕ поведение экспорта байтово прежнее (санация O-20 активна,
 *                 hidden-блоки не включаются; reasoning сетевого пути, как и раньше,
 *                 лежит в тексте хода секциями [REASONING]/[ANSWER] — v8);
 *   ON          = РОВНО ОДИН сырой режим: hidden-reasoning идёт в текст ОТДЕЛЬНЫМ блоком
 *                 с пометкой [REASONING]…[ANSWER]…, инъекции DeepSeek++ — КАК ЕСТЬ
 *                 (санация O-20 не применяется).
 * Метрики (tokens/pct/limit/модель/бейдж) считаются БЕЗ hidden-блоков при ЛЮБОМ положении
 * тумблера: hidden живёт отдельным полем захвата (hiddenReasoning), а не в тексте.
 *
 * Контур сьюта (правило R-D: пины на КАЖДЫЙ путь захвата + на единственную точку выхода):
 *   D1 — тумблер ON → md/txt/json/pdf несут reasoning-блок и инъекции; DOM-путь (панель
 *        размышлений, отброшенная на захвате) и сетевой путь (инъекции в user-тексте);
 *   D2 — тумблер OFF → БАЙТЫ экспорта идентичны текущему поведению для всех 6 платформ
 *        (независимый оракул O-20 + буквальный байтовый пин txt);
 *   R1 — санация O-20 при OFF активна (инъекции вырезаны, лог пропуска жив);
 *   R2 — tokens/pct/база не меняются от положения тумблера;
 *   R3 — регресс-наборы O-11/O-31/O-27/O-33/O-15…O-20 и версия не тронуты;
 *   R4 — i18n/a11y: ключи в ОБЕИХ локалях, разметка с label[for], default OFF в UI;
 *   R5 — version-hygiene/changelog-format: версия 2.0.8, CHANGELOG не тронут (релиз — отдельно).
 */
const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const buildReferenceText = require('../utils/buildReferenceText.js');

const ROOT = path.join(__dirname, '..');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

const PIPELINE_SRC = read('utils/export-emit-pipeline.js');
const EXPORT_MGR_SRC = read('core/export-manager.js');
const BASE_HANDLER_SRC = read('core/base-handler.js');
const CONTENT_SRC = require('./helpers/content-source.js').contentSource;
const ADAPTER_SRC = read('adapters/deepseek-adapter.js');
const BASE_ADAPTER_SRC = read('adapters/base-adapter.js');
const INTERCEPT_SRC = read('core/deepseek-intercept.js');
const OPTIONS_JS = read('options/options.js');
const OPTIONS_HTML = read('options/options.html');
const PRINT_JS = read('print/print.js');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const changelog = read('CHANGELOG.md');
const ru = JSON.parse(read('_locales/ru/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));

const SETTING_KEY = 'aiCmIncludeHiddenInExport';
const HIDDEN_LABEL_KEY = 'options_export_hidden_label';
const HIDDEN_HINT_KEY = 'options_export_hidden_hint';
const HIDDEN_LABEL_RU = 'Включать reasoning и инъекции DeepSeek++ в экспорт';

// =====================================================================================
// Фикстуры: инъекции DeepSeek++ (реальные строки O-20) и reasoning-ход DeepSeek
// =====================================================================================
const START = '<!-- deepseek-pp-visible-user-prompt:start -->';
const END = '<!-- deepseek-pp-visible-user-prompt:end -->';

const VISIBLE_USER_TEXT = 'O-7: покажи мой вопрос целиком, без преамбулы DeepSeek++.';
const MEMORY_PREAMBLE = [
  'You have long-term memory. Existing memories:',
  '1. Пользователь работает с расширением DeepSeek++.',
  '2. Цель — экспорт истории чата.'
].join('\n');
const TOOL_SCHEMA = [
  'Tool call format reminder:',
  'Available tool tag names:',
  'These listed tools are executable by the extension.'
].join('\n');
// Инъекция = преамбула + тул-схема ДО маркеров, видимый текст МЕЖДУ, хвост ПОСЛЕ.
const INJECTED_USER_TEXT =
  MEMORY_PREAMBLE + '\n\n' + TOOL_SCHEMA + '\n\n' +
  START + '\n' + VISIBLE_USER_TEXT + '\n' + END +
  '\n\nContinue answering based on the tool results above.';

const REASONING_TEXT = 'Сначала вспомню определение, затем сравню варианты.';
const ANSWER_TEXT = 'Итог: берите вариант B.';
// Сетевой путь DeepSeek (v8): reasoning УЖЕ в тексте хода секциями [REASONING]/[ANSWER].
const NETWORK_ASSISTANT_TEXT = '[REASONING]\n' + REASONING_TEXT + '\n\n[ANSWER]\n' + ANSWER_TEXT;
// DOM-путь DeepSeek: текст хода БЕЗ панели размышлений — reasoning захватывается отдельно.
const DOM_ANSWER_TEXT = 'Тогда важны CPU и быстрый SSD.';
const DOM_REASONING_TEXT = 'Пользователь спрашивает про монтаж видео.';

// Токены/лимит/процент — серверная правда контекста; тумблер их НЕ пересчитывает.
const TOKENS = 4210;
const LIMIT = 131072;
const PERCENT = 3.2;

// Все 6 платформ: байтовый регресс-пин OFF считается по КАЖДОЙ.
const PLATFORMS = [
  { site: 'chatgpt', label: 'ChatGPT', model: 'GPT-4o', user: 'Вопрос ChatGPT', assistant: 'Ответ ChatGPT' },
  { site: 'gemini', label: 'Gemini', model: 'Gemini 2.5 Pro', user: 'Вопрос Gemini', assistant: 'Ответ Gemini' },
  {
    site: 'deepseek', label: 'DeepSeek', model: 'DeepSeek-V3',
    user: INJECTED_USER_TEXT, assistant: NETWORK_ASSISTANT_TEXT
  },
  { site: 'google_search', label: 'Google Search AI', model: 'Gemini 2.5 Flash', user: 'Вопрос GSA', assistant: 'Ответ GSA' },
  { site: 'claude', label: 'Claude', model: 'Claude 3.5 Sonnet', user: 'Вопрос Claude', assistant: 'Ответ Claude' },
  { site: 'perplexity', label: 'Perplexity', model: 'Sonar', user: 'Вопрос Perplexity', assistant: 'Ответ Perplexity' }
];

function networkMessages(fixture) {
  return [
    { role: 'user', text: fixture.user, id: 'u1' },
    { role: 'assistant', text: fixture.assistant, id: 'a1' }
  ];
}

function historyFrom(fixture, messages) {
  return {
    host: 'chat.example',
    convId: 'conv-o7-1',
    site: fixture.site,
    model: fixture.model,
    tokens: TOKENS,
    limit: LIMIT,
    percent: PERCENT,
    updatedAt: 1789000000000,
    messages: messages
  };
}

// =====================================================================================
// Оракул «текущего поведения» (НЕЗАВИСИМАЯ реализация O-20 + снятие hidden-полей):
// так выглядел экспорт ДО фикса O-7. Сравнение с ним и есть байтовый регресс-пин D2.
// =====================================================================================
function countMarker(text, marker) {
  let n = 0;
  let at = text.indexOf(marker);
  while (at !== -1) { n++; at = text.indexOf(marker, at + marker.length); }
  return n;
}

function oracleCurrentBehaviour(messages) {
  return messages.map(function (m) {
    if (!m || typeof m !== 'object') return m;
    // hidden-полей захвата в текущем экспорте не существовало вовсе; id точка эмита
    // сетевого пути не переносит — набор полей ровно {role, text}
    const base = { role: (m.role === 'user') ? 'user' : 'assistant', text: String(m.text == null ? '' : m.text) };
    if (m.role !== 'user') return base;
    const text = base.text;
    const starts = countMarker(text, START);
    const ends = countMarker(text, END);
    if (!(starts === 1 && ends === 1 && text.indexOf(END) > text.indexOf(START))) return base;
    const from = text.indexOf(START) + START.length;
    const to = text.indexOf(END, from);
    base.text = text.slice(from, to).trim();
    return base;
  });
}

// =====================================================================================
// Песочница: РЕАЛЬНАЯ единая точка выхода экспорта (core/export-manager.js)
// =====================================================================================
function sliceSource(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error('срез исходника не найден: ' + startMarker);
  return src.slice(start, end);
}

function makeEmitter(opts) {
  const o = opts || {};
  const logs = [];
  const sessionStore = {};
  if (o.debug === true) sessionStore.aiCmDebug = '1';
  const ctx = {
    window: { AiCmExportEmitPipeline: P },
    sessionStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null; },
      setItem: function (k, v) { sessionStore[k] = String(v); },
      removeItem: function (k) { delete sessionStore[k]; }
    },
    console: {
      log: function (m) { logs.push(String(m)); },
      warn: function () { }, error: function () { }, info: function () { }, debug: function () { }
    },
    lastBaseTexts: [],
    lastDetailMessages: null,
    baseSeen: o.baseSeen !== false,
    currentAdapter: o.adapter || { siteName: 'deepseek', extractMessages: function () { return []; } }
  };
  // Хвост песочницы: точка выхода + переключатель тумблера (в песочнице переменная локальна).
  const src = sliceSource(EXPORT_MGR_SRC, 'function sanitizeGeminiText(s)', '// T1-fix#3') +
    '\nctx.__emit = aiCmCollectExportSource;' +
    '\nctx.__setHidden = function (v) { aiCmIncludeHiddenInExport = (v === true); };' +
    '\nctx.__hidden = function () { return aiCmIncludeHiddenInExport; };';
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  return {
    ctx: ctx,
    logs: logs,
    run: function (messages) {
      ctx.lastBaseTexts = messages.map(function (m) { return String(m.text == null ? '' : m.text); });
      ctx.lastDetailMessages = messages;
      return ctx.__emit();
    },
    offline: function () { ctx.__setHidden(false); },
    online: function () { ctx.__setHidden(true); },
    hidden: function () { return ctx.__hidden(); }
  };
}

/** Сетевой путь (baseSeen=true) с выключенным тумблером — «как сейчас». */
function emitNetworkOff(fixture, messages) {
  const e = makeEmitter();
  e.offline();
  return e.run(messages || networkMessages(fixture));
}

/** Сетевой путь (baseSeen=true) с включённым тумблером — сырой режим. */
function emitNetworkOn(fixture, messages) {
  const e = makeEmitter();
  e.online();
  return e.run(messages || networkMessages(fixture));
}

// =====================================================================================
// Печатная форма (pdf): РЕАЛЬНЫЙ print/print.js в jsdom (тот же приём, что в O-20-сьюте)
// =====================================================================================
function installRendererStub() {
  window.MarkdownRenderer = {
    escapeHtml: function (s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    render: function (text) {
      return '<p>' + window.MarkdownRenderer.escapeHtml(text) + '</p>';
    }
  };
}

async function renderPdfForm(history) {
  jest.useFakeTimers();
  try {
    document.body.innerHTML = '<div class="print-wrap"><div id="print-banner"></div>' +
      '<div id="print-content"></div>' +
      '<div class="empty-state" id="empty-state" style="display:none;"></div></div>';
    document.title = '';
    installRendererStub();
    const chromeMock = {
      i18n: { getMessage: function () { return ''; } },
      tabs: {
        get: function (id, cb) { cb({ id: id, url: 'https://chat.deepseek.com/a/chat/s/conv-o7-1' }); },
        sendMessage: function (id, msg, cb) { cb({ data: history }); }
      },
      storage: { local: { get: function (keys, cb) { cb({}); } } },
      runtime: { lastError: null, sendMessage: function () { } }
    };
    const params = { get: function (name) { return (name === 'tab') ? '4242' : null; } };
    window.print = function () { };
    const consoleStub = { log: function () { }, warn: function () { }, error: function () { } };
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'document', 'chrome', 'console', 'setTimeout', 'clearTimeout', 'URLSearchParams', PRINT_JS);
    fn(window, document, chromeMock, consoleStub,
      function (cb, ms) { return setTimeout(cb, ms); },
      function (id) { return clearTimeout(id); },
      function () { return params; });
    await jest.advanceTimersByTimeAsync(200);
    return document.getElementById('print-content').innerHTML;
  } finally {
    jest.useRealTimers();
    try { delete window.MarkdownRenderer; } catch (e) { }
  }
}

// =====================================================================================
// Реальный DOM-адаптер DeepSeek (панель размышлений) в текущем jsdom-документе
// =====================================================================================
function bootDeepSeekAdapter() {
  // eslint-disable-next-line no-new-func
  const factory = new Function('debugLog', BASE_ADAPTER_SRC + '\n' + ADAPTER_SRC +
    '\nreturn DeepSeekAdapter;');
  return new (factory(function () { }))();
}

const DOM_HTML =
  '<div class="ds-message">' +
  '  <div class="ds-markdown"><p>' + DOM_ANSWER_TEXT + '</p></div>' +
  '  <div class="ds-think">' + DOM_REASONING_TEXT + '</div>' +
  '</div>';

beforeEach(() => {
  window.buildReferenceText = buildReferenceText;
});

afterEach(() => {
  document.body.innerHTML = '';
  try { delete window.MarkdownRenderer; } catch (e) { }
  try { delete window.print; } catch (e) { }
});

/* =====================================================================================
 * D1: тумблер ON — hidden-блоки (reasoning + инъекции) в тексте экспорта
 * ===================================================================================== */
describe('O-7 D1: тумблер ON — reasoning и инъекции DeepSeek++ в экспорте', () => {
  const ds = PLATFORMS[2];

  test('md: сырой user-текст с инъекциями + reasoning-блок сетевого пути', () => {
    const md = Builders.buildMdFromHistory(historyFrom(ds, emitNetworkOn(ds)), 'DeepSeek');
    expect(md).toContain(MEMORY_PREAMBLE);
    expect(md).toContain(TOOL_SCHEMA);
    expect(md).toContain('deepseek-pp-visible-user-prompt:start');
    expect(md).toContain('deepseek-pp-visible-user-prompt:end');
    expect(md).toContain(VISIBLE_USER_TEXT);
    expect(md).toContain('[REASONING]\n' + REASONING_TEXT);
    expect(md).toContain('[ANSWER]\n' + ANSWER_TEXT);
  });

  test('txt: буквальные байты сырого режима (преамбула, тул-схема, маркеры, reasoning)', () => {
    const txt = Builders.buildTxtFromHistory(historyFrom(ds, emitNetworkOn(ds)));
    expect(typeof txt).toBe('string');
    expect(txt).toContain(MEMORY_PREAMBLE);
    expect(txt).toContain('Tool call format reminder:');
    expect(txt).toContain(START);
    expect(txt).toContain(END);
    expect(txt).toContain('[REASONING]');
    expect(txt).toContain(ANSWER_TEXT);
  });

  test('json: messages[0].text — сырой текст с инъекциями; шапка не пересчитана', () => {
    const json = JSON.parse(Builders.buildJsonFromHistory(historyFrom(ds, emitNetworkOn(ds)), 'DeepSeek'));
    expect(json.messages[0].text).toBe(INJECTED_USER_TEXT);
    expect(json.messages[1].text).toBe(NETWORK_ASSISTANT_TEXT);
    expect(json.tokens).toBe(TOKENS);
    expect(json.limit).toBe(LIMIT);
    expect(json.percent).toBe(PERCENT);
  });

  test('pdf (print/print.js): инъекции и reasoning-блок в печатной форме', async () => {
    const html = await renderPdfForm(historyFrom(ds, emitNetworkOn(ds)));
    expect(html).toContain('Existing memories:');
    expect(html).toContain('deepseek-pp-visible-user-prompt:start');
    expect(html).toContain('[REASONING]');
    expect(html).toContain(ANSWER_TEXT);
  });

  test('DOM-ветка (baseSeen=false): захваченный reasoning уходит ОТДЕЛЬНЫМ блоком [REASONING]…[ANSWER]…', () => {
    document.body.innerHTML = DOM_HTML;
    const adapter = bootDeepSeekAdapter();
    const e = makeEmitter({ baseSeen: false, adapter: adapter });
    e.online();
    const msgs = e.run([]);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].text).toBe('[REASONING]\n' + DOM_REASONING_TEXT + '\n\n[ANSWER]\n' + DOM_ANSWER_TEXT);
  });

  test('reasoning, УЖЕ присутствующий в тексте, повторно не дописывается (нет дубля)', () => {
    const once = P.includeHiddenExportBlocks([
      { role: 'assistant', text: NETWORK_ASSISTANT_TEXT, hiddenReasoning: REASONING_TEXT }
    ]);
    expect(once[0].text).toBe(NETWORK_ASSISTANT_TEXT);
    expect(once[0].text.match(/\[REASONING\]/g).length).toBe(1);
    // идемпотентность: повторный вызов на своём же выходе ничего не меняет
    expect(P.includeHiddenExportBlocks(once)).toEqual(once);
  });

  test('includeHiddenExportBlocks: вход не мутируется, служебные поля в результат не текут', () => {
    const input = [{ role: 'assistant', text: DOM_ANSWER_TEXT, hiddenReasoning: DOM_REASONING_TEXT, id: 'a1' }];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = P.includeHiddenExportBlocks(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);      // вход байтово прежний
    expect(Object.prototype.hasOwnProperty.call(out[0], 'hiddenReasoning')).toBe(false);
    expect(out[0].id).toBe('a1');
    // сообщение БЕЗ hidden-захвата возвращается ТЕМ ЖЕ объектом
    const plain = { role: 'assistant', text: 'ответ' };
    expect(P.includeHiddenExportBlocks([plain])[0]).toBe(plain);
  });

  test('не-массив/мусор не роняет развёртывание hidden-блоков', () => {
    expect(P.includeHiddenExportBlocks(null)).toEqual([]);
    expect(P.includeHiddenExportBlocks(undefined)).toEqual([]);
    const arr = [null, 'x', { role: 'user', text: 'вопрос' }];
    expect(P.includeHiddenExportBlocks(arr).length).toBe(3);
  });
});

/* =====================================================================================
 * D2: тумблер OFF — БАЙТЫ идентичны текущему поведению для всех 6 платформ
 * ===================================================================================== */
describe('O-7 D2: тумблер OFF — байтовый регресс-пин текущего поведения', () => {
  test('OFF-выход === независимому оракулу O-20 (6 платформ, JSON.stringify побайтово)', () => {
    PLATFORMS.forEach(function (fixture) {
      const input = networkMessages(fixture);
      const off = emitNetworkOff(fixture, input);
      const oracle = oracleCurrentBehaviour(input);
      expect([fixture.site, JSON.stringify(off)]).toEqual([fixture.site, JSON.stringify(oracle)]);
    });
  });

  test('OFF: md/json/txt/pdf байтово равны экспорту из оракула (6 платформ)', async () => {
    // метка «Дата экспорта» в md/json — единственная недетерминированная часть; фиксируем её,
    // чтобы сравнение было именно ПОБАЙТОВЫМ (txt/pdf от текущего времени не зависят вовсе)
    const iso = jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-09-17T12:00:00.000Z');
    try {
      for (const fixture of PLATFORMS) {
        const input = networkMessages(fixture);
        const histOff = historyFrom(fixture, emitNetworkOff(fixture, input));
        const histRef = historyFrom(fixture, oracleCurrentBehaviour(input));
        expect([fixture.site, Builders.buildMdFromHistory(histOff, fixture.label)])
          .toEqual([fixture.site, Builders.buildMdFromHistory(histRef, fixture.label)]);
        expect([fixture.site, Builders.buildTxtFromHistory(histOff)])
          .toEqual([fixture.site, Builders.buildTxtFromHistory(histRef)]);
        expect([fixture.site, Builders.buildJsonFromHistory(histOff, fixture.label)])
          .toEqual([fixture.site, Builders.buildJsonFromHistory(histRef, fixture.label)]);
        const pdfOff = await renderPdfForm(histOff);
        const pdfRef = await renderPdfForm(histRef);
        expect([fixture.site, pdfOff]).toEqual([fixture.site, pdfRef]);
      }
    } finally {
      iso.mockRestore();
    }
  });

  test('OFF: буквальный байтовый пин txt (DeepSeek, сетевой путь) — прежний экспорт', () => {
    const txt = Builders.buildTxtFromHistory(historyFrom(PLATFORMS[2], emitNetworkOff(PLATFORMS[2])));
    // видимый текст пользователя + reasoning-секции хода; инъекций DeepSeek++ нет вовсе
    expect(txt).toBe(VISIBLE_USER_TEXT + '\n\n' + NETWORK_ASSISTANT_TEXT);
    expect(txt).not.toContain('deepseek-pp');
    expect(txt).not.toContain('Existing memories:');
    expect(txt).not.toContain('Tool call format reminder:');
  });

  test('OFF: источник-пин — прежний путь санации O-20 не переписан', () => {
    const fn = sliceSource(EXPORT_MGR_SRC, 'function aiCmSanitizeEmitUserTexts(messages)', '// v81: единая точка источников');
    expect(fn).toContain('var res = P.sanitizeEmitMessages(messages);');
    expect(fn).toContain('aiCmLogSanitizeSkip(res && res.skipped);');
    expect(fn).toContain('return (res && Array.isArray(res.messages)) ? res.messages : messages;');
    // тумблер выбирает ВЕТКУ, а не переписывает санацию
    expect(fn).toContain('if (aiCmIncludeHiddenInExport === true) {');
    // единая точка выхода экспорта держит РОВНО 3 обращения к ней (пин O-20 жив)
    const collect = sliceSource(EXPORT_MGR_SRC, 'function aiCmCollectExportSource()', 'function aiCmExportBaseSource(');
    expect(collect.match(/aiCmSanitizeEmitUserTexts\(/g).length).toBe(3);
    expect(BASE_HANDLER_SRC).toContain('return aiCmDedupeExportSource(aiCmCollectExportSource()).messages;');
  });

  test('OFF: сообщения без hidden-полей возвращаются ТЕМИ ЖЕ объектами (идентичность)', () => {
    const src = [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: 'ответ' }];
    const res = P.sanitizeEmitMessages(src);
    expect(res.messages[0]).toBe(src[0]);
    expect(res.messages[1]).toBe(src[1]);
  });

  test('умолчание тумблера — ВЫКЛ (отсутствие ключа = текущее поведение)', () => {
    const e = makeEmitter();
    expect(e.hidden()).toBe(false);
    expect(CONTENT_SRC).toContain('var aiCmIncludeHiddenInExport = false;');
    expect(CONTENT_SRC).toContain("chrome.storage.local.get(['aiCmIncludeHiddenInExport']");
    // загрузчик настроек автоэкспорта (M-13) не тронут ни строкой
    expect(CONTENT_SRC).toContain("chrome.storage.local.get(['aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt']");
    expect(CONTENT_SRC).toContain("autoExportSettings.fmt = (fmtRaw === 'md' || fmtRaw === 'json') ? fmtRaw : 'txt';");
  });
});

/* =====================================================================================
 * R1: санация O-20 при OFF активна
 * ===================================================================================== */
describe('O-7 R1: при OFF санация O-20 активна (инъекции вырезаны)', () => {
  const ds = PLATFORMS[2];

  test('md/txt/json OFF: инъекций нет, видимый текст на месте', () => {
    const hist = historyFrom(ds, emitNetworkOff(ds));
    const md = Builders.buildMdFromHistory(hist, 'DeepSeek');
    const txt = Builders.buildTxtFromHistory(hist);
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'DeepSeek'));
    expect(md).toContain(VISIBLE_USER_TEXT);
    expect(txt).toContain(VISIBLE_USER_TEXT);
    expect(json.messages[0].text).toBe(VISIBLE_USER_TEXT);
    [md, txt, JSON.stringify(json)].forEach(function (body) {
      expect(body).not.toContain('deepseek-pp');
      expect(body).not.toContain('Existing memories:');
      expect(body).not.toContain('Tool call format reminder:');
      expect(body).not.toContain('Continue answering based on the tool results above.');
    });
  });

  test('OFF не отдаёт наружу hidden-блоки: поле захвата снято (json без hiddenReasoning)', () => {
    document.body.innerHTML = DOM_HTML;
    const adapter = bootDeepSeekAdapter();
    const e = makeEmitter({ baseSeen: false, adapter: adapter });
    e.offline();
    const msgs = e.run([]);
    expect(msgs[0].text).toBe(DOM_ANSWER_TEXT);                       // базовый текст прежний
    expect(Object.prototype.hasOwnProperty.call(msgs[0], 'hiddenReasoning')).toBe(false);
    const json = JSON.parse(Builders.buildJsonFromHistory(historyFrom(ds, msgs), 'DeepSeek'));
    expect(JSON.stringify(json)).not.toContain('hiddenReasoning');
    expect(JSON.stringify(json)).not.toContain(DOM_REASONING_TEXT);
  });

  test('причина пропуска санации по-прежнему логируется под гейтом aiCmDebug', () => {
    const e = makeEmitter({ debug: true });
    e.offline();
    e.run([{ role: 'user', text: 'обычный вопрос' }, { role: 'assistant', text: 'ответ' }]);
    expect(e.logs.filter(function (l) { return l.indexOf('[AI CM][sanitize] skip reason=') === 0; }))
      .toEqual(['[AI CM][sanitize] skip reason=no-markers']);
  });

  test('OFF: санированный user-текст байтово равен видимому (оракул и продакшн совпали)', () => {
    expect(P.sanitizeInjectedUserText(INJECTED_USER_TEXT)).toBe(VISIBLE_USER_TEXT);
    expect(oracleCurrentBehaviour([{ role: 'user', text: INJECTED_USER_TEXT }])[0].text).toBe(VISIBLE_USER_TEXT);
  });
});

/* =====================================================================================
 * R2: метрики/база не зависят от положения тумблера
 * ===================================================================================== */
describe('O-7 R2: tokens/pct/база не меняются от тумблера', () => {
  const ds = PLATFORMS[2];

  test('OFF и ON: шапка md (токены/лимит/процент) байтово одинакова', () => {
    const mdOff = Builders.buildMdFromHistory(historyFrom(ds, emitNetworkOff(ds)), 'DeepSeek');
    const mdOn = Builders.buildMdFromHistory(historyFrom(ds, emitNetworkOn(ds)), 'DeepSeek');
    const tokensLine = 'Токены: ' + TOKENS + ' / ' + LIMIT + ' (' + PERCENT + '%)';
    expect(mdOff).toContain(tokensLine);
    expect(mdOn).toContain(tokensLine);
    // шапка (до первого сообщения) у OFF и ON совпадает побайтово
    expect(mdOff.slice(0, mdOff.indexOf('## '))).toBe(mdOn.slice(0, mdOn.indexOf('## ')));
  });

  test('OFF и ON: tokens/limit/percent в json равны, различается только текст', () => {
    const jOff = JSON.parse(Builders.buildJsonFromHistory(historyFrom(ds, emitNetworkOff(ds)), 'DeepSeek'));
    const jOn = JSON.parse(Builders.buildJsonFromHistory(historyFrom(ds, emitNetworkOn(ds)), 'DeepSeek'));
    expect([jOn.tokens, jOn.limit, jOn.percent]).toEqual([jOff.tokens, jOff.limit, jOff.percent]);
    expect([jOn.platform, jOn.model]).toEqual([jOff.platform, jOff.model]);
    expect(jOn.messages[0].text).not.toBe(jOff.messages[0].text);
  });

  test('ON не мутирует базу метрик: ctx.lastBaseTexts после эмита байтово прежние', () => {
    const input = networkMessages(ds);
    const e = makeEmitter();
    e.online();
    const before = input.map(function (m) { return m.text; });
    e.run(input);
    expect(e.ctx.lastBaseTexts).toEqual(before);
    expect(input[0].text).toBe(INJECTED_USER_TEXT);
    expect(input[1].text).toBe(NETWORK_ASSISTANT_TEXT);
  });

  test('source-пин: текст метрик (aiCmPreparedText/aiCmMetricBaseText) hidden-полей не видит', () => {
    const prepared = sliceSource(CONTENT_SRC, 'function aiCmPreparedText(messages)', 'function aiCmMetricBaseText(fallback)');
    const metric = sliceSource(CONTENT_SRC, 'function aiCmMetricBaseText(fallback)', '// ================= v61diag');
    expect(prepared).toContain('out.push(String((src[i] && src[i].text) || \'\'));');
    expect(prepared).not.toContain('hiddenReasoning');
    expect(metric).not.toContain('hiddenReasoning');
    expect(metric).toContain('return aiCmPreparedText(aiCmBasePrepared);');
    // metrics-текст строится из СХЛОПНУТОЙ БАЗЫ снимка, а не из выхода точки эмита
    expect(metric).not.toContain('aiCmSanitizeEmitUserTexts');
    expect(metric).not.toContain('includeHiddenExportBlocks');
  });
});

/* =====================================================================================
 * Захват: поля hidden в базе (adapter + intercept), базовый текст и метрики не тронуты
 * ===================================================================================== */
describe('O-7 capture: hidden-пометки в базе', () => {
  test('DOM-адаптер: reasoning панели уходит в hiddenReasoning, content — без панели', () => {
    document.body.innerHTML = DOM_HTML;
    const adapter = bootDeepSeekAdapter();
    const msgs = adapter.extractMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBe(DOM_ANSWER_TEXT);
    expect(msgs[0].hiddenReasoning).toBe(DOM_REASONING_TEXT);
    // метрики DOM-ветки считаются по content и длине массива — hidden их не меняет
    expect(adapter.getFullDialogText()).toBe(DOM_ANSWER_TEXT);
  });

  test('DOM-адаптер: ход без панели размышлений hidden-поле НЕ получает (байты прежние)', () => {
    document.body.innerHTML = '<div class="ds-message"><div class="ds-markdown"><p>' + DOM_ANSWER_TEXT + '</p></div></div>';
    const adapter = bootDeepSeekAdapter();
    const msgs = adapter.extractMessages();
    expect(Object.prototype.hasOwnProperty.call(msgs[0], 'hiddenReasoning')).toBe(false);
    expect(msgs[0]).toEqual({ role: 'assistant', content: DOM_ANSWER_TEXT });
  });

  test('DOM-адаптер: служебная шапка панели («DeepThink · 12 с») reasoning-ом не считается', () => {
    document.body.innerHTML =
      '<div class="ds-message"><div class="ds-markdown"><p>' + DOM_ANSWER_TEXT + '</p></div>' +
      '<div class="ds-think">DeepThink · 12 с</div>' +
      '<div class="ds-think">' + DOM_REASONING_TEXT + '</div></div>';
    const adapter = bootDeepSeekAdapter();
    const msgs = adapter.extractMessages();
    expect(msgs[0].content).toBe(DOM_ANSWER_TEXT);
    expect(msgs[0].hiddenReasoning).toBe(DOM_REASONING_TEXT);
    expect(msgs[0].hiddenReasoning).not.toContain('DeepThink');
  });

  test('DOM-адаптер: «висячий» reasoning отдельного узла — не сообщение, но не теряется', () => {
    // узел только с THINK перед ответом → reasoning приклеен к СЛЕДУЮЩЕМУ assistant-ходу
    document.body.innerHTML =
      '<div class="ds-message ds-think-content">Размышления: проверю цены.</div>' +
      '<div class="ds-message"><div class="ds-markdown"><p>' + DOM_ANSWER_TEXT + '</p></div></div>';
    const adapter = bootDeepSeekAdapter();
    const msgs = adapter.extractMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatchObject({ role: 'assistant', content: DOM_ANSWER_TEXT, hiddenReasoning: 'проверю цены.' });

    // и в конце ленты (следующего assistant нет) → к ПРЕДЫДУЩЕМУ assistant-ходу
    document.body.innerHTML =
      '<div class="ds-message"><div class="ds-markdown"><p>' + DOM_ANSWER_TEXT + '</p></div></div>' +
      '<div class="ds-message ds-think-content">Размышления: проверю цены.</div>';
    const msgsTail = bootDeepSeekAdapter().extractMessages();
    expect(msgsTail.length).toBe(1);
    expect(msgsTail[0]).toMatchObject({ role: 'assistant', content: DOM_ANSWER_TEXT, hiddenReasoning: 'проверю цены.' });
  });

  test('DOM-ветка + ON: «висячий» reasoning тоже доезжает до экспорта отдельным блоком', () => {
    document.body.innerHTML =
      '<div class="ds-message ds-think-content">Размышления: проверю цены.</div>' +
      '<div class="ds-message"><div class="ds-markdown"><p>' + DOM_ANSWER_TEXT + '</p></div></div>';
    const e = makeEmitter({ baseSeen: false, adapter: bootDeepSeekAdapter() });
    e.offline();
    const offTxt = Builders.buildTxtFromHistory(historyFrom(PLATFORMS[2], e.run([])));
    expect(offTxt).toBe(DOM_ANSWER_TEXT);
    e.online();
    const onTxt = Builders.buildTxtFromHistory(historyFrom(PLATFORMS[2], e.run([])));
    expect(onTxt).toBe('[REASONING]\nпроверю цены.\n\n[ANSWER]\n' + DOM_ANSWER_TEXT);
  });

  test('normalizeExportMessages несёт hiddenReasoning рядом с текстом (в text не входит)', () => {
    const out = P.normalizeExportMessages([
      { role: 'user', content: 'вопрос' },
      { role: 'assistant', content: DOM_ANSWER_TEXT, hiddenReasoning: DOM_REASONING_TEXT }
    ]);
    expect(out[0]).toEqual({ role: 'user', text: 'вопрос' });
    expect(out[1].text).toBe(DOM_ANSWER_TEXT);
    expect(out[1].hiddenReasoning).toBe(DOM_REASONING_TEXT);
    // источник без захвата — поле не появляется вовсе
    expect(P.normalizeExportMessages([{ role: 'assistant', content: 'ответ' }])[0])
      .toEqual({ role: 'assistant', text: 'ответ' });
  });

  test('перехватчик: hidden-пометки базы на месте, текст хода и формат не тронуты', () => {
    expect(INTERCEPT_SRC).toContain("var DS_PP_VISIBLE_MARKER = 'deepseek-pp-visible-user-prompt:start';");
    expect(INTERCEPT_SRC).toContain('if (turnReasoning) turnMsg.hiddenReasoning = turnReasoning;');
    expect(INTERCEPT_SRC).toContain("if (t.role === 'user' && hasInjectedUserPrompt(t.text)) turnMsg.hiddenInjection = true;");
    // текст хода по-прежнему собирает composeTurnText (O-7 v8): [REASONING]/[ANSWER] не тронуты
    expect(INTERCEPT_SRC).toContain("var REASONING_TAG = '[REASONING]';");
    expect(INTERCEPT_SRC).toContain("var ANSWER_TAG = '[ANSWER]';");
    expect(INTERCEPT_SRC).toContain("return REASONING_TAG + '\\n' + reasoning + '\\n\\n' + ANSWER_TAG + '\\n' + answer;");
    expect(INTERCEPT_SRC).toContain("messages.push(turnMsg);");
    expect(INTERCEPT_SRC).toContain('reasoningTexts: reasonings,');
  });

  test('прочие адаптеры платформ hidden-захват не получили (минимально необходимое изменение)', () => {
    ['chatgpt', 'gemini', 'claude', 'perplexity', 'google-search'].forEach(function (name) {
      const src = read('adapters/' + name + '-adapter.js');
      expect([name, src.indexOf('hiddenReasoning')]).toEqual([name, -1]);
    });
  });
});

/* =====================================================================================
 * R3: соседние регресс-наборы живы (O-11 / O-31 / O-27 / O-33 / O-15…O-20)
 * ===================================================================================== */
describe('O-7 R3: регресс-контур O-11/O-31/O-27/O-33/O-15…O-20 не тронут', () => {
  const SUITES = [
    'tests/gsa-autoexport-o11-name-collision.test.js',   // O-11
    'tests/gsa-o31-thread-segmentation.test.js',         // O-31
    'tests/gsa-o27-protective-form-guard.test.js',       // O-27
    'tests/gsa-o27-captcha-base-guard.test.js',          // O-27
    'tests/o33-autoexport-base-pending.test.js',         // O-33
    'tests/export-sanitize.test.js',                     // O-20
    'tests/adapters/deepseek-o15-pairing.test.js',       // O-15
    'tests/adapters/deepseek-o16-stream-export.test.js', // O-16
    'tests/adapters/deepseek-o17-spa-chat.test.js',      // O-17
    'tests/adapters/deepseek-o18-export-net-sync.test.js', // O-18
    'tests/i18n-locales.test.js',                        // M-4 (i18n)
    'tests/a11y-options.test.js',                        // M-1..M-3 (a11y)
    'tests/version-hygiene.test.js',                     // R-1
    'tests/changelog-format.test.js'                     // CHANGELOG
  ];

  test('все соседние наборы на месте (исполняются npm test)', () => {
    SUITES.forEach(function (rel) {
      expect([rel, fs.existsSync(path.join(ROOT, rel))]).toEqual([rel, true]);
    });
  });

  test('маркеры соседей в коде живы', () => {
    expect(PIPELINE_SRC).toContain('function sanitizeEmitMessages(messages)');
    expect(PIPELINE_SRC).toContain('function buildAutoExportFileName(spec)');
    expect(PIPELINE_SRC).toContain('function sanitizeInjectedUserText(text)');
    expect(PIPELINE_SRC).toContain('function shouldSkipGsaPageGuard(state)');
    expect(PIPELINE_SRC).toContain('function shouldSkipAutoExport(state)');
    expect(PIPELINE_SRC).toContain('function includeHiddenExportBlocks(messages)');
    expect(EXPORT_MGR_SRC).toContain("reason: 'base-pending',");
    expect(EXPORT_MGR_SRC).toContain('function aiCmAutoExportStartDownload(content, file, fmt)');
    // O-27: пост-гард единственной точки скачивания живёт в сборщиках экспорта
    expect(read('utils/export-text-builders.js')).toContain('function downloadBlockReason');
  });

  test('«не трогать»: маска имён экспорта, пороги, уведомления и прочие форматы не переписаны', () => {
    expect(EXPORT_MGR_SRC).toContain('function loadAutoExportSettings()');
    expect(EXPORT_MGR_SRC).toContain('function maybeAutoExport(percentage)');
    expect(EXPORT_MGR_SRC).toContain("doAutoExportDownload(cid, percentage, 'threshold');");
    expect(EXPORT_MGR_SRC).toContain('AI_CM_DS_STREAM_DEFER_MS = 800');
    expect(EXPORT_MGR_SRC).not.toContain('hiddenReasoning');
  });
});

/* =====================================================================================
 * R4: i18n + a11y нового тумблера
 * ===================================================================================== */
describe('O-7 R4: i18n и a11y тумблера «Включать reasoning и инъекции DeepSeek++ в экспорт»', () => {
  test('ключи метки и хинта есть в ОБЕИХ локалях, значения непусты и различаются', () => {
    [HIDDEN_LABEL_KEY, HIDDEN_HINT_KEY].forEach(function (key) {
      expect([key, Object.prototype.hasOwnProperty.call(ru, key)]).toEqual([key, true]);
      expect([key, Object.prototype.hasOwnProperty.call(en, key)]).toEqual([key, true]);
      expect([key, ru[key].message.length > 0]).toEqual([key, true]);
      expect([key, en[key].message.length > 0]).toEqual([key, true]);
      expect([key, en[key].message === ru[key].message]).toEqual([key, false]);
    });
    expect(ru[HIDDEN_LABEL_KEY].message).toBe(HIDDEN_LABEL_RU);
  });

  test('разметка: RU-метка заявлена ключом, контрол связан с подписью через label[for]', () => {
    expect(OPTIONS_HTML).toContain('id="' + SETTING_KEY + '"');
    expect(OPTIONS_HTML).toContain('for="' + SETTING_KEY + '"');
    expect(OPTIONS_HTML).toContain('data-i18n="' + HIDDEN_LABEL_KEY + '">' + HIDDEN_LABEL_RU + '</label>');
    expect(OPTIONS_HTML).toContain('data-i18n="' + HIDDEN_HINT_KEY + '"');
    // тумблер стоит в секции «Экспорт истории», а не в группах автоэкспорта/порогов
    const exportSection = sliceSource(OPTIONS_HTML, 'data-i18n="options_export_legend"', 'id="archive-section"');
    expect(exportSection).toContain('id="' + SETTING_KEY + '"');
    expect(sliceSource(OPTIONS_HTML, 'id="auto-export-section"', 'id="proactive-section"'))
      .not.toContain(SETTING_KEY);
    // a11y-инвариант файла: у нового поля есть доступное имя (label[for]) и нет висячей подписи
    const tag = /<input[^>]*id="aiCmIncludeHiddenInExport"[^>]*>/.exec(OPTIONS_HTML)[0];
    expect(tag).toContain('type="checkbox"');
  });

  test('options.js: читает и пишет отдельный ключ, дефолт OFF, прочие настройки не тронуты', () => {
    expect(OPTIONS_JS).toContain("chrome.storage.local.get(['aiCmIncludeHiddenInExport']");
    expect(OPTIONS_JS).toContain('chrome.storage.local.set({ aiCmIncludeHiddenInExport: includeHiddenCheckbox.checked });');
    expect(OPTIONS_JS).toContain("getElementById('aiCmIncludeHiddenInExport')");
    // запись одного ключа, а не полного объекта настроек автоэкспорта (пин M-13 цел)
    expect(OPTIONS_JS).not.toContain('chrome.storage.local.set({ aiCmAutoExport:');
    expect(OPTIONS_JS).not.toMatch(/aria-|focus-visible/);
  });

  test('jsdom: реальный options.js — пустой storage → тумблер ВЫКЛ; change пишет true', () => {
    const DOM_IDS = [
      'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent', 'stat-source',
      'model-select', 'custom-limit', 'show-widget', 'toggle-api-key',
      'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
      'export-hint', 'stale-warning', 'export-diag', 'reset-limit', 'privacy-link', 'help-link',
      'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
      'aiCmProactive', 'aiCmProactiveNotify',
      'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh',
      'api-key-status', 'api-key-remove'
    ];
    document.body.innerHTML = '';
    DOM_IDS.forEach(function (id) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    });
    const keyInput = document.createElement('input');
    keyInput.id = 'api-key';
    keyInput.type = 'password';
    document.body.appendChild(keyInput);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = SETTING_KEY;
    document.body.appendChild(checkbox);
    const versionEl = document.createElement('span');
    versionEl.className = 'version';
    document.body.appendChild(versionEl);

    const localSets = [];
    global.chrome = {
      runtime: {
        getManifest: function () { return { version: '2.0.8' }; },
        getURL: function () { return 'print.html'; },
        lastError: null,
        sendMessage: function () { }
      },
      storage: {
        sync: { get: function (keys, cb) { cb({}); }, set: function () { } },
        local: {
          get: function (keys, cb) { if (typeof cb === 'function') cb({}); },
          getKeys: function (cb) { cb([]); },
          set: function (obj, cb) { localSets.push(Object.assign({}, obj)); if (cb) cb(); },
          remove: function (keys, cb) { if (cb) cb(); }
        },
        session: {
          get: function () { return Promise.resolve({}); },
          set: function () { return Promise.resolve(); },
          remove: function () { return Promise.resolve(); }
        },
        onChanged: { addListener: function () { } }
      },
      tabs: {
        query: function (q, cb) { cb([]); },
        create: function () { },
        sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
      }
    };
    jest.resetModules();
    require('../options/options.js');
    expect(document.getElementById(SETTING_KEY).checked).toBe(false);
    document.getElementById(SETTING_KEY).checked = true;
    document.getElementById(SETTING_KEY).dispatchEvent(new window.Event('change', { bubbles: true }));
    const writes = localSets.filter(function (o) { return SETTING_KEY in o; });
    expect(writes).toEqual([{ aiCmIncludeHiddenInExport: true }]);
    delete global.chrome;
  });
});

/* =====================================================================================
 * R5: version-hygiene / changelog-format — версия и CHANGELOG не тронуты
 * ===================================================================================== */
describe('O-7 R5: версия не менялась, CHANGELOG — отдельным релизным коммитом', () => {
  test('версия 2.0.8 во всех точках вывода (манифест/пакет/лок)', () => {
    expect(manifest.version).toBe('2.0.8');
    expect(pkg.version).toBe('2.0.8');
    expect(lock.version).toBe('2.0.8');
    expect(lock.packages[''].version).toBe('2.0.8');
  });

  test('верхняя запись CHANGELOG — прежняя (2.0.8), фикс O-7 в неё не дописан', () => {
    const top = changelog.split(/\r?\n/).find(function (l) { return l.indexOf('## [') === 0; });
    expect(top).toBe('## [2.0.8] - 2026-09-17');
    expect(changelog).not.toContain('aiCmIncludeHiddenInExport');
    expect(changelog).not.toContain('Включать reasoning и инъекции DeepSeek++ в экспорт');
  });

  test('тумблер не добавлен в релизные точки версии (options футер берёт версию из манифеста)', () => {
    expect(OPTIONS_JS).toContain("versionEl.textContent = 'v' + manifest.version");
    expect(OPTIONS_HTML).toContain('<span class="version"></span>');
  });
});
