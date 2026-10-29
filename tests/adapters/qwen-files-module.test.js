/**
 * tests/adapters/qwen-files-module.test.js — R2: экспорт вложений Qwen с текстом.
 *
 * Контракт core/qwen-files.js: нормализация files[] (url/id/name/mime/size/isImage/status),
 * FIFO-очередь текста вложений (concurrency 2, дедуп `chatId|fileKey`), fetch тела через
 * originalFetch с credentials:'omit' и таймаутом 10 с, жёсткий кап 200 000 символов на файл
 * и 2 000 000 на чат, секции «[FILE: имя]\n<текст>» / «[FILE: имя — текст не получен: reason]»,
 * дебаунс-ре-эмит базы (250 мс) и протокол A-лайт (state-request/response, drain/done).
 *
 * ОТДЕЛЬНО и жёстко: URL файла (в нём JWT-подпись) НЕ попадает в текст экспорта ни при
 * каком исходе — это требование приватности задачи.
 *
 * Плюс source-пины связки: перехватчик ставит файлы в очередь, дописывает секции только в
 * пользовательский блок, включает длину секций в buildSignature и сбрасывает состояние на
 * смене чата; background регистрирует модуль ПЕРЕД перехватчиком; экспорт ждёт очередь.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'qwen-files.js'), 'utf8');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

const CHAT = 'chat-1';
const URL_MD = 'https://cdn.qwenlm.ai/u1/f1_%D0%9F%D1%80%D0%BE%D1%82%D0%BE%D0%BA%D0%BE%D0%BB.md?key=JWT.SIGNATURE';

// ---- песочница: свой клок, свой window, свой fetch (без jest-таймеров) ---------------
function makeHarness(over) {
  over = over || {};
  const listeners = {};
  const events = [];
  const windowObj = {
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: function (type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent: function (ev) {
      events.push({ type: ev && ev.type, detail: ev && ev.detail });
      const list = (listeners[ev && ev.type] || []).slice();
      for (let i = 0; i < list.length; i++) list[i](ev);
      return true;
    },
    fetch: null
  };

  const fetchCalls = [];
  const originalFetch = jest.fn(function (url, opts) {
    let settle;
    const p = new Promise(function (resolve) { settle = resolve; });
    fetchCalls.push({ url: url, opts: opts, resolve: settle });
    return p;
  });
  windowObj.fetch = over.noFetch ? null : originalFetch;

  const clock = { now: 0 };
  const timers = [];
  function fakeSetTimeout(fn, ms) {
    const t = { at: clock.now + (ms || 0), fn: fn };
    timers.push(t);
    return t;
  }
  function fakeClearTimeout(t) {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  }
  function tick(ms) {
    const target = clock.now + ms;
    for (;;) {
      let best = null;
      for (let i = 0; i < timers.length; i++) {
        if (timers[i].at <= target && (!best || timers[i].at < best.at)) best = timers[i];
      }
      if (!best) break;
      timers.splice(timers.indexOf(best), 1);
      clock.now = best.at;
      best.fn();
    }
    clock.now = target;
  }

  class TestCustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
  }

  const sandbox = {
    window: windowObj,
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Date: Date,
    CustomEvent: TestCustomEvent,
    AbortController: AbortController,
    aiCmDiagWarn: jest.fn(),
    aiCmDiagLine: jest.fn()
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(MODULE_SRC, ctx, { filename: 'core/qwen-files.js' });
  const Fn = sandbox.window.AiCmQwenFiles;

  const deps = Object.assign({
    emitSnapshot: jest.fn(),
    diagLine: jest.fn(),
    currentChatId: CHAT,
    originalFetch: over.noFetch ? null : originalFetch,
    lastEmitMeta: { tokens: 1709, complete: true, chatId: CHAT, responseId: 'resp-1' }
  }, over.deps || {});

  if (over.bind !== false) Fn.__bind(deps);

  return {
    Fn: Fn,
    deps: deps,
    windowObj: windowObj,
    listeners: listeners,
    events: events,
    fetchCalls: fetchCalls,
    originalFetch: originalFetch,
    tick: tick,
    sandbox: sandbox,
    dispatch: function (type, detail) {
      return windowObj.dispatchEvent(new TestCustomEvent(type, { detail: detail }));
    },
    findEvents: function (type) { return events.filter(function (e) { return e.type === type; }); },
    lastEvent: function (type) {
      const list = events.filter(function (e) { return e.type === type; });
      return list.length ? list[list.length - 1] : null;
    }
  };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function makeRes(spec) {
  spec = spec || {};
  const headers = spec.headers || {};
  return {
    ok: spec.ok !== false,
    status: (typeof spec.status === 'number') ? spec.status : 200,
    headers: { get: function (n) { const k = String(n || '').toLowerCase(); return (k in headers) ? headers[k] : null; } },
    text: function () { return Promise.resolve(spec.body || ''); }
  };
}

function textFile(over) {
  return Object.assign({
    id: 'f1',
    name: 'Протокол.md',
    url: URL_MD,
    file_type: 'text/markdown',
    size: 514967,
    status: 'uploaded',
    type: 'file'
  }, over || {});
}

/** Текст секции вложения без служебного префикса «[FILE: имя]\n». */
function bodyOf(section) {
  const i = section.indexOf(']\n');
  return i === -1 ? '' : section.slice(i + 2);
}

