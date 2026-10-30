/**
 * tests/qwen-r4-files-only.test.js — R4: ход Qwen, состоящий ТОЛЬКО из вложений.
 *
 * Контракт (PROJECT_HANDOFF.md, аппендикс v112 §4 R4):
 *   • сообщение с files[] и без текста не пропускается ни на разборе (content_list=[]),
 *     ни при записи хода (assistant с пустым ответом), ни при сборке снимка;
 *   • пользовательский блок получает текстовый заместитель «[Вложение]» и секции
 *     «[FILE: имя]\n<тело>»; пустой ASSISTANT-блок в базу/экспорт НЕ попадает;
 *   • вложения ассистента (наблюдённая форма) не теряются: объединяются с вложениями
 *     вопроса и попадают в тот же пользовательский блок;
 *   • ход без ответа вообще (только user + files) существует как file-only заглушка,
 *     а приход настоящего ответа забирает её (adoption), не плодя второй user-блок;
 *   • повторное применение той же страницы истории идемпотентно.
 *
 * Стенд — РЕАЛЬНЫЕ core/qwen-intercept.js + core/qwen-files.js в jsdom; сеть подменена:
 * история отдаётся JSON-ом, тело вложения — текстом (fetch-хук перехватчика при этом жив).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'qwen-intercept.js'), 'utf8');
const STREAM_FRAMES_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'stream-frames.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const QWEN_FILES_SRC = fs.readFileSync(path.join(ROOT, 'core', 'qwen-files.js'), 'utf8');

const CHAT_ID = 'aaaaaaaa-1111-4222-8333-444455556666';
const URL_HISTORY = 'https://chat.qwen.ai/api/v2/chats/' + CHAT_ID + '?direction=up&limit=10';
const RESPONSE_ID = 'resp-0000-1111-2222-333333333333';
const FID = 'fid-user-0001';
const MODEL = 'qwen3.8-max';

const FILE_URL = 'https://cdn.qwenlm.ai/u1/file-1_PROTOCOL.md?key=JWT.SIGNATURE';
const FILE_BODY = '# PROTOCOL\n\nStep 1: keep the turn.';
const FILE = {
  id: 'file-1',
  name: 'PROTOCOL.md',
  file_type: 'text/markdown',
  size: 1200,
  status: 'uploaded',
  type: 'file',
  url: FILE_URL
};
const FILE_SECTION = '[FILE: PROTOCOL.md]';

// ---- фикстуры измеренных форм -------------------------------------------------------
function userNode(opts) {
  const o = opts || {};
  const files = Array.isArray(o.files) ? o.files : [];
  const node = {
    id: o.id || ('msg-' + FID),
    fid: o.fid || FID,
    role: 'user',
    files: files
  };
  if (o.emptyList === true) {
    node.content_list = [];
  } else {
    node.content_list = [{ phase: 'answer', status: 'finished', content: o.text || '' }];
  }
  return node;
}

function assistantNode(opts) {
  const o = opts || {};
  const list = [];
  if (o.reasoning) {
    list.push({
      phase: 'thinking_summary',
      status: 'finished',
      extras: { summary_thought: { content: [o.reasoning] } }
    });
  }
  list.push({ phase: 'answer', status: 'finished', content: o.text || '' });
  const node = {
    id: o.id || ('msg-a-' + RESPONSE_ID),
    response_id: o.responseId || RESPONSE_ID,
    role: 'assistant',
    model: MODEL,
    content_list: list
  };
  if (Array.isArray(o.files)) node.files = o.files;
  return node;
}

function historyPayload(messages) {
  return { data: { chat_id: CHAT_ID, chat: { history: { messages: messages } } } };
}

// ---- подменённая сеть: история — JSON, тело вложения — текст ------------------------
function jsonResponse(payload) {
  const body = JSON.stringify(payload);
  function make() {
    return {
      ok: true,
      status: 200,
      headers: { get: function (n) { return n === 'content-type' ? 'application/json' : null; } },
      text: function () { return Promise.resolve(body); },
      json: function () { return Promise.resolve(JSON.parse(body)); },
      clone: function () { return make(); }
    };
  }
  return make();
}

function fileResponse(text) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: function (n) {
        if (n === 'content-type') return 'text/markdown';
        if (n === 'content-length') return String(text.length);
        return null;
      }
    },
    text: function () { return Promise.resolve(text); },
    clone: function () { return fileResponse(text); }
  };
}

function installStand(payload) {
  new Function('window', 'self', DEBUG_SRC)(window, window);
  new Function('window', 'self', STREAM_FRAMES_SRC)(window, window);
  if (!window.AiCmQwenFiles) {
    new Function('window', 'self', QWEN_FILES_SRC)(window, window);
  }
  // Очередь/тексты вложений — состояние модуля, живёт между тестами; чистим до нового ядра.
  window.AiCmQwenFiles.qfReset(CHAT_ID);

  const events = [];
  const calls = [];
  window.addEventListener('ai-cm-full-history', function (ev) { events.push(ev.detail); });

  // originalFetch перехватчика = именно этот мок: иначе на втором тесте он снял бы
  // ПРЕДЫДУЩУЮ обёртку и тело файла ушло бы в рекурсию/404.
  window.fetch = function (input, init) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.push({ url: url, method: method });
    if (url === URL_HISTORY) return Promise.resolve(jsonResponse(payload));
    if (url === FILE_URL) return Promise.resolve(fileResponse(FILE_BODY));
    return Promise.resolve({ ok: false, status: 404, headers: { get: function () { return null; } } });
  };

  jest.spyOn(console, 'log').mockImplementation(function () { });
  jest.spyOn(console, 'warn').mockImplementation(function () { });

  delete window.__aiCmQwenInterceptInstalled;
  new Function(INTERCEPT_SRC)();
  return { events: events, calls: calls };
}

function settle(rounds) {
  let p = Promise.resolve();
  for (let i = 0; i < (rounds || 6); i++) {
    p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  }
  return p;
}

function delay(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1500);
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(20);
  }
  return !!check();
}

async function runHistory(payload) {
  const st = installStand(payload);
  await window.fetch(URL_HISTORY, { method: 'GET' });
  await settle(6);
  // qwen-files просит ре-эмит через 250 мс после тела файла — ждём по признаку в событии.
  await waitFor(function () {
    return st.events.some(function (d) { return d.text.indexOf(FILE_SECTION) !== -1; });
  }, 2000);
  await settle(4);
  return st;
}

function lastEvent(st) {
  expect(st.events.length).toBeGreaterThan(0);
  return st.events[st.events.length - 1];
}

function txtOf(detail) {
  return Builders.buildTxtFromHistory({ site: 'qwen', messages: detail.messages });
}

function mdOf(detail) {
  return Builders.buildMdFromHistory({ site: 'qwen', messages: detail.messages }, 'Qwen');
}

beforeAll(function () {
  window.history.replaceState({}, '', '/c/' + CHAT_ID);
});

beforeEach(function () {
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { /* sessionStorage may be unavailable */ }
});

