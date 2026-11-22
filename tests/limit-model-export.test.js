'use strict';

/**
 * 2.2/фаза 5: три факта лимита в файле.
 *
 * MD/JSON несут окно модели, порог показа и лимит аккаунта отдельными полями.
 * Старый снимок без новых полей не добавляет ни одного байта; null — явное
 * «лимит аккаунта неизвестен», а не 0 и не 128k.
 */

const loadEsm = require('./helpers/load-esm.js');
const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');

function baseHistory(extra) {
  return Object.assign({
    site: 'gemini',
    model: 'Gemini 3.6 Flash',
    tokens: 50000,
    limit: 128000,
    percent: 39.1,
    messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]
  }, extra || {});
}

describe('phase 5 limits in export', () => {
  test('MD: окно, порог и лимит аккаунта — тремя ASCII-строками', function () {
    const md = Builders.buildMdFromHistory(baseHistory({
      windowLimit: 1048576,
      displayLimit: 128000,
      accountLimit: 32768,
      limitPlan: 'free',
      limitWarnings: []
    }), 'Gemini');
    expect(md).toContain('model-window: 1048576');
    expect(md).toContain('display-limit: 128000');
    expect(md).toContain('account-limit: 32768');
    expect(md).toContain('limit-plan: free');
  });

  test('MD: accountLimit=null печатается как unknown, а не 0', function () {
    const md = Builders.buildMdFromHistory(baseHistory({
      windowLimit: 1048576,
      displayLimit: 128000,
      accountLimit: null,
      limitPlan: null,
      limitWarnings: ['plan-unknown', 'account-limit-unknown']
    }), 'Gemini');
    expect(md).toContain('account-limit: unknown');
    expect(md).not.toContain('account-limit: 0');
    expect(md).toContain('limit-warnings: plan-unknown,account-limit-unknown');
    expect(md).not.toContain('limit-plan:');
  });

  test('JSON: поля аддитивны; старый снимок их не получает', function () {
    const doc = JSON.parse(Builders.buildJsonFromHistory(baseHistory({
      windowLimit: 1048576,
      displayLimit: 128000,
      accountLimit: null,
      limitPlan: 'free',
      limitWarnings: ['account-limit-unknown']
    }), 'Gemini'));
    expect(doc.modelWindow).toBe(1048576);
    expect(doc.displayLimit).toBe(128000);
    expect(doc.accountLimit).toBeNull();
    expect(doc.limitPlan).toBe('free');
    expect(doc.limitWarnings).toEqual(['account-limit-unknown']);

    const oldDoc = JSON.parse(Builders.buildJsonFromHistory(baseHistory(), 'Gemini'));
    expect('modelWindow' in oldDoc).toBe(false);
    expect('displayLimit' in oldDoc).toBe(false);
    expect('accountLimit' in oldDoc).toBe(false);
    expect('limitPlan' in oldDoc).toBe(false);
    expect('limitWarnings' in oldDoc).toBe(false);
  });

  test('BIG-02: баннер платформы даёт 100% и метку context-saturated', function () {
    const saturated = baseHistory({
      tokens: 63077,
      limit: 128000,
      percent: 49.3,
      saturated: true
    });
    const md = Builders.buildMdFromHistory(saturated, 'ChatGPT');
    expect(md).toContain('(100%)');
    expect(md).toContain('context-saturated: 1');
    const doc = JSON.parse(Builders.buildJsonFromHistory(saturated, 'chatgpt'));
    expect(doc.percent).toBe(100);
    expect(doc.saturated).toBe(true);

    const plain = JSON.parse(Builders.buildJsonFromHistory(baseHistory(), 'chatgpt'));
    expect('saturated' in plain).toBe(false);
    expect(plain.percent).toBe(39.1);
  });

  test('TXT не меняется: три подписи живут в MD/JSON, а не в эталонном теле', function () {
    const plain = Builders.buildTxtFromHistory(baseHistory());
    const withLimits = Builders.buildTxtFromHistory(baseHistory({
      windowLimit: 1048576,
      displayLimit: 128000,
      accountLimit: 32768,
      limitPlan: 'free'
    }));
    expect(withLimits).toBe(plain);
  });
});
