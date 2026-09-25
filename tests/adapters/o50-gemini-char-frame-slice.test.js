/**
 * O-50: префикс длины кадра batchexecute дан в СИМВОЛАХ декодированной строки, а
 * `parseByBytes` перекодировал raw в UTF-8-байты (TextEncoder) и резал n БАЙТ →
 * системное усечение кирилличных кадров («Unterminated string» при `clamped=0`).
 *
 * Лог-свидетель владельца 2026-09-25 15:20:35.756–757: `declaredN=1093974` = `rawLen(1094077)`
 * минус заголовок, `clamped=0`, `availableBytes=1258163` = `reEncodedLen(1258177)` минус
 * заголовок, `position=947582` — полный JSON с Deep Research присутствовал в raw ЦЕЛИКОМ
 * («сеть отдала обрыв» опровергнуто числами). Второй симптом того же прогона: автоэкспорт по
 * 60s-таймауту сработал (эмит 4 сообщений), но `download trigger` отсутствует — кандидат в
 * отдельный дефект; в O-50 закрыт read-only измерением (диаг-строка под гейтом aiCmDebug).
 *
 * Пины (O-50):
 *   C1 срез кадра — В СИМВОЛЬНОМ пространстве: кадр с кириллицей, размеченный в СИМВОЛАХ,
 *      парсится целиком (хвостовой маркер на месте), ни одного parse-top fail;
 *   C2 репро дефекта: старая байтовая нарезка того же кадра обрывается при `clamped=0`
 *      (единица разметки, а не обрыв тела, — корень O-50);
 *   C3 несколько символьных кадров с кириллицей: порядок и полнота payload'ов сохранены;
 *   C4 source-пины: символьный срез — основной путь (`raw.slice`), TextEncoder только в
 *      legacy-ветке ПОСЛЕ структурной проверки разметки; точка JSON.parse/handleOuter одна;
 *      байтовые лимиты/клэмп O-48 текстуально целы;
 *   R1 регресс O-48: байтовая разметка (в т.ч. с кириллицей) распознаётся структурно и
 *      парсится без единого parse-top fail (payload'ы равны исходным);
 *   R2 регресс O-48: обрыв байтового кадра — диаг-числа в БАЙТАХ (`declaredN/availableBytes/
 *      reEncodedLen/rawLen/clamped=1`) и tolerant-salvage завершённых ходов (полуход не влит);
 *   R3 инвентарь: пины O-48 (16) и O-49 (15) в файлах не тронуты;
 *   И1 измерение auto-timeout-пути: диаг-строка `o50-timeout-download` под гейтом aiCmDebug
 *      фиксирует `download=absent` + причину; гейта/хелпера нет — поведения нет, строки нет;
 *   И2 поведение таймаута не изменилось: снимок истории пишется, `[LOW CONFIDENCE]_`-маркировка
 *      (aiCmLowConfidenceByConv) прежняя, строка `deferred-timeout(60s), exporting as-is` цела.
 *
 * Тесты исполняют РЕАЛЬНЫЕ тела core/gemini-intercept.js и core/export-manager.js (конвенция
 * fnDecl + песочница `with`), а не копии логики. НЕ ТРОГАЕТСЯ: tolerant-salvage O-48, единая
 * точка сбора O-49, санация O-20/O-40/O-42, D-O41, badge-метрика O-47, CHANGELOG/версия.
 */
const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');
const EXPORT_MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');

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

