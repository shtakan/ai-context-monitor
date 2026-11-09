/**
 * Общая утилита MAIN-перехватчиков: setInterval с visibility-гардом и вызов
 * оригинального fetch с гашением Chrome-овского onfreeze-броска.
 * Вынесена для юнит-тестирования и переиспользования перехватчиками
 * (page / claude / perplexity / google-search / qwen).
 *
 * ESM-модуль (Roadmap Ph2): перехватчики импортируют setIntervalVisible
 * статически, а build.mjs (esbuild) втягивает модуль в MAIN-бандл каждого
 * перехватчика. Прежние UMD-зеркала и module.exports больше не публикуются —
 * единственный способ потребления это import.
 *
 * swallowSoft берётся из utils/debug.ts настоящим статическим import'ом: модуль
 * переведён на ESM (R1), поэтому esbuild втягивает его по-настоящему, без
 * синтезированной грани поверх window.__aiCmSwallowSoft (прежний
 * debugSoftFacadePlugin из build.mjs удалён).
 *
 * Задача (R2): страховочные setInterval живут всю страницу и поллят даже в
 * скрытой вкладке (document.visibilityState !== 'visible'). Гард по видимости:
 * тик выполняется ТОЛЬКО когда вкладка видима (skip-при-hidden). Состояние
 * перехватчиков персистентно, первый видимый тик догоняет — resume-листенер
 * не нужен.
 *
 * Задача (onfreeze, живая приёмка 2026-11-09): Chrome синхронно бросает из
 * fetch() «Only fetch keepalive is allowed during onfreeze», когда страница
 * уходит в bfcache/freeze. Для перехватчика это ошибка ДАЛЬНЕГО вызова
 * (нативного fetch), поэтому она всплывала из нашей обёртки uncaught
 * (core/claude-intercept.js, ChatGPT/Claude). fetchGuarded гасит ровно этот
 * случай, остальные синхронные ошибки пробрасывает как раньше.
 */

// R1 (Ph2): utils/debug.ts — настоящий ESM-модуль, экспорт реальный (@ts-expect-error снят).
import { swallowSoft } from './debug.ts';

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

/**
 * Текст Chrome-овской ошибки onfreeze. Сравнение регистронезависимое: строка
 * приходит из DOMException, локаль/версия Chrome могут менять регистр.
 */
export const ONFREEZE_ERROR_RE = /Only fetch keepalive is allowed during onfreeze/i;

/**
 * true, если ошибка — Chrome-ов onfreeze-запрет fetch (синхронный бросок).
 * @param error Перехваченное значение (обычно DOMException/Error).
 */
export function isOnFreezeError(error: unknown): boolean {
  try {
    var message = (error && typeof (error as { message?: unknown }).message !== 'undefined')
      ? String((error as { message?: unknown }).message)
      : String(error);
    return ONFREEZE_ERROR_RE.test(message);
  } catch (eText) {
    // нечитаемое значение — это не onfreeze
    return false;
  }
}

/**
 * Вызов оригинального fetch из обёртки window.fetch.
 *
 * onfreeze-бросок гасится здесь: он не всплывает uncaught из расширения, а
 * страница получает rejected promise ровно как от нативного fetch. К промису
 * сразу навешен тихий catch, поэтому консоль Chrome не показывает
 * «Uncaught (in promise)» даже если сайт не обработал отказ.
 *
 * Любая другая синхронная ошибка (в т.ч. Illegal invocation) пробрасывается
 * дальше без изменений — поведение перехватчика остаётся прежним.
 *
 * @param fetchFn Нативный fetch (уже снятый до подмены).
 * @param thisArg Получатель вызова (this сайта).
 * @param args Аргументы вызова (input, init) / arguments обёртки.
 */
export function fetchGuarded<T>(
  fetchFn: (...args: unknown[]) => Promise<T>,
  thisArg: unknown,
  args: ArrayLike<unknown>
): Promise<T> {
  try {
    var list: unknown[] = Array.prototype.slice.call(args) as unknown[];
    return Reflect.apply(fetchFn, thisArg, list) as Promise<T>;
  } catch (eCall) {
    if (!isOnFreezeError(eCall)) throw eCall;
    swallowSoft(eCall, 'intercept-common:onfreeze-fetch');
    var rejected: Promise<T> = Promise.reject(eCall);
    rejected.catch(function () {
      // тихий catch: снимаем ложный uncaught в консоли Chrome (onfreeze)
    });
    return rejected;
  }
}
