/**
 * tests/adapters/gemini-files-module.test.js — v2.0: экспорт вложений Gemini.
 *
 * Контракт core/gemini-files.js: ref-ы из turn[2][0][4][0][4] (type 1=image,
 * 10=docx, 11=pdf), FIFO-очередь concurrency 2 с дедупом convId|token|name,
 * скачивание через originalFetch с credentials:'include', DOCX-распаковка
 * (DecompressionStream('deflate-raw') → word/document.xml), PDF только
 * мета-секция, изображения — [IMAGE: имя] CDN-URL, кап чтения 200 000 символов
 * на файл (в секцию экспорта — не больше 2 000: крупный файл заменяется меткой
 * с именем и размером), дебаунс-ре-эмит 250 мс и протокол state/drain.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { TextDecoder, TextEncoder } = require('util');
const { DecompressionStream, ReadableStream } = require('stream/web');
const timers = require('timers');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'gemini-files.js'), 'utf8');
const PARSER_SRC = require('../helpers/load-esm.js').loadAsClassic('utils/gemini-batchexecute-parser.ts');
const INGEST_SRC = fs.readFileSync(path.join(ROOT, 'core', 'gemini-ingest.js'), 'utf8');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

/** Вырезает `function <name>(…) { … }` по балансу скобок (для чистых хелперов). */
function fnSource(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}

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
  if (over.location) sandbox.location = over.location;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(PARSER_SRC, ctx, { filename: 'utils/gemini-batchexecute-parser.ts' });
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

/**
 * Ждёт выполнения предиката в реальном времени (не по числу тиков event loop).
 * DOCX распаковывается через DecompressionStream → zlib в libuv-пуле: на быстрой
 * машине хватает 3 setImmediate, а под нагрузкой CI (воркеры jest делят пул) — нет,
 * поэтому `flush()` с фиксированным бюджетом тиков давал пустую секцию "".
 */
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(function (r) { timers.setTimeout(r, 5); });
  }
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

