/**
 * T1-fix#5 (v1.16.5): ФОРМАЛИЗАЦИЯ САМОУНИЖЕНИЯ УСТАРЕВШЕГО ПОЛА (clean-end self-heal).
 *
 * БАГ-КЛАСС. Пол (floor) — снимок прошлой ПОЛНОЙ сборки. Если чат с тех пор укорочен на
 * сервере (или пол был поднят уже удалённым архивом), база остаётся ниже пола НАВСЕГДА:
 *   • оракул полноты вечно возвращает `oracle=incomplete reason=below-floor` →
 *     baseComplete/reachedStart не взводятся → автоэкспорт остаётся в deferred;
 *   • completeness-оракул запускает loader-restart по кругу (циклические перезагрузки),
 *     хотя окно вырасти не может: сервер больше страниц не отдаёт.
 * Именно этот случай лоадер сам закрыть не может: reachedStart остаётся 0 (физического
 * верха нет), но чистый конец истории доказан сетью (quietEndedClean + курсора нет).
 *
 * ФИКС. Механизм самоунижения формализован:
 *   • GeminiInterceptLogic.selfHealFloorVerdict(o) — ЕДИНСТВЕННОЕ решение о понижении
 *     (гарды: не clean-end / живой курсор / активный тихий цикл / ошибка страницы /
 *     идущий лоадер / архив без доказанного живого яруса / пустая база / нет пола /
 *     база >= пола / нет подтверждающего повтора);
 *   • GeminiInterceptLogic.writeSelfHealedFloor(...) + обёртка core `selfHealFloor(...)` —
 *     ЕДИНСТВЕННАЯ точка записи понижения;
 *   • вызов — в оракуле полноты (stableCheck74) ПЕРЕД гейтом below-floor, плюс тот же
 *     механизм используется уже доказанной clean-end веткой collapse-гарда лоадера
 *     (прямой localStorage.setItem пола там больше нет).
 *
 * НЕ ТРОГАЕТСЯ (регрессионный контур): логика saveFloor/archiveFloorRecord (HWM —
 * пол двигается только вверх), H9/H10-гейты (below-floor без доказательства чистого
 * конца остаётся в силе), resetForNewConversation, диагностика удалена (T1-diag).
 *
 * stableCheck74 извлекается из core/gemini-intercept.js и исполняется в песочнице с
 * `with` (конвенция gemini-floor-confirmed / gemini-collapse-guard) — гоняется реальный
 * код, а не копия логики.
 */
const fs = require('fs');
const path = require('path');

const GIL = require('../../utils/gemini-intercept-logic.js');

const ROOT = path.join(__dirname, '..', '..');
const CORE_GEMINI = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');
const CORE_CONTENT = require('../helpers/content-source.js').contentSource;

const PARSER_VERSION = 'g-selfheal';
const CONV_ID = 'conv-selfheal';
const FLOOR_COUNT = 108;
const FLOOR_EFFECTIVE_LEN = 216714;

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

// --- извлечение реального `var stableCheck74 = function () { … };` из оракула ---
function extractStableCheck74() {
  const marker = 'var stableCheck74 = function () {';
  const i = CORE_GEMINI.indexOf(marker);
  expect(i).toBeGreaterThan(-1); // оракул найден
  let depth = 0;
  for (let j = i + marker.length - 1; j < CORE_GEMINI.length; j++) {
    if (CORE_GEMINI[j] === '{') depth++;
    else if (CORE_GEMINI[j] === '}') {
      depth--;
      if (depth === 0) return CORE_GEMINI.slice(i, j + 1) + ';';
    }
  }
  throw new Error('stableCheck74: закрывающая скобка не найдена');
}

function makeStorage() {
  const map = {};
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    _map: map
  };
}