afterEach(function () {
  jest.restoreAllMocks();
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { /* sessionStorage may be unavailable */ }
});

// =====================================================================================
// A: user files-only + пустой assistant → ход есть, ASSISTANT-блока нет
// =====================================================================================
describe('R4 A/F: пустой assistant с вложениями вопроса', () => {
  test('A: user text="" + files, assistant text="" → один user-блок с файлом, без assistant', async () => {
    const st = await runHistory(historyPayload([
      userNode({ text: '', files: [FILE] }),
      assistantNode({ text: '' })
    ]));
    const B = window.__aiCmQwenBridge;

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].filesOnly).toBe(true);
    expect(B.turns()[0].key).toBe(RESPONSE_ID);
    expect(B.turns()[0].answer).toBe('');

    const d = lastEvent(st);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user']);
    expect(d.messageIds).toHaveLength(1);
    expect(d.messageIds[0]).toBe('u:' + FID);
    expect(d.modelSlug).toBe(MODEL);
    expect(d.messages[0].text).toContain('[Вложение]');
    expect(d.messages[0].text).toContain(FILE_SECTION);
    expect(d.messages[0].text).toContain('Step 1: keep the turn.');

    const txt = txtOf(d);
    const md = mdOf(d);
    expect(txt).toContain('USER:\n[Вложение]');
    expect(txt).not.toContain('ASSISTANT:');
    expect(md).toContain('### USER');
    expect(md).not.toContain('### ASSISTANT');
    expect(md).toContain(FILE_SECTION);
    // URL с JWT-подписью не уходит в экспорт ни в каком виде.
    expect(txt).not.toContain('key=JWT');
    expect(md).not.toContain('key=JWT');
  });

  test('F: пустой answer + reasoning → ход не filesOnly, [ANSWER] остаётся, файл в user-блоке', async () => {
    const st = await runHistory(historyPayload([
      userNode({ text: '', files: [FILE] }),
      assistantNode({ text: '', reasoning: 'Короткая мысль.' })
    ]));
    const B = window.__aiCmQwenBridge;

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].filesOnly).toBe(false);
    expect(B.turns()[0].answer).toBe('');
    expect(B.turns()[0].reasoning).toBe('Короткая мысль.');

    const d = lastEvent(st);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(d.messages[0].text).toContain('[Вложение]');
    expect(d.messages[0].text).toContain(FILE_SECTION);
    expect(d.messages[1].text).toContain('[REASONING]');
    expect(d.messages[1].text).toContain('[ANSWER]');
    expect(d.messages[1].text).not.toContain(FILE_SECTION);
  });
});

