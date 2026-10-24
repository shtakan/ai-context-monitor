/**
 * Шаг 3 (BYOK-приоритет): точное значение API countTokens приоритетнее эвристики tokens~.
 *
 * КОРЕНЬ ДЕФЕКТА (по коду, без выдуманных замеров). `netServerTokens` — ОБЩИЙ сетевой
 * счётчик: ingest пишет его безусловно (`netServerTokens = detail.serverTokens || 0;`,
 * core/content.js). У Gemini/AI Studio серверного поля нет → ingest обнуляет счётчик, в
 * котором лежало точное число BYOK. Восстановить его в том же проходе может только
 * requestExactTokens, а он под гейтом `baseComplete` в processAndSend. На НЕПОЛНОМ снимке
 * (пагинация, переэмит historyComplete=false) точное значение уже стёрто, API не
 * спрашивается — и aiCmMetricServerTokens возвращал 0, из-за чего badge и pct попапа
 * перезаписывались оценкой Tokenizer.estimateDialogTokens (tokens~). Точный счёт «прыгал»
 * назад к эвристике.
 *
 * ПРАВИЛО. countTokens зависит только от текста, поэтому точное число верно ровно для
 * того текста, для которого получено. Латч — пара lastCountTokensText/lastCountTokensCache
 * (пишется ТОЛЬКО успешным ответом API либо восстановлением из chrome.storage.local;
 * чистится сменой чата в core/widget.js и сменой ключа в aiCmByokKeyInvalidate).
 *   S1 — латч совпал и ingest обнулил netServerTokens → метрика = точные токены API;
 *   S2 — латч совпал при живом серверном счётчике → всё равно точные токены API;
 *   S3 — текст сменился (новый сетевой ход) → метрики от API нет, эвристика снова допустима;
 *   S4 — exactCount выключен / нет ключа / кеш 0 → эвристика, как раньше;
 *   S5 — Qwen: site-гейт O-47 главнее, даже при совпавшем латче (правило Qwen не тронуто);
 *   S6 — source-пины: ОБА пути метрики (processAndSend и GET_STATS) передают текст, а
 *        displayTokens попапа уважает точный счётчик (иначе попап расходится с бейджем).
 *
 * КОНСТРУКЦИЯ: правила исполняются РЕАЛЬНЫМИ байтами core/content.js (срез по имени +
 * new Function), а не пересказом.
 */

const H = require('./helpers/content-source.js');

const CONTENT = H.contentSource;

/** Срез объявления по балансу фигурных скобок (конвенция сьюта). */
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

/**
 * Исполняет реальные aiCmMetricServerTokens (и aiCmExactTokensFor, если он есть в срезе)
 * в песочнице контента: свободные переменные — параметры фабрики.
 */
function buildMetric(opts) {
  const withLatch = opts.withLatch !== false;
  const src = (withLatch ? fnDecl(CONTENT, 'aiCmExactTokensFor') + '\n' : '') +
              fnDecl(CONTENT, 'aiCmMetricServerTokens');
  const factory = new Function(
    'exactCountEnabled', 'geminiApiKey', 'lastCountTokensText', 'lastCountTokensCache', 'netServerTokens',
    src + '\nreturn aiCmMetricServerTokens;'
  );
  return factory(
    opts.exactCountEnabled !== undefined ? opts.exactCountEnabled : true,
    opts.geminiApiKey !== undefined ? opts.geminiApiKey : 'AIza-test-key',
    opts.lastCountTokensText !== undefined ? opts.lastCountTokensText : 'ДИАЛОГ-1',
    opts.lastCountTokensCache !== undefined ? opts.lastCountTokensCache : 1234,
    opts.netServerTokens !== undefined ? opts.netServerTokens : 0
  );
}

describe('Шаг 3: точный ответ API countTokens приоритетнее эвристики tokens~', () => {
  test('S1: латч переживает обнуление netServerTokens ingest-ом (главный дефект)', () => {
    const metric = buildMetric({ netServerTokens: 0 });
    // До правки здесь было 0 → метрика уходила на Tokenizer.estimateDialogTokens.
    expect(metric('gemini', 'ДИАЛОГ-1')).toBe(1234);
    // Контроль «до правки»: та же песочница БЕЗ aiCmExactTokensFor (typeof-гард) даёт эвристику.
    const legacy = buildMetric({ netServerTokens: 0, withLatch: false });
    expect(legacy('gemini', 'ДИАЛОГ-1')).toBe(0);
  });

  test('S2: точное значение API авторитетнее живого серверного счётчика', () => {
    const metric = buildMetric({ netServerTokens: 777, lastCountTokensCache: 987 });
    expect(metric('aistudio', 'ДИАЛОГ-1')).toBe(987);
  });

  test('S3: сменился текст (новый сетевой ход) — точного значения для него нет', () => {
    const metric = buildMetric({ netServerTokens: 0, lastCountTokensText: 'ДИАЛОГ-1' });
    expect(metric('gemini', 'ДИАЛОГ-2')).toBe(0);
  });

  test('S4: нет точного счёта (off / нет ключа / пустой кеш) — эвристика', () => {
    expect(buildMetric({ exactCountEnabled: false })('gemini', 'ДИАЛОГ-1')).toBe(0);
    expect(buildMetric({ geminiApiKey: '' })('gemini', 'ДИАЛОГ-1')).toBe(0);
    expect(buildMetric({ lastCountTokensCache: 0 })('gemini', 'ДИАЛОГ-1')).toBe(0);
    expect(buildMetric({ lastCountTokensCache: -5 })('gemini', 'ДИАЛОГ-1')).toBe(0);
  });

  test('S5: Qwen — site-гейт O-47 главнее латча', () => {
    const metric = buildMetric({ lastCountTokensCache: 5555 });
    expect(metric('qwen', 'ДИАЛОГ-1')).toBe(0);
  });

  test('S6: source-пины — оба пути метрики передают текст, попап уважает точный счётчик', () => {
    // 1 объявление + 2 вызова на ОБОИХ путях метрики (processAndSend и GET_STATS).
    expect(CONTENT.split('aiCmMetricServerTokens(').length - 1).toBe(3);
    expect(CONTENT).toContain('aiCmMetricServerTokens(svc, fullText)');
    expect(CONTENT).toContain('aiCmMetricServerTokens(currentAdapter.siteName, fullText)');
    // Попап: при точном счётчике монотонный max() эвристики его не поднимает.
    expect(CONTENT).toContain(
      'const displayTokens = metricServerTokens > 0 ? tokenEstimate : Math.max(tokenEstimate, maxTokenCount);'
    );
  });
});
