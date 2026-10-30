/**
 * v2.0.34: стенд для проверки кнопок экспорта в попапе (options/options.js).
 *
 * Кнопки MD/JSON/PDF/TXT должны быть активны, когда сетевой снимок уже есть
 * (aiCmState.netBaseMsgs > 0), даже если aiCmHistory ещё не записан и
 * extractMessages() у Claude/Perplexity по дизайну возвращает [].
 *
 * Стенд поднимает реальный options/options.js в jsdom с минимальным chrome-mock.
 */

'use strict';

const DEFAULT_HOST = 'claude.ai';
const DEFAULT_TAB_URL = 'https://claude.ai/chat/test-conv';

function defaultState(host, site) {
  return {
    host: host,
    site: site || 'claude',
    model: 'claude-sonnet-4-6',
    tokens: 1200,
    limit: 200000,
    percent: 0.6,
    updatedAt: Date.now(),
    stale: false,
    netBaseMsgs: 168,
    sourceKind: 'network',
    sourceLabel: 'сеть'
  };
}

function setupDom() {
  const ids = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent',
    'stat-source', 'model-select', 'custom-limit', 'show-widget', 'api-key',
    'toggle-api-key', 'exact-count', 'exact-count-warning', 'debugLogs',
    'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag',
    'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt'
  ];
  ids.forEach(function (id) {
    const el = document.createElement('div');
    el.id = id;
    if (id.indexOf('export-') === 0 && id !== 'export-hint' && id !== 'export-diag') {
      el.disabled = true;
    }
    if (id === 'debugLogs') { el.type = 'checkbox'; }
    document.body.appendChild(el);
  });
}

/**
 * @param {{state?: object|null, history?: object|null, snapshot?: object|null,
 *          host?: string, tabUrl?: string}} opts
 *        snapshot — ответ content-скрипта на aiCmExportCurrent (для клика по кнопке).
 */
function setupChrome(opts) {
  const options = opts || {};
  const host = options.host || DEFAULT_HOST;
  const tabUrl = options.tabUrl || DEFAULT_TAB_URL;
  const state = options.state === undefined ? defaultState(host, options.site) : options.state;
  const history = options.history || null;
  const snapshot = options.snapshot || null;

  function valueFor(key) {
    if (key === 'aiCmHistory' || key === 'aiCmHistory:' + host) return history;
    if (key === 'aiCmState' || key === 'aiCmState:' + host) return state;
    return undefined;
  }

  global.chrome = {
    runtime: {
      getManifest: function () { return { version: '2.0.33' }; },
      getURL: function (p) { return p || 'page.html'; },
      lastError: null,
      onMessage: { addListener: function () {} }
    },
    storage: {
      sync: {
        get: function (keys, cb) { cb({}); },
        set: function () {}
      },
      local: {
        get: function (keys, cb) {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach(function (k) {
            const v = valueFor(k);
            if (v !== undefined) out[k] = v;
          });
          cb(out);
        },
        set: function () {}
      },
      onChanged: { addListener: function () {} }
    },
    tabs: {
      query: function (q, cb) { cb([{ id: 7, url: tabUrl }]); },
      create: function () {},
      sendMessage: function (tabId, msg, cb) {
        if (typeof cb !== 'function') return;
        if (msg && msg.type === 'aiCmExportCurrent' && snapshot) {
          cb({ data: snapshot });
          return;
        }
        cb(undefined);
      }
    }
  };
}

function loadOptions() {
  const resolved = require.resolve('../../options/options.js');
  delete require.cache[resolved];
  // Jest кэширует модули отдельно от require.cache: без resetModules второй попап
  // не переисполнил бы options.js и слушал бы DOMContentLoaded от прежнего DOM.
  jest.resetModules();
  require(resolved);
  // Как при открытии попапа: статистика + состояние экспорта.
  document.dispatchEvent(new Event('DOMContentLoaded'));
}

/**
 * Поднимает попап и возвращает кнопки экспорта.
 */
function openOptionsExportGate(opts) {
  document.body.innerHTML = '';
  if (!window.AiCmExportBuilders) {
    window.AiCmExportBuilders = require('../../utils/export-text-builders.js');
  }
  if (!window.buildReferenceText) {
    window.buildReferenceText = require('../../utils/buildReferenceText.js');
  }
  setupDom();
  setupChrome(opts);
  loadOptions();
  return {
    md: document.getElementById('export-md'),
    json: document.getElementById('export-json'),
    pdf: document.getElementById('export-pdf'),
    txt: document.getElementById('export-txt'),
    hint: document.getElementById('export-hint')
  };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_TAB_URL,
  defaultState,
  setupDom,
  setupChrome,
  loadOptions,
  openOptionsExportGate
};
