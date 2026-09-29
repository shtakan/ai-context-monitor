/**
 * Регресс #9 (UI-аудит 2026-09-28, Major, найден живой приёмкой 2026-09-29):
 * на низком окне панель .ai-widget-panel уходила ВЫШЕ верха вьюпорта, и срезанное
 * содержимое было недостижимо.
 *
 * Диагноз (принят): `aiCmComputeWidgetSafeBottom` корректен — он возвращает
 * GAP(12) + расстояние от низа вьюпорта до верха нижнего док-контрола (композера),
 * и потому обоснованно растёт на мобильной ширине (там композер выше). Дефект — в CSS:
 * `max-height: calc(100vh - 108px)` считался от 100vh и НЕ вычитал подъём контейнера
 * `--acm-safe-bottom`, поэтому верх панели = vh - safe - 76 - panelH уезжал в минус.
 *
 * Правка: к `max-height` добавлена вторая декларация с clamp(), резервирующая и подъём
 * контейнера, и собственный отступ панели 76px, и воздух 8px (76 + 8 = 84). Первая
 * (историческая) декларация оставлена буквально — она и fallback, и потолок клампа, —
 * её ищет существующий пин tests/panel-overflow-contrast.test.js:55, поэтому НИ ОДИН
 * существующий тест не правился и не ослаблялся.
 *
 * Пины читают РЕАЛЬНЫЙ core/widget.js через tests/helpers/content-source.js
 * (конвенция H11/H22/H24/H25): правило вырезается по селектору, функции — по балансу
 * скобок, числа (min, резерв, потолок, отступ панели) извлекаются ИЗ САМОГО ИСХОДНИКА.
 * Поэтому пин №1 не даст через полгода молча удалить вторую декларацию.
 */
const HELPERS = require('./helpers/content-source.js');

const WIDGET_SRC = HELPERS.moduleSource('core/widget.js');
const PANEL_SELECTOR = '.ai-widget-panel';

/** Базовые числа ДО правки (зафиксированы до неё), чтобы поймать добавление рантайма. */
const ADD_EVENT_LISTENER_BASELINE = 12;
const SET_TIMEOUT_BASELINE = 2;
const SET_INTERVAL_BASELINE = 1;

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

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** Значения ВСЕХ деклараций max-height правила, в порядке появления. */
function maxHeightDecls(rule) {
  return (rule.match(/max-height\s*:\s*[^;]+;/g) || [])
    .map((decl) => decl.replace(/^max-height\s*:\s*/, '').replace(/;$/, '').trim());
}

/** Собственный отступ панели (bottom: Npx) — берётся из правила, а не дублируется. */
function panelOffset(rule) {
  const m = rule.match(/bottom\s*:\s*(-?\d+(?:\.\d+)?)px/);
  expect(['bottom панели', !!m]).toEqual(['bottom панели', true]);
  return Number(m[1]);
}

/**
 * Разбор второй (clamp) декларации из реального исходника: min, fallback подъёма,
 * резерв (отступ панели + воздух) и потолок. Числа НЕ дублируются в тесте.
 */
function clampParts(rule) {
  const clampDecl = maxHeightDecls(rule)[1];
  expect(typeof clampDecl).toBe('string');
  const mMin = clampDecl.match(/^clamp\(\s*(-?\d+(?:\.\d+)?)px\s*,/);
  const mMid = clampDecl.match(
    /calc\(\s*100vh\s*-\s*var\(\s*--acm-safe-bottom\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)\s*-\s*(-?\d+(?:\.\d+)?)px\s*\)/
  );
  const mMax = clampDecl.match(/,\s*calc\(\s*100vh\s*-\s*(-?\d+(?:\.\d+)?)px\s*\)\s*\)$/);
  expect([!!mMin, !!mMid, !!mMax]).toEqual([true, true, true]);
  return {
    decl: clampDecl,
    min: Number(mMin[1]),
    safeFallback: Number(mMid[1]),
    reserve: Number(mMid[2]),
    ceilingReserve: Number(mMax[1])
  };
}

