'use strict';

/**
 * AI Studio: сквозная связка «перехватчик → модуль вложений → дренаж».
 *
 * Один vm-контекст, в котором сначала грузится core/aistudio-intercept.js,
 * затем core/aistudio-files.js — ровно тот порядок, что в core/background.js
 * (plan-aistudio-files.md §8). Так проверяется ленивый __bind: перехватчик
 * обязан привязать модуль при первом обращении, а не на загрузке.
 *
 * Сценарии повторяют приёмку §12: две секции [FILE: …] в хвосте USER-блоков,
 * служебные ходы не попадают, чат без вложений остаётся байтово прежним,
 * drain отвечает idle/drained/timeout, токен не уходит в диагностику.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextDecoder } = require('util');

const ROOT = path.join(__dirname, '..', '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'aistudio-intercept.js'), 'utf8');
const FILES_SRC = fs.readFileSync(path.join(ROOT, 'core', 'aistudio-files.js'), 'utf8');

const CHAT = '1gHphBl1b-Km9KknOAD5t2fJ3mfec8T3g';
const MAKER_SUITE = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/';
const TOKEN_URL = MAKER_SUITE + 'GenerateAccessToken';
const HISTORY_URL = MAKER_SUITE + 'ResolveDriveResource';
const ID1 = '17NuA9ExvAranPM4iHwzfPP0tZK0YKKkv';
const ID2 = '1kX4sI1HL2C8bbLeG0KSr5rFe7mQBTtaH';
const NAME1 = 'ai-context-monitor-aistudio-Gemini-3.8-Flash-2026-10-27-18-24.md';
const NAME2 = 'ai-context-monitor-aistudio-Gemini-3.8-Flash-2026-10-27-19-03.md';
const TOKEN = 'ya29.' + 'T'.repeat(260);

function makeRes(body, over) {
  const o = over || {};
  return Object.assign({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(body)
  }, o);
}

function metaRes(name, mime, size) {
  return makeRes(JSON.stringify({ name, mimeType: mime, size: String(size) }));
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Строка снимка: 33 поля, как в tests/adapters/aistudio-network.test.js. */
function snapshotRow(text, role, opts) {
  const o = opts || {};
  const m = new Array(33).fill(null);
  m[0] = text;
  m[8] = role;
  if (o.reasoning) m[19] = 1;
  if (o.files) m[3] = o.files;
  m[32] = ['1793095607', 981000000];
  return m;
}

/** Ответ истории: root[13][0] = строки ходов. */
function snapshotBody(rows) {
  const data = new Array(13).fill(null);
  data[0] = 'prompts/' + CHAT;
  data[12] = [];
  data.push([rows, [['', null, null, null, null, null, null, null, 'user']]]);
  return JSON.stringify(data);
}

function makeStack() {
  const listeners = Object.create(null);
  const events = [];
  const clock = { now: 0, seq: 0, timers: [] };

  function fakeSetTimeout(fn, ms) {
    const t = { id: ++clock.seq, at: clock.now + (Number(ms) || 0), fn, cancelled: false };
    clock.timers.push(t);
    return t;
  }
  function fakeClearTimeout(t) {
    if (t && typeof t === 'object') t.cancelled = true;
  }
  function tick(ms) {
    const target = clock.now + (Number(ms) || 0);
    for (let guard = 0; guard < 1000; guard++) {
      clock.timers = clock.timers.filter((t) => !t.cancelled);
      const due = clock.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.timers = clock.timers.filter((t) => t !== due);
      clock.now = due.at;
      due.fn();
    }
    clock.now = target;
  }

  const calls = [];
  const originalFetch = jest.fn((url, opts) => new Promise((resolve) => {
    calls.push({ url, opts, resolve });
  }));

  class TestCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init ? init.detail : undefined;
    }
  }

  const windowObj = {
    location: {
      hostname: 'aistudio.google.com',
      pathname: '/prompts/' + CHAT,
      href: 'https://aistudio.google.com/prompts/' + CHAT
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    dispatchEvent(ev) {
      events.push({ type: ev.type, detail: ev.detail });
      (listeners[ev.type] || []).slice().forEach((fn) => fn(ev));
      return true;
    },
    fetch: originalFetch
  };

  const diagLine = jest.fn();
  const diagWarn = jest.fn();
  const swallowSoft = jest.fn();
  const sandbox = {
    window: windowObj,
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Date,
    CustomEvent: TestCustomEvent,
    AbortController,
    TextDecoder,
    aiCmDiagLine: diagLine,
    aiCmDiagWarn: diagWarn,
    swallowSoft
  };
  vm.createContext(sandbox);
  vm.runInContext(INTERCEPT_SRC, sandbox, { filename: 'core/aistudio-intercept.js' });
  vm.runInContext(FILES_SRC, sandbox, { filename: 'core/aistudio-files.js' });

  const api = windowObj.AiCmAistudioIntercept;
  const files = windowObj.AiCmAistudioFiles;

  function historyEvents() {
    const out = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].type !== 'ai-cm-aistudio-net') continue;
      let d = events[i].detail;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (eP) { continue; }
      }
      if (d && d.kind === 'history') out.push(d);
    }
    return out;
  }

  function drainEvents() {
    return events.filter((e) => e.type === 'ai-cm-deepseek-files-drain-done');
  }

  return {
    api,
    files,
    calls,
    events,
    diagLine,
    diagWarn,
    windowObj,
    tick,
    historyEvents,
    drainEvents,
    dispatch(type, detail) {
      windowObj.dispatchEvent(new TestCustomEvent(type, { detail }));
    }
  };
}

