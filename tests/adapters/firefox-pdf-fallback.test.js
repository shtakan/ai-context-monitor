'use strict';
/**
 * A2 (план plan-firefox-cold-start-bugs): резервный разбор PDF в странице.
 *
 * ПРОБЛЕМА. Firefox: offscreen-документа нет, event page засыпает на холодном
 * старте, и Port вкладки рвётся посреди разбора — мост отдавал pdf-aborted при
 * живых байтах (5 МБ уже в странице).
 *
 * ЧТО ПИНУЕТСЯ. Мост core/content.js (секция между маркерами [pdf-bridge:start]
 * и [pdf-bridge:end]) исполняется в vm-песочнице вместе с настоящим
 * core/pdf-bytes.js, поэтому проверяется не текст, а поведение:
 *
 *   D1  Chrome, порт умирает дважды → реконнект, затем локальный разбор
 *       (pdf-bytes.js) → текст извлечён, страницы посчитаны;
 *   D1b Firefox: локальный разбор первым, chrome.runtime.connect не зовётся
 *       вообще, байты уходят ArrayBuffer'ом с transfer (без base64 и без
 *       5 МБ по messaging-каналу);
 *   R1  Chrome, живой порт → результат приходит от брокера (offscreen-путь
 *       не тронут), локальный разбор не запрашивается; брокер по-прежнему
 *       содержит offscreen-хост;
 *   П1  один реконнект достаточно: второй порт отвечает → текст от брокера,
 *       локального разбора нет;
 *   П2  мусор вместо PDF + мёртвый порт → ровно один отказ pdf-aborted;
 *   E1…E4  сам локальный извлекатель: FlateDecode (DecompressionStream),
 *       hex-строки и UTF-16BE, pdf-invalid, pdf-no-text;
 *   D1/R1 (фильтрация мусора): сложная кодировка реального PDF (CID-хексы,
 *       \001-escape, бинарные шрифт и XMP) → чистый текст без SOH; простой
 *       текстовый PDF разбирается как раньше.
 *
 * Пины Xray/дедупликации (plan-firefox-xray-pdf, Фиксы A/B/C):
 *   D1 (Xray)  ArrayBuffer из чужого realm (instanceof ложен, как у Xray-обёртки)
 *              не отбрасывается: байты копируются в свой буфер, чанк уходит
 *              ArrayBuffer'ом с transfer, текст извлекается, ошибок нет;
 *   D2 (взрыв)  пул с переподписанной `dl`-ссылкой — тот же файл: одна запись,
 *              один [FILE:]-блок, повторный разбор хода не размножает текст;
 *   R1 (байты)  Chrome-путь прежний: те же байты, тот же ArrayBuffer с transfer.
 *   C          холодный старт тестового чата снимает латчи автоэкспорта
 *              (aiCmAutoExportFiredOnce / preTrimExportFired), иначе второй
 *              прогон не эмитит текст и дедупликацию не измерить.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { DecompressionStream: RealDecompressionStream } = require('stream/web');

const ROOT = path.join(__dirname, '..', '..');
const CONTENT_PATH = path.join(ROOT, 'core', 'content.js');
const BYTES_PATH = path.join(ROOT, 'core', 'pdf-bytes.js');
const BROKER_PATH = path.join(ROOT, 'core', 'pdf-parser.js');
const PARSER_PATH = path.join(ROOT, 'utils', 'gemini-batchexecute-parser.ts');
const START_MARK = '// [pdf-bridge:start]';
const END_MARK = '// [pdf-bridge:end]';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

/** Секция моста из боевого core/content.js (маркеры — часть контракта). */
function readBridgeSource() {
  const src = fs.readFileSync(CONTENT_PATH, 'utf8');
  const a = src.indexOf(START_MARK);
  const b = src.indexOf(END_MARK);
  if (a < 0 || b <= a) throw new Error('в core/content.js нет маркеров ' + START_MARK + ' / ' + END_MARK);
  return src.slice(a + START_MARK.length, b);
}

function FakeCustomEvent(type, init) {
  this.type = type;
  this.detail = init && init.detail !== undefined ? init.detail : null;
  this.bubbles = !!(init && init.bubbles);
  this.defaultPrevented = false;
}

/**
 * DecompressionStream в MAIN-песочнице: байты приходят из другого realm, поэтому
 * перед записью приводим их к Buffer хоста. Ведёт себя как настоящий поток
 * (getWriter/write/close/getReader/read), чтобы код резерва шёл без развилок.
 */
