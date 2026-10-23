/**
 * tests/adapters/deepseek-files-module.test.js — Step D.10 (Вариант B + A-лайт).
 *
 * Контракт core/deepseek-files.js: FIFO-очередь текста вложений (concurrency 2, дедуп
 * `convId|fileId`), fetch тела через originalFetch (same-origin, lastAuthHeaders, таймаут
 * 10 с, кап 500 000 символов), карта `fileTextsByMsg`, пересборка хода и дебаунс-ре-эмит
 * базы (250 мс), протокол A-лайт (state-request/response, drain/done с таймаутом 2000 мс).
 *
 * Плюс source-пины связки: ingest вызывает enqueueChainFiles/applyPendingFileTexts ДО
 * emitBaseSnapshot; ядро форвардит их в модуль; background регистрирует файл между ingest
 * и sse; экспорт (base-handler/content/export-manager) спрашивает очередь перед снятием.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = require('../helpers/deepseek-intercept-source.js');
const ROOT = path.join(__dirname, '..', '..');

const MODULE_SRC = DS.moduleSource('deepseek-files.js');

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
  windowObj.fetch = originalFetch;

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
    location: { origin: 'https://chat.deepseek.com' },
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    CustomEvent: TestCustomEvent,
    AbortController: AbortController,
    aiCmDiagWarn: jest.fn()
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(MODULE_SRC, ctx, { filename: 'core/deepseek-files.js' });
  const Fn = sandbox.window.AiCmDeepseekFiles;

  const deps = Object.assign({
    emitBaseSnapshot: jest.fn(),
    composeTurnText: jest.fn(function (answer, reasoning) {
      return reasoning ? '[REASONING]\n' + reasoning + '\n\n[ANSWER]\n' + answer : answer;
    }),
    getModelSlug: jest.fn(function () { return 'deepseek-v4.1'; }),
    turnsMap: {},
    orderCounter: 0,
    currentConvId: 'convA',
    originalFetch: originalFetch,
    lastAuthHeaders: { Authorization: 'Bearer tok' },
    lastBaseServerTokens: 11,
    lastBaseChatMode: 'chat'
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
    ctx: ctx,
    dispatch: function (type, detail) {
      return windowObj.dispatchEvent(new TestCustomEvent(type, { detail: detail }));
    },
    findEvents: function (type) { return events.filter(function (e) { return e.type === type; }); }
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function fileFrag(id, name) { return { type: 'FILE', file_id: id, file_name: name || '' }; }

function msg(id, role, frags, extra) {
  return Object.assign({
    message_id: id,
    role: role || 'ASSISTANT',
    fragments: frags || [],
    inserted_at: 1
  }, extra || {});
}

function resp(body, status, ok) {
  return { ok: ok !== false, status: status || 200, text: function () { return Promise.resolve(body); } };
}

// ===== S1: контракт связки и гард повторной загрузки =================================
describe('Step D.10: core/deepseek-files.js — контракт модуля FILES', () => {
  test('S1: до __bind экспортируется только __bind, после — шесть функций и карта текстов', () => {
    const h = makeHarness({ bind: false });
    expect(Object.keys(h.Fn)).toEqual(['__bind']);
    expect(typeof h.Fn.__bind).toBe('function');

    h.Fn.__bind(h.deps);
    expect(Object.keys(h.Fn).sort()).toEqual([
      '__bind',
      'applyPendingFileTexts',
      'enqueueChainFiles',
      'extractFileRefs',
      'fetchFileContent',
      'fileQueueStats',
      'fileTextsByMsg'
    ]);
    expect(typeof h.Fn.fileTextsByMsg).toBe('object');
    expect(h.Fn.fileQueueStats()).toEqual({ queued: 0, active: 0, pending: 0, texts: 0, keys: [] });
  });

  test('S2: гард — повторная инъекция не удваивает слушателей A-лайт', () => {
    const h = makeHarness();
    const first = h.windowObj.AiCmDeepseekFiles;
    const stateBefore = (h.listeners['ai-cm-deepseek-files-state-request'] || []).length;
    const drainBefore = (h.listeners['ai-cm-deepseek-files-drain'] || []).length;
    vm.runInContext(MODULE_SRC, h.ctx, { filename: 'core/deepseek-files.js' });
    expect(h.windowObj.AiCmDeepseekFiles).toBe(first);
    expect((h.listeners['ai-cm-deepseek-files-state-request'] || []).length).toBe(stateBefore);
    expect((h.listeners['ai-cm-deepseek-files-drain'] || []).length).toBe(drainBefore);
  });

  test('S3: extractFileRefs понимает FILE-фрагмент, files[] и attachments[] и дедупит по id', () => {
    const h = makeHarness();
    const m = msg('m1', 'USER', [
      fileFrag('f1', 'a.pdf'),
      { type: 'REQUEST', content: 'почитай' },
      { type: 'FILE', content: '{"file_id":"f2","file_name":"b.txt"}' },
      { type: 'FILE', files: [{ id: 'f3', signed_path: '/signed/f3' }] }
    ], { files: [{ id: 'f4' }], attachments: [{ file_id: 'f5' }, { file_id: 'f1' }] });
    const refs = h.Fn.extractFileRefs(m);
    expect(refs.map(function (r) { return r.fileId; })).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    const f3 = refs.filter(function (r) { return r.fileId === 'f3'; })[0];
    expect(f3.signedPath).toBe('/signed/f3');
    expect(h.Fn.extractFileRefs(null)).toEqual([]);
    expect(h.Fn.extractFileRefs({ message_id: 'x', fragments: [{ type: 'RESPONSE', content: 'только текст' }] })).toEqual([]);
  });
});

// ===== S2: fetch тела вложения ========================================================
describe('Step D.10: fetchFileContent — same-origin, заголовки, таймаут, кап', () => {
  test('S1: запрос идёт через originalFetch в /api/v0/file/<id> с заголовками ядра', async () => {
    const h = makeHarness();
    const p = h.Fn.fetchFileContent('file_123', '');
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toBe('https://chat.deepseek.com/api/v0/file/file_123');
    expect(h.fetchCalls[0].opts.headers.Authorization).toBe('Bearer tok');
    expect(h.fetchCalls[0].opts.credentials).toBe('include');
    h.fetchCalls[0].resolve(resp(JSON.stringify({ code: 0, data: { content: 'ТЕКСТ ФАЙЛА', file_name: 'a.txt' } })));
    await expect(p).resolves.toEqual({ ok: true, text: 'ТЕКСТ ФАЙЛА', name: 'a.txt', truncated: false });
  });

  test('S2: подписанный путь приоритетнее (абсолютный и relative /api/... сохраняют origin)', async () => {
    const h = makeHarness();
    h.Fn.fetchFileContent('f1', '/api/v0/file/f1?sig=abc');
    expect(h.fetchCalls[0].url).toBe('https://chat.deepseek.com/api/v0/file/f1?sig=abc');
    h.Fn.fetchFileContent('f2', 'signed/route');
    expect(h.fetchCalls[1].url).toBe('https://chat.deepseek.com/api/v0/file/signed/route');
    h.Fn.fetchFileContent('f3', 'https://cdn.example.com/x');
    expect(h.fetchCalls[2].url).toBe('https://cdn.example.com/x');
  });

  test('S3: HTTP-ошибка и таймаут 10 с возвращают ok:false с причиной', async () => {
    const h = makeHarness();
    const p1 = h.Fn.fetchFileContent('f1', '');
    h.fetchCalls[0].resolve(resp('', 500, false));
    await expect(p1).resolves.toEqual({ ok: false, reason: 'http-500', text: '' });

    const p2 = h.Fn.fetchFileContent('f2', '');
    h.tick(10000);
    await expect(p2).resolves.toEqual({ ok: false, reason: 'timeout', text: '' });
  });

  test('S4: кап 500 000 символов — текст обрезан и помечен truncated', async () => {
    const h = makeHarness();
    const big = 'x'.repeat(500001);
    const p = h.Fn.fetchFileContent('f1', '');
    h.fetchCalls[0].resolve(resp(JSON.stringify({ code: 0, data: { content: big } })));
    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBe(500000);
  });
});

// ===== S3: очередь FIFO / concurrency 2 / дедуп ======================================
describe('Step D.10: очередь вложений — FIFO, concurrency 2, дедуп convId|fileId', () => {
  test('S1: одновременно в полёте не больше двух, третий стартует после первого', async () => {
    const h = makeHarness();
    const chain = [
      msg('m1', 'USER', [fileFrag('f1')]),
      msg('m2', 'USER', [fileFrag('f2')]),
      msg('m3', 'USER', [fileFrag('f3')])
    ];
    expect(h.Fn.enqueueChainFiles(chain, {})).toBe(3);
    expect(h.fetchCalls.map(function (c) { return c.url; })).toHaveLength(2);
    expect(h.Fn.fileQueueStats().active).toBe(2);

    h.fetchCalls[0].resolve(resp('A'));
    await flush();
    expect(h.fetchCalls).toHaveLength(3);
    expect(h.fetchCalls[2].url).toContain('/file/f3');
  });

  test('S2: один файл у двух ходов качается один раз, текст доезжает до обоих', async () => {
    const h = makeHarness();
    const chain = [
      msg('m1', 'USER', [fileFrag('f1', 'a.txt')]),
      msg('m2', 'USER', [fileFrag('f1', 'a.txt')]),
      msg('m3', 'USER', [fileFrag('f9', 'b.txt')])
    ];
    expect(h.Fn.enqueueChainFiles(chain, {})).toBe(2);
    expect(h.fetchCalls).toHaveLength(2);
    h.fetchCalls[0].resolve(resp('BODY F1'));
    h.fetchCalls[1].resolve(resp('BODY F9'));
    await flush();
    expect(h.Fn.fileTextsByMsg.m1.text).toBe('BODY F1');
    expect(h.Fn.fileTextsByMsg.m2.text).toBe('BODY F1');
    expect(h.Fn.fileTextsByMsg.m3.text).toBe('BODY F9');
    // текст уже разложен, но дебаунс-эмит базы ещё в полёте — очередь «занята» (A-лайт ждёт)
    expect(h.Fn.fileQueueStats().pending).toBe(1);
    h.tick(250);
    expect(h.Fn.fileQueueStats().pending).toBe(0);
  });

  test('S3: дедуп привязан к конверсации — в другом чате тот же fileId качается снова', async () => {
    const h = makeHarness();
    h.Fn.enqueueChainFiles([msg('m1', 'USER', [fileFrag('f1')])], {});
    expect(h.fetchCalls).toHaveLength(1);
    h.fetchCalls[0].resolve(resp('A'));
    await flush();
    h.deps.currentConvId = 'convB';
    h.Fn.enqueueChainFiles([msg('m2', 'USER', [fileFrag('f1')])], {});
    expect(h.fetchCalls).toHaveLength(2);
  });

  test('S4: сбой не залипает в дедупе — повторный ingest пробует снова', async () => {
    const h = makeHarness();
    h.Fn.enqueueChainFiles([msg('m1', 'USER', [fileFrag('f1')])], {});
    h.fetchCalls[0].resolve(resp('', 500, false));
    await flush();
    expect(h.Fn.fileQueueStats().pending).toBe(0);
    h.Fn.enqueueChainFiles([msg('m1', 'USER', [fileFrag('f1')])], {});
    expect(h.fetchCalls).toHaveLength(2);
  });
});

// ===== S4: текст хода + ре-эмит базы =================================================
describe('Step D.10: fileTextsByMsg, пересборка хода и дебаунс-ре-эмит базы', () => {
  test('S1: текст хода = ответ + [FILE: имя] + тело; emitBaseSnapshot — ОДИН раз через 250 мс', async () => {
    const h = makeHarness();
    h.deps.turnsMap.m1 = { text: 'ответ', answer: 'ответ', reasoning: '', modelSlug: '', order: 0, role: 'assistant' };
    h.Fn.enqueueChainFiles([msg('m1', 'ASSISTANT', [{ type: 'RESPONSE', content: 'ответ' }, fileFrag('f1', 'a.txt')])], {});
    h.fetchCalls[0].resolve(resp('FILE BODY'));
    await flush();
    expect(h.deps.turnsMap.m1.text).toBe('ответ\n\n[FILE: a.txt]\nFILE BODY');
    expect(h.Fn.fileTextsByMsg.m1.text).toBe('FILE BODY');
    expect(h.deps.emitBaseSnapshot).not.toHaveBeenCalled();
    h.tick(250);
    expect(h.deps.emitBaseSnapshot).toHaveBeenCalledTimes(1);
    expect(h.deps.emitBaseSnapshot).toHaveBeenCalledWith(11, 'chat');
  });

  test('S2: ход из ОДНИХ вложений получает заглушку (order из ядра) и наполняется позже', async () => {
    const h = makeHarness();
    h.Fn.enqueueChainFiles([msg('m9', 'ASSISTANT', [fileFrag('f9', 'doc.pdf')])], {});
    expect(h.deps.turnsMap.m9).toBeTruthy();
    expect(h.deps.turnsMap.m9.order).toBe(0);
    expect(h.deps.orderCounter).toBe(1);
    expect(h.deps.turnsMap.m9.text).toBe('');
    h.fetchCalls[0].resolve(resp('PDF BODY'));
    await flush();
    expect(h.deps.turnsMap.m9.text).toBe('\n\n[FILE: doc.pdf]\nPDF BODY');
  });

  test('S3: applyPendingFileTexts переносит кэш в СВЕЖИЙ turnsMap после повторного ingest', async () => {
    const h = makeHarness();
    h.deps.turnsMap.m1 = { text: 'a', answer: 'a', reasoning: '', order: 0, role: 'assistant' };
    h.Fn.enqueueChainFiles([msg('m1', 'ASSISTANT', [fileFrag('f1', 'a.txt')])], {});
    h.fetchCalls[0].resolve(resp('CACHED'));
    await flush();
    h.tick(250);
    expect(h.deps.emitBaseSnapshot).toHaveBeenCalledTimes(1);

    h.deps.turnsMap = { m1: { text: 'a', answer: 'a', reasoning: 'r', order: 0, role: 'assistant' } };
    expect(h.Fn.applyPendingFileTexts()).toBe(1);
    expect(h.deps.turnsMap.m1.text).toBe('[REASONING]\nr\n\n[ANSWER]\na\n\n[FILE: a.txt]\nCACHED');
    h.tick(250);
    expect(h.deps.emitBaseSnapshot).toHaveBeenCalledTimes(2);
  });
});

// ===== S5: протокол A-лайт (state/drain) =============================================
describe('Step D.10: A-лайт — состояние очереди и ожидание опустошения', () => {
  test('S1: пустая очередь отвечает синхронно reason=idle', () => {
    const h = makeHarness();
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'r1' });
    const done = h.findEvents('ai-cm-deepseek-files-drain-done');
    expect(done).toHaveLength(1);
    expect(done[0].detail).toMatchObject({ requestId: 'r1', ok: true, drained: true, reason: 'idle', pending: 0 });
  });

  test('S2: ожидание будится после прихода текста и ре-эмита (reason=drained)', async () => {
    const h = makeHarness();
    h.Fn.enqueueChainFiles([msg('m1', 'ASSISTANT', [fileFrag('f1', 'a.txt')])], {});
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'r2', timeoutMs: 2000 });
    expect(h.findEvents('ai-cm-deepseek-files-drain-done')).toHaveLength(0);

    h.fetchCalls[0].resolve(resp('X'));
    await flush();
    expect(h.findEvents('ai-cm-deepseek-files-drain-done')).toHaveLength(0); // ждёт дебаунс-эмит
    h.tick(250);
    const done = h.findEvents('ai-cm-deepseek-files-drain-done');
    expect(done).toHaveLength(1);
    expect(done[0].detail).toMatchObject({ requestId: 'r2', ok: true, drained: true, reason: 'drained' });
  });

  test('S3: зависший файл не держит экспорт дольше 2000 мс — reason=file-queue-timeout', () => {
    const h = makeHarness();
    h.Fn.enqueueChainFiles([msg('m1', 'ASSISTANT', [fileFrag('f1')])], {});
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'r3' });
    h.tick(1999);
    expect(h.findEvents('ai-cm-deepseek-files-drain-done')).toHaveLength(0);
    h.tick(1);
    const done = h.findEvents('ai-cm-deepseek-files-drain-done');
    expect(done).toHaveLength(1);
    expect(done[0].detail).toMatchObject({ requestId: 'r3', ok: false, drained: false, reason: 'file-queue-timeout' });
    expect(done[0].detail.pending).toBeGreaterThan(0);
  });

  test('S4: state-request отдаёт pending/queued/active/texts (A-лайт не ждёт пустую очередь)', async () => {
    const h = makeHarness();
    h.dispatch('ai-cm-deepseek-files-state-request');
    let st = h.findEvents('ai-cm-deepseek-files-state-response');
    expect(st).toHaveLength(1);
    expect(st[0].detail).toEqual({ pending: 0, active: 0, queued: 0, texts: 0 });

    h.Fn.enqueueChainFiles([msg('m1', 'ASSISTANT', [fileFrag('f1')])], {});
    h.dispatch('ai-cm-deepseek-files-state-request');
    st = h.findEvents('ai-cm-deepseek-files-state-response');
    expect(st[1].detail.pending).toBeGreaterThan(0);
    expect(st[1].detail.active).toBe(1);
  });
});

// ===== S6: source-пины связки =======================================================
describe('Step D.10: source-пины связки (ingest -> files -> kernel -> export)', () => {
  const ingest = DS.readSource('core/deepseek-ingest.js');
  const kernel = DS.readSource('core/deepseek-intercept.js');
  const bg = DS.readSource('core/background.js');
  const baseHandler = DS.readSource('core/base-handler.js');
  const content = DS.readSource('core/content.js');
  const exporter = DS.readSource('core/export-manager.js');

  test('S1: ingest зовёт модуль в ACCEPT-ветке, но ПОСЛЕ turnsMap и ДО emitBaseSnapshot', () => {
    expect(ingest).toContain("if (typeof enqueueChainFiles === 'function') enqueueChainFiles(chain, chatModelSignals);");
    expect(ingest).toContain("if (typeof applyPendingFileTexts === 'function') applyPendingFileTexts();");
    const iCall = ingest.indexOf('enqueueChainFiles(chain, chatModelSignals)');
    const iEmit = ingest.indexOf('var em = emitBaseSnapshot(lastAccumulated, chatMode);');
    const iAccept = ingest.indexOf('turnsMap = {};');
    expect(iCall).toBeGreaterThan(iAccept);
    expect(iEmit).toBeGreaterThan(iCall);
  });

  test('S2: ядро форвардит имя-в-имя и передаёт модулю только контракт (fn/rw/ro)', () => {
    expect(kernel).toContain('function enqueueChainFiles(chain, modelSignals) { if (aiCmDeepseekFiles) return aiCmDeepseekFiles.enqueueChainFiles(chain, modelSignals); }');
    expect(kernel).toContain('function applyPendingFileTexts() { if (aiCmDeepseekFiles) return aiCmDeepseekFiles.applyPendingFileTexts(); }');
    expect(kernel).toContain('enqueueChainFiles: enqueueChainFiles,');
    expect(kernel).toContain('applyPendingFileTexts: applyPendingFileTexts,');
    expect(kernel).toContain('var aiCmDeepseekFiles = (typeof window !== \'undefined\' && window.AiCmDeepseekFiles) || null;');
  });

  test('S3: background грузит файл между ingest и sse, id регистрации — -v12', () => {
    const js = "js: ['utils/debug.js', 'core/deepseek-diag.js', 'core/deepseek-netsync.js', 'core/deepseek-refetch.js', 'core/deepseek-parse.js', 'core/deepseek-conv.js', 'core/deepseek-emit.js', 'core/deepseek-net.js', 'core/deepseek-ingest.js', 'core/deepseek-files.js', 'core/deepseek-sse.js', 'core/deepseek-intercept.js']";
    expect(bg).toContain(js);
    expect(bg).toContain("registerSafe('ai-cm-deepseek-intercept-v12'");
  });

  test('S4: экспорт спрашивает очередь A-лайт до снятия файла (оба пути)', () => {
    expect(baseHandler).toContain('function aiCmExportFilesDrainThen(convId, cb, timeoutMs)');
    expect(baseHandler).toContain('function aiCmExportFilesThenNetSync(convId, cb, netTimeoutMs)');
    expect(baseHandler).toContain("reason: 'file-queue-timeout'");
    expect(baseHandler).toContain('ai-cm-deepseek-files-state-request');
    expect(baseHandler).toContain('ai-cm-deepseek-files-drain');
    expect(content).toContain('aiCmExportFilesThenNetSync(curCidExp, replyManualExport)');
    expect(exporter).toContain('aiCmExportFilesThenNetSync(cid, selfSync)');
  });

  test('S5: новый файл — UTF-8/LF, без CRLF и без хвостовых пробелов-мусора', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'core', 'deepseek-files.js'), 'utf8');
    expect(raw.indexOf('\r')).toBe(-1);
    expect(raw.endsWith('\n')).toBe(true);
    expect(MODULE_SRC).toContain('var FILES_CONCURRENCY = 2;');
    expect(MODULE_SRC).toContain('var FILES_TEXT_CAP = 500000;');
    expect(MODULE_SRC).toContain('var FILES_FETCH_TIMEOUT_MS = 10000;');
    expect(MODULE_SRC).toContain('var FILES_EMIT_DEBOUNCE_MS = 250;');
    expect(MODULE_SRC).toContain('var FILES_DRAIN_TIMEOUT_MS = 2000;');
    expect(MODULE_SRC).toContain('var FILES_URL_PREFIX = \'/api/v0/file/\';');
  });
});
