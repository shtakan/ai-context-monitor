/**
 * BUG-H (gsa-aonly-fill): A-only ход GSA — вопрос есть в DOM, но `userText` пуст.
 *
 * Живой дефект (тред nOX6apueFdSqxc8P2ZzpkQY, 5 ходов): у ходов 3 и 5
 * `userLen=0`, вопрос виден только в эхе, в экспорте `msgs=8` вместо 10.
 *
 * Причина: `fillMissingUserText` искал вопрос ТОЛЬКО по точному каноническому
 * ключу `q||a`. У A-only хода вопроса нет, поэтому его ключ — `||a`, а у хода
 * DOM-добора тот же ход выглядит как `q||a`: точного совпадения нет и добор
 * молчит, хотя в DOM вопрос есть (`resolveUserQuestionForTurn`) и тело ответа
 * — то же самое.
 *
 * Правка (узкая, второй индекс): тело ответа — общая часть обеих форм ключа.
 *   byAnswer: turnIdentityParts(extra).a → userText; неоднозначное тело (один
 *   текст ответа на РАЗНЫЕ вопросы) не индексируется. В базе добор пробуется
 *   после промаха по точному ключу и только при пустом `userText`.
 *
 * Инварианты BUG-G сохранены: ходы не добавляются, порядок и id прежние,
 * `assistantText` байтово тот же. Ход 17 длинного треда (вопроса нет и в DOM)
 * остаётся остаточным ограничением — он здесь и пинится (T5: без DOM-вопроса
 * поведение прежнее).
 */

'use strict';

const Parser = require('./helpers/load-esm.js').loadEsmModule('utils/google-search-folwr-parser.ts');

// Реальная форма эха GSA (h3.iMqumd A-only хода), в т.ч. с блоком исходных файлов.
function echoLine(q, files) {
  const tail = files ? 'исходные файлы: ' + files + ', ' : '';
  return 'Ответ в режиме ИИ, ' + tail + 'исходный запрос: "' + q + '"';
}

// Сетевой ход без вопроса (A-only) — только тело ответа.
function aOnlyBody(id, body) {
  return { id: id, userText: null, assistantText: body };
}

// Ход DOM-добора: вопрос есть, ответ — то же тело.
function domTurn(id, q, body) {
  return { id: id, userText: q, assistantText: body };
}

