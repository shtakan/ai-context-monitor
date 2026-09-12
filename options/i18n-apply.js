/**
 * M-4 (фаза 3): i18n-фундамент — общий механизм подстановки локализованных строк.
 *
 * Подключается и в options/options.html, и в print/print.html. Статическая разметка
 * объявляет ключи из _locales/<lang>/messages.json атрибутами:
 *   data-i18n              → textContent
 *   data-i18n-placeholder  → placeholder
 *   data-i18n-title        → title
 *   data-i18n-aria-label   → aria-label
 *
 * Русский текст/значение в разметке остаётся ФОЛБЭКОМ: подстановка затирает его
 * только при непустом chrome.i18n.getMessage(key). Так страница остаётся читаемой,
 * если chrome.i18n недоступен (jsdom, отладочный контекст), и статические пины
 * регрессии по разметке не меняются.
 *
 * Осознанно НЕ переводятся (M-4, п.5): логи, статусы и прочие динамические строки,
 * которые пишут options.js / print.js / content-скрипты.
 */
(function () {
  'use strict';

  // Атрибут-ключ → куда подставлять сообщение локали.
  var BINDINGS = [
    { key: 'data-i18n', target: 'textContent' },
    { key: 'data-i18n-placeholder', target: 'placeholder' },
    { key: 'data-i18n-title', target: 'title' },
    { key: 'data-i18n-aria-label', target: 'aria-label' }
  ];

  /**
   * Сообщение локали по ключу. '' — если chrome.i18n недоступен, ключ неизвестен
   * или вызов бросил: вызывающая сторона сохраняет фолбэк из разметки.
   */
  function aiCmI18nMessage(key) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
        return chrome.i18n.getMessage(key) || '';
      }
    } catch (eMessage) { }
    return '';
  }

  /**
   * Подставляет локализованные строки во всё поддерево root (по умолчанию document).
   * Возвращает число фактически применённых подстановок. Идемпотентно.
   */
  function aiCmI18nApply(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
    var applied = 0;
    for (var i = 0; i < BINDINGS.length; i++) {
      var binding = BINDINGS[i];
      var nodes = scope.querySelectorAll('[' + binding.key + ']');
      for (var j = 0; j < nodes.length; j++) {
        var message = aiCmI18nMessage(nodes[j].getAttribute(binding.key));
        if (!message) continue;
        if (binding.target === 'textContent') nodes[j].textContent = message;
        else nodes[j].setAttribute(binding.target, message);
        applied++;
      }
    }
    return applied;
  }

  function aiCmI18nBoot() {
    aiCmI18nApply(document);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', aiCmI18nBoot);
    } else {
      aiCmI18nBoot();
    }
  }

  // Экспорт для юнит-тестов (jest). В браузере (MV3, классический скрипт
  // options.html/print.html) module не определён — блок не выполняется.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      aiCmI18nApply: aiCmI18nApply,
      aiCmI18nMessage: aiCmI18nMessage,
      bindings: BINDINGS
    };
  }
})();
