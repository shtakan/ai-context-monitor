'use strict';

// Фикс B: регистрация MAIN-хелпера AiCmPdf (core/pdf-bytes.js) обязана идти
// ПЕРВОЙ и в собственном try, а после свежей регистрации — самопроверка
// hello → ready через chrome.scripting.executeScript(world:'MAIN').
// Тест режет helpers из core/background.ts и исполняет их с фейковым chrome:
// так проверяется и порядок, и реальное поведение, без загрузки всего SW.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const BG_SRC = fs.readFileSync(path.join(ROOT, 'core', 'background.ts'), 'utf8');

const START = BG_SRC.indexOf('async function registerSafe');
const END = BG_SRC.indexOf('async function ensureInterceptor');
const HELPERS_SRC = BG_SRC.slice(START, END);

function makeHelpers(chrome) {
  const warns = [];
  const fakeConsole = {
    log: function () {},
    warn: function () { warns.push(Array.prototype.slice.call(arguments)); }
  };
  const factory = new Function(
    'chrome',
    'console',
    HELPERS_SRC + '\nreturn { ensurePdfHelper: ensurePdfHelper, selfCheckPdfHelper: selfCheckPdfHelper };'
  );
  return { api: factory(chrome, fakeConsole), warns };
}

function fakeChrome(opts) {
  opts = opts || {};
  const calls = { register: [], unregister: [], exec: [], query: [] };
  return {
    calls,
    runtime: {},
    scripting: {
      registerContentScripts: async function (list) { calls.register.push(list); },
      unregisterContentScripts: async function (arg) { calls.unregister.push(arg); },
      executeScript: async function (cfg) {
        calls.exec.push(cfg);
        return opts.execResult || [{ result: { ok: true, reason: '' } }];
      }
    },
    tabs: {
      query: async function (q) {
        calls.query.push(q);
        return opts.tabs || [];
      }
    }
  };
}

function runInjected(fn, win) {
  const sandbox = {
    window: win,
    CustomEvent: function TestCustomEvent(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    JSON: JSON,
    Promise: Promise,
    String: String
  };
  return vm.runInNewContext('(' + fn.toString() + ')()', sandbox);
}

function fakeWindow(hasHelper) {
  const listeners = {};
  return {
    AiCmPdf: hasHelper ? { fromUrl: function () {} } : undefined,
    addEventListener: function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent: function (ev) {
      // role of core/content.ts: ai-cm-pdf-hello → ai-cm-pdf-ready
      if (ev && ev.type === 'ai-cm-pdf-hello') {
        const ready = new ev.constructor('ai-cm-pdf-ready', { detail: '{"enabled":true}' });
        (listeners['ai-cm-pdf-ready'] || []).slice().forEach(function (fn) { fn(ready); });
      }
      return true;
    }
  };
}

describe('fix B: PDF-хелпер регистрируется первым и проверяется', () => {
  test('ensurePdfHelper вызывается до перехватчика ChatGPT и в отдельном try', () => {
    const body = BG_SRC.slice(
      BG_SRC.indexOf('async function ensureInterceptor'),
      BG_SRC.indexOf('chrome.runtime.onInstalled.addListener')
    );
    const call = body.indexOf('await ensurePdfHelper(ids)');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(body.indexOf("'ai-cm-page-intercept'"));
    expect(BG_SRC).toContain('try {\n      await ensurePdfHelper(ids);\n    } catch (ePdf) {');
  });

  test('регистрация: свой id, js[] только pdf-bytes.js, MAIN, четыре сайта', async () => {
    const chrome = fakeChrome();
    const { api, warns } = makeHelpers(chrome);
    await api.ensurePdfHelper([]);

    expect(chrome.calls.register).toHaveLength(1);
    const cfg = chrome.calls.register[0][0];
    expect(cfg).toMatchObject({
      id: 'ai-cm-pdf-bytes-v1',
      js: ['core/pdf-bytes.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false
    });
    expect(cfg.matches).toEqual([
      'https://gemini.google.com/*',
      'https://aistudio.google.com/*',
      'https://chat.qwen.ai/*',
      'https://chat.deepseek.com/*'
    ]);
    // Нет открытой вкладки — проверять нечего, это не ошибка.
    expect(chrome.calls.exec).toHaveLength(0);
    expect(warns).toEqual([]);
  });

  test('уже зарегистрированный id повторно не регистрируется', async () => {
    const chrome = fakeChrome();
    const { api } = makeHelpers(chrome);
    await api.ensurePdfHelper(['ai-cm-pdf-bytes-v1']);
    expect(chrome.calls.register).toHaveLength(0);
    expect(chrome.calls.exec).toHaveLength(0);
  });

  test('самопроверка: hello/ready в MAIN, при провале — console.warn с причиной', async () => {
    const chrome = fakeChrome({
      tabs: [{ id: 7, url: 'https://gemini.google.com/app' }],
      execResult: [{ result: { ok: false, reason: 'helper-missing' } }]
    });
    const { api, warns } = makeHelpers(chrome);
    await api.ensurePdfHelper([]);

    expect(chrome.calls.exec).toHaveLength(1);
    const cfg = chrome.calls.exec[0];
    expect(cfg.world).toBe('MAIN');
    expect(cfg.target).toEqual({ tabId: 7 });
    expect(cfg.func.toString()).toContain('ai-cm-pdf-hello');
    expect(cfg.func.toString()).toContain('ai-cm-pdf-ready');
    expect(cfg.func.toString()).toContain('AiCmPdf');
    expect(cfg.func.toString()).toContain('fromUrl');
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0])).toContain('helper-missing');
    expect(String(warns[0][0])).toContain('PDF-самопроверка');
  });

  test('инжектируемая функция: нет хелпера — helper-missing без ожидания', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7 }] });
    const { api } = makeHelpers(chrome);
    await api.ensurePdfHelper([]);
    const res = await runInjected(chrome.calls.exec[0].func, fakeWindow(false));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('helper-missing');
  });

  test('инжектируемая функция: хелпер есть — hello получает ready за <1.5 с', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7 }] });
    const { api } = makeHelpers(chrome);
    await api.ensurePdfHelper([]);
    const res = await runInjected(chrome.calls.exec[0].func, fakeWindow(true));
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('');
  });
});
