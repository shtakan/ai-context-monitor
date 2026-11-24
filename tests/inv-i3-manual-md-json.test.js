'use strict';

/**
 * S5 + I3c' (ADR-001 §4): MD и JSON ОДНОГО нажатия строятся из одного канонического
 * массива и дают РАВНЫЕ тела; JSON несёт СЫРОЙ ключ сайта в platform (как авто-путь,
 * core/export-manager.ts:1933-1939) и sourceTier, когда он есть в снимке; drop
 * контейнеров и reasoning применяются РОВНО один раз — на этапе массива, поэтому
 * защитный проход сборщиков на каноническом входе тождественен (доказано (v)).
 *
 * Тест поведенческий: реальные utils/export-text-builders.ts, реальный
 * options/options.js в jsdom-стенде попапа и РЕАЛЬНЫЙ участок core/content.ts
 * (MANUAL-регион, ручной ответ aiCmExportCurrent) в песочнице with(ctx) —
 * прецедент tests/inv-i4-partial-barrier.test.js. Массив объединения (union-путь)
 * канонизируется тем же aiCmCanonicalizeMessages, что у тела снимка.
 */

const loadEsm = require('./helpers/load-esm.js');
const { moduleSource } = require('./helpers/content-source.js');
const { openOptionsExportGate } = require('./helpers/options-export-gate');
const { loadOptions } = require('./helpers/load-options.js');

const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
const Canonical = loadEsm.loadEsmModule('utils/canonical-body.ts');
const CONTENT = moduleSource('content.ts');
const EM_SRC = moduleSource('export-manager.ts');
const CONV_ID = 'conv-i3-manual-md-json';

const MAN_START = "if (message.type === 'aiCmExportCurrent') {";
const MAN_END = "if (message.type === 'GET_STATS') {";
const MANUAL_CODE = 'var run = function () {\n' +
  CONTENT.slice(CONTENT.indexOf(MAN_START), CONTENT.indexOf(MAN_END)) + '\n}; run();';

/** Декларация функции по балансу фигурных скобок (конвенция сьюта). */
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('inv-i3-md-json: в исходнике нет function ' + name + '(');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('inv-i3-md-json: unbalanced declaration: ' + name);
}

// Тот же канонизатор, что у тела снимка: свободная переменная AiCmExportBuilders
// инжектируется параметром — как AiCmExportBuilders в общем скоупе бандла.
const canonicalizeMessages = new Function(
  'AiCmExportBuilders',
  fnDecl(EM_SRC, 'aiCmCanonicalizeMessages') + '\nreturn aiCmCanonicalizeMessages;'
)(Builders);

function runSlice(code, ctx) {
  return new Function('ctx', 'with (ctx) { ' + code + '\n }')(ctx);
}

/**
 * Песочница MANUAL-региона core/content.ts: baseComplete=false (низкая достоверность),
 * union-подстановка отдаёт объединение архив+live, aiCmBuildCanonicalBody падает при
 * вызове — union-путь обязан канонизировать САМ массив, а не тело снимка.
 */
