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
import { canonicalBody } from '../utils/canonical-body';
import { debugLog, swallowSoft } from '../utils/debug';

/** Старое сообщение адаптера: { role, content }. */
export interface AiCmV2OldMessage {
  role?: string;
  content?: string;
}

/** Итог сравнения старого и нового представления одного треда. */
export interface AiCmV2DualRunResult {
  verdict: 'same' | 'diff';
  oldHash: string;
  newHash: string;
  oldChars: number;
  newChars: number;
  oldUser: number;
  oldAssistant: number;
  newUser: number;
  newAssistant: number;
  /** Индекс первого расхождения; -1 — расхождений нет. */
  firstDiff: number;
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
  const oldUser = countRole(oldNorm, 'user');
  const oldAssistant = countRole(oldNorm, 'assistant');
  const newUser = countRole(thread.messages, 'user');
  const newAssistant = countRole(thread.messages, 'assistant');

  const reasons: string[] = [];
  if (oldNorm.length !== thread.messages.length) reasons.push('count');
  if (oldBody.bodyHash !== newBody.bodyHash) reasons.push('body-hash');
  if (oldUser !== newUser) reasons.push('user-count');
  if (oldAssistant !== newAssistant) reasons.push('assistant-count');
  if (firstDiff >= 0) reasons.push('first-diff');
  if (thread.completeness.missingUserTurns) reasons.push('missing-user-turns');

  return {
    verdict: oldBody.bodyHash === newBody.bodyHash && oldNorm.length === thread.messages.length ? 'same' : 'diff',
    oldHash: oldBody.bodyHash,
    newHash: newBody.bodyHash,
    oldChars: oldBody.chars,
    newChars: newBody.chars,
    oldUser: oldUser,
    oldAssistant: oldAssistant,
    newUser: newUser,
    newAssistant: newAssistant,
    firstDiff: firstDiff,
    reasons: reasons,
    newComplete: thread.completeness.complete,
    newReasons: thread.completeness.reasons.slice()
  };
}

function logResult(result: AiCmV2DualRunResult, batch: CaptureBatch): void {
  const signature = [
    batch.convId || '', batch.kind, result.oldHash, result.newHash,
    result.oldChars, result.newChars, result.firstDiff
  ].join('|');
  if (signature === lastSignature) return;
  lastSignature = signature;

  debugLog('log',
    '[AI CM][v2-messages] site=aistudio verdict=' + result.verdict +
    ' src=' + batch.kind +
    ' old=' + result.oldUser + 'u/' + result.oldAssistant + 'a' +
    ' new=' + result.newUser + 'u/' + result.newAssistant + 'a' +
    ' oldHash=' + result.oldHash + ' newHash=' + result.newHash +
    ' oldChars=' + result.oldChars + ' newChars=' + result.newChars);

  if (result.verdict === 'diff') {
    debugLog('log',
      '[AI CM][v2-messages] diff site=aistudio first=' + result.firstDiff +
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
