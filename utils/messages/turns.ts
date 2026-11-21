/**
 * utils/messages/turns.ts — склейка сегментов одного хода (фаза 3).
 *
 * Gemini batchexecute отдаёт ответ несколькими assistant-сегментами одного
 * хода (thinking/слои). Здесь они склеиваются '\n\n' в один assistant, чтобы
 * 1 ответ = 1 сообщение (BIG-04). Deep Research с РАЗНЫМИ turnId — это разные
 * ходы: сегменты не склеиваются, даже если стоят подряд.
 *
 * Модуль чистый (без DOM/storage) и ESM. Потребитель в MAIN-мире —
 * core/gemini-ingest.js через classic-артефакт utils/messages/turns.js
 * (build.mjs: writeMessagesTurnsClassic); локальный fallback в ingest
 * сохраняет поведение срез-песочниц/старых регистраций.
 */

/** Сегмент хода до склейки. turnId опционален: splitTurnMessages его не отдаёт. */
export interface TurnSegment {
  role?: string;
  text?: string;
  turnId?: string;
}

/** Сообщение после склейки: только role/text, как у прежнего aiCmMergeTurnSegments. */
export interface MergedTurnMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Склеивает подряд идущие сегменты одной роли.
 *
 * turnId-правило: если у обоих сегментов turnId задан и различается — это
 * разные ходы (Deep Research), склейки нет. Если turnId нет хотя бы у одного
 * (обычный Gemini), работает прежнее правило BIG-04.
 *
 * Не-массив/пустой массив возвращается как есть — контракт прежней функции.
 */
export function mergeTurnSegments(
  segs: TurnSegment[] | null | undefined
): MergedTurnMessage[] | TurnSegment[] | null | undefined {
  if (!Array.isArray(segs) || !segs.length) return segs;
  const out: MergedTurnMessage[] = [];
  let lastTurnId = '';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] || {};
    const txt = seg && seg.text ? String(seg.text).trim() : '';
    if (!txt) continue;
    const role: 'user' | 'assistant' = (seg.role === 'user') ? 'user' : 'assistant';
    const segTurnId = (typeof seg.turnId === 'string') ? seg.turnId : '';
    const canMerge = out.length > 0
      && out[out.length - 1].role === role
      && (!lastTurnId || !segTurnId || lastTurnId === segTurnId);
    if (canMerge) {
      out[out.length - 1].text += '\n\n' + txt;
      if (!lastTurnId && segTurnId) lastTurnId = segTurnId;
    } else {
      out.push({ role: role, text: txt });
      lastTurnId = segTurnId;
    }
  }
  return out;
}

/** Имя прежнего потребителя (core/gemini-ingest.js) для classic-артефакта. */
export const aiCmMergeTurnSegments = mergeTurnSegments;
