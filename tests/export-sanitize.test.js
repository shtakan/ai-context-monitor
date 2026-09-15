/**
 * O-20: санация известных маркеров сторонних расширений в тексте экспорта.
 *
 * Соседнее расширение DeepSeek++ (v1.14.0, content-scripts/content.js: prompt.systemThinking
 * + prompt.toolSchema + обёртка видимого промпта) дописывает в user-промпт memory-преамбулу
 * и тул-схему, а ВИДИМЫЙ пользователю текст оборачивает парой HTML-комментариев:
 *   <!-- deepseek-pp-visible-user-prompt:start -->
 *   <видимый текст>
 *   <!-- deepseek-pp-visible-user-prompt:end -->
 * Серверная история DeepSeek отдаёт эти инъекции в локальный снимок, и они уезжали в файл
 * экспорта. Санация — ТОЛЬКО на выходе экспорта (общая точка эмита всех четырёх форматов:
 * md/json/txt + print-pdf), база/метрики/токены не пересчитываются.
 *
 * Ассерты задачи: извлечение = видимый текст; без маркеров = байтово идентично; tokens не
 * изменились; assistant не тронут; санация видна во всех 4 форматах; лог пропуска — одна
 * строка при sessionStorage aiCmDebug=1 (без спама).
 */
const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const buildReferenceText = require('../utils/buildReferenceText.js');

const ROOT = path.join(__dirname, '..');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const EXPORT_MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const BASE_HANDLER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'base-handler.js'), 'utf8');
const PRINT_JS = fs.readFileSync(path.join(ROOT, 'print', 'print.js'), 'utf8');

const START = '<!-- deepseek-pp-visible-user-prompt:start -->';
const END = '<!-- deepseek-pp-visible-user-prompt:end -->';
const VALUE_PREFIX = '<!-- deepseek-pp-visible-user-prompt:value=';

// Видимый текст — ровно то, что пользователь набрал сам; он и должен остаться в экспорте.
const VISIBLE_USER_TEXT = 'O-20: проверь, что в экспорте виден только мой текст — без преамбулы DeepSeek++.';

// Memory-преамбула DeepSeek++ (реальный текст инъекции; 4 записи, как в живом экспорте).
const MEMORY_PREAMBLE = [
  'You have long-term memory. Existing memories:',
  '1. Пользователь работает с расширением DeepSeek++ (браузерное, сайдбар-панель).',
  '2. Интересуется подключением папки с проектом к ИИ-чату для работы с кодом.',
  '3. Цель — работа с кодом проекта через DSH (DeepSeek Harness).'
].join('\n');

// Тул-схема DeepSeek++ (реальные строки инъекции; порядок как в oo[8] = Wn).
const TOOL_SCHEMA = [
  'Tool call format reminder:',
  'Available tool tag names:',
  'These listed tools are executable by the extension.',
  'To call a tool, use ONLY the direct XML tag <tool_name>…</tool_name>.',
  'For MCP tools, prefer the short tag name.',
  'For local file paths, use forward slashes.'
].join('\n');

// ФИКСТУРА = реальный user-текст релизного экспорта с инъекциями DeepSeek++ (встроен строкой):
// преамбула + тул-схема ДО маркеров, видимый текст МЕЖДУ маркерами, хвост инъекции ПОСЛЕ.
const INJECTED_USER_TEXT =
  MEMORY_PREAMBLE + '\n\n' + TOOL_SCHEMA + '\n\n' +
  START + '\n' + VISIBLE_USER_TEXT + '\n' + END +
  '\n\nContinue answering based on the tool results above.';

const ASSISTANT_TEXT = 'Готово: в экспорте остался только видимый текст пользователя.';

// Токены/лимит/процент — серверная правда контекста; санация их НЕ пересчитывает.
const TOKENS = 4210;
const LIMIT = 131072;
const PERCENT = 3.2;

function historyFrom(messages) {
  return {
    host: 'chat.deepseek.com',
    convId: 'e2685d10',
    site: 'deepseek',
    model: 'DeepSeek-V3',
    tokens: TOKENS,
    limit: LIMIT,
    percent: PERCENT,
    messages: messages
  };
}

function sliceSource(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error('срез исходника не найден: ' + startMarker);
  return src.slice(start, end);
}

function block(src, startMarker, endMarker) {
  return sliceSource(src, startMarker, endMarker);
}

