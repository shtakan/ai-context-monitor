/**
 * v2.0.35 (приёмка Фазы 3, шаг 2): AI Studio — автоэкспорт ждёт очередь вложений.
 *
 * Живой дефект: автоэкспорт срабатывал (reason=base-complete) раньше, чем MAIN-мир
 * догружал текст вложений (core/aistudio-files.js: ResolveDriveResource отдаёт только
 * Drive file id), и в файл уходила заглушка вместо `[FILE: <имя>]`. Очередь на странице
 * уже есть и публикуется как window.AiCmAistudioFiles.pending() (счётчик незавершённых
 * загрузок + отложенный ре-эмит снимка).
 *
 * Контракт фикса (core/base-handler.ts, рядом с дренажом DeepSeek/Qwen):
 *   1. aiCmFilesDrainDefer() — узкий гейт siteName === 'aistudio'; pending <= 0 →
 *      сразу пишем файл (поведение всех прочих сайтов не меняется);
 *   2. pending > 0 → файр откладывается на 500 мс и перепроверяется, повторные триггеры
 *      не плодят файлы (per-cid реестр таймеров);
 *   3. общий потолок ожидания 5000 мс: не дождались — пишем файл, чтобы не потерять экспорт;
 *   4. вызов стоит ПЕРВОЙ строкой doAutoExportDownload (core/export-manager.ts) под
 *      typeof-гардом, без слова aistudio в самом менеджере (R1: чужая платформа не
 *      проникает в проводку); срез-песочницы тестов без хелпера видят прежнее
 *      поведение 1:1; дренаж DeepSeek/Qwen не тронут.
 */
const fs = require('fs');
const { readCore } = require('./helpers/core-src.js');
const read = function (rel) { return readCore(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')); };
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = require('./helpers/content-source.js').contentSource;
const EXPORT_MANAGER_SRC = read('core/export-manager.ts');
const AISTUDIO_FILES_SRC = fs.readFileSync(path.join(ROOT, 'core', 'aistudio-files.js'), 'utf8');

// Рез по балансу фигурных скобок (как в tests/autoexport-export-isolation-e1.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

const SCOPE = 'with (ctx) { ' +
  fnDecl(CONTENT, 'aiCmAistudioFilesApi') + '\n' +
  fnDecl(CONTENT, 'aiCmAistudioFilesPending') + '\n' +
  fnDecl(CONTENT, 'aiCmFilesDrainDefer') + '\n' +
  ' return { defer: aiCmFilesDrainDefer, pending: aiCmAistudioFilesPending }; }';
const makeDrain = new Function('ctx', SCOPE);

const CID = 'aistudio-chat-42';

/** ctx песочницы: константы и реестры объявлены вне срезов, поэтому передаём их извне. */
function ctxFor(over) {
  const logs = [];
  const exports = [];
  const ctx = {
    AI_CM_AISTUDIO_DRAIN_STEP_MS: 500,
    AI_CM_AISTUDIO_DRAIN_CAP_MS: 5000,
    aiCmAistudioDrainTimers: Object.create(null),
    aiCmAistudioDrainDeadlines: Object.create(null),
    currentAdapter: { siteName: 'aistudio' },
    window: {},
    logs: logs,
    exports: exports,
    debugLog: function (level, msg) { logs.push(String(msg)); },
    doAutoExportDownload: null,
  };
  Object.assign(ctx, over || {});
  return ctx;
}

/**
 * Установка: api.defer — срезанная функция; doAutoExportDownload — её «настоящий» вызов:
 * отложено → выходим (файла нет), не отложено → файл пишется (здесь — запись в exports).
 */
function install(ctx) {
  const api = makeDrain(ctx);
  ctx.doAutoExportDownload = function (cid, percentage, reason, netSynced) {
    if (api.defer(cid, percentage, reason, netSynced)) return;
    ctx.exports.push({ cid: cid, percentage: percentage, reason: reason, netSynced: netSynced });
  };
  return api;
}

/** Очередь файлов страницы: mutable pending + учёт вызовов. */
function filesQueue(pendingRef, apiName) {
  const calls = [];
  const api = {
    calls: calls,
    pending: function (chatId) { calls.push(chatId); return pendingRef.pending; },
  };
  return api;
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

describe('aiCmAistudioDrainDefer: гейт и ожидание pending=0', () => {
  test('другой сайт (gemini) — ожидание не включается, файл пишется сразу', () => {
    const ctx = ctxFor({ currentAdapter: { siteName: 'gemini' } });
    install(ctx);
    ctx.doAutoExportDownload(CID, 95, 'threshold', false);
    expect(Object.keys(ctx.aiCmAistudioDrainTimers).length).toBe(0);
    expect(ctx.exports.length).toBe(1);
  });

  test('aistudio, очередь пуста — файл пишется сразу, таймеров нет', () => {
    const ref = { pending: 0 };
    const ctx = ctxFor({ window: { AiCmAistudioFiles: filesQueue(ref) } });
    install(ctx);
    ctx.doAutoExportDownload(CID, 95, 'base-complete', false);
    expect(ctx.exports.length).toBe(1);
    expect(ctx.exports[0]).toEqual({ cid: CID, percentage: 95, reason: 'base-complete', netSynced: false });
    expect(Object.keys(ctx.aiCmAistudioDrainTimers).length).toBe(0);
  });

  test('aistudio, pending=2 — файр отложен; после pending=0 и 500 мс файл пишется', () => {
    const ref = { pending: 2 };
    const q = filesQueue(ref);
    const ctx = ctxFor({ window: { AiCmAistudioFiles: q } });
    install(ctx);

    expect(ctx.doAutoExportDownload(CID, 95, 'base-complete', false)).toBeUndefined();
    expect(ctx.exports.length).toBe(0); // файла нет: ждём вложения
    expect(q.calls.length).toBeGreaterThan(0);
    expect(ctx.logs.some(function (m) { return m.indexOf('ждём очередь файлов') !== -1; })).toBe(true);

    jest.advanceTimersByTime(499);
    expect(ctx.exports.length).toBe(0); // шаг 500 мс ещё не истёк

    ref.pending = 0; // MAIN-мир выгрузил тексты вложений
    jest.advanceTimersByTime(1);
    expect(ctx.exports.length).toBe(1);
    expect(ctx.exports[0]).toEqual({ cid: CID, percentage: 95, reason: 'base-complete', netSynced: false });
  });

  test('pending не падает — повторный триггер не плодит файлы, держим до потолка 5000 мс', () => {
    const ref = { pending: 1 };
    const ctx = ctxFor({ window: { AiCmAistudioFiles: filesQueue(ref) } });
    install(ctx);

    ctx.doAutoExportDownload(CID, 95, 'threshold', false);
    // Девять шагов по 500 мс (до 4500 включительно) — очередь всё ещё не пуста
    jest.advanceTimersByTime(4500);
    expect(ctx.exports.length).toBe(0);
    // На 5000 мс срабатывает потолок: файл пишем, чтобы не потерять экспорт
    jest.advanceTimersByTime(500);
    expect(ctx.exports.length).toBe(1);
    expect(ctx.logs.some(function (m) { return m.indexOf('потолок ожидания — пишем файл') !== -1; })).toBe(true);
  });

  test('второй триггер во время ожидания не ставит второй таймер', () => {
    const ref = { pending: 3 };
    const ctx = ctxFor({ window: { AiCmAistudioFiles: filesQueue(ref) } });
    install(ctx);

    ctx.doAutoExportDownload(CID, 95, 'threshold', false);
    const firstTimer = ctx.aiCmAistudioDrainTimers[CID];
    ctx.doAutoExportDownload(CID, 95, 'threshold', false);
    expect(ctx.aiCmAistudioDrainTimers[CID]).toBe(firstTimer);
    expect(ctx.exports.length).toBe(0);
  });

  test('глобал из тикета (AiCmAiStudioFiles, с большой S) тоже читается', () => {
    const ref = { pending: 1 };
    const ctx = ctxFor({ window: { AiCmAiStudioFiles: filesQueue(ref) } });
    const api = install(ctx);
    expect(api.pending()).toBe(1);
    expect(api.defer(CID, 95, 'threshold', false)).toBe(true);
    ref.pending = 0;
    jest.advanceTimersByTime(500);
    expect(ctx.exports.length).toBe(1);
  });
});

describe('разводка export-manager → хелпер ожидания очереди (статические пины)', () => {
  test('doAutoExportDownload вызывает хелпер base-handler первой строкой под typeof-гардом', () => {
    const dl = fnDecl(CONTENT, 'doAutoExportDownload');
    const iTry = dl.indexOf('try {');
    const iGuard = dl.indexOf('aiCmFilesDrainDefer(cid, percentage, reason, netSynced)');
    expect(iTry).toBeGreaterThan(-1);
    expect(iGuard).toBeGreaterThan(iTry);
    expect(dl.slice(iTry, iGuard)).toContain("typeof filesApiD.aiCmFilesDrainDefer === 'function'");
    expect(dl.slice(iTry, iGuard)).toContain('window.AiCmBaseHandler');
    // вызов стоит ДО прежних гейтов (живой стрим / archive / base-pending)
    expect(iGuard).toBeLessThan(dl.indexOf('O-16'));
    // R1: в самом export-manager ни слова про aistudio — платформенный гейт живёт ниже
    expect(EXPORT_MANAGER_SRC).not.toContain('aistudio');
  });

  test('хелпер очереди: константы шага/потолка и оба имени глобала на месте', () => {
    expect(CONTENT).toContain('var AI_CM_AISTUDIO_DRAIN_STEP_MS = 500;');
    expect(CONTENT).toContain('var AI_CM_AISTUDIO_DRAIN_CAP_MS = 5000;');
    expect(CONTENT).toContain('w.AiCmAiStudioFiles || w.AiCmAistudioFiles');
    // siteName-гейт узкий: только AI Studio
    expect(CONTENT).toContain("currentAdapter.siteName !== 'aistudio'");
  });

  test('дренаж DeepSeek/Qwen не тронут (прежние вызовы байтово)', () => {
    expect(EXPORT_MANAGER_SRC).toContain('aiCmExportFilesDrainThen(cid, selfSync, 6000);');
    expect(EXPORT_MANAGER_SRC).toContain('aiCmExportFilesThenNetSync(cid, selfSync)');
  });

  test('страница публикует очередь: AiCmAistudioFiles.pending() и drainTimeoutMs=5000', () => {
    expect(AISTUDIO_FILES_SRC).toContain('window.AiCmAistudioFiles = Fn;');
    expect(AISTUDIO_FILES_SRC).toContain('Fn.pending = afPending;');
    expect(AISTUDIO_FILES_SRC).toContain('function afPendingCount(chatId) {');
    expect(AISTUDIO_FILES_SRC).toContain('drainTimeoutMs: AF_DRAIN_TIMEOUT_MS');
  });
});