function manualSandbox(over) {
  const resp = [];
  const live = [
    { role: 'user', text: 'Живой вопрос' },
    { role: 'assistant', text: 'Живой ответ', reasoning: 'Живое рассуждение' }
  ];
  const archived = [
    { role: 'user', text: 'Архивный вопрос' },
    { role: 'assistant', text: 'Архивный ответ' }
  ];
  const union = archived.concat(live);
  const ctx = {
    message: { type: 'aiCmExportCurrent' },
    sendResponse: function (r) { resp.push(r); },
    currentAdapter: { siteName: 'qwen' },
    window: { location: { hostname: 'chat.qwen.ai' } },
    getCurrentConvId: function () { return CONV_ID; },
    aiCmCanonicalConvId: function () { return CONV_ID; },
    lastTokensSnapshot: { src: 'dom' },
    baseComplete: false,
    lastSnapshotModelName: 'Qwen3.8-Max',
    lastResolvedModelId: 'qwen3.8-max',
    maxTokenCount: 2593,
    lastPercentage: 42.5,
    computeEffectiveLimit: function () { return 1000000; },
    aiCmReadContextSnapshot: function () { return null; },
    buildHistoryMessages: function () { return live.map(function (m) { return Object.assign({}, m); }); },
    aiCmFlushLiveStreamForExport: function () { },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmUnionFileMessages: function () { return union.map(function (m) { return Object.assign({}, m); }); },
    aiCmCanonicalizeMessages: canonicalizeMessages,
    aiCmBuildCanonicalBody: function () {
      throw new Error('inv-i3-md-json: union-путь не должен звать aiCmBuildCanonicalBody');
    },
    aiCmExportNetSyncSite: function () { return false; },
    debugLog: function () { },
    swallowSoft: function () { }
  };
  Object.assign(ctx, over || {});
  return { ctx: ctx, resp: resp, live: live, union: union };
}

/** Текстовые блоки MD после шапки, разобранные по маркерам ролей ('### USER'/'### ASSISTANT'). */
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

/** Сколько раз подстрока вошла в текст (dup-детектор reasoning/drop). */
function countOf(text, sub) {
  return String(text).split(sub).length - 1;
}

function loadPopup() {
  openOptionsExportGate({ history: null });
  return loadOptions();
}

