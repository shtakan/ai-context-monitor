/**
 * v2.0.35 (приёмка Фазы 3, шаг 3): Gemini — строгий монотонный бейдж.
 *
 * Живой дефект: при пересборке базы истории (baseComplete ещё false) новый расчёт
 * токенов оказывался НИЖЕ прошлого, и бейдж падал 9% → 7% → 5%. useMonotonic включался
 * только при baseComplete || lastBounded || (baseSeen && baseCount > 0), поэтому в
 * «слепой» фазе (пустая база, свежий разговор) падение проходило.
 *
 * Контракт фикса (core/content.ts, processAndSend): после выбора maxTokenCount и ДО
 * расчёта percentage — удержание: если baseComplete !== true, серверных токенов нет и
 * прошлый процент > 0, maxTokenCount не опускается ниже порога прошлого процента.
 * НЕ переписываются: точное серверное число (metricServerTokens > 0) и сброс храповика
 * O-32 (база с дублями, ветка C) — это доказанные снижения.
 *
 * Пины, которые нельзя сдвинуть байтово: строка useMonotonic,
 * `const percentage = displayLimit > 0 …`, вызов updateWidget(percentage, maxTokenCount, …).
 */
const CONTENT = require('./helpers/content-source.js').contentSource;
const { readSource } = require('./helpers/content-source.js');
const fs = require('fs');
const path = require('path');
const ROOT = require('./helpers/content-source.js').ROOT;

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

// =====================================================================================
// v2.6 (R1) D5/D6: ЕДИНЫЙ снимок метрики. Живой дефект R1 — 81 токен между счётчиком
// панели файла и бейджем сразу после F5: панель считала Math.max(эвристика, максимум),
// а шапка файла читала maxTokenCount напрямую, при этом флаш истории шёл ДО ресинка метрик.
// Фикс: число считается в ОДНОЙ функции (aiCmTokenSnapshot), фиксируется в
// state.ts:lastTokensSnapshot в ОДНОЙ точке и оттуда читается панелью и шапкой файла.
// Пины ниже — расширение (D5: одна точка записи; D6: значение виджета до ветвления + wiring).
// =====================================================================================
describe('v2.6 (R1) D5/D6: снимок метрики фиксируется ОДИН раз и до ветвления', () => {
  const COMMIT = 'lastTokensSnapshot = (body && body.text === effective)';

  test('D5: одна точка записи снимка — после percentage и после строгого удержания', () => {
    // единственная запись во всём контент-скрипте: иначе панель и файл разойдутся с бейджем
    expect(CONTENT.split(COMMIT).length - 1).toBe(1);
    const draw = sliceFunction(CONTENT, 'processAndSend');
    const iCommit = draw.indexOf(COMMIT);
    expect(iCommit).toBeGreaterThan(-1);
    // maxTokenCount/percentage уже окончательны: запись идёт после lastPercentage и после
    // блока строгого удержания (иначе снимок зафиксировал бы доисправочное число)
    expect(iCommit).toBeGreaterThan(draw.indexOf('lastPercentage = percentage;'));
    expect(draw.lastIndexOf('strictHoldTokens', iCommit)).toBeLessThan(iCommit);
    // и до расчёта числа не пишется: запись ровно одна на проход
    expect(draw.split(COMMIT).length - 1).toBe(1);
  });

  test('D6: значение виджета пишется ДО ветвления — любая ветка видит посчитанное число', () => {
    const draw = sliceFunction(CONTENT, 'processAndSend');
    const iWidget = draw.indexOf('lastWidgetData = {');
    const iCascade = draw.indexOf('var badgeSuppressActive');
    expect(iWidget).toBeGreaterThan(-1);
    expect(iCascade).toBeGreaterThan(iWidget);
    // копий значения в ветках больше нет (прежние две записи удалены)
    expect(draw.split('lastWidgetData = {').length - 1).toBe(1);
    // все «держащие» ветки на месте: супрессия SPA, заморозка лоадера, щит O-1, BYOK
    ['[content-trace] badge-suppress', '[content-trace] badge-freeze', '[content-trace] byok-hold']
      .forEach(function (marker) { expect(draw).toContain(marker); });
    expect(draw).toContain('} else if (aiCmBadgeHoldActive()) {');
    // и на разморозке лоадера слушатель по-прежнему рисует накопленное значение
    expect(CONTENT).toContain('if (!aiCmLoaderFreeze && lastWidgetData) {');
    expect(CONTENT).toContain('updateWidget(d.percentage, d.tokenEstimate, d.effectiveLimit, d.contextLimit, d.displayLimit, d.modelName, d.attachBreak);');
  });

  test('D6: state.ts объявляет снимок и зеркалит в UMD; сбросы чата его гасят', () => {
    const state = fs.readFileSync(path.join(ROOT, 'core', 'state.ts'), 'utf8');
    expect(state).toContain('let lastTokensSnapshot: { tokens: number; percent: number; limit: number; src?: string; chars?: number; msgs?: number; bodyHash?: string; baseComplete?: boolean } | null = null;');
    expect(state).toContain("Object.defineProperty(Api, 'lastTokensSnapshot',");
    // сброс разговора (widget) и смена convId/base-complete (content) обнуляют снимок:
    // иначе панель/файл нового чата прочли бы число предыдущего
    expect(readSource('core/widget.ts')).toContain("if (typeof lastTokensSnapshot !== 'undefined') lastTokensSnapshot = null;");
    // 1 сброс разговора (widget.ts) + 2 сброса в content.ts (смена convId и 0→1 base-complete)
    expect(CONTENT.split("if (typeof lastTokensSnapshot !== 'undefined') lastTokensSnapshot = null;").length - 1).toBe(3);
  });

  test('D6: шапка файла экспорта берёт tokens/percent/limit из снимка, а не из maxTokenCount напрямую', () => {
    const mgr = readSource('core/export-manager.ts');
    const iAuto = mgr.indexOf('function aiCmWriteAutoExportFile(');
    const iNext = mgr.indexOf('\nfunction ', iAuto + 10);
    const body = mgr.slice(iAuto, iNext);
    expect(body).toContain("var snapR1Auto = (typeof lastTokensSnapshot !== 'undefined' && lastTokensSnapshot) ? lastTokensSnapshot : null;");
    expect(body).toContain("var snapTokens = (snapR1Auto && typeof snapR1Auto.tokens === 'number')");
    expect(body).toContain("var snapPercent = (snapR1Auto && typeof snapR1Auto.percent === 'number')");
    expect(body).toContain('tokens: snapTokens,');
    // история записи (aiCmWriteCurrentHistory) — тот же снимок
    const iHist = mgr.indexOf('function aiCmWriteCurrentHistory(');
    const histBody = mgr.slice(iHist, mgr.indexOf('\nfunction ', iHist + 10));
    expect(histBody).toContain("var histTokens = (snapR1Hist && typeof snapR1Hist.tokens === 'number') ? snapR1Hist.tokens : maxTokenCount;");
    expect(histBody).toContain('tokens: histTokens,');
    // и ни один путь не пишет в шапку сырой maxTokenCount, минуя снимок
    expect(body).not.toContain('var snapTokens = (typeof maxTokenCount === \'number\') ? maxTokenCount : 0;');
  });
});
