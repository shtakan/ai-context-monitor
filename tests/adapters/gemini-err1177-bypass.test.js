/**
 * v1.16 (1177-BYPASS): обход ошибки Bard (code 1177) на запросах СТАРЫХ окон истории Gemini.
 *
 * Проблема: сервер Gemini (batchexecute hNvQHb) иногда отвечает на запрос глубокого окна
 * истории НЕ данными, а ошибкой (BardErrorInfo 1177 «повторите позже») — обычно при серийных
 * запросах старых окон встык (троттлинг) или когда континуационный токен окна не принимается
 * в этом контексте. Ретрай того же окна ограничен (paginateErrorRetryDecision, до 3).
 *
 * Решение (обход БЕЗ знания внутреннего формата окна):
 *   1) paginateErrorEscalation — после исчерпания ретраев окна НЕ объявлять «старших страниц
 *      больше нет» и не продолжать сломанную цепочку: эскалировать на НАТИВНЫЙ скрытый скролл
 *      лоадера (loadFullHistoryInvisibly). Сам сайт Gemini запросит старшие окна своими
 *      токенами в человеческом темпе (scrollTop=0 + синтетический scroll под оверлеем);
 *      их ответы приходят как src=passive и сливаются в базу. Один раз на чат.
 *   2) paginatePaceDelayMs — после серии ошибок-страниц тихий цикл продолжается с паузой
 *      (анти-троттлинг); в штатном режиме паузы нет (рабочая цепочка не меняется).
 *   3) Пин-тесты в core/gemini-intercept.js: ветка эскалации стоит ПОСЛЕ блока ретраев и
 *      вызывает maybeStartLoader; лоадер по эскалации скрывает/скроллит даже при msgs ниже
 *      порога (reason=1177-bypass); счётчики серии/флаги сбрасываются при смене чата.
 */

const fs = require('fs');
const path = require('path');

const {
  paginateErrorEscalation,
  paginatePaceDelayMs,
} = require('../../utils/gemini-intercept-logic');

const ROOT = path.join(__dirname, '..', '..');
const coreSrc = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');

describe('paginateErrorEscalation (v1.16: 1177 → нативный скрытый скролл)', () => {
  test('ретраи исчерпаны (retries>=cap), ошибка-страница, ходов/курсора нет → escalate',
    () => {
      expect(paginateErrorEscalation({
        errPage: true, hasCursor: false, added: 0, retries: 3, cap: 3,
        loaderRunning: false, nativeEscalationUsed: false
      })).toEqual({ escalate: true, reason: 'err1177-exhausted' });
    });

  test('бюджет ретраев ещё жив → escalate=false (retry-budget-alive)', () => {
    expect(paginateErrorEscalation({
      errPage: true, hasCursor: false, added: 0, retries: 1, cap: 3
    })).toEqual({ escalate: false, reason: 'retry-budget-alive' });
  });

  test('страница с данными/курсором/добавлением не эскалируется (not-ready)', () => {
    expect(paginateErrorEscalation({
      errPage: true, hasCursor: true, added: 0, retries: 3, cap: 3
    })).toEqual({ escalate: false, reason: 'not-ready' });
    expect(paginateErrorEscalation({
      errPage: true, hasCursor: false, added: 5, retries: 3, cap: 3
    })).toEqual({ escalate: false, reason: 'not-ready' });
    expect(paginateErrorEscalation({
      errPage: false, hasCursor: false, added: 0, retries: 3, cap: 3
    })).toEqual({ escalate: false, reason: 'not-ready' });
  });

  test('лоадер уже бежит → escalate=false (loader-running)', () => {
    expect(paginateErrorEscalation({
      errPage: true, hasCursor: false, added: 0, retries: 3, cap: 3,
      loaderRunning: true, nativeEscalationUsed: false
    })).toEqual({ escalate: false, reason: 'loader-running' });
  });

  test('на этот чат эскалация уже выполнена → escalate=false (native-escalation-used)', () => {
    expect(paginateErrorEscalation({
      errPage: true, hasCursor: false, added: 0, retries: 3, cap: 3,
      loaderRunning: false, nativeEscalationUsed: true
    })).toEqual({ escalate: false, reason: 'native-escalation-used' });
  });

  test('пустые/мусорные входы не ломают', () => {
    expect(paginateErrorEscalation(null)).toEqual({ escalate: false, reason: 'not-ready' });
    expect(paginateErrorEscalation({})).toEqual({ escalate: false, reason: 'not-ready' });
    expect(paginateErrorEscalation({ retries: 3 })).toEqual({ escalate: false, reason: 'not-ready' });
  });
});

describe('paginatePaceDelayMs (v1.16: анти-троттлинг после 1177)', () => {
  test('штатный режим (errSeen=false) — паузы НЕТ (0 мс): рабочая цепочка не меняется', () => {
    expect(paginatePaceDelayMs(0, false)).toBe(0);
    expect(paginatePaceDelayMs(7, false)).toBe(0);
    expect(paginatePaceDelayMs(undefined, false)).toBe(0);
  });

  test('после ошибки-страницы — базовая пауза 1200мс с ростом по глубине окна', () => {
    expect(paginatePaceDelayMs(0, true)).toBe(1200);
    expect(paginatePaceDelayMs(1, true)).toBe(1275);
    expect(paginatePaceDelayMs(8, true)).toBe(1800);
    // глубже 8 — рост ограничен (не более 8*75)
    expect(paginatePaceDelayMs(30, true)).toBe(1800);
  });
});

