/**
 * Тесты каскада приоритетов resolveCurrentModel (T1, шаг 4 плана QUALITY_AUDIT).
 *
 * Проверяется РЕАЛЬНАЯ функция core/content.ts:resolveCurrentModel в песочнице
 * `with (ctx)`, с настоящими ModelConfig и utils/gemini-ui-model.ts и jsdom-документом.
 * Подменяются только входы content-скоупа (сеть/popup/адаптер/хост), поэтому тест
 * пинит именно лестницу H19: попап → сеть → DOM → дефолт сайта.
 *
 * Сценарии:
 *   1) popupModelId задан — он побеждает и сеть, и DOM-сигнал;
 *   2) popup пуст, есть detectedModelSlug (сеть) — побеждает сеть;
 *   3) ни popup, ни сети — берётся DOM Gemini (реальный UI-детектор + кэш семьи);
 *   4) хост не gemini.google.com — DOM не читается, возвращается дефолт сайта.
 *
 * Источник модели в debug-логе пинится через lastModelSourceSig / model-source=…:
 * popup | snapshot | dom.
 */

const loadEsm = require('../helpers/load-esm.js').loadEsm;
const loadEsmModule = require('../helpers/load-esm.js').loadEsmModule;

const ModelConfig = loadEsm('utils/model-config.ts');
const ui = loadEsmModule('utils/gemini-ui-model.ts');
const CONTENT = require('../helpers/content-source.js').contentSource;

// Рез по балансу фигурных скобок (тот же приём, что в tests/gsa-autoexport.test.js).
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

const SCOPE = 'with (ctx) { ' + fnDecl(CONTENT, 'resolveCurrentModel') +
  ' return { run: resolveCurrentModel }; }';
const makeResolve = new Function('ctx', SCOPE);

const GEMINI_HOST = 'gemini.google.com';

// Открытое меню с выбранной моделью: текст содержит слово Gemini, поэтому
// реальный ModelConfig.resolveModelId приводит его к ключу 'gemini-3.6-flash'.
const DOM_MENU_GEMINI_FLASH = '<div class="model-menu" role="menu" aria-label="Выбор модели">' +
  '<button type="button" role="menuitemradio" aria-checked="false">' +
  '<span class="label">Gemini 2.5 Pro</span></button>' +
  '<button type="button" role="menuitemradio" aria-checked="true">' +
  '<span class="label">Gemini 3.6 Flash</span></button>' +
  '</div>';

/** Монтирует фрагмент в body jsdom-документа (общий document теста). */
function mount(html) {
  document.body.innerHTML = html;
  return document;
}

/**
 * Контекст content-скоупа. Возвращает ещё журналы console.log/debugLog,
 * чтобы пинить выбранный путь и источник модели.
 */
function makeCtx(over) {
  const logs = [];
  const debugs = [];
  const ctx = {
    ModelConfig: ModelConfig,
    GeminiUiModel: ui,
    document: document,
    currentAdapter: { siteName: 'gemini', detectModel: function () { return ''; } },
    detectedModelSlug: '',
    popupModelId: null,
    popupRawModel: '',
    geminiUiModelByFamily: {},
    lastResolvedModelId: null,
    lastModelSourceSig: '',
    lastSnapshotModelName: '',
    debugLog: function (level, msg) { debugs.push(String(msg)); },
    swallow: function () { },
    swallowSoft: function () { },
    console: { log: function (msg) { logs.push(String(msg)); } },
    window: { location: { hostname: GEMINI_HOST } }
  };
  Object.assign(ctx, over || {});
  return { ctx: ctx, logs: logs, debugs: debugs };
}

describe('resolveCurrentModel: лестница попап → сеть → DOM → дефолт', () => {
  afterEach(function () {
    document.body.innerHTML = '';
  });

  test('1) popupModelId задан: побеждает сеть и DOM', function () {
    mount(DOM_MENU_GEMINI_FLASH);
    const t = makeCtx({
      popupModelId: 'gemini-2.5-flash',
      popupRawModel: '2.5 Flash',
      detectedModelSlug: 'gemini-2.5-pro' // сеть не должна перебить ручной выбор
    });

    expect(makeResolve(t.ctx).run()).toBe('gemini-2.5-flash');
    // источник — попап, а не сеть (snapshot) и не DOM
    expect(t.ctx.lastModelSourceSig).toBe('popup|gemini-2.5-flash');
    expect(t.debugs[0]).toContain('model-source=popup');
    expect(t.logs[0]).toContain('путь=попап');
    // сеть по-прежнему заполняет имя снимка — это отдельный канал, не выбор модели
    expect(t.ctx.lastSnapshotModelName).toBe('Gemini 2.5 Pro');
  });

  test('2) popup пуст, есть detectedModelSlug: побеждает сеть', function () {
    mount(DOM_MENU_GEMINI_FLASH);
    const t = makeCtx({ detectedModelSlug: 'gemini-2.5-pro' });

    expect(makeResolve(t.ctx).run()).toBe('gemini-2.5-pro');
    expect(t.ctx.lastModelSourceSig).toBe('snapshot|gemini-2.5-pro');
    expect(t.debugs[0]).toContain('model-source=snapshot');
    expect(t.debugs[0]).toContain('снимок="gemini-2.5-pro"');
    expect(t.logs[0]).toContain('путь=сеть');
    // DOM-сигнал был прочитан, но в лестнице проиграл сети
    expect(t.ctx.geminiUiModelByFamily.flash).toBe('Gemini 3.6 Flash');
  });

  test('3) ни popup, ни сети: берётся DOM Gemini', function () {
    mount(DOM_MENU_GEMINI_FLASH);
    const t = makeCtx({});

    expect(makeResolve(t.ctx).run()).toBe('gemini-3.6-flash');
    expect(t.ctx.lastModelSourceSig).toBe('dom|gemini-3.6-flash');
    expect(t.debugs[0]).toContain('model-source=dom');
    expect(t.debugs[0]).toContain('v48 dom raw="Gemini 3.6 Flash"');
    expect(t.logs[0]).toContain('путь=dom');
    // реальный UI-детектор отработал и обновил кэш семьи
    expect(t.ctx.geminiUiModelByFamily.flash).toBe('Gemini 3.6 Flash');
  });

  test('4) хост не Gemini: DOM не читается, возвращается дефолт сайта', function () {
    mount(DOM_MENU_GEMINI_FLASH);
    const t = makeCtx({
      currentAdapter: { siteName: 'deepseek', detectModel: function () { return ''; } },
      window: { location: { hostname: 'chat.deepseek.com' } }
    });

    expect(makeResolve(t.ctx).run()).toBe('deepseek-v3');
    expect(t.ctx.lastModelSourceSig).toBe('snapshot|deepseek-v3');
    expect(t.logs[0]).toContain('путь=дефолт');
    // Gemini-ветка не выполнялась: DOM-меню есть, но кэш остался пустым
    expect(t.ctx.geminiUiModelByFamily).toEqual({});
  });
});
