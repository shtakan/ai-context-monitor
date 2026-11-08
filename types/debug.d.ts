/**
 * Типы диагностического слоя (utils/debug.ts).
 *
 * Модуль самодостаточен: импортов нет. Важно: utils/debug.ts — классический
 * скрипт общего лексического скоупа, он НЕ публикует единый объект-API.
 * Поэтому DebugApi ниже описывает ИМЕНА функций диагностического слоя (как они
 * видны в общем скоупе), а не форму одного рантайм-объекта.
 */

/**
 * Сигнатура «мягкого» перехвата: swallow(error, tag) и swallowSoft(error, tag)
 * (utils/debug.ts:85-90, 264-275). Поток управления не меняется — возврат void,
 * исключение не пробрасывается. tag — контекст точки '<domain>:<function>',
 * по умолчанию 'unlabeled'.
 *
 * window.__aiCmSwallow / window.__aiCmSwallowSoft типизируются этим типом
 * (types/globals.d.ts): обе функции — window-зеркала одного контракта.
 */
export type DiagFn = (error: unknown, tag?: string) => void;

/** Уровни debugLog (utils/debug.ts:44-55); warn/error печатаются всегда. */
export type DebugLogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';

/** Поля произвольной диагностической строки (aiCmDiagLine key=value…). */
export type DiagFields = Record<string, unknown>;

/**
 * Диагностический слой utils/debug.ts по фактическим именам функций.
 *
 * Гейт aiCmDiagOn() включён, если sessionStorage 'aiCmDebug' === '1' ИЛИ
 * window.__aiCmDebugLogs === true (utils/debug.ts:106-115). Хелперы aiCmDiag*
 * ничего не пишут в базу/storage/DOM и не меняют байты экспорта.
 */
export interface DebugApi {
  /** Сеттер флага «Подробные логи»; дублирует значение в window.__aiCmDebugLogs. */
  __aiCmSetDebugLogs(v: unknown): void;

  /** Обёртка над console[level]; warn/error — всегда, остальное — под гейтом DEBUG. */
  debugLog(level: DebugLogLevel | string, ...args: unknown[]): void;

  /** Молчаливый catch → диагностируемый: ring + console.error всегда (Step E.2a). */
  swallow: DiagFn;

  /** Канал B: ring всегда, console — только под гейтом, error не эскалируется. */
  swallowSoft: DiagFn;

  /** Гейт инструментирования aiCmDebug (sessionStorage или чекбокс). */
  aiCmDiagOn(): boolean;

  /** Печать строки 'tag key=value…'; false — гейт выключен. */
  aiCmDiagLine(tag: string, fields?: DiagFields): boolean;

  /** Warn-уровень канала B: ring всегда, console.warn только под гейтом. */
  aiCmDiagWarn(tag: string, message?: string, detail?: unknown): void;

  /** Первые n символов одной строкой (пустое — явно '(пусто)'). */
  aiCmDiagHead(v: unknown, n?: number): string;

  /** Верхние кадры стека одной строкой (для точки вызова). */
  aiCmDiagStack(skip?: number): string;

  /** Тип документа для логов сброса: 'captcha' | 'chat' | 'search' | 'unknown'. */
  aiCmDiagDocKind(): string;

  /** Копия ring-буфера текущего мира (≤200 строк). */
  __aiCmGetLogRing(): string[];
}
