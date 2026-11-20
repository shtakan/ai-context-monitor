/**
 * utils/messages/canonicalize.ts — шов messages: сырой захват → канонический тред.
 *
 * Реализация ARCHITECTURE-2.2 §3.2. Модуль чистый (без DOM/storage/сети), ESM:
 * вход — CaptureBatch или RawMessage[], выход — CanonicalThread. Побочные эффекты
 * остаются в core/content.ts; здесь только данные.
 *
 * Правила, которые держит этот файл:
 *  1. Роль — из raw.role (структура), не из текста.
 *  2. tool/file/artifact/source/ui/system не становятся assistant.text: они
 *     отбрасываются и учитываются в Completeness.droppedNodes.
 *  3. Один ход = один user + один assistant; соседние assistant-сегменты хода
 *     склеиваются '\n\n' (правило §3.2 п.3). Сегменты остаются в turn.segments.
 *  4. reasoning — отдельное поле; в text не попадает (правило §3.2 п.4).
 *  5. Дедуп: по raw.id, затем по (turnId, role, текст) — §3.2 п.5.
 *  6. Порядок задаёт ordinal, если он есть у ВСЕХ сообщений; иначе исходный.
 *  7. Каждая потеря учтена: droppedNodes / missingUserTurns (§3.2 п.7).
 *
 * Модель/лимиты/экспорт здесь не считаются: это следующие швы (metrics/export).
 */

import type {
  CaptureBatch,
  CaptureKind,
  PlatformId,
  RawMessage,
  RawNodeType,
} from '../../types/capture';
import type {
  CanonicalMessage,
  CanonicalThread,
  CanonicalTurn,
  Completeness,
  PartialReason,
  Role,
} from '../../types/canonical';
import { fnv1a32 } from '../canonical-body';

/** Контекст канонизации: то, что не является сообщением, но нужно провенансу. */
export interface CanonicalizeOptions {
  platform: PlatformId;
  convId?: string | null;
  model?: string;
  kind?: CaptureKind;
  capturedAt?: number;
  complete?: boolean;
  dropped?: Partial<Record<RawNodeType, number>>;
}

/** Разделитель склейки assistant-сегментов одного хода (§3.2 п.3). */
export const ASSISTANT_SEGMENT_SEPARATOR = '\n\n';

/** Псевдонимы ролей, которые встречаются у платформ. */
const ROLE_ALIASES: Record<string, Role> = {
  user: 'user',
  human: 'user',
  you: 'user',
  assistant: 'assistant',
  model: 'assistant',
  ai: 'assistant',
  bot: 'assistant',
};

/**
 * Нормализует сырую роль. Неизвестная роль → null (узел отбрасывается):
 * угадывать роль по тексту запрещено правилом §3.2 п.1.
 * @param raw Сырое значение role источника.
 * @returns 'user' | 'assistant' | null.
 */
export function normalizeRole(raw: unknown): Role | null {
  if (raw == null) return null;
  var key = String(raw).trim().toLowerCase();
  return ROLE_ALIASES[key] || null;
}

/**
 * Классификация узла до канонизации. Отсутствующий nodeType — обычное сообщение.
 * @param raw Сырое сообщение.
 * @returns Тип узла.
 */
export function classifyNode(raw: RawMessage): RawNodeType {
  return raw.nodeType || 'message';
}

/**
 * Нормализует текст: CRLF/CR → LF, без trim (trim менял бы bodyHash и chars).
 * Пустой/пробельный текст отбрасывается вызывающим.
 * @param text Сырой текст.
 * @returns Текст с нормализованными переводами строк.
 */
export function normalizeText(text: unknown): string {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
}

/**
 * Хэш канонического сообщения: fnv1a32(role + '\0' + text), 8 hex.
 * Тот же FNV-1a, что и bodyHash (utils/canonical-body.ts), но без convId:
 * хэш сообщения не зависит от чата и переживает reconcile.
 * @param role Роль сообщения.
 * @param text Нормализованный текст.
 * @returns 8 hex-символов.
 */
export function messageHash(role: Role, text: string): string {
  return fnv1a32(role + '\u0000' + text);
}

/** Порядок: ordinal учитывается только когда он есть у всех сообщений. */
function orderRaw(messages: RawMessage[]): { messages: RawMessage[]; ordered: boolean } {
  var allOrdinal = messages.length > 0 && messages.every(function (m) {
    return typeof m.ordinal === 'number' && isFinite(m.ordinal);
  });
  if (!allOrdinal) return { messages: messages.slice(), ordered: false };
  var copy = messages.slice();
  copy.sort(function (a, b) { return Number(a.ordinal) - Number(b.ordinal); });
  return { messages: copy, ordered: true };
}

