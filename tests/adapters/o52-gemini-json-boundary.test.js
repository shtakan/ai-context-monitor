/**
 * O-52 (Medium): умное добивание границ JSON-кадра в `parseByBytes`.
 *
 * Живой прогон 2026-09-25 (чат 8f1343975188be5d): `JSON.parse` кадра падал с
 * «Unexpected non-whitespace character after JSON at position …». Корень: срез
 * `raw.slice(pos, end)` брался ровно по ОБЪЯВЛЕННОЙ длине кадра, а объявленная длина может
 * НЕ совпадать с концом JSON-значения — тогда в payload попадают trailing-разделители и префикс
 * длины СЛЕДУЮЩЕГО кадра (перебег), либо, наоборот, значение не закрывается (недобор).
 * Сам JSON в теле при этом цел; терялись кадр(ы) и ходы.
 *
 * Фикс: `extractJsonPayload` возвращает РОВНО одно сбалансированное JSON-значение —
 * (а) срез как объявлен, если после значения только пробелы (быстрый путь, байты O-50 целы);
 * (б) срез, обрезанный по концу значения (перебег: разделители/префикс следующего кадра убраны,
 *     нумерация кадров восстанавливается — цикл продолжается с конца значения);
 * (в) добор границы за объявленный конец в пределах safety_margin (недобор);
 * (г) обрыв тела — исходный срез БЕЗ изменений (семантика O-48: диаг-числа и tolerant-salvage
 *     получают тот же вход).
 * Guard: добор не превышает `declaredN + JSON_FRAME_OVERRUN_MAX` (256 СИМВОЛОВ) и никогда не
 * выходит за конец тела — защита от O-50-регресса и «убегающего» скана.
 *
 * Пины:
 *   D1 JSON парсится без ошибки: форма дефекта воспроизведена (объявленный срез падает ровно
 *      сообщением живого лога), при этом реальный `parseByBytes` не даёт НИ ОДНОГО parse-top
 *      fail, а кадр после перебега не теряется (оба конверта в handleOuter);
 *   D2 payload не содержит лишних символов: payload обоих кадров побайтово равен исходному JSON
 *      (round-trip), `lastFrameParseFail` пуст — ни разделителей, ни префикса, ни обрезки;
 *   R1 регресс O-50 цел: кадр с кириллицей, размеченный в СИМВОЛАХ, идёт быстрым путём (а) —
 *      payload байтово тот же, ни одного fail; source-пины символьного среза/одной точки разбора;
 *   R2 guard добивания: недобор в пределах margin восстанавливается; обрыв тела сверх margin и
 *      обрыв без закрытия — прежняя семантика O-48 (один parse-top fail, диаг-числа в БАЙТАХ,
 *      clamped, ложной полноты/успеха нет); добор ограничен `declaredN + margin` и концом тела;
 *   R3 регресс O-48 (legacy-байтовая разметка) и O-51: байтовый обрыв → clamped=1 + salvage,
 *      решение по базе (isSubsetIds/vf5-subset-no-reset) не тронуто.
 *
 * Тесты исполняют РЕАЛЬНОЕ тело parseByBytes из core/gemini-intercept.js (конвенция fnDecl +
 * песочница `with`), а не копию логики. НЕ ТРОГАЕТСЯ: tolerant-salvage O-48, единая точка сбора
 * O-49, символьный срез O-50, монотонный union O-51, санация O-20/O-40/O-42, D-O41, O-47,
 * CHANGELOG/версия.
 */
const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');

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

// ---- песочница: реальный parseByBytes (+ salvage/extractCursor), payload'ы сохраняются ----
function makeParserSandbox() {
  const ctx = {
    logs: [], outers: [], payloads: [],
    TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    window: {},
    lastFrameParseFail: null,
    salvagingPartialFrame: false,
    historyFullByQuiet: false, reachedStart: false,
    quietDecisionMade: false, quietIncompleteNoStart: false,
    loggedMultiCursor: false,
    debugLog: function (level, msg) { ctx.logs.push(String(msg)); },
    handleOuter: function (outer, out, src) {
      ctx.outers.push(outer);
      ctx.payloads.push(JSON.stringify(outer));
      out.turns.push({ id: 'ok' + out.total, outer: outer, src: src });
      out.total++;
    }
  };
  const decls = [
    'classifyOpaque', 'edges8', 'findCursors', 'extractCursor',
    'isTurnLikeSpan', 'noteJsonChild', 'closeTruncatedJson', 'unescapeJsonLiteralPrefix',
    'extractTruncatedInner', 'handleSalvagedOuter', 'salvagePartialFrame',
    'parseByBytes', 'parseByLines', 'parseBatchExecute'
  ].map((n) => fnDecl(SRC, n)).join('\n');
  const epilogue = 'return { parseBatchExecute: parseBatchExecute, extractCursor: extractCursor };';
  const fn = new Function('ctx', 'with (ctx) {\n' + decls + '\n' + epilogue + '\n}');
  ctx.api = fn(ctx);
  return ctx;
}

