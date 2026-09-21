/**
 * FIX (Claude → md): ВСЕ ХОДЫ ПОЛЬЗОВАТЕЛЯ, А НЕ ТОЛЬКО role='user'.
 *
 * Дефект: utils/export-text-builders.js:buildMdFromHistory() выбирал заголовок хода
 * бинарно — `msg.role === 'user'` → '## Пользователь', ИНАЧЕ '## Ассистент'. Парсер
 * истории Claude (core/claude-intercept.js:1065 и его тест-близнец
 * tests/helpers/parse-claude-conversation.js) кладёт ход пользователя ролью 'human',
 * поэтому в md-экспорте Claude ВСЕ ходы (и вопросы, и ответы) шли под '## Ассистент' —
 * вопрос пользователя невозможно было отличить от ответа модели.
 *
 * Фикс (одно условие): 'user' || 'human' → '## Пользователь'. Маркерный путь qwen
 * (mdMarked) не тронут: у него свои '### USER'/'### ASSISTANT' (O-36/R2).
 *
 * Контур пинов:
 *   D1 — Claude-история (РЕАЛЬНЫЙ фикстур-парсер, роли 'human'/'assistant') → md несёт
 *        '## Пользователь' на каждом ходе пользователя; 'human' не протекает в файл;
 *   D2 — СИЛЬНЫЙ байтовый пин: та же история с ролями, нормализованными 'human'→'user',
 *        даёт БАЙТОВО тот же md (т.е. 'human' эквивалентен 'user'); до фикса пин красный;
 *   D3 — source-пин условия сборщика;
 *   R1 — шесть прежних платформ (user/assistant) → md байтово равен оракулу со СТАРОЙ
 *        логикой ролей (ни одного нового байта);
 *   R2 — маркерный путь (site=qwen) не задет: '### USER'/'### ASSISTANT' как были.
 *   D3 — live-цепочка (РЕАЛЬНЫЕ aiCmCollectExportSource + aiCmDedupeExportSource +
 *        buildHistoryMessages): Claude-адаптер role='human' → msg[0].role === 'user', md несёт
 *        '## Пользователь' на ходах пользователя; + source-пины трёх точек нормализации upstream;
 *   D4 — live-цепочка сети: role='human' в lastDetailMessages → 'user' → '## Пользователь';
 *   R3 — live-цепочка пяти прочих платформ (user/assistant): md байтово равен оракулу;
 *   R4 — live-цепочка Gemini/AI Studio: роли и байты md прежние (ветка дедупа не тронута);
 *   R5 — normalizeExportMessages (utils/export-emit-pipeline.js): 'human'→'user', прочие роли
 *        прежние (user→user, model/bot→assistant).
 *   R6 — live-измерение под гейтом aiCmDebug (РЕАЛЬНЫЕ aiCmDiagOn/aiCmDiagLine из utils/debug.js):
 *        пять диаг-маркеров claude-role-* печатаются с фактом «human на входе → user на выходе»
 *        и НЕ меняют байты md; site-aware маркеры (dedupe/network/adapter) SCOPED по 'claude' —
 *        на чужом сайте их строк нет, то есть чужой тег через канон инструментирования не уходит;
 *   R7 — тот же прогон БЕЗ гейта: НИ ОДНОЙ строки, байты md идентичны прогону под гейтом.
 *
 * НЕ ТРОГАЕТСЯ: текст ходов, шапка (platform/model/tokens/дата), json/txt-сборщики.
 */

const fs = require('fs');
const path = require('path');

const Builders = require('../utils/export-text-builders.js');
const { parseClaudeConversation } = require('./helpers/parse-claude-conversation');

const ROOT = path.join(__dirname, '..');
const BUILDERS_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');
const CLAUDE_INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'claude-intercept.js'), 'utf8');

const CLAUDE_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'claude-conversation.json'), 'utf8')
);

// Фиксированные прочие платформы: только роли 'user'/'assistant' (R-пины байтового регресса).
const OTHER_PLATFORMS = [
  { site: 'deepseek', label: 'DeepSeek', model: 'DeepSeek-V3' },
  { site: 'chatgpt', label: 'ChatGPT', model: 'GPT-4o' },
  { site: 'gemini', label: 'Gemini', model: 'Gemini 2.5 Pro' },
  { site: 'perplexity', label: 'Perplexity', model: 'Sonar' },
  { site: 'google_search', label: 'Google Search AI', model: 'Gemini 2.5 Flash' }
];

const TOKENS = 4210;
const LIMIT = 131072;
const PERCENT = 3.2;

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

function mdOf(messages, platform, model) {
  return Builders.buildMdFromHistory({
    host: 'chat.example',
    convId: 'conv-md-roles-1',
    model: model || 'Claude 3.5 Sonnet',
    tokens: TOKENS,
    limit: LIMIT,
    percent: PERCENT,
    messages: messages
  }, platform);
}

/**
 * Оракул СТАРОЙ (до фикса) логики ролей: пользователь — ТОЛЬКО role==='user',
 * всё остальное (в т.ч. 'human') — ассистент. Формат шапки/тел — как у сборщика
 * (текст без reasoning: инвариант R-пинов).
 */
function oracleMdOldRoles(history, platform) {
  const lines = [];
  lines.push('# AI Context Monitor — экспорт истории');
  lines.push('');
  lines.push('Платформа: ' + (platform || 'AI Chat'));
  lines.push('Модель: ' + (history.model || '—'));
  lines.push('Дата экспорта: ' + new Date().toISOString());
  const tokens = (typeof history.tokens === 'number') ? history.tokens : 0;
  const limit = (typeof history.limit === 'number') ? history.limit : 0;
  const percent = (typeof history.percent === 'number') ? history.percent : 0;
  lines.push('Токены: ' + tokens + ' / ' + limit + ' (' + percent + '%)');
  lines.push('');
  const messages = Array.isArray(history.messages) ? history.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] || {};
    lines.push((msg.role === 'user') ? '## Пользователь' : '## Ассистент');
    lines.push('');
    lines.push((typeof msg.text === 'string') ? msg.text : '');
    lines.push('');
  }
  return lines.join('\n');
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-21T12:00:00.000Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

// =====================================================================================
// D1: CLAUDE-ИСТОРИЯ — ХОДЫ ПОЛЬЗОВАТЕЛЯ ПОД '## Пользователь'
// =====================================================================================
describe('Claude md roles D1: роли human/assistant реального парсера → корректные заголовки', () => {
  test('D1 роли фикстуры human/assistant, md: 2 × Пользователь и 2 × Ассистент, «human» в файле нет', () => {
    const parsed = parseClaudeConversation(CLAUDE_FIXTURE);
    // Страховка пина: источник ролей — действительно 'human' (парсер Claude).
    expect(parsed.messages.map(function (m) { return m.role; }))
      .toEqual(['human', 'assistant', 'human', 'assistant']);

    const md = mdOf(parsed.messages, 'Claude', parsed.model);
    expect(countOccurrences(md, '## Пользователь')).toBe(2);
    expect(countOccurrences(md, '## Ассистент')).toBe(2);
    expect(md).not.toContain('human');
    // Заголовок пользователя стоит ПЕРЕД текстом хода пользователя, а не подменён.
    expect(md).toContain('## Пользователь\n\n' + parsed.messages[0].text);
    expect(md).toContain('## Ассистент\n\n' + parsed.messages[1].text);
  });

  test('D1 source-пин: роль пользователя в сборщике — user ИЛИ human; маркерный путь qwen прежний', () => {
    const fn = fnDecl(BUILDERS_SRC, 'buildMdFromHistory');
    expect(fn).toContain(": ((msg.role === 'user' || msg.role === 'human')");
    expect(fn).toContain("aiCmI18nMessage('export_md_role_user', '## Пользователь')");
    expect(fn).toContain("aiCmI18nMessage('export_md_role_assistant', '## Ассистент')");
    // Реальный источник роли 'human' — парсер истории Claude (и его тест-близнец).
    expect(CLAUDE_INTERCEPT_SRC).toContain("sender === 'assistant' ? 'assistant' : 'human'");
    const helperSrc = fs.readFileSync(path.join(ROOT, 'tests', 'helpers', 'parse-claude-conversation.js'), 'utf8');
    expect(helperSrc).toContain("sender === 'assistant' ? 'assistant' : 'human'");
  });
});

