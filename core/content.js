(function () {
  let v = 'unknown';
  try { v = chrome.runtime.getManifest().version; } catch (e) { v = 'unknown'; }
  console.log('AI Context Monitor v' + v + ' — индикатор заполнения контекста (ChatGPT, Gemini, DeepSeek, Claude, Perplexity, Google Search AI)');
})();
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
let badgeSuppressed = false; // v1.8.1: true после RESET — до первого снимка нового чата бейдж не рисуем
let maxTokenCount = 0;
let restoredTapeLoaded = false; // v28: флаг однократного восстановления ленты при загрузке чата
let restoreDone = false; // v30: флаг завершения восстановления — разрешает сохранение ленты только после restore
let cacheRefreshPlanned = {}; // v30.6: convId → true — планирование уточнения после кэша один раз на чат за сессию
let tapeRestoreSeen = {}; // v77: convId → true — лента для этого чата уже восстановлена в этой сессии страницы (O2)
var aiCmTapeAccountIdx = {}; // v82 (D8): convId → account index на момент последнего tape load
var aiCmRestoredDispatched = {}; // v82 (D9-A): convId → true — ai-cm-restored-history уже диспатчен (page-session)
// ========== ГИБРИД: БАЗА (сеть) + ХВОСТ (DOM по кэшу базы) ==========
let baseText = '';
let baseCount = 0;
let baseSeen = false;
let baseComplete = false; // сеть дала ПОЛНУЮ историю (тихая пагинация) → индикатор берёт число из базы, не из DOM
let lastBounded = false;  // последний DOM-хвост нашёл границу (стабильный источник для монотонного максимума)
let lastTailSig = null;
let lastBaseSig = null;   // антиспам: сигнатура последней печати «📥 база полной истории»
let lastEmitSig = null;   // антиспам: сигнатура последней печати «[content-trace] EMIT принят»
let lastDrawSig = null;   // антиспам: сигнатура последней печати «[content-trace] DRAW»
let lastHybridTailSig = null; // антиспам: последняя напечатанная строка «[hybrid-tail]»

// v30.5: антиспам для skip reason=not-complete — печатаем не чаще 1 раза на convId,
// пока не пришла полная база. Сбрасывается вместе с fired при смене чата.
let notCompleteLogged = {};

// v30.8: заморозка бейджа на время скрытой загрузки лоадером Gemini
var aiCmLoaderFreeze = false;

let baseIdSet = null;
var lastBaseIds = [];
var lastBaseTexts = [];
let baseSkelSet = null;
let baseAnchors = null;
const ANCHOR_MIN = 40;

// ========== САМОДИАГНОСТИКА: флаг stale (интеграция могла устареть) ==========
let stale = false;      // сетевого снимка нет 12с, хотя диалог с сообщениями в DOM есть
let staleTimer = null;

// ========== ЭКСПОРТ ИСТОРИИ (aiCmHistory) ==========
// Роли сообщений берём из detail.messages перехватчика (если есть);
// иначе — фолбэк: первое сообщение user, далее чередование user/assistant.
let lastDetailMessages = null; // [{role,text}] из последнего detail.messages (или null)
let lastHistoryWroteKey = null; // сигнатура 'baseCount|textLen' последней записи aiCmHistory
let lastThreadId = null; // threadId последнего применённого снимка Google (для сброса при SPA-возврате)
// M-8: TTL-метка per-host записи истории. Глобальный ключ 'aiCmHistory' пишется прежней
// формой (сам snapshot, без ts) — его семантика не меняется; поле ts аддитивно только
// для 'aiCmHistory:<host>'. По ts core/background.js удаляет записи старше 30 дней.
function aiCmHostHistoryRecord(snapshot) {
  var rec = Object.assign({}, snapshot);
  rec.ts = Date.now();
  return rec;
}
// v31: страховочная чистка перед записью экспорта истории.
// Единая санация вынесена в utils/gemini-batchexecute-parser.js (sanitizeGeminiText):
//   strip /$AXzLiR[A-Za-z0-9+\/=\s]+/g, точную строку "File attachment was not previously
//   registered" и /\[cite:\s*\d+\]/g. Здесь — делегирование к парсеру с локальным фолбэком
//   на случай, если парсер ещё не загрузился.
function sanitizeGeminiText(s) {
  if (typeof window !== 'undefined' && window.GeminiBatchexecuteParser && window.GeminiBatchexecuteParser.sanitizeGeminiText) {
    return window.GeminiBatchexecuteParser.sanitizeGeminiText(s);
  }
  if (typeof s !== 'string') return s;
  return s
    .replace(/\$AXzLiR[A-Za-z0-9+\/=\s]+/g, ' ')
    .replace(/File attachment was not previously registered/g, '')
    .replace(/\[cite:\s*\d+\]/g, '');
}
// v81: единая точка источников сообщений для экспорта — приоритет:
// detail.messages (последний EMIT) → lastBaseTexts с ролями → currentAdapter.extractMessages()
// (нормализация к {role,text}) → фолбэк чередования ролей. Используется в
// buildHistoryMessages(), aiCmWriteCurrentHistory() и doAutoExportDownload().
function aiCmCollectExportSource() {
  var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
  var texts = lastBaseTexts || [];
  // v82 (D2): выбор источника — чистая функция пайплайна: baseSeen=true → ТОЛЬКО сеть,
  // baseSeen=false → DOM-адаптер (сетевая ветка с пустыми texts даёт [] — потребители skip).
  var source = (P && typeof P.pickExportSource === 'function')
    ? P.pickExportSource(baseSeen === true, texts.length > 0)
    : ((baseSeen && texts.length > 0) ? 'network' : 'adapter');
  var out = [];
  if (source === 'network') {
    if (Array.isArray(lastDetailMessages) && lastDetailMessages.length === texts.length && texts.length > 0) {
      for (var i = 0; i < texts.length; i++) {
        var r = (lastDetailMessages[i] && lastDetailMessages[i].role) || '';
        out.push({ role: (r === 'user') ? 'user' : 'assistant', text: sanitizeGeminiText(texts[i]) });
      }
    } else {
      for (var j = 0; j < texts.length; j++) {
        out.push({ role: (j % 2 === 0) ? 'user' : 'assistant', text: sanitizeGeminiText(texts[j]) });
      }
    }
    return out;
  }
  // v82 (D2): ветка DOM-адаптера — ТОЛЬКО при baseSeen=false
  try {
    if (currentAdapter && typeof currentAdapter.extractMessages === 'function') {
      var raw = currentAdapter.extractMessages() || [];
      var hasRoles = false;
      for (var k = 0; k < raw.length; k++) {
        if (raw[k] && (raw[k].role === 'user' || raw[k].role === 'assistant')) { hasRoles = true; break; }
      }
      var norm = (P && typeof P.normalizeExportMessages === 'function') ? P.normalizeExportMessages(raw) : [];
      if (norm.length > 0 && hasRoles) return norm;
      // фолбэк чередования ролей (роль в адаптере отсутствует)
      for (var n2 = 0; n2 < norm.length; n2++) {
        out.push({ role: (n2 % 2 === 0) ? 'user' : 'assistant', text: norm[n2].text });
      }
    }
  } catch (eA) { }
  return out;
}
function buildHistoryMessages() {
  // v81: поведение для Gemini побитово прежнее (detail.messages/lastBaseTexts — приоритет);
  // для не-Gemini добавлен источник DOM-адаптера с нормализацией и чередованием.
  // для не-Gemini добавлен источник DOM-адаптера с нормализацией и чередованием.
  return aiCmCollectExportSource();
}

// ================= v61diag: диагностика холодного старта (ТОЛЬКО логи, логика не тронута) =================
// FNV-1a 32-bit от id||text → 6 hex-символов (отпечаток хода для сравнения краёв ленты).
function aiCmDiagHash6(id, text) {
  try {
    var s = String(id || '') + '\u0000' + String(text || '');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('000000' + h.toString(16)).slice(-6);
  } catch (e) { return '000000'; }
}
// Синхронный запрос сводки turnsMap у MAIN-перехватчика (Gemini) через CustomEvent-мост.
function aiCmGeminiTurnsSnapshotSync() {
  try {
    var resp = null;
    var h = function (ev) { resp = ev.detail; };
    window.addEventListener('ai-cm-turns-snap-response', h, { once: true });
    window.dispatchEvent(new CustomEvent('ai-cm-turns-snap-request'));
    window.removeEventListener('ai-cm-turns-snap-response', h);
    return resp;
  } catch (e) { return null; }
}
// Дамп turnsMap в момент экспорта: авто-fired и ручной (md/txt).
function aiCmDumpTurnsSnapshot(tag, cid, msgs) {
  try {
    var snap = aiCmGeminiTurnsSnapshotSync();
    var msgsN = (snap && snap.msgs) || 0;
    var firstHash = '-', lastHash = '-', firstText = '', lastText = '';
    var bc = null, rs = null, cbs = null;
    if (snap && typeof snap === 'object') {
      firstHash = snap.firstMsgHash || '-';
      lastHash = snap.lastMsgHash || '-';
      firstText = snap.firstText || '';
      lastText = snap.lastText || '';
      bc = snap.baseComplete;
      rs = snap.reachedStart;
      cbs = snap.confirmedByScroll;
    }
    if (!msgsN && Array.isArray(msgs) && msgs.length > 0) {
      // фолбэк: перехватчик недоступен (не Gemini) — считаем по экспортируемым сообщениям
      msgsN = msgs.length;
      firstHash = aiCmDiagHash6('', msgs[0] && msgs[0].text);
      lastHash = aiCmDiagHash6('', msgs[msgs.length - 1] && msgs[msgs.length - 1].text);
      firstText = String((msgs[0] && msgs[0].text) || '').slice(0, 80).replace(/\s+/g, ' ');
      lastText = String((msgs[msgs.length - 1] && msgs[msgs.length - 1].text) || '').slice(0, 80).replace(/\s+/g, ' ');
    }
    if (bc === null) bc = (baseComplete === true);
    if (rs === null || cbs === null) {
      var conf = (aiCmBaseConfirmedByConv[cid] === 1);
      if (rs === null) rs = conf;
      if (cbs === null) cbs = conf;
    }
    debugLog('log', '[AI CM][turnsMap] ' + tag + ' convId=' + (cid || (snap && snap.convId) || '(none)') +
      ' msgs=' + msgsN +
      ' firstMsgHash=' + firstHash + ' lastMsgHash=' + lastHash +
      ' firstText="' + firstText + '" lastText="' + lastText + '"' +
      ' baseComplete=' + (bc ? 1 : 0) +
      ' reachedStart=' + (rs ? 'true' : 'false') +
      ' confirmedByScroll=' + (cbs ? 'true' : 'false') +
      ' scrollEngaged=' + (snap && snap.scrollEngaged ? 'true' : 'false')); // v66
  } catch (e) { }
}
// ==== конец v61diag ====

// T1-fix#3 (v1.16.3): источник сообщений файла автоэкспорта — ОБЪЕДИНЁННАЯ база MAIN
// (архив + live), а не последний EMIT. Архив вливается в turnsMap ПЕРВЫМ (content.js
// читает aiCmArchive:<convId> сразу при page-load), поэтому lastBaseTexts на момент
// экспорта мог нести одну архивную часть (live-прогон: 4 архивных хода в файле при
// базе 114). Решение принимает ЧИСТАЯ функция пайплайна (resolveExportSource) — здесь
// только синхронный мост (CustomEvent), сверка convId и нормализация ролей.
//   null                 — не Gemini / моста нет / чат не совпал / объединённая база не
//                          больше локального снимка → прежний путь 1:1;
//   { blocked:true, ... }— в базе ТОЛЬКО архив: файл писать нельзя (латч fired не ставим);
//   { msgs:[...], ... }  — сообщения объединённой базы (архив + live).
function aiCmExportBaseSource(convId, localMsgs) {
  try {
    var site = (currentAdapter && currentAdapter.siteName) || '';
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    if (!P || typeof P.resolveExportSource !== 'function') return null;
    if (site !== 'gemini') return null; // прочие сервисы: архив — только индикатор источника
    var snap = (typeof aiCmGeminiTurnsSnapshotSync === 'function') ? aiCmGeminiTurnsSnapshotSync() : null;
    var hasBridge = !!(snap && typeof snap === 'object');
    // чужая база (SPA-переход между чтением и экспортом) — мост не используем
    if (hasBridge && snap.convId && convId && String(snap.convId) !== String(convId)) hasBridge = false;
    var union = (hasBridge && Array.isArray(snap.messages)) ? snap.messages : [];
    var localN = Array.isArray(localMsgs) ? localMsgs.length : 0;
    var verdict = P.resolveExportSource({
      isGemini: true,
      bridge: hasBridge,
      archiveCount: (hasBridge && typeof snap.archiveCount === 'number') ? snap.archiveCount : 0,
      liveCount: (hasBridge && typeof snap.liveCount === 'number') ? snap.liveCount : null,
      baseCount: (hasBridge && typeof snap.baseMsgs === 'number') ? snap.baseMsgs : 0,
      localCount: localN
    });
    if (!verdict || verdict.action === 'local') return null;
    if (verdict.action === 'block') {
      return {
        blocked: true, reason: verdict.reason,
        baseCount: (hasBridge && typeof snap.baseMsgs === 'number') ? snap.baseMsgs : 0,
        liveCount: (hasBridge && typeof snap.liveCount === 'number') ? snap.liveCount : 0,
        archiveCount: (hasBridge && typeof snap.archiveCount === 'number') ? snap.archiveCount : 0
      };
    }
    var out = [];
    for (var i = 0; i < union.length; i++) {
      var m = union[i] || {};
      if (typeof m.text !== 'string' || !m.text) continue;
      out.push({ role: (m.role === 'user') ? 'user' : 'assistant', text: m.text });
    }
    if (out.length <= localN) return null; // объединённая база не больше снимка EMIT — прежний путь
    return {
      blocked: false, msgs: out, baseCount: union.length,
      liveCount: (typeof snap.liveCount === 'number') ? snap.liveCount : 0,
      archiveCount: (typeof snap.archiveCount === 'number') ? snap.archiveCount : 0
    };
  } catch (eEbs) { return null; }
}

