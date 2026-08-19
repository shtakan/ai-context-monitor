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
 *   5) вызываем window.print() — пользователь сохраняет PDF штатным диалогом Chrome.
 */

(function () {
  'use strict';

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
    html += '<h1>AI Context Monitor — история диалога</h1>';
    html += '<div class="doc-meta">';
    html += '<b>Платформа:</b> ' + escapeText(platform) + '<br>';
    html += '<b>Модель:</b> ' + escapeText(h.model || '—') + '<br>';
    html += '<b>Дата:</b> ' + escapeText(formatDateTime(h.updatedAt)) + '<br>';
    html += '<b>Токены:</b> ' + tokens.toLocaleString() + ' / ' + limit.toLocaleString() +
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
      html += '<div class="msg-role">' + escapeText(role === 'user' ? 'Пользователь' : 'Ассистент') + '</div>';
      html += '<div class="msg-body">' + renderMarkdown(text) + '</div>';
      html += '</div>';
    }
    return html;
  }

  function render(history) {
    var messages = (history && Array.isArray(history.messages)) ? history.messages : [];
    var header = buildHeader(history);
    var body = messages.length ? buildMessages(messages) :
      '<p>История пуста: в хранилище нет сообщений для этой вкладки.</p>';
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
    document.getElementById('print-content').innerHTML = '';
    document.getElementById('empty-state').style.display = 'block';
  }

  function showContent(history) {
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

      chrome.storage.local.get(['aiCmHistory'], function (data) {
        var history = null;
        var all = data && data.aiCmHistory ? data.aiCmHistory : null;
        if (all && all.messages) {
          if (!host || all.host === host) history = all;
        }
        if (!history) { showEmpty(); return; }
        showContent(history);
        // Форма отрисована — диалог печати (пользователь выбирает «Сохранить как PDF»).
        setTimeout(function () {
          scheduleClosePrintTab();
          window.print();
        }, 50);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForRenderer.bind(null, init));
  } else {
    waitForRenderer(init);
  }
})();