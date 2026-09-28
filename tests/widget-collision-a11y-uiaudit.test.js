/**
 * UI-аудит 2026-09-28 (docs/UI_AUDIT_QWEN_2026-09-28.md), два Critical — пины одной итерации:
 *   #1 collision-safe позиция индикатора (WCAG 2.2 AA 1.4.10 Reflow): индикатор 64×64 в
 *      правом нижнем углу перекрывал поле ввода и кнопку отправки на узком окне →
 *      подъём через --acm-safe-bottom (потолок min(40vh, 320px) — честная граница);
 *   #2 доступность индикатора (WCAG 2.2 AA 2.1.1 / 2.4.7 / 4.1.2): role/tabindex/aria,
 *      Enter+Space, Escape, клик вне панели, focus-visible, доступное имя с процентом.
 *
 * Тела функций и константы берутся из РЕАЛЬНОГО core/widget.js и исполняются в песочнице
 * (конвенция H11/H22/H24/H25). D-пин — дефект: падает на коде до фикса (извлечение
 * функции/константы не находит её вовсе). R-пин — регресс: падает при поломке соседнего
 * поведения (позиция без коллизии, 8 токенов темы, тихий путь H25, разметка стрелок).
 *
 * jsdom: getBoundingClientRect() = нули, offsetParent = null у всех → в D-пинах rect и
 * offsetParent подменяются точечно; окно — фейковое (innerHeight/rAF/слушатели), поэтому
 * пересчёт, троттлинг и идемпотентность сторожа проверяются детерминированно.
 */
const fs = require('fs');
const path = require('path');
const HELPERS = require('./helpers/content-source.js');

const ROOT = HELPERS.ROOT;
const WIDGET_SRC = HELPERS.moduleSource('core/widget.js');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));
const RU = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'ru', 'messages.json'), 'utf8'));

const VH = 768;          // высота окна в песочницах по умолчанию
const CIRCLE_PX = 64;    // высота индикатора: .ai-widget-circle { width: 64px; height: 64px; }

jest.useFakeTimers();

// ---------- извлечение РЕАЛЬНЫХ тел функций/констант из исходника ----------
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

function extractConstObject(src, name) {
  const marker = 'const ' + name + ' = ';
  const i = src.indexOf(marker);
  expect([name, i > -1]).toEqual([name, true]);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(src.indexOf('{', i), k + 1);
    }
  }
  throw new Error('unbalanced const body: ' + name);
}

/** Значение скалярной константы вместе с литералом (строка/число/объект). */
function extractConst(src, name) {
  const marker = 'const ' + name + ' = ';
  const i = src.indexOf(marker);
  expect([name, i > -1]).toEqual([name, true]);
  const j = src.indexOf(';', i);
  return src.slice(i + marker.length, j);
}

// ---------- фейковое окно: высота, кадры, слушатели — всё под контролем теста ----------
function makeFakeWindow(vh) {
  const listeners = { resize: [], scroll: [] };
  const rafQueue = [];
  return {
    innerHeight: vh === undefined ? VH : vh,
    listeners: listeners,
    rafQueue: rafQueue,
    requestAnimationFrame: function (cb) { rafQueue.push(cb); return rafQueue.length; },
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: function (type, fn) {
      const arr = listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    }
  };
}

