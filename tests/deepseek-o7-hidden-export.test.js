/**
 * O-7 (Medium): тумблер «Включать reasoning и инъекции DeepSeek++ в экспорт».
 *
 * Продуктовое решение владельца (P1=a, P2=OFF):
 *   OFF (default) = в файл экспорта попадают ТОЛЬКО вопросы и ответы: секции
 *                   [REASONING]…[ANSWER]… сетевого пути DeepSeek урезаются до части [ANSWER]
 *                   (маркеры убираются), инъекции DeepSeek++ вырезаны (санация O-20 активна),
 *                   hidden-поля захвата (hiddenReasoning) сняты;
 *   ON            = всё как есть: секции [REASONING]/[ANSWER] остаются в тексте, инъекции
 *                   DeepSeek++ — как есть (O-20 обойдена), hiddenReasoning идёт ОТДЕЛЬНЫМ
 *                   блоком [REASONING]…[ANSWER]… (includeHiddenExportBlocks).
 * БАЗА и метрики (tokens/pct/limit/модель/бейдж) считаются по базовому тексту и от
 * положения тумблера НЕ зависят: секции остаются в тексте хода (core/deepseek-intercept.js,
 * v8), hidden живёт отдельным полем захвата; урезание — ТОЛЬКО на выходе экспорта
 * (utils/export-emit-pipeline.js:stripReasoningSections).
 *
 * Контур сьюта (правило R-D: пины на КАЖДЫЙ путь захвата + на единственную точку выхода):
 *   D1 — тумблер ON → md/txt/json/pdf несут reasoning-секции и инъекции; DOM-путь (панель
 *        размышлений, отброшенная на захвате) и сетевой путь (инъекции в user-тексте);
 *   D2 — тумблер OFF → только вопросы и ответы: секции урезаны до [ANSWER], инъекций нет,
 *        hidden-полей нет (независимый оракул + буквальный байтовый пин txt); S3/S4/S5 —
 *        служебный тул-мусор DeepSeek++ (user-ход из одних [TOOL_RESULTS], XML-вызовы тулов
 *        в тексте ассистента, пустые после чистки ходы) в файл не едет — фикстура-выдержка
 *        из живого OFF-артефакта deepseek_test/…-2026-09-17-21-29 с рукописным оракулом
 *        «минус мусор» (ON тот же вход отдаёт БАЙТОВО как есть);
 *   D3 — чистая функция stripReasoningSections: байтовые инварианты и идемпотентность;
 *   S3/S4/S5 — чистые функции тул-мусора (isToolResultsOnlyText / stripToolCallBlocks):
 *        полный список тегов вызовов, парность/нежадность/атрибуты, байтовые no-op для
 *        чужих текстов и тегов-РЕЗУЛЬТАТОВ, удаление пустых ходов, идемпотентность;
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
// O-7: подсказка описывает НОВУЮ семантику тумблера (OFF = вопросы и ответы, ON = всё как есть).
const HIDDEN_HINT_RU = 'Выключено: в файл попадают только вопросы и ответы, без размышлений и инъекций. ' +
  'Включено: размышления и инъекции попадают в экспорт.';

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

// =====================================================================================
// O-7 (OFF, S3/S4/S5): фикстура «минус мусор» — ВЫДЕРЖКА из живого OFF-артефакта
// deepseek_test/ai-context-monitor-deepseek-DeepSeek-R1-2026-09-17-21-29.txt
// (agent-сессия DeepSeek++ с browser-MCP). Байты фрагментов — КАК В АРТЕФАКТЕ, без правок
// и без переэкранирования: взят ровно один user-ход с результатами тулов (хвост-приглашение
// на месте) и ровно один ход ассистента с ЧЕТЫРЬМЯ XML-вызовами тулов (browser_type /
// browser_key / browser_wait_for / browser_evaluate_script) между прозой. Соседний к этому
// user-ходу ответ ассистента в артефакте — 19 КБ, поэтому выдержка составлена из двух
// фрагментов одного файла (каждый — байтовая копия).
// =====================================================================================
const ARTIFACT_TOOL_RESULTS_USER = [
  '[TOOL_RESULTS]',
  '<memory_update_result>',
  '{"ok":true,"name":"memory_update","provider":{"kind":"local","id":"memory","displayName":"DeepSeek++ Memory","transport":"in_process"},"descriptorId":"local:memory:memory_update","summary":"Updated","detail":"Qwen (chat.qwen.ai) API v2 — спека провайдера"}',
  '</memory_update_result>',
  '[/TOOL_RESULTS]',
  '',
  'Continue answering based on the tool results above.',
].join('\n');

const ARTIFACT_ASSISTANT_RAW = [
  '',
  '',
  'Поймал только служебный запрос — это НЕ чат. Разбор первого улова:',
  '',
  '',
  'GET /api/v2/notifications/latest?type=memory   →  200, JSON',
  'Headers: Version: 0.2.91, bx-v: 2.5.37, source: web, X-Request-Id: <uuid>',
  '',
  '',
  'Что из этого уже ценно для провайдера:',
  '',
  'API-префикс подтверждён: https://chat.qwen.ai/api/v2/... — это база, к которой будет обращаться твой адаптер.',
  'Версия клиента: Version: 0.2.91 — сервер может требовать этот заголовок, иначе 4xx. Обязательно прокидывать.',
  'source: web + bx-v: 2.5.37 — похоже на обязательную телеметрию Baidu-фронтенда (bx = Baidu X?). Скорее всего тоже нужно.',
  'X-Request-Id — генерит клиент (uuid v4). Сервер его эхоит в request_id. Твой адаптер должен генерить свой.',
  'Формат ответа: обёртка { success, request_id, data: {...} } — общая для всего API, не только чата.',
  '',
  'Но чтобы получить схему чата, нужен настоящий POST. Условие wait_for сработало от фонового GET (уведомления), а не от отправки сообщения. Значит сообщение ещё не отправлено.',
  '',
  'Отправь, пожалуйста, «привет» в поле Qwen (сейчас фокус уже стоит на textarea — я вижу textbox "Спросить Qwen" focused). Как только нажмёшь Enter, я сразу вытащу запрос чата.',
  '',
  'Можно и без тебя — попробую сам:',
  '',
  '<browser_type>',
  '{"uid": "e18", "text": "привет"}',
  '</browser_type>',
  '',
  '<browser_key>',
  '{"key": "Enter"}',
  '</browser_key>',
  '',
  'Теперь ловлю новый трафик. Даю странице 6 секунд на стрим и вычитываю лог — на этот раз отфильтрую всё, что не похоже на чат.',
  '',
  '<browser_wait_for>',
  '{"expression": "(window.qwenLog && window.qwenLog.some(e => e.method === \'POST\'))", "timeoutMs": 30000}',
  '</browser_wait_for>',
  '',
  '<browser_evaluate_script>',
  '{"script":"(() => {\\n  const log = (window.qwenLog || []).filter(e => e.method === \'POST\' || /completion|chat|conversation|message/i.test(e.url||\'\'));\\n  return {\\n    total: (window.qwenLog||[]).length,\\n    chat: log.map(e => ({\\n      kind: e.kind, method: e.method, url: e.url, status: e.status,\\n      respCt: e.respCt, stream: !!e.stream,\\n      reqHeaders: e.reqHeaders,\\n      reqBody: e.reqBody ? String(e.reqBody).slice(0, 5000) : null,\\n      respBody: e.respBody ? String(e.respBody).slice(0, 2000) : null,\\n      streamBody: e.streamBody ? String(e.streamBody).slice(0, 4000) : null,\\n      err: e.err\\n    }))\\n  };\\n})()"}',
  '</browser_evaluate_script>',
  '',
  '',
].join('\n');

// РУКОПИСНЫЙ оракул «минус мусор»: тот же ход ассистента, но user-ход с тул-результатами
// выброшен целиком (S3), четыре XML-вызова вырезаны вместе со своей пробельной отбивкой (S4),
// а проза — байтово как в артефакте (включая её собственные двойные пустые строки).
const ARTIFACT_ASSISTANT_ORACLE = [
  '',
  '',
  'Поймал только служебный запрос — это НЕ чат. Разбор первого улова:',
  '',
  '',
  'GET /api/v2/notifications/latest?type=memory   →  200, JSON',
  'Headers: Version: 0.2.91, bx-v: 2.5.37, source: web, X-Request-Id: <uuid>',
  '',
  '',
  'Что из этого уже ценно для провайдера:',
  '',
  'API-префикс подтверждён: https://chat.qwen.ai/api/v2/... — это база, к которой будет обращаться твой адаптер.',
  'Версия клиента: Version: 0.2.91 — сервер может требовать этот заголовок, иначе 4xx. Обязательно прокидывать.',
  'source: web + bx-v: 2.5.37 — похоже на обязательную телеметрию Baidu-фронтенда (bx = Baidu X?). Скорее всего тоже нужно.',
  'X-Request-Id — генерит клиент (uuid v4). Сервер его эхоит в request_id. Твой адаптер должен генерить свой.',
  'Формат ответа: обёртка { success, request_id, data: {...} } — общая для всего API, не только чата.',
  '',
  'Но чтобы получить схему чата, нужен настоящий POST. Условие wait_for сработало от фонового GET (уведомления), а не от отправки сообщения. Значит сообщение ещё не отправлено.',
  '',
  'Отправь, пожалуйста, «привет» в поле Qwen (сейчас фокус уже стоит на textarea — я вижу textbox "Спросить Qwen" focused). Как только нажмёшь Enter, я сразу вытащу запрос чата.',
  '',
  'Можно и без тебя — попробую сам:',
  '',
  'Теперь ловлю новый трафик. Даю странице 6 секунд на стрим и вычитываю лог — на этот раз отфильтрую всё, что не похоже на чат.',
].join('\n');

/** Сообщения выдержки: user-ход с тул-результатами + ход ассистента с XML-вызовами. */
function artifactMessages() {
  return [
    { role: 'user', text: ARTIFACT_TOOL_RESULTS_USER, id: 'u-tools' },
    { role: 'assistant', text: ARTIFACT_ASSISTANT_RAW, id: 'a-tools' }
  ];
}

