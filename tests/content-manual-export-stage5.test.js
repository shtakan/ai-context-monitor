'use strict';
/**
 * 2.4 Stage 5: core/content-manual-export.ts — поведенческие проверки выноса
 * ручного экспорта из core/content.ts.
 *
 * Вход — dependency object (те же значения, что content.ts собирает из состояния
 * и host-хелперов), выход — ответ aiCmExportCurrent и последовательность вызовов
 * flush/dump/file-drain/net-sync/канонизации/проекции/dedupe. Тест не читает
 * исходник продукта: модуль исполняется как в бандле (types сняты helper'ом).
 */

const { API, runManualExport } = require('./helpers/manual-export-runner.js');

function messages() {
  return [
    { role: 'user', text: 'Вопрос' },
    { role: 'assistant', text: 'Ответ' }
  ];
}

/**
 * Базовый ctx: успешный обычный чат с полной базой. Каждый тест переопределяет
 * только то, что проверяет; runManualExport собирает из ctx dependency object.
 */
function makeCtx(over) {
  const events = [];
  const sent = [];
  const ctx = {
    getCurrentConvId: function () { return 'conv-stage5'; },
    currentAdapter: { siteName: 'gemini' },
    window: { location: { hostname: 'gemini.google.com' } },
    lastPercentage: 12.5,
    maxTokenCount: 1234,
    lastSnapshotModelName: 'Gemini 3.8 Flash',
    lastResolvedModelId: 'gemini-3.8-flash',
    baseComplete: true,
    lastTokensSnapshot: { src: 'net' },
    lastDetailMessages: [{ role: 'user', text: 'detail-q' }],
    computeEffectiveLimit: function () { return 128000; },
    buildHistoryMessages: function () {
      events.push('build');
      return messages();
    },
    aiCmReadContextSnapshot: function () { return null; },
    aiCmFlushLiveStreamForExport: function (cid) { events.push('flush:' + cid); },
    aiCmDumpTurnsSnapshot: function (tag, cid, msgs) {
      events.push('dump:' + tag + ':' + cid + ':' + msgs.length);
    },
    swallowSoft: function () { events.push('swallow'); },
    debugLog: function (level, message) { events.push('debug:' + level + ':' + message); },
    aiCmExportNetSyncSite: function () { return false; },
    sendResponse: function (response) { events.push('send'); sent.push(response); }
  };
  Object.assign(ctx, over || {});
  return { ctx: ctx, events: events, sent: sent };
}

describe('2.4 Stage 5: resolveManualExportRoute — порядок ожиданий', function () {
  test('net-sync сайт: files+net приоритетнее чистого net', function () {
    expect(API.route({
      netSyncSite: true, hasFilesThenNetSync: true, hasNetSyncThen: true,
      filesDrainSite: true, hasFilesDrainThen: true
    })).toBe('files-then-net');
  });

  test('net-sync сайт без files-моста → net', function () {
    expect(API.route({
      netSyncSite: true, hasFilesThenNetSync: false, hasNetSyncThen: true,
      filesDrainSite: true, hasFilesDrainThen: true
    })).toBe('net');
  });

  test('net-sync сайт без мостов падает в дренаж файлов, если он доступен', function () {
    expect(API.route({
      netSyncSite: true, hasFilesThenNetSync: false, hasNetSyncThen: false,
      filesDrainSite: true, hasFilesDrainThen: true
    })).toBe('files-drain');
  });

  test('только дренаж файлов → files-drain; ничего нет → direct', function () {
    expect(API.route({
      netSyncSite: false, hasFilesThenNetSync: false, hasNetSyncThen: false,
      filesDrainSite: true, hasFilesDrainThen: true
    })).toBe('files-drain');
    expect(API.route({
      netSyncSite: false, hasFilesThenNetSync: false, hasNetSyncThen: false,
      filesDrainSite: false, hasFilesDrainThen: false
    })).toBe('direct');
  });
});

