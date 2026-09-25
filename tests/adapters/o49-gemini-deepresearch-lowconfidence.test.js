/**
 * O-49: потеря сообщений Deep Research в экспорте Gemini при isLowConfidenceBase=true.
 *
 * Живой симптом (Gemini, Deep Research, 2026-09-25): БАЗА — 6 сообщений (i=0 len=4975
 * «ROLE & OBJECTIVE», i=1 len=77 план, i=2 len=19 «Начать исследование», i=3 len=26855
 * отчёт «Исследование завершено», i=4 len=35 «тест», i=5 len=410 ответ), а ФАЙЛ
 * `[LOW CONFIDENCE]_ai-context-monitor-gemini-Gemini-3.6-Flash-2026-09-25-11-41.txt` —
 * только 2 последних (i=4, i=5). Лог-свидетель `o40-emit-msg i=0..5 msgsIn=6 msgsOut=6`:
 * единая точка сбора видела ВСЕ шесть. Условие: isLowConfidenceBase=true (baseComplete=0,
 * 60s-таймаут / ручной as-is).
 *
 * Корень: точка записи снимка (`aiCmWriteCurrentHistory` — она же кормит ручной экспорт
 * ключом `aiCmHistory[:host]`) собирала массив СВОИМ вызовом, а не через единую точку сбора
 * `aiCmCollectExportSource()` (которой пользуется автоэкспорт): при неполной as-is-базе
 * локальный снимок EMIT несёт только последние ходы, тогда как полная база ТОГО ЖЕ
 * разговора (объединённая, архив + live) уже посчитана в MAIN.
 *
 * Фикс: оба пути идут через ОДИН конвейер — aiCmCollectExportSource() (санация
 * O-20/O-40/O-42 + нормализация ролей O-39) → aiCmDedupeExportSource (E-2) → при
 * isLowConfidenceBase=true добор объединённой базой (архив + live), если она СТРОГО
 * полнее локального снимка (aiCmUnionFileMessages / aiCmExportBaseSource).
 *
 * Пины: D1 (6 сообщений + 4 маркера), D2 (source-пин проводки единой точки),
 * R1 (санация O-20/O-40/O-42 на пути записи), R2 (O-39 reasoning 53/53 при включённом
 * тумблере), R3 (обычный Gemini-чат baseComplete=1 — снимок байтово прежний),
 * R4 (O-48: [LOW CONFIDENCE]_ + tolerant-salvage не тронуты).
 */
const fs = require('fs');
const path = require('path');

const P = require('../../utils/export-emit-pipeline.js');

const ROOT = path.join(__dirname, '..', '..');
const EXPORT_MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const BASE_HANDLER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'base-handler.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const GEMINI_SRC = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');

// ---------------------------------------------------------------------------------
// Утилиты среза исходника (конвенция сьютов проекта)
// ---------------------------------------------------------------------------------
function sliceSource(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error('срез не найден: ' + startMarker);
  return src.slice(start, end);
}

// Рез по балансу фигурных скобок — комментарии следующей функции не затягиваются.
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

// ---------------------------------------------------------------------------------
// Фикстура живого прогона: 6 сообщений базы Deep Research (длины — как в свидетеле)
// ---------------------------------------------------------------------------------
const CID = '72c88213f2e812e1';

function pad(text, len) {
  const s = String(text);
  return (s.length >= len) ? s.slice(0, len) : s + 'x'.repeat(len - s.length);
}

const DR_PROMPT = pad('ROLE & OBJECTIVE — промпт Deep Research.', 4975);
const DR_PLAN = pad('Вот план исследования: цель и шаги.', 77);
const DR_BUTTON = pad('Начать исследование', 19);
const DR_REPORT = pad('Исследование завершено. Отчёт Deep Research.', 26855);
const DR_TEST_Q = pad('тест', 35);
const DR_ANSWER = pad('Ответ на тест.', 410);

