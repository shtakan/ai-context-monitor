'use strict';

/**
 * S1.3b (inv-i3): файл и снимок строятся из ОДНОГО канонического массива.
 *
 * Тест берёт реальную пару (core/hybrid-tail.ts + utils/canonical-body.ts), собирает
 * базу + bounded-хвост, получает тело через aiCmBuildCanonicalBody (срез
 * core/export-manager.ts исполняется new Function с инжекцией canonicalBody/
 * AiCmExportBuilders — как в бандле контент-скрипта), а затем строит MD и JSON
 * РЕАЛЬНЫМИ buildMdFromHistory/buildJsonFromHistory (utils/export-text-builders.ts).
 *
 * ПИНУЕТСЯ:
 *   1. canonicalBodyText(body.messages) === body.text (тело = массив, не пересборка);
 *   2. MD после шапки: блоки, разобранные по маркерам ролей, join('\n') === body.text;
 *   3. JSON: messages.map(m => m.text).join('\n') === body.text;
 *   4. chars/msgs/bodyHash тела согласованы с текстом и массивом, bodyHash мемоизирован;
 *   5. хвост входит в тело (база + новые ходы последними).
 *
 * На HEAD ed77f69 (без aiCmBuildCanonicalBody) тест КРАСНЫЙ; после S1.3b — зелёный.
 */

const fs = require('fs');
const path = require('path');

const loadEsmHelper = require('./helpers/load-esm.js');
const Canonical = loadEsmHelper.loadEsmModule('utils/canonical-body.ts');
const Hybrid = loadEsmHelper.loadEsmGlobal('core/hybrid-tail.ts', 'AiCmHybridTail');
const Builders = loadEsmHelper.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');

const ROOT = path.join(__dirname, '..');
const EM_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.ts'), 'utf8');
const CONV_ID = 'conv-i3-equality';

// Свободные переменные общего лексического скоупа контент-скриптов.
const SCOPE_KEYS = [
  'baseSeen', 'baseText', 'baseCount', 'baseComplete', 'baseIdSet', 'baseSkelSet',
  'baseAnchors', 'lastBounded', 'lastTailSig', 'lastHybridTailSig', 'currentAdapter',
  'aiCmMetricBaseText', 'debugLog', 'aiCmBasePrepared'
];

// ---- база: тот же массив, что в жизни лежит в aiCmBasePrepared -----------------------------
// reasoning у a2: canonicalize складывает секции в текст, а сборщики MD/JSON обязаны
// увидеть уже сложенный текст и НЕ добавить [REASONING]/[ANSWER] второй раз.
const BASE_PREPARED = [
  { id: 'u1', role: 'user', text: 'Первый вопрос' },
  { id: 'a1', role: 'assistant', text: 'Первый ответ' },
  { id: 'u2', role: 'user', text: 'Второй вопрос' },
  { id: 'a2', role: 'assistant', text: 'Второй ответ', reasoning: 'Рассуждение второго ответа' }
];
const BASE_TEXT = Canonical.canonicalBodyText(BASE_PREPARED);
const BASE_COUNT = BASE_PREPARED.length;

const DOM_BASE = [
  { id: 'u1', kind: 'user-query' },
  { id: 'a1', kind: 'model-response' },
  { id: 'u2', kind: 'user-query' },
  { id: 'a2', kind: 'model-response' }
];
const NEW_MSGS = [
  { id: 'u3', kind: 'user-query', text: 'Третий вопрос после обмена' },
  { id: 'a3', kind: 'model-response', text: 'Свежий ответ модели, которого ещё нет в базе.' }
];
const NEW_TEXT = NEW_MSGS.map(function (m) { return m.text; }).join('\n');

function renderFeed(msgs) {
  document.body.innerHTML = '<div class="conversation-container"></div>';
  const feed = document.querySelector('.conversation-container');
  msgs.forEach(function (m) {
    const el = document.createElement('div');
    el.className = m.kind;
    el.setAttribute('data-message-id', m.id);
    if (m.attrRole) el.setAttribute('data-message-author-role', m.attrRole);
    el.textContent = m.text || '';
    feed.appendChild(el);
  });
}

