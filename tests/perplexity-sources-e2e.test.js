'use strict';

/**
 * BUG-08/фаза 4: источники Perplexity — данные, а не [source] в тексте.
 * Сквозная проверка: parser → normalizeExportMessages → aiCmDedupeExportSource
 * (не-Gemini ветка) → buildJson/Md.
 */

const fs = require('fs');
const path = require('path');
const { parsePerplexityThread } = require('../utils/perplexity-parser.ts');
const P = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.ts');
const Builders = require('./helpers/load-esm.js').loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
const BASE = require('./helpers/content-source.js').moduleSource('base-handler.ts');

function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

const dedupe = new Function('ctx',
  'with (ctx) { ' + fnDecl(BASE, 'aiCmDedupeExportSource') + '\n return aiCmDedupeExportSource; }')({
  currentAdapter: { siteName: 'perplexity' },
  swallow: function () { },
  debugLog: function () { }
});

describe('Perplexity sources: сквозной путь', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'perplexity-thread.json'), 'utf8'));

  test('parser отдаёт sources, в text нет [source]', function () {
    const parsed = parsePerplexityThread(fixture);
    expect(parsed.messages[1].text).toBe('Синтетический ответ один.');
    expect(parsed.messages[1].text).not.toContain('[source]');
    expect(parsed.messages[1].sources).toEqual([
      { title: 'Синтетический источник', url: 'https://example.com/1', snippet: 'Синтетический сниппет источника.' }
    ]);
  });

  test('normalize + dedupe сохраняют sources (не-Gemini ветка)', function () {
    const parsed = parsePerplexityThread(fixture);
    const normalized = P.normalizeExportMessages(parsed.messages);
    const kept = dedupe(normalized).messages;
    expect(kept[1].text).toBe('Синтетический ответ один.');
    expect(kept[1].sources).toEqual(parsed.messages[1].sources);
  });

  test('buildJson/Md печатают sources, тело без [source]', function () {
    const parsed = parsePerplexityThread(fixture);
    const kept = dedupe(P.normalizeExportMessages(parsed.messages)).messages;
    const h = { site: 'perplexity', model: 'Sonar', tokens: 10, limit: 1000, percent: 1, messages: kept };
    const json = JSON.parse(Builders.buildJsonFromHistory(h, 'Perplexity'));
    expect(json.sources).toEqual([
      { title: 'Синтетический источник', url: 'https://example.com/1', snippet: 'Синтетический сниппет источника.' },
      { title: 'Второй источник', url: 'https://example.com/2', snippet: 'Сниппет второго источника.' },
      { title: 'Третий источник', url: 'https://example.com/3', snippet: 'Сниппет третьего источника.' }
    ]);
    expect(json.messages[1].sources).toBeUndefined();
    expect(json.messages[3].sources).toBeUndefined();
    const md = Builders.buildMdFromHistory(h, 'Perplexity');
    expect(md).not.toContain('[source]');
    expect(md).toContain('## SOURCES');
    expect(md).toContain('[Синтетический источник](https://example.com/1)');
  });
});
