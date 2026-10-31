/**
 * Chrome-пакет не должен объявлять browser_specific_settings.
 *
 * browser_specific_settings — блок Firefox/AMO: gecko.id (ADDON_ID_REQUIRED) и
 * data_collection_permissions (MISSING_DATA_COLLECTION_PERMISSIONS). Chrome этот
 * ключ не знает, а data_collection_permissions: none читается как заявленное
 * расширению разрешение на сбор данных — ложный сигнал в Chrome Web Store.
 * Поэтому build.mjs (rewireManifestText) вычищает блок из dist/manifest.json, а
 * writeFirefoxDist возвращает его из корневого SSOT manifest.json в
 * dist-firefox/manifest.json, где он обязателен.
 *
 * Тест читает СГЕНЕРИРОВАННЫЕ манифесты (dist/ и dist-firefox/), а не корневой
 * manifest.json: корневой блок — вход сборки, а не артефакт. Если dist/ ещё не
 * собран (чистый клон), тест один раз вызывает node build.mjs — иначе проверка
 * молча зависела бы от предыдущего прогона сборки.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CHROME_MANIFEST = path.join(ROOT, 'dist', 'manifest.json');
const FIREFOX_MANIFEST = path.join(ROOT, 'dist-firefox', 'manifest.json');

let chromeRaw;
let chromeManifest;
let firefoxRaw;
let firefoxManifest;

beforeAll(() => {
  if (!fs.existsSync(CHROME_MANIFEST) || !fs.existsSync(FIREFOX_MANIFEST)) {
    execFileSync(process.execPath, [path.join(ROOT, 'build.mjs')], { cwd: ROOT, stdio: 'pipe' });
  }
  chromeRaw = fs.readFileSync(CHROME_MANIFEST, 'utf8');
  chromeManifest = JSON.parse(chromeRaw);
  firefoxRaw = fs.readFileSync(FIREFOX_MANIFEST, 'utf8');
  firefoxManifest = JSON.parse(firefoxRaw);
}, 120000);

describe('build: browser_specific_settings — только в Firefox-пакете', () => {
  test('dist/manifest.json: ключа browser_specific_settings нет (ни в JSON, ни в тексте)', () => {
    expect(Object.prototype.hasOwnProperty.call(chromeManifest, 'browser_specific_settings')).toBe(false);
    expect(chromeRaw).not.toContain('browser_specific_settings');
    expect(chromeRaw).not.toContain('data_collection_permissions');
  });

  test('dist/manifest.json: Chrome-инварианты не сломаны', () => {
    expect(chromeManifest.manifest_version).toBe(3);
    expect(chromeManifest.background.service_worker).toBe('background.js');
    expect('scripts' in chromeManifest.background).toBe(false);
    expect(chromeManifest.content_scripts[0].js).toEqual(['content.js']);
  });

  test('dist-firefox/manifest.json: блок на месте — gecko.id, strict_min_version, data_collection_permissions', () => {
    const bss = firefoxManifest.browser_specific_settings;
    expect(bss && typeof bss === 'object').toBe(true);
    expect(bss.gecko.id).toBe('ai-context-monitor@shtakan');
    expect(bss.gecko.strict_min_version).toBe('140.0');
    expect(bss.gecko.data_collection_permissions).toEqual({ required: ['none'] });
  });

  test('dist-firefox/manifest.json: Firefox-блок остался в тексте и background.scripts на месте', () => {
    expect(firefoxRaw).toContain('browser_specific_settings');
    // v2.0.37: pdf.js в event page — pdf-text.js и pdf-host.js подключаются до парса,
    // background.js остаётся первым и объявляет debugLog для SW-дубля.
    expect(firefoxManifest.background.scripts).toEqual([
      'background.js',
      'parser/pdf-text.js',
      'parser/pdf-host.js'
    ]);
  });
});
