/**
 * metrics/limits — LimitModel без DOM/storage.
 *
 * Три факта разделены (I9): окно модели, порог показа и лимит плана. Старый
 * путь склеивал их в одно число (128 000 вместо окна 1M), поэтому фаза 2
 * начинает с явной модели лимитов, не меняя живой расчёт: displayLimit
 * приходит из legacy computeEffectiveLimit как «порог», а не как окно.
 *
 * Приоритет источников: явный displayLimit (ручной порог/legacy cap) →
 * min(modelWindow, accountLimit) → modelWindow → fallback.
 */

import type { LimitModel } from '../../types/metrics';

export type LimitSource = 'api' | 'catalog' | 'settings' | 'fallback';

export interface LimitProbe {
  modelId?: string;
  /** Окно модели в токенах (API/каталог), например AI Studio 1 048 576. */
  modelWindow?: number;
  /** Лимит плана, если платформа его сообщает. null/undefined — неизвестен. */
  accountLimit?: number | null;
  /** Явный порог показа (ручной pct/legacy cap), главнее окна и плана. */
  displayLimit?: number | null;
  plan?: string | null;
  /** Откуда взято окно. */
  windowSource?: LimitSource;
  /** Откуда взят явный порог показа. */
  displaySource?: LimitSource;
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
 * displayLimit НЕ пересчитывается из окна, если передан явно: в 2.2 это
 * сохраняет байтовый паритет со старым порогом (128 000). Разделение
 * «окно 1M / порог 128k» становится видимым в modelWindow/displayLimit.
 */
export function resolveLimitModel(probe: LimitProbe | null | undefined): LimitModel {
  const input = probe || {};
  const modelWindow = positiveInt(input.modelWindow);
  const accountLimit = positiveInt(input.accountLimit);
  const explicitDisplay = positiveInt(input.displayLimit);
  const fallback = positiveInt(input.fallbackLimit);

  let displayLimit = 0;
  if (explicitDisplay > 0) displayLimit = explicitDisplay;
  else if (modelWindow > 0 && accountLimit > 0) displayLimit = Math.min(modelWindow, accountLimit);
  else if (modelWindow > 0) displayLimit = modelWindow;
  else if (fallback > 0) displayLimit = fallback;

  const sources: LimitSource[] = [];
  if (modelWindow > 0) pushSource(sources, input.windowSource || 'catalog');
  else pushSource(sources, 'fallback');
  if (accountLimit > 0) pushSource(sources, 'api');
  if (explicitDisplay > 0) pushSource(sources, input.displaySource || 'settings');

  return {
    modelId: (typeof input.modelId === 'string' && input.modelId) ? input.modelId : undefined,
    modelWindow: modelWindow > 0 ? modelWindow : displayLimit,
    displayLimit: displayLimit,
    accountLimit: accountLimit > 0 ? accountLimit : null,
    plan: (typeof input.plan === 'string' && input.plan) ? input.plan : null,
    sources: sources
  };
}
