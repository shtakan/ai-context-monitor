/**
 * Ambient-объявление глобала классических скриптов расширения.
 *
 * `utils/platform.js` — UMD: на верхнем уровне объявляет `function aiCmIsFirefox()` и
 * дополнительно отдаёт её через `module.exports` для jest-тестов в Node. Из-за ветки
 * `module.exports` TypeScript (allowJs + checkJs) считает файл модулем, поэтому его
 * function-декларация не попадает в global scope, и `core/background.js`/`core/content.js`
 * получали TS2304. Здесь сигнатура повторена как ambient — ровно как types/core-globals.d.ts
 * поступает с другими кросс-файловыми функциями (сам types/ в этой задаче не меняется).
 *
 * В рантайме объявление исчезает: в options.html/content_scripts функция приходит из
 * utils/platform.js, в SW — из BACKGROUND_PRELUDE (build.mjs), в vm-песочницах тестов —
 * из подложенного исходника.
 */
declare function aiCmIsFirefox(): boolean;
