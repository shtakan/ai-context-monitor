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
  aiCmPruneHistory(); // M-8: TTL per-host истории — чистка при установке/обновлении
  aiCmMigrateByokToSession(); // M-7: plaintext-ключ BYOK из local → session (и стирание с диска)
  ensureInterceptor();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    aiCmPruneHistory(); // M-8: TTL per-host истории — чистка при старте браузера
    aiCmMigrateByokToSession(); // M-7: plaintext-ключ BYOK из local → session (и стирание с диска)
    ensureInterceptor();
  });
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
    // M-9: sender нужен для debounce-ключа (tabId); текст/модель — из message, как раньше.
    handleCountTokens(message, sender).then(sendResponse).catch(function (err) {
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

// ========== M-7: BYOK-ключ — ТОЛЬКО chrome.storage.session ==========
// Аудит фазы 3: ключ Google AI Studio лежал в chrome.storage.local открытым
// текстом и оставался на диске. Решение — session-only (chrome.storage.session):
// ключ живёт в памяти сессии браузера до перезапуска и на диск не пишется.
// Псевдо-шифрование в local сознательно НЕ применяется.
var AI_CM_BYOK_SESSION_KEY = 'aiCmApiKeySession';
// Известные имена plaintext-ключа BYOK прежних версий — их гарантированно
// стираем из chrome.storage.local (имя из README/настроек прежних версий первое).
var AI_CM_BYOK_LEGACY_KEYS = [
  'ai_cm_gemini_api_key',
  'ai_cm_api_key',
  'ai_cm_byok_key',
  'aiCmGeminiApiKey',
  'aiCmApiKey',
  'gemini_api_key'
];

// Первое непустое значение среди известных legacy-имён ключа (иначе '').
function aiCmFirstLegacyByokKey(data) {
  for (var i = 0; i < AI_CM_BYOK_LEGACY_KEYS.length; i++) {
    var v = data ? data[AI_CM_BYOK_LEGACY_KEYS[i]] : null;
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

// Удаление plaintext-ключей BYOK из chrome.storage.local — по всем известным именам.
function aiCmPurgeLegacyByokKeys() {
  try {
    if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.remove !== 'function') return;
    chrome.storage.local.remove(AI_CM_BYOK_LEGACY_KEYS);
  } catch (ePurge) { }
}

// M-7: миграция plaintext→session на onInstalled/onStartup. Ключ найден в local →
// переносим в session, стираем с диска, пишем лог. Идемпотентно: если в local ключа
// нет (штатное состояние после первой миграции) — не делаем ничего.
function aiCmMigrateByokToSession() {
  try {
    if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== 'function') return;
    chrome.storage.local.get(AI_CM_BYOK_LEGACY_KEYS, function (data) {
      var legacy = aiCmFirstLegacyByokKey(data);
      if (!legacy) return;
      try {
        if (chrome.storage.session && typeof chrome.storage.session.set === 'function') {
          var patch = {};
          patch[AI_CM_BYOK_SESSION_KEY] = legacy;
          chrome.storage.session.set(patch);
        }
      } catch (eSet) { }
      aiCmPurgeLegacyByokKeys();
      console.log('[AI CM][byok] migrated plaintext→session');
    });
  } catch (eMig) { }
}

// Чтение ключа BYOK: штатный источник — chrome.storage.session ('aiCmApiKeySession').
function aiCmSessionByokGet() {
  return new Promise(function (resolve) {
    try {
      if (!chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== 'function') {
        resolve(''); return;
      }
      chrome.storage.session.get([AI_CM_BYOK_SESSION_KEY], function (d) {
        var v = d ? d[AI_CM_BYOK_SESSION_KEY] : '';
        resolve((typeof v === 'string') ? v : '');
      });
    } catch (eGet) { resolve(''); }
  });
}

// M-7: ключ для COUNT_TOKENS. session — первичен; переходный фолбэк на plaintext
// прежних версий в local нужен только на окно миграции (SW мог обновиться в уже
// открытом браузере раньше onInstalled): найденный legacy-ключ переносим в session
// и стираем из local — пользователь не теряет ключ, диск очищается.
async function aiCmReadByokApiKey() {
  var key = await aiCmSessionByokGet();
  if (key) return key;

  var legacy = await new Promise(function (resolve) {
    try {
      if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== 'function') {
        resolve(''); return;
      }
      chrome.storage.local.get(AI_CM_BYOK_LEGACY_KEYS, function (d) { resolve(aiCmFirstLegacyByokKey(d)); });
    } catch (eLeg) { resolve(''); }
  });
  if (!legacy) return '';

  try {
    if (chrome.storage.session && typeof chrome.storage.session.set === 'function') {
      var patch = {};
      patch[AI_CM_BYOK_SESSION_KEY] = legacy;
      chrome.storage.session.set(patch);
    }
  } catch (eSet) { }
  aiCmPurgeLegacyByokKeys();
  console.log('[AI CM][byok] migrated plaintext→session');
  return legacy;
}

// ========== M-9: гигиена COUNT_TOKENS (таймаут + debounce + кэш) ==========
// Протокол COUNT_TOKENS — инвариант: имя сообщения, поля запроса (text/model) и
// фолбэк content.js при ok:false НЕ меняются. Все поля ниже — ТОЛЬКО добавленные.

// Таймаут сети: висящий fetch (зависший сокет, «чёрная дыра» прокси) держал запрос
// вечно, а content.js показывал «pending» без точного значения. AbortController
// обрывает попытку кандидата, handleCountTokens сразу уходит в фолбэк.
var COUNT_TOKENS_TIMEOUT_MS = 10000;

// Debounce: стриминг шлёт COUNT_TOKENS на каждую эмиссию истории → сеть дёргалась
// на каждый кадр. Ключ = tabId:convId:model; в окне 800 мс выполняется ТОЛЬКО
// последний запрос окна, ожидающий таймер снимается (clearTimeout).
var COUNT_TOKENS_DEBOUNCE_MS = 800;

// Кэш Map в SW: ключ = model + ':' + FNV-1a hash(content), значение = число токенов.
// Ёмкость 200, вытеснение FIFO (самая старая запись). Кэш живёт до перезапуска SW —
// это приемлемо: MV3 SW не персистентен, промах стоит одного сетевого запроса.
var COUNT_TOKENS_CACHE_MAX = 200;
var countTokensCache = new Map();

// FNV-1a 32-бит: дешёвый детерминированный хеш текста. Хранить сам текст в ключе
// нельзя — кэш из 200 длинных контекстов съел бы память SW; коллизия даёт лишь
// неверное число токенов, поэтому дополнительно сверяем длину текста.
function countTokensHash(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function countTokensCacheGet(model, text) {
  var key = model + ':' + countTokensHash(text);
  var hit = countTokensCache.get(key);
  if (!hit || hit.len !== text.length) return null;
  return { key: key, tokens: hit.tokens };
}

function countTokensCacheSet(model, text, tokens) {
  var key = model + ':' + countTokensHash(text);
  if (countTokensCache.has(key)) countTokensCache.delete(key); // FIFO: перезапись = свежая запись
  countTokensCache.set(key, { tokens: tokens, len: text.length });
  while (countTokensCache.size > COUNT_TOKENS_CACHE_MAX) {
    countTokensCache.delete(countTokensCache.keys().next().value); // вытеснение самой старой
  }
}

// Отложенные вызовы: строковый ключ debounce → {promise, resolve, timer, payload}.
// Ключ именно СТРОКА (не объект): Map живёт в песочнице SW, а объектные ключи из
// разных контекстов не совпадают по идентичности. Повторный COUNT_TOKENS по тому же
// ключу снимает таймер предшественника и переиспользует его promise: оба sendResponse
// получат результат последнего (фактически выполненного) запроса окна.
var countTokensPending = new Map();

function scheduleCountTokens(key, payload, debounced) {
  var entry = countTokensPending.get(key);
  if (entry && entry.timer != null) {
    clearTimeout(entry.timer); // отмена ожидающего запроса окна
    entry.timer = null;
    entry.debounced = 1;
  }
  if (!entry) {
    entry = { promise: null, resolve: null, timer: null, debounced: 0 };
    entry.promise = new Promise(function (resolve) { entry.resolve = resolve; });
    countTokensPending.set(key, entry);
  }
  entry.debounced = debounced || entry.debounced;
  // payload фиксируется на момент планирования: таймер исполняет именно последний запрос окна.
  entry.payload = { text: payload.text, model: payload.model, debounced: entry.debounced };
  if (entry.timer == null) {
    entry.timer = setTimeout(function () {
      countTokensPending.delete(key);
      handleCountTokensRun(entry.payload).then(entry.resolve, function (e) {
        entry.resolve({ error: e && e.message ? e.message : 'unknown_error' });
      });
    }, COUNT_TOKENS_DEBOUNCE_MS);
  }
  return entry.promise;
}

function handleCountTokens(message, sender) {
  var text = (message && message.text) || '';
  var model = message.model || 'gemini-flash-latest'; // НЕ менять: пинуется тестом exact-token-count-models
  if (!text || text.length === 0) return Promise.resolve({ totalTokens: 0 });

  // Кэш проверяем ДО debounce: попадание отвечает немедленно, без сети и без ожидания окна.
  var hit = countTokensCacheGet(model, text);
  if (hit) {
    // M-8 (вшивка A): путь cache-hit раньше отвечал без строки наблюдаемости —
    // несмотря на cached=1/debounced=0 в ответе, по логам нельзя было отличить
    // попадание кэша от сетевого ответа. Формат строки согласован с ok-строкой ниже.
    console.log('[AI CM][countTokens] cache-hit model=' + model + ' tokens=' + hit.tokens + ' cached=1 debounced=0');
    return Promise.resolve({
      ok: true,
      totalTokens: hit.tokens,
      tokens: hit.tokens,
      cached: 1,
      debounced: 0
    });
  }

  // Ключ debounce = tabId + ':' + convId + ':' + model (как в ТЗ).
  var tabId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : '';
  var convId = (message && message.convId) ? String(message.convId) : '';
  var key = tabId + ':' + convId + ':' + model;
  return scheduleCountTokens(key, { text: text, model: model }, 0);
}

async function handleCountTokensRun(run) {
  var text = run.text;
  var model = run.model;
  if (!text || text.length === 0) return { totalTokens: 0 };

  var isDebounced = run.debounced ? 1 : 0;
  var logPrefix = '[AI CM][countTokens]';

  // M-7: ключ читаем из chrome.storage.session ('aiCmApiKeySession') — на диск он
  // больше не пишется; в local допустим только переходный plaintext-фолбэк, который
  // тут же переносится в session и стирается (см. aiCmReadByokApiKey).
  var apiKey = await aiCmReadByokApiKey();
  if (!apiKey) return { ok: false, reason: 'no-key' };

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

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var abortReason = '';
    var timeoutId = null;
    if (controller) {
      timeoutId = setTimeout(function () { abortReason = 'timeout'; controller.abort(); }, COUNT_TOKENS_TIMEOUT_MS);
    }

    try {
      var fetchOpts = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: text }] }]
        })
      };
      if (controller) fetchOpts.signal = controller.signal;
      var response = await fetch(url, fetchOpts);

      if (response.ok) {
        lastGoodModel = cand;
        console.log('[count-tokens] использована модель: ' + cand);
        var json = await response.json();
        var totalTokens = (json && typeof json.totalTokens === 'number') ? json.totalTokens : 0;
        if (totalTokens > 0) countTokensCacheSet(model, text, totalTokens);
        // M-9: строка результата несёт cached=0|1 и debounced=0|1 (факт отмены предшественника).
        console.log(logPrefix + ' ok model=' + cand + ' tokens=' + totalTokens + ' cached=0 debounced=' + isDebounced);
        return { ok: true, totalTokens: totalTokens, tokens: totalTokens, cached: 0, debounced: isDebounced };
      }

      // Не ok — логируем и пробуем следующего кандидата
      var errText = '';
      try { errText = await response.text(); } catch (e) { }
      console.warn('[count-tokens] модель ' + cand + ' вернула ' + response.status + ': ' + errText.slice(0, 120));
    } catch (fetchError) {
      if (abortReason === 'timeout') {
        // Таймаут: висящий запрос снят AbortController'ом. Сообщаем причину и выходим —
        // повторять кандидатов после таймаута смысла нет, content.js уходит в эвристику.
        console.log(logPrefix + ' abort reason=timeout model=' + cand + ' debounced=' + isDebounced);
        return { ok: false, error: 'timeout', reason: 'timeout', totalTokens: 0, cached: 0, debounced: isDebounced };
      }
      console.warn('[count-tokens] модель ' + cand + ' fetch error: ' + fetchError.message);
    } finally {
      if (timeoutId != null) clearTimeout(timeoutId);
    }
  }

  return { error: 'all_models_failed' };
}

