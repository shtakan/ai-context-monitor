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
// ========== M-4.2: i18n пользовательских строк контент-скрипта ==========
// Динамические строки виджета/тултипа/панели берутся из _locales через
// chrome.i18n.getMessage (ключи content_* есть и в ru, и в en). chrome.i18n недоступен
// (jsdom-тесты, изолированные песочницы, отладочный контекст) → возвращается прежний
// русский литерал: внешний вид без локали байтово прежний. $1..$9 в сообщении локали
// подставляются переданными substitutions (как в chrome.i18n.getMessage(key, [...])).
function aiCmI18nMessage(key, fallback, substitutions) {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
      var message = substitutions ? chrome.i18n.getMessage(key, substitutions) : chrome.i18n.getMessage(key);
      if (message) return message;
    }
  } catch (eMessage) { }
  return fallback;
}

// ===== v2.0 (этап 1/3): state.js ← currentAdapter, observer, isInitialized, lastPercentage, updateTimer, widgetElement, lastWidgetData, badgeSuppressed, maxTokenCount, restoredTapeLoaded, restoreDone, cacheRefreshPlanned, tapeRestoreSeen, aiCmTapeAccountIdx, aiCmRestoredDispatched, baseText, baseCount, baseSeen, baseComplete, lastBounded, lastTailSig, lastBaseSig, lastEmitSig, lastDrawSig, lastHybridTailSig =====

// ===== v2.0 (этап 1/3): state.js ← notCompleteLogged =====

// ===== v2.0 (этап 1/3): state.js ← aiCmLoaderFreeze =====

// ===== v2.0 (этап 1/3): state.js ← baseIdSet, lastBaseIds, lastBaseTexts, baseSkelSet, baseAnchors, ANCHOR_MIN =====

// ===== v2.0 (этап 1/3): state.js ← stale, staleTimer =====

// ===== v2.0 (этап 1/3): state.js, base-handler.js, export-manager.js ← lastDetailMessages, lastHistoryWroteKey, lastThreadId, aiCmHostHistoryRecord, sanitizeGeminiText, aiCmCollectExportSource, aiCmLogIntraDedupe, aiCmDedupeExportSource, lastDedupeLogSig, aiCmLogDedupeRemoved, buildHistoryMessages, aiCmBasePrepared, aiCmPreparedText, aiCmMetricBaseText =====

// ===== v2.0 (этап 1/3): base-handler.js ← aiCmDiagHash6, aiCmGeminiTurnsSnapshotSync, aiCmDumpTurnsSnapshot =====

// ===== v2.0 (этап 1/3): export-manager.js ← aiCmExportBaseSource =====

// ===== v2.0 (этап 1/3): base-handler.js ← scheduleStaleCheck =====

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

// ===== v2.0 (этап 1/3): state.js ← detectedModelSlug, lastResolvedModelId, lastSnapshotModelName =====

// ===== v2.0 (этап 1/3): state.js ← netAttachTokens, netAttachBreak =====

// ===== v2.0 (этап 1/3): state.js ← netServerTokens, netEffectiveLen =====

// ===== v2.0 (этап 1/3): state.js ← exactCountEnabled, geminiApiKey, lastCountTokensText, lastCountTokensCache, countTokensTimer, countTokensPending =====

var AI_CM_BYOK_SESSION_KEY = 'aiCmApiKeySession';
// Известные имена plaintext-ключа BYOK прежних версий (chrome.storage.local).
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
  for (var iLk = 0; iLk < AI_CM_BYOK_LEGACY_KEYS.length; iLk++) {
    var vLk = data ? data[AI_CM_BYOK_LEGACY_KEYS[iLk]] : null;
    if (typeof vLk === 'string' && vLk) return vLk;
  }
  return '';
}

// M-7: чтение ключа BYOK. Первичен session; plaintext прежних версий в local —
// только переходный фолбэк на окно миграции (саму миграцию делает background SW).
function aiCmReadByokKey(cb) {
  var finished = false;
  function finish(v) { if (!finished) { finished = true; cb(v || ''); } }
  try {
    if (!chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== 'function') { finish(''); return; }
    chrome.storage.session.get([AI_CM_BYOK_SESSION_KEY], function (d) {
      var v = d ? d[AI_CM_BYOK_SESSION_KEY] : '';
      if (typeof v === 'string' && v) { finish(v); return; }
      try {
        chrome.storage.local.get(AI_CM_BYOK_LEGACY_KEYS, function (dl) { finish(aiCmFirstLegacyByokKey(dl)); });
      } catch (eLeg) { finish(''); }
    });
  } catch (eKey) { finish(''); }
}

// ===== v2.0 (этап 1/3): state.js, widget.js ← safePct, popupRawModel, popupRawPct, popupModelId, popupLimitPct, safePctKey, zoneColor, aiCmActivePct, computeEffectiveLimit, aiCmSetPopupOverrides, aiCmRefreshPopupOverrides, aiCmLoadPopupOverrides, updatePanel, snapCurrentPct, setSafePctFromInput, resetSafePct, stepSafePct =====

// ============================================================================================

// ===== v2.0 (этап 1/3): widget.js ← resetConversationState =====

