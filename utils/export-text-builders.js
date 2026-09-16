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

  // ===========================================================================
  // O-27/O-32 (ДИАГНОСТИКА, только измерение): лог точки скачивания файла.
  // Гейт — aiCmDebug: sessionStorage 'aiCmDebug' === '1' ИЛИ чекбокс «Подробные логи»
  // (window.__aiCmDebugLogs). В контент-скрипте канонические хелперы даёт utils/debug.js
  // (aiCmDiagDownload); в popup/options этот файл подключён БЕЗ debug.js, поэтому здесь
  // та же семантика реализована локально. Гейт выключен → ни одной строки; функция
  // только читает уже собранные content/fileName и НЕ меняет байты экспорта.
  // ===========================================================================
  // Единый префикс диагностических строк этого файла (ровно одно место — литерал ниже):
  // и обычная строка скачивания, и строка отказа печатаются через DIAG_PREFIX.
  var DIAG_PREFIX = '[AI CM][diag]';
  function diagOn() {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage &&
        sessionStorage.getItem('aiCmDebug') === '1') return true;
    } catch (eSess) { }
    try {
      if (typeof window !== 'undefined' && window && window.__aiCmDebugLogs === true) return true;
    } catch (eWin) { }
    return false;
  }
  function diagHead(v, n) {
    try {
      var lim = (typeof n === 'number' && n > 0) ? n : 100;
      if (v === undefined || v === null) return '';
      var s = String(v);
      if (!s) return '';
      var flat = s.replace(/\s+/g, ' ').trim();
      if (!flat) return '';
      return (flat.length > lim) ? (flat.slice(0, lim) + '…') : flat;
    } catch (eHead) { return ''; }
  }
  function diagStack() {
    try {
      var lines = String((new Error()).stack || '').split('\n');
      var out = [];
      for (var i = 1; i < lines.length && out.length < 4; i++) {
        var s = String(lines[i] || '').replace(/\s+/g, ' ').trim();
        if (!s || s.indexOf('diag') !== -1) continue;
        out.push(s);
      }
      return out.join(' <- ');
    } catch (eStack) { return ''; }
  }
  // Единая точка: триггер, имя файла (пустое — словом «пустое»), первые 100 символов
  // базы, её длина, URL документа, threadId, источник вызова (dev-режим).
  function diagDownload(trigger, content, fileName, extra) {
    try {
      if (typeof aiCmDiagDownload === 'function') return aiCmDiagDownload(trigger, content, fileName, extra);
    } catch (eGlobal) { }
    if (!diagOn()) return false;
    try {
      var e = extra || {};
      var url = '';
      try { url = String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eUrl) { }
      console.log(DIAG_PREFIX + ' download trigger=' + (trigger || '(нет)') +
        ' file=' + ((fileName === undefined || fileName === null || String(fileName) === '') ? 'пустое' : String(fileName)) +
        ' bytes100=' + (diagHead(content, 100) || 'пусто') +
        ' len=' + ((content === undefined || content === null) ? 0 : String(content).length) +
        ' mime=' + (e.mime === undefined ? '(нет)' : e.mime) +
        ' url=' + url +
        ' threadId=' + (e.threadId === undefined || e.threadId === '' ? '(нет)' : e.threadId) +
        ' site=' + (e.site === undefined ? '' : e.site) +
        ' reason=' + (e.reason === undefined ? '' : e.reason) +
        ' src=' + diagStack());
    } catch (eLog) { }
    return true;
  }

  // ===========================================================================
  // O-27 (защитный фикс, пост-гард ЕДИНСТВЕННОЙ точки скачивания): файл НЕ выдаётся,
  // если контент — форма мусора (первые байты — XSSI-префикс Google `)]}'`; живой артефакт
  // `f.txt` с captcha-страницы) ИЛИ имя файла пустое/не задано (живой путь: автоэкспорт на
  // captcha-странице скачал мусор с ПУСТЫМ именем). Отказ — поведение точки (ловится любой
  // триггер: автоэкспорт, попап/options, печать); сама строка отказа (download-blocked,
  // reason=xssi-prefix|empty-name) печатается только под гейтом aiCmDebug. Content/fileName
  // только читаются: байты легитимного экспорта не меняются.
  // ===========================================================================
  var XSSI_PREFIX_LEN = 4;
  // Первые байты контента — четырёхсимвольный XSSI-префикс Google (`)]}'`)? Сравнение по
  // кодам символов: в литерале нет фигурной скобки (source-пин-тесты режут функции по
  // балансу скобок).
  function startsWithXssiPrefix(content) {
    try {
      if (content === undefined || content === null) return false;
      var s = String(content);
      if (s.length < XSSI_PREFIX_LEN) return false;
      return s.charCodeAt(0) === 41 && s.charCodeAt(1) === 93 &&
        s.charCodeAt(2) === 125 && s.charCodeAt(3) === 39;
    } catch (eXssi) { return false; }
  }
  // Причина отказа точки скачивания или null. Контент проверяется ПЕРВЫМ: живой `f.txt`
  // подходит под оба условия (XSSI-тело + пустое имя), и решающая причина там — форма мусора.
  function downloadBlockReason(content, fileName) {
    if (startsWithXssiPrefix(content)) return 'xssi-prefix';
    if (fileName === undefined || fileName === null || String(fileName).trim() === '') return 'empty-name';
    return null;
  }
  // Строка отказа: `download-blocked reason=<причина> …` с общим префиксом DIAG_PREFIX.
  // В контент-скрипте приоритет у канонического хелпера utils/debug.js (тот же гейт
  // aiCmDebug и та же строка).
  function diagDownloadBlocked(trigger, content, fileName, reason, extra) {
    try {
      if (typeof aiCmDiagDownloadBlocked === 'function') {
        return aiCmDiagDownloadBlocked(trigger, content, fileName, reason, extra);
      }
    } catch (eGlobalBlocked) { }
    if (!diagOn()) return false;
    try {
      var e = extra || {};
      var url = '';
      try { url = String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eUrlB) { }
      console.log(DIAG_PREFIX + ' download-blocked reason=' + (reason || '(нет)') +
        ' trigger=' + (trigger || '(нет)') +
        ' file=' + ((fileName === undefined || fileName === null || String(fileName) === '') ? 'пустое' : String(fileName)) +
        ' bytes100=' + (diagHead(content, 100) || 'пусто') +
        ' len=' + ((content === undefined || content === null) ? 0 : String(content).length) +
        ' mime=' + (e.mime === undefined ? '(нет)' : e.mime) +
        ' url=' + url +
        ' threadId=' + (e.threadId === undefined || e.threadId === '' ? '(нет)' : e.threadId) +
        ' site=' + (e.site === undefined ? '' : e.site) +
        ' src=' + diagStack());
    } catch (eLogBlocked) { }
    return true;
  }

  // Скачивание через blob + временную ссылку (как раньше в options.js)
  // O-27/O-32: 4-й аргумент trigger и 5-й extra — ТОЛЬКО для диагностической строки;
  // поведение, байты (content), mime и имя файла не меняются.
  // O-27 (защитный фикс): перед выдачей файла — пост-гард формы мусора/пустого имени.
  function downloadBlob(content, fileName, mimeType, trigger, extra) {
    var ex = extra || {};
    var blockReason = downloadBlockReason(content, fileName);
    if (blockReason) {
      try {
        diagDownloadBlocked(trigger || 'builder-download', content, fileName, blockReason,
          { mime: mimeType, threadId: ex.threadId, site: ex.site });
      } catch (eDiagBlocked) { }
      return false; // файл не выдан: форма мусора либо имя не задано
    }
    try {
      diagDownload(trigger || 'builder-download', content, fileName,
        { mime: mimeType, threadId: ex.threadId, site: ex.site, reason: ex.reason });
    } catch (eDiag) { }
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
    return true;
  }

  var Api = {
    buildTxtFromHistory: buildTxtFromHistory,
    buildMdFromHistory: buildMdFromHistory,
    buildJsonFromHistory: buildJsonFromHistory,
    downloadBlob: downloadBlob,
    // O-27 (защитный фикс): причина отказа точки скачивания (null — выдача разрешена) и
    // сама точка отказа наружу — для пинов тестов и переиспользования вызывающим кодом.
    aiCmDownloadBlockReason: downloadBlockReason,
    aiCmDiagDownloadBlocked: diagDownloadBlocked,
    // O-27/O-32: диагностические хелперы наружу (content.js/export-manager.js зовут их
    // через window.AiCmExportBuilders, если глобальный utils/debug.js не подключён).
    aiCmDiagOn: diagOn,
    aiCmDiagHead: diagHead,
    aiCmDiagDownload: diagDownload
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmExportBuilders = Api;
})();