// =====================================================================================
// D2: БАЙТОВАЯ ЭКВИВАЛЕНТНОСТЬ 'human' И 'user'
// =====================================================================================
describe('Claude md roles D2: md(human-роли) байтово равен md(user-роли)', () => {
  test('D2 та же история с human→user даёт БАЙТОВО тот же md (до фикса — красный)', () => {
    const humanMsgs = [
      { role: 'human', text: 'Первый вопрос пользователя.' },
      { role: 'assistant', text: 'Первый ответ.' },
      { role: 'human', text: 'Второй вопрос пользователя.' },
      { role: 'assistant', text: 'Второй ответ.' }
    ];
    const userMsgs = humanMsgs.map(function (m) {
      return { role: (m.role === 'human') ? 'user' : m.role, text: m.text };
    });

    const mdHuman = mdOf(humanMsgs, 'Claude', 'claude-sonnet-4-6');
    const mdUser = mdOf(userMsgs, 'Claude', 'claude-sonnet-4-6');
    expect(mdHuman).toBe(mdUser);

    // Контроль оракула: старая логика на 'human' дала бы ДРУГОЙ файл (2 × Ассистент) —
    // то есть пин D2 действительно про фикс, а не про совпадение заголовков.
    const mdOld = oracleMdOldRoles({
      model: 'claude-sonnet-4-6', tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: humanMsgs
    }, 'Claude');
    expect(mdOld).not.toBe(mdHuman);
    expect(countOccurrences(mdOld, '## Пользователь')).toBe(0);
    expect(countOccurrences(mdOld, '## Ассистент')).toBe(4);
  });

  test('D2 прочие НЕ-user роли поведения не меняют: assistant/model/bot → Ассистент', () => {
    const md = mdOf([
      { role: 'human', text: 'Вопрос.' },
      { role: 'assistant', text: 'Ответ.' },
      { role: 'model', text: 'Ответ модели.' },
      { role: 'bot', text: 'Ответ бота.' }
    ], 'Claude', 'claude-sonnet-4-6');
    expect(countOccurrences(md, '## Пользователь')).toBe(1);
    expect(countOccurrences(md, '## Ассистент')).toBe(3);
  });
});

// =====================================================================================
// R1: ШЕСТЬ ПРЕЖНИХ ПЛАТФОРМ — БАЙТЫ ПРЕЖНИЕ
// =====================================================================================
describe('Claude md roles R1: прочие платформы (user/assistant) — ни одного нового байта', () => {
  test('R1 каждая платформа: md байтово равен оракулу со старой логикой ролей', () => {
    OTHER_PLATFORMS.forEach(function (p) {
      const history = {
        host: 'chat.example',
        convId: 'conv-md-roles-r1',
        site: p.site,
        model: p.model,
        tokens: TOKENS,
        limit: LIMIT,
        percent: PERCENT,
        messages: [
          { role: 'user', text: 'Вопрос ' + p.label },
          { role: 'assistant', text: 'Ответ ' + p.label },
          { role: 'user', text: 'Уточнение ' + p.label },
          { role: 'assistant', text: 'Финальный ответ ' + p.label }
        ]
      };
      const real = Builders.buildMdFromHistory(history, p.label);
      const oracle = oracleMdOldRoles(history, p.label);
      expect(real).toBe(oracle);
      // Оракул осмыслен: заголовки ролей на месте.
      expect(countOccurrences(real, '## Пользователь')).toBe(2);
      expect(countOccurrences(real, '## Ассистент')).toBe(2);
    });
  });

  test('R1 без site (ручной экспорт попапа): те же байты, что у оракула', () => {
    const history = {
      model: 'GPT-4o', tokens: TOKENS, limit: LIMIT, percent: PERCENT,
      messages: [
        { role: 'user', text: 'Вопрос.' },
        { role: 'assistant', text: 'Ответ.' }
      ]
    };
    expect(Builders.buildMdFromHistory(history, 'ChatGPT')).toBe(oracleMdOldRoles(history, 'ChatGPT'));
  });
});

// =====================================================================================
// R2: МАРКЕРНЫЙ ПУТЬ qwen НЕ ЗАДЕТ
// =====================================================================================
describe('Claude md roles R2: site=qwen — прежние маркеры ### USER / ### ASSISTANT', () => {
  test('R2 qwen: локализованные заголовки не появляются, маркеры ролей на месте', () => {
    const md = Builders.buildMdFromHistory({
      site: 'qwen', model: 'Qwen3.8-Max', tokens: TOKENS, limit: LIMIT, percent: PERCENT,
      messages: [
        { role: 'user', text: 'привет' },
        { role: 'assistant', text: 'ответ' }
      ]
    }, 'Qwen');
    expect(md).toContain('### USER\n\nпривет');
    expect(md).toContain('### ASSISTANT\n\nответ');
    expect(md).not.toContain('## Пользователь');
    expect(md).not.toContain('## Ассистент');
  });
});

// =====================================================================================
// D3/D4/R3-R5: LIVE-ЦЕПОЧКА buildHistoryMessages → buildMdFromHistory
// =====================================================================================
// Второй контур дефекта: даже с фиксом сборщика (D1/D2) роль хода НОРМАЛИЗУЕТСЯ upstream —
// aiCmCollectExportSource (core/export-manager.js) и aiCmDedupeExportSource
// (core/base-handler.js) строили role бинарно `=== 'user' ? 'user' : 'assistant'`, поэтому
// 'human' парсера Claude умирал ДО buildMdFromHistory. Пины ниже гонят РЕАЛЬНЫЕ функции обоих
// модулей в одном лексическом скоупе (как в браузере) — ровно выражение buildHistoryMessages.
// =====================================================================================

const P = require('../utils/export-emit-pipeline.js');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const BASE_HANDLER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'base-handler.js'), 'utf8');

const COLLECT_SRC = MGR_SRC.slice(
  MGR_SRC.indexOf('function sanitizeGeminiText(s)'),
  MGR_SRC.indexOf('// T1-fix#3')
);

/**
 * Песочница ЖИВОЙ цепочки: РЕАЛЬНЫЕ aiCmCollectExportSource (export-manager.js),
 * aiCmDedupeExportSource и buildHistoryMessages (base-handler.js) в одном скоупе.
 * Вход — DOM-адаптер (baseSeen=false, как у Claude) и/или сетевой снимок (baseSeen=true).
 * Выход — ровно aiCmDedupeExportSource(aiCmCollectExportSource()).messages, т.е. то, что
 * получает buildMdFromHistory в бою.
 */
