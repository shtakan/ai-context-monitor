/**
 * Тесты чистой логики перехватчика Gemini (utils/gemini-intercept-logic.js).
 * Покрывают два класса багов:
 *   (а) пол (floor): ключ включает PARSER_VERSION — при смене версии сохранённое
 *       игнорируется и перезаписывается; пол не применяется при baseComplete=true.
 *   (б) полная пересборка vf5: пейлоад с курсором → merge без сброса,
 *       без курсора → rebuild.
 */

const {
  floorStorageKey,
  loadFloor,
  saveFloor,
  resolveFloor,
  shouldSaveFloor,
  shouldFullRebuild,
  tapeStorageKey,
  tapeVersionOf,
  shouldAcceptTape,
  orderPages,
  reverseRawTurnPage,
  orderPageByR1,
  orderRestoredTape,
  countR1Inversions,
  orderByArrival,
  orderByR1Chain,
  mergeRestoredTurns,
  isProtobufSkeleton,
  effectiveReachedStart,
  shouldMergeRestoredTurns,
  sanitizeFinalMessages,
  newDomReadiness,
  advanceReadiness,
  shouldRetryAutoscroll,
  shouldPollVf5,
  diagnoseFloorAbsence
} = require('../../utils/gemini-intercept-logic');

function makeStorage() {
  const map = {};
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    _map: map
  };
}

describe('Gemini floor (пол) — версионирование по PARSER_VERSION', () => {
  it('ключ пола включает PARSER_VERSION', () => {
    expect(floorStorageKey('conv_1', 'g2')).toBe('ai-cm-gemini-floor-g2-conv_1');
    expect(floorStorageKey('conv_1', 'g2')).not.toBe(floorStorageKey('conv_1', 'g1'));
  });

  it('пол сбрасывается при смене PARSER_VERSION: сохранённое игнорируется и перезаписывается', () => {
    const storage = makeStorage();

    // сохраняем «грязный» исторический пол под старой версией
    saveFloor('conv_1', 'g1', 98, 1320505, storage);
    expect(loadFloor('conv_1', 'g1', storage)).toEqual(
      expect.objectContaining({ count: 98, effectiveLen: 1320505 })
    );

    // под новой версией старый пол не виден → сброшен
    expect(loadFloor('conv_1', 'g2', storage)).toBeNull();
  });

  it('сохранённый пол другой версии перезаписывается новой записью', () => {
    const storage = makeStorage();

    // старый пол записан напрямую в ключ новой версии, но с чужой version
    storage.setItem(
      floorStorageKey('conv_1', 'g2'),
      JSON.stringify({ count: 98, effectiveLen: 1320505, ts: 1, version: 'g1' })
    );
    // из-за несовпадения версии он игнорируется
    expect(loadFloor('conv_1', 'g2', storage)).toBeNull();

    // новая запись должна перезаписать ключ (существующий пол = null)
    saveFloor('conv_1', 'g2', 20, 250000, storage);
    const f = loadFloor('conv_1', 'g2', storage);
    expect(f).toEqual(expect.objectContaining({ count: 20, effectiveLen: 250000, version: 'g2' }));
  });
});

describe('Gemini floor — применение только при неполной загрузке', () => {
  const savedFloor = { count: 98, effectiveLen: 1320505 };

  it('не применяется при baseComplete=true: effectiveLen = фактический textLen', () => {
    const r = resolveFloor(250000, 20, savedFloor, true);
    expect(r.effectiveLen).toBe(250000);
    expect(r.floorApplied).toBe(false);
    expect(r.floorValue).toBe(0);
  });

  it('применяется при baseComplete=false как защита от просадки', () => {
    const r = resolveFloor(250000, 20, savedFloor, false);
    expect(r.floorApplied).toBe(true);
    expect(r.floorValue).toBe(1320505);
    expect(r.effectiveLen).toBe(1320505);
  });

  it('не применяется при baseComplete=false, если сохранённый пол не выше фактического', () => {
    const lowFloor = { count: 5, effectiveLen: 1000 };
    const r = resolveFloor(250000, 20, lowFloor, false);
    expect(r.floorApplied).toBe(false);
    expect(r.effectiveLen).toBe(250000);
  });

  it('пол обновляется только когда база полная и пагинация дошла до начала', () => {
    expect(shouldSaveFloor(true, true)).toBe(true);
    expect(shouldSaveFloor(true, false)).toBe(false);
    expect(shouldSaveFloor(false, true)).toBe(false);
    expect(shouldSaveFloor(false, false)).toBe(false);
  });
});

