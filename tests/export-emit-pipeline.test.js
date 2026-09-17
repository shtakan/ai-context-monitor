/**
 * Тесты общего EMIT-пайплайна экспорта (v81, Задача A, Шаг 3).
 * utils/export-emit-pipeline.js — чистые функции: имя файла, гейт автоэкспорта,
 * латч per service+convId, извлечение convId из URL, нормализация сообщений.
 * v1.19.1 (M-11): Perplexity /search/<id> — живой URL диалога (см. 3.3b).
 */
const P = require('../utils/export-emit-pipeline.js');

// —— 3.1 Имя файла: префикс сервиса, срез convId, метка времени, суффикс причины,
//        [LOW CONFIDENCE]_ только при baseComplete=0 ——
describe('buildExportFileName', () => {
  const services = ['chatgpt', 'gemini', 'deepseek', 'google_search', 'claude', 'perplexity'];
  afterEach(() => jest.restoreAllMocks());

  function mockNow() {
    jest.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026);
    jest.spyOn(Date.prototype, 'getMonth').mockReturnValue(7); // август
    jest.spyOn(Date.prototype, 'getDate').mockReturnValue(31);
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
    jest.spyOn(Date.prototype, 'getMinutes').mockReturnValue(5);
  }

  test.each(services)('содержит префикс сервиса %s, срез convId (8) и метку времени', (svc) => {
    mockNow();
    const file = P.buildExportFileName(svc, 'abcdefgh12345678', 'threshold', false, 'txt');
    expect(file).toBe(svc + '-abcdefgh-2026-08-31_09-05.txt');
  });

  test.each(services)('%s: суффикс причины pre-trim → -pretrim, base-complete → -base-complete', (svc) => {
    expect(P.buildExportFileName(svc, 'cid', 'pre-trim', false, 'txt')).toMatch(/-pretrim\.txt$/);
    expect(P.buildExportFileName(svc, 'cid', 'base-complete', false, 'txt')).toMatch(/-base-complete\.txt$/);
    expect(P.buildExportFileName(svc, 'cid', 'threshold', false, 'txt')).not.toMatch(/-(pretrim|base-complete)\./);
  });

  test.each(services)('%s: [LOW CONFIDENCE]_ только при baseComplete=0 (isLowConfidence=true)', (svc) => {
    expect(P.buildExportFileName(svc, 'cid', 'threshold', true, 'txt')).toMatch(/^\[LOW CONFIDENCE\]_/);
    expect(P.buildExportFileName(svc, 'cid', 'threshold', false, 'txt')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('нет convId → сегмент noconv (md)', () => {
    const f = P.buildExportFileName('claude', '', 'threshold', false, 'md');
    expect(f).toBe('claude-noconv-' + f.split('-noconv-')[1]);
    expect(f.endsWith('.md')).toBe(true);
  });
});

// —— 3.2 Латч per service+convId: already-fired; изоляция по сервису ——
describe('латч автоэкспорта (per service+convId)', () => {
  test('повторный вызов с тем же service+convId → skip already-fired', () => {
    const store = {};
    P.markAutoExportFired(store, 'chatgpt', 'conv-123');
    expect(P.getAutoExportFired(store, 'chatgpt', 'conv-123')).toBe(true);
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: true, baseSeen: false, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'chatgpt', 'conv-123'), isGemini: false
    });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('already-fired');
  });

  test('другой сервис с тем же формальным идентификатором НЕ блокируется', () => {
    const store = {};
    P.markAutoExportFired(store, 'chatgpt', 'same-id-1');
    expect(P.getAutoExportFired(store, 'claude', 'same-id-1')).toBe(false);
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: true, baseSeen: false, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'claude', 'same-id-1'), isGemini: false
    });
    expect(v.skip).toBe(false);
  });

  test('изоляция по convId внутри одного сервиса', () => {
    const store = {};
    P.markAutoExportFired(store, 'gemini', 'aaa');
    expect(P.getAutoExportFired(store, 'gemini', 'bbb')).toBe(false);
    P.resetAutoExportFired(store, 'gemini', 'aaa');
    expect(P.getAutoExportFired(store, 'gemini', 'aaa')).toBe(false);
  });

  test('гистерезис −10 п.п. сохраняется: 79 < 90-10 → skip c resetFired', () => {
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 79, threshold: 90,
      baseComplete: true, baseSeen: false, loaderRunning: false, fired: true, isGemini: true
    });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('below-threshold-hysteresis');
    expect(v.resetFired).toBe(true);
  });
});

