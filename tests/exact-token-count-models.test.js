// Тесты: точный подсчёт токенов — миграция на живые API-id (09.2026).
const path = require('path');
const fs = require('fs');
const ModelConfig = require('../utils/model-config.js');

const ROOT = path.join(__dirname, '..');
const BG_SRC = fs.readFileSync(path.join(ROOT, 'core', 'background.js'), 'utf8');
const MC_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'model-config.js'), 'utf8');

function extractCandidates() {
  const m = BG_SRC.match(/var rawCandidates = \[([^\]]+)\]/);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/['"]/g, '').replace(/lastGoodModel/g, '<LGM>'));
}
function resolveChain(raw, lastGoodModel, model) {
  var candidates = [];
  raw.forEach(c => {
    var v = c === '<LGM>' ? (lastGoodModel || '') : (c === 'model' ? model : c);
    if (v && candidates.indexOf(v) === -1) candidates.push(v);
  });
  return candidates;
}

describe('Точный подсчёт токенов: миграция на живые API-id', () => {
  test('getGeminiApiModelId: дефолт → gemini-flash-latest', () => {
    expect(ModelConfig.getGeminiApiModelId(null)).toBe('gemini-flash-latest');
    expect(ModelConfig.getGeminiApiModelId(undefined)).toBe('gemini-flash-latest');
    expect(ModelConfig.getGeminiApiModelId('')).toBe('gemini-flash-latest');
  });

  test('getGeminiApiModelId: детект-слаги 3.x passthrough', () => {
    expect(ModelConfig.getGeminiApiModelId('gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite');
    expect(ModelConfig.getGeminiApiModelId('gemini-3.5-flash')).toBe('gemini-3.5-flash');
    expect(ModelConfig.getGeminiApiModelId('gemini-3-flash')).toBe('gemini-3-flash');
  });

  test('мапа: 1.5/2.0-семейства убраны, 2.5 и search-default сохранены/мигрированы', () => {
    expect(MC_SRC).not.toMatch(/var map = \{[\s\S]*?'gemini-1\.5-pro':/);
    expect(MC_SRC).not.toMatch(/var map = \{[\s\S]*?'gemini-1\.5-flash':/);
    expect(MC_SRC).not.toMatch(/var map = \{[\s\S]*?'gemini-2\.0-flash':/);
    expect(MC_SRC).not.toMatch(/var map = \{[\s\S]*?'gemini-2\.0-pro':/);
    expect(ModelConfig.getGeminiApiModelId('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(ModelConfig.getGeminiApiModelId('gemini-search-default')).toBe('gemini-flash-latest');
    expect(MC_SRC).not.toMatch(/return 'gemini-1\.5-pro'/);
  });

  test('background.js: дефолт model и цепочка кандидатов', () => {
    expect(BG_SRC).toContain("var model = message.model || 'gemini-flash-latest';");
    expect(extractCandidates()).toEqual(['<LGM>', 'model', 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash']);
  });

  test('НЕ трогать: endpoint/заголовки/эвристика/гейт', () => {
    expect(BG_SRC).toContain('/v1beta/models/');
    expect(BG_SRC).toContain("'x-goog-api-key': apiKey");
    expect(BG_SRC).toContain("return { error: 'all_models_failed' };");
    const contentSrc = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
    expect(contentSrc).toMatch(/exactCountEnabled[\s\S]{0,160}baseComplete/);
  });

  test('баг-сценарий: 404 на deprecated → успех на gemini-flash-latest, lastGoodModel кэш', async () => {
    var raw = extractCandidates();
    var lastGoodModel = '';
    var model = 'gemini-1.5-pro';
    var calls = [];
    global.fetch = jest.fn(function (url) {
      calls.push(url);
      if (url.indexOf('gemini-1.5-pro') !== -1 || url.indexOf('gemini-2.5-flash') !== -1) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('not found for API version v1beta') });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ totalTokens: 42 }) });
    });
    var chain = resolveChain(raw, lastGoodModel, model);
    for (var j = 0; j < chain.length; j++) {
      var cand = chain[j];
      var response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cand) + ':countTokens');
      if (response.ok) { lastGoodModel = cand; break; }
    }
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('models/gemini-1.5-pro:countTokens');
    expect(calls[1]).toContain('models/gemini-flash-latest:countTokens');
    expect(lastGoodModel).toBe('gemini-flash-latest');
    // повторный вызов: lastGoodModel первый кандидат
    expect(resolveChain(raw, lastGoodModel, model)[0]).toBe('gemini-flash-latest');
  });

  test('байтово-идентично: успех на первой модели, цепочка не проходится', async () => {
    var chain = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'];
    var calls = [];
    global.fetch = jest.fn(function () {
      calls.push(1);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ totalTokens: 7 }) });
    });
    var lastGoodModel = '';
    for (var j = 0; j < chain.length; j++) {
      var response = await fetch(chain[j] + ':countTokens');
      if (response.ok) { lastGoodModel = chain[j]; break; }
    }
    expect(calls.length).toBe(1);
    expect(lastGoodModel).toBe('gemini-flash-latest');
  });
});
