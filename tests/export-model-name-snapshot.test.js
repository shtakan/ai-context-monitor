'use strict';

/**
 * BUG-20: модель в ручном JSON и авто-файле берётся из ТОГО ЖЕ снимка,
 * что у бейджа (lastTokensSnapshot.modelName), а не из раннего
 * lastSnapshotModelName / каталога lastResolvedModelId.
 */

const { moduleSource } = require('./helpers/content-source.js');
const loadEsm = require('./helpers/load-esm.js');
const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');

describe('BUG-20: model из снимка бейджа', () => {
  test('ручной снимок предпочитает modelName зафиксированного снимка', function () {
    const content = moduleSource('content.ts');
    expect(content).toContain('model: (snapPartMan && snapPartMan.modelName) ? snapPartMan.modelName :');
    // старый источник остаётся фолбэком, а не единственным
    expect(content).toContain('lastSnapshotModelName || (lastResolvedModelId');
  });

  test('авто-файл предпочитает modelName того же snapR1Auto', function () {
    const mgr = moduleSource('export-manager.ts');
    expect(mgr).toContain('model: (snapR1Auto && snapR1Auto.modelName) ? snapR1Auto.modelName :');
    expect(mgr).toContain("ModelConfig.getModel(lastResolvedModelId || '')?.name");
  });

  test('JSON-сборщик печатает переданную модель без пересчёта', function () {
    const doc = JSON.parse(Builders.buildJsonFromHistory({
      model: 'Gemini 4 Hydrogen',
      messages: [{ role: 'user', text: 'q' }]
    }, 'aistudio'));
    expect(doc.model).toBe('Gemini 4 Hydrogen');
    expect(doc.platform).toBe('aistudio');
  });
});