// --- песочница: реальный оракул внутри with(ctx) + IIFE (function-expression
//     захватывает объектную среду ctx → присваивания пишут в ctx, как в исходнике) ---
function runStableCheck74(ctx) {
  const body = extractStableCheck74() + '\n stableCheck74();';
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + body + '\n})(); }');
  fn(ctx);
  return ctx;
}

function baseCtx(overrides) {
  const storage = makeStorage();
  // существующий (устаревший) пол: 108 / 216714
  GIL.saveFloor(CONV_ID, PARSER_VERSION, FLOOR_COUNT, FLOOR_EFFECTIVE_LEN, storage);
  const ctx = {
    logs: [],
    emits: 0,
    convId: CONV_ID,
    // состояние момента: лоадер остановился, сеть отдала всё (чистый конец), курсора нет
    lastLoaderDoneReason: 'collapse',
    pendingCursor: null,
    historyFullByQuiet: false,
    quietEndedClean: true,
    quietActive: false,
    lastHnvPageError: false,
    loaderRunningFor: null,
    reachedStart: false,          // reachedStart=0 — физического верха нет
    quietIncompleteNoStart: true,
    oracleIncompleteSeen: { },
    lastBaseCount: 80,            // реальное значение базы (msgs)
    lastBaseCountChangeAt: Date.now() - 6000, // база стабильна ≥5с (подтверждающий повтор)
    lastOlderNonPagAddAt: Date.now() - 6000,
    lastBaseTextLen: 123456,
    aiCmArchiveFor: function () { return null; },
    // реальный aiCmArchiveLiveProven: архива нет → true («Архива нет → прежние гейты»)
    aiCmArchiveLiveProven: function () { return true; },
    debugLog: function (level, msg) { ctx.logs.push(String(msg)); },
    loadFloor: function (cid) { return GIL.loadFloor(cid, PARSER_VERSION, storage); },
    // эмуляция обёртки core `selfHealFloor` (строки рядом с saveFloor)
    selfHealFloor: function (cid, count, effectiveLen, source) {
      return GIL.writeSelfHealedFloor(cid, PARSER_VERSION, count, effectiveLen, source, storage);
    },
    emitBaseSnapshot: function () { ctx.emits++; },
    _storage: storage
  };
  ctx.oracleIncompleteSeen[CONV_ID] = true;
  ctx.window = { GeminiInterceptLogic: GIL };
  return Object.assign(ctx, overrides || {});
}

describe('T1-fix#5: вердикт самоунижения (чистая функция)', () => {
  const good = {
    cleanEnd: true, pendingCursor: null, quietActive: false, pageError: false,
    loaderRunning: false, archivePending: false,
    baseCount: 80, floorCount: FLOOR_COUNT, floorLen: FLOOR_EFFECTIVE_LEN,
    provenLen: 123456, reachedStart: false, confirmations: 1
  };

  test('доказанный чистый конец + база ниже пола → понижение до реальной базы (msgs)', () => {
    expect(GIL.selfHealFloorVerdict(good)).toEqual({
      lower: true, count: 80, effectiveLen: 123456, floorWas: FLOOR_COUNT,
      source: 'clean-end-self-heal', reachedStart: false, reason: 'stale-floor'
    });
  });

  test('устаревшая длина НЕ сохраняется: effectiveLen = реальная длина базы', () => {
    const v = GIL.selfHealFloorVerdict(good);
    expect(v.effectiveLen).toBe(123456);
    expect(v.effectiveLen).not.toBe(FLOOR_EFFECTIVE_LEN);
    // длина базы неизвестна (0) → остаётся прежняя: count уже равен базе, пол не применяется
    expect(GIL.selfHealFloorVerdict(Object.assign({}, good, { provenLen: 0 })).effectiveLen).toBe(FLOOR_EFFECTIVE_LEN);
  });

  test('каждый недоказанный случай запрещает понижение своим reason', () => {
    const cases = [
      [{ cleanEnd: false }, 'no-clean-end'],
      [{ pendingCursor: 'CURSOR' }, 'cursor-alive'],
      [{ quietActive: true }, 'quiet-active'],
      [{ pageError: true }, 'page-error'],
      [{ loaderRunning: true }, 'loader-running'],
      [{ archivePending: true }, 'archive-pending-live'],
      [{ baseCount: 0 }, 'base-empty'],
      [{ floorCount: 0 }, 'no-floor'],
      [{ baseCount: 108 }, 'floor-not-stale'],
      [{ baseCount: 120 }, 'floor-not-stale'],
      [{ confirmations: 0 }, 'unconfirmed']
    ];
    cases.forEach(([patch, reason]) => {
      const v = GIL.selfHealFloorVerdict(Object.assign({}, good, patch));
      expect(v.lower).toBe(false);
      expect(v.reason).toBe(reason);
    });
  });

  test('нулевые/отсутствующие входы → без исключений, понижения нет', () => {
    expect(() => GIL.selfHealFloorVerdict(null)).not.toThrow();
    expect(GIL.selfHealFloorVerdict(null).lower).toBe(false);
    expect(GIL.selfHealFloorVerdict({}).reason).toBe('no-clean-end');
    expect(GIL.selfHealFloorVerdict(undefined).lower).toBe(false);
  });
});

