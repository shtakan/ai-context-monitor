/**
 * Fix-getServiceKey-claude (вариант A′, 2 строки): getServiceKey() не знал claude.ai и падал
 * в `return 'chatgpt'` ⇒ safePctKey() давал 'ai_cm_safe_pct_chatgpt' ⇒ per-service порог
 * виджета Claude читался/писался по ЧУЖОМУ ключу ChatGPT (порог и displayLimit Claude
 * считались из ключа ChatGPT).
 *   Источник дефекта: PROJECT_HANDOFF.md, Секция 4 п.1 (core/widget.js:360-367);
 *   живой лог 18:10:14: 'gsa-metric-src site=chatgpt' в одном прогоне с site=claude.
 *
 * Правка A′ (ровно 2 строки, замена 1-в-1, номера строк не сдвигаются):
 *   (1) core/widget.js:366  `return 'chatgpt';`
 *         → `return host.includes('claude.ai') ? 'claude' : 'chatgpt';`
 *   (2) core/widget.js:435  `const config = THEME_CONFIGS[serviceKey];`
 *         → `const config = THEME_CONFIGS[serviceKey] || THEME_CONFIGS.chatgpt;`
 *   Гард (2) обязателен: в THEME_CONFIGS нет ключа 'claude' (core/widget.js:338-359),
 *   без него `config.dark` на claude.ai дал бы TypeError. Значения THEME_CONFIGS не менялись.
 *
 * Конвенция H11/H22/H24: тела функций/константы берутся из РЕАЛЬНЫХ исходников
 * (tests/helpers/content-source.js) и исполняются в песочнице; существующие тесты не правятся.
 *
 * Пины (у каждого — ссылка на источник требования):
 *   P1 формат ключа: claude.ai → 'claude'; safePctKey() === 'ai_cm_safe_pct_claude' ≠ chatgpt
 *   P2 путь записи: симулированный setSafePctFromInput('50') на claude.ai → sync.set(claude-ключ: 50)
 *   P3 путь чтения: sync-стаб { ai_cm_safe_pct_claude: 40 } → safePct 40 → displayLimit 200000
 *   P4 инвариант изоляции: запись claude не трогает chatgpt-ключ; чужой onChanged не трогает safePct
 *   P5 non-regression палитры: claude.ai даёт палитру THEME_CONFIGS.chatgpt байтово
 *   P6 гард отсутствующего ключа: host вне THEME_CONFIGS → палитра chatgpt, без TypeError
 *   P7 диагностика: 'gsa-metric-src' site питается getServiceKey() → claude.ai = 'claude'
 */
const CONTENT = require('./helpers/content-source.js').contentSource;
const WIDGET = require('./helpers/content-source.js').moduleSource('core/widget.js');
const ModelConfig = require('../utils/model-config.js');

// Хелпер swallowSoft из utils/debug.js в eval-песочнице отсутствует (как в tests/widget-inapp-theme-h24.test.js:33).
global.swallowSoft = function () { };

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

// =====================================================================================
// Песочница 1: порог/ключ — safePctKey + getServiceKey + запись/чтение (% виджета)
// =====================================================================================
function chromeStub(initial, listeners) {
  const state = Object.assign({}, initial || {});
  const writes = [];
  const storage = {
    sync: {
      get(keys, cb) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { out[k] = state[k]; });
        if (typeof cb === 'function') cb(out);
      },
      set(obj) { writes.push(obj); Object.assign(state, obj); }
    },
    local: {
      get(keys, cb) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in state) out[k] = state[k]; });
        if (typeof cb === 'function') cb(out);
      },
      set(obj) { writes.push(obj); Object.assign(state, obj); }
    },
    onChanged: {
      addListener(fn) { listeners.push(fn); },
      removeListener() { }
    }
  };
  return { state, writes, chrome: { storage } };
}

