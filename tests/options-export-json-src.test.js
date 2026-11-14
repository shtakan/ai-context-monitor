/**
 * v1.9 (canonical): ручной JSON-экспорт options/options.js обязан нести `src`
 * (dom|net|max) тем же значением, что шапка MD и снимок истории. Без этого
 * живая приёмка «одно число в шапке и теле» не проверяема по JSON-файлу.
 *
 * Тест поведенческий: поднимает реальный options/options.js в jsdom-стенде
 * экспортных кнопок и зовёт его buildJsonText (UMD-экспорт для тестов).
 */

'use strict';

const { openOptionsExportGate, setupDom, setupChrome } = require('./helpers/options-export-gate');
const { loadOptions } = require('./helpers/load-options.js');
const { loadEsmGlobal } = require('./helpers/load-esm.js');

function loadExportModule() {
  openOptionsExportGate({ history: null });
  return loadOptions();
}

describe('v1.9: src в ручном JSON-экспорте', function () {
  test('src попадает в JSON, когда снимок его несёт', function () {
    const mod = loadExportModule();
    const json = JSON.parse(mod.buildJsonText({
      site: 'qwen', model: 'Qwen3.8-Max',
      tokens: 218359, limit: 1000000, percent: 21.8,
      src: 'dom',
      messages: [{ role: 'user', text: 'привет' }]
    }));
    expect(json.src).toBe('dom');
    expect(json.tokens).toBe(218359);
    expect(json.messages).toHaveLength(1);
  });

  test('без src ключ отсутствует (JSON.stringify опускает undefined)', function () {
    const mod = loadExportModule();
    const json = JSON.parse(mod.buildJsonText({
      site: 'qwen', tokens: 1, limit: 100, percent: 1, messages: []
    }));
    expect(Object.prototype.hasOwnProperty.call(json, 'src')).toBe(false);
  });

  test('без аргумента platform берётся из того же cachedHistory', function () {
    document.body.innerHTML = '';
    setupDom();
    setupChrome({
      host: 'gemini.google.com',
      tabUrl: 'https://gemini.google.com/app/x',
      history: {
        site: 'gemini', host: 'gemini.google.com', model: 'Gemini 2.5 Pro',
        tokens: 1, limit: 100, percent: 1,
        messages: [{ role: 'user', text: 'привет' }]
      }
    });
    window.AiCmExportBuilders = loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
    const mod = loadOptions();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(JSON.parse(mod.buildJsonText()).platform).toBe('gemini');
  });
});
