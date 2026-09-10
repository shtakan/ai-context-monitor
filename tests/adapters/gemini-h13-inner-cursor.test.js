/**
 * H13 (inner-cursor): континуационный курсор глубоких окон Gemini живёт ВНУТРИ inner
 * (outer[0][2] → JSON.parse → turns[1]) и длиннее потолка 600 (e292: len=705 для окна
 * 81..100, len=849 для окна 101..108). Узкая extractCursor (classifyOpaque 40..600)
 * давала ложный negative, широкая extractCursorWide сканировала только rest
 * (outer[0].slice(3)) и inner не видела вовсе → контрольный probe объявлял терминальным
 * ответ, НЁСШИЙ живой курсор (oracle=complete reason=probe-terminal на усечённой базе).
 *
 * Фикс (канон — utils/gemini-intercept-logic.js, в core — делегация + inline-дубль):
 *   1) classifyOpaque: потолок 600→2000 (токены 705/849 реальны; фильтры мусора
 *      image/png-строк и не-b64 сохранены);
 *   2) extractCursorWide: зоны скана — inner (outer[0][2] → JSON.parse → turns) ПЕРВОЙ,
 *      затем rest (outer[0].slice(3)); приоритет — ДЛИННЕЙШИЙ b64-кандидат;
 *   3) extractCursor: приоритет длиннейшего по всему turns (включая turns[1]).
 *
 * Защищённые пути (probe-terminal/probeTerminalGate, retained H9b, no-older-history,
 * stable-stop/floor-confirmed, untrusted-top, circular-mismatch и пр.) не меняются —
 * их лог/reason-строки и ветки проверяются существующими сьютами и пинами ниже.
 *
 * H15 (hex-marker): probe-ответ (e292) несёт в inner (turns[1]) служебный hex-маркер
 * 16 символов (только [0-9a-fA-F]) — НЕ континуационный токен. [0-9a-fA-F] ⊂ b64-алфавита,
 * поэтому classifyOpaqueWide (8..2000) классифицировал его как opaque → ложный
 * cursorFound=yes → бесконечный цикл probe-non-terminal. Фикс (только в каноне
 * utils/gemini-intercept-logic.js, core НЕ тронут): hex-строка длиной < 40 → false
 * в обоих классификаторах (isShortHexMarker).
 *
 * H17 (mime-garbage): e292-диагностика — inner-зона терминального шага пагинации несёт
 * MIME-тип вложений ("image/png", len=9; '/' ∈ b64-алфавита, 9 в wide 8..2000 → true) →
 * тот же ложный cursorFound=yes → цикл probe-non-terminal. Фикс (только канон utils,
 * core НЕ тронут): MIME-префиксы (image/ video/ audio/ application/ text/) → false +
 * нижняя граница wide 8→16. Тесты — в describe H17 ниже; защищённые пути те же, что выше.
 */
const fs = require('fs');
const path = require('path');

const GIL = require('../../utils/gemini-intercept-logic.js');
const coreSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
  'utf8'
);

// ---- фикстуры e292: токены в форме реальных континуационных токенов tC…Ag== ----
function b64Tok(len, seed) {
  return 'tC' + String(seed).repeat(len - 6) + 'Ag==';
}
const TOK_705 = b64Tok(705, 'A');
const TOK_849 = b64Tok(849, 'B');
// реальная форма окна: turns.len=4, ходы в turns[0], курсор в turns[1], хвост [] (тест2_logs)
function makeWindowTurns(tok, extra) {
  const t = [
    [[['r_61aa', 'r_62bb'], [['текст окна (не b64)']]]],
    tok,
    [1783900002, 0],
    []
  ];
  if (extra) Object.assign(t, extra);
  return t;
}
function makeOuter(turnsArr, restTail) {
  const inner = JSON.stringify(turnsArr);
  // outer = [entry], entry = ['wrb.fr','hNvQHb',<inner>,(rest…)] — outer[0].len=7 как в логах
  return [['wrb.fr', 'hNvQHb', inner, null, null, null, restTail || 'rest-метаданные (не b64)']];
}

