/**
 * H19: оверрайды попапа (chrome.storage.sync: 'selectedModel' / 'customLimit') подключены
 * к display-расчёту.
 *   (а) явный выбор модели в дропдауне авторитетен для лимита и токенизации,
 *       «Автоопределение»/пусто/неизвестный id → сетевой slug (null);
 *   (б) поле «Лимит контекста» = % от Авто-порога: displayLimit = Auto × pct/100,
 *       «Заполнение» и цвета виджета считаются от displayLimit;
 *   (в) валидация: pct вне 1–100 (2000) → фолбэк 100 = как Авто, пусто → Авто;
 *   (г) дефолтный путь (Автоопределение + пустое поле/100) байтово идентичен прежнему.
 * Чистые функции — utils/model-config.js (resolvePopupModelId / resolveLimitPct /
 * applyLimitPct / computeDisplayLimit); пин-тесты — core/content.js и options/*.
 */

const fs = require('fs');
const path = require('path');
const ModelConfig = require('../utils/model-config.js');

const CORE = path.join(__dirname, '..', 'core', 'content.js');
const OPTIONS_JS = path.join(__dirname, '..', 'options', 'options.js');
const OPTIONS_HTML = path.join(__dirname, '..', 'options', 'options.html');

// Прежняя формула виджета (content.js до H19) — эталон байтовой идентичности
function legacyDisplayLimit(modelId, safePct) {
  const eff = ModelConfig.getEffectiveLimit(modelId);
  if (typeof safePct === 'number' && safePct > 0) return Math.max(1, Math.round(safePct / 100 * eff));
  return eff;
}
// Формула «Заполнения» (content.js:1583 — не менялась)
function percentageOf(tokens, displayLimit) {
  return displayLimit > 0 ? Math.round((tokens / displayLimit) * 1000) / 10 : 0;
}

