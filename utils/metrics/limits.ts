/**
 * metrics/limits — LimitModel без DOM/storage.
 *
 * Три факта разделены (I9): окно модели, порог показа и лимит плана. Старый
 * путь склеивал их в одно число (128 000 вместо окна 1M), поэтому фаза 2
 * ввела явную модель лимитов, а фаза 5 — каталог платформ/планов.
 *
 * Приоритет источников: API → каталог → настройки → fallback.
 *  - окно модели: API > исключение каталога > значение реестра моделей > площадка;
 *  - лимит плана: API > тариф каталога > null;
 *  - порог показа: ручной (settings) > min(окно, лимит) > порог площадки >
 *    окно > fallback. Порог площадки — это НЕ окно и НЕ лимит аккаунта.
 *
 * `provenance` различает «неизвестно» (`null`) и «подставлен fallback»:
 * это разные факты, и UI не имеет права показывать второй как первый.
 */

import type { LimitModel, LimitSource } from '../../types/metrics';
import { lookupLimitCatalog } from './limit-catalog';
import type { LimitCatalogHit } from './limit-catalog';

export type { LimitSource } from '../../types/metrics';

export interface LimitProbe {
  /** Площадка (site id или хост) — для каталога платформ/планов. */
  site?: string | null;
  modelId?: string;

  /** Окно модели в токенах (API/каталог), например AI Studio 1 048 576. */
  modelWindow?: number;
  /** Откуда взято окно; отсутствие источника у непустого значения = 'catalog'. */
  windowSource?: LimitSource;

  /** Лимит плана, если платформа его сообщает. null/undefined — неизвестен. */
  accountLimit?: number | null;
  /** Откуда взят лимит плана; по умолчанию — API. */
  accountSource?: LimitSource;

  /**
   * Порог показа. `settings`/`api` — авторитетный факт; `fallback`/`catalog` —
   * запасной, который не блокирует тарифный лимит каталога.
   */
  displayLimit?: number | null;
  /** Откуда взят порог; по умолчанию — настройки. */
  displaySource?: LimitSource;

  plan?: string | null;
  /** Откуда узнали тариф; по умолчанию — API/runtime-сигнал. */
  planSource?: LimitSource;

  /** Запасной порог, если окно/план/ручной порог неизвестны. */
  fallbackLimit?: number;
}

