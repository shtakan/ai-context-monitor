/**
 * Задача 1.9 (финальный пин): запрет bare `console.error(...)` в production-исходниках.
 *
 * Контракт проекта: единственная точка вывода — обёртка `debugLog(level, ...)`
 * (utils/debug.js): 'error'/'warn' печатаются всегда, 'log'/'info'/'debug' — под флагом
 * «Подробные логи». Прямой `console.error` обходит и ring-буфер, и единый формат строк,
 * поэтому здесь — source-level пин против рецидива.
 *
 * Сканируются ЛЕКСЕРОМ только production-исходники core/ и adapters/:
 *   - комментарии (// и /* ... *\/) игнорируются;
 *   - строковые литералы ('...', "...", `...`) игнорируются;
 *   - содержимое аргументов `console.error` значения не имеет — важен сам вызов;
 *   - utils/debug.js — белый список (сам модуль-обёртка владеет console.*).
 *
 * Падение (сообщение): `bare console.error в <file>:<line>`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'adapters'];

// Белый список: модуль-обёртка — единственный легальный владелец console.*
// (в SCAN_DIRS он не входит, запись сохранена как явный контракт).
const WHITELIST = new Set(['utils/debug.js']);

function toRel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Символ, после которого `/` — начало регулярки, а не деление.
function regexAllowed(prevSig) {
  if (!prevSig) return true;
  return '(,=:[!&|?{};+-*%~^<>'.indexOf(prevSig) !== -1;
}

/**
 * Лексер: возвращает копию исходника той же длины, где все комментарии и строковые
 * литералы заменены пробелами (переводы строк сохранены — нумерация строк не сдвигается).
 * Интерполяции шаблонов (`${...}`) остаются кодом и лексируются дальше.
 */
function maskNonCode(src) {
  const out = src.split('');
  const n = src.length;

  function blank(from, to) {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  }

  // Продолжение сканирования шаблонного литерала с позиции from.
  // Возвращает { end } — литерал закрыт, либо { substStart } — открыта интерполяция.
  function scanTemplate(from) {
    let j = from;
    while (j < n) {
      const d = src[j];
      if (d === '\\') { j += 2; continue; }
      if (d === '`') return { end: j + 1, substStart: -1 };
      if (d === '$' && src[j + 1] === '{') return { end: -1, substStart: j + 2 };
      j++;
    }
    return { end: n, substStart: -1 };
  }

  const braceStack = []; // глубина `{` внутри активной интерполяции шаблона
  let i = 0;
  let prevSig = '';

  while (i < n) {
    const c = src[i];

    // // однострочный комментарий
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    // /* блочный комментарий (многострочный) */
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }

    // /regexp/flags
    if (c === '/' && regexAllowed(prevSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        blank(i, j);
        i = j;
        prevSig = ')';
        continue;
      }
      // не закрылся до конца строки — это деление, идём дальше как по коду
    }

    // 'строка' / "строка"
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        if (src[j] === '\n') break;
        j++;
      }
      blank(i, j);
      i = j;
      prevSig = quote;
      continue;
    }

    // `шаблон` (с продолжением кода в ${...})
    if (c === '`') {
      const r = scanTemplate(i + 1);
      if (r.substStart > 0) {
        blank(i, r.substStart);
        braceStack.push(0);
        i = r.substStart;
        prevSig = '{';
        continue;
      }
      blank(i, r.end);
      i = r.end;
      prevSig = '`';
      continue;
    }

    // Возврат из интерполяции в текст шаблона.
    if (c === '}' && braceStack.length) {
      const top = braceStack.length - 1;
      if (braceStack[top] === 0) {
        braceStack.pop();
        const r = scanTemplate(i + 1);
        if (r.substStart > 0) {
          blank(i, r.substStart);
          braceStack.push(0);
          i = r.substStart;
          prevSig = '{';
          continue;
        }
        blank(i, r.end);
        i = r.end;
        prevSig = '`';
        continue;
      }
      braceStack[top]--;
    } else if (c === '{' && braceStack.length) {
      braceStack[braceStack.length - 1]++;
    }

    if (!/\s/.test(c)) prevSig = c;
    i++;
  }

  return out.join('');
}

