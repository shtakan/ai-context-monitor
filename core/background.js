// core/background.js
// Service Worker. Ставит перехватчики в МИР САЙТА ДО загрузки страницы
// (document_start), программно, через registerContentScripts.
// Это не зависит от manifest и не ломает существующую инжекцию content.js.
// Копия DEBUG + debugLog для SW (импорт невозможен в MV3 non-module SW).
var DEBUG = true;
var lastGoodModel = ''; // запоминаем модель, которая реально сработала для countTokens
function debugLog(level) {
  var args = Array.prototype.slice.call(arguments, 1);
  if (level === 'error' || level === 'warn') { (console[level] || console.log).apply(console, args); return; }
  if (DEBUG) { (console[level] || console.log).apply(console, args); }
}
console.log('AI Context Monitor: Service Worker запущен');

async function ensureInterceptor() {
  try {
    if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
    var existing = [];
    try {
      existing = await chrome.scripting.getRegisteredContentScripts();
    } catch (e) { existing = []; }
    var ids = existing.map(function (s) { return s.id; });

    // перехватчик ChatGPT (как было)
    if (ids.indexOf('ai-cm-page-intercept') === -1) {
      await chrome.scripting.registerContentScripts([{
        id: 'ai-cm-page-intercept',
        matches: ['https://chatgpt.com/*'],
        js: ['utils/debug.js', 'core/page-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      }]);
      console.log('AI Context Monitor: перехватчик ChatGPT зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик Gemini (новое)
    if (ids.indexOf('ai-cm-gemini-intercept') === -1) {
      await chrome.scripting.registerContentScripts([{
        id: 'ai-cm-gemini-intercept',
        matches: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
        js: ['utils/debug.js', 'core/gemini-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      }]);
      console.log('AI Context Monitor: перехватчик Gemini зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик DeepSeek
    if (ids.indexOf('ai-cm-deepseek-intercept') === -1) {
      await chrome.scripting.registerContentScripts([{
        id: 'ai-cm-deepseek-intercept',
        matches: ['https://chat.deepseek.com/*'],
        js: ['utils/debug.js', 'core/deepseek-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      }]);
      console.log('AI Context Monitor: перехватчик DeepSeek зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик Claude
    if (ids.indexOf('ai-cm-claude-intercept') === -1) {
      await chrome.scripting.registerContentScripts([{
        id: 'ai-cm-claude-intercept',
        matches: ['https://claude.ai/*'],
        js: ['utils/debug.js', 'core/claude-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      }]);
      console.log('AI Context Monitor: перехватчик Claude зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик Google Search AI
    if (ids.indexOf('ai-cm-google-search-intercept') === -1) {
      await chrome.scripting.registerContentScripts([{
        id: 'ai-cm-google-search-intercept',
        matches: ['https://www.google.com/*'],
        js: ['utils/debug.js', 'core/google-search-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      }]);
      console.log('AI Context Monitor: перехватчик Google Search AI зарегистрирован (мир сайта, document_start)');
    }
  } catch (err) {
    console.warn('AI Context Monitor: не удалось зарегистрировать перехватчик:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Context Monitor установлен');
  chrome.storage.sync.set({
    selectedModel: 'auto',
    customLimit: null,
    showPercentage: true
  });
  ensureInterceptor();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => { ensureInterceptor(); });
}
ensureInterceptor();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog('log', 'Получено сообщение в Service Worker:', message);
  if (message.type === 'UPDATE_CONTEXT_INFO') {
    console.log('Данные о контексте:', message.data);
  }
  if (message.type === 'COUNT_TOKENS') {
    handleCountTokens(message).then(sendResponse).catch(function (err) {
      console.error('COUNT_TOKENS error:', err);
      sendResponse({ error: err.message || 'unknown_error' });
    });
    return true; // асинхронный ответ
  }
  return true;
});

async function handleCountTokens(message) {
  var text = message.text;
  var model = message.model || 'gemini-1.5-pro';
  if (!text || text.length === 0) return { totalTokens: 0 };

  // Читаем ключ из chrome.storage.local
  var data = await new Promise(function (resolve) {
    chrome.storage.local.get(['ai_cm_gemini_api_key'], resolve);
  });
  var apiKey = data.ai_cm_gemini_api_key;
  if (!apiKey) return { error: 'no_key' };

  // Список кандидатов: lastGoodModel, запрошенная модель, фолбэки
  var rawCandidates = [lastGoodModel, model, 'gemini-2.5-flash', 'gemini-2.0-flash'];
  var candidates = [];
  for (var i = 0; i < rawCandidates.length; i++) {
    var c = rawCandidates[i];
    if (c && candidates.indexOf(c) === -1) candidates.push(c);
  }

  for (var j = 0; j < candidates.length; j++) {
    var cand = candidates[j];
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cand) + ':countTokens';

    try {
      var response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: text }] }]
        })
      });

      if (response.ok) {
        lastGoodModel = cand;
        console.log('[count-tokens] использована модель: ' + cand);
        var json = await response.json();
        var totalTokens = (json && typeof json.totalTokens === 'number') ? json.totalTokens : 0;
        return { totalTokens: totalTokens };
      }

      // Не ok — логируем и пробуем следующего кандидата
      var errText = '';
      try { errText = await response.text(); } catch (e) { }
      console.warn('[count-tokens] модель ' + cand + ' вернула ' + response.status + ': ' + errText.slice(0, 120));
    } catch (fetchError) {
      console.warn('[count-tokens] модель ' + cand + ' fetch error: ' + fetchError.message);
    }
  }

  return { error: 'all_models_failed' };
}