// Песочница с РЕАЛЬНОЙ общей точкой эмита core/export-manager.js
// (sanitizeGeminiText → O-20-хелперы → aiCmCollectExportSource). Один makeEmitter = одна
// «страница»: антиспам-карта причин живёт внутри песочницы и между вызовами сохраняется.
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
  const src = sliceSource(EXPORT_MGR_SRC, 'function sanitizeGeminiText(s)', '// T1-fix#3') +
    '\nctx.__emit = aiCmCollectExportSource;';
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  return {
    ctx: ctx,
    logs: logs,
    run: function (texts, detailMessages) {
      ctx.lastBaseTexts = texts;
      ctx.lastDetailMessages = detailMessages;
      return ctx.__emit();
    }
  };
}

const DETAIL_MESSAGES = [
  { role: 'user', text: INJECTED_USER_TEXT, id: 'u1' },
  { role: 'assistant', text: ASSISTANT_TEXT, id: 'a1' }
];

// Сообщения, какими их отдаёт общая точка эмита (buildHistoryMessages → сюда).
function emittedMessages(opts) {
  const e = makeEmitter(opts);
  return { emitter: e, messages: e.run(DETAIL_MESSAGES.map((m) => m.text), DETAIL_MESSAGES) };
}

beforeEach(() => {
  window.buildReferenceText = buildReferenceText;
});

// =====================================================================================
// (1) Чистая функция санации user-текста
// =====================================================================================
describe('O-20 (1): sanitizeInjectedUserText — чистая санация user-текста', () => {
  test('фикстура: ровно одна пара маркеров → trim видимого текста (преамбула и тул-схема вырезаны)', () => {
    expect(INJECTED_USER_TEXT).toContain(MEMORY_PREAMBLE);
    expect(INJECTED_USER_TEXT).toContain(TOOL_SCHEMA);
    expect(P.sanitizeInjectedUserText(INJECTED_USER_TEXT)).toBe(VISIBLE_USER_TEXT);
    expect(P.injectedUserTextSkipReason(INJECTED_USER_TEXT)).toBe(null);
  });

  test('краевые пробелы/переводы строк внутри маркеров снимаются (trim, а не slice)', () => {
    const s = START + '\n\n   ' + VISIBLE_USER_TEXT + '  \n\n' + END;
    expect(P.sanitizeInjectedUserText(s)).toBe(VISIBLE_USER_TEXT);
  });

  test('текст без маркеров → БАЙТОВО идентично (NBSP, краевые пробелы, разметка)', () => {
    const plain = '  обычный вопрос\u00a0с NBSP, **markdown** и хвостом  ';
    expect(P.sanitizeInjectedUserText(plain)).toBe(plain);
    expect(P.injectedUserTextSkipReason(plain)).toBe('no-markers');
  });

  test('нет РОВНО одной пары → байтово идентично + причина пропуска', () => {
    const cases = [
      { name: 'две пары', text: START + 'a' + END + '\n' + START + 'b' + END, reason: 'multiple-pairs' },
      { name: 'только start', text: 'до\n' + START + '\n' + VISIBLE_USER_TEXT, reason: 'unpaired-markers' },
      { name: 'только end', text: VISIBLE_USER_TEXT + '\n' + END, reason: 'unpaired-markers' },
      { name: 'пара перевёрнута', text: END + '\n' + VISIBLE_USER_TEXT + '\n' + START, reason: 'unpaired-markers' },
      { name: 'два start / один end', text: START + 'a' + START + 'b' + END, reason: 'multiple-pairs' },
      {
        name: 'только value-форма',
        text: VALUE_PREFIX + encodeURIComponent(JSON.stringify(VISIBLE_USER_TEXT)) + ' -->',
        reason: 'value-only'
      },
      { name: 'пустая строка', text: '', reason: 'no-markers' }
    ];
    cases.forEach((c) => {
      expect(P.injectedUserTextSkipReason(c.text)).toBe(c.reason);
      expect(P.sanitizeInjectedUserText(c.text)).toBe(c.text);
    });
  });

  test('идемпотентность: повторная санация не меняет результат', () => {
    const once = P.sanitizeInjectedUserText(INJECTED_USER_TEXT);
    expect(P.sanitizeInjectedUserText(once)).toBe(once);
  });

  test('чистота: в функциях санации нет логирования и обращений к DOM', () => {
    const pure = block(PIPELINE_SRC, 'function injectedUserTextSkipReason(text)', 'function sanitizeEmitMessages(messages)') +
      block(PIPELINE_SRC, 'function sanitizeEmitMessages(messages)', 'function unionTurnsById(');
    expect(pure).not.toContain('console.');
    expect(pure).not.toContain('document.');
  });
});

