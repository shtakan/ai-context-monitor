/**
 * metrics/limit-catalog — каталог лимитов по платформам и планам (2.2, фаза 5).
 *
 * Каталог держит ТОЛЬКО то, что нельзя вывести из уже снятой модели:
 *  - окно модели-исключения (когда реестр моделей хранит тарифное значение);
 *  - лимит тарифа (accountLimit), если платформа его публикует;
 *  - порог показа площадки (displayThreshold) — это НЕ окно и НЕ лимит плана.
 *
 * Источник истины по окнам обычных моделей остаётся `utils/model-config.ts`:
 * дублировать 140 записей в каталог нельзя, иначе значения разъедутся. Сюда
 * попадают только подтверждённые исключения и плановые лимиты.
 *
 * Модуль чистый: без DOM/storage/chrome. Побочные эффекты — в core/content.ts.
 */

/** Правило тарифа: лимит контекста, который платформа даёт этому плану. */
export interface LimitPlanRule {
  /** Лимит плана в токенах; null — тариф известен, но число не подтверждено. */
  accountLimit: number | null;
  /** Откуда число (для диагностики и файла). */
  note?: string;
}

/** Исключение по модели: окно и/или собственный порог показа. */
export interface LimitModelRule {
  /** Окно модели, если реестр хранит тарифное значение; не задано — из реестра. */
  modelWindow?: number;
  /**
   * Порог показа модели. `0` — не применять порог площадки (считать от окна).
   * Не задан — действует порог площадки.
   */
  displayThreshold?: number;
  note?: string;
}

/** Правило площадки: окно по умолчанию, порог показа и тарифы. */
export interface LimitSiteRule {
  /** Окно модели по умолчанию, когда конкретная модель неизвестна; 0 — нет данных. */
  modelWindow?: number;
  /** Порог показа по умолчанию — не окно модели и не лимит аккаунта. */
  displayThreshold?: number;
  /** Тарифы площадки: канонический plan id → лимит. */
  plans?: Record<string, LimitPlanRule>;
  /** Исключения по моделям: канонический model id → окно. */
  models?: Record<string, LimitModelRule>;
  /** Человекочитаемая пометка площадки. */
  note?: string;
}

/** Каталог: site id → правило площадки. */
export type LimitCatalog = Record<string, LimitSiteRule>;

/** Запрос к каталогу. Все поля необязательны: неизвестное — это факт. */
export interface LimitCatalogQuery {
  site?: string | null;
  plan?: string | null;
  modelId?: string | null;
}

/** Результат поиска: что именно нашлось, а что осталось неизвестным. */
export interface LimitCatalogHit {
  /** Канонический site id или null. */
  site: string | null;
  /** Канонический plan id или null. */
  plan: string | null;
  /** Окно конкретной модели-исключения; 0 — исключения нет. */
  modelWindow: number;
  /** Окно площадки по умолчанию; 0 — неизвестно. */
  siteWindow: number;
  /** Лимит плана в токенах; null — неизвестен. */
  accountLimit: number | null;
  /** Порог показа площадки в токенах; 0 — не задан. */
  displayThreshold: number;
  /** Какие части каталога реально сработали. */
  found: {
    site: boolean;
    plan: boolean;
    model: boolean;
  };
  /** У площадки есть таблица тарифов (значит «тариф не определён» — важный факт). */
  hasPlans: boolean;
  /** Пометка площадки/тарифа/модели для диагностики. */
  note: string;
}

/** Псевдонимы хостов и коротких имён площадок. */
const SITE_ALIASES: Record<string, string> = {
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'gemini.google.com': 'gemini',
  'aistudio.google.com': 'aistudio',
  'aistudio': 'aistudio',
  'ai-studio': 'aistudio',
  'google_search': 'google_search',
  'google-search': 'google_search',
  'gsa': 'google_search',
  'chat.qwen.ai': 'qwen',
  'qwen.ai': 'qwen',
  'chat.deepseek.com': 'deepseek',
  'deepseek.com': 'deepseek',
  'claude.ai': 'claude',
  'www.perplexity.ai': 'perplexity',
  'perplexity.ai': 'perplexity'
};

/**
 * Каталог подтверждённых лимитов. Числа без источника в репозитории сюда
 * не добавляются: лучше null + warning, чем красивая, но выдуманная цифра.
 *
 * Gemini: окно веба зависит от тарифа (32K Free / 128K AI Plus / 1M AI Pro),
 * API-окно всех 3.x-моделей — 1 048 576. Поэтому 128 000 у 3.1 Pro — это
 * тариф AI Plus, а не окно модели.
 */
