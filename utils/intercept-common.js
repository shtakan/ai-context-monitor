/**
 * Общая утилита MAIN-перехватчиков: setInterval с visibility-гардом.
 * Вынесена для юнит-тестирования и переиспользования перехватчиками
 * (page / claude / perplexity / google-search). Работает в браузере
 * (window.aiCmCommon) и в Node (module.exports) — шапка как у
 * gemini-intercept-logic.js.
 *
 * Задача (R2): страховочные setInterval живут всю страницу и поллят даже в
 * скрытой вкладке (document.visibilityState !== 'visible'). Гард по видимости:
 * тик выполняется ТОЛЬКО когда вкладка видима (skip-при-hidden). Состояние
 * перехватчиков персистентно, первый видимый тик догоняет — resume-листенер
 * не нужен.
 */

(function () {
  /**
   * Опции setIntervalVisible.
   * @typedef {Object} VisibleIntervalOptions
   * @property {boolean} [skipWhenHidden] false — выполнять тик даже в скрытой вкладке
   *   (явный обход гарда); иначе тик только при document.visibilityState === 'visible'.
   */

  /**
   * setInterval с гардом видимости. opts.skipWhenHidden === false — принудительно
   * выполнять тик даже в скрытой вкладке (явный обход гарда). Бросок тика
   * проглатывается через swallowSoft и не ломает интервал / страницу.
   * @param {() => void} fn Тик интервала.
   * @param {number} ms Период в миллисекундах.
   * @param {VisibleIntervalOptions} [opts] Опции гарда видимости.
   * @returns {ReturnType<typeof setInterval>} Идентификатор интервала для clearInterval.
   */
  function setIntervalVisible(fn, ms, opts) {
    var id = setInterval(function () {
      try {
        if (opts && opts.skipWhenHidden === false) {
          fn();
        } else if (document.visibilityState === 'visible') {
          fn();
        }
      } catch (e) {
        swallowSoft(e, 'intercept-common:setIntervalVisible-tick');
        // тихий сброс: бросок тика не должен ломать интервал / страницу
      }
    }, ms);
    return id;
  }

  /**
   * Публичный API модуля (window.aiCmCommon / self.aiCmCommon / module.exports).
   * Тип window-зеркала описан в types/globals.d.ts как any — здесь он уточняется.
   * @typedef {Object} AiCmCommonApi
   * @property {typeof setIntervalVisible} setIntervalVisible setInterval с visibility-гардом.
   */

  /** @type {AiCmCommonApi} */
  var api = {
    setIntervalVisible: setIntervalVisible
  };

  if (typeof window !== 'undefined') {
    window.aiCmCommon = api;
  }
  // MV3 Service Worker / воркеры: глобальный объект — self (window отсутствует).
  if (typeof self !== 'undefined') {
    self.aiCmCommon = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