// ---------- песочница #1: позиционирование (пп.1.1-1.6) ----------
function safeBottomSrcLines() {
  return [
    'const AI_CM_SAFE_BOTTOM_DEFAULT = ' + extractConst(WIDGET_SRC, 'AI_CM_SAFE_BOTTOM_DEFAULT') + ';',
    'const AI_CM_SAFE_BOTTOM_MIN = ' + extractConst(WIDGET_SRC, 'AI_CM_SAFE_BOTTOM_MIN') + ';',
    'const AI_CM_SAFE_BOTTOM_GAP = ' + extractConst(WIDGET_SRC, 'AI_CM_SAFE_BOTTOM_GAP') + ';',
    'const AI_CM_SAFE_BOTTOM_MAX_PX = ' + extractConst(WIDGET_SRC, 'AI_CM_SAFE_BOTTOM_MAX_PX') + ';',
    'const AI_CM_SAFE_BOTTOM_MAX_VH = ' + extractConst(WIDGET_SRC, 'AI_CM_SAFE_BOTTOM_MAX_VH') + ';',
    'const AI_CM_SAFE_BOTTOM_THROTTLE_MS = ' + extractConst(WIDGET_SRC, 'AI_CM_SAFE_BOTTOM_THROTTLE_MS') + ';',
    'const AI_CM_BOTTOM_CONTROL_SELECTOR = ' + extractConst(WIDGET_SRC, 'AI_CM_BOTTOM_CONTROL_SELECTOR') + ';',
    'const AI_CM_SAFE_BOTTOM_LISTEN_OPTS = ' + extractConst(WIDGET_SRC, 'AI_CM_SAFE_BOTTOM_LISTEN_OPTS') + ';',
    'let widgetElement = null;',
    'let aiCmSafeBottomWatchContainer = null;',
    'let aiCmSafeBottomObserver = null;',
    'let aiCmSafeBottomTimer = null;',
    'let aiCmSafeBottomRafPending = false;',
    'let aiCmSafeBottomLastRunAt = 0;',
    extractFn(WIDGET_SRC, 'aiCmWidgetHostEl'),
    extractFn(WIDGET_SRC, 'aiCmComputeWidgetSafeBottom'),
    extractFn(WIDGET_SRC, 'aiCmUpdateWidgetSafeBottom'),
    extractFn(WIDGET_SRC, 'aiCmSafeBottomFlush'),
    extractFn(WIDGET_SRC, 'aiCmSafeBottomSchedule'),
    extractFn(WIDGET_SRC, 'aiCmStartWidgetSafeBottomWatch'),
    extractFn(WIDGET_SRC, 'aiCmStopWidgetSafeBottomWatch'),
    extractFn(WIDGET_SRC, 'aiCmRestartWidgetSafeBottomWatch')
  ];
}

const SAFE_API = 'ctx.__api = { compute: aiCmComputeWidgetSafeBottom,' +
  ' update: aiCmUpdateWidgetSafeBottom, start: aiCmStartWidgetSafeBottomWatch,' +
  ' stop: aiCmStopWidgetSafeBottomWatch, restart: aiCmRestartWidgetSafeBottomWatch,' +
  ' setWidget: function (el) { widgetElement = el; },' +
  ' watch: function () { return aiCmSafeBottomWatchContainer; },' +
  ' observer: function () { return aiCmSafeBottomObserver; },' +
  ' timer: function () { return aiCmSafeBottomTimer; } };';

function safeSandbox(vh) {
  const win = makeFakeWindow(vh);
  const ctx = { document: document, window: win, MutationObserver: MutationObserver, __api: null };
  new Function('ctx', 'with (ctx) {\n' + safeBottomSrcLines().concat([SAFE_API]).join('\n') + '\n}')(ctx);
  return { ctx: ctx, win: win, api: ctx.__api };
}

/** Хост-элемент виджета с записанными значениями --acm-safe-bottom. */
function makeHost() {
  const host = document.createElement('div');
  host.id = 'ai-context-widget';
  document.body.appendChild(host);
  return host;
}

/** Хост-контрол: видимый, с rect в нижней половине окна (jsdom сам rect не считает). */
function makeControl(opts) {
  const o = opts || {};
  const el = document.createElement(o.tag || 'textarea');
  if (o.attrs) Object.keys(o.attrs).forEach(function (k) { el.setAttribute(k, o.attrs[k]); });
  const top = o.top === undefined ? 700 : o.top;
  const height = o.height === undefined ? 40 : o.height;
  el.getBoundingClientRect = function () {
    return { top: top, bottom: top + height, left: 0, right: 500, width: o.width === undefined ? 500 : o.width, height: height };
  };
  if (o.offsetParent !== false) Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  document.body.appendChild(el);
  return el;
}

/** Прогон отложенного пересчёта: throttle 150 мс → кадр отрисовки (фейковые окно/таймеры). */
function runWatchCycle(sandbox) {
  jest.advanceTimersByTime(200);          // часы уходят вперёд — троттл пропускает
  (sandbox.win.listeners.resize[0] || function () { })();
  const raf = sandbox.win.rafQueue.shift();
  if (raf) raf();
}

// ---------- песочница #2: виджет целиком (разметка + a11y-обработчики) ----------
function i18nFrom(messages) {
  return function (key, fallback, subs) {
    const entry = messages[key];
    if (!entry || !entry.message) return fallback;
    if (!subs) return entry.message;
    return entry.message.replace(/\$(\d)/g, function (m, n) {
      const v = subs[Number(n) - 1];
      return (v === undefined || v === null) ? m : String(v);
    });
  };
}