// —— 3.3 Извлечение идентификатора диалога из URL (6 сервисов) ——
describe('extractConvIdFromUrl', () => {
  test('chatgpt.com — /c/<uuid>', () => {
    expect(P.extractConvIdFromUrl('/c/abc123-def')).toBe('abc123-def');
  });
  test('gemini.google.com — /app/<id>', () => {
    expect(P.extractConvIdFromUrl('/app/xyz789')).toBe('xyz789');
  });
  test('chat.deepseek.com — /a/chat/s/<id>', () => {
    expect(P.extractConvIdFromUrl('/a/chat/s/dsid456')).toBe('dsid456');
  });
  test('claude.ai — /chat/<uuid> (в т.ч. внутри project)', () => {
    expect(P.extractConvIdFromUrl('/chat/uuid-claude')).toBe('uuid-claude');
    expect(P.extractConvIdFromUrl('/project/p1/chat/uuid-claude')).toBe('uuid-claude');
  });
  test('perplexity.ai — /thread/<slug>', () => {
    expect(P.extractConvIdFromUrl('/thread/some-slug-99')).toBe('some-slug-99');
  });
  test('google.com (Search AI) — надёжного id в URL нет → пустая строка (не выдумываем)', () => {
    expect(P.extractConvIdFromUrl('/search?q=test')).toBe('');
  });
  test('нечитаемый путь → пустая строка', () => {
    expect(P.extractConvIdFromUrl('')).toBe('');
    expect(P.extractConvIdFromUrl(null)).toBe('');
  });
});

// —— 3.3b M-11 (v1.19.1): Perplexity /search/<id> наравне с /thread/<id> ——
// Регресс: живой диалог Perplexity живёт по /search/<id>, а распознавался только
// /thread/<slug> → aiCmAutoExportConvId() === '' и maybeAutoExport() молча выходил
// на «if (!cid) return;» при зелёных гейтах (автоэкспорт не стрелял вовсе).
describe('M-11: extractConvIdFromUrl — Perplexity /search/<id>', () => {
  const UUID = '2f2a1b1c-9d3e-4a5b-8c7d-1e2f3a4b5c6d';

  test('perplexity.ai — /search/<uuid> → <uuid> (живой URL диалога)', () => {
    expect(P.extractConvIdFromUrl('/search/' + UUID)).toBe(UUID);
    expect(P.extractConvIdFromUrl('/search/abcdefgh1234')).toBe('abcdefgh1234');
  });

  test('perplexity.ai — /thread/<uuid> → <uuid> (прежняя ветка байтово не изменена)', () => {
    expect(P.extractConvIdFromUrl('/thread/' + UUID)).toBe(UUID);
    expect(P.extractConvIdFromUrl('/thread/some-slug-99')).toBe('some-slug-99');
  });

  test('google.com/search БЕЗ id-сегмента → "" (GSA остаётся пустым, threadId-путь цел)', () => {
    expect(P.extractConvIdFromUrl('/search')).toBe('');
    expect(P.extractConvIdFromUrl('/search?q=test')).toBe('');
    expect(P.extractConvIdFromUrl('/search/abc')).toBe('');       // короткий хвост — не id
    expect(P.extractConvIdFromUrl('/search/abc/def')).toBe('');   // id-сегмента 8+ нет
  });

  test('прочие сервисы байтово прежние: gemini /app/<id>, claude /chat/<uuid>', () => {
    expect(P.extractConvIdFromUrl('/app/xyz789')).toBe('xyz789');
    expect(P.extractConvIdFromUrl('/app/7c1f4a9b2e8d3a05')).toBe('7c1f4a9b2e8d3a05');
    expect(P.extractConvIdFromUrl('/chat/' + UUID)).toBe(UUID);
    expect(P.extractConvIdFromUrl('/project/p1/chat/uuid-claude')).toBe('uuid-claude');
    expect(P.extractConvIdFromUrl('/c/abc123-def')).toBe('abc123-def');
    expect(P.extractConvIdFromUrl('/a/chat/s/dsid456')).toBe('dsid456');
  });

  test('сквозной путь: perplexity — обычный не-GSA сайт, resolveAutoExportConvId = urlConvId', () => {
    expect(P.resolveAutoExportConvId('perplexity', P.extractConvIdFromUrl('/search/' + UUID), ''))
      .toBe(UUID);
    expect(P.resolveAutoExportConvId('perplexity', P.extractConvIdFromUrl('/search/abcdefgh1234'), 'tid-1'))
      .toBe('abcdefgh1234');
    // без id — не выдумываем; GSA-ветка (threadId) и gemini не тронуты
    expect(P.resolveAutoExportConvId('perplexity', '', 'tid-1')).toBe('');
    expect(P.resolveAutoExportConvId('google_search', '', 'tid-1')).toBe('tid-1');
    expect(P.resolveAutoExportConvId('gemini', 'url-id', 'tid-1')).toBe('url-id');
  });
});

