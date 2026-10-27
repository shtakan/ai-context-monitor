'use strict';

/**
 * AI Studio: нативное число токенов промпта из шапки чата (v2.0.32).
 *
 * ЗАЧЕМ. AI Studio рядом с названием чата показывает СВОЁ число токенов промпта
 * («9,637 tokens» в живом замере). Оно включает то, чего в DOM реплик нет вообще:
 * системные инструкции/шаблон промпта, схемы включённых инструментов (Grounding with
 * Google Search, Code execution) и всю историю. Наша эвристика видит только реплики —
 * в том же чате это 1 560 токенов, то есть в шесть раз меньше шапки, и бейдж расходился
 * с самой студией. Поэтому при наличии шапки бейдж берёт её число.
 *
 * ЧТО ТЕСТИРУЕТСЯ. Вырезанный из core/content.js участок от `var AI_CM_AISTUDIO_TOKENS_LABELS`
 * до конца aiCmAistudioNativeProbe: разбор числа, поиск пары «число + метка» в блоке
 * заголовка, фолбэк по тексту «N tokens», защита от длинных блоков (лента реплик),
 * троттлинг (processAndSend зовётся на каждую мутацию) и гейт по хосту.
 */

const fs = require('fs');
const path = require('path');

const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'content.js'), 'utf8');
const START_MARK = 'var AI_CM_AISTUDIO_TOKENS_LABELS';
const END_TEXT = '* AI Studio: кэш разобранной истории';

function extractSection() {
  const from = CONTENT_SRC.indexOf(START_MARK);
  if (from < 0) throw new Error('native tokens section not found in core/content.js');
  const endText = CONTENT_SRC.indexOf(END_TEXT, from);
  if (endText < 0) throw new Error('end of native tokens section not found');
  // Режем перед открывающим комментарием следующего раздела (иначе остался бы незакрытый /*).
  const to = CONTENT_SRC.lastIndexOf('/*', endText);
  return CONTENT_SRC.slice(from, to);
}

const SECTION = extractSection();

/** Часы, которыми можно управлять из теста (троттлинг 400 мс). */
function makeClock(start) {
  let now = start || 1000;
  return {
    now: function () { return now; },
    tick: function (ms) { now += ms; }
  };
}

/**
 * Загрузить срез: window/document подменяются, гейт хоста — заглушка,
 * Date — управляемые часы (только now(), больше срез ничего не читает).
 */
function loadNative(options) {
  const opts = options || {};
  const clock = opts.clock || makeClock();
  const factory = new Function(
    'window', 'document', 'swallowSoft', 'aiCmIsAistudioHost', 'Date',
    SECTION + '\nreturn {' +
    ' parseCount: aiCmAistudioParseCount,' +
    ' inBox: aiCmAistudioTokensInBox,' +
    ' native: aiCmAistudioNativePromptTokens,' +
    ' probe: aiCmAistudioNativeProbe' +
    ' };'
  );
  const doc = opts.document || document;
  const win = { location: { hostname: 'aistudio.google.com' } };
  const host = opts.isAistudio === undefined ? true : opts.isAistudio;
  return factory(
    win,
    doc,
    function () { },
    function () { return host; },
    { now: clock.now }
  );
}

/** Шапка чата: <h1> название + блок счётчика рядом. */
function header(countText, labelText) {
  return '<div id="hdr"><h1>Copy of Возможности Google AI Studio</h1>' +
    '<div class="count"><span>' + countText + '</span><span>' + labelText + '</span></div></div>';
}

describe('content.js: нативный счётчик токенов AI Studio — разбор числа', () => {
  const api = loadNative();

  test('группировка тысяч через запятую/точку/пробел', () => {
    expect(api.parseCount('9,637')).toBe(9637);
    expect(api.parseCount('9 637')).toBe(9637);
    expect(api.parseCount('1.234.567')).toBe(1234567);
    expect(api.parseCount('636')).toBe(636);
  });

  test('проценты, мусор и нечисла — 0 (иначе в токены попал бы процент)', () => {
    expect(api.parseCount('1.2')).toBe(0);
    expect(api.parseCount('0,5')).toBe(0);
    expect(api.parseCount('')).toBe(0);
    expect(api.parseCount(null)).toBe(0);
    expect(api.parseCount('12abc')).toBe(0);
    expect(api.parseCount('0')).toBe(0);
  });
});