const MARKERS = ['ROLE & OBJECTIVE', 'план исследования', 'Начать исследование', 'Исследование завершено'];

// База (6 сообщений) — то, что видит единая точка сбора и MAIN.
const DR_BASE = [
  { role: 'user', text: DR_PROMPT },
  { role: 'assistant', text: DR_PLAN },
  { role: 'assistant', text: DR_BUTTON },
  { role: 'assistant', text: DR_REPORT },
  { role: 'user', text: DR_TEST_Q },
  { role: 'assistant', text: DR_ANSWER }
];
// Локальный снимок EMIT в состоянии as-is/таймаута (baseComplete=0): только последние ходы.
const DR_LOCAL = DR_BASE.slice(4);

function unionSnapshot(base) {
  return {
    convId: CID,
    archiveCount: base.length - DR_LOCAL.length,
    liveCount: DR_LOCAL.length,
    baseMsgs: base.length,
    messages: base.map((m, i) => ({ id: 'u' + i, role: m.role, text: m.text }))
  };
}

// ---------------------------------------------------------------------------------
// Песочница РЕАЛЬНОГО пути записи снимка: core/export-manager.js (sanitizeGeminiText →
// aiCmCollectExportSource → aiCmExportBaseSource → aiCmUnionFileMessages →
// aiCmWriteCurrentHistory) + core/base-handler.js (aiCmDedupeExportSource,
// buildHistoryMessages) в одном лексическом скоупе — как в браузере.
// ---------------------------------------------------------------------------------
function makeWriteSandbox(opts) {
  const o = opts || {};
  const logs = [];
  const writes = [];
  const sanitizeCalls = { n: 0 };
  const localMsgs = o.localMsgs || DR_LOCAL;
  const pipeline = Object.assign({}, P, {
    sanitizeEmitMessages: function (messages) {
      sanitizeCalls.n++;
      return P.sanitizeEmitMessages(messages);
    }
  });
  const ctx = {
    window: { AiCmExportEmitPipeline: pipeline, location: { hostname: 'gemini.google.com' } },
    sessionStorage: { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } },
    console: { log: function () { }, warn: function () { }, error: function () { }, info: function () { } },
    aiCmSanitizeSkipLogged: {},
    lastBaseTexts: localMsgs.map((m) => m.text),
    lastDetailMessages: localMsgs.map((m) => {
      const out = { role: m.role, text: m.text };
      if (typeof m.reasoning === 'string' && m.reasoning) out.reasoning = m.reasoning;
      return out;
    }),
    lastEmitConvId: CID,
    lastResolvedModelId: 'gemini-3.6-flash',
    lastSnapshotModelName: 'Gemini-3.6-Flash',
    maxTokenCount: 1234,
    baseSeen: true,
    baseComplete: o.baseComplete === true,
    baseText: localMsgs.map((m) => m.text).join('\n'),
    currentAdapter: o.adapter || { siteName: 'gemini', extractMessages: function () { return []; } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    isExtensionValid: function () { return true; },
    getCurrentConvId: function () { return CID; },
    computeEffectiveLimit: function () { return 100000; },
    ModelConfig: { getModel: function () { return { name: 'Gemini-3.6-Flash' }; } },
    aiCmHostHistoryRecord: function (snap) { return Object.assign({}, snap); },
    aiCmGeminiTurnsSnapshotSync: function () { return (o.snap === undefined) ? null : o.snap; },
    chrome: { storage: { local: { set: function (patch) { writes.push(patch); } } } }
  };
  const code = sliceSource(EXPORT_MGR_SRC, 'function sanitizeGeminiText(s)', '// T1-fix#3') + '\n' +
    fnDecl(BASE_HANDLER_SRC, 'aiCmDedupeExportSource') + '\n' +
    fnDecl(BASE_HANDLER_SRC, 'buildHistoryMessages') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmExportBaseSource') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmUnionFileMessages') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmWriteCurrentHistory') + '\n' +
    'ctx.__write = aiCmWriteCurrentHistory;\n' +
    'ctx.__union = aiCmUnionFileMessages;\n' +
    'ctx.__collect = aiCmCollectExportSource;\n' +
    'ctx.__dedupe = aiCmDedupeExportSource;\n' +
    'ctx.__history = buildHistoryMessages;\n' +
    // `var aiCmIncludeHiddenInExport = false;` объявлен ВНУТРИ среза единой точки сбора,
    // поэтому тумблер включается ровно так же, как в сьютах O-7/O-39/D-O41 (сеттер в скоупе).
    'ctx.__setHidden = function (v) { aiCmIncludeHiddenInExport = (v === true); };';
  // eslint-disable-next-line no-new-func
  new Function('ctx', 'with (ctx) { (function () {\n' + code + '\n})(); }')(ctx);
  return {
    ctx: ctx,
    logs: logs,
    sanitizeCalls: sanitizeCalls,
    snapshot: function () {
      ctx.__write();
      const patch = writes[writes.length - 1];
      return patch ? patch.aiCmHistory : null;
    }
  };
}