function a11ySrcLines() {
  return [
    'let aiCmWidgetA11yBound = false;',
    extractFn(WIDGET_SRC, 'aiCmWidgetCircleEl'),
    extractFn(WIDGET_SRC, 'aiCmWidgetPanelEl'),
    extractFn(WIDGET_SRC, 'aiCmSetWidgetPanelOpen'),
    extractFn(WIDGET_SRC, 'aiCmToggleWidgetPanel'),
    extractFn(WIDGET_SRC, 'aiCmWidgetA11yKeydown'),
    extractFn(WIDGET_SRC, 'aiCmWidgetA11yDocClick'),
    extractFn(WIDGET_SRC, 'aiCmBindWidgetA11y'),
    extractFn(WIDGET_SRC, 'aiCmSetWidgetA11yLabel'),
    extractFn(WIDGET_SRC, 'createWidget')
  ];
}

const A11Y_API = 'ctx.__api = { create: createWidget,' +
  ' circle: aiCmWidgetCircleEl, panel: aiCmWidgetPanelEl,' +
  ' toggle: aiCmToggleWidgetPanel, label: aiCmSetWidgetA11yLabel,' +
  ' bind: aiCmBindWidgetA11y,' +
  ' stopWatch: aiCmStopWidgetSafeBottomWatch,' +
  ' widget: function () { return widgetElement; } };';

let activeSandbox = null;

function widgetSandbox(messages) {
  const win = makeFakeWindow(VH);
  const ctx = {
    document: document,
    window: win,
    MutationObserver: MutationObserver,
    aiCmI18nMessage: i18nFrom(messages || EN),
    applyNativeStyles: jest.fn(),
    updatePanel: jest.fn(),
    processAndSend: jest.fn(),
    aiCmStartThemePoll: jest.fn(),
    aiCmRevealWidget: jest.fn(),
    aiCmBadgeHoldActive: function () { return false; },
    snapCurrentPct: jest.fn(),
    resetSafePct: jest.fn(),
    stepSafePct: jest.fn(),
    setSafePctFromInput: jest.fn(),
    __api: null
  };
  const src = safeBottomSrcLines().concat(a11ySrcLines()).concat([A11Y_API]).join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  activeSandbox = { ctx: ctx, win: win, api: ctx.__api };
  return activeSandbox;
}

// ---------- песочница #3: тема (8 токенов + тихий путь H25) ----------
function themeSandbox(hostname) {
  const ctx = {
    document: document,
    window: {
      location: { hostname: hostname || 'chatgpt.com' },
      matchMedia: function () { return { matches: false, addEventListener: function () { }, removeEventListener: function () { } }; },
      getComputedStyle: function (el) { return window.getComputedStyle(el); }
    },
    debugLog: function () { },
    __api: null
  };
  const src = [
    'const THEME_CONFIGS = ' + extractConstObject(WIDGET_SRC, 'THEME_CONFIGS') + ';',
    extractFn(WIDGET_SRC, 'getServiceKey'),
    extractFn(WIDGET_SRC, 'aiCmInAppTheme'),
    extractFn(WIDGET_SRC, 'isDarkMode'),
    'let aiCmWidgetAppliedTheme = null;',
    extractFn(WIDGET_SRC, 'applyNativeStyles'),
    extractFn(WIDGET_SRC, 'aiCmRefreshThemeIfNeeded'),
    'ctx.__api = { apply: applyNativeStyles, refresh: aiCmRefreshThemeIfNeeded, applied: function () { return aiCmWidgetAppliedTheme; } };'
  ].join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return ctx;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  document.body.style.backgroundColor = '';
  document.documentElement.className = '';
});

afterEach(() => {
  if (activeSandbox && activeSandbox.api && activeSandbox.api.stopWatch) {
    try { activeSandbox.api.stopWatch(); } catch (eCleanup) { }
  }
  activeSandbox = null;
  document.body.innerHTML = '';
});

