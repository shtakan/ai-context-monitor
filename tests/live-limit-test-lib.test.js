'use strict';

/**
 * 2.2 / фаза 5: чистая логика живого лимит-теста gpt-6-mini.
 *
 * Проверяем то, от чего зависит корректность вывода: детерминированный
 * наполнитель, сохранность меток при нарезке, разбор ответа-пробы,
 * классификацию попытки, обновление интервала и решение по конфигу.
 * Браузер здесь не нужен и не трогается.
 */

const lib = require('../tools/live-limit-test-lib.js');

describe('live-limit-test: наполнитель', function () {
  test('детерминирован при одинаковом seed и различается при разном', function () {
    const a = lib.buildFiller({ chars: 2000, seed: 7, firstId: 'aaaaaaaa', lastId: 'bbbbbbbb' });
    const b = lib.buildFiller({ chars: 2000, seed: 7, firstId: 'aaaaaaaa', lastId: 'bbbbbbbb' });
    const c = lib.buildFiller({ chars: 2000, seed: 8, firstId: 'aaaaaaaa', lastId: 'bbbbbbbb' });
    expect(a.text).toBe(b.text);
    expect(a.text).not.toBe(c.text);
  });

  test('первая и последняя метки стоят по краям', function () {
    const f = lib.buildFiller({ chars: 3000, seed: 1, firstId: '11112222', lastId: '33334444', runId: 'R1' });
    expect(f.text.indexOf('[[NID-11112222]]')).toBe(0);
    expect(f.text.indexOf('LIMIT-TEST R1')).toBeGreaterThan(0);
    expect(f.text.endsWith('[[NID-33334444]]')).toBe(true);
    expect(f.chars).toBe(f.text.length);
  });

  test('текст не короче запрошенного (с точностью до предложения)', function () {
    const f = lib.buildFiller({ chars: 10000, seed: 3, firstId: 'aaaaaaaa', lastId: 'bbbbbbbb' });
    expect(f.chars).toBeGreaterThanOrEqual(10000);
    expect(f.chars).toBeLessThan(10400);
  });
});

describe('live-limit-test: нарезка на куски', function () {
  test('первая метка в первом куске, последняя — в последнем', function () {
    const f = lib.buildFiller({ chars: 20000, seed: 2, firstId: 'abcdabcd', lastId: 'efefefef' });
    const chunks = lib.splitIntoChunks(f.text, 3000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].indexOf('[[NID-abcdabcd]]')).toBe(0);
    expect(chunks[chunks.length - 1].endsWith('[[NID-efefefef]]')).toBe(true);
  });

  test('куски не превышают лимит', function () {
    const f = lib.buildFiller({ chars: 20000, seed: 4, firstId: 'aaaaaaaa', lastId: 'bbbbbbbb' });
    const chunks = lib.splitIntoChunks(f.text, 2500);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2500);
  });

  test('короткий текст остаётся одним куском', function () {
    expect(lib.splitIntoChunks('short text', 3000)).toEqual(['short text']);
  });
});

describe('live-limit-test: разбор пробы', function () {
  const first = '0123abcd';
  const last = '89ef4567';

  test('обе метки найдены', function () {
    const r = lib.parseProbeAnswer('FIRST=0123abcd LAST=89ef4567', first, last);
    expect(r).toEqual({ first: true, last: true, verdict: 'both', empty: false });
  });

  test('потеряна первая метка — ранний контекст вытеснен', function () {
    const r = lib.parseProbeAnswer('FIRST=NOTFOUND LAST=89ef4567', first, last);
    expect(r.verdict).toBe('first-lost');
    expect(r.first).toBe(false);
    expect(r.last).toBe(true);
  });

  test('потеряна последняя метка', function () {
    const r = lib.parseProbeAnswer('FIRST=0123abcd LAST=NOTFOUND', first, last);
    expect(r.verdict).toBe('last-lost');
  });

  test('ничего не найдено', function () {
    const r = lib.parseProbeAnswer('Не вижу идентификаторов.', first, last);
    expect(r.verdict).toBe('notfound');
    expect(r.first).toBe(false);
    expect(r.last).toBe(false);
  });

  test('метки в вопросе не считаются: ответ без них — none', function () {
    const r = lib.parseProbeAnswer('Первый идентификатор был про погоду.', first, last);
    expect(r.verdict).toBe('none');
  });
});

