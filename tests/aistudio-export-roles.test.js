'use strict';

/**
 * BUG-12 регресс: роли экспортной проекции берутся из снимка AI Studio,
 * а не из чётностного фолбэка (d18 % 2 / j % 2).
 *
 * Тест исполняет реальные срезы core/content.ts (aiCmApplyAistudioNetBase и
 * aiCmCollectExportSource) и чистый aistudioDetailMessages.
 */

const { aistudioDetailMessages } = require('../core/aistudio-dualrun.ts');
const CONTENT = require('./helpers/content-source.js').contentSource;

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

function makeFn(name) {
  const scope = 'with (ctx) { ' + fnDecl(CONTENT, name) + '\n return ' + name + '; }';
  return new Function('ctx', scope);
}

const makeApply = makeFn('aiCmApplyAistudioNetBase');
const makeCollect = makeFn('aiCmCollectExportSource');

describe('BUG-12: роли снимка AI Studio не теряются в проекции', () => {
  test('aistudioDetailMessages сохраняет роли, порядок и sections', function () {
    const snap = {
      msgs: [
        { role: 'user', text: 'u1' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'u2', sections: '[FILE: f]' },
        { role: 'model', text: 'a2' }
      ]
    };
    const out = aistudioDetailMessages(snap);
    expect(out.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out.map(function (m) { return m.text; })).toEqual(['u1', 'a1', 'u2[FILE: f]', 'a2']);
    expect(out).toHaveLength(4);
  });

  test('aiCmApplyAistudioNetBase синхронизирует lastDetailMessages с ролями снимка', function () {
    // Роли намеренно не чередуются: u,u,a — чётностный фолбэк дал бы u,a,u.
    const snap = {
      historyComplete: true,
      msgs: [
        { role: 'user', text: 'первый' },
        { role: 'user', text: 'второй' },
        { role: 'assistant', text: 'ответ' }
      ]
    };
    const ctx = {
      aiCmNetMsgsAistudio: snap,
      aistudioDetailMessages: aistudioDetailMessages,
      baseText: '',
      baseCount: 0,
      lastBaseTexts: null,
      lastDetailMessages: null,
      baseSeen: false,
      baseComplete: false,
      stale: true,
      swallowSoft: function () { }
    };
    makeApply(ctx)();
    expect(ctx.lastBaseTexts).toEqual(['первый', 'второй', 'ответ']);
    expect(ctx.lastDetailMessages).not.toBeNull();
    expect(ctx.lastDetailMessages.map(function (m) { return m.role; })).toEqual(['user', 'user', 'assistant']);
    expect(ctx.lastDetailMessages.map(function (m) { return m.text; })).toEqual(['первый', 'второй', 'ответ']);
    expect(ctx.baseSeen).toBe(true);
    expect(ctx.baseComplete).toBe(true);
  });

  test('aiCmCollectExportSource берёт роли из lastDetailMessages, а не по индексу', function () {
    const texts = ['u1', 'a1', 'u2', 'u3', 'a3'];
    const detail = [
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'u2' },
      { role: 'user', text: 'u3' },
      { role: 'assistant', text: 'a3' }
    ];
    const ctx = {
      baseSeen: true,
      lastBaseTexts: texts,
      lastDetailMessages: detail,
      AiCmExportEmitPipeline: {
        pickExportSource: function () { return 'network'; }
      },
      sanitizeGeminiText: function (s) { return String(s); },
      aiCmSanitizeEmitUserTexts: function (list) { return list; },
      currentAdapter: { siteName: 'aistudio' }
    };
    const out = makeCollect(ctx)();
    expect(out.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
    expect(out.map(function (m) { return m.text; })).toEqual(texts);
  });
});
