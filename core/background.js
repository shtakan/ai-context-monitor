// core/background.js
// Service Worker. Ставит перехватчики в МИР САЙТА ДО загрузки страницы
// (document_start), программно, через registerContentScripts.
// Это не зависит от manifest и не ломает существующую инжекцию content.js.
// Копия DEBUG + debugLog для SW (импорт невозможен в MV3 non-module SW).
var DEBUG = false;
// v51 (A3): lastGoodModel — ТОЛЬКО кэш-оптимизация (предпочтительный кандидат для countTokens).
// MV3 SW не персистентен: глобал теряется при рестарте SW — это ожидаемо и безопасно,
// handleCountTokens просто пробует кандидатов заново. Персистентность не обязательна.
var lastGoodModel = '';
function debugLog(level) {
  var args = Array.prototype.slice.call(arguments, 1);
  if (level === 'error' || level === 'warn') { (console[level] || console.log).apply(console, args); return; }
  if (DEBUG) { (console[level] || console.log).apply(console, args); }
}
console.log('AI Context Monitor: Service Worker запущен');

// v1.15 (COLD-START): маркер реального холодного старта — новый процесс браузера (или
// перезапуск SW из остановленного состояния) будит Service Worker, и мы фиксируем время
// инициализации: в консоль SW и в chrome.storage.local (aiCmLastSwStart) — чтобы после
// полного рестарта Chrome можно было доказательно сверить «браузер перезапускался».
// Значение: 'COLD_START@<epochMs>'; перезаписывается при каждом новом старте SW.
var aiCmSwBootTs = Date.now();
console.log('[AI CM][COLD_START] Service Worker стартовал ts=' + aiCmSwBootTs +
  ' iso=' + new Date(aiCmSwBootTs).toISOString() +
  ' ext=' + chrome.runtime.getManifest().version);
try {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ aiCmLastSwStart: 'COLD_START@' + aiCmSwBootTs });
  }
} catch (eCsBoot) { }

// v1.14.1 (O3): по умолчанию chrome.storage.session недоступен контент-скриптам.
// Открываем доступ, чтобы кросс-табовый латч already-fired (см. content.js)
// читался/писался прямо из вкладок — без EXTRA сообщений через SW.
try {
  if (chrome.storage.session && chrome.storage.session.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  }
} catch (eO3Access) { }

// Фаза B: чистая логика проактивных порогов из utils/gemini-intercept-logic.js
// (UMD-файл экспортирует api в self в SW; window/module отсутствуют).
if (typeof importScripts === 'function') {
  try { importScripts('/utils/gemini-intercept-logic.js'); } catch (e) { console.warn('[AI CM][thresholds] importScripts error:', e); }
}

