/**
 * Пин формата CHANGELOG.md (Keep a Changelog).
 *
 * Требование: КАЖДЫЙ версионный заголовок имеет вид
 *   ## [x.y.z] - YYYY-MM-DD
 * (дефис с пробелами; длинное тире «—» не допускается), и в файле присутствуют
 * как минимум заголовки 2.0.5, 2.0.4, 2.0.3, 2.0.2, 2.0.1, 2.0.0, 1.19.0, 1.18.0, 1.17.0, 1.16.0, 1.15.3.
 *
 * Тест читает реальный CHANGELOG.md и не трогает ни код расширения,
 * ни содержимое секций (Added/Fixed/Changed).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');

const HEADING_RE = /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/;
const REQUIRED_VERSIONS = ['2.0.5', '2.0.4', '2.0.3', '2.0.2', '2.0.1', '2.0.0', '1.19.0', '1.18.0', '1.17.0', '1.16.0', '1.15.3'];

const lines = changelog.split(/\r?\n/);
const versionHeadings = lines.filter(function (l) { return l.indexOf('## [') === 0; });

describe('CHANGELOG.md: формат версионных заголовков (Keep a Changelog)', () => {
  test('все строки-заголовки версии матчат /^## \\[\\d+\\.\\d+\\.\\d+\\] - \\d{4}-\\d{2}-\\d{2}$/', () => {
    expect(versionHeadings.length).toBeGreaterThan(0);
    versionHeadings.forEach(function (h) {
      expect(h).toMatch(HEADING_RE);
    });
  });

  test('заголовков не меньше 4 и присутствуют 2.0.5, 2.0.4, 2.0.3, 2.0.2, 2.0.1, 2.0.0, 1.19.0, 1.18.0, 1.17.0, 1.16.0, 1.15.3', () => {
    expect(versionHeadings.length).toBeGreaterThanOrEqual(4);
    REQUIRED_VERSIONS.forEach(function (v) {
      const matched = versionHeadings.filter(function (h) {
        return h.indexOf('## [' + v + '] - ') === 0 && HEADING_RE.test(h);
      });
      expect(matched.length).toBe(1);
    });
  });

  test('в версионных заголовках нет длинного тире «—»', () => {
    versionHeadings.forEach(function (h) {
      expect(h).not.toContain('—');
    });
  });
});