// Самодиагностика: через 12с после загрузки/смены диалога, если диалог с сообщениями
// в DOM есть (isInitialized=true и extractMessages()>0), но сетевой снимок не пришёл
// (baseSeen=false) — взводим stale. На пустых чатах extractMessages()=0 → не взводим.
function scheduleStaleCheck() {
  if (!isExtensionValid()) return;
  try { clearTimeout(staleTimer); } catch (e) { }
  stale = false;
  staleTimer = setTimeout(function () {
    staleTimer = null;
    if (isInitialized && !baseSeen) {
      var hasMessages = false;
      try {
        if (currentAdapter) {
          var msgs = currentAdapter.extractMessages();
          hasMessages = !!msgs && msgs.length > 0;
        }
      } catch (e) { hasMessages = false; }
      if (hasMessages) {
        stale = true;
        processAndSend();
      }
    }
  }, 12000);
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

// Версия логики парсинга Gemini (PARSER_VERSION из utils/gemini-batchexecute-parser.js).
// Ключ ленты включает версию: протухшие записи другой версии не читаются и не мигрируются.
function geminiParserVersion() {
  try {
    if (typeof window !== 'undefined' && window.GeminiBatchexecuteParser && window.GeminiBatchexecuteParser.PARSER_VERSION) {
      return window.GeminiBatchexecuteParser.PARSER_VERSION;
    }
  } catch (e) { }
  return '';
}
// v34: индекс аккаунта из /u/N в URL — в ключе хранилища, чтобы ленты разных
// аккаунтов (один и тот же convId теоретически возможен) не смешивались.
function getAccountIndex() {
  try {
    var m = location.pathname.match(/\/u\/(\d+)\//);
    return m ? m[1] : '0';
  } catch (e) { return '0'; }
}
function geminiTapeKey(convId) {
  return STORAGE_PREFIX + geminiParserVersion() + '-u' + getAccountIndex() + '-' + convId;
}

var GeminiTapeStore = {
  load: function (convId) {
    if (!isExtensionValid() || !convId) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var key = geminiTapeKey(convId);
      chrome.storage.local.get([key], function (data) {
        var entry = data[key];
        if (!entry) { resolve(null); return; }
        // обновляем ts при каждом обращении
        entry.meta = entry.meta || {};
        entry.meta.ts = Date.now();
        // пишем обновлённый ts обратно (fire-and-forget)
        var kv = {};
        kv[key] = entry;
        chrome.storage.local.set(kv);
        resolve(entry);
      });
    });
  },

  save: function (convId, turns, meta) {
    if (!isExtensionValid() || !convId || !turns || !turns.length) return Promise.resolve();
    var self = this;
    meta = meta || {};
    meta.ts = Date.now();
    meta.version = geminiParserVersion();
    meta.orderVersion = 2; // v1.6 (D15a-2): версия порядка ленты
    // v1.6 (D18): tape-save пишет ОБЪЕДИНЕНИЕ существующего тейпа и текущей базы по id —
    // msgs НИКОГДА не меньше прежнего (хвостовое окно сети не уничтожает старшие ходы).
    return new Promise(function (resolve) {
      self.load(convId).then(function (entry) {
        var existing = (entry && entry.turns) || [];
        var unionTurns = turns;
        var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
        if (P && typeof P.unionTurnsById === 'function') {
          var u = P.unionTurnsById(existing, turns);
          if (u.length > turns.length) unionTurns = u;
        } else if (existing.length > turns.length) {
          unionTurns = existing; // фолбэк: не уменьшать тейп
        }
        debugLog('log', '[AI CM][tape-save] convId=' + convId + ' action=written msgs=' + unionTurns.length +
          (unionTurns.length > turns.length ? ' (union с прежним тейпом ' + existing.length + ')' : ''));
        var record = { turns: unionTurns, meta: meta };
        var kv = {};
        kv[geminiTapeKey(convId)] = record;
        chrome.storage.local.set(kv, function () {
          GeminiTapeStore._touchIndex(convId).then(resolve);
        });
      });
    });
  },

  remove: function (convId) {
    if (!isExtensionValid() || !convId) return Promise.resolve();
    return new Promise(function (resolve) {
      // v34: ключ ленты теперь включает версию/аккаунт — удаляем по фактическому ключу
      chrome.storage.local.remove([geminiTapeKey(convId), STORAGE_INDEX_PREFIX + convId], function () {
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
// v47: имя модели СНИМКА (сеть/тэйп/адаптер) — для экспорта, который остаётся
// привязан к модели, писавшей ответы, а не к выбранной в UI.
let lastSnapshotModelName = '';

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
// H19: оверрайды попапа (chrome.storage.sync) — раньше писались и НЕ читались.
let popupRawModel = null;  // сырое selectedModel из попапа ('auto' = Автоопределение)
let popupRawPct = null;    // сырое customLimit из попапа («Лимит контекста» = % от Авто)
let popupModelId = null;   // канонический id выбранной модели; null = Автоопределение
let popupLimitPct = null;  // 1..100; null = Авто (поле пустое)
function safePctKey() { return 'ai_cm_safe_pct_' + getServiceKey(); }
function zoneColor(p) { if (p < 50) return '#22c55e'; if (p < 80) return '#eab308'; return '#ef4444'; }
// H19: активный % от Авто. Приоритет: порог виджета (per-service, точнее) →
// порог попапа (глобальный) → Авто (null). Дефолтный путь (оба null) и поле «100»
// (по определению = как Авто) — байтово прежние (в т.ч. текст панели/тултипа).
function aiCmActivePct() {
  if (typeof safePct === 'number' && safePct > 0) return safePct;
  if (typeof popupLimitPct === 'number' && popupLimitPct > 0 && popupLimitPct !== 100) return popupLimitPct;
  return null;
}
function computeEffectiveLimit(modelId) {
  return ModelConfig.computeDisplayLimit(modelId, aiCmActivePct());
}
// H19: чтение/применение оверрайдов попапа. changed=false (ничего не сохранено) →
// никаких перерисовок — дефолтный путь байтово идентичен.
function aiCmSetPopupOverrides(rawModel, rawPct) {
  popupRawModel = (rawModel === undefined) ? null : rawModel;
  popupRawPct = (rawPct === undefined) ? null : rawPct;
  aiCmRefreshPopupOverrides();
}
function aiCmRefreshPopupOverrides() {
  const m = ModelConfig.resolvePopupModelId(popupRawModel);
  const p = ModelConfig.resolveLimitPct(popupRawPct);
  const changed = (m !== popupModelId) || (p !== popupLimitPct);
  popupModelId = m;
  popupLimitPct = p;
  if (!changed) return;
  debugLog('log', '[model-detect] H19 popup-override model=' + (popupModelId || 'авто') +
    ' pct=' + (popupLimitPct == null ? 'авто' : popupLimitPct));
  updatePanel();
  if (isInitialized) processAndSend();
}
function aiCmLoadPopupOverrides() {
  try {
    if (!isExtensionValid() || !chrome.storage || !chrome.storage.sync) return;
    chrome.storage.sync.get(['selectedModel', 'customLimit'], function (d) {
      try { aiCmSetPopupOverrides(d && d.selectedModel, d && d.customLimit); } catch (eA) { }
    });
  } catch (e) { debugLog('log', '[model-detect] H19 popup-override load error: ' + (e && e.message || e)); }
}
function updatePanel() {
  if (!widgetElement) return;
  const status = widgetElement.querySelector('.ai-cm-limit-text');
  const input = widgetElement.querySelector('.ai-cm-input');
  if (!status) return;
  const effLim = lastWidgetData ? lastWidgetData.effectiveLimit : 0;
  const pct = aiCmActivePct();
  if (pct != null) {
    const eff = Math.max(1, Math.round(pct / 100 * effLim));
    status.textContent = 'Порог ' + pct + '% = ' + eff.toLocaleString() + ' ток';
    if (input) input.value = pct;
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
  // v53: чистка поздних re-check и курсорных флагов при смене чата (не перетекают в другой чат)
  try { aiCmLateCheckByConv = {}; aiCmCursorLiveByConv = {}; } catch (eReset) { }
  // v1.13.1: подтверждение полноты (reachedStart) тоже не перетекает в другой чат
  try { aiCmBaseConfirmedByConv = {}; } catch (eReset2) { }
  // v63: low-confidence флаг тоже не перетекает в другой чат
  try { aiCmLowConfidenceByConv = {}; } catch (eResetLc63) { }
  // v54: сброс детектора обрезки и pre-trim латчей при смене чата (не перетекают в другой чат)
  try { trimProbe = {}; preTrimExportFired = {}; trimRetryByConv = {}; } catch (eTrimReset) { }
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
  lastThreadId = null;
  detectedModelSlug = '';
  netAttachTokens = 0;
  netAttachBreak = null;
  netServerTokens = 0;
  netEffectiveLen = 0;
  lastCountTokensText = '';
  lastCountTokensCache = 0;
  lastPercentage = -1;
  lastResolvedModelId = null;
  lastSnapshotModelName = ''; // v47: модель снимка тоже сбрасывается при смене чата
  restoredTapeLoaded = false; // v28: разрешаем повторное восстановление при смене чата
  cacheRefreshPlanned = {}; // v30.8: сброс — каждый новый SPA-вход в чат снова планирует уточнение после кэша
  restoreDone = false; // v30: сбрасываем флаг восстановления при смене чата
  // v1.6 (D19): per-conv сторожа «уже восстановлено» и дедуп dispatch (v77/D9-A,
  // page-session) сбрасываются ТОЛЬКО на смене чата — SPA-возврат обязан ре-мержить
  // ленту (база=тейп∪сеть, голова истинная). Внутри одного непрерывного визита они
  // остаются — двойной ingest недопустим.
  tapeRestoreSeen = {};         // v77: повторный load/restore для нового входа в чат
  aiCmRestoredDispatched = {};  // v82 (D9-A): повторный dispatch ai-cm-restored-history
  // T1 (v1.16): первый ярус — тот же принцип, что у ленты (v1.6 D19): SPA-возврат в чат
  // обязан ПОВТОРНО прочитать архив и влить его в новую (очищенную) базу. Внутри одного
  // непрерывного визита дедуп сохраняется — повторный dispatch/merge недопустим.
  aiCmArchiveLoadStarted = {};
  aiCmArchiveRestoredDispatched = {};
  aiCmArchiveCountByConv = {}; // T1-fix#2 (v1.16.2): count архива перечитывается на новом входе
  lastEmitConvId = ''; // v35: сброс convId последнего снимка — экспорт старого чата запрещён до нового EMIT
  // v82 (D6): pct прошлого чата не должен стрелять в 0→1 re-check/loader-stop re-check
  // нового чата — гейты autoExportLastPct >= 0 молчат до первого реального pct нового чата.
  autoExportLastPct = -1;
  // v82 (D14): SPA-вход в чат — новый вход = один новый fired. Сбрасываем латч
  // автоэкспорта для целевого conv (per service+convId); внутри входа повторный
  // fired по-прежнему запрещён (already-fired). На холодном открытии латч пуст —
  // сброс no-op, поведение побайтово.
  // v1.18 (F2): для GSA сброс НЕ делаем. Перехватчик на SPA-возврате эмитит КЭШ треда
  // с historyComplete=true, поэтому снятый латч дал бы второй файл того же разговора
  // («SPA-возврат с уже снятым latch → повторный fired» запрещён). Латч GSA живёт по
  // site+threadId и переживает уход/возврат в пределах сессии страницы.
  try {
    var cidD14 = getCurrentConvId() || '';
    var P14 = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    var siteD14 = (currentAdapter && currentAdapter.siteName) || '';
    if (siteD14 === 'google_search') {
      debugLog('log', '[AI CM][auto-export] site=google_search latch kept reason=spa-entry convId=' +
        (cidD14 || '(threadId)'));
    } else if (P14 && typeof P14.resetAutoExportFired === 'function') {
      P14.resetAutoExportFired(autoExportFired, siteD14, cidD14);
      // v1.14.1 (O3): session-латч целевого conv снимаем синхронно с L1 — семантика
      // D14 «новый вход = один новый fired» сохраняется и для другой вкладки.
      try {
        if (P14.firedSessionKey && chrome.storage.session) {
          chrome.storage.session.remove(P14.firedSessionKey(siteD14, cidD14));
        }
      } catch (eO3D14) { }
    } else if (cidD14) {
      delete autoExportFired[cidD14];
    }
  } catch (eD14c) { }
  stale = false; // сбрасываем флаг устаревшей интеграции
  scheduleStaleCheck(); // фиксируем момент смены диалога для 12с-проверки
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
    if (pt) pt.textContent = '—'; // v1.8.1: «—» вместо ложного 0.0% до первых данных
    if (tt) tt.innerHTML = 'Загрузка контекста...';
  }
  badgeSuppressed = true; // v1.8.1: до первого badge-recv нового convId бейдж не обновляем
  lastWidgetData = null; // v1.8.1: старые данные предыдущего чата более недействительны
  // H23-cosmetic (v1.15.3): 3с-фолбэк request-emit старого чата не должен стрелять в новый —
  // висящий таймер гасим, иначе после SPA-перехода уходит лишний 'ai-cm-request-emit'
  // (MAIN отвечает ретейном, который уже обнулён reset-ом в intercept: пустой ре-эмит).
  // Флаг content-ready тоже обнуляем: новый чат = новый handshake (ре-эмит снимка нового чата).
  // Контракт H23 не меняется — те же события, те же миры, только гигиена таймера/флага.
  try {
    if (aiCmRequestEmitTimer) clearTimeout(aiCmRequestEmitTimer);
    aiCmRequestEmitTimer = null;
    aiCmContentReadySent = false;
  } catch (eH23c) { }
  debugLog('log', '[content] смена чата → состояние виджета сброшено');
}
// v55 (SPA): трекаем convId на content-стороне; при смене — лог, отмена висящего
// deferred-таймера старого разговора и сброс бейджа таба в SW.
var aiCmLastSeenConvId = getCurrentConvId() || '';
window.addEventListener('ai-cm-conversation-changed', function () {
  try {
    var newCid = getCurrentConvId() || '';
    if (newCid !== aiCmLastSeenConvId) {
      debugLog('log', '[AI CM][spa] conv-changed old=' + (aiCmLastSeenConvId || '(none)') +
        ' new=' + (newCid || '(none)') + ' (content)');
      // фикс бага A: висящий deferred-таймер старого разговора отменяем ДО его 60с-таймаута,
      // иначе он выгрузил бы историю ПРЕДЫДУЩЕГО чата. Экспорт-билдер перебиндовывается на
      // новый convId сам: lastEmitConvId='' и baseComplete=false в resetConversationState ниже.
      try { aiCmCancelDeferredHistWrite(''); } catch (eDw) { }
      // фикс бага B: per-tab бейдж со старого разговора («85») сбрасываем в SW;
      // актуальный поставит первый сработавший порог нового чата (THRESHOLD_PCT).
      try { chrome.runtime.sendMessage({ type: 'BADGE_RESET' }).catch(function () { }); } catch (eBr) { }
      aiCmLastSeenConvId = newCid;
    }
  } catch (eSpa) { }
  resetConversationState();
});
  // v30.8: сигнал лоадера «скроллер скрыт/восстановлен» — для заморозки бейджа
  window.addEventListener('ai-cm-loader-freeze', function (ev) {
    try {
      aiCmLoaderFreeze = !!(ev.detail && ev.detail.on);
      // v30.9: на разморозке рисуем накопленное значение сразу — новый badge-update может не прийти
      if (!aiCmLoaderFreeze && lastWidgetData) {
        const d = lastWidgetData;
        updateWidget(d.percentage, d.tokenEstimate, d.effectiveLimit, d.contextLimit, d.displayLimit, d.modelName, d.attachBreak);
        debugLog('log', '[content-trace] badge-unfreeze: виджет обновлён pct=' + d.percentage);
      }
    } catch (e) { }
  });
// v55: DOM-догон — локальный пересчёт токенов по запросу перехватчика Gemini
// ('ai-cm-dom-emit-request' после тихого дебаунса DOM-мутаций ~2.5с, т.е. когда
// стриминг ответа завершён). Без сетевого запроса: baseText + DOM-хвост через
// существующий tokenEstimate (processAndSend → getEffectiveText). Убирает «лаг
// в одну реплику»: процент растёт сразу после стриминга, а не со следующим
// снапшотом. Гарды: есть база, вкладка активна, лоадер не бежит (не ломать пол);
// пересчёт только при (baseComplete || lastBounded) — иначе монотонный максимум
// мог бы быть затёрт DOM-оценкой. Дедуп с последующим сетевым снапшотом даёт
// существующий монотонный максимум (двойного роста быть не должно).
var aiCmLastDomEmitSig = null;
window.addEventListener('ai-cm-dom-emit-request', function () {
  try {
    if (!currentAdapter) return;
    if (document.hidden || document.visibilityState !== 'visible') return; // только активная вкладка
    if (!baseSeen || !baseText) return;        // нет базы — догонять нечем
    if (aiCmLoaderFreeze) return;              // скрытая загрузка лоадером — не трогаем
    var probe = getEffectiveText();            // обновляет lastBounded
    if (!(baseComplete || lastBounded)) {
      debugLog('log', '[AI CM][realtime] dom-emit skip: хвост без границы (unbounded) и база неполная');
      return;
    }
    var sig = baseCount + '|' + (probe ? probe.length : 0);
    if (sig === aiCmLastDomEmitSig) return;    // значение не изменилось — повторный эмит не нужен
    aiCmLastDomEmitSig = sig;
    processAndSend();
    debugLog('log', '[AI CM][realtime] dom-emit pct=' + lastPercentage + ' tokens=' + maxTokenCount);
  } catch (eDe) { }
});

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

// Gemini: DOM-хвост собираем через чистый парсер utils/gemini-dom-parser.js,
// чтобы исключить блоки мышления и включить HTML-таблицы как markdown.
function shouldUseGeminiDomParser() {
  try {
    if (currentAdapter && currentAdapter.siteName === 'gemini') return true;
  } catch (e) { }
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
    var txt = '';
    if (shouldUseGeminiDomParser()) {
      try {
        txt = (typeof GeminiDomParser !== 'undefined' && GeminiDomParser)
          ? GeminiDomParser.extractGeminiResponse(tailNodes[j]).text
          : '';
      } catch (e) {
        txt = (tailNodes[j].innerText || tailNodes[j].textContent || '').trim();
      }
    } else {
      txt = (tailNodes[j].innerText || tailNodes[j].textContent || '').trim();
    }
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
      lastTailSig = sig;
      // Антиспам: печатаем hybrid-tail только если текст изменился относительно последней печати.
      if (tail.diag !== lastHybridTailSig) {
        lastHybridTailSig = tail.diag;
        debugLog('log', '[hybrid-tail] ' + tail.diag);
      }
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

let lastEmitConvId = ''; // v34: convId последнего принятого снимка (гард экспорта)
let lastSnapConvId = ''; // v37: convId последнего снимка для сброса монотонного максимума
window.addEventListener('ai-cm-full-history', function (ev) {
  // v81 Step1: один флаг-лог на сессию страницы — дошло ли событие 'ai-cm-full-history'
  // до content.js для текущего сервиса. Поведение не меняется.
  try {
    if (!window.__aiCmEmitChannelSeen) {
      window.__aiCmEmitChannelSeen = true;
      var P1 = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
      debugLog('log', '[AI CM][svc-emit-trace] site=' + ((currentAdapter && currentAdapter.siteName) || '?') +
        ' emit-channel=received convId=' + ((P1 && P1.extractConvIdFromUrl(location.pathname)) || ''));
    }
  } catch (eEmit1) { }
  const detail = ev && ev.detail;
  if (!detail || !detail.text) return;
  // v38: trace приёма снимка — видно, что сообщение дошло до content.js
  debugLog('log', '[AI CM][trace] badge-recv convId=' + (detail.convId || '-') +
    ' msgs=' + (detail.count || 0) +
    ' tokens~' + (Math.round((detail.text || '').length / 4) + (detail.attachTokens || 0)));
  // v34/v38: гард по convId — снимок устаревшего чата отбрасываем ЦЕЛИКОМ,
  // но ТОЛЬКО пустой (msgs=0): валидный снимок (msgs>0) всегда доходит до UI
  // (от обнуления защищает гард parse-empty в перехватчике).
  var emitConvId = detail.convId || '';
  if (emitConvId && getCurrentConvId() && emitConvId !== getCurrentConvId() && !(detail.count > 0)) {
    debugLog('log', '[content] v38: пропущен ПУСТОЙ снимок чужого чата (emit=' + emitConvId + ', current=' + getCurrentConvId() + ')');
    return;
  }
  lastEmitConvId = emitConvId;
  badgeSuppressed = false; // v1.8.1: пришёл первый валидный снимок нового чата — бейдж снова обновляется
  // v37: смена чата по convId из снимка — сбрасываем монотонный максимум токенов.
  // Без этого после SPA-переключения бейдж держит старые pct/tokens предыдущего чата
  // (baseComplete=true не даёт сработать правилу перехода неполная→полная).
  if (emitConvId && emitConvId !== lastSnapConvId) {
    maxTokenCount = 0;
    lastSnapConvId = emitConvId;
    debugLog('log', '[content-trace] v37: новый convId снимка → maxTokenCount=0 (' + emitConvId.slice(0, 8) + ')');
  }
  // Сброс при смене threadId (Google SPA): сначала чистим состояние виджета, затем применяем базу.
  if (detail.threadId) {
    if (lastThreadId !== null && detail.threadId !== lastThreadId) {
      resetConversationState();
    }
    lastThreadId = detail.threadId;
  }
  // ФИКС: взводим baseComplete из флага перехватчика. При переходе «сеть стала полной» сбрасываем
  //   монотонный максимум, чтобы добить любой пик, накопленный DOM-путём до этого.
  // v1.18 (F1): ЕДИНСТВЕННАЯ точка вердикта полноты для всех сервисов, включая GSA:
  //   probe-классификатор страницы продолжения (utils/google-search-folwr-parser.js:
  //   kind=cursor-repeat|no-new-turns при ok=200 → complete=true)
  //   → applyTurns(..., true) → buildDetail(historyComplete=true) → это присваивание →
  //   baseComplete, который читает shouldSkipAutoExport/maybeAutoExport. Дублирующего
  //   вердикта в content.js нет и быть не должно (классификатор здесь не вызывается).
  const newBaseComplete = !!detail.historyComplete;
  var completeTransition79 = (newBaseComplete && !baseComplete); // v79: фиксируем переход 0→1 ДО перезаписи
  if (newBaseComplete && !baseComplete) {
    maxTokenCount = 0;
  }
  baseComplete = newBaseComplete;
  // v1.13.1: подтверждение полноты — baseComplete при reachedStart=true (Gemini);
  // для не-Gemini перехватчиков detail.reachedStart нет — гейт подтверждения не применяется.
  if (emitConvId) {
    aiCmBaseConfirmedByConv[emitConvId] = (newBaseComplete && detail.reachedStart === true) ? 1 : 0;
    // v63: флаг low-confidence базы (sanity-фолбэк без proof) — попадает в histSnapshot → имя файла
    try { aiCmLowConfidenceByConv[emitConvId] = (detail.isLowConfidenceBase === true); } catch (eLc63) { }
  }
  // v79: переход baseComplete 0→1 — re-check автоэкспорта. v82 (D1): блок ПЕРЕНЕСЁН
  // в КОНЕЦ слушателя (после присвоений baseText/lastBaseTexts/lastDetailMessages/baseSeen
  // и после финального processAndSend) — раньше вызов стоял ДО применения базы, fired шёл
  // на пустом сетевом источнике (текст из DOM-адаптера) и латч блокировал поздний
  // корректный экспорт. Семантика «один re-check на переход 0→1» сохранена.
  // v82 (D1): блок re-check удалён отсюда (был ДО присвоения базы) и перенесён
  // в конец слушателя — сразу после финального processAndSend().
  baseText = detail.text;
  baseCount = detail.count || 0;
  detectedModelSlug = detail.modelSlug || '';
  netAttachTokens = detail.attachTokens || 0;
  netAttachBreak = detail.attachBreak || null;
  netServerTokens = detail.serverTokens || 0;
  netEffectiveLen = (typeof detail.effectiveLen === 'number' && detail.effectiveLen > 0) ? detail.effectiveLen : 0;
  baseSeen = true;
  stale = false; // сетевой снимок пришёл — интеграция актуальна
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
  // Антиспам: печатаем базу/EMIT только при реальном изменении состояния (baseCount/textLen/baseComplete/effectiveLen).
  var baseSig = [baseCount, (baseText ? baseText.length : 0), (baseComplete ? 1 : 0), netEffectiveLen].join('|');
  if (baseSig !== lastBaseSig) {
    lastBaseSig = baseSig;
    console.log('📥 база полной истории: ' + baseCount + ' сообщений, кэш id=' + baseIdSet.size +
      ', скелетов=' + baseSkelSet.size + ', длинных якорей=' + baseAnchors.length +
      (detectedModelSlug ? ', slug из сети=' + detectedModelSlug : '') +
      (netAttachTokens > 0 ? ', вложения≈' + netAttachTokens + ' ток' : '') +
      (netServerTokens > 0 ? ', serverTokens=' + netServerTokens : '') +
      (baseComplete ? ', история ПОЛНАЯ по сети (индикатор по базе, DOM игнор)' : ''));
  }
  if (baseSig !== lastEmitSig) {
    lastEmitSig = baseSig;
    debugLog('log', '[content-trace] EMIT принят seq=' + (window.__aiCmTraceSeq || 0) + ' baseComplete=' + baseComplete + ' baseCount=' + baseCount + ' textLen=' + (baseText ? baseText.length : 0) + ' t=' + Date.now());
  }

  // v54: детектор обрезки истории в Gemini (спасательный pre-trim экспорт; гейты
  // автоэкспорта v51–v53 не задействованы — у спасательного экспорта свои инварианты).
  try { geminiDetectTrim(detail); } catch (eTrim) { }

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
  // v33: сохраняем ТОЛЬКО при baseComplete (сеть дала полную историю) — чтобы не записать
  // в ленту DOM-хвост, из-за которого экспорт после F5 отличался от экспорта после открытия.
  // v4x: пишем ленту ТОЛЬКО из санированных messages (detail.messages) — они уже
  // прошли sanitizeFinalMessages и содержат r1/turnId для связного списка порядка.
  if (restoreDone && baseComplete) {
    var convId = detail.convId || '';
    var msgs = Array.isArray(detail.messages) ? detail.messages : [];
    if (convId && msgs.length > 0) {
      var turns = [];
      for (var x = 0; x < msgs.length; x++) {
        var mm = msgs[x] || {};
        turns.push({
          id: (mm.id != null) ? String(mm.id) : '',
          text: mm.text || '',
          role: (mm.role === 'user') ? 'user' : 'assistant',
          r1: mm.r1 || null,
          turnId: mm.turnId || null
        });
      }
      // v66: диагностика записи ленты при baseComplete=1 (почему ленты может не быть на
      // следующем холодном открытии — лог 15:40: tape-restore action=empty после 14:54)
      debugLog('log', '[AI CM][tape-save] convId=' + convId + ' action=written msgs=' + turns.length +
        ' baseComplete=1');
      GeminiTapeStore.save(convId, turns, {
        count: detail.count || 0,
        effectiveLen: detail.effectiveLen || 0,
        modelSlug: detail.modelSlug || '',
        version: geminiParserVersion()
      });
    } else {
      // v66: полный снимок без messages — ленту записать не из чего; фиксируем причину
      debugLog('log', '[AI CM][tape-save] action=skipped reason=' +
        (!convId ? 'no-convId' : 'no-messages') + ' baseComplete=1 msgs=' + (msgs ? msgs.length : 0));
    }
  }

  // v82 (D1): re-check перехода 0→1 — теперь ПОСЛЕ присвоений базы и финального
  // processAndSend(): fired видит сетевой источник (lastBaseTexts), а не DOM-адаптер.
  if (completeTransition79) {
    try {
      var cid79 = emitConvId || lastEmitConvId || getCurrentConvId() || '';
      if (cid79) {
        if (aiCmLateCheckByConv[cid79]) {
          aiCmTryLateAutoExport(cid79);
        } else if (autoExportSettings.enabled === true && typeof autoExportLastPct === 'number' && autoExportLastPct >= 0) {
          debugLog('log', '[AI CM][auto-export] base-complete 0→1 check (не loader-stop) convId=' + cid79 + ' pct=' + autoExportLastPct);
          maybeAutoExport(autoExportLastPct);
        }
        // v83: если deferred-запись aiCmHistory ещё висит (loader-stop был при
        // base-unconfirmed) — флашим сразу при подтверждении полноты 0→1, не ждём 60s.
        // Гарды внутри flush сами требуют baseComplete && !loaderRunning.
        try { aiCmFlushDeferredHistWrite(cid79, 'base-complete'); } catch (eF79) { }
      }
    } catch (e79) { }
  }
  processAndSend();
});

// =============================================================================
// H23: гонка «ответ истории раньше слушателя» (claude.ai, живой лог 2026-09-09).
// Перехватчик (MAIN, document_start) может распарсить и эмитнуть снимок ДО того, как
// слушатель выше зарегистрирован (content.js — ISOLATED, document_idle): fire-once emit
// теряется, бейдж 0.0% и попап «Откройте поддерживаемый сайт» до F5. Контракт (канал —
// только CustomEvent, миры не меняются):
//   1) после создания адаптера content.js диспатчит 'ai-cm-content-ready' — но ТОЛЬКО если
//      первый снимок ещё не дошёл (иначе рабочий путь остаётся байтово прежним);
//   2) MAIN по нему ре-эмитит РЕТЕЙН последнего снимка (тот же detail, без перепарса);
//   3) фолбэк: если за 3с после init не было ни одного badge-recv — 'ai-cm-request-emit',
//      MAIN отвечает ретейном.
// Область H23 — только сервисы, чей MAIN-перехватчик реализует ретейн (сейчас claude):
// остальные (Gemini/ChatGPT/DeepSeek/Perplexity/Google Search) байтово прежние — им
// хватает собственных пост-инит фолбэков (virtual-F5/activeRefresh, loaderBadgeTimer,
// GSA-handshake). Гейты автоэкспорта (baseComplete/latch) не затронуты: ре-эмит идёт
// обычным путём слушателя выше, отдельного триггера экспорта не появляется.
// =============================================================================
var AI_CM_H23_SITES = ['claude'];
var aiCmContentReadySent = false;
var aiCmRequestEmitTimer = null;
function aiCmH23Site() {
  try { return !!currentAdapter && AI_CM_H23_SITES.indexOf(currentAdapter.siteName) !== -1; } catch (e) { return false; }
}
function aiCmDispatchContentReady() {
  if (aiCmContentReadySent) return;
  if (!aiCmH23Site()) return; // прочие сервисы — байтово прежнее поведение
  // Гард байтовой идентичности рабочего пути: если первый снимок УЖЕ дошёл до слушателя
  // (гонки не было), handshake не нужен — ре-эмит не выполняется вовсе, пост-F5 путь
  // остаётся прежним (emit-channel=received → fired → already-fired).
  if (window.__aiCmEmitChannelSeen) {
    debugLog('log', '[AI CM][emit-channel] content-ready пропущен — emit уже дошёл site=' +
      ((currentAdapter && currentAdapter.siteName) || '?'));
    return;
  }
  aiCmContentReadySent = true;
  try { window.dispatchEvent(new CustomEvent('ai-cm-content-ready')); } catch (eCr) { }
  debugLog('log', '[AI CM][emit-channel] content-ready site=' + ((currentAdapter && currentAdapter.siteName) || '?'));
  try {
    var siteCr = (currentAdapter && currentAdapter.siteName) || '';
    if (aiCmRequestEmitTimer) clearTimeout(aiCmRequestEmitTimer);
    aiCmRequestEmitTimer = setTimeout(function () {
      aiCmRequestEmitTimer = null;
      // badge-recv уже был (ре-эмит сработал) — повторный запрос не нужен
      if (window.__aiCmEmitChannelSeen) return;
      try { window.dispatchEvent(new CustomEvent('ai-cm-request-emit')); } catch (eRe) { }
      debugLog('log', '[AI CM][emit-channel] request-emit (3с без badge-recv) site=' + siteCr);
    }, 3000);
  } catch (eCr2) { }
}

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
    // v81: обобщено на 6 сервисов через utils/export-emit-pipeline.js:
    // Gemini /app/<id> и claude /chat/<uuid> сохранены 1:1; добавлены ветки
    // chatgpt.com /c/<id>, chat.deepseek.com /a/chat/s/<id>, perplexity.ai /thread/<id>;
    // google.com (Search AI) — надёжного id в URL нет → '' (не выдумываем).
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    if (P && typeof P.extractConvIdFromUrl === 'function') return P.extractConvIdFromUrl(location.pathname) || '';
    // фолбэк (утилита не загружена): прежняя логика v38
    var m = location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    var parts = location.pathname.split('/');
    var chatIdx = parts.indexOf('chat');
    if (chatIdx !== -1 && chatIdx + 1 < parts.length) return parts[chatIdx + 1];
    return '';
  } catch (e) { return ''; }
}
// H22/H24: in-app тема СЕРВИСА (Gemini «Настройки → Тема», Claude «Тема: тёмная») приоритетнее
// prefers-color-scheme.
// Признак 1 — класс-токены dark-theme/light-theme на html/body (Gemini: body.theme-host.dark-theme;
// CSS страницы: gemini-dom-sample.html:75 `:where(.theme-host):where(.dark-theme)`).
// H24: гейт токенов оставлен ТОЛЬКО Gemini — у claude.ai токенов темы в разметке нет
// (DOM-образца нет, тема живёт на computed-фоне; адаптер Claude DOM-парсинг не ведёт).
// Признак 2 (H24: ВСЕ сервисы) — computed-яркость НЕПРОЗРАЧНОГО фона [body, documentElement].
// H24 live (2026-09-09): у тёмного Claude тёмный фон лежит на body/обёртке, а documentElement
// прозрачен — прежний проб (Gemini-гейт + только html) давал null → фолбэк matchMedia (светлая ОС)
// → светлый виджет на чёрной странице. Поэтому проб обобщён: body первым, оба элемента, все сервисы.
// Правило паритета H22 НЕ меняется: СВЕТЛЫЙ фон никогда не понижает до light (светлые страницы
// всех шести сервисов байтово прежние — решает matchMedia, последний фолбэк).
// Возврат: 'dark' | 'light' | null (null → прежняя цепочка).
function aiCmInAppTheme() {
  try {
    const root = document.documentElement;
    const body = document.body;
    if (getServiceKey() === 'gemini') { // H22: токены темы есть только в разметке Gemini
      const cls = ((root && root.className) || '') + ' ' + ((body && body.className) || '');
      if (/(^|\s)dark-theme(\s|$)/.test(cls)) return 'dark';
      if (/(^|\s)light-theme(\s|$)/.test(cls)) return 'light';
      // Gemini может держать тему не на html/body, а на элементе-хосте .theme-host
      const hostEl = document.querySelector('.theme-host.dark-theme, .theme-host.light-theme');
      if (hostEl) return hostEl.classList.contains('dark-theme') ? 'dark' : 'light';
    }
    const probes = [body, root]; // H24: body первым — у claude.ai тёмный фон на body/обёртке
    for (let i = 0; i < probes.length; i++) {
      const el = probes[i];
      if (!el || typeof window.getComputedStyle !== 'function') continue;
      const c = window.getComputedStyle(el).backgroundColor || '';
      const m = c.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/);
      if (!m) continue;
      if (m[4] !== undefined && parseFloat(m[4]) === 0) continue; // прозрачный — не сигнал
      if ((0.2126 * (+m[1]) + 0.7152 * (+m[2]) + 0.0722 * (+m[3])) < 100) return 'dark';
    }
    return null;
  } catch (e) { return null; }
}
function isDarkMode() {
  const htmlClass = document.documentElement.classList;
  const bodyClass = document.body.classList;
  const dataTheme = document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme');
  if (htmlClass.contains('dark') || bodyClass.contains('dark') || dataTheme === 'dark') return true;
  if (htmlClass.contains('light') || bodyClass.contains('light') || dataTheme === 'light') return false;
  const inApp = aiCmInAppTheme(); // H22: тема сервиса важнее темы ОС
  if (inApp === 'dark') return true;
  if (inApp === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}
// H25 (live 2026-09-09, Claude): живой переключатель темы сервиса НЕ перекрашивал виджет до F5.
// Диагностика тёмной темы Claude без F5: body=rgb(21,21,21) (проб яркости его ловит), html прозрачен,
// htmlCls="cds-root h-screen antialiased scroll-smooth", bodyCls="bg-surface-1 text-primary font-sans
// min-h-screen chat-ui-core" — тема приходит ТОЛЬКО сменой CSS-переменных, атрибуты html/body не
// мутируют → themeObserver H22 молчит, matchMedia (тема ОС не менялась) молчит, и палитра читалась
// лишь при инициализации виджета → перекрас только после reload. Детект (aiCmInAppTheme, проб
// [body, root]) корректен — чиним ТРИГГЕР, а не детект.
// H25: медленный дубль-страховка для всех шести сервисов — сравнение isDarkMode() с последней
// ПРИМЕНЁННОЙ темой виджета. Запись делает сам applyNativeStyles, поэтому быстрый путь H22
// (themeObserver на класс-токены Gemini + matchMedia) остаётся байтово прежним.
// Гард тихого пути: при неизменной теме — НИ ОДНОЙ style-записи (никаких applyNativeStyles-вызовов).
let aiCmWidgetAppliedTheme = null; // true=dark, false=light, null=палитра ещё не применялась
let aiCmThemePollTimer = null;
const AI_CM_THEME_POLL_MS = 5000;
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
  aiCmWidgetAppliedTheme = isDark; // H25: единственный источник правды о применённой палитре
}
// H25: перекрас виджета ТОЛЬКО при фактической смене темы (isDarkMode() ≠ применённая палитра).
// Возврат true — палитра переприменена. Байтово тихий путь: при неизменной теме функция не
// пишет ни одного style-свойства и не вызывает applyNativeStyles.
function aiCmRefreshThemeIfNeeded() {
  try {
    const el = widgetElement;
    if (!el) return false;
    if (typeof el.isConnected === 'boolean' && !el.isConnected) return false; // виджет снят со страницы
    const nowDark = isDarkMode();
    if (aiCmWidgetAppliedTheme === nowDark) return false;
    applyNativeStyles(el); // перекрас круга/трека/текста/тултипа/панели по THEME_CONFIGS[site][dark|light]
    debugLog('log', '[AI CM][theme] палитра виджета перекрашена: ' + (nowDark ? 'dark' : 'light') +
      ' (live-смена темы сервиса, без reload)');
    return true;
  } catch (eTh25) { return false; }
}
// H25: страховочный опрос — тема сервиса может смениться без мутации атрибутов и без смены темы ОС.
function aiCmStartThemePoll() {
  aiCmStopThemePoll();
  aiCmThemePollTimer = setInterval(function () {
    if (!widgetElement || (typeof widgetElement.isConnected === 'boolean' && !widgetElement.isConnected)) {
      aiCmStopThemePoll(); // виджет удалён (showWidget=false / DOM вычищен страницей) — таймер гасим
      return;
    }
    aiCmRefreshThemeIfNeeded();
  }, AI_CM_THEME_POLL_MS);
}
function aiCmStopThemePoll() {
  if (aiCmThemePollTimer) { clearInterval(aiCmThemePollTimer); aiCmThemePollTimer = null; }
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
  // H23: слушатель ai-cm-full-history зарегистрирован, адаптер готов → handshake MAIN-миру
  // (ре-эмит потерянного снимка + 3с-фолбэк request-emit). Для прочих сервисов — no-op.
  aiCmDispatchContentReady();
  // S2: per-site порог автоэкспорта ('aiCmAutoExportPct_<siteName>') — до первых снапшотов
  loadAutoExportPerSitePct();
  loadByokSettings();
  loadByokCache();
  aiCmLoadPopupOverrides(); // H19: selectedModel/customLimit попапа → лимит и токенизация
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
  let found = findMessageNodes();
  // Фолбэк для адаптеров без общих [data-message-*] (Google Search AI использует
  // [data-scope-id="turn"], которого нет в MSG_SELECTORS). Без этого isInitialized
  // остаётся false, processAndSend не пишет aiCmState → попап «Откройте поддерживаемый сайт».
  if (found.nodes.length === 0 && currentAdapter && typeof currentAdapter.extractMessages === 'function') {
    try {
      const ams = currentAdapter.extractMessages();
      if (ams && ams.length > 0) {
        found = { nodes: ams, sel: (currentAdapter.siteName || 'adapter') + '.extractMessages()' };
      }
    } catch (e) { }
  }
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
  // v48: subtree-наблюдение покрывает и кнопку button.input-area-switch — смена
  // выбранной модели меняет её текст (childList/characterData) → пересчёт pct.
}
// ========== ОПРЕДЕЛЕНИЕ МОДЕЛИ (v47: UI-приоритет + 3 слоя фолбэка) ==========
// v47: бейдж/попап/лимит должны считать от модели, ВЫБРАННОЙ в UI Gemini, а не от
// модели, писавшей последний ответ (снимок/тэйп). Сигналы по убыванию точности:
//  (1) checked-пункт открытого меню моделей ([aria-checked="true"]) — точная версия;
//  (2) текст кнопки выбора модели в композере — версия+семейство или только семейство
//      (тогда берём последнюю известную точную версию этого семейства);
//  нет сигнала / не распознан → фолбэк на прежнюю цепочку: снимок сети → DOM-адаптер.
const GEMINI_UI_MODEL_RE = /(?:gemini\s*)?(\d+(?:[.,]\d+)?)?\s*(ultra|pro|flash)(?:\s+(?:lite|расширенн[аяый]|extended|fast))?/i;
const geminiUiModelByFamily = {}; // 'pro'|'flash'|'ultra' -> последнее точное имя из UI
let lastModelSourceSig = '';

function extractUiModelText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return '';
  const m = t.match(GEMINI_UI_MODEL_RE);
  if (!m) return '';
  // страховка от ложных срабатываний: нужна версия ИЛИ слово gemini
  if (!m[1] && !/gemini/i.test(t)) return '';
  return m[0].trim();
}

function probeGeminiUiMenuChecked() {
  const items = document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]');
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.getAttribute('aria-checked') !== 'true' && !it.querySelector('[aria-checked="true"]')) continue;
    const name = extractUiModelText(it.textContent);
    if (name) return name;
  }
  return '';
}