// v52: дубликаты регистраций после перезагрузки расширения гасим здесь:
// при "Duplicate script ID" снимаем старую и регистрируем заново.
async function registerSafe(id, cfg) {
  try {
    await chrome.scripting.registerContentScripts([cfg]);
  } catch (e) {
    if (/Duplicate script ID/.test(String(e && e.message))) {
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
      await chrome.scripting.registerContentScripts([cfg]);
    } else throw e;
  }
}

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
      await registerSafe('ai-cm-page-intercept', {
        id: 'ai-cm-page-intercept',
        matches: ['https://chatgpt.com/*'],
        js: ['utils/debug.js', 'utils/chatgpt-conversation-parser.js', 'utils/intercept-common.js', 'core/page-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
      console.log('AI Context Monitor: перехватчик ChatGPT зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик Gemini (новое)
    if (ids.indexOf('ai-cm-gemini-intercept') === -1) {
      await registerSafe('ai-cm-gemini-intercept', {
        id: 'ai-cm-gemini-intercept',
        matches: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
        js: ['utils/debug.js', 'utils/gemini-batchexecute-parser.js', 'utils/gemini-intercept-logic.js', 'core/gemini-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
      console.log('AI Context Monitor: перехватчик Gemini зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик DeepSeek (v2: новый id, чтобы Chrome гарантированно перезагрузил
    // обновлённый код — MV3 registerContentScripts не перезаписывает содержимое при
    // одинаковом id из прежней версии расширения, из-за чего на chat.deepseek.com
    // перехватчик молчал и попап показывал «Откройте поддерживаемый сайт»).
    if (ids.indexOf('ai-cm-deepseek-intercept-v2') === -1) {
      await registerSafe('ai-cm-deepseek-intercept-v2', {
        id: 'ai-cm-deepseek-intercept-v2',
        matches: ['https://chat.deepseek.com/*'],
        js: ['utils/debug.js', 'core/deepseek-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
      console.log('AI Context Monitor: перехватчик DeepSeek (v2) зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик Claude
    if (ids.indexOf('ai-cm-claude-intercept') === -1) {
      await registerSafe('ai-cm-claude-intercept', {
        id: 'ai-cm-claude-intercept',
        matches: ['https://claude.ai/*'],
        js: ['utils/debug.js', 'utils/intercept-common.js', 'core/claude-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
      console.log('AI Context Monitor: перехватчик Claude зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик Perplexity
    if (ids.indexOf('ai-cm-perplexity-intercept') === -1) {
      await registerSafe('ai-cm-perplexity-intercept', {
        id: 'ai-cm-perplexity-intercept',
        matches: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
        js: ['utils/debug.js', 'utils/perplexity-parser.js', 'utils/intercept-common.js', 'core/perplexity-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
      console.log('AI Context Monitor: перехватчик Perplexity зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик Google Search AI
    if (ids.indexOf('ai-cm-google-search-intercept') === -1) {
      await registerSafe('ai-cm-google-search-intercept', {
        id: 'ai-cm-google-search-intercept',
        matches: ['https://www.google.com/*'],
        js: ['utils/debug.js', 'utils/google-search-folwr-parser.js', 'utils/intercept-common.js', 'core/google-search-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
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
  // v1.15: dead-code обработчик UPDATE_CONTEXT_INFO удалён — SW эти данные не использует,
  // только логировал раньше под флагом «Подробные логи». Тип-имя разошлось в процессе
  // рефакторинга; реальные каналы от content.js: 'THRESHOLD_PCT' (бейдж/уведомления) и
  // 'COUNT_TOKENS' (BYOK). Приходящий 'CONTEXT_UPDATE' молча игнорируется.
  if (message.type === 'close-print-tab') {
    if (sender && sender.tab && sender.tab.id != null) {
      chrome.tabs.remove(sender.tab.id);
    }
  }
  if (message.type === 'COUNT_TOKENS') {
    handleCountTokens(message).then(sendResponse).catch(function (err) {
      console.error('COUNT_TOKENS error:', err);
      sendResponse({ error: err.message || 'unknown_error' });
    });
    return true; // асинхронный ответ
  }
  if (message.type === 'THRESHOLD_PCT') {
    checkThresholds(message.data || {}, sender);
  }
  if (message.type === 'BADGE_RESET') {
    // v55 (SPA): смена разговора в табе — гасим per-tab бейдж старого разговора;
    // актуальный поставит первый сработавший порог нового чата. Без таба-отправителя молчим.
    var tabIdR = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : null;
    if (tabIdR != null && chrome.action && chrome.action.setBadgeText) {
      try {
        chrome.action.setBadgeText({ text: '', tabId: tabIdR });
        debugLog('log', '[AI CM][thresholds] badge-reset tabId=' + tabIdR);
      } catch (eR) { }
    }
  }
  return true;
});

// ========== Фаза B: ПРОАКТИВНЫЕ ПОРОГИ (настраиваемые, S2) ==========
// content.js шлёт THRESHOLD_PCT {convId, site, pct}. Анти-спам по ТЗ «один раз на
// разговор»: латч — chrome.storage.session, ключ 'aiCmThr:'+convId → массив
// исполненных порогов. Ключ по convId → смена вкладки НЕ сбрасывает, смена разговора
// даёт новый ключ (самосброс); элементы никогда не снимаются до конца разговора.
// Пороги [low,medium,high] читаются через G.getProactiveThresholds() из
// chrome.storage.local ('aiCmProactiveThresholds', дефолт [70,85,95]).
// Цвет бейджа — зонный для уровня T: low зелёный, medium жёлтый, high красный.
function aiCmZoneColorFor(t, thresholds) {
  var thr = (thresholds && thresholds.length === 3) ? thresholds : [70, 85, 95]; // S2: синхронный фолбэк, если storage ещё не загрузился
  if (t >= thr[2]) return '#ef4444';
  if (t >= thr[1]) return '#eab308';
  return '#22c55e';
}

async function checkThresholds(data, sender) {
  try {
    var cfg = await new Promise(function (r) {
      chrome.storage.local.get(['aiCmProactive', 'aiCmProactiveNotify'], r);
    });
    if (cfg.aiCmProactive === false) return; // выключен в настройках
    var convId = data && data.convId ? String(data.convId) : '';
    var pct = (data && typeof data.pct === 'number') ? data.pct : NaN;
    if (!convId || !isFinite(pct)) return;

    var latchKey = 'aiCmThr:' + convId;
    var ses = await new Promise(function (r) { chrome.storage.session.get([latchKey], r); });
    var firedArr = Array.isArray(ses[latchKey]) ? ses[latchKey] : [];
    var firedSet = new Set(firedArr);

    var G = (typeof GeminiInterceptLogic !== 'undefined') ? GeminiInterceptLogic :
      ((typeof self !== 'undefined') ? self.GeminiInterceptLogic : null);
    // S2: настраиваемые пороги [low,medium,high] из chrome.storage.local
    // ('aiCmProactiveThresholds'); storage недоступен/не загрузился → дефолт [70,85,95].
    var thresholds = (G && typeof G.getProactiveThresholds === 'function')
      ? await G.getProactiveThresholds() : [70, 85, 95];
    var T = (G && typeof G.pickProactiveThreshold === 'function')
      ? G.pickProactiveThreshold(pct, firedSet, thresholds) : null;
    if (T == null) return;

    // Бейдж — пер-вкладочно, чтобы чужие табы не затирались
    var tabId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : null;
    if (tabId != null && chrome.action && chrome.action.setBadgeText) {
      try {
        chrome.action.setBadgeText({ text: String(T), tabId: tabId });
        chrome.action.setBadgeBackgroundColor({ color: aiCmZoneColorFor(T, thresholds), tabId: tabId });
      } catch (eB) { }
    }

    // Обновляем латч ДО побочных действий: гонки повторной отправки pct закрываются сразу.
    // Защита от скачка pct (60→92): в латч добавляем НЕ только T, а ВСЕ пороги <= pct,
    // иначе после «большого прыжка» следующий draw добил бы младший пропущенный порог
    // (70 после 85) и бейдж откатился бы назад. Смена convId → новый ключ, самосброс.
    firedArr.push(T);
    var THRESHOLDS = (thresholds && thresholds.length === 3) ? thresholds : [70, 85, 95];
    for (var i = 0; i < THRESHOLDS.length; i++) {
      if (THRESHOLDS[i] !== T && pct >= THRESHOLDS[i] && firedArr.indexOf(THRESHOLDS[i]) === -1) {
        firedArr.push(THRESHOLDS[i]);
      }
    }
    var patch = {};
    patch[latchKey] = firedArr;
    await new Promise(function (r) { chrome.storage.session.set(patch, r); });

    // Opt-in уведомление. Tab id зашит в id уведомления ('aiCmThr|<tabId>|<convId>|<T>') —
    // переживает рестарт SW без отдельного стейта. iconUrl — ТОЛЬКО абсолютный URL:
    // в MV3 SW относительный путь не резолвится → Chrome молча отбрасывает create.
    var notifyOn = cfg.aiCmProactiveNotify === true;
    if (!notifyOn) {
      debugLog('log', '[AI CM][thresholds] notify-skip reason=settings-off');
    } else if (!chrome.notifications || !chrome.notifications.create) {
      debugLog('log', '[AI CM][thresholds] notify-skip reason=no-notifications-api');
    } else {
      var notifId = 'aiCmThr|' + (tabId == null ? '' : String(tabId)) +
        '|' + convId + '|' + T;
      try {
        chrome.notifications.create(notifId, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'AI Context Monitor',
          message: 'Заполнение контекста ' + Math.round(pct * 10) / 10 + '% — достигнут порог ' + T + '%',
          requireInteraction: false,
          buttons: [{ title: 'Открыть чат' }]
        }, function () {
          var le = chrome.runtime.lastError;
          if (le) debugLog('log', '[AI CM][thresholds] notify-skip reason=api-error ' + (le.message || ''));
          else debugLog('log', '[AI CM][thresholds] notify-fire T=' + T + ' convId=' + convId);
        });
      } catch (eN) {
        debugLog('log', '[AI CM][thresholds] notify-skip reason=api-error ' + eN);
      }
    }
    debugLog('log', '[AI CM][thresholds] fired T=' + T + '% pct=' + pct + ' convId=' + convId);
  } catch (err) {
    console.error('[AI CM][thresholds] checkThresholds error:', err);
  }
}

// Кнопка «Открыть чат»: активируем исходную вкладку чата (id зашит в notifId);
// если вкладка закрыта — молча выходим. tabs.create не используем: дубликат чата не нужен.
if (chrome.notifications && chrome.notifications.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener(function (notifId) {
    try {
      var parts = String(notifId).split('|');
      if (parts[0] !== 'aiCmThr' || parts.length < 3 || parts[1] === '') return;
      var tabId = parseInt(parts[1], 10);
      if (!isFinite(tabId)) return;
      chrome.tabs.get(tabId, function (tab) {
        if (chrome.runtime.lastError || !tab) return;
        try {
          chrome.tabs.update(tabId, { active: true });
          if (chrome.windows && tab.windowId != null) {
            chrome.windows.update(tab.windowId, { focused: true });
          }
        } catch (eU) { }
      });
    } catch (e) { }
  });
}

async function handleCountTokens(message) {
  var text = message.text;
  var model = message.model || 'gemini-flash-latest';
  if (!text || text.length === 0) return { totalTokens: 0 };

  // Читаем ключ из chrome.storage.local
  var data = await new Promise(function (resolve) {
    chrome.storage.local.get(['ai_cm_gemini_api_key'], resolve);
  });
  var apiKey = data.ai_cm_gemini_api_key;
  if (!apiKey) return { error: 'no_key' };

  // Список кандидатов: lastGoodModel, запрошенная модель, фолбэки
  var rawCandidates = [lastGoodModel, model, 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'];
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