describe('live-limit-test: классификация попытки', function () {
  test('обе метки => окно не меньше объёма', function () {
    expect(lib.classifyTrial({ tokens: 50000, probe: { first: true, last: true } }))
      .toEqual({ kind: 'recall-ok', relation: 'ge' });
  });

  test('первая потеряна, последняя видна => окно меньше объёма', function () {
    expect(lib.classifyTrial({ tokens: 900000, probe: { first: false, last: true } }))
      .toEqual({ kind: 'early-truncated', relation: 'lt' });
  });

  test('баннер переполнения авторитетнее пробы', function () {
    expect(lib.classifyTrial({ tokens: 400000, saturation: true, probe: { first: true, last: true } }))
      .toEqual({ kind: 'saturated', relation: 'lt' });
  });

  test('отказ по длине сообщения — не окно', function () {
    expect(lib.classifyTrial({ tokens: 10000, inputRejected: true }))
      .toEqual({ kind: 'input-rejected', relation: 'unknown' });
  });

  test('без замера токенов вердикта нет', function () {
    expect(lib.classifyTrial({ tokens: 0, probe: { first: true, last: true } }))
      .toEqual({ kind: 'no-measurement', relation: 'unknown' });
  });

  test('неотправленное сообщение (rate limit) не выдаётся за переполнение', function () {
    expect(lib.classifyTrial({ tokens: 50000, sendFailed: true, probe: { first: false, last: true } }))
      .toEqual({ kind: 'send-failed', relation: 'unknown' });
  });

  test('проба не получена — вердикта нет', function () {
    expect(lib.classifyTrial({ tokens: 50000, probe: { verdict: 'skipped' } }))
      .toEqual({ kind: 'probe-missing', relation: 'unknown' });
    expect(lib.classifyTrial({ tokens: 50000, probe: { verdict: 'timeout' } }))
      .toEqual({ kind: 'probe-missing', relation: 'unknown' });
  });
});

describe('live-limit-test: интервал', function () {
  test('ge поднимает низ, lt опускает верх, unknown не двигает', function () {
    let s = lib.createState({});
    expect(Number.isFinite(s.high)).toBe(false);
    s = lib.applyTrial(s, { tokens: 100000, relation: 'ge' });
    expect(s.low).toBe(100000);
    s = lib.applyTrial(s, { tokens: 400000, relation: 'lt' });
    expect(s.high).toBe(400000);
    s = lib.applyTrial(s, { tokens: 999999, relation: 'unknown' });
    expect(s.low).toBe(100000);
    expect(s.high).toBe(400000);
  });

  test('бинарный поиск закрывается по допуску', function () {
    let s = lib.createState({ high: 1000000 });
    s = lib.applyTrial(s, { tokens: 500000, relation: 'ge' });
    s = lib.applyTrial(s, { tokens: 1000000, relation: 'lt' });
    expect(lib.nextPoint(s, 0.1)).toBe(750000);
    s = lib.applyTrial(s, { tokens: 760000, relation: 'ge' });
    expect(lib.nextPoint(s, 0.1)).toBe(880000);
    expect(lib.bracketDone(s, 0.1)).toBe(false);
    s = lib.applyTrial(s, { tokens: 900000, relation: 'lt' });
    expect(lib.bracketDone(s, 0.1)).toBe(false);
    expect(lib.nextPoint(s, 0.1)).toBe(830000);
    s = lib.applyTrial(s, { tokens: 840000, relation: 'ge' });
    expect(lib.bracketDone(s, 0.1)).toBe(true);
    expect(lib.nextPoint(s, 0.1)).toBeNull();
  });
});

