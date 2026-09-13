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
const exportPdfBtn = document.getElementById('export-pdf');
const exportTxtBtn = document.getElementById('export-txt');
const exportHintEl = document.getElementById('export-hint');
const staleWarningEl = document.getElementById('stale-warning');
const exportDiagBtn = document.getElementById('export-diag');
// T1 (v1.16): индикатор источника истории (архив — первый ярус / live — второй)
const sourceEl = document.getElementById('stat-source');

// Цветовые пороги — те же, что в content.js (zoneColor: <50 зелёный, <80 жёлтый, красный)
function percentColor(p) { if (p < 50) return '#22c55e'; if (p < 80) return '#eab308'; return '#ef4444'; }

// Версия из manifest (вместо захардкоженной)
try {
  var manifest = chrome.runtime.getManifest();
  if (versionEl && manifest.version) versionEl.textContent = 'v' + manifest.version;
} catch (e) {}

// v1.18 (P1): открытие privacy.html во внешней вкладке
// Страница политики конфиденциальности — самодостаточный HTML внутри расширения,
// открывается через chrome.runtime.getURL, чтобы не уводить popup-контекст.
var privacyLink = document.getElementById('privacy-link');
privacyLink && privacyLink.addEventListener('click', function (e) {
  e.preventDefault();
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('privacy/privacy.html') });
  } catch (ePrivacy) {
    console.warn('[privacy] не удалось открыть политику конфиденциальности:', ePrivacy);
  }
});

// v1.19 (M-6): открытие руководства (docs/index.html) во внешней вкладке
// Страница руководства входит в пакет расширения (docs/ больше не исключается из ZIP),
// поэтому chrome.runtime.getURL('docs/index.html') валиден и в установленном расширении.
var helpLink = document.getElementById('help-link');
helpLink && helpLink.addEventListener('click', function (e) {
  e.preventDefault();
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('docs/index.html') });
  } catch (eHelp) {
    console.warn('[help] не удалось открыть руководство:', eHelp);
  }
});

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

// ========== M-7: BYOK-ключ — ТОЛЬКО chrome.storage.session ==========
// Аудит фазы 3: ключ Google AI Studio лежал в chrome.storage.local открытым текстом
// (на диске). Теперь источник истины — chrome.storage.session, ключ
// 'aiCmApiKeySession': ключ живёт в памяти сессии до перезапуска браузера.
// Прежние plaintext-имена ключа в local стираются немедленно при каждом сохранении
// и при открытии настроек; псевдо-шифрование в local не применяется.
var AI_CM_BYOK_SESSION_KEY = 'aiCmApiKeySession';
// Известные имена plaintext-ключа BYOK прежних версий (первое — имя из прежних версий).
var AI_CM_BYOK_LEGACY_KEYS = [
  'ai_cm_gemini_api_key',
  'ai_cm_api_key',
  'ai_cm_byok_key',
  'aiCmGeminiApiKey',
  'aiCmApiKey',
  'gemini_api_key'
];
var apiKeyStatusEl = document.getElementById('api-key-status');
var removeApiKeyBtn = document.getElementById('api-key-remove');

// Первое непустое значение среди известных legacy-имён ключа (иначе '').
function aiCmFirstLegacyByokKey(data) {
  for (var iLk = 0; iLk < AI_CM_BYOK_LEGACY_KEYS.length; iLk++) {
    var vLk = data ? data[AI_CM_BYOK_LEGACY_KEYS[iLk]] : null;
    if (typeof vLk === 'string' && vLk) return vLk;
  }
  return '';
}

// Стереть plaintext-ключи BYOK из chrome.storage.local — по всем известным именам.
function aiCmPurgeLegacyByokKeys() {
  try {
    if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.remove !== 'function') return;
    chrome.storage.local.remove(AI_CM_BYOK_LEGACY_KEYS);
  } catch (ePurge) { }
}

// ========== M-4 (фаза 3) / M-4.2: i18n — строки интерфейса из _locales ==========
// Динамические строки страницы настроек берутся из chrome.i18n.getMessage
// (ключи options_* есть в ru и en). chrome.i18n недоступен (юнит-тесты, отладочный
// контекст) → прежний русский фолбэк: внешнее поведение и тексты без расширения
// байтово прежние. $1..$9 в сообщении локали подставляются substitutions.
function aiCmI18nMessage(key, fallback, substitutions) {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
      var message = substitutions ? chrome.i18n.getMessage(key, substitutions) : chrome.i18n.getMessage(key);
      if (message) return message;
    }
  } catch (eMessage) { }
  return fallback;
}

// Статус-строка — по фактическому наличию ключа в session.
function aiCmRenderApiKeyStatus(hasKey) {
  if (!apiKeyStatusEl) return;
  apiKeyStatusEl.textContent = hasKey
    ? aiCmI18nMessage('options_byok_status_set', 'Ключ: задан')
    : aiCmI18nMessage('options_byok_status_unset', 'Ключ: не задан');
}

// Сохранение ключа: пишем ТОЛЬКО в session; local очищается от plaintext-имён.
function aiCmSaveByokKey(value) {
  try {
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.set === 'function') {
      var patch = {};
      patch[AI_CM_BYOK_SESSION_KEY] = value;
      chrome.storage.session.set(patch);
    }
  } catch (eSet) { }
  aiCmPurgeLegacyByokKeys();
}

// Загрузка ключа: поле и статус — по факту session. Plaintext прежних версий в
// local — переходный фолбэк: переносим в session и стираем с диска (ключ не теряем).
function aiCmLoadByokKey() {
  try {
    if (!chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== 'function') {
      aiCmRenderApiKeyStatus(false);
      return;
    }
    var handled = false;
    function onSession(data) {
      if (handled) return;
      handled = true;
      var key = data ? data[AI_CM_BYOK_SESSION_KEY] : '';
      if (typeof key === 'string' && key) {
        if (apiKeyInput) apiKeyInput.value = key;
        aiCmRenderApiKeyStatus(true);
        return;
      }
      aiCmRenderApiKeyStatus(false);
      try {
        chrome.storage.local.get(AI_CM_BYOK_LEGACY_KEYS, function (dl) {
          var legacy = aiCmFirstLegacyByokKey(dl);
          if (!legacy) return;
          aiCmSaveByokKey(legacy);
          if (apiKeyInput) apiKeyInput.value = legacy;
          aiCmRenderApiKeyStatus(true);
          console.log('[AI CM][byok] migrated plaintext→session');
        });
      } catch (eLeg) { }
    }
    // Chrome отдаёт промис, если колбэк не передан; колбэк-форма — для прежних моков.
    var maybePromise = chrome.storage.session.get([AI_CM_BYOK_SESSION_KEY], onSession);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(onSession, function () {
        if (!handled) { handled = true; aiCmRenderApiKeyStatus(false); }
      });
    }
  } catch (eLoad) { aiCmRenderApiKeyStatus(false); }
}

