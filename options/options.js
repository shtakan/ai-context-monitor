console.log('AI Context Monitor: Настройки загружены');

const siteEl = document.getElementById('stat-site');
const modelEl = document.getElementById('stat-model');
const tokensEl = document.getElementById('stat-tokens');
const limitEl = document.getElementById('stat-limit');
const percentEl = document.getElementById('stat-percent');
const modelSelect = document.getElementById('model-select');
const customLimit = document.getElementById('custom-limit');
const showWidget = document.getElementById('show-widget');
const apiKeyInput = document.getElementById('api-key');
const toggleApiKeyBtn = document.getElementById('toggle-api-key');
const exactCountCheckbox = document.getElementById('exact-count');
const versionEl = document.querySelector('.version');
const exportMdBtn = document.getElementById('export-md');
const exportJsonBtn = document.getElementById('export-json');
const exportHintEl = document.getElementById('export-hint');
const staleWarningEl = document.getElementById('stale-warning');
const exportDiagBtn = document.getElementById('export-diag');

// Цветовые пороги — те же, что в content.js (zoneColor: <50 зелёный, <80 жёлтый, красный)
function percentColor(p) { if (p < 50) return '#22c55e'; if (p < 80) return '#eab308'; return '#ef4444'; }

// Версия из manifest (вместо захардкоженной)
try {
  var manifest = chrome.runtime.getManifest();
  if (versionEl && manifest.version) versionEl.textContent = 'v' + manifest.version;
} catch (e) {}

// Сайт-в-human-readable
var siteLabels = {
  'chatgpt': 'ChatGPT',
  'gemini': 'Gemini',
  'aistudio': 'Google AI Studio',
  'google_search': 'Google Search AI',
  'deepseek': 'DeepSeek',
  'claude': 'Claude',
  'perplexity': 'Perplexity'
};

// Загружаем настройки
chrome.storage.sync.get(['selectedModel', 'customLimit', 'showWidget'], function (data) {
  if (data.selectedModel) modelSelect.value = data.selectedModel;
  if (data.customLimit) customLimit.value = data.customLimit;
  if (data.showWidget !== undefined) showWidget.checked = data.showWidget;
});

// Загружаем BYOK настройки из chrome.storage.local
chrome.storage.local.get(['ai_cm_gemini_api_key', 'ai_cm_exact_token_count'], function (data) {
  if (data.ai_cm_gemini_api_key) apiKeyInput.value = data.ai_cm_gemini_api_key;
  if (data.ai_cm_exact_token_count !== undefined) exactCountCheckbox.checked = data.ai_cm_exact_token_count;
});

modelSelect.addEventListener('change', function () {
  chrome.storage.sync.set({ selectedModel: modelSelect.value });
});

customLimit.addEventListener('input', function () {
  var value = customLimit.value ? parseInt(customLimit.value) : null;
  chrome.storage.sync.set({ customLimit: value });
});

customLimit.addEventListener('change', function () {
  if (!customLimit.value) {
    customLimit.placeholder = 'Авто';
    chrome.storage.sync.set({ customLimit: null });
  }
});

showWidget.addEventListener('change', function () {
  chrome.storage.sync.set({ showWidget: showWidget.checked });
});

// BYOK: сохранение API-ключа (chrome.storage.local)
apiKeyInput.addEventListener('input', function () {
  chrome.storage.local.set({ ai_cm_gemini_api_key: apiKeyInput.value });
});

// BYOK: показать/скрыть ключ
toggleApiKeyBtn.addEventListener('click', function () {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    toggleApiKeyBtn.textContent = '\uD83D\uDE48';
  } else {
    apiKeyInput.type = 'password';
    toggleApiKeyBtn.textContent = '\uD83D\uDC41';
  }
});

// BYOK: сохранение флага точного подсчёта
exactCountCheckbox.addEventListener('change', function () {
  chrome.storage.local.set({ ai_cm_exact_token_count: exactCountCheckbox.checked });
});

document.getElementById('reset-limit') && document.getElementById('reset-limit').addEventListener('click', function () {
  customLimit.value = '';
  customLimit.placeholder = 'Авто';
  chrome.storage.sync.set({ customLimit: null });
});