describe('R2: нормализация node.files[]', function () {
  test('живая форма: id/name/url/file_type/size/status/type', function () {
    const h = makeHarness();
    const ref = h.Fn.refFromEntry(textFile());
    expect(ref).toEqual({
      url: URL_MD,
      id: 'f1',
      name: 'Протокол.md',
      mime: 'text/markdown',
      size: 514967,
      isImage: false,
      status: 'uploaded',
      fileKey: 'f1'
    });
  });

  test('защитная форма: id/имя/mime/size из вложенного o.file.*', function () {
    const h = makeHarness();
    const ref = h.Fn.refFromEntry({
      file: { id: 77, filename: 'protocol.md', meta: { content_type: 'text/markdown', size: '8243' } }
    });
    expect(ref.id).toBe('77');
    expect(ref.name).toBe('protocol.md');
    expect(ref.mime).toBe('text/markdown');
    expect(ref.size).toBe(8243);
    expect(ref.fileKey).toBe('77');
  });

  test('картинка распознаётся по type, file_class и mime', function () {
    const h = makeHarness();
    expect(h.Fn.refFromEntry({ id: 'a', name: 'a.png', type: 'image' }).isImage).toBe(true);
    expect(h.Fn.refFromEntry({ id: 'b', name: 'b.bin', file_class: 'vision' }).isImage).toBe(true);
    expect(h.Fn.refFromEntry({ id: 'c', name: 'c.webp', file_type: 'image/webp' }).isImage).toBe(true);
  });

  test('мусорные записи отсекаются, имя-фолбэк не пустое', function () {
    const h = makeHarness();
    expect(h.Fn.refFromEntry(null)).toBeNull();
    expect(h.Fn.refFromEntry('file')).toBeNull();
    // ни имени, ни id, ни url — записи не существует
    expect(h.Fn.refFromEntry({})).toBeNull();
    // url есть, имени нет — фолбэк, чтобы секция не осталась безымянной
    expect(h.Fn.refFromEntry({ url: URL_MD }).name).toBe('attachment');
  });

  test('текстовость: MIME первый признак, расширение — второй (CDN отдаёт octet-stream)', function () {
    const h = makeHarness();
    expect(h.Fn.isTextual({ mime: 'text/plain', name: 'a.bin' })).toBe(true);
    expect(h.Fn.isTextual({ mime: 'application/octet-stream', name: 'Протокол.md' })).toBe(true);
    expect(h.Fn.isTextual({ mime: 'application/octet-stream', name: 'data.jsonl' })).toBe(true);
    expect(h.Fn.isTextual({ mime: 'application/pdf', name: 'spec.pdf' })).toBe(false);
    expect(h.Fn.isTextual({ mime: 'image/png', name: 'photo.png' })).toBe(false);
  });
});

