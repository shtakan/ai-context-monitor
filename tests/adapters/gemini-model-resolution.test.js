/**
 * Тесты каскада приоритетов resolveCurrentModel (T1, шаг 4 плана QUALITY_AUDIT).
 *
 * Проверяется РЕАЛЬНАЯ функция core/content.ts:resolveCurrentModel в песочнице
 * `with (ctx)`, с настоящими ModelConfig и utils/gemini-ui-model.ts и jsdom-документом.
 * Подменяются только входы content-скоупа (сеть/popup/адаптер/хост), поэтому тест
 * пинит именно лестницу H19: попап → DOM(UI) → сеть → дефолт сайта.
 *
 * Сценарии:
 *   1) popupModelId задан — он побеждает и сеть, и DOM-сигнал;
 *   2) popup пуст, есть и detectedModelSlug (сеть), и DOM — побеждает DOM;
 *   3) popup пуст, DOM-сигнала нет, есть detectedModelSlug — побеждает сеть;
 *   4) ни popup, ни сети — берётся DOM Gemini (реальный UI-детектор + кэш семьи);
 *   5) хост не gemini.google.com — DOM не читается, возвращается дефолт сайта;
 *   6) «Авто» в новом пикере не подставляет ложный слаг: без сети — дефолт сайта.
 *
 * Отдельно (регрессия петли): имя файла автоэкспорта («…gemini-3.1-Pro-2026.md»)
 * не считается моделью ни сетевым captureModelSlugFromBody (core/gemini-rpc.js),
 * ни парсером истории (extractModelName → r.model), но реальный слаг рядом ловится.
 *
 * Источник модели в debug-логе пинится через lastModelSourceSig / model-source=…:
 * popup | snapshot | dom.
 */

const loadEsm = require('../helpers/load-esm.js').loadEsm;
const loadEsmModule = require('../helpers/load-esm.js').loadEsmModule;

const ModelConfig = loadEsm('utils/model-config.ts');
const ui = loadEsmModule('utils/gemini-ui-model.ts');
const parser = loadEsmModule('utils/gemini-batchexecute-parser.ts');
const Rpc = require('../../core/gemini-rpc.js');
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

// Новый пикер модели: основной текст — выбранный режим, конкретной модели нет.
const DOM_PICKER_AUTO = '<button type="button" class="model-picker" aria-haspopup="menu">' +
  '<span class="picker-primary-text">Авто</span></button>';

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

describe('resolveCurrentModel: лестница попап → DOM → сеть → дефолт', () => {
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

  test('2) popup пуст, есть и сеть, и DOM: побеждает DOM', function () {
    mount(DOM_MENU_GEMINI_FLASH);
    const t = makeCtx({ detectedModelSlug: 'gemini-2.5-pro' });

    expect(makeResolve(t.ctx).run()).toBe('gemini-3.6-flash');
    expect(t.ctx.lastModelSourceSig).toBe('dom|gemini-3.6-flash');
    expect(t.debugs[0]).toContain('model-source=dom');
    expect(t.debugs[0]).toContain('v48 dom raw="Gemini 3.6 Flash"');
    expect(t.logs[0]).toContain('путь=dom');
    // реальный UI-детектор отработал и обновил кэш семьи
    expect(t.ctx.geminiUiModelByFamily.flash).toBe('Gemini 3.6 Flash');
    // сеть по-прежнему заполняет имя снимка — отдельный канал (экспорт/лимит)
    expect(t.ctx.lastSnapshotModelName).toBe('Gemini 2.5 Pro');
  });

  test('3) popup пуст, DOM-сигнала нет: побеждает сеть', function () {
    mount('');
    const t = makeCtx({ detectedModelSlug: 'gemini-2.5-pro' });

    expect(makeResolve(t.ctx).run()).toBe('gemini-2.5-pro');
    expect(t.ctx.lastModelSourceSig).toBe('snapshot|gemini-2.5-pro');
    expect(t.debugs[0]).toContain('model-source=snapshot');
    expect(t.debugs[0]).toContain('снимок="gemini-2.5-pro"');
    expect(t.logs[0]).toContain('путь=сеть');
  });

  test('4) ни popup, ни сети: берётся DOM Gemini', function () {
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

  test('5) хост не Gemini: DOM не читается, возвращается дефолт сайта', function () {
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

  test('6) «Авто» в пикере: метка не превращается в слаг, без сети — дефолт сайта', function () {
    mount(DOM_PICKER_AUTO);
    const t = makeCtx({});

    expect(makeResolve(t.ctx).run()).toBe('gemini-2.5-flash');
    expect(t.ctx.lastModelSourceSig).toBe('snapshot|gemini-2.5-flash');
    expect(t.logs[0]).toContain('путь=дефолт');
    // «Авто» — режим, а не модель: кэш семьи не заполняется выдуманным именем
    expect(t.ctx.geminiUiModelByFamily).toEqual({});
    expect(t.debugs[0]).not.toContain('model-source=dom');
  });
});

describe('имя файла автоэкспорта не становится моделью (петля «файл → сеть → модель»)', () => {
  function makeTurn(extraMetaStrings, question) {
    return [
      ['c_conv', 'r_x'].concat(extraMetaStrings || []),
      ['c_conv', 'r_y', 'rc_z'],
      [[question, null, null, null, null]],
      [[['Ответ']]],
      [1780000000, 100]
    ];
  }

  function buildRaw(turn) {
    return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn]]), null, 'generic']]);
  }

  test('captureModelSlugFromBody игнорирует слаг внутри имени файла/даты', function () {
    // Раньше MODEL_SLUG_RE матчился внутри большего слова и отдавал gemini-3.1-pro.
    expect(Rpc.captureModelSlugFromBody('{"file":"-gemini-3.1-Pro-2026.md"}')).toBe('');
    expect(Rpc.captureModelSlugFromBody('файл chat_gemini-3.5-flash.json')).toBe('');
    expect(Rpc.captureModelSlugFromBody('gemini-3.1-Pro-2026')).toBe('');
  });

  test('реальный слаг рядом с именем файла по-прежнему извлекается', function () {
    expect(Rpc.captureModelSlugFromBody(
      '{"model":"gemini-3.5-flash-lite"} + имя файла gemini-3.1-Pro-2026.md'
    )).toBe('gemini-3.5-flash-lite');
    // AI Studio: models/<slug> — слэш перед слагом не мешает
    expect(Rpc.captureModelSlugFromBody('"models/gemini-3.8-flash"')).toBe('gemini-3.8-flash');
  });

  test('parseGeminiHistory не берёт имя файла за модель хода, а реальную модель видит', function () {
    const bad = parser.parseGeminiHistory(
      buildRaw(makeTurn(['gemini-3.1-Pro-2026.md'], 'Что в этом файле?'))
    );
    expect(bad.model).toBe('Gemini 2.5 Pro'); // дефолт-фолбэк, а не имя файла
    expect(bad.messages.every(function (m) { return m.model !== 'gemini-3.1-Pro-2026.md'; })).toBe(true);

    const good = parser.parseGeminiHistory(
      buildRaw(makeTurn(['Gemini 3.1 Pro'], 'Какой моделью ты отвечаешь?'))
    );
    expect(good.model).toBe('Gemini 3.1 Pro');
    expect(good.messages[0].model).toBe('Gemini 3.1 Pro');
  });
});
