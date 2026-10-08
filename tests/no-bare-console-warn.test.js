/**
 * Step E.2c-A (канал B): страж «bare console.warn» в production-исходниках.
 *
 * Контракт проекта: warn-уровень выводится ЛИБО через debugLog('warn', …) (канал A:
 * вычисленный уровень, печатается всегда), ЛИБО через aiCmDiagWarn(tag, message, detail)
 * (канал B: печатается только под гейтом aiCmDebug, но всегда пишется в ring-буфер).
 * Прямой console.warn обходит и ring, и гейт — поэтому здесь source-level пин.
 *
 * Отличия от tests/no-bare-console-error.test.js (брат-страж, структура скопирована):
 *   1. Ловится и computed-доступ: `console['warn'](` / `console["warn"](` — форма, которую
 *      страж console.error намеренно НЕ ловит (tests/no-bare-console-error.test.js:261).
 *      Лексер стирает ключ-литерал, поэтому форма ловится по виду `console[…] (`, см. WARN_PATTERNS.
 *   2. Ловится и динамический уровень `console[level]` — иначе сам логгер (utils/debug.js:62,69
 *      и SW-дубль core/background.js:13,14) был бы невидим для стража.
 *   3. utils/debug.js не «белый список целиком», а ЯВНО сканируемый файл: его сайты внесены
 *      в allow-list поимённо (иначе «владелец console.*» оказался бы непроверяемым).
 *   4. Вместо белого списка — allow-list tests/fixtures/console-allow.json (schema
 *      ai-cm/console-allow@1) с обязательным reason у каждой записи и проверкой мёртвых записей.
 *
 * Падение (сообщение): `Found N bare console.warn calls; either migrate to aiCmDiagWarn or
 * add to tests/fixtures/console-allow.json with reason` + по одной падающей проверке на сайт.
 *
 * ДО B2c страж ОЖИДАЕМО КРАСНЫЙ: все текущие console.warn в core/ и adapters/ — ещё не
 * мигрированный канал B. Зелёным он становится после шага B2c, без правок этого файла.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'adapters'];
// Модуль-обёртка: в SCAN_DIRS не входит, но сканируется явно (plan §7.1а) — записи
// allow-list для utils/debug.js должны указывать на живые сайты, а не висеть мёртвыми.
const EXTRA_SCANNED_FILES = ['utils/debug.js'];
const ALLOW_PATH = path.join(ROOT, 'tests', 'fixtures', 'console-allow.json');
const ALLOW_SCHEMA = 'ai-cm/console-allow@1';
const HINT = 'either migrate to aiCmDiagWarn or add to tests/fixtures/console-allow.json with reason';

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

// Три формы вывода warn, которые страж обязан видеть:
//   1) bare `console.warn(` — обычный обход канала B;
//   2) computed `console['warn'](` — обход мимо regex по точке. Ловушка: лексер уже
//      заменил сам ключ-литерал пробелами (maskNonCode не различает содержимое строк),
//      поэтому ловится ФОРМА `console[<литерал>](`, а не слово 'warn'. Именно из-за этой
//      ловушки брат-страж tests/no-bare-console-error.test.js:261 фиксирует, что
//      `console["error"]()` им НЕ ловится. Здесь форма ловится шире, чем warn-only:
//      любой computed-вызов console с ключом-литералом — аномалия (в дереве сейчас 0 таких);
//   3) динамический уровень `console[level]` — логгер-владелец console.* (канал A),
//      единственный легальный случай: он в allow-list, а не вне стража.
const WARN_PATTERNS = [
  /console\s*\.\s*warn\s*\(/g,
  /console\s*\[\s*\]\s*\(/g,
  /console\s*\[\s*[A-Za-z_$][\w$]*\s*\]/g
];

// Находит сайты warn в уже замаскированном коде; возвращает [{ line, text }] по строке.
function findBareConsoleWarn(masked) {
  const byLine = new Map();
  for (const re of WARN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      // `obj.console.warn(` — не bare-вызов; `foo_console[level]` — тоже.
      const before = m.index > 0 ? masked[m.index - 1] : '';
      if (/[\w$.]/.test(before)) continue;
      const line = masked.slice(0, m.index).split('\n').length;
      if (!byLine.has(line)) byLine.set(line, m[0]);
    }
  }
  return [...byLine.entries()].map(([line, text]) => ({ line, text })).sort((a, b) => a.line - b.line);
}

function scanFile(absPath) {
  const rel = toRel(absPath);
  const src = fs.readFileSync(absPath, 'utf8');
  return findBareConsoleWarn(maskNonCode(src)).map(h => ({ file: rel, line: h.line, text: h.text }));
}

function scanTree() {
  const found = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of listJsFiles(abs)) found.push(...scanFile(f));
  }
  for (const rel of EXTRA_SCANNED_FILES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) found.push(...scanFile(abs));
  }
  return found;
}

function loadAllow() {
  return JSON.parse(fs.readFileSync(ALLOW_PATH, 'utf8'));
}

/** Разворачивает groups[] в Map('file:line' → reason); отдельно копит дефекты схемы. */
function expandAllow(doc) {
  const declared = new Map();
  const problems = [];
  if (!doc || typeof doc !== 'object') return { declared, problems: ['allow-list: не объект'] };
  if (doc.schema !== ALLOW_SCHEMA) problems.push('allow-list.schema != ' + ALLOW_SCHEMA);
  if (!Array.isArray(doc.groups)) return { declared, problems: problems.concat(['allow-list.groups: не массив']) };
  doc.groups.forEach((g, i) => {
    const at = 'groups[' + i + ']';
    if (!g || typeof g !== 'object') { problems.push(at + ': не объект'); return; }
    if (typeof g.file !== 'string' || !g.file.trim()) problems.push(at + ': пустой file');
    if (typeof g.reason !== 'string' || !g.reason.trim()) problems.push(at + ' (' + g.file + '): пустой reason');
    if (!Array.isArray(g.lines) || g.lines.length === 0) { problems.push(at + ' (' + g.file + '): пустой lines'); return; }
    for (const ln of g.lines) {
      if (typeof ln !== 'number' || !isFinite(ln) || ln < 1) { problems.push(at + ' (' + g.file + '): некорректная строка ' + ln); continue; }
      const key = g.file + ':' + ln;
      if (declared.has(key)) problems.push(key + ': дубликат записи');
      else declared.set(key, g.reason);
    }
  });
  if (typeof doc.totalEntries === 'number' && doc.totalEntries !== declared.size) {
    problems.push('totalEntries=' + doc.totalEntries + ' != развёрнутых записей ' + declared.size);
  }
  return { declared, problems };
}

