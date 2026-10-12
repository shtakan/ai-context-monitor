/**
 * §п.8-A: ЛОАДЕР АДАПТЕРОВ В ПЕСОЧНИЦУ (обобщение tests/qwen-adapter.test.js:40-51).
 *
 * Назначение. Контрактные тесты adapters/*.js и core|utils-парсеров Gemini должны
 * исполнять ТОТ ЖЕ исходник, что уезжает в бандл, но без браузера. Мини-песочница
 * `new Function(...)`: адаптер получает инъекции (document/location/debugLog/console/
 * window/module/require + хелперы aiCm*), а класс/API возвращается наружу.
 *
 * ЧЕСТНОСТЬ ЗАГЛУШЕК. Заглушки — минимальные и тихие, поэтому «проглоченная» ошибка
 * молча сделала бы контрактные пины зелёными и бессмысленными. Отсюда три замка:
 *   1. swallow(e, where) НЕ глотает: пишет в sandbox.errors и ПЕРЕБРАСЫВАЕТ (fail loud);
 *   2. любой aiCm*-хелпер, который адаптер вызывает и которого нет в песочнице, падает
 *      явной ошибкой со списком имён (а не тихо деградирует через typeof-гард);
 *   3. sandbox.called фиксирует, какие заглушки реально дёргались, — тест может
 *      потребовать, чтобы диагностический путь НЕ был пройден «вслепую».
 *
 * Экспорт: { loadAdapter, loadSource, REPO_ROOT }
 *   loadAdapter(adapterFile, options?) → { Adapter, Ctor, sandbox }
 *   loadSource(file, options?)         → { sandbox, value, ctor }
 *
 * options: { baseFile='adapters/base-adapter.js', document, location, returnExpr, exportsName, strict }
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Хелперы, которые адаптеры/core зовут через typeof-гард. Все обязаны существовать. */
const HELPER_NAMES = [
  'aiCmDiagWarn',
  'aiCmDiagOn',
  'aiCmDiagLine',
  'aiCmDropContainerMessages',
  'aiCmContainerRules',
  'aiCmIncludeHiddenInExport',
  'aiCmQwenSpaReshoot',
  'aiCmDiagDownload',
  'aiCmDiagDownloadBlocked'
];

/**
 * Срезает CJS-хвост (`if (typeof module …) { module.exports = …; }`) целиком — вместе с телом
 * и закрывающей скобкой. Посрочный однострочный срез НЕ годится: у адаптеров условие и тело
 * лежат на разных строках, и остаётся висячий `module.exports = X;` + `}` от класса
 * (проверено: `Unexpected token '}'`). Якорь на строку обязателен: у utils/*.js внутри IIFE
 * есть собственный такой же guard, и срез «до конца файла» разрезал бы обёртку посередине
 * (проверено: `Unexpected end of input`).
 */
function stripCjsTail(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*if \(typeof module[^\n]*$/.test(lines[i])) { out.push(lines[i]); continue; }
    // Однострочная форма: `if (…) module.exports = X;` — тело на той же строке.
    if (!/\{[ \t]*\r?$/.test(lines[i])) continue;
    // Блочная форма: пропускаем тело до закрывающей `}` на нулевом отступе.
    i++;
    while (i < lines.length && !/^[ \t]*\}[ \t]*\r?$/.test(lines[i])) i++;
    // i указывает на `}` (либо на конец файла) — её тоже не выводим.
  }
  return out.join('\n');
}

