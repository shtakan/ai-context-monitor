/**
 * O-36: ЭКСПОРТ qwen — два дефекта живой приёмки 2026-09-19.
 *
 *   D1: префикс [LOW CONFIDENCE]_ в имени файла.
 *       Симптом: `[LOW CONFIDENCE]_ai-context-monitor-qwen-Qwen3.8-Max-2026-09-19-19-54.txt`
 *       при `history-write source=adapter msgs=75` и `adapterBaseSeen=1`.
 *       Корень (подтверждён чтением): имя — РУЧНОЙ шаблон (options.js:784-795), префикс даёт
 *       `hist.isLowConfidenceBase`, а его в снимок ручного экспорта кладёт content.js живым
 *       флагом `baseComplete !== true` (v1.14.1). `baseComplete` — признак СЕТЕВОЙ полноты
 *       (core/state.js:53): у qwen сети нет вовсе (живой источник — DOM-адаптер, O-35/D2),
 *       поэтому флаг не взведётся НИКОГДА и префикс липнет к каждому экспорту.
 *       Фикс: база, принятая адаптером (adapterBaseSeen), для сервиса без сети — достоверный
 *       источник → низкая достоверность не ставится (узкое правило, R1 не тронут).
 *
 *   D2: txt-экспорт без разделения ролей.
 *       Симптом: сплошной поток текста (скрин 5 слева). Корень: txt собирает
 *       buildReferenceText — «эталон» БЕЗ ролей вообще (у md роли есть, у json есть поле role).
 *       Фикс: для сайта, чей живой источник — DOM-адаптер (qwen), перед КАЖДЫМ сообщением
 *       строка-маркер 'USER:' / 'ASSISTANT:'; прочие сайты — байтово прежний «эталон».
 *
 * ПИНЫ: D1 (имя без префикса — ручной шаблон и автоэкспорт), D2 (маркеры в txt ручного и
 * авто-экспорта), R1 (шесть прежних платформ: имена и байты прежние), R2 (ни один прежний
 * пин не ослаблен: options.js:794, low-confidence-литерал content.js, маски O-11).
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');
const buildReferenceText = require('../utils/buildReferenceText.js');
const H = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = H.contentSource;                                                    // модули + content.js (единый скоуп)
const CONTENT_ONLY = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/gsa-autoexport.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

// Ручной экспорт (options.js) собирает «эталон» реальным сборщиком, а имя — шаблоном
// ai-context-monitor-<site>-<model>-<stamp> с префиксом по hist.isLowConfidenceBase.
beforeAll(function () { window.buildReferenceText = buildReferenceText; });
afterAll(function () { try { delete window.buildReferenceText; } catch (e) { } });

// =====================================================================================
// D2: маркеры ролей в txt-экспорте qwen
// =====================================================================================
describe('O-36 D2: txt qwen — маркеры USER:/ASSISTANT: перед каждым сообщением', function () {
  test('живой чат «привет»: маркер роли у каждого хода', function () {
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', model: 'Qwen3.8-Max', messages: [
        { role: 'user', text: 'привет' },
        { role: 'assistant', text: 'Привет!' }
      ]
    });
    expect(txt).toBe('USER:\nпривет\n\nASSISTANT:\nПривет!');
    expect(txt.split('\n\n')).toHaveLength(2);      // роли разделены, а не «сплошняком»
  });

  test('живая роль-картина assi,assi,user,assi → маркер у КАЖДОГО сообщения (не только на смене)', function () {
    // живой лог адаптера: «Извлечено 4 сообщений, роли: assi, assi, user, assi»
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', messages: [
        { role: 'assistant', text: 'A1' },
        { role: 'assistant', text: 'A2' },
        { role: 'user', text: 'U1' },
        { role: 'assistant', text: 'A3' }
      ]
    });
    expect(txt).toBe('ASSISTANT:\nA1\n\nASSISTANT:\nA2\n\nUSER:\nU1\n\nASSISTANT:\nA3');
    expect((txt.match(/ASSISTANT:/g) || [])).toHaveLength(3);
    expect((txt.match(/USER:/g) || [])).toHaveLength(1);
  });

  test('reasoning отдельным полем: маркер + [REASONING]/[ANSWER] (контракт O-35 не сломан)', function () {
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', messages: [
        { role: 'user', text: 'привет' },
        { role: 'assistant', text: 'Привет!', reasoning: 'Пользователь здоровается.' }
      ]
    });
    expect(txt).toBe('USER:\nпривет\n\nASSISTANT:\n[REASONING]\nПользователь здоровается.\n\n[ANSWER]\nПривет!');
  });

  test('зачистка разметки внутри блока — та же, что у «эталона» (маркер её не отменяет)', function () {
    const messages = [{ role: 'user', text: '## Заголовок\n**жирный** текст' }];
    const qwenTxt = Builders.buildTxtFromHistory({ site: 'qwen', messages: messages });
    expect(qwenTxt).toBe('USER:\n' + buildReferenceText(messages));
    expect(qwenTxt).toContain('Заголовок');
    expect(qwenTxt).not.toContain('**');
  });

  test('R1: шесть прежних платформ и история без site — байтово прежний «эталон», маркеров нет', function () {
    const messages = [
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: 'ответ' }
    ];
    const reference = buildReferenceText(messages);
    ['chatgpt', 'gemini', 'deepseek', 'claude', 'perplexity', 'google_search'].forEach(function (site) {
      const txt = Builders.buildTxtFromHistory({ site: site, messages: messages });
      expect(txt).toBe(reference);
      expect(txt).not.toContain('USER:');
      expect(txt).not.toContain('ASSISTANT:');
    });
    // история без site (ручной путь до заполнения site) — прежний «эталон» 1:1
    expect(Builders.buildTxtFromHistory({ messages: messages })).toBe(reference);
  });

  test('R1: json qwen не изменился; md qwen — маркеры ролей Qwen Studio (R2, D2.1)', function () {
    const hist = { site: 'qwen', model: 'Qwen3.8-Max', messages: [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: 'ответ' }] };
    const md = Builders.buildMdFromHistory(hist, 'Qwen');
    expect(md).toContain('### USER\n\nвопрос');
    expect(md).toContain('### ASSISTANT\n\nответ');
    expect(md).not.toContain('## Пользователь');
    const json = JSON.parse(Builders.buildJsonFromHistory(hist, 'Qwen'));
    expect(json.messages).toEqual(hist.messages);
  });

  test('пустая история qwen → пустой файл (висячих маркеров нет)', function () {
    expect(Builders.buildTxtFromHistory({ site: 'qwen', messages: [] })).toBe('');
    expect(Builders.buildTxtFromHistory({ site: 'qwen' })).toBe('');
    expect(Builders.buildTxtFromHistory(null)).toBe('');
  });

  test('рендерер: window недоступен → тот же текст через Node-модуль; полная деградация → пустой файл', function () {
    const saved = window.buildReferenceText;
    delete window.buildReferenceText;
    try {
      // Node-фолбэк (require) — тот же «эталон» и те же маркеры: путь зачистки РОВНО ОДИН
      expect(Builders.buildTxtFromHistory({ site: 'qwen', messages: [{ role: 'user', text: 'x' }] }))
        .toBe('USER:\nx');
    } finally {
      window.buildReferenceText = saved;
    }
    // нет ни окна, ни Node-модуля → прежний пустой результат (нормализация null → '')
    const src = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');
    expect(fnDecl(src, 'renderReferenceText')).toContain('return null;');
    expect(fnDecl(src, 'buildTxtFromHistory')).toContain("return (out === null) ? '' : out;");
  });

  test('чистые предикаты наружу + site доезжает до сборщика обеими дорогами экспорта', function () {
    expect(Builders.aiCmTxtRoleMarker('user')).toBe('USER:');
    expect(Builders.aiCmTxtRoleMarker('assistant')).toBe('ASSISTANT:');
    expect(Builders.aiCmTxtRoleMarker(undefined)).toBe('ASSISTANT:');
    expect(Builders.aiCmIsTxtRoleMarkerHistory({ site: 'qwen' })).toBe(true);
    expect(Builders.aiCmIsTxtRoleMarkerHistory({ site: 'QWEN' })).toBe(true);
    expect(Builders.aiCmIsTxtRoleMarkerHistory({ site: 'gemini' })).toBe(false);
    expect(Builders.aiCmIsTxtRoleMarkerHistory(null)).toBe(false);
    expect(Builders.aiCmTxtRoleMarkerSites).toEqual(['qwen']);
    // ручной путь (content.js → options.js) и автоэкспорт кладут в hist РОВНО site адаптера —
    // тем самым предикат видит 'qwen' на обеих дорогах (иначе маркеров не было бы вовсе)
    expect(CONTENT_ONLY).toContain("site: (currentAdapter && currentAdapter.siteName) || '',");
    expect(MGR_SRC).toContain("site: (currentAdapter && currentAdapter.siteName) || '',");
  });
});

// =====================================================================================
// D2.1: контейнер-склейка qwen (живой артефакт 20:50) + структура forTxt
// =====================================================================================
describe('O-36 D2.1: txt qwen — маркеры идут по репликам, а не по узлам-контейнерам', function () {
  // Ровно живая структура артефакта qwen 2026-09-19 20:50: в массиве сообщений рядом с
  // репликами лежат узлы-КОНТЕЙНЕРЫ всего чата (склейка текста всех реплик), роль у них
  // 'assistant' → файл начинался «стеной» ASSISTANT: на 183 КБ до первого USER:.
  const REAL = [
    { role: 'user', text: 'Как удалить плагин из приложения? При открытии файла настроек ошибка.' },
    { role: 'assistant', text: 'Коротко: плагин в DSH Desktop удаляется не кнопкой в списке «Плагины», а через маркет.' },
    { role: 'user', text: 'Способ 1. Через маркет (без команд). Способ сработал. Спасибо!' },
    { role: 'assistant', text: 'Отлично! Рада, что сработало.' }
  ];
  const WALL = REAL.map(function (m) { return m.text; }).join('\n');   // текст узла-контейнера
  const EXPECTED = 'USER:\n' + REAL[0].text + '\n\nASSISTANT:\n' + REAL[1].text +
    '\n\nUSER:\n' + REAL[2].text + '\n\nASSISTANT:\n' + REAL[3].text;

  test('два контейнера на входе → в файле только реплики: маркер у КАЖДОЙ, пустая строка между', function () {
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', messages: [
        { role: 'assistant', text: WALL },
        { role: 'assistant', text: WALL }
      ].concat(REAL)
    });
    expect(txt).toBe(EXPECTED);
    expect(txt.startsWith('USER:\n')).toBe(true);               // «стены» ASSISTANT: впереди нет
    expect((txt.match(/USER:/g) || [])).toHaveLength(2);
    expect((txt.match(/ASSISTANT:/g) || [])).toHaveLength(2);
    expect(txt.split('\n\n').filter(function (b) { return /^(USER|ASSISTANT):/.test(b); })).toHaveLength(4);
    // живой контейнер отброшен целиком: его текст (склейка) в файл не попал ни разу
    expect(txt.length).toBe(EXPECTED.length);
  });

  test('порог: одного вложенного мало — реплика, целиком процитировавшая вопрос, остаётся', function () {
    const q = 'Готово';
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', messages: [
        { role: 'user', text: q },
        { role: 'assistant', text: q + ' — отлично, шаг закрыт. Дальше: перезапусти приложение.' }
      ]
    });
    expect(txt).toBe('USER:\n' + q + '\n\nASSISTANT:\n' + q + ' — отлично, шаг закрыт. Дальше: перезапусти приложение.');
  });

  test('равные по длине тексты контейнерами не считаются: дубль-реплика не теряется', function () {
    const txt = Builders.buildTxtFromHistory({
      site: 'qwen', messages: [{ role: 'user', text: 'да' }, { role: 'assistant', text: 'да' }]
    });
    expect(txt).toBe('USER:\nда\n\nASSISTANT:\nда');
  });

  test('forTxt — массив объектов; сырой .content (адаптерный вход) не даёт висячего маркера', function () {
    expect(Builders.aiCmMessageTextForMarkers({ role: 'user', content: 'привет' })).toBe('привет');
    expect(Builders.buildTxtFromHistory({ site: 'qwen', messages: [{ role: 'user', content: 'привет' }] }))
      .toBe('USER:\nпривет');
    // пустая реплика блока не создаёт (маркер без текста не печатается)
    expect(Builders.buildTxtFromHistory({ site: 'qwen', messages: [{ role: 'user', text: '   ' }] })).toBe('');
  });

  test('R1: контейнер-чистка НЕ трогает прочие платформы — байты прежнего «эталона» 1:1', function () {
    const messages = [{ role: 'assistant', text: WALL }].concat(REAL);
    const reference = buildReferenceText(messages);
    ['chatgpt', 'gemini', 'deepseek', 'claude', 'perplexity', 'google_search'].forEach(function (site) {
      expect(Builders.buildTxtFromHistory({ site: site, messages: messages })).toBe(reference);
    });
    expect(Builders.buildTxtFromHistory({ messages: messages })).toBe(reference);
    // чистые функции контейнер-правила не зависят от сайта: гейт стоит у сборщика
    expect(Builders.aiCmDropContainerMessages(messages)).toHaveLength(4);
  });

  test('R2: md qwen — маркеры ### USER / ### ASSISTANT и та же контейнер-чистка', function () {
    const md = Builders.buildMdFromHistory({
      site: 'qwen', messages: [{ role: 'assistant', text: WALL }].concat(REAL)
    }, 'Qwen');
    expect(md).toContain('### USER\n\n' + REAL[0].text);
    expect(md).toContain('### ASSISTANT\n\n' + REAL[1].text);
    expect((md.match(/### ASSISTANT/g) || [])).toHaveLength(2);
    expect(md).not.toContain('## Пользователь');
    // прочие платформы: прежние локализованные заголовки и прежний массив (R1)
    ['chatgpt', 'gemini', 'deepseek', 'claude', 'perplexity', 'google_search'].forEach(function (site) {
      const other = Builders.buildMdFromHistory({ site: site, messages: [{ role: 'assistant', text: WALL }].concat(REAL) }, 'X');
      expect(other).toContain('## Пользователь\n\n' + REAL[0].text);
      expect(other).not.toContain('### USER');
    });
  });

  test('структура forTxt печатается РОВНО под гейтом aiCmDebug (тишина без гейта)', function () {
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation(function (s) { lines.push(String(s)); });
    const messages = [{ role: 'assistant', text: WALL }].concat(REAL);
    try {
      sessionStorage.removeItem('aiCmDebug');
      delete window.__aiCmDebugLogs;
      Builders.buildTxtFromHistory({ site: 'qwen', messages: messages });
      expect(lines.filter(function (l) { return l.indexOf('txt-roles') !== -1; })).toHaveLength(0);
      window.__aiCmDebugLogs = true;
      Builders.buildTxtFromHistory({ site: 'qwen', messages: messages });
      const hit = lines.filter(function (l) { return l.indexOf('txt-roles') !== -1; });
      expect(hit).toHaveLength(1);
      expect(hit[0]).toContain('[AI CM][diag]');
      expect(hit[0]).toContain('isArray=true');
      expect(hit[0]).toContain('msgs=5');
      expect(hit[0]).toContain('kept=4');
      expect(hit[0]).toContain('dropped-containers=1');
      expect(hit[0]).toContain('first.role=user');
      expect(hit[0]).toContain('first.kind=text');
      expect(hit[0]).toContain('first.len=' + REAL[0].text.length);
      // прочие платформы диагностику маркеров не печатают вовсе (гейт сайта)
      lines.length = 0;
      Builders.buildTxtFromHistory({ site: 'gemini', messages: messages });
      expect(lines.filter(function (l) { return l.indexOf('txt-roles') !== -1; })).toHaveLength(0);
    } finally {
      spy.mockRestore();
      delete window.__aiCmDebugLogs;
    }
  });

  test('source-пин: явный цикл и Array.isArray в рендерере (структура, а не только байты)', function () {
    const src = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');
    const fn = fnDecl(src, 'renderReferenceTextWithRoleMarkers');
    expect(fn).toContain('var src = Array.isArray(list) ? list : [];');
    expect(fn).toContain('for (var i = 0; i < src.length; i++)');
    expect(fn).toContain("parts.push(txtRoleMarker(m.role) + '\\n' + text);");
    expect(fn).toContain("return parts.join('\\n\\n');");
    expect(fn).toContain('renderReferenceText([');           // та же зачистка, что у «эталона»
    expect(fnDecl(src, 'buildTxtFromHistory')).toContain('var kept = marked ? dropContainerMessages(messages) : messages;');
    expect(fnDecl(src, 'buildMdFromHistory')).toContain('if (mdMarked) messages = dropContainerMessages(messages);');
    expect(Builders.aiCmMdRoleMarker('user')).toBe('### USER');
    expect(Builders.aiCmMdRoleMarker('assistant')).toBe('### ASSISTANT');
    expect(Builders.aiCmContainerRules).toEqual({ minContained: 2, coverMin: 0.8 });
  });
});

// =====================================================================================
// D1: префикс [LOW CONFIDENCE]_ — воспроизведение дефекта и фикс
// =====================================================================================
describe('O-36 D1: имя файла qwen без префикса [LOW CONFIDENCE]_', function () {
  const STAMP = '2026-09-19-19-54';   // метка из симптома владельца

  // Зеркало options/options.js:784-795 (ручной шаблон; пин самого литерала — ниже).
  function manualExportName(site, model, isLowConfidenceBase, stamp) {
    const lowConfPrefix = (isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';
    return lowConfPrefix + 'ai-context-monitor-' + site + '-' + model + '-' + (stamp || STAMP) + '.txt';
  }

  /** Реальный aiCmQwenExportBaseTrusted из core/content.js в песочнице состояния. */
  function runBaseTrusted(over) {
    const ctx = {
      currentAdapter: (over && over.adapter !== undefined) ? over.adapter : { siteName: 'qwen' },
      adapterBaseSeen: !!(over && over.adapterBaseSeen === true)
    };
    if (over && over.noAdapterBaseSeen === true) delete ctx.adapterBaseSeen;
    const fn = new Function('ctx', 'with (ctx) { ' + fnDecl(CONTENT_ONLY, 'aiCmQwenExportBaseTrusted') +
      '\n return aiCmQwenExportBaseTrusted; }')(ctx);
    return fn();
  }

  test('репро дефекта: baseComplete=0 у qwen → прежнее правило даёт префикс (имя из симптома)', function () {
    // ровно живой вход: истории нет из сети (baseComplete=false), база адаптера записана
    const isLowConfidenceBase = (false !== true);            // content.js: живой флаг v1.14.1
    expect(isLowConfidenceBase).toBe(true);
    expect(manualExportName('qwen', 'Qwen3.8-Max', isLowConfidenceBase))
      .toBe('[LOW CONFIDENCE]_ai-context-monitor-qwen-Qwen3.8-Max-' + STAMP + '.txt');
  });

  test('фикс: база принята адаптером → ручной шаблон БЕЗ префикса', function () {
    const trusted = runBaseTrusted({ adapterBaseSeen: true });
    expect(trusted).toBe(true);
    const isLowConfidenceBase = (false !== true) && !trusted; // content.js: правило O-36
    expect(isLowConfidenceBase).toBe(false);
    expect(manualExportName('qwen', 'Qwen3.8-Max', isLowConfidenceBase))
      .toBe('ai-context-monitor-qwen-Qwen3.8-Max-' + STAMP + '.txt');
    expect(manualExportName('qwen', 'Qwen3.8-Max', isLowConfidenceBase)).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  test('вердикты правила: только qwen с принятой адаптерной базой (R1: прочие платформы не задеты)', function () {
    expect(runBaseTrusted({ adapterBaseSeen: true })).toBe(true);
    expect(runBaseTrusted({ adapterBaseSeen: false })).toBe(false);          // адаптерной базы ещё нет
    expect(runBaseTrusted({ noAdapterBaseSeen: true })).toBe(false);         // состояние не объявлено
    expect(runBaseTrusted({ adapter: null, adapterBaseSeen: true })).toBe(false);
    ['chatgpt', 'gemini', 'deepseek', 'claude', 'perplexity', 'google_search'].forEach(function (site) {
      expect(runBaseTrusted({ adapter: { siteName: site }, adapterBaseSeen: true })).toBe(false);
    });
  });

  test('проводка в content.js: живой флаг v1.14.1 сохранён, правило применено ДО ответа попапу', function () {
    const iFlag = CONTENT_ONLY.indexOf('isLowConfidenceBase: (baseComplete !== true),');
    const iRule = CONTENT_ONLY.indexOf('if (typeof aiCmQwenExportBaseTrusted === \'function\' && aiCmQwenExportBaseTrusted()) {');
    const iClear = CONTENT_ONLY.indexOf('manualSnapshot.isLowConfidenceBase = false;');
    const iSend = CONTENT_ONLY.indexOf('sendResponse({ data: manualSnapshot });');
    expect(iFlag).toBeGreaterThan(-1);                 // R-пин прежних сьютов (low-confidence-prefix и др.)
    expect(iRule).toBeGreaterThan(iFlag);              // правило — ПОСЛЕ живого флага
    expect(iClear).toBeGreaterThan(iRule);
    expect(iSend).toBeGreaterThan(iClear);             // и ДО ответа: попап видит уже снятый флаг
    // хелпер объявлен в том же файле (на боевом пути определён всегда)
    expect(CONTENT_ONLY).toContain('function aiCmQwenExportBaseTrusted() {');
    // правило узкое: снимается только низкая достоверность, baseComplete не подменяется
    expect(CONTENT_ONLY).not.toContain('baseComplete = true; // O-36');
    // снимок ручного экспорта остаётся единственным носителем решения (payload = тот же объект)
    expect(CONTENT_ONLY).toContain('sendResponse({ data: manualSnapshot });');
  });

  test('R-пин: правило префикса options.js и маска имён O-11 не тронуты', function () {
    expect(OPTIONS_SRC).toContain("var lowConfPrefix = (hist && hist.isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';");
    expect(OPTIONS_SRC).toContain("return lowConfPrefix + 'ai-context-monitor-' + safeSite + '-' + safeModel + '-' + stamp + '.' + ext;");
    expect(P.buildAutoExportFileName({
      mask: 'convId', service: 'gemini', convId: 'abcdefgh', reason: 'threshold',
      isLowConfidence: true, fmt: 'txt'
    })).toMatch(/^\[LOW CONFIDENCE\]_gemini-abcdefgh-/);
    expect(P.buildAutoExportFileName({
      mask: 'convId', service: 'gemini', convId: 'abcdefgh', reason: 'threshold',
      isLowConfidence: false, fmt: 'txt'
    })).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });

  // ---------------------------------------------------------------------------------
  // Авто-дорога: РЕАЛЬНЫЙ doAutoExportDownload qwen (имя + тело файла)
  // ---------------------------------------------------------------------------------
  const SCOPE = 'with (ctx) { ' +
    fnDecl(MGR_SRC, 'aiCmExportBaseSource') + '\n' +
    fnDecl(MGR_SRC, 'aiCmAutoExportStartDownload') + '\n' +
    fnDecl(MGR_SRC, 'doAutoExportDownload') + '\n' +
    ' return { dl: doAutoExportDownload }; }';
  const makeContent = new Function('ctx', SCOPE);

  function ctxFor(site, over) {
    const downloads = [];
    const logs = [];
    const ctx = {
      currentAdapter: { siteName: site },
      autoExportSettings: { fmt: 'txt', enabled: true, pct: 90 },
      aiCmLowConfidenceByConv: {},
      baseSeen: false,                 // у qwen сети нет вовсе (O-35/D2)
      baseComplete: false,             // сетевой полноты не будет никогда
      lastBaseTexts: ['привет', 'Привет!'],
      lastEmitConvId: 'cda86f26-0155-4243-a134-777d909a936b',
      lastThreadId: '',
      lastResolvedModelId: 'qwen3.8-max',
      lastSnapshotModelName: 'Qwen3.8-Max',
      maxTokenCount: 2593,
      sessionFiredCache: {},
      autoExportFired: {},
      aiCmAutoExportNamesUsed: {},
      aiCmCursorLiveByConv: {},
      aiCmDumpTurnsSnapshot: function () { },
      aiCmCancelDeferredHistWrite: function () { },
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      console: { error: function () { } },
      ModelConfig: { getModel: function () { return { name: 'Qwen3.8-Max' }; } },
      buildHistoryMessages: function () {
        return [
          { role: 'user', text: 'привет' },
          { role: 'assistant', text: 'Привет!' }
        ];
      },
      aiCmGeminiTurnsSnapshotSync: function () { return null; },
      chrome: { storage: { session: { set: function () { }, remove: function () { } } } },
      window: {
        location: { hostname: 'chat.qwen.ai' },
        AiCmExportBuilders: {
          buildTxtFromHistory: Builders.buildTxtFromHistory,     // РЕАЛЬНЫЙ сборщик (D2)
          buildMdFromHistory: Builders.buildMdFromHistory,
          buildJsonFromHistory: Builders.buildJsonFromHistory,
          downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); }
        },
        AiCmExportEmitPipeline: P
      }
    };
    Object.assign(ctx, over || {});
    return { ctx: ctx, downloads: downloads, logs: logs, api: makeContent(ctx) };
  }

  test('D1/D2 авто-дорога: файл qwen без префикса, тело — с маркерами ролей', function () {
    const h = ctxFor('qwen', {});
    h.api.dl(h.ctx.lastEmitConvId, 42.5, 'threshold');
    expect(h.downloads).toHaveLength(1);
    const d = h.downloads[0];
    // D1: маска O-11 <service>-<convId 8>-<stamp>, префикса нет
    expect(d.file).toMatch(/^qwen-cda86f26-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
    expect(d.file).not.toMatch(/^\[LOW CONFIDENCE\]_/);
    // D2: тело собрано реальным сборщиком с маркерами
    expect(d.content).toBe('\uFEFF' + Builders.buildTxtFromHistory({
      site: 'qwen', messages: [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'Привет!' }]
    }));
    expect(d.content).toContain('USER:\nпривет');
    expect(d.content).toContain('ASSISTANT:\nПривет!');
    expect(h.logs.join('\n')).toContain('fired convId=' + h.ctx.lastEmitConvId);
  });

  test('R1: авто-дорога прочих платформ прежняя — gemini с low-confidence остаётся с префиксом', function () {
    const h = ctxFor('gemini', { baseSeen: true, baseComplete: true, aiCmLowConfidenceByConv: {} });
    // Gemini: префикс даёт липкий v63-флаг по convId (baseComplete=0-семантика)
    h.ctx.aiCmLowConfidenceByConv[h.ctx.lastEmitConvId] = true;
    h.api.dl(h.ctx.lastEmitConvId, 42.5, 'threshold');
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0].file).toMatch(/^\[LOW CONFIDENCE\]_gemini-cda86f26-/);
    // и чужая платформа (chatgpt) без флага — без префикса (прежнее поведение 1:1)
    const h2 = ctxFor('chatgpt', { baseSeen: true, baseComplete: true });
    h2.api.dl(h2.ctx.lastEmitConvId, 42.5, 'threshold');
    expect(h2.downloads[0].file).toMatch(/^chatgpt-cda86f26-/);
    expect(h2.downloads[0].file).not.toMatch(/^\[LOW CONFIDENCE\]_/);
  });
});