describe('v1.16 пины в core/gemini-intercept.js (1177-BYPASS)', () => {
  test('состояние эскалации объявлено и сбрасывается при смене чата', () => {
    expect(coreSrc).toContain('var quietErrStreak = 0;');
    expect(coreSrc).toContain('var nativeEscalationUsedMap = {};');
    expect(coreSrc).toContain('var nativeEscalationFor = null;');
    expect(coreSrc).toContain('quietErrStreak = 0; // v1.16 (1177-PACE): смена чата');
    expect(coreSrc).toContain('nativeEscalationFor = null; // v1.16 (1177-BYPASS): смена чата');
  });

  test('ветка эскалации стоит ПОСЛЕ блока ретраев окна (pag-error-retry) и до оракула v73', () => {
    const retryLogIdx = coreSrc.indexOf('[AI CM][cold-debug] pag-error-retry окно повторяется');
    const escIdx = coreSrc.indexOf('paginateErrorEscalation');
    const escMarker = coreSrc.indexOf('[AI CM][1177-bypass] escalate-native-scroll');
    const v73Idx = coreSrc.indexOf('// v68: сервер-авторитетное решение о следующем шаге');
    expect(retryLogIdx).toBeGreaterThan(-1);
    expect(escIdx).toBeGreaterThan(-1);
    expect(escMarker).toBeGreaterThan(-1);
    expect(escIdx).toBeGreaterThan(retryLogIdx);
    expect(escIdx).toBeLessThan(v73Idx);
  });

  test('эскалация сворачивает тихий цикл, снимает латчи и запускает лоадер (maybeStartLoader)', () => {
    expect(coreSrc).toContain('quietActive = false; // тихий цикл сворачиваем');
    expect(coreSrc).toContain('try { delete loaderDoneMap[__escConv]; }');
    expect(coreSrc).toContain('try { oracleIncompleteSeen[__escConv] = true; }');
    expect(coreSrc).toContain('maybeStartLoader();');
  });

  test('эскалация одноразовая на чат (nativeEscalationUsedMap) — вечного цикла нет', () => {
    expect(coreSrc).toContain('nativeEscalationUsed: !!(getConvId() && nativeEscalationUsedMap[getConvId()])');
    expect(coreSrc).toContain('try { nativeEscalationUsedMap[__escConv] = true; }');
  });

  test('лоадер по эскалации скрывает и скроллит даже при msgs ниже порога (reason=1177-bypass)', () => {
    const escRunIdx = coreSrc.indexOf('var escRun116 = !!(convId && nativeEscalationFor === convId);');
    const hideGateIdx = coreSrc.indexOf('__msgsNow >= LOADER_HIDE_MIN_MSGS || hideVerdict.bootstrapShort || escRun116');
    expect(escRunIdx).toBeGreaterThan(-1);
    expect(hideGateIdx).toBeGreaterThan(-1);
    expect(coreSrc).toContain("' reason=1177-bypass'");
  });

  test('после серии ошибок продолжение цепочки идёт с паузой (paginatePaceDelayMs)', () => {
    expect(coreSrc).toContain('window.GeminiInterceptLogic.paginatePaceDelayMs');
    expect(coreSrc).toContain('[AI CM][1177-bypass] pace-window');
    expect(coreSrc).toContain('if (lastHnvPageError === true) quietErrStreak++;');
    expect(coreSrc).toContain('else if (added > 0 || next) quietErrStreak = 0;');
  });

  test('НЕ трогать: прежние v1.15-пути (ретрай окна и распознавание ошибки) на месте', () => {
    expect(coreSrc).toContain('paginateErrorRetryDecision');
    expect(coreSrc).toContain('window.GeminiInterceptLogic.paginateErrorRetryDecision');
    expect(coreSrc).toContain('[AI CM][cold-debug] pag-error-retry окно повторяется');
    // чистый конец сети (quietEndedClean) не удалён — поведение v1.15 сохранено
    // (инвариант 3а: quietEndedClean=true требует НЕоборванного финального шага — lastPagStepBroken=false)
    expect(coreSrc).toContain('quietEndedClean = (lastHnvPageError === false) && lastPagStepBroken !== true;');
  });

  test('hide-гейт лоадера покрывает «короткие по ходам, но высокие» чаты (reason=older-unstarted)', () => {
    const gateIdx = coreSrc.indexOf('var olderUnstarted116 = !!(hideVerdict.hide && olderHistorySeen === true && reachedStart !== true);');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(coreSrc).toContain("' reason=older-unstarted'");
  });

  test('недостижимый скрытый скролл + чистый конец сети → early-stop (clean-end-unscrollable)', () => {
    expect(coreSrc).toContain("doneReason = 'clean-end-unscrollable';");
    expect(coreSrc).toContain('[AI CM][Gemini][loader] early-stop reason=clean-end-unscrollable');
    expect(coreSrc).toContain('__nhClean = __qcNh && !__pcNh && !reachedStart && __floorNh > 0 && baseSize() > 0 && baseSize() >= __floorNh;');
  });
});