function makeHistoryChain(opts) {
  const o = opts || {};
  const site = o.site || 'claude';
  const adapterMessages = o.adapterMessages || [];
  const ctx = {
    window: { AiCmExportEmitPipeline: P },
    sessionStorage: {
      getItem: function () { return null; },
      setItem: function () { },
      removeItem: function () { }
    },
    // Диагностика (Claude md): свой console можно подать снаружи — пины гейта ловят строки
    // aiCmDiagLine, напечатанные ИЗНУТРИ песочницы. По умолчанию — прежний глушитель.
    console: o.console || { log: function () { }, warn: function () { }, error: function () { }, info: function () { }, debug: function () { } },
    lastBaseTexts: o.texts || [],
    lastDetailMessages: o.detail || null,
    baseSeen: o.baseSeen === true,
    currentAdapter: {
      siteName: site,
      extractMessages: function () { return adapterMessages.slice(); }
    },
    aiCmLogIntraDedupe: function () { }
  };
  const src = COLLECT_SRC + '\n' +
    fnDecl(BASE_HANDLER_SRC, 'aiCmDedupeExportSource') + '\n' +
    fnDecl(BASE_HANDLER_SRC, 'buildHistoryMessages') + '\n' +
    'ctx.__history = buildHistoryMessages;';
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  return ctx.__history();
}

/** md по выходу цепочки — тот же сборщик и та же шапка, что у mdOf (site берётся из истории). */
function mdOfChain(rows, site, platform, model) {
  return Builders.buildMdFromHistory({
    host: 'chat.example',
    convId: 'conv-md-roles-live',
    site: site,
    model: model || 'claude-sonnet-4-6',
    tokens: TOKENS,
    limit: LIMIT,
    percent: PERCENT,
    messages: rows
  }, platform);
}

// —— D3: Claude-адаптер (role='human') — нормализация upstream, затем md ——
describe('Claude md roles D3: live-цепочка адаптера (role=human) → buildHistoryMessages → md', () => {
  test('D3 human не доходит до md: роли user/assistant, ходы пользователя под ## Пользователь', () => {
    // История НЕ чередуется (два хода пользователя подряд): фолбэк чередования ролей на ней
    // дал бы ДРУГИЕ роли — пин действительно про нормализацию, а не про совпадение чётности.
    const messages = [
      { role: 'human', text: 'Первый вопрос пользователя.' },
      { role: 'human', text: 'Дополнение к первому вопросу.' },
      { role: 'assistant', text: 'Ответ на оба сообщения.' },
      { role: 'human', text: 'Ещё один вопрос.' },
      { role: 'assistant', text: 'Последний ответ.' }
    ];
    const rows = makeHistoryChain({ site: 'claude', adapterMessages: messages });

    // (1) нормализация upstream: 'human' → 'user' (до фикса — фолбэк чередования/assistant).
    expect(rows.map(function (m) { return m.role; }))
      .toEqual(['user', 'user', 'assistant', 'user', 'assistant']);
    expect(rows[0].role).toBe('user');
    expect(rows.map(function (m) { return m.text; }))
      .toEqual(messages.map(function (m) { return m.text; }));

    // (2) точка выхода: тот же md-сборщик на выходе цепочки.
    const md = mdOfChain(rows, 'claude', 'Claude');
    expect(countOccurrences(md, '## Пользователь')).toBe(3);
    expect(countOccurrences(md, '## Ассистент')).toBe(2);
    expect(md).not.toContain('human');
    expect(md).toContain('## Пользователь\n\n' + messages[1].text);
    expect(md).toContain('## Пользователь\n\n' + messages[3].text);
    // Контроль: md цепочки байтово равен md той же истории с ролями 'user'/'assistant'.
    const userRows = messages.map(function (m) {
      return { role: (m.role === 'human') ? 'user' : m.role, text: m.text };
    });
    expect(md).toBe(mdOfChain(userRows, 'claude', 'Claude'));
  });

  test('D3 source-пины трёх точек нормализации upstream (+ защита сборщика не сдвинута)', () => {
    // (1) core/base-handler.js:aiCmDedupeExportSource — не-Gemini ветка.
    expect(BASE_HANDLER_SRC)
      .toContain("var msg = { role: (mp.role === 'user' || mp.role === 'human') ? 'user' : 'assistant', text: (typeof mp.text === 'string') ? mp.text : '' };");
    // (2) core/export-manager.js:aiCmCollectExportSource — сетевая ветка.
    expect(MGR_SRC)
      .toContain("var msg = { role: (r === 'user' || r === 'human') ? 'user' : 'assistant', text: sanitizeGeminiText(texts[i]) };");
    // (3) core/export-manager.js:aiCmCollectExportSource — предикат «роль есть» (иначе Claude
    // уходил бы фолбэком чередования и терял настоящие роли ходов).
    expect(MGR_SRC)
      .toContain("if (raw[k] && (raw[k].role === 'user' || raw[k].role === 'assistant' || raw[k].role === 'human')) { hasRoles = true; break; }");
    // Нормализация пайплайна (utils/export-emit-pipeline.js:normalizeExportMessages) — та же роль.
    const pipelineSrc = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
    expect(pipelineSrc)
      .toContain("var norm = { role: (m.role === 'user' || m.role === 'human') ? 'user' : 'assistant', text: text };");
    // Защита от ПРЯМОЙ подачи 'human' в сборщик (utils/export-text-builders.js:300) — прежняя.
    expect(BUILDERS_SRC).toContain("(msg.role === 'user' || msg.role === 'human')");
    // Копия поля reasoning (O-39) в обеих ветках — байтово прежняя.
    expect(BASE_HANDLER_SRC).toContain("if (typeof mp.reasoning === 'string' && mp.reasoning) msg.reasoning = mp.reasoning;");
    expect(MGR_SRC).toContain("if (typeof dm.reasoning === 'string' && dm.reasoning) msg.reasoning = dm.reasoning;");
  });
});

