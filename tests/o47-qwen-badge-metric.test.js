/**
 * O-47 (badge-метрика Qwen): badge/pct Qwen считаются ТОЛЬКО эвристикой tokens~.
 *
 * КОРЕНЬ (спецификация владельца, 2026-09-25). У Qwen netServerTokens приходил из
 * `usage.input` SSE-стрима (core/qwen-intercept.js:emitSnapshot, detail.serverTokens) — это
 * КУМУЛИРОВАННОЕ сервисом потребление API (input текущего запроса + контекст на его стороне),
 * а НЕ размер текущего контекста диалога. Число растёт от хода к ходу, к кольцу/окну отношения
 * не имеет, поэтому в метрике оно ложно: живой замер — 1709 «токенов» на диалоге из двух
 * сообщений (B2-антипин ниже). У DeepSeek аналог (accumulated_token_usage) авторитетен по
 * решению O-23; у Gemini — счёт BYOK countTokens (O-35). Правило O-47 узкое: ТОЛЬКО Qwen.
 *
 * ПРАВИЛО.
 *   B1 — до обмена репликами (серверного usage ещё нет) badge показывает tokens~ (эвристика);
 *   B2 — после обмена репликами badge показывает tokens~, а НЕ netServerTokens (антипин:
 *        серверный счётчик принудительно подставлен в 1709 — метрика Qwen всё равно tokens~);
 *   B3 — после F5 badge показывает то же tokens~ (консистентно с B1/B2; снимок после F5
 *        серверного числа не несёт вовсе — ядро ingest'а `detail.serverTokens || 0` даёт 0);
 *   R1 — регресс: у DeepSeek серверный счётчик в метрике авторитетен (значение = serverTokens);
 *   R2 — регресс O-32 (GSA): канонический инвариант идентичности хода не тронут, а серверный
 *        счётчик не-Qwen сервисов правилом не задет.
 *
 * КОНСТРУКЦИЯ (R-D, без выдуманных чисел):
 *   • правило читается РЕАЛЬНОЙ функцией core/content.js:aiCmMetricServerTokens (исполняется);
 *   • вердикт бейджа считается РЕАЛЬНЫМИ байтами тернарника из core/content.js (берётся из
 *     источника регуляркой, исполняется через new Function) и РЕАЛЬНЫМ utils/tokenizer.js;
 *   • ingest снимка считается РЕАЛЬНОЙ строкой `netServerTokens = detail.serverTokens || 0;`.
 *   Так пины держат не пересказ, а те самые байты продакшна: правка любого из трёх звеньев
 *   (перехватчик → ingest → метрика) роняет соответствующий пин.
 *
 * НЕ ТРОГАЕТСЯ: OFF-зачистка O-7 (другой дефект), UX-авто-ON D-O41 (пины D-O41 пересмотра —
 * tests/d-o41-reasoning-auto-on.test.js), база/экспорт (от метрики не зависят).
 */

const fs = require('fs');
const path = require('path');
const Tokenizer = require('../utils/tokenizer.js');
const ModelConfig = require('../utils/model-config.js');
const Parser = require('../utils/google-search-folwr-parser.js');
const H = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = H.contentSource;
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'qwen-intercept.js'), 'utf8');
const WIDGET_SRC = fs.readFileSync(path.join(ROOT, 'core', 'widget.js'), 'utf8');

// =====================================================================================
// Рез по балансу фигурных скобок (конвенция сьюта).
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

// =====================================================================================
// Живой контекст Qwen (замер O-47): диалог из двух сообщений, серверный usage.input = 1709.
// =====================================================================================
const SERVER_TOKENS_LIVE = 1709;
const QUESTION = 'привет';
const ANSWER = 'Привет! Чем помочь?';
// Текст базы, по которому считается tokens~ (та же форма, что у снапшота перехватчика).
const BASE_TEXT = QUESTION + '\n' + ANSWER;
const BASE_COUNT = 2;

// =====================================================================================
// ЗВЕНО 1: правило метрики — РЕАЛЬНАЯ функция core/content.js (исполняется).
// =====================================================================================
function metricRule() {
  const decl = fnDecl(CONTENT, 'aiCmMetricServerTokens');
  const fn = new Function('netServerTokens', 'return (function () { ' + decl +
    '\n return aiCmMetricServerTokens; })();');
  return fn;
}
/** Правило по РЕАЛЬНЫМ байтам: (site, что приняли из снимка) → что идёт в метрику. */
function metricOf(site, ingestedServerTokens) {
  const make = metricRule();
  const call = make(ingestedServerTokens);
  return call(site);
}