// ---- фикстуры batchexecute (форма живого тела: заголовок + «длина\nJSON\n…») ----
const HEADER = ")]}'\n";
const CYR = 'Я';
const MARK_TAIL = 'КОНЕЦ-КАДРА-O52';
const CURSOR = 'Cg' + 'y'.repeat(46) + '=';

function turnStr(id, r1, q, a, ts, cursor) {
  const t = [null, [id, r1], [[q]], [[[null, [a]]]], [ts]];
  if (cursor) t.push(cursor);
  return JSON.stringify(t);
}
function outerOf(turns) {
  const inner = '[' + turns.join(',') + ']';
  return '[["wrb.fr","hNvQHb",' + JSON.stringify(inner) + ',null,null,null,"generic"]]';
}
function frame1() {
  return outerOf([turnStr('r_0000000000000001', 'r_0000000000000000',
    'Вопрос один: ' + CYR.repeat(500) + ' ' + MARK_TAIL, 'Ответ один', 1700000000, CURSOR)]);
}
function frame2() {
  return outerOf([turnStr('r_0000000000000021', 'r_0000000000000020',
    'Вопрос два: второй кадр', 'Ответ два ' + MARK_TAIL, 1700000001)]);
}
// Точная форма дефекта: объявленная длина кадра «перебегает» конец JSON и захватывает
// LF-разделитель + префикс длины СЛЕДУЮЩЕГО кадра (та же семья, что и живой обрыв границы).
function overrunBody() {
  const p1 = frame1();
  const p2 = frame2();
  const declaredN = p1.length + 1 + String(p2.length).length;
  return { raw: HEADER + declaredN + '\n' + p1 + '\n' + String(p2.length) + '\n' + p2 + '\n', p1: p1, p2: p2, declaredN: declaredN };
}
// Недобор: объявленная длина КОРОЧЕ JSON на k символов (значение не закрывается внутри среза).
function underrunBody(k) {
  const p1 = frame1();
  return { raw: HEADER + (p1.length - k) + '\n' + p1 + '\n', p1: p1, declaredN: p1.length - k };
}

describe('O-52 (D1): JSON парсится без ошибки — перебег границы кадра', () => {
  test('D1: форма дефекта воспроизведена (объявленный срез падает сообщением живого лога)', () => {
    const f = overrunBody();
    const declaredSlice = f.raw.slice(HEADER.length + String(f.declaredN).length + 1,
      HEADER.length + String(f.declaredN).length + 1 + f.declaredN);
    // ровно та ошибка, что в живом логе 2026-09-25: JSON цел, а за ним — разделитель и цифры
    expect(() => JSON.parse(declaredSlice)).toThrow(/Unexpected non-whitespace character after JSON/);
    expect(declaredSlice.length).toBeGreaterThan(f.p1.length);
    expect(declaredSlice.indexOf(f.p1)).toBe(0);
  });

  test('D1: реальный parseByBytes — ни одного parse-top fail, оба кадра доехали', () => {
    const f = overrunBody();
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(f.raw, 'vf5');

    expect(ctx.logs).toEqual([]);                 // ни одного parse-top fail
    expect(ctx.lastFrameParseFail).toBeNull();    // обрыв/сбой не зафиксирован
    expect(ctx.outers).toHaveLength(2);           // перебег не съел следующий кадр
    const turns1 = JSON.parse(ctx.outers[0][0][2]);
    const turns2 = JSON.parse(ctx.outers[1][0][2]);
    expect(JSON.stringify(turns1)).toContain(MARK_TAIL);
    expect(JSON.stringify(turns2)).toContain('Вопрос два: второй кадр');
    expect(JSON.stringify(turns2)).toContain(MARK_TAIL);
  });
});

