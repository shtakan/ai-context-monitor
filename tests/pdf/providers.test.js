'use strict';

// Провайдеры + pdf.js: проверяем именно стык. MAIN-хелпер (core/pdf-bytes.js)
// подменяется заглушкой window.AiCmPdf, поэтому тест ловит контракт вызова
// (URL, credentials, капы, таймаут) и то, что текст PDF доезжает до результата
// загрузки, а без хелпера остаётся прежняя заглушка.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextDecoder, TextEncoder } = require('util');
const { DecompressionStream } = require('stream/web');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PARSER_SRC = read('utils/gemini-batchexecute-parser.js');

const PDF_TEXT = 'PDF-текст';
const PDF_MAX = 10 * 1024 * 1024;

function makeSandbox() {
  const windowObj = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    fetch: null
  };
  const moduleObj = { exports: {} };
  const sandbox = {
    window: windowObj,
    self: windowObj,
    module: moduleObj,
    exports: moduleObj.exports,
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Date: Date,
    AbortController: AbortController,
    TextDecoder: TextDecoder,
    TextEncoder: TextEncoder,
    CustomEvent: class TestCustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    DecompressionStream: DecompressionStream,
    aiCmDiagWarn: jest.fn(),
    aiCmDiagLine: jest.fn(),
    aiCmBridgeDetail: () => null,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    document: { addEventListener() {}, removeEventListener() {} }
  };
  return { ctx: vm.createContext(sandbox), windowObj };
}

function loadProvider(rel, withParser) {
  const { ctx, windowObj } = makeSandbox();
  if (withParser) vm.runInContext(PARSER_SRC, ctx, { filename: 'utils/gemini-batchexecute-parser.js' });
  vm.runInContext(read(rel), ctx, { filename: rel });
  return windowObj;
}

function pdfStub() {
  return {
    fromUrl: jest.fn(async () => ({
      ok: true,
      text: PDF_TEXT,
      pages: 2,
      truncated: false,
      reason: '',
      size: 12345
    }))
  };
}

function pdfRes(spec) {
  spec = spec || {};
  const headers = spec.headers || {};
  return {
    ok: true,
    status: spec.status || 200,
    headers: { get: (n) => headers[String(n || '').toLowerCase()] || null },
    text: () => Promise.resolve(spec.body || ''),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    body: { cancel: jest.fn(() => Promise.resolve()) }
  };
}

describe('pdf.js в провайдерах: Gemini', () => {
  test('PDF ≤10 МиБ: Range-проба даёт размер, текст приходит из pdf.js', async () => {
    const windowObj = loadProvider('core/gemini-files.js', true);
    const Fn = windowObj.AiCmGeminiFiles;
    windowObj.AiCmPdf = pdfStub();
    const fetchMock = jest.fn(async () => pdfRes({
      status: 206,
      headers: { 'content-range': 'bytes 0-0/12345' }
    }));
    Fn.__bind({ emitSnapshot: jest.fn(), getConvId: () => 'chat-1', originalFetch: fetchMock, diagLine: jest.fn() });

    const res = await Fn.fetchFile({
      url: 'https://gemini.example/a.pdf',
      ref: { name: 'a.pdf', mime: 'application/pdf' }
    });

    expect(windowObj.AiCmPdf.fromUrl).toHaveBeenCalledTimes(1);
    const [url, opts] = windowObj.AiCmPdf.fromUrl.mock.calls[0];
    expect(url).toBe('https://gemini.example/a.pdf');
    expect(opts).toMatchObject({
      credentials: 'include',
      name: 'a.pdf',
      maxBytes: PDF_MAX,
      maxChars: 200000,
      timeoutMs: 15000
    });
    expect(res).toMatchObject({ ok: true, pdf: true, text: PDF_TEXT, size: 12345 });
    // Первый запрос — только Range-проба: тело PDF второй раз не качается.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-0' });
  });

  test('без MAIN-хелпера остаётся прежняя заглушка pdf-no-text', async () => {
    const windowObj = loadProvider('core/gemini-files.js', true);
    const Fn = windowObj.AiCmGeminiFiles;
    const fetchMock = jest.fn(async () => pdfRes({
      status: 206,
      headers: { 'content-range': 'bytes 0-0/777' }
    }));
    Fn.__bind({ emitSnapshot: jest.fn(), getConvId: () => 'chat-1', originalFetch: fetchMock, diagLine: jest.fn() });

    const res = await Fn.fetchFile({
      url: 'https://gemini.example/b.pdf',
      ref: { name: 'b.pdf', mime: 'application/pdf' }
    });

    expect(res).toMatchObject({ ok: false, pdf: true, size: 777, reason: 'pdf-no-text' });
  });
});