describe('content.js: нативный счётчик токенов AI Studio — поиск в шапке', () => {
  test('пара «число + метка» в блоке заголовка → число шапки', () => {
    document.body.innerHTML = header('9,637', ' tokens ');
    const api = loadNative();
    expect(api.probe()).toBe(9637);
    expect(api.native()).toBe(9637);
  });

  test('русская локаль: «9 637 токенов»', () => {
    document.body.innerHTML = header('9 637', 'токенов');
    expect(loadNative().probe()).toBe(9637);
  });

  test('число и метка одним текстом («9,637 tokens») — фолбэк по регулярке', () => {
    document.body.innerHTML =
      '<div id="hdr"><h1>Чат</h1><div><span>9,637 tokens</span></div></div>';
    expect(loadNative().probe()).toBe(9637);
  });

  test('нет шапки (нет h1) → 0: бейдж остаётся на прежнем пути', () => {
    document.body.innerHTML = '<ms-cmark-node class="cmark-node v3-font-body">привет</ms-cmark-node>';
    const api = loadNative();
    expect(api.probe()).toBe(0);
    expect(api.native()).toBe(0);
  });

  test('длинный блок (лента реплик) не считается шапкой', () => {
    // «tokens» и число рядом есть, но блок — вся лента (>4000 символов) → не шапка.
    const long = new Array(1600).join('слово ');
    document.body.innerHTML =
      '<div id="wrap"><div id="hdr"><h1>Чат</h1></div><p>' + long + '</p>' +
      '<div><span>9,637</span><span>tokens</span></div></div>';
    expect(loadNative().probe()).toBe(0);
  });

  test('проценты рядом с меткой не принимаются за токены', () => {
    document.body.innerHTML = header('1.2', 'tokens');
    expect(loadNative().probe()).toBe(0);
  });

  test('не AI Studio → 0 (гейт по хосту)', () => {
    document.body.innerHTML = header('9,637', 'tokens');
    expect(loadNative({ isAistudio: false }).native()).toBe(0);
  });
});

describe('content.js: нативный счётчик токенов AI Studio — троттлинг', () => {
  test('повторный вызов в пределах 400 мс отдаёт кэш, после — свежее значение', () => {
    document.body.innerHTML = header('1,234', 'tokens');
    const clock = makeClock(5000);
    const api = loadNative({ clock: clock });
    expect(api.native()).toBe(1234);

    // Шапка выросла: сеть добавила ходы, студия пересчитала счётчик.
    document.body.innerHTML = header('9,637', 'tokens');
    expect(api.native()).toBe(1234); // троттлинг: ещё не истёк интервал

    clock.tick(401);
    expect(api.native()).toBe(9637); // интервал истёк — читаем заново
  });
});

/* ------------------------------------------------------------------ *
 * Метрика: шапка чата — только для AI Studio (m00455: другие
 * адаптеры не должны измениться)
 * ------------------------------------------------------------------ */

/** Вырезать функцию из core/content.js по балансу фигурных скобок. */
function extractFunction(name) {
  const head = 'function ' + name + '(';
  const from = CONTENT_SRC.indexOf(head);
  if (from < 0) throw new Error('function not found: ' + name);
  const open = CONTENT_SRC.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < CONTENT_SRC.length; i++) {
    if (CONTENT_SRC[i] === '{') depth++;
    else if (CONTENT_SRC[i] === '}') {
      depth--;
      if (depth === 0) return CONTENT_SRC.slice(from, i + 1);
    }
  }
  throw new Error('unbalanced function: ' + name);
}

const METRIC_FN = extractFunction('aiCmMetricServerTokens');

/** Прогон настоящей aiCmMetricServerTokens с подставным нативным счётчиком. */
function runMetric(svc, options) {
  const opts = options || {};
  const factory = new Function(
    'netServerTokens', 'aiCmExactTokensFor', 'aiCmAistudioNativePromptTokens',
    METRIC_FN + '\nreturn aiCmMetricServerTokens;'
  );
  return factory(
    typeof opts.netServerTokens === 'number' ? opts.netServerTokens : 0,
    function () { return opts.exact || 0; },
    function () { return opts.native || 0; }
  )(svc, 'текст диалога');
}

describe('content.js: aiCmMetricServerTokens — шапка AI Studio', () => {
  test('aistudio: число шапки главнее сетевого счётчика', () => {
    expect(runMetric('aistudio', { native: 9637, netServerTokens: 486 })).toBe(9637);
  });

  test('aistudio без шапки — прежний путь (сеть, затем BYOK-ответ)', () => {
    expect(runMetric('aistudio', { native: 0, netServerTokens: 486 })).toBe(486);
    expect(runMetric('aistudio', { native: 0, netServerTokens: 0, exact: 777 })).toBe(777);
  });

  test('другие сервисы шапку не читают (m00455): остаётся их прежний приоритет', () => {
    ['gemini', 'google_search', 'chatgpt', 'deepseek', 'claude', 'perplexity'].forEach((svc) => {
      expect(runMetric(svc, { native: 9637, netServerTokens: 486 })).toBe(486);
      expect(runMetric(svc, { native: 9637, netServerTokens: 0 })).toBe(0);
    });
  });

  test('qwen по-прежнему 0 даже при непустой шапке', () => {
    expect(runMetric('qwen', { native: 9637, netServerTokens: 486 })).toBe(0);
  });
});
