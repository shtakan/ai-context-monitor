console.log('AI Context Monitor v1.24 — индикатор заполнения контекста (ChatGPT, Gemini, DeepSeek, Claude, Perplexity, Google Search AI)');
// Проверка валидности контекста расширения
function isExtensionValid() {
  try {
    return !!chrome.runtime?.id;
  } catch (e) {
    return false;
  }
}
let currentAdapter = null;
let observer = null;
let isInitialized = false;
let lastPercentage = -1;
let updateTimer = null;
let widgetElement = null;
let lastWidgetData = null;
let maxTokenCount = 0;
let restoredTapeLoaded = false; // v28: флаг однократного восстановления ленты при загрузке чата
let restoreDone = false; // v30: флаг завершения восстановления — разрешает сохранение ленты только после restore
// ========== ГИБРИД: БАЗА (сеть) + ХВОСТ (DOM по кэшу базы) ==========
let baseText = '';
let baseCount = 0;
let baseSeen = false;
let baseComplete = false; // сеть дала ПОЛНУЮ историю (тихая пагинация) → индикатор берёт число из базы, не из DOM
let lastBounded = false;  // последний DOM-хвост нашёл границу (стабильный источник для монотонного максимума)
let lastTailSig = null;

let baseIdSet = null;
var lastBaseIds = [];
var lastBaseTexts = [];
let baseSkelSet = null;
let baseAnchors = null;
const ANCHOR_MIN = 40;

// ========== ЭКСПОРТ ИСТОРИИ (aiCmHistory) ==========
// Роли сообщений берём из detail.messages перехватчика (если есть);
// иначе — фолбэк: первое сообщение user, далее чередование user/assistant.
let lastDetailMessages = null; // [{role,text}] из последнего detail.messages (или null)
let lastHistoryWroteKey = null; // сигнатура 'baseCount|textLen' последней записи aiCmHistory
function buildHistoryMessages() {
  var texts = lastBaseTexts || [];
  var out = [];
  if (Array.isArray(lastDetailMessages) && lastDetailMessages.length === texts.length) {
    for (var i = 0; i < texts.length; i++) {
      var r = (lastDetailMessages[i] && lastDetailMessages[i].role) || '';
      out.push({ role: (r === 'user') ? 'user' : 'assistant', text: texts[i] || '' });
    }
  } else {
    for (var j = 0; j < texts.length; j++) {
      out.push({ role: (j % 2 === 0) ? 'user' : 'assistant', text: texts[j] || '' });
    }
  }
  return out;
}

// ========== v28: ХРАНИЛИЩЕ ПОЛНОЙ ЛЕНТЫ GEMINI (chrome.storage.local) ==========
// Интерфейс (асинхронный, на Promise):
//   load(convId) -> {turns:[{id,text}], meta:{count,effectiveLen,ts,modelSlug}} | null
//   save(convId, turns, meta)
//   remove(convId)
//   cleanup()
// Бэкенд — chrome.storage.local; сигнатуры позволяют заменить на IndexedDB без переписывания вызывающего кода.
const STORAGE_PREFIX = 'ai-cm-gemini-tape-';
const STORAGE_INDEX_PREFIX = 'ai-cm-gemini-index-';
const MAX_DIALOGUES = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

var GeminiTapeStore = {
  load: function (convId) {
    if (!isExtensionValid() || !convId) return Promise.resolve(null);
    return new Promise(function (resolve) {
      chrome.storage.local.get([STORAGE_PREFIX + convId], function (data) {
        var entry = data[STORAGE_PREFIX + convId];
        if (!entry) { resolve(null); return; }
        // обновляем ts при каждом обращении
        entry.meta = entry.meta || {};
        entry.meta.ts = Date.now();
        // пишем обновлённый ts обратно (fire-and-forget)
        var kv = {};
        kv[STORAGE_PREFIX + convId] = entry;
        chrome.storage.local.set(kv);
        resolve(entry);
      });
    });
  },

  save: function (convId, turns, meta) {
    if (!isExtensionValid() || !convId || !turns || !turns.length) return Promise.resolve();
    meta = meta || {};
    meta.ts = Date.now();
    var record = { turns: turns, meta: meta };
    var kv = {};
    kv[STORAGE_PREFIX + convId] = record;
    return new Promise(function (resolve) {
      chrome.storage.local.set(kv, function () {
        GeminiTapeStore._touchIndex(convId).then(resolve);
      });
    });
  },

  remove: function (convId) {
    if (!isExtensionValid() || !convId) return Promise.resolve();
    return new Promise(function (resolve) {
      chrome.storage.local.remove([STORAGE_PREFIX + convId, STORAGE_INDEX_PREFIX + convId], function () {
        resolve();
      });
    });
  },

  cleanup: function () {
    if (!isExtensionValid()) return Promise.resolve();
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (all) {
        var now = Date.now();
        var entries = [];
        for (var k in all) {
          if (k.indexOf(STORAGE_PREFIX) !== 0) continue;
          var convId = k.slice(STORAGE_PREFIX.length);
          var entry = all[k];
          var ts = (entry && entry.meta && entry.meta.ts) ? entry.meta.ts : 0;
          entries.push({ convId: convId, ts: ts });
        }
        // сортируем по ts: самые свежие — первые
        entries.sort(function (a, b) { return b.ts - a.ts; });

        var toRemove = [];
        for (var i = 0; i < entries.length; i++) {
          // удаляем если слишком старые ИЛИ за пределами лимита
          if ((now - entries[i].ts > MAX_AGE_MS) || (i >= MAX_DIALOGUES)) {
            toRemove.push(STORAGE_PREFIX + entries[i].convId);
            toRemove.push(STORAGE_INDEX_PREFIX + entries[i].convId);
          }
        }

        if (toRemove.length > 0) {
          chrome.storage.local.remove(toRemove, function () { resolve(); });
        } else {
          resolve();
        }
      });
    });
  },

  // вспомогательное: метка времени в индексе
  _touchIndex: function (convId) {
    return new Promise(function (resolve) {
      var kv = {};
      kv[STORAGE_INDEX_PREFIX + convId] = { ts: Date.now() };
      chrome.storage.local.set(kv, function () { resolve(); });
    });
  }
};

// ========== ДЕТЕКТОР МОДЕЛИ (сеть) ==========
let detectedModelSlug = '';
let lastResolvedModelId = null;

// ========== ВЛОЖЕНИЯ (Gemini; для ChatGPT = 0, нейтрально) ==========
let netAttachTokens = 0;
let netAttachBreak = null;

// ========== СЕРВЕРНЫЙ ЧИСЛИТЕЛЬ (DeepSeek accumulated_token_usage; для ChatGPT/Gemini = 0) ==========
let netServerTokens = 0;
let netEffectiveLen = 0;

