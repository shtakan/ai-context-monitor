/**
 * C1: контракты границы Service Worker.
 *
 * Что было: в core/background.ts жил локальный `interface AiCmSwMessage` с
 * `[key: string]: any` — единственный «динамический» вход SW: любое сообщение
 * проходило проверку типов, payload каждой ветки (text/model/convId/debounced,
 * data.pct, service) был невидим для tsc, а ответы sendResponse — без формы.
 *
 * Что стало: types/messages.d.ts — дискриминированный `AiCmSwRequest` (девять
 * вариантов по `type`), карта ответов `AiCmSwResponseMap` и производные
 * `AiCmSwResponse`/`AiCmSwResponseFor<T>`/`AiCmSwAskRequest` (только каналы с
 * ответом). Индекс-подписи нет; слушатель и обёртка aiCmSwAsk типизированы generic'ом.
 *
 * C2: тот же принцип для второй границы — AiCmContentRequest/AiCmContentResponse
 * (листенер content), AiCmDiagResponse, AiCmManualSnapshot в конверте data
 * (фактический ответ aiCmExportCurrent) и AiCmBroadcast (CONTEXT_UPDATE).
 *
 * Тест сторожит именно границу: наличие/отсутствие объявлений в четырёх файлах и
 * отсутствие запрещённых подавлений. Поведение не проверяется — оно не менялось
 * (рантайм-контракты держат tests/background-counttokens.test.js, tests/byok-session.test.js,
 * tests/security/byok-isolation.test.js, tests/o43-gsa-autoexport-race.test.js).
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers/content-source.js');

const raw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MESSAGES = raw('types/messages.d.ts');
const BACKGROUND = raw('core/background.ts');
const STATE = raw('core/state.ts');
const CONTENT = raw('core/content.ts');

/** Число вхождений подстроки (парные места отправки: BADGE_RESET ×2). */
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('C1: types/messages.d.ts — объявленный union запросов', () => {
  it('экспортирует AiCmSwRequest и все девять вариантов по type', () => {
    expect(MESSAGES).toContain('export type AiCmSwRequest =');
    const types = [
      "'COUNT_TOKENS'", "'THRESHOLD_PCT'", "'BADGE_RESET'", "'close-print-tab'",
      "'aiCm-get-byok-key'", "'aiCm-latch-get'", "'aiCm-latch-set'",
      "'aiCm-latch-remove'", "'aiCm-latch-get-all'"
    ];
    expect(types).toHaveLength(9);
    types.forEach(function (t) {
      expect(MESSAGES).toContain('type: ' + t);
    });
  });

  it('payload-поля вариантов совпадают с фактической отправкой', () => {
    expect(MESSAGES).toContain('export interface AiCmSwCountTokensRequest');
    expect(MESSAGES).toContain('text: string;');
    expect(MESSAGES).toContain('convId?: string | number;');
    expect(MESSAGES).toContain('debounced?: number;');
    // site приходит от content (core/content.ts:3374), в SW-потребителе его нет
    expect(MESSAGES).toContain('data: { pct?: number; convId?: string | number; site?: string };');
    expect(MESSAGES).toContain('service: string;');
  });

  it('карта ответов, AiCmSwResponseFor и AiCmSwAskRequest объявлены', () => {
    expect(MESSAGES).toContain('export interface AiCmSwResponseMap');
    expect(MESSAGES).toContain('export type AiCmSwResponse = AiCmSwResponseMap[keyof AiCmSwResponseMap];');
    expect(MESSAGES).toContain("export type AiCmSwResponseFor<T extends AiCmSwRequest> = AiCmSwResponseMap[T['type']];");
    expect(MESSAGES).toContain('export type AiCmSwAskRequest = Extract<AiCmSwRequest, {');
    // каналы без ответа — void, а не выдуманная форма
    expect(MESSAGES).toContain('THRESHOLD_PCT: void;');
    expect(MESSAGES).toContain('BADGE_RESET: void;');
    expect(MESSAGES).toContain("'close-print-tab': void;");
  });

  it('в контракте нет индекс-подписи и подавлений типов', () => {
    expect(MESSAGES).not.toContain('[key: string]: any');
    expect(MESSAGES).not.toContain('@ts-ignore');
    expect(MESSAGES).not.toContain('@ts-nocheck');
    expect(MESSAGES).not.toContain('as any');
  });
});

