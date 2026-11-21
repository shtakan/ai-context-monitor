/**
 * 2.2/фаза 3: dual-run messages для Qwen.
 *
 * Старый путь (QwenAdapter.extractMessages) продолжает отдавать массив как
 * раньше; рядом canonicalizeBatch(capture()) строит канон и сравнивается с ним.
 * Ни снимок, ни бейдж, ни экспорт не меняются. Включение — тот же флаг
 * aiCmV2Messages (sessionStorage '1' / storage.aiCmV2.messages=true).
 */

import { canonicalizeBatch } from '../utils/messages/canonicalize';
import {
  aiCmV2MessagesEnabled,
  aiCmV2MessagesWarmFlag,
  roleSequence,
  roleSequenceHash
} from './aistudio-dualrun';
import { debugLog, swallowSoft } from '../utils/debug';

export interface QwenDualRunResult {
  verdict: 'same' | 'diff';
  oldCount: number;
  newCount: number;
  oldRoles: string;
  newRoles: string;
  oldRoleHash: string;
  newRoleHash: string;
  firstDiff: number;
  reasons: string[];
}

let installed = false;
let inDualRun = false;
let lastSig = '';

function oldMessages(list: any): Array<{ role: 'user' | 'assistant'; text: string }> {
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {};
    const text = (typeof m.content === 'string') ? m.content : ((typeof m.text === 'string') ? m.text : '');
    if (!text) continue;
    out.push({ role: (m.role === 'user') ? 'user' : 'assistant', text: text });
  }
  return out;
}

/**
 * Сравнивает старый массив Qwen с каноном capture(). Чистая функция.
 * Текст сравнивается как есть (canonicalize нормализует только CRLF).
 */
export function compareQwenMessages(oldList: any, batch: any): QwenDualRunResult {
  const old = oldMessages(oldList);
  const thread = canonicalizeBatch(batch);
  const next = thread.messages.map(function (m) {
    return { role: m.role, text: m.text };
  });
  const oldRoles = roleSequence(old);
  const newRoles = roleSequence(next);
  const reasons: string[] = [];
  if (old.length !== next.length) reasons.push('count');
  if (oldRoles !== newRoles) reasons.push('role-sequence');
  let firstDiff = -1;
  const max = Math.max(old.length, next.length);
  for (let i = 0; i < max; i++) {
    const a = old[i];
    const b = next[i];
    if (!a || !b || a.role !== b.role || a.text !== b.text) {
      firstDiff = i;
      if (!reasons.length) reasons.push('text');
      break;
    }
  }
  return {
    verdict: reasons.length ? 'diff' : 'same',
    oldCount: old.length,
    newCount: next.length,
    oldRoles: oldRoles,
    newRoles: newRoles,
    oldRoleHash: roleSequenceHash(old),
    newRoleHash: roleSequenceHash(next),
    firstDiff: firstDiff,
    reasons: reasons
  };
}

/**
 * Dual-run одного вызова extractMessages. Возвращает null, если флаг выключен,
 * адаптер не Qwen или capture() недоступен. Никогда не бросает.
 */
export function aiCmV2QwenDualRun(adapter: any, oldList: any): QwenDualRunResult | null {
  if (!aiCmV2MessagesEnabled()) return null;
  if (!adapter || adapter.siteName !== 'qwen' || typeof adapter.capture !== 'function') return null;
  if (inDualRun) return null; // capture() зовёт wrapped extractMessages — не рекурсия
  inDualRun = true;
  try {
    const batch = adapter.capture();
    if (!batch || !Array.isArray(batch.messages)) return null;
    const result = compareQwenMessages(oldList, batch);
    const sig = [result.verdict, result.oldCount, result.newCount, result.oldRoleHash, result.newRoleHash, result.reasons.join(',')].join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      debugLog('log', '[AI CM][v2-messages] ' + result.verdict + ' site=qwen' +
        ' counts=' + result.oldCount + '->' + result.newCount +
        ' roleHash=' + result.oldRoleHash + '->' + result.newRoleHash +
        ' first=' + result.firstDiff +
        ' reasons=' + (result.reasons.join(',') || '-'));
    }
    return result;
  } catch (eDual) {
    swallowSoft(eDual, 'content:v2-messages-qwen-dualrun');
    return null;
  } finally {
    inDualRun = false;
  }
}

/** Оборачивает QwenAdapter.prototype.extractMessages. Идемпотентно. */
export function installQwenDualRun(AdapterCtor: any): boolean {
  if (installed || !AdapterCtor || !AdapterCtor.prototype) return false;
  const original = AdapterCtor.prototype.extractMessages;
  if (typeof original !== 'function') return false;
  installed = true;
  aiCmV2MessagesWarmFlag();
  AdapterCtor.prototype.extractMessages = function (this: any, ...args: any[]) {
    const result = original.apply(this, args);
    try {
      aiCmV2QwenDualRun(this, result);
    } catch (eWrap) {
      swallowSoft(eWrap, 'content:v2-messages-qwen-wrap');
    }
    return result;
  };
  return true;
}

/** Только для тестов: сброс состояния установки/антиспама. */
export function resetQwenDualRunForTests(): void {
  installed = false;
  inDualRun = false;
  lastSig = '';
}
