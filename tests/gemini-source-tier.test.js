/**
 * Two-Tier (v89): метка достоверности ИСТОЧНИКА файла в сборщиках TXT/MD + аддитивное
 * поле JSON. Метка отвечает на вопрос «какой ярус базы наполнил файл»: импортированный
 * архив (первый ярус), живой захват (live) или оба сразу.
 *
 *   D1: sourceTierOf({archiveCount:10, liveCount:10}) → '[MERGED: ARCHIVE+LIVE]'.
 *   D2: sourceTierOf({archiveCount:10, liveCount:0})  → '[ARCHIVE]'.
 *   D3: sourceTierOf({archiveCount:0,  liveCount:10}) → '[BEST-EFFORT: LIVE CAPTURE]'.
 *   D4: buildTxtFromHistory({site:'gemini', sourceTier}) → метка ПЕРВОЙ строкой файла,
 *       тело файла под меткой байтово равно прежнему «эталону».
 *   D5: buildTxtFromHistory({site:'qwen', sourceTier}) → метки НЕТ (гейт по site);
 *       байты совпадают с вызовом без метки.
 *   D6: buildTxtFromHistory({site:'gemini'}) без метки → метки НЕТ, байты прежние.
 *   D7: buildMdFromHistory — метка отдельным блоком сразу после шапки, только Gemini.
 *   D8: buildJsonFromHistory — аддитивное поле sourceTier; при undefined ключа нет.
 *   S1–S3: source-пины проводки (чистая функция в Api пайплайна; хелпер метки в
 *       export-manager рядом с aiCmExportBaseSource; передача в снимки истории content.js
 *       и export-manager).
 *
 * ГРАНИЦЫ: метка — латиница без локализации (прецедент [REASONING]/[ANSWER]); BOM и
 * порядок сборки не тронуты (BOM ставит export-manager ПОСЛЕ сборки тела); прочие
 * шесть платформ не получают ни одного нового байта (R1 прежних пинов — qwen-export-o36,
 * claude-export-md-roles, print/options-export-txt — остаётся зелёным).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const buildReferenceText = require('../utils/buildReferenceText.js');

const ROOT = path.join(__dirname, '..');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const CONTENT_ONLY = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');

const MERGED = '[MERGED: ARCHIVE+LIVE]';
const ARCHIVE = '[ARCHIVE]';
const LIVE = '[BEST-EFFORT: LIVE CAPTURE]';

const MESSAGES = [
  { role: 'user', text: 'вопрос' },
  { role: 'assistant', text: 'ответ' }
];

describe('Two-Tier D1–D3: sourceTierOf — классификация ярусов источника', function () {
  test('D1: архив и live вместе → MERGED', function () {
    expect(P.sourceTierOf({ archiveCount: 10, liveCount: 10 })).toBe(MERGED);
  });

  test('D2: только архив → ARCHIVE', function () {
    expect(P.sourceTierOf({ archiveCount: 10, liveCount: 0 })).toBe(ARCHIVE);
  });

  test('D3: только live → BEST-EFFORT: LIVE CAPTURE', function () {
    expect(P.sourceTierOf({ archiveCount: 0, liveCount: 10 })).toBe(LIVE);
  });
});

describe('Two-Tier D4: txt Gemini — метка первой строкой, тело файла прежнее', function () {
  test('D4a: первая строка файла — ровно метка', function () {
    const txt = Builders.buildTxtFromHistory({ site: 'gemini', sourceTier: LIVE, messages: MESSAGES });
    expect(txt.split('\n')[0]).toBe(LIVE);
  });

  test('D4b: под меткой — ровно одна пустая строка и прежний «эталон»', function () {
    const txt = Builders.buildTxtFromHistory({ site: 'gemini', sourceTier: LIVE, messages: MESSAGES });
    expect(txt).toBe(LIVE + '\n\n' + buildReferenceText(MESSAGES));
  });

  test('D4c: пустая история — файла нет (метка не «оживляет» пустой файл)', function () {
    // иначе файл из одной метки обошёл бы гейт empty-text автоэкспорта (прежнее поведение — skip)
    expect(Builders.buildTxtFromHistory({ site: 'gemini', sourceTier: MERGED })).toBe('');
  });
});

describe('Two-Tier D5: txt не-Gemini — гейт по site, метка не ставится', function () {
  test('D5a: qwen с меткой в истории → метки нет', function () {
    const txt = Builders.buildTxtFromHistory({ site: 'qwen', sourceTier: LIVE, messages: MESSAGES });
    expect(txt.indexOf(LIVE)).toBe(-1);
  });

  test('D5b: qwen — байты совпадают с вызовом без метки', function () {
    const withTier = Builders.buildTxtFromHistory({ site: 'qwen', sourceTier: LIVE, messages: MESSAGES });
    const without = Builders.buildTxtFromHistory({ site: 'qwen', messages: MESSAGES });
    expect(withTier).toBe(without);
  });

  test('D5c: deepseek с меткой в истории → метки нет', function () {
    const txt = Builders.buildTxtFromHistory({ site: 'deepseek', sourceTier: ARCHIVE, messages: MESSAGES });
    expect(txt.indexOf(ARCHIVE)).toBe(-1);
  });
});

describe('Two-Tier D6: txt Gemini без метки (undefined) — байты прежние', function () {
  test('D6a: метки нет, файл равен «эталону»', function () {
    const txt = Builders.buildTxtFromHistory({ site: 'gemini', messages: MESSAGES });
    expect(txt).toBe(buildReferenceText(MESSAGES));
  });

  test('D6b: ни один литерал метки не появился', function () {
    const txt = Builders.buildTxtFromHistory({ site: 'gemini', messages: MESSAGES });
    [MERGED, ARCHIVE, LIVE].forEach(function (tier) {
      expect(txt.indexOf(tier)).toBe(-1);
    });
  });

  test('D6c: пустой вход без site → прежний пустой файл', function () {
    expect(Builders.buildTxtFromHistory({})).toBe('');
    expect(Builders.buildTxtFromHistory()).toBe('');
  });
});

describe('Two-Tier D7: md Gemini — метка отдельным блоком после шапки', function () {
  test('D7a: метка стоит после шапки и перед первым сообщением', function () {
    const md = Builders.buildMdFromHistory({ site: 'gemini', sourceTier: LIVE, messages: MESSAGES }, 'Gemini');
    const iTier = md.indexOf(LIVE);
    expect(iTier).toBeGreaterThan(-1);
    expect(md.slice(0, iTier)).toContain('Токены');
    expect(md.indexOf('вопрос')).toBeGreaterThan(iTier);
    expect(md.slice(iTier, iTier + LIVE.length + 2)).toBe(LIVE + '\n\n');
  });

  test('D7b: qwen md с меткой → метки нет, байты как без метки', function () {
    // Флейк: шапка md несёт `new Date().toISOString()` (utils/export-text-builders.js:290),
    // а тест сравнивает ДВА независимых вызова. Переход через границу миллисекунды/секунды
    // между ними менял строку даты → падение «раз в N прогонов». Время фиксируем.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    try {
      const withTier = Builders.buildMdFromHistory({ site: 'qwen', sourceTier: LIVE, messages: MESSAGES });
      const without = Builders.buildMdFromHistory({ site: 'qwen', messages: MESSAGES });
      expect(withTier).toBe(without);
    } finally {
      jest.useRealTimers();
    }
  });

  test('D7c: Gemini md без метки → метки нет', function () {
    const md = Builders.buildMdFromHistory({ site: 'gemini', messages: MESSAGES });
    expect(md.indexOf(LIVE)).toBe(-1);
  });
});

describe('Two-Tier D8: json — аддитивное поле, undefined не добавляет ключ', function () {
  test('D8a: метка есть → поле в метаданных', function () {
    const json = JSON.parse(Builders.buildJsonFromHistory({ site: 'gemini', sourceTier: MERGED, messages: MESSAGES }));
    expect(json.sourceTier).toBe(MERGED);
    expect(Array.isArray(json.messages)).toBe(true);
    expect(json.messages).toHaveLength(MESSAGES.length);
  });

  test('D8b: метки нет → ключа нет (аддитивность, байты прежние)', function () {
    const json = JSON.parse(Builders.buildJsonFromHistory({ site: 'gemini', messages: MESSAGES }));
    expect(Object.prototype.hasOwnProperty.call(json, 'sourceTier')).toBe(false);
  });

  test('D8c: прочие платформы без метки → ключа нет', function () {
    const json = JSON.parse(Builders.buildJsonFromHistory({ site: 'qwen', messages: MESSAGES }));
    expect(Object.prototype.hasOwnProperty.call(json, 'sourceTier')).toBe(false);
  });
});

describe('Two-Tier S1–S3: source-пины проводки', function () {
  test('S1: чистая функция классификации экспортирована в Api пайплайна', function () {
    expect(typeof P.sourceTierOf).toBe('function');
    const PIPE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
    expect(PIPE_SRC).toContain('sourceTierOf: sourceTierOf,');
    expect(PIPE_SRC).toContain('MERGED: ARCHIVE+LIVE');
    expect(PIPE_SRC).toContain('BEST-EFFORT: LIVE CAPTURE');
  });

  test('S2: хелпер метки рядом с aiCmExportBaseSource, гейт по site = gemini', function () {
    expect(MGR_SRC).toContain('function aiCmGetSourceTier() {');
    expect(MGR_SRC).toContain("siteName === 'gemini'");
    expect(MGR_SRC).toContain('aiCmGeminiTurnsSnapshotSync()');
    expect(MGR_SRC).toContain('sourceTierOf({');
  });

  test('S3: обе точки записи метаданных передают метку', function () {
    // две точки в export-manager (снимок истории + hist автоэкспорта) и ручной снимок content.js;
    // typeof-гард — контракт срез-песочниц тестов, а не ослабление метки.
    const SITE = "sourceTier: (typeof aiCmGetSourceTier === 'function') ? aiCmGetSourceTier() : undefined,";
    expect(MGR_SRC.split(SITE).length - 1).toBe(2);
    expect(CONTENT_ONLY).toContain('aiCmGetSourceTier()');
    expect(CONTENT_ONLY).toContain('sourceTier:');
  });
});
