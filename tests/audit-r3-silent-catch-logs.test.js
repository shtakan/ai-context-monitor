/**
 * Аудит-волна 1 / R3: тихие catch(e){} на критичных путях → тегированный лог.
 * Цель — заменить МОЛЧАНИЕ логом БЕЗ изменения поведения (проглат сохраняем,
 * ре-троу НЕ добавляем). Здесь только source-level пины (стиль deepseek-order /
 * low-confidence-prefix): удостоверяем, что в нужных catch появился лог-вызов,
 * а «НЕ трогать»-пути остались неизменны.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const contentSrc = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const parserSrc = fs.readFileSync(path.join(ROOT, 'utils', 'gemini-batchexecute-parser.js'), 'utf8');
const interceptSrc = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');

function sliceContent(from, to) {
  return contentSrc.slice(contentSrc.indexOf(from), to ? contentSrc.indexOf(to) : undefined);
}

describe('R3: content.js — silent-catch экспорта стал тегированным debugLog', () => {
  test('catch aiCmWriteCurrentHistory содержит debugLog silent-catch', () => {
    const fn = sliceContent('function aiCmWriteCurrentHistory()', 'function aiCmFlushDeferredHistWrite');
    expect(fn).toContain("[AI CM][export] silent-catch aiCmWriteCurrentHistory: ");
    // проглат сохранён: нет ре-троу
    expect(fn).not.toContain('throw ');
  });

  test('catch aiCmFlushDeferredHistWrite содержит debugLog silent-catch', () => {
    const fn = sliceContent('function aiCmFlushDeferredHistWrite', 'function aiCmScheduleDeferredHistWrite');
    expect(fn).toContain("[AI CM][export] silent-catch aiCmFlushDeferredHistWrite: ");
    expect(fn).not.toContain('throw ');
  });

  test('aiCmScheduleDeferredHistWrite: внутренние fireDeferredTimeout catch (eLc64/eW) и внешний catch логируют', () => {
    const fn = sliceContent('function aiCmScheduleDeferredHistWrite', 'function loadAutoExportSettings');
    expect(fn).toContain('silent-catch aiCmScheduleDeferredHistWrite(fireDeferredTimeout/lowConf): ');
    expect(fn).toContain('silent-catch aiCmScheduleDeferredHistWrite(fireDeferredTimeout/export): ');
    expect(fn).toContain('silent-catch aiCmScheduleDeferredHistWrite: ');
    expect(fn).not.toContain('throw ');
  });

  test('НЕ трогать: гейты и сигнатуры экспорта не изменены', () => {
    expect(contentSrc).toContain('if (baseComplete !== true) return;');
    expect(contentSrc).toContain('if (reason !== \'timeout\' && !(baseComplete === true && !aiCmLoaderRunningByConv[p.convId])) return;');
    expect(contentSrc).toContain('setTimeout(fireDeferredTimeout, 60000)');
  });
});

describe('R3: gemini-batchexecute-parser — JSON.parse-вершины логгируют', () => {
  test('локальный лог-хелпер и тег сегмента на месте', () => {
    expect(parserSrc).toContain('function logSegmentParseFail');
    expect(parserSrc).toContain('[AI CM][batchexecute] segment parse fail ');
  });

  test('catch вокруг JSON.parse сегментов вызывает лог-хелпер', () => {
    // handleOuter (JSON.parse(inner)) + parseByBytes + parseByLines
    expect(parserSrc).toContain("logSegmentParseFail(e, 'handleOuter')");
    expect(parserSrc).toContain("logSegmentParseFail(e, 'parseByBytes')");
    expect(parserSrc).toContain("logSegmentParseFail(e, 'parseByLines')");
  });

  test('проглат сохранён — ре-троу не добавлен в parse-катчи', () => {
    const catches = parserSrc.match(/catch \(e\) \{[^}]*\}/g) || [];
    for (const c of catches) expect(c).not.toMatch(/throw\b/);
  });
});

describe('R3: gemini-intercept — только вершины ingest-парса логгируют', () => {
  test('ровно 4 верхних parse-top: eD13 + handleOuter + parseByBytes + parseByLines', () => {
    const matches = interceptSrc.match(/\[gemini-intercept\] parse-top fail/g) || [];
    expect(matches.length).toBe(4);
    expect(interceptSrc).toContain('parse-top fail (eD13/DR): ');
    expect(interceptSrc).toContain('parse-top fail (handleOuter): ');
    expect(interceptSrc).toContain('parse-top fail (parseByBytes): ');
    expect(interceptSrc).toContain('parse-top fail (parseByLines): ');
  });

  test('leaf-структура ingest-обработки не изменена (нет новых ре-троу на вершинах)', () => {
    // На выбранных вершинах только debugLog, поведение прежнее.
    expect(interceptSrc).toContain("catch (e) { debugLog('log', '[gemini-intercept] parse-top fail (handleOuter): '");
  });
});