function updateStatsFromState(state) {
  siteEl.textContent = siteLabels[state.site] || state.site || '—';
  modelEl.textContent = state.model || '—';
  tokensEl.textContent = (typeof state.tokens === 'number') ? state.tokens.toLocaleString() : '—';
  limitEl.textContent = (typeof state.limit === 'number') ? state.limit.toLocaleString() : '—';
  var p = state.percent || 0;
  percentEl.textContent = p + '%';
  percentEl.style.color = percentColor(p);
  updateStaleWarning(state);
}

function updateStaleWarning(state) {
  if (!staleWarningEl) return;
  if (state && state.stale === true) {
    var siteLabel = siteLabels[state.site] || state.site || 'сайтом';
    staleWarningEl.textContent = 'Интеграция с ' + siteLabel + ' могла устареть: сайт не отдаёт данные диалога. Проверьте обновление расширения.';
    staleWarningEl.style.display = 'block';
  } else {
    staleWarningEl.style.display = 'none';
    staleWarningEl.textContent = '';
  }
}

function showNoData(message) {
  siteEl.textContent = message || 'Нет данных';
  modelEl.textContent = '—';
  tokensEl.textContent = '—';
  limitEl.textContent = '—';
  percentEl.textContent = '—';
  percentEl.style.color = '#8888aa';
}

// Загружаем статистику при открытии — через chrome.storage.local (aiCmState)
function loadStats() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        showNoData('Нет активной вкладки');
        return;
      }

      // chrome:// и chrome-extension:// — сразу нет
      if (tab.url.indexOf('chrome://') === 0 || tab.url.indexOf('chrome-extension://') === 0) {
        showNoData('Откройте поддерживаемый сайт');
        return;
      }

      var tabHost = '';
      try { tabHost = new URL(tab.url).hostname; } catch (e) {}

      chrome.storage.local.get(['aiCmState'], function (data) {
        var state = data.aiCmState;
        if (state && state.host === tabHost) {
          updateStatsFromState(state);
        } else {
          showNoData('Откройте поддерживаемый сайт');
        }
      });
    });
  } catch (e) {
    showNoData('Обновите страницу');
  }
}

// Live-обновление при изменении aiCmState
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local' || !changes.aiCmState) return;
    var state = changes.aiCmState.newValue;
    if (!state) return;
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      var tabHost = '';
      try { if (tab && tab.url) tabHost = new URL(tab.url).hostname; } catch (e) {}
      if (state.host === tabHost) {
        updateStatsFromState(state);
      }
    });
  });
} catch (e) {}

// ========== ЭКСПОРТ ИСТОРИИ ==========
var cachedHistory = null;
var currentTabHost = '';

function getActiveTabHost(cb) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      var host = '';
      if (tab && tab.url) {
        try { host = new URL(tab.url).hostname; } catch (e) { host = ''; }
      }
      currentTabHost = host;
      cb(host);
    });
  } catch (e) {
    cb('');
  }
}

function updateExportButtons() {
  if (!exportMdBtn || !exportJsonBtn) return;
  var enabled = !!(cachedHistory && cachedHistory.host === currentTabHost);
  exportMdBtn.disabled = !enabled;
  exportJsonBtn.disabled = !enabled;
  if (exportHintEl) {
    exportHintEl.textContent = enabled ? 'Готово к экспорту' : 'Откройте поддерживаемый сайт';
  }
}

