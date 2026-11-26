'use strict';
/**
 * Stage 6: nativeExport(adapter) — чистый сборщик активной цепочки.
 *
 * Qwen — первый адаптер и эталон: нативный JSON
 * `chat-export-1795690751361.json` (268 сообщений, 134 user + 134 assistant,
 * currentId + parentId). Fixture приватная и лежит вне репозитория, поэтому
 * тест skip-if-absent; в CI без неё остаются синтетические инварианты.
 */

const fs = require('fs');
const path = require('path');
const { loadEsmModule, loadAsClassic } = require('./helpers/load-esm.js');
const { readCore } = require('./helpers/core-src.js');

const N = loadEsmModule('utils/export/native-chain.ts');
const QWEN_CLASSIC = loadAsClassic('core/qwen-intercept.js');
const MGR_SRC = readCore('core/export-manager.ts');
const QWEN_FIXTURE = path.join(
  __dirname, '..', '..',
  'acceptance', 'BIG-2026-11', '2.3', 'live', '2026-11-25',
  '08-qwen', 'exports', 'chat-export-1795690751361.json'
);

function qwenText(node) {
  if (typeof node.content === 'string' && node.content.trim()) return node.content;
  const list = Array.isArray(node.content_list) ? node.content_list : [];
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    if (item.phase === 'thinking' || item.phase === 'thinking_summary') continue;
    if (typeof item.content === 'string' && item.content) parts.push(item.content);
  }
  return parts.join('\n\n');
}

function qwenReasoning(node) {
  if (typeof node.reasoning_content === 'string' && node.reasoning_content) return node.reasoning_content;
  const list = Array.isArray(node.content_list) ? node.content_list : [];
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    if (item.phase !== 'thinking' && item.phase !== 'thinking_summary') continue;
    if (typeof item.content === 'string' && item.content) parts.push(item.content);
  }
  return parts.join('\n\n');
}

function qwenNative(file) {
  const root = JSON.parse(fs.readFileSync(file, 'utf8'));
  const history = root[0].chat.history;
  const nodes = [];
  for (const id of Object.keys(history.messages)) {
    const node = history.messages[id];
    if (!node || typeof node !== 'object') continue;
    nodes.push({
      id: node.id || id,
      parentId: node.parentId || null,
      role: node.role,
      text: qwenText(node),
      reasoning: qwenReasoning(node),
      files: Array.isArray(node.files) ? node.files : undefined
    });
  }
  return { nodes: nodes, currentId: history.currentId };
}

function rolesOf(messages) {
  const out = { user: 0, assistant: 0, other: 0 };
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') out.user++;
    else if (messages[i].role === 'assistant') out.assistant++;
    else out.other++;
  }
  return out;
}

