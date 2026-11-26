/**
 * core/content-resync.ts — 2.4 Stage 2: чистое решение ресинка метрик после
 * deferred-флаша истории.
 *
 * Classic-скрипт manifest.content_scripts[0].js ПЕРЕД core/content.ts: общий
 * лексический скоуп. Модуль не читает DOM/chrome/состояние: counts, длины и
 * ключи приходят явными входами. Обёртка `aiCmResyncMetricsAfterFlush` в
 * content.ts собирает финальный срез, зовёт решение и применяет state-записи.
 *
 * Правила v95/v96/v1.9 сохранены:
 *   - финальный срез не может быть короче принятой базы (shrink);
 *   - при том же числе сообщений длина не должна падать (shrink-length, MCP);
 *   - пропуск только при неизменных histKey И сыром сетевом счётчике;
 *   - выросший сырой счётчик при том же histKey снимает ключ (resync-raw).
 */

interface AiCmResyncDecisionInput {
  /** Число сообщений в финальном срезе. */
  finalCount: number;
  /** Число сообщений уже принятой базы. */
  previousCount: number;
  /** Длина канонического текста финального среза. */
  finalLength: number;
  /** Длина уже принятой базы. */
  previousLength: number;
  /** histKey финального среза (count|length). */
  newKey: string;
  /** histKey последней записи истории (null — ключ снят). */
  lastHistoryWroteKey: string | null;
  /** Сырой счётчик сети известен (в срез-песочницах — false). */
  rawKnown: boolean;
  /** Сырой счётчик сети текущего снимка. */
  rawCount: number;
  /** Сырой счётчик сети, уже принятый прошлым срезом. */
  previousRawCount: number;
}

interface AiCmResyncDecision {
  /** Сырой сетевой счётчик не изменился (или неизвестен). */
  rawUnchanged: boolean;
  /** Финальный срез короче базы — не принимать. */
  shrinkCount: boolean;
  /** То же число сообщений, но текст короче — не принимать. */
  shrinkLength: boolean;
  /** Срез уже финальный: histKey и сырой счётчик совпали. */
  canSkip: boolean;
  /** histKey совпал с последней записью (для снятия ключа при resync-raw). */
  keyRepeated: boolean;
  /** Вердикт для o22-metrics-resync (как в живом коде). */
  verdict: 'shrink' | 'shrink-length' | 'skip' | 'resync' | 'resync-raw';
}

/** Чистое решение: принимать ли финальный срез и что писать в историю. */
function resolveResyncDecision(input: AiCmResyncDecisionInput): AiCmResyncDecision {
  var rawUnchanged = !input.rawKnown || (input.rawCount === input.previousRawCount);
  var shrinkCount = input.finalCount < input.previousCount;
  var sameCount = (input.finalCount === input.previousCount);
  var shrinkLength = input.previousLength > 0 && input.finalLength < input.previousLength;
  var canSkip = sameCount && (input.newKey === input.lastHistoryWroteKey) && rawUnchanged;
  var keyRepeated = (input.newKey === input.lastHistoryWroteKey);
  var verdict: AiCmResyncDecision['verdict'];
  if (shrinkCount) verdict = 'shrink';
  else if (shrinkLength) verdict = 'shrink-length';
  else if (canSkip) verdict = 'skip';
  else if (rawUnchanged) verdict = 'resync';
  else verdict = 'resync-raw';
  return {
    rawUnchanged: rawUnchanged,
    shrinkCount: shrinkCount,
    shrinkLength: shrinkLength,
    canSkip: canSkip,
    keyRepeated: keyRepeated,
    verdict: verdict
  };
}

// Глобальный мост для content.ts и срез-песочниц.
(function () {
  var Api: any = {};
  Api.resolveResyncDecision = resolveResyncDecision;
  if (typeof window !== 'undefined') {
    (window as any).AiCmContentResync = Api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
  }
})();
