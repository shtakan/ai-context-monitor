/**
 * Тесты UI-слоя определения модели Gemini (T1, часть 1 плана docs/QUALITY_AUDIT.md).
 *
 * Модуль: utils/gemini-ui-model.ts — бывшие приватные функции core/content.ts
 * (GEMINI_UI_MODEL_RE, normalizeUiModelText, extractUiModelText,
 * probeGeminiUiMenuChecked, probeGeminiUiPickerPrimaryText, resolveFamilyVariantId,
 * probeGeminiUiButton, detectSelectedModelFromDom), вынесенные в чистый ES-модуль
 * с DI: документ, реестр моделей (порт ModelConfig) и кэш «последнее точное имя по
 * семейству» приходят аргументами. Здесь документ — jsdom-инстанс jest, реестр —
 * управляемая заглушка, поэтому проверяется именно логика слоя, без content-бандла
 * и chrome.*.
 *
 * Что пинится (лестница v47–v2.0.33):
 *   1) регэксп модели и нормализация слитного текста кнопки ("ProРасширенный");
 *   2) extractUiModelText: длина ≤ 60, нужна версия ИЛИ слово gemini, иначе "";
 *   3) меню: aria-checked на пункте ИЛИ на потомке; без checked — "";
 *   4) кнопка: точная версия → имя как есть + обновление кэша; семейство без
 *      версии → кэш меню → сетевой снимок → семейный дефолт ModelConfig;
 *   5) новый пикер `.picker-primary-text`: явная модель → имя/резолвер семьи,
 *      «Авто»/«Auto» → GEMINI_UI_AUTO_NAME (не слаг!), служебный текст → "";
 *   6) detectSelectedModelFromDom: меню → пикер → кнопка; «Авто» не падает на
 *      старую кнопку и не выдумывает модель.
 *
 * Известная особенность (пинится намеренно, НЕ «исправляется»): в
 * GEMINI_UI_MODEL_RE хвост варианта — /расширенн[аяый]/, т.е. ровно один символ,
 * поэтому "Pro Расширенный" матчится как "Pro Расширенны" (без финального «й»).
 * Для выбора модели это безвредно: семейство/вариант распознаны, род не важен.
 */

const fs = require('fs');
const path = require('path');

const loadEsm = require('../helpers/load-esm.js').loadEsm;
const loadEsmModule = require('../helpers/load-esm.js').loadEsmModule;

const ui = loadEsmModule('utils/gemini-ui-model.ts');
const realModelConfig = loadEsm('utils/model-config.ts');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'gemini-ui-models');

/** HTML-фрагмент фикстуры по имени файла. */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** Монтирует фрагмент(ы) в body jsdom-документа и возвращает документ. */
function mount(html) {
  document.body.innerHTML = html;
  return document;
}

/**
 * Заглушка порта ModelConfig: управляемые resolve/get/default.
 * opts: { resolveMap, names, defaults, resolveUnknown }
 *   resolveMap — точное имя → id; names — id → имя модели; defaults — fam → id.
 * Возвращает ещё и журнал вызовов, чтобы пинить порядок веток резолвера.
 */
function makeConfig(opts) {
  const o = opts || {};
  const calls = { resolve: [], get: [], def: [] };
  const config = {
    calls: calls,
    resolveModelId: function (raw) {
      calls.resolve.push(raw);
      if (!raw) return null;
      if (o.resolveMap && Object.prototype.hasOwnProperty.call(o.resolveMap, raw)) return o.resolveMap[raw];
      return o.resolveUnknown ? 'id:' + raw : null;
    },
    getModel: function (id) {
      calls.get.push(id);
      const name = o.names && o.names[id];
      return name ? { name: name, provider: 'google', contextLimit: 1000000 } : null;
    },
    getFamilyDefaultModelId: function (fam, variant) {
      calls.def.push([fam, variant]);
      const d = o.defaults || {};
      return Object.prototype.hasOwnProperty.call(d, fam) ? d[fam] : null;
    }
  };
  return config;
}

