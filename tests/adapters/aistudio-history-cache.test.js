'use strict';

/**
 * AI Studio: кэш разобранной истории в sessionStorage (v2.0.30, DOM-пик — v2.0.31).
 *
 * Зачем: холодное открытие /prompts/<id> показывает «2 узла» — DOM виртуализирован,
 * а полная история приходит только с ResolveDriveResource/UpdatePrompt. Разобранный
 * снимок прошлой загрузки вкладки отдаётся ДО первого DOM-замера.
 *
 * ДВА ИСТОЧНИКА СНИМКА (одна схема записи):
 *   • сеть — ai-cm-aistudio-net { kind: 'history' } (aiCmAistudioHistoryCacheSave);
 *   • DOM  — список адаптера на КАЖДОМ росте msgs (aiCmAistudioDomCacheSave): лента
 *     успевает отрисовать полную историю (6 реплик) и тут же схлопывается до 2
 *     виртуализированных узлов, поэтому пик нельзя взять «когда-нибудь потом».
 * Кэш хранит ПИК: запись меньшего count не перезаписывает большую (high-water mark).
 *
 * Тестируется вырезанный из core/content.js участок (как и остальные тесты проекта
 * грузят срезы main-перехватчика): от `var aiCmNetMsgsAistudio` до вызова
 * восстановления на инициализации. Окно подменено (нужен hostname aistudio.google.com),
 * хранилище — настоящее window.sessionStorage из jsdom, хелперы — заглушки.
 */

const fs = require('fs');
const path = require('path');

const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'content.js'), 'utf8');
const START_MARK = 'var aiCmNetMsgsAistudio = null;';
const END_MARK = 'aiCmAistudioHistoryCacheRestore();';

function extractCacheSection() {
  const from = CONTENT_SRC.indexOf(START_MARK);
  const to = CONTENT_SRC.indexOf(END_MARK, from);
  if (from < 0 || to < 0) throw new Error('cache section not found in core/content.js');
  return CONTENT_SRC.slice(from, to + END_MARK.length);
}

const CACHE_SECTION = extractCacheSection();

const AISTUDIO_HOST = 'https://aistudio.google.com';

/** Минимальное окно: только то, что читает участок кэша. */
function makeWin(pathname) {
  const loc = { hostname: 'aistudio.google.com', href: AISTUDIO_HOST + pathname };
  return {
    location: loc,
    addEventListener: function () { },
    removeEventListener: function () { },
    dispatchEvent: function () { return true; }
  };
}

/** Сдвиг страницы внутри SPA (history.pushState в реальном AI Studio). */
function goto(win, pathname) {
  win.location.href = AISTUDIO_HOST + pathname;
}

function loadCache(win, storage) {
  const store = storage || window.sessionStorage;
  const factory = new Function(
    'window', 'sessionStorage', 'netServerTokens', 'debugLog', 'swallowSoft', 'aiCmBridgeDetail',
    'detectedModelSlug',
    CACHE_SECTION + '\nreturn {' +
    ' ingest: aiCmIngestAistudioNet,' +
    ' restore: aiCmAistudioHistoryCacheRestore,' +
    ' save: aiCmAistudioHistoryCacheSave,' +
    ' domSave: aiCmAistudioDomCacheSave,' +
    ' clear: aiCmAistudioHistoryCacheClear,' +
    ' key: aiCmAistudioCacheKey,' +
    ' pathOf: aiCmAistudioPathOf,' +
    ' peak: function () { return aiCmAistudioPeakCount; },' +
    // v2.0.32: модель чата — состояние среза и то, что реально читают адаптер/резолвер.
    ' setSlug: function (v) { aiCmNetModelSlugAistudio = v; },' +
    ' netSlug: function () { return aiCmNetModelSlugAistudio; },' +
    ' detected: function () { return detectedModelSlug; },' +
    ' state: function () {' +
    '   return { msgs: aiCmNetMsgsAistudio, count: aiCmNetCountAistudio, net: netServerTokens };' +
    ' }' +
    ' };'
  );
  return factory(win, store, 0, function () { }, function () { }, null, '');
}

const KEY_1 = 'ai_cm_aistudio_history_conv-1';
const KEY_2 = 'ai_cm_aistudio_history_conv-2';
const URL_1 = AISTUDIO_HOST + '/prompts/conv-1';
const URL_2 = AISTUDIO_HOST + '/prompts/conv-2';

