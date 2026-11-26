/**
 * core/content-model.ts — 2.4 Stage 1: чистое решение «какая модель текущего чата».
 *
 * Classic-скрипт manifest.content_scripts[0].js ПЕРЕД core/content.ts: общий
 * лексический скоуп. Модуль НЕ читает DOM, chrome, ModelConfig и глобальное
 * состояние: все сигналы и резолверы приходят явными входами. Обёртка
 * `resolveCurrentModel()` в content.ts собирает сигналы (попап → DOM(UI) → сеть),
 * зовёт это решение и применяет побочные эффекты (lastSnapshotModelName, логи).
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

// UMD/глобальный мост для content.ts и срез-песочниц: функция остаётся в общем
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
