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
 * swallowSoft берётся из utils/debug.js настоящим статическим import'ом: модуль
 * переведён на ESM (R1), поэтому esbuild втягивает его по-настоящему, без
 * синтезированной грани поверх window.__aiCmSwallowSoft (прежний
 * debugSoftFacadePlugin из build.mjs удалён).
 *
 * Задача (R2): страховочные setInterval живут всю страницу и поллят даже в
 * скрытой вкладке (document.visibilityState !== 'visible'). Гард по видимости:
 * тик выполняется ТОЛЬКО когда вкладка видима (skip-при-hidden). Состояние
 * перехватчиков персистентно, первый видимый тик догоняет — resume-листенер
 * не нужен.
 */

// R1 (Ph2): utils/debug.js — настоящий ESM-модуль, экспорт реальный (@ts-expect-error снят).
import { swallowSoft } from './debug.js';

/**
 * Опции setIntervalVisible (локально для этого модуля, см. types/ — там
 * объявляются только кросс-файловые глобалы).
 */
export interface VisibleIntervalOptions {
  /** false — выполнять тик даже в скрытой вкладке (явный обход гарда);
   *  иначе тик только при document.visibilityState === 'visible'. */
  skipWhenHidden?: boolean;
}

/**
 * setInterval с гардом видимости. opts.skipWhenHidden === false — принудительно
 * выполнять тик даже в скрытой вкладке (явный обход гарда). Бросок тика
 * проглатывается через swallowSoft и не ломает интервал / страницу.
 * @param fn Тик интервала.
 * @param ms Период в миллисекундах.
 * @param opts Опции гарда видимости.
 * @returns Идентификатор интервала для clearInterval.
 */
export function setIntervalVisible(
  fn: () => void,
  ms: number,
  opts?: VisibleIntervalOptions
): ReturnType<typeof setInterval> {
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
