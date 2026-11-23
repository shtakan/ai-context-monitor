'use strict';

/**
 * Gemini web «Авто»: конкретная модель не выбрана. Расширение не должно подставлять
 * старый дефолт «Gemini 2.5 Pro» — для режима Auto есть отдельная запись каталога,
 * а siteDefaults Gemini указывает на неё.
 */

const { ModelConfig } = require('./helpers/load-esm.js').loadEsmModule('utils/model-config.ts');

describe('Gemini (Авто) в каталоге моделей', () => {
  test('запись gemini-auto: имя, окно и порог', () => {
    const m = ModelConfig.getModel('gemini-auto');
    expect(m).not.toBeNull();
    expect(m.name).toBe('Gemini (Авто)');
    expect(ModelConfig.getContextLimit('gemini-auto')).toBe(1048576);
    expect(ModelConfig.getEffectiveLimit('gemini-auto')).toBe(128000);
  });

  test('siteDefaults Gemini остаётся прежним (авто — только явный UI-сигнал)', () => {
    expect(ModelConfig.getDefaultModel('gemini')).toBe('gemini-2.5-flash');
  });

  test('countTokens для auto идёт на актуальный API-слаг', () => {
    expect(ModelConfig.getGeminiApiModelId('gemini-auto')).toBe('gemini-flash-latest');
  });
});
