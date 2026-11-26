/**
 * core/content-tape-restore.js — 2.4 Stage 8: восстановление ленты Gemini.
 *
 * Вынесено из processAndSend БЕЗ изменения логики. Классический content-скрипт
 * (manifest до content.ts): общий лексический скоуп, состояние — из host-объекта.
 * with (host) сохраняет доступ к именам блока; сеттеры host меняют реальные
 * restoredTapeLoaded/badgeSuppressed/restoreDone.
 */
function aiCmProcessTapeRestore() {
  // v28: однократное восстановление сохранённой ленты Gemini при загрузке чата
  if (!restoredTapeLoaded) {
    restoredTapeLoaded = true;
    var svc0 = getServiceKey();
    // Нейтрализация: ключ 'aistudio' раньше не существовал, и AI Studio попадал сюда как
    // 'google_search' (т.е. в Gemini-ветку НЕ входил). Теперь ключ есть — оставляем ветку
    // строго Gemini-only, чтобы поведение AI Studio не изменилось (tape-restore Gemini
    // работает по /app/<id>, а у AI Studio путь /prompts/<id> — convId всегда пуст).
    // 'google_search'/'aistudio' сюда по-прежнему не входят: как до появления ключа.
    if (svc0 === 'gemini') {
      var convId = '';
      try {
        var m = location.pathname.match(/\/app\/(?!prompts(?:\/|$)|new(?:\/|$)|apikey(?:\/|$))([A-Za-z0-9_-]+)/);
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
        (GeminiTapeStore.load(convId)).then(function (entry) {
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
            // v2.0.29 (Xray/Firefox): detail — СТРОКОЙ JSON (см. ai-cm-archive-restore выше);
            // MAIN разбирает её aiCmBridgeDetail (core/gemini-archive.js).
            window.dispatchEvent(new CustomEvent('ai-cm-restored-history', {
              detail: JSON.stringify({
                convId: convId,
                turns: entry.turns,
                meta: entry.meta || {}
              })
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
          } catch (eT79) { swallowSoft(eT79, 'content:processAndSend-tape-restore'); }
          // v30.6: кэш-лента применена — сеть может прийти не сразу; планируем ОДНО
          // уточнение канонического значения активным снимком через 2с.
          // Гарды: convId не сменился (проверка перед диспатчем), один раз на convId за сессию.
          if (!cacheRefreshPlanned[convId]) {
            cacheRefreshPlanned[convId] = true;
            setTimeout(function () {
              if (getCurrentConvId() !== convId) return;
              try {
                // v2.0.29 (Xray/Firefox): detail — СТРОКОЙ JSON; MAIN разбирает её
                // aiCmBridgeDetail (core/gemini-archive.js).
                window.dispatchEvent(new CustomEvent('ai-cm-cache-refresh', { detail: JSON.stringify({ convId: convId }) }));
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
    // Нейтрализация (см. блок v28 выше): retry считает Gemini-ключ ленты по /app/<id> —
    // для AI Studio это всегда пустой convId, поэтому ветка остаётся строго Gemini-only.
    if (svcD8 === 'gemini') {
      var cidD8 = '';
      try {
        var mD8 = location.pathname.match(/\/app\/(?!prompts(?:\/|$)|new(?:\/|$)|apikey(?:\/|$))([A-Za-z0-9_-]+)/);
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
}
