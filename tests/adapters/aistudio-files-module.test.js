'use strict';

/**
 * core/aistudio-files.js — контракт модуля вложений AI Studio.
 *
 * Проверяем ровно то, что обещает plan-aistudio-files.md §5-§7:
 *  - Drive API: meta (`fields=...`) и тело (`alt=media`) c Bearer, БЕЗ `key=`;
 *  - лимиты 200 000 симв./файл и маркер обрезки;
 *  - не-текстовые mime получают заглушку без второго запроса;
 *  - ошибки 403/404/пустое тело превращаются в заглушки, а не в исключения;
 *  - дебаунс 250 мс и A-лайт drain-протокол (idle/drained/timeout/reset);
 *  - токен не уходит ни в диагностику, ни в события моста.
 *
 * Песочница — vm, как в tests/adapters/qwen-files-module.test.js: тот же
 * исходник, что уезжает в MAIN-мир, без браузера и без jest-фейковых таймеров.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'aistudio-files.js'), 'utf8');

const CHAT = 'chat-1';
const TOKEN = 'ya29.' + 'a'.repeat(64);
const DRIVE = 'https://www.googleapis.com/drive/v3/files/';

function makeRes(body, over) {
  const o = over || {};
  return Object.assign({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(body)
  }, o);
}

function flush() {
  // jsdom-окружение Jest не имеет setImmediate: таймер 0 мс сливает
  // очередь микротасок песочницы так же надёжно.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHarness(over) {
  const o = over || {};
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
    location: { pathname: o.pathname || ('/prompts/' + CHAT), hostname: 'aistudio.google.com' },
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
  const sandbox = {
    window: windowObj,
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Date,
    CustomEvent: TestCustomEvent,
    AbortController,
    aiCmDiagLine: diagLine,
    aiCmDiagWarn: diagWarn
  };
  vm.createContext(sandbox);
  vm.runInContext(MODULE_SRC, sandbox, { filename: 'core/aistudio-files.js' });

  const Fn = windowObj.AiCmAistudioFiles;
  const deps = {
    emitSnapshot: jest.fn(),
    diagLine: jest.fn(),
    currentChatId: o.currentChatId === undefined ? CHAT : o.currentChatId,
    originalFetch
  };
  Fn.__bind(deps);

  return {
    Fn,
    deps,
    calls,
    events,
    diagLine,
    diagWarn,
    windowObj,
    tick,
    dispatch(type, detail) {
      windowObj.dispatchEvent(new TestCustomEvent(type, { detail }));
    },
    lastEvent(type) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === type) return events[i];
      }
      return null;
    }
  };
}

function metaRes(name, mime, size) {
  return makeRes(JSON.stringify({ name, mimeType: mime, size: String(size) }));
}

describe('AiCmAistudioFiles: Drive API и секции', () => {
  test('constants фиксируют лимиты плана', () => {
    const h = makeHarness();
    expect(h.Fn.constants).toMatchObject({
      concurrency: 2,
      textCap: 200000,
      totalCap: 2000000,
      drainTimeoutMs: 5000,
      emitDebounceMs: 250
    });
  });

  test('без токена — заглушка no-token и ни одного запроса', () => {
    const h = makeHarness();
    expect(h.Fn.afSectionsFor(['f1'], CHAT))
      .toBe('\n\n[FILE: файл f1 — текст не получен: no-token]');
    expect(h.calls.length).toBe(0);
    expect(h.Fn.afPending(CHAT)).toBe(0);
  });

  test('meta и media идут с Bearer, без key=; секция сохраняет переводы строк', async () => {
    const h = makeHarness();
    expect(h.Fn.afSetToken(TOKEN)).toBe(true);

    expect(h.Fn.afSectionsFor(['f1'], CHAT)).toBe('');
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].url).toBe(DRIVE + 'f1?fields=id,name,mimeType,size&supportsAllDrives=true');
    expect(h.calls[0].url.indexOf('key=')).toBe(-1);
    expect(h.calls[0].opts).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(h.calls[0].opts.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(h.Fn.afPending(CHAT)).toBe(1);

    h.calls[0].resolve(metaRes('a.md', 'text/markdown', 42));
    await flush();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].url).toBe(DRIVE + 'f1?alt=media&supportsAllDrives=true');

    h.calls[1].resolve(makeRes('строка1\nстрока2'));
    await flush();
    expect(h.Fn.afSectionsFor(['f1'], CHAT)).toBe('\n\n[FILE: a.md]\nстрока1\nстрока2');
    expect(h.Fn.afPending(CHAT)).toBe(1); // ре-эмит ещё в дебаунсе
    h.tick(250);
    expect(h.deps.emitSnapshot).toHaveBeenCalledTimes(1);
    expect(h.Fn.afPending(CHAT)).toBe(0);
  });

  test('403 на meta — заглушка http-403 без второго запроса', async () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['f9'], CHAT);
    h.calls[0].resolve(makeRes('', { ok: false, status: 403 }));
    await flush();
    expect(h.calls.length).toBe(1);
    expect(h.Fn.afSectionsFor(['f9'], CHAT))
      .toBe('\n\n[FILE: файл f9 — текст не получен: http-403]');
  });

  test('пустое тело media — заглушка empty-body', async () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['f2'], CHAT);
    h.calls[0].resolve(metaRes('empty.md', 'text/markdown', 0));
    await flush();
    h.calls[1].resolve(makeRes(''));
    await flush();
    expect(h.Fn.afSectionsFor(['f2'], CHAT))
      .toBe('\n\n[FILE: empty.md — текст не получен: empty-body]');
  });

  test('картинка/PDF — метаданные без alt=media', async () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['pic'], CHAT);
    h.calls[0].resolve(metaRes('pic.png', 'image/png', 202543));
    await flush();
    expect(h.calls.length).toBe(1);
    expect(h.Fn.afSectionsFor(['pic'], CHAT))
      .toBe('\n\n[FILE: pic.png — image/png, 202543 Б; текст не извлекается]');
  });

  test('cap 200 000 символов с маркером обрезки', async () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['big'], CHAT);
    h.calls[0].resolve(metaRes('big.md', 'text/markdown', 200050));
    await flush();
    h.calls[1].resolve(makeRes('x'.repeat(200050)));
    await flush();
    const section = h.Fn.afSectionsFor(['big'], CHAT);
    const body = section.replace('\n\n[FILE: big.md]\n', '');
    expect(body.length).toBe(200000);
    expect(body.endsWith('[обрезано 50]')).toBe(true);
  });

  test('повторный запрос до ответа не дублирует fetch', async () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    expect(h.Fn.afSectionsFor(['d1'], CHAT)).toBe('');
    expect(h.Fn.afSectionsFor(['d1'], CHAT)).toBe('');
    expect(h.calls.length).toBe(1);
    h.calls[0].resolve(metaRes('d.md', 'text/markdown', 3));
    await flush();
    h.calls[1].resolve(makeRes('abc'));
    await flush();
    expect(h.Fn.afSectionsFor(['d1'], CHAT)).toBe('\n\n[FILE: d.md]\nabc');
  });

  test('afNote ставит файл в очередь только при токене', () => {
    const h = makeHarness();
    expect(h.Fn.afNote(CHAT, ['n1'])).toBe(0);
    expect(h.calls.length).toBe(0);
    h.Fn.afSetToken(TOKEN);
    expect(h.Fn.afNote(CHAT, ['n1'])).toBe(1);
    expect(h.calls.length).toBe(1);
    expect(h.Fn.afNote(CHAT, ['n1'])).toBe(0);
  });
});

describe('AiCmAistudioFiles: A-лайт drain-протокол', () => {
  test('state-request отвечает pending/active/queued/texts', () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['f1'], CHAT);
    h.dispatch('ai-cm-deepseek-files-state-request', null);
    const ev = h.lastEvent('ai-cm-deepseek-files-state-response');
    expect(ev.detail).toMatchObject({ pending: 1, active: 1, queued: 1, texts: 0 });
  });

  test('drain без очереди отвечает idle сразу', () => {
    const h = makeHarness();
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'r-idle', timeoutMs: 5000 });
    const ev = h.lastEvent('ai-cm-deepseek-files-drain-done');
    expect(ev.detail).toMatchObject({
      requestId: 'r-idle', ok: true, drained: true, reason: 'idle', pending: 0
    });
  });

  test('drain ждёт дебаунс ре-эмита и завершается drained', async () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['f1'], CHAT);
    h.calls[0].resolve(metaRes('a.md', 'text/markdown', 3));
    await flush();
    h.calls[1].resolve(makeRes('abc'));
    await flush();

    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'r-ok', timeoutMs: 5000 });
    expect(h.lastEvent('ai-cm-deepseek-files-drain-done')).toBeNull();

    h.tick(250);
    const ev = h.lastEvent('ai-cm-deepseek-files-drain-done');
    expect(ev.detail).toMatchObject({
      requestId: 'r-ok', ok: true, drained: true, reason: 'drained', pending: 0
    });
  });

  test('drain timeout: заглушки reason=timeout и ре-эмит ДО drain-done', async () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['f1'], CHAT);
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'r-timeout', timeoutMs: 5000 });
    h.tick(5000);

    expect(h.deps.emitSnapshot).toHaveBeenCalledTimes(1);
    expect(h.Fn.afSectionsFor(['f1'], CHAT))
      .toBe('\n\n[FILE: файл f1 — текст не получен: timeout]');
    const ev = h.lastEvent('ai-cm-deepseek-files-drain-done');
    expect(ev.detail).toMatchObject({
      requestId: 'r-timeout', ok: false, drained: false, reason: 'timeout'
    });

    // Поздний ответ не отменяется и заменяет заглушку.
    h.calls[0].resolve(metaRes('late.md', 'text/markdown', 4));
    await flush();
    h.calls[1].resolve(makeRes('позд'));
    await flush();
    h.tick(250);
    expect(h.Fn.afSectionsFor(['f1'], CHAT)).toBe('\n\n[FILE: late.md]\nпозд');
  });

  test('afReset снимает ожидание причиной reset и чистит состояние', () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['f1'], CHAT);
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'r-reset', timeoutMs: 5000 });
    h.Fn.afReset('');

    const ev = h.lastEvent('ai-cm-deepseek-files-drain-done');
    expect(ev.detail).toMatchObject({ ok: false, reason: 'reset', pending: 0 });
    expect(h.Fn.afPending(CHAT)).toBe(0);
    expect(h.Fn.stats()).toMatchObject({ texts: 0, queued: 0, active: 0 });
  });

  test('токен не попадает в диагностику и события моста', async () => {
    const h = makeHarness();
    h.Fn.afSetToken(TOKEN);
    h.Fn.afSectionsFor(['f1'], CHAT);
    h.calls[0].resolve(metaRes('a.md', 'text/markdown', 3));
    await flush();
    h.calls[1].resolve(makeRes('abc'));
    await flush();
    h.tick(250);

    const dump = JSON.stringify(h.diagLine.mock.calls) +
      JSON.stringify(h.events) +
      JSON.stringify(h.deps.emitSnapshot.mock.calls);
    expect(dump.indexOf(TOKEN)).toBe(-1);
    expect(dump.indexOf('ya29.')).toBe(-1);
  });
});