const MSGS = [
  { role: 'user', text: 'первый вопрос' },
  { role: 'model', text: 'первый ответ' },
  { role: 'user', text: 'второй вопрос' },
  { role: 'model', text: 'второй ответ' },
  { role: 'user', text: 'третий вопрос' },
  { role: 'model', text: 'третий ответ' }
];

function seed(storage, key, payload) {
  storage.setItem(key, JSON.stringify(Object.assign({
    v: 1,
    href: URL_1,
    msgs: MSGS,
    count: MSGS.length,
    serverTokens: 486,
    ts: 111
  }, payload || {})));
}

describe('content.js: кэш истории AI Studio в sessionStorage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('ключ кэша — разговор из пути /prompts/<id>', () => {
    const api = loadCache(makeWin('/prompts/conv-42'));
    expect(api.key()).toBe('ai_cm_aistudio_history_conv-42');
    expect(api.key(AISTUDIO_HOST + '/prompts/abc?x=1')).toBe('ai_cm_aistudio_history_abc');
    expect(api.pathOf(AISTUDIO_HOST + '/prompts/abc')).toBe('/prompts/abc');
  });

  test('восстановление: снимок доезжает до первого замера (а не 2 узла)', () => {
    seed(window.sessionStorage, KEY_1);
    const win = makeWin('/prompts/conv-1');
    const api = loadCache(win);

    // восстановление уже отработало при инициализации среза
    const st = api.state();
    expect(st.msgs).not.toBeNull();
    expect(st.msgs.count).toBe(6);
    expect(st.msgs.msgs[1]).toEqual({ role: 'assistant', text: 'первый ответ' });
    expect(st.msgs.href).toBe(URL_1);
    // серверный счётчик из кэша тоже подхвачен
    expect(st.net).toBe(486);
    // общая точка для адаптера
    expect(win.__aiCmNetMsgs).toBe(st.msgs);
  });

  test('живая история сохраняется и переживает перезагрузку вкладки', () => {
    const win = makeWin('/prompts/conv-1');
    const first = loadCache(win);
    expect(first.state().msgs).toBeNull();

    expect(first.ingest({
      kind: 'history',
      msgs: MSGS,
      count: 6,
      href: win.location.href,
      ts: 222
    })).toBe(true);
    // сохранение делает обработчик события; здесь — та же функция напрямую
    expect(first.save()).toBe(true);
    expect(window.sessionStorage.getItem(KEY_1)).toBeTruthy();

    // «F5»: новый экземпляр content.js читает ту же sessionStorage
    const second = loadCache(makeWin('/prompts/conv-1'));
    expect(second.state().msgs.count).toBe(6);
    expect(second.state().msgs.ts).toBe(222);
  });

  test('смена чата удаляет запись ПРЕДЫДУЩЕГО разговора', () => {
    seed(window.sessionStorage, KEY_1);
    const win = makeWin('/prompts/conv-1');
    const api = loadCache(win);
    expect(window.sessionStorage.getItem(KEY_1)).toBeTruthy();

    goto(win, '/prompts/conv-2');
    expect(api.clear()).toBe(true);
    expect(window.sessionStorage.getItem(KEY_1)).toBeNull();
    // запись нового разговора не создаётся сбросом
    expect(window.sessionStorage.getItem(KEY_2)).toBeNull();
  });

  test('холостой сброс на том же пути кэш не трогает', () => {
    seed(window.sessionStorage, KEY_1);
    const api = loadCache(makeWin('/prompts/conv-1'));
    expect(api.clear()).toBe(false);
    expect(window.sessionStorage.getItem(KEY_1)).toBeTruthy();
  });

  test('кэш другого разговора (SPA-подмена пути) не восстанавливается', () => {
    seed(window.sessionStorage, KEY_1);
    const win = makeWin('/prompts/conv-2');
    const api = loadCache(win);
    expect(api.state().msgs).toBeNull();
    expect(win.__aiCmNetMsgs).toBeUndefined();
  });

  test('битый JSON / чужая версия / пустая история — молча пропускаются', () => {
    const win = makeWin('/prompts/conv-1');
    window.sessionStorage.setItem(KEY_1, '{not json');
    let api = loadCache(win);
    expect(api.state().msgs).toBeNull();

    window.sessionStorage.setItem(KEY_1, JSON.stringify({ v: 99, msgs: MSGS }));
    api = loadCache(win);
    expect(api.state().msgs).toBeNull();

    window.sessionStorage.setItem(KEY_1, JSON.stringify({ v: 1, href: URL_1, msgs: [] }));
    api = loadCache(win);
    expect(api.state().msgs).toBeNull();
  });

  test('ingest нормализует роли и отбрасывает пустые сообщения', () => {
    const win = makeWin('/prompts/conv-1');
    const api = loadCache(win);

    expect(api.ingest({
      kind: 'history',
      msgs: [
        { role: 'model', text: 'ответ' },
        { role: 'user', text: '' },
        { role: 'user', text: 'вопрос' }
      ],
      href: win.location.href,
      ts: 333
    })).toBe(true);

    const msgs = api.state().msgs.msgs;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'assistant', text: 'ответ' });
    expect(msgs[1]).toEqual({ role: 'user', text: 'вопрос' });
  });

  test('count-инжест: точный serverTokens попадает в состояние', () => {
    const api = loadCache(makeWin('/prompts/conv-1'));
    expect(api.ingest({ kind: 'count', serverTokens: '1234' })).toBe(true);
    expect(api.state().count).toBe(1234);
    expect(api.state().net).toBe(1234);
    // повтор того же значения — без лишнего пересчёта
    expect(api.ingest({ kind: 'count', serverTokens: 1234 })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * DOM-пик (v2.0.31): снимок адаптера на росте msgs
 * ------------------------------------------------------------------ */

/** Список в контракте адаптера: { role, content } — не { role, text }. */
function adapterMsgs(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ role: (i % 2 === 1) ? 'user' : 'assistant', content: 'реплика ' + i });
  }
  return out;
}