// v48: нормализация слитного текста кнопки («ProРасширенный» → «Pro Расширенный»)
function normalizeUiModelText(text) {
  return String(text || '')
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// v49: семья(+вариант без версии) → канонический ключ. Приоритет точной версии:
//  (a) кэш точного имени из открытого меню (geminiUiModelByFamily);
//  (b) точная версия из сетевого снимка (snapModelId), если семья совпадает с DOM-семьёй;
//  (c) семейный дефолт ModelConfig (реальная линейка веб-UI, не 3.7-анонс).
// Род варианта не важен («Расширенный» == «Расширенная»).
function resolveFamilyVariantId(fam, variant, snapModelId) {
  // (a)
  const cached = geminiUiModelByFamily[fam];
  if (cached) {
    const cachedId = ModelConfig.resolveModelId(cached);
    if (cachedId) return cachedId;
  }
  // (b) сетевой снимок честен («3.6 Flash» / «3.1 Pro») — берём, если семья совпадает
  if (snapModelId) {
    const snapName = (ModelConfig.getModel(snapModelId) && ModelConfig.getModel(snapModelId).name) || '';
    const snapFam = snapName.match(/ultra|pro|flash/i);
    if (snapFam && snapFam[0].toLowerCase() === fam) return snapModelId;
  }
  // (c) реальный семейный дефолт веб-UI («3.6 Flash», «3.1 Pro», «3.5 Flash Lite»)
  const defId = ModelConfig.getFamilyDefaultModelId && ModelConfig.getFamilyDefaultModelId(fam, variant);
  if (defId) return defId;
  // страховочный фолбэк — всё же сетевая версия
  return snapModelId || '';
}

function probeGeminiUiButton(snapModelId) {
  // v48: реальный DOM Gemini — BUTTON.input-area-switch, текст слитный
  // («ProРасширенный», «FlashРасширенный», «Flash»). Кнопки нет → ''.
  const btn = document.querySelector('button.input-area-switch');
  if (!btn || !btn.textContent) return '';
  const text = normalizeUiModelText(btn.textContent);
  const m = text.match(GEMINI_UI_MODEL_RE);
  if (!m) return '';
  const famM = m[0].match(/ultra|pro|flash/i);
  if (!famM) return '';
  const fam = famM[0].toLowerCase();
  if (m[1]) { // версия есть прямо в кнопке — точное имя, обновляем кэш
    geminiUiModelByFamily[fam] = m[0].trim();
    return m[0].trim();
  }
  // только семья(+вариант): приоритеты v49 (кэш меню → снимок → семейный дефолт)
  const varM = m[0].match(/lite|расширенн[а-яё]*|extended|fast/i);
  return resolveFamilyVariantId(fam, varM ? varM[0] : '', snapModelId);
}

function detectSelectedModelFromDom(snapModelId) {
  // меню открыто — самый точный сигнал, обновляем кэш «последняя по семейству»
  const fromMenu = probeGeminiUiMenuChecked();
  if (fromMenu) {
    const famM = fromMenu.match(/ultra|pro|flash/i);
    if (famM) geminiUiModelByFamily[famM[0].toLowerCase()] = fromMenu;
    return fromMenu;
  }
  return probeGeminiUiButton(snapModelId) || '';
}

function resolveCurrentModel() {
  // v47: приоритет — выбранная в UI модель; фолбэк — снимок/тэйп/адаптер/дефолт.
  const rawFromNet = detectedModelSlug || '';
  const snapNetId = rawFromNet ? ModelConfig.resolveModelId(rawFromNet) : null;
  let uiRaw = '';
  try {
    if ((window.location.hostname || '').indexOf('gemini.google.com') !== -1) {
      // v49: передаём сетевую версию — приоритет (b) для DOM-сигнала без номера версии
      uiRaw = detectSelectedModelFromDom(snapNetId) || '';
    }
  } catch (e) { uiRaw = ''; }
  const uiResolved = uiRaw ? ModelConfig.resolveModelId(uiRaw) : null;
  if (uiRaw && !uiResolved) uiRaw = ''; // сигнал есть, но не распознан → фолбэк

  const rawFromDom = (rawFromNet || uiRaw) ? '' : (currentAdapter.detectModel() || '');
  const rawSnapshot = rawFromNet || rawFromDom || '';
  const snapModelId = rawSnapshot ? ModelConfig.resolveModelId(rawSnapshot) : null;

  // v47: экспорт остаётся на модели снимка — запоминаем её имя отдельно
  if (snapModelId) {
    lastSnapshotModelName = ModelConfig.getModel(snapModelId)?.name || snapModelId;
  }

  // H19: явный выбор модели в дропдауне попапа авторитетен для лимита и токенизации.
  // «Автоопределение» (popupModelId === null) → прежний путь: сетевой slug → DOM → дефолт.
  const raw = popupModelId || uiRaw || rawSnapshot || '';
  let modelId = raw ? ModelConfig.resolveModelId(raw) : null;
  let path;
  if (modelId) {
    path = popupModelId ? 'попап' : (uiRaw ? 'dom' : (rawFromNet ? 'сеть' : 'DOM'));
  } else {
    modelId = ModelConfig.getDefaultModel(currentAdapter.siteName);
    path = raw ? ((rawFromNet ? 'сеть' : 'DOM') + '→дефолт(не распознан)') : 'дефолт';
  }
  // v1.18 (F7): GSA — сеть может не дать slug вовсе (детектор GSA молчит, если в ответе нет
  // model:"…"), и имя модели снапшота оставалось пустым → сегмент модели в имени файла
  // автоэкспорта падал в фолбэк 'model'. Заполняем ОДНОЙ точкой ЗДЕСЬ — ровно той моделью,
  // что показывает badge-update: ModelConfig.getModel(modelId)?.name, где modelId идёт по
  // пути попап → сеть → DOM → дефолт сайта ('gemini-search-default' = «Gemini (Search AI)»).
  // Для прочих сайтов (в т.ч. Gemini) поведение прежнее — присваивание не выполняется.
  if (!snapModelId && currentAdapter && currentAdapter.siteName === 'google_search') {
    lastSnapshotModelName = ModelConfig.getModel(modelId)?.name || modelId;
  }
  const source = popupModelId ? 'popup' : (uiRaw ? 'dom' : 'snapshot');
  if (modelId !== lastResolvedModelId) {
    lastResolvedModelId = modelId;
    const ctx = ModelConfig.getContextLimit(modelId);
    const eff = ModelConfig.getEffectiveLimit(modelId);
    console.log('[model-detect] путь=' + path +
      (raw ? ', raw="' + raw + '"' : '') +
      ' → id=' + modelId + ', имя=' + (ModelConfig.getModel(modelId)?.name || modelId) +
      ', окно=' + ctx.toLocaleString() + ', порог потери деталей=' + eff.toLocaleString());
  }
  // v47: debug-лог источника модели (бейдж/попап/лимит)
  const srcSig = source + '|' + modelId;
  if (srcSig !== lastModelSourceSig) {
    lastModelSourceSig = srcSig;
    debugLog('log', source === 'popup'
      ? '[model-detect] H19 popup raw="' + popupRawModel + '" → id=' + modelId + ' · model-source=popup'
      : (source === 'dom'
        ? '[model-detect] v48 dom raw="' + uiRaw + '" → id=' + modelId + ' · model-source=dom'
        : '[model-detect] v47 model-source=snapshot' +
          (rawSnapshot ? ', снимок="' + rawSnapshot + '"' : '') +
          ' → id=' + modelId));
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

// ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (импорт) ============
// Единственное место с доступом к chrome.storage.local — здесь (ISOLATED). Архив
// появляется ТОЛЬКО из локального файла пользователя (options.html + FileReader),
// внешних fetch нет. Ходы архива передаются в MAIN-мир событием
// 'ai-cm-archive-restore' (паттерн tape-restore); запись источника
// (aiCmConvSource:<convId>, ярлык считается на импорте) — для попапа и виджета.
var AI_ARCHIVE_PREFIX = 'aiCmArchive:';
var AI_CONV_SOURCE_PREFIX = 'aiCmConvSource:';
var aiCmConvSourceByConv = {};          // convId → запись источника (для попапа/виджета)
var aiCmArchiveLoadStarted = {};        // convId → true — чтение архива уже запущено (page-session)
var aiCmArchiveRestoredDispatched = {}; // convId → true — ai-cm-archive-restore уже диспатчен
var aiCmArchiveCountByConv = {};        // T1-fix#2 (v1.16.2): convId → count архивных ходов (гейт экспорта)
var aiCmSourceLabelNow = '';            // ярлык источника для тултипа виджета

// T1-fix#2 (v1.16.2): count архива ЭТОГО чата (0 — архива нет/не прочитан). Нужен гейту
// автоэкспорта: архивные ходы лежат в той же базе, поэтому baseCount <= archiveMsgs
// означает «база состоит ТОЛЬКО из архива» — живая история ещё не влилась.
function aiCmArchiveCountFor(convId) {
  try { return (convId && aiCmArchiveCountByConv[convId]) || 0; } catch (eAcf) { return 0; }
}

// Источник для UI: архив (если импортирован для ЭТОГО convId) либо живой ярус.
// Ярлык архива берётся из aiCmConvSource:<convId> (посчитан при импорте) — логика
// ярлыка не дублируется в content-скрипте.
function aiCmSourceInfo() {
  var cid = getCurrentConvId() || '';
  var rec = cid ? aiCmConvSourceByConv[cid] : null;
  if (rec && rec.kind === 'archive') {
    return { kind: 'archive', label: rec.label || ('архив: ' + (rec.format || '?') + ' · ' + (rec.count || 0) + ' сообщ.') };
  }
  if (baseSeen) return { kind: 'live', label: 'live (сеть/DOM)' };
  return null;
}

function aiCmLoadArchiveTier(convId, reason) {
  if (!convId || !isExtensionValid()) return;
  try {
    var archKey = AI_ARCHIVE_PREFIX + convId;
    var srcKey = AI_CONV_SOURCE_PREFIX + convId;
    chrome.storage.local.get([archKey, srcKey], function (data) {
      try {
        if (!isExtensionValid()) return;
        // SPA-переход за время асинхронного чтения — архив чужого чата не применяем
        if (getCurrentConvId() !== convId) {
          debugLog('log', '[AI CM][archive-restore] skip reason=stale convId=' + convId +
            ' current=' + (getCurrentConvId() || '(none)'));
          return;
        }
        var src = data[srcKey] || null;
        if (src) aiCmConvSourceByConv[convId] = src;
        var rec = data[archKey] || null;
        var hasMsgs = !!(rec && Array.isArray(rec.messages) && rec.messages.length);
        // T1-fix#2 (v1.16.2): count архива этого чата — вход гейта автоэкспорта
        if (rec) {
          var recCount = (typeof rec.count === 'number' && rec.count > 0) ? rec.count
            : (hasMsgs ? rec.messages.length : 0);
          if (recCount > 0) aiCmArchiveCountByConv[convId] = recCount;
        }
        debugLog('log', '[AI CM][archive-restore] convId=' + convId +
          ' action=' + (hasMsgs ? 'used' : 'none') +
          ' cachedMsgs=' + (hasMsgs ? rec.messages.length : 0) +
          ' count=' + ((rec && rec.count) || 0) +
          ' format=' + ((rec && rec.format) || '-') +
          ' reason=' + (reason || ''));
        if (hasMsgs && !aiCmArchiveRestoredDispatched[convId]) {
          aiCmArchiveRestoredDispatched[convId] = true;
          try {
            window.dispatchEvent(new CustomEvent('ai-cm-archive-restore', {
              detail: {
                convId: convId,
                messages: rec.messages,
                count: (typeof rec.count === 'number' && rec.count > 0) ? rec.count : rec.messages.length,
                textLen: (typeof rec.textLen === 'number') ? rec.textLen : 0,
                format: rec.format || '',
                service: rec.service || '',
                title: rec.title || ''
              }
            }));
            debugLog('log', '[AI CM][archive-restore] dispatched convId=' + convId +
              ' msgs=' + rec.messages.length);
          } catch (eD) { }
        }
        aiCmUpdateSourceIndicator();
      } catch (eInner) { }
    });
  } catch (eL) {
    debugLog('log', '[AI CM][archive-restore] silent-catch load: ' + (eL && eL.message || eL));
  }
}

// Индикатор источника: строка в панели виджета (создаётся динамически — разметка
// виджета и её тема не меняются) + ярлык для тултипа.
function aiCmUpdateSourceIndicator() {
  try {
    var info = aiCmSourceInfo();
    aiCmSourceLabelNow = info ? info.label : '';
    if (!widgetElement) return;
    var panel = widgetElement.querySelector('.ai-widget-panel');
    if (!panel) return;
    var el = panel.querySelector('.ai-cm-source');
    var want = aiCmSourceLabelNow ? ('Источник: ' + aiCmSourceLabelNow) : '';
    if (el && el.textContent === want && el.style.display === (want ? 'block' : 'none')) return; // без лишних DOM-записей
    if (!want) {
      if (el) { el.textContent = ''; el.style.display = 'none'; }
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'ai-cm-source';
      panel.appendChild(el);
    }
    el.textContent = want;
    el.style.display = 'block';
  } catch (eSrc) { }
}

function processAndSend() {
  if (!currentAdapter) return;

  // v81 Step1: диагностический trace для не-Gemini адаптеров (поведение не меняется):
  // факты — у каких сервисов база заполняется через EMIT-канал, у каких история только из адаптера.
  try {
    var siteNameS1 = currentAdapter.siteName || '';
    if (siteNameS1 && siteNameS1 !== 'gemini') {
      // v82 (D2): baseSeen && тексты → network; !baseSeen → adapter; база есть, текстов нет → none
      var histWritePathS1 = (baseSeen && lastBaseTexts.length > 0) ? 'network'
        : (!baseSeen ? 'adapter' : 'none');
      debugLog('log', '[AI CM][svc-emit-trace] site=' + siteNameS1 +
        ' convId=' + (getCurrentConvId() || '') +
        ' msgs=' + ((typeof currentAdapter.extractMessages === 'function') ? currentAdapter.extractMessages().length : 0) +
        ' histWritePath=' + histWritePathS1);
    }
  } catch (eS1) { }

  // T1 (v1.16): первый ярус — архив. Читаем импортированный архив для ТЕКУЩЕГО convId
  // (один раз на convId за сессию страницы) и отдаём его в MAIN. Не зависит от
  // tape/лоадера: архив — независимый источник (для не-Gemini сервисов он пока
  // только индикатор источника — оракул/пол живут в Gemini-перехватчике).
  try {
    var cidArc = getCurrentConvId() || '';
    if (cidArc && !aiCmArchiveLoadStarted[cidArc]) {
      aiCmArchiveLoadStarted[cidArc] = true;
      aiCmLoadArchiveTier(cidArc, 'page-load');
    }
  } catch (eArcInit) { }

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
        // v82 (D8.2): диагностика фактического ключа load (времязависимый account index!)
        debugLog('log', '[AI CM][tape-restore] key=' + geminiTapeKey(convId));
        // v82 (D8.1): кэш account index на момент этого load
        aiCmTapeAccountIdx[convId] = getAccountIndex();
        // v77: лента уже восстановлена в этой сессии страницы → НЕ читаем storage повторно
        // (SW MV3 выгружается, но страница живёт; повторный tape-restore поверх живых
        // данных сбрасывал high-water mark).
        if (tapeRestoreSeen[convId]) {
          debugLog('log', '[AI CM][tape-restore] skip reason=already-restored convId=' + convId +
            ' (per-page session, v77)');
        } else {
        GeminiTapeStore.load(convId).then(function (entry) {
          restoreDone = true; // v30: восстановление завершено — разрешаем сохранение ленты
          // v66: ГАРАНТ записи ленты при baseComplete=1 — полный снимок мог прийти ДО
          // завершения restore (restoreDone=false → путь записи в listener пропущен),
          // либо запись сорвалась в прошлой сессии (лог 15:40: лента отсутствует после
          // успешного 14:54). Если лента пуста, а база уже полная — договариваем ленту.
          var hasTurns66 = !!(entry && entry.turns && entry.turns.length);
          if (!hasTurns66 && baseSeen && baseComplete === true &&
              Array.isArray(lastDetailMessages) && lastDetailMessages.length > 0 &&
              getCurrentConvId() === convId) {
            var lateTurns66 = [];
            for (var lt66 = 0; lt66 < lastDetailMessages.length; lt66++) {
              var lm66 = lastDetailMessages[lt66] || {};
              lateTurns66.push({
                id: (lm66.id != null) ? String(lm66.id) : '',
                text: lm66.text || '',
                role: (lm66.role === 'user') ? 'user' : 'assistant',
                r1: lm66.r1 || null,
                turnId: lm66.turnId || null
              });
            }
            if (lateTurns66.length > 0) {
              debugLog('log', '[AI CM][tape-save] convId=' + convId + ' action=late-save msgs=' + lateTurns66.length +
                ' baseComplete=1 (полный снимок пришёл до/вместо записи ленты — договариваю)');
              GeminiTapeStore.save(convId, lateTurns66, {
                count: baseCount || 0,
                effectiveLen: netEffectiveLen || 0,
                modelSlug: detectedModelSlug || '',
                version: geminiParserVersion()
              });
            }
          }
          // v54: trace привязки ленты к convId (кэш применяется ТОЛЬКО к своему чату)
          var hasTurns = !!(entry && entry.turns && entry.turns.length);
          // v61diag: усиленный tape-restore лог — добавлены cachedMsgs и хеши краёв ленты
          var diagTape0 = (hasTurns && entry.turns[0]) || null;
          var diagTapeN = (hasTurns && entry.turns[entry.turns.length - 1]) || null;
          debugLog('log', '[AI CM][tape-restore] convId=' + convId +
            ' cacheConvId=' + convId + ' action=' + (hasTurns ? 'used' : 'empty') +
            ' cachedMsgs=' + (hasTurns ? entry.turns.length : 0) +
            ' firstMsgHash=' + (diagTape0 ? aiCmDiagHash6(diagTape0.id, diagTape0.text) : '-') +
            ' lastMsgHash=' + (diagTapeN ? aiCmDiagHash6(diagTapeN.id, diagTapeN.text) : '-'));
          if (!hasTurns) return;
          // v77: пометка «восстановлено» ТОЛЬКО при непустой ленте (HWM: cachedMsgs=0 ничего не затирает)
          tapeRestoreSeen[convId] = true;
          // v35: за время асинхронной загрузки convId мог смениться (SPA-переход) —
          // сохранённый convId ≠ текущему → полностью пропускаем restore.
          if (getCurrentConvId() !== convId) {
            debugLog('log', '[content] v35: restore пропущен — лента чужого чата (saved=' + convId + ', current=' + getCurrentConvId() + ')');
            // v61diag: stale — лента чужого чата, применена не будет
            debugLog('log', '[AI CM][tape-restore] convId=' + getCurrentConvId() +
              ' cacheConvId=' + convId + ' action=stale cachedMsgs=' + entry.turns.length +
              ' firstMsgHash=' + aiCmDiagHash6(entry.turns[0] && entry.turns[0].id, entry.turns[0] && entry.turns[0].text) +
              ' lastMsgHash=' + aiCmDiagHash6(entry.turns[entry.turns.length - 1] && entry.turns[entry.turns.length - 1].id, entry.turns[entry.turns.length - 1] && entry.turns[entry.turns.length - 1].text));
            return;
          }
          // v30.4: восстановление из кэша/ленты для текущего convId — снимаем супрессию:
          // при SPA-переходе чат отдаётся из кэша (сети нет), бейдж показывает «—» < 1с,
          // затем подставляет кэшированные модель+процент, сеть позже уточняет.
          badgeSuppressed = false;
          debugLog('log', '[content-trace] badge: снята супрессия — восстановлена лента кэша convId=' + convId);
          // v82 (D9-A): дедупликация dispatch — повторный load того же convId в этой
          // сессии страницы (через resetConversationState при cold-open conv-changed)
          // не диспатчит ai-cm-restored-history второй раз; intercept сам гардируется
          // cacheRestoredMap, но content-side дедуп убирает лишний load/dispatch-путь.
          if (aiCmRestoredDispatched[convId]) {
            debugLog('log', '[AI CM][tape-restore] skip reason=already-dispatched convId=' + convId +
              ' cachedMsgs=' + entry.turns.length);
          } else {
            aiCmRestoredDispatched[convId] = true;
            try {
            window.dispatchEvent(new CustomEvent('ai-cm-restored-history', {
              detail: {
                convId: convId,
                turns: entry.turns,
                meta: entry.meta || {}
              }
            }));
          } catch (e) { }
          } // v82 (D9-A): конец else (дедуп dispatch)
          // v79: tape-restore применён — проверяем автоэкспорт при любом переходе полноты
          // (гейты внутри maybeAutoExport: not-complete → skip без fired, не вредит).
          try {
            var tapeCheckCid79 = getCurrentConvId() || '';
            if (tapeCheckCid79 && autoExportSettings.enabled === true &&
                typeof autoExportLastPct === 'number' && autoExportLastPct >= 0) {
              debugLog('log', '[AI CM][auto-export] tape-restore applied → check convId=' + tapeCheckCid79 + ' pct=' + autoExportLastPct);
              maybeAutoExport(autoExportLastPct);
            }
          } catch (eT79) { }
          // v30.6: кэш-лента применена — сеть может прийти не сразу; планируем ОДНО
          // уточнение канонического значения активным снимком через 2с.
          // Гарды: convId не сменился (проверка перед диспатчем), один раз на convId за сессию.
          if (!cacheRefreshPlanned[convId]) {
            cacheRefreshPlanned[convId] = true;
            setTimeout(function () {
              if (getCurrentConvId() !== convId) return;
              try {
                window.dispatchEvent(new CustomEvent('ai-cm-cache-refresh', { detail: { convId: convId } }));
              } catch (e2) { }
            }, 2000);
          }
        });
        GeminiTapeStore.cleanup(); // очистка при загрузке чата
        } // v77: конец else (повторный tape-restore)
      }
    }
  }

  // v82 (D8.3): повторный tape-restore при стабилизации account index (u0→uN после
  // редиректа Gemini): первый load мог вычислить ключ с 'u0' и промахнуться мимо
  // хранилища (B1-repeat: action=empty при существующей ленте). Однократно на смену
  // индекса; повторный проход — штатный блок выше (restoreDone, late-save v66,
  // badge-супрессия, tape-check v79) — экспорт-поведение и ключи не меняются.
  try {
    var svcD8 = getServiceKey();
    if (svcD8 === 'gemini' || svcD8 === 'aistudio') {
      var cidD8 = '';
      try {
        var mD8 = location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/);
        cidD8 = mD8 ? mD8[1] : '';
      } catch (eD8) { }
      if (cidD8 && restoredTapeLoaded &&
          aiCmTapeAccountIdx[cidD8] !== undefined &&
          String(aiCmTapeAccountIdx[cidD8]) !== String(getAccountIndex())) {
        debugLog('log', '[AI CM][tape-restore] retry reason=account-index-stabilized u' +
          aiCmTapeAccountIdx[cidD8] + '→u' + getAccountIndex() + ' convId=' + cidD8 +
          ' key=' + geminiTapeKey(cidD8));
        aiCmTapeAccountIdx[cidD8] = getAccountIndex();
        restoredTapeLoaded = false; // следующий processAndSend повторит штатный restore
      }
    }
  } catch (eD8b) { }

  // Антиспам: DRAW/DRAW-ПРОПУСК печатаем только при изменении сигнатуры состояния.
  var drawSig = [baseComplete ? 1 : 0, baseSeen ? 1 : 0, isInitialized ? 1 : 0, baseCount, (baseText ? baseText.length : 0)].join('|');
  if (!isInitialized && !(baseSeen && baseComplete)) {
    if (drawSig !== lastDrawSig) {
      lastDrawSig = drawSig;
      debugLog('log', '[content-trace] DRAW-ПРОПУСК (guard) seq=' + (window.__aiCmTraceSeq || 0) + ' baseComplete=' + baseComplete + ' baseSeen=' + baseSeen + ' isInitialized=' + isInitialized + ' t=' + Date.now());
    }
    return;
  }
  if (drawSig !== lastDrawSig) {
    lastDrawSig = drawSig;
    debugLog('log', '[content-trace] DRAW seq=' + (window.__aiCmTraceSeq || 0) + ' baseComplete=' + baseComplete + ' baseSeen=' + baseSeen + ' isInitialized=' + isInitialized + ' effectiveLen=' + ((function () { var e = getEffectiveText(); return e ? e.length : 0; })()) + ' t=' + Date.now());
  }
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
    } else if (baseComplete === true) {
      // v1.8-fix: новый ПОЛНЫЙ сетевой снапшот ЗАМЕНЯЕТ значение базы и сбрасывает
      // монотонный максимум — случайная инфляция (двойной учёт вложений и т.п.)
      // самолечится следующим доверенным снапшотом вместо max-merge.
      maxTokenCount = tokenEstimate;
    } else if (useMonotonic) {
      if (tokenEstimate > maxTokenCount) maxTokenCount = tokenEstimate;
    } else {
      maxTokenCount = tokenEstimate;
    }
    const percentage = displayLimit > 0 ? Math.round((maxTokenCount / displayLimit) * 1000) / 10 : 0;
    const hasChanged = percentage !== lastPercentage;
    lastPercentage = percentage;
    if (badgeSuppressed && !baseSeen) {
      // v1.8.1: после RESET до первого badge-recv НЕ эмитим дефолтную модель с нулями
      // (иначе 1–2с показывается ложная «Gemini 2.5 Pro» и 0%); бейдж остаётся «—».
      debugLog('log', '[content-trace] badge-suppress: пропуск updateWidget до первого снимка нового convId');
    } else if (aiCmLoaderFreeze) {
      // v30.9: во время скрытой загрузки молча копим последнее значение (без updateWidget);
      // на разморозке слушатель ai-cm-loader-freeze отрисует его принудительно.
      lastWidgetData = {
        percentage, tokenEstimate: maxTokenCount, effectiveLimit, contextLimit, displayLimit,
        modelName: ModelConfig.getModel(modelId)?.name || modelId, attachBreak: netAttachBreak
      };
      debugLog('log', '[content-trace] badge-freeze: скрытая загрузка лоадера — значение накоплено, виджет держится');
    } else {
      updateWidget(percentage, maxTokenCount, effectiveLimit, contextLimit, displayLimit, ModelConfig.getModel(modelId)?.name || modelId, netAttachBreak);
      lastWidgetData = {
        percentage, tokenEstimate: maxTokenCount, effectiveLimit, contextLimit, displayLimit,
        modelName: ModelConfig.getModel(modelId)?.name || modelId, attachBreak: netAttachBreak
      };
    }
    // v30.4: автоэкспорт на ЛЮБОМ пути badge-update с реальным pct (включая кэш-путь и
    // путь снятия супрессии); условие внутри maybeAutoExport — без требования baseComplete.
    maybeAutoExport(percentage);
    // Фаза B: проактивные пороги 70/85/95 → SW (бейдж + opt-in уведомления)
    sendThresholdPct(percentage);
    if (hasChanged) {
      const tagPct = aiCmActivePct();
      const tag = (tagPct != null) ? ('порог ' + tagPct + '% от Авто') : 'Авто';
      debugLog('log', `📊 ${ModelConfig.getModel(modelId)?.name || modelId}: ${maxTokenCount} / ${displayLimit.toLocaleString()} (${tag}) · окно ${contextLimit.toLocaleString()} · ${percentage}%` + (netAttachTokens > 0 ? ` · вложения≈${netAttachTokens}` : '') + (netServerTokens > 0 ? ' · serverTokens' : '') + (baseComplete ? ' · по базе' : ''));
    }

    // Снапшот для попапа в chrome.storage.local
    if (isExtensionValid()) {
      try {
        // v31: пишем также per-host ключ aiCmState:<host> — глобальный ключ затирается чужим табом/хостом
        var stateSnapshot = {
          host: window.location.hostname,
          site: currentAdapter.siteName,
          model: ModelConfig.getModel(modelId)?.name || modelId,
          tokens: maxTokenCount,
          limit: displayLimit,
          percent: percentage,
          updatedAt: Date.now(),
          stale: stale,
          // T1 (v1.16): источник первого/второго яруса для индикатора в попапе
          sourceKind: (function () { try { var si = aiCmSourceInfo(); return si ? si.kind : ''; } catch (eSi) { return ''; } })(),
          sourceLabel: (function () { try { var si2 = aiCmSourceInfo(); return si2 ? si2.label : ''; } catch (eSi2) { return ''; } })()
        };
        var statePatch = { aiCmState: stateSnapshot };
        statePatch['aiCmState:' + window.location.hostname] = stateSnapshot;
        chrome.storage.local.set(statePatch);
      } catch (e) { }
    }
    // Экспорт истории: пишем aiCmHistory только когда история реально изменилась (baseCount или textLen).
    // v34/v35: защита от гонки при смене треда. Адаптер-независимое условие:
    // запрет ТОЛЬКО когда оба convId непустые и разные (эмит чужого треда);
    // пустая сторона (адаптеры без convId в URL: claude/deepseek/gsa/perplexity) запись разрешает.
    var emitConvA = lastEmitConvId || '';
    var currentConvB = getCurrentConvId() || '';
    if (isExtensionValid() && baseSeen && lastBaseTexts.length > 0 &&
        !(emitConvA && currentConvB && emitConvA !== currentConvB)) {
      var histKey = baseCount + '|' + (baseText ? baseText.length : 0);
      if (histKey !== lastHistoryWroteKey) {
        lastHistoryWroteKey = histKey;
        // v54: trace записи экспорта — источник ВСЕГДА сеть текущего convId
        debugLog('log', '[AI CM][trace] history-write source=network convId=' + (emitConvA || '-') +
          ' msgs=' + baseCount);
        try {
          // v31: дублируем в per-host ключ aiCmHistory:<host> (перезапись, без накопления)
          var histSnapshot = {
            host: window.location.hostname,
            convId: lastEmitConvId,
            site: currentAdapter.siteName,
            // v47: экспорт НЕ переводим на UI-модель — здесь остаётся модель снимка
            model: lastSnapshotModelName || (ModelConfig.getModel(modelId)?.name || modelId),
            tokens: maxTokenCount,
            limit: displayLimit,
            percent: percentage,
            updatedAt: Date.now(),
            // v63: low-confidence база (sanity-фолбэк без proof) — options.js ставит префикс [LOW CONFIDENCE]_
            isLowConfidenceBase: aiCmLowConfidenceByConv[emitConvA] === true,
            // T1 (v1.16): источник истории — архив (первый ярус) или live (сеть/DOM)
            sourceKind: (function () { try { var si = aiCmSourceInfo(); return si ? si.kind : ''; } catch (eSi) { return ''; } })(),
            sourceLabel: (function () { try { var si2 = aiCmSourceInfo(); return si2 ? si2.label : ''; } catch (eSi2) { return ''; } })(),
            messages: buildHistoryMessages()
          };
          var histPatch = { aiCmHistory: histSnapshot };
          histPatch['aiCmHistory:' + window.location.hostname] = aiCmHostHistoryRecord(histSnapshot);
          // v52: гейт ручного экспорта — не пишем частичную историю, пока лоадер бежит
          // или база не полная; одноразовый defer с таймаутом 20с (см. schedule/flush ниже).
          // v1.13.1: для Gemini дополнительно требуется ПОДТВЕРЖДЁННАЯ полнота
          // (baseComplete при reachedStart=true) — baseComplete без начала недостоверен.
          var cidForGate = emitConvA || currentConvB || '';
          var isGeminiGate = currentAdapter && currentAdapter.siteName === 'gemini';
          if (cidForGate && (aiCmLoaderRunningByConv[cidForGate] || baseComplete !== true ||
              (isGeminiGate && aiCmBaseConfirmedByConv[cidForGate] !== 1))) {
            aiCmScheduleDeferredHistWrite(cidForGate);
          } else {
            aiCmCancelDeferredHistWrite(cidForGate || '');
            chrome.storage.local.set(histPatch);
          }
        } catch (e) { }
      }
    }
    // v81 (2.4): параллельная ветка записи истории для не-Gemini сервисов — когда сети нет
    // (baseSeen=false или пустая база), пишем aiCmHistory из DOM-адаптера; convId из
    // getCurrentConvId(); те же примитивы deferred/латч (гейт лоадера и base-confirmed —
    // только для Gemini, здесь не применяются).
    try {
      var svcS24 = getServiceKey();
      var isGeminiS24 = (svcS24 === 'gemini' || svcS24 === 'aistudio');
      if (!isGeminiS24 && isExtensionValid() && !baseSeen &&
          !(lastEmitConvId && currentConvB && lastEmitConvId !== currentConvB)) {
        var cidS24 = getCurrentConvId() || '';
        var msgsS24 = buildHistoryMessages();
        var histKeyS24 = 'adapter|' + msgsS24.length;
        if (msgsS24.length > 0 && histKeyS24 !== lastHistoryWroteKey) {
          lastHistoryWroteKey = histKeyS24;
          debugLog('log', '[AI CM][trace] history-write source=adapter site=' + (currentAdapter.siteName || '') +
            ' convId=' + cidS24 + ' msgs=' + msgsS24.length);
          var histSnapshotS24 = {
            host: window.location.hostname,
            convId: cidS24,
            site: currentAdapter.siteName,
            model: lastSnapshotModelName || (ModelConfig.getModel(modelId)?.name || modelId),
            tokens: maxTokenCount,
            limit: displayLimit,
            percent: percentage,
            updatedAt: Date.now(),
            // v81 (2.5): полный DOM-адаптер НЕ помечается low-confidence автоматически
            isLowConfidenceBase: false,
            messages: msgsS24
          };
          var histPatchS24 = { aiCmHistory: histSnapshotS24 };
          histPatchS24['aiCmHistory:' + window.location.hostname] = aiCmHostHistoryRecord(histSnapshotS24);
          chrome.storage.local.set(histPatchS24);
        }
      }
    } catch (eS24) { }
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
// v77: возврат видимости вкладки — форсируем восстановление UI из локальных данных
// (SW MV3 мог быть выгружен браузером; локальный turnsMap/виджет живы в контент-скрипте).
document.addEventListener('visibilitychange', function () {
  try {
    if (document.visibilityState !== 'visible') return;
    debugLog('log', '[visibility] tab-focused');
    if (!currentAdapter) return;
    if (baseSeen || lastWidgetData) {
      processAndSend(); // пере-отрисовка бейджа/виджета/POPUP-снапшота из локальной базы
    }
  } catch (eVis77) { }
});
// ========== Фаза B: ПРОАКТИВНЫЕ ПОРОГИ 70/85/95 ==========
// Отправка текущего pct в Service Worker (THRESHOLD_PCT): там бейдж по вкладке и
// opt-in chrome-уведомления. Латч «один раз на разговор» живёт в SW
// (chrome.storage.session, ключ 'aiCmThr:'+convId) — content-сторона только шлёт pct.
// Флаг aiCmProactive (дефолт ON) читаем из chrome.storage.local (кэш + onChanged).
var aiCmProactiveEnabled = true;
function aiCmLoadProactiveFlag() {
  try {
    if (!isExtensionValid() || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['aiCmProactive'], function (data) {
      aiCmProactiveEnabled = !(data && data.aiCmProactive === false);
    });
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName === 'local' && changes.aiCmProactive) {
          aiCmProactiveEnabled = changes.aiCmProactive.newValue !== false;
        }
      });
    } catch (eL) {}
  } catch (e) {
    console.error('[AI CM][thresholds] load flag error:', e);
  }
}
function sendThresholdPct(pct) {
  try {
    if (!isExtensionValid() || !aiCmProactiveEnabled) return;
    if (typeof pct !== 'number' || !(pct >= 0)) return;
    var cid = lastEmitConvId || getCurrentConvId() || '';
    var siteName = (currentAdapter && currentAdapter.siteName) ? currentAdapter.siteName : '';
    chrome.runtime.sendMessage({
      type: 'THRESHOLD_PCT',
      data: { convId: cid, site: siteName, pct: pct }
    }).catch(function () { });
  } catch (e) {
    console.error('[AI CM][thresholds] send error:', e);
  }
}
aiCmLoadProactiveFlag();

