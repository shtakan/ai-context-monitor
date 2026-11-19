'use strict';

/**
 * S5.1 (I3, ADR-001 §4): проекция «канонический массив → массив файла».
 *
 * Одна функция core/export-manager.ts:aiCmProjectFileMessages(msgs, site) применяется на
 * ручном и авто-путях (включая union) и НЕ трогает снимок/метрику: tokens/limit/percent/src/
 * partial/bodyHash по-прежнему считает aiCmBuildCanonicalBody/aiCmReadContextSnapshot.
 * Тумблер меняет ТОЛЬКО наличие секций reasoning и инъекций в файле.
 *
 * Тест держит функцию РЕАЛЬНОЙ: декларации из core/export-manager.ts исполняются через
 * new Function, свободные глобалы (AiCmExportEmitPipeline, AiCmExportBuilders, currentAdapter,
 * aiCmIncludeHiddenInExport, aiCmLogSanitizeSkip, swallowSoft) инжектируются аргументами —
 * тот же приём, что tests/inv-i3-canonical-messages.test.js. Сборщики файла — реальные
 * utils/export-text-builders.ts; каноническое тело — реальный utils/canonical-body.ts.
 * Живьём DeepSeek++ не проверяем (расширение удалено, ToS-риск): O-20 — unit/fixture.
 */

const fs = require('fs');
const path = require('path');

const loadEsm = require('./helpers/load-esm.js');
const { moduleSource } = require('./helpers/content-source.js');
const { openOptionsExportGate } = require('./helpers/options-export-gate');
const { loadOptions } = require('./helpers/load-options.js');

const ROOT = path.join(__dirname, '..');
const P = loadEsm.loadEsmModule('utils/export-emit-pipeline.ts');
const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
const Canonical = loadEsm.loadEsmModule('utils/canonical-body.ts');
const EM_SRC = moduleSource('export-manager.ts');
const CONTENT = moduleSource('content.ts');

const LABEL = '[AI-CM projection: applied]';
const CONV_ID = 'conv-i3-export-projection';

/** Декларация функции по балансу фигурных скобок (конвенция сьюта). */
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('inv-i3-projection: в исходнике нет function ' + name + '(');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('inv-i3-projection: unbalanced declaration: ' + name);
}

// Цепочка проекции: эффективный тумблер → (OFF) снятие reasoning/hiddenReasoning у всех
// сайтов → единственная точка санации. O-37-разложения text→reasoning здесь НЕТ: вход —
// канонический массив, он уже в файловой форме (секции в text + поле reasoning).
// aiCmCanonicalizeMessages — вход (канонический массив).
const FN_NAMES = [
  'aiCmHiddenExportEffectiveOn',
  'aiCmSanitizeEmitUserTexts',
  'aiCmCanonicalizeMessages',
  'aiCmProjectFileMessages'
];

/**
 * Песочница проекции. site — currentAdapter.siteName, userOn — тумблер aiCmIncludeHiddenInExport.
 * @param {{site?: string, userOn?: boolean}} [opts]
 */
function makeProjection(opts) {
  const env = Object.assign({ site: 'qwen', userOn: false }, opts || {});
  const code = FN_NAMES.map(function (name) { return fnDecl(EM_SRC, name); }).join('\n\n') +
    '\nreturn { canon: aiCmCanonicalizeMessages, project: aiCmProjectFileMessages };';
  const factory = new Function(
    'AiCmExportEmitPipeline',
    'AiCmExportBuilders',
    'currentAdapter',
    'aiCmIncludeHiddenInExport',
    'aiCmLogSanitizeSkip',
    'swallowSoft',
    code
  );
  return factory(P, Builders, { siteName: env.site }, env.userOn, function () { }, function () { });
}

/** История файла: метрики снимка неизменны, меняется только messages (+ bodyProjection). */
function histFor(messages, over) {
  return Object.assign({
    site: 'qwen',
    model: 'Qwen3.8-Max',
    tokens: 2593,
    limit: 1000000,
    percent: 0.3,
    src: 'dom',
    messages: messages
  }, over || {});
}