// =====================================================================================
// (2) Массив сообщений: меняется ТОЛЬКО role=user
// =====================================================================================
describe('O-20 (2): sanitizeEmitMessages — только role=user', () => {
  test('user санирован; assistant и user без маркеров — те же объекты (байтово)', () => {
    const plainUser = { role: 'user', text: 'обычный вопрос', id: 'u2' };
    const assistantInjected = { role: 'assistant', text: INJECTED_USER_TEXT, id: 'a2' };
    const src = [
      { role: 'user', text: INJECTED_USER_TEXT, id: 'u1' },
      assistantInjected,
      plainUser
    ];
    const res = P.sanitizeEmitMessages(src);
    expect(res.sanitized).toBe(1);
    expect(res.messages[0].text).toBe(VISIBLE_USER_TEXT);
    expect(res.messages[0].id).toBe('u1');            // id санированного сообщения сохранён
    expect(res.messages[1]).toBe(assistantInjected);  // assistant не тронут вовсе
    expect(res.messages[1].text).toBe(INJECTED_USER_TEXT);
    expect(res.messages[2]).toBe(plainUser);          // без маркеров — тот же объект
    expect(res.skipped).toEqual(['no-markers']);      // причина видна только по user-сообщению
  });

  test('не-массив/мусор не роняет санацию (возврат как есть)', () => {
    expect(P.sanitizeEmitMessages(null).messages).toEqual([]);
    expect(P.sanitizeEmitMessages(undefined).sanitized).toBe(0);
    const arr = [null, 'x', { role: 'user', text: 'без маркеров' }];
    const res = P.sanitizeEmitMessages(arr);
    expect(res.messages.length).toBe(3);
    expect(res.sanitized).toBe(0);
  });
});

// =====================================================================================
// (3) Проводка: общая точка эмита core/export-manager.js
// =====================================================================================
describe('O-20 (3): aiCmCollectExportSource — единая точка эмита', () => {
  test('сетевой снимок: user санирован, assistant и база байтово (токены не пересчитываются)', () => {
    const r = emittedMessages();
    expect(r.messages[0].text).toBe(VISIBLE_USER_TEXT);
    expect(r.messages[1].text).toBe(ASSISTANT_TEXT);
    // база/метрики — ТОТ ЖЕ массив, что пришёл от сервера (санация её не касается)
    expect(r.emitter.ctx.lastBaseTexts[0]).toBe(INJECTED_USER_TEXT);
    expect(r.emitter.ctx.lastBaseTexts[1]).toBe(ASSISTANT_TEXT);
  });

  test('DOM-адаптер (baseSeen=false) — та же санация на выходе', () => {
    const e = makeEmitter({
      baseSeen: false,
      adapter: {
        siteName: 'deepseek',
        extractMessages: function () {
          return [
            { role: 'user', text: INJECTED_USER_TEXT },
            { role: 'assistant', text: ASSISTANT_TEXT }
          ];
        }
      }
    });
    const msgs = e.run([], null);
    expect(msgs[0].text).toBe(VISIBLE_USER_TEXT);
    expect(msgs[1].text).toBe(ASSISTANT_TEXT);
  });

  test('source-пин: санация стоит на выходе aiCmCollectExportSource (обе ветки + ранний возврат)', () => {
    const fnSrc = block(EXPORT_MGR_SRC, 'function aiCmCollectExportSource()', 'function aiCmExportBaseSource(');
    expect(fnSrc).toContain('return aiCmSanitizeEmitUserTexts(out);');
    expect(fnSrc).toContain('if (norm.length > 0 && hasRoles) return aiCmSanitizeEmitUserTexts(norm);');
    expect(fnSrc.match(/aiCmSanitizeEmitUserTexts\(/g).length).toBe(3);
    // база buildHistoryMessages (пин E-2 в core/base-handler.js) не переписана — дедуп на месте
    expect(BASE_HANDLER_SRC).toContain('return aiCmDedupeExportSource(aiCmCollectExportSource()).messages;');
  });
});

// =====================================================================================
// (4) Санация видна во всех 4 форматах (md/json/txt/pdf) из ОДНОГО эмита
// =====================================================================================
describe('O-20 (4): четыре формата из одного эмита', () => {
  test('md: видимый текст на месте, инъекций нет, токены прежние', () => {
    const hist = historyFrom(emittedMessages().messages);
    const md = Builders.buildMdFromHistory(hist, 'DeepSeek');
    expect(md).toContain(VISIBLE_USER_TEXT);
    expect(md).not.toContain('deepseek-pp-visible-user-prompt');
    expect(md).not.toContain('Tool call format reminder:');
    expect(md).not.toContain('Existing memories:');
    expect(md).toContain('Токены: ' + TOKENS + ' / ' + LIMIT + ' (' + PERCENT + '%)');
  });

  test('json: messages санированы, tokens/limit/percent НЕ пересчитаны', () => {
    const hist = historyFrom(emittedMessages().messages);
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'DeepSeek'));
    expect(json.tokens).toBe(TOKENS);
    expect(json.limit).toBe(LIMIT);
    expect(json.percent).toBe(PERCENT);
    expect(json.messages[0].text).toBe(VISIBLE_USER_TEXT);
    expect(json.messages[1].text).toBe(ASSISTANT_TEXT);
    expect(JSON.stringify(json)).not.toContain('deepseek-pp');
    expect(JSON.stringify(json)).not.toContain('Tool call format reminder:');
  });

  test('txt: инъекций нет, видимый текст на месте', () => {
    const hist = historyFrom(emittedMessages().messages);
    const txt = Builders.buildTxtFromHistory(hist);
    expect(txt).toContain(VISIBLE_USER_TEXT);
    expect(txt).toContain(ASSISTANT_TEXT);
    expect(txt).not.toContain('deepseek-pp-visible-user-prompt');
    expect(txt).not.toContain('Existing memories:');
  });

  test('pdf (print/print.js): печатная форма без инъекций, видимый текст на месте', async () => {
    const hist = historyFrom(emittedMessages().messages);
    const html = await renderPdfForm(hist);
    expect(html).toContain(VISIBLE_USER_TEXT);
    expect(html).not.toContain('deepseek-pp');
    expect(html).not.toContain('Tool call format reminder:');
    expect(html).not.toContain('Existing memories:');
  });
});

