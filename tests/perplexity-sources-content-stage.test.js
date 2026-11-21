'use strict';

/**
 * BUG-08/фаза 4, регресс живого PP-SOURCES-MISSING: секции сообщения обязаны
 * пережить стадию приёма сетевой базы в core/content.ts.
 *
 * Живой дефект: parser отдавал sources, но content-стадия собирала
 * preDedupe18/msgs18 заново как {role,text,id} — sources исчезали ДО dedupe
 * и до lastDetailMessages, поэтому JSON/MD/TXT получали пустые секции.
 *
 * Тест исполняет НАСТОЯЩИЙ срез core/content.ts (от var rawMsgs18 до
 * lastDetailMessages = msgs18) в песочнице с реальным aiCmDedupeExportSource.
 */

const fs = require('fs');
const path = require('path');
const { parsePerplexityThread } = require('../utils/perplexity-parser.ts');
const BASE = require('./helpers/content-source.js').moduleSource('base-handler.ts');
const CONTENT = require('./helpers/content-source.js').moduleSource('content.ts');
const MANAGER = require('./helpers/content-source.js').moduleSource('export-manager.ts');

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

const START = 'var rawMsgs18 =';
const END = 'lastDetailMessages = msgs18;';

function stageBlock() {
  const start = CONTENT.indexOf(START);
  expect(start).toBeGreaterThan(-1);
  const end = CONTENT.indexOf(END, start);
  expect(end).toBeGreaterThan(start);
  return CONTENT.slice(start, end + END.length);
}

function runContentStage(parsed) {
  const body = stageBlock() + '\n return { prepared: aiCmBasePrepared, detail: lastDetailMessages, texts: lastBaseTexts };';
  const stage = new Function('ctx', 'with (ctx) { ' + body + ' }');
  return stage({
    texts: parsed.pieces,
    ids: parsed.ids,
    detail: { messages: parsed.messages },
    sanitizeGeminiText: function (s) { return s; },
    aiCmDedupeExportSource: dedupe,
    canonicalBodyText: function (list) { return list.map(function (m) { return String(m.text || ''); }).join('\n'); },
    netEffectiveLen: 0,
    aiCmLogDedupeRemoved: function () { },
    aiCmBasePrepared: null,
    lastBaseTexts: [],
    lastBaseIds: [],
    lastDetailMessages: null,
    baseCount: 0,
    baseText: ''
  });
}

const collectSource = new Function('ctx',
  'with (ctx) { ' + fnDecl(MANAGER, 'aiCmCollectExportSource') + '\n return aiCmCollectExportSource; }');

function runCollect(out) {
  const collect = collectSource({
    AiCmExportEmitPipeline: { pickExportSource: function () { return 'network'; } },
    AiCmExportBuilders: null,
    baseSeen: true,
    lastBaseTexts: out.texts,
    lastDetailMessages: out.detail,
    currentAdapter: { siteName: 'perplexity' },
    sanitizeGeminiText: function (s) { return s; },
    aiCmSanitizeEmitUserTexts: function (list) { return list; },
    swallow: function () { },
    debugLog: function () { }
  });
  return collect();
}

describe('Perplexity sources: стадия приёма базы content.ts', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'perplexity-thread.json'), 'utf8'));

  test('sources доезжают до aiCmBasePrepared и lastDetailMessages', function () {
    const parsed = parsePerplexityThread(fixture);
    expect(parsed.messages[1].sources).toHaveLength(1);

    const out = runContentStage(parsed);

    expect(out.prepared[1].sources).toEqual(parsed.messages[1].sources);
    expect(out.detail[1].sources).toEqual(parsed.messages[1].sources);
    expect(out.texts[1]).toBe('Синтетический ответ один.');
    expect(out.texts[1]).not.toContain('[source]');
  });

  test('aiCmCollectExportSource (network) не теряет sources', function () {
    const parsed = parsePerplexityThread(fixture);
    const out = runContentStage(parsed);
    const collected = runCollect(out);

    expect(collected[1].text).toBe('Синтетический ответ один.');
    expect(collected[1].sources).toEqual(parsed.messages[1].sources);
    expect(collected[3].sources).toHaveLength(2);
  });

  test('сообщения без секций остаются без новых ключей', function () {
    const parsed = parsePerplexityThread(fixture);
    const out = runContentStage(parsed);

    expect(Object.prototype.hasOwnProperty.call(out.detail[0], 'sources')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out.detail[0], 'artifact')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out.detail[0], 'artifacts')).toBe(false);
  });
});