function positiveInt(value: unknown): number {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

function pushSource(list: LimitSource[], source: LimitSource | null | undefined): void {
  if (!source) return;
  if (list.indexOf(source) === -1) list.push(source);
}

/**
 * Собирает LimitModel. Никогда не бросает и не читает состояние.
 *
 * displayLimit собирается по приоритету: ручной/API-порог → min(окно, лимит)
 * → порог площадки (128k у Gemini/GSA) → окно → fallback. Legacy-порог с
 * source=fallback НЕ блокирует тариф каталога: иначе 128k заслонит 32K Free.
 */
export function resolveLimitModel(probe: LimitProbe | null | undefined): LimitModel {
  const input = probe || {};
  const hit: LimitCatalogHit = lookupLimitCatalog({
    site: input.site,
    plan: input.plan,
    modelId: input.modelId
  });

  const probeWindow = positiveInt(input.modelWindow);
  const probeWindowSource: LimitSource = input.windowSource || 'catalog';
  const apiWindow = (probeWindow > 0 && probeWindowSource === 'api') ? probeWindow : 0;
  const usableProbeWindow = (probeWindow > 0 && probeWindowSource !== 'fallback') ? probeWindow : 0;
  const catalogModelWindow = positiveInt(hit.modelWindow);
  const catalogSiteWindow = positiveInt(hit.siteWindow);

  let modelWindow = 0;
  let windowSource: LimitSource | null = null;
  if (apiWindow > 0) {
    modelWindow = apiWindow;
    windowSource = 'api';
  } else if (catalogModelWindow > 0) {
    modelWindow = catalogModelWindow;
    windowSource = 'catalog';
  } else if (usableProbeWindow > 0) {
    modelWindow = usableProbeWindow;
    windowSource = probeWindowSource;
  } else if (catalogSiteWindow > 0) {
    modelWindow = catalogSiteWindow;
    windowSource = 'catalog';
  }

  const probeAccount = positiveInt(input.accountLimit);
  const probeAccountSource: LimitSource = input.accountSource || 'api';
  const usableProbeAccount = (probeAccount > 0 && probeAccountSource !== 'fallback') ? probeAccount : 0;
  const catalogAccount = hit.found.plan ? positiveInt(hit.accountLimit) : 0;

  let accountLimit = 0;
  let accountSource: LimitSource | null = null;
  if (usableProbeAccount > 0) {
    accountLimit = usableProbeAccount;
    accountSource = probeAccountSource;
  } else if (catalogAccount > 0) {
    accountLimit = catalogAccount;
    accountSource = 'catalog';
  }

  // Тариф приходит runtime-сигналом (API/DOM); каталог даёт только его лимит.
  const plan = hit.plan;
  const planSource: LimitSource | null = plan ? (input.planSource || 'api') : null;

  const explicitDisplay = positiveInt(input.displayLimit);
  const displaySourceInput: LimitSource = input.displaySource || 'settings';
  const fallback = positiveInt(input.fallbackLimit);

  // Ручной порог и API-порог — факты платформы/пользователя, они главнее.
  // Legacy-порог с source=fallback/catalog НЕ блокирует тариф каталога:
  // иначе 128k навсегда заслонит лимит Gemini Free 32K.
  const manualDisplay = (explicitDisplay > 0 && displaySourceInput === 'settings') ? explicitDisplay : 0;
  const apiDisplay = (explicitDisplay > 0 && displaySourceInput === 'api') ? explicitDisplay : 0;
  const callerCatalogDisplay = (explicitDisplay > 0 && displaySourceInput === 'catalog') ? explicitDisplay : 0;
  const callerFallbackDisplay = (explicitDisplay > 0 && displaySourceInput === 'fallback') ? explicitDisplay : 0;

  let displayLimit = 0;
  let displaySource: LimitSource | null = null;
  if (manualDisplay > 0) {
    displayLimit = manualDisplay;
    displaySource = 'settings';
  } else if (apiDisplay > 0) {
    displayLimit = apiDisplay;
    displaySource = 'api';
  } else if (modelWindow > 0 && accountLimit > 0) {
    displayLimit = Math.min(modelWindow, accountLimit);
    displaySource = (accountLimit <= modelWindow ? accountSource : windowSource) || 'catalog';
  } else if (hit.displayThreshold > 0) {
    // Порог площадки не выдаёт себя за окно: у Gemini/GSA это 128k при окне 1M.
    // Но порог не может быть больше окна: у GPT-4 (8K) действует 8K, а не 128K.
    displayLimit = (modelWindow > 0) ? Math.min(modelWindow, hit.displayThreshold) : hit.displayThreshold;
    displaySource = 'catalog';
  } else if (callerCatalogDisplay > 0) {
    displayLimit = (modelWindow > 0) ? Math.min(modelWindow, callerCatalogDisplay) : callerCatalogDisplay;
    displaySource = 'catalog';
  } else if (modelWindow > 0) {
    displayLimit = modelWindow;
    displaySource = windowSource;
  } else if (callerFallbackDisplay > 0) {
    displayLimit = callerFallbackDisplay;
    displaySource = 'fallback';
  } else if (fallback > 0) {
    displayLimit = fallback;
    displaySource = 'fallback';
  }

  // Совместимость с прежним контрактом: при полном отсутствии окна видимый
  // порог остаётся числом, но provenance/windowKnown честно говорят, что это
  // не окно модели.
  const windowKnown = modelWindow > 0;
  const modelWindowOut = windowKnown ? modelWindow : displayLimit;

  const sources: LimitSource[] = [];
  if (windowSource) pushSource(sources, windowSource);
  if (accountSource) pushSource(sources, accountSource);
  if (displaySource) pushSource(sources, displaySource);
  if (sources.length === 0 && fallback > 0) pushSource(sources, 'fallback');

  const warnings: string[] = [];
  if (!windowKnown) warnings.push('window-unknown');
  if (displaySource === 'fallback') warnings.push('fallback-display');
  if (hit.hasPlans && !plan) warnings.push('plan-unknown');
  if (!accountLimit) warnings.push('account-limit-unknown');

  return {
    modelId: (typeof input.modelId === 'string' && input.modelId) ? input.modelId : undefined,
    modelWindow: modelWindowOut,
    windowKnown: windowKnown,
    displayLimit: displayLimit,
    accountLimit: accountLimit > 0 ? accountLimit : null,
    plan: plan,
    sources: sources,
    provenance: {
      modelWindow: windowSource,
      displayLimit: displaySource,
      accountLimit: accountSource,
      plan: planSource
    },
    warnings: warnings,
    sourceNote: hit.note || undefined
  };
}
