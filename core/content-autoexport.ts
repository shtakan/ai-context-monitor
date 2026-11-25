/**
 * core/content-autoexport.ts — 2.3 Stage 5: планировщик и доверие базы
 * для автоэкспорта.
 *
 * Classic-скрипт в manifest.content_scripts[0].js ПЕРЕД core/content.ts:
 * общий лексический скоуп. Здесь дебаунс aiCmScheduleAutoExport и предикаты
 * aiCmQwenExportBaseTrusted / aiCmAutoExportTrustedBase / Diag.
 * Точки вызова (processAndSend, слушатель ai-cm-full-history, export-manager)
 * остаются в своих файлах и видят эти функции как глобальные.
 */

// P1: автоэкспорт отвязан от отрисовки бейджа. Раньше maybeAutoExport(percentage)
// вызывался в processAndSend на КАЖДОМ обновлении бейджа — включая транзиентные pct
// во время догрузки базы и скролла. Теперь проверка порога запускается только в точке
// ПРИНЯТИЯ базы (слушатель ai-cm-full-history ниже либо adapter-запись базы) и
// склеивается дебаунсом 500 мс: серия мутаций DOM/эмитов не даёт ложного файра, пока
// база не стабилизировалась. Гейты baseComplete/латча остаются в maybeAutoExport.
var AI_CM_AUTOEXPORT_DEBOUNCE_MS: number = 500;
var autoExportDebounceTimer: ReturnType<typeof setTimeout> | null = null;
var autoExportDebouncePct: number = -1;
var autoExportDebounceCid: string = '';
function aiCmScheduleAutoExport(percentage: number): void {
  try {
    if (!autoExportSettings || autoExportSettings.enabled !== true) return;
    if (typeof percentage !== 'number' || !isFinite(percentage) || percentage < 0) return;
    autoExportDebouncePct = percentage;
    autoExportDebounceCid = (typeof aiCmAutoExportConvId === 'function') ? (aiCmAutoExportConvId() || '') : '';
    if (autoExportDebounceTimer !== null) clearTimeout(autoExportDebounceTimer);
    autoExportDebounceTimer = setTimeout(function () {
      autoExportDebounceTimer = null;
      var pct = autoExportDebouncePct;
      var cid = autoExportDebounceCid;
      autoExportDebouncePct = -1;
      autoExportDebounceCid = '';
      if (typeof pct !== 'number' || pct < 0) return;
      // Пока тикал дебаунс, пользователь мог переключить чат: чужой convId не экспортируем.
      if (cid && typeof aiCmAutoExportConvId === 'function' && (aiCmAutoExportConvId() || '') !== cid) return;
      try {
        maybeAutoExport(pct);
      } catch (eFire) {
        swallowSoft(eFire, 'content:autoexport-debounce');
      }
    }, AI_CM_AUTOEXPORT_DEBOUNCE_MS);
  } catch (eSched) {
    swallowSoft(eSched, 'content:autoexport-schedule');
  }
}

// =============================================================================
// O-36 (D1): достоверность базы для маркировки [LOW CONFIDENCE]_ в РУЧНОМ экспорте.
//
// Симптом (живой прогон qwen, 2026-09-19 19:54): файл
// `[LOW CONFIDENCE]_ai-context-monitor-qwen-Qwen3.8-Max-….txt` при работающей базе
// (`history-write source=adapter msgs=75`, `adapterBaseSeen=1`).
// Корень: база qwen приходит НЕ из сети (O-35/D2: живой источник — DOM-адаптер), а
// `baseComplete` — признак СЕТЕВОЙ полноты (core/state.js:53): у qwen он не взведётся
// никогда, поэтому живой флаг v1.14.1 (`isLowConfidenceBase: baseComplete !== true`)
// давал префикс на КАЖДОМ ручном экспорте. Для сервиса без сети маркировка «база не
// подтверждена» ложна: база подтверждена ЕДИНСТВЕННЫМ доступным источником — записью
// DOM-адаптера (`history-write source=adapter` → adapterBaseSeen=true, O-35/v54).
//
// Правило (узкое, чтобы не тронуть прочие платформы — R1): qwen И база принята
// адаптером для ТЕКУЩЕГО convId (adapterBaseSeen сбрасывается на смене разговора) →
// низкая достоверность НЕ ставится. Прочие сервисы и прежняя семантика 1:1.
// `baseComplete` здесь НЕ подменяется: признак сетевой полноты остаётся своим
// (гейты лоадера/оракула/бейджа читают его по прежнему смыслу).
// =============================================================================
function aiCmQwenExportBaseTrusted(): boolean {
  try {
    return !!((currentAdapter && currentAdapter.siteName === 'qwen') && adapterBaseSeen === true);
  } catch (eQbt) { return false; }
}