describe('T1-fix#5: единственная точка записи понижения + HWM не тронут', () => {
  test('writeSelfHealedFloor понижает пол и помечает источник', () => {
    const storage = makeStorage();
    GIL.saveFloor(CONV_ID, PARSER_VERSION, FLOOR_COUNT, FLOOR_EFFECTIVE_LEN, storage);
    const rec = GIL.writeSelfHealedFloor(CONV_ID, PARSER_VERSION, 80, 123456, 'clean-end-self-heal', storage);
    expect(rec).not.toBeNull();
    expect(rec.count).toBe(80);
    const f = GIL.loadFloor(CONV_ID, PARSER_VERSION, storage);
    expect(f.count).toBe(80);
    expect(f.effectiveLen).toBe(123456);
    expect(JSON.parse(storage.getItem(GIL.floorStorageKey(CONV_ID, PARSER_VERSION))).source).toBe('clean-end-self-heal');
    // запись адресная: чужой чат/версия не тронуты
    expect(GIL.loadFloor('conv-other', PARSER_VERSION, storage)).toBeNull();
  });

  test('saveFloor по-прежнему монотонен (HWM): понижение через него отклоняется', () => {
    const storage = makeStorage();
    GIL.saveFloor(CONV_ID, PARSER_VERSION, FLOOR_COUNT, FLOOR_EFFECTIVE_LEN, storage);
    GIL.saveFloor(CONV_ID, PARSER_VERSION, 80, 123456, storage); // попытка понизить
    const f = GIL.loadFloor(CONV_ID, PARSER_VERSION, storage);
    expect(f.count).toBe(FLOOR_COUNT);
    expect(f.effectiveLen).toBe(FLOOR_EFFECTIVE_LEN);
  });

  test('writer не пишет мусор: нет storage/convId или count<=0 → null, пол прежний', () => {
    const storage = makeStorage();
    GIL.saveFloor(CONV_ID, PARSER_VERSION, FLOOR_COUNT, FLOOR_EFFECTIVE_LEN, storage);
    expect(GIL.writeSelfHealedFloor(CONV_ID, PARSER_VERSION, 0, 123, 'x', storage)).toBeNull();
    expect(GIL.writeSelfHealedFloor(CONV_ID, PARSER_VERSION, -5, 123, 'x', storage)).toBeNull();
    expect(GIL.writeSelfHealedFloor(CONV_ID, PARSER_VERSION, 80, 123, 'x', null)).toBeNull();
    expect(GIL.writeSelfHealedFloor('', PARSER_VERSION, 80, 123, 'x', storage)).toBeNull();
    expect(GIL.loadFloor(CONV_ID, PARSER_VERSION, storage).count).toBe(FLOOR_COUNT);
  });
});