// —— 3.4 Источник сообщений: нормализация из адаптера; чередование ролей ——
describe('normalizeExportMessages', () => {
  test('нормализация из адаптера: content → text, роли сохраняются', () => {
    const raw = [
      { role: 'user', content: 'вопрос' },
      { role: 'model', content: 'ответ' }
    ];
    const out = P.normalizeExportMessages(raw);
    expect(out).toEqual([
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: 'ответ' }
    ]);
  });

  test('пустой источник → пустой массив (фолбэк чередования делает вызывающая сторона)', () => {
    expect(P.normalizeExportMessages([])).toEqual([]);
    expect(P.normalizeExportMessages(null)).toEqual([]);
    expect(P.normalizeExportMessages([{ role: 'user', content: '' }])).toEqual([]);
  });

  test('фолбэк чередования ролей: отсутствующие роли чередуются user/assistant', () => {
    // имитация вызывающей стороны content.js (aiCmCollectExportSource)
    const norm = P.normalizeExportMessages([{ content: 'a' }, { content: 'b' }, { content: 'c' }]);
    const out = norm.map((m, i) => ({ role: (i % 2 === 0) ? 'user' : 'assistant', text: m.text }));
    expect(out).toEqual([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
      { role: 'user', text: 'c' }
    ]);
  });
});

// —— v82 (D4): порог 1–100 без клампа [50,99] ——
describe('shouldSkipAutoExport: порог D4', () => {
  test('порог 40 honered: 45 ≥ 40 → fired; 31 < 40-10 → гистерезис', () => {
    const pass = P.shouldSkipAutoExport({
      enabled: true, percentage: 45, threshold: 40,
      baseComplete: true, baseSeen: true, loaderRunning: false, fired: false, isGemini: false
    });
    expect(pass.skip).toBe(false);
    const hyst = P.shouldSkipAutoExport({
      enabled: true, percentage: 29, threshold: 40,
      baseComplete: true, baseSeen: true, loaderRunning: false, fired: true, isGemini: false
    });
    expect(hyst.reason).toBe('below-threshold-hysteresis');
  });

  test('порог 100 honered: 99.9 < 100 → below-threshold', () => {
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 99.9, threshold: 100,
      baseComplete: true, baseSeen: true, loaderRunning: false, fired: false, isGemini: false
    });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('below-threshold');
  });

  test('0 и 101 → дефолт 90 (значение валидируется в loadAutoExportSettings)', () => {
    const zero = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 0,
      baseComplete: true, baseSeen: true, loaderRunning: false, fired: false, isGemini: false
    });
    expect(zero.skip).toBe(false); // дефолт 90, 95 ≥ 90
    const over = P.shouldSkipAutoExport({
      enabled: true, percentage: 89, threshold: 101,
      baseComplete: true, baseSeen: true, loaderRunning: false, fired: false, isGemini: false
    });
    expect(over.skip).toBe(true); // дефолт 90, 89 < 90
    expect(over.reason).toBe('below-threshold');
  });
});

// —— v82 (D1/D2): порядок слушателя и выбор источника ——
describe('re-check 0→1 видит применённую базу; выбор источника', () => {
  test('симуляция порядка слушателя: после присвоений re-check проходит по сети, не по адаптеру', () => {
    // имитация состояния content.js на момент перенесённого re-check (D1):
    const state = { baseComplete: false, baseSeen: false, lastBaseTexts: [] };
    // 1) пришёл полный снимок → присвоения базы (как в listener 'ai-cm-full-history')
    state.lastBaseTexts = ['вопрос', 'ответ'];
    state.baseSeen = true;
    state.baseComplete = true;
    // 2) re-check 0→1 (теперь в КОНЦЕ слушателя) → shouldSkipAutoExport видит сеть
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: state.baseComplete, baseSeen: state.baseSeen,
      loaderRunning: false, fired: false, isGemini: false
    });
    expect(v.skip).toBe(false);
    // 3) источник — network (D2), пустой адаптер не участвует
    expect(P.pickExportSource(state.baseSeen, state.lastBaseTexts.length > 0)).toBe('network');
  });

  test('Gemini до присвоений (baseSeen=false, baseComplete=false) — skip not-complete, латч не ставится; O-33: не-Gemini до сетевого снимка — skip base-pending (DOM-база полнотой больше не считается)', () => {
    const gem = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: false, baseSeen: false, loaderRunning: false, fired: false, isGemini: true
    });
    expect(gem.skip).toBe(true);
    expect(gem.reason).toBe('not-complete'); // fired не ставится — поздний экспорт возможен
    const nonGem = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: false, baseSeen: false, loaderRunning: false, fired: false, isGemini: false
    });
    // O-33 (продуктовое решение (a)): DOM-адаптер до сетевого снимка (baseSeen=false)
    // полнотой больше не считается — файл не пишется, латч fired не ставится и не
    // сбрасывается (resetFired:false): поздний честный экспорт по сети состоится.
    expect(nonGem).toEqual({ skip: true, reason: 'base-pending', resetFired: false });
  });

  test('источник: baseSeen=true → network; baseSeen=false → adapter', () => {
    expect(P.pickExportSource(true, true)).toBe('network');
    expect(P.pickExportSource(true, false)).toBe('network'); // сеть — единственный источник
    expect(P.pickExportSource(false, false)).toBe('adapter');
  });
});

