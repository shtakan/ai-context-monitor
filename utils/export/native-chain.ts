/**
 * utils/export/native-chain.ts — Stage 6: сборка активной цепочки чата.
 *
 * Вход — нативные узлы платформы (`{ id, parentId, role, text, ... }`) и лист
 * (`currentId`/`current_node`/последний узел) либо плоский список (`linear: true`).
 * Выход — один массив сообщений oldest→newest для MD/TXT/JSON.
 *
 * Инвариант: assistant не может идти за assistant без user-пары. Разрыв не
 * удаляется молча: результат помечается `partial=true` и причиной
 * `missing-user-text`; off-chain/abandoned узлы отбрасываются со счётчиком.
 *
 * Модуль чистый: не читает DOM/chrome/storage и не знает платформенных payload.
 * Адаптер платформы сам переводит свои узлы в NativeChainNode.
 */

import type { ExportMessage } from '../../types/export';

export interface NativeChainNode {
  id: string;
  parentId?: string | null;
  role: string;
  text: string;
  reasoning?: string;
  files?: unknown[];
  sources?: unknown[];
  artifact?: unknown;
  artifacts?: unknown[];
  offChain?: boolean;
  [key: string]: unknown;
}

export type NativePartialReason = 'missing-user-text' | 'truncated' | 'incomplete';

export interface NativeChainInput {
  nodes: NativeChainNode[] | Record<string, NativeChainNode> | null | undefined;
  /** Лист активной ветки. Если пуст — берётся последний узел. */
  currentId?: string | null;
  /** Платформа хранит плоский список: цепочку не строим, берём порядок как есть. */
  linear?: boolean;
}

export interface NativeChainResult {
  messages: ExportMessage[];
  partial: boolean;
  partialReason?: NativePartialReason;
  /** Число узлов, не попавших в активную цепочку (off-chain/abandoned). */
  dropped: number;
  /** Длина выбранной цепочки до нормализации ролей. */
  chainLength: number;
  /** Лист, от которого построена цепочка. */
  currentId: string;
  /** Цепочка не дошла до корня (битый parentId/цикл). */
  truncated: boolean;
  /** Сколько assistant-сообщений осталось без user-пары. */
  missingUserPairs: number;
}

function normId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return '';
}

function roleOf(value: unknown): 'user' | 'assistant' {
  const role = String(value || '').toLowerCase();
  if (role === 'user' || role === 'human') return 'user';
  return 'assistant';
}

/** Узлы в массив с устойчивыми id; словарь сохраняет порядок значений. */
function normalizeNodes(input: NativeChainInput['nodes']): NativeChainNode[] {
  const out: NativeChainNode[] = [];
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      const node = input[i];
      if (!node || typeof node !== 'object') continue;
      out.push(Object.assign({}, node, { id: normId(node.id) || ('#' + i) }));
    }
    return out;
  }
  if (input && typeof input === 'object') {
    const keys = Object.keys(input);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const node = (input as Record<string, NativeChainNode>)[key];
      if (!node || typeof node !== 'object') continue;
      out.push(Object.assign({}, node, { id: normId(node.id) || key }));
    }
  }
  return out;
}

/**
 * Строит активную цепочку от листа к корню и разворачивает oldest→newest.
 * Возвращает также флаг truncated: parentId не разрешился или обнаружен цикл.
 */
function collectChain(nodes: NativeChainNode[], currentId: string): {
  chain: NativeChainNode[];
  truncated: boolean;
  currentId: string;
} {
  const byId: Record<string, NativeChainNode> = {};
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id && !byId[nodes[i].id]) byId[nodes[i].id] = nodes[i];
  }
  let leaf = currentId;
  if (!leaf) {
    for (let j = nodes.length - 1; j >= 0; j--) {
      if (nodes[j].id && nodes[j].offChain !== true) { leaf = nodes[j].id; break; }
    }
  }
  if (!leaf) return { chain: [], truncated: false, currentId: '' };

  const reversed: NativeChainNode[] = [];
  const seen: Record<string, true> = {};
  let truncated = false;
  let cursor = leaf;
  while (cursor) {
    const node = byId[cursor];
    if (!node) { truncated = true; break; }
    if (seen[cursor]) { truncated = true; break; }
    seen[cursor] = true;
    reversed.push(node);
    const parent = normId(node.parentId);
    if (!parent) { cursor = ''; break; }
    cursor = parent;
  }
  reversed.reverse();
  return { chain: reversed, truncated: truncated, currentId: leaf };
}

/** Копия узла в сообщение файла; платформенные enrichments переносятся как есть. */
function toMessage(node: NativeChainNode): ExportMessage {
  const msg: ExportMessage = {
    role: roleOf(node.role),
    text: (typeof node.text === 'string') ? node.text : ''
  };
  if (node.id) msg.id = node.id;
  if (typeof node.reasoning === 'string' && node.reasoning) msg.reasoning = node.reasoning;
  if (typeof node.hiddenReasoning === 'string' && node.hiddenReasoning) msg.hiddenReasoning = node.hiddenReasoning;
  if (Array.isArray(node.files) && node.files.length) msg.files = node.files;
  if (Array.isArray(node.sources) && node.sources.length) msg.sources = node.sources;
  if (node.artifact && typeof node.artifact === 'object') msg.artifact = node.artifact;
  if (Array.isArray(node.artifacts) && node.artifacts.length) msg.artifacts = node.artifacts;
  return msg;
}

/**
 * Собирает сообщения из нативной цепочки.
 * Не бросает на мусорном входе: пустой/невалидный источник → пустой массив.
 */
export function buildNativeChain(input: NativeChainInput): NativeChainResult {
  const nodes = normalizeNodes(input ? input.nodes : null);
  const linear = !!(input && input.linear === true);
  const requestedLeaf = normId(input ? input.currentId : '');
  const built = linear
    ? { chain: nodes.slice(), truncated: false, currentId: requestedLeaf }
    : collectChain(nodes, requestedLeaf);

  const chain = built.chain;
  const chainIds: Record<string, true> = {};
  for (let c = 0; c < chain.length; c++) chainIds[chain[c].id] = true;

  const messages: ExportMessage[] = [];
  let missingUserPairs = 0;
  let hasUserForAssistant = false;
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    if (node.offChain === true) continue;
    const msg = toMessage(node);
    if (msg.role === 'user') {
      hasUserForAssistant = true;
    } else {
      if (!hasUserForAssistant) missingUserPairs++;
      hasUserForAssistant = false;
    }
    messages.push(msg);
  }

  let dropped = 0;
  for (let j = 0; j < nodes.length; j++) {
    if (!chainIds[nodes[j].id] || nodes[j].offChain === true) dropped++;
  }

  let partialReason: NativePartialReason | undefined;
  // Обрыв цепочки объясняет и возможный A→A: причина «truncated» точнее.
  if (built.truncated) partialReason = 'truncated';
  else if (missingUserPairs > 0) partialReason = 'missing-user-text';
  else if (!messages.length) partialReason = 'incomplete';

  return {
    messages: messages,
    partial: partialReason !== undefined,
    partialReason: partialReason,
    dropped: dropped,
    chainLength: chain.length,
    currentId: built.currentId,
    truncated: built.truncated,
    missingUserPairs: missingUserPairs
  };
}