function installScope(over) {
  const scope = {
    baseSeen: true,
    baseText: BASE_TEXT,
    baseCount: BASE_COUNT,
    baseComplete: true,
    baseIdSet: new Set(DOM_BASE.map(function (m) { return m.id; })),
    baseSkelSet: new Set(),
    baseAnchors: [],
    lastBounded: null,
    lastTailSig: null,
    lastHybridTailSig: null,
    currentAdapter: { siteName: 'qwen' },
    aiCmMetricBaseText: undefined,
    debugLog: function () { },
    aiCmBasePrepared: BASE_PREPARED
  };
  Object.assign(scope, over || {});
  SCOPE_KEYS.forEach(function (k) { global[k] = scope[k]; });
  return scope;
}

function exportManagerSlice() {
  const start = EM_SRC.indexOf('var lastCanonList = null;');
  const end = EM_SRC.indexOf('// ========== v2.0 (этап 1/3)', start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'inv-i3: в core/export-manager.ts нет блока S1.3 (aiCmBuildCanonicalBody). ' +
      'На HEAD ed77f69 тест обязан быть красным; после S1.3b — зелёным.'
    );
  }
  const slice = EM_SRC.slice(start, end);
  if (slice.indexOf('function aiCmBuildCanonicalBody') === -1) {
    throw new Error('inv-i3: в срезе export-manager.ts нет aiCmBuildCanonicalBody');
  }
  return slice;
}

/** Тело снимка из того же массива, что отдаёт getEffectiveMessages(). */
function buildBodyFromEffective() {
  const factory = new Function(
    'getEffectiveMessages',
    'buildHistoryMessages',
    'canonicalBody',
    'AiCmExportBuilders',
    'currentAdapter',
    exportManagerSlice() + '\nreturn aiCmBuildCanonicalBody;'
  );
  const build = factory(
    Hybrid.getEffectiveMessages,
    function () { return []; },
    Canonical.canonicalBody,
    Builders,
    { siteName: 'qwen' }
  );
  return build(CONV_ID);
}

