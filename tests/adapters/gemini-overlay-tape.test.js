/**
 * v81 (O1 white-screen, вариант A): при tapeWasUsedInThisColdStart=true оверлей
 * aiCmSetScrollOverlay(true, reason) с reason 'loader'/'loader-restart'/'loader-fallback'
 * НЕ показывается — тейп уже отрисовал полную историю (непрозрачный экран поверх ленты
 * давал «белый экран» 2–3с на холодном открытии чата с тейпом).
 *
 * Гарды извлекаются РЕАЛЬНЫМ блоком из core/gemini-intercept.js (по маркеру-вызову
 * aiCmSetScrollOverlay(true, '<reason>')) и исполняются в песочнице с `with` — тесты
 * гоняют исходный код, а не копию логики.
 *
 * Проверяем:
 *   а) tapeWasUsedInThisColdStart=true + loader-restart/loader-fallback →
 *      aiCmSetScrollOverlay(true,...) НЕ вызван, есть лог overlay-suppressed;
 *   б) tapeWasUsedInThisColdStart=false + loader-restart → оверлей включён как прежде
 *      (reason=loader-restart), лога overlay-suppressed нет (байтово-идентичный сценарий);
 *   в) «НЕ трогать»: overlay-off/restore (loader-done 2×rAF, rerun-overlay-disarm) и
 *      visibilitychange/pagehide-снятие остаются байтово-идентичными исходнику.
 */
const fs = require('fs');
const path = require('path');

const coreSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
  'utf8'
);

// --- извлечение гарда (if tapeWasUsedInThisColdStart === true {...} else {...}),
// внутри которого лежит вызов aiCmSetScrollOverlay(true, '<reason>') ---
function extractGuardFor(reason) {
  const call = "aiCmSetScrollOverlay(true, '" + reason + "');";
  const ci = coreSrc.indexOf(call);
  expect(ci).toBeGreaterThan(-1); // вызов найден
  const guardMarker = 'if (tapeWasUsedInThisColdStart === true) {';
  const gi = coreSrc.lastIndexOf(guardMarker, ci);
  expect(gi).toBeGreaterThan(-1); // гард найден
  expect(ci - gi).toBeLessThan(900); // гард действительно рядом с вызовом
  // баланс скобок if/else-if/else: `}` перед `else` НЕ завершает гард
  let depth = 0;
  let i = gi;
  for (; i < coreSrc.length; i++) {
    const ch = coreSrc[i];
    if (ch === '{') { depth++; continue; }
    if (ch !== '}') continue;
    depth--;
    if (depth === 0) {
      let j = i + 1;
      while (j < coreSrc.length && /\s/.test(coreSrc[j])) j++;
      if (coreSrc.slice(j, j + 4) === 'else') continue; // `} else ...` — цепочка продолжается
      i++;
      break;
    }
  }
  return coreSrc.slice(gi, i);
}

// --- песочница: гард исполняется с with(ctx) ---
function runGuard(snippet, ctx) {
  ctx.debugLog = ctx.debugLog || function (level, msg) { ctx.logs.push(String(msg)); };
  ctx.aiCmSetScrollOverlay = ctx.aiCmSetScrollOverlay || function (on, reason) {
    ctx.calls.push({ on: !!on, reason: reason });
  };
  ctx.getConvId = ctx.getConvId || function () { return 'conv-1'; };
  const fn = new Function('ctx', 'with (ctx) {\n' + snippet + '\n}');
  fn(ctx);
  return ctx;
}

function baseCtx(overrides) {
  return Object.assign({
    logs: [],
    calls: [],
    tapeWasUsedInThisColdStart: false,
    // для loader-guard else-ветки: debugLog использует sc.height
    sc: { height: function () { return 9000; } },
    aiCmScrollOverlay: null // loader-fallback: оверлей не поднят
  }, overrides || {});
}


