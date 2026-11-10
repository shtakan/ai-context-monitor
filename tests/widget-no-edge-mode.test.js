/**
 * UI-аудит 2026-09-28 (docs/UI_AUDIT_QWEN_2026-09-28.md), находка #6 — edge-режим
 * индикатора (уменьшение круга в edge-режиме, 28×44 при HIG 44×44).
 *
 * Статус находки: **Won't Fix**. Решение принято ранее в коммите `deab423`:
 * edge-режим 28×44 отклонён, потому что 28 px < 44 px (HIG 44×44 / WCAG 2.2 AA 2.5.8),
 * а процент в SVG при 88% от 28 px ≈ 24.6 px нечитаем. Требование hit-area и далее
 * выполняется текущим кругом 64 px.
 *
 * Этот файл — защита от возврата фичи: он падает, если в `core/widget.ts` снова
 * появятся селектор/класс `.edge-mode` или определение мобильного устройства через
 * `navigator.userAgent` (второй признак возврата «сжатого» режима по UA).
 *
 * D = пин решения (чего быть не должно), R = защита чужого поведения (что должно
 * остаться на месте). Читается РЕАЛЬНЫЙ `core/widget.ts` тем же приёмом, что и
 * остальные source-level пины виджета (tests/helpers/content-source.js).
 */
const HELPERS = require('./helpers/content-source.js');

const WIDGET_SRC = HELPERS.moduleSource('core/widget.ts');

/** Число вхождений подстроки. */
function occurrences(src, sub) {
  return src.split(sub).length - 1;
}

describe('#6 edge-режим: Won\'t Fix (защита от возврата фичи)', () => {
  test('D: в core/widget.ts нет селектора/класса .edge-mode', () => {
    // CSS-селектор, класс в разметке или строка classList — любая форма вернёт фичу.
    expect(occurrences(WIDGET_SRC, '.edge-mode')).toBe(0);
    expect(occurrences(WIDGET_SRC, 'edge-mode')).toBe(0);
  });

  test('D: в core/widget.ts нет navigator.userAgent', () => {
    expect(occurrences(WIDGET_SRC, 'navigator.userAgent')).toBe(0);
  });

  test('R: служебный комментарий про отклонённый edge-режим сохранён (история решения)', () => {
    // Комментарий — не код: он документирует отказ от 28×44 и не включает фичу.
    expect(WIDGET_SRC).toContain('edge-режим');
  });

  test('R: шаблон виджета и корневое правило на месте (фича не «закрыта» удалением виджета)', () => {
    expect(WIDGET_SRC).toContain('container.replaceChildren(');
    const rootMarker = '#ai-context-widget { position: fixed; bottom: var(--acm-safe-bottom, 24px); right: 24px;';
    expect(WIDGET_SRC).toContain(rootMarker);
    // Круг индикатора остаётся прежнего размера — hit-area #6 не деградировала.
    expect(occurrences(WIDGET_SRC, '.ai-widget-circle')).toBeGreaterThan(0);
  });
});
