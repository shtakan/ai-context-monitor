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
 * того текста, для которого получено. Латч — тройка
 * lastCountTokensText/lastCountTokensCache/lastCountTokensConvId
 * (пишется ТОЛЬКО успешным ответом API либо восстановлением из chrome.storage.local;
 * чистится сменой чата в core/widget.js, сменой ключа в aiCmByokKeyInvalidate и ошибкой
 * countTokens — иначе бейдж «замёрз» бы на последнем точном числе при исчерпанной квоте).
 *   S1 — латч совпал и ingest обнулил netServerTokens → метрика = точные токены API;
 *   S2 — латч совпал при живом серверном счётчике → всё равно точные токены API;
 *   S3 — текст сменился (новый сетевой ход) → метрики от API нет, эвристика снова допустима;
 *   S4 — exactCount выключен / нет ключа / кеш 0 → эвристика, как раньше;
 *   S5 — Qwen: site-гейт O-47 главнее, даже при совпавшем латче (правило Qwen не тронуто);
 *   S6 — source-пины: ОБА пути метрики (processAndSend и GET_STATS) передают текст, а
 *        displayTokens попапа уважает точный счётчик (иначе попап расходится с бейджем).
 *
 * ШАГИ 1-3 (24-10, гонка «эвристика vs API») — пины ниже:
 *   S7 — Шаг 2: ответ API получен для ТЕКУЩЕГО convId → другой текст ТОГО ЖЕ чата
 *        эвристикой не перезаписывается (авторитет = чат, а не строка текста);
 *   S8 — Шаг 2: авторитет НЕ перетекает в другой чат (чужой convId → эвристика);
 *   S9 — Шаг 2: ошибка API снимает авторитет (source-пин ветки ошибки);
 *   S10 — Шаг 1: гейт baseComplete у вызова requestExactTokens снят (source-пин);
 *   S11 — Шаг 3: подстановки прошлого lastCountTokensCache в общий счётчик больше нет.
 *
 * ШАГ 4 (фикс «скачка» бейджа при BYOK, живой лог 18:51:40: 25.9% → 23.1%) — пины ниже:
 *   Корень: кэш countTokens для чата ещё не восстановлен (или это другой чат), ответ API в пути —
 *   и проход считал метрику эвристикой Tokenizer.estimateDialogTokens (33162), а через 1.4 с
 *   приходило точное 29517. Правило aiCmHeuristicHoldForByok: BYOK включён + ключ есть + точного
 *   числа для ЭТОГО текста нет → эвристика не двигает maxTokenCount/percentage и не зовёт
 *   updateWidget. Без ключа / вне списка сервисов / при отказе API эвристика работает как раньше.
 *   S12 — правило исполняется реальными байтами (держание on/off по всем веткам);
 *   S13 — в processAndSend ветка держания стоит ДО эвристики и ничего не пишет в бейдж;
 *   S14 — успех/отказ countTokens управляют держанием, сброс чата чистит отметку отказа.
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
 * Шаг 2: lastCountTokensConvId + getCurrentConvId добавлены параметрами — иначе typeof-гарды
 * в aiCmExactTokensFor гасят авторитет (песочница без объявлений контура).
 */
