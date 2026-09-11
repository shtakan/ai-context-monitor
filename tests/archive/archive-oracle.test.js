/**
 * T1-fix (v1.16.1): оракул archive-complete ЖДЁТ живой ярус.
 *
 * БАГ live-прогона: архивные ходы вливаются в ТУ ЖЕ базу (same-conv-union), поэтому
 * baseCount включает вклад самого архива. Импорт архива с 4 ходами в чат, где на сервере
 * 80 сообщений, давал baseCount === archiveCount === 4 сразу после импорта → мгновенный
 * archive-complete → автоэкспорт уходил с одной архивной частью (живой хвост не успевал
 * догрузиться).
 *
 * ГЕЙТ: полнота архива объявляется только при доказательствах живого яруса —
 *   (1) живой лоадер не бежит (loaderRunning=false);
 *   (2) прогон лоадера отработал (loaderDone) ИЛИ база подтверждённо выросла сверх
 *       архива (grewBeyondArchive: живых ходов больше архива И живое окно стыкуется
 *       с архивом — нет пропуска середины);
 *   (3) живая догрузка (тихий цикл/пагинация) завершена (active=false).
 *
 * НЕ ТРОГАЕТСЯ: saveFloor/HWM-пол, H9-гейты (untrustedTopVerdict/pagStepBroken),
 * H10 (probeTerminalGate), resetForNewConversation.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const Logic = require('../../utils/gemini-intercept-logic.js');
const CORE_GEMINI = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');
const LOGIC_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'gemini-intercept-logic.js'), 'utf8');

function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const nextFn = rest.indexOf('\n  function ', 10);
  return nextFn === -1 ? rest : rest.slice(0, nextFn);
}

const ARCHIVE_MSGS = 4;     // архив: 4 хода
const LIVE_FULL = 80;       // реальная история чата: 80 сообщений

function verdict(baseCount, live) {
  return Logic.archiveCompleteVerdict({
    archiveConvId: 'c1',
    currentConvId: 'c1',
    archiveCount: ARCHIVE_MSGS,
    baseCount: baseCount,
    floorCount: ARCHIVE_MSGS,
    live: live
  });
}

function live(o) {
  return Object.assign({
    loaderRunning: false, loaderDone: false, active: false, grewBeyondArchive: false
  }, o || {});
}

// =====================================================================================
// А) гейт живого яруса
// =====================================================================================
describe('T1-fix: archive-complete не взводится без доказательств живого яруса', () => {
  test('сразу после импорта (база = вклад архива = 4, лоадер ещё не отработал) → live-loader-pending', () => {
    // ГЛАВНЫЙ ПИН БАГА: baseCount === archiveCount — это вклад самого архива.
    expect(verdict(ARCHIVE_MSGS, live())).toEqual({ complete: false, reason: 'live-loader-pending' });
  });

  test('живой лоадер бежит прямо сейчас → loader-running (полноту за него не объявляем)', () => {
    expect(verdict(ARCHIVE_MSGS + 20, live({ loaderRunning: true })).reason).toBe('loader-running');
    expect(verdict(LIVE_FULL, live({ loaderRunning: true, loaderDone: true, grewBeyondArchive: true })).reason)
      .toBe('loader-running'); // loader-running приоритетнее любых других доказательств
  });

  test('лоадер отработал (loaderDoneMap=true) → complete на полной живой базе', () => {
    expect(verdict(LIVE_FULL, live({ loaderDone: true })))
      .toEqual({ complete: true, reason: 'archive-complete' });
  });

  test('подтверждённый рост базы сверх архива (стык с архивом) → complete без loaderDone', () => {
    expect(verdict(LIVE_FULL, live({ grewBeyondArchive: true })))
      .toEqual({ complete: true, reason: 'archive-complete' });
  });

  test('рост БЕЗ стыка с архивом (пассивное окно 20 ходов) → по-прежнему withheld', () => {
    // база = 4 архивных + 20 живых, общего хода нет → между архивом и живым окном пропуск
    expect(verdict(ARCHIVE_MSGS + 20, live()))
      .toEqual({ complete: false, reason: 'live-loader-pending' });
  });

  test('живая догрузка ещё идёт (тихий цикл) → withheld даже при loaderDone', () => {
    expect(verdict(LIVE_FULL, live({ loaderDone: true, active: true })).reason).toBe('live-loading');
  });

  test('база не доросла до архива → below-archive-count (прежний гейт сохранён)', () => {
    expect(verdict(3, live({ loaderDone: true })).reason).toBe('below-archive-count');
  });

  test('H10: база ниже пола → below-floor (даже при полном живом доказательстве)', () => {
    expect(Logic.archiveCompleteVerdict({
      archiveConvId: 'c1', currentConvId: 'c1',
      archiveCount: ARCHIVE_MSGS, baseCount: LIVE_FULL, floorCount: 100,
      live: live({ loaderDone: true })
    })).toEqual({ complete: false, reason: 'below-floor' });
  });

  test('прежние гейты (convId/пустой архив) не тронуты', () => {
    expect(verdict(ARCHIVE_MSGS, live({ loaderDone: true }))).toEqual({ complete: true, reason: 'archive-complete' });
    expect(Logic.archiveCompleteVerdict({
      archiveConvId: 'other', currentConvId: 'c1', archiveCount: ARCHIVE_MSGS, baseCount: LIVE_FULL, live: live({ loaderDone: true })
    }).reason).toBe('conv-mismatch');
    expect(Logic.archiveCompleteVerdict({
      archiveConvId: 'c1', currentConvId: 'c1', archiveCount: 0, baseCount: LIVE_FULL, live: live({ loaderDone: true })
    }).reason).toBe('archive-empty');
  });

  test('снимок live не передан → прежнее (T1) поведение вызова сохраняется', () => {
    // совместимость вызовов/существующих тестов T1, которые снимок живого яруса не передают
    expect(Logic.archiveCompleteVerdict({
      archiveConvId: 'c1', currentConvId: 'c1', archiveCount: ARCHIVE_MSGS, baseCount: ARCHIVE_MSGS, floorCount: 0
    })).toEqual({ complete: true, reason: 'archive-complete' });
  });
});

// =====================================================================================
// Б) эмуляция живого лоадера: архив 4 хода, реальная история 80
// =====================================================================================
describe('T1-fix: эмуляция подгрузки живой истории 4 → 80', () => {
  test('ни один шаг догрузки до завершения прогона НЕ даёт complete; complete — на 80 после стопа', () => {
    const steps = [];
    // лоадер бежит и подгружает живые ходы: baseCount = 4 архивных + liveN живых
    for (let liveN = 0; liveN < LIVE_FULL; liveN += 5) {
      const v = verdict(ARCHIVE_MSGS + liveN, live({ loaderRunning: true }));
      expect(v.complete).toBe(false);
      steps.push(v.reason);
    }
    expect(steps.length).toBeGreaterThan(10);
    expect(new Set(steps)).toEqual(new Set(['loader-running']));
    // шаг без loaderRunning (сеть отдала окно, лоадер ещё не отработал) — тоже withheld
    expect(verdict(ARCHIVE_MSGS + 20, live()).complete).toBe(false);
    // прогон завершён: живая история догружена до 80, архив влит → только здесь complete
    expect(verdict(LIVE_FULL, live({ loaderDone: true })))
      .toEqual({ complete: true, reason: 'archive-complete' });
  });

  test('база «доросла до архива» вкладом архива НЕ считается доказательством (регресс-пин бага)', () => {
    // ровно состояние бага: 4 архивных хода, живой хвост ещё не пришёл
    const premature = verdict(ARCHIVE_MSGS, live({ loaderRunning: false, loaderDone: false }));
    expect(premature.complete).toBe(false);
    expect(premature.reason).toBe('live-loader-pending');
    // ...и то же самое, когда живой хвост уже больше архива, но не стыкуется с ним
    expect(verdict(ARCHIVE_MSGS + 3, live()).complete).toBe(false);
    // автоэкспорт возможен только после догрузки живой истории
    expect(verdict(LIVE_FULL, live({ loaderDone: true })).complete).toBe(true);
    // база на момент ложной полноты (4) НЕ равна базе на момент честной (80)
    expect(ARCHIVE_MSGS).not.toBe(LIVE_FULL);
  });
});

// =====================================================================================
// В) HWM-пол сохранён (не понижается)
// =====================================================================================
describe('T1-fix: пол (HWM) не понижается', () => {
  test('архивный count поднимает пол вверх и никогда не опускает', () => {
    expect(Logic.archiveFloorRecord(null, ARCHIVE_MSGS, 100))
      .toEqual({ count: ARCHIVE_MSGS, effectiveLen: 100, source: 'archive' });
    expect(Logic.archiveFloorRecord({ count: LIVE_FULL, effectiveLen: 9000 }, ARCHIVE_MSGS, 100)).toBeNull();
    expect(Logic.archiveFloorRecord({ count: 10, effectiveLen: 500 }, LIVE_FULL, 100))
      .toEqual({ count: LIVE_FULL, effectiveLen: 500, source: 'archive' });
  });

  test('source-level: MAIN пишет пол результатом archiveFloorRecord (saveFloor не подменён)', () => {
    const listenerStart = CORE_GEMINI.indexOf("window.addEventListener('ai-cm-archive-restore'");
    expect(listenerStart).toBeGreaterThan(-1);
    const listenerEnd = CORE_GEMINI.indexOf('\n  });', listenerStart);
    expect(listenerEnd).toBeGreaterThan(listenerStart);
    const listener = CORE_GEMINI.slice(listenerStart, listenerEnd);
    expect(listener).toContain('logic.archiveFloorRecord(');
    expect(listener).toContain('saveFloor(convId, archFloor.count, archFloor.effectiveLen)');
    // HWM-гейт живого яруса не даёт себя обойти вкладом архива
    expect(listener).toContain('addedIds: archAddedIds');
    expect(listener).toContain('keys: archKeys');
  });
});

// =====================================================================================
// Г) проводка гейта в MAIN + H9/H10 не тронуты
// =====================================================================================
describe('T1-fix: проводка гейта живого яруса', () => {
  test('aiCmArchiveTierApply передаёт снимок live (loaderRunning/loaderDone/active/grew)', () => {
    const body = fnSource(CORE_GEMINI, 'aiCmArchiveTierApply');
    expect(body).toContain('live: live');
    expect(body).toContain('loaderRunning: loaderRunningFor === convId');
    expect(body).toContain('var loaderDone = loaderDoneMap[convId] === true;');
    expect(body).toContain('loaderDone: loaderDone');
    expect(body).toContain('active: quietActive === true');
    expect(body).toContain('aiCmArchiveGrewBeyondArchive(arch)');
  });

  test('рост сверх архива подтверждается ТОЛЬКО при стыке живого окна с архивом', () => {
    const body = fnSource(CORE_GEMINI, 'aiCmArchiveGrewBeyondArchive');
    expect(body).toContain('addedIds');
    expect(body).toContain('archiveContentKey');
    expect(body).toContain('overlap');
    expect(body).toContain('return liveCount > arch.count;');
    expect(body).toContain('if (!overlap) return false;');
  });

  test('оракул переоценивается и на стопе живого лоадера, и на конце тихого цикла', () => {
    const nlBody = fnSource(CORE_GEMINI, 'notifyLoaderState');
    expect(nlBody).toContain('aiCmArchiveTierApply()');
    // вызов стоит ДО dispatch ai-cm-loader-state — свежая полнота уезжает тем же событием
    expect(nlBody.indexOf('aiCmArchiveTierApply()')).toBeLessThan(nlBody.indexOf("new CustomEvent('ai-cm-loader-state'"));
    expect(fnSource(CORE_GEMINI, 'finishQuiet')).toContain('aiCmArchiveTierApply()');
    expect(fnSource(CORE_GEMINI, 'emitBaseSnapshot')).toContain('aiCmArchiveTierApply()');
  });

  test('H9/H10-гейты не знают про архив (archive-гейт их не подменяет)', () => {
    ['probeTerminalGate', 'untrustedTopVerdict', 'pagStepBroken', 'collapseGuardVerdict'].forEach((name) => {
      expect(fnSource(LOGIC_SRC, name).toLowerCase()).not.toContain('archive');
    });
    // новый гейт — часть ТОЛЬКО archiveCompleteVerdict
    expect(LOGIC_SRC).toContain('reason: \'live-loader-pending\'');
    expect(LOGIC_SRC).toContain('reason: \'live-loading\'');
    expect(LOGIC_SRC).toContain('reason: \'loader-running\'');
  });

  test('лог withheld содержит снимок живого яруса (диагностика live-прогона)', () => {
    const body = fnSource(CORE_GEMINI, 'aiCmArchiveTierApply');
    expect(body).toContain("' loaderRunning='");
    expect(body).toContain("' loaderDone='");
    expect(body).toContain("' liveActive='");
    expect(body).toContain("' grew='");
  });
});

// =====================================================================================
// Д) поведение aiCmArchiveGrewBeyondArchive (тело из реального MAIN-модуля)
// =====================================================================================
describe('T1-fix: grewBeyondArchive — поведение (извлечённое тело из core)', () => {
  const full = fnSource(CORE_GEMINI, 'aiCmArchiveGrewBeyondArchive');
  const body = full.slice(full.indexOf('{') + 1); // тело без строки декларации
  // тело исполняется в with(ctx): turnsMap/arch видны как свободные переменные исходника
  const make = new Function('ctx',
    'with (ctx) { return function aiCmArchiveGrewBeyondArchive(arch) {' + body + ' }');
  const ARCH_MSGS_LIST = [
    { role: 'user', text: 'ход 0' }, { role: 'assistant', text: 'ход 1' },
    { role: 'user', text: 'ход 2' }, { role: 'assistant', text: 'ход 3' }
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
  function archiveTurns() {
    const map = {};
    ARCH_MSGS_LIST.forEach((m, i) => { map['a:' + i] = { role: m.role, text: m.text, pageMode: 'restored' }; });
    return map;
  }
  function run(turnsMap, arch) {
    return make({ turnsMap: turnsMap, window: { GeminiInterceptLogic: Logic } })(arch);
  }

  test('живое окно не стыкуется с архивом → рост НЕ подтверждён (нет ложной полноты)', () => {
    const map = archiveTurns();
    for (let i = 0; i < 20; i++) map['net' + i] = { role: i % 2 ? 'assistant' : 'user', text: 'живой ' + i };
    expect(run(map, archiveMeta())).toBe(false);
  });

  test('живое окно стыкуется с архивом и больше него → рост подтверждён', () => {
    const map = archiveTurns();
    // живой ход с контентом архивного (стык) + 79 своих
    map['net0'] = { role: 'user', text: 'ход 0' };
    for (let i = 1; i <= 79; i++) map['net' + i] = { role: i % 2 ? 'assistant' : 'user', text: 'живой ' + i };
    expect(run(map, archiveMeta())).toBe(true);
  });

  test('стык есть, но живое окно НЕ больше архива → рост НЕ подтверждён', () => {
    const map = archiveTurns();
    map['net0'] = { role: 'user', text: 'ход 0' };
    expect(run(map, archiveMeta())).toBe(false); // 0 живых «своих» + 1 стык ≤ 4
  });

  test('merge архива ещё не было (нет keys/addedIds) → роста нет', () => {
    const map = archiveTurns();
    map['net0'] = { role: 'user', text: 'ход 0' };
    for (let i = 1; i <= 79; i++) map['net' + i] = { role: 'assistant', text: 'ж' + i };
    expect(run(map, { count: 4 })).toBe(false);
    expect(run(map, null)).toBe(false);
  });

  test('в базе только архив (живой хвост ещё не пришёл) → роста нет', () => {
    expect(run(archiveTurns(), archiveMeta())).toBe(false);
  });
});
