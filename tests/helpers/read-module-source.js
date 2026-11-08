'use strict';

/**
 * Чтение исходника модуля для хелперов, исполняющих его через new Function
 * (load-esm.js, main-intercept.js).
 *
 * `.js`-модули отдаются как есть. Для `.ts` типы снимает esbuild.transformSync —
 * тот же транспилятор, что у build.mjs и у jest-трансформера
 * (tools/jest-esbuild-transform.js): new Function не принимает TS-аннотации.
 *
 * esbuild нормализует объявления в трейлинг-блок `export { a, b as default };`,
 * а хелперы рассчитывают на исходную форму (`export function f`, `export default f`),
 * поэтому форма экспортов восстанавливается обратно: префикс `export ` ставится
 * на объявление по имени, default-алиас превращается в `export default <local>;`.
 */

const fs = require('fs');

const DECL_KEYWORDS = '(?:async\\s+)?(?:function|var|let|const|class)';

let esbuildApi = null;

/**
 * Загружает esbuild внутри тестового окружения.
 *
 * esbuild на загрузке проверяет `Buffer.from('') instanceof Uint8Array`. В
 * jsdom-окружении Jest код теста живёт в отдельном realm'е: Buffer приходит из
 * Node, а `Uint8Array` — глобал песочницы, поэтому проверка ложно падает
 * («Invariant violation»). На время require подменяем глобал на Node-овский
 * конструктор и сразу откатываем: подмена синхронная, ни один другой модуль её
 * не наблюдает. В node-окружении проверка проходит сама, подмены нет.
 */
function loadEsbuild() {
  if (esbuildApi) return esbuildApi;
  const saved = globalThis.Uint8Array;
  const nodeUint8Array = Object.getPrototypeOf(
    Object.getPrototypeOf(Buffer.from(''))
  ).constructor;
  try {
    if (!(Buffer.from('') instanceof Uint8Array)) {
      globalThis.Uint8Array = nodeUint8Array;
    }
    esbuildApi = require('esbuild');
  } finally {
    globalThis.Uint8Array = saved;
  }
  return esbuildApi;
}

/** Снимает TS-типы и восстанавливает исходную форму import/export. */
function stripTypes(source, file) {
  const code = loadEsbuild().transformSync(source, {
    loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    target: 'es2020',
    sourcefile: file,
  }).code;

  const named = [];
  const defaults = [];
  const body = code.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, function (line, list) {
    list.split(',').forEach(function (part) {
      // Блок у esbuild многострочный — элементы разделены переводами строк.
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part.trim());
      if (!m) return;
      const local = m[1];
      const exported = m[2] || local;
      if (exported === 'default') defaults.push(local);
      else named.push({ local: local, exported: exported });
    });
    return '';
  });

  let out = body;
  named.forEach(function (e) {
    if (e.exported !== e.local) return;
    const decl = new RegExp('^((?:' + DECL_KEYWORDS + ')\\s+)' + e.local + '\\b', 'm');
    if (!decl.test(out)) return;
    out = out.replace(decl, 'export $1' + e.local);
  });
  // Алиасы: отдаём обычным export-блоком — его снимают оба хелпера.
  const aliased = named.filter(function (e) {
    return e.exported !== e.local;
  });
  if (aliased.length) {
    out += '\nexport {' + aliased
      .map(function (e) {
        return e.local + ' as ' + e.exported;
      })
      .join(', ') + '};\n';
  }
  if (defaults.length) out += '\nexport default ' + defaults[0] + ';\n';
  return out;
}

/** Исходник файла; для `.ts`/`.tsx` — уже без типов. */
function readModuleSource(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (!/\.tsx?$/.test(file)) return source;
  return stripTypes(source, file);
}

module.exports = { readModuleSource, stripTypes, loadEsbuild };