describe('O-49 D1: Deep Research + isLowConfidenceBase=true → в снимке/файле все 6 сообщений', () => {
  test('путь записи снимка (таймаут/ручной as-is): 6 сообщений и все 4 маркера Deep Research', () => {
    const sb = makeWriteSandbox({ baseComplete: false, snap: unionSnapshot(DR_BASE) });
    const snap = sb.snapshot();
    expect(snap).toBeTruthy();
    expect(snap.isLowConfidenceBase).toBe(true);          // честная маркировка сохранена (O-48)
    expect(snap.messages.length).toBe(6);                  // было 2 (i=4, i=5) до фикса
    const joined = snap.messages.map((m) => m.text).join('\n');
    MARKERS.forEach(function (marker) { expect(joined).toContain(marker); });
    expect(sb.logs.join('\n')).toContain('O-49 low-confidence base-union: localMsgs=2 unionMsgs=6');
  });

  test('локальный снимок без объединённой базы (моста нет) → прежний путь 1:1 (2 сообщения)', () => {
    const sb = makeWriteSandbox({ baseComplete: false, snap: null });
    const snap = sb.snapshot();
    expect(snap.messages.length).toBe(2);
    expect(snap.isLowConfidenceBase).toBe(true);
  });

  test('aiCmUnionFileMessages: добор только СТРОГО полнее и только при isLowConfidence=true', () => {
    const sb = makeWriteSandbox({ baseComplete: false, snap: unionSnapshot(DR_BASE) });
    const local = DR_LOCAL.slice();
    // низкая достоверность + объединённая база полнее → добор
    expect(sb.ctx.__union(CID, local, true).length).toBe(6);
    // база подтверждена → вызов не делает ничего (R3)
    expect(sb.ctx.__union(CID, local, false)).toEqual(local);
    // объединённая база НЕ полнее локальной → локальный снимок
    const eq = makeWriteSandbox({ baseComplete: false, snap: { convId: CID, archiveCount: 2, liveCount: 2, baseMsgs: 2, messages: [] } });
    expect(eq.ctx.__union(CID, local, true)).toEqual(local);
  });

  test('ручной экспорт (content.js): снимок ответа добирается той же точкой', () => {
    const manual = sliceSource(CONTENT_SRC, "if (message.type === 'aiCmExportCurrent')", "if (message.type === 'GET_STATS')");
    expect(manual).toContain("messages: buildHistoryMessages()");       // прежняя сборка сохранена
    expect(manual).toContain('aiCmUnionFileMessages(curCidExp, manualSnapshot.messages');
    expect(manual).toContain('manualSnapshot.isLowConfidenceBase === true');
    expect(manual).toContain('sendResponse({ data: manualSnapshot });');
  });
});

