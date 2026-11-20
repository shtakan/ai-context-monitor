#!/usr/bin/env node
'use strict';

/**
 * tools/accept-compare.js — машинные критерии K1/K2 для парных экспортов 2.2.
 *
 * K1: канонически равны (deep-equal JSON) после удаления волатильных полей
 *     (`exportedAt` по умолчанию). Побайтовое равенство невозможно: таймстамп
 *     всегда новый, поэтому критерий сформулирован по содержимому.
 * K2: совпадает последовательность ролей (roleHash) и счётчики user/assistant.
 *
 * Запуск:
 *   node tools/accept-compare.js before.json after.json
 *   node tools/accept-compare.js a.json b.json --ignore=exportedAt,updatedAt --json
 *
 * Выход: 0 — K1 && K2, 1 — расхождение, 2 — ошибка запуска.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_IGNORED = ['exportedAt'];

function fnv1a32(input) {
  const str = String(input == null ? '' : input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  let hex = (hash >>> 0).toString(16);
  while (hex.length < 8) hex = '0' + hex;
  return hex;
}

/** Хэш последовательности ролей: 'u'/'a', без текста. */
function roleHashOf(messages) {
  let seq = '';
  if (Array.isArray(messages)) {
    for (const m of messages) seq += (m && m.role === 'user') ? 'u' : 'a';
  }
  return fnv1a32(seq);
}

function roleCounts(messages) {
  let user = 0;
  let assistant = 0;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && m.role === 'user') user++;
      else assistant++;
    }
  }
  return { user, assistant };
}

/** Глубокая копия без перечисленных ключей (для exportedAt/updatedAt и т.п.). */
function stripFields(value, fields) {
  const drop = new Set(fields || []);
  function walk(v) {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const key of Object.keys(v)) {
      if (drop.has(key)) continue;
      out[key] = walk(v[key]);
    }
    return out;
  }
  return walk(value);
}

/** Стабильная сериализация: ключи объектов отсортированы, массивы — в порядке. */
function stableStringify(value) {
  function walk(v) {
    if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
    if (v && typeof v === 'object') {
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + walk(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }
  return walk(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Первый путь расхождения (для отчёта), либо null. */
function firstDiffPath(a, b, prefix) {
  const at = prefix || '$';
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return at + '.length (' + a.length + ' != ' + b.length + ')';
    for (let i = 0; i < a.length; i++) {
      const d = firstDiffPath(a[i], b[i], at + '[' + i + ']');
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of Array.from(keys).sort()) {
      const d = firstDiffPath(a[k], b[k], at + '.' + k);
      if (d) return d;
    }
    return null;
  }
  if (a === b) return null;
  return at + ' (' + JSON.stringify(a) + ' != ' + JSON.stringify(b) + ')';
}

/**
 * Сравнение двух экспортов.
 * @param {object} a первый JSON
 * @param {object} b второй JSON
 * @param {{ignore?: string[]}} [options] поля, исключаемые из K1
 * @returns {object} критерии и доказательства
 */
function compareExports(a, b, options) {
  const ignore = (options && options.ignore) || DEFAULT_IGNORED;
  const ca = stripFields(a, ignore);
  const cb = stripFields(b, ignore);
  const jsonA = stableStringify(ca);
  const jsonB = stableStringify(cb);
  const messagesA = Array.isArray(a && a.messages) ? a.messages : [];
  const messagesB = Array.isArray(b && b.messages) ? b.messages : [];
  const roleHashA = roleHashOf(messagesA);
  const roleHashB = roleHashOf(messagesB);
  const countsA = roleCounts(messagesA);
  const countsB = roleCounts(messagesB);
  return {
    k1: jsonA === jsonB,
    k2: roleHashA === roleHashB &&
      countsA.user === countsB.user &&
      countsA.assistant === countsB.assistant,
    ignored: ignore.slice(),
    messages: {
      a: messagesA.length,
      b: messagesB.length
    },
    roles: {
      a: countsA,
      b: countsB,
      hashA: roleHashA,
      hashB: roleHashB
    },
    sha256: {
      a: sha256(jsonA),
      b: sha256(jsonB)
    },
    firstDiff: jsonA === jsonB ? null : firstDiffPath(ca, cb, '$')
  };
}

function formatReport(result) {
  const lines = [];
  lines.push('K1 canonical equal (ignore: ' + result.ignored.join(',') + '): ' + (result.k1 ? 'equal' : 'DIFF'));
  lines.push('K2 role sequence: ' + (result.k2 ? 'equal' : 'DIFF') +
    ' (a=' + result.roles.a.user + 'u/' + result.roles.a.assistant + 'a ' + result.roles.hashA +
    ', b=' + result.roles.b.user + 'u/' + result.roles.b.assistant + 'a ' + result.roles.hashB + ')');
  lines.push('messages: a=' + result.messages.a + ' b=' + result.messages.b);
  lines.push('sha256(canonical): a=' + result.sha256.a + ' b=' + result.sha256.b);
  if (result.firstDiff) lines.push('first diff: ' + result.firstDiff);
  return lines.join('\n');
}

function parseArgs(argv) {
  const files = [];
  let ignore = DEFAULT_IGNORED.slice();
  let json = false;
  let roleHashOnly = false;
  for (const arg of argv) {
    if (arg === '--json') { json = true; continue; }
    if (arg === '--role-hash') { roleHashOnly = true; continue; }
    if (arg.startsWith('--ignore=')) {
      const rest = arg.slice('--ignore='.length).trim();
      ignore = rest ? rest.split(',').map((s) => s.trim()).filter(Boolean) : [];
      continue;
    }
    if (arg.startsWith('--')) throw new Error('unknown option: ' + arg);
    files.push(arg);
  }
  if (roleHashOnly) {
    if (files.length !== 1) throw new Error('usage: node tools/accept-compare.js --role-hash <export.json>');
  } else if (files.length !== 2) {
    throw new Error('usage: node tools/accept-compare.js <a.json> <b.json> [--ignore=fields] [--json]');
  }
  return { files, ignore, json, roleHashOnly };
}

/** Роли одного экспорта: счётчики и roleHash (для сверки с dual-run). */
function roleReport(doc) {
  const messages = Array.isArray(doc && doc.messages) ? doc.messages : [];
  const counts = roleCounts(messages);
  return {
    messages: messages.length,
    user: counts.user,
    assistant: counts.assistant,
    roleHash: roleHashOf(messages),
    roles: messages.map((m) => (m && m.role === 'user') ? 'u' : 'a').join('')
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e && e.message ? e.message : e));
    return 2;
  }
  try {
    if (args.roleHashOnly) {
      const doc = JSON.parse(fs.readFileSync(path.resolve(args.files[0]), 'utf8'));
      const report = roleReport(doc);
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log('messages=' + report.messages +
          ' ' + report.user + 'u/' + report.assistant + 'a' +
          ' roleHash=' + report.roleHash +
          ' roles=' + report.roles);
      }
      return 0;
    }
    const a = JSON.parse(fs.readFileSync(path.resolve(args.files[0]), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.resolve(args.files[1]), 'utf8'));
    const result = compareExports(a, b, { ignore: args.ignore });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatReport(result));
    return (result.k1 && result.k2) ? 0 : 1;
  } catch (e) {
    console.error('accept-compare: ' + (e && e.stack ? e.stack : e));
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_IGNORED,
  roleHashOf,
  roleCounts,
  stripFields,
  stableStringify,
  sha256,
  firstDiffPath,
  compareExports,
  formatReport,
  roleReport
};
