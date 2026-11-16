/**
 * strict-config: the strict TS gate is pinned.
 *
 * `tsconfig.strict.json` is the incremental strict-typing track: `types/**`, the
 * TypeScript adapters, the leaf `utils/*.ts` batches (B1 + B2 + B3 + B4 + B5 + B6) and
 * the eight `core/*.ts` files of the core batches (B7 closed six of them, B8 `core/widget.ts`
 * 38 → 0, B9 `core/background.ts` 59 → 0; `core/content.ts` + `core/export-manager.ts`
 * are the remaining 177). The strict run stays
 * a small, reviewable batch while the main `tsconfig.json` keeps `strict: false` for
 * the rest of the tree (options/, JS files). Widening `include` here without cleaning
 * the new batch turns the gate red; relaxing `strict` makes the track meaningless.
 * Both regressions are caught below.
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

/** Strip line and block comments outside strings (tsconfig globs contain "/*"). */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Parse a tsconfig file, tolerating UTF-8 BOM and comments. */
function readTsconfig(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(stripJsonComments(raw));
}

describe('tsconfig.strict.json (adapters + utils B1/B2/B3/B4/B5/B6 + core B7/B8/B9 strict gate)', () => {
  test('exists and extends the main tsconfig', () => {
    expect(fs.existsSync(path.join(ROOT, 'tsconfig.strict.json'))).toBe(true);
    const cfg = readTsconfig('tsconfig.strict.json');
    expect(cfg.extends).toBe('./tsconfig.json');
  });

  test('enables strict and emits nothing', () => {
    const cfg = readTsconfig('tsconfig.strict.json');
    expect(cfg.compilerOptions.strict).toBe(true);
    expect(cfg.compilerOptions.noEmit).toBe(true);
    expect(cfg.compilerOptions.declaration).toBe(false);
    expect(cfg.compilerOptions.emitDeclarationOnly).toBe(false);
  });

  test('include covers types, adapters, the B1/B2/B3/B4/B5/B6 utils batch and the eight B7/B8/B9 core files', () => {
    const cfg = readTsconfig('tsconfig.strict.json');
    expect(cfg.include).toContain('adapters/**/*.ts');
    expect(cfg.include).toContain('types/**/*.d.ts');
    for (const file of [
      'utils/debug.ts',
      'utils/model-config.ts',
      'utils/perplexity-parser.ts',
      'utils/archive-import.ts',
      'utils/chatgpt-conversation-parser.ts',
      'utils/stream-frames.ts',
      'utils/gemini-batchexecute-parser.ts',
      'utils/google-search-folwr-parser.ts',
      'utils/export-emit-pipeline.ts',
      'utils/gemini-intercept-logic.ts',
      'core/content.ts',
      'core/widget.ts',
      'core/state.ts',
      'core/base-handler.ts',
      'core/hybrid-tail.ts',
      'core/export-manager.ts',
      'core/background.ts',
      'core/gemini-diag-dump.ts',
    ]) {
      expect(cfg.include).toContain(file);
    }
    // Only the in-track B1–B9 files are in scope: no globs over the rest of utils/core.
    expect(cfg.include.some((p) => /^(utils|core)\//.test(p) && !p.endsWith('.ts'))).toBe(false);
    // The B7/B8/B9 core batch is exactly the eight core entry points — a ninth would pull an unclean file in.
    expect(cfg.include.filter((p) => p.startsWith('core/'))).toHaveLength(8);
    expect(cfg.include).not.toContain('utils/**/*.ts');
    expect(cfg.include).not.toContain('core/**/*.ts');
  });

  test('main tsconfig stays non-strict', () => {
    const cfg = readTsconfig('tsconfig.json');
    expect(cfg.compilerOptions.strict).toBe(false);
  });
});
