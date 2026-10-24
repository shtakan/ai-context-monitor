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

/**
 * Срезает комментарии (строчные — до конца строки, и блочные) из исходника, НЕ трогая
 * содержимое строковых литералов. Нужен замку №2 (см. ниже): он ищет ВЫЗОВЫ
 * `aiCm*(` текстово, и упоминание имени в комментарии — не вызов. Живой случай:
 * adapters/google-search-adapter.js:206 — фраза «Гейт — aiCm…» внутри комментария,
 * из-за которой адаптер отказывался грузиться (Plan §«google-search»).
 *
 * Посимвольный проход, а не regex: наивный `replace(/\/\/.*$/gm, …)` режет строки со
 * слешами (`'https://…'`, `'a//b'`) и может съесть реальный вызов на той же строке —
 * тогда замок ослепнет (ложноотрицательный результат вместо ложноположительного).
 * Переносы строк в блочном комментарии сохраняются, чтобы номера строк не съезжали.
 */
function stripComments(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  while (i < s.length) {
    const c = s.charAt(i);
    const c2 = s.charAt(i + 1);
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && c2 === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += c2; i += 2; continue; }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '/' && c2 === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && c2 === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
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

/**
 * Блочные теги: на их границах `innerText` ставит перевод строки — как в браузере и как
 * это делает структурный фолбэк `_innerTextFallback` (adapters/qwen-adapter.js:227-252).
 * Набор совпадает с `QWEN_BLOCK_TAGS` того же файла: тест обязан проверять ту же
 * семантику текста, что увидит пользователь, иначе пины многострочности ничего не стоят.
 */
const INNER_TEXT_BLOCK_TAGS = {
  ADDRESS: true, ARTICLE: true, ASIDE: true, BLOCKQUOTE: true, DD: true, DETAILS: true,
  DIALOG: true, DIV: true, DL: true, DT: true, FIELDSET: true, FIGCAPTION: true,
  FIGURE: true, FOOTER: true, FORM: true, H1: true, H2: true, H3: true, H4: true,
  H5: true, H6: true, HEADER: true, HR: true, LI: true, MAIN: true, NAV: true,
  OL: true, P: true, PRE: true, SECTION: true, TABLE: true, TD: true, TH: true,
  TR: true, UL: true
};

/**
 * Отрисовка текста в семантике браузерного `innerText` (без CSS-видимости и схлопывания
 * пробелов — они тестам не нужны): текст-узлы как есть, `<br>` → '\n', границы блочных
 * элементов и комментарии-маркеры снятых узлов (`ai-cm-qwen-cut`,
 * adapters/qwen-adapter.js: `_removeKeepingCut`) → '\n'. Крайние '\n' срезаются, чтобы
 * для плоского текста `innerText === textContent` (это и проверяет харнесс-тест).
 *
 * ПОЧЕМУ НЕ `return this.textContent`: у реплик Qwen каждая строка ответа — отдельный
 * `<p>`, и `textContent` склеивает их без переводов строк. Тогда `_readableText` получил бы
 * схлопнутый текст и покраснели бы честные пины многострочности (contract-qwen Q5,
 * tests/qwen-adapter.test.js Д2/Д4/Д5/Д7) — то есть тест перестал бы проверять ровно тот
 * дефект (`textContent` терял строки), ради которого адаптер и написан.
 *
 * @param {object} root узел (элемент песочницы или реального jsdom-document)
 * @returns {string}
 */
function renderInnerText(root) {
  let out = '';
  function boundary() {
    if (out.length > 0 && out.charAt(out.length - 1) !== '\n') out += '\n';
  }
  function walk(node) {
    if (!node) return;
    const type = node.nodeType;
    if (type === 3) { out += node.nodeValue == null ? '' : String(node.nodeValue); return; }
    if (type === 8) { boundary(); return; }
    if (type !== 1) return;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'BR') { out += '\n'; return; }
    const block = INNER_TEXT_BLOCK_TAGS[tag] === true;
    if (block) boundary();
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
    if (block) boundary();
  }
  walk(root);
  return out.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** Геттер `innerText` для прототипа: у заглушки детей нет — отдаём её `textContent`. */
function innerTextGetter() {
  const kids = this.childNodes;
  if (!kids || kids.length === 0) {
    return typeof this.textContent === 'string' ? this.textContent : '';
  }
  return renderInnerText(this);
}

/**
 * Патч `innerText` для jsdom (residual v90 §4 п.2 / v101 §4 п.4).
 *
 * jsdom не реализует `HTMLElement.prototype.innerText` (jsdom идёт без раскладки), поэтому
 * адаптеры уходят в структурный фолбэк. Патч ставит браузероподобный геттер на прототип
 * `win.HTMLElement`; если `innerText` уже есть (нативный или поставленный раньше) — не
 * перетирает его.
 *
 * @param {object} win окно (`sandbox.window` либо `document.defaultView`)
 * @returns {boolean} true — `innerText` доступен на прототипе после вызова
 */
function patchInnerText(win) {
  if (!win || !win.HTMLElement || !win.HTMLElement.prototype) return false;
  const proto = win.HTMLElement.prototype;
  if (!('innerText' in proto)) {
    Object.defineProperty(proto, 'innerText', {
      get: innerTextGetter,
      configurable: true
    });
  }
  return 'innerText' in proto;
}

function createSandbox(options) {
  const opts = options || {};
  const errors = [];
  const called = Object.create(null);
  const notes = [];

  /** Класс-заглушка песочницы: даёт `window.HTMLElement`, чтобы `patchInnerText` было на что встать. */
  function SandboxHTMLElement() { this.textContent = ''; }
  const elementStub = new SandboxHTMLElement();
  const documentStub = {
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return new SandboxHTMLElement(); },
    body: elementStub,
    documentElement: elementStub
  };
  const locationStub = { hostname: 'localhost', pathname: '/', href: 'http://localhost/' };
  const win = { location: opts.location || locationStub, HTMLElement: SandboxHTMLElement };
  notes.push({ innerTextPatched: patchInnerText(win) });
  // Настоящий jsdom: элементы приходят из ИНЪЕКТИРОВАННОГО `document`, прототип заглушки
  // им не виден, поэтому патчим окно этого документа (иначе адаптер так и читал бы через
  // структурный фолбэк, а свойство в песочнице стояло бы мёртвым грузом).
  const docView = opts.document && /** @type {any} */ (opts.document).defaultView;
  notes.push({ innerTextViewPatched: docView ? patchInnerText(docView) : false });

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
    // Комментарии срезаем ДО скана: упоминание aiCm*-имени в комментарии — не вызов
    // (иначе адаптер с таким упоминанием не грузится вовсе — см. stripComments).
    const src = stripComments(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
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