function pctSandbox(hostname, initialSync) {
  const listeners = [];
  const store = chromeStub(initialSync, listeners);
  const ctx = {
    window: { location: { hostname: hostname } },
    chrome: store.chrome,
    ModelConfig: ModelConfig,
    isExtensionValid: () => true,
    updatePanel: () => { },
    processAndSend: () => { },
    debugLog: () => { },
    aiCmDiagLine: () => { },
    __api: null
  };
  const src = [
    'var safePct = null;',
    'var popupLimitPct = null;',
    'var aiCmRingThresholds = null;',
    'var widgetElement = null;',
    'var lastWidgetData = null;',
    extractFn(WIDGET, 'getServiceKey'),
    extractFn(WIDGET, 'safePctKey'),
    extractFn(WIDGET, 'aiCmRingBounds'),
    extractFn(WIDGET, 'aiCmActivePct'),
    extractFn(WIDGET, 'computeEffectiveLimit'),
    extractFn(WIDGET, 'setSafePctFromInput'),
    extractFn(WIDGET, 'snapCurrentPct'),
    extractFn(WIDGET, 'resetSafePct'),
    extractFn(WIDGET, 'aiCmRepaintRing'),
    extractFn(WIDGET, 'aiCmLoadRingThresholds'),
    'ctx.__api = { getServiceKey: getServiceKey, safePctKey: safePctKey,' +
    ' aiCmActivePct: aiCmActivePct, computeEffectiveLimit: computeEffectiveLimit,' +
    ' setSafePctFromInput: setSafePctFromInput, resetSafePct: resetSafePct,' +
    ' snapCurrentPct: snapCurrentPct,' +
    ' getSafePct: function () { return safePct; },' +
    ' setSafePct: function (v) { safePct = v; },' +
    ' getRingThresholds: function () { return aiCmRingThresholds; },' +
    ' setLastWidgetData: function (v) { lastWidgetData = v; },' +
    ' loadRingThresholds: aiCmLoadRingThresholds };'
  ].join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return { api: ctx.__api, store: store, listeners: listeners, syncGet: store.chrome.storage.sync.get };
}

// =====================================================================================
// Песочница 2: палитра — THEME_CONFIGS + getServiceKey + isDarkMode + applyNativeStyles
// =====================================================================================
function paletteSandbox(hostname, prefersDark) {
  const ctx = {
    window: {
      location: { hostname: hostname },
      matchMedia: () => makeMq(prefersDark),
      getComputedStyle: (el) => window.getComputedStyle(el)
    },
    __api: null
  };
  const src = [
    'const THEME_CONFIGS = ' + extractConstObject(WIDGET, 'THEME_CONFIGS') + ';',
    'var aiCmWidgetAppliedTheme = null;',
    extractFn(WIDGET, 'getServiceKey'),
    extractFn(WIDGET, 'aiCmInAppTheme'),
    extractFn(WIDGET, 'isDarkMode'),
    extractFn(WIDGET, 'applyNativeStyles'),
    'ctx.__api = { getServiceKey: getServiceKey, isDarkMode: isDarkMode, applyNativeStyles: applyNativeStyles };'
  ].join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return ctx.__api;
}

function paletteFor(hostname, prefersDark, domOpts) {
  setDom(domOpts);
  const api = paletteSandbox(hostname, prefersDark);
  const el = document.createElement('div');
  api.applyNativeStyles(el);
  return {
    isDark: api.isDarkMode(),
    tooltipBg: el.style.getPropertyValue('--w-tooltip-bg'),
    text: el.style.getPropertyValue('--w-text'),
    bgTrack: el.style.getPropertyValue('--w-bg-track'),
    bgFill: el.style.getPropertyValue('--w-bg-fill')
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  document.body.style.backgroundColor = '';
  document.documentElement.className = '';
  document.documentElement.style.backgroundColor = '';
});

