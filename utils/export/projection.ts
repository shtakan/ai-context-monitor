/**
 * utils/export/projection.ts — проекция канонического массива в массив файла.
 *
 * Реализация ARCHITECTURE-2.2 §4/§5 (S5.1, I3): одна чистая функция на ручной и
 * авто-путь (обычный/union). Снимок/метрика сюда не входят — на входе только
 * сообщения файла. Канонический массив уже несёт reasoning-секции в text;
 * здесь только:
 *   - копии сообщений (вход не мутируется);
 *   - при эффективном OFF — удаление поля reasoning у копий;
 *   - единственная точка санации (передаётся хуком, без DOM/storage внутри);
 *   - mode='projected' только при фактическом изменении (длина или любое поле),
 *     иначе тот же массив и mode=''.
 *
 * Шов не импортирует конвейер/сборщики: зависимости приходят хуками, поэтому
 * модуль тестируется без new Function-песочниц.
 */

import type { ExportMessage } from '../../types/export';

export interface ProjectionHooks {
  /** Пользовательский тумблер; используется, если hiddenEffective не передан. */
  includeHidden?: boolean;
  /** Эффективный режим (qwen/deepseek force-exclude и т.п.) по копиям. */
  hiddenEffective?: ((copies: ExportMessage[]) => boolean) | null;
  /** Единственная точка санации (aiCmSanitizeEmitUserTexts) или null. */
  sanitize?: ((messages: ExportMessage[]) => ExportMessage[]) | null;
}

export interface ProjectionResult {
  messages: ExportMessage[];
  mode: '' | 'projected';
}

function sameField(a: unknown, b: unknown): boolean {
  const sa = (typeof a === 'string') ? a : JSON.stringify(a === undefined ? null : a);
  const sb = (typeof b === 'string') ? b : JSON.stringify(b === undefined ? null : b);
  return sa === sb;
}

/**
 * Проецирует сообщения файла. Не бросает на мусорном входе: не-массив → пустой.
 */
export function projectFileMessages(
  msgs: ExportMessage[] | null | undefined,
  hooks?: ProjectionHooks | null
): ProjectionResult {
  const src = Array.isArray(msgs) ? msgs : [];
  const copies: ExportMessage[] = [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i];
    copies.push((m && typeof m === 'object') ? Object.assign({}, m) : m);
  }
  const h = hooks || {};
  const hiddenEffective = (typeof h.hiddenEffective === 'function')
    ? (h.hiddenEffective(copies) === true)
    : (h.includeHidden === true);
  if (!hiddenEffective) {
    for (let r = 0; r < copies.length; r++) {
      if (copies[r] && typeof copies[r] === 'object') delete copies[r].reasoning;
    }
  }
  let out = (typeof h.sanitize === 'function') ? h.sanitize(copies) : copies;
  if (!Array.isArray(out)) out = copies;

  let changed = (out.length !== src.length);
  if (!changed) {
    for (let j = 0; j < src.length; j++) {
      const a = src[j] || {};
      const b = out[j] || {};
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) { changed = true; break; }
      for (let k = 0; k < ka.length; k++) {
        const f = ka[k];
        if (!sameField((a as Record<string, unknown>)[f], (b as Record<string, unknown>)[f])) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return changed ? { messages: out, mode: 'projected' } : { messages: src, mode: '' };
}

/** UMD/ESM-зеркало для тестов и будущих потребителей (content-бандл). */
export const aiCmProjectFileMessages = projectFileMessages;
