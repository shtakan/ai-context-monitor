/**
 * E-2 (live, Gemini Deep Research, convId 72c88213f2e812e1): txt-экспорт содержал начальный
 * промпт пользователя 4 раза (пузырь реплики + карточка плана + узлы шагов исследования),
 * из-за чего счётчик токенов и % индикатора считались по раздутой истории
 * (13 737 токенов при реальном однократном промпте).
 *
 * Фикс:
 *   1) чистая функция Utils/gemini-batchexecute-parser → utils/export-emit-pipeline.js:
 *      dedupeMessages(messages) — схлопывание сообщений с одинаковой ролью и идентичным
 *      нормализованным текстом (trim + схлоп пробелов), ПЕРВОЕ вхождение побеждает;
 *   2) core/content.js — слушатель ai-cm-full-history схлопывает базу ДО потребителей
 *      (baseText/baseCount/lastBaseTexts/lastDetailMessages), поэтому badge/pct, экспорт
 *      .txt/.md/.json и print видят одну и ту же схлопнутую историю;
 *   3) лог '[AI CM][gemini] dedupe removed=N' при N>0 (один раз на снимок базы).
 *
 * E-2.1 (Deep Research С ВЛОЖЕНИЯМИ): тот же промпт дублируется ВНУТРИ одного сообщения —
 * отрендеренный текст + сырой markdown-блок ('### ROLE& OBJECTIVE'), который Gemini хранит
 * для внутреннего рендеринга (та же болезнь у карточки плана). Меж-сообщенческий
 * dedupeMessages такие повторы не видит. Фикс:
 *   4) чистая функция dedupeIntraMessage(message) → { text, removedBlocks } режет текст
 *      сообщения на блоки по пустым строкам и выбрасывает дубли (нормализованное
 *      совпадение ИЛИ сырой markdown против отрендеренного текста), оставляя ПЕРВОЕ
 *      вхождение; приоритет — отрендеренный текст;
 *   5) prepareExportMessages(raw, onMessageDedupe) — единая точка порядка:
 *      нормализация → внутри-сообщенческая → меж-сообщенческая дедупликация;
 *   6) лог '[AI CM][gemini] intra-dedupe removed=X blocks in message role=Y' при X>0.
 *
 * Фикстуры:
 *   - deepResearchFixture() — меж-сообщенческие дубли (4 копии промпта по разным узлам);
 *   - deepResearchWithAttachmentsFixture() — дубли ВНУТРИ хода (отрендеренный текст +
 *     сырой markdown-блок '### ROLE& OBJECTIVE', копия карточки плана) И побайтовая
 *     копия того же хода другим узлом: внутри-сообщенческая дедупликация делает ходы
 *     идентичными, после чего меж-сообщенческая убирает второй.
 * Проверки: removedBlocks/intraRemoved, пересчёт baseText/baseCount/токенов и логи
 * 'dedupe removed=' + 'intra-dedupe removed='.
 *
 * Тесты гоняют РЕАЛЬНЫЙ код: чистую функцию из пайплайна и РЕАЛЬНОЕ тело слушателя
 * core/content.js (конвенция collapse-guard / tape-protect — песочница с `with`).
 */
const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');

const ROOT = path.join(__dirname, '..');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');

const USER_PROMPT =
  'Проведи глубокое исследование: правомерно ли увольнение водителя трамвая по медицинским показаниям';
const PLAN_CARD =
  'Вот план исследования: цель — «правомерно ли увольнение водителя трамвая по медицинским ' +
  'показаниям»; шаги: (1) собрать нормативную базу, (2) изучить судебную практику, ' +
  '(3) подготовить итоговое заключение.';

// ---- fixture Deep Research: один реальный промпт, размноженный по узлам дерева ----
// Узлы: пузырь реплики + 3 узла шагов; id у всех разные (подряд идущий строгий дедуп
// внутри перехватчика такие повторы не видит — они не соседние assistant-сообщения).
function deepResearchFixture() {
  return [
    { id: 'u1_user', role: 'user', text: USER_PROMPT },
    { id: 'a1_assistant', role: 'assistant', text: PLAN_CARD },
    { id: 'u2_user', role: 'user', text: USER_PROMPT },
    { id: 'u3_user', role: 'user', text: '  ' + USER_PROMPT.replace(/ /g, '  ') + '  ' },
    { id: 'u4_user', role: 'user', text: USER_PROMPT + '\n' },
    { id: 'a2_assistant', role: 'assistant', text: 'Отчёт: итоговое заключение по делу.' }
  ];
}

// ---- E-2.1: fixture Deep Research С ВЛОЖЕНИЯМИ — дубли ВНУТРИ одного сообщения ----
// Узел u1 несёт отрендеренный промпт И сырой markdown-блок '### ROLE& OBJECTIVE'
// (Gemini хранит его для внутреннего рендеринга); карточка плана продублирована
// отрендеренной копией. Снаружи сообщения тоже повторяются (u2) — проверяем, что
// внутри-сообщенческая дедупликация идёт ПЕРВОЙ, а меж-сообщенческая второй.
const RAW_ROLE_BLOCK =
  '### ROLE& OBJECTIVE\n' +
  'Ты — ведущий эксперт в области медицинского права РФ.\n' +
  'Отвечай со ссылками на нормы и судебную практику.';

// Тот же смысл без markdown-разметки (отрендеренная копия «ядра» блока).
const RENDERED_ROLE_BLOCK =
  'Ты — ведущий эксперт в области медицинского права РФ.\n' +
  'Отвечай со ссылками на нормы и судебную практику.';

function deepResearchWithAttachmentsFixture() {
  return [
    { id: 'u1_user', role: 'user', text: USER_PROMPT + '\n\n' + RENDERED_ROLE_BLOCK + '\n\n' + RAW_ROLE_BLOCK },
    { id: 'a1_assistant', role: 'assistant', text: PLAN_CARD + '\n\n' + PLAN_CARD },
    // u2 — побайтовая копия хода u1 (другой узел дерева): внутри-сообщенческая
    // дедупликация делает ходы идентичными, меж-сообщенческая убирает второй
    { id: 'u2_user', role: 'user', text: USER_PROMPT + '\n\n' + RENDERED_ROLE_BLOCK + '\n\n' + RAW_ROLE_BLOCK }
  ];
}

