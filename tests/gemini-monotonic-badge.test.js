/**
 * v2.0.35 (приёмка Фазы 3, шаг 3): Gemini — строгий монотонный бейдж.
 *
 * Живой дефект: при пересборке базы истории (baseComplete ещё false) новый расчёт
 * токенов оказывался НИЖЕ прошлого, и бейдж падал 9% → 7% → 5%. useMonotonic включался
 * только при baseComplete || lastBounded || (baseSeen && baseCount > 0), поэтому в
 * «слепой» фазе (пустая база, свежий разговор) падение проходило.
 *
 * Контракт фикса (core/content.js, processAndSend): после выбора maxTokenCount и ДО
 * расчёта percentage — удержание: если baseComplete !== true, серверных токенов нет и
 * прошлый процент > 0, maxTokenCount не опускается ниже порога прошлого процента.
 * НЕ переписываются: точное серверное число (metricServerTokens > 0) и сброс храповика
 * O-32 (база с дублями, ветка C) — это доказанные снижения.
 *
 * Пины, которые нельзя сдвинуть байтово: строка useMonotonic,
 * `const percentage = displayLimit > 0 …`, вызов updateWidget(percentage, maxTokenCount, …).
 */
const CONTENT = require('./helpers/content-source.js').contentSource;

// Рез функции по балансу фигурных скобок (как в tests/o32-gsa-spa-inflation.test.js).
function sliceFunction(src, name) {
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
  throw new Error('unterminated ' + name);
}

/** Срез ветвления maxTokenCount + удержание (до строки percentage). */
function metricMaxBranch() {
  const draw = sliceFunction(CONTENT, 'processAndSend');
  const iAnchor = draw.indexOf('// точное число из countTokens авторитетно');
  expect(iAnchor).toBeGreaterThan(-1);
  const iStart = draw.lastIndexOf('if (metricServerTokens > 0) {', iAnchor);
  expect(iStart).toBeGreaterThan(-1);
  const iEnd = draw.indexOf('const percentage = displayLimit > 0', iStart);
  expect(iEnd).toBeGreaterThan(iStart);
  return draw.slice(iStart, iEnd);
}

const BRANCH = metricMaxBranch();

function pctOf(o) {
  return Math.round((o.maxTokenCount / o.displayLimit) * 1000) / 10;
}

/**
 * Прогон реального ветвления на заданном состоянии прохода.
 * Флаг сброса храповика объявлен ВНЕ среза (в коде — перед цепочкой), поэтому в
 * песочнице он передаётся в ctx; в браузере это var того же прохода.
 */
function runMaxBranch(o) {
  const logs = [];
  const ctx = {
    metricServerTokens: o.metricServerTokens || 0,
    byokHeuristicHold: o.byokHeuristicHold === true,
    baseComplete: o.baseComplete === true,
    baseSeen: o.baseSeen === true,
    baseCount: o.baseCount,
    aiCmDomListS1: (o.domMsgs == null) ? null : new Array(o.domMsgs),
    useMonotonic: o.useMonotonic === true,
    tokenEstimate: o.tokenEstimate,
    maxTokenCount: o.maxTokenCount,
    lastBounded: o.lastBounded === true,
    displayLimit: o.displayLimit,
    lastPercentage: o.lastPercentage,
    aiCmRatchetResetByDom: false,
    logs: logs,
    debugLog: function (level, msg) { logs.push(String(msg)); }
  };
  new Function('ctx', 'with (ctx) { ' + BRANCH + '\nreturn maxTokenCount; }')(ctx);
  return ctx;
}