// ========== v1.8: АВТОЭКСПОРТ ЧАТА ПРИ ПОРОГЕ ==========
// Настройки: aiCmAutoExport / aiCmAutoExportPct / aiCmAutoExportFmt (chrome.storage.local).
// Сборка текста — тем же сборщиком, что использует ручная кнопка выбранного формата
// (utils/export-text-builders.js). Без флага консоль тихая; ошибки — console.error.
var autoExportSettings = { enabled: false, pct: 90, fmt: 'txt' };
var autoExportFired = {};        // convId -> 1 (один раз на чат)
// S2: per-site порог автоэкспорта: ключ 'aiCmAutoExportPct_<siteName>' (например
// aiCmAutoExportPct_chatgpt) переопределяет глобальный aiCmAutoExportPct для этого
// сайта. Кэш заполняется асинхронно (initialize + onChanged); запись отсутствует →
// в maybeAutoExport фолбэк на глобальный порог.
var autoExportPctBySite = {};    // siteName -> число 1..100; undefined = фолбэк на глобальный
function autoExportPerSiteKey(siteName) { return 'aiCmAutoExportPct_' + (siteName || ''); }
function loadAutoExportPerSitePct() {
  try {
    if (!isExtensionValid() || !chrome.storage || !chrome.storage.local) return;
    var site = (currentAdapter && currentAdapter.siteName) || '';
    if (!site) return;
    var key = autoExportPerSiteKey(site);
    chrome.storage.local.get([key], function (data) {
      try {
        var raw = data && data[key];
        var n = parseInt(raw, 10);
        autoExportPctBySite[site] = (!isNaN(n) && n >= 1 && n <= 100) ? n : undefined;
        debugLog('log', '[AI CM][auto-export] per-site load ' + key + '=' +
          (autoExportPctBySite[site] === undefined ? 'нет (глобальный фолбэк)' : autoExportPctBySite[site]));
      } catch (eParsePs) {}
    });
  } catch (e) { console.error('[AI CM][auto-export] per-site load error:', e); }
}
// v1.14.1 (O3): кросс-табовый латч already-fired. Кэш chrome.storage.session
// ('aiCmFired:service|convId' -> 1), общий для всех вкладок профиля: вторая вкладка
// с тем же чатом видит fired первой и не экспортирует повторно. Доступ к
// storage.session из контент-скриптов открыт в background.js (setAccessLevel).
var sessionFiredCache = {};
(function initSessionFiredCache() {
  try {
    if (!chrome.storage.session) return;
    chrome.storage.session.get(null).then(function (m) { sessionFiredCache = m || {}; }).catch(function () { });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'session') return;
      for (var k in changes) {
        if (changes[k].newValue == null) delete sessionFiredCache[k];
        else sessionFiredCache[k] = changes[k].newValue;
      }
    });
  } catch (eO3init) { }
})();
var autoExportLastConvId = '';   // сброс fired при смене чата
// v42: convId → 1, пока лоадер Gemini (MAIN-мир) бежит по этому чату; канал — ai-cm-loader-state
var aiCmLoaderRunningByConv = {};
var autoExportLastPct = -1;      // v42: последний pct для однократного re-check на стопе лоадера
// v52: отложенная запись aiCmHistory (питает ручной экспорт попапа из chrome.storage.local).
// Если в момент снимка лоадер Gemini ещё бежит ИЛИ база не полная — не пишем сразу,
// иначе попап может скачать частичную историю (дыра в середине). Одноразово ждём
// события (baseComplete && !loader), таймаут-фолбэк 20с → пишем как есть.
var aiCmPendingHistWrite = null; // { convId, timer }
// v53: курсор продолжения лоадера Gemini по convId на момент стопа (из ai-cm-loader-state
// detail.pendingCursor). Пока курсор жив — автоэкспорт НЕ стреляет (даже при baseComplete).
var aiCmCursorLiveByConv = {};
// v1.13.1: convId → 1 — база подтверждённо полная (baseComplete при reachedStart=true от
// перехватчика Gemini). До подтверждения deferred-запись истории висит и НЕ флашится по
// loader-stop; фолбэк — «счётчик стабилен при видимой вкладке» (таймаут defer при visible).
var aiCmBaseConfirmedByConv = {};
// v63: convId → true — база подтверждена только sanity-фолбэком (low confidence);
// читается при записи histSnapshot (поле isLowConfidenceBase → префикс имени файла).
var aiCmLowConfidenceByConv = {};
// v53: convId → 1 — «ждём поздний re-check, когда база впервые станет полной».
// Одноразовый: гасится после фактического re-check (см. aiCmTryLateAutoExport).
var aiCmLateCheckByConv = {};
// v54: детектор обрезки истории в Gemini + спасательный pre-trim экспорт.
// trimProbe[cid] = { maxCount, firstIds, suspectPending } — эталон последнего ПОЛНОГО
// снимка (обновляется только при detail.historyComplete === true).
var trimProbe = {};
var preTrimExportFired = {};     // v54: cid -> 1 — pre-trim экспорт один раз на чат; Независим от autoExportFired
var trimRetryByConv = {};        // v54: cid -> счётчик ретраев инвариантов полноты (≤5 по 2с)
// N первых id снимка для сравнения голов детектором обрезки (синхронно с util).
var TRIM_HEAD_IDS_N = 10;

