/**
 * Разбор строки лога `[gemini-intercept] parse-top fail (parseByBytes): Unterminated string`.
 *
 * ВОПРОС: это штатная обработка ЧАСТИЧНОГО чанка или потеря ходов?
 * ОТВЕТ (проверяется здесь на РЕАЛЬНОМ коде core/gemini-intercept.js): штатная обработка.
 *
 * Почему потеря невозможна:
 *   1) фреймы байтового парсера независимы: цикл `while (pos < bytes.length && guard++ < 200)`
 *      продолжается после неудачи одного фрейма — уже собранные ходы в out.turns остаются;
 *   2) `if (end > bytes.length) end = bytes.length;` — обрыв последнего фрейма обрабатывается
 *      ЯВНО (длина клампится), а не молча;
 *   3) JSON.parse стоит ДО handleOuter: частично разобранный фрейм физически не может
 *      влиться в базу половиной хода — в handleOuter уходит только целиком разобранный объект;
 *   4) провал логируется (`parse-top fail (parseByBytes): …`) и НЕ делает re-throw/return/break —
 *      это телеметрия, а не отказ парса;
 *   5) счётчик out.total (id вида 'idx<N>') не тратится на упавший фрейм → id следующих
 *      ходов не сдвигаются;
 *   6) parseByLines — фолбэк ТОЛЬКО когда байтовый парс не дал ни одного хода
 *      (`if (!out.turns.length)`) — двойного ингеста и дублей нет;
 *   7) ход из оборванного фрейма приходит в следующем (полном) снимке того же ответа и
 *      дедуплицируется по id в turnsMap — «пропуск» разовый, не потеря.
 *
 * Тест исполняет РЕАЛЬНЫЕ тела parseByBytes/parseByLines/parseBatchExecute, извлечённые из
 * core/gemini-intercept.js (конвенция fnDecl + песочница `with`), — не копию логики.
 * НЕ ТРОГАЕТСЯ: saveFloor (HWM), H9/H10-гейты, resetForNewConversation.
 */
const fs = require('fs');
const path = require('path');
// jsdom (jest-окружение проекта) не даёт TextEncoder/TextDecoder — в браузере это нативные
// глобалы, поэтому в песочницу они подаются явно (иначе реальный parseByBytes выходит
// на первом же try и тест проверял бы пустоту вместо парса).
const { TextEncoder, TextDecoder } = require('util');

const ROOT = path.join(__dirname, '..', '..');
const CORE_GEMINI = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');

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

// ---- сборка сырого тела batchexecute: заголовок + фреймы «длина(байт)\nJSON\n» ----
const HEADER = ")]}'" + '\n';
function frame(payload) {
  return Buffer.byteLength(payload, 'utf8') + '\n' + payload + '\n';
}
const P1 = '[0,"hNvQHb","ход-1"]';
const P2 = '[0,"hNvQHb","ход-2"]';
const P3 = '[0,"hNvQHb","ход-3"]';
// обрыв ПОСЕРЕДИНЕ строки: ровно тот случай, что даёт «Unterminated string»
const TRUNC = '[0,"hNvQHb';
// частичный чанк: два целых фрейма + заявленная длина 999 при 11 доступных байтах
const PARTIAL = HEADER + frame(P1) + frame(P2) + '999\n' + TRUNC;
const COMPLETE = HEADER + frame(P1) + frame(P2) + frame(P3);

// ---- песочница: реальное тело parseByBytes + записывающий handleOuter ----
function runParseByBytes(raw) {
  const ctx = { logs: [], calls: [], TextEncoder: TextEncoder, TextDecoder: TextDecoder };
  ctx.debugLog = function (level, msg) { ctx.logs.push(String(msg)); };
  // эмуляция реального присвоения id (extractTurnId(t) || 'idx' + out.total++):
  // счётчик out.total тратится ТОЛЬКО на дошедшие до handleOuter ходы.
  ctx.handleOuter = function (outer, out, src) {
    ctx.calls.push(outer);
    out.turns.push({ id: 'idx' + out.total, outer: outer, src: src });
    out.total++;
  };
  const body = fnDecl(CORE_GEMINI, 'parseByBytes') +
    '\n parseByBytes(' + JSON.stringify(raw) + ', out, "passive"); return out;';
  const fn = new Function('ctx', 'with (ctx) { var out = { turns: [], total: 0 };' + body + ' }');
  ctx.out = fn(ctx);
  return ctx;
}

// ---- песочница: реальная связка parseByBytes + parseByLines + parseBatchExecute ----
function runParseBatchExecute(raw) {
  const ctx = { logs: [], calls: [], TextEncoder: TextEncoder, TextDecoder: TextDecoder };
  ctx.debugLog = function (level, msg) { ctx.logs.push(String(msg)); };
  ctx.handleOuter = function (outer, out, src) {
    ctx.calls.push(outer);
    out.turns.push({ id: String(outer[2]), outer: outer, src: src });
  };
  const body = fnDecl(CORE_GEMINI, 'parseByBytes') + '\n' +
    fnDecl(CORE_GEMINI, 'parseByLines') + '\n' +
    fnDecl(CORE_GEMINI, 'parseBatchExecute') +
    '\n return parseBatchExecute(' + JSON.stringify(raw) + ', "passive");';
  const fn = new Function('ctx', 'with (ctx) {' + body + ' }');
  ctx.result = fn(ctx);
  return ctx;
}