// =====================================================================================
// ЗВЕНО 2: ingest снимка — РЕАЛЬНАЯ строка content.js (исполняется).
// =====================================================================================
const INGEST_LINE = 'netServerTokens = detail.serverTokens || 0;';
function ingestOf(detail) {
  const fn = new Function('detail', 'var netServerTokens = 0; ' + INGEST_LINE +
    ' return netServerTokens;');
  return fn(detail);
}

// =====================================================================================
// ЗВЕНО 3: вердикт бейджа — РЕАЛЬНЫЙ тернарник content.js (исполняется) + реальный Tokenizer.
// =====================================================================================
const DECISION_NEEDLE = 'metricServerTokens > 0 ? metricServerTokens : Tokenizer.estimateDialogTokens(fullText, countForTokens)';
const DECISION_RE = /metricServerTokens > 0 \? metricServerTokens : Tokenizer\.estimateDialogTokens\(fullText, countForTokens\)/;
const DECISION_SRC = (DECISION_RE.exec(CONTENT) || [])[0];
expect(DECISION_SRC).toBe(DECISION_NEEDLE);          // исполняем ровно байты продакшна
function badgeTokens(site, ingestedServerTokens, fullText, countForTokens) {
  const metric = metricOf(site, ingestedServerTokens);
  const decide = new Function('metricServerTokens', 'Tokenizer', 'fullText', 'countForTokens',
    'return (' + DECISION_SRC + ');');
  return decide(metric, Tokenizer, fullText, countForTokens);
}
/** tokens~ того же текста (эталон эвристики; то, чем обязан быть badge Qwen). */
function tokensTilde(fullText, countForTokens) {
  return Tokenizer.estimateDialogTokens(fullText, countForTokens);
}
/** pct бейджа — формула core/content.js, лимит берётся реальным ModelConfig. */
function pctOf(tokens, modelId) {
  const displayLimit = ModelConfig.computeDisplayLimit(modelId, null);
  return { pct: Math.round((tokens / displayLimit) * 1000) / 10, displayLimit: displayLimit };
}

const QWEN_MODEL = ModelConfig.getDefaultModel('qwen');