/** Текстовые блоки MD после шапки, разобранные по маркерам ролей ('### USER'/'### ASSISTANT'). */
function mdBodyTexts(md) {
  const isMarker = function (line) { return line === '### USER' || line === '### ASSISTANT'; };
  const lines = String(md).split('\n');
  let i = 0;
  while (i < lines.length && !isMarker(lines[i])) i++;
  const blocks = [];
  let cur = null;
  for (; i < lines.length; i++) {
    if (isMarker(lines[i])) {
      if (cur) blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(lines[i]);
  }
  if (cur) blocks.push(cur);
  return blocks.map(function (block) {
    let s = 0;
    let e = block.length;
    while (s < e && block[s] === '') s++;
    while (e > s && block[e - 1] === '') e--;
    return block.slice(s, e).join('\n');
  });
}

beforeEach(function () {
  document.body.innerHTML = '';
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

afterEach(function () {
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

describe('inv-i3: файл и снимок из одного канонического массива (S1.3b)', function () {
  test('MD после шапки === JSON join(text) === body.text; chars/msgs/bodyHash согласованы', function () {
    renderFeed(DOM_BASE.concat(NEW_MSGS));
    installScope({});

    const effectiveMessages = Hybrid.getEffectiveMessages();
    expect(effectiveMessages).not.toBeNull();
    expect(effectiveMessages.length).toBe(BASE_COUNT + NEW_MSGS.length);

    const body = buildBodyFromEffective();
    expect(body).not.toBeNull();
    expect(body.messages.length).toBe(BASE_COUNT + NEW_MSGS.length);

    // 1. Тело — это РОВНО массив сообщений, без отдельной пересборки текста.
    expect(Canonical.canonicalBodyText(body.messages)).toBe(body.text);

    // 5. Хвост входит последними сообщениями, база — первыми.
    expect(body.text).toContain(BASE_PREPARED[0].text);
    expect(body.text).toContain(BASE_PREPARED[2].text);
    expect(body.text.slice(-NEW_TEXT.length)).toBe(NEW_TEXT);
    expect(body.messages[body.messages.length - 1].text).toBe(NEW_MSGS[1].text);

    // Reasoning сложен ОДИН раз: секция есть, дублей нет.
    expect(body.text).toContain('[REASONING]\nРассуждение второго ответа');
    expect(body.text.split('Рассуждение второго ответа').length - 1).toBe(1);

    // 4. chars/msgs/bodyHash согласованы с текстом и массивом.
    expect(body.chars).toBe(body.text.length);
    expect(body.msgs).toBe(body.messages.length);
    expect(body.bodyHash).toMatch(/^[0-9a-f]{8}:\d+$/);
    expect(body.bodyHash.split(':')[1]).toBe(String(body.chars));
    // Мемо: тот же массив + тот же чат → тот же объект тела (WeakMap canonicalBody).
    expect(Canonical.canonicalBody(CONV_ID, body.messages)).toBe(body);

    const hist = {
      site: 'qwen',
      model: 'Qwen',
      tokens: 1234,
      limit: 1000000,
      percent: 0.1,
      messages: body.messages
    };

    // 2. MD: реальный сборщик, после шапки — блоки по маркерам ролей.
    const md = Builders.buildMdFromHistory(hist, 'Qwen');
    const mdTexts = mdBodyTexts(md);
    expect(mdTexts.length).toBe(body.msgs);
    expect(mdTexts.join('\n')).toBe(body.text);
    // Маркеров ровно столько же, сколько сообщений (шапка своих маркеров не содержит).
    const markerCount = md.split('\n').filter(function (line) {
      return line === '### USER' || line === '### ASSISTANT';
    }).length;
    expect(markerCount).toBe(body.msgs);

    // 3. JSON: реальный сборщик, messages[].text — тот же текст в том же порядке.
    const parsed = JSON.parse(Builders.buildJsonFromHistory(hist, 'Qwen'));
    expect(parsed.messages.length).toBe(body.msgs);
    expect(parsed.messages.map(function (m) { return m.text; }).join('\n')).toBe(body.text);
  });

  test('drop контейнеров не расходится с файлом: тело и MD теряют один и тот же узел', function () {
    const containerText = 'Первый вопрос\nВторой вопрос';
    renderFeed(DOM_BASE.concat(NEW_MSGS));
    installScope({
      aiCmBasePrepared: BASE_PREPARED.concat([{ id: 'c1', role: 'assistant', text: containerText }])
    });

    const messages = Hybrid.getEffectiveMessages();
    expect(messages.length).toBe(BASE_COUNT + NEW_MSGS.length + 1);

    const body = buildBodyFromEffective();
    // Qwen: контейнер выброшен РОВНО один раз — и в теле, и в MD/JSON из него.
    expect(body.messages.length).toBe(BASE_COUNT + NEW_MSGS.length);
    expect(body.text).not.toContain(containerText);
    expect(Canonical.canonicalBodyText(body.messages)).toBe(body.text);

    const hist = {
      site: 'qwen',
      model: 'Qwen',
      tokens: 10,
      limit: 100,
      percent: 10,
      messages: body.messages
    };
    const mdTexts = mdBodyTexts(Builders.buildMdFromHistory(hist, 'Qwen'));
    expect(mdTexts.join('\n')).toBe(body.text);
    expect(mdTexts.join('\n')).not.toContain(containerText);
    const parsed = JSON.parse(Builders.buildJsonFromHistory(hist, 'Qwen'));
    expect(parsed.messages.map(function (m) { return m.text; }).join('\n')).toBe(body.text);
  });
});