// ========== BYOK: точный подсчёт токенов через Gemini countTokens API ==========
let exactCountEnabled = false;
let geminiApiKey = '';
let lastCountTokensText = '';
let lastCountTokensCache = 0;
let countTokensTimer = null;
let countTokensPending = false; // защита от повторного запроса пока предыдущий в полёте

// ========== БЕЗОПАСНЫЙ ПОРОГ (регулятор; определения целиком, со стрелками) ==========
let safePct = null;
function safePctKey() { return 'ai_cm_safe_pct_' + getServiceKey(); }
function zoneColor(p) { if (p < 50) return '#22c55e'; if (p < 80) return '#eab308'; return '#ef4444'; }
function computeEffectiveLimit(modelId) {
  const eff = ModelConfig.getEffectiveLimit(modelId);
  if (typeof safePct === 'number' && safePct > 0) return Math.max(1, Math.round(safePct / 100 * eff));
  return eff;
}
function updatePanel() {
  if (!widgetElement) return;
  const status = widgetElement.querySelector('.ai-cm-limit-text');
  const input = widgetElement.querySelector('.ai-cm-input');
  if (!status) return;
  const effLim = lastWidgetData ? lastWidgetData.effectiveLimit : 0;
  if (typeof safePct === 'number' && safePct > 0) {
    const eff = Math.max(1, Math.round(safePct / 100 * effLim));
    status.textContent = 'Порог ' + safePct + '% = ' + eff.toLocaleString() + ' ток';
    if (input) input.value = safePct;
  } else {
    status.textContent = 'Авто-порог: ' + effLim.toLocaleString() + ' ток (= 100% в поле)';
    if (input) input.value = '';
  }
}
function snapCurrentPct() {
  const eff = lastWidgetData ? lastWidgetData.effectiveLimit : 0;
  const t = lastWidgetData ? lastWidgetData.tokenEstimate : 0;
  if (!eff || !t || t <= 0) return;
  safePct = Math.max(1, Math.round(t / eff * 1000) / 10);
  if (isExtensionValid()) { try { chrome.storage.sync.set({ [safePctKey()]: safePct }); } catch (e) { } }
  updatePanel();
  processAndSend();
}
function setSafePctFromInput(v) {
  const n = parseFloat(v);
  if (isNaN(n) || n <= 0) { resetSafePct(); return; }
  safePct = Math.round(n * 10) / 10;
  if (isExtensionValid()) { try { chrome.storage.sync.set({ [safePctKey()]: safePct }); } catch (e) { } }
  updatePanel();
  processAndSend();
}
function resetSafePct() {
  safePct = null;
  if (isExtensionValid()) { try { chrome.storage.sync.set({ [safePctKey()]: null }); } catch (e) { } }
  updatePanel();
  processAndSend();
}
function stepSafePct(delta) {
  if (!widgetElement) return;
  const input = widgetElement.querySelector('.ai-cm-input');
  if (!input) return;
  let cur = parseFloat(input.value);
  if (isNaN(cur)) cur = 100;
  let next = Math.round((cur + delta) * 10) / 10;
  if (next < 1) next = 1;
  if (next > 100) next = 100;
  setSafePctFromInput(String(next));
}
// ============================================================================================

// ========== v1.18/v1.22: сброс состояния виджета при смене чата в SPA ==========
function resetConversationState() {
  debugLog('log', '[content-trace] RESET виджета seq=' + (++window.__aiCmTraceSeq || (window.__aiCmTraceSeq = 1)) + ' t=' + Date.now());
  baseText = '';
  baseCount = 0;
  baseSeen = false;
  baseComplete = false;
  lastBounded = false;
  maxTokenCount = 0;
  baseIdSet = null;
  baseSkelSet = null;
  baseAnchors = null;
  lastTailSig = null;
  lastBaseIds = [];
  lastBaseTexts = [];
  lastDetailMessages = null;
  lastHistoryWroteKey = null;
  detectedModelSlug = '';
  netAttachTokens = 0;
  netAttachBreak = null;
  netServerTokens = 0;
  netEffectiveLen = 0;
  lastCountTokensText = '';
  lastCountTokensCache = 0;
  lastPercentage = -1;
  lastResolvedModelId = null;
  restoredTapeLoaded = false; // v28: разрешаем повторное восстановление при смене чата
  restoreDone = false; // v30: сбрасываем флаг восстановления при смене чата
  if (widgetElement) {
    const circle = widgetElement.querySelector('.ai-widget-fill');
    const pt = widgetElement.querySelector('.ai-widget-text');
    const tt = widgetElement.querySelector('.ai-widget-tooltip');
    if (circle) {
      const C = 2 * Math.PI * 43;
      circle.style.strokeDasharray = C;
      circle.style.strokeDashoffset = C;
      circle.style.stroke = zoneColor(0);
    }
    if (pt) pt.textContent = '0.0%';
    if (tt) tt.innerHTML = 'Загрузка контекста...';
  }
  debugLog('log', '[content] смена чата → состояние виджета сброшено');
}
window.addEventListener('ai-cm-conversation-changed', resetConversationState);
// =============================================================================