// —— D4: сетевая ветка точки сбора (role='human' в снимке) ——
describe('Claude md roles D4: live-цепочка сети (role=human в lastDetailMessages) → md', () => {
  test('D4 human в сетевом снимке нормализуется в user, md — ## Пользователь/## Ассистент', () => {
    const q = 'Вопрос пользователя из сетевого снимка истории.';
    const a = 'Ответ ассистента из сетевого снимка истории.';
    const rows = makeHistoryChain({
      site: 'claude',
      baseSeen: true,
      texts: [q, a],
      detail: [{ role: 'human', text: q }, { role: 'assistant', text: a }]
    });
    expect(rows.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    const md = mdOfChain(rows, 'claude', 'Claude');
    expect(countOccurrences(md, '## Пользователь')).toBe(1);
    expect(countOccurrences(md, '## Ассистент')).toBe(1);
    expect(md).toContain('## Пользователь\n\n' + q);
  });
});

// —— R3: прочие платформы (user/assistant) через live-цепочку — байты прежние ——
describe('Claude md roles R3: live-цепочка прочих платформ — ни одного нового байта', () => {
  test('R3 каждая платформа: роли не переименованы, md байтово равен оракулу старой логики', () => {
    OTHER_PLATFORMS.forEach(function (p) {
      const messages = [
        { role: 'user', text: 'Вопрос ' + p.label + ': как устроен экспорт истории этого чата?' },
        { role: 'assistant', text: 'Ответ ' + p.label + ': история собирается из базы ходов.' },
        { role: 'user', text: 'Уточнение ' + p.label + ': а роли ходов сохраняются?' },
        { role: 'assistant', text: 'Финальный ответ ' + p.label + ': да, роли сохраняются как есть.' }
      ];
      const rows = makeHistoryChain({ site: p.site, adapterMessages: messages });
      expect(rows.map(function (m) { return m.role; }))
        .toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(rows.map(function (m) { return m.text; }))
        .toEqual(messages.map(function (m) { return m.text; }));

      const md = mdOfChain(rows, p.site, p.label, p.model);
      const oracle = oracleMdOldRoles({
        model: p.model, tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: rows
      }, p.label);
      expect(md).toBe(oracle);
      expect(countOccurrences(md, '## Пользователь')).toBe(2);
      expect(countOccurrences(md, '## Ассистент')).toBe(2);
    });
  });
});

// —— R4: ветка Gemini/AI Studio дедупа не тронута ——
describe('Claude md roles R4: live-цепочка Gemini/AI Studio (ветка дедупа не тронута)', () => {
  test('R4 gemini/aistudio: роли прежние, md байтово равен прямому md тех же сообщений', () => {
    ['gemini', 'aistudio'].forEach(function (site) {
      const messages = [
        { role: 'user', text: 'Вопрос ' + site + ': собери историю этого исследования целиком.' },
        { role: 'assistant', text: 'Ответ ' + site + ': план исследования и шаги уже собраны.' },
        { role: 'user', text: 'Уточнение ' + site + ': покажи финальную сводку по шагам.' },
        { role: 'assistant', text: 'Финальный ответ ' + site + ': сводка по шагам приложена ниже.' }
      ];
      const rows = makeHistoryChain({ site: site, adapterMessages: messages });
      expect(rows.map(function (m) { return m.role; }))
        .toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(rows.map(function (m) { return m.text; }))
        .toEqual(messages.map(function (m) { return m.text; }));
      // Байтовая идентичность: прямой md тех же сообщений (ветка Gemini/AI Studio не задета).
      expect(mdOfChain(rows, site, 'Gemini', 'Gemini 2.5 Pro'))
        .toBe(mdOfChain(messages, site, 'Gemini', 'Gemini 2.5 Pro'));
    });
  });
});

// —— R5: нормализация пайплайна — 'human' эквивалентен 'user', прочие роли прежние ——
describe('Claude md roles R5: normalizeExportMessages — human→user, прочие роли прежние', () => {
  test('R5 human→user; user→user; assistant/model/bot → assistant (байты прочих ролей)', () => {
    expect(P.normalizeExportMessages([
      { role: 'human', content: 'вопрос' },
      { role: 'user', content: 'вопрос 2' },
      { role: 'assistant', content: 'ответ' },
      { role: 'model', content: 'ответ модели' },
      { role: 'bot', content: 'ответ бота' }
    ])).toEqual([
      { role: 'user', text: 'вопрос' },
      { role: 'user', text: 'вопрос 2' },
      { role: 'assistant', text: 'ответ' },
      { role: 'assistant', text: 'ответ модели' },
      { role: 'assistant', text: 'ответ бота' }
    ]);
    // Прежний контракт (tests/export-emit-pipeline.test.js) не сдвинут.
    expect(P.normalizeExportMessages([
      { role: 'user', content: 'вопрос' },
      { role: 'model', content: 'ответ' }
    ])).toEqual([
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: 'ответ' }
    ]);
  });
});

// =====================================================================================
// R6/R7: ДИАГНОСТИКА РОЛЕЙ claude-role-* — ТОЛЬКО ПОД ГЕЙТОМ aiCmDebug
// =====================================================================================
// Гейт — РЕАЛЬНЫЕ канонические aiCmDiagOn/aiCmDiagLine из utils/debug.js (как в контент-
// скрипте): строки печатаются ровно под sessionStorage 'aiCmDebug' === '1' ИЛИ чекбоксом
// «Подробные логи» (window.__aiCmDebugLogs), и молчат без гейта. Каналов печати два —
// песочница живой цепочки (ctx.console) и сборщик md (глобальный console); оба сведены в
// ОДИН перехват, чтобы пин видел полный набор строк прогона. Пины не трогают логику ролей:
// проверяются факт и значения печати + байтовая идентичность md.
// =====================================================================================

const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const DIAG_PREFIX = '[AI CM][diag] ';

// Канонический гейт диагностики: РЕАЛЬНЫЕ функции из utils/debug.js, а не заглушки.
const DEBUG_API = new Function(
  fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
  fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
  ' return { on: aiCmDiagOn, line: aiCmDiagLine };')();

const ROLE_MARKERS = [
  'claude-role-dedupe',     // core/base-handler.js:aiCmDedupeExportSource
  'claude-role-network',    // core/export-manager.js:aiCmCollectExportSource (сеть)
  'claude-role-adapter',    // core/export-manager.js:aiCmCollectExportSource (DOM-адаптер)
  'claude-role-normalize',  // utils/export-emit-pipeline.js:normalizeExportMessages
  'claude-role-builder'     // utils/export-text-builders.js:buildMdFromHistory
];

// Ходы Claude в живом контуре: вопрос парсера приходит ролью 'human' (см. D1/D3/D4).
const CLAUDE_LIVE_MESSAGES = [
  { role: 'human', text: 'Вопрос пользователя Claude.' },
  { role: 'assistant', text: 'Ответ ассистента Claude.' }
];
const NET_Q = 'Вопрос пользователя Claude из сетевого снимка.';
const NET_A = 'Ответ ассистента Claude из сетевого снимка.';

/** Перехват console.log: строки диаг-печати ОБОИХ каналов — в один массив. */
function withLogCapture(run) {
  const lines = [];
  const sink = {
    // Канал песочницы: ctx.console внутри new Function-цепочки.
    log: function () { lines.push(Array.prototype.slice.call(arguments).join(' ')); },
    warn: function () { }, error: function () { }, info: function () { }, debug: function () { }
  };
  // Канал модулей (сборщик md и пайплайн): глобальный console.
  const spy = jest.spyOn(console, 'log').mockImplementation(function () {
    lines.push(Array.prototype.slice.call(arguments).join(' '));
  });
  try { run(sink); } finally { spy.mockRestore(); }
  return lines;
}

/** Один живой прогон Claude (адаптер role='human' ЛИБО сетевой снимок) + md: строки наружу. */
function runClaudeLive(mode) {
  let rows = null;
  let md = '';
  const lines = withLogCapture(function (sink) {
    rows = (mode === 'network')
      ? makeHistoryChain({
        site: 'claude', baseSeen: true, texts: [NET_Q, NET_A],
        detail: [{ role: 'human', text: NET_Q }, { role: 'assistant', text: NET_A }],
        console: sink
      })
      : makeHistoryChain({ site: 'claude', adapterMessages: CLAUDE_LIVE_MESSAGES, console: sink });
    md = mdOfChain(rows, 'claude', 'Claude');
  });
  return { rows: rows, md: md, lines: lines };
}

function diagLines(lines, tag) {
  return lines.filter(function (l) { return l.indexOf(DIAG_PREFIX + tag + ' ') === 0; });
}