/** deps для чистых вызовов: документ + заглушка + собственный кэш. */
function makeDeps(doc, config, cache) {
  return { document: doc, modelConfig: config || makeConfig(), cache: cache || {} };
}

describe('Gemini UI model: GEMINI_UI_MODEL_RE и normalizeUiModelText', () => {
  const RE = ui.GEMINI_UI_MODEL_RE;

  it('матчит версию + семейство и захватывает группы', function () {
    const m = 'Gemini 3.1 Pro'.match(RE);
    expect(m).not.toBeNull();
    expect(m[0]).toBe('Gemini 3.1 Pro');
    expect(m[1]).toBe('3.1'); // версия
    expect(m[2]).toBe('Pro'); // семейство
  });

  it('понимает запятую как десятичный разделитель и вариант Lite', function () {
    const m = '2,5 Flash Lite'.match(RE);
    expect(m).not.toBeNull();
    expect(m[0]).toBe('2,5 Flash Lite');
    expect(m[1]).toBe('2,5');
    expect(m[2]).toBe('Flash');
  });

  it('пинит усечение варианта «Расширенный» → «Расширенны» (известная особенность)', function () {
    // /расширенн[аяый]/ — ровно один символ после корня, финальное «й» не входит.
    expect('Pro Расширенный'.match(RE)[0]).toBe('Pro Расширенны');
  });

  it('не матчит текст без семейства модели', function () {
    expect(RE.test('Выбрать модель')).toBe(false);
    expect(RE.test('Расширенный')).toBe(false);
  });

  it('нормализует слитный текст кнопки на границе строчная→заглавная', function () {
    expect(ui.normalizeUiModelText('ProРасширенный')).toBe('Pro Расширенный');
    expect(ui.normalizeUiModelText('FlashLite')).toBe('Flash Lite');
    expect(ui.normalizeUiModelText('UltraРасширенный')).toBe('Ultra Расширенный');
  });

  it('сжимает пробельные серии и терпит пустой вход', function () {
    expect(ui.normalizeUiModelText('  3.6 \n\t Flash  ')).toBe('3.6 Flash');
    expect(ui.normalizeUiModelText('')).toBe('');
    expect(ui.normalizeUiModelText(null)).toBe('');
    expect(ui.normalizeUiModelText(undefined)).toBe('');
  });
});

describe('Gemini UI model: extractUiModelText', () => {
  it('извлекает точное имя с версией', function () {
    expect(ui.extractUiModelText('3.6 Flash')).toBe('3.6 Flash');
    expect(ui.extractUiModelText('  3,6\tFlash  ')).toBe('3,6 Flash');
  });

  it('сохраняет префикс gemini, если он есть в тексте', function () {
    expect(ui.extractUiModelText('  Gemini  3.1   Pro  ')).toBe('Gemini 3.1 Pro');
    expect(ui.extractUiModelText('Gemini Pro')).toBe('Gemini Pro');
  });

  it('отбрасывает семейство без версии и без слова gemini', function () {
    expect(ui.extractUiModelText('Pro')).toBe('');
    expect(ui.extractUiModelText('Flash Lite')).toBe('');
  });

  it('отбрасывает пустой, служебный и слишком длинный текст (> 60)', function () {
    expect(ui.extractUiModelText('')).toBe('');
    expect(ui.extractUiModelText(null)).toBe('');
    expect(ui.extractUiModelText('Выбрать модель')).toBe('');
    expect(ui.extractUiModelText('3.6 Flash ' + 'x'.repeat(60))).toBe('');
  });

  it('пинит усечение «Расширенный» и для extract (нужен префикс gemini)', function () {
    expect(ui.extractUiModelText('Gemini Pro Расширенный')).toBe('Gemini Pro Расширенны');
  });
});