// v55 (SPA): трекаем convId на content-стороне; при смене — лог, отмена висящего
// deferred-таймера старого разговора и сброс бейджа таба в SW.
var aiCmLastSeenConvId = getCurrentConvId() || '';
// O-35 (ДИАГНОСТИКА, только измерение): метка времени последнего сброса по сигналу смены
// разговора. Нужна строке qwen-adapter («сколько прошло от сброса до пересъёма базы»).
// Ничего кроме собственного числа не хранит и ни на что не влияет.
var aiCmQwenSpaResetAt = 0;
window.addEventListener('ai-cm-conversation-changed', function () {
  try {
    var newCid = getCurrentConvId() || '';
    // O-22 (диагностика, только измерение): строка НА КАЖДЫЙ диспатч события;
    // показывает, что resetConversationState() ниже вызывается БЕЗУСЛОВНО (в т.ч. когда
    // newCid не изменился) — и какой lastHistoryWroteKey при этом стирается (гипотеза F4-a).
    try {
      if (typeof aiCmDiagLine === 'function') {
        aiCmDiagLine('o22-conv-changed', {
          ts: Date.now(),
          convId: newCid || '(none)',
          prev: aiCmLastSeenConvId || '(none)',
          changed: (newCid !== aiCmLastSeenConvId) ? 1 : 0,
          lastHistKey: (typeof lastHistoryWroteKey !== 'undefined') ? lastHistoryWroteKey : undefined,
          verdict: 'reset-unconditional'
        });
      }
    } catch (eO22a) { }
    // O-35 (ДИАГНОСТИКА, только измерение): qwen-spa — приём сигнала смены разговора на
    // ISOLATED-стороне. Именно этой строки НЕ будет на chat.qwen.ai, пока перехватчик не
    // диспатчит событие (дефект C): у qwen хук смены чата живёт только в MAIN-мире.
    try {
      if (typeof aiCmDiagLine === 'function' && currentAdapter && currentAdapter.siteName === 'qwen') {
        aiCmDiagLine('qwen-spa', {
          ts: Date.now(), event: 'conv-changed-recv',
          convId: newCid || '(none)', prev: aiCmLastSeenConvId || '(none)',
          changed: (newCid !== aiCmLastSeenConvId) ? 1 : 0,
          url: String((typeof location !== 'undefined' && location && location.href) || '')
        });
      }
    } catch (eQspa) { }
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
  // O-27/O-32 (диагностика): причина сброса — сигнал смены разговора (SPA).
  aiCmGsaDiagState('conv-changed', 'reset', 'conversation-id-change', {
    convId: String(getCurrentConvId() || ''),
    lastSeenConvId: String(aiCmLastSeenConvId || '')
  });
  resetConversationState();
  // O-35 (B2, фикс): счётчик DOM-адаптерной базы ПОКИНУТОГО чата не перетекает в новый —
  // метка «Источник» нового разговора до первого пересъёма снова пуста (как и было).
  aiCmAdapterBaseCount = 0;
  // O-35 (ДИАГНОСТИКА, только измерение): qwen-spa — ФАКТ сброса состояния виджета этим
  // сигналом (baseSeen/baseText/baseCount/maxTokenCount/netServerTokens обнулены,
  // badgeSuppressed=true, снимок попапа удалён). «Пересъём» после сброса виден строками
  // qwen-adapter (msgs/convId/url на каждой записи истории) и qwen-badge (следующая отрисовка).
  try {
    if (typeof aiCmDiagLine === 'function' && currentAdapter && currentAdapter.siteName === 'qwen') {
      aiCmQwenSpaResetAt = Date.now();
      aiCmDiagLine('qwen-spa', {
        ts: aiCmQwenSpaResetAt, event: 'reset-done', reason: 'conversation-id-change',
        convId: String(getCurrentConvId() || '') || '(none)',
        url: String((typeof location !== 'undefined' && location && location.href) || ''),
        baseSeen: (baseSeen === true) ? 1 : 0, baseCount: (typeof baseCount === 'number') ? baseCount : 0
      });
    }
  } catch (eQspaR) { }
  // O-35 (C, фикс): qwen — SPA-смена разговора обязана ПОДНЯТЬ ISOLATED-контур БЕЗ F5.
  // До фикса перехватчик не диспатчил это событие (qwen-intercept.js:dispatched=0 → 1),
  // слушатель не срабатывал, и на SPA-открытом чате попап оставался без данных («—»),
  // кнопки ручного экспорта — неактивны, база не писалась до перезагрузки. Что делает
  // реактивация — см. aiCmQwenSpaReshoot(): повторный детект сайта/адаптера + адаптерный
  // пересъём базы по НОВОМУ convId (аналог bootstrapSnapshot у Claude/Perplexity).
  try {
    if (typeof aiCmDiagLine === 'function' && currentAdapter && currentAdapter.siteName === 'qwen') {
      aiCmDiagLine('qwen-spa', {
        ts: Date.now(), event: 'reshoot',
        convId: String(getCurrentConvId() || '') || '(none)',
        initialized: (isInitialized === true) ? 1 : 0,
        url: String((typeof location !== 'undefined' && location && location.href) || '')
      });
    }
  } catch (eQspaSh) { }
  aiCmQwenSpaReshoot();
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

// ===== v2.0 (этап 1/3): state.js ← aiCmLastDomEmitSig =====

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

// ===== v2.0 (этап 1/3): hybrid-tail.js ← normalize, stripMd =====

// ===== v2.0 (этап 1/3): hybrid-tail.js ← MSG_SELECTORS =====

// ===== v2.0 (этап 1/3): hybrid-tail.js ← findMessageNodes =====

// ===== v2.0 (этап 1/3): hybrid-tail.js ← nodeIsBase =====

// ===== v2.0 (этап 1/3): hybrid-tail.js ← shouldUseGeminiDomParser =====

// ===== v2.0 (этап 1/3): hybrid-tail.js ← computeTailFromDom =====

// ===== v2.0 (этап 1/3): hybrid-tail.js ← getEffectiveText, getEffectiveCount =====

// ===== v2.0 (этап 1/3): state.js ← lastEmitConvId, lastSnapConvId =====

// ===== O-31: сегментация базы по разговору (Google Search AI) =====
// threadId живого DOM — «какой разговор открыт сейчас» (атрибут GSA; на прочих сайтах '').
function aiCmDomThreadId() {
  try {
    var el = document.querySelector('[data-session-thread-id]');
    if (!el) return '';
    var v = el.getAttribute('data-session-thread-id');
    return v ? String(v).trim() : '';
  } catch (e) { return ''; }
}

// Снимок принадлежит ТЕКУЩЕМУ разговору? Снимок чужого треда (поздний ответ старого
// разговора после SPA-переключения) в базу не применяется: ни baseCount/baseText (pct),
// ни lastBaseTexts (экспорт), ни счётчики svc-emit-trace. Нет threadId/нет DOM-атрибута —
// прежнее поведение.
function aiCmSnapshotIsCurrentThread(emitThreadId, domThreadId) {
  if (!emitThreadId) return true;
  if (!domThreadId) return true;
  return String(emitThreadId) === String(domThreadId);
}

// ===== O-27 (b): признак ЧАТ-страницы GSA для гейта автоэкспорта =====
// Чат-страница Google Search AI определяется ровно двумя признаками: threadId снаффнут
// в DOM ([data-session-thread-id]) ИЛИ в DOM есть чат-контейнер (turn/aimfl). Сервисная
// страница Google (captcha / «подозрительный трафик» /sorry) не содержит ни того, ни
// другого — там база/pct прошлого документа права на файл не дают.
function aiCmGsaChatPageMarker() {
  try {
    if (typeof aiCmDomThreadId === 'function' && aiCmDomThreadId()) return true;
    if (document.querySelector('[data-scope-id="turn"]')) return true;
    if (document.querySelector('[data-subtree="aimfl"]')) return true;
  } catch (e) { }
  return false;
}

// ===== O-27 (c): состояние ПРОШЛОГО документа не переживает не-чат документ GSA =====
// Полная навигация даёт новый экземпляр (состояние и так пусто), но подмена документа
// сервисной страницей (captcha) в живом SPA/документе оставляла базу, pct и pct-latch
// прошлого разговора. Здесь они гасятся — до следующего сетевого EMIT базы нет, гейт
// автоэкспорта молчит. Чат-страница (threadId/контейнер в DOM) не трогается вовсе:
// байты и маска экспорта чат-страниц прежние.
//
// O-27/O-32 (диагностика, только измерение): aiCmGsaDiagState печатает тип документа
// (captcha/чат/поиск) и причину сброса/несброса под гейтом aiCmDebug. Строки «несброс»
// с антиспамом (одна на комбинацию причин за страницу), «сброс» — всегда (событие редкое).
// Поведение не меняется: функция только читает уже посчитанное состояние.
var aiCmGsaDiagNoResetLogged = {};
function aiCmGsaDiagState(point, verdict, reason, extra) {
  try {
    var doc = (typeof aiCmDiagDocKind === 'function') ? aiCmDiagDocKind() : 'unknown';
    if (verdict === 'no-reset') {
      var key = String(point) + '|' + String(reason) + '|' + String(doc);
      if (aiCmGsaDiagNoResetLogged[key] === 1) return false;
      aiCmGsaDiagNoResetLogged[key] = 1;
    }
    var f = {
      point: point,
      verdict: verdict,
      reason: reason,
      doc: doc,
      site: (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName) || '',
      baseSeen: (typeof baseSeen !== 'undefined' && baseSeen === true) ? 1 : 0,
      baseComplete: (typeof baseComplete !== 'undefined' && baseComplete === true) ? 1 : 0,
      baseCount: (typeof baseCount === 'number') ? baseCount : 0,
      threadId: (typeof aiCmDomThreadId === 'function') ? aiCmDomThreadId() : ''
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) f[k] = extra[k];
      }
    }
    if (typeof aiCmDiagLine === 'function') aiCmDiagLine('gsa-state', f);
    return true;
  } catch (eDiagState) { return false; }
}
function aiCmGsaResetStaleStateOnChatlessDoc() {
  try {
    if (!currentAdapter || currentAdapter.siteName !== 'google_search') return false;
    if (typeof document === 'undefined' || document.readyState !== 'complete') {
      aiCmGsaDiagState('reset-stale', 'no-reset', 'doc-not-complete');
      return false;
    }
    if (aiCmGsaChatPageMarker()) {
      aiCmGsaDiagState('reset-stale', 'no-reset', 'chat-page');
      return false;
    }
    var hasState = (baseSeen === true) || (baseComplete === true) || (baseCount > 0);
    if (!hasState) {
      aiCmGsaDiagState('reset-stale', 'no-reset', 'no-stale-state');
      return false;
    }
    resetConversationState();
    aiCmGsaDiagState('reset-stale', 'reset', 'chatless-doc (captcha/search)');
    debugLog('log', '[AI CM][auto-export] site=google_search O-27: документ без чата — ' +
      'база/pct прошлого документа сброшены');
    return true;
  } catch (e) { return false; }
}

window.addEventListener('ai-cm-full-history', function (ev) {
  // O-22 (ИЗМЕРЕНИЕ-2): маркер ПЕРВОЙ строки колбэка слушателя — ДО блока v81 Step1
  // и ДО вставок O-22 (блоки A–G2). Только диагностика под гейтом aiCmDebug.
  try {
    if (typeof aiCmDiagLine === 'function') {
      aiCmDiagLine('o22-listener-entry', { ts: Date.now() });
    }
  } catch (eO22L1) { }
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
  // O-22 (диагностика, только измерение): строка НА КАЖДЫЙ диспатч ai-cm-full-history
  // (в т.ч. до гарда на пустой detail): виден тройной эмит за 4–7 мс и histKey НА МОМЕНТ
  // приёма снимка — ключ ПРЕДЫДУЩЕЙ записи, с которым сравнится дедуп в processAndSend.
  try {
    if (typeof aiCmDiagLine === 'function') {
      aiCmDiagLine('o22-svc-emit', {
        ts: Date.now(),
        convId: (ev && ev.detail && ev.detail.convId) || (typeof getCurrentConvId === 'function' ? (getCurrentConvId() || '') : '') || '(none)',
        histKey: (typeof baseCount === 'number' ? baseCount : 0) + '|' + ((typeof baseText === 'string' && baseText) ? baseText.length : 0),
        msgs: (ev && ev.detail && ev.detail.count) || 0,
        textLen: (ev && ev.detail && typeof ev.detail.text === 'string') ? ev.detail.text.length : 0,
        lastHistKey: (typeof lastHistoryWroteKey !== 'undefined') ? lastHistoryWroteKey : undefined,
        src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : ''
      });
    }
  } catch (eO22b) { }
  const detail = ev && ev.detail;
  if (!detail || !detail.text) return;
  // O-31: база/pct/экспорт — ТОЛЬКО по ходам текущего разговора (threadId).
  // Снимок чужого треда отбрасывается ЦЕЛИКОМ: он не сбрасывает и не подменяет базу
  // текущего разговора. typeof-гард — слушатель исполняется и в source-песочницах
  // тестов (частичный скоуп без этих хелперов).
  if (typeof aiCmSnapshotIsCurrentThread === 'function') {
    var domTid31 = (typeof aiCmDomThreadId === 'function') ? aiCmDomThreadId() : '';
    if (!aiCmSnapshotIsCurrentThread(detail.threadId, domTid31)) {
      debugLog('log', '[content] O-31: снимок чужого разговора не применён (emit=' + detail.threadId +
        ', dom=' + domTid31 + ', msgs=' + (detail.count || 0) + ')');
      return;
    }
  }
  // v38: trace приёма снимка — видно, что сообщение дошло до content.js
  debugLog('log', '[AI CM][trace] badge-recv convId=' + (detail.convId || '-') +
    ' msgs=' + (detail.count || 0) +
    ' tokens~' + (Math.round((detail.text || '').length / 4) + (detail.attachTokens || 0)));
  // O-22 (диагностика, только измерение): ts+convId на КАЖДОЕ обновление бейджа —
  // та же точка, что и строка badge-recv выше (поведение, байты и гейт не меняются).
  try {
    if (typeof aiCmDiagLine === 'function') {
      aiCmDiagLine('o22-badge-recv', {
        ts: Date.now(),
        convId: detail.convId || '(none)',
        msgs: detail.count || 0,
        lastHistKey: (typeof lastHistoryWroteKey !== 'undefined') ? lastHistoryWroteKey : undefined
      });
    }
  } catch (eO22c) { }
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
      // O-27/O-32 (диагностика): причина сброса — смена threadId в самом снимке.
      aiCmGsaDiagState('emit-thread-switch', 'reset', 'thread-id-change', { from: String(lastThreadId), to: String(detail.threadId) });
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
  // O-35 (B1, фикс): серверный usage Qwen (output/reasoning/total) едет отдельным полем
  // (core/qwen-intercept.js:482-488) — тултип показывает reasoning и output РАЗДЕЛЬНО
  // (output ВКЛЮЧАЕТ reasoning). Прочие платформы поля не шлют → null → строк нет.
  netQwenUsage = (detail.qwenUsage && typeof detail.qwenUsage === 'object') ? detail.qwenUsage : null;
  netEffectiveLen = (typeof detail.effectiveLen === 'number' && detail.effectiveLen > 0) ? detail.effectiveLen : 0;
  baseSeen = true;
  stale = false; // сетевой снимок пришёл — интеграция актуальна
  var texts = Array.isArray(detail.messageTexts) ? detail.messageTexts : [];
  var ids = Array.isArray(detail.messageIds) ? detail.messageIds : [];
  lastBaseIds = ids;
  lastBaseTexts = texts;
  // O-27/O-32 (диагностика, только измерение): точка ПРИЁМА базы GSA в content.js —
  // форма (число текстов, длины) и вердикт полноты снимка. Только под гейтом aiCmDebug.
  try {
    if ((currentAdapter && currentAdapter.siteName) === 'google_search' && typeof aiCmDiagLine === 'function') {
      aiCmDiagLine('gsa-base-accept', {
        point: 'content-emit',
        verdict: (texts.length > 0) ? 'accept' : 'accept-empty',
        msgs: texts.length,
        textLen: (typeof detail.text === 'string') ? detail.text.length : 0,
        historyComplete: (detail.historyComplete === true) ? 1 : 0,
        threadId: detail.threadId || '',
        convId: emitConvId || '',
        head: (typeof aiCmDiagHead === 'function') ? aiCmDiagHead(detail.text, 100) : ''
      });
    }
  } catch (eDiagAccept) { }
  // v1.18 (E-2): Deep Research отдаёт один и тот же текст пользователя несколько раз
  // (пузырь реплики + карточка плана + узлы шагов). База схлопывается ДО потребителей:
  // badge/pct считаются по схлопнутой истории, экспорт .txt/.md/.json и print — тоже.
  // Карточка плана («Вот план исследования…» + цитата цели) — самостоятельный текст,
  // остаётся ОДНИМ assistant-сообщением и не режется.
  if (texts.length > 0) {
    var rawMsgs18 = (Array.isArray(detail.messages) && detail.messages.length === texts.length)
      ? detail.messages
      : null;
    var preDedupe18 = [];
    for (var d18 = 0; d18 < texts.length; d18++) {
      var r18 = rawMsgs18 ? ((rawMsgs18[d18] && rawMsgs18[d18].role) || '') : ((d18 % 2 === 0) ? 'user' : 'assistant');
      preDedupe18.push({
        // FIX (Claude md): ход пользователя парсера Claude приходит в снимок ролью 'human'
        // (core/claude-intercept.js:parseHistory) — нормализуем её в 'user' ЗДЕСЬ, на записи
        // сетевой базы: иначе 'human' умирал бы в 'assistant' ДО точек collect/dedupe
        // (core/base-handler.js:54, core/export-manager.js:178 — те уже знают 'human', но
        // получали готовый 'assistant') и все ходы Claude шли под '## Ассистент'.
        role: (r18 === 'user' || r18 === 'human') ? 'user' : 'assistant',
        text: sanitizeGeminiText(texts[d18]),
        id: (rawMsgs18 && rawMsgs18[d18] && rawMsgs18[d18].id != null) ? String(rawMsgs18[d18].id) : String(ids[d18])
      });
    }
    var ded18 = aiCmDedupeExportSource(preDedupe18);
    // v1.18 (E-2.3): ЕДИНЫЙ источник правды — РОВНО выход prepareExportMessages. Этот массив
    // питает и метрики (baseText/baseCount/getEffectiveText), и файл экспорта (lastBaseTexts →
    // aiCmCollectExportSource): отдельного второго массива-базы не заводим.
    var prepared18 = Array.isArray(ded18.messages) ? ded18.messages : [];
    aiCmBasePrepared = prepared18;
    var texts18 = [];
    var ids18 = [];
    var msgs18 = [];
    // id берём у ВЫЖИВШЕГО сообщения (prepareExportMessages переносит id): после схлопывания
    // индексы выхода и входа НЕ совпадают, поэтому фолбэк — id того же входа по индексу.
    for (var e18 = 0; e18 < prepared18.length; e18++) {
      var me18 = prepared18[e18] || {};
      var mid18 = (me18.id != null)
        ? String(me18.id)
        : ((preDedupe18[e18] && preDedupe18[e18].id != null) ? String(preDedupe18[e18].id) : '');
      texts18.push(String(me18.text == null ? '' : me18.text));
      ids18.push(mid18);
      msgs18.push({ role: me18.role, text: String(me18.text == null ? '' : me18.text), id: mid18 });
    }
    lastBaseTexts = texts18;
    lastBaseIds = ids18;
    lastDetailMessages = msgs18;
    baseCount = texts18.length;
    // baseText — производное ТОГО ЖЕ массива (texts18 собраны из prepared18), а не вторая база.
    baseText = texts18.join('\n');
    // v1.18 (E-2.3): сетевой effectiveLen (пол/длина) описывает ДО-схлопнутый текст. Когда
    // база схлопнута, масштаб оценки токенов берётся по САМОЙ базе — иначе бейдж/pct считались
    // бы по второй (несхлопнутой) копии, которую в файл уже не кладут (live: pct 10.7% при
    // файле ~32 тыс. символов вместо ~40 тыс.). Без схлопывания (removed=0) пол не трогаем.
    if (ded18.removed > 0 && netEffectiveLen > baseText.length) netEffectiveLen = baseText.length;
    aiCmLogDedupeRemoved(ded18.removed);
  } else {
    // нет сетевых текстов — схлопнутой базы у снимка нет: метрики идут прежним путём
    // (getEffectiveText → baseText), чужая/прошлая база не подставляется.
    aiCmBasePrepared = null;
    lastDetailMessages = Array.isArray(detail.messages) ? detail.messages : null;
  }
  baseIdSet = new Set();
  for (var i = 0; i < lastBaseIds.length; i++) { var s = String(lastBaseIds[i]).trim(); if (s) baseIdSet.add(s); }
  baseSkelSet = new Set();
  baseAnchors = [];
  for (var t = 0; t < lastBaseTexts.length; t++) {
    var sk = normalize(stripMd(lastBaseTexts[t]));
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
  // O-22 (ИЗМЕРЕНИЕ-2): маркер непосредственно ПЕРЕД финальным processAndSend() этого
  // слушателя — src=aiCmDiagStack(2) показывает, из какого пути пришёл вызов.
  try {
    if (typeof aiCmDiagLine === 'function') {
      aiCmDiagLine('o22-call725', {
        ts: Date.now(),
        src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(2) : ''
      });
    }
  } catch (eO22L2) { }
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

// ===== v2.0 (этап 1/3): widget.js ← THEME_CONFIGS, getServiceKey =====

function getCurrentConvId() {
  try {
    // v81: обобщено на 6 сервисов через utils/export-emit-pipeline.js:
    // Gemini /app/<id> и claude /chat/<uuid> сохранены 1:1; добавлены ветки
    // chatgpt.com /c/<id>, chat.deepseek.com /a/chat/s/<id>,
    // perplexity.ai /search/<id> (живой диалог, M-11 v1.19.1) или /thread/<id>;
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

// ===== v2.0 (этап 1/3): widget.js ← aiCmInAppTheme, isDarkMode, aiCmWidgetAppliedTheme, aiCmThemePollTimer, AI_CM_THEME_POLL_MS, applyNativeStyles, aiCmRefreshThemeIfNeeded, aiCmStartThemePoll, aiCmStopThemePoll =====

// ========== ИНИЦИАЛИЗАЦИЯ ==========
// O-35 (C, фикс): выбор адаптера по hostname — ОДНА точка для двух путей: штатной
// инициализации и реактивации ISOLATED-контура по сигналу смены разговора (SPA).
// Ветки шести прежних платформ и ветка qwen байтово прежние (R-пины и пины проводки
// Qwen читают эти строки как есть).
function aiCmAssignAdapterByHost() {
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
  } else if (hostname.includes('chat.qwen.ai')) {
    // O-35: Qwen — живой SSE-перехватчик (core/qwen-intercept.js, MAIN-мир) даёт точные
    // тексты/токены; адаптер — ФОЛБЭК на случай отсутствия сетевого снимка.
    currentAdapter = new QwenAdapter();
  }
  return currentAdapter;
}
// O-35 (ДИАГНОСТИКА, только измерение): текст исключения одной строкой (имя + сообщение) —
// для строк qwen-init «throw». Только читает поле уже пойманной ошибки.
function aiCmQwenInitErrText(e) {
  try { return String((e && e.name) ? (e.name + ': ' + (e.message || '')) : e); } catch (eQiErr) { return '(read-error)'; }
}
// O-35 (ДИАГНОСТИКА, только измерение): qwen-init — ЕДИНАЯ точка строк ИНИЦИАЛИЗАЦИИ контура.
// Закрывает ровно те дыры, из-за которых живой лог 17:49–17:50 не отвечал, жив ли контур:
//   1) вход/выход/throw реактивации aiCmQwenSpaReshoot (и КАЖДЫЙ её ретрай с его delay);
//   2) КАЖДЫЙ вызов tryInit с результатом (найдены узлы / не найдены / фолбэк адаптера) или
//      исключением — успешный tryInit логировал «Диалог найден» только через debugLog, а
//      НЕУДАЧНЫЙ не логировал НИЧЕГО: «ретраев не видно» не доказывало, что их не было;
//   3) вход/выход/throw initialize (в т.ч. пропуск лесенки 2000/4000/6000 при исключении);
//   4) вердикт DRAW-гарда processAndSend — единственное место, где видно, что проход вернулся
//      ДО записи базы адаптером и снимка aiCmState.
// Гейт — общий aiCmDebug (utils/debug.js: aiCmDiagLine → aiCmDiagOn): выключен → НИ ОДНОЙ
// строки и ни одного лишнего чтения. Ничего не пишет в состояние/storage/DOM и не меняет
// байты выхода; строки — только для qwen. Вызовы защищены try/catch, поэтому срез-песочницы
// тестов без этого хелпера видят прежнее поведение 1:1.
function aiCmQwenInitDiag(event, fields) {
  try {
    if (typeof aiCmDiagLine !== 'function') return false;
    if (typeof currentAdapter === 'undefined' || !currentAdapter) return false;
    if (currentAdapter.siteName !== 'qwen') return false;
    var f = {
      ts: Date.now(),
      event: event,
      initialized: (typeof isInitialized !== 'undefined' && isInitialized === true) ? 1 : 0
    };
    if (fields) {
      for (var k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) f[k] = fields[k];
      }
    }
    return aiCmDiagLine('qwen-init', f);
  } catch (eQid) { return false; }
}
// O-35 (C, фикс): адаптерный пересъём базы по НОВОМУ convId после сигнала смены разговора.
// Аналог bootstrapSnapshot у Claude (claude-intercept.js:553) / Perplexity (perplexity-
// intercept.js:270), но на ISOLATED-стороне: у qwen сетевого снимка после F5/SPA нет вовсе,
// живой источник — adapters/qwen-adapter.js: extractMessages() вызывается ЗАНОВО (кэша/латча
// в адаптере нет), а не ждёт перезагрузку страницы. Контур «спал» (isInitialized=false, потому
// что initialize/tryInit отработали на прежнем документе, а DOM нового чата отрисовался позже)
// → tryInit с ретраями: он находит узлы, ставит isInitialized=true, пишет базу адаптера
// (content.js:history-write source=adapter) и снимок aiCmState → попап и кнопки ручного
// экспорта оживают. Контур уже поднят → штатный processAndSend() с той же адаптерной ветвью.
// Ничего не делает для прочих платформ (их SPA-путь не меняется).
function aiCmQwenSpaReshoot() {
  try {
    if (!currentAdapter || currentAdapter.siteName !== 'qwen') {
      try { aiCmQwenInitDiag('reshoot-exit', { ret: 0, branch: 'not-qwen' }); } catch (eQi1) { }
      return false;
    }
    aiCmAssignAdapterByHost();                  // повторный детект сайта/адаптера
    if (!currentAdapter || currentAdapter.siteName !== 'qwen') {
      try { aiCmQwenInitDiag('reshoot-exit', { ret: 0, branch: 'not-qwen-after-detect' }); } catch (eQi2) { }
      return false;
    }
    try { aiCmQwenInitDiag('reshoot-enter', { branch: isInitialized ? 'awake' : 'asleep', convId: (typeof getCurrentConvId === 'function' ? (getCurrentConvId() || '(none)') : '(none)'), url: String((typeof location !== 'undefined' && location && location.href) || ''), src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : '' }); } catch (eQi3) { }
    if (!isInitialized) {
      tryInit();                                // синхронный путь: DOM нового чата уже отрисован
      try { aiCmQwenInitDiag('reshoot-after-sync', { branch: isInitialized ? 'awake' : 'asleep' }); } catch (eQi4) { }
      if (!isInitialized) {
        setTimeout(function () { if (!isInitialized) tryInit(); try { aiCmQwenInitDiag('reshoot-retry', { delay: 500 }); } catch (eQi5) { } }, 500);
        setTimeout(function () { if (!isInitialized) tryInit(); try { aiCmQwenInitDiag('reshoot-retry', { delay: 1500 }); } catch (eQi6) { } }, 1500);
        setTimeout(function () { if (!isInitialized) tryInit(); try { aiCmQwenInitDiag('reshoot-retry', { delay: 3000 }); } catch (eQi7) { } }, 3000);
        // O-35 (B2-терминал, ФИКС): ПОСЛЕДНИЙ мост реактивации — после исчерпания лесенки
        // 500/1500/3000, когда DOM нового чата отрисовался ПОЗЖЕ неё. Живой лог 17:50:32 + 3с
        // даёт ровно «тишину»: ноль строк qwen-adapter/svc-emit-trace/history-write, попап
        // «Откройте поддерживаемый сайт», кнопки экспорта неактивны, бейдж «—». Причина, по
        // которой дальше ждать нечего: своего периодического тика у контура нет, а наблюдателя
        // нет тем более — startObserving() зовёт только tryInit(), который ни разу не дошёл до
        // ветки «узлы найдены» (isInitialized так и остался false).
        // Горизонт 6000 мс равен горизонту штатной лесенки initialize (2000/4000/6000): SPA-путь
        // получает то же окно, что F5-путь. Ровно ОДИН дополнительный таймер на реактивацию и
        // ровно один проход (aiCmQwenTerminalReshoot); typeof-гард — как у прочих точек, чтобы
        // срез-песочницы тестов без этого хелпера видели прежнее поведение 1:1.
        setTimeout(function () {
          if (typeof aiCmQwenTerminalReshoot !== 'function') return;
          aiCmQwenTerminalReshoot();
        }, 6000);
      }
    } else {
      processAndSend();                         // контур поднят — пересъём базы тем же путём
      try { aiCmQwenInitDiag('reshoot-awake-send', {}); } catch (eQi8) { }
    }
    try { aiCmQwenInitDiag('reshoot-exit', { ret: 1, branch: isInitialized ? 'awake' : 'asleep' }); } catch (eQi9) { }
    return true;
  } catch (eQwenReshoot) {
    // Исключение по-прежнему НЕ выходит наружу (контракт реактивации прежний), но теперь
    // о нём есть строка: раньше throw до tryInit() молча отменял и вызов, и все ретраи.
    try { aiCmQwenInitDiag('reshoot-throw', { error: aiCmQwenInitErrText(eQwenReshoot) }); } catch (eQi10) { }
    return false;
  }
}
// O-35 (B2-терминал, ФИКС): терминальный шаг реактивации qwen — «DOM отрисовался позже
// лесенки». Вызывается РОВНО один раз, из последнего таймера aiCmQwenSpaReshoot (6000 мс).
// Что делает: снимает ТЕКУЩУЮ DOM-базу адаптера тем же вызовом, что и F5-путь
// (extractMessages(); кэша/латча в адаптере нет — см. adapters/qwen-adapter.js:155-185),
// фиксирует её размер в aiCmAdapterBaseCount (по нему aiCmAdapterBaseSeen() даёт вердикт
// «адаптерная база готова»; aiCmAdapterBaseCount заполняется в processAndSend ТОЛЬКО ниже
// гарда, поэтому без этой фиксации новый пропускной путь гарда был бы недостижим), и делает
// ОДИН проход processAndSend(): гард (content.js:1887) пропускает путь
// «адаптерная база готова, isInitialized ещё нет» → база уходит в aiCmHistory
// (history-write source=adapter, adapterBaseSeen=true отпускает SPA-супрессию бейджа), а
// снимок — в aiCmState: попап и кнопки ручного экспорта оживают без F5 (дефект «мёртвого
// попапа»). Мёртвого пути нет: у qwen после SPA сети нет вовсе, поэтому без прохода по
// адаптерной базе контур не оживает ничем, кроме F5.
// Чего НЕ делает (границы фикса, чтобы не плодить вторые контуры):
//   - НЕ трогает isInitialized: единственный писатель остаётся прежним (tryInit, content.js:1122);
//   - НЕ заводит наблюдателя/ретраев/периодики: ровно один таймер на одну реактивацию;
//   - НЕ меняет пустой путь: при termMsgs=0 размер базы остаётся 0 → гард возвращает проход
//     там же, где и раньше (поведение пустого чата прежнее, только строка диагностики).
// Свой таймер на каждую реактивацию; устаревший (брошенный переходом в другой чат) безвреден:
// он снимает DOM адаптера и convId ТЕКУЩЕГО документа, а повторная запись истории того же чата
// отсекается lastHistoryWroteKey (histKey = 'adapter|<msgs>').
// Диагностика — тот же канал/гейт (aiCmQwenInitDiag → qwen-init), каждый вызов под try/catch.
function aiCmQwenTerminalReshoot() {
  if (isInitialized) return false;                  // контур поднят — терминалу нечего делать
  var termMsgs = -1;                                // -1: фолбэк недоступен; -2: адаптер бросил
  try {
    if (currentAdapter && typeof currentAdapter.extractMessages === 'function') {
      termMsgs = currentAdapter.extractMessages().length;
    }
  } catch (eQiTm) {
    termMsgs = -2;
    try { aiCmQwenInitDiag('reshoot-terminal-throw', { error: aiCmQwenInitErrText(eQiTm) }); } catch (eQiT1) { }
  }
  // Размер адаптерной базы ТЕКУЩЕГО convId фиксируется ДО прохода: гард читает его через
  // aiCmAdapterBaseSeen(). Пустой DOM оставляет 0 — «адаптерной базы нет» (как и было).
  if (typeof aiCmAdapterBaseCount !== 'undefined') {
    aiCmAdapterBaseCount = (termMsgs > 0) ? termMsgs : 0;
  }
  try { aiCmQwenInitDiag('reshoot-terminal', { adapterMsgs: termMsgs, ready: (typeof aiCmAdapterBaseSeen === 'function' && aiCmAdapterBaseSeen()) ? 1 : 0 }); } catch (eQiT2) { }
  processAndSend();                                 // ровно один проход (гард решает, писать ли базу)
  return true;
}
async function initialize() {
  try {
    aiCmAssignAdapterByHost();
    if (!currentAdapter) {
      try { aiCmQwenInitDiag('initialize-exit', { ret: 0, reason: 'no-adapter' }); } catch (eQi18) { }
      return;
    }
    try { aiCmQwenInitDiag('initialize-enter', { adapter: currentAdapter.siteName, url: String((typeof location !== 'undefined' && location && location.href) || '') }); } catch (eQi19) { }
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
    // O-35 (ДИАГНОСТИКА): результат первого tryInit штатного запуска (и жив ли контур).
    try { aiCmQwenInitDiag('initialize-after-tryinit', {}); } catch (eQi20) { }
    if (!isInitialized) {
      [2000, 4000, 6000].forEach(delay => {
        setTimeout(async () => { if (!isInitialized) await tryInit(); }, delay);
      });
      // O-35 (ДИАГНОСТИКА): лесенка штатного запуска — её абсолютные задержки. Она истекает
      // за 7.5с от загрузки документа; SPA-вход позже (живой лог 17:50:32 — через 42с) её
      // уже не застаёт, и единственным мостом остаётся reshoot (500/1500/3000).
      try { aiCmQwenInitDiag('initialize-ladder', { delays: '2000,4000,6000', scheduled: 3 }); } catch (eQi21) { }
    }
    try { aiCmQwenInitDiag('initialize-exit', { ret: 1 }); } catch (eQi22) { }
  } catch (eInitialize) {
    // Диагностика исключение НЕ глотает: initialize() по-прежнему отклоняется (вызов из
    // setTimeout(() => initialize(), 1500) остаётся unhandled rejection) — но теперь видно,
    // что лесенка 2000/4000/6000 после await tryInit() не была поставлена.
    try { aiCmQwenInitDiag('initialize-throw', { error: aiCmQwenInitErrText(eInitialize), src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : '' }); } catch (eQi23) { }
    throw eInitialize;
  }
}
async function tryInit() {
  try {
    if (isInitialized) {
      try { aiCmQwenInitDiag('tryinit-skip', { reason: 'already-initialized' }); } catch (eQi11) { }
      return;
    }
    let found = findMessageNodes();
    // O-35 (ДИАГНОСТИКА, только измерение): вход КАЖДОГО вызова — сколько узлов дал общий
    // селектор ДО фолбэка и какой путь позвал (src: initialize / сетевой EMIT / reshoot / лесенка).
    try { aiCmQwenInitDiag('tryinit-enter', { nodes: found.nodes.length, sel: found.sel, src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : '' }); } catch (eQi12) { }
    var qiAdapterMsgs = -1; // -1: фолбэк не вызывался; -2: фолбэк бросил исключение
    // Фолбэк для адаптеров без общих [data-message-*] (Google Search AI использует
    // [data-scope-id="turn"], которого нет в MSG_SELECTORS). Без этого isInitialized
    // остаётся false, processAndSend не пишет aiCmState → попап «Откройте поддерживаемый сайт».
    if (found.nodes.length === 0 && currentAdapter && typeof currentAdapter.extractMessages === 'function') {
      try {
        const ams = currentAdapter.extractMessages();
        qiAdapterMsgs = (ams && typeof ams.length === 'number') ? ams.length : 0;
        if (ams && ams.length > 0) {
          found = { nodes: ams, sel: (currentAdapter.siteName || 'adapter') + '.extractMessages()' };
        }
      } catch (e) {
        // O-35 (ДИАГНОСТИКА): раньше исключение фолбэка глоталось молча (пустой catch) —
        // теперь о нём есть строка. Поведение прежнее: узел не найден.
        qiAdapterMsgs = -2;
        try { aiCmQwenInitDiag('tryinit-adapter-throw', { error: aiCmQwenInitErrText(e) }); } catch (eQi13) { }
      }
    }
    if (found.nodes.length > 0) {
      debugLog('log', 'Диалог найден:', found.nodes.length, 'узлов (' + found.sel + ')');
      try { aiCmQwenInitDiag('tryinit-nodes', { nodes: found.nodes.length, sel: found.sel, action: 'set-initialized' }); } catch (eQi14) { }
      isInitialized = true;
      processAndSend();
      startObserving();
      // Строка ПОСЛЕ processAndSend/startObserving: её отсутствие при наличии
      // tryinit-nodes доказывает, что проход упал именно внутри processAndSend().
      try { aiCmQwenInitDiag('tryinit-exit', { action: 'initialized', nodes: found.nodes.length, sel: found.sel, observer: (typeof observer !== 'undefined' && observer) ? 1 : 0 }); } catch (eQi15) { }
    } else {
      try { aiCmQwenInitDiag('tryinit-exit', { action: 'not-found', nodes: 0, adapterMsgs: qiAdapterMsgs }); } catch (eQi16) { }
    }
  } catch (eTryInit) {
    // Диагностика исключение НЕ глотает: контракт прежний — промис tryInit отклоняется,
    // а вызывающий (initialize/сетевой слушатель/reshoot) видит тот же отказ, что и раньше.
    try { aiCmQwenInitDiag('tryinit-throw', { error: aiCmQwenInitErrText(eTryInit), src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : '' }); } catch (eQi17) { }
    throw eTryInit;
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
  // M-7: флаг точного подсчёта остаётся в chrome.storage.local, ключ — в session.
  chrome.storage.local.get(['ai_cm_exact_token_count'], function (data) {
    exactCountEnabled = !!data.ai_cm_exact_token_count;
    aiCmReadByokKey(function (key) {
      geminiApiKey = key || '';
      console.log('[byok] настройки загружены: exactCount=' + exactCountEnabled + ', key=' + (geminiApiKey ? '***' : '(пусто)'));
    });
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

// ===== v2.0 (этап 1/3): state.js ← aiCmConvSourceByConv, aiCmArchiveLoadStarted, aiCmArchiveRestoredDispatched, aiCmArchiveCountByConv, aiCmSourceLabelNow =====

// T1-fix#2 (v1.16.2): count архива ЭТОГО чата (0 — архива нет/не прочитан). Нужен гейту
// автоэкспорта: архивные ходы лежат в той же базе, поэтому baseCount <= archiveMsgs
// означает «база состоит ТОЛЬКО из архива» — живая история ещё не влилась.
function aiCmArchiveCountFor(convId) {
  try { return (convId && aiCmArchiveCountByConv[convId]) || 0; } catch (eAcf) { return 0; }
}

// Источник для UI: архив (если импортирован для ЭТОГО convId) либо живой ярус.
// Ярлык архива берётся из aiCmConvSource:<convId> (посчитан при импорте) — логика
// ярлыка не дублируется в content-скрипте.
// O-35 (B2, фикс): размер последней DOM-адаптерной базы (пишется в processAndSend из уже
// посчитанного messageCount — без дополнительного прохода extractMessages()). Нужен, чтобы
// отличить «живой ярус из адаптера» (baseSeen=false: у qwen после F5/SPA сети нет вовсе)
// от «данных нет совсем». Сбрасывается сигналом смены разговора.
var aiCmAdapterBaseCount = 0;
function aiCmAdapterBaseSeen() {
  return (!baseSeen) && ((typeof aiCmAdapterBaseCount === 'number' && aiCmAdapterBaseCount > 0) ||
    (typeof baseCount === 'number' && baseCount > 0) ||
    (Array.isArray(lastBaseTexts) && lastBaseTexts.length > 0));
}
function aiCmSourceInfo() {
  var cid = getCurrentConvId() || '';
  var rec = cid ? aiCmConvSourceByConv[cid] : null;
  if (rec && rec.kind === 'archive') {
    // M-4.2: фолбэк-ярлык архива — ключ content_source_archive (rec.label с импорта не трогаем)
    var fmt = rec.format || '?';
    var cnt = String(rec.count || 0);
    return { kind: 'archive', label: rec.label || aiCmI18nMessage('content_source_archive', 'архив: ' + fmt + ' · ' + cnt + ' сообщ.', [fmt, cnt]) };
  }
  if (baseSeen) return { kind: 'live', label: aiCmI18nMessage('content_source_live', 'live (сеть/DOM)') };
  // O-35 (B2, фикс): живой ярус — НЕ только сетевой снимок. На SPA-открытом/F5-чате qwen
  // сети нет вовсе: базу снимает DOM-адаптер (history-write source=adapter), а числа могут
  // приходить из серверного usage стрима. Раньше здесь возвращался null → попап показывал
  // «Источник: —» при живых числах (скрин №3). Существующий ярлык content_source_live
  // («live (сеть/DOM)») честно покрывает оба пути; метки прочих платформ не меняются
  // (нет ни сети, ни адаптерной базы → прежний null).
  if (aiCmAdapterBaseSeen()) return { kind: 'live', label: aiCmI18nMessage('content_source_live', 'live (сеть/DOM)') };
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
    // M-4.2: строка источника — ключ content_source_label (фолбэк — прежний русский)
    var want = aiCmSourceLabelNow
      ? aiCmI18nMessage('content_source_label', 'Источник: ' + aiCmSourceLabelNow, [aiCmSourceLabelNow])
      : '';
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

// ===== O-1: бейдж ChatGPT без «моргания» после F5 =====
// После F5 у ChatGPT первым успевает отработать DOM-путь: в DOM только видимый
// (виртуализированный) кусок истории → бейдж рисует 0.0% из разметки/заниженный процент,
// и лишь через ~1 с приходит сетевой снимок (ai-cm-full-history) с верным числом.
// Щит: до первой ЗАПИСИ БАЗЫ на этом документе (baseSeen — сеть/архив/память) виджет
// ChatGPT не обновляется и скрыт (createWidget ставит display:none, O-1 в widget.js).
// Взвод — на СТАРТЕ ДОКУМЕНТА и НЕ зависит от convId: F5#1 (пустой convId в URL) даёт
// ровно ту же DOM-догадку (2–4 сообщения адаптера, сетевой базы нет), что и F5#2
// с convId (/c/<id>); причину взвода видно в диагностике (armed / armed-empty-convid).
// Отпускание — событийное: первая запись базы (released-baseSeen) ИЛИ жёсткий фолбэк
// AI_CM_BADGE_HOLD_FALLBACK_MS=10 c (released-fallback), если сеть/перехватчик молчат:
// дальше поведение прежнее (рисунок по DOM-базе), виджет гарантированно возвращается.
// Одноразовость на документ (aiCmBadgeHoldSpent) сохранена; SPA-держание — отдельный
// механизм (badgeSuppressed/resetConversationState) и этим щитом не перевзводится.
// Скоуп: только chatgpt; прочие сервисы — байтово прежние.
var AI_CM_BADGE_HOLD_FALLBACK_MS = 10000; // жёсткий фолбэк щита: сеть/перехватчик молчат
var aiCmBadgeHoldUntil = 0;
var aiCmBadgeHoldSpent = false; // щит уже отработал (запись базы или фолбэк) — второй раз не взводим
var aiCmBadgeHoldTimer = null;

// O-1 (диагностика, только измерение): взвод/отпускание щита каноническим хелпером
// utils/debug.js — под гейтом aiCmDebug. reason=armed|armed-empty-convid|released-baseSeen|
// released-fallback. Гейт выключен → ни одной новой строки (aiCmDiagLine возвращает false,
// console не трогается), поведение щита то же. typeof-гард — срез-песочницы тестов.
function aiCmBadgeHoldDiag(reason) {
  try {
    if (typeof aiCmDiagLine !== 'function') return;
    aiCmDiagLine('badge-hold', {
      point: 'badge-hold',
      reason: reason,
      site: (currentAdapter && currentAdapter.siteName) || '',
      convId: (typeof getCurrentConvId === 'function' ? getCurrentConvId() : '') || '',
      baseSeen: (typeof baseSeen !== 'undefined' && baseSeen === true) ? 1 : 0,
      fallbackMs: AI_CM_BADGE_HOLD_FALLBACK_MS
    });
  } catch (eHoldDiag) { }
}

// ЕДИНСТВЕННАЯ точка отпускания щита (одноразовость на документ): запись базы или фолбэк.
// reveal=true — снятие по таймеру: виджет надо вернуть и перерисовать (DRAW в этот момент
// мог не случиться вовсе). При отпускании по записи базы рисовать не нужно: DRAW, который
// и позвал гейт, сам пойдёт в updateWidget и покажет виджет.
function aiCmBadgeHoldRelease(reason, reveal) {
  try {
    if (aiCmBadgeHoldSpent) return false;
    aiCmBadgeHoldSpent = true;
    aiCmBadgeHoldUntil = 0;
    debugLog('log', '[content-trace] badge-hold (O-1): щит отпущен (' + reason + ') t=' + Date.now());
    aiCmBadgeHoldDiag(reason);
    if (reveal) {
      try { aiCmRevealWidget(); } catch (eRevO1) { }
      processAndSend();
    }
    return true;
  } catch (eRelO1) { return false; }
}

// Истинно, пока бейдж держится: первой записи базы на этом документе ещё нет.
function aiCmBadgeHoldActive() {
  try {
    if (aiCmBadgeHoldSpent) return false;
    if (!currentAdapter || currentAdapter.siteName !== 'chatgpt') return false;
    if (baseSeen) { aiCmBadgeHoldRelease('released-baseSeen', false); return false; } // первая запись базы
    if (!aiCmBadgeHoldUntil) {
      // O-1: взвод на старте документа; пустой convId щит НЕ выключает
      var armReason = getCurrentConvId() ? 'armed' : 'armed-empty-convid';
      aiCmBadgeHoldUntil = Date.now() + AI_CM_BADGE_HOLD_FALLBACK_MS;
      debugLog('log', '[content-trace] badge-hold (O-1): ChatGPT — записи базы ещё нет, виджет скрыт (' + armReason + ') t=' + Date.now());
      aiCmBadgeHoldDiag(armReason);
      aiCmArmBadgeHoldFallback();
    }
    if (Date.now() >= aiCmBadgeHoldUntil) { aiCmBadgeHoldRelease('released-fallback', false); return false; }
    return true;
  } catch (eHoldO1) { return false; }
}

// Фолбэк щита: сеть/перехватчик молчат → снимаем щит, возвращаем виджет и перерисовываем
// по DOM-базе (прежнее поведение). Виджет не может остаться скрытым навсегда.
function aiCmArmBadgeHoldFallback() {
  try {
    if (aiCmBadgeHoldTimer) return;
    aiCmBadgeHoldTimer = setTimeout(function () {
      aiCmBadgeHoldTimer = null;
      if (aiCmBadgeHoldSpent || baseSeen) return; // запись базы уже пришла — щит отпущен ею
      aiCmBadgeHoldRelease('released-fallback', true);
    }, AI_CM_BADGE_HOLD_FALLBACK_MS);
  } catch (eArmO1) { }
}

function processAndSend() {
  if (!currentAdapter) return;

  // O-27 (c): на не-чат документе GSA (captcha/«подозрительный трафик») база/pct прошлого
  // документа гасятся ДО расчёта pct и вызова автоэкспорта — прошлое состояние вердикта
  // не даёт. На чат-странице вызов — no-op (threadId/контейнер в DOM есть).
  try { aiCmGsaResetStaleStateOnChatlessDoc(); } catch (eO27c) { }

  // v81 Step1: диагностический trace для не-Gemini адаптеров (поведение не меняется):
  // факты — у каких сервисов база заполняется через EMIT-канал, у каких история только из адаптера.
  try {
    var siteNameS1 = currentAdapter.siteName || '';
    if (siteNameS1 && siteNameS1 !== 'gemini') {
      // v82 (D2): baseSeen && тексты → network; !baseSeen → adapter; база есть, текстов нет → none
      var histWritePathS1 = (baseSeen && lastBaseTexts.length > 0) ? 'network'
        : (!baseSeen ? 'adapter' : 'none');
      // O-26 (только диагностика): два счётчика РЯДОМ с msgs — измерение расхождения
      // «msgs в svc-emit ≠ сетевая база». Поведение эмита не меняется: оба считаются из уже
      // существующих переменных, новых источников/кэшей/веток нет, печатаются в ту же
      // debugLog-строку (гейт подробных логов прежний).
      //   netMsgs — размер СЕТЕВОЙ базы: turnsMap перехватчика, доехавший EMIT-ом
      //             (lastBaseTexts = texts18 из detail.messageTexts, тот же массив, что у baseCount);
      //   domMsgs — размер извлечения DOM-адаптера (тот же единственный вызов, что и у msgs).
      var netMsgsS1 = lastBaseTexts.length;
      var domMsgsS1 = (typeof currentAdapter.extractMessages === 'function') ? currentAdapter.extractMessages().length : 0;
      debugLog('log', '[AI CM][svc-emit-trace] site=' + siteNameS1 +
        ' convId=' + (getCurrentConvId() || '') +
        ' msgs=' + domMsgsS1 +
        ' domMsgs=' + domMsgsS1 +
        ' netMsgs=' + netMsgsS1 +
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
  // O-35 (B2-терминал, ФИКС): третий ПРОПУСКНОЙ путь гарда — «адаптерная база текущего convId
  // уже снята, а isInitialized ещё нет». Это ровно путь SPA-реактивации qwen: терминальный шаг
  // (aiCmQwenTerminalReshoot, 6000 мс) снял DOM-базу нового чата, но tryInit ни разу не дошёл до
  // ветки «узлы найдены» — наблюдателя/инициализации нет. До фикса проход возвращался ЗДЕСЬ, ВЫШЕ
  // записи адаптерной базы и снимка aiCmState: попап «Откройте поддерживаемый сайт», кнопки
  // экспорта неактивны, бейдж «—» (живой лог 17:49-17:50) — до F5.
  // Для прочих путей условие — no-op: aiCmAdapterBaseCount заполняется ТОЛЬКО НИЖЕ этой строки
  // (ветка !baseSeen, content.js:1916), а baseCount/lastBaseTexts живут только вместе с
  // baseSeen=true и обнуляются resetConversationState() (вместе с aiCmAdapterBaseCount) на смене
  // разговора — утечки «базы прошлого чата» новый путь не даёт.
  if (!isInitialized && !(baseSeen && baseComplete) && !aiCmAdapterBaseSeen()) {
    if (drawSig !== lastDrawSig) {
      lastDrawSig = drawSig;
      debugLog('log', '[content-trace] DRAW-ПРОПУСК (guard) seq=' + (window.__aiCmTraceSeq || 0) + ' baseComplete=' + baseComplete + ' baseSeen=' + baseSeen + ' isInitialized=' + isInitialized + ' t=' + Date.now());
    }
    // O-35 (ДИАГНОСТИКА, только измерение): явный вердикт DRAW-гарда — единственная точка,
    // где видно ФАКТ возврата прохода ДО записи адаптерной базы и снимка aiCmState (попап
    // «Откройте поддерживаемый сайт», неактивные кнопки экспорта). adapterMsgs — счётчик
    // ПРЕДЫДУЩЕГО прохода: этот выходит раньше extractMessages(). Строка печатается на
    // каждый проход (в т.ч. с пустого чата, где проход зовёт createWidget → widget.js:482).
    try { aiCmQwenInitDiag('draw-guard', { verdict: 'skip', reason: 'not-initialized', baseSeen: (baseSeen === true) ? 1 : 0, baseComplete: (baseComplete === true) ? 1 : 0, baseCount: (typeof baseCount === 'number') ? baseCount : 0, adapterMsgs: (typeof aiCmAdapterBaseCount === 'number') ? aiCmAdapterBaseCount : -1, src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : '' }); } catch (eQg1) { }
    return;
  }
  if (drawSig !== lastDrawSig) {
    lastDrawSig = drawSig;
    debugLog('log', '[content-trace] DRAW seq=' + (window.__aiCmTraceSeq || 0) + ' baseComplete=' + baseComplete + ' baseSeen=' + baseSeen + ' isInitialized=' + isInitialized + ' effectiveLen=' + ((function () { var e = getEffectiveText(); return e ? e.length : 0; })()) + ' t=' + Date.now());
  }
  // O-35 (ДИАГНОСТИКА, только измерение): гард пропустил проход — контур жив (isInitialized)
  // либо есть полная сетевая база; ниже работают запись базы адаптером и снимок aiCmState.
  try { aiCmQwenInitDiag('draw-guard', { verdict: 'pass', baseSeen: (baseSeen === true) ? 1 : 0, baseComplete: (baseComplete === true) ? 1 : 0, baseCount: (typeof baseCount === 'number') ? baseCount : 0, src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : '' }); } catch (eQg2) { }
  try {
    const svc = getServiceKey();
    const isGeminiLike = (svc === 'gemini' || svc === 'aistudio');
    let messageCount;
    if (!baseSeen) {
      messageCount = isGeminiLike ? 0 : currentAdapter.extractMessages().length;
      // O-35 (B2, фикс): запоминаем размер DOM-адаптерной базы текущего чата — из него
      // aiCmSourceInfo() отличает живой ярус адаптера от «данных нет совсем». Число уже
      // посчитано строкой выше: лишнего прохода extractMessages() не появляется.
      aiCmAdapterBaseCount = messageCount;
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
    // O-35: Qwen в этот список НЕ входит — осознанно. У Qwen есть собственный серверный
    // usage в SSE (input/output/reasoning), и перезапись через countTokens BYOK затрёт
    // авторитетные числа стрима. Добавление 'qwen' сюда — регресс (пин-тест запрещает).
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
    // O-35 (v54, фикс badge-suppress): супрессия держится ТОЛЬКО пока база нового convId не
    // принята — сетью (baseSeen) ИЛИ DOM-адаптером (adapterBaseSeen; у qwen после F5/SPA сети
    // нет вовсе, базу пишет history-write source=adapter). Вердикт считается один раз и уходит
    // в ту же диагностику qwen-badge (reason=spa-suppress) — гейт и строка не расходятся.
    var badgeSuppressActive = (badgeSuppressed && !baseSeen && !adapterBaseSeen);
    if (badgeSuppressActive) {
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
    } else if (aiCmBadgeHoldActive()) {
      // O-1: первой записи базы ChatGPT на этом документе ещё нет — бейдж держим (виджет
      // скрыт с создания): не показываем ни placeholder «—», ни заниженную DOM-оценку после
      // F5 (в т.ч. при пустом convId). Отпускание — записью базы ИЛИ фолбэком
      // AI_CM_BADGE_HOLD_FALLBACK_MS (aiCmArmBadgeHoldFallback).
    } else {
      updateWidget(percentage, maxTokenCount, effectiveLimit, contextLimit, displayLimit, ModelConfig.getModel(modelId)?.name || modelId, netAttachBreak);
      lastWidgetData = {
        percentage, tokenEstimate: maxTokenCount, effectiveLimit, contextLimit, displayLimit,
        modelName: ModelConfig.getModel(modelId)?.name || modelId, attachBreak: netAttachBreak
      };
    }
    // O-35 (ДИАГНОСТИКА, только измерение): qwen-badge — вердикт ветви отрисовки бейджа.
    // reason=draw — updateWidget выполнился (процент ушёл в круг/подпись); reason=spa-suppress —
    // держит SPA-супрессия после сброса; reason=loader-freeze — скрытая загрузка лоадера.
    // Плейсхолдер «—» вместо числа (ветка stale) печатает core/widget.js своей строкой.
    try {
      if (typeof aiCmDiagLine === 'function' && currentAdapter && currentAdapter.siteName === 'qwen') {
        aiCmDiagLine('qwen-badge', {
          ts: Date.now(),
          event: 'badge-update',
          reason: badgeSuppressActive ? 'spa-suppress' : (aiCmLoaderFreeze ? 'loader-freeze' : 'draw'),
          pct: percentage, tokens: maxTokenCount, stale: (stale === true) ? 1 : 0,
          baseSeen: (baseSeen === true) ? 1 : 0, baseComplete: (baseComplete === true) ? 1 : 0,
          // O-35 (v54): признак «база принята адаптером» — объясняет baseCount=0 в живом
          // логе: baseCount/netBaseMsgs описывают СЕТЕВУЮ базу, адаптерная живёт здесь.
          adapterBaseSeen: (adapterBaseSeen === true) ? 1 : 0,
          netBaseMsgs: lastBaseTexts.length, baseCount: baseCount,
          netServerTokens: (typeof netServerTokens === 'number') ? netServerTokens : 0,
          convId: (typeof getCurrentConvId === 'function' ? (getCurrentConvId() || '') : '') || '(none)',
          url: String((typeof location !== 'undefined' && location && location.href) || ''),
          source: (typeof aiCmSourceLabelNow === 'string' && aiCmSourceLabelNow) ? aiCmSourceLabelNow : '-'
        });
      }
    } catch (eQbw) { }
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
      // O-22 (диагностика, только измерение): КАЖДАЯ проверка дедуп-ключа baseCount|textLen.
      // verdict=write — ключ новый, запись пойдёт; verdict=dedup-skip — запись пропущена.
      // Путь export-manager.js:395 эту проверку НЕ проходит — гипотеза F4-b.
      try {
        if (typeof aiCmDiagLine === 'function') {
          aiCmDiagLine('o22-histkey-dedup', {
            ts: Date.now(),
            convId: emitConvA || currentConvB || '(none)',
            histKey: histKey,
            lastKey: (typeof lastHistoryWroteKey !== 'undefined') ? lastHistoryWroteKey : undefined,
            verdict: (histKey !== lastHistoryWroteKey) ? 'write' : 'dedup-skip',
            baseCount: baseCount,
            textLen: baseText ? baseText.length : 0,
            src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : ''
          });
        }
      } catch (eO22d) { }
      if (histKey !== lastHistoryWroteKey) {
        lastHistoryWroteKey = histKey;
        // v54: trace записи экспорта — источник ВСЕГДА сеть текущего convId
        debugLog('log', '[AI CM][trace] history-write source=network convId=' + (emitConvA || '-') +
          ' msgs=' + baseCount);
        // O-35 (ДИАГНОСТИКА, только измерение): qwen-adapter — каждая запись истории
        // (msgs/convId/URL). sinceSpaResetMs — сколько прошло от сброса по смене разговора
        // до этого пересъёма (-1 — сброса в этой сессии документа не было).
        try {
          if (typeof aiCmDiagLine === 'function' && currentAdapter && currentAdapter.siteName === 'qwen') {
            aiCmDiagLine('qwen-adapter', {
              ts: Date.now(), source: 'network', msgs: baseCount, netBaseMsgs: lastBaseTexts.length,
              convId: (emitConvA || '(none)'), url: String((typeof location !== 'undefined' && location && location.href) || ''),
              histKey: histKey, sinceSpaResetMs: aiCmQwenSpaResetAt ? (Date.now() - aiCmQwenSpaResetAt) : -1
            });
          }
        } catch (eQadN) { }
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
          // O-35 (v54, фикс badge-suppress): ЕДИНСТВЕННАЯ точка взвода состояния «база принята
          // по convId для adapter-пути» — ровно там, где база фактически записана (источник
          // adapter, независимо от того, что сеть молчит). Синхронно, в ISOLATED-мире, без
          // таймеров/async и вторых писателей: отсюда SPA-супрессия бейджа (badgeSuppressed)
          // отпускается по baseSeen ИЛИ adapterBaseSeen, а D1 (widget.js) не подменяет
          // посчитанное число на «—». Сброс — только resetConversationState().
          adapterBaseSeen = true;
          debugLog('log', '[AI CM][trace] history-write source=adapter site=' + (currentAdapter.siteName || '') +
            ' convId=' + cidS24 + ' msgs=' + msgsS24.length);
          // O-35 (ДИАГНОСТИКА, только измерение): qwen-adapter — запись истории путём
          // DOM-адаптера (именно она дала msgs=156 в консоли 14:48:51.318). convId/url —
          // привязка числа к РАЗГОВОРУ (вердикт A), roles — разбивка по ролям (признак
          // овер-экстракции: 78u/78a — легитимный чат, перекос — лишние узлы в счётчике).
          try {
            if (typeof aiCmDiagLine === 'function' && currentAdapter && currentAdapter.siteName === 'qwen') {
              var qUsers = 0;
              var qAssist = 0;
              for (var qr = 0; qr < msgsS24.length; qr++) {
                if (msgsS24[qr] && msgsS24[qr].role === 'user') qUsers++; else qAssist++;
              }
              aiCmDiagLine('qwen-adapter', {
                ts: Date.now(), source: 'adapter', msgs: msgsS24.length, adapterMsgs: msgsS24.length,
                roles: qUsers + 'u/' + qAssist + 'a', convId: cidS24 || '(none)',
                url: String((typeof location !== 'undefined' && location && location.href) || ''),
                histKey: histKeyS24, sinceSpaResetMs: aiCmQwenSpaResetAt ? (Date.now() - aiCmQwenSpaResetAt) : -1
              });
            }
          } catch (eQadA) { }
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

// ===== v2.0 (этап 1/3): state.js, export-manager.js ← autoExportSettings, aiCmAutoExportFlagMissingLogged, autoExportFired, autoExportPctBySite, autoExportPerSiteKey, loadAutoExportPerSitePct, sessionFiredCache, initSessionFiredCache IIFE, autoExportLastConvId, aiCmLoaderRunningByConv, autoExportLastPct, aiCmPendingHistWrite, aiCmCursorLiveByConv, aiCmBaseConfirmedByConv, aiCmLowConfidenceByConv, aiCmLateCheckByConv, trimProbe, preTrimExportFired, trimRetryByConv, TRIM_HEAD_IDS_N =====

// ===== v2.0 (этап 1/3): export-manager.js ← aiCmTryLateAutoExport =====

// ===== v2.0 (этап 1/3): export-manager.js ← detectTrimStateFallback =====

// ===== v2.0 (этап 1/3): export-manager.js ← geminiDetectTrim =====

// ===== v2.0 (этап 1/3): export-manager.js ← maybeTrimExport =====

// ===== v2.0 (этап 1/3): export-manager.js ← aiCmCancelDeferredHistWrite =====

// ===== v2.0 (этап 1/3): export-manager.js ← aiCmWriteCurrentHistory =====

// ===== v2.0 (этап 1/3): export-manager.js ← aiCmFlushDeferredHistWrite =====

// ===== v2.0 (этап 1/3): export-manager.js ← aiCmScheduleDeferredHistWrite =====

// ===== v2.0 (этап 1/3): export-manager.js ← loadAutoExportSettings =====

// ===== v2.0 (этап 1/3): export-manager.js ← aiCmAutoExportConvId, aiCmGsaProbeByThread, aiCmGsaProbeRunning, listener ai-cm-gsa-probe-state, aiCmGsaProbeRunningFor, aiCmGsaAutoExportSkipLog =====

// ===== v2.0 (этап 1/3): export-manager.js ← maybeAutoExport =====

// ===== v2.0 (этап 1/3): export-manager.js ← doAutoExportDownload =====

loadAutoExportSettings();
// O-7: тумблер «Включать reasoning и инъекции DeepSeek++ в экспорт» (default ВЫКЛ) —
// отдельный ключ chrome.storage.local, читается единственной точкой выхода экспорта.
loadExportHiddenSetting();

// ===== v2.0 (этап 1/3): export-manager.js ← listener ai-cm-loader-state =====

// ===== v2.0 (этап 1/3): widget.js ← createWidget, updateWidget =====

// =============================================================================
// O-36 (D1): достоверность базы для маркировки [LOW CONFIDENCE]_ в РУЧНОМ экспорте.
//
// Симптом (живой прогон qwen, 2026-09-19 19:54): файл
// `[LOW CONFIDENCE]_ai-context-monitor-qwen-Qwen3.8-Max-….txt` при работающей базе
// (`history-write source=adapter msgs=75`, `adapterBaseSeen=1`).
// Корень: база qwen приходит НЕ из сети (O-35/D2: живой источник — DOM-адаптер), а
// `baseComplete` — признак СЕТЕВОЙ полноты (core/state.js:53): у qwen он не взведётся
// никогда, поэтому живой флаг v1.14.1 (`isLowConfidenceBase: baseComplete !== true`)
// давал префикс на КАЖДОМ ручном экспорте. Для сервиса без сети маркировка «база не
// подтверждена» ложна: база подтверждена ЕДИНСТВЕННЫМ доступным источником — записью
// DOM-адаптера (`history-write source=adapter` → adapterBaseSeen=true, O-35/v54).
//
// Правило (узкое, чтобы не тронуть прочие платформы — R1): qwen И база принята
// адаптером для ТЕКУЩЕГО convId (adapterBaseSeen сбрасывается на смене разговора) →
// низкая достоверность НЕ ставится. Прочие сервисы и прежняя семантика 1:1.
// `baseComplete` здесь НЕ подменяется: признак сетевой полноты остаётся своим
// (гейты лоадера/оракула/бейджа читают его по прежнему смыслу).
// =============================================================================
function aiCmQwenExportBaseTrusted() {
  try {
    return !!((currentAdapter && currentAdapter.siteName === 'qwen') && adapterBaseSeen === true);
  } catch (eQbt) { return false; }
}

// =============================================================================
// O-37 (A): ДОВЕРИЕ БАЗЕ АДАПТЕРА В ГЕЙТЕ АВТОЭКСПОРТА (сервис без сети — qwen).
//
// Симптом (живой лог 21:47:18 / 21:58:03 / 22:03:50 / 22:07:44):
//   [AI CM][diag] auto-export point=maybeAutoExport verdict=skip reason=base-pending
//   site=qwen pct=63.7 baseSeen=0 baseComplete=0 — при пороге 30 файла нет вовсе.
// Корень (ИЗМЕРЕН): гейт O-33 (utils/export-emit-pipeline.js:shouldSkipAutoExport) требовал
// СЕТЕВОЙ снимок (baseSeen=1), а adapterBaseSeen (единственная точка взвода — запись базы
// путём DOM-адаптера, v54) гейтом не читался: у qwen сети не будет никогда, поэтому
// base-pending возвращался на каждом DRAW и автоэкспорт не срабатывал ни разу. Доверие
// aiCmQwenExportBaseTrusted (O-36/D1) было простёрто только на РУЧНОЙ снимок экспорта.
//
// Правило (узкое, чтобы не тронуть шесть платформ — R1): qwen И база принята адаптером для
// ТЕКУЩЕГО convId (adapterBaseSeen сбрасывается на смене разговора) → база объявляется
// достоверной (O-35: DESIGN-источник qwen — DOM-адаптер), и гейт получает domBaseTrusted=true:
// причина base-pending не возвращается, дальше решают порог и латч fired (повторных файров
// нет). Порядок причин и вердикты прочих сайтов не меняются вовсе (поле в гейт не уходит).
// =============================================================================
function aiCmAutoExportTrustedBase() {
  try {
    return !!((currentAdapter && currentAdapter.siteName === 'qwen') && adapterBaseSeen === true);
  } catch (eAtb) { return false; }
}
// O-37 (A, ДИАГНОСТИКА, только измерение): строка порогового файра по доверенной базе
// адаптера. Печатается РОВНО под гейтом aiCmDebug (aiCmDiagLine) и только когда файр реально
// состоялся на доверенной базе qwen; значения читаются, байты файла не меняются. Гейт
// выключен → ни одной строки. Вызывается из единственной точки старта скачивания
// автоэкспорта (core/export-manager.js) через typeof-гард — в срез-песочницах тестов,
// где хелпера нет, вызова не происходит вовсе (поведение 1:1).
function aiCmAutoExportTrustedBaseDiag(trigger, cid, percentage) {
  try {
    if (typeof aiCmDiagLine !== 'function') return false;
    if (!aiCmAutoExportTrustedBase()) return false;
    aiCmDiagLine('auto-export', {
      point: 'maybeAutoExport',
      verdict: 'fire',
      trigger: trigger,
      site: 'qwen',
      convId: cid,
      pct: percentage,
      baseSeen: (typeof baseSeen !== 'undefined' && baseSeen === true) ? 1 : 0,
      baseComplete: (typeof baseComplete !== 'undefined' && baseComplete === true) ? 1 : 0,
      adapterBaseSeen: (typeof adapterBaseSeen !== 'undefined' && adapterBaseSeen === true) ? 1 : 0
    });
    return true;
  } catch (eAtbd) { return false; }
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
      // O-16: если у DeepSeek прямо сейчас читается тело ответа (SSE ещё не закрыт),
      // сначала СИНХРОННО сбрасываем незакрытый буфер потока в memory-базу — иначе в
      // файл уйдёт ход ассистента, обрезанный на текущем чанке. Мост синхронный:
      // flush → finalizeRealtimeTurn → EMIT ai-cm-full-history → lastBaseTexts обновлены
      // ДО buildHistoryMessages() ниже.
      try { aiCmFlushLiveStreamForExport(curCidExp); } catch (eFlushExp) { }
      var pctExp = (typeof lastPercentage === 'number' && lastPercentage >= 0) ? lastPercentage : 0;
      // v61diag: дамп turnsMap в момент ручного экспорта (md/txt из options).
      // O-9-подпись: источник подписи — КАНОНИЧЕСКАЯ база текущего снимка, ровно тот же
      // массив, что уходит в файл (buildHistoryMessages() → detail.messages/lastBaseTexts).
      // Раньше третьим аргументом шёл null, и у сервисов без MAIN-моста turns-snap
      // (Perplexity: перехватчик на ai-cm-turns-snap-request не отвечает) подпись печатала
      // msgs=0 firstText="" при живой истории. Приоритет моста не тронут: ответил MAIN
      // (Gemini/DeepSeek O-17) — печатаются ЕГО числа, фолбэк не подставляется.
      try { aiCmDumpTurnsSnapshot('snapshot-at-manual', curCidExp, buildHistoryMessages()); } catch (eDumpM) { }
      // O-18 (фаза 2): ПЕРЕД композицией файла — сетевой дозапрос истории текущего чата
      // (только DeepSeek; таймаут 3 с внутри aiCmExportNetSyncThen). Перехватчик сам решает,
      // нужен ли запрос, и сам выбирает текст по ходам (EQUAL → live, MIDDLE-HOLE/TAIL-CUT →
      // сеть, ONE-SIDE → live + маркер). Не дождались/сети нет → прежний live-путь БЕЗ
      // изменения байтов файла; isLowConfidenceBase и порядок [REASONING]/[ANSWER] не тронуты.
      var replyManualExport = function () {
        var manualSnapshot = {
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
        };
        // O-36 (D1): у сервиса без сети (qwen) база подтверждена записью DOM-адаптера —
        // префикс низкой достоверности ей не полагается (см. aiCmQwenExportBaseTrusted).
        // Прочие сайты: флаг остаётся живым значением baseComplete (байтово прежнее имя).
        // typeof-гард: срез-песочницы тестов ручного экспорта (MANUAL-регион без этого
        // хелпера) видят прежнее поведение 1:1 — как у прочих точек контура qwen.
        if (typeof aiCmQwenExportBaseTrusted === 'function' && aiCmQwenExportBaseTrusted()) {
          manualSnapshot.isLowConfidenceBase = false;
        }
        sendResponse({ data: manualSnapshot });
      };
      if (typeof aiCmExportNetSyncThen === 'function' && aiCmExportNetSyncSite()) {
        aiCmExportNetSyncThen(curCidExp, replyManualExport);
      } else {
        replyManualExport();
      }
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
    // O-27/O-32 (диагностика, только измерение): точка скачивания дампа по Ctrl+Shift+D —
    // триггер, имя файла, первые 100 символов базы, URL, threadId, источник вызова.
    // Только под гейтом aiCmDebug; содержимое дампа и имя файла не меняются.
    var dumpFile = 'ai-cm-history-' + Date.now() + '.json';
    try {
      var BdiagHot = (typeof window !== 'undefined' && window && window.AiCmExportBuilders) ? window.AiCmExportBuilders : null;
      if (BdiagHot && typeof BdiagHot.aiCmDiagDownload === 'function') {
        BdiagHot.aiCmDiagDownload('hotkey-json-dump', JSON.stringify(payload, null, 2), dumpFile, {
          site: (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName) || '',
          threadId: (typeof aiCmDomThreadId === 'function') ? aiCmDomThreadId() : ''
        });
      }
    } catch (eDiagHot) { }
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = dumpFile;
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
    // BYOK (M-7): ключ живёт в chrome.storage.session ('aiCmApiKeySession');
    // legacy-имя в local слушаем только на переходный период миграции,
    // флаг точного подсчёта — по-прежнему в local.
    if (changes.ai_cm_exact_token_count || changes[AI_CM_BYOK_SESSION_KEY] || changes.ai_cm_gemini_api_key) {
      loadByokSettings();
      // Сбрасываем кэш при смене настроек, чтобы новый ключ/флаг применился сразу
      lastCountTokensText = '';
      lastCountTokensCache = 0;
      netServerTokens = 0; // при отключении BYOK сразу эвристика
      if (isInitialized) processAndSend();
    }
  });
}

