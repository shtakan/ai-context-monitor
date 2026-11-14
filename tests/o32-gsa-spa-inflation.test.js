/**
 * O-32 (регрессия SPA-возврата, комбинированный фикс A+C отчёта plan-gsa-spa-inflation).
 *
 * ЖИВОЙ ДЕФЕКТ (после первого O-32-фикса): на одном треде бейдж оставался завышенным —
 * 6 сообщений / 12255 знаков / 5658 токенов / 4.4% на холодном старте, но 9% на возврате
 * в тред по SPA. Новых сообщений пользователь не отправлял.
 *
 * Механизм, который пинится здесь:
 *   A) ТЕЛО ОДНОГО ОТВЕТА приходило двумя формами: прерванный стрим (короткая форма) и
 *      полный добор (длинная), либо длинная форма с маркерами цитат в хвосте. Точный
 *      канонический ключ их не схлопывал — база росла «ход + его продолжение».
 *      Правило: при ОДНОМ вопросе тела совместимы, если одно — префикс другого либо общий
 *      префикс ≥ 80% короткого тела; при слиянии побеждает ПОЛНОЕ тело.
 *   C) раздутая база оседала в кэше треда (источник базы при SPA-возврате), а монотонный
 *      максимум бейджа (`maxTokenCount`) удерживал завышенное значение навсегда.
 *      Правило: кэш пишется без дублей; при неполной базе, которая заявляет БОЛЬШЕ
 *      сообщений, чем отдаёт DOM, храповик сбрасывается к текущей оценке.
 *
 * Исполняются РЕАЛЬНЫЕ байты исходников (конвенция сьюта): парсер — как модуль,
 * ветвление maxTokenCount — срезом core/content.ts через new Function.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./helpers/content-source.js');

const ROOT = H.ROOT;
const CONTENT = fs.readFileSync(path.join(ROOT, 'core', 'content.ts'), 'utf8');
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const Parser = require('./helpers/load-esm.js').loadEsmModule('utils/google-search-folwr-parser.ts');

/** Тело функции по имени: от `function name(` до парной закрывающей скобки. */
function sliceFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let i = src.indexOf('{', start);
  let depth = 0;
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated ' + name + ' @' + open);
}

/**
 * Срез присваивания числа (S4/D3): от единственного `maxTokenCount = tokenEstimate;`
 * через серверный источник и O-32-релиз до расчёта percentage. Монотонного максимума нет.
 */
function metricMaxBranch() {
  const draw = sliceFunction(CONTENT, 'processAndSend');
  const iStart = draw.indexOf('maxTokenCount = tokenEstimate;');
  expect(iStart).toBeGreaterThan(-1);
  expect(draw.indexOf('useMonotonic')).toBe(-1);
  const iEnd = draw.indexOf('const percentage = displayLimit > 0', iStart);
  expect(iEnd).toBeGreaterThan(iStart);
  return draw.slice(iStart, iEnd);
}

/**
 * Прогон реального ветвления maxTokenCount на заданном состоянии прохода.
 * Возвращает весь ctx: ветка меняет не только maxTokenCount, но и lastBounded.
 */
function runMaxBranch(o) {
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
    lastBounded: o.lastBounded === true
  };
  new Function('ctx', 'with (ctx) { ' + metricMaxBranch() +
    '\nreturn maxTokenCount; }')(ctx);
  return ctx;
}

// =====================================================================================
// Данные живого дефекта: один вопрос, тело ответа пришло в двух формах полноты
// =====================================================================================
const QUESTION = 'Напиши Python-код для вычисления N-го числа Фибоначчи итеративно';
const SHORT_BODY = 'Вот код:\n```python\ndef fib(n):\n    a, b = 0, 1';
const FULL_BODY = SHORT_BODY + '\n    for _ in range(n):\n        a, b = b, a + b\n' +
  '    return a\n```\n\nСложность O(n), память O(1).';
const SHORT_TURN = { id: 'net-short', userText: QUESTION, assistantText: SHORT_BODY };
const FULL_TURN = { id: 'net-full', userText: QUESTION, assistantText: FULL_BODY };

