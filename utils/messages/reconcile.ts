/**
 * utils/messages/reconcile.ts — сведение live и reload в одно представление треда.
 *
 * Реализация ARCHITECTURE-2.2 §3.2 п.6. Чистый модуль: никаких DOM/storage/сети,
 * только два канонических треда и их провенанс.
 *
 * Правило выбора:
 *  1) более полный тред (completeness.complete) побеждает неполный;
 *  2) при равной полноте — приоритет источника: net > native-counter > passive >
 *     loader > archive > files > dom;
 *  3) при равенстве источника — больше непустых сообщений; затем более поздний
 *     capturedAt; затем первый кандидат (порядок вызова стабилен).
 *
 * Базовый тред не смешивается с чужим текстом: недостающие user/assistant
 * заполняются из второго представления (с провенансом), а расхождение текста
 * фиксируется в diagnostics, а не склеивается половинами.
 */

import type { CaptureKind } from '../../types/capture';
import type {
  CanonicalMessage,
  CanonicalThread,
  CanonicalTurn,
  PartialReason,
  Role,
} from '../../types/canonical';
import { dedupeMessages } from './canonicalize';

/** Кандидат reconcile: тред + канал, которым он получен. */
export interface ReconcileCandidate {
  thread: CanonicalThread;
  kind: CaptureKind;
  capturedAt?: number;
}

/** Тип расхождения, которое reconcile обязан показать, а не проглотить. */
export type ReconcileDiagnosticType =
  | 'source-priority'
  | 'text-divergence'
  | 'filled'
  | 'turn-mismatch';

export interface ReconcileDiagnostic {
  type: ReconcileDiagnosticType;
  turnId: string;
  role?: Role;
  field?: 'user' | 'assistant';
  chosenKind: CaptureKind;
  otherKind: CaptureKind;
  chosenHash?: string;
  otherHash?: string;
  note?: string;
}

export interface ReconcileResult {
  thread: CanonicalThread;
  diagnostics: ReconcileDiagnostic[];
}

/** Приоритет каналов: чем больше число, тем довереннее представление. */
const KIND_RANK: Record<CaptureKind, number> = {
  net: 6,
  'native-counter': 5,
  passive: 4,
  loader: 3,
  archive: 2,
  files: 1,
  dom: 0,
};

function rankOf(kind: CaptureKind): number {
  return Object.prototype.hasOwnProperty.call(KIND_RANK, kind) ? KIND_RANK[kind] : 0;
}

function messageCount(thread: CanonicalThread): number {
  var n = 0;
  for (var i = 0; i < thread.turns.length; i++) {
    if (thread.turns[i].user) n++;
    if (thread.turns[i].assistant) n++;
  }
  return n;
}

function capturedAtOf(candidate: ReconcileCandidate): number {
  if (typeof candidate.capturedAt === 'number') return candidate.capturedAt;
  var max = 0;
  for (var i = 0; i < candidate.thread.messages.length; i++) {
    var prov = candidate.thread.messages[i].provenance;
    for (var j = 0; j < prov.length; j++) {
      if (prov[j].capturedAt > max) max = prov[j].capturedAt;
    }
  }
  return max;
}

/**
 * Выбирает базовое представление. Возвращает true, если базой стал первый
 * кандидат (a), false — второй (b).
 */
function preferFirst(a: ReconcileCandidate, b: ReconcileCandidate): boolean {
  var aComplete = a.thread.completeness.complete;
  var bComplete = b.thread.completeness.complete;
  if (aComplete !== bComplete) return aComplete;

  var aRank = rankOf(a.kind);
  var bRank = rankOf(b.kind);
  if (aRank !== bRank) return aRank > bRank;

  var aCount = messageCount(a.thread);
  var bCount = messageCount(b.thread);
  if (aCount !== bCount) return aCount > bCount;

  return capturedAtOf(a) >= capturedAtOf(b);
}

function cloneMessage(m: CanonicalMessage): CanonicalMessage {
  var copy: CanonicalMessage = {
    id: m.id,
    turnId: m.turnId,
    seq: m.seq,
    role: m.role,
    kind: m.kind,
    text: m.text,
    provenance: m.provenance.map(function (p) {
      return { kind: p.kind, capturedAt: p.capturedAt, convId: p.convId };
    }),
    hash: m.hash,
  };
  if (m.reasoning != null) copy.reasoning = m.reasoning;
  if (m.artifact) copy.artifact = { name: m.artifact.name, mime: m.artifact.mime, content: m.artifact.content };
  return copy;
}

function cloneTurn(turn: CanonicalTurn): CanonicalTurn {
  var copy: CanonicalTurn = {
    id: turn.id,
    user: turn.user ? cloneMessage(turn.user) : null,
    assistant: turn.assistant ? cloneMessage(turn.assistant) : null,
  };
  if (turn.segments) copy.segments = turn.segments.map(cloneMessage);
  return copy;
}