/** Все aiCm*-имена, которые где-то ВЫЗЫВАЮТ (для замка №2). */
function aiCmNamesIn(src) {
  const found = new Set();
  // `.aiCmFoo(` исключаем: это обращение к свойству объекта, а не к глобальному хелперу.
  const re = /(^|[^.\w$])(aiCm[A-Za-z0-9_$]*)[ \t]*\(/g;
  let m;
  while ((m = re.exec(src))) found.add(m[2]);
  return Array.from(found);
}

/** aiCm*-имена, ОБЪЯВЛЕННЫЕ внутри загружаемых файлов (function/const/let/var). */
function aiCmNamesDeclared(src) {
  const found = new Set();
  const re = /\b(?:function|const|let|var)[ \t]+(aiCm[A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re.exec(src))) found.add(m[1]);
  return Array.from(found);
}

function relKey(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/** Вырезает require('./local') — файл всё равно въезжает отдельным чанком выше по стеку. */
function dropLocalRequires(src) {
  return src.replace(/require\((['"])(\.[^'"]*)\1\)/g, 'void 0');
}

function collectFiles(file, seen, all) {
  const abs = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
  const key = relKey(abs);
  if (seen.has(key)) return '';
  seen.add(key);
  if (all) all.push(key);
  const src = stripCjsTail(fs.readFileSync(abs, 'utf8'));
  const dir = path.dirname(abs);
  const deps = [];
  const re = /require\((['"])([^'"]+)\1\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[2].charAt(0) !== '.') continue; // bare-модули (util и т.п.) отдаёт node
    const dep = relKey(path.resolve(dir, m[2]));
    if (seen.has(dep)) continue;
    deps.push(collectFiles(path.join(REPO_ROOT, dep), seen, all));
  }
  // Локальные require НЕ вырезаем: их отдаёт sandbox.require (как в проде), а сам файл
  // остаётся в глобальной области — иначе window.AiCmExportBuilders не долетел бы до адаптера.
  return deps.join('\n') + src;
}

function createSandbox(options) {
  const opts = options || {};
  const errors = [];
  const called = Object.create(null);
  const notes = [];

  const elementStub = {};
  const documentStub = {
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return elementStub; },
    body: elementStub,
    documentElement: elementStub
  };
  const locationStub = { hostname: 'localhost', pathname: '/', href: 'http://localhost/' };
  const win = { location: opts.location || locationStub };

  const debugLog = function debugLogNoop() { };

  function mark(name) {
    called[name] = (called[name] || 0) + 1;
    return called[name];
  }
  /** Единственный «глотающий» хелпер, который НЕ должен молчать: пишем и бросаем. */
  function swallowAndRethrow(e, where) {
    mark('swallow');
    errors.push({ where: String(where || 'unknown'), error: e });
    throw e;
  }
  function swallowSoftRecorder(e, where) {
    mark('swallowSoft');
    errors.push({ where: String(where || 'unknown'), soft: true, error: e });
    return undefined;
  }

  const sandbox = {
    document: opts.document || documentStub,
    location: opts.location || locationStub,
    debugLog: debugLog,
    console: console,
    swallow: swallowAndRethrow,
    swallowSoft: swallowSoftRecorder,
    aiCmDiagWarn: function () { mark('aiCmDiagWarn'); },
    aiCmDiagOn: function () { mark('aiCmDiagOn'); return false; },
    aiCmDiagLine: function () { mark('aiCmDiagLine'); },
    aiCmDropContainerMessages: function (list) { mark('aiCmDropContainerMessages'); return list; },
    aiCmContainerRules: function () { mark('aiCmContainerRules'); return []; },
    aiCmIncludeHiddenInExport: function () { mark('aiCmIncludeHiddenInExport'); return false; },
    aiCmQwenSpaReshoot: function () { mark('aiCmQwenSpaReshoot'); return false; },
    aiCmDiagDownload: function () { mark('aiCmDiagDownload'); },
    aiCmDiagDownloadBlocked: function () { mark('aiCmDiagDownloadBlocked'); },
    window: win,
    globalThis: win,
    errors: errors,
    called: called,
    notes: notes
  };
  return sandbox;
}

/**
 * Загружает исходники в песочницу и возвращает значение (`Adapter`/API/класс).
 * @param {(string|string[])} files файл(ы) от корня репозитория — в порядке склейки
 * @param {object} [options]
 */
function loadSource(files, options) {
  const opts = options || {};
  const list = Array.isArray(files) ? files : [files];
  const seen = new Set();
  const loaded = [];
  const code = list.map(function (f) { return collectFiles(f, seen, loaded); }).join('\n');
  const sandbox = createSandbox(opts);
  const returnExpr = opts.returnExpr !== undefined
    ? opts.returnExpr
    : (opts.exportsName !== undefined ? opts.exportsName : (opts.exportExpr !== undefined ? opts.exportExpr : 'module.exports'));

  const argNames = Object.keys(sandbox).concat(['module', 'exports', 'require']);
  const moduleObj = { exports: {} };
  const requireFn = function (id) {
    if (typeof id === 'string' && id.charAt(0) !== '.') return require(id);
    const abs = path.isAbsolute(id) ? id : path.resolve(REPO_ROOT, id);
    delete require.cache[require.resolve(abs)];
    return require(abs);
  };

  const argValues = Object.keys(sandbox).map(function (k) { return sandbox[k]; })
    .concat([moduleObj, moduleObj.exports, requireFn]);
  const args = argNames.concat(['\nreturn (' + returnExpr + ');\n']);
  const body = code + args.pop();

  let value;
  let ctor = null;
  try {
    // eslint-disable-next-line no-new-func
    if (process.env.AI_CM_HARNESS_DUMP) require('fs').writeFileSync(process.env.AI_CM_HARNESS_DUMP, body);
    ctor = Function.apply(null, args.concat([body]));
    value = ctor.apply(null, argValues);
  } catch (e) {
    throw new Error('[adapter-harness] сбой загрузки ' + list.join(' + ') + ': ' + (e && e.stack || e));
  }

  // Замок №2: любой aiCm*-хелпер из исходника обязан быть в песочнице, иначе адаптер
  // тихо пойдёт по деградированной ветке (typeof-гард) — контракт стал бы вакуумным.
  const called = new Set();
  const defined = new Set();
  loaded.forEach(function (f) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    aiCmNamesIn(src).forEach(function (n) { called.add(n); });
    aiCmNamesDeclared(src).forEach(function (n) { defined.add(n); });
  });
  const missing = Array.from(called).filter(function (n) { return !defined.has(n) && !(n in sandbox); });
  if (missing.length) {
    throw new Error('[adapter-harness] в исходнике есть aiCm*-хелперы без заглушки: ' + missing.join(', '));
  }

  return { sandbox: sandbox, value: value, ctor: ctor };
}

/**
 * Загружает адаптер: base-adapter.js первым (как в manifest.json), затем сам адаптер.
 * @param {string} adapterFile напр. 'adapters/qwen-adapter.js'
 * @param {object} [options] { baseFile, document, location, exportExpr, returnExpr, exportsName }
 * @returns {{Adapter: object, Ctor: Function, sandbox: object}} Adapter — экземпляр
 *
 * exportExpr — имя класса в песочнице ('QwenAdapter'), когда файлов несколько и
 * module.exports уже перезаписан базовым классом. Без него берётся module.exports.
 */
function loadAdapter(adapterFile, options) {
  const opts = options || {};
  const baseFile = opts.baseFile || 'adapters/base-adapter.js';
  const res = loadSource([baseFile, adapterFile], {
    document: opts.document,
    location: opts.location,
    returnExpr: opts.returnExpr,
    exportsName: opts.exportsName,
    exportExpr: opts.exportExpr,
    strict: opts.strict
  });
  const Ctor = res.value;
  if (typeof Ctor !== 'function') {
    throw new Error('[adapter-harness] ' + adapterFile + ': экспорт не является классом/конструктором (' +
      typeof Ctor + ') — проверь хвост module.exports или верни returnExpr');
  }
  let Adapter;
  try {
    Adapter = new Ctor();
  } catch (e) {
    throw new Error('[adapter-harness] ' + adapterFile + ': конструктор упал: ' + (e && e.stack || e));
  }
  return { Adapter: Adapter, Ctor: Ctor, sandbox: res.sandbox };
}

module.exports = { loadAdapter: loadAdapter, loadSource: loadSource, REPO_ROOT: REPO_ROOT };
