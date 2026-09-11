/**
 * T1 (v1.16): парсеры четырёх архивов (utils/archive-import.js).
 *
 * Фикстуры — синтетические, но повторяют реальные формы экспортов:
 *   tests/fixtures/archive/gemini-takeout.json         (Google Takeout MyActivity)
 *   tests/fixtures/archive/chatgpt-conversations.json  (ChatGPT conversations.json)
 *   tests/fixtures/archive/claude-conversations.json   (Claude conversations.json)
 *   tests/fixtures/archive/perplexity-threads.json     (Perplexity threads)
 *
 * Инварианты, которые здесь закрепляются:
 *   - system/tool/служебные записи в архив НЕ попадают (count = только ходы);
 *   - запись без convId НЕ попадает в архив и считается в skippedNoConvId
 *     (идентификаторы не выдумываются);
 *   - порядок ходов хронологический, голова диалога = первый user-ход;
 *   - пустой/неизвестный файл → ok:false с диагностикой, а не «пустой архив».
 */

const path = require('path');
const fs = require('fs');
const AI = require('../../utils/archive-import.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'archive');
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}
function roles(conv) { return conv.messages.map((m) => m.role); }
function texts(conv) { return conv.messages.map((m) => m.text); }

describe('T1: Gemini Takeout (MyActivity.json)', () => {
  const fixture = loadFixture('gemini-takeout.json');
  const res = AI.parseGeminiTakeout(fixture);

  test('записи группируются по convId из titleUrl', () => {
    expect(res.conversations.length).toBe(2);
    expect(res.conversations[0].convId).toBe('7c1f4a9b2e8d3a05');
    expect(res.conversations[1].convId).toBe('9ab31d77c0f2e614');
    expect(res.conversations[0].service).toBe('gemini');
    expect(res.conversations[0].format).toBe(AI.FORMATS.GEMINI_TAKEOUT);
  });

  test('префикс «Prompted » срезан, ходы пар user/assistant в хронологии', () => {
    const conv = res.conversations[0];
    expect(roles(conv)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv.messages[0].text).toBe('Объясни разницу между процессом и потоком в Linux');
    expect(conv.messages[1].text).toMatch(/^Процесс — это экземпляр программы/);
    expect(conv.messages[2].text).toBe('А что такое copy-on-write при fork?');
    expect(conv.count).toBe(4);
    expect(conv.title).toBe('Объясни разницу между процессом и потоком в Linux');
  });

  test('Takeout без ответа модели (штатный случай) не выбрасывает ход пользователя', () => {
    const conv = res.conversations[1];
    expect(roles(conv)).toEqual(['user', 'user']);
    expect(conv.count).toBe(2);
    expect(texts(conv)).toEqual([
      'Собери мне чек-лист по code review',
      'Добавь пункт про тесты'
    ]);
  });

  test('запись без convId (Search) пропущена и посчитана в skippedNoConvId', () => {
    expect(res.skippedNoConvId).toBe(1);
  });

  test('updatedAt = максимальное время записей чата', () => {
    expect(res.conversations[0].updatedAt).toBe(Date.parse('2024-07-10T08:18:02.000Z'));
  });

  test('textLen = сумма длин текстов ходов', () => {
    const conv = res.conversations[0];
    const expected = conv.messages.reduce((n, m) => n + m.text.length, 0);
    expect(conv.textLen).toBe(expected);
  });

  test('обёртка {items:[...]} обрабатывается как тот же формат', () => {
    const wrapped = AI.parseGeminiTakeout({ items: fixture });
    expect(wrapped.conversations.length).toBe(2);
  });
});

describe('T1: ChatGPT conversations.json', () => {
  const fixture = loadFixture('chatgpt-conversations.json');
  const res = AI.parseChatGPTArchive(fixture);

  test('оба диалога разобраны, convId из conversation_id', () => {
    expect(res.conversations.length).toBe(2);
    expect(res.conversations[0].convId).toBe('5f2b8d61-4c7a-4d1e-9b3f-2a6e0c8d7f10');
    expect(res.conversations[1].convId).toBe('b1d4e7a2-8f36-4c05-a9d8-77e2b41c6f93');
    expect(res.conversations[0].service).toBe('chatgpt');
  });

  test('system и tool-узлы mapping в архив НЕ попадают', () => {
    const conv = res.conversations[0];
    expect(roles(conv)).toEqual(['user', 'assistant', 'user']);
    expect(conv.count).toBe(3);
    expect(texts(conv).join('\n')).not.toContain('You are ChatGPT');
    expect(texts(conv).join('\n')).not.toContain('"ok":true');
  });

  test('голова диалога — первый user-ход (линеаризация mapping)', () => {
    expect(res.conversations[0].messages[0].text).toBe('Что такое декогеренция простыми словами?');
    expect(res.conversations[1].messages[0].text).toBe('Посчитай 2+2');
  });

  test('PUA-маркер [cite:…] вычищен через общий санатор ChatGPT', () => {
    expect(res.conversations[0].messages[1].text).toBe('Декогеренция — это потеря фазовой когерентности.');
    expect(res.conversations[0].messages[1].text).not.toMatch(/[\uE000-\uF8FF]/);
  });

  test('второй диалог: пара user/assistant', () => {
    expect(roles(res.conversations[1])).toEqual(['user', 'assistant']);
    expect(texts(res.conversations[1])).toEqual(['Посчитай 2+2', '4']);
  });
});

