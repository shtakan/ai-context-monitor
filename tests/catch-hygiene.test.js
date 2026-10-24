/**
 * Step E.2b.1 — Jest-страж: запрет НОВЫХ молчаливых catch в боевом коде.
 *
 * ─── DESIGN REVIEW ────────────────────────────────────────────────────────────
 * ГРАНИЦЫ СКАНИРОВАНИЯ:  core/, utils/, adapters/ (только *.js, рекурсивно).
 *   Вне области: dist/, node_modules/, tests/, tools/, .git/ — страж не
 *   распространяется на сгенерированный бандл, тестовые файлы и одноразовые
 *   скрипты. R3 фиксирует это поведением, а не комментарием.
 *
 * ОПРЕДЕЛЕНИЕ «МОЛЧАЛИВЫЙ CATCH» (прецедент E.1):
 *   тело после вырезания комментариев содержит только пробелы (сюда же попадает
 *   тело из одного комментария — комментарии маскируются в пробелы),
 *   ЛИБО ровно один no-op: void 0; / return; / continue; / break;.
 *   Всё остальное — «не молчаливое» и стражем не рассматривается: серия E.2a
 *   уже расставила swallow/debugLog в 194 точках, и повторно проверять наличие
 *   логирования здесь не нужно (двойной контроль = двойные ложные падения).
 *
 * ФОРМАТ WHITELIST: tests/fixtures/catch-whitelist.json — сгруппирован по
 *   (file, category): { file, category, lines: [...], reason }. Группировка
 *   выбрана вместо плоского списка из 458 записей, потому что reason у соседних
 *   строк одного класса совпадает дословно; reviewer читает ~185 групп вместо
 *   458 почти одинаковых строк, а ключ (file, line) восстанавливается
 *   расширением groups[].lines[]. reason НЕ пустой и содержит категорию,
 *   обоснование и пример тела try.
 *
 * ЧТО ДЕЛАЕТ СТРАЖ:
 *   (а) молчаливый catch, которого нет в whitelist → падение;
 *   (б) запись whitelist, не соответствующая ни одному фактическому catch
 *       (мёртвая запись) → падение;
 *   (в) дубликат (file, line) внутри whitelist → падение;
 *   (г) пустой reason у группы → падение.
 *
 * ЧЕГО СТРАЖ НЕ ДЕЛАЕТ:
 *   не требует swallow в catch (это предмет серии E.2a), не анализирует
 *   содержимое непустых catch, не сканирует каталоги вне SCAN_DIRS.
 *
 * ЛЕКСЕР: копия maskNonCode из tests/no-bare-console-error.test.js с ОДНИМ
 *   отличием — строковые/регулярочные/шаблонные литералы маскируются в
 *   непустой плейсхолдер §, а не в пробел. Иначе `catch (e) { return 'x'; }`
 *   вырождается в «пустое» тело и даёт ложное срабатывание (проверено: это
 *   ломало utils/debug.js:152/169). Комментарии по-прежнему → пробелы.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'utils', 'adapters'];
const WHITELIST_PATH = path.join(ROOT, 'tests', 'fixtures', 'catch-whitelist.json');
const WHITELIST_SCHEMA = 'ai-cm/catch-whitelist@1';

// ============================ лексер =========================================

/** Плейсхолдер литерала. Именно НЕ пробел: см. DESIGN REVIEW выше. */
const LIT = '\u00A7';

function regexAllowed(prevSig) {
  if (!prevSig) return true;
  return '(,=:[!&|?{};+-*%~^<>'.indexOf(prevSig) !== -1;
}