// BYOK: флаг точного подсчёта остаётся в chrome.storage.local (ключ — в session, M-7).
chrome.storage.local.get(['ai_cm_exact_token_count'], function (data) {
  if (data.ai_cm_exact_token_count !== undefined) exactCountCheckbox.checked = data.ai_cm_exact_token_count;
});
aiCmLoadByokKey();

modelSelect && modelSelect.addEventListener('change', function () {
  chrome.storage.sync.set({ selectedModel: modelSelect.value });
});

// H20: дебаунс поля «Лимит контекста» (~500мс) до записи в chrome.storage.sync.
// Иначе каждый keystroke уходит отдельной записью, и промежуточное «5» на миг
// становится лимитом 5% от Авто-порога (6 400) → ложное уведомление
// «Заполнение 400.4%» (25 624 / 6 400). Пустое поле → null (тоже по дебаунсу).
// Кнопка «Авто» (reset-limit) и change с пустым полем пишут МГНОВЕННО и гасят таймер.
var CUSTOM_LIMIT_DEBOUNCE_MS = 500;
var customLimitWriteTimer = null;

function aiCmCancelCustomLimitWrite() {
  if (customLimitWriteTimer !== null) {
    clearTimeout(customLimitWriteTimer);
    customLimitWriteTimer = null;
  }
}

customLimit && customLimit.addEventListener('input', function () {
  aiCmCancelCustomLimitWrite();
  customLimitWriteTimer = setTimeout(function () {
    customLimitWriteTimer = null;
    var value = customLimit.value ? parseInt(customLimit.value) : null;
    chrome.storage.sync.set({ customLimit: value });
  }, CUSTOM_LIMIT_DEBOUNCE_MS);
});

customLimit && customLimit.addEventListener('change', function () {
  if (!customLimit.value) {
    aiCmCancelCustomLimitWrite(); // H20: пустое поле — мгновенный null, без дебаунса
    customLimit.placeholder = aiCmI18nMessage('options_limit_placeholder', 'Авто');
    chrome.storage.sync.set({ customLimit: null });
  }
});

showWidget && showWidget.addEventListener('change', function () {
  chrome.storage.sync.set({ showWidget: showWidget.checked });
});

// v31: чекбокс «Подробные логи» (aiCmDebugLogs в chrome.storage.local, по умолчанию ВЫКЛ)
const debugLogsCheckbox = document.getElementById('debugLogs');
chrome.storage.local.get(['aiCmDebugLogs'], function (data) {
  if (debugLogsCheckbox) debugLogsCheckbox.checked = data.aiCmDebugLogs === true;
});
debugLogsCheckbox && debugLogsCheckbox.addEventListener('change', function () {
  chrome.storage.local.set({ aiCmDebugLogs: debugLogsCheckbox.checked });
});

// Фаза B: проактивные пороги (aiCmProactive / aiCmProactiveNotify, chrome.storage.local).
// Дефолты: aiCmProactive = ON, aiCmProactiveNotify = OFF.
const proactiveCheckbox = document.getElementById('aiCmProactive');
const proactiveNotifyCheckbox = document.getElementById('aiCmProactiveNotify');
chrome.storage.local.get(['aiCmProactive', 'aiCmProactiveNotify'], function (data) {
  if (proactiveCheckbox) proactiveCheckbox.checked = !(data && data.aiCmProactive === false);
  if (proactiveNotifyCheckbox) proactiveNotifyCheckbox.checked = !!(data && data.aiCmProactiveNotify === true);
});
proactiveCheckbox && proactiveCheckbox.addEventListener('change', function () {
  chrome.storage.local.set({ aiCmProactive: proactiveCheckbox.checked });
});
proactiveNotifyCheckbox && proactiveNotifyCheckbox.addEventListener('change', function () {
  chrome.storage.local.set({ aiCmProactiveNotify: proactiveNotifyCheckbox.checked });
});
// Синхронизация UI с внешними изменениями (в т.ч. между попапами)
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    if (changes.aiCmProactive && proactiveCheckbox) {
      proactiveCheckbox.checked = changes.aiCmProactive.newValue !== false;
    }
    if (changes.aiCmProactiveNotify && proactiveNotifyCheckbox) {
      proactiveNotifyCheckbox.checked = changes.aiCmProactiveNotify.newValue === true;
    }
  });
} catch (e) {}

// ========== S2: НАСТРАИВАЕМЫЕ ПРОАКТИВНЫЕ ПОРОГИ ==========
// 'aiCmProactiveThresholds' = [low, medium, high] (1–100, строго возрастают) —
// chrome.storage.local. Дефолт [70,85,95]. При битом вводе/сохранённом значении —
// фолбэк на дефолт и лог в консоль.
const thrLowInput = document.getElementById('aiCmProactiveLow');
const thrMedInput = document.getElementById('aiCmProactiveMedium');
const thrHighInput = document.getElementById('aiCmProactiveHigh');
const PROACTIVE_THRESHOLDS_DEFAULT = [70, 85, 95];

