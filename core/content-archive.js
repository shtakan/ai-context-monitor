/**
 * core/content-archive.js — 2.4 Stage 9: восстановление архивного тира чата.
 *
 * Перенесено move-only из core/content.ts: общий лексический скоуп, тело
 * функции байтово прежнее. Classic-скрипт manifest.content_scripts[0].js
 * ПЕРЕД core/content.ts.
 */
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
            // v2.0.29 (Xray/Firefox): detail — СТРОКОЙ JSON. Массив ходов чужих компартментов
            // Firefox отдаёт MAIN-миру Xray-обёрткой, и чтение полей падает «Permission denied
            // to access property». Строка примитив — мост доезжает. MAIN разбирает её
            // aiCmBridgeDetail (core/gemini-archive.js).
            window.dispatchEvent(new CustomEvent('ai-cm-archive-restore', {
              detail: JSON.stringify({
                convId: convId,
                messages: rec.messages,
                count: (typeof rec.count === 'number' && rec.count > 0) ? rec.count : rec.messages.length,
                textLen: (typeof rec.textLen === 'number') ? rec.textLen : 0,
                format: rec.format || '',
                service: rec.service || '',
                title: rec.title || ''
              })
            }));
            debugLog('log', '[AI CM][archive-restore] dispatched convId=' + convId +
              ' msgs=' + rec.messages.length);
          } catch (eD) { /* best-effort */ }
        }
        aiCmUpdateSourceIndicator();
      } catch (eInner) { swallowSoft(eInner, 'content:aiCmLoadArchiveTier'); }
    });
  } catch (eL) {
    debugLog('log', '[AI CM][archive-restore] silent-catch load: ' + ((eL instanceof Error && eL.message) || String(eL)));
  }
}
