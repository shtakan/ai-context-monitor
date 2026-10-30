/* ============================================================================================
 * aiCmIsFirefox — определение движка для BYOK-гейтов (v2.0.34, P0).
 *
 * ПОЧЕМУ НЕ `typeof browser`. Chrome 148+ выставляет в области расширения алиас `browser`,
 * поэтому прежняя проверка `typeof browser !== 'undefined'` стала истинной и в Chrome:
 * options.js прятал секции API-ключа, background.js отвечал 'byok-disabled-firefox',
 * content.js не запрашивал точный счёт — BYOK-интерфейс исчезал на Chrome.
 *
 * КАК. Единственный надёжный признак движка — схема URL самого расширения: у Firefox она
 * `moz-extension://`, у Chrome — `chrome-extension://`. Берём её у runtime.getURL('')
 * (в WebExtensions API это `api.runtime.getURL`; запасная ветка api.getURL — для моков).
 *
 * ГДЕ ЖИВЁТ. Классический скрипт без import/export: function-декларация попадает в общую
 * область видимости (options.html, content_scripts, BACKGROUND_PRELUDE сборки), поэтому
 * потребители зовут её по имени. module.exports — только для jest-тестов в Node.
 * ============================================================================================ */
function aiCmIsFirefox() {
  try {
    var api = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser
      : (typeof chrome !== 'undefined' && chrome && chrome.runtime) ? chrome : null;
    if (!api) return false;
    if (api.runtime && typeof api.runtime.getURL === 'function') {
      return String(api.runtime.getURL('')).indexOf('moz-extension://') === 0;
    }
    if (typeof api.getURL === 'function') {
      return String(api.getURL('')).indexOf('moz-extension://') === 0;
    }
    return false;
  } catch (e) {
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { aiCmIsFirefox: aiCmIsFirefox };
}
