/**
 * T1-fix#3 (v1.16.3): файл автоэкспорта собирается из ОБЪЕДИНЁННОЙ базы (архив + live),
 * а не из одной архивной части.
 *
 * БАГ live-прогона (после T1-fix#2, v1.16.2): console показывал объединённую базу
 * (baseSize=114, msgs=114, overlapCount=20), а в экспортированном файле лежали только
 * архивные ходы (первые/последние строки — тренировочные «Как называется квадратное…» и
 * «Страницы памяти помечаются read-only…»).
 *
 * ПРИЧИНА (проверено по коду): прямой чтение aiCmArchive:<convId> в экспорте НЕТ —
 * архив попадает в файл через ОБЩУЮ базу (same-conv-union: архив вливается в тот же
 * turnsMap). Но источником файла служит последний EMIT (lastBaseTexts), а архив
 * вливается в базу ПЕРВЫМ (content.js читает aiCmArchive: сразу при page-load, до
 * живого RPC) — поэтому:
 *   (а) база «только архив» могла объявить полноту и выгрузиться файлом из одних
 *       архивных ходов (латч fired при этом ставился триггером base-complete, v64,
 *       который шёл МИМО гейта shouldSkipAutoExport);
 *   (б) даже когда база уже несла живую историю, локальный снимок EMIT мог отставать —
 *       файл уходил архивной частью при базе из 114 ходов.
 *
 * ФИКС: (1) источник файла — объединённая база MAIN (архив + live) через существующий
 * синхронный мост turns-snap; (2) гейт «в базе только архив» (живых ходов 0) стоит в
 * ЕДИНСТВЕННОЙ точке записи файла (doAutoExportDownload) — покрывает порог, base-complete
 * (v64), pre-trim (v54) и поздний re-check; латч fired при гейте НЕ ставится.
 *
 * НЕ ТРОГАЕТСЯ: saveFloor/archiveFloorRecord (HWM), H9/H10-гейты, resetForNewConversation,
 * ручной экспорт попапа и запись aiCmHistory (отдельный контур).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const Logic = require('../../utils/gemini-intercept-logic.js');
const Pipeline = require('../../utils/export-emit-pipeline.js');
const Archive = require('../../utils/archive-import.js');
const CORE_GEMINI = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');
const CORE_CONTENT = require('../helpers/content-source.js').contentSource;
const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');

// Рез по балансу фигурных скобок: fnSource-стиль затягивает комментарии следующей функции.
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

// ——— сценарий live-прогона ———
const ARCHIVE_MSGS = 20;   // ходов в архиве
const LIVE_ONLY = 94;      // живых ходов СВЕРХ архива (их нет в архиве)
const LIVE_WINDOW = 114;   // живое окно сервера (= ARCHIVE_MSGS-пересечение + LIVE_ONLY)
const OVERLAP = 20;        // пересечение архива и живого окна (по контенту, id разные)
const UNION = ARCHIVE_MSGS + LIVE_ONLY; // 114 — объединённая база

function archiveMessages() {
  const out = [];
  for (let i = 0; i < ARCHIVE_MSGS / 2; i++) {
    out.push({ role: 'user', text: 'тренировочный вопрос ' + i });
    out.push({ role: 'assistant', text: 'тренировочный ответ ' + i });
  }
  return out; // [{...}, ...] 20 ходов
}
function liveMessages() {
  // 20 ходов живого окна СОВПАДАЮТ по контенту с архивом (пересечение=20), но id другие
  const out = archiveMessages().map((m, i) => ({ id: 'net_' + i, role: m.role, text: m.text }));
  for (let i = 0; i < LIVE_ONLY; i++) {
    out.push({ id: 'live_' + i, role: i % 2 ? 'assistant' : 'user', text: 'живой ход ' + i });
  }
  return out;
}
// Объединённая база MAIN: архивные ходы (id a:*) + живые, НЕ влитые архивом (94).
function unionMessages() {
  const arch = archiveMessages().map((m, i) => ({ id: 'a:' + i, role: m.role, text: m.text }));
  const liveOnly = liveMessages().slice(OVERLAP).map((m) => ({ id: m.id, role: m.role, text: m.text }));
  return arch.concat(liveOnly); // 20 + 94 = 114
}

// ——— T1-fix#4 (v1.16.4): 4 архивных хода + 110 живых (архив обязан идти В ГОЛОВЕ) ———
const ARCH4 = [
  { id: 'a1', role: 'user', text: 'тренировочный вопрос 0' },
  { id: 'a2', role: 'assistant', text: 'тренировочный ответ 0' },
  { id: 'a3', role: 'user', text: 'Страницы памяти помечаются read-only' },
  { id: 'a4', role: 'assistant', text: 'тренировочный ответ 1' }
];
const LIVE4_TURNS = 55;                    // 55 ходов × 2 сообщения = 110 живых ходов
const LIVE4_COUNT = LIVE4_TURNS * 2;       // 110
const UNION4 = ARCH4.length + LIVE4_COUNT; // 114
function live4Window() {
  const out = [];
  for (let i = 0; i < LIVE4_TURNS; i++) {
    out.push({ id: 'live_' + i + '_user', role: 'user', text: 'живой вопрос ' + i, turnId: 't' + i, r1: i === 0 ? null : 't' + (i - 1), order: i });
    out.push({ id: 'live_' + i + '_assistant', role: 'assistant', text: 'живой ответ ' + i, turnId: 't' + i, r1: i === 0 ? null : 't' + (i - 1), order: i });
  }
  return out; // 110
}
// 1:1 с обработчиком ai-cm-archive-restore (core): чистая archiveMergeTurns → запись turnsMap.
// order НЕ меняется (как в core: maxOrder+1+i — числовой order архива САМЫЙ БОЛЬШОЙ в базе),
// признак «ход влит архивом» несёт ТОЛЬКО метка archiveAdded (фикс#4).
function turns4Map(withFlag) {
  const live = live4Window();
  const map = {};
  live.forEach((m) => { map[m.id] = { role: m.role, text: m.text, order: m.order, turnId: m.turnId, r1: m.r1 }; });
  const maxOrder = Math.max.apply(null, live.map((m) => m.order));
  const merged = Logic.archiveMergeTurns(live.map((m) => ({ id: m.id, role: m.role, text: m.text })), ARCH4);
  merged.items.forEach((it, i) => {
    if (map[it.id]) return;
    const rec = {
      role: it.role, text: it.text, order: maxOrder + 1 + i,
      pageMode: 'restored', ts: 0, turnId: it.turnId, r1: null
    };
    if (withFlag) rec.archiveAdded = true;
    map[it.id] = rec;
  });
  return map; // 114
}
// Элементы для чистой функции порядка — ровно те поля, что передаёт core
// (emitBaseSnapshot / aiCmBuildBaseMessages), включая метку archive.
function order4Items(map) {
  return Object.keys(map).map((id) => ({
    id: id, turnId: map[id].turnId || null, r1: map[id].r1 || null,
    order: map[id].order || 0, role: map[id].role,
    archive: map[id].archiveAdded === true
  }));
}

// ——— эмуляция решения doAutoExportDownload (локальный снимок + мост) ———
function decide(state) {
  return Pipeline.resolveExportSource(Object.assign({
    isGemini: true, bridge: true, archiveCount: ARCHIVE_MSGS, liveCount: 0,
    baseCount: ARCHIVE_MSGS, localCount: ARCHIVE_MSGS
  }, state || {}));
}
function emulateExport(localTexts, snap) {
  // 1:1 с doAutoExportDownload: сначала локальный источник, затем решение моста
  let texts = localTexts.slice();
  const localN = texts.length;
  const v = Pipeline.resolveExportSource({
    isGemini: true, bridge: !!snap,
    archiveCount: snap ? snap.archiveCount : 0,
    liveCount: snap ? snap.liveCount : null,
    baseCount: snap ? snap.baseMsgs : 0,
    localCount: localN
  });
  if (v.action === 'block') return { fired: false, reason: v.reason, texts: [] };
  if (v.action === 'union') {
    const out = (snap.messages || []).filter((m) => m && typeof m.text === 'string' && m.text).map((m) => m.text);
    if (out.length > localN) texts = out;
  }
  if (!texts.length) return { fired: false, reason: 'empty-history', texts: [] };
  return { fired: true, reason: null, texts: texts };
}

// =====================================================================================
// А) чистый выбор источника: база «только архив» / объединённая база / прежний путь
// =====================================================================================
describe('T1-fix#3: выбор источника файла (resolveExportSource)', () => {
  test('база = только архив (живых ходов 0) → block archive-only-base', () => {
    expect(decide({ liveCount: 0, baseCount: ARCHIVE_MSGS, localCount: ARCHIVE_MSGS }))
      .toEqual({ action: 'block', reason: 'archive-only-base' });
  });

  test('живая история влилась, локальный снимок отстал → union (stale-local-source)', () => {
    expect(decide({ liveCount: LIVE_ONLY, baseCount: UNION, localCount: ARCHIVE_MSGS }))
      .toEqual({ action: 'union', reason: 'stale-local-source' });
  });

  test('локальный снимок не отстал → прежний путь (local, in-sync)', () => {
    expect(decide({ liveCount: LIVE_ONLY, baseCount: UNION, localCount: UNION }))
      .toEqual({ action: 'local', reason: 'in-sync' });
  });

  test('архив не импортирован → ВСЕГДА local (обратная совместимость 1:1)', () => {
    expect(decide({ archiveCount: 0, liveCount: 0, baseCount: 4, localCount: 4 }))
      .toEqual({ action: 'local', reason: 'no-archive' });
    expect(decide({ archiveCount: 0, liveCount: 0, baseCount: 0, localCount: 0 }))
      .toEqual({ action: 'local', reason: 'no-archive' });
  });

  test('не-Gemini и отсутствие моста → прежний путь', () => {
    expect(decide({ isGemini: false, liveCount: 0 })).toEqual({ action: 'local', reason: 'non-gemini' });
    expect(decide({ bridge: false, liveCount: 0 })).toEqual({ action: 'local', reason: 'no-bridge' });
  });

  test('нет данных о живых ходах (liveCount=null) → union не берём (только block по 0)', () => {
    expect(decide({ liveCount: null, baseCount: UNION, localCount: ARCHIVE_MSGS }).action).toBe('local');
  });

  test('порядок: block приоритетнее union (нулевой live не маскируется «ростом» базы)', () => {
    expect(decide({ liveCount: 0, baseCount: UNION, localCount: 1 }).action).toBe('block');
  });
});

// =====================================================================================
// Б) эмуляция live-прогона: архив 20, живое окно 114, пересечение 20
// =====================================================================================
describe('T1-fix#3: эмуляция archiveMsgs=20 / liveMsgs=114 / overlap=20', () => {
  const ARCH_TEXTS = archiveMessages().map((m) => m.text);
  const LIVE_TEXTS = liveMessages().map((m) => m.text);

  test('ни один шаг догрузки НЕ даёт файл из одной архивной части', () => {
    const union = unionMessages();
    for (let liveIngested = 0; liveIngested <= LIVE_ONLY; liveIngested += 2) {
      const snap = {
        convId: 'c1', archiveCount: ARCHIVE_MSGS, liveCount: liveIngested,
        baseMsgs: ARCHIVE_MSGS + liveIngested, messages: union
      };
      // худший случай: последний EMIT — архивный (локальный снимок = 20 архивных ходов)
      const stale = emulateExport(ARCH_TEXTS, liveIngested === 0
        ? snap // база из одного архива — мост тоже сообщает liveCount=0
        : snap);
      if (liveIngested === 0) {
        expect(stale.fired).toBe(false);
        expect(stale.reason).toBe('archive-only-base');
        continue;
      }
      expect(stale.fired).toBe(true);
      // файл НИКОГДА не равен архивной части и всегда покрывает объединённую базу
      expect(stale.texts.length).not.toBe(ARCHIVE_MSGS);
      expect(stale.texts.length).toBeGreaterThanOrEqual(ARCHIVE_MSGS + liveIngested);
    }
  });

  test('на полной базе файл = union (114), а не архив (20)', () => {
    const res = emulateExport(ARCH_TEXTS, {
      convId: 'c1', archiveCount: ARCHIVE_MSGS, liveCount: LIVE_ONLY,
      baseMsgs: UNION, messages: unionMessages()
    });
    expect(res.fired).toBe(true);
    expect(res.texts.length).toBe(UNION);       // 114
    expect(res.texts.length).not.toBe(ARCHIVE_MSGS); // и не 20
    // в файле есть и голова архива, и живой хвост (ни одна часть не потеряна)
    expect(res.texts).toEqual(expect.arrayContaining([ARCH_TEXTS[0], ARCH_TEXTS[ARCHIVE_MSGS - 1]]));
    expect(res.texts).toEqual(expect.arrayContaining([LIVE_TEXTS[LIVE_WINDOW - 1], LIVE_TEXTS[0]]));
    expect(new Set(res.texts).size).toBe(UNION);
  });

  test('свежий локальный снимок (не отстал) → файл тот же union, без подмены', () => {
    const union = unionMessages();
    const res = emulateExport(union.map((m) => m.text), {
      convId: 'c1', archiveCount: ARCHIVE_MSGS, liveCount: LIVE_ONLY,
      baseMsgs: UNION, messages: union
    });
    expect(res.fired).toBe(true);
    expect(res.texts.length).toBe(UNION);
  });

  test('база «только архив» не выгружается ни порогом, ни base-complete, ни pre-trim', () => {
    const snap = {
      convId: 'c1', archiveCount: ARCHIVE_MSGS, liveCount: 0,
      baseMsgs: ARCHIVE_MSGS, messages: archiveMessages().map((m, i) => ({ id: 'a:' + i, role: m.role, text: m.text }))
    };
    // все три триггера приходят в doAutoExportDownload → гейт один и тот же
    ['threshold', 'base-complete', 'pre-trim'].forEach((reason) => {
      const res = emulateExport(ARCH_TEXTS, snap);
      expect(res.fired).toBe(false);
      expect(res.reason).toBe('archive-only-base');
      expect(reason).toBeTruthy();
    });
  });

  test('без моста (не Gemini / MAIN недоступен) поведение прежнее — локальный снимок', () => {
    const res = emulateExport(ARCH_TEXTS, null);
    expect(res.fired).toBe(true);
    expect(res.texts.length).toBe(ARCHIVE_MSGS); // прежний путь 1:1, новая логика не вмешивается
  });
});

// =====================================================================================
// В) MAIN: объединённая база (тело aiCmBuildBaseMessages/aiCmBaseExportInfo из core)
// =====================================================================================
describe('T1-fix#3: объединённая база MAIN — поведение (извлечённые тела из core)', () => {
  const MAIN_SCOPE = 'with (ctx) { ' +
    ['aiCmLiveTurnCount', 'aiCmArchiveOnlyBase', 'aiCmArchiveLiveProven',
      'aiCmArchiveGrewBeyondArchive', 'aiCmBuildBaseMessages', 'aiCmBaseExportInfo']
      .map((n) => fnDecl(CORE_GEMINI, n)).join('\n') +
    ' return { msgs: aiCmBuildBaseMessages, info: aiCmBaseExportInfo }; }';
  const makeMain = new Function('ctx', MAIN_SCOPE);
  const ARCH = archiveMessages();
  const UNION_MSGS = unionMessages();

  function env(turnsMap, arch) {
    return {
      turnsMap: turnsMap,
      baseSize: () => Object.keys(turnsMap).length,
      getConvId: () => 'c1',
      aiCmArchiveFor: () => arch,
      sanitizeMessagesForEmit: (m) => m,
      window: { GeminiInterceptLogic: Logic }
    };
  }
  function archiveTier() {
    const keys = {};
    const addedIds = {};
    ARCH.forEach((m, i) => {
      keys[Logic.archiveContentKey(m)] = true;
      addedIds['a:' + i] = true;
    });
    return { convId: 'c1', count: ARCHIVE_MSGS, keys: keys, addedIds: addedIds };
  }
  // база «как в live-прогоне»: 20 архивных ходов (order = maxOrder+1+i, как ставит
  // ai-cm-archive-restore) + живое окно уже БЕЗ архива. Один живой ход — стык с архивом
  // (тот же контент, другой id): он и есть пересечение=20 (остальные 19 представлены
  // архивными копиями), поэтому пропуска середины нет — живой ярус доказан.
  function turnsUnion() {
    const map = {};
    const liveOnly = UNION_MSGS.slice(ARCHIVE_MSGS); // 94 живых хода
    liveOnly.forEach((m, i) => {
      map[m.id] = {
        role: m.role, text: (i === 0) ? ARCH[0].text : m.text,
        order: i, turnId: 't' + i, r1: i === 0 ? null : 't' + (i - 1)
      };
    });
    ARCH.forEach((m, i) => {
      // T1-fix#4: метка archiveAdded — как ставит core. order намеренно ОСТАВЛЕН прежним
      // (maxOrder+1+i): голову файла задаёт метка, а не числовой order (order питает
      // aiCmOrderedTurns → dbFirstHash H9-гейта — его менять нельзя).
      map['a:' + i] = { role: m.role, text: m.text, order: liveOnly.length + 1 + i, pageMode: 'restored', r1: null, archiveAdded: true };
    });
    return map;
  }

  test('база «только архив»: liveCount=0, объединённая база = архив', () => {
    const map = {};
    ARCH.forEach((m, i) => { map['a:' + i] = { role: m.role, text: m.text, order: i, pageMode: 'restored', r1: null }; });
    const api = makeMain(env(map, archiveTier()));
    expect(api.msgs().length).toBe(ARCHIVE_MSGS);
    const info = api.info();
    expect(info.baseMsgs).toBe(ARCHIVE_MSGS);
    expect(info.liveCount).toBe(0);
    expect(info.archiveCount).toBe(ARCHIVE_MSGS);
    expect(info.messages.length).toBe(ARCHIVE_MSGS);
  });

  test('влитая живая история: объединённая база = 114 (архив + live), живой ярус доказан', () => {
    const api = makeMain(env(turnsUnion(), archiveTier()));
    const msgs = api.msgs();
    expect(msgs.length).toBe(UNION); // 114 — а не 20 архивных
    const info = api.info();
    expect(info.baseMsgs).toBe(UNION);
    expect(info.liveCount).toBe(LIVE_ONLY);
    expect(info.archiveCount).toBe(ARCHIVE_MSGS);
    expect(info.liveProven).toBe(true); // стык по контенту (20 ходов) + рост сверх архива
    // обе части базы входят в объединённый список
    const texts = msgs.map((m) => m.text);
    expect(texts).toEqual(expect.arrayContaining(ARCH.map((m) => m.text)));
    expect(texts).toEqual(expect.arrayContaining(['живой ход 1', 'живой ход ' + (LIVE_ONLY - 1)]));
    // 114 ходов; один контент повторён стыком (архивный ход + живой ход того же текста) —
    // в реальном EMIT такой дубль снимает sanitizeFinalMessages
    expect(new Set(texts).size).toBeGreaterThanOrEqual(UNION - 1);
    // роли нормализованы (никаких undefined в файл)
    msgs.forEach((m) => expect(['user', 'assistant']).toContain(m.role));
  });

  test('порядок строит та же чистая orderExportMessages (дубля логики нет)', () => {
    const body = fnDecl(CORE_GEMINI, 'aiCmBuildBaseMessages');
    expect(body).toContain('orderExportMessages');
    expect(body).toContain('sanitizeMessagesForEmit');
    // результат совпадает с порядком самой утилиты на тех же данных
    const items = Object.keys(turnsUnion()).map((id) => ({
      id: id, turnId: turnsUnion()[id].turnId || null, r1: turnsUnion()[id].r1 || null,
      order: turnsUnion()[id].order || 0, role: turnsUnion()[id].role,
      archive: turnsUnion()[id].archiveAdded === true
    }));
    const expected = Logic.orderExportMessages(items).ids;
    const api = makeMain(env(turnsUnion(), archiveTier()));
    expect(api.msgs().map((m) => m.id)).toEqual(expected.filter((id) => turnsUnion()[id]));
  });

  test('архива нет → liveCount = вся база (прежнее поведение)', () => {
    const map = turnsUnion();
    const api = makeMain(env(map, null));
    const info = api.info();
    expect(info.archiveCount).toBe(0);
    expect(info.liveCount).toBe(Object.keys(map).length);
    expect(info.liveProven).toBe(true);
  });
});

// =====================================================================================
// Г) конец-в-конец: РЕАЛЬНЫЙ doAutoExportDownload (ISOLATED) с мостом объединённой базы
// =====================================================================================
describe('T1-fix#3: doAutoExportDownload — файл из объединённой базы (реальный код)', () => {
  const CONTENT_SCOPE = 'with (ctx) { ' +
    fnDecl(CORE_CONTENT, 'aiCmExportBaseSource') + '\n' +
    fnDecl(CORE_CONTENT, 'doAutoExportDownload') + '\n' +
    ' return { src: aiCmExportBaseSource, dl: doAutoExportDownload }; }';
  const makeContent = new Function('ctx', CONTENT_SCOPE);

  const ARCH_TEXTS = archiveMessages();
  const UNION_MSGS = unionMessages();

  function ctxFor(site, snap, localMsgs) {
    const downloads = [];
    const logs = [];
    const ctx = {
      currentAdapter: { siteName: site },
      autoExportSettings: { fmt: 'txt', enabled: true },
      aiCmLowConfidenceByConv: {},
      baseSeen: true,
      baseComplete: true,
      lastBaseTexts: localMsgs.map((m) => m.text),
      lastResolvedModelId: 'gemini-2.0-flash',
      maxTokenCount: 1000,
      sessionFiredCache: {},
      autoExportFired: {},
      aiCmCursorLiveByConv: {},
      aiCmDumpTurnsSnapshot: function () { },
      aiCmCancelDeferredHistWrite: function () { },
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      console: { error: function () { } },
      ModelConfig: { getModel: function () { return { name: 'Gemini 2.0 Flash' }; } },
      chrome: { storage: { session: { set: function () { }, remove: function () { } } } },
      buildHistoryMessages: function () { return localMsgs.slice(); },
      aiCmGeminiTurnsSnapshotSync: function () { return snap; },
      window: {
        AiCmExportBuilders: {
          buildTxtFromHistory: function (hist) { return hist.messages.map((m) => m.role + '::' + m.text).join('\n'); },
          buildMdFromHistory: function (hist) { return hist.messages.map((m) => m.text).join('\n'); },
          downloadBlob: function (content, file) { downloads.push({ content: content, file: file }); }
        },
        AiCmExportEmitPipeline: Pipeline
      }
    };
    return { ctx: ctx, downloads: downloads, logs: logs, api: makeContent(ctx) };
  }
  const unionSnap = {
    convId: 'c1', archiveCount: ARCHIVE_MSGS, liveCount: LIVE_ONLY,
    baseMsgs: UNION, messages: UNION_MSGS
  };

  test('живой прогон: локальный снимок = архив (20), база = 114 → в файле 114', () => {
    const h = ctxFor('gemini', unionSnap, ARCH_TEXTS);
    h.api.dl('c1', 95, 'threshold');
    expect(h.downloads.length).toBe(1);
    const lines = h.downloads[0].content.replace(/^\uFEFF/, '').split('\n');
    expect(lines.length).toBe(UNION); // 114, а не 20 архивных
    expect(lines.some((l) => l.indexOf('живой ход 93') !== -1)).toBe(true);
    expect(lines.some((l) => l.indexOf('тренировочный вопрос 0') !== -1)).toBe(true);
    expect(h.logs.join('\n')).toContain('source=base-union');
    // экспорт состоялся → латч поставлен (позднего дубля не будет)
    expect(Pipeline.getAutoExportFired(h.ctx.autoExportFired, 'gemini', 'c1')).toBe(true);
  });

  test('база «только архив»: триггер base-complete (v64) файла НЕ даёт и латч НЕ ставит', () => {
    const snap = {
      convId: 'c1', archiveCount: ARCHIVE_MSGS, liveCount: 0,
      baseMsgs: ARCHIVE_MSGS, messages: ARCH_TEXTS.map((m, i) => ({ id: 'a:' + i, role: m.role, text: m.text }))
    };
    const h = ctxFor('gemini', snap, ARCH_TEXTS);
    h.api.dl('c1', 95, 'base-complete');
    expect(h.downloads.length).toBe(0);
    expect(Pipeline.getAutoExportFired(h.ctx.autoExportFired, 'gemini', 'c1')).toBe(false);
    const joined = h.logs.join('\n');
    expect(joined).toContain('reason=archive-pending-live');
    expect(joined).toContain('source=archive-only-base');
    expect(joined).toContain('liveMsgs=0');
  });

  test('pre-trim (v54) и поздний re-check идут через тот же гейт', () => {
    const snap = {
      convId: 'c1', archiveCount: ARCHIVE_MSGS, liveCount: 0,
      baseMsgs: ARCHIVE_MSGS, messages: ARCH_TEXTS.map((m, i) => ({ id: 'a:' + i, role: m.role, text: m.text }))
    };
    ['pre-trim', 'threshold'].forEach((reason) => {
      const h = ctxFor('gemini', snap, ARCH_TEXTS);
      h.api.dl('c1', 95, reason);
      expect(h.downloads.length).toBe(0);
    });
  });

  test('чужой convId в мосте (SPA-переход) → мост игнорируется, путь прежний', () => {
    const h = ctxFor('gemini', Object.assign({}, unionSnap, { convId: 'other' }), ARCH_TEXTS);
    expect(h.api.src('c1', ARCH_TEXTS)).toBe(null);
    h.api.dl('c1', 95, 'threshold');
    expect(h.downloads.length).toBe(1); // локальный снимок как раньше
  });

  test('не-Gemini: archive-гейт не применяется (прежний путь 1:1)', () => {
    const h = ctxFor('chatgpt', Object.assign({}, unionSnap, { liveCount: 0 }), ARCH_TEXTS);
    expect(h.api.src('c1', ARCH_TEXTS)).toBe(null);
    h.api.dl('c1', 95, 'threshold');
    expect(h.downloads.length).toBe(1);
  });

  test('мост недоступен (MAIN не установлен) → null и прежнее поведение', () => {
    const h = ctxFor('gemini', null, ARCH_TEXTS);
    expect(h.api.src('c1', ARCH_TEXTS)).toBe(null);
    h.api.dl('c1', 95, 'threshold');
    expect(h.downloads.length).toBe(1);
  });

  test('T1-fix#4: локальный источник EMIT (архив уже в голове) → файл: архив первым, живой ход последним', () => {
    // локальный снимок = ровно то, что отдаёт EMIT: порядок чистой функции по базе с метками
    const map = turns4Map(true);
    const local = Logic.orderExportMessages(order4Items(map)).ids.map((id) => {
      const r = map[id];
      return { role: r.role, text: r.text };
    });
    expect(local.length).toBe(UNION4);
    const h = ctxFor('gemini', {
      convId: 'c1', archiveCount: ARCH4.length, liveCount: LIVE4_COUNT,
      baseMsgs: UNION4, messages: local
    }, local);
    h.api.dl('c1', 95, 'threshold');
    expect(h.downloads.length).toBe(1);
    const lines = h.downloads[0].content.replace(/^\uFEFF/, '').split('\n');
    expect(lines.length).toBe(UNION4); // 114
    // голова файла — архивные ходы (включая «Страницы памяти помечаются read-only»)
    expect(lines[0]).toContain('тренировочный вопрос 0');
    expect(lines[2]).toContain('Страницы памяти помечаются read-only');
    // хвост файла — последний ЖИВОЙ ход (именно этого не было в live-прогоне)
    expect(lines[UNION4 - 1]).toContain('живой ответ ' + (LIVE4_TURNS - 1));
    // источник файла — локальный снимок EMIT, объединённая база не понадобилась:
    // признак — отсутствие ветки source=base-union (диагностика T1-diag снята)
    expect(h.logs.join('\n')).not.toContain('source=base-union');
    expect(h.logs.join('\n')).toContain('fired convId=c1');
  });
});

// =====================================================================================
// Д) пины проводки: единственная точка записи + архив НЕ перезаписывает объединённую базу
// =====================================================================================
describe('T1-fix#3: проводка (source-level)', () => {
  test('гейт стоит в doAutoExportDownload ДО установки латча fired', () => {
    const body = fnDecl(CORE_CONTENT, 'doAutoExportDownload');
    expect(body).toContain('var baseSrc = aiCmExportBaseSource(cid, msgs);');
    expect(body).toContain('baseSrc.blocked === true');
    expect(body).toContain('source=archive-only-base');
    expect(body).toContain('msgs = baseSrc.msgs;');
    // block-ветка выходит ДО markAutoExportFired (иначе поздний честный экспорт блокировался бы)
    expect(body.indexOf('baseSrc.blocked === true')).toBeLessThan(body.indexOf('markAutoExportFired'));
  });

  test('aiCmExportBaseSource: решение — чистая функция пайплайна, мост — CustomEvent', () => {
    const body = fnDecl(CORE_CONTENT, 'aiCmExportBaseSource');
    expect(body).toContain('P.resolveExportSource(');
    expect(body).toContain('aiCmGeminiTurnsSnapshotSync()');
    expect(body).toContain("site !== 'gemini'");
    expect(body).not.toContain('chrome.'); // мировая изоляция: только мост
  });

  test('MAIN отдаёт объединённую базу в существующем синхронном мосте', () => {
    expect(CORE_GEMINI).toContain('function aiCmBuildBaseMessages(');
    expect(CORE_GEMINI).toContain('function aiCmBaseExportInfo(');
    expect(CORE_GEMINI).toContain('var baseInfo = (typeof aiCmBaseExportInfo === \'function\') ? aiCmBaseExportInfo() : null;');
    expect(CORE_GEMINI).toContain('messages: (baseInfo && Array.isArray(baseInfo.messages)) ? baseInfo.messages : []');
    expect(CORE_GEMINI).toContain('liveCount: baseInfo ? baseInfo.liveCount : null');
    expect(CORE_GEMINI).toContain('archiveCount: baseInfo ? baseInfo.archiveCount : 0');
    // MAIN по-прежнему без chrome.*
    expect(fnDecl(CORE_GEMINI, 'aiCmBaseExportInfo')).not.toContain('chrome.');
    expect(fnDecl(CORE_GEMINI, 'aiCmBuildBaseMessages')).not.toContain('chrome.');
  });

  test('чистая функция живёт в пайплайне, экспортирована и opt-in', () => {
    expect(typeof Pipeline.resolveExportSource).toBe('function');
    expect(PIPELINE_SRC).toContain('resolveExportSource: resolveExportSource,');
    expect(PIPELINE_SRC).toContain("reason: 'archive-only-base'");
    expect(PIPELINE_SRC).toContain("reason: 'stale-local-source'");
  });

  test('buildArchiveStoragePatch пишет ТОЛЬКО два ключа T1 (объединённую базу не трогает)', () => {
    const scope = 'with (ctx) { ' + fnDecl(OPTIONS_SRC, 'aiCmArchiveApi') + '\n' +
      fnDecl(OPTIONS_SRC, 'buildArchiveStoragePatch') +
      ' return buildArchiveStoragePatch; }';
    const build = new Function('ctx', scope)({ window: { AiCmArchiveImport: Archive } });
    const rec = Archive.buildArchiveRecord({
      convId: 'c1', service: 'gemini', format: Archive.FORMATS.GEMINI_TAKEOUT,
      messages: archiveMessages().map((m, i) => ({ role: m.role, text: m.text, id: 'a:' + i }))
    }, { fileName: 'MyActivity.json' });
    const patch = build([rec], 'MyActivity.json');
    expect(Object.keys(patch).sort()).toEqual(['aiCmArchive:c1', 'aiCmConvSource:c1']);
    // объединённая база (aiCmHistory / лента Gemini) архивом НЕ перезаписывается
    Object.keys(patch).forEach((k) => {
      expect(k.indexOf('aiCmHistory')).toBe(-1);
      expect(k.indexOf('ai-cm-gemini-tape-')).toBe(-1);
    });
    expect(patch['aiCmArchive:c1'].count).toBe(ARCHIVE_MSGS);
  });

  test('импорт пишет только report.patch (никаких других ключей хранилища)', () => {
    expect(OPTIONS_SRC).toContain('chrome.storage.local.set(report.patch, function () {');
    const body = fnDecl(OPTIONS_SRC, 'aiCmImportArchiveFiles');
    expect(body).toContain('Object.assign(report.patch, buildArchiveStoragePatch(plan.accepted, file.name));');
    expect(body).not.toContain('aiCmHistory');
    expect(body).not.toContain('gemini-tape');
  });

  test('HWM-пол, H9/H10-гейты и resetForNewConversation не тронуты', () => {
    // saveFloor — тонкая обёртка, архива не знает (HWM: пол монотонно ВВЕРХ)
    expect(fnDecl(CORE_GEMINI, 'saveFloor').toLowerCase()).not.toContain('archive');
    expect(Logic.archiveFloorRecord({ count: UNION, effectiveLen: 9000 }, ARCHIVE_MSGS, 100)).toBeNull();
    expect(Logic.archiveFloorRecord(null, ARCHIVE_MSGS, 100))
      .toEqual({ count: ARCHIVE_MSGS, effectiveLen: 100, source: 'archive' });
    ['probeTerminalGate', 'untrustedTopVerdict', 'pagStepBroken', 'collapseGuardVerdict'].forEach((name) => {
      expect(fnDecl(fs.readFileSync(path.join(ROOT, 'utils', 'gemini-intercept-logic.js'), 'utf8'), name).toLowerCase())
        .not.toContain('archive');
    });
    // оракул архива по-прежнему гейтится снимком live (T1-fix#1/#2 не ослаблены)
    const tier = fnDecl(CORE_GEMINI, 'aiCmArchiveTierApply');
    expect(tier).toContain('live: live');
    expect(tier).toContain('loaderDone: loaderDone && !archiveOnly');
    // новый код не трогает сброс состояния чата
    expect(fnDecl(CORE_CONTENT, 'resetConversationState')).not.toContain('baseSrc');
  });
});

// =====================================================================================
// Е) T1-fix#4 (v1.16.4): ПОРЯДОК — архив В ГОЛОВЕ файла, живое окно В ХВОСТЕ
// =====================================================================================
// БАГ live-прогона после fix#3: база 114 (архив 4 + live 110), источник local/in-sync,
// а последние строки файла — АРХИВНЫЕ («Страницы памяти помечаются read-only»).
// ПРИЧИНА: ходы, влитые архивом, получали order = maxOrder+1+i (САМЫЙ БОЛЬШОЙ в базе) и
// r1=null → в chain-r1 они попадали в M_rest, то есть В КОНЕЦ. Признака «это архив» в
// порядке не было вовсе, поэтому объединённая база (и local-снимок EMIT, и base-union)
// отдавала архив в хвосте.
// ФИКС: метка archiveAdded на записи turnsMap (её ставит ТОЛЬКО вливание архива T1) →
// чистая orderExportMessages выносит такие ходы в ГОЛОВУ (свой внутренний порядок
// сохраняется). order НЕ менялся: он питает aiCmOrderedTurns → dbFirstHash H9-гейта
// полноты, и его сдвиг тронул бы гейт.
// НЕ ТРОГАЕТСЯ: saveFloor/archiveFloorRecord (HWM), H9/H10-гейты, resetForNewConversation.
describe('T1-fix#4: порядок объединённой базы (архив первым, live последним)', () => {
  const MAIN4_SCOPE = 'with (ctx) { ' + fnDecl(CORE_GEMINI, 'aiCmBuildBaseMessages') +
    ' return aiCmBuildBaseMessages; }';
  const makeMain4 = new Function('ctx', MAIN4_SCOPE); // ctx → сама функция из core
  const LOGIC_SRC4 = fs.readFileSync(path.join(ROOT, 'utils', 'gemini-intercept-logic.js'), 'utf8');

  function env4(map) {
    return {
      turnsMap: map,
      baseSize: () => Object.keys(map).length,
      sanitizeMessagesForEmit: (m) => m,
      window: { GeminiInterceptLogic: Logic }
    };
  }

  test('4 архивных (archiveAdded) + 110 живых → порядок [a1,a2,a3,a4, live...], а не наоборот', () => {
    const ids = Logic.orderExportMessages(order4Items(turns4Map(true))).ids;
    expect(ids.length).toBe(UNION4); // 114
    expect(ids.slice(0, 4)).toEqual(['a1', 'a2', 'a3', 'a4']); // архив — ГОЛОВА
    expect(ids[ids.length - 1]).toBe('live_' + (LIVE4_TURNS - 1) + '_assistant'); // live — ХВОСТ
    // ни одного архивного id в хвосте
    expect(ids.slice(4).filter((id) => id.charAt(0) === 'a')).toEqual([]);
  });

  test('без метки archiveAdded порядок прежний (архив в хвосте) — этот баг и закрыт', () => {
    const ids = Logic.orderExportMessages(order4Items(turns4Map(false))).ids;
    expect(ids.length).toBe(UNION4);
    expect(ids.slice(-4)).toEqual(['a1', 'a2', 'a3', 'a4']); // ровно live-баг: архив в конце
  });

  test('чаты без архива: ни одной метки → результат прежний (архивный фикс не вмешивается)', () => {
    const map = turns4Map(false);
    delete map.a1; delete map.a2; delete map.a3; delete map.a4;
    const ids = Logic.orderExportMessages(order4Items(map)).ids;
    expect(ids.length).toBe(LIVE4_COUNT);
    expect(ids[0]).toBe('live_0_user');
    expect(ids[ids.length - 1]).toBe('live_' + (LIVE4_TURNS - 1) + '_assistant');
  });

  test('РЕАЛЬНЫЙ aiCmBuildBaseMessages (core): голова = архив, хвост = последний живой ход', () => {
    const msgs = makeMain4(env4(turns4Map(true)))(); // makeMain4(ctx) → сама функция из core
    expect(msgs.length).toBe(UNION4);
    expect(msgs.slice(0, 4).map((m) => m.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(msgs.slice(0, 4).map((m) => m.text)).toEqual(ARCH4.map((m) => m.text));
    expect(msgs[UNION4 - 1].text).toBe('живой ответ ' + (LIVE4_TURNS - 1));
    // архивный ход «Страницы памяти помечаются read-only» — в голове, не в конце
    expect(msgs.slice(0, 4).some((m) => m.text.indexOf('read-only') !== -1)).toBe(true);
  });

  test('проводка: метку ставит вливание архива, и она доезжает до обоих вызовов порядка', () => {
    expect(CORE_GEMINI).toContain('archiveAdded: true');
    // порядок получает метку и в EMIT (emitBaseSnapshot), и в объединённой базе экспорта
    expect(CORE_GEMINI).toContain('archive: rec.archiveAdded === true');
    expect(CORE_GEMINI).toContain('archive: ot.archiveAdded === true');
    // метка ставится ТОЛЬКО в обработчике вливания архива (один раз на файл)
    expect(CORE_GEMINI.split('archiveAdded: true').length - 1).toBe(1);
    // чистая функция: архив отделяется и уходит в начало, прежний порядок — без изменений
    const body = fnDecl(LOGIC_SRC4, 'orderExportMessages');
    expect(body).toContain('qi.archive === true');
    expect(body).toContain('orderExportMessagesBase(restItems)');
    const base = fnDecl(LOGIC_SRC4, 'orderExportMessagesBase');
    expect(base).toContain("mode: 'chain-r1'");
    expect(base).toContain("mode: 'arrival'");
    expect(base).not.toContain('archive === true');
  });
});
