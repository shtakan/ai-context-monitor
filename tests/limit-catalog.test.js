'use strict';

/**
 * 2.2 / фаза 5, шаг 1: каталог LimitModel по платформам/планам.
 *
 * Проверяем три факта по отдельности: окно модели, порог показа, лимит
 * аккаунта. Каталог не имеет права выдавать тарифное значение за окно модели
 * и не подставляет 128k туда, где это не подтверждено.
 */

const {
  LIMIT_CATALOG,
  normalizeLimitSite,
  normalizeLimitPlan,
  lookupLimitCatalog
} = require('../utils/metrics/limit-catalog.ts');
const { resolveLimitModel } = require('../utils/metrics/limits.ts');

describe('limit-catalog: нормализация площадок и тарифов', () => {
  test('хост/URL сводятся к site id, неизвестное не теряется', function () {
    expect(normalizeLimitSite('https://gemini.google.com/app/abc')).toBe('gemini');
    expect(normalizeLimitSite('chat.qwen.ai')).toBe('qwen');
    expect(normalizeLimitSite('GSA')).toBe('google_search');
    expect(normalizeLimitSite('example.ai')).toBe('example.ai');
    expect(normalizeLimitSite('')).toBeNull();
  });

  test('Gemini: plus/pro — это AI Plus/AI Pro; у ChatGPT plus остаётся plus', function () {
    expect(normalizeLimitPlan('AI Plus', 'gemini')).toBe('ai-plus');
    expect(normalizeLimitPlan('pro', 'gemini')).toBe('ai-pro');
    expect(normalizeLimitPlan('advanced', 'gemini')).toBe('ai-pro');
    expect(normalizeLimitPlan('Plus', 'chatgpt')).toBe('plus');
    expect(normalizeLimitPlan('  ', 'gemini')).toBeNull();
  });
});

describe('limit-catalog: подтверждённые лимиты платформ', () => {
  test('Gemini Free: окно 1M, лимит плана 32K, порог показа 128K', function () {
    const hit = lookupLimitCatalog({ site: 'gemini', plan: 'free', modelId: 'gemini-3.6-flash' });
    expect(hit.site).toBe('gemini');
    expect(hit.plan).toBe('free');
    expect(hit.modelWindow).toBe(0);
    expect(hit.siteWindow).toBe(1048576);
    expect(hit.accountLimit).toBe(32768);
    expect(hit.displayThreshold).toBe(128000);
    expect(hit.found).toEqual({ site: true, plan: true, model: false });
    expect(hit.hasPlans).toBe(true);
  });

  test('Gemini AI Plus = 128K, AI Pro = 1M', function () {
    expect(lookupLimitCatalog({ site: 'gemini', plan: 'ai-plus' }).accountLimit).toBe(128000);
    expect(lookupLimitCatalog({ site: 'gemini', plan: 'ai-pro' }).accountLimit).toBe(1048576);
  });

  test('Gemini 3.1 Pro: каталог возвращает API-окно 1M, а не тарифные 128K', function () {
    const hit = lookupLimitCatalog({ site: 'gemini', modelId: 'gemini-3.1-pro' });
    expect(hit.modelWindow).toBe(1048576);
    expect(hit.siteWindow).toBe(1048576);
    expect(hit.found.model).toBe(true);
    expect(hit.note).toContain('веб-окно задаёт тариф');
  });

  test('неизвестный тариф: лимит null, а не 128K по умолчанию', function () {
    const hit = lookupLimitCatalog({ site: 'gemini', modelId: 'gemini-3.6-flash' });
    expect(hit.plan).toBeNull();
    expect(hit.accountLimit).toBeNull();
    expect(hit.found.plan).toBe(false);
    expect(hit.displayThreshold).toBe(128000);
  });

  test('неизвестная площадка: ничего не выдумывает', function () {
    const hit = lookupLimitCatalog({ site: 'example.ai', plan: 'pro', modelId: 'x' });
    expect(hit.modelWindow).toBe(0);
    expect(hit.siteWindow).toBe(0);
    expect(hit.accountLimit).toBeNull();
    expect(hit.displayThreshold).toBe(0);
    expect(hit.found).toEqual({ site: false, plan: false, model: false });
    expect(hit.hasPlans).toBe(false);
  });

  test('каталог не мутируется запросами', function () {
    const before = JSON.stringify(LIMIT_CATALOG.gemini);
    lookupLimitCatalog({ site: 'gemini', plan: 'free', modelId: 'gemini-3.1-pro' });
    lookupLimitCatalog({ site: 'gemini', plan: 'ai-pro' });
    expect(JSON.stringify(LIMIT_CATALOG.gemini)).toBe(before);
  });
});