// =====================================================================================
// P1 — формат ключа (источник: проектный дефект, safePctKey core/widget.js:22)
// =====================================================================================
describe('P1 (формат ключа): claude.ai → serviceKey claude и per-service ключ claude', () => {
  test('claude.ai: getServiceKey() === "claude" (а не фолбэк "chatgpt")', () => {
    const s = pctSandbox('claude.ai');
    expect(s.api.getServiceKey()).toBe('claude');
    expect(s.api.getServiceKey()).not.toBe('chatgpt');
  });

  test('claude.ai: safePctKey() === "ai_cm_safe_pct_claude" и НЕ равно chatgpt-ключу', () => {
    const s = pctSandbox('claude.ai');
    expect(s.api.safePctKey()).toBe('ai_cm_safe_pct_claude');
    expect(s.api.safePctKey()).not.toBe('ai_cm_safe_pct_chatgpt');
  });

  test('прочие сервисы — байтово прежние ключи (non-regression формата)', () => {
    expect(pctSandbox('chatgpt.com').api.safePctKey()).toBe('ai_cm_safe_pct_chatgpt');
    expect(pctSandbox('chat.deepseek.com').api.safePctKey()).toBe('ai_cm_safe_pct_deepseek');
    expect(pctSandbox('gemini.google.com').api.safePctKey()).toBe('ai_cm_safe_pct_gemini');
    expect(pctSandbox('www.google.com').api.safePctKey()).toBe('ai_cm_safe_pct_google_search');
  });

  test('вне списка сервисов (perplexity.ai/qwen) фолбэк "chatgpt" сохранён (вне scope)', () => {
    expect(pctSandbox('perplexity.ai').api.getServiceKey()).toBe('chatgpt');
    expect(pctSandbox('chat.qwen.ai').api.getServiceKey()).toBe('chatgpt');
  });
});

// =====================================================================================
// P2 — путь записи (источник: setSafePctFromInput, core/widget.js:113-120)
// =====================================================================================
describe('P2 (путь записи): порог, выставленный на claude.ai, пишется в claude-ключ', () => {
  test('setSafePctFromInput("50") → sync.set({ ai_cm_safe_pct_claude: 50 })', () => {
    const s = pctSandbox('claude.ai');
    s.api.setSafePctFromInput('50');
    expect(s.store.writes.length).toBe(1);
    expect(s.store.writes[0]).toEqual({ ai_cm_safe_pct_claude: 50 });
    expect(s.store.state.ai_cm_safe_pct_claude).toBe(50);
    expect(s.api.getSafePct()).toBe(50);
  });

  test('snapCurrentPct ("Снять текущий %") пишет в claude-ключ, а не в chatgpt-ключ', () => {
    const s = pctSandbox('claude.ai');
    s.api.setLastWidgetData({ effectiveLimit: 500000, tokenEstimate: 100000 });
    s.api.snapCurrentPct(); // core/widget.js:104-112
    expect(s.api.getSafePct()).toBe(20); // 100000/500000*1000 = 200 → /10 = 20
    expect(s.store.writes.length).toBe(1);
    expect(s.store.writes[0]).toEqual({ ai_cm_safe_pct_claude: 20 });
    expect('ai_cm_safe_pct_chatgpt' in s.store.writes[0]).toBe(false);
  });

  test('resetSafePct ("Авто") обнуляет именно claude-ключ', () => {
    const s = pctSandbox('claude.ai', { ai_cm_safe_pct_claude: 40 });
    s.api.setSafePct(40);
    s.api.resetSafePct(); // core/widget.js:121-126
    expect(s.api.getSafePct()).toBe(null);
    expect(s.store.writes[0]).toEqual({ ai_cm_safe_pct_claude: null });
  });
});

