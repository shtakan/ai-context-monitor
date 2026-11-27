/**
 * tests/qwen-bug25-tail-pending.test.js — BUG-25: последний assistant Qwen после F5.
 *
 * Живой дефект (acceptance/BIG-2026-11/2.4/mini/firefox/qwen):
 *   • до F5 наш экспорт: 56 сообщений, финальный assistant с ответом;
 *   • после F5: 55 сообщений, финального assistant НЕТ;
 *   • родной JSON Qwen: 56 узлов, последний assistant `content=""`,
 *     `content_list=null`, `done=false`.
 *
 * Корень: parseQwenHistory видел узел, но applyHistoryPayload выбрасывал его как
 * «пустой files-only ход» (R4). Снимок объявлял себя полным, и ответ исчезал молча.
 *
 * Контракт фикса:
 *   • `done=false` — это НЕ пустой завершённый ход: turn сохраняется с `pending`,
 *     в messages/файле остаётся assistant-блок (пустой, как в родном экспорте Qwen);
 *   • снимок/файл получает `tailPending` → `partialReason=history-not-finalized`;
 *   • завершённый пустой assistant (R4, `done` не false) по-прежнему не даёт блока;
 *   • когда история дописывается (`done=true`, текст), pending снимается.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Builders = require('./helpers/load-esm.js').loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
const { derivePartial, PARTIAL_REASONS } = require('../utils/export/completeness.ts');
const { makeProbe } = require('./helpers/process-and-send-probe.js');
const { loadAsClassic } = require('./helpers/load-esm.js');

const QWEN_CLASSIC = loadAsClassic('core/qwen-intercept.js');
const DEBUG_SRC = loadAsClassic('utils/debug.ts');
const QWEN_FILES_SRC = loadAsClassic('core/qwen-files.js');
const NATIVE_FIXTURE = path.join(
  __dirname, '..', '..',
  'acceptance', 'BIG-2026-11', '2.4', 'mini', 'firefox', 'qwen',
  'chat-export-1795778412430.json'
);

const CHAT_ID = 'ab45dc99-cbab-435e-b0d3-f0440f6422df';
const URL_PAGE = 'https://chat.qwen.ai/api/v2/chats/' + CHAT_ID + '?direction=up&limit=10';
const URL_FULL = 'https://chat.qwen.ai/api/v2/chats/' + CHAT_ID;
const USER_ID = 'user-bug25-0001';
const ASSISTANT_ID = 'assistant-bug25-0001';
const RESPONSE_ID = 'resp-bug25-0001';

const FILE = {
  id: 'file-bug25',
  name: 'pdf-fixture.pdf',
  file_type: 'application/pdf',
  size: 628,
  status: 'uploaded',
  type: 'file',
  file_class: 'document'
};

function userNode() {
  return {
    id: USER_ID,
    fid: 'fid-bug25',
    role: 'user',
    content_list: [{ phase: 'answer', status: 'finished', content: 'Прочитай PDF и назови маркер' }],
    files: [FILE]
  };
}

function assistantNode(opts) {
  const o = opts || {};
  const node = {
    id: ASSISTANT_ID,
    response_id: RESPONSE_ID,
    role: 'assistant',
    content_list: o.text ? [{ phase: 'answer', status: 'finished', content: o.text }] : null,
    content: o.text || ''
  };
  if (o.done !== undefined) node.done = o.done;
  return node;
}

function historyPayload(nodes) {
  return { data: { chat_id: CHAT_ID, chat: { history: { messages: nodes } } } };
}

/** Полный документ: history.messages — словарь по id + currentId (путь Stage 6). */
function historyPayloadFull(nodes) {
  const byId = {};
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const copy = Object.assign({}, n);
    copy.parentId = (i === 0) ? null : nodes[i - 1].id;
    byId[n.id] = copy;
  }
  return {
    data: {
      chat_id: CHAT_ID,
      chat: { history: { messages: byId, currentId: nodes[nodes.length - 1].id } }
    }
  };
}

