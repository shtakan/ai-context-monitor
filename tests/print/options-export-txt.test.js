/**
 * Юнит-тесты txt-экспорта в попапе (options/options.js).
 * Проверки: кнопка #export-txt не disabled при наличии истории,
 * клик по кнопке строит plain-text ровно из тех же сообщений,
 * что использует MD-экспорт (cachedHistory.messages), и отдаёт его
 * в downloadBlob (mock URL.createObjectURL).
 */

const buildReferenceText = require('../../utils/buildReferenceText.js');

function setupDom() {
  const ids = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent',
    'model-select', 'custom-limit', 'show-widget', 'api-key', 'toggle-api-key',
    'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag',
    'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt'
  ];
  ids.forEach(function (id) {
    const el = document.createElement('div');
    el.id = id;
    if (id === 'export-md' || id === 'export-json' || id === 'export-pdf' || id === 'export-txt') {
      el.disabled = true;
    }
    if (id === 'debugLogs') { el.type = 'checkbox'; }
    document.body.appendChild(el);
  });
}

function setupChrome(history) {
  global.chrome = {
    runtime: {
      getManifest: function () { return { version: '1.6.0' }; },
      getURL: function () { return 'print.html'; },
      lastError: null
    },
    storage: {
      sync: {
        get: function (keys, cb) { cb({}); },
        set: function () {}
      },
      local: {
        get: function (keys, cb) {
          if (Array.isArray(keys) && keys.indexOf('aiCmHistory') !== -1) {
            cb({ aiCmHistory: history });
          } else if (Array.isArray(keys) && keys.indexOf('aiCmState') !== -1) {
            cb({ aiCmState: null });
          } else {
            cb({});
          }
        },
        set: function () {}
      },
      onChanged: { addListener: function () {} }
    },
    tabs: {
      query: function (q, cb) { cb([{ id: 1, url: 'https://gemini.google.com/' }]); },
      create: function () {},
      // v1.13.1: content-скрипт не отвечает → как в реальном Chrome приходит пустой ответ
      // (lastError/undefined) → options.js фолбэк на cachedHistory (host-level история).
      sendMessage: function (tabId, msg, cb) { if (typeof cb === 'function') cb(undefined); }
    }
  };
}

function loadOptions() {
  const resolved = require.resolve('../../options/options.js');
  delete require.cache[resolved];
  require(resolved);
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.buildReferenceText = buildReferenceText;
  window.AiCmExportBuilders = require('../../utils/export-text-builders.js');
  global.URL.createObjectURL = jest.fn(function () { return 'blob:mock'; });
  global.URL.revokeObjectURL = jest.fn();
});

describe('options.js — txt-экспорт (эталон) в попапе', () => {
  test('кнопка не disabled при истории; клик скачивает текст из тех же сообщений', async () => {
    const history = {
      host: 'gemini.google.com',
      site: 'gemini',
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'user', text: 'вопрос' },
        { role: 'assistant', text: 'ответ\nс новой строки' }
      ]
    };
    setupDom();
    setupChrome(history);
    loadOptions();

    // инициализация состояния экспорта (как при открытии попапа)
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const txtBtn = document.getElementById('export-txt');
    expect(txtBtn.disabled).toBe(false);
    expect(document.getElementById('export-md').disabled).toBe(false);

    txtBtn.click();

    expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = global.URL.createObjectURL.mock.calls[0][0];
    // jsdom не реализует Blob.prototype.text — читаем через FileReader
    const text = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(blob);
    });
    expect(text).toBe('вопрос\n\nответ\nс новой строки');
  });

  test('кнопка disabled, когда истории для активной вкладки нет', () => {
    setupDom();
    setupChrome(null);
    loadOptions();

    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(document.getElementById('export-txt').disabled).toBe(true);
    expect(document.getElementById('export-md').disabled).toBe(true);
  });
});