describe('pdf.js в провайдерах: Qwen', () => {
  test('PDF-вложение уходит в pdf.js вместо чтения тела как текста', async () => {
    const windowObj = loadProvider('core/qwen-files.js');
    const Fn = windowObj.AiCmQwenFiles;
    windowObj.AiCmPdf = pdfStub();
    const fetchMock = jest.fn();
    Fn.__bind({ originalFetch: fetchMock });

    const res = await Fn.fetchText({
      url: 'https://cdn.example/spec.pdf',
      name: 'spec.pdf',
      mime: 'application/pdf'
    });

    expect(res).toMatchObject({ ok: true, pdf: true, text: PDF_TEXT });
    const [, opts] = windowObj.AiCmPdf.fromUrl.mock.calls[0];
    expect(opts).toMatchObject({ credentials: 'omit', name: 'spec.pdf', maxBytes: PDF_MAX, timeoutMs: 15000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pdf.js в провайдерах: AI Studio', () => {
  test('Drive-PDF скачивается с Bearer-заголовком через pdf.js', async () => {
    const windowObj = loadProvider('core/aistudio-files.js');
    const Fn = windowObj.AiCmAistudioFiles;
    windowObj.AiCmPdf = pdfStub();

    const meta = { name: 'a.pdf', mime: 'application/pdf', size: 10 };
    const res = await Fn.fetchPdf({ fileId: 'f1' }, meta);

    expect(res).toMatchObject({ ok: true, pdf: true, text: PDF_TEXT, meta: meta });
    const [url, opts] = windowObj.AiCmPdf.fromUrl.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/drive/v3/files/f1?alt=media&supportsAllDrives=true');
    expect(opts).toMatchObject({ credentials: 'omit', name: 'a.pdf', maxBytes: PDF_MAX, maxChars: 200000 });
    expect(opts.headers).toMatchObject({ Authorization: expect.stringContaining('Bearer') });
  });
});

describe('pdf.js в провайдерах: DeepSeek', () => {
  test('fetchFileContent с PDF-ref идёт в pdf.js, а не в res.text()', async () => {
    const windowObj = loadProvider('core/deepseek-files.js');
    const Fn = windowObj.AiCmDeepseekFiles;
    windowObj.AiCmPdf = pdfStub();
    const fetchMock = jest.fn();
    Fn.__bind({ originalFetch: fetchMock, diagLine: jest.fn(), emitSnapshot: jest.fn() });

    const res = await Fn.fetchFileContent('file_123', 'signed/abc', {
      fileId: 'file_123',
      signedPath: 'signed/abc',
      name: 'a.pdf',
      mime: 'application/pdf',
      isPdf: true
    });

    expect(res).toMatchObject({ ok: true, pdf: true, text: PDF_TEXT });
    expect(windowObj.AiCmPdf.fromUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('без ref (старый двухаргументный вызов) поведение прежнее', async () => {
    const windowObj = loadProvider('core/deepseek-files.js');
    const Fn = windowObj.AiCmDeepseekFiles;
    windowObj.AiCmPdf = pdfStub();
    const fetchMock = jest.fn(async () => pdfRes({ body: '{"x":1}' }));
    Fn.__bind({ originalFetch: fetchMock, diagLine: jest.fn(), emitSnapshot: jest.fn() });

    const res = await Fn.fetchFileContent('file_9', '');
    expect(windowObj.AiCmPdf.fromUrl).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });
});