// =====================================================================
// D-пины (дефект #1): коллизия индикатора с нижними хост-контролами
// =====================================================================
describe('Critical #1: --acm-safe-bottom (D-пины)', () => {
  test('D1: textarea в нижней половине → подъём > 24px, индикатор не перекрывает контрол', () => {
    const host = makeHost();
    const control = makeControl({ top: 700 });
    const s = safeSandbox();
    const px = s.api.compute(host);
    expect(px).toBe(VH - 700 + 12);            // 80: верх контрола + зазор
    expect(px).toBeGreaterThan(24);
    expect(VH - px).toBeLessThanOrEqual(control.getBoundingClientRect().top); // низ индикатора выше верха контрола
    expect(VH - px - CIRCLE_PX).toBeGreaterThanOrEqual(0);
    expect(s.api.update(host)).toBe(px);
    expect(host.style.getPropertyValue('--acm-safe-bottom')).toBe(px + 'px');
    expect(s.win.listeners.resize.length).toBe(0); // чистый расчёт сторож не взводит
  });

  test('D2: кандидатов нет → 24px (значение равно CSS-фолбэку)', () => {
    const host = makeHost();
    makeControl({ top: 100 });   // верхняя половина экрана — не помеха
    makeControl({ top: 200 });
    const s = safeSandbox();
    expect(s.api.compute(host)).toBe(24);
    expect(s.api.update(host)).toBe(24);
    expect(host.style.getPropertyValue('--acm-safe-bottom')).toBe('24px');
  });

  test('D3: контрол верхней половины экрана игнорируется (rect.bottom <= innerHeight/2)', () => {
    const host = makeHost();
    makeControl({ top: 300, height: 80 });  // bottom 380 < 384
    const s = safeSandbox();
    expect(s.api.compute(host)).toBe(24);
    expect(s.api.update(host)).toBe(24);
  });

  test('D4: несколько контролов → берётся минимальный rect.top (наибольший подъём)', () => {
    const host = makeHost();
    makeControl({ top: 620 });
    makeControl({ top: 500 });
    makeControl({ top: 700 });
    const s = safeSandbox();
    expect(s.api.compute(host)).toBe(VH - 500 + 12); // 280 — по самому верхнему из нижних
    expect(s.api.compute(host)).toBeGreaterThan(VH - 620 + 12);
  });

  test('D5: потолок = min(40vh, 320px) — контрол выше потолка остаётся перекрыт (known limit)', () => {
    const host = makeHost();
    makeControl({ top: 100, height: 600 }); // bottom 700 > 384, top 100 в окне
    const s = safeSandbox();
    expect(s.api.compute(host)).toBeCloseTo(VH * 0.4, 5); // 307.2 < 320: режет высота окна
    expect(s.api.compute(host)).toBeGreaterThan(307);
    const narrow = safeSandbox(500);
    expect(narrow.api.compute(host)).toBe(200); // 40% от 500 = 200 < 320
    const tall = safeSandbox(2000);
    makeControl({ top: 1500, height: 100 });    // нижняя половина окна 2000
    expect(tall.api.compute(host)).toBe(320);   // 40% от 2000 = 800 → режет уже 320px
  });

  test('D6: нижний клампинг — не ниже 12px даже на крошечном окне', () => {
    const host = makeHost();
    makeControl({ top: 0, height: 6 });
    const s = safeSandbox(10);
    expect(s.api.compute(host)).toBe(12);
  });

  test('D7: контрол внутри виджета (#ai-context-widget) кандидатом не считается', () => {
    const host = makeHost();
    const inner = document.createElement('div');
    inner.setAttribute('role', 'textbox');
    inner.getBoundingClientRect = function () { return { top: 700, bottom: 740, left: 0, right: 100, width: 100, height: 40 }; };
    Object.defineProperty(inner, 'offsetParent', { value: host, configurable: true });
    host.appendChild(inner);
    const s = safeSandbox();
    expect(s.api.compute(host)).toBe(24);
  });

  test('D8: скрытый, нулевой и ушедший за низ окна контрол не двигают индикатор', () => {
    const host = makeHost();
    makeControl({ top: 700, offsetParent: false });      // hidden: offsetParent = null
    makeControl({ top: 700, width: 0 });                 // нулевая ширина
    makeControl({ top: 700, height: 0 });                // нулевая высота
    makeControl({ top: VH + 10 });                       // ниже окна
    const s = safeSandbox();
    expect(s.api.compute(host)).toBe(24);
  });

  test('D9: сторож пересчитывает значение при изменении DOM (throttle 150 мс → кадр)', () => {
    const host = makeHost();
    const control = makeControl({ top: 700 });
    const s = safeSandbox();
    s.api.start(host);
    expect(host.style.getPropertyValue('--acm-safe-bottom')).toBe('80px'); // стартовый расчёт
    expect(s.win.listeners.resize.length).toBe(1);
    expect(s.win.listeners.scroll.length).toBe(1);
    control.remove();                                    // коллизия исчезла
    runWatchCycle(s);
    expect(host.style.getPropertyValue('--acm-safe-bottom')).toBe('24px'); // пересчёт состоялся
    expect(Math.round(VH - 24 - CIRCLE_PX)).toBe(680);
  });

  test('D10: сторож гаснет сам, когда виджет снят из DOM (showWidget=false)', () => {
    const host = makeHost();
    makeControl({ top: 700 });
    const s = safeSandbox();
    s.api.start(host);
    expect(s.api.observer()).not.toBeNull();
    host.remove();
    runWatchCycle(s);
    expect(s.api.watch()).toBeNull();
    expect(s.api.observer()).toBeNull();
    expect(s.win.listeners.resize.length).toBe(0);
    expect(s.win.listeners.scroll.length).toBe(0);
  });

  test('D11: сторож идемпотентен — повторный запуск не плодит слушателей и наблюдателя', () => {
    const host = makeHost();
    const s = safeSandbox();
    s.api.start(host);
    const observer = s.api.observer();
    s.api.start(host);
    s.api.start(host);
    expect(s.win.listeners.resize.length).toBe(1);
    expect(s.win.listeners.scroll.length).toBe(1);
    expect(s.api.observer()).toBe(observer);
    s.api.stop();
    expect(s.win.listeners.resize.length).toBe(0);
    expect(s.api.watch()).toBeNull();
  });

  test('D12: restart (смена SPA-страницы) гасит старый сторож и пересчитывает для текущего виджета', () => {
    const first = makeHost();
    const s = safeSandbox();
    s.api.start(first);
    expect(s.api.watch()).toBe(first);
    const second = document.createElement('div');
    second.id = 'ai-context-widget';
    document.body.appendChild(second);
    makeControl({ top: 700 });
    s.api.setWidget(second);
    s.api.restart();
    expect(s.api.watch()).toBe(second);
    expect(first.style.getPropertyValue('--acm-safe-bottom')).toBe('24px'); // прошлое значение не переписывается
    expect(second.style.getPropertyValue('--acm-safe-bottom')).toBe('80px');
    expect(s.win.listeners.resize.length).toBe(1); // слушатели не удвоились
  });
});

