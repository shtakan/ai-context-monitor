/**
 * v54 (O-35, фикс badge-suppress): бейдж при ЖИВОЙ adapter-базе.
 *
 * Живой лог (SPA-вход qwen, 16:44): строки
 *   `[content-trace] badge-suppress: пропуск updateWidget до первого снимка нового convId`
 *   на 33.214 / 37.883 / 41.676 — при том что `history-write source=adapter msgs=156`
 *   состоялся, а `baseCount` остался 0. Итог: бейдж показывал «—» при живой базе.
 *
 * Что здесь удостоверяется:
 *   D-пин  — дефект из живого лога воспроизведён и закрыт: гейт SPA-супрессии читает
 *            badgeSuppressed (взводит resetConversationState) + baseSeen (сеть) +
 *            adapterBaseSeen (база принята adapter-записью); после adapter-записи msgs=156
 *            супрессия ОТПУЩЕНА и бейдж показывает ЧИСЛО, а не тире (D1/B2 согласованы);
 *   R-пины — шесть платформ: поведение бейджа при СЕТЕВОМ снимке прежнее (супрессию
 *            отпускает baseSeen, как и было), SPA-держание без базы прежнее, байты DOM
 *            виджета при добавлении нового входа не меняются; щит O-1 (ChatGPT) не задет
 *            (в его функции новое состояние не заглядывает, отпускание — baseSeen/фолбэк);
 *            семантики O-33 (автоэкспорт ждёт базу) и O-14 (reset чистит ровно снимок
 *            попапа) — регресс-маркеры;
 *   диагностика — новые ветки печатают ТОЛЬКО под гейтом aiCmDebug; байты выхода (DOM
 *            виджета) при гейте вкл/выкл идентичны.
 *
 * Исполняются РЕАЛЬНЫЕ функции: условие супрессии и блок записи базы — текстом из
 * core/content.js (не литералами теста), updateWidget — из core/widget.js, канонический
 * aiCmDiagLine + гейт — из utils/debug.js.
 */

const fs = require('fs');
const path = require('path');
const H = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = H.contentSource;                                    // модули + content.js (единый скоуп)
const CONTENT_ONLY = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const WIDGET_SRC = H.moduleSource('core/widget.js');
const STATE_SRC = H.moduleSource('core/state.js');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');

const RU_MESSAGES = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'ru', 'messages.json'), 'utf8'));
function i18nMock(key, fallback, substitutions) {
  const rec = RU_MESSAGES[key];
  const tpl = (rec && rec.message) ? rec.message : String(fallback);
  if (!substitutions) return tpl;
  return String(tpl).replace(/\$(\d)/g, function (m, d) {
    const v = substitutions[Number(d) - 1];
    return (v === undefined || v === null) ? m : String(v);
  });
}

// Рез по балансу фигурных скобок (стиль tests/chatgpt-o1-badge-hold.test.js).
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

const DRAW = fnDecl(CONTENT, 'processAndSend');

// ---------------------------------------------------------------------------------
// ФАКТ живого лога: состояние на момент строк badge-suppress (16:44)
// ---------------------------------------------------------------------------------
const LIVE = {
  badgeSuppressed: true,   // взведено resetConversationState на SPA-входе
  baseSeen: false,         // сетевого снимка нет вовсе
  baseCount: 0,            // счётчик СЕТЕВОЙ базы — адаптерная запись его не трогает
  lastBaseTexts: [],       // сетевых текстов нет
  adapterBaseSeen: false   // до adapter-записи база нового convId не принята
};
const ADAPTER_MSGS = 156;  // history-write source=adapter msgs=156 (живой лог)
const LIVE_BADGE = { pct: 158.8, tokens: 203274, model: 'Qwen3.8-Max' }; // бейдж живой сессии

// ---------------------------------------------------------------------------------
// ВЕРДИКТ ГЕЙТА — реальным условием из исходника (не копией литерала)
// ---------------------------------------------------------------------------------
const SUPPRESS_M = /var badgeSuppressActive = \((badgeSuppressed[^;]*)\);/.exec(DRAW);
expect(SUPPRESS_M).not.toBeNull();
const SUPPRESS_DECL = SUPPRESS_M[0];
const SUPPRESS_COND = SUPPRESS_M[1];
/** Исполняет РЕАЛЬНОЕ объявление вердикта из processAndSend в переданном состоянии. */
const suppressVerdict = new Function('ctx', 'with (ctx) { ' + SUPPRESS_DECL + '\n return badgeSuppressActive; }');