// =====================================================================================
// B1/B2/B3: Qwen — tokens~ во всех трёх состояниях
// =====================================================================================
describe('O-47 B: badge/pct Qwen — только tokens~ (эвристика) в состояниях B1/B2/B3', () => {
  test('B1 до обмена репликами: серверного usage нет → badge = tokens~', () => {
    // серверного числа в снимке нет вовсе (SSE ещё не было): ingest даёт 0
    expect(ingestOf({ text: BASE_TEXT, count: BASE_COUNT })).toBe(0);
    const tokens = badgeTokens('qwen', 0, BASE_TEXT, BASE_COUNT);
    expect(tokens).toBe(tokensTilde(BASE_TEXT, BASE_COUNT));      // эвристика, а не 0 и не сервер
    expect(tokens).toBeGreaterThan(0);
    // pct — производное ТОГО ЖЕ числа (формула бейджа × реальный лимит модели qwen3.8-max)
    const p = pctOf(tokens, QWEN_MODEL);
    expect(p.pct).toBe(Math.round((tokens / p.displayLimit) * 1000) / 10);
    // антипин B1: если бы метрика Qwen брала серверное число, pct был бы строго больше
    // (1709 «токенов» против tokens~ короткого диалога на том же лимите).
    const pServer = pctOf(SERVER_TOKENS_LIVE, QWEN_MODEL);
    expect(pServer.pct).toBeGreaterThan(p.pct);
  });

  test('B2 после обмена репликами: даже с серверным usage badge = tokens~ (не netServerTokens)', () => {
    // АНТИПИН: серверный счётчик принудительно подставлен (живой замер usage.input=1709) —
    // правило O-47 обязано его проигнорировать и остаться на эвристике того же текста.
    const tokens = badgeTokens('qwen', SERVER_TOKENS_LIVE, BASE_TEXT, BASE_COUNT);
    expect(tokens).toBe(tokensTilde(BASE_TEXT, BASE_COUNT));
    expect(tokens).not.toBe(SERVER_TOKENS_LIVE);
    expect(tokens).toBeLessThan(SERVER_TOKENS_LIVE);              // 1709 «токенов» на 2 сообщения — ложь
    // само правило: у Qwen метрический счётчик ВСЕГДА 0, у DeepSeek — принятое значение
    expect(metricOf('qwen', SERVER_TOKENS_LIVE)).toBe(0);
    expect(metricOf('deepseek', SERVER_TOKENS_LIVE)).toBe(SERVER_TOKENS_LIVE);
  });

  test('B3 после F5: badge = то же tokens~ (консистентно с B1/B2), снимок серверного числа не несёт', () => {
    // После F5 SSE-сессии нет: снимок приходит БЕЗ serverTokens (его не публикует перехватчик —
    // O-47), поэтому ingest честно даёт 0, а значение бейджа совпадает с B1/B2.
    expect(ingestOf({ text: BASE_TEXT, count: BASE_COUNT, messages: [{ role: 'user', text: QUESTION }, { role: 'assistant', text: ANSWER }] })).toBe(0);
    const b1 = badgeTokens('qwen', 0, BASE_TEXT, BASE_COUNT);
    const b2 = badgeTokens('qwen', SERVER_TOKENS_LIVE, BASE_TEXT, BASE_COUNT);
    const b3 = badgeTokens('qwen', ingestOf({ text: BASE_TEXT, count: BASE_COUNT }), BASE_TEXT, BASE_COUNT);
    expect(b1).toBe(b3);
    expect(b2).toBe(b3);
    expect(b3).toBe(tokensTilde(BASE_TEXT, BASE_COUNT));
  });

  test('source-пины трёх звеньев: перехватчик не публикует serverTokens, content берёт site-гейт', () => {
    // ЗВЕНО 1 (перехватчик): в литерале detail нет ПОЛЯ serverTokens (комментарии не считаем),
    // число осталось только в диагностике
    const iDetail = INTERCEPT_SRC.indexOf('var detail = {');
    expect(iDetail).toBeGreaterThan(-1);
    const iEnd = INTERCEPT_SRC.indexOf('};', iDetail);
    const detailLit = INTERCEPT_SRC.slice(iDetail, iEnd).replace(/\/\/[^\n]*/g, '');
    expect(detailLit).not.toContain('serverTokens');
    expect(INTERCEPT_SRC).toContain("serverTokens: serverTokens,");          // строки 'emit'/'qwen-sse'
    // ЗВЕНО 2 (ingest) — байты, которые исполняет пин выше
    expect(CONTENT).toContain(INGEST_LINE);
    // ЗВЕНО 3 (метрика): правило в ОДНОЙ функции, зовётся на ОБОИХ путях метрики
    expect(fnDecl(CONTENT, 'aiCmMetricServerTokens')).toContain("if (svc === 'qwen') return 0;");
    expect((CONTENT.split(DECISION_NEEDLE).length - 1)).toBe(2);            // processAndSend + GET_STATS
    const calls = CONTENT.match(/aiCmMetricServerTokens\(/g) || [];
    expect(calls.length).toBe(3);                                            // объявление + 2 пути метрики
    // авторитетная ветка бейджа и метка лога тоже читают метрику, а не сырое поле
    expect(CONTENT).toContain('if (metricServerTokens > 0) {');
    expect(CONTENT).toContain("(metricServerTokens > 0 ? ' · serverTokens' : '')");
    // диагностика qwen-badge печатает ОБА числа (ingest и метрику) — правило проверяемо в живом логе
    expect(CONTENT).toContain('metricServerTokens: (typeof metricServerTokens === \'number\') ? metricServerTokens : 0,');
  });

  test('два числа в живом логе qwen-badge: netServerTokens (ingest) ≠ metricServerTokens (Qwen)', () => {
    // Живой замер O-47 в формате строки: ingest=1709, метрика=0, pct — по tokens~.
    const diag = {
      event: 'badge-update',
      netServerTokens: ingestOf({ text: BASE_TEXT, count: BASE_COUNT, serverTokens: SERVER_TOKENS_LIVE }),
      metricServerTokens: metricOf('qwen', SERVER_TOKENS_LIVE),
      tokens: badgeTokens('qwen', SERVER_TOKENS_LIVE, BASE_TEXT, BASE_COUNT)
    };
    expect(diag.netServerTokens).toBe(SERVER_TOKENS_LIVE);
    expect(diag.metricServerTokens).toBe(0);
    expect(diag.tokens).toBe(tokensTilde(BASE_TEXT, BASE_COUNT));
  });
});

// =====================================================================================
// R1: регресс DeepSeek — серверный счётчик в метрике авторитетен (не изменён)
// =====================================================================================
describe('O-47 R1: регресс DeepSeek — badge по serverTokens (поведение O-23 не изменено)', () => {
  test('R1 DeepSeek: метрика = accepted serverTokens (0% отклонения), а не tokens~', () => {
    const server = 105217;                                   // P3 пары O-23 (большой payload)
    expect(metricOf('deepseek', server)).toBe(server);
    const tokens = badgeTokens('deepseek', server, BASE_TEXT, BASE_COUNT);
    expect(tokens).toBe(server);                             // бейдж DeepSeek авторитетен по server
    expect(tokens).not.toBe(tokensTilde(BASE_TEXT, BASE_COUNT));
    expect(Math.abs((tokens - server) / server)).toBe(0);
    // и ingest DeepSeek-снимка (accumulated_token_usage) не тронут: поле доезжает как есть
    expect(ingestOf({ text: BASE_TEXT, count: BASE_COUNT, serverTokens: server })).toBe(server);
  });

  test('R1 правило site-узкое: ни один не-Qwen сервис не потерял серверный счётчик', () => {
    ['deepseek', 'gemini', 'aistudio', 'chatgpt', 'claude', 'perplexity', 'google_search', '']
      .forEach(function (site) {
        expect([site, metricOf(site, 4096)]).toEqual([site, 4096]);
      });
    // адаптера/сервиса нет вовсе (срез-песочницы) → прежнее поведение: счётчик как приняли
    expect(metricOf(undefined, 4096)).toBe(4096);
    // нет серверного числа — метрика не выдумывает (0 → путь tokens~)
    expect(metricOf('deepseek', 0)).toBe(0);
    expect(metricOf('qwen', 0)).toBe(0);
  });
});

// =====================================================================================
// R2: регресс O-32 (GSA) — канонический инвариант идентичности не тронут
// =====================================================================================
describe('O-47 R2: регресс O-32 — каноническая идентичность хода GSA не затронута', () => {
  const TURNS = [
    { q: 'Наши Python скрипт для вычисления факториала N-го числа Фибоначчи', a: 'Ответ в режиме ИИ, исходный запрос: "Наши Python скрипт для вычисления факториала N-го числа Фибоначчи" Вот код.' },
    { q: 'Напиши рекурсивный код, а потом индуктивный.', a: 'Ответ в режиме ИИ, исходный запрос: "Напиши рекурсивный код, а потом индуктивный." Оба варианта.' }
  ];

  test('R2 канонический ключ хода не зависит от формы пути (DOM-обёртка = сеть)', () => {
    // Инвариант O-32 (tests/o32-gsa-canonical-thread-invariant.test.js): ключ выводится из
    // СОДЕРЖИМОГО. Здесь он пересчитывается на тех же двух формах — O-47 его не касается.
    const keys = TURNS.map(function (t) {
      const domForm = Parser.canonicalTurnKeyOf({ id: 'x', userText: null, assistantText: t.a });
      const netForm = Parser.canonicalTurnKeyOf({ id: 'y', userText: t.q, assistantText: Parser.canonicalAnswerBody(t.a) });
      expect(netForm).toBe(domForm);
      return domForm;
    });
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('R2 GSA: серверный счётчик канонической базы (BYOK countTokens) в метрике авторитетен', () => {
    // Живой эталон O-32: тред A = 5658 токенов при 6 сообщениях (каноническая идентичность).
    const canonicalTokens = 5658;
    expect(metricOf('google_search', canonicalTokens)).toBe(canonicalTokens);
    expect(badgeTokens('google_search', canonicalTokens, BASE_TEXT, BASE_COUNT)).toBe(canonicalTokens);
    // правило метрики не читает ни каноническую базу, ни threadId — идентичность ему недоступна
    const decl = fnDecl(CONTENT, 'aiCmMetricServerTokens');
    expect(decl).not.toContain('threadId');
    expect(decl).not.toContain('canonical');
    expect(decl).not.toContain('baseText');
    expect(decl).toContain('netServerTokens');
  });

  test('R2 O-32/O-35 не переписаны: канонический хелпер и виджет на месте', () => {
    expect(typeof Parser.canonicalTurnKeyOf).toBe('function');
    expect(typeof Parser.canonicalAnswerBody).toBe('function');
    // виджет по-прежнему рисует число, которое ему отдала метрика (O-35: подпись updateWidget не менялась)
    expect(WIDGET_SRC).toContain('updateWidget(percentage, tokens, effectiveLimit, contextLimit, displayLimit, modelName, attachBreak)');
  });
});
