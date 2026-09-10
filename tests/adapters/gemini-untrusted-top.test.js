/**
 * H9 (additive-гейт недостоверного doneReason='top') + H12 (A5b):
 *   1) untrustedTopVerdict — первый визит без пола (floor=0) + курсор в истории был +
 *      скроллер за прогон НЕ вырос (схлопнутая высота) → doneReason='top' на пустом/
 *      схлопнутом скроллере ложный; лоадер обязан уйти в 'collapse' (ретрай-путь collapse-guard).
 *   2) pagStepBroken — диагностика оборвавшегося финального шага тихой пагинации
 *      (added=0, курсора нет, скелет/0 opaque-кандидатов). Сам scroll-top-proof как
 *      источник complete удалён (H12/A5b: циркулярный оракул полноты) — top+scrollEngaged
 *      уходят в (b) probe / loader-restart; гейт lastPagStepBroken сохранён.
 *
 * Пины (реальный core/gemini-intercept.js): лоадер вызывает untrustedTopVerdict ПЕРЕД
 * присвоением doneReason='top'; scroll-top-proof-ветка (a) в paginateLoop отсутствует.
 */
const fs = require('fs');
const path = require('path');

const GIL = require('../../utils/gemini-intercept-logic.js');

const coreSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
  'utf8'
);

describe('H9 untrustedTopVerdict (чистый хелпер)', () => {
  test('(а) floor=0 + hadCursor + no-growth + низкая высота → untrusted (no-floor-no-growth)', () => {
    const v = GIL.untrustedTopVerdict({
      floorCount: 0,
      hadCursor: true,
      anyGrowth: false,
      maxScrollHSeen: 864,
      viewportH: 800
    });
    expect(v).toEqual({ untrusted: true, reason: 'no-floor-no-growth' });
  });

  test('(б) floor>0 (пол есть) → null (collapse-guard покрывает, не дублируем)', () => {
    expect(GIL.untrustedTopVerdict({
      floorCount: 124,
      hadCursor: true,
      anyGrowth: false,
      maxScrollHSeen: 864,
      viewportH: 800
    })).toBeNull();
  });

  test('(в) hadCursor=false (короткий чат без старшей истории) → null', () => {
    expect(GIL.untrustedTopVerdict({
      floorCount: 0,
      hadCursor: false,
      anyGrowth: false,
      maxScrollHSeen: 864,
      viewportH: 800
    })).toBeNull();
  });

  test('(г) anyGrowth=true (скроллер реально рос) → null (вовлечение было)', () => {
    expect(GIL.untrustedTopVerdict({
      floorCount: 0,
      hadCursor: true,
      anyGrowth: true,
      maxScrollHSeen: 100000,
      viewportH: 800
    })).toBeNull();
  });

  test('(д) большая maxScrollHSeen (> viewport+400) → null (реальный длинный скроллер)', () => {
    expect(GIL.untrustedTopVerdict({
      floorCount: 0,
      hadCursor: true,
      anyGrowth: false,
      maxScrollHSeen: 5000,
      viewportH: 800
    })).toBeNull();
  });

  test('(е) viewportH=0 (нет вьюпорта) → fallback 700; низкая высота → untrusted', () => {
    const v = GIL.untrustedTopVerdict({
      floorCount: 0,
      hadCursor: true,
      anyGrowth: false,
      maxScrollHSeen: 900,
      viewportH: 0
    });
    expect(v && v.untrusted).toBe(true);
  });

  test('(ж) отсутствующие/нулевые входы → без исключений, null', () => {
    expect(GIL.untrustedTopVerdict(null)).toBeNull();
    expect(GIL.untrustedTopVerdict({})).toBeNull();
  });
});

