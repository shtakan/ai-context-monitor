/**
 * Ambient-контракт JS-мира проекта (шаг 3 Фазы 1, вариант C: проверка по месту).
 *
 * utils/*.js — это классические скрипты контент-скрипта, не ESM: каждый вешает свой
 * API на window и/или отдаёт его через module.exports (UMD-образец, см. хвост
 * utils/intercept-common.js). Поэтому для allowJs + checkJs нужно объявить то, чего
 * TypeScript не знает из коробки:
 *
 *   1. require() — CommonJS-загрузчик, которым utils/*.js подтягивают соседей в Node-ветке;
 *   2. модуль 'util' — фолбэк TextDecoder для jsdom-стендов (utils/stream-frames.js:75);
 *   3. chrome.* — WebExtension API, доступный из контент-скрипта;
 *   4. window.<...> — глобалы, которые utils/*.js публикуют друг для друга.
 *
 * @types/node и @types/chrome на шаге 3 НЕ устанавливаются (вне scope), поэтому внешние
 * API объявлены как any. Это описание ШВА между мирами (браузер расширения / Node),
 * а не типизация логики: сама логика utils/ типизируется JSDoc-аннотациями в файлах.
 */

// --- Node-глобали -----------------------------------------------------------

/**
 * CommonJS-загрузчик. Возвращает any: без @types/node точные формы модулей неизвестны.
 * @param {string} id — идентификатор модуля ('util') или относительный путь ('./x.js')
 * @returns {any}
 */
declare function require(id: string): any;

/**
 * Встроенный модуль Node 'util'. Без @types/node TS не резолвит его сам, а строковый
 * литерал в require('util') он резолвит всегда — поэтому объявляем модуль явно.
 */
declare module 'util' {
  const util: { TextDecoder: any };
  export = util;
}

// --- WebExtension API -------------------------------------------------------

/** chrome.* доступен из контент-скрипта; без @types/chrome объявлен как any. */
declare const chrome: any;

// --- Глобалы проекта, публикуемые utils/*.js на window ----------------------
// Каждый опциональный: в Node-ветке (module.exports) их на window нет, и код
// проверяет их наличие через typeof, прежде чем использовать.

interface Window {
  /** utils/chatgpt-conversation-parser.js */
  ChatGPTConversationParser?: any;
  /** utils/perplexity-parser.js */
  parsePerplexityThread?: any;
  /** utils/intercept-common.js */
  aiCmCommon?: any;
  /** utils/stream-frames.js */
  aiCmStreamFrames?: any;
  /** utils/debug.js — гейт диагностики (включается одноимённой настройкой) */
  __aiCmDebugLogs?: boolean;
  /** utils/debug.js — хелпер swallow(error, tag): молчаливый catch → диагностируемый (Step E.2a) */
  __aiCmSwallow?: any;
  /** utils/archive-import.js */
  AiCmArchiveImport?: any;
  /** utils/export-text-builders.js */
  AiCmExportBuilders?: any;
  /** utils/export-emit-pipeline.js */
  AiCmExportEmitPipeline?: any;
  /** utils/buildReferenceText.js */
  buildReferenceText?: any;
  /** utils/markdown.js */
  MarkdownRenderer?: any;
  /** utils/gemini-intercept-logic.js */
  GeminiInterceptLogic?: any;
  /** utils/gemini-dom-parser.js */
  GeminiDomParser?: any;
  /** utils/gemini-batchexecute-parser.js */
  GeminiBatchexecuteParser?: any;
  /** utils/google-search-folwr-parser.js */
  parseGoogleFolwrOpen?: any;
  /** utils/google-search-folwr-parser.js */
  GoogleFolwrUtils?: any;
}