const BARE_CONSOLE_ERROR = /console\s*\.\s*error\s*\(/g;

// Находит вызовы console.error в уже замаскированном коде; возвращает [{ index, line }].
function findBareConsoleError(masked) {
  const hits = [];
  BARE_CONSOLE_ERROR.lastIndex = 0;
  let m;
  while ((m = BARE_CONSOLE_ERROR.exec(masked)) !== null) {
    // `obj.console.error(` — не bare-вызов; `foo_console.error(` — тоже.
    const before = m.index > 0 ? masked[m.index - 1] : '';
    if (/[\w$.]/.test(before)) continue;
    const line = masked.slice(0, m.index).split('\n').length;
    hits.push({ index: m.index, line });
  }
  return hits;
}

// Скан одного файла с учётом белого списка.
function scanFile(absPath) {
  const rel = toRel(absPath);
  if (WHITELIST.has(rel)) return [];
  const src = fs.readFileSync(absPath, 'utf8');
  return findBareConsoleError(maskNonCode(src)).map(h => ({ file: rel, line: h.line }));
}

function scanDirs(dirs) {
  const violations = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of listJsFiles(abs)) violations.push(...scanFile(f));
  }
  return violations;
}

function formatViolations(violations) {
  return violations.map(v => 'bare console.error в ' + v.file + ':' + v.line).join('\n');
}

describe('1.9: пин no-bare-console-error (core/ + adapters/)', () => {
  test('production-исходники не содержат bare console.error', () => {
    const violations = scanDirs(SCAN_DIRS);
    if (violations.length) throw new Error(formatViolations(violations));
    expect(violations).toHaveLength(0);
  });

  test('ленсер ловит реальный вызов и сообщает файл:строку', () => {
    const src = [
      'function f() {',
      "  console.error('boom');",
      '}'
    ].join('\n');
    const hits = findBareConsoleError(maskNonCode(src));
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
    const msg = formatViolations([{ file: 'core/demo.js', line: 2 }]);
    expect(msg).toBe('bare console.error в core/demo.js:2');
  });

  test('ленсер не считает комментарии (// и /* */) и строковые литералы', () => {
    const src = [
      "// console.error('в строке комментария');",
      '/* console.error( */',
      "const s = \"console.error('в строке')\";",
      "const t = 'console.error(';",
      'const u = `console.error(`;',
      'const re = /console\\.error\\(/;',
      'obj.console.error;',
      'console["error"]();'
    ].join('\n');
    expect(findBareConsoleError(maskNonCode(src))).toHaveLength(0);
  });

  test('ленсер видит вызов внутри интерполяции шаблона', () => {
    const src = 'const x = `a${console.error(\'boom\')}b`;';
    const hits = findBareConsoleError(maskNonCode(src));
    expect(hits).toHaveLength(1);
  });

  test('ленсер видит вызов во второй строке блочного комментария и многострочного кода', () => {
    const src = [
      '/*',
      "  console.error('в блочном комментарии');",
      '*/',
      'try {',
      '  console.error(', // перенос аргумента на другую строку
      '    new Error("x")',
      '  );',
      '} catch (e) {}'
    ].join('\n');
    const hits = findBareConsoleError(maskNonCode(src));
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(5);
  });

  test('белый список: utils/debug.js разрешён (сам модуль-обёртка)', () => {
    expect(WHITELIST.has('utils/debug.js')).toBe(true);
    const debugPath = path.join(ROOT, 'utils', 'debug.js');
    expect(scanFile(debugPath)).toHaveLength(0);
    // сканируемые каталоги белый список не пересекают
    for (const d of SCAN_DIRS) {
      expect(listJsFiles(path.join(ROOT, d)).map(toRel)).not.toContain('utils/debug.js');
    }
  });

  test('НЕ трогать: комментарий core/state.js:147 не считается вызовом', () => {
    const stateSrc = fs.readFileSync(path.join(ROOT, 'core', 'state.js'), 'utf8');
    const line147 = stateSrc.split('\n')[146];
    expect(line147).toContain('console.error');
    expect(line147.trim().startsWith('//')).toBe(true);
    expect(findBareConsoleError(maskNonCode(stateSrc))).toHaveLength(0);
  });
});
