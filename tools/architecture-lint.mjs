#!/usr/bin/env node
/**
 * tools/architecture-lint.mjs — структурный (AST) линтер архитектурных границ.
 *
 * Решение и правила: docs/decisions/architecture-lint.md (ADR-002).
 * Парсер — TypeScript compiler API (уже в devDependencies), без новых пакетов
 * и без исполнения проверяемого кода.
 *
 * Почему AST, а не строки: line-based пины (catch-whitelist, счётчики
 * `baseSeen = true;`) ломаются от любой вставки выше и требуют ручного
 * пересчёта. AST-узел переживает сдвиг строк; проверка привязана к факту
 * (пустой catch, chrome.* в MAIN, import() в рантайме), а не к номеру.
 *
 * Запуск:
 *   node tools/architecture-lint.mjs
 *   node tools/architecture-lint.mjs --list-rules
 *   node tools/architecture-lint.mjs --json
 *
 * Выход: 0 — чисто, 1 — нарушения, 2 — ошибка запуска.
 * Интеграция: npm run lint:arch в CI (вне Jest — behavior-gate не растёт).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Каталоги, которые не являются исходниками продукта. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-firefox', '.build', 'coverage', 'tests', 'docs', 'artifacts',
]);

/** MAIN-перехватчики: собираются отдельными IIFE (build.mjs MAIN_INTERCEPTS). */
const MAIN_INTERCEPT_RE = /^core\/(?:page|[a-z0-9-]+)-intercept\.js$/;

/** Швы 2.2: чистые модули без DOM/host-API (появятся в фазах 1–4). */
const SEAM_DIRS = ['utils/messages', 'utils/metrics', 'utils/export'];

// ---------------------------------------------------------------------------
// обход файлов
// ---------------------------------------------------------------------------

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('_')) continue;
      walk(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(?:js|ts)$/.test(entry.name)) continue;
    out.push(abs);
  }
  return out;
}

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function kindOf(file) {
  return file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kindOf(file));
}

function forEachNode(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => forEachNode(child, visit));
}

function positionOf(sourceFile, node) {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: pos.line + 1, column: pos.character + 1 };
}

function nodeKind(node) {
  return ts.SyntaxKind[node.kind];
}

function preview(sourceFile, node, limit = 60) {
  const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

// ---------------------------------------------------------------------------
// правила
// ---------------------------------------------------------------------------

/** Тело catch, которое считается молчаливым (та же семантика, что catch-hygiene). */
function isSilentCatch(clause) {
  const statements = clause.block.statements;
  if (statements.length === 0) return true;
  if (statements.length !== 1) return false;
  const st = statements[0];
  if (ts.isEmptyStatement(st)) return true;
  if (ts.isReturnStatement(st) && !st.expression) return true;
  if (ts.isContinueStatement(st) || ts.isBreakStatement(st)) return true;
  if (ts.isExpressionStatement(st) && ts.isVoidExpression(st.expression)) {
    const expr = st.expression.expression;
    return ts.isNumericLiteral(expr) && expr.text === '0';
  }
  return false;
}

function isIdentifierNamed(node, name) {
  return ts.isIdentifier(node) && node.text === name;
}

const RULES = [
  {
    id: 'seam-no-silent-catch',
    description: 'швы utils/messages|metrics|export не глотают ошибки молча (пустой/no-op catch)',
    applies: (file) => SEAM_DIRS.some((dir) => file.startsWith(dir + '/')),
    check(sourceFile, file, report) {
      forEachNode(sourceFile, (node) => {
        if (!ts.isCatchClause(node)) return;
        if (!isSilentCatch(node)) return;
        report({
          file,
          node,
          message:
            'молчаливый catch в шве: используйте swallowSoft/swallow с причиной ' +
            'или верните значение — тело не может быть пустым',
        });
      });
    },
  },
  {
    id: 'seam-no-host-globals',
    description: 'швы не читают document/chrome: вход — данные, выход — данные',
    applies: (file) => SEAM_DIRS.some((dir) => file.startsWith(dir + '/')),
    check(sourceFile, file, report) {
      forEachNode(sourceFile, (node) => {
        if (!ts.isIdentifier(node)) return;
        if (node.text !== 'document' && node.text !== 'chrome') return;
        if (isDeclarationName(node)) return;
        report({
          file,
          node,
          message: `шов не должен обращаться к ${node.text}: побочные эффекты остаются в core/content.ts`,
        });
      });
    },
  },
  {
    id: 'main-no-chrome',
    description: 'MAIN-перехватчики не используют chrome.* — только события (ADR-001/§3.5)',
    applies: (file) => MAIN_INTERCEPT_RE.test(file),
    check(sourceFile, file, report) {
      forEachNode(sourceFile, (node) => {
        if (!isIdentifierNamed(node, 'chrome')) return;
        if (isPropertyName(node)) return;
        report({
          file,
          node,
          message: 'chrome.* в MAIN-мире недоступен; используйте CustomEvent-мост в ISOLATED',
        });
      });
    },
  },
  {
    id: 'main-no-dynamic-import',
    description: 'MAIN-перехватчики не грузят ESM в рантайме (статические import разрешены: IIFE-сборка)',
    applies: (file) => MAIN_INTERCEPT_RE.test(file),
    check(sourceFile, file, report) {
      forEachNode(sourceFile, (node) => {
        if (!ts.isCallExpression(node)) return;
        if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
        report({
          file,
          node,
          message:
            'динамический import() в MAIN требует web_accessible_resources и ломает IIFE-границу; ' +
            'вынесите зависимость в статический import (собирается build.mjs)',
        });
      });
    },
  },
  {
    id: 'baseSeen-single-bare-write',
    description: 'ровно одна запись baseSeen = true; в core; новые места — baseSeen = (true);',
    applies: (file) => file.startsWith('core/'),
    check(sourceFile, file, report, ctx) {
      forEachNode(sourceFile, (node) => {
        if (!ts.isBinaryExpression(node)) return;
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
        if (!isIdentifierNamed(node.left, 'baseSeen')) return;
        if (node.right.kind !== ts.SyntaxKind.TrueKeyword) return;
        // Новая точка обязана быть в скобках: baseSeen = (true);
        if (ts.isParenthesizedExpression(node.right)) return;
        ctx.bareWrites.push({ file, node });
      });
    },
  },
];

function isPropertyName(node) {
  const parent = node.parent;
  return !!parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
}

function isDeclarationName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) return true;
  return false;
}

