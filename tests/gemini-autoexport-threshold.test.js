/**
 * O-36 (D3): автоэкспорт Gemini — файл ТОЛЬКО при percentage >= порога.
 *
 * Живой дефект (сообщение владельца 2026-09-19): при включённом автоэкспорте чат Gemini
 * выгружал историю при значении индикатора НИЖЕ установленного порога.
 * Подтверждённый корень (чтение кода): пороговый путь (processAndSend → maybeAutoExport →
 * shouldSkipAutoExport) порог проверял ВСЕГДА, а ВТОРОЙ триггер автоэкспорта — base-complete
 * от loader-state (v64: loader done + baseComplete=1 + pendingCursor=0 + msgs>0) — уходил в
 * doAutoExportDownload МИМО порога, с последним pct индикатора. Файл писался на каждом
 * дозавершённом чате, в том числе при pct=5 и пороге 90.
 * Фикс: у второго триггера — тот же порог (per-site → глобальный → 90), вердикт чистой
 * функции пайплайна, лог skip с точными значениями pct/threshold/trigger. Латч fired
 * срезанным триггером НЕ ставится (поздний честный экспорт остаётся возможен).
 *
 * Здесь три слоя пинов:
 *   1) ЧИСТЫЙ ГЕЙТ (utils/export-emit-pipeline.js: shouldSkipBaseCompleteTrigger);
 *   2) ЖИВОЙ ХАРНЕСС: РЕАЛЬНЫЙ core/export-manager.js загружен целиком, слушатель
 *      'ai-cm-loader-state' перехвачен, события loader-stop прогоняются по-настоящему
 *      (реальные maybeAutoExport → doAutoExportDownload → имена/байты);
 *   3) SOURCE/R-пины: место гейта, сохранённые литералы fired-строк, нетронутые
 *      shouldSkipAutoExport и спасательный pre-trim (v54).
 *
 * НЕ ТРОГАЕТСЯ (R-пины ниже): вердикты shouldSkipAutoExport, литералы «base-complete
 * trigger» и `doAutoExportDownload(cid, pctBc64, 'base-complete')` (пины H21 /
 * claude-h23 / gsa-o11), порог 70/85/95, спасательный pre-trim, прочие платформы.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');

const CID = 'e292103e4b521dae';                 // живой convId Gemini из fixture H21
const OTHER = '1984298ffe185ef1';

// Рез по балансу фигурных скобок (конвенция сьюта).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

// =====================================================================================
// 1) ЧИСТЫЙ ГЕЙТ: тот же порог, что у порогового пути, но с причиной срезанного триггера
// =====================================================================================
describe('O-36 D3 (чистый гейт): shouldSkipBaseCompleteTrigger', function () {
  test('pct ниже порога → skip below-threshold-base-complete с точным порогом', function () {
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 5, threshold: 90 }))
      .toEqual({ skip: true, reason: 'below-threshold-base-complete', threshold: 90 });
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 89.9, threshold: 90 }))
      .toEqual({ skip: true, reason: 'below-threshold-base-complete', threshold: 90 });
  });

  test('pct РАВЕН порогу и выше → файл разрешён (граница включительная)', function () {
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 90, threshold: 90 }))
      .toEqual({ skip: false, reason: null, threshold: 90 });
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 91.2, threshold: 90 }))
      .toEqual({ skip: false, reason: null, threshold: 90 });
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 100, threshold: 1 }))
      .toEqual({ skip: false, reason: null, threshold: 1 });
  });

  test('pct не число / отрицательный → no-pct (файла нет); невалидный порог → фолбэк 90', function () {
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: NaN, threshold: 90 }).reason).toBe('no-pct');
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: -1, threshold: 90 }).reason).toBe('no-pct');
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: '40', threshold: 90 }).reason).toBe('no-pct');
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 40 }).threshold).toBe(90);
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 40, threshold: 0 }).threshold).toBe(90);
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 40, threshold: 101 }).threshold).toBe(90);
    expect(P.shouldSkipBaseCompleteTrigger(null)).toEqual({ skip: true, reason: 'no-pct', threshold: 90 });
  });

  test('гейт чистый: латч fired не трогает, второй вызов даёт тот же вердикт', function () {
    const a = P.shouldSkipBaseCompleteTrigger({ percentage: 5, threshold: 90 });
    const b = P.shouldSkipBaseCompleteTrigger({ percentage: 5, threshold: 90 });
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual(['reason', 'skip', 'threshold']); // ни fired, ни resetFired
  });

  test('R-пин: пороговый путь (shouldSkipAutoExport) не тронут', function () {
    const base = {
      enabled: true, percentage: 89.9, threshold: 90, baseComplete: true, baseSeen: true,
      loaderRunning: false, fired: false, isGemini: true
    };
    expect(P.shouldSkipAutoExport(base)).toEqual({ skip: true, reason: 'below-threshold', resetFired: false });
    expect(P.shouldSkipAutoExport(Object.assign({}, base, { percentage: 90 })))
      .toEqual({ skip: false, reason: null, resetFired: false });
    // гистерезис −10 п.п. (сброс латча) — прежняя семантика
    expect(P.shouldSkipAutoExport(Object.assign({}, base, { percentage: 79 })))
      .toEqual({ skip: true, reason: 'below-threshold-hysteresis', resetFired: true });
  });

  test('тот же порог, что у порогового пути: per-site оверрайд → глобальный → 90', function () {
    expect(P.effectiveAutoExportThreshold(90, 30)).toBe(30);   // per-site приоритетен
    expect(P.effectiveAutoExportThreshold(90, undefined)).toBe(90);
    expect(P.effectiveAutoExportThreshold(undefined, undefined)).toBe(90);
    // вердикт второго триггера строится на этом же значении (см. живой харнесс ниже)
    expect(P.shouldSkipBaseCompleteTrigger({ percentage: 42, threshold: P.effectiveAutoExportThreshold(10, 50) }))
      .toEqual({ skip: true, reason: 'below-threshold-base-complete', threshold: 50 });
  });
});

// =====================================================================================
// 2) ЖИВОЙ ХАРНЕСС: реальный core/export-manager.js + перехваченный loader-state
// =====================================================================================
/**
 * Загрузка РЕАЛЬНОГО модуля целиком в песочницу состояния контент-скрипта.
 * window — фейковый (перехватываем addEventListener), сборщики/пайплайн — настоящие.
 */