describe('частичный чанк batchexecute: parse-top fail = штатная обработка, не потеря ходов', () => {
  test('обрыв последнего фрейма: предыдущие ходы СОХРАНЕНЫ, парс не падает', () => {
    const ctx = runParseByBytes(PARTIAL);
    // оба целых фрейма обработаны — цикл не прервался на оборванном
    expect(ctx.out.turns.map((t) => t.id)).toEqual(['idx0', 'idx1']);
    expect(ctx.out.turns.map((t) => t.outer[2])).toEqual(['ход-1', 'ход-2']);
    // счётчик id не сдвинут: оборванный фрейм его не тратил
    expect(ctx.out.total).toBe(2);
    // провал залогирован ровно ожидаемой строкой лога и не бросил исключение
    const joined = ctx.logs.join('\n');
    expect(joined).toContain('parse-top fail (parseByBytes): ');
    expect(joined).toMatch(/Unterminated string/);
    expect(ctx.logs).toHaveLength(1);
  });

  test('обрыв НЕ доходит до handleOuter: половина хода в базу не вливается', () => {
    const ctx = runParseByBytes(PARTIAL);
    // handleOuter получил РОВНО два объекта — по одному на целый фрейм
    expect(ctx.calls).toHaveLength(2);
    ctx.calls.forEach((outer) => {
      expect(Array.isArray(outer)).toBe(true); // целиком разобранный JSON, не обрывок
      expect(outer[0]).toBe(0);
      expect(outer[1]).toBe('hNvQHb');
      expect(['ход-1', 'ход-2']).toContain(outer[2]);
    });
    // ни один вызов не является обрывком: значения вызовов — только целые фреймы,
    // а сам обрывок (равный TRUNC) в handleOuter не уходил
    ctx.calls.forEach((outer) => { expect(outer).toHaveLength(3); });
    expect(ctx.calls.some((outer) => JSON.stringify(outer) === TRUNC)).toBe(false);
  });

  test('догрузка полного тела того же ответа возвращает недостающий ход (без дублей)', () => {
    const partial = runParseByBytes(PARTIAL);
    const complete = runParseByBytes(COMPLETE);
    // полное тело: все три хода; id продолжают ту же нумерацию
    expect(complete.out.turns.map((t) => t.id)).toEqual(['idx0', 'idx1', 'idx2']);
    expect(complete.out.turns.map((t) => t.outer[2])).toEqual(['ход-1', 'ход-2', 'ход-3']);
    expect(complete.logs).toHaveLength(0); // полное тело парсится без единого parse-top fail
    // «пропущенное» на обрыве подмножество полного набора → разовый пропуск, не потеря:
    // уникальность id сохраняется, дублей нет (дедуп в turnsMap по id)
    const partialKeys = partial.out.turns.map((t) => t.outer[2]);
    partialKeys.forEach((k) => expect(complete.out.turns.map((t) => t.outer[2])).toContain(k));
    expect(new Set(complete.out.turns.map((t) => t.id)).size).toBe(3);
  });

  test('parseByLines — фолбэк ТОЛЬКО при нуле ходов из байтового парса (нет двойного ингеста)', () => {
    // фрейм без маркера hNvQHb байтовый парс пропускает → включится построчный фолбэк
    const raw = HEADER + frame('[0,"other","x"]') + frame(P2);
    const ctx = runParseBatchExecute(raw);
    expect(ctx.result).toHaveLength(1);
    expect(ctx.result[0].id).toBe('ход-2');
    // байтовый парс дал ходы → parseByLines НЕ вызывается (handleOuter ровно один раз)
    const direct = runParseBatchExecute(HEADER + frame(P1) + frame(P2));
    expect(direct.calls).toHaveLength(2);
    expect(direct.result).toHaveLength(2);
  });
});

describe('частичный чанк: пины исходника (штатная обработка не превратится в тихую потерю)', () => {
  const body = fnDecl(CORE_GEMINI, 'parseByBytes');

  test('кламп длины фрейма и продолжение цикла на месте', () => {
    expect(body).toContain('var end = pos + n; if (end > bytes.length) end = bytes.length;');
    expect(body).toContain('while (pos < bytes.length && guard++ < 200) {');
  });

  test('JSON.parse стоит ДО handleOuter (частичный фрейм не вливается)', () => {
    // единственная точка вызова — handleOuter(JSON.parse(payloadStr), …): в handleOuter
    // физически не может уйти полуразобранный объект
    expect(body).toContain('handleOuter(JSON.parse(payloadStr), out, src)');
    expect((body.match(/handleOuter\(/g) || []).length).toBe(1);
    expect((body.match(/JSON\.parse\(/g) || []).length).toBe(1);
  });

  test('catch — только телеметрия: есть лог, нет throw/return/break (цикл не обрывается)', () => {
    const tag = body.indexOf('parse-top fail (parseByBytes): ');
    expect(tag).toBeGreaterThan(-1);
    const catchStart = body.lastIndexOf('catch (e) {', tag);
    expect(catchStart).toBeGreaterThan(-1);
    const catchBlock = body.slice(catchStart, body.indexOf('}', tag) + 1);
    expect(catchBlock).not.toContain('throw');
    expect(catchBlock).not.toContain('return');
    expect(catchBlock).not.toContain('break');
    expect(catchBlock).toContain("debugLog('log'");
  });

  test('parseBatchExecute: построчный фолбэк только при нуле ходов', () => {
    expect(fnDecl(CORE_GEMINI, 'parseBatchExecute')).toContain('if (!out.turns.length) parseByLines(raw, out, src);');
  });
});