describe('T1-fix#5: реальный оракул полноты (stableCheck74) снимает deadlock below-floor', () => {
  test('чистый конец + база 80 < пол 108 → пол понижен, полнота подтверждена, экспорт разблокирован', () => {
    const ctx = runStableCheck74(baseCtx());
    const f = GIL.loadFloor(CONV_ID, PARSER_VERSION, ctx._storage);
    expect(f.count).toBe(80);                 // пол самоунижен до реального msgs
    expect(f.effectiveLen).toBe(123456);
    expect(ctx.historyFullByQuiet).toBe(true); // полнота взведена → гейт автоэкспорта открыт
    expect(ctx.reachedStart).toBe(true);
    expect(ctx.quietIncompleteNoStart).toBe(false);
    expect(ctx.oracleIncompleteSeen[CONV_ID]).toBeUndefined();
    expect(ctx.emits).toBe(1);
    const joined = ctx.logs.join('\n');
    expect(joined).toContain('floor self-healed (clean-end)');
    expect(joined).toContain('floorWas=' + FLOOR_COUNT + ' floorNow=80');
    expect(joined).toContain('source=clean-end-self-heal');
    expect(joined).toContain('oracle=complete reason=loader-stable-stop');
    expect(joined).not.toContain('reason=below-floor'); // deadlock-ветка не достигнута
  });

  test('НЕТ доказательства чистого конца → пол не тронут, полнота НЕ объявляется (H10 сохранён)', () => {
    const ctx = runStableCheck74(baseCtx({ quietEndedClean: false }));
    const f = GIL.loadFloor(CONV_ID, PARSER_VERSION, ctx._storage);
    expect(f.count).toBe(FLOOR_COUNT);
    expect(f.effectiveLen).toBe(FLOOR_EFFECTIVE_LEN);
    expect(ctx.historyFullByQuiet).toBe(false);
    expect(ctx.emits).toBe(0);
    // deadlock-ветка (база ниже пола без доказательства) остаётся incomplete
    expect(ctx.logs.join('\n')).toContain('oracle=incomplete reason=loader-max-not-top');
    expect(ctx.logs.join('\n')).not.toContain('floor self-healed');
  });

  test('база ещё растёт (изменение < 5с) → нет подтверждающего повтора, понижения нет', () => {
    const ctx = runStableCheck74(baseCtx({ lastBaseCountChangeAt: Date.now() - 1000 }));
    expect(GIL.loadFloor(CONV_ID, PARSER_VERSION, ctx._storage).count).toBe(FLOOR_COUNT);
    expect(ctx.historyFullByQuiet).toBe(false);
    expect(ctx.logs.join('\n')).toContain('oracle=incomplete reason=loader-max-not-top');
    expect(ctx.logs.join('\n')).not.toContain('floor self-healed');
  });

  test('архив без доказанного живого яруса → понижения нет (T1-гейт архива сохранён)', () => {
    const ctx = runStableCheck74(baseCtx({
      aiCmArchiveFor: function () { return { count: 4 }; },
      aiCmArchiveLiveProven: function () { return false; }
    }));
    expect(GIL.loadFloor(CONV_ID, PARSER_VERSION, ctx._storage).count).toBe(FLOOR_COUNT);
    expect(ctx.historyFullByQuiet).toBe(false);
    expect(ctx.logs.join('\n')).toContain('oracle=incomplete reason=loader-max-not-top');
    expect(ctx.logs.join('\n')).not.toContain('floor self-healed');
  });

  test('база НЕ ниже пола → прежнее поведение (механизм не переусердствует)', () => {
    const ctx = runStableCheck74(baseCtx({ lastBaseCount: 120 }));
    expect(GIL.loadFloor(CONV_ID, PARSER_VERSION, ctx._storage).count).toBe(FLOOR_COUNT); // пол не переписан
    expect(ctx.historyFullByQuiet).toBe(true);
    expect(ctx.logs.join('\n')).toContain('oracle=complete reason=loader-stable-stop');
    expect(ctx.logs.join('\n')).not.toContain('floor self-healed');
  });
});