// Печатная форма: РЕАЛЬНЫЙ print/print.js в jsdom с моками chrome.tabs/storage (тот же
// приём, что в tests/print/print-hygiene-e2.test.js). Снимок истории — ровно выход общей
// точки эмита (так его отдаёт content.js на aiCmExportCurrent).
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
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="banner" id="print-banner"></div><div id="print-content"></div>' +
      '<div class="empty-state" id="empty-state" style="display:none;"></div>';
    document.body.innerHTML = '';
    document.body.appendChild(wrap);
    document.title = '';
    installRendererStub();
    const chromeMock = {
      i18n: { getMessage: function () { return ''; } },
      tabs: {
        get: function (id, cb) { cb({ id: id, url: 'https://chat.deepseek.com/a/chat/s/e2685d10' }); },
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
// (5) Лог пропуска: sessionStorage aiCmDebug=1, одна строка на причину, без спама
// =====================================================================================
describe('O-20 (5): лог пропуска санации', () => {
  const PLAIN_A = [{ role: 'user', text: 'обычный вопрос 1' }, { role: 'assistant', text: 'ответ 1' }];
  const PLAIN_B = [{ role: 'user', text: 'обычный вопрос 2 — другой' }, { role: 'assistant', text: 'ответ 2' }];

  function emitPlain(e, pairs) {
    pairs.forEach((p) => e.run(p.map((m) => m.text), p));
  }

  test('aiCmDebug=1 → ровно одна строка reason=no-markers на серию снимков', () => {
    const e = makeEmitter({ debug: true });
    emitPlain(e, [PLAIN_A, PLAIN_B, PLAIN_A]);
    const lines = e.logs.filter((l) => l.indexOf('[AI CM][sanitize] skip reason=') === 0);
    expect(lines).toEqual(['[AI CM][sanitize] skip reason=no-markers']);
  });

  test('без aiCmDebug лог молчит (флаг не выставлен)', () => {
    const e = makeEmitter({ debug: false });
    emitPlain(e, [PLAIN_A, PLAIN_B]);
    expect(e.logs.filter((l) => l.indexOf('[AI CM][sanitize]') === 0).length).toBe(0);
  });

  test('value-форма (пары start/end нет) → reason=value-only, санация не применена', () => {
    const valueOnly = VALUE_PREFIX + encodeURIComponent(JSON.stringify(VISIBLE_USER_TEXT)) + ' -->';
    const e = makeEmitter({ debug: true });
    const pairs = [{ role: 'user', text: valueOnly }, { role: 'assistant', text: 'ответ' }];
    const msgs = e.run(pairs.map((m) => m.text), pairs);
    expect(msgs[0].text).toBe(valueOnly);   // байтово прежний текст
    expect(e.logs.filter((l) => l === '[AI CM][sanitize] skip reason=value-only').length).toBe(1);
  });

  test('сообщение с ровно одной парой → санация применена, строки пропуска нет', () => {
    const e = makeEmitter({ debug: true });
    const msgs = e.run(DETAIL_MESSAGES.map((m) => m.text), DETAIL_MESSAGES);
    expect(msgs[0].text).toBe(VISIBLE_USER_TEXT);
    expect(e.logs.filter((l) => l.indexOf('[AI CM][sanitize]') === 0).length).toBe(0);
  });
});