describe('H19 (а): resolvePopupModelId — выбор модели попапа авторитетен', () => {
  test('известный id дропдауна → канонический ключ', () => {
    expect(ModelConfig.resolvePopupModelId('gemini-1.5-pro')).toBe('gemini-1.5-pro');
    expect(ModelConfig.resolvePopupModelId('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(ModelConfig.resolvePopupModelId('gpt-4')).toBe('gpt-4');
    expect(ModelConfig.resolvePopupModelId('deepseek-v3')).toBe('deepseek-v3');
  });

  test('имя модели (не slug) тоже резолвится', () => {
    expect(ModelConfig.resolvePopupModelId('Gemini 2.5 Pro')).toBe('gemini-2.5-pro');
  });

  test('«Автоопределение»/пусто/мусор → null (сетевой slug, прежний путь)', () => {
    expect(ModelConfig.resolvePopupModelId('auto')).toBeNull();
    expect(ModelConfig.resolvePopupModelId('AUTO')).toBeNull();
    expect(ModelConfig.resolvePopupModelId('')).toBeNull();
    expect(ModelConfig.resolvePopupModelId('   ')).toBeNull();
    expect(ModelConfig.resolvePopupModelId(null)).toBeNull();
    expect(ModelConfig.resolvePopupModelId(undefined)).toBeNull();
    expect(ModelConfig.resolvePopupModelId('нет-такой-модели')).toBeNull();
  });
});

describe('H19 (в): resolveLimitPct — валидация % от Авто', () => {
  test('1–100 как есть (число и строка)', () => {
    expect(ModelConfig.resolveLimitPct(50)).toBe(50);
    expect(ModelConfig.resolveLimitPct('50')).toBe(50);
    expect(ModelConfig.resolveLimitPct(1)).toBe(1);
    expect(ModelConfig.resolveLimitPct(100)).toBe(100);
  });

  test('пусто/null → Авто (null)', () => {
    expect(ModelConfig.resolveLimitPct('')).toBeNull();
    expect(ModelConfig.resolveLimitPct('   ')).toBeNull();
    expect(ModelConfig.resolveLimitPct(null)).toBeNull();
    expect(ModelConfig.resolveLimitPct(undefined)).toBeNull();
  });

  test('вне 1–100 → фолбэк 100 (как Авто): 2000, 0, -5, 101, мусор', () => {
    expect(ModelConfig.resolveLimitPct(2000)).toBe(100);
    expect(ModelConfig.resolveLimitPct('2000')).toBe(100);
    expect(ModelConfig.resolveLimitPct(0)).toBe(100);
    expect(ModelConfig.resolveLimitPct(-5)).toBe(100);
    expect(ModelConfig.resolveLimitPct(101)).toBe(100);
    expect(ModelConfig.resolveLimitPct('abc')).toBe(100);
  });
});

describe('H19 (б): computeDisplayLimit — unit-тесты оверрайдов', () => {
  test('pct=50 → 64 000 (Авто 128 000 × 50/100)', () => {
    expect(ModelConfig.getEffectiveLimit('gemini-2.5-flash')).toBe(128000);
    expect(ModelConfig.computeDisplayLimit('gemini-2.5-flash', 50)).toBe(64000);
  });

  test('pct=2000 → фолбэк 100 → Авто-порог', () => {
    expect(ModelConfig.resolveLimitPct(2000)).toBe(100);
    expect(ModelConfig.computeDisplayLimit('gemini-2.5-flash', ModelConfig.resolveLimitPct(2000))).toBe(128000);
    expect(ModelConfig.computeDisplayLimit('gemini-2.5-flash', ModelConfig.resolveLimitPct(2000)))
      .toBe(ModelConfig.getEffectiveLimit('gemini-2.5-flash'));
  });

  test('pct пусто (null) → Авто', () => {
    expect(ModelConfig.computeDisplayLimit('gemini-2.5-flash', null)).toBe(128000);
  });

  test('модель из попапа задаёт Авто-порог (gpt-4 = 8 192)', () => {
    expect(ModelConfig.computeDisplayLimit('gpt-4', null)).toBe(8192);
    expect(ModelConfig.computeDisplayLimit('gpt-4', 50)).toBe(4096);
  });

  test('Gemini 1.5 Pro: окно 2M, порог потери деталей 128K', () => {
    expect(ModelConfig.getContextLimit('gemini-1.5-pro')).toBe(2097152);
    expect(ModelConfig.computeDisplayLimit('gemini-1.5-pro', null)).toBe(128000);
    expect(ModelConfig.computeDisplayLimit('gemini-1.5-pro', 50)).toBe(64000);
  });

  test('pct=1 → 1 280 (минимум), неизвестная модель → EFFECTIVE_CAP_DEFAULT', () => {
    expect(ModelConfig.computeDisplayLimit('gemini-2.5-flash', 1)).toBe(1280);
    expect(ModelConfig.computeDisplayLimit('нет-такой-модели', null))
      .toBe(ModelConfig.EFFECTIVE_CAP_DEFAULT);
  });
});

describe('H19: интеграция — badge EMIT содержит displayLimit по оверрайду', () => {
  test('попап: модель Gemini 2.5 Flash + 50% → EMIT {contextLimit, effectiveLimit, displayLimit}', () => {
    const modelId = ModelConfig.resolvePopupModelId('gemini-2.5-flash');
    const pct = ModelConfig.resolveLimitPct(50);
    // content.js:1564-1566 — те же три поля EMIT/бейджа
    const emit = {
      contextLimit: ModelConfig.getContextLimit(modelId),
      effectiveLimit: ModelConfig.getEffectiveLimit(modelId),
      displayLimit: ModelConfig.computeDisplayLimit(modelId, pct),
      modelName: ModelConfig.getModel(modelId).name
    };
    expect(emit).toEqual({
      contextLimit: 1048576,
      effectiveLimit: 128000,
      displayLimit: 64000,
      modelName: 'Gemini 2.5 Flash'
    });
    // «Заполнение» и цвет считаются от displayLimit (семантика поповера)
    const tokens = 25600;
    const percentage = percentageOf(tokens, emit.displayLimit);
    expect(percentage).toBe(40);
    expect(percentage < 50).toBe(true); // zoneColor → зелёный (content.js:388)
  });

  test('выбор модели попапа виден в EMIT: имя и окно модели', () => {
    const modelId = ModelConfig.resolvePopupModelId('gemini-1.5-pro');
    const pct = ModelConfig.resolveLimitPct('');
    expect(ModelConfig.getModel(modelId).name).toBe('Gemini 1.5 Pro');
    expect(ModelConfig.getContextLimit(modelId)).toBe(2097152);
    expect(ModelConfig.computeDisplayLimit(modelId, pct)).toBe(128000);
  });

  test('core реально читает оба ключа попапа и делегирует расчёт оверрайду', () => {
    const src = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain("chrome.storage.sync.get(['selectedModel', 'customLimit']");
    expect(src).toContain('aiCmLoadPopupOverrides();');
    expect(src).toContain('ModelConfig.computeDisplayLimit(modelId, aiCmActivePct())');
    expect(src).toContain('const raw = popupModelId || uiRaw || rawSnapshot');
    expect(src).toContain('if (changes.selectedModel || changes.customLimit)');
  });

  test('контракт badge-EMIT/виджета не изменён (те же литералы)', () => {
    const src = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain("'[AI CM][trace] badge-update pct=' + percentage + '% tokens=' + tokens + ' model=' + modelName");
    expect(src).toContain('updateWidget(percentage, maxTokenCount, effectiveLimit, contextLimit, displayLimit, ModelConfig.getModel(modelId)?.name || modelId, netAttachBreak);');
    expect(src).toContain('limit: displayLimit,');
    expect(src).toContain('const percentage = displayLimit > 0 ? Math.round((maxTokenCount / displayLimit) * 1000) / 10 : 0;');
    expect(src).toContain("function zoneColor(p) { if (p < 50) return '#22c55e'; if (p < 80) return '#eab308'; return '#ef4444'; }");
  });
});

describe('H19 (г): дефолтный путь байтово идентичен', () => {
  const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-pro', 'gpt-4', 'gpt-4o', 'deepseek-v3', 'claude-sonnet-4-6', 'turbo'];

  test('«Автоопределение» + пустое поле → displayLimit = Авто-порог', () => {
    MODELS.forEach((m) => {
      expect(ModelConfig.computeDisplayLimit(m, null)).toBe(legacyDisplayLimit(m, null));
    });
  });

  test('поле = 100 → тот же Авто-порог (байтово)', () => {
    MODELS.forEach((m) => {
      expect(ModelConfig.computeDisplayLimit(m, ModelConfig.resolveLimitPct(100))).toBe(legacyDisplayLimit(m, null));
    });
  });

  test('поле = 100 трактуется как «Авто» и в UI-тексте (aiCmActivePct → null)', () => {
    const src = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain('popupLimitPct > 0 && popupLimitPct !== 100');
  });

  test('per-service порог виджета (safePct) считается 1:1 прежней формулой', () => {
    const pcts = [1, 10, 50, 99.9, 100, 2000];
    MODELS.forEach((m) => {
      pcts.forEach((p) => {
        expect(ModelConfig.applyLimitPct(ModelConfig.getEffectiveLimit(m), p)).toBe(legacyDisplayLimit(m, p));
      });
    });
  });

  test('«Заполнение» дефолтного пути: tokens/Auto — как раньше', () => {
    const eff = ModelConfig.getEffectiveLimit('gemini-2.5-flash');
    expect(percentageOf(25600, ModelConfig.computeDisplayLimit('gemini-2.5-flash', null)))
      .toBe(percentageOf(25600, eff));
    expect(percentageOf(25600, ModelConfig.computeDisplayLimit('gemini-2.5-flash', null))).toBe(20);
  });
});

describe('H19: options — поле «Лимит контекста» = % от Авто', () => {
  test('разметка: min=1 max=100 step=1 и подсказка про цвета/%', () => {
    const html = fs.readFileSync(OPTIONS_HTML, 'utf8');
    expect(html).toContain('id="custom-limit"');
    expect(html).toContain('min="1" max="100" step="1"');
    expect(html).not.toContain('min="1000" max="10000000"');
    expect(html).toContain('цвета и % считаются от этого порога');
  });

  test('options.js пишет selectedModel/customLimit в chrome.storage.sync', () => {
    const src = fs.readFileSync(OPTIONS_JS, 'utf8');
    expect(src).toContain("chrome.storage.sync.get(['selectedModel', 'customLimit', 'showWidget']");
    expect(src).toContain('chrome.storage.sync.set({ selectedModel: modelSelect.value });');
    expect(src).toContain('chrome.storage.sync.set({ customLimit: value });');
  });

  describe('jsdom: ввод в попапе → sync.customLimit', () => {
    function setupDom() {
      const ids = [
        'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent',
        'model-select', 'custom-limit', 'show-widget', 'api-key', 'toggle-api-key',
        'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
        'export-hint', 'stale-warning', 'export-diag', 'reset-limit',
        'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
        'aiCmProactive', 'aiCmProactiveNotify',
        'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh'
      ];
      ids.forEach(function (id) {
        const el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
      });
      const versionEl = document.createElement('span');
      versionEl.className = 'version';
      document.body.appendChild(versionEl);
    }

    function createChromeMock(initialSync) {
      const syncSets = [];
      return {
        chrome: {
          runtime: {
            getManifest: function () { return { version: '1.15.2' }; },
            getURL: function () { return 'print.html'; },
            lastError: null,
            sendMessage: function () { }
          },
          storage: {
            sync: {
              get: function (keys, cb) { cb(Object.assign({}, initialSync || {})); },
              set: function (obj) { syncSets.push(Object.assign({}, obj)); }
            },
            local: {
              get: function (keys, cb) { cb({}); },
              set: function () { },
              remove: function () { }
            },
            session: {
              get: function () { return Promise.resolve({}); },
              set: function () { return Promise.resolve(); },
              remove: function () { return Promise.resolve(); }
            },
            onChanged: { addListener: function () { } }
          },
          tabs: {
            query: function (q, cb) { cb([]); },
            create: function () { },
            sendMessage: function (a, b, cb) { if (typeof cb === 'function') cb(undefined); }
          }
        },
        syncSets: syncSets
      };
    }

    beforeEach(() => {
      jest.useFakeTimers(); // H20: поле лимита пишется по дебаунсу 500мс
      jest.resetModules();
      document.body.innerHTML = '';
      setupDom();
      window.AiCmExportBuilders = require('../utils/export-text-builders.js');
      window.buildReferenceText = require('../utils/buildReferenceText.js');
    });

    afterEach(() => { delete global.chrome; jest.useRealTimers(); });

    test('ввод 50 → sync.set({customLimit: 50}) (после дебаунса H20)', () => {
      const m = createChromeMock({});
      global.chrome = m.chrome;
      require('../options/options.js');
      const el = document.getElementById('custom-limit');
      el.value = '50';
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
      expect(m.syncSets.filter(function (o) { return 'customLimit' in o; })).toHaveLength(0); // H20: не мгновенно
      jest.advanceTimersByTime(600);
      const last = m.syncSets[m.syncSets.length - 1];
      expect(last.customLimit).toBe(50);
    });

    test('сохранённое значение загружается в поле; выбор модели → sync.set({selectedModel})', () => {
      const m = createChromeMock({ selectedModel: 'gemini-1.5-pro', customLimit: 50 });
      global.chrome = m.chrome;
      require('../options/options.js');
      expect(String(document.getElementById('custom-limit').value)).toBe('50');
      const sel = document.getElementById('model-select');
      expect(sel.value).toBe('gemini-1.5-pro');
      sel.value = 'auto';
      sel.dispatchEvent(new window.Event('change', { bubbles: true }));
      const last = m.syncSets[m.syncSets.length - 1];
      expect(last.selectedModel).toBe('auto');
    });

    test('кнопка «Авто» очищает поле → sync.set({customLimit: null})', () => {
      const m = createChromeMock({ customLimit: 50 });
      global.chrome = m.chrome;
      require('../options/options.js');
      const btn = document.getElementById('reset-limit');
      btn.dispatchEvent(new window.Event('click', { bubbles: true }));
      const last = m.syncSets[m.syncSets.length - 1];
      expect(last.customLimit).toBeNull();
      expect(String(document.getElementById('custom-limit').value)).toBe('');
    });
  });
});

describe('H19: «НЕ трогать» — гейты/оракулы/виджет-EMIT на месте', () => {
  test('core: автоэкспорт-гейты, deferred-запись истории, tape/floor-обвязка', () => {
    const src = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain('function maybeAutoExport(');
    expect(src).toContain('shouldSkipAutoExport');
    expect(src).toContain('function aiCmWriteCurrentHistory()');
    expect(src).toContain('function maybeTrimExport(cid)');
    expect(src).toContain('GeminiTapeStore');
    expect(src).toContain('aiCmBaseConfirmedByConv');
    expect(src).toContain('computeEffectiveLimit(lastResolvedModelId)');
  });

  test('export-emit-pipeline: чистые функции экспорта не изменены', () => {
    const P = require('../utils/export-emit-pipeline.js');
    expect(P.shouldSkipAutoExport({ enabled: false }).skip).toBe(true);
    expect(P.effectiveAutoExportThreshold(90, 50)).toBe(50);
    expect(P.pickExportSource(true, true)).toBe('network');
  });
});
