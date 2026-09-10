/**
 * v82 (context-transfer bug): живой pendingCursor + мёртвый лоадер (skip already-done /
 * cache-complete) → ни один прежний источник полноты не взводит baseComplete:
 * stableCheck74 из notifyLoaderState(false) требует loader done reason=top, которого при
 * скипнутом лоадере не будет → baseComplete=false вечно → auto-export skip not-complete.
 *
 * Фикс: независимый источник полноты floor-confirmed — stableFloorConfirm() + debounce
 * 5500мс из noteBaseCountChange(). Чат с floor и живым курсором, база стабильна >=5с и
 * не ниже пола → полнота подтверждается без лоадера.
 *
 * Из core/gemini-intercept.js извлекается РЕАЛЬНОЕ тело stableFloorConfirm /
 * noteBaseCountChange и исполняется в песочнице с `with` (конвенция tape-protect) —
 * тесты гоняют исходный код, а не копию логики.
 *
 * Проверяем:
 *   а) floor-confirmed взводит флаги при полном наборе гардов;
 *   б) floor отсутствует (count=0) → НЕ взводит;
 *   в) loaderRunningFor занят → НЕ взводит;
 *   г) lastBaseCount < floor.count → НЕ взводит;
 *   д) изменение count младше 5с → НЕ взводит;
 *   е) прежние пути no-older-history и loader-stable-stop — байтово как прежде.
 */
const fs = require('fs');
const path = require('path');

const coreSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
  'utf8'
);

