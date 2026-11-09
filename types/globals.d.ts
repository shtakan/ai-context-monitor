/**
 * Ambient-контракт JS-мира проекта (шаг 3 Фазы 1, вариант C: проверка по месту).
 *
 * utils/*.js — это классические скрипты контент-скрипта, не ESM: каждый вешает свой
 * API на window и/или отдаёт его через module.exports (UMD-образец, см. хвост
 * utils/intercept-common.js). Поэтому для allowJs + checkJs нужно объявить то, чего
 * TypeScript не знает из коробки:
 *
 *   1. require() — CommonJS-загрузчик, которым utils/*.js подтягивают соседей в Node-ветке;
 *   2. модуль 'util' — фолбэк TextDecoder для jsdom-стендов (utils/stream-frames.ts:75);
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
 * CommonJS-объект модуля. utils/*.js отдают публичное API и через
 * `module.exports` (UMD-хвост) — это Node-ветка тестов: tests/helpers/load-esm.js
 * исполняет исходник с параметром `module`, а @jest-environment node (окна нет)
 * забирает API именно отсюда. Без @types/node TS не знает имя `module`,
 * поэтому объявляем форму контейнера; содержимое — any.
 */
declare const module: { exports: any };

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

/**
 * browser.* — WebExtension API движка Gecko (Firefox). В Chrome/Safari этого глобала нет,
 * поэтому код проверяет движок через `typeof browser !== 'undefined'` (BYOK-гейт
 * Firefox-сборки). Объявлен как any по той же причине, что и chrome: @types/chrome нет.
 */
declare const browser: any;

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
  /** utils/debug.ts — гейт диагностики (включается одноимённой настройкой) */
  __aiCmDebugLogs?: boolean;
  /** utils/debug.ts — хелпер swallow(error, tag): молчаливый catch → диагностируемый (Step E.2a) */
  __aiCmSwallow?: import('./debug').DiagFn;
  /** utils/debug.ts — хелпер swallowSoft(error, tag): канал B, console.error не вызывает (Step E.2c-A) */
  __aiCmSwallowSoft?: import('./debug').DiagFn;
  /**
   * core/content.js ← core/aistudio-intercept.js: слаг модели, названный в теле
   * сетевого запроса AI Studio (models/gemini-…). Читается adapters/aistudio-adapter.js.
   */
  __aiCmNetModelSlug?: string;
  /**
   * core/content.js: снимок сетевой истории AI Studio для текущего пути
   * ({ msgs, count, ts, href }). Читается adapters/aistudio-adapter.js.
   */
  __aiCmNetMsgs?: {
    msgs: Array<{ role: string; text: string }>;
    count: number;
    ts: number;
    href: string;
  } | null;
  /** utils/archive-import.js — разбор/план импорта (types/archive-import.d.ts). */
  AiCmArchiveImport?: import('./archive-import').ArchiveImportApi;
  /** utils/export-text-builders.js — сборщики txt/md/json (types/export.d.ts). */
  AiCmExportBuilders?: import('./export').ExportBuildersApi;
  /** utils/export-emit-pipeline.ts — имена файлов/ярус источника (types/export.d.ts). */
  AiCmExportEmitPipeline?: import('./export').ExportPipelineApi;
  /** utils/buildReferenceText.js */
  buildReferenceText?: any;
  /** utils/markdown.ts */
  MarkdownRenderer?: any;
  /** utils/gemini-intercept-logic.js */
  GeminiInterceptLogic?: any;
  /** utils/gemini-dom-parser.js */
  GeminiDomParser?: any;
  /** utils/gemini-batchexecute-parser.ts */
  GeminiBatchexecuteParser?: any;
  /** utils/google-search-folwr-parser.js */
  parseGoogleFolwrOpen?: any;
  /** utils/google-search-folwr-parser.js */
  GoogleFolwrUtils?: any;
  /**
   * core/pdf-parser.js — window.AiCmPdf: хелпер PDF-байтов (fromUrl), к которому
   * SW обращается через chrome.scripting.executeScript; объявлен после миграции
   * core/background.ts (Wave 4), где JSDoc-каст `/** @type {any} *\/(window)` перестал
   * действовать (в .ts он не типизирует выражение).
   */
  AiCmPdf?: { fromUrl?: (url: string) => any; ready?: boolean; [key: string]: any };
}
