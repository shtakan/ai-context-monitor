'use strict';

/**
 * BUG-09/фаза 4: Claude artifact capture из tool-блоков истории.
 *
 * Живая форма (fixture cb5317de…, artifact 71905e01…): в chat_messages нет
 * массива artifacts; метаданные — в tool_use(Artifact).structured_content и
 * tool_result.display_content, исходник — в
 * tool_use(create_file).input.file_text. Парсер должен собрать
 * per-message artifacts, а builders — напечатать верхнеуровневые секции.
 */

const fs = require('fs');
const path = require('path');
const loadEsm = require('./helpers/load-esm.js');
const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
const moduleSource = require('./helpers/content-source.js').moduleSource;

const CLAUDE_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'claude-intercept.js'), 'utf8');
const BASE_SRC = moduleSource('base-handler.ts');
const CONTENT_SRC = moduleSource('content.ts');
const MANAGER_SRC = moduleSource('export-manager.ts');

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

const PARSE_SRC = [
  'parseHistory',
  'claudeArtifactBaseName',
  'claudeArtifactMime',
  'claudeArtifactsFromBlocks'
].map(function (name) { return fnDecl(CLAUDE_SRC, name); }).join('\n\n');

function parse(raw) {
  const ctx = {
    traceLog: function () { },
    console: { log: function () { }, warn: function () { }, error: function () { } }
  };
  return new Function('ctx', 'raw',
    'with (ctx) { ' + PARSE_SRC + '\n return parseHistory(raw); }')(ctx, raw);
}

const dedupe = new Function('ctx',
  'with (ctx) { ' + fnDecl(BASE_SRC, 'aiCmDedupeExportSource') + '\n return aiCmDedupeExportSource; }')({
  currentAdapter: { siteName: 'claude' },
  swallow: function () { },
  debugLog: function () { }
});

const STAGE_START = 'var rawMsgs18 =';
const STAGE_END = 'lastDetailMessages = msgs18;';

