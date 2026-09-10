/**
 * v1.14.2 (COLLAPSE-GUARD): коллапс скроллера ≠ физический верх.
 * Баг 03.09 11:35: во время скрытого прогона лоадера Gemini схлопнул скроллер
 * (scrollHeight 100933→744), scrollTop стал ≤8px тривиально → v65-гейт дал
 * done reason='top' при base=80 < floor=124 → stable-stop оракул взвёл baseComplete
 * на УСЕЧЁННОЙ базе → неполный экспорт.
 *
 * Фикс: per-run maxScrollHSeen (сброс в старте прогона; на каждой итерации max) +
 * чистый хелпер GeminiInterceptLogic.collapseGuardVerdict(state) — условие коллапса:
 * scrollH < max(3000, maxScrollHSeen*0.5) И baseCount < floorCount → doneReason='collapse'
 * + перезапуск лоадера через 8с (бюджет collapseRetries≤2; сброс при смене convId
 * и при base>=floor). stableCheck74 и fallback-scroll-top открывают полноту ТОЛЬКО
 * при 'top' — 'collapse' уходит в incomplete.
 *
 * Из core/gemini-intercept.js извлекается РЕАЛЬНОЕ тело collapse-гарда и исполняется
 * в песочнице с `with` (конвенция floor-confirmed / tape-protect) — тесты гоняют
 * исходный код, а не копию логики.
 */
const fs = require('fs');
const path = require('path');

const GIL = require('../../utils/gemini-intercept-logic.js');

const coreSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
  'utf8'
);

// --- извлечение ТЕЛА collapse-гарда (между внешними { } if (__cvCollapsed)) из реального исходника ---
function extractCollapseBody() {
  const marker = 'if (__cvCollapsed) {';
  const i = coreSrc.indexOf(marker);
  expect(i).toBeGreaterThan(-1); // гард найден в core
  const open = i + marker.length - 1;
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

// --- песочница: тело исполняется внутри with(ctx) + IIFE ---
function runBody(body, ctx) {
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + body + '\n})(); }');
  fn(ctx);
  return ctx;
}

function baseCtx(overrides) {
  const ctx = {
    logs: [],
    debugLog: function (kind, msg) { ctx.logs.push(msg); },
    doneReason: 'max',
    collapseRetries: 0,
    convId: 'conv-test',
    baseSize: () => 0,
    getConvId: () => 'conv-test',
    loadFloor: () => null,
    maybeStartLoader: function () { ctx.restartCalls = (ctx.restartCalls || 0) + 1; },
    loaderDoneMap: {},
    setTimeout: function (fn, ms) { ctx.timers = ctx.timers || []; ctx.timers.push({ fn, ms }); },
    clearTimeout: function () { },
    window: { GeminiInterceptLogic: GIL }
  };
  return Object.assign(ctx, overrides || {});
}

// v65-гейт из реального кода: topReached уже true (scrollTop<=8, scrollEngaged) →
// доходим до collapse-гарда; эмулируем окружение точки присвоения doneReason='top'.
function runTopPoint(ctx, extra) {
  ctx.sc = ctx.sc || { height: () => 0 };
  ctx.maxScrollHSeen = 0;
  ctx.usedFallbackScroll = false;
  Object.assign(ctx, extra || {});
  const guardSrc = coreSrc.slice(
    coreSrc.indexOf('// v1.14.2 (COLLAPSE-GUARD): collapse ≠ top'),
    coreSrc.indexOf('doneReason = \'top\'; // v78')
  );
  const body = guardSrc + '\ndoneReason = \'top\'; break;';
  return runBody('while (true) { ' + body + ' }', ctx);
}

