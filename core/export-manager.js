// =============================================================================
// core/export-manager.js — v2.0 (этап 1/3): декомпозиция core/content.js.
// ЭКСПОРТ (источники текста, порог и латчи автоэкспорта, ручная и авто-выгрузка).
//
// Кластер экспорта: единая точка источников сообщений и санация текста, база для
// экспорта (архив/лента/живые), per-site порог, кросс-табовый латч already-fired,
// отложенная запись aiCmHistory, trim-детект, пороговый и base-complete триггеры,
// само скачивание файла. Гейты и порядок триггеров перенесены байтово.
// Топ-левел слушатели ai-cm-gsa-probe-state и ai-cm-loader-state переехали вместе
// со своим кластером; регистрируются по-прежнему один раз на страницу (document_idle).
//
// Порядок подключения (manifest.json, content_scripts[0].js):
//   utils/* → adapters/* → core/state.js → core/widget.js → core/base-handler.js
//   → core/hybrid-tail.js → core/export-manager.js → core/content.js
// Перенос БЕЗ изменения логики: тела функций, сигнатуры, имена и строковые
// литералы байтово прежние (декомпозиция, а не переписывание).
// =============================================================================

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
// ===== O-20: санация инъекций сторонних расширений на выходе экспорта =====
// DeepSeek++ (соседнее расширение) дописывает в user-промпт memory-преамбулу и тул-схему,
// а видимый пользователю текст оборачивает парой маркеров видимого промпта
// (deepseek-pp-visible-user-prompt:start / :end — точные строки в utils/export-emit-pipeline.js).
// Серверная история отдаёт эти инъекции в локальный снимок, и они уезжали в файл экспорта.
// Санация ставится в ОДНОЙ точке — на выходе aiCmCollectExportSource(): отсюда сообщения
// берут ВСЕ четыре формата (md/json/txt из options/автоэкспорта + print-pdf) и запись
// aiCmHistory. Ветки базы (lastBaseTexts/baseText/aiCmBasePrepared), serverTokens, turnsMap,
// бейдж и поля tokens/percent/limit НЕ тронуты — серверная правда контекста не пересчитывается.
// Чистые функции санации — utils/export-emit-pipeline.js (sanitizeEmitMessages).
var aiCmSanitizeSkipLogged = {};
// ===== O-7: тумблер «Включать reasoning и инъекции DeepSeek++ в экспорт» =====
// aiCmIncludeHiddenInExport (chrome.storage.local, default ВЫКЛ). Решение владельца
// (P1=a, P2=OFF): OFF = в файл идут ТОЛЬКО вопросы и ответы — секции [REASONING]…[ANSWER]…
// сетевого пути DeepSeek урезаются до части [ANSWER] (чистая функция пайплайна
// stripReasoningSections), санация O-20 активна, hidden-поля захвата снимаются. ON = сырой
// режим: текст как есть (секции на месте), hidden-reasoning отдельным блоком с пометкой,
// инъекции DeepSeek++ как есть. БАЗА (lastBaseTexts/baseText/turnsMap) и метрики, пороги,
// бейдж и латчи от положения тумблера НЕ зависят: секции остаются в базе, hidden живёт
// отдельным полем захвата, урезание — только на выходе экспорта. Значение грузит
// loadExportHiddenSetting().
var aiCmIncludeHiddenInExport = false;
function aiCmSanitizeDebugOn() {
  // Тот же флаг, что у диагностики DeepSeek (core/deepseek-intercept.js, SECTION 13).
  try { return sessionStorage.getItem('aiCmDebug') === '1'; } catch (e) { return false; }
}
// Одна строка на ПРИЧИНУ пропуска за страницу: санация вызывается на каждый снимок/запись
// истории, без антиспама лог повторялся бы на каждом ходе.
function aiCmLogSanitizeSkip(reasons) {
  if (!reasons || !reasons.length) return;
  if (!aiCmSanitizeDebugOn()) return;
  for (var i = 0; i < reasons.length; i++) {
    var r = String(reasons[i] || '');
    if (!r || aiCmSanitizeSkipLogged[r] === 1) continue;
    aiCmSanitizeSkipLogged[r] = 1;
    try { console.log('[AI CM][sanitize] skip reason=' + r); } catch (eL) { }
  }
}
// O-40 (ДИАГНОСТИКА — только ИЗМЕРЕНИЕ, поведение и байты не меняются): точка входа
// санации экспорта печатает под гейтом aiCmDebug РОВНО то, что выбрано — прочитанное
// значение тумблера aiCmIncludeHiddenInExport, ветку (includeHiddenExportBlocks |
// sanitizeEmitMessages | no-pipeline) и число сообщений на входе/выходе. Строка уходит
// каноническим хелпером utils/debug.js:aiCmDiagLine (собственного вывода в консоль и
// собственного формата здесь нет); хелпера нет (Node/срез-песочницы тестов) или гейт
// выключен → ни одной строки. Читаются только уже посчитанные значения; сам вызов в точке
// входа защищён typeof-гардом, поэтому песочницы без этого хелпера видят прежнее поведение.
function aiCmEmitEntryDiag(branch, inMsgs, outMsgs) {
  try {
    if (typeof aiCmDiagLine !== 'function') return false;
    return aiCmDiagLine('o40-emit-entry', {
      hidden: (aiCmIncludeHiddenInExport === true) ? 'on' : 'off',
      branch: branch,
      msgsIn: Array.isArray(inMsgs) ? inMsgs.length : 0,
      msgsOut: Array.isArray(outMsgs) ? outMsgs.length : 0
    }) !== false;
  } catch (eDiagEntry) { return false; }
}
// Санация массива сообщений экспорта: role=user с ровно одной парой маркеров → видимый
// текст; role=assistant и тексты без ровно одной пары — байтово прежние. Пайплайн не
// загружен (отладочный контекст) → массив отдаётся как есть, поведение прежнее.
// O-7: это ЕДИНАЯ точка выбора OFF/ON для экспорта (как у O-20 — выход всех четырёх
// форматов md/json/txt + print-pdf и записи aiCmHistory):
//   тумблер OFF (default) → вопросы и ответы: секции [REASONING]…[ANSWER]… урезаются до
//                           части [ANSWER], санация O-20 активна, hidden снят (OFF-путь);
//   тумблер ON            → сырой режим: текст как есть, hidden-reasoning отдельным блоком,
//                           инъекции как есть (O-20 обойдена).
function aiCmSanitizeEmitUserTexts(messages) {
  try {
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    if (!P || typeof P.sanitizeEmitMessages !== 'function') {
      // O-40 (диагностика): пайплайна нет — ветка no-pipeline, массив не тронут.
      if (typeof aiCmEmitEntryDiag === 'function') aiCmEmitEntryDiag('no-pipeline', messages, messages);
      return messages;
    }
    if (aiCmIncludeHiddenInExport === true) {
      var onMsgs = (typeof P.includeHiddenExportBlocks === 'function')
        ? P.includeHiddenExportBlocks(messages)
        : messages;
      // O-40 (диагностика): ON-ветка (сырой режим — O-40 и O-20 обойдены).
      if (typeof aiCmEmitEntryDiag === 'function') aiCmEmitEntryDiag('includeHiddenExportBlocks', messages, onMsgs);
      return onMsgs;
    }
    var res = P.sanitizeEmitMessages(messages);
    aiCmLogSanitizeSkip(res && res.skipped);
    // O-40 (диагностика): OFF-ветка — санация O-40/O-20 в пайплайне; числа до/после.
    if (typeof aiCmEmitEntryDiag === 'function') aiCmEmitEntryDiag('sanitizeEmitMessages', messages, res && res.messages);
    return (res && Array.isArray(res.messages)) ? res.messages : messages;
  } catch (e) { return messages; }
}
// v81: единая точка источников сообщений для экспорта — приоритет:
// detail.messages (последний EMIT) → lastBaseTexts с ролями → currentAdapter.extractMessages()
// (нормализация к {role,text}) → фолбэк чередования ролей. Используется в
// buildHistoryMessages(), aiCmWriteCurrentHistory() и doAutoExportDownload().
// v12 (O-18, фаза 2): чаты, для которых сетевой дозапрос истории уже выполняется, —
// защита от параллельных триггеров автоэкспорта (повторный вход после дозапроса).
var aiCmNetSyncInFlight = {};
// ===== O-37 (C): REASONING СЕРВИСА БЕЗ СЕТИ — В РЕНДЕР ЭКСПОРТА =====
// Живой факт (21:59, chat=4cf29053): стрим дал размышление (qwen-stream-end reasoningFrames=2
// reasoningLen=214, usage reasoning=68, строка reasoning в попапе есть), а в txt/md секции
// [REASONING] нет (ASSISTANT-блок = bare-ответ 277 знаков). Корень (инспекция):
//   (1) сетевая ветка ниже собирает сообщения заново как {role,text} — поле reasoning сетевого
//       снимка (detail.messages[].reasoning) теряется, а размышление остаётся только СЕКЦИЯМИ
//       В ТЕКСТЕ хода ([REASONING]…[ANSWER]…, composeTurnText перехватчика);
//   (2) OFF-путь O-7 (sanitizeEmitMessages → stripReasoningSections) урезает секции до [ANSWER]
//       на выходе экспорта — то есть ДО рендера;
//   (3) рендер маркерного пути читает поле reasoning, а DOM-адаптер сервиса без сети кладёт
//       размышление в СЛУЖЕБНОЕ ПОЛЕ ЗАХВАТА (O-35) — «поле, которое сообщение не заполняет».
// Правило (узкое, ровно для сервиса, чей DESIGN-источник — DOM-адаптер: qwen): на выходе этой
// точки размышление нормализуется в ОТДЕЛЬНОЕ поле reasoning — из поля захвата (DOM-база) или
// разбором пары секций из текста хода (сетевая база). Нормализация — ЧИСТАЯ функция пайплайна
// (applyReasoningExportFields), идёт ПО МЕСТУ и ДО единственной точки санации; прочие платформы
// не задеты вовсе: предикат сайта false → массив не трогается (байты прежние 1:1).
function aiCmReasoningExportSite() {
  try { return !!(currentAdapter && currentAdapter.siteName === 'qwen'); } catch (eRes) { return false; }
}
// Тонкая обёртка точки сбора: флаг сайта + чистый хелпер пайплайна. Хелпера нет (срез-
// песочница) → массив не тронут; сайт не тот → хелпер возвращается сразу (0 изменений).
function aiCmPrepareReasoningForExport(messages) {
  try {
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    if (!P || typeof P.applyReasoningExportFields !== 'function') return messages;
    P.applyReasoningExportFields(messages, aiCmReasoningExportSite());
  } catch (ePrep) { }
  return messages;
}
function aiCmCollectExportSource() {
  var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
  var texts = lastBaseTexts || [];
  // O-37 (C): хелпер нормализации reasoning берём typeof-гардом ОДИН раз (он объявлен рядом,
  // в этом же модуле): в срез-песочницах тестов, где вырезана только эта функция, хелпера нет
  // → null → поведение прежнее 1:1 (ни одной новой ветки не исполняется).
  var prepareReasoning = (typeof aiCmPrepareReasoningForExport === 'function') ? aiCmPrepareReasoningForExport : null;
  // v82 (D2): выбор источника — чистая функция пайплайна: baseSeen=true → ТОЛЬКО сеть,
  // baseSeen=false → DOM-адаптер (сетевая ветка с пустыми texts даёт [] — потребители skip).
  var source = (P && typeof P.pickExportSource === 'function')
    ? P.pickExportSource(baseSeen === true, texts.length > 0)
    : ((baseSeen && texts.length > 0) ? 'network' : 'adapter');
  var out = [];
  if (source === 'network') {
    if (Array.isArray(lastDetailMessages) && lastDetailMessages.length === texts.length && texts.length > 0) {
      for (var i = 0; i < texts.length; i++) {
        var dm = lastDetailMessages[i] || {};
        var r = dm.role || '';
        // FIX (Claude md): 'human' (парсер Claude) нормализуется в 'user' ровно как 'user'.
        var msg = { role: (r === 'user' || r === 'human') ? 'user' : 'assistant', text: sanitizeGeminiText(texts[i]) };
        // Claude md (ДИАГНОСТИКА — только измерение под гейтом aiCmDebug): роль сетевого снимка
        // и роль после нормализации. Маркер claude-role-* SCOPED по сайту (currentAdapter):
        // живой замер идёт по Claude-цепочке, чужие сайты строку этого маркера не получают.
        // Канонический хелпер utils/debug.js:aiCmDiagLine; гейт выключен или хелпера нет →
        // ни одной строки, байты выхода не меняются.
        if (typeof aiCmDiagLine === 'function' && typeof currentAdapter !== 'undefined' &&
          currentAdapter && currentAdapter.siteName === 'claude') {
          aiCmDiagLine('claude-role-network', { r: r, normalizedRole: msg.role });
        }
        // O-39: копируем поле reasoning из сетевого снимка напрямую, чтобы рендер получил
        // его как ДАННЫЕ (контракт O-35) независимо от того, сохранились ли секции
        // [REASONING]/[ANSWER] в тексте после санации. Прочие платформы: поле отсутствует
        // в lastDetailMessages → msg.reasoning не ставится → байты прежние (R1).
        if (typeof dm.reasoning === 'string' && dm.reasoning) msg.reasoning = dm.reasoning;
        out.push(msg);
      }
    } else {
      for (var j = 0; j < texts.length; j++) {
        out.push({ role: (j % 2 === 0) ? 'user' : 'assistant', text: sanitizeGeminiText(texts[j]) });
      }
    }
    if (prepareReasoning) prepareReasoning(out);   // O-37 (C): размышление — отдельным полем ДО санации
    // O-7 (Qwen): OFF-путь очищает поле reasoning, чтобы сборщики txt/md не вставляли
    // секции [REASONING] безусловно: applyReasoningExportFields переводит размышление хода
    // в отдельное поле ДО stripReasoningSections, и рендер видит msg.reasoning независимо
    // от тумблера. Служебные hidden-поля захвата снимает сам OFF-путь санации ниже.
    // typeof-гарды — конвенция срез-песочниц (fnDecl): там ни переменной тумблера, ни
    // предиката сайта нет → массив не трогается вовсе, поведение прежнее 1:1.
    var hiddenExportOn = (typeof aiCmIncludeHiddenInExport !== 'undefined') && aiCmIncludeHiddenInExport === true;
    var reasoningExportSite = (typeof aiCmReasoningExportSite === 'function') ? aiCmReasoningExportSite : null;
    if (!hiddenExportOn && reasoningExportSite && reasoningExportSite()) {
      for (var ri = 0; ri < out.length; ri++) {
        if (out[ri] && typeof out[ri] === 'object') delete out[ri].reasoning;
      }
    }
    return aiCmSanitizeEmitUserTexts(out);
  }
  // v82 (D2): ветка DOM-адаптера — ТОЛЬКО при baseSeen=false
  try {
    if (currentAdapter && typeof currentAdapter.extractMessages === 'function') {
      var raw = currentAdapter.extractMessages() || [];
      var hasRoles = false;
      // FIX (Claude md): role='human' (парсер Claude) — тоже «роль есть»: иначе Claude-база
      // уходила бы фолбэком чередования и теряла настоящие роли ходов.
      for (var k = 0; k < raw.length; k++) {
        if (raw[k] && (raw[k].role === 'user' || raw[k].role === 'assistant' || raw[k].role === 'human')) { hasRoles = true; break; }
      }
      var norm = (P && typeof P.normalizeExportMessages === 'function') ? P.normalizeExportMessages(raw) : [];
      // Claude md (ДИАГНОСТИКА — только измерение под гейтом aiCmDebug): роль DOM-адаптера ДО
      // нормализации пайплайна и после неё. rawRole — роль ПЕРВОГО хода с ролью: предикат
      // hasRoles выше выходит по break, поэтому k указывает ровно на него; при hasRoles=false
      // индекс k на элемент не указывает и роль не читается (undefined → '(нет)'). Предикат
      // hasRoles выше байтово не тронут. Маркер SCOPED по сайту — как claude-role-network
      // выше; гейт выключен → ни одной строки, байты прежние.
      if (typeof aiCmDiagLine === 'function' && typeof currentAdapter !== 'undefined' &&
        currentAdapter && currentAdapter.siteName === 'claude') {
        aiCmDiagLine('claude-role-adapter', {
          rawRole: hasRoles ? raw[k].role : undefined,
          normalizedRole: (norm.length > 0) ? norm[0].role : undefined,
          hasRoles: hasRoles
        });
      }
      if (prepareReasoning) prepareReasoning(norm);   // O-37 (C): то же для DOM-базы (поле захвата)
      if (norm.length > 0 && hasRoles) return aiCmSanitizeEmitUserTexts(norm);
      // фолбэк чередования ролей (роль в адаптере отсутствует)
      // O-39: копируем ВСЕ дополнительные поля из norm[n2] кроме role и text (уже установлены),
      // чтобы служебные поля захвата (например, размышление DOM-адаптера O-35) доехали до файла.
      // Без строкового литерала: обход через for-in с фильтром ключей.
      for (var n2 = 0; n2 < norm.length; n2++) {
        var fbMsg = { role: (n2 % 2 === 0) ? 'user' : 'assistant', text: norm[n2].text };
        for (var key in norm[n2]) {
          if (Object.prototype.hasOwnProperty.call(norm[n2], key) && key !== 'role' && key !== 'text') {
            fbMsg[key] = norm[n2][key];
          }
        }
        out.push(fbMsg);
      }
    }
  } catch (eA) { }
  if (prepareReasoning) prepareReasoning(out);   // O-37 (C): фолбэк чередования ролей — то же правило
  return aiCmSanitizeEmitUserTexts(out);
}

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
    // O-22 (диагностика, только измерение): каждый флаш отложенной записи — с histKey и
    // ТЕКУЩИМ lastHistoryWroteKey. Гипотеза F4-b: aiCmWriteCurrentHistory НЕ читает
    // lastHistoryWroteKey, поэтому запись ниже дедуп-ключ content.js:1686-1688 не проверяет —
    // в логе это видно как повтор histKey при неизменившемся lastKey.
    try {
      if (typeof aiCmDiagLine === 'function') {
        aiCmDiagLine('o22-deferred-flush', {
          ts: Date.now(),
          convId: p.convId || '(none)',
          histKey: (typeof baseCount === 'number' ? baseCount : 0) + '|' + ((typeof baseText === 'string' && baseText) ? baseText.length : 0),
          lastKey: (typeof lastHistoryWroteKey !== 'undefined') ? lastHistoryWroteKey : undefined,
          reason: reason || '(none)',
          baseSeen: (typeof baseSeen !== 'undefined' && baseSeen === true) ? 1 : 0,
          'baseComplete': (typeof baseComplete !== 'undefined' && baseComplete === true) ? 1 : 0
        });
      }
    } catch (eO22e) { }
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
        data = data || {};
        // v1.19.2 (M-13c): НОРМАЛИЗАЦИЯ ФЛАГА — нет БУЛЕВА enabled в загруженном объекте →
        // enabled=false И обязательная строка в логе. Тихий выход запрещён: дефект 13.09 17:33
        // (тред /search/5fe65fcb, галка включена, порог 20, baseComplete=true, cid непустой)
        // выглядел именно так — модуль автоэкспорта не сказал ни слова, потому что флаг потерялся
        // в storage при сохранении порога из попапа (M-13a), а этот путь молчал.
        if (typeof data.aiCmAutoExport !== 'boolean') {
          autoExportSettings.enabled = false;
          if (!aiCmAutoExportFlagMissingLogged) {
            aiCmAutoExportFlagMissingLogged = true;
            // console.log (а не debugLog): строка видна всегда, как «[byok] настройки загружены» —
            // «Подробные логи» для диагностики потери флага не требуются. Антиспам — одна строка
            // на эпизод «флага нет» (повторные onChanged-перезагрузки не дублируют её).
            console.log('[AI CM][auto-export] настройки: флаг enabled отсутствует — автоэкспорт выключен');
          }
        } else {
          aiCmAutoExportFlagMissingLogged = false; // флаг вернулся — следующий эпизод снова виден
          autoExportSettings.enabled = data.aiCmAutoExport === true;
        }
        var p = parseInt(data.aiCmAutoExportPct, 10);
        autoExportSettings.pct = (!isNaN(p) && p >= 1 && p <= 100) ? p : 90; // v65: 1–100
        // v1.18 (F4): селектор формата общий для всех сайтов — txt | md | json.
        var fmtRaw = data.aiCmAutoExportFmt;
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
// ===== O-7: загрузка тумблера «Включать reasoning и инъекции DeepSeek++ в экспорт» =====
// Отдельный ключ chrome.storage.local (aiCmIncludeHiddenInExport) и ОТДЕЛЬНЫЙ загрузчик:
// чтение настроек автоэкспорта (loadAutoExportSettings) не тронуто ни строкой — его
// сигнатура, набор ключей и строка нормализации флага запинены (M-13). Default ВЫКЛ:
// отсутствие ключа/не-булево значение — тот же текущий экспорт, что и раньше.
function loadExportHiddenSetting() {
  try {
    if (!isExtensionValid() || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['aiCmIncludeHiddenInExport'], function (data) {
      try {
        aiCmIncludeHiddenInExport = !!(data && data.aiCmIncludeHiddenInExport === true);
      } catch (eParse7) { }
    });
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local') return;
        if (changes.aiCmIncludeHiddenInExport) {
          aiCmIncludeHiddenInExport = (changes.aiCmIncludeHiddenInExport.newValue === true);
        }
      });
    } catch (eL7) {}
  } catch (e7) {
    console.error('[AI CM][export] include-hidden setting load error:', e7);
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
// ===== O-29 (Low): лог-строки автоэкспорта — печать ТОЛЬКО на смену состояния =====
// Живой симптом (GSA под гейтом aiCmDebug): пара «latch kept reason=spa-entry» /
// «skip reason=already-fired|not-complete» печаталась каждую секунду непрерывно — обе строки
// печатались на КАЖДЫЙ вердикт (повтор той же причины: already-fired/below-threshold вообще
// без антиспама), а не на смену состояния. Латч — aiCmAutoExportLastLogState (core/state.js,
// family → сигнатура); здесь — читатель/писатель. Только логи: вердикт гейта, латчи fired,
// пороги и байты файла не затрагиваются.
function aiCmAutoExportLogOnChange(family, key) {
  try {
    var f = String(family || '');
    var k = (key === undefined || key === null) ? '' : String(key);
    var st = (typeof aiCmAutoExportLastLogState === 'object' && aiCmAutoExportLastLogState)
      ? aiCmAutoExportLastLogState : null;
    if (!st) {
      // срез-песочница без общего состояния (core/state.js): латч живёт на самой функции —
      // без глобалов и без протечки состояния между песочницами.
      if (!aiCmAutoExportLogOnChange.__state) aiCmAutoExportLogOnChange.__state = Object.create(null);
      st = aiCmAutoExportLogOnChange.__state;
    }
    if (st[f] === k) return false;  // та же сигнатура состояния — молчание (O-29)
    st[f] = k;
    return true;
  } catch (e) { return true; }
}
// O-29: бит «латч fired этого разговора взведён» — часть сигнатуры состояния: после файра та
// же причина печатается снова РОВНО ОДИН раз (первый skip после fired). Функция только ЧИТАЕТ
// существующие латчи (O-38 once-латч + in-memory autoExportFired по ключу 'site|convId'),
// ничего не пишет и ни на что не влияет.
function aiCmAutoExportLogFiredBit(site, cid) {
  try {
    var c = (cid === undefined || cid === null) ? '' : String(cid);
    if (!c) return 0;
    var k = String(site || '') + '|' + c;
    if (typeof aiCmAutoExportFiredOnce === 'object' && aiCmAutoExportFiredOnce && aiCmAutoExportFiredOnce[k] === 1) return 1;
    if (typeof autoExportFired === 'object' && autoExportFired && autoExportFired[k] === 1) return 1;
    return 0;
  } catch (e) { return 0; }
}
// v1.18 (F5): единая tagged-строка логов автоэкспорта GSA. Антиспам — как у
// not-complete в общем пути: не чаще 1 раза на разговор для причин отсутствия полноты.
// O-29: остальные причины (already-fired, below-threshold) — тоже не чаще 1 раза, но по
// правилу «на смену состояния»: сигнатура = разговор + причина + бит латча fired.
function aiCmGsaAutoExportSkipLog(reason, cid, percentage) {
  try {
    if (reason === 'not-complete' || reason === 'probe-running') {
      var k = 'gsa:' + cid;
      if (notCompleteLogged[k]) return;
      notCompleteLogged[k] = 1;
    } else if (reason === 'not-chat-page' || reason === 'no-messages' || reason === 'empty-base') {
      // O-27 (b/c): страница без чата / пустая база — причина печатается один раз на
      // разговор и причину (иначе на сервисной странице строка шла бы каждую секунду).
      var k27 = 'gsa27:' + reason + ':' + cid;
      if (notCompleteLogged[k27]) return;
      notCompleteLogged[k27] = 1;
    }
    // O-29: печать — только на смену состояния. Хелперы того же модуля, вызов под
    // typeof-гардом — конвенция срез-песочниц тестов (O-33); без них поведение прежнее.
    if (typeof aiCmAutoExportLogOnChange === 'function') {
      var firedBit = (typeof aiCmAutoExportLogFiredBit === 'function')
        ? aiCmAutoExportLogFiredBit('google_search', cid) : 0;
      if (!aiCmAutoExportLogOnChange('gsa-skip',
          'google_search|' + cid + '|' + reason + '|fired=' + firedBit)) {
        return;
      }
    }
    debugLog('log', '[AI CM][auto-export] site=google_search skip reason=' + reason +
      ' convId=' + cid + ' pct=' + percentage +
      ' probeRunning=' + (aiCmGsaProbeRunningFor(cid) ? '1' : '0'));
  } catch (e) { }
}
// =============================================================================
// O-16: DeepSeek — защита от записи файла на ЖИВОМ SSE-стриме.
// Симптом (живой прогон): файл автоэкспорта (histSource=memory) обрывался на полуслове
// в последнем ответе ассистента, хотя сеть уже отдала полный текст (лог базы 29255
// символов против усечённого файла).
// Причина: memory-база ISOLATED-мира (lastBaseTexts) — это последний EMIT
// ai-cm-full-history. Пока MAIN-перехватчик DeepSeek читает тело ответа completion,
// последний EMIT может нести ещё НЕ ДОПИСАННЫЙ ход ассистента — запись файла по такой
// базе фиксирует обрыв. Проверка состояния потока — синхронный мост CustomEvent
// (тот же приём, что у Gemini-моста turnsMap):
//   probe 'ai-cm-deepseek-stream-probe' → '...-probe-response' {convId, active, turnFinished};
//   flush 'ai-cm-deepseek-stream-flush' — принудительный финал незакрытого буфера.
// Поведение: автоэкспорт ОТКЛАДЫВАЕТСЯ (дебаунс), пока стрим активен, и стреляет по
// факту завершения потока (EMIT полного хода + повторный гейт); ручной экспорт сначала
// флашит буфер, чтобы в файл ушло всё принятое. Прочие сервисы не затронуты: мост
// отвечает только в MAIN-мире chat.deepseek.com.
var AI_CM_DS_STREAM_DEFER_MS = 800;    // дебаунс отложенного автоэкспорта
var AI_CM_DS_STREAM_DEFER_MAX = 150;   // ≈2 мин; дальше буфер флашим принудительно
var aiCmDsStreamDeferByConv = {};      // cid -> число отложек
var aiCmDsStreamDeferLogged = {};      // cid -> 1 (антиспам строки defer)
var aiCmDsStreamFlushLogged = {};      // cid -> 1 (антиспам строки stream-flush)

// Синхронный запрос состояния живого SSE-потока DeepSeek (MAIN-мир перехватчика).
function aiCmDeepseekStreamProbe() {
  try {
    var resp = null;
    var h = function (ev) { resp = ev.detail; };
    window.addEventListener('ai-cm-deepseek-stream-probe-response', h, { once: true });
    window.dispatchEvent(new CustomEvent('ai-cm-deepseek-stream-probe'));
    window.removeEventListener('ai-cm-deepseek-stream-probe-response', h);
    return resp;
  } catch (e) { return null; }
}
// Активен ли стрим ИМЕННО этого чата. Прочие сервисы/чаты → false (поведение 1:1).
function aiCmDeepseekStreamActiveFor(cid) {
  try {
    if (((currentAdapter && currentAdapter.siteName) || '') !== 'deepseek') return false;
    var snap = aiCmDeepseekStreamProbe();
    if (!snap || snap.active !== true) return false;
    if (snap.convId && cid && String(snap.convId) !== String(cid)) return false;
    return true;
  } catch (e) { return false; }
}
// Принудительный сброс незакрытого SSE-буфера DeepSeek в memory-базу (ручной экспорт).
function aiCmFlushLiveStreamForExport(cid) {
  try {
    if (!aiCmDeepseekStreamActiveFor(cid)) return false;
    window.dispatchEvent(new CustomEvent('ai-cm-deepseek-stream-flush'));
    if (cid && !aiCmDsStreamFlushLogged[cid]) {
      aiCmDsStreamFlushLogged[cid] = 1;
      debugLog('log', '[AI CM][auto-export] stream-flush convId=' + cid + ' reason=manual');
    }
    return true;
  } catch (e) { return false; }
}
// Гейт автоэкспорта: стрим жив → файл НЕ пишем, откладываем дебаунсом. true = отложено.
function aiCmDeferAutoExportOnLiveStream(cid, percentage) {
  try {
    if (!cid) return false;
    if (!aiCmDeepseekStreamActiveFor(cid)) return false;
    var n = (aiCmDsStreamDeferByConv[cid] || 0) + 1;
    aiCmDsStreamDeferByConv[cid] = n;
    if (n > AI_CM_DS_STREAM_DEFER_MAX) {
      // Патологически долгий стрим: не ждём вечно — флашим буфер и пишем то, что пришло.
      aiCmDsStreamDeferByConv[cid] = 0;
      aiCmFlushLiveStreamForExport(cid);
      debugLog('log', '[AI CM][auto-export] stream-flush convId=' + cid +
        ' reason=defer-cap defers=' + AI_CM_DS_STREAM_DEFER_MAX);
      return false;
    }
    if (!aiCmDsStreamDeferLogged[cid]) {
      aiCmDsStreamDeferLogged[cid] = 1;
      debugLog('log', '[AI CM][auto-export] defer reason=stream-active convId=' + cid +
        ' pct=' + percentage + ' ms=' + AI_CM_DS_STREAM_DEFER_MS + ' histSource=memory');
    }
    setTimeout(function () {
      try {
        if (!cid || cid !== aiCmAutoExportConvId()) return;  // чат сменился — отложка неактуальна
        maybeAutoExport(percentage);
      } catch (eR) { }
    }, AI_CM_DS_STREAM_DEFER_MS);
    return true;
  } catch (e) { return false; }
}

// O-33 (Medium): вердикт гейта base-pending = база ещё DOM-оценка (сетевой снимок не пришёл).
// Лог этой причины — РОВНО ОДНА строка на СМЕНУ состояния (урок O-29: непрерывная серия
// DRAW с тем же вердиктом не спамит). Трекер — объект состояния content-скриптов; в
// source-песочницах тестов его нет — доступ только через typeof-гард (поведение 1:1).
var aiCmAutoExportSkipReasonState = { reason: '' };
// O-33: печать причины base-pending каноническим aiCmDiagLine под гейтом aiCmDebug
// (прецедент O-27/O-32, utils/debug.js). Гейт выключен → НИ ОДНОЙ строки; функция только
// читает уже посчитанные значения и на поведение/байты файла не влияет никогда.
function aiCmAutoExportBasePendingLog(cid, percentage) {
  try {
    if (typeof aiCmDiagLine !== 'function') return;
    var site = (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName) || '';
    aiCmDiagLine('auto-export', {
      point: 'maybeAutoExport',
      verdict: 'skip',
      reason: 'base-pending',
      site: site,
      convId: cid,
      pct: percentage,
      baseSeen: (typeof baseSeen !== 'undefined' && baseSeen === true) ? 1 : 0,
      baseComplete: (typeof baseComplete !== 'undefined' && baseComplete === true) ? 1 : 0
    });
  } catch (eBp) { }
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
    // O-27 (b/c): факты ЧАТ-страницы GSA для гейта — признак чата в DOM (threadId снаффнут
    // ИЛИ чат-контейнер), число сообщений базы и длина её текста. Считаются ТОЛЬКО для
    // google_search; не переданное значение (typeof 'undefined') вердикта не меняет, поэтому
    // песочницы/прочие сайты видят прежнее поведение 1:1.
    var gsaMsgCount;
    var gsaBaseTextLen;
    var gsaChatMarker;
    if (siteName === 'google_search') {
      gsaMsgCount = (typeof baseCount === 'number') ? baseCount : undefined;
      gsaChatMarker = (typeof aiCmGsaChatPageMarker === 'function') ? aiCmGsaChatPageMarker() : undefined;
      if (typeof baseText === 'string') {
        gsaBaseTextLen = baseText.length;
      } else if (typeof lastBaseTexts !== 'undefined' && Array.isArray(lastBaseTexts)) {
        gsaBaseTextLen = lastBaseTexts.join('\n').length;
      }
    }
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
        // O-38: + модульный латч — переживает resetConversationState (SPA-возврат)
        fired: P.getAutoExportFired(autoExportFired, siteName, cid) ||
               (typeof P.isFiredInSession === 'function' ? P.isFiredInSession(sessionFiredCache, siteName, cid) : false) ||
               (typeof aiCmAutoExportFiredOnce === 'object' && aiCmAutoExportFiredOnce && aiCmAutoExportFiredOnce[siteName + '|' + cid] === 1),
        isGemini: isGeminiSvc,
        // O-37 (A): база сервиса БЕЗ сети (qwen) — доверенная по дизайну O-35 (живой источник —
        // DOM-адаптер; признак «база адаптера принята» взведён записью source=adapter). Предикат живёт в
        // content.js (там же, где писатель признака) и вызывается typeof-гардом: в срез-
        // песочницах без него вердикт прежний, а сам гейт получает только БУЛЕВО (имя признака
        // в автоэкспорт-контур не проникает — пин v54/G). false → поведение всех платформ 1:1.
        domBaseTrusted: (typeof aiCmAutoExportTrustedBase === 'function') ? (aiCmAutoExportTrustedBase() === true) : false,
        // O-27 (b/c): сайт + факты страницы (см. shouldSkipGsaPageGuard)
        site: siteName,
        chatPageMarker: gsaChatMarker,
        msgCount: gsaMsgCount,
        baseTextLen: gsaBaseTextLen
      });
      // O-33 (урок O-29): причина текущего вердикта — база правила «лог base-pending
      // только на смене состояния» (previous reason ≠ base-pending). Трекер — общий
      // объект состояния content-скриптов (typeof-гард: срез-песочницы тестов).
      var skipReasonState = (typeof aiCmAutoExportSkipReasonState !== 'undefined') ? aiCmAutoExportSkipReasonState : null;
      if (verdict && verdict.skip) {
        var basePendingChanged = !skipReasonState || skipReasonState.reason !== 'base-pending';
        if (skipReasonState) skipReasonState.reason = verdict.reason;
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
        // O-33: база — транзиентная DOM-оценка до сетевого снимка (не-Gemini, baseSeen=false).
        // Файла нет; латч fired НЕ ставится и НЕ сбрасывается (resetFired:false) — поздний
        // честный экспорт по полной сетевой базе состоится. Строка лога — одна на смену
        // состояния (aiCmDiagLine под гейтом aiCmDebug); иных строк причина не порождает
        // (в т.ч. GSA-тега: причина общая для всех не-Gemini, вердикт — один).
        if (verdict.reason === 'base-pending') {
          if (basePendingChanged && typeof aiCmAutoExportBasePendingLog === 'function') {
            aiCmAutoExportBasePendingLog(cid, percentage);
          }
          return;
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
      // O-33 (урок O-29): вердикт не skip (файл разрешён) — состояние сменилось, поэтому
      // следующий base-pending в этом состоянии снова даст ровно одну строку.
      if (skipReasonState) skipReasonState.reason = '';
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
    // O-38: + модульный латч — переживает resetConversationState (SPA-возврат)
    if (autoExportFired[cid] ||
        (P && typeof P.isFiredInSession === 'function' && P.isFiredInSession(sessionFiredCache, siteName, cid)) ||
        (typeof aiCmAutoExportFiredOnce === 'object' && aiCmAutoExportFiredOnce && aiCmAutoExportFiredOnce[siteName + '|' + cid] === 1)) {
      debugLog('log', '[AI CM][auto-export] skip reason=already-fired convId=' + cid);
      return; // уже скачивали в этом чате
    }
    doAutoExportDownload(cid, percentage, 'threshold'); // v54: тело вынесено в хелпер
  } catch (e) {
    console.error('[AI CM][auto-export] error:', e);
  }
}
// O-36 (D3): эффективный порог автоэкспорта для ТЕКУЩЕГО сайта — РОВНО та же ось, что у
// порогового пути maybeAutoExport: per-site 'aiCmAutoExportPct_<site>' → глобальный → 90
// (кламп [1,100] делает пайплайн effectiveAutoExportThreshold, S2). Отдельная функция —
// чтобы ВТОРОЙ триггер автоэкспорта (base-complete от loader-state, v64) проверял тот же
// порог, что и первый; сам maybeAutoExport и его гейты/порядок НЕ тронуты (запинованы).
// typeof-гарды: в срез-песочницах тестов части состояния может не быть — фолбэк 90, как у
// глобального пути 1:1.
function aiCmEffectiveAutoExportThreshold(siteName) {
  try {
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    var s = (typeof autoExportSettings === 'object' && autoExportSettings) ? autoExportSettings : null;
    var globalPct = (s && typeof s.pct === 'number') ? s.pct : undefined;
    var perSitePct = (typeof autoExportPctBySite === 'object' && autoExportPctBySite)
      ? autoExportPctBySite[siteName || ''] : undefined;
    if (P && typeof P.effectiveAutoExportThreshold === 'function') {
      return P.effectiveAutoExportThreshold(globalPct, perSitePct);
    }
    return (typeof globalPct === 'number' && globalPct >= 1 && globalPct <= 100) ? globalPct : 90;
  } catch (eThr) { return 90; }
}
// O-11: имена файлов автоэкспорта, уже выданные расширением в этой вкладке (файл занят).
// Гард коллизии живёт в единственном источнике имени (buildAutoExportFileName): занятое
// имя получает дисамбигуатор -2, -3, … поэтому второй автоэкспорт GSA в ту же минуту
// (у GSA нет convId в URL, маска ручного экспорта минутная) больше не теряет копию.
// Ключ — ИТОГОВОЕ имя (с уже учтённым дисамбигуатором).
// O-11 (раунд 2): реестр консультируется и имя РЕЗЕРВИРУЕТСЯ СИНХРОННО в единственной
// точке старта скачивания (см. aiCmAutoExportStartDownload) — ДО старта, а не после него.
// Граница: реестр — изолированный мир страницы (как и весь ISOLATED-путь): полная
// навигация/перезагрузка страницы и вторая вкладка дают свой реестр; повторный экспорт
// ТОГО ЖЕ чата из второй вкладки и так блокирует кросс-табовый session-латч O3.
var aiCmAutoExportNamesUsed = Object.create(null);
// O-11 (раунд 2): ЕДИНСТВЕННАЯ точка старта скачивания автоэкспорта — для ВСЕХ сайтов
// (Gemini, ChatGPT, DeepSeek, google_search, Claude, Perplexity): doAutoExportDownload
// зовёт её ровно один раз, и других стартов скачивания автоэкспорта в расширении нет
// (ручной Ctrl+Shift+D дамп истории и ручной экспорт options.js — не автоэкспорт).
// Контракт точки строгий и СИНХРОННЫЙ:
//   1) реестр занятых имён консультируется ЗДЕСЬ, перед стартом: если имя успело стать
//      занятым (повторный вход/асинхронный дозапрос O-18), свободное имя выдаёт тот же
//      дисамбигуатор единственного источника имён (-2, -3, …);
//   2) имя РЕЗЕРВИРУЕТСЯ в реестре ДО старта скачивания (раньше запись шла ПОСЛЕ
//      downloadBlob — имя занималось уже после выдачи файла);
//   3) только после этого стартует скачивание.
// Байты файла, маска имени, формат и гейты не изменяются: сюда приходит уже собранный
// content. Возвращает ИТОГОВОЕ имя файла (его печатает fired-строка).
function aiCmAutoExportStartDownload(content, file, fmt) {
  var Pdl = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
  var used = (typeof aiCmAutoExportNamesUsed === 'object' && aiCmAutoExportNamesUsed)
    ? aiCmAutoExportNamesUsed : null;
  // (1) синхронная консультация реестра имён
  if (used && file && Pdl && typeof Pdl.isFileNameTaken === 'function' &&
      Pdl.isFileNameTaken(used, file) && typeof Pdl.disambiguateFileName === 'function') {
    file = Pdl.disambiguateFileName(file, used);
  }
  // (2) синхронный резерв имени ДО старта скачивания
  try { if (used && file) used[file] = 1; } catch (eNameReserve) { }
  // (3) старт скачивания
  // O-27 (защитный фикс): пост-гард отказа (XSSI-префикс в первых байтах контента | пустое
  // имя файла) живёт ровно в одной точке — utils/export-text-builders.js:downloadBlob,
  // поэтому его проходит ЛЮБОЙ триггер (автоэкспорт, options, печать). Порядок и содержимое
  // O-11 не тронуты: реестр консультируется и имя резервируется синхронно ДО старта, как и
  // раньше; отказ лишь не выдаёт файл и пишет `[AI CM][diag] download-blocked reason=…`.
  var Bdl = (typeof window !== 'undefined' && window.AiCmExportBuilders) ? window.AiCmExportBuilders : null;
  if (!Bdl || typeof Bdl.downloadBlob !== 'function') throw new Error('utils/export-text-builders.js не загружен');
  Bdl.downloadBlob(content, file, fmt === 'md' ? 'text/markdown' : (fmt === 'json' ? 'application/json' : 'text/plain;charset=utf-8'), 'autoexport');
  return file;
}
// v54: тело скачивания, вынесенное из maybeAutoExport для переиспользования спасательным
// pre-trim экспортом. reason='threshold' — поведение ровно как раньше; reason='pre-trim'
// добавляет суффикс -pretrim к имени файла и НЕ ставит латч autoExportFired
// (это независимый одноразовый экспорт по обрезке истории).
// v12 (O-18, фаза 2): netSynced=true — повторный вход ПОСЛЕ сетевого дозапроса истории
// (дозапрос делает перехватчик DeepSeek; здесь только ожидание с таймаутом 3 с).
// Латч autoExportFired и прочие гейты стоят ПОСЛЕ дозапроса, поэтому повторный вход
// не может ни задвоить файл, ни потерять латч; при недоступной сети поведение прежнее.
function doAutoExportDownload(cid, percentage, reason, netSynced) {
  try {
    // O-16: живой SSE-стрим DeepSeek → файл по НЕДОПИСАННОЙ memory-базе не пишем:
    // откладываем (дебаунс) до конца потока. При потолке отложек буфер флашится и
    // запись идёт по актуальному состоянию (латч fired ставит обычный путь ниже).
    // typeof-гард: функция живёт в этом же модуле; в срез-песочницах без неё
    // поведение остаётся прежним (пишем файл как раньше).
    if (typeof aiCmDeferAutoExportOnLiveStream === 'function' &&
        aiCmDeferAutoExportOnLiveStream(cid, percentage)) return;
    // v12 (O-18, фаза 2): ПЕРЕД композицией файла — сетевой дозапрос истории (только DeepSeek:
    // перехватчик MAIN-мира сам решает, нужен ли запрос, и сам выбирает текст по ходам:
    // EQUAL → live, MIDDLE-HOLE/TAIL-CUT → сеть, ONE-SIDE → live + маркер в логе).
    if (netSynced !== true && typeof aiCmExportNetSyncThen === 'function' && aiCmExportNetSyncSite()) {
      if (!aiCmNetSyncInFlight[cid]) {
        aiCmNetSyncInFlight[cid] = 1;
        var selfSync = function () {
          delete aiCmNetSyncInFlight[cid];
          doAutoExportDownload(cid, percentage, reason, true);
        };
        try {
          aiCmExportNetSyncThen(cid, selfSync);
        } catch (eSync) {
          delete aiCmNetSyncInFlight[cid];
          selfSync();
        }
        return;
      }
      // дозапрос для этого чата уже идёт (параллельный триггер) — ждём его результат
      debugLog('log', '[AI CM][auto-export] net-sync уже выполняется convId=' + cid);
      return;
    }
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
    // O-11: набор занятых имён — гард коллизии единственного источника имени. Реестр
    // модуля (typeof-гард: в срез-песочницах без него поведение прежнее, имена 1:1).
    var namesUsedD = (typeof aiCmAutoExportNamesUsed === 'object' && aiCmAutoExportNamesUsed)
      ? aiCmAutoExportNamesUsed : null;
    if (siteNameD === 'google_search' && P && typeof P.buildGsaExportFileName === 'function') {
      // v1.18 (F4): GSA — имя файла по шаблону РУЧНОГО экспорта GSA
      // ([LOW CONFIDENCE]_ai-context-monitor-google_search-<model>-<метка>.<fmt>),
      // с причиной в диагностике, а не в имени (форматы txt/md/json — из селектора).
      // O-11: занятое имя (второй экспорт в ту же минуту) → дисамбигуатор -2, -3, …
      file = P.buildGsaExportFileName(siteNameD, gsaModelD, lowConfD, fmt, namesUsedD);
    } else if (P && typeof P.buildExportFileName === 'function') {
      file = P.buildExportFileName(siteNameD, cid, reason, lowConfD, fmt, namesUsedD);
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
            // O-38: модульный латч — переживает resetConversationState (SPA-возврат в уже
            // экспортированный чат). Ключ site|convId — тот же, что у shouldSkipAutoExport.
            try {
              var siteOnce = (currentAdapter && currentAdapter.siteName) || '';
              if (typeof aiCmAutoExportFiredOnce === 'object' && aiCmAutoExportFiredOnce) {
                aiCmAutoExportFiredOnce[siteOnce + '|' + cid] = 1;
              }
            } catch (eOnce) { }
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
            // O-38: модульный латч — переживает resetConversationState
            try {
              var siteOnceFb = (currentAdapter && currentAdapter.siteName) || '';
              if (typeof aiCmAutoExportFiredOnce === 'object' && aiCmAutoExportFiredOnce) {
                aiCmAutoExportFiredOnce[siteOnceFb + '|' + cid] = 1;
              }
            } catch (eOnceFb) { }
          }
        }
        aiCmCancelDeferredHistWrite(cid); // v54: экспорт состоялся — висящий deferred-таймер больше не нужен
        // O-11 (раунд 2): ЕДИНСТВЕННАЯ точка старта скачивания автоэкспорта для ВСЕХ сайтов
        // (Gemini/ChatGPT/DeepSeek/GSA/Claude/Perplexity приходят сюда одним путём
        // maybeAutoExport → doAutoExportDownload, в т.ч. порог, base-complete и pre-trim).
        // Точка сама СИНХРОННО консультирует реестр занятых имён и резервирует имя ДО старта
        // скачивания; имя из неё же уходит в fired-строку. Гейты, латч и байты не тронуты.
        // O-27/O-32 (диагностика, только измерение): точка старта скачивания автоэкспорта —
        // триггер/reason, имя файла («пустое» — словом), первые 100 символов базы, URL,
        // threadId и источник вызова. Только под гейтом aiCmDebug; байты и имя не меняются.
        try {
          var BdiagDl = (typeof window !== 'undefined' && window && window.AiCmExportBuilders) ? window.AiCmExportBuilders : null;
          if (BdiagDl && typeof BdiagDl.aiCmDiagDownload === 'function') {
            BdiagDl.aiCmDiagDownload('autoexport', content, file, {
              reason: reason,
              site: (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName) ? currentAdapter.siteName : '',
              threadId: (typeof lastThreadId === 'string') ? lastThreadId : '',
              mime: fmt
            });
          }
        } catch (eDiagDl) { }
        file = aiCmAutoExportStartDownload(content, file, fmt);
        debugLog('log', '[AI CM][auto-export] fired convId=' + cid + ' pct=' + percentage + ' file=' + file +
          ' textLen=' + textLen + ' pendingCursor=' + (aiCmCursorLiveByConv[cid] ? '1' : '0') +
          ' baseComplete=' + (baseComplete === true ? '1' : '0') +
          ' histSource=' + histSource + ' histConvId=' + histConvId);
        // O-37 (A, ДИАГНОСТИКА, только измерение): пороговый файр по ДОВЕРЕННОЙ базе
        // адаптера (сервис без сети). Печать — в content.js (там живёт признак), здесь только
        // typeof-гард; строка выходит ровно под гейтом aiCmDebug (aiCmDiagLine) и НЕ влияет на
        // байты файла. Прочие триггеры своим путём — строка та же.
        try {
          if (typeof aiCmAutoExportTrustedBaseDiag === 'function') {
            aiCmAutoExportTrustedBaseDiag(reason, cid, percentage);
          }
        } catch (eTrustDiag) { }
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
        // O-36 (D3): ФИКС — второй триггер подчиняется порогу автоэкспорта. До фикса
        // base-complete уходил в doAutoExportDownload МИМО порога: файл писался на каждом
        // дозавершённом чате, в том числе при значении индикатора много ниже установленного
        // порога (живой дефект 2026-09-19, сообщение владельца). Порог берётся ТОЙ ЖЕ
        // функцией, что у порогового пути (per-site → глобальный → 90); вердикт — чистой
        // функцией пайплайна; строка skip несёт точные значения для диагностики.
        // Латч fired срезанным триггером НЕ ставится: поздний честный экспорт по порогу
        // (или рост pct выше порога) остаётся возможен — семантика skip-ов прежняя.
        var thrBc64 = aiCmEffectiveAutoExportThreshold((typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName) || '');
        var Pbc64 = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
        var gateBc64 = (Pbc64 && typeof Pbc64.shouldSkipBaseCompleteTrigger === 'function')
          ? Pbc64.shouldSkipBaseCompleteTrigger({ percentage: pctBc64, threshold: thrBc64 })
          : { skip: (pctBc64 < thrBc64), reason: 'below-threshold-base-complete', threshold: thrBc64 };
        if (gateBc64.skip) {
          debugLog('log', '[AI CM][auto-export] skip reason=' + gateBc64.reason + ' convId=' + cid +
            ' pct=' + pctBc64 + ' threshold=' + gateBc64.threshold + ' trigger=base-complete');
        } else {
          debugLog('log', '[AI CM][auto-export] base-complete trigger convId=' + cid +
            ' msgs=' + baseCount + ' pendingCursor=0 baseComplete=1 pct=' + pctBc64);
          doAutoExportDownload(cid, pctBc64, 'base-complete');
        }
      }
    } catch (eBc64) { console.error('[AI CM][auto-export] base-complete trigger error:', eBc64); }
  } catch (e) {
    console.error('[AI CM][auto-export] loader-state error:', e);
  }
});

