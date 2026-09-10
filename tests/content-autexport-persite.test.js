/**
 * S2 (бэклог «Настраиваемые пороги»): per-site порог автоэкспорта.
 * Ключ 'aiCmAutoExportPct_<site>' (например aiCmAutoExportPct_chatgpt)
 * переопределяет глобальный aiCmAutoExportPct (autoExportSettings.pct) для этого
 * сайта; отсутствует запись → глобальный; кламп [1,100]; фолбэк 90.
 * Чистая функция — utils/export-emit-pipeline.js effectiveAutoExportThreshold;
 * здесь же интеграционная проверка с shouldSkipAutoExport (гейт maybeAutoExport).
 */

const P = require('../utils/export-emit-pipeline.js');

describe('effectiveAutoExportThreshold (S2: per-site автоэкспорт)', () => {
  test('per-site ключ переопределяет глобальный порог', () => {
    expect(P.effectiveAutoExportThreshold(90, 50)).toBe(50);
    expect(P.effectiveAutoExportThreshold(60, 30)).toBe(30);
  });

  test('per-site значение строкой "50" парсится как число', () => {
    expect(P.effectiveAutoExportThreshold(90, '50')).toBe(50);
  });

  test('per-site отсутствует → фолбэк на глобальный порог', () => {
    expect(P.effectiveAutoExportThreshold(90, undefined)).toBe(90);
    expect(P.effectiveAutoExportThreshold(90, null)).toBe(90);
    expect(P.effectiveAutoExportThreshold(60, '')).toBe(60);
  });

  test('per-site битый (не число) → фолбэк на глобальный', () => {
    expect(P.effectiveAutoExportThreshold(75, 'abc')).toBe(75);
    expect(P.effectiveAutoExportThreshold(75, '  ')).toBe(75);
  });

  test('per-site клампится в [1,100]', () => {
    expect(P.effectiveAutoExportThreshold(90, 150)).toBe(100);
    expect(P.effectiveAutoExportThreshold(90, -5)).toBe(1);
    expect(P.effectiveAutoExportThreshold(90, 0)).toBe(1);
  });

  test('глобальный невалидный → дефолт 90', () => {
    expect(P.effectiveAutoExportThreshold(0, undefined)).toBe(90);
    expect(P.effectiveAutoExportThreshold(101, undefined)).toBe(90);
    expect(P.effectiveAutoExportThreshold('x', undefined)).toBe(90);
  });
});

describe('интеграция с shouldSkipAutoExport — чат на 60%: per-site 50 стреляет, глобальный 90 — нет', () => {
  const base = {
    enabled: true, percentage: 60, baseComplete: true,
    baseSeen: false, loaderRunning: false, isGemini: false
  };

  test('per-site 50 (aiCmAutoExportPct_chatgpt) при глобальном 90 → 60% ≥ 50, skip=false', () => {
    const th = P.effectiveAutoExportThreshold(90, 50);
    const v = P.shouldSkipAutoExport(Object.assign({}, base, {
      threshold: th,
      fired: P.getAutoExportFired({}, 'chatgpt', 'conv-1')
    }));
    expect(v).toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('без per-site (глобальный 90) → 60% < 90, skip (DOM-путь: below-threshold-unreliable)', () => {
    const th = P.effectiveAutoExportThreshold(90, undefined);
    const v = P.shouldSkipAutoExport(Object.assign({}, base, {
      threshold: th,
      fired: P.getAutoExportFired({}, 'chatgpt', 'conv-1')
    }));
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('below-threshold-unreliable');
  });

  test('другой сайт не получает чужой per-site оверрайд (gemini без записи → глобальный)', () => {
    const thChatgpt = P.effectiveAutoExportThreshold(90, 50);
    expect(thChatgpt).toBe(50);
    const thGemini = P.effectiveAutoExportThreshold(90, undefined);
    expect(thGemini).toBe(90);
    const v = P.shouldSkipAutoExport(Object.assign({}, base, {
      threshold: thGemini,
      fired: P.getAutoExportFired({}, 'gemini', 'conv-1')
    }));
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('below-threshold-unreliable');
  });
});
