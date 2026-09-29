/**
 * UI-аудит 2026-09-28 (docs/UI_AUDIT_QWEN_2026-09-28.md), Major-подбатч 2 — панель виджета:
 *   #9 переполнение (WCAG 2.2 AA 1.4.10 Reflow): у .ai-widget-panel не было ни max-width,
 *      ни max-height, ни overflow — на узком/низком окне содержимое панели недостижимо →
 *      width: min(260px, calc(100vw - 48px)) + max-height: calc(100vh - 108px) +
 *      overflow-y: auto + overscroll-behavior: contain + box-sizing: border-box;
 *   #11 контраст тёмной темы (WCAG 2.2 AA 1.4.3): .ai-cm-hint имел opacity: 0.72 —
 *      эффективный контраст текста падал ниже 4.5:1 → opacity: 1 + явный
 *      color: var(--w-tooltip-text) (общие токены тултипа НЕ трогаются).
 *
 * Пины читают РЕАЛЬНЫЙ core/widget.js (конвенция H11/H22/H24/H25) и режут правила из
 * инлайн <style> по имени селектора, а не дублируют строки в себе. H25-инвариант
 * («applyNativeStyles пишет ровно 8 токенов --w-*») остаётся зелёным без правок:
 * новых токенов не вводили, поэтому ни одна проверка не ослаблена.
 */
const HELPERS = require('./helpers/content-source.js');

const WIDGET_SRC = HELPERS.moduleSource('core/widget.js');

/** Тело CSS-правила по точному селектору (' {') — первое совпадение, до парной '}'. */
function ruleBody(src, selector) {
  const marker = selector + ' {';
  const i = src.indexOf(marker);
  expect([selector, i > -1]).toEqual([selector, true]);
  const end = src.indexOf('}', i);
  expect([selector + ' (закрывающая скобка)', end > i]).toEqual([selector + ' (закрывающая скобка)', true]);
  return src.slice(i + marker.length, end);
}

/** Тело функции из исходника по имени (баланс фигурных скобок). */
function extractFn(src, name) {
  const marker = 'function ' + name + '(';
  const i = src.indexOf(marker);
  expect([name, i > -1]).toEqual([name, true]);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error('unbalanced function body: ' + name);
}

describe('UI-аудит #9 — панель виджета не выходит за viewport (Reflow)', () => {
  const panel = ruleBody(WIDGET_SRC, '.ai-widget-panel');

  test('D#9: правило .ai-widget-panel ограничено по ширине через width: min(260px, calc(100vw - 48px))', () => {
    expect(panel).toContain('width: min(260px, calc(100vw - 48px))');
  });

  test('D#9: правило .ai-widget-panel ограничено по высоте через max-height: calc(100vh - 108px)', () => {
    expect(panel).toContain('max-height: calc(100vh - 108px)');
  });

  test('D#9: содержимое панели прокручивается (overflow-y: auto) с containment оверскролла', () => {
    expect(panel).toContain('overflow-y: auto');
    expect(panel).toContain('overscroll-behavior: contain');
  });

  test('D#9: padding включён в width (box-sizing: border-box)', () => {
    expect(panel).toContain('box-sizing: border-box');
  });

  test('R#9: min-width: 230px из правила убран — он перебивал бы width на узком окне', () => {
    expect(panel).not.toContain('min-width: 230px');
    expect(WIDGET_SRC).not.toContain('min-width: 230px');
  });

  test('R#9: прочие свойства панели не тронуты (bottom/right/фон/цвет/радиус/шрифт/z-index)', () => {
    expect(panel).toContain('bottom: 76px');
    expect(panel).toContain('right: 0');
    expect(panel).toContain('background: var(--w-tooltip-bg)');
    expect(panel).toContain('color: var(--w-tooltip-text)');
    expect(panel).toContain('padding: 10px');
    expect(panel).toContain('border-radius: 10px');
    expect(panel).toContain('font-size: 12px');
    expect(panel).toContain('line-height: 1.4');
    expect(panel).toContain('z-index: 1000000');
    expect(panel).toContain('white-space: normal');
    expect(panel).toContain('flex-direction: column');
    expect(panel).toContain('gap: 6px');
  });

  test('R#9: вертикальный flip не реализован — позиция панели по-прежнему CSS-only', () => {
    expect(panel).not.toContain('transform: translateY');
    expect(extractFn(WIDGET_SRC, 'updatePanel')).not.toContain('getBoundingClientRect');
  });
});

describe('UI-аудит #11 — контраст подсказки .ai-cm-hint в тёмной теме', () => {
  const hint = ruleBody(WIDGET_SRC, '.ai-cm-hint');

  test('D#11: opacity: 0.72 в правиле .ai-cm-hint отсутствует', () => {
    expect(hint).not.toContain('opacity: 0.72');
    expect(WIDGET_SRC).not.toContain('opacity: 0.72');
  });

  test('D#11: у .ai-cm-hint явный непрозрачный цвет текста color: var(--w-tooltip-text)', () => {
    expect(hint).toContain('color: var(--w-tooltip-text)');
    expect(hint).toContain('opacity: 1');
    expect(hint).not.toMatch(/opacity:\s*0?\.\d/);
  });

  test('R#11: размер шрифта подсказки не изменён (font-size: 11px)', () => {
    expect(hint).toContain('font-size: 11px');
  });

  test('R#11: общие токены тултипа не подменялись (--w-tooltip-bg/--w-tooltip-text на месте)', () => {
    expect(WIDGET_SRC).toContain('.ai-widget-tooltip {');
    expect(WIDGET_SRC).toContain('background: var(--w-tooltip-bg)');
    expect(WIDGET_SRC).toContain('color: var(--w-tooltip-text)');
  });
});

describe('Токен-инвариант подбатча — новых --w-* токенов не вводили (H25)', () => {
  test('R: в core/widget.js нет ни одной подстроки --w-panel (и вообще новых токенов панели)', () => {
    expect(WIDGET_SRC).not.toContain('--w-panel');
  });

  test('R: applyNativeStyles пишет ровно 8 токенов setProperty(\'--w-...\')', () => {
    const body = extractFn(WIDGET_SRC, 'applyNativeStyles');
    expect((body.match(/setProperty\('--w-/g) || []).length).toBe(8);
  });

  test('R: тихий путь H25 не тронут — единственный источник правды о палитре на месте', () => {
    const body = extractFn(WIDGET_SRC, 'applyNativeStyles');
    expect(body).toContain('aiCmWidgetAppliedTheme = isDark;');
    expect(WIDGET_SRC).toContain('function applyNativeStyles(container)');
  });
});
