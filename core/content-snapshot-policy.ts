/**
 * core/content-snapshot-policy.ts — 2.4 Stage 3: чистое решение снимка метрики.
 *
 * Classic-скрипт manifest.content_scripts[0].js ПЕРЕД core/content.ts: общий
 * лексический скоуп. Модуль не читает DOM/chrome/состояние: tokenSnap,
 * limitModel и callbacks приходят явными входами. Обёртка processAndSend
 * собирает fullText/count, зовёт tokenSnapshot/resolveLimitModel, применяет
 * решение и пишет снимок/бейдж.
 *
 * Сохранены правила 2.2/2.3:
 *   - tokens = tokenSnap.tokens; serverTokens = tokenSnap.serverTokens;
 *   - src = baseSource || (baseComplete ? 'net' : 'dom'), server > 0 → 'server';
 *   - contextLimit = windowKnown ? modelWindow : 0;
 *   - displayLimit = applyLimitPct(effectiveLimit, activePct);
 *   - percentage = tokens/displayLimit; saturated → snapshotPercentage 100.
 */

interface AiCmSnapshotPolicyInput {
  tokenSnap: { tokens: number; serverTokens: number };
  limitModel: {
    windowKnown: boolean;
    modelWindow: number;
    displayLimit: number;
    accountLimit?: unknown;
    plan?: unknown;
    warnings?: unknown;
  };
  /** Источник базы: net/dom/server/''. */
  baseSource: string;
  /** Полнота сетевой базы. */
  baseComplete: boolean;
  /** Платформа сообщила «контекст заполнен». */
  contextSaturated: boolean;
  /** Ручной порог в % от Авто (null — не задан). */
  activePct: number | null;
  /** Прошлый опубликованный процент. */
  lastPercentage: number;
  /** ModelConfig.applyLimitPct — чистая функция порога. */
  applyLimitPct: (limit: number, pct: number | null) => number;
}

interface AiCmSnapshotPolicy {
  /** Текущая оценка токенов (точное серверное число уже внутри tokenSnap). */
  tokenEstimate: number;
  /** Серверный счётчик, вошедший в метрику. */
  metricServerTokens: number;
  /** Источник числа для diag/шапки: net|dom|server. */
  metricValueSrc: string;
  /** Настоящее окно модели (0 — неизвестно). */
  contextLimit: number;
  /** display-limit до ручного порога. */
  effectiveLimit: number;
  /** Итоговый порог показа (после applyLimitPct). */
  displayLimit: number;
  /** Процент до платформенного saturated. */
  percentage: number;
  /** Опубликованный процент (saturated → 100). */
  snapshotPercentage: number;
  /** Процент изменился относительно прошлого. */
  hasChanged: boolean;
}

/** Чистое решение метрики; побочные эффекты — в processAndSend. */
function resolveSnapshotPolicy(input: AiCmSnapshotPolicyInput): AiCmSnapshotPolicy {
  var tokenEstimate = input.tokenSnap.tokens;
  var metricServerTokens = input.tokenSnap.serverTokens || 0;
  var metricValueSrc = (input.baseSource && input.baseSource)
    ? input.baseSource
    : (input.baseComplete ? 'net' : 'dom');
  // S4: точное серверное число авторитетно для источника (и для шапки файла).
  if (metricServerTokens > 0) metricValueSrc = 'server';
  var contextLimit = input.limitModel.windowKnown ? input.limitModel.modelWindow : 0;
  var effectiveLimit = input.limitModel.displayLimit;
  var displayLimit = input.applyLimitPct(effectiveLimit, input.activePct);
  var percentage = displayLimit > 0
    ? Math.round((tokenEstimate / displayLimit) * 1000) / 10
    : 0;
  // BIG-02: баннер платформы «контекст заполнен» → 100 %, токены остаются измеренными.
  var snapshotPercentage = input.contextSaturated ? 100 : percentage;
  return {
    tokenEstimate: tokenEstimate,
    metricServerTokens: metricServerTokens,
    metricValueSrc: metricValueSrc,
    contextLimit: contextLimit,
    effectiveLimit: effectiveLimit,
    displayLimit: displayLimit,
    percentage: percentage,
    snapshotPercentage: snapshotPercentage,
    hasChanged: snapshotPercentage !== input.lastPercentage
  };
}

// Глобальный мост для content.ts и срез-песочниц.
(function () {
  var Api: any = {};
  Api.resolveSnapshotPolicy = resolveSnapshotPolicy;
  if (typeof window !== 'undefined') {
    (window as any).AiCmContentSnapshotPolicy = Api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
  }
})();
