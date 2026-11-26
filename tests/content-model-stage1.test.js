'use strict';
/**
 * 2.4 Stage 1: чистое решение модели (core/content-model.ts).
 *
 * Проверяется выделенная функция `resolveModelDecision`: лестница
 * попап → DOM(UI) → сеть/снимок → дефолт сайта, «Авто» и unknown-слаг.
 * Обёртка `resolveCurrentModel` (сбор сигналов + побочные эффекты) остаётся
 * в content.ts и покрыта прежними сьютами.
 */
const { moduleSource } = require('./helpers/content-source.js');

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

const MODEL_SRC = moduleSource('content-model.ts');
const resolveModelDecision = new Function('ctx',
  'with (ctx) { ' + fnDecl(MODEL_SRC, 'resolveModelDecision') + '\n return resolveModelDecision; }'
)({});
const IDS = {
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-3.6-flash': 'gemini-3.6-flash',
  'qwen3.8-max': 'qwen3.8-max',
  'gpt-6': 'gpt-6'
};
const resolveModelId = function (raw) { return IDS[raw] || null; };

function input(over) {
  return Object.assign({
    site: 'gemini',
    popupModelId: null,
    raw: '',
    rawSrc: '',
    rawFromNet: '',
    rawFromDom: '',
    rawSnapshot: '',
    uiRaw: '',
    uiAuto: false,
    geminiHost: false,
    defaultModel: 'gemini-2.5-pro',
    resolveModelId: resolveModelId
  }, over || {});
}

describe('2.4 Stage 1: resolveModelDecision — чистая лестница модели', function () {
  test('попап побеждает DOM и сеть; source=popup', function () {
    const d = resolveModelDecision(input({
      popupModelId: 'gemini-2.5-pro',
      raw: 'gemini-2.5-pro', rawSrc: 'попап',
      rawFromNet: 'gemini-2.5-flash', uiRaw: 'gemini-3.6-flash'
    }));
    expect(d).toMatchObject({ modelId: 'gemini-2.5-pro', path: 'попап', source: 'popup', unknownModel: false });
  });

  test('DOM(UI) побеждает сеть; source=dom', function () {
    const d = resolveModelDecision(input({
      raw: 'gemini-3.6-flash', rawSrc: 'dom',
      rawFromNet: 'gemini-2.5-flash', uiRaw: 'gemini-3.6-flash'
    }));
    expect(d).toMatchObject({ modelId: 'gemini-3.6-flash', path: 'dom', source: 'dom' });
  });

  test('сеть используется, когда UI-сигнала нет; source=snapshot', function () {
    const d = resolveModelDecision(input({
      raw: 'gemini-2.5-flash', rawSrc: 'сеть',
      rawFromNet: 'gemini-2.5-flash'
    }));
    expect(d).toMatchObject({ modelId: 'gemini-2.5-flash', path: 'сеть', source: 'snapshot' });
  });

  test('Gemini «Авто» без сети даёт gemini-auto/dom(auto)', function () {
    const d = resolveModelDecision(input({ geminiHost: true, uiAuto: true, raw: '', rawSrc: '' }));
    expect(d).toMatchObject({ modelId: 'gemini-auto', path: 'dom(auto)', source: 'snapshot' });
  });

  test('Gemini без сигналов после F5 — gemini-auto, не устаревший ярлык', function () {
    const d = resolveModelDecision(input({ geminiHost: true, raw: '' }));
    expect(d).toMatchObject({ modelId: 'gemini-auto', path: 'dom(auto)' });
  });

  test('unknown-слаг GSA: дефолт сайта, path→siteDefaults(вне каталога)', function () {
    const d = resolveModelDecision(input({
      site: 'google_search', defaultModel: 'gemini-search-default',
      raw: 'brand-new-model', rawSrc: 'сеть', rawFromNet: 'brand-new-model'
    }));
    expect(d).toMatchObject({
      modelId: 'gemini-search-default',
      unknownModel: true,
      path: 'сеть→siteDefaults(вне каталога)'
    });
  });

  test('unknown-слаг Qwen: та же ветка siteDefaults', function () {
    const d = resolveModelDecision(input({
      site: 'qwen', defaultModel: 'qwen3.7-plus',
      raw: 'qwen9.9-max', rawSrc: 'сеть', rawFromNet: 'qwen9.9-max'
    }));
    expect(d).toMatchObject({ modelId: 'qwen3.7-plus', unknownModel: true, path: 'сеть→siteDefaults(вне каталога)' });
  });

  test('unknown-слаг прочих сайтов: обычный путь «→дефолт(не распознан)»', function () {
    const d = resolveModelDecision(input({
      site: 'chatgpt', defaultModel: 'gpt-6',
      raw: 'gpt-9', rawSrc: 'сеть', rawFromNet: 'gpt-9'
    }));
    expect(d).toMatchObject({ modelId: 'gpt-6', unknownModel: true, path: 'сеть→дефолт(не распознан)' });
  });

  test('нет сигналов: дефолт сайта, path=дефолт', function () {
    const d = resolveModelDecision(input({ raw: '', defaultModel: 'gemini-2.5-pro' }));
    expect(d).toMatchObject({ modelId: 'gemini-2.5-pro', path: 'дефолт', unknownModel: false });
  });
});