describe('E-2 (1): dedupeMessages — чистая функция пайплайна', () => {
  test('4 дубля промпта схлопываются до 1, карточка плана остаётся одним сообщением', () => {
    const res = P.dedupeMessages(deepResearchFixture());
    const users = res.messages.filter((m) => m.role === 'user');
    const plans = res.messages.filter((m) => m.role === 'assistant' && m.text.indexOf('Вот план исследования') === 0);
    expect(users.length).toBe(1);
    expect(users[0].text).toBe(USER_PROMPT); // побеждает ПЕРВОЕ вхождение (не обрезанное)
    expect(plans.length).toBe(1);
    expect(plans[0].text).toBe(PLAN_CARD);   // текст карточки плана не режется
    expect(res.removed).toBe(3);
    expect(res.messages.length).toBe(3);     // user + план + отчёт
  });

  test('нормализация: trim + схлоп пробелов и переводов строк', () => {
    const res = P.dedupeMessages([
      { role: 'user', text: 'а  б\n\tв' },
      { role: 'user', text: '  а б в  ' }
    ]);
    expect(res.messages.length).toBe(1);
    expect(res.messages[0].text).toBe('а  б\n\tв');
    expect(res.removed).toBe(1);
  });

  test('роли сравниваются независимо: user-реплика не съедает assistant с тем же текстом', () => {
    const res = P.dedupeMessages([
      { role: 'user', text: 'одинаковый текст' },
      { role: 'assistant', text: 'одинаковый текст' }
    ]);
    expect(res.messages.length).toBe(2);
    expect(res.removed).toBe(0);
  });

  test('история без дублей — байтово прежняя, removed=0', () => {
    const src = [
      { role: 'user', text: 'Привет' },
      { role: 'assistant', text: 'Привет! Чем могу помочь?' }
    ];
    const res = P.dedupeMessages(src);
    expect(res.messages).toEqual(src);
    expect(res.removed).toBe(0);
  });

  test('не-массив на входе → пустой результат без исключений', () => {
    expect(P.dedupeMessages(null)).toEqual({ messages: [], removed: 0 });
    expect(() => P.dedupeMessages(undefined)).not.toThrow();
  });
});

// ==================== E-2.1: внутри-сообщенческая дедупликация ====================
describe('E-2.1: dedupeIntraMessage — внутри-сообщенческая дедупликация', () => {
  test('удаляет сырой markdown-блок, дублирующий отрендеренный текст', () => {
    // Форма реального Deep Research: сырой markdown-блок несёт заголовок '### …' и
    // повторяет (целиком или с лишними секциями) уже отрендеренный текст хода.
    const input = {
      role: 'user',
      text: 'Проведи исследование: правомерно ли увольнение водителя трамвая\n\n### ROLE& OBJECTIVE\nПроведи исследование: правомерно ли увольнение водителя трамвая\n\nПроведи исследование: правомерно ли увольнение водителя трамвая'
    };
    const res = P.dedupeIntraMessage(input);
    expect(res.removedBlocks).toBe(2); // дубль отрендеренного текста + сырой markdown-блок
    expect(res.text).not.toContain('### ROLE& OBJECTIVE');
    // отрендеренный текст остаётся один раз
    const occurrences = res.text.split('Проведи исследование').length - 1;
    expect(occurrences).toBe(1);
  });

  test('удаляет сырой markdown-блок, ядро которого содержится в отрендеренном тексте', () => {
    // Сырой блок бывает длиннее отрендеренного: UI показывает не все секции.
    const rendered = 'Проведи исследование: правомерно ли увольнение водителя трамвая по медицинским показаниям';
    const raw =
      '### ROLE& OBJECTIVE\n' + rendered + '\n' +
      '### CONSTRAINTS\nОпирайся на нормы ТК РФ и судебную практику.';
    const res = P.dedupeIntraMessage({ role: 'user', text: rendered + '\n\n' + raw });
    expect(res.removedBlocks).toBe(1);
    expect(res.text).toBe(rendered);
  });

  test('не трогает сообщения без дубликатов', () => {
    const input = { role: 'user', text: 'Привет, как дела?' };
    const res = P.dedupeIntraMessage(input);
    expect(res.text).toBe(input.text);
    expect(res.removedBlocks).toBe(0);
  });

  test('обрабатывает большие промпты (>1000 символов)', () => {
    const longPrompt = 'А'.repeat(500) + '\n\n### ROLE\n' + 'А'.repeat(500);
    const input = { role: 'user', text: longPrompt };
    const res = P.dedupeIntraMessage(input);
    expect(res.removedBlocks).toBeGreaterThan(0);
    expect(res.text.length).toBeLessThan(longPrompt.length);
  });

  test('карточка плана, размноженная внутри одного assistant-сообщения, схлопывается', () => {
    const res = P.dedupeIntraMessage({ role: 'assistant', text: PLAN_CARD + '\n\n' + PLAN_CARD });
    expect(res.removedBlocks).toBe(1);
    expect(res.text).toBe(PLAN_CARD);
  });

  test('разные короткие блоки не склеиваются (порог 100 символов для сырого markdown)', () => {
    const text = 'Да.\n\nГотово.\n\nЧто дальше?';
    const res = P.dedupeIntraMessage({ role: 'assistant', text: text });
    expect(res.text).toBe(text);
    expect(res.removedBlocks).toBe(0);
  });

  test('приоритет отрендеренного текста: сырой блок выживает первым, но отбрасывается', () => {
    const res = P.dedupeIntraMessage({ role: 'user', text: RAW_ROLE_BLOCK + '\n\n' + RENDERED_ROLE_BLOCK });
    expect(res.removedBlocks).toBe(1);
    expect(res.text).not.toContain('### ROLE& OBJECTIVE');
    expect(res.text).toBe(RENDERED_ROLE_BLOCK);
  });

  test('сообщение без текста / не-строка → без изменений и без исключений', () => {
    expect(P.dedupeIntraMessage({ role: 'user', text: '' })).toEqual({ text: '', removedBlocks: 0 });
    expect(P.dedupeIntraMessage(null)).toEqual({ text: '', removedBlocks: 0 });
    expect(() => P.dedupeIntraMessage({ text: undefined })).not.toThrow();
  });

  test('prepareExportMessages: внутри-сообщенческая идёт ПЕРВОЙ, меж-сообщенческая — второй', () => {
    const fixture = deepResearchWithAttachmentsFixture();
    const calls = [];
    const res = P.prepareExportMessages(fixture, function (role, blocks) { calls.push([role, blocks]); });
    // внутри: u1 (сырой ROLE-блок снят) + a1 (копия карточки плана снята) + u2 (сырой ROLE-блок)
    expect(res.intraRemoved).toBe(3);
    expect(calls.length).toBe(3);
    expect(calls[0][0]).toBe('user');
    expect(calls[1][0]).toBe('assistant');
    expect(calls[0][1]).toBeGreaterThan(0);
    // меж: u2 — та же реплика, что и u1, ПОСЛЕ внутри-сообщенческой очистки u1
    expect(res.removed).toBe(1);
    expect(res.messages.length).toBe(2);
    const userText = res.messages.filter((m) => m.role === 'user')[0].text;
    expect(userText.split('Проведи глубокое исследование').length - 1).toBe(1);
    expect(res.messages.some((m) => m.text.indexOf('### ') !== -1)).toBe(false);
  });

  test('id сообщений переносятся (тейп/набор id базы не рвётся)', () => {
    const fixture = deepResearchWithAttachmentsFixture();
    const res = P.prepareExportMessages(fixture);
    expect(res.messages.map((m) => m.id)).toEqual(['u1_user', 'a1_assistant']);
  });
});

// ---- E-2.2: живая СКЛЕЙКА копий БЕЗ переноса строки на стыке ----
// Реальный экспорт (convId 72c88213f2e812e1) содержал отрендеренную копию промпта и сырой
// markdown-блок, склеенные ВПЛОТНУЮ: «…готовы к прямому копированию.### ROLE & OBJECTIVE…».
// Разбиение по /\n{2,}/ такой текст одним блоком не видит, поэтому E-2.1-дедуп молча не
// срабатывал и промпт оставался в одном ходе дважды. Тот же паттерн — в карточке плана.
const SEAM_PROMPT =
  'Проведи глубокое исследование: правомерно ли увольнение водителя трамвая по медицинским ' +
  'показаниям. Оформи результат как отчёт, готовый к прямому копированию.';