describe('v81 O1 white-screen: tape present suppresses loader overlays', () => {
  describe('а) баг-сценарий: tapeWasUsedInThisColdStart=true → overlay НЕ включён', () => {
    it('loader-restart: aiCmSetScrollOverlay(true, loader-restart) НЕ вызван, есть overlay-suppressed', () => {
      const ctx = runGuard(extractGuardFor('loader-restart'), baseCtx({ tapeWasUsedInThisColdStart: true }));
      expect(ctx.calls).toEqual([]); // никаких overlay-on
      const joined = ctx.logs.join('\n');
      expect(joined).toContain('overlay-suppressed reason=tape-present convId=conv-1');
    });

    it('loader-fallback: aiCmSetScrollOverlay(true, loader-fallback) НЕ вызван, есть overlay-suppressed', () => {
      const ctx = runGuard(extractGuardFor('loader-fallback'), baseCtx({ tapeWasUsedInThisColdStart: true }));
      expect(ctx.calls).toEqual([]); // никаких overlay-on
      const joined = ctx.logs.join('\n');
      expect(joined).toContain('overlay-suppressed reason=tape-present convId=conv-1');
    });

    it('loader (первое hide в __applyHide): тоже подавлен', () => {
      const ctx = runGuard(extractGuardFor('loader'), baseCtx({ tapeWasUsedInThisColdStart: true }));
      expect(ctx.calls).toEqual([]);
      const joined = ctx.logs.join('\n');
      expect(joined).toContain('overlay-suppressed reason=tape-present convId=conv-1');
    });
  });

  describe('б) байтово-идентично: tapeWasUsedInThisColdStart=false → оверлей включён как прежде', () => {
    it('loader-restart: оверлей включён reason=loader-restart, overlay-suppressed нет', () => {
      const ctx = runGuard(extractGuardFor('loader-restart'), baseCtx({ tapeWasUsedInThisColdStart: false }));
      expect(ctx.calls).toEqual([{ on: true, reason: 'loader-restart' }]);
      const joined = ctx.logs.join('\n');
      expect(joined).not.toContain('overlay-suppressed');
    });

    it('loader-fallback: оверлей включён reason=loader-fallback (overlay был снят)', () => {
      const ctx = runGuard(extractGuardFor('loader-fallback'), baseCtx({ tapeWasUsedInThisColdStart: false }));
      expect(ctx.calls).toEqual([{ on: true, reason: 'loader-fallback' }]);
      const joined = ctx.logs.join('\n');
      expect(joined).not.toContain('overlay-suppressed');
    });

    it('loader (первое hide): оверлей включён reason=loader + hide-лог как прежде', () => {
      const ctx = runGuard(extractGuardFor('loader'), baseCtx({ tapeWasUsedInThisColdStart: false }));
      expect(ctx.calls).toEqual([{ on: true, reason: 'loader' }]);
      const joined = ctx.logs.join('\n');
      expect(joined).toContain('hide reason=loader-overlay');
      expect(joined).not.toContain('overlay-suppressed');
    });
  });

  describe('в) «НЕ трогать»: overlay-off/restore и visibilitychange-снятие без изменений', () => {
    it('loader-done (снятие после ДВУХ rAF + seq-гвард) байтово-идентично исходнику', () => {
      const removal = '' +
        '        var seqAtEnd80 = aiCmOverlaySeq;\n' +
        '        var __overlayOff80 = function () {\n' +
        "          aiCmSetScrollOverlay(false, 'loader-done', seqAtEnd80);\n" +
        "          debugLog('log', '[AI CM][visibility] restore reason=loader-done convId=' + (getConvId() || '(none)'));\n" +
        '        };\n' +
        '        try {\n' +
        '          requestAnimationFrame(function () { requestAnimationFrame(__overlayOff80); });\n' +
        '        } catch (eRaf80) { __overlayOff80(); }';
      expect(coreSrc).toContain(removal);
      // не обёрнут tape-гардом: между seq-фиксацией и loader-done нет if (tapeWasUsed...)
      const between = coreSrc.slice(coreSrc.indexOf('var seqAtEnd80'), coreSrc.indexOf("aiCmSetScrollOverlay(false, 'loader-done'"));
      expect(between).not.toContain('tapeWasUsedInThisColdStart');
    });

    it('rerun-overlay-disarm (разоружение loader-restart) байтово-идентично и без tape-гарда', () => {
      const disarm = '' +
        "            if (aiCmScrollOverlay && !loaderRunningFor) aiCmSetScrollOverlay(false, 'rerun-overlay-disarm');";
      expect(coreSrc).toContain(disarm);
      const between = coreSrc.slice(coreSrc.indexOf('aiCmRerunOverlayTimer = setTimeout'), coreSrc.indexOf('rerun-overlay-disarm'));
      expect(between).not.toContain('tapeWasUsedInThisColdStart');
    });

    it('forceRestoreVisibility + pagehide/visibilitychange-снятие байтово-идентичны', () => {
      const frv = '' +
        '  function forceRestoreVisibility(reason) {\n' +
        "    aiCmSetScrollOverlay(false, 'force-' + reason);\n" +
        '  }';
      expect(coreSrc).toContain(frv);
      expect(coreSrc).toContain("window.addEventListener('pagehide', function () { forceRestoreVisibility('pagehide'); });");
      expect(coreSrc).toContain("document.addEventListener('visibilitychange', function () { forceRestoreVisibility('visibilitychange'); });");
      // функции снятия не содержат tape-условий
      expect(frv).not.toContain('tapeWasUsedInThisColdStart');
    });

    it('autoscroll-done (v75 restore) байтово-идентичен', () => {
      expect(coreSrc).toContain("aiCmSetScrollOverlay(false, 'autoscroll-done');");
    });
  });
});