describe('O-52 (D2): payload не содержит лишних символов', () => {
  test('D2: payload кадров побайтово равен исходному JSON (ни разделителей, ни префикса)', () => {
    const f = overrunBody();
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(f.raw, 'vf5');

    // payload'ы, ушедшие в handleOuter, БАЙТОВО равны исходным конвертам
    expect(ctx.payloads).toEqual([f.p1, f.p2]);
    expect(ctx.outers[0]).toEqual(JSON.parse(f.p1));
    expect(ctx.outers[1]).toEqual(JSON.parse(f.p2));
    // ни хвостового LF, ни префикса длины следующего кадра в payload'е нет
    expect(ctx.payloads[0].endsWith('\n')).toBe(false);
    expect(ctx.payloads[0]).not.toContain('\n' + String(f.p2.length));
  });

  test('D2 (source): границы добираются до конца значения, а не «до конца среза»', () => {
    const body = fnDecl(SRC, 'parseByBytes');
    expect(body).toContain('function extractJsonPayload(slice, rawStr, start, stop, maxOverrun) {');
    expect(body).toContain('function jsonValueEnd(str, from) {');
    expect(body).toContain('function jsonTailIsBlank(str, from) {');
    // (а) быстрый путь — тот же срез; (б) перебег — срез по концу значения
    expect(body).toContain('if (jsonTailIsBlank(slice, q)) return res;');
    expect(body).toContain('var cut = slice.slice(0, q);');
    // маркер конверта обязателен: иначе кадр отбрасывается выше и настоящий JSON терялся бы
    // (гейт вызова + два стража кандидата в extractJsonPayload)
    expect((body.match(/indexOf\('hNvQHb'\) !== -1/g) || []).length).toBe(3);
    // добирается только СИМВОЛЬНЫЙ путь (байтовая разметка legacy не тронута)
    expect(body).toContain('if (!hasUtf8) {');
    expect(body).toContain('extractJsonPayload(payloadStr, raw, posPayload, pos, JSON_FRAME_OVERRUN_MAX)');
  });
});

describe('O-52 (R1): регресс O-50 — символьный срез и быстрый путь целы', () => {
  test('R1: точная разметка в СИМВОЛАХ с кириллицей — payload байтово прежний, fail нет', () => {
    const p1 = frame1();
    const raw = HEADER + p1.length + '\n' + p1 + '\n';
    expect(p1.length).toBeGreaterThan(500); // кириллица: длина в символах, не в байтах
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'vf5');

    expect(ctx.logs).toEqual([]);
    expect(ctx.lastFrameParseFail).toBeNull();
    expect(ctx.outers).toHaveLength(1);
    expect(ctx.payloads[0]).toBe(p1);        // быстрый путь (а): срез не пересобирается
  });

  test('R1 (source): символьный срез, клэмп и одна точка разбора не переписаны', () => {
    const body = fnDecl(SRC, 'parseByBytes');
    expect(body).toContain('var payloadStr = hasUtf8 ? dec.decode(bytes.subarray(pos, end)) : raw.slice(pos, end);');
    expect(body).toContain('var end = pos + n; if (end > bytes.length) end = bytes.length;');
    expect(body).toContain('while (pos < bytes.length && guard++ < 200) {');
    expect(body).toContain('framingStrictScore(utf8Try).score > charFit.score');
    expect((body.match(/JSON\.parse\(/g) || []).length).toBe(1);
    expect((body.match(/handleOuter\(/g) || []).length).toBe(1);
    // структурный скан — без второго разбора JSON и без TextEncoder на символьном пути
    expect(body).toContain('if (c === 0x5C) { esc = true; continue; }');
  });
});

describe('O-52 (R2): guard добивания — margin ограничен, обрыв сохраняет семантику O-48', () => {
  test('R2: недобор в пределах margin восстанавливается (граница добирается за declaredN)', () => {
    const f = underrunBody(10);
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(f.raw, 'vf5');

    expect(ctx.logs).toEqual([]);
    expect(ctx.lastFrameParseFail).toBeNull();
    expect(ctx.outers).toHaveLength(1);
    expect(ctx.payloads[0]).toBe(f.p1);      // добрали РОВНО до конца значения
  });

  test('R2: обрыв тела сверх margin — исходный срез, один parse-top fail, диаг-числа прежние', () => {
    const p1 = frame1();
    const truncated = p1.slice(0, p1.length - 300);        // обрыв внутри строки хода
    // объявлена длина БОЛЬШЕ доступного в ОБОИХ пространствах (ни символы, ни байты не
    // подтверждают разметку → символьное пространство по приоритету O-50, clamped=1)
    const declaredN = Buffer.byteLength(p1, 'utf8') + 100;
    const raw = HEADER + declaredN + '\n' + truncated;     // тела дальше нет вовсе
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'vf5');

    const log = ctx.logs.join('\n');
    expect(ctx.outers).toHaveLength(0);                    // ложного успеха нет
    // строка кадрового парса (дальше фолбэк parseByLines перезаписывает lastFrameParseFail —
    // это штатное поведение O-48, диаг-числа самого parseByBytes читаем в логе)
    const bytesFail = log.split('\n').filter((l) => l.indexOf('parse-top fail (parseByBytes): ') !== -1)[0];
    expect(bytesFail).toBeDefined();
    expect(bytesFail).toContain('declaredN=' + declaredN);
    expect(bytesFail).toContain('clamped=1');              // объявленная длина больше доступного
    expect(bytesFail).toContain('availableBytes=' + Buffer.byteLength(truncated, 'utf8'));
    expect(bytesFail).toContain('rawLen=' + raw.length);
    expect(bytesFail).toContain('salvagedTurns=0');        // завершённых ходов в обрыве нет
    expect(ctx.lastFrameParseFail).not.toBeNull();         // сбой зафиксирован, тишины нет
  });

  test('R2: недобор с мусором после обрыва — добор не «дотягивается» и не выдаёт успех', () => {
    const p1 = frame1();
    const truncated = p1.slice(0, p1.length - 300);
    const declaredN = truncated.length + 5;                // clamped=0: срез влезает в тело
    const raw = HEADER + declaredN + '\n' + truncated + 'XXXXX' + '\n';
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'vf5');

    const log = ctx.logs.join('\n');
    expect(ctx.outers).toHaveLength(0);
    expect(log).toContain('parse-top fail (parseByBytes): ');
    expect(log).toContain('clamped=0');                    // это НЕ клэмп, а незакрытое значение
    expect(ctx.lastFrameParseFail.clamped).toBe(false);
  });

  test('R2 (source): margin = 256 СИМВОЛОВ, не больше declaredN + margin и не дальше тела', () => {
    const body = fnDecl(SRC, 'parseByBytes');
    expect(body).toContain('var JSON_FRAME_OVERRUN_MAX = 256;');
    expect(body).toContain('var limit = (typeof maxOverrun === \'number\' && maxOverrun >= 0) ? maxOverrun : JSON_FRAME_OVERRUN_MAX;');
    expect(body).toContain('var hard = to + limit; if (hard > rawStr.length) hard = rawStr.length;');
    expect(body).toContain('if (q2 > (to - from) && wideCut.indexOf(\'hNvQHb\') !== -1)');
    // добор — только когда значение НЕ закрылось в объявленном срезе
    expect(body.indexOf('var q = jsonValueEnd(slice, 0);')).toBeLessThan(body.indexOf('var hard = to + limit;'));
  });
});

