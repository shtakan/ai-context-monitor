/**
 * core/content-model.ts — 2.4 Stage 1: чистое решение «какая модель текущего чата».
 *
 * Classic-скрипт manifest.content_scripts[0].js ПЕРЕД core/content.ts: общий
 * лексический скоуп.
 *
 * 2.4 Stage 1: чистое решение `resolveModelDecision` не читает DOM/chrome/
 * ModelConfig — все сигналы и резолверы приходят явными входами.
 * 2.4 Stage 9: обёртка `resolveCurrentModel()` перенесена сюда move-only из
 * content.ts. Она собирает сигналы (попап → DOM(UI) → сеть), зовёт решение и
 * применяет побочные эффекты (lastSnapshotModelName, логи) в общем скоупе.
 *
 * Лестница приоритетов сохранена байтово:
 *   попап → DOM(UI) → сеть/снимок → дефолт сайта.
 * «Авто» не резолвится и уступает сети; unknown-слаг у GSA/Qwen получает
 * siteDefaults-путь, но отображаемое имя остаётся распознанным.
 */

/** Входные сигналы решения. Никаких чтений из DOM/chrome/ModelConfig. */
interface AiCmModelDecisionInput {
  /** Ключ сайта: chatgpt/gemini/aistudio/deepseek/qwen/google_search/... */
  site: string;
  /** Явный выбор в попапе (null/'' — «Авто»). */
  popupModelId: string | null;
  /** Итоговый raw по лестнице попап → UI → снимок (уже собран обёрткой). */
  raw: string;
  /** Источник raw: 'попап' | 'dom' | 'сеть' | 'DOM' | ''. */
  rawSrc: string;
  /** Слаг из сети (detectedModelSlug), '' если сигнала нет. */
  rawFromNet: string;
  /** DOM-адаптер (detectModel), '' если сигнала нет. */
  rawFromDom: string;
  /** Снимок (AI Studio DOM slug / сеть / DOM), '' если сигнала нет. */
  rawSnapshot: string;
  /** Распознанный UI-текст Gemini (после отбрасывания нераспознанного). */
  uiRaw: string;
  /** UI показывает «Авто». */
  uiAuto: boolean;
  /** Текущий хост — gemini.google.com. */
  geminiHost: boolean;
  /** Дефолт сайта из каталога. */
  defaultModel: string;
  /** Резолвер каталожного id: raw → id | null. */
  resolveModelId: (raw: string) => string | null;
}

/** Результат чистого решения; побочные эффекты — в обёртке content.ts. */
interface AiCmModelDecision {
  /** Каталожный id для raw (null — сигнал не распознан). */
  rawResolvedId: string | null;
  /** Сигнал есть, но модели нет в каталоге. */
  unknownModel: boolean;
  /** Итоговый id (каталожный/дефолт сайта/gemini-auto). */
  modelId: string;
  /** Человеческий путь для [model-detect]. */
  path: string;
  /** Источник для снимка/лога: popup | dom | snapshot. */
  source: 'popup' | 'dom' | 'snapshot';
}

/**
 * Чистое решение модели. Порядок веток и строки путей — ровно как в
 * content.ts:resolveCurrentModel до 2.4 Stage 1 (R1: байты/поведение прежние).
 */
function resolveModelDecision(input: AiCmModelDecisionInput): AiCmModelDecision {
  var raw = input.raw || '';
  var rawSrc = input.rawSrc || '';
  var rawFromNet = input.rawFromNet || '';
  var rawFromDom = input.rawFromDom || '';
  var uiRaw = input.uiRaw || '';
  var uiAuto = input.uiAuto === true;
  var geminiHost = input.geminiHost === true;
  var popupModelId = input.popupModelId || '';
  var site = input.site || '';

  var rawResolvedId = raw ? input.resolveModelId(raw) : null;
  var unknownModel = !!raw && !rawResolvedId;
  var modelId = rawResolvedId;
  var path = '';
  if (modelId) {
    path = rawSrc || 'дефолт';
  } else if (uiAuto && !rawFromNet && !popupModelId) {
    // UI явно показывает «Авто», сети нет: не подставляем скрытый/дефолтный ярлык.
    modelId = 'gemini-auto';
    path = 'dom(auto)';
  } else if (geminiHost && site === 'gemini' && !popupModelId && !rawFromNet && !rawFromDom && !uiRaw) {
    // После F5 UI-пикер может ещё не отрисоваться: Gemini web по умолчанию «Авто».
    modelId = 'gemini-auto';
    path = 'dom(auto)';
  } else {
    modelId = input.defaultModel;
    path = raw ? ((rawFromNet ? 'сеть' : 'DOM') + '→дефолт(не распознан)') : 'дефолт';
    // BUG-02: путь честно называет, откуда число лимита (siteDefaults), только там,
    // где распознанный слаг показывается в файле/бейдже.
    if (unknownModel && (site === 'google_search' || site === 'qwen')) {
      path = (rawSrc || 'сеть') + '→siteDefaults(вне каталога)';
    }
  }
  var source: AiCmModelDecision['source'] = rawSrc === 'попап' ? 'popup'
    : (rawSrc === 'dom' ? 'dom' : 'snapshot');
  return {
    rawResolvedId: rawResolvedId,
    unknownModel: unknownModel,
    modelId: modelId as string,
    path: path,
    source: source
  };
}