// ---------------------------------------------------------------------------
// движок
// ---------------------------------------------------------------------------

function run() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--list-rules')) {
    for (const rule of RULES) console.log(`${rule.id} — ${rule.description}`);
    return 0;
  }

  const files = walk(ROOT, []).map(rel).sort();
  const parsed = new Map(files.map((file) => [file, parse(path.join(ROOT, file))]));
  const ctx = { bareWrites: [] };
  const violations = [];

  for (const rule of RULES) {
    for (const file of files) {
      if (!rule.applies(file)) continue;
      const sourceFile = parsed.get(file);
      rule.check(sourceFile, file, (v) => {
        const pos = positionOf(sourceFile, v.node);
        violations.push({
          rule: rule.id,
          file: v.file,
          line: pos.line,
          column: pos.column,
          node: nodeKind(v.node),
          snippet: preview(sourceFile, v.node),
          message: v.message,
        });
      }, ctx);
    }
  }

  // baseSeen: ровно одна голая запись во всём core/.
  const bare = ctx.bareWrites;
  if (bare.length !== 1) {
    if (bare.length === 0) {
      violations.push({
        rule: 'baseSeen-single-bare-write',
        file: 'core/content.ts',
        line: 1,
        column: 1,
        node: 'SourceFile',
        snippet: 'core/**',
        message: 'не найдена точка взвода baseSeen = true; — ожидается ровно одна',
      });
    } else {
      for (const item of bare.slice(1)) {
        const sourceFile = parsed.get(item.file);
        const pos = positionOf(sourceFile, item.node);
        violations.push({
          rule: 'baseSeen-single-bare-write',
          file: item.file,
          line: pos.line,
          column: pos.column,
          node: nodeKind(item.node),
          snippet: preview(sourceFile, item.node),
          message: `вторая голая запись baseSeen = true; (первая: ${bare[0].file}); новая точка — baseSeen = (true);`,
        });
      }
    }
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  if (args.has('--json')) {
    console.log(JSON.stringify({ root: ROOT, files: files.length, rules: RULES.map((r) => r.id), violations }, null, 2));
  } else if (violations.length === 0) {
    console.log(`architecture-lint: OK — ${RULES.length} rules, ${files.length} files, 0 violations`);
  } else {
    console.error(`architecture-lint: ${violations.length} violation(s) in ${files.length} files`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}  [${v.rule}]  ${v.node}`);
      console.error(`    ${v.message}`);
      console.error(`    ${v.snippet}`);
    }
    console.error('\nПравила и область: docs/decisions/architecture-lint.md');
  }

  return violations.length === 0 ? 0 : 1;
}

try {
  process.exitCode = run();
} catch (error) {
  console.error('architecture-lint: internal error:', error && error.stack ? error.stack : error);
  process.exitCode = 2;
}
