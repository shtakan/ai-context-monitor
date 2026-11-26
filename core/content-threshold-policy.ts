/**
 * core/content-threshold-policy.ts — 2.4 Stage 4: чистые предикаты бейджа,
 * проактивного порога и планирования автоэкспорта.
 *
 * Classic-скрипт manifest.content_scripts[0].js ПЕРЕД core/content.ts: общий
 * лексический скоуп. Модуль не читает DOM/chrome/state: флаги приходят явно.
 * Вызовы updateWidget / sendMessage / setTimeout остаются в content.ts и
 * content-autoexport.ts.
 */

interface AiCmBadgePolicyInput {
  badgeSuppressed: boolean;
  baseSeen: boolean;
  adapterBaseSeen: boolean;
  loaderFreeze: boolean;
  badgeHold: boolean;
  byokHeuristicHold: boolean;
  hasWidgetData: boolean;
}

interface AiCmBadgePolicy {
  draw: boolean;
  reason: 'spa-suppress' | 'loader-freeze' | 'badge-hold' | 'byok-hold' | 'no-data' | 'draw';
}

/** Решение ветки отрисовки бейджа: рисовать или держать и почему. */
function resolveBadgePolicy(input: AiCmBadgePolicyInput): AiCmBadgePolicy {
  var badgeSuppressActive = input.badgeSuppressed === true && input.baseSeen !== true && input.adapterBaseSeen !== true;
  if (badgeSuppressActive) return { draw: false, reason: 'spa-suppress' };
  if (input.loaderFreeze === true) return { draw: false, reason: 'loader-freeze' };
  if (input.badgeHold === true) return { draw: false, reason: 'badge-hold' };
  if (input.byokHeuristicHold === true) return { draw: false, reason: 'byok-hold' };
  if (input.hasWidgetData !== true) return { draw: false, reason: 'no-data' };
  return { draw: true, reason: 'draw' };
}

interface AiCmThresholdPolicyInput {
  extensionValid: boolean;
  proactiveEnabled: boolean;
  percentage: number;
}

interface AiCmThresholdPolicy {
  send: boolean;
  reason: 'extension-invalid' | 'proactive-off' | 'invalid-pct' | '';
}

/** Решение sendThresholdPct: отправлять ли pct в SW. */
function resolveThresholdPolicy(input: AiCmThresholdPolicyInput): AiCmThresholdPolicy {
  if (input.extensionValid !== true) return { send: false, reason: 'extension-invalid' };
  if (input.proactiveEnabled !== true) return { send: false, reason: 'proactive-off' };
  if (typeof input.percentage !== 'number' || !(input.percentage >= 0)) return { send: false, reason: 'invalid-pct' };
  return { send: true, reason: '' };
}

interface AiCmAutoExportScheduleInput {
  enabled: boolean;
  percentage: number;
}

interface AiCmAutoExportSchedulePolicy {
  schedule: boolean;
  reason: 'disabled' | 'invalid-pct' | '';
}

/** Решение aiCmScheduleAutoExport: ставить ли debounce-тик. */
function resolveAutoExportSchedulePolicy(input: AiCmAutoExportScheduleInput): AiCmAutoExportSchedulePolicy {
  if (input.enabled !== true) return { schedule: false, reason: 'disabled' };
  if (typeof input.percentage !== 'number' || !isFinite(input.percentage) || input.percentage < 0) {
    return { schedule: false, reason: 'invalid-pct' };
  }
  return { schedule: true, reason: '' };
}

// Глобальный мост для content.ts/content-autoexport.ts и срез-песочниц.
(function () {
  var Api: any = {};
  Api.resolveBadgePolicy = resolveBadgePolicy;
  Api.resolveThresholdPolicy = resolveThresholdPolicy;
  Api.resolveAutoExportSchedulePolicy = resolveAutoExportSchedulePolicy;
  if (typeof window !== 'undefined') {
    (window as any).AiCmContentThresholdPolicy = Api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
  }
})();