// S4: полный список тегов вызовов DeepSeek++ (задача: 18 browser_* + 3 memory_* +
// web_search/web_fetch) и префиксные семейства shell_/python_/skill_ (любое имя семейства:
// shell_exec, python_status, skill_draft_create, …).
const TOOL_CALL_TAG_NAMES = [
  'browser_navigate', 'browser_go_back', 'browser_go_forward', 'browser_refresh',
  'browser_list_tabs', 'browser_select_tab', 'browser_close_tab', 'browser_snapshot',
  'browser_click', 'browser_hover', 'browser_fill', 'browser_fill_form', 'browser_key',
  'browser_type', 'browser_attach_file', 'browser_wait_for', 'browser_handle_dialog',
  'browser_evaluate_script', 'memory_save', 'memory_update', 'memory_delete',
  'web_search', 'web_fetch'
];
const TOOL_CALL_FAMILY_EXAMPLES = [
  'shell_exec', 'shell_status', 'shell_session_begin', 'shell_session_exec', 'shell_session_end',
  'python_exec', 'python_status', 'skill_draft_create', 'skill_anything_new'
];

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
// Оракул OFF-пути (НЕЗАВИСИМАЯ реализация правил «только вопросы и ответы» + санации O-20):
// урезание секций сделано регуляркой, снятие hidden-полей — построением {role,text}.
// Расхождение продакшна с этим оракулом и есть регресс-пин D2.
// =====================================================================================
function countMarker(text, marker) {
  let n = 0;
  let at = text.indexOf(marker);
  while (at !== -1) { n++; at = text.indexOf(marker, at + marker.length); }
  return n;
}

