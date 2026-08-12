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
  'claude': 'Claude'
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

// Загружаем статистику при открытии
document.addEventListener('DOMContentLoaded', loadStats);