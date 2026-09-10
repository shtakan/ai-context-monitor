/**
 * H22 (live 2026-09-09): Gemini переведён в in-app тёмную тему (Настройки → Тема) — страница
 * чёрная, а виджет остался СВЕТЛЫМ (белый круг, тёмные цифры 35.0%): палитра не следовала за
 * темой сервиса. Причина: и виджет (core/content.js isDarkMode → applyNativeStyles), и оверлей
 * (core/gemini-intercept.js aiCmOverlayTheme) знали только prefers-color-scheme, а Gemini
 * выражает свою тему классом body.theme-host.dark-theme (CSS: gemini-dom-sample.html:75
 * `:where(.theme-host):where(.dark-theme)`), который `classList.contains('dark')` НЕ ловит.
 *
 * Тела функций берутся из РЕАЛЬНЫХ исходников и исполняются в песочнице `with (ctx)`
 * (конвенция H11/H12/H13 — тесты гоняют исходный код, а не копию логики).
 *
 * Пины:
 *   а) in-app dark → тёмная палитра виджета/оверлея (баг H22 закрыт);
 *   б) in-app light → светлая палитра (тема сервиса важнее темы ОС);
 *   в) светлая страница и прочие сервисы — БАЙТОВО прежняя цепочка (фолбэк не понижает до light,
 *      gate по хосту Gemini, токены dark/light/matchMedia как были);
 *   г) пересчёт палитры при смене темы: MutationObserver на class/style/data-theme + matchMedia change.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');

// ---------- извлечение РЕАЛЬНЫХ тел функций/констант из исходников ----------
function extractFn(src, name) {
  const marker = 'function ' + name + '(';
  const i = src.indexOf(marker);
  expect(i).toBeGreaterThan(-1); // функция найдена
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
  return {
    matches: !!matches,
    addEventListener() { },
    removeEventListener() { }
  };
}

function setDom(opts) {
  const o = opts || {};
  document.documentElement.className = o.htmlClass || '';
  document.documentElement.style.backgroundColor = o.rootBg || '';
  document.body.className = o.bodyClass || '';
  document.body.style.backgroundColor = o.bodyBg || '';
}

// ---------- песочница виджета: THEME_CONFIGS + getServiceKey + aiCmInAppTheme + isDarkMode + applyNativeStyles ----------
function contentSandbox(hostname, prefersDark) {
  const ctx = {
    window: {
      location: { hostname: hostname },
      matchMedia: () => makeMq(prefersDark),
      getComputedStyle: (el) => window.getComputedStyle(el)
    },
    __api: null
  };
  const src = [
    'const THEME_CONFIGS = ' + extractConstObject(CONTENT, 'THEME_CONFIGS') + ';',
    extractFn(CONTENT, 'getServiceKey'),
    extractFn(CONTENT, 'aiCmInAppTheme'),
    extractFn(CONTENT, 'isDarkMode'),
    extractFn(CONTENT, 'applyNativeStyles'),
    'ctx.__api = { getServiceKey: getServiceKey, aiCmInAppTheme: aiCmInAppTheme, isDarkMode: isDarkMode, applyNativeStyles: applyNativeStyles };'
  ].join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return ctx.__api;
}

// ---------- песочница оверлея: aiCmIsGeminiHost + aiCmOverlayTheme + apply/watch ----------
function overlaySandbox(hostname, prefersDark) {
  const ctx = {
    location: { hostname: hostname },
    window: { matchMedia: () => makeMq(prefersDark) },
    getComputedStyle: (el) => window.getComputedStyle(el),
    __api: null
  };
  const src = [
    // как в исходнике: модульное состояние наблюдателя живёт рядом с функциями
    'var aiCmOverlayThemeWatcher = null;',
    extractFn(INTERCEPT, 'aiCmIsGeminiHost'),
    extractFn(INTERCEPT, 'aiCmOverlayTheme'),
    extractFn(INTERCEPT, 'aiCmApplyOverlayTheme'),
    extractFn(INTERCEPT, 'aiCmWatchOverlayTheme'),
    'ctx.__api = { aiCmIsGeminiHost: aiCmIsGeminiHost, aiCmOverlayTheme: aiCmOverlayTheme, aiCmApplyOverlayTheme: aiCmApplyOverlayTheme, aiCmWatchOverlayTheme: aiCmWatchOverlayTheme, getWatcher: function () { return aiCmOverlayThemeWatcher; }, setOverlay: function (el) { aiCmScrollOverlay = el; } };'
  ].join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return ctx.__api;
}

function paletteFor(hostname, prefersDark, domOpts) {
  setDom(domOpts);
  const api = contentSandbox(hostname, prefersDark);
  const el = document.createElement('div');
  api.applyNativeStyles(el);
  return {
    isDark: api.isDarkMode(),
    inApp: api.aiCmInAppTheme(),
    tooltipBg: el.style.getPropertyValue('--w-tooltip-bg'),
    text: el.style.getPropertyValue('--w-text'),
    bgTrack: el.style.getPropertyValue('--w-bg-track')
  };
}

function overlayThemeFor(hostname, prefersDark, domOpts) {
  setDom(domOpts);
  return overlaySandbox(hostname, prefersDark).aiCmOverlayTheme();
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  document.body.style.backgroundColor = '';
  document.documentElement.className = '';
  document.documentElement.style.backgroundColor = '';
});

describe('H22: виджет следует in-app теме Gemini (core/content.js)', () => {
  describe('а) баг-сценарий: in-app тёмная тема Gemini → тёмная палитра', () => {
    it('body.theme-host.dark-theme при prefers-color-scheme=light → isDark=true, палитра gemini.dark', () => {
      const p = paletteFor('gemini.google.com', false, { bodyClass: 'theme-host dark-theme' });
      expect(p.inApp).toBe('dark');
      expect(p.isDark).toBe(true);
      expect(p.tooltipBg).toBe('#1e1f20');
      expect(p.text).toBe('#e3e3e3');
    });

    it('фолбэк по computed-яркости: чёрный body без токенов → тёмная палитра', () => {
      const p = paletteFor('gemini.google.com', false, { bodyClass: 'theme-host', bodyBg: 'rgb(32, 33, 36)' });
      expect(p.inApp).toBe('dark');
      expect(p.isDark).toBe(true);
      expect(p.tooltipBg).toBe('#1e1f20');
    });

    it('фолбэк по computed-яркости: прозрачный body + тёмный html → тёмная палитра', () => {
      const p = paletteFor('gemini.google.com', false, { bodyClass: 'theme-host', rootBg: 'rgb(20, 20, 20)' });
      expect(p.isDark).toBe(true);
      expect(p.text).toBe('#e3e3e3');
    });

    it('тема на элементе-хосте (.theme-host.dark-theme), а не на body → тёмная палитра', () => {
      setDom({ bodyClass: '' });
      document.body.innerHTML = '<div class="theme-host dark-theme"></div>';
      const api = contentSandbox('gemini.google.com', false);
      expect(api.aiCmInAppTheme()).toBe('dark');
      expect(api.isDarkMode()).toBe(true);
    });
  });

  describe('б) in-app светлая тема важнее темы ОС', () => {
    it('body.theme-host.light-theme при prefers-color-scheme=dark → светлая палитра', () => {
      const p = paletteFor('gemini.google.com', true, { bodyClass: 'theme-host light-theme' });
      expect(p.inApp).toBe('light');
      expect(p.isDark).toBe(false);
      expect(p.tooltipBg).toBe('#e9eef6');
      expect(p.text).toBe('#1f1f1f');
    });
  });

  describe('в) светлая страница и прочие сервисы — байтово прежнее', () => {
    it('светлая страница Gemini (без токенов, светлый фон) + OS light → светлая палитра как прежде', () => {
      const p = paletteFor('gemini.google.com', false, { bodyClass: 'theme-host', bodyBg: 'rgb(255, 255, 255)' });
      expect(p.inApp).toBe(null);
      expect(p.isDark).toBe(false);
      expect(p.tooltipBg).toBe('#e9eef6');
      expect(p.text).toBe('#1f1f1f');
    });

    it('светлый фон НЕ понижает до light: без токенов решает matchMedia (прежняя цепочка)', () => {
      const p = paletteFor('gemini.google.com', true, { bodyClass: 'theme-host', bodyBg: 'rgb(255, 255, 255)' });
      expect(p.inApp).toBe(null);
      expect(p.isDark).toBe(true); // как до H22
    });

    it('прочие сервисы: dark-theme на chatgpt.com игнорируется (gate по сервису)', () => {
      const p = paletteFor('chatgpt.com', false, { bodyClass: 'theme-host dark-theme' });
      expect(p.inApp).toBe(null);
      expect(p.isDark).toBe(false);
      expect(p.tooltipBg).toBe('#ffffff');
    });

    it('прежние токены dark/light не сломаны (chatgpt.com)', () => {
      expect(paletteFor('chatgpt.com', false, { bodyClass: 'dark' }).isDark).toBe(true);
      expect(paletteFor('chatgpt.com', true, { bodyClass: 'light' }).isDark).toBe(false);
      expect(paletteFor('chatgpt.com', true, {}).isDark).toBe(true); // matchMedia как прежде
    });
  });

  describe('г) пересчёт при смене темы (структурные пины core/content.js)', () => {
    it('наблюдатель атрибутов html/body остаётся, добавлен matchMedia change', () => {
      expect(CONTENT).toContain("themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });");
      expect(CONTENT).toContain("themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });");
      expect(CONTENT).toContain("if (mqlTheme && mqlTheme.addEventListener) mqlTheme.addEventListener('change', () => applyNativeStyles(container));");
    });

    it('элемент-хост .theme-host тоже под наблюдением (если тема живёт не на body)', () => {
      expect(CONTENT).toContain("const themeHostEl = document.querySelector('.theme-host');");
      expect(CONTENT).toContain("themeObserver.observe(themeHostEl, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });");
    });
  });
});

describe('H22: оверлей следует in-app теме Gemini (core/gemini-intercept.js)', () => {
  describe('а) баг-сценарий: in-app тёмная тема Gemini → тёмный оверлей', () => {
    it('body.theme-host.dark-theme при prefers-color-scheme=light → theme=dark', () => {
      const th = overlayThemeFor('gemini.google.com', false, { bodyClass: 'theme-host dark-theme' });
      expect(th.name).toBe('dark');
      expect(th.bg).toBe('#1e1f20');
      expect(th.fg).toBe('#e3e3e3');
    });

    it('фолбэк по computed-яркости: тёмный body без токенов → theme=dark', () => {
      const th = overlayThemeFor('gemini.google.com', false, { bodyClass: 'theme-host', bodyBg: 'rgb(27, 28, 29)' });
      expect(th.name).toBe('dark');
    });

    it('тема на элементе-хосте (.theme-host.dark-theme) → theme=dark', () => {
      setDom({ bodyClass: '' });
      document.body.innerHTML = '<div class="theme-host dark-theme"></div>';
      const th = overlaySandbox('gemini.google.com', false).aiCmOverlayTheme();
      expect(th.name).toBe('dark');
      expect(th.bg).toBe('#1e1f20');
    });
  });

  describe('б) in-app светлая тема важнее темы ОС', () => {
    it('body.theme-host.light-theme при prefers-color-scheme=dark → theme=light', () => {
      const th = overlayThemeFor('gemini.google.com', true, { bodyClass: 'theme-host light-theme' });
      expect(th.name).toBe('light');
      expect(th.bg).toBe('#f0f4f9');
      expect(th.fg).toBe('#1f1f1f');
    });
  });

  describe('в) светлая страница и не-Gemini хосты — байтово прежнее', () => {
    it('прозрачный фон без токенов + OS light → theme=light (прежняя цепочка matchMedia)', () => {
      const th = overlayThemeFor('gemini.google.com', false, { bodyClass: 'theme-host' });
      expect(th.name).toBe('light');
    });

    it('светлый фон без токенов + OS dark → theme=dark (фолбэк не понижает до light)', () => {
      const th = overlayThemeFor('gemini.google.com', true, { bodyClass: 'theme-host', bodyBg: 'rgb(255, 255, 255)' });
      expect(th.name).toBe('dark');
    });

    it('не-Gemini хост (aistudio): in-app токены и тёмный body игнорируются', () => {
      const th = overlayThemeFor('aistudio.google.com', false, {
        bodyClass: 'theme-host dark-theme',
        bodyBg: 'rgb(20, 20, 20)'
      });
      expect(th.name).toBe('light'); // прежняя логика: body не пробуется → matchMedia
    });

    it('не-Gemini хост (aistudio): прежний пробник html-фона сохранён байтово', () => {
      const th = overlayThemeFor('aistudio.google.com', false, { rootBg: 'rgb(20, 20, 20)' });
      expect(th.name).toBe('dark'); // как до H22: тёмный html → dark
    });
  });

  describe('г) живой пересчёт палитры поднятого оверлея', () => {
    it('смена body.class перекрашивает оверлей, снятие наблюдателя останавливает пересчёт', async () => {
      setDom({ bodyClass: 'theme-host' });
      const api = overlaySandbox('gemini.google.com', false);
      const ov = document.createElement('div');
      ov.className = 'ai-cm-loader-overlay';
      ov.innerHTML = '<div class="ai-cm-loader-spinner"></div><div class="ai-cm-loader-label"></div>';
      document.body.appendChild(ov);
      api.setOverlay(ov);
      api.aiCmWatchOverlayTheme(true);
      expect(api.getWatcher()).not.toBeNull();

      document.body.className = 'theme-host dark-theme';
      await new Promise((r) => setTimeout(r, 0));
      expect(ov.style.background).toBe('rgb(30, 31, 32)');
      expect(ov.querySelector('.ai-cm-loader-label').style.color).toBe('rgb(227, 227, 227)');

      api.aiCmWatchOverlayTheme(false);
      expect(api.getWatcher()).toBeNull();
      document.body.className = 'theme-host light-theme';
      await new Promise((r) => setTimeout(r, 0));
      expect(ov.style.background).toBe('rgb(30, 31, 32)'); // наблюдатель снят — пересчёта нет
      api.setOverlay(null);
    });

    it('смена темы на элементе-хосте .theme-host тоже перекрашивает оверлей', async () => {
      setDom({ bodyClass: '' });
      document.body.innerHTML = '<div class="theme-host"></div>';
      const hostEl = document.body.querySelector('.theme-host');
      const api = overlaySandbox('gemini.google.com', false);
      const ov = document.createElement('div');
      ov.className = 'ai-cm-loader-overlay';
      ov.innerHTML = '<div class="ai-cm-loader-label"></div>';
      document.body.appendChild(ov);
      api.setOverlay(ov);
      api.aiCmWatchOverlayTheme(true);

      hostEl.className = 'theme-host dark-theme';
      await new Promise((r) => setTimeout(r, 0));
      expect(ov.style.background).toBe('rgb(30, 31, 32)');

      api.aiCmWatchOverlayTheme(false);
      api.setOverlay(null);
    });

    it('наблюдатель поднимается/снимается только вместе с оверлеем (пины вызовов)', () => {
      expect(INTERCEPT).toContain('var aiCmOverlayThemeWatcher = null;');
      expect(INTERCEPT).toContain('aiCmWatchOverlayTheme(true); // H22');
      expect(INTERCEPT).toContain('aiCmWatchOverlayTheme(false); // H22');
      // лог overlay-on остался байтово прежним
      expect(INTERCEPT).toContain("debugLog('log', '[AI CM][visibility] overlay-on reason=' + reason + ' theme=' + th.name + ' convId=' + (getConvId() || '(none)'));");
      expect(INTERCEPT).toContain("debugLog('log', '[AI CM][visibility] overlay-off reason=' + reason + ' convId=' + (getConvId() || '(none)'));");
    });
  });
});
