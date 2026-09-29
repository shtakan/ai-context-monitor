/**
 * Регресс #26 «тултип схлопывается по ширине» — закрывается в core/widget.js
 * (подбатч 3, UI-аудит #8, регресс после 6e51838).
 *
 * Диагноз (НЕ перепроверяется, зафиксирован): `.ai-widget-tooltip` — shrink-to-fit
 * (position: absolute + display: block, без width/min-width), а `overflow-wrap: anywhere`
 * обнуляет min-content: у absolute-элемента min-content-ширина становится ~1 символ,
 * поэтому текст разваливался на колонки по 1–2 символа на chatgpt.com и gemini.google.com.
 *
 * Правка (только правило `.ai-widget-tooltip`, ничего больше):
 *   #1 `width: max-content`      — ширина считается по самой длинной строке содержимого;
 *   #2 `box-sizing: border-box`  — `max-width: calc(100vw - 48px)` включает padding+border
 *                                  (на Gemini box-sizing = content-box, ограничение текло);
 *   #3 `overflow-wrap: break-word` вместо `anywhere` — токены переносятся, но min-content
 *                                  не обнуляется (задокументированное отличие от `anywhere`).
 *
 * Пины читают РЕАЛЬНЫЙ `core/widget.js` (конвенция H11/H22/H24/H25) и режут правило из
 * инлайн `<style>` по точному селектору; строки CSS в тесте не дублируются, все числа
 * извлекаются из исходника. Пин `tests/tooltip-persist-reflow.test.js` (D#8, строка 118)
 * обновлён осознанно: требование («токены переносятся») сохранено, средство переноса
 * изменено; число тестов в том файле — 19 до и после.
 *
 * Область НЕ расширяется: вертикальный flip не реализован, `pointer-events` не добавлен,
 * Escape-закрытие не добавлено, `aiCmComputeWidgetSafeBottom` и `.ai-widget-panel` не тронуты.
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

/** Число вхождений подстроки (литерал, не регэксп). */
function occurrences(src, needle) {
  return src.split(needle).length - 1;
}

const TOOLTIP_SEL = '.ai-widget-tooltip';
const PANEL_SEL = '.ai-widget-panel';

const tooltip = ruleBody(WIDGET_SRC, TOOLTIP_SEL);
const panel = ruleBody(WIDGET_SRC, PANEL_SEL);

/** Значение CSS-свойства из тела правила; null, если свойства нет. */
function cssValue(body, prop) {
  const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'));
  return m ? m[1].trim() : null;
}

/** Числовые слагаемые значения сокращённой записи padding. */
function paddingPx(value) {
  return String(value).split(/\s+/).filter(Boolean).map((p) => parseFloat(p)).filter((n) => !isNaN(n));
}

describe('Регресс #26 — правило тултипа больше не схлопывается по ширине (D-пины)', () => {
  test('D#1: правило тултипа содержит width: max-content (ширина по содержимому, не min-content)', () => {
    expect(tooltip).toContain('width: max-content');
  });

  test('D#2: правило тултипа содержит box-sizing: border-box (max-width включает padding+border)', () => {
    expect(tooltip).toContain('box-sizing: border-box');
  });

  test('D#3: value(#1) — ровно `max-content`, без fit-content/min-content/auto/100%', () => {
    expect(cssValue(tooltip, 'width')).toBe('max-content');
  });

  test('D#4: value(#2) — ровно `border-box` (не content-box, не inherit)', () => {
    expect(cssValue(tooltip, 'box-sizing')).toBe('border-box');
  });

  test('D#5: max-width остался верхней границей (min(320px, calc(100vw - 48px))) и не был заменён', () => {
    expect(tooltip).toContain('max-width: min(320px, calc(100vw - 48px))');
    expect(tooltip).not.toContain('min-width: 320px');
    expect(tooltip).not.toContain('width: 320px');
  });

  test('D#6: overflow-wrap — `break-word`, а не `anywhere` (anywhere обнуляет min-content)', () => {
    expect(tooltip).toContain('overflow-wrap: break-word');
    expect(tooltip).not.toContain('overflow-wrap: anywhere');
    expect(cssValue(tooltip, 'overflow-wrap')).toBe('break-word');
  });

  test('D#7: padding по горизонтали ненулевой — ограничение max-width реально делит место с текстом', () => {
    const parts = paddingPx(cssValue(tooltip, 'padding'));
    expect(parts.length).toBeGreaterThan(0);
    const horizontal = parts.length === 1 ? parts[0] : parts[1];
    expect(horizontal).toBeGreaterThan(0);
  });
});

describe('Регресс #26 — границы правки не расширены (R-пины)', () => {
  test('R#8: шим-ширина не введена через min-width/fit-content/min-content ни в правиле, ни в файле', () => {
    expect(tooltip).not.toContain('min-width');
    expect(tooltip).not.toContain('fit-content');
    expect(WIDGET_SRC).not.toContain('width: fit-content');
    expect(WIDGET_SRC).not.toContain('width: min-content');
  });

  test('R#9: перенос строк не переключён на nowrap (white-space: normal сохранён)', () => {
    expect(tooltip).toContain('white-space: normal');
    expect(tooltip).not.toContain('white-space: nowrap');
    expect(occurrences(WIDGET_SRC, 'white-space: nowrap')).toBe(0);
  });

  test('R#10: overflow-wrap объявлен в core/widget.js ровно один раз — только в правиле тултипа', () => {
    expect(occurrences(WIDGET_SRC, 'overflow-wrap')).toBe(1);
    expect(occurrences(WIDGET_SRC, 'overflow-wrap: anywhere')).toBe(0);
    expect(occurrences(WIDGET_SRC, 'overflow-wrap: break-word')).toBe(1);
  });

  test('R#11: JS-поведение не изменилось — pointer-events отсутствует, число addEventListener( прежнее', () => {
    expect(WIDGET_SRC).not.toContain('pointer-events');
    expect(tooltip).not.toContain('pointer-events');
    expect(occurrences(WIDGET_SRC, 'addEventListener(')).toBe(12);
  });

  test('R#12: H25 — applyNativeStyles по-прежнему пишет ровно 8 токенов --w-*, новых токенов нет', () => {
    const i = WIDGET_SRC.indexOf('function applyNativeStyles(');
    expect(i).toBeGreaterThan(-1);
    const body = WIDGET_SRC.slice(i, WIDGET_SRC.indexOf('}', i));
    expect(occurrences(body, "setProperty('--w-")).toBe(8);
    expect(WIDGET_SRC).not.toContain('--w-panel');
  });

  test('R#13: .ai-widget-panel не тронут — оба max-height (historical calc + clamp) на месте', () => {
    expect(occurrences(panel, 'max-height:')).toBe(2);
    expect(panel).toContain('max-height: calc(100vh - 108px);');
    expect(panel).toContain('max-height: clamp(130px, calc(100vh - var(--acm-safe-bottom, 24px) - 84px), calc(100vh - 108px));');
  });
});
