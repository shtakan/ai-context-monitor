/**
 * v54: юнит-тесты чистой функции detectTrimState (utils/gemini-intercept-logic.js) —
 * детектор обрезки истории в Gemini для спасательного pre-trim экспорта.
 */
const L = require('../utils/gemini-intercept-logic.js');

describe('detectTrimState (v54: детектор обрезки истории Gemini)', () => {
  const mkIds = (n, off = 0) => Array.from({ length: n }, (_, i) => 'id-' + String(off + i).padStart(3, '0'));

  test('stable: count не меняется → подозрений нет', () => {
    const prev = { maxCount: 20, firstIds: mkIds(10), suspectPending: 0 };
    const snap = { count: 20, messageIds: mkIds(20), historyComplete: true };
    expect(L.detectTrimState(prev, snap)).toEqual({ suspect: false, confirmed: false, lostHead: false });
  });

  test('частичная загрузка (historyComplete=false) → срабатывания не должно быть', () => {
    const prev = { maxCount: 20, firstIds: mkIds(10), suspectPending: 0 };
    // count упал, голова исчезла — но это норма тихой пагинации, а НЕ обрезка
    const snap = { count: 12, messageIds: mkIds(12, 8), historyComplete: false };
    expect(L.detectTrimState(prev, snap)).toEqual({ suspect: false, confirmed: false, lostHead: false });
  });

  test('count-drop: первое сокращение → suspect, второе подряд → confirmed=true', () => {
    const prev = { maxCount: 20, firstIds: mkIds(10), suspectPending: 0 };
    // обрезали голову: остались сообщения id-010..id-019 (count 20 → 10)
    const s1 = { count: 10, messageIds: mkIds(10, 10), historyComplete: true };
    const r1 = L.detectTrimState(prev, s1);
    expect(r1.lostHead).toBe(true);
    expect(r1.suspect).toBe(true);
    expect(r1.confirmed).toBe(false);

    // вызывающий код после suspect ставит suspectPending=1 в probe
    const prev2 = { maxCount: 20, firstIds: mkIds(10), suspectPending: 1 };
    // вызывающий код при lostHead сохраняет СТАРЫЙ эталон firstIds (см. geminiDetectTrim),
    // поэтому и второй сокращённый снимок подряд не содержит исходной головы id-000..009
    const s2 = { count: 5, messageIds: mkIds(5, 15), historyComplete: true };
    const r2 = L.detectTrimState(prev2, s2);
    expect(r2.lostHead).toBe(true);
    expect(r2.suspect).toBe(true);
    expect(r2.confirmed).toBe(true);
  });

  test('не-подряд: стабильный снимок между двумя сокращениями сбрасывает streak', () => {
    const prev = { maxCount: 20, firstIds: mkIds(10), suspectPending: 0 };
    const s1 = { count: 10, messageIds: mkIds(10, 10), historyComplete: true };
    expect(L.detectTrimState(prev, s1).confirmed).toBe(false);
    // стабильный снимок → вызывающий код ОБНОВИЛ firstIds и сбросил suspectPending
    const stableProbe = { maxCount: 20, firstIds: mkIds(10, 10), suspectPending: 0 };
    const s2 = { count: 5, messageIds: mkIds(5, 20), historyComplete: true };
    const r2 = L.detectTrimState(stableProbe, s2);
    expect(r2.suspect).toBe(true);
    expect(r2.confirmed).toBe(false);
  });

  test('подряд: между двумя сокращениями не было стабильного снимка → confirmed', () => {
    // подряд = два lostHead подряд с ОДНИМ И ТЕМ ЖЕ сохранённым эталоном головы
    const prev = { maxCount: 20, firstIds: mkIds(10), suspectPending: 1 };
    const snap = { count: 12, messageIds: mkIds(12, 20), historyComplete: true };
    const r = L.detectTrimState(prev, snap);
    expect(r.suspect).toBe(true);
    expect(r.confirmed).toBe(true);
  });

  test('без эталона (prevProbe=null / пустые firstIds) → тишина', () => {
    const snap = { count: 10, messageIds: mkIds(10), historyComplete: true };
    expect(L.detectTrimState(null, snap)).toEqual({ suspect: false, confirmed: false, lostHead: false });
    expect(L.detectTrimState({ maxCount: 20, firstIds: [], suspectPending: 0 }, snap))
      .toEqual({ suspect: false, confirmed: false, lostHead: false });
  });

  test('голова видна в первых N id нового снимка → это НЕ обрезка', () => {
    const prev = { maxCount: 20, firstIds: mkIds(10), suspectPending: 0 };
    // добились хвоста: count меньше, но старые первые id всё ещё среди первых N
    const snap = { count: 14, messageIds: mkIds(14, 6), historyComplete: true };
    expect(L.detectTrimState(prev, snap)).toEqual({ suspect: false, confirmed: false, lostHead: false });
  });
});