// =====================================================================================
// B: обычно выглядящий ответ рядом с files-only вопросом
// =====================================================================================
describe('R4 B: файл вопроса не подменяет ответ', () => {
  test('B: user files-only + assistant "OK" → placeholder и файл в user, ответ отдельно', async () => {
    const st = await runHistory(historyPayload([
      userNode({ text: '', files: [FILE] }),
      assistantNode({ text: 'OK' })
    ]));
    const B = window.__aiCmQwenBridge;

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].filesOnly).toBe(false);
    const d = lastEvent(st);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(d.messages[0].text).toContain('[Вложение]');
    expect(d.messages[0].text).toContain(FILE_SECTION);
    expect(d.messages[1].text).toBe('OK');
    expect(d.messages[1].text).not.toContain(FILE_SECTION);
    expect(txtOf(d)).toContain('USER:\n[Вложение]');
    expect(txtOf(d)).toContain('ASSISTANT:\nOK');
  });
});

// =====================================================================================
// C: только вопрос с вложением, ответа нет вообще → synthetic file-only turn
// =====================================================================================
describe('R4 C: сообщение только с вложением без ответа', () => {
  test('C: user files-only → synthetic turn, файл в базе, assistant-блока нет', async () => {
    const st = await runHistory(historyPayload([
      userNode({ text: '', files: [FILE] })
    ]));
    const B = window.__aiCmQwenBridge;

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].filesOnly).toBe(true);
    expect(B.turns()[0].key.indexOf('file-only:')).toBe(0);
    expect(B.turns()[0].answer).toBe('');

    const d = lastEvent(st);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user']);
    expect(d.messages[0].text).toContain('[Вложение]');
    expect(d.messages[0].text).toContain(FILE_SECTION);
    expect(d.messages[0].text).toContain('Step 1: keep the turn.');
    expect(mdOf(d)).not.toContain('### ASSISTANT');
  });

  test('C/idempotency: повторное применение страницы не плодит ходы и user-блоки', async () => {
    const payload = historyPayload([userNode({ text: '', files: [FILE] })]);
    const st = installStand(payload);
    const B = window.__aiCmQwenBridge;

    const first = B.applyHistory(payload, { chatId: CHAT_ID, url: URL_HISTORY });
    await waitFor(function () {
      return st.events.some(function (d) { return d.text.indexOf(FILE_SECTION) !== -1; });
    }, 2000);
    const second = B.applyHistory(payload, { chatId: CHAT_ID, url: URL_HISTORY });
    await settle(8);

    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(B.turns()).toHaveLength(1);
    const d = lastEvent(st);
    expect(d.messages.filter(function (m) { return m.role === 'user'; })).toHaveLength(1);
    expect(d.messages.filter(function (m) { return m.role === 'assistant'; })).toHaveLength(0);
    expect((d.text.match(/\[FILE: PROTOCOL\.md\]/g) || [])).toHaveLength(1);
  });

  test('C/adoption: настоящий ответ забирает file-only заглушку, второй user-блок не появляется', async () => {
    const userOnly = historyPayload([userNode({ text: '', files: [FILE] })]);
    const withAnswer = historyPayload([
      userNode({ text: '', files: [FILE] }),
      assistantNode({ text: 'OK' })
    ]);
    const st = installStand(userOnly);
    const B = window.__aiCmQwenBridge;

    B.applyHistory(userOnly, { chatId: CHAT_ID, url: URL_HISTORY });
    await waitFor(function () {
      return st.events.some(function (d) { return d.text.indexOf(FILE_SECTION) !== -1; });
    }, 2000);
    expect(B.turns()[0].key.indexOf('file-only:')).toBe(0);

    B.applyHistory(withAnswer, { chatId: CHAT_ID, url: URL_HISTORY });
    await settle(8);

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].key).toBe(RESPONSE_ID);
    expect(B.turns()[0].filesOnly).toBe(false);
    expect(B.turns()[0].answer).toBe('OK');

    const d = lastEvent(st);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(d.messages.filter(function (m) { return m.role === 'user'; })).toHaveLength(1);
    expect(d.messages[0].text).toContain('[Вложение]');
    expect(d.messages[0].text).toContain(FILE_SECTION);
    expect(d.messages[1].text).toBe('OK');
  });

  test('C/adoption+повтор: C → A → C не плодит второй ход после смены ключа', async () => {
    const userOnly = historyPayload([userNode({ text: '', files: [FILE] })]);
    const emptyAnswer = historyPayload([
      userNode({ text: '', files: [FILE] }),
      assistantNode({ text: '' })
    ]);
    const st = installStand(userOnly);
    const B = window.__aiCmQwenBridge;

    B.applyHistory(userOnly, { chatId: CHAT_ID, url: URL_HISTORY });
    await settle(8);
    B.applyHistory(emptyAnswer, { chatId: CHAT_ID, url: URL_HISTORY });
    await settle(8);
    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].key).toBe(RESPONSE_ID);
    expect(B.turns()[0].filesOnly).toBe(true);

    B.applyHistory(userOnly, { chatId: CHAT_ID, url: URL_HISTORY });
    await settle(8);

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].key).toBe(RESPONSE_ID);
    const d = lastEvent(st);
    expect(d.messages.filter(function (m) { return m.role === 'user'; })).toHaveLength(1);
    expect(d.messages.filter(function (m) { return m.role === 'assistant'; })).toHaveLength(0);
  });
});