/** Комментарии → пробелы; строки/регекспы/шаблоны → LIT. Длины и \n сохраняются. */
function maskNonCode(src) {
  const out = src.split('');
  const n = src.length;
  function blank(from, to, ch) {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ch;
    }
  }
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
  const braceStack = [];
  let i = 0;
  let prevSig = '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      blank(i, j, ' '); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2); blank(i, j, ' '); i = j; continue;
    }
    if (c === '/' && regexAllowed(prevSig)) {
      let j = i + 1, inClass = false, closed = false;
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
        blank(i, j, LIT); i = j; prevSig = ')'; continue;
      }
    }
    if (c === "'" || c === '"') {
      const quote = c; let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        if (src[j] === '\n') break;
        j++;
      }
      blank(i, j, LIT); i = j; prevSig = quote; continue;
    }
    if (c === '`') {
      const r = scanTemplate(i + 1);
      if (r.substStart > 0) { blank(i, r.substStart, LIT); braceStack.push(0); i = r.substStart; prevSig = '{'; continue; }
      blank(i, r.end, LIT); i = r.end; prevSig = '`'; continue;
    }
    if (c === '}' && braceStack.length) {
      const top = braceStack.length - 1;
      if (braceStack[top] === 0) {
        braceStack.pop();
        const r = scanTemplate(i + 1);
        if (r.substStart > 0) { blank(i, r.substStart, LIT); braceStack.push(0); i = r.substStart; prevSig = '{'; continue; }
        blank(i, r.end, LIT); i = r.end; prevSig = '`'; continue;
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

function listJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * `catch` → { line, body }. Обе скобки ищутся ПОСЛЕ ключевого слова и его
 * необязательного параметра: `try { } catch (e) { }` в одну строку иначе
 * связывается с чужим `{`. Promise-хендлеры `.catch(fn)` отбрасываются —
 * после разбора параметра там нет `{`.
 */
function findCatches(masked) {
  const out = [];
  const re = /\bcatch\b/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    let i = m.index + 5;
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] === '(') {
      let depth = 0;
      while (i < masked.length) {
        if (masked[i] === '(') depth++;
        else if (masked[i] === ')') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
    }
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] !== '{') continue;
    const bodyStart = i + 1;
    let depth = 1, j = bodyStart;
    while (j < masked.length && depth > 0) {
      const ch = masked[j];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
      j++;
    }
    const line = masked.slice(0, m.index).split('\n').length;
    out.push({ line, body: masked.slice(bodyStart, j) });
  }
  return out;
}

const NOOP_RE = /^(void\s+0|return|continue|break)\s*;?$/;

function classify(body) {
  const t = body.trim();
  if (t === '') return 'empty';
  if (NOOP_RE.test(t)) return 'noop';
  return 'other';
}

/** Молчаливые catch одного исходника. `rel` — путь от корня сканирования, '/' -разделитель. */
function scanSource(rel, raw) {
  const found = [];
  for (const c of findCatches(maskNonCode(raw))) {
    const kind = classify(c.body);
    if (kind !== 'other') found.push({ file: rel, line: c.line, kind });
  }
  return found;
}

/** Молчаливые catch дерева: обход SCAN_DIRS от `root`. */
function collectSilentCatches(root, dirs) {
  const found = [];
  for (const d of (dirs || SCAN_DIRS)) {
    for (const f of listJsFiles(path.join(root, d))) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      found.push(...scanSource(rel, fs.readFileSync(f, 'utf8')));
    }
  }
  return found;
}

// ====================== whitelist и решение стража ===========================

/** Разворачивает groups[] в плоские записи; отдельно копит дефекты схемы. */
function expandWhitelist(wl) {
  const entries = [];
  const problems = [];
  if (!wl || typeof wl !== 'object') return { entries, problems: ['whitelist: не объект'] };
  if (wl.schema !== WHITELIST_SCHEMA) problems.push('whitelist.schema != ' + WHITELIST_SCHEMA);
  if (!Array.isArray(wl.groups)) return { entries, problems: problems.concat(['whitelist.groups: не массив']) };
  wl.groups.forEach((g, i) => {
    const at = 'groups[' + i + ']';
    if (!g || typeof g !== 'object') { problems.push(at + ': не объект'); return; }
    if (typeof g.file !== 'string' || !g.file.trim()) problems.push(at + ': пустой file');
    if (typeof g.reason !== 'string' || !g.reason.trim()) problems.push(at + ' (' + g.file + '): пустой reason');
    if (!Array.isArray(g.lines) || g.lines.length === 0) { problems.push(at + ' (' + g.file + '): пустой lines'); return; }
    for (const ln of g.lines) {
      if (typeof ln !== 'number' || !isFinite(ln) || ln < 1) { problems.push(at + ' (' + g.file + '): некорректная строка ' + ln); continue; }
      entries.push({ file: g.file, line: ln, reason: g.reason, category: g.category });
    }
  });
  if (typeof wl.totalEntries === 'number' && wl.totalEntries !== entries.length) {
    problems.push('totalEntries=' + wl.totalEntries + ' != развёрнутых записей ' + entries.length);
  }
  return { entries, problems };
}

