#!/usr/bin/env node
/**
 * content-function-hash — sha256 тел top-level функций.
 *
 * Для move-only декомпозиции core/content.ts: снять хеши ДО переноса, снять
 * ПОСЛЕ на новом файле и сверить по имени. Совпало — тело функции не менялось.
 *
 * Usage:
 *   node tools/content-function-hash.mjs core/content.ts
 *   node tools/content-function-hash.mjs core/content.ts core/content-pdf.ts --json
 *
 * В тело не входят сигнатура, отступы вокруг и комментарии перед функцией;
 * входят комментарии внутри тела. CRLF нормализуется в LF.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export function functionHashes(file) {
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = [];
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name || !st.body) continue;
    const start = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    const body = st.body.getText(sf).replace(/\r\n/g, '\n');
    out.push({
      name: st.name.text,
      start,
      end,
      hash: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

function main(args) {
  const asJson = args.includes('--json');
  const files = args.filter(function (a) { return a.indexOf('--') !== 0; });
  if (!files.length) files.push('core/content.ts');

  const rows = [];
  files.forEach(function (file) {
    functionHashes(file).forEach(function (row) {
      rows.push({ file: file, name: row.name, start: row.start, end: row.end, hash: row.hash });
    });
  });

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  rows.forEach(function (row) {
    console.log(row.hash + '  ' + row.name + '  ' + row.file + ':' + row.start + '-' + row.end);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
