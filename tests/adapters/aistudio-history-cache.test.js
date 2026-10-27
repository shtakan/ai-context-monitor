'use strict';

/**
 * AI Studio: кэш разобранной истории в sessionStorage (v2.0.30).
 *
 * Зачем: холодное открытие /prompts/<id> показывает «2 узла» — DOM виртуализирован,
 * а полная история приходит только с ResolveDriveResource/UpdatePrompt. Разобранный
 * снимок прошлой загрузки вкладки отдаётся ДО первого DOM-замера.
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
    CACHE_SECTION + '\nreturn {' +
    ' ingest: aiCmIngestAistudioNet,' +
    ' restore: aiCmAistudioHistoryCacheRestore,' +
    ' save: aiCmAistudioHistoryCacheSave,' +
    ' clear: aiCmAistudioHistoryCacheClear,' +
    ' key: aiCmAistudioCacheKey,' +
    ' pathOf: aiCmAistudioPathOf,' +
    ' state: function () {' +
    '   return { msgs: aiCmNetMsgsAistudio, count: aiCmNetCountAistudio, net: netServerTokens };' +
    ' }' +
    ' };'
  );
  return factory(win, store, 0, function () { }, function () { }, null);
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