function normalize(s) { return (s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/g, ''); }
function stripMd(s) {
  if (!s) return '';
  return s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`+/g, '');
}

var MSG_SELECTORS = [
  '[data-message-author-role]',
  '[data-message-id]',
  '.user-query, .model-response, .query-text, .response-content, [data-role="user"], [data-role="model"]'
];

function findMessageNodes() {
  for (var i = 0; i < MSG_SELECTORS.length; i++) {
    var nodes = document.querySelectorAll(MSG_SELECTORS[i]);
    if (nodes && nodes.length > 0) return { nodes: Array.prototype.slice.call(nodes), sel: MSG_SELECTORS[i] };
  }
  return { nodes: [], sel: '(none)' };
}

function nodeIsBase(node, skel) {
  if (baseIdSet && baseIdSet.size > 0) {
    var id = '';
    try { id = (node.getAttribute && node.getAttribute('data-message-id')) || ''; } catch (e) { }
    if (id && baseIdSet.has(String(id).trim())) return true;
  }
  if (!skel) return false;
  if (baseSkelSet && baseSkelSet.has(skel)) return true;
  if (baseAnchors) {
    for (var i = 0; i < baseAnchors.length; i++) {
      if (skel.indexOf(baseAnchors[i]) !== -1) return true;
    }
  }
  return false;
}

function computeTailFromDom() {
  var found = findMessageNodes();
  var nodes = found.nodes;
  if (!baseSeen || !baseText) return { text: '', count: 0, bounded: false, sel: found.sel, diag: 'нет базы' };
  if (nodes.length === 0) return { text: '', count: 0, bounded: false, sel: found.sel, diag: 'селектор не дал узлов: ' + found.sel };
  if ((!baseIdSet || baseIdSet.size === 0) && (!baseSkelSet || baseSkelSet.size === 0)) {
    return { text: '', count: 0, bounded: false, sel: found.sel, diag: 'кэш базы пуст → фолбэк по базе' };
  }

  var tailNodes = [];
  var stopAt = -1;
  var stopFound = false;
  for (var k = nodes.length - 1; k >= 0; k--) {
    var raw = nodes[k].innerText || nodes[k].textContent || '';
    var skel = normalize(raw);
    if (nodeIsBase(nodes[k], skel)) { stopFound = true; stopAt = k; break; }
    if (skel.length > 0) tailNodes.unshift(nodes[k]);
  }

  var pieces = [];
  for (var j = 0; j < tailNodes.length; j++) {
    var txt = (tailNodes[j].innerText || tailNodes[j].textContent || '').trim();
    if (txt) pieces.push(txt);
  }
  return {
    text: pieces.join('\n'),
    count: tailNodes.length,
    bounded: stopFound,
    sel: found.sel,
    diag: 'sel=' + found.sel + ' узлов=' + nodes.length +
      ' стоп=' + (stopFound ? ('@' + stopAt) : 'нет(все в окне — новые)') +
      ' хвост=' + tailNodes.length + ' bdd=' + (stopFound ? 'да' : 'нет')
  };
}

// Если сеть дала полную историю (baseComplete) — индикатор берёт число ИЗ БАЗЫ (baseText), а НЕ из DOM.
//   Это и есть фикс расхождения 20.3% vs 34.8%: при тихой пагинации DOM не дорендеривается (в этом её
//   смысл), поэтому в нём только видимый кусок; база же держит всю историю детерминированно. Раньше строка,
//   взводящая baseComplete из события, была потеряна при переписывании под сброс чата → виджет всегда считал
//   по DOM. Теперь при baseComplete=true возвращаем baseText, и скролл вверх число не меняет (сеть от скролла
//   не зависит). Иначе (база неполная) — прежняя логика: bounded ? база+хвост : только DOM.
function getEffectiveText() {
  if (baseSeen && baseText) {
    if (baseComplete) {
      lastBounded = true; // источник = сеть, стабилен → монотонный максимум безвреден
      return baseText;
    }
    var tail = computeTailFromDom();
    var sig = (tail.sel || '') + '|' + (tail.bounded ? '1' : '0');
    if (sig !== lastTailSig) {
      debugLog('log', '[hybrid-tail] ' + tail.diag);
      lastTailSig = sig;
    }
    lastBounded = tail.bounded;
    if (!tail.text) return baseText;
    if (tail.bounded) return baseText + '\n' + tail.text;
    return tail.text;
  }
  return '';
}
function getEffectiveCount(fallbackCount) {
  if (baseSeen && baseText) {
    if (baseComplete) return baseCount;
    var tail = computeTailFromDom();
    if (!tail.count) return baseCount;
    if (tail.bounded) return baseCount + tail.count;
    return tail.count;
  }
  return fallbackCount;
}

window.addEventListener('ai-cm-full-history', function (ev) {
  const detail = ev && ev.detail;
  if (!detail || !detail.text) return;
  // ФИКС: взводим baseComplete из флага перехватчика. При переходе «сеть стала полной» сбрасываем
  //   монотонный максимум, чтобы добить любой пик, накопленный DOM-путём до этого.
  const newBaseComplete = !!detail.historyComplete;
  if (newBaseComplete && !baseComplete) { maxTokenCount = 0; }
  baseComplete = newBaseComplete;
  baseText = detail.text;
  baseCount = detail.count || 0;
  detectedModelSlug = detail.modelSlug || '';
  netAttachTokens = detail.attachTokens || 0;
  netAttachBreak = detail.attachBreak || null;
  netServerTokens = detail.serverTokens || 0;
  netEffectiveLen = (typeof detail.effectiveLen === 'number' && detail.effectiveLen > 0) ? detail.effectiveLen : 0;
  baseSeen = true;
  var texts = Array.isArray(detail.messageTexts) ? detail.messageTexts : [];
  var ids = Array.isArray(detail.messageIds) ? detail.messageIds : [];
  lastBaseIds = ids;
  lastBaseTexts = texts;
  lastDetailMessages = Array.isArray(detail.messages) ? detail.messages : null;
  baseIdSet = new Set();
  for (var i = 0; i < ids.length; i++) { var s = String(ids[i]).trim(); if (s) baseIdSet.add(s); }
  baseSkelSet = new Set();
  baseAnchors = [];
  for (var t = 0; t < texts.length; t++) {
    var sk = normalize(stripMd(texts[t]));
    if (sk) { baseSkelSet.add(sk); if (sk.length >= ANCHOR_MIN) baseAnchors.push(sk); }
  }
  lastTailSig = null;
  console.log('📥 база полной истории: ' + baseCount + ' сообщений, кэш id=' + baseIdSet.size +
    ', скелетов=' + baseSkelSet.size + ', длинных якорей=' + baseAnchors.length +
    (detectedModelSlug ? ', slug из сети=' + detectedModelSlug : '') +
    (netAttachTokens > 0 ? ', вложения≈' + netAttachTokens + ' ток' : '') +
    (netServerTokens > 0 ? ', serverTokens=' + netServerTokens : '') +
    (baseComplete ? ', история ПОЛНАЯ по сети (индикатор по базе, DOM игнор)' : ''));
  debugLog('log', '[content-trace] EMIT принят seq=' + (window.__aiCmTraceSeq || 0) + ' baseComplete=' + baseComplete + ' baseCount=' + baseCount + ' textLen=' + (baseText ? baseText.length : 0) + ' t=' + Date.now());

  // ФИКС: сеть дала базу, но DOM-инициализация ещё не случилась (SPA-переход по сайдбару без F5 —
  //   ретраи initialize уже отработали вхолостую, а bootFetch пропущен). Запускаем инициализацию
  //   наблюдателя, чтобы isInitialized стало true и realtime после обмена заработал без F5.
  //   DOM может отрендериться чуть позже снимка — делаем несколько попыток.
  if (!isInitialized) {
    tryInit();
    setTimeout(function () { if (!isInitialized) tryInit(); }, 500);
    setTimeout(function () { if (!isInitialized) tryInit(); }, 1500);
  }

  // v28: сохраняем полную ленту в chrome.storage.local для восстановления после F5/переоткрытия
  // v30: сохраняем ТОЛЬКО если restoreDone === true — не даём первому неполному эмиту
  // после F5 затереть ленту до восстановления.
  if (restoreDone) {
    var convId = detail.convId || '';
    if (convId && ids.length > 0 && texts.length > 0) {
      var turns = [];
      for (var x = 0; x < ids.length; x++) {
        turns.push({ id: ids[x], text: texts[x] || '' });
      }
      GeminiTapeStore.save(convId, turns, {
        count: detail.count || 0,
        effectiveLen: detail.effectiveLen || 0,
        modelSlug: detail.modelSlug || ''
      });
    }
  }

  processAndSend();
});

// ========== ДИЗАЙН-КОНФИГУРАЦИЯ ==========
const THEME_CONFIGS = {
  chatgpt: {
    font: 'Söhne, Inter, -apple-system, BlinkMacSystemFont, sans-serif',
    light: { bgTrack: '#f0f0f0', bgFill: '#10a37f', text: '#212121', tooltipBg: '#ffffff', tooltipText: '#212121', shadow: '0 2px 6px rgba(0,0,0,0.08), 0 0 1px rgba(0,0,0,0.1)', border: '1px solid #e5e5e5' },
    dark: { bgTrack: '#2f2f2f', bgFill: '#19c37d', text: '#ececf1', tooltipBg: '#212121', tooltipText: '#ececf1', shadow: '0 2px 6px rgba(0,0,0,0.3)', border: '1px solid #424242' }
  },
  deepseek: {
    font: 'Inter, system-ui, -apple-system, sans-serif',
    light: { bgTrack: '#e5e7eb', bgFill: '#4d6bfe', text: '#111827', tooltipBg: '#ffffff', tooltipText: '#111827', shadow: '0 4px 12px rgba(77, 107, 254, 0.1)', border: '1px solid #e5e7eb' },
    dark: { bgTrack: '#242b3d', bgFill: '#3d5afe', text: '#f3f4f6', tooltipBg: '#181f30', tooltipText: '#f3f4f6', shadow: '0 4px 20px rgba(0, 0, 0, 0.4)', border: '1px solid #2e374a' }
  },
  gemini: {
    font: '"Google Sans", Roboto, Arial, sans-serif',
    light: { bgTrack: '#e9eef6', bgFill: 'url(#gemini-gradient)', text: '#1f1f1f', tooltipBg: '#e9eef6', tooltipText: '#1f1f1f', shadow: '0 4px 16px rgba(0,0,0,0.08)', border: 'none' },
    dark: { bgTrack: '#37393b', bgFill: 'url(#gemini-gradient)', text: '#e3e3e3', tooltipBg: '#1e1f20', tooltipText: '#e3e3e3', shadow: '0 4px 24px rgba(0,0,0,0.5)', border: 'none' }
  },
  google_search: {
    font: '"Google Sans", Roboto, helvetica, arial, sans-serif',
    light: { bgTrack: '#f1f3f4', bgFill: '#1a73e8', text: '#3c4043', tooltipBg: '#ffffff', tooltipText: '#3c4043', shadow: '0 1px 6px rgba(32,33,36,0.28)', border: '1px solid #dadce0' },
    dark: { bgTrack: '#3c4043', bgFill: '#8ab4f8', text: '#e8eaed', tooltipBg: '#303134', tooltipText: '#e8eaed', shadow: '0 1px 6px rgba(0,0,0,0.4)', border: '1px solid #5f6368' }
  }
};
function getServiceKey() {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com')) return 'chatgpt';
  if (host.includes('deepseek.com')) return 'deepseek';
  if (host.includes('gemini.google.com')) return 'gemini';
  if (host.includes('google.com')) return 'google_search';
  return 'chatgpt';
}
function getCurrentConvId() {
  try {
    var m = location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}
function isDarkMode() {
  const htmlClass = document.documentElement.classList;
  const bodyClass = document.body.classList;
  const dataTheme = document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme');
  if (htmlClass.contains('dark') || bodyClass.contains('dark') || dataTheme === 'dark') return true;
  if (htmlClass.contains('light') || bodyClass.contains('light') || dataTheme === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}
function applyNativeStyles(container) {
  const serviceKey = getServiceKey();
  const isDark = isDarkMode();
  const config = THEME_CONFIGS[serviceKey];
  const styles = isDark ? config.dark : config.light;
  container.style.setProperty('--w-font', config.font);
  container.style.setProperty('--w-bg-track', styles.bgTrack);
  container.style.setProperty('--w-bg-fill', styles.bgFill);
  container.style.setProperty('--w-text', styles.text);
  container.style.setProperty('--w-tooltip-bg', styles.tooltipBg);
  container.style.setProperty('--w-tooltip-text', styles.tooltipText);
  container.style.setProperty('--w-shadow', styles.shadow);
  container.style.setProperty('--w-border', styles.border);
}
// ========== ИНИЦИАЛИЗАЦИЯ ==========
async function initialize() {
  const hostname = window.location.hostname;
  if (hostname.includes('chatgpt.com')) {
    currentAdapter = new ChatGPTAdapter();
  } else if (hostname.includes('gemini.google.com') || hostname.includes('aistudio.google.com')) {
    currentAdapter = new GeminiAdapter();
  } else if (hostname.includes('chat.deepseek.com')) {
    currentAdapter = new DeepSeekAdapter();
  } else if (hostname.includes('google.com') && !hostname.includes('aistudio')) {
    currentAdapter = new GoogleSearchAdapter();
  } else if (hostname.includes('claude.ai')) {
    currentAdapter = new ClaudeAdapter();
  } else if (hostname.includes('perplexity.ai')) {
    currentAdapter = new PerplexityAdapter();
  }
  if (!currentAdapter) return;
  debugLog('log', 'Адаптер:', currentAdapter.siteName);
  loadByokSettings();
  loadByokCache();
  if (isExtensionValid()) {
    chrome.storage.sync.get([safePctKey()], (d) => {
      const v = d[safePctKey()];
      safePct = (typeof v === 'number' && v > 0) ? v : null;
      updatePanel();
      if (isInitialized) processAndSend();
    });
  }
  if (isExtensionValid()) {
    chrome.storage.sync.get(['showWidget'], (data) => {
      if (data.showWidget !== false) {
        createWidget();
      }
    });
  } else {
    createWidget();
  }
  await tryInit();
  if (!isInitialized) {
    [2000, 4000, 6000].forEach(delay => {
      setTimeout(async () => { if (!isInitialized) await tryInit(); }, delay);
    });
  }
}
async function tryInit() {
  if (isInitialized) return;
  const found = findMessageNodes();
  if (found.nodes.length > 0) {
    debugLog('log', 'Диалог найден:', found.nodes.length, 'узлов (' + found.sel + ')');
    isInitialized = true;
    processAndSend();
    startObserving();
  }
}
// ========== НАБЛЮДЕНИЕ ==========
function startObserving() {
  if (observer) observer.disconnect();
  let mutationCount = 0;
  observer = new MutationObserver((mutations) => {
    const hasNewText = mutations.some(mutation => {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1 && node.textContent?.trim()?.length > 10) return true;
        }
      }
      return mutation.type === 'characterData';
    });
    if (hasNewText) {
      mutationCount++;
      clearTimeout(updateTimer);
      const delay = Math.min(800 + (mutationCount * 300), 3000);
      updateTimer = setTimeout(() => {
        mutationCount = 0;
        processAndSend();
      }, delay);
    }
  });
  observer.observe(document.body, {
    childList: true, subtree: true, characterData: true, attributes: false
  });
}
// ========== ОПРЕДЕЛЕНИЕ МОДЕЛИ (3 слоя) + ОБРАБОТКА ==========
function resolveCurrentModel() {
  const rawFromNet = detectedModelSlug || '';
  const rawFromDom = rawFromNet ? '' : (currentAdapter.detectModel() || '');
  const raw = rawFromNet || rawFromDom || '';
  let modelId = raw ? ModelConfig.resolveModelId(raw) : null;
  let path;
  if (modelId) {
    path = rawFromNet ? 'сеть' : 'DOM';
  } else {
    modelId = ModelConfig.getDefaultModel(currentAdapter.siteName);
    path = raw ? ((rawFromNet ? 'сеть' : 'DOM') + '→дефолт(не распознан)') : 'дефолт';
  }
  if (modelId !== lastResolvedModelId) {
    lastResolvedModelId = modelId;
    const ctx = ModelConfig.getContextLimit(modelId);
    const eff = ModelConfig.getEffectiveLimit(modelId);
    console.log('[model-detect] путь=' + path +
      (raw ? ', raw="' + raw + '"' : '') +
      ' → id=' + modelId + ', имя=' + (ModelConfig.getModel(modelId)?.name || modelId) +
      ', окно=' + ctx.toLocaleString() + ', порог потери деталей=' + eff.toLocaleString());
  }
  return modelId;
}
// ========== BYOK: запрос точных токенов через countTokens API ==========
function logTextProbe(label, text) {
  if (!text) return;
  var totalLen = text.length;
  var normText = normalize(text);
  var skelLen = normText.length;
  var pieces = text.split('\n');
  var baseHits = 0;
  var nonBase = 0;
  for (var p = 0; p < pieces.length; p++) {
    var pieceNorm = normalize(pieces[p]);
    if (!pieceNorm) continue;
    if (baseSkelSet && baseSkelSet.has(pieceNorm)) {
      baseHits++;
    } else {
      nonBase++;
    }
  }
  console.log('[text-probe] ' + label + ' totalLen=' + totalLen + ' skelLen=' + skelLen + ' кусковБаза=' + baseHits + ' кусковНеБаза=' + nonBase);
}

function requestExactTokens(fullText, modelId) {
  if (!isExtensionValid()) return;
  if (!exactCountEnabled || !geminiApiKey) { netServerTokens = 0; return; }
  if (!fullText) { netServerTokens = 0; return; }
  
  console.log('[byok-src] baseComplete=' + baseComplete +
  ' baseSeen=' + baseSeen +
  ' fullIsBase=' + (fullText === baseText) +
  ' baseLen=' + baseText.length +
  ' fullLen=' + fullText.length +
  ' baseCount=' + baseCount);

  // Кэш: текст не изменился — не дёргаем API
  if (fullText === lastCountTokensText) {
    netServerTokens = lastCountTokensCache;
    return;
  }

  // Текст изменился — показываем последнее точное значение как заполнитель
  if (lastCountTokensCache > 0) {
    netServerTokens = lastCountTokensCache;
  }

  // Сбрасываем любой pending дебаунс
  clearTimeout(countTokensTimer);

  // Защита от дублирования: если запрос уже в полёте — не отправляем повторно
  if (countTokensPending) return;

  countTokensPending = true;
  var apiModelId = ModelConfig.getGeminiApiModelId(modelId);

  logTextProbe('pre-send', fullText);

  chrome.runtime.sendMessage({
    type: 'COUNT_TOKENS',
    text: fullText,
    model: apiModelId
  }, function (response) {
    countTokensPending = false;
    if (response && typeof response.totalTokens === 'number') {
      lastCountTokensText = fullText;
      lastCountTokensCache = response.totalTokens;
      netServerTokens = response.totalTokens;
      console.log('[exact-tokens] countTokens вернул ' + response.totalTokens + ' токенов для модели ' + apiModelId);
      logTextProbe('post-ok:' + response.totalTokens, fullText);
      // Сохраняем точное значение в chrome.storage.local для восстановления после перезагрузки
      if (isExtensionValid()) {
        var convId = getCurrentConvId();
        try {
          chrome.storage.local.set({
            'ai-cm-byok-cache': { convId: convId, text: fullText, count: response.totalTokens, ts: Date.now() }
          });
          console.log('[byok-cache] точное значение сохранено в хранилище: ' + response.totalTokens);
        } catch (e) { }
      }
      // Пересчитываем виджет с точным числом (кэш lastCountTokensText не даст повторному вызову уйти в API)
      processAndSend();
    } else {
      var err = (response && response.error) ? response.error : 'unknown';
      console.warn('[exact-tokens] ошибка countTokens: ' + err + ' — фолбэк на эвристику');
      // Если для этого же текста уже есть точное значение — не затираем его
      if (fullText === lastCountTokensText && lastCountTokensCache > 0) {
        netServerTokens = lastCountTokensCache;
      } else {
        netServerTokens = 0;
      }
    }
  });
}

function loadByokSettings() {
  if (!isExtensionValid()) return;
  chrome.storage.local.get(['ai_cm_exact_token_count', 'ai_cm_gemini_api_key'], function (data) {
    exactCountEnabled = !!data.ai_cm_exact_token_count;
    geminiApiKey = data.ai_cm_gemini_api_key || '';
    console.log('[byok] настройки загружены: exactCount=' + exactCountEnabled + ', key=' + (geminiApiKey ? '***' : '(пусто)'));
  });
}

function loadByokCache() {
  if (!isExtensionValid()) return;
  var currentConvId = getCurrentConvId();
  if (!currentConvId) return;
  chrome.storage.local.get(['ai-cm-byok-cache'], function (data) {
    var entry = data['ai-cm-byok-cache'];
    if (!entry || entry.convId !== currentConvId) return;
    if (!entry.text || typeof entry.count !== 'number' || entry.count <= 0) return;
    lastCountTokensText = entry.text;
    lastCountTokensCache = entry.count;
    console.log('[byok-cache] восстановлено точное значение из хранилища: ' + entry.count + ' токенов');
  });
}

function processAndSend() {
  if (!currentAdapter) return;

  // v28: однократное восстановление сохранённой ленты Gemini при загрузке чата
  if (!restoredTapeLoaded) {
    restoredTapeLoaded = true;
    var svc0 = getServiceKey();
    if (svc0 === 'gemini' || svc0 === 'aistudio') {
      var convId = '';
      try {
        var m = location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/);
        convId = m ? m[1] : '';
      } catch (e) { }
      if (convId) {
        GeminiTapeStore.load(convId).then(function (entry) {
          restoreDone = true; // v30: восстановление завершено — разрешаем сохранение ленты
          if (!entry || !entry.turns || !entry.turns.length) return;
          try {
            window.dispatchEvent(new CustomEvent('ai-cm-restored-history', {
              detail: {
                convId: convId,
                turns: entry.turns,
                meta: entry.meta || {}
              }
            }));
          } catch (e) { }
        });
        GeminiTapeStore.cleanup(); // очистка при загрузке чата
      }
    }
  }

  if (!isInitialized && !(baseSeen && baseComplete)) { debugLog('log', '[content-trace] DRAW-ПРОПУСК (guard) seq=' + (window.__aiCmTraceSeq || 0) + ' baseComplete=' + baseComplete + ' baseSeen=' + baseSeen + ' isInitialized=' + isInitialized + ' t=' + Date.now()); return; }
  debugLog('log', '[content-trace] DRAW seq=' + (window.__aiCmTraceSeq || 0) + ' baseComplete=' + baseComplete + ' baseSeen=' + baseSeen + ' isInitialized=' + isInitialized + ' effectiveLen=' + ((function () { var e = getEffectiveText(); return e ? e.length : 0; })()) + ' t=' + Date.now());
  try {
    const svc = getServiceKey();
    const isGeminiLike = (svc === 'gemini' || svc === 'aistudio');
    let messageCount;
    if (!baseSeen) {
      messageCount = isGeminiLike ? 0 : currentAdapter.extractMessages().length;
    } else {
      messageCount = baseCount;
    }
    const modelId = resolveCurrentModel();
    const effective = getEffectiveText(); // обновляет lastBounded
    let fullText;
    let countForTokens;
    if (effective) {
      fullText = effective;
      countForTokens = getEffectiveCount(messageCount);
    } else {
      if (isGeminiLike) {
        fullText = '';
        countForTokens = 0;
      } else {
        fullText = currentAdapter.getFullDialogText();
        countForTokens = messageCount;
      }
    }
    // BYOK: для Gemini-подобных сервисов отправляем запрос на точный подсчёт токенов
    const isGeminiSvc = (svc === 'gemini' || svc === 'aistudio' || svc === 'google_search');
    if (isGeminiSvc && exactCountEnabled && geminiApiKey && fullText && baseComplete) {
      requestExactTokens(fullText, modelId);
    }

    let tokenEstimate = netServerTokens > 0 ? netServerTokens : Tokenizer.estimateDialogTokens(fullText, countForTokens);
    // Поднятый полом effectiveLen (Gemini): если сеть дала effectiveLen > длины текста — масштабируем оценку
    if (netServerTokens === 0 && netEffectiveLen > 0 && fullText && fullText.length > 0 && netEffectiveLen > fullText.length) {
      tokenEstimate = Math.round(tokenEstimate * (netEffectiveLen / fullText.length));
    }
    tokenEstimate += netAttachTokens;
    const contextLimit = ModelConfig.getContextLimit(modelId);
    const effectiveLimit = ModelConfig.getEffectiveLimit(modelId);
    const displayLimit = computeEffectiveLimit(modelId);
    // Монотонный максимум удерживается, когда источник стабилен —
    // EITHER сеть дала полную историю (baseComplete) ИЛИ найденная DOM-граница (lastBounded).
    const useMonotonic = baseComplete || lastBounded;
    if (netServerTokens > 0) {
      // точное число из countTokens авторитетно — не удерживаем завышенную эвристику
      maxTokenCount = tokenEstimate;
    } else if (useMonotonic) {
      if (tokenEstimate > maxTokenCount) maxTokenCount = tokenEstimate;
    } else {
      maxTokenCount = tokenEstimate;
    }
    const percentage = displayLimit > 0 ? Math.round((maxTokenCount / displayLimit) * 1000) / 10 : 0;
    const hasChanged = percentage !== lastPercentage;
    lastPercentage = percentage;
    updateWidget(percentage, maxTokenCount, effectiveLimit, contextLimit, displayLimit, ModelConfig.getModel(modelId)?.name || modelId, netAttachBreak);
    lastWidgetData = {
      percentage, tokenEstimate: maxTokenCount, effectiveLimit, contextLimit, displayLimit,
      modelName: ModelConfig.getModel(modelId)?.name || modelId, attachBreak: netAttachBreak
    };
    if (hasChanged) {
      const tag = (typeof safePct === 'number' && safePct > 0) ? ('порог ' + safePct + '% от Авто') : 'Авто';
      debugLog('log', `📊 ${ModelConfig.getModel(modelId)?.name || modelId}: ${maxTokenCount} / ${displayLimit.toLocaleString()} (${tag}) · окно ${contextLimit.toLocaleString()} · ${percentage}%` + (netAttachTokens > 0 ? ` · вложения≈${netAttachTokens}` : '') + (netServerTokens > 0 ? ' · serverTokens' : '') + (baseComplete ? ' · по базе' : ''));
    }

    // Снапшот для попапа в chrome.storage.local
    if (isExtensionValid()) {
      try {
        chrome.storage.local.set({ aiCmState: {
          host: window.location.hostname,
          site: currentAdapter.siteName,
          model: ModelConfig.getModel(modelId)?.name || modelId,
          tokens: maxTokenCount,
          limit: displayLimit,
          percent: percentage,
          updatedAt: Date.now()
        }});
      } catch (e) {}
    }
    // Экспорт истории: пишем aiCmHistory только когда история реально изменилась (baseCount или textLen).
    if (isExtensionValid() && baseSeen && lastBaseTexts.length > 0) {
      var histKey = baseCount + '|' + (baseText ? baseText.length : 0);
      if (histKey !== lastHistoryWroteKey) {
        lastHistoryWroteKey = histKey;
        try {
          chrome.storage.local.set({ aiCmHistory: {
            host: window.location.hostname,
            site: currentAdapter.siteName,
            model: ModelConfig.getModel(modelId)?.name || modelId,
            tokens: maxTokenCount,
            limit: displayLimit,
            percent: percentage,
            updatedAt: Date.now(),
            messages: buildHistoryMessages()
          }});
        } catch (e) {}
      }
    }
    if (isExtensionValid()) {
      chrome.runtime.sendMessage({
        type: 'CONTEXT_UPDATE',
        data: {
          site: currentAdapter.siteName,
          model: modelId,
          modelName: ModelConfig.getModel(modelId)?.name || modelId,
          tokenCount: maxTokenCount,
          contextLimit: effectiveLimit,
          percentage,
          messageCount,
          timestamp: Date.now()
        }
      }).catch(() => { });
    }
  } catch (error) {
    console.error('Ошибка:', error);
  }
}
// ========== ВИДЖЕТ (со стрелками ▲▼) ==========
function createWidget() {
  if (document.getElementById('ai-context-widget')) return;
  const container = document.createElement('div');
  container.id = 'ai-context-widget';
  container.innerHTML = `<style> #ai-context-widget { position: fixed; bottom: 24px; right: 24px; z-index: 999999; font-family: var(--w-font); user-select: none; } .ai-widget-circle { width: 64px; height: 64px; position: relative; cursor: pointer; background: var(--w-tooltip-bg); border-radius: 50%; box-shadow: var(--w-shadow); border: var(--w-border); display: flex; align-items: center; justify-content: center; transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1); } .ai-widget-circle:hover { transform: scale(1.06); } .ai-widget-circle svg { width: 88%; height: 88%; transform: rotate(-90deg); } .ai-widget-bg { fill: none; stroke: var(--w-bg-track); stroke-width: 7; } .ai-widget-fill { fill: none; stroke: var(--w-bg-fill); stroke-width: 7; stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; } .ai-widget-text { position: absolute; font-size: 13px; font-weight: 600; color: var(--w-text); letter-spacing: -0.03em; } .ai-widget-tooltip { visibility: hidden; opacity: 0; position: absolute; bottom: 76px; right: 0; background: var(--w-tooltip-bg); color: var(--w-tooltip-text); padding: 8px 12px; border-radius: 8px; font-size: 12px; line-height: 1.4; white-space: nowrap; box-shadow: var(--w-shadow); border: var(--w-border); transition: opacity 0.15s ease, visibility 0.15s ease; } .ai-widget-circle:hover .ai-widget-tooltip { visibility: visible; opacity: 1; } #ai-context-widget.ai-panel-open .ai-widget-tooltip { visibility: hidden !important; opacity: 0 !important; } .ai-widget-panel { display: none; position: absolute; bottom: 76px; right: 0; background: var(--w-tooltip-bg); color: var(--w-tooltip-text); padding: 10px; border-radius: 10px; box-shadow: var(--w-shadow); border: var(--w-border); flex-direction: column; gap: 6px; min-width: 230px; font-size: 12px; line-height: 1.4; z-index: 1000000; white-space: normal; } .ai-widget-panel.open { display: flex; } .ai-cm-limit-text { font-weight: 600; margin-bottom: 2px; } .ai-cm-row { display: flex; align-items: center; gap: 6px; } .ai-cm-input { width: 56px; padding: 4px 6px; border-radius: 6px; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12); color: inherit; font-family: inherit; font-size: 12px; -webkit-appearance: textfield; -moz-appearance: textfield; appearance: textfield; } .ai-cm-input::-webkit-outer-spin-button, .ai-cm-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; } .ai-cm-spin { display: flex; flex-direction: column; margin-left: -2px; } .ai-cm-spin button { cursor: pointer; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12); color: inherit; font-size: 8px; line-height: 1; padding: 2px 5px; font-family: inherit; } .ai-cm-spin button:first-child { border-radius: 4px 4px 0 0; border-bottom: none; } .ai-cm-spin button:last-child { border-radius: 0 0 4px 4px; } .ai-cm-spin button:hover { background: rgba(127,127,127,0.32); } .ai-cm-btn { cursor: pointer; border: none; border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; background: rgba(127,127,127,0.18); color: inherit; text-align: left; } .ai-cm-btn:hover { background: rgba(127,127,127,0.32); } .ai-cm-hint { opacity: 0.72; font-size: 11px; } </style> <div class="ai-widget-circle"> <svg viewBox="0 0 100 100"> <defs> <linearGradient id="gemini-gradient" x1="0%" y1="0%" x2="100%" y2="100%"> <stop offset="0%" stop-color="#4285F4" /> <stop offset="50%" stop-color="#9B51E0" /> <stop offset="100%" stop-color="#EA4335" /> </linearGradient> </defs> <circle class="ai-widget-bg" cx="50" cy="50" r="43"/> <circle class="ai-widget-fill" cx="50" cy="50" r="43"/> </svg> <div class="ai-widget-text">0.0%</div> <div class="ai-widget-tooltip">Загрузка контекста...</div> </div> <div class="ai-widget-panel"> <div class="ai-cm-limit-text">Авто-порог</div> <div class="ai-cm-row"><input type="number" min="1" max="100" step="1" class="ai-cm-input" placeholder="Авто"><span class="ai-cm-spin"><button type="button" class="ai-cm-spin-up" tabindex="-1" aria-label="увеличить порог">▲</button><button type="button" class="ai-cm-spin-down" tabindex="-1" aria-label="уменьшить порог">▼</button></span><span>% от Авто</span></div> <div class="ai-cm-row"><button class="ai-cm-btn ai-cm-snap">📌 Текущее = 100%</button><button class="ai-cm-btn ai-cm-auto">↺ Авто</button></div> <div class="ai-cm-hint">Порог в % от Авто-порога (оценённой точки, где модель начинает забывать). 100% = как Авто. Меньше = строже: цвета и % считаются от этого порога. Пример: порог 10% → жёлтый, когда Авто≈5%, красный при Авто≈8%.</div> </div>`;
  document.body.appendChild(container);
  widgetElement = container;
  applyNativeStyles(container);
  const circleEl = container.querySelector('.ai-widget-circle');
  const panelEl = container.querySelector('.ai-widget-panel');
  const snapBtn = container.querySelector('.ai-cm-snap');
  const autoBtn = container.querySelector('.ai-cm-auto');
  const inputEl = container.querySelector('.ai-cm-input');
  const upBtn = container.querySelector('.ai-cm-spin-up');
  const dnBtn = container.querySelector('.ai-cm-spin-down');
  if (circleEl && panelEl) {
    circleEl.addEventListener('click', () => {
      panelEl.classList.toggle('open');
      container.classList.toggle('ai-panel-open');
      if (panelEl.classList.contains('open')) updatePanel();
    });
  }
  if (snapBtn) snapBtn.addEventListener('click', snapCurrentPct);
  if (autoBtn) autoBtn.addEventListener('click', resetSafePct);
  if (inputEl) inputEl.addEventListener('change', (e) => setSafePctFromInput(e.target.value));
  if (upBtn) upBtn.addEventListener('click', () => stepSafePct(+1));
  if (dnBtn) dnBtn.addEventListener('click', () => stepSafePct(-1));
  updatePanel();
  const themeObserver = new MutationObserver(() => applyNativeStyles(container));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  processAndSend();
}
function updateWidget(percentage, tokens, effectiveLimit, contextLimit, displayLimit, modelName, attachBreak) {
  if (!widgetElement) return;
  const circle = widgetElement.querySelector('.ai-widget-fill');
  const percentText = widgetElement.querySelector('.ai-widget-text');
  const tooltip = widgetElement.querySelector('.ai-widget-tooltip');
  if (!circle || !percentText) return;
  const radius = 43;
  const circumference = 2 * Math.PI * radius;
  const pDraw = Math.min(100, Math.max(0, percentage));
  const offset = circumference - (pDraw / 100) * circumference;
  circle.style.strokeDasharray = circumference;
  circle.style.strokeDashoffset = offset;
  circle.style.stroke = zoneColor(percentage);
  percentText.textContent = percentage.toFixed(1) + '%';
  if (tooltip) {
    const limLine = (typeof safePct === 'number' && safePct > 0)
      ? `Предел: ${safePct}% от Авто = ${displayLimit.toLocaleString()} ток`
      : `Предел: Авто = ${effectiveLimit.toLocaleString()} ток`;
    let html =
      `Модель: ${modelName}<br>` +
      `Токены: ${tokens.toLocaleString()}<br>` +
      `${limLine}<br>` +
      `Окно модели: ${contextLimit.toLocaleString()}`;
    if (attachBreak && (attachBreak.imgCount > 0 || attachBreak.docCount > 0)) {
      html += `<br>Вложения ≈ ${(attachBreak.imgTokens + attachBreak.docTokens).toLocaleString()} токенов`;
      if (attachBreak.imgCount > 0) html += `<br>· картинки: ${attachBreak.imgCount} шт ≈ ${attachBreak.imgTokens.toLocaleString()} (по 2 тайла)`;
      if (attachBreak.docCount > 0) html += `<br>· файлы: ${attachBreak.docCount} шт ≈ ${attachBreak.docTokens.toLocaleString()} (оценочно)`;
    }
    tooltip.innerHTML = html;
  }
}
// ========== СЛУШАТЕЛЬ POPUP ==========
if (isExtensionValid()) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_STATS') {
      if (currentAdapter && (isInitialized || (baseSeen && baseComplete))) {
        const messages = currentAdapter.extractMessages();
        const effective = getEffectiveText();
        const fullText = effective ? effective : currentAdapter.getFullDialogText();
        const countForTokens = effective ? getEffectiveCount(messages.length) : messages.length;
        const modelId = resolveCurrentModel();
        let tokenEstimate = netServerTokens > 0 ? netServerTokens : Tokenizer.estimateDialogTokens(fullText, countForTokens);
        if (netServerTokens === 0 && netEffectiveLen > 0 && fullText && fullText.length > 0 && netEffectiveLen > fullText.length) {
          tokenEstimate = Math.round(tokenEstimate * (netEffectiveLen / fullText.length));
        }
        tokenEstimate += netAttachTokens;
        const displayTokens = Math.max(tokenEstimate, maxTokenCount);
        const contextLimit = ModelConfig.getContextLimit(modelId);
        const effectiveLimit = ModelConfig.getEffectiveLimit(modelId);
        const displayLimit = computeEffectiveLimit(modelId);
        const percent = displayLimit > 0 ? Math.round((displayTokens / displayLimit) * 1000) / 10 : 0;
        sendResponse({
          data: {
            site: currentAdapter.siteName,
            modelName: ModelConfig.getModel(modelId)?.name || modelId,
            tokenCount: displayTokens,
            contextLimit: effectiveLimit,
            percentage: percent,
            messageCount: messages.length
          }
        });
      } else {
        sendResponse({ data: null });
      }
    }
    return true;
  });
}
// ========== ЗАПУСК ==========
setTimeout(() => initialize(), 1500);
// ========== ГОРЯЧАЯ КЛАВИША Ctrl+Shift+D: скачать JSON дампа ==========
document.addEventListener('keydown', function (e) {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    var turns = [];
    for (var i = 0; i < lastBaseIds.length; i++) {
      var t = lastBaseTexts[i] || '';
      turns.push({ id: lastBaseIds[i], len: t.length,
        preview: t.slice(0, 60).replace(/\s+/g, ' ') });
    }
    var payload = {
      convId: (location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/) || [])[1] || '',
      count: lastBaseIds.length,
      turns: turns
    };
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'ai-cm-history-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      console.log('[byok-dump] дамп истории скачан: ' + payload.count + ' ходов');
    } catch (err) {
      console.warn('[byok-dump] не удалось скачать дамп:', err);
    }
  }
});

