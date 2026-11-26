/**
 * BUG-02 (Qwen): распознанная, но отсутствующая в каталоге модель.
 *
 * Проблема: сеть/DOM даёт валидный слаг (например 'qwen3.9-max'), которого ещё нет в
 * каталоге utils/model-config.ts. resolveModelId(raw) === null, и прежний код молча
 * подменял модель дефолтом сайта — и в бейдже, и в файле экспорта.
 *
 * Правило (решение владельца):
 *   - сигнал ЕСТЬ, модели НЕТ в каталоге (Qwen) → лимиты из siteDefaults.qwen
 *     (getDefaultModel('qwen') = 'qwen3.7-plus'), а отображаемое имя (lastSnapshotModelName)
 *     — распознанный слаг;
 *   - сигнала НЕТ вообще → дефолт сайта, lastSnapshotModelName НЕ заполняется;
 *   - известная каталожная модель → ключ + каталожное имя (прежнее поведение);
 *   - прочие сайты (Gemini/GSA и т.д.) — байтово прежнее поведение: unknown-слаг в
 *     lastSnapshotModelName НЕ попадает (защита пина «Gemini-путь: пусто»).
 *
 * resolveCurrentModel исполняется РЕАЛЬНОЙ функцией из core/content.ts в песочнице
 * `with (ctx)` с настоящим ModelConfig; подменяются только входы скоупа.
 */

const CONTENT = require('./helpers/content-source.js').contentSource;
const CONTENT_MODEL = require('./helpers/content-source.js').moduleSource('content-model.ts');
const ModelConfig = require('./helpers/load-esm.js').loadEsm('utils/model-config.ts');
const Builders = require('./helpers/load-esm.js').loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');

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

const SCOPE = 'with (ctx) { ' + fnDecl(CONTENT_MODEL, 'resolveModelDecision') + '\n' +
  fnDecl(CONTENT, 'resolveCurrentModel') +
  ' return { run: resolveCurrentModel }; }';
const makeResolve = new Function('ctx', SCOPE);

const QWEN = 'qwen';
const QWEN_DEFAULT = 'qwen3.7-plus';

function qwenCtx(over) {
  const ctx = {
    ModelConfig: ModelConfig,
    currentAdapter: { siteName: QWEN, detectModel: function () { return ''; } },
    detectedModelSlug: '',
    popupModelId: null,
    popupRawModel: '',
    geminiUiModelByFamily: {},
    lastResolvedModelId: null,
    lastModelSourceSig: '',
    lastSnapshotModelName: '',
    debugLog: function () { },
    swallow: function () { },
    swallowSoft: function () { },
    console: { log: function () { } },
    window: { location: { hostname: 'chat.qwen.ai' } }
  };
  Object.assign(ctx, over || {});
  return ctx;
}

describe('BUG-02: Qwen — распознанный слаг вне каталога не подменяется молча', () => {
  test('unknown qwen3.9-max: лимит siteDefaults, имя снимка = распознанный слаг', () => {
    expect(ModelConfig.resolveModelId('qwen3.9-max')).toBeNull();
    const ctx = qwenCtx({ detectedModelSlug: 'qwen3.9-max' });
    expect(makeResolve(ctx).run()).toBe(QWEN_DEFAULT);
    expect(ctx.lastSnapshotModelName).toBe('qwen3.9-max');
    // ключ для лимитов/сравнения — дефолт сайта, отображаемое имя — слаг
    expect(ModelConfig.getEffectiveLimit(QWEN_DEFAULT))
      .toBe(ModelConfig.getEffectiveLimit(ModelConfig.getDefaultModel(QWEN)));
  });

  test('сигнала нет: дефолт сайта, lastSnapshotModelName не заполняется', () => {
    const ctx = qwenCtx({});
    expect(makeResolve(ctx).run()).toBe(QWEN_DEFAULT);
    expect(ctx.lastSnapshotModelName).toBe('');
  });

  test('известный qwen3.8-max: каталожный ключ и имя (прежнее поведение)', () => {
    const ctx = qwenCtx({ detectedModelSlug: 'qwen3.8-max' });
    expect(makeResolve(ctx).run()).toBe('qwen3.8-max');
    expect(ctx.lastSnapshotModelName).toBe('Qwen3.8-Max');
  });

  test('не-Qwen unknown: lastSnapshotModelName остаётся пустым (пин Gemini)', () => {
    const ctx = qwenCtx({
      currentAdapter: { siteName: 'gemini', detectModel: function () { return 'gemini-без-версии'; } },
      window: { location: { hostname: 'gemini.google.com' } }
    });
    expect(makeResolve(ctx).run()).toBe(ModelConfig.getDefaultModel('gemini'));
    expect(ctx.lastSnapshotModelName).toBe('');
  });

  test('источник логики: одна точка показа слага (site === qwen && unknownModel)', () => {
    const body = fnDecl(CONTENT, 'resolveCurrentModel');
    expect((body.match(/site === 'qwen' && unknownModel/g) || []).length).toBe(1);
    expect(body).toContain('String(raw).trim().slice(0, 64)');
    // присваиваний lastSnapshotModelName в конкат-источнике ровно три (сброс + slug + эта)
    expect((CONTENT.match(/^\s*lastSnapshotModelName = /gm) || []).length).toBe(3);
  });
});

describe('BUG-02: снимок — model остаётся каталожным ключом, имя несёт modelName', () => {
  const SNAP_START = CONTENT.indexOf('var aiCmCtxSnapCandidate');
  const SNAP = CONTENT.slice(SNAP_START, SNAP_START + 1400);

  test('modelName берёт lastSnapshotModelName только для qwen/google_search', () => {
    expect(SNAP_START).toBeGreaterThan(-1);
    expect(SNAP).toContain("(ctxSnapSite === 'google_search' || ctxSnapSite === 'qwen')");
    expect(SNAP).toContain('typeof lastSnapshotModelName === \'string\' && lastSnapshotModelName');
    expect(SNAP).toContain('? lastSnapshotModelName');
    // фолбэк — прежнее выражение байт-в-байт (прочие сайты не меняются)
    expect(SNAP).toContain(': (ModelConfig.getModel(modelId)?.name || modelId),');
  });

  test('поле model снимка — каталожный ключ (лимиты/сравнение)', () => {
    expect(SNAP).toContain('model: modelId,');
  });

  test('json-экспорт: model — pass-through, слаг показывается как есть', () => {
    const json = JSON.parse(Builders.buildJsonFromHistory({ model: 'qwen3.9-max', messages: [] }));
    expect(json.model).toBe('qwen3.9-max');
  });
});