// Валидация: три числа 1–100, строго возрастают (low < medium < high).
// Возвращает нормализованный массив чисел или null (битый ввод).
function validProactiveThresholds(arr) {
  try {
    if (!Array.isArray(arr) || arr.length < 3) return null;
    var out = [];
    for (var i = 0; i < 3; i++) {
      var n = parseInt(arr[i], 10);
      if (isNaN(n) || n < 1 || n > 100) return null;
      out.push(n);
    }
    if (!(out[0] < out[1] && out[1] < out[2])) return null;
    return out;
  } catch (e) { return null; }
}
function readProactiveThresholdInputs() {
  return [
    thrLowInput ? thrLowInput.value : undefined,
    thrMedInput ? thrMedInput.value : undefined,
    thrHighInput ? thrHighInput.value : undefined
  ];
}
function fillProactiveThresholdInputs(arr) {
  if (!arr || arr.length < 3) return;
  if (thrLowInput) thrLowInput.value = arr[0];
  if (thrMedInput) thrMedInput.value = arr[1];
  if (thrHighInput) thrHighInput.value = arr[2];
}
function applyProactiveThresholdInputs() {
  try {
    var raw = readProactiveThresholdInputs();
    var t = validProactiveThresholds(raw);
    if (!t) {
      console.warn('[AI CM][thresholds] битый ввод порогов → фолбэк [70,85,95]', raw);
      t = PROACTIVE_THRESHOLDS_DEFAULT;
    }
    fillProactiveThresholdInputs(t);
    chrome.storage.local.set({ aiCmProactiveThresholds: t });
  } catch (eP) { }
}

// Загрузка сохранённых порогов; битое сохранённое значение — дефолт в поля + лог.
try {
  chrome.storage.local.get(['aiCmProactiveThresholds'], function (data) {
    try {
      var hasStored = data && data.aiCmProactiveThresholds !== undefined;
      var t = validProactiveThresholds(hasStored ? data.aiCmProactiveThresholds : null);
      if (hasStored && !t) {
        console.warn('[AI CM][thresholds] битые сохранённые aiCmProactiveThresholds → дефолт [70,85,95]', data.aiCmProactiveThresholds);
      }
      fillProactiveThresholdInputs(t || PROACTIVE_THRESHOLDS_DEFAULT);
    } catch (eInit) { }
  });
} catch (eLoad) { }
// 'change' (blur/Enter/спиннер) — как у поля автоэкспорта
[thrLowInput, thrMedInput, thrHighInput].forEach(function (el) {
  if (!el) return;
  el.addEventListener('change', applyProactiveThresholdInputs);
  el.addEventListener('blur', applyProactiveThresholdInputs);
});
// Внешний апдейт порогов (другое окно options) — только если поле не в фокусе
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'local' && changes.aiCmProactiveThresholds) {
      var t2 = validProactiveThresholds(changes.aiCmProactiveThresholds.newValue);
      if (!t2) return; // битое внешнее значение игнорируем — остаются текущие поля
      if (document.activeElement === thrLowInput || document.activeElement === thrMedInput || document.activeElement === thrHighInput) return;
      fillProactiveThresholdInputs(t2);
    }
  });
} catch (e) { }

// BYOK (M-7): сохранение API-ключа — ТОЛЬКО chrome.storage.session ('aiCmApiKeySession').
// chrome.storage.local.set с ключом не вызывается никогда; прежние plaintext-имена
// в local удаляются немедленно (см. aiCmSaveByokKey).
apiKeyInput && apiKeyInput.addEventListener('input', function () {
  aiCmSaveByokKey(apiKeyInput.value);
  aiCmRenderApiKeyStatus(!!apiKeyInput.value);
});

// BYOK (M-7): «Убрать ключ» — очищает ключ из памяти сессии (и поле ввода).
removeApiKeyBtn && removeApiKeyBtn.addEventListener('click', function () {
  try {
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.remove === 'function') {
      chrome.storage.session.remove([AI_CM_BYOK_SESSION_KEY]);
    }
  } catch (eRm) { }
  aiCmPurgeLegacyByokKeys();
  if (apiKeyInput) apiKeyInput.value = '';
  aiCmRenderApiKeyStatus(false);
});

// BYOK: показать/скрыть ключ
toggleApiKeyBtn && toggleApiKeyBtn.addEventListener('click', function () {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    toggleApiKeyBtn.textContent = '\uD83D\uDE48';
  } else {
    apiKeyInput.type = 'password';
    toggleApiKeyBtn.textContent = '\uD83D\uDC41';
  }
});

// BYOK: сохранение флага точного подсчёта
exactCountCheckbox && exactCountCheckbox.addEventListener('change', function () {
  chrome.storage.local.set({ ai_cm_exact_token_count: exactCountCheckbox.checked });
});

// ========== v1.8: АВТОЭКСПОРТ ПРИ ПОРОГЕ (настройки) ==========
// aiCmAutoExport (bool, по умолчанию ВЫКЛ), aiCmAutoExportPct (1–100, по умолчанию 90),
// aiCmAutoExportFmt ('txt'|'md'|'json', по умолчанию 'txt') — всё в chrome.storage.local.
// v1.18: фича общая для Gemini и Google Search AI (подпись секции), формат — общий селектор.
const autoExportCheckbox = document.getElementById('aiCmAutoExport');
const autoExportPctInput = document.getElementById('aiCmAutoExportPct');
const autoExportFmtSelect = document.getElementById('aiCmAutoExportFmt');

// v1.18: 'txt' | 'md' | 'json' — битое/чужое значение → 'txt' (прежнее поведение 1:1)
function normalizeAutoExportFmt(v) {
  return (v === 'md' || v === 'json') ? v : 'txt';
}

function clampAutoExportPct(v) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return null;
  if (n < 1) n = 1;   // v65: порог автоэкспорта разрешён 1–100 (было 50–99)
  if (n > 100) n = 100;
  return n;
}

// v1.19.2 (M-13a): ЕДИНСТВЕННАЯ форма записи настроек автоэкспорта — ПОЛНЫЙ объект
// {enabled, pct, fmt} из текущих значений формы. Частичная запись запрещена: сохранение
// одного порога теряло флаг enabled в storage (13.09 17:33 — галка нарисована включённой,
// а content.js читал enabled=false и молчал), после чего автоэкспорт не стрелял вовсе.
var AI_CM_AUTO_EXPORT_PCT_DEFAULT = 90;

