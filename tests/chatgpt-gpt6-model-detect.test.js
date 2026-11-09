/**
 * ШАГ 1 (живая приёмка 2026-11-09): ChatGPT отдаёт в сети raw-слаг `gpt-6`
 * (и вариант `gpt-6-turbo`). До правки resolveModelId не находил ни точного
 * совпадения, ни префикса, ни подстроки → возвращал null, и core/content.js
 * падал в siteDefaults ('gpt-5.5'): бейдж считался от чужого окна.
 *
 * Здесь проверяется каталог utils/model-config.ts: новые ключи описаны, а
 * слаги сети сводятся к ним; соседние GPT-6 ключи (astra/sol/6.1) не сломаны —
 * точное совпадение по-прежнему важнее префикса.
 */
'use strict';

const ModelConfig = require('./helpers/load-esm.js').loadEsm('utils/model-config.ts');

describe('gpt-6: каталог моделей', () => {
  test('gpt-6 и gpt-6-turbo описаны (OpenAI, окно 1 050 000)', () => {
    const base = ModelConfig.models['gpt-6'];
    expect(base).toBeDefined();
    expect(base.name).toBe('GPT-6');
    expect(base.provider).toBe('OpenAI');
    expect(base.contextLimit).toBe(1050000);

    const turbo = ModelConfig.models['gpt-6-turbo'];
    expect(turbo).toBeDefined();
    expect(turbo.name).toBe('GPT-6 Turbo');
    expect(turbo.provider).toBe('OpenAI');
    expect(turbo.contextLimit).toBe(1050000);
  });

  test('лимит берётся из каталога, действующий порог — 128 000 (capExempt нет)', () => {
    expect(ModelConfig.getContextLimit('gpt-6')).toBe(1050000);
    expect(ModelConfig.getEffectiveLimit('gpt-6'))
      .toBe(ModelConfig.EFFECTIVE_CAP_DEFAULT);
    expect(ModelConfig.getEffectiveLimit('gpt-6-turbo'))
      .toBe(ModelConfig.EFFECTIVE_CAP_DEFAULT);
  });
});

describe('gpt-6: распознавание слагов ChatGPT', () => {
  test('сетевой слаг gpt-6 → ключ gpt-6 (регистр/подчёркивания нормализуются)', () => {
    expect(ModelConfig.resolveModelId('gpt-6')).toBe('gpt-6');
    expect(ModelConfig.resolveModelId('GPT-6')).toBe('gpt-6');
    expect(ModelConfig.resolveModelId('gpt_6')).toBe('gpt-6');
  });

  test('gpt-6-turbo не схлопывается префиксом в gpt-6', () => {
    expect(ModelConfig.resolveModelId('gpt-6-turbo')).toBe('gpt-6-turbo');
    expect(ModelConfig.resolveModelId('GPT-6-Turbo')).toBe('gpt-6-turbo');
    // суффикс версии/даты — префиксное совпадение с самым длинным ключом
    expect(ModelConfig.resolveModelId('gpt-6-turbo-2026-11')).toBe('gpt-6-turbo');
  });

  test('соседние GPT-6 ключи не сломаны: точное совпадение важнее префикса', () => {
    expect(ModelConfig.resolveModelId('gpt-6-astra')).toBe('gpt-6-astra');
    expect(ModelConfig.resolveModelId('gpt-6-sol')).toBe('gpt-6-sol');
    expect(ModelConfig.resolveModelId('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(ModelConfig.resolveModelId('gpt-5.5')).toBe('gpt-5.5');
  });

  test('мусор по-прежнему → null (новые ключи не расширили подстрочный матч)', () => {
    expect(ModelConfig.resolveModelId('zzz-нет-такого')).toBeNull();
    expect(ModelConfig.resolveModelId('')).toBeNull();
    expect(ModelConfig.resolveModelId(null)).toBeNull();
  });
});
