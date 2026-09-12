/**
 * Общие сборщики экспорта истории чата (v1.8).
 * Используются и ручными кнопками попапа (options/options.js),
 * и автоэкспортом по порогу (core/content.js).
 * Паттерн как у buildReferenceText.js: работает в браузере
 * (window.AiCmExportBuilders) и в Node (module.exports).
 * Поведение функций НЕ менялось — перенесено из options/options.js.
 */
(function () {
  'use strict';

  // txt «эталон»: тот же buildReferenceText, что использует кнопка «Сохранить .txt»
  function buildTxtFromHistory(history) {
    var messages = (history && Array.isArray(history.messages)) ? history.messages : [];
    if (typeof window !== 'undefined' && typeof window.buildReferenceText === 'function') {
      return window.buildReferenceText(messages);
    }
    if (typeof require === 'function') {
      try { return require('./buildReferenceText.js')(messages); } catch (e) { /* fallthrough */ }
    }
    return '';
  }

  // md: та же разметка, что использовала кнопка «Сохранить .md» в попапе
  function buildMdFromHistory(history, platform) {
    var h = history || {};
    var lines = [];
    lines.push('# AI Context Monitor — экспорт истории');
    lines.push('');
    lines.push('Платформа: ' + (platform || 'AI Chat'));
    lines.push('Модель: ' + (h.model || '—'));
    lines.push('Дата экспорта: ' + new Date().toISOString());
    var tokens = (typeof h.tokens === 'number') ? h.tokens : 0;
    var limit = (typeof h.limit === 'number') ? h.limit : 0;
    var percent = (typeof h.percent === 'number') ? h.percent : 0;
    lines.push('Токены: ' + tokens + ' / ' + limit + ' (' + percent + '%)');
    lines.push('');

    var messages = Array.isArray(h.messages) ? h.messages : [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i] || {};
      var title = (msg.role === 'user') ? '## Пользователь' : '## Ассистент';
      lines.push(title);
      lines.push('');
      lines.push(msg.text || '');
      lines.push('');
    }
    return lines.join('\n');
  }

  // v1.18 (F4): json — та же схема, что у ручной кнопки «Сохранить .json»
  // (options/options.js buildJsonText): platform/model/exportedAt/tokens/limit/percent/messages.
  // Добавлен в общий сборщик, чтобы автоэкспорт по порогу умел json-формат селектора.
  function buildJsonFromHistory(history, platform) {
    var h = history || {};
    return JSON.stringify({
      platform: (platform || 'AI Chat'),
      model: h.model || '',
      exportedAt: new Date().toISOString(),
      tokens: (typeof h.tokens === 'number') ? h.tokens : 0,
      limit: (typeof h.limit === 'number') ? h.limit : 0,
      percent: (typeof h.percent === 'number') ? h.percent : 0,
      messages: Array.isArray(h.messages) ? h.messages : []
    }, null, 2);
  }

  // Скачивание через blob + временную ссылку (как раньше в options.js)
  function downloadBlob(content, fileName, mimeType) {
    try {
      var blob = new Blob([content], { type: mimeType });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      console.warn('[export] не удалось скачать файл:', e);
    }
  }

  var Api = {
    buildTxtFromHistory: buildTxtFromHistory,
    buildMdFromHistory: buildMdFromHistory,
    buildJsonFromHistory: buildJsonFromHistory,
    downloadBlob: downloadBlob
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmExportBuilders = Api;
})();