describe('Claude md roles R6/R7: диаг-маркеры ролей — только под гейтом aiCmDebug', () => {
  beforeAll(() => {
    global.aiCmDiagOn = DEBUG_API.on;
    global.aiCmDiagLine = DEBUG_API.line;
  });

  afterAll(() => {
    try { delete global.aiCmDiagOn; } catch (e1) { }
    try { delete global.aiCmDiagLine; } catch (e2) { }
  });

  beforeEach(() => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    window.__aiCmDebugLogs = false;
  });

  afterEach(() => {
    try { window.sessionStorage.removeItem('aiCmDebug'); } catch (eS) { }
    try { window.__aiCmDebugLogs = false; } catch (eW) { }
  });

  test('R6 гейт включён: напечатаны все пять маркеров, значения human→user, байты md не тронуты', () => {
    expect(DEBUG_API.on()).toBe(true);

    const adapter = runClaudeLive('adapter');
    const network = runClaudeLive('network');
    const all = adapter.lines.concat(network.lines);

    // (1) Каждое измеренное имя маркера реально напечатано (все пять точек инструментированы).
    ROLE_MARKERS.forEach(function (tag) {
      expect(all.some(function (l) { return l.indexOf(DIAG_PREFIX + tag + ' ') === 0; })).toBe(true);
    });

    // (2) ЧИСЛО строк = число ходов/точек прогона (адаптер: normalize+dedupe+builder по 2 хода,
    // точка сбора 1; сеть: network+dedupe+builder по 2; точек другой ветки нет вовсе).
    expect(diagLines(adapter.lines, 'claude-role-normalize').length).toBe(2);
    expect(diagLines(adapter.lines, 'claude-role-adapter').length).toBe(1);
    expect(diagLines(adapter.lines, 'claude-role-dedupe').length).toBe(2);
    expect(diagLines(adapter.lines, 'claude-role-builder').length).toBe(2);
    expect(diagLines(adapter.lines, 'claude-role-network').length).toBe(0);
    expect(diagLines(network.lines, 'claude-role-network').length).toBe(2);
    expect(diagLines(network.lines, 'claude-role-dedupe').length).toBe(2);
    expect(diagLines(network.lines, 'claude-role-builder').length).toBe(2);
    expect(diagLines(network.lines, 'claude-role-adapter').length).toBe(0);

    // (3) ЗНАЧЕНИЯ: 'human' виден на входе точки и становится 'user' на выходе — по каждой точке.
    // Сеть: r=human → normalizedRole=user (корень live-приёмки «все ходы ## Ассистент»).
    expect(diagLines(network.lines, 'claude-role-network')).toEqual([
      DIAG_PREFIX + 'claude-role-network r=human normalizedRole=user',
      DIAG_PREFIX + 'claude-role-network r=assistant normalizedRole=assistant'
    ]);
    // DOM-адаптер: rawRole=human → normalizedRole=user при hasRoles=true (не фолбэк чередования).
    expect(diagLines(adapter.lines, 'claude-role-adapter')).toEqual([
      DIAG_PREFIX + 'claude-role-adapter rawRole=human normalizedRole=user hasRoles=true'
    ]);
    expect(diagLines(adapter.lines, 'claude-role-normalize')).toEqual([
      DIAG_PREFIX + 'claude-role-normalize inputRole=human outputRole=user',
      DIAG_PREFIX + 'claude-role-normalize inputRole=assistant outputRole=assistant'
    ]);
    // Дедуп и сборщик: роли уже нормализованы ('human' нигде не осталось), заголовок не подменён.
    expect(diagLines(adapter.lines, 'claude-role-dedupe')).toEqual([
      DIAG_PREFIX + 'claude-role-dedupe site=claude mpRole=user normalizedRole=user',
      DIAG_PREFIX + 'claude-role-dedupe site=claude mpRole=assistant normalizedRole=assistant'
    ]);
    expect(diagLines(adapter.lines, 'claude-role-builder')).toEqual([
      DIAG_PREFIX + 'claude-role-builder msgRole=user mdMarked=false',
      DIAG_PREFIX + 'claude-role-builder msgRole=assistant mdMarked=false'
    ]);
    // Ни одна диаг-строка не печатает роль 'human' как ИТОГ (нормализация не сломана).
    expect(all.filter(function (l) { return l.indexOf('normalizedRole=human') !== -1; })).toEqual([]);
    expect(all.filter(function (l) { return l.indexOf('outputRole=human') !== -1; })).toEqual([]);
    expect(all.filter(function (l) { return l.indexOf('msgRole=human') !== -1; })).toEqual([]);

    // (4) Байты md прогона: ходы пользователя под '## Пользователь', 'human' в файле нет, и
    // файл байтово равен оракулу старой логики ролей (инструментирование новых байт не дало).
    expect(countOccurrences(adapter.md, '## Пользователь')).toBe(1);
    expect(countOccurrences(adapter.md, '## Ассистент')).toBe(1);
    expect(adapter.md).not.toContain('human');
    expect(adapter.md).toBe(oracleMdOldRoles({
      model: 'claude-sonnet-4-6', tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: adapter.rows
    }, 'Claude'));
    expect(network.md).toBe(oracleMdOldRoles({
      model: 'claude-sonnet-4-6', tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: network.rows
    }, 'Claude'));
  });

  test('R7 гейт выключен: НИ ОДНОЙ строки, байты md идентичны прогону под гейтом', () => {
    // 1) эталон: тот же прогон под гейтом (строки есть, md посчитан).
    expect(DEBUG_API.on()).toBe(true);
    const on = runClaudeLive('adapter');
    const onNet = runClaudeLive('network');
    expect(diagLines(on.lines, 'claude-role-builder').length).toBe(2);
    expect(diagLines(onNet.lines, 'claude-role-network').length).toBe(2);

    // 2) гейт снят ОБОИМИ ключами: печати нет ни одной строки (в т.ч. прежних O-40/O-27).
    window.sessionStorage.removeItem('aiCmDebug');
    window.__aiCmDebugLogs = false;
    expect(DEBUG_API.on()).toBe(false);

    const off = runClaudeLive('adapter');
    const offNet = runClaudeLive('network');
    expect(off.lines.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; })).toEqual([]);
    expect(offNet.lines.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; })).toEqual([]);
    // Ни одного claude-role-* ни в одном канале (включая сборщик md).
    ROLE_MARKERS.forEach(function (tag) {
      expect(off.lines.concat(offNet.lines).filter(function (l) { return l.indexOf(tag) !== -1; })).toEqual([]);
    });

    // 3) БАЙТОВАЯ ИДЕНТИЧНОСТЬ: md без гейта === md с гейтом === оракул старой логики ролей.
    expect(off.md).toBe(on.md);
    expect(offNet.md).toBe(onNet.md);
    expect(off.md).toBe(oracleMdOldRoles({
      model: 'claude-sonnet-4-6', tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: off.rows
    }, 'Claude'));
    expect(off.rows.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);

    // Копия поля reasoning (O-39) и роли не сдвинуты: те же значения, что под гейтом.
    expect(off.rows).toEqual(on.rows);
    expect(offNet.rows).toEqual(onNet.rows);
  });

  test('R6 site-aware маркеры scoped: на чужом сайте их строк нет, чистые функции печатают', () => {
    expect(DEBUG_API.on()).toBe(true);
    const messages = [
      { role: 'user', text: 'Вопрос DeepSeek.' },
      { role: 'assistant', text: 'Ответ DeepSeek.' }
    ];
    let rows = null;
    const lines = withLogCapture(function (sink) {
      rows = makeHistoryChain({ site: 'deepseek', adapterMessages: messages, console: sink });
      mdOfChain(rows, 'deepseek', 'DeepSeek', 'DeepSeek-V3');
    });

    // Точки, знающие сайт (currentAdapter/site), на чужом сайте МОЛЧАТ: маркер claude-role-* —
    // замер именно Claude-цепочки. Это же гарантирует, что чужая песочница инструментирования
    // (O-40 R3: currentAdapter.siteName='deepseek') не получит через канон чужой тег.
    ['claude-role-dedupe', 'claude-role-network', 'claude-role-adapter'].forEach(function (tag) {
      expect(diagLines(lines, tag)).toEqual([]);
    });
    // Чистые функции без знания сайта (пайплайн и сборщик) под гейтом печатают, как описано.
    expect(diagLines(lines, 'claude-role-normalize')).toEqual([
      DIAG_PREFIX + 'claude-role-normalize inputRole=user outputRole=user',
      DIAG_PREFIX + 'claude-role-normalize inputRole=assistant outputRole=assistant'
    ]);
    expect(diagLines(lines, 'claude-role-builder')).toEqual([
      DIAG_PREFIX + 'claude-role-builder msgRole=user mdMarked=false',
      DIAG_PREFIX + 'claude-role-builder msgRole=assistant mdMarked=false'
    ]);
    // Байты чужой платформы не зависят от инструментирования.
    expect(rows.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(mdOfChain(rows, 'deepseek', 'DeepSeek', 'DeepSeek-V3')).toBe(oracleMdOldRoles({
      model: 'DeepSeek-V3', tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: rows
    }, 'DeepSeek'));
  });

  test('R6 source-пины: четыре точки инструментированы, имя и МЕСТО маркера не сдвинуты', () => {
    // (1) core/base-handler.js:aiCmDedupeExportSource — строка диаг ПОСЛЕ нормализации роли.
    const dedupe = fnDecl(BASE_HANDLER_SRC, 'aiCmDedupeExportSource');
    expect(dedupe).toContain("aiCmDiagLine('claude-role-dedupe', { site: site, mpRole: mp.role, normalizedRole: msg.role });");
    expect(dedupe.indexOf("aiCmDiagLine('claude-role-dedupe'"))
      .toBeGreaterThan(dedupe.indexOf("var msg = { role: (mp.role === 'user' || mp.role === 'human')"));

    // (2) core/export-manager.js:aiCmCollectExportSource — сеть ПОСЛЕ нормализации, адаптер
    // ПОСЛЕ normalizeExportMessages; предикат hasRoles байтово прежний.
    const collect = fnDecl(MGR_SRC, 'aiCmCollectExportSource');
    expect(collect).toContain("aiCmDiagLine('claude-role-network', { r: r, normalizedRole: msg.role });");
    expect(collect).toContain("aiCmDiagLine('claude-role-adapter', {");
    expect(collect.indexOf("aiCmDiagLine('claude-role-network'"))
      .toBeGreaterThan(collect.indexOf("var msg = { role: (r === 'user' || r === 'human')"));
    expect(collect.indexOf("aiCmDiagLine('claude-role-adapter'"))
      .toBeGreaterThan(collect.indexOf('P.normalizeExportMessages(raw)'));
    expect(collect).toContain("if (raw[k] && (raw[k].role === 'user' || raw[k].role === 'assistant' || raw[k].role === 'human')) { hasRoles = true; break; }");

    // (3) utils/export-emit-pipeline.js:normalizeExportMessages — ПОСЛЕ нормализации роли.
    const normalize = fnDecl(PIPELINE_SRC, 'normalizeExportMessages');
    expect(normalize).toContain("aiCmDiagLine('claude-role-normalize', { inputRole: m.role, outputRole: norm.role });");
    expect(normalize.indexOf("aiCmDiagLine('claude-role-normalize'"))
      .toBeGreaterThan(normalize.indexOf("var norm = { role: (m.role === 'user' || m.role === 'human')"));

    // (4) utils/export-text-builders.js:buildMdFromHistory — ПЕРЕД условием mdMarked, внутри
    // цикла ходов (там доступны и msg.role, и mdMarked); логика заголовка не тронута.
    const builder = fnDecl(BUILDERS_SRC, 'buildMdFromHistory');
    expect(builder).toContain("aiCmDiagLine('claude-role-builder', { msgRole: msg.role, mdMarked: mdMarked });");
    expect(builder.indexOf("aiCmDiagLine('claude-role-builder'"))
      .toBeGreaterThan(builder.indexOf('var msg = messages[i] || {};'));
    expect(builder.indexOf("aiCmDiagLine('claude-role-builder'"))
      .toBeLessThan(builder.indexOf('var title = mdMarked'));
    expect(builder).toContain(": ((msg.role === 'user' || msg.role === 'human')");
    expect(builder).not.toContain("aiCmDiagLine('claude-role-normalize'");

    // (5) Гейт — канонический: печать возможна только через aiCmDiagLine, typeof-гард на всех
    // четырёх точках (иначе срез-песочницы тестов без хелпера сломались бы).
    [dedupe, collect, normalize, builder].forEach(function (fn) {
      expect(fn).toContain("if (typeof aiCmDiagLine === 'function'");
    });
    // Маркеры, знающие сайт (dedupe/network/adapter), SCOPED по 'claude': иначе чужая песочница
    // инструментирования (напр. O-40 R3: currentAdapter.siteName='deepseek') получила бы через
    // канон чужой тег. Точки без знания сайта (normalize/builder) печатают как описано выше.
    expect(dedupe).toContain("if (typeof aiCmDiagLine === 'function' && site === 'claude') {");
    expect(collect.match(/currentAdapter\.siteName === 'claude'/g)).toHaveLength(2);
    expect(DEBUG_SRC).toContain("sessionStorage.getItem('aiCmDebug') === '1'");
  });
});

