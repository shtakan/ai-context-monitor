/**
 * Типы реестра моделей (utils/model-config.js).
 *
 * Модуль самодостаточен: импортов нет. Формы выведены из фактического объекта
 * ModelConfig на HEAD 0f194f9; проверено исполнением require('./utils/model-config.js'):
 * у 140 записей models объединение полей — name, provider, contextLimit,
 * description, capExempt.
 */

/**
 * Запись модели в реестре ModelConfig.models.
 *
 * name/provider/contextLimit — обязательные поля каждой записи;
 * description — человекочитаемое описание (есть у подавляющего большинства,
 * но не гарантировано контрактом); capExempt:true — opt-out из общего потолка
 * EFFECTIVE_CAP_DEFAULT (utils/model-config.js:521-527): действующий лимит
 * становится реальным contextLimit, а не min(contextLimit, 128000).
 */
export interface ModelRecord {
  /** Отображаемое имя модели ('GPT-5.5', 'Gemini 3.6 Flash', …). */
  name: string;

  /** Провайдер ('OpenAI', 'Google', 'DeepSeek', …). */
  provider: string;

  /** Окно контекста модели в токенах. */
  contextLimit: number;

  /** Описание для попапа/диагностики. */
  description?: string;

  /**
   * Запись не режется общим порогом EFFECTIVE_CAP_DEFAULT (128000).
   * Устанавливается только там, где веб-UI реально отдаёт больше.
   */
  capExempt?: boolean;
}

/**
 * Каталог моделей: ключ — канонический id модели, значение — её запись.
 * Соответствует ModelConfig.models (utils/model-config.js:8-473), включая
 * авто-регистрируемые сетевые слаг-и Gemini (utils/model-config.js:588-611).
 */
export type ModelCatalog = Record<string, ModelRecord>;

/**
 * Дефолтная модель по имени сайта: ModelConfig.siteDefaults
 * (utils/model-config.js:474-483), например chatgpt → 'gpt-5.5',
 * gemini → 'gemini-2.5-flash'. Значение — ключ ModelCatalog.
 */
export type SiteDefaults = Record<string, string>;