// ========== M-8: TTL per-host истории (chrome.storage.local) ==========
// Ключи 'aiCmHistory:<host>' (см. core/content.js) писались без срока жизни: за месяцы
// работы хранилище росло неограниченно — по одной записи на каждый посещённый хост,
// и старые записи не удалялись никогда. TTL = 30 дней: per-host запись несёт
// аддитивное поле ts (Date.now() на момент записи), запись с ts старше TTL удаляется.
// Глобальный ключ 'aiCmHistory' (last-writer-wins между вкладками, тело экспорта его
// не читает — см. E-1) префикса 'aiCmHistory:' не имеет и НЕ трогается: семантика прежняя.
var AI_CM_HISTORY_TTL_MS = 2592000000; // 30 суток = 30 * 24 * 60 * 60 * 1000

// Просрочена ли запись. ts отсутствует (запись прежней версии либо чужая форма) —
// НЕ удаляем: «форма записи сохраняется», оснований считать её просроченной нет.
// Сравнение строгое: ровно 30 дней — ещё живая запись.
function aiCmHistoryEntryStale(rec, now) {
  var ts = (rec && typeof rec.ts === 'number') ? rec.ts : null;
  if (ts == null) return false;
  return (now - ts) > AI_CM_HISTORY_TTL_MS;
}