// =====================================================================================
// D5/D6/R8-R10: LIVE-ЦЕПОЧКА ОТ СЫРОГО PAYLOAD ВЛАДЕЛЬЦА (разбор tree → снимок → запись базы)
// =====================================================================================
// Корень остатка дефекта: пять точек нормализации ролей (buildMdFromHistory,
// aiCmDedupeExportSource, aiCmCollectExportSource ×2, normalizeExportMessages) стоят НИЖЕ
// записи сетевой базы. Пока сама запись (core/content.js, регион v1.18 E-2) пересчитывала
// роль бинарно `r18 === 'user'`, 'human' парсера Claude умирал в 'assistant' ДО них: в
// lastDetailMessages сетевого снимка лежал уже 'assistant' (live: dm.role=assistant для всех
// ходов), и ни одна из пяти точек не могла восстановить роль — все ходы шли под '## Ассистент'.
// Пины ниже гонят РЕАЛЬНЫЙ путь целиком: parseHistory + emitSnapshot (core/claude-intercept.js)
// → дословный регион записи базы (core/content.js) → aiCmCollectExportSource +
// aiCmDedupeExportSource + buildHistoryMessages → buildMdFromHistory.
// =====================================================================================

const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');

// Дословный срез записи сетевого снимка/базы: `if (texts.length > 0) {` … до baseIdSet —
// ровно тот код, что исполняет боевой слушатель ai-cm-full-history (core/content.js).
const BASE_WRITE_SRC = (function () {
  const start = CONTENT_SRC.indexOf('  if (texts.length > 0) {');
  const end = CONTENT_SRC.indexOf('  baseIdSet = new Set();', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return CONTENT_SRC.slice(start, end);
})();

// Строка фикса: роль хода пользователя на записи сетевой базы — 'user' ИЛИ 'human'.
const BASE_WRITE_ROLE_FIXED = "role: (r18 === 'user' || r18 === 'human') ? 'user' : 'assistant',";

// Фикстура = два объекта владельца ДОСЛОВНО: роль в sender, текст — в content[0].text,
// верхнеуровневый text ПУСТ (форма сырого tree-ответа эндпоинта <uuid>?tree=).
const RAW_CLAUDE_PAYLOAD = {
  uuid: 'conv-raw-claude-0001',
  model: 'claude-sonnet-4-6',
  chat_messages: [
    {
      uuid: 'raw-msg-0001',
      sender: 'human',
      text: '',
      content: [{ type: 'text', text: 'Сырой вопрос пользователя из tree-ответа.' }]
    },
    {
      uuid: 'raw-msg-0002',
      sender: 'assistant',
      text: '',
      content: [{ type: 'text', text: 'Сырой ответ ассистента из tree-ответа.' }]
    }
  ]
};

/**
 * Шаг 1 (tree → снимок): РЕАЛЬНЫЕ parseHistory + emitSnapshot перехватчика Claude.
 * Возвращает { parsed, detail } — detail ровно тот объект, что уходит событием
 * 'ai-cm-full-history' (messageTexts/messageIds/messages).
 */
function snapshotFromRaw(raw) {
  const ctx = {
    console: { log: function () { }, warn: function () { }, error: function () { }, info: function () { }, debug: function () { } },
    traceLog: function () { },
    lastEmitDetail: null,
    lastEmitDetailConvId: '',
    validEmitConvId: '',
    validEmitCount: 0,
    CustomEvent: function (type, init) { this.type = type; this.detail = (init || {}).detail; },
    window: { dispatchEvent: function (ev) { ctx.__detail = ev.detail; } }
  };
  const src = fnDecl(CLAUDE_INTERCEPT_SRC, 'parseHistory') + '\n' +
    fnDecl(CLAUDE_INTERCEPT_SRC, 'emitSnapshot') + '\n' +
    'var __parsed = parseHistory(__raw);\n' +
    'ctx.__parsed = __parsed;\n' +
    'emitSnapshot(__parsed, "raw-test");';
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', '__raw', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx, raw);
  return { parsed: ctx.__parsed, detail: ctx.__detail };
}

/**
 * Шаги 2-3 (снимок → запись базы → collect → dedupe → buildHistoryMessages): РЕАЛЬНЫЙ регион
 * записи базы core/content.js + РЕАЛЬНЫЕ aiCmCollectExportSource/aiCmDedupeExportSource/
 * buildHistoryMessages в одном лексическом скоупе (как в браузере).
 * opts.baseWriteSrc — подмена среза (мутационный пин D6); opts.aiCmDiagLine/console — диаг-пины.
 */
function chainFromSnapshot(detail, opts) {
  const o = opts || {};
  const site = o.site || 'claude';
  const ctx = {
    window: { AiCmExportEmitPipeline: P },
    sessionStorage: { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } },
    console: o.console || { log: function () { }, warn: function () { }, error: function () { }, info: function () { }, debug: function () { } },
    currentAdapter: { siteName: site, extractMessages: function () { return []; } },
    aiCmLogIntraDedupe: function () { },
    aiCmLogDedupeRemoved: function () { },
    lastBaseTexts: [],
    lastBaseIds: [],
    lastDetailMessages: null,
    aiCmBasePrepared: null,
    baseCount: 0,
    baseText: '',
    baseSeen: true,
    netEffectiveLen: 0,
    __snapshot: detail
  };
  if (typeof o.aiCmDiagLine === 'function') ctx.aiCmDiagLine = o.aiCmDiagLine;
  const baseWrite = o.baseWriteSrc || BASE_WRITE_SRC;
  const src = COLLECT_SRC + '\n' +
    fnDecl(BASE_HANDLER_SRC, 'aiCmDedupeExportSource') + '\n' +
    fnDecl(BASE_HANDLER_SRC, 'buildHistoryMessages') + '\n' +
    'function __baseWrite(texts, ids, detail) {\n' + baseWrite + '\n}\n' +
    '__baseWrite(__snapshot.messageTexts, __snapshot.messageIds, __snapshot);\n' +
    'ctx.__base = { texts: lastBaseTexts, msgs: lastDetailMessages, prepared: aiCmBasePrepared, count: baseCount, text: baseText };\n' +
    'ctx.__rows = buildHistoryMessages();';
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  return { base: ctx.__base, rows: ctx.__rows };
}