// =====================================================================
// R-пины: позиция без коллизии, токены темы, тихий путь H25, разметка
// =====================================================================
describe('Critical #1: регрессы (R-пины)', () => {
  test('R1: без коллизии позиция байтово прежняя — CSS-фолбэк 24px', () => {
    expect(WIDGET_SRC).toContain('#ai-context-widget { position: fixed; bottom: var(--acm-safe-bottom, 24px); right: 24px;');
    const host = makeHost();
    const s = safeSandbox();
    s.api.update(host);
    expect(host.style.getPropertyValue('--acm-safe-bottom')).toBe('24px');
    expect(WIDGET_SRC).toContain('.ai-widget-tooltip { visibility: hidden; opacity: 0; position: absolute; bottom: 76px;');
  });

  test('R2: applyNativeStyles — те же 8 токенов --w-*, ноль записей при неизменной теме (H25)', () => {
    const ctx = themeSandbox('chatgpt.com');
    const writes = [];
    const fake = { style: { setProperty: function (name, value) { writes.push([name, value]); } } };
    ctx.__api.apply(fake);
    expect(writes.map(function (w) { return w[0]; })).toEqual([
      '--w-font', '--w-bg-track', '--w-bg-fill', '--w-text',
      '--w-tooltip-bg', '--w-tooltip-text', '--w-shadow', '--w-border'
    ]);
    const first = writes.length;
    ctx.__api.refresh(fake);                  // тема не менялась
    expect(writes.length).toBe(first);        // тихий путь H25: ноль style-записей
    expect(writes.some(function (w) { return w[0] === '--acm-safe-bottom'; })).toBe(false);
  });

  test('R3: --acm-safe-bottom пишется ровно из одной точки и не в applyNativeStyles', () => {
    expect((WIDGET_SRC.match(/setProperty\('--acm-safe-bottom'/g) || []).length).toBe(1);
    expect((WIDGET_SRC.match(/bottom: var\(--acm-safe-bottom, 24px\)/g) || []).length).toBe(1); // единственное чтение var()
    expect(extractFn(WIDGET_SRC, 'applyNativeStyles')).not.toContain('acm-safe-bottom');
    expect(extractFn(WIDGET_SRC, 'applyNativeStyles').match(/setProperty\('--w-/g).length).toBe(8);
    expect(extractFn(WIDGET_SRC, 'aiCmUpdateWidgetSafeBottom')).toContain("setProperty('--acm-safe-bottom', px + 'px')");
  });

  test('R4: разметка виджета — стрелки ▲▼ и их aria-label/tabindex не тронуты', () => {
    expect(WIDGET_SRC).toContain('<button type="button" class="ai-cm-spin-up" tabindex="-1" aria-label="${t(\'content_panel_spin_up\', \'увеличить порог\')}">▲</button>');
    expect(WIDGET_SRC).toContain('<button type="button" class="ai-cm-spin-down" tabindex="-1" aria-label="${t(\'content_panel_spin_down\', \'уменьшить порог\')}">▼</button>');
    expect(WIDGET_SRC).toContain('<div class="ai-widget-text">—</div> <div class="ai-widget-tooltip">');
    expect((WIDGET_SRC.match(/\('content_widget_loading'/g) || []).length).toBe(2);
  });

  test('R5: круг индикатора — размер, hover и transition прежние; фокус-кольцо добавлено отдельно', () => {
    expect(WIDGET_SRC).toContain('.ai-widget-circle { width: 64px; height: 64px; position: relative; cursor: pointer;');
    expect(WIDGET_SRC).toContain('transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);');
    expect(WIDGET_SRC).toContain('.ai-widget-circle:hover { transform: scale(1.06); } .ai-widget-circle:focus-visible { outline: 2px solid var(--w-text); outline-offset: 2px; }');
    expect(WIDGET_SRC).toContain('.ai-widget-circle svg { width: 88%; height: 88%; transform: rotate(-90deg); }');
  });

  test('R6: updateWidget по-прежнему печатает процент и обновляет доступное имя рядом с ним', () => {
    const updateSrc = extractFn(WIDGET_SRC, 'updateWidget');
    expect(updateSrc).toContain("percentText.textContent = aiCmStalePlaceholder ? '—' : (percentage.toFixed(1) + '%');");
    expect(updateSrc).toContain("aiCmSetWidgetA11yLabel(widgetElement.querySelector('.ai-widget-circle'), percentage)");
    expect(updateSrc).toContain('catch (eA11yW)');   // песочницы без хелпера остаются рабочими
  });
});

// =====================================================================
// D/R-пины #2: доступность индикатора
// =====================================================================
describe('Critical #2: доступность индикатора (D/R-пины)', () => {
  test('D13: разметка — role/tabindex/aria-* и id панели', () => {
    const markup = WIDGET_SRC.slice(WIDGET_SRC.indexOf('</style>'));
    expect(markup).toContain('<div class="ai-widget-circle" tabindex="0" role="button" aria-haspopup="dialog" aria-controls="ai-widget-panel" aria-expanded="false"');
    expect(markup).toContain('<div class="ai-widget-panel" id="ai-widget-panel">');
    const s = widgetSandbox();
    s.api.create();
    const circle = s.api.circle();
    const panel = s.api.panel();
    expect(circle.getAttribute('role')).toBe('button');
    expect(circle.getAttribute('tabindex')).toBe('0');
    expect(circle.getAttribute('aria-haspopup')).toBe('dialog');
    expect(circle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('ai-widget-panel')).toBe(panel);          // aria-controls ведёт на реальный узел
    expect(document.getElementById(circle.getAttribute('aria-controls'))).toBe(panel);
  });

  test('D14: клик по индикатору открывает панель — aria-expanded, класс .open, фокус в поле', () => {
    const s = widgetSandbox();
    s.api.create();
    const circle = s.api.circle();
    const panel = s.api.panel();
    circle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(panel.classList.contains('open')).toBe(true);
    expect(s.api.widget().classList.contains('ai-panel-open')).toBe(true);
    expect(circle.getAttribute('aria-expanded')).toBe('true');
    expect(s.ctx.updatePanel).toHaveBeenCalled();
    expect(document.activeElement).toBe(s.api.widget().querySelector('.ai-cm-input'));
  });

  test('D15: Enter тогглит панель и возвращает фокус на индикатор', () => {
    const s = widgetSandbox();
    s.api.create();
    const circle = s.api.circle();
    const panel = s.api.panel();
    circle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(panel.classList.contains('open')).toBe(true);
    expect(circle.getAttribute('aria-expanded')).toBe('true');
    circle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(panel.classList.contains('open')).toBe(false);
    expect(circle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(circle);
  });

  test('D16: Space тогглит панель и не прокручивает страницу (preventDefault)', () => {
    const s = widgetSandbox();
    s.api.create();
    const circle = s.api.circle();
    s.ctx.updatePanel.mockClear();           // createWidget тоже зовёт updatePanel — считаем только панель
    const evt = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    circle.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(s.api.panel().classList.contains('open')).toBe(true);
    const evt2 = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    circle.dispatchEvent(evt2);
    expect(s.api.panel().classList.contains('open')).toBe(false);
    expect(s.ctx.updatePanel).toHaveBeenCalledTimes(1); // панель перерисовывается только при открытии
  });

  test('D17: Escape закрывает панель и возвращает фокус на индикатор', () => {
    const s = widgetSandbox();
    s.api.create();
    const circle = s.api.circle();
    s.api.toggle(true);
    expect(s.api.panel().classList.contains('open')).toBe(true);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(s.api.panel().classList.contains('open')).toBe(false);
    expect(circle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(circle);
  });

  test('D18: клик вне панели закрывает её, клик внутри — нет', () => {
    const s = widgetSandbox();
    s.api.create();
    const panel = s.api.panel();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    s.api.toggle(true);
    panel.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(panel.classList.contains('open')).toBe(true);  // клик внутри виджета — не «вне панели»
    outside.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(panel.classList.contains('open')).toBe(false);
    expect(s.api.circle().getAttribute('aria-expanded')).toBe('false');
  });

  test('D19: доступное имя — процент и статус зоны (en), границы 50/80 как у zoneColor', () => {
    const s = widgetSandbox(EN);
    s.api.create();
    const circle = s.api.circle();
    expect(circle.getAttribute('aria-label')).toBe(EN.content_a11y_circle_initial.message);
    s.api.label(circle, 77.5);
    expect(circle.getAttribute('aria-label')).toBe('AI Context Monitor: 77.5% context used, warning');
    s.api.label(circle, 49.9);
    expect(circle.getAttribute('aria-label')).toBe('AI Context Monitor: 49.9% context used, ok');
    s.api.label(circle, 50);
    expect(circle.getAttribute('aria-label')).toBe('AI Context Monitor: 50.0% context used, warning');
    s.api.label(circle, 80);
    expect(circle.getAttribute('aria-label')).toBe('AI Context Monitor: 80.0% context used, critical');
  });

  test('D19b: доступное имя в ru — своя строка статуса из локали', () => {
    const ru = widgetSandbox(RU);   // свежий DOM: второй createWidget в том же документе не создаётся
    ru.api.create();
    const circle = ru.api.circle();
    expect(circle.getAttribute('aria-label')).toBe(RU.content_a11y_circle_initial.message);
    ru.api.label(circle, 77.5);
    expect(circle.getAttribute('aria-label')).toBe('AI Context Monitor: 77.5% контекста использовано, внимание');
    ru.api.label(circle, 85);
    expect(circle.getAttribute('aria-label')).toBe('AI Context Monitor: 85.0% контекста использовано, критично');
  });

  test('R7: без хелпера локали имя собирается из ru-фолбэков байтово как сообщение ru', () => {
    const circle = document.createElement('div');
    const ctx = { __circle: circle };   // aiCmI18nMessage НЕ объявлен → путь фолбэков
    const src = extractFn(WIDGET_SRC, 'aiCmSetWidgetA11yLabel') + '\n' +
      'aiCmSetWidgetA11yLabel(ctx.__circle, 77.5);';
    new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
    expect(circle.getAttribute('aria-label')).toBe(RU.content_a11y_circle_label.message.replace('$1', '77.5').replace('$2', RU.content_a11y_status_warning.message));
    expect(circle.getAttribute('aria-label')).toBe('AI Context Monitor: 77.5% контекста использовано, внимание');
  });

  test('R8: панель без коллизии — стартовое значение пишет createWidget, сторож взведён', () => {
    const s = widgetSandbox();
    s.api.create();
    const w = s.api.widget();
    expect(w.style.getPropertyValue('--acm-safe-bottom')).toBe('24px');
    expect(s.win.listeners.resize.length).toBe(1);   // createWidget взвёл ровно один сторож
    expect(s.win.listeners.scroll.length).toBe(1);
  });
});
