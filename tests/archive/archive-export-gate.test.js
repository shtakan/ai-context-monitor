/**
 * T1-fix#2 (v1.16.2): автоэкспорт НЕ стреляет на архивных ходах, пока живая история
 * не влилась в базу.
 *
 * БАГ live-прогона (после T1-fix #1, v1.16.1): полнота взводилась В ОБХОД archiveCompleteVerdict
 * двумя путями, где доказательством служил вклад самого архива:
 *   (а) stableFloorConfirm (v82): архив поднял пол своим count (floor=4) и его же ходы этот
 *       пол закрыли (base=4) → через 5.5с тишины historyFullByQuiet=true → baseComplete=true
 *       → автоэкспорт уходил с одной архивной частью (живой хвост не успевал догрузиться);
 *   (б) loader-«скип» no-older-history: решение «нет старшей истории» выводилось из НЕПУСТОЙ
 *       базы, а база была непуста ТОЛЬКО архивом (живой RPC ещё не распарсен) → латч
 *       loaderDoneMap=true ставился БЕЗ прогона лоадера → гейт live-loader-pending обходился.
 *
 * ФИКС: (1) база «только архив» (живых ходов 0) не является доказательством живого яруса —
 * пол-подтверждения (floor-confirm / clean-end) требуют подтверждённого роста сверх архива;
 * (2) латч loaderDoneMap при базе из одного архива доказательством не считается;
 * (3) лоадер не пропускает догрузку из-за архива (ждёт живой сигнал по живым ходам);
 * (4) автоэкспорт получает независимый гейт archive-pending-live (baseCount <= archiveMsgs).
 *
 * НЕ ТРОГАЕТСЯ: saveFloor/archiveFloorRecord (HWM), H9/H10-гейты, resetForNewConversation.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const Logic = require('../../utils/gemini-intercept-logic.js');
const Pipeline = require('../../utils/export-emit-pipeline.js');
const CORE_GEMINI = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');
const CORE_CONTENT = require('../helpers/content-source.js').contentSource;
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');

// fnSource останавливается на '\n  function ' и потому затягивает комментарии следующей
// функции; здесь нужен ровно текст объявления — режем по балансу фигурных скобок.
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

const ARCHIVE_MSGS = 4;   // архивных ходов
const LIVE_FULL = 114;    // реальная история чата (msgs=114 из live-прогона)

// ——— источник: чистый гейт автоэкспорта (то, что вызывает maybeAutoExport) ———
function state(baseCount, over) {
  return Object.assign({
    enabled: true,
    percentage: 95,
    threshold: 90,
    baseComplete: true,   // ВАЖНО: полнота уже объявлена (в баге — ошибочно, вкладом архива)
    baseSeen: true,
    loaderRunning: false,
    fired: false,
    isGemini: true,
    archiveCount: ARCHIVE_MSGS,
    baseCount: baseCount
  }, over || {});
}
function skip(st) { return Pipeline.shouldSkipAutoExport(st); }

// ——— источник: вердикт первого яруса (MAIN) ———
function live(o) {
  return Object.assign({
    loaderRunning: false, loaderDone: false, active: false, grewBeyondArchive: false
  }, o || {});
}
function verdict(baseCount, lv) {
  return Logic.archiveCompleteVerdict({
    archiveConvId: 'c1', currentConvId: 'c1',
    archiveCount: ARCHIVE_MSGS, baseCount: baseCount, floorCount: ARCHIVE_MSGS, live: lv
  });
}

// =====================================================================================
// А) гейт экспорта: база из одного архива права на автоэкспорт не даёт
// =====================================================================================
describe('T1-fix#2: архивный гейт автоэкспорта (archive-pending-live)', () => {
  test('baseCount === archiveMsgs при baseComplete=true → skip (латч fired НЕ ставится)', () => {
    expect(skip(state(ARCHIVE_MSGS)))
      .toEqual({ skip: true, reason: 'archive-pending-live', resetFired: false });
  });

  test('латч fired при этом гейте не сбрасывается (resetFired=false)', () => {
    // resetFired=false — важно: путь archive-* НЕ трогает латч, поэтому поздний честный
    // экспорт после догрузки живой истории остаётся возможным.
    expect(skip(state(ARCHIVE_MSGS)).resetFired).toBe(false);
    // порядок гейтов: архивный (сразу после not-complete) раньше already-fired
    expect(skip(state(ARCHIVE_MSGS, { fired: true })).resetFired).toBe(false);
    expect(skip(state(LIVE_FULL, { fired: true })).reason).toBe('already-fired');
  });

  test('база меньше архива (частичный merge) → тот же гейт', () => {
    for (let base = 0; base <= ARCHIVE_MSGS; base++) {
      expect(skip(state(base)).reason).toBe('archive-pending-live');
    }
  });

  test('живая история добавилась (baseCount > archiveMsgs) → гейт снят', () => {
    expect(skip(state(ARCHIVE_MSGS + 1)).skip).toBe(false);
    expect(skip(state(LIVE_FULL))).toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('неполная база остаётся not-complete (архивный гейт не подменяет прежний)', () => {
    expect(skip(state(ARCHIVE_MSGS, { baseComplete: false })).reason).toBe('not-complete');
  });

  test('бегущий лоадер: архивный гейт проверяется раньше loader-running', () => {
    expect(skip(state(ARCHIVE_MSGS, { loaderRunning: true })).reason).toBe('archive-pending-live');
    expect(skip(state(LIVE_FULL, { loaderRunning: true })).reason).toBe('loader-running');
  });

  test('обратная совместимость: без archiveCount/baseCount поведение прежнее (1:1)', () => {
    const legacy = { enabled: true, percentage: 95, threshold: 90, baseComplete: true, baseSeen: true, loaderRunning: false, fired: false, isGemini: true };
    expect(skip(legacy)).toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('не-Gemini: архивный гейт не применяется (архив там пока только индикатор)', () => {
    const v = skip(state(ARCHIVE_MSGS, { isGemini: false }));
    expect(v.reason).not.toBe('archive-pending-live');
  });
});

// =====================================================================================
// Б) эмуляция live-прогона: архив 4, живая история догружается до 114
// =====================================================================================
describe('T1-fix#2: эмуляция 4 → 114 (не стрелять на архивной части)', () => {
  test('пока лоадер догружает живую историю — автоэкспорт withheld на каждом шаге', () => {
    const reasons = [];
    for (let liveN = 0; liveN < LIVE_FULL - ARCHIVE_MSGS; liveN += 5) {
      const baseCount = ARCHIVE_MSGS + liveN;
      const v = verdict(baseCount, live({ loaderRunning: true }));
      expect(v.complete).toBe(false);
      const gate = skip(state(baseCount, { baseComplete: v.complete, loaderRunning: true }));
      expect(gate.skip).toBe(true); // гейт экспорта НЕ пропускает ни одного шага
      reasons.push(v.reason);
    }
    expect(reasons.length).toBeGreaterThan(15);
    expect(new Set(reasons)).toEqual(new Set(['loader-running']));
  });

  test('ЛОЖНАЯ полнота на 4 (floor-confirm вкладом архива) всё равно НЕ даёт экспорт', () => {
    // ровно состояние бага: baseComplete=true, в базе только 4 архивных хода
    const v = skip(state(ARCHIVE_MSGS, { baseComplete: true }));
    expect(v).toEqual({ skip: true, reason: 'archive-pending-live', resetFired: false });
    // ...и то же самое при любой базе, не вышедшей за архив
    expect(skip(state(2, { baseComplete: true })).reason).toBe('archive-pending-live');
  });

  test('экспорт возможен только на догруженной живой истории (114)', () => {
    const vFull = verdict(LIVE_FULL, live({ loaderDone: true }));
    expect(vFull).toEqual({ complete: true, reason: 'archive-complete' });
    expect(skip(state(LIVE_FULL, { baseComplete: vFull.complete }))).toEqual({ skip: false, reason: null, resetFired: false });
    // база момента ложной полноты (4) НЕ равна базе честной (114)
    expect(ARCHIVE_MSGS).not.toBe(LIVE_FULL);
  });
});

// =====================================================================================
// В) пины проводки: MAIN-гейты + ISOLATED-гейт
// =====================================================================================
describe('T1-fix#2: проводка гейтов (source-level)', () => {
  test('floor-confirm больше не подтверждает полноту вкладом архива', () => {
    const body = fnDecl(CORE_GEMINI, 'stableFloorConfirm');
    expect(body).toContain('aiCmArchiveLiveProven(convIdFc)');
    expect(body).toContain('reason=archive-live-pending(floor-confirm)');
    // гейт стоит ДО взвода historyFullByQuiet
    expect(body.indexOf('aiCmArchiveLiveProven(convIdFc)')).toBeLessThan(body.indexOf('historyFullByQuiet = true;'));
  });

  test('clean-end подтверждение под архивным гейтом, ветка done=top — НЕТ', () => {
    const body = fnDecl(CORE_GEMINI, 'notifyLoaderState');
    expect(body).toContain('reason=archive-live-pending(clean-end)');
    expect(body).toContain('aiCmArchiveLiveProven(convId)');
    // гейт только внутри ветки «не top» (реальный live-доказательство top не ослаблено)
    expect(body.indexOf("lastLoaderDoneReason !== 'top'")).toBeLessThan(body.indexOf('aiCmArchiveLiveProven(convId)'));
    expect(body.indexOf('aiCmArchiveLiveProven(convId)')).toBeLessThan(body.indexOf('historyFullByQuiet = true;'));
  });

  test('оракул архива: база из одного архива не даёт loaderDone-доказательства', () => {
    const body = fnDecl(CORE_GEMINI, 'aiCmArchiveTierApply');
    expect(body).toContain('var archiveOnly = aiCmArchiveOnlyBase(convId);');
    expect(body).toContain('loaderDone: loaderDone && !archiveOnly');
    expect(body).toContain('archiveOnly=');
    expect(body).toContain('live: live');
  });

  test('лоадер не пропускает догрузку из-за архива (живой сигнал по живым ходам)', () => {
    const body = fnDecl(CORE_GEMINI, 'maybeStartLoader');
    expect(body).toContain('var liveMsgs = aiCmLiveTurnCount();');
    expect(body).toContain('if (!olderHistorySeen && liveMsgs === 0) {');
    const branch = body.indexOf('if (aiCmArchiveFor(convId) && liveMsgs === 0) {');
    expect(branch).toBeGreaterThan(-1);
    const deferred = body.slice(branch, body.indexOf('} else {', branch));
    expect(deferred).toContain('no-older-history отложен: база = только архив');
    // в отложенной ветке латч done НЕ ставится (иначе он снова стал бы «доказательством»)
    expect(deferred).not.toContain('loaderDoneMap[convId] = true;');
    // ...а прежняя (безархивная) ветка сохраняет прежний скип с латчем
    const elseBranch = body.slice(body.indexOf('} else {', branch), body.indexOf('loader-skipped reason=no-older-history'));
    expect(elseBranch).toContain('loaderDoneMap[convId] = true;');
  });

  test('помощники живого яруса объявлены в MAIN', () => {
    ['aiCmLiveTurnCount', 'aiCmArchiveOnlyBase', 'aiCmArchiveLiveProven'].forEach((n) => {
      expect(CORE_GEMINI).toContain('function ' + n + '(');
    });
  });

  test('ISOLATED: maybeAutoExport передаёт count архива и базу в гейт', () => {
    expect(CORE_CONTENT).toContain('var aiCmArchiveCountByConv = {};');
    expect(CORE_CONTENT).toContain('function aiCmArchiveCountFor(convId)');
    expect(CORE_CONTENT).toContain('archiveCount: aiCmArchiveCountFor(cid)');
    expect(CORE_CONTENT).toContain('baseCount: baseCount');
    expect(CORE_CONTENT).toContain('reason=archive-pending-live');
    // инлайн-фолбэк (утилита не загружена) — тот же гейт
    const fb = CORE_CONTENT.indexOf('var archMsgsFb = aiCmArchiveCountFor(cid);');
    expect(fb).toBeGreaterThan(-1);
    // SPA-сброс: count перечитывается на новом входе
    expect(fnDecl(CORE_CONTENT, 'resetConversationState')).toContain('aiCmArchiveCountByConv = {}');
  });

  test('чистый гейт живёт в пайплайне и opt-in (обратная совместимость)', () => {
    expect(PIPELINE_SRC).toContain("reason: 'archive-pending-live'");
    expect(PIPELINE_SRC).toContain('s.isGemini === true && typeof s.archiveCount === \'number\' && s.archiveCount > 0');
  });

  test('H9/H10-гейты и HWM-пол архива не тронуты', () => {
    ['probeTerminalGate', 'untrustedTopVerdict', 'pagStepBroken', 'collapseGuardVerdict'].forEach((name) => {
      expect(fnDecl(fs.readFileSync(path.join(ROOT, 'utils', 'gemini-intercept-logic.js'), 'utf8'), name).toLowerCase())
        .not.toContain('archive');
    });
    // HWM: архив поднимает пол и никогда не опускает (поведение archiveFloorRecord 1:1)
    expect(Logic.archiveFloorRecord({ count: LIVE_FULL, effectiveLen: 9000 }, ARCHIVE_MSGS, 100)).toBeNull();
    expect(Logic.archiveFloorRecord(null, ARCHIVE_MSGS, 100))
      .toEqual({ count: ARCHIVE_MSGS, effectiveLen: 100, source: 'archive' });
  });
});

// =====================================================================================
// Г) поведение помощников живого яруса (тела из реального MAIN-модуля)
// =====================================================================================
describe('T1-fix#2: живой ярус — поведение (извлечённые тела из core)', () => {
  const scope = 'with (ctx) { ' +
    ['aiCmLiveTurnCount', 'aiCmArchiveOnlyBase', 'aiCmArchiveLiveProven', 'aiCmArchiveGrewBeyondArchive']
      .map((n) => fnDecl(CORE_GEMINI, n)).join('\n') +
    ' return { live: aiCmLiveTurnCount, only: aiCmArchiveOnlyBase, proven: aiCmArchiveLiveProven,' +
    ' grew: aiCmArchiveGrewBeyondArchive }; }';
  const make = new Function('ctx', scope);

  const ARCH_MSGS_LIST = [
    { role: 'user', text: 'Объясни разницу между процессом и потоком в Linux' },
    { role: 'assistant', text: 'Процесс — это программа в исполнении…' },
    { role: 'user', text: 'А что такое поток?' },
    { role: 'assistant', text: 'Поток — единица планирования внутри процесса…' }
  ];
  function archiveMeta() {
    const keys = {};
    const addedIds = {};
    ARCH_MSGS_LIST.forEach((m, i) => {
      keys[Logic.archiveContentKey(m)] = true;
      addedIds['a:' + i] = true;
    });
    return { count: ARCH_MSGS_LIST.length, keys: keys, addedIds: addedIds };
  }
  function archiveTurns(map) {
    ARCH_MSGS_LIST.forEach((m, i) => { map['a:' + i] = { role: m.role, text: m.text, pageMode: 'restored' }; });
    return map;
  }
  function env(turnsMap, arch) {
    return {
      turnsMap: turnsMap,
      baseSize: () => Object.keys(turnsMap).length,
      getConvId: () => 'c1',
      aiCmArchiveFor: () => arch,
      window: { GeminiInterceptLogic: Logic }
    };
  }
  function apiFor(turnsMap, arch) { return make(env(turnsMap, arch)); }

  test('база = только архив: живых ходов 0, live-доказательства нет', () => {
    const api = apiFor(archiveTurns({}), archiveMeta());
    expect(api.live()).toBe(0);
    expect(api.only()).toBe(true);
    expect(api.proven()).toBe(false);
  });

  test('пассивное живое окно без стыка с архивом: ходы есть, доказательства нет', () => {
    const map = archiveTurns({});
    for (let i = 0; i < 20; i++) map['net' + i] = { role: i % 2 ? 'assistant' : 'user', text: 'живой ' + i };
    const api = apiFor(map, archiveMeta());
    expect(api.live()).toBe(20);
    expect(api.only()).toBe(false);
    expect(api.proven()).toBe(false); // нет стыка → возможен пропуск середины
  });

  test('живое окно стыкуется с архивом и больше него → доказательство есть', () => {
    const map = archiveTurns({});
    map['net0'] = { role: 'user', text: ARCH_MSGS_LIST[0].text }; // стык по контенту
    for (let i = 1; i <= LIVE_FULL; i++) map['net' + i] = { role: i % 2 ? 'assistant' : 'user', text: 'ж' + i };
    const api = apiFor(map, archiveMeta());
    expect(api.live()).toBe(LIVE_FULL + 1);
    expect(api.only()).toBe(false);
    expect(api.proven()).toBe(true);
  });

  test('архива нет → прежние гейты (live-доказательство не требуется)', () => {
    const map = {};
    for (let i = 0; i < 5; i++) map['net' + i] = { role: i % 2 ? 'assistant' : 'user', text: 'ж' + i };
    const api = apiFor(map, null);
    expect(api.only()).toBe(false);
    expect(api.proven()).toBe(true);
    expect(api.live()).toBe(5); // без addedIds вся база считается живой
  });

  test('merge архива ещё не было (нет addedIds) → база считается живой (без ложного withheld)', () => {
    const map = archiveTurns({});
    const api = apiFor(map, { count: ARCHIVE_MSGS }); // keys/addedIds отсутствуют
    expect(api.only()).toBe(false);
    expect(api.live()).toBe(ARCHIVE_MSGS);
  });
});
