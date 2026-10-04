#!/usr/bin/env node
/**
 * build.mjs — Phase 2 step 1: esbuild bundler with three entry points.
 *
 * Why the entry points are *derived* instead of hardcoded:
 * this repository has no `src/` directory. The extension sources are plain
 * global-scope scripts wired together by two source-of-truth files:
 *   - manifest.json            -> background.service_worker
 *                              -> content_scripts[0].js (order-sensitive)
 *   - options/options.html     -> <script src> order (order-sensitive)
 * The bundler reads those SSOTs, concatenates each entry group into a single
 * module (one shared scope, which is what the legacy sources expect: every
 * cross-file reference is a bare identifier, not window.X) and lets esbuild
 * transpile + wrap the result. Nothing is hardcoded, so the bundles cannot
 * drift from the manifest / HTML script order.
 *
 * Outputs (dist/):
 *   background.js, content.js, options.js   (IIFE, no import/export)
 *   manifest.json, icons/**, options/options.html, options/options.css
 *   _locales/**, plus the files Chrome resolves itself at runtime (see step 2c)
 *
 * Phase 2 step 2 (rewiring): dist/ is a *complete extension root*, so that
 * "Load unpacked -> dist/" works. Two things follow from that:
 *   2b. the copies handed to Chrome are rewritten (manifest.json + options.html)
 *       so the bundles are loaded instead of the legacy global scripts;
 *   2c. the files that Chrome resolves by path at runtime — the MAIN-world
 *       interceptors registered from core/background.js and _locales/ — are
 *       copied next to the bundles. A single IIFE cannot replace those: the
 *       interceptors must run in the MAIN world at document_start, which only
 *       chrome.scripting.registerContentScripts can express.
 * The root manifest.json / options/options.html stay legacy on purpose: they are
 * frozen by the test suite (tests/manifest-smoke.test.js, tests/qwen-provider-wiring.test.js)
 * and are no longer what Chrome loads.
 *
 * Usage:
 *   node build.mjs              # dev build, sourcemaps on
 *   node build.mjs --watch      # rebuild on change (own watcher, see note below)
 *   node build.mjs --minify     # production, sourcemaps off
 *   node build.mjs --clean      # remove dist/ and exit
 *   node build.mjs --no-sourcemap
 *
 * Watch note: because the sources are fed to esbuild through `stdin`, esbuild's
 * own `ctx.watch()` has no file to watch and never fires. The dev watcher below
 * therefore tracks the SSOT-derived file set itself with fs.watch.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const WATCH = flag('--watch');
const CLEAN_ONLY = flag('--clean');
const MINIFY = flag('--minify') || process.env.NODE_ENV === 'production';
const SOURCEMAP = flag('--no-sourcemap') ? false : !MINIFY || flag('--sourcemap');

const abs = (rel) => path.join(ROOT, rel);
const rel = (abs_) => path.relative(ROOT, abs_).split(path.sep).join('/');

function fail(message) {
  console.error(`\n[build] ERROR: ${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 1. SSOT readers
 * ------------------------------------------------------------------ */

function readJSON(relPath) {
  try {
    return JSON.parse(fs.readFileSync(abs(relPath), 'utf8'));
  } catch (err) {
    fail(`cannot read JSON SSOT "${relPath}": ${err.message}`);
  }
}

/** background entry — manifest.background.service_worker */
function backgroundEntry(manifest) {
  const src = manifest?.background?.service_worker;
  if (typeof src !== 'string' || src === '') {
    fail('manifest.json: background.service_worker is missing or not a string');
  }
  return [src];
}

/** content entry — manifest.content_scripts[0].js, order preserved */
function contentEntry(manifest) {
  const groups = manifest?.content_scripts;
  if (!Array.isArray(groups) || groups.length === 0) {
    fail('manifest.json: content_scripts is missing or empty');
  }
  if (groups.length > 1) {
    fail(
      `manifest.json: expected exactly 1 content_scripts entry, found ${groups.length}. ` +
        'The single-bundle content script assumes one group — update build.mjs if that changes.'
    );
  }
  const js = groups[0]?.js;
  if (!Array.isArray(js) || js.length === 0) {
    fail('manifest.json: content_scripts[0].js is missing or empty');
  }
  return js;
}