// ---- песочница: реальный parseByBytes (+ salvage/extractCursor) ----
function makeParserSandbox() {
  const ctx = {
    logs: [], outers: [],
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

// ---- песочница: реальный aiCmScheduleDeferredHistWrite (auto-timeout 60s) ----
function runDeferredTimeout(overrides) {
  const ctx = Object.assign({
    logs: [], diagCalls: [], writes: 0, captured: null,
    aiCmPendingHistWrite: null,
    aiCmLoaderRunningByConv: {}, aiCmCursorLiveByConv: {}, aiCmLowConfidenceByConv: {},
    baseComplete: false, lastEmitConvId: 'conv-o50',
    autoExportFired: {}, aiCmAutoExportNamesUsed: {},
    aiCmCancelDeferredHistWrite: function () { },
    getCurrentConvId: function () { return 'conv-o50'; },
    aiCmWriteCurrentHistory: function () { ctx.writes++; },
    aiCmDiagLine: function (tag, fields) { ctx.diagCalls.push({ tag: tag, fields: fields }); return true; },
    debugLog: function (level, msg) { ctx.logs.push(String(msg)); },
    setTimeout: function (cb) { ctx.captured = cb; return 1; },
    clearTimeout: function () { }
  }, overrides || {});
  const body = fnDecl(EXPORT_MGR_SRC, 'aiCmScheduleDeferredHistWrite') +
    '\n aiCmScheduleDeferredHistWrite("conv-o50");';
  const fn = new Function('ctx', 'with (ctx) {' + body + ' }');
  fn(ctx);
  return ctx;
}

// ---- фикстуры кадров batchexecute ----
const HEADER = ")]}'\n";
const CYR_A = 'А';
const CYR_D = 'Д';
const MARK_HEAD = 'НАЧАЛО-ПОЛНОГО-КАДРА';
const MARK_TAIL = 'КОНЕЦ-ПОЛНОГО-КАДРА';
const CURSOR = 'Cg' + 'x'.repeat(46) + '=';

// Ход Gemini: [null, [id, r1], [[вопрос]], [[[null,[ответ]]]], [ts]] (+ opaque-курсор полем).
function turnStr(id, r1, q, a, ts, cursor) {
  const t = [null, [id, r1], [[q]], [[[null, [a]]]], [ts]];
  if (cursor) t.push(cursor);
  return JSON.stringify(t);
}
function outerOf(turns) {
  const inner = '[' + turns.join(',') + ']';
  return '[["wrb.fr","hNvQHb",' + JSON.stringify(inner) + ',null,null,null,"generic"]]';
}
// O-50: разметка в СИМВОЛАХ (как в живом теле — declaredN ≈ rawLen минус заголовок).
function charFramed(payload) { return payload.length + '\n' + payload + '\n'; }
// legacy-разметка в БАЙТАХ (фикстуры O-48 / старые сборки).
function byteFramed(payload) { return Buffer.byteLength(payload, 'utf8') + '\n' + payload + '\n'; }

function bigCyrOuter() {
  const q = MARK_HEAD + CYR_A.repeat(120000) + MARK_TAIL;
  return outerOf([turnStr('r_0000000000000001', 'r_0000000000000000', q, 'ответ ' + MARK_TAIL, 1700000000, CURSOR)]);
}
function secondCyrOuter() {
  const q = 'Второй вопрос: ' + CYR_D.repeat(30000) + ' ХВОСТ-2';
  return outerOf([turnStr('r_0000000000000021', 'r_0000000000000020', q, 'Второй ответ', 1700000001)]);
}

// Обрыв байтового кадра: declaredN = байтовая длина ПОЛНОГО кадра, тело оборвано внутри хода #2.
function byteFramedTruncated() {
  const turn1 = turnStr('r_0000000000000011', 'r_0000000000000010',
    'Вопрос один: проверка обрыва', CYR_A.repeat(40000), 1700000000, CURSOR);
  const turn2 = turnStr('r_0000000000000021', 'r_0000000000000020',
    'Вопрос два: хвост обрезан', CYR_D.repeat(20000), 1700000001);
  const outerFull = outerOf([turn1, turn2]);
  const declaredN = Buffer.byteLength(outerFull, 'utf8');
  const outerPartial = outerFull.slice(0, outerFull.length - 200);
  return { raw: HEADER + declaredN + '\n' + outerPartial, outerPartial: outerPartial, declaredN: declaredN };
}

describe('O-50 (C1/C2): символьная единица префикса длины — срез в СИМВОЛАХ, не в байтах', () => {
  test('C1: кадр с кириллицей, размеченный в СИМВОЛАХ, парсится ЦЕЛИКОМ (обрыва нет)', () => {
    const outer = bigCyrOuter();
    const raw = HEADER + charFramed(outer);
    // фикстура действительно многобайтовая: символов меньше, чем байт UTF-8
    expect(Buffer.byteLength(outer, 'utf8')).toBeGreaterThan(outer.length * 1.5);

    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'vf5');

    expect(ctx.logs).toEqual([]);                 // ни одного parse-top fail
    expect(ctx.lastFrameParseFail).toBeNull();    // обрыв не зафиксирован
    expect(ctx.outers).toHaveLength(1);
    const turns = JSON.parse(ctx.outers[0][0][2]);
    expect(turns).toHaveLength(1);
    const inner = JSON.stringify(turns);
    expect(inner).toContain(MARK_HEAD);
    expect(inner).toContain(MARK_TAIL);           // хвост кадра доехал — усечения нет
    expect(inner).toContain(CYR_A.repeat(200));
  });

  test('C2: та же разметка, но БАЙТОВЫЙ срез (legacy) обрывается при clamped=0 — корень в единице', () => {
    const outer = bigCyrOuter();
    const declaredN = outer.length;               // O-50: префикс = число СИМВОЛОВ payload'а
    const raw = HEADER + charFramed(outer);
    const bytes = Buffer.from(raw, 'utf8');
    const pos = HEADER.length + String(declaredN).length + 1; // ASCII-заголовок: байт == символ

    // legacy резал declaredN БАЙТ: clamped=0 (длина влезает в тело), но payload усечён
    expect(pos + declaredN).toBeLessThan(bytes.length);
    const legacyCut = bytes.subarray(pos, pos + declaredN).toString('utf8');
    expect(legacyCut.length).toBeLessThan(outer.length);
    expect(() => JSON.parse(legacyCut)).toThrow(/Unterminated string|Unexpected end of JSON input/);

    // новая единица: тот же кадр проходит целиком (C1) — регрессия невозможна молча
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'vf5');
    expect(ctx.lastFrameParseFail).toBeNull();
    expect(ctx.outers).toHaveLength(1);
  });

  test('C3: несколько символьных кадров с кириллицей — порядок и полнота payload\'ов сохранены', () => {
    const o1 = bigCyrOuter();
    const o2 = secondCyrOuter();
    const raw = HEADER + charFramed(o1) + charFramed(o2);
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'raw');

    expect(ctx.logs).toEqual([]);
    expect(ctx.outers).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(ctx.outers[0][0][2]))).toContain(MARK_TAIL);
    expect(JSON.stringify(JSON.parse(ctx.outers[1][0][2]))).toContain('ХВОСТ-2');
  });

  test('C4: source-пины — символьный срез основной, TextEncoder только в legacy-ветке', () => {
    const body = fnDecl(SRC, 'parseByBytes');
    // основной путь: payload — string.slice; коды символов = пространство индексов
    expect(body).toContain('var payloadStr = hasUtf8 ? dec.decode(bytes.subarray(pos, end)) : raw.slice(pos, end);');
    expect(body).toContain('var charCodes = charCodeView(raw);');
    expect(body).toContain('function charCodeView(s) {');
    expect(body).toContain('new Uint16Array(s.length)');
    // байтовая ветка включается ТОЛЬКО после структурной проверки разметки (без JSON.parse)
    expect(body).toContain('if (!charFit.complete) {');
    expect(body).toContain('function framingStrictScore(seq) {');
    expect(body).toContain('framingStrictScore(utf8Try).score > charFit.score');
    expect(body.indexOf('new TextEncoder()')).toBeGreaterThan(body.indexOf('var charCodes = charCodeView(raw);'));
    // одна точка парса кадра (двух проходов с двойным salvage/дублями нет)
    expect((body.match(/JSON\.parse\(/g) || []).length).toBe(1);
    expect((body.match(/handleOuter\(/g) || []).length).toBe(1);
    // лимиты и клэмп O-48 текстуально целы (пины 16 не переписаны)
    expect(body).toContain('while (pos < bytes.length && guard++ < 200) {');
    expect(body).toContain('var end = pos + n; if (end > bytes.length) end = bytes.length;');
    expect(body).toContain("bytes[3] === 0x27) pos = 4;");
    expect(SRC).toContain('salvagedTurns=');
  });
});