function rolesOf(rows) { return (rows || []).map(function (m) { return m.role; }); }
function textsOf(rows) { return (rows || []).map(function (m) { return m.text; }); }

// —— D5: СЫРОЙ payload владельца → tree → снимок → база → collect → dedupe → md ——
describe('Claude md roles D5: СЫРОЙ payload владельца → tree → снимок → база → collect → dedupe → md', () => {
  test('D5 human-ход даёт ## Пользователь, assistant-ход — ## Ассистент (все хопы реальные)', () => {
    const snap = snapshotFromRaw(RAW_CLAUDE_PAYLOAD);

    // (0) разбор tree: роль из sender, текст — из content[0].text (верхний text пуст).
    expect(rolesOf(snap.parsed.messages)).toEqual(['human', 'assistant']);
    expect(textsOf(snap.parsed.messages)).toEqual([
      'Сырой вопрос пользователя из tree-ответа.',
      'Сырой ответ ассистента из tree-ответа.'
    ]);

    // (1) СНИМОК перехватчика несёт 'human' — потеря не здесь.
    expect(rolesOf(snap.detail.messages)).toEqual(['human', 'assistant']);
    expect(snap.detail.messageTexts).toEqual(textsOf(snap.parsed.messages));

    // (2) ЗАПИСЬ СЕТЕВОЙ БАЗЫ (histWritePath=network): 'human' → 'user' (до фикса — 'assistant').
    const chain = chainFromSnapshot(snap.detail);
    expect(rolesOf(chain.base.msgs)).toEqual(['user', 'assistant']);
    expect(chain.base.count).toBe(2);

    // (3) выход боевой цепочки экспорта (collect → dedupe → buildHistoryMessages).
    expect(rolesOf(chain.rows)).toEqual(['user', 'assistant']);

    const md = mdOfChain(chain.rows, 'claude', 'Claude', 'claude-sonnet-4-6');
    expect(countOccurrences(md, '## Пользователь')).toBe(1);
    expect(countOccurrences(md, '## Ассистент')).toBe(1);
    expect(md).toContain('## Пользователь\n\nСырой вопрос пользователя из tree-ответа.');
    expect(md).toContain('## Ассистент\n\nСырой ответ ассистента из tree-ответа.');
    expect(md).not.toContain('human');

    // Контроль дефекта: прежняя бинарная запись базы дала бы assistant/assistant → 0 «Пользователь».
    const preFixRows = chain.rows.map(function (m) { return { role: 'assistant', text: m.text }; });
    const mdPreFix = oracleMdOldRoles({
      model: 'claude-sonnet-4-6', tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: preFixRows
    }, 'Claude');
    expect(countOccurrences(mdPreFix, '## Пользователь')).toBe(0);
    expect(mdPreFix).not.toBe(md);
  });

  test('D5 source-пин: запись базы знает human, текстовая логика не тронута', () => {
    // Найденная (пятая) точка нормализации — на записи сетевой базы.
    expect(BASE_WRITE_SRC).toContain(BASE_WRITE_ROLE_FIXED);
    // Текст хода берётся как прежде: из texts[d18] через sanitizeGeminiText.
    expect(BASE_WRITE_SRC).toContain('text: sanitizeGeminiText(texts[d18]),');
    // Точка стоит ДО dedupe (content.js:653) — то есть чинит роль на входе всей нижней цепочки.
    expect(BASE_WRITE_SRC.indexOf(BASE_WRITE_ROLE_FIXED))
      .toBeLessThan(BASE_WRITE_SRC.indexOf('var ded18 = aiCmDedupeExportSource(preDedupe18);'));
    // Пять точек нормализации ролей (четыре прежних + найденная) — все знают 'human'.
    expect(BASE_HANDLER_SRC).toContain("mp.role === 'user' || mp.role === 'human'");
    expect(MGR_SRC).toContain("r === 'user' || r === 'human'");
    expect(MGR_SRC).toContain("raw[k].role === 'human'");
    expect(PIPELINE_SRC).toContain("m.role === 'user' || m.role === 'human'");
    expect(BUILDERS_SRC).toContain("msg.role === 'user' || msg.role === 'human'");
    // Новая точка не дублирует и не меняет прежние четыре.
    expect(BASE_WRITE_SRC.match(/r18 === 'user'/g)).toHaveLength(1);
  });

  test('D6 мутационный пин: откат строки фикса → 0 «Пользователь» (пин красный при откате)', () => {
    // Пин держится ровно на найденной строке: без неё мутация не собирается → красный.
    expect(BASE_WRITE_SRC).toContain(BASE_WRITE_ROLE_FIXED);
    const mutated = BASE_WRITE_SRC.replace(BASE_WRITE_ROLE_FIXED, "role: (r18 === 'user') ? 'user' : 'assistant',");
    expect(mutated).not.toBe(BASE_WRITE_SRC);

    const snap = snapshotFromRaw(RAW_CLAUDE_PAYLOAD);
    const chain = chainFromSnapshot(snap.detail, { baseWriteSrc: mutated });
    // Мутированная запись базы теряет роль — та самая live-картина dm.role=assistant.
    expect(rolesOf(chain.base.msgs)).toEqual(['assistant', 'assistant']);
    expect(rolesOf(chain.rows)).toEqual(['assistant', 'assistant']);
    const md = mdOfChain(chain.rows, 'claude', 'Claude', 'claude-sonnet-4-6');
    expect(countOccurrences(md, '## Пользователь')).toBe(0);
    expect(countOccurrences(md, '## Ассистент')).toBe(2);
  });
});

