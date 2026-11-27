'use strict';
/**
 * Stage 0 (2.4): характеризационный пробник `processAndSend`.
 *
 * Цель — зафиксировать ТЕКУЩЕЕ поведение до рефакторинга: входное состояние
 * (baseSeen/baseComplete/baseCount/tokens/limit/...) → решение и последовательность
 * вызовов (updateWidget, sendThresholdPct, aiCmScheduleAutoExport, commit снимка,
 * запись истории, CONTEXT_UPDATE).
 *
 * Продукт не меняется: пробник режет реальную `processAndSend` из contentSource
 * (тот же исполнимый текст, что в браузере) и запускает её в песочнице `with (ctx)`.
 * Все зависимости — явные стубы; необязательные помощники, которых нет в сценарии,
 * остаются undefined, поэтому их typeof-гарды ведут себя как в живом коде.
 */

const { contentSource, moduleSource } = require('./content-source.js');

/** Срез функции по балансу фигурных скобок. */
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced function: ' + name);
}

const PROCESS_SRC = fnDecl(contentSource, 'processAndSend');
const PUBLISH_SRC = fnDecl(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'core', 'content-publish.js'), 'utf8'), 'aiCmPublishAfterMetric');
const SNAPSHOT_POLICY_SRC = fnDecl(moduleSource('content-snapshot-policy.ts'), 'resolveSnapshotPolicy');
const THRESHOLD_POLICY_SRC = fnDecl(moduleSource('content-threshold-policy.ts'), 'resolveBadgePolicy') + '\n' +
  fnDecl(moduleSource('content-threshold-policy.ts'), 'resolveThresholdPolicy');