function provenanceOf(options: CanonicalizeOptions) {
  return {
    kind: options.kind || 'dom',
    capturedAt: typeof options.capturedAt === 'number' ? options.capturedAt : 0,
    convId: options.convId == null ? null : String(options.convId),
  };
}

function makeMessage(
  role: Role,
  text: string,
  turnId: string,
  seq: number,
  raw: RawMessage,
  options: CanonicalizeOptions,
  reasoning?: string
): CanonicalMessage {
  var hash = messageHash(role, text);
  var rawId = raw.id == null ? '' : String(raw.id);
  var msg: CanonicalMessage = {
    id: rawId || turnId + ':' + seq + ':' + role + ':' + hash,
    turnId: turnId,
    seq: seq,
    role: role,
    kind: 'message',
    text: text,
    provenance: [provenanceOf(options)],
    hash: hash,
  };
  if (reasoning) msg.reasoning = reasoning;
  return msg;
}

/** Черновик хода: assistant собирается из сегментов и склеивается в конце. */
interface DraftTurn {
  id: string;
  user: CanonicalMessage | null;
  segments: CanonicalMessage[];
}

function joinReasoning(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return left + ASSISTANT_SEGMENT_SEPARATOR + right;
}

function rawTurnId(raw: RawMessage, position: number): string {
  var meta = raw.meta;
  var metaId = meta && typeof meta.turnId === 'string' ? meta.turnId : '';
  return metaId || 't' + position;
}

/**
 * Канонизирует массив сырых сообщений.
 *
 * @param messages Сырые сообщения одного источника.
 * @param options Контекст (платформа, канал, convId, заявление о полноте).
 * @returns Канонический тред; `messages` — плоский список тех же user/assistant.
 */
