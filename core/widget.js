// =============================================================================
// core/widget.js — v2.0 (этап 1/3): декомпозиция core/content.js.
// ВИДЖЕТ (бейдж, панель, тема сервиса, сброс чата).
//
// Кластер виджета: сборка и обновление бейджа/панели, per-service порог виджета
// (safePct) и оверрайды попапа, in-app тема сервиса и её живой перекрас, сброс
// состояния при смене чата. Тела функций перенесены байтово — сигнатуры, имена и
// порядок вызовов не менялись; общее состояние и хелперы видны по прежним именам.
//
// Порядок подключения (manifest.json, content_scripts[0].js):
//   utils/* → adapters/* → core/state.js → core/widget.js → core/base-handler.js
//   → core/hybrid-tail.js → core/export-manager.js → core/content.js
// Перенос БЕЗ изменения логики: тела функций, сигнатуры, имена и строковые
// литералы байтово прежние (декомпозиция, а не переписывание).
// =============================================================================

// ВНИМАНИЕ: функции updateWidget/createWidget/updatePanel/resetConversationState
// регрессия режет из исходника и исполняет в песочнице без этого хелпера — там каждая
// берёт локальный резолвер вида `(typeof aiCmI18nMessage === 'function') ? ... : фолбэк`
// (иначе ReferenceError в песочнице, а не прежняя русская строка).

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
  // M-4.2: строки панели — из _locales (content_*); в песочницах без хелпера — фолбэк.
  const i18n = (typeof aiCmI18nMessage === 'function') ? aiCmI18nMessage : function (key, fallback) { return fallback; };
  const status = widgetElement.querySelector('.ai-cm-limit-text');
  const input = widgetElement.querySelector('.ai-cm-input');
  if (!status) return;
  const effLim = lastWidgetData ? lastWidgetData.effectiveLimit : 0;
  const pct = aiCmActivePct();
  if (pct != null) {
    const eff = Math.max(1, Math.round(pct / 100 * effLim));
    status.textContent = i18n('content_panel_threshold', 'Порог ' + pct + '% = ' + eff.toLocaleString() + ' ток', [String(pct), eff.toLocaleString()]);
    if (input) input.value = pct;
  } else {
    status.textContent = i18n('content_panel_auto_status', 'Авто-порог: ' + effLim.toLocaleString() + ' ток (= 100% в поле)', [effLim.toLocaleString()]);
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

// ========== v1.18/v1.22: сброс состояния виджета при смене чата в SPA ==========
function resetConversationState() {
  // O-27/O-32 (диагностика, только измерение): тип документа (captcha/чат/поиск) и
  // источник вызова (кто именно сбросил состояние). Гейт — aiCmDebug (utils/debug.js);
  // поведение/сброс не меняются.
  if (typeof aiCmDiagLine === 'function') {
    aiCmDiagLine('gsa-state', {
      point: 'resetConversationState',
      verdict: 'reset',
      reason: 'caller-see-src',
      doc: (typeof aiCmDiagDocKind === 'function') ? aiCmDiagDocKind() : 'unknown',
      site: (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName) || '',
      threadId: (typeof aiCmDomThreadId === 'function') ? aiCmDomThreadId() : '',
      src: (typeof aiCmDiagStack === 'function') ? aiCmDiagStack(1) : ''
    });
  }
  debugLog('log', '[content-trace] RESET виджета seq=' + (++window.__aiCmTraceSeq || (window.__aiCmTraceSeq = 1)) + ' t=' + Date.now());
  baseText = '';
  baseCount = 0;
  baseSeen = false;
  baseComplete = false;
  // O-43: смена треда — ЕДИНСТВЕННЫЙ сброс монотонного латча сетевой полноты GSA
  // ('site|threadId' → 1, core/state.js). Внутри одного разговора латч не снимается ничем
  // (регрессия baseComplete от поздних эмитов с historyComplete=0 его не касается);
  // на новом треде прежняя полнота права на файл не даёт. Сброс — по ФАКТУ смены threadId
  // (DOM-атрибут data-session-thread-id), а не на каждый вызов этого сброса: сюда приходят
  // и «холостые» вызовы (conv-changed без смены id, не-чат документ) — на них латч жив, иначе
  // один поздний эмит с historyComplete=0 в уже полном разговоре запретил бы честный файл.
  // Хелпера нет (срез-песочницы тестов) → ничего не сбрасывается, поведение прежнее.
  if (typeof aiCmGsaNetworkCompleteReset === 'function') {
    aiCmGsaNetworkCompleteReset((typeof aiCmDomThreadId === 'function') ? (aiCmDomThreadId() || '') : '');
  }
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
  // v1.18 (E-2.3): схлопнутая база метрик не перетекает в другой чат
  aiCmBasePrepared = null;
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
      // O-29 (Low, лог-спам): строка печатается только на СМЕНУ состояния SPA-входа.
      // Сигнатура = разговор (URL-id, а у GSA — threadId из DOM) + бит латча O-38 (site|convId):
      // непрерывные сбросы одного и того же разговора при неизменном латче молчат, а ПЕРВЫЙ
      // вход после файра (латч взведён) снова виден. Печатаемый текст не изменён. Хелперы живут
      // в export-manager.js (парсится после widget.js, вызов — на смене чата, т.е. после
      // загрузки всех модулей) — typeof-гард, как у прочих межмодульных вызовов: срез-песочницы
      // тестов без них видят прежнее поведение.
      var logCidD14 = cidD14 ||
        ((typeof aiCmDomThreadId === 'function') ? (aiCmDomThreadId() || '') : '');
      var logFiredD14 = (typeof aiCmAutoExportLogFiredBit === 'function')
        ? aiCmAutoExportLogFiredBit(siteD14, logCidD14) : 0;
      var logChangedD14 = (typeof aiCmAutoExportLogOnChange !== 'function') ||
        aiCmAutoExportLogOnChange('spa-entry', siteD14 + '|' + logCidD14 + '|fired=' + logFiredD14);
      if (logChangedD14) {
        debugLog('log', '[AI CM][auto-export] site=google_search latch kept reason=spa-entry convId=' +
          (cidD14 || '(threadId)'));
      }
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
    // O-35 (ДИАГНОСТИКА, только измерение): qwen-badge — плейсхолдер «—» ветви RESET
    // (сброс состояния виджета сигналом смены разговора). На qwen до фикса дефекта C
    // эта строка не появляется НИКОГДА: событие 'ai-cm-conversation-changed' не приходит.
    try {
      if (typeof aiCmDiagLine === 'function' && typeof currentAdapter !== 'undefined' &&
          currentAdapter && currentAdapter.siteName === 'qwen') {
        aiCmDiagLine('qwen-badge', {
          ts: Date.now(), event: 'placeholder', reason: 'reset-conversation',
          convId: (typeof getCurrentConvId === 'function' ? (getCurrentConvId() || '') : '') || '(none)',
          url: String((typeof location !== 'undefined' && location && location.href) || '')
        });
      }
    } catch (eQbReset) { }
    if (tt) {
      // M-4.2: строка загрузки — ключ content_widget_loading (в песочнице без хелпера — фолбэк)
      const i18n = (typeof aiCmI18nMessage === 'function') ? aiCmI18nMessage : function (key, fallback) { return fallback; };
      tt.innerHTML = i18n('content_widget_loading', 'Загрузка контекста...');
    }
  }
  badgeSuppressed = true; // v1.8.1: до первого badge-recv нового convId бейдж не обновляем
  // O-35 (v54): супрессия взведена заново — база НОВОГО convId ещё не принята ни сетью, ни
  // адаптером. Здесь и только здесь «сброс» признака adapterBaseSeen (его ВЗВОД — ровно одна
  // точка: запись базы путём адаптера в core/content.js); без этого состояние прошлого
  // разговора отпускало бы супрессию нового.
  adapterBaseSeen = false;
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
  // O-14 (A): RESET не оставляет попапу старый снимок. Снимок живёт в
  // chrome.storage.local (глобальный aiCmState + per-host aiCmState:<host> — те же
  // ключи, что пишет content.js при badge-update). Удаляем ровно эти два ключа;
  // историю (aiCmHistory*), sync-ключи и selectedModel/customLimit НЕ трогаем.
  try {
    if (isExtensionValid() && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(['aiCmState', 'aiCmState:' + window.location.hostname]);
    }
  } catch (eResetState14) { }

  // Critical #1 (п.1.6): смена чата/SPA-страницы — сторож коллизий старой страницы гасим
  // и взводим заново на текущий виджет: в новой вёрстке хост-контролы другие, значение
  // --acm-safe-bottom пересчитывается сразу. Гард по typeof — resetConversationState
  // прогоняется и в песочницах тестов виджета (там хелпера нет, поведение прежнее).
  try {
    if (typeof aiCmRestartWidgetSafeBottomWatch === 'function') aiCmRestartWidgetSafeBottomWatch();
  } catch (eSafeBottomReset) { }
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

// ===== O-1: показ виджета только после первой записи базы =====
// Пока гейт aiCmBadgeHoldActive() (content.js) держит бейдж, контейнер снят с отрисовки:
// пользователь не видит ни начальный плейсхолдер из разметки, ни заниженную DOM-оценку.
// P2a: сам начальный плейсхолдер разметки — «—» (а не DOM-догадка «0.0%»): до первого
// updateWidget ни имя модели, ни tokens, ни pct не печатаются; новых состояний и
// индикатора «загрузка» не вводится (тултип — прежний content_widget_loading).
// Показ — ровно в updateWidget (первый расчёт уже разложен по circle/text/tooltip)
// либо по таймауту-фолбэку из content.js (сеть молчит → прежнее поведение).
function aiCmRevealWidget() {
  try {
    if (!widgetElement) return;
    if (widgetElement.style.display === 'none') widgetElement.style.display = '';
  } catch (eRev) { }
}

// ========== Critical #1 UI-аудита 2026-09-28 (находка #1): collision-safe позиция ==========
// Индикатор 64×64 в правом нижнем углу перекрывал поле ввода и кнопку отправки на узком
// окне (WCAG 2.2 AA 1.4.10 Reflow). Индикатор поднимается на высоту ближайшего нижнего
// хост-контрола через --acm-safe-bottom; форма индикатора не меняется: edge-режим 28×44
// отклонён (28px < 44px HIG, процент внутри кольца 24.6px нечитаем — это визуальный
// редизайн с отдельной приёмкой). Потолок min(40vh, 320px) — честная граница: контрол
// выше потолка остаётся частично перекрыт (known limit, не баг).
// ВАЖНО (п.1.7): значение пишет ТОЛЬКО эта функция. applyNativeStyles и гард H25
// («при неизменной теме — ни одной style-записи») не тронуты байтово.
const AI_CM_SAFE_BOTTOM_DEFAULT = 24;
const AI_CM_SAFE_BOTTOM_MIN = 12;
const AI_CM_SAFE_BOTTOM_GAP = 12;
const AI_CM_SAFE_BOTTOM_MAX_PX = 320;
const AI_CM_SAFE_BOTTOM_MAX_VH = 0.4;
const AI_CM_SAFE_BOTTOM_THROTTLE_MS = 150;
// Кандидаты — точки ввода (п.1.2). Всё внутри нашего виджета исключается отдельно.
const AI_CM_BOTTOM_CONTROL_SELECTOR = 'textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], button[type="submit"]';
const AI_CM_SAFE_BOTTOM_LISTEN_OPTS = { capture: true, passive: true };
let aiCmSafeBottomWatchContainer = null;
let aiCmSafeBottomObserver = null;
let aiCmSafeBottomTimer = null;
let aiCmSafeBottomRafPending = false;
let aiCmSafeBottomLastRunAt = 0;

function aiCmWidgetHostEl(container) {
  if (container) return container;
  return (typeof document !== 'undefined' && document && document.getElementById) ? document.getElementById('ai-context-widget') : null;
}

// Чистое вычисление (без записи в DOM) — его же прогоняют D-пины на подменённых rect.
function aiCmComputeWidgetSafeBottom(container) {
  const vh = (typeof window !== 'undefined' && typeof window.innerHeight === 'number') ? window.innerHeight : 0;
  if (!(vh > 0)) return AI_CM_SAFE_BOTTOM_DEFAULT;
  const host = aiCmWidgetHostEl(container);
  let minTop = null;
  if (typeof document !== 'undefined' && document && typeof document.querySelectorAll === 'function') {
    const controls = document.querySelectorAll(AI_CM_BOTTOM_CONTROL_SELECTOR);
    for (let i = 0; i < controls.length; i++) {
      const el = controls[i];
      if (host && el !== host && host.contains && host.contains(el)) continue; // внутри виджета — не хост-контрол
      if (!el.offsetParent) continue;                                          // скрыт/снят с отрисовки
      const rect = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
      if (!(rect.bottom > vh * 0.5)) continue; // контрол верхней половины экрана виджету не мешает
      if (!(rect.top < vh)) continue;          // ниже окна — не в счёте
      if (minTop === null || rect.top < minTop) minTop = rect.top; // несколько контролов → минимальный top
    }
  }
  const raw = (minTop === null) ? AI_CM_SAFE_BOTTOM_DEFAULT : (vh - minTop + AI_CM_SAFE_BOTTOM_GAP);
  const capped = Math.min(raw, vh * AI_CM_SAFE_BOTTOM_MAX_VH, AI_CM_SAFE_BOTTOM_MAX_PX);
  return Math.max(AI_CM_SAFE_BOTTOM_MIN, capped);
}

function aiCmUpdateWidgetSafeBottom(container) {
  const px = aiCmComputeWidgetSafeBottom(container);
  const host = aiCmWidgetHostEl(container);
  try {
    if (host && host.style && typeof host.style.setProperty === 'function') host.style.setProperty('--acm-safe-bottom', px + 'px');
  } catch (eSafeBottomWrite) { }
  return px;
}

function aiCmSafeBottomFlush() {
  aiCmSafeBottomTimer = null;
  aiCmSafeBottomRafPending = false;
  const el = aiCmSafeBottomWatchContainer;
  if (!el) return; // сторож снят (смена SPA-страницы / resetConversationState)
  // Виджет удалён из DOM (showWidget=false, content.js:2879) — сторож гаснет сам, как
  // theme-poll H25: иначе MutationObserver по document.body жил бы вечно.
  if (typeof el.isConnected === 'boolean' && !el.isConnected) { aiCmStopWidgetSafeBottomWatch(); return; }
  aiCmSafeBottomLastRunAt = Date.now();
  aiCmUpdateWidgetSafeBottom(el);
}

// Throttle 150 мс (п.1.6): первый пересчёт после простоя — в кадре отрисовки, частые
// подряд схлопываются в один отложенный. Отдельный таймер, а не debounce: позиция
// обновляется и во время непрерывного скролла/набора, а не только после паузы.
function aiCmSafeBottomSchedule() {
  if (!aiCmSafeBottomWatchContainer) return;
  if (aiCmSafeBottomTimer !== null || aiCmSafeBottomRafPending) return;
  const elapsed = Date.now() - aiCmSafeBottomLastRunAt;
  if (elapsed < AI_CM_SAFE_BOTTOM_THROTTLE_MS) {
    aiCmSafeBottomTimer = setTimeout(function () {
      aiCmSafeBottomTimer = null;
      aiCmSafeBottomSchedule();
    }, AI_CM_SAFE_BOTTOM_THROTTLE_MS - elapsed);
    return;
  }
  aiCmSafeBottomRafPending = true;
  const raf = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
    ? function (cb) { window.requestAnimationFrame(cb); }
    : function (cb) { setTimeout(cb, 16); };
  raf(function () { aiCmSafeBottomFlush(); });
}

// Идемпотентно (п.1.6): один сторож на документ — повторный createWidget не плодит ни
// наблюдателя, ни слушателей; контейнер сменился — прежний сторож гасится.
function aiCmStartWidgetSafeBottomWatch(container) {
  if (!container || typeof document === 'undefined' || !document.body) return;
  if (aiCmSafeBottomWatchContainer === container && aiCmSafeBottomObserver) return;
  aiCmStopWidgetSafeBottomWatch();
  aiCmSafeBottomWatchContainer = container;
  try {
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', aiCmSafeBottomSchedule, AI_CM_SAFE_BOTTOM_LISTEN_OPTS);
      window.addEventListener('scroll', aiCmSafeBottomSchedule, AI_CM_SAFE_BOTTOM_LISTEN_OPTS);
    }
    if (typeof MutationObserver === 'function') {
      aiCmSafeBottomObserver = new MutationObserver(aiCmSafeBottomSchedule);
      aiCmSafeBottomObserver.observe(document.body, { childList: true, subtree: true });
    }
  } catch (eSafeBottomWatch) { }
  // Стартовое значение: без коллизии это 24px — позиция байтово прежняя (R-пин).
  aiCmSafeBottomLastRunAt = Date.now();
  aiCmUpdateWidgetSafeBottom(container);
}

