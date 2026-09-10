/**
 * H11 (monotonic floor в collapse-guard «ретраи исчерпаны 2/2»+clean-end):
 * exhausted-ветка collapse-guard (else of collapseRetries<2) писала пол НАПРЯМУЮ
 * в localStorage (`localStorage.setItem` ключа 'ai-cm-gemini-floor-<v>-<convId>')
 * и ТОЛЬКО при __floorCg > baseSize(), т.е. способна ПОНИЗИТЬ сохранённый пол
 * (108→80), обходя монотонный гард saveFloor (инвариант: пол никогда не
 * уменьшается; единая точка записи — saveFloor → GIL.saveFloor max-логика).
 *
 * Фикс: прямой setItem заменён на обёртку saveFloor(convId, baseSize(),
 * lastBaseTextLen) с сохранением всех typeof-гардов и условия входа в блок;
 * добавлен диагностический лог
 * '[AI CM][Gemini][loader] clean-end floor-write via saveFloor (H11) …'.
 * Остальное в блоке (лог 'clean-end top confirmed (exhausted retries)',
 * doneReason='top', ветка else 'ретраи исчерпаны 2/2 — incomplete as-is', break)
 * — байтово как есть.
 *
 * Регрессионный контур:
 *  (2a) баг-сценарий: пол 108/216714 сохранён, collapse-heal предлагает 80 →
 *       localStorage по ключу пола БЕЗ ИЗМЕНЕНИЙ (монотонный гард удержал 108/216714);
 *  (2b) контроль: штатный saveFloor count=120 > сохранённого → пол обновляется до 120;
 *  (2c) существующие тесты пола/холодного открытия не изменены и зелёные (полный npm test)
 *       + байтовая неизменность прочих путей collapse-guard/чистого конца.
 * Тело извлекается из core/gemini-intercept.js и исполняется в песочнице с `with`
 * (конвенция gemini-collapse-guard / floor-confirmed) — гоняем исходный код,
 * а не копию логики.
 */
const fs = require('fs');
const path = require('path');

const GIL = require('../../utils/gemini-intercept-logic.js');

const coreSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
  'utf8'
);

const PARSER_VERSION = 'g-h11';
const CONV_ID = 'conv-h11';
const FLOOR_COUNT = 108;
const FLOOR_EFFECTIVE_LEN = 216714;

function makeStorage() {
  const map = {};
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    _map: map
  };
}

// --- извлечение exhausted clean-end if/else СТЕЙТМЕНТА из РЕАЛЬНОГО исходника ---
// Маркер уникален: self-heal-ветка (retries>=1) начинается с
// `if (__cleanEndCg && collapseRetries >= 1 &&` — эта строка матчится ТОЛЬКО
// на exhausted clean-end if (line ~2184). Скобочный скан с else-поддержкой:
// `} else {` не является концом стейтмента.
function extractExhaustedCleanEndStatement() {
  const marker = 'if (__cleanEndCg && typeof lastCleanEndBaseCount !== \'undefined\' && baseSize() === lastCleanEndBaseCount) {';
  const i = coreSrc.indexOf(marker);
  expect(i).toBeGreaterThan(-1); // exhausted clean-end if найден в core
  let depth = 0;
  const re = /\{|\}/g;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(coreSrc)) !== null) {
    if (m[0] === '{') depth++;
    else {
      depth--;
      if (depth === 0) {
        const rest = coreSrc.slice(m.index + 1);
        if (/^\s*else\b/.test(rest)) {
          // `} else {` — не конец: счётчик уже на 0, `{` else-ветки поднимет до 1
          continue;
        }
        return coreSrc.slice(i, m.index + 1); // полный if (...) {…} else {…}
      }
    }
  }
  throw new Error('exhausted clean-end if/else: закрывающая скобка не найдена');
}

// --- песочница: тело исполняется внутри with(ctx) + IIFE ---
function runBody(body, ctx) {
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + body + '\n})(); }');
  fn(ctx);
  return ctx;
}

function baseCtx(overrides) {
  const storage = makeStorage();
  // существующий пол: count=108 / effectiveLen=216714
  GIL.saveFloor(CONV_ID, PARSER_VERSION, FLOOR_COUNT, FLOOR_EFFECTIVE_LEN, storage);
  const ctx = {
    logs: [],
    debugLog: function (kind, msg) { ctx.logs.push(msg); },
    doneReason: 'collapse',
    convId: CONV_ID,
    // эмуляция обёртки saveFloor(convId, count, effectiveLen) из core (строки ~460-463):
    // → window.GeminiInterceptLogic.saveFloor(convId, parserVersion, count, effectiveLen, localStorage)
    saveFloor: function (convId, count, effectiveLen) {
      GIL.saveFloor(convId, PARSER_VERSION, count, effectiveLen, storage);
    },
    parserVersion: PARSER_VERSION,
    localStorage: storage,
    __floorCg: FLOOR_COUNT,
    _storage: storage
  };
  return Object.assign(ctx, overrides || {});
}

