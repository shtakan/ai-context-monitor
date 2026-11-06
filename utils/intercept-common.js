/**
 * Общая утилита MAIN-перехватчиков: setInterval с visibility-гардом.
 * Вынесена для юнит-тестирования и переиспользования перехватчиками
 * (page / claude / perplexity / google-search).
 *
 * ESM-модуль (Roadmap Ph2): перехватчики импортируют setIntervalVisible
 * статически, а build.mjs (esbuild) втягивает модуль в MAIN-бандл каждого
 * перехватчика. Прежние UMD-зеркала и module.exports больше не публикуются —
 * единственный способ потребления это import.
 *
 * swallowSoft берётся из utils/debug.js. debug.js остаётся классическим
 * MAIN-world скриптом (грузится первым в js[]), поэтому его экспорт синтезирует
 * сборка поверх window.__aiCmSwallowSoft (build.mjs, debugSoftFacadePlugin):
 * ring-буфер и window-зеркала debug.js не дублируются в каждом бандле.
 *
 * Задача (R2): страховочные setInterval живут всю страницу и поллят даже в
 * скрытой вкладке (document.visibilityState !== 'visible'). Гард по видимости:
 * тик выполняется ТОЛЬКО когда вкладка видима (skip-при-hidden). Состояние
 * перехватчиков персистентно, первый видимый тик догоняет — resume-листенер
 * не нужен.
 */

// @ts-expect-error utils/debug.js — классический скрипт без export; ESM-грань синтезирует сборка.
import { swallowSoft } from './debug.js';

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
export function setIntervalVisible(fn, ms, opts) {
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