// ===== классификаторы =====
describe('H13: classifyOpaque (потолок 600→2000)', () => {
  test('(а) len=705 и len=849 (реальные токены e292) → opaque', () => {
    expect(GIL.classifyOpaque(TOK_705)).toBe(true);
    expect(GIL.classifyOpaque(TOK_849)).toBe(true);
  });

  test('(б) границы: 40..2000 проходят, <40 и >2000 нет', () => {
    expect(GIL.classifyOpaque(b64Tok(40, 'C'))).toBe(true);
    expect(GIL.classifyOpaque(b64Tok(600, 'D'))).toBe(true);  // старая граница
    expect(GIL.classifyOpaque(b64Tok(601, 'E'))).toBe(true);  // раньше отсекалось
    expect(GIL.classifyOpaque(b64Tok(2000, 'F'))).toBe(true);
    expect(GIL.classifyOpaque(b64Tok(39, 'G'))).toBe(false);
    expect(GIL.classifyOpaque(b64Tok(2001, 'H'))).toBe(false);
    expect(GIL.classifyOpaque('')).toBe(false);
    expect(GIL.classifyOpaque(null)).toBe(false);
    expect(GIL.classifyOpaque(705)).toBe(false);
  });

  test('(в) фильтры мусора сохранены: image/png-строки, не-b64, $AVuibg', () => {
    expect(GIL.classifyOpaque('data:image/png;base64,' + 'A'.repeat(80))).toBe(false);
    expect(GIL.classifyOpaque('вопрос на русском длиной больше сорока символов и ещё немного')).toBe(false);
    expect(GIL.classifyOpaque('$AVuibg' + 'A'.repeat(80))).toBe(false);
    expect(GIL.classifyOpaque('r_61aa' + 'A'.repeat(80))).toBe(false); // '_' вне b64
    expect(GIL.classifyOpaque('A'.repeat(30) + '=ABC' + 'A'.repeat(30))).toBe(false); // '=' внутри
  });
});

// ===== H15 (hex-marker): короткие hex-маркеры (16 символов [0-9a-fA-F]) НЕ opaque =====
// e292: probe-ответ несёт в inner (turns[1]) служебный hex-маркер 16 символов — НЕ
// континуационный токен; раньше classifyOpaqueWide (8..2000, [0-9a-fA-F] ⊂ b64-алфавита)
// давал true → ложный cursorFound=yes → цикл probe-non-terminal. Правило фикса (только
// utils/gemini-intercept-logic.js): строка из ТОЛЬКО hex-символов длиной < 40 → false.
const HEX16_LOWER = '3f8a9c2b7d1e0a4f'; // ровно 16 hex-символов
const HEX16_UPPER = '3F8A9C2B7D1E0A4F';
const HEX16_MIXED = '3f8A9c2B7d1E0a4F';

