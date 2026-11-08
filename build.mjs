#!/usr/bin/env node
/**
 * build.mjs — Phase 2 step 1: esbuild bundler with four entry points.
 *
 * Why the entry points are *derived* instead of hardcoded:
 * this repository has no `src/` directory. The extension sources are plain
 * global-scope scripts wired together by three source-of-truth files:
 *   - manifest.json            -> background.service_worker
 *                              -> content_scripts[0].js (order-sensitive)
 *   - options/options.html     -> <script src> order (order-sensitive)
 *   - print/print.html         -> <script src> order (order-sensitive)
 * The bundler reads those SSOTs, concatenates each entry group into a single
 * module (one shared scope, which is what the legacy sources expect: every
 * cross-file reference is a bare identifier, not window.X) and lets esbuild
 * transpile + wrap the result. Nothing is hardcoded, so the bundles cannot
 * drift from the manifest / HTML script order.
 *
 * Outputs (dist/):
 *   background.js, content.js, options.js, print.js, shared-i18n.js
 *                                                     (IIFE, no import/export)
 *   manifest.json, icons/**, options/options.html, options/options.css,
 *   print/print.html, privacy/privacy.html, docs/index.html + docs/screenshots/**
 *   _locales/**, plus the files Chrome resolves itself at runtime (see step 2c)
 *
 * Plus dist-firefox/ (step 4c): a copy of dist/ whose manifest ALSO declares the
 * Firefox /background/scripts fallback. MV3 does not support background.scripts
 * (Chrome's manifest is service-worker only), while Firefox MV3 has no service
 * workers and AMO requires the scripts fallback — so one output root cannot
 * serve both engines.
 *
 * Phase 3 step 1 (print): print/print.html is the last legacy page that pulled
 * global scripts from the source tree (options/i18n-apply.js, utils/markdown.ts,
 * print/print.js), which forced the whole legacy tree into the release ZIP. It
 * is now a fourth entry point. Two layout notes, both deliberate:
 *   - the page stays at dist/print/print.html, because the popup opens exactly
 *     chrome.runtime.getURL('print/print.html') (options/options.js:901);
 *   - the bundle lands at the dist ROOT (dist/print.js), like the other three,
 *     so the page loads it as ../print.js — the same shape as options.html.
 *
 * Phase 3 step 3 (privacy + docs): privacy/privacy.html and docs/index.html were
 * the last two pages pulling a legacy source script (options/i18n-apply.js)
 * directly. Their dependency lists are identical (one file), so they share ONE
 * bundle — dist/shared-i18n.js at the dist root, loaded by both pages as
 * ../shared-i18n.js. Two consequences worth naming:
 *   - dist/ now carries rewired copies of BOTH pages, so «Помощь» and
 *     «Приватность» also work from an unpacked dist/ (until now those two trees
 *     existed only inside the release ZIP);
 *   - with that, no page in the package references the legacy source tree any
 *     more, and options/i18n-apply.js stops being shipped (see release.yml).
 * docs/screenshots/** is copied along because docs/index.html shows them with
 * page-relative paths; in the ZIP they override identical legacy entries, so the
 * archive content does not change. The root pages stay legacy on purpose — their
 * script tag is pinned by tests/privacy.test.js:173-181 and
 * tests/i18n-locales.test.js:264-270.
 *
 * Phase 2 step 2 (rewiring): dist/ is a *complete extension root*, so that
 * "Load unpacked -> dist/" works. Two things follow from that:
 *   2b. the copies handed to Chrome are rewritten (manifest.json + options.html)
 *       so the bundles are loaded instead of the legacy global scripts;
 *   2c. the files that Chrome resolves by path at runtime — the MAIN-world
 *       interceptors registered from core/background.js and _locales/ — must
 *       exist next to the bundles. Most of them are copied verbatim, but the
 *       four ESM interceptors (page / claude / perplexity / google-search) are
 *       built as their OWN IIFE bundles into dist/core/<name>.js: a MAIN-world
 *       script is registered by path and cannot carry `import`/`export`, while
 *       the interceptor source now imports utils/intercept-common.ts.
 *       chrome.scripting.registerContentScripts still points at the same path,
 *       so the js[] registration in core/background.js does not change shape.
 * The root manifest.json / options/options.html stay legacy on purpose: they are
 * frozen by the test suite (tests/manifest-smoke.test.js, tests/qwen-provider-wiring.test.js)
 * and are no longer what Chrome loads.
 *
 * Stage 0 (entry points): every bundle is built from a generated entry file,
 * `.build/entry-<name>.js`, instead of from `stdin`. The entry files are
 * regenerated from the SSOTs on every build and are gitignored:
 *   .build/entry-background.js    <- BACKGROUND_PRELUDE + manifest.background.service_worker
 *   .build/entry-content.js       <- manifest.content_scripts[0].js
 *   .build/entry-options.js       <- options/options.html script order
 *   .build/entry-print.js         <- print/print.html script order
 *   .build/entry-shared-i18n.js   <- privacy/privacy.html (docs/index.html must match)
 *
 * The entry file holds the *concatenation* of its sources, not an
 * `import './x.js'` chain, and that is deliberate: these sources are classic
 * scripts that reference each other by bare identifier inside one shared scope.
 * An import chain gives every file its own module scope, so a source carrying a
 * `module.exports` UMD shim for jest would become a CommonJS closure and its
 * declarations would vanish from that shared scope. The build stays green while
 * the extension breaks at runtime (no top-level aiCmIsFirefox(), Tokenizer,
 * core/state.js globals…), so concatenation — one shared scope — is what this
 * build must keep.
 *
 * ESM-пилот (Roadmap Ph2) is the one deliberate exception: a source may instead
 * carry a real `import` and let esbuild pull that module into the same bundle
 * (print/print.js → markdown, options|content.js → platform, export-text-builders
 * → buildReferenceText, MAIN-перехватчики → intercept-common, core/qwen-intercept.js
 * → utils/stream-frames.ts, core/background.js + core/content.js → utils/debug.js).
 * utils/debug.js остаётся в js[] MAIN-регистраций (парсеры пакета — classic-скрипты
 * без import), поэтому для них дополнительно выводится classic-артефакт dist/.
 * The imported
 * module is then excluded from its entry's concatenation list, and the bundle
 * still ends up as ONE scope. MAIN-перехватчики не входят в общий content-бандл:
 * они собираются отдельными IIFE (mainInterceptOptions) в те же пути dist/core/,
 * потому что их грузит chrome.scripting по пути, а не manifest.
 *
 * Usage:
 *   node build.mjs                # dev build (dist/ + dist-firefox/), sourcemaps on
 *   node build.mjs --watch        # rebuild on change (native esbuild ctx.watch())
 *   node build.mjs --minify       # production, sourcemaps off
 *   node build.mjs --clean        # remove dist/ and dist-firefox/, then exit
 *   node build.mjs --no-sourcemap
 *   node build.mjs --write-entries  # only regenerate .build/entry-*.js, then exit
 *
 * Watch note: esbuild's own `ctx.watch()` drives the dev loop now. The entry
 * plugin reports every real input through `watchFiles` (entry sources,
 * manifest.json, the assets copied verbatim and the recursively copied trees),
 * so a change to any of them triggers a native rebuild.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
// The Firefox package is the same build with one extra manifest key (see 4c):
// the two engines refuse each other's background shape, so they cannot share
// one output root.
const DIST_FIREFOX = path.join(ROOT, 'dist-firefox');
// Stage 0: the generated entry files are build inputs, not artefacts, so they
// live outside dist/ and are gitignored.
const BUILD_DIR = path.join(ROOT, '.build');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const WATCH = flag('--watch');
const CLEAN_ONLY = flag('--clean');
const ENTRIES_ONLY = flag('--write-entries');
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

// Статические зависимости background-бандла, склеиваемые ДО esbuild в одну область
// видимости. Здесь остаётся только то, что не умеет ESM: классический IIFE, который
// публикует window-API. importScripts в сборке запрещён: API только воркера, поэтому
// Firefox event page его не исполняет, и пороги проактивных предупреждений молча
// падали бы на дефолт (гейт — verifyDist/verifyFirefoxDist).
// Ph2: utils/gemini-intercept-logic.js из этого списка ушёл — модуль переведён на ESM,
// и core/background.js втягивает его статическим import'ом (esbuild кладёт его в тот же
// бандл SW); для MAIN-регистрации ниже выводится classic-артефакт. Так же раньше ушёл
// utils/platform.ts (Ph2, шаг 3).
const BACKGROUND_PRELUDE = [
  // v2.0.37 (PDF): SW-брокер pdf.js вшивается в бандл статически.
  'core/pdf-parser.js',
];

// Ph2: MAIN-перехватчики, перешедшие на ESM (intercept-common). Их исходники
// содержат top-level import, поэтому они не копируются verbatim: каждый
// собирается отдельным IIFE в тот же путь dist/core/<name>.js, на который
// продолжает указывать js[] в core/background.js.
// Ph2, шаг stream-frames: core/qwen-intercept.js тоже ESM — он импортирует
// utils/stream-frames.ts, поэтому esbuild вшивает модуль кадров прямо в
// dist/core/qwen-intercept.js. Из js[] путь utils/stream-frames.ts удалён
// (см. registration id -v4 в core/background.js): копировать нечего, а старый
// путь в dist больше не существует.
const MAIN_INTERCEPTS = [
  'core/page-intercept.js',
  'core/claude-intercept.js',
  'core/perplexity-intercept.js',
  'core/google-search-intercept.js',
  'core/qwen-intercept.js',
];

/**
 * Ph2, шаг debug.js: модуль переведён на ESM (R1), поэтому подменять его
 * синтезированной гранью больше не нужно — esbuild втягивает utils/debug.js в
 * MAIN-бандл по настоящему статическому import'у из utils/intercept-common.ts.
 * Прежний debugSoftFacadePlugin удалён вместе с причиной своего существования.
 */