describe('Stage 6 native-chain: Qwen reference 268/134/134', () => {
  const hasFixture = fs.existsSync(QWEN_FIXTURE);
  if (!hasFixture) {
    test.skip('приватная Qwen fixture отсутствует — пропуск', () => {});
  } else {
    test('активная цепочка: 268 сообщений, strict 134/134, off-chain 10 отброшено', () => {
      const input = qwenNative(QWEN_FIXTURE);
      const result = N.buildNativeChain(input);

      expect(result.messages).toHaveLength(268);
      expect(rolesOf(result.messages)).toEqual({ user: 134, assistant: 134, other: 0 });
      expect(result.partial).toBe(false);
      expect(result.partialReason).toBeUndefined();
      expect(result.truncated).toBe(false);
      expect(result.chainLength).toBe(268);
      expect(result.dropped).toBe(10);
      expect(result.currentId).toBe(input.currentId);
      expect(result.missingUserPairs).toBe(0);

      for (let i = 1; i < result.messages.length; i++) {
        expect([result.messages[i - 1].role, result.messages[i].role])
          .not.toEqual(['assistant', 'assistant']);
      }
    });

    test('порядок oldest→newest и текст последнего хода — из content_list', () => {
      const input = qwenNative(QWEN_FIXTURE);
      const result = N.buildNativeChain(input);
      const first = result.messages[0];
      const last = result.messages[result.messages.length - 1];

      expect(first.role).toBe('user');
      expect(first.text).toContain('Добрый день');
      expect(last.role).toBe('assistant');
      expect(last.text).toContain('Коммит принят');
      // Пустой текст допустим только у хода с вложениями; такие узлы не теряются,
      // их секции накладываются адаптером на следующем шаге Stage 6.
      const empty = result.messages.filter(function (m) { return !m.text; });
      expect(empty.length).toBeLessThanOrEqual(10);
    });

    test('интеграция: exportSnapshot отдаёт native, buildNativeChain выбирает ветку', () => {
      const payload = JSON.parse(fs.readFileSync(QWEN_FIXTURE, 'utf8'));
      const chatId = payload[0].id;
      window.history.replaceState({}, '', '/c/' + chatId);
      delete window.__aiCmQwenInterceptInstalled;
      new Function(QWEN_CLASSIC)();

      const bridge = window.__aiCmQwenBridge;
      expect(bridge && typeof bridge.applyHistory).toBe('function');
      bridge.applyHistory(payload, {
        chatId: chatId,
        full: true,
        url: 'https://chat.qwen.ai/api/v2/chats/' + chatId
      });

      const snap = bridge.exportSnapshot();
      expect(snap.chatId).toBe(chatId);
      expect(snap.messages).toHaveLength(268);
      expect(snap.native).toBeTruthy();
      expect(snap.native.nodes).toHaveLength(278);
      expect(snap.native.currentId).toBe('18ff9889-f18f-4e03-9ab1-e8c19c408583');
      expect(snap.native.linear).toBe(false);

      const built = N.buildNativeChain(snap.native);
      expect(built.messages).toHaveLength(268);
      expect(rolesOf(built.messages)).toEqual({ user: 134, assistant: 134, other: 0 });
      expect(built.partial).toBe(false);
      expect(built.partialReason).toBeUndefined();
      expect(built.dropped).toBe(10);
      expect(built.truncated).toBe(false);
      expect(built.messages[built.messages.length - 1].text).toContain('Коммит принят');

      // Свежесть: новый живой ход после полной истории отменяет native — иначе файл
      // потерял бы последнюю пару, которой ещё нет в нативном документе.
      bridge.turns().push({
        key: 'live-after-full', order: 9999, model: '', userKey: 'live-user',
        answer: 'LIVE TURN', reasoning: '', text: 'LIVE TURN', filesOnly: false
      });
      expect(bridge.exportSnapshot().native).toBe(null);
      bridge.turns().pop();

      delete window.__aiCmQwenBridge;
      delete window.__aiCmQwenInterceptInstalled;
    });
  }
});

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

describe('Stage 6 native-chain: выбор источника в export-manager', () => {
  function nativeHelper(ctx) {
    return new Function(
      'ctx',
      'with (ctx) { ' + fnDecl(MGR_SRC, 'aiCmQwenNativeFileMessages') +
      '\n return aiCmQwenNativeFileMessages; }'
    )(ctx);
  }

  test('полная цепочка → сообщения; partial/нет моста → null (старый путь)', () => {
    const msgs = [{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'A' }];
    const snap = { native: { nodes: [{ id: 'a', role: 'user', text: 'Q' }], currentId: 'a' } };

    expect(nativeHelper({ aiCmExportNativeChain: function () { return { messages: msgs, partial: false }; } })(snap))
      .toBe(msgs);
    expect(nativeHelper({ aiCmExportNativeChain: function () { return { messages: msgs, partial: true }; } })(snap))
      .toBe(null);
    expect(nativeHelper({})(snap)).toBe(null);
    expect(nativeHelper({ aiCmExportNativeChain: function () { return { messages: [], partial: false }; } })(snap))
      .toBe(null);
  });

  test('source-пины: collect и canonicalBody спрашивают native раньше turns', () => {
    const collect = fnDecl(MGR_SRC, 'aiCmCollectExportSource');
    const canonStart = MGR_SRC.indexOf('function aiCmBuildCanonicalBody(');
    const canonEnd = MGR_SRC.indexOf('// ========== S5.1', canonStart);
    expect(canonStart).toBeGreaterThan(-1);
    expect(canonEnd).toBeGreaterThan(canonStart);
    const canon = MGR_SRC.slice(canonStart, canonEnd);

    expect(collect).toContain('aiCmQwenNativeFileMessages(qSnap)');
    expect(collect).toContain("'qwen-native'");
    expect(canon).toContain('aiCmQwenNativeFileMessages(qCanon)');
    expect(canon.indexOf('aiCmQwenNativeFileMessages(qCanon)'))
      .toBeLessThan(canon.indexOf('qCanonMsgs.length > list.length'));
  });
});

