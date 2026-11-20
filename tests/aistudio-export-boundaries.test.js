'use strict';

/**
 * BUG-13 регресс: границы assistant-ответов не теряются при дедупе AI Studio.
 *
 * Раньше aiCmDedupeExportSource сначала дедуплицировал (удалял повторные user-
 * ходы), а потом склеивал подряд идущие assistant — и три разных ответа,
 * разделённые дублями user, становились одним. Теперь merge идёт ДО dedupe:
 * настоящие сегменты одного ответа склеиваются, разные ответы — нет.
 */

const CONTENT = require('./helpers/content-source.js').moduleSource('base-handler.ts');

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

const SCOPE = 'with (ctx) { ' +
  fnDecl(CONTENT, 'aiCmMergeAssistantRuns') + '\n' +
  fnDecl(CONTENT, 'aiCmDedupeExportSource') + '\n' +
  ' return { dedupe: aiCmDedupeExportSource, merge: aiCmMergeAssistantRuns }; }';
const makeApi = new Function('ctx', SCOPE);

/** Простой дедуп, повторяющий контракт prepareExportMessages для ролей/текста. */
function prepareExportMessages(messages) {
  const out = [];
  const seen = {};
  for (const m of messages) {
    const role = (m.role === 'user' || m.role === 'human') ? 'user' : 'assistant';
    const text = String(m.text == null ? '' : m.text);
    const key = role + '\u0000' + text.replace(/\s+/g, ' ').trim();
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ role, text });
  }
  return { messages: out, removed: messages.length - out.length };
}

function apiFor() {
  return makeApi({
    currentAdapter: { siteName: 'aistudio' },
    AiCmExportEmitPipeline: { prepareExportMessages },
    aiCmLogIntraDedupe: function () { },
    debugLog: function () { },
    swallow: function () { }
  });
}

describe('BUG-13: границы ответов AI Studio', () => {
  test('дубли user не склеивают разные assistant-ответы в один', function () {
    const { dedupe } = apiFor();
    const out = dedupe([
      { role: 'user', text: 'Продолжай' },
      { role: 'assistant', text: 'ответ 1' },
      { role: 'user', text: 'Продолжай' },
      { role: 'assistant', text: 'ответ 2' },
      { role: 'user', text: 'Продолжай' },
      { role: 'assistant', text: 'ответ 3' }
    ]).messages;
    expect(out.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'assistant', 'assistant']);
    expect(out.map(function (m) { return m.text; })).toEqual(['Продолжай', 'ответ 1', 'ответ 2', 'ответ 3']);
  });

  test('настоящие подряд идущие сегменты одного ответа склеиваются', function () {
    const { dedupe } = apiFor();
    const out = dedupe([
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: 'сегмент 1' },
      { role: 'assistant', text: 'сегмент 2' },
      { role: 'user', text: 'ещё вопрос' },
      { role: 'assistant', text: 'ответ' }
    ]).messages;
    expect(out.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out[1].text).toBe('сегмент 1\n\nсегмент 2');
  });
});