// =====================================================================================
// P3 — путь чтения (источник: content.js:1158-1160 — sync.get([safePctKey()]) → safePct)
// =====================================================================================
describe('P3 (путь чтения): порог Claude читается из claude-ключа и даёт правильный displayLimit', () => {
  test('sync-стаб { ai_cm_safe_pct_claude: 40 } → safePct 40 → displayLimit 200000 (40% от 500000)', () => {
    const s = pctSandbox('claude.ai', { ai_cm_safe_pct_claude: 40 });
    const key = s.api.safePctKey();
    expect(key).toBe('ai_cm_safe_pct_claude');
    let v;
    s.syncGet([key], (d) => { v = d[key]; }); // core/content.js:1158: chrome.storage.sync.get([safePctKey()], ...)
    s.api.setSafePct((typeof v === 'number' && v > 0) ? v : null); // core/content.js:1160
    expect(s.api.getSafePct()).toBe(40);
    // utils/model-config.js:323-327: claude-sonnet-4-6 capExempt, contextLimit 500000
    expect(ModelConfig.getEffectiveLimit('claude-sonnet-4-6')).toBe(500000);
    expect(s.api.computeEffectiveLimit('claude-sonnet-4-6')).toBe(200000);
  });

  test('дефект-контрфакт: без порога (Авто) displayLimit Claude = 500000 ≠ 200000', () => {
    const s = pctSandbox('claude.ai');
    expect(s.api.getSafePct()).toBe(null);
    expect(s.api.computeEffectiveLimit('claude-sonnet-4-6')).toBe(500000);
  });

  test('источник чтения keyed динамически: content.js читает storage по safePctKey()', () => {
    // core/content.js:1158-1160 — ключ чтения не литерал, а safePctKey()
    expect(CONTENT).toContain('chrome.storage.sync.get([safePctKey()], (d) => {');
    expect(CONTENT).toContain('const v = d[safePctKey()];');
    expect(CONTENT).toContain("safePct = (typeof v === 'number' && v > 0) ? v : null;");
  });
});

// =====================================================================================
// P4 — инвариант изоляции (источник: безопасность пер-сервисного ключа)
// =====================================================================================
describe('P4 (изоляция): Claude и ChatGPT не делят порог', () => {
  test('запись на claude.ai не создаёт и не меняет ai_cm_safe_pct_chatgpt', () => {
    const s = pctSandbox('claude.ai', { ai_cm_safe_pct_chatgpt: 70 });
    s.api.setSafePctFromInput('50');
    expect(s.store.state.ai_cm_safe_pct_claude).toBe(50);
    expect(s.store.state.ai_cm_safe_pct_chatgpt).toBe(70); // чужой порог не тронут
    expect(Object.keys(s.store.writes[0])).toEqual(['ai_cm_safe_pct_claude']);
    expect('ai_cm_safe_pct_chatgpt' in s.store.writes[0]).toBe(false);
  });

  test('onChanged по chatgpt-ключу не трогает safePct на claude.ai (core/content.js:2962-2968)', () => {
    const s = pctSandbox('claude.ai', { ai_cm_safe_pct_claude: 40 });
    s.api.setSafePct(40);
    const sk = s.api.safePctKey();
    const changes = { ai_cm_safe_pct_chatgpt: { newValue: 99 } };
    // точная реконструкция ветки content.js:2963 `if (changes[sk])`
    if (changes[sk]) s.api.setSafePct(changes[sk].newValue);
    expect(changes[sk]).toBeUndefined();
    expect(s.api.getSafePct()).toBe(40);
  });

  test('onChanged по СВОЕМУ claude-ключу применяет порог (канал жив)', () => {
    const s = pctSandbox('claude.ai', { ai_cm_safe_pct_claude: 40 });
    s.api.setSafePct(40);
    const sk = s.api.safePctKey();
    const changes = { ai_cm_safe_pct_claude: { newValue: 55 } };
    if (changes[sk]) s.api.setSafePct((typeof changes[sk].newValue === 'number' && changes[sk].newValue > 0) ? changes[sk].newValue : null);
    expect(s.api.getSafePct()).toBe(55);
  });

  test('ring-onChanged (core/widget.js:748-756) гейтнут на aiCmProactiveThresholds и игнорирует safePct-ключи', () => {
    const s = pctSandbox('claude.ai');
    s.api.loadRingThresholds(); // реальный aiCmLoadRingThresholds взводит подписку в ЭТОЙ же песочнице
    const listeners = s.listeners;
    expect(listeners.length).toBe(1);
    const listen = listeners[0];
    s.api.setSafePct(40);
    listen({ ai_cm_safe_pct_chatgpt: { newValue: 99 } }, 'sync'); // чужой ключ
    expect(s.api.getSafePct()).toBe(40);
    expect(s.api.getRingThresholds()).toBe(null); // пороги кольца не тронуты
    listen({ aiCmProactiveThresholds: { newValue: [60, 80, 90] } }, 'local'); // свой ключ порогов
    expect(s.api.getRingThresholds()).toEqual([60, 80, 90]); // гейт именно на порогах кольца
  });
});