/** esbuild options для одного MAIN-бандла на перехватчик (IIFE, путь сохраняется). */
function mainInterceptOptions() {
  return {
    absWorkingDir: ROOT,
    entryPoints: MAIN_INTERCEPTS,
    // outbase='.' сохраняет core/ в имени: dist/core/<name>.js — тот же путь,
    // который service worker уже регистрирует через js[].
    outbase: '.',
    outdir: DIST,
    format: 'iife',
    bundle: true,
    platform: 'browser',
    target: 'es2020',
    sourcemap: false,
    minify: MINIFY,
    legalComments: 'none',
    logLevel: WATCH ? 'info' : 'warning',
  };
}

async function buildMainIntercepts() {
  await fsp.mkdir(DIST, { recursive: true });
  await esbuild.build(mainInterceptOptions());
}

/** background entry — build-time prelude + manifest.background.service_worker */
function backgroundEntry(manifest) {
  const src = manifest?.background?.service_worker;
  if (typeof src !== 'string' || src === '') {
    fail('manifest.json: background.service_worker is missing or not a string');
  }
  return [...BACKGROUND_PRELUDE, src];
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
  // ESM-пилот (Roadmap Ph2): utils/buildReferenceText.ts больше не отдельный
  // content script — его втягивает esbuild по import из utils/export-text-builders.ts.
  // utils/platform.ts теперь импортирует core/content.js (шаг 3), поэтому в списке
  // конкатенации ему тоже не место. Фильтр держит SSOT устойчивым, даже если строку
  // случайно вернут в манифест.
  // R1 (Ph2): utils/debug.ts переведён на ESM и втягивается import'ом из
  // core/content.js — как строку конкатенации его больше не берём (иначе в одной
  // области видимости оказались бы и импорт, и текст модуля). В манифесте путь
  // остаётся ради SSOT-порядка; фильтр держит сборку устойчивой.
  // Ph2, шаг tokenizer.js: модуль тоже ESM — его втягивает статический import из
  // core/content.js, из списка конкатенации исключён по той же причине.
  // Ph2, шаг model-config.ts: модуль ESM — его втягивает статический import из
  // core/content.js; из манифеста строка удалена, фильтр держит SSOT устойчивым.
  // Ph2, шаг perplexity-parser.ts: модуль ESM — его втягивают статические import'ы
  // core/perplexity-intercept.js (MAIN-бандл) и options/options.js; как строку
  // конкатенации content-скрипта не берём.
  // Ph2, шаг chatgpt-conversation-parser.ts: модуль ESM — его втягивают статические
  // import'ы core/page-intercept.js (MAIN-бандл) и options/options.js; как строку
  // конкатенации не берём.
  // Ph2, шаг export-text-builders.ts: модуль ESM — его втягивает статический import из
  // core/content.js (единый скоуп бандла: AiCmExportBuilders делят core/export-manager.js,
  // adapters/qwen-adapter.js и core/content.js); строка из манифеста удалена.
  // Ph2, шаг gemini-batchexecute-parser.js: модуль ESM — его втягивает side-effect
  // import из core/content.js (нужно window-зеркало для core/export-manager.js и
  // PARSER_VERSION), а для MAIN-мира ниже выводится classic-артефакт. Как строку
  // конкатенации не берём; строка из манифеста удалена.
  return js.filter(function (rel) {
    return (
      rel !== 'utils/buildReferenceText.ts' &&
      rel !== 'utils/platform.ts' &&
      rel !== 'utils/debug.ts' &&
      rel !== 'utils/tokenizer.ts' &&
      rel !== 'utils/model-config.ts' &&
      rel !== 'utils/export-text-builders.ts' &&
      rel !== 'utils/perplexity-parser.ts' &&
      rel !== 'utils/chatgpt-conversation-parser.ts' &&
      rel !== 'utils/gemini-batchexecute-parser.ts' &&
      // Ph2, шаг gemini-dom-parser.ts: модуль ESM — его втягивает статический
      // import из core/hybrid-tail.js (ISOLATED-мир). MAIN-регистраций у парсера
      // нет, поэтому classic-артефакт не выводится; как строку конкатенации не берём.
      rel !== 'utils/gemini-dom-parser.ts' &&
      // Ph2, шаг google-search-folwr-parser.js: модуль ESM — его втягивает side-effect
      // import из core/content.js (window-зеркало для адаптера GSA в ISOLATED-мире),
      // а для MAIN-регистрации ai-cm-google-search-intercept ниже выводится
      // classic-артефакт. Как строку конкатенации не берём; строка из манифеста удалена.
      rel !== 'utils/google-search-folwr-parser.js' &&
      // Ph2, шаг export-emit-pipeline.js: модуль ESM — его втягивает статический
      // import из core/content.js (единый скоуп бандла: AiCmExportEmitPipeline делят
      // core/export-manager.js, core/base-handler.js и core/content.js). MAIN-регистраций
      // нет, classic-артефакт не выводится; как строку конкатенации не берём.
      rel !== 'utils/export-emit-pipeline.ts'
    );
  });
}

/** Entry derived from the <script src> order of a legacy HTML page (order-sensitive). */
function htmlScriptEntry(htmlPath) {
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
          'concatenated into the classic-scope bundle. The bundles expect classic scripts.'
      );
    }
    out.push(rel(path.resolve(dir, src)));
  }
  if (out.length === 0) fail(`${htmlPath}: no local <script src> tags found`);
  return out;
}

/** options entry — <script src> order in options/options.html */
function optionsEntry() {
  // ESM-пилот (Roadmap Ph2): utils/buildReferenceText.ts втягивается import'ом
  // из utils/export-text-builders.ts, поэтому тег <script> из options.html убран.
  // utils/platform.ts втягивается import'ом из options/options.js (шаг 3) — его тег
  // тоже удалён. utils/export-text-builders.ts — ESM: и options.html-тег, и строка
  // конкатенации убраны, модуль втягивается import'ом из options/options.js.
  // Ph2, шаг archive-import.ts: модуль ESM — его втягивает статический import из
  // options/options.js, поэтому и options.html-тег, и строка конкатенации убраны.
  // Фильтр — страховка SSOT: теги не должны вернуться в разметку.
  return htmlScriptEntry('options/options.html').filter(function (rel) {
    return rel !== 'utils/buildReferenceText.ts' && rel !== 'utils/platform.ts' &&
      rel !== 'utils/export-text-builders.ts' && rel !== 'utils/archive-import.ts';
  });
}