describe('O-52 (R3): регресс O-48 (legacy-байтовая разметка) и O-51 не тронуты', () => {
  test('R3: байтовый обрыв кадра — clamped=1, диаг-числа в БАЙТАХ, tolerant-salvage целых ходов', () => {
    const t1 = turnStr('r_0000000000000011', 'r_0000000000000010',
      'Вопрос один: обрыв', CYR.repeat(40000), 1700000000, CURSOR);
    const t2 = turnStr('r_0000000000000021', 'r_0000000000000020',
      'Вопрос два: хвост обрезан', CYR.repeat(20000), 1700000001);
    const outer = outerOf([t1, t2]);
    const declaredN = Buffer.byteLength(outer, 'utf8');
    const raw = HEADER + declaredN + '\n' + outer.slice(0, outer.length - 200);

    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'vf5');

    expect(ctx.logs.join('\n')).toContain('clamped=1');
    expect(ctx.lastFrameParseFail.clamped).toBe(true);
    expect(ctx.lastFrameParseFail.declaredN).toBe(declaredN);
    expect(ctx.lastFrameParseFail.salvaged).toBe(1);       // завершённый ход спасён, оборванный нет
    expect(ctx.outers).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(ctx.outers[0][0][2]))).toContain('Вопрос один: обрыв');
    expect(JSON.stringify(JSON.parse(ctx.outers[0][0][2]))).not.toContain('Вопрос два');
  });

  test('R3: решение по базе O-51 и инвентарь пинов O-48/O-49/O-50 целы', () => {
    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const ingest = fnDecl(SRC, 'ingest');
    expect(ingest).toContain('if (fullRebuildFromVf5 && incomingIsSubsetOfBase) fullRebuildFromVf5 = false;');
    expect(ingest).toContain("reason = 'vf5-subset-no-reset'");
    const o48 = read('tests/adapters/o48-gemini-parse-fail-salvage.test.js');
    const o49 = read('tests/adapters/o49-gemini-deepresearch-lowconfidence.test.js');
    const o50 = read('tests/adapters/o50-gemini-char-frame-slice.test.js');
    expect((o48.match(/^\s*test\(/gm) || []).length).toBe(16);
    expect((o49.match(/^\s*test\(/gm) || []).length).toBe(15);
    expect((o50.match(/^\s*test\(/gm) || []).length).toBe(10);
    expect(read('core/export-manager.js')).toContain('aiCmCollectExportSource');
  });
});