/** options entry — <script src> order in options/options.html */
function optionsEntry() {
  const htmlPath = 'options/options.html';
  const html = fs.readFileSync(abs(htmlPath), 'utf8');
  const dir = path.dirname(abs(htmlPath));
  const re = /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi;
  const out = [];
  for (const m of html.matchAll(re)) {
    const attrs = `${m[1]} ${m[3]}`;
    const src = m[2].trim();
    if (/^[a-z]+:/i.test(src) || src.startsWith('//')) continue; // external URL
    if (/\btype\s*=\s*["']module["']/i.test(attrs)) {
      fail(
        `${htmlPath}: <script src="${src}" type="module"> — module scripts cannot be ` +
          'concatenated into the classic-scope bundle. The options bundle expects classic scripts.'
      );
    }
    out.push(rel(path.resolve(dir, src)));
  }
  if (out.length === 0) fail(`${htmlPath}: no local <script src> tags found`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. Asset copy (mirrors the repo layout under dist/)
 * ------------------------------------------------------------------ */

const ASSET_FILES = ['manifest.json', 'options/options.html', 'options/options.css'];
const ASSET_DIRS = ['icons'];
// manifest.json declares `default_locale`, so Chrome refuses to load the
// extension unless _locales/<locale>/messages.json exists next to it.
const ASSET_TREES = ['_locales'];

/* ------------------------------------------------------------------ *
 * 2b. Runtime-resolved files (Phase 2 step 2)
 *
 * core/background.js is the SSOT for the site-world (world: 'MAIN') content
 * scripts it registers programmatically via
 * chrome.scripting.registerContentScripts([... { js: [...] }]) and for the one
 * helper it pulls in with importScripts(). Chrome resolves those paths against
 * the extension root, so the files must exist verbatim next to the bundles.
 * Deriving the list from background.js keeps it in sync automatically.
 * ------------------------------------------------------------------ */

const BACKGROUND_SRC = 'core/background.js';

function runtimeRegisteredFiles() {
  const src = fs.readFileSync(abs(BACKGROUND_SRC), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/\bjs\s*:\s*\[([^\]]*)\]/g)) {
    for (const quoted of m[1].matchAll(/["']([^"']+)["']/g)) out.add(quoted[1]);
  }
  for (const m of src.matchAll(/importScripts\(\s*["']([^"']+)["']\s*\)/g)) {
    out.add(m[1].replace(/^\/+/, ''));
  }
  if (out.size === 0) {
    fail(`${BACKGROUND_SRC}: no registerContentScripts js[] / importScripts path found`);
  }
  return [...out].sort();
}

/* ------------------------------------------------------------------ *
 * 2c. Dist rewiring (Phase 2 step 2)
 *
 * The copies made above are the *source* layout: legacy global scripts wired
 * together by manifest/HTML order. What actually runs is the bundled layout, so
 * the copies handed to Chrome are rewritten to point at the bundles.
 * ------------------------------------------------------------------ */

const REWIRED_SERVICE_WORKER = 'background.js';
const REWIRED_CONTENT_SCRIPTS = ['content.js'];
const REWIRED_OPTIONS_SCRIPT = '../options.js';
// A local (non-URL) classic <script src="...">...</script> tag, with its indent
// and to end of line, so removing the legacy tags leaves no blank lines behind.
const LOCAL_SCRIPT_TAG =
  /[ \t]*<script\b[^>]*\bsrc\s*=\s*["'](?!https?:|\/\/)[^"']+["'][^>]*>\s*<\/script>[ \t]*\r?\n?/gi;

function rewireManifestText(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    fail(`dist/manifest.json is not valid JSON: ${err.message}`);
  }
  const out = JSON.parse(JSON.stringify(manifest));
  if (!out.background || typeof out.background !== 'object') {
    fail('dist/manifest.json: background is missing');
  }
  out.background.service_worker = REWIRED_SERVICE_WORKER;
  // The background bundle is an IIFE, not an ES module: stay classic. No
  // top-level await is needed and classic is simpler for the MV3 worker lifecycle.
  delete out.background.type;
  if (!Array.isArray(out.content_scripts) || out.content_scripts.length === 0) {
    fail('dist/manifest.json: content_scripts is missing or empty');
  }
  out.content_scripts[0].js = [...REWIRED_CONTENT_SCRIPTS];
  return JSON.stringify(out, null, 2) + '\n';
}