function installStand() {
  new Function('window', 'self', DEBUG_SRC)(window, window);
  if (!window.AiCmQwenFiles) new Function('window', 'self', QWEN_FILES_SRC)(window, window);
  window.AiCmQwenFiles.qfReset(CHAT_ID);

  const events = [];
  window.addEventListener('ai-cm-full-history', function (ev) { events.push(ev.detail); });
  // Очередь вложений не должна ходить в реальную сеть: 404 → файл просто не попадёт
  // секцией, на состав ходов это не влияет.
  window.fetch = function () {
    return Promise.resolve({ ok: false, status: 404, headers: { get: function () { return null; } } });
  };
  jest.spyOn(console, 'log').mockImplementation(function () { });
  jest.spyOn(console, 'warn').mockImplementation(function () { });
  delete window.__aiCmQwenInterceptInstalled;
  new Function(QWEN_CLASSIC)();
  return { events: events };
}

function settle(rounds) {
  let p = Promise.resolve();
  for (let i = 0; i < (rounds || 6); i++) {
    p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  }
  return p;
}

async function apply(payload, meta) {
  const st = installStand();
  window.__aiCmQwenBridge.applyHistory(payload, Object.assign({ chatId: CHAT_ID }, meta || {}));
  await settle(6);
  return st;
}

function lastEvent(st) {
  expect(st.events.length).toBeGreaterThan(0);
  return st.events[st.events.length - 1];
}

beforeAll(function () {
  window.history.replaceState({}, '', '/c/' + CHAT_ID);
});

afterEach(function () {
  jest.restoreAllMocks();
});

