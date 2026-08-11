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

// Загружаем настройки
chrome.storage.sync.get(['selectedModel', 'customLimit', 'showWidget'], (data) => {
  if (data.selectedModel) modelSelect.value = data.selectedModel;
  if (data.customLimit) customLimit.value = data.customLimit;
  if (data.showWidget !== undefined) showWidget.checked = data.showWidget;
});

// Загружаем BYOK настройки из chrome.storage.local
chrome.storage.local.get(['ai_cm_gemini_api_key', 'ai_cm_exact_token_count'], (data) => {
  if (data.ai_cm_gemini_api_key) apiKeyInput.value = data.ai_cm_gemini_api_key;
  if (data.ai_cm_exact_token_count !== undefined) exactCountCheckbox.checked = data.ai_cm_exact_token_count;
});

modelSelect.addEventListener('change', () => {
  chrome.storage.sync.set({ selectedModel: modelSelect.value });
});

customLimit.addEventListener('input', () => {
  const value = customLimit.value ? parseInt(customLimit.value) : null;
  chrome.storage.sync.set({ customLimit: value });
});

customLimit.addEventListener('change', () => {
  if (!customLimit.value) {
    customLimit.placeholder = 'Авто';
    chrome.storage.sync.set({ customLimit: null });
  }
});

showWidget.addEventListener('change', () => {
  chrome.storage.sync.set({ showWidget: showWidget.checked });
});

// BYOK: сохранение API-ключа (chrome.storage.local)
apiKeyInput.addEventListener('input', () => {
  chrome.storage.local.set({ ai_cm_gemini_api_key: apiKeyInput.value });
});

// BYOK: показать/скрыть ключ
toggleApiKeyBtn.addEventListener('click', () => {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    toggleApiKeyBtn.textContent = '🙈';
  } else {
    apiKeyInput.type = 'password';
    toggleApiKeyBtn.textContent = '👁';
  }
});

// BYOK: сохранение флага точного подсчёта
exactCountCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ ai_cm_exact_token_count: exactCountCheckbox.checked });
});

document.getElementById('reset-limit')?.addEventListener('click', () => {
  customLimit.value = '';
  customLimit.placeholder = 'Авто';
  chrome.storage.sync.set({ customLimit: null });
});

// Функция загрузки статистики
async function loadStats() {
  console.log('loadStats: запрашиваю данные...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('loadStats: вкладка:', tab?.url, 'id:', tab?.id);
    
    if (!tab || !tab.url) {
      showNoData('Нет активной вкладки');
      return;
    }
    
    const url = tab.url;
    const isSupported = url.includes('chatgpt.com') || 
                        url.includes('gemini.google.com') || 
                        url.includes('chat.deepseek.com') ||
                        url.includes('aistudio.google.com') ||
                        url.includes('google.com');
    
    if (!isSupported) {
      showNoData('Откройте поддерживаемый сайт');
      return;
    }
    
    console.log('loadStats: отправляю GET_STATS');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATS' });
    console.log('loadStats: ответ:', response);
    
    if (response && response.data) {
      updateStats(response.data);
    } else {
      showNoData('Ожидание данных...');
    }
  } catch (error) {
    console.log('loadStats: данные временно недоступны:', error.message);
    showNoData('Обновите страницу');
  }
}

function updateStats(data) {
  console.log('updateStats:', data);
  siteEl.textContent = data.site || '—';
  modelEl.textContent = data.modelName || '—';
  tokensEl.textContent = data.tokenCount?.toLocaleString() || '—';
  limitEl.textContent = data.contextLimit?.toLocaleString() || '—';
  const percent = data.percentage || 0;
  percentEl.textContent = percent + '%';
  percentEl.style.color = percent < 50 ? '#22c55e' : percent < 80 ? '#eab308' : '#ef4444';
}

function showNoData(message = 'Нет данных') {
  siteEl.textContent = message;
  modelEl.textContent = '—';
  tokensEl.textContent = '—';
  limitEl.textContent = '—';
  percentEl.textContent = '—';
  percentEl.style.color = '#8888aa';
}

// Загружаем статистику при открытии
document.addEventListener('DOMContentLoaded', loadStats);