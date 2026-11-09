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

/**
 * Отделяет UMD-хвост классического скрипта от тела (adapters/*.ts).
 *
 * Адаптеры остаются classic-скриптами и заканчиваются блоком
 * `if (typeof module !== 'undefined' && module.exports) { module.exports = X; }`.
 * Для esbuild это признак CommonJS: в формате esm он оборачивает ВЕСЬ файл в
 * `var require_x = __commonJS(...)` и добавляет `export default require_x();`.
 * В песочнице `new Function` такой `export` не парсится («Unexpected token
 * 'export'»), а обёртка __commonJS ломает общую лексическую область, на которой
 * держится наследование адаптеров от BaseAdapter.
 *
 * Поэтому хвост на время транспиляции откладывается и возвращается как был:
 * типы снимаются с тела, CJS-хвост остаётся последним блоком файла и дальше
 * снимается вызывающим (stripCjsTail в tests/helpers/adapter-harness.js).
 */
function splitCjsTail(source) {
  const at = source.lastIndexOf("\nif (typeof module");
  if (at === -1) return { head: source, tail: '' };
  const tail = source.slice(at);
  if (tail.indexOf('module.exports') === -1) return { head: source, tail: '' };
  return { head: source.slice(0, at + 1), tail: tail.slice(1) };
}

/**
 * UMD-хвост ВНУТРИ IIFE (`(function () { ... module.exports = Api; })();` в
 * core/base-handler.ts и др.) splitCjsTail не отделяет — он ищет только
 * top-level `\nif (typeof module`. Для таких classic-скриптов esbuild принимает
 * `module` за CommonJS и оборачивает файл в __commonJS с `export default` — такой
 * текст не парсится в `new Function`. Поэтому типы снимает TypeScript-API
 * (stripTypesKeepComments): он сохраняет комментарии, исходную форму и UMD-хвост.
 */
const INDENTED_UMD = /^[ \t]+if \(typeof module !== 'undefined' && module\.exports\)/m;

/** Снимает TS-типы и восстанавливает исходную форму import/export. */
function stripTypes(source, file) {
  if (INDENTED_UMD.test(source)) return stripTypesKeepComments(source, file);
  const parts = splitCjsTail(source);
  const code = loadEsbuild().transformSync(parts.head, {
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
  return out + (parts.tail ? '\n' + parts.tail : '');
}

let typescriptApi = null;

/** Загружает TypeScript один раз (уже в devDependencies — новых зависимостей нет). */
function loadTypescript() {
  if (!typescriptApi) typescriptApi = require('typescript');
  return typescriptApi;
}

/**
 * Снимает TS-типы, СОХРАНЯЯ комментарии и исходную форму кода.
 *
 * Нужен source-level пин-тестам: они ищут в исходнике и код (`let netQwenUsage = null;`),
 * и комментарии («систематичен»), а esbuild комментарии выбрасывает. `ts.transpileModule`
 * с `removeComments: false` оставляет их на месте; аннотации при этом удаляются, поэтому
 * текст остаётся исполняемым в `new Function` и совпадает с прежней (до миграции) формой:
 * `let x: Type = v;` → `let x = v;`, `fn(a: T)` → `fn(a)`, `as T` и `<T>q` — снимаются.
 *
 * Модульный формат не меняется (ESNext): UMD-хвост `module.exports = Api` остаётся как был,
 * а `import`/`export` (если появятся) не превращаются в `require`.
 */
function stripTypesKeepComments(source, file) {
  const ts = loadTypescript();
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2020,
    true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const cuts = [];
  const statements = [];
  function cut(start, end) {
    if (end > start) cuts.push([start, end]);
  }
  function isFunctionWithReturnType(node) {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    );
  }
  function visit(node) {
    // Типы/интерфейсы — чисто декларативные блоки: вырезаем целиком вместе с переводом строки.
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      let end = node.end;
      while (source[end] === '\r' || source[end] === '\n') end += 1;
      // От fullStart: вместе с JSDoc-комментариями над объявлением (они — trivia).
      statements.push([node.getFullStart(), end]);
      return;
    }
    if (ts.isVariableDeclaration(node) && node.type) {
      cut(node.name.end, node.type.end);
    }
    if (ts.isParameter(node)) {
      if (node.questionToken) cut(node.name.end, node.type ? node.type.end : node.questionToken.end);
      else if (node.type) cut(node.name.end, node.type.end);
    }
    if (isFunctionWithReturnType(node) && node.type) {
      // Двоеточие перед типом возврата не входит в узел типа — идём назад до него.
      let from = node.type.getStart(sf);
      while (from > 0 && source[from] !== ':') from -= 1;
      cut(from, node.type.end);
    }
    if (ts.isAsExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))) {
      cut(node.expression.end, node.end);
    }
    if (ts.isTypeAssertionExpression(node)) {
      cut(node.getStart(sf), node.expression.getStart(sf));
    }
    if (ts.isNonNullExpression(node)) {
      cut(node.expression.end, node.end);
    }
    const typeArgs = node.typeArguments;
    if (typeArgs && typeArgs.length) {
      const owner = node.expression || node.tag;
      let listEnd = typeof typeArgs.end === 'number'
        ? typeArgs.end
        : typeArgs[typeArgs.length - 1].end;
      // Закрывающая `>` в NodeArray.end не входит — снимаем её отдельно.
      if (source[listEnd] === '>') listEnd += 1;
      if (owner) cut(owner.end, listEnd);
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);

  function mergePlain(ranges) {
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    const merged = [];
    ranges.forEach(function (range) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    });
    return merged;
  }

  // Аннотации вырезаются «в никуда», декларативные блоки — целиком, оставляя перевод строки,
  // чтобы соседние строки не склеились.
  const edits = mergePlain(cuts)
    .map(function (r) { return [r[0], r[1], '']; })
    .concat(mergePlain(statements).map(function (r) { return [r[0], r[1], '\n']; }));
  edits.sort(function (a, b) { return b[0] - a[0]; });
  let out = source;
  edits.forEach(function (e) {
    out = out.slice(0, e[0]) + e[2] + out.slice(e[1]);
  });
  return out;
}

/** Исходник файла; для `.ts`/`.tsx` — уже без типов. */
function readModuleSource(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (!/\.tsx?$/.test(file)) return source;
  return stripTypes(source, file);
}

module.exports = { readModuleSource, stripTypes, stripTypesKeepComments, loadEsbuild };