const TWO_FILE_ROWS = [
  snapshotRow(null, 'user'),                        // служебный ход — дроп
  snapshotRow(null, 'user', { files: [ID1] }),      // вложение 1
  snapshotRow('Первый промпт', 'user'),
  snapshotRow('Ответ 1', 'model'),
  snapshotRow(null, 'user'),                        // служебный ход — дроп
  snapshotRow(null, 'user', { files: [ID2] }),      // вложение 2
  snapshotRow('Второй промпт', 'user'),
  snapshotRow('Ответ 2', 'model')
];

describe('AI Studio: вложения в снимке истории', () => {
  test('GenerateAccessToken доезжает до модуля, токен не логируется', () => {
    const h = makeStack();
    expect(h.api.__handlers.isTokenRpc(TOKEN_URL)).toBe(true);
    expect(h.api.__handlers.tokenFromBody(JSON.stringify([TOKEN]))).toBe(TOKEN);

    h.api.__handlers.handleResponse(TOKEN_URL, JSON.stringify([TOKEN]));
    expect(h.files.stats().token).toBe('set');
    expect(h.events.length).toBe(0);

    const dump = JSON.stringify(h.diagLine.mock.calls);
    expect(dump).toContain('aistudio-auth-token');
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('ya29.');
  });

  test('две строки-вложения уходят в хвост USER-блоков, служебные ходы не попадают', async () => {
    const h = makeStack();
    h.api.__handlers.handleResponse(TOKEN_URL, JSON.stringify([TOKEN]));
    h.api.__handlers.handleResponse(HISTORY_URL, snapshotBody(TWO_FILE_ROWS));

    const first = h.historyEvents();
    expect(first.length).toBe(1);
    expect(first[0].msgs.length).toBe(4);
    expect(first[0].msgs[0]).toEqual({
      role: 'user', text: 'Первый промпт', files: [ID1]
    });
    expect(first[0].msgs[0].sections).toBeUndefined();
    expect(first[0].msgs[2]).toEqual({
      role: 'user', text: 'Второй промпт', files: [ID2]
    });
    expect(h.calls.length).toBe(2); // по одному meta-запросу на файл

    const media1 = h.calls.find((c) => c.url.indexOf(ID1) !== -1 && c.url.indexOf('alt=media') !== -1);
    const media2 = h.calls.find((c) => c.url.indexOf(ID2) !== -1 && c.url.indexOf('alt=media') !== -1);
    expect(media1).toBeUndefined();

    h.calls[0].resolve(metaRes(NAME1, 'text/markdown', 10476));
    h.calls[1].resolve(metaRes(NAME2, 'text/markdown', 28246));
    await flush();
    expect(h.calls.length).toBe(4);

    const m1 = h.calls.find((c) => c.url.indexOf(ID1) !== -1 && c.url.indexOf('alt=media') !== -1);
    const m2 = h.calls.find((c) => c.url.indexOf(ID2) !== -1 && c.url.indexOf('alt=media') !== -1);
    m1.resolve(makeRes('# Protocol\n\nстрока A\nстрока B'));
    m2.resolve(makeRes('# Второй файл\n\nстрока C'));
    await flush();
    h.tick(250);

    const hist = h.historyEvents();
    expect(hist.length).toBe(2);
    const second = hist[1];
    expect(second.msgs.length).toBe(4);
    expect(second.msgs[0].sections).toContain('\n\n[FILE: ' + NAME1 + ']\n');
    expect(second.msgs[0].sections).toContain('строка A\nстрока B');
    expect(second.msgs[2].sections).toContain('\n\n[FILE: ' + NAME2 + ']\n');
    expect(second.msgs[2].sections).toContain('строка C');
    expect(second.msgs[1].sections).toBeUndefined();
    expect(second.msgs.every((m) => (typeof m.text === 'string' && m.text.length > 0) ||
      (typeof m.sections === 'string' && m.sections.length > 0))).toBe(true);
    expect(h.files.afPending('')).toBe(0);
  });

  test('чат без вложений: подпись и сообщения прежние, лишних полей нет', () => {
    const h = makeStack();
    h.api.__handlers.handleResponse(HISTORY_URL, snapshotBody([
      snapshotRow('Привет', 'user'),
      snapshotRow('Здравствуйте', 'model')
    ]));

    const hist = h.historyEvents();
    expect(hist.length).toBe(1);
    expect(hist[0].msgs).toEqual([
      { role: 'user', text: 'Привет' },
      { role: 'assistant', text: 'Здравствуйте' }
    ]);
    expect(hist[0].msgs[0].files).toBeUndefined();
    expect(hist[0].msgs[0].sections).toBeUndefined();
    expect(h.calls.length).toBe(0);
    expect(h.files.afPending('')).toBe(0);
    expect(h.files.stats().texts).toBe(0);
  });

  test('drain timeout: заглушка timeout попадает в снимок ДО drain-done', async () => {
    const h = makeStack();
    h.api.__handlers.handleResponse(TOKEN_URL, JSON.stringify([TOKEN]));
    h.api.__handlers.handleResponse(HISTORY_URL, snapshotBody([
      snapshotRow(null, 'user', { files: [ID1] }),
      snapshotRow('Промпт', 'user'),
      snapshotRow('Ответ', 'model')
    ]));
    expect(h.calls.length).toBe(1);

    h.dispatch('ai-cm-deepseek-files-drain', JSON.stringify({ requestId: 'req-1', timeoutMs: 5000 }));
    h.tick(5000);

    const hist = h.historyEvents();
    expect(hist.length).toBe(2);
    expect(hist[1].msgs[0].sections).toContain('текст не получен: timeout');
    const done = h.drainEvents();
    expect(done.length).toBe(1);
    expect(done[0].detail).toMatchObject({
      requestId: 'req-1', ok: false, drained: false, reason: 'timeout'
    });

    let idxLastHist = -1;
    h.events.forEach((e, i) => {
      if (e.type !== 'ai-cm-aistudio-net' || typeof e.detail !== 'string') return;
      if (JSON.parse(e.detail).kind === 'history') idxLastHist = i;
    });
    const idxDone = h.events.findIndex((e) => e.type === 'ai-cm-deepseek-files-drain-done');
    expect(idxLastHist).toBeGreaterThan(-1);
    expect(idxLastHist).toBeLessThan(idxDone);

    // Поздний ответ заменяет заглушку и пересобирает снимок ещё раз.
    h.calls[0].resolve(metaRes(NAME1, 'text/markdown', 10476));
    await flush();
    h.calls[1].resolve(makeRes('поздний текст'));
    await flush();
    h.tick(250);
    const late = h.historyEvents();
    expect(late.length).toBe(3);
    expect(late[2].msgs[0].sections).toContain('поздний текст');
  });
});