// =====================================================================================
// P5 — non-regression палитры (источник: tests/widget-inapp-theme-h24.test.js:165, :199)
// =====================================================================================
describe('P5 (non-regression палитры): claude.ai даёт палитру THEME_CONFIGS.chatgpt байтово', () => {
  test('claude.ai light → #ffffff/#212121/#f0f0f0 (палитра chatgpt.light)', () => {
    const p = paletteFor('claude.ai', false, { bodyBg: 'rgb(255, 255, 255)' });
    expect(p.isDark).toBe(false);
    expect(p.tooltipBg).toBe('#ffffff');
    expect(p.text).toBe('#212121');
    expect(p.bgTrack).toBe('#f0f0f0');
  });

  test('claude.ai dark (тёмный body, светлая ОС) → #212121/#ececf1/#2f2f2f (палитра chatgpt.dark)', () => {
    const p = paletteFor('claude.ai', false, { bodyBg: 'rgb(38, 38, 36)' });
    expect(p.isDark).toBe(true);
    expect(p.tooltipBg).toBe('#212121');
    expect(p.text).toBe('#ececf1');
    expect(p.bgTrack).toBe('#2f2f2f');
  });

  test('claude.ai и chatgpt.com дают БАЙТОВО одну палитру (тема виджета не изменилась)', () => {
    ['light', 'dark'].forEach((mode) => {
      const dom = mode === 'dark' ? { bodyBg: 'rgb(21, 21, 21)' } : { bodyBg: 'rgb(255, 255, 255)' };
      expect(paletteFor('claude.ai', false, dom)).toEqual(paletteFor('chatgpt.com', false, dom));
    });
  });
});

// =====================================================================================
// P6 — гард отсутствующего ключа (источник: core/widget.js:435 + отсутствие 'claude' в THEME_CONFIGS)
// =====================================================================================
describe('P6 (гард отсутствующего ключа): нет TypeError, когда ключа нет в THEME_CONFIGS', () => {
  test('в THEME_CONFIGS ДЕЙСТВИТЕЛЬНО нет ключа claude → гард несущий', () => {
    const THEME = new Function('return ' + extractConstObject(WIDGET, 'THEME_CONFIGS'))();
    expect(Object.keys(THEME).sort()).toEqual(['chatgpt', 'deepseek', 'gemini', 'google_search']);
    expect(THEME.claude).toBeUndefined();
    // контрфакт без гарда: именно эта строка давала бы TypeError на claude.ai
    expect(() => { const c = THEME.claude; return c.dark; }).toThrow(TypeError);
  });

  test('host вне THEME_CONFIGS и ≠ claude (perplexity.ai) → палитра chatgpt, без TypeError', () => {
    let p;
    expect(() => { p = paletteFor('perplexity.ai', false, { bodyBg: 'rgb(255, 255, 255)' }); }).not.toThrow();
    expect(p.tooltipBg).toBe('#ffffff');
    expect(p.text).toBe('#212121');
    expect(p.bgTrack).toBe('#f0f0f0');
  });

  test('claude.ai (ключ ' + "'claude'" + ' отсутствует в THEME_CONFIGS) → палитра chatgpt, без TypeError', () => {
    let p;
    expect(() => { p = paletteFor('claude.ai', true, { bodyBg: 'rgb(21, 21, 21)' }); }).not.toThrow();
    expect(p.tooltipBg).toBe('#212121');
  });

  test('структурный пин: applyNativeStyles содержит фолбэк на THEME_CONFIGS.chatgpt', () => {
    const fnSrc = extractFn(WIDGET, 'applyNativeStyles');
    expect(fnSrc).toContain('const config = THEME_CONFIGS[serviceKey] || THEME_CONFIGS.chatgpt;');
    expect(fnSrc).toContain('const styles = isDark ? config.dark : config.light;');
  });
});