describe('O-49 D2: source-пин — единая точка сбора на пути записи', () => {
  test('aiCmWriteCurrentHistory использует aiCmCollectExportSource + aiCmDedupeExportSource', () => {
    const body = fnDecl(EXPORT_MGR_SRC, 'aiCmWriteCurrentHistory');
    expect(body).toContain('aiCmCollectExportSource()');       // единая точка сбора
    expect(body).toContain('aiCmDedupeExportSource(msgsWrite)'); // та же схлопка E-2
    expect(body).toContain('msgsWrite = buildHistoryMessages();'); // фолбэк (срез-песочницы/пустая база)
    expect(body).toContain('aiCmUnionFileMessages(cid, msgsWrite, (baseComplete !== true))');
    expect(body).not.toContain('messages: buildHistoryMessages()'); // собственной сборки больше нет
    expect(body).toContain('messages: msgsWrite');
    // флаг низкой достоверности — живой (O-36/O-48 не переписаны)
    expect(body).toContain('isLowConfidenceBase: (baseComplete !== true)');
  });

  test('добор объединённой базы — единственная точка aiCmExportBaseSource (не-Gemini → null)', () => {
    const body = fnDecl(EXPORT_MGR_SRC, 'aiCmUnionFileMessages');
    expect(body).toContain('aiCmExportBaseSource(cid, localMsgs)');
    expect(body).toContain('union.msgs.length > localMsgs.length');
    expect(body).toContain('if (isLowConfidence !== true) return localMsgs;');
  });

  test('байты снимка health-чата не меняются: единая точка = то же выражение, что buildHistoryMessages', () => {
    // Один и тот же базовый массив → оба выхода идентичны байтово (без объединённой базы).
    const sb = makeWriteSandbox({ baseComplete: true, snap: null });
    const collected = sb.ctx.__collect();
    const viaUnified = sb.ctx.__dedupe(collected).messages;
    const viaLegacy = sb.ctx.__history();
    expect(JSON.stringify(viaUnified)).toBe(JSON.stringify(viaLegacy));
  });
});

describe('O-49 R1: санация O-20/O-40/O-42 работает на пути записи (та же единая точка)', () => {
  const START = '<!-- deepseek-pp-visible-user-prompt:start -->';
  const END = '<!-- deepseek-pp-visible-user-prompt:end -->';
  const VISIBLE = 'R1: в снимке/файле виден только мой текст.';
  const INJECTED = 'You have long-term memory.\nTool call format reminder:\n\n' +
    START + '\n' + VISIBLE + '\n' + END + '\n\nContinue answering based on the tool results above.';

  test('user-текст с парой маркеров DeepSeek++ → в снимке видимый текст (O-20)', () => {
    const sb = makeWriteSandbox({
      baseComplete: false,
      adapter: { siteName: 'deepseek', extractMessages: function () { return []; } },
      localMsgs: [{ role: 'user', text: INJECTED }, { role: 'assistant', text: 'Ответ.' }]
    });
    const snap = sb.snapshot();
    expect(snap.messages.length).toBe(2);
    expect(snap.messages[0].text).toBe(VISIBLE);
    expect(snap.messages[0].text).not.toContain('deepseek-pp-visible-user-prompt');
    expect(sb.sanitizeCalls.n).toBeGreaterThan(0);   // санация O-20/O-40/O-42 вызвана единой точкой
  });

  test('санация стоит ВНУТРИ единой точки сбора (обе ветки) — путь записи не обходит её', () => {
    const collect = sliceSource(EXPORT_MGR_SRC, 'function aiCmCollectExportSource()', 'function aiCmExportBaseSource(');
    // выход каждой ветки единой точки (сеть + DOM-адаптер) идёт через aiCmSanitizeEmitUserTexts
    expect(collect.match(/return aiCmSanitizeEmitUserTexts\(out\);/g).length).toBe(2);
    expect(EXPORT_MGR_SRC).toContain('P.sanitizeEmitMessages(messages)');
  });
});