function aiCmStopWidgetSafeBottomWatch() {
  if (aiCmSafeBottomTimer !== null) { clearTimeout(aiCmSafeBottomTimer); aiCmSafeBottomTimer = null; }
  aiCmSafeBottomRafPending = false;
  if (aiCmSafeBottomObserver) {
    try { aiCmSafeBottomObserver.disconnect(); } catch (eSafeBottomUnobserve) { }
    aiCmSafeBottomObserver = null;
  }
  try {
    if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', aiCmSafeBottomSchedule, AI_CM_SAFE_BOTTOM_LISTEN_OPTS);
      window.removeEventListener('scroll', aiCmSafeBottomSchedule, AI_CM_SAFE_BOTTOM_LISTEN_OPTS);
    }
  } catch (eSafeBottomUnbind) { }
  aiCmSafeBottomWatchContainer = null;
}

// Смена SPA-страницы/чата (resetConversationState): сторож старой страницы гасим и
// взводим заново на текущий виджет — в новой вёрстке хост-контролы другие.
function aiCmRestartWidgetSafeBottomWatch() {
  aiCmStopWidgetSafeBottomWatch();
  if (widgetElement) aiCmStartWidgetSafeBottomWatch(widgetElement);
}

// ========== Critical #2 UI-аудита 2026-09-28 (находка #2): доступность индикатора ==========
// WCAG 2.2 AA: 2.1.1 (клавиатура), 2.4.7 (видимый фокус), 4.1.2 (имя/роль/состояние);
// панель связана с индикатором через aria-controls/aria-expanded (пп.2.1-2.7).
let aiCmWidgetA11yBound = false;