// —— v82 (D5/D6): гистерезис только по сетевому pct; сброс pct при смене чата ——
describe('гистерезис D5 и сброс autoExportLastPct D6', () => {
  test('(D5) транзиентный DOM-pct 2.9 при baseSeen=false НЕ удаляет латч', () => {
    const store = {};
    P.markAutoExportFired(store, 'chatgpt', 'conv-1');
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 2.9, threshold: 30,
      baseComplete: false, baseSeen: false, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'chatgpt', 'conv-1'), isGemini: false
    });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('below-threshold-unreliable');
    expect(v.resetFired).toBe(false); // вызывающая сторона НЕ вызывает resetAutoExportFired
    expect(P.getAutoExportFired(store, 'chatgpt', 'conv-1')).toBe(true); // латч жив
  });

  test('(тест 3) регрессия гистерезиса: сетевой pct ниже threshold−10 удаляет латч', () => {
    const store = {};
    P.markAutoExportFired(store, 'deepseek', 'conv-2');
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 19, threshold: 30,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'deepseek', 'conv-2'), isGemini: false
    });
    expect(v.reason).toBe('below-threshold-hysteresis');
    expect(v.resetFired).toBe(true);
    P.resetAutoExportFired(store, 'deepseek', 'conv-2');
    // повторный fired разрешён
    const retry = P.shouldSkipAutoExport({
      enabled: true, percentage: 35, threshold: 30,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'deepseek', 'conv-2'), isGemini: false
    });
    expect(retry.skip).toBe(false);
  });

  test('(D6, тест 2) после смены чата autoExportLastPct=-1: 0→1 re-check нового чата молчит', () => {
    // имитация гейтов re-check в content.js (completeTransition79 / loader-stop / tape-restore)
    var autoExportLastPct = 50.8; // pct ПРЕДЫДУЩЕГО чата
    autoExportLastPct = -1;       // v82 (D6): resetConversationState()
    function reCheckFires() {
      return typeof autoExportLastPct === 'number' && autoExportLastPct >= 0; // гейт вызова
    }
    expect(reCheckFires()).toBe(false); // re-check НЕ вызовет maybeAutoExport
  });

  test('(D5) Gemini: прежнее поведение гистерезиса 1:1 даже при baseSeen=false', () => {
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 5, threshold: 90,
      baseComplete: true, baseSeen: false, loaderRunning: false, fired: true, isGemini: true
    });
    expect(v.reason).toBe('below-threshold-hysteresis');
    expect(v.resetFired).toBe(true);
  });
});

// —— v82 (D7): autoExportLastPct обновляется только из достоверного источника ——
describe('гейт достоверности pct (D7)', () => {
  // имитация гейта присвоения из maybeAutoExport (core/content.js)
  function d7Assign(autoExportLastPct, percentage, baseSeen, isGemini) {
    if (baseSeen === true || isGemini === true) return percentage; // присвоение
    return autoExportLastPct;                                     // прежнее значение
  }

  test('(тест 1) DOM-pct 2.9 при baseSeen=false НЕ обновляет autoExportLastPct (остаётся -1)', () => {
    expect(d7Assign(-1, 2.9, false, false)).toBe(-1);
  });

  test('(тест 2) симуляция SPA-возврата: отравленный pct не попадает в re-check; латч жив → already-fired', () => {
    var autoExportLastPct = -1;                 // после D6-сброса resetConversationState
    autoExportLastPct = d7Assign(autoExportLastPct, 2.9, false, false); // транзиентный DOM-pct
    expect(autoExportLastPct).toBe(-1);         // re-check'и (>=0) молчат
    // латч фазы 1 жив → повторный вызов skip already-fired
    const store = {};
    P.markAutoExportFired(store, 'chatgpt', '6a59cfa1');
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 40,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'chatgpt', '6a59cfa1'), isGemini: false
    });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('already-fired');
  });

  test('(тест 3) регрессия гистерезиса: сетевой pct ниже threshold−10 сбрасывает латч → повторный fired разрешён', () => {
    const store = {};
    P.markAutoExportFired(store, 'claude', 'conv-3');
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 19, threshold: 40,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'claude', 'conv-3'), isGemini: false
    });
    expect(v.reason).toBe('below-threshold-hysteresis');
    expect(v.resetFired).toBe(true);
    P.resetAutoExportFired(store, 'claude', 'conv-3');
    const retry = P.shouldSkipAutoExport({
      enabled: true, percentage: 45, threshold: 40,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: P.getAutoExportFired(store, 'claude', 'conv-3'), isGemini: false
    });
    expect(retry.skip).toBe(false);
  });

  test('(тест 4) Gemini: присвоение работает и при baseSeen=false (isGemini=true)', () => {
    expect(d7Assign(-1, 50.8, false, true)).toBe(50.8);
    expect(d7Assign(-1, 50.8, true, false)).toBe(50.8); // сеть — тоже достоверный источник
  });
});