describe('live-limit-test: решение', function () {
  test('не разделимо => отдельная запись не нужна', function () {
    const d = lib.decide(lib.createState({}), { separable: false });
    expect(d.code).toBe('not-separable');
    expect(d.suggestedContextLimit).toBeNull();
  });

  test('узкий интервал => измерено, рекомендация консервативная', function () {
    let s = lib.createState({ high: 1000000 });
    s = lib.applyTrial(s, { tokens: 950000, relation: 'ge' });
    s = lib.applyTrial(s, { tokens: 1000000, relation: 'lt' });
    const d = lib.decide(s, { separable: true });
    expect(d.code).toBe('measured');
    expect(d.interval).toEqual([950000, 1000000]);
    expect(d.suggestedContextLimit).toBe(950000);
  });

  test('только нижняя граница => at-least, не выдаём за точное окно', function () {
    let s = lib.createState({});
    s = lib.applyTrial(s, { tokens: 1050000, relation: 'ge' });
    const d = lib.decide(s, {});
    expect(d.code).toBe('at-least');
    expect(d.interval).toEqual([1050000, null]);
  });

  test('ни одного подтверждения => ниже границы, окно не рекомендуем', function () {
    let s = lib.createState({ high: 1050000 });
    s = lib.applyTrial(s, { tokens: 1050000, relation: 'lt' });
    const d = lib.decide(s, {});
    expect(d.code).toBe('below');
    expect(d.suggestedContextLimit).toBeNull();
  });

  test('пустые данные => unresolved', function () {
    expect(lib.decide(lib.createState({}), {}).code).toBe('unresolved');
  });
});

describe('live-limit-test: CLI-помощники', function () {
  const cli = require('../tools/live-limit-test.js');

  test('session id берётся из state-строки bsk', function () {
    expect(cli.parseSessionId('[state session=ab12cd tab=2009660510 ctx=c1]')).toBe('ab12cd');
  });

  test('separable: отдельный пункт mini', function () {
    expect(cli.inferSeparable({ options: [{ text: 'GPT-6' }, { text: 'GPT-6 Mini' }] }, [{ slug: 'gpt-6-mini' }]))
      .toBe(true);
  });

  test('separable: один GPT-6 без mini => выбрать нельзя', function () {
    expect(cli.inferSeparable({ options: [{ text: 'GPT-6' }] }, [{ slug: 'gpt-6-mini' }]))
      .toBe(false);
  });

  test('separable: два GPT-6 => по DOM не доказать', function () {
    expect(cli.inferSeparable({ options: [{ text: 'GPT-6' }, { text: 'GPT-6' }] }, [{ slug: 'gpt-6-mini' }]))
      .toBeNull();
  });

  test('separable: меню не прочиталось => неизвестно', function () {
    expect(cli.inferSeparable({ options: [] }, [{ slug: 'gpt-6-mini' }])).toBeNull();
  });
});

describe('live-limit-test: план', function () {
  test('quick — одна дешёвая точка', function () {
    expect(lib.planPoints({ mode: 'quick', point: 32000 })).toEqual([32000]);
  });

  test('confirm — одна точка на заявленном окне', function () {
    expect(lib.planPoints({ mode: 'confirm', target: 1050000 })).toEqual([1050000]);
  });

  test('bracket — начинаем с заявленного окна и дальше сужаем', function () {
    expect(lib.planPoints({ mode: 'bracket', target: 1000000 })).toEqual([1000000]);
    const s = lib.createState({ high: 1000000 });
    expect(lib.nextPoint(s, 0.1)).toBe(500000);
  });

  test('неизвестный режим — ошибка, а не молчаливый дефолт', function () {
    expect(function () { lib.planPoints({ mode: 'nope' }); }).toThrow(/unknown mode/);
  });
});