describe('R2: очередь — картинки и нетекстовые не качаются', function () {
  test('image/PDF получают метку с типом и размером, в очередь идёт только текст', async function () {
    const h = makeHarness();
    const queued = h.Fn.enqueueUserFiles(CHAT, 'u-1', [
      { id: 'img', name: 'photo.png', file_type: 'image/png', size: 202543, type: 'image', status: 'uploaded' },
      { id: 'pdf', name: 'spec.pdf', file_type: 'application/pdf', size: 5000, status: 'uploaded' },
      textFile()
    ]);
    expect(queued).toBe(1);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toBe(URL_MD);

    const sec = h.Fn.sectionsFor(CHAT, 'u-1');
    expect(sec).toContain('[FILE: photo.png — image/png, 202543 Б; изображение не выгружается]');
    expect(sec).toContain('[FILE: spec.pdf — application/pdf, 5000 Б; текст не извлекается]');
    // незавершённый файл в базу НЕ пишется: экспорт ждёт очередь (drain) и только потом снимает
    expect(sec).not.toContain('Протокол.md');

    h.fetchCalls[0].resolve(makeRes({ body: '# Протокол' }));
    await flush();
    const after = h.Fn.sectionsFor(CHAT, 'u-1');
    expect(after).toContain('[FILE: Протокол.md]\n# Протокол');
    // URL и подпись не попадают в текст ни в каком виде
    expect(after).not.toContain('cdn.qwenlm.ai');
    expect(after).not.toContain('key=');
  });

  test('нет url / статус не uploaded → метка с причиной, запроса нет', function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [
      textFile({ id: 'nourl', name: 'note.txt', url: '', file_type: 'text/plain' }),
      textFile({ id: 'pending', name: 'upload.txt', status: 'pending' })
    ]);
    expect(h.fetchCalls).toHaveLength(0);
    const sec = h.Fn.sectionsFor(CHAT, 'u-1');
    expect(sec).toContain('[FILE: note.txt — текст не получен: no-url]');
    expect(sec).toContain('[FILE: upload.txt — текст не получен: status-pending]');
  });

  test('чужой чат не принимается (поздняя страница пагинации после SPA-перехода)', function () {
    const h = makeHarness();
    expect(h.Fn.enqueueUserFiles('chat-2', 'u-9', [textFile()])).toBe(0);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.Fn.sectionsFor('chat-2', 'u-9')).toBe('');
  });

  test('дубли в одном сообщении и повтор файла в другом сообщении — один запрос', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile(), textFile()]);
    h.Fn.enqueueUserFiles(CHAT, 'u-2', [textFile()]);
    expect(h.fetchCalls).toHaveLength(1);

    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-type': 'text/markdown' }, body: '# Протокол' }));
    await flush();

    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toBe('\n\n[FILE: Протокол.md]\n# Протокол');
    expect(h.Fn.sectionsFor(CHAT, 'u-2')).toBe('\n\n[FILE: Протокол.md]\n# Протокол');
  });
});