// v53: одноразовый поздний re-check автоэкспорта после loader-stop с неполной базой/
// живым курсором. Стреляем только когда база полная И курсор ушёл И лоадер остановлен.
function aiCmTryLateAutoExport(cid) {
  try {
    if (!cid || !aiCmLateCheckByConv[cid]) return;
    if (baseComplete !== true) return;          // база ещё не полная — ждём дальше
    // v1.13.1: для Gemini требуется подтверждённое начало (reachedStart=true)
    if (currentAdapter && currentAdapter.siteName === 'gemini' && aiCmBaseConfirmedByConv[cid] !== 1) return;
    if (aiCmLoaderRunningByConv[cid]) return;   // лоадер бежит — ждём стоп
    if (aiCmCursorLiveByConv[cid]) return;      // курсор ещё жив — не стреляем неполное
    aiCmLateCheckByConv[cid] = 0;
    if (typeof autoExportLastPct === 'number' && autoExportLastPct >= 0) {
      debugLog('log', '[AI CM][auto-export] late re-check base-complete convId=' + cid +
        ' pct=' + autoExportLastPct + ' pendingCursor=0 baseComplete=1');
      maybeAutoExport(autoExportLastPct);
    }
  } catch (e) { }
}

// v54: локальный фолбэк чистой функции detectTrimState (utils/gemini-intercept-logic.js).
// Утилита на Gemini грузится только в MAIN-мире (background.js), а content.js живёт в
// ISOLATED и window.GeminiInterceptLogic не видит. Копия синхронизирована с утилитой;
// при наличии window.GeminiInterceptLogic.detectTrimState приоритет у канонической.
function detectTrimStateFallback(prevProbe, snapshot) {
  var res = { suspect: false, confirmed: false, lostHead: false };
  try {
    if (!snapshot || !Array.isArray(snapshot.messageIds)) return res;
    if (snapshot.historyComplete === false) return res;
    var curCount = (typeof snapshot.count === 'number') ? snapshot.count : snapshot.messageIds.length;
    if (!prevProbe || !(typeof prevProbe.maxCount === 'number') || !(prevProbe.maxCount > 0)) return res;
    if (!(curCount < prevProbe.maxCount)) return res;
    var prevFirst = Array.isArray(prevProbe.firstIds) ? prevProbe.firstIds : [];
    if (prevFirst.length === 0) return res;
    var head = [];
    var lim = Math.min(TRIM_HEAD_IDS_N, snapshot.messageIds.length);
    for (var i = 0; i < lim; i++) head.push(String(snapshot.messageIds[i]));
    for (var j = 0; j < prevFirst.length; j++) {
      if (head.indexOf(String(prevFirst[j])) !== -1) return res;
    }
    res.lostHead = true;
    res.suspect = true;
    res.confirmed = !!prevProbe.suspectPending;
  } catch (e) { }
  return res;
}