describe('BUG-25: done=false хвост истории не теряется молча', () => {
  test('страница истории: pending assistant сохраняется, снимок несёт tailPending', async () => {
    const st = await apply(historyPayload([userNode(), assistantNode({ done: false })]), { url: URL_PAGE });
    const B = window.__aiCmQwenBridge;

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].pending).toBe(true);
    expect(B.turns()[0].filesOnly).toBe(false);

    const d = lastEvent(st);
    expect(d.count).toBe(2);
    expect(d.historyComplete).toBe(true);          // история прочитана полностью
    expect(d.tailPending).toBe(true);              // но последний ответ ещё не финализирован
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(d.messages[1].text).toBe('');           // как в родном экспорте Qwen (пустой блок)

    const snap = B.exportSnapshot();
    expect(snap.count).toBe(2);
    expect(snap.tailPending).toBe(true);
    expect(snap.messages[1]).toEqual({ role: 'assistant', text: '', reasoning: '' });

    // В файле виден и пустой ASSISTANT-блок, и машинная причина частичности.
    const md = Builders.buildMdFromHistory({
      site: 'qwen', partial: true, partialReason: 'history-not-finalized', messages: snap.messages
    }, 'Qwen');
    expect(md).toContain('metric-partial: 1');
    expect(md).toContain('metric-partial-reason: history-not-finalized');
    expect(md).toContain('### ASSISTANT');
    const json = JSON.parse(Builders.buildJsonFromHistory({
      site: 'qwen', partial: true, partialReason: 'history-not-finalized', messages: snap.messages
    }, 'Qwen'));
    expect(json.partial).toBe(true);
    expect(json.partialReason).toBe('history-not-finalized');
    expect(json.messages).toHaveLength(2);
  });

  test('полная нативная история: pending узел не отбрасывается native-цепочкой', async () => {
    const st = await apply(historyPayloadFull([userNode(), assistantNode({ done: false })]), {
      url: URL_FULL, full: true
    });
    const B = window.__aiCmQwenBridge;
    const snap = B.exportSnapshot();

    expect(snap.native).not.toBeNull();
    expect(snap.native.nodes).toHaveLength(2);
    expect(snap.native.nodes[1].role).toBe('assistant');
    expect(snap.native.nodes[1].pending).toBe(true);
    expect(snap.count).toBe(2);
    expect(snap.tailPending).toBe(true);
    expect(lastEvent(st).tailPending).toBe(true);
  });

  test('история дописалась (done=true + текст): pending снимается, ответ в файле', async () => {
    const st = installStand();
    const B = window.__aiCmQwenBridge;

    B.applyHistory(historyPayload([userNode(), assistantNode({ done: false })]), { chatId: CHAT_ID, url: URL_PAGE });
    await settle(4);
    expect(B.exportSnapshot().tailPending).toBe(true);

    B.applyHistory(historyPayload([userNode(), assistantNode({ done: true, text: 'Маркер: MARKER-7F3A9C' })]), {
      chatId: CHAT_ID, url: URL_PAGE
    });
    await settle(6);

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].pending).toBeUndefined();
    expect(B.turns()[0].answer).toBe('Маркер: MARKER-7F3A9C');
    const snap = B.exportSnapshot();
    expect(snap.tailPending).toBe(false);
    expect(snap.messages).toHaveLength(2);
    expect(snap.messages[1].text).toBe('Маркер: MARKER-7F3A9C');
    expect(lastEvent(st).tailPending).toBe(false);
  });

  test('R4 не сломан: завершённый пустой assistant (done не false) по-прежнему без блока', async () => {
    const st = await apply(historyPayload([userNode(), assistantNode({})]), { url: URL_PAGE });
    const B = window.__aiCmQwenBridge;
    const d = lastEvent(st);

    expect(B.turns()).toHaveLength(1);
    expect(B.turns()[0].filesOnly).toBe(true);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user']);
    expect(d.tailPending).toBe(false);
    expect(B.exportSnapshot().tailPending).toBe(false);
  });

  const hasNative = fs.existsSync(NATIVE_FIXTURE);
  (hasNative ? test : test.skip)('реальный Qwen export 16:20: 56 сообщений, хвост done=false сохранён', async () => {
    const root = JSON.parse(fs.readFileSync(NATIVE_FIXTURE, 'utf8'));
    const history = root[0].chat.history;
    const payload = {
      data: {
        chat_id: CHAT_ID,
        chat: { history: { messages: history.messages, currentId: history.currentId } }
      }
    };
    await apply(payload, { url: URL_FULL, full: true });
    const B = window.__aiCmQwenBridge;
    const snap = B.exportSnapshot();

    expect(snap.count).toBe(56);                       // было 55 после F5
    expect(snap.tailPending).toBe(true);
    expect(snap.messages).toHaveLength(56);
    expect(snap.messages[55].role).toBe('assistant');
    expect(snap.messages[55].text).toBe('');
    expect(snap.native).not.toBeNull();
    expect(snap.native.nodes).toHaveLength(56);
    expect(snap.native.nodes[55].pending).toBe(true);
  });
});

describe('BUG-25: словарь partialReason и снимок', () => {
  test('history-not-finalized — легальная причина частичности', () => {
    expect(PARTIAL_REASONS).toContain('history-not-finalized');
    expect(derivePartial({ partial: true, partialReason: 'history-not-finalized' }))
      .toEqual({ partial: true, partialReason: 'history-not-finalized' });
  });

  test('processAndSend: причина tailPending поднимает partial, не понижая baseComplete', () => {
    const p = makeProbe({
      state: {
        site: 'qwen',
        baseComplete: true,
        baseCompleteReason: 'history-not-finalized',
        partial: false
      }
    });
    const r = p.run();

    expect(r.commit).not.toBeNull();
    expect(r.commit.baseComplete).toBe(true);       // база истории прочитана полностью
    expect(r.commit.partial).toBe(true);            // но файл не объявляет себя полным
    expect(r.commit.partialReason).toBe('history-not-finalized');
  });
});