describe('T1-fix#5: пины проводки и неприкосновенных контуров', () => {
  test('вердикт стоит ПЕРЕД deadlock-ветками (loader-max-not-top / below-floor), H10-лог сохранён', () => {
    const body = fnDecl(CORE_GEMINI, 'notifyLoaderState');
    expect(body).toContain('selfHealFloorVerdict');
    // самоунижение обязано случиться РАНЬШЕ раннего return'а loader-max-not-top,
    // иначе пол не успевает понизиться и deadlock остаётся
    expect(body.indexOf('selfHealFloorVerdict')).toBeLessThan(body.indexOf('reason=loader-max-not-top'));
    expect(body.indexOf('floor self-healed (clean-end)')).toBeLessThan(body.indexOf('reason=loader-max-not-top'));
    expect(body.indexOf('floor self-healed (clean-end)')).toBeLessThan(body.indexOf('reason=below-floor'));
    // сами гейты не удалены (H10: база ниже пола без доказательства → incomplete)
    expect(body).toContain("debugLog('log', '[AI CM][completeness] oracle=incomplete reason=below-floor convId=' + convId +");
    expect(body).toContain('oracle=complete reason=loader-stable-stop');
  });

  test('collapse-гард: прямого setItem пола больше нет, понижение — тем же механизмом', () => {
    expect(CORE_GEMINI).not.toContain("var fkCg = 'ai-cm-gemini-floor-'");
    expect(CORE_GEMINI).toContain('selfHealFloor(convId, __shvCg.count, __shvCg.effectiveLen, __shvCg.source);');
    expect(CORE_GEMINI).toContain('clean-end top confirmed (устаревший пол самоизлечен)'); // лог-пруф сохранён
    expect(CORE_GEMINI).toContain('clean-end collapse candidate');
  });

  test('core-обёртка selfHealFloor делегирует в единственный writer', () => {
    const body = fnDecl(CORE_GEMINI, 'selfHealFloor');
    expect(body).toContain('writeSelfHealedFloor');
    expect(body).toContain('GeminiInterceptLogic');
  });

  test('saveFloor (HWM) не знает про самоунижение', () => {
    const coreSave = fnDecl(CORE_GEMINI, 'saveFloor');
    expect(coreSave).toContain('GeminiInterceptLogic.saveFloor');
    expect(coreSave.toLowerCase()).not.toContain('selfheal');
    expect(GIL.saveFloor.toString()).not.toContain('selfHeal');
    expect(GIL.saveFloor.toString()).toContain('count > existing.count'); // монотонный гард на месте
    expect(GIL.archiveFloorRecord.toString()).not.toContain('selfHeal');
  });

  test('H9/H10-гейты и resetForNewConversation не тронуты', () => {
    ['probeTerminalGate', 'untrustedTopVerdict', 'pagStepBroken', 'collapseGuardVerdict'].forEach((n) => {
      expect(GIL[n].toString()).not.toContain('selfHeal');
    });
    expect(GIL.archiveCompleteVerdict.toString()).not.toContain('selfHeal');
    const reset = fnDecl(CORE_GEMINI, 'resetForNewConversation');
    expect(reset).not.toContain('selfHeal');
    expect(reset).toContain('collapseRetries = 0;');
  });

  test('диагностика T1-diag снята из обоих файлов', () => {
    expect(CORE_GEMINI).not.toContain('T1-diag');
    expect(CORE_CONTENT).not.toContain('T1-diag');
    expect(CORE_GEMINI).toContain("debugLog('log', '[AI CM][completeness] oracle=incomplete reason=below-floor convId=' + convId +");
  });
});