function aiCmAutoExportWriteFull() {
  try {
    var pctFull = clampAutoExportPct(autoExportPctInput.value);
    pctFull = (pctFull === null) ? AI_CM_AUTO_EXPORT_PCT_DEFAULT : pctFull;
    autoExportPctInput.value = pctFull;
    chrome.storage.local.set({
      aiCmAutoExport: autoExportCheckbox.checked === true,
      aiCmAutoExportPct: pctFull,
      aiCmAutoExportFmt: normalizeAutoExportFmt(autoExportFmtSelect.value)
    });
  } catch (eFull) {}
}

// v1.19.2 (M-13b): инициализация формы — СТРОГО из chrome.storage (без дефолтов, расходящихся
// с хранилищем). Если ключа/валидного значения в storage нет, нормализованное значение сразу
// фиксируется полным объектом — форма и хранилище не расходятся ни в одном поле.
try {
  chrome.storage.local.get(['aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt'], function (data) {
    try {
      data = data || {};
      if (autoExportCheckbox) autoExportCheckbox.checked = data.aiCmAutoExport === true;
      var pctInit = clampAutoExportPct(data.aiCmAutoExportPct);
      if (autoExportPctInput) autoExportPctInput.value = (pctInit === null) ? AI_CM_AUTO_EXPORT_PCT_DEFAULT : pctInit;
      if (autoExportFmtSelect) autoExportFmtSelect.value = normalizeAutoExportFmt(data.aiCmAutoExportFmt);
      var needsNormalize = (typeof data.aiCmAutoExport !== 'boolean') ||
        (pctInit === null) ||
        (normalizeAutoExportFmt(data.aiCmAutoExportFmt) !== data.aiCmAutoExportFmt);
      if (needsNormalize) aiCmAutoExportWriteFull();
    } catch (eInit) {}
  });
} catch (eLoad) {}

// v1.19.2 (M-13a): любой из трёх контролов пишет ПОЛНЫЙ объект — enabled не теряется
autoExportCheckbox && autoExportCheckbox.addEventListener('change', aiCmAutoExportWriteFull);
// 'change' срабатывает и при ручном вводе (blur/Enter), и при кликах по стрелкам спиннера
autoExportPctInput && autoExportPctInput.addEventListener('change', aiCmAutoExportWriteFull);
autoExportPctInput && autoExportPctInput.addEventListener('blur', aiCmAutoExportWriteFull);
autoExportFmtSelect && autoExportFmtSelect.addEventListener('change', aiCmAutoExportWriteFull);

// v31: синхронизация чекбокса «Подробные логи» при внешнем изменении ключа
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'local' && changes.aiCmDebugLogs) {
      debugLogsCheckbox.checked = changes.aiCmDebugLogs.newValue === true;
    }
    // v1.8: внешний апдейт порога — пишем в поле ТОЛЬКО если оно не в фокусе
    if (areaName === 'local' && changes.aiCmAutoExportPct && autoExportPctInput &&
        document.activeElement !== autoExportPctInput) {
      var pct = clampAutoExportPct(changes.aiCmAutoExportPct.newValue);
      autoExportPctInput.value = (pct === null) ? 90 : pct;
    }
  });
} catch (e) {}

document.getElementById('reset-limit') && document.getElementById('reset-limit').addEventListener('click', function () {
  aiCmCancelCustomLimitWrite(); // H20: гасим висящий дебаунс — сброс мгновенный
  customLimit.value = '';
  customLimit.placeholder = aiCmI18nMessage('options_limit_placeholder', 'Авто');
  chrome.storage.sync.set({ customLimit: null });
});

// H8: чистая функция-предикат «на странице реального диалога». Несмотря на имя,
// isChatHome() возвращает true, когда открыт именно диалог (разговор), и false на
// home-страницах (диалога нет) и для неизвестных хостов. Это гейт для
// stale-предупреждения ниже: на home DOM-эвристика content.js ложно взводит stale.
var chatDialogPathBySite = {
  'chatgpt': /\/(c|g|share)\//,
  'gemini': /\/app\//,
  'claude': /\/chat\//,
  'perplexity': /\/(search|follow)\//,
  'deepseek': /\/a\//
};

function detectChatSite(hostname) {
  if (!hostname) return null;
  var host = String(hostname).toLowerCase();
  if (host.indexOf('chatgpt.com') !== -1) return 'chatgpt';
  if (host.indexOf('gemini.google.com') !== -1) return 'gemini';
  if (host.indexOf('claude.ai') !== -1) return 'claude';
  if (host.indexOf('perplexity.ai') !== -1) return 'perplexity';
  if (host.indexOf('chat.deepseek.com') !== -1) return 'deepseek';
  return null;
}

function isChatHome(hostname, pathname) {
  var site = detectChatSite(hostname);
  if (!site) return false; // неизвестный хост → false (поведение как прежде)
  return chatDialogPathBySite[site].test(String(pathname || ''));
}

function updateStatsFromState(state, tabHost, tabPath, fromCache) {
  siteEl.textContent = siteLabels[state.site] || state.site || '—';
  modelEl.textContent = state.model || '—';
  tokensEl.textContent = (typeof state.tokens === 'number') ? state.tokens.toLocaleString() : '—';
  limitEl.textContent = (typeof state.limit === 'number') ? state.limit.toLocaleString() : '—';
  var p = state.percent || 0;
  percentEl.textContent = p + '%';
  percentEl.style.color = percentColor(p);
  // T1 (v1.16): источник истории — архив (первый ярус) или live (второй)
  // M-4.3: показанный из кэша прошлой беседы снапшот не выдаётся за live — метка
  // источника подменяется честной («кэш (прошлая беседа)»); у свежего снапшота
  // остаётся его собственная sourceLabel.
  if (sourceEl) {
    sourceEl.textContent = fromCache
      ? aiCmI18nMessage('options_source_cache', 'кэш (прошлая беседа)')
      : (state.sourceLabel || '—');
  }
  updateStaleWarning(state, tabHost, tabPath);
}