describe('H9 pagStepBroken (чистый хелпер)', () => {
  test('(а) added=0, курсора нет, страница не распарсилась (скелет) → true', () => {
    expect(GIL.pagStepBroken({
      added: 0,
      nextCursor: false,
      failedSkeleton: true,
      opaqueCandidates: 5
    })).toBe(true);
  });

  test('(б) added=0, курсора нет, opaque-кандидатов 0 → true', () => {
    expect(GIL.pagStepBroken({
      added: 0,
      nextCursor: false,
      failedSkeleton: false,
      opaqueCandidates: 0
    })).toBe(true);
  });

  test('(в) added>0 (реальный рост) → false (сброс флага)', () => {
    expect(GIL.pagStepBroken({
      added: 12,
      nextCursor: false,
      failedSkeleton: false,
      opaqueCandidates: 0
    })).toBe(false);
  });

  test('(г) есть курсор (nextCursor=true) → false (продолжаем, не финальный шаг)', () => {
    expect(GIL.pagStepBroken({
      added: 0,
      nextCursor: true,
      failedSkeleton: false,
      opaqueCandidates: 0
    })).toBe(false);
  });

  test('(д) added=0, курсора нет, но скелета нет и кандидаты есть → false', () => {
    expect(GIL.pagStepBroken({
      added: 0,
      nextCursor: false,
      failedSkeleton: false,
      opaqueCandidates: 3
    })).toBe(false);
  });

  test('(е) отсутствующие входы → без исключений, false', () => {
    expect(GIL.pagStepBroken(null)).toBe(false);
    expect(GIL.pagStepBroken({})).toBe(false);
  });
});

describe('H9 пины в core/gemini-intercept.js', () => {
  test('лоадер вызывает untrustedTopVerdict ПЕРЕД присвоением doneReason=\'top\'', () => {
    const verdictIdx = coreSrc.indexOf('GeminiInterceptLogic.untrustedTopVerdict');
    const topIdx = coreSrc.indexOf('doneReason = \'top\'; // v78');
    expect(verdictIdx).toBeGreaterThan(-1);
    expect(topIdx).toBeGreaterThan(-1);
    expect(verdictIdx).toBeLessThan(topIdx);
    expect(coreSrc).toContain('var cursorEpochAtRunStart = cursorEpoch;');
  });

  test('untrusted-top уходит в collapse с ретрай-путём collapse-guard (≤2)', () => {
    expect(coreSrc).toContain('[AI CM][Gemini][loader] untrusted-top');
    expect(coreSrc).toContain('doneReason = \'collapse\'; // H9: НЕ \'top\'');
    expect(coreSrc).toContain('untrusted-top: ретраи исчерпаны 2/2 — incomplete as-is');
  });

  test('H12 (A5b): scroll-top-proof-ветка (a) удалена — top+scrollEngaged уходят в (b) probe', () => {
    expect(coreSrc).not.toContain('} else if (!lastPagStepBroken && loaderState.topReached === true');
    expect(coreSrc).not.toContain('oracle=complete reason=scroll-top-proof');
    expect(coreSrc).not.toContain('reason=below-floor scroll-top-proof');
    expect(coreSrc).toContain('H12 (A5b): scroll-top-proof удалён');
    // H9-гейт и его диагностика сохранены (поведение — сценарии (а)/(а2) H12-сьюта ниже)
    expect(coreSrc).toContain('[gemini-paginate] scroll-top-proof suppressed: last step broken');
  });

  test('флаг lastPagStepBroken вычисляется в тихом цикле и сбрасывается', () => {
    expect(coreSrc).toContain('window.GeminiInterceptLogic.pagStepBroken');
    expect(coreSrc).toContain('lastPagStepBroken = false; // H9: новый прогон тихой пагинации');
    expect(coreSrc).toContain('lastPagStepBroken = false; // H9: смена convId');
  });
});

// ===== H12 (A5b): scroll-top-proof удалён — циркулярный оракул полноты =====
// Стейтмент решения о полноте извлекается из РЕАЛЬНОГО исходника (конвенция
// floor-confirmed/tape-protect) и исполняется в песочнице с `with`: гоняем код
// paginateLoop, а не копию логики. Сценарий A5b — top+scrollEngaged+floor>0+тишина —
// обязан уходить в incomplete/probe (reason=await-probe), а НЕ объявлять complete.