/**
 * print entry — <script src> order in print/print.html. Phase 3 step 1: the
 * print page was the last consumer of source-tree globals, so its three legacy
 * scripts become one bundle and the page stops referencing the source layout.
 */
function printEntry() {
  // ESM-пилот (Roadmap Ph2): utils/markdown.ts больше не тег <script> печатной
  // страницы — его втягивает esbuild по import из print/print.js. Фильтр держит
  // SSOT устойчивым, даже если тег случайно вернут в разметку.
  return htmlScriptEntry('print/print.html').filter(function (rel) {
    return rel !== 'utils/markdown.ts';
  });
}

/**
 * shared-i18n entry — Phase 3 step 3: privacy/privacy.html and docs/index.html
 * are the last two pages that load a legacy source script directly. Both load
 * exactly the same one, so they are served by ONE bundle. The shared bundle is
 * only valid while the two lists are identical, so a divergence is a hard error
 * rather than a silent loss of code on one of the pages.
 */
function sharedI18nEntry() {
  const pages = ['privacy/privacy.html', 'docs/index.html'];
  const base = { page: pages[0], list: htmlScriptEntry(pages[0]) };
  for (const page of pages.slice(1)) {
    const list = htmlScriptEntry(page);
    if (JSON.stringify(list) !== JSON.stringify(base.list)) {
      fail(
        `${page}: loads [${list.join(', ')}] but ${base.page} loads [${base.list.join(', ')}]. ` +
          'One shared bundle requires identical dependencies — give the pages separate entry points.'
      );
    }
  }
  return base.list;
}

/* ------------------------------------------------------------------ *
 * 2. Asset copy (mirrors the repo layout under dist/)
 * ------------------------------------------------------------------ */

const ASSET_FILES = [
  'manifest.json',
  'options/options.html',
  'options/options.css',
  'print/print.html',
  // Phase 3 step 3: bundled pages — copied, then rewired in dist/ (see 2c).
  'privacy/privacy.html',
  'docs/index.html',
  // v2.0.37 (PDF): offscreen-хост Chrome и общие с Firefox обработчики текста.
  // Копируются как есть: parser/offscreen.html грузит три classic-скрипта по порядку.
  'parser/offscreen.html',
  'parser/offscreen.js',
  'parser/pdf-host.js',
  'parser/pdf-text.js',
];
const ASSET_DIRS = ['icons'];
// manifest.json declares `default_locale`, so Chrome refuses to load the
// extension unless _locales/<locale>/messages.json exists next to it.
// docs/screenshots is here because dist/docs/index.html references the images
// with page-relative paths (screenshots/*.png).
const ASSET_TREES = ['_locales', 'docs/screenshots'];

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

/* ------------------------------------------------------------------ *
 * Classic artifacts from ES modules (TypeScript migration, step 1)
 *
 * dist/utils/{debug,gemini-batchexecute-parser,google-search-folwr-parser,
 * gemini-intercept-logic}.js are loaded by chrome.scripting as classic scripts,
 * where `import`/`export` are syntax errors. They used to be derived by two
 * regexes: strip the `export` prefixes, then glue the body into a hand-written
 * `(function () { ... })();`.
 *
 * Both steps are now esbuild.transform({ loader: 'ts', format: 'iife' }): it
 * understands every declaration form (`export function/const/class/type`), cannot
 * silently miss a new one, and produces the same single-scope result. The one
 * thing transform() never does is resolve imports, so the import line itself is
 * still removed by a regex before the transform.
 *
 * The same path already handles `.ts` sources, so a future TypeScript module gets
 * its classic artifact without a second code path.
 * ------------------------------------------------------------------ */

// Extension -> esbuild loader, shared by the classic artifacts (transform) and the
// generated entry files (onLoad). Step 1 of the TS migration: `.ts`/`.tsx` inputs
// must be parsed as TypeScript instead of failing on type annotations.
const LOADERS = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mts': 'ts',
  '.cts': 'ts',
};

/** esbuild loader for a file path; unknown extensions keep the historical 'js'. */
function loaderForFile(file) {
  return LOADERS[path.extname(file).toLowerCase()] || 'js';
}

// The import directive esbuild.transform cannot resolve: it would be rewritten into
// `require(...)`, and `require` does not exist in the MAIN world.
const IMPORT_LINE_RE = /^[ \t]*import\s[^\n]*\bfrom\s*['"][^'"]+['"];?[ \t]*$/gm;

// Namespace the debug classic artifact publishes into globalThis (see classicIife).
const DEBUG_CLASSIC_NS = '__aiCmDebugClassic';

/**
 * Render one classic artifact: `export` declarations removed, body wrapped in an
 * IIFE - both by esbuild, see the section comment above.
 *
 * `globalName` is for modules whose consumers rely on bare global identifiers
 * (utils/debug.js): the namespace is published into `globalThis`, so `swallowSoft`
 * keeps resolving from the parser artifacts exactly as it did while the file still
 * had top-level function declarations.
 */
async function classicIife(src, label, globalName) {
  const out = await esbuild.transform(src, {
    loader: 'ts',
    format: 'iife',
    target: 'es2020',
    ...(globalName ? { globalName } : {}),
  });
  let code = out.code.trimEnd() + '\n';
  if (globalName) code += '\nObject.assign(globalThis, ' + globalName + ');\n';
  if (/\bimport\s*\(|\brequire\s*\(/.test(code)) {
    fail(label + ': classic artifact still calls require() (unresolved import)');
  }
  return code;
}
// R1 (Ph2): ESM-исходник debug.js и путь, под которым его ждут runtime-регистрации.
const DEBUG_SOURCE = 'utils/debug.ts';
const DEBUG_CLASSIC = 'utils/debug.js';

/**
 * Update (TypeScript migration, step 1): the artifact is now an esbuild IIFE whose
 * namespace is published into `globalThis`, so the bare identifiers MAIN-world
 * consumers rely on (`swallowSoft` and friends) keep resolving as before.
 */
/**
 * dist/utils/debug.js: classic-артефакт того же модуля.
 *
 * utils/debug.ts переведён на ESM, но его грузят 8 регистраций world:'MAIN' через
 * chrome.scripting — путь резолвится в файл, а classic-скрипт не может содержать
 * export-объявления. Снять только префиксы объявлений (export function → function) —
 * весь остальной текст (ring-буфер, window-зеркала, гейты) остаётся байт-в-байт
 * прежним, поэтому поведение в MAIN-мире не меняется.
 */
async function writeDebugClassic() {
  const src = fs.readFileSync(abs(DEBUG_SOURCE), 'utf8').replace(/^\uFEFF/, '');
  const classic = await classicIife(src, DEBUG_CLASSIC, DEBUG_CLASSIC_NS);
  if (/^\s*(?:import|export)\b/m.test(classic)) {
    fail(DEBUG_CLASSIC + ': classic-артефакт всё ещё содержит import/export');
  }
  const to = path.join(DIST, DEBUG_CLASSIC);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, classic, 'utf8');
  return DEBUG_CLASSIC;
}

// Ph2, шаг gemini-batchexecute-parser.js: ESM-исходник и путь, под которым его ждут
// регистрации world:'MAIN' в core/background.js (регистрация ai-cm-gemini-intercept-v18).
const PARSER_SOURCE = 'utils/gemini-batchexecute-parser.ts';
const PARSER_CLASSIC = 'utils/gemini-batchexecute-parser.js';

/**
 * Update (TypeScript migration, step 1): the `export` prefixes and the
 * `(function () {` wrapper are no longer produced by regexes - `classicIife()`
 * derives both with esbuild.transform({ loader: 'ts', format: 'iife' }). The
 * import line is still stripped by a regex, because transform() never
 * resolves imports.
 */
/**
 * dist/utils/gemini-batchexecute-parser.js: classic-артефакт того же модуля.
 *
 * Парсер переведён на ESM (Roadmap Ph2), но его грузит 21-скриптовая MAIN-регистрация
 * через chrome.scripting: путь резолвится в файл, а classic-скрипт не может содержать
 * import/export. Снять префиксы объявлений и строку импорта (swallowSoft в MAIN-мире
 * даёт classic-артефакт utils/debug.js — он первый в js[]), затем завернуть тело в
 * IIFE: до миграции файл был самовызывающейся функцией и держал ~40 внутренних имён
 * вне общего скоупа MAIN-мира, где рядом живут 19 других classic-скриптов.
 *
 * window-зеркало (window.GeminiBatchexecuteParser) остаётся в исходнике и потому
 * попадает и в бандл content.js (core/content.js → core/export-manager.js), и сюда.
 */
async function writeParserClassic() {
  const src = fs.readFileSync(abs(PARSER_SOURCE), 'utf8').replace(/^\uFEFF/, '');
  // transform() never resolves imports, so the import line is the only piece
  // still stripped by a regex; export declarations and the IIFE come from esbuild.
  const classic = await classicIife(src.replace(IMPORT_LINE_RE, ''), PARSER_CLASSIC);
  if (/^\s*(?:import|export)\b/m.test(classic)) {
    fail(PARSER_CLASSIC + ': classic-артефакт всё ещё содержит import/export');
  }
  if (!/window\.GeminiBatchexecuteParser\s*=/.test(classic)) {
    fail(PARSER_CLASSIC + ': самовызывающаяся обёртка не публикует window.GeminiBatchexecuteParser');
  }
  const to = path.join(DIST, PARSER_CLASSIC);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, classic, 'utf8');
  return PARSER_CLASSIC;
}

