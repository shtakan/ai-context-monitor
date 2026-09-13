/**
 * H25 (live 2026-09-09, Claude): живой переключатель темы сервиса НЕ перекрашивал виджет до F5.
 * Диагностика тёмной темы Claude без F5: body=rgb(21,21,21) (проб яркости его ловит), html прозрачен,
 * htmlCls="cds-root h-screen antialiased scroll-smooth",
 * bodyCls="bg-surface-1 text-primary font-sans min-h-screen chat-ui-core" — тема приходит ТОЛЬКО
 * сменой CSS-переменных, атрибуты html/body при переключении темы НЕ мутируют → themeObserver H22
 * (class/style/data-theme) молчит, matchMedia (тема ОС не менялась) молчит → палитра читалась лишь
 * при инициализации виджета, перекрас только после reload.
 *
 * Детект (aiCmInAppTheme, проб [body, root]) корректен — H25 чинит ТРИГГЕР:
 *   — aiCmRefreshThemeIfNeeded(): isDarkMode() ≠ последняя применённая палитра → applyNativeStyles;
 *   — вызовы: каждая отрисовка updateWidget + интервал 5000мс (виджет создан и не скрыт);
 *   — гард тихого пути: при неизменной теме НИ ОДНОЙ style-записи (applyNativeStyles не вызван);
 *   — быстрый путь H22 (themeObserver + matchMedia) остаётся байтово прежним.
 *
 * Тела функций берутся из РЕАЛЬНЫХ исходников и исполняются в песочнице (конвенция H11/H22/H24).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = require('./helpers/content-source.js').contentSource;

// ---------- извлечение РЕАЛЬНЫХ тел функций/констант из исходника ----------
function extractFn(src, name) {
  const marker = 'function ' + name + '(';
  const i = src.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
  let depth = 0;
  const start = i;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, k + 1);
    }
  }
  throw new Error('unbalanced function body: ' + name);
}

function extractConstObject(src, name) {
  const marker = 'const ' + name + ' = ';
  const i = src.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
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

function makeMq(matches) {
  return { matches: !!matches, addEventListener() { }, removeEventListener() { } };
}

function setDom(opts) {
  const o = opts || {};
  document.documentElement.className = o.htmlClass || '';
  document.documentElement.style.backgroundColor = o.rootBg || '';
  document.body.className = o.bodyClass || '';
  document.body.style.backgroundColor = o.bodyBg || '';
}

// ---------- песочница виджета: THEME_CONFIGS + детект темы + H25-триггер ----------
// Порядок объявлений повторяет исходник: состояние (let) → applyNativeStyles → H25-функции.
function themeSrcLines() {
  return [
    'const THEME_CONFIGS = ' + extractConstObject(CONTENT, 'THEME_CONFIGS') + ';',
    extractFn(CONTENT, 'getServiceKey'),
    extractFn(CONTENT, 'aiCmInAppTheme'),
    extractFn(CONTENT, 'isDarkMode'),
    'let aiCmWidgetAppliedTheme = null;',
    'let aiCmThemePollTimer = null;',
    'const AI_CM_THEME_POLL_MS = 5000;',
    extractFn(CONTENT, 'applyNativeStyles'),
    extractFn(CONTENT, 'aiCmRefreshThemeIfNeeded'),
    extractFn(CONTENT, 'aiCmStartThemePoll'),
    extractFn(CONTENT, 'aiCmStopThemePoll')
  ];
}

const THEME_API = 'ctx.__api = { getServiceKey: getServiceKey, aiCmInAppTheme: aiCmInAppTheme,' +
  ' isDarkMode: isDarkMode, applyNativeStyles: applyNativeStyles, refresh: aiCmRefreshThemeIfNeeded,' +
  ' startPoll: aiCmStartThemePoll, stopPoll: aiCmStopThemePoll,' +
  ' applied: function () { return aiCmWidgetAppliedTheme; },' +
  ' timer: function () { return aiCmThemePollTimer; } };';

function themeSandbox(hostname, prefersDark) {
  const ctx = {
    window: {
      location: { hostname: hostname },
      matchMedia: () => makeMq(prefersDark),
      getComputedStyle: (el) => window.getComputedStyle(el)
    },
    debugLog: jest.fn(),
    widgetElement: null,
    __api: null
  };
  const src = themeSrcLines().concat([THEME_API]).join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return ctx;
}

// ---------- песочница отрисовки: H25-вызов внутри updateWidget ----------
// ВАЖНО: одна область видимости — updateWidget должен видеть aiCmRefreshThemeIfNeeded.
function updateWidgetSandbox(hostname, prefersDark) {
  const ctx = {
    window: {
      location: { hostname: hostname },
      matchMedia: () => makeMq(prefersDark),
      getComputedStyle: (el) => window.getComputedStyle(el)
    },
    debugLog: jest.fn(),
    widgetElement: null,
    stale: false,
    zoneColor: (p) => (p < 50 ? '#22c55e' : (p < 80 ? '#eab308' : '#ef4444')),
    aiCmActivePct: () => null,
    __api: null
  };
  const src = themeSrcLines().concat([
    extractFn(CONTENT, 'updateWidget'),
    THEME_API,
    'ctx.__api.updateWidget = updateWidget;'
  ]).join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return ctx;
}

function makeWidgetEl() {
  const el = document.createElement('div');
  el.id = 'ai-context-widget';
  el.innerHTML =
    '<div class="ai-widget-circle"><svg><circle class="ai-widget-bg"></circle>' +
    '<circle class="ai-widget-fill"></circle></svg><span class="ai-widget-text">—</span>' +
    '<div class="ai-widget-tooltip"></div></div><div class="ai-widget-panel"></div>';
  document.body.appendChild(el);
  return el;
}

function paletteOf(el) {
  return {
    tooltipBg: el.style.getPropertyValue('--w-tooltip-bg'),
    text: el.style.getPropertyValue('--w-text'),
    bgTrack: el.style.getPropertyValue('--w-bg-track')
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  document.body.style.backgroundColor = '';
  document.documentElement.className = '';
  document.documentElement.style.backgroundColor = '';
  jest.useRealTimers();
});

// =====================================================================================
// H25 (1) БАГ-СЦЕНАРИЙ live: Claude, живой переключатель темы, атрибуты НЕ мутируют
// =====================================================================================
describe('H25: живой перекрас палитры виджета при смене in-app темы без reload (core/content.js)', () => {
  describe('а) Claude live: тёмная тема без мутации атрибутов → перекрас ≤5с', () => {
    const HTML_CLS = 'cds-root h-screen antialiased scroll-smooth';
    const BODY_CLS = 'bg-surface-1 text-primary font-sans min-h-screen chat-ui-core';

    it('тёмный body (только CSS-переменные, классы те же) → интервал 5с перекрашивает виджет', () => {
      jest.useFakeTimers();
      setDom({ htmlClass: HTML_CLS, bodyClass: BODY_CLS, bodyBg: 'rgb(255, 255, 255)' });
      const ctx = themeSandbox('claude.ai', false);
      const el = makeWidgetEl();
      ctx.widgetElement = el;
      ctx.__api.applyNativeStyles(el);
      expect(paletteOf(el).tooltipBg).toBe('#ffffff'); // светлая палитра при инициализации
      expect(ctx.__api.applied()).toBe(false);

      const setProp = jest.spyOn(el.style, 'setProperty');
      const cssBefore = el.getAttribute('style');
      ctx.__api.startPoll();

      // 3 тика неизменной темы — НИ ОДНОЙ style-записи (байтово тихий путь)
      jest.advanceTimersByTime(15000);
      expect(setProp).not.toHaveBeenCalled();
      expect(el.getAttribute('style')).toBe(cssBefore);

      // live-переключение темы Claude: атрибуты html/body НЕ меняются, меняется только фон
      document.body.style.backgroundColor = 'rgb(21, 21, 21)';
      expect(document.documentElement.className).toBe(HTML_CLS);
      expect(document.body.className).toBe(BODY_CLS);
      expect(ctx.__api.aiCmInAppTheme()).toBe('dark'); // проб [body, root] ловит без атрибутов

      jest.advanceTimersByTime(5000); // ≤5с без F5
      expect(setProp).toHaveBeenCalledTimes(8); // ровно один полный перекрас
      expect(ctx.__api.applied()).toBe(true);
      expect(paletteOf(el)).toEqual({ tooltipBg: '#212121', text: '#ececf1', bgTrack: '#2f2f2f' });

      // далее тема стабильна — снова ни одной записи
      const cssDark = el.getAttribute('style');
      jest.advanceTimersByTime(15000);
      expect(setProp).toHaveBeenCalledTimes(8);
      expect(el.getAttribute('style')).toBe(cssDark);
    });

    it('обратно в светлую → светлеет ≤5с (двусторонняя смена)', () => {
      jest.useFakeTimers();
      setDom({ htmlClass: HTML_CLS, bodyClass: BODY_CLS, bodyBg: 'rgb(21, 21, 21)' });
      const ctx = themeSandbox('claude.ai', false);
      const el = makeWidgetEl();
      ctx.widgetElement = el;
      ctx.__api.applyNativeStyles(el);
      expect(paletteOf(el).tooltipBg).toBe('#212121'); // тёмная тема на загрузке (пин H24)
      const setProp = jest.spyOn(el.style, 'setProperty');
      ctx.__api.startPoll();

      document.body.style.backgroundColor = 'rgb(255, 255, 255)'; // светлая тема Claude
      jest.advanceTimersByTime(5000);
      expect(setProp).toHaveBeenCalledTimes(8);
      expect(paletteOf(el)).toEqual({ tooltipBg: '#ffffff', text: '#212121', bgTrack: '#f0f0f0' });
    });

    it('виджет снят со страницы → таймер гасится сам (нет висящего интервала)', () => {
      jest.useFakeTimers();
      setDom({ bodyClass: BODY_CLS, bodyBg: 'rgb(255, 255, 255)' });
      const ctx = themeSandbox('claude.ai', false);
      const el = makeWidgetEl();
      ctx.widgetElement = el;
      ctx.__api.applyNativeStyles(el);
      ctx.__api.startPoll();
      expect(ctx.__api.timer()).not.toBeNull();

      el.remove();
      jest.advanceTimersByTime(5000);
      expect(ctx.__api.timer()).toBeNull(); // интервал очищен (удаление виджета)
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  // =====================================================================================
  // H25 (2) РЕГРЕСС: светлые страницы всех шести сервисов — ноль перекрасов
  // =====================================================================================
  describe('б) регресс: светлые страницы — ноль перекрасов за 10 тиков', () => {
    const HOSTS = [
      'chatgpt.com', 'gemini.google.com', 'chat.deepseek.com',
      'google.com', 'perplexity.ai', 'claude.ai'
    ];

    HOSTS.forEach((host) => {
      it(host + ': светлый фон + OS light → applyNativeStyles не вызван за 10 тиков', () => {
        jest.useFakeTimers();
        setDom({ bodyClass: 'theme-host', bodyBg: 'rgb(255, 255, 255)' });
        const ctx = themeSandbox(host, false);
        const el = makeWidgetEl();
        ctx.widgetElement = el;
        ctx.__api.applyNativeStyles(el);
        const cssBefore = el.getAttribute('style');
        const setProp = jest.spyOn(el.style, 'setProperty');
        ctx.__api.startPoll();

        jest.advanceTimersByTime(50000); // 10 тиков
        expect(setProp).not.toHaveBeenCalled();
        expect(el.getAttribute('style')).toBe(cssBefore);
        expect(ctx.__api.applied()).toBe(false);
      });

      it(host + ': светлый фон + OS dark → палитра прежняя (matchMedia), перекрасов ноль', () => {
        jest.useFakeTimers();
        setDom({ bodyClass: 'theme-host', bodyBg: 'rgb(240, 238, 230)' });
        const ctx = themeSandbox(host, true);
        const el = makeWidgetEl();
        ctx.widgetElement = el;
        ctx.__api.applyNativeStyles(el);
        expect(ctx.__api.applied()).toBe(true); // как до H25: решает matchMedia
        const setProp = jest.spyOn(el.style, 'setProperty');
        ctx.__api.startPoll();
        jest.advanceTimersByTime(50000);
        expect(setProp).not.toHaveBeenCalled();
      });
    });

    it('refresh() без виджета и без смены темы не пишет ничего', () => {
      setDom({ bodyBg: 'rgb(255, 255, 255)' });
      const ctx = themeSandbox('claude.ai', false);
      ctx.widgetElement = null;
      expect(ctx.__api.refresh()).toBe(false);
    });
  });

  // =====================================================================================
  // H25 (3) ТЁМНЫЙ GEMINI: мгновенный путь H22 не сломан
  // =====================================================================================
  describe('в) тёмный Gemini — быстрый путь по токену байтово прежний', () => {
    it('токен .dark-theme меняет isDarkMode() мгновенно (без ожидания тика)', () => {
      setDom({ bodyClass: 'theme-host', bodyBg: 'rgb(255, 255, 255)' });
      const ctx = themeSandbox('gemini.google.com', false);
      const el = makeWidgetEl();
      ctx.widgetElement = el;
      ctx.__api.applyNativeStyles(el);
      expect(paletteOf(el).tooltipBg).toBe('#e9eef6');

      document.body.className = 'theme-host dark-theme';
      expect(ctx.__api.isDarkMode()).toBe(true); // мгновенно, как в H22
      expect(ctx.__api.refresh()).toBe(true);    // тот же перекрас, что делал themeObserver
      expect(paletteOf(el).tooltipBg).toBe('#1e1f20');
      expect(paletteOf(el).text).toBe('#e3e3e3');
    });

    it('структурные пины H22: наблюдатель атрибутов и matchMedia не тронуты', () => {
      expect(CONTENT).toContain("const themeObserver = new MutationObserver(() => applyNativeStyles(container));");
      expect(CONTENT).toContain("themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });");
      expect(CONTENT).toContain("themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });");
      expect(CONTENT).toContain("const themeHostEl = document.querySelector('.theme-host');");
      expect(CONTENT).toContain("themeObserver.observe(themeHostEl, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });");
      expect(CONTENT).toContain("if (mqlTheme && mqlTheme.addEventListener) mqlTheme.addEventListener('change', () => applyNativeStyles(container));");
    });

    it('THEME_CONFIGS-значения не тронуты (байтовый паритет H22/H24)', () => {
      const cfg = extractConstObject(CONTENT, 'THEME_CONFIGS');
      expect(cfg).toContain("dark: { bgTrack: '#37393b', bgFill: 'url(#gemini-gradient)', text: '#e3e3e3', tooltipBg: '#1e1f20'");
      expect(cfg).toContain("light: { bgTrack: '#e9eef6', bgFill: 'url(#gemini-gradient)', text: '#1f1f1f', tooltipBg: '#e9eef6'");
      expect(cfg).toContain("dark: { bgTrack: '#2f2f2f', bgFill: '#19c37d', text: '#ececf1', tooltipBg: '#212121'");
    });
  });

  // =====================================================================================
  // H25 (4) H24-ПИНЫ: тёмный Claude на загрузке + детект не тронут
  // =====================================================================================
  describe('г) H24-пины зелёные: тёмный claude на загрузке, детект не тронут', () => {
    it('тёмный body Claude (html прозрачен) → тёмная палитра при инициализации', () => {
      setDom({ bodyClass: 'bg-surface-1 text-primary font-sans min-h-screen chat-ui-core', bodyBg: 'rgb(21, 21, 21)' });
      const ctx = themeSandbox('claude.ai', false);
      const el = makeWidgetEl();
      ctx.widgetElement = el;
      ctx.__api.applyNativeStyles(el);
      expect(ctx.__api.aiCmInAppTheme()).toBe('dark');
      expect(ctx.__api.isDarkMode()).toBe(true);
      expect(paletteOf(el)).toEqual({ tooltipBg: '#212121', text: '#ececf1', bgTrack: '#2f2f2f' });
      expect(ctx.__api.applied()).toBe(true); // H25: палитра зафиксирована как применённая
    });

    it('проб [body, root] и правило паритета H24 не тронуты', () => {
      const themeSrc = extractFn(CONTENT, 'aiCmInAppTheme');
      expect(themeSrc).toContain('const probes = [body, root];');
      expect(themeSrc).toContain('if (m[4] !== undefined && parseFloat(m[4]) === 0) continue;');
      expect(themeSrc).toContain("if ((0.2126 * (+m[1]) + 0.7152 * (+m[2]) + 0.0722 * (+m[3])) < 100) return 'dark';");
      expect(themeSrc).not.toContain("if (getServiceKey() !== 'gemini') return null;");
    });

    it('гард тихого пути: смена НЕтемы (например, чат) перекраса не вызывает', () => {
      setDom({ bodyBg: 'rgb(255, 255, 255)' });
      const ctx = themeSandbox('claude.ai', false);
      const el = makeWidgetEl();
      ctx.widgetElement = el;
      ctx.__api.applyNativeStyles(el);
      const setProp = jest.spyOn(el.style, 'setProperty');
      // SPA-смена чата/прочие мутации DOM тему не меняют
      for (let i = 0; i < 5; i++) expect(ctx.__api.refresh()).toBe(false);
      expect(setProp).not.toHaveBeenCalled();
    });
  });

  // =====================================================================================
  // H25 (5) ТРИГГЕР В ОТРИСОВКЕ: updateWidget тоже перекрашивает
  // =====================================================================================
  describe('д) updateWidget: каждая отрисовка проверяет тему', () => {
    it('смена темы применяется на ближайшей отрисовке (до тика интервала)', () => {
      setDom({ bodyBg: 'rgb(255, 255, 255)' });
      const ctx = updateWidgetSandbox('claude.ai', false);
      const el = makeWidgetEl();
      ctx.widgetElement = el;
      ctx.__api.applyNativeStyles(el);
      expect(paletteOf(el).tooltipBg).toBe('#ffffff');

      document.body.style.backgroundColor = 'rgb(21, 21, 21)';
      ctx.__api.updateWidget(53.7, 107000, 200000, 200000, 200000, 'Claude', null);

      expect(paletteOf(el).tooltipBg).toBe('#212121');
      expect(paletteOf(el).text).toBe('#ececf1');
      expect(el.querySelector('.ai-widget-text').textContent).toBe('53.7%');
      // зональный цвет заливки (inline) перекрасом палитры не затёрт
      expect(el.querySelector('.ai-widget-fill').style.stroke).toBe('#eab308');
    });

    it('неизменная тема: отрисовка не пишет ни одной style-записи палитры', () => {
      setDom({ bodyBg: 'rgb(255, 255, 255)' });
      const ctx = updateWidgetSandbox('claude.ai', false);
      const el = makeWidgetEl();
      ctx.widgetElement = el;
      ctx.__api.applyNativeStyles(el);
      const setProp = jest.spyOn(el.style, 'setProperty');
      for (let i = 0; i < 3; i++) ctx.__api.updateWidget(10 + i, 1000, 200000, 200000, 200000, 'Claude', null);
      expect(setProp).not.toHaveBeenCalled();
    });
  });

  // =====================================================================================
  // H25 (6) СТРУКТУРНЫЕ ПИНЫ: вызовы, интервал, гард
  // =====================================================================================
  describe('е) структурные пины core/content.js', () => {
    const refreshSrc = extractFn(CONTENT, 'aiCmRefreshThemeIfNeeded');
    const pollSrc = extractFn(CONTENT, 'aiCmStartThemePoll');
    const updateSrc = extractFn(CONTENT, 'updateWidget');
    const applySrc = extractFn(CONTENT, 'applyNativeStyles');

    it('(а) updateWidget: проверка темы на каждой отрисовке', () => {
      expect(updateSrc).toContain('aiCmRefreshThemeIfNeeded();');
      expect(updateSrc.indexOf('aiCmRefreshThemeIfNeeded();'))
        .toBeLessThan(updateSrc.indexOf('circle.style.stroke = zoneColor(percentage);'));
    });

    it('(б) интервал 5000мс поднимается в createWidget и гасится на скрытии виджета', () => {
      expect(CONTENT).toContain('const AI_CM_THEME_POLL_MS = 5000;');
      expect(pollSrc).toContain('aiCmThemePollTimer = setInterval(function () {');
      expect(pollSrc).toContain('}, AI_CM_THEME_POLL_MS);');
      expect(CONTENT).toContain('aiCmStartThemePoll(); // H25: медленный дубль-страховка');
      expect(CONTENT).toContain('aiCmStopThemePoll(); // H25: виджета нет — опрос темы больше не нужен');
      expect(extractFn(CONTENT, 'aiCmStopThemePoll')).toContain('clearInterval(aiCmThemePollTimer)');
      // createWidget поднимает опрос ПОСЛЕ первичной палитры
      const createSrc = extractFn(CONTENT, 'createWidget');
      expect(createSrc.indexOf('applyNativeStyles(container);'))
        .toBeLessThan(createSrc.indexOf('aiCmStartThemePoll();'));
    });

    it('(в) гард тихого пути: сравнение с применённой темой ДО applyNativeStyles', () => {
      expect(refreshSrc).toContain('const nowDark = isDarkMode();');
      expect(refreshSrc).toContain('if (aiCmWidgetAppliedTheme === nowDark) return false;');
      expect(refreshSrc.indexOf('if (aiCmWidgetAppliedTheme === nowDark) return false;'))
        .toBeLessThan(refreshSrc.indexOf('applyNativeStyles(el);'));
      // единственный источник правды о применённой палитре — applyNativeStyles
      expect(applySrc).toContain('aiCmWidgetAppliedTheme = isDark;');
      // в refresh-е только ЧТЕНИЕ состояния (сравнение), никаких записей
      expect(refreshSrc).not.toMatch(/aiCmWidgetAppliedTheme\s*=(?!=)/);
    });

    it('(г) состояние H25 объявлено рядом с палитрой, детект не изменён', () => {
      expect(CONTENT).toContain('let aiCmWidgetAppliedTheme = null;');
      expect(CONTENT).toContain('let aiCmThemePollTimer = null;');
      // H19/H20/H23 и автоэкспорт-гейты не тронуты
      expect(CONTENT).toContain("var AI_CM_H23_SITES = ['claude'];");
      expect(CONTENT).toContain("themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });");
    });
  });
});
