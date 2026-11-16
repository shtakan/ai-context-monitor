/**
 * chrome-types-config: the `@types/chrome` track is pinned.
 *
 * `tsconfig.chrome.json` is the separate run that types `chrome.*` for real
 * (`@types/chrome`) while the main `tsconfig.json` and `tsconfig.strict.json`
 * keep `types: []` and stay green through the `types/chrome-any.d.ts` shim.
 * The shim must never leak into the chrome run (it would shadow the package
 * types with `any`), and the main run must never pull `@types/chrome` in (it
 * would light up the whole tree at once instead of batch by batch).
 *
 * Track progress: the measurement run started at 28 errors and B12
 * (`options/options.js`, 17 → 0) leaves 11 — `core/background.ts` 6,
 * `core/export-manager.ts` 4, `core/content.ts` 1. The options page itself
 * stays pinned by `tests/options-checkjs.test.js`; `include` is unchanged.
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

/** Parse a tsconfig file, tolerating UTF-8 BOM. */
function readTsconfig(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

describe('tsconfig.chrome.json (@types/chrome measurement run)', () => {
  test('exists and extends the main tsconfig', () => {
    expect(fs.existsSync(path.join(ROOT, 'tsconfig.chrome.json'))).toBe(true);
    const cfg = readTsconfig('tsconfig.chrome.json');
    expect(cfg.extends).toBe('./tsconfig.json');
  });

  test('loads the chrome types and emits nothing', () => {
    const cfg = readTsconfig('tsconfig.chrome.json');
    expect(cfg.compilerOptions.types).toContain('chrome');
    expect(cfg.compilerOptions.noEmit).toBe(true);
  });

  test('excludes the chrome:any shim', () => {
    const cfg = readTsconfig('tsconfig.chrome.json');
    expect(cfg.exclude).toContain('types/chrome-any.d.ts');
  });

  test('main tsconfig does not load chrome types', () => {
    const cfg = readTsconfig('tsconfig.json');
    expect(cfg.compilerOptions.types).not.toContain('chrome');
  });
});