/** Результат max-height панели для данных vh и --acm-safe-bottom (та же арифметика, что в CSS). */
function maxHeightFor(vh, safe, parts) {
  const mid = vh - (safe === undefined ? parts.safeFallback : safe) - parts.reserve;
  const ceiling = vh - parts.ceilingReserve;
  return Math.min(Math.max(parts.min, mid), ceiling);
}

/** Верх панели: отступ панели отсчитывается от поднятого контейнера (vh - safe). */
function panelTop(vh, safe, height, offset) {
  return vh - safe - offset - height;
}

/** Натуральная высота содержимого панели из живой приёмки (PROJECT_HANDOFF, 360×360). */
const NATURAL_PANEL_HEIGHT = 237;

describe('Регресс #9 — панель не уходит за верх вьюпорта на низком окне (D-пины)', () => {
  const panel = ruleBody(WIDGET_SRC, PANEL_SELECTOR);

  test('D#9: в правиле панели ровно ДВЕ декларации max-height (fallback + clamp)', () => {
    expect(maxHeightDecls(panel).length).toBe(2);
    expect(occurrences(panel, 'max-height:')).toBe(2);
  });

  test('D#9: первая декларация — буквально calc(100vh - 108px) (её ищет tests/panel-overflow-contrast.test.js:55)', () => {
    expect(maxHeightDecls(panel)[0]).toBe('calc(100vh - 108px)');
    expect(panel).toContain('max-height: calc(100vh - 108px)');
  });

  test('D#9: первая декларация идёт ДО клампа — иначе CSS-fallback не сработал бы', () => {
    const first = panel.indexOf('max-height: calc(100vh - 108px);');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(panel.indexOf('max-height: clamp('));
  });

  test('D#9: первая декларация снабжена комментарием, объясняющим, почему она оставлена', () => {
    const between = panel.slice(
      panel.indexOf('max-height: calc(100vh - 108px);'),
      panel.indexOf('max-height: clamp(')
    );
    expect(between).toContain('/*');
    expect(between).toContain('*/');
    expect(between).toContain('fallback');
  });

  test('D#9: вторая декларация содержит clamp(, var(--acm-safe-bottom, 130px, 84px и потолок calc(100vh - 108px)', () => {
    const { decl } = clampParts(panel);
    expect(decl).toContain('clamp(');
    expect(decl).toContain('var(--acm-safe-bottom');
    expect(decl).toContain('130px');
    expect(decl).toContain('84px');
    expect(decl).toContain('calc(100vh - 108px)');
  });

  test('D#9: резерв второй декларации = собственный отступ панели + 8px воздуха', () => {
    const parts = clampParts(panel);
    expect(parts.reserve).toBe(panelOffset(panel) + 8);
  });

  test('D#9: bottom панели не изменён (bottom: 76px)', () => {
    expect(panel).toContain('bottom: 76px');
    expect(occurrences(panel, 'bottom:')).toBe(1);
    expect(panelOffset(panel)).toBe(76);
  });

  test('D#9: ширина панели не изменена (width: min(260px, calc(100vw - 48px))) — проверена живьём', () => {
    expect(panel).toContain('width: min(260px, calc(100vw - 48px))');
  });

  test('D#9: прокрутка и containment оверскролла на месте', () => {
    expect(panel).toContain('overflow-y: auto');
    expect(panel).toContain('overscroll-behavior: contain');
  });
});