function makeProbe(over) {
  const o = over || {};
  const state = Object.assign({
    site: 'chatgpt',
    convId: 'conv-test',
    isInitialized: true,
    baseSeen: true,
    baseComplete: true,
    baseCount: 10,
    baseText: 'base text',
    lastBaseTexts: ['q', 'a'],
    lastDetailMessages: null,
    fullText: 'base text',
    countForTokens: 10,
    tokens: 10000,
    serverTokens: 0,
    windowLimit: 128000,
    displayLimit: 128000,
    modelId: 'test-model',
    modelName: 'Test Model',
    saturated: false,
    adapterMessages: [],
    adapterBaseSeen: false,
    badgeSuppressed: false,
    loaderFreeze: false,
    badgeHold: false,
    netPending: false,
    trustedBase: true,
    partial: false,
    partialReason: '',
    stopActive: false,
    sourceKind: 'net',
    baseSource: 'net',
    priorSnapshot: null,
    lastPercentage: -1,
    maxTokenCount: 0,
    lastHistoryWroteKey: null
  }, o.state || {});

  const calls = {
    updateWidget: [],
    thresholds: [],
    autoExport: [],
    commits: [],
    historySet: [],
    stateSet: [],
    stateRemove: [],
    deferred: [],
    cancels: [],
    historyMessages: [],
    runtimeMessages: [],
    diag: [],
    events: []
  };
  const logs = [];
  let committedSnapshot = null;
  const cid = state.convId;

  const ctx = {
    // ---- state -------------------------------------------------------------
    currentAdapter: {
      siteName: state.site,
      extractMessages: function () { return state.adapterMessages || []; },
      getFullDialogText: function () { return state.fullText || ''; }
    },
    location: { href: 'https://example.test/c/' + cid, pathname: '/c/' + cid },
    currentAdapterBaseCount: 0,
    isInitialized: state.isInitialized,
    baseSeen: state.baseSeen,
    baseComplete: state.baseComplete,
    baseCount: state.baseCount,
    baseText: state.baseText,
    lastBaseTexts: state.lastBaseTexts || [],
    lastDetailMessages: state.lastDetailMessages || null,
    baseCompleteReason: (typeof state.baseCompleteReason === 'string' && state.baseCompleteReason)
      ? state.baseCompleteReason
      : (state.baseComplete ? 'complete' : 'incomplete'),
    lastEmitConvId: cid,
    adapterBaseSeen: state.adapterBaseSeen === true,
    badgeSuppressed: state.badgeSuppressed === true,
    aiCmLoaderFreeze: state.loaderFreeze === true,
    stale: false,
    lastPercentage: state.lastPercentage,
    maxTokenCount: state.maxTokenCount,
    lastBounded: false,
    lastTokensSnapshot: state.priorSnapshot,
    lastWidgetData: null,
    lastHistoryWroteKey: state.lastHistoryWroteKey,
    lastDrawSig: null,
    lastMetricSig: null,
    lastCtxSnapSig: null,
    lastSnapshotModelName: state.modelName,
    detectedModelSlug: '',
    netAttachTokens: 0,
    netAttachBreak: null,
    netServerTokens: 0,
    aiCmBaseSource: state.baseSource,
    restoredTapeLoaded: true,
    aiCmArchiveLoadStarted: {},
    tapeRestoreSeen: {},
    aiCmTapeAccountIdx: {},
    aiCmRestoredDispatched: {},
    cacheRefreshPlanned: {},
    autoExportSettings: { enabled: false },
    autoExportLastPct: -1,
    aiCmLoaderRunningByConv: {},
    aiCmBaseConfirmedByConv: {},
    aiCmLowConfidenceByConv: {},
    aiCmProactiveEnabled: true,

    // ---- state readers / pure helpers -------------------------------------
    getCurrentConvId: function () { return cid; },
    aiCmCanonicalConvId: function () { return cid; },
    aiCmAutoExportConvId: function () { return cid; },
    aiCmHistoryConvId: function () { return cid; },
    getServiceKey: function () { return state.site; },
    aiCmAdapterBaseSeen: function () { return state.adapterBaseSeen === true; },
    aiCmBadgeHoldActive: function () { return state.badgeHold === true; },
    aiCmNetSnapshotPending: function () { return state.netPending === true; },
    aiCmAutoExportTrustedBase: function () { return state.trustedBase !== false; },
    aiCmSnapshotPartial: function () { return state.partial === true; },
    aiCmCtxStopActive: function () { return state.stopActive === true; },
    aiCmExportPartialView: function () {
      return { partial: state.partial === true ? true : undefined, partialReason: state.partial ? (state.partialReason || 'incomplete') : undefined };
    },
    aiCmPartialReasonFromBase: function (reason, stop) {
      return stop ? 'stop' : (state.partialReason || reason || 'incomplete');
    },
    aiCmSourceInfo: function () { return { kind: state.sourceKind, label: state.sourceKind === 'net' ? 'live (сеть/DOM)' : 'adapter' }; },
    aiCmChatGptContextSaturated: function () { return state.saturated === true; },
    aiCmActivePct: function () { return null; },
    aiCmHeuristicHoldForByok: function () { return false; },
    aiCmDiagLine: function (name, fields) { calls.diag.push({ name: name, fields: fields || {} }); },
    aiCmDiagOn: function () { return true; },
    aiCmDiagStack: function () { return ''; },
    aiCmQwenInitDiag: function () { },
    debugLog: function (level, msg) { logs.push(String(msg)); },
    swallowSoft: function (e, tag) { logs.push('swallowSoft ' + (tag || '') + ': ' + ((e && e.message) || e)); },
    swallow: function (e, tag) { logs.push('swallow ' + (tag || '') + ': ' + ((e && e.message) || e)); },
    setInterval: function () { return 0; },
    setTimeout: function () { return 0; },
    clearTimeout: function () { },

    // ---- metrics / model ---------------------------------------------------
    resolveCurrentModel: function () { return state.modelId; },
    getEffectiveText: function () { return state.fullText; },
    getEffectiveCount: function (n) { return state.countForTokens || n; },
    getEffectiveMessages: function () { return state.fullText ? [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] : null; },
    aiCmBuildCanonicalBody: function () {
      return { text: state.fullText, chars: String(state.fullText || '').length, msgs: 2, bodyHash: 'probe-hash' };
    },
    canonicalBody: function () { return { text: state.fullText, chars: String(state.fullText || '').length, msgs: 2, bodyHash: 'probe-hash' }; },
    aiCmTokenSnapshot: function () { return { tokens: state.tokens, serverTokens: state.serverTokens || 0 }; },
    resolveLimitModel: function () {
      return {
        windowKnown: true,
        modelWindow: state.windowLimit,
        displayLimit: state.displayLimit,
        accountLimit: null,
        plan: null,
        warnings: []
      };
    },
    ModelConfig: {
      getModel: function () { return { name: state.modelName }; },
      getContextLimit: function () { return state.windowLimit; },
      getEffectiveLimit: function () { return state.displayLimit; },
      applyLimitPct: function (limit) { return limit; }
    },
    aiCmGeminiPlan: null,
    exactCountEnabled: false,
    geminiApiKey: '',
    requestExactTokens: function () { },
    aiCmAistudioNativePromptTokens: function () { return 0; },
    aiCmV2MetricsDualRun: function () { return null; },
    aiCmV2MetricsProbe: function () { return null; },

    // ---- snapshot commit / widget -----------------------------------------
    aiCmCommitContextSnapshot: function (prev, cand) {
      calls.commits.push(Object.assign({}, cand));
      committedSnapshot = Object.assign({}, cand);
      return committedSnapshot;
    },
    aiCmReadContextSnapshot: function () { return committedSnapshot || state.priorSnapshot; },
    aiCmWidgetDataFromSnapshot: function (snap) {
      if (!snap) return null;
      return {
        percentage: snap.percent,
        tokenEstimate: snap.tokens,
        effectiveLimit: snap.effectiveLimit,
        contextLimit: snap.contextLimit,
        displayLimit: snap.limit,
        modelName: snap.modelName,
        attachBreak: snap.attachBreak
      };
    },
    aiCmStatePatchFromSnapshot: function (snap) {
      if (!snap) return {};
      return {
        percentage: snap.percent,
        tokenEstimate: snap.tokens,
        displayLimit: snap.limit,
        windowLimit: snap.contextLimit,
        accountLimit: snap.accountLimit,
        limitPlan: snap.limitPlan,
        limitWarnings: snap.limitWarnings,
        modelName: snap.modelName,
        saturated: snap.saturated
      };
    },
    updateWidget: function () { calls.updateWidget.push(Array.prototype.slice.call(arguments)); },
    sendThresholdPct: function (pct) { calls.thresholds.push(pct); },
    aiCmScheduleAutoExport: function (pct) { calls.autoExport.push(pct); },
    aiCmScheduleDeferredHistWrite: function (v) { calls.deferred.push(v); },
    aiCmCancelDeferredHistWrite: function (v) { calls.cancels.push(v); },
    aiCmTryGeminiDomBase: function () { },
    aiCmGsaResetStaleStateOnChatlessDoc: function () { },
    aiCmAistudioDomCacheSave: function () { },
    aiCmLoadArchiveTier: function () { },
    GeminiTapeStore: { load: function () { return Promise.resolve(null); }, save: function () { }, cleanup: function () { } },
    buildHistoryMessages: function () { var m = state.historyMessages || [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]; calls.historyMessages.push(m.length); return m; },
    aiCmHostHistoryRecord: function (x) { return x; },
    aiCmGsaNetworkCompleteIs: function () { return false; },
    aiCmDiagHash6: function () { return 'abcdef'; },
    aiCmQwenSpaResetAt: 0,

    // ---- extension / storage ----------------------------------------------
    isExtensionValid: function () { return true; },
    chrome: {
      storage: {
        local: {
          set: function (patch) { calls.stateSet.push(patch); },
          remove: function (keys) { calls.stateRemove.push(keys); }
        }
      },
      runtime: {
        sendMessage: function (msg) { calls.runtimeMessages.push(msg); return Promise.resolve(); }
      }
    },
    window: {
      location: { href: 'https://example.test/c/' + cid, hostname: 'example.test' },
      __aiCmTraceSeq: 0,
      dispatchEvent: function (ev) { calls.events.push(ev && ev.type); return true; }
    },
    document: { visibilityState: 'visible' },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    Date: Date,
    Math: Math,
    JSON: JSON,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Promise: Promise,
    Set: Set,
    Map: Map,
    RegExp: RegExp,
    Error: Error,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    Infinity: Infinity,
    NaN: NaN,
    undefined: undefined
  };
  const fn = new Function('ctx', 'with (ctx) { ' + SNAPSHOT_POLICY_SRC + '\n' + THRESHOLD_POLICY_SRC + '\n' + PUBLISH_SRC + '\n' + PROCESS_SRC + '\n return processAndSend; }')(ctx);

  function run(patch) {
    if (patch && typeof patch === 'object') {
      Object.assign(state, patch);
      Object.assign(ctx, patch);
      if (Object.prototype.hasOwnProperty.call(patch, 'baseSource')) ctx.aiCmBaseSource = patch.baseSource;
    }
    fn();
    return result();
  }
  function result() {
    var commits = calls.commits.slice();
    return {
      state: ctx,
      calls: calls,
      logs: logs.slice(),
      updateWidget: calls.updateWidget[calls.updateWidget.length - 1] || null,
      thresholds: calls.thresholds.slice(),
      autoExport: calls.autoExport.slice(),
      commit: commits[commits.length - 1] || null,
      commits: commits,
      historyWrites: calls.stateSet.filter(function (p) { return p && p.aiCmHistory; }),
      stateWrites: calls.stateSet.filter(function (p) { return p && p.aiCmState; }),
      stateRemove: calls.stateRemove.slice(),
      historyMessages: calls.historyMessages.slice(),
      runtimeMessages: calls.runtimeMessages.slice(),
      deferred: calls.deferred.slice(),
      cancels: calls.cancels.slice(),
      diag: calls.diag.slice()
    };
  }
  return { ctx: ctx, state: state, calls: calls, logs: logs, run: run, result: result };
}

module.exports = { makeProbe, fnDecl, PROCESS_SRC };