// =====================================================================================
// P7 — диагностика (источник: core/content.js:2157 svc + :2227-2241 gsa-metric-src site)
// =====================================================================================
describe('P7 (диагностика): site в gsa-metric-src питается getServiceKey()', () => {
  test('источник: svc = getServiceKey(), а site: svc в объекте gsa-metric-src', () => {
    expect(CONTENT).toContain('const svc = getServiceKey();');
    expect(CONTENT).toContain("aiCmDiagLine('gsa-metric-src', {");
    const i = CONTENT.indexOf("aiCmDiagLine('gsa-metric-src', {");
    const block = CONTENT.slice(i, CONTENT.indexOf('});', i));
    expect(block).toContain('site: svc,');
  });

  test('claude.ai → site "claude" (прежде — "chatgpt" из фолбэка)', () => {
    const svc = pctSandbox('claude.ai').api.getServiceKey();
    expect(svc).toBe('claude');
    const line = { site: svc };
    expect(line.site).toBe('claude');
  });

  test('host вне списка → site "chatgpt" (фолбэк сохранён)', () => {
    expect(({ site: pctSandbox('perplexity.ai').api.getServiceKey() }).site).toBe('chatgpt');
  });
});

// =====================================================================================
// Структурные пины самой правки A′ (ровно 2 строки, 1-в-1)
// =====================================================================================
describe("Правка A′: ровно две строки core/widget.js, прочие ветки байтово не тронуты", () => {
  test('getServiceKey: новый хвост и отсутствие прежнего голого фолбэка', () => {
    const fnSrc = extractFn(WIDGET, 'getServiceKey');
    expect(fnSrc).toContain("return host.includes('claude.ai') ? 'claude' : 'chatgpt';");
    expect(fnSrc).not.toMatch(/^\s*return 'chatgpt';\s*$/m);
  });

  test('ветки chatgpt.com/deepseek.com/gemini.google.com/google.com — байтово прежние', () => {
    const fnSrc = extractFn(WIDGET, 'getServiceKey');
    expect(fnSrc).toContain("if (host.includes('chatgpt.com')) return 'chatgpt';");
    expect(fnSrc).toContain("if (host.includes('deepseek.com')) return 'deepseek';");
    expect(fnSrc).toContain("if (host.includes('gemini.google.com')) return 'gemini';");
    expect(fnSrc).toContain("if (host.includes('google.com')) return 'google_search';");
  });

  test('THEME_CONFIGS не тронут: четыре ключа и значения chatgpt-палитры прежние', () => {
    expect(WIDGET).toContain("light: { bgTrack: '#f0f0f0', bgFill: '#10a37f', text: '#212121', tooltipBg: '#ffffff', tooltipText: '#212121'");
    expect(WIDGET).toContain("dark: { bgTrack: '#2f2f2f', bgFill: '#19c37d', text: '#ececf1', tooltipBg: '#212121', tooltipText: '#ececf1'");
    expect(WIDGET).not.toContain('THEME_CONFIGS.claude =');
  });
});