describe('H15: hex-маркеры (16 символов) → НЕ opaque (оба классификатора)', () => {
  test('(а) classifyOpaque: hex-маркер 16 символов (нижний/верхний/смешанный) → false', () => {
    expect(GIL.classifyOpaque(HEX16_LOWER)).toBe(false);
    expect(GIL.classifyOpaque(HEX16_UPPER)).toBe(false);
    expect(GIL.classifyOpaque(HEX16_MIXED)).toBe(false);
  });

  test('(б) classifyOpaqueWide: hex-маркер 16 символов → false (H14: ложный cursorFound устранён)', () => {
    expect(GIL.classifyOpaqueWide(HEX16_LOWER)).toBe(false);
    expect(GIL.classifyOpaqueWide(HEX16_UPPER)).toBe(false);
    expect(GIL.classifyOpaqueWide(HEX16_MIXED)).toBe(false);
  });

  test('(в) короткие НЕ-hex b64-кандидаты (legacy wide 8..39) не задеты', () => {
    expect(GIL.classifyOpaqueWide('q'.repeat(16))).toBe(true); // q вне [0-9a-fA-F]
    expect(GIL.classifyOpaqueWide('q'.repeat(39))).toBe(true);
    expect(GIL.classifyOpaqueWide('q'.repeat(7))).toBe(false);  // <8 как было
    expect(GIL.classifyOpaque('q'.repeat(16))).toBe(false);     // узкая <40 как было
  });

  test('(г) правило только <40: hex-строка >= 40 классифицируется как прежде', () => {
    const hex40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e'; // ровно 40 hex
    const hex39 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3';  // 39 hex → под правило
    expect(hex40.length).toBe(40);
    expect(hex39.length).toBe(39);
    expect(GIL.classifyOpaque(hex40)).toBe(true);
    expect(GIL.classifyOpaqueWide(hex40)).toBe(true);
    expect(GIL.classifyOpaqueWide(hex39)).toBe(false);
    expect(GIL.classifyOpaque(hex39)).toBe(false);
  });

  test('(д) extractCursorWide: hex-маркер в turns[1] и НЕТ b64-кандидатов → курсор не найден (null)', () => {
    // H14-сценарий дословно: раньше wide давал hex-маркер → ложный cursorFound=yes
    const outer = makeOuter(makeWindowTurns(HEX16_LOWER));
    expect(GIL.extractCursorWide(outer)).toBeNull();
    expect(GIL.extractCursor(makeWindowTurns(HEX16_LOWER))).toBeNull();
  });

  test('(е) hex-маркер рядом с реальным токеном не мешает: длиннейший b64 (705/849) побеждает', () => {
    const turns = [[[['r_61aa', 'r_62bb'], [['текст окна (не b64)']]]], HEX16_LOWER, [TOK_705], []];
    expect(GIL.extractCursorWide(makeOuter(turns))).toBe(TOK_705);
    expect(GIL.extractCursor(turns)).toBe(TOK_705);
    const turns2 = [[[['r_61aa'], [['текст']]]], [HEX16_UPPER, [TOK_849]], [], 'meta'];
    expect(GIL.extractCursorWide(makeOuter(turns2))).toBe(TOK_849);
  });

  test('(ж) не-hex буква (g..z) в составе → строка не под hex-правило (wide как раньше)', () => {
    expect(GIL.classifyOpaqueWide('abcdefg'.repeat(2) + '1234')).toBe(true);
  });
});

// ===== H17 (mime-garbage): MIME-типы вложений и b64-мусор 8..15 НЕ opaque =====
// e292 (терминальный шаг тихой пагинации): probe-ответ несёт в inner (turns) MIME-тип
// вложений "image/png" (len=9). '/' допустим в b64-алфавите, длина 9 попадала в wide
// 8..2000 → раньше classifyOpaqueWide давал true → wide-курсор = MIME-мусор → ложный
// cursorFound=yes на ответе БЕЗ курсора → цикл probe-non-terminal. Правила фикса
// (только utils/gemini-intercept-logic.js, core НЕ тронут): MIME-префикс
// (image/ video/ audio/ application/ text/) → false; нижняя граница wide 8→16
// (b64-подобный мусор 8..15 → false). Реальные токены 705/849 и hex-маркеры
// 16..39 (H15) не задеты.
const MIME_PNG = 'image/png';                // len=9 — точный H16-токен
const MIME_JSON = 'application/json';        // len=16 — ровно новая граница, режет префикс

