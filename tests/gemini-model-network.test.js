/**
 * v2.0.20: имя модели Gemini берётся из СЕТИ и приоритетнее DOM.
 *   D1 core/gemini-rpc.js:captureModelSlugFromBody — чистый разбор тела запроса/ответа
 *      (batch-execute, SSE-кадры): gemini-<версия>-<flash|pro|ultra>[-lite].
 *   D2 utils/model-config.js:resolveModelId — авто-регистрация НОВОГО слаг-а: запись
 *      создаётся, когда словарь слаг ещё не покрывает (Pro → 128 000, Flash/Flash Lite →
 *      1 048 576), существующие ключи не подменяются.
 *   D3 core/content.js:resolveCurrentModel — лестница попап → сеть (rawSnapshot) → DOM
 *      (uiRaw): ручной выбор пользователя не перебивается сетью (H19), но при
 *      «Автоопределении» сеть по-прежнему впереди DOM — дропдаун часто без номера
 *      версии, а сеть называет модель полностью.
 *   D4 мост между мирами: core/gemini-intercept.js (MAIN world) шлёт событие
 *      ai-cm-model-slug, core/content.js (изолированный мир) пишет detectedModelSlug —
 *      прямая запись переменной из MAIN world не видна (см. регрессионный запрет в D4).
 *   D5 (v2.0.21) выбор модели из МАССИВА слаг-ов: в теле ответа перечислены несколько
 *      моделей (['gemini-3-flash','gemini-3.6-flash','gemini-2.5-flash-lite']) и первой
 *      идёт не текущая; берётся самая свежая версия (pro > ultra > flash при равенстве,
 *      внутри семейства — без -lite), а не первое совпадение.
 */

const fs = require('fs');
const path = require('path');
const Rpc = require('../core/gemini-rpc.js');
const ModelConfig = require('../utils/model-config.js');

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'core', 'content.js'), 'utf8');

describe('D1: captureModelSlugFromBody — слаг модели из тела сети', () => {
  test('flash-lite из тела ответа → полный слаг (lite не отрезается до flash)', () => {
    const body = ')]}\'\n\n[["wrb.fr",null,"{\\"model\\":\\"gemini-3.5-flash-lite\\"}]]';
    expect(Rpc.captureModelSlugFromBody(body)).toBe('gemini-3.5-flash-lite');
  });

  test('варианты семейств: flash / pro / ultra / -lite', () => {
    expect(Rpc.captureModelSlugFromBody('"gemini-3.6-flash"')).toBe('gemini-3.6-flash');
    expect(Rpc.captureModelSlugFromBody('"gemini-3.1-pro"')).toBe('gemini-3.1-pro');
    expect(Rpc.captureModelSlugFromBody('"gemini-3.1-ultra"')).toBe('gemini-3.1-ultra');
    expect(Rpc.captureModelSlugFromBody('"gemini-3.5-pro-lite"')).toBe('gemini-3.5-pro-lite');
  });

  test('регистр нормализуется к нижнему', () => {
    expect(Rpc.captureModelSlugFromBody('"Gemini-3.5-Flash-Lite"')).toBe('gemini-3.5-flash-lite');
  });

  test('слаг в SSE-кадре (вторая строка потока) находится', () => {
    const sse = 'data: {"c":0}\n\ndata: {"model":"gemini-3.5-flash-lite","tokens":12}\n\n';
    expect(Rpc.captureModelSlugFromBody(sse)).toBe('gemini-3.5-flash-lite');
  });

  test('нет слаг-а / пусто / не строка → пустая строка, без исключений', () => {
    expect(Rpc.captureModelSlugFromBody('f.req=[[["hNvQHb"]]]')).toBe('');
    expect(Rpc.captureModelSlugFromBody('')).toBe('');
    expect(Rpc.captureModelSlugFromBody(null)).toBe('');
    expect(Rpc.captureModelSlugFromBody(undefined)).toBe('');
    expect(Rpc.captureModelSlugFromBody(42)).toBe('');
  });

  test('посторонний слаг (не gemini) не подхватывается', () => {
    expect(Rpc.captureModelSlugFromBody('"qwen3.7-plus"')).toBe('');
    expect(Rpc.captureModelSlugFromBody('"gpt-5.5"')).toBe('');
  });
});