describe('Gemini: строгое удержание бейджа на неполной базе', () => {
  test('baseComplete=false: 9% → 7% НЕ принимается, бейдж держит 9%', () => {
    const ctx = runMaxBranch({
      baseComplete: false, lastPercentage: 9, displayLimit: 100000,
      tokenEstimate: 7000, maxTokenCount: 7000
    });
    expect(ctx.maxTokenCount).toBe(9000); // порог прошлого процента: 9% от 100000
    expect(pctOf(ctx)).toBe(9);
    expect(ctx.logs.some(function (m) { return m.indexOf('badge-strict-hold') !== -1; })).toBe(true);
  });

  test('падение серией проходов: 9% → 7% → 5% держится на 9% до baseComplete', () => {
    const limit = 200000;
    // проход 1: 9% принят (первый бейдж)
    let ctx = runMaxBranch({
      baseComplete: false, lastPercentage: -1, displayLimit: limit,
      tokenEstimate: 18000, maxTokenCount: 0
    });
    expect(pctOf(ctx)).toBe(9);
    // проход 2: свежий расчёт 7% — удержание
    ctx = runMaxBranch({
      baseComplete: false, lastPercentage: 9, displayLimit: limit,
      tokenEstimate: 14000, maxTokenCount: 14000
    });
    expect(pctOf(ctx)).toBe(9);
    // проход 3: 5% — держим те же 9%
    ctx = runMaxBranch({
      baseComplete: false, lastPercentage: 9, displayLimit: limit,
      tokenEstimate: 10000, maxTokenCount: 10000
    });
    expect(pctOf(ctx)).toBe(9);
    // проход 4: база дособрана → авторитетен полный расчёт, падение разрешено
    ctx = runMaxBranch({
      baseComplete: true, lastPercentage: 9, displayLimit: limit,
      tokenEstimate: 10000, maxTokenCount: 10000
    });
    expect(pctOf(ctx)).toBe(5);
  });

  test('рост процента на неполной базе проходит как раньше (9% → 11%)', () => {
    const ctx = runMaxBranch({
      baseComplete: false, lastPercentage: 9, displayLimit: 100000,
      tokenEstimate: 11000, maxTokenCount: 11000
    });
    expect(ctx.maxTokenCount).toBe(11000);
    expect(pctOf(ctx)).toBe(11);
  });

  test('новый разговор (lastPercentage=-1/0): удержания нет — бейдж с нуля', () => {
    [-1, 0].forEach(function (prev) {
      const ctx = runMaxBranch({
        baseComplete: false, lastPercentage: prev, displayLimit: 100000,
        tokenEstimate: 7000, maxTokenCount: 7000
      });
      expect(ctx.maxTokenCount).toBe(7000);
      expect(pctOf(ctx)).toBe(7);
    });
  });

  test('O-32 (база с дублями, ветка C): доказанное снижение не переписывается', () => {
    const ctx = runMaxBranch({
      baseComplete: false, lastBounded: true, baseSeen: true, baseCount: 10, domMsgs: 6,
      lastPercentage: 95, displayLimit: 100000,
      tokenEstimate: 5658, maxTokenCount: 11475
    });
    expect(ctx.maxTokenCount).toBe(5658); // сброс храповика сильнее удержания
    expect(ctx.lastBounded).toBe(false);
  });

  test('точное серверное число (metricServerTokens>0) авторитетно — удержание молчит', () => {
    const ctx = runMaxBranch({
      metricServerTokens: 5000, baseComplete: false, lastPercentage: 9, displayLimit: 100000,
      tokenEstimate: 5000, maxTokenCount: 9000
    });
    expect(ctx.maxTokenCount).toBe(5000);
    expect(pctOf(ctx)).toBe(5);
  });
});

describe('пины контракта (строки, которые нельзя сдвинуть)', () => {
  test('useMonotonic и updateWidget сохранены байтово', () => {
    expect(CONTENT).toContain('const useMonotonic = baseComplete || lastBounded || (baseSeen && baseCount > 0);');
    expect(CONTENT).toContain(
      'updateWidget(percentage, maxTokenCount, effectiveLimit, contextLimit, displayLimit, ModelConfig.getModel(modelId)?.name || modelId, netAttachBreak);');
    expect(CONTENT).toContain('const percentage = displayLimit > 0 ? Math.round((maxTokenCount / displayLimit) * 1000) / 10 : 0;');
  });

  test('удержание стоит МЕЖДУ цепочкой и расчётом percentage, с guard на lastPercentage', () => {
    expect(BRANCH).toContain("typeof lastPercentage === 'number' && lastPercentage > 0");
    expect(BRANCH).toContain('var strictHoldTokens = Math.ceil((lastPercentage * displayLimit) / 100);');
    const iHold = BRANCH.indexOf('strictHoldTokens');
    const iChainEnd = BRANCH.lastIndexOf('maxTokenCount = tokenEstimate;');
    expect(iHold).toBeGreaterThan(iChainEnd);
  });
});