/** Три вердикта стража: unlisted (а), dead (б), duplicates (в). */
function evaluateGate(found, declared) {
  const declaredKeys = new Map();
  const duplicates = [];
  for (const e of declared) {
    const key = e.file + ':' + e.line;
    if (declaredKeys.has(key)) duplicates.push(key);
    else declaredKeys.set(key, e.reason);
  }
  const foundKeys = new Set(found.map(f => f.file + ':' + f.line));
  const unlisted = found.filter(f => !declaredKeys.has(f.file + ':' + f.line));
  const dead = [...declaredKeys.keys()].filter(k => !foundKeys.has(k));
  return { unlisted, dead, duplicates };
}

function loadWhitelist() {
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
}

/** Финальный прогон стража по реальному дереву. */
function runGate() {
  const { entries, problems } = expandWhitelist(loadWhitelist());
  const found = collectSilentCatches(ROOT, SCAN_DIRS);
  return { found, declared: entries, problems, ...evaluateGate(found, entries) };
}

function fmt(items) {
  return items.map(x => (typeof x === 'string' ? x : x.file + ':' + x.line + (x.kind ? ' (' + x.kind + ')' : ''))).join('\n  ');
}

// ================================ тесты ======================================

describe('Step E.2b.1: страж молчаливых catch — whitelist', () => {
  test('схема whitelist корректна, у каждой группы непустой reason', () => {
    const { entries, problems } = expandWhitelist(loadWhitelist());
    expect(problems).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    for (const g of loadWhitelist().groups) expect(g.reason.trim().length).toBeGreaterThan(0);
  });

  test('D3: дубликат (file, line) в whitelist — падение', () => {
    const dup = [
      { file: 'core/a.js', line: 7, reason: 'r' },
      { file: 'core/a.js', line: 7, reason: 'r' }
    ];
    const v = evaluateGate([{ file: 'core/a.js', line: 7, kind: 'empty' }], dup);
    expect(v.duplicates).toEqual(['core/a.js:7']);
  });

  test('D2: мёртвая запись whitelist — падение', () => {
    const declared = [{ file: 'core/a.js', line: 7, reason: 'r' }];
    const v = evaluateGate([{ file: 'core/a.js', line: 9, kind: 'empty' }], declared);
    expect(v.dead).toEqual(['core/a.js:7']);
    expect(v.unlisted.map(x => x.file + ':' + x.line)).toEqual(['core/a.js:9']);
  });

  test('D1: молчаливый catch вне whitelist — падение', () => {
    const found = scanSource('core/a.js', 'function f(){ try { g(); } catch (e) { } }');
    expect(found).toEqual([{ file: 'core/a.js', line: 1, kind: 'empty' }]);
    const v = evaluateGate(found, []);
    expect(v.unlisted.map(x => x.file + ':' + x.line)).toEqual(['core/a.js:1']);
  });

  test('R1: текущее дерево проходит страж и совпадает с whitelist запись-в-запись', () => {
    const { found, declared, unlisted, dead, duplicates, problems } = runGate();
    expect(problems).toEqual([]);
    expect(duplicates).toEqual([]);
    expect(fmt(unlisted)).toBe('');
    expect(fmt(dead)).toBe('');
    expect(found.length).toBe(declared.length);
    expect(found.length).toBe(loadWhitelist().totalEntries);
  });

  test('R1b: определение «молчаливый» — no-op считается, непустое тело и литералы нет', () => {
    expect(scanSource('x.js', 'try{a();}catch(e){}').map(c => c.kind)).toEqual(['empty']);
    expect(scanSource('x.js', 'try{a();}catch(e){ /* только комментарий */ }').map(c => c.kind)).toEqual(['empty']);
    expect(scanSource('x.js', 'try{a();}catch(e){ continue; }').map(c => c.kind)).toEqual(['noop']);
    expect(scanSource('x.js', 'try{a();}catch(e){ return; }').map(c => c.kind)).toEqual(['noop']);
    // регресс-защита лексера: литерал не должен вырождать тело в пустое
    expect(scanSource('x.js', "try{a();}catch(e){ return '(ошибка)'; }")).toEqual([]);
    expect(scanSource('x.js', 'const p = q.catch(function () { });')).toEqual([]);
    expect(scanSource('x.js', 'const s = "catch (e) { }";')).toEqual([]);
    expect(scanSource('x.js', 'try { a(); } catch (e) { swallow(e, "t"); }')).toEqual([]);
  });

  test('R2: страж не конфликтует с tests/audit-r3-silent-catch-logs.test.js', () => {
    // audit-r3 пинует литералы ИНСТРУМЕНТИРОВАННЫХ catch. Страж их не видит
    // (тела непустые) и не требует их удаления — сосуществование проверяем
    // пофайлово: у каждого catch с logSegmentParseFail тело непустое.
    const rel = 'utils/gemini-batchexecute-parser.js';
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(raw).toContain('function logSegmentParseFail');
    expect(raw).toContain('[AI CM][batchexecute] segment parse fail ');
    expect(raw).toContain("logSegmentParseFail(e, 'handleOuter')");
    const interceptSrc = require('./helpers/gemini-intercept-source.js');
    expect(interceptSrc.geminiSource).toContain('[gemini-intercept] parse-top fail');
    const contentSrc = require('./helpers/content-source.js');
    for (const lit of [
      '[AI CM][export] silent-catch aiCmWriteCurrentHistory: ',
      '[AI CM][export] silent-catch aiCmFlushDeferredHistWrite: '
    ]) {
      expect(contentSrc.contentSource).toContain(lit);
    }

    const instrumentedLines = findCatches(maskNonCode(raw))
      .filter(c => c.body.indexOf('logSegmentParseFail') !== -1)
      .map(c => c.line);
    expect(instrumentedLines.length).toBeGreaterThanOrEqual(3);

    const silentInFile = collectSilentCatches(ROOT, ['utils']).filter(f => f.file === rel);
    for (const ln of instrumentedLines) {
      expect(silentInFile.map(f => f.line)).not.toContain(ln);
    }
    // и весь utils/ проходит страж: все молчаливые catch заwhitelist'ованы
    const { entries } = expandWhitelist(loadWhitelist());
    const v = evaluateGate(collectSilentCatches(ROOT, ['utils']), entries);
    expect(fmt(v.unlisted)).toBe('');
    for (const f of silentInFile) {
      expect(entries.map(e => e.file + ':' + e.line)).toContain(f.file + ':' + f.line);
    }

    // сами прецедентные стражи не тронуты
    expect(fs.existsSync(path.join(ROOT, 'tests', 'audit-r3-silent-catch-logs.test.js'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'tests', 'no-bare-console-error.test.js'))).toBe(true);
  });

  test('R3: tests/ вне области сканирования — молчаливый catch там не репортится', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cm-catch-gate-'));
    try {
      fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'core', 'probe.js'), 'function f(){ try { g(); } catch (e) { } }\n');
      fs.writeFileSync(path.join(tmp, 'tests', 'probe.test.js'), 'function f(){ try { g(); } catch (e) { } }\n');
      const found = collectSilentCatches(tmp, SCAN_DIRS);
      expect(found.map(f => f.file)).toEqual(['core/probe.js']);
      expect(found.every(f => !f.file.startsWith('tests/'))).toBe(true);
      // тот же прогон на реальном дереве: ни одного файла вне SCAN_DIRS
      for (const f of collectSilentCatches(ROOT, SCAN_DIRS)) {
        expect(SCAN_DIRS).toContain(f.file.split('/')[0]);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Step E.2b.1: страж молчаливых catch — позитивный контроль', () => {
  test('PC1: инъекция пустого catch в РЕАЛЬНЫЙ core/-файл валит страж (в памяти, байты не тронуты)', () => {
    const rel = 'core/state.js';
    const abs = path.join(ROOT, rel);
    const before = fs.readFileSync(abs);
    const raw = before.toString('utf8');

    // инъекция В КОНЕЦ файла: номера строк остальных catch не сдвигаются,
    // поэтому «мёртвых» записей быть не должно — только одна новая unlisted.
    const injected = raw.replace(/\n?$/, '\n') + 'try { aiCmProbeGuard(); } catch (eProbe) { }\n';
    const injectedLines = injected.split('\n');
    const probeLine = injectedLines.findIndex(l => l.indexOf('eProbe') !== -1) + 1;

    const clean = scanSource(rel, raw);
    const dirty = scanSource(rel, injected);
    expect(dirty.length).toBe(clean.length + 1);
    expect(dirty.filter(f => f.line === probeLine)).toEqual([{ file: rel, line: probeLine, kind: 'empty' }]);

    // Полный вердикт стража на реальном whitelist: ровно одна новая unlisted.
    const { entries } = expandWhitelist(loadWhitelist());
    const v = evaluateGate(collectSilentCatches(ROOT, SCAN_DIRS).concat([{ file: rel, line: probeLine, kind: 'empty' }]), entries);
    expect(v.unlisted.map(x => x.file + ':' + x.line)).toEqual([rel + ':' + probeLine]);
    expect(v.dead).toEqual([]);

    // исходный файл на диске не изменён ни на байт
    expect(fs.readFileSync(abs).equals(before)).toBe(true);
  });

  test('PC2: инъекция пустого catch на ДИСК (временное дерево) валит страж → запись в whitelist лечит', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cm-catch-pos-'));
    try {
      const probe = path.join(tmp, 'core', 'probe.js');
      fs.mkdirSync(path.dirname(probe), { recursive: true });
      fs.writeFileSync(probe, 'function f(){ try { g(); } catch (e) { } }\n');

      const found = collectSilentCatches(tmp, SCAN_DIRS);
      expect(found).toEqual([{ file: 'core/probe.js', line: 1, kind: 'empty' }]);
      expect(evaluateGate(found, []).unlisted.map(x => x.file + ':' + x.line)).toEqual(['core/probe.js:1']);

      // запись в whitelist с непустым reason закрывает падение
      const declared = [{ file: 'core/probe.js', line: 1, reason: 'probe' }];
      const ok = evaluateGate(found, declared);
      expect(ok.unlisted).toEqual([]);
      expect(ok.dead).toEqual([]);

      // идемпотентность: повторный обход диска даёт тот же результат
      expect(collectSilentCatches(tmp, SCAN_DIRS)).toEqual(found);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ================= baseline-pin: пустые catch ВНЕ области whitelist ==========
// НЕЗАВИСИМЫЙ от лексера `maskNonCode` наивный сканер: ищет ЛЮБЫЕ catch-блоки
// с пустым (после нормализации пробелов, переводов строк и комментариев) телом
// в каталогах, которые страж E.2b.1 не сканирует: options/**, print/** и
// utils/i18n-apply.js. Исторический путь utils/i18n-apply.js в дереве
// отсутствует (реальный файл — options/i18n-apply.js, он уже покрыт options/**),
// поэтому несуществующие цели просто пропускаются и вклада не дают.
// Baseline = 0: все 38 исторических точек закрыты (27 в options/options.js,
// 10 в print/print.js, 1 в options/i18n-apply.js) — либо диагностикой/фолбэком
// в теле catch, либо удалением try/catch, который ничего не бросал. Поэтому
// счётчик пинится строго на нуле: любая НОВАЯ пустая точка — падение, а не
// «ещё одна сверх baseline». Логика whitelist-стража выше не затронута.
const OUTSIDE_WHITELIST_BASELINE = 0;
const OUTSIDE_WHITELIST_TARGETS = ['options', 'print', 'utils/i18n-apply.js'];

/** Рекурсивный список *.js под целью (файл или каталог); нет пути → []. */
function listJsUnder(abs) {
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return abs.endsWith('.js') ? [abs] : [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...listJsUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Наивный скан: `catch` [ (param) ] `{` со сбалансированными скобками и пустым телом. */
function scanEmptyCatches(rel, raw) {
  const found = [];
  const re = /\bcatch\b\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = re.lastIndex;
    let depth = 1;
    let j = start;
    while (j < raw.length && depth > 0) {
      if (raw[j] === '{') depth++;
      else if (raw[j] === '}') { depth--; if (depth === 0) break; }
      j++;
    }
    const body = raw.slice(start, j)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    if (body.replace(/\s+/g, '') === '') {
      found.push({ file: rel, line: raw.slice(0, m.index).split('\n').length });
    }
    re.lastIndex = j + 1;
  }
  return found;
}

function collectEmptyCatchesOutsideWhitelist() {
  const found = [];
  for (const target of OUTSIDE_WHITELIST_TARGETS) {
    for (const f of listJsUnder(path.join(ROOT, target))) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      found.push(...scanEmptyCatches(rel, fs.readFileSync(f, 'utf8')));
    }
  }
  return found;
}

describe('Step E.2b.1: baseline-pin пустых catch вне области whitelist', () => {
  test('N1: в options/, print/ и utils/i18n-apply.js нет ни одного пустого catch (baseline 0)', () => {
    const found = collectEmptyCatchesOutsideWhitelist();
    const listing = found.map(f => f.file + ':' + f.line).join('\n  ');
    expect(found.length > OUTSIDE_WHITELIST_BASELINE
      ? 'НАЙДЕНО ' + found.length + ' (> baseline ' + OUTSIDE_WHITELIST_BASELINE + '), точки:\n  ' + listing
      : '').toBe('');
    // baseline 0 → пин строгий: пустых catch вне whitelist не должно быть вовсе
    expect(found.length).toBeLessThanOrEqual(OUTSIDE_WHITELIST_BASELINE);
  });
});

// ================= R1: пин против identity-replace в print/print.js ===========
// Регресс-защита фикса v85 (§4 R1): в print/print.js не должно появляться
// `.replace(/X/g, 'X')` — вызов, который возвращает вход без изменений.
// История: до v85 HTML-escape в fail-open fallback был identity-цепочкой
// `.replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>')`, т.е. не экранировал
// ничего. Сейчас там реальные сущности `&amp;` / `&lt;` / `&gt;` / `&quot;`;
// пин фиксирует, что цепочка не деградирует обратно.
//
// Детектор намеренно ШИРЕ примера из постановки: помимо `.replace(/X/g, "X")`
// он ловит любой string-заменитель, чьё значение после раскрытия JS-escape
// совпадает с ЛИТЕРАЛЬНЫМ текстом шаблона (`.replace(/\./g, '.')` тоже identity).
// Шаблон с регексп-метасимволами (`\s`, `\d`, `+`, `[]`, `\b` и т.п.) литералом
// не считается: `.replace(/a+/g, 'a+')` и `.replace(/\s+/g, ' ')` — не identity.
const PRINT_JS_PATH = path.join(ROOT, 'print', 'print.js');

const REPLACE_CALL_RE = /\.replace\(\s*\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+)\/([gimsuy]*)\s*,\s*(['"])((?:\\.|(?!\3)[^\\\n])*)\3\s*\)/g;

const JS_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
const REGEX_CONTROL_ESCAPES = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', 0: '\0' };
const REGEX_META = '^$.*+?()[]{}|';

/** Раскрывает escape-последовательности строкового литерала (без кавычек). */
function decodeJsString(s) {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, e) => {
    if (e[0] === 'u') {
      const hex = e[1] === '{' ? e.slice(2, -1) : e.slice(1);
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return Object.prototype.hasOwnProperty.call(JS_ESCAPES, e) ? JS_ESCAPES[e] : e;
  });
}

/**
 * Литеральный текст regex-шаблона или null, если шаблон содержит метасимволы
 * (класс, якорь, квантификатор, группа, backreference). Только литеральный
 * шаблон, совпавший с заменителем, действительно возвращает вход как есть.
 */
function literalRegexText(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const e = src[++i];
      if (e === undefined) return null;
      if (e === 'u' || e === 'x') {
        const width = e === 'u' ? 4 : 2;
        const hex = src.slice(i + 1, i + 1 + width);
        if (!new RegExp('^[0-9a-fA-F]{' + width + '}$').test(hex)) return null;
        out += String.fromCodePoint(parseInt(hex, 16));
        i += width;
      } else if (Object.prototype.hasOwnProperty.call(REGEX_CONTROL_ESCAPES, e)) {
        out += REGEX_CONTROL_ESCAPES[e];
      } else if (REGEX_META.indexOf(e) !== -1 || e === '\\' || e === '/' || e === '-') {
        out += e;
      } else {
        return null; // \s, \d, \w, \b, \1 и прочие не-литералы
      }
    } else if (REGEX_META.indexOf(c) !== -1) {
      return null;
    } else {
      out += c;
    }
  }
  return out;
}

/** Все identity-replace в исходнике: { line, expr }. */
function findIdentityReplaces(src) {
  const found = [];
  REPLACE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = REPLACE_CALL_RE.exec(src)) !== null) {
    const pattern = literalRegexText(m[1]);
    const replacement = decodeJsString(m[4]);
    if (pattern !== null && pattern === replacement) {
      found.push({ line: src.slice(0, m.index).split('\n').length, expr: m[0] });
    }
  }
  return found;
}

describe('R1 (v85): в print/print.js нет identity-replace цепочек', () => {
  test('identity-replace `.replace(/X/g, \'X\')` — 0 совпадений', () => {
    const src = fs.readFileSync(PRINT_JS_PATH, 'utf8');
    const found = findIdentityReplaces(src);
    const listing = found.map(f => 'print/print.js:' + f.line + ' — ' + f.expr).join('\n  ');
    expect(found.length
      ? 'НАЙДЕНО ' + found.length + ' identity-replace, точки:\n  ' + listing
      : '').toBe('');
    expect(found).toEqual([]);
  });

  test('R1b: детектор ловит identity и не трогает реальный escape', () => {
    expect(findIdentityReplaces("var s = x.replace(/&/g, '&');").map(f => f.line)).toEqual([1]);
    expect(findIdentityReplaces('var s = x.replace(/</g, "<");').length).toBe(1);
    expect(findIdentityReplaces("x.replace(/\\./g, '.');").length).toBe(1);
    // не identity: реальные сущности, пробельная нормализация, нестроковый заменитель
    expect(findIdentityReplaces("x.replace(/&/g, '&amp;');")).toEqual([]);
    expect(findIdentityReplaces("x.replace(/</g, '&lt;');")).toEqual([]);
    expect(findIdentityReplaces("x.replace(/\\s+/g, ' ');")).toEqual([]);
    expect(findIdentityReplaces("x.replace(/a+/g, 'a+');")).toEqual([]);
    expect(findIdentityReplaces("x.replace(/\\b/g, 'b');")).toEqual([]);
    expect(findIdentityReplaces('x.replace(/a/g, repl);')).toEqual([]);
    // положительный контроль на живой цепочке v85: 4 реальные сущности
    const fixed = "s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;')";
    expect(findIdentityReplaces(fixed)).toEqual([]);
    // и та же цепочка в исторически дефектном виде детектируется целиком
    const broken = "s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')";
    expect(findIdentityReplaces(broken).length).toBe(3);
  });
});
