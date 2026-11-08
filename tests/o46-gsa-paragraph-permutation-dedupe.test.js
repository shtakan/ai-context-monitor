/**
 * O-46 (регрессия SPA-возврата): ТЕЛО ОДНОГО ХОДА приходит с ДРУГИМ ПОРЯДКОМ АБЗАЦЕВ.
 *
 * ЖИВОЙ ДЕФЕКТ (2026-11-07, тред 8bTpaveuJtWckdUP46iumAo): при возврате на тестовый чат
 * пассивный снимок /async/folif приносил те же 12 ходов, но у двух из них абзацы ответа шли
 * в другом порядке (source-snippet-пункт в снимке — 3-м, в кэше треда — 8-м). Нормализованные
 * тела были одинаковой ДЛИНЫ (1865 и 1300 знаков) и с одинаковым МНОЖЕСТВОМ абзацев, но
 * порядко-зависимый канонический ключ и префикс-правило (общий префикс 429/1865 = 0.19)
 * их не схлопывали. mergeTurns(isFull=false) добавлял переставленный ход как новый:
 * 12 → 14 ходов, 24 → 28 сообщений, textLen 34753 → 38902, бейдж 8.4% → 9.3%, и каждый
 * следующий SPA-возврат повторял те же 2 хода (16 ходов, 10.3%).
 *
 * Правило, которое пинится здесь: при ОДНОМ вопросе тела эквивалентны, если совпадает
 * мультимножество их абзацев (текст абзацев без учёта порядка). Исполняются реальные байты
 * парсера (конвенция сьюта), ключи и результаты слияния проверяются как в живом коде.
 */

'use strict';

const Parser = require('./helpers/load-esm.js').loadEsmModule('utils/google-search-folwr-parser.ts');

// Разделитель абзацев без escape-последовательностей в исходнике теста.
const P = String.fromCharCode(10, 10);

const QUESTION = 'Почему DeepSeek упал 3 ноября 2026 года и когда ждать компенсацию?';
const P1 = '3 ноября 2026 года произошёл кратковременный сбой в работе DeepSeek.';
const P2 = 'Официальный статус подтверждает частичный сбой и восстановление сервиса.';
const P3 = '- SambaNova Developer Community: Significant latency and elevated error rates.';
const P4 = 'Я продолжаю следить за официальными новостями и сообщу, когда появится ответ.';

// Форма кэша треда: source-snippet-пункт в конце списка (порядок обычного стрима).
const BASE_BODY = [P1, P2, P4, P3].join(P);
// Форма снимка /async/folif: тот же текст, но source-snippet-пункт переставлен выше.
const SNAPSHOT_BODY = [P1, P3, P2, P4].join(P);

const BASE_TURN = { id: 'G8IKA_6o', userText: QUESTION, assistantText: BASE_BODY };
const SNAPSHOT_TURN = { id: 'r1rT2c_1e', userText: QUESTION, assistantText: SNAPSHOT_BODY };
// Обёрточная форма (DOM/эмит): вопрос живёт внутри текста ответа, userText пуст.
const WRAPPED_TURN = {
  id: 'wrap-1',
  userText: null,
  assistantText: 'Ответ в режиме ИИ, исходный запрос: "' + QUESTION + '" ' + SNAPSHOT_BODY
};

function bodiesDifferOnlyInOrder(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/\u00a0/g, ' ')
    .replace(/[^a-zа-яё0-9]/g, '');
  return norm(a).length === norm(b).length && norm(a) !== norm(b);
}

