/**
 * Шаг 1 миграции на TypeScript: Jest-трансформер для `.ts`/`.tsx`.
 *
 * Зачем: tsconfig.json держит `noEmit`, поэтому Jest не может исполнять TS так, как
 * это делает `tsc`; отдельный `typescript`-транспилятор (ts-jest) потянул бы новую
 * зависимость. esbuild уже стоит — build.mjs собирает им бандлы — и его
 * `transformSync` делает ровно то, что нужно тесту: снимает типы, оставляя
 * исполняемый JS.
 *
 * Контракт Jest 29: модуль экспортирует `process(sourceText, sourcePath, options)`
 * (и, опционально, `getCacheKey`). Возвращается CJS, потому что сьют гоняется в
 * дефолтном (не-ESM) режиме: `import`/`export` из TS-теста esbuild превращает в
 * `require`/`__export`, и дальше Jest работает как с обычным CJS-модулем.
 *
 * Файлы `.js`/`.jsx`/`.cjs`/`.mjs` по-прежнему идут через `babel-jest`
 * (см. "transform" в package.json): именно babel-preset-jest поднимает
 * `jest.mock(...)` к началу модуля, и терять этот хойстинг нельзя.
 *
 * TS-исходников в репозитории пока нет — файл готовит инфраструктуру (Шаг 1 плана
 * миграции), а не меняет исполнение текущего сьюта.
 */
'use strict';

const path = require('node:path');

const esbuild = require('esbuild');

/** Расширение → loader esbuild. Трансформер вызывается только для `.ts*`, но mts/cts тоже покрыты. */
const LOADERS = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
};

function loaderFor(filename) {
  return LOADERS[path.extname(filename).toLowerCase()] || 'ts';
}

module.exports = {
  process(sourceText, sourcePath) {
    const { code } = esbuild.transformSync(sourceText, {
      loader: loaderFor(sourcePath),
      format: 'cjs',
      // target совпадает с tsconfig.json: ES2020 понимает и jsdom-окружение Jest.
      target: 'es2020',
      sourcefile: sourcePath,
      // Инлайн-карта держит стек-трейсы на строках TS-исходника, а не сгенерированного JS.
      sourcemap: 'inline',
    });
    return { code };
  },

  /** Кеш Jest не должен переиспользовать вывод другой версии esbuild. */
  getCacheKey(sourceText, sourcePath, options) {
    const instrument = typeof options === 'object' && options !== null && options.instrument === true;
    return JSON.stringify([esbuild.version, instrument, sourcePath, sourceText]);
  },
};