// Ph2, шаг google-search-folwr-parser.js: ESM-исходник и путь, под которым его ждёт
// MAIN-регистрация ai-cm-google-search-intercept в core/background.js.
const GSA_PARSER_SOURCE = 'utils/google-search-folwr-parser.js';
const GSA_PARSER_CLASSIC = 'utils/google-search-folwr-parser.js';

/**
 * Update (TypeScript migration, step 1): the `export` prefixes and the
 * `(function () {` wrapper are no longer produced by regexes - `classicIife()`
 * derives both with esbuild.transform({ loader: 'ts', format: 'iife' }). The
 * import line is still stripped by a regex, because transform() never
 * resolves imports.
 */
/**
 * dist/utils/google-search-folwr-parser.js: classic-артефакт того же модуля.
 *
 * GSA-перехватчик работает в world:'MAIN' и получает парсер отдельным classic-скриптом
 * (core/google-search-intercept.js читает window.GoogleFolwrUtils). classic-скрипт не
 * может содержать import/export, поэтому снимаем префиксы объявлений и заворачиваем
 * тело в IIFE — так внутренние имена не протекают в общий скоуп MAIN-мира.
 *
 * window-зеркало остаётся в исходнике и попадает как в бандл content.js (ISOLATED-мир),
 * так и сюда.
 */
async function writeGsaParserClassic() {
  const src = fs.readFileSync(abs(GSA_PARSER_SOURCE), 'utf8').replace(/^\uFEFF/, '');
  // transform() never resolves imports, so the import line is the only piece
  // still stripped by a regex; export declarations and the IIFE come from esbuild.
  const classic = await classicIife(src.replace(IMPORT_LINE_RE, ''), GSA_PARSER_CLASSIC);
  if (/^\s*(?:import|export)\b/m.test(classic)) {
    fail(GSA_PARSER_CLASSIC + ': classic-артефакт всё ещё содержит import/export');
  }
  if (!/window\.GoogleFolwrUtils\s*=/.test(classic)) {
    fail(GSA_PARSER_CLASSIC + ': самовызывающаяся обёртка не публикует window.GoogleFolwrUtils');
  }
  const to = path.join(DIST, GSA_PARSER_CLASSIC);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, classic, 'utf8');
  return GSA_PARSER_CLASSIC;
}

// Ph2, шаг gemini-intercept-logic.js: ESM-исходник и путь, под которым его ждёт
// 21-скриптовая MAIN-регистрация ai-cm-gemini-intercept-v18 в core/background.js.
const GEMINI_LOGIC_SOURCE = 'utils/gemini-intercept-logic.js';
const GEMINI_LOGIC_CLASSIC = 'utils/gemini-intercept-logic.js';

/**
 * Update (TypeScript migration, step 1): the `export` prefixes and the
 * `(function () {` wrapper are no longer produced by regexes - `classicIife()`
 * derives both with esbuild.transform({ loader: 'ts', format: 'iife' }). The
 * import line is still stripped by a regex, because transform() never
 * resolves imports.
 */
/**
 * dist/utils/gemini-intercept-logic.js: classic-артефакт того же модуля.
 *
 * Логика переведена на ESM (Roadmap Ph2) и входит в бандл SW статическим import'ом
 * из core/background.js. Но тот же путь перечислен в js[] MAIN-регистрации
 * (ai-cm-gemini-intercept-v18), а chrome.scripting грузит classic-скрипты, где
 * import/export недопустимы. Снимаем префиксы объявлений и заворачиваем тело в IIFE:
 * до миграции файл был самовызывающейся функцией и держал ~90 внутренних имён вне
 * общего скоупа MAIN-мира, где рядом живут 19 других classic-скриптов.
 *
 * window/self-зеркала остаются в исходнике и потому попадают и в бандл SW (self),
 * и сюда (window): потребители в core/gemini-*.js по-прежнему читают
 * window.GeminiInterceptLogic, поэтому ни один из них не меняется.
 */
async function writeGeminiLogicClassic() {
  const src = fs.readFileSync(abs(GEMINI_LOGIC_SOURCE), 'utf8').replace(/^\uFEFF/, '');
  // transform() never resolves imports, so the import line is the only piece
  // still stripped by a regex; export declarations and the IIFE come from esbuild.
  const classic = await classicIife(src.replace(IMPORT_LINE_RE, ''), GEMINI_LOGIC_CLASSIC);
  if (/^\s*(?:import|export)\b/m.test(classic)) {
    fail(GEMINI_LOGIC_CLASSIC + ': classic-артефакт всё ещё содержит import/export');
  }
  if (!/window\.GeminiInterceptLogic\s*=/.test(classic)) {
    fail(GEMINI_LOGIC_CLASSIC + ': самовызывающаяся обёртка не публикует window.GeminiInterceptLogic');
  }
  const to = path.join(DIST, GEMINI_LOGIC_CLASSIC);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, classic, 'utf8');
  return GEMINI_LOGIC_CLASSIC;
}

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
// Firefox fallback (dist-firefox only): name the bundle, never the legacy source —
// dist/ does not contain core/background.js.
// v2.0.37 (PDF): в Firefox нет offscreen API, поэтому pdf.js-хост грузится прямо
// в event page как classic-скрипты (Worker там доступен). Chrome исполняет те же
// файлы в parser/offscreen.html, а они попадают в dist/ как обычные ассеты.
const FIREFOX_BACKGROUND_SCRIPTS = [
  REWIRED_SERVICE_WORKER,
  'parser/pdf-text.js',
  'parser/pdf-host.js',
];
// data_collection_permissions появился в Firefox 140; без явного минимума валидатор
// AMO отвечает 'Unexpected property "data_collection_permissions" for any Firefox
// version below 140' (uBlock Origin #3894). Поле пишется ТОЛЬКО в dist-firefox/:
// dist/manifest.json (Chrome) остаётся байт-в-байт прежним.
const FIREFOX_MIN_VERSION = '140.0';
// BYOK: единственный сетевой хост, торчащий из Firefox-пакета. В Firefox BYOK выключен
// (гейт в core/background.js), поэтому разрешение снимается из dist-firefox/manifest.json:
// заявленный data_collection_permissions: none подтверждается отсутствием доступа к Google.
const BYOK_HOST = 'https://generativelanguage.googleapis.com/*';
const REWIRED_OPTIONS_SCRIPT = '../options.js';
const REWIRED_PRINT_SCRIPT = '../print.js';
// Phase 3 step 3: privacy/privacy.html and docs/index.html both live one level
// below the dist root, like options/ and print/, so both reach the bundle the
// same way. One file, one bundle, one path.
const REWIRED_SHARED_I18N_SCRIPT = '../shared-i18n.js';
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
  // MV3 declares exactly one background entry, and it is the service worker:
  // background.scripts is an MV2 key (Firefox still uses it, Chrome does not), so
  // dist/ drops it outright. The Firefox fallback required by AMO
  // (BACKGROUND_SERVICE_WORKER_NOFALLBACK) is written only into dist-firefox/
  // (step 4c) — never into the package Chrome loads.
  delete out.background.scripts;
  // The background bundle is an IIFE, not an ES module: stay classic. No
  // top-level await is needed and classic is simpler for the MV3 worker lifecycle.
  delete out.background.type;
  // Chrome не знает browser_specific_settings: AMO-блок (gecko.id +
  // data_collection_permissions) остаётся только в dist-firefox/ (шаг 4c), где
  // он обязателен. В Chrome-пакете он выглядит как заявленное расширению
  // разрешение на сбор данных, хотя это всего лишь AMO-декларация «none» —
  // поэтому dist/manifest.json его не содержит вовсе.
  delete out.browser_specific_settings;
  if (!Array.isArray(out.content_scripts) || out.content_scripts.length === 0) {
    fail('dist/manifest.json: content_scripts is missing or empty');
  }
  out.content_scripts[0].js = [...REWIRED_CONTENT_SCRIPTS];
  return JSON.stringify(out, null, 2) + '\n';
}