function rewireOptionsHtmlText(text) {
  let inserted = false;
  const out = text.replace(LOCAL_SCRIPT_TAG, (tag) => {
    if (inserted) return '';
    inserted = true;
    const indent = (tag.match(/^[ \t]*/) || [''])[0];
    return `${indent}<script src="${REWIRED_OPTIONS_SCRIPT}"></script>\n`;
  });
  if (!inserted) fail('dist/options/options.html: no local <script src> tag to replace');
  return out;
}

async function rewireDist() {
  const manifestPath = path.join(DIST, 'manifest.json');
  const htmlPath = path.join(DIST, 'options', 'options.html');
  await fsp.writeFile(manifestPath, rewireManifestText(await fsp.readFile(manifestPath, 'utf8')));
  await fsp.writeFile(htmlPath, rewireOptionsHtmlText(await fsp.readFile(htmlPath, 'utf8')));
  return ['manifest.json (rewired)', 'options/options.html (rewired)'];
}

/* ------------------------------------------------------------------ *
 * 3. Entry assembly (concat into one shared scope)
 * ------------------------------------------------------------------ */

function readSources(entryRelPaths) {
  const parts = [];
  let bytes = 0;
  for (const r of entryRelPaths) {
    const file = abs(r);
    if (!fs.existsSync(file)) {
      fail(`entry "${r}" is referenced by the SSOT but does not exist: ${file}`);
    }
    let src = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!src.endsWith('\n')) src += '\n';
    parts.push(`/* ==== ${r} ==== */\n${src}`);
    bytes += Buffer.byteLength(src);
  }
  return { contents: parts.join('\n'), bytes };
}

function collectEntries() {
  const manifest = readJSON('manifest.json');
  return {
    background: backgroundEntry(manifest),
    content: contentEntry(manifest),
    options: optionsEntry(),
  };
}

async function copyTree(fromRel, toAbs) {
  const copied = [];
  const walk = async (dir, relDir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), relPath);
      } else if (e.isFile()) {
        const to = path.join(toAbs, relPath);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(path.join(dir, e.name), to);
        copied.push(`${fromRel}/${relPath}`);
      }
    }
  };
  await walk(abs(fromRel), '');
  return copied;
}