describe('H17: MIME-типы и b64-мусор 8..15 → НЕ opaque (classifyOpaqueWide)', () => {
  test('(а) MIME-префиксы всех пяти классов → false (в т.ч. длиннее нижней границы)', () => {
    expect(MIME_PNG.length).toBe(9);   // короткий: режут и префикс, и min-16
    expect(MIME_JSON.length).toBe(16); // ровно граница 16 — режет ТОЛЬКО префикс
    [
      'image/png', 'image/webp',                  // image/
      'video/mp4',                                // video/
      'audio/mpeg',                               // audio/
      'application/json', 'application/x-protobuf', // application/ (22 символа)
      'text/plain', 'text/html'                   // text/
    ].forEach((m) => expect(GIL.classifyOpaqueWide(m)).toBe(false));
  });

  test('(б) нижняя граница 8→16: b64-подобный мусор 8..15 → false, 16..39 → true', () => {
    expect(GIL.classifyOpaqueWide('q'.repeat(15))).toBe(false); // было true (легаси 8..15)
    expect(GIL.classifyOpaqueWide('q'.repeat(8))).toBe(false);  // нижний край легаси 8
    expect(GIL.classifyOpaqueWide('q'.repeat(7))).toBe(false);  // <8 как было
    expect(GIL.classifyOpaqueWide('q'.repeat(16))).toBe(true);  // граница 16 (сверено с H15 (в))
    expect(GIL.classifyOpaqueWide('q'.repeat(39))).toBe(true);  // легаси-хвост 16..39 жив
  });

  test('(в) extractCursorWide: MIME в inner turns[1] (H16-сценарий) → курсор не найден', () => {
    // раньше wide возвращал 'image/png' → ложный cursorFound=yes на терминальном шаге
    expect(GIL.extractCursorWide(makeOuter(makeWindowTurns(MIME_PNG)))).toBeNull();
    expect(GIL.extractCursor(makeWindowTurns(MIME_PNG))).toBeNull(); // узкая не видела и раньше
    // 'application/json' (len=16) не проходит и при новой нижней границе — режет префикс
    const turns16 = [[[['r_61aa'], [['текст окна (не b64)']]]], MIME_JSON, [], []];
    expect(GIL.extractCursorWide(makeOuter(turns16))).toBeNull();
  });

  test('(г) MIME и короткий slash-мусор (8..15) в rest → null; легаси rest 16..39 жив', () => {
    expect(GIL.extractCursorWide(makeOuter(makeWindowTurns(null), MIME_PNG))).toBeNull();
    // slash-мусор 9 символов (b64-алфавит; раньше wide-true)
    const slashJunk = 'AB/CD123';
    expect(GIL.classifyOpaqueWide(slashJunk)).toBe(false);
    expect(GIL.extractCursorWide(makeOuter(makeWindowTurns(null), slashJunk))).toBeNull();
    // короткий НЕ-MIME кандидат 16..39 в rest по-прежнему виден (legacy wide)
    const restShort = 'q'.repeat(20);
    expect(GIL.extractCursorWide(makeOuter(makeWindowTurns(null), restShort))).toBe(restShort);
  });

  test('(д) MIME рядом с реальным токеном не мешает: 705/849 (длиннейший) побеждают', () => {
    const turns705 = [[[['r_61aa', 'r_62bb'], [['текст окна (не b64)']]]], MIME_PNG, [TOK_705], []];
    expect(GIL.extractCursorWide(makeOuter(turns705))).toBe(TOK_705);
    expect(GIL.extractCursor(turns705)).toBe(TOK_705);
    const turns849 = [[[['r_61aa'], [['текст']]]], MIME_JSON, [TOK_849], 'meta'];
    expect(GIL.extractCursorWide(makeOuter(turns849))).toBe(TOK_849);
    expect(GIL.classifyOpaqueWide(TOK_705)).toBe(true); // реальные токены не задеты
    expect(GIL.classifyOpaqueWide(TOK_849)).toBe(true);
  });

  test('(е) прочие wide-фильтры и H15 сохранены (hex 16..39, $AVuibg, не-b64)', () => {
    expect(GIL.classifyOpaqueWide(HEX16_LOWER)).toBe(false); // H15 не задеты
    expect(GIL.classifyOpaqueWide(HEX16_UPPER)).toBe(false);
    expect(GIL.classifyOpaqueWide('$AVuibg' + 'A'.repeat(30))).toBe(false);
    expect(GIL.classifyOpaqueWide('data:image/png;base64,' + 'A'.repeat(30))).toBe(false); // ':'/';'
    expect(GIL.classifyOpaqueWide('нет-b64-символов')).toBe(false);
  });
});

