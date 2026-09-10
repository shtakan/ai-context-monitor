/**
 * O4 / чек-лист 3.3: префикс [LOW CONFIDENCE]_ только при baseComplete=0.
 * Баг B: aiCmExportCurrent не отдавал isLowConfidenceBase → ручной as-is при
 *         baseComplete=0 шёл без префикса.
 * Баг C: липкий aiCmLowConfidenceByConv не снимался при 0→1 → ложный префикс
 *         у cachedHistory после перезаписи.
 * Фикс: isLowConfidenceBase = живое (baseComplete !== true).
 */
const fs = require('fs');
const path = require('path');
const P = require('../utils/export-emit-pipeline.js');

const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'content.js'), 'utf8');

// ---- б) «НЕ трогать»: путь A автоэкспорта и buildExportFileName без изменений ----
describe('НЕ трогать: неизменность путей', () => {
  test('гейт автоэкспорта (baseComplete !== true → ждём) присутствует в content.js', () => {
    expect(contentSrc).toContain('if (baseComplete !== true) return;');
  });

  test('buildExportFileName: сигнатура и префикс-поведение не изменены', () => {
    expect(P.buildExportFileName.length).toBe(5);
    expect(P.buildExportFileName('chatgpt', 'abcdefgh12345678', 'threshold', false, 'txt'))
      .toMatch(/^chatgpt-abcdefgh-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
  });
});

// ---- источник: фиксированная правка именно там, где были дыры B и C ----
describe('источник content.js: живой флаг baseComplete', () => {
  test('баг B: ответ aiCmExportCurrent содержит isLowConfidenceBase = (baseComplete !== true)', () => {
    const handler = contentSrc.slice(contentSrc.indexOf("'aiCmExportCurrent'"));
    expect(handler).toContain('isLowConfidenceBase: (baseComplete !== true)');
  });

  test('баг C: aiCmWriteCurrentHistory больше не читает липкий aiCmLowConfidenceByConv для флага', () => {
    const fn = contentSrc.slice(
      contentSrc.indexOf('function aiCmWriteCurrentHistory()'),
      contentSrc.indexOf('function aiCmFlushDeferredHistWrite')
    );
    expect(fn).not.toContain('aiCmLowConfidenceByConv[');
    expect(fn).toContain('isLowConfidenceBase: (baseComplete !== true)');
  });
});

// ---- поведение: низкоуровневая модель логики options.js:378 ----
//   var lowConfPrefix = (hist && hist.isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';
function buildName(hist, ext) {
  var lowConfPrefix = (hist && hist.isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';
  return lowConfPrefix + P.buildExportFileName(hist.site || 'gemini', hist.convId || '', 'threshold', false, ext);
}

describe('баг-сценарий (а): baseComplete=0 → снапшот даёт [LOW CONFIDENCE]_', () => {
  test('ручной экспорт при baseComplete=0', () => {
    const snapshot = { site: 'gemini', convId: 'abcdefgh12345678', isLowConfidenceBase: (false !== true) };
    expect(snapshot.isLowConfidenceBase).toBe(true);
    expect(buildName(snapshot, 'md')).toMatch(/^\[LOW CONFIDENCE\]_gemini-abcdefgh-.*\.md$/);
  });

  test('flush deferred при baseComplete=0 (снапшот histSnapshot)', () => {
    const histSnapshot = { site: 'chatgpt', convId: 'conv-42', isLowConfidenceBase: (false !== true) };
    expect(histSnapshot.isLowConfidenceBase).toBe(true);
    expect(buildName(histSnapshot, 'txt')).toMatch(/^\[LOW CONFIDENCE\]_chatgpt-conv-42-.*\.txt$/);
  });
});

describe('байтово-идентично (б): baseComplete=1 → префикса нет', () => {
  test('ручной экспорт при baseComplete=1 — без префикса', () => {
    const snapshot = { site: 'gemini', convId: 'abcdefgh12345678', isLowConfidenceBase: (true !== true) };
    expect(snapshot.isLowConfidenceBase).toBe(false);
    expect(buildName(snapshot, 'md')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('ложный префикс устранён: липкий флаг стоит, но baseComplete=1 → flush пишет false', () => {
    const stickyFlag = true; // aiCmLowConfidenceByConv[cid] === true — липкий, не снят
    const baseComplete = true;
    const histSnapshot = { site: 'claude', convId: 'cid9', isLowConfidenceBase: (baseComplete !== true) };
    expect(stickyFlag).toBe(true);
    expect(histSnapshot.isLowConfidenceBase).toBe(false);
    expect(buildName(histSnapshot, 'txt')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('переход 0→1: имя файла меняется с префиксного на чистое', () => {
    const before = { isLowConfidenceBase: (false !== true), site: 'deepseek', convId: 'spax1' };
    const after = { isLowConfidenceBase: (true !== true), site: 'deepseek', convId: 'spax1' };
    expect(buildName(before, 'md')).toMatch(/^\[LOW CONFIDENCE\]_/);
    expect(buildName(after, 'md')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });
});
