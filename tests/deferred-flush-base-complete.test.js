/**
 * v83: flush deferred aiCmHistory при переходе baseComplete 0→1.
 * Баг: loader-stop при base-unconfirmed → deferred kept; полнота после стопа —
 * flush не вызывался до 60s. Фикс: вызов aiCmFlushDeferredHistWrite(cid79,'base-complete')
 * в блоке completeTransition79.
 */
const fs = require('fs');
const path = require('path');

const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'content.js'), 'utf8');

function makeFlushTraced() {
  const start = contentSrc.indexOf('function aiCmFlushDeferredHistWrite');
  const end = contentSrc.indexOf('function aiCmScheduleDeferredHistWrite');
  let fnSrc = contentSrc.slice(start, end);
  fnSrc = fnSrc.replace('aiCmWriteCurrentHistory();', 'S.flushed.push(reason); aiCmWriteCurrentHistory();');
  // перенаправляем мутируемые глобалы в песочницу S, чтобы видеть эффект флаша
  fnSrc = fnSrc
    .split('aiCmPendingHistWrite').join('S.aiCmPendingHistWrite')
    .split('aiCmLoaderRunningByConv').join('S.aiCmLoaderRunningByConv')
    .split('baseComplete').join('S.baseComplete');
  const sandbox = { flushed: [], wrote: 0, cleared: 0, aiCmPendingHistWrite: null, aiCmLoaderRunningByConv: {}, baseComplete: false };
  sandbox.clearTimeout = () => { sandbox.cleared++; };
  sandbox.debugLog = () => {};
  sandbox.aiCmWriteCurrentHistory = () => { sandbox.wrote++; };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'clearTimeout', 'debugLog', 'aiCmWriteCurrentHistory', 'S', 'cid', 'reason',
    fnSrc + '; aiCmFlushDeferredHistWrite(cid, reason);'
  );
  sandbox.run = (cid, reason) => fn(sandbox.clearTimeout, sandbox.debugLog, sandbox.aiCmWriteCurrentHistory, sandbox, cid, reason);
  return sandbox;
}

function makePending(convId) {
  return { convId, timer: 't' };
}

// ---- (а) баг-сценарий ----
describe('баг-сценарий: deferred pending + полнота после loader-stop (0→1)', () => {
  test('flush reason=base-complete, pending снят, aiCmWriteCurrentHistory вызван', () => {
    const sb = makeFlushTraced();
    sb.aiCmPendingHistWrite = makePending('conv-A');
    sb.aiCmLoaderRunningByConv['conv-A'] = false;
    sb.baseComplete = true;
    sb.run('conv-A', 'base-complete');
    expect(sb.flushed).toEqual(['base-complete']);
    expect(sb.aiCmPendingHistWrite).toBeNull();
    expect(sb.wrote).toBe(1);
    expect(sb.cleared).toBe(1);
  });

  test('источник: в блоке completeTransition79 есть вызов base-complete', () => {
    const seg = contentSrc.slice(contentSrc.indexOf('if (completeTransition79)'));
    expect(seg).toContain("aiCmFlushDeferredHistWrite(cid79, 'base-complete')");
  });
});

// ---- (б) байтово-идентично ----
describe('байтово-идентично: прежние ветки flush не изменены', () => {
  test('0→1 без pending — no-op', () => {
    const sb = makeFlushTraced();
    sb.baseComplete = true;
    sb.aiCmPendingHistWrite = null;
    sb.run('conv-A', 'base-complete');
    expect(sb.flushed).toEqual([]);
    expect(sb.wrote).toBe(0);
  });

  test('loader-stop confirmed flush как прежде', () => {
    const sb = makeFlushTraced();
    sb.aiCmPendingHistWrite = makePending('conv-B');
    sb.baseComplete = true;
    sb.aiCmLoaderRunningByConv['conv-B'] = false;
    sb.run('conv-B', 'loader-stop');
    expect(sb.flushed).toEqual(['loader-stop']);
    expect(sb.wrote).toBe(1);
  });

  test('loader-stop при base-unconfirmed → deferred kept', () => {
    const sb = makeFlushTraced();
    sb.aiCmPendingHistWrite = makePending('conv-C');
    sb.baseComplete = false;
    sb.aiCmLoaderRunningByConv['conv-C'] = false;
    sb.run('conv-C', 'loader-stop');
    expect(sb.flushed).toEqual([]);
    expect(sb.aiCmPendingHistWrite).not.toBeNull();
  });

  test('timeout as-is флашится даже при baseComplete=0', () => {
    const sb = makeFlushTraced();
    sb.aiCmPendingHistWrite = makePending('conv-D');
    sb.baseComplete = false;
    sb.aiCmLoaderRunningByConv['conv-D'] = true;
    sb.run('conv-D', 'timeout');
    expect(sb.flushed).toEqual(['timeout']);
    expect(sb.wrote).toBe(1);
  });

  test('чужой convId — не флашим', () => {
    const sb = makeFlushTraced();
    sb.aiCmPendingHistWrite = makePending('conv-E');
    sb.baseComplete = true;
    sb.run('conv-OTHER', 'base-complete');
    expect(sb.flushed).toEqual([]);
  });

  test('работающий лоадер — не флашим (гейт loaderRunning)', () => {
    const sb = makeFlushTraced();
    sb.aiCmPendingHistWrite = makePending('conv-F');
    sb.baseComplete = true;
    sb.aiCmLoaderRunningByConv['conv-F'] = true;
    sb.run('conv-F', 'base-complete');
    expect(sb.flushed).toEqual([]);
  });

  test('источник: loader-stop и timeout вызовы в content.js не изменены', () => {
    expect(contentSrc).toContain("aiCmFlushDeferredHistWrite(d.convId, 'loader-stop')");
    expect(contentSrc).toMatch(/aiCmFlushDeferredHistWrite\([^)]*'base-complete'\)/);
  });
});

// ---- (в) «НЕ трогать» ----
describe('НЕ трогать: O4-живой флаг и гейты автоэкспорта', () => {
  test('isLowConfidenceBase остаётся живым флагом (baseComplete !== true)', () => {
    expect(contentSrc).toContain('isLowConfidenceBase: (baseComplete !== true)');
  });

  test('гейт автоэкспорта присутствует', () => {
    expect(contentSrc).toContain('if (baseComplete !== true) return;');
  });

  test('60s-таймаут и его маркировка [LOW CONFIDENCE]_ не тронуты', () => {
    expect(contentSrc).toContain('aiCmLowConfidenceByConv[cid] = true;');
    expect(contentSrc).toContain('deferred-timeout(60s), exporting as-is');
    expect(contentSrc).toContain('if (baseComplete !== true) {');
  });

  test('тело aiCmFlushDeferredHistWrite содержит исходные гарды', () => {
    const fnSrc = contentSrc.slice(
      contentSrc.indexOf('function aiCmFlushDeferredHistWrite'),
      contentSrc.indexOf('function aiCmScheduleDeferredHistWrite')
    );
    expect(fnSrc).toContain("if (reason !== 'timeout' && !(baseComplete === true && !aiCmLoaderRunningByConv[p.convId])) return;");
    expect(fnSrc).toContain('if (cid && p.convId !== cid) return;');
  });
});
