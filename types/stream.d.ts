/**
 * Типы stream-analyzer-каркаса (utils/stream-frames.ts, O-35).
 *
 * Модуль самодостаточен: импортов нет. Формы выведены из фактических функций
 * frames()/normalizeUsage()/mergeUsage(); это декларации, рантайм не меняется.
 */

/**
 * Один кадр потока (frames/framesManual).
 *
 * SSE-ветка отдаёт { event, data }, где event — значение 'event:' либо null,
 * если строка 'data:' пришла без предшествующего event (utils/stream-frames.ts:199-209).
 * Не-SSE-ветка отдаёт кадры без поля event (только { data }): тело копится
 * целиком, затем JSON-массив разбивается на элементы либо склейка {...}{...}
 * режется splitJsonObjects (utils/stream-frames.ts:176-186). Поэтому event
 * опционален, а не обязателен.
 */
export interface StreamFrame {
  /** Имя SSE-события; null/undefined — событие не было задано. */
  event?: string | null;

  /** Сырые данные кадра (строка JSON/текст), '[DONE]' здесь НЕ фильтруется. */
  data: string;
}

/**
 * Нормализованный usage (normalizeUsage, utils/stream-frames.ts:350-363).
 *
 * Единая форма для провайдеров: input/output/total/reasoning/cached.
 * Каждое поле — number | null: null означает «провайдер не дал число»
 * (num() возвращает null, а не 0, чтобы не подменять отсутствие нулём).
 */
export interface Usage {
  /** Входные токены: input_tokens | prompt_tokens | promptTokenCount. */
  input: number | null;

  /** Выходные токены: output_tokens | completion_tokens | candidatesTokenCount. */
  output: number | null;

  /** Всего: total_tokens | totalTokenCount. */
  total: number | null;

  /** Токены рассуждения: *_details.reasoning_tokens | thoughtsTokenCount. */
  reasoning: number | null;

  /** Кэшированные входные: prompt_tokens_details.cached_tokens | cache_read_input_tokens | cachedContentTokenCount. */
  cached: number | null;
}

/**
 * utils/stream-frames.ts — ESM-модуль (Roadmap Ph2). Типы экспортов выводятся
 * из JSDoc самого модуля (tsconfig: allowJs + checkJs); здесь — только контракт
 * вызывающего: frames(res) читает Response-подобный поток и отдаёт кадры,
 * normalizeUsage/mergeUsage нормализуют и сливают usage.
 */
export interface StreamFramesModule {
  frames(res: {
    headers?: { get(name: string): string | null } | null;
    body?: { getReader(): { read(): Promise<{ done: boolean; value?: unknown }> } } | null;
  } | null): AsyncGenerator<StreamFrame, void, unknown>;

  /** Нормализация usage провайдера; null — usage не объект. */
  normalizeUsage(u: unknown): Usage | null;

  /**
   * Слияние usage: cumulative === true → перезапись (Qwen отдаёт кумулятив),
   * иначе — сумма полей; null-поля next не затирают собранное.
   */
  mergeUsage(prev: Usage | null, next: Partial<Usage> | null, cumulative?: boolean): Usage | null;

  /** Эталон паритета: ручной pull-итератор кадров (не рантайм-фолбэк). */
  framesManual(res: unknown): AsyncIterator<StreamFrame, void, unknown>;

  /** Режет склейку {...}{...} на отдельные JSON-объекты. */
  splitJsonObjects(s: string | null | undefined): string[];
}
