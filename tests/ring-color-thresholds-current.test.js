/**
 * v2.0.13: цвет кольца индикатора считается по НАСТРОЕННЫМ порогам
 * (chrome.storage.local 'aiCmProactiveThresholds' = [low, medium, high]), а не по жёстким
 * 50/80. Контракт: pct < low → зелёный, low <= pct < high → жёлтый, pct >= high → красный;
 * low/high — нижний и верхний из настроек, не заданы/битые → дефолт [70,85,95] ⇒ 70/95.
 *
 * Пины:
 *   D20 — дефект: падает на коде до фикса (60.1% при порогах 20/28/54 было жёлтым).
 *   R9  — регресс: живой перекрас кольца при смене настроек без перезагрузки страницы,
 *         те же границы у доступного имени и неприкосновенность уведомлений/бейджа/
 *         автоэкспорта (их пороги НЕ унифицировались — только кольцо).
 *
 * Тела функций берутся из реального core/widget.js и исполняются в песочнице (конвенция
 * H11/H22/H24/H25), поэтому отсутствие chrome/соседних хелперов проверяется по-настоящему.
 */
const HELPERS = require('./helpers/content-source.js');

const WIDGET_SRC = HELPERS.moduleSource('core/widget.js');
const BG_SRC = HELPERS.readSource('core/background.js');
const GIL_SRC = HELPERS.readSource('utils/gemini-intercept-logic.js');

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

/**
 * Песочница кольца: реальные тела aiCmRingBounds/zoneColor/aiCmSetWidgetA11yLabel/
 * aiCmRepaintRing/aiCmLoadRingThresholds + управляемые ctx.widgetElement/lastWidgetData/chrome.
 */
function ringSandbox(opts) {
  const o = opts || {};
  const ctx = {
    aiCmRingThresholds: (o.thresholds === undefined) ? null : o.thresholds,
    widgetElement: o.widgetEl || null,
    lastWidgetData: (o.data === undefined) ? null : o.data,
    chrome: o.chrome
  };
  ctx.document = document;
  const src = [
    extractFn(WIDGET_SRC, 'aiCmRingBounds'),
    extractFn(WIDGET_SRC, 'zoneColor'),
    extractFn(WIDGET_SRC, 'aiCmSetWidgetA11yLabel'),
    extractFn(WIDGET_SRC, 'aiCmRepaintRing'),
    extractFn(WIDGET_SRC, 'aiCmLoadRingThresholds'),
    'ctx.__ringApi = { zoneColor: zoneColor,' +
    ' bounds: aiCmRingBounds,' +
    ' label: aiCmSetWidgetA11yLabel,' +
    ' load: aiCmLoadRingThresholds,' +
    ' repaint: aiCmRepaintRing,' +
    ' setThresholds: function (t) { aiCmRingThresholds = (t === undefined) ? null : t; },' +
    ' setData: function (d) { lastWidgetData = d; },' +
    ' fill: function () { return widgetElement ? widgetElement.querySelector(".ai-widget-fill").style.stroke : null; } };'
  ].join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return { api: ctx.__ringApi, ctx: ctx };
}

/** Хост виджета: круг + заливка, как в разметке createWidget. */
function makeWidgetEl() {
  const el = document.createElement('div');
  el.id = 'ai-context-widget';
  el.innerHTML = '<div class="ai-widget-circle"><svg viewBox="0 0 100 100">' +
    '<circle class="ai-widget-bg" cx="50" cy="50" r="43"/>' +
    '<circle class="ai-widget-fill" cx="50" cy="50" r="43"/></svg></div>';
  document.body.appendChild(el);
  return el;
}

/** chrome.storage.local с одним ключом + подписка onChanged (как в контенте). */
function chromeMock(initial) {
  const listeners = [];
  let stored = initial;
  return {
    listeners: listeners,
    fire: function (newValue) {
      stored = newValue;
      const changes = { aiCmProactiveThresholds: { newValue: newValue } };
      listeners.forEach(function (fn) { fn(changes, 'local'); });
    },
    storage: {
      local: {
        get: function (keys, cb) { cb(stored === undefined ? {} : { aiCmProactiveThresholds: stored }); }
      },
      onChanged: {
        addListener: function (fn) { listeners.push(fn); }
      }
    }
  };
}