function refreshExportState() {
  getActiveTabHost(function () {
    chrome.storage.local.get(['aiCmHistory'], function (data) {
      cachedHistory = data.aiCmHistory || null;
      updateExportButtons();
    });
  });
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function buildFileName(ext) {
  var d = new Date();
  var stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    '-' + pad2(d.getHours()) + '-' + pad2(d.getMinutes());
  var site = (cachedHistory && cachedHistory.site) || 'chat';
  var model = (cachedHistory && cachedHistory.model) || 'model';
  var safeSite = String(site).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'chat';
  var safeModel = String(model).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  return 'ai-context-monitor-' + safeSite + '-' + safeModel + '-' + stamp + '.' + ext;
}

function downloadBlob(content, fileName, mimeType) {
  try {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  } catch (e) {
    console.warn('[export] не удалось скачать файл:', e);
  }
}

function getPlatform() {
  var site = cachedHistory && cachedHistory.site;
  return (siteLabels[site] || site || 'AI Chat');
}

function buildJsonText() {
  var exportedAt = new Date().toISOString();
  return JSON.stringify({
    platform: getPlatform(),
    model: (cachedHistory && cachedHistory.model) || '',
    exportedAt: exportedAt,
    tokens: (cachedHistory && typeof cachedHistory.tokens === 'number') ? cachedHistory.tokens : 0,
    limit: (cachedHistory && typeof cachedHistory.limit === 'number') ? cachedHistory.limit : 0,
    percent: (cachedHistory && typeof cachedHistory.percent === 'number') ? cachedHistory.percent : 0,
    messages: (cachedHistory && Array.isArray(cachedHistory.messages)) ? cachedHistory.messages : []
  }, null, 2);
}

function buildMdText() {
  var h = cachedHistory || {};
  var lines = [];
  lines.push('# AI Context Monitor — экспорт истории');
  lines.push('');
  lines.push('Платформа: ' + getPlatform());
  lines.push('Модель: ' + (h.model || '—'));
  lines.push('Дата экспорта: ' + new Date().toISOString());
  var tokens = (typeof h.tokens === 'number') ? h.tokens : 0;
  var limit = (typeof h.limit === 'number') ? h.limit : 0;
  var percent = (typeof h.percent === 'number') ? h.percent : 0;
  lines.push('Токены: ' + tokens + ' / ' + limit + ' (' + percent + '%)');
  lines.push('');

  var messages = Array.isArray(h.messages) ? h.messages : [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i] || {};
    var title = (msg.role === 'user') ? '## Пользователь' : '## Ассистент';
    lines.push(title);
    lines.push('');
    lines.push(msg.text || '');
    lines.push('');
  }
  return lines.join('\n');
}

exportMdBtn && exportMdBtn.addEventListener('click', function () {
  if (exportMdBtn.disabled) return;
  downloadBlob(buildMdText(), buildFileName('md'), 'text/markdown');
});

exportJsonBtn && exportJsonBtn.addEventListener('click', function () {
  if (exportJsonBtn.disabled) return;
  downloadBlob(buildJsonText(), buildFileName('json'), 'application/json');
});

// ========== ЭКСПОРТ ДИАГНОСТИКИ ==========
function getActiveTab(cb) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      cb(tabs && tabs[0] ? tabs[0] : null);
    });
  } catch (e) {
    cb(null);
  }
}

function buildDiagnosticsFileName() {
  return 'ai-context-monitor-diagnostics-' + Date.now() + '.json';
}

exportDiagBtn && exportDiagBtn.addEventListener('click', function () {
  getActiveTab(function (tab) {
    if (!tab || !tab.id) {
      downloadBlob(JSON.stringify({ error: 'нет активной вкладки', at: new Date().toISOString() }, null, 2), buildDiagnosticsFileName(), 'application/json');
      return;
    }
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'aiCmDiag' }, function (response) {
        var payload;
        if (chrome.runtime.lastError) {
          payload = {
            error: 'content script не ответил: ' + chrome.runtime.lastError.message,
            at: new Date().toISOString()
          };
        } else {
          payload = (response && response.diag) ? response.diag : { error: 'пустой ответ', response: response || null };
        }
        downloadBlob(JSON.stringify(payload, null, 2), buildDiagnosticsFileName(), 'application/json');
      });
    } catch (e) {
      downloadBlob(JSON.stringify({ error: 'sendMessage error: ' + e.message, at: new Date().toISOString() }, null, 2), buildDiagnosticsFileName(), 'application/json');
    }
  });
});

// Live-обновление доступности кнопок при изменении aiCmHistory
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local' || !changes.aiCmHistory) return;
    cachedHistory = changes.aiCmHistory.newValue || null;
    // host активной вкладки мог не успеть обновиться — перезапрашиваем
    getActiveTabHost(function () {
      updateExportButtons();
    });
  });
} catch (e) {}

// Загружаем статистику и состояние экспорта при открытии
document.addEventListener('DOMContentLoaded', function () {
  loadStats();
  refreshExportState();
});
