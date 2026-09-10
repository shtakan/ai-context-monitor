/**
 * Аудит-волна 1 / R4: paste-capture в core/content.js шлёт postMessage с
 * targetOrigin '*' — текст буфера уходит без ограничения по origin. Канал
 * ISOLATED→MAIN живёт внутри одного окна (listener того же окна), поэтому
 * window.origin безопаснее и эквивалентен по доставке.
 * Здесь source-level пин: postMessage блока paste-capture использует
 * window.origin (НЕ '*'); логика захвата/доставки не изменена.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const contentSrc = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');

function pasteBlock() {
  const from = contentSrc.indexOf('PASTE-CAPTURE');
  const to = contentSrc.indexOf('// ========== ЗАПУСК ==========');
  return contentSrc.slice(from, to);
}

describe('R4: content.js — paste-capture postMessage использует window.origin', () => {
  test('пасте-capture шлёт в window.origin, а НЕ в \'*\'', () => {
    expect(contentSrc).toContain(
      "window.postMessage({ source: 'ai-cm-paste', text: String(t).slice(0, 500000) }, window.origin);"
    );
  });

  test('в блоке paste-capture нет wildcard targetOrigin \'*\'', () => {
    expect(pasteBlock()).not.toContain("}, '*');");
    expect(pasteBlock()).not.toContain("'*'");
  });

  test('пост-сообщение в content.js вне paste-capture не затронуто', () => {
    // единственный window.postMessage в content.js — paste-capture (window.origin)
    const pms = contentSrc.match(/window\.postMessage\(/g) || [];
    expect(pms.length).toBe(1);
  });

  test('НЕ трогать: логика захвата/доставки paste-capture не изменена', () => {
    const block = pasteBlock();
    expect(block).toContain("if (!window.location.hostname.includes('claude.ai')) return;");
    expect(block).toContain("document.addEventListener('paste', function (e) {");
    expect(block).toContain("e.clipboardData && e.clipboardData.getData('text')");
    expect(block).toContain('String(t).trim()');
    expect(block).toContain('String(t).slice(0, 500000)');
    expect(block).toContain("debugLog('log', '[AI CM][Claude][pasted] paste-capture len=' + t.length);");
    expect(block).toContain("debugLog('log', '[AI CM][Claude][pasted] paste-send len=' + t.length);");
  });
});