function updateStaleWarning(state, tabHost, tabPath) {
  if (!staleWarningEl) return;
  // H8: stale липнет на home-страницах (диалог не открыт → baseSeen=false, но
  // DOM-эвристика >0). Предупреждение показываем ТОЛЬКО когда открыт реальный
  // диалог; на home и неизвестных хостах (isChatHome() === false) — display:none.
  var showStale = !!(state && state.stale === true && isChatHome(tabHost, tabPath));
  if (showStale) {
    // M-4.2: фолбэк-название сайта и текст предупреждения — ключи options_*
    var siteLabel = siteLabels[state.site] || state.site || aiCmI18nMessage('options_stale_site_fallback', 'сайтом');
    staleWarningEl.textContent = aiCmI18nMessage('options_stale_warning', 'Интеграция с ' + siteLabel + ' могла устареть: сайт не отдаёт данные диалога. Проверьте обновление расширения.', [siteLabel]);
    staleWarningEl.style.display = 'block';
  } else {
    staleWarningEl.style.display = 'none';
    staleWarningEl.textContent = '';
  }
}

function showNoData(message) {
  siteEl.textContent = message || aiCmI18nMessage('options_no_data', 'Нет данных');
  modelEl.textContent = '—';
  tokensEl.textContent = '—';
  limitEl.textContent = '—';
  percentEl.textContent = '—';
  percentEl.style.color = '#8888aa';
}

// v31: пометка времени для кэша «данные от HH:MM»
function formatTime(ts) {
  try {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  } catch (e) { return '??:??'; }
}

// v31: последний показанный снапшот своего хоста — используется, если свежих данных нет
var cachedState = null;

// Загружаем статистику при открытии — через chrome.storage.local (aiCmState + aiCmState:<host>)
function loadStats() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        showNoData(aiCmI18nMessage('options_no_active_tab', 'Нет активной вкладки'));
        return;
      }

      // chrome:// и chrome-extension:// — сразу нет
      if (tab.url.indexOf('chrome://') === 0 || tab.url.indexOf('chrome-extension://') === 0) {
        showNoData(aiCmI18nMessage('options_open_supported_site', 'Откройте поддерживаемый сайт'));
        return;
      }

      var tabHost = '';
      var tabPath = '';
      try {
        var activeTabUrl = new URL(tab.url);
        tabHost = activeTabUrl.hostname;
        tabPath = activeTabUrl.pathname;
      } catch (e) {}

      // v31: per-host ключ приоритетен; глобальный — только если он про этот же хост
      chrome.storage.local.get(['aiCmState', 'aiCmState:' + tabHost], function (data) {
        var state = data['aiCmState:' + tabHost] || null;
        if (!state && data.aiCmState && data.aiCmState.host === tabHost) {
          state = data.aiCmState;
        }
        if (state) {
          cachedState = state;
          updateStatsFromState(state, tabHost, tabPath);
        } else if (cachedState && cachedState.host === tabHost) {
          // v31: свежих данных нет — НЕ сбрасываем экран, показываем последний кэш своего хоста
          // M-4.3: и честно помечаем его кэшем (fromCache=true) — не «live (сеть/DOM)»
          updateStatsFromState(cachedState, tabHost, tabPath, true);
          var cachedAt = formatTime(cachedState.updatedAt);
          siteEl.textContent += aiCmI18nMessage('options_data_from', ' · данные от ' + cachedAt, [cachedAt]);
        } else {
          showNoData(aiCmI18nMessage('options_open_supported_site', 'Откройте поддерживаемый сайт'));
        }
      });
    });
  } catch (e) {
    showNoData(aiCmI18nMessage('options_reload_page', 'Обновите страницу'));
  }
}

// Live-обновление при изменении aiCmState / aiCmState:<host> (v31)
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    var candidates = [];
    if (changes.aiCmState && changes.aiCmState.newValue) candidates.push(changes.aiCmState.newValue);
    for (var key in changes) {
      if (key.indexOf('aiCmState:') === 0 && changes[key] && changes[key].newValue) {
        candidates.push(changes[key].newValue);
      }
    }
    if (!candidates.length) return;
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      var tabHost = '';
      var tabPath = '';
      try {
        if (tab && tab.url) {
          var activeTabUrl = new URL(tab.url);
          tabHost = activeTabUrl.hostname;
          tabPath = activeTabUrl.pathname;
        }
      } catch (e) {}
      var best = null;
      for (var i = 0; i < candidates.length; i++) {
        var s = candidates[i];
        if (s.host === tabHost && (!best || (s.updatedAt || 0) > (best.updatedAt || 0))) best = s;
      }
      if (best) {
        cachedState = best;
        updateStatsFromState(best, tabHost, tabPath);
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
  if (!exportMdBtn || !exportJsonBtn || !exportPdfBtn) return;
  var enabled = !!(cachedHistory && cachedHistory.host === currentTabHost);
  exportMdBtn.disabled = !enabled;
  exportJsonBtn.disabled = !enabled;
  exportPdfBtn.disabled = !enabled;
  if (exportTxtBtn) exportTxtBtn.disabled = !enabled;
  if (exportHintEl) {
    // v31: при наличии кэша того же хоста — пометка времени, как в статистике
    // M-4.2: обе ветки — ключи options_* (фолбэк — прежний русский текст)
    if (enabled) {
      var exportAt = formatTime(cachedHistory.updatedAt);
      exportHintEl.textContent = aiCmI18nMessage('options_ready_to_export', 'Готово к экспорту · данные от ' + exportAt, [exportAt]);
    } else {
      exportHintEl.textContent = aiCmI18nMessage('options_open_supported_site', 'Откройте поддерживаемый сайт');
    }
  }
}

// v1.8: сборщики вынесены в utils/export-text-builders.js — здесь только делегирование
function buildTxtText(hist) {
  return window.AiCmExportBuilders
    ? window.AiCmExportBuilders.buildTxtFromHistory(hist || cachedHistory)
    : '';
}

