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

// ========== M-4.5 (аудит 1.7): i18n — строки Chrome-уведомлений из _locales ==========
// Пользовательские строки уведомления берутся из chrome.i18n.getMessage (ключи
// bg_notification_* есть в ru и en). chrome.i18n в MV3 SW доступен всегда; фолбэк
// (юнит-тесты, отладочный контекст) — прежний русский текст, байтово тот же.
// $1..$9 в сообщении локали подставляются substitutions (placeholders → $1/$2).
function aiCmI18nMessage(key, fallback, substitutions) {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
      var message = substitutions ? chrome.i18n.getMessage(key, substitutions) : chrome.i18n.getMessage(key);
      if (message) return message;
    }
  } catch (eMessage) { }
  return fallback;
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

// Шаг A.1 (security): chrome.storage.session сжат до доверенных контекстов.
// v1.14.1 (O3) открывал его ВСЕМ контент-скриптам (TRUSTED_AND_UNTRUSTED_CONTEXTS),
// из-за чего BYOK-ключ ('aiCmApiKeySession') был читаем кодом любого сайта в общей
// куче контент-скриптов. Теперь доступ есть только у SW и extension-страниц
// (options/options.js — trusted-контекст, его BYOK-путь не меняется); контент-скрипты
// получают ключ и трогают O3-латч ТОЛЬКО сообщениями к SW (см. обработчики
// 'aiCm-get-byok-key' и 'aiCm-latch-*' ниже).
try {
  if (chrome.storage.session && chrome.storage.session.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS_ONLY' });
  }
} catch (eO3Access) { }