const SEAM_RAW_ROLE =
  '### ROLE & OBJECTIVE\n' +
  SEAM_PROMPT + '\n' +
  'Отвечай со ссылками на нормы и судебную практику.';
const SEAM_PLAN_CARD =
  'Вот план исследования: цель — «правомерно ли увольнение водителя трамвая по медицинским ' +
  'показаниям»; шаги: (1) собрать нормативную базу, (2) изучить судебную практику, ' +
  '(3) подготовить итоговое заключение.';
// Сырой markdown-блок карточки плана: секция-копия самой карточки + лишняя секция,
// из-за которой «ядро» по всему блоку не совпадает с отрендеренным текстом.
const SEAM_RAW_PLAN =
  '### PLAN\n' + SEAM_PLAN_CARD + '\n' +
  '### CONSTRAINTS\nОтвечай со ссылками на нормы и судебную практику.';
function seamGluedFixture() {
  return [
    // стык БЕЗ переноса строки: «…копированию.### ROLE & OBJECTIVE…»
    { id: 'u1_user', role: 'user', text: SEAM_PROMPT + SEAM_RAW_ROLE },
    // тот же паттерн внутри assistant-сообщения карточки плана: сырой markdown-блок
    // с посекционной копией самой карточки плана
    { id: 'a1_assistant', role: 'assistant', text: SEAM_PLAN_CARD + SEAM_RAW_PLAN }
  ];
}

describe('E-2.2: склейка копий без переноса строки на стыке', () => {
  test('фикстура воспроизводит live-дефект: стык «копированию.###» без пустой строки', () => {
    const fixture = seamGluedFixture();
    expect(fixture[0].text).toContain('копированию.### ROLE & OBJECTIVE');
    // до фикса текст — ОДИН блок, поэтому E-2.1-дедуп не срабатывает
    expect(fixture[0].text.split(/\n{2,}/).length).toBe(1);
  });

  test('separateRawBlocks разводит склейку и идемпотентен', () => {
    const glued = SEAM_PROMPT + SEAM_RAW_ROLE;
    const sep = P.separateRawBlocks(glued);
    expect(sep).toContain('копированию.\n\n### ROLE & OBJECTIVE');
    expect(sep.split(/\n{2,}/).length).toBe(2);          // теперь это два блока
    expect(P.separateRawBlocks(sep)).toBe(sep);          // повторный прогон не меняет
    // текст без заголовков '### ' не меняется байтово
    expect(P.separateRawBlocks('Привет\n\nКак дела?')).toBe('Привет\n\nКак дела?');
    // заголовок в начале текста не трогается
    expect(P.separateRawBlocks('### ROLE\nТекст.')).toBe('### ROLE\nТекст.');
  });

  test('после prepareExportMessages: в user-сообщении РОВНО ОДНА копия промпта', () => {
    const res = P.prepareExportMessages(seamGluedFixture());
    const users = res.messages.filter((m) => m.role === 'user');
    expect(users.length).toBe(1);
    // копия промпта внутри хода — ровно одна (сырой markdown-блок вырезан целиком)
    expect(users[0].text.split('Проведи глубокое исследование').length - 1).toBe(1);
    expect(users[0].text.split('### ROLE & OBJECTIVE').length - 1).toBe(0);
    expect(users[0].text).toBe(SEAM_PROMPT);
    expect(res.intraRemoved).toBe(2); // по одному сырому блоку в user- и assistant-ходе
  });

  test('карточка плана сохраняет свой текст, а копия промпта в ней — одна', () => {
    const res = P.prepareExportMessages(seamGluedFixture());
    const plans = res.messages.filter((m) => m.role === 'assistant' && m.text.indexOf('Вот план исследования') === 0);
    expect(plans.length).toBe(1);
    // текст карточки плана не режется
    expect(plans[0].text.split(SEAM_PLAN_CARD).length - 1).toBe(1);
    expect(plans[0].text.indexOf(SEAM_PLAN_CARD)).toBe(0);
    // секция-копия '### PLAN' и её заголовок вырезаны целиком
    expect(plans[0].text.split('### ').length - 1).toBe(0);
    // оба хода схлопнуты: по одному блоку-копии на сообщение
    expect(res.intraRemoved).toBe(2);
    expect(res.messages.length).toBe(2);
    // во ВСЕЙ истории промпт пользователя встречается ровно один раз
    const all = res.messages.map((m) => m.text).join('\n');
    expect(all.split('Проведи глубокое исследование').length - 1).toBe(1);
  });

  test('слушатель ai-cm-full-history: склейка схлопывается до потребителей (badge/база)', () => {
    const fixture = seamGluedFixture();
    const inflated = fixture.map((m) => m.text).join('\n');
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: inflated,
      count: fixture.length,
      effectiveLen: inflated.length,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);

    expect(ctx.baseCount).toBe(2);
    expect(ctx.baseText.split('ROLE & OBJECTIVE').length - 1).toBe(0);
    expect(ctx.baseText.split('Проведи глубокое исследование').length - 1).toBe(1);
    expect(ctx.effectiveTextAtSend).toBe(ctx.lastBaseTexts.join('\n'));
    expect(ctx.logs.some((l) => l.indexOf('[AI CM][gemini] intra-dedupe removed=') === 0)).toBe(true);
  });
});

// ---- E-2.2: копии промпта, разложенные по РАЗНЫМ сообщениям (живой экспорт 21-15) ----
// Реальный .txt/.md (convId 72c88213f2e812e1, скачан 2026-09-12 21:15) содержал промпт ТРИ
// раза: пузырь реплики пользователя (1) и карточка плана ассистента (2 — карточка + её
// сырой повтор). Все блоки обоих сообщений — СЫРОЙ markdown (в промпте есть '### '), а
// внутри-сообщенческий этап сравнивает сырой блок только с ОТРЕНДЕРЕННЫМ, поэтому
// dedupeIntraMessage возвращал removedBlocks=0 и копии выживали.
// Разделитель абзацев ВНУТРИ сырого блока в живом экспорте — строка с NBSP (\u00a0), а не
// пустая строка: именно поэтому весь блок '### ROLE… ### RESEARCH TASK' остаётся ОДНИМ
// блоком, а по /\n{2,}/ режется только на границах копий. Порядок абзацев повторён как в файле.
const NBSP = '\u00a0';
const LIVE_ROLE_PART = [
  '### ROLE & OBJECTIVE',
  'Ты — ведущий эксперт-аудитор в сфере контроля качества медицинской экспертизы.',
  NBSP,
  '### CONTEXT & HARD DATA',
  '1. Работник: Водитель трамвая (3-й класс, Трамвайное депо №2, г. Челябинск).',
  '2. Клинический статус: Первичный двусторонний коксартроз 3-й стадии, ФК 2.',
  NBSP,
  '### RESEARCH TASK & REQUIRED OUTPUT STRUCTURE',
  NBSP,
  'Просчитай риски и выдай структурированный аналитический отчет:',
  NBSP,
  '#'
].join('\n');
const LIVE_SECTION_1 =
  '### 1. Тактический выбор тайминга: Проактивный удар vs Реактивный ответ\n' +
  'Сравни Сценарий А и Сценарий Б, посчитай вероятность статьи за «прогул».';