describe('T1: недоступный общий парсер → честная диагностика (без дублей логики)', () => {
  // В браузере (страница настроек) парсеры приходят window-глобалами
  // (скрипт-теги options.html); в Node — через require. Проверяем ОБА пути
  // отказа: мок-модуль + вычищенные page-глобалы (resetModules их не трогает).
  afterEach(() => {
    jest.dontMock('../../utils/chatgpt-conversation-parser.js');
    jest.dontMock('../../utils/perplexity-parser.js');
    jest.resetModules();
  });

  function clearPageGlobals() {
    delete window.ChatGPTConversationParser;
    delete window.parsePerplexityThread;
  }

  test('ChatGPT: без orderChatGPTMapping импорт отклоняется, а не «угадывается»', () => {
    jest.resetModules();
    clearPageGlobals();
    jest.doMock('../../utils/chatgpt-conversation-parser.js', () => ({}));
    const isolated = require('../../utils/archive-import.js');
    const r = isolated.parseArchive(loadFixture('chatgpt-conversations.json'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('chatgpt-parser-unavailable');
    expect(r.format).toBe(AI.FORMATS.CHATGPT_CONVERSATIONS);
    expect(r.conversations).toEqual([]);
  });

  test('Perplexity: без parsePerplexityThread импорт отклоняется', () => {
    jest.resetModules();
    clearPageGlobals();
    jest.doMock('../../utils/perplexity-parser.js', () => ({}));
    const isolated = require('../../utils/archive-import.js');
    const r = isolated.parseArchive(loadFixture('perplexity-threads.json'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('perplexity-parser-unavailable');
    expect(r.conversations).toEqual([]);
  });

  test('инъекция парсеров через deps работает без глобалов (явный шов)', () => {
    jest.resetModules();
    clearPageGlobals();
    jest.doMock('../../utils/chatgpt-conversation-parser.js', () => ({}));
    const isolated = require('../../utils/archive-import.js');
    const real = require('../../utils/chatgpt-conversation-parser.js');
    jest.dontMock('../../utils/chatgpt-conversation-parser.js');
    // deps приоритетнее require/window
    const deps = {
      orderChatGPTMapping: require('../../utils/chatgpt-conversation-parser.js').orderChatGPTMapping,
      sanitizeChatGPTText: require('../../utils/chatgpt-conversation-parser.js').sanitizeChatGPTText
    };
    const r = isolated.parseArchive(loadFixture('chatgpt-conversations.json'), deps);
    expect(r.ok).toBe(true);
    expect(r.conversations.length).toBe(2);
    expect(typeof real).toBe('object');
  });
});

describe('T1: Claude conversations.json', () => {
  const fixture = loadFixture('claude-conversations.json');
  const res = AI.parseClaudeArchive(fixture);

  test('оба диалога разобраны, convId из uuid', () => {
    expect(res.conversations.length).toBe(2);
    expect(res.conversations[0].convId).toBe('d2f5a1c8-7b40-4e93-8a16-5c0d9e2f3b74');
    expect(res.conversations[0].service).toBe('claude');
    expect(res.conversations[0].title).toBe('Свёрточные сети');
  });

  test('thinking-блоки и system-sender в архив не попадают; пустой content отброшен', () => {
    const conv = res.conversations[0];
    expect(roles(conv)).toEqual(['user', 'assistant']);
    expect(conv.count).toBe(2);
    expect(texts(conv).join('\n')).not.toContain('Внутреннее рассуждение');
    expect(texts(conv).join('\n')).not.toContain('Служебная заметка');
    expect(conv.messages[1].text).toMatch(/^Свёрточный слой применяет ядро/);
  });

  test('uuid сообщения сохраняется как id (стабильность same-conv-union)', () => {
    expect(res.conversations[0].messages[0].id).toBe('cm-001');
    expect(res.conversations[0].messages[1].id).toBe('cm-002');
  });

  test('фолбэк на msg.text, когда content-блоков нет', () => {
    const conv = res.conversations[1];
    expect(texts(conv)[0]).toBe('Только текстовое поле, без content-блоков.');
    expect(conv.count).toBe(2);
  });

  test('6-значные доли секунды в датах разбираются (toMs-фолбэк)', () => {
    expect(res.conversations[0].updatedAt).toBeGreaterThan(0);
    expect(res.conversations[1].updatedAt).toBeGreaterThan(0);
  });
});

describe('T1: Perplexity threads', () => {
  const fixture = loadFixture('perplexity-threads.json');
  const res = AI.parsePerplexityArchive(fixture);

  test('оба треда разобраны, convId из thread.id', () => {
    expect(res.conversations.length).toBe(2);
    expect(res.conversations[0].convId).toBe('thr-9f1c0d7a');
    expect(res.conversations[1].convId).toBe('thr-4b8e21c5');
    expect(res.conversations[0].service).toBe('perplexity');
    expect(res.conversations[0].title).toBe('Квантовый шум');
  });

  test('путь blocks (workflow): user из query_str + assistant из WORKFLOW_ITEM_TEXT', () => {
    const conv = res.conversations[0];
    expect(roles(conv)).toEqual(['user', 'assistant']);
    expect(texts(conv)).toEqual([
      'Что такое квантовый шум?',
      'Квантовый шум — это неустранимые флуктуации наблюдаемых величин.'
    ]);
  });

  test('путь REST (entry.text → FINAL → content.answer → answer)', () => {
    const conv = res.conversations[1];
    expect(roles(conv)).toEqual(['user', 'assistant']);
    expect(conv.messages[1].text).toBe('Декогеренция — потеря фазовой когерентности при взаимодействии со средой.');
    expect(conv.count).toBe(2);
  });
});

describe('T1: фасад parseArchive / parseArchiveText', () => {
  test('parseArchive сам определяет формат и возвращает service', () => {
    const r = AI.parseArchive(loadFixture('perplexity-threads.json'));
    expect(r.ok).toBe(true);
    expect(r.format).toBe(AI.FORMATS.PERPLEXITY_THREADS);
    expect(r.service).toBe('perplexity');
    expect(r.error).toBeNull();
    expect(r.conversations.length).toBe(2);
  });

  test('неизвестный формат → ok:false reason=unknown-format, диалогов нет', () => {
    const r = AI.parseArchive([{ foo: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown-format');
    expect(r.conversations).toEqual([]);
  });

  test('битый JSON → ok:false reason=invalid-json (без исключения наружу)', () => {
    const r = AI.parseArchiveText('{ это не json');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid-json');
  });

  test('parseArchiveText на валидном файле', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'claude-conversations.json'), 'utf8');
    const r = AI.parseArchiveText(raw);
    expect(r.ok).toBe(true);
    expect(r.format).toBe(AI.FORMATS.CLAUDE_CONVERSATIONS);
  });
});

describe('T1: бюджеты импорта (chrome.storage.local)', () => {
  function conv(id, n) {
    const messages = [];
    for (let i = 0; i < n; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(50) });
    return { convId: id, service: 'gemini', format: AI.FORMATS.GEMINI_TAKEOUT, title: id, messages: messages };
  }

  test('обычный импорт: все диалоги приняты, бюджет посчитан', () => {
    const plan = AI.planArchiveImport([conv('a', 4), conv('b', 2)], { fileName: 'f.json', importedAt: 7 });
    expect(plan.accepted.length).toBe(2);
    expect(plan.skipped.length).toBe(0);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(plan.accepted[0].importedAt).toBe(7);
    expect(plan.accepted[0].fileName).toBe('f.json');
  });

  test('диалог сверх per-conversation бюджета → skipped reason=too-large', () => {
    const plan = AI.planArchiveImport([conv('big', 4)], { maxConversationBytes: 100 });
    expect(plan.accepted.length).toBe(0);
    expect(plan.skipped[0].reason).toBe('too-large');
  });

  test('суммарный бюджет → skipped reason=budget-exceeded', () => {
    const one = AI.recordBytes(AI.buildArchiveRecord(conv('a', 4), { fileName: 'f.json', importedAt: 7 }));
    const plan = AI.planArchiveImport([conv('a', 4), conv('b', 4)], {
      maxTotalBytes: one + 10,
      fileName: 'f.json',
      importedAt: 7
    });
    expect(plan.accepted.length).toBe(1);
    expect(plan.skipped.map((s) => s.reason)).toContain('budget-exceeded');
  });

  test('пустой диалог → skipped reason=empty; без convId → no-conv-id', () => {
    const plan = AI.planArchiveImport([
      { convId: 'e', service: 'gemini', format: AI.FORMATS.GEMINI_TAKEOUT, messages: [] },
      { convId: '', service: 'gemini', format: AI.FORMATS.GEMINI_TAKEOUT, messages: [{ role: 'user', text: 'x' }] }
    ]);
    expect(plan.accepted.length).toBe(0);
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(['empty', 'no-conv-id']);
  });
});
