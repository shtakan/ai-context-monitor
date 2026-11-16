/**
 * strict-config (stage 0): the strict TS gate for adapters is pinned.
 *
 * `tsconfig.strict.json` is the incremental strict-typing track: only
 * The scope is `types/**` plus the TypeScript adapters, so the strict run
 * stays a small, reviewable batch while the main
 * `tsconfig.json` keeps `strict: false` for the rest of the tree (utils/, core/,
 * options/, JS files). Widening `include` here without cleaning the new batch
 * turns the gate red; relaxing `strict` makes the adapters track meaningless.
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

describe('tsconfig.strict.json (adapters strict gate)', () => {
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

  test('include covers types and adapters only', () => {
    const cfg = readTsconfig('tsconfig.strict.json');
    expect(cfg.include).toContain('adapters/**/*.ts');
    expect(cfg.include).toContain('types/**/*.d.ts');
    expect(cfg.include.some((p) => /^(utils|core)\//.test(p))).toBe(false);
  });

  test('main tsconfig stays non-strict', () => {
    const cfg = readTsconfig('tsconfig.json');
    expect(cfg.compilerOptions.strict).toBe(false);
  });
});