describe('C1: core/background.ts — слушатель на объединении', () => {
  it('импортирует контракты и типизирует onMessage', () => {
    expect(BACKGROUND).toContain('import type { AiCmContentRequest, AiCmSwCountTokensResponse, AiCmSwRequest, AiCmSwResponse, AiCmSwSender }');
    expect(BACKGROUND).toContain("from '../types/messages'");
    expect(BACKGROUND).toContain(
      '(message: AiCmSwRequest, sender: AiCmSwSender, sendResponse: (response?: AiCmSwResponse) => void)'
    );
  });

  it('локальный AiCmSwMessage с [key: string]: any удалён', () => {
    expect(BACKGROUND).not.toContain('interface AiCmSwMessage');
    expect(BACKGROUND).not.toContain('[key: string]: any');
  });

  it('handleCountTokens принимает суженный вариант COUNT_TOKENS', () => {
    expect(BACKGROUND).toContain(
      "function handleCountTokens(message: Extract<AiCmSwRequest, { type: 'COUNT_TOKENS' }>, sender: AiCmSwSender): Promise<AiCmSwCountTokensResponse>"
    );
    expect(BACKGROUND).toContain('function checkThresholds(data: AiCmThresholdData, sender: AiCmSwSender)');
  });

  it('нет подавлений типов в рабочем коде', () => {
    expect(BACKGROUND).not.toContain('@ts-ignore');
    expect(BACKGROUND).not.toContain('@ts-nocheck');
    expect(BACKGROUND).not.toContain('as any');
  });
});

describe('C1: core/state.ts — generic aiCmSwAsk', () => {
  it('обёртка связана с картой ответов', () => {
    expect(STATE).toContain('function aiCmSwAsk<T extends AiCmSwAskRequest>(payload: T): Promise<AiCmSwResponseFor<T> | null> {');
    expect(STATE).toContain('chrome.runtime.sendMessage(payload, function (resp: AiCmSwResponseFor<T>) {');
    expect(STATE).not.toContain('function aiCmSwAsk(payload: unknown): Promise<any>');
  });

  it('не модуль: контракт подключён type-алиасами, а не import-строкой', () => {
    expect(STATE).toContain("type AiCmSwAskRequest = import('../types/messages').AiCmSwAskRequest;");
    expect(STATE).not.toMatch(/^import /m);
  });

  it('нет подавлений типов', () => {
    expect(STATE).not.toContain('@ts-ignore');
    expect(STATE).not.toContain('@ts-nocheck');
    expect(STATE).not.toContain('as any');
  });
});

describe('C1: core/content.ts — отправители типизированы', () => {
  it('COUNT_TOKENS: объект и колбэк-ответ получили форму union', () => {
    expect(CONTENT).toContain('} as AiCmSwCountTokensRequest, function (response: AiCmSwCountTokensResponse) {');
    expect(CONTENT).toContain("type AiCmSwCountTokensRequest = import('../types/messages').AiCmSwCountTokensRequest;");
  });

  it('THRESHOLD_PCT и BADGE_RESET: ассерты на месте, отправка прежняя', () => {
    expect(CONTENT).toContain('} as AiCmSwThresholdPctRequest).catch(function () { });');
    expect(count(CONTENT, "{ type: 'BADGE_RESET' } as AiCmSwBadgeResetRequest")).toBe(2);
    expect(count(CONTENT, "chrome.runtime.sendMessage({ type: 'BADGE_RESET' } as AiCmSwBadgeResetRequest)")).toBe(2);
  });

  it('CONTEXT_UPDATE получил форму AiCmBroadcast, отправка прежняя', () => {
    expect(CONTENT).toContain('} as AiCmBroadcast).catch(() => { });');
    expect(CONTENT).toContain("type AiCmBroadcast = import('../types/messages').AiCmBroadcast;");
  });
});

const OPTIONS = raw('options/options.js');

describe('C2: types/messages.d.ts — контракты content и broadcast', () => {
  it('AiCmContentRequest: четыре канала, включая GET_STATS (живая ветка без отправителя)', () => {
    expect(MESSAGES).toContain('export type AiCmContentRequest =');
    ['aiCmDiag', 'aiCmExportCurrent', 'aiCm-byok-key-changed', 'GET_STATS'].forEach(function (t) {
      expect(MESSAGES).toContain("{ type: '" + t + "' }");
    });
  });

  it('AiCmDiagPayload/AiCmDiagResponse описывают фактический дамп', () => {
    expect(MESSAGES).toContain('export interface AiCmDiagPayload {');
    expect(MESSAGES).toContain('generatedAt: string;');
    expect(MESSAGES).toContain('logsContent: string[];');
    expect(MESSAGES).toContain('aiCmHistoryMeta: AiCmDiagHistoryMeta | null;');
    expect(MESSAGES).toContain('historyPreviews: string[];');
    expect(MESSAGES).toContain('intercept: unknown;');
    expect(MESSAGES).toContain('export interface AiCmDiagResponse {');
    expect(MESSAGES).toContain('diag: AiCmDiagPayload;');
  });

  it('AiCmManualSnapshot: поля снимка и надмножество messages', () => {
    expect(MESSAGES).toContain('export interface AiCmManualSnapshot {');
    expect(MESSAGES).toContain('isLowConfidenceBase: boolean;');
    expect(MESSAGES).toContain("partialReason?: 'incomplete' | 'stale' | 'shrank' | 'missing-user-text';");
    expect(MESSAGES).toContain('bodyProjection?: string;');
    expect(MESSAGES).toContain('messages: Array<{ role?: string; text?: string }>;');
    // конверт проводного ответа: content отвечает { data: manualSnapshot }, а не снимком
    expect(MESSAGES).toContain('export interface AiCmExportCurrentResponse {');
    expect(MESSAGES).toContain('data: AiCmManualSnapshot;');
  });

  it('карта ответов: diag/export/stats — формы, byok — void', () => {
    expect(MESSAGES).toContain('export interface AiCmContentResponseMap {');
    expect(MESSAGES).toContain('aiCmDiag: AiCmDiagResponse;');
    expect(MESSAGES).toContain('aiCmExportCurrent: AiCmExportCurrentResponse;');
    expect(MESSAGES).toContain("'aiCm-byok-key-changed': void;");
    expect(MESSAGES).toContain('GET_STATS: AiCmContentStatsResponse;');
    expect(MESSAGES).toContain('export type AiCmContentResponse =');
    expect(MESSAGES).toContain("export type AiCmContentResponseFor<T extends AiCmContentRequest> = AiCmContentResponseMap[T['type']];");
  });

  it('AiCmBroadcast: CONTEXT_UPDATE с полным data', () => {
    expect(MESSAGES).toContain('export interface AiCmBroadcast {');
    expect(MESSAGES).toContain("type: 'CONTEXT_UPDATE';");
    expect(MESSAGES).toContain('timestamp: number;');
  });

  it('нет индекс-подписи и подавлений типов', () => {
    expect(MESSAGES).not.toContain('[key: string]: any');
    expect(MESSAGES).not.toContain('@ts-ignore');
    expect(MESSAGES).not.toContain('@ts-nocheck');
    expect(MESSAGES).not.toContain('as any');
  });
});