// ========== Фаза B: pickProactiveThreshold (пороги 70/85/95, один раз на разговор) ==========
const pick = L.pickProactiveThreshold;

describe('pickProactiveThreshold — проактивные пороги 70/85/95', () => {
  test('pct=75, fired=[] → 70 (но не 85/95)', () => {
    expect(pick(75, new Set())).toBe(70);
  });

  test('pct=87, fired=[70] → 85', () => {
    expect(pick(87, new Set([70]))).toBe(85);
  });

  test('pct=92, fired=[70,85] → null (порог 95 ещё не достигнут; кейс из ТЗ с ответом 95 — опечатка, верно pct=96)', () => {
    expect(pick(92, new Set([70, 85]))).toBe(null);
  });

  test('pct=96, fired=[70,85] → 95', () => {
    expect(pick(96, new Set([70, 85]))).toBe(95);
  });

  test('pct=97, fired=[70,85,95] → null (ничего нового)', () => {
    expect(pick(97, new Set([70, 85, 95]))).toBe(null);
  });

  test('pct=60, fired=[] → null', () => {
    expect(pick(60, new Set())).toBe(null);
  });
});

describe('pickProactiveThreshold — границы и латч', () => {
  test('порог включительно: pct=70 → 70', () => {
    expect(pick(70, new Set())).toBe(70);
  });

  test('исполненный порог ниже текущего не выдаётся повторно (латч через firedSet)', () => {
    const s = new Set([70]);
    expect(pick(87, s)).toBe(85);
    s.add(85);
    expect(pick(96, s)).toBe(95);
    s.add(95);
    expect(pick(99, s)).toBe(null); // ничего нового до конца разговора
  });

  test('невалидный pct → null', () => {
    expect(pick(NaN, new Set())).toBe(null);
    expect(pick(undefined, new Set())).toBe(null);
  });
});

describe('pickProactiveThreshold — защита от скачка pct (SW-политика)', () => {
  // Соглашено с рецензентом: при прыжке 60→92 не должно стрелять 70 ПОСЛЕ 85,
  // поэтому после срабатывания T в латч (firedSet) добавляются ВСЕ пороги <= pct.
  // Политика применяется вызывающим кодом (checkThresholds в SW); здесь — симуляция.
  test('скачок 60→92: первый вызов → 85, после внесения порогов <= 92 в латч → null', () => {
    const s = new Set();
    expect(pick(60, s)).toBe(null);          // ещё ниже первого порога
    const T = pick(92, s);                    // скачок сразу за 85
    expect(T).toBe(85);
    L.PROACTIVE_THRESHOLDS.forEach((t) => { if (t <= 92) s.add(t); }); // как делает SW
    expect(Array.from(s).sort((a, b) => a - b)).toEqual([70, 85]);
    expect(pick(92, s)).toBe(null);           // тот же pct → ничего нового
  });

  test('защита от отката бейджа: все исполненные пороги остаются в латче навсегда', () => {
    const s = new Set([70, 85, 95]);          // конец разговора — Set никогда не чистится
    [60, 75, 92].forEach((p) => expect(pick(p, s)).toBe(null));
  });
});

