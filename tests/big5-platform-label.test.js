'use strict';

/**
 * BIG-05 (2.1.5): единая метка платформы в шапке авто- и ручного экспорта.
 * Карта вынесена в aiCmPlatformLabelForFile (core/export-manager.ts).
 */

const { moduleSource } = require('./helpers/content-source.js');

const SRC = moduleSource('export-manager.ts');

function fn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('BIG-05: в core/export-manager.ts нет function ' + name + '(');
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('BIG-05: unbalanced declaration: ' + name);
}

const label = new Function(fn('aiCmPlatformLabelForFile') + '\nreturn aiCmPlatformLabelForFile;')();

describe('BIG-05: метка платформы в экспорте', () => {
  test('все 8 платформ — человекочитаемые имена', () => {
    expect(label('chatgpt')).toBe('ChatGPT');
    expect(label('gemini')).toBe('Gemini');
    expect(label('deepseek')).toBe('DeepSeek');
    expect(label('google_search')).toBe('Google Search AI');
    expect(label('claude')).toBe('Claude');
    expect(label('perplexity')).toBe('Perplexity');
    expect(label('qwen')).toBe('Qwen');
  });

  test('неизвестный сайт — сырой id, пустой — AI Chat', () => {
    expect(label('new-site')).toBe('new-site');
    expect(label('')).toBe('AI Chat');
  });
});