describe('R2: загрузка тела файла', function () {
  test('originalFetch, GET, credentials omit, без заголовков', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].opts).toEqual({ method: 'GET', credentials: 'omit', signal: expect.anything() });
    expect(h.originalFetch).toHaveBeenCalledTimes(1);
    h.fetchCalls[0].resolve(makeRes({ body: 'ok' }));
    await flush();
    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toContain('[FILE: Протокол.md]\nok');
  });

  test('JSON-обёртка {"code":0,"data":{content}} разворачивается, code≠0 — причина api-N', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile({ id: 'j1', name: 'a.json', file_type: 'application/json' })]);
    h.fetchCalls[0].resolve(makeRes({ body: '{"code":0,"data":{"content":"{\\"a\\":1}"}}' }));
    await flush();
    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toContain('{"a":1}');

    h.Fn.enqueueUserFiles(CHAT, 'u-2', [textFile({ id: 'j2', name: 'b.json', file_type: 'application/json' })]);
    h.fetchCalls[1].resolve(makeRes({ body: '{"code":403,"message":"forbidden"}' }));
    await flush();
    expect(h.Fn.sectionsFor(CHAT, 'u-2')).toContain('[FILE: b.json — текст не получен: api-403]');
  });

  test('страница логина вместо файла отсекается (html-instead-of-file)', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    h.fetchCalls[0].resolve(makeRes({
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><html><body>Sign in</body></html>'
    }));
    await flush();
    const sec = h.Fn.sectionsFor(CHAT, 'u-1');
    expect(sec).toContain('текст не получен: html-instead-of-file');
    expect(sec).not.toContain('Sign in');
  });

  test('HTTP-ошибка и таймаут видны в секции', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile({ id: 'e1', name: 'one.txt' })]);
    h.fetchCalls[0].resolve(makeRes({ ok: false, status: 404 }));
    await flush();
    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toContain('[FILE: one.txt — текст не получен: http-404]');

    h.Fn.enqueueUserFiles(CHAT, 'u-2', [textFile({ id: 'e2', name: 'two.txt' })]);
    h.tick(10000);
    await flush();
    expect(h.Fn.sectionsFor(CHAT, 'u-2')).toContain('[FILE: two.txt — текст не получен: timeout]');
    // отложенный ре-эмит — тоже «в полёте»; после его срабатывания очередь пуста
    h.tick(250);
    expect(h.Fn.pendingCount()).toBe(0);
  });

  test('нет native fetch → no-fetch (не падение)', async function () {
    const h = makeHarness({ noFetch: true });
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    await flush();
    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toContain('[FILE: Протокол.md — текст не получен: no-fetch]');
  });

  test('content-length больше 8 МБ → too-large, тело не читается', async function () {
    const h = makeHarness();
    const res = makeRes({ headers: { 'content-length': String(9 * 1024 * 1024) }, body: 'x' });
    const spy = jest.spyOn(res, 'text');
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    h.fetchCalls[0].resolve(res);
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toContain('текст не получен: too-large');
  });
});

describe('R2: жёсткий кап 200 000 символов на файл', function () {
  test('длинный текст обрезается до капа ровно и помечается', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-type': 'text/plain' }, body: 'a'.repeat(250000) }));
    await flush();

    const sec = h.Fn.sectionsFor(CHAT, 'u-1');
    const body = bodyOf(sec);
    expect(body.length).toBe(200000);
    expect(body.endsWith('\n…[обрезано 50000]')).toBe(true);
    // длина секции, которую видит emitSnapshot, совпадает с реальной строкой
    expect(h.Fn.sectionLength(CHAT, 'u-1')).toBe(sec.length);
  });

  test('кап чата 2 000 000: следующий файл получает chat-cap', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile({ id: 'big', name: 'big.txt' })]);
    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-type': 'text/plain' }, body: 'a'.repeat(200000) }));
    await flush();
    // добираем остаток капа чата ещё девятью файлами по 200 000
    for (let i = 0; i < 9; i++) {
      h.Fn.enqueueUserFiles(CHAT, 'u-k' + i, [textFile({ id: 'f' + i, name: 'f' + i + '.txt' })]);
      h.fetchCalls[h.fetchCalls.length - 1].resolve(makeRes({ headers: { 'content-type': 'text/plain' }, body: 'b'.repeat(200000) }));
      await flush();
    }
    h.Fn.enqueueUserFiles(CHAT, 'u-last', [textFile({ id: 'last', name: 'last.txt' })]);
    h.fetchCalls[h.fetchCalls.length - 1].resolve(makeRes({ headers: { 'content-type': 'text/plain' }, body: 'c' }));
    await flush();
    expect(h.Fn.sectionsFor(CHAT, 'u-last')).toContain('[FILE: last.txt — текст не получен: chat-cap]');
  });
});

