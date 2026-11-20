/**
 * core/aistudio-dualrun.ts — dual-run шва messages на AI Studio (2.2, фаза 1).
 *
 * Что делает: после штатного extractMessages() (старый путь, уже склеенные
 * assistant-сегменты) адаптер отдаёт сырой CaptureBatch (capture()), тот же
 * вход проходит через utils/messages/canonicalize, и два результата
 * сравниваются по составу и bodyHash. Файл пишет СТАРЫЙ путь — новый только
 * измеряется. Включение: sessionStorage['aiCmV2Messages']='1' или
 * chrome.storage.local.aiCmV2.messages=true.
 *
 * Почему снаружи адаптера: адаптер — classic-скрипт (песочницы тестов и
 * MAIN-подобная склейка), ему нельзя импортировать ESM. Установщик ниже
 * оборачивает prototype.extractMessages уже в контексте content-бандла.
 *
 * Диагностика (без текста сообщений):
 *   [AI CM][v2-messages] site=aistudio verdict=same|diff src=net
 *     old=6u/8a new=6u/6a oldHash=… newHash=… oldChars=… newChars=…
 */

import type { CaptureBatch } from '../types/capture';
import { canonicalizeBatch } from '../utils/messages/canonicalize';
import { canonicalBody, fnv1a32 } from '../utils/canonical-body';
import { debugLog, swallowSoft } from '../utils/debug';

/** Старое сообщение адаптера: { role, content }. */
export interface AiCmV2OldMessage {
  role?: string;
  content?: string;
}

/** Сообщение снимка AI Studio (window.__aiCmNetMsgs.msgs). */
export interface AiCmAistudioSnapshotMessage {
  role?: string;
  text?: string;
  sections?: string;
  id?: string | number;
}

/**
 * BUG-13: след dedupe для файла. Сравнивает роли источника и выхода:
 * removedUsers — сколько user-ходов убрано, foldedAssistants — сколько
 * assistant-сообщений склеено. undefined — счёт не менялся.
 */
export function exportDedupeInfo(
  sourceMessages: Array<{ role?: string }> | null | undefined,
  outputMessages: Array<{ role?: string }> | null | undefined
): { input: number; output: number; removedUsers: number; foldedAssistants: number } | undefined {
  const src = Array.isArray(sourceMessages) ? sourceMessages : [];
  const out = Array.isArray(outputMessages) ? outputMessages : [];
  if (src.length === out.length) return undefined;
  let srcUsers = 0;
  let srcAssistants = 0;
  let outUsers = 0;
  let outAssistants = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] && src[i].role === 'user') srcUsers++;
    else srcAssistants++;
  }
  for (let j = 0; j < out.length; j++) {
    if (out[j] && out[j].role === 'user') outUsers++;
    else outAssistants++;
  }
  return {
    input: src.length,
    output: out.length,
    removedUsers: Math.max(0, srcUsers - outUsers),
    foldedAssistants: Math.max(0, srcAssistants - outAssistants)
  };
}

/**
 * Роли и тексты базового снимка AI Studio для экспортной проекции.
 *
 * BUG-12: export-manager берёт роли из lastDetailMessages; без этой синхронизации
 * он падал в чётностный фолбэк (j % 2) и переворачивал роли после файлового узла.
 * Функция чистая: только маппинг role/text(+sections), без DOM/storage.
 */
export function aistudioDetailMessages(
  snap: { msgs?: AiCmAistudioSnapshotMessage[] } | null | undefined
): Array<{ role: 'user' | 'assistant'; text: string; id?: string }> {
  const out: Array<{ role: 'user' | 'assistant'; text: string; id?: string }> = [];
  const msgs = snap && Array.isArray(snap.msgs) ? snap.msgs : [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] || {};
    const text = String(m.text == null ? '' : m.text) + String(m.sections == null ? '' : m.sections);
    const rec: { role: 'user' | 'assistant'; text: string; id?: string } = {
      role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user',
      text: text
    };
    if (m.id != null) rec.id = String(m.id);
    out.push(rec);
  }
  return out;
}

/** Итог сравнения старого и нового представления одного треда. */
export interface AiCmV2DualRunResult {
  verdict: 'same' | 'diff';
  oldHash: string;
  newHash: string;
  oldRoleHash: string;
  newRoleHash: string;
  oldChars: number;
  newChars: number;
  oldUser: number;
  oldAssistant: number;
  newUser: number;
  newAssistant: number;
  /** Индекс первого расхождения текста/роли; -1 — расхождений нет. */
  firstDiff: number;
  /** Индекс первого расхождения именно ролей; -1 — роли совпадают. */
  firstRoleDiff: number;
  /** Все индексы, где роль старого и нового пути разошлась. */
  roleDiffs: number[];
  /** Компактная последовательность ролей: 'u'/'a' (для сверки с экспортом). */
  oldRoles: string;
  newRoles: string;
  reasons: string[];
  newComplete: boolean;
  newReasons: string[];
}

let storageFlag = false;
let storageRequested = false;
let lastSignature = '';
let installed = false;