describe('D5: из массива слаг-ов выбирается самая свежая модель', () => {
  // Полевой случай 2026-10-22: тело ответа — массив ['gemini-3-flash','gemini-3.6-flash',
  // 'gemini-2.5-flash-lite'], первым лежит не текущая модель; виджет показывал самую свежую
  // (gemini-3.6-flash), а первое совпадение дало бы gemini-3-flash.
  test('массив из ответа → gemini-3.6-flash, а не первое совпадение', () => {
    const body = ')]}\'\n\n[["wrb.fr",null,"[\\"gemini-3-flash\\",\\"gemini-3.6-flash\\",\\"gemini-2.5-flash-lite\\"]"]]';
    expect(Rpc.captureModelSlugFromBody(body)).toBe('gemini-3.6-flash');
  });

  test('порядок в массиве не важен: [gemini-3-flash, gemini-3.6-flash] и обратный', () => {
    expect(Rpc.captureModelSlugFromBody('["gemini-3-flash","gemini-3.6-flash"]')).toBe('gemini-3.6-flash');
    expect(Rpc.captureModelSlugFromBody('["gemini-3.6-flash","gemini-3-flash"]')).toBe('gemini-3.6-flash');
  });

  test('версия сравнивается посегментно: 3.10 старше 3.9', () => {
    expect(Rpc.captureModelSlugFromBody('["gemini-3.9-flash","gemini-3.10-flash"]')).toBe('gemini-3.10-flash');
    expect(Rpc.captureModelSlugFromBody('["gemini-4-flash","gemini-3.99-pro"]')).toBe('gemini-4-flash');
  });

  test('равная версия → pro > ultra > flash', () => {
    expect(Rpc.captureModelSlugFromBody('["gemini-3.6-flash","gemini-3.6-pro"]')).toBe('gemini-3.6-pro');
    expect(Rpc.captureModelSlugFromBody('["gemini-3.6-flash","gemini-3.6-ultra"]')).toBe('gemini-3.6-ultra');
    expect(Rpc.captureModelSlugFromBody('["gemini-3.6-flash","gemini-3.6-pro","gemini-3.6-ultra"]')).toBe('gemini-3.6-pro');
  });

  test('равная версия и семейство → вариант без -lite важнее', () => {
    expect(Rpc.captureModelSlugFromBody('["gemini-3.6-flash-lite","gemini-3.6-flash"]')).toBe('gemini-3.6-flash');
    expect(Rpc.captureModelSlugFromBody('["gemini-3.6-flash","gemini-3.6-flash-lite"]')).toBe('gemini-3.6-flash');
  });

  test('выбор стабилен при повторе одного и того же слаг-а (SSE-кадры)', () => {
    const sse = 'data: {"model":"gemini-3.6-flash"}\n\ndata: {"model":"gemini-3.6-flash"}\n\n';
    expect(Rpc.captureModelSlugFromBody(sse)).toBe('gemini-3.6-flash');
  });
});

