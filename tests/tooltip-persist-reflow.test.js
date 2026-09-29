/**
 * UI-аудит 2026-09-28 (docs/UI_AUDIT_QWEN_2026-09-28.md), Major-подбатч 3 — тултип виджета:
 *   #4 тултип нельзя прочитать: .ai-widget-tooltip вложен в .ai-widget-circle, но между
 *      верхом круга (64px) и низом тултипа (bottom: 76px) есть 12px разрыва, не покрытых
 *      ни одним элементом — при переходе указателя через разрыв :hover теряется и
 *      многострочный тултип исчезает мгновенно. Решение: ЗАДЕРЖКА СКРЫТИЯ 300ms
 *      (visibility ... linear 0.3s в правиле тултипа + мгновенное visibility ... linear 0s
 *      в hover-правиле). Хит-эррей НЕ расширяется: pointer-events не добавляется.
 *   #8 tooltip reflow (WCAG 2.2 AA 1.4.10): белый пробел nowrap без max-width/max-height/
 *      overflow уводил тултип за левый край на узком окне → max-width: min(320px,
 *      calc(100vw - 48px)) + max-height: 40vh + overflow-y: auto +
 *      overscroll-behavior: contain + white-space: normal + overflow-wrap: break-word
 *      (регресс #26: anywhere обнуляет min-content → тултип схлопывался по ширине;
 *      break-word переносит токены, не меняя min-content).
 *      Вертикальный flip (как у панели) сознательно НЕ реализуется.
 *
 * Пины читают РЕАЛЬНЫЙ core/widget.js (конвенция H11/H22/H24/H25) и режут правила из
 * инлайн <style> по имени селектора, а не дублируют строки CSS в себе. H25-инвариант
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

/** Число вхождений подстроки (литерал, не регэксп). */
function occurrences(src, needle) {
  return src.split(needle).length - 1;
}

// Зафиксировано ДО правки (CSS-only): 12 вызовов addEventListener( в core/widget.js.
const ADD_EVENT_LISTENER_BASELINE = 12;

const TOOLTIP_SEL = '.ai-widget-tooltip';
const HOVER_SEL = '.ai-widget-circle:hover .ai-widget-tooltip';
const PANEL_OPEN_SEL = '#ai-context-widget.ai-panel-open .ai-widget-tooltip';

const tooltip = ruleBody(WIDGET_SRC, TOOLTIP_SEL);
const hover = ruleBody(WIDGET_SRC, HOVER_SEL);
const panelOpen = ruleBody(WIDGET_SRC, PANEL_OPEN_SEL);

describe('UI-аудит #4 — тултип переживает переход через 12px разрыв (задержка скрытия)', () => {
  test('D#4: в правиле тултипа скрытие задержано — transition: opacity 0.15s ease, visibility 0s linear 0.3s', () => {
    expect(tooltip).toContain('transition: opacity 0.15s ease, visibility 0s linear 0.3s');
    expect(tooltip).toContain('visibility 0s linear 0.3s');
  });

  test('D#4: hover-правило показывает тултип мгновенно (visibility 0s linear 0s)', () => {
    expect(hover).toContain('transition: opacity 0.15s ease, visibility 0s linear 0s');
    expect(hover).toContain('visibility: visible');
    expect(hover).toContain('opacity: 1');
  });

  test('D#4: задержка 300ms не утаскивает гашение при открытой панели — transition: none', () => {
    expect(panelOpen).toContain('transition: none');
    expect(panelOpen).toContain('visibility: hidden !important');
    expect(panelOpen).toContain('opacity: 0 !important');
  });

  test('R#4: хит-эррей не расширялся — pointer-events отсутствует и в правиле тултипа, и в файле', () => {
    expect(tooltip).not.toContain('pointer-events');
    expect(hover).not.toContain('pointer-events');
    expect(panelOpen).not.toContain('pointer-events');
    expect(WIDGET_SRC).not.toContain('pointer-events');
  });

  test('R#4: Escape-закрытие тултипа и новые JS-обработчики не добавлены (addEventListener без роста)', () => {
    expect(occurrences(WIDGET_SRC, 'addEventListener(')).toBe(ADD_EVENT_LISTENER_BASELINE);
  });
});