// v54: детектор обрезки истории в Gemini — вызывается из слушателя ai-cm-full-history.
// trimProbe обновляется ТОЛЬКО по полному снимку (historyComplete===true); confirmed
// требует двух последовательных сокращений подряд (suspect → confirmed).
function geminiDetectTrim(detail) {
  try {
    if (!detail || !Array.isArray(detail.messageIds)) return;
    var site = (currentAdapter && currentAdapter.siteName) || '';
    if (site !== 'gemini') return;
    var cid = detail.convId || lastEmitConvId || getCurrentConvId() || '';
    if (!cid) return;
    if (detail.historyComplete !== true) return; // частичная загрузка — это пагинация, НЕ обрезка
    var G = window.GeminiInterceptLogic;
    var fn = (G && typeof G.detectTrimState === 'function') ? G.detectTrimState : detectTrimStateFallback;
    var prev = trimProbe[cid] || null;
    var cnt = (typeof detail.count === 'number' && detail.count >= 0)
      ? detail.count : detail.messageIds.length;
    var st = fn(prev, { count: cnt, messageIds: detail.messageIds, historyComplete: true });
    var curFirstIds = detail.messageIds.slice(0, TRIM_HEAD_IDS_N);
    // При подозрении на обрезку ХРАНИМ СТАРЫЙ эталон головы — подтверждение (suspect→confirmed)
    // требует, чтобы и следующий ПОЛНЫЙ снимок тоже не содержал сохранённые firstIds.
    // Стабильный/растущий снимок обновляет firstIds (и сбрасывает «подряд»).
    var keptFirstIds = (st.lostHead && prev && Array.isArray(prev.firstIds) && prev.firstIds.length > 0)
      ? prev.firstIds : curFirstIds;
    // эталон максимума монотонный: после обрезки count падает, но maxCount хранит прежний пик
    var maxCount = Math.max(cnt, (prev && typeof prev.maxCount === 'number') ? prev.maxCount : 0);
    trimProbe[cid] = {
      maxCount: maxCount,
      firstIds: keptFirstIds,
      suspectPending: st.lostHead ? 1 : 0 // «подряд» сбрасывается любым стабильным снимком
    };
    if (st.confirmed) {
      debugLog('log', '[AI CM][trim] confirmed обрезка истории convId=' + cid +
        ' cnt=' + cnt + ' maxCount=' + maxCount);
      maybeTrimExport(cid);
    }
  } catch (e) { }
}

// v54: одноразовый спасательный экспорт ДО потери головы (обрезка истории в Gemini).
// Латч preTrimExportFired ставится сразу (одна попытка-цепочка на чат); инварианты
// полноты как у автоэкспорта: baseComplete && лоадер не бежит && курсор ушёл.
// Если не готово — ретрай ≤5 раз по 2с. autoExportFired НЕ трогаем.
function maybeTrimExport(cid) {
  try {
    if (!cid || preTrimExportFired[cid]) return;
    preTrimExportFired[cid] = 1; // одноразовый латч, независим от autoExportFired
    var ready = baseComplete === true &&
      !aiCmLoaderRunningByConv[cid] && !aiCmCursorLiveByConv[cid];
    if (!ready) {
      var n = trimRetryByConv[cid] || 0;
      if (n >= 5) {
        debugLog('log', '[AI CM][auto-export] skip reason=pre-trim-not-ready convId=' + cid +
          ' retries=' + n + ' baseComplete=' + (baseComplete === true ? '1' : '0'));
        return;
      }
      trimRetryByConv[cid] = n + 1;
      debugLog('log', '[AI CM][auto-export] pre-trim not ready, retry ' + (n + 1) + '/5 in 2s convId=' + cid);
      setTimeout(function () {
        try {
          preTrimExportFired[cid] = 0; // отдаём латч повторной попытке своей же цепочки
          maybeTrimExport(cid);
        } catch (eRetry) { }
      }, 2000);
      return;
    }
    var dispLimit = computeEffectiveLimit(lastResolvedModelId);
    var pct = dispLimit > 0 ? Math.round((maxTokenCount / dispLimit) * 1000) / 10 : 0;
    doAutoExportDownload(cid, pct, 'pre-trim');
    debugLog('log', '[AI CM][auto-export] fired reason=pre-trim convId=' + cid +
      ' msgs=' + (baseCount || 0) + ' lostHead=1.');
  } catch (e) {
    console.error('[AI CM][auto-export] error:', e);
  }
}

function aiCmCancelDeferredHistWrite(cid) {
  try {
    if (!aiCmPendingHistWrite) return;
    if (cid && aiCmPendingHistWrite.convId !== cid) return;
    clearTimeout(aiCmPendingHistWrite.timer);
    aiCmPendingHistWrite = null;
  } catch (e) { }
}

function aiCmWriteCurrentHistory() {
  try {
    if (!isExtensionValid() || !baseSeen || !baseText) return;
    var cid = lastEmitConvId || getCurrentConvId() || '';
    var mid = lastResolvedModelId;
    var dispLimit = computeEffectiveLimit(mid);
    var pct = dispLimit > 0 ? Math.round((maxTokenCount / dispLimit) * 1000) / 10 : 0;
    var histSnapshot = {
      host: window.location.hostname,
      convId: lastEmitConvId,
      site: (currentAdapter && currentAdapter.siteName) || '',
      model: lastSnapshotModelName || (mid ? (ModelConfig.getModel(mid)?.name || mid) : ''),
      tokens: maxTokenCount,
      limit: dispLimit,
      percent: pct,
      updatedAt: Date.now(),
      // v1.14.1: живой флаг вместо липкого — префикс [LOW CONFIDENCE]_ только пока
      // baseComplete !== true; после 0→1 липкий aiCmLowConfidenceByConv больше не лепит
      // ложный префикс переписанному снапшоту.
      isLowConfidenceBase: (baseComplete !== true),
      messages: buildHistoryMessages()
    };
    var histPatch = { aiCmHistory: histSnapshot };
    histPatch['aiCmHistory:' + window.location.hostname] = aiCmHostHistoryRecord(histSnapshot);
    chrome.storage.local.set(histPatch);
  } catch (e) { debugLog('log', '[AI CM][export] silent-catch aiCmWriteCurrentHistory: ' + (e && e.message || e)); }
}

function aiCmFlushDeferredHistWrite(cid, reason) {
  try {
    var p = aiCmPendingHistWrite;
    if (!p) return;
    if (cid && p.convId !== cid) return;
    if (reason !== 'timeout' && !(baseComplete === true && !aiCmLoaderRunningByConv[p.convId])) return;
    clearTimeout(p.timer);
    aiCmPendingHistWrite = null;
    debugLog('log', '[AI CM][export] deferred flushed reason=' + reason + ' convId=' + p.convId);
    aiCmWriteCurrentHistory();
  } catch (e) { debugLog('log', '[AI CM][export] silent-catch aiCmFlushDeferredHistWrite: ' + (e && e.message || e)); }
}

function aiCmScheduleDeferredHistWrite(cid) {
  try {
    aiCmCancelDeferredHistWrite(); // один отложенный снапшот за сессию — свежий важнее
    debugLog('log', '[AI CM][export] deferred until base-complete convId=' + cid +
      ' loader=' + !!aiCmLoaderRunningByConv[cid] + ' baseComplete=' + baseComplete);
    var p = { convId: cid, timer: null };
    function fireDeferredTimeout() {
      if (aiCmPendingHistWrite !== p) return;
      // v1.13.1: при скрытой вкладке «как есть» НЕ экспортируем — переносим deferred.
      // После разлока visibilitychange перезапустит досбор и база докрутится до начала;
      // фолбэк «счётчик стабилен» срабатывает только при видимой вкладке.
      if (document.visibilityState !== 'visible') {
        p.timer = setTimeout(fireDeferredTimeout, 60000);
        debugLog('log', '[AI CM][export] deferred-wait-visible convId=' + cid +
          ' (вкладка скрыта — таймаут перенесён, экспорт как есть отложен)');
        return;
      }
      aiCmPendingHistWrite = null;
      // v55: SPA-переход за время defer → convId таймера не совпал с текущим чатом:
      // НЕ экспортируем (иначе уйдёт история предыдущего разговора), лог reason=stale-conv.
      var curCid = getCurrentConvId() || '';
      if (curCid && cid !== curCid) {
        debugLog('log', '[AI CM][export] deferred-timeout skip reason=stale-conv timerConv=' +
          cid + ' current=' + curCid);
        return;
      }
      // v53: ручной экспорт ждёт base-complete до 60с, затем «как есть» с логом
      debugLog('log', '[AI CM][export] deferred-timeout(60s), exporting as-is convId=' + cid +
        ' pendingCursor=' + (aiCmCursorLiveByConv[cid] ? '1' : '0') +
        ' baseComplete=' + (baseComplete === true ? '1' : '0'));
      // v64: честная маркировка as-is экспорта — при baseComplete=0 база не подтверждена,
      // histSnapshot получает isLowConfidenceBase=true → v63-префикс [LOW CONFIDENCE]_.
      if (baseComplete !== true) {
        try {
          aiCmLowConfidenceByConv[cid] = true;
          if (lastEmitConvId && lastEmitConvId !== cid) aiCmLowConfidenceByConv[lastEmitConvId] = true;
        } catch (eLc64) { debugLog('log', '[AI CM][export] silent-catch aiCmScheduleDeferredHistWrite(fireDeferredTimeout/lowConf): ' + (eLc64 && eLc64.message || eLc64)); }
        debugLog('log', '[AI CM][export] as-is baseComplete=0 → isLowConfidenceBase=true convId=' + cid);
      }
      try { aiCmWriteCurrentHistory(); } catch (eW) { debugLog('log', '[AI CM][export] silent-catch aiCmScheduleDeferredHistWrite(fireDeferredTimeout/export): ' + (eW && eW.message || eW)); }
    }
    p.timer = setTimeout(fireDeferredTimeout, 60000);
    aiCmPendingHistWrite = p;
  } catch (e) { debugLog('log', '[AI CM][export] silent-catch aiCmScheduleDeferredHistWrite: ' + (e && e.message || e)); }
}



function loadAutoExportSettings() {
  try {
    if (!isExtensionValid() || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt'], function (data) {
      try {
        autoExportSettings.enabled = data && data.aiCmAutoExport === true;
        var p = parseInt(data && data.aiCmAutoExportPct, 10);
        autoExportSettings.pct = (!isNaN(p) && p >= 1 && p <= 100) ? p : 90; // v65: 1–100
        // v1.18 (F4): селектор формата общий для всех сайтов — txt | md | json.
        var fmtRaw = data && data.aiCmAutoExportFmt;
        autoExportSettings.fmt = (fmtRaw === 'md' || fmtRaw === 'json') ? fmtRaw : 'txt';
      } catch (eParse) {
        console.error('[AI CM][auto-export] parse settings error:', eParse);
      }
    });
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local') return;
        if (changes.aiCmAutoExport || changes.aiCmAutoExportPct || changes.aiCmAutoExportFmt) {
          loadAutoExportSettings();
        }
      });
    } catch (eL) {}
  } catch (e) {
    console.error('[AI CM][auto-export] load settings error:', e);
  }
}

// ========== v1.18 (F2/F5): GSA — идентификатор разговора и probe-полнота ==========
// convId автоэкспорта. У GSA надёжного id в URL нет (extractConvIdFromUrl → ''), поэтому
// идентификатором разговора служит threadId снапшота (detail.threadId → lastThreadId):
// он попадает и в ключ латча (site+convId), и в диагностику. Прочие сервисы — URL-id 1:1.
function aiCmAutoExportConvId() {
  try {
    var urlCid = getCurrentConvId() || '';
    var site = (currentAdapter && currentAdapter.siteName) || '';
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    if (P && typeof P.resolveAutoExportConvId === 'function') {
      return P.resolveAutoExportConvId(site, urlCid, lastThreadId || '') || '';
    }
    return urlCid;
  } catch (e) { return getCurrentConvId() || ''; }
}
// v1.18 (F5): состояние probe-полноты GSA (MAIN → ISOLATED, CustomEvent
// 'ai-cm-gsa-probe-state'). Нужно ТОЛЬКО для ярлыка причины skip: probe-running,
// пока вердикта классификатора ещё нет. Сам вердикт полноты — baseComplete (один).
var aiCmGsaProbeByThread = {};    // threadId -> 1 (probe в полёте)
var aiCmGsaProbeRunning = false;  // последнее состояние (фолбэк для пустого convId)
window.addEventListener('ai-cm-gsa-probe-state', function (ev) {
  try {
    var d = ev && ev.detail;
    if (!d) return;
    aiCmGsaProbeRunning = d.running === true;
    if (d.threadId) aiCmGsaProbeByThread[d.threadId] = aiCmGsaProbeRunning ? 1 : 0;
  } catch (eGsaProbe) { }
});
function aiCmGsaProbeRunningFor(cid) {
  try {
    if (cid && typeof aiCmGsaProbeByThread[cid] !== 'undefined') return aiCmGsaProbeByThread[cid] === 1;
    return aiCmGsaProbeRunning === true;
  } catch (e) { return false; }
}
// v1.18 (F5): единая tagged-строка логов автоэкспорта GSA. Антиспам — как у
// not-complete в общем пути: не чаще 1 раза на разговор для причин отсутствия полноты.
function aiCmGsaAutoExportSkipLog(reason, cid, percentage) {
  try {
    if (reason === 'not-complete' || reason === 'probe-running') {
      var k = 'gsa:' + cid;
      if (notCompleteLogged[k]) return;
      notCompleteLogged[k] = 1;
    }
    debugLog('log', '[AI CM][auto-export] site=google_search skip reason=' + reason +
      ' convId=' + cid + ' pct=' + percentage +
      ' probeRunning=' + (aiCmGsaProbeRunningFor(cid) ? '1' : '0'));
  } catch (e) { }
}