describe('Регресс #9 — арифметика клампа закрывает именно низкое окно', () => {
  const panel = ruleBody(WIDGET_SRC, PANEL_SELECTOR);
  const parts = clampParts(panel);
  const offset = panelOffset(panel);

  test('D#9: 360×360 при safe=112 (живой замер) — верх панели ВНУТРИ вьюпорта (было -65)', () => {
    const h = maxHeightFor(360, 112, parts);
    expect(h).toBeLessThan(NATURAL_PANEL_HEIGHT); // панель реально сжали, а не «повезло»
    const top = panelTop(360, 112, h, offset);
    expect(top).toBeGreaterThanOrEqual(0); // до правки было -65
    expect(top).toBe(8); // 360 - 112 - 76 - 164
  });

  test('D#9: 360×640 (живая приёмка PASSED) — панель не сжата, живые метрики сохранены', () => {
    const h = Math.min(NATURAL_PANEL_HEIGHT, maxHeightFor(640, 112.5, parts));
    expect(h).toBe(NATURAL_PANEL_HEIGHT);
    expect(Math.round(panelTop(640, 112.5, h, offset))).toBe(215); // живой panelTop приёмки
  });

  test('D#9: потолок остался историческим — при safe по умолчанию панель не выше calc(100vh - 108px)', () => {
    [360, 480, 640, 900].forEach((vh) => {
      expect(maxHeightFor(vh, undefined, parts)).toBeLessThanOrEqual(vh - 108);
    });
  });

  test('D#9: граница применимости честно задокументирована — срез начинается ниже vh = safe + отступ + пол', () => {
    const safe = 112;
    const floorVh = safe + offset + parts.min; // 318: ниже него пол 130px уже не спасает верх панели
    expect(maxHeightFor(floorVh, safe, parts)).toBe(parts.min); // пол уже работает (130 < натуральных 237)
    expect(panelTop(floorVh, safe, parts.min, offset)).toBe(0);
    expect(panelTop(floorVh - 1, safe, maxHeightFor(floorVh - 1, safe, parts), offset)).toBeLessThan(0);
    expect(parts.min).toBeLessThan(NATURAL_PANEL_HEIGHT);
  });

  test('D#9: на экстремально низком окне кламп упирается в исторический потолок, а не в пол', () => {
    const vh = parts.min + parts.ceilingReserve - 10; // здесь потолок vh - 108px сам ниже пола
    expect(maxHeightFor(vh, 112, parts)).toBe(vh - parts.ceilingReserve);
    expect(maxHeightFor(vh, 112, parts)).toBeLessThan(parts.min);
  });

  test('D#9: подъём контейнера учитывается — при safe=12 (пустой композер) кламп не режет живую панель', () => {
    const h = Math.min(NATURAL_PANEL_HEIGHT, maxHeightFor(640, 12, parts));
    expect(h).toBe(NATURAL_PANEL_HEIGHT);
  });
});

describe('Регресс #9 — R-пины: чужое поведение не сломано', () => {
  test("R#9: applyNativeStyles пишет ровно 8 токенов setProperty('--w- (H25 не тронут)", () => {
    const body = extractFn(WIDGET_SRC, 'applyNativeStyles');
    expect((body.match(/setProperty\('--w-/g) || []).length).toBe(8);
  });

  test('R#9: новых токенов панели не вводили — --w-panel отсутствует', () => {
    expect(WIDGET_SRC).not.toContain('--w-panel');
  });

  test('R#9: pointer-events не добавлен (правка CSS-only)', () => {
    expect(WIDGET_SRC).not.toContain('pointer-events');
  });

  test('R#9: новых addEventListener( не добавлено — число равно дореформенному базовому', () => {
    expect(occurrences(WIDGET_SRC, 'addEventListener(')).toBe(ADD_EVENT_LISTENER_BASELINE);
  });

  test('R#9: новых таймеров не добавлено — число setTimeout/setInterval равно базовому', () => {
    expect(occurrences(WIDGET_SRC, 'setTimeout(')).toBe(SET_TIMEOUT_BASELINE);
    expect(occurrences(WIDGET_SRC, 'setInterval(')).toBe(SET_INTERVAL_BASELINE);
  });

  test('R#9: вертикальный flip не реализован — позиция панели осталась CSS-only', () => {
    const panel = ruleBody(WIDGET_SRC, PANEL_SELECTOR);
    expect(panel).not.toContain('transform: translateY');
    expect(extractFn(WIDGET_SRC, 'updatePanel')).not.toContain('getBoundingClientRect');
  });

  test('R#9: aiCmComputeWidgetSafeBottom не тронут — единственный источник --acm-safe-bottom', () => {
    const body = extractFn(WIDGET_SRC, 'aiCmComputeWidgetSafeBottom');
    expect(body).toContain('AI_CM_SAFE_BOTTOM_GAP');
    expect(body).toContain('AI_CM_SAFE_BOTTOM_MIN');
    expect(body).toContain('AI_CM_SAFE_BOTTOM_MAX_PX');
    expect(body).toContain('AI_CM_SAFE_BOTTOM_MAX_VH');
    expect(occurrences(WIDGET_SRC, "setProperty('--acm-safe-bottom'")).toBe(1);
  });
});