// Блок записи базы путём адаптера (единственный писатель состояния) — текстом из исходника
const ADAPTER_BRANCH = (function () {
  const i = CONTENT_ONLY.indexOf('var cidS24 = getCurrentConvId()');
  expect(i).toBeGreaterThan(-1);
  const j = CONTENT_ONLY.indexOf('} catch (eS24) { }', i);
  expect(j).toBeGreaterThan(i);
  return CONTENT_ONLY.slice(i, j);
})();

// ---------------------------------------------------------------------------------
// Реальный updateWidget (единственная печать бейджа) — песочница как в O-35 D-тестах
// ---------------------------------------------------------------------------------
function runUpdateWidget(opts) {
  const o = opts || {};
  const el = document.createElement('div');
  el.innerHTML = '<div class="ai-widget-fill"></div><div class="ai-widget-text">—</div><div class="ai-widget-tooltip"></div>';
  const ctx = {
    document: document,
    window: window,
    widgetElement: el,
    stale: !!o.stale,
    currentAdapter: { siteName: o.site || 'qwen' },
    location: window.location,
    baseSeen: o.baseSeen === true,
    baseCount: o.baseCount,
    lastBaseTexts: o.lastBaseTexts || [],
    adapterBaseSeen: o.adapterBaseSeen === true,
    netQwenUsage: null,
    getCurrentConvId: function () { return 'cda86f26-0155-4243-a134-777d909a936b'; },
    zoneColor: function () { return '#000'; },
    aiCmRefreshThemeIfNeeded: function () { },
    aiCmUpdateSourceIndicator: function () { },
    aiCmRevealWidget: function () { },
    aiCmActivePct: function () { return null; },
    aiCmSourceLabelNow: o.label || '',
    aiCmI18nMessage: i18nMock,
    debugLog: function () { }
  };
  const scope = 'with (ctx) { ' + fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
    fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' + fnDecl(WIDGET_SRC, 'updateWidget') +
    '\n return updateWidget; }';
  const fn = new Function('ctx', scope)(ctx);
  fn(LIVE_BADGE.pct, LIVE_BADGE.tokens, 128000, 128000, 128000, LIVE_BADGE.model, null, null);
  return { el: el, ctx: ctx };
}

function diagLines() {
  const spy = console.log;
  if (!spy || !spy.mock || !spy.mock.calls) return [];
  return spy.mock.calls.map(function (a) { return String(a[0]); })
    .filter(function (s) { return s.indexOf('[AI CM][diag]') === 0; });
}