// Шаг A.1 (R6): ключ BYOK пишет options-страница напрямую в chrome.storage.session —
// вкладкам этот onChanged (area='session') больше не виден (доступ сжат выше), поэтому
// SW транслирует факт смены ключа сообщением 'aiCm-byok-key-changed'; контент
// перечитывает ключ через 'aiCm-get-byok-key' (иначе считал бы токены старым ключом).
try {
  if (chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
    chrome.storage.onChanged.addListener(function (changes, area) {
      try {
        if (area !== 'session' || !changes || !changes[AI_CM_BYOK_SESSION_KEY]) return;
        chrome.tabs.query({}, function (tabs) {
          try {
            for (var iT = 0; iT < (tabs || []).length; iT++) {
              if (tabs[iT] && tabs[iT].id != null && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
                chrome.tabs.sendMessage(tabs[iT].id, { type: 'aiCm-byok-key-changed' }, function () {
                  // Канал к вкладке мог закрыться (навигация/закрытие) — lastError гасим,
                  // иначе Chrome пишет «Unchecked runtime.lastError» в консоль SW.
                  try { void chrome.runtime.lastError; } catch (eLe) { }
                });
              }
            }
          } catch (eBs) { }
        });
      } catch (eCh) { }
    });
  }
} catch (eByokWatch) { }

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

    // перехватчик Gemini (v2.0, этап 3/3: id сменён на -v2 по решению B; сам кластер
    // скрытого скролла вынесен на этапе 2/3 в core/gemini-hidden-scroll.js — модуль
    // обязан идти ПЕРЕД core/gemini-intercept.js).
    // Phase 3 step 1 (диагностика): кластер DIAG_TOKENS + логи холодного старта вынесены в
    // core/gemini-diag.js, он идёт ПЕРЕД ядром (после hidden-scroll). Ядро умеет жить без
    // него (мягкая деградация + лог), поэтому у профилей с уже установленным id -v2
    // диагностика просто выключится до миграции id — функциональные пути не задеты.
    // Phase 3 step 5 (rpc): опознание RPC + метаданные запроса (buildActive*/rememberSiteMeta/
    // captureHeadersFromInit и родственные) вынесены в core/gemini-rpc.js, он идёт ПЕРЕД ядром
    // (после diag). Ядро тоже умеет жить без него (мягкая деградация + безопасные заглушки).
    // Почему id сменён, а не переиспользован: MV3 registerContentScripts НЕ перечитывает
    // js[] под уже существующим id, унаследованным от прежней версии расширения —
    // без смены id core/gemini-hidden-scroll.js не доехал бы до обновившихся
    // пользователей (прецедент — DeepSeek, id 'ai-cm-deepseek-intercept-v11' ниже).
    // Шаг 5 использует ровно тот же приём: id -v3, а прежние -v2 и legacy снимаются ниже.
    // Шаг 6 (кластер парсеров кадра, core/gemini-parse.js) id НЕ меняет: файл добавлен в js[]
    // уже зарегистрированного -v3. Для профиля, где -v3 зарегистрирован РАНЬШЕ (например,
    // после шага 5), Chrome список js[] не перечитает → модуль не подключится, и ядро
    // деградирует мягко: parseBatchExecute отдаёт пустой список ходов (парсинг выключен
    // целиком, не только salvage). Лечится перезагрузкой расширения или бампом id.
    // Phase 3 step 7: бамп -v3 → -v4 ровно по этой причине — core/gemini-parse.js шага 6 не
    // доезжал до профилей, где -v3 зарегистрирован раньше (Chrome не перечитывает js[]), и
    // парсинг кадров молча деградировал до заглушки. Новый id гарантирует доставку модуля;
    // -v3 снимается ниже вместе с -v2 и legacy, чтобы старый пучок (без parse) не жил
    // параллельно с новым.
    // Phase 3 step 9: бамп -v4 → -v5 по той же причине — core/gemini-sse.js (SSE-кластер:
    // перехват fetch/XHR) не доехал бы до профилей, где -v4 зарегистрирован раньше. Здесь
    // цена ошибки выше, чем у parse: без модуля ядро ставит no-op вместо installNetworkHooks,
    // то есть перехват сети Gemini выключается ЦЕЛИКОМ (пассивные снимки в ingest не попадают).
    // Phase 3 step 10: бамп -v5 → -v6 по той же причине — core/pagination/pagination.js
    // (кластер пагинации и контроля полноты) не доехал бы до профилей, где -v5
    // зарегистрирован раньше. Без модуля ядро ставит no-op на paginateLoop/finishQuiet/
    // runCompletenessProbe, поэтому тихая пагинация и независимый probe выключены:
    // база доезжает активными путями (vf5/лоадер), но полнота больше НЕ доказывается.
    // Phase 3 step 11: бамп -v6 → -v7 по той же причине — core/gemini-loader-scroll.js
    // (кластер лоадера полной истории и его автозапуска) не доехал бы до профилей, где -v6
    // зарегистрирован раньше. Цена ошибки здесь самая высокая из всех шагов: без модуля
    // ядро ставит no-op на автозапуск лоадера, и скрытый доскролл до начала истории
    // выключается ЦЕЛИКОМ (ручной запуск из консоли тоже), то есть на длинных чатах база
    // молча остаётся неполной.
    // Phase 3 step 12: бамп -v7 → -v8 по той же причине — добавлен core/gemini-ingest.js
    // (ingest-кластер вынесен из ядра: приём снимков базы, выход снимка, разбор кадра).
    // Без бампа id у уже установленного расширения Chrome останется прежний registration,
    // js[] не перечитается, и ядро будет работать без кластера: база молча останется неполной.
    // Phase 3 step 13.1: бамп -v8 → -v9 по той же причине — добавлен core/gemini-overlay.js
    // (кластер оверлея вынесен из ядра: палитра под in-app тему сервиса, наблюдатель темы,
    // постановка и seq-гвардированное снятие оверлея, страховка видимости). Без бампа id у уже
    // установленного расширения Chrome останется прежний registration, js[] не перечитается,
    // и ядро будет работать без кластера: оверлей загрузки истории выключается целиком,
    // а форвардеры aiCmSetScrollOverlay/forceRestoreVisibility возвращают undefined.
    // Phase 3 step 13.2: бамп -v9 → -v10 по той же причине — добавлен core/gemini-archive.js
    // (кластер архива вынесен из ядра: приём ходов архива и ленты кэша, оракул archive-complete,
    // пол архива и сводка объединённой базы для экспорта). Без бампа id у уже установленного
    // расширения Chrome останется прежний registration, js[] не перечитается, и ядро будет
    // работать без кластера: архивный ярус выключается целиком, а форвардеры возвращают
    // null/true/baseSize() — гейты полноты молча теряют T1-архив.
    // Phase 3 step 13.3: бамп -v10 → -v11 по той же причине — добавлен core/gemini-oracle.js
    // (оракул полноты вынесен из ядра: floor-confirmed и его debounce, loader-stable-stop с
    // вложенным stableCheck74, отпечатки краёв базы и мост снимка ходов). Без бампа id у уже
    // установленного расширения Chrome останется прежний registration, js[] не перечитается,
    // и ядро будет работать без кластера: floor-confirmed и loader-stable-stop не взводятся,
    // снапшот ходов пуст, а форвардеры возвращают undefined — полнота молча не подтверждается.
    if (ids.indexOf('ai-cm-gemini-intercept-v11') === -1) {
      // Снимаем регистрации прежних id: они остались в профиле после обновления и
      // несли бы старый js[] (без hidden-scroll/diag/rpc/parse/sse) параллельно с новым пучком.
      // Прежних id может не быть (чистая установка) — поэтому тихий catch без диагностики.
      try {
        await chrome.scripting.unregisterContentScripts({ ids: ['ai-cm-gemini-intercept', 'ai-cm-gemini-intercept-v2', 'ai-cm-gemini-intercept-v3', 'ai-cm-gemini-intercept-v4', 'ai-cm-gemini-intercept-v5', 'ai-cm-gemini-intercept-v6', 'ai-cm-gemini-intercept-v7', 'ai-cm-gemini-intercept-v8', 'ai-cm-gemini-intercept-v9', 'ai-cm-gemini-intercept-v10'] });
      } catch (eUnregGemini) { }
      await registerSafe('ai-cm-gemini-intercept-v11', {
        id: 'ai-cm-gemini-intercept-v11',
        matches: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
        js: ['utils/debug.js', 'utils/gemini-batchexecute-parser.js', 'utils/gemini-intercept-logic.js', 'core/gemini-hidden-scroll.js', 'core/gemini-diag.js', 'core/gemini-rpc.js', 'core/gemini-parse.js', 'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-oracle.js', 'core/gemini-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
      console.log('AI Context Monitor: перехватчик Gemini (v11) зарегистрирован (мир сайта, document_start)');
    }

    // перехватчик DeepSeek (v2: новый id, чтобы Chrome гарантированно перезагрузил
    // обновлённый код — MV3 registerContentScripts не перезаписывает содержимое при
    // одинаковом id из прежней версии расширения, из-за чего на chat.deepseek.com
    // перехватчик молчал и попап показывал «Откройте поддерживаемый сайт»).
    // Step D.1: бамп -v2 → -v3 — добавлен core/deepseek-diag.js (кластер диагностики
    // вынесен из ядра: СЕКЦИИ 13/13D/13B). Step D.2: бамп -v3 → -v4 — добавлен
    // core/deepseek-netsync.js (кластер сетевого дозапроса: СЕКЦИЯ 9C, O-18 фаза 2).
    // Step D.3: бамп -v4 → -v5 — добавлен core/deepseek-refetch.js (кластер
    // REFETCH/URL-гигиены: СЕКЦИЯ 10 — гард перекрёста convId, СЕКЦИЯ 10B — хелперы
    // MERGE-дозапроса). Step D.4: бамп -v5 → -v6 — добавлен core/deepseek-parse.js
    // (кластер цепочки/текста хода: СЕКЦИЯ 5 — MODEL-хелпер, СЕКЦИЯ 6 — активная цепочка,
    // СЕКЦИЯ 7 — сборка текста хода + hidden-пометки базы). Step D.5: бамп -v6 → -v7 —
    // добавлен core/deepseek-conv.js (кластер CONV ID + детектор смены чата: СЕКЦИЯ 3 —
    // getConvId, resetForNewConversation, checkConvChange и патчи history.pushState/
    // replaceState/popstate). Step D.6: бамп -v7 → -v8 — добавлен core/deepseek-emit.js
    // (кластер EMIT: СЕКЦИЯ 4 — buildDispatchSignature, emitBaseSnapshot, clipTurnText/
    // turnsSnapshot и мост ai-cm-turns-snap-request). Step D.7: бамп -v8 → -v9 —
    // добавлен core/deepseek-net.js (кластер NETWORK: СЕКЦИИ 11/12 — обёртка window.fetch
    // и обёртки XMLHttpRequest.prototype.open/send/setRequestHeader + копилки
    // lastAuthHeaders/lastHistoryUrl). Step D.8: бамп -v9 → -v10 — добавлен
    // core/deepseek-ingest.js (кластер INGEST: СЕКЦИЯ 8 — приёмка авторитетного сетевого
    // снимка history_messages, сборка turnsMap по ходам, детектор усечения цепочки с
    // тихим дозапросом и режим экспортного дозапроса). Порядок в js[] для D.5-D.8 не
    // критичен (у модулей нет нижестоящих зависимостей), но модули поставлены ПОСЛЕ
    // parse/conv и ПЕРЕД ядром — как D.4; порядок зафиксирован пинами
    // qwen-provider-wiring и deepseek-order. Для D.7 существенно, что связка модуля
    // вызывается в КОНЦЕ IIFE ядра: обёртка fetch берёт originalFetch из ядра и не
    // замыкается сама на себя.
    // Без бампа id у уже установленного расширения Chrome остался бы прежний
    // registration, js[] не перечитался бы, и ядро работало бы без модуля: связка
    // заполнила бы форвардеры немыми заглушками — диагностика, сетевой дозапрос,
    // URL-гигиена, разбор базы, детектор смены чата, EMIT, перехват сетевого слоя
    // (fetch/XHR) и приёмка истории (turnsMap/полнота базы) выключились бы целиком
    // до миграции.
    // Прежний -v9 снимается ниже (тихий catch: чистая установка его не имеет).
    if (ids.indexOf('ai-cm-deepseek-intercept-v11') === -1) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: ['ai-cm-deepseek-intercept-v10'] });
      } catch (eUnregDeepseek) { }
      await registerSafe('ai-cm-deepseek-intercept-v11', {
        id: 'ai-cm-deepseek-intercept-v11',
        matches: ['https://chat.deepseek.com/*'],
        js: ['utils/debug.js', 'core/deepseek-diag.js', 'core/deepseek-netsync.js', 'core/deepseek-refetch.js', 'core/deepseek-parse.js', 'core/deepseek-conv.js', 'core/deepseek-emit.js', 'core/deepseek-net.js', 'core/deepseek-ingest.js', 'core/deepseek-sse.js', 'core/deepseek-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
      // Версия в логе — БЕЗ «(vN)»-формы намеренно: пины Gemini
      // (gemini-oracle/overlay/archive-module) глобально проверяют отсутствие в этом файле
      // их ПРЕЖНЕГО лога (скобочная форма с номером -v10) — это их собственный сдвиг id
      // -v10 → -v11, а не признак отката DeepSeek. Версия DeepSeek в логе сохранена.
      console.log('AI Context Monitor: перехватчик DeepSeek v11 зарегистрирован (мир сайта, document_start)');
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

    // O-35: перехватчик Qwen (chat.qwen.ai). Тот же паттерн, что у остальных шести:
    // MAIN-мир, document_start, отдельный id. utils/stream-frames.js идёт ПЕРЕД
    // core/qwen-intercept.js (порядок js[] внутри регистрации соблюдается; при этом сам
    // перехватчик разрешает утилиту лениво — порядок для него не критичен, но так
    // очевиднее). Своих запросов перехватчик не делает: только обёртка нативного fetch
    // страницы (антибот bx-ua/bx-umidtoken не воспроизводится).
    if (ids.indexOf('ai-cm-qwen-intercept') === -1) {
      await registerSafe('ai-cm-qwen-intercept', {
        id: 'ai-cm-qwen-intercept',
        matches: ['https://chat.qwen.ai/*'],
        js: ['utils/debug.js', 'utils/stream-frames.js', 'core/qwen-intercept.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false
      });
      console.log('AI Context Monitor: перехватчик Qwen зарегистрирован (мир сайта, document_start)');
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
      debugLog('error', 'COUNT_TOKENS error:', err);
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
  // Шаг A.1 (security, P5): ЕДИНСТВЕННАЯ точка выхода BYOK-ключа из SW.
  // Ключ теперь недоступен контент-скриптам через chrome.storage.session (см.
  // setAccessLevel выше), поэтому они просят его сообщением. Отправителя проверяем
  // (свой origin расширения + таб), наружу уходит только сам ключ, без обёрток,
  // чтобы не логировать его случайно: '***' в логах — как и раньше.
  if (message.type === 'aiCm-get-byok-key') {
    if (!aiCmTrustedSender(sender)) { sendResponse({ key: '' }); return true; }
    // Единственный потребитель ключа — aiCmReadByokApiKey() (он же нужен COUNT_TOKENS):
    // отдельная ветка чтения здесь была бы вторым путём выхода ключа из SW (P5).
    aiCmGetByokKeyForContent().then(function (key) {
      debugLog('log', '[AI CM][byok] get-key → ' + (key ? '***' : '(пусто)'));
      sendResponse({ key: key || '' });
    }).catch(function (errK) {
      debugLog('error', 'aiCm-get-byok-key error:', errK);
      sendResponse({ key: '' });
    });
    return true; // асинхронный ответ
  }
  // Шаг A.1 (security): O3-латч already-fired переведён на SW-канал. Раньше контент-скрипты
  // читали/писали chrome.storage.session напрямую (это и открывало им доступ ко всему
  // session-хранилищу, включая BYOK-ключ). Теперь единственный владелец хранилища — SW,
  // семантика латча прежняя: ключ 'aiCmFired:service|convId' → 1, общий на профиль,
  // живёт в пределах сессии браузера.
  if (message.type === 'aiCm-latch-get') {
    if (!aiCmTrustedSender(sender)) { sendResponse({ fired: false }); return true; }
    aiCmLatchRead(message.service, message.convId).then(function (fired) {
      sendResponse({ fired: fired });
    }).catch(function (errLg) {
      debugLog('error', 'aiCm-latch-get error:', errLg);
      sendResponse({ fired: false });
    });
    return true; // асинхронный ответ
  }
  if (message.type === 'aiCm-latch-set') {
    if (!aiCmTrustedSender(sender)) { sendResponse({ ok: false }); return true; }
    aiCmLatchWrite(message.service, message.convId, true).then(function (ok) {
      sendResponse({ ok: ok });
    }).catch(function (errLs) {
      debugLog('error', 'aiCm-latch-set error:', errLs);
      sendResponse({ ok: false });
    });
    return true; // асинхронный ответ
  }
  if (message.type === 'aiCm-latch-remove') {
    if (!aiCmTrustedSender(sender)) { sendResponse({ ok: false }); return true; }
    aiCmLatchWrite(message.service, message.convId, false).then(function (ok) {
      sendResponse({ ok: ok });
    }).catch(function (errLr) {
      debugLog('error', 'aiCm-latch-remove error:', errLr);
      sendResponse({ ok: false });
    });
    return true; // асинхронный ответ
  }
  if (message.type === 'aiCm-latch-get-all') {
    if (!aiCmTrustedSender(sender)) { sendResponse({ map: {} }); return true; }
    // Гидратация локального кэша вкладки на старте: второе окно с тем же чатом видит
    // латч первой вкладки и не экспортирует повторно (v1.14.1/O3 — семантика прежняя).
    aiCmLatchAllFired().then(function (map) {
      sendResponse({ map: map });
    }).catch(function (errLa) {
      debugLog('error', 'aiCm-latch-get-all error:', errLa);
      sendResponse({ map: {} });
    });
    return true; // асинхронный ответ
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
      // M-4.5: текст и подпись кнопки — из _locales (bg_notification_*); title — бренд.
      var notifPct = String(Math.round(pct * 10) / 10);
      var notifMessage = aiCmI18nMessage('bg_notification_message',
        'Заполнение контекста ' + notifPct + '% — достигнут порог ' + T + '%',
        [notifPct, String(T)]);
      var notifButtonOpen = aiCmI18nMessage('bg_notification_button_open_chat', 'Открыть чат');
      try {
        chrome.notifications.create(notifId, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'AI Context Monitor',
          message: notifMessage,
          requireInteraction: false,
          buttons: [{ title: notifButtonOpen }]
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
    debugLog('error', '[AI CM][thresholds] checkThresholds error:', err);
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

// Шаг A.1 (P5): единственный потребитель ключа BYOK для контент-скрипта. Тонкая
// обёртка над aiCmReadByokApiKey() (тот же хелпер, что и у COUNT_TOKENS) — чтобы
// «единственная точка выхода ключа» была буквально одной функцией: второй ветки
// чтения session здесь нет.
async function aiCmGetByokKeyForContent() {
  return await aiCmReadByokApiKey();
}

// ========== Шаг A.1 (security): O3-латч already-fired за SW ==========
// Ключ 'aiCmFired:service|convId' → 1, ОБЩИЙ на профиль в chrome.storage.session.
// Дублирует построение ключа из utils/export-emit-pipeline.js:551-564 (там он для
// sessionMap контент-стороны): санация safeSeg для имён сервисов расширения — тождество
// (все siteName: gemini/chatgpt/deepseek/google_search/claude/perplexity/qwen — из
// [a-zA-Z0-9_-]), поэтому ключи SW и контента совпадают; совпадение пинуется тестом.
var AI_CM_FIRED_SESSION_PREFIX = 'aiCmFired:';
function aiCmLatchKey(service, convId) {
  return AI_CM_FIRED_SESSION_PREFIX + String(service == null ? '' : service) + '|' + String(convId == null ? '' : convId);
}

// Единственный владелец session-хранилища после Шага A.1: контент-скрипты ходят сюда
// сообщениями 'aiCm-latch-*'. Проверка отправителя — defense-in-depth: свой extension-id
// и живой таб; внешние/расширения-соседи ответа не получают.
function aiCmTrustedSender(sender) {
  try {
    if (!sender) return false;
    if (sender.id && chrome.runtime && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
    return !!(sender.tab && sender.tab.id != null);
  } catch (eSnd) { return false; }
}

function aiCmLatchRead(service, convId) {
  return new Promise(function (resolve) {
    try {
      if (!service || !convId) { resolve(false); return; }
      if (!chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== 'function') { resolve(false); return; }
      var k = aiCmLatchKey(service, convId);
      chrome.storage.session.get([k], function (d) {
        // null/undefined (ключа нет) и любое иное значение, кроме 1, — «не взведён»:
        // семантика isFiredInSession прежняя (=== 1).
        resolve(!!d && d[k] === 1);
      });
    } catch (eRead) { resolve(false); }
  });
}

function aiCmLatchWrite(service, convId, fired) {
  return new Promise(function (resolve) {
    try {
      if (!service || !convId) { resolve(false); return; }
      if (!chrome.storage || !chrome.storage.session) { resolve(false); return; }
      var k = aiCmLatchKey(service, convId);
      var done = false;
      function finish(ok) { if (!done) { done = true; resolve(ok); } }
      if (fired) {
        if (typeof chrome.storage.session.set !== 'function') { resolve(false); return; }
        var patch = {};
        patch[k] = 1; // значение ровно 1 — инвариант isFiredInSession (=== 1)
        chrome.storage.session.set(patch, function () { finish(true); });
      } else {
        if (typeof chrome.storage.session.remove !== 'function') { resolve(false); return; }
        chrome.storage.session.remove([k], function () { finish(true); });
      }
    } catch (eWrite) { resolve(false); }
  });
}

// Гидратация кэша вкладки (sessionFiredCache в core/export-manager.js): контент больше
// не читает storage.session целиком, поэтому карту отдаёт SW (только префикс латча).
function aiCmLatchAllFired() {
  return new Promise(function (resolve) {
    try {
      if (!chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== 'function') { resolve({}); return; }
      chrome.storage.session.get(null, function (all) {
        var out = {};
        try {
          for (var k in (all || {})) {
            if (k.indexOf(AI_CM_FIRED_SESSION_PREFIX) === 0) out[k] = all[k];
          }
        } catch (eCopy) { }
        resolve(out);
      });
    } catch (eAll) { resolve({}); }
  });
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
// JSDoc: name в SW отличается от одноимённого boolean-счётчика в core/state.js:110
// (общее имя, разные миры) — SW-версия это всегда Map, поэтому boolean недопустим;
// при тайпинге используется any (самый дешёвый шов между двумя мирами).
var /** @type {any} */ countTokensPending = new Map();

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

// O-22 (диагностика, только измерение): счётчик записей aiCmHistory:<host> за окно 100 мс.
// Тройной вызов svc-emit/badge-recv за 4–7 мс виден как win100ms=2/3… Код только читает
// changes/Date.now(): ни storage, ни prune, ни форма записи не меняются. Гейт тот же
// aiCmDebug, но в SW доступен только чекбокс «Подробные логи» (aiCmDebugLogs).
var aiCmHistWinDebugOn = false;
var aiCmHistWin = {};
try {
  if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
    chrome.storage.local.get(['aiCmDebugLogs'], function (d) {
      aiCmHistWinDebugOn = !!(d && d.aiCmDebugLogs === true);
    });
  }
} catch (eDarkGate) { }
function aiCmHistWinCount(changes, keys) {
  try {
    if (!aiCmHistWinDebugOn) return;
    var now = Date.now();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('aiCmHistory:') !== 0) continue;
      var w = aiCmHistWin[k];
      if (!w || (now - w.startTs) > 100) { w = { startTs: now, count: 0 }; }
      w.count++;
      aiCmHistWin[k] = w;
      var nv = (changes[k] && changes[k].newValue) || {};
      console.log('[AI CM][diag] o22-hist-onchanged key=' + k + ' ts=' + now +
        ' win100ms=' + w.count + ' convId=' + (nv.convId || '(none)') +
        ' msgs=' + ((nv.messages && nv.messages.length) || 0) +
        ' updatedAt=' + (nv.updatedAt || '(нет)'));
    }
  } catch (eWinCount) { }
}

// Ленивый вызов: content.js пишет 'aiCmHistory:<host>' → storage.onChanged будит SW
// и дочищает просрочку, не дожидаясь следующего старта браузера. Реагируем только на
// запись ключа истории в local: прочие ключи и sync-область sweep не запускают.
if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local' || !changes) return;
    if (changes.aiCmDebugLogs) aiCmHistWinDebugOn = (changes.aiCmDebugLogs.newValue === true);
    var touched = false;
    var changedKeys = Object.keys(changes);
    for (var i = 0; i < changedKeys.length; i++) {
      if (changedKeys[i].indexOf('aiCmHistory:') === 0) { touched = true; break; }
    }
    if (changedKeys.length) aiCmHistWinCount(changes, changedKeys);
    if (touched) aiCmPruneHistory();
  });
}