describe('R2: ре-эмит базы после прихода текста', function () {
  test('дебаунс 250 мс, аргументы последнего снимка повторяются как есть', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    h.fetchCalls[0].resolve(makeRes({ body: '# Протокол' }));
    await flush();
    expect(h.deps.emitSnapshot).not.toHaveBeenCalled();

    h.tick(250);
    expect(h.deps.emitSnapshot).toHaveBeenCalledTimes(1);
    expect(h.deps.emitSnapshot).toHaveBeenCalledWith({
      usage: { input: 1709 },
      complete: true,
      chatId: CHAT,
      responseId: 'resp-1'
    });
    expect(h.Fn.pendingCount()).toBe(0);
  });

  test('два файла подряд дают ОДИН ре-эмит (дебаунс не суммируется)', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [
      textFile({ id: 'f1', name: 'a.txt' }),
      textFile({ id: 'f2', name: 'b.txt' })
    ]);
    h.fetchCalls[0].resolve(makeRes({ body: 'A' }));
    await flush();
    h.fetchCalls[1].resolve(makeRes({ body: 'B' }));
    await flush();
    h.tick(250);
    expect(h.deps.emitSnapshot).toHaveBeenCalledTimes(1);
  });

  test('незавершённая пагинация не объявляется полной (partial сохраняется)', async function () {
    const h = makeHarness({ deps: { lastEmitMeta: { tokens: 0, complete: false, chatId: CHAT, responseId: '' } } });
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    h.fetchCalls[0].resolve(makeRes({ body: 'x' }));
    await flush();
    h.tick(250);
    const arg = h.deps.emitSnapshot.mock.calls[0][0];
    expect(arg.complete).toBe(false);
    expect(arg.partial).toEqual({ pages: 0, reason: 'files-in-progress' });
  });

  test('без ядра (__bind не зван) модуль молчит, но не падает', async function () {
    const h = makeHarness({ bind: false });
    expect(h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()])).toBe(1);
    h.fetchCalls[0].resolve(makeRes({ body: 'x' }));
    await flush();
    h.tick(250);
    expect(h.deps.emitSnapshot).not.toHaveBeenCalled();
  });
});

describe('R2: протокол ожидания очереди (A-лайт)', function () {
  test('state-request → state-response с pending/active/queued/texts', async function () {
    const h = makeHarness();
    h.dispatch('ai-cm-deepseek-files-state-request', {});
    const idle = h.lastEvent('ai-cm-deepseek-files-state-response');
    expect(idle.detail).toEqual({ pending: 0, active: 0, queued: 0, texts: 0 });

    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    h.dispatch('ai-cm-deepseek-files-state-request', {});
    const busy = h.lastEvent('ai-cm-deepseek-files-state-response');
    expect(busy.detail.pending).toBe(1);
    expect(busy.detail.active).toBe(1);
  });

  test('drain на простое отвечает сразу (reason idle)', function () {
    const h = makeHarness();
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'rq-idle', timeoutMs: 6000 });
    const done = h.lastEvent('ai-cm-deepseek-files-drain-done');
    expect(done.detail).toEqual({ requestId: 'rq-idle', ok: true, drained: true, reason: 'idle', pending: 0, waitedMs: 0 });
  });

  test('drain ждёт очередь и отвечает drained после ре-эмита', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'rq-1', timeoutMs: 6000 });
    expect(h.findEvents('ai-cm-deepseek-files-drain-done')).toHaveLength(0);

    h.fetchCalls[0].resolve(makeRes({ body: 'x' }));
    await flush();
    // ожидание не снимается до ре-эмита: отложенный таймер тоже «в полёте»
    expect(h.findEvents('ai-cm-deepseek-files-drain-done')).toHaveLength(0);
    h.tick(250);
    const done = h.lastEvent('ai-cm-deepseek-files-drain-done');
    expect(done.detail.requestId).toBe('rq-1');
    expect(done.detail.ok).toBe(true);
    expect(done.detail.drained).toBe(true);
    expect(done.detail.reason).toBe('drained');
    expect(done.detail.pending).toBe(0);
  });

  test('drain с JSON-строкой (Xray/Firefox) разбирается, таймаут отвечает file-queue-timeout', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    h.dispatch('ai-cm-deepseek-files-drain', JSON.stringify({ requestId: 'rq-xray', timeoutMs: 6000 }));
    h.tick(6000);
    const done = h.lastEvent('ai-cm-deepseek-files-drain-done');
    expect(done.detail.requestId).toBe('rq-xray');
    expect(done.detail.drained).toBe(false);
    expect(done.detail.reason).toBe('file-queue-timeout');
    expect(done.detail.ok).toBe(false);
  });
});

