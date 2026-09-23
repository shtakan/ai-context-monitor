/**
 * O-45 (Medium): КОД-БЛОКИ GSA (окна python/js) не попадали в экспорт txt/md.
 *
 * Живой прогон (threadId gGezatSZK426i-gPxITekAw, «Напиши пример кода на python для
 * сортировки списка», udm=50): тело folwr 191236B, а база ассистента — 796 знаков ОДНОЙ
 * прозы; код, метка языка («python») и кнопка «Скопировать код» отсутствовали.
 * DOM окна кода: StaticText «python» → code (полный многострочный текст) → button
 * «Скопировать код в буфер обмена».
 *
 * Корень (инспекция, read-only): в ОТБОРЕ контент-узлов ответа код-контейнеров не было вовсе
 * (utils/google-search-folwr-parser.js:gatherAnswerContentNodes брал только .n6owBd.awi2gc,
 * table, [role=heading], h2-h4, ul/ol/li), а generic-ветка assignContentToTurns читала
 * textContent — код вне чанка терялся, код внутри чанка схлопывался бы в одну строку и
 * потерял бы маркеры языка. Потеря на ОТБОРЕ узлов, не в санации.
 *
 * Спецификация: файл содержит полный текст код-блока ВКЛЮЧАЯ маркеры языка — ```lang\n…\n```.
 *
 * Фикс (точки):
 *   1) отбор: pre, code, [class*=code-block], [class*=codeBlock] добавлены в
 *      gatherAnswerContentNodes; инлайн <code> блоком не считается (остаётся инлайн-текстом);
 *   2) хелпер renderCodeBlock(node, langHint) → ```<lang>\n<текст>\n``` (язык — из атрибута/
 *      класса или из СОСЕДНЕГО узла-метки «python»); текст — textContent с переносами строк;
 *   3) assignContentToTurns и санация: код-узел рендерится renderCodeBlock/answerTextOf,
 *      многострочный код не схлопывается; sanitizeAssistant/stripTags не трогают сегменты
 *      ВНУТРИ фенсов (mapOutsideFences) — отступы и переносы кода сохраняются;
 *   4) DOM-путь един: extractTurnsFromDocument и адаптер берут узлы общим answerDomNodes и
 *      текст общим answerTextOf (адаптер резолвит хелпер лениво, как Qwen в O-37).
 *
 * Пины: D1 (pre>code + метка «python»), D2 (без метки → пустой lang), D3 (несколько блоков),
 * D4 (код внутри чанка), D5 (DOM-добор + адаптер), R1 (O-11/O-31/O-27/O-43 не тронуты),
 * R2 (проза байтово прежняя, инлайн <code> не фенсится), R3 (санация не режет фенсы).
 *
 * НЕ ТРОГАЕТСЯ: mergeTurns/applyTurns, пороги, латчи (O-38/O-29/O-43), санация инъекций
 * соседей (O-20/O-40/O-42), CHANGELOG/manifest/package.
 */

const fs = require('fs');
const path = require('path');

const Parser = require('../utils/google-search-folwr-parser.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = require('./helpers/content-source.js').contentSource;
const BASE_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'base-adapter.js'), 'utf8')
  .replace(/if \(typeof module[\s\S]*$/, '');
const ADAPTER_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'google-search-adapter.js'), 'utf8');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const STATE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'state.js'), 'utf8');

// =====================================================================================
// Фикстуры (формы измерены в живом DOM GSA)
// =====================================================================================
const TID = '<div data-session-thread-id="O45-THREAD" style="display:none"></div>';
const PY_CODE = 'nums = [3, 1, 2]\nnums.sort()\nprint(nums)';
const PY_FENCE = '```python\n' + PY_CODE + '\n```';
const JS_CODE = 'const a = [3, 1];\na.sort();';

