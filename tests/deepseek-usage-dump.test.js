/** @jest-environment node */
/**
 * O-26 (замер): семантика accumulated_token_usage + расхождение счётчиков svc-emit.
 *
 * Наблюдение: на длинном чате DeepSeek бейдж растёт сверхлинейно (151.3% → 396.3% при
 * +3 коротких ходах). Подозрение: accumulated_token_usage в payload — НАКОПИТЕЛЬ (сумма
 * по ходам), а не «токены хода»; тогда походовое сравнение даёт квадратичный рост. Второе
 * наблюдение: msgs в svc-emit (13→8) не равен размеру сетевой базы turnsMap.
 *
 * Стенд: РЕАЛЬНЫЙ core/deepseek-intercept.js в jsdom (node-окружение + свой JSDOM, как в
 * tests/adapters/deepseek-o17-spa-chat.test.js), сервер — подменённый window.fetch, который
 * отдаёт фикстуру истории с ЯВНО накопительными usage-полями и «соседними» ключами
 * (prompt_tokens/completion_tokens/total_tokens/cache_read_tokens + НЕ-usage inserted_at).
 *
 * Проверки:
 *  1) без флага sessionStorage.aiCmDebug дамп МОЛЧИТ, а EMIT байтово идентичен (дамп — только
 *     чтение payload: он не меняет ни turnsMap, ни пейлоад ai-cm-full-history);
 *  2) с флагом дамп печатает по каждому ходу index/role/длины текста и ВЕРБАТИМ все usage-поля
 *     фикстуры (значения как есть — без суммирования и пересчёта), ровно один раз на загрузку;
 *  3) source-пин trace-строки svc-emit-trace: рядом с msgs появились domMsgs и netMsgs,
 *     оба считаются из уже существующих переменных и живут ТОЛЬКО в log-строке (тело эмита
 *     байтово прежнее: новых источников/веток/записей состояния нет).
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'deepseek-intercept.js'), 'utf8');

jest.useFakeTimers();

const CID = 'usage26chat';
const CHAT_URL = 'https://chat.deepseek.com/a/chat/s/' + CID;
const HISTORY_URL = 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=' + CID;

// ======================= фикстура истории с usage-полями =======================

const Q1 = 'Первый вопрос';
const R1 = 'Считаю варианты.';
const A1 = 'Первый ответ';
const Q2 = 'Второй вопрос';
const R2 = 'Проверяю вывод.';
const A2 = 'Второй ответ';

// usage-поля как их отдаёт сервер: accumulated_token_usage МОНОТОННО РАСТЁТ по ходам
// (накопитель), prompt_tokens/completion_tokens тоже даны «как есть» — дамп не вправе их менять.
const TURNS = [
  {
    uid: 'u1', aid: 'a1', q: Q1, r: R1, a: A1, parent: null,
    uUsage: { accumulated_token_usage: 120, prompt_tokens: 110, completion_tokens: 10, total_tokens: 120 },
    aUsage: { accumulated_token_usage: 900, prompt_tokens: 130, completion_tokens: 770, total_tokens: 900, cache_read_tokens: 7 }
  },
  {
    uid: 'u2', aid: 'a2', q: Q2, r: R2, a: A2, parent: 'a1',
    uUsage: { accumulated_token_usage: 1010, prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
    aUsage: { accumulated_token_usage: 2600, prompt_tokens: 1030, completion_tokens: 1570, total_tokens: 2600 }
  }
];

function historyFixture() {
  const msgs = [];
  TURNS.forEach((t) => {
    msgs.push(Object.assign({
      message_id: t.uid, parent_id: t.parent, role: 'USER', thinking_enabled: true,
      inserted_at: '2026-01-01T10:00:00.000Z',              // НЕ usage — в дамп попасть не должен
      fragments: [{ type: 'REQUEST', content: t.q }]
    }, t.uUsage));
    msgs.push(Object.assign({
      message_id: t.aid, parent_id: t.uid, role: 'ASSISTANT', thinking_enabled: true,
      inserted_at: '2026-01-01T10:00:01.000Z',
      fragments: [{ type: 'THINK', content: t.r }, { type: 'RESPONSE', content: t.a }]
    }, t.aUsage));
  });
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'a2', model_type: 'expert', is_empty: false },
        chat_messages: msgs
      }
    }
  };
}

// ======================= стенд: реальный перехватчик + сервер =======================

function fakeResponse(jsonBody) {
  const clone = { json: () => Promise.resolve(jsonBody), text: () => Promise.resolve('') };
  return { ok: true, status: 200, json: () => Promise.resolve(jsonBody), text: () => Promise.resolve(''), clone: () => clone };
}

function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 120); i++) p = p.then(() => { });
  return p;
}
async function settle(times) {
  await flush(times || 150);
  await Promise.resolve();
  await flush(40);
}

function makeStand(debug) {
  const vc = new VirtualConsole();
  const logs = [];
  ['log', 'warn', 'error'].forEach((k) => vc.on(k, (...a) => logs.push(a.map(String).join(' '))));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: CHAT_URL, runScripts: 'dangerously', virtualConsole: vc
  });
  const { window } = dom;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  if (debug) window.sessionStorage.setItem('aiCmDebug', '1');
  window.fetch = (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.indexOf('history_messages') !== -1) return Promise.resolve(fakeResponse(historyFixture()));
    return Promise.resolve(fakeResponse(null));
  };
  window.eval(INTERCEPT_SRC);
  const events = [];
  window.addEventListener('ai-cm-full-history', (e) => events.push(e.detail));
  return {
    window, dom, logs, events,
    // тот же запрос, что делает сам сайт: перехватчик парсит ответ и публикует базу
    history: () => window.fetch(HISTORY_URL, { headers: { Authorization: 'Bearer t' } }),
    last: () => events[events.length - 1] || null,
    dumpLines: () => logs.filter((l) => l.indexOf('[ai-cm-debug][O26]') !== -1),
    turnLines: () => logs.filter((l) => l.indexOf('[ai-cm-debug][O26][turn]') !== -1),
    headerLines: () => logs.filter((l) => l.indexOf('[ai-cm-debug][O26][usage]') !== -1),
    close: () => { try { window.close(); } catch (e) { } }
  };
}

async function runScenario(debug) {
  const stand = makeStand(debug);
  await stand.history();
  await settle();
  return stand;
}

function parseTurn(line) {
  return JSON.parse(line.slice(line.indexOf('{')));
}

// ======================= 1) дамп как ИЗМЕРЕНИЕ: молчание без флага, EMIT байтово тот же =======================

describe('O-26 (1): вербатим-дамп usage при загрузке истории', () => {
  let off = null;
  let on = null;

  beforeAll(async () => {
    off = await runScenario(false);
    on = await runScenario(true);
  });
  afterAll(() => {
    if (off) off.close();
    if (on) on.close();
  });

  test('без флага aiCmDebug дамп молчит (ни одной строки [O26])', () => {
    expect(off.last()).toBeTruthy();                    // история реально загружена и опубликована
    expect(off.last().count).toBe(4);
    expect(off.logs.filter((l) => l.indexOf('[O26]') !== -1)).toHaveLength(0);
  });

  test('EMIT байтово идентичен при включённом и выключенном дампе', () => {
    expect(on.last()).toBeTruthy();
    // Сравниваем ИМЕННО пейлоад (то, что уезжает в content.js/бейдж/экспорт), а не логи:
    // дамп не вправе ни добавить поле, ни изменить порядок/значение.
    expect(JSON.stringify(on.last())).toBe(JSON.stringify(off.last()));
    expect(on.last().count).toBe(4);
    expect(on.last().serverTokens).toBe(2600);          // accumulated_token_usage как есть
  });

  test('с флагом дамп печатает по каждому ходу index/role/длины текста и usage фикстуры', () => {
    const lines = on.turnLines();
    expect(lines).toHaveLength(4);
    const recs = lines.map(parseTurn);

    expect(recs.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(recs.map((r) => r.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(recs.map((r) => r.messageIdPrefix)).toEqual(['u1', 'a1', 'u2', 'a2']);

    // длины текста хода: контент всех фрагментов / ответ (RESPONSE) / reasoning (THINK)
    expect(recs[0].contentLength).toBe(Q1.length);
    expect(recs[0].reasoningLength).toBe(0);
    expect(recs[1].contentLength).toBe(R1.length + A1.length);
    expect(recs[1].answerLength).toBe(A1.length);
    expect(recs[1].reasoningLength).toBe(R1.length);
    expect(recs[1].fragments).toBe(2);

    // usage ВЕРБАТИМ: ровно те ключи и значения, что в payload (включая «соседние»)
    expect(recs[0].usage).toEqual(TURNS[0].uUsage);
    expect(recs[1].usage).toEqual(TURNS[0].aUsage);
    expect(recs[2].usage).toEqual(TURNS[1].uUsage);
    expect(recs[3].usage).toEqual(TURNS[1].aUsage);
    expect(recs[1].usage.cache_read_tokens).toBe(7);    // соседний ключ не потерян
    expect(recs[0].usage.inserted_at).toBeUndefined();  // НЕ-usage ключ не притворяется usage

    // накопительная семантика видна сырыми числами: походовое чтение даёт рост 900 → 2600,
    // никакого суммирования/пересчёта дамп не делает
    expect(recs[1].usage.accumulated_token_usage).toBe(900);
    expect(recs[3].usage.accumulated_token_usage).toBe(2600);
    expect(lines.join('\n')).toContain('"prompt_tokens":130');
    expect(lines.join('\n')).toContain('"completion_tokens":1570');

    // шапка дампа: состав ключей и модель
    const header = on.headerLines();
    expect(header).toHaveLength(1);
    expect(header[0]).toContain('turns=4');
    expect(header[0]).toContain('chatMessages=4');
    expect(header[0]).toContain('modelType=expert');
    expect(header[0]).toContain('accumulated_token_usage');
    expect(header[0]).toContain('prompt_tokens');
    expect(header[0]).toContain('completion_tokens');
    expect(header[0]).toContain('total_tokens');
    expect(header[0]).toContain('cache_read_tokens');
  });

  test('дамп однократный: повторная загрузка истории той же страницы его не повторяет', async () => {
    await on.history();
    await settle();
    expect(on.headerLines()).toHaveLength(1);
    expect(on.turnLines()).toHaveLength(4);
  });
});

// ======================= 2) счётчики netMsgs/domMsgs в svc-emit-trace =======================

describe('O-26 (2): счётчики netMsgs/domMsgs в trace-строке svc-emit', () => {
  const contentSrc = require('./helpers/content-source.js').readSource('core/content.js');

  // Тело trace-блока как оно есть в content.js: от чтения siteName до закрытия if.
  function traceRegion() {
    const start = contentSrc.indexOf("var siteNameS1 = currentAdapter.siteName || '';");
    expect(start).toBeGreaterThan(-1);
    const marker = contentSrc.indexOf("' histWritePath=' + histWritePathS1);", start);
    expect(marker).toBeGreaterThan(-1);
    const end = contentSrc.indexOf('\n    }', marker) + '\n    }'.length;
    return contentSrc.slice(start, end);
  }
  const countOf = (s, sub) => s.split(sub).length - 1;

  test('trace-строка печатает msgs, domMsgs и netMsgs из уже существующих переменных', () => {
    const logged = [];
    const run = new Function('currentAdapter', 'getCurrentConvId', 'baseSeen', 'lastBaseTexts', 'debugLog',
      traceRegion());
    // сеть: 13 ходов в turnsMap-базе, DOM-адаптер извлёк 8 (та самая живая пара 13→8)
    run({ siteName: 'deepseek', extractMessages: () => new Array(8) }, () => 'conv-1',
      true, new Array(13), (lvl, msg) => logged.push(msg));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('[AI CM][svc-emit-trace]');
    expect(logged[0]).toContain('site=deepseek');
    expect(logged[0]).toContain(' msgs=8');
    expect(logged[0]).toContain(' domMsgs=8');
    expect(logged[0]).toContain(' netMsgs=13');
    expect(logged[0]).toContain('histWritePath=network');
  });

  test('поведение эмита не изменилось: gemini по-прежнему не логирует, adapter-путь виден', () => {
    const logged = [];
    const run = new Function('currentAdapter', 'getCurrentConvId', 'baseSeen', 'lastBaseTexts', 'debugLog',
      traceRegion());
    run({ siteName: 'gemini', extractMessages: () => new Array(8) }, () => 'c', true,
      new Array(13), (lvl, msg) => logged.push(msg));
    expect(logged).toHaveLength(0);                       // прежний гейт «не gemini»

    run({ siteName: 'deepseek' }, () => 'c', false, [],
      (lvl, msg) => logged.push(msg));                    // нет extractMessages и пустая база
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(' msgs=0');
    expect(logged[0]).toContain(' netMsgs=0');
    expect(logged[0]).toContain('histWritePath=adapter');
  });

  test('source-пин: счётчики живут ТОЛЬКО в log-строке (тело эмита байтово прежнее)', () => {
    const region = traceRegion();
    // Ни одного вхождения новых счётчиков за пределами trace-блока: эмит-пейлоад,
    // база (lastBaseTexts/baseText/baseCount) и экспорт их не видят.
    expect(countOf(contentSrc, 'netMsgs')).toBe(countOf(region, 'netMsgs'));
    expect(countOf(contentSrc, 'domMsgs')).toBe(countOf(region, 'domMsgs'));
    expect(countOf(contentSrc, 'netMsgsS1')).toBe(2);     // объявление + печать
    expect(countOf(contentSrc, 'domMsgsS1')).toBe(3);     // объявление + msgs + domMsgs
    // Прежние поля строки не переписаны — добавлены ровно два рядом с msgs.
    expect(region).toContain("' msgs=' + domMsgsS1 +");
    expect(region).toContain("' domMsgs=' + domMsgsS1 +");
    expect(region).toContain("' netMsgs=' + netMsgsS1 +");
    expect(region).toContain("' convId=' + (getCurrentConvId() || '') +");
    expect(region).toContain("' histWritePath=' + histWritePathS1);");
    // источники счётчиков — уже существующие переменные (новых коллекций/кэшей нет)
    expect(contentSrc).toContain('var netMsgsS1 = lastBaseTexts.length;');
    expect(contentSrc).toContain("var domMsgsS1 = (typeof currentAdapter.extractMessages === 'function') ? currentAdapter.extractMessages().length : 0;");
  });

  test('не тронуты: санация O-20, экспортный пайплайн, прочие адаптеры, версия', () => {
    const pipe = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
    const manifest = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
    expect(pipe).toContain('sanitizeEmitMessages');
    expect(pipe).not.toContain('netMsgs');
    expect(pipe).not.toContain('domMsgs');
    expect(manifest).not.toContain('netMsgs');
    expect(fs.readFileSync(path.join(ROOT, 'adapters', 'gemini-adapter.js'), 'utf8')).not.toContain('domMsgs');
    expect(fs.readFileSync(path.join(ROOT, 'adapters', 'deepseek-adapter.js'), 'utf8')).not.toContain('netMsgs');
  });
});
