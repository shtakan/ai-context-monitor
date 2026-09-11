/**
 * T1 (v1.16): первый ярус как данные — same-conv-union архивных ходов и
 * авторитет архива для пола (utils/gemini-intercept-logic.js).
 *
 * Инварианты:
 *   - same-conv-union: пересечение архив×живая база схлопывается по id И по
 *     контенту (role+text) — одно и то же сообщение не удваивается, даже когда
 *     id архива и id сетевого хода разные;
 *   - архивные ходы встают ПЕРЕД хвостовым окном сети (отрицательный order),
 *     r1 не наследуется (порядок пересчитает chain-r1, как у tape-restore);
 *   - импорт идемпотентен: повторный merge того же архива даёт addedCount=0;
 *   - архивный count авторитетен для пола, но пол МОНОТОНЕН ВВЕРХ (HWM):
 *     архив меньше сохранённого пола НЕ опускает пол.
 */

const Logic = require('../../utils/gemini-intercept-logic.js');

function msgs(list) {
  return list.map((m) => ({ id: m[0], role: m[1], text: m[2] }));
}

describe('T1: same-conv-union архивных ходов (archiveMergeTurns)', () => {
  const network = msgs([
    ['t1_user', 'user', 'Что такое декогеренция?'],
    ['t1_assistant', 'assistant', 'Потеря фазовой когерентности.'],
    ['t2_user', 'user', 'А подробнее?']
  ]);

  test('архивный ход, которого нет в базе, добавляется; пересечение — дедуп по контенту', () => {
    const archive = msgs([
      ['a:0:aaaaaa', 'user', 'С чего начать?'],
      ['a:1:bbbbbb', 'assistant', 'Начни с основ.'],
      ['a:2:cccccc', 'user', 'Что такое декогеренция?'],
      ['a:3:dddddd', 'assistant', 'Потеря фазовой когерентности.']
    ]);
    const r = Logic.archiveMergeTurns(network, archive);
    expect(r.addedCount).toBe(2);
    expect(r.duplicateCount).toBe(2);
    expect(r.items.map((i) => i.text)).toEqual(['С чего начать?', 'Начни с основ.']);
  });

  test('добавленные ходы — старший сегмент: отрицательный order, r1=null, id архива', () => {
    const archive = msgs([['ARCH-1', 'user', 'Старый вопрос'], ['ARCH-2', 'assistant', 'Старый ответ']]);
    const r = Logic.archiveMergeTurns(network, archive);
    expect(r.items.length).toBe(2);
    r.items.forEach((it) => {
      expect(it.order).toBeLessThan(0);
      expect(it.r1).toBeNull();
    });
    expect(r.items[0].order).toBeLessThan(r.items[1].order);
    expect(r.items[0].id).toBe('ARCH-1');
    expect(r.items[0].turnId).toBe('ARCH-1');
    expect(r.items[0].role).toBe('user');
  });

  test('идемпотентность: повторный merge того же архива ничего не добавляет', () => {
    const archive = msgs([['ARCH-1', 'user', 'Старый вопрос'], ['t1_user', 'user', 'Что такое декогеренция?']]);
    const first = Logic.archiveMergeTurns(network, archive);
    expect(first.addedCount).toBe(1);
    const after = network.concat(first.items);
    const second = Logic.archiveMergeTurns(after, archive);
    expect(second.addedCount).toBe(0);
    expect(second.duplicateCount).toBe(2);
  });

  test('пустой текст и мусорные элементы не превращаются в ходы', () => {
    const r = Logic.archiveMergeTurns([], [
      { id: 'x', role: 'user', text: '   ' },
      null,
      { id: 'y', role: 'assistant' }
    ]);
    expect(r.addedCount).toBe(0);
  });

  test('пустая база → все архивные ходы добавляются (архив = голова истории)', () => {
    const archive = msgs([['a:0:1', 'user', 'Q1'], ['a:1:2', 'assistant', 'A1']]);
    const r = Logic.archiveMergeTurns([], archive);
    expect(r.addedCount).toBe(2);
    expect(r.items.map((i) => i.text)).toEqual(['Q1', 'A1']);
  });

  test('не массив вместо базы/архива → пустой результат, без исключения', () => {
    expect(Logic.archiveMergeTurns(null, null)).toEqual({ items: [], addedCount: 0, duplicateCount: 0 });
    expect(Logic.archiveMergeTurns(undefined, [])).toEqual({ items: [], addedCount: 0, duplicateCount: 0 });
  });

  test('дедуп не схлопывает осмысленные повторы assistant с разным текстом', () => {
    const base = msgs([['t1_assistant', 'assistant', 'Вариант 1']]);
    const r = Logic.archiveMergeTurns(base, [{ id: 'z', role: 'assistant', text: 'Вариант 2' }]);
    expect(r.addedCount).toBe(1);
  });

  test('archiveContentKey нормализует пробелы (перенос строки = пробел)', () => {
    const r = Logic.archiveMergeTurns(
      [{ id: 'n1', role: 'user', text: 'две\nстроки' }],
      [{ id: 'a1', role: 'user', text: 'две   строки' }]
    );
    expect(r.addedCount).toBe(0);
    expect(r.duplicateCount).toBe(1);
  });
});

