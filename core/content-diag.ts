/**
 * core/content-diag.ts — 2.3 Stage 2: экспорт диагностики и флаг подробных
 * логов.
 *
 * Classic-скрипт в manifest.content_scripts[0].js ПЕРЕД core/content.ts:
 * общий лексический скоуп, только объявления. Проводка chrome.storage
 * остаётся в content.ts и вызывает applyDebugLogs после загрузки всех модулей.
 */

type AiCmDiagResponse = import('../types/messages').AiCmDiagResponse;
type AiCmDiagPayload = import('../types/messages').AiCmDiagPayload;

// ========== ЭКСПОРТ ДИАГНОСТИКИ ==========
// popup шлёт {type:'aiCmDiag'}. content.js (ISOLATED) дёргает MAIN-перехватчик через
// window.dispatchEvent('ai-cm-diag-request') и ждёт 'ai-cm-diag-response'.
function handleAiCmDiag(sendResponse: (response?: AiCmDiagResponse) => void): void {
  var intercepted: unknown = null;
  var timer: ReturnType<typeof setTimeout> | null = null;

  function finishWithResponse() {
    if (timer) { clearTimeout(timer); timer = null; }
    // метаданные aiCmHistory из chrome.storage.local (если записаны для этого хоста)
    try {
      chrome.storage.local.get(['aiCmHistory'], function (data: Record<string, any>) {
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
        var diag: AiCmDiagPayload = {
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

  function onResponse(ev: CustomEvent) {
    try { intercepted = (ev && ev.detail) || null; } catch (e) { intercepted = null; }
    finishWithResponse();
  }

  window.addEventListener('ai-cm-diag-response', onResponse);

  // таймаут: если перехватчик (MAIN-мир) не ответил (не Gemini / не установлен) — отдаём без intercept.
  timer = setTimeout(finishWithResponse, 900);

  try { window.dispatchEvent(new CustomEvent('ai-cm-diag-request')); } catch (e) { }
}
// ========== v31: ФЛАГ «ПОДРОБНЫЕ ЛОГИ» (aiCmDebugLogs, по умолчанию ВЫКЛ) ==========
function applyDebugLogs(v: unknown): void {
  __aiCmSetDebugLogs(v);
  // транслируем в MAIN-мир перехватчикам (у них свой debug.js)
  try { window.dispatchEvent(new CustomEvent('ai-cm-debug-logs', { detail: !!v })); } catch (e) { }
}