function aiCmWidgetCircleEl() {
  return (widgetElement && typeof widgetElement.querySelector === 'function') ? widgetElement.querySelector('.ai-widget-circle') : null;
}
function aiCmWidgetPanelEl() {
  return (widgetElement && typeof widgetElement.querySelector === 'function') ? widgetElement.querySelector('.ai-widget-panel') : null;
}

// Единственный путь открытия/закрытия панели: класс .open и aria-expanded меняются
// вместе (п.2.4), при открытии фокус уходит в поле панели (п.2.7).
function aiCmSetWidgetPanelOpen(open, restoreFocus) {
  const panel = aiCmWidgetPanelEl();
  const circle = aiCmWidgetCircleEl();
  if (!panel || !circle) return false;
  const isOpen = open === true;
  panel.classList.toggle('open', isOpen);
  if (widgetElement) widgetElement.classList.toggle('ai-panel-open', isOpen);
  circle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  if (isOpen) {
    updatePanel();
    const input = (typeof widgetElement.querySelector === 'function') ? widgetElement.querySelector('.ai-cm-input') : null;
    if (input && typeof input.focus === 'function') { try { input.focus(); } catch (eA11yFocusIn) { } }
  } else if (restoreFocus === true && typeof circle.focus === 'function') {
    try { circle.focus(); } catch (eA11yFocusOut) { }
  }
  return isOpen;
}

