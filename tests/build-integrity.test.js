/**
 * build-integrity (stage 0): the generated esbuild entry files keep their
 * sources in SSOT order.
 *
 * build.mjs no longer feeds the bundle sources to esbuild through `stdin`: it
 * materialises one entry file per bundle (`.build/entry-<name>.js`) and builds
 * it as an `entryPoints` input. The order inside those files is load-bearing —
 * the sources are classic scripts that share ONE scope and call each other by
 * bare identifier, so a reordering changes behaviour while every bundle still
 * builds and every other test stays green. This test therefore re-derives the
 * expected order from the same SSOTs the build reads and compares it with the
 * marker sequence actually written into `.build/entry-<name>.js`.
 *
 * The entry files are generated with `node build.mjs --write-entries`, which
 * only (re)writes `.build/entry-*.js` and does not touch dist/ — so the check
 * is cheap and cannot race a real build.
 *
 * Note on `MAIN_WORLD_FILES`: no such list exists in this repository (it is not
 * exported anywhere and not defined in PROJECT_HANDOFF.md). The global,
 * order-sensitive list this stage can verify is
 * `manifest.content_scripts[0].js` — the bundle that becomes one content script
 * in the manifest — and it is asserted file-by-file below.
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, '.build');

jest.setTimeout(120000);

/** `/* ==== utils/platform.js ==== *\/` — the delimiter build.mjs emits. */
const MARKER_RE = /^\/\* ==== (.+?) ==== \*\/$/;

function entryFile(name) {
  return path.join(BUILD_DIR, `entry-${name}.js`);
}

function markers(name) {
  const file = entryFile(name);
  expect(fs.existsSync(file)).toBe(true);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => MARKER_RE.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** Local <script src> order of a legacy page, resolved to repo-relative paths. */
function htmlScripts(htmlRelPath) {
  const html = fs.readFileSync(path.join(ROOT, htmlRelPath), 'utf8');
  const dir = path.dirname(path.join(ROOT, htmlRelPath));
  const re = /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi;
  const out = [];
  for (const m of html.matchAll(re)) {
    const src = m[2].trim();
    if (/^[a-z]+:/i.test(src) || src.startsWith('//')) continue; // external URL
    if (/\btype\s*=\s*["']module["']/i.test(`${m[1]} ${m[3]}`)) {
      throw new Error(`${htmlRelPath}: <script src="${src}" type="module"> cannot be concatenated`);
    }
    out.push(path.relative(ROOT, path.resolve(dir, src)).split(path.sep).join('/'));
  }
  return out;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/**
 * Expected order per bundle, derived independently of build.mjs:
 * the SSOTs plus the background prelude declared in build.mjs (duplicating that
 * one list here is what makes a silent prelude reshuffle fail).
 *
 * Ph2, шаг gemini-intercept-logic.js: модуль ушёл из текстовой склейки в статический
 * import из core/background.js (заодно с уходом из prelude файл перестал быть
 * classic-скриптом в SW), поэтому в prelude остался только pdf-parser.
 */
const BACKGROUND_PRELUDE = ['core/pdf-parser.js'];

const EXPECTED = {
  background: [...BACKGROUND_PRELUDE, manifest.background.service_worker],
  content: manifest.content_scripts[0].js,
  options: htmlScripts('options/options.html'),
  print: htmlScripts('print/print.html'),
  'shared-i18n': htmlScripts('privacy/privacy.html'),
};

beforeAll(() => {
  const out = execFileSync(process.execPath, ['build.mjs', '--write-entries'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 110000,
  });
  expect(out).toContain('entry files written');
});

describe('build-integrity: generated entry files', () => {
  it('generates one entry file per bundle', () => {
    for (const name of Object.keys(EXPECTED)) {
      expect(fs.existsSync(entryFile(name))).toBe(true);
    }
  });

  // The stage-0 guard: import order inside the generated entry === SSOT order.
  it.each(Object.keys(EXPECTED))('%s: import order matches the SSOT order', (name) => {
    expect(markers(name)).toEqual(EXPECTED[name]);
  });

  // MAIN_WORLD_FILES stand-in: the manifest content-script list is the only
  // global, order-sensitive list the build consumes as a whole bundle.
  it('content entry mirrors manifest.content_scripts[0].js exactly', () => {
    expect(markers('content')).toEqual(manifest.content_scripts[0].js);
    expect(markers('content').length).toBeGreaterThan(10);
  });

  it('lists no file twice and every listed file exists', () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      expect(new Set(expected).size).toBe(expected.length);
      const missing = markers(name).filter((relPath) => !fs.existsSync(path.join(ROOT, relPath)));
      expect(missing).toEqual([]);
    }
  });

  it('starts each entry with its first source file', () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const first = fs.readFileSync(entryFile(name), 'utf8').split('\n')[0];
      expect(first).toBe(`/* ==== ${expected[0]} ==== */`);
    }
  });

  // Stage 0 regression guard: concatenation, not an `import './x.js'` chain.
  // A chain gives every source its own module scope, so a source carrying a
  // `module.exports` UMD shim would become a CommonJS closure and its
  // declarations would vanish from the shared scope the classic scripts rely on.
  it.each(Object.keys(EXPECTED))('%s: entry is a concatenation, not an import chain', (name) => {
    const text = fs.readFileSync(entryFile(name), 'utf8');
    // ESM-пилот (Roadmap Ph2): print/print.js — первый ESM-модуль, его статический
    // import втягивает utils/markdown.js в граф esbuild; это осознанное исключение.
    if (name === 'print') {
      expect(text).toMatch(/^import MarkdownRenderer from '\.\.\/utils\/markdown\.js';$/m);
      expect(/^\s*export\b/m.test(text)).toBe(false);
      return;
    }
    // Ph2, шаг 2: utils/export-text-builders.js — ESM-модуль; он импортирует
    // buildReferenceText уже ВНУТРИ себя, а в entry входит как
    // import AiCmExportBuilders from '../utils/export-text-builders.js'
    // (спецификатор перебазирован из core|options/ в .build/, см. rebaseImportSpecifiers).
    // Ph2, шаг 3: background.js импортирует platform статически, content.js и
    // options.js — тоже.
    // export-обёрток в конкатенации по-прежнему нет.
    if (name === 'options' || name === 'content' || name === 'background') {
      expect(text).toContain("import { aiCmIsFirefox } from '../utils/platform.js';");
      expect(text).not.toContain('module.exports = { aiCmIsFirefox');
      if (name !== 'background') {
        expect(text).toContain("import AiCmExportBuilders from '../utils/export-text-builders.js';");
      }
      expect(/^[ \t]*export\b/m.test(text)).toBe(false);
      return;
    }
    expect(/^\s*import\b/m.test(text)).toBe(false);
    expect(/^\s*export\b/m.test(text)).toBe(false);
  });
});