function loadManager(over) {
  const o = over || {};
  const logs = [];
  const downloads = [];
  const listeners = {};
  const win = {
    location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app/' + CID },
    AiCmExportEmitPipeline: P,
    AiCmExportBuilders: {
      buildTxtFromHistory: function (hist) { return hist.messages.map(function (m) { return m.role + '::' + m.text; }).join('\n'); },
      buildMdFromHistory: function (hist) { return hist.messages.map(function (m) { return m.text; }).join('\n'); },
      buildJsonFromHistory: Builders.buildJsonFromHistory,
      downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); },
      aiCmDiagDownload: function () { return false; }
    },
    addEventListener: function (type, cb) { (listeners[type] = listeners[type] || []).push(cb); },
    dispatchEvent: function () { return true; }
  };
  const ctx = {
    window: win,
    // ---- адаптер/сайт ----
    currentAdapter: { siteName: 'gemini' },
    siteName: 'gemini',
    // ---- настройки автоэкспорта (S2: per-site → глобальный) ----
    autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' },
    autoExportPctBySite: {},
    // ---- состояние базы ----
    baseSeen: true,
    baseComplete: true,
    baseText: 'база',
    baseCount: 42,
    lastBaseTexts: ['вопрос', 'ответ'],
    lastEmitConvId: CID,
    lastThreadId: '',
    lastResolvedModelId: 'gemini-2.5-flash',
    lastSnapshotModelName: 'Gemini 2.5 Flash',
    maxTokenCount: 63000,
    // ---- латчи/курсоры ----
    autoExportFired: {},
    autoExportLastConvId: '',
    autoExportLastPct: -1,
    aiCmLoaderRunningByConv: {},
    aiCmCursorLiveByConv: {},
    aiCmBaseConfirmedByConv: {},
    aiCmLateCheckByConv: {},
    aiCmLowConfidenceByConv: {},
    aiCmPendingHistWrite: null,
    sessionFiredCache: {},       // модуль перезапишет своим {} — мутируем ПОСЛЕ загрузки
    notCompleteLogged: {},
    aiCmAutoExportSkipReasonState: { reason: '' },
    // ---- хелперы/внешние зависимости ----
    getCurrentConvId: function () { return CID; },
    buildHistoryMessages: function () {
      return [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: 'ответ' }];
    },
    aiCmArchiveCountFor: function () { return 0; },
    aiCmGeminiTurnsSnapshotSync: function () { return null; },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    aiCmFlushDeferredHistWrite: function () { },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    console: { error: function () { }, log: function () { }, warn: function () { } },
    ModelConfig: { getModel: function () { return { name: 'Gemini 2.5 Flash' }; } },
    aiCmAutoExportBasePendingLog: function () { },
    chrome: {
      storage: {
        session: {
          // промис НЕ резолвится: модульный кэш остаётся тем {}, что создан при загрузке,
          // и тест мутирует его напрямую (детерминированно, без гонок микротасок)
          get: function () { return new Promise(function () { }); },
          set: function () { },
          remove: function (k) { delete ctx.sessionFiredCache[k]; }
        },
        onChanged: { addListener: function () { } }
      }
    }
  };
  Object.assign(ctx, o.ctx || {});
  new Function('ctx', 'with (ctx) { ' + MGR_SRC + '\n }')(ctx);
  return {
    ctx: ctx,
    logs: logs,
    downloads: downloads,
    listeners: listeners,
    line: function (needle) { return logs.filter(function (l) { return l.indexOf(needle) !== -1; }); },
    fire: function (detail) {
      const cbs = listeners['ai-cm-loader-state'] || [];
      expect(cbs.length).toBeGreaterThan(0);          // реальный слушатель зарегистрирован модулем
      cbs.forEach(function (cb) { cb({ detail: detail }); });
    }
  };
}