function maybeAutoExport(percentage) {
  try {
    var s = autoExportSettings;
    if (!s || s.enabled !== true) return;
    // v1.18 (F2): convId автоэкспорта — URL-id, а для GSA threadId (site+convId = ключ латча)
    var cid = aiCmAutoExportConvId();
    if (cid !== autoExportLastConvId) {
      // гистерезис: смена чата — сброс антиспам-флага not-complete.
      // v44: autoExportFired НЕ стираем — он keyed по convId и переживает SPA-уход/возврат
      // того же чата в пределах сессии (сброс только при полной загрузке страницы);
      // гистерезис −10 ниже по-прежнему удаляет запись для ретрива внутри одного чата.
      notCompleteLogged = {};
      autoExportLastConvId = cid;
    }
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    var siteName = (currentAdapter && currentAdapter.siteName) || '';
    // S2: per-site порог 'aiCmAutoExportPct_<siteName>' (например aiCmAutoExportPct_chatgpt)
    // переопределяет глобальный autoExportSettings.pct для этого сайта; отсутствует —
    // глобальный. Кламп [1,100], финальный фолбэк 90 (utils/export-emit-pipeline.js).
    var perSiteThr = (typeof autoExportPctBySite === 'object' && autoExportPctBySite) ? autoExportPctBySite[siteName] : undefined;
    var threshold = (P && typeof P.effectiveAutoExportThreshold === 'function')
      ? P.effectiveAutoExportThreshold(s.pct, perSiteThr)
      : ((typeof s.pct === 'number' && s.pct >= 1 && s.pct <= 100) ? s.pct : 90); // v82 (D4): кламп [50,99] убран — v65 допускает 1–100
    if (typeof percentage !== 'number' || !(percentage >= 0)) return;
    // v82 (D7): pct сохраняем ТОЛЬКО из достоверного источника (сеть baseSeen=true
    // или Gemini). Транзиентный DOM-pct (baseSeen=false, не-Gemini) НЕ перезаписывает
    // autoExportLastPct — иначе 0→1 re-check при возврате в чат стреляет отравленным
    // pct прошлого чата (D5b) и гистерезис (v44, не трогаем) удаляет латч.
    if (baseSeen === true || siteName === 'gemini') {
      autoExportLastPct = percentage; // v42: запоминаем для re-check после стопа лоадера
    }
    // v81 (2.5): гейты автоэкспорта вынесены в чистую shouldSkipAutoExport
    // (utils/export-emit-pipeline.js); для Gemini порядок и смысл гейтов 1:1 прежние
    // (v30.5 полнота сети, v42 лоадер, гистерезис −10 п.п., латч already-fired).
    var isGeminiSvc = siteName === 'gemini';
    if (P && typeof P.shouldSkipAutoExport === 'function') {
      var verdict = P.shouldSkipAutoExport({
        enabled: s.enabled,
        percentage: percentage,
        threshold: threshold,
        baseComplete: baseComplete === true,
        baseSeen: baseSeen === true,
        loaderRunning: !!(cid && aiCmLoaderRunningByConv[cid]),
        // T1-fix#2 (v1.16.2): база из одного архива (baseCount <= archiveMsgs) полнотой
        // живого яруса не является — гейт внутри shouldSkipAutoExport (archive-pending-live).
        archiveCount: aiCmArchiveCountFor(cid),
        baseCount: baseCount,
        // v1.14.1 (O3): fired = in-memory ИЛИ session-латч (кросс-табовый)
        fired: P.getAutoExportFired(autoExportFired, siteName, cid) ||
               (typeof P.isFiredInSession === 'function' ? P.isFiredInSession(sessionFiredCache, siteName, cid) : false),
        isGemini: isGeminiSvc
      });
      if (verdict && verdict.skip) {
        // гистерезис −10 п.п.: общая точка сброса латча (для всех сайтов, включая GSA) —
        // семантика v1.14.1/O3 прежняя, просто вынесена из цепочки логов ниже.
        if (verdict.reason === 'below-threshold-hysteresis') {
          P.resetAutoExportFired(autoExportFired, siteName, cid);
          // v1.14.1 (O3): session-латч снимаем вместе с L1
          try {
            if (typeof P.firedSessionKey === 'function' && chrome.storage.session) {
              chrome.storage.session.remove(P.firedSessionKey(siteName, cid));
            }
          } catch (eO3hys) { }
        }
        // v1.18 (F5): GSA — tagged-строка лога с причиной fired/skip; причина not-complete
        // уточняется до probe-running, пока probe-полнота в полёте. Вердикт гейта ОДИН
        // (shouldSkipAutoExport выше) — здесь только формулировка причины, не новый вердикт.
        if (siteName === 'google_search') {
          var gsaReason = verdict.reason;
          if (verdict.reason === 'not-complete' && P && typeof P.notCompleteReason === 'function') {
            gsaReason = P.notCompleteReason({ site: siteName, probeRunning: aiCmGsaProbeRunningFor(cid) });
          }
          aiCmGsaAutoExportSkipLog(gsaReason, cid, percentage);
          return;
        }
        if (verdict.reason === 'not-complete') {
          // v30.5: fired НЕ ставим; лог не чаще 1 раза на convId
          if (cid && !notCompleteLogged[cid]) {
            notCompleteLogged[cid] = 1;
            debugLog('log', '[AI CM][auto-export] skip reason=not-complete convId=' + cid + ' pct=' + percentage);
          }
        } else if (verdict.reason === 'already-fired') {
          debugLog('log', '[AI CM][auto-export] skip reason=already-fired convId=' + cid);
        } else if (verdict.reason === 'loader-running') {
          debugLog('log', '[AI CM][auto-export] skip reason=loader-running convId=' + cid + ' pct=' + percentage);
        } else if (verdict.reason === 'archive-pending-live') {
          // T1-fix#2 (v1.16.2): латч fired НЕ ставится — поздний честный экспорт после
          // догрузки живой истории должен состояться. Лог не чаще 1 раза на чат.
          if (cid && !notCompleteLogged['arch:' + cid]) {
            notCompleteLogged['arch:' + cid] = 1;
            debugLog('log', '[AI CM][auto-export] skip reason=archive-pending-live convId=' + cid +
              ' baseCount=' + baseCount + ' archiveMsgs=' + aiCmArchiveCountFor(cid));
          }
        } else if (verdict.reason === 'below-threshold') {
          debugLog('log', '[AI CM][auto-export] skip reason=below-threshold convId=' + cid + ' pct=' + percentage);
        } else if (verdict.reason === 'below-threshold-hysteresis') {
          // сброс латча уже выполнен общей точкой выше — здесь только ничего не логируем
        } else if (verdict.reason === 'below-threshold-unreliable') {
          // v82 (D5): транзиентный DOM-pct (baseSeen=false) — латч НЕ трогаем, не логируем
        }
        return;
      }
      if (cid) { delete notCompleteLogged[cid]; delete notCompleteLogged['gsa:' + cid]; } // полнота пришла — можно снова логировать в другом чате
      if (!cid) return;
      doAutoExportDownload(cid, percentage, 'threshold');
      return;
    }
    // фолбэк (v81): утилита не загружена — прежний inline-гейт без изменений
    // T1-fix#2 (v1.16.2): плюс тот же архивный гейт, что и в shouldSkipAutoExport —
    // база из одного архива (baseCount <= archiveMsgs) права на экспорт не даёт.
    if (isGeminiSvc) {
      var archMsgsFb = aiCmArchiveCountFor(cid);
      if (archMsgsFb > 0 && baseCount <= archMsgsFb) {
        debugLog('log', '[AI CM][auto-export] skip reason=archive-pending-live convId=' + cid +
          ' baseCount=' + baseCount + ' archiveMsgs=' + archMsgsFb);
        return;
      }
    }
    if (baseComplete !== true) {
      if (cid && !notCompleteLogged[cid]) {
        notCompleteLogged[cid] = 1;
        debugLog('log', '[AI CM][auto-export] skip reason=not-complete convId=' + cid + ' pct=' + percentage);
      }
      return;
    }
    if (cid) delete notCompleteLogged[cid];
    if (cid && aiCmLoaderRunningByConv[cid]) {
      debugLog('log', '[AI CM][auto-export] skip reason=loader-running convId=' + cid + ' pct=' + percentage);
      return;
    }
    if (percentage < threshold - 10) {
      // v82 (D5): сброс латча только по достоверному сетевому pct
      if (baseSeen === true && cid) {
        delete autoExportFired[cid];
        // v1.14.1 (O3): session-латч снимаем вместе с L1
        try {
          if (P && typeof P.firedSessionKey === 'function' && chrome.storage.session) {
            chrome.storage.session.remove(P.firedSessionKey(siteName, cid));
          }
        } catch (eO3hys2) { }
      }
      return;
    }
    if (percentage < threshold) {
      debugLog('log', '[AI CM][auto-export] skip reason=below-threshold convId=' + cid + ' pct=' + percentage);
      return;
    }
    if (!cid) return;
    // v1.14.1 (O3): fired = in-memory ИЛИ session-латч (кросс-табовый)
    if (autoExportFired[cid] ||
        (P && typeof P.isFiredInSession === 'function' && P.isFiredInSession(sessionFiredCache, siteName, cid))) {
      debugLog('log', '[AI CM][auto-export] skip reason=already-fired convId=' + cid);
      return; // уже скачивали в этом чате
    }
    doAutoExportDownload(cid, percentage, 'threshold'); // v54: тело вынесено в хелпер
  } catch (e) {
    console.error('[AI CM][auto-export] error:', e);
  }
}

