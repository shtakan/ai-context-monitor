'use strict';

/**
 * 2.2: messages по умолчанию для AI Studio.
 * Источник экспорта — capture() + canonicalizeBatch; дубли user остаются
 * отдельными ходами, поэтому merge-before-dedupe (BUG-13) не склеивает разные
 * ответы. Откат — sessionStorage.aiCmV2Messages='0'.
 */

const { moduleSource, contentSource } = require('./helpers/content-source.js');
const { canonicalizeBatch } = require('../utils/messages/canonicalize.ts');
const {
  aiCmV2MessagesDefaultEnabled,
  resetAistudioDualRunForTests
} = require('../core/aistudio-dualrun.ts');

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

const makeExportSource = new Function('ctx',
  'with (ctx) { ' + fnDecl(contentSource, 'aiCmV2AistudioExportSource') + '\n return aiCmV2AistudioExportSource; }');

function batch(messages) {
  return {
    v: 1,
    platform: 'aistudio',
    kind: 'net',
    convId: 'conv-1',
    routeKey: 'prompts/conv-1',
    capturedAt: 1,
    complete: true,
    messages: messages.map(function (m, i) {
      return { role: m.role, text: m.text, ordinal: i, nodeType: 'message' };
    })
  };
}

function fakeAdapter(messages) {
  const b = batch(messages);
  return { siteName: 'aistudio', capture: function () { return b; } };
}

/** Реальный aiCmDedupeExportSource (merge-before-dedupe) с простым пайплайном. */
function prepareExportMessages(messages) {
  const out = [];
  const seen = {};
  for (const m of messages) {
    const role = (m.role === 'user' || m.role === 'human') ? 'user' : 'assistant';
    const text = String(m.text == null ? '' : m.text);
    const key = role + '\u0000' + text.replace(/\s+/g, ' ').trim();
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ role: role, text: text });
  }
  return { messages: out, removed: messages.length - out.length };
}

const DEDUPE = new Function('ctx',
  'with (ctx) { ' +
  fnDecl(moduleSource('base-handler.ts'), 'aiCmMergeAssistantRuns') + '\n' +
  fnDecl(moduleSource('base-handler.ts'), 'aiCmDedupeExportSource') + '\n' +
  ' return aiCmDedupeExportSource; }')({
  currentAdapter: { siteName: 'aistudio' },
  AiCmExportEmitPipeline: { prepareExportMessages: prepareExportMessages },
  aiCmLogIntraDedupe: function () { },
  debugLog: function () { },
  swallow: function () { }
});

describe('messages default: флаг и opt-out', () => {
  test('по умолчанию включён; sessionStorage=0 выключает; =1 не меняет default', function () {
    resetAistudioDualRunForTests();
    sessionStorage.removeItem('aiCmV2Messages');
    expect(aiCmV2MessagesDefaultEnabled()).toBe(true);
    sessionStorage.setItem('aiCmV2Messages', '0');
    expect(aiCmV2MessagesDefaultEnabled()).toBe(false);
    sessionStorage.setItem('aiCmV2Messages', '1');
    expect(aiCmV2MessagesDefaultEnabled()).toBe(true);
    sessionStorage.removeItem('aiCmV2Messages');
    resetAistudioDualRunForTests();
  });
});

describe('messages default: канонический источник экспорта', () => {
  const LIVE = [
    { role: 'user', text: 'Продолжай' },
    { role: 'assistant', text: 'ответ 1' },
    { role: 'user', text: 'Продолжай' },
    { role: 'assistant', text: 'ответ 2' },
    { role: 'user', text: 'Продолжай' },
    { role: 'assistant', text: 'ответ 3' }
  ];

  test('источник = capture + canonicalize (роли и порядок)', function () {
    sessionStorage.removeItem('aiCmV2Messages');
    resetAistudioDualRunForTests();
    const src = makeExportSource({
      currentAdapter: fakeAdapter(LIVE),
      aiCmV2MessagesDefaultEnabled: function () { return true; },
      canonicalizeBatch: canonicalizeBatch,
      swallowSoft: function () { }
    })();
    expect(src.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(src.map(function (m) { return m.text; })).toEqual(['Продолжай', 'ответ 1', 'Продолжай', 'ответ 2', 'Продолжай', 'ответ 3']);
  });

  test('сетевой снимок (33) канонизируется, дубли user остаются ходами', function () {
    resetAistudioDualRunForTests();
    const ctx = {
      currentAdapter: { siteName: 'aistudio', capture: function () { throw new Error('capture must not be called'); } },
      aiCmV2MessagesDefaultEnabled: function () { return true; },
      canonicalizeBatch: canonicalizeBatch,
      canonicalizeMessages: require('../utils/messages/canonicalize.ts').canonicalizeMessages,
      aiCmNetMsgsAistudio: { msgs: LIVE.map(function (m) { return { role: m.role, text: m.text }; }), ts: 1 },
      baseComplete: true,
      aiCmHistoryConvId: function () { return 'conv-1'; },
      swallowSoft: function () { }
    };
    const out = makeExportSource(ctx)();
    expect(out).toHaveLength(6);
    expect(out.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    // downstream снимает дубли user, но не ответы
    const deduped = DEDUPE(out).messages;
    expect(deduped.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'assistant', 'assistant']);
  });

  test('merge-before-dedupe: дубли user сняты, три ответа НЕ склеены (BUG-13)', function () {
    sessionStorage.removeItem('aiCmV2Messages');
    resetAistudioDualRunForTests();
    const src = makeExportSource({
      currentAdapter: fakeAdapter(LIVE),
      aiCmV2MessagesDefaultEnabled: function () { return true; },
      canonicalizeBatch: canonicalizeBatch,
      swallowSoft: function () { }
    })();
    const out = DEDUPE(src).messages;
    expect(out.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'assistant', 'assistant']);
    expect(out.map(function (m) { return m.text; })).toEqual(['Продолжай', 'ответ 1', 'ответ 2', 'ответ 3']);
  });

  test('opt-out и чужой сайт → null, старый путь', function () {
    resetAistudioDualRunForTests();
    const off = makeExportSource({
      currentAdapter: fakeAdapter(LIVE),
      aiCmV2MessagesDefaultEnabled: function () { return false; },
      canonicalizeBatch: canonicalizeBatch,
      swallowSoft: function () { }
    })();
    expect(off).toBeNull();

    const other = makeExportSource({
      currentAdapter: { siteName: 'gemini', capture: function () { return batch(LIVE); } },
      aiCmV2MessagesDefaultEnabled: function () { return true; },
      canonicalizeBatch: canonicalizeBatch,
      swallowSoft: function () { }
    })();
    expect(other).toBeNull();
  });

  test('source: единая точка сбора спрашивает канон первой', function () {
    const mgr = moduleSource('export-manager.ts');
    const collect = fnDecl(mgr, 'aiCmCollectExportSource');
    expect(collect).toContain('aiCmV2AistudioExportSource()');
    expect(collect.indexOf('aiCmV2AistudioExportSource()'))
      .toBeLessThan(collect.indexOf("source === 'network'"));
  });
});