const LIVE_SECTION_4 =
  '### 4. Юридический щит для заявления в депо на 14 июля\n' +
  'Подготовь формулировки для уведомления руководства депо.\n' +
  'Выдай отчет в жестком, деловом, экспертном стиле.\n' +
  'Формулировки заявлений должны быть готовы к прямому копированию.';
const LIVE_PLAN_INTRO = 'Вот план исследования для этой темы. Сообщите мне, если что-то надо поменять.';
const LIVE_REPORT =
  'Экспертное заключение по превентивному управлению правовыми и медицинскими рисками.\n\n' +
  'Сценарий А полностью нивелирует риски: работодатель обязан оплатить простой.';
// Пузырь реплики: сырой промпт (2 блока). Карточка плана: свой текст, ПРИКЛЕЕННЫЙ к полной
// копии промпта, + вторая копия первого блока. Отчёт не содержит '### ' и не трогается.
function liveCrossCopiesFixture() {
  const userText = LIVE_ROLE_PART + '\n\n' + LIVE_SECTION_1 + '\n\n' + LIVE_SECTION_4;
  return [
    { id: 'u1_user', role: 'user', text: userText },
    { id: 'a1_assistant', role: 'assistant', text: LIVE_PLAN_INTRO + '\n' + userText + '\n\n' + LIVE_ROLE_PART },
    { id: 'u2_user', role: 'user', text: 'Начать исследование' },
    { id: 'a2_assistant', role: 'assistant', text: LIVE_REPORT }
  ];
}
const occurrences = (s, sub) => s.split(sub).length - 1;