describe('O-46: один ход — тело с переставленными абзацами', () => {
  test('D0: данные пинят живой дефект — длины нормализованных тел равны, порядок разный', () => {
    expect(bodiesDifferOnlyInOrder(BASE_BODY, SNAPSHOT_BODY)).toBe(true);
    // префикс-правило (O-32) такой ход НЕ ловит: общий префикс много меньше 80%
    expect(Parser.bodiesPrefixCompatible(
      Parser.turnIdentityParts(BASE_TURN).a,
      Parser.turnIdentityParts(SNAPSHOT_TURN).a
    )).toBe(false);
    // точные канонические ключи различаются
    expect(Parser.canonicalTurnKeyOf(BASE_TURN))
      .not.toBe(Parser.canonicalTurnKeyOf(SNAPSHOT_TURN));
  });

  test('D1: dedupeTurns (путь mergeTurns → dedupeTurnsForCache) оставляет ОДИН ход', () => {
    const out = Parser.dedupeTurns([BASE_TURN, SNAPSHOT_TURN]);
    expect(out).toHaveLength(1);
    // остаётся первая (кэшевая) форма: порядок абзацев базы не сдвигается
    expect(out[0].assistantText).toBe(BASE_BODY);
    expect(out[0].id).toBe('G8IKA_6o');
  });

  test('D1: обратный порядок тоже схлопывает, первая форма сохраняется', () => {
    const out = Parser.dedupeTurns([SNAPSHOT_TURN, BASE_TURN]);
    expect(out).toHaveLength(1);
    expect(out[0].assistantText).toBe(SNAPSHOT_BODY);
    expect(out[0].id).toBe('r1rT2c_1e');
  });

  test('D1: mergeTurnsById/Monotone/ByKey (applyTurns/DOM-добор) — тоже один ход', () => {
    for (const fn of ['mergeTurnsById', 'mergeTurnsMonotone', 'mergeTurnsByKey']) {
      expect(Parser[fn]([BASE_TURN], [SNAPSHOT_TURN])).toHaveLength(1);
      expect(Parser[fn]([SNAPSHOT_TURN], [BASE_TURN])).toHaveLength(1);
    }
  });

  test('D1: обёрточная форма вопроса против сетевой — тот же ход', () => {
    const out = Parser.dedupeTurns([BASE_TURN, WRAPPED_TURN]);
    expect(out).toHaveLength(1);
    const merged = Parser.mergeTurnsById([BASE_TURN], [WRAPPED_TURN]);
    expect(merged).toHaveLength(1);
  });

  test('D2: повторный SPA-возврат не накапливает копии (12 ходов остаются 12)', () => {
    // база из 12 ходов, где два хода приходят в переставленной форме при каждом возврате
    const base = [];
    for (let i = 0; i < 12; i++) {
      base.push({ id: 'base-' + i, userText: 'Q' + i, assistantText: 'A' + i + P + 'B' + i });
    }
    const snap = base.map((t) => ({ ...t }));
    // два хода с переставленными абзацами
    snap[3] = { id: 'snap-3', userText: 'Q3', assistantText: ['B3', 'A3'].join(P) };
    let turns = Parser.mergeTurnsById(base, snap);
    expect(turns).toHaveLength(12);
    // ещё один возврат тем же снимком — снова 12 (без роста)
    turns = Parser.mergeTurnsById(turns, snap);
    expect(turns).toHaveLength(12);
    // и финальная чистка кэша не находит дублей
    expect(Parser.dedupeTurns(turns)).toHaveLength(12);
  });

  test('D3: защита — изменённый абзац при том же вопросе остаётся ОТДЕЛЬНЫМ ходом', () => {
    const changed = {
      id: 'other-1',
      userText: QUESTION,
      assistantText: [P1, '- Иной источник: совсем другие данные о сбое.', P2, P4].join(P)
    };
    expect(Parser.dedupeTurns([BASE_TURN, changed])).toHaveLength(2);
    expect(Parser.mergeTurnsById([BASE_TURN], [changed])).toHaveLength(2);
  });

  test('D3: защита — тот же набор абзацев при ДРУГОМ вопросе остаётся отдельным ходом', () => {
    const otherQuestion = { id: 'other-2', userText: 'Другой вопрос про погоду', assistantText: SNAPSHOT_BODY };
    expect(Parser.dedupeTurns([BASE_TURN, otherQuestion])).toHaveLength(2);
    expect(Parser.mergeTurnsById([BASE_TURN], [otherQuestion])).toHaveLength(2);
  });
});