/**
 * Replace the FIRST local <script src> tag with the bundle tag and drop the
 * remaining local tags (the bundle already contains all of them, in order).
 */
function rewireHtmlText(text, scriptSrc, label) {
  let inserted = false;
  const out = text.replace(LOCAL_SCRIPT_TAG, (tag) => {
    if (inserted) return '';
    inserted = true;
    const indent = (tag.match(/^[ \t]*/) || [''])[0];
    return `${indent}<script src="${scriptSrc}"></script>\n`;
  });
  if (!inserted) fail(`${label}: no local <script src> tag to replace`);
  return out;
}

function rewireOptionsHtmlText(text) {
  return rewireHtmlText(text, REWIRED_OPTIONS_SCRIPT, 'dist/options/options.html');
}

function rewirePrintHtmlText(text) {
  return rewireHtmlText(text, REWIRED_PRINT_SCRIPT, 'dist/print/print.html');
}

async function rewireDist() {
  const manifestPath = path.join(DIST, 'manifest.json');
  const optionsPath = path.join(DIST, 'options', 'options.html');
  const printPath = path.join(DIST, 'print', 'print.html');
  const docsPath = path.join(DIST, 'docs', 'index.html');
  const privacyPath = path.join(DIST, 'privacy', 'privacy.html');
  await fsp.writeFile(manifestPath, rewireManifestText(await fsp.readFile(manifestPath, 'utf8')));
  await fsp.writeFile(optionsPath, rewireOptionsHtmlText(await fsp.readFile(optionsPath, 'utf8')));
  await fsp.writeFile(printPath, rewirePrintHtmlText(await fsp.readFile(printPath, 'utf8')));
  await fsp.writeFile(
    docsPath,
    rewireHtmlText(await fsp.readFile(docsPath, 'utf8'), REWIRED_SHARED_I18N_SCRIPT, 'dist/docs/index.html')
  );
  await fsp.writeFile(
    privacyPath,
    rewireHtmlText(
      await fsp.readFile(privacyPath, 'utf8'),
      REWIRED_SHARED_I18N_SCRIPT,
      'dist/privacy/privacy.html'
    )
  );
  return [
    'manifest.json (rewired)',
    'options/options.html (rewired)',
    'print/print.html (rewired)',
    'docs/index.html (rewired)',
    'privacy/privacy.html (rewired)',
  ];
}

/* ------------------------------------------------------------------ *
 * 3. Entry assembly (concat into one shared scope)
 *
 * Stage 0: the concatenation is materialised on disk as
 * .build/entry-<name>.js and handed to esbuild through `entryPoints`, instead
 * of through `stdin`. The generated file is exactly what the stdin build used
 * to receive (same markers, same order, same bytes), so the bundles cannot
 * change shape just because the transport did.
 * ------------------------------------------------------------------ */

/** Absolute path of the generated entry file of one bundle. */
function entryPath(name) {
  return path.join(BUILD_DIR, `entry-${name}.js`);
}

/**
 * A file concatenated into ".build/entry-<name>.js" keeps the relative imports it
 * was written with for its own folder, while the generated entry sits one level
 * above the source tree. Rebase every static import specifier from the source
 * directory to the entry directory — exactly the path esbuild resolves from
 * ".build/entry-*.js".
 * ESM-пилот (Roadmap Ph2): print/print.js's '../utils/markdown.ts' is already
 * entry-relative and stays as is; utils/export-text-builders.ts's
 * './buildReferenceText.ts' becomes '../utils/buildReferenceText.ts'.
 */
function rebaseImportSpecifiers(src, sourceRel) {
  const dir = path.posix.dirname(String(sourceRel).replace(/\\/g, '/'));
  return src.replace(
    /^([ \t]*(?:import|export)\b[^\n]*?\bfrom\s*['"])(\.\.?\/[^'"]+)(['"])/gm,
    function (line, head, spec, tail) {
      const target = path.posix.normalize(path.posix.join(dir, spec));
      return head + '../' + target + tail;
    }
  );
}

function renderEntry(entryRelPaths) {
  const parts = [];
  let bytes = 0;
  for (const r of entryRelPaths) {
    const file = abs(r);
    if (!fs.existsSync(file)) {
      fail(`entry "${r}" is referenced by the SSOT but does not exist: ${file}`);
    }
    let src = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    src = rebaseImportSpecifiers(src, r);
    if (!src.endsWith('\n')) src += '\n';
    parts.push(`/* ==== ${r} ==== */\n${src}`);
    bytes += Buffer.byteLength(src);
  }
  return { contents: parts.join('\n'), bytes };
}

/**
 * Materialise .build/entry-<name>.js for every bundle. A file is only rewritten
 * when the rendered text actually differs, so a watch rebuild of an unrelated
 * entry cannot retrigger the watcher in a loop.
 */
async function writeEntryFiles(entries = collectEntries()) {
  await fsp.mkdir(BUILD_DIR, { recursive: true });
  const written = [];
  for (const [name, list] of Object.entries(entries)) {
    const { contents, bytes } = renderEntry(list);
    const file = entryPath(name);
    let previous = null;
    try {
      previous = await fsp.readFile(file, 'utf8');
    } catch {
      previous = null; // first build: no entry file yet
    }
    if (previous !== contents) {
      // Rename over, never truncate in place: esbuild (and jest, which runs
      // `--write-entries`) may read the entry file at any moment, and a
      // half-written entry would be a build input, not a stale artifact.
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, contents);
      await fsp.rename(tmp, file);
    }
    written.push({ name, file, list, bytes });
  }
  return written;
}

