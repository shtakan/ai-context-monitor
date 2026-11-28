/**
 * tests/qwen-live-tail-journal.test.js — BUG-25 follow-up:
 * per-conversation журнал последнего живого хода Qwen в chrome.storage.local.
 *
 * Контракт:
 *   • save: завершённый live-ход (answer/reasoning) пишется в ключ
 *     aiCmLiveTail:qwen:<convId>, без URL/JWT/вложений;
 *   • restore: запись возвращается событием ai-cm-qwen-live-tail-restore;
 *   • TTL 24 ч: старая запись не отдаётся и удаляется;
 *   • clear: удаляет запись только при совпадении responseId.
 *
 * Стенд — РЕАЛЬНЫЙ core/content-archive.js (ISOLATED-модуль) с фейковым
 * chrome.storage.local; MAIN-перехватчик не нужен.
 */
'use strict';

const { loadAsClassic } = require('./helpers/load-esm.js');

const CHAT_ID = 'live-tail-chat-0001';
const KEY = 'aiCmLiveTail:qwen:' + CHAT_ID;

let store;
let restoreEvents;
let api;

beforeAll(function () {
  jest.useFakeTimers();
  store = {};
  restoreEvents = [];
  const fakeChrome = {
    storage: {
      local: {
        set: function (obj, cb) { Object.assign(store, obj); if (cb) cb(); },
        get: function (keys, cb) {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          cb(out);
        },
        remove: function (key, cb) { delete store[key]; if (cb) cb(); }
      }
    },
    runtime: { lastError: null }
  };
  const src = loadAsClassic('core/content-archive.js') +
    '\nreturn { restore: aiCmLiveTailRestore };';
  api = new Function(
    'window', 'chrome', 'currentAdapter', 'getCurrentConvId',
    'debugLog', 'swallowSoft', 'setTimeout',
    src
  )(
    window, fakeChrome, { siteName: 'qwen' }, function () { return CHAT_ID; },
    function () { }, function () { }, setTimeout
  );
  window.addEventListener('ai-cm-qwen-live-tail-restore', function (ev) {
    restoreEvents.push(JSON.parse(String(ev.detail)));
  });
});

afterAll(function () {
  jest.useRealTimers();
});

beforeEach(function () {
  for (const k of Object.keys(store)) delete store[k];
  restoreEvents.length = 0;
});

function liveTurn(over) {
  return Object.assign({
    v: 1,
    site: 'qwen',
    chatId: CHAT_ID,
    responseId: 'resp-live-1',
    userKey: 'fid-live-1',
    userPrompt: 'Прочитай PDF и назови маркер',
    answer: 'Маркер: MARKER-7F3A9C',
    reasoning: 'Короткая мысль.',
    model: 'qwen3.8-omni-flash',
    ts: Date.now()
  }, over || {});
}

describe('BUG-25 live-tail journal: chrome.storage.local', () => {
  test('save → restore: текст и responseId возвращаются в MAIN', function () {
    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail', {
      detail: JSON.stringify(liveTurn())
    }));

    expect(store[KEY]).toBeTruthy();
    expect(store[KEY].answer).toBe('Маркер: MARKER-7F3A9C');
    expect(store[KEY].responseId).toBe('resp-live-1');
    expect(JSON.stringify(store[KEY])).not.toContain('http');
    expect(JSON.stringify(store[KEY])).not.toContain('key=');

    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail-request'));
    expect(restoreEvents).toHaveLength(1);
    expect(restoreEvents[0].answer).toBe('Маркер: MARKER-7F3A9C');
    expect(restoreEvents[0].chatId).toBe(CHAT_ID);
  });

  test('повторный restore читает журнал (поздний старт адаптера)', function () {
    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail', {
      detail: JSON.stringify(liveTurn())
    }));
    expect(restoreEvents).toHaveLength(0);

    api.restore();
    expect(restoreEvents).toHaveLength(1);
    expect(restoreEvents[0].answer).toBe('Маркер: MARKER-7F3A9C');
  });

  test('TTL: запись старше 24 ч не отдаётся и удаляется', function () {
    store[KEY] = liveTurn({ ts: Date.now() - 25 * 60 * 60 * 1000 });
    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail-request'));
    expect(restoreEvents).toHaveLength(0);
    expect(store[KEY]).toBeUndefined();
  });

  test('clear: чужой responseId не удаляет, свой — удаляет', function () {
    store[KEY] = liveTurn({ responseId: 'resp-live-1' });

    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail-clear', {
      detail: JSON.stringify({ chatId: CHAT_ID, responseId: 'resp-other' })
    }));
    expect(store[KEY]).toBeTruthy();

    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail-clear', {
      detail: JSON.stringify({ chatId: CHAT_ID })
    }));
    expect(store[KEY]).toBeTruthy();

    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail-clear', {
      detail: JSON.stringify({ chatId: CHAT_ID, responseId: 'resp-live-1' })
    }));
    expect(store[KEY]).toBeUndefined();
  });

  test('save: пустой ответ не пишется; запись другого чата не подхватывается', function () {
    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail', {
      detail: JSON.stringify(liveTurn({ answer: '', reasoning: '' }))
    }));
    expect(store[KEY]).toBeUndefined();

    store[KEY] = liveTurn({ chatId: 'other-chat' });
    window.dispatchEvent(new window.CustomEvent('ai-cm-qwen-live-tail-request'));
    expect(restoreEvents).toHaveLength(0);
  });
});
