/**
 * Аудит-волна 1 / R4 + Шаг A.2 (v53-A2): origin-контракт paste-capture.
 *
 * Отправитель (core/content.js, ISOLATED) и приёмник (core/claude-intercept.js,
 * MAIN) живут в ОДНОМ окне, поэтому канал обязан быть same-origin:
 *   - отправитель: targetOrigin = location.origin с гардом пустого/'null'
 *     значения (fallback '/'); window.origin (легаси-алиас) в non-HTTP/opaque
 *     контекстах даёт undefined → postMessage бросает SyntaxError;
 *   - приёмник: ДО записи в pasteQueue проверяются ev.source === window и
 *     ev.origin === location.origin — иначе сторонний фрейм может подбросить
 *     текст и подменить pasted-вложение (риски R8-R10).
 * Здесь source-level пины: логика захвата/доставки не изменена.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const contentSrc = require('./helpers/content-source.js').contentSource;
const interceptSrc = fs.readFileSync(path.join(ROOT, 'core', 'claude-intercept.js'), 'utf8');

function pasteBlock() {
  const from = contentSrc.indexOf('PASTE-CAPTURE');
  const to = contentSrc.indexOf('// ========== ЗАПУСК ==========');
  return contentSrc.slice(from, to);
}

function pasteRecvBlock() {
  const from = interceptSrc.indexOf('__aiCmPasteMsgListenerInstalled');
  const to = interceptSrc.indexOf('function scheduleFileTextFetch(');
  return interceptSrc.slice(from, to);
}

describe('R4/A.2: paste-capture postMessage использует location.origin (pasteOrigin)', () => {
  test('пасте-capture шлёт в pasteOrigin, а НЕ в \'*\'', () => {
    expect(contentSrc).toContain(
      "window.postMessage({ source: 'ai-cm-paste', text: String(t).slice(0, 500000) }, pasteOrigin);"
    );
  });

  test('targetOrigin — location.origin под гардом пустого/\'null\' значения', () => {
    const block = pasteBlock();
    expect(block).toContain('var pasteOrigin = \'/\';');
    expect(block).toContain('var oOrig = window.location.origin;');
    expect(block).toContain("if (typeof oOrig === 'string' && oOrig && oOrig !== 'null') pasteOrigin = oOrig;");
    expect(block).toContain("catch (eO) { pasteOrigin = '/'; }");
  });

  test('легаси window.origin в рантайме больше не используется', () => {
    expect(contentSrc).not.toContain(', window.origin);');
    expect(pasteBlock()).not.toContain('window.origin');
  });

  test('в блоке paste-capture нет wildcard targetOrigin \'*\'', () => {
    expect(pasteBlock()).not.toContain("}, '*');");
    expect(pasteBlock()).not.toContain("'*'");
  });

  test('пост-сообщение в content.js вне paste-capture не затронуто', () => {
    // единственный window.postMessage в content.js — paste-capture (pasteOrigin)
    const pms = contentSrc.match(/window\.postMessage\(/g) || [];
    expect(pms.length).toBe(1);
  });

  test('приёмник: ev.source === window и ev.origin === location.origin ДО pasteQueue.push', () => {
    const block = pasteRecvBlock();
    expect(block).toContain('if (!ev || ev.source !== window) return;');
    expect(block).toContain('if (ev.origin !== location.origin) return;');
    const guardAt = block.indexOf('if (ev.origin !== location.origin) return;');
    const pushAt = block.indexOf('pasteQueue.push({');
    expect(guardAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(guardAt); // гард стоит РАНЬШЕ записи в очередь
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

  test('НЕ трогать: приёмник сохранил контракт data/paste-очереди', () => {
    const block = pasteRecvBlock();
    expect(block).toContain("if (!d || d.source !== 'ai-cm-paste' || typeof d.text !== 'string' || !d.text) return;");
    expect(block).toContain('pasteQueue.push({ text: d.text, ts: Date.now() });');
    expect(block).toContain('while (pasteQueue.length > 5) pasteQueue.shift();');
    expect(block).toContain("window.addEventListener('message', function (ev) {");
  });
});