function DecompressionStreamShim(format) {
  const inner = new RealDecompressionStream(format);
  return {
    writable: {
      getWriter() {
        const writer = inner.writable.getWriter();
        return {
          write(chunk) {
            const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            return writer.write(Buffer.from(bytes));
          },
          close() { return writer.close(); }
        };
      }
    },
    readable: { getReader() { return inner.readable.getReader(); } }
  };
}

function makePortHost(page, name, index) {
  const port = {
    name: name,
    index: index,
    messages: [],
    disconnected: false,
    onMessage: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    onDisconnect: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    postMessage(msg) {
      port.messages.push(msg);
      if (typeof page.onPortMessage === 'function') page.onPortMessage(port, msg);
    },
    disconnect() {
      port.disconnected = true;
      port.fireDisconnect();
    },
    fireDisconnect() {
      const listeners = port.onDisconnect.listeners.slice();
      for (let i = 0; i < listeners.length; i++) {
        try { listeners[i](); } catch (e) { page.errors.push(e); }
      }
    },
    emit(msg) {
      const listeners = port.onMessage.listeners.slice();
      for (let i = 0; i < listeners.length; i++) {
        try { listeners[i](msg); } catch (e) { page.errors.push(e); }
      }
    }
  };
  return port;
}

/**
 * Мини-страница: window с настоящей семантикой событий/postMessage, фейковый
 * chrome.runtime, MAIN-хелпер и секция моста в одной vm-песочнице.
 */