describe('AI Studio: статические пины проводки', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('base-handler признаёт aistudio сайтом очереди файлов', () => {
    expect(read('core/base-handler.js'))
      .toContain("site === 'deepseek' || site === 'qwen' || site === 'aistudio'");
  });

  test('background регистрирует модуль после перехватчика', () => {
    const bg = read('core/background.js');
    expect(bg).toContain("'ai-cm-aistudio-intercept-v2'");
    expect(bg).toContain("unregisterContentScripts({ ids: ['ai-cm-aistudio-intercept'] })");
    expect(bg).toContain("'core/aistudio-files.js'");
    expect(bg.indexOf("'core/aistudio-intercept.js'")).toBeLessThan(bg.indexOf("'core/aistudio-files.js'"));
  });

  test('адаптер дописывает секции после _cleanText (оба пути)', () => {
    const src = read('adapters/aistudio-adapter.js');
    const hits = src.split('this._cleanText(rec.text) + sections;').length - 1;
    expect(hits).toBe(2);
  });

  test('content сохраняет sections в снимке', () => {
    expect(read('core/content.js')).toContain('if (sections) rec.sections = sections;');
  });

  test('перехватчик спрашивает секции и прокидывает токен', () => {
    const src = read('core/aistudio-intercept.js');
    expect(src).toContain('annotateFileSections(msgs);');
    expect(src).toContain('api.afSectionsFor(m.files, cid)');
    expect(src).toContain('api.afSetToken(tok)');
  });
});