describe('Gemini UI model: probeGeminiUiMenuChecked (aria-checked)', () => {
  it('берёт пункт с aria-checked="true" на самом элементе', function () {
    const doc = mount(fixture('menu-checked-own.html'));
    expect(ui.probeGeminiUiMenuChecked(doc)).toBe('3.6 Flash');
  });

  it('берёт пункт, где aria-checked="true" стоит на потомке (галочка внутри)', function () {
    const doc = mount(fixture('menu-checked-nested.html'));
    expect(ui.probeGeminiUiMenuChecked(doc)).toBe('3.1 Pro');
  });

  it('возвращает "", если ни один пункт не помечен checked', function () {
    const doc = mount(fixture('menu-no-checked.html'));
    expect(ui.probeGeminiUiMenuChecked(doc)).toBe('');
  });

  it('возвращает "", если checked-пункт не содержит версии модели', function () {
    const doc = mount(fixture('menu-no-version.html'));
    expect(ui.probeGeminiUiMenuChecked(doc)).toBe('');
  });

  it('возвращает "" на документе без меню модели', function () {
    const doc = mount('<div class="chat"><p>Привет</p></div>');
    expect(ui.probeGeminiUiMenuChecked(doc)).toBe('');
  });

  it('checked-пункт «Авто» → метка режима, а не выдуманная модель', function () {
    const doc = mount('<div role="menu">' +
      '<button type="button" role="menuitemradio" aria-checked="false">3.6 Flash</button>' +
      '<button type="button" role="menuitemradio" aria-checked="true">Авто</button>' +
      '</div>');
    expect(ui.probeGeminiUiMenuChecked(doc)).toBe(ui.GEMINI_UI_AUTO_NAME);
  });
});