function turnHead(id, question) {
  return '<div class="CKgc1d" data-scope-id="turn" jsuid="' + id + '">' +
    '<h2 class="iMqumd">Вы сказали: "' + question + '"</h2></div>';
}
function assistantOf(result) {
  return result.messages.filter(function (m) { return m.role === 'assistant'; })[0];
}

// =====================================================================================
// Песочница РЕАЛЬНОГО адаптера (паттерн tests/qwen-container-drop-o37.test.js):
// base-adapter.js + google-search-adapter.js в одном лексическом скоупе, window/require
// передаются явно — пиним все три пути резолва общего хелпера.
// =====================================================================================
function loadAdapter(opts) {
  const o = opts || {};
  const sandbox = new Function('document', 'location', 'debugLog', 'console', 'window', 'require', 'module',
    BASE_SRC + '\n' + ADAPTER_SRC + '\nreturn GoogleSearchAdapter;');
  const win = (o.noWindow === true) ? undefined
    : ((o.window !== undefined) ? o.window : { GoogleFolwrUtils: Parser, dispatchEvent: function () { } });
  const req = (o.require !== undefined) ? o.require : undefined;
  const GsaAdapterClass = sandbox(document, { hostname: 'www.google.com', pathname: '/search' },
    function () { }, console, win, req, undefined);
  return new GsaAdapterClass();
}

// DOM-фикстура адаптера: чанк прозы + САМОСТОЯТЕЛЬНОЕ окно кода вне чанка (живая форма).
function renderAdapterFixture(tid) {
  document.body.innerHTML = [
    '<div data-session-thread-id="' + (tid || 'O45-THREAD') + '" style="display:none"></div>',
    turnHead('t1', 'Напиши пример кода на python'),
    '<div class="n6owBd awi2gc">Пример сортировки:</div>',
    '<div class="code-block"><div class="lang-label">python</div>',
    '<pre><code>' + PY_CODE + '</code></pre></div>'
  ].join('');
}

beforeEach(function () {
  document.body.innerHTML = '';
});

