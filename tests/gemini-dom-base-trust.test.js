'use strict';

/**
 * Новый чат Gemini: loader подтвердил `no-older-history` → видимая DOM-лента = весь чат.
 * `aiCmTryGeminiDomBase` поднимает её как обычную базу, чтобы бейдж/попап/экспорт
 * работали без F5. Проверяем поведение на реальном срезе core/content.ts.
 */

const { moduleSource } = require('./helpers/content-source.js');

const SRC = moduleSource('content.ts');

function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('нет function ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced ' + name);
}

function run(over) {
  const messages = over && over.messages !== undefined ? over.messages : [
    { role: 'user', content: 'Вопрос нового чата' },
    { role: 'assistant', content: 'Ответ нового чата' }
  ];
  const ctx = {
    baseSeen: false,
    baseComplete: false,
    baseCount: 0,
    baseText: '',
    currentAdapter: {
      siteName: 'gemini',
      extractMessages: function () { return messages; }
    },
    getCurrentConvId: function () { return 'cid-new'; },
    aiCmGeminiDomBaseTrusted: { 'cid-new': true },
    aiCmBasePrepared: null,
    lastBaseTexts: [],
    lastBaseIds: [],
    lastDetailMessages: null,
    aiCmBaseSource: '',
    aiCmBaseConfirmedByConv: {},
    aiCmAdapterBaseCount: 0,
    canonicalBodyText: function (list) { return list.map(function (m) { return m.text; }).join('\n'); },
    debugLog: function () { },
    swallowSoft: function () { }
  };
  Object.assign(ctx, (over && over.ctx) || {});
  const fn = new Function('ctx', 'with (ctx) {\n' + fnDecl(SRC, 'aiCmTryGeminiDomBase') + '\nreturn aiCmTryGeminiDomBase();\n}')(ctx);
  return { ret: fn, ctx: ctx };
}

describe('Gemini: DOM-база нового чата (no-older-history)', () => {
  test('подтверждённый короткий чат становится базой', () => {
    const r = run({});
    expect(r.ret).toBe(true);
    expect(r.ctx.baseSeen).toBe(true);
    expect(r.ctx.baseComplete).toBe(true);
    expect(r.ctx.baseCount).toBe(2);
    expect(r.ctx.baseText).toBe('Вопрос нового чата\nОтвет нового чата');
    expect(r.ctx.aiCmBaseConfirmedByConv['cid-new']).toBe(1);
    expect(r.ctx.aiCmAdapterBaseCount).toBe(2);
    expect(r.ctx.aiCmBasePrepared.map(function (m) { return m.text; })).toEqual([
      'Вопрос нового чата', 'Ответ нового чата'
    ]);
  });

  test('без сигнала loader база НЕ поднимается', () => {
    const r = run({ ctx: { aiCmGeminiDomBaseTrusted: {} } });
    expect(r.ret).toBe(false);
    expect(r.ctx.baseSeen).toBe(false);
  });

  test('длинная лента (>20) не считается полным чатом', () => {
    const many = [];
    for (let i = 0; i < 21; i++) many.push({ role: i % 2 ? 'assistant' : 'user', content: 'ход ' + i });
    const r = run({ messages: many });
    expect(r.ret).toBe(false);
    expect(r.ctx.baseSeen).toBe(false);
  });

  test('пустая лента и не-Gemini — отказ', () => {
    expect(run({ messages: [] }).ret).toBe(false);
    expect(run({ ctx: { currentAdapter: { siteName: 'chatgpt', extractMessages: function () { return [{ role: 'user', content: 'x' }]; } } } }).ret).toBe(false);
  });
});