describe('Gemini v1.14.2 COLLAPSE-GUARD: collapseGuardVerdict (чистый хелпер)', () => {
  test('(а) коллапс: scrollH=744, maxSeen=100933, base=80<floor=124 → collapsed=true', () => {
    const v = GIL.collapseGuardVerdict({ scrollH: 744, maxScrollHSeen: 100933, baseCount: 80, floorCount: 124 });
    expect(v.collapsed).toBe(true);
  });

  test('(б) нормальная вершина: scrollH=100933, base=124=floor → collapsed=false', () => {
    const v = GIL.collapseGuardVerdict({ scrollH: 100933, maxScrollHSeen: 100933, baseCount: 124, floorCount: 124 });
    expect(v.collapsed).toBe(false);
  });

  test('(в) низкая высота, но base>=floor → НЕ коллапс (короткий чат)', () => {
    const v = GIL.collapseGuardVerdict({ scrollH: 744, maxScrollHSeen: 100933, baseCount: 124, floorCount: 124 });
    expect(v.collapsed).toBe(false);
  });

  test('(г) нулевые/отсутствующие входы → без исключений, collapsed=false', () => {
    expect(() => GIL.collapseGuardVerdict(null)).not.toThrow();
    expect(GIL.collapseGuardVerdict({}).collapsed).toBe(false);
    expect(GIL.collapseGuardVerdict({ scrollH: 0, maxScrollHSeen: 0, baseCount: 0, floorCount: 0 }).collapsed).toBe(false);
  });
});
describe('Gemini v1.14.2 COLLAPSE-GUARD: точка присвоения doneReason (реальный код core)', () => {
  test('(а) коллапс → doneReason=\'collapse\' + ретрай через 8с (бюджет 2)', () => {
    const ctx = baseCtx({
      baseSize: () => 80,
      loadFloor: () => ({ count: 124 })
    });
    runTopPoint(ctx, {
      sc: { height: () => 744 },
      maxScrollHSeen: 100933
    });
    expect(ctx.doneReason).toBe('collapse');
    expect(ctx.collapseRetries).toBe(1);
    expect(ctx.timers && ctx.timers.length).toBe(1);
    expect(ctx.timers[0].ms).toBe(8000);
    expect(ctx.logs.join('\n')).toContain('collapse-guard');
  });

  test('(б) нормальная вершина → doneReason=\'top\', без ретрая', () => {
    const ctx = baseCtx({
      baseSize: () => 124,
      loadFloor: () => ({ count: 124 })
    });
    runTopPoint(ctx, {
      sc: { height: () => 100933 },
      maxScrollHSeen: 100933
    });
    expect(ctx.doneReason).toBe('top');
    expect(ctx.collapseRetries).toBe(0);
    expect(ctx.timers === undefined || ctx.timers.length === 0).toBe(true);
  });

  test('(в) бюджет исчерпан (collapseRetries=2) → collapse без нового ретрая', () => {
    const ctx = baseCtx({
      collapseRetries: 2,
      baseSize: () => 80,
      loadFloor: () => ({ count: 124 })
    });
    runTopPoint(ctx, {
      sc: { height: () => 744 },
      maxScrollHSeen: 100933
    });
    expect(ctx.doneReason).toBe('collapse');
    expect(ctx.timers === undefined || ctx.timers.length === 0).toBe(true);
    expect(ctx.logs.join('\n')).toContain('ретраи исчерпаны');
  });

  test('(г) смена convId после коллапса → ретрай НЕ запускает лоадер', () => {
    const ctx = baseCtx({
      baseSize: () => 80,
      loadFloor: () => ({ count: 124 }),
      getConvId: () => 'conv-DIFFERENT'
    });
    runTopPoint(ctx, {
      sc: { height: () => 744 },
      maxScrollHSeen: 100933
    });
    expect(ctx.doneReason).toBe('collapse');
    ctx.timers[0].fn();
    expect(ctx.restartCalls === undefined || ctx.restartCalls === 0).toBe(true);
  });

  // v1.15 (BUG «холодное открытие без полной истории»): чистый конец тихой пагинации +
  // схлопнутый скроллер на верхе при base < УСТАРЕВШЕГО пола — это не «ждём больше»,
  // а чат, ужатый на сервере. После подтверждающего повтора (база не выросла) →
  // doneReason='top' (не вечный collapse-ретрай против пола).
  test('(д) v1.15: чистый конец + повтор без роста базы → doneReason=\'top\' (самоизлечение пола)', () => {
    const ctx = baseCtx({
      baseSize: () => 80,
      loadFloor: () => ({ count: 108 }),
      collapseRetries: 1,
      quietEndedClean: true,
      pendingCursor: null,
      quietActive: false,
      lastHnvPageError: false,
      lastCleanEndBaseCount: 80
    });
    runTopPoint(ctx, {
      sc: { height: () => 744 },
      maxScrollHSeen: 100933
    });
    expect(ctx.doneReason).toBe('top');
    expect(ctx.timers === undefined || ctx.timers.length === 0).toBe(true);
    expect(ctx.logs.join('\n')).toContain('clean-end top confirmed');
  });

  test('(е) v1.15: первый коллапс при чистом конце — кандидат + подтверждающий ретрай 8с', () => {
    const ctx = baseCtx({
      baseSize: () => 80,
      loadFloor: () => ({ count: 108 }),
      quietEndedClean: true,
      pendingCursor: null,
      quietActive: false,
      lastHnvPageError: false,
      lastCleanEndBaseCount: -1
    });
    runTopPoint(ctx, {
      sc: { height: () => 744 },
      maxScrollHSeen: 100933
    });
    expect(ctx.doneReason).toBe('collapse');
    expect(ctx.collapseRetries).toBe(1);
    expect(ctx.timers && ctx.timers.length).toBe(1);
    expect(ctx.timers[0].ms).toBe(8000);
    expect(ctx.logs.join('\n')).toContain('clean-end collapse candidate');
  });

  test('(ж) v1.15: чистый конец, но база выросла на повторе → НЕ top (ждём рост)', () => {
    const ctx = baseCtx({
      baseSize: () => 90, // база выросла после первого collapse (была 80)
      loadFloor: () => ({ count: 108 }),
      collapseRetries: 1,
      quietEndedClean: true,
      pendingCursor: null,
      quietActive: false,
      lastHnvPageError: false,
      lastCleanEndBaseCount: 80
    });
    runTopPoint(ctx, {
      sc: { height: () => 744 },
      maxScrollHSeen: 100933
    });
    expect(ctx.doneReason).toBe('collapse');
    expect(ctx.collapseRetries).toBe(2); // рост базы — ждём следующий прогон, НЕ подтверждаем top
    expect(ctx.timers && ctx.timers.length).toBe(1);
    expect(ctx.logs.join('\n')).not.toContain('clean-end top confirmed');
  });

});