describe('2.4 Stage 5: прямой путь — flush → dump → сборка → ответ', function () {
  test('порядок вызовов и аргументы dump; sendResponse ровно один', function () {
    const h = makeCtx();
    runManualExport(h.ctx);

    expect(h.events).toEqual([
      'flush:conv-stage5',
      'build',                   // dump получает ту же сборку, что уходила в файл
      'dump:snapshot-at-manual:conv-stage5:2',
      'build',                   // снимок ответа собирается в колбэке (после ожиданий)
      'send'
    ]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].data.convId).toBe('conv-stage5');
  });

  test('процент: валидный → как есть, отрицательный/NaN/строка → 0', function () {
    [12.5, -1, NaN, '50'].forEach(function (pct) {
      const h = makeCtx({ lastPercentage: pct });
      runManualExport(h.ctx);
      expect(h.sent[0].data.percent).toBe(pct === 12.5 ? 12.5 : 0);
    });
  });

  test('обычный чат: снапшот даёт модель/лимиты, src из токен-снимка, partial из снимка', function () {
    const snap = {
      modelName: 'Gemini 3.8 Flash (snap)', limit: 32768, contextLimit: 1048576,
      windowLimit: 1048576, accountLimit: 32768, limitPlan: 'free',
      limitWarnings: ['plan-unknown'], saturated: true, partial: true, partialReason: 'stale'
    };
    const h = makeCtx({
      aiCmReadContextSnapshot: function () { return snap; },
      aiCmGetSourceTier: function () { return '[BEST-EFFORT: LIVE CAPTURE]'; }
    });
    runManualExport(h.ctx);

    const data = h.sent[0].data;
    expect(data.host).toBe('gemini.google.com');
    expect(data.site).toBe('gemini');
    expect(data.model).toBe('Gemini 3.8 Flash (snap)');
    expect(data.tokens).toBe(1234);
    expect(data.limit).toBe(32768);
    expect(data.displayLimit).toBe(32768);
    expect(data.windowLimit).toBe(1048576);
    expect(data.accountLimit).toBe(32768);
    expect(data.limitPlan).toBe('free');
    expect(data.limitWarnings).toEqual(['plan-unknown']);
    expect(data.saturated).toBe(true);
    expect(data.src).toBe('net');
    expect(data.sourceTier).toBe('[BEST-EFFORT: LIVE CAPTURE]');
    expect(data.partial).toBe(true);
    expect(data.partialReason).toBe('stale');
    expect(data.isLowConfidenceBase).toBe(false);
  });

  test('без снимка: model — из lastSnapshotModelName, limit — computeEffectiveLimit, меток нет', function () {
    const h = makeCtx({ lastSnapshotModelName: '', lastResolvedModelId: 'fallback-model' });
    runManualExport(h.ctx);

    const data = h.sent[0].data;
    expect(data.model).toBe('fallback-model');
    expect(data.limit).toBe(128000);
    expect(data.windowLimit).toBeUndefined();
    expect(data.displayLimit).toBeUndefined();
    expect(data.accountLimit).toBeUndefined();
    expect(data.partial).toBeUndefined();
    expect(data.partialReason).toBeUndefined();
  });
});

describe('2.4 Stage 5: ожидания file-drain / net-sync', function () {
  test('net-sync: ответ не уходит до колбэка; сборка базы — внутри колбэка', function () {
    const callbacks = [];
    const h = makeCtx({
      aiCmExportNetSyncSite: function () { return true; },
      aiCmExportNetSyncThen: function (cid, cb) {
        h.events.push('net:' + cid);
        callbacks.push(cb);
      }
    });
    runManualExport(h.ctx);

    expect(h.sent).toHaveLength(0);
    expect(h.events).toEqual([
      'flush:conv-stage5',
      'build',
      'dump:snapshot-at-manual:conv-stage5:2',
      'net:conv-stage5'
    ]);
    callbacks[0]();
    expect(h.events).toEqual([
      'flush:conv-stage5',
      'build',
      'dump:snapshot-at-manual:conv-stage5:2',
      'net:conv-stage5',
      'build',
      'send'
    ]);
    expect(h.sent).toHaveLength(1);
  });

  test('files+net: вызывается aiCmExportFilesThenNetSync, чистый net не трогается', function () {
    const h = makeCtx({
      aiCmExportNetSyncSite: function () { return true; },
      aiCmExportFilesThenNetSync: function (cid, cb) {
        h.events.push('files-then-net:' + cid);
        cb();
      },
      aiCmExportNetSyncThen: function () { h.events.push('net'); }
    });
    runManualExport(h.ctx);

    expect(h.events).toContain('files-then-net:conv-stage5');
    expect(h.events).not.toContain('net');
    expect(h.sent).toHaveLength(1);
  });

  test('дренаж файлов: 6000 мс, затем сборка и ответ', function () {
    const drains = [];
    const h = makeCtx({
      AiCmBaseHandler: {
        aiCmFilesDrainSite: function () { return true; },
        aiCmExportFilesDrainThen: function (cid, cb, timeoutMs) {
          drains.push({ cid: cid, timeoutMs: timeoutMs });
          h.events.push('drain:' + cid + ':' + timeoutMs);
          cb();
        }
      }
    });
    runManualExport(h.ctx);

    expect(drains).toEqual([{ cid: 'conv-stage5', timeoutMs: 6000 }]);
    expect(h.events).toContain('drain:conv-stage5:6000');
    expect(h.sent).toHaveLength(1);
  });
});