function aiCmToggleWidgetPanel(restoreFocus) {
  const panel = aiCmWidgetPanelEl();
  if (!panel) return;
  aiCmSetWidgetPanelOpen(!panel.classList.contains('open'), restoreFocus);
}

function aiCmWidgetA11yKeydown(e) {
  if (!e || !widgetElement) return;
  const panel = aiCmWidgetPanelEl();
  if (!panel || !panel.classList.contains('open')) return;
  if (e.key !== 'Escape' && e.key !== 'Esc') return;
  if (typeof e.preventDefault === 'function') e.preventDefault();
  aiCmSetWidgetPanelOpen(false, true); // п.2.5: закрыть и вернуть фокус на индикатор
}

function aiCmWidgetA11yDocClick(e) {
  if (!e || !widgetElement) return;
  const panel = aiCmWidgetPanelEl();
  if (!panel || !panel.classList.contains('open')) return;
  const target = e.target;
  // Клик внутри виджета (индикатор/панель) — не «вне панели»: переключение делает сам
  // индикатор, иначе один и тот же клик закрывал бы и тут же открывал панель.
  if (target && typeof target.closest === 'function' && target.closest('#ai-context-widget')) return;
  // restoreFocus=false: пользователь уже ушёл курсором в другое место страницы, возврат
  // фокуса на индикатор украл бы его у элемента под курсором. Клавиатурные закрытия
  // (Escape, Enter/Space, клик по индикатору) фокус на индикатор возвращают.
  aiCmSetWidgetPanelOpen(false, false);
}

function aiCmBindWidgetA11y() {
  if (aiCmWidgetA11yBound) return;
  if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') return;
  aiCmWidgetA11yBound = true;
  // capture: хост-страницы глушат всплытие (Escape у модалок чата), а панель обязана
  // закрываться — иначе пользователь с клавиатуры остаётся в «запертой» панели.
  document.addEventListener('keydown', aiCmWidgetA11yKeydown, true);
  document.addEventListener('click', aiCmWidgetA11yDocClick, true);
}