// ===== extractCursor (узкая: весь turns, включая turns[1]) =====
describe('H13: extractCursor извлекает inner-курсор (turns[1], len=705/849)', () => {
  test('(а) токен len=705 в turns[1] → извлекается', () => {
    expect(GIL.extractCursor(makeWindowTurns(TOK_705))).toBe(TOK_705);
  });

  test('(б) токен len=849 в turns[1] → извлекается', () => {
    expect(GIL.extractCursor(makeWindowTurns(TOK_849))).toBe(TOK_849);
  });

  test('(в) вложенный токен (turns[1][0]… поддерево) → извлекается', () => {
    const turns = [[], [[null, ['x'], null, [TOK_705]]], 'meta', []];
    expect(GIL.extractCursor(turns)).toBe(TOK_705);
  });

  test('(г) без opaque-кандидатов → null (мусор контента не проходит)', () => {
    expect(GIL.extractCursor([[['r_a'], [['текст без b64']]]])).toBeNull();
    expect(GIL.extractCursor(null)).toBeNull();
    expect(GIL.extractCursor(undefined)).toBeNull();
    expect(GIL.extractCursor('строка')).toBeNull();
  });

  test('(д) приоритет — длиннейший кандидат; равные — последний (как до H13)', () => {
    const short = b64Tok(120, 'S');
    const turns = [short, TOK_705, [], short]; // 120 в [0], 705 в [1], 120 в [3]
    expect(GIL.extractCursor(turns)).toBe(TOK_705);
    const tieA = b64Tok(200, 'X');
    const tieB = b64Tok(200, 'Y');
    expect(GIL.extractCursor([tieA, tieB])).toBe(tieB); // равные → последний
  });
});

// ===== extractCursorWide (широкая: inner ПЕРВОЙ, затем rest; длиннейший) =====
describe('H13: extractCursorWide видит inner (turns), rest сохранён, длиннейший побеждает', () => {
  test('(а) токен len=705 в inner turns[1] → извлекается (probe-ответ e292)', () => {
    expect(GIL.extractCursorWide(makeOuter(makeWindowTurns(TOK_705)))).toBe(TOK_705);
  });

  test('(б) токен len=849 в inner turns[1] → извлекается', () => {
    expect(GIL.extractCursorWide(makeOuter(makeWindowTurns(TOK_849)))).toBe(TOK_849);
  });

  test('(в) вложенный inner-токен (turns[1][0][3][0]) → извлекается', () => {
    const turns = [[], [[null, ['x'], null, [TOK_849]]], 'meta', []];
    expect(GIL.extractCursorWide(makeOuter(turns))).toBe(TOK_849);
  });

  test('(г) legacy: inner без кандидатов, b64-курсор в rest → rest-зона работает как раньше', () => {
    const restTok = 'z'.repeat(120);
    const outer = makeOuter(makeWindowTurns(null), restTok);
    expect(GIL.extractCursorWide(outer)).toBe(restTok);
  });

  test('(д) короткий rest-кандидат (8..39, legacy wide) по-прежнему виден', () => {
    const restTok = 'q'.repeat(20);
    const outer = makeOuter(makeWindowTurns(null), restTok);
    expect(GIL.extractCursorWide(outer)).toBe(restTok);
    expect(GIL.extractCursor(makeWindowTurns(null))).toBeNull(); // узкая его не видит (как было)
  });

  test('(е) длиннейший между зонами: inner 705 > rest 200 → 705', () => {
    const outer = makeOuter(makeWindowTurns(TOK_705), 'z'.repeat(200));
    expect(GIL.extractCursorWide(outer)).toBe(TOK_705);
  });

  test('(ж) равные длины: выигрывает найденный раньше — из inner (зона inner первой)', () => {
    const restTok = b64Tok(120, 'R');
    const outer = makeOuter(makeWindowTurns(b64Tok(120, 'I')), restTok);
    expect(GIL.extractCursorWide(outer)).toBe(b64Tok(120, 'I'));
  });

  test('(з) ошибка-страница (inner не строка / не JSON) не ломает rest-скан; мусор не проходит', () => {
    // inner=null (BardErrorInfo) — зона inner пуста, rest junk не b64 → null
    expect(GIL.extractCursorWide([['wrb.fr', 'hNvQHb', null, null, null, null, 'метаданные']])).toBeNull();
    // inner — НЕ валидный JSON
    const outerBad = [['wrb.fr', 'hNvQHb', '[[[не json', null, null, null, 'z'.repeat(60)]];
    expect(GIL.extractCursorWide(outerBad)).toBe('z'.repeat(60)); // rest-скан жив
    expect(GIL.extractCursorWide(null)).toBeNull();
    expect(GIL.extractCursorWide([])).toBeNull();
    expect(GIL.extractCursorWide([1, 2])).toBeNull();
  });
});