describe('O-32 (A): префикс-совместимые тела одного хода — ОДИН ход, побеждает полное тело', () => {
  test('D1: mergeTurnsById/Monotone/ByKey схлопывают прерванный стрим и полный добор', () => {
    for (const fn of ['mergeTurnsById', 'mergeTurnsMonotone', 'mergeTurnsByKey']) {
      const merged = Parser[fn]([SHORT_TURN], [FULL_TURN]);
      expect(merged).toHaveLength(1);
      expect(merged[0].assistantText).toBe(FULL_BODY);   // сохранено ПОЛНОЕ тело
    }
  });

  test('D1: обратный порядок ровно так же оставляет полное тело (короткое не затирает)', () => {
    const merged = Parser.mergeTurnsById([FULL_TURN], [SHORT_TURN]);
    expect(merged).toHaveLength(1);
    expect(merged[0].assistantText).toBe(FULL_BODY);
    // id базы сохранён: ход не «переезжает» под id новой формы
    expect(merged[0].id).toBe('net-full');
  });

  test('D1: нечёткое совпадение (общий префикс ≥ 80%) — тоже один ход', () => {
    // маркеры цитат/хвост разошлись после общего префикса: префикс ~90% короткого тела
    const near = SHORT_BODY + ' [1]' + ' — иная концовка ответа с цитатой [2].';
    const merged = Parser.mergeTurnsById(
      [{ id: 'a', userText: QUESTION, assistantText: SHORT_BODY }],
      [{ id: 'b', userText: QUESTION, assistantText: near }]
    );
    expect(Parser.bodiesPrefixCompatible(
      Parser.turnIdentityParts({ assistantText: SHORT_BODY }).a,
      Parser.turnIdentityParts({ assistantText: near }).a
    )).toBe(true);
    expect(merged).toHaveLength(1);
    expect(merged[0].assistantText).toBe(near);          // длиннее (полнее) — он и остался
  });

  test('D1-контроль: разные вопросы и разные тела НЕ схлопываются', () => {
    // одинаковое тело, разные вопросы — это два РАЗНЫХ хода
    expect(Parser.mergeTurnsById(
      [{ id: 'q1', userText: 'Первый вопрос пользователя?', assistantText: FULL_BODY }],
      [{ id: 'q2', userText: 'Совсем другой вопрос пользователя?', assistantText: FULL_BODY }]
    )).toHaveLength(2);
    // один вопрос, тела без общего префикса — тоже два хода (разные ответы)
    expect(Parser.mergeTurnsById(
      [{ id: 'r1', userText: QUESTION, assistantText: 'Первый вариант решения через рекурсию.' }],
      [{ id: 'r2', userText: QUESTION, assistantText: 'Второй вариант через матричное возведение.' }]
    )).toHaveLength(2);
    // короткие тела («Да» / «Да, верно») префикс-правилом не склеиваются
    expect(Parser.bodiesPrefixCompatible('да', 'даверно')).toBe(false);
  });

  test('C-dedupe: dedupeTurns не переписывает объекты и сохраняет id полной формы', () => {
    const out = Parser.dedupeTurns([SHORT_TURN, FULL_TURN, Object.assign({}, FULL_TURN, { id: 'net-full-dup' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(FULL_TURN);                      // оригинальный объект, не копия
    expect(out[0].id).toBe('net-full');
  });
});

describe('O-32 (C): сброс храповика на раздутой базе и чистая запись в кэш', () => {
  test('D2 (D3): неполная база заявляет БОЛЬШЕ сообщений, чем DOM → число = текущая оценка', () => {
    // живой SPA-возврат: база с дублями (12 сообщений) при 6 реальных в DOM,
    // бейдж держал раздутые 11475 токенов, честная оценка канонической базы — 5658.
    // D3: число — текущее измерение, прошлый максимум источником больше не является.
    const ctx = runMaxBranch({
      baseComplete: false, baseSeen: true, baseCount: 12, domMsgs: 6,
      tokenEstimate: 5658, maxTokenCount: 11475, lastBounded: true
    });
    expect(ctx.maxTokenCount).toBe(5658);
    expect(ctx.maxTokenCount).toBeLessThan(11475);
    // DOM-граница снята: следующий проход снова мерит источник с нуля
    expect(ctx.lastBounded).toBeFalsy();
  });

  test('R1 (D3): тред без дублей (DOM = Net) — падение до текущего измерения разрешено', () => {
    const ctx = runMaxBranch({
      baseComplete: false, baseSeen: true, baseCount: 6, domMsgs: 6,
      tokenEstimate: 35100, maxTokenCount: 35800
    });
    expect(ctx.maxTokenCount).toBe(35100);               // 35.8% → 35.2%: D3, не регресс
  });

  test('R1 (D3): рост принимается безусловно', () => {
    const ctx = runMaxBranch({
      baseComplete: false, baseSeen: true, baseCount: 6, domMsgs: 4,
      tokenEstimate: 36000, maxTokenCount: 35800
    });
    expect(ctx.maxTokenCount).toBe(36000);
  });

  test('R1 (D3): полная база тоже берёт текущее измерение', () => {
    const ctx = runMaxBranch({
      baseComplete: true, baseSeen: true, baseCount: 12, domMsgs: 6,
      tokenEstimate: 35100, maxTokenCount: 35800
    });
    expect(ctx.maxTokenCount).toBe(35100);
  });

  test('source-пин: единственное присваивание числа + O-32-релиз по DOM-базе', () => {
    const branch = metricMaxBranch();
    expect(branch).toContain('baseCount > aiCmDomListS1.length');
    expect(branch).toContain('maxTokenCount = tokenEstimate;');
    expect(branch).toContain('lastBounded = false;');
    expect(branch).not.toContain('useMonotonic');
    // дубли отсекаются ДО записи в кэш на всех трёх точках записи
    expect(sliceFunction(INTERCEPT, 'dedupeTurnsForCache')).toContain('dedupeTurns');
    expect(sliceFunction(INTERCEPT, 'applySnapshot')).toContain('dedupeTurnsForCache(rawTurns)');
    expect(sliceFunction(INTERCEPT, 'mergeStreamTurns')).toContain('dedupeTurnsForCache(merged)');
    expect(sliceFunction(INTERCEPT, 'mergeTurns')).toContain('dedupeTurnsForCache(lastFullTurns)');
  });
});