describe('Stage 6 native-chain: синтетические инварианты', () => {
  test('human → user, off-chain отбрасывается, лист — последний узел', () => {
    const result = N.buildNativeChain({
      nodes: [
        { id: 'a', parentId: null, role: 'human', text: 'Q1' },
        { id: 'b', parentId: 'a', role: 'assistant', text: 'A1' },
        { id: 'x', parentId: null, role: 'human', text: 'abandoned', offChain: true }
      ]
    });
    expect(result.messages.map(function (m) { return [m.role, m.text]; }))
      .toEqual([['user', 'Q1'], ['assistant', 'A1']]);
    expect(result.dropped).toBe(1);
    expect(result.partial).toBe(false);
  });

  test('A→A без user: не удаляется молча, partial=missing-user-text', () => {
    const result = N.buildNativeChain({
      nodes: [
        { id: 'a', parentId: null, role: 'assistant', text: 'A1' },
        { id: 'b', parentId: 'a', role: 'assistant', text: 'A2' }
      ]
    });
    expect(result.messages).toHaveLength(2);
    expect(result.missingUserPairs).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('missing-user-text');
  });

  test('user без assistant не ломает U/A-инвариант', () => {
    const result = N.buildNativeChain({
      nodes: [
        { id: 'a', parentId: null, role: 'user', text: 'Q1' },
        { id: 'b', parentId: 'a', role: 'assistant', text: 'A1' },
        { id: 'c', parentId: 'b', role: 'user', text: 'Q2' }
      ]
    });
    expect(result.messages).toHaveLength(3);
    expect(result.missingUserPairs).toBe(0);
    expect(result.partial).toBe(false);
  });

  test('битый parentId/цикл: partial=truncated, без выдуманных сообщений', () => {
    const broken = N.buildNativeChain({
      nodes: [
        { id: 'a', parentId: 'missing', role: 'user', text: 'Q' },
        { id: 'b', parentId: 'a', role: 'assistant', text: 'A' }
      ],
      currentId: 'b'
    });
    expect(broken.truncated).toBe(true);
    expect(broken.partial).toBe(true);
    expect(broken.partialReason).toBe('truncated');

    const cycle = N.buildNativeChain({
      nodes: [
        { id: 'a', parentId: 'b', role: 'user', text: 'Q' },
        { id: 'b', parentId: 'a', role: 'assistant', text: 'A' }
      ],
      currentId: 'a'
    });
    expect(cycle.truncated).toBe(true);
    expect(cycle.partialReason).toBe('truncated');
  });

  test('linear: true — плоский список берётся как есть', () => {
    const result = N.buildNativeChain({
      linear: true,
      nodes: [
        { id: '1', role: 'user', text: 'Q1' },
        { id: '2', role: 'assistant', text: 'A1' },
        { id: '3', role: 'user', text: 'Q2' }
      ]
    });
    expect(result.messages.map(function (m) { return m.text; })).toEqual(['Q1', 'A1', 'Q2']);
    expect(result.chainLength).toBe(3);
    expect(result.dropped).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.partial).toBe(false);
  });

  test('reasoning/hiddenReasoning переносятся для ON-режима экспорта', () => {
    const result = N.buildNativeChain({
      nodes: [
        { id: 'a', parentId: null, role: 'user', text: 'Q' },
        { id: 'b', parentId: 'a', role: 'assistant', text: 'A', reasoning: 'R', hiddenReasoning: 'R' }
      ]
    });
    expect(result.messages[1].reasoning).toBe('R');
    expect(result.messages[1].hiddenReasoning).toBe('R');
  });

  test('пустой вход: partial=incomplete, без исключения', () => {
    const result = N.buildNativeChain({ nodes: [] });
    expect(result.messages).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('incomplete');
  });
});