// ========== v2.0 (этап 1/3): UMD-экспорт модуля ==========
// Паттерн как у utils/export-emit-pipeline.js: window.<Api> + module.exports.
// Рабочий путь ничего не импортирует: content-скрипты манифеста делят один
// глобальный лексический скоуп, поэтому объявления выше видны всем модулям и
// content.js по прежним именам. Api — для инструментов, отладки и тестов.
(function () {
  var Api = {};
  Api.sanitizeGeminiText = sanitizeGeminiText;
  Api.aiCmCollectExportSource = aiCmCollectExportSource;
  Api.aiCmExportBaseSource = aiCmExportBaseSource;
  Api.autoExportPerSiteKey = autoExportPerSiteKey;
  Api.loadAutoExportPerSitePct = loadAutoExportPerSitePct;
  Api.sessionFiredCache = sessionFiredCache;
  Api.aiCmTryLateAutoExport = aiCmTryLateAutoExport;
  Api.detectTrimStateFallback = detectTrimStateFallback;
  Api.geminiDetectTrim = geminiDetectTrim;
  Api.maybeTrimExport = maybeTrimExport;
  Api.aiCmCancelDeferredHistWrite = aiCmCancelDeferredHistWrite;
  Api.aiCmWriteCurrentHistory = aiCmWriteCurrentHistory;
  Api.aiCmFlushDeferredHistWrite = aiCmFlushDeferredHistWrite;
  Api.aiCmScheduleDeferredHistWrite = aiCmScheduleDeferredHistWrite;
  Api.loadAutoExportSettings = loadAutoExportSettings;
  Api.aiCmAutoExportConvId = aiCmAutoExportConvId;
  Api.aiCmGsaProbeByThread = aiCmGsaProbeByThread;
  Api.aiCmGsaProbeRunning = aiCmGsaProbeRunning;
  Api.aiCmGsaProbeRunningFor = aiCmGsaProbeRunningFor;
  Api.aiCmGsaAutoExportSkipLog = aiCmGsaAutoExportSkipLog;
  Api.maybeAutoExport = maybeAutoExport;
  Api.aiCmEffectiveAutoExportThreshold = aiCmEffectiveAutoExportThreshold; // O-36 (D3)
  Api.doAutoExportDownload = doAutoExportDownload;
  // O-16: мост «живой SSE-стрим DeepSeek» (для тестов и диагностики)
  Api.aiCmDeepseekStreamProbe = aiCmDeepseekStreamProbe;
  Api.aiCmDeepseekStreamActiveFor = aiCmDeepseekStreamActiveFor;
  Api.aiCmFlushLiveStreamForExport = aiCmFlushLiveStreamForExport;
  Api.aiCmDeferAutoExportOnLiveStream = aiCmDeferAutoExportOnLiveStream;
  Api.AI_CM_DS_STREAM_DEFER_MS = AI_CM_DS_STREAM_DEFER_MS;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmExportManager = Api;
})();
