'use strict';

// Брокер SW (core/pdf-parser.js) — единственное место, где выбирается хост
// разбора: offscreen-документ Chrome или event page Firefox. Тесты гоняют обе
// ветки через поддельные Port'ы: контракт сообщений важнее самого pdf.js.

const path = require('path');

const BROKER_PATH = path.join(__dirname, '..', '..', 'core', 'pdf-parser.js');

function fakePort(name) {
  const handlers = {};
  return {
    name,
    messages: [],
    disconnected: false,
    postMessage(msg) { this.messages.push(msg); },
    disconnect() { this.disconnected = true; },
    onMessage: { addListener(fn) { handlers.message = fn; } },
    onDisconnect: { addListener(fn) { handlers.disconnect = fn; } },
    emit(msg) { if (handlers.message) handlers.message(msg); },
    dropByPeer() { if (handlers.disconnect) handlers.disconnect(); }
  };
}

function b64(s) {
  return Buffer.from(s, 'binary').toString('base64');
}

async function flush() {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

function loadBroker() {
  jest.resetModules();
  return require(BROKER_PATH);
}

describe('pdf-parser: брокер выбора хоста', () => {
  afterEach(() => {
    if (window.AiCmPdfBroker && typeof window.AiCmPdfBroker.reset === 'function') {
      window.AiCmPdfBroker.reset();
    }
    delete window.AiCmPdfHost;
    delete global.chrome;
  });

  test('Firefox: байты из чанков уходят в AiCmPdfHost.parsePdf, ответ — в порт вкладки', async () => {
    const parsePdf = jest.fn(async () => ({ ok: true, text: 'Привет', pages: 1, truncated: false, reason: '' }));
    window.AiCmPdfHost = { parsePdf };

    const broker = loadBroker();
    const port = fakePort('ai-cm-pdf:p1');
    broker.onConnect(port);

    port.emit({ t: 'begin', id: 'p1', total: 1, maxChars: 1000 });
    port.emit({ t: 'chunk', id: 'p1', seq: 0, b64: b64('abc') });
    port.emit({ t: 'end', id: 'p1' });
    await flush();

    expect(parsePdf).toHaveBeenCalledTimes(1);
    const [bytes, opts] = parsePdf.mock.calls[0];
    expect(Array.from(bytes)).toEqual([97, 98, 99]);
    expect(opts).toMatchObject({ maxChars: 1000, maxPages: 500 });

    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]).toMatchObject({ t: 'result', id: 'p1', ok: true, text: 'Привет', pages: 1, size: 3 });
    expect(port.disconnected).toBe(true);
  });

  test('Chrome: брокер поднимает offscreen и передаёт чанки в порт хоста', async () => {
    const created = [];
    global.chrome = {
      runtime: {
        getURL: (p) => 'chrome-extension://test/' + p,
        getContexts: async () => []
      },
      offscreen: {
        createDocument: async (opts) => { created.push(opts); },
        closeDocument: async () => {},
        hasDocument: async () => false
      }
    };

    const broker = loadBroker();
    const port = fakePort('ai-cm-pdf:pdf-1');
    broker.onConnect(port);

    port.emit({ t: 'begin', id: 'pdf-1', total: 1 });
    port.emit({ t: 'chunk', id: 'pdf-1', seq: 0, b64: b64('PDF') });
    port.emit({ t: 'end', id: 'pdf-1' });
    await flush();

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ url: 'parser/offscreen.html', reasons: ['WORKERS'] });

    const host = fakePort('ai-cm-pdf-host');
    broker.onConnect(host);
    await flush();

    expect(host.messages.map((m) => m.t)).toEqual(['begin', 'chunk', 'end']);
    expect(host.messages[0]).toMatchObject({ id: 'pdf-1', total: 1 });
    expect(host.messages[1]).toMatchObject({ id: 'pdf-1', seq: 0, b64: b64('PDF') });

    host.emit({ t: 'result', id: 'pdf-1', ok: true, text: 'Текст PDF', pages: 2, size: 3 });
    await flush();

    expect(port.messages[0]).toMatchObject({ t: 'result', id: 'pdf-1', ok: true, text: 'Текст PDF', pages: 2 });
    expect(port.disconnected).toBe(true);
  });

  test('без хоста разбора результат — pdf-unavailable', async () => {
    global.chrome = { runtime: { getURL: (p) => 'chrome-extension://test/' + p } };

    const broker = loadBroker();
    const port = fakePort('ai-cm-pdf:no-host');
    broker.onConnect(port);

    port.emit({ t: 'begin', id: 'no-host', total: 1 });
    port.emit({ t: 'chunk', id: 'no-host', seq: 0, b64: b64('x') });
    port.emit({ t: 'end', id: 'no-host' });
    await flush();

    expect(port.messages[0]).toMatchObject({ t: 'result', ok: false, reason: 'pdf-unavailable' });
  });

  test('больше 64 чанков — pdf-too-large без запуска хоста', async () => {
    const created = [];
    global.chrome = {
      runtime: { getURL: (p) => 'chrome-extension://test/' + p, getContexts: async () => [] },
      offscreen: {
        createDocument: async (opts) => { created.push(opts); },
        closeDocument: async () => {},
        hasDocument: async () => false
      }
    };

    const broker = loadBroker();
    const port = fakePort('ai-cm-pdf:many');
    broker.onConnect(port);
    port.emit({ t: 'begin', id: 'many', total: 65 });
    for (let i = 0; i < 65; i++) {
      port.emit({ t: 'chunk', id: 'many', seq: i, b64: b64('a') });
    }
    port.emit({ t: 'end', id: 'many' });
    await flush();

    expect(created).toHaveLength(0);
    expect(port.messages[0]).toMatchObject({ t: 'result', ok: false, reason: 'pdf-too-large' });
  });

  test('отмена вкладкой — pdf-aborted', async () => {
    window.AiCmPdfHost = { parsePdf: jest.fn(async () => ({ ok: true, text: 'x', pages: 1 })) };

    const broker = loadBroker();
    const port = fakePort('ai-cm-pdf:abort');
    broker.onConnect(port);
    port.emit({ t: 'begin', id: 'abort', total: 1 });
    port.emit({ t: 'cancel', id: 'abort' });
    await flush();

    expect(port.messages[0]).toMatchObject({ t: 'result', ok: false, reason: 'pdf-aborted' });
    expect(window.AiCmPdfHost.parsePdf).not.toHaveBeenCalled();
  });
});