function refreshExportState() {
  getActiveTabHost(function (host) {
    // v31: per-host ключ приоритетен; глобальный — только если он про этот же хост
    chrome.storage.local.get(['aiCmHistory', 'aiCmHistory:' + host], function (data) {
      var hist = data['aiCmHistory:' + host] || null;
      if (!hist && data.aiCmHistory && data.aiCmHistory.host === host) {
        hist = data.aiCmHistory;
      }
      cachedHistory = hist;
      updateExportButtons();
    });
  });
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function buildFileName(ext, hist) {
  hist = hist || cachedHistory;
  var d = new Date();
  var stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    '-' + pad2(d.getHours()) + '-' + pad2(d.getMinutes());
  var site = (hist && hist.site) || 'chat';
  var model = (hist && hist.model) || 'model';
  var safeSite = String(site).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'chat';
  var safeModel = String(model).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  // v63: база подтверждена только sanity-фолбэком (low confidence) — префикс в имени файла
  var lowConfPrefix = (hist && hist.isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';
  return lowConfPrefix + 'ai-context-monitor-' + safeSite + '-' + safeModel + '-' + stamp + '.' + ext;
}

function downloadBlob(content, fileName, mimeType) {
  // v1.8: общий downloadBlob из utils/export-text-builders.js
  if (window.AiCmExportBuilders && window.AiCmExportBuilders.downloadBlob) {
    window.AiCmExportBuilders.downloadBlob(content, fileName, mimeType);
  }
}

function getPlatform(hist) {
  hist = hist || cachedHistory;
  var site = hist && hist.site;
  return (siteLabels[site] || site || 'AI Chat');
}

function buildJsonText(hist) {
  hist = hist || cachedHistory;
  var exportedAt = new Date().toISOString();
  return JSON.stringify({
    platform: getPlatform(hist),
    model: (hist && hist.model) || '',
    exportedAt: exportedAt,
    tokens: (hist && typeof hist.tokens === 'number') ? hist.tokens : 0,
    limit: (hist && typeof hist.limit === 'number') ? hist.limit : 0,
    percent: (hist && typeof hist.percent === 'number') ? hist.percent : 0,
    messages: (hist && Array.isArray(hist.messages)) ? hist.messages : []
  }, null, 2);
}

function buildMdText(hist) {
  // v1.8: общий сборщик из utils/export-text-builders.js
  return window.AiCmExportBuilders
    ? window.AiCmExportBuilders.buildMdFromHistory(hist || cachedHistory, getPlatform(hist))
    : '';
}

// v1.13.1: атрибуция ручного экспорта — снимок ТОЛЬКО текущего convId активной вкладки.
// Спрашиваем content-скрипт вкладки; он строит снимок по ТЕКУЩЕМУ convId и текущей базе
// (сразу после SPA-перехода база ещё пуста → файл-заглушка). НИКОГДА чужая история.
function getCurrentConvSnapshot(cb) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.id) { cb(null); return; }
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'aiCmExportCurrent' }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.data) { cb(null); return; }
          cb(resp.data);
        });
      } catch (eS) { cb(null); }
    });
  } catch (eQ) { cb(null); }
}

// v1.13.1: convId известен → экспортируем снимок текущего разговора (даже пустой);
// convId пуст / content-скрипт недоступен → прежнее host-level поведение (cachedHistory).
function pickExportHistory(snap) {
  if (snap && snap.convId) return snap;
  return cachedHistory;
}

exportMdBtn && exportMdBtn.addEventListener('click', function () {
  if (exportMdBtn.disabled) return;
  getCurrentConvSnapshot(function (snap) {
    var hist = pickExportHistory(snap);
    if (!hist) return;
    downloadBlob(buildMdText(hist), buildFileName('md', hist), 'text/markdown');
  });
});

exportJsonBtn && exportJsonBtn.addEventListener('click', function () {
  if (exportJsonBtn.disabled) return;
  getCurrentConvSnapshot(function (snap) {
    var hist = pickExportHistory(snap);
    if (!hist) return;
    downloadBlob(buildJsonText(hist), buildFileName('json', hist), 'application/json');
  });
});

exportTxtBtn && exportTxtBtn.addEventListener('click', function () {
  if (exportTxtBtn.disabled) return;
  // v54-4: BOM в начале txt — Windows-просмотрщики (Блокнот и др.) читают UTF-8;
  // прочие форматы (md/json/pdf) не меняем.
  getCurrentConvSnapshot(function (snap) {
    var hist = pickExportHistory(snap);
    if (!hist) return;
    var txt = buildTxtText(hist);
    try { if (txt.charAt(0) !== '\uFEFF') txt = '\uFEFF' + txt; } catch (eB) {}
    downloadBlob(txt, buildFileName('txt', hist), 'text/plain;charset=utf-8');
  });
});

// ========== ЭКСПОРТ PDF: ПЕЧАТНАЯ ФОРМА ==========
// Кнопка «Сохранить .pdf» открывает print/print.html с id активной вкладки.
// Страница сама рендерит историю (utils/markdown.js) и вызывает window.print(),
// а пользователь сохраняет PDF штатным диалогом Chrome («Сохранить как PDF»).
exportPdfBtn && exportPdfBtn.addEventListener('click', function () {
  if (exportPdfBtn.disabled) return;
  getActiveTab(function (tab) {
    if (!tab || !tab.id) return;
    var url = chrome.runtime.getURL('print/print.html') + '?tab=' + tab.id;
    try {
      chrome.tabs.create({ url: url });
    } catch (e) {
      console.warn('[export-pdf] не удалось открыть печатную форму:', e);
    }
  });
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

// Live-обновление доступности кнопок при изменении aiCmHistory / aiCmHistory:<host> (v31)
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    var hist = null;
    if (changes.aiCmHistory && changes.aiCmHistory.newValue) hist = changes.aiCmHistory.newValue;
    for (var key in changes) {
      if (key.indexOf('aiCmHistory:') === 0 && changes[key] && changes[key].newValue) {
        var v = changes[key].newValue;
        if (!hist || (v.updatedAt || 0) > (hist.updatedAt || 0)) hist = v;
      }
    }
    if (!hist) return;
    // host активной вкладки мог не успеть обновиться — перезапрашиваем
    getActiveTabHost(function () {
      if (hist.host === currentTabHost) cachedHistory = hist;
      updateExportButtons();
    });
  });
} catch (e) {}