// --- извлечение if (circular-mismatch) … else { …probe… } из реального исходника ---
function extractDecisionStatement() {
  const startMarker = '// v73: нециркулярное решение о полноте';
  const i = coreSrc.indexOf(startMarker);
  expect(i).toBeGreaterThan(-1); // стейтмент решения найден
  const j = coreSrc.indexOf('runCompletenessProbe(dbFirstHash, wideCur);', i);
  expect(j).toBeGreaterThan(-1); // вызов probe в else-ветке найден
  const close = coreSrc.indexOf('\n        }', j); // закрывающая } else-ветки
  expect(close).toBeGreaterThan(j);
  return coreSrc.slice(i, close) + '\n        }';
}

function runDecision(ctx) {
  const snippet = extractDecisionStatement();
  const fn = new Function('ctx', 'with (ctx) {\n' + snippet + '\n}');
  fn(ctx);
  return ctx;
}

function decisionCtx(overrides) {
  const ctx = {
    logs: [],
    fqCalls: [],
    probeCalls: [],
    // A5b-сценарий: circular-mismatch нет (serverFirstHash пуст), топ достигнут
    // (topReached), скрытый скролл вовлечён (scrollEngaged), старших добавлений вне
    // пагинации нет (lastOlderNonPagAddAt < startTs — тишина), пол > 0 (floor).
    serverFirstHash: '',
    dbFirstHash: 'h12-first',
    reachedStart: false,
    lastPagStepBroken: false,
    // внешние locals стейтмента (выше точки извлечения) — только для логов веток
    retriesC73: 0,
    added: 0,
    totalNow: 120,
    loaderState: { topReached: true, scrollEngaged: true },
    lastOlderNonPagAddAt: 0,
    paginationRun: { startTs: Date.now() - 10000 },
    floor: { count: 120 },
    lastPaginateOuter: null,
    lastGoodWideCur: null,
    console: console,
    getConvId: function () { return 'conv-h12'; },
    extractCursorWide: function () { return null; },
    debugLog: function (level, msg) { ctx.logs.push(String(msg)); },
    finishQuiet: function (success, reason) { ctx.fqCalls.push({ success: success, reason: reason }); },
    runCompletenessProbe: function (dbFirstHash, wideCur) { ctx.probeCalls.push({ dbFirstHash: dbFirstHash, wideCur: wideCur }); }
  };
  return Object.assign(ctx, overrides || {});
}

describe('H12 (A5b) в core/gemini-intercept.js (решение о полноте исполняется из исходника)', () => {
  test('(а) топ+scrollEngaged+floor>0+тишина → complete НЕ объявляется, поток уходит в incomplete/probe', () => {
    const ctx = runDecision(decisionCtx());
    // никакого complete: finishQuiet(true, ...) не вызван; единственный исход — await-probe
    expect(ctx.fqCalls).toEqual([{ success: false, reason: 'await-probe' }]);
    expect(ctx.probeCalls.length).toBe(1);
    expect(ctx.probeCalls[0].dbFirstHash).toBe('h12-first');
    expect(ctx.reachedStart).toBe(false);
    const joined = ctx.logs.join('\n');
    expect(joined).not.toContain('oracle=complete');
    expect(joined).not.toContain('reason=scroll-top-proof');
    // до H12 этот сценарий завершался scroll-top-proof → complete (finishQuiet(true, 'end'))
    expect(ctx.fqCalls.some(function (c) { return c.success === true; })).toBe(false);
  });

  test('(а2) тот же сценарий при сломанном финальном шаге → probe + H9-диагностика (гейт сохранён)', () => {
    const ctx = runDecision(decisionCtx({ lastPagStepBroken: true }));
    expect(ctx.fqCalls).toEqual([{ success: false, reason: 'await-probe' }]);
    expect(ctx.probeCalls.length).toBe(1);
    expect(ctx.logs.join('\n')).toContain('[gemini-paginate] scroll-top-proof suppressed: last step broken');
  });

  test('(а3) circular-mismatch-гейт не тронут: serverFirstHash≠dbFirstHash → reason=circular-mismatch', () => {
    const ctx = runDecision(decisionCtx({ serverFirstHash: 'server-h', dbFirstHash: 'db-h' }));
    expect(ctx.fqCalls).toEqual([{ success: false, reason: 'circular-mismatch' }]);
    expect(ctx.probeCalls.length).toBe(0);
    expect(ctx.reachedStart).toBe(false);
  });
});

