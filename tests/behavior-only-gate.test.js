/**
 * Гейт правила 3 «Behavior-Only Tests» (v117 R2).
 *
 * Правило (PROJECT_HANDOFF.md, «Правила парсинга и приёмки», п. 3): тест не имеет
 * права читать исходный код продукта (`readFileSync` по `core/`, `utils/`,
 * `adapters/`, `options/`, `manifest.json`). Вход теста — дамп или фикстура,
 * выход — результат парсера. Тест, пиннящий имя ключа или форму строки, зеленеет
 * при сломанном поведении и краснеет при безобидном рефакторинге.
 *
 * Гейт не переписывает существующие пины (правило обратной силы не имеет): он
 * фиксирует их baseline в `tests/fixtures/behavior-gate-whitelist.json` и держит
 * ratchet в обе стороны.
 *
 *   (а) новый файл с чтением кода → FAIL (нет записи в whitelist);
 *   (б) count в файле БОЛЬШЕ baseline → FAIL (новая связка с исходником);
 *   (в) count в файле МЕНЬШЕ baseline → FAIL (burn-down: запись надо удалить
 *       или опустить count — иначе baseline перестаёт быть честным);
 *   (г) валидация whitelist: у каждой записи есть допустимая причина и count ≥ 1,
 *       файл существует, записей ровно столько, сколько реально читает код.
 *
 * Что считается «чтением кода»:
 *   1) `readFileSync(...)`, чей путь (после разрешения `const`-переменных,
 *      `path.join`/`path.resolve`, шаблонных строк, конкатенации, обёрток-хелперов
 *      вида `const read = (rel) => fs.readFileSync(abs(rel), 'utf8')`) указывает в
 *      `core/`, `utils/`, `adapters/`, `options/` или на `manifest.json`.
 *      Динамические хвосты пути (`path.join(ROOT, 'core', name)`) разрешаются до
 *      литерального префикса — каталог кода виден и без имени файла.
 *   2) `expect(<binding>).toContain(...)` / `.toMatch(...)` (и любой другой
 *      матчер) по переменной, значением которой является такой прочитанный
 *      исходник, — это и есть source-пин по форме строки.
 *
 * count записи whitelist = (число мест чтения кода) + (число expect по
 * source-переменным). Метрика детерминирована: комментарии вырезаются, порядок
 * обхода — сортировка путей.
 *
 * Сам гейт исходников не читает: он читает только JSON-фикстуру whitelist.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..');
const WHITELIST_PATH = path.join(__dirname, 'fixtures', 'behavior-gate-whitelist.json');

// Каталоги продукта и файл, чтение которых правилом 3 запрещено.
const CODE_DIRS = ['core', 'utils', 'adapters', 'options'];
const CODE_FILES = ['manifest.json'];
// Допустимые причины существования legacy-пина.
const REASONS = ['legacy-pin', 'vm-harness', 'static-linter'];

const ROOT_NORM = toPosix(REPO_ROOT);

// ---------------------------------------------------------------- утилиты путей

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function normalizePath(p) {
  const q = toPosix(p);
  const isDrive = /^[A-Za-z]:\//.test(q);
  const isAbs = q.startsWith('/') || isDrive;
  const parts = q.split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  if (isDrive) {
    const head = joined.split('/')[0].toUpperCase();
    return head + '/' + joined.split('/').slice(1).join('/');
  }
  if (isAbs) return '/' + joined;
  return joined;
}

function isCodePath(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  if (!candidate.includes('*') && !candidate.includes('/') && !candidate.includes('\\')) return false;
  const q = normalizePath(candidate);
  if (!q.startsWith(ROOT_NORM + '/')) return false;
  const rel = q.slice(ROOT_NORM.length + 1);
  if (CODE_FILES.indexOf(rel) !== -1) return true;
  const first = rel.split('/')[0];
  return CODE_DIRS.indexOf(first) !== -1;
}

// --------------------------------------------- разбор текста без сторонних парсеров

// Вырезает комментарии, сохраняя переводы строк и длину (номера строк не сдвигаются).
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i++; continue; }
      out += c;
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue; }
      out += ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    // внутри строки/шаблона
    if (c === '\\') { out += c + (d === undefined ? '' : d); i += 2; continue; }
    if (c === state) { state = 'code'; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function skipString(text, i) {
  const quote = text[i];
  i++;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function matchingParen(text, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i); continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; if (depth === 0) return i; i++; continue; }
    i++;
  }
  return -1;
}

function splitTopLevel(text, sepChar) {
  const out = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === sepChar) { out.push(text.slice(last, i)); last = i + 1; }
    i++;
  }
  out.push(text.slice(last));
  return out.map(function (s) { return s.trim(); });
}

function replaceWord(text, word, replacement) {
  if (!word) return text;
  const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
  return text.replace(re, replacement);
}

// Тело хелпера приводится к одному выражению: снимаются фигурные скобки и `return`.
function normalizeHelperBody(body) {
  let text = String(body).trim();
  while (text.startsWith('{') && findMatchingBrace(text, 0) === text.length - 1) {
    text = text.slice(1, -1).trim();
  }
  const ret = /\breturn\b/.exec(text);
  if (ret) {
    const start = ret.index + ret[0].length;
    const end = findStatementEnd(text, start);
    text = text.slice(start, end).trim();
  }
  return text;
}

function unquote(literal) {
  const body = literal.slice(1, -1);
  return body.replace(/\\(.)/g, '$1');
}

// Ищет конец инициализатора объявления: ';' на нулевой глубине.
function findStatementEnd(text, from) {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (c === ';' && depth === 0) return i;
    i++;
  }
  return text.length;
}

// --------------------------------------------------- разрешение путей по исходнику

function isPlainIdentifier(expr) {
  return /^[A-Za-z_$][\w$]*$/.test(expr);
}

function makeContext(fileAbs, text) {
  const ctx = {
    dir: toPosix(path.dirname(fileAbs)),
    file: toPosix(fileAbs),
    bindings: new Map(),
    helpers: new Map(),
    helperRanges: []
  };

  const clean = stripComments(text);

  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m;
  while ((m = declRe.exec(clean)) !== null) {
    const start = declRe.lastIndex;
    const end = findStatementEnd(clean, start);
    const init = clean.slice(start, end).trim();
    if (!ctx.bindings.has(m[1])) ctx.bindings.set(m[1], init);
    declRe.lastIndex = Math.max(declRe.lastIndex, start);
  }

  // function read(rel) { return fs.readFileSync(abs(rel), 'utf8'); }
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  while ((m = fnRe.exec(clean)) !== null) {
    const openBrace = clean.indexOf('{', m.index + m[0].length - 1);
    const closeBrace = findMatchingBrace(clean, openBrace);
    if (closeBrace < 0) continue;
    const body = normalizeHelperBody(clean.slice(openBrace + 1, closeBrace));
    ctx.helpers.set(m[1], {
      params: m[2].split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      body: body,
      start: openBrace,
      end: closeBrace
    });
  }

  // const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
  // const read = function (rel) { return fs.readFileSync(abs(rel), 'utf8'); };
  ctx.bindings.forEach(function (init, name) {
    const arrow = /^(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*([\s\S]+)$/.exec(init);
    if (arrow) {
      const params = (arrow[1] === undefined ? arrow[2] : arrow[1])
        .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!params.length) return;
      ctx.helpers.set(name, { params: params, body: normalizeHelperBody(arrow[3]), start: -1, end: -1 });
      return;
    }
    const fnExpr = /^(?:async\s+)?function\s*\*?\s*[A-Za-z_$]*\s*\(([^)]*)\)\s*\{([\s\S]*)\}\s*$/.exec(init);
    if (!fnExpr) return;
    const params = fnExpr[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!params.length) return;
    ctx.helpers.set(name, { params: params, body: normalizeHelperBody(fnExpr[2]), start: -1, end: -1 });
  });

  // Обёртки, которые читают файл: их вызовы считаются местом чтения, а тело — нет.
  ctx.helpers.forEach(function (helper, name) {
    const readCall = /readFileSync\s*\(/.exec(helper.body);
    if (!readCall) return;
    const open = readCall.index + readCall[0].length - 1;
    const close = matchingParen(helper.body, open);
    const argText = close > open ? helper.body.slice(open + 1, close) : '';
    const readsParam = helper.params.some(function (p) {
      return new RegExp('\\b' + p.replace(/\$/g, '\\$') + '\\b').test(argText);
    });
    helper.isReader = readsParam || !helper.params.length;
    if (helper.isReader && helper.start >= 0) ctx.helperRanges.push([helper.start, helper.end]);
    void name;
  });

  ctx.clean = clean;
  return ctx;
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i); continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; if (depth === 0) return i; i++; continue; }
    i++;
  }
  return -1;
}

function resolveExpr(expr, ctx, depth) {
  const level = depth || 0;
  if (level > 8) return '*';
  if (expr === undefined || expr === null) return '*';
  let e = String(expr).trim();
  if (!e) return '*';
  while (e.startsWith('(') && matchingParen(e, 0) === e.length - 1) {
    e = e.slice(1, -1).trim();
    if (!e) return '*';
  }

  // строковый литерал
  if (/^'(?:[^'\\]|\\.)*'$/.test(e) || /^"(?:[^"\\]|\\.)*"$/.test(e)) return unquote(e);

  // шаблонная строка: `${...}` разрешается, если известно, иначе '*'
  if (e[0] === '`') {
    let out = '';
    let i = 1;
    while (i < e.length - 1) {
      if (e[i] === '\\') { out += e[i + 1]; i += 2; continue; }
      if (e[i] === '$' && e[i + 1] === '{') {
        const close = findMatchingBrace(e, i + 1);
        if (close < 0) { out += '*'; i = e.length; break; }
        out += resolveExpr(e.slice(i + 2, close), ctx, level + 1);
        i = close + 1;
        continue;
      }
      out += e[i];
      i++;
    }
    return out;
  }

  if (e === '__dirname') return ctx.dir;
  if (e === '__filename') return ctx.file;

  // конкатенация строками
  const plus = splitTopLevel(e, '+');
  if (plus.length > 1) {
    return plus.map(function (part) { return resolveExpr(part, ctx, level + 1); }).join('');
  }

  // вызов функции
  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(e);
  if (call) {
    const open = e.indexOf('(', call[1].length);
    const close = matchingParen(e, open);
    if (close === e.length - 1) {
      const name = call[1];
      const args = splitTopLevel(e.slice(open + 1, close), ',');
      if (/(^|\.)(join|resolve|normalize|dirname)$/.test(name) && /join|resolve/.test(name)) {
        return normalizePath(args.map(function (a) { return resolveExpr(a, ctx, level + 1); }).join('/'));
      }
      const helper = ctx.helpers.get(name) || ctx.helpers.get(name.replace(/^.*\./, ''));
      if (helper && !helper.isReader) {
        let body = helper.body;
        helper.params.forEach(function (p, idx) {
          const arg = args[idx] === undefined ? 'undefined' : args[idx];
          body = replaceWord(body, p, '(' + arg + ')');
        });
        return resolveExpr(body, ctx, level + 1);
      }
      return literalFallback(args.join(','), ctx, level);
    }
  }

  if (isPlainIdentifier(e)) {
    if (ctx.bindings.has(e)) return resolveExpr(ctx.bindings.get(e), ctx, level + 1);
    return '*';
  }

  return literalFallback(e, ctx, level);
}

// Последний шанс: склеить литералы из выражения, пометив неизвестное как '*'.
function literalFallback(expr, ctx, depth) {
  void ctx;
  void depth;
  const parts = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let m;
  let last = 0;
  while ((m = re.exec(expr)) !== null) {
    if (m.index > last) parts.push('*');
    parts.push(unescapeLiteral(m[1] !== undefined ? m[1] : m[2]));
    last = re.lastIndex;
  }
  if (!parts.length) return '*';
  if (last < expr.length) parts.push('*');
  return parts.join('');
}

function unescapeLiteral(body) {
  return body.replace(/\\(.)/g, '$1');
}

// --------------------------------------------------------------- скан одного файла

function findReadSites(ctx) {
  const sites = [];
  const helperCalls = [];

  ctx.helpers.forEach(function (helper, name) {
    if (!helper.isReader) return;
    const re = new RegExp('\\b' + name.replace(/[$]/g, '\\$&') + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(ctx.clean)) !== null) {
      if (m.index >= 1 && ctx.clean[m.index - 1] === '.') continue; // метод, не наш хелпер
      if (helper.start >= 0 && m.index >= helper.start && m.index <= helper.end) continue;
      const open = m.index + m[0].length - 1;
      const close = matchingParen(ctx.clean, open);
      if (close < 0) continue;
      const args = splitTopLevel(ctx.clean.slice(open + 1, close), ',');
      if (!args.length || args[0] === '') continue;
      helperCalls.push({ name: name, arg: args[0], index: m.index, helper: helper });
    }
  });

  helperCalls.forEach(function (call) {
    let resolved;
    if (!call.helper.params.length) {
      resolved = resolveExpr(call.helper.body, ctx, 0);
      // тело обёртки без параметров: ищем аргумент readFileSync
      const readArg = /readFileSync\s*\(/.exec(call.helper.body);
      if (readArg) {
        const open = readArg.index + readArg[0].length - 1;
        const close = matchingParen(call.helper.body, open);
        if (close > open) resolved = resolveExpr(call.helper.body.slice(open + 1, close), ctx, 0);
      }
    } else {
      const body = call.helper.body;
      const readArg = /readFileSync\s*\(/.exec(body);
      if (!readArg) return;
      const open = readArg.index + readArg[0].length - 1;
      const close = matchingParen(body, open);
      if (close < 0) return;
      const argExpr = body.slice(open + 1, close);
      const pieces = splitTopLevel(argExpr, ',');
      const first = pieces[0];
      let exprText = first;
      call.helper.params.forEach(function (p, idx) {
        const args = splitTopLevel(call.arg, ',');
        const raw = idx === 0 ? call.arg : (args[idx] === undefined ? 'undefined' : args[idx]);
        exprText = replaceWord(exprText, p, '(' + raw + ')');
      });
      resolved = resolveExpr(exprText, ctx, 0);
    }
    const code = isCodePath(resolved);
    if (code) sites.push({ index: call.index, resolved: resolved });
  });

  const readRe = /(?:fs\s*\.\s*)?readFileSync\s*\(/g;
  let rm;
  while ((rm = readRe.exec(ctx.clean)) !== null) {
    const open = rm.index + rm[0].length - 1;
    const inHelper = ctx.helperRanges.some(function (r) { return rm.index >= r[0] && rm.index <= r[1]; });
    if (inHelper) continue;
    const close = matchingParen(ctx.clean, open);
    if (close < 0) continue;
    const args = splitTopLevel(ctx.clean.slice(open + 1, close), ',');
    if (!args.length || !args[0]) continue;
    const resolved = resolveExpr(args[0], ctx, 0);
    if (isCodePath(resolved)) sites.push({ index: rm.index, resolved: resolved });
  }

  return sites;
}

function collectCodeSourceVars(ctx, sites) {
  const vars = new Set();
  ctx.bindings.forEach(function (init, name) {
    const trimmed = init.trim();
    // прямое чтение: const SRC = fs.readFileSync(...)
    if (/readFileSync\s*\(/.test(trimmed)) {
      const readArg = /readFileSync\s*\(/.exec(trimmed);
      const open = readArg.index + readArg[0].length - 1;
      const close = matchingParen(trimmed, open);
      if (close > open) {
        const arg = splitTopLevel(trimmed.slice(open + 1, close), ',')[0];
        if (isCodePath(resolveExpr(arg, ctx, 0))) vars.add(name);
      }
      return;
    }
    // чтение через обёртку: const SRC = read('core/x.js')
    const call = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(trimmed);
    if (!call) return;
    const helper = ctx.helpers.get(call[1]);
    if (!helper || !helper.isReader) return;
    let argExpr = splitTopLevel(call[2], ',')[0];
    if (helper.params.length) {
      helper.params.forEach(function (p, idx) {
        const args = splitTopLevel(call[2], ',');
        const raw = idx === 0 ? argExpr : (args[idx] === undefined ? 'undefined' : args[idx]);
        argExpr = replaceWord(argExpr, p, '(' + raw + ')');
      });
    }
    const readArg = /readFileSync\s*\(/.exec(helper.body);
    if (!readArg) return;
    const open = readArg.index + readArg[0].length - 1;
    const close = matchingParen(helper.body, open);
    if (close < 0) return;
    const inner = splitTopLevel(helper.body.slice(open + 1, close), ',')[0];
    let exprText = inner;
    helper.params.forEach(function (p, idx) {
      const args = splitTopLevel(call[2], ',');
      const raw = idx === 0 ? argExpr : (args[idx] === undefined ? 'undefined' : args[idx]);
      exprText = replaceWord(exprText, p, '(' + raw + ')');
    });
    if (isCodePath(resolveExpr(exprText, ctx, 0))) vars.add(name);
    void sites;
  });
  return vars;
}

function countSourceAssertions(ctx, codeSrcVars) {
  const hits = [];
  if (!codeSrcVars.size) return hits;
  const re = /\bexpect\s*\(/g;
  let m;
  while ((m = re.exec(ctx.clean)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(ctx.clean, open);
    if (close < 0) continue;
    const receiver = ctx.clean.slice(open + 1, close);
    // корневой идентификатор приёмника: SRC, SRC.slice(...), String(SRC), !SRC
    const rootMatch = /(?:[A-Za-z_$][\w$]*)/.exec(receiver.replace(/^[\s!(]+/, ''));
    if (!rootMatch) continue;
    let root = rootMatch[0];
    if (/^(?:String|Number|Boolean|JSON|Object|Array)$/.test(root)) {
      const inner = /\(\s*([A-Za-z_$][\w$]*)/.exec(receiver);
      if (!inner) continue;
      root = inner[1];
    }
    if (codeSrcVars.has(root)) hits.push({ index: m.index, root: root });
  }
  return hits;
}

function scanFileText(text, fileAbs) {
  const ctx = makeContext(fileAbs, text);
  const sites = findReadSites(ctx);
  const codeSrcVars = collectCodeSourceVars(ctx, sites);
  const asserts = countSourceAssertions(ctx, codeSrcVars);
  return {
    count: sites.length + asserts.length,
    reads: sites.length,
    asserts: asserts.length
  };
}

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.js$/.test(entry.name)) continue;
    out.push(abs);
  }
  return out;
}

function relativeKey(fileAbs) {
  return toPosix(path.relative(REPO_ROOT, fileAbs));
}

function scanTests() {
  const files = walk(TESTS_DIR, []).sort();
  const found = new Map();
  for (let i = 0; i < files.length; i++) {
    const abs = files[i];
    if (path.normalize(abs) === path.normalize(WHITELIST_PATH)) continue;
    // Правило 3 покрывает тест-файлы и helpers/: остальные .js (setup, fixtures,
    // mocks) не являются пинами и в baseline не попадают.
    const isTestFile = /\.test\.js$/.test(abs);
    const isHelperFile = /[\\/]helpers[\\/]/.test(abs);
    if (!isTestFile && !isHelperFile) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const result = scanFileText(text, abs);
    if (result.count > 0) found.set(relativeKey(abs), result);
  }
  return found;
}

// ---------------------------------------------------------------------- baseline

function loadWhitelist() {
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
}

function formatList(items) {
  return items.length ? '\n  - ' + items.join('\n  - ') : '';
}

// Тесты регистрируются только под jest: файл экспортирует скан для генератора
// baseline (tools-скрипт запускается обычным Node).
if (typeof describe === 'function' && typeof test === 'function') {
  describe('rule 3 - Behavior-Only Tests gate (v117 R2)', function () {
    let whitelist;
    let found;

    beforeAll(function () {
      whitelist = loadWhitelist();
      found = scanTests();
    });

    test('baseline whitelist is well-formed (reason + count)', function () {
      expect(typeof whitelist).toBe('object');
      expect(Array.isArray(whitelist)).toBe(false);
      const keys = Object.keys(whitelist);
      expect(keys.length).toBeGreaterThan(0);
      const problems = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const entry = whitelist[key];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          problems.push(key + ': запись должна быть объектом { count, reason }');
          continue;
        }
        if (REASONS.indexOf(entry.reason) === -1) {
          problems.push(key + ': reason="' + String(entry.reason) + '" вне ' + REASONS.join('|'));
        }
        if (!Number.isInteger(entry.count) || entry.count < 1) {
          problems.push(key + ': count должен быть целым ≥ 1, получено ' + String(entry.count));
        }
        if (key.indexOf('\\') !== -1) {
          problems.push(key + ': путь должен быть в posix-форме');
        }
        if (!/\.test\.js$|\.js$/.test(key)) {
          problems.push(key + ': запись не похожа на js-файл теста');
        }
        if (!fs.existsSync(path.join(REPO_ROOT, key))) {
          problems.push(key + ': файла нет в дереве (удалите запись)');
        }
      }
      expect(problems).toEqual([]);
      expect(keys.length).toBe(Object.keys(whitelist).length);
    });

    test('(a) no new test file reads product source outside the baseline', function () {
      const offenders = [];
      found.forEach(function (result, rel) {
        if (!Object.prototype.hasOwnProperty.call(whitelist, rel)) {
          offenders.push(rel + ' (count=' + result.count + ': reads=' + result.reads + ', asserts=' + result.asserts + ')');
        }
      });
      if (offenders.length) {
        throw new Error(
          'Правило 3 (Behavior-Only Tests): новый тест читает исходный код продукта.' +
          ' Перепишите тест на поведении (фикстура → результат) либо, только для legacy, добавьте запись в ' +
          'tests/fixtures/behavior-gate-whitelist.json с причиной.' + formatList(offenders.sort())
        );
      }
      expect(offenders).toEqual([]);
    });

    test('(b) no file exceeds its whitelisted count', function () {
      const offenders = [];
      Object.keys(whitelist).forEach(function (rel) {
        const base = whitelist[rel];
        const result = found.get(rel);
        if (!result) return; // отловлено тестом (в) как burn-down
        if (result.count > base.count) {
          offenders.push(rel + ': ' + result.count + ' > baseline ' + base.count +
            ' (reads=' + result.reads + ', asserts=' + result.asserts + ')');
        }
      });
      if (offenders.length) {
        throw new Error(
          'Правило 3: число source-пинов выросло сверх baseline. Уберите новые чтения исходника;' +
          ' если они неизбежны — отдельным осознанным коммитом поднимите count в whitelist.' + formatList(offenders.sort())
        );
      }
      expect(offenders).toEqual([]);
    });

    test('(c) no file falls below its whitelisted count (burn-down ratchet)', function () {
      const offenders = [];
      Object.keys(whitelist).forEach(function (rel) {
        const base = whitelist[rel];
        const result = found.get(rel);
        if (!result) {
          offenders.push(rel + ': чтения кода больше нет — удалите запись из whitelist (было ' + base.count + ')');
          return;
        }
        if (result.count < base.count) {
          offenders.push(rel + ': ' + result.count + ' < baseline ' + base.count +
            ' — опустите count до ' + result.count + ' или удалите запись (burn-down)');
        }
      });
      if (offenders.length) {
        throw new Error(
          'Правило 3: baseline рассинхронизирован с деревом (burn-down).' +
          ' Whitelist обязан отражать текущее число source-пинов, иначе ratchet не работает.' + formatList(offenders.sort())
        );
      }
      expect(offenders).toEqual([]);
    });

    test('(d) scan is not vacuous: baseline covers every code-reading test', function () {
      expect(found.size).toBeGreaterThan(0);
      expect(found.size).toBe(Object.keys(whitelist).length);
    });

    test('(e) the gate itself does not read product source', function () {
      const self = scanFileText(fs.readFileSync(__filename, 'utf8'), __filename);
      expect(self.count).toBe(0);
    });
  });
}

module.exports = {
  scanTests: scanTests,
  scanFileText: scanFileText,
  isCodePath: isCodePath,
  normalizePath: normalizePath,
  WHITELIST_PATH: WHITELIST_PATH,
  REPO_ROOT: REPO_ROOT,
  CODE_DIRS: CODE_DIRS,
  REASONS: REASONS
};