describe('E-2.2: сырые копии промпта между сообщениями (пузырь + карточка плана)', () => {
  test('фикстура воспроизводит live-дефект: промпт в истории 3 раза', () => {
    const fixture = liveCrossCopiesFixture();
    const all = fixture.map((m) => m.text).join('\n');
    expect(occurrences(all, '### ROLE & OBJECTIVE')).toBe(3);
    // внутри-сообщенческий этап бессилен: все блоки сырые → ни один проход не срабатывает
    const plan = P.dedupeIntraMessage(fixture[1]);
    expect(plan.removedBlocks).toBe(0);
    expect(plan.text).toBe(fixture[1].text);
  });

  test('dedupeCrossRawCopies снимает копии, сохраняя собственный текст карточки плана', () => {
    const res = P.prepareExportMessages(liveCrossCopiesFixture());
    // вырезаны: 2 блока-секции + повторный блок промпта в карточке (блок с интро — обрезан)
    expect(res.crossRemoved).toBe(3);
    expect(res.removed).toBe(3);
    // карточка плана сохранила РОВНО свой текст
    expect(res.messages[1].text).toBe(LIVE_PLAN_INTRO);
    // во ВСЕЙ истории промпт остался один раз — первое вхождение (пузырь реплики)
    const all = res.messages.map((m) => m.text).join('\n');
    expect(occurrences(all, '### ROLE & OBJECTIVE')).toBe(1);
    expect(all.indexOf('### ROLE & OBJECTIVE')).toBe(0);
    // сообщения и их id не удалены/не переставлены (индексы id у потребителя целы)
    expect(res.messages.map((m) => m.id)).toEqual(['u1_user', 'a1_assistant', 'u2_user', 'a2_assistant']);
  });

  test('чужие сообщения не тронуты байт-в-байт (отчёт, короткие реплики)', () => {
    const fixture = liveCrossCopiesFixture();
    const res = P.prepareExportMessages(fixture);
    // E-2.3: первый промпт (референс-копия) сохранён побайтово КРОМЕ одинокой строки '#'
    // в конце — это остаток разметки (маркер raw-заголовка), которого в экспорте быть не
    // должно (см. E-2.3 (в)); остальные байты сообщения целы.
    expect(res.messages[0].text).toBe(
      fixture[0].text.split('\n').filter((l) => !/^\s*#{1,}\s*$/.test(l)).join('\n')
    );
    expect(res.messages[2].text).toBe(fixture[2].text);
    expect(res.messages[3].text).toBe(fixture[3].text);
  });

  test('идемпотентность: повторный прогон ничего не режет', () => {
    const once = P.prepareExportMessages(liveCrossCopiesFixture());
    const twice = P.prepareExportMessages(once.messages);
    expect(twice.crossRemoved).toBe(0);
    expect(twice.messages.map((m) => m.text)).toEqual(once.messages.map((m) => m.text));
  });

  test('порог существенности: короткая повторяющаяся строка блок не режет', () => {
    const short = '### Итог\nГотово.';
    const res = P.prepareExportMessages([
      { id: 'u1', role: 'user', text: short },
      { id: 'a1', role: 'assistant', text: short }
    ]);
    expect(res.crossRemoved).toBe(0);
    expect(res.messages.map((m) => m.text)).toEqual([short, short]);
  });

  test('обычный текст (без строк «### ») не режется, даже если блок — префикс другого', () => {
    const fixture = [
      { id: 'u1', role: 'user', text: 'Привет' },
      { id: 'a1', role: 'assistant', text: 'Привет\nКак дела?' }
    ];
    const res = P.prepareExportMessages(fixture);
    expect(res.messages.map((m) => m.text)).toEqual(['Привет', 'Привет\nКак дела?']);
  });
});

// ---------- песочница реального слушателя ai-cm-full-history (core/content.js) ----------
const LISTENER_SRC = CONTENT_SRC.slice(
  CONTENT_SRC.indexOf("window.addEventListener('ai-cm-full-history'"),
  CONTENT_SRC.indexOf('// H23: гонка «ответ истории раньше слушателя»')
);

function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const HELPERS_SRC = [
  // Один непрерывный отрезок core/content.js: aiCmLogIntraDedupe → aiCmDedupeExportSource →
  // aiCmLogDedupeRemoved → buildHistoryMessages (все видят друг друга как в модуле).
  extractBlock(CONTENT_SRC, 'function aiCmLogIntraDedupe(role, blocks)', '// ================= v61diag'),
  extractBlock(CONTENT_SRC, 'function sanitizeGeminiText(s)', 'function aiCmCollectExportSource()'),
  extractBlock(CONTENT_SRC, 'function normalize(s)', 'var MSG_SELECTORS = [')
].join('\n');

function makeListenerCtx(overrides) {
  const ctx = {
    logs: [],
    console: { log: function () { }, warn: function () { }, error: function () { } },
    setTimeout: function () { return 0; },
    clearTimeout: function () { },
    Date: Date,
    // переменные модуля core/content.js, к которым обращается слушатель
    maxTokenCount: 0,
    lastSnapConvId: '',
    lastEmitConvId: '',
    lastBaseIds: [],
    lastBaseTexts: [],
    lastDetailMessages: null,
    lastHistoryWroteKey: null,
    lastThreadId: null,
    baseText: '',
    baseCount: 0,
    baseSeen: false,
    baseComplete: false,
    baseIdSet: null,
    baseSkelSet: null,
    baseAnchors: null,
    lastTailSig: null,
    lastBaseSig: null,
    lastEmitSig: null,
    netAttachTokens: 0,
    netAttachBreak: null,
    netServerTokens: 0,
    netEffectiveLen: 0,
    detectedModelSlug: '',
    stale: false,
    restoredTapeLoaded: true,
    restoreDone: true,
    badgeSuppressed: false,
    lastDedupeLogSig: null,
    aiCmBaseConfirmedByConv: {},
    aiCmLowConfidenceByConv: {},
    aiCmLateCheckByConv: {},
    aiCmLateAutoExportDone: {},
    preTrimExportFired: {},
    trimProbe: {},
    trimRetryByConv: {},
    aiCmLoaderRunningByConv: {},
    currentAdapter: { siteName: 'gemini', extractMessages: function () { return []; } },
    baseSig: null,
    ANCHOR_MIN: 40,
    window: { __aiCmTraceSeq: 0, location: { pathname: '/app/72c88213f2e812e1', href: '', hostname: 'gemini.google.com' }, __aiCmEmitChannelSeen: true, AiCmExportEmitPipeline: P },
    location: { pathname: '/app/72c88213f2e812e1', href: '', hostname: 'gemini.google.com' },
    document: { querySelectorAll: function () { return []; }, body: null },
    chrome: { runtime: { id: 'test-ext', lastError: null } },
    GeminiTapeStore: { save: function () { }, load: function () { return Promise.resolve(null); } },
    AiCmExportEmitPipeline: P,
    aiCmGeminiTurnsSnapshotSync: function () { return null; },
    aiCmDiagHash6: function () { return '000000'; },
    geminiParserVersion: function () { return 'test'; },
    GeminiInterceptLogic: null,
    isExtensionValid: function () { return true; },
    getCurrentConvId: function () { return '72c88213f2e812e1'; },
    getServiceKey: function () { return 'gemini'; },
    getAccountIndex: function () { return '0'; },
    geminiTapeKey: function (c) { return 'tape-' + c; },
    resetConversationState: function () { },
    geminiDetectTrim: function () { },
    tryInit: function () { },
    aiCmExportBaseSource: function () { return null; },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmLoadArchiveTier: function () { },
    aiCmExportCurrentSnap: null,
    aiCmArchiveLoadStarted: {},
    aiCmTapeAccountIdx: {},
    tapeRestoreSeen: {},
    aiCmRestoredDispatched: {},
    aiCmArchiveRestoredDispatched: {},
    // E-2.3: единственная схлопнутая база снимка (выход prepareExportMessages)
    aiCmBasePrepared: null,
    // прочие зависимости слушателя, не относящиеся к E-2 (поведение не проверяется)
    isInitialized: true,
    aiCmLoaderFreeze: false,
    aiCmLateAutoExportDone: {},
    aiCmHostHistoryRecord: function (snap) { return snap; },
    aiCmWriteCurrentHistory: function () { },
    aiCmScheduleDeferredHistWrite: function () { },
    aiCmFlushDeferredHistWrite: function () { },
    aiCmTryLateAutoExport: function () { },
    maybeAutoExport: function () { },
    notifyCounterMode: function () { },
    debugLog: function (kind, msg) { ctx.logs.push(String(msg)); },
    processAndSendCalls: 0,
    effectiveTextAtSend: null,
    effectiveCountAtSend: null
  };
  ctx.processAndSend = function () {
    ctx.processAndSendCalls++;
    ctx.effectiveTextAtSend = ctx.baseText;
    ctx.effectiveCountAtSend = ctx.baseCount;
  };
  return Object.assign(ctx, overrides || {});
}

// В песочнице `with (ctx)` идентификатор window — обычное свойство ctx, а не глобальный
// объект jsdom. Хелперы core/content.js читают пайплайн как window.AiCmExportEmitPipeline,
// поэтому кладём объект и в глобальный window (в page-контексте они совпадают).
function injectIntoGlobalWindow(ctx) {
  try {
    if (typeof window !== 'undefined') {
      window.AiCmExportEmitPipeline = P;
      window.__aiCmEmitChannelSeen = true;
      window.__aiCmTraceSeq = 1;
    }
  } catch (e) { }
}

function runListener(ctx, detail) {
  ctx.__detail = detail;
  ctx.window.__aiCmTraceSeq = 1;
  ctx.window.__aiCmEmitChannelSeen = true;
  ctx.__dedupeCalls = [];
  const src = HELPERS_SRC + '\n' + LISTENER_SRC +
    '\nvar __realDedupe = aiCmDedupeExportSource;\n' +
    'aiCmDedupeExportSource = function (m) { var r = __realDedupe(m); ctx.__dedupeCalls.push({ n: m.length, out: r.messages.length, removed: r.removed }); return r; };\n' +
    'window.dispatchEvent(new CustomEvent("ai-cm-full-history", { detail: __detail }));';
  // Минимальная шина событий — реальное тело слушателя остаётся нетронутым.
  ctx.window.addEventListener = function (type, handler) { ctx.handler = handler; };
  ctx.window.dispatchEvent = function (ev) { if (ctx.handler) ctx.handler(ev); };
  ctx.CustomEvent = function (type, init) { this.type = type; this.detail = (init || {}).detail; };
  injectIntoGlobalWindow(ctx);
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  return ctx;
}

describe('E-2 (2): слушатель ai-cm-full-history — схлопывание базы (badge/токены/экспорт)', () => {
  test('4 дубля промпта в базе → baseText/baseCount схлопнуты, лог removed=3', () => {
    const fixture = deepResearchFixture();
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: fixture.map((m) => m.text).join('\n'),
      count: fixture.length,
      effectiveLen: fixture.map((m) => m.text).join('\n').length,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);

    expect(ctx.baseCount).toBe(3);
    expect(ctx.lastBaseTexts.length).toBe(3);
    expect(ctx.lastDetailMessages.length).toBe(3);
    // промпт пользователя ровно 1 раз, карточка плана — 1 раз (не порезана)
    const userTexts = ctx.lastDetailMessages.filter((m) => m.role === 'user').map((m) => m.text);
    expect(userTexts).toEqual([USER_PROMPT]);
    const planTexts = ctx.lastDetailMessages.filter((m) => m.role === 'assistant' && m.text.indexOf('Вот план') === 0);
    expect(planTexts.length).toBe(1);
    expect(planTexts[0].text).toBe(PLAN_CARD);
    // лог схлопывания
    expect(ctx.logs.some((l) => l === '[AI CM][gemini] dedupe removed=3')).toBe(true);
  });

  test('токены/бейдж считаются по схлопнутой истории (effectiveText = baseText)', () => {
    const fixture = deepResearchFixture();
    const inflated = fixture.map((m) => m.text).join('\n');
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: inflated,
      count: fixture.length,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);

    expect(ctx.processAndSendCalls).toBe(1);
    // источник getEffectiveText()/getEffectiveCount() — уже схлопнутая база
    expect(ctx.effectiveCountAtSend).toBe(3);
    expect(ctx.effectiveTextAtSend).toBe(ctx.lastBaseTexts.join('\n'));
    expect(ctx.effectiveTextAtSend).not.toBe(inflated);
    expect(ctx.effectiveTextAtSend.length).toBeLessThan(inflated.length);
    // повтор промпта в схлопнутом тексте отсутствует
    const occurrences = ctx.effectiveTextAtSend.split(USER_PROMPT).length - 1;
    expect(occurrences).toBe(1);
  });

  test('история без дублей: база, счётчики и лог — байтово прежние', () => {
    const fixture = [
      { id: 'u1_user', role: 'user', text: 'Привет' },
      { id: 'a1_assistant', role: 'assistant', text: 'Привет! Чем могу помочь?' }
    ];
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: fixture.map((m) => m.text).join('\n'),
      count: 2,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);
    expect(ctx.baseCount).toBe(2);
    expect(ctx.baseText).toBe('Привет\nПривет! Чем могу помочь?');
    expect(ctx.logs.some((l) => l.indexOf('dedupe removed=') !== -1)).toBe(false);
  });

  test('не-Gemini сервис: база не трогается (адаптеры прочих сайтов байтово прежние)', () => {
    const fixture = deepResearchFixture();
    const inflated = fixture.map((m) => m.text).join('\n');
    const ctx = makeListenerCtx({ currentAdapter: { siteName: 'chatgpt', extractMessages: function () { return []; } } });
    ctx.__detail = {
      convId: 'chatgpt-conv',
      text: inflated,
      count: fixture.length,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true
    };
    runListener(ctx, ctx.__detail);
    expect(ctx.baseCount).toBe(fixture.length);
    expect(ctx.baseText).toBe(inflated);
    expect(ctx.logs.some((l) => l.indexOf('dedupe removed=') !== -1)).toBe(false);
  });
});

