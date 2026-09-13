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

  // M-4.2: пользовательские строки рендеримого md-документа (шапка и роли) берутся из
  // _locales через chrome.i18n.getMessage (ключи export_md_*). chrome.i18n недоступен
  // (Node/jest, отладочный контекст) → прежний русский литерал: md без локали байтово
  // прежний. Ключи json-схемы (platform/model/...) — формат данных, их НЕ переводим.
  function aiCmI18nMessage(key, fallback, substitutions) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
        var message = substitutions ? chrome.i18n.getMessage(key, substitutions) : chrome.i18n.getMessage(key);
        if (message) return message;
      }
    } catch (eMessage) { }
    return fallback;
  }

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
  // (M-4.2: шапка и роли — из _locales, ключи export_md_*)
  function buildMdFromHistory(history, platform) {
    var h = history || {};
    var lines = [];
    lines.push(aiCmI18nMessage('export_md_title', '# AI Context Monitor — экспорт истории'));
    lines.push('');
    lines.push(aiCmI18nMessage('export_md_platform', 'Платформа: ' + (platform || 'AI Chat'), [platform || 'AI Chat']));
    lines.push(aiCmI18nMessage('export_md_model', 'Модель: ' + (h.model || '—'), [h.model || '—']));
    var exportedAt = new Date().toISOString();
    lines.push(aiCmI18nMessage('export_md_date', 'Дата экспорта: ' + exportedAt, [exportedAt]));
    var tokens = (typeof h.tokens === 'number') ? h.tokens : 0;
    var limit = (typeof h.limit === 'number') ? h.limit : 0;
    var percent = (typeof h.percent === 'number') ? h.percent : 0;
    lines.push(aiCmI18nMessage('export_md_tokens', 'Токены: ' + tokens + ' / ' + limit + ' (' + percent + '%)', [String(tokens), String(limit), String(percent)]));
    lines.push('');

    var messages = Array.isArray(h.messages) ? h.messages : [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i] || {};
      var title = (msg.role === 'user')
        ? aiCmI18nMessage('export_md_role_user', '## Пользователь')
        : aiCmI18nMessage('export_md_role_assistant', '## Ассистент');
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