// ========== T1 (v1.16): АРХИВЫ — ПЕРВЫЙ ЯРУС ИСТОРИИ ==========
// Импорт ЛОКАЛЬНЫХ файлов экспорта через FileReader: внешних fetch нет, manifest не
// меняется. Разбор — utils/archive-import.js (те же парсеры, что в тестах).
// Запись: aiCmArchive:<convId> (ходы) + aiCmConvSource:<convId> (ярлык источника для
// попапа/виджета) в chrome.storage.local. Применяет архив к чату content-скрипт
// (событие ai-cm-archive-restore в MAIN-мир Gemini-перехватчика).
const archiveFileInput = document.getElementById('archive-file');
const archiveImportBtn = document.getElementById('archive-import');
const archiveRefreshBtn = document.getElementById('archive-refresh');
const archiveStatusEl = document.getElementById('archive-status');
const archiveListEl = document.getElementById('archive-list');

// Защита от случайного выбора огромной папки: за один импорт не больше N файлов.
const AI_ARCHIVE_MAX_FILES = 20;

function aiCmArchiveApi() {
  try {
    return (typeof window !== 'undefined' && window.AiCmArchiveImport) ? window.AiCmArchiveImport : null;
  } catch (e) { return null; }
}

function aiCmSetArchiveStatus(text, isError) {
  if (!archiveStatusEl) return;
  archiveStatusEl.textContent = text || '';
  archiveStatusEl.style.color = isError ? '#ef4444' : '';
}

// ---- чистая функция: записи архива → патч chrome.storage.local ----
// Оба ключа T1 пишутся вместе: aiCmArchive:<convId> (данные) и
// aiCmConvSource:<convId> (ярлык источника; попап/виджет читают только его).
function buildArchiveStoragePatch(records, fileName) {
  const API = aiCmArchiveApi();
  const patch = {};
  if (!API || !Array.isArray(records)) return patch;
  records.forEach(function (rec) {
    if (!rec || !rec.convId) return;
    patch[API.archiveStorageKey(rec.convId)] = rec;
    patch[API.convSourceStorageKey(rec.convId)] = API.buildConvSourceRecord(rec, { fileName: fileName });
  });
  return patch;
}

// ---- чтение выбранных файлов FileReader'ом (по одному, последовательно) ----
// onDone(null, report) | onDone(errorString)
function aiCmImportArchiveFiles(files, onDone) {
  const API = aiCmArchiveApi();
  if (!API) { onDone(aiCmI18nMessage('options_archive_module_missing', 'модуль импорта не загружен (utils/archive-import.js)')); return; }
  const list = Array.prototype.slice.call(files || []).filter(function (f) { return !!f; }).slice(0, AI_ARCHIVE_MAX_FILES);
  if (!list.length) { onDone(aiCmI18nMessage('options_archive_no_files', 'файлы не выбраны')); return; }

  const report = {
    files: 0, conversations: 0, accepted: 0, bytes: 0,
    skipped: [], errors: [], patch: {}
  };
  let idx = 0;

  function step() {
    if (idx >= list.length) { onDone(null, report); return; }
    const file = list[idx++];
    report.files++;
    // LOW-1 (аудит перед релизом): архив читается ЦЕЛИКОМ в память (readAsText),
    // поэтому файл больше MAX_ARCHIVE_SIZE отклоняется ДО чтения — понятной
    // ошибкой, а не подвисанием вкладки настроек. Порог — константа модуля
    // импорта (utils/archive-import.js), здесь не дублируется.
    const maxArchiveSize = Number(API.MAX_ARCHIVE_SIZE) || 0;
    const fileSize = Number(file && file.size) || 0;
    if (maxArchiveSize > 0 && fileSize > maxArchiveSize) {
      const limitMb = String(Math.round(maxArchiveSize / (1024 * 1024)));
      report.errors.push({
        fileName: file.name,
        error: 'file-too-large',
        size: fileSize,
        limit: maxArchiveSize,
        message: aiCmI18nMessage(
          'options_archive_file_too_large',
          'файл слишком большой (больше ' + limitMb + ' МБ) — чтение отменено',
          [limitMb]
        )
      });
      step();
      return;
    }
    let reader;
    try {
      reader = new FileReader();
    } catch (eNew) {
      report.errors.push({ fileName: file.name, error: 'filereader-unavailable' });
      step();
      return;
    }
    reader.onerror = function () {
      report.errors.push({ fileName: file.name, error: 'read-error' });
      step();
    };
    reader.onload = function () {
      try {
        const parsed = API.parseArchiveText(String(reader.result == null ? '' : reader.result));
        if (!parsed.ok) {
          report.errors.push({ fileName: file.name, error: parsed.error });
          step();
          return;
        }
        report.conversations += parsed.conversations.length;
        const plan = API.planArchiveImport(parsed.conversations, { fileName: file.name });
        (plan.skipped || []).forEach(function (s) {
          report.skipped.push({ fileName: file.name, convId: s.convId, reason: s.reason });
        });
        report.accepted += plan.accepted.length;
        report.bytes += plan.bytes || 0;
        Object.assign(report.patch, buildArchiveStoragePatch(plan.accepted, file.name));
      } catch (eParse) {
        report.errors.push({ fileName: file.name, error: 'parse-exception' });
      }
      step();
    };
    try {
      reader.readAsText(file);
    } catch (eRead) {
      report.errors.push({ fileName: file.name, error: 'read-exception' });
      step();
    }
  }
  step();
}

// ---- человекочитаемый отчёт об импорте (для строки статуса) ----
function formatArchiveReport(report) {
  if (!report) return '';
  const parts = [];
  var nFiles = String(report.files);
  var nConvs = String(report.conversations);
  var nAccepted = String(report.accepted);
  parts.push(aiCmI18nMessage('options_archive_report_files', 'файлов: ' + nFiles, [nFiles]));
  parts.push(aiCmI18nMessage('options_archive_report_conversations', 'диалогов: ' + nConvs, [nConvs]));
  parts.push(aiCmI18nMessage('options_archive_report_imported', 'импортировано: ' + nAccepted, [nAccepted]));
  if (report.bytes) {
    var kb = String(Math.round(report.bytes / 1024));
    parts.push(aiCmI18nMessage('options_archive_report_kb', '≈' + kb + ' КБ', [kb]));
  }
  if (report.skipped && report.skipped.length) {
    const byReason = {};
    report.skipped.forEach(function (s) { byReason[s.reason] = (byReason[s.reason] || 0) + 1; });
    var skippedList = Object.keys(byReason).map(function (r) { return r + '×' + byReason[r]; }).join(', ');
    parts.push(aiCmI18nMessage('options_archive_report_skipped', 'пропущено: ' + skippedList, [skippedList]));
  }
  if (report.errors && report.errors.length) {
    var errorList = report.errors.map(function (e) { return e.fileName + ' (' + (e.message || e.error) + ')'; }).join(', ');
    parts.push(aiCmI18nMessage('options_archive_report_errors', 'ошибки: ' + errorList, [errorList]));
  }
  return parts.join(' · ');
}