/** Строки шапки, которые несут числа/источник снимка (сравнение OFF/ON). */
function metricLines(md) {
  return String(md).split('\n').filter(function (line) {
    return line.indexOf('Токены:') === 0 || line.indexOf('metric-src:') === 0 ||
      line.indexOf('metric-partial') === 0;
  });
}

/** Текстовые блоки MD после маркеров ролей ('### USER'/'### ASSISTANT'). */
function mdBodyTexts(md) {
  const isMarker = function (line) { return line === '### USER' || line === '### ASSISTANT'; };
  const lines = String(md).split('\n');
  let i = 0;
  while (i < lines.length && !isMarker(lines[i])) i++;
  const blocks = [];
  let cur = null;
  for (; i < lines.length; i++) {
    if (isMarker(lines[i])) {
      if (cur) blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(lines[i]);
  }
  if (cur) blocks.push(cur);
  return blocks.map(function (block) {
    let s = 0;
    let e = block.length;
    while (s < e && block[s] === '') s++;
    while (e > s && block[e - 1] === '') e--;
    return block.slice(s, e).join('\n');
  });
}

function countOf(text, sub) {
  return String(text).split(sub).length - 1;
}

/**
 * Текстовые блоки MD после шапки для НЕ-маркерных сайтов (deepseek/прочие):
 * роли идут заголовками '## …', тело — до следующего заголовка. Нужен, чтобы
 * сравнить тело MD с JSON-текстом там, где нет '### USER'/'### ASSISTANT'.
 */
function mdBodiesGeneric(md) {
  const isHeader = function (line) { return /^## /.test(line); };
  const lines = String(md).split('\n');
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (isHeader(lines[i])) {
      if (cur) blocks.push(cur);
      cur = [];
      continue;
    }
    if (cur) cur.push(lines[i]);
  }
  if (cur) blocks.push(cur);
  return blocks.map(function (block) {
    let s = 0;
    let e = block.length;
    while (s < e && block[s] === '') s++;
    while (e > s && block[e - 1] === '') e--;
    return block.slice(s, e).join('\n');
  });
}

function stripDates(text) {
  return String(text).replace(/^Дата экспорта: .*$/m, 'Дата экспорта: <t>');
}

function jsonNoDate(text) {
  const obj = JSON.parse(text);
  delete obj.exportedAt;
  return obj;
}

const RAW_QWEN = [
  { role: 'user', text: 'Вопрос' },
  { role: 'assistant', text: 'Ответ', reasoning: 'Рассуждение ответа' }
];
const RAW_DS_SECTIONS = [
  { role: 'user', text: 'Вопрос' },
  { role: 'assistant', text: '[REASONING]\nДумал так\n\n[ANSWER]\nОтвет' }
];

// ===== ручной путь: РЕАЛЬНЫЙ участок core/content.ts (MANUAL-регион) =====
const MAN_START = "if (message.type === 'aiCmExportCurrent') {";
const MAN_END = "if (message.type === 'GET_STATS') {";
const MANUAL_CODE = 'var run = function () {\n' +
  CONTENT.slice(CONTENT.indexOf(MAN_START), CONTENT.indexOf(MAN_END)) + '\n}; run();';

function runSlice(code, ctx) {
  return new Function('ctx', 'with (ctx) { ' + code + '\n }')(ctx);
}

/**
 * Песочница ручного экспорта: РЕАЛЬНЫЙ MANUAL-регион с инжектированной проекцией.
 * baseComplete=false → union-путь (aiCmUnionFileMessages), иначе — тело снимка.
 */
function manualSandbox(opts) {
  const o = Object.assign({ baseComplete: true, union: [], snapshot: null }, opts || {});
  const resp = [];
  const canon = o.canon || [];
  const api = o.api || makeProjection({ site: 'qwen' });
  const ctx = {
    message: { type: 'aiCmExportCurrent' },
    sendResponse: function (r) { resp.push(r); },
    currentAdapter: { siteName: 'qwen' },
    window: { location: { hostname: 'chat.qwen.ai' } },
    getCurrentConvId: function () { return CONV_ID; },
    aiCmCanonicalConvId: function () { return CONV_ID; },
    lastTokensSnapshot: { src: 'dom' },
    baseComplete: o.baseComplete,
    lastSnapshotModelName: 'Qwen3.8-Max',
    lastResolvedModelId: 'qwen3.8-max',
    maxTokenCount: 2593,
    lastPercentage: 42.5,
    computeEffectiveLimit: function () { return 1000000; },
    aiCmReadContextSnapshot: function () { return o.snapshot; },
    aiCmGetSourceTier: function () { return undefined; },
    aiCmQwenExportBaseTrusted: function () { return false; },
    buildHistoryMessages: function () {
      return canon.map(function (m) { return Object.assign({}, m); });
    },
    aiCmFlushLiveStreamForExport: function () { },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmUnionFileMessages: function () {
      return o.union.map(function (m) { return Object.assign({}, m); });
    },
    aiCmCanonicalizeMessages: api.canon,
    aiCmProjectFileMessages: api.project,
    aiCmBuildCanonicalBody: function () { return Canonical.canonicalBody(CONV_ID, canon); },
    aiCmExportNetSyncSite: function () { return false; },
    debugLog: function () { },
    swallowSoft: function () { }
  };
  return { ctx: ctx, resp: resp };
}

function loadPopup() {
  openOptionsExportGate({ history: null });
  return loadOptions();
}

describe('inv-i3 (S5.1): проекция «канонический массив → массив файла»', function () {
  test('(1) OFF/ON на одном источнике: метрики и metric-src равны, различаются только секции', function () {
    const apiOff = makeProjection({ site: 'qwen', userOn: false });
    const canon = apiOff.canon(RAW_QWEN, 'qwen');
    const pOff = apiOff.project(canon, 'qwen');
    const pOn = makeProjection({ site: 'qwen', userOn: true }).project(canon, 'qwen');

    expect(pOff.mode).toBe('projected');
    expect(pOn.mode).toBe('');                       // канонический массив уже в файловой форме
    const mdOff = Builders.buildMdFromHistory(histFor(pOff.messages, { bodyProjection: pOff.mode }), 'qwen');
    const mdOn = Builders.buildMdFromHistory(histFor(pOn.messages, { bodyProjection: pOn.mode }), 'qwen');
    expect(metricLines(mdOff)).toEqual(metricLines(mdOn));
    expect(metricLines(mdOff).join('\n')).toContain('Токены: 2593 / 1000000'); // число снимка
    expect(metricLines(mdOff)).toContain('metric-src: dom');

    // Тело OFF: секций нет; тело ON: секции есть — остальное (роли, тексты) совпадает.
    expect(countOf(mdBodyTexts(mdOff).join('\n'), '[REASONING]')).toBe(0);
    expect(mdBodyTexts(mdOn).join('\n')).toContain('[REASONING]\nРассуждение ответа');
    // Входной канонический массив не мутирован проекцией.
    expect(canon[1].reasoning).toBe('Рассуждение ответа');
    expect(canon[1].text).toContain('[REASONING]');
  });

  test('(2) qwen OFF: 0 секций [REASONING], поля reasoning нет, MD-тело == JSON-тело', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const canon = api.canon(RAW_QWEN, 'qwen');
    const proj = api.project(canon, 'qwen');
    expect(proj.mode).toBe('projected');
    proj.messages.forEach(function (m) {
      expect(m.reasoning).toBeUndefined();
      expect(String(m.text)).not.toContain('[REASONING]');
    });
    const hist = histFor(proj.messages, { bodyProjection: proj.mode });
    const md = Builders.buildMdFromHistory(hist, 'qwen');
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'qwen'));
    expect(json.messages.map(function (m) { return m.text; }).join('\n')).toBe(mdBodyTexts(md).join('\n'));
  });

  test('(3) deepseek OFF: секции из текста вырезаны, поля reasoning нет', function () {
    const api = makeProjection({ site: 'deepseek', userOn: false });
    const canon = api.canon(RAW_DS_SECTIONS, 'deepseek');
    const proj = api.project(canon, 'deepseek');
    expect(proj.mode).toBe('projected');
    expect(proj.messages[1].text).not.toContain('[REASONING]');
    expect(proj.messages[1].text).not.toContain('[ANSWER]');
    expect(proj.messages[1].text).toContain('Ответ');
    expect(proj.messages[1].reasoning).toBeUndefined();
  });

  test('(4) ON: секции есть; скрытый reasoning становится секциями файла (метка при изменении)', function () {
    const canonApi = makeProjection({ site: 'qwen', userOn: true });
    const canon = canonApi.canon(RAW_QWEN, 'qwen');
    const same = canonApi.project(canon, 'qwen');
    expect(same.mode).toBe('');
    expect(same.messages[1].text).toContain('[REASONING]\nРассуждение ответа');

    const withHidden = [{ role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: 'Ответ', hiddenReasoning: 'Скрытое рассуждение' }];
    const proj = canonApi.project(withHidden, 'qwen');
    expect(proj.mode).toBe('projected');
    // ON раскрывает hiddenReasoning В ТЕКСТ секциями файла (includeHiddenExportBlocks) и НЕ
    // синтезирует поле reasoning: повторное O-37-разложение разъезжало MD и JSON.
    expect(proj.messages[1].reasoning).toBeUndefined();
    expect(proj.messages[1].hiddenReasoning).toBeUndefined();
    expect(proj.messages[1].text).toContain('[REASONING]\nСкрытое рассуждение\n\n[ANSWER]\nОтвет');
    const hist = histFor(proj.messages, { bodyProjection: proj.mode });
    const md = Builders.buildMdFromHistory(hist, 'qwen');
    expect(mdBodyTexts(md).join('\n')).toContain('[REASONING]\nСкрытое рассуждение');
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'qwen'));
    // MD и JSON одного массива: секции уже в text, сборщику нечего переклеивать.
    expect(json.messages.map(function (m) { return m.text; }).join('\n'))
      .toBe(mdBodyTexts(md).join('\n'));
    expect(json.messages[1].reasoning).toBeUndefined();
    expect(json.messages[1].hiddenReasoning).toBeUndefined();
  });

  test('(5) авто (threshold и base-complete) == ручной путь: один массив проекции и одно тело', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const canon = api.canon(RAW_QWEN, 'qwen');
    // threshold: локальный массив; base-complete: массив тела снимка ([ctx-snap]) — тот же вход.
    const pThreshold = api.project(canon, 'qwen');
    const pBase = api.project(Canonical.canonicalBody(CONV_ID, canon).messages, 'qwen');
    expect(pBase.messages).toEqual(pThreshold.messages);
    expect(pBase.mode).toBe('projected');

    const sb = manualSandbox({ canon: canon, api: api, baseComplete: true });
    runSlice(MANUAL_CODE, sb.ctx);
    expect(sb.resp).toHaveLength(1);
    const data = sb.resp[0].data;
    expect(data.bodyProjection).toBe('projected');
    expect(data.messages).toEqual(pThreshold.messages);

    const popup = loadPopup();
    const autoMd = Builders.buildMdFromHistory(histFor(pThreshold.messages, {
      bodyProjection: pThreshold.mode
    }), 'Qwen');
    expect(stripDates(popup.buildMdText(data))).toBe(stripDates(autoMd));
    // Метрики у путей свои (percent ручного — lastPercentage), тело файла — одно.
    const manualJson = jsonNoDate(popup.buildJsonText(data));
    const autoJson = jsonNoDate(Builders.buildJsonFromHistory(histFor(pThreshold.messages, {
      bodyProjection: pThreshold.mode
    }), 'qwen'));
    expect(manualJson.messages).toEqual(autoJson.messages);
    expect(manualJson.bodyProjection).toBe(true);
    expect(autoJson.bodyProjection).toBe(true);
  });

  test('(6) base-union проецируется и сохраняет partial', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const unionRaw = [
      { role: 'user', text: 'Архивный вопрос' },
      { role: 'assistant', text: 'Архивный ответ' },
      { role: 'user', text: 'Живой вопрос' },
      { role: 'assistant', text: 'Живой ответ', reasoning: 'Живое рассуждение' }
    ];
    const sb = manualSandbox({
      api: api,
      baseComplete: false,
      union: unionRaw,
      snapshot: { partial: true, partialReason: 'stale' }
    });
    runSlice(MANUAL_CODE, sb.ctx);
    const data = sb.resp[0].data;
    expect(data.partial).toBe(true);
    expect(data.partialReason).toBe('stale');
    expect(data.bodyProjection).toBe('projected');
    expect(countOf(JSON.stringify(data.messages), '[REASONING]')).toBe(0);

    const json = jsonNoDate(loadPopup().buildJsonText(data));
    expect(json.partial).toBe(true);
    expect(json.partialReason).toBe('stale');
    expect(json.bodyProjection).toBe(true);
    expect(countOf(JSON.stringify(json.messages), '[REASONING]')).toBe(0);
  });

  test('(7) Gemini/GSA: тела байт-в-байт (пустой mode, тот же объект массива)', function () {
    ['gemini', 'google_search'].forEach(function (site) {
      const api = makeProjection({ site: site, userOn: false });
      const canon = api.canon([
        { role: 'user', text: 'Вопрос' },
        { role: 'assistant', text: 'Ответ' }
      ], site);
      const proj = api.project(canon, site);
      expect(proj.mode).toBe('');
      expect(proj.messages).toBe(canon);
      const before = histFor(canon, { site: site });
      const after = histFor(proj.messages, { site: site, bodyProjection: proj.mode });
      expect(stripDates(Builders.buildMdFromHistory(after, 'AI Chat')))
        .toBe(stripDates(Builders.buildMdFromHistory(before, 'AI Chat')));
      expect(Builders.buildTxtFromHistory(after)).toBe(Builders.buildTxtFromHistory(before));
      expect(jsonNoDate(Builders.buildJsonFromHistory(after, 'AI Chat')))
        .toEqual(jsonNoDate(Builders.buildJsonFromHistory(before, 'AI Chat')));
    });
  });

  test('(8) O-20 fixture через проекцию: OFF вырезает маркеры и преамбулу, ON — как есть', function () {
    const O20_START = '<!-- deepseek-pp-visible-user-prompt:start -->';
    const O20_END = '<!-- deepseek-pp-visible-user-prompt:end -->';
    const O20_VISIBLE = 'O-20: в экспорте виден только мой текст — без преамбулы DeepSeek++.';
    const O20_PREAMBLE = [
      'You have long-term memory. Existing memories:',
      '1. Пользователь работает с расширением DeepSeek++.',
      '2. Цель — работа с кодом проекта через DSH (DeepSeek Harness).'
    ].join('\n');
    const injected = O20_PREAMBLE + '\n\n' + O20_START + '\n' + O20_VISIBLE + '\n' + O20_END;
    const src = [{ role: 'user', text: injected }, { role: 'assistant', text: 'ответ' }];

    const off = makeProjection({ site: 'deepseek', userOn: false }).project(src, 'deepseek');
    expect(off.mode).toBe('projected');
    expect(off.messages[0].text).toBe(O20_VISIBLE);
    expect(off.messages[0].text).not.toContain(O20_START);
    expect(off.messages[0].text).not.toContain('long-term memory');

    const on = makeProjection({ site: 'deepseek', userOn: true }).project(src, 'deepseek');
    expect(on.messages[0].text).toBe(injected);
  });

  test('(9) несколько секций в одном сообщении: OFF режет все, ON сохраняет все', function () {
    const text = '[REASONING]\nр1\n\n[ANSWER]\nо1\n\n[REASONING]\nр2\n\n[ANSWER]\nо2';
    const src = [{ role: 'assistant', text: text }];
    const off = makeProjection({ site: 'qwen', userOn: false }).project(src, 'qwen');
    expect(countOf(off.messages[0].text, '[REASONING]')).toBe(0);
    expect(countOf(off.messages[0].text, '[ANSWER]')).toBe(0);
    expect(off.messages[0].text).toContain('о1');
    expect(off.messages[0].text).toContain('о2');

    const on = makeProjection({ site: 'qwen', userOn: true }).project(src, 'qwen');
    // ON не теряет ни одного фрагмента: секции остаются в text, разложения в поле reasoning нет.
    expect(on.mode).toBe('');
    ['р1', 'р2', 'о1', 'о2'].forEach(function (frag) {
      expect(on.messages[0].text).toContain(frag);
      expect(on.messages[0].reasoning).toBeUndefined();
    });
  });

  test('(10) метка есть при projected и отсутствует при пустом mode; ровно 4 точки применения', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const canon = api.canon(RAW_QWEN, 'qwen');
    const proj = api.project(canon, 'qwen');
    const withLabel = histFor(proj.messages, { bodyProjection: proj.mode });
    const noLabel = histFor(proj.messages, { bodyProjection: '' });
    const md = Builders.buildMdFromHistory(withLabel, 'qwen');
    const txt = Builders.buildTxtFromHistory(withLabel);
    const json = JSON.parse(Builders.buildJsonFromHistory(withLabel, 'qwen'));
    expect(md.split('\n').filter(function (l) { return l === LABEL; })).toHaveLength(1);
    expect(txt.split('\n')[0]).toBe(LABEL);
    expect(json.bodyProjection).toBe(true);

    const md2 = Builders.buildMdFromHistory(noLabel, 'qwen');
    const txt2 = Builders.buildTxtFromHistory(noLabel);
    const json2 = JSON.parse(Builders.buildJsonFromHistory(noLabel, 'qwen'));
    expect(md2).not.toContain(LABEL);
    expect(txt2.split('\n')[0]).not.toBe(LABEL);
    expect('bodyProjection' in json2).toBe(false);

    // Ровно 4 вызова: ручной union + ручной обычный + авто base-union + авто обычный.
    const emCalls = (EM_SRC.match(/aiCmProjectFileMessages\(/g) || []).length - 1; // минус декларация
    const ctCalls = (CONTENT.match(/aiCmProjectFileMessages\(/g) || []).length;
    expect(emCalls).toBe(2);
    expect(ctCalls).toBe(2);
  });

  test('(11) идемпотентность: проекция проекции == проекция (пустой mode, тот же массив)', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const canon = api.canon(RAW_QWEN, 'qwen');
    const once = api.project(canon, 'qwen');
    expect(once.mode).toBe('projected');
    const twice = api.project(once.messages, 'qwen');
    expect(twice.mode).toBe('');
    expect(twice.messages).toBe(once.messages);
    expect(twice.messages).toEqual(once.messages);
  });

  test('(12) канонический массив и bodyHash не изменены проекцией', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const canon = api.canon(RAW_QWEN, 'qwen');
    const before = JSON.stringify(canon);
    const bodyBefore = Canonical.canonicalBody(CONV_ID, canon);
    api.project(canon, 'qwen');
    expect(JSON.stringify(canon)).toBe(before);
    const bodyAfter = Canonical.canonicalBody(CONV_ID, canon);
    expect(bodyAfter).toBe(bodyBefore);
    expect(bodyAfter.bodyHash).toBe(bodyBefore.bodyHash);
    expect(canon[1].reasoning).toBe('Рассуждение ответа');
  });

  test('(13) позиция метки: MD — под metric-src (или после шапки), TXT — первая строка / под sourceTier', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const canon = api.canon(RAW_QWEN, 'qwen');
    const proj = api.project(canon, 'qwen');
    const withSrc = histFor(proj.messages, { bodyProjection: proj.mode });
    const lines = Builders.buildMdFromHistory(withSrc, 'qwen').split('\n');
    const srcIdx = lines.indexOf('metric-src: dom');
    expect(srcIdx).toBeGreaterThan(0);
    expect(lines[srcIdx + 1]).toBe(LABEL);

    const noSrc = histFor(proj.messages, { bodyProjection: proj.mode, src: undefined });
    const noSrcLines = Builders.buildMdFromHistory(noSrc, 'qwen').split('\n');
    expect(noSrcLines[7]).toBe(LABEL);      // title, '', platform, model, date, tokens, '', LABEL

    const tier = Builders.buildTxtFromHistory(histFor(proj.messages, {
      site: 'gemini', sourceTier: '<!-- tier -->', bodyProjection: proj.mode
    })).split('\n');
    expect(tier[0]).toBe('<!-- tier -->');
    expect(tier[1]).toBe('');
    expect(tier[2]).toBe(LABEL);

    expect(Buffer.byteLength(LABEL + '\n', 'utf8')).toBe(28);
    const plainJson = Builders.buildJsonFromHistory(histFor(proj.messages), 'qwen');
    const projJson = Builders.buildJsonFromHistory(withSrc, 'qwen');
    expect(projJson.length - plainJson.length).toBe(',\n  "bodyProjection": true'.length);
  });

  test('(14a) qwen ON: секции уже в text, поля reasoning нет — mode пуст, метки/ключа нет, MD==JSON', function () {
    const api = makeProjection({ site: 'qwen', userOn: true });
    const src = [
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: '[REASONING]\nДумал так\n\n[ANSWER]\nОтвет' }
    ];
    const proj = api.project(src, 'qwen');
    expect(proj.mode).toBe('');
    expect(proj.messages).toBe(src);                 // тот же массив: ни одного нового байта
    const hist = histFor(proj.messages, { bodyProjection: proj.mode });
    const md = Builders.buildMdFromHistory(hist, 'qwen');
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'qwen'));
    expect(md).not.toContain(LABEL);                 // ON без скрытых полей — метки нет
    expect('bodyProjection' in json).toBe(false);    // ключа авто-JSON тоже нет
    expect(countOf(mdBodyTexts(md).join('\n'), '[REASONING]')).toBe(1);
    expect(json.messages.map(function (m) { return m.text; }).join('\n'))
      .toBe(mdBodyTexts(md).join('\n'));
  });

  test('(14b) qwen OFF на том же входе: 0 секций, метка есть, MD==JSON', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const src = [
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: '[REASONING]\nДумал так\n\n[ANSWER]\nОтвет' }
    ];
    const proj = api.project(src, 'qwen');
    expect(proj.mode).toBe('projected');
    expect(countOf(JSON.stringify(proj.messages), '[REASONING]')).toBe(0);
    expect(countOf(JSON.stringify(proj.messages), '[ANSWER]')).toBe(0);
    const hist = histFor(proj.messages, { bodyProjection: proj.mode });
    const md = Builders.buildMdFromHistory(hist, 'qwen');
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'qwen'));
    expect(md.split('\n').filter(function (l) { return l === LABEL; })).toHaveLength(1);
    expect(json.bodyProjection).toBe(true);
    expect(countOf(md, '[REASONING]')).toBe(0);
    expect(json.messages.map(function (m) { return m.text; }).join('\n'))
      .toBe(mdBodyTexts(md).join('\n'));
  });

  test('(14c) ON + hiddenReasoning: тело меняется, метка уместна, MD==JSON', function () {
    const api = makeProjection({ site: 'qwen', userOn: true });
    const src = [
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: '[REASONING]\nПервое рассуждение\n\n[ANSWER]\nПервый ответ', reasoning: 'Первое рассуждение' },
      { role: 'user', text: 'Ещё вопрос' },
      { role: 'assistant', text: 'Второй ответ', hiddenReasoning: 'Скрытое рассуждение' }
    ];
    const proj = api.project(src, 'qwen');
    expect(proj.mode).toBe('projected');
    expect(proj.messages[1].text).toBe('[REASONING]\nПервое рассуждение\n\n[ANSWER]\nПервый ответ');
    expect(proj.messages[3].text).toBe('[REASONING]\nСкрытое рассуждение\n\n[ANSWER]\nВторой ответ');
    expect(proj.messages[3].hiddenReasoning).toBeUndefined();
    const hist = histFor(proj.messages, { bodyProjection: proj.mode });
    const md = Builders.buildMdFromHistory(hist, 'qwen');
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'qwen'));
    expect(md.split('\n').filter(function (l) { return l === LABEL; })).toHaveLength(1);
    expect(json.bodyProjection).toBe(true);
    expect(json.messages.map(function (m) { return m.text; }).join('\n'))
      .toBe(mdBodyTexts(md).join('\n'));
  });

  test('(14d) авто-путь и union проецируются ровно как ручной (ON и OFF)', function () {
    [true, false].forEach(function (userOn) {
      const api = makeProjection({ site: 'qwen', userOn: userOn });
      const canon = api.canon(RAW_QWEN, 'qwen');
      const auto = api.project(Canonical.canonicalBody(CONV_ID, canon).messages, 'qwen');
      const sb = manualSandbox({ canon: canon, api: api, baseComplete: true });
      runSlice(MANUAL_CODE, sb.ctx);
      expect(sb.resp).toHaveLength(1);
      expect(sb.resp[0].data.messages).toEqual(auto.messages);
      expect(sb.resp[0].data.bodyProjection).toBe(auto.mode);

      const unionRaw = [
        { role: 'user', text: 'Архивный вопрос' },
        { role: 'assistant', text: 'Архивный ответ' },
        { role: 'user', text: 'Живой вопрос' },
        { role: 'assistant', text: 'Живой ответ', reasoning: 'Живое рассуждение' }
      ];
      const unionAuto = api.project(api.canon(unionRaw, 'qwen'), 'qwen');
      const sbU = manualSandbox({ api: api, baseComplete: false, union: unionRaw, snapshot: { partial: true } });
      runSlice(MANUAL_CODE, sbU.ctx);
      expect(sbU.resp).toHaveLength(1);
      expect(sbU.resp[0].data.messages).toEqual(unionAuto.messages);
      expect(sbU.resp[0].data.bodyProjection).toBe(unionAuto.mode);
    });
  });

  test('(14e) deepseek OFF, живая форма: поле reasoning + секции в text — 0 [REASONING], поля нет, метка есть, MD==JSON', function () {
    const api = makeProjection({ site: 'deepseek', userOn: false });
    // Живая форма сетевого источника: секции уже в text И продублированы полем reasoning.
    const src = [
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: '[REASONING]\nДумал так\n\n[ANSWER]\nОтвет', reasoning: 'Думал так' }
    ];
    const proj = api.project(src, 'deepseek');
    expect(proj.mode).toBe('projected');
    expect(proj.messages[1].reasoning).toBeUndefined();
    expect(proj.messages[1].text).toBe('Ответ');
    expect(countOf(JSON.stringify(proj.messages), '[REASONING]')).toBe(0);
    expect(countOf(JSON.stringify(proj.messages), '[ANSWER]')).toBe(0);

    const hist = histFor(proj.messages, { bodyProjection: proj.mode, site: 'deepseek' });
    const md = Builders.buildMdFromHistory(hist, 'deepseek');
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'deepseek'));
    expect(md.split('\n').filter(function (l) { return l === LABEL; })).toHaveLength(1);
    expect(json.bodyProjection).toBe(true);
    // Раньше поле reasoning переклеивало [REASONING] в MD (messageTextWithReasoning) —
    // теперь тело MD байт-в-байт равно JSON-тексту.
    expect(countOf(md, '[REASONING]')).toBe(0);
    expect(mdBodiesGeneric(md).join('\n')).toBe(json.messages.map(function (m) { return m.text; }).join('\n'));
  });

  test('(14f) OFF и [REASONING] без [ANSWER]: текущее поведение — mode пуст, текст как есть', function () {
    const api = makeProjection({ site: 'qwen', userOn: false });
    const src = [{ role: 'assistant', text: '[REASONING]\nchain' }];
    const canon = api.canon(src, 'qwen');
    const proj = api.project(canon, 'qwen');
    expect(proj.mode).toBe('');
    expect(proj.messages).toBe(canon);              // тот же массив, не копия
    expect(proj.messages[0].text).toBe('[REASONING]\nchain');
    expect(P.stripReasoningSections('[REASONING]\nchain')).toBe('[REASONING]\nchain');
    // дыра принята ADR §9 (2026-11-15); это фиксация текущего поведения, НЕ фикс
  });
});
