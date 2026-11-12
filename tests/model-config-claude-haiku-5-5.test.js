'use strict';

/**
 * BUG-01: slug `claude-haiku-5-5` из веб-чата отсутствовал в каталоге, поэтому
 * resolveModelId возвращал null и core/content.ts падал в siteDefaults
 * ('claude-sonnet-4-6'): в бейдже было чужое имя и чужое окно 500 000.
 *
 * Здесь фиксируется запись каталога utils/model-config.ts и действующий порог:
 * capExempt обязателен, иначе getEffectiveLimit вернёт min(1000000, 128000).
 * Неизвестный slug по-прежнему не распознаётся — это класс BUG-02 (S3).
 */

const ModelConfig = require('./helpers/load-esm.js').loadEsm('utils/model-config.ts');

describe('claude-haiku-5-5: каталог моделей', () => {
  test('slug сводится к ключу каталога, имя — из записи', () => {
    expect(ModelConfig.resolveModelId('claude-haiku-5-5')).toBe('claude-haiku-5-5');

    const model = ModelConfig.getModel('claude-haiku-5-5');
    expect(model).not.toBeNull();
    expect(model.name).toBe('Claude Haiku 5.5');
    expect(model.provider).toBe('Anthropic');
    expect(model.contextLimit).toBe(1000000);
    expect(model.capExempt).toBe(true);
  });

  test('действующий порог — реальное окно 1M, а не EFFECTIVE_CAP_DEFAULT', () => {
    expect(ModelConfig.getEffectiveLimit('claude-haiku-5-5')).toBe(1000000);
  });

  test('неизвестный slug по-прежнему не распознаётся (класс BUG-02)', () => {
    expect(ModelConfig.resolveModelId('claude-haiku-9-9')).toBeNull();
  });
});