describe('Gemini v1.14.2 COLLAPSE-GUARD: сбросы бюджета и гейты полноты', () => {
  test('сброс collapseRetries при смене convId (resetForNewConversation)', () => {
    expect(coreSrc).toContain("lastLoaderDoneReason = ''; // v78: done-reason прошлого чата не должен открывать stable-stop оракул");
    expect(coreSrc).toContain('collapseRetries = 0; // v1.14.2 (COLLAPSE-GUARD): смена convId — новый бюджет коллапс-ретраев');
  });

  test('сброс collapseRetries при base>=floor (maybeStartLoader)', () => {
    expect(coreSrc).toContain('if (baseSize() >= __floorMs) collapseRetries = 0;');
  });

  test('stableCheck74 открывает полноту ТОЛЬКО при lastLoaderDoneReason===\'top\' (байтово)', () => {
    expect(coreSrc).toContain("            if (lastLoaderDoneReason !== 'top') {");
    expect(coreSrc).toContain("'collapse'"); // doneReason='collapse' — не 'top'
  });

  test('fallback-scroll-top гейт — только doneReason===\'top\' (байтово)', () => {
    expect(coreSrc).toContain("if (doneReason === 'top' && usedFallbackScroll) { // v1.14.2: 'collapse' сюда не попадает");
  });
});

describe('Gemini v1.14.2 COLLAPSE-GUARD: пер-ран maxScrollHSeen', () => {
  test('per-run maxScrollHSeen объявлен в старте прогона и обновляется на каждой итерации', () => {
    expect(coreSrc).toContain('var maxScrollHSeen = sc.height(); // v1.14.2 (COLLAPSE-GUARD): пер-ран максимум scrollHeight — сброс в старте прогона');
    expect(coreSrc).toContain('if (__hCg0 > maxScrollHSeen) maxScrollHSeen = __hCg0;');
  });
});

describe('Gemini v1.14.2 COLLAPSE-GUARD: (c) v65 top-not-reached байтово неизменен', () => {
  test('v65-лог и сброс счётчиков — байт в байт', () => {
    expect(coreSrc).toContain("debugLog('log', '[AI CM][Gemini][loader] v65 top-not-reached scrollTop=' + sc.top() +");
    expect(coreSrc).toContain("' (height-stable среди истории — не конец, продолжаю скролл) convId=' + convId);");
    expect(coreSrc).toContain('loaderState.topReached = loaderState.scrollEngaged && sc.top() <= 8;');
  });
});