// Независимое урезание: каждая пара [REASONING]…[ANSWER] (+ форматный перевод строки) вон.
const ORACLE_SECTION_RE = /\[REASONING\][\s\S]*?\[ANSWER\](?:\r\n|\n)?/g;

function oracleStripReasoningSections(text) {
  const s = String(text == null ? '' : text);
  if (s.indexOf('[REASONING]') === -1 || s.indexOf('[ANSWER]') === -1) return s;
  const out = s.replace(ORACLE_SECTION_RE, '');
  return out === s ? s : out;
}

// S3 (независимо): строка, ЦЕЛИКОМ равная блоку тул-результатов (+ хвост-приглашение).
const ORACLE_TOOL_RESULTS_ONLY_RE =
  /^\[TOOL_RESULTS\][\s\S]*?\[\/TOOL_RESULTS\]\s*(?:Continue answering based on the tool results above\.)?\s*$/;

// S4 (независимо): тот же список тегов, но БЕЗ обратной ссылки — имя тега выписано в обеих
// частях пары (открывающая с необязательными атрибутами / закрывающая), хвост блока + пробелы.
const ORACLE_TOOL_CALL_RE = new RegExp(
  '<(?:' + TOOL_CALL_TAG_NAMES.join('|') + '|shell_\\w+|python_\\w+|skill_\\w+)(?:\\s[^>]*)?>' +
  '[\\s\\S]*?' +
  '<\\/(?:' + TOOL_CALL_TAG_NAMES.join('|') + '|shell_\\w+|python_\\w+|skill_\\w+)>\\s*', 'g');

function oracleStripToolCalls(text) {
  const s = String(text == null ? '' : text);
  const out = s.replace(ORACLE_TOOL_CALL_RE, '');
  return out === s ? s : out.replace(/\s+$/, '');
}