describe('O-50 (R1/R2): регресс O-48 через новый парсер — байтовая разметка распознаётся', () => {
  test('R1: байтовая разметка с кириллицей парсится без единого parse-top fail', () => {
    const o1 = bigCyrOuter();
    const o2 = secondCyrOuter();
    expect(Buffer.byteLength(o1, 'utf8')).toBeGreaterThan(o1.length * 1.5); // байт != символов
    const raw = HEADER + byteFramed(o1) + byteFramed(o2);

    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'passive');

    expect(ctx.logs).toEqual([]);
    expect(ctx.lastFrameParseFail).toBeNull();
    expect(ctx.outers).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(ctx.outers[0][0][2]))).toContain(MARK_TAIL);
    expect(JSON.stringify(JSON.parse(ctx.outers[1][0][2]))).toContain('ХВОСТ-2');
  });

  test('R2: обрыв байтового кадра — диаг-числа в БАЙТАХ, clamped=1, salvage целых ходов', () => {
    const big = byteFramedTruncated();
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(big.raw, 'vf5');

    const log = ctx.logs.join('\n');
    expect(log).toContain('parse-top fail (parseByBytes): ');
    expect(log).toContain('declaredN=' + big.declaredN);
    expect(log).toContain('availableBytes=' + Buffer.byteLength(big.outerPartial, 'utf8'));
    expect(log).toContain('reEncodedLen=' + Buffer.byteLength(big.raw, 'utf8'));
    expect(log).toContain('rawLen=' + big.raw.length);
    expect(log).toContain('clamped=1');
    expect(ctx.lastFrameParseFail.where).toBe('parseByBytes');
    expect(ctx.lastFrameParseFail.clamped).toBe(true);
    expect(ctx.lastFrameParseFail.declaredN).toBe(big.declaredN);
    expect(ctx.lastFrameParseFail.availableBytes).toBe(Buffer.byteLength(big.outerPartial, 'utf8'));
    // tolerant-salvage: завершённый ход доехал, оборванный отброшен ЦЕЛИКОМ
    expect(ctx.outers).toHaveLength(1);
    expect(ctx.lastFrameParseFail.salvaged).toBe(1);
    const salvTurns = JSON.parse(ctx.outers[0][0][2]);
    expect(salvTurns).toHaveLength(1);
    expect(JSON.stringify(salvTurns)).toContain('Вопрос один: проверка обрыва');
    expect(JSON.stringify(salvTurns)).not.toContain('Вопрос два');
  });

  test('R3: инвентарь пинов — O-48 (16) и O-49 (15) в файлах не тронуты', () => {
    const o48 = fs.readFileSync(path.join(ROOT, 'tests', 'adapters', 'o48-gemini-parse-fail-salvage.test.js'), 'utf8');
    const o49 = fs.readFileSync(path.join(ROOT, 'tests', 'adapters', 'o49-gemini-deepresearch-lowconfidence.test.js'), 'utf8');
    expect((o48.match(/^\s*test\(/gm) || []).length).toBe(16);
    expect((o49.match(/^\s*test\(/gm) || []).length).toBe(15);
    expect(o48).toContain("bytes[3] === 0x27) pos = 4;");
    expect(o48).toContain('handleOuter(JSON.parse(payloadStr), out, src)');
    expect(o49).toContain('aiCmCollectExportSource');
  });
});