// ===== извлечение РЕАЛЬНЫХ тел функций из core/gemini-intercept.js (конвенция H11/H12) =====
function extractCoreFunction(name) {
  const marker = 'function ' + name + '(';
  const i = coreSrc.indexOf(marker);
  expect(i).toBeGreaterThan(-1); // определение функции найдено в core-исходнике
  let j = i + marker.length - 1;
  let depth = 0;
  while (j < coreSrc.length) {
    const ch = coreSrc[j];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) break; }
    j++;
  }
  const open = coreSrc.indexOf('{', j);
  let k = open;
  depth = 0;
  while (k < coreSrc.length) {
    const ch = coreSrc[k];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    k++;
  }
  return coreSrc.slice(i, k + 1);
}

function makeCoreFns(ctx) {
  const fnSrc = {};
  ['classifyOpaque', 'classifyOpaqueWide', 'findCursors', 'edges8', 'extractCursor', 'extractCursorWide']
    .forEach((n) => {
      fnSrc[n] = extractCoreFunction(n);
    });
  const fns = {};
  Object.keys(fnSrc).forEach((n) => {
    const src = fnSrc[n];
    fns[n] = new Function('ctx', 'with (ctx) { return (' + src + '); }')(ctx);
  });
  // свободные переменные извлечённых функций разрешаются через ctx (with-запись)
  ctx.classifyOpaque = fns.classifyOpaque;
  ctx.classifyOpaqueWide = fns.classifyOpaqueWide;
  ctx.findCursors = fns.findCursors;
  ctx.edges8 = fns.edges8;
  ctx.extractCursor = fns.extractCursor;
  ctx.extractCursorWide = fns.extractCursorWide;
  ctx.debugLog = function (kind, msg) { (ctx.logs = ctx.logs || []).push(msg); };
  return fns;
}

// Контекст без window → извлечённые функции идут по inline-дублю (как без GeminiInterceptLogic);
// выставив ctx.window = { GeminiInterceptLogic: GIL } — по делегации (как в проде).
function sandboxCtx(overrides) {
  const ctx = {
    window: undefined,
    loggedMultiCursor: false,
    logs: []
  };
  makeCoreFns(ctx);
  return Object.assign(ctx, overrides || {});
}