function collectEntries() {
  const manifest = readJSON('manifest.json');
  return {
    background: backgroundEntry(manifest),
    content: contentEntry(manifest),
    options: optionsEntry(),
    print: printEntry(),
    'shared-i18n': sharedI18nEntry(),
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
  const mainBundleSources = new Set(MAIN_INTERCEPTS);
  for (const r of runtimeRegisteredFiles()) {
    // Ph2: эти четыре файла собираются esbuild'ом в dist/core/<name>.js,
    // копировать исходник поверх бандла нельзя.
    if (mainBundleSources.has(r)) continue;
    // R1 (Ph2): utils/debug.js — ESM-модуль, но 8 MAIN-регистраций грузят его как
    // classic-скрипт (world: 'MAIN' не умеет import). Копировать ESM-исходник в dist/
    // нельзя: браузер выполнит его как classic и упадёт на export-префиксах. Ниже из
    // того же исходника выводится classic-артефакт — второй копии логики в дереве нет.
    if (r === DEBUG_CLASSIC) continue;
    // Ph2: utils/gemini-batchexecute-parser.js — та же история (Gemini MAIN-регистрация
    // v12); classic-артефакт выводит writeParserClassic ниже.
    if (r === PARSER_CLASSIC) continue;
    // Ph2: utils/google-search-folwr-parser.js — та же история (GSA MAIN-регистрация
    // ai-cm-google-search-intercept); classic-артефакт выводит writeGsaParserClassic ниже.
    if (r === GSA_PARSER_CLASSIC) continue;
    // Ph2: utils/gemini-intercept-logic.js — та же история (Gemini MAIN-регистрация
    // v12); ESM-исходник уходит в бандл SW статическим import'ом из core/background.js,
    // а classic-артефакт для MAIN-мира выводит writeGeminiLogicClassic ниже.
    if (r === GEMINI_LOGIC_CLASSIC) continue;
    const from = abs(r);
    if (!fs.existsSync(from)) {
      fail(`"${r}" is registered at runtime by ${BACKGROUND_SRC} but does not exist`);
    }
    const to = path.join(DIST, r);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    copied.push(r);
  }
  copied.push(await writeDebugClassic());
  copied.push(await writeParserClassic());
  copied.push(await writeGsaParserClassic());
  copied.push(await writeGeminiLogicClassic());
  copied.push(...(await rewireDist()));
  return copied;
}

/* ------------------------------------------------------------------ *
 * 3b. pdf.js assets (v2.0.37)
 *
 * Версия pdfjs-dist закреплена точно (4.8.69): 3.x снят с поддержки и уязвим
 * (CVE-2024-4367), а 4.x поставляется только как ESM. Пути не произвольные —
 * их ждёт рантайм: lib/pdf.min.mjs грузится dynamic import'ом из parser/pdf-host.js,
 * воркер подключается отдельным ESM-файлом pdf.worker.js.
 * ------------------------------------------------------------------ */

const PDFJS_MODULE = 'pdfjs-dist';
const PDFJS_ASSETS = [
  ['build/pdf.min.mjs', 'lib/pdf.min.mjs'],
  ['build/pdf.worker.min.mjs', 'pdf.worker.js'],
  // .md, не .txt: релизный шаг "Verify ZIP integrity" намеренно считает любой
  // *.txt недопустимым артефактом, поэтому лицензия идёт как Markdown.
  ['LICENSE', 'vendor/pdfjs-LICENSE.md'],
];
// .js-ассеты pdf.js, которые Chrome/Firefox резолвят по пути. Их надо внести в
// allow-list verifyDist: иначе он примет их за legacy-хвосты прежних сборок.
const PDFJS_DIST_JS = ['pdf.worker.js', 'parser/offscreen.js', 'parser/pdf-host.js', 'parser/pdf-text.js'];

async function copyPdfjsAssets() {
  const copied = [];
  for (const [fromRel, toRel] of PDFJS_ASSETS) {
    const from = abs(path.join('node_modules', PDFJS_MODULE, fromRel));
    if (!fs.existsSync(from)) {
      fail(`pdf.js asset "node_modules/${PDFJS_MODULE}/${fromRel}" is missing (run npm i)`);
    }
    const to = path.join(DIST, toRel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    copied.push(toRel);
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
 * 4b. Dist verification (Phase 2 step 2): what Chrome will load
 * ------------------------------------------------------------------ */

/** The entry-point bundles: everything else in dist/ is copied verbatim. */
const BUNDLES = ['background.js', 'content.js', 'options.js', 'print.js', 'shared-i18n.js'];

const REQUIRED_DIST_FILES = [
  'manifest.json',
  'options/options.html',
  'options/options.css',
  'print/print.html',
  // Phase 3 step 3: both bundled pages must survive into dist/ — in the release
  // ZIP their rewired copies are what replaces the legacy originals.
  'privacy/privacy.html',
  'docs/index.html',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  '_locales/ru/messages.json',
  '_locales/en/messages.json',
  // v2.0.37 (PDF): pdf.js + хост-страница offscreen + лицензия Apache-2.0.
  'pdf.worker.js',
  'lib/pdf.min.mjs',
  'vendor/pdfjs-LICENSE.md',
  'parser/offscreen.html',
  'parser/offscreen.js',
  'parser/pdf-host.js',
  'parser/pdf-text.js',
];

/**
 * Phase 3 step 1: the same rewire contract applies to every bundled HTML page.
 * Exactly one local <script src> (the bundle) and no legacy source path left.
 */
function verifyHtmlRewire(relPath, expectedScript, staleTokens, problems) {
  return fsp.readFile(path.join(DIST, relPath), 'utf8').then((html) => {
    const localTags = [...html.matchAll(LOCAL_SCRIPT_TAG)];
    if (localTags.length !== 1) {
      problems.push(`dist/${relPath}: expected exactly 1 local <script src>, found ${localTags.length}`);
    } else if (!localTags[0][0].includes(`<script src="${expectedScript}"></script>`)) {
      problems.push(`dist/${relPath}: local script tag is not <script src="${expectedScript}">`);
    }
    for (const stale of staleTokens) {
      if (html.includes(stale)) {
        problems.push(`dist/${relPath}: still references the legacy source path "${stale}"`);
      }
    }
  });
}

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
  // MV3 keeps a single background entry: dist/ must declare service_worker and
  // NOTHING else (background.scripts is an MV2 key). The Firefox fallback is
  // materialised into dist-firefox/ only (see writeFirefoxDist).
  if ('scripts' in (manifest?.background || {})) {
    problems.push(
      'dist/manifest.json: background.scripts must be absent for Chrome ' +
        '(the Firefox fallback belongs in dist-firefox/)'
    );
  }
  // Один статический бандл: importScripts() — API воркера, а в Firefox event page его
  // нет, поэтому рантайм-загрузка в поставке запрещена (utils/gemini-intercept-logic.js
  // вшит на сборке статическим import'ом из core/background.js). Гейт держит тот же
  // инвариант в обоих пакетах.
  const bgSource = await fsp.readFile(path.join(DIST, REWIRED_SERVICE_WORKER), 'utf8');
  if (/\bimportScripts\s*\(/.test(bgSource)) {
    problems.push(
      `dist/${REWIRED_SERVICE_WORKER}: importScripts() must not be present ` +
        '(no Worker API in the Firefox event page)'
    );
  }
  const js = manifest?.content_scripts?.[0]?.js;
  if (JSON.stringify(js) !== JSON.stringify(REWIRED_CONTENT_SCRIPTS)) {
    problems.push(
      `dist/manifest.json: content_scripts[0].js is ${JSON.stringify(js)}, ` +
        `expected ${JSON.stringify(REWIRED_CONTENT_SCRIPTS)}`
    );
  }

  await verifyHtmlRewire(
    'options/options.html',
    REWIRED_OPTIONS_SCRIPT,
    ['../utils/', '../adapters/', '../core/', 'i18n-apply.js'],
    problems
  );
  await verifyHtmlRewire(
    'print/print.html',
    REWIRED_PRINT_SCRIPT,
    ['../options/', '../utils/', 'i18n-apply.js', 'markdown.js'],
    problems
  );
  // Phase 3 step 3: privacy + docs are bundled pages now — same contract as the
  // pages above: exactly one local <script src>, pointing at the shared bundle,
  // with no trace of the legacy source layout left in the markup. The stale
  // tokens are path-shaped (../options/) on purpose: privacy.html *mentions*
  // options/i18n-apply.js in its header comment as prose, and that description of
  // the shared mechanism must stay.
  for (const page of ['docs/index.html', 'privacy/privacy.html']) {
    await verifyHtmlRewire(page, REWIRED_SHARED_I18N_SCRIPT, ['../options/', '../utils/', '../core/'], problems);
  }

  // dist/ must not carry legacy entry files: only the bundles, plus the
  // files Chrome resolves by path at runtime (see runtimeRegisteredFiles).
  const expected = new Set([...BUNDLES, ...runtimeRegisteredFiles(), ...PDFJS_DIST_JS]);
  const actual = await collectDistJs();
  // Phase 3 step 3: a .js under options/ in dist/ is always a leftover of the
  // legacy tree — the only script that ever lived there (i18n-apply.js) is inside
  // shared-i18n.js now. Reported with its own message, because "extra file" would
  // not tell the reader which phase removed it and where the code lives instead.
  const legacyOptionsJs = actual.filter((f) => f.startsWith('options/'));
  for (const f of legacyOptionsJs) {
    problems.push(`dist/${f}: legacy script under options/ left in the bundle output (must live in shared-i18n.js)`);
  }
  for (const f of actual) {
    if (legacyOptionsJs.includes(f)) continue;
    if (!expected.has(f)) problems.push(`dist/${f}: legacy .js file left in the bundle output`);
  }
  for (const f of expected) {
    if (!actual.includes(f)) problems.push(`dist/${f}: missing (referenced by Chrome at runtime)`);
  }

  // v2.0.37 (PDF): offscreen-документ без разрешения не создаётся, а воркер без
  // lib/pdf.min.mjs не стартует — оба инварианта проверяем по дисту, не по источнику.
  const perms = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  if (!perms.includes('offscreen')) {
    problems.push('dist/manifest.json: permissions must include "offscreen" (Chrome pdf.js host)');
  }
  const pdfWorkerPath = path.join(DIST, 'pdf.worker.js');
  const pdfWorkerSize = fs.existsSync(pdfWorkerPath) ? fs.statSync(pdfWorkerPath).size : 0;
  if (pdfWorkerSize < 1024 * 1024) {
    problems.push(
      `dist/pdf.worker.js: unexpected size ${pdfWorkerSize} bytes (the pdf.js worker is expected to be >1 MiB)`
    );
  }
  const pdfLibPath = path.join(DIST, 'lib/pdf.min.mjs');
  if (fs.existsSync(pdfLibPath)) {
    const pdfLibText = await fsp.readFile(pdfLibPath, 'utf8');
    if (!pdfLibText.includes('export{')) {
      problems.push('dist/lib/pdf.min.mjs: no "export{" — the ESM build of pdf.js did not survive the copy');
    }
  }
  // offscreen-страница грузит три classic-скрипта строго по порядку: текст до хоста,
  // хост до рантайма (pdf-host.js публикует AiCmPdfHost, offscreen.js его зовёт).
  const pdfOffscreenPath = path.join(DIST, 'parser/offscreen.html');
  if (fs.existsSync(pdfOffscreenPath)) {
    const offscreenHtml = await fsp.readFile(pdfOffscreenPath, 'utf8');
    const order = ['pdf-text.js', 'pdf-host.js', 'offscreen.js'].map((n) => offscreenHtml.indexOf(n));
    if (order.some((i) => i < 0) || !(order[0] < order[1] && order[1] < order[2])) {
      problems.push(
        'dist/parser/offscreen.html: scripts must load in order pdf-text.js → pdf-host.js → offscreen.js'
      );
    }
  }

  for (const r of REQUIRED_DIST_FILES) {
    if (!fs.existsSync(path.join(DIST, r))) problems.push(`dist/${r}: missing`);
  }

  if (problems.length) fail(problems.join('\n  '));
  console.log(
    `  ✓ dist/ verified: ${actual.length} .js files (${BUNDLES.length} bundles + ` +
      `${actual.length - BUNDLES.length} runtime-registered)`
  );
}

/* ------------------------------------------------------------------ *
 * 4c. Firefox variant (dist-firefox/): same bundles, one manifest key more.
 *
 * Firefox MV3 has no service workers, so AMO requires /background/scripts next
 * to /background/service_worker (BACKGROUND_SERVICE_WORKER_NOFALLBACK), while
 * Chrome's MV3 manifest keeps the service worker alone. The fallback therefore
 * never lives in dist/: it is materialised here from the already verified dist/,
 * keeping both packages identical apart from that single key.
 * ------------------------------------------------------------------ */

async function writeFirefoxDist() {
  await fsp.rm(DIST_FIREFOX, { recursive: true, force: true });
  await fsp.cp(DIST, DIST_FIREFOX, { recursive: true });
  const manifestPath = path.join(DIST_FIREFOX, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (!manifest.background || typeof manifest.background !== 'object') {
    fail('dist-firefox/manifest.json: background is missing');
  }
  // dist/manifest.json намеренно не несёт browser_specific_settings (Chrome-пакет,
  // см. rewireManifestText), поэтому Firefox-блок возвращается из корневого SSOT
  // manifest.json — единственного места, где он объявлен. Копия диста не источник.
  const bss = readJSON('manifest.json')?.browser_specific_settings;
  if (!bss || typeof bss !== 'object' || !bss.gecko || typeof bss.gecko !== 'object') {
    fail('manifest.json: browser_specific_settings.gecko is missing (required by dist-firefox)');
  }
  manifest.browser_specific_settings = JSON.parse(JSON.stringify(bss));
  manifest.browser_specific_settings.gecko.strict_min_version = FIREFOX_MIN_VERSION;
  // BYOK в Firefox-пакете недостижим → снимаем и разрешение на Google API. Chrome-манифест
  // (dist/manifest.json) не фильтруется: там BYOK остался рабочим.
  if (Array.isArray(manifest.host_permissions)) {
    manifest.host_permissions = manifest.host_permissions.filter((host) => host !== BYOK_HOST);
  }
  manifest.background.scripts = [...FIREFOX_BACKGROUND_SCRIPTS];
  // Firefox не умеет offscreen-документы: pdf.js-хост живёт в event page, а
  // неиспользуемое разрешение в AMO-пакете только пугает ревью (least privilege).
  if (Array.isArray(manifest.permissions)) {
    manifest.permissions = manifest.permissions.filter((p) => p !== 'offscreen');
  }
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

async function verifyFirefoxDist() {
  const problems = [];
  const manifest = JSON.parse(await fsp.readFile(path.join(DIST_FIREFOX, 'manifest.json'), 'utf8'));
  if (manifest?.background?.service_worker !== REWIRED_SERVICE_WORKER) {
    problems.push(
      `dist-firefox/manifest.json: background.service_worker is ` +
        `${JSON.stringify(manifest?.background?.service_worker)}, expected "${REWIRED_SERVICE_WORKER}"`
    );
  }
  if (JSON.stringify(manifest?.background?.scripts) !== JSON.stringify(FIREFOX_BACKGROUND_SCRIPTS)) {
    problems.push(
      `dist-firefox/manifest.json: background.scripts is ` +
        `${JSON.stringify(manifest?.background?.scripts)}, expected ${JSON.stringify(FIREFOX_BACKGROUND_SCRIPTS)}`
    );
  }
  const minVer = manifest?.browser_specific_settings?.gecko?.strict_min_version;
  if (minVer !== FIREFOX_MIN_VERSION) {
    problems.push(
      `dist-firefox/manifest.json: gecko.strict_min_version is ${JSON.stringify(minVer)}, ` +
        `expected "${FIREFOX_MIN_VERSION}"`
    );
  }
  const firefoxHosts = Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : [];
  if (firefoxHosts.includes(BYOK_HOST)) {
    problems.push(
      `dist-firefox/manifest.json: host_permissions must not include ${BYOK_HOST} ` +
        '(BYOK is disabled in the Firefox build)'
    );
  }
  const firefoxPerms = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  if (firefoxPerms.includes('offscreen')) {
    problems.push(
      'dist-firefox/manifest.json: permissions must not include "offscreen" (no offscreen API in Firefox)'
    );
  }
  if (JSON.stringify(manifest?.content_scripts?.[0]?.js) !== JSON.stringify(REWIRED_CONTENT_SCRIPTS)) {
    problems.push(
      `dist-firefox/manifest.json: content_scripts[0].js is ` +
        `${JSON.stringify(manifest?.content_scripts?.[0]?.js)}, expected ${JSON.stringify(REWIRED_CONTENT_SCRIPTS)}`
    );
  }
  const bgSource = await fsp.readFile(path.join(DIST_FIREFOX, REWIRED_SERVICE_WORKER), 'utf8');
  if (/\bimportScripts\s*\(/.test(bgSource)) {
    problems.push(
      `dist-firefox/${REWIRED_SERVICE_WORKER}: importScripts() must not be present ` +
        '(no Worker API in the Firefox event page)'
    );
  }
  for (const bundle of BUNDLES) {
    if (!fs.existsSync(path.join(DIST_FIREFOX, bundle))) problems.push(`dist-firefox/${bundle}: missing`);
  }
  if (problems.length) fail(problems.join('\n  '));
  console.log('  ✓ dist-firefox/ verified: background.scripts fallback for Firefox');
}

/* ------------------------------------------------------------------ *
 * 5. Build
 * ------------------------------------------------------------------ */

/**
 * esbuild plugin: regenerates the .build/entry-*.js files from the SSOTs before
 * every build (including watch rebuilds), serves them as the entry contents and
 * reports every real input through `watchFiles` so `ctx.watch()` can see it.
 */
function entryFilesPlugin() {
  return {
    name: 'ai-cm-entry-files',
    setup(build) {
      build.onStart(async () => {
        const entries = collectEntries();
        const written = await writeEntryFiles(entries);
        for (const { name, bytes, list } of written) {
          console.log(
            `[build] ${name}: ${bytes.toLocaleString('en-US')} source bytes (${list.length} files)`
          );
        }
        // Drop stale artifacts of the targets we are about to write, so switching
        // between dev and prod cannot leave an orphaned (and stale) sourcemap behind.
        for (const name of Object.keys(entries)) {
          for (const stale of [`${name}.js`, `${name}.js.map`]) {
            await fsp.rm(path.join(DIST, stale), { force: true });
          }
        }
        return {};
      });

      // The loader follows the extension: step 1 of the TS migration lets an entry
      // built from .ts sources parse as TypeScript instead of failing on annotations.
      build.onLoad({ filter: /[\\/]\.build[\\/]entry-[^\\/]+\.(?:[cm]?[jt]sx?)$/ }, async (args) => {
        const name = path.basename(args.path).replace(/^entry-/, '').replace(/\.(?:[cm]?[jt]sx?)$/, '');
        const entries = collectEntries();
        if (!entries[name]) {
          fail(`generated entry "${rel(args.path)}" has no SSOT list for bundle "${name}"`);
        }
        return {
          contents: await fsp.readFile(args.path, 'utf8'),
          loader: loaderForFile(args.path),
          // ESM-пилот: entry-*.js физически лежат в .build/, поэтому относительные
          // импорты (print.js -> ../utils/markdown.ts) резолвятся от корня репо.
          resolveDir: BUILD_DIR,
          watchFiles: watchFiles(entries),
        };
      });
    },
  };
}

/** Every input whose change must trigger a rebuild under `--watch`. */
function watchFiles(entries) {
  const files = new Set([abs('manifest.json')]);
  for (const r of ASSET_FILES) files.add(abs(r));
  for (const list of Object.values(entries)) for (const r of list) files.add(abs(r));
  // runtime-registered files are copied verbatim, so a change must rebuild too
  for (const r of runtimeRegisteredFiles()) files.add(abs(r));
  // Ph2: MAIN-перехватчики собираются отдельно, а intercept-common втягивается
  // в каждый из них — оба набора обязаны триггерить watcher.
  for (const r of MAIN_INTERCEPTS) files.add(abs(r));
  files.add(abs('utils/intercept-common.ts'));
  // Whole trees copied verbatim (icons/, _locales/, docs/screenshots/): watch the
  // directory itself, so a newly added or renamed file inside one rebuilds too.
  for (const r of ASSET_DIRS) files.add(abs(r));
  for (const r of ASSET_TREES) files.add(abs(r));
  return [...files];
}

/**
 * esbuild plugin: asset copying and dist verification run after the bundles were
 * written. Hooking onEnd means `--watch` keeps dist/ and dist-firefox/ in sync
 * through the same code path as a one-shot build.
 */
function postBuildPlugin() {
  return {
    name: 'ai-cm-post-build',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length) return; // esbuild rejects the build on its own
        await finishBuild(collectEntries());
      });
    },
  };
}

async function finishBuild(entries) {
  await fsp.mkdir(DIST, { recursive: true });
  // Ph2: MAIN-перехватчики собираются до copyAssets; свои dist/core/<name>.js
  // они пишут сами, а copyAssets эти четыре пути пропускает.
  await buildMainIntercepts();
  // Ph2: intercept-common.js вшит в MAIN-бандлы и больше не копируется. Копия
  // от предыдущей сборки иначе осталась бы в dist/ и упала бы в verifyDist.
  await fsp.rm(path.join(DIST, 'utils', 'intercept-common.js'), { force: true });
  // Ph2: stream-frames.js переведён на ESM и вшит в бандл core/qwen-intercept.js,
  // из js[] в background.js удалён. Копия от предыдущей сборки (verbatim из
  // runtimeRegisteredFiles) иначе осталась бы в dist/ и упала бы в verifyDist.
  await fsp.rm(path.join(DIST, 'utils', 'stream-frames.js'), { force: true });
  const outputs = Object.keys(entries).map((name) => ({
    name,
    outfile: path.join(DIST, `${name}.js`),
  }));
  const copied = [...(await copyAssets()), ...(await copyPdfjsAssets())];
  console.log(`[build] mode=${MINIFY ? 'production' : 'development'} sourcemap=${SOURCEMAP}`);
  console.log(`[build] ${copied.length} asset file(s) copied into dist/`);
  await verify(outputs);
  await verifyDist();
  await writeFirefoxDist();
  await verifyFirefoxDist();
}

/* ------------------------------------------------------------------ *
 * 6. Runner: one-shot build or native esbuild watch
 * ------------------------------------------------------------------ */

function buildOptions(entries = collectEntries()) {
  return {
    // Entry names are spelled relative to .build/ (absWorkingDir) so esbuild's
    // module label stays short: the label is baked into the bundle by the
    // CommonJS wrapper (`// entry-background.js`, `require_entry_background`),
    // and keeping it minimal keeps every bundle within 1% of the old sizes.
    absWorkingDir: BUILD_DIR,
    entryPoints: Object.fromEntries(
      Object.keys(entries).map((name) => [name, path.basename(entryPath(name))])
    ),
    outdir: DIST,
    // Entry names are flat: dist/background.js, dist/shared-i18n.js, … — the
    // bundles all live at the dist root, whatever .build/ nesting they came from.
    entryNames: '[name]',
    format: 'iife', // classic script: MV3 content scripts / non-module manifest
    bundle: true,
    platform: 'browser',
    target: 'es2020',
    sourcemap: SOURCEMAP,
    minify: MINIFY,
    external: [],
    legalComments: 'none',
    logLevel: WATCH ? 'info' : 'warning',
    plugins: [entryFilesPlugin(), postBuildPlugin()],
  };
}

/* ------------------------------------------------------------------ */

async function main() {
  if (CLEAN_ONLY) {
    await fsp.rm(DIST, { recursive: true, force: true });
    await fsp.rm(DIST_FIREFOX, { recursive: true, force: true });
    console.log('[build] removed dist/ and dist-firefox/');
    return;
  }

  if (ENTRIES_ONLY) {
    const entries = collectEntries();
    const written = await writeEntryFiles(entries);
    for (const { file, list } of written) {
      console.log(`  ${rel(file)} <- ${list.length} file(s), SSOT order preserved`);
    }
    console.log('[build] entry files written, no bundle build requested.');
    return;
  }

  const entries = collectEntries();
  // absWorkingDir is .build/ (see buildOptions), so the directory must exist
  // before esbuild resolves the entry points on a clean clone.
  await fsp.mkdir(BUILD_DIR, { recursive: true });
  console.log('[build] entries derived from SSOTs:');
  for (const [name, list] of Object.entries(entries)) console.log(`  ${name} <- ${list.length} file(s)`);
  console.log(`  runtime-registered <- ${runtimeRegisteredFiles().length} file(s) (copied verbatim; MAIN intercepts bundled)`);
  console.log(`[build] generated entry files: ${rel(BUILD_DIR)}/entry-<name>.js`);

  if (WATCH) {
    const ctx = await esbuild.context(buildOptions(entries));
    await ctx.watch();
    const stop = async () => {
      await ctx.dispose();
      console.log('\n[build] watcher stopped.');
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.log('[build] watching for changes… (native esbuild watch)');
  } else {
    await esbuild.build(buildOptions(entries));
    console.log('[build] done.');
  }
}

main().catch((err) => fail(err.stack || String(err)));