function turnWith(nodes, ts) {
  // turn[2][0][4][0][4] — ровно тот путь, который читает план/парсер.
  // turn[4] — время хода, которое читает extractTurnTs (секунды эпохи).
  const turn = [null, null, [[null, null, null, null, [[null, null, null, null, nodes]]]]];
  if (typeof ts === 'number') turn[4] = [ts];
  return turn;
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

/** PDF-узел с известным размером: изображения/хвост узла [w, h, bytes]. */
function pdfNodeSized(name, size, token, url) {
  const node = fileNode(11, name, 'application/pdf', {
    token: token || TOKEN_PDF,
    urls: ['thumb', 'https://contribution.usercontent.google.com/download?c=' + (url || encodeURIComponent(name)), 'upload']
  });
  node[15] = [null, null, size];
  return node;
}

function docxBuffer(xml, level) {
  // Минимальный ZIP: local header + deflate-raw. Центральный каталог не нужен —
  // модуль умеет fallback по local header (см. gfZipEntry).
  // level=0 (store) — чтобы получить файл реального размера (пины A3/D2).
  const name = Buffer.from('word/document.xml', 'utf8');
  const raw = zlib.deflateRawSync(Buffer.from(xml, 'utf8'), (typeof level === 'number') ? { level: level } : undefined);
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
    // Готовность DOCX — появление записи секции (успех или причина отказа),
    // а не число тиков event loop: см. waitFor.
    const ready = await waitFor(function () {
      return h.Fn.gfSectionsFor(CHAT, 'u1') !== '';
    }, 3000);
    expect(ready).toBe(true);
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
    expect(section).toContain('[FILE: report.pdf — application/pdf, 12345 Б, текст не получен: pdf-no-text]');
    expect(h.fetchCalls[0].opts.credentials).toBe('include');
  });

  test('PDF: Range bytes=0-0 + content-range дают полный размер', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([pdfNode('big.pdf')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);

    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].opts.headers).toEqual({ 'Range': 'bytes=0-0' });

    h.fetchCalls[0].resolve(makeRes({ status: 206, headers: { 'content-range': 'bytes 0-0/987654' } }));
    await flush();
    h.tick(300);

    const section = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(section).toContain('[FILE: big.pdf — application/pdf, 987654 Б, текст не получен: pdf-no-text]');
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
  });

  test('PDF: 206 без валидного content-range — «размер неизвестен», content-length=1 не берётся', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([pdfNode('scan.pdf')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);

    h.fetchCalls[0].resolve(makeRes({ status: 206, headers: { 'content-range': 'bytes 0-0/*', 'content-length': '1' } }));
    await flush();
    h.tick(300);

    expect(h.Fn.gfSectionsFor(CHAT, 'u1'))
      .toContain('[FILE: scan.pdf — application/pdf, размер неизвестен, текст не получен: pdf-no-text]');
  });

  test('дубли в одном ходе — один запрос и одна секция; повторная эмиссия идемпотентна', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([pdfNode('same.pdf')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref, ref]);
    expect(h.fetchCalls).toHaveLength(1);

    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': '7' } }));
    await flush();
    h.tick(300);

    const s1 = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(sectionsCount(s1)).toBe(1);

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

  test('A3: content-length больше прежних 200 КБ не повод для too-large, крупный файл — только метка', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([textNode('big.txt')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);
    // 500 КБ по content-length: прежний жёсткий лимит 200 КБ снят — файл читается
    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': String(500 * 1024) }, body: 'x'.repeat(200005) }));
    await flush();
    h.tick(300);
    const section = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(section).not.toContain('too-large');
    // v2.8: тело читается до GF_TEXT_CAP (200 000), но в секцию крупный файл не
    // вшивается — остаётся метка с именем и размером, без текста и «обрезано».
    expect(section).toBe('\n\n[FILE: big.txt (500 KB)]');
    expect(section).not.toContain('xxxx');
    expect(section).not.toContain('обрезано');
  });

  test('D2 (A3): DOCX ~500 КБ читается целиком, в секции — метка с размером', async function () {
    const h = makeHarness();
    // 250 000 кириллических символов = 500 000 байт в word/document.xml;
    // level 0 (store) держит тело файла ~500 КБ, чтобы проверялся реальный размер.
    const xml = '<w:document><w:body><w:p><w:r><w:t>' + 'Д'.repeat(250000) +
      '</w:t></w:r></w:p></w:body></w:document>';
    const buf = docxBuffer(xml, 0);
    expect(buf.length).toBeGreaterThan(400 * 1024);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const ref = h.Fn.collectTurnFiles(turnWith([docxNode('huge.docx')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);
    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': String(buf.length) }, buffer: ab }));
    const got = await waitFor(function () {
      return /\[FILE: huge\.docx \(\d+(?:\.\d+)? (?:KB|MB)\)\]/.test(h.Fn.gfSectionsFor(CHAT, 'u1'));
    }, 4000);
    expect(got).toBe(true);
    h.tick(300);
    const section = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(section).not.toContain('too-large');
    // v2.8: секция — одна метка с размером, текста файла и «обрезано» нет
    expect(section).not.toContain('Д');
    expect(section).not.toContain('обрезано');
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
  });
});

describe('v2.4 (A+B): дельта пула и единый ключ файла', function () {
  test('D2: два test.pdf с разными размерами — разные файлы, обе секции в экспорте', async function () {
    const h = makeHarness();
    const small = h.Fn.collectTurnFiles(turnWith([pdfNodeSized('test.pdf', 100, TOKEN_PDF, 'pdf-small')]))[0];
    const big = h.Fn.collectTurnFiles(turnWith([pdfNodeSized('test.pdf', 200, TOKEN_PDF, 'pdf-big')]))[0];
    // размер реально прочитан из узла (Фикс B), ключи различаются
    expect(small.size).toBe(100);
    expect(big.size).toBe(200);
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [small, big]);
    expect(h.fetchCalls).toHaveLength(2);

    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': '100' } }));
    h.fetchCalls[1].resolve(makeRes({ headers: { 'content-length': '200' } }));
    await flush();
    h.tick(300);

    const s = h.Fn.gfSectionsFor(CHAT, 'u1');
    expect(sectionsCount(s)).toBe(2);
    expect(s).toContain(', 100 Б,');
    expect(s).toContain(', 200 Б,');
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
  });

  test('D1: один файл в накопительном пуле на 10 ходов → одна секция, textLen не раздувается', async function () {
    const h = makeHarness();
    const ts0 = 1762000000;
    const turns = [];
    // ingest: предварительный проход регистрирует пулы старые→новые,
    // затем эмиссия получает ДЕЛЬТУ пула (Фикс A).
    for (let i = 0; i < 10; i++) {
      const t = turnWith([pdfNode('same.pdf')], ts0 + i * 60);
      turns.push(t);
      h.Parser.registerTurnFileOwner(t, CHAT, 'u' + i, ts0 + i * 60, i);
    }
    for (let i = 0; i < 10; i++) {
      const files = h.Parser.collectTurnFilesForOwner(turns[i], CHAT, 'u' + i, ts0 + i * 60, i);
      h.Fn.gfEnqueueTurnFiles(CHAT, 'u' + i, files);
    }
    expect(h.fetchCalls).toHaveLength(1);

    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': '7' } }));
    await flush();
    h.tick(300);

    let sections = 0;
    let textLen = 0;
    for (let i = 0; i < 10; i++) {
      const s = h.Fn.gfSectionsFor(CHAT, 'u' + i);
      sections += sectionsCount(s);
      textLen += ('вопрос ' + i).length + s.length;
    }
    expect(sections).toBe(1);
    const only = h.Fn.gfSectionsFor(CHAT, 'u0');
    expect(sectionsCount(only)).toBe(1);
    expect(h.Fn.gfSectionsFor(CHAT, 'u9')).toBe('');
    // ровно одна секция на всю базу: длина = сумма ходов + эта секция
    let baseLen = 0;
    for (let i = 0; i < 10; i++) baseLen += ('вопрос ' + i).length;
    expect(textLen).toBe(baseLen + only.length);
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
  });

  test('D1 (дельта): A → A+B → A+B+C даёт по ходам ровно A, B, C', function () {
    const h = makeHarness();
    const ts0 = 1762000000;
    const t1 = turnWith([textNode('A.txt')], ts0);
    const t2 = turnWith([textNode('A.txt'), textNode('B.txt')], ts0 + 60);
    const t3 = turnWith([textNode('A.txt'), textNode('B.txt'), textNode('C.txt')], ts0 + 120);
    h.Parser.registerTurnFileOwner(t1, CHAT, 'u1', ts0, 0);
    h.Parser.registerTurnFileOwner(t2, CHAT, 'u2', ts0 + 60, 1);
    h.Parser.registerTurnFileOwner(t3, CHAT, 'u3', ts0 + 120, 2);

    const names = function (files) { return files.map(function (r) { return r.name; }); };
    expect(names(h.Parser.collectTurnFilesForOwner(t1, CHAT, 'u1', ts0, 0))).toEqual(['A.txt']);
    expect(names(h.Parser.collectTurnFilesForOwner(t2, CHAT, 'u2', ts0 + 60, 1))).toEqual(['B.txt']);
    expect(names(h.Parser.collectTurnFilesForOwner(t3, CHAT, 'u3', ts0 + 120, 2))).toEqual(['C.txt']);
  });

  test('D1 (экспорт): ход 1 = A, ход 2 = B, ход 3 = C в секциях сообщений', async function () {
    const h = makeHarness();
    const ts0 = 1762000000;
    const t1 = turnWith([textNode('A.txt')], ts0);
    const t2 = turnWith([textNode('A.txt'), textNode('B.txt')], ts0 + 60);
    const t3 = turnWith([textNode('A.txt'), textNode('B.txt'), textNode('C.txt')], ts0 + 120);
    h.Parser.registerTurnFileOwner(t1, CHAT, 'u1', ts0, 0);
    h.Parser.registerTurnFileOwner(t2, CHAT, 'u2', ts0 + 60, 1);
    h.Parser.registerTurnFileOwner(t3, CHAT, 'u3', ts0 + 120, 2);
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', h.Parser.collectTurnFilesForOwner(t1, CHAT, 'u1', ts0, 0));
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u2', h.Parser.collectTurnFilesForOwner(t2, CHAT, 'u2', ts0 + 60, 1));
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u3', h.Parser.collectTurnFilesForOwner(t3, CHAT, 'u3', ts0 + 120, 2));
    // concurrency 2: третья загрузка стартует после завершения одной из первых двух
    expect(h.fetchCalls).toHaveLength(2);

    h.fetchCalls[0].resolve(makeRes({ body: 'one' }));
    h.fetchCalls[1].resolve(makeRes({ body: 'two' }));
    await flush();
    expect(h.fetchCalls).toHaveLength(3);
    h.fetchCalls[2].resolve(makeRes({ body: 'three' }));
    await flush();
    h.tick(300);

    const s1 = h.Fn.gfSectionsFor(CHAT, 'u1');
    const s2 = h.Fn.gfSectionsFor(CHAT, 'u2');
    const s3 = h.Fn.gfSectionsFor(CHAT, 'u3');
    expect(sectionsCount(s1)).toBe(1);
    expect(sectionsCount(s2)).toBe(1);
    expect(sectionsCount(s3)).toBe(1);
    expect(s1).toContain('[FILE: A.txt]\none');
    expect(s2).toContain('[FILE: B.txt]\ntwo');
    expect(s3).toContain('[FILE: C.txt]\nthree');
    expect(s1).not.toContain('B.txt');
    expect(s2).not.toContain('A.txt');
    expect(s2).not.toContain('C.txt');
    expect(s3).not.toContain('A.txt');
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
  });

  test('R1: нормальный чат — каждый из 3 файлов остаётся в своём ходе', async function () {
    const h = makeHarness();
    const refs = h.Fn.collectTurnFiles(turnWith([
      textNode('one.txt'), textNode('two.txt'), textNode('three.txt')
    ]));
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [refs[0]]);
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u2', [refs[1]]);
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u3', [refs[2]]);
    expect(h.fetchCalls).toHaveLength(2);

    h.fetchCalls[0].resolve(makeRes({ body: '1' }));
    h.fetchCalls[1].resolve(makeRes({ body: '2' }));
    await flush();
    expect(h.fetchCalls).toHaveLength(3);
    h.fetchCalls[2].resolve(makeRes({ body: '3' }));
    await flush();
    h.tick(300);

    const s1 = h.Fn.gfSectionsFor(CHAT, 'u1');
    const s2 = h.Fn.gfSectionsFor(CHAT, 'u2');
    const s3 = h.Fn.gfSectionsFor(CHAT, 'u3');
    expect(s1).toContain('[FILE: one.txt]\n1');
    expect(s2).toContain('[FILE: two.txt]\n2');
    expect(s3).toContain('[FILE: three.txt]\n3');
    expect(s1).not.toContain('two.txt');
    expect(s2).not.toContain('three.txt');
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
  });

  test('реестр dk→turnId: общий список не уезжает во все ходы, разные файлы не теряются', function () {
    const h = makeHarness();
    const dupTurn = turnWith([pdfNode('same.pdf')]);
    expect(h.Parser.collectTurnFilesForOwner(dupTurn, CHAT, 't1')).toHaveLength(1);
    expect(h.Parser.collectTurnFilesForOwner(dupTurn, CHAT, 't2')).toHaveLength(0);
    // повторный разбор того же хода идемпотентен
    expect(h.Parser.collectTurnFilesForOwner(dupTurn, CHAT, 't1')).toHaveLength(1);
    // другой файл в другом ходе не подавляется
    expect(h.Parser.collectTurnFilesForOwner(turnWith([docxNode('other.docx')]), CHAT, 't2')).toHaveLength(1);
    // без ownerId — прежний контракт: весь список
    expect(h.Parser.collectTurnFiles(dupTurn)).toHaveLength(1);
  });

  test('D1 (v2.3): файл привязан к хронологически первому ходу (min ts), а не к последнему', function () {
    const h = makeHarness();
    const ts1000 = 1762000000;      // 10:00
    const ts1005 = ts1000 + 300;    // 10:05
    const early = turnWith([pdfNode('same.pdf')], ts1000);
    const late = turnWith([pdfNode('same.pdf')], ts1005);
    // ingest сначала регистрирует владельцев (обход с конца: поздний раньше),
    // и только потом эмитит вложения.
    h.Parser.registerTurnFileOwner(late, CHAT, 't-late', ts1005, 1);
    h.Parser.registerTurnFileOwner(early, CHAT, 't-early', ts1000, 0);
    expect(h.Parser.collectTurnFilesForOwner(early, CHAT, 't-early', ts1000, 0)).toHaveLength(1);
    expect(h.Parser.collectTurnFilesForOwner(late, CHAT, 't-late', ts1005, 1)).toHaveLength(0);
  });

  test('R1 (v2.3): дедупликация сохранена — общий файл один раз, уникальные не теряются', function () {
    const h = makeHarness();
    const ts1 = 1762000000;
    const ts2 = ts1 + 300;
    const early = turnWith([pdfNode('shared.pdf')], ts1);
    const late = turnWith([pdfNode('shared.pdf'), docxNode('only-late.docx')], ts2);
    h.Parser.registerTurnFileOwner(late, CHAT, 't-late', ts2, 1);
    h.Parser.registerTurnFileOwner(early, CHAT, 't-early', ts1, 0);
    const a = h.Parser.collectTurnFilesForOwner(early, CHAT, 't-early', ts1, 0);
    const b = h.Parser.collectTurnFilesForOwner(late, CHAT, 't-late', ts2, 1);
    expect(a.map(function (r) { return r.name; })).toEqual(['shared.pdf']);
    expect(b.map(function (r) { return r.name; })).toEqual(['only-late.docx']);
  });
});