function createPage(options) {
  const o = options || {};
  const listeners = Object.create(null);
  const page = {
    errors: [],
    posted: [],
    transfers: [],
    connectCalls: [],
    ports: [],
    results: [],
    logs: [],
    onPortMessage: null,
    onConnect: null
  };

  const win = {
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent(ev) {
      if (!ev || typeof ev.type !== 'string') return false;
      const arr = (listeners[ev.type] || []).slice();
      for (let i = 0; i < arr.length; i++) {
        try { arr[i](ev); } catch (e) { page.errors.push(e); }
      }
      return true;
    },
    postMessage(msg, targetOrigin, transfer) {
      page.posted.push({ msg: msg, transfer: transfer || null });
      if (Array.isArray(transfer)) for (let i = 0; i < transfer.length; i++) page.transfers.push(transfer[i]);
      setTimeout(function () {
        win.dispatchEvent({ type: 'message', source: win, data: msg, origin: 'null' });
      }, 0);
    }
  };
  win.navigator = { userAgent: o.userAgent || CHROME_UA };
  page.win = win;

  const chromeObj = {
    runtime: {
      lastError: undefined,
      connect(info) {
        page.connectCalls.push(info);
        const port = makePortHost(page, info && info.name, page.ports.length);
        page.ports.push(port);
        if (typeof page.onConnect === 'function') {
          setTimeout(function () { page.onConnect(port, port.index); }, 0);
        }
        return port;
      }
    }
  };

  const sandbox = {
    window: win,
    self: win,
    navigator: win.navigator,
    console: { warn: function () {}, log: function () {}, error: function () {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    CustomEvent: FakeCustomEvent,
    DecompressionStream: DecompressionStreamShim,
    atob: function (s) { return Buffer.from(String(s), 'base64').toString('binary'); },
    btoa: function (s) { return Buffer.from(String(s), 'binary').toString('base64'); },
    chrome: chromeObj,
    document: {},
    debugLog: function () { page.logs.push(Array.prototype.slice.call(arguments)); }
  };

  page.context = vm.createContext(sandbox);
  page.toBytes = vm.runInContext('(function (arr) { return new Uint8Array(arr); })', page.context);
  page.getGlobal = function (expr) { return vm.runInContext(expr, page.context); };
  page.setGlobal = function (expr, value) {
    page.context.__probe = value;
    vm.runInContext(expr + ' = __probe;', page.context);
  };

  win.addEventListener('ai-cm-pdf-result', function (ev) {
    page.results.push(JSON.parse(ev.detail));
  });

  vm.runInContext(fs.readFileSync(BYTES_PATH, 'utf8'), page.context, { filename: BYTES_PATH });
  vm.runInContext(readBridgeSource(), page.context, { filename: CONTENT_PATH });
  return page;
}

/** PDF одной страницы: литеральный content-стрим, по желанию сжат Flate. */
function buildPdf(opts) {
  const o = opts || {};
  const content = (typeof o.content === 'string') ? o.content : 'BT /F1 18 Tf 72 720 Td (Hello PDF fallback) Tj ET';
  let stream;
  let filter = '';
  if (o.flate) {
    stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
    filter = ' /Filter /FlateDecode';
  } else {
    stream = Buffer.from(content, 'latin1');
  }
  const head = [
    '%PDF-1.4',
    '1 0 obj',
    '<</Type /Catalog /Pages 2 0 R>>',
    'endobj',
    '2 0 obj',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    'endobj',
    '3 0 obj',
    '<</Type /Page /Parent 2 0 R /Contents 4 0 R>>',
    'endobj',
    '4 0 obj',
    '<</Length ' + stream.length + filter + '>>',
    'stream'
  ].join('\n') + '\n';
  const tail = '\nendstream\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), stream, Buffer.from(tail, 'latin1')]);
}

/**
 * «Сложная кодировка» как в реальном PDF: CID/Type0-шрифт отдаёт глифы
 * двухбайтовыми hex-кодами, в литералах есть восьмеричные escape'ы, рядом лежат
 * бинарная программа шрифта и XMP-поток. До фильтрации байты 0x00–0x1F уезжали
 * в текст вложения (SOH = \x01), потому что decodeHex/decodeLiteral не отличают
 * код глифа от печатного символа.
 */
function buildEncodedPdf() {
  const content = [
    'BT /F1 12 Tf 72 720 Td (Document title) Tj ET',
    'BT /F2 12 Tf 72 700 Td <00010002000300040005> Tj ET',
    'BT /F1 12 Tf 72 680 Td (\\001\\002Report body) Tj ET'
  ].join('\n');
  // Программа шрифта: нули/управляющие байты и строка, похожая на операнд Tj.
  const font = Buffer.concat([
    Buffer.from([0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from('(font program bytes) Tj', 'latin1')
  ]);
  const xmp = Buffer.from('<x:xmpmeta>(metadata \x01\x02 junk)</x:xmpmeta>', 'latin1');
  const head = '%PDF-1.4\n' +
    '1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n' +
    '2 0 obj\n<</Type /Pages /Count 1 /Kids [3 0 R]>>\nendobj\n' +
    // /Metadata в page-словаре — соседнем объекте: его нельзя путать с самим
    // stream-объектом (иначе content-стрим ошибочно считается метаданными).
    '3 0 obj\n<</Type /Page /Parent 2 0 R /Contents 4 0 R /Metadata 6 0 R>>\nendobj\n';
  return Buffer.concat([
    Buffer.from(head, 'latin1'),
    Buffer.from('4 0 obj\n<</Length ' + content.length + '>>\nstream\n' + content +
      '\nendstream\nendobj\n', 'latin1'),
    Buffer.from('5 0 obj\n<</Length ' + font.length + ' /Length1 12 /FontFile2 3 0 R>>\nstream\n', 'latin1'),
    font,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
    Buffer.from('6 0 obj\n<</Type /Metadata /Subtype /XML /Length ' + xmp.length +
      '>>\nstream\n', 'latin1'),
    xmp,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')
  ]);
}

/** MAIN отдаёт байты чанками (как postChunks в core/pdf-bytes.js). */
function feed(page, bytes, opts) {
  const o = opts || {};
  const id = o.id || 'job-1';
  const chunkSize = o.chunkSize || bytes.length;
  const parts = [];
  for (let at = 0; at < bytes.length; at += chunkSize) {
    parts.push(bytes.subarray(at, Math.min(at + chunkSize, bytes.length)));
  }
  for (let seq = 0; seq < parts.length; seq++) {
    (function (part, index) {
      setTimeout(function () {
        page.win.postMessage({
          source: 'ai-cm-pdf',
          id: id,
          seq: index,
          total: parts.length,
          bytes: part,
          maxChars: o.maxChars || 200000
        }, '*', [part.buffer]);
      }, 0);
    }(parts[seq], seq));
  }
  return id;
}

function localRequests(page) {
  return page.posted.filter(function (p) {
    return p.msg && p.msg.source === 'ai-cm-pdf-local';
  });
}

function byteChunks(page) {
  return page.posted.filter(function (p) {
    return p.msg && p.msg.source === 'ai-cm-pdf';
  });
}

/**
 * Фикс C: холодный старт тестового чата. Латчи автоэкспорта — модульные мапы:
 *   state.js:            aiCmAutoExportFiredOnce['gemini|' + convId]
 *   export-manager.js:   preTrimExportFired[convId]
 * Прогретый процесс держит их взведёнными, поэтому холодный старт тестового
 * чата снимает обе записи (иначе повторный прогон не эмитит базу и текст
 * дедупликации не измерить). Чужие чаты не трогаем.
 */
const TEST_CHAT = 'c_e1020dbabcfa5a02';

function coldStartResetAutoExportLatches(convId, state) {
  if (!state || !state.aiCmAutoExportFiredOnce || !state.preTrimExportFired) return false;
  if (convId !== TEST_CHAT) return false;
  delete state.aiCmAutoExportFiredOnce['gemini|' + convId];
  delete state.preTrimExportFired[convId];
  return true;
}

/** Ход batchexecute с пулом вложений: turn[2][0][4][0][4] = nodes. */
function turnWithFileNodes(nodes, ts) {
  const turn = [null, null, null, [], [ts || 0]];
  turn[2] = [[null, null, null, null, [[null, null, null, null, nodes]]]];
  return turn;
}

/** Узел вложения документа: download-ссылка `dl` переподписывается в ответах. */
function docNode(name, dl, size, index) {
  const node = [null, 11, name, null, null, 'token-' + (index || 0), null,
    ['https://drive-thumb/' + (index || 0) + '?sig=' + (index || 0), dl, 'upload-' + (index || 0)],
    1, [1762000000, 0], null, 'application/pdf'];
  node[15] = [null, null, typeof size === 'number' ? size : 0];
  return node;
}

/** Текст вложения так, как его собирает экспорт: [FILE: имя]. */
function fileSections(refs) {
  return refs.map(function (ref) { return '\n\n[FILE: ' + ref.name + ']'; }).join('');
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(function (r) { setTimeout(r, 5); });
  }
  throw new Error('не дождались: ' + label);
}

describe('A2: резервный разбор PDF в странице (Firefox pdf-aborted)', () => {
  test('D1: Chrome — порт умер дважды → реконнект, затем pdf-bytes.js, текст извлечён', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const pdf = buildPdf({ content: 'BT /F1 18 Tf 72 720 Td (Hello PDF fallback) Tj ET' });
    const id = feed(page, page.toBytes(Array.from(pdf)));

    let deaths = 2;
    page.onPortMessage = function (port, msg) {
      if (msg.t !== 'begin' || deaths <= 0) return;
      deaths--;
      setTimeout(function () { port.fireDisconnect(); }, 0);
    };

    await waitFor(function () { return page.results.length >= 1; }, 'результат D1');
    expect(page.errors).toEqual([]);
    expect(page.connectCalls.length).toBe(2);
    expect(page.results).toHaveLength(1);
    expect(page.results[0].id).toBe(id);
    expect(page.results[0].ok).toBe(true);
    expect(page.results[0].text).toContain('Hello PDF fallback');
    expect(page.results[0].pages).toBe(1);
    expect(page.results[0].reason).toBe('');
    expect(localRequests(page).length).toBe(1);
    // 5 МБ байтов не гоняются base64-ом: в local-запрос уходит ArrayBuffer с transfer.
    const req = localRequests(page)[0].msg;
    expect(Object.prototype.toString.call(req.bytes)).toBe('[object ArrayBuffer]');
    expect(page.posted.filter(function (p) { return p.transfer; }).length).toBeGreaterThan(0);
  });

  test('D1b: Firefox — локальный разбор первым, chrome.runtime.connect не вызывается', async () => {
    const page = createPage({ userAgent: FIREFOX_UA });
    const pdf = buildPdf({ content: 'BT (Firefox local) Tj ET' });
    feed(page, page.toBytes(Array.from(pdf)));

    await waitFor(function () { return page.results.length >= 1; }, 'результат D1b');
    expect(page.errors).toEqual([]);
    expect(page.connectCalls).toEqual([]);
    expect(page.results[0].ok).toBe(true);
    expect(page.results[0].text).toContain('Firefox local');
    expect(localRequests(page).length).toBe(1);
    expect(page.getGlobal('aiCmPdfLocalReady')).toBe(true);
  });

  test('R1: Chrome — живой порт отдаёт результат брокера, локальный разбор не зовётся', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const pdf = buildPdf({});
    page.onPortMessage = function (port, msg) {
      if (msg.t !== 'end') return;
      setTimeout(function () {
        port.emit({ t: 'result', ok: true, text: 'BROKER TEXT', pages: 3, truncated: false, reason: '', size: 4096, ms: 12 });
      }, 0);
    };
    feed(page, page.toBytes(Array.from(pdf)));

    await waitFor(function () { return page.results.length >= 1; }, 'результат R1');
    expect(page.errors).toEqual([]);
    expect(page.connectCalls.length).toBe(1);
    expect(page.connectCalls[0].name).toBe('ai-cm-pdf:job-1');
    expect(page.results).toHaveLength(1);
    expect(page.results[0].ok).toBe(true);
    expect(page.results[0].text).toBe('BROKER TEXT');
    expect(page.results[0].pages).toBe(3);
    expect(localRequests(page)).toEqual([]);

    // Offscreen-хост Chrome не тронут: решение о нём осталось в брокере.
    const broker = fs.readFileSync(BROKER_PATH, 'utf8');
    expect(broker).toContain("HOST_URL = 'parser/offscreen.html'");
    expect(broker).toContain('hasOffscreenHost');
    expect(broker).toContain('createDocument');
    // Мост не зовёт offscreen API: в Chrome он по-прежнему только Port.
    expect(readBridgeSource()).not.toContain('chrome.offscreen');
    expect(readBridgeSource()).not.toContain('createDocument');
  });

  test('П1: одного реконнекта достаточно — второй порт ответил, локального разбора нет', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const pdf = buildPdf({});
    let dials = 0;
    page.onPortMessage = function (port, msg) {
      if (msg.t === 'begin') {
        dials++;
        if (dials === 1) setTimeout(function () { port.fireDisconnect(); }, 0);
        return;
      }
      if (msg.t !== 'end') return;
      setTimeout(function () {
        port.emit({ t: 'result', ok: true, text: 'RETRY OK', pages: 1, reason: '', size: 512 });
      }, 0);
    };
    feed(page, page.toBytes(Array.from(pdf)));

    await waitFor(function () { return page.results.length >= 1; }, 'результат П1');
    expect(page.errors).toEqual([]);
    expect(page.connectCalls.length).toBe(2);
    expect(page.results[0].ok).toBe(true);
    expect(page.results[0].text).toBe('RETRY OK');
    expect(localRequests(page)).toEqual([]);
  });

  test('П2: мусор вместо PDF и мёртвый порт → ровно один pdf-aborted', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    feed(page, page.toBytes(Array.from(Buffer.from('это не pdf, а обычный текст', 'utf8'))));

    let deaths = 2;
    page.onPortMessage = function (port, msg) {
      if (msg.t !== 'begin' || deaths <= 0) return;
      deaths--;
      setTimeout(function () { port.fireDisconnect(); }, 0);
    };

    await waitFor(function () { return page.results.length >= 1; }, 'результат П2');
    expect(page.errors).toEqual([]);
    expect(page.results).toHaveLength(1);
    expect(page.results[0].ok).toBe(false);
    expect(page.results[0].reason).toBe('pdf-aborted');
    expect(page.results[0].text).toBe('');
  });

  test('E1: FlateDecode-стрим разбирается локально (DecompressionStream)', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const pdf = buildPdf({ flate: true, content: 'BT /F1 12 Tf (Compressed page text) Tj ET' });
    const res = await page.getGlobal('window').AiCmPdf.parseLocal(page.toBytes(Array.from(pdf)));
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Compressed page text');
    expect(res.pages).toBe(1);
    expect(res.size).toBe(pdf.length);
  });

  test('E2: hex-строки и UTF-16BE (BOM FE FF) декодируются', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const utf16 = '(\u00FE\u00FF\u0000H\u0000i) Tj';
    const pdf = buildPdf({ content: 'BT <48656C6C6F> Tj ' + utf16 + ' ET' });
    const res = await page.getGlobal('window').AiCmPdf.parseLocal(page.toBytes(Array.from(pdf)));
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Hello');
    expect(res.text).toContain('Hi');
  });

  test('E3: не-PDF → pdf-invalid; PDF без текстовых стримов → pdf-no-text', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const api = page.getGlobal('window').AiCmPdf;
    const notPdf = await api.parseLocal(page.toBytes(Array.from(Buffer.from('plain text'))));
    expect(notPdf).toMatchObject({ ok: false, reason: 'pdf-invalid' });

    const empty = await api.parseLocal(page.toBytes(Array.from(buildPdf({ content: '' }))));
    expect(empty.ok).toBe(false);
    expect(empty.reason).toBe('pdf-no-text');
  });

  test('E4: лимит maxChars соблюдается, truncated=true', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const long = 'BT (' + 'A'.repeat(500) + ') Tj ET';
    const pdf = buildPdf({ content: long });
    const res = await page.getGlobal('window').AiCmPdf.parseLocal(page.toBytes(Array.from(pdf)), { maxChars: 40 });
    expect(res.ok).toBe(true);
    expect(res.text.length).toBe(40);
    expect(res.truncated).toBe(true);
  });

  test('D1: сложная кодировка (CID-хексы, \\001-escape, бинарный шрифт) → чистый текст без SOH', async () => {
    const page = createPage({ userAgent: FIREFOX_UA });
    const pdf = buildEncodedPdf();
    const res = await page.getGlobal('window').AiCmPdf.parseLocal(page.toBytes(Array.from(pdf)));

    expect(res.ok).toBe(true);
    // Содержание на месте: фильтр обязан резать мусор, а не текст.
    expect(res.text).toContain('Document title');
    expect(res.text).toContain('Report body');
    expect(res.pages).toBe(1);
    // Бинарный мусор не добрался до вложения: ни SOH (\x01), ни ESC, ни C1.
    expect(res.text).not.toContain('\x01');
    expect(res.text).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    expect(res.text).not.toMatch(/[\x7F-\x9F]/);
    // Бинарные потоки (программа шрифта, XMP) не стали текстом.
    expect(res.text).not.toContain('font program bytes');
    expect(res.text).not.toContain('metadata');
  });

  test('D1b: PDF только из CID-кодов → pdf-no-text, а не мусор (откат на pdf.js)', async () => {
    const page = createPage({ userAgent: FIREFOX_UA });
    const pdf = buildPdf({ content: 'BT /F2 12 Tf 72 720 Td <00010002000300040005> Tj ET' });
    const res = await page.getGlobal('window').AiCmPdf.parseLocal(page.toBytes(Array.from(pdf)));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('pdf-no-text');
    expect(res.text).toBe('');
  });

  test('R1: простой текстовый PDF разбирается как раньше', async () => {
    const page = createPage({ userAgent: FIREFOX_UA });
    const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (Simple text stays intact) Tj ET' });
    const res = await page.getGlobal('window').AiCmPdf.parseLocal(page.toBytes(Array.from(pdf)));
    expect(res.ok).toBe(true);
    expect(res.text).toBe('Simple text stays intact');
    expect(res.pages).toBe(1);
    expect(res.truncated).toBe(false);
    expect(res.reason).toBe('');
  });

  test('S1: маркеры моста и константы ретрая/лимита зафиксированы в source', () => {
    const src = fs.readFileSync(CONTENT_PATH, 'utf8');
    expect(src).toContain(START_MARK);
    expect(src).toContain(END_MARK);
    const bridge = readBridgeSource();
    expect(bridge).toContain('var AI_CM_PDF_PORT_RETRY = 1;');
    expect(bridge).toContain('var AI_CM_PDF_LOCAL_MAX_BYTES = 5 * 1024 * 1024;');
    expect(bridge).toContain('var AI_CM_PDF_LOCAL_TIMEOUT_MS = 12000;');
    expect(bridge).toContain('function aiCmPdfIsFirefox()');
    expect(bridge).toContain('function aiCmPdfAfterPort(id, reason, retryable)');
    expect(bridge).toContain('function aiCmPdfAfterLocal(id, res)');
    expect(bridge).toContain("reason: 'pdf-aborted'");
    // Резерв читает байты из pdf-bytes.js, а не из брокера.
    const bytes = fs.readFileSync(BYTES_PATH, 'utf8');
    expect(bytes).toContain('function parseLocal(buf, opts)');
    expect(bytes).toContain("emit('ai-cm-pdf-local-result'");
    expect(bytes).toContain("emit('ai-cm-pdf-local-ready'");
    expect(bytes).toContain('parseLocal: function (buf, opts)');
    // v2.8: в Firefox разбор идёт в своём realm, без границы Xray.
    expect(bytes).toContain('function isFirefoxRealm()');
    expect(bytes).toContain('function runLocalOnly(buf, opts)');
    expect(bytes).toContain('if (isFirefoxRealm()) return runLocalOnly(u8, o);');
  });

  // Фикс A (Xray). Байты из page-realm приходят в песочницу обёрнутыми: у
  // Xray-объекта `buf instanceof ArrayBuffer` ложно, поэтому прежний toBytes
  // отбрасывал доставленный массив как «не байты» → pdf-invalid.
  //
  // v2.8 (Firefox без моста). В Firefox любой поход через границу realm
  // (transfer ArrayBuffer в локальный разбор, base64-чанки в Port) падает с
  // «Permission denied to access property "constructor"», поэтому pdf-bytes.js
  // разбирает PDF в СВОЁМ realm и чанки никуда не отправляет. Проверяем обе
  // половины: чужой ArrayBuffer доходит до парсера, а граница не пересекается.
  test('D1 (Xray): ArrayBuffer чужого realm не теряется, Firefox не шлёт чанки', async () => {
    const page = createPage({ userAgent: FIREFOX_UA });
    const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (Xray bytes) Tj ET' });
    // Буфер из другого realm: ровно та ситуация, в которой ломается instanceof.
    const foreign = vm.runInNewContext('new Uint8Array(' + pdf.length + ')');
    for (let i = 0; i < pdf.length; i++) foreign[i] = pdf[i];

    const crossRealm = page.getGlobal(
      '(function (b) { return (typeof ArrayBuffer !== "undefined") && (b instanceof ArrayBuffer); })'
    );
    expect(crossRealm(foreign.buffer)).toBe(false);

    // Прямой локальный разбор: чужой буфер принимается как байты.
    const direct = await page.getGlobal('window').AiCmPdf.parseLocal(foreign.buffer, { maxChars: 200000 });
    expect(direct.ok).toBe(true);
    expect(direct.text).toBe('Xray bytes');

    const res = await page.getGlobal('window').AiCmPdf.fromBytes(foreign.buffer, { maxChars: 200000 });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('Xray bytes');
    expect(page.errors).toEqual([]);
    // Мост не задействован: ни чанков, ни transfer — Xray-исключения невозможны.
    expect(byteChunks(page).length).toBe(0);
    expect(page.transfers.length).toBe(0);
  });

  test('D1b (Chrome): чанк в изолированный мир уходит своей копией байтов', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (Chunk copy) Tj ET' });
    const foreign = vm.runInNewContext('new Uint8Array(' + pdf.length + ')');
    for (let i = 0; i < pdf.length; i++) foreign[i] = pdf[i];

    const res = await page.getGlobal('window').AiCmPdf.fromBytes(foreign.buffer, { maxChars: 200000, timeoutMs: 60 });
    expect(res.ok).toBe(false);
    expect(['pdf-aborted', 'pdf-timeout']).toContain(res.reason);

    const chunks = byteChunks(page);
    expect(chunks.length).toBe(1);
    // Своя копия, а не чужой буфер: иначе Firefox бросает constructor error.
    expect(chunks[0].msg.bytes).not.toBe(foreign.buffer);
    expect(Object.prototype.toString.call(chunks[0].msg.bytes)).toBe('[object ArrayBuffer]');
    expect(chunks[0].transfer[0]).toBe(chunks[0].msg.bytes);
    expect(Buffer.from(new Uint8Array(chunks[0].msg.bytes)).equals(pdf)).toBe(true);
  });

  // Фикс B. `dl`-ссылка переподписывается в каждом ответе batchexecute, поэтому
  // тот же файл получал новый ключ идентичности и эмитился повторно — текст
  // вложений размножался. Ключ теперь name|size, `claimed` сбрасывается при
  // смене подписи пула, а без хронологического предшественника дельта считается
  // против предыдущего ЗАРЕГИСТРИРОВАННОГО хода.
  test('D2 (взрыв): переподписанная dl-ссылка не плодит файл и текст', () => {
    const P = require('../helpers/load-esm.js').loadEsmModule('utils/gemini-batchexecute-parser.ts');
    const conv = TEST_CHAT;
    const dlA = 'https://contribution.usercontent.google.com/download?c=report-A';
    const dlB = 'https://contribution.usercontent.google.com/download?c=report-B';

    // Фикс C: холодный старт тестового чата снимает латчи автоэкспорта, иначе
    // повторный прогон не эмитит базу и дедупликацию текста не измерить.
    const latches = {
      aiCmAutoExportFiredOnce: { ['gemini|' + conv]: 1, 'gemini|c_other': 1 },
      preTrimExportFired: { [conv]: true, c_other: true }
    };
    expect(coldStartResetAutoExportLatches(conv, latches)).toBe(true);
    expect(latches.aiCmAutoExportFiredOnce['gemini|' + conv]).toBeUndefined();
    expect(latches.preTrimExportFired[conv]).toBeUndefined();
    // Чужой чат холодный старт тестового не сбрасывает.
    expect(coldStartResetAutoExportLatches('c_other', latches)).toBe(false);
    expect(latches.aiCmAutoExportFiredOnce['gemini|c_other']).toBe(1);

    P.__resetFileOwners(conv);
    const t1 = turnWithFileNodes([docNode('report.pdf', dlA, 0, 0)], 100);
    const t2 = turnWithFileNodes([docNode('report.pdf', dlB, 0, 1)], 200);

    P.registerTurnFileOwner(t1, conv, 'r_t1', 100, 0);
    const out1 = P.collectTurnFilesForOwner(t1, conv, 'r_t1', 100, 0);
    expect(out1.map(function (r) { return r.name; })).toEqual(['report.pdf']);
    // Идентичность не зависит от переподписываемых ссылок (Фикс B1).
    const key = P.fileRefIdentityKey(out1[0]);
    expect(key).toBe('report.pdf|0');
    expect(P.fileRefIdentityKey({ name: 'report.pdf', size: 0, dl: 'other-dl', urls: ['u2'], img: 'img2' })).toBe(key);

    P.registerTurnFileOwner(t2, conv, 'r_t2', 200, 1);
    const out2 = P.collectTurnFilesForOwner(t2, conv, 'r_t2', 200, 1);
    expect(out2).toEqual([]);
    expect(fileSections(out1.concat(out2))).toBe('\n\n[FILE: report.pdf]');
    expect(countOf(fileSections(out1.concat(out2)), '[FILE: report.pdf]')).toBe(1);

    // Повторный разбор того же хода с новым файлом: подпись пула меняется,
    // прежние закрепления снимаются, но старый файл не повторяется.
    const t2b = turnWithFileNodes([
      docNode('report.pdf', dlA, 0, 2),
      docNode('contract.pdf', dlB, 0, 3)
    ], 200);
    P.registerTurnFileOwner(t2b, conv, 'r_t2', 200, 1);
    const out2b = P.collectTurnFilesForOwner(t2b, conv, 'r_t2', 200, 1);
    expect(out2b.map(function (r) { return r.name; })).toEqual(['contract.pdf']);
    const all = fileSections(out1.concat(out2).concat(out2b));
    expect(countOf(all, '[FILE: report.pdf]')).toBe(1);
    expect(countOf(all, '[FILE: contract.pdf]')).toBe(1);
  });

  // R1 (байты). Chrome-путь не изменился: те же байты уходят ArrayBuffer'ом с
  // transfer, копия не портит содержимое и не роняет страницу.
  test('R1: Chrome-путь байтов прежний', async () => {
    const page = createPage({ userAgent: CHROME_UA });
    const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (Chrome bytes) Tj ET' });
    const bytes = page.toBytes(Array.from(pdf));
    // Порт в этом тесте молчит: мост исчерпывает ретрай и закрывает запрос —
    // точный reason не важен, важен сам байтовый путь до порта.
    const res = await page.getGlobal('window').AiCmPdf.fromBytes(bytes, { timeoutMs: 60 });
    expect(res.ok).toBe(false);
    expect(['pdf-aborted', 'pdf-timeout']).toContain(res.reason);
    expect(page.errors).toEqual([]);

    const chunks = byteChunks(page);
    expect(chunks.length).toBe(1);
    expect(Object.prototype.toString.call(chunks[0].msg.bytes)).toBe('[object ArrayBuffer]');
    expect(chunks[0].transfer[0]).toBe(chunks[0].msg.bytes);
    expect(Buffer.from(new Uint8Array(chunks[0].msg.bytes)).equals(pdf)).toBe(true);
    // Chrome пошёл через порт, а не через локальный разбор страницы.
    expect(page.connectCalls.length).toBeGreaterThan(0);
    expect(localRequests(page)).toHaveLength(0);
  });
});