// =====================================================================================
// D1: pre>code + метка языка «python»
// =====================================================================================
describe('O-45 D1: код-блок с меткой языка уезжает в ```python```', () => {
  const html = TID + turnHead('t1', 'Напиши пример кода на python для сортировки списка') +
    '<div class="n6owBd awi2gc">Пример сортировки списка:</div>' +
    '<div class="code-block"><div class="lang-label">python</div>' +
    '<pre><code>' + PY_CODE + '</code></pre></div>';

  test('ответ содержит ```python\\n<код>\\n``` целиком', () => {
    const text = assistantOf(Parser.parseGoogleFolwrOpen(html)).text;
    expect(text).toContain(PY_FENCE);
  });

  test('код не схлопнут: строки и отступы на месте (прозаическая санация не съела)', () => {
    const indent = 'def main():\n    nums = [3, 1]\n    return sorted(nums)';
    const withIndent = TID + turnHead('t1', 'Функция') +
      '<div class="n6owBd awi2gc">Функция:</div>' +
      '<div class="code-block"><span class="lang-label">python</span>' +
      '<pre><code>' + indent + '</code></pre></div>';
    const text = assistantOf(Parser.parseGoogleFolwrOpen(withIndent)).text;
    expect(text).toContain('```python\ndef main():\n    nums = [3, 1]\n    return sorted(nums)\n```');
    // отступ вложенной строки сохранён (построчный trim его бы уничтожил)
    expect(text).toContain('\n    nums = [3, 1]\n');
  });

  test('маркеры языка не съедены санацией: ровно два фенса и оба целые', () => {
    const text = assistantOf(Parser.parseGoogleFolwrOpen(html)).text;
    expect((text.match(/```/g) || [])).toHaveLength(2);
    expect(text.indexOf('```python')).toBeGreaterThan(text.indexOf('Пример сортировки'));
    expect(text.endsWith('```')).toBe(true);
  });

  test('метка языка берётся и из класса language-* (без соседнего узла)', () => {
    const viaClass = TID + turnHead('t1', 'Код') +
      '<div class="n6owBd awi2gc">Код:</div>' +
      '<pre><code class="language-python">' + PY_CODE + '</code></pre>';
    expect(assistantOf(Parser.parseGoogleFolwrOpen(viaClass)).text).toContain(PY_FENCE);
  });

  test('подсветка синтаксиса в span\'ах однострочный код не разрывает', () => {
    const oneLine = TID + turnHead('t1', 'Одна строка') +
      '<div class="n6owBd awi2gc">Строка:</div>' +
      '<pre><code class="language-js"><span class="k">const</span> <span class="n">a</span> = <span>1</span>;</code></pre>';
    const text = assistantOf(Parser.parseGoogleFolwrOpen(oneLine)).text;
    expect(text).toContain('```js\nconst a = 1;\n```');   // вся строка целиком, без вставленных \n
    expect(text).not.toContain('const\na');
  });
});

// =====================================================================================
// D2: код-блок без метки языка
// =====================================================================================
describe('O-45 D2: код-блок без метки → пустой lang (```…```)', () => {
  const html = TID + turnHead('t1', 'Покажи код') +
    '<div class="n6owBd awi2gc">Вот код:</div>' +
    '<pre><code>console.log(1)\nconsole.log(2)</code></pre>';

  test('фенс без языка, код целиком', () => {
    const text = assistantOf(Parser.parseGoogleFolwrOpen(html)).text;
    expect(text).toContain('```\nconsole.log(1)\nconsole.log(2)\n```');
    expect(text).not.toContain('```python');
    // прозаический сосед меткой языка не становится
    expect(text).not.toContain('```Вот код');
  });

  test('строки-дивишки (живой DOM) собираются построчно, а не в одну строку', () => {
    const divLines = TID + turnHead('t1', 'Код') +
      '<div class="n6owBd awi2gc">Код:</div>' +
      '<pre><code><div>line1</div><div>line2</div></code></pre>';
    expect(assistantOf(Parser.parseGoogleFolwrOpen(divLines)).text)
      .toContain('```\nline1\nline2\n```');
  });
});

// =====================================================================================
// D3: несколько код-блоков в одном сообщении
// =====================================================================================
describe('O-45 D3: несколько окон кода в одном ответе — все сохранены', () => {
  const html = TID + turnHead('t1', 'Дай два примера') +
    '<div class="n6owBd awi2gc">Первый — на JS:</div>' +
    '<div class="code-block"><div class="lang-label">javascript</div>' +
    '<pre><code>' + JS_CODE + '</code></pre></div>' +
    '<div class="n6owBd awi2gc">Второй — на Python:</div>' +
    '<pre><code class="language-python">' + PY_CODE + '</code></pre>';

  test('оба блока на месте, порядок сохранён', () => {
    const text = assistantOf(Parser.parseGoogleFolwrOpen(html)).text;
    expect(text).toContain('```javascript\n' + JS_CODE + '\n```');
    expect(text).toContain(PY_FENCE);
    expect((text.match(/```/g) || [])).toHaveLength(4);
    expect(text.indexOf('```javascript')).toBeLessThan(text.indexOf('```python'));
    expect(text.indexOf('```javascript')).toBeGreaterThan(text.indexOf('Первый — на JS:'));
  });
});

// =====================================================================================
// D4: окно кода ВНУТРИ чанка прозы
// =====================================================================================
describe('O-45 D4: окно кода внутри чанка .n6owBd.awi2gc тоже фенсится', () => {
  const html = TID + turnHead('t1', 'Код в абзаце') +
    '<div class="n6owBd awi2gc">Пример:<div class="code-block"><span class="lang-label">python</span>' +
    '<pre><code>a = 1\nb = 2</code></pre></div>Готово.</div>';

  test('фенс на месте, проза до и после кода сохранена', () => {
    const text = assistantOf(Parser.parseGoogleFolwrOpen(html)).text;
    expect(text).toContain('```python\na = 1\nb = 2\n```');
    expect(text.indexOf('Пример:')).toBeLessThan(text.indexOf('```python'));
    expect(text.indexOf('Готово.')).toBeGreaterThan(text.indexOf('```python'));
  });
});

// =====================================================================================
// D5: DOM-путь — досбор перехватчика и адаптер (единство с сетевым путём)
// =====================================================================================
describe('O-45 D5: DOM-путь — extractTurnsFromDocument и адаптер', () => {
  const html = TID + turnHead('t1', 'Напиши пример кода на python') +
    '<div class="n6owBd awi2gc">Пример сортировки:</div>' +
    '<div class="code-block"><div class="lang-label">python</div>' +
    '<pre><code>' + PY_CODE + '</code></pre></div>';

  test('DOM-добор перехватчика (extractTurnsFromDocument) даёт тот же текст по коду', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const turns = Parser.extractTurnsFromDocument(doc);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantText).toContain(PY_FENCE);
  });

  test('адаптер (общий ISOLATED-хелпер window.GoogleFolwrUtils) отдаёт код фенсом', () => {
    renderAdapterFixture();
    const msgs = loadAdapter().extractMessages();
    const assistant = msgs.filter(function (m) { return m.role === 'assistant'; })[0];
    expect(assistant).toBeTruthy();
    expect(assistant.content).toContain(PY_FENCE);
    expect(assistant.content).toContain('Пример сортировки:');
  });

  test('резолв хелпера эквивалентен: window-путь == Node-путь (require) — байтово', () => {
    renderAdapterFixture();
    const viaWindow = loadAdapter({ window: { GoogleFolwrUtils: Parser, dispatchEvent: function () { } } }).extractMessages();
    const viaRequire = loadAdapter({ noWindow: true, require: require }).extractMessages();
    expect(viaRequire).toEqual(viaWindow);
    expect(viaRequire[1].content).toContain(PY_FENCE);
  });

  test('R (до фикса): без хелпера адаптер ведёт себя 1:1 прежним путём — только проза', () => {
    renderAdapterFixture();
    const legacy = loadAdapter({ noWindow: true, require: undefined }).extractMessages();
    const assistant = legacy.filter(function (m) { return m.role === 'assistant'; })[0];
    expect(assistant.content).toBe('Пример сортировки:');   // окно кода вне чанка прежним путём не видно
    expect(assistant.content).not.toContain('```');
  });

  test('единство путей зафиксировано в источнике: адаптер зовёт общий хелпер парсера', () => {
    expect(ADAPTER_SRC).toContain('window.GoogleFolwrUtils');
    expect(ADAPTER_SRC).toContain('answerTextOf');
    expect(ADAPTER_SRC).toContain('answerDomNodes');
    // своих правил рендера код-блоков адаптер не держит (нет дубля логики)
    expect(ADAPTER_SRC).not.toContain('CODE_CONTAINER_SEL');
    expect(ADAPTER_SRC).not.toContain('CODE_LANG_RE');
  });
});

// =====================================================================================
// D6: путь до файла — санация выхода экспорта фенсы не трогает
// =====================================================================================
describe('O-45 D6: код-блок доезжает до санации выхода экспорта без потерь', () => {
  const html = TID + turnHead('t1', 'Напиши пример кода на python') +
    '<div class="n6owBd awi2gc">Пример сортировки:</div>' +
    '<div class="code-block"><div class="lang-label">python</div>' +
    '<pre><code>' + PY_CODE + '</code></pre></div>';

  test('sanitizeEmitMessages сохраняет фенс и многострочный код 1:1', () => {
    const P = require('../utils/export-emit-pipeline.js');
    const parsed = Parser.parseGoogleFolwrOpen(html);
    const messages = parsed.messages.map(function (m, i) {
      return { role: m.role, text: m.text, id: 'm' + i };
    });
    const res = P.sanitizeEmitMessages(messages);
    const assistant = res.messages.filter(function (m) { return m.role === 'assistant'; })[0];
    expect(assistant.text).toContain(PY_FENCE);
    expect(assistant.text).toBe(parsed.messages[1].text);   // ни одного сдвинутого символа
  });
});

// =====================================================================================
// R1: регрессы O-11/O-31/O-27/O-43 не тронуты
// =====================================================================================
describe('O-45 R1: прежние контуры GSA не тронуты', () => {
  test('R1 (O-11): имена и единственная точка старта скачивания — адаптер своих не имеет', () => {
    expect(ADAPTER_SRC).not.toContain('downloadBlob');
    expect(ADAPTER_SRC).not.toContain('createObjectURL');
    expect(MGR_SRC.split('.downloadBlob(').length - 1).toBe(1);
  });

  test('R1 (O-31): сегментация по threadId перехватчика на месте; парсер читает threadId', () => {
    expect(INTERCEPT_SRC).toContain('function isForeignThread(tid)');
    expect(INTERCEPT_SRC).toContain('absorbForeignSnapshot(tid, turns, historyComplete)');
    const two = TID + turnHead('t1', 'Первый вопрос') + '<div class="n6owBd awi2gc">Первый ответ</div>' +
      turnHead('t2', 'Второй вопрос') +
      '<div class="n6owBd awi2gc">Код:</div><pre><code class="language-python">' + PY_CODE + '</code></pre>';
    const parsed = Parser.parseGoogleFolwrOpen(two);
    expect(parsed.threadId).toBe('O45-THREAD');
    expect(parsed.messages[1].text).toBe('Первый ответ');            // код второго хода не приклеен к первому
    expect(parsed.messages[3].text).toContain(PY_FENCE);
  });

  test('R1 (O-27): captcha-мусор по-прежнему не даёт ходов', () => {
    expect(Parser.parseGoogleFolwrOpen(')]}\' [""]').messages).toHaveLength(0);
    expect(Parser.parseGoogleFolwrOpen(')]}\' [""]').turns).toHaveLength(0);
    expect(INTERCEPT_SRC).toContain('function isGarbageBody(bodyText, turns)');
    expect(INTERCEPT_SRC).toContain('function hasUsableTurns(turns)');
  });

  test('R1 (O-43): сетевой латч полноты объявлен и читается только в ISOLATED-мире', () => {
    ['core/state.js', 'core/widget.js', 'core/export-manager.js', 'core/content.js'].forEach(function (rel) {
      expect(fs.readFileSync(path.join(ROOT, rel), 'utf8')).toContain('aiCmGsaNetworkComplete');
    });
    expect(STATE_SRC).toContain('var aiCmGsaNetworkCompleteLatch = Object.create(null);');
    expect(MGR_SRC).toContain('aiCmGsaNetworkCompleteIs(siteName, cid)');
    expect(CONTENT).toContain('aiCmGsaNetworkCompleteSet(detail.threadId');
  });

  test('R1: пороги/латчи автоэкспорта не тронуты (текст фенсов их не размыкает)', () => {
    const P = require('../utils/export-emit-pipeline.js');
    expect(typeof P.shouldSkipAutoExport).toBe('function');
    expect(MGR_SRC).toContain("aiCmAutoExportFiredOnce[siteName + '|' + cid] === 1");
  });
});

// =====================================================================================
// R2: прозаические чанки байтово прежние
// =====================================================================================
describe('O-45 R2: проза байтово прежняя (золото снято с кода ДО фикса)', () => {
  // Золотой выход снят с парсера ДО правок O-45 (node + jsdom) и заморожен здесь.
  const PROSE_HTML = [
    '<div data-session-thread-id="O45-R2" style="display:none"></div>',
    turnHead('t1', 'Расскажи про сортировку'),
    '<div class="n6owBd awi2gc">Сортировка — это упорядочивание элементов.</div>',
    '<div role="heading" aria-level="3">Виды сортировок</div>',
    '<ul><li><strong>Пузырьковая</strong> простая</li><li>Быстрая</li></ul>',
    '<table class="NRefec"><tr><th>Алгоритм</th><th>Сложность</th></tr>' +
      '<tr><td>Быстрая</td><td>O(n log n)</td></tr></table>',
    '<div class="n6owBd awi2gc">Код <code>nums.sort()</code> — встроенная сортировка.</div>'
  ].join('');
  const PROSE_USER = 'Расскажи про сортировку';
  const PROSE_ASSISTANT = 'Сортировка — это упорядочивание элементов.\n\nВиды сортировок\n\n' +
    '- **Пузырьковая**: простая\n- Быстрая\n\n| Алгоритм | Сложность |\n| Быстрая | O(n log n) |\n\n' +
    'Код nums.sort() — встроенная сортировка.';

  test('messages и text байтово равны золоту (ни один символ не сдвинулся)', () => {
    const r = Parser.parseGoogleFolwrOpen(PROSE_HTML);
    expect(r.messages).toEqual([
      { role: 'user', text: PROSE_USER },
      { role: 'assistant', text: PROSE_ASSISTANT }
    ]);
    expect(r.text).toBe(PROSE_USER + '\n' + PROSE_ASSISTANT);
    expect(r.count).toBe(2);
  });

  test('инлайн <code> в прозе НЕ становится код-блоком', () => {
    const text = assistantOf(Parser.parseGoogleFolwrOpen(PROSE_HTML)).text;
    expect(text).toContain('Код nums.sort() — встроенная сортировка.');
    expect(text).not.toContain('```');
  });

  test('адаптер без хелпера отдаёт ту же прозу (DOM-путь байтово прежний)', () => {
    document.body.innerHTML = PROSE_HTML;
    const legacy = loadAdapter({ noWindow: true, require: undefined }).extractMessages();
    const withHelper = loadAdapter().extractMessages();
    expect(legacy.map(function (m) { return m.content; })).toEqual(withHelper.map(function (m) { return m.content; }));
    expect(withHelper[1].content).toContain('Код nums.sort() — встроенная сортировка.');
    expect(withHelper[1].content).not.toContain('```');
  });
});

// =====================================================================================
// R3: санация не ломает фенсы
// =====================================================================================
describe('O-45 R3: санация (stripTags/sanitizeAssistant) фенсы не режет', () => {
  test('фенс в вопросе пользователя (путь stripTags) сохранён целиком', () => {
    const html = TID + turnHead('t1', 'Вот код:\n```python\n' + PY_CODE + '\n```') +
      '<div class="n6owBd awi2gc">Принято.</div>';
    const user = Parser.parseGoogleFolwrOpen(html).messages[0];
    expect(user.role).toBe('user');
    expect(user.text).toContain('```python\n' + PY_CODE + '\n```');
    expect((user.text.match(/```/g) || [])).toHaveLength(2);
  });

  test('код с ``` внутри получает удлинённый фенс — код не разваливается', () => {
    const nested = '# Заголовок\n\n```js\nconst a = 1;\n```\n\n    отступ';
    const html = TID + turnHead('t1', 'Markdown') +
      '<div class="n6owBd awi2gc">Пример:</div>' +
      '<pre><code class="language-markdown">' + nested + '</code></pre>';
    const text = assistantOf(Parser.parseGoogleFolwrOpen(html)).text;
    expect(text).toContain('````markdown\n' + nested + '\n````');
    expect(text).toContain('\n    отступ\n');            // отступ кода не срезан
    expect((text.match(/````/g) || [])).toHaveLength(2); // ровно пара внешних фенсов
  });

  test('пустой/битый вход не бросает (гард прежний)', () => {
    expect(Parser.parseGoogleFolwrOpen(null).messages).toHaveLength(0);
    expect(Parser.parseGoogleFolwrOpen(undefined).messages).toHaveLength(0);
    expect(Parser.parseGoogleFolwrOpen('<div><pre></pre></div>').messages).toHaveLength(0);
  });
});