describe('E-2.1 (2): слушатель — внутри-сообщенческая дедупликация базы (Deep Research с вложениями)', () => {
  test('дубли ВНУТРИ хода удалены: baseText/baseCount пересчитаны, лог intra-dedupe есть', () => {
    const fixture = deepResearchWithAttachmentsFixture();
    const inflated = fixture.map((m) => m.text).join('\n');
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: inflated,
      count: fixture.length,
      effectiveLen: inflated.length,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);

    // u1 (внутри схлопнут) + a1 (копия плана убрана); u2 — меж-сообщенческий дубль u1
    expect(ctx.baseCount).toBe(2);
    expect(ctx.lastBaseTexts.length).toBe(2);
    expect(ctx.lastDetailMessages.length).toBe(2);
    // сырого markdown-блока в базе больше нет
    expect(ctx.baseText).not.toContain('### ');
    expect(ctx.baseText).not.toContain('### ROLE& OBJECTIVE');
    // промпт — ровно 1 раз, карточка плана — ровно 1 раз
    expect(ctx.baseText.split(USER_PROMPT).length - 1).toBe(1);
    expect(ctx.baseText.split('Вот план исследования').length - 1).toBe(1);
    // база реально ужалась относительно раздутого эмита
    expect(ctx.baseText.length).toBeLessThan(inflated.length);
    // логи: внутри-сообщенческая дедупликация + меж-сообщенческая
    const intraLogs = ctx.logs.filter((l) => l.indexOf('[AI CM][gemini] intra-dedupe removed=') === 0);
    expect(intraLogs.length).toBeGreaterThan(0);
    expect(intraLogs.some((l) => /removed=\d+ blocks in message role=(user|assistant)/.test(l))).toBe(true);
    expect(ctx.logs.some((l) => l === '[AI CM][gemini] dedupe removed=1')).toBe(true);
  });

  test('токены/бейдж считаются по базе без внутри-сообщенческих дублей', () => {
    const fixture = deepResearchWithAttachmentsFixture();
    const inflated = fixture.map((m) => m.text).join('\n');
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: inflated,
      count: fixture.length,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);

    expect(ctx.processAndSendCalls).toBe(1);
    expect(ctx.effectiveCountAtSend).toBe(2);
    expect(ctx.effectiveTextAtSend).toBe(ctx.lastBaseTexts.join('\n'));
    expect(ctx.effectiveTextAtSend.split(USER_PROMPT).length - 1).toBe(1);
    expect(ctx.effectiveTextAtSend.indexOf('### ')).toBe(-1);
  });

  test('база без внутри-сообщенческих дублей остаётся байтово прежней, лог intra-dedupe молчит', () => {
    const fixture = [
      { id: 'u1_user', role: 'user', text: 'Привет' },
      { id: 'a1_assistant', role: 'assistant', text: 'Привет! Чем могу помочь?' }
    ];
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: fixture.map((m) => m.text).join('\n'),
      count: 2,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);
    expect(ctx.baseCount).toBe(2);
    expect(ctx.baseText).toBe('Привет\nПривет! Чем могу помочь?');
    expect(ctx.logs.some((l) => l.indexOf('intra-dedupe') !== -1)).toBe(false);
  });

  test('не-Gemini сервис: внутри-сообщенческая дедупликация НЕ применяется (адаптеры прочих сайтов прежние)', () => {
    const fixture = deepResearchWithAttachmentsFixture();
    const inflated = fixture.map((m) => m.text).join('\n');
    const ctx = makeListenerCtx({ currentAdapter: { siteName: 'chatgpt', extractMessages: function () { return []; } } });
    ctx.__detail = {
      convId: 'chatgpt-conv',
      text: inflated,
      count: fixture.length,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true
    };
    runListener(ctx, ctx.__detail);
    expect(ctx.baseCount).toBe(fixture.length);
    expect(ctx.baseText).toBe(inflated);
    expect(ctx.baseText).toContain('### ROLE& OBJECTIVE');
    expect(ctx.logs.some((l) => l.indexOf('intra-dedupe') !== -1)).toBe(false);
  });
});

describe('E-2 (3): точка врезки в core/content.js', () => {
  test('слушатель схлопывает базу ДО processAndSend и зовёт логгер', () => {
    expect(LISTENER_SRC).toContain('var ded18 = aiCmDedupeExportSource(preDedupe18);');
    expect(LISTENER_SRC).toContain('baseText = texts18.join(\'\\n\');');
    expect(LISTENER_SRC).toContain('aiCmLogDedupeRemoved(ded18.removed);');
    expect(CONTENT_SRC).toContain("debugLog('log', '[AI CM][gemini] dedupe removed=' + removed);");
  });

  test('buildHistoryMessages схлопывает собранный массив (ручной экспорт/print)', () => {
    expect(CONTENT_SRC).toContain('return aiCmDedupeExportSource(aiCmCollectExportSource()).messages;');
  });

  test('E-2.1: внутри-сообщенческая дедупликация подключена ДО меж-сообщенческой', () => {
    const helpers = extractBlock(CONTENT_SRC, 'function aiCmLogIntraDedupe(role, blocks)', 'function aiCmDedupeExportSource(messages)');
    // гейт сервиса: не-Gemini выходит РАНЬШЕ — внутри-сообщенческая дедупликация не применяется
    expect(CONTENT_SRC).toContain("if (site !== 'gemini' && site !== 'aistudio') {");
    // единая точка входа пайплайна: порядок «внутри → меж» задан prepareExportMessages
    expect(CONTENT_SRC).toContain('P.prepareExportMessages(messages, aiCmLogIntraDedupe)');
    expect(CONTENT_SRC.indexOf('P.prepareExportMessages(messages, aiCmLogIntraDedupe)'))
      .toBeLessThan(CONTENT_SRC.indexOf('return P.dedupeMessages(messages);'));
    // лог ровно того формата, что в задаче
    expect(helpers).toContain("'[AI CM][gemini] intra-dedupe removed=' + blocks + ' blocks in message role=' + role");
  });

  test('E-2.1: пайплайн экспортирует функции и сохраняет порядок дедупликации', () => {
    expect(typeof P.dedupeIntraMessage).toBe('function');
    expect(typeof P.prepareExportMessages).toBe('function');
    const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
    // dedupeIntraMessage вызывается на КАЖДОЕ сообщение ДО dedupeMessages
    expect(PIPELINE_SRC.indexOf('var res = dedupeIntraMessage({ role: role, text: text });'))
      .toBeLessThan(PIPELINE_SRC.indexOf('var inter = dedupeMessages(out);'));
    // чистые функции не логируют (логирование вынесено в content.js через callback)
    const intraSrc = extractBlock(PIPELINE_SRC, 'function dedupeIntraMessage(message)', 'function coreOfBlock(block)');
    expect(intraSrc).not.toContain('console.');
  });
});