/** Живая форма loader-stop Gemini (v64-триггер): done + baseComplete + курсор ушёл. */
function loaderStop(over) {
  return Object.assign({
    convId: CID, running: false, pendingCursor: false,
    baseComplete: true, reachedStart: true
  }, over || {});
}

describe('O-36 D3 (живой харнесс): loader-stop не выгружает чат ниже порога', function () {
  test('репро дефекта: pct=40 при пороге 90 → файла НЕТ, лог skip с точными значениями', function () {
    const h = loadManager({ ctx: { autoExportLastPct: 40, autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' } } });
    h.fire(loaderStop({}));
    expect(h.downloads).toEqual([]);                                  // файла нет — дефект закрыт
    expect(h.ctx.autoExportFired).toEqual({});                        // латч не поставлен
    const skip = h.line('[AI CM][auto-export] skip reason=below-threshold-base-complete');
    expect(skip).toHaveLength(1);
    expect(skip[0]).toContain('convId=' + CID);
    expect(skip[0]).toContain('pct=40');
    expect(skip[0]).toContain('threshold=90');
    expect(skip[0]).toContain('trigger=base-complete');
    expect(h.logs.join('\n')).not.toContain('base-complete trigger');
    expect(h.logs.join('\n')).not.toContain('fired convId=');
  });

  test('pct=89.9 ниже порога 90 → файла нет (граница), pct=90 → файл ровно один', function () {
    const below = loadManager({ ctx: { autoExportLastPct: 89.9 } });
    below.fire(loaderStop({}));
    expect(below.downloads).toEqual([]);
    expect(below.line('skip reason=below-threshold-base-complete')[0]).toContain('threshold=90');

    const at = loadManager({ ctx: { autoExportLastPct: 90 } });
    at.fire(loaderStop({}));
    expect(at.downloads).toHaveLength(1);
    expect(at.logs.join('\n')).toContain('fired convId=' + CID + ' pct=90');
    // имя без reason-суффикса: пороговый путь (fired ДО v64-триггера) — прежняя форма
    expect(at.downloads[0].file).toMatch(/^gemini-e292103e-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
  });

  test('per-site оверрайд — та же ось порога: глобальный 10, gemini 50, pct=42 → файла нет', function () {
    const perSite = loadManager({
      ctx: {
        autoExportLastPct: 42,
        autoExportSettings: { enabled: true, pct: 10, fmt: 'txt' },
        autoExportPctBySite: { gemini: 50 }
      }
    });
    perSite.fire(loaderStop({}));
    expect(perSite.downloads).toEqual([]);
    expect(perSite.line('skip reason=below-threshold-base-complete')[0]).toContain('threshold=50');

    const perSitePass = loadManager({
      ctx: {
        autoExportLastPct: 42,
        autoExportSettings: { enabled: true, pct: 10, fmt: 'txt' },
        autoExportPctBySite: { gemini: 30 }
      }
    });
    perSitePass.fire(loaderStop({}));
    expect(perSitePass.downloads).toHaveLength(1);
  });

  test('R-пин: второй триггер ЖИВ — при pct выше порога он по-прежнему выгружает (H21-сценарий)', function () {
    // session-латч прошлой вкладки (только он): пороговый re-check даёт already-fired
    // (in-memory латч пуст), поэтому именно v64-триггер пишет файл — как в fixture H21
    const h = loadManager({ ctx: { autoExportLastPct: 91.2 } });
    h.ctx.sessionFiredCache[P.firedSessionKey('gemini', CID)] = 1;
    h.fire(loaderStop({}));
    expect(h.downloads).toHaveLength(1);                              // РОВНО один файл
    expect(h.logs.join('\n')).toContain('skip reason=already-fired convId=' + CID);
    expect(h.logs.join('\n')).toContain('base-complete trigger convId=' + CID +
      ' msgs=42 pendingCursor=0 baseComplete=1 pct=91.2');
    expect(h.logs.join('\n')).toContain('fired convId=' + CID + ' pct=91.2');
    expect(h.downloads[0].file).toMatch(/-base-complete\.txt$/);      // имя прежнее (O-11)
  });

  test('курсор продолжения жив → второй триггер молчит (прежний гейт не ослаблен)', function () {
    const h = loadManager({ ctx: { autoExportLastPct: 95 } });
    h.fire(loaderStop({ pendingCursor: true }));
    expect(h.downloads).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('base-complete trigger');
  });

  test('другой чат в событии → вердикта нет (прежний convId-гард)', function () {
    const h = loadManager({ ctx: { autoExportLastPct: 95 } });
    h.fire(loaderStop({ convId: OTHER }));
    expect(h.downloads).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('base-complete trigger');
  });

  test('латч уже стоит → второго файла нет даже при pct выше порога', function () {
    const h = loadManager({ ctx: { autoExportLastPct: 95 } });
    h.ctx.autoExportFired[P.latchKey('gemini', CID)] = 1;
    h.fire(loaderStop({}));
    // и пороговый путь, и v64-триггер видят один и тот же in-memory латч (per site+convId) —
    // файла нет ни на одном из них
    expect(h.downloads).toEqual([]);
    expect(h.logs.join('\n')).toContain('skip reason=already-fired convId=' + CID);
    expect(h.logs.join('\n')).not.toContain('base-complete trigger');
  });
});

// =====================================================================================
// 3) SOURCE/R-пины: место гейта и сохранённые литералы
// =====================================================================================
describe('O-36 D3 (source-пины): гейт стоит перед файром, прежние литералы сохранены', function () {
  test('гейт в v64-триггере: порог → чистая функция → skip-лог → иначе fire', function () {
    const iGate = MGR_SRC.indexOf('var gateBc64 = (Pbc64 && typeof Pbc64.shouldSkipBaseCompleteTrigger === \'function\')');
    const iSkip = MGR_SRC.indexOf("'[AI CM][auto-export] skip reason=' + gateBc64.reason + ' convId=' + cid +");
    const iTrigger = MGR_SRC.indexOf("debugLog('log', '[AI CM][auto-export] base-complete trigger convId=' + cid +");
    const iFire = MGR_SRC.indexOf("doAutoExportDownload(cid, pctBc64, 'base-complete');");
    expect(iGate).toBeGreaterThan(-1);
    expect(iSkip).toBeGreaterThan(iGate);
    expect(iTrigger).toBeGreaterThan(iSkip);
    expect(iFire).toBeGreaterThan(iTrigger);                  // файр — ТОЛЬКО в else-ветке после гейта
    // порог берётся единой функцией оси порога (per-site → глобальный → 90)
    expect(MGR_SRC).toContain('var thrBc64 = aiCmEffectiveAutoExportThreshold(');
    const thr = fnDecl(MGR_SRC, 'aiCmEffectiveAutoExportThreshold');
    expect(thr).toContain('P.effectiveAutoExportThreshold(globalPct, perSitePct)');
    expect(thr).toContain("autoExportPctBySite[siteName || '']");
    expect(thr).toContain('? globalPct : 90');
  });

  test('R-пин литералов (H21 / claude-h23 / gsa-o11): fired-строки и вызовы не переписаны', function () {
    expect(MGR_SRC).toContain("doAutoExportDownload(cid, pctBc64, 'base-complete');");
    expect(MGR_SRC).toContain("doAutoExportDownload(cid, percentage, 'threshold');");
    expect(MGR_SRC).toContain("doAutoExportDownload(cid, pct, 'pre-trim');");
    expect(MGR_SRC).toContain("debugLog('log', '[AI CM][auto-export] base-complete trigger convId=' + cid +");
    expect(MGR_SRC).toContain("debugLog('log', '[AI CM][auto-export] skip reason=already-fired convId=' + cid);");
    // skip-лог нового гейта несёт точные значения (пин D3: «лог с точными значениями»)
    expect(MGR_SRC).toContain("' pct=' + pctBc64 + ' threshold=' + gateBc64.threshold + ' trigger=base-complete'");
  });

  test('R-пин: спасательный pre-trim (v54) вне порога — отдельный триггер, не тронут', function () {
    // mayTrimExport — спасательный экспорт ДО потери головы истории (свой reason/суффикс имени
    // и свой латч preTrimExportFired), не пороговый автоэкспорт. Гейт D3 его не касается:
    // в его теле нет ни shouldSkipBaseCompleteTrigger, ни aiCmEffectiveAutoExportThreshold.
    const trim = fnDecl(MGR_SRC, 'maybeTrimExport');
    expect(trim).not.toContain('shouldSkipBaseCompleteTrigger');
    expect(trim).not.toContain('aiCmEffectiveAutoExportThreshold');
    expect(trim).toContain("doAutoExportDownload(cid, pct, 'pre-trim');");
    const STATE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'state.js'), 'utf8');
    expect(STATE_SRC).toContain('var preTrimExportFired = {};');   // латч спасательного пути жив
    // и «threshold»-путь по-прежнему гейтится ОДНИМ shouldSkipAutoExport (не тронут)
    expect(fnDecl(MGR_SRC, 'maybeAutoExport')).toContain('P.shouldSkipAutoExport({');
  });

  test('R-пин: shouldSkipAutoExport не переписан (тот же порядок причин)', function () {
    const gate = fnDecl(fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8'), 'shouldSkipAutoExport');
    expect(gate).toContain('threshold');                      // (страховка от пустого реза)
    ['not-enabled', 'no-pct', 'not-complete', 'base-pending', 'below-threshold-hysteresis',
      'below-threshold-unreliable', 'below-threshold', 'already-fired'].forEach(function (reason) {
      expect(gate).toContain("'" + reason + "'");
    });
    expect(gate).not.toContain('shouldSkipBaseCompleteTrigger'); // гейты независимы
  });
});