function stored(key) {
  const raw = window.sessionStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

describe('content.js: DOM-пик истории AI Studio в sessionStorage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('рост DOM пишется (6 реплик), повтор и сжатие ленты — нет', () => {
    const win = makeWin('/prompts/conv-1');
    const api = loadCache(win);

    expect(api.domSave(adapterMsgs(6))).toBe(true);
    const saved = stored(KEY_1);
    expect(saved.v).toBe(1);
    expect(saved.href).toBe(URL_1);
    expect(saved.count).toBe(6);
    expect(saved.msgs).toHaveLength(6);
    // контракт адаптера (content) приведён к схеме кэша (text)
    expect(saved.msgs[1]).toEqual({ role: 'assistant', text: 'реплика 2' });

    // коллапс ленты: 2 виртуализированных узла — это не рост
    expect(api.domSave(adapterMsgs(2))).toBe(false);
    expect(stored(KEY_1).count).toBe(6);
    // повтор того же размера — тоже не рост (нет лишних записей в storage)
    expect(api.domSave(adapterMsgs(6))).toBe(false);
    expect(api.peak()).toBe(6);
  });

  test('пик восстанавливается до initialize (F5 → сразу 6, а не 2)', () => {
    const first = loadCache(makeWin('/prompts/conv-1'));
    expect(first.domSave(adapterMsgs(6))).toBe(true);

    const win2 = makeWin('/prompts/conv-1');
    const second = loadCache(win2);
    // восстановление сработало на инициализации среза — до первого DOM-замера
    expect(second.state().msgs.count).toBe(6);
    expect(second.state().msgs.msgs[0]).toEqual({ role: 'user', text: 'реплика 1' });
    expect(win2.__aiCmNetMsgs).toBe(second.state().msgs);
    // и пик нового экземпляра уже знает про 6 — сжатие не перезапишет
    expect(second.peak()).toBe(6);
  });

  test('живой UpdatePrompt с меньшим count не затирает пик, с большим — пишет', () => {
    const win = makeWin('/prompts/conv-1');
    const api = loadCache(win);
    expect(api.domSave(adapterMsgs(6))).toBe(true);

    // сеть пришла после коллапса: 2 хода
    expect(api.ingest({
      kind: 'history', msgs: MSGS.slice(0, 2), href: win.location.href, ts: 501
    })).toBe(true);
    expect(api.save()).toBe(false);
    expect(stored(KEY_1).count).toBe(6);

    // а рост (7 ходов) кэш обновляет
    expect(api.ingest({
      kind: 'history',
      msgs: MSGS.concat([{ role: 'user', text: 'ещё один ход' }]),
      href: win.location.href,
      ts: 502
    })).toBe(true);
    expect(api.save()).toBe(true);
    expect(stored(KEY_1).count).toBe(7);
  });

  test('смена чата обнуляет пик: у нового разговора своя история', () => {
    const win = makeWin('/prompts/conv-1');
    const api = loadCache(win);
    expect(api.domSave(adapterMsgs(6))).toBe(true);

    goto(win, '/prompts/conv-2');
    expect(api.clear()).toBe(true);
    expect(api.peak()).toBe(0);
    // 2 реплики на новом разговоре — это рост для него, запись создаётся
    expect(api.domSave(adapterMsgs(2))).toBe(true);
    expect(stored(KEY_2).count).toBe(2);
    expect(window.sessionStorage.getItem(KEY_1)).toBeNull();
  });

  test('не AI Studio и пустые списки не пишутся', () => {
    const geminiWin = {
      location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app/abc' },
      addEventListener: function () { },
      removeEventListener: function () { },
      dispatchEvent: function () { return true; }
    };
    expect(loadCache(geminiWin).domSave(adapterMsgs(6))).toBe(false);
    expect(window.sessionStorage.length).toBe(0);

    const api = loadCache(makeWin('/prompts/conv-1'));
    expect(api.domSave(null)).toBe(false);
    expect(api.domSave([])).toBe(false);
    // список есть, но текста нет ни в одной реплике — писать нечего
    expect(api.domSave([{ role: 'user', content: '' }, { role: 'assistant' }])).toBe(false);
    expect(window.sessionStorage.getItem(KEY_1)).toBeNull();
  });
});