describe('D2: resolveModelId — авто-регистрация нового слаг-а Gemini', () => {
  test('gemini-9.9-pro не падает и даёт запись Gemini 9.9 Pro с окном 128 000', () => {
    const id = ModelConfig.resolveModelId('gemini-9.9-pro');
    expect(id).toBe('gemini-9.9-pro');
    const rec = ModelConfig.getModel(id);
    expect(rec.name).toBe('Gemini 9.9 Pro');
    expect(rec.provider).toBe('Google');
    expect(rec.contextLimit).toBe(128000);
    expect(ModelConfig.getContextLimit(id)).toBe(128000);
    expect(ModelConfig.getEffectiveLimit(id)).toBe(128000);
  });

  test('flash и flash-lite получают окно 1 048 576', () => {
    const flash = ModelConfig.resolveModelId('gemini-9.9-flash');
    expect(ModelConfig.getModel(flash).name).toBe('Gemini 9.9 Flash');
    expect(ModelConfig.getContextLimit(flash)).toBe(1048576);

    const lite = ModelConfig.resolveModelId('gemini-9.9-flash-lite');
    expect(ModelConfig.getModel(lite).name).toBe('Gemini 9.9 Flash Lite');
    expect(ModelConfig.getContextLimit(lite)).toBe(1048576);
  });

  test('запись кешируется: повторный разбор того же слаг-а — тот же ключ', () => {
    const a = ModelConfig.resolveModelId('gemini-9.9-pro');
    const b = ModelConfig.resolveModelId('gemini-9-9-pro');
    expect(b).toBe(a);
    expect(ModelConfig.models[a].contextLimit).toBe(128000);
  });

  test('существующий gemini-3.5-flash-lite резолвится как раньше (984k→ключ словаря)', () => {
    const id = ModelConfig.resolveModelId('gemini-3.5-flash-lite');
    expect(id).toBe('gemini-3.5-flash-lite');
    expect(ModelConfig.getModel(id).name).toBe('Gemini 3.5 Flash Lite');
    expect(ModelConfig.getContextLimit(id)).toBe(1048576);
  });

  test('известные слаг-и берут свою запись словаря (дублей не появляется)', () => {
    const before = Object.keys(ModelConfig.models).length;
    expect(ModelConfig.resolveModelId('gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(ModelConfig.getModel('gemini-3.6-flash').contextLimit).toBe(1048576);
    expect(ModelConfig.resolveModelId('gemini-3.1-pro')).toBe('gemini-3.1-pro');
    expect(ModelConfig.getModel('gemini-3.1-pro').name).toBe('Gemini 3.1 Pro');
    expect(ModelConfig.getModel('gemini-3.1-pro').contextLimit).toBe(128000);
    // «3.1 Pro» (без префикса gemini-) по-прежнему резолвится в свой ключ
    expect(ModelConfig.resolveModelId('3.1 Pro')).toBe('3.1 Pro');
    expect(Object.keys(ModelConfig.models).length).toBe(before);
  });

  test('не-gemini мусор по-прежнему null (авто-регистрация не расширяет область)', () => {
    expect(ModelConfig.resolveModelId('zzz-нет-такого')).toBeNull();
    expect(ModelConfig.resolveModelId('gemini-без-версии')).toBeNull();
  });
});

describe('D4: мост MAIN world → content.js (событие ai-cm-model-slug)', () => {
  const INTERCEPT = fs.readFileSync(path.join(__dirname, '..', 'core', 'gemini-intercept.js'), 'utf8');
  test('ядро MAIN world шлёт событие, а не пишет переменную чужого мира', () => {
    // Перехватчик исполняется в MAIN world (core/background.js: world:'MAIN'), а
    // detectedModelSlug объявлен в изолированном мире (core/state.js:94) — прямая запись
    // оттуда молча не доходит до content.js, поэтому мост обязан быть событием.
    expect(INTERCEPT).toContain("window.dispatchEvent(new CustomEvent('ai-cm-model-slug', { detail: { slug: slug } }))");
    expect(INTERCEPT).not.toContain('if (slug) detectedModelSlug = slug;');
    expect(INTERCEPT).toContain('captureModelSlugFromBody: captureModelSlugFromBody,');
  });

  test('content.js принимает событие и обновляет detectedModelSlug', () => {
    expect(CONTENT).toContain("window.addEventListener('ai-cm-model-slug'");
    const at = CONTENT.indexOf("window.addEventListener('ai-cm-model-slug'");
    expect(CONTENT.slice(at, at + 400)).toContain('detectedModelSlug = md.slug');
  });
});

describe('D3: лестница приоритета модели в content.js — попап → сеть → DOM', () => {
  test('raw = popupModelId → rawSnapshot → uiRaw (H19: ручной выбор первый)', () => {
    expect(CONTENT).toContain("const raw = popupModelId || rawSnapshot || uiRaw || '';");
    const fn = CONTENT.slice(CONTENT.indexOf('function resolveCurrentModel()'));
    const line = fn.slice(fn.indexOf("const raw = "), fn.indexOf('let modelId'));
    const iPopup = line.indexOf('popupModelId');
    const iSnap = line.indexOf('rawSnapshot');
    const iUi = line.indexOf('uiRaw');
    expect(iPopup).toBeGreaterThan(-1);
    expect(iSnap).toBeGreaterThan(iPopup);
    expect(iUi).toBeGreaterThan(iSnap);
  });

  test('источник raw идёт той же лестницей: попап → сеть → DOM', () => {
    // rawSrc обязан совпадать с raw, иначе бейдж/снимок получат модель одного источника,
    // а path/source назовут другой (H19: попап авторитетен для лимита и токенизации).
    expect(CONTENT).toContain("const rawSrc = popupModelId ? 'попап' : (rawSnapshot ? (rawFromNet ? 'сеть' : 'DOM') : (uiRaw ? 'dom' : ''));");
  });

  test('порядок сети над DOM сохранён (смысл v2.0.20)', () => {
    const fn = CONTENT.slice(CONTENT.indexOf('function resolveCurrentModel()'));
    const line = fn.slice(fn.indexOf("const raw = "), fn.indexOf('let modelId'));
    expect(line.indexOf('rawSnapshot')).toBeLessThan(line.indexOf('uiRaw'));
  });

  test('прежний порядок «сеть первой» не остался в живом коде', () => {
    expect(CONTENT).not.toContain("const raw = rawSnapshot || uiRaw || popupModelId || '';");
  });
});