// =====================================================================================
// T1: 5 ходов, A-only у 3 и 5 — вопрос добирается, состав/порядок/байты прежние
// =====================================================================================
describe('BUG-H T1: 5 ходов — A-only 3 и 5 получают вопрос, ответы байтово прежние', () => {
  const BASE = [
    { id: 't1', userText: 'Вопрос 1', assistantText: 'Ответ 1' },
    { id: 't2', userText: 'Вопрос 2', assistantText: 'Ответ 2' },
    aOnlyBody('t3', 'Ответ 3'),
    { id: 't4', userText: 'Вопрос 4', assistantText: 'Ответ 4' },
    aOnlyBody('t5', 'Ответ 5')
  ];
  const EXTRA = [
    domTurn('d1', 'Вопрос 1', 'Ответ 1'),
    domTurn('d2', 'Вопрос 2', 'Ответ 2'),
    domTurn('d3', 'Вопрос 3', 'Ответ 3'),
    domTurn('d4', 'Вопрос 4', 'Ответ 4'),
    domTurn('d5', 'Вопрос 5', 'Ответ 5')
  ];

  test('все userText заполнены, assistantText ходов 3/5 байтово прежние, порядок 1..5', () => {
    const out = Parser.fillMissingUserText(BASE, EXTRA);
    expect(out.length).toBe(5);
    expect(out.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(out.map((t) => t.userText)).toEqual([
      'Вопрос 1', 'Вопрос 2', 'Вопрос 3', 'Вопрос 4', 'Вопрос 5'
    ]);
    expect(out[2].assistantText).toBe('Ответ 3');
    expect(out[4].assistantText).toBe('Ответ 5');
    expect(out.map((t) => t.assistantText)).toEqual(BASE.map((t) => t.assistantText));
  });

  test('вход не мутируется, новых ходов не появляется', () => {
    const baseSnapshot = BASE.map((t) => ({ id: t.id, userText: t.userText, assistantText: t.assistantText }));
    const out = Parser.fillMissingUserText(BASE, EXTRA);
    expect(out.length).toBe(BASE.length);
    expect(BASE).toEqual(baseSnapshot);
    expect(out).not.toBe(BASE);
    // id ходов базы — ровно те же (никаких синтетических ходов добора).
    expect(out.map((t) => t.id)).toEqual(baseSnapshot.map((t) => t.id));
  });

  test('заполненный ход — минимальная запись {id, userText, assistantText}', () => {
    const out = Parser.fillMissingUserText(BASE, EXTRA);
    expect(Object.keys(out[2]).sort()).toEqual(['assistantText', 'id', 'userText']);
  });

  test('худой случай: один A-only ход и один DOM-ход — тоже заполняется', () => {
    const out = Parser.fillMissingUserText([aOnlyBody('t3', 'Ответ 3')], [domTurn('d3', 'Вопрос 3', 'Ответ 3')]);
    expect(out.length).toBe(1);
    expect(out[0].userText).toBe('Вопрос 3');
    expect(out[0].assistantText).toBe('Ответ 3');
  });
});

// =====================================================================================
// T2: реальная форма эха (с блоком исходных файлов) — тот же результат
// =====================================================================================
describe('BUG-H T2: реальная форма эха не мешает добору по телу ответа', () => {
  const Q3 = 'Как ускорить сборку?';
  const BODY = 'Соберите один раз и кэшируйте.';
  const ECHO = echoLine(Q3, 'data.csv') + '\n' + BODY;

  test('эхо с «исходные файлы: …» в тексте ответа — вопрос добирается', () => {
    const out = Parser.fillMissingUserText([aOnlyBody('t3', ECHO)], [domTurn('d3', Q3, ECHO)]);
    expect(out.length).toBe(1);
    expect(out[0].userText).toBe(Q3);
    expect(out[0].assistantText).toBe(ECHO);
  });

  test('эхо без блока файлов + чистое тело в DOM — добор по телу ответа', () => {
    const echo = echoLine(Q3) + ' ' + BODY;
    const out = Parser.fillMissingUserText([aOnlyBody('t3', echo)], [domTurn('d3', Q3, BODY)]);
    expect(out.length).toBe(1);
    expect(out[0].userText).toBe(Q3);
    expect(out[0].assistantText).toBe(echo);
  });

  test('тело ответа совпадает только после нормализации (регистр/пунктуация) — добор есть', () => {
    const out = Parser.fillMissingUserText(
      [aOnlyBody('t3', 'Работает: да.')],
      [domTurn('d3', 'Вопрос 3', 'работает да')]
    );
    expect(out[0].userText).toBe('Вопрос 3');
    expect(out[0].assistantText).toBe('Работает: да.');
  });
});

// =====================================================================================
// T3: неоднозначное тело — один ответ на РАЗНЫЕ вопросы не заполняется
// =====================================================================================
describe('BUG-H T3: fail-safe — неоднозначное тело ответа не даёт добора', () => {
  test('два разных вопроса на одно тело → userText остаётся пустым', () => {
    const base = [aOnlyBody('t3', 'Ответ 3')];
    const extra = [domTurn('d3a', 'Вопрос A', 'Ответ 3'), domTurn('d3b', 'Вопрос B', 'Ответ 3')];
    const out = Parser.fillMissingUserText(base, extra);
    expect(out.length).toBe(1);
    expect(out[0].userText).toBeNull();
    expect(out[0].assistantText).toBe('Ответ 3');
  });

  test('два одинаковых вопроса на одно тело — добор есть', () => {
    const base = [aOnlyBody('t3', 'Ответ 3')];
    const extra = [domTurn('d3a', 'Вопрос 3', 'Ответ 3'), domTurn('d3b', 'Вопрос 3', 'Ответ 3')];
    const out = Parser.fillMissingUserText(base, extra);
    expect(out[0].userText).toBe('Вопрос 3');
  });

  test('чужое тело ответа и пустое тело в доборе не заполняют ход', () => {
    const base = [aOnlyBody('t3', 'Ответ 3'), aOnlyBody('t4', '')];
    const extra = [domTurn('d9', 'Чужой вопрос', 'Другой ответ'), domTurn('d0', 'Пустой ответ', '')];
    const out = Parser.fillMissingUserText(base, extra);
    expect(out).toBe(base);
  });
});

// =====================================================================================
// T4: вопроса нет и в DOM (пустой extraTurns) — поведение прежнее
// =====================================================================================
describe('BUG-H T4: без DOM-вопроса поведение прежнее (A-only остаётся)', () => {
  test('пустой extraTurns → та же база, userText пуст', () => {
    const base = [aOnlyBody('t3', 'Ответ 3')];
    expect(Parser.fillMissingUserText(base, [])).toBe(base);
    expect(base[0].userText).toBeNull();
  });

  test('extraTurns без вопросов → база не меняется', () => {
    const base = [aOnlyBody('t3', 'Ответ 3')];
    const extra = [{ id: 'd3', userText: null, assistantText: 'Ответ 3' }];
    expect(Parser.fillMissingUserText(base, extra)).toBe(base);
  });

  test('непустой userText базы не перезаписывается вопросом добора', () => {
    const out = Parser.fillMissingUserText(
      [{ id: 't3', userText: 'Мой вопрос', assistantText: 'Ответ 3' }],
      [domTurn('d3', 'Другой вопрос', 'Ответ 3')]
    );
    expect(out[0].userText).toBe('Мой вопрос');
  });
});

// =====================================================================================
// T5: пины — индекс строится по телу ответа; ходы не добавляются
// =====================================================================================
describe('BUG-H T5: пины тела ответа и состава', () => {
  test('тело ответа — общая часть форм q||a и ||a (turnIdentityParts.a)', () => {
    const plain = { id: 's', userText: 'Вопрос 3', assistantText: 'Ответ 3' };
    const aOnly = { id: 'n', userText: null, assistantText: 'Ответ 3' };
    expect(Parser.turnIdentityParts(plain).a).toBe(Parser.turnIdentityParts(aOnly).a);
    expect(Parser.turnIdentityParts(plain).a.length).toBeGreaterThan(0);
    // Ключи при этом РАЗНЫЕ — именно поэтому точный поиск и промахивался.
    expect(Parser.canonicalTurnKeyOf(plain)).not.toBe(Parser.canonicalTurnKeyOf(aOnly));
  });

  test('добор опирается на тело ответа, а не на совпадение ключа', () => {
    const out = Parser.fillMissingUserText(
      [aOnlyBody('t3', 'Ответ 3')],
      [domTurn('d3', 'Вопрос 3', 'Ответ 3')]
    );
    expect(out[0].userText).toBe('Вопрос 3');
  });

  test('длина базы и последовательность id не меняются ни в одном сценарии', () => {
    const base = [
      { id: 't1', userText: 'Вопрос 1', assistantText: 'Ответ 1' },
      aOnlyBody('t2', 'Ответ 2'),
      aOnlyBody('t3', 'Ответ 3')
    ];
    const out = Parser.fillMissingUserText(base, [
      domTurn('d1', 'Вопрос 1', 'Ответ 1'),
      domTurn('d2', 'Вопрос 2', 'Ответ 2')
    ]);
    expect(out.length).toBe(3);
    expect(out.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(out[2].userText).toBeNull();
  });
});