function contentStage(parsed) {
  const start = CONTENT_SRC.indexOf(STAGE_START);
  const end = CONTENT_SRC.indexOf(STAGE_END, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = CONTENT_SRC.slice(start, end + STAGE_END.length);
  const fn = new Function('ctx', 'with (ctx) { ' + block +
    '\n return { prepared: aiCmBasePrepared, detail: lastDetailMessages, texts: lastBaseTexts }; }');
  return fn({
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

function collectStage(out) {
  const fn = new Function('ctx',
    'with (ctx) { ' + fnDecl(MANAGER_SRC, 'aiCmCollectExportSource') + '\n return aiCmCollectExportSource; }');
  const collect = fn({
    AiCmExportEmitPipeline: { pickExportSource: function () { return 'network'; } },
    baseSeen: true,
    lastBaseTexts: out.texts,
    lastDetailMessages: out.detail,
    currentAdapter: { siteName: 'claude' },
    sanitizeGeminiText: function (s) { return s; },
    aiCmSanitizeEmitUserTexts: function (list) { return list; },
    swallow: function () { },
    debugLog: function () { }
  });
  return collect();
}

const ART_ID = '71905e01-cf09-46da-b1bb-33774528c7ed';
const HTML = '<!DOCTYPE html>\n<html><body><h1>Таймер 60 секунд</h1></body></html>';

function rawWith(content) {
  return {
    uuid: 'conv-fixture',
    model: 'claude-sonnet-5',
    chat_messages: [
      {
        uuid: 'u1',
        sender: 'human',
        content: [{ type: 'text', text: 'Create an artifact, not a file.' }]
      },
      {
        uuid: 'a1',
        sender: 'assistant',
        content: content
      }
    ]
  };
}

const ARTIFACT_CONTENT = [
  { type: 'text', text: 'Готово — таймер опубликован как артефакт.' },
  {
    type: 'tool_use',
    name: 'create_file',
    input: { path: '/mnt/user-data/outputs/timer.html', file_text: HTML }
  },
  {
    type: 'tool_result',
    display_content: {
      type: 'file',
      published_url: 'https://claude.ai/code/artifact/' + ART_ID,
      published_artifact_id: ART_ID,
      published_action: 'published',
      title: 'Таймер 60 секунд',
      owned_by_account: true
    }
  },
  {
    type: 'tool_use',
    name: 'Artifact',
    structured_content: {
      artifact_id: ART_ID,
      no_capabilities: true,
      path: '/mnt/user-data/outputs/timer.html',
      title: 'Таймер 60 секунд',
      url: 'https://claude.ai/artifact/F2MaaTibQQAsAPXomYBsnt'
    }
  }
];

describe('Claude artifact capture (BUG-09)', () => {
  test('tool_use(Artifact)+create_file → per-message artifact без дубля', function () {
    const parsed = parse(rawWith(ARTIFACT_CONTENT));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].text).toBe('Create an artifact, not a file.');
    expect(parsed.messages[1].text).toBe('Готово — таймер опубликован как артефакт.');

    const artifacts = parsed.messages[1].artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({
      name: 'Таймер 60 секунд',
      mime: 'text/html',
      content: HTML,
      turnId: 'a1'
    });
    // Текст/счётчики не изменились от появления artifact.
    expect(parsed.count).toBe(2);
    expect(parsed.text).not.toContain('tool_use');
    expect(parsed.text).not.toContain('artifact_id');
  });

  test('create_file без artifact-метаданных не становится artifact', function () {
    const parsed = parse(rawWith([
      { type: 'text', text: 'Файл готов.' },
      { type: 'tool_use', name: 'create_file', input: { path: 'notes.txt', file_text: 'hello' } }
    ]));
    expect(parsed.messages[1].artifacts).toBeUndefined();
  });

  test('artifact-only ход (нет text) сохраняется как сообщение с artifact', function () {
    const parsed = parse(rawWith([
      {
        type: 'tool_use',
        name: 'create_file',
        input: { path: 'timer.html', file_text: HTML }
      },
      {
        type: 'tool_use',
        name: 'Artifact',
        structured_content: { artifact_id: ART_ID, title: 'Таймер 60 секунд', path: 'timer.html' }
      }
    ]));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].text).toBe('');
    expect(parsed.messages[1].artifacts).toHaveLength(1);
    expect(parsed.messages[1].artifacts[0].content).toBe(HTML);
  });

  test('content-стадия и aiCmCollectExportSource сохраняют artifacts', function () {
    const parsed = parse(rawWith(ARTIFACT_CONTENT));
    const out = contentStage(parsed);

    expect(out.prepared[1].artifacts).toEqual(parsed.messages[1].artifacts);
    expect(out.detail[1].artifacts).toEqual(parsed.messages[1].artifacts);
    expect(out.texts[1]).toBe('Готово — таймер опубликован как артефакт.');

    const collected = collectStage(out);
    expect(collected[1].artifacts).toEqual(parsed.messages[1].artifacts);
    expect(collected[1].text).toBe('Готово — таймер опубликован как артефакт.');
  });

  test('builders: artifacts верхнеуровнево, в messages их нет', function () {
    const parsed = parse(rawWith(ARTIFACT_CONTENT));
    const h = {
      site: 'claude',
      model: 'Claude Sonnet 5',
      tokens: 10,
      limit: 1000000,
      percent: 0,
      messages: parsed.messages
    };

    const json = JSON.parse(Builders.buildJsonFromHistory(h, 'Claude'));
    expect(json.artifacts).toHaveLength(1);
    expect(json.artifacts[0].name).toBe('Таймер 60 секунд');
    expect(json.artifacts[0].mime).toBe('text/html');
    expect(json.artifacts[0].content).toBe(HTML);
    expect(json.messages[1].artifacts).toBeUndefined();

    const md = Builders.buildMdFromHistory(h, 'Claude');
    expect(md).toContain('## ARTIFACTS');
    expect(md).toContain('### Таймер 60 секунд (text/html)');
    expect(md).toContain('Таймер 60 секунд</h1>');

    const txt = Builders.buildTxtFromHistory(h);
    expect(txt).toContain('[ARTIFACTS]');
    expect(txt).toContain('Таймер 60 секунд (text/html)');
  });
});
