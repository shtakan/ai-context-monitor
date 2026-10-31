/**
 * tests/adapters/gemini-files-module.test.js — v2.0: экспорт вложений Gemini.
 *
 * Контракт core/gemini-files.js: ref-ы из turn[2][0][4][0][4] (type 1=image,
 * 10=docx, 11=pdf), FIFO-очередь concurrency 2 с дедупом convId|token|name,
 * скачивание через originalFetch с credentials:'include', DOCX-распаковка
 * (DecompressionStream('deflate-raw') → word/document.xml), PDF только
 * мета-секция, изображения — [IMAGE: имя] CDN-URL, кап 200 000 символов на файл,
 * дебаунс-ре-эмит 250 мс и протокол state/drain.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { TextDecoder } = require('util');
const { DecompressionStream } = require('stream/web');
const timers = require('timers');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'gemini-files.js'), 'utf8');
const PARSER_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'gemini-batchexecute-parser.js'), 'utf8');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

const CHAT = 'conv-1';
const TOKEN_PDF = '$AfW07Ipdf';
const TOKEN_DOCX = '$AfW07Idocx';

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

  const moduleObj = { exports: {} };
  const sandbox = {
    window: windowObj,
    module: moduleObj,
    exports: moduleObj.exports,
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Date: Date,
    CustomEvent: TestCustomEvent,
    AbortController: AbortController,
    TextDecoder: TextDecoder,
    DecompressionStream: DecompressionStream,
    aiCmDiagWarn: jest.fn(),
    aiCmDiagLine: jest.fn()
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(PARSER_SRC, ctx, { filename: 'utils/gemini-batchexecute-parser.js' });
  const Parser = windowObj.GeminiBatchexecuteParser;
  vm.runInContext(MODULE_SRC, ctx, { filename: 'core/gemini-files.js' });
  const Fn = windowObj.AiCmGeminiFiles;

  const deps = Object.assign({
    emitSnapshot: jest.fn(),
    getConvId: function () { return CHAT; },
    originalFetch: over.noFetch ? null : originalFetch,
    diagLine: jest.fn()
  }, over.deps || {});
  if (over.bind !== false) Fn.__bind(deps);

  return {
    Fn: Fn,
    Parser: Parser,
    deps: deps,
    windowObj: windowObj,
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
  for (let k = 0; k < 4; k++) await new Promise(function (r) { timers.setImmediate(r); });
  for (let j = 0; j < 12; j++) await Promise.resolve();
}

function makeRes(spec) {
  spec = spec || {};
  const headers = spec.headers || {};
  return {
    ok: spec.ok !== false,
    status: (typeof spec.status === 'number') ? spec.status : 200,
    headers: { get: function (n) { const k = String(n || '').toLowerCase(); return (k in headers) ? headers[k] : null; } },
    text: function () { return Promise.resolve(spec.body || ''); },
    arrayBuffer: function () { return Promise.resolve(spec.buffer || new ArrayBuffer(0)); },
    body: spec.bodyStream || { cancel: jest.fn(function () { return Promise.resolve(); }) }
  };
}

function turnWith(nodes) {
  // turn[2][0][4][0][4] — ровно тот путь, который читает план/парсер.
  return [null, null, [[null, null, null, null, [[null, null, null, null, nodes]]]]];
}

function fileNode(type, name, mime, opts) {
  opts = opts || {};
  const img = opts.img || null;
  const token = opts.token || ((type === 1 ? '$AVuibg' : '$AfW07I') + name);
  const urls = opts.urls || null;
  return [null, type, name, img, null, token, null, urls, 1, [1, 0], null, mime];
}

function pdfNode(name) {
  return fileNode(11, name, 'application/pdf', {
    token: TOKEN_PDF,
    urls: ['thumb', 'https://contribution.usercontent.google.com/download?c=pdf-1', 'upload']
  });
}

function docxNode(name) {
  return fileNode(10, name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', {
    token: TOKEN_DOCX,
    urls: ['thumb', 'https://contribution.usercontent.google.com/download?c=docx-1', 'upload']
  });
}

function imageNode(name) {
  return fileNode(1, name, 'image/jpeg', {
    token: '$AVuibg' + name,
    img: 'https://lh3.googleusercontent.com/' + name
  });
}

function textNode(name) {
  return fileNode(10, name, 'text/plain', {
    urls: ['https://contribution.usercontent.google.com/download?c=' + encodeURIComponent(name)]
  });
}

function docxBuffer(xml) {
  // Минимальный ZIP: local header + deflate-raw. Центральный каталог не нужен —
  // модуль умеет fallback по local header (см. gfZipEntry).
  const name = Buffer.from('word/document.xml', 'utf8');
  const raw = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(raw.length, 18);
  local.writeUInt32LE(Buffer.byteLength(xml, 'utf8'), 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  return Buffer.concat([local, name, raw]);
}

function sectionsCount(text) {
  return (text.match(/\[FILE: /g) || []).length;
}

describe('R2: разбор вложений Gemini', function () {
  test('path turn[2][0][4][0][4]: 19 ref-ов, у документов download-URL, у картинок CDN', function () {
    const nodes = [];
    for (let i = 0; i < 19; i++) {
      if (i % 4 === 0) nodes.push(imageNode('photo-' + i + '.jpg'));
      else if (i % 2 === 0) nodes.push(pdfNode('doc-' + i + '.pdf'));
      else nodes.push(docxNode('doc-' + i + '.docx'));
    }
    const turn = turnWith(nodes);
    const h = makeHarness();
    const refs = h.Parser.collectTurnFiles(turn);
    expect(refs).toHaveLength(19);
    expect(refs[0]).toMatchObject({ name: 'photo-0.jpg', type: 1, isImage: true });
    expect(refs[0].img).toContain('lh3.googleusercontent.com');
    const pdf = refs.find(function (r) { return r.name === 'doc-2.pdf'; });
    expect(pdf).toMatchObject({ type: 11, mime: 'application/pdf', isImage: false });
    expect(pdf.dl).toContain('contribution.usercontent.google.com/download');
    expect(h.Parser.collectTurnFiles({})).toEqual([]);
    expect(h.Parser.fileRefFromNode(null)).toBeNull();
    expect(h.Parser.fileRefFromNode([null, 11, '', null])).toBeNull();
  });

  test('модульный fallback повторяет парсер и не падает на мусоре', function () {
    const h = makeHarness();
    const refs = h.Fn.collectTurnFiles(turnWith([pdfNode('a.pdf'), docxNode('b.docx'), imageNode('c.jpg')]));
    expect(refs.map(function (r) { return r.name; })).toEqual(['a.pdf', 'b.docx', 'c.jpg']);
    expect(h.Fn.collectTurnFiles({})).toEqual([]);
    expect(h.Fn.refFromNode('nope')).toBeNull();
  });

  test('collectAttachments-совместимая форма: PDF/DOCX без node[3] и с токеном $AfW', function () {
    const h = makeHarness();
    const refs = h.Fn.collectTurnFiles(turnWith([pdfNode('x.pdf'), docxNode('y.docx')]));
    expect(refs[0].img).toBe('');
    expect(refs[0].token.indexOf('$AfW')).toBe(0);
    expect(refs[0].dl).toContain('/download?c=pdf-1');
    expect(refs[1].dl).toContain('/download?c=docx-1');
  });
});

describe('R2: очередь, дедуп и секции', function () {
  test('DOCX: originalFetch GET credentials include, zip/deflate, текст в секции', async function () {
    const h = makeHarness();
    const xml = '<w:document><w:body>' +
      '<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second &amp; line</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const buf = docxBuffer(xml);
    const ref = h.Fn.collectTurnFiles(turnWith([docxNode('notes.docx')]))[0];

    expect(h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref])).toBe(1);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toContain('contribution.usercontent.google.com/download');
    expect(h.fetchCalls[0].opts.credentials).toBe('include');
    expect(h.fetchCalls[0].opts.signal).toBeTruthy();

    h.fetchCalls[0].resolve(makeRes({ buffer: buf }));
    await flush();
    h.tick(300);

    const section = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(section).toContain('[FILE: notes.docx]\n');
    expect(section).toContain('Hello world');
    expect(section).toContain('Second & line');
    expect(h.deps.emitSnapshot).toHaveBeenCalled();
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
  });

  test('PDF: только заголовки, мета-секция с mime и размером; картинка — CDN-URL', async function () {
    const h = makeHarness();
    const refs = h.Fn.collectTurnFiles(turnWith([pdfNode('report.pdf'), imageNode('photo.jpg')]));
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', refs);

    expect(h.fetchCalls).toHaveLength(1); // изображение не качается
    const before = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(before).toContain('[IMAGE: photo.jpg] https://lh3.googleusercontent.com/photo.jpg');
    expect(before).not.toContain('[FILE: report.pdf');

    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': '12345' } }));
    await flush();
    h.tick(300);

    const section = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(section).toContain('[FILE: report.pdf — application/pdf, 12345 Б, текст не получен]');
    expect(h.fetchCalls[0].opts.credentials).toBe('include');
  });

  test('дубли в одном ходе и повтор файла в другом — один запрос, без дублей секций', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([pdfNode('same.pdf')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref, ref]);
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u2', [ref]);
    expect(h.fetchCalls).toHaveLength(1);

    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': '7' } }));
    await flush();
    h.tick(300);

    const s1 = h.Fn.gfSectionsFor(CHAT, 'u1');
    const s2 = h.Fn.gfSectionsFor(CHAT, 'u2');
    expect(sectionsCount(s1)).toBe(1);
    expect(s1).toBe(s2);

    // повторная эмиссия того же сообщения не добавляет секцию
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);
    expect(h.Fn.gfSectionsFor(CHAT, 'u1')).toBe(s1);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
  });

  test('concurrency 2: третий файл стартует только после завершения одного из двух', async function () {
    const h = makeHarness();
    const refs = h.Fn.collectTurnFiles(turnWith([textNode('a.txt'), textNode('b.txt'), textNode('c.txt')]));
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', refs);
    expect(h.fetchCalls).toHaveLength(2);
    // два активных + один ещё в очереди — очередь не «схлопывается» в active
    expect(h.Fn.gfPendingCount(CHAT)).toBe(3);

    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': '1' }, body: 'A' }));
    await flush();
    expect(h.fetchCalls).toHaveLength(3);

    h.fetchCalls[1].resolve(makeRes({ body: 'B' }));
    h.fetchCalls[2].resolve(makeRes({ body: 'C' }));
    await flush();
    h.tick(300);

    const section = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(section).toContain('[FILE: a.txt]\nA');
    expect(section).toContain('[FILE: b.txt]\nB');
    expect(section).toContain('[FILE: c.txt]\nC');
  });

  test('кап 200 000 символов на файл помечается, тело сверх content-length не читается', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([textNode('long.txt')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);
    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': String(200 * 1024 + 1) } }));
    await flush();
    h.tick(300);
    expect(h.Fn.gfSectionsFor(CHAT, 'u1')).toContain('too-large');

    const h2 = makeHarness();
    const ref2 = h2.Fn.collectTurnFiles(turnWith([textNode('big.txt')]))[0];
    h2.Fn.gfEnqueueTurnFiles(CHAT, 'u2', [ref2]);
    h2.fetchCalls[0].resolve(makeRes({ body: 'x'.repeat(200005) }));
    await flush();
    h2.tick(300);
    const section = h2.Fn.gfSectionsFor(CHAT, 'u2');
    expect(section).toContain('…[обрезано 5]');
    expect(section.indexOf(']' + '\n') > 0).toBe(true);
  });
});

describe('R2: протокол ожидания и сброс', function () {
  test('state-request/response и drain ждут очередь, затем drained', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([textNode('wait.txt')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);

    h.dispatch('ai-cm-deepseek-files-state-request');
    const state = h.lastEvent('ai-cm-deepseek-files-state-response');
    expect(state.detail).toMatchObject({ pending: 1, queued: 0, active: 1 });

    h.dispatch('ai-cm-deepseek-files-drain', JSON.stringify({ requestId: 'rq-1', timeoutMs: 6000 }));
    expect(h.lastEvent('ai-cm-deepseek-files-drain-done')).toBeNull();

    h.fetchCalls[0].resolve(makeRes({ body: 'ok' }));
    await flush();
    expect(h.lastEvent('ai-cm-deepseek-files-drain-done')).toBeNull();
    h.tick(300);

    const done = h.lastEvent('ai-cm-deepseek-files-drain-done');
    expect(done.detail).toMatchObject({ requestId: 'rq-1', ok: true, drained: true, pending: 0 });
  });

  test('drain на простое отвечает idle сразу', function () {
    const h = makeHarness();
    h.dispatch('ai-cm-deepseek-files-drain', { requestId: 'idle-1', timeoutMs: 6000 });
    expect(h.lastEvent('ai-cm-deepseek-files-drain-done').detail).toMatchObject({
      requestId: 'idle-1', ok: true, drained: true, reason: 'idle'
    });
  });

  test('gfReset очищает карту и очередь; поздний ответ не попадает в новый чат', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([textNode('old.txt')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);
    h.Fn.gfReset('conv-2');
    expect(h.Fn.gfSectionsFor(CHAT, 'u1')).toBe('');
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);

    h.fetchCalls[0].resolve(makeRes({ body: 'late' }));
    await flush();
    h.tick(300);
    expect(h.Fn.gfSectionsFor(CHAT, 'u1')).toBe('');
  });
});

describe('R2: связка с перехватчиком/background', function () {
  test('background регистрирует gemini-files перед ingest, версия v12', function () {
    const bg = read('core/background.js');
    expect(bg).toContain("'core/gemini-files.js', 'core/gemini-ingest.js'");
    expect(bg).toContain("'ai-cm-gemini-intercept-v12'");
  });

  test('дренаж очереди разрешён для gemini', function () {
    expect(read('core/base-handler.js')).toContain("site === 'gemini'");
  });
});
