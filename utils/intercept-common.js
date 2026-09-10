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
  // setInterval с гардом видимости. opts.skipWhenHidden === false — принудительно
  // выполнять тик даже в скрытой вкладке (явный обход гарда).
  function setIntervalVisible(fn, ms, opts) {
    var id = setInterval(function () {
      try {
        if (opts && opts.skipWhenHidden === false) {
          fn();
        } else if (document.visibilityState === 'visible') {
          fn();
        }
      } catch (e) {
        // тихий сброс: бросок тика не должен ломать интервал / страницу
      }
    }, ms);
    return id;
  }

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
