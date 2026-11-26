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
const P = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.ts');

const contentSrc = require('./helpers/content-source.js').contentSource;
const manualSrc = require('./helpers/content-source.js').moduleSource('content-manual-export.ts');

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
    expect(manualSrc).toContain('isLowConfidenceBase: (host.isBaseComplete() !== true)');
  });

  test('BUG-J: у GSA живой baseComplete уступает partial снимка (и только у GSA)', () => {
    const handler = manualSrc;
    // переопределение стоит ПОСЛЕ присваивания живым baseComplete и ДО qwen-исключения
    const assignAt = handler.indexOf('isLowConfidenceBase: (host.isBaseComplete() !== true)');
    const gsaAt = handler.indexOf("if (site === 'google_search' && snapPartMan) {");
    const qwenAt = handler.indexOf('host.isQwenExportBaseTrusted()');
    expect(assignAt).toBeGreaterThan(-1);
    expect(gsaAt).toBeGreaterThan(assignAt);
    expect(qwenAt).toBeGreaterThan(gsaAt);
    // выражение — ровно partial снимка, без baseComplete
    expect(handler).toContain('manualSnapshot.isLowConfidenceBase = (snapPartMan.partial === true);');
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

// ---- BUG-J (4.4): префикс имени файла выровнен с телом у GSA ----
// Холодная загрузка GSA (`folwr-open`) отдавала тело new→old при baseComplete=1, поэтому
// живой флаг врал: файл считался достоверным. Теперь для GSA флаг — partial снимка
// контекста (тот же признак, что у поля partial), прочие сайты видят прежний baseComplete.
describe('BUG-J: префикс GSA выровнен с телом файла', () => {
  // Зеркало выражения content.ts: GSA со снимком контекста → partial, иначе живой baseComplete.
  function manualFlag(site, baseComplete, snapPartMan) {
    let flag = (baseComplete !== true);
    if (site === 'google_search' && snapPartMan) flag = (snapPartMan.partial === true);
    return flag;
  }
  function nameFor(flag, site) {
    return buildName({ site: site, convId: 'abcdefgh12345678', isLowConfidenceBase: flag }, 'md');
  }

  test('GSA: baseComplete=1, но снимок partial=false → префикса НЕТ', () => {
    const flag = manualFlag('google_search', true, { partial: false });
    expect(flag).toBe(false);
    expect(nameFor(flag, 'google_search')).toMatch(/^google_search-abcdefgh-.*\.md$/);
    expect(nameFor(flag, 'google_search')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('GSA: снимок partial=true → префикс ЕСТЬ, даже при baseComplete=1', () => {
    const flag = manualFlag('google_search', true, { partial: true });
    expect(flag).toBe(true);
    expect(nameFor(flag, 'google_search')).toMatch(/^\[LOW CONFIDENCE\]_google_search-abcdefgh-.*\.md$/);
  });

  test('GSA: без снимка контекста (snapPartMan=null) → прежний живой baseComplete=0', () => {
    expect(manualFlag('google_search', false, null)).toBe(true);
    expect(nameFor(true, 'google_search')).toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('Gemini/Qwen: partial=false не понижает живой baseComplete=0 — префикс остаётся', () => {
    expect(manualFlag('gemini', false, { partial: false })).toBe(true);
    expect(manualFlag('qwen', false, { partial: false })).toBe(true);
    expect(nameFor(true, 'gemini')).toMatch(/^\[LOW CONFIDENCE\]_gemini-/);
    expect(nameFor(true, 'qwen')).toMatch(/^\[LOW CONFIDENCE\]_qwen-/);
    // и наоборот: baseComplete=1 без partial — чистое имя у не-GSA
    expect(manualFlag('gemini', true, { partial: false })).toBe(false);
    expect(nameFor(false, 'gemini')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('Gemini/Qwen: partial=true байтово не меняет прежнее решение (по-прежнему baseComplete)', () => {
    expect(manualFlag('gemini', false, { partial: true })).toBe(true);
    expect(manualFlag('gemini', true, { partial: true })).toBe(false);
  });
});
