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

// ===== BUG-25 (follow-up): журнал последнего живого хода Qwen =====
// Переживает F5: MAIN-перехватчик отдаёт завершённый SSE-ход, ISOLATED пишет
// компактную запись в chrome.storage.local. На загрузке/смене чата запись
// возвращается в MAIN и применяется ТОЛЬКО к пустому pending-ходу.
// Хранится только текст последнего ответа: без URL/JWT/вложений; TTL 24 ч,
// размерный cap, ключ на разговор.
var AI_CM_LIVE_TAIL_PREFIX = 'aiCmLiveTail:';
var AI_CM_LIVE_TAIL_TTL_MS = 24 * 60 * 60 * 1000;
var AI_CM_LIVE_TAIL_MAX_CHARS = 256 * 1024;

function aiCmLiveTailSite() {
  try {
    return (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName) || '';
  } catch (eSite) { swallowSoft(eSite, 'content:liveTailSite'); return ''; }
}
function aiCmLiveTailConvId() {
  try {
    return (typeof getCurrentConvId === 'function' && getCurrentConvId()) || '';
  } catch (eConv) { swallowSoft(eConv, 'content:liveTailConv'); return ''; }
}
function aiCmLiveTailKey(site, convId) {
  return AI_CM_LIVE_TAIL_PREFIX + String(site || '') + ':' + String(convId || '');
}
function aiCmLiveTailParse(detail) {
  if (typeof detail !== 'string') return detail;
  try { return JSON.parse(detail); } catch (eParse) { swallowSoft(eParse, 'content:liveTailParse'); return null; }
}
function aiCmLiveTailSave(detail) {
  try {
    var d = aiCmLiveTailParse(detail);
    if (!d || typeof d !== 'object') return;
    var site = String(d.site || aiCmLiveTailSite());
    if (site !== 'qwen') return;
    var convId = String(d.chatId || aiCmLiveTailConvId());
    if (!convId) return;
    var rec = {
      v: 1,
      site: site,
      chatId: convId,
      responseId: String(d.responseId || ''),
      userKey: String(d.userKey || ''),
      userPrompt: String(d.userPrompt || ''),
      answer: String(d.answer || ''),
      reasoning: String(d.reasoning || ''),
      model: String(d.model || ''),
      ts: (typeof d.ts === 'number' && d.ts > 0) ? d.ts : Date.now()
    };
    if (!rec.answer && !rec.reasoning) return;
    if (JSON.stringify(rec).length > AI_CM_LIVE_TAIL_MAX_CHARS) return;
    var key = aiCmLiveTailKey(site, convId);
    chrome.storage.local.set((function () { var o = {}; o[key] = rec; return o; })(), function () {
      try {
        if (chrome.runtime.lastError) return;
        debugLog('log', '[AI CM][live-tail] saved convId=' + convId.slice(0, 8) +
          ' answerLen=' + rec.answer.length + ' reasoningLen=' + rec.reasoning.length);
      } catch (eCb) { swallowSoft(eCb, 'content:liveTailSave-cb'); }
    });
  } catch (eSave) { swallowSoft(eSave, 'content:liveTailSave'); }
}
function aiCmLiveTailRestore() {
  try {
    var site = aiCmLiveTailSite();
    if (site !== 'qwen') return;
    var convId = aiCmLiveTailConvId();
    if (!convId) return;
    var key = aiCmLiveTailKey(site, convId);
    chrome.storage.local.get([key], function (data) {
      try {
        var rec = data && data[key];
        if (!rec || String(rec.chatId || '') !== convId) return;
        if (rec.site && rec.site !== 'qwen') return;
        if (typeof rec.ts === 'number' && Date.now() - rec.ts > AI_CM_LIVE_TAIL_TTL_MS) {
          chrome.storage.local.remove(key);
          return;
        }
        if (!rec.answer && !rec.reasoning) return;
        if (aiCmLiveTailConvId() !== convId) return;
        window.dispatchEvent(new CustomEvent('ai-cm-qwen-live-tail-restore', {
          detail: JSON.stringify(rec)
        }));
        debugLog('log', '[AI CM][live-tail] restore convId=' + convId.slice(0, 8) +
          ' answerLen=' + String(rec.answer || '').length);
      } catch (eRestoreCb) { swallowSoft(eRestoreCb, 'content:liveTailRestore-cb'); }
    });
  } catch (eRestore) { swallowSoft(eRestore, 'content:liveTailRestore'); }
}
function aiCmLiveTailClear(detail) {
  try {
    var d = aiCmLiveTailParse(detail);
    if (!d || typeof d !== 'object') return;
    var site = aiCmLiveTailSite();
    if (site !== 'qwen') return;
    var convId = String(d.chatId || aiCmLiveTailConvId());
    if (!convId) return;
    var key = aiCmLiveTailKey(site, convId);
    chrome.storage.local.get([key], function (data) {
      try {
        var rec = data && data[key];
        if (!rec) return;
        if (rec.responseId && (!d.responseId || String(d.responseId) !== String(rec.responseId))) return;
        chrome.storage.local.remove(key);
      } catch (eClearCb) { swallowSoft(eClearCb, 'content:liveTailClear-cb'); }
    });
  } catch (eClear) { swallowSoft(eClear, 'content:liveTailClear'); }
}

try {
  window.addEventListener('ai-cm-qwen-live-tail', function (ev) { aiCmLiveTailSave(ev && ev.detail); });
  window.addEventListener('ai-cm-qwen-live-tail-request', function () { aiCmLiveTailRestore(); });
  window.addEventListener('ai-cm-qwen-live-tail-clear', function (ev) { aiCmLiveTailClear(ev && ev.detail); });
  window.addEventListener('ai-cm-qwen-live-tail-merged', function (ev) {
    try {
      var d = aiCmLiveTailParse(ev && ev.detail);
      var cid = aiCmLiveTailConvId();
      if (d && d.chatId && cid && String(d.chatId) !== String(cid)) return;
      // Журнал восстановил текст — снимаем метку history-not-finalized и
      // пересобираем снимок из тех же turns. baseComplete не понижаем.
      try { if (typeof baseCompleteReason !== 'undefined') baseCompleteReason = 'complete'; } catch (eReason) { swallowSoft(eReason, 'content:liveTailReason'); }
      if (typeof isInitialized !== 'undefined' && isInitialized && typeof processAndSend === 'function') processAndSend();
    } catch (eMerged) { swallowSoft(eMerged, 'content:liveTailMerged'); }
  });
} catch (eLiveTailEvents) { swallowSoft(eLiveTailEvents, 'content:liveTailEvents'); }

// Страховка на холодную загрузку: content.ts назначает адаптер позже этого файла.
try { setTimeout(aiCmLiveTailRestore, 1500); } catch (eLiveTailInit) { swallowSoft(eLiveTailInit, 'content:liveTailInit'); }
try { setTimeout(aiCmLiveTailRestore, 5000); } catch (eLiveTailInit2) { swallowSoft(eLiveTailInit2, 'content:liveTailInit2'); }