describe('H13: inline-дубли в core/gemini-intercept.js = новой семантике (реальные тела из исходника)', () => {
  test('(а) fallback classifyOpaque пропускает 705/849 и режет >2000/мусор', () => {
    const ctx = sandboxCtx();
    expect(ctx.classifyOpaque(TOK_705)).toBe(true);
    expect(ctx.classifyOpaque(TOK_849)).toBe(true);
    expect(ctx.classifyOpaque(b64Tok(601, 'E'))).toBe(true); // 600-потолок снят и в core
    expect(ctx.classifyOpaque(b64Tok(2001, 'H'))).toBe(false);
    expect(ctx.classifyOpaque('data:image/png;base64,' + 'A'.repeat(80))).toBe(false);
    expect(ctx.classifyOpaque('$AVuibg' + 'A'.repeat(80))).toBe(false);
    expect(ctx.loggedMultiCursor).toBe(false);
  });

  test('(б) fallback extractCursor находит inner-курсор 705/849 (turns[1])', () => {
    const ctx = sandboxCtx();
    expect(ctx.extractCursor(makeWindowTurns(TOK_705))).toBe(TOK_705);
    expect(ctx.extractCursor(makeWindowTurns(TOK_849))).toBe(TOK_849);
    expect(ctx.extractCursor(makeWindowTurns(null))).toBeNull();
  });

  test('(в) fallback extractCursorWide читает inner-зону первой и берёт длиннейший', () => {
    const ctx = sandboxCtx();
    expect(ctx.extractCursorWide(makeOuter(makeWindowTurns(TOK_705)))).toBe(TOK_705);
    expect(ctx.extractCursorWide(makeOuter(makeWindowTurns(TOK_849)))).toBe(TOK_849);
    // rest-легаси жив
    const restTok = 'z'.repeat(120);
    expect(ctx.extractCursorWide(makeOuter(makeWindowTurns(null), restTok))).toBe(restTok);
    // длиннейший между зонами
    expect(ctx.extractCursorWide(makeOuter(makeWindowTurns(TOK_705), 'z'.repeat(200)))).toBe(TOK_705);
    // ошибка-страница: inner=null
    expect(ctx.extractCursorWide([['wrb.fr', 'hNvQHb', null, null, null, null, 'метаданные']])).toBeNull();
    expect(ctx.extractCursorWide(null)).toBeNull();
  });

  test('(г) делегация (window.GeminiInterceptLogic) даёт те же результаты, что канон utils', () => {
    const ctx = sandboxCtx({ window: { GeminiInterceptLogic: GIL } });
    expect(ctx.extractCursorWide(makeOuter(makeWindowTurns(TOK_705)))).toBe(TOK_705);
    expect(ctx.extractCursor(makeWindowTurns(TOK_849))).toBe(TOK_849);
    expect(ctx.classifyOpaque(b64Tok(2000, 'F'))).toBe(true);
    expect(ctx.classifyOpaque(b64Tok(2001, 'H'))).toBe(false);
    expect(ctx.classifyOpaqueWide('q'.repeat(20))).toBe(true);
  });

  test('(д) H13 не тронул защищённые пути: reason-строки и делегации на месте', () => {
    const pins = [
      'oracle=complete reason=probe-terminal',      // probe-terminal (H10)
      'probe-terminal blocked reason=',             // гейт H10
      'retained-wide-cur fed reason=oracle-b',      // retained H9b
      'retained-meta fed reason=fallback-top',      // retained H9b (fallback-top)
      'oracle=complete reason=no-older-history',    // no-older-history
      'oracle=incomplete reason=circular-mismatch', // circular-mismatch
      'loader-stable-stop',                         // stable-stop оракул
      'untrustedTopVerdict',                        // H9
      'stableFloorConfirm',                         // floor-confirmed
      'window.GeminiInterceptLogic.extractCursorWide', // делегация H13
      'window.GeminiInterceptLogic.extractCursor',      // делегация H13
      'window.GeminiInterceptLogic.classifyOpaque'      // делегация H13
    ];
    pins.forEach((p) => expect(coreSrc).toContain(p));
    // ключевые строки, которые НЕ должны появиться (ложный complete по-прежнему невозможен)
    expect(coreSrc).not.toContain('oracle=complete reason=scroll-top-proof');
  });
});

// ===== retained H9b: здоровый pag-шаг с inner-токеном фиксирует wide-курсор =====
// Тело H9b-блока извлекается из РЕАЛЬНОГО исходника и исполняется в песочнице с `with`
// (конвенция floor-monotonic-h11): гоняем код тихого цикла, а не копию логики.
function extractRetainBlock() {
  const startMarker = '// H9b (retain-last-good): фиксация retained ТОЛЬКО на здоровом шаге тихой пагинации';
  const endMarker = '// v1.15 (BUG «холодное открытие без полной истории»): страница вернула ОШИБКУ Bard';
  const i = coreSrc.indexOf(startMarker);
  const j = coreSrc.indexOf(endMarker);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return coreSrc.slice(i, j);
}

function runRetainBlock(ctx) {
  const block = extractRetainBlock();
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + block + '\n})(); }');
  fn(ctx);
  return ctx;
}

