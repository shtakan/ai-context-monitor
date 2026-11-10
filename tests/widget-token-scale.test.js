/**
 * UI-аудит 2026-09-28 (docs/UI_AUDIT_QWEN_2026-09-28.md), находка #16 — типографика
 * и скругления заданы литералами в разных правилах: шкала не выведена в токены,
 * поэтому правка размера шрифта/радиуса требует синхронной правки нескольких мест.
 *
 * Шаги 1–2 закрывают #16 частично: в правиле `#ai-context-widget` объявлена шкала
 * `--w-radius-s/m/l` (6/8/10 px), `--w-space-xs/s/m/l/xl` (4/6/8/10/12 px) и
 * `--w-type-s/m/l` (11/12/13 px); непинованные правила переведены на неё:
 * `.ai-widget-text` (13), `.ai-cm-input` (padding/radius/13), `.ai-cm-btn`
 * (radius/padding/12), `.ai-cm-row` (gap 6). Панельные `padding: 10px` /
 * `border-radius: 10px` / `gap: 6px` и тултиповые `padding: 8px 12px` /
 * `border-radius: 8px` оставлены литералами: они закреплены существующими пинами
 * (tests/panel-overflow-contrast.test.js, tests/tooltip-persist-reflow.test.js,
 * tests/widget-minor-polish.test.js) — токенизация сломала бы чужой пин.
 *
 * Восемь токенов темы (`--w-font`, `--w-bg-track`, `--w-bg-fill`, `--w-text`,
 * `--w-tooltip-bg`, `--w-tooltip-text`, `--w-shadow`, `--w-border`) пишутся через
 * `setProperty` в `applyNativeStyles` и здесь НЕ трогаются — шкала их не заменяет.
 *
 * D = пин находки #16, R = защита чужих пинов и инвариантов виджета.
 */
const HELPERS = require('./helpers/content-source.js');

const WIDGET_SRC = HELPERS.moduleSource('core/widget.ts');

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

/** Тело функции по имени — от `function name(` до парной закрывающей скобки. */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect([name, start > -1]).toEqual([name, true]);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('не найдена закрывающая скобка функции ' + name);
}