function aiCmHistoryPruneRemove(stale) {
  if (!stale.length) { console.log('[AI CM][storage] prune removed=0'); return; }
  if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.remove !== 'function') return;
  chrome.storage.local.remove(stale, function () {
    console.log('[AI CM][storage] prune removed=' + stale.length);
  });
}

// Перебор ВСЕХ ключей chrome.storage.local (get(null)) с фильтром по префиксу
// 'aiCmHistory:' — двоеточие само отсекает глобальный ключ 'aiCmHistory'.
function aiCmPruneHistory() {
  try {
    if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== 'function') return;
    chrome.storage.local.get(null, function (all) {
      try {
        var now = Date.now();
        var stale = [];
        var keys = (all && typeof all === 'object') ? Object.keys(all) : [];
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (key.indexOf('aiCmHistory:') !== 0) continue;
          if (aiCmHistoryEntryStale(all[key], now)) stale.push(key);
        }
        aiCmHistoryPruneRemove(stale);
      } catch (e) {
        console.warn('[AI CM][storage] prune error:', e);
      }
    });
  } catch (e2) {
    console.warn('[AI CM][storage] prune error:', e2);
  }
}

// Ленивый вызов: content.js пишет 'aiCmHistory:<host>' → storage.onChanged будит SW
// и дочищает просрочку, не дожидаясь следующего старта браузера. Реагируем только на
// запись ключа истории в local: прочие ключи и sync-область sweep не запускают.
if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local' || !changes) return;
    var touched = false;
    var changedKeys = Object.keys(changes);
    for (var i = 0; i < changedKeys.length; i++) {
      if (changedKeys[i].indexOf('aiCmHistory:') === 0) { touched = true; break; }
    }
    if (touched) aiCmPruneHistory();
  });
}