function oracleOffExport(messages) {
  const out = [];
  messages.forEach(function (m) {
    if (!m || typeof m !== 'object') { out.push(m); return; }
    const role = (m.role === 'user') ? 'user' : 'assistant';
    let text = oracleStripReasoningSections(String(m.text == null ? '' : m.text));
    // S3: user-ход целиком из результатов тулов — в экспорт не идёт
    if (role === 'user' && ORACLE_TOOL_RESULTS_ONLY_RE.test(text.trim())) return;
    // S4: XML-вызовы тулов — только из текста ассистента
    if (role !== 'user') text = oracleStripToolCalls(text);
    if (role === 'user') {
      const starts = countMarker(text, START);
      const ends = countMarker(text, END);
      if (starts === 1 && ends === 1 && text.indexOf(END) > text.indexOf(START)) {
        const from = text.indexOf(START) + START.length;
        const to = text.indexOf(END, from);
        text = text.slice(from, to).trim();
      }
    }
    if (text.trim() === '') return;                                     // S5: пустых в файле нет
    out.push({ role: role, text: text });
  });
  return out;
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
    expect(txt).toBe(INJECTED_USER_TEXT + '\n\n' + NETWORK_ASSISTANT_TEXT);   // текст КАК ЕСТЬ
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
 * D2: тумблер OFF — экспорт = только вопросы и ответы (секции урезаны, инъекций нет)
 * ===================================================================================== */
describe('O-7 D2: тумблер OFF — только вопросы и ответы', () => {
  test('OFF-выход === независимому оракулу «только вопросы и ответы» (6 платформ, JSON.stringify побайтово)', () => {
    PLATFORMS.forEach(function (fixture) {
      const input = networkMessages(fixture);
      const off = emitNetworkOff(fixture, input);
      const oracle = oracleOffExport(input);
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
        const histRef = historyFrom(fixture, oracleOffExport(input));
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

  test('OFF: буквальный байтовый пин txt (DeepSeek, сетевой путь) — вопрос и ответ', () => {
    const txt = Builders.buildTxtFromHistory(historyFrom(PLATFORMS[2], emitNetworkOff(PLATFORMS[2])));
    // видимый вопрос пользователя + ЧАСТЬ [ANSWER] хода: секций reasoning и инъекций нет
    expect(txt).toBe(VISIBLE_USER_TEXT + '\n\n' + ANSWER_TEXT);
    ['[REASONING]', '[ANSWER]', REASONING_TEXT, 'deepseek-pp', 'Existing memories:',
      'Tool call format reminder:'].forEach(function (needle) {
      expect([needle, txt.indexOf(needle)]).toEqual([needle, -1]);
    });
  });

  test('OFF: секции урезаны ТОЛЬКО в экспорте; вход и БАЗА байтово прежние', () => {
    const input = networkMessages(PLATFORMS[2]);
    const snapshot = input.map(function (m) { return m.text; });
    const e = makeEmitter();
    e.offline();
    const msgs = e.run(input);
    expect(msgs[1].text).toBe(ANSWER_TEXT);                        // выход — только [ANSWER]-часть
    expect(msgs[1]).not.toBe(input[1]);                            // копия, а не мутация входа
    expect(input.map(function (m) { return m.text; })).toEqual(snapshot);
    expect(e.ctx.lastBaseTexts[1]).toBe(NETWORK_ASSISTANT_TEXT);   // БАЗА несёт секции (v8)
  });

  test('OFF: источник-пин — единая точка выхода держит OFF-путь (урезание + O-20 + hidden)', () => {
    const fn = sliceSource(EXPORT_MGR_SRC, 'function aiCmSanitizeEmitUserTexts(messages)', '// v81: единая точка источников');
    expect(fn).toContain('var res = P.sanitizeEmitMessages(messages);');
    expect(fn).toContain('aiCmLogSanitizeSkip(res && res.skipped);');
    expect(fn).toContain('return (res && Array.isArray(res.messages)) ? res.messages : messages;');
    // тумблер выбирает ВЕТКУ, а не переписывает санацию
    expect(fn).toContain('if (aiCmIncludeHiddenInExport === true) {');
    // OFF-путь = пайплайн: урезание секций → O-20 → снятие hidden (все три — там же)
    expect(PIPELINE_SRC).toContain('function stripReasoningSections(text)');
    expect(PIPELINE_SRC).toContain('var bare = stripReasoningSections(raw);');
    // единая точка выхода экспорта держит РОВНО 3 обращения к ней (пин O-20 жив)
    const collect = sliceSource(EXPORT_MGR_SRC, 'function aiCmCollectExportSource()', 'function aiCmExportBaseSource(');
    expect(collect.match(/aiCmSanitizeEmitUserTexts\(/g).length).toBe(3);
    expect(BASE_HANDLER_SRC).toContain('return aiCmDedupeExportSource(aiCmCollectExportSource()).messages;');
  });

  test('OFF: сообщения без секций и hidden-полей возвращаются ТЕМИ ЖЕ объектами (идентичность)', () => {
    const src = [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: 'ответ' }];
    const res = P.sanitizeEmitMessages(src);
    expect(res.messages[0]).toBe(src[0]);
    expect(res.messages[1]).toBe(src[1]);
  });

  test('OFF: прочие 5 платформ байтово прежние и на OFF, и на ON (R-D)', () => {
    PLATFORMS.filter(function (f) { return f.site !== 'deepseek'; }).forEach(function (fixture) {
      const input = networkMessages(fixture);
      [emitNetworkOff(fixture, input), emitNetworkOn(fixture, input)].forEach(function (out) {
        expect([fixture.site, out[0].text]).toEqual([fixture.site, fixture.user]);
        expect([fixture.site, out[1].text]).toEqual([fixture.site, fixture.assistant]);
      });
    });
  });

  test('умолчание тумблера — ВЫКЛ (отсутствие ключа = вопросы и ответы)', () => {
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
 * D3: чистая функция stripReasoningSections — урезание секций [REASONING]…[ANSWER]…
 * ===================================================================================== */
describe('O-7 D3: stripReasoningSections — чистое урезание секций reasoning', () => {
  test('одна пара → только часть после [ANSWER] (маркеры и форматный перевод строки убраны)', () => {
    expect(P.stripReasoningSections(NETWORK_ASSISTANT_TEXT)).toBe(ANSWER_TEXT);
    expect(P.stripReasoningSections('[REASONING]\n' + REASONING_TEXT + '\n\n[ANSWER]\n' + ANSWER_TEXT))
      .toBe(ANSWER_TEXT);
    expect(P.stripReasoningSections('[REASONING]\r\nр\r\n\r\n[ANSWER]\r\nо')).toBe('о');
  });

  test('идемпотентность: повторный вызов на своём же выходе ничего не меняет', () => {
    const once = P.stripReasoningSections(NETWORK_ASSISTANT_TEXT);
    expect(once).toBe(ANSWER_TEXT);
    expect(P.stripReasoningSections(once)).toBe(once);
    const two = P.stripReasoningSections(
      'x\n[REASONING]\nр1\n\n[ANSWER]\nо1\n[REASONING]\nр2\n\n[ANSWER]\nо2');
    expect(P.stripReasoningSections(two)).toBe(two);
  });

  test('тексты без пары маркеров байтово неизменны (6 платформ, разметка, NBSP, пустая строка)', () => {
    const texts = [
      'Вопрос ChatGPT', 'Ответ Gemini с **markdown** и `кодом`',
      '  NBSP\u00a0и хвост  ', '# Заголовок\n\n- список\n- ещё', '', '…', 'C# и Java'
    ];
    texts.forEach(function (t) { expect([t, P.stripReasoningSections(t)]).toEqual([t, t]); });
    PLATFORMS.forEach(function (fixture) {
      expect([fixture.site, P.stripReasoningSections(fixture.user)]).toEqual([fixture.site, fixture.user]);
      if (fixture.site !== 'deepseek') {
        expect([fixture.site, P.stripReasoningSections(fixture.assistant)])
          .toEqual([fixture.site, fixture.assistant]);
      }
    });
  });

  test('[ANSWER] без предшествующего [REASONING] текст не меняет', () => {
    ['[ANSWER]\nответ',
      'вопрос [ANSWER]\nответ [REASONING]\nрассуждение',
      'ответ [ANSWER] и всё'].forEach(function (t) {
      expect([t, P.stripReasoningSections(t)]).toEqual([t, t]);
    });
  });

  test('несколько пар в одном тексте — обработаны ВСЕ (все ответы остаются)', () => {
    const text = '[REASONING]\nр1\n\n[ANSWER]\nо1\n\n[REASONING]\nр2\n\n[ANSWER]\nо2';
    expect(P.stripReasoningSections(text)).toBe('о1\n\nо2');
    // текст вокруг пары сохраняется байтово
    expect(P.stripReasoningSections('префикс [REASONING]\nр\n\n[ANSWER]\nо')).toBe('префикс о');
  });

  test('нестрока/мусор не роняет функцию', () => {
    expect(P.stripReasoningSections(null)).toBe('');
    expect(P.stripReasoningSections(undefined)).toBe('');
    expect(P.stripReasoningSections(42)).toBe('42');
  });
});

/* =====================================================================================
 * S3/S4/S5 (OFF): служебный тул-мусор DeepSeek++ в файл экспорта не едет
 * ===================================================================================== */
describe('O-7 S3/S4/S5: OFF-путь убирает [TOOL_RESULTS] и XML-вызовы тулов', () => {
  const ds = PLATFORMS[2];

  test('D-пин OFF: выдержка артефакта …-21-29 — user-ход с тул-результатами удалён, вызовы ассистента вырезаны', () => {
    const off = emitNetworkOff(ds, artifactMessages());
    // S3: машинный user-ход (результаты тулов + хвост) в экспорте отсутствует ЦЕЛИКОМ
    expect(off.length).toBe(1);
    expect(off[0].role).toBe('assistant');
    // S4: рукописный оракул «минус мусор» — проза байтово, вызовов нет
    expect(off[0].text).toBe(ARTIFACT_ASSISTANT_ORACLE);
    expect(off[0].text).toContain('Поймал только служебный запрос — это НЕ чат.');
    expect(off[0].text).toContain('Теперь ловлю новый трафик.');
    // D-пин: в OFF-экспорте нет НИ тул-результатов, НИ вызовов, НИ хвоста-приглашения,
    // НИ reasoning-секций, НИ инъекций DeepSeek++
    const body = JSON.stringify(off);
    ['[TOOL_RESULTS]', '[/TOOL_RESULTS]', '<browser_', '<memory_', '</browser_', '</memory_',
      'Continue answering based on the tool results above.', '[REASONING]', '[ANSWER]',
      'deepseek-pp', 'Existing memories:', 'Tool call format reminder:'
    ].forEach(function (needle) { expect([needle, body.indexOf(needle)]).toEqual([needle, -1]); });
    // выдержка == независимому оракулу OFF-пути (регулярочная реализация S3/S4/S5)
    expect(JSON.stringify(off)).toBe(JSON.stringify(oracleOffExport(artifactMessages())));
  });

  test('D-пин OFF: тул-мусора нет ни в одном из четырёх форматов (md/txt/json/pdf)', async () => {
    const hist = historyFrom(ds, emitNetworkOff(ds, artifactMessages()));
    const md = Builders.buildMdFromHistory(hist, 'DeepSeek');
    const txt = Builders.buildTxtFromHistory(hist);
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'DeepSeek'));
    const pdf = await renderPdfForm(hist);
    expect(json.messages.length).toBe(1);                       // user-ход тул-результатов выброшен
    expect(json.messages[0].text).toBe(ARTIFACT_ASSISTANT_ORACLE);
    [md, txt, JSON.stringify(json), pdf].forEach(function (b) {
      expect(b).not.toContain('[TOOL_RESULTS]');
      expect(b).not.toContain('Continue answering based on the tool results above.');
      expect(b).not.toContain('browser_type');
      expect(b).not.toContain('browser_evaluate_script');
      expect(b).not.toContain('memory_update_result');
      expect(b).toContain('Поймал только служебный запрос');
    });
  });

  test('D-пин ON: тот же вход в сыром режиме — и тул-результаты, и XML-вызовы на месте (ON не тронут)', () => {
    const on = emitNetworkOn(ds, artifactMessages());
    expect(on.length).toBe(2);
    expect(on[0].text).toBe(ARTIFACT_TOOL_RESULTS_USER);         // user-ход как есть
    expect(on[1].text).toBe(ARTIFACT_ASSISTANT_RAW);             // вызовы как есть
    const txt = Builders.buildTxtFromHistory(historyFrom(ds, on));
    expect(txt).toContain('[TOOL_RESULTS]');
    expect(txt).toContain('<memory_update_result>');
    expect(txt).toContain('Continue answering based on the tool results above.');
    expect(txt).toContain('<browser_type>');
    expect(txt).toContain('<browser_evaluate_script>');
    expect(txt).toBe(ARTIFACT_TOOL_RESULTS_USER + '\n\n' + ARTIFACT_ASSISTANT_RAW);
  });

  test('S3: user-ход из одних тул-результатов (+ необязательный хвост) распознаётся, смешанный — нет', () => {
    expect(P.isToolResultsOnlyText(ARTIFACT_TOOL_RESULTS_USER)).toBe(true);
    expect(P.isToolResultsOnlyText('[TOOL_RESULTS]\n<browser_click_result>{}</browser_click_result>\n[/TOOL_RESULTS]')).toBe(true);
    expect(P.isToolResultsOnlyText('  \n[TOOL_RESULTS]\nx\n[/TOOL_RESULTS]  \n Continue answering based on the tool results above. \n')).toBe(true);
    // НЕ целиком: текст пользователя рядом, незакрытый блок, склейка двух блоков, чужой хвост
    expect(P.isToolResultsOnlyText('мой вопрос\n[TOOL_RESULTS]\nx\n[/TOOL_RESULTS]')).toBe(false);
    expect(P.isToolResultsOnlyText('[TOOL_RESULTS]\nx')).toBe(false);
    expect(P.isToolResultsOnlyText('[TOOL_RESULTS]\nx\n[/TOOL_RESULTS]\n\n[TOOL_RESULTS]\ny\n[/TOOL_RESULTS]')).toBe(false);
    expect(P.isToolResultsOnlyText('[TOOL_RESULTS]\nx\n[/TOOL_RESULTS]\n\nПродолжай.')).toBe(false);
    expect(P.isToolResultsOnlyText('обычный вопрос')).toBe(false);
    expect(P.isToolResultsOnlyText('')).toBe(false);
  });

  test('S3: такой user-ход из массива удаляется, счётчик dropped растёт, пропуск O-20 не пишется', () => {
    const res = P.sanitizeEmitMessages([
      { role: 'user', text: ARTIFACT_TOOL_RESULTS_USER, id: 'u1' },
      { role: 'assistant', text: 'Ответ по существу.', id: 'a1' }
    ]);
    expect(res.messages.length).toBe(1);
    expect(res.messages[0].text).toBe('Ответ по существу.');
    expect(res.dropped).toBe(1);
    expect(res.skipped).toEqual([]);                 // удаление — не «пропуск санации»
    expect(res.sanitized).toBe(0);
  });

  test('S4: вырезаются ВСЕ теги списка (пары, нежадно, тело с чужими тегами внутри)', () => {
    TOOL_CALL_TAG_NAMES.forEach(function (tag) {
      const src = 'до\n\n<' + tag + ' attr="1">\n{"x": "<browser_click>", "y": 1}\n</' + tag + '>\n\nпосле';
      expect([tag, P.stripToolCallBlocks(src)]).toEqual([tag, 'до\n\nпосле']);
    });
    // префиксные семейства (задача: shell_\w+, python_\w+, skill_\w+) — любые имена семейства
    TOOL_CALL_FAMILY_EXAMPLES.forEach(function (tag) {
      const src = 'до\n\n<' + tag + '>\n{}\n</' + tag + '>\n\nпосле';
      expect([tag, P.stripToolCallBlocks(src)]).toEqual([tag, 'до\n\nпосле']);
    });
    // несколько блоков подряд — обработаны все
    expect(P.stripToolCallBlocks(
      'A\n\n<browser_click>{}</browser_click>\n\n<browser_key>{"key":"Enter"}</browser_key>\n\nB'))
      .toBe('A\n\nB');
    // атрибуты открывающего тега допускаются
    expect(P.stripToolCallBlocks('A\n<browser_fill selector="#q" text="привет" delay="50"></browser_fill>\nB'))
      .toBe('A\nB');
  });

  test('S4: теги-РЕЗУЛЬТАТЫ и обычные тексты/разметка не тронуты (байтово)', () => {
    // result-теги не входят в список вызовов: их вырезает S3 вместе с user-ходом
    ['<browser_click_result>\n{"ok":true}\n</browser_click_result>',
      '<memory_update_result>{}</memory_update_result>',
      '<web_search_result>{}</web_search_result>'
    ].forEach(function (t) { expect([t, P.stripToolCallBlocks(t)]).toEqual([t, t]); });
    // пары без тела-близнеца, одиночные теги, чужой закрывающий — не трогаем
    ['<browser_click>{}', 'текст <browser_click> внутри строки',
      '<browser_click>{}</browser_other>', '<browser>{}<browser>'
    ].forEach(function (t) { expect([t, P.stripToolCallBlocks(t)]).toEqual([t, t]); });
    // обычные тексты всех платформ — байтово (быстрый выход по '<')
    PLATFORMS.forEach(function (fixture) {
      expect([fixture.site, P.stripToolCallBlocks(fixture.user)]).toEqual([fixture.site, fixture.user]);
      expect([fixture.site, P.stripToolCallBlocks(fixture.assistant)]).toEqual([fixture.site, fixture.assistant]);
    });
    ['', 'C# и Java', 'a < b и c > d', 'код: if (a<b) { }', '**markdown** и `код`'].forEach(function (t) {
      expect([t, P.stripToolCallBlocks(t)]).toEqual([t, t]);
    });
    expect(P.stripToolCallBlocks(null)).toBe('');
    expect(P.stripToolCallBlocks(42)).toBe('42');
  });

  test('S4 идемпотентен: повторный вызов на своём же выходе ничего не меняет', () => {
    const once = P.stripToolCallBlocks(ARTIFACT_ASSISTANT_RAW);
    expect(once).toBe(ARTIFACT_ASSISTANT_ORACLE);
    expect(P.stripToolCallBlocks(once)).toBe(once);
  });

  test('S5: ход ассистента из одних тул-коллов и пустые тексты в экспорт не попадают', () => {
    const res = P.sanitizeEmitMessages([
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: '<browser_click>{"selector":"#go"}</browser_click>' },
      { role: 'assistant', text: '' },
      { role: 'assistant', text: '   \n  ' },
      { role: 'assistant', text: 'ответ' }
    ]);
    expect(res.messages.map(function (m) { return m.text; })).toEqual(['вопрос', 'ответ']);
    expect(res.dropped).toBe(3);
    // сообщение-ход, ставший пустым после урезания reasoning, тоже уходит
    const onlyReasoning = P.sanitizeEmitMessages([{ role: 'assistant', text: '[REASONING]\nр\n\n[ANSWER]\n' }]);
    expect(onlyReasoning.messages).toEqual([]);
    expect(onlyReasoning.dropped).toBe(1);
  });

  test('R-пин: сообщения без тул-мусора — ТЕ ЖЕ объекты (O-20/вызовы не переписывают вход)', () => {
    const plain = [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: 'ответ' }];
    const res = P.sanitizeEmitMessages(plain);
    expect(res.messages[0]).toBe(plain[0]);
    expect(res.messages[1]).toBe(plain[1]);
    expect(res.dropped).toBe(0);
    // вход S4/S3 не мутируется: исходный ход ассистента байтово прежний
    const input = artifactMessages();
    const snapshot = input.map(function (m) { return m.text; });
    P.sanitizeEmitMessages(input);
    expect(input.map(function (m) { return m.text; })).toEqual(snapshot);
    expect(input[0].text).toBe(ARTIFACT_TOOL_RESULTS_USER);
    expect(input[1].text).toBe(ARTIFACT_ASSISTANT_RAW);
  });

  test('R-пин: 5 прочих платформ байтово прежние на обоих путях (тул-мусора там нет)', () => {
    PLATFORMS.filter(function (f) { return f.site !== 'deepseek'; }).forEach(function (fixture) {
      const input = networkMessages(fixture);
      [emitNetworkOff(fixture, input), emitNetworkOn(fixture, input)].forEach(function (out) {
        expect([fixture.site, out.map(function (m) { return m.text; })])
          .toEqual([fixture.site, [fixture.user, fixture.assistant]]);
      });
    });
    // чужие тексты, ПОХОЖИЕ на мусор (подстрока, но не целый ход), не вырезаются
    const lookalike = [
      { role: 'user', text: 'мой вопрос: [TOOL_RESULTS] — просто упоминание' },
      { role: 'assistant', text: 'пример из доки: <browser_click>{} — это вызов' }
    ];
    const res = P.sanitizeEmitMessages(lookalike);
    expect(res.messages.map(function (m) { return m.text; }))
      .toEqual([lookalike[0].text, lookalike[1].text]);
    expect(res.dropped).toBe(0);
  });

  test('source-пины: S3/S4/S5 стоят в OFF-пути пайплайна, ON-путь их не вызывает', () => {
    expect(PIPELINE_SRC).toContain('function isToolResultsOnlyText(text)');
    expect(PIPELINE_SRC).toContain('function stripToolCallBlocks(text)');
    expect(PIPELINE_SRC).toContain('function isEmptyExportText(text)');
    expect(PIPELINE_SRC).toContain('if (m.role === \'user\' && isToolResultsOnlyText(raw)) { dropped++; continue; }');
    expect(PIPELINE_SRC).toContain('var cut = stripToolCallBlocks(');
    // полный список тегов — в константе пайплайна
    TOOL_CALL_TAG_NAMES.forEach(function (tag) {
      expect([tag, PIPELINE_SRC.indexOf("'" + tag + "'") >= 0]).toEqual([tag, true]);
    });
    expect(PIPELINE_SRC).toContain("|shell_\\\\w+|python_\\\\w+|skill_\\\\w+");
    // ON-путь (сырой режим) S3/S4/S5 не зовёт: вырезает и удаляет ТОЛЬКО OFF
    const onFn = sliceSource(PIPELINE_SRC, 'function includeHiddenExportBlocks(messages)', 'var Api = {');
    expect(onFn).not.toContain('stripToolCallBlocks');
    expect(onFn).not.toContain('isToolResultsOnlyText');
    expect(onFn).not.toContain('isEmptyExportText');
    expect(onFn).toContain('HIDDEN_REASONING_TAG');
  });
});

/* =====================================================================================
 * R1: санация O-20 при OFF активна + секции reasoning урезаны на выходе
 * ===================================================================================== */
describe('O-7 R1: при OFF санация O-20 активна (инъекции вырезаны)', () => {
  const ds = PLATFORMS[2];

  test('md/txt/json OFF: инъекций нет, секций reasoning нет, ответ на месте', () => {
    const hist = historyFrom(ds, emitNetworkOff(ds));
    const md = Builders.buildMdFromHistory(hist, 'DeepSeek');
    const txt = Builders.buildTxtFromHistory(hist);
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'DeepSeek'));
    expect(md).toContain(VISIBLE_USER_TEXT);
    expect(txt).toContain(VISIBLE_USER_TEXT);
    expect(json.messages[0].text).toBe(VISIBLE_USER_TEXT);
    expect(json.messages[1].text).toBe(ANSWER_TEXT);          // OFF: только часть [ANSWER]
    expect(md).toContain(ANSWER_TEXT);
    expect(txt).toContain(ANSWER_TEXT);
    [md, txt, JSON.stringify(json)].forEach(function (body) {
      expect(body).not.toContain('deepseek-pp');
      expect(body).not.toContain('Existing memories:');
      expect(body).not.toContain('Tool call format reminder:');
      expect(body).not.toContain('Continue answering based on the tool results above.');
      expect(body).not.toContain('[REASONING]');
      expect(body).not.toContain('[ANSWER]');
      expect(body).not.toContain(REASONING_TEXT);
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
    expect(oracleOffExport([{ role: 'user', text: INJECTED_USER_TEXT }])[0].text).toBe(VISIBLE_USER_TEXT);
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
          // шапка (до первого сообщения) у OFF и ON совпадает по метрикам побайтово;
      // строку «Дата экспорта:» нормализуем: два последовательных эмита могут пересечь
      // миллисекундную границу (flake CI Lint #22 на 377aab9: ...36.956Z vs ...36.955Z)
    const normStamp = (s) => s.replace(/Дата экспорта: [^\n]+/g, 'Дата экспорта: <STAMP>');
    expect(normStamp(mdOff.slice(0, mdOff.indexOf('## ')))).toBe(normStamp(mdOn.slice(0, mdOn.indexOf('## '))));
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

  test('OFF не мутирует базу метрик: урезание живёт только на выходе экспорта', () => {
    const input = networkMessages(ds);
    const e = makeEmitter();
    e.offline();
    const before = input.map(function (m) { return m.text; });
    const out = e.run(input);
    expect(e.ctx.lastBaseTexts).toEqual(before);          // база метрик байтово прежняя
    expect(input[1].text).toBe(NETWORK_ASSISTANT_TEXT);   // вход не мутирован
    expect(out[1].text).toBe(ANSWER_TEXT);                // урезан только выход
  });

  test('source-пин: текст метрик (aiCmPreparedText/aiCmMetricBaseText) hidden-полей не видит', () => {
    const prepared = sliceSource(CONTENT_SRC, 'function aiCmPreparedText(messages)', 'function aiCmMetricBaseText(fallback)');
    const metric = sliceSource(CONTENT_SRC, 'function aiCmMetricBaseText(fallback)', '// ================= v61diag');
    expect(prepared).toContain('out.push(String((src[i] && src[i].text) || \'\'));');
    expect(prepared).not.toContain('hiddenReasoning');
    expect(metric).not.toContain('hiddenReasoning');
    expect(metric).toContain('return aiCmPreparedText(aiCmBasePrepared);');
    // metrics-текст строится из СХЛОПНУТОЙ БАЗЫ снимка, а не из выхода точки эмита:
    // ни O-20, ни hidden-блоки, ни урезание секций метрик не касаются
    expect(metric).not.toContain('aiCmSanitizeEmitUserTexts');
    expect(metric).not.toContain('includeHiddenExportBlocks');
    expect(metric).not.toContain('stripReasoningSections');
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
    expect(PIPELINE_SRC).toContain('function stripReasoningSections(text)');
    // S3/S4/S5: чистые функции тул-мусора DeepSeek++ (OFF-путь) на месте
    expect(PIPELINE_SRC).toContain('function isToolResultsOnlyText(text)');
    expect(PIPELINE_SRC).toContain('function stripToolCallBlocks(text)');
    expect(PIPELINE_SRC).toContain('function isEmptyExportText(text)');
    // база секций не тронута: перехватчик по-прежнему собирает [REASONING]/[ANSWER] в текст хода
    expect(INTERCEPT_SRC).toContain("var REASONING_TAG = '[REASONING]';");
    expect(INTERCEPT_SRC).toContain("var ANSWER_TAG = '[ANSWER]';");
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
    expect(ru[HIDDEN_LABEL_KEY].message).toBe(HIDDEN_LABEL_RU);      // метку не меняем
    // O-7: подсказка описывает НОВУЮ семантику (OFF = вопросы и ответы, ON = всё как есть)
    expect(ru[HIDDEN_HINT_KEY].message).toBe(HIDDEN_HINT_RU);
    expect(en[HIDDEN_HINT_KEY].message).toMatch(/^Off: /);
    expect(en[HIDDEN_HINT_KEY].message).toContain('reasoning');
    expect(en[HIDDEN_HINT_KEY].message).toContain('injections');
    // i18n-инвариант: fallback разметки байтово равен ru-значению словаря
    expect(OPTIONS_HTML).toContain('data-i18n="' + HIDDEN_HINT_KEY + '">' + HIDDEN_HINT_RU + '</span>');
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
describe('O-7 R5: релиз v2.0.10 — версия во всех точках вывода, верх CHANGELOG — [2.0.10]', () => {
  test('версия 2.0.10 во всех точках вывода (манифест/пакет/лок)', () => {
    expect(manifest.version).toBe('2.0.10');
    expect(pkg.version).toBe('2.0.10');
    expect(lock.version).toBe('2.0.10');
    expect(lock.packages[''].version).toBe('2.0.10');
  });

  test('верхняя запись CHANGELOG — [2.0.10]; прежние секции не переписаны', () => {
    const top = changelog.split(/\r?\n/).find(function (l) { return l.indexOf('## [') === 0; });
    expect(top).toBe('## [2.0.10] - 2026-09-19');
    expect(changelog).not.toContain('aiCmIncludeHiddenInExport');
    expect(changelog).not.toContain('Включать reasoning и инъекции DeepSeek++ в экспорт');
  });

  test('тумблер не добавлен в релизные точки версии (options футер берёт версию из манифеста)', () => {
    expect(OPTIONS_JS).toContain("versionEl.textContent = 'v' + manifest.version");
    expect(OPTIONS_HTML).toContain('<span class="version"></span>');
  });
});
