/**
 * core/content-publish.js — 2.4 Stage 8: публикация метрики и истории.
 *
 * Вынесено из processAndSend БЕЗ изменения логики: popup-снимок aiCmState,
 * запись aiCmHistory (network/adapter), отложенный flush и CONTEXT_UPDATE.
 * with (host) сохраняет имена блока; host — локальные значения прохода.
 */
function aiCmPublishAfterMetric(host) {
  var modelId = host.modelId, messageCount = host.messageCount, maxTokenCount = host.maxTokenCount,
    effectiveLimit = host.effectiveLimit, displayLimit = host.displayLimit,
    snapshotPercentage = host.snapshotPercentage, badgeSnap = host.badgeSnap;
  if (isExtensionValid()) {
      try {
        var stateNumbers = aiCmStatePatchFromSnapshot(badgeSnap);
        // v31: пишем также per-host ключ aiCmState:<host> — глобальный ключ затирается чужим табом/хостом
        var hostStateKey = 'aiCmState:' + window.location.hostname;
        if (typeof stateNumbers.percentage === 'number' && typeof stateNumbers.tokenEstimate === 'number') {
          var stateSnapshot = {
            host: window.location.hostname,
            site: currentAdapter.siteName,
            model: stateNumbers.modelName,
            tokens: stateNumbers.tokenEstimate,
            limit: stateNumbers.displayLimit,
            // 2.2/фаза 5: попап показывает окно модели и лимит аккаунта отдельно
            // от порога показа. null/0 — честное «неизвестно», не подмена.
            windowLimit: stateNumbers.windowLimit,
            accountLimit: stateNumbers.accountLimit,
            limitPlan: stateNumbers.limitPlan,
            limitWarnings: stateNumbers.limitWarnings,
            saturated: stateNumbers.saturated === true ? true : undefined,
            percent: stateNumbers.percentage,
            updatedAt: Date.now(),
            stale: stale,
            // v2.0.34: размер сетевого снимка. Попап включает ручной экспорт и при пустом DOM,
            // если сеть отдала реплики (Claude/Perplexity: extractMessages() === [] по дизайну).
            netBaseMsgs: lastBaseTexts.length,
            // T1 (v1.16): источник первого/второго яруса для индикатора в попапе
            sourceKind: (function () { try { var si = aiCmSourceInfo(); return si ? si.kind : ''; } catch (eSi) { return ''; } })(),
            sourceLabel: (function () { try { var si2 = aiCmSourceInfo(); return si2 ? si2.label : ''; } catch (eSi2) { return ''; } })()
          };
          var statePatch = { aiCmState: stateSnapshot };
          statePatch['aiCmState:' + window.location.hostname] = stateSnapshot;
          chrome.storage.local.set(statePatch);
        } else {
          chrome.storage.local.remove(['aiCmState', hostStateKey]);
        }
      } catch (e) { swallowSoft(e, 'content:processAndSend-state-write'); }
    }
    // Экспорт истории: пишем aiCmHistory только когда история реально изменилась (baseCount или textLen).
    // v34/v35: защита от гонки при смене треда. Адаптер-независимое условие:
    // запрет ТОЛЬКО когда оба convId непустые и разные (эмит чужого треда);
    // пустая сторона (адаптеры без convId в URL: claude/deepseek/gsa/perplexity) запись разрешает.
    var emitConvA = lastEmitConvId || '';
    var currentConvB = getCurrentConvId() || '';
    if (isExtensionValid() && baseSeen && lastBaseTexts.length > 0 &&
        !(emitConvA && currentConvB && emitConvA !== currentConvB)) {
      // BUG-D (act-gsa-turn-order): для GSA в ключ входит метка порядка 'o2' (oldest-first).
      // После реверса парсера count/textLen не меняются, и без метки запись исправленного
      // снимка ушла бы в dedup-skip — в chrome.storage остался бы старый reversed-снимок.
      // Для остальных сайтов ключ байт-в-байт прежний (site !== 'google_search').
      var histSite = (currentAdapter && currentAdapter.siteName) || '';
      var histKey = baseCount + '|' + (baseText ? baseText.length : 0) +
        (histSite === 'google_search' ? '|o2' : '');
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
          // S2.3 (ADR-001, I4): частичность берём из ЕДИНОГО снимка — того же читателя,
          // что использует барьер автоэкспорта. typeof-гард: срез-песочницы без state.ts
          // видят null → меток нет (байты прежние).
          var snapPartNet = (typeof aiCmReadContextSnapshot === 'function')
            ? aiCmReadContextSnapshot((typeof aiCmCanonicalConvId === 'function')
              ? aiCmCanonicalConvId() : (emitConvA || lastEmitConvId || '')) : null;
          // v31: дублируем в per-host ключ aiCmHistory:<host> (перезапись, без накопления)
          var histSnapshot = {
            host: window.location.hostname,
            convId: lastEmitConvId || ((typeof aiCmHistoryConvId === 'function') ? aiCmHistoryConvId() : ''),
            site: currentAdapter.siteName,
            // v47: экспорт НЕ переводим на UI-модель — здесь остаётся модель снимка
            model: lastSnapshotModelName || (ModelConfig.getModel(modelId)?.name || modelId),
            // BUG-D (act-gsa-turn-order): порядок ходов в снимке — oldest-first (msgOrder:2);
            // по этой метке options.js отличает исправленный снимок GSA от старого reversed.
            msgOrder: 2,
            tokens: maxTokenCount,
            limit: displayLimit,
            percent: snapshotPercentage,
            updatedAt: Date.now(),
            // v63: low-confidence база (sanity-фолбэк без proof) — options.js ставит префикс [LOW CONFIDENCE]_
            isLowConfidenceBase: aiCmLowConfidenceByConv[emitConvA] === true,
            // T1 (v1.16): источник истории — архив (первый ярус) или live (сеть/DOM)
            sourceKind: (function () { try { var si = aiCmSourceInfo(); return si ? si.kind : ''; } catch (eSi) { return ''; } })(),
            sourceLabel: (function () { try { var si2 = aiCmSourceInfo(); return si2 ? si2.label : ''; } catch (eSi2) { return ''; } })(),
            // S2.3 (I4): метки частичности в payload/теле файла; при partial !== true
            // ключи не появляются (undefined → JSON.stringify их отбрасывает).
            partial: (typeof aiCmExportPartialView === 'function') ? aiCmExportPartialView(snapPartNet).partial : ((snapPartNet && snapPartNet.partial === true) ? true : undefined),
            partialReason: (typeof aiCmExportPartialView === 'function')
              ? aiCmExportPartialView(snapPartNet).partialReason : ((snapPartNet && snapPartNet.partial === true) ? ((snapPartNet.partialReason) || 'incomplete') : undefined),
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
        } catch (e) { swallowSoft(e, 'content:processAndSend-history-write'); }
      }
    }
    // v81 (2.4): параллельная ветка записи истории для не-Gemini сервисов — когда сети нет
    // (baseSeen=false или пустая база), пишем aiCmHistory из DOM-адаптера; convId из
    // getCurrentConvId(); те же примитивы deferred/латч (гейт лоадера и base-confirmed —
    // только для Gemini, здесь не применяются).
    try {
      var svcS24 = getServiceKey();
      // Нейтрализация: 'aistudio' был 'google_search' ⇒ ветка не-Gemini (запись истории из
      // DOM) для него РАБОТАЛА и является для AI Studio рабочей. Оставляем Gemini-only.
      var isGeminiS24 = (svcS24 === 'gemini');
      if (!isGeminiS24 && isExtensionValid() && !baseSeen &&
          !(lastEmitConvId && currentConvB && lastEmitConvId !== currentConvB)) {
        var cidS24 = getCurrentConvId() || '';
        var msgsS24 = buildHistoryMessages();
        var histKeyS24 = 'adapter|' + msgsS24.length;
        if (msgsS24.length > 0 && histKeyS24 !== lastHistoryWroteKey && cidS24 !== '') {
          lastHistoryWroteKey = histKeyS24;
          // O-35 (v54, фикс badge-suppress): ЕДИНСТВЕННАЯ точка взвода состояния «база принята
          // по convId для adapter-пути» — ровно там, где база фактически записана (источник
          // adapter, независимо от того, что сеть молчит). Синхронно, в ISOLATED-мире, без
          // таймеров/async и вторых писателей: отсюда SPA-супрессия бейджа (badgeSuppressed)
          // отпускается по baseSeen ИЛИ adapterBaseSeen, а D1 (widget.js) не подменяет
          // посчитанное число на «—». Сброс — только resetConversationState().
          adapterBaseSeen = true;
          // P1: adapter-путь (AI Studio/Qwen, без ai-cm-full-history) принял базу — та же
          // отложенная проверка порога, что и у сетевого пути.
          if (typeof aiCmScheduleAutoExport === 'function') aiCmScheduleAutoExport(snapshotPercentage);
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
            convId: cidS24 || ((typeof aiCmHistoryConvId === 'function') ? aiCmHistoryConvId() : ''),
            site: currentAdapter.siteName,
            model: lastSnapshotModelName || (ModelConfig.getModel(modelId)?.name || modelId),
            tokens: maxTokenCount,
            limit: displayLimit,
            percent: snapshotPercentage,
            updatedAt: Date.now(),
            // v81 (2.5): полный DOM-адаптер НЕ помечается low-confidence автоматически
            isLowConfidenceBase: false,
            messages: msgsS24
          };
          var histPatchS24 = { aiCmHistory: histSnapshotS24 };
          histPatchS24['aiCmHistory:' + window.location.hostname] = aiCmHostHistoryRecord(histSnapshotS24);
          // S2.3 (ADR-001, I4): метки частичности — из ЕДИНОГО снимка (тот же читатель и cid,
          // что у барьера/сетевого пути). Дописываем аддитивно через Object.assign: при
          // partial !== true объекта нет — ключи не появляются, storage-байты прежние.
          // (Литерал выше не расширяем: source-пин окна адаптерной ветки O-35 держит запись
          // aiCmHistory:<host> в пределах 3400 символов от cidS24.)
          var snapPartAd = (typeof aiCmReadContextSnapshot === 'function')
            ? aiCmReadContextSnapshot((typeof aiCmCanonicalConvId === 'function')
              ? aiCmCanonicalConvId() : cidS24) : null;
          if (snapPartAd && snapPartAd.partial === true) {
            var partFieldsAd = {
              partial: (typeof aiCmExportPartialView === 'function') ? aiCmExportPartialView(snapPartAd).partial : true,
              partialReason: (typeof aiCmExportPartialView === 'function') ? aiCmExportPartialView(snapPartAd).partialReason : (snapPartAd.partialReason || 'incomplete')
            };
            Object.assign(histSnapshotS24, partFieldsAd);
            Object.assign(histPatchS24['aiCmHistory:' + window.location.hostname], partFieldsAd);
          }
          chrome.storage.local.set(histPatchS24);
        }
      }
    } catch (eS24) { swallowSoft(eS24, 'content:processAndSend-history-write-adapter'); }
    if (isExtensionValid()) {
      chrome.runtime.sendMessage({
        type: 'CONTEXT_UPDATE',
        data: {
          site: currentAdapter.siteName,
          model: modelId,
          modelName: ModelConfig.getModel(modelId)?.name || modelId,
          tokenCount: maxTokenCount,
          contextLimit: effectiveLimit,
          percentage: snapshotPercentage,
          messageCount,
          timestamp: Date.now()
        }
      }).catch(() => { });
    }
}
