/**
 * utils/export/completeness.ts — единый владелец partial/partialReason файла.
 *
 * S2.3 (ADR-001, I4): частичность в MD/JSON — из того же снимка, что у барьера
 * автоэкспорта. Модуль только нормализует пару:
 *   - snapshot.partial !== true → ключей нет (undefined; JSON.stringify их опустит);
 *   - partial=true + непустая причина → partial=true + причина;
 *   - partial=true без причины → 'incomplete'.
 *
 * Чистый: вход — данные, выход — данные; DOM/storage/снимок не читает.
 */

export type PartialReason =
  | 'incomplete'
  | 'stale'
  | 'shrank'
  | 'missing-user-text'
  | 'stopped'
  | 'truncated'
  | 'history-not-finalized';

/** Минимальная форма читателя снимка (AiCmContextSnapshot совместима). */
export interface PartialSource {
  partial?: boolean;
  partialReason?: string | null;
}

export interface PartialView {
  partial?: true;
  partialReason?: PartialReason;
}

/** Словарь причин — единственное место, где он перечислен для рендера. */
export const PARTIAL_REASONS: PartialReason[] = [
  'incomplete',
  'stale',
  'shrank',
  'missing-user-text',
  'stopped',
  'truncated',
  'history-not-finalized'
];

/**
 * Нормализует partial-пару снимка. Неизвестная непустая причина сохраняется
 * как есть (байтовый паритет со старым `(reason) || 'incomplete'`), пустая —
 * 'incomplete'. Не мутирует вход.
 */
export function derivePartial(source: PartialSource | null | undefined): PartialView {
  if (!source || source.partial !== true) {
    return { partial: undefined, partialReason: undefined };
  }
  const raw = (typeof source.partialReason === 'string') ? source.partialReason.trim() : '';
  return {
    partial: true,
    partialReason: (raw || 'incomplete') as PartialReason
  };
}