/** Финальный прогон стража по реальному дереву. */
function runGate() {
  const { declared, problems } = expandAllow(loadAllow());
  const found = scanTree();
  const violations = found.filter(f => !declared.has(f.file + ':' + f.line));
  const dead = [...declared.keys()].filter(k => !found.some(f => f.file + ':' + f.line === k));
  return { found, declared, violations, dead, problems };
}

describe('Step E.2c-A: страж bare console.warn — allow-list', () => {
  test('схема ai-cm/console-allow@1 корректна, у каждой группы непустой reason', () => {
    const { declared, problems } = expandAllow(loadAllow());
    expect(problems).toEqual([]);
    expect(declared.size).toBeGreaterThan(0);
    expect(declared.size).toBe(loadAllow().totalEntries);
    for (const g of loadAllow().groups) expect(g.reason.trim().length).toBeGreaterThan(0);
  });

  test('allow-list не содержит мёртвых записей (каждая указывает на реальный сайт)', () => {
    const { dead } = runGate();
    expect(dead).toEqual([]);
  });

  test('лексер не считает комментарии, строковые литералы и регулярки', () => {
    const src = [
      "// console.warn('в комментарии');",
      '/* console.warn( */',
      "const s = \"console.warn('в строке')\";",
      'const t = \'console.warn(\';',
      'const u = `console.warn(`;',
      'const re = /console\\.warn\\(/;',
      'const v = "console[level]";'
    ].join('\n');
    expect(findBareConsoleWarn(maskNonCode(src))).toHaveLength(0);
  });

  test('лексер видит вызов внутри интерполяции шаблона', () => {
    const src = 'const x = `a${console.warn(\'boom\')}b`;';
    expect(findBareConsoleWarn(maskNonCode(src))).toHaveLength(1);
  });

  test('detector: computed-форма console["warn"]( ловится (в отличие от стража console.error)', () => {
    // лексер стирает ключ-литерал, в маске остаётся `console[      ](` — ловится форма
    expect(maskNonCode('console["warn"]();').indexOf('console[')).toBe(0);
    expect(findBareConsoleWarn(maskNonCode('console["warn"]();'))).toHaveLength(1);
    expect(findBareConsoleWarn(maskNonCode("console['warn']();"))).toHaveLength(1);
    expect(findBareConsoleWarn(maskNonCode('console[ "warn" ](a, b);'))).toHaveLength(1);
    expect(findBareConsoleWarn(maskNonCode("obj.console['warn']();"))).toHaveLength(0);
  });

  test('detector: динамический уровень console[level] ловится, obj.console.* — нет', () => {
    expect(findBareConsoleWarn(maskNonCode('(console[level] || console.log).apply(console, args);'))).toHaveLength(1);
    expect(findBareConsoleWarn(maskNonCode("obj.console.warn('x');"))).toHaveLength(0);
    expect(findBareConsoleWarn(maskNonCode('foo_console[level];'))).toHaveLength(0);
    expect(findBareConsoleWarn(maskNonCode('console.warn;'))).toHaveLength(0);
  });

  test('detector: bare console.warn( сообщает файл:строку', () => {
    const src = ['function f() {', "  console.warn('boom');", '}'].join('\n');
    const hits = findBareConsoleWarn(maskNonCode(src));
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  test('реальный логгер (utils/debug.js) сканируется и покрыт allow-list, а не пропущен', () => {
    expect(EXTRA_SCANNED_FILES).toContain('utils/debug.js');
    const loggerHits = scanFile(path.join(ROOT, 'utils', 'debug.js'));
    expect(loggerHits.length).toBeGreaterThan(0);
    const { declared } = expandAllow(loadAllow());
    for (const h of loggerHits) expect(declared.has(h.file + ':' + h.line)).toBe(true);
  });
});

describe('A5 (до B2c): каждый bare console.warn вне allow-list — отдельное падение', () => {
  const { violations } = runGate();
  const total = violations.length;
  if (!total) {
    test('вне allow-list нет ни одного bare console.warn: канал B мигрирован', () => {
      expect(violations).toEqual([]);
    });
  }
  violations.forEach(v => {
    test(`bare console.warn: ${v.file}:${v.line}`, () => {
      throw new Error('Found ' + total + ' bare console.warn calls; ' + HINT + ' → ' + v.file + ':' + v.line);
    });
  });
});