describe('content.js: модель чата в кэше истории AI Studio (v2.0.32)', () => {
  // Зачем: бейдж показывал константу адаптера 'Gemini 3.1 Pro' на чате с 'Gemini 3.8 Flash'.
  // Слаг приходит только с тела GenerateContent, поэтому кэш обязан его помнить — иначе после
  // F5 (до первого хода) детектор снова уходил в фолбэк.
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('сетевой снимок пишет модель, восстановление её применяет', () => {
    const win = makeWin('/prompts/conv-1');
    const api = loadCache(win);
    api.setSlug('gemini-3.8-flash');
    expect(api.ingest({ kind: 'history', msgs: MSGS, href: win.location.href, ts: 700 })).toBe(true);
    expect(api.save()).toBe(true);
    expect(stored(KEY_1).model).toBe('gemini-3.8-flash');

    // «F5»: новый документ, тот же чат
    const win2 = makeWin('/prompts/conv-1');
    const api2 = loadCache(win2);
    expect(api2.state().msgs.count).toBe(MSGS.length);
    expect(api2.detected()).toBe('gemini-3.8-flash');
    expect(api2.netSlug()).toBe('gemini-3.8-flash');
    expect(win2.__aiCmNetModelSlug).toBe('gemini-3.8-flash');
  });

  test('DOM-пик тоже помнит модель (после F5 модель видна до первого хода)', () => {
    const win = makeWin('/prompts/conv-2');
    const api = loadCache(win);
    api.setSlug('gemini-3.8-pro');
    expect(api.domSave(adapterMsgs(4))).toBe(true);
    expect(stored(KEY_2).model).toBe('gemini-3.8-pro');

    const api2 = loadCache(makeWin('/prompts/conv-2'));
    expect(api2.detected()).toBe('gemini-3.8-pro');
  });

  test('смена чата стирает модель ПРЕДЫДУЩЕГО разговора', () => {
    const win = makeWin('/prompts/conv-1');
    const api = loadCache(win);
    api.setSlug('gemini-3.8-flash');
    expect(api.domSave(adapterMsgs(3))).toBe(true);

    goto(win, '/prompts/conv-2');
    expect(api.clear()).toBe(true);
    expect(api.netSlug()).toBe('');
    expect(win.__aiCmNetModelSlug).toBe('');
  });

  test('старая запись без model не подставляет чужую модель', () => {
    seed(window.sessionStorage, KEY_1); // model в записи нет
    const api = loadCache(makeWin('/prompts/conv-1'));
    expect(api.state().msgs.count).toBe(MSGS.length);
    expect(api.detected()).toBe('');
    expect(api.netSlug()).toBe('');
  });
});