describe('Gemini UI model: resolveFamilyVariantId (приоритеты v49)', () => {
  it('(a) кэш точного имени из меню важнее снимка и дефолта', function () {
    const config = makeConfig({
      resolveMap: { '3.1 Pro': 'gemini-3.1-pro' },
      defaults: { pro: 'gemini-3.1-pro-default' }
    });
    const deps = makeDeps(mount(''), config, { pro: '3.1 Pro' });
    expect(ui.resolveFamilyVariantId(deps, 'pro', '', null)).toBe('gemini-3.1-pro');
    expect(config.calls.def.length).toBe(0); // до дефолта не дошли
  });

  it('(b) снимок сети с совпадающей семьёй важнее семейного дефолта', function () {
    const config = makeConfig({
      names: { 'gemini-2.5-flash': '2.5 Flash' },
      defaults: { flash: 'gemini-3.6-flash' }
    });
    const deps = makeDeps(mount(''), config, {});
    expect(ui.resolveFamilyVariantId(deps, 'flash', '', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });

  it('(b) снимок другой семьи игнорируется → (c) семейный дефолт', function () {
    const config = makeConfig({
      names: { 'gemini-3.1-pro': '3.1 Pro' },
      defaults: { flash: 'gemini-3.6-flash' }
    });
    const deps = makeDeps(mount(''), config, {});
    expect(ui.resolveFamilyVariantId(deps, 'flash', '', 'gemini-3.1-pro')).toBe('gemini-3.6-flash');
  });

  it('без кэша и дефолта возвращает снимок сети (страховочный фолбэк)', function () {
    const config = makeConfig({ names: { 'gemini-3.1-pro': '3.1 Pro' } });
    const deps = makeDeps(mount(''), config, {});
    expect(ui.resolveFamilyVariantId(deps, 'flash', '', 'gemini-3.1-pro')).toBe('gemini-3.1-pro');
    expect(ui.resolveFamilyVariantId(deps, 'flash', '', null)).toBe('');
  });
});

describe('Gemini UI model: probeGeminiUiPickerPrimaryText (.picker-primary-text)', () => {
  function pickerHtml(text) {
    return '<button type="button" class="model-picker" aria-haspopup="menu">' +
      '<span class="picker-primary-text">' + text + '</span></button>';
  }

  it('точная версия из нового пикера возвращается как есть и обновляет кэш семьи', function () {
    const config = makeConfig({ defaults: { flash: 'gemini-3.6-flash' } });
    const deps = makeDeps(mount(pickerHtml('Gemini 3.6 Flash')), config, {});
    expect(ui.probeGeminiUiPickerPrimaryText(deps, null)).toBe('Gemini 3.6 Flash');
    expect(deps.cache.flash).toBe('Gemini 3.6 Flash');
    expect(config.calls.def.length).toBe(0);
  });

  it('семейство без версии («Flash», «Flash Lite») → семейный резолвер', function () {
    const config = makeConfig({ defaults: { flash: 'gemini-3.6-flash' } });
    const deps = makeDeps(mount(pickerHtml('Flash')), config, {});
    expect(ui.probeGeminiUiPickerPrimaryText(deps, null)).toBe('gemini-3.6-flash');
    expect(config.calls.def[0][0]).toBe('flash');
    // точной версии нет — кэш не обновляется
    expect(deps.cache).toEqual({});

    const depsLite = makeDeps(mount(pickerHtml('Flash Lite')), makeConfig({
      defaults: { flash: 'gemini-3.5-flash-lite' }
    }), {});
    expect(ui.probeGeminiUiPickerPrimaryText(depsLite, null)).toBe('gemini-3.5-flash-lite');
  });

  it('«Авто»/«Auto» → метка режима, кэш и семейный дефолт не трогаются', function () {
    expect(ui.isAutoUiModelText('Авто')).toBe(true);
    expect(ui.isAutoUiModelText('Auto')).toBe(true);
    expect(ui.isAutoUiModelText('Automatic')).toBe(false);
    for (const auto of ['Авто', 'Auto']) {
      const config = makeConfig({ defaults: { flash: 'gemini-3.6-flash' } });
      const deps = makeDeps(mount(pickerHtml(auto)), config, {});
      expect(ui.probeGeminiUiPickerPrimaryText(deps, null)).toBe(ui.GEMINI_UI_AUTO_NAME);
      expect(deps.cache).toEqual({});
      expect(config.calls.def.length).toBe(0);
    }
  });

  it('служебная подпись и пустой пикер → "" (фолбэк на другие слои)', function () {
    expect(ui.probeGeminiUiPickerPrimaryText(makeDeps(mount(pickerHtml('Выбрать модель'))), null)).toBe('');
    expect(ui.probeGeminiUiPickerPrimaryText(makeDeps(mount(pickerHtml(''))), null)).toBe('');
    expect(ui.probeGeminiUiPickerPrimaryText(makeDeps(mount('<div class="chat"></div>')), null)).toBe('');
  });
});

describe('Gemini UI model: probeGeminiUiButton (button.input-area-switch)', () => {
  it('слитный текст «ProРасширенный» без версии → семейный дефолт', function () {
    const doc = mount(fixture('button-pro-extended.html'));
    const config = makeConfig({ defaults: { pro: 'gemini-pro-default' } });
    const deps = makeDeps(doc, config, {});
    expect(ui.probeGeminiUiButton(deps, null)).toBe('gemini-pro-default');
    // вариант доходит до реестра в усечённом виде — «род» варианта не важен
    expect(config.calls.def[0][0]).toBe('pro');
    expect(config.calls.def[0][1]).toBe('Расширенны');
    // точной версии нет — кэш не обновляется
    expect(deps.cache).toEqual({});
  });

  it('кнопка «Flash» без версии → семейный дефолт flash', function () {
    const doc = mount(fixture('button-flash.html'));
    const config = makeConfig({ defaults: { flash: 'gemini-3.6-flash' } });
    const deps = makeDeps(doc, config, {});
    expect(ui.probeGeminiUiButton(deps, null)).toBe('gemini-3.6-flash');
  });

  it('точная версия в кнопке возвращается как есть и обновляет кэш семьи', function () {
    const doc = mount(fixture('button-version.html'));
    const config = makeConfig({ defaults: { flash: 'gemini-3.6-flash' } });
    const deps = makeDeps(doc, config, {});
    expect(ui.probeGeminiUiButton(deps, null)).toBe('3.6 Flash');
    expect(deps.cache.flash).toBe('3.6 Flash');
    expect(config.calls.def.length).toBe(0);
  });

  it('кэш меню важнее семейного дефолта для кнопки без версии', function () {
    const doc = mount(fixture('button-flash.html'));
    const config = makeConfig({
      resolveMap: { '3.5 Flash': 'gemini-3.5-flash' },
      defaults: { flash: 'gemini-3.6-flash' }
    });
    const deps = makeDeps(doc, config, { flash: '3.5 Flash' });
    expect(ui.probeGeminiUiButton(deps, null)).toBe('gemini-3.5-flash');
  });

  it('возвращает "" без кнопки и на служебном тексте кнопки', function () {
    expect(ui.probeGeminiUiButton(makeDeps(mount('<div class="chat"></div>')), null)).toBe('');
    const doc = mount(fixture('button-negative.html'));
    expect(ui.probeGeminiUiButton(makeDeps(doc), null)).toBe('');
  });
});

describe('Gemini UI model: detectSelectedModelFromDom', () => {
  it('меню приоритетнее кнопки и обновляет кэш семьи', function () {
    const doc = mount(fixture('menu-checked-own.html') + fixture('button-flash.html'));
    const config = makeConfig({ defaults: { flash: 'gemini-3.6-flash' } });
    const deps = makeDeps(doc, config, {});
    expect(ui.detectSelectedModelFromDom(deps, null)).toBe('3.6 Flash');
    expect(deps.cache.flash).toBe('3.6 Flash');
  });

  it('новый пикер приоритетнее старой кнопки композера', function () {
    const doc = mount('<span class="picker-primary-text">3.6 Flash</span>' + fixture('button-flash.html'));
    const config = makeConfig({ defaults: { flash: 'gemini-3.6-flash' } });
    const deps = makeDeps(doc, config, {});
    expect(ui.detectSelectedModelFromDom(deps, null)).toBe('3.6 Flash');
    expect(deps.cache.flash).toBe('3.6 Flash');
    expect(config.calls.def.length).toBe(0); // до кнопки/дефолта не дошли
  });

  it('«Авто» в пикере: метка режима, на старую кнопку не падаем', function () {
    const doc = mount('<span class="picker-primary-text">Авто</span>' + fixture('button-flash.html'));
    const deps = makeDeps(doc, makeConfig({ defaults: { flash: 'gemini-3.6-flash' } }), {});
    expect(ui.detectSelectedModelFromDom(deps, null)).toBe(ui.GEMINI_UI_AUTO_NAME);
    expect(deps.cache).toEqual({});
  });

  it('при закрытом меню (нет checked) падает на кнопку композера', function () {
    const doc = mount(fixture('menu-no-checked.html') + fixture('button-flash.html'));
    const config = makeConfig({ defaults: { flash: 'gemini-3.6-flash' } });
    const deps = makeDeps(doc, config, {});
    expect(ui.detectSelectedModelFromDom(deps, null)).toBe('gemini-3.6-flash');
    expect(deps.cache.flash).toBeUndefined();
  });

  it('кэш переживает вызовы: меню → кнопка без версии использует точное имя', function () {
    const config = makeConfig({
      resolveMap: { '3.6 Flash': 'gemini-3.6-flash' },
      defaults: { flash: 'other' }
    });
    const deps = makeDeps(document, config, {});
    mount(fixture('menu-checked-own.html'));
    expect(ui.detectSelectedModelFromDom(deps, null)).toBe('3.6 Flash');
    mount(fixture('button-flash.html'));
    expect(ui.detectSelectedModelFromDom(deps, null)).toBe('gemini-3.6-flash');
  });

  it('без UI-сигналов возвращает "" (решение о фолбэке — за content.ts)', function () {
    const doc = mount('<div class="chat"><p>Привет</p></div>');
    expect(ui.detectSelectedModelFromDom(makeDeps(doc), null)).toBe('');
  });
});

describe('Gemini UI model: порт реального ModelConfig', () => {
  it('настоящий реестр реализует все три метода порта', function () {
    expect(typeof realModelConfig.resolveModelId).toBe('function');
    expect(typeof realModelConfig.getModel).toBe('function');
    expect(typeof realModelConfig.getFamilyDefaultModelId).toBe('function');
  });

  it('кнопка с точной версией не требует реестра (работает и с реальным)', function () {
    const doc = mount(fixture('button-version.html'));
    expect(ui.probeGeminiUiButton(makeDeps(doc, realModelConfig), null)).toBe('3.6 Flash');
  });
});