async function copyAssets() {
  const copied = [];
  for (const r of ASSET_FILES) {
    const from = abs(r);
    if (!fs.existsSync(from)) fail(`asset "${r}" is missing`);
    const to = path.join(DIST, r);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    copied.push(r);
  }
  for (const r of ASSET_DIRS) {
    const from = abs(r);
    if (!fs.existsSync(from)) fail(`asset directory "${r}" is missing`);
    for (const e of await fsp.readdir(from, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const to = path.join(DIST, r, e.name);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(path.join(from, e.name), to);
      copied.push(`${r}/${e.name}`);
    }
  }
  for (const r of ASSET_TREES) {
    if (!fs.existsSync(abs(r))) fail(`asset tree "${r}" is missing`);
    copied.push(...(await copyTree(r, path.join(DIST, r))));
  }
  for (const r of runtimeRegisteredFiles()) {
    const from = abs(r);
    if (!fs.existsSync(from)) {
      fail(`"${r}" is registered at runtime by ${BACKGROUND_SRC} but does not exist`);
    }
    const to = path.join(DIST, r);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    copied.push(r);
  }
  copied.push(...(await rewireDist()));
  return copied;
}

/* ------------------------------------------------------------------ *
 * 4. Post-build verification
 * ------------------------------------------------------------------ */

async function verify(outputs) {
  const problems = [];
  for (const { name, outfile } of outputs) {
    if (!fs.existsSync(outfile)) {
      problems.push(`${name}: expected output ${rel(outfile)} was not written`);
      continue;
    }
    const text = await fsp.readFile(outfile, 'utf8');
    // Content scripts are classic scripts: any import/export is a hard error.
    if (/^\s*(?:import|export)\b/m.test(text)) {
      problems.push(`${name}: bundle contains a top-level import/export (must be IIFE)`);
    }
    if (/\bexport\s*[{(]/.test(text)) {
      problems.push(`${name}: bundle contains an export list (must be IIFE)`);
    }
    if (/\bimport\s*\(/.test(text)) {
      problems.push(`${name}: bundle contains a dynamic import()`);
    }
    if (SOURCEMAP && !text.includes('sourceMappingURL')) {
      problems.push(`${name}: sourcemap requested but no sourceMappingURL comment in the bundle`);
    }
    console.log(`  ✓ ${rel(outfile)} (${Buffer.byteLength(text).toLocaleString('en-US')} bytes)`);
  }
  if (problems.length) fail(problems.join('\n  '));
}

/* ------------------------------------------------------------------ *
 * 4b. Dist verification (Phase 2 step 2): what Chrome will load
 * ------------------------------------------------------------------ */

const REQUIRED_DIST_FILES = [
  'manifest.json',
  'options/options.html',
  'options/options.css',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  '_locales/ru/messages.json',
  '_locales/en/messages.json',
];

async function collectDistJs(dir = DIST, relDir = '') {
  const found = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const relPath = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) found.push(...(await collectDistJs(path.join(dir, e.name), relPath)));
    else if (e.isFile() && e.name.endsWith('.js')) found.push(relPath);
  }
  return found.sort();
}

async function verifyDist() {
  const problems = [];

  const manifest = JSON.parse(await fsp.readFile(path.join(DIST, 'manifest.json'), 'utf8'));
  if (manifest?.background?.service_worker !== REWIRED_SERVICE_WORKER) {
    problems.push(
      `dist/manifest.json: background.service_worker is ${JSON.stringify(manifest?.background?.service_worker)}, ` +
        `expected "${REWIRED_SERVICE_WORKER}"`
    );
  }
  if ('type' in (manifest?.background || {})) {
    problems.push('dist/manifest.json: background.type must stay unset (classic service worker)');
  }
  const js = manifest?.content_scripts?.[0]?.js;
  if (JSON.stringify(js) !== JSON.stringify(REWIRED_CONTENT_SCRIPTS)) {
    problems.push(
      `dist/manifest.json: content_scripts[0].js is ${JSON.stringify(js)}, ` +
        `expected ${JSON.stringify(REWIRED_CONTENT_SCRIPTS)}`
    );
  }

  const html = await fsp.readFile(path.join(DIST, 'options', 'options.html'), 'utf8');
  const localTags = [...html.matchAll(LOCAL_SCRIPT_TAG)];
  if (localTags.length !== 1) {
    problems.push(`dist/options/options.html: expected exactly 1 local <script src>, found ${localTags.length}`);
  } else if (!localTags[0][0].includes(`<script src="${REWIRED_OPTIONS_SCRIPT}"></script>`)) {
    problems.push(`dist/options/options.html: local script tag is not <script src="${REWIRED_OPTIONS_SCRIPT}">`);
  }
  for (const stale of ['../utils/', '../adapters/', '../core/', 'i18n-apply.js']) {
    if (html.includes(stale)) {
      problems.push(`dist/options/options.html: still references the legacy source path "${stale}"`);
    }
  }

  // dist/ must not carry legacy entry files: only the three bundles, plus the
  // files Chrome resolves by path at runtime (see runtimeRegisteredFiles).
  const expected = new Set(['background.js', 'content.js', 'options.js', ...runtimeRegisteredFiles()]);
  const actual = new Set(await collectDistJs());
  for (const f of actual) {
    if (!expected.has(f)) problems.push(`dist/${f}: legacy .js file left in the bundle output`);
  }
  for (const f of expected) {
    if (!actual.has(f)) problems.push(`dist/${f}: missing (referenced by Chrome at runtime)`);
  }

  for (const r of REQUIRED_DIST_FILES) {
    if (!fs.existsSync(path.join(DIST, r))) problems.push(`dist/${r}: missing`);
  }

  if (problems.length) fail(problems.join('\n  '));
  console.log(
    `  ✓ dist/ verified: ${actual.size} .js files (3 bundles + ${actual.size - 3} runtime-registered)`
  );
}

/* ------------------------------------------------------------------ *
 * 5. Build
 * ------------------------------------------------------------------ */

async function buildOnce(entries, { quiet = false } = {}) {
  await fsp.mkdir(DIST, { recursive: true });

  const outputs = [];

  // Drop stale artifacts of the targets we are about to write, so switching
  // between dev and prod cannot leave an orphaned (and stale) sourcemap behind.
  for (const name of Object.keys(entries)) {
    for (const stale of [`${name}.js`, `${name}.js.map`]) {
      await fsp.rm(path.join(DIST, stale), { force: true });
    }
  }

  for (const [name, list] of Object.entries(entries)) {
    const outfile = path.join(DIST, `${name}.js`);
    const { contents, bytes } = readSources(list);
    if (!quiet) console.log(`[build] ${name}: ${bytes.toLocaleString('en-US')} source bytes (${list.length} files)`);

    await esbuild.build({
      // Concatenated sources are handed to esbuild through stdin so that no
      // generated entry file ever lands in the repository.
      stdin: { contents, resolveDir: ROOT, sourcefile: `${name}.js`, loader: 'js' },
      outfile,
      format: 'iife', // classic script: MV3 content scripts / non-module manifest
      bundle: true,
      platform: 'browser',
      target: 'es2020',
      sourcemap: SOURCEMAP,
      minify: MINIFY,
      external: [],
      legalComments: 'none',
      logLevel: 'warning',
    });
    outputs.push({ name, outfile });
  }

  const copied = await copyAssets();
  if (!quiet) {
    console.log(`[build] mode=${MINIFY ? 'production' : 'development'} sourcemap=${SOURCEMAP}`);
    console.log(`[build] ${copied.length} asset file(s) copied into dist/`);
  }
  await verify(outputs);
  await verifyDist();
}

/* ------------------------------------------------------------------ *
 * 6. Dev watcher (esbuild cannot watch stdin)
 * ------------------------------------------------------------------ */

function startWatcher() {
  const targets = new Map(); // dir -> { names: Set<string>, all: boolean }

  const watchFile = (relPath) => {
    const file = abs(relPath);
    const dir = path.dirname(file);
    if (!targets.has(dir)) targets.set(dir, { names: new Set(), all: false });
    targets.get(dir).names.add(path.basename(file));
  };

  const refreshTargets = () => {
    targets.clear();
    watchFile('manifest.json');
    for (const r of ASSET_FILES) watchFile(r);
    for (const list of Object.values(collectEntries())) for (const r of list) watchFile(r);
    // runtime-registered files are copied verbatim, so a change must rebuild too
    for (const r of runtimeRegisteredFiles()) watchFile(r);
    // whole icons/ and _locales/ directories: a newly added file should rebuild
    targets.set(abs('icons'), { names: new Set(), all: true });
    targets.set(abs('_locales'), { names: new Set(), all: true });
  };

  refreshTargets();

  let timer = null;
  const schedule = (reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const stamp = new Date().toLocaleTimeString('en-GB');
      console.log(`\n[build ${stamp}] change detected (${reason}) — rebuilding…`);
      try {
        refreshTargets();
        await buildOnce(collectEntries());
        console.log(`[build ${stamp}] rebuild done. watching…`);
      } catch (err) {
        // keep watching: a broken edit must not kill the dev loop
        console.error(`[build] rebuild failed: ${err.message}\n[build] still watching…`);
      }
    }, 120);
  };

  for (const [dir, { names, all }] of targets) {
    // `all` marks a whole-directory target (icons/, _locales/): watch it
    // recursively, otherwise a change inside _locales/<locale>/messages.json
    // never reaches the callback. The repo root and options/ are watched
    // per-file (names), so they must stay non-recursive.
    fs.watch(dir, { persistent: true, recursive: all }, (event, filename) => {
      if (all || !filename) schedule(`${path.basename(dir)}/${filename || '*'}`);
      else if (names.has(filename)) schedule(rel(path.join(dir, filename)));
    });
  }

  const stop = () => {
    console.log('\n[build] watcher stopped.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/* ------------------------------------------------------------------ */

async function main() {
  if (CLEAN_ONLY) {
    await fsp.rm(DIST, { recursive: true, force: true });
    console.log('[build] removed dist/');
    return;
  }

  const entries = collectEntries();
  console.log('[build] entries derived from SSOTs:');
  for (const [name, list] of Object.entries(entries)) console.log(`  ${name} <- ${list.length} file(s)`);
  console.log(`  runtime-registered <- ${runtimeRegisteredFiles().length} file(s) (copied verbatim)`);

  await buildOnce(entries);

  if (WATCH) {
    startWatcher();
    console.log('[build] watching for changes…');
  } else {
    console.log('[build] done.');
  }
}

main().catch((err) => fail(err.stack || String(err)));
