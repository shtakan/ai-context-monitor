'use strict';
/**
 * 2.4 Stage 5: песочница ручного экспорта.
 *
 * Загружает РЕАЛЬНЫЙ core/content-manual-export.ts (типы сняты штатным helper'ом
 * content-source, комментарии сохранены) и собирает dependency object из старого
 * ctx-словаря тестов (currentAdapter/window/lastTokensSnapshot/...). Это позволяет
 * поведенческим тестам вызывать вынесенный слушатель так же, как его зовёт content.ts.
 */

const { moduleSource } = require('./content-source.js');

const SRC = moduleSource('content-manual-export.ts');
const API = new Function(
  SRC + '\nreturn { handle: aiCmHandleManualExport, route: resolveManualExportRoute };'
)();

function fnOf(ctx, name) {
  return (ctx && typeof ctx[name] === 'function') ? ctx[name] : null;
}

function hostFromContext(ctx) {
  const host = {
    getCurrentConvId: function () {
      const fn = fnOf(ctx, 'getCurrentConvId');
      return fn ? (fn() || '') : '';
    },
    getHostname: function () {
      return (ctx.window && ctx.window.location && ctx.window.location.hostname) || ctx.hostname || '';
    },
    getSiteName: function () {
      return (ctx.currentAdapter && ctx.currentAdapter.siteName) || '';
    },
    getResolvedModelId: function () { return ctx.lastResolvedModelId || ''; },
    getSnapshotModelName: function () { return ctx.lastSnapshotModelName || ''; },
    getTokenCount: function () { return (typeof ctx.maxTokenCount === 'number') ? ctx.maxTokenCount : 0; },
    getPercentage: function () { return ctx.lastPercentage; },
    getTokenSnapshot: function () {
      return (typeof ctx.lastTokensSnapshot !== 'undefined' && ctx.lastTokensSnapshot) ? ctx.lastTokensSnapshot : null;
    },
    isBaseComplete: function () { return ctx.baseComplete === true; },
    getMessages: function () { return ctx.buildHistoryMessages(); },
    getLastDetailMessages: function () {
      return (typeof ctx.lastDetailMessages !== 'undefined') ? ctx.lastDetailMessages : null;
    },
    getEffectiveLimit: function (modelId) { return ctx.computeEffectiveLimit(modelId); },
    flushLiveStream: function (convId) {
      const fn = fnOf(ctx, 'aiCmFlushLiveStreamForExport');
      if (fn) fn(convId);
    },
    dumpTurnsSnapshot: function (tag, convId, messages) {
      const fn = fnOf(ctx, 'aiCmDumpTurnsSnapshot');
      if (fn) fn(tag, convId, messages);
    },
    swallowSoft: function (error, reason) {
      const fn = fnOf(ctx, 'swallowSoft');
      if (fn) fn(error, reason);
    },
    debugLog: function (level, message) {
      const fn = fnOf(ctx, 'debugLog');
      if (fn) fn(level, message);
    }
  };

  if (fnOf(ctx, 'aiCmCanonicalConvId')) {
    host.getCanonicalConvId = function (fallback) { return ctx.aiCmCanonicalConvId() || fallback; };
  }
  if (fnOf(ctx, 'aiCmReadContextSnapshot')) {
    host.readSnapshot = function (convId) { return ctx.aiCmReadContextSnapshot(convId); };
  }
  if (fnOf(ctx, 'aiCmGetSourceTier')) {
    host.getSourceTier = function () { return ctx.aiCmGetSourceTier(); };
  }
  if (fnOf(ctx, 'aiCmExportPartialView')) {
    host.partialView = function (snapshot) { return ctx.aiCmExportPartialView(snapshot); };
  }
  if (fnOf(ctx, 'aiCmQwenExportBaseTrusted')) {
    host.isQwenExportBaseTrusted = function () { return ctx.aiCmQwenExportBaseTrusted(); };
  }
  if (fnOf(ctx, 'aiCmUnionFileMessages')) {
    host.unionFileMessages = function (convId, messages, lowConfidence) {
      return ctx.aiCmUnionFileMessages(convId, messages, lowConfidence);
    };
  }
  if (fnOf(ctx, 'aiCmCanonicalizeMessages')) {
    host.canonicalizeMessages = function (messages, site) {
      return ctx.aiCmCanonicalizeMessages(messages, site);
    };
  }
  if (fnOf(ctx, 'aiCmProjectFileMessages')) {
    host.projectFileMessages = function (messages, site) {
      return ctx.aiCmProjectFileMessages(messages, site);
    };
  }
  if (fnOf(ctx, 'aiCmBuildCanonicalBody')) {
    host.buildCanonicalBody = function (convId) { return ctx.aiCmBuildCanonicalBody(convId); };
  }
  if (fnOf(ctx, 'exportDedupeInfo')) {
    host.dedupeInfo = function (detail, messages) { return ctx.exportDedupeInfo(detail, messages); };
  }
  if (fnOf(ctx, 'aiCmExportNetSyncSite')) {
    host.isNetSyncSite = function () { return ctx.aiCmExportNetSyncSite() === true; };
  }
  if (fnOf(ctx, 'aiCmExportFilesThenNetSync')) {
    host.filesThenNetSync = function (convId, cb) { ctx.aiCmExportFilesThenNetSync(convId, cb); };
  }
  if (fnOf(ctx, 'aiCmExportNetSyncThen')) {
    host.netSyncThen = function (convId, cb) { ctx.aiCmExportNetSyncThen(convId, cb); };
  }
  const filesApi = ctx.AiCmBaseHandler || (ctx.window && ctx.window.AiCmBaseHandler);
  if (filesApi && typeof filesApi.aiCmFilesDrainSite === 'function') {
    host.isFilesDrainSite = function () { return filesApi.aiCmFilesDrainSite() === true; };
  }
  if (filesApi && typeof filesApi.aiCmExportFilesDrainThen === 'function') {
    host.filesDrainThen = function (convId, cb, timeoutMs) {
      filesApi.aiCmExportFilesDrainThen(convId, cb, timeoutMs);
    };
  }
  return host;
}

function runManualExport(ctx) {
  API.handle(function (response) { ctx.sendResponse(response); }, hostFromContext(ctx));
}

module.exports = { API, hostFromContext, runManualExport };