function retainCtx(overrides) {
  // window=undefined → извлечённый реальный extractCursorWide идёт по inline-дублю
  const ctx = sandboxCtx();
  ctx.lastPagStepBroken = false;
  ctx.added = 0;              // шаг-дубль: новых ходов нет
  ctx.next = null;            // узкий extractCursor не дал курсора (H13-сценарий)
  ctx.lastHeadToken = null;
  ctx.lastGoodWideCur = null;
  ctx.lastGoodProbeMeta = null;
  ctx.__pagLoopConv = 'conv-h13';
  ctx.lastAtEncoded = 'at-1';
  ctx.lastBaseUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';
  ctx.lastHeaders = { authorization: 'SATK-1' };
  return Object.assign(ctx, overrides || {});
}

describe('H13: retained H9b фиксирует inner-курсор на здоровом pag-шаге (реальный блок из core)', () => {
  test('(а) pag-шаг с inner-токеном len=705 (next жив) → retained = wide-курсор из inner (не next)', () => {
    // e292-шаг: окно-дубль, added=0, но в inner (turns[1]) живой курсор 705 → после фикса
    // extractCursor (потолок 2000) даёт next; H9b-блок входит и wide (inner-зона) — 705.
    const ctx = retainCtx({
      lastPaginateOuter: makeOuter(makeWindowTurns(TOK_705)),
      next: 'next-соседний-токен' // wide приоритетнее next
    });
    runRetainBlock(ctx);
    expect(ctx.lastGoodWideCur).not.toBeNull();
    expect(ctx.lastGoodWideCur.cur).toBe(TOK_705);
    expect(ctx.lastGoodWideCur.conv).toBe('conv-h13');
  });

  test('(б) inner-токен len=849 (окно 101..108) → retained = 849', () => {
    const ctx = retainCtx({
      lastPaginateOuter: makeOuter(makeWindowTurns(TOK_849)),
      next: 'next-соседний-токен'
    });
    runRetainBlock(ctx);
    expect(ctx.lastGoodWideCur.cur).toBe(TOK_849);
  });

  test('(в) wide пуст (терминальный outer) → легаси-фолбэк next/lastHeadToken не сломан', () => {
    // next жив (продолжение) — retained = next
    const ctx = retainCtx({
      lastPaginateOuter: makeOuter(makeWindowTurns(null)), // кандидатов нет
      next: 'next-токен-шага',
      lastHeadToken: null
    });
    runRetainBlock(ctx);
    expect(ctx.lastGoodWideCur.cur).toBe('next-токен-шага');

    // финальный ЗДОРОВЫЙ шаг: ходы добавились (added>0), курсора нет → retained = lastHeadToken
    const ctx2 = retainCtx({
      lastPaginateOuter: makeOuter(makeWindowTurns(null)),
      added: 1,
      next: null,
      lastHeadToken: 'head-токен'
    });
    runRetainBlock(ctx2);
    expect(ctx2.lastGoodWideCur.cur).toBe('head-токен');
  });

  test('(г) сломанный шаг (lastPagStepBroken=true) → retained НЕ перезаписывается (гейт H9b жив)', () => {
    const prev = { conv: 'conv-h13', cur: 'старый-good-курсор', ts: 1 };
    const ctx = retainCtx({
      lastPagStepBroken: true,
      lastPaginateOuter: makeOuter(makeWindowTurns(TOK_705)),
      lastGoodWideCur: prev
    });
    runRetainBlock(ctx);
    expect(ctx.lastGoodWideCur).toBe(prev);
    expect(ctx.lastGoodWideCur.cur).toBe('старый-good-курсор');
  });

  test('(д) канон utils экспортирован (API рядом с probeTerminalGate/pagStepBroken)', () => {
    expect(typeof GIL.classifyOpaque).toBe('function');
    expect(typeof GIL.classifyOpaqueWide).toBe('function');
    expect(typeof GIL.extractCursor).toBe('function');
    expect(typeof GIL.extractCursorWide).toBe('function');
    const logicSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'utils', 'gemini-intercept-logic.js'), 'utf8');
    expect(logicSrc).toContain('extractCursorWide: extractCursorWide');
    expect(logicSrc).toContain('classifyOpaque: classifyOpaque');
  });
});
