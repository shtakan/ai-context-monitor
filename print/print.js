/**
 * Печатная форма для экспорта истории в PDF (v1.6.0).
 * Открывается из попапа кнопкой «Сохранить .pdf» как
 * chrome.tabs.create({ url: 'print/print.html?tab=<id>' }).
 *
 * Поток:
 *   1) читаем id вкладки из query-параметра tab;
 *   2) берём host этой вкладки (chrome.tabs.get);
 *   3) достаём санированный aiCmHistory из chrome.storage.local
 *      (тот же источник, что у индикатора и экспортов .md/.json);
 *   4) фильтруем запись по хосту вкладки и рендерим HTML;
 *   5) выставляем непустой document.title (имя файла в диалоге «Сохранить как PDF»)
 *      и вызываем window.print() — ровно ОДИН раз за жизненный цикл страницы;
 *      пользователь сохраняет PDF штатным диалогом Chrome.
 */

(function () {
  'use strict';

  // M-4.2: строки печатной формы берутся из _locales через chrome.i18n.getMessage
  // (ключи print_* есть и в ru, и в en). chrome.i18n недоступен (jsdom-песочница,
  // отладочный контекст) → возвращается прежний русский литерал: форма без локали
  // байтово прежняя. $1..$9 в сообщении локали подставляются substitutions.
  function aiCmI18nMessage(key, fallback, substitutions) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
        var message = substitutions ? chrome.i18n.getMessage(key, substitutions) : chrome.i18n.getMessage(key);
        if (message) return message;
      }
    } catch (eMessage) { }
    return fallback;
  }

  var SITE_LABELS = {
    'chatgpt': 'ChatGPT',
    'gemini': 'Gemini',
    'aistudio': 'Google AI Studio',
    'google_search': 'Google Search AI',
    'deepseek': 'DeepSeek',
    'claude': 'Claude',
    'perplexity': 'Perplexity'
  };

  function getParam(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function formatDateTime(ts) {
    var d = ts ? new Date(ts) : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // Шапка: платформа, модель, дата, токены.
  function buildHeader(history) {
    var h = history || {};
    var tokens = (typeof h.tokens === 'number') ? h.tokens : 0;
    var limit = (typeof h.limit === 'number') ? h.limit : 0;
    var percent = (typeof h.percent === 'number') ? h.percent : 0;
    var platform = SITE_LABELS[h.site] || h.site || 'AI Chat';

    var html = '<div class="doc-header">';
    html += '<h1>' + escapeText(aiCmI18nMessage('print_doc_title', 'AI Context Monitor — история диалога')) + '</h1>';
    html += '<div class="doc-meta">';
    html += '<b>' + escapeText(aiCmI18nMessage('print_meta_platform', 'Платформа:')) + '</b> ' + escapeText(platform) + '<br>';
    html += '<b>' + escapeText(aiCmI18nMessage('print_meta_model', 'Модель:')) + '</b> ' + escapeText(h.model || '—') + '<br>';
    html += '<b>' + escapeText(aiCmI18nMessage('print_meta_date', 'Дата:')) + '</b> ' + escapeText(formatDateTime(h.updatedAt)) + '<br>';
    html += '<b>' + escapeText(aiCmI18nMessage('print_meta_tokens', 'Токены:')) + '</b> ' + tokens.toLocaleString() + ' / ' + limit.toLocaleString() +
      ' (' + percent + '%)';
    html += '</div></div>';
    return html;
  }

  function buildMessages(messages) {
    var html = '';
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i] || {};
      var role = (msg.role === 'user') ? 'user' : 'assistant';
      var text = (typeof msg.text === 'string') ? msg.text : '';
      html += '<div class="msg-block ' + role + '">';
      // M-4.2: роль — ключ print_role_user / print_role_assistant (ru/en), не хардкод
      html += '<div class="msg-role">' + escapeText(role === 'user'
        ? aiCmI18nMessage('print_role_user', 'Пользователь')
        : aiCmI18nMessage('print_role_assistant', 'Ассистент')) + '</div>';
      html += '<div class="msg-body">' + renderMarkdown(text) + '</div>';
      html += '</div>';
    }
    return html;
  }

  function render(history) {
    var messages = (history && Array.isArray(history.messages)) ? history.messages : [];
    var header = buildHeader(history);
    var body = messages.length ? buildMessages(messages) :
      '<p>' + escapeText(aiCmI18nMessage('print_empty_body', 'История пуста: в хранилище нет сообщений для этой вкладки.')) + '</p>';
    return header + body;
  }

  function escapeText(s) {
    var md = (typeof window.MarkdownRenderer !== 'undefined' && window.MarkdownRenderer) ?
      window.MarkdownRenderer : null;
    if (md && md.escapeHtml) return md.escapeHtml(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
  }

  function renderMarkdown(text) {
    var md = (typeof window.MarkdownRenderer !== 'undefined' && window.MarkdownRenderer) ?
      window.MarkdownRenderer : null;
    if (md && md.render) return md.render(text);
    return escapeText(text);
  }

  function showEmpty() {
    // O-27/O-32 (диагностика): пустая форма — печати/файла не будет; имя файла пустое.
    printDiag('print-pdf-empty', { reason: 'history-not-found' });
    document.getElementById('print-content').innerHTML = '';
    document.getElementById('empty-state').style.display = 'block';
  }

  function showContent(history) {
    // O-27/O-32 (диагностика): база печатной формы (для строки точки печати) — только чтение.
    try {
      var msgsDiag = (history && Array.isArray(history.messages)) ? history.messages : [];
      var partsDiag = [];
      for (var miDiag = 0; miDiag < msgsDiag.length; miDiag++) {
        partsDiag.push((msgsDiag[miDiag] && msgsDiag[miDiag].text) || '');
      }
      diagBaseHead = partsDiag.join('\n');
      diagBaseConvId = (history && history.convId) || '';
      diagBaseSite = (history && history.site) || '';
      diagBaseMsgs = msgsDiag.length;
      printDiag('print-render', { reason: 'form-rendered' });
    } catch (eDiagShow) { }
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('print-content').innerHTML = render(history);
  }

  function waitForRenderer(cb) {
    if (typeof window.MarkdownRenderer !== 'undefined' && window.MarkdownRenderer) {
      cb();
      return;
    }
    setTimeout(function () { waitForRenderer(cb); }, 30);
  }

  // Автозакрытие вкладки печати после сохранения PDF: диалог печати закрылся (afterprint)
  // или сработал фолбэк-таймаут 2с. Шлём фоновому SW запрос на закрытие вкладки.
  function scheduleClosePrintTab() {
    var sent = false;
    function send() {
      if (sent) return;
      sent = true;
      try { chrome.runtime.sendMessage({ type: 'close-print-tab' }); } catch (e) { }
    }
    window.addEventListener('afterprint', send);
    setTimeout(send, 2000);
  }

  // v1.18 (E-2): гигиена печати.
  // (A) Диалог сохранения PDF берёт имя файла из document.title: пустой/слетевший title
  //     даёт пустое имя. Перед print() title выставляем ЯВНО из локали, с непустым фолбэком.
  // (B) Автопечать разрешена РОВНО ОДИН раз за жизненный цикл страницы: повторные вызовы
  //     (двойной init/повторная отрисовка) печати не запускают — иначе первый же сохранённый
  //     PDF оказывается «занят другим приложением» (Chrome перезаписывает файл вторым диалогом).
  // v1.18 (E-2) + M-4.2: title берётся из локали (print_page_title) с непустым
  // русским фолбэком для окружений без chrome.i18n.
  var PRINT_TITLE_FALLBACK = 'AI Context Monitor — печатная форма';
  var printInvoked = false;

  // ===========================================================================
  // O-27/O-32 (ДИАГНОСТИКА, только измерение): точка печати/сохранения PDF.
  // Гейт — aiCmDebug: sessionStorage 'aiCmDebug' === '1' ИЛИ чекбокс «Подробные логи»
  // (window.__aiCmDebugLogs). Имя файла в диалоге «Сохранить как PDF» — это document.title,
  // поэтому в лог идёт именно он (пустой — словом «пустое»), плюс первые 100 символов
  // базы, URL документа, convId и источник вызова. Поведение и разметка не меняются.
  // ===========================================================================
  var diagBaseHead = '';
  var diagBaseConvId = '';
  var diagBaseSite = '';
  var diagBaseMsgs = 0;
  function printDiagOn() {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage &&
        sessionStorage.getItem('aiCmDebug') === '1') return true;
    } catch (eSess) { }
    try {
      if (typeof window !== 'undefined' && window && window.__aiCmDebugLogs === true) return true;
    } catch (eWin) { }
    return false;
  }
  function printDiagStack() {
    try {
      var lines = String((new Error()).stack || '').split('\n');
      var out = [];
      for (var i = 1; i < lines.length && out.length < 4; i++) {
        var s = String(lines[i] || '').replace(/\s+/g, ' ').trim();
        if (!s || s.indexOf('printDiag') !== -1) continue;
        out.push(s);
      }
      return out.join(' <- ');
    } catch (eStack) { return ''; }
  }
  function printDiag(trigger, extra) {
    if (!printDiagOn()) return false;
    try {
      var url = '';
      try { url = String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eUrl) { }
      var title = '';
      try { title = String(document.title || ''); } catch (eTitle) { }
      var head = String(diagBaseHead || '').replace(/\s+/g, ' ').trim();
      if (head.length > 100) head = head.slice(0, 100) + '…';
      console.log('[AI CM][diag] download trigger=' + trigger +
        ' file=' + (title || 'пустое') +
        ' bytes100=' + (head || '(пусто)') +
        ' len=' + String(diagBaseHead || '').length +
        ' url=' + url +
        ' threadId=(нет)' +
        ' convId=' + (diagBaseConvId || '(нет)') +
        ' site=' + (diagBaseSite || '') +
        ' msgs=' + diagBaseMsgs +
        ' reason=' + ((extra && extra.reason) || '') +
        ' src=' + printDiagStack());
    } catch (eDiag) { }
    return true;
  }

  function ensurePrintTitle() {
    try {
      document.title = aiCmI18nMessage('print_page_title', PRINT_TITLE_FALLBACK);
    } catch (e) {
      document.title = PRINT_TITLE_FALLBACK;
    }
    return document.title;
  }

  function triggerPrint() {
    if (printInvoked) {
      // O-27/O-32 (диагностика): повторный триггер печати подавлен (E-2) — файла не будет.
      printDiag('print-pdf-suppressed', { reason: 'duplicate print suppressed (E-2)' });
      try { console.log('[AI CM][print] duplicate print suppressed'); } catch (e) { }
      return false;
    }
    printInvoked = true;
    ensurePrintTitle();
    // O-27/O-32 (диагностика): точка печати/сохранения PDF — имя файла = document.title.
    printDiag('print-pdf', { reason: 'auto-print (window.print); user saves PDF' });
    scheduleClosePrintTab();
    window.print();
    return true;
  }

  function init() {
    var tabId = getParam('tab');
    if (!tabId) { showEmpty(); return; }

    chrome.tabs.get(parseInt(tabId, 10), function (tab) {
      var host = '';
      if (chrome.runtime.lastError) {
        // Вкладка могла закрыться — рендерим последнюю доступную запись без фильтра по хосту
        host = '';
      } else if (tab && tab.url) {
        try { host = new URL(tab.url).hostname; } catch (e) { host = ''; }
      }

      // v1.13.1: атрибуция ручного экспорта — снимок ТОЛЬКО текущего convId вкладки.
      // Спрашиваем content-скрипт вкладки; convId известен → рендерим текущий разговор
      // (даже если база ещё пуста → пустая форма, но НИКОГДА чужой convId).
      // convId нет / content-скрипт недоступен → прежний host-level фолбэк aiCmHistory.
      chrome.tabs.sendMessage(parseInt(tabId, 10), { type: 'aiCmExportCurrent' }, function (snapResp) {
        var snap = (snapResp && snapResp.data) ? snapResp.data : null;
        chrome.storage.local.get(['aiCmHistory'], function (data) {
          var history = null;
          var all = data && data.aiCmHistory ? data.aiCmHistory : null;
          if (snap && snap.convId) {
            history = snap;
          } else if (all && all.messages) {
            if (!host || all.host === host) history = all;
          }
          if (!history || !history.messages || !history.messages.length) { showEmpty(); return; }
          showContent(history);
          // Форма отрисована — диалог печати (пользователь выбирает «Сохранить как PDF»).
          setTimeout(function () {
            triggerPrint();
          }, 50);
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForRenderer.bind(null, init));
  } else {
    waitForRenderer(init);
  }

  // v1.18 (E-2): точка автопечати доступна тестам (регрессионный пин «ровно один print»).
  // Поведение страницы не меняется — init() вызывает ту же функцию.
  try { window.__aiCmPrintTrigger = triggerPrint; } catch (e) { }
})();