// --- извлечение ТЕЛА функции (между внешними { }) из реального исходника ---
function extractBody(name) {
  const marker = 'function ' + name + '() {';
  const i = coreSrc.indexOf(marker);
  expect(i).toBeGreaterThan(-1); // функция найдена
  const open = i + marker.length - 1; // позиция внешней '{'
  let depth = 0;
  let j = open;
  for (; j < coreSrc.length; j++) {
    const ch = coreSrc[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return coreSrc.slice(open + 1, j);
}

// --- песочница: тело исполняется внутри with(ctx) + IIFE (return в теле валиден) ---
function runBody(body, ctx) {
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + body + '\n})(); }');
  fn(ctx);
  return ctx;
}

function baseCtx(overrides) {
  const now = Date.now();
  const ctx = {
    logs: [],
    emits: 0,
    convId: 'conv-floor-1',
    historyFullByQuiet: false,
    loaderRunningFor: null,
    quietActive: false,
    lastBaseCount: 120,
    floor: { count: 120, effectiveLen: 5000 },
    lastBaseCountChangeAt: now - 6000,     // старше 5с
    lastOlderNonPagAddAt: now - 6000,      // старше 5с
    reachedStart: false,
    quietIncompleteNoStart: true,
    oracleIncompleteSeen: { 'conv-floor-1': true },
    floorConfirmDebounceTimer: null
  };
  ctx.baseSize = function () { return ctx.lastBaseCount; };
  ctx.getConvId = function () { return ctx.convId; };
  ctx.loadFloor = function () { return ctx.floor; };
  ctx.emitBaseSnapshot = function () { ctx.emits++; };
  ctx.debugLog = function (level, msg) { ctx.logs.push(String(msg)); };
  return Object.assign(ctx, overrides || {});
}

describe('v82 floor-confirmed: независимый источник полноты (стабильный пол + мёртвый лоадер)', () => {
  const stableBody = extractBody('stableFloorConfirm');

  it('а) полный набор гардов → historyFullByQuiet/reachedStart взведены, oi-флаг снят, emit+лог', () => {
    const ctx = runBody(stableBody, baseCtx());
    expect(ctx.historyFullByQuiet).toBe(true);
    expect(ctx.reachedStart).toBe(true);
    expect(ctx.quietIncompleteNoStart).toBe(false);
    expect(ctx.oracleIncompleteSeen['conv-floor-1']).toBeUndefined();
    expect(ctx.emits).toBe(1);
    const joined = ctx.logs.join('\n');
    expect(joined).toContain('oracle=complete reason=floor-confirmed');
    expect(joined).toContain('convId=conv-floor-1 msgs=120 floor=120');
  });

  it('б) floor отсутствует (count=0 или null) → НЕ взводит', () => {
    const c1 = runBody(stableBody, baseCtx({ floor: { count: 0, effectiveLen: 0 } }));
    expect(c1.historyFullByQuiet).toBe(false);
    expect(c1.emits).toBe(0);
    expect(c1.logs.join('\n')).not.toContain('reason=floor-confirmed');
    const c2 = runBody(stableBody, baseCtx({ floor: null }));
    expect(c2.historyFullByQuiet).toBe(false);
    expect(c2.emits).toBe(0);
  });

  it('в) loaderRunningFor занят / quietActive=true / convId пуст → НЕ взводит', () => {
    const c1 = runBody(stableBody, baseCtx({ loaderRunningFor: 'conv-floor-1' }));
    expect(c1.historyFullByQuiet).toBe(false);
    expect(c1.emits).toBe(0);
    const c2 = runBody(stableBody, baseCtx({ quietActive: true }));
    expect(c2.historyFullByQuiet).toBe(false);
    expect(c2.emits).toBe(0);
    const c3 = runBody(stableBody, baseCtx({ convId: '' }));
    expect(c3.historyFullByQuiet).toBe(false);
    expect(c3.emits).toBe(0);
  });

  it('в+) historyFullByQuiet уже true → идемпотентно, повторного emit нет', () => {
    const ctx = runBody(stableBody, baseCtx({ historyFullByQuiet: true }));
    expect(ctx.emits).toBe(0);
    expect(ctx.logs.join('\n')).not.toContain('reason=floor-confirmed');
  });

  it('г) lastBaseCount < floor.count → НЕ взводит', () => {
    const ctx = runBody(stableBody, baseCtx({ lastBaseCount: 80 }));
    expect(ctx.historyFullByQuiet).toBe(false);
    expect(ctx.reachedStart).toBe(false);
    expect(ctx.emits).toBe(0);
    expect(ctx.logs.join('\n')).not.toContain('reason=floor-confirmed');
  });

  it('д) изменение count младше 5с / старшие добавления младше 5с → НЕ взводит', () => {
    const c1 = runBody(stableBody, baseCtx({ lastBaseCountChangeAt: Date.now() - 3000 }));
    expect(c1.historyFullByQuiet).toBe(false);
    expect(c1.emits).toBe(0);
    const c2 = runBody(stableBody, baseCtx({ lastOlderNonPagAddAt: Date.now() - 3000 }));
    expect(c2.historyFullByQuiet).toBe(false);
    expect(c2.emits).toBe(0);
  });
});

describe('v82 debounce-триггер в noteBaseCountChange (5500мс, clearTimeout предыдущего)', () => {
  const nbBody = extractBody('noteBaseCountChange');
  const stableBody = extractBody('stableFloorConfirm');
  // Тело исполняется как function-EXPRESSION, создаваемая ВНУТРИ with(ctx): её [[Environment]]
  // — объектная среда ctx, поэтому присваивания свободных переменных (historyFullByQuiet и пр.)
  // пишут в ctx, как настоящие переменные замыкания в исходнике (function declaration внутри
  // with hoist мимо объектной среды и мутировали бы global — конвенция tape-protect).
  const declStable = 'var stableFloorConfirm = function () {' + stableBody + '};';
  const declNb = 'var noteBaseCountChange = function () {' + nbBody + '};';

  it('два вызова подряд: debounce сбрасывает предыдущий таймер, ставит новый 5500мс', () => {
    const ctx = baseCtx();
    ctx.setTimeout = function (fn, ms) { ctx.calls = ctx.calls || []; ctx.calls.push({ fn: fn, ms: ms }); return ctx.calls.length; };
    ctx.clearTimeout = function () { ctx.cleared = (ctx.cleared || 0) + 1; };
    const fn = new Function('ctx', 'with (ctx) {\n' + declStable + '\n' + declNb + '\n  noteBaseCountChange();\n  noteBaseCountChange();\n}');
    fn(ctx);
    expect(ctx.cleared).toBe(1);      // предыдущий таймер отменён
    expect(ctx.calls).toHaveLength(2);
    expect(ctx.calls[1].ms).toBe(5500);
  });

  it('таймер вызывает именно stableFloorConfirm (callback функции, не чужой код)', () => {
    const ctx = baseCtx();
    let captured = null;
    ctx.setTimeout = function (fn, ms) { captured = fn; return 1; };
    ctx.clearTimeout = function () {};
    const fn = new Function('ctx', 'with (ctx) {\n' + declStable + '\n' + declNb + '\n  noteBaseCountChange();\n}');
    fn(ctx);
    expect(typeof captured).toBe('function');
    // имя функции — stableFloorConfirm (в with-скоупе она видна)
    expect(captured.name).toBe('stableFloorConfirm');
  });

  it('истечение debounce на стабильной базе → floor-confirmed взводит полноту (auto-export gate)', () => {
    // 5.5с тишины прошли: база стабильна и >= floor → вызов stableFloorConfirm() взводит флаги
    const ctx = baseCtx({ lastBaseCountChangeAt: Date.now() - 7000 });
    ctx.captured = null;
    ctx.setTimeout = function (fn, ms) { ctx.captured = fn; return 1; };
    ctx.clearTimeout = function () {};
    const fn = new Function('ctx', 'with (ctx) {\n' + declStable + '\n' + declNb + '\n  noteBaseCountChange();\n  ctx.captured();\n}');
    fn(ctx);
    expect(ctx.historyFullByQuiet).toBe(true);
    expect(ctx.reachedStart).toBe(true);
    expect(ctx.emits).toBe(1);
    expect(ctx.logs.join('\n')).toContain('oracle=complete reason=floor-confirmed');
  });
});

describe('е) прежние пути полноты — байтово как прежде (НЕ тронуты)', () => {
  it('no-older-history (первый пассивный снимок без курсора) байтово идентичен', () => {
    const noOlder = '' +
      '      if ((src === \'passive\' || src === \'vf5\') && !pendingCursor && !olderHistorySeen &&\n' +
      '          Array.isArray(turns) && turns.length > 0 && !historyFullByQuiet) {\n' +
      '        historyFullByQuiet = true;\n' +
      '        reachedStart = true;\n' +
      '        quietIncompleteNoStart = false;\n' +
      '        quietDecisionMade = true; // фолбэк-автоскролл не нужен — история полная\n' +
      "        debugLog('log', '[AI CM][completeness] oracle=complete reason=no-older-history turns=' + turns.length +\n" +
      "          ' convId=' + (getConvId() || '(none)'));\n" +
      '      }';
    expect(coreSrc).toContain(noOlder);
  });

  it('loader-stable-stop (stableCheck74 в notifyLoaderState) байтово идентичен', () => {
    expect(coreSrc).toContain("            if (lastLoaderDoneReason !== 'top') {");
    expect(coreSrc).toContain("              debugLog('log', '[AI CM][completeness] oracle=incomplete reason=loader-max-not-top convId=' + convId +");
    expect(coreSrc).toContain("              debugLog('log', '[AI CM][completeness] oracle=incomplete reason=below-floor convId=' + convId +");
    expect(coreSrc).toContain("            debugLog('log', '[AI CM][completeness] oracle=complete reason=loader-stable-stop convId=' + convId +");
    expect(coreSrc).toContain('        stableCheck74();');
    expect(coreSrc).toContain('        setTimeout(stableCheck74, 5000); // повторная проверка через 5с тишины');
  });

  it('stableFloorConfirm объявлена в v74-трекинге, а НЕ внутри notifyLoaderState', () => {
    const nlStart = coreSrc.indexOf('function notifyLoaderState(');
    // notifyLoaderState — короткая функция; до её конца (до dispatch ai-cm-loader-state)
    const nlEnd = coreSrc.indexOf("window.dispatchEvent(new CustomEvent('ai-cm-loader-state'", nlStart);
    const nlBody = coreSrc.slice(nlStart, nlEnd);
    expect(nlBody).not.toContain('stableFloorConfirm');
    expect(nlBody).not.toContain('reason=floor-confirmed');
    // floor-confirmed живёт отдельно, рядом с v74 noteBaseCountChange
    const fcStart = coreSrc.indexOf('function stableFloorConfirm()');
    expect(fcStart).toBeGreaterThan(-1);
    expect(coreSrc.slice(0, nlStart)).toContain('function stableFloorConfirm()');
  });

  it('floor-применение v78 и quiet/paginate-пути байтово идентичны', () => {
    expect(coreSrc).toContain('    // v78: жёсткий пол — при floorCount > baseCount бейдж/токены НЕ опускаются ниже пола');
    expect(coreSrc).toContain("        ' floorApplied=true baseComplete=' + baseComplete);");
    expect(coreSrc).toContain('  function finishQuiet(success, reason) {');
    expect(coreSrc).toContain('    quietDecisionMade = false;');
  });
});