export function canonicalizeMessages(
  messages: RawMessage[],
  options: CanonicalizeOptions
): CanonicalThread {
  var ordered = orderRaw(messages);
  var droppedByType: Partial<Record<RawNodeType, number>> = {};
  var droppedTotal = 0;

  function drop(type: RawNodeType): void {
    droppedByType[type] = (droppedByType[type] || 0) + 1;
    droppedTotal++;
  }

  var initial = options.dropped || {};
  Object.keys(initial).forEach(function (key) {
    var type = key as RawNodeType;
    var count = Number(initial[type] || 0);
    if (count > 0) {
      droppedByType[type] = (droppedByType[type] || 0) + count;
      droppedTotal += count;
    }
  });

  var seenRawIds: Record<string, boolean> = {};
  var seenTurnKeys: Record<string, boolean> = {};
  var turns: DraftTurn[] = [];
  var current: DraftTurn | null = null;
  var pendingReasoning = '';
  var missingUserTurns = 0;

  for (var i = 0; i < ordered.messages.length; i++) {
    var raw = ordered.messages[i];
    var node = classifyNode(raw);
    var text = normalizeText(raw.text);

    if (node === 'reasoning') {
      pendingReasoning = joinReasoning(pendingReasoning, text);
      continue;
    }
    if (node !== 'message') {
      // tool/file/artifact/source/ui/system: в тело не попадают (§3.2 п.2).
      drop(node);
      continue;
    }

    if (raw.id != null) {
      var rawKey = String(raw.id);
      if (seenRawIds[rawKey]) continue;
      seenRawIds[rawKey] = true;
    }

    var role = normalizeRole(raw.role);
    if (!role) {
      drop(node);
      continue;
    }

    if (!text.trim()) {
      if (role === 'user') missingUserTurns++;
      else drop(node);
      continue;
    }

    if (role === 'user') {
      var turnId = rawTurnId(raw, turns.length + 1);
      var userKey = turnId + '\u0000user\u0000' + text;
      if (seenTurnKeys[userKey]) continue;
      seenTurnKeys[userKey] = true;
      current = {
        id: turnId,
        user: makeMessage('user', text, turnId, 0, raw, options),
        segments: [],
      };
      turns.push(current);
      continue;
    }

    // assistant
    if (!current) {
      // Ответ без user-хода: ход создаётся, но полнота понижается (§3.2 п.7).
      missingUserTurns++;
      current = { id: rawTurnId(raw, turns.length + 1), user: null, segments: [] };
      turns.push(current);
    }

    var assistantKey = current.id + '\u0000assistant\u0000' + text;
    if (seenTurnKeys[assistantKey]) continue;
    seenTurnKeys[assistantKey] = true;

    current.segments.push(
      makeMessage('assistant', text, current.id, 1 + current.segments.length, raw, options, pendingReasoning || undefined)
    );
    pendingReasoning = '';
  }

  if (pendingReasoning) {
    // Reasoning без ответа: не текст и не ход, но потеря обязана быть учтена.
    drop('reasoning');
  }

  var canonicalTurns: CanonicalTurn[] = [];
  var flat: CanonicalMessage[] = [];

  for (var t = 0; t < turns.length; t++) {
    var draft = turns[t];
    var assistant: CanonicalMessage | null = null;
    var mergedSegments: CanonicalMessage[] = [];

    if (draft.segments.length === 1) {
      assistant = draft.segments[0];
    } else if (draft.segments.length > 1) {
      mergedSegments = draft.segments;
      var mergedText = mergedSegments.map(function (s) { return s.text; }).join(ASSISTANT_SEGMENT_SEPARATOR);
      var mergedReasoning = mergedSegments.reduce(function (acc, s) {
        return joinReasoning(acc, s.reasoning || '');
      }, '');
      var hash = messageHash('assistant', mergedText);
      var provenance: CanonicalMessage['provenance'] = [];
      for (var p = 0; p < mergedSegments.length; p++) {
        provenance = provenance.concat(mergedSegments[p].provenance);
      }
      assistant = {
        id: draft.id + ':1:assistant:' + hash,
        turnId: draft.id,
        seq: 1,
        role: 'assistant',
        kind: 'message',
        text: mergedText,
        provenance: provenance,
        hash: hash,
      };
      if (mergedReasoning) assistant.reasoning = mergedReasoning;
    }

    var turn: CanonicalTurn = {
      id: draft.id,
      user: draft.user,
      assistant: assistant,
    };
    if (mergedSegments.length > 1) turn.segments = mergedSegments;

    canonicalTurns.push(turn);
    if (turn.user) flat.push(turn.user);
    if (turn.assistant) flat.push(turn.assistant);
  }

  var reasons: PartialReason[] = [];
  var complete = options.complete !== false;
  if (options.complete === false) reasons.push('incomplete');
  if (missingUserTurns > 0) {
    if (reasons.indexOf('missing-user-text') < 0) reasons.push('missing-user-text');
    complete = false;
  }

  var completeness: Completeness = {
    complete: complete,
    reasons: reasons,
  };
  if (droppedTotal > 0) completeness.droppedNodes = droppedTotal;
  if (missingUserTurns > 0) completeness.missingUserTurns = missingUserTurns;

  var thread: CanonicalThread = {
    convId: options.convId == null ? null : String(options.convId),
    platform: options.platform,
    turns: canonicalTurns,
    messages: flat,
    completeness: completeness,
  };
  if (options.model) thread.model = options.model;
  return thread;
}

/**
 * Канонизирует CaptureBatch (контракт capture → messages).
 * @param batch Батч источника.
 * @returns Канонический тред.
 */
export function canonicalizeBatch(batch: CaptureBatch): CanonicalThread {
  return canonicalizeMessages(batch.messages, {
    platform: batch.platform,
    convId: batch.convId,
    kind: batch.kind,
    capturedAt: batch.capturedAt,
    complete: batch.complete,
    dropped: batch.dropped,
  });
}

/**
 * Дедуп готовых канонических сообщений: по id, затем по
 * (turnId, role, нормализованный текст). Порядок сохраняется, первый экземпляр
 * побеждает (правило §3.2 п.5). Экспортируется для reconcile/export и тестов.
 * @param messages Канонические сообщения.
 * @returns Копия без дублей и число отброшенных.
 */
export function dedupeMessages(messages: CanonicalMessage[]): {
  messages: CanonicalMessage[];
  skipped: number;
} {
  var seenIds: Record<string, boolean> = {};
  var seenTuples: Record<string, boolean> = {};
  var out: CanonicalMessage[] = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var tuple = m.turnId + '\u0000' + m.role + '\u0000' + normalizeText(m.text);
    if ((m.id && seenIds[m.id]) || seenTuples[tuple]) continue;
    if (m.id) seenIds[m.id] = true;
    seenTuples[tuple] = true;
    out.push(m);
  }
  return { messages: out, skipped: messages.length - out.length };
}
