#!/usr/bin/env node
'use strict';

/**
 * Mutation check for the source pins of ADR docs/decisions/context-snapshot.md §7.
 *
 * Eight pins, eight mutations. Each mutation is applied to the working copy of a
 * product file, the owning test file is run, and the working copy is restored in a
 * finally block (byte-for-byte). No git stash, no commits, no writes outside the
 * working copy and %TEMP%.
 *
 * Baseline: owning test must be green BEFORE the mutation, otherwise ERROR (no false KILLED).
 * Postflight: after restore the same tests are run together and must be green, otherwise exit 2.
 *
 * Usage:
 *   node tools/mutation-check.js              # M1..M8
 *   node tools/mutation-check.js --only M8    # run a deferred mutation explicitly
 *   node tools/mutation-check.js --only M1,M3
 *   node tools/mutation-check.js --list
 *
 * Exit codes: 0 = every executed mutation KILLED, 1 = SURVIVED, 2 = preflight/error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const JEST_BIN = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
const TIMEOUT_MS = 180000;

const MUTATIONS = [
  {
    id: 'M1',
    pin: 'o23',
    file: 'core/content.ts',
    anchor: '683',
    test: 'tests/o23-tokens-calibration.test.js',
    find: '  var tokens = serverTokens > 0 ? serverTokens : aiCmCanonicalTokens(text, 0, msgs);',
    replace: '  var tokens = aiCmCanonicalTokens(text, 0, msgs);',
  },
  {
    id: 'M2',
    pin: 'o47',
    file: 'core/content.ts',
    anchor: '2293',
    test: 'tests/o47-qwen-badge-metric.test.js',
    find: "  if (svc === 'qwen') return 0;",
    replace: "  if (svc === 'qwen') return 1;",
  },
  {
    id: 'M3',
    pin: 'gemini-monotonic',
    file: 'core/export-manager.ts',
    anchor: '1898-1900',
    test: 'tests/gemini-monotonic-badge.test.js',
    find: [
      '        var snapTokens = (snapR1Auto && typeof snapR1Auto.tokens === \'number\')',
      '          ? snapR1Auto.tokens',
      '          : ((typeof maxTokenCount === \'number\') ? maxTokenCount : 0);',
    ].join('\n'),
    replace: '        var snapTokens = (typeof maxTokenCount === \'number\') ? maxTokenCount : 0;',
  },
  {
    id: 'M4',
    pin: 'gemini-source-tier',
    file: 'utils/export-text-builders.ts',
    anchor: '448',
    test: 'tests/gemini-source-tier.test.js',
    find: "    lines.push('metric-src: ' + h.src);",
    replace: "    lines.push('metric-src:' + h.src);",
  },
  {
    id: 'M5',
    pin: 'o32',
    file: 'core/content.ts',
    anchor: '2890',
    test: 'tests/o32-gsa-canonical-thread-invariant.test.js',
    find: '    maxTokenCount = tokenEstimate;',
    replace: '    maxTokenCount = Math.max(maxTokenCount, tokenEstimate);',
  },
  {
    id: 'M6',
    pin: 'o14',
    file: 'core/widget.ts',
    anchor: '420',
    test: 'tests/o14-reset-popup-snapshot.test.js',
    find: "      chrome.storage.local.remove(['aiCmState', 'aiCmState:' + window.location.hostname]);",
    replace: "      chrome.storage.local.remove(['aiCmState']);",
  },
  {
    id: 'M7',
    pin: 'badge-suppress',
    file: 'core/export-manager.ts',
    anchor: '2306-2307',
    test: 'tests/badge-suppress-adapter-base-v54.test.js',
    find: [
      '  var userOn = (typeof aiCmIncludeHiddenInExport !== \'undefined\') && aiCmIncludeHiddenInExport === true;',
      '  var hiddenEffective = (typeof aiCmHiddenExportEffectiveOn === \'function\')',
    ].join('\n'),
    replace: [
      '  var userOn = (typeof aiCmIncludeHiddenInExport !== \'undefined\') && aiCmIncludeHiddenInExport === true;',
      '  var adapterSeenGate = (typeof adapterBaseSeen !== \'undefined\') && adapterBaseSeen === true;',
      '  var hiddenEffective = (typeof aiCmHiddenExportEffectiveOn === \'function\')',
    ].join('\n'),
  },
  {
    id: 'M8',
    pin: 'inv-i3',
    file: 'core/export-manager.ts',
    anchor: '2299',
    test: 'tests/inv-i3-export-projection.test.js',
    // Reference to a name that FN_NAMES still injects in S6.1: SURVIVED by design.
    // After the S6.2 prune the sandbox no longer defines it -> ReferenceError -> KILLED.
    find: 'function aiCmProjectFileMessages(msgs, site) {',
    replace: 'function aiCmProjectFileMessages(msgs, site) {\n  var __m8Pruned = aiCmPrepareReasoningForExport;',
  },
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: null, timeout: 60000 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' -> exit ' + res.status + ': ' + res.stderr.toString().trim());
  }
  return res.stdout;
}

function getOnly(argv) {
  let raw = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && i + 1 < argv.length) raw = argv[i + 1];
    else if (argv[i].indexOf('--only=') === 0) raw = argv[i].slice('--only='.length);
  }
  if (!raw) return null;
  const ids = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const known = new Set(MUTATIONS.map((m) => m.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error('unknown mutation id(s): ' + unknown.join(', ') + ' (known: ' + [...known].join(', ') + ')');
  }
  return new Set(ids);
}

function preflight(mutations) {
  const files = [...new Set(mutations.map((m) => m.file))];
  for (const file of files) {
    const status = git(['status', '--porcelain', '--', file]).toString().trim();
    if (status) {
      throw new Error('preflight: working copy is dirty: ' + file + '\n' + status);
    }
    const head = git(['show', 'HEAD:' + file]);
    const disk = fs.readFileSync(path.join(ROOT, file));
    if (!head.equals(disk)) {
      throw new Error('preflight: working copy differs from HEAD: ' + file +
        ' (HEAD ' + sha256(head).slice(0, 12) + ', disk ' + sha256(disk).slice(0, 12) + ')');
    }
  }
  return files;
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function runJest(tests) {
  const list = Array.isArray(tests) ? tests : [tests];
  const res = spawnSync(process.execPath, [JEST_BIN].concat(list, ['--runInBand', '--silent', '--ci']), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: Object.assign({}, process.env, { CI: '1', FORCE_COLOR: '0' }),
  });
  return res; // вызывающий смотрит res.error и res.status
}

function runMutation(m) {
  const abs = path.join(ROOT, m.file);
  const original = fs.readFileSync(abs);
  const originalText = original.toString('utf8');
  const occurrences = originalText.split(m.find).length - 1;
  if (occurrences !== 1) {
    return { status: 'ERROR', detail: 'anchor found ' + occurrences + ' time(s), expected 1' };
  }

  const base = runJest(m.test);
  if (base.error || base.status !== 0) {
    return { status: 'ERROR', detail: 'baseline red (jest exit ' + (base.error ? 'spawn' : base.status) + ')' };
  }

  const stamp = crypto.createHash('sha1')
    .update(m.id + '|' + m.file + '|' + Date.now() + '|' + Math.random())
    .digest('hex').slice(0, 12);
  const backupDir = path.join(os.tmpdir(), 'ai-cm-mut', stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(m.file));
  fs.writeFileSync(backupPath, original);

  const started = Date.now();
  let result;
  try {
    fs.writeFileSync(abs, originalText.replace(m.find, m.replace), 'utf8');
    const res = runJest(m.test);
    if (res.error) {
      result = { status: 'ERROR', detail: String(res.error.message || res.error) };
    } else if (res.status === 0) {
      result = { status: 'SURVIVED', detail: 'jest exit 0' };
    } else {
      result = { status: 'KILLED', detail: 'jest exit ' + res.status };
    }
  } finally {
    fs.writeFileSync(abs, original);
    const restored = fs.readFileSync(abs);
    if (!restored.equals(original)) {
      throw new Error('RESTORE FAILED: ' + m.file + ' (backup: ' + backupPath + ')');
    }
  }

  result.ms = Date.now() - started;
  result.sha = sha256(original).slice(0, 12);
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tools/mutation-check.js [--only M1,M3] [--list]');
    return 0;
  }
  if (argv.includes('--list')) {
    for (const m of MUTATIONS) {
      console.log(pad(m.id, 4) + pad(m.pin, 21) + pad(m.file + ':' + m.anchor, 34) + m.test +
        (m.deferred ? '  [deferred ' + m.deferred + ']' : ''));
    }
    return 0;
  }

  const only = getOnly(argv);
  const selected = only
    ? MUTATIONS.filter((m) => only.has(m.id))
    : MUTATIONS.filter((m) => !m.deferred);

  if (!selected.length) {
    console.log('nothing selected');
    return 2;
  }

  console.log('mutation-check: ' + selected.length + ' selected, ' +
    (MUTATIONS.length - selected.length) + ' not selected');
  const checkedFiles = preflight(selected);
  console.log('preflight: ' + [...new Set(selected.map((m) => m.file))].join(', ') + ' == HEAD');
  let killed = 0;
  let survived = 0;
  let errors = 0;
  for (const m of selected) {
    process.stdout.write(pad(m.id, 4) + pad(m.pin, 21) + pad(m.file + ':' + m.anchor, 34) + m.test + '  ... ');
    let result;
    try {
      result = runMutation(m);
    } catch (err) {
      result = { status: 'ERROR', detail: err.message };
    }
    if (result.status === 'KILLED') killed++;
    else if (result.status === 'SURVIVED') survived++;
    else errors++;
    console.log(pad(result.status, 10) + (result.ms ? result.ms + 'ms' : '') +
      (result.status === 'KILLED' ? '' : '  ' + result.detail));
  }

  const dirty = git(['status', '--porcelain', '--'].concat(checkedFiles)).toString().trim();
  if (dirty) {
    console.error('postflight: working copies dirty after restore:\n' + dirty);
    return 2;
  }

  const testsRun = [...new Set(selected.map((m) => m.test))];
  if (!dirty && testsRun.length) {
    const after = runJest(testsRun);
    if (after.error || after.status !== 0) {
      console.error('postflight: restored tree is red (jest exit ' + (after.error ? 'spawn' : after.status) + ')');
      return 2;
    }
  }

  const deferred = MUTATIONS.filter((m) => m.deferred && !selected.includes(m));
  const skipped = MUTATIONS.filter((m) => !m.deferred && !selected.includes(m));
  for (const m of deferred) {
    console.log(pad(m.id, 4) + pad(m.pin, 21) + pad(m.file + ':' + m.anchor, 34) + m.test +
      '  DEFERRED ' + m.deferred + ' (run with --only ' + m.id + ')');
  }

  console.log('matrix: ' + killed + ' KILLED / ' + survived + ' SURVIVED / ' + errors + ' ERROR / ' +
    deferred.length + ' DEFERRED / ' + skipped.length + ' NOT SELECTED');
  if (errors) return 2;
  if (survived) return 1;
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error('mutation-check: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 2;
}
