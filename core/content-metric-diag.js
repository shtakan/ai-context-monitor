/**
 * core/content-metric-diag.js — 2.4 Stage 8: диагностика gsa-metric-src.
 * Вынесено из processAndSend без изменения логики; host — локальные значения прохода.
 */
function aiCmLogMetricSource(host) {
  var svc = host.svc, fullText = host.fullText, tokenEstimate = host.tokenEstimate,
    aiCmMetricValueSrc = host.aiCmMetricValueSrc, countForTokens = host.countForTokens;
  try {
    var metricSrc = baseComplete ? 'base-complete' : (lastBounded ? 'base-floor+dom-tail' : 'base-floor');
    var metricSig = [metricSrc, aiCmMetricValueSrc, baseCount, (fullText ? fullText.length : 0), tokenEstimate, baseSeen ? 1 : 0].join('|');
    if (typeof aiCmDiagLine === 'function' && metricSig !== lastMetricSig) {
      lastMetricSig = metricSig;
      aiCmDiagLine('gsa-metric-src', {
        site: svc,
        src: metricSrc,
        // S4: источник САМОГО числа (dom|net|server) — обязан совпадать
        // с тем, что уйдёт в lastTokensSnapshot.src и в шапку файла.
        valueSrc: aiCmMetricValueSrc,
        baseSrc: (typeof aiCmBaseSource !== 'undefined') ? aiCmBaseSource : '',
        note: (!baseComplete && baseCount > 0) ? 'incomplete-canonical-floor' : '',
        msgs: baseCount,
        countForTokens: countForTokens,
        textLen: fullText ? fullText.length : 0,
        baseComplete: baseComplete ? 1 : 0,
        baseSeen: baseSeen ? 1 : 0,
        lastBounded: lastBounded ? 1 : 0,
        tokens: tokenEstimate,
        baseTextLen: baseText ? baseText.length : 0,
        threadId: lastThreadId || ''
      });
    }
  } catch (eMetricSrc) { }
}