describe('limits: API → каталог → настройки → fallback', () => {
  test('Gemini Free: окно 1M, лимит 32K, порог = min(окно, лимит)', function () {
    const model = resolveLimitModel({
      site: 'gemini',
      plan: 'free',
      modelId: 'gemini-3.1-pro',
      modelWindow: 128000,
      windowSource: 'catalog'
    });
    expect(model.modelWindow).toBe(1048576);
    expect(model.windowKnown).toBe(true);
    expect(model.accountLimit).toBe(32768);
    expect(model.displayLimit).toBe(32768);
    expect(model.plan).toBe('free');
    expect(model.sources).toEqual(['catalog']);
    expect(model.provenance).toEqual({
      modelWindow: 'catalog',
      displayLimit: 'catalog',
      accountLimit: 'catalog',
      plan: 'api'
    });
    expect(model.warnings).toEqual([]);
  });

  test('legacy-порог 128K не заслоняет тариф Free 32K', function () {
    const model = resolveLimitModel({
      site: 'gemini',
      plan: 'free',
      modelId: 'gemini-3.1-pro',
      displayLimit: 128000,
      displaySource: 'fallback'
    });
    expect(model.displayLimit).toBe(32768);
    expect(model.provenance && model.provenance.displayLimit).toBe('catalog');
    expect(model.warnings).toEqual([]);
  });

  test('Gemini без тарифа: окно 1M, порог показа 128K, лимит аккаунта неизвестен', function () {
    const model = resolveLimitModel({
      site: 'gemini',
      modelId: 'gemini-3.6-flash',
      modelWindow: 1048576,
      windowSource: 'catalog'
    });
    expect(model.modelWindow).toBe(1048576);
    expect(model.accountLimit).toBeNull();
    expect(model.displayLimit).toBe(128000);
    expect(model.provenance).toEqual({
      modelWindow: 'catalog',
      displayLimit: 'catalog',
      accountLimit: null,
      plan: null
    });
    expect(model.warnings).toEqual(['plan-unknown', 'account-limit-unknown']);
    expect(model.sourceNote).toContain('окно веба зависит от тарифа');
  });

  test('API-окно главнее каталога, даже для Gemini 3.1 Pro', function () {
    const model = resolveLimitModel({
      site: 'gemini',
      plan: 'free',
      modelId: 'gemini-3.1-pro',
      modelWindow: 2000000,
      windowSource: 'api'
    });
    expect(model.modelWindow).toBe(2000000);
    expect(model.displayLimit).toBe(32768);
    expect(model.sources).toEqual(['api', 'catalog']);
  });

  test('ручной порог показа главнее min(окно, лимит)', function () {
    const model = resolveLimitModel({
      site: 'gemini',
      plan: 'free',
      modelId: 'gemini-3.1-pro',
      displayLimit: 64000,
      displaySource: 'settings'
    });
    expect(model.modelWindow).toBe(1048576);
    expect(model.accountLimit).toBe(32768);
    expect(model.displayLimit).toBe(64000);
    expect(model.provenance && model.provenance.displayLimit).toBe('settings');
    expect(model.sources).toEqual(['catalog', 'settings']);
  });

  test('API-лимит плана главнее тарифного каталога', function () {
    const model = resolveLimitModel({
      site: 'gemini',
      plan: 'free',
      accountLimit: 64000,
      accountSource: 'api'
    });
    expect(model.accountLimit).toBe(64000);
    expect(model.displayLimit).toBe(64000);
    expect(model.sources).toEqual(['catalog', 'api']);
  });

  test('GSA: окно 1M и порог 128K — разные подписи; тарифного ключа нет', function () {
    const model = resolveLimitModel({
      site: 'google_search',
      modelId: 'gemini-search-default',
      modelWindow: 1048576,
      windowSource: 'catalog'
    });
    expect(model.modelWindow).toBe(1048576);
    expect(model.accountLimit).toBeNull();
    expect(model.displayLimit).toBe(128000);
    expect(model.warnings).toEqual(['account-limit-unknown']);
  });

  test('Qwen 1M: окно и порог не подменяются на 128K', function () {
    const model = resolveLimitModel({
      site: 'qwen',
      modelId: 'qwen3.8-max',
      modelWindow: 1000000,
      windowSource: 'catalog'
    });
    expect(model.modelWindow).toBe(1000000);
    expect(model.displayLimit).toBe(1000000);
    expect(model.provenance && model.provenance.displayLimit).toBe('catalog');
  });

  test('Claude: capExempt-модель считает от окна, обычная — от порога 128K', function () {
    const sonnet = resolveLimitModel({ site: 'claude', modelId: 'claude-sonnet-5-5', modelWindow: 1000000 });
    expect(sonnet.displayLimit).toBe(1000000);
    const haiku = resolveLimitModel({ site: 'claude', modelId: 'claude-haiku-4-5', modelWindow: 200000 });
    expect(haiku.displayLimit).toBe(128000);
    expect(haiku.provenance && haiku.provenance.displayLimit).toBe('catalog');
  });

  test('порог модели 0 отменяет порог площадки, не отменяя окно', function () {
    const qwen = lookupLimitCatalog({ site: 'qwen', modelId: 'qwen3.8-max' });
    expect(qwen.modelWindow).toBe(1000000);
    expect(qwen.displayThreshold).toBe(0);
    const claude = lookupLimitCatalog({ site: 'claude', modelId: 'claude-haiku-4-5' });
    expect(claude.displayThreshold).toBe(128000);
  });

  test('DeepSeek: V4.1 — 1M, V3 — 128K; площадка не режет оба одним порогом', function () {
    const v4 = resolveLimitModel({ site: 'deepseek', modelId: 'deepseek-v4.1-flash' });
    expect(v4.modelWindow).toBe(1000000);
    expect(v4.displayLimit).toBe(1000000);
    const v3 = resolveLimitModel({ site: 'deepseek', modelId: 'deepseek-v3' });
    expect(v3.modelWindow).toBe(128000);
    expect(v3.displayLimit).toBe(128000);
  });

  test('полный fallback: число есть, но окно помечено неизвестным', function () {
    const model = resolveLimitModel({ fallbackLimit: 128000 });
    expect(model.modelWindow).toBe(128000);
    expect(model.windowKnown).toBe(false);
    expect(model.displayLimit).toBe(128000);
    expect(model.sources).toEqual(['fallback']);
    expect(model.provenance && model.provenance.modelWindow).toBeNull();
    expect(model.warnings).toEqual(['window-unknown', 'fallback-display', 'account-limit-unknown']);
  });

  test('совместимость: явный порог без источника считается настройками', function () {
    const model = resolveLimitModel({ modelWindow: 1048576, displayLimit: 128000 });
    expect(model.displayLimit).toBe(128000);
    expect(model.provenance && model.provenance.displayLimit).toBe('settings');
  });
});