describe('R2: qfReset на SPA-переходе', function () {
  test('карта и очередь очищаются, секции нового чата пустые', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toBe('');

    h.Fn.qfReset('chat-2');
    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toBe('');
    expect(h.Fn.pendingCount()).toBe(0);
    expect(h.Fn.messages()).toEqual({});
  });

  test('результат запроса, начатого до смены чата, в карту не пишется (epoch)', async function () {
    const h = makeHarness();
    h.Fn.enqueueUserFiles(CHAT, 'u-1', [textFile()]);
    const inflight = h.fetchCalls[0];
    h.Fn.qfReset('chat-2');
    inflight.resolve(makeRes({ body: 'поздний ответ' }));
    await flush();
    expect(h.Fn.sectionsFor(CHAT, 'u-1')).toBe('');
    expect(h.deps.emitSnapshot).not.toHaveBeenCalled();
  });
});

describe('R2: source-пины связки (перехватчик, регистрация, экспорт)', function () {
  const intercept = read('core/qwen-intercept.js');
  const background = read('core/background.js');
  const baseHandler = read('core/base-handler.js');
  const content = read('core/content.js');
  const exportManager = read('core/export-manager.js');

  test('parseQwenHistory отдаёт вложения, applyHistoryPayload ставит их в очередь', function () {
    expect(intercept).toContain('function historyFilesOf(node)');
    expect(intercept).toContain('files: historyFilesOf(node)');
    expect(intercept).toContain('pendingUserFiles = Array.isArray(msg.files) ? msg.files : [];');
    expect(intercept).toContain('aiCmQwenFiles.qfEnqueueUserFiles(chatId, rec.turn.userKey, pendingUserFiles);');
  });

  test('секции вложений дописываются в ПОЛЬЗОВАТЕЛЬСКИЙ блок, длина — в buildSignature', function () {
    expect(intercept).toContain('aiCmQwenFiles.qfSectionsFor(currentChatId, t.userKey)');
    expect(intercept).toContain("parts.push('f:' + aiCmQwenFiles.qfSectionLength(currentChatId, t.userKey));");
    expect(intercept).toContain('aiCmQwenFiles.qfReset(next);');
  });

  test('связка __bind: форвардер снимка, диагностика, геттеры ядра', function () {
    expect(intercept).toContain('aiCmQwenFiles.__bind({');
    expect(intercept).toContain('emitSnapshot: emitSnapshot,');
    expect(intercept).toContain('get originalFetch() { return originalFetch; }');
    expect(intercept).toContain('get lastEmitMeta() { return lastEmitMeta; }');
  });

  test('background: core/qwen-files.js в js[] ПЕРЕД перехватчиком', function () {
    const iFiles = background.indexOf("'core/qwen-files.js'");
    const iCore = background.indexOf("'core/qwen-intercept.js'");
    expect(iFiles).toBeGreaterThan(-1);
    expect(iCore).toBeGreaterThan(-1);
    expect(iFiles).toBeLessThan(iCore);
  });

  test('экспорт ждёт очередь: aiCmFilesDrainSite в base-handler и обеих точках снятия', function () {
    expect(baseHandler).toContain('function aiCmFilesDrainSite()');
    expect(baseHandler).toContain('Api.aiCmFilesDrainSite = aiCmFilesDrainSite;');
    expect(content).toContain('aiCmExportFilesDrainThen(curCidExp, replyManualExport, 6000);');
    expect(exportManager).toContain('aiCmExportFilesDrainThen(cid, selfSync, 6000);');
  });

  test('в модуле нет голого console.warn (страж сьюта) и формат секции закреплён', function () {
    expect(MODULE_SRC).not.toContain('console.warn(');
    expect(MODULE_SRC).toContain("'\\n\\n[FILE: ' + name + ']\\n' + rec.text");
    expect(MODULE_SRC).toContain("' — текст не получен'");
  });
});