// ========== ОПРЕДЕЛЕНИЕ МОДЕЛИ (v47: UI-приоритет + 3 слоя фолбэка) ==========
// T1 (часть 1): логика UI-детектора Gemini (регэксп, checked-пункт меню, кнопка
// композера, семейный резолвер) вынесена в utils/gemini-ui-model.ts — чистый модуль
// с DI (document/ModelConfig/кэш передаются аргументами) и jest-пинами
// (tests/adapters/gemini-ui-model.test.js). Здесь остаются только кэш «последнее
// точное имя по семейству» и вызов детектора в resolveCurrentModel ниже.
const geminiUiModelByFamily: Record<string, string> = {}; // 'pro'|'flash'|'ultra' -> последнее точное имя из UI
let lastModelSourceSig: string = '';
function resolveCurrentModel(): string {
  // v2.0.33: лестница — попап → DOM(uiRaw) → сеть; «Авто» не резолвится и уступает сети.
  const rawFromNet = detectedModelSlug || '';
  const snapNetId = rawFromNet ? ModelConfig.resolveModelId(rawFromNet) : null;
  let uiRaw = '';
  let uiAuto = false;
  let geminiHost = false;
  try {
    geminiHost = (window.location.hostname || '').indexOf('gemini.google.com') !== -1;
    if (geminiHost) {
      // v49: передаём сетевую версию — приоритет (b) для DOM-сигнала без номера версии
      // T1: UI-слой живёт в utils/gemini-ui-model.ts — DI: документ, реестр моделей
      // и общий кэш семьи передаются аргументами (модуль втянут import'ом выше).
      uiRaw = GeminiUiModel.detectSelectedModelFromDom({
        document: document,
        modelConfig: ModelConfig,
        cache: geminiUiModelByFamily
      }, snapNetId) || '';
      uiAuto = !!(uiRaw && typeof GeminiUiModel.isAutoUiModelText === 'function' &&
        GeminiUiModel.isAutoUiModelText(uiRaw));
    }
  } catch (e) { uiRaw = ''; uiAuto = false; }
  const uiResolved = uiRaw ? ModelConfig.resolveModelId(uiRaw) : null;
  if (uiRaw && !uiResolved) uiRaw = ''; // «Авто»/нераспознанный UI-сигнал → фолбэк на сеть/DOM

  const rawFromDom = (rawFromNet || uiRaw || uiAuto) ? '' : (currentAdapter!.detectModel() || '');
  const rawSnapshot = ((typeof aiCmAistudioDomSlug === 'function') ? aiCmAistudioDomSlug() : '') || rawFromNet || rawFromDom || '';
  const snapModelId = rawSnapshot ? ModelConfig.resolveModelId(rawSnapshot) : null;

  // v47: экспорт остаётся на модели снимка — запоминаем её имя отдельно
  if (snapModelId) {
    lastSnapshotModelName = ModelConfig.getModel(snapModelId)?.name || snapModelId;
  }

  // H19: явный выбор модели в дропдауне попапа авторитетен для лимита и токенизации.
  // Лестница: попап → DOM(UI) → сеть. «Автоопределение» (popupModelId === null/'')
  // уступает явному UI-сигналу, а если UI показывает «Авто» — уступает сети, поэтому
  // ручной выбор пользователя не перебивается сетью, а «Авто» не подставляет ложный слаг.
  const raw = popupModelId || uiRaw || rawSnapshot || '';
  // Источник raw для path/source: та же лестница приоритетов (без повторов).
  const rawSrc = popupModelId ? 'попап' : (uiRaw ? 'dom' : (rawSnapshot ? (rawFromNet ? 'сеть' : 'DOM') : ''));
  // 2.4 Stage 1: чистое решение модели — в core/content-model.ts (без DOM/chrome/
  // ModelConfig внутри); здесь только сбор сигналов и побочные эффекты.
  var decision = resolveModelDecision({
    site: (currentAdapter && currentAdapter.siteName) || '',
    popupModelId: popupModelId,
    raw: raw,
    rawSrc: rawSrc,
    rawFromNet: rawFromNet,
    rawFromDom: rawFromDom,
    rawSnapshot: rawSnapshot,
    uiRaw: uiRaw,
    uiAuto: uiAuto,
    geminiHost: geminiHost,
    defaultModel: ModelConfig.getDefaultModel(currentAdapter!.siteName),
    resolveModelId: function (value: string) { return ModelConfig.resolveModelId(value); }
  });
  // BUG-02: «сигнал есть, а модели нет в каталоге» — отдельное состояние. Лимиты берутся
  // из siteDefaults (modelId ниже), а отображаемое имя остаётся распознанным слагом.
  var site = (currentAdapter && currentAdapter.siteName) || '';
  var unknownModel = decision.unknownModel;
  let modelId = decision.modelId;
  let path = decision.path;
  if (modelId === 'gemini-auto') lastSnapshotModelName = (ModelConfig.getModel('gemini-auto')?.name || 'Gemini (auto)');
  // v1.18 (F7): GSA — сеть может не дать slug вовсе (детектор GSA молчит, если в ответе нет
  // model:"…"), и имя модели снапшота оставалось пустым → сегмент модели в имени файла
  // автоэкспорта падал в фолбэк 'model'. Заполняем ОДНОЙ точкой ЗДЕСЬ — ровно той моделью,
  // что показывает badge-update: ModelConfig.getModel(modelId)?.name, где modelId идёт по
  // пути попап → DOM → сеть → дефолт сайта ('gemini-search-default' = «Gemini (Search AI)»).
  // Для прочих сайтов (в т.ч. Gemini) поведение прежнее — присваивание не выполняется.
  // BUG-02: Qwen + распознанный слаг вне каталога — в файл/бейдж идёт САМ слаг (лимит
  // остаётся дефолтом сайта); без сигнала Qwen по-прежнему ничего не заполняет, а у GSA
  // и у Qwen с сигналом из каталога — каталожное имя (поведение прежнее).
  if (currentAdapter && (site === 'google_search' || (site === 'qwen' && unknownModel))) {
    lastSnapshotModelName = (site === 'qwen')
      ? String(raw).trim().slice(0, 64)
      : (ModelConfig.getModel(modelId)?.name || modelId);
  }
  const source = decision.source;
  if (modelId !== lastResolvedModelId) {
    lastResolvedModelId = modelId;
    const ctx = ModelConfig.getContextLimit(modelId);
    const eff = ModelConfig.getEffectiveLimit(modelId);
    console.log('[model-detect] путь=' + path +
      (raw ? ', raw="' + raw + '"' : '') +
      ' → id=' + modelId + ', имя=' + (ModelConfig.getModel(modelId)?.name || modelId) +
      ', окно=' + ctx.toLocaleString() + ', порог потери деталей=' + eff.toLocaleString());
  }
  // v47: debug-лог источника модели (бейдж/попап/лимит)
  const srcSig = source + '|' + modelId;
  if (srcSig !== lastModelSourceSig) {
    lastModelSourceSig = srcSig;
    debugLog('log', source === 'popup'
      ? '[model-detect] H19 popup raw="' + popupRawModel + '" → id=' + modelId + ' · model-source=popup'
      : (source === 'dom'
        ? '[model-detect] v48 dom raw="' + uiRaw + '" → id=' + modelId + ' · model-source=dom'
        : '[model-detect] v47 model-source=snapshot' +
          (rawSnapshot ? ', снимок="' + rawSnapshot + '"' : '') +
          ' → id=' + modelId));
  }
  return modelId;
}

// UMD/глобальный мост для content.ts и срез-песочниц: функции остаются в общем
// лексическом скоупе classic-скриптов, Api — для тестов/диагностики.

(function () {
  var Api: any = {};
  Api.resolveModelDecision = resolveModelDecision;
  if (typeof window !== 'undefined') {
    (window as any).AiCmContentModel = Api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
  }
})();