// П.2.3: доступное имя — «{app}: {pct}% контекста использовано, {status}»; статус по тем
// же границам зон, что у zoneColor (50/80). Строки — только _locales (content_a11y_*).
function aiCmSetWidgetA11yLabel(circleEl, percentage) {
  if (!circleEl || typeof circleEl.setAttribute !== 'function') return;
  const i18n = (typeof aiCmI18nMessage === 'function') ? aiCmI18nMessage : function (key, fallback) { return fallback; };
  const pct = (typeof percentage === 'number' && isFinite(percentage)) ? percentage : 0;
  const pctLabel = pct.toFixed(1);
  const status = (pct < 50) ? i18n('content_a11y_status_ok', 'норма')
    : ((pct < 80) ? i18n('content_a11y_status_warning', 'внимание')
      : i18n('content_a11y_status_critical', 'критично'));
  circleEl.setAttribute('aria-label', i18n('content_a11y_circle_label', 'AI Context Monitor: ' + pctLabel + '% контекста использовано, ' + status, [pctLabel, status]));
}

// ========== ВИДЖЕТ (со стрелками ▲▼) ==========
function createWidget() {
  if (document.getElementById('ai-context-widget')) return;
  // M-4.2: строки разметки виджета — из _locales (ключи content_*); в изолированной
  // песочнице регрессии хелпера локали нет — остаются прежние русские литералы.
  const t = (typeof aiCmI18nMessage === 'function') ? aiCmI18nMessage : function (key, fallback) { return fallback; };
  const container = document.createElement('div');
  container.id = 'ai-context-widget';
  container.innerHTML = `<style> #ai-context-widget { position: fixed; bottom: var(--acm-safe-bottom, 24px); right: 24px; z-index: 999999; font-family: var(--w-font); user-select: none; } .ai-widget-circle { width: 64px; height: 64px; position: relative; cursor: pointer; background: var(--w-tooltip-bg); border-radius: 50%; box-shadow: var(--w-shadow); border: var(--w-border); display: flex; align-items: center; justify-content: center; transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1); } .ai-widget-circle:hover { transform: scale(1.06); } .ai-widget-circle:focus-visible { outline: 2px solid var(--w-text); outline-offset: 2px; } .ai-widget-circle svg { width: 88%; height: 88%; transform: rotate(-90deg); } .ai-widget-bg { fill: none; stroke: var(--w-bg-track); stroke-width: 7; } .ai-widget-fill { fill: none; stroke: var(--w-bg-fill); stroke-width: 7; stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; } .ai-widget-text { position: absolute; font-size: 13px; font-weight: 600; color: var(--w-text); letter-spacing: -0.03em; } .ai-widget-tooltip { visibility: hidden; opacity: 0; position: absolute; bottom: 76px; right: 0; width: max-content; box-sizing: border-box; max-width: min(320px, calc(100vw - 48px)); max-height: 40vh; overflow-y: auto; overscroll-behavior: contain; background: var(--w-tooltip-bg); color: var(--w-tooltip-text); padding: 8px 12px; border-radius: 8px; font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: break-word; box-shadow: var(--w-shadow); border: var(--w-border); transition: opacity 0.15s ease, visibility 0s linear 0.3s; } .ai-widget-circle:hover .ai-widget-tooltip { visibility: visible; opacity: 1; transition: opacity 0.15s ease, visibility 0s linear 0s; } #ai-context-widget.ai-panel-open .ai-widget-tooltip { visibility: hidden !important; opacity: 0 !important; transition: none; } .ai-widget-panel { display: none; position: absolute; bottom: 76px; right: 0; background: var(--w-tooltip-bg); color: var(--w-tooltip-text); padding: 10px; border-radius: 10px; box-shadow: var(--w-shadow); border: var(--w-border); flex-direction: column; gap: 6px; width: min(260px, calc(100vw - 48px)); max-height: calc(100vh - 108px); /* fallback for engines without var()/clamp() support in max-height; declared FIRST on purpose - this literal is pinned by tests/panel-overflow-contrast.test.js (i18n pin M-4.2: no user-facing ru literals here) */ max-height: clamp(130px, calc(100vh - var(--acm-safe-bottom, 24px) - 84px), calc(100vh - 108px)); overflow-y: auto; overscroll-behavior: contain; box-sizing: border-box; font-size: 12px; line-height: 1.4; z-index: 1000000; white-space: normal; } .ai-widget-panel.open { display: flex; } .ai-cm-limit-text { font-weight: 600; margin-bottom: 2px; } .ai-cm-row { display: flex; align-items: center; gap: 6px; } .ai-cm-input { width: 56px; padding: 4px 6px; border-radius: 6px; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12); color: inherit; font-family: inherit; font-size: 12px; -webkit-appearance: textfield; -moz-appearance: textfield; appearance: textfield; } .ai-cm-input::-webkit-outer-spin-button, .ai-cm-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; } .ai-cm-spin { display: flex; flex-direction: column; margin-left: -2px; } .ai-cm-spin button { cursor: pointer; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12); color: inherit; font-size: 8px; line-height: 1; padding: 2px 5px; font-family: inherit; } .ai-cm-spin button:first-child { border-radius: 4px 4px 0 0; border-bottom: none; } .ai-cm-spin button:last-child { border-radius: 0 0 4px 4px; } .ai-cm-spin button:hover { background: rgba(127,127,127,0.32); } .ai-cm-btn { cursor: pointer; border: none; border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; background: rgba(127,127,127,0.18); color: inherit; text-align: left; } .ai-cm-btn:hover { background: rgba(127,127,127,0.32); } .ai-cm-hint { opacity: 1; color: var(--w-tooltip-text); font-size: 11px; } </style> <div class="ai-widget-circle" tabindex="0" role="button" aria-haspopup="dialog" aria-controls="ai-widget-panel" aria-expanded="false" aria-label="${t('content_a11y_circle_initial', 'Открыть панель порога контекста')}"> <svg viewBox="0 0 100 100"> <defs> <linearGradient id="gemini-gradient" x1="0%" y1="0%" x2="100%" y2="100%"> <stop offset="0%" stop-color="#4285F4" /> <stop offset="50%" stop-color="#9B51E0" /> <stop offset="100%" stop-color="#EA4335" /> </linearGradient> </defs> <circle class="ai-widget-bg" cx="50" cy="50" r="43"/> <circle class="ai-widget-fill" cx="50" cy="50" r="43"/> </svg> <div class="ai-widget-text">—</div> <div class="ai-widget-tooltip">${t('content_widget_loading', 'Загрузка контекста...')}</div> </div> <div class="ai-widget-panel" id="ai-widget-panel"> <div class="ai-cm-limit-text">${t('content_panel_auto_label', 'Авто-порог')}</div> <div class="ai-cm-row"><input type="number" min="1" max="100" step="1" class="ai-cm-input" placeholder="${t('content_panel_placeholder', 'Авто')}"><span class="ai-cm-spin"><button type="button" class="ai-cm-spin-up" tabindex="-1" aria-label="${t('content_panel_spin_up', 'увеличить порог')}">▲</button><button type="button" class="ai-cm-spin-down" tabindex="-1" aria-label="${t('content_panel_spin_down', 'уменьшить порог')}">▼</button></span><span>${t('content_panel_pct_auto', '% от Авто')}</span></div> <div class="ai-cm-row"><button class="ai-cm-btn ai-cm-snap">${t('content_panel_snap_btn', '📌 Текущее = 100%')}</button><button class="ai-cm-btn ai-cm-auto">${t('content_panel_auto_btn', '↺ Авто')}</button></div> <div class="ai-cm-hint">${t('content_panel_hint', 'Порог в % от Авто-порога (оценённой точки, где модель начинает забывать). 100% = как Авто. Меньше = строже: цвета и % считаются от этого порога. Пример: порог 10% → жёлтый, когда Авто≈5%, красный при Авто≈8%.')}</div> </div>`;
  document.body.appendChild(container);
  widgetElement = container;
  applyNativeStyles(container);
  // O-1: ChatGPT после F5 — виджет скрыт, пока не пришла первая запись базы
  // (гейт aiCmBadgeHoldActive из content.js). Показ делает updateWidget/фолбэк-таймаут.
  try {
    if (typeof aiCmBadgeHoldActive === 'function' && aiCmBadgeHoldActive()) container.style.display = 'none';
  } catch (eHold) { }
  const circleEl = container.querySelector('.ai-widget-circle');
  const panelEl = container.querySelector('.ai-widget-panel');
  const snapBtn = container.querySelector('.ai-cm-snap');
  const autoBtn = container.querySelector('.ai-cm-auto');
  const inputEl = container.querySelector('.ai-cm-input');
  const upBtn = container.querySelector('.ai-cm-spin-up');
  const dnBtn = container.querySelector('.ai-cm-spin-down');
  if (circleEl && panelEl) {
    // Critical #2 (п.2.4): индикатор — кнопка панели; клик, Enter и Space делают одно и
    // то же и идут одним путём: класс .open и aria-expanded меняются вместе, фокус при
    // открытии уезжает в .ai-cm-input, при закрытии — обратно на индикатор.
    circleEl.addEventListener('click', () => aiCmToggleWidgetPanel(true));
    circleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault(); // Space на кнопке не должен прокручивать страницу
        aiCmToggleWidgetPanel(true);
      }
    });
  }
  // Critical #1/#2 (пп.1.1-1.6, 2.5): стартовый расчёт --acm-safe-bottom, сторож коллизий
  // и документные a11y-слушатели. Гарды по typeof — как у aiCmBadgeHoldActive выше:
  // изолированные песочницы тестов виджета (chatgpt-o1-badge-hold и др.) этих хелперов
  // не знают (при отсутствии хелпера поведение прежнее).
  try {
    if (typeof aiCmUpdateWidgetSafeBottom === 'function') aiCmUpdateWidgetSafeBottom(container);
    if (typeof aiCmStartWidgetSafeBottomWatch === 'function') aiCmStartWidgetSafeBottomWatch(container);
    if (typeof aiCmBindWidgetA11y === 'function') aiCmBindWidgetA11y();
  } catch (eWidgetCritical) { }
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
  // O-35 (D1, фикс): stale («12с без сетевого снимка») — НЕ повод стирать посчитанное число,
  // если база адаптера ЕСТЬ: у qwen после F5/SPA сети нет вовсе, базу снимает DOM-адаптер,
  // и подмена числа на «—» давала картинку «бейдж —, попап 158.8%» (дефект D). Норма stale
  // зафиксирована комментарием в core/state.js:61 и core/base-handler.js:230: у qwen это
  // систематическое состояние, а не авария. «—» остаётся ровно там, где базы нет совсем
  // (ни сетевого снимка, ни DOM-адаптерной базы) — поведение прочих платформ прежнее.
  // O-35 (v54, фикс badge-suppress): третий вход — «база принята по convId» для adapter-пути
  // (state.js:adapterBaseSeen, взводится в единственной точке записи базы адаптером). Он
  // нужен там, где baseCount/lastBaseTexts пусты ПО УСТРОЙСТВУ: они описывают СЕТЕВУЮ базу, а
  // у qwen её нет вовсе (в живом логе baseCount=0 при записанной adapter-базе msgs=156).
  var aiCmAdapterBasePresent = ((typeof baseCount === 'number' && baseCount > 0) ||
    (typeof lastBaseTexts !== 'undefined' && lastBaseTexts && lastBaseTexts.length > 0) ||
    (typeof adapterBaseSeen !== 'undefined' && adapterBaseSeen === true));
  var aiCmStalePlaceholder = (stale === true) && !aiCmAdapterBasePresent;
  percentText.textContent = aiCmStalePlaceholder ? '—' : (percentage.toFixed(1) + '%');
  // Critical #2 (п.2.3): доступное имя индикатора — процент и статус зоны, рядом с
  // видимым числом. Вызов защищён try/catch по образцу aiCmUpdateSourceIndicator выше:
  // updateWidget исполняется и в песочницах темы, где a11y-хелпера нет.
  try { aiCmSetWidgetA11yLabel(widgetElement.querySelector('.ai-widget-circle'), percentage); } catch (eA11yW) { }
  // O-35 (ДИАГНОСТИКА, только измерение): qwen-badge — плейсхолдер «—» ВМЕСТО процента.
  // Единственный путь: stale=true при ОТСУТСТВИИ базы (12с без сетевого снимка при
  // сообщениях в DOM — core/base-handler.js:scheduleStaleCheck). Строка печатается в ТОЙ
  // ЖЕ отрисовке, где badge-update (widget.js:473) уже показал число, — это и есть «тире
  // ПОЗЛЕ badge-update» (дефект D). Числа попапа живут отдельно (снимок aiCmState пишет
  // content.js). Случай «stale + база адаптера» строку НЕ печатает: число сохранено,
  // неполнота источника помечена меткой в тултипе (D1).
  try {
    if (aiCmStalePlaceholder && typeof aiCmDiagLine === 'function' && typeof currentAdapter !== 'undefined' &&
        currentAdapter && currentAdapter.siteName === 'qwen') {
      aiCmDiagLine('qwen-badge', {
        ts: Date.now(), event: 'placeholder', reason: 'stale',
        pct: percentage, tokens: tokens,
        baseSeen: (typeof baseSeen !== 'undefined' && baseSeen === true) ? 1 : 0,
        adapterBase: aiCmAdapterBasePresent ? 1 : 0,
        url: String((typeof location !== 'undefined' && location && location.href) || '')
      });
    }
  } catch (eQbStale) { }
  if (tooltip) {
    // M-4.2: строки тултипа — из _locales (ключи content_tooltip_*/content_source_*);
    // в изолированной песочнице регрессии хелпера нет — прежние русские литералы.
    const i18n = (typeof aiCmI18nMessage === 'function') ? aiCmI18nMessage : function (key, fallback) { return fallback; };
    const limPct = aiCmActivePct();
    const limLine = (limPct != null)
      ? i18n('content_tooltip_limit_pct', `Предел: ${limPct}% от Авто = ${displayLimit.toLocaleString()} ток`, [String(limPct), displayLimit.toLocaleString()])
      : i18n('content_tooltip_limit_auto', `Предел: Авто = ${effectiveLimit.toLocaleString()} ток`, [effectiveLimit.toLocaleString()]);
    // v1.10.x: безопасный рендер тултипа (textContent вместо innerHTML)
    const esc = String;
    const lines = [
      i18n('content_tooltip_model', `Модель: ${esc(modelName)}`, [esc(modelName)]),
      i18n('content_tooltip_tokens', `Токены: ${tokens.toLocaleString()}`, [tokens.toLocaleString()]),
      limLine,
      i18n('content_tooltip_window', `Окно модели: ${contextLimit.toLocaleString()}`, [contextLimit.toLocaleString()])
    ];
    // O-35 (B1, фикс): серверный usage Qwen — ОТДЕЛЬНЫЕ строки reasoning и output.
    // Источник — netQwenUsage из общего лексического скоупа контент-скрипта (state.js):
    // тот же паттерн, что у stale/baseSeen/baseCount (widget.js:498 читает их напрямую),
    // поэтому подпись и вызовы updateWidget остаются байтово прежними. Диспатч поля —
    // core/qwen-intercept.js:482-488 → content.js:detail.qwenUsage. output ВКЛЮЧАЕТ
    // reasoning, поэтому цифры идут раздельно. Ключ/формат локали — существующие
    // (content_tooltip_tokens), новых ru-литералов нет (страж i18n-locales).
    // Нет usage (шесть прежних платформ / стрим без кадра usage) → строк нет вовсе.
    try {
      if (typeof netQwenUsage !== 'undefined' && netQwenUsage && typeof netQwenUsage === 'object') {
        const qOut = (typeof netQwenUsage.outputTokens === 'number') ? netQwenUsage.outputTokens : 0;
        const qRea = (typeof netQwenUsage.reasoningTokens === 'number') ? netQwenUsage.reasoningTokens : 0;
        if (qOut > 0) lines.push(i18n('content_tooltip_tokens', `Токены: ${qOut.toLocaleString()}`, ['output ' + qOut.toLocaleString()]));
        if (qRea > 0) lines.push(i18n('content_tooltip_tokens', `Токены: ${qRea.toLocaleString()}`, ['reasoning ' + qRea.toLocaleString()]));
      }
    } catch (eQwUsageTt) { }
    // T1 (v1.16): индикатор источника (первый ярус — архив / второй — live).
    // O-35 (D1, фикс): когда число СОХРАНЕНО при stale (база адаптера есть), неполнота
    // источника помечается меткой ' · stale' в ТОЙ ЖЕ строке — метка ASCII, новых
    // ru-литералов нет. Без stale строка байтово прежняя (подстановка = прежний ярлык).
    try {
      const staleMark = (stale === true && aiCmAdapterBasePresent) ? ' · stale' : '';
      const srcVal = aiCmSourceLabelNow ? (esc(aiCmSourceLabelNow) + staleMark) : (staleMark ? 'stale' : '');
      if (srcVal) lines.push(i18n('content_source_label', `Источник: ${srcVal}`, [srcVal]));
    } catch (eSrcL) { }
    if (attachBreak && (attachBreak.imgCount > 0 || attachBreak.docCount > 0)) {
      const attachTotal = (attachBreak.imgTokens + attachBreak.docTokens).toLocaleString();
      lines.push(i18n('content_tooltip_attachments', `Вложения ≈ ${attachTotal} токенов`, [attachTotal]));
      if (attachBreak.imgCount > 0) lines.push(i18n('content_tooltip_attach_images', `· картинки: ${attachBreak.imgCount} шт ≈ ${attachBreak.imgTokens.toLocaleString()} (по 2 тайла)`, [String(attachBreak.imgCount), attachBreak.imgTokens.toLocaleString()]));
      if (attachBreak.docCount > 0) lines.push(i18n('content_tooltip_attach_files', `· файлы: ${attachBreak.docCount} шт ≈ ${attachBreak.docTokens.toLocaleString()} (оценочно)`, [String(attachBreak.docCount), attachBreak.docTokens.toLocaleString()]));
    }
    while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
    lines.forEach((line, i) => {
      if (i > 0) tooltip.appendChild(document.createElement('br'));
      tooltip.appendChild(document.createTextNode(line));
    });
  }
  // O-1: первый валидный расчёт уже отрисован — показываем виджет. Хелпер живёт в
  // content.js (загружается ПОСЛЕ widget.js), поэтому гард по typeof — как у гейта
  // в createWidget: изолированные песочницы тестов виджета остаются рабочими.
  try { if (typeof aiCmRevealWidget === 'function') aiCmRevealWidget(); } catch (eRevW) { }
}

