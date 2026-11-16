/**
 * strict-config: the strict TS gate is pinned.
 *
 * `tsconfig.strict.json` is the incremental strict-typing track: `types/**`,
 * the TypeScript adapters and the leaf `utils/*.ts` batches (B1 + B2 + B3 + B4) that are
 * already clean. The strict run stays a small, reviewable batch while the main
 * `tsconfig.json` keeps `strict: false` for the rest of the tree (utils/, core/,
 * options/, JS files). Widening `include` here without cleaning the new batch
 * turns the gate red; relaxing `strict` makes the track meaningless.
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

describe('tsconfig.strict.json (adapters + utils B1/B2/B3/B4 strict gate)', () => {
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

  test('include covers types, adapters and the B1/B2/B3/B4 utils batch only', () => {
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
    ]) {
      expect(cfg.include).toContain(file);
    }
    // Only the clean B1/B2/B3/B4 leaves are in scope: no globs over the rest of utils/core.
    expect(cfg.include.some((p) => /^(utils|core)\//.test(p) && !p.endsWith('.ts'))).toBe(false);
    expect(cfg.include.some((p) => p.startsWith('core/'))).toBe(false);
    expect(cfg.include).not.toContain('utils/**/*.ts');
  });

  test('main tsconfig stays non-strict', () => {
    const cfg = readTsconfig('tsconfig.json');
    expect(cfg.compilerOptions.strict).toBe(false);
  });
});
