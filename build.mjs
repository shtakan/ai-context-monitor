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

  await copyAssets();
  if (!quiet) {
    console.log(`[build] mode=${MINIFY ? 'production' : 'development'} sourcemap=${SOURCEMAP}`);
  }
  await verify(outputs);
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
    // whole icons/ directory: a newly added icon should also rebuild
    targets.set(abs('icons'), { names: new Set(), all: true });
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
    fs.watch(dir, { persistent: true }, (event, filename) => {
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

  await buildOnce(entries);

  if (WATCH) {
    startWatcher();
    console.log('[build] watching for changes…');
  } else {
    console.log('[build] done.');
  }
}

main().catch((err) => fail(err.stack || String(err)));