// —— R8: пять прочих платформ через ту же СЫРУЮ цепочку — байты прежние ——
describe('Claude md roles R8: СЫРАЯ цепочка прочих платформ (user/assistant) — ни одного нового байта', () => {
  test('R8 каждая платформа: роли не переименованы, md байтово равен оракулу старой логики', () => {
    OTHER_PLATFORMS.forEach(function (p) {
      const msgs = [
        { role: 'user', text: 'Вопрос ' + p.label + ': как устроен экспорт истории этого чата?' },
        { role: 'assistant', text: 'Ответ ' + p.label + ': история собирается из базы ходов.' }
      ];
      // Снимок платформы: её перехватчик кладёт в detail.messages роли user/assistant.
      const detail = {
        text: textsOf(msgs).join('\n'),
        count: msgs.length,
        messageTexts: textsOf(msgs),
        messageIds: msgs.map(function (m, i) { return p.site + '-id-' + i; }),
        messages: msgs,
        convId: 'conv-raw-' + p.site,
        historyComplete: true
      };
      const chain = chainFromSnapshot(detail, { site: p.site });
      expect(rolesOf(chain.base.msgs)).toEqual(['user', 'assistant']);
      expect(rolesOf(chain.rows)).toEqual(['user', 'assistant']);
      expect(textsOf(chain.rows)).toEqual(textsOf(msgs));

      const md = mdOfChain(chain.rows, p.site, p.label, p.model);
      const oracle = oracleMdOldRoles({
        model: p.model, tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: chain.rows
      }, p.label);
      expect(md).toBe(oracle);
      expect(countOccurrences(md, '## Пользователь')).toBe(1);
      expect(countOccurrences(md, '## Ассистент')).toBe(1);
    });
  });
});

// —— R9/R10: диаг-маркеры на СЫРОЙ цепочке — только под гейтом aiCmDebug ——
describe('Claude md roles R9/R10: диаг-маркеры claude-role-* на СЫРОЙ цепочке — только под гейтом', () => {
  beforeAll(() => {
    global.aiCmDiagOn = DEBUG_API.on;
    global.aiCmDiagLine = DEBUG_API.line;
  });

  afterAll(() => {
    try { delete global.aiCmDiagOn; } catch (e1) { }
    try { delete global.aiCmDiagLine; } catch (e2) { }
  });

  beforeEach(() => {
    window.sessionStorage.setItem('aiCmDebug', '1');
    window.__aiCmDebugLogs = false;
  });

  afterEach(() => {
    try { window.sessionStorage.removeItem('aiCmDebug'); } catch (eS) { }
    try { window.__aiCmDebugLogs = false; } catch (eW) { }
  });

  /** Один прогон СЫРОЙ цепочки Claude + md; строки обоих каналов — наружу. */
  function runRawLive() {
    let chain = null;
    let md = '';
    const lines = withLogCapture(function (sink) {
      const snap = snapshotFromRaw(RAW_CLAUDE_PAYLOAD);
      chain = chainFromSnapshot(snap.detail, { console: sink, aiCmDiagLine: DEBUG_API.line });
      md = mdOfChain(chain.rows, 'claude', 'Claude', 'claude-sonnet-4-6');
    });
    return { chain: chain, md: md, lines: lines };
  }

  test('R9 гейт включён: сетевые маркеры печатают user (не human/assistant), байты md корректны', () => {
    expect(DEBUG_API.on()).toBe(true);
    const run = runRawLive();

    // Запись базы нормализовала 'human' → 'user' ДО инструментированных точек: на входе
    // collect/dedupe/builder роль уже 'user' (до фикса здесь было бы r=assistant).
    expect(diagLines(run.lines, 'claude-role-network')).toEqual([
      DIAG_PREFIX + 'claude-role-network r=user normalizedRole=user',
      DIAG_PREFIX + 'claude-role-network r=assistant normalizedRole=assistant'
    ]);
    // dedupe зовётся дважды: на записи базы (content.js:653) и в buildHistoryMessages.
    expect(diagLines(run.lines, 'claude-role-dedupe')).toEqual([
      DIAG_PREFIX + 'claude-role-dedupe site=claude mpRole=user normalizedRole=user',
      DIAG_PREFIX + 'claude-role-dedupe site=claude mpRole=assistant normalizedRole=assistant',
      DIAG_PREFIX + 'claude-role-dedupe site=claude mpRole=user normalizedRole=user',
      DIAG_PREFIX + 'claude-role-dedupe site=claude mpRole=assistant normalizedRole=assistant'
    ]);
    expect(diagLines(run.lines, 'claude-role-builder')).toEqual([
      DIAG_PREFIX + 'claude-role-builder msgRole=user mdMarked=false',
      DIAG_PREFIX + 'claude-role-builder msgRole=assistant mdMarked=false'
    ]);
    // Ни одна диаг-строка не печатает 'human' как ИТОГ (роль нормализована выше по пути).
    ['normalizedRole=human', 'outputRole=human', 'msgRole=human'].forEach(function (needle) {
      expect(run.lines.filter(function (l) { return l.indexOf(needle) !== -1; })).toEqual([]);
    });

    // Байты: human-ход — '## Пользователь', assistant-ход — '## Ассистент'; 'human' в файле нет.
    expect(countOccurrences(run.md, '## Пользователь')).toBe(1);
    expect(countOccurrences(run.md, '## Ассистент')).toBe(1);
    expect(run.md).not.toContain('human');
    expect(run.md).toBe(oracleMdOldRoles({
      model: 'claude-sonnet-4-6', tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: run.chain.rows
    }, 'Claude'));
  });

  test('R10 гейт выключен: НИ ОДНОЙ строки, байты и роли идентичны прогону под гейтом', () => {
    expect(DEBUG_API.on()).toBe(true);
    const on = runRawLive();
    expect(diagLines(on.lines, 'claude-role-network').length).toBe(2);

    window.sessionStorage.removeItem('aiCmDebug');
    window.__aiCmDebugLogs = false;
    expect(DEBUG_API.on()).toBe(false);

    const off = runRawLive();
    expect(off.lines.filter(function (l) { return l.indexOf(DIAG_PREFIX) === 0; })).toEqual([]);
    ROLE_MARKERS.forEach(function (tag) {
      expect(off.lines.filter(function (l) { return l.indexOf(tag) !== -1; })).toEqual([]);
    });

    // Байтовая идентичность: без гейта === под гейтом === оракул старой логики ролей.
    expect(off.md).toBe(on.md);
    expect(rolesOf(off.chain.rows)).toEqual(['user', 'assistant']);
    expect(off.chain.rows).toEqual(on.chain.rows);
    expect(off.md).toBe(oracleMdOldRoles({
      model: 'claude-sonnet-4-6', tokens: TOKENS, limit: LIMIT, percent: PERCENT, messages: off.chain.rows
    }, 'Claude'));
  });
});