describe('inv-i3 (S5): MD и JSON одного нажатия — один канонический массив', function () {
  test('(i) qwen: JSON join(text) === MD-тело === canonicalBodyText; контейнер отброшен, reasoning один раз', function () {
    const mod = loadPopup();
    // Контейнер-склейка DOM-адаптера qwen (O-36/D2.1): содержит тексты ДВУХ реплик целиком.
    const raw = [
      { role: 'user', text: 'Вопрос первый' },
      { role: 'assistant', text: 'Ответ первый' },
      { role: 'assistant', text: 'Вопрос первый\nОтвет первый' },
      { role: 'assistant', text: 'Ответ с рассуждением', reasoning: 'Рассуждение ответа' }
    ];
    const messages = canonicalizeMessages(raw, 'qwen');
    expect(messages).toHaveLength(3);
    expect(messages.some(function (m) { return m.text === 'Вопрос первый\nОтвет первый'; })).toBe(false);

    const hist = {
      site: 'qwen', model: 'Qwen3.8-Max',
      tokens: 2593, limit: 1000000, percent: 0.3, src: 'dom',
      messages: messages
    };
    const json = JSON.parse(mod.buildJsonText(hist));
    const md = mod.buildMdText(hist);
    const body = json.messages.map(function (m) { return m.text; }).join('\n');
    const mdTexts = mdBodyTexts(md);

    // platform в JSON — СЫРОЙ ключ сайта, а не метка siteLabels ('qwen' нет в таблице).
    expect(json.platform).toBe('qwen');
    expect(body).toBe(Canonical.canonicalBodyText(messages));
    expect(mdTexts.length).toBe(messages.length);
    expect(mdTexts.join('\n')).toBe(body);
    // маркеров ровно столько же, сколько сообщений в каноническом массиве
    const markers = md.split('\n').filter(function (line) {
      return line === '### USER' || line === '### ASSISTANT';
    }).length;
    expect(markers).toBe(messages.length);
    // reasoning сложен один раз, дубля секции нет
    expect(body).toContain('[REASONING]\nРассуждение ответа');
    expect(countOf(body, 'Рассуждение ответа')).toBe(1);
  });

  test('(ii) partial: метки в MD и те же ключи в JSON одного нажатия', function () {
    const mod = loadPopup();
    const messages = canonicalizeMessages([
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: 'Ответ' }
    ], 'qwen');
    const hist = {
      site: 'qwen', model: 'Qwen3.8-Max',
      tokens: 100, limit: 1000, percent: 10, src: 'dom',
      partial: true, partialReason: 'stale',
      messages: messages
    };
    const md = mod.buildMdText(hist);
    const json = JSON.parse(mod.buildJsonText(hist));
    expect(md).toContain('metric-partial: 1');
    expect(md).toContain('metric-partial-reason: stale');
    expect(json.partial).toBe(true);
    expect(json.partialReason).toBe('stale');
    // тело файла одно и то же в обеих дорожках
    expect(mdBodyTexts(md).join('\n')).toBe(json.messages.map(function (m) { return m.text; }).join('\n'));
    // полный снимок — ни одного нового ключа/строки
    const full = Object.assign({}, hist, { partial: undefined, partialReason: undefined });
    expect(mod.buildMdText(full)).not.toContain('metric-partial');
    expect(mod.buildJsonText(full)).not.toContain('"partial"');
  });

  test('(iii) low-confidence/union: массив = канонизация объединения, MD === JSON, файл шире снимка', function () {
    const sb = manualSandbox({});
    runSlice(MANUAL_CODE, sb.ctx);
    expect(sb.resp).toHaveLength(1);
    const data = sb.resp[0].data;

    expect(data.isLowConfidenceBase).toBe(true);
    // Один массив на ручном пути: это канонизация объединения архив+live, а не тело снимка.
    expect(data.messages).toEqual(canonicalizeMessages(sb.union, 'qwen'));

    const mod = loadPopup();
    const json = JSON.parse(mod.buildJsonText(data));
    const md = mod.buildMdText(data);
    const fileBody = json.messages.map(function (m) { return m.text; }).join('\n');

    expect(fileBody).toBe(Canonical.canonicalBodyText(data.messages));
    expect(mdBodyTexts(md).join('\n')).toBe(fileBody);

    // Исключение ТОЛЬКО из I3a: тело файла (union) ≠ тело снимка (live) — файл помечается partial.
    const snapshotBody = Canonical.canonicalBodyText(canonicalizeMessages(sb.live, 'qwen'));
    expect(fileBody).not.toBe(snapshotBody);
    expect(fileBody).toContain('Архивный вопрос');
    expect(fileBody).toContain('Живой вопрос');
  });

  test('(vi) ChatGPT saturated: ручной файл получает 100 %, context-saturated и три факта лимита', function () {
    const snap = {
      modelName: 'GPT-6', src: 'net', tokens: 68893, percent: 53.8, limit: 128000,
      effectiveLimit: 128000, contextLimit: 1050000, windowLimit: 1050000,
      accountLimit: null, limitPlan: 'free', limitWarnings: ['account-limit-unknown'],
      saturated: true, partial: false
    };
    const live = [
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: 'Ответ' }
    ];
    const sb = manualSandbox({
      currentAdapter: { siteName: 'chatgpt' },
      window: { location: { hostname: 'chatgpt.com' } },
      baseComplete: true,
      maxTokenCount: 68893,
      lastPercentage: 100,
      lastTokensSnapshot: snap,
      computeEffectiveLimit: function () { return 128000; },
      aiCmReadContextSnapshot: function () { return snap; },
      buildHistoryMessages: function () { return live.map(function (m) { return Object.assign({}, m); }); },
      aiCmUnionFileMessages: function () { return live.map(function (m) { return Object.assign({}, m); }); },
      aiCmBuildCanonicalBody: function () { return { messages: live.map(function (m) { return Object.assign({}, m); }) }; }
    });
    runSlice(MANUAL_CODE, sb.ctx);
    const data = sb.resp[0].data;
    expect(data.saturated).toBe(true);
    expect(data.percent).toBe(100);
    expect(data.windowLimit).toBe(1050000);
    expect(data.displayLimit).toBe(128000);
    expect(data.accountLimit).toBeNull();
    expect(data.limitPlan).toBe('free');
    expect(data.limitWarnings).toEqual(['account-limit-unknown']);

    const md = loadPopup().buildMdText(data);
    expect(md).toContain('Токены: 68893 / 128000 (100%)');
    expect(md).toContain('context-saturated: 1');
    expect(md).toContain('model-window: 1050000');
    expect(md).toContain('display-limit: 128000');
    expect(md).toContain('account-limit: unknown');
    expect(md).toContain('limit-plan: free');
  });

  test('(vii) Gemini Free: ручной файл считает от тарифных 32K, а не от 128K', function () {
    const snap = {
      modelName: 'Gemini 3.6 Flash', src: 'net', tokens: 16000, percent: 48.8, limit: 32768,
      effectiveLimit: 32768, contextLimit: 1048576, windowLimit: 1048576,
      accountLimit: 32768, limitPlan: 'free', limitWarnings: [],
      saturated: false, partial: false
    };
    const live = [
      { role: 'user', text: 'Вопрос' },
      { role: 'assistant', text: 'Ответ' }
    ];
    const sb = manualSandbox({
      currentAdapter: { siteName: 'gemini' },
      window: { location: { hostname: 'gemini.google.com' } },
      baseComplete: true,
      maxTokenCount: 16000,
      lastPercentage: 48.8,
      lastTokensSnapshot: snap,
      // Legacy-порог намеренно 128K: ручной файл не должен печатать его вместо 32K.
      computeEffectiveLimit: function () { return 128000; },
      aiCmReadContextSnapshot: function () { return snap; },
      buildHistoryMessages: function () { return live.map(function (m) { return Object.assign({}, m); }); },
      aiCmUnionFileMessages: function () { return live.map(function (m) { return Object.assign({}, m); }); },
      aiCmBuildCanonicalBody: function () { return { messages: live.map(function (m) { return Object.assign({}, m); }) }; }
    });
    runSlice(MANUAL_CODE, sb.ctx);
    const data = sb.resp[0].data;
    expect(data.limit).toBe(32768);
    expect(data.displayLimit).toBe(32768);

    const mod = loadPopup();
    const md = mod.buildMdText(data);
    expect(md).toContain('Токены: 16000 / 32768 (48.8%)');
    expect(md).toContain('model-window: 1048576');
    expect(md).toContain('display-limit: 32768');
    expect(md).toContain('account-limit: 32768');
    expect(md).toContain('limit-plan: free');
    const json = JSON.parse(mod.buildJsonText(data));
    expect(json.limit).toBe(32768);
    expect(json.displayLimit).toBe(32768);
    expect(json.accountLimit).toBe(32768);
  });

  test('(viii) GSA и Gemini Auto: 1M окно, 128K порог, лимит аккаунта unknown', function () {
    const cases = [
      {
        site: 'google_search', host: 'www.google.com',
        warnings: ['account-limit-unknown']
      },
      {
        site: 'gemini', host: 'gemini.google.com',
        warnings: ['plan-unknown', 'account-limit-unknown']
      }
    ];
    cases.forEach(function (c) {
      const snap = {
        modelName: 'Gemini 3.6 Flash', src: 'net', tokens: 20000, percent: 15.6, limit: 128000,
        effectiveLimit: 128000, contextLimit: 1048576, windowLimit: 1048576,
        accountLimit: null, limitPlan: null, limitWarnings: c.warnings,
        saturated: false, partial: false
      };
      const live = [
        { role: 'user', text: 'Вопрос' },
        { role: 'assistant', text: 'Ответ' }
      ];
      const sb = manualSandbox({
        currentAdapter: { siteName: c.site },
        window: { location: { hostname: c.host } },
        baseComplete: true,
        maxTokenCount: 20000,
        lastPercentage: 15.6,
        lastTokensSnapshot: snap,
        computeEffectiveLimit: function () { return 128000; },
        aiCmReadContextSnapshot: function () { return snap; },
        buildHistoryMessages: function () { return live.map(function (m) { return Object.assign({}, m); }); },
        aiCmUnionFileMessages: function () { return live.map(function (m) { return Object.assign({}, m); }); },
        aiCmBuildCanonicalBody: function () { return { messages: live.map(function (m) { return Object.assign({}, m); }) }; }
      });
      runSlice(MANUAL_CODE, sb.ctx);
      const data = sb.resp[0].data;
      expect(data.accountLimit).toBeNull();
      expect(data.limitPlan == null).toBe(true);
      const mod = loadPopup();
      const md = mod.buildMdText(data);
      expect(md).toContain('Токены: 20000 / 128000 (15.6%)');
      expect(md).toContain('model-window: 1048576');
      expect(md).toContain('display-limit: 128000');
      expect(md).toContain('account-limit: unknown');
      expect(md).not.toContain('limit-plan:');
      expect(md).toContain('limit-warnings: ' + c.warnings.join(','));
      const json = JSON.parse(mod.buildJsonText(data));
      expect(json.accountLimit).toBeNull();
      expect('limitPlan' in json).toBe(false);
    });
  });

  test('(iv) gemini: sourceTier в JSON, platform === сырому ключу, MD-шапка по-прежнему локализована', function () {
    const mod = loadPopup();
    const hist = {
      site: 'gemini', model: 'Gemini 2.5 Pro',
      tokens: 12000, limit: 1000000, percent: 1.2, src: 'net', sourceTier: '[BEST-EFFORT: LIVE CAPTURE]',
      messages: [
        { role: 'user', text: 'Вопрос' },
        { role: 'assistant', text: 'Ответ' }
      ]
    };
    const json = JSON.parse(mod.buildJsonText(hist));
    expect(json.platform).toBe('gemini');            // сырой ключ сайта
    expect(json.sourceTier).toBe('[BEST-EFFORT: LIVE CAPTURE]');
    expect(json.src).toBe('net');

    const md = mod.buildMdText(hist);
    const headerLine = md.split('\n').filter(function (line) { return /^Платформа: /.test(line); })[0];
    expect(headerLine).toBe('Платформа: Gemini');    // метка siteLabels — только в MD
    expect(md).toContain('metric-src: net');
    expect(md).toContain('[BEST-EFFORT: LIVE CAPTURE]');   // ярус из того же снимка
    expect(md).not.toContain('Платформа: gemini');
    // JSON чужой метки не несёт
    expect(JSON.stringify(json.platform)).not.toContain('Gemini');
  });

  test('(v) сборщики на каноническом входе тождественны: drop/reasoning не срабатывают второй раз', function () {
    const raw = [
      { role: 'user', text: 'Вопрос первый' },
      { role: 'assistant', text: 'Ответ первый' },
      { role: 'assistant', text: 'Вопрос первый\nОтвет первый' },
      { role: 'assistant', text: 'Ответ с рассуждением', reasoning: 'Рассуждение ответа' }
    ];
    const canon = canonicalizeMessages(raw, 'qwen');
    // Идемпотентность: повторная канонизация — тот же массив (drop и reasoning применены один раз).
    expect(canonicalizeMessages(canon, 'qwen')).toEqual(canon);

    const hist = { site: 'qwen', model: 'Qwen3.8-Max', tokens: 10, limit: 100, percent: 10, messages: canon };
    const reference = Canonical.canonicalBodyText(canon);

    const md = Builders.buildMdFromHistory(hist, 'Qwen');
    expect(mdBodyTexts(md).join('\n')).toBe(reference);
    expect(countOf(md, '[REASONING]')).toBe(1);
    expect(countOf(md, 'Рассуждение ответа')).toBe(1);

    const txt = Builders.buildTxtFromHistory(hist);
    expect(countOf(txt, '[REASONING]')).toBe(1);
    expect(countOf(txt, '[ANSWER]')).toBe(1);
    expect(countOf(txt, 'Рассуждение ответа')).toBe(1);
    expect(txt).toContain('USER:\nВопрос первый');
  });
});