describe('2.4 Stage 5: low-confidence — union → канонизация → проекция', function () {
  test('union-путь: массив файла из объединения, drop/reasoning один раз, dedupe — по финалу', function () {
    const union = [
      { role: 'assistant', text: 'Ответ\nВопрос' },   // контейнер: canonicalize его снимет
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: 'Ответ', reasoning: 'R' }
    ];
    const canonical = [
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: 'Ответ', reasoning: 'R' }
    ];
    const projected = canonical.map(function (m) { return Object.assign({}, m); });
    const calls = [];
    const h = makeCtx({
      baseComplete: false,
      aiCmReadContextSnapshot: function () {
        return { partial: true, partialReason: 'shrank' };
      },
      aiCmUnionFileMessages: function (cid, msgs, low) {
        calls.push(['union', cid, low]);
        return union.map(function (m) { return Object.assign({}, m); });
      },
      aiCmCanonicalizeMessages: function (msgs, site) {
        calls.push(['canon', site, msgs.length]);
        return canonical.map(function (m) { return Object.assign({}, m); });
      },
      aiCmProjectFileMessages: function (msgs, site) {
        calls.push(['project', site, msgs.length]);
        return { messages: projected, mode: 'projected' };
      },
      aiCmBuildCanonicalBody: function () {
        throw new Error('union-путь не должен звать buildCanonicalBody');
      },
      exportDedupeInfo: function (detail, msgs) {
        calls.push(['dedupe', detail.length, msgs.length]);
        return { input: 3, output: 2, removedUsers: 0, foldedAssistants: 1 };
      }
    });
    runManualExport(h.ctx);

    const data = h.sent[0].data;
    expect(data.isLowConfidenceBase).toBe(true);
    expect(data.partial).toBe(true);
    expect(data.partialReason).toBe('shrank');
    expect(data.messages).toEqual(projected);
    expect(data.bodyProjection).toBe('projected');
    expect(calls).toEqual([
      ['union', 'conv-stage5', true],
      ['canon', 'gemini', 3],
      ['project', 'gemini', 2],
      ['dedupe', 1, 2]
    ]);
    expect(data.dedupe).toEqual({ input: 3, output: 2, removedUsers: 0, foldedAssistants: 1 });
  });

  test('обычный чат: buildCanonicalBody → project; dedupe видит финальный массив', function () {
    const body = [{ role: 'user', text: 'Вопрос' }, { role: 'assistant', text: 'Ответ' }];
    const projected = [{ role: 'user', text: 'Вопрос' }, { role: 'assistant', text: 'Ответ' }];
    const calls = [];
    const h = makeCtx({
      aiCmBuildCanonicalBody: function (cid) { calls.push(['body', cid]); return { messages: body }; },
      aiCmProjectFileMessages: function (msgs, site) {
        calls.push(['project', site, msgs === body]);
        return { messages: projected, mode: '' };
      },
      exportDedupeInfo: function (detail, msgs) {
        calls.push(['dedupe', detail, msgs]);
        return undefined;
      }
    });
    runManualExport(h.ctx);

    const data = h.sent[0].data;
    expect(data.messages).toEqual(projected);
    expect(data.bodyProjection).toBe('');
    expect(calls[0]).toEqual(['body', 'conv-stage5']);
    expect(calls[1]).toEqual(['project', 'gemini', true]);
    expect(calls[2][0]).toBe('dedupe');
    expect(calls[2][2]).toBe(projected);
  });

  test('GSA: low-confidence берётся из partial снимка, а не из baseComplete', function () {
    const h = makeCtx({
      currentAdapter: { siteName: 'google_search' },
      baseComplete: true,
      aiCmReadContextSnapshot: function () { return { partial: true }; }
    });
    runManualExport(h.ctx);
    expect(h.sent[0].data.isLowConfidenceBase).toBe(true);
  });

  test('qwen с принятой адаптерной базой: low-confidence снимается, baseComplete не подменяется', function () {
    const h = makeCtx({
      currentAdapter: { siteName: 'qwen' },
      baseComplete: false,
      aiCmQwenExportBaseTrusted: function () { return true; }
    });
    runManualExport(h.ctx);
    expect(h.sent[0].data.isLowConfidenceBase).toBe(false);
  });
});

describe('2.4 Stage 5: деградация без optional-хелперов', function () {
  test('нет читателя снимка/union/канонизации/проекции/dedupe — сырой массив и никаких меток', function () {
    const h = makeCtx({ baseComplete: false });
    delete h.ctx.aiCmReadContextSnapshot;
    runManualExport(h.ctx);

    const data = h.sent[0].data;
    expect(data.messages).toEqual(messages());
    expect(data.partial).toBeUndefined();
    expect(data.partialReason).toBeUndefined();
    expect(data.dedupe).toBeUndefined();
    expect(data.isLowConfidenceBase).toBe(true);
  });

  test('ошибка union не роняет ответ: debugLog с причиной, файл остаётся локальным', function () {
    const h = makeCtx({
      baseComplete: false,
      aiCmUnionFileMessages: function () { throw new Error('boom'); }
    });
    runManualExport(h.ctx);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].data.messages).toEqual(messages());
    expect(h.events.some(function (e) { return e.indexOf('debug:log:[AI CM][export] silent-catch replyManualExport(O-49 union): boom') === 0; })).toBe(true);
  });
});
