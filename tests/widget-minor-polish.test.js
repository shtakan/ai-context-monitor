/**
 * UI-аудит 2026-09-28 (docs/UI_AUDIT_QWEN_2026-09-28.md), Minor-подбатч A — поверхности
 * виджета: #17, #18, #22, #23. Плюс фиксация закрытия #15 (закоммичен deab423).
 *
 *   #23 резкая смена цвета кольца → transition: stroke 0.18s ease добавлен к
 *       существующему stroke-dashoffset 0.4s ease (fill/stroke/*-width/-linecap не тронуты);
 *   #17 нет состояний кнопок панели → :active / :focus-visible / :disabled у
 *       .ai-cm-btn и :active / :disabled у .ai-cm-spin button; фокус-кольцо исключает
 *       декоративные узлы по семантике (aria-hidden), а не по имени класса;
 *   #18 нет аффорданса скролла → scrollbar-width: thin + scrollbar-color в правиле
 *       .ai-widget-panel; fade-маски/sticky-footer НЕ реализованы (требуют pointer-events);
 *   #22 нет иерархии в тултипе → .ai-widget-tt-primary/secondary/sep + span-обёртка
 *       строк в updateWidget (первые 3 — primary, дальше secondary, линейка перед i===3).
 *
 * Пины читают РЕАЛЬНЫЙ core/widget.js тем же приёмом, что tests/panel-overflow-contrast.test.js
 * (ruleBody по селектору + extractFn по имени). D = пин находки, R = защита чужого поведения.
 * Существующие пины не ослаблялись; существующий пин сборки тултипа
 * (tests/tooltip-persist-reflow.test.js) переведён на новую форму сборки (#22,
 * span-обёртка строк); требование безопасной сборки (без innerHTML, по одной
 * текстовой ноде на строку, <br> между строками) сохранено.
 */
const HELPERS = require('./helpers/content-source.js');

const WIDGET_SRC = HELPERS.moduleSource('core/widget.js');

/** Число вхождений подстроки. */
function occurrences(src, sub) {
  return src.split(sub).length - 1;
}

/** Тело CSS-правила по точному селектору (' {') — первое совпадение, до парной '}'. */
function ruleBody(src, selector) {
  const marker = selector + ' {';
  const i = src.indexOf(marker);
  expect([selector, i > -1]).toEqual([selector, true]);
  const end = src.indexOf('}', i);
  expect([selector + ' (закрывающая скобка)', end > i]).toEqual([selector + ' (закрывающая скобка)', true]);
  return src.slice(i + marker.length, end);
}