describe('T1: архивный count авторитетен для пола (archiveFloorRecord)', () => {
  test('архива нет, пола нет → писать нечего', () => {
    expect(Logic.archiveFloorRecord(null, 0, 0)).toBeNull();
    expect(Logic.archiveFloorRecord(undefined, undefined, undefined)).toBeNull();
  });

  test('пола нет, но архив непустой → пол = архивный count/textLen', () => {
    expect(Logic.archiveFloorRecord(null, 12, 3456)).toEqual({ count: 12, effectiveLen: 3456, source: 'archive' });
  });

  test('архив выше сохранённого пола → пол поднимается до архива', () => {
    expect(Logic.archiveFloorRecord({ count: 8, effectiveLen: 900 }, 12, 3456))
      .toEqual({ count: 12, effectiveLen: 3456, source: 'archive' });
  });

  test('архив НИЖЕ сохранённого пола → HWM: пол не опускается (null)', () => {
    expect(Logic.archiveFloorRecord({ count: 30, effectiveLen: 4000 }, 12, 500)).toBeNull();
  });

  test('архив равен полу → менять нечего (null)', () => {
    expect(Logic.archiveFloorRecord({ count: 12, effectiveLen: 3456 }, 12, 3456)).toBeNull();
  });

  test('равный count, но больший textLen → пол обновляется по длине', () => {
    expect(Logic.archiveFloorRecord({ count: 12, effectiveLen: 1000 }, 12, 3456))
      .toEqual({ count: 12, effectiveLen: 3456, source: 'archive' });
  });
});

describe('T1: связка с реальным saveFloor (монотонность пола сохраняется)', () => {
  function fakeStorage() {
    const map = {};
    return {
      map: map,
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); }
    };
  }

  test('архивный пол пишется, живая база меньше — пол не проседает', () => {
    const st = fakeStorage();
    const PV = 'v-test';

    // 1) архив импортирован: пол = архивный count (авторитет)
    const arch = Logic.archiveFloorRecord(Logic.loadFloor('conv1', PV, st), 50, 50000);
    expect(arch).toEqual({ count: 50, effectiveLen: 50000, source: 'archive' });
    Logic.saveFloor('conv1', PV, arch.count, arch.effectiveLen, st);
    expect(Logic.loadFloor('conv1', PV, st)).toMatchObject({ count: 50, effectiveLen: 50000 });

    // 2) живая сессия собрала меньше (усечённое окно) — пол держит HWM
    Logic.saveFloor('conv1', PV, 30, 30000, st);
    expect(Logic.loadFloor('conv1', PV, st)).toMatchObject({ count: 50, effectiveLen: 50000 });

    // 3) повторный импорт того же архива → менять нечего (идемпотентность)
    expect(Logic.archiveFloorRecord(Logic.loadFloor('conv1', PV, st), 50, 50000)).toBeNull();

    // 4) живая сессия собрала больше архива → пол растёт
    Logic.saveFloor('conv1', PV, 80, 80000, st);
    expect(Logic.loadFloor('conv1', PV, st)).toMatchObject({ count: 80, effectiveLen: 80000 });
  });

  test('чужой convId не смешивается: пол другого чата не тронут', () => {
    const st = fakeStorage();
    const PV = 'v-test';
    Logic.saveFloor('conv1', PV, 50, 50000, st);
    Logic.saveFloor('conv2', PV, 5, 5000, st);
    expect(Logic.loadFloor('conv2', PV, st)).toMatchObject({ count: 5, effectiveLen: 5000 });
    expect(Logic.loadFloor('conv1', PV, st)).toMatchObject({ count: 50, effectiveLen: 50000 });
  });
});