describe('#16 шкала токенов типографики и скруглений', () => {
  test('D: корневое правило объявляет шкалу radius (6/8/10)', () => {
    const root = ruleBody(WIDGET_SRC, '#ai-context-widget');
    expect(root).toContain('--w-radius-s: 6px;');
    expect(root).toContain('--w-radius-m: 8px;');
    expect(root).toContain('--w-radius-l: 10px;');
  });

  test('D: корневое правило объявляет шкалу space (4/6/8/10/12)', () => {
    const root = ruleBody(WIDGET_SRC, '#ai-context-widget');
    expect(root).toContain('--w-space-xs: 4px;');
    expect(root).toContain('--w-space-s: 6px;');
    expect(root).toContain('--w-space-m: 8px;');
    expect(root).toContain('--w-space-l: 10px;');
    expect(root).toContain('--w-space-xl: 12px;');
  });

  test('D: корневое правило объявляет шкалу type (11/12/13)', () => {
    const root = ruleBody(WIDGET_SRC, '#ai-context-widget');
    expect(root).toContain('--w-type-s: 11px;');
    expect(root).toContain('--w-type-m: 12px;');
    expect(root).toContain('--w-type-l: 13px;');
  });

  test('D: каждая переменная шкалы объявлена ровно один раз (нет рассинхрона значений)', () => {
    const names = [
      '--w-radius-s', '--w-radius-m', '--w-radius-l',
      '--w-space-xs', '--w-space-s', '--w-space-m', '--w-space-l', '--w-space-xl',
      '--w-type-s', '--w-type-m', '--w-type-l'
    ];
    names.forEach(function (name) {
      expect([name, occurrences(WIDGET_SRC, name + ': ')]).toEqual([name, 1]);
    });
  });

  test('D: .ai-widget-text использует --w-type-l (вместо литерала 13px)', () => {
    const body = ruleBody(WIDGET_SRC, '.ai-widget-text');
    expect(body).toContain('font-size: var(--w-type-l);');
    expect(body).not.toContain('font-size: 13px;');
  });

  test('D: .ai-cm-input использует --w-space-xs / --w-radius-s / --w-type-l', () => {
    const body = ruleBody(WIDGET_SRC, '.ai-cm-input');
    expect(body).toContain('padding: var(--w-space-xs) 2px;');
    expect(body).toContain('border-radius: var(--w-radius-s);');
    expect(body).toContain('font-size: var(--w-type-l);');
    expect(body).not.toContain('font-size: 13px;');
  });

  test('D: .ai-cm-btn использует --w-radius-s / --w-space-s / --w-space-m / --w-type-m', () => {
    const body = ruleBody(WIDGET_SRC, '.ai-cm-btn');
    expect(body).toContain('border-radius: var(--w-radius-s);');
    expect(body).toContain('padding: var(--w-space-s) var(--w-space-m);');
    expect(body).toContain('font-size: var(--w-type-m);');
  });

  test('D: .ai-cm-row использует --w-space-s для gap', () => {
    const body = ruleBody(WIDGET_SRC, '.ai-cm-row');
    expect(body).toContain('gap: var(--w-space-s);');
  });

  test('R: панель сохраняет литералы пинов (padding 10px, radius 10px, gap 6px)', () => {
    const body = ruleBody(WIDGET_SRC, '.ai-widget-panel');
    expect(body).toContain('padding: 10px;');
    expect(body).toContain('border-radius: 10px;');
    expect(body).toContain('gap: 6px;');
    // токены шкалы в панель не просочились
    expect(body).not.toContain('--w-radius');
    expect(body).not.toContain('--w-space');
  });

  test('R: тултип сохраняет литералы пинов (padding 8px 12px, radius 8px, текст 12px)', () => {
    const body = ruleBody(WIDGET_SRC, '.ai-widget-tooltip');
    expect(body).toContain('padding: 8px 12px;');
    expect(body).toContain('border-radius: 8px;');
    expect(body).toContain('font-size: 12px;');
    expect(body).not.toContain('--w-radius');
    expect(body).not.toContain('--w-space');
  });

  test('R: pointer-events в core/widget.ts по-прежнему отсутствует (#9)', () => {
    expect(occurrences(WIDGET_SRC, 'pointer-events')).toBe(0);
  });

  test('R: 8 токенов темы через setProperty не тронуты и не переопределены в CSS', () => {
    const fn = extractFn(WIDGET_SRC, 'applyNativeStyles');
    const theme = [
      '--w-font', '--w-bg-track', '--w-bg-fill', '--w-text',
      '--w-tooltip-bg', '--w-tooltip-text', '--w-shadow', '--w-border'
    ];
    expect(occurrences(fn, "setProperty('--w-")).toBe(8);
    theme.forEach(function (name) {
      expect([name, occurrences(fn, "setProperty('" + name + "'")]).toEqual([name, 1]);
      // токен темы объявляется только через setProperty, не в CSS-шаблоне
      expect([name, occurrences(WIDGET_SRC, name + ': ')]).toEqual([name, 0]);
    });
    // шкала #16 не пишется через setProperty (иначе поедут счётчики 8)
    expect(occurrences(WIDGET_SRC, "setProperty('--w-radius")).toBe(0);
    expect(occurrences(WIDGET_SRC, "setProperty('--w-space")).toBe(0);
    expect(occurrences(WIDGET_SRC, "setProperty('--w-type")).toBe(0);
  });

  test('R: --w-panel не введён (инвариант пинов)', () => {
    expect(occurrences(WIDGET_SRC, '--w-panel')).toBe(0);
  });
});