describe('v2.0.13: зоны кольца — из настроенных порогов (D20)', () => {
  test('D20: пороги 20/28/54 → 60.1% красный (до фикса было жёлтым по жёстким 50/80)', () => {
    const s = ringSandbox({ thresholds: [20, 28, 54] });
    expect(s.api.bounds()).toEqual([20, 54]);
    expect(s.api.zoneColor(0)).toBe('#22c55e');
    expect(s.api.zoneColor(19.9)).toBe('#22c55e');
    expect(s.api.zoneColor(20)).toBe('#eab308');
    expect(s.api.zoneColor(30)).toBe('#eab308');
    expect(s.api.zoneColor(53.9)).toBe('#eab308');
    expect(s.api.zoneColor(54)).toBe('#ef4444');
    expect(s.api.zoneColor(60.1)).toBe('#ef4444');
    expect(s.api.zoneColor(100)).toBe('#ef4444');
  });

  test('D20b: пороги не заданы → прежние границы «из коробки» 70/95', () => {
    const s = ringSandbox({ thresholds: null });
    expect(s.api.bounds()).toEqual([70, 95]);
    expect(s.api.zoneColor(69.9)).toBe('#22c55e');
    expect(s.api.zoneColor(70)).toBe('#eab308');
    expect(s.api.zoneColor(94.9)).toBe('#eab308');
    expect(s.api.zoneColor(95)).toBe('#ef4444');
  });

  test('D20c: битые пороги → дефолт 70/95 (тот же контракт, что у options.js)', () => {
    [[80, 70, 95], [0, 50, 150], [50, 60], 'nope', {}, [20, 20, 54]].forEach((bad) => {
      const s = ringSandbox({ thresholds: bad });
      expect([bad, s.api.bounds()]).toEqual([bad, [70, 95]]);
    });
    // Дробные значения округляются parseInt — ровно как в options.js:305-317.
    expect(ringSandbox({ thresholds: [20.5, 28.9, 54.1] }).api.bounds()).toEqual([20, 54]);
  });

  test('D20d: пересчёт цвета на каждом вызове — 19% зелёный, 28% жёлтый, 55% красный при порогах 20/28/54', () => {
    const s = ringSandbox({ thresholds: [20, 28, 54] });
    expect(s.api.zoneColor(19)).toBe('#22c55e');
    expect(s.api.zoneColor(28)).toBe('#eab308');
    expect(s.api.zoneColor(55)).toBe('#ef4444');
  });
});