describe('UI-аудит #8 — тултип не выходит за viewport (Reflow)', () => {
  test('D#8: правило .ai-widget-tooltip ограничено по ширине через max-width: min(320px, calc(100vw - 48px))', () => {
    expect(tooltip).toContain('max-width: min(320px, calc(100vw - 48px))');
    expect(tooltip).not.toContain('min-width: 320px');
  });

  test('D#8: правило .ai-widget-tooltip ограничено по высоте через max-height: 40vh', () => {
    expect(tooltip).toContain('max-height: 40vh');
  });

  test('D#8: содержимое тултипа прокручивается (overflow-y: auto) с containment оверскролла', () => {
    expect(tooltip).toContain('overflow-y: auto');
    expect(tooltip).toContain('overscroll-behavior: contain');
  });

  test('D#8: строки переносятся — white-space: normal вместо nowrap', () => {
    expect(tooltip).toContain('white-space: normal');
    expect(tooltip).not.toContain('white-space: nowrap');
  });

  test('D#8: длинные неразрывные токены переносятся (overflow-wrap: break-word)', () => {
    expect(tooltip).toContain('overflow-wrap: break-word');
  });

  test('R#8: white-space: nowrap не встречается в core/widget.js ни разу', () => {
    expect(WIDGET_SRC).not.toContain('white-space: nowrap');
    expect(occurrences(WIDGET_SRC, 'white-space: nowrap')).toBe(0);
  });

  test('R#8: вертикальный flip не реализован — нет transform: translateY в правиле тултипа', () => {
    expect(tooltip).not.toContain('transform: translateY');
    expect(extractFn(WIDGET_SRC, 'updateWidget')).not.toContain('getBoundingClientRect');
  });
});

describe('R-пины подбатча: правило тултипа не ослаблено и разметка прежняя', () => {
  test('R: префикс правила тултипа байтово прежний (пин tests/widget-collision-a11y-uiaudit.test.js:427)', () => {
    expect(WIDGET_SRC).toContain('.ai-widget-tooltip { visibility: hidden; opacity: 0; position: absolute; bottom: 76px;');
  });

  test('R: прочие свойства тултипа не тронуты (right/фон/цвет/padding/радиус/шрифт)', () => {
    expect(tooltip).toContain('right: 0');
    expect(tooltip).toContain('background: var(--w-tooltip-bg)');
    expect(tooltip).toContain('color: var(--w-tooltip-text)');
    expect(tooltip).toContain('padding: 8px 12px');
    expect(tooltip).toContain('border-radius: 8px');
    expect(tooltip).toContain('font-size: 12px');
    expect(tooltip).toContain('line-height: 1.4');
    expect(tooltip).toContain('box-shadow: var(--w-shadow)');
    expect(tooltip).toContain('border: var(--w-border)');
  });

  test('R: сборка многострочного тултипа в updateWidget обновлена под #22 (span-обёртка строк)', () => {
    const updateSrc = extractFn(WIDGET_SRC, 'updateWidget');
    expect(updateSrc).toContain('tooltip.appendChild(document.createElement(\'br\'));');
    expect(updateSrc).toContain('row.textContent = line;');
    expect(occurrences(updateSrc, 'textContent = line')).toBe(1);
    expect(occurrences(updateSrc, 'createTextNode')).toBe(0);
  });

  test('R: разметка виджета прежняя — текст и тултип подряд', () => {
    expect(WIDGET_SRC).toContain('<div class="ai-widget-text">—</div> <div class="ai-widget-tooltip">');
  });

  test('R: правило .ai-widget-circle не изменено (размер/hover/transition)', () => {
    const circle = ruleBody(WIDGET_SRC, '.ai-widget-circle');
    expect(circle).toContain('width: 64px');
    expect(circle).toContain('height: 64px');
    expect(WIDGET_SRC).toContain('.ai-widget-circle:hover { transform: scale(1.06); }');
  });
});

describe('Токен-инвариант подбатча — новых --w-* токенов не вводили (H25)', () => {
  test('R: в core/widget.js нет ни одной подстроки --w-panel', () => {
    expect(WIDGET_SRC).not.toContain('--w-panel');
    expect(occurrences(WIDGET_SRC, '--w-panel')).toBe(0);
  });

  test('R: applyNativeStyles по-прежнему пишет ровно 8 токенов --w-*', () => {
    expect(occurrences(extractFn(WIDGET_SRC, 'applyNativeStyles'), "setProperty('--w-")).toBe(8);
  });
});