function buildMetric(opts) {
  const withLatch = opts.withLatch !== false;
  const src = (withLatch ? fnDecl(CONTENT, 'aiCmExactTokensFor') + '\n' : '') +
              fnDecl(CONTENT, 'aiCmMetricServerTokens');
  const factory = new Function(
    'exactCountEnabled', 'geminiApiKey', 'lastCountTokensText', 'lastCountTokensCache', 'netServerTokens',
    'lastCountTokensConvId', 'getCurrentConvId',
    src + '\nreturn aiCmMetricServerTokens;'
  );
  return factory(
    opts.exactCountEnabled !== undefined ? opts.exactCountEnabled : true,
    opts.geminiApiKey !== undefined ? opts.geminiApiKey : 'AIza-test-key',
    opts.lastCountTokensText !== undefined ? opts.lastCountTokensText : 'ДИАЛОГ-1',
    opts.lastCountTokensCache !== undefined ? opts.lastCountTokensCache : 1234,
    opts.netServerTokens !== undefined ? opts.netServerTokens : 0,
    opts.lastCountTokensConvId !== undefined ? opts.lastCountTokensConvId : '',
    typeof opts.getCurrentConvId === 'function' ? opts.getCurrentConvId : function () { return ''; }
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

  test('S7 (Шаг 2): ответ API для текущего convId не перебивается эвристикой на новом тексте', () => {
    // Тот же чат: точное число получено для 'ДИАЛОГ-1', а метрика спрашивается уже для
    // 'ДИАЛОГ-2' (DOM-хвост / неполный снимок). До Шага 2 здесь была эвристика → бейдж
    // «прыгал» с точного числа на tokens~ на каждом проходе.
    const metric = buildMetric({
      netServerTokens: 0,
      lastCountTokensText: 'ДИАЛОГ-1',
      lastCountTokensCache: 1234,
      lastCountTokensConvId: 'conv-A',
      getCurrentConvId: function () { return 'conv-A'; }
    });
    expect(metric('gemini', 'ДИАЛОГ-2')).toBe(1234);
    expect(metric('aistudio', 'ДИАЛОГ-2 + хвост')).toBe(1234);
  });

  test('S8 (Шаг 2): авторитет точного числа не перетекает в другой чат', () => {
    const metric = buildMetric({
      lastCountTokensText: 'ДИАЛОГ-1',
      lastCountTokensCache: 1234,
      lastCountTokensConvId: 'conv-A',
      getCurrentConvId: function () { return 'conv-B'; }
    });
    expect(metric('gemini', 'ДИАЛОГ-2')).toBe(0);
    // и при пустом convId/снятом латче (ошибка API) эвристика снова допустима
    expect(buildMetric({ lastCountTokensText: 'ДИАЛОГ-1', lastCountTokensConvId: '' })('gemini', 'ДИАЛОГ-2')).toBe(0);
  });

  test('S9 (Шаг 2): ошибка countTokens снимает авторитет convId (source-пин ветки ошибки)', () => {
    const req = fnDecl(CONTENT, 'requestExactTokens');
    // успех ставит авторитет, ошибка — снимает (иначе число «замёрзло» бы при квоте/сети)
    expect(req).toContain("lastCountTokensConvId = getCurrentConvId() || '';");
    expect(req).toContain("lastCountTokensConvId = '';");
    const errIdx = req.indexOf("aiCmDiagWarn('content:requestExactTokens'");
    expect(errIdx).toBeGreaterThan(-1);
    expect(req.indexOf("lastCountTokensConvId = '';", errIdx)).toBeGreaterThan(errIdx);
    // восстановление из chrome.storage.local тоже ставит авторитет текущего чата
    expect(CONTENT).toContain('lastCountTokensConvId = currentConvId;');
  });

  test('S10 (Шаг 1): гейт baseComplete у вызова requestExactTokens снят', () => {
    expect(CONTENT).toContain('if (isGeminiSvc && exactCountEnabled && geminiApiKey && fullText) {');
    expect(CONTENT).not.toContain('exactCountEnabled && geminiApiKey && fullText && baseComplete');
    const call = CONTENT.indexOf('if (isGeminiSvc && exactCountEnabled && geminiApiKey && fullText) {');
    expect(CONTENT.indexOf('requestExactTokens(fullText, modelId);', call)).toBeGreaterThan(call);
    // точка входа гейтится только по сервису/настройке/ключу/тексту — baseComplete в гейте нет
    // (диагностическая строка [byok-src] печатает baseComplete, но ничего не решает)
    const req = fnDecl(CONTENT, 'requestExactTokens');
    expect(req).not.toContain('&& baseComplete');
    expect(req).toContain("[byok-src] baseComplete=' + baseComplete");
  });

  test('S11 (Шаг 3): прошлое точное значение больше НЕ подставляется в netServerTokens', () => {
    const reqRaw = fnDecl(CONTENT, 'requestExactTokens');
    // код без комментариев — иначе считались бы упоминания в пояснении фикса
    const req = reqRaw.split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n');
    // фатальный «заполнитель» прошлого текста/чата удалён
    expect(req).not.toMatch(/if \(lastCountTokensCache > 0\) \{\s*netServerTokens = lastCountTokensCache;/);
    expect(reqRaw).not.toContain('показываем последнее точное значение как заполнитель');
    expect(reqRaw).toContain('Шаг 3 (фикс «заполнителя»)');
    // подстановка кэша осталась только в ветке «текст не изменился» (корректный латч)
    // и в ветке ошибки для того же текста — обе про ТЕКУЩИЙ текст, не про прошлый чат
    expect(req.split('netServerTokens = lastCountTokensCache;').length - 1).toBe(2);
  });
});

// =====================================================================================
// Шаг 4: держание бейджа при BYOK — эвристика не пишет, пока нет точного числа
// =====================================================================================

/**
 * Исполняет РЕАЛЬНЫЕ aiCmHeuristicHoldForByok + aiCmExactTokensFor (реальный латч, не заглушка)
 * в песочнице контента. Свободные переменные контура переданы параметрами фабрики — та же
 * конвенция, что у buildMetric (typeof-гарды в исходнике молчат без соседних объявлений).
 */
function buildHold(opts) {
  const o = opts || {};
  const src = fnDecl(CONTENT, 'aiCmExactTokensFor') + '\n' + fnDecl(CONTENT, 'aiCmHeuristicHoldForByok');
  const factory = new Function(
    'exactCountEnabled', 'geminiApiKey', 'lastCountTokensText', 'lastCountTokensCache',
    'lastCountTokensConvId', 'lastCountTokensErrorText', 'getCurrentConvId', 'isExtensionValid',
    src + '\nreturn aiCmHeuristicHoldForByok;'
  );
  return factory(
    o.exactCountEnabled !== undefined ? o.exactCountEnabled : true,
    o.geminiApiKey !== undefined ? o.geminiApiKey : 'AIza-test-key',
    o.lastCountTokensText !== undefined ? o.lastCountTokensText : '',
    o.lastCountTokensCache !== undefined ? o.lastCountTokensCache : 0,
    o.lastCountTokensConvId !== undefined ? o.lastCountTokensConvId : '',
    o.lastCountTokensErrorText !== undefined ? o.lastCountTokensErrorText : '',
    typeof o.getCurrentConvId === 'function' ? o.getCurrentConvId : function () { return ''; },
    typeof o.isExtensionValid === 'function' ? o.isExtensionValid : function () { return true; }
  );
}

/** Тело ветки else-if/if по индексу начала условия (баланс фигурных скобок). */
function branchBody(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced branch at ' + startIdx);
}

describe('Шаг 4: при BYOK без точного числа эвристика не пишет бейдж', () => {
  test('S12: держание включается ровно в дыре «BYOK есть, точного числа нет»', () => {
    // Главный кейс живого лога: ключ и флаг включены, кэша для чата нет (loadByokCache вышел
    // рано при пустом convId), ответ countTokens ещё в пути → бейдж держим (было: 25.9%).
    const hold = buildHold({ lastCountTokensText: '', lastCountTokensCache: 0 });
    expect(hold('gemini', 'ДИАЛОГ-НОВЫЙ')).toBe(true);
    expect(hold('aistudio', 'ДИАЛОГ-НОВЫЙ')).toBe(true);
    expect(hold('google_search', 'ДИАЛОГ-НОВЫЙ')).toBe(true);
    // Латч есть, но относится к ДРУГОМУ чату/тексту (S8) → точного числа для этого текста нет.
    expect(buildHold({
      lastCountTokensText: 'ДИАЛОГ-1', lastCountTokensCache: 1234, lastCountTokensConvId: 'conv-A',
      getCurrentConvId: function () { return 'conv-B'; }
    })('gemini', 'ДИАЛОГ-2')).toBe(true);
  });

  test('S12b: точное число для текста есть → держания нет (точные байты авторитетны)', () => {
    expect(buildHold({ lastCountTokensText: 'ДИАЛОГ-1', lastCountTokensCache: 1234 })('gemini', 'ДИАЛОГ-1')).toBe(false);
    // латч того же чата (Шаг 2) — тоже точное значение, держать нечего
    expect(buildHold({
      lastCountTokensText: 'ДИАЛОГ-1', lastCountTokensCache: 1234, lastCountTokensConvId: 'conv-A',
      getCurrentConvId: function () { return 'conv-A'; }
    })('gemini', 'ДИАЛОГ-2')).toBe(false);
  });

  test('S12c: без ключа/флага, вне списка сервисов и после отказа API эвристика живёт', () => {
    expect(buildHold({ exactCountEnabled: false })('gemini', 'ДИАЛОГ-1')).toBe(false);
    expect(buildHold({ geminiApiKey: '' })('gemini', 'ДИАЛОГ-1')).toBe(false);
    ['qwen', 'chatgpt', 'deepseek', 'claude', 'perplexity'].forEach(function (site) {
      expect([site, buildHold({})(site, 'ДИАЛОГ-1')]).toEqual([site, false]);
    });
    // пустой текст и недействительный контекст расширения — держать нечего
    expect(buildHold({})('gemini', '')).toBe(false);
    expect(buildHold({ isExtensionValid: function () { return false; } })('gemini', 'ДИАЛОГ-1')).toBe(false);
    // Отказ countTokens для ЭТОГО текста снимает держание (иначе «замёрзший» бейдж при квоте).
    expect(buildHold({ lastCountTokensErrorText: 'ДИАЛОГ-1' })('gemini', 'ДИАЛОГ-1')).toBe(false);
    // ...но не распространяется на другой текст: там ждём свой ответ API
    expect(buildHold({ lastCountTokensErrorText: 'ДИАЛОГ-1' })('gemini', 'ДИАЛОГ-2')).toBe(true);
  });

  test('S13: ветка держания в processAndSend стоит ДО эвристики и не пишет в бейдж', () => {
    const draw = fnDecl(CONTENT, 'processAndSend');
    const GATE = 'const byokHeuristicHold = aiCmHeuristicHoldForByok(svc, fullText);';
    expect(draw).toContain(GATE);
    const iGate = draw.indexOf(GATE);
    // ровно две ветки держания: максимум (метрика) и отрисовка (updateWidget)
    expect(CONTENT.split('} else if (byokHeuristicHold) {').length - 1).toBe(2);
    const iMetricHold = draw.indexOf('} else if (byokHeuristicHold) {', iGate);
    expect(iMetricHold).toBeGreaterThan(iGate);
    const metricHold = branchBody(draw, iMetricHold);
    // код ветки без комментариев: иначе считались бы упоминания в пояснении фикса
    const metricHoldCode = metricHold.split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n');
    expect(metricHoldCode).not.toContain('maxTokenCount');       // эвристика максимум не двигает
    expect(metricHoldCode).not.toContain('tokenEstimate =');
    // эвристические ветви максимума (baseComplete/useMonotonic/else) остались ПОСЛЕ держания
    expect(draw.indexOf('} else if (baseComplete === true) {', iMetricHold)).toBeGreaterThan(iMetricHold);
    expect(draw.indexOf('const percentage = displayLimit', iMetricHold)).toBeGreaterThan(iMetricHold);
    // ветка отрисовки: после щита O-1 и до updateWidget, без единой записи в виджет
    const iDrawHold = draw.indexOf('} else if (byokHeuristicHold) {', iMetricHold + 1);
    expect(iDrawHold).toBeGreaterThan(draw.indexOf('} else if (aiCmBadgeHoldActive()) {'));
    const drawHold = branchBody(draw, iDrawHold);
    const drawHoldCode = drawHold.split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n');
    expect(drawHoldCode).not.toContain('updateWidget');
    expect(drawHoldCode).not.toContain('lastWidgetData');
    expect(draw.indexOf('updateWidget(percentage, maxTokenCount, effectiveLimit')).toBeGreaterThan(iDrawHold);
    expect(draw.indexOf('maybeAutoExport(percentage);')).toBeGreaterThan(iDrawHold);
  });

  test('S14: успех/отказ countTokens управляют держанием, сброс чата чистит отметку', () => {
    const req = fnDecl(CONTENT, 'requestExactTokens');
    const iErr = req.indexOf("aiCmDiagWarn('content:requestExactTokens'");
    expect(iErr).toBeGreaterThan(-1);
    // отказ помечает ИМЕННО этот текст — держание снимается (ветка фолбэка на эвристику)
    expect(req.indexOf('lastCountTokensErrorText = fullText;', iErr)).toBeGreaterThan(iErr);
    // успех стирает отметку (выше ветки ошибки) — держание для текста кончилось
    const iClear = req.indexOf("lastCountTokensErrorText = '';");
    expect(iClear).toBeGreaterThan(-1);
    expect(iClear).toBeLessThan(iErr);
    expect(req.slice(req.indexOf('lastCountTokensCache = response.totalTokens;'), iErr)).toContain("lastCountTokensErrorText = '';");
    // сброс чата и смена ключа/настроек не оставляют отметку прошлого текста
    expect(H.moduleSource('widget.js')).toContain("lastCountTokensErrorText = '';");
    expect(H.moduleSource('state.js')).toContain('let lastCountTokensErrorText');
    expect(CONTENT.split("lastCountTokensErrorText = '';").length - 1).toBeGreaterThanOrEqual(3);
  });
});

