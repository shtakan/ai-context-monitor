/**
 * LOW-2 (аудит перед релизом): smoke-тест manifest.json.
 *
 * Пакет собирается ТОЛЬКО под Chromium MV3 (Edge Add-ons / Chrome Web Store),
 * Firefox/Opera-специфичные поля в манифесте недопустимы: они либо игнорируются,
 * либо меняют поведение загрузки расширения на целевых браузерах. Тест читает
 * РЕАЛЬНЫЙ manifest.json (не копию) и падает при появлении чужих ключей.
 *
 * Проверяется:
 *   1) только Chromium-MV3 ключи (allow-лист верхнего уровня);
 *   2) manifest_version === 3 и нет legacy MV2-полей;
 *   3) permissions: точный список, без "<all_urls>" и без host-паттернов;
 *   4) совместимость: browser_specific_settings/options_ui/page_action/... отсутствуют
 *      (в т.ч. как подстрока в сыром тексте — ловим и вложенные вставки);
 *   5) инварианты аудита: version 1.18.0, default_locale ru, 9 host_permissions.
 *
 * Тест НИЧЕГО не меняет: manifest — замороженный инвариант (i18n-набор, E-1
 * гарды, privacy).
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const RAW = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const manifest = JSON.parse(RAW);

// Ключи Chromium MV3, которые проект реально использует.
const CHROMIUM_MV3_KEYS = [
  'manifest_version', 'name', 'version', 'description', 'default_locale',
  'homepage_url', 'permissions', 'host_permissions', 'background',
  'content_scripts', 'action', 'icons'
];

// Ключи, специфичные для Firefox/Opera/старых сборок MV2 — в Chromium-MV3 пакете
// их быть не должно (browser_specific_settings — Firefox, options_ui — устаревший
// способ, browser_action/page_action — MV2, developer/update_url — не для стора).
const NON_CHROMIUM_KEYS = [
  'browser_specific_settings', 'applications', 'options_ui', 'browser_action',
  'page_action', 'sidebar_action', 'chrome_settings_overrides', 'developer',
  'update_url', 'content_security_policy_string', 'applications'
];

describe('LOW-2: manifest.json — smoke-тест состава ключей (Chromium MV3)', () => {
  test('разбор: manifest.json — валидный JSON-объект', () => {
    expect(manifest && typeof manifest).toBe('object');
    expect(Array.isArray(manifest)).toBe(false);
  });

  test('верхний уровень содержит ТОЛЬКО Chromium-MV3 ключи (нет лишних)', () => {
    const actual = Object.keys(manifest).sort();
    const unknown = actual.filter(function (k) { return CHROMIUM_MV3_KEYS.indexOf(k) === -1; });
    expect(unknown).toEqual([]);
  });

  test('все ожидаемые ключи присутствуют (состав не «усох»)', () => {
    CHROMIUM_MV3_KEYS.forEach(function (key) {
      expect([key, Object.prototype.hasOwnProperty.call(manifest, key)]).toEqual([key, true]);
    });
  });

  test('Firefox/Opera/MV2-специфичных полей нет — ни как ключей, ни как подстрок', () => {
    NON_CHROMIUM_KEYS.forEach(function (key) {
      expect([key, Object.keys(manifest).indexOf(key)]).toEqual([key, -1]);
      expect([key, RAW.indexOf(key)]).toEqual([key, -1]);   // вложенные вставки тоже ловим
    });
  });

  test('manifest_version === 3 (MV3), MV2-маркеров нет', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(RAW).not.toContain('manifest_version": 2');
    expect(RAW).not.toContain('"persistent"');           // MV2 background.page/persistent
    expect(RAW).not.toContain('background_page');        // MV2
  });

  test('permissions: точный список, без "<all_urls>" и без host-паттернов', () => {
    expect(manifest.permissions).toEqual(['scripting', 'storage', 'notifications']);
    manifest.permissions.forEach(function (p) {
      expect(['permission ' + p, /[*:/]/.test(p)]).toEqual(['permission ' + p, false]);
    });
    expect(manifest.permissions).not.toContain('<all_urls>');
    expect(RAW).not.toContain('<all_urls>');
    expect(RAW).not.toContain('"*://*/*"');
  });

  test('host-доступы — только явные https-паттерны целевых сервисов (9 штук)', () => {
    expect(manifest.host_permissions).toHaveLength(9);
    manifest.host_permissions.forEach(function (hp) {
      expect([hp, /^https:\/\//.test(hp)]).toEqual([hp, true]);
    });
    expect(manifest.host_permissions).toContain('https://gemini.google.com/*');
  });

  test('инварианты аудита не тронуты: version, default_locale, background, popup, content_scripts', () => {
    expect(manifest.version).toBe('1.18.0');
    expect(manifest.default_locale).toBe('ru');
    expect(manifest.background.service_worker).toBe('core/background.js');
    expect(manifest.action.default_popup).toBe('options/options.html');
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].js).toContain('core/content.js');
    // архив-импорт — страница настроек (chrome.storage), НЕ content_script
    expect(manifest.content_scripts[0].js).not.toContain('utils/archive-import.js');
  });

  test('privacy: манифест не запрашивает сетевых/идентификационных разрешений', () => {
    ['tabs', 'webRequest', 'cookies', 'history', 'identity', 'geolocation', 'clipboardRead'].forEach(function (p) {
      expect([p, manifest.permissions.indexOf(p)]).toEqual([p, -1]);
    });
  });
});