export const LIMIT_CATALOG: LimitCatalog = {
  gemini: {
    modelWindow: 1048576,
    displayThreshold: 128000,
    note: 'Gemini web: API-окно 1 048 576; окно веба зависит от тарифа',
    plans: {
      free: { accountLimit: 32768, note: 'Gemini web Free: 32K' },
      'ai-plus': { accountLimit: 128000, note: 'Gemini web AI Plus: 128K' },
      'ai-pro': { accountLimit: 1048576, note: 'Gemini web AI Pro: 1M' },
      ultra: { accountLimit: 1048576, note: 'Gemini web Ultra: 1M' }
    },
    models: {
      'gemini-3.1-pro': {
        modelWindow: 1048576,
        note: 'API-окно 1M; веб-окно задаёт тариф, а не модель'
      }
    }
  },
  google_search: {
    modelWindow: 1048576,
    displayThreshold: 128000,
    note: 'Google Search AI: окно модели-прокси 1 048 576; лимит аккаунта не публикуется'
  },
  aistudio: {
    modelWindow: 1048576,
    displayThreshold: 128000,
    note: 'AI Studio: окно из API; лимит аккаунта не публикуется'
  },
  qwen: {
    displayThreshold: 128000,
    note: 'Qwen: окно 1M у qwen3.7-plus/qwen3.8-max; тарифный лимит не публикуется',
    models: {
      'qwen3.7-plus': { modelWindow: 1000000, displayThreshold: 0, note: 'окно 1M — считать от окна' },
      'qwen3.8-max': { modelWindow: 1000000, displayThreshold: 0, note: 'окно 1M — считать от окна' }
    }
  },
  deepseek: {
    displayThreshold: 128000,
    note: 'DeepSeek: окна по моделям; тарифный лимит не публикуется',
    models: {
      'deepseek-v4-pro': { modelWindow: 1000000, displayThreshold: 0 },
      'deepseek-flash': { modelWindow: 1000000, displayThreshold: 0 },
      'deepseek-v4.1-flash': { modelWindow: 1000000, displayThreshold: 0 },
      'deepseek-v3': { modelWindow: 128000 },
      'deepseek-r1': { modelWindow: 128000 }
    }
  },
  claude: {
    displayThreshold: 128000,
    note: 'Claude: окна по моделям; лимит тарифа Free не проверен',
    models: {
      // capExempt-модели веб-чата: текущий бейдж считает от окна, а не от 128K.
      'claude-sonnet-5-5': { displayThreshold: 0 },
      'claude-opus-5-5': { displayThreshold: 0 },
      'claude-fable-5-1': { displayThreshold: 0 },
      'claude-opus-5': { displayThreshold: 0 },
      'claude-opus-4-8': { displayThreshold: 0 },
      'claude-opus-4-7': { displayThreshold: 0 },
      'claude-sonnet-5': { displayThreshold: 0 },
      'claude-sonnet-4-6': { displayThreshold: 0 },
      'claude-opus-4-6': { displayThreshold: 0 },
      'claude-haiku-5-5': { displayThreshold: 0 }
    }
  },
  chatgpt: {
    displayThreshold: 128000,
    note: 'ChatGPT web: окно не документировано; баннер «контекст заполнен» — runtime-сигнал'
  },
  perplexity: {
    displayThreshold: 128000,
    note: 'Perplexity: квота поиска не равна контексту; лимит аккаунта не публикуется'
  }
};

/**
 * Канонический id площадки по хосту, короткому имени или URL.
 * Неизвестное значение возвращается нормализованной строкой, а не теряется.
 */
export function normalizeLimitSite(site: unknown): string | null {
  if (typeof site !== 'string') return null;
  let value = site.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split('/')[0].split('?')[0].split(':')[0];
  const alias = SITE_ALIASES[value];
  return alias || (value || null);
}

/**
 * Канонический id тарифа. Для Gemini «plus»/«pro» — это AI Plus/AI Pro,
 * для остальных площадок значения остаются как есть.
 */
export function normalizeLimitPlan(plan: unknown, site?: string | null): string | null {
  if (typeof plan !== 'string') return null;
  const value = plan.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!value) return null;
  const normalizedSite = normalizeLimitSite(site);
  if (normalizedSite === 'gemini') {
    if (value === 'plus' || value === 'aiplus' || value === 'google-ai-plus') return 'ai-plus';
    if (value === 'pro' || value === 'aipro' || value === 'advanced' || value === 'google-ai-pro') return 'ai-pro';
  }
  return value;
}

function positiveInt(value: unknown): number {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

function noteJoin(parts: Array<string | undefined>): string {
  return parts.filter(function (part) { return !!part; }).join('; ');
}

/**
 * Ищет площадку, тариф и модель в каталоге. Никогда не бросает и не мутирует
 * каталог. `found.site` означает, что площадка есть в каталоге, а не что
 * все её поля известны.
 */
export function lookupLimitCatalog(query: LimitCatalogQuery | null | undefined): LimitCatalogHit {
  const input = query || {};
  const site = normalizeLimitSite(input.site);
  const plan = normalizeLimitPlan(input.plan, site);
  const modelId = (typeof input.modelId === 'string' && input.modelId.trim())
    ? input.modelId.trim() : null;

  const siteRule = (site && LIMIT_CATALOG[site]) ? LIMIT_CATALOG[site] : null;
  const planRule = (siteRule && plan && siteRule.plans && siteRule.plans[plan])
    ? siteRule.plans[plan] : null;
  const modelRule = (siteRule && modelId && siteRule.models && siteRule.models[modelId])
    ? siteRule.models[modelId] : null;

  const modelThreshold = (modelRule && typeof modelRule.displayThreshold === 'number')
    ? positiveInt(modelRule.displayThreshold)
    : null;
  const displayThreshold = (modelThreshold !== null)
    ? modelThreshold
    : (siteRule ? positiveInt(siteRule.displayThreshold) : 0);

  return {
    site: site,
    plan: plan,
    modelWindow: modelRule ? positiveInt(modelRule.modelWindow) : 0,
    siteWindow: siteRule ? positiveInt(siteRule.modelWindow) : 0,
    accountLimit: planRule ? (positiveInt(planRule.accountLimit) || null) : null,
    displayThreshold: displayThreshold,
    found: {
      site: !!siteRule,
      plan: !!planRule,
      model: !!modelRule
    },
    hasPlans: !!(siteRule && siteRule.plans && Object.keys(siteRule.plans).length > 0),
    note: noteJoin([
      siteRule ? siteRule.note : undefined,
      planRule ? planRule.note : undefined,
      modelRule ? modelRule.note : undefined
    ])
  };
}