describe('v2.0.13: кольцо читает chrome.storage.local и живо реагирует (R9)', () => {
  test('R9: 60.1% при порогах 20/28/54 → красная заливка сразу после чтения storage', () => {
    const el = makeWidgetEl();
    const ch = chromeMock([20, 28, 54]);
    const s = ringSandbox({ widgetEl: el, data: { percentage: 60.1 }, chrome: ch });
    s.api.load();
    expect(ch.listeners.length).toBe(1);            // живая подписка взведена ровно один раз
    expect(s.api.fill()).toBe('#ef4444');
    expect(el.querySelector('.ai-widget-fill').style.stroke).toBe('#ef4444');
  });

  test('R9b: смена настроек в options перекрашивает кольцо без перезагрузки страницы', () => {
    const el = makeWidgetEl();
    const ch = chromeMock([20, 28, 54]);
    const s = ringSandbox({ widgetEl: el, data: { percentage: 60.1 }, chrome: ch });
    s.api.load();
    expect(s.api.fill()).toBe('#ef4444');
    ch.fire([90, 92, 95]);                          // пользователь поднял пороги в options
    expect(s.api.fill()).toBe('#22c55e');           // 60.1 < 90 → зелёный
    ch.fire([70, 85, 95]);
    expect(s.api.fill()).toBe('#22c55e');
    ch.fire([10, 20, 30]);
    expect(s.api.fill()).toBe('#ef4444');           // 60.1 >= 30 → красный
  });

  test('R9c: без chrome и без данных загрузчик молчит (песочницы регрессии не падают)', () => {
    const s = ringSandbox({ widgetEl: null, data: null });
    expect(function () { s.api.load(); }).not.toThrow();
    expect(s.api.bounds()).toEqual([70, 95]);       // дефолт, а не ReferenceError
    expect(function () { s.api.repaint(); }).not.toThrow();
  });

  test('R9d: доступное имя — по тем же границам, что и цвет кольца', () => {
    const circle = document.createElement('div');
    const s = ringSandbox({ thresholds: [20, 28, 54] });
    s.api.label(circle, 19.9);
    expect(circle.getAttribute('aria-label')).toContain('норма');
    s.api.label(circle, 30);
    expect(circle.getAttribute('aria-label')).toContain('внимание');
    s.api.label(circle, 60.1);
    expect(circle.getAttribute('aria-label')).toContain('критично');
  });

  test('R9e: перекрас кольца не переписывает текст процента и не трогает счётчик', () => {
    const el = makeWidgetEl();
    const fill = el.querySelector('.ai-widget-fill');
    fill.style.strokeDasharray = '270.18';
    fill.style.strokeDashoffset = '100';
    const ch = chromeMock([20, 28, 54]);
    const s = ringSandbox({ widgetEl: el, data: { percentage: 60.1 }, chrome: ch });
    s.api.load();
    expect(fill.style.strokeDashoffset).toBe('100');   // геометрия кольца — не наша забота
    expect(fill.style.strokeDasharray).toBe('270.18');
    expect(el.querySelector('.ai-widget-text')).toBeNull();  // текст рисует updateWidget
  });
});

describe('v2.0.13: неприкосновенные пути (do-not-touch)', () => {
  test('обновление виджета по-прежнему зовёт zoneColor(percentage) — литерал байтово прежний', () => {
    expect(WIDGET_SRC).toContain('circle.style.stroke = zoneColor(percentage);');
  });

  test('плавная анимация кольца сохранена (transition 0.18s)', () => {
    expect(WIDGET_SRC).toContain('transition: stroke 0.18s ease, stroke-dashoffset 0.4s ease;');
  });

  test('уведомления/бейдж не тронуты: aiCmZoneColorFor и его дефолт байтово прежние', () => {
    expect(extractFn(BG_SRC, 'aiCmZoneColorFor')).toBe(
      "function aiCmZoneColorFor(t, thresholds) {\n" +
      "  var thr = (thresholds && thresholds.length === 3) ? thresholds : [70, 85, 95]; // S2: синхронный фолбэк, если storage ещё не загрузился\n" +
      "  if (t >= thr[2]) return '#ef4444';\n" +
      "  if (t >= thr[1]) return '#eab308';\n" +
      "  return '#22c55e';\n" +
      "}");
  });

  test('автоэкспорт: дефолт порогов в gemini-intercept-logic.js не менялся', () => {
    expect(GIL_SRC).toContain('var PROACTIVE_THRESHOLDS = [70, 85, 95];');
    expect(GIL_SRC).toContain('function getProactiveThresholds()');
    expect(GIL_SRC).toContain('function pickProactiveThreshold(pct, firedSet, thresholds)');
  });

  test('новых ключей storage нет: кольцо читает существующий aiCmProactiveThresholds', () => {
    expect(WIDGET_SRC).toContain("chrome.storage.local.get(['aiCmProactiveThresholds'], function (res) {");
    expect(WIDGET_SRC).not.toContain('aiCmRingThresholdsKey');
    expect(WIDGET_SRC).not.toContain('chrome.storage.local.set');
  });

  test('вход в загрузчик из createWidget — под typeof-гардом (песочницы без chrome)', () => {
    expect(WIDGET_SRC).toContain('if (typeof aiCmLoadRingThresholds === \'function\') aiCmLoadRingThresholds();');
  });
});
