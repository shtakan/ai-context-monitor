'use strict';

/**
 * BIG-02 (2.1.5): причина 'stopped' значима (не нормализуется в 'incomplete')
 * и маркер остановки распознаётся. Проверяем реальный source core/state.ts.
 */

const { moduleSource } = require('./helpers/content-source.js');

const SRC = moduleSource('state.ts');

function fn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('BIG-02: в core/state.ts нет function ' + name + '(');
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('BIG-02: unbalanced declaration: ' + name);
}

const api = new Function(
  fn('aiCmDetectStopMarker') + '\n' + fn('aiCmCommitContextSnapshot') +
  '\nreturn { stop: aiCmDetectStopMarker, commit: aiCmCommitContextSnapshot };'
)();

function snap(extra) {
  return Object.assign({
    convId: 'conv-1',
    capturedAt: 1,
    site: 'chatgpt',
    model: 'gpt-6',
    modelName: 'GPT-6',
    src: 'net',
    tokens: 100,
    percent: 1,
    limit: 1000,
    effectiveLimit: 1000,
    contextLimit: 1000,
    partial: false,
    bodyHash: 'h1'
  }, extra || {});
}

describe('BIG-02: stopped/truncated — значимые причины неполноты', () => {
  test('commit сохраняет reason=stopped', () => {
    const out = api.commit(snap(), snap({ partial: true, partialReason: 'stopped' }));
    expect(out.partial).toBe(true);
    expect(out.partialReason).toBe('stopped');
  });

  test('commit сохраняет reason=truncated', () => {
    const out = api.commit(snap(), snap({ partial: true, partialReason: 'truncated' }));
    expect(out.partialReason).toBe('truncated');
  });

  test('незначимая причина нормализуется в incomplete', () => {
    const out = api.commit(snap(), snap({ partial: true, partialReason: 'shrank' }));
    expect(out.partialReason).toBe('incomplete');
  });
});

describe('BIG-02: детектор подписи остановки', () => {
  test('ChatGPT «You stopped»', () => {
    expect(api.stop('… Если один TCP\n\nYou stopped\n\nResume')).toBe(true);
  });

  test('Claude «Вы остановили ответ Claude»', () => {
    expect(api.stop('…а там всегда полно па\n\nВы остановили ответ Claude')).toBe(true);
  });

  test('DeepSeek/Qwen «Остановлено»', () => {
    expect(api.stop('Остановлено\nПродолжить')).toBe(true);
  });

  test('обычный текст без маркера — false', () => {
    expect(api.stop('Готово. Вот ответ на ваш вопрос.')).toBe(false);
  });

  test('маркер в начале длинного текста игнорируется (смотрим хвост)', () => {
    expect(api.stop('You stopped\n' + 'x'.repeat(2000))).toBe(false);
  });
});
