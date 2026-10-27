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
 *
 * --- v63 (Fix-getServiceKey-expand): расширение на perplexity.ai и chat.qwen.ai ---
 * Правка A′ (1 строка, замена 1-в-1 на ТОЙ ЖЕ строке core/widget.js:366, номера не сдвигаются):
 *   хвост стал цепочкой
 *   `return host.includes('perplexity.ai') ? 'perplexity' : host.includes('chat.qwen.ai') ? 'qwen'
 *    : host.includes('claude.ai') ? 'claude' : 'chatgpt';`
 * ⇒ safePctKey() даёт 'ai_cm_safe_pct_perplexity' / 'ai_cm_safe_pct_qwen' (прежде — чужой ключ ChatGPT).
 * aistudio.google.com СОЗНАТЕЛЬНО НЕ добавлялся в v63 (его перехватывала ветка host.includes('google.com')
 *   → 'google_search'; ключа 'aistudio' не было в THEME_CONFIGS, поэтому ветка переключила бы палитру
 *   виджета на chatgpt-зелёную #10a37f через гард core/widget.js:435 и сделала бы достижимыми 4 ветки
 *   `=== 'aistudio'` в core/content.js) — это была ОТДЕЛЬНАЯ задача с живой приёмкой.
 * --- v64 (Fix-aistudio-servicekey): эта отдельная задача выполнена (m00001) ---
 *   (1) core/widget.js, getServiceKey(): Перед `if (host.includes('google.com'))` добавлена ветка
 *       `if (host.includes('aistudio.google.com')) return 'aistudio';` ⇒ safePctKey() даёт
 *       'ai_cm_safe_pct_aistudio' (свой ключ, а не google_search).
 *   (2) core/widget.js, THEME_CONFIGS: добавлен ключ `aistudio` — палитра БАЙТОВО равна google_search
 *       (light #f1f3f4/#1a73e8/#3c4043, dark #3c4043/#8ab4f8/#e8eaed, font "Google Sans"), т.к. до правки
 *       AI Studio получал ровно её. Внешний вид не меняется ⇒ P-aistudio-1b прежний.
 *   (3) Миграция порога: при первом чтении, если 'ai_cm_safe_pct_aistudio' в storage ОТСУТСТВУЕТ
 *       (undefined), значение однократно копируется из 'ai_cm_safe_pct_google_search' (старый ключ
 *       НЕ удаляется). Явный «Авто» пишет null — это НЕ пусто, поэтому миграция не воскрешает снятый
 *       порог. Функции: AI_CM_SAFE_PCT_MIGRATIONS / aiCmSafePctMigrationSource /
 *       aiCmSafePctMigrationValue (чистая) / aiCmMigrateSafePct; вызов — core/content.js initialize.
 *   (4) core/content.js: 4 прежние «спящие» ветки `=== 'aistudio'` НЕЙТРАЛИЗОВАНЫ до строгого
 *       'gemini' (v28 tape-restore, v82 D8.3 retry, isGeminiLike, v81 2.4 isGeminiS24): до появления
 *       ключа AI Studio ходил туда как 'google_search' и в них не входил, т.е. поведение байтово
 *       прежнее. isGeminiSvc (BYOK) НЕ тронут — пины qwen-gate-diag-o35/qwen-provider-wiring живы.
 * Новые пины v63: P8 (perplexity/qwen/aistudio), R1–R3 (non-regression + изоляция), S-1/S-2 (структура).
 * Новые пины v64: P-aistudio-1/-1b (ключ + палитра), P-aistudio-2 (миграция safePct), S-1/S-2 обновлены
 *   (5 ключей THEME_CONFIGS, 8 host.includes в getServiceKey).
 * ШАГ 2 (qwen, read-only — сцепления НЕТ): qwen-intercept не публикует serverTokens (O-47,
 *   core/qwen-intercept.js:932-941), поэтому netServerTokens на chat.qwen.ai = 0 и
 *   aiCmMetricServerTokens (core/content.js:1917-1920) возвращает 0 и ДО, и ПОСЛЕ правки;
 *   прочие гейты content.js сравнивают currentAdapter.siteName, а не getServiceKey().
 *   core/content.js и core/qwen-intercept.js НЕ тронуты.
 * THEME_CONFIGS в v63 не тронут (было ровно 4 ключа) — S-2/P6; в v64 ключей стало 5 (добавлен 'aistudio').
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

// =====================================================================================
// Песочница 3 (v64): миграция per-service порога — реальные тела core/widget.js
// =====================================================================================
function migrationSandbox(hostname, initialSync) {
  const listeners = [];
  const store = chromeStub(initialSync, listeners);
  const ctx = {
    window: { location: { hostname: hostname } },
    chrome: store.chrome,
    isExtensionValid: () => true,
    updatePanel: () => { },
    processAndSend: () => { },
    debugLog: () => { },
    aiCmDiagLine: () => { },
    __api: null
  };
  const src = [
    'var safePct = null;',
    'const AI_CM_SAFE_PCT_MIGRATIONS = ' + extractConstObject(WIDGET, 'AI_CM_SAFE_PCT_MIGRATIONS') + ';',
    extractFn(WIDGET, 'getServiceKey'),
    extractFn(WIDGET, 'aiCmSafePctMigrationSource'),
    extractFn(WIDGET, 'aiCmSafePctMigrationValue'),
    extractFn(WIDGET, 'aiCmMigrateSafePct'),
    'ctx.__api = { getServiceKey: getServiceKey, migrationSource: aiCmSafePctMigrationSource,' +
    ' migrationValue: aiCmSafePctMigrationValue, migrate: aiCmMigrateSafePct,' +
    ' getSafePct: function () { return safePct; } };'
  ].join('\n');
  new Function('ctx', 'with (ctx) {\n' + src + '\n}')(ctx);
  return { api: ctx.__api, store: store, listeners: listeners, chart: ctx.chrome };
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

  test('R1: четыре прежних сервиса — getServiceKey байтово прежний (non-regression веток)', () => {
    expect(pctSandbox('chatgpt.com').api.getServiceKey()).toBe('chatgpt');
    expect(pctSandbox('chat.deepseek.com').api.getServiceKey()).toBe('deepseek');
    expect(pctSandbox('gemini.google.com').api.getServiceKey()).toBe('gemini');
    expect(pctSandbox('www.google.com').api.getServiceKey()).toBe('google_search');
  });

  test('хост вне списка сервисов (example.com) → фолбэк "chatgpt" сохранён', () => {
    expect(pctSandbox('example.com').api.getServiceKey()).toBe('chatgpt');
    expect(pctSandbox('example.com').api.safePctKey()).toBe('ai_cm_safe_pct_chatgpt');
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
    expect(Object.keys(THEME).sort()).toEqual(['aistudio', 'chatgpt', 'deepseek', 'gemini', 'google_search']);
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

  test('host вне списка сервисов (example.com) → site "chatgpt" (фолбэк сохранён)', () => {
    expect(({ site: pctSandbox('example.com').api.getServiceKey() }).site).toBe('chatgpt');
  });

  test('v63: perplexity.ai → site "perplexity", chat.qwen.ai → site "qwen" (прежде — "chatgpt")', () => {
    expect(({ site: pctSandbox('perplexity.ai').api.getServiceKey() }).site).toBe('perplexity');
    expect(({ site: pctSandbox('chat.qwen.ai').api.getServiceKey() }).site).toBe('qwen');
    // v64: aistudio больше НЕ 'google_search' — свой ключ (см. P-aistudio-1)
    expect(({ site: pctSandbox('aistudio.google.com').api.getServiceKey() }).site).toBe('aistudio');
  });
});

// =====================================================================================
// P8 — расширение v63 (источник: m00001 ШАГ 3-5; образец ветки claude.ai v62)
// =====================================================================================
describe('P8 (v63: perplexity.ai / chat.qwen.ai): per-service serviceKey и ключ порога', () => {
  test('P-perplexity-1: perplexity.ai → "perplexity"; safePctKey "ai_cm_safe_pct_perplexity" ≠ chatgpt', () => {
    const s = pctSandbox('perplexity.ai');
    expect(s.api.getServiceKey()).toBe('perplexity');
    expect(s.api.safePctKey()).toBe('ai_cm_safe_pct_perplexity');
    expect(s.api.safePctKey()).not.toBe('ai_cm_safe_pct_chatgpt');
  });

  test('P-perplexity-1b: поддомен www.perplexity.ai → "perplexity"', () => {
    expect(pctSandbox('www.perplexity.ai').api.getServiceKey()).toBe('perplexity');
  });

  test('P-qwen-1: chat.qwen.ai → "qwen"; safePctKey "ai_cm_safe_pct_qwen" ≠ chatgpt', () => {
    const s = pctSandbox('chat.qwen.ai');
    expect(s.api.getServiceKey()).toBe('qwen');
    expect(s.api.safePctKey()).toBe('ai_cm_safe_pct_qwen');
    expect(s.api.safePctKey()).not.toBe('ai_cm_safe_pct_chatgpt');
  });

  test('P-qwen-1b: ветка — только chat.qwen.ai; qwen.ai → фолбэк "chatgpt"', () => {
    expect(pctSandbox('qwen.ai').api.getServiceKey()).toBe('chatgpt');
  });

  test('P-aistudio-1: aistudio.google.com → "aistudio"; safePctKey свой; палитра в THEME_CONFIGS', () => {
    const s = pctSandbox('aistudio.google.com');
    expect(s.api.getServiceKey()).toBe('aistudio');
    expect(s.api.safePctKey()).toBe('ai_cm_safe_pct_aistudio');
    expect(s.api.safePctKey()).not.toBe('ai_cm_safe_pct_google_search');
    // v64: ключ 'aistudio' ЕСТЬ в THEME_CONFIGS — иначе гард core/widget.js:435 дал бы chatgpt-палитру
    const THEME = new Function('return ' + extractConstObject(WIDGET, 'THEME_CONFIGS'))();
    expect(THEME.aistudio).toBeDefined();
    expect(WIDGET).toContain("host.includes('aistudio.google.com')");
    // ветка стоит ПЕРЕД google-веткой, иначе aistudio.google.com до неё не дойдёт
    expect(WIDGET.indexOf("if (host.includes('aistudio.google.com')) return 'aistudio';"))
      .toBeLessThan(WIDGET.indexOf("if (host.includes('google.com')) return 'google_search';"));
    // www.google.com остаётся 'google_search' (non-regression per-service ключа GSA)
    expect(pctSandbox('www.google.com').api.getServiceKey()).toBe('google_search');
  });

  test('P-aistudio-1b: палитра aistudio.google.com — google_search (#f1f3f4/#1a73e8), НЕ chatgpt-зелёная', () => {
    const p = paletteFor('aistudio.google.com', false, { bodyBg: 'rgb(255, 255, 255)' });
    expect(p.isDark).toBe(false);
    expect(p.bgTrack).toBe('#f1f3f4');
    expect(p.bgFill).toBe('#1a73e8');
    expect(p.bgFill).not.toBe('#10a37f');
    // v64: палитра aistudio БАЙТОВО равна google_search и в light, и в dark (вид не изменился)
    ['light', 'dark'].forEach((mode) => {
      const dom = mode === 'dark' ? { bodyBg: 'rgb(32, 33, 36)' } : { bodyBg: 'rgb(255, 255, 255)' };
      expect(paletteFor('aistudio.google.com', false, dom))
        .toEqual(paletteFor('www.google.com', false, dom));
    });
  });
});

// =====================================================================================
// P-aistudio-2 (v64) — миграция per-service порога 'google_search' → 'aistudio'
// Источник: m00001 ШАГ 2. Прежде порог на AI Studio лежал в ai_cm_safe_pct_google_search
// (aistudio.google.com → 'google_search'); новый ключ иначе «потерял» бы его.
// =====================================================================================
describe('P-aistudio-2 (v64): однократная миграция порога в ключ aistudio', () => {
  test('aiCmSafePctMigrationValue — таблица решений (свой ключ / кривой legacy)', () => {
    const s = migrationSandbox('aistudio.google.com');
    const val = s.api.migrationValue;
    // своего ключа нет, legacy валиден → мигрируем ровно его
    expect(val(undefined, 40)).toBe(40);
    expect(val(undefined, 1)).toBe(1);
    expect(val(undefined, 99.5)).toBe(99.5);
    // свой ключ уже есть (число или null = «Авто») → НЕ мигрируем (однократность)
    expect(val(40, 30)).toBe(null);
    expect(val(null, 40)).toBe(null); // «Авто» не воскресает
    expect(val(0, 40)).toBe(null); // 0 в свой ключ не пишется, но ключ существует
    // legacy пуст/кривой → мигрировать нечего
    expect(val(undefined, undefined)).toBe(null);
    expect(val(undefined, null)).toBe(null);
    expect(val(undefined, 0)).toBe(null);
    expect(val(undefined, -5)).toBe(null);
    expect(val(undefined, '40')).toBe(null);
    expect(val(undefined, NaN)).toBe(null);
  });

  test('aiCmSafePctMigrationSource — пара ключей только для aistudio', () => {
    expect(migrationSandbox('aistudio.google.com').api.migrationSource())
      .toEqual({ own: 'ai_cm_safe_pct_aistudio', legacy: 'ai_cm_safe_pct_google_search' });
    // остальные сервисы миграции не имеют — хранимые ключи байтово прежние
    ['chatgpt.com', 'www.google.com', 'gemini.google.com', 'claude.ai', 'chat.qwen.ai', 'example.com']
      .forEach((h) => expect(migrationSandbox(h).api.migrationSource()).toBe(null));
  });

  test('E2E: legacy 40 → запись ai_cm_safe_pct_aistudio=40, старый ключ не удалён, cb(40)', () => {
    const s = migrationSandbox('aistudio.google.com', {
      ai_cm_safe_pct_google_search: 40,
      ai_cm_safe_pct_aistudio: undefined
    });
    let got = 'not-called';
    expect(s.api.migrate((v) => { got = v; })).toBe(true);
    expect(got).toBe(40);
    expect(s.store.writes).toEqual([{ ai_cm_safe_pct_aistudio: 40 }]);
    expect(s.store.state.ai_cm_safe_pct_aistudio).toBe(40);
    expect(s.store.state.ai_cm_safe_pct_google_search).toBe(40); // старый ключ НЕ удалён
  });

  test('однократность: второй вызов со своим ключом ничего не пишет и даёт cb(null)', () => {
    const s = migrationSandbox('aistudio.google.com', {
      ai_cm_safe_pct_google_search: 40,
      ai_cm_safe_pct_aistudio: undefined
    });
    expect(s.api.migrate(() => { })).toBe(true);
    expect(s.store.writes.length).toBe(1);
    const writesAfterFirst = s.store.writes.length;
    let second = 'not-called';
    expect(s.api.migrate((v) => { second = v; })).toBe(true);
    expect(second).toBe(null);
    expect(s.store.writes.length).toBe(writesAfterFirst); // ровно одна запись за всю жизнь
  });

  test('«Авто» (null) не мигрирует: legacy 40 при null в своём ключе игнорируется', () => {
    const s = migrationSandbox('aistudio.google.com', {
      ai_cm_safe_pct_google_search: 40,
      ai_cm_safe_pct_aistudio: null
    });
    let got = 'not-called';
    expect(s.api.migrate((v) => { got = v; })).toBe(true);
    expect(got).toBe(null);
    expect(s.store.writes).toEqual([]);
  });

  test('legacy пуст или кривой → storage не пишется, cb(null)', () => {
    [{}, { ai_cm_safe_pct_google_search: 0 }, { ai_cm_safe_pct_google_search: -3 }].forEach((init) => {
      const s = migrationSandbox('aistudio.google.com', init);
      let got = 'not-called';
      expect(s.api.migrate((v) => { got = v; })).toBe(true);
      expect(got).toBe(null);
      expect(s.store.writes).toEqual([]);
    });
  });

  test('сервис без миграции: migrate() → false, колбэк и storage НЕ трогаются', () => {
    const s = migrationSandbox('chatgpt.com', { ai_cm_safe_pct_chatgpt: 10 });
    let gets = 0;
    const rawGet = s.chart.storage.sync.get;
    s.chart.storage.sync.get = function (keys, cb) { gets++; return rawGet.call(this, keys, cb); };
    let called = false;
    expect(s.api.migrate(() => { called = true; })).toBe(false);
    expect(called).toBe(false);
    expect(gets).toBe(0); // ни одного storage-обращения — путь чтения не удлиняется
    expect(s.store.writes).toEqual([]);
  });

  test('структурный пин: константа миграции и вызов в точке чтения content.js', () => {
    expect(WIDGET).toContain("const AI_CM_SAFE_PCT_MIGRATIONS = { aistudio: 'google_search' };");
    // вызов стоит в initialize до чтения порога (typeof-гард — конвенция сьюта)
    expect(CONTENT).toContain('typeof aiCmMigrateSafePct === \'function\'');
    expect(CONTENT.indexOf('aiCmMigrateSafePct(')).toBeLessThan(CONTENT.indexOf('chrome.storage.sync.get([safePctKey()], (d) => {'));
  });
});

// =====================================================================================
// R3 — изоляция v63 (источник: ШАГ 5 R3; инвариант пер-сервисного ключа)
// =====================================================================================
describe('R3 (изоляция v63): perplexity / qwen / chatgpt не делят порог', () => {
  test('запись на perplexity.ai не создаёт и не меняет chatgpt- и qwen-ключи', () => {
    const s = pctSandbox('perplexity.ai', { ai_cm_safe_pct_chatgpt: 70, ai_cm_safe_pct_qwen: 30 });
    s.api.setSafePctFromInput('50');
    expect(s.store.state.ai_cm_safe_pct_perplexity).toBe(50);
    expect(s.store.state.ai_cm_safe_pct_chatgpt).toBe(70);
    expect(s.store.state.ai_cm_safe_pct_qwen).toBe(30);
    expect(Object.keys(s.store.writes[0])).toEqual(['ai_cm_safe_pct_perplexity']);
  });

  test('запись на chat.qwen.ai не создаёт и не меняет perplexity- и chatgpt-ключи', () => {
    const s = pctSandbox('chat.qwen.ai', { ai_cm_safe_pct_chatgpt: 70, ai_cm_safe_pct_perplexity: 20 });
    s.api.setSafePctFromInput('60');
    expect(s.store.writes[0]).toEqual({ ai_cm_safe_pct_qwen: 60 });
    expect(s.store.state.ai_cm_safe_pct_chatgpt).toBe(70);
    expect(s.store.state.ai_cm_safe_pct_perplexity).toBe(20);
  });

  test('чтение qwen: sync-стаб по своему ключу применяется, чужой onChanged — нет', () => {
    const s = pctSandbox('chat.qwen.ai', { ai_cm_safe_pct_qwen: 40 });
    const key = s.api.safePctKey();
    expect(key).toBe('ai_cm_safe_pct_qwen');
    let v;
    s.syncGet([key], (d) => { v = d[key]; }); // core/content.js:1158 — sync.get([safePctKey()])
    s.api.setSafePct((typeof v === 'number' && v > 0) ? v : null);
    expect(s.api.getSafePct()).toBe(40);
    const sk = s.api.safePctKey();
    const foreign = { ai_cm_safe_pct_chatgpt: { newValue: 99 }, ai_cm_safe_pct_perplexity: { newValue: 88 } };
    if (foreign[sk]) s.api.setSafePct(foreign[sk].newValue);
    expect(s.api.getSafePct()).toBe(40); // чужой порог не применён
    const own = { ai_cm_safe_pct_qwen: { newValue: 55 } };
    if (own[sk]) s.api.setSafePct(own[sk].newValue);
    expect(s.api.getSafePct()).toBe(55); // свой канал жив
  });
});

// =====================================================================================
// S — структурные пины v63 (одна точка правки; THEME_CONFIGS не тронут)
// =====================================================================================
describe('S (структура v63): правка в одной точке, THEME_CONFIGS не тронут', () => {
  test('S-1: getServiceKey — 8 host.includes (5 if + 3 в хвосте), тело из 9 строк', () => {
    const fnSrc = extractFn(WIDGET, 'getServiceKey');
    ['perplexity.ai', 'chat.qwen.ai', 'aistudio.google.com'].forEach((h) => expect(fnSrc).toContain("host.includes('" + h + "')"));
    expect((fnSrc.match(/host\.includes\(/g) || []).length).toBe(8); // 5 прежних if + 3 в хвосте
    expect(fnSrc.split('\n').length).toBe(9); // сигнатура, const host, 5 if, хвост-return, '}'
    expect(fnSrc.match(/^\s{2}return /gm).length).toBe(1); // ровно один return-строка в хвосте (1-в-1)
  });

  test('S-2: THEME_CONFIGS — 5 ключей (добавлен aistudio); нет perplexity/qwen/claude', () => {
    const THEME = new Function('return ' + extractConstObject(WIDGET, 'THEME_CONFIGS'))();
    expect(Object.keys(THEME).sort()).toEqual(['aistudio', 'chatgpt', 'deepseek', 'gemini', 'google_search']);
    ['perplexity', 'qwen', 'claude'].forEach((k) => expect(THEME[k]).toBeUndefined());
    expect(THEME.aistudio).toEqual(THEME.google_search); // палитра байтово одна
    expect(WIDGET).not.toMatch(/THEME_CONFIGS\.(perplexity|qwen|claude)\s*=/);
  });

  test('S-2b: палитры 4 прежних сервисов не переписаны (снимок ключевых значений)', () => {
    expect(WIDGET).toContain("light: { bgTrack: '#f1f3f4', bgFill: '#1a73e8'"); // google_search
    expect(WIDGET).toContain("light: { bgTrack: '#f0f0f0', bgFill: '#10a37f'"); // chatgpt
  });
});

// =====================================================================================
// Структурные пины самой правки A′ (ровно 2 строки, 1-в-1)
// =====================================================================================
describe("Правка A′: ровно две строки core/widget.js, прочие ветки байтово не тронуты", () => {
  test('getServiceKey: хвост v63 (perplexity → qwen → claude → chatgpt) и отсутствие голого фолбэка', () => {
    const fnSrc = extractFn(WIDGET, 'getServiceKey');
    expect(fnSrc).toContain("return host.includes('perplexity.ai') ? 'perplexity' : host.includes('chat.qwen.ai') ? 'qwen' : host.includes('claude.ai') ? 'claude' : 'chatgpt';");
    expect(fnSrc).toContain("'claude' : 'chatgpt';"); // пин v62 внутри хвоста не ослаблен
    expect(fnSrc).not.toContain("return host.includes('claude.ai') ? 'claude' : 'chatgpt';"); // прежний хвост v62 заменён
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