function sessionFlag(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('aiCmV2Messages') === '1';
  } catch (eSession) {
    return false;
  }
}

/**
 * Включён ли dual-run messages. sessionStorage читается на каждом вызове
 * (живой тумблер без перезагрузки), storage.local — один раз при установке.
 */
export function aiCmV2MessagesEnabled(): boolean {
  return sessionFlag() || storageFlag;
}

function loadStorageFlag(): void {
  if (storageRequested) return;
  storageRequested = true;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get('aiCmV2', function (data: Record<string, any>) {
      const cfg = data && data.aiCmV2;
      storageFlag = !!(cfg && cfg.messages === true);
      if (storageFlag) debugLog('log', '[AI CM][v2-messages] flag=on source=storage');
    });
  } catch (eFlag) {
    swallowSoft(eFlag, 'content:v2-messages-flag');
  }
}

function normalizeOld(messages: AiCmV2OldMessage[] | null | undefined): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  if (!Array.isArray(messages)) return out;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content !== 'string') continue;
    const text = m.content.replace(/\r\n?/g, '\n');
    if (!text.trim()) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', text: text });
  }
  return out;
}

function countRole(messages: Array<{ role: string }>, role: string): number {
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === role) n++;
  }
  return n;
}

/**
 * Хэш последовательности ролей: 'u'/'a' без текста. Нужен как отдельный
 * критерий приёмки (K2): bodyHash чувствителен к роли, но его расхождение
 * смешано с текстом; roleHash отвечает ровно на вопрос «та же раскладка ролей».
 */
export function roleSequenceHash(messages: Array<{ role?: string }> | null | undefined): string {
  return fnv1a32(roleSequence(messages));
}

/** Компактная последовательность ролей: 'u' для user, 'a' для остальных. */
export function roleSequence(messages: Array<{ role?: string }> | null | undefined): string {
  let seq = '';
  if (Array.isArray(messages)) {
    for (let i = 0; i < messages.length; i++) {
      seq += (messages[i] && messages[i].role === 'user') ? 'u' : 'a';
    }
  }
  return seq;
}

function roleDifferences(
  oldMessages: Array<{ role: string }>,
  newMessages: Array<{ role: string }>
): number[] {
  const out: number[] = [];
  const n = Math.max(oldMessages.length, newMessages.length);
  for (let i = 0; i < n; i++) {
    const a = oldMessages[i] ? oldMessages[i].role : '';
    const b = newMessages[i] ? newMessages[i].role : '';
    if (a !== b) out.push(i);
  }
  return out;
}

function firstDifference(
  oldMessages: Array<{ role: string; text: string }>,
  newMessages: Array<{ role: string; text: string }>
): number {
  const n = Math.max(oldMessages.length, newMessages.length);
  for (let i = 0; i < n; i++) {
    const a = oldMessages[i];
    const b = newMessages[i];
    if (!a || !b) return i;
    if (a.role !== b.role || a.text !== b.text) return i;
  }
  return -1;
}

/**
 * Чистое сравнение: старый массив адаптера против канона из CaptureBatch.
 * Не логирует и не зависит от флага — пригодно для тестов и live-трейса.
 */
export function compareAistudioMessages(
  oldMessages: AiCmV2OldMessage[] | null | undefined,
  batch: CaptureBatch
): AiCmV2DualRunResult {
  const oldNorm = normalizeOld(oldMessages);
  const thread = canonicalizeBatch(batch);
  const oldBody = canonicalBody(batch.convId || '', oldNorm);
  const newBody = canonicalBody(thread.convId || '', thread.messages);
  const firstDiff = firstDifference(oldNorm, thread.messages);
  const roleDiffs = roleDifferences(oldNorm, thread.messages);
  const oldRoleHash = roleSequenceHash(oldNorm);
  const newRoleHash = roleSequenceHash(thread.messages);
  const oldUser = countRole(oldNorm, 'user');
  const oldAssistant = countRole(oldNorm, 'assistant');
  const newUser = countRole(thread.messages, 'user');
  const newAssistant = countRole(thread.messages, 'assistant');

  const reasons: string[] = [];
  if (oldNorm.length !== thread.messages.length) reasons.push('count');
  if (oldBody.bodyHash !== newBody.bodyHash) reasons.push('body-hash');
  if (oldUser !== newUser) reasons.push('user-count');
  if (oldAssistant !== newAssistant) reasons.push('assistant-count');
  if (oldRoleHash !== newRoleHash || roleDiffs.length > 0) reasons.push('role-sequence');
  if (firstDiff >= 0) reasons.push('first-diff');
  if (thread.completeness.missingUserTurns) reasons.push('missing-user-turns');

  return {
    verdict: oldBody.bodyHash === newBody.bodyHash &&
      oldNorm.length === thread.messages.length &&
      oldRoleHash === newRoleHash ? 'same' : 'diff',
    oldHash: oldBody.bodyHash,
    newHash: newBody.bodyHash,
    oldRoleHash: oldRoleHash,
    newRoleHash: newRoleHash,
    oldChars: oldBody.chars,
    newChars: newBody.chars,
    oldUser: oldUser,
    oldAssistant: oldAssistant,
    newUser: newUser,
    newAssistant: newAssistant,
    firstDiff: firstDiff,
    firstRoleDiff: roleDiffs.length ? roleDiffs[0] : -1,
    roleDiffs: roleDiffs,
    oldRoles: roleSequence(oldNorm),
    newRoles: roleSequence(thread.messages),
    reasons: reasons,
    newComplete: thread.completeness.complete,
    newReasons: thread.completeness.reasons.slice()
  };
}