describe('O-49 R2: O-39 reasoning на пути записи базы (53/53, ON-путь тумблера)', () => {
  const REASONING = 'размышление хода';
  const ANSWER = 'ответ хода';

  function qwenBase() {
    const msgs = [];
    for (let i = 0; i < 53; i++) {
      msgs.push({ role: 'user', text: '[REASONING]' + REASONING + i + '[ANSWER]вопрос ' + i });
      msgs.push({ role: 'assistant', text: '[REASONING]' + REASONING + i + '[ANSWER]' + ANSWER + i, reasoning: REASONING + i });
    }
    return msgs;
  }

  test('53 хода с полем reasoning доезжают до снимка (тумблер ON, как в живой приёмке O-39)', () => {
    const base = qwenBase();
    const sb = makeWriteSandbox({
      baseComplete: true,
      adapter: { siteName: 'qwen', extractMessages: function () { return []; } },
      localMsgs: base
    });
    sb.ctx.__setHidden(true);   // живая приёмка O-39 шла на ON-пути тумблера
    const snap = sb.snapshot();
    expect(snap.messages.length).toBe(base.length);
    const withReasoning = snap.messages.filter((m) => typeof m.reasoning === 'string' && m.reasoning);
    expect(withReasoning.length).toBe(53);
    const joined = snap.messages.map((m) => m.text).join('\n');
    expect((joined.match(/\[REASONING\]/g) || []).length).toBeGreaterThanOrEqual(53);
    expect((joined.match(/\[ANSWER\]/g) || []).length).toBeGreaterThanOrEqual(53);
  });
});

describe('O-49 R3: обычный Gemini-чат (baseComplete=1) — снимок байтово прежний', () => {
  test('baseComplete=true + объединённая база полнее → снимок НЕ добирается (путь прежний)', () => {
    const local = DR_BASE.slice(0, 4);   // локальный снимок «здорового» чата
    const sb = makeWriteSandbox({ baseComplete: true, snap: unionSnapshot(DR_BASE), localMsgs: local });
    const snap = sb.snapshot();
    expect(snap.isLowConfidenceBase).toBe(false);
    expect(snap.messages.length).toBe(4);
    expect(JSON.stringify(snap.messages)).toBe(JSON.stringify(local));
    expect(sb.logs.join('\n')).not.toContain('O-49 low-confidence base-union');
  });

  test('снимок = прежнее выражение buildHistoryMessages (байтовое сравнение)', () => {
    const local = DR_BASE.slice(0, 4);
    const sb = makeWriteSandbox({ baseComplete: true, snap: null, localMsgs: local });
    const legacy = sb.ctx.__history();
    const snap = sb.snapshot();
    expect(JSON.stringify(snap.messages)).toBe(JSON.stringify(legacy));
  });
});

describe('O-49 R4: O-48 не тронут — [LOW CONFIDENCE]_ + tolerant-salvage как прежде', () => {
  test('[LOW CONFIDENCE]_ в имени ручного файла — от живого флага снимка (options.js)', () => {
    expect(OPTIONS_SRC).toContain("var lowConfPrefix = (hist && hist.isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';");
  });

  test('60s-таймаут и tolerant-salvage (reason=parse-fail) на месте', () => {
    expect(EXPORT_MGR_SRC).toContain("aiCmLowConfidenceByConv[cid] = true;");
    expect(EXPORT_MGR_SRC).toContain("deferred-timeout(60s), exporting as-is convId=");
    expect(GEMINI_SRC).toContain("reason='parse-fail'");
    expect(GEMINI_SRC).toContain('salvagedTurns');
  });

  test('T1-фикс#3 (архивная объединённая база) не переписан: автопуть прежний', () => {
    expect(EXPORT_MGR_SRC).toContain('var baseSrc = aiCmExportBaseSource(cid, msgs);');
    expect(fnDecl(EXPORT_MGR_SRC, 'aiCmExportBaseSource')).toContain('P.resolveExportSource(');
  });
});