// =====================================================================================
// v1.18 (E-2.3): бейдж и экспорт на ОДНОЙ схлопнутой базе + marker-insensitive дедуп.
//   (а) пин синхронизации: baseText/baseCount и вход badge-расчёта равны выходу
//       prepareExportMessages; масштаб токенов берётся по схлопнутой базе;
//   (б) адверсариальные фикстуры: копии одного контента с разной разметкой (0..6 '#'+,
//       списки, цитата, '*', '_', '`', склейка заголовка без переноса, NBSP) схлопываются
//       в 1 (removed = N-1), а РАЗНЫЙ контент с теми же маркерами — нет;
//   (в) в тексте экспорта нет строк-остатков из одних '#'.
// =====================================================================================
const PROMPT_CORE =
  'Собери судебную практику по увольнению водителя трамвая по медицинским показаниям и подготовь отчёт.';

// Копии ОДНОГО контента в разной форматной разметке (принцип: разметка не влияет на работу).
function markerCopiesFixture() {
  const s = PROMPT_CORE;
  return [
    s,                                          // 0 маркеров
    '# ' + s,                                   // 1 '#'
    '## ' + s,                                  // 2
    '### ' + s,                                 // 3
    '#### ' + s,                                // 4
    '##### ' + s,                               // 5
    '###### ' + s,                              // 6
    '###\n' + s,                                // заголовок отдельной строкой
    '- ' + s,                                   // маркер списка
    '+ ' + s,
    '1. ' + s,                                  // нумерация
    '2) ' + s,
    '> ' + s,                                   // цитата
    '> ### ' + s,                               // цитата + заголовок
    '**' + s + '**',                            // выделение
    '__' + s + '__',
    '`' + s + '`',                              // код
    '### ' + s.replace(/ /g, NBSP)              // NBSP вместо пробелов
  ].map((text, i) => ({ id: 'u' + i, role: 'user', text: text }));
}

describe('E-2.3 (а): метрики и экспорт считаются по ОДНОЙ схлопнутой базе', () => {
  test('baseText/baseCount/badge-вход равны выходу prepareExportMessages', () => {
    const fixture = liveCrossCopiesFixture();
    const inflated = fixture.map((m) => m.text).join('\n');
    const prepared = P.prepareExportMessages(fixture).messages;
    const preparedText = prepared.map((m) => m.text).join('\n');
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: inflated,
      count: fixture.length,
      effectiveLen: inflated.length, // сеть отдала ДО-схлопнутую длину (вторая копия базы)
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);

    // база метрик = ровно выход prepareExportMessages (та же база, что уходит в файл)
    expect(ctx.baseCount).toBe(prepared.length);
    expect(ctx.baseText).toBe(preparedText);
    expect(ctx.lastBaseTexts).toEqual(prepared.map((m) => m.text));
    expect(ctx.lastBaseIds).toEqual(prepared.map((m) => m.id));
    // вход badge-расчёта (getEffectiveText/getEffectiveCount в processAndSend)
    expect(ctx.effectiveTextAtSend).toBe(preparedText);
    expect(ctx.effectiveCountAtSend).toBe(prepared.length);
    // токены: масштаб берётся по СХЛОПНУТОЙ базе, а не по ДО-схлопнутой длине сети
    expect(ctx.netEffectiveLen).toBe(preparedText.length);
    expect(ctx.netEffectiveLen).toBeLessThan(inflated.length);
  });

  test('без схлопывания (removed=0) сетевой effectiveLen (пол/selfHeal) не трогается', () => {
    const fixture = [
      { id: 'u1_user', role: 'user', text: 'Привет' },
      { id: 'a1_assistant', role: 'assistant', text: 'Привет! Чем могу помочь?' }
    ];
    const FLOOR_LEN = 50000; // пол поднял effectiveLen (парсер потерял текст)
    const ctx = makeListenerCtx();
    ctx.__detail = {
      convId: '72c88213f2e812e1',
      text: fixture.map((m) => m.text).join('\n'),
      count: fixture.length,
      effectiveLen: FLOOR_LEN,
      messageTexts: fixture.map((m) => m.text),
      messageIds: fixture.map((m) => m.id),
      messages: fixture,
      historyComplete: true,
      reachedStart: true
    };
    runListener(ctx, ctx.__detail);
    expect(ctx.baseCount).toBe(2);
    expect(ctx.netEffectiveLen).toBe(FLOOR_LEN);
  });

  test('врезка E-2.3 в core/content.js: единый массив + масштаб по схлопнутой базе', () => {
    expect(LISTENER_SRC).toContain('aiCmBasePrepared = prepared18;');
    expect(LISTENER_SRC).toContain("baseText = texts18.join('\\n');");
    expect(CONTENT_SRC).toContain('if (ded18.removed > 0 && netEffectiveLen > baseText.length) netEffectiveLen = baseText.length;');
    // текст метрик читается из того же подготовленного массива, а не из второй копии базы
    expect(CONTENT_SRC).toContain('return aiCmMetricBaseText(baseText);');
    expect(CONTENT_SRC).toContain('function aiCmMetricBaseText(fallback) {');
    // база метрик не перетекает в другой чат/снимок без сетевых текстов
    expect(CONTENT_SRC).toContain('// v1.18 (E-2.3): схлопнутая база метрик не перетекает в другой чат');
    expect(LISTENER_SRC).toContain('aiCmBasePrepared = null;');
    // экспорт по-прежнему собирается чистой подготовкой той же базы (один вердикт дедупа)
    expect(CONTENT_SRC).toContain('return aiCmDedupeExportSource(aiCmCollectExportSource()).messages;');
    // повторный прогон подготовки идемпотентен — второго вердикта/второй базы не появляется
    const fixture = liveCrossCopiesFixture();
    const once = P.prepareExportMessages(fixture).messages;
    const twice = P.prepareExportMessages(once).messages;
    expect(twice.map((m) => m.text)).toEqual(once.map((m) => m.text));
  });
});