function logResult(result: AiCmV2DualRunResult, batch: CaptureBatch): void {
  const signature = [
    batch.convId || '', batch.kind, result.oldHash, result.newHash,
    result.oldRoleHash, result.newRoleHash, result.oldChars, result.newChars,
    result.firstDiff, result.roleDiffs.join(',')
  ].join('|');
  if (signature === lastSignature) return;
  lastSignature = signature;

  debugLog('log',
    '[AI CM][v2-messages] site=aistudio verdict=' + result.verdict +
    ' src=' + batch.kind +
    ' old=' + result.oldUser + 'u/' + result.oldAssistant + 'a' +
    ' new=' + result.newUser + 'u/' + result.newAssistant + 'a' +
    ' oldHash=' + result.oldHash + ' newHash=' + result.newHash +
    ' oldRoleHash=' + result.oldRoleHash + ' newRoleHash=' + result.newRoleHash +
    ' oldChars=' + result.oldChars + ' newChars=' + result.newChars);

  // Машинный след для приёмки: одна JSON-строка на извлечение (K1/K2), без текстов.
  debugLog('log', '[AI CM][v2-messages-json] ' + JSON.stringify({
    t: new Date().toISOString(),
    site: 'aistudio',
    verdict: result.verdict,
    src: batch.kind,
    convId: batch.convId || '',
    old: {
      u: result.oldUser,
      a: result.oldAssistant,
      bodyHash: result.oldHash,
      roleHash: result.oldRoleHash,
      roles: result.oldRoles,
      chars: result.oldChars
    },
    new: {
      u: result.newUser,
      a: result.newAssistant,
      bodyHash: result.newHash,
      roleHash: result.newRoleHash,
      roles: result.newRoles,
      chars: result.newChars,
      complete: result.newComplete,
      reasons: result.newReasons
    },
    reasons: result.reasons,
    firstDiff: result.firstDiff,
    firstRoleDiff: result.firstRoleDiff,
    roleDiffs: result.roleDiffs
  }));

  if (result.verdict === 'diff') {
    debugLog('log',
      '[AI CM][v2-messages] diff site=aistudio first=' + result.firstDiff +
      ' firstRole=' + result.firstRoleDiff +
      ' roleDiffs=' + (result.roleDiffs.join(',') || '-') +
      ' reasons=' + result.reasons.join(',') +
      ' newComplete=' + (result.newComplete ? 1 : 0) +
      ' newReasons=' + (result.newReasons.join(',') || '-'));
  }
}

/**
 * Dual-run для одного вызова extractMessages. Возвращает null, если флаг
 * выключен/адаптер не AI Studio/сравнение невозможно. Никогда не бросает.
 */
export function aiCmV2AistudioDualRun(
  adapter: any,
  oldMessages: AiCmV2OldMessage[] | null | undefined
): AiCmV2DualRunResult | null {
  if (!aiCmV2MessagesEnabled()) return null;
  if (!adapter || adapter.siteName !== 'aistudio' || typeof adapter.capture !== 'function') return null;
  try {
    const batch = adapter.capture();
    if (!batch || !Array.isArray(batch.messages)) return null;
    const result = compareAistudioMessages(oldMessages, batch);
    logResult(result, batch);
    return result;
  } catch (eDual) {
    swallowSoft(eDual, 'content:v2-messages-dualrun');
    return null;
  }
}

/**
 * Оборачивает AistudioAdapter.prototype.extractMessages: старый return не
 * меняется, рядом выполняется dual-run. Идемпотентно.
 * @returns true, если обёртка установлена.
 */
export function installAistudioDualRun(AdapterCtor: any): boolean {
  if (installed || !AdapterCtor || !AdapterCtor.prototype) return false;
  const original = AdapterCtor.prototype.extractMessages;
  if (typeof original !== 'function') return false;
  installed = true;
  loadStorageFlag();

  AdapterCtor.prototype.extractMessages = function (this: any, ...args: any[]) {
    const result = original.apply(this, args);
    try {
      aiCmV2AistudioDualRun(this, result);
    } catch (eWrap) {
      swallowSoft(eWrap, 'content:v2-messages-wrap');
    }
    return result;
  };
  return true;
}

/** Только для тестов: сброс состояния установки/троттлинга. */
export function resetAistudioDualRunForTests(): void {
  installed = false;
  lastSignature = '';
  storageFlag = false;
  storageRequested = false;
}