function cloneThread(thread: CanonicalThread): CanonicalThread {
  var copy: CanonicalThread = {
    convId: thread.convId,
    platform: thread.platform,
    turns: thread.turns.map(cloneTurn),
    messages: thread.messages.map(cloneMessage),
    completeness: {
      complete: thread.completeness.complete,
      reasons: thread.completeness.reasons.slice(),
    },
  };
  if (thread.model != null) copy.model = thread.model;
  if (thread.completeness.droppedNodes != null) copy.completeness.droppedNodes = thread.completeness.droppedNodes;
  if (thread.completeness.missingUserTurns != null) copy.completeness.missingUserTurns = thread.completeness.missingUserTurns;
  return copy;
}

function appendProvenance(target: CanonicalMessage, source: CanonicalMessage): void {
  var seen: Record<string, boolean> = {};
  for (var i = 0; i < target.provenance.length; i++) {
    var p = target.provenance[i];
    seen[p.kind + '\u0000' + p.capturedAt + '\u0000' + String(p.convId)] = true;
  }
  for (var j = 0; j < source.provenance.length; j++) {
    var q = source.provenance[j];
    var key = q.kind + '\u0000' + q.capturedAt + '\u0000' + String(q.convId);
    if (seen[key]) continue;
    seen[key] = true;
    target.provenance.push({ kind: q.kind, capturedAt: q.capturedAt, convId: q.convId });
  }
}

function addReason(thread: CanonicalThread, reason: PartialReason): void {
  if (thread.completeness.reasons.indexOf(reason) < 0) thread.completeness.reasons.push(reason);
}

function rebuildMessages(thread: CanonicalThread): CanonicalMessage[] {
  var flat: CanonicalMessage[] = [];
  for (var i = 0; i < thread.turns.length; i++) {
    var turn = thread.turns[i];
    if (turn.user) flat.push(turn.user);
    if (turn.assistant) flat.push(turn.assistant);
  }
  return dedupeMessages(flat).messages;
}

function findTurn(thread: CanonicalThread, id: string, index: number): CanonicalTurn | null {
  for (var i = 0; i < thread.turns.length; i++) {
    if (thread.turns[i].id === id) return thread.turns[i];
  }
  return index < thread.turns.length ? thread.turns[index] : null;
}

/**
 * Сводит два представления одного треда.
 *
 * @param a Первое представление (например, live/dom).
 * @param b Второе представление (например, reload/net).
 * @returns Тред-победитель (не мутирует входы) и диагностика расхождений.
 */
export function reconcile(a: ReconcileCandidate, b: ReconcileCandidate): ReconcileResult {
  var firstWins = preferFirst(a, b);
  var base = firstWins ? a : b;
  var other = firstWins ? b : a;
  var thread = cloneThread(base.thread);
  var diagnostics: ReconcileDiagnostic[] = [];

  if (base.kind !== other.kind) {
    diagnostics.push({
      type: 'source-priority',
      turnId: '*',
      chosenKind: base.kind,
      otherKind: other.kind,
    });
  }

  for (var i = 0; i < thread.turns.length; i++) {
    var turn = thread.turns[i];
    var peer = findTurn(other.thread, turn.id, i);
    if (!peer) continue;

    if (!turn.user && peer.user) {
      turn.user = cloneMessage(peer.user);
      appendProvenance(turn.user, peer.user);
      thread.completeness.complete = false;
      addReason(thread, 'missing-user-text');
      diagnostics.push({
        type: 'filled',
        turnId: turn.id,
        role: 'user',
        field: 'user',
        chosenKind: base.kind,
        otherKind: other.kind,
        otherHash: peer.user.hash,
      });
    } else if (turn.user && peer.user && turn.user.hash !== peer.user.hash) {
      diagnostics.push({
        type: 'text-divergence',
        turnId: turn.id,
        role: 'user',
        field: 'user',
        chosenKind: base.kind,
        otherKind: other.kind,
        chosenHash: turn.user.hash,
        otherHash: peer.user.hash,
      });
    }

    if (!turn.assistant && peer.assistant) {
      turn.assistant = cloneMessage(peer.assistant);
      appendProvenance(turn.assistant, peer.assistant);
      thread.completeness.complete = false;
      addReason(thread, 'incomplete');
      diagnostics.push({
        type: 'filled',
        turnId: turn.id,
        role: 'assistant',
        field: 'assistant',
        chosenKind: base.kind,
        otherKind: other.kind,
        otherHash: peer.assistant.hash,
      });
    } else if (turn.assistant && peer.assistant && turn.assistant.hash !== peer.assistant.hash) {
      diagnostics.push({
        type: 'text-divergence',
        turnId: turn.id,
        role: 'assistant',
        field: 'assistant',
        chosenKind: base.kind,
        otherKind: other.kind,
        chosenHash: turn.assistant.hash,
        otherHash: peer.assistant.hash,
      });
    }
  }

  if (other.thread.turns.length > thread.turns.length) {
    diagnostics.push({
      type: 'turn-mismatch',
      turnId: '*',
      chosenKind: base.kind,
      otherKind: other.kind,
      note: 'other has ' + other.thread.turns.length + ' turns, chosen has ' + thread.turns.length,
    });
  }

  thread.messages = rebuildMessages(thread);

  return { thread: thread, diagnostics: diagnostics };
}