describe('O-50 (И1/И2): измерение отсутствия download trigger на auto-timeout-пути 15:20:35', () => {
  test('И1+И2: диаг-строка o50-timeout-download с download=absent; снимок и маркировка прежние', () => {
    const ctx = runDeferredTimeout();
    expect(typeof ctx.captured).toBe('function');
    ctx.captured(); // 60s-таймаут сработал (15:20:35 в логе-свидетеле)

    const o50 = ctx.diagCalls.filter((c) => c.tag === 'o50-timeout-download');
    expect(o50).toHaveLength(1);
    expect(o50[0].fields.download).toBe('absent');
    expect(o50[0].fields.reason).toBe('no-download-point-on-timeout-path');
    expect(o50[0].fields.path).toBe('deferred-timeout-60s');
    expect(o50[0].fields.convId).toBe('conv-o50');
    expect(o50[0].fields.asIs).toBe(1);                       // baseComplete=0 → as-is
    expect(o50[0].fields.snapshot).toBe('write-current-history');
    expect(o50[0].fields.fired).toBe(0);
    expect(o50[0].fields.dlNames).toBe(0);
    // И2: поведение таймаута не изменилось
    expect(ctx.writes).toBe(1);
    expect(ctx.aiCmLowConfidenceByConv['conv-o50']).toBe(true);
    const log = ctx.logs.join('\n');
    expect(log).toContain('deferred-timeout(60s), exporting as-is');
    expect(log).toContain('as-is baseComplete=0 → isLowConfidenceBase=true');
  });

  test('И1 (гейт): хелпера aiCmDiagLine нет — строки нет, исключения нет, запись прежняя', () => {
    const ctx = runDeferredTimeout({ aiCmDiagLine: undefined });
    expect(ctx.diagCalls).toHaveLength(0);
    expect(() => ctx.captured()).not.toThrow();
    expect(ctx.writes).toBe(1);
    expect(ctx.aiCmLowConfidenceByConv['conv-o50']).toBe(true);
  });

  test('И1 (source-пин): строка стоит на auto-timeout-пути ДО записи снимка и под typeof-гардом', () => {
    const fn = EXPORT_MGR_SRC.slice(
      EXPORT_MGR_SRC.indexOf('function aiCmScheduleDeferredHistWrite'),
      EXPORT_MGR_SRC.indexOf('function loadAutoExportSettings')
    );
    const iDiag = fn.indexOf("aiCmDiagLine('o50-timeout-download'");
    const iGuard = fn.indexOf("if (typeof aiCmDiagLine === 'function') {");
    const iWrite = fn.indexOf('try { aiCmWriteCurrentHistory(); }');
    expect(iDiag).toBeGreaterThan(-1);
    expect(iGuard).toBeGreaterThan(-1);
    expect(iWrite).toBeGreaterThan(-1);
    expect(iGuard).toBeLessThan(iDiag);
    expect(iDiag).toBeLessThan(iWrite);
    expect(fn).toContain("download: 'absent'");
    expect(fn).toContain("reason: 'no-download-point-on-timeout-path'");
    // гейты/латчи O-48 и silent-catch R3 не переписаны
    expect(fn).toContain('deferred-timeout(60s), exporting as-is');
    expect(fn).toContain('silent-catch aiCmScheduleDeferredHistWrite(fireDeferredTimeout/export): ');
    expect(fn).not.toContain('throw ');
  });
});