// v54: тело скачивания, вынесенное из maybeAutoExport для переиспользования спасательным
// pre-trim экспортом. reason='threshold' — поведение ровно как раньше; reason='pre-trim'
// добавляет суффикс -pretrim к имени файла и НЕ ставит латч autoExportFired
// (это независимый одноразовый экспорт по обрезке истории).
function doAutoExportDownload(cid, percentage, reason) {
  try {
    var B = (typeof window !== 'undefined' && window.AiCmExportBuilders) ? window.AiCmExportBuilders : null;
    if (!B) throw new Error('utils/export-text-builders.js не загружен');
    var fmt = (autoExportSettings.fmt === 'md') ? 'md' : ((autoExportSettings.fmt === 'json') ? 'json' : 'txt');
    // v81 (2.6): имя файла — ТОЛЬКО через пайплайн (utils/export-emit-pipeline.js);
    // site/модель — из текущего адаптера, не из Gemini-констант.
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    var siteNameD = (currentAdapter && currentAdapter.siteName) || '';
    // v81 (2.5): low-confidence НЕ ставится автоматически для не-Gemini (полный DOM-адаптер);
    // для Gemini — прежний флаг v63 (aiCmLowConfidenceByConv).
    // v1.18 (F4): для GSA — РОВНО baseComplete=0 (префикс [LOW CONFIDENCE]_ в ручном шаблоне).
    var lowConfD = (siteNameD === 'gemini')
      ? (aiCmLowConfidenceByConv[cid] === true)
      : ((siteNameD === 'google_search') ? (baseComplete !== true) : false);
    // v1.18 (F7): модель снапшота для имени файла GSA. lastSnapshotModelName заполняется для
    // GSA в resolveCurrentModel (реальная модель: сеть → DOM → дефолт сайта, как у бейджа);
    // фолбэк 'model' в buildGsaExportFileName остаётся ТОЛЬКО при реально пустой модели.
    var gsaModelD = (siteNameD === 'google_search' && typeof lastSnapshotModelName === 'string')
      ? lastSnapshotModelName : '';
    var file;
    if (siteNameD === 'google_search' && P && typeof P.buildGsaExportFileName === 'function') {
      // v1.18 (F4): GSA — имя файла по шаблону РУЧНОГО экспорта GSA
      // ([LOW CONFIDENCE]_ai-context-monitor-google_search-<model>-<метка>.<fmt>),
      // с причиной в диагностике, а не в имени (форматы txt/md/json — из селектора).
      file = P.buildGsaExportFileName(siteNameD, gsaModelD, lowConfD, fmt);
    } else if (P && typeof P.buildExportFileName === 'function') {
      file = P.buildExportFileName(siteNameD, cid, reason, lowConfD, fmt);
    } else {
      // фолбэк: прежнее имя файла (v54)
      var dFb = new Date();
      function ap2Fb(n) { return (n < 10 ? '0' : '') + n; }
      file = 'chat-' + String(cid).slice(0, 8) + '-' + dFb.getFullYear() + '-' + ap2Fb(dFb.getMonth() + 1) + '-' + ap2Fb(dFb.getDate()) +
        '_' + ap2Fb(dFb.getHours()) + '-' + ap2Fb(dFb.getMinutes()) +
        (reason === 'pre-trim' ? '-pretrim' : '') + '.' + fmt;
    }
    var msgs = buildHistoryMessages();
    // v82 (D3): защита от частичного выстрела — сеть ожидалась (baseSeen=true),
    // но сетевые тексты пусты → skip БЕЗ установки латча (поздний корректный
    // экспорт останется возможен). Для Gemini путь до этого не доходит:
    // гейт лоадера гарантирует применение базы до fired (поведение 1:1).
    if (baseSeen === true && lastBaseTexts.length === 0) {
      debugLog('log', '[AI CM][auto-export] skip reason=source-mismatch convId=' + cid +
        ' baseSeen=1 networkTexts=0');
      return;
    }
    // T1-fix#3 (v1.16.3): источник файла — ОБЪЕДИНЁННАЯ база (архив + live) из MAIN.
    // Гейт «в базе только архив» стоит ЗДЕСЬ — в единственной точке записи файла, поэтому
    // покрывает и пороговый путь, и триггер base-complete (v64), и pre-trim (v54), и
    // поздний re-check: ни один из них не может выгрузить одну архивную часть.
    var baseSrc = aiCmExportBaseSource(cid, msgs);
    var srcTag = 'local'; // какой массив реально уходит в файл
    if (baseSrc && baseSrc.blocked === true) {
      debugLog('log', '[AI CM][auto-export] skip reason=archive-pending-live convId=' + cid +
        ' baseMsgs=' + baseSrc.baseCount + ' liveMsgs=' + baseSrc.liveCount +
        ' archiveMsgs=' + baseSrc.archiveCount + ' source=archive-only-base');
      return; // латч fired НЕ ставится — поздний честный экспорт после догрузки live состоится
    }
    if (baseSrc && Array.isArray(baseSrc.msgs)) {
      debugLog('log', '[AI CM][auto-export] source=base-union convId=' + cid +
        ' baseMsgs=' + baseSrc.baseCount + ' localMsgs=' + (Array.isArray(msgs) ? msgs.length : 0) +
        ' liveMsgs=' + baseSrc.liveCount + ' archiveMsgs=' + baseSrc.archiveCount);
      msgs = baseSrc.msgs;
      srcTag = 'base-union';
    }
    // v1.19 (E-1): паспорт in-memory истории стреляющей вкладки. convId — lastEmitConvId
    // (та же запись EMIT, что питает бейдж и pct); у GSA url-id нет — историю адресует
    // threadId; прочие сервисы — convId из URL.
    var histConvIdMem = '';
    try {
      if (typeof lastEmitConvId === 'string' && lastEmitConvId) histConvIdMem = lastEmitConvId;
      else if (siteNameD === 'google_search' && typeof lastThreadId === 'string' && lastThreadId) histConvIdMem = lastThreadId;
      else if (typeof getCurrentConvId === 'function') histConvIdMem = getCurrentConvId() || '';
    } catch (eHistCid) { histConvIdMem = ''; }
    var histSiteMem = siteNameD;
    if (!Array.isArray(msgs) || msgs.length === 0) {
      // v1.19 (E-1): in-memory истории нет — единственный разрешённый фолбэк: per-host
      // ключ 'aiCmHistory:<host>' СВОЕЙ вкладки. Глобальный ключ aiCmHistory
      // (last-writer-wins между вкладками) для тела экспорта НЕ читается никогда.
      // Тот же provenance-гард: convId/site записи против cid/сайта стреляющей вкладки.
      var hostFb = '';
      try { hostFb = (typeof window !== 'undefined' && window.location && window.location.hostname) || ''; } catch (eHostFb) { }
      var hostKeyFb = hostFb ? ('aiCmHistory:' + hostFb) : '';
      var readFb = false;
      var fbDone = false;
      var onHostHistFb = function (data) {
        if (fbDone) return;
        fbDone = true;
        var rec = (data && typeof data === 'object') ? data[hostKeyFb] : null;
        if (!rec || !Array.isArray(rec.messages) || rec.messages.length === 0) {
          debugLog('log', '[AI CM][auto-export] skip reason=empty-history convId=' + cid +
            ' histSource=storage-host');
          return;
        }
        aiCmWriteAutoExportFile(rec.messages, 'storage-host', rec.convId || '', rec.site || '');
      };
      try {
        if (hostKeyFb && typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local &&
            typeof chrome.storage.local.get === 'function') {
          readFb = true;
          var maybePromiseFb = chrome.storage.local.get([hostKeyFb], onHostHistFb);
          if (maybePromiseFb && typeof maybePromiseFb.then === 'function') {
            maybePromiseFb.then(onHostHistFb, function () { onHostHistFb(null); });
          }
        }
      } catch (eHostRead) { readFb = false; }
      if (!readFb) {
        debugLog('log', '[AI CM][auto-export] skip reason=empty-history convId=' + cid);
      }
      return;
    }
    // v1.19 (E-1): ЕДИНСТВЕННАЯ точка записи файла. Тело собирается ТОЛЬКО из переданного
    // in-memory массива стреляющей вкладки (тот же массив, что питает бейдж и pct).
    // Provenance-гард: convId истории сверяется с cid стреляющей вкладки, site истории —
    // с currentAdapter.siteName; несовпадение → файл НЕ пишется (кросс-табная/кросс-чатная
    // подмена тела исключена; histSource/histConvId видны в fired-строке).
    function aiCmWriteAutoExportFile(fileMsgs, histSource, histConvId, histSite) {
      try {
        if ((histConvId && cid && String(histConvId) !== String(cid)) ||
            (histSite && siteNameD && String(histSite) !== String(siteNameD))) {
          debugLog('log', '[AI CM][auto-export] abort reason=history-source-mismatch histConvId=' +
            histConvId + ' site=' + histSite);
          return;
        }
        var msgs = fileMsgs;
        // v61diag: дамп turnsMap в момент fired автоэкспорта (md/txt)
        try { aiCmDumpTurnsSnapshot('snapshot-at-fired', cid, msgs); } catch (eDump) { }
        var hist = {
          site: (currentAdapter && currentAdapter.siteName) || '',
          model: ModelConfig.getModel(lastResolvedModelId || '')?.name || '',
          tokens: maxTokenCount,
          limit: 0,
          percent: percentage,
          messages: msgs
        };
        var content = (fmt === 'md')
          ? B.buildMdFromHistory(hist, (currentAdapter && currentAdapter.siteName) || 'AI Chat')
          : ((fmt === 'json')
            ? ((typeof B.buildJsonFromHistory === 'function')
              ? B.buildJsonFromHistory(hist, (currentAdapter && currentAdapter.siteName) || 'AI Chat')
              : '')
            : B.buildTxtFromHistory(hist));
        if (typeof content !== 'string') content = '';
        var textLen = String(content).replace(/^\uFEFF/, '').replace(/\s+/g, '').length;
        if (textLen <= 0) {
          debugLog('log', '[AI CM][auto-export] skip reason=empty-text convId=' + cid);
          return;
        }
        if (fmt === 'txt' && content.charAt(0) !== '\uFEFF') content = '\uFEFF' + content;
        if (reason !== 'pre-trim') {
          // v81 (2.5): латч «один раз на чат» — per service+convId (изоляция по сервису);
          // для Gemini ключ по-прежнему уникален на чат — поведение 1:1.
          var PDl = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
          if (PDl && typeof PDl.markAutoExportFired === 'function') {
            PDl.markAutoExportFired(autoExportFired, (currentAdapter && currentAdapter.siteName) || '', cid);
            // v1.14.1 (O3): кросс-табовый латч — пишем в storage.session и в локальный кэш
            try {
              var siteO3 = (currentAdapter && currentAdapter.siteName) || '';
              if (typeof PDl.sessionFiredPatch === 'function' && chrome.storage.session) {
                chrome.storage.session.set(PDl.sessionFiredPatch(siteO3, cid));
                var pkO3 = (typeof PDl.firedSessionKey === 'function') ? PDl.firedSessionKey(siteO3, cid) : null;
                if (pkO3) sessionFiredCache[pkO3] = 1;
              }
            } catch (eO3write) { }
          } else {
            autoExportFired[cid] = 1;
          }
        }
        aiCmCancelDeferredHistWrite(cid); // v54: экспорт состоялся — висящий deferred-таймер больше не нужен
        B.downloadBlob(content, file, fmt === 'md' ? 'text/markdown' : (fmt === 'json' ? 'application/json' : 'text/plain;charset=utf-8'));
        debugLog('log', '[AI CM][auto-export] fired convId=' + cid + ' pct=' + percentage + ' file=' + file +
          ' textLen=' + textLen + ' pendingCursor=' + (aiCmCursorLiveByConv[cid] ? '1' : '0') +
          ' baseComplete=' + (baseComplete === true ? '1' : '0') +
          ' histSource=' + histSource + ' histConvId=' + histConvId);
        // v1.18 (F5): GSA — дополнительная tagged-строка fired (общая строка выше сохранена
        // байтово: на ней стоит пин порядка логов H21).
        if (siteNameD === 'google_search') {
          debugLog('log', '[AI CM][auto-export] site=google_search fired convId=' + cid +
            ' pct=' + percentage + ' file=' + file + ' fmt=' + fmt +
            ' model=' + (gsaModelD || '') +
            ' lowConfidence=' + (lowConfD === true ? '1' : '0') +
            ' baseComplete=' + (baseComplete === true ? '1' : '0') +
            ' histSource=' + histSource + ' histConvId=' + histConvId);
        }
      } catch (eInner) {
        console.error('[AI CM][auto-export] error:', eInner);
      }
    }
    // v1.19 (E-1): тело файла — ТОЛЬКО in-memory история этой вкладки (histSource=memory)
    aiCmWriteAutoExportFile(msgs, 'memory', histConvIdMem, histSiteMem);
  } catch (e) {
    console.error('[AI CM][auto-export] error:', e);
  }
}
loadAutoExportSettings();
// v42: состояние лоадера Gemini наружу ПО convId (MAIN → ISOLATED через window-CustomEvent).
// На running=false по текущему чату — re-check гейта экспорта: badge-update к этому моменту
// может уже не прийти, а раньше стрельнуть помешал skip reason=loader-running.
window.addEventListener('ai-cm-loader-state', function (ev) {
  try {
    var d = ev && ev.detail;
    if (!d || !d.convId) return;
    if (d.running) {
      aiCmLoaderRunningByConv[d.convId] = 1;
      aiCmCursorLiveByConv[d.convId] = !!d.pendingCursor;
      // v1.13.1: подтверждение полноты — baseComplete при reachedStart=true
      aiCmBaseConfirmedByConv[d.convId] = (d.baseComplete === true && d.reachedStart === true) ? 1 : 0;
      return;
    }
    delete aiCmLoaderRunningByConv[d.convId];
    aiCmCursorLiveByConv[d.convId] = !!d.pendingCursor;
    // v1.13.1: подтверждение полноты базы по стопу лоадера (baseComplete при reachedStart=true)
    aiCmBaseConfirmedByConv[d.convId] = (d.baseComplete === true && d.reachedStart === true) ? 1 : 0;
    // v1.13.1: при неподтверждённой базе deferred НЕ флашится — висит до base-complete
    // (либо видимого таймаута «счётчик стабилен»).
    if (aiCmBaseConfirmedByConv[d.convId] === 1) {
      aiCmFlushDeferredHistWrite(d.convId, 'loader-stop'); // v52: флаш отложенной записи истории
    } else {
      debugLog('log', '[AI CM][export] deferred kept reason=base-unconfirmed convId=' + d.convId +
        ' baseComplete=' + (d.baseComplete === true ? '1' : '0') +
        ' reachedStart=' + (d.reachedStart === true ? '1' : '0'));
    }
    var cid = getCurrentConvId() || '';
    if (cid && cid === d.convId && autoExportSettings.enabled === true &&
        typeof autoExportLastPct === 'number' && autoExportLastPct >= 0) {
      // v53: инвариант автоэкспорта — при стопе лоадера стреляем ТОЛЬКО когда база полная
      // И курсор продолжения уже ушёл. Иначе: НЕ стреляем, НЕ ставим already-fired и
      // планируем одноразовый поздний re-check на момент, когда база впервые станет полной
      // (порог превышен → fired + лог). Это закрывает холодный старт (недозагрузка истории).
      // v1.13.1: требуется подтверждённая полнота (reachedStart=true) — иначе ждём.
      if (baseComplete !== true || aiCmBaseConfirmedByConv[cid] !== 1 || !!d.pendingCursor) {
        aiCmLateCheckByConv[cid] = 1;
        aiCmTryLateAutoExport(cid);
        debugLog('log', '[AI CM][auto-export] loader-stop с неполной базой → не стреляю, жду base-complete convId=' + cid +
          ' pct=' + autoExportLastPct + ' pendingCursor=' + (!!d.pendingCursor ? '1' : '0') +
          ' baseComplete=' + (baseComplete === true ? '1' : '0'));
      } else {
        debugLog('log', '[AI CM][auto-export] re-check после стопа лоадера convId=' + cid + ' pct=' + autoExportLastPct);
        maybeAutoExport(autoExportLastPct);
      }
    }
    // v64: второй триггер автоэкспорта — один раз на чат при завершённой сборке:
    // (loader done && baseComplete=1 && pendingCursor=0 && msgs>0). Переиспользуем
    // существующий латч «один раз на чат» autoExportFired (keyed по convId);
    // пороговый триггер maybeAutoExport не изменён.
    // H21 (порядок логов инвертирован, функционал корректен — гейты не менялись):
    // в ОДНОМ loader-stop событии сначала идёт re-check после стопа лоадера (выше),
    // и его пороговый гейт видит КРОСС-ТАБОВЫЙ session-латч (isFiredInSession) →
    // пишет «skip reason=already-fired». Затем этот блок: его гейт читает ТОЛЬКО
    // in-memory autoExportFired, поэтому при session-латче из прошлой вкладки или
    // после перезагрузки страницы он пишет «base-complete trigger» и затем «fired».
    // Отсюда в логе already-fired стоит РАНЬШЕ base-complete trigger/fired, хотя
    // fired в этом событии ещё не было. Экспорт при этом ровно один (пороговый путь
    // пропущен session-латчем), поэтому гейты и порядок триггеров НЕ трогаем.
    // Пин порядка логов: tests/autoexport-log-order-h21.test.js.
    try {
      if (cid && cid === d.convId && autoExportSettings.enabled === true &&
          baseComplete === true && !aiCmCursorLiveByConv[cid] &&
          !(function () {
            // v81 (2.5): латч per service+convId
            var Pbc = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
            if (Pbc && typeof Pbc.getAutoExportFired === 'function') {
              return Pbc.getAutoExportFired(autoExportFired, (currentAdapter && currentAdapter.siteName) || '', cid);
            }
            return autoExportFired[cid] === 1;
          })() && (baseCount || 0) > 0) {
        var pctBc64 = (typeof autoExportLastPct === 'number' && autoExportLastPct >= 0) ? autoExportLastPct : 0;
        debugLog('log', '[AI CM][auto-export] base-complete trigger convId=' + cid +
          ' msgs=' + baseCount + ' pendingCursor=0 baseComplete=1 pct=' + pctBc64);
        doAutoExportDownload(cid, pctBc64, 'base-complete');
      }
    } catch (eBc64) { console.error('[AI CM][auto-export] base-complete trigger error:', eBc64); }
  } catch (e) {
    console.error('[AI CM][auto-export] loader-state error:', e);
  }
});

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
  // H22: тема сервиса может жить на элементе-хосте .theme-host — следим и за ним
  const themeHostEl = document.querySelector('.theme-host');
  if (themeHostEl && themeHostEl !== document.documentElement && themeHostEl !== document.body) {
    themeObserver.observe(themeHostEl, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }
  // H22: пересчёт палитры при смене темы ОС/браузера (in-app смена темы ловится наблюдателем выше)
  try {
    const mqlTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mqlTheme && mqlTheme.addEventListener) mqlTheme.addEventListener('change', () => applyNativeStyles(container));
  } catch (eMq) { }
  aiCmStartThemePoll(); // H25: медленный дубль-страховка (атрибутов и matchMedia может не хватить)
  processAndSend();
}
function updateWidget(percentage, tokens, effectiveLimit, contextLimit, displayLimit, modelName, attachBreak) {
  if (!widgetElement) return;
  // T1 (v1.16): строка источника в панели виджета. Вызов защищён try/catch: updateWidget
  // исполняется и в изолированных песочницах (collapse-guard/тесты темы), где хелпера нет —
  // отрисовка виджета не должна от этого падать.
  try { aiCmUpdateSourceIndicator(); } catch (eSrcW) { }
  aiCmRefreshThemeIfNeeded(); // H25: каждая отрисовка — дешёвая проверка смены темы (гард тихий)
  debugLog('log', '[AI CM][trace] badge-update pct=' + percentage + '% tokens=' + tokens + ' model=' + modelName);
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
  percentText.textContent = stale ? '—' : (percentage.toFixed(1) + '%');
  if (tooltip) {
    const limPct = aiCmActivePct();
    const limLine = (limPct != null)
      ? `Предел: ${limPct}% от Авто = ${displayLimit.toLocaleString()} ток`
      : `Предел: Авто = ${effectiveLimit.toLocaleString()} ток`;
    // v1.10.x: безопасный рендер тултипа (textContent вместо innerHTML)
    const esc = String;
    const lines = [
      `Модель: ${esc(modelName)}`,
      `Токены: ${tokens.toLocaleString()}`,
      limLine,
      `Окно модели: ${contextLimit.toLocaleString()}`
    ];
    // T1 (v1.16): индикатор источника (первый ярус — архив / второй — live)
    try { if (aiCmSourceLabelNow) lines.push(`Источник: ${esc(aiCmSourceLabelNow)}`); } catch (eSrcL) { }
    if (attachBreak && (attachBreak.imgCount > 0 || attachBreak.docCount > 0)) {
      lines.push(`Вложения ≈ ${(attachBreak.imgTokens + attachBreak.docTokens).toLocaleString()} токенов`);
      if (attachBreak.imgCount > 0) lines.push(`· картинки: ${attachBreak.imgCount} шт ≈ ${attachBreak.imgTokens.toLocaleString()} (по 2 тайла)`);
      if (attachBreak.docCount > 0) lines.push(`· файлы: ${attachBreak.docCount} шт ≈ ${attachBreak.docTokens.toLocaleString()} (оценочно)`);
    }
    while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
    lines.forEach((line, i) => {
      if (i > 0) tooltip.appendChild(document.createElement('br'));
      tooltip.appendChild(document.createTextNode(line));
    });
  }
}
// ========== СЛУШАТЕЛЬ POPUP ==========
if (isExtensionValid()) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'aiCmDiag') {
      handleAiCmDiag(sendResponse);
      return true;
    }
    if (message.type === 'aiCmExportCurrent') {
      // v1.13.1: ручной/принудительный экспорт — снимок ТОЛЬКО текущего convId.
      // После SPA-перехода lastBaseTexts сброшены (resetConversationState) → messages=[]
      // (файл-заглушка); НИКОГДА не отдаём историю предыдущего разговора.
      var curCidExp = getCurrentConvId() || '';
      var pctExp = (typeof lastPercentage === 'number' && lastPercentage >= 0) ? lastPercentage : 0;
      // v61diag: дамп turnsMap в момент ручного экспорта (md/txt из options)
      try { aiCmDumpTurnsSnapshot('snapshot-at-manual', curCidExp, null); } catch (eDumpM) { }
      sendResponse({ data: {
        host: window.location.hostname,
        convId: curCidExp,
        site: (currentAdapter && currentAdapter.siteName) || '',
        model: lastSnapshotModelName || (lastResolvedModelId || ''),
        tokens: maxTokenCount,
        limit: computeEffectiveLimit(lastResolvedModelId),
        percent: pctExp,
        updatedAt: Date.now(),
        // v1.14.1: живой флаг — ручной as-is экспорт при baseComplete=0 получает
        // префикс [LOW CONFIDENCE]_ (options.js:378), после base-complete — без префикса.
        isLowConfidenceBase: (baseComplete !== true),
        messages: buildHistoryMessages()
      } });
      return true;
    }
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

// ========== ЭКСПОРТ ДИАГНОСТИКИ ==========
// popup шлёт {type:'aiCmDiag'}. content.js (ISOLATED) дёргает MAIN-перехватчик через
// window.dispatchEvent('ai-cm-diag-request') и ждёт 'ai-cm-diag-response'.
function handleAiCmDiag(sendResponse) {
  var intercepted = null;
  var timer = null;

  function finishWithResponse() {
    if (timer) { clearTimeout(timer); timer = null; }
    // метаданные aiCmHistory из chrome.storage.local (если записаны для этого хоста)
    try {
      chrome.storage.local.get(['aiCmHistory'], function (data) {
        var h = data.aiCmHistory;
        var sameHost = !!(h && h.host === window.location.hostname);
        var meta = sameHost ? {
          host: h.host,
          model: h.model || '',
          tokens: (typeof h.tokens === 'number') ? h.tokens : 0,
          percent: (typeof h.percent === 'number') ? h.percent : 0,
          count: (Array.isArray(h.messages)) ? h.messages.length : 0
        } : {
          host: window.location.hostname,
          model: '',
          tokens: 0,
          percent: 0,
          count: 0
        };
        var historyPreviews = [];
        if (sameHost && Array.isArray(h.messages)) {
          for (var i = 0; i < h.messages.length; i++) {
            var msg = h.messages[i] || {};
            historyPreviews.push((msg.role || '?') + '|' + String(msg.text || '').slice(0, 60).replace(/\s+/g, ' '));
          }
        }
        var diag = {
          generatedAt: new Date().toISOString(),
          url: window.location.href,
          logsContent: (typeof __aiCmGetLogRing === 'function') ? __aiCmGetLogRing() : [],
          aiCmHistoryMeta: meta,
          historyPreviews: historyPreviews,
          intercept: intercepted || null
        };
        sendResponse({ ok: true, diag: diag });
      });
    } catch (e) {
      sendResponse({ ok: true, diag: { generatedAt: new Date().toISOString(), url: window.location.href, logsContent: [], aiCmHistoryMeta: null, historyPreviews: [], intercept: intercepted } });
    }
  }

  function onResponse(ev) {
    try { intercepted = (ev && ev.detail) || null; } catch (e) { intercepted = null; }
    finishWithResponse();
  }

  window.addEventListener('ai-cm-diag-response', onResponse);

  // таймаут: если перехватчик (MAIN-мир) не ответил (не Gemini / не установлен) — отдаём без intercept.
  timer = setTimeout(finishWithResponse, 900);

  try { window.dispatchEvent(new CustomEvent('ai-cm-diag-request')); } catch (e) { }
}
// ========== v31: ФЛАГ «ПОДРОБНЫЕ ЛОГИ» (aiCmDebugLogs, по умолчанию ВЫКЛ) ==========
function applyDebugLogs(v) {
  __aiCmSetDebugLogs(v);
  // транслируем в MAIN-мир перехватчикам (у них свой debug.js)
  try { window.dispatchEvent(new CustomEvent('ai-cm-debug-logs', { detail: !!v })); } catch (e) { }
}
if (isExtensionValid()) {
  try {
    chrome.storage.local.get(['aiCmDebugLogs'], function (data) {
      applyDebugLogs(data.aiCmDebugLogs === true);
    });
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName === 'local' && changes.aiCmDebugLogs) {
        applyDebugLogs(changes.aiCmDebugLogs.newValue === true);
      }
    });
  } catch (e) { }
}
// ========== v44-B3: PASTE-CAPTURE (только claude.ai): клиентский источник pasted-текста ==========
// ISOLATED world слушает paste и пересылает текст в MAIN-мир перехватчика через postMessage.
(function () {
  try {
    if (!window.location.hostname.includes('claude.ai')) return;
    document.addEventListener('paste', function (e) {
      try {
        var t = e.clipboardData && e.clipboardData.getData('text');
        if (t && String(t).trim()) {
          window.postMessage({ source: 'ai-cm-paste', text: String(t).slice(0, 500000) }, window.origin);
          debugLog('log', '[AI CM][Claude][pasted] paste-capture len=' + t.length);
          // v46-2: диагностика канала ISOLATED→MAIN — отправка
          debugLog('log', '[AI CM][Claude][pasted] paste-send len=' + t.length);
        }
      } catch (e2) { }
    }, true); // capture-фаза: до обработчиков сайта
  } catch (e) { }
})();
// ========== ЗАПУСК ==========
setTimeout(() => initialize(), 1500);
scheduleStaleCheck(); // фиксируем момент загрузки страницы для 12с-проверки
// ========== ГОРЯЧАЯ КЛАВИША Ctrl+Shift+D: скачать JSON дампа ==========
document.addEventListener('keydown', function (e) {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    var turns = [];
    for (var i = 0; i < lastBaseIds.length; i++) {
      var t = lastBaseTexts[i] || '';
      turns.push({
        id: lastBaseIds[i], len: t.length,
        preview: t.slice(0, 60).replace(/\s+/g, ' ')
      });
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
        aiCmStopThemePoll(); // H25: виджета нет — опрос темы больше не нужен
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
    // T1 (v1.16): архив импортирован/удалён в options — применяем к ОТКРЫТОМУ чату сразу
    // (импорт в другом окне; собственный onChanged в options.js пишет те же ключи).
    try {
      var cidArcCh = getCurrentConvId() || '';
      if (cidArcCh) {
        var archKeyCh = AI_ARCHIVE_PREFIX + cidArcCh;
        var srcKeyCh = AI_CONV_SOURCE_PREFIX + cidArcCh;
        if (changes[archKeyCh] || changes[srcKeyCh]) {
          delete aiCmArchiveRestoredDispatched[cidArcCh]; // повторный dispatch с новым архивом
          aiCmLoadArchiveTier(cidArcCh, 'storage-changed');
        }
      }
    } catch (eArcCh) { }
    // H19: оверрайды попапа изменились (другая вкладка/сам попап) — пересчёт display-цепочки
    if (changes.selectedModel || changes.customLimit) {
      if (changes.selectedModel) popupRawModel = changes.selectedModel.newValue;
      if (changes.customLimit) popupRawPct = changes.customLimit.newValue;
      aiCmRefreshPopupOverrides();
    }
    // S2: per-site порог автоэкспорта изменился (options/иная вкладка) — обновляем
    // кэш и пере-оцениваем автоэкспорт на последнем достоверном pct.
    try {
      var perSiteChKey = null;
      for (var chPsKey in changes) {
        if (chPsKey.indexOf('aiCmAutoExportPct_') === 0) { perSiteChKey = chPsKey; break; }
      }
      if (perSiteChKey) {
        var siteCh = perSiteChKey.slice('aiCmAutoExportPct_'.length);
        var nvPs = changes[perSiteChKey].newValue;
        var nPs = parseInt(nvPs, 10);
        autoExportPctBySite[siteCh] = (!isNaN(nPs) && nPs >= 1 && nPs <= 100) ? nPs : undefined;
        debugLog('log', '[AI CM][auto-export] per-site onChanged ' + perSiteChKey + '=' +
          (autoExportPctBySite[siteCh] === undefined ? 'нет (глобальный фолбэк)' : autoExportPctBySite[siteCh]));
        if (isInitialized && typeof autoExportLastPct === 'number' && autoExportLastPct >= 0) {
          maybeAutoExport(autoExportLastPct);
        }
      }
    } catch (ePerSite) { }
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