// ========== v2.0 (этап 1/3): UMD-экспорт модуля ==========
// Паттерн как у utils/export-emit-pipeline.js: window.<Api> + module.exports.
// Рабочий путь ничего не импортирует: content-скрипты манифеста делят один
// глобальный лексический скоуп, поэтому объявления выше видны всем модулям и
// content.js по прежним именам. Api — для инструментов, отладки и тестов.
(function () {
  var Api = {};
  Api.safePctKey = safePctKey;
  Api.zoneColor = zoneColor;
  Api.aiCmActivePct = aiCmActivePct;
  Api.computeEffectiveLimit = computeEffectiveLimit;
  Api.aiCmSetPopupOverrides = aiCmSetPopupOverrides;
  Api.aiCmRefreshPopupOverrides = aiCmRefreshPopupOverrides;
  Api.aiCmLoadPopupOverrides = aiCmLoadPopupOverrides;
  Api.updatePanel = updatePanel;
  Api.snapCurrentPct = snapCurrentPct;
  Api.setSafePctFromInput = setSafePctFromInput;
  Api.resetSafePct = resetSafePct;
  Api.stepSafePct = stepSafePct;
  Api.resetConversationState = resetConversationState;
  Api.THEME_CONFIGS = THEME_CONFIGS;
  Api.getServiceKey = getServiceKey;
  Api.aiCmInAppTheme = aiCmInAppTheme;
  Api.isDarkMode = isDarkMode;
  Api.aiCmWidgetAppliedTheme = aiCmWidgetAppliedTheme;
  Api.aiCmThemePollTimer = aiCmThemePollTimer;
  Api.AI_CM_THEME_POLL_MS = AI_CM_THEME_POLL_MS;
  Api.applyNativeStyles = applyNativeStyles;
  Api.aiCmRefreshThemeIfNeeded = aiCmRefreshThemeIfNeeded;
  Api.aiCmStartThemePoll = aiCmStartThemePoll;
  Api.aiCmStopThemePoll = aiCmStopThemePoll;
  Api.aiCmComputeWidgetSafeBottom = aiCmComputeWidgetSafeBottom;
  Api.aiCmUpdateWidgetSafeBottom = aiCmUpdateWidgetSafeBottom;
  Api.aiCmStartWidgetSafeBottomWatch = aiCmStartWidgetSafeBottomWatch;
  Api.aiCmStopWidgetSafeBottomWatch = aiCmStopWidgetSafeBottomWatch;
  Api.aiCmRestartWidgetSafeBottomWatch = aiCmRestartWidgetSafeBottomWatch;
  Api.aiCmSetWidgetA11yLabel = aiCmSetWidgetA11yLabel;
  Api.aiCmSetWidgetPanelOpen = aiCmSetWidgetPanelOpen;
  Api.aiCmToggleWidgetPanel = aiCmToggleWidgetPanel;
  Api.createWidget = createWidget;
  Api.aiCmRevealWidget = aiCmRevealWidget;
  Api.updateWidget = updateWidget;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmWidget = Api;
})();