describe('Gemini H11: collapse-guard exhausted clean-end пишет пол через saveFloor (монотонно)', () => {
  const exhaustedStatement = extractExhaustedCleanEndStatement();

  test('(2a) баг-сценарий: пол 108/216714 + clean-end heal base=80 → localStorage БЕЗ ИЗМЕНЕНИЙ', () => {
    // состояние: тихая пагинация завершилась чисто, база не выросла на повторе
    const ctx = baseCtx({
      __cleanEndCg: true,
      lastCleanEndBaseCount: 80,
      baseSize: () => 80,
      lastBaseTextLen: 123456
    });
    runBody(exhaustedStatement, ctx);

    // ветка clean-end top confirm (exhausted retries) отработала как раньше
    expect(ctx.doneReason).toBe('top');
    expect(ctx.logs.join('\n')).toContain('clean-end top confirmed (exhausted retries)');

    // H11-лог попытки записи через saveFloor присутствует
    expect(ctx.logs.join('\n')).toContain('clean-end floor-write via saveFloor (H11)');
    expect(ctx.logs.join('\n')).toContain('proposed=80 floorWas=' + FLOOR_COUNT);

    // ПОЛ НЕ ПОНИЖЕН: монотонный гард saveFloor отклонил 80 (< 108)
    const f = GIL.loadFloor(CONV_ID, PARSER_VERSION, ctx._storage);
    expect(f).not.toBeNull();
    expect(f.count).toBe(FLOOR_COUNT);
    expect(f.effectiveLen).toBe(FLOOR_EFFECTIVE_LEN);
    const parsed = JSON.parse(ctx._storage.getItem(GIL.floorStorageKey(CONV_ID, PARSER_VERSION)));
    expect(parsed.count).toBe(FLOOR_COUNT);
    expect(parsed.effectiveLen).toBe(FLOOR_EFFECTIVE_LEN);
  });

  test('(2a-байт) в exhausted clean-end блоке больше НЕТ прямого localStorage.setItem пола', () => {
    expect(exhaustedStatement).not.toContain("var fkCg2 = 'ai-cm-gemini-floor-'");
    expect(exhaustedStatement).not.toContain('localStorage.setItem(fkCg2,');
    expect(exhaustedStatement).toContain('saveFloor(convId, baseSize(), lastBaseTextLen);');
    // typeof-гарды входа в блок сохранены
    expect(exhaustedStatement).toContain("__floorCg > baseSize() && convId && typeof parserVersion !== 'undefined' && parserVersion");
    expect(exhaustedStatement).toContain("typeof localStorage !== 'undefined' && typeof lastBaseTextLen !== 'undefined'");
  });

  test('(2a-ветка else) НЕ clean-end → «ретраи исчерпаны 2/2 — incomplete as-is», пол не тронут', () => {
    const ctx = baseCtx({ __cleanEndCg: false, baseSize: () => 80 });
    runBody(exhaustedStatement, ctx);
    expect(ctx.doneReason).toBe('collapse');
    expect(ctx.logs.join('\n')).toContain('ретраи исчерпаны 2/2');
    expect(ctx.logs.join('\n')).not.toContain('clean-end top confirmed');
    const f = GIL.loadFloor(CONV_ID, PARSER_VERSION, ctx._storage);
    expect(f.count).toBe(FLOOR_COUNT);
    expect(f.effectiveLen).toBe(FLOOR_EFFECTIVE_LEN);
  });

  test('(2b) контроль: штатный saveFloor count=120 > сохранённого (108) → пол обновляется до 120', () => {
    const storage = makeStorage();
    GIL.saveFloor(CONV_ID, PARSER_VERSION, FLOOR_COUNT, FLOOR_EFFECTIVE_LEN, storage);
    // штатная запись через ту же обёртку, что зовёт exhausted clean-end после фикса
    GIL.saveFloor(CONV_ID, PARSER_VERSION, 120, 300000, storage);
    const f = GIL.loadFloor(CONV_ID, PARSER_VERSION, storage);
    expect(f).not.toBeNull();
    expect(f.count).toBe(120);
    expect(f.effectiveLen).toBe(300000);
  });
});

describe('Gemini H11: байтовая неизменность прочих путей (clean-end / collapse-guard)', () => {
  test('self-heal-ветка (collapseRetries>=1, «устаревший пол самоизлечен») не тронута', () => {
    expect(coreSrc).toContain('clean-end top confirmed (устаревший пол самоизлечен)');
    expect(coreSrc).toContain('clean-end collapse candidate');
    expect(coreSrc).toContain("doneReason = 'top'; // v1.15: чистый конец сети + физический верх → stable-stop оракул");
  });

  test('(2c) exhausted clean-end: лог/структура сохранены, прямого setItem пола больше нет', () => {
    // лог exhausted-ветки на месте
    expect(coreSrc).toContain("clean-end top confirmed (exhausted retries)");
    // ветка else 'ретраи исчерпаны 2/2 — incomplete as-is' + break сохранены
    expect(coreSrc).toContain('collapse-guard: ретраи исчерпаны 2/2 — incomplete as-is convId=');
    // прямой setItem (и его ключ-переменная) удалён из файла
    expect(coreSrc).not.toContain("var fkCg2 = 'ai-cm-gemini-floor-'");
    // новая строка лога H11 присутствует в core
    expect(coreSrc).toContain("'[AI CM][Gemini][loader] clean-end floor-write via saveFloor (H11) convId='");
  });

  test('(2c) прочие гарды/логика не тронуты (ключевые строки на месте)', () => {
    const pins = [
      'untrustedTopVerdict',       // H9 untrusted-top
      'probeTerminalGate',         // H10 probe-terminal gate
      'stableCheck74',             // stable-stop оракул
      'resolveFloor',              // resolveFloor
      'shouldSaveFloor',           // shouldSaveFloor
      'lastPagStepBroken',         // H9 pagStepBroken
      'loader-stable-stop',        // oracle complete reason
      'reachedStart',              // начало подтверждено
      'historyFullByQuiet'         // полнота по тихой пагинации
    ];
    pins.forEach((p) => expect(coreSrc).toContain(p));
  });
});
