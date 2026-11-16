/**
 * Shim WebExtension API для main/strict-прогонов.
 *
 * `tsconfig.json` и `tsconfig.strict.json` собираются без `@types/chrome`
 * (`compilerOptions.types: []`), поэтому `chrome.*` в них остаётся `any` —
 * ровно как было до появления пакета. Shim подхватывается main-`include`
 * (glob по каталогу `types`: все файлы `.d.ts`).
 *
 * Chrome-трек (`tsconfig.chrome.json`) этот файл исключает и видит реальные
 * типы `@types/chrome`. Пока chrome-трек не закрыт батчами, shim держит
 * main/strict зелёными и не даёт двум объявлениям `chrome` конфликтовать.
 */
declare const chrome: any;