// ---- список импортированных архивов (по метаданным aiCmConvSource:<convId>) ----
// Тела архивов (aiCmArchive:<convId>) здесь НЕ читаются: MB-историю в попап не тянем.
function aiCmListArchiveSourceKeys(cb) {
  try {
    if (chrome.storage.local.getKeys) {
      chrome.storage.local.getKeys(function (keys) {
        cb((keys || []).filter(function (k) { return k.indexOf('aiCmArchive:') === 0; })
          .map(function (k) { return k.slice('aiCmArchive:'.length); }));
      });
      return;
    }
  } catch (eKeys) { }
  try {
    chrome.storage.local.get(null, function (all) {
      cb(Object.keys(all || {}).filter(function (k) { return k.indexOf('aiCmArchive:') === 0; })
        .map(function (k) { return k.slice('aiCmArchive:'.length); }));
    });
  } catch (eAll) { cb([]); }
}

function aiCmRenderArchiveList() {
  if (!archiveListEl) return;
  const API = aiCmArchiveApi();
  if (!API) { archiveListEl.textContent = ''; return; }
  aiCmListArchiveSourceKeys(function (convIds) {
    if (!convIds.length) {
      archiveListEl.textContent = aiCmI18nMessage('options_archive_empty', 'Архивы не импортированы.');
      return;
    }
    const srcKeys = convIds.map(function (cid) { return API.convSourceStorageKey(cid); });
    chrome.storage.local.get(srcKeys, function (data) {
      archiveListEl.textContent = '';
      convIds.forEach(function (cid) {
        const rec = (data || {})[API.convSourceStorageKey(cid)] || null;
        const row = document.createElement('div');
        row.className = 'archive-item';
        const info = document.createElement('span');
        info.className = 'archive-info';
        const label = rec ? (rec.label || API.describeSource(rec)) : aiCmI18nMessage('options_archive_fallback', 'архив');
        const when = (rec && rec.importedAt) ? (' · ' + formatTime(rec.importedAt)) : '';
        const file = (rec && rec.fileName) ? (' · ' + rec.fileName) : '';
        info.textContent = cid.slice(0, 8) + ' — ' + label + when + file;
        row.appendChild(info);
        const del = document.createElement('button');
        del.className = 'btn-reset archive-del';
        del.type = 'button';
        del.textContent = aiCmI18nMessage('options_archive_delete', 'Удалить');
        del.setAttribute('data-conv-id', cid);
        del.addEventListener('click', function () { aiCmDeleteArchive(cid); });
        row.appendChild(del);
        archiveListEl.appendChild(row);
      });
    });
  });
}

// Удаление архива чата: снимаются ОБА ключа T1 (данные + источник).
function aiCmDeleteArchive(convId) {
  const API = aiCmArchiveApi();
  if (!API || !convId) return;
  try {
    chrome.storage.local.remove([API.archiveStorageKey(convId), API.convSourceStorageKey(convId)], function () {
      var shortId = String(convId).slice(0, 8);
      aiCmSetArchiveStatus(aiCmI18nMessage('options_archive_deleted', 'архив ' + shortId + ' удалён', [shortId]));
      aiCmRenderArchiveList();
    });
  } catch (eDel) {
    var delErr = String(eDel && eDel.message || eDel);
    aiCmSetArchiveStatus(aiCmI18nMessage('options_archive_delete_error', 'не удалось удалить архив: ' + delErr, [delErr]), true);
  }
}

function aiCmApplyArchiveImport() {
  const files = archiveFileInput && archiveFileInput.files;
  aiCmSetArchiveStatus(aiCmI18nMessage('options_archive_reading', 'чтение файлов…'));
  aiCmImportArchiveFiles(files, function (err, report) {
    if (err) { aiCmSetArchiveStatus(err, true); return; }
    const keys = Object.keys(report.patch);
    if (!keys.length) {
      var nothingReport = formatArchiveReport(report);
      aiCmSetArchiveStatus(aiCmI18nMessage('options_archive_nothing', 'ничего не импортировано · ' + nothingReport, [nothingReport]), true);
      aiCmRenderArchiveList();
      return;
    }
    try {
      chrome.storage.local.set(report.patch, function () {
        var doneReport = formatArchiveReport(report);
        aiCmSetArchiveStatus(aiCmI18nMessage('options_archive_done', 'готово · ' + doneReport, [doneReport]));
        aiCmRenderArchiveList();
      });
    } catch (eSet) {
      var setErr = String(eSet && eSet.message || eSet);
      aiCmSetArchiveStatus(aiCmI18nMessage('options_archive_set_error', 'ошибка записи в хранилище: ' + setErr, [setErr]), true);
    }
  });
}

archiveImportBtn && archiveImportBtn.addEventListener('click', aiCmApplyArchiveImport);
archiveRefreshBtn && archiveRefreshBtn.addEventListener('click', function () {
  aiCmSetArchiveStatus('');
  aiCmRenderArchiveList();
});
// Внешние изменения (другое окно/удаление) — обновляем список
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    for (var k in changes) {
      if (k.indexOf('aiCmArchive:') === 0) { aiCmRenderArchiveList(); return; }
    }
  });
} catch (eArcCh) { }

// Загружаем статистику и состояние экспорта при открытии
document.addEventListener('DOMContentLoaded', function () {
  loadStats();
  refreshExportState();
  aiCmRenderArchiveList();
});

// Экспорт чистых функций для юнит-тестов (jest). В браузере (MV3, классический
// скрипт options.html) module не определён — блок не выполняется.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isChatHome: isChatHome,
    buildArchiveStoragePatch: buildArchiveStoragePatch,
    aiCmImportArchiveFiles: aiCmImportArchiveFiles,
    formatArchiveReport: formatArchiveReport
  };
}