/** Тело правила, чей селектор лишь НАЧИНАЕТСЯ с фрагмента (объединённые селекторы). */
function ruleBodyAfter(src, fragment) {
  const i = src.indexOf(fragment);
  expect([fragment, i > -1]).toEqual([fragment, true]);
  const open = src.indexOf('{', i);
  const close = src.indexOf('}', open);
  expect([fragment + ' (закрывающая скобка)', close > open]).toEqual([fragment + ' (закрывающая скобка)', true]);
  return src.slice(open + 1, close);
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

describe('D#23 — кольцо виджета меняет цвет не рывком, а за 0.18s', () => {
  const fill = ruleBody(WIDGET_SRC, '.ai-widget-fill');

  test('D#23: transition включает stroke 0.18s ease', () => {
    expect(fill).toContain('transition: stroke 0.18s ease, stroke-dashoffset 0.4s ease;');
  });

  test('R#23: прежний stroke-dashoffset 0.4s ease в том же transition сохранён', () => {
    expect(fill).toContain('stroke-dashoffset 0.4s ease');
  });

  test('R#23: прочие свойства .ai-widget-fill не тронуты', () => {
    expect(fill).toContain('fill: none');
    expect(fill).toContain('stroke: var(--w-bg-fill)');
    expect(fill).toContain('stroke-width: 7');
    expect(fill).toContain('stroke-linecap: round');
  });
});

describe('D#17 — состояния кнопок панели (active/focus-visible/disabled)', () => {
  test('D#17: у .ai-cm-btn есть :focus-visible с outline 2px var(--w-text) и offset 2px', () => {
    const body = ruleBodyAfter(WIDGET_SRC, '.ai-cm-btn:focus-visible:not([aria-hidden="true"])');
    expect(body).toContain('outline: 2px solid var(--w-text)');
    expect(body).toContain('outline-offset: 2px');
  });

  test('D#17: фокус-кольцо исключает декоративные узлы по семантике aria-hidden (не по классу)', () => {
    expect(WIDGET_SRC).toContain('.ai-cm-spin button:focus-visible:not([aria-hidden="true"])');
    expect(WIDGET_SRC).not.toContain('.ai-widget-tt-sep:focus-visible');
  });

  test('D#17: у .ai-cm-btn есть :active и :disabled (opacity: 0.38)', () => {
    expect(ruleBody(WIDGET_SRC, '.ai-cm-btn:active')).toContain('background: rgba(127,127,127,0.45)');
    expect(ruleBody(WIDGET_SRC, '.ai-cm-btn:disabled')).toContain('opacity: 0.38');
    expect(ruleBody(WIDGET_SRC, '.ai-cm-btn:disabled')).toContain('cursor: default');
  });

  test('D#17: у .ai-cm-spin button есть :active и :disabled (opacity: 0.38)', () => {
    expect(ruleBody(WIDGET_SRC, '.ai-cm-spin button:active')).toContain('background: rgba(127,127,127,0.45)');
    expect(ruleBody(WIDGET_SRC, '.ai-cm-spin button:disabled')).toContain('opacity: 0.38');
    expect(ruleBody(WIDGET_SRC, '.ai-cm-spin button:disabled')).toContain('cursor: default');
  });

  test('R#17: hover-состояния сохранены дословно (rgba(127,127,127,0.32))', () => {
    expect(WIDGET_SRC).toContain('.ai-cm-btn:hover { background: rgba(127,127,127,0.32); }');
    expect(WIDGET_SRC).toContain('.ai-cm-spin button:hover { background: rgba(127,127,127,0.32); }');
  });
});

describe('D#18 — аффорданс скролла у панели (scrollbar-width/color)', () => {
  const panel = ruleBody(WIDGET_SRC, '.ai-widget-panel');

  test('D#18: правило .ai-widget-panel содержит scrollbar-width: thin', () => {
    expect(panel).toContain('scrollbar-width: thin');
  });

  test('D#18: правило .ai-widget-panel содержит scrollbar-color: rgba(127,127,127,0.5) transparent', () => {
    expect(panel).toContain('scrollbar-color: rgba(127,127,127,0.5) transparent');
  });

  test('R#18: max-height панели дословно прежний (clamp + fallback)', () => {
    expect(panel).toContain('max-height: clamp(130px, calc(100vh - var(--acm-safe-bottom, 24px) - 84px), calc(100vh - 108px))');
    expect(panel).toContain('max-height: calc(100vh - 108px)');
  });

  test('R#18: padding: 10px и border-radius: 10px в правиле панели не изменены', () => {
    expect(panel).toContain('padding: 10px');
    expect(panel).toContain('border-radius: 10px');
  });

  test('R#18: fade-маски/sticky-footer не реализованы — pointer-events в widget.js отсутствует', () => {
    expect(WIDGET_SRC).not.toContain('pointer-events');
  });
});

describe('D#22 — иерархия содержимого тултипа', () => {
  test('D#22: в CSS есть .ai-widget-tt-primary (13px/600)', () => {
    const primary = ruleBody(WIDGET_SRC, '.ai-widget-tt-primary');
    expect(primary).toContain('font-size: 13px');
    expect(primary).toContain('font-weight: 600');
  });

  test('D#22: в CSS есть .ai-widget-tt-secondary (11px)', () => {
    expect(ruleBody(WIDGET_SRC, '.ai-widget-tt-secondary')).toContain('font-size: 11px');
  });

  test('D#22: в CSS есть .ai-widget-tt-sep — декоративная линейка с opacity на линейке, не на тексте', () => {
    const sep = ruleBody(WIDGET_SRC, '.ai-widget-tt-sep');
    expect(sep).toContain('display: block');
    expect(sep).toContain('height: 1px');
    expect(sep).toContain('background: currentColor');
    expect(sep).toContain('opacity: 0.18');
    expect(sep).toContain('margin: 4px 0');
  });

  test('D#22: в updateWidget первые три строки получают primary, остальные secondary', () => {
    const update = extractFn(WIDGET_SRC, 'updateWidget');
    expect(update).toContain("(i < 3) ? 'ai-widget-tt-primary' : 'ai-widget-tt-secondary'");
    expect(update).toContain('row.textContent = line;');
  });

  test('D#22: разделитель вставляется ровно один раз, перед первой вторичной строкой (i === 3)', () => {
    const update = extractFn(WIDGET_SRC, 'updateWidget');
    expect(update).toContain('if (i === 3) {');
    expect(occurrences(update, "'ai-widget-tt-sep'")).toBe(1);
    expect(update).toContain("sep.setAttribute('aria-hidden', 'true');");
  });

  test('R#22: ни одной новой пользовательской строки — i18n-ключи тултипа на месте', () => {
    expect(occurrences(WIDGET_SRC, "('content_widget_loading'")).toBe(2);
    expect(occurrences(WIDGET_SRC, 'content_tooltip_model')).toBe(1);
    expect(occurrences(WIDGET_SRC, 'content_tooltip_limit_pct')).toBe(1);
    expect(occurrences(WIDGET_SRC, 'content_tooltip_limit_auto')).toBe(1);
    expect(occurrences(WIDGET_SRC, 'content_tooltip_window')).toBe(1);
    // Число КОДОВЫХ вызовов ключа tokens. Подстрока 'content_tooltip_tokens'
    // встречается ещё и в комментарии — пин на неё зависел бы от текста
    // комментария, а он правится свободно.
    expect(occurrences(WIDGET_SRC, "i18n('content_tooltip_tokens'")).toBe(3);
    expect(occurrences(WIDGET_SRC, 'content_source_label')).toBe(1);
  });
});

describe('D#15 — фиксация закрытия находки (коммит deab423)', () => {
  test('D#15: Escape закрывает панель и возвращает фокус (restoreFocus=true)', () => {
    const kd = extractFn(WIDGET_SRC, 'aiCmWidgetA11yKeydown');
    expect(kd).toContain("'Escape'");
    expect(kd).toContain('aiCmSetWidgetPanelOpen(false, true)');
  });

  test('D#15: клик вне панели закрывает без возврата фокуса (restoreFocus=false)', () => {
    const dc = extractFn(WIDGET_SRC, 'aiCmWidgetA11yDocClick');
    expect(dc).toContain('aiCmSetWidgetPanelOpen(false, false)');
  });
});

describe('R — инварианты Minor-подбатча A', () => {
  test('R: --acm-safe-bottom — одна точка записи', () => {
    expect(occurrences(WIDGET_SRC, "setProperty('--acm-safe-bottom'")).toBe(1);
  });

  test('R: подстрока --w-panel отсутствует (новых токенов панели не вводили)', () => {
    expect(WIDGET_SRC).not.toContain('--w-panel');
  });

  test("R: applyNativeStyles пишет ровно 8 токенов setProperty('--w-...')", () => {
    const body = extractFn(WIDGET_SRC, 'applyNativeStyles');
    expect(occurrences(body, "setProperty('--w-")).toBe(8);
  });

  test('R: pointer-events в widget.js отсутствует', () => {
    expect(WIDGET_SRC).not.toContain('pointer-events');
  });

  test('R: число addEventListener( не выросло (12)', () => {
    expect(occurrences(WIDGET_SRC, 'addEventListener(')).toBe(12);
  });

  test('R: число setTimeout(/setInterval( не выросло (3)', () => {
    expect(occurrences(WIDGET_SRC, 'setTimeout(') + occurrences(WIDGET_SRC, 'setInterval(')).toBe(3);
  });

  test('R: разметка кнопок ▲▼ и их aria-атрибуты не менялись', () => {
    expect(WIDGET_SRC).toContain('class="ai-cm-spin-up" tabindex="-1"');
    expect(WIDGET_SRC).toContain('class="ai-cm-spin-down" tabindex="-1"');
    expect(WIDGET_SRC).toContain('role="button" aria-haspopup="dialog" aria-controls="ai-widget-panel" aria-expanded="false"');
  });
});
