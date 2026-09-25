/**
 * O-48: `parseByBytes` обрывается на длинных JSON-ответах Gemini (>900KB) —
 * `Unterminated string in JSON at position 919934`, база не дозревает, 60s-таймаут →
 * `[LOW CONFIDENCE]` в имени файла (без convId, с моделью).
 *
 * Проверяются ровно согласованные с владельцем пункты (пины D1–D4 + R1/R3):
 *   D1 честная маркировка: parse-fail НЕ взводит полноту → база остаётся неполной,
 *      префикс `[LOW CONFIDENCE]_` и 60s-таймаут не переписаны (ложная полнота запрещена);
 *   D2 save/restore `pendingCursor` в ingest: при обрыве/нуле ходов курсор продолжения жив;
 *   D3 отдельный `reason='parse-fail'` в оракуле (watchdog + прогресс лоадера) — НЕ
 *      маскируется под `first-hash-mismatch`, ретрай-ломающий livelock не запускается;
 *   D4 tolerant-salvage: завершённые ходы и курсор вытащены из partial JSON, незавершённый
 *      ход отброшен ЦЕЛИКОМ (полуход в базу не вливается);
 *   R1 легитимный (целый) ответ проходит байтово прежним путём — payload-последовательность
 *      совпадает с legacy-алгоритмом, ни одного parse-top fail;
 *   R3 XSSI-гард `)]}'` цел (первые 4 байта срезаются).
 *   R2 (канонический инвариант GSA, O-32) — регресс полным сьютом, здесь не дублируется.
 *
 * Тесты исполняют РЕАЛЬНЫЕ тела core/gemini-intercept.js (конвенция fnDecl + песочница
 * `with`), а не копии логики. НЕ ТРОГАЕТСЯ: saveFloor (HWM), H9/H10-гейты, оракул
 * clean-end-stable (кроме добавленной parse-fail-ветки), версия/CHANGELOG.
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

const HEADER = ")]}'\n";
function frame(payload) {
  return Buffer.byteLength(payload, 'utf8') + '\n' + payload + '\n';
}

// Ход Gemini в реальной форме (utils/gemini-batchexecute-parser.js):
// [null, [id, r1], [[вопрос]], [[[null,[ответ]]]], [ts]] (+ opaque-курсор полем).
function turnStr(id, r1, q, a, ts, cursor) {
  const t = [null, [id, r1], [[q]], [[[null, [a]]]], [ts]];
  if (cursor) t.push(cursor);
  return JSON.stringify(t);
}
const CYR_A = 'А';
const CYR_D = 'Д';
// opaque-курсор: b64-подобный, 8..2000, не '$AVuibg' (classifyOpaque)
const CURSOR = 'Cg' + 'x'.repeat(46) + '=';

// ---- песочница: реальный парсер + salvage + extractCursor (все — из исходника) ----
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
    // эмуляция реального handleOuter: (а) запоминает восстановленный outer,
    // (б) как v74-ветка реального handleOuter, ПЫТАЕТСЯ взвести полноту — тест ниже
    // доказывает, что на восстановленном кадре она откатывается.
    handleOuter: function (outer, out, src) {
      ctx.outers.push(outer);
      out.turns.push({ id: 'salv' + out.total, outer: outer, src: src });
      out.total++;
      ctx.historyFullByQuiet = true;
      ctx.reachedStart = true;
      ctx.quietDecisionMade = true;
    }
  };
  const decls = [
    'classifyOpaque', 'edges8', 'findCursors', 'extractCursor',
    'isTurnLikeSpan', 'noteJsonChild', 'closeTruncatedJson', 'unescapeJsonLiteralPrefix',
    'extractTruncatedInner', 'handleSalvagedOuter', 'salvagePartialFrame',
    'parseByBytes', 'parseByLines', 'parseBatchExecute'
  ].map((n) => fnDecl(SRC, n)).join('\n');
  const epilogue = 'return { parseBatchExecute: parseBatchExecute, salvagePartialFrame: salvagePartialFrame,' +
    ' closeTruncatedJson: closeTruncatedJson, extractTruncatedInner: extractTruncatedInner,' +
    ' extractCursor: extractCursor };';
  const fn = new Function('ctx', 'with (ctx) {\n' + decls + '\n' + epilogue + '\n}');
  ctx.api = fn(ctx);
  return ctx;
}

// ---- песочница: реальный ingest (ранний путь: парс → fail/0 ходов → return 0) ----
function runIngest(overrides) {
  const ctx = Object.assign({
    logs: [],
    text: '',
    pendingCursor: 'CURSOR-ALIVE',
    lastVf5ActivityAt: 0,
    historyFullByQuiet: false,
    reachedStart: false,
    olderHistorySeen: false,
    quietActive: false,
    loaderRunningFor: null,
    loaderDoneMap: {},
    loggedErr: false,
    lastFrameParseFail: null,
    lastIngestParseFail: null,
    baseSize: function () { return 0; },
    getConvId: function () { return 'conv-o48'; },
    aiCmEnsureColdWindow: function () { },
    parseBatchExecute: function () { return []; },
    debugLog: function (level, msg) { ctx.logs.push(String(msg)); }
  }, overrides || {});
  const body = fnDecl(SRC, 'ingest') + '\n return ingest(text, { fromVirtualF5: true });';
  const fn = new Function('ctx', 'with (ctx) {' + body + ' }');
  ctx.result = fn(ctx);
  return ctx;
}

// ---- песочница: реальный вердикт watchdog-оракула ----
function runWatchdogDecision(probeParseFailed) {
  const ctx = {
    logs: [], restarts: 0,
    completenessWatchdogRetries: {}, watchdogFiredMap: {},
    historyFullByQuiet: true, reachedStart: true, reachedStartByScroll: false,
    quietIncompleteNoStart: false, quietDecisionMade: true,
    loaderDoneMap: { 'conv-w': true },
    debugLog: function (level, msg) { ctx.logs.push(String(msg)); },
    maybeStartLoader: function () { ctx.restarts++; }
  };
  const body = fnDecl(SRC, 'finishWatchdogDecision') +
    '\n return finishWatchdogDecision("conv-w", "hash-a", "", true, 0, ' + (probeParseFailed === true) + ');';
  const fn = new Function('ctx', 'with (ctx) {' + body + ' }');
  fn(ctx);
  return ctx;
}

// D4: длинный обрезанный кадр (>900KB raw) — 1 завершённый ход + оборванный второй.
// Сценарий ровно как в логе-свидетеле O-48: сервер объявил ПОЛНУЮ длину кадра, а тело
// ответа оборвано на середине строки хода #2 → `Unterminated string in JSON at position …`
// в самом конце доступного payload'а (клэмп: declaredN > availableBytes).
function bigTruncatedFrame() {
  const turn1 = turnStr('r_0000000000000011', 'r_0000000000000010',
    'Вопрос один: проверка обрыва', CYR_A.repeat(460000), 1700000000, CURSOR);
  const turn2 = turnStr('r_0000000000000021', 'r_0000000000000020',
    'Вопрос два: хвост обрезан', CYR_D.repeat(200000), 1700000001);
  const innerFull = '[' + turn1 + ',' + turn2 + ']';
  const outerFull = '[["wrb.fr","hNvQHb",' + JSON.stringify(innerFull) + ',null,null,null,"generic"]]';
  const declaredN = Buffer.byteLength(outerFull, 'utf8');        // объявлена полная длина кадра
  const outerPartial = outerFull.slice(0, outerFull.length - 300); // тело оборвано внутри хода #2
  return { raw: HEADER + declaredN + '\n' + outerPartial, outerPartial: outerPartial, declaredN: declaredN };
}

describe('O-48: диаг-числа обрыва кадра (клэмп vs TextEncoder-сдвиг)', () => {
  test('обрыв длинного кадра (>900KB): declaredN/availableBytes/reEncodedLen/rawLen в логе, clamped=1', () => {
    const big = bigTruncatedFrame();
    // граница дефекта: raw > 900KB — в БАЙТАХ (лог-свидетель O-48: raw 1064032 байт);
    // rawLen в диаг-строке — длина строки в UTF-16, потому и печатается вместе с reEncodedLen
    expect(Buffer.byteLength(big.raw, 'utf8')).toBeGreaterThan(900000);
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(big.raw, 'vf5');

    const log = ctx.logs.join('\n');
    expect(log).toContain('parse-top fail (parseByBytes): ');
    expect(log).toMatch(/Unterminated string|Unexpected end of JSON input/);
    expect(log).toContain('declaredN=' + big.declaredN);
    expect(log).toContain('availableBytes=' + Buffer.byteLength(big.outerPartial, 'utf8'));
    expect(log).toContain('reEncodedLen=' + Buffer.byteLength(big.raw, 'utf8'));
    expect(log).toContain('rawLen=' + big.raw.length);
    expect(log).toContain('clamped=1'); // объявленная длина > доступного → КЛЭМП (корень доказан числом)
    expect(ctx.lastFrameParseFail.where).toBe('parseByBytes');
    expect(ctx.lastFrameParseFail.clamped).toBe(true);
    expect(ctx.lastFrameParseFail.declaredN).toBe(big.declaredN);
    expect(ctx.lastFrameParseFail.availableBytes).toBe(Buffer.byteLength(big.outerPartial, 'utf8'));
  });

  test('rawLen ≠ reEncodedLen (кириллица) — числа отделяют сдвиг перекодирования от клэмпа', () => {
    const big = bigTruncatedFrame();
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(big.raw, 'vf5');
    // UTF-16-длина строки и байтовая длина после TextEncoder расходятся на кириллице:
    // именно эта пара (вместе с clamped) делает диагноз однозначным в живом логе.
    expect(ctx.lastFrameParseFail.rawLen).not.toBe(ctx.lastFrameParseFail.reEncodedLen);
    expect(ctx.lastFrameParseFail.reEncodedLen).toBeGreaterThan(ctx.lastFrameParseFail.rawLen);
  });

  test('лимит парсера НЕ поднят: потолок фреймов и клэмп длины — байтово прежние', () => {
    const body = fnDecl(SRC, 'parseByBytes');
    expect(body).toContain('while (pos < bytes.length && guard++ < 200) {');
    expect(body).toContain('var end = pos + n; if (end > bytes.length) end = bytes.length;');
    expect(body).toContain('handleOuter(JSON.parse(payloadStr), out, src)');
  });
});

describe('O-48 (D4): tolerant-salvage — завершённые ходы и курсор из partial JSON', () => {
  test('обрезанный ход отброшен ЦЕЛИКОМ; завершённый ход и курсор извлечены', () => {
    const big = bigTruncatedFrame();
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(big.raw, 'vf5');

    // salvage восстановил РОВНО один кадр — через штатный handleOuter
    expect(ctx.outers).toHaveLength(1);
    const salvOuter = ctx.outers[0];
    expect(salvOuter[0][1]).toBe('hNvQHb');
    const salvInner = salvOuter[0][2];
    const salvTurns = JSON.parse(salvInner); // восстановленный префикс — синтаксически целый
    expect(Array.isArray(salvTurns)).toBe(true);
    expect(salvTurns).toHaveLength(1); // незавершённый ход НЕ влит полуходом

    const salvJson = JSON.stringify(salvTurns);
    expect(salvJson).toContain('Вопрос один: проверка обрыва');
    expect(salvJson).toContain(CYR_A.repeat(200));
    expect(salvJson).not.toContain('Вопрос два');
    expect(salvJson).not.toContain(CYR_D.repeat(50)); // текст оборванного хода не просочился

    // курсор продолжения извлечён из восстановленного кадра (extractCursor — штатный)
    expect(ctx.api.extractCursor(salvTurns)).toBe(CURSOR);
    expect(ctx.lastFrameParseFail.salvaged).toBe(1); // счётчик в диаг-строке
    expect(ctx.logs.join('\n')).toContain('salvagedTurns=1');
  });

  test('нет завершённых ходов → не чиним ничего (поведение прежнее, пустой результат)', () => {
    const ctx = makeParserSandbox();
    // обрыв ВНУТРИ первого (единственного) хода: завершённых ходов нет
    const broken = '[null,["r_0000000000000001","r_0000000000000000"],[["вопрос"]],[[[null,["обрыв';
    expect(ctx.api.closeTruncatedJson(broken)).toBe('');
    expect(ctx.api.closeTruncatedJson('[1,2,3')).toBe('');
    expect(ctx.api.closeTruncatedJson('[[["a","b","c"],["d')).toBe('');
  });

  test('unit: точка отреза — граница последнего ЦЕЛОГО хода, скобки закрываются', () => {
    const ctx = makeParserSandbox();
    const t1 = turnStr('r_0000000000000001', 'r_0000000000000002', 'вопрос', 'ответ', 1);
    const text = '[' + t1 + ',[null,["r_2","r_1"],["обрыв';
    expect(ctx.api.closeTruncatedJson(text)).toBe('[' + t1 + ']');
    // inner-строка достаётся из частичного кадра (outer[0][2]) с расшифровкой escape'ов
    const outer = '[["wrb.fr","hNvQHb",' + JSON.stringify(text) + ',null';
    expect(ctx.api.extractTruncatedInner(outer)).toBe(text);
  });

  test('полнота на восстановленном кадре НЕ взводится (флаги откатываются, 5b/D1)', () => {
    const big = bigTruncatedFrame();
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(big.raw, 'vf5');
    // stub handleOuter эмулировал v74-ветку (взвёл полноту) — salvage обязан откатить
    expect(ctx.historyFullByQuiet).toBe(false);
    expect(ctx.reachedStart).toBe(false);
    expect(ctx.quietDecisionMade).toBe(false);
    expect(ctx.api.parseBatchExecute('', 'vf5')).toEqual([]);
    // гарантия держится на откате, а НЕ на правке v74-ветки: её байтовый пин
    // («е) прежние пути полноты — байтово как прежде», gemini-floor-confirmed) цел
    expect(SRC).toContain('          Array.isArray(turns) && turns.length > 0 && !historyFullByQuiet) {');
    expect(fnDecl(SRC, 'handleSalvagedOuter')).toContain('historyFullByQuiet = wasFull;');
    expect(fnDecl(SRC, 'handleSalvagedOuter')).toContain('quietIncompleteNoStart = wasNoStart;');
  });
});

describe('O-48 (D2): save/restore pendingCursor в ingest — курсор продолжения жив', () => {
  test('обрыв парса: pendingCursor восстановлен, lastIngestParseFail заполнен, полнота не взведена', () => {
    const ctx = runIngest({
      text: HEADER + '12345\n[["wrb.fr","hNvQHb","[[null,["обрыв',
      lastFrameParseFail: {
        where: 'parseByBytes', declaredN: 12345, availableBytes: 100,
        reEncodedLen: 2200, rawLen: 1100, clamped: true, salvaged: 1
      }
    });
    expect(ctx.result).toBe(0);
    expect(ctx.pendingCursor).toBe('CURSOR-ALIVE'); // D2: курсор НЕ уничтожен
    expect(ctx.lastIngestParseFail.convId).toBe('conv-o48');
    expect(ctx.lastIngestParseFail.salvaged).toBe(1);
    const log = ctx.logs.join('\n');
    expect(log).toContain('reason=parse-fail');
    expect(log).toContain('pendingCursor=alive');
    expect(log).not.toContain('first-hash-mismatch');
    expect(ctx.historyFullByQuiet).toBe(false); // D1/5b: полнота не взводится
  });

  test('ноль ходов БЕЗ обрыва (пустая hNvQHb-страница): курсор тоже восстановлен', () => {
    const ctx = runIngest({ text: HEADER + '12\n[["wrb.fr","hNvQHb","[]"]]',
      lastFrameParseFail: null, parseBatchExecute: function () { return []; } });
    expect(ctx.result).toBe(0);
    expect(ctx.pendingCursor).toBe('CURSOR-ALIVE');
    expect(ctx.lastIngestParseFail).toBeNull();
    expect(ctx.logs.join('\n')).not.toContain('reason=parse-fail');
  });

  test('source-пин: save ДО обнуления, restore в ветке fail/0-ходов и в catch', () => {
    const ingestSrc = fnDecl(SRC, 'ingest');
    const iSave = ingestSrc.indexOf('var savedPendingCursor = pendingCursor;');
    const iNull = ingestSrc.indexOf('if (!preservePagination) pendingCursor = null;');
    const iRestore = ingestSrc.indexOf('pendingCursor = savedPendingCursor;');
    const iZero = ingestSrc.indexOf('if (!parsed.length) {');
    expect(iSave).toBeGreaterThan(-1);
    expect(iNull).toBeGreaterThan(-1);
    expect(iSave).toBeLessThan(iNull);            // сохраняем ДО уничтожения
    expect(iRestore).toBeGreaterThan(iNull);      // восстанавливаем ПОСЛЕ парса
    expect(iRestore).toBeLessThan(iZero);         // и ДО раннего return 0
    expect((ingestSrc.match(/pendingCursor = savedPendingCursor;/g) || []).length).toBe(2); // + catch
  });
});

describe('O-48 (D3): reason=parse-fail в оракуле — не first-hash-mismatch', () => {
  test('обрыв кадра probe: reason=parse-fail, бюджет полноты и лоадер не тронуты', () => {
    const ctx = runWatchdogDecision(true);
    const log = ctx.logs.join('\n');
    expect(log).toContain('watchdog=fail reason=parse-fail');
    expect(log).not.toContain('first-hash-mismatch');
    expect(ctx.completenessWatchdogRetries['conv-w']).toBeUndefined(); // бюджет не тратится
    expect(ctx.restarts).toBe(0);                                     // livelock-рестарта нет
    expect(ctx.historyFullByQuiet).toBe(true);                        // ложная неполнота не объявлена
    expect(ctx.loaderDoneMap['conv-w']).toBe(true);                   // латч не снят
    expect(ctx.watchdogFiredMap['conv-w']).toBe(false);               // probe свободен для повтора
  });

  test('контроль: БЕЗ обрыва поведение прежнее (first-hash-mismatch + ретрай лоадера)', () => {
    const ctx = runWatchdogDecision(false);
    const log = ctx.logs.join('\n');
    expect(log).toContain('watchdog=fail reason=first-hash-mismatch');
    expect(log).not.toContain('reason=parse-fail');
    expect(ctx.completenessWatchdogRetries['conv-w']).toBe(1);
    expect(ctx.restarts).toBe(1);
    expect(ctx.historyFullByQuiet).toBe(false);
  });

  test('source-пины: probe-терминал и прогресс лоадера получают ветку parse-fail', () => {
    const src = SRC;
    // probe: ветка стоит ПЕРЕД объявлением терминала (0 новых ходов + нет курсора)
    const iProbeFail = src.indexOf('reason=parse-fail (probe)');
    const iProbeTerminal = src.indexOf('if (newOlder === 0 && !pCursorWide) {');
    expect(iProbeFail).toBeGreaterThan(-1);
    expect(iProbeTerminal).toBeGreaterThan(-1);
    expect(iProbeFail).toBeLessThan(iProbeTerminal);
    expect(src).toContain('var pParseFailed = !!lastFrameParseFail;');
    // watchdog: вердикт получает признак обрыва и ветку parse-fail
    expect(src).toContain('var probeParseFailed = false; // O-48: обрыв JSON-кадра probe-страницы');
    expect(src).toContain('function finishWatchdogDecision(convId, dbFirstHash, probeFirstHash, probeCursorExhausted, retries, probeParseFailed) {');
    expect(src).toContain('finishWatchdogDecision(convId, dbFirstHash, probeFirstHash, probeCursorExhausted, retries, probeParseFailed);');
    // прогресс лоадера (stable-stop): parse-fail-ветка стоит ДО подтверждения полноты
    const stable = src.slice(src.indexOf('var stableCheck74 = function () {'));
    const iStableFail = stable.indexOf('reason=parse-fail');
    const iStableConfirm = stable.indexOf('historyFullByQuiet = true;');
    expect(iStableFail).toBeGreaterThan(-1);
    expect(iStableConfirm).toBeGreaterThan(-1);
    expect(iStableFail).toBeLessThan(iStableConfirm);
    // оракул clean-end-stable не переписан: прочие ветки байтово на месте
    expect(src).toContain("if (lastLoaderDoneReason !== 'top') {");
    expect(src).toContain("debugLog('log', '[AI CM][completeness] oracle=clean-end-stable convId=' + convId +");
  });
});

describe('O-48 (D1): честная маркировка [LOW CONFIDENCE] не снята', () => {
  test('parse-fail-путь не взводит baseComplete; 60s-таймаут и префикс целы', () => {
    const exportSrc = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
    const optionsSrc = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
    // асимметрия «как есть» при baseComplete=0 → isLowConfidenceBase=true (O-48 ничего не меняет)
    expect(exportSrc).toContain('if (baseComplete !== true) {');
    expect(exportSrc).toContain("debugLog('log', '[AI CM][export] as-is baseComplete=0 → isLowConfidenceBase=true convId=' + cid);");
    expect(exportSrc).toContain('p.timer = setTimeout(fireDeferredTimeout, 60000);');
    expect(optionsSrc).toContain("var lowConfPrefix = (hist && hist.isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';");
    // ingest не объявляет полноту на обрыве: единственные присваивания historyFullByQuiet
    // в ingest-ветке O-48 — отсутствуют (полнота взводится только штатными путями)
    const ingestSrc = fnDecl(SRC, 'ingest');
    const head = ingestSrc.slice(0, ingestSrc.indexOf('if (!parsed.length) {'));
    expect(head).not.toContain('historyFullByQuiet = true');
    expect(head).not.toContain('reachedStart = true');
  });
});

describe('O-48 (R1/R3): легитимный ответ байтово прежний; XSSI-гард цел', () => {
  // legacy-алгоритм (побайтово прежний parseByBytes из тестового хелпера) — эталон R1
  function legacyPayloads(raw) {
    const bytes = Buffer.from(raw, 'utf8');
    let pos = 0;
    if (bytes.length >= 4 && bytes[0] === 0x29 && bytes[1] === 0x5D && bytes[2] === 0x7D && bytes[3] === 0x27) pos = 4;
    const dec = new TextDecoder('utf-8');
    const out = [];
    let guard = 0;
    while (pos < bytes.length && guard++ < 200) {
      while (pos < bytes.length && (bytes[pos] < 48 || bytes[pos] > 57)) pos++;
      if (pos >= bytes.length) break;
      let n = 0;
      while (pos < bytes.length && bytes[pos] >= 48 && bytes[pos] <= 57) { n = n * 10 + (bytes[pos] - 48); pos++; }
      if (n <= 0) { pos++; continue; }
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      let end = pos + n; if (end > bytes.length) end = bytes.length;
      const payloadStr = dec.decode(bytes.subarray(pos, end));
      pos = end;
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      out.push(payloadStr);
    }
    return out;
  }

  test('well-formed тело: payload-последовательность равна legacy, обрывов нет', () => {
    const inner1 = '[' + turnStr('r_0000000000000001', 'r_0000000000000002',
      'Вопрос с кириллицей, эмодзи 🚀 и кавычкой "внутри"', 'Ответ\nс переводом строки и \\ слэшем', 1699999999) + ']';
    const inner2 = '[' + turnStr('r_0000000000000003', 'r_0000000000000002',
      'Второй вопрос', 'Второй ответ', 1700000001) + ']';
    const payload1 = '[["wrb.fr","hNvQHb",' + JSON.stringify(inner1) + ',null,null,null,"generic"]]';
    const payload2 = '[["wrb.fr","other","[]",null,null,null,"generic"]]'; // без hNvQHb — пропуск
    const payload3 = '[["wrb.fr","hNvQHb",' + JSON.stringify(inner2) + ',null,null,null,"generic"]]';
    const raw = HEADER + frame(payload1) + frame(payload2) + frame(payload3);

    const ctx = makeParserSandbox();
    const turns = ctx.api.parseBatchExecute(raw, 'passive');
    expect(ctx.logs).toEqual([]);               // ни одного parse-top fail на целом теле
    expect(ctx.lastFrameParseFail).toBeNull();  // обрыв не зафиксирован
    expect(ctx.outers).toHaveLength(2);         // ровно два hNvQHb-кадра
    expect(turns).toHaveLength(2);
    // R1: срезка/позиционирование прежние — payload-тексты байтово те же, что у legacy
    expect(ctx.outers.map((o) => JSON.stringify(o)))
      .toEqual(legacyPayloads(raw).filter((p) => p.indexOf('hNvQHb') !== -1).map((p) => JSON.stringify(JSON.parse(p))));
    // R3: XSSI-префикс срезан (иная логика не появилась)
    expect(fnDecl(SRC, 'parseByBytes')).toContain("bytes[3] === 0x27) pos = 4;");
  });

  test('тело БЕЗ XSSI-заголовка и с хвостовым переводом строки: заголовок не обязателен', () => {
    const payload = '[["wrb.fr","hNvQHb","[[[1]]]",null,null,null,"generic"]]';
    const raw = frame(payload);
    const ctx = makeParserSandbox();
    ctx.api.parseBatchExecute(raw, 'passive');
    expect(ctx.logs).toEqual([]);
    expect(ctx.outers).toHaveLength(1);
    expect(ctx.lastFrameParseFail).toBeNull();
  });
});