// ========== СЛУШАТЕЛЬ НАСТРОЕК ==========
if (isExtensionValid()) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.showWidget) {
      if (changes.showWidget.newValue === false) {
        const widget = document.getElementById('ai-context-widget');
        if (widget) widget.remove();
        widgetElement = null;
      } else {
        createWidget();
        if (lastWidgetData) {
          updateWidget(lastWidgetData.percentage, lastWidgetData.tokenEstimate,
            lastWidgetData.effectiveLimit, lastWidgetData.contextLimit, lastWidgetData.displayLimit, lastWidgetData.modelName, lastWidgetData.attachBreak);
        }
      }
    }
    const sk = safePctKey();
    if (changes[sk]) {
      const v = changes[sk].newValue;
      safePct = (typeof v === 'number' && v > 0) ? v : null;
      updatePanel();
      if (isInitialized) processAndSend();
    }
    // BYOK: слушаем изменения API-ключа и флага точного подсчёта
    if (changes.ai_cm_exact_token_count || changes.ai_cm_gemini_api_key) {
      loadByokSettings();
      // Сбрасываем кэш при смене настроек, чтобы новый ключ/флаг применился сразу
      lastCountTokensText = '';
      lastCountTokensCache = 0;
      netServerTokens = 0; // при отключении BYOK сразу эвристика
      if (isInitialized) processAndSend();
    }
  });
}