// =============================================================================
// O-37 (A): ДОВЕРИЕ БАЗЕ АДАПТЕРА В ГЕЙТЕ АВТОЭКСПОРТА (сервис без сети — qwen).
//
// Симптом (живой лог 21:47:18 / 21:58:03 / 22:03:50 / 22:07:44):
//   [AI CM][diag] auto-export point=maybeAutoExport verdict=skip reason=base-pending
//   site=qwen pct=63.7 baseSeen=0 baseComplete=0 — при пороге 30 файла нет вовсе.
// Корень (ИЗМЕРЕН): гейт O-33 (utils/export-emit-pipeline.ts:shouldSkipAutoExport) требовал
// СЕТЕВОЙ снимок (baseSeen=1), а adapterBaseSeen (единственная точка взвода — запись базы
// путём DOM-адаптера, v54) гейтом не читался: у qwen сети не будет никогда, поэтому
// base-pending возвращался на каждом DRAW и автоэкспорт не срабатывал ни разу. Доверие
// aiCmQwenExportBaseTrusted (O-36/D1) было простёрто только на РУЧНОЙ снимок экспорта.
//
// Правило (узкое, чтобы не тронуть шесть платформ — R1): qwen И база принята адаптером для
// ТЕКУЩЕГО convId (adapterBaseSeen сбрасывается на смене разговора) → база объявляется
// достоверной (O-35: DESIGN-источник qwen — DOM-адаптер), и гейт получает domBaseTrusted=true:
// причина base-pending не возвращается, дальше решают порог и латч fired (повторных файров
// нет). Порядок причин и вердикты прочих сайтов не меняются вовсе (поле в гейт не уходит).
// =============================================================================
function aiCmAutoExportTrustedBase(): boolean {
  try {
    // Правило qwen (O-37/D1): DOM-адаптер — DESIGN-источник, сети у qwen не будет.
    if (currentAdapter && currentAdapter.siteName === 'qwen' && adapterBaseSeen === true) return true;
    // Правило aistudio (v2.0.34, fix base-pending): AI Studio не шлёт ai-cm-full-history,
    // поэтому baseSeen/baseComplete у него всегда false, и все четыре пути «база готова»
    // (baseComplete/baseSeen/gsa-латч/domBaseTrusted) для него закрыты. Полноту знает
    // только сетевой ingest: historyComplete=true. Доверие узкое, как у qwen: база принята
    // адаптером ТЕКУЩЕГО чата И сеть подтвердила полную историю ЭТОГО чата (aiCmNetReadyKey).
    if (currentAdapter && currentAdapter.siteName === 'aistudio' && adapterBaseSeen === true) {
      var cidReady = (typeof aiCmNetReadyKey === 'function') ? (aiCmNetReadyKey() || '') : '';
      return !!cidReady && aiCmNetReadyAistudio[cidReady] === true;
    }
    return false;
  } catch (eAtb) { return false; }
}
// O-37 (A, ДИАГНОСТИКА, только измерение): строка порогового файра по доверенной базе
// адаптера. Печатается РОВНО под гейтом aiCmDebug (aiCmDiagLine) и только когда файр реально
// состоялся на доверенной базе qwen; значения читаются, байты файла не меняются. Гейт
// выключен → ни одной строки. Вызывается из единственной точки старта скачивания
// автоэкспорта (core/export-manager.js) через typeof-гард — в срез-песочницах тестов,
// где хелпера нет, вызова не происходит вовсе (поведение 1:1).
function aiCmAutoExportTrustedBaseDiag(trigger: string, cid: string | null, percentage?: number): boolean {
  try {
    if (typeof aiCmDiagLine !== 'function') return false;
    if (!aiCmAutoExportTrustedBase()) return false;
    var diagSite = (currentAdapter && currentAdapter.siteName) || '';
    var diagNetReady = 0;
    try {
      var diagKey = (diagSite === 'aistudio' && typeof aiCmNetReadyKey === 'function')
        ? (aiCmNetReadyKey() || '') : '';
      diagNetReady = (diagKey && aiCmNetReadyAistudio[diagKey] === true) ? 1 : 0;
    } catch (eAtbNet) { diagNetReady = 0; }
    aiCmDiagLine('auto-export', {
      point: 'maybeAutoExport',
      verdict: 'fire',
      trigger: trigger,
      site: diagSite || 'qwen',
      convId: cid,
      pct: percentage,
      baseSeen: (typeof baseSeen !== 'undefined' && baseSeen === true) ? 1 : 0,
      baseComplete: (typeof baseComplete !== 'undefined' && baseComplete === true) ? 1 : 0,
      adapterBaseSeen: (typeof adapterBaseSeen !== 'undefined' && adapterBaseSeen === true) ? 1 : 0,
      // v2.0.34: наблюдаемость aistudio-фикса — доверие пришло от флага полноты сети,
      // а не от baseSeen/baseComplete (у AI Studio они по дизайну остаются 0).
      domBaseTrusted: 1,
      netReady: diagNetReady
    });
    return true;
  } catch (eAtbd) { return false; }
}
