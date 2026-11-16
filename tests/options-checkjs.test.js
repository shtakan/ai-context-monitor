/**
 * options-checkjs: пин на типизацию legacy-страницы настроек.
 *
 * `options/options.js` добавлен в `tsconfig.include` точечно (не `options/**`):
 * файл проверяется `checkJs` в strict:false и закрыт JSDoc-типами DOM-элементов
 * (63 TS2339: value/checked/hidden/style/placeholder/disabled/files/type).
 * Сам `npx tsc --noEmit` — отдельный гейт и из jest не запускается; здесь
 * фиксируется только конфигурация и запрет type-check escape-директив.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TSCONFIG = path.join(ROOT, 'tsconfig.json');
const OPTIONS_JS = path.join(ROOT, 'options', 'options.js');

describe('options/options.js в checkJs', () => {
  test('tsconfig.include содержит options/options.js точечно', () => {
    const tsconfig = JSON.parse(fs.readFileSync(TSCONFIG, 'utf8'));
    expect(Array.isArray(tsconfig.include)).toBe(true);
    expect(tsconfig.include).toContain('options/options.js');
    // Не разворачиваем на весь каталог: остальные options/*.js не проверяются.
    expect(tsconfig.include).not.toContain('options/**');
    expect(tsconfig.compilerOptions.allowJs).toBe(true);
    expect(tsconfig.compilerOptions.checkJs).toBe(true);
  });

  test('в файле нет @ts-nocheck', () => {
    const source = fs.readFileSync(OPTIONS_JS, 'utf8');
    expect(source).not.toContain('@ts-nocheck');
  });
});