describe('Gemini rebuild из vf5 — курсор продолжения против полной истории', () => {
  it('пейлоад с курсором → merge без сброса (нет полной пересборки)', () => {
    expect(shouldFullRebuild({ fromVirtualF5: true, wasFull: true, hasCursor: true })).toBe(false);
  });

  it('пейлоад без курсора → rebuild (полная пересборка)', () => {
    expect(shouldFullRebuild({ fromVirtualF5: true, wasFull: true, hasCursor: false })).toBe(true);
  });

  it('пересборка только для vf5 при уже полной базе', () => {
    expect(shouldFullRebuild({ fromVirtualF5: false, wasFull: true, hasCursor: false })).toBe(false);
    expect(shouldFullRebuild({ fromVirtualF5: true, wasFull: false, hasCursor: false })).toBe(false);
  });
});

describe('Gemini глобальный порядок страниц пагинации', () => {
  it('две синтетические страницы «новые сверху» → финальная хронология, messages[0]=старый ход', () => {
    // passive (свежая страница) приходит первой, pag (старшая) — последней.
    const pages = [
      { mode: 'fresh', turns: [{ id: 't3', text: 'третий', role: 'assistant' }, { id: 't4', text: 'четвёртый', role: 'assistant' }] },
      { mode: 'older', turns: [{ id: 't1', text: 'первый', role: 'user' }, { id: 't2', text: 'второй', role: 'assistant' }] }
    ];
    const ordered = orderPages(pages);
    expect(ordered.map(x => x.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(ordered[0].text).toBe('первый');
  });

  it('несколько старших страниц: каждый новый prepend вставляется перед предыдущими', () => {
    const pages = [
      { mode: 'fresh', turns: [{ id: 'a5', text: '5', role: 'assistant' }] },
      { mode: 'older', turns: [{ id: 'a3', text: '3', role: 'user' }, { id: 'a4', text: '4', role: 'assistant' }] },
      { mode: 'older', turns: [{ id: 'a1', text: '1', role: 'user' }, { id: 'a2', text: '2', role: 'assistant' }] }
    ];
    const ordered = orderPages(pages);
    expect(ordered.map(x => x.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('дедупликация по id: свежая встреча побеждает', () => {
    const pages = [
      { mode: 'fresh', turns: [{ id: 'x1', text: 'свежий', role: 'user' }] },
      { mode: 'older', turns: [{ id: 'x1', text: 'старший-дубль', role: 'user' }, { id: 'x2', text: 'х2', role: 'assistant' }] }
    ];
    const ordered = orderPages(pages);
    expect(ordered.map(x => x.id)).toEqual(['x2', 'x1']);
    expect(ordered[1].text).toBe('свежий');
  });

  it('r1-самопроверка (2 страницы по 3 хода): r1=сосед НОВЕЕ, начало=самый старый, конец=самый новый', () => {
    // r1 — указатель на соседний БОЛЕЕ НОВЫЙ ход (подтверждено логами idmap).
    // Старшая страница (t1..t3), свежая страница (t4..t6); прибытие в любом порядке.
    const pages = [
      { mode: 'fresh', turns: [
        { id: 't4', text: 'ход4', role: 'assistant', r1: 't5' },
        { id: 't5', text: 'ход5', role: 'assistant', r1: 't6' },
        { id: 't6', text: 'ход6', role: 'assistant', r1: null }
      ] },
      { mode: 'older', turns: [
        { id: 't1', text: 'ход1', role: 'user', r1: 't2' },
        { id: 't2', text: 'ход2', role: 'assistant', r1: 't3' },
        { id: 't3', text: 'ход3', role: 'assistant', r1: 't4' }
      ] }
    ];
    const ordered = orderPages(pages);
    expect(ordered.map(x => x.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    // самопроверка: для каждой соседней пары older.r1 === newer.id
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(ordered[i].r1).toBe(ordered[i + 1].id);
    }
    // краевые ходы
    expect(ordered[0].id).toBe('t1'); // самый старый
    expect(ordered[ordered.length - 1].id).toBe('t6'); // самый новый
    expect(ordered[ordered.length - 1].r1).toBeNull(); // самый новый ни на кого не ссылается
  });
});

describe('Gemini разворот сырой страницы (reverseRawTurnPage)', () => {
  it('страница raw новые→старые → финальный порядок хронологический, user перед assistant', () => {
    // raw в ответе идёт «новые→старые». внутри t2 (последний по времени) user+assistant.
    const rawMsgs = [
      { id: 't2_assistant', turnId: 't2', role: 'assistant' },
      { id: 't2_user', turnId: 't2', role: 'user' },
      { id: 't1_assistant', turnId: 't1', role: 'assistant' },
      { id: 't1_user', turnId: 't1', role: 'user' }
    ];
    const out = reverseRawTurnPage(rawMsgs);
    expect(out.map(x => x.id)).toEqual(['t1_user', 't1_assistant', 't2_user', 't2_assistant']);
    // user перед assistant внутри каждого хода
    expect(out[0].id).toBe('t1_user');
    expect(out[2].id).toBe('t2_user');
  });
});

describe('Gemini внутристраничный r1-порядок (orderPageByR1)', () => {
  it('(а) страница с r1-цепочкой → old→new, user перед assistant', () => {
    // r1 = сосед СТАРШЕ. newest = t3 (id не встречается как r1 в странице).
    // цепочка t3→t2→t1 (newest→oldest) → разворот t1,t2,t3.
    const page = [
      { id: 't3_assistant', turnId: 't3', r1: 't2', role: 'assistant' },
      { id: 't2_assistant', turnId: 't2', r1: 't1', role: 'assistant' },
      { id: 't1_user', turnId: 't1', r1: null, role: 'user' },
      { id: 't1_assistant', turnId: 't1', r1: null, role: 'assistant' }
    ];
    const r = orderPageByR1(page);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['t1_user', 't1_assistant', 't2_assistant', 't3_assistant']);
  });

  it('(а) restored-лента [новые->старые] с r1 → [старые->новые], messages[0]=user с r1=null', () => {
    // r1 указывает на ПРЕДЫДУЩИЙ (более старый) ход; у корня r1=null (первая пара user+assistant).
    // Лента new→old: t3→t2, t2→t1, t1(r1=null). Внутри хода assistant-first.
    const tape = [
      { id: 't3_assistant', role: 'assistant', r1: 't2' },
      { id: 't3_user', role: 'user', r1: 't2' },
      { id: 't2_assistant', role: 'assistant', r1: 't1' },
      { id: 't2_user', role: 'user', r1: 't1' },
      { id: 't1_assistant', role: 'assistant', r1: null },
      { id: 't1_user', role: 'user', r1: null }
    ];
    expect(orderRestoredTape(tape)).toEqual([
      't1_user', 't1_assistant', 't2_user', 't2_assistant', 't3_user', 't3_assistant'
    ]);
    // messages[0] = user с r1=null (первый промт)
    expect(orderRestoredTape(tape)[0]).toBe('t1_user');
  });

  it('(б) restored-блок prepend + разворот (orderRestoredTape)', () => {
    // лента хранится new→old
    const tape = [
      { id: 'r3', role: 'assistant' },
      { id: 'r2', role: 'assistant' },
      { id: 'r1', role: 'user' }
    ];
    expect(orderRestoredTape(tape)).toEqual(['r1', 'r2', 'r3']);
  });

  it('(в) инвариант inversions=0 (r1=старше идёт раньше)', () => {
    // финальный порядок old→new: t1(старый) → t2 → t3(новый). r1 указывает на старшего.
    const items = [
      { id: 't1_user', turnId: 't1', r1: null },
      { id: 't2_assistant', turnId: 't2', r1: 't1' },
      { id: 't3_assistant', turnId: 't3', r1: 't2' }
    ];
    expect(countR1Inversions(items)).toBe(0);

    // перевёрнутый порядок → 2 инверсии (t3 раньше t2; t2 раньше t1)
    const rev = [items[2], items[1], items[0]];
    expect(countR1Inversions(rev)).toBe(2);
  });
});

describe('Gemini порядок по прибытию страниц (orderByArrival)', () => {
  it('3 страницы в порядке прибытия → финальный порядок = порядок прибытия', () => {
    // passive (свежая) → pag (старшая) → vf5 (свежая). order отражает прибытие.
    const items = [
      { id: 'p1_user', turnId: 'p1', r1: null, order: 0, role: 'user' },
      { id: 'p2_assistant', turnId: 'p2', r1: null, order: 1, role: 'assistant' },
      { id: 'g1_user', turnId: 'g1', r1: null, order: 2, role: 'user' },
      { id: 'g2_assistant', turnId: 'g2', r1: null, order: 3, role: 'assistant' },
      { id: 'v1_user', turnId: 'v1', r1: null, order: 4, role: 'user' },
      { id: 'v2_assistant', turnId: 'v2', r1: null, order: 5, role: 'assistant' }
    ];
    const r = orderByArrival(items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['p1_user', 'p2_assistant', 'g1_user', 'g2_assistant', 'v1_user', 'v2_assistant']);
  });

  it('внутри хода user перед assistant (порядок сообщений стабилен)', () => {
    const items = [
      { id: 't1_assistant', turnId: 't1', r1: null, order: 0, role: 'assistant' },
      { id: 't1_user', turnId: 't1', r1: null, order: 0, role: 'user' }
    ];
    const r = orderByArrival(items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['t1_user', 't1_assistant']);
  });

  it('дубликат order у разных turn\'ов → ok=false (детерминированность нарушена)', () => {
    const items = [
      { id: 'a_user', turnId: 'a', r1: null, order: 1, role: 'user' },
      { id: 'b_assistant', turnId: 'b', r1: null, order: 1, role: 'assistant' }
    ];
    const r = orderByArrival(items);
    expect(r.ok).toBe(false);
  });
});

describe('Gemini фикс первого промта: reachedStart + protobuf-страница', () => {
  it('(а) reachedStart=false → restored-лента мерджится НЕЗАВИСИМО от baseComplete/historyFullByQuiet', () => {
    expect(shouldMergeRestoredTurns(false)).toBe(true);
    expect(shouldMergeRestoredTurns(undefined)).toBe(true);
    expect(shouldMergeRestoredTurns(true)).toBe(false);
  });

  it('protobuf-скелет (числа/массивы без строк) распознаётся', () => {
    // buildJsonSkeleton сериализует непарсящуюся protobuf-страницу как
    // {arr:N, items:[числа/массивы]} — без единой строки текста хода.
    const skel = { arr: 2, items: [ { arr: 3, items: [1, 2, 3] }, 0, null ] };
    expect(isProtobufSkeleton(skel)).toBe(true);
  });

  it('НЕ protobuf-скелет (есть строка-текст) не распознаётся', () => {
    const skel = { arr: 1, items: [{ arr: 2, items: ['s12: какой-то текст'] }] };
    expect(isProtobufSkeleton(skel)).toBe(false);
  });

  it('effectiveReachedStart=false когда последний шаг вернул 0 ходов', () => {
    expect(effectiveReachedStart(true, 0, null)).toBe(false);
  });

  it('effectiveReachedStart=false когда сохранён protobuf-скелет (даже при added>0)', () => {
    const skel = { arr: 2, items: [{ arr: 3, items: [1, 2, 3] }, null] };
    expect(effectiveReachedStart(true, 1, skel)).toBe(false);
  });

  it('effectiveReachedStart=true только при флаге + добавленных ходах без protobuf-скелета', () => {
    expect(effectiveReachedStart(true, 3, null)).toBe(true);
    expect(effectiveReachedStart(false, 3, null)).toBe(false);
  });
});

describe('Gemini санация и дедуп финального messages (sanitizeFinalMessages)', () => {
  function helpers() {
    const parser = require('../../utils/gemini-batchexecute-parser');
    return {
      isThinkingAssistant: function (s) { return parser.isThinkingAssistant(s); },
      stripLeadingThinking: function (s) { return parser.stripLeadingThinking(s); }
    };
  }

  it('(в) чисто английское мышление полностью вырезается из messages', () => {
    const h = helpers();
    const input = [
      { role: 'user', text: 'Привет' },
      { role: 'assistant', text: 'Assessing the Core Task' }, // чистый thinking
      { role: 'assistant', text: "I'm now zeroing in on the structure." }, // чистый thinking
      { role: 'assistant', text: 'Вот ответ.' }
    ];
    const out = sanitizeFinalMessages(input, h);
    expect(out.map(m => m.text)).toEqual(['Привет', 'Вот ответ.']);
    expect(out.every(m => !(/Assessing|zeroing in/).test(m.text))).toBe(true);
  });

  it('смешанный блок срезается до первого кириллического символа', () => {
    const h = helpers();
    const input = [
      { role: 'assistant', text: 'Assessing the Core Task\nВот итоговый ответ.' }
    ];
    const out = sanitizeFinalMessages(input, h);
    expect(out[0].text).toBe('Вот итоговый ответ.');
  });

  it('(б) дубликаты assistant подряд по text или id — на выходе только уникальные', () => {
    const input = [
      { role: 'user', text: 'Вопрос', id: 't1_user' },
      { role: 'assistant', text: 'Ответ', id: 't1_assistant' },
      { role: 'assistant', text: 'Ответ', id: 't1_assistant' }, // дубль по text+id
      { role: 'assistant', text: 'Ответ 2', id: 't2_assistant' },
      { role: 'assistant', text: 'Ответ 2', id: 't3_assistant' } // дубль по text (разные id)
    ];
    const out = sanitizeFinalMessages(input);
    expect(out.map(m => m.text)).toEqual(['Вопрос', 'Ответ', 'Ответ 2']);
    expect(out.length).toBe(3);
  });
});

describe('Gemini fallback по связному списку r1 (orderByR1Chain)', () => {
  // r1 = id СТАРШЕГО соседа. Используется ТОЛЬКО как fallback при разрывах прибытия.
  it('цепочка сквозь границы страниц: head найдётся (самый новый), порядок хронологический', () => {
    // 6 ходов: t6(новый) → t5 → ... → t1(старый). r1 указывает на старшего.
    const items = [
      { id: 't3_assistant', turnId: 't3', r1: 't2' },
      { id: 't6_assistant', turnId: 't6', r1: 't5' },
      { id: 't1_user', turnId: 't1', r1: null },
      { id: 't4_assistant', turnId: 't4', r1: 't3' },
      { id: 't2_assistant', turnId: 't2', r1: 't1' },
      { id: 't5_assistant', turnId: 't5', r1: 't4' }
    ];
    const r = orderByR1Chain(items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['t1_user', 't2_assistant', 't3_assistant', 't4_assistant', 't5_assistant', 't6_assistant']);
  });

  it('нет head (все ходы — r1-цели, цикл) → ok=false, фолбэк не падает', () => {
    const items = [
      { id: 'a_user', turnId: 'a', r1: 'b' },
      { id: 'b_assistant', turnId: 'b', r1: 'a' }
    ];
    const r = orderByR1Chain(items);
    expect(r.ok).toBe(false);
    expect(r.ids).toEqual([]);
  });
});

describe('Gemini restored-лента: версионирование, авторитет по id, порядок по r1', () => {
  it('ключ ленты включает версию парсера', () => {
    expect(tapeStorageKey('conv_1', 'g3')).toBe('ai-cm-gemini-tape-g3-conv_1');
    expect(tapeStorageKey('conv_1', 'g3')).not.toBe(tapeStorageKey('conv_1', 'g2'));
    expect(tapeVersionOf({ meta: { version: 'g3' } })).toBe('g3');
    expect(tapeVersionOf({})).toBe('');
  });

  it('(а) протухшая лента: версия записи ≠ текущей → игнорируется без миграции', () => {
    expect(shouldAcceptTape({ meta: { version: 'g2' } }, 'g3')).toBe(false);
    expect(shouldAcceptTape({ meta: {} }, 'g3')).toBe(false);
    expect(shouldAcceptTape(null, 'g3')).toBe(false);
    expect(shouldAcceptTape({ meta: { version: 'g3' } }, 'g3')).toBe(true);
    expect(shouldAcceptTape({ meta: { version: 'g3' } }, '')).toBe(false);
  });

  it('(а) сеть авторитетна по id: сетевой ход перезаписывает restored того же id (текст/роль), missing только для отсутствующих', () => {
    const network = [
      { id: 'r_5341_user', turnId: 'r_5341', r1: null, order: 0, role: 'user', text: 'сетевой-вопрос' },
      { id: 'r_5341_assistant', turnId: 'r_5341', r1: null, order: 1, role: 'assistant', text: 'сетевой-ответ' },
      { id: 'r_5342_assistant', turnId: 'r_5342', r1: 'r_5341', order: 2, role: 'assistant', text: 'сетевой-ответ-2' }
    ];
    const restored = [
      { id: 'r_5341_user', text: 'RU_ANSWER + EN_THINKING + RU_ANSWER', role: 'user', r1: null },
      { id: 'r_5341_assistant', text: 'STALE-DUP', role: 'assistant', r1: null },
      { id: 'r_5342_assistant', text: 'STALE-DUP-2', role: 'assistant', r1: 'r_5341' },
      { id: 'r_old_missing_user', text: 'недостающий промт', role: 'user', r1: null }
    ];
    const r = mergeRestoredTurns(network, restored);
    expect(r.missingCount).toBe(1);
    const ids = r.items.map(x => x.id);
    expect(ids).toContain('r_5341_user');
    expect(ids).toContain('r_5341_assistant');
    expect(ids).toContain('r_5342_assistant');
    expect(ids).toContain('r_old_missing_user');
    // сетевой текст не перетёрт restored-дублем
    expect(r.items.find(x => x.id === 'r_5341_user').text).toBe('сетевой-вопрос');
    expect(r.items.find(x => x.id === 'r_5342_assistant').text).toBe('сетевой-ответ-2');
  });

  it('(а) финальный порядок по r1-цепочке объединения: inversions=0, голова r_5341 (user перед assistant)', () => {
    const items = [
      { id: 'r_5341_user', turnId: 'r_5341', r1: null, order: 0, role: 'user', text: 'рецепт-user' },
      { id: 'r_5341_assistant', turnId: 'r_5341', r1: null, order: 1, role: 'assistant', text: 'рецепт-assistant' },
      { id: 'r_5342_assistant', turnId: 'r_5342', r1: 'r_5341', order: 2, role: 'assistant', text: 'ответ-2' },
      { id: 'r_5343_assistant', turnId: 'r_5343', r1: 'r_5342', order: 3, role: 'assistant', text: 'ответ-3' }
    ];
    const r = orderByR1Chain(items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['r_5341_user', 'r_5341_assistant', 'r_5342_assistant', 'r_5343_assistant']);
    expect(r.ids[0]).toBe('r_5341_user'); // голова = r_5341, user первым
    const invItems = r.ids.map(id => items.find(x => x.id === id));
    expect(countR1Inversions(invItems)).toBe(0);
  });

  it('(б) protobuf-хвост (в сети нет r1=null) + лента текущей версии → мерджится только недостающее, порядок по r1, inversions=0', () => {
    // Сеть отдала r1-цепочку без корня (r_5341 отсутствует) — protobuf-хвост; лента версии g3.
    expect(shouldAcceptTape({ meta: { version: 'g3' } }, 'g3')).toBe(true);
    expect(shouldMergeRestoredTurns(false)).toBe(true);

    const network = [
      { id: 'r_5343_assistant', turnId: 'r_5343', r1: 'r_5342', order: 0, role: 'assistant', text: 'ответ-3' },
      { id: 'r_5342_assistant', turnId: 'r_5342', r1: 'r_5341', order: 1, role: 'assistant', text: 'ответ-2' }
    ];
    const restored = [
      { id: 'r_5342_assistant', text: 'ДУБЛЬ ЛЕНТЫ', role: 'assistant', r1: 'r_5341' },      // сеть авторитетна
      { id: 'r_5341_user', text: 'недостающий промт', role: 'user', r1: null },               // missing
      { id: 'r_5341_assistant', text: 'недостающий ответ', role: 'assistant', r1: null }       // missing
    ];
    const merged = mergeRestoredTurns(network, restored);
    expect(merged.missingCount).toBe(2);
    // r_5342_assistant остался от СЕТИ — restored-дубль не должен его перетереть
    expect(merged.items.find(x => x.id === 'r_5342_assistant').text).toBe('ответ-2');

    const r = orderByR1Chain(merged.items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['r_5341_user', 'r_5341_assistant', 'r_5342_assistant', 'r_5343_assistant']);
    const invItems = r.ids.map(id => merged.items.find(x => x.id === id));
    expect(countR1Inversions(invItems)).toBe(0);
  });
});

describe('Gemini детектор готовности DOM перед автоскроллом (advanceReadiness)', () => {
  it('фикстура «ленивая подгрузка»: scrollHeight растёт → готовность по стабилизации 2 замеров', () => {
    // elements===expected не выполняется (expected=20, элементов ≤10), поэтому критерий
    // готовности — стабилизация двух последних замеров scrollHeight (разница < 100).
    const state = newDomReadiness();
    expect(state.samples).toEqual([]);

    let r = advanceReadiness(state, 1000, 3, 20);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('pending');

    r = advanceReadiness(state, 1900, 5, 20);
    expect(r.ready).toBe(false);

    r = advanceReadiness(state, 3100, 7, 20);
    expect(r.ready).toBe(false);

    // последние 2 = [3100, 3150], разница 50 < 100 → стабильно
    r = advanceReadiness(state, 3150, 9, 20);
    expect(r.ready).toBe(true);
    expect(r.reason).toMatch(/^stable:/);
  });

  it('стабилизация scrollHeight (2 замера, разница < 100px) → ready=true', () => {
    const state = newDomReadiness();
    let r = advanceReadiness(state, 2000, 1, 20);
    expect(r.ready).toBe(false);
    r = advanceReadiness(state, 2050, 2, 20); // разница 50 < 100
    expect(r.ready).toBe(true);
    expect(r.reason).toBe('stable:2000-2050');
  });

  it('elements>10 готово ТОЛЬКО когда elements===expected', () => {
    const state = newDomReadiness();
    const r = advanceReadiness(state, 1200, 11, 11);
    expect(r.ready).toBe(true);
    expect(r.reason).toBe('elements:11');
  });

  it('elements>10, но elements !== expected → НЕ готов по элементам (жмёт стабилизацию)', () => {
    const state = newDomReadiness();
    const r = advanceReadiness(state, 1200, 11, 5);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('pending');
  });

  it('элементов ≤ 10 и scrollHeight не стабилизировался → ready=false', () => {
    const state = newDomReadiness();
    advanceReadiness(state, 1000, 5, 20);
    advanceReadiness(state, 1600, 8, 20);
    const r = advanceReadiness(state, 2200, 10, 20);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('pending');
  });

  it('держит не более 3 последних замеров в samples', () => {
    const state = newDomReadiness();
    advanceReadiness(state, 1000, 1, 20);
    advanceReadiness(state, 1100, 2, 20);
    advanceReadiness(state, 1200, 3, 20);
    advanceReadiness(state, 1300, 4, 20);
    expect(state.samples).toEqual([1100, 1200, 1300]);
  });
});

describe('Gemini причина нулевого пола (diagnoseFloorAbsence)', () => {
  it('диагностирует отсутствие сохранённого пола и неверную версию', () => {
    const storage = makeStorage();
    expect(diagnoseFloorAbsence('', 'g3', storage)).toBe('no-conv');
    expect(diagnoseFloorAbsence('conv_1', 'g3', storage)).toBe('no-floor-saved');
    // даже под новым ключом вручную запишем другой версии → version-mismatch
    storage.setItem(floorStorageKey('conv_1', 'g3'), JSON.stringify({ count: 10, effectiveLen: 100, version: 'g2' }));
    expect(diagnoseFloorAbsence('conv_1', 'g3', storage)).toBe('version-mismatch-or-invalid');
    storage.setItem(floorStorageKey('conv_1', 'g3'), JSON.stringify({ count: 0, effectiveLen: 0, version: 'g3' }));
    expect(diagnoseFloorAbsence('conv_1', 'g3', storage)).toBe('floor-count-zero');
    storage.setItem(floorStorageKey('conv_1', 'g3'), JSON.stringify({ count: 10, effectiveLen: 100, version: 'g3' }));
    expect(diagnoseFloorAbsence('conv_1', 'g3', storage)).toBe('ok');
  });
});

describe('Gemini тишина vf5-поллера при полной истории (shouldPollVf5)', () => {
  it('полная история + reachedStart + активности не было 60с → не поллить', () => {
    const now = 200000;
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now - 60000 }, now)).toBe(false);
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now - 120000 }, now)).toBe(false);
  });

  it('полная история + reachedStart, но активность была недавно → поллить', () => {
    const now = 200000;
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now - 59999 }, now)).toBe(true);
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now }, now)).toBe(true);
  });

  it('активность < 60с или ровно 0 → поллить (любое событие снимает тишину)', () => {
    const now = 200000;
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now - 1 }, now)).toBe(true);
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now }, now)).toBe(true);
  });

  it('история НЕ полная или НЕ reachedStart → поллить независимо от простоя', () => {
    const now = 200000;
    const stale = now - 60000;
    expect(shouldPollVf5({ baseComplete: false, reachedStart: true, lastActivityAt: stale }, now)).toBe(true);
    expect(shouldPollVf5({ baseComplete: true, reachedStart: false, lastActivityAt: stale }, now)).toBe(true);
    expect(shouldPollVf5({ baseComplete: false, reachedStart: false, lastActivityAt: stale }, now)).toBe(true);
  });

  it('пустое состояние / отсутствие lastActivityAt → поллить (граничный случай)', () => {
    expect(shouldPollVf5({}, 200000)).toBe(true);
    expect(shouldPollVf5(null, 200000)).toBe(true);
  });
});

describe('Gemini retry-логика автоскролла (shouldRetryAutoscroll)', () => {
  it('факт < ожидаемого → нужен retry, пока не исчерпан лимит', () => {
    expect(shouldRetryAutoscroll(50, 100, 0, 2)).toBe(true);
    expect(shouldRetryAutoscroll(50, 100, 1, 2)).toBe(true);
    expect(shouldRetryAutoscroll(50, 100, 2, 2)).toBe(false); // лимит исчерпан
  });

  it('факт >= ожидаемого → retry не нужен', () => {
    expect(shouldRetryAutoscroll(100, 100, 0, 2)).toBe(false);
    expect(shouldRetryAutoscroll(120, 100, 0, 2)).toBe(false);
  });

  it('нет ожидаемого числа (0 или пусто) → retry не нужен (не с чем сравнивать)', () => {
    expect(shouldRetryAutoscroll(50, 0, 0, 2)).toBe(false);
    expect(shouldRetryAutoscroll(50, null, 0, 2)).toBe(false);
    expect(shouldRetryAutoscroll(50, undefined, 0, 2)).toBe(false);
  });
});