describe('C2: core/content.ts — слушатель, diag и broadcast', () => {
  it('листенер типизирован AiCmContentRequest/AiCmContentResponse', () => {
    expect(CONTENT).toContain(
      '(message: AiCmContentRequest, sender: unknown, sendResponse: (response?: AiCmContentResponse) => void)'
    );
    expect(CONTENT).toContain("type AiCmContentRequest = import('../types/messages').AiCmContentRequest;");
    expect(CONTENT).toContain("type AiCmContentResponse = import('../types/messages').AiCmContentResponse;");
  });

  it('handleAiCmDiag отвечает AiCmDiagResponse, дамп — AiCmDiagPayload', () => {
    expect(CONTENT).toContain('function handleAiCmDiag(sendResponse: (response?: AiCmDiagResponse) => void): void {');
    expect(CONTENT).toContain('var diag: AiCmDiagPayload = {');
    expect(CONTENT).toContain("type AiCmDiagPayload = import('../types/messages').AiCmDiagPayload;");
    expect(CONTENT).toContain("type AiCmDiagResponse = import('../types/messages').AiCmDiagResponse;");
  });

  it('manualSnapshot объявлен AiCmManualSnapshot, ответ прежний', () => {
    expect(CONTENT).toContain('var manualSnapshot = /** @type {AiCmManualSnapshot} */');
    expect(CONTENT).toContain("type AiCmManualSnapshot = import('../types/messages').AiCmManualSnapshot;");
    expect(CONTENT).toContain('sendResponse({ data: manualSnapshot } as AiCmContentResponse);');
  });

  it('нет подавлений типов', () => {
    expect(CONTENT).not.toContain('@ts-ignore');
    expect(CONTENT).not.toContain('@ts-nocheck');
    expect(CONTENT).not.toContain('as any');
  });
});

describe('C2: options/options.js — отправители и колбэки', () => {
  it('aiCmExportCurrent: запрос AiCmContentRequest, ответ AiCmExportCurrentResponse', () => {
    expect(OPTIONS).toContain("({ type: 'aiCmExportCurrent' })");
    expect(OPTIONS).toContain("import('../types/messages').AiCmExportCurrentResponse | undefined");
    expect(OPTIONS).toContain('if (chrome.runtime.lastError || !resp || !resp.data) { cb(null); return; }');
  });

  it('aiCmDiag: запрос AiCmContentRequest, ответ AiCmDiagResponse', () => {
    expect(OPTIONS).toContain("({ type: 'aiCmDiag' })");
    expect(OPTIONS).toContain("import('../types/messages').AiCmDiagResponse | undefined");
    expect(OPTIONS).toContain("payload = (response && response.diag) ? response.diag : { error: 'пустой ответ', response: response || null };");
  });

  it('нет подавлений типов', () => {
    expect(OPTIONS).not.toContain('@ts-ignore');
    expect(OPTIONS).not.toContain('@ts-nocheck');
    expect(OPTIONS).not.toContain('as any');
  });
});

describe('C2: core/background.ts — сообщение в вкладку', () => {
  it('aiCm-byok-key-changed отправляется как AiCmContentRequest', () => {
    expect(BACKGROUND).toContain("{ type: 'aiCm-byok-key-changed' } as AiCmContentRequest");
    expect(BACKGROUND).toContain("chrome.tabs.sendMessage(tabs[iT].id, { type: 'aiCm-byok-key-changed' } as AiCmContentRequest, function () {");
  });

  it('нет подавлений типов', () => {
    expect(BACKGROUND).not.toContain('@ts-ignore');
    expect(BACKGROUND).not.toContain('@ts-nocheck');
    expect(BACKGROUND).not.toContain('as any');
  });
});
