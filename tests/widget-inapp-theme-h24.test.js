/**
 * H24 (live 2026-09-09): тёмный Claude (in-app тема «Тёмная») — страница чёрная, а виджет
 * остался СВЕТЛЫМ (белый круг, тёмные цифры 53.7%). Причина: фикс H22 был ограничен Gemini
 * (в aiCmInAppTheme стоял гейт `getServiceKey() !== 'gemini' → null`), а у claude.ai тёмный
 * фон живёт на body/обёртке, тогда как documentElement прозрачен → старый проб давал null →
 * фолбэк prefers-color-scheme (ОС светлая) → светлая палитра.
 *
 * H24 обобщает адаптацию палитры виджета на in-app тёмные темы ВСЕХ сервисов:
 *   — класс-токены dark-theme/light-theme остаются быстрым первым признаком и остаются
 *     гейтнутыми на Gemini (у claude.ai токенов темы в разметке нет — DOM-образца нет,
 *     адаптер Claude DOM-парсинг не ведёт → добавление токенов для claude не подтверждено);
 *   — luminance-проб computed-фона обобщён на все сервисы и пробует [body, documentElement]
 *     (body первым), непрозрачный фон, lum<100 → dark.
 * ПРАВИЛО ПАРИТЕТА H22 НЕ МЕНЯЕТСЯ: светлый фон никогда не понижает до light — светлые
 * страницы всех шести сервисов остаются байтово прежними, последний фолбэк — matchMedia.
 *
 * H23-cosmetic: 3с-фолбэк request-emit (aiCmRequestEmitTimer) не гасился в
 * resetConversationState → после SPA-смены чата уходил лишний 'ai-cm-request-emit' в новый
 * чат, а флаг aiCmContentReadySent оставался взведённым (handshake нового чата невозможен).
 *
 * Тела функций берутся из РЕАЛЬНЫХ исходников и исполняются в песочнице (конвенция H11/H22).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');

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

// ---------- песочница H23: реальные aiCmH23Site / aiCmDispatchContentReady / resetConversationState ----------
function h23Sandbox() {
  const ctx = {
    window: window,
    document: document,
    debugLog: jest.fn(),
    currentAdapter: { siteName: 'claude' },
    getCurrentConvId: () => '',
    autoExportFired: {},
    chrome: { storage: { session: { remove() { } } } },
    scheduleStaleCheck: jest.fn(),
    widgetElement: null,
    zoneColor: () => '#22c55e',
    __api: null
  };
  const src = [
    'var AI_CM_H23_SITES = ' + JSON.stringify(['claude']) + ';',
    'var aiCmContentReadySent = false;',
    'var aiCmRequestEmitTimer = null;',
    extractFn(CONTENT, 'aiCmH23Site'),
    extractFn(CONTENT, 'aiCmDispatchContentReady'),
    extractFn(CONTENT, 'resetConversationState'),
    'ctx.__api = { dispatchReady: aiCmDispatchContentReady, reset: resetConversationState,' +
    ' sent: function () { return aiCmContentReadySent; }, timer: function () { return aiCmRequestEmitTimer; } };'
  ].join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return ctx.__api;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  document.body.style.backgroundColor = '';
  document.documentElement.className = '';
  document.documentElement.style.backgroundColor = '';
  delete window.__aiCmEmitChannelSeen;
  jest.useRealTimers();
});

// =====================================================================================
// H24 (1) БАГ-СЦЕНАРИЙ: тёмный in-app Claude при светлой ОС → тёмная палитра виджета
// =====================================================================================
describe('H24: виджет следует in-app тёмной теме ЛЮБОГО сервиса (core/content.js)', () => {
  describe('а) баг-сценарий live: тёмный Claude, documentElement прозрачный', () => {
    it('claude.ai: тёмный body (html прозрачен) + prefers-color-scheme=light → dark-палитра', () => {
      const p = paletteFor('claude.ai', false, { bodyBg: 'rgb(38, 38, 36)' });
      expect(p.inApp).toBe('dark');
      expect(p.isDark).toBe(true);
      expect(p.tooltipBg).toBe('#212121'); // claude.ai → THEME_CONFIGS.chatgpt (dark)
      expect(p.text).toBe('#ececf1');
      expect(p.bgTrack).toBe('#2f2f2f');
    });

    it('claude.ai: body прозрачен, тёмный html → dark (проб обобщён на оба элемента)', () => {
      const p = paletteFor('claude.ai', false, { rootBg: 'rgb(28, 28, 26)' });
      expect(p.inApp).toBe('dark');
      expect(p.isDark).toBe(true);
      expect(p.text).toBe('#ececf1');
    });

    it('claude.ai: полупрозрачный body (rgba alpha<1) считается тёмным фоном', () => {
      document.body.style.backgroundColor = 'rgba(38, 38, 36, 0.9)';
      const api = contentSandbox('claude.ai', false);
      expect(api.aiCmInAppTheme()).toBe('dark');
    });

    it('обобщение не только на Claude: тёмные страницы deepseek/perplexity тоже дают dark', () => {
      expect(paletteFor('chat.deepseek.com', false, { bodyBg: 'rgb(24, 31, 48)' }).inApp).toBe('dark');
      expect(paletteFor('perplexity.ai', false, { bodyBg: 'rgb(20, 20, 24)' }).isDark).toBe(true);
    });
  });

  // =====================================================================================
  // H24 (2) РЕГРЕСС: светлые страницы всех шести сервисов — байтово light
  // =====================================================================================
  describe('б) регресс: светлые страницы всех шести сервисов байтово прежние', () => {
    const LIGHT = [
      { host: 'chatgpt.com', tooltipBg: '#ffffff', text: '#212121', bgTrack: '#f0f0f0' },
      { host: 'gemini.google.com', tooltipBg: '#e9eef6', text: '#1f1f1f', bgTrack: '#e9eef6' },
      { host: 'chat.deepseek.com', tooltipBg: '#ffffff', text: '#111827', bgTrack: '#e5e7eb' },
      { host: 'google.com', tooltipBg: '#ffffff', text: '#3c4043', bgTrack: '#f1f3f4' },
      { host: 'perplexity.ai', tooltipBg: '#ffffff', text: '#212121', bgTrack: '#f0f0f0' },
      { host: 'claude.ai', tooltipBg: '#ffffff', text: '#212121', bgTrack: '#f0f0f0' }
    ];

    LIGHT.forEach((c) => {
      it(c.host + ': светлый фон + OS light → inApp=null, светлая палитра как прежде', () => {
        const p = paletteFor(c.host, false, { bodyBg: 'rgb(255, 255, 255)' });
        expect(p.inApp).toBe(null);
        expect(p.isDark).toBe(false);
        expect(p.tooltipBg).toBe(c.tooltipBg);
        expect(p.text).toBe(c.text);
        expect(p.bgTrack).toBe(c.bgTrack);
      });

      it(c.host + ': светлый фон НЕ понижает до light — решает matchMedia (прежняя цепочка)', () => {
        const p = paletteFor(c.host, true, { bodyBg: 'rgb(240, 238, 230)' });
        expect(p.inApp).toBe(null); // светлый фон не сигнал light
        expect(p.isDark).toBe(true); // как до H24: matchMedia
      });
    });

    it('прозрачные html/body без токенов → inApp=null (нет ложного dark на светлой странице)', () => {
      ['chatgpt.com', 'gemini.google.com', 'chat.deepseek.com', 'google.com', 'perplexity.ai', 'claude.ai']
        .forEach((h) => expect(paletteFor(h, false, {}).inApp).toBe(null));
    });
  });

  // =====================================================================================
  // H24 (3) ТЕМНЫЙ GEMINI — БАЙТОВО ПРЕЖНИЙ (пины H22 не сломаны)
  // =====================================================================================
  describe('в) тёмный Gemini: палитра байтово прежняя (H22)', () => {
    it('body.theme-host.dark-theme + OS light → gemini.dark', () => {
      const p = paletteFor('gemini.google.com', false, { bodyClass: 'theme-host dark-theme' });
      expect(p.inApp).toBe('dark');
      expect(p.tooltipBg).toBe('#1e1f20');
      expect(p.text).toBe('#e3e3e3');
    });

    it('luminance-фолбэк Gemini: тёмный body без токенов → gemini.dark', () => {
      const p = paletteFor('gemini.google.com', false, { bodyClass: 'theme-host', bodyBg: 'rgb(32, 33, 36)' });
      expect(p.inApp).toBe('dark');
      expect(p.tooltipBg).toBe('#1e1f20');
    });

    it('in-app light Gemini важнее тёмной ОС (H22 не тронут)', () => {
      const p = paletteFor('gemini.google.com', true, { bodyClass: 'theme-host light-theme' });
      expect(p.inApp).toBe('light');
      expect(p.isDark).toBe(false);
      expect(p.tooltipBg).toBe('#e9eef6');
    });

    it('токены темы остались ГЕЙТНУТЫ на Gemini: у claude.ai/chatgpt.com они игнорируются', () => {
      // у claude.ai токенов темы в разметке не найдено (нет DOM-образца) → добавление
      // токенов для claude НЕ подтверждено: работает только luminance-проб
      expect(paletteFor('claude.ai', false, { bodyClass: 'theme-host dark-theme' }).inApp).toBe(null);
      expect(paletteFor('chatgpt.com', false, { bodyClass: 'theme-host dark-theme' }).inApp).toBe(null);
      expect(paletteFor('chatgpt.com', false, { bodyClass: 'theme-host dark-theme' }).isDark).toBe(false);
    });

    it('прежние токены dark/light и data-theme в isDarkMode не тронуты', () => {
      expect(paletteFor('claude.ai', false, { bodyClass: 'dark' }).isDark).toBe(true);
      expect(paletteFor('claude.ai', true, { bodyClass: 'light' }).isDark).toBe(false);
      expect(paletteFor('claude.ai', true, {}).isDark).toBe(true);
    });
  });

  // =====================================================================================
  // H24 (4) СТРУКТУРНЫЕ ПИНЫ: проб = [body, documentElement], токены — под гейтом Gemini
  // =====================================================================================
  describe('г) структурные пины core/content.js', () => {
    const themeSrc = extractFn(CONTENT, 'aiCmInAppTheme');

    it('проб яркости: body первым, documentElement вторым (H24)', () => {
      expect(themeSrc).toContain('const probes = [body, root];');
      expect(themeSrc.indexOf('const probes = [body, root];')).toBeGreaterThan(-1);
    });

    it('сервисный гейт остался ТОЛЬКО у класс-токенов, luminance-проб без гейта', () => {
      const iGate = themeSrc.indexOf("if (getServiceKey() === 'gemini')");
      const iProbes = themeSrc.indexOf('const probes = [body, root];');
      expect(iGate).toBeGreaterThan(-1);
      expect(iProbes).toBeGreaterThan(iGate); // проб вне гейта
      expect(themeSrc).toContain("if (/(^|\\s)dark-theme(\\s|$)/.test(cls)) return 'dark';");
      expect(themeSrc).not.toContain("if (getServiceKey() !== 'gemini') return null;");
    });

    it('правило паритета: светлый фон не возвращает light (только dark или null)', () => {
      expect(themeSrc).toContain('if ((0.2126 * (+m[1]) + 0.7152 * (+m[2]) + 0.0722 * (+m[3])) < 100) return \'dark\';');
      expect(themeSrc).not.toMatch(/return 'light';\s*\/\/[^\n]*luminance/);
      // единственный return 'light' — класс-токен Gemini, и он ВЫШЕ проба яркости
      const lightReturns = themeSrc.match(/return 'light';/g) || [];
      expect(lightReturns.length).toBe(1);
      expect(themeSrc.indexOf("return 'light';")).toBeLessThan(themeSrc.indexOf('const probes = [body, root];'));
      // в цикле проб единственный выход — 'dark'
      const loopSrc = themeSrc.slice(themeSrc.indexOf('const probes = [body, root];'));
      expect(loopSrc).toContain("return 'dark';");
      expect(loopSrc).not.toContain("return 'light';");
    });

    it('прозрачный фон по-прежнему не сигнал', () => {
      expect(themeSrc).toContain('if (m[4] !== undefined && parseFloat(m[4]) === 0) continue;');
    });
  });
});

// =====================================================================================
// H23-cosmetic: гигиена 3с-фолбэка request-emit и флага handshake при SPA-смене чата
// =====================================================================================
describe('H23-cosmetic: resetConversationState гасит фолбэк и разрешает новый handshake', () => {
  it('(1) поведение: таймер старого чата погашен, флаг обнулён, handshake нового чата работает', () => {
    jest.useFakeTimers();
    const api = h23Sandbox();
    const ready = [];
    const req = [];
    const onReady = () => ready.push(Date.now());
    const onReq = () => req.push(Date.now());
    window.addEventListener('ai-cm-content-ready', onReady);
    window.addEventListener('ai-cm-request-emit', onReq);
    try {
      api.dispatchReady(); // первый чат: handshake отправлен, 3с-фолбэк взведён
      expect(ready.length).toBe(1);
      expect(api.sent()).toBe(true);
      expect(api.timer()).not.toBeNull();

      api.reset(); // SPA-смена чата
      expect(api.sent()).toBe(false);   // новый чат = новый handshake
      expect(api.timer()).toBeNull();   // висящий таймер старого чата снят

      jest.advanceTimersByTime(5000);
      expect(req.length).toBe(0);       // лишнего 'ai-cm-request-emit' в новый чат нет

      api.dispatchReady();              // handshake нового чата снова возможен
      expect(ready.length).toBe(2);
      expect(api.timer()).not.toBeNull();
    } finally {
      window.removeEventListener('ai-cm-content-ready', onReady);
      window.removeEventListener('ai-cm-request-emit', onReq);
    }
  });

  it('(2) без reset-а 3с-фолбэк продолжает работать как прежде (контракт H23 не сломан)', () => {
    jest.useFakeTimers();
    const api = h23Sandbox();
    const req = [];
    const onReq = () => req.push(Date.now());
    window.addEventListener('ai-cm-request-emit', onReq);
    try {
      api.dispatchReady();
      expect(api.sent()).toBe(true);
      expect(api.dispatchReady()).toBeUndefined(); // повторный handshake не отправляется (флаг)
      jest.advanceTimersByTime(3000);
      expect(req.length).toBe(1); // фолбэк сработал ровно один раз
      jest.advanceTimersByTime(3000);
      expect(req.length).toBe(1); // и не повторяется
    } finally {
      window.removeEventListener('ai-cm-request-emit', onReq);
    }
  });

  it('(3) структурные пины: сброс живёт именно в resetConversationState', () => {
    const resetSrc = extractFn(CONTENT, 'resetConversationState');
    expect(resetSrc).toContain('if (aiCmRequestEmitTimer) clearTimeout(aiCmRequestEmitTimer);');
    expect(resetSrc).toContain('aiCmRequestEmitTimer = null;');
    expect(resetSrc).toContain('aiCmContentReadySent = false;');
    // гейты и события H23 не изменены
    expect(CONTENT).toContain("var AI_CM_H23_SITES = ['claude'];");
    expect(CONTENT).toContain('if (!aiCmH23Site()) return; // прочие сервисы — байтово прежнее поведение');
    expect(CONTENT).toContain('content-ready пропущен — emit уже дошёл');
    expect(CONTENT).toContain('}, 3000);');
    // фолбэк по-прежнему молчит, если ре-эмит уже дошёл
    expect(extractFn(CONTENT, 'aiCmDispatchContentReady')).toContain('if (window.__aiCmEmitChannelSeen) return;');
  });
});