beforeEach(function () {
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

afterEach(function () {
  jest.restoreAllMocks();
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

// =====================================================================================
// D-пин: какое состояние читает гейт и кто его взводит
// =====================================================================================
describe('v54 D: гейт badge-suppress — читаемое состояние и единственный писатель', function () {
  test('D: гейт читает badgeSuppressed (SPA-сброс) + baseSeen (сеть) + adapterBaseSeen (адаптер)', function () {
    expect(SUPPRESS_COND).toBe('badgeSuppressed && !baseSeen && !adapterBaseSeen');
    // гейт сервис-независим: своей ветки по платформе у него нет и не появилось
    expect(SUPPRESS_DECL).not.toContain('siteName');
    // взвод badgeSuppressed — единственная точка, core/widget.js:resetConversationState
    expect(fnDecl(WIDGET_SRC, 'resetConversationState')).toContain('badgeSuppressed = true;');
    // взвод baseSeen — единственная точка, приём сетевого снимка (ai-cm-full-history)
    expect((CONTENT_ONLY.match(/baseSeen = true;/g) || [])).toHaveLength(1);
    expect(CONTENT_ONLY).toContain('badgeSuppressed = false; // v1.8.1: пришёл первый валидный снимок нового чата');
  });

  test('D: adapterBaseSeen взведён РОВНО в одной точке — запись базы адаптером (ISOLATED, синхронно)', function () {
    // состояние объявлено в общем реестре (state.js) — читают content.js и widget.js
    expect(STATE_SRC).toContain('let adapterBaseSeen = false;');
    expect((STATE_SRC.match(/adapterBaseSeen = /g) || [])).toHaveLength(1);
    // единственный взвод — в блоке history-write source=adapter
    expect((CONTENT_ONLY.match(/adapterBaseSeen = true;/g) || [])).toHaveLength(1);
    expect(ADAPTER_BRANCH).toContain('adapterBaseSeen = true;');
    expect(ADAPTER_BRANCH.indexOf('adapterBaseSeen = true;')).toBeGreaterThan(ADAPTER_BRANCH.indexOf('lastHistoryWroteKey = histKeyS24;'));
    // взвод стоит ВНУТРИ ветки фактической записи (msgs>0 и новый ключ), а не рядом с ней
    expect(ADAPTER_BRANCH.indexOf('if (msgsS24.length > 0 && histKeyS24 !== lastHistoryWroteKey) {'))
      .toBeLessThan(ADAPTER_BRANCH.indexOf('adapterBaseSeen = true;'));
    // никаких новых async-путей/таймеров/вторых писателей в блоке
    expect(ADAPTER_BRANCH).not.toContain('setTimeout');
    expect(ADAPTER_BRANCH).not.toContain('Promise');
    expect(ADAPTER_BRANCH).not.toContain('addEventListener');
    // сброс — только resetConversationState (взвода в widget.js нет)
    expect((WIDGET_SRC.match(/adapterBaseSeen = false;/g) || [])).toHaveLength(1);
    expect((WIDGET_SRC.match(/adapterBaseSeen = true;/g) || [])).toHaveLength(0);
    expect((CONTENT_ONLY.match(/adapterBaseSeen = false;/g) || [])).toHaveLength(0);
    // порядок в DRAW: вердикт гейта считается ДО ветвления (одна строка на гейт и диагностику)
    expect(DRAW.indexOf(SUPPRESS_DECL)).toBeLessThan(DRAW.indexOf('if (badgeSuppressActive) {'));
    expect(DRAW).toContain("reason: badgeSuppressActive ? 'spa-suppress'");
  });

  test('D: baseCount=0 после adapter-записи — счётчик СЕТЕВОЙ базы адаптерный путь не пишет', function () {
    // причина дефекта: гейт ждал именно baseSeen (сеть), а baseCount/lastBaseTexts —
    // производные СЕТЕВОГО снимка; адаптерная запись их не трогает вовсе
    expect(ADAPTER_BRANCH).not.toContain('baseCount');
    expect(ADAPTER_BRANCH).not.toContain('lastBaseTexts');
    expect(ADAPTER_BRANCH).toContain('history-write source=adapter site=');
    // сетевой счётчик пишется только приёмом снимка
    expect(CONTENT_ONLY).toContain('baseCount = detail.count || 0;');
    expect(CONTENT_ONLY).toContain('baseText = detail.text;');
  });
});

// =====================================================================================
// D-пин: воспроизведение дефекта живого лога и его закрытие
// =====================================================================================
describe('v54 D: живой лог 16:44 (SPA-вход, adapter msgs=156, сети нет) — бейдж показывает число', function () {
  test('D: до adapter-записи — супрессия (как в живом логе), после — отпущена, «—» нет', function () {
    // проход 1: SPA-вход, база нового convId ещё не принята ни сетью, ни адаптером
    expect(suppressVerdict(LIVE)).toBe(true);          // ровно строки 33.214/37.883/41.676
    // в этом же проходе историю пишет адаптер (msgs=156) → взвод единственного писателя
    LIVE.adapterBaseSeen = true;
    expect(ADAPTER_MSGS).toBe(156);

    // проход 2: супрессия ОТПУЩЕНА без сетевого снимка
    expect(suppressVerdict(LIVE)).toBe(false);

    // ...и бейдж реально рисует ЧИСЛО, а не тире (stale у qwen систематичен — D1)
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const r = runUpdateWidget({ stale: true, adapterBaseSeen: true, label: 'live (сеть/DOM)' });
    expect(r.el.querySelector('.ai-widget-text').textContent).toBe('158.8%');
    expect(r.el.querySelector('.ai-widget-text').textContent).not.toBe('—');
    // метка источника честна для adapter-базы (B2) + неполнота помечена меткой (D1)
    expect(r.el.querySelector('.ai-widget-tooltip').textContent).toContain('Источник: live (сеть/DOM) · stale');

    // контроль дефекта: без нового состояния (прежнее поведение) тот же вход даёт тире
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const broken = runUpdateWidget({ stale: true, label: 'live (сеть/DOM)' });
    expect(broken.el.querySelector('.ai-widget-text').textContent).toBe('—');
  });

  test('D1: условие «число не стираем» истинно после adapter-записи (реальный вход виджета)', function () {
    // выражение берётся из исходника виджета как есть (EOL не важен — режем по ';')
    const iStart = WIDGET_SRC.indexOf('var aiCmAdapterBasePresent = ') + 'var aiCmAdapterBasePresent = '.length;
    expect(iStart).toBeGreaterThan('var aiCmAdapterBasePresent = '.length);
    const iEnd = WIDGET_SRC.indexOf(';', WIDGET_SRC.indexOf('adapterBaseSeen === true', iStart));
    expect(iEnd).toBeGreaterThan(iStart);
    const expr = WIDGET_SRC.slice(iStart, iEnd);
    const verdict = new Function('ctx', 'with (ctx) { return ' + expr + '; }');
    // после adapter-записи: baseCount/lastBaseTexts пусты (сеть молчит) — решает третий вход
    expect(verdict({ baseCount: 0, lastBaseTexts: [], adapterBaseSeen: true })).toBe(true);
    // прежние два входа не тронуты
    expect(verdict({ baseCount: 156, lastBaseTexts: [], adapterBaseSeen: false })).toBe(true);
    expect(verdict({ baseCount: 0, lastBaseTexts: ['a'], adapterBaseSeen: false })).toBe(true);
    // базы нет вовсе → «—» (прежнее поведение, D1)
    expect(verdict({ baseCount: 0, lastBaseTexts: [], adapterBaseSeen: false })).toBe(false);
  });

  test('D: супрессия отпускается и при пустом адаптерном извлечении адаптер НЕ считается базой', function () {
    // писатель стоит под условием msgsS24.length > 0: пустая база состояние не взводит
    expect(ADAPTER_BRANCH).toContain('msgsS24.length > 0 && histKeyS24 !== lastHistoryWroteKey');
    expect(suppressVerdict({ badgeSuppressed: true, baseSeen: false, adapterBaseSeen: false })).toBe(true);
  });
});

// =====================================================================================
// R-пины: шесть платформ — поведение бейджа при сетевом снимке прежнее
// =====================================================================================
const SITES = ['chatgpt', 'gemini', 'deepseek', 'claude', 'perplexity', 'google_search'];

describe('v54 R: шесть платформ — гейт и бейдж при сетевом снимке прежние', function () {
  test('R: сетевой снимок (baseSeen) отпускает супрессию на всех шести, как и до фикса', function () {
    SITES.forEach(function (site) {
      expect(suppressVerdict({ badgeSuppressed: true, baseSeen: true, adapterBaseSeen: false })).toBe(false);
      expect(suppressVerdict({ badgeSuppressed: true, baseSeen: true, adapterBaseSeen: true })).toBe(false);
      // вне окна SPA-сброса супрессии не было и нет
      expect(suppressVerdict({ badgeSuppressed: false, baseSeen: false, adapterBaseSeen: false })).toBe(false);
      // SPA-держание без базы (ни сети, ни адаптера) — прежнее, на всех шести
      expect(suppressVerdict({ badgeSuppressed: true, baseSeen: false, adapterBaseSeen: false })).toBe(true);
      expect(site).toBeTruthy();
    });
  });

  test('R: байты DOM виджета при сетевом снимке не меняются новым входом (шесть платформ)', function () {
    jest.spyOn(console, 'log').mockImplementation(function () { });
    SITES.forEach(function (site) {
      const before = runUpdateWidget({ site: site, stale: true, baseCount: 156, label: 'live (сеть/DOM)' });
      const after = runUpdateWidget({ site: site, stale: true, baseCount: 156, lastBaseTexts: ['a', 'b'], adapterBaseSeen: true, label: 'live (сеть/DOM)' });
      expect(after.el.textContent).toBe(before.el.textContent);   // байтово прежний виджет
      expect(after.el.querySelector('.ai-widget-text').textContent).toBe('158.8%');
    });
    // «—» на бейдже возможен только без базы вовсе (прежняя семантика D1)
    const none = runUpdateWidget({ site: 'chatgpt', stale: true });
    expect(none.el.querySelector('.ai-widget-text').textContent).toBe('—');
  });

  test('R: щит O-1 (ChatGPT) не задет — новое состояние в его функции не читается', function () {
    const hold = fnDecl(CONTENT, 'aiCmBadgeHoldActive') + fnDecl(CONTENT, 'aiCmBadgeHoldRelease') +
      fnDecl(CONTENT, 'aiCmArmBadgeHoldFallback');
    expect(hold).not.toContain('adapterBaseSeen');
    expect(hold).not.toContain('badgeSuppressed');
    // отпускание щита — прежнее: baseSeen ИЛИ фолбэк (одноразовость сохранена)
    expect(fnDecl(CONTENT, 'aiCmBadgeHoldActive')).toContain("currentAdapter.siteName !== 'chatgpt'");
    expect(hold).toContain("'released-baseSeen'");
    expect(hold).toContain("'released-fallback'");
    expect((CONTENT_ONLY.match(/aiCmBadgeHoldSpent = true/g) || [])).toHaveLength(1);
    expect((CONTENT_ONLY.match(/var AI_CM_BADGE_HOLD_FALLBACK_MS = 10000;/g) || [])).toHaveLength(1);
    // гейт SPA-супрессии стоит в цепочке РАНЬШЕ щита O-1 (порядок ветвей прежний)
    expect(DRAW.indexOf('if (badgeSuppressActive) {')).toBeLessThan(DRAW.indexOf('} else if (aiCmBadgeHoldActive()) {'));
  });

  test('R: семантики O-33 (автоэкспорт ждёт базу) и O-14 (reset чистит ровно снимок) живы', function () {
    // O-33: вызов автоэкспорта — вне ветвления бейджа, гейт полноты прежний
    expect(DRAW).toContain('maybeAutoExport(percentage);');
    expect(DRAW.indexOf('maybeAutoExport(percentage);')).toBeGreaterThan(DRAW.indexOf('if (badgeSuppressActive) {'));
    expect(fnDecl(CONTENT, 'maybeAutoExport')).toContain('P.shouldSkipAutoExport({');
    // новое состояние в автоэкспорт-контур не проникает вовсе
    expect(MGR_SRC).not.toContain('adapterBaseSeen');
    expect(PIPELINE_SRC).not.toContain('adapterBaseSeen');
    // O-14: reset по-прежнему удаляет ровно aiCmState и aiCmState:<host>, истории не касается
    const reset = fnDecl(WIDGET_SRC, 'resetConversationState');
    expect(reset).toContain("chrome.storage.local.remove(['aiCmState', 'aiCmState:' + window.location.hostname])");
    expect(reset.match(/storage\.local\.remove/g)).toHaveLength(1);
    expect(reset.replace(/\/\/[^\n]*/g, '')).not.toContain('aiCmHistory');
  });
});

// =====================================================================================
// Гейт aiCmDebug: новые ветки — только под гейтом, байты выхода не меняются
// =====================================================================================
describe('v54 G: диагностика новых ветвей — только под aiCmDebug, байты выхода прежние', function () {
  test('G: гейт выключен → ни строки; включён → поле adapterBaseSeen в строке qwen-badge', function () {
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const off = runUpdateWidget({ stale: true, adapterBaseSeen: true, label: 'live (сеть/DOM)' });
    expect(diagLines()).toEqual([]);                          // гейт выключен — ни одной строки
    const offText = off.el.textContent;

    sessionStorage.setItem('aiCmDebug', '1');
    const on = runUpdateWidget({ stale: true, adapterBaseSeen: true, label: 'live (сеть/DOM)' });
    expect(on.el.textContent).toBe(offText);                  // байты выхода идентичны
    // строка badge-update (content.js) несёт объяснение baseCount=0 — поле adapterBaseSeen,
    // и печатается под тем же гейтом qwen + aiCmDiagLine (гард — непосредственно перед ней)
    const iQb = CONTENT_ONLY.indexOf("aiCmDiagLine('qwen-badge', {");
    expect(iQb).toBeGreaterThan(-1);
    const diagBlock = CONTENT_ONLY.slice(iQb - 320, iQb + 900);
    expect(diagBlock).toContain("adapterBaseSeen: (adapterBaseSeen === true) ? 1 : 0,");
    expect(diagBlock).toContain("if (typeof aiCmDiagLine === 'function' && currentAdapter && currentAdapter.siteName === 'qwen') {");
    expect(diagBlock).toContain("event: 'badge-update'");
    // плейсхолдер «—» печатает только ветка stale БЕЗ базы: с adapterBaseSeen=true строки нет
    expect(diagLines().filter(function (s) { return s.indexOf('placeholder') !== -1; })).toEqual([]);
  });

  test('G: писатель состояния не печатает ничего своего (диагностика — прежняя строка)', function () {
    expect(ADAPTER_BRANCH).not.toContain('console.');
    // единственная новая ветка observability — уже существующая строка history-write
    expect(ADAPTER_BRANCH).toContain("debugLog('log', '[AI CM][trace] history-write source=adapter site='");
    expect(ADAPTER_BRANCH).toContain("aiCmDiagLine('qwen-adapter'");
    expect(ADAPTER_BRANCH).toContain("histKey: histKeyS24, sinceSpaResetMs:");
  });
});