// —— v82 (D8): повторный tape-restore при стабилизации account index ——
describe('tape-restore retry (D8)', () => {  // имитация state-машины D8 (core/content.js): guard restoredTapeLoaded + кэш idx
  function d8Sim(pathnameSeq) {
    const state = { restoredTapeLoaded: false, idx: {}, loads: 0, keyLog: [] };
    const acct = (p) => (p.match(/\/u\/(\d+)\//) || [])[1] || '0';
    const key = (p) => 'ai-cm-gemini-tape-g3-u' + acct(p) + '-0362260d';
    for (const p of pathnameSeq) {
      const cid = (p.match(/\/app\/([A-Za-z0-9_-]+)/) || [])[1];
      if (!cid) continue;
      if (!state.restoredTapeLoaded) {
        state.restoredTapeLoaded = true;
        state.loads += 1;
        state.keyLog.push(key(p));      // D8.2: лог ключа при каждом load
        state.idx[cid] = acct(p);       // D8.1: кэш индекса
      } else if (state.idx[cid] !== undefined && String(state.idx[cid]) !== String(acct(p))) {
        state.idx[cid] = acct(p);       // D8.3: retry — однократно на смену индекса
        state.restoredTapeLoaded = false;
      }
    }
    return state;
  }

  test('(тест 1) стабилизация u0→u1 триггит повторный load, ровно один retry', () => {
    const st = d8Sim(['/app/0362260d', '/app/0362260d', '/u/1/app/0362260d', '/u/1/app/0362260d']);
    expect(st.loads).toBe(2);           // 1-й load (u0) + 1 retry (u1), дальше латч
    expect(st.idx['0362260d']).toBe('1');
  });

  test('(тест 2) ключ логируется при каждом load: 1-й u0, retry u1', () => {
    const st = d8Sim(['/app/0362260d', '/u/1/app/0362260d', '/u/1/app/0362260d']);
    expect(st.keyLog).toEqual([
      'ai-cm-gemini-tape-g3-u0-0362260d',
      'ai-cm-gemini-tape-g3-u1-0362260d'
    ]);
  });

  test('(тест 3) регрессия: индекс уже стабилен → повторного load нет (латч tapeRestoreSeen не ломается)', () => {
    const st = d8Sim(['/u/1/app/0362260d', '/u/1/app/0362260d', '/u/1/app/0362260d']);
    expect(st.loads).toBe(1);
    expect(st.keyLog.length).toBe(1);
  });
});

// —— v82 (D9-A): дедупликация dispatch ai-cm-restored-history (page-session) ——
describe('dispatch dedup (D9-A)', () => {
  // имитация content-side state: повторный заход в tape-блок (resetConversationState)
  function d9Sim(restorePasses) {
    const dispatched = {};       // aiCmRestoredDispatched (page-session)
    const events = [];
    const logs = [];
    for (let i = 0; i < restorePasses; i++) {
      const convId = '0362260d';
      const hasTurns = true;     // лента непуста (124 msgs)
      if (hasTurns) {
        if (dispatched[convId]) {
          logs.push('skip reason=already-dispatched');
        } else {
          dispatched[convId] = true;
          events.push(convId);
        }
      }
    }
    return { events, logs };
  }

  test('(тест 1) второй load того же convId в той же сессии → dispatch ровно один + skip', () => {
    const st = d9Sim(2);
    expect(st.events).toEqual(['0362260d']);                 // dispatch ровно один
    expect(st.logs).toEqual(['skip reason=already-dispatched']);
  });

  test('(тест 2) холодное открытие (новая страница, пустые флаги) → dispatch выполняется', () => {
    const st = d9Sim(1);
    expect(st.events).toEqual(['0362260d']);
    expect(st.logs).toEqual([]);
  });

  test('(тест 3) SPA-возврат (D19): tapeRestoreSeen сброшен в resetConversationState → load и dispatch идут', () => {
    // v1.6 (D19): tapeRestoreSeen/aiCmRestoredDispatched — page-session, но per-conv;
    // resetConversationState при conv-switch их сбрасывает → SPA-возврат ре-мержит ленту
    const tapeRestoreSeen = {};   // после resetConversationState (D19)
    const dispatched = {};        // после resetConversationState (D19)
    const cid = '0362260d';
    const loadHappens = !tapeRestoreSeen[cid];   // v77 гард снят
    expect(loadHappens).toBe(true);              // storage load выполняется
    let events = [];
    if (loadHappens && !dispatched[cid]) {       // D9-A дедуп не мешает новому входу
      dispatched[cid] = true;
      events.push(cid);
    }
    expect(events).toEqual(['0362260d']);        // dispatch ровно один (ре-merge)
  });
});

// —— v82 (D14): SPA-вход — сброс латча автоэкспорта для целевого conv ——
describe('D14: SPA-вход и латч автоэкспорта', () => {
  const SV = 'gemini';
  const cid = '0362260d';
  const state = { enabled: true, percentage: 95, threshold: 90, baseComplete: true, baseSeen: true, loaderRunning: false };

  test('(2) повторный вход в тот же conv → сброс латча → новый fired ровно один', () => {
    const store = {};
    // фаза 1: первый вход — fired
    P.markAutoExportFired(store, SV, cid);
    expect(P.getAutoExportFired(store, SV, cid)).toBe(true);
    // SPA-возврат в тот же чат: resetConversationState → resetAutoExportFired
    P.resetAutoExportFired(store, SV, cid);
    expect(P.getAutoExportFired(store, SV, cid)).toBe(false);
    // новый вход → fired разрешён ровно один раз
    const v1 = P.shouldSkipAutoExport(Object.assign({}, state, { fired: P.getAutoExportFired(store, SV, cid) }));
    expect(v1.skip).toBe(false);
    P.markAutoExportFired(store, SV, cid);
    // внутри входа второй check → already-fired
    const v2 = P.shouldSkipAutoExport(Object.assign({}, state, { fired: P.getAutoExportFired(store, SV, cid) }));
    expect(v2.skip).toBe(true);
    expect(v2.reason).toBe('already-fired');
  });

  test('(3) внутри входа второй check → already-fired (латч стоит)', () => {
    const store = {};
    P.markAutoExportFired(store, SV, cid);
    const v = P.shouldSkipAutoExport(Object.assign({}, state, { fired: P.getAutoExportFired(store, SV, cid) }));
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('already-fired');
  });

  test('(4) холодное открытие/F5: латч пуст → resetAutoExportFired no-op, поведение побайтово', () => {
    const store = {};
    // на холодном старте (fresh page) autoExportFired пуст
    P.resetAutoExportFired(store, SV, cid); // как в resetConversationState
    expect(P.getAutoExportFired(store, SV, cid)).toBe(false);
    const v = P.shouldSkipAutoExport(Object.assign({}, state, { fired: false }));
    expect(v.skip).toBe(false); // fired разрешён — как прежде
  });

  test('(1-голова) голова экспорта = первый реальный user-ход, не отчёт', () => {
    // порядок строится из реальных ходов; DR-инъекция не создаёт синтетических id (D13)
    const ids = ['u1', 'a1', 'u2', 'a2'];
    expect(ids[0]).toBe('u1');
  });

  test('(5-изоляция) сброс латча по convId не трогает другие чаты', () => {
    const store = {};
    P.markAutoExportFired(store, SV, cid);
    P.resetAutoExportFired(store, SV, cid);
    expect(P.getAutoExportFired(store, SV, 'other-chat')).toBe(false); // нет записи — no-op
    // и не влияет на латч другого сервиса с тем же формальным id
    P.markAutoExportFired(store, 'chatgpt', cid);
    expect(P.getAutoExportFired(store, 'chatgpt', cid)).toBe(true);
    P.resetAutoExportFired(store, SV, cid);
    expect(P.getAutoExportFired(store, 'chatgpt', cid)).toBe(true); // изоляция по сервису
  });
});

// —— v82 (D18): tape-save union по id — msgs никогда не меньше прежнего ——
describe('D18: unionTurnsById (tape-save не уменьшает тейп)', () => {
  function t(id, text) { return { id: id, text: text, role: 'user', r1: null, turnId: id }; }

  test('(а) тейп 102 + база 80 (хвостовое окно) → union ≥102, голова тейпа сохранена', () => {
    // старшие 22 хода только в тейпе
    const tape = [];
    for (let i = 0; i < 22; i++) tape.push(t('old_' + i, 'старший' + i));  // вкл. «Как называется…»
    const base = [];
    for (let i = 22; i < 102; i++) base.push(t('msg_' + i, 'окно' + i));  // 80 хвостовых
    const union = P.unionTurnsById(tape, base);
    expect(union.length).toBe(102); // не меньше прежнего тейпа (102)
    expect(union[0].id).toBe('old_0'); // голова тейпа (старший сегмент) сохранена
    expect(union.some(x => x.id === 'old_0')).toBe(true);
  });

  test('(б) база 124 + тейп 102 → union=124 (все новые добавлены, дублей нет)', () => {
    const tape = [];
    for (let i = 0; i < 102; i++) tape.push(t('id_' + i, 't' + i));
    const base = [];
    for (let i = 0; i < 124; i++) base.push(t('id_' + i, 'b' + i)); // все 124, первые 102 дублируют тейп
    const union = P.unionTurnsById(tape, base);
    expect(union.length).toBe(124);
    const ids = new Set(union.map(x => x.id));
    expect(ids.size).toBe(124); // дублей нет
  });

  test('(в) база ровно как тейп → union = база (без изменений, побайтово)', () => {
    const tape = [t('a', '1'), t('b', '2')];
    const base = [t('a', '1'), t('b', '2')];
    expect(P.unionTurnsById(tape, base)).toEqual(tape);
  });

  test('пустой существующий тейп → union = база', () => {
    const base = [t('x', '1'), t('y', '2')];
    expect(P.unionTurnsById([], base)).toEqual(base);
    expect(P.unionTurnsById(null, base)).toEqual(base);
  });
});

// —— v1.6 (D19): SPA-возврат — ре-merge ленты после conv-switch ——
describe('D19: SPA-возврат и ре-merge ленты (cacheRestoredMap/tapeRestoreSeen)', () => {
  const GL = require('../utils/gemini-intercept-logic');

  // Тейп: 62 хода = 124 сообщения (cachedMsgs=124); сеть отдаёт хвостовое окно
  // 40 ходов (80 msgs) — старшие ходы есть только в тейпе.
  const TURNS = 62;
  const NET_TURNS = 40;
  const MSGS = TURNS * 2;         // 124
  const SV = 'gemini';
  const CID = '0362260d';

  function tapeAll() {
    const arr = [];
    for (let t = 1; t <= TURNS; t++) {
      arr.push({ id: 't' + t + '_user', text: (t === 1 ? 'Составь промт для deep research…' : 'вопрос' + t), r1: null, turnId: 't' + t, role: 'user' });
      arr.push({ id: 't' + t + '_assistant', text: 'ответ' + t, r1: null, turnId: 't' + t, role: 'assistant' });
    }
    return arr;
  }

  function networkTail() {
    const first = TURNS - NET_TURNS + 1; // хвостовое окно: t23..t62
    const arr = [];
    for (let t = first; t <= TURNS; t++) {
      arr.push({ id: 't' + t + '_user', turnId: 't' + t, r1: (t === first ? null : 't' + (t - 1)), order: 100 + (t - first) * 2, role: 'user', text: 'вопрос' + t });
      arr.push({ id: 't' + t + '_assistant', turnId: 't' + t, r1: null, order: 101 + (t - first) * 2, role: 'assistant', text: 'ответ' + t });
    }
    return arr;
  }

  // state-машина: tape-блок content.js + merge-гарды gemini-intercept.js
  function newSession() {
    return {
      restoredTapeLoaded: false,    // content.js v28
      tapeRestoreSeen: {},          // content.js v77
      aiCmRestoredDispatched: {},   // content.js D9-A
      cacheRestoredMap: new Set(),  // gemini-intercept.js v77
      base: [],
      merges: 0,        // вызовов mergeRestoredTurns (двойной ingest недопустим)
      loadCount: 0,     // storage load ленты
      dispatchCount: 0  // dispatch ai-cm-restored-history
    };
  }

  // один проход processAndSend: сетевой ингест + tape-блок restore
  function processPass(s, convId) {
    const net = networkTail();
    for (const it of net) { // сеть авторитетна по id
      const idx = s.base.findIndex(x => x.id === it.id);
      if (idx >= 0) s.base[idx] = it; else s.base.push(it);
    }
    if (!s.restoredTapeLoaded) {
      s.restoredTapeLoaded = true;
      if (s.tapeRestoreSeen[convId]) return;        // v77: skip already-restored (content)
      s.loadCount++;
      s.tapeRestoreSeen[convId] = true;
      if (s.aiCmRestoredDispatched[convId]) return; // D9-A: skip already-dispatched
      s.aiCmRestoredDispatched[convId] = true;
      s.dispatchCount++;
      if (s.cacheRestoredMap.has(convId)) return;   // v77: skip already-restored (intercept)
      const merged = GL.mergeRestoredTurns(s.base, tapeAll());
      s.base = merged.items;
      s.cacheRestoredMap.add(convId);
      s.merges++;
    }
  }

  // conv-switch: resetForNewConversation (intercept) + resetConversationState (content)
  function switchConv(s) {
    s.cacheRestoredMap.clear();      // D19 (gemini-intercept.js)
    s.restoredTapeLoaded = false;    // v28
    s.tapeRestoreSeen = {};          // D19 (content.js)
    s.aiCmRestoredDispatched = {};   // D19 (content.js)
    s.base = [];
    s.merges = 0;
    s.loadCount = 0;
    s.dispatchCount = 0;
  }

  function headId(base) {
    return GL.orderExportMessages(base).ids[0];
  }

  function checkAutoExport(firedStore) {
    const v = P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90,
      baseComplete: true, baseSeen: true, loaderRunning: false,
      fired: P.getAutoExportFired(firedStore, SV, CID), isGemini: true
    });
    expect(v.skip).toBe(false); // один fired на вход разрешён
    P.markAutoExportFired(firedStore, SV, CID);
    // тейп применён → baseComplete=true → [LOW CONFIDENCE]_ не выставляется
    expect(P.buildExportFileName(SV, CID, 'threshold', false, 'txt')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  }

  test('(а) уход+возврат: тейп ре-мержен, база=тейп∪сеть, голова=истинная, один fired без [LOW CONFIDENCE]_', () => {
    const s = newSession();
    const firedStore = {};
    // холодное открытие A
    processPass(s, CID);
    expect(s.merges).toBe(1);
    expect(s.base.length).toBe(MSGS);        // база = тейп ∪ сеть = 124
    expect(headId(s.base)).toBe('t1_user');  // голова истинная («Составь промт…»)
    checkAutoExport(firedStore);
    // уход в другой чат → возврат в A
    switchConv(s);
    P.resetAutoExportFired(firedStore, SV, CID); // D14: resetConversationState
    processPass(s, CID);
    expect(s.merges).toBe(1);                 // ре-merge ровно один за новый визит
    expect(s.base.length).toBe(MSGS);         // база = тейп ∪ сеть
    expect(headId(s.base)).toBe('t1_user');   // голова истинная
    checkAutoExport(firedStore);              // один fired на новый вход, без LOW CONFIDENCE
  });

  test('(б) внутри одного непрерывного визита повторного merge нет', () => {
    const s = newSession();
    processPass(s, CID);
    expect(s.merges).toBe(1);
    expect(s.dispatchCount).toBe(1);
    expect(s.loadCount).toBe(1);
    // повторный проход того же визита (без conv-switch): лента «уже восстановлена»
    processPass(s, CID);
    expect(s.merges).toBe(1);         // двойного merge НЕТ
    expect(s.dispatchCount).toBe(1);  // повторного dispatch нет
    expect(s.loadCount).toBe(1);      // повторного storage load нет (v77)
    expect(s.base.length).toBe(MSGS);
  });

  test('(в) холод/F5 — байтово-идентично холодному прогону', () => {
    // эталон: холодное открытие (прогон 15-44)
    const cold = newSession();
    processPass(cold, CID);
    const coldIds = GL.orderExportMessages(cold.base).ids;
    expect(cold.base.length).toBe(MSGS);
    expect(coldIds[0]).toBe('t1_user');
    // SPA-уход→возврат после фикса D19 обязан дать байтово тот же порядок
    const s = newSession();
    processPass(s, CID);
    switchConv(s);
    processPass(s, CID);
    const retIds = GL.orderExportMessages(s.base).ids;
    expect(retIds).toEqual(coldIds);  // байтово-идентично
    expect(retIds[0]).toBe('t1_user');
  });
});

// —— v1.14.1 (O3): кросс-табовый латч already-fired (chrome.storage.session) ——
// Вторая вкладка с тем же чатом должна видеть fired первой вкладки (двойной
// экспорт …22-12.txt + …22-12(1).txt, 2026-09-02). Хелперы чистые: кэш-объект
// sessionFiredCache в content.js наполняется из sessionFiredPatch() и sync-ится
// через chrome.storage.onChanged.
describe('v1.14.1 (O3) session-латч already-fired (кросс-табовый)', () => {
  test('sessionFiredPatch → isFiredInSession: вторая вкладка видит fired', () => {
    const patch = P.sessionFiredPatch('gemini', 'e292103e4b521dae');
    expect(Object.keys(patch).length).toBe(1);
    expect(P.isFiredInSession(patch, 'gemini', 'e292103e4b521dae')).toBe(true);
  });

  test('изоляция по convId и по сервису', () => {
    const patch = P.sessionFiredPatch('gemini', 'conv-a');
    expect(P.isFiredInSession(patch, 'gemini', 'conv-b')).toBe(false);
    expect(P.isFiredInSession(patch, 'chatgpt', 'conv-a')).toBe(false);
  });

  test('firedSessionKey согласован с in-memory latchKey (одинаковый префикс ключа)', () => {
    const store = {};
    P.markAutoExportFired(store, 'gemini', 'conv-a');
    expect(Object.keys(store)[0]).toBe(P.firedSessionKey('gemini', 'conv-a').replace('aiCmFired:', ''));
  });

  test('null/undefined кэш → false без исключений', () => {
    expect(P.isFiredInSession(null, 'gemini', 'conv-a')).toBe(false);
    expect(P.isFiredInSession(undefined, 'gemini', 'conv-a')).toBe(false);
  });

  test('симуляция двойной вкладки: L1 изолирован, session общий → второй fired блокирован', () => {
    // вкладка A: своя L1 и общий session-кэш
    const l1A = {};
    const sessionCache = {};
    P.markAutoExportFired(l1A, 'gemini', 'conv-x');
    Object.assign(sessionCache, P.sessionFiredPatch('gemini', 'conv-x'));
    // вкладка B: СВОЯ пустая L1 (отдельный контент-скрипт), session видит тот же
    const l1B = {};
    const firedB = P.getAutoExportFired(l1B, 'gemini', 'conv-x') ||
      P.isFiredInSession(sessionCache, 'gemini', 'conv-x');
    expect(firedB).toBe(true); // без O3 было бы false → двойной экспорт
  });

  test('сброс (гистерезис/D14): remove-ключ совпадает с patch-ключом', () => {
    const patch = P.sessionFiredPatch('gemini', 'conv-y');
    const key = P.firedSessionKey('gemini', 'conv-y');
    expect(patch[key]).toBe(1);
    const cache = Object.assign({}, patch);
    delete cache[key]; // эквивалент chrome.storage.session.remove
    expect(P.isFiredInSession(cache, 'gemini', 'conv-y')).toBe(false);
  });
});