describe('E-2.3 (б): marker-insensitive дедуп (адверсариальные фикстуры)', () => {
  test('один контент в 18 форматах разметки → 1 сообщение, removed = N-1', () => {
    const fixture = markerCopiesFixture();
    expect(fixture.length).toBe(18);
    const res = P.prepareExportMessages(fixture);
    expect(res.messages.length).toBe(1);
    expect(res.removed).toBe(fixture.length - 1);
    // побеждает ПЕРВОЕ вхождение — байтово (нормализация выхода не трогает)
    expect(res.messages[0].text).toBe(PROMPT_CORE);
    expect(res.messages[0].id).toBe('u0');
  });

  test('ядро контента не зависит от разметки: 0..6 «#», списки, цитата, *, _, `, NBSP', () => {
    const core = P.coreText(PROMPT_CORE);
    markerCopiesFixture().forEach((m) => expect(P.coreText(m.text)).toBe(core));
    expect(P.coreText('### Другой текст про другое дело')).not.toBe(core);
    expect(P.coreText('')).toBe('');
  });

  test('separateRawBlocks: любое число «#» в склейке/после пробела, идемпотентно, C# не трогает', () => {
    const glued3 = 'готовый к прямому копированию.### ROLE & OBJECTIVE\nтекст';
    const glued1 = 'готовый к прямому копированию.# ROLE\nтекст';
    const spaced = 'готовый к прямому копированию. ### ROLE & OBJECTIVE\nтекст';
    [glued3, glued1, spaced].forEach((s) => {
      const once = P.separateRawBlocks(s);
      expect(once).toContain('\n\n#');
      expect(P.separateRawBlocks(once)).toBe(once); // идемпотентно
    });
    expect(P.separateRawBlocks(spaced)).toBe('готовый к прямому копированию.\n\n### ROLE & OBJECTIVE\nтекст');
    // обычный текст и «#» без пробела после маркера — байтово прежние
    expect(P.separateRawBlocks('Привет\n\nКак дела?')).toBe('Привет\n\nКак дела?');
    expect(P.separateRawBlocks('### ROLE\nТекст.')).toBe('### ROLE\nТекст.');
    expect(P.separateRawBlocks('Пишу на C# и на Java')).toBe('Пишу на C# и на Java');
  });

  test('склейка raw-заголовка без переноса + NBSP: копия снимается, остаётся один промпт', () => {
    const prompt = 'Оформи результат как отчёт, готовый к прямому копированию.';
    const glued = prompt + '### ROLE\n' + prompt;
    const spaced = prompt + '\n\n### ROLE\n' + prompt;
    const nbspGlued = prompt + '## ROLE\n' + prompt.replace(/ /g, NBSP);
    const res = P.prepareExportMessages([
      { id: 'u1', role: 'user', text: prompt },
      { id: 'u2', role: 'user', text: glued },
      { id: 'u3', role: 'user', text: spaced },
      { id: 'u4', role: 'user', text: nbspGlued }
    ]);
    expect(res.messages.length).toBe(1);
    expect(res.messages[0].text).toBe(prompt);
    expect(res.intraRemoved).toBe(3); // по одной внутри-сообщенческой копии на ход
    expect(res.removed).toBe(3);      // меж-сообщенческое схлопывание копий
  });

  test('РАЗНЫЙ контент с ОДИНАКОВЫМИ маркерами не схлопывается', () => {
    const a = '### ROLE & OBJECTIVE\n' +
      'Первый текст: собрать нормативную базу по увольнению водителя трамвая и проверить её.';
    const b = '### ROLE & OBJECTIVE\n' +
      'Совершенно другой текст: изучить судебную практику по коксартрозу и подготовить отчёт.';
    const c = '## ROLE & OBJECTIVE\n' +
      'Первый текст: собрать нормативную базу по увольнению водителя трамвая и проверить её.';
    const res = P.prepareExportMessages([
      { id: 'u1', role: 'user', text: a },
      { id: 'a1', role: 'assistant', text: b },
      { id: 'u2', role: 'user', text: c } // копия a другим уровнем заголовка
    ]);
    expect(res.messages.length).toBe(2);           // c схлопнулась с a, b остался
    expect(res.removed).toBe(1);
    expect(res.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(res.messages[1].text).toBe(b);          // чужой ответ не тронут байтово
  });

  test('порог существенности сохранён: короткие разные блоки с «#» не режутся', () => {
    const res = P.prepareExportMessages([
      { id: 'u1', role: 'user', text: '### Итог\nГотово.' },
      { id: 'a1', role: 'assistant', text: '### Итог\nГотово.' }
    ]);
    expect(res.crossRemoved).toBe(0);
    expect(res.messages.map((m) => m.text)).toEqual(['### Итог\nГотово.', '### Итог\nГотово.']);
  });
});

describe('E-2.3 (в): в тексте экспорта нет строк-остатков из одних «#»', () => {
  const hashOnly = (line) => /^\s*#{1,}\s*$/.test(line);

  test('живой экспорт (21-26): одинокие «#» удалены из ВСЕХ сообщений', () => {
    const fixture = liveCrossCopiesFixture();
    // дефект воспроизводится: в исходном промпте есть строка из одного '#'
    expect(fixture[0].text.split('\n').some(hashOnly)).toBe(true);
    const res = P.prepareExportMessages(fixture);
    res.messages.forEach((m) => {
      m.text.split('\n').forEach((l) => expect(hashOnly(l)).toBe(false));
    });
    // сам промпт при этом сохранён (содержимое, кроме маркера-остатка)
    const all = res.messages.map((m) => m.text).join('\n');
    expect(all.split('### ROLE & OBJECTIVE').length - 1).toBe(1);
    expect(all.indexOf('Просчитай риски и выдай структурированный аналитический отчет:')).toBeGreaterThan(-1);
  });

  test('stripMarkerResidue: маркер удаляется ЦЕЛИКОМ, чужие байты целы', () => {
    expect(P.stripMarkerResidue('а\n#\nб')).toBe('а\nб');
    expect(P.stripMarkerResidue('а\n###   \nб')).toBe('а\nб');
    expect(P.stripMarkerResidue('а\n> ##\nб')).toBe('а\nб');
    // строка с текстом заголовка — не остаток
    expect(P.stripMarkerResidue('а\n#### НЕ ОСТАТОК\nб')).toBe('а\n#### НЕ ОСТАТОК\nб');
    const plain = 'обычный текст\nбез разметки';
    expect(P.stripMarkerResidue(plain)).toBe(plain);
    expect(P.stripMarkerResidue(P.stripMarkerResidue('а\n#\nб'))).toBe('а\nб'); // идемпотентно
    expect(P.stripMarkerResidue(null)).toBe('');
  });

  test('идемпотентность пайплайна: повторная подготовка остатков не оставляет', () => {
    const once = P.prepareExportMessages(liveCrossCopiesFixture());
    const twice = P.prepareExportMessages(once.messages);
    expect(twice.removed).toBe(0);
    expect(twice.messages.map((m) => m.text)).toEqual(once.messages.map((m) => m.text));
    twice.messages.forEach((m) => m.text.split('\n').forEach((l) => expect(hashOnly(l)).toBe(false)));
  });
});