// =====================================================================================
// D: content_list пуст, есть только files[] — узел должен попасть в разбор
// =====================================================================================
describe('R4 D: user-узел с пустым content_list и files[]', () => {
  test('D: content_list=[] + files → узел собран, файл в user-блоке', async () => {
    const payload = historyPayload([
      userNode({ text: '', emptyList: true, files: [FILE] }),
      assistantNode({ text: 'OK' })
    ]);
    const st = await runHistory(payload);
    const B = window.__aiCmQwenBridge;

    const parsed = B.parseQwenHistory(payload);
    expect(parsed.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(parsed.messages[0].text).toBe('');
    expect(parsed.messages[0].files).toHaveLength(1);

    expect(B.turns()).toHaveLength(1);
    const d = lastEvent(st);
    expect(d.messages[0].text).toContain('[Вложение]');
    expect(d.messages[0].text).toContain(FILE_SECTION);
    expect(d.messages[1].text).toBe('OK');
  });
});

// =====================================================================================
// E: вложение приходит в assistant-узле, а текст вопроса — в user-узле
// =====================================================================================
describe('R4 E: files[] ассистента не теряются', () => {
  test('E: user "hi" + assistant files-only → файл в user-блоке, пустого assistant нет', async () => {
    const st = await runHistory(historyPayload([
      userNode({ text: 'hi', files: [] }),
      assistantNode({ text: '', files: [FILE] })
    ]));
    const B = window.__aiCmQwenBridge;

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].filesOnly).toBe(true);
    expect(B.turns()[0].answer).toBe('');

    const d = lastEvent(st);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user']);
    expect(d.messages[0].text).toContain('hi');
    expect(d.messages[0].text).toContain(FILE_SECTION);
    expect(d.messages[0].text).toContain('Step 1: keep the turn.');
    expect(mdOf(d)).not.toContain('### ASSISTANT');
  });
});