describe('v2.3 (A1): база не финализируется, пока очередь вложений не пуста', function () {
  function loadIngestHelpers() {
    const ctx = vm.createContext({ Date: Date });
    vm.runInContext('var GF_FILES_GATE_MS = 30000;\n' +
      fnSource(INGEST_SRC, 'filesGateDecision') + '\n' +
      fnSource(INGEST_SRC, 'baseCompleteWithFiles'), ctx);
    return {
      decision: vm.runInContext('filesGateDecision', ctx),
      baseComplete: vm.runInContext('baseCompleteWithFiles', ctx)
    };
  }

  test('D1: filesPending > 0 держит baseComplete; 30 с лишь перезапускают ожидание', function () {
    const H = loadIngestHelpers();
    // прежний порог «11 файлов и 5 001 мс» больше не финализирует базу
    expect(H.decision(11, 1000, 6001)).toMatchObject({ release: false });
    expect(H.decision(11, 1000, 6000).release).toBe(false);
    // окно ожидания — 30 с: на границе release только перезапускает отсчёт
    expect(H.decision(11, 1000, 1000 + 29999)).toMatchObject({ release: false, delay: 1 });
    expect(H.decision(11, 1000, 1000 + 30000)).toMatchObject({ release: true, delay: 0 });
    // очередь пуста — гейт молчит независимо от времени
    expect(H.decision(0, 0, 999999).release).toBe(false);

    // база полная только при пустой очереди, флаг обрезки больше не спасает
    expect(H.baseComplete(true, 11)).toBe(false);
    expect(H.baseComplete(true, 1)).toBe(false);
    expect(H.baseComplete(true, 0)).toBe(true);
    expect(H.baseComplete(false, 0)).toBe(false);

    const body = fnSource(INGEST_SRC, 'emitBaseSnapshot');
    expect(body).toContain('filesGateDecision(filesPending, filesGateSince[gateKey], gateNow)');
    expect(body).toContain('baseCompleteWithFiles(historyFullByQuiet, filesPending)');
    // filesTruncated остаётся только полем формы снимка и не выставляется ожиданием
    expect(body).toContain('var filesTruncated = false;');
    expect(body).not.toContain('filesTruncated = gate.release');
  });

  test('R1: обычный чат (1 страница, 1 файл) — прежнее поведение без ожиданий', async function () {
    const h = makeHarness();
    const ref = h.Fn.collectTurnFiles(turnWith([textNode('note.txt')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);
    expect(h.Fn.gfPendingCount(CHAT)).toBe(1);
    h.fetchCalls[0].resolve(makeRes({ headers: { 'content-length': '5' }, body: 'hello' }));
    await flush();
    h.tick(300);
    expect(h.Fn.gfSectionsFor(CHAT, 'u1')).toContain('[FILE: note.txt]\nhello');
    expect(h.Fn.gfPendingCount(CHAT)).toBe(0);
    expect(h.deps.emitSnapshot).toHaveBeenCalled();
  });

  test('D1: отложенный fetch-done пере-эмитит снимок, раньше очередь молчит', async function () {
    const h = makeHarness();
    const refs = h.Fn.collectTurnFiles(turnWith([textNode('a.txt'), textNode('b.txt')]));
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', refs);
    // дебаунс-таймеры прошли, но ни один файл ещё не докачан — снимок не финализируется
    h.tick(1000);
    expect(h.deps.emitSnapshot).not.toHaveBeenCalled();
    // fetch-done первого файла → пере-эмиссия (второй всё ещё в очереди)
    h.fetchCalls[0].resolve(makeRes({ body: 'A' }));
    await flush();
    h.tick(300);
    expect(h.deps.emitSnapshot).toHaveBeenCalled();
  });
});

describe('D: authuser скачивания вложений Gemini (403 в мультиаккаунте)', function () {
  const DL = 'https://contribution.usercontent.google.com/download?c=pdf-1';

  function downloadCall(pathname) {
    const h = makeHarness({ location: { pathname: pathname } });
    const ref = h.Fn.collectTurnFiles(turnWith([pdfNode('auth.pdf')]))[0];
    h.Fn.gfEnqueueTurnFiles(CHAT, 'u1', [ref]);
    expect(h.fetchCalls).toHaveLength(1);
    return h.fetchCalls[0];
  }

  test('D1: в пути нет /u/ — authuser не добавляется', function () {
    const call = downloadCall('/app/7c1f0e');
    expect(call.url).toBe(DL);
    expect(call.opts.credentials).toBe('include');
  });

  test('D2: путь /u/1/ — скачивание с &authuser=1', function () {
    expect(downloadCall('/u/1/app/7c1f0e').url).toBe(DL + '&authuser=1');
  });

  test('D3: путь /u/0/ — скачивание с &authuser=0 (аккаунт по умолчанию)', function () {
    expect(downloadCall('/u/0/app/7c1f0e').url).toBe(DL + '&authuser=0');
  });
});

describe('v2.1: дедуп ходов/вложений и метрика без двойного счёта', function () {
  test('один и тот же ход с двух страниц не дублируется (user + assistant)', function () {
    const Logic = require('../helpers/load-esm.js').loadEsmModule('utils/gemini-intercept-logic.ts');
    const msgs = [
      { role: 'user', text: 'Вопрос', id: 'h1_user' },
      { role: 'assistant', text: 'Ответ', id: 'h1_assistant' },
      { role: 'user', text: 'Вопрос', id: 'h1_user' },
      { role: 'assistant', text: 'Ответ', id: 'h1_assistant' },
      { role: 'user', text: 'Второй', id: 'h2_user' },
      { role: 'assistant', text: 'Ответ 2', id: 'h2_assistant' }
    ];
    const out = Logic.sanitizeFinalMessages(msgs);
    expect(out.map(function (m) { return m.text; })).toEqual(['Вопрос', 'Ответ', 'Второй', 'Ответ 2']);
    expect(out.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'user', 'assistant']);

    // подряд идущие user с одинаковым текстом (разные id) тоже один ход
    const adj = Logic.sanitizeFinalMessages([
      { role: 'user', text: 'Повтор', id: 'a_user' },
      { role: 'user', text: 'Повтор', id: 'b_user' }
    ]);
    expect(adj).toHaveLength(1);
  });

  test('сохранённый текст с секцией + новая секция = ровно одна секция', function () {
    const ing = read('core/gemini-ingest.js');
    const strip = new Function('return (' + fnSource(ing, 'stripAttachmentSections') + ');')();
    const section = '\n\n[FILE: report.pdf — application/pdf, 12345 Б, текст не получен]';
    const saved = 'Вопрос' + section;

    expect(strip(saved)).toBe('Вопрос');
    expect((strip(saved) + section).match(/\[FILE: /g)).toHaveLength(1);
    expect(strip('просто текст')).toBe('просто текст');
    expect(strip('')).toBe('');

    // эмиссия и восстановление используют один и тот же стрип
    expect(fnSource(ing, 'emitBaseSnapshot')).toContain('mtext = stripAttachmentSections(mtext) + fileSections;');
    expect(fnSource(ing, 'sanitizeRestoredTurn')).toContain('stripAttachmentSections(');
    expect(fnSource(ing, 'handleOuter')).toContain('stableTurnFallbackId(t, out)');
    expect(fnSource(ing, 'handleOuter')).not.toContain("('idx' + out.total++)");
  });

  test('fallback-id хода не зависит от порядка обхода', function () {
    const ing = read('core/gemini-ingest.js');
    const stable = new Function('extractTurnTs', 'extractTurnR1',
      'return (' + fnSource(ing, 'stableTurnFallbackId') + ');')(
      function (t) { return (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][0] === 'number') ? t[1][0] : 0; },
      function (t) { return (Array.isArray(t) && Array.isArray(t[1])) ? t[1][1] : null; }
    );
    const turn = [null, [1700000000, 'r1abc'], null, null, 'Привет'];
    const a = stable(turn, { total: 0 });
    const b = stable(turn, { total: 5 });
    expect(a).toMatch(/^h[0-9a-f]{8}$/);
    expect(a).toBe(b);

    const other = [null, [1700000001, 'r1abc'], null, null, 'Привет'];
    expect(stable(other, { total: 0 })).not.toBe(a);

    // ход без единого признака — крайний случай idxN
    expect(stable([], { total: 7 })).toBe('idx7');
  });

  test('B1/D3: частичное наличие файлов — в метрику идёт только доля неотрендеренного пула', function () {
    const content = read('core/content.js');
    // оба пути метрики (бейдж и GET_STATS) используют ОДИН хелпер
    expect(content.split('var attachAdd = aiCmAttachPendingTokens(fullText, netAttachTokens, netAttachBreak);').length - 1).toBe(1);
    expect(content.split('var attachAddM = aiCmAttachPendingTokens(fullText, netAttachTokens, netAttachBreak);').length - 1).toBe(1);
    // прежнего двоичного гейта «есть [FILE: → пул целиком в ноль» больше нет
    expect(content).not.toContain("indexOf('[FILE:') === -1");
    expect(content).not.toMatch(/(^|\n)\s*tokenEstimate \+= netAttachTokens;/);

    const pending = new Function('return (' + fnSource(content, 'aiCmAttachPendingTokens') + ');')();

    // все файлы отрендерены — добавки нет (двойного счёта нет)
    expect(pending('Вопрос\n\n[FILE: a.txt]\nтело\n\n[FILE: b.txt]\nтело', 2860, { imgCount: 0, docCount: 2 })).toBe(0);
    // D3: один отрендерен, второй ещё качается → учитывается ровно половина пула
    expect(pending('Вопрос\n\n[FILE: a.txt]\nтело', 2860, { imgCount: 0, docCount: 2 })).toBe(1430);
    // секций нет — весь пул, как раньше
    expect(pending('Вопрос', 2860, { imgCount: 0, docCount: 2 })).toBe(2860);
    // смешанный набор: картинка ещё качается, файл уже в тексте → остаётся доля картинки
    expect(pending('Вопрос\n\n[FILE: a.txt]\nтело', 1000, { imgTokens: 500, imgCount: 1, docTokens: 500, docCount: 1 })).toBe(500);
    // старый detail без attachBreak: дробление неизвестно — не добавляем (секции уже в тексте)
    expect(pending('Вопрос\n\n[FILE: a.txt]\nтело', 2500, null)).toBe(0);
    expect(pending('Вопрос', 0, null)).toBe(0);
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
  test('background регистрирует gemini-files перед ingest, версия v18', function () {
    const bg = read('core/background.js');
    expect(bg).toContain("'core/gemini-files.js', 'core/gemini-payload.js', 'core/gemini-ingest.js'");
    expect(bg).toContain("'ai-cm-gemini-intercept-v18'");
  });

  test('дренаж очереди разрешён для gemini', function () {
    expect(read('core/base-handler.js')).toContain("site === 'gemini'");
  });
});

/**
 * v2.8 (живая приёмка 2026-11-09): текст вложения, вшиваемый в СЕКЦИЮ (а значит
 * в текст сообщения и в экспорт), ограничен 2 000 символов. Крупный файл не
 * вшивается вовсе: остаётся метка `[FILE: имя (размер KB/MB)]` — без текста и
 * без маркера `…[обрезано N]`. Повторно приложенная выгрузка Gemini больше не
 * раздувает следующую, а потеря содержимого видна по одной строке с размером.
 */
describe('v2.8: крупное вложение в секции — только метка с размером', function () {
  test('constants.sectionTextCap = 2 000', function () {
    const h = makeHarness();
    expect(h.Fn.constants.sectionTextCap).toBe(2000);
  });

  test('текст сверх капа не вшивается: метка имени и размера, без «обрезано»', function () {
    const h = makeHarness();
    const cap = h.Fn.constants.sectionTextCap;
    const text = 'x'.repeat(cap + 4321);
    const section = h.Fn.sectionOf({ name: 'gemini-e1020dba.md', ok: true, text: text, size: 1572864 });
    expect(section).toBe('\n\n[FILE: gemini-e1020dba.md (1.5 MB)]');
    expect(section).not.toContain('обрезано');
    expect(section).not.toContain('truncated');
    expect(section).not.toContain('x'.repeat(10));
  });

  test('размер без узла/заголовка считается по байтам текста (UTF-8)', function () {
    const h = makeHarness();
    const cap = h.Fn.constants.sectionTextCap;
    // 2001 байт ASCII → 2 KB (округление до одного знака после запятой)
    const ascii = h.Fn.sectionOf({ name: 'notes.md', ok: true, text: 'x'.repeat(cap + 1) });
    expect(ascii).toBe('\n\n[FILE: notes.md (2 KB)]');
    // 2001 кириллический символ = 4002 байта → 3.9 KB
    const utf = h.Fn.sectionOf({ name: 'ru.md', ok: true, text: 'Д'.repeat(cap + 1) });
    expect(utf).toBe('\n\n[FILE: ru.md (3.9 KB)]');
  });

  test('граница капа: ровно 2 000 символов ещё уходят текстом', function () {
    const h = makeHarness();
    const cap = h.Fn.constants.sectionTextCap;
    const text = 'y'.repeat(cap);
    const section = h.Fn.sectionOf({ name: 'edge.md', ok: true, text: text, size: 4096 });
    expect(section).toBe('\n\n[FILE: edge.md]\n' + text);
    expect(section).not.toContain('KB');
  });

  test('текст в пределах капа уходит без пометки', function () {
    const h = makeHarness();
    const section = h.Fn.sectionOf({ name: 'small.md', ok: true, text: 'hello' });
    expect(section).toBe('\n\n[FILE: small.md]\nhello');
  });

  test('мета-секция «текст не получен» не меняется', function () {
    const h = makeHarness();
    const section = h.Fn.sectionOf({
      name: 'scan.pdf', ok: false,
      note: 'application/pdf, 10 Б, текст не получен', reason: 'pdf-no-text'
    });
    expect(section).toBe('\n\n[FILE: scan.pdf — application/pdf, 10 Б, текст не получен: pdf-no-text]');
  });
});

/**
 * v2.7: граница капа ПОТОКОВОГО чтения тела. Раньше чанк, попавший ровно на
 * GF_TEXT_CAP, оставлял truncated=false (живой ди-агностик: chars=200000
 * truncated=false), хотя reader уже отменён и хвост тела потерян.
 */
describe('v2.7: граница капа тела вложения (truncated)', function () {
  function readTextCapped() {
    const capSrc = fnSource(MODULE_SRC, 'gfCapText');
    const readSrc = fnSource(MODULE_SRC, 'gfReadTextCapped');
    return new Function(
      'GF_TEXT_CAP', 'gfDiag', 'gfStr', 'TextDecoder',
      'var gfCapText = (' + capSrc + ');\nreturn (' + readSrc + ');'
    )(200000, function () { }, function (v) { return typeof v === 'string' ? v : ''; }, TextDecoder);
  }

  function streamOf(text) {
    return new ReadableStream({
      start: function (c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      }
    });
  }

  test('ровно GF_TEXT_CAP символов помечаются truncated=true', async function () {
    const read = readTextCapped();
    const out = await read({ body: streamOf('y'.repeat(200000)) });
    expect(out.text.length).toBe(200000);
    expect(out.truncated).toBe(true);
  });

  test('тело короче капа помечается truncated=false', async function () {
    const read = readTextCapped();
    const out = await read({ body: streamOf('y'.repeat(199999)) });
    expect(out.text.length).toBe(199999);
    expect(out.truncated).toBe(false);
  });
});
