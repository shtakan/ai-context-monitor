/**
 * O-39 (дефект C, R-D пины): REASONING ПРОХОДИТ КАЖДЫЙ ПУТЬ ЗАПИСИ БАЗЫ И ДОЕЗЖАЕТ ДО ФАЙЛА.
 *
 * Дефект: reasoning есть в стриме (qwen-stream-end reasoningFrames > 0) и строкой в попапе,
 * но в txt/md-экспорте Qwen секции [REASONING] нет. Корень найден и исправлен в рабочей копии:
 * сообщения ПЕРЕСОБИРАЮТСЯ на пути записи базы, и поле reasoning терялось в ДВУХ точках:
 *   (1) core/export-manager.js:aiCmCollectExportSource —
 *       сетевая ветка строила {role,text} из lastDetailMessages[i] и теряла dm.reasoning
 *       (O-39: строка копирования `if (typeof dm.reasoning === 'string' && dm.reasoning)`);
 *       DOM-фолбэк чередования ролей строил {role,text} из norm[n2] и терял служебные поля
 *       (O-39: обход for-in копирует ВСЕ ключи кроме role/text с hasOwnProperty-фильтром);
 *   (2) core/base-handler.js:aiCmDedupeExportSource —
 *       не-Gemini ветка строила {role,text} из messages[p] и теряла mp.reasoning
 *       (O-39: строка копирования `if (typeof mp.reasoning === 'string' && mp.reasoning)`);
 *       ветка Gemini/AI Studio не тронута (идёт через пайплайн prepareExportMessages).
 * Точка ВЫХОДА (единая) — рендер utils/export-text-builders.js: рендерер читает ТОЛЬКО поле
 * message.reasoning, поэтому фикс сделан на путях ЗАПИСИ базы, а не расширением рендерера
 * (source-пин S4: в withReasoningSections нет ни одного упоминания hiddenReasoning).
 *
 * R-D-контур (правило §0: пины на КАЖДЫЙ путь записи базы + точка выхода):
 *   D1 — сетевая ветка точки сбора (Qwen): поле reasoning снимка доезжает до выхода массивом;
 *   D2 — не-Gemini ветка дедупа (core/base-handler.js): поле reasoning доезжает до выхода;
 *   D3 — DOM-фолбэк чередования ролей (Qwen, baseSeen=false, роль в адаптере отсутствует):
 *        поле захвата hiddenReasoning доезжает до выхода объекта-сообщения;
 *   D4 — точка выхода: рендер отдаёт [REASONING] и [ANSWER] (чистая функция + сборщики);
 *   D5 — сквозной путь файла: collect → dedupe (ровно выражение buildHistoryMessages) →
 *        buildTxtFromHistory/buildMdFromHistory Qwen: секция [REASONING] в файле;
 *   D6 — СТАДИЯ ФОРМИРОВАНИЯ БАЗЫ (core/content.js:720-760): снимок пересобирается как
 *        {role,text,id} (поле reasoning на этой стадии теряется — исходный корень дефекта),
 *        но размышление доезжает до файла ЧЕРЕЗ СЕКЦИИ текста (нормализация
 *        applyReasoningExportFields на выходе точки сбора). D1/D5 кормят точку сбора
 *        синтетическим снимком с полем — полный live-путь покрывал только D6;
 *   D7 — R-D «диагностика только под гейтом aiCmDebug» и «байты выхода при гейте вкл/выкл
 *        идентичны» на путях ЭТОГО дефекта (реальный utils/debug.js в песочнице);
 *   R1 — DeepSeek (сетевой путь): поля reasoning в снимке нет → ключа нет, txt байтово прежний;
 *   R2 — ChatGPT/Claude/Perplexity/GSA/Gemini/AI Studio: то же (шесть платформ не задеты);
 *   R3 — пустое reasoning ('') → поле НЕ копируется (falsy-check обоих фиксов);
 *   R4 — ветка Gemini/AI Studio дедупа не тронута (гейт `site !== 'gemini' && site !== 'aistudio'`);
 *   S  — source-пины проводки: обе строки копирования, for-in фолбэка, единая точка санации,
 *        цепочка buildHistoryMessages и «рендерер читает только reasoning».
 *
 * Особенность фикса (зафиксирована пинами R1/R2): копия `dm.reasoning` в сетевой ветке НЕ
 * гейтится сайтом (в отличие от O-37-нормализации, у которой гейт aiCmReasoningExportSite),
 * а рендер платформу не различает вовсе. Байтовый инвариант шести платформ держится ФОРМОЙ
 * снимка: content.js при непустой сети пересобирает lastDetailMessages как {role,text,id}
 * (core/content.js:664-675), поэтому поля reasoning у чужих платформ там нет — это и
 * воспроизводят моки R1/R2 (снимок без reasoning).
 *
 * НЕ ТРОГАЕТСЯ: core/export-manager.js, core/base-handler.js, utils/export-text-builders.js —
 * только чтение источника; поведение прочих платформ (байты) — R-пины.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const BASE_HANDLER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'base-handler.js'), 'utf8');
const BUILDERS_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-text-builders.js'), 'utf8');
// D7: РЕАЛЬНЫЙ utils/debug.js (канонический гейт aiCmDebug) — только для пина «диагностика
// под гейтом»: в прочих пинах он не подключается вовсе (прежнее поведение песочницы 1:1).
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/qwen-reasoning-export-o37.test.js).
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

// Живые числа артефакта O-37 (chat=4cf29053): reasoningLen=214, ответ 277 знаков.
const REASONING = 'Пользователь здоровается и просит короткий ответ без лишних деталей. ' +
  'Отвечу приветствием и предложу помощь — этого достаточно.';
const ANSWER = 'Привет! Чем помочь?';
const SECTIONED = '[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER;
const QUESTION = 'привет';

// РЕАЛЬНЫЙ регион core/export-manager.js: sanitizeGeminiText → aiCmSanitizeEmitUserTexts →
// O-37/O-39-хелперы → aiCmCollectExportSource (границы — как в O-37-сьюте).
const COLLECT_SRC = MGR_SRC.slice(
  MGR_SRC.indexOf('function sanitizeGeminiText(s)'),
  MGR_SRC.indexOf('// T1-fix#3')
);

/**
 * Песочница ПУТИ ЗАПИСИ БАЗЫ: РЕАЛЬНЫЕ aiCmCollectExportSource (export-manager) и
 * aiCmDedupeExportSource (base-handler) в одном скоупе — ровно как в браузере, где модули
 * делят глобальный лексический скоуп. Выход наружу:
 *   collect(texts, detail) — сетевой/DOM путь точки сбора;
 *   dedupe(messages)       — путь схлопывания базы (core/base-handler.js);
 *   history(texts, detail) — ТО ЖЕ выражение, что в buildHistoryMessages (collect → dedupe);
 *   setBase(texts, detail) — прямая запись базы (стадия формирования content.js, пин D6);
 *   sanitize(s)            — РЕАЛЬНЫЙ sanitizeGeminiText песочницы (стадия формирования D6);
 *   txt(msgs, site) / md(msgs, site) — единая точка выхода (сборщики файла);
 *   setGate(v) / diag()    — гейт aiCmDebug и снятые diag-строки (только opts.diag, пин D7).
 */
function makeBaseWriter(opts) {
  const o = opts || {};
  const site = o.site || 'qwen';
  const adapterMessages = o.adapterMessages || [];
  // D7: гейт aiCmDebug. Песочница без opts.diag не подключает utils/debug.js вовсе —
  // для неё aiCmDiagLine не существует (typeof-гард), поведение прежнее 1:1.
  let gate = (o.gate === true);
  const logs = [];
  const ctx = {
    window: { AiCmExportEmitPipeline: P },
    sessionStorage: {
      getItem: function (k) { return (gate && k === 'aiCmDebug') ? '1' : null; },
      setItem: function () { },
      removeItem: function () { }
    },
    console: {
      log: function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); },
      warn: function () { }, error: function () { }, info: function () { }, debug: function () { }
    },
    lastBaseTexts: [],
    lastDetailMessages: null,
    baseSeen: o.baseSeen === true,
    currentAdapter: {
      siteName: site,
      extractMessages: function () { return adapterMessages.slice(); }
    },
    // зависимости Gemini-ветки дедупа (для не-Gemini не исполняются)
    aiCmLogIntraDedupe: function () { }
  };
  const src = (o.diag === true ? DEBUG_SRC + '\n' : '') + COLLECT_SRC + '\n' +
    fnDecl(BASE_HANDLER_SRC, 'aiCmDedupeExportSource') + '\n' +
    'ctx.__collect = aiCmCollectExportSource;\n' +
    'ctx.__dedupe = aiCmDedupeExportSource;\n' +
    'ctx.__history = function () { return aiCmDedupeExportSource(aiCmCollectExportSource()).messages; };\n' +
    'ctx.__sanitize = sanitizeGeminiText;\n' +
    // O-7 (тумблер): в песочнице переменная локальна — переключатель наружу.
    'ctx.__setHidden = function (v) { aiCmIncludeHiddenInExport = (v === true); };';
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  // hidden: true — песочница в режиме ON (тумблер «Включать reasoning…» ВКЛ). Пины, чей
  // инвариант «размышление доезжает до файла», живут на ON-пути: OFF-путь теперь очищает
  // поле reasoning (O-7, см. aiCmCollectExportSource) — OFF покрыт tests/qwen-o7-reasoning-toggle.
  if (o.hidden === true) ctx.__setHidden(true);
  return {
    collect: function (texts, detail) {
      ctx.lastBaseTexts = texts || [];
      ctx.lastDetailMessages = detail || null;
      return ctx.__collect();
    },
    dedupe: function (messages) {
      return ctx.__dedupe(messages);
    },
    history: function (texts, detail) {
      ctx.lastBaseTexts = texts || [];
      ctx.lastDetailMessages = detail || null;
      return ctx.__history();
    },
    /** Прямая запись базы (ровно присваивания стадии формирования core/content.js). */
    setBase: function (texts, detail) {
      ctx.lastBaseTexts = texts || [];
      ctx.lastDetailMessages = detail || null;
      ctx.baseSeen = true;
    },
    /** РЕАЛЬНЫЙ sanitizeGeminiText песочницы (та же функция, что зовёт content.js). */
    sanitize: function (s) { return ctx.__sanitize(s); },
    txt: function (messages, renderSite) {
      return Builders.buildTxtFromHistory({ site: renderSite || site, messages: messages });
    },
    md: function (messages, renderSite) {
      return Builders.buildMdFromHistory({ site: renderSite || site, messages: messages }, 'Qwen');
    },
    setGate: function (v) { gate = (v === true); },
    diag: function () {
      return logs.filter(function (s) { return s.indexOf('[AI CM][diag]') === 0; });
    }
  };
}

/** Сеть Qwen: строки базы + снимок lastDetailMessages БЕЗ поля reasoning (базовый мок R-пинов). */
function netInputNoReasoning() {
  return {
    texts: [QUESTION, ANSWER],
    detail: [{ role: 'user', text: QUESTION, id: 'u1' }, { role: 'assistant', text: ANSWER, id: 'a1' }]
  };
}

/** Сеть Qwen: снимок НЕСЁТ поле reasoning (дефект-сценарий O-39). */
function netInputWithReasoning() {
  return {
    texts: [QUESTION, ANSWER],
    detail: [
      { role: 'user', text: QUESTION, id: 'u1' },
      { role: 'assistant', text: ANSWER, id: 'a1', reasoning: REASONING }
    ]
  };
}

// =====================================================================================
// D1/D5: СЕТЕВАЯ ВЕТКА ТОЧКИ СБОРА (core/export-manager.js) + СКВОЗНОЙ ФАЙЛ
// =====================================================================================
describe('O-39 D1: сетевая ветка точки сбора — dm.reasoning доезжает до выхода', () => {
  test('D1 Qwen: объект выхода несёт ключ reasoning со строкой снимка', () => {
    const w = makeBaseWriter({ site: 'qwen', baseSeen: true, hidden: true });
    const inp = netInputWithReasoning();
    const msgs = w.collect(inp.texts, inp.detail);
    expect(msgs).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(msgs[1], 'reasoning')).toBe(true);
    expect(msgs[1].reasoning).toBe(REASONING);
    expect(msgs[1].text).toBe(ANSWER);            // текст — bare-ответ (санация секций OFF-пути)
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[0].reasoning).toBeUndefined();    // user-ход мока поля не несёт
  });

  test('D1+ D5: та же база после дедупа (buildHistoryMessages) → файл txt/md с [REASONING]', () => {
    const w = makeBaseWriter({ site: 'qwen', baseSeen: true, hidden: true });
    const inp = netInputWithReasoning();
    const msgs = w.history(inp.texts, inp.detail);   // ровно aiCmDedupeExportSource(aiCmCollectExportSource()).messages
    expect(msgs[1].reasoning).toBe(REASONING);
    const txt = w.txt(msgs, 'qwen');
    expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
    expect((txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    const md = w.md(msgs, 'qwen');
    expect(md).toContain('### ASSISTANT\n\n' + SECTIONED);
  });

  test('D5-норма: без reasoning снимка — ни поля, ни секции в файле (Qwen)', () => {
    const w = makeBaseWriter({ site: 'qwen', baseSeen: true });
    const inp = netInputNoReasoning();
    const msgs = w.history(inp.texts, inp.detail);
    expect(msgs[1].reasoning).toBeUndefined();
    const txt = w.txt(msgs, 'qwen');
    expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
    expect(txt).not.toContain('[REASONING]');
  });
});

// =====================================================================================
// D2: НЕ-GEMINI ВЕТКА ДЕДУПА (core/base-handler.js)
// =====================================================================================
describe('O-39 D2: не-Gemini ветка дедупа — mp.reasoning сохраняется', () => {
  test('D2 Qwen: выход дедупа сохраняет поле reasoning (и оно доходит до файла)', () => {
    const w = makeBaseWriter({ site: 'qwen' });
    const res = w.dedupe([
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: ANSWER, reasoning: REASONING }
    ]);
    expect(res.removed).toBe(0);
    expect(res.messages).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(res.messages[1], 'reasoning')).toBe(true);
    expect(res.messages[1].reasoning).toBe(REASONING);
    expect(res.messages[1].text).toBe(ANSWER);
    expect(w.txt(res.messages, 'qwen')).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
  });

  test('D2 не-Gemini сайт: поля в снимке нет → ключ не создаётся, txt байтово прежний', () => {
    const w = makeBaseWriter({ site: 'deepseek' });
    const res = w.dedupe([
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: ANSWER }
    ]);
    expect(Object.prototype.hasOwnProperty.call(res.messages[1], 'reasoning')).toBe(false);
    expect(w.txt(res.messages, 'deepseek')).toBe(QUESTION + '\n\n' + ANSWER);
  });

  test('D2/разделение ответственности: рендер НЕ гейтит платформу — инвариант держит путь записи', () => {
    // Рендер читает ТОЛЬКО поле reasoning и не знает про сайт (O-35): если поле пришло,
    // секции появятся в файле ЛЮБОЙ платформы. Поэтому байтовый инвариант R1/R2 стоит на
    // ПУТИ ЗАПИСИ (поле не должно появиться у чужой платформы) — этот пин фиксирует, что
    // гейт живёт именно там, а не в рендере.
    expect(Builders.aiCmMessageTextWithReasoning({ role: 'assistant', text: ANSWER, reasoning: REASONING }))
      .toBe(SECTIONED);
    // и НЕ появляется из реального снимка: у прочих платформ поля reasoning в
    // lastDetailMessages нет — content.js пересобирает снимок как {role,text,id}
    // (core/content.js:664-675), R1-мок это же и проверяет.
    const w = makeBaseWriter({ site: 'deepseek', baseSeen: true });
    const inp = netInputNoReasoning();
    expect(Object.prototype.hasOwnProperty.call(w.collect(inp.texts, inp.detail)[1], 'reasoning')).toBe(false);
  });

  test('S-пин D2: строка копирования в не-Gemini ветке и гейт Gemini/AI Studio', () => {
    const src = fnDecl(BASE_HANDLER_SRC, 'aiCmDedupeExportSource');
    expect(src).toContain("if (typeof mp.reasoning === 'string' && mp.reasoning) msg.reasoning = mp.reasoning;");
    expect(src).toContain("if (site !== 'gemini' && site !== 'aistudio') {");
    expect(src).toContain('return { messages: keep, removed: 0 };');
  });
});

// =====================================================================================
// D3: DOM-ФОЛБЭК ЧЕРЕДОВАНИЯ РОЛЕЙ (Qwen, baseSeen=false)
// =====================================================================================
describe('O-39 D3: DOM-фолбэк (роль в адаптере отсутствует) — копия доп. полей norm[n2]', () => {
  // Сырой объект адаптера РОЛИ НЕ НЕСЁТ (иначе сработал бы путь hasRoles) → исполняется
  // фолбэк чередования ролей, тот самый цикл `for (var key in norm[n2])` из фикса O-39.
  const RAW_NO_ROLES = [{ content: QUESTION }, { content: ANSWER, hiddenReasoning: REASONING }];

  test('D3 Qwen: поле захвата hiddenReasoning доезжает до сообщения (полем reasoning)', () => {
    const w = makeBaseWriter({ site: 'qwen', baseSeen: false, adapterMessages: RAW_NO_ROLES });
    const msgs = w.collect([], null);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');       // роль — из чередования фолбэка
    expect(msgs[1].text).toBe(ANSWER);            // текст сырого .content не потерян
    // Поле захвата доезжает до выхода: нормализация O-37 переводит hiddenReasoning → reasoning
    // ДО копии, а сама копия (O-39) переносит его из norm[n2] в объект-сообщение.
    expect(msgs[1].reasoning).toBe(REASONING);
    expect(msgs[1].hiddenReasoning).toBeUndefined();   // служебное поле снято санацией
    expect(w.txt(msgs, 'qwen')).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
  });

  test('D3-норма: без поля захвата фолбэк ничего не добавляет (Qwen, байты прежние)', () => {
    const w = makeBaseWriter({
      site: 'qwen', baseSeen: false,
      adapterMessages: [{ content: QUESTION }, { content: ANSWER }]
    });
    const msgs = w.collect([], null);
    expect(msgs[1].reasoning).toBeUndefined();
    expect(w.txt(msgs, 'qwen')).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
  });
});

// =====================================================================================
// D4: ТОЧКА ВЫХОДА — РЕНДЕР (utils/export-text-builders.js)
// =====================================================================================
describe('O-39 D4: рендер собирает секции из поля reasoning', () => {
  test('D4 withReasoningSections: [REASONING] + [ANSWER] из чистых аргументов', () => {
    const out = Builders.aiCmWithReasoningSections(ANSWER, REASONING);
    expect(out).toBe(SECTIONED);
    expect(out).toContain('[REASONING]');
    expect(out).toContain('[ANSWER]');
  });

  test('D4 сообщение-объект с полем reasoning проходит рендер целиком', () => {
    const msg = { role: 'assistant', text: ANSWER, reasoning: REASONING };
    expect(Builders.aiCmMessageTextWithReasoning(msg)).toBe(SECTIONED);
    // пустое/отсутствующее reasoning — текст байтово прежний (норма)
    expect(Builders.aiCmMessageTextWithReasoning({ role: 'assistant', text: ANSWER })).toBe(ANSWER);
    expect(Builders.aiCmMessageTextWithReasoning({ role: 'assistant', text: ANSWER, reasoning: '' })).toBe(ANSWER);
  });
});

// =====================================================================================
// R1/R2: БАЙТОВЫЙ ИНВАРИАНТ ОСТАЛЬНЫХ ПЛАТФОРМ (поля reasoning в снимке нет)
// =====================================================================================
describe('O-39 R1/R2: прочие платформы — ключ reasoning не появляется', () => {
  const OTHER_SITES = ['deepseek', 'chatgpt', 'claude', 'perplexity', 'google_search', 'gemini', 'aistudio'];

  test('R1 DeepSeek: выход точки сбора без ключа reasoning, txt байтово прежний', () => {
    const w = makeBaseWriter({ site: 'deepseek', baseSeen: true });
    const inp = netInputNoReasoning();
    const msgs = w.collect(inp.texts, inp.detail);
    expect(Object.prototype.hasOwnProperty.call(msgs[1], 'reasoning')).toBe(false);
    expect(msgs[1].reasoning).toBeUndefined();
    expect(w.history(inp.texts, inp.detail).length).toBe(2);
    expect(w.txt(msgs, 'deepseek')).toBe(QUESTION + '\n\n' + ANSWER);
  });

  test('R2 шесть прочих платформ: ни поля, ни секции (сеть и DOM-фолбэк)', () => {
    OTHER_SITES.forEach(function (site) {
      const wNet = makeBaseWriter({ site: site, baseSeen: true });
      const inp = netInputNoReasoning();
      const net = wNet.collect(inp.texts, inp.detail);
      net.forEach(function (m) {
        expect(Object.prototype.hasOwnProperty.call(m, 'reasoning')).toBe(false);
      });

      // DOM-фолбэк: поле захвата hiddenReasoning у чужой платформы в файл не едет
      const wDom = makeBaseWriter({
        site: site, baseSeen: false,
        adapterMessages: [{ content: QUESTION }, { content: ANSWER, hiddenReasoning: REASONING }]
      });
      const dom = wDom.collect([], null);
      expect(dom[1].reasoning).toBeUndefined();
      expect(dom[1].hiddenReasoning).toBeUndefined();
      expect(dom[1].text).toBe(ANSWER);
    });
  });

  test('R4 ветка Gemini/AI Studio дедупа не тронута (идёт через пайплайн подготовки)', () => {
    ['gemini', 'aistudio'].forEach(function (site) {
      const w = makeBaseWriter({ site: site });
      const res = w.dedupe([
        { role: 'user', text: QUESTION },
        { role: 'assistant', text: ANSWER }
      ]);
      expect(res.messages.length).toBe(2);
      res.messages.forEach(function (m) {
        expect(Object.prototype.hasOwnProperty.call(m, 'reasoning')).toBe(false);
      });
    });
  });
});

// =====================================================================================
// R3: ПУСТОЕ reasoning — falsy-check обоих фиксов (поле не копируется)
// =====================================================================================
describe('O-39 R3: reasoning="" не создаёт поле ни на одном пути записи', () => {
  test('R3 сетевой путь и DOM-фолбэк: пустая строка не копируется', () => {
    const wNet = makeBaseWriter({ site: 'qwen', baseSeen: true });
    const net = wNet.collect(
      [QUESTION, ANSWER],
      [{ role: 'user', text: QUESTION }, { role: 'assistant', text: ANSWER, reasoning: '' }]
    );
    expect(Object.prototype.hasOwnProperty.call(net[1], 'reasoning')).toBe(false);

    const wDom = makeBaseWriter({
      site: 'qwen', baseSeen: false,
      adapterMessages: [{ content: QUESTION }, { content: ANSWER, hiddenReasoning: '' }]
    });
    const dom = wDom.collect([], null);
    expect(Object.prototype.hasOwnProperty.call(dom[1], 'reasoning')).toBe(false);
    expect(wNet.txt(net, 'qwen')).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
  });

  test('R3 дедуп (не-Gemini ветка): пустая строка не копируется', () => {
    const w = makeBaseWriter({ site: 'qwen' });
    const res = w.dedupe([
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: ANSWER, reasoning: '' }
    ]);
    expect(Object.prototype.hasOwnProperty.call(res.messages[1], 'reasoning')).toBe(false);
    expect(w.txt(res.messages, 'qwen')).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
  });

  test('R3 не-строка (число/null) не копируется: typeof-гард обоих фиксов', () => {
    const w = makeBaseWriter({ site: 'qwen' });
    const res = w.dedupe([
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: ANSWER, reasoning: 42 }
    ]);
    expect(Object.prototype.hasOwnProperty.call(res.messages[1], 'reasoning')).toBe(false);
  });
});

// =====================================================================================
// S: SOURCE-ПИНЫ ПРОВОДКИ (обе точки записи + единый выход)
// =====================================================================================
describe('O-39 S: пины проводки', () => {
  test('S1 точка сбора: копия dm.reasoning в сетевой ветке и единая точка санации', () => {
    const fn = fnDecl(MGR_SRC, 'aiCmCollectExportSource');
    expect(fn).toContain("if (typeof dm.reasoning === 'string' && dm.reasoning) msg.reasoning = dm.reasoning;");
    expect(fn).toContain('return aiCmSanitizeEmitUserTexts(out);');
  });

  test('S2 точка сбора: for-in копия доп. полей в DOM-фолбэке (без строкового литерала поля)', () => {
    const fn = fnDecl(MGR_SRC, 'aiCmCollectExportSource');
    expect(fn).toContain('for (var key in norm[n2]) {');
    expect(fn).toContain('Object.prototype.hasOwnProperty.call(norm[n2], key)');
    expect(fn).toContain("key !== 'role' && key !== 'text'");
    expect(fn).toContain('fbMsg[key] = norm[n2][key];');
  });

  test('S3 цепочка записи базы: buildHistoryMessages = collect → dedupe', () => {
    expect(fnDecl(BASE_HANDLER_SRC, 'buildHistoryMessages'))
      .toContain('return aiCmDedupeExportSource(aiCmCollectExportSource()).messages;');
  });

  test('S4 единый выход: рендер читает ТОЛЬКО поле reasoning (hiddenReasoning не упомянут)', () => {
    const fn = fnDecl(BUILDERS_SRC, 'withReasoningSections');
    expect(fn).toContain('REASONING_SECTION_TAG');
    expect(fn).toContain('ANSWER_SECTION_TAG');
    expect(fn).not.toContain('hiddenReasoning');
    expect(fnDecl(BUILDERS_SRC, 'reasoningOfMessage')).toContain('msg.reasoning');
  });
});

// =====================================================================================
// D6: СТАДИЯ ФОРМИРОВАНИЯ БАЗЫ (core/content.js:720-760) — ЖИВОЙ ПУТЬ ЦЕЛИКОМ
// =====================================================================================
// D1/D5 кормят точку сбора синтетическим снимком, у которого поле reasoning УЖЕ есть.
// В браузере снимок приходит из detail перехватчика и ПЕРЕСОБИРАЕТСЯ на записи базы:
//   detail.messages → preDedupe18 {role,text,id} → aiCmDedupeExportSource → texts18/msgs18
//   → lastBaseTexts/lastDetailMessages (core/content.js:720-760).
// На этой стадии поле reasoning теряется (в msgs18 попадают только role/text/id) — это и есть
// «этап формирования» из корня дефекта. Инвариант пина: размышление ВСЁ РАВНО доезжает до
// файла — через ПАРУ СЕКЦИЙ в тексте хода (нормализация applyReasoningExportFields на выходе
// точки сбора), то есть живой путь не зависит от того, донёс ли снимок отдельное поле.
/** detail перехватчика Qwen: тексты несут пару секций (composeTurnText), поля — тоже. */
function detailWithSections() {
  return {
    messageTexts: [QUESTION, SECTIONED],
    messageIds: ['u:1', 'a:1'],
    messages: [
      { role: 'user', text: QUESTION, reasoning: '' },
      { role: 'assistant', text: SECTIONED, reasoning: REASONING, hiddenReasoning: REASONING }
    ]
  };
}

/** Точная копия стадии формирования core/content.js:720-760 (preDedupe18 → dedupe → msgs18). */
function formLiveBase(w, detail) {
  const texts = detail.messageTexts;
  const ids = detail.messageIds;
  const rawMsgs18 = (Array.isArray(detail.messages) && detail.messages.length === texts.length)
    ? detail.messages : null;
  const preDedupe18 = [];
  for (let d = 0; d < texts.length; d++) {
    const r18 = rawMsgs18 ? ((rawMsgs18[d] && rawMsgs18[d].role) || '') : ((d % 2 === 0) ? 'user' : 'assistant');
    preDedupe18.push({
      role: (r18 === 'user' || r18 === 'human') ? 'user' : 'assistant',
      text: w.sanitize(texts[d]),
      id: (rawMsgs18 && rawMsgs18[d] && rawMsgs18[d].id != null) ? String(rawMsgs18[d].id) : String(ids[d])
    });
  }
  const ded18 = w.dedupe(preDedupe18);
  const prepared18 = Array.isArray(ded18.messages) ? ded18.messages : [];
  const texts18 = [];
  const msgs18 = [];
  for (let e = 0; e < prepared18.length; e++) {
    const me = prepared18[e] || {};
    const mid = (me.id != null) ? String(me.id)
      : ((preDedupe18[e] && preDedupe18[e].id != null) ? String(preDedupe18[e].id) : '');
    texts18.push(String(me.text == null ? '' : me.text));
    msgs18.push({ role: me.role, text: String(me.text == null ? '' : me.text), id: mid });
  }
  w.setBase(texts18, msgs18);
  return { texts: texts18, msgs: msgs18, preDedupe: preDedupe18 };
}

describe('O-39 D6: стадия формирования базы (content.js) — reasoning доезжает до файла', () => {
  test('D6 Qwen: msgs18 без поля reasoning → секции [REASONING]/[ANSWER] в txt и md', () => {
    const w = makeBaseWriter({ site: 'qwen', hidden: true });
    const formed = formLiveBase(w, detailWithSections());
    // корень дефекта воспроизведён: стадия формирования пересобирает снимок как {role,text,id}
    expect(formed.msgs).toHaveLength(2);
    formed.msgs.forEach(function (m) {
      expect(Object.prototype.hasOwnProperty.call(m, 'reasoning')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(m, 'hiddenReasoning')).toBe(false);
    });
    // …но файл собирается по ТЕКСТУ хода (пара секций) — размышление не теряется
    const msgs = w.history(formed.texts, formed.msgs);
    expect(msgs[1].reasoning).toBe(REASONING);
    expect(msgs[1].text).toBe(ANSWER);
    const txt = w.txt(msgs, 'qwen');
    expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
    expect((txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect((txt.match(/\[ANSWER\]/g) || [])).toHaveLength(1);
    const md = w.md(msgs, 'qwen');
    expect(md).toContain('### ASSISTANT\n\n' + SECTIONED);
    expect((md.match(/\[REASONING\]/g) || [])).toHaveLength(1);
  });

  test('D6-норма: база без секций и без поля → файл байтово bare-ответ (Qwen)', () => {
    const w = makeBaseWriter({ site: 'qwen', hidden: true });
    const formed = formLiveBase(w, {
      messageTexts: [QUESTION, ANSWER],
      messageIds: ['u:1', 'a:1'],
      messages: [{ role: 'user', text: QUESTION, reasoning: '' }, { role: 'assistant', text: ANSWER, reasoning: '' }]
    });
    const msgs = w.history(formed.texts, formed.msgs);
    expect(msgs[1].reasoning).toBeUndefined();
    const txt = w.txt(msgs, 'qwen');
    expect(txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
    expect(txt).not.toContain('[REASONING]');
  });

  test('D6-регресс: та же стадия формирования у платформы без reasoning — байты прежние', () => {
    const w = makeBaseWriter({ site: 'deepseek', hidden: true });
    const formed = formLiveBase(w, {
      messageTexts: [QUESTION, ANSWER],
      messageIds: ['u:1', 'a:1'],
      messages: [{ role: 'user', text: QUESTION }, { role: 'assistant', text: ANSWER }]
    });
    const msgs = w.history(formed.texts, formed.msgs);
    msgs.forEach(function (m) {
      expect(Object.prototype.hasOwnProperty.call(m, 'reasoning')).toBe(false);
    });
    expect(w.txt(msgs, 'deepseek')).toBe(QUESTION + '\n\n' + ANSWER);
  });
});

// =====================================================================================
// D7: ГЕЙТ aiCmDebug (диагностика только под гейтом; байты от гейта не зависят)
// =====================================================================================
describe('O-39 D7: диагностика только под гейтом aiCmDebug, байты выхода от гейта не зависят', () => {
  test('D7 гейт ВЫКЛ → ни одной diag-строки; ВКЛ → строки есть; txt/md байтово те же', () => {
    const w = makeBaseWriter({ site: 'qwen', hidden: true, diag: true, gate: false });
    const formed = formLiveBase(w, detailWithSections());
    const offMsgs = w.history(formed.texts, formed.msgs);
    const offTxt = w.txt(offMsgs, 'qwen');
    const offMd = w.md(offMsgs, 'qwen');
    expect(w.diag()).toEqual([]);                       // без гейта — ни одной строки

    w.setGate(true);
    const onMsgs = w.history(formed.texts, formed.msgs);
    const onTxt = w.txt(onMsgs, 'qwen');
    const onMd = w.md(onMsgs, 'qwen');
    expect(onTxt).toBe(offTxt);                         // байты выхода идентичны
    expect(onMd).toBe(offMd);
    expect(onMsgs[1].reasoning).toBe(REASONING);        // инвариант дефекта держится при обоих положениях
    expect(w.diag().length).toBeGreaterThan(0);         // гейт рабочий (строки появляются)
    // O-39-пути собственной диагностики не вводят: строк qwen-* нет ни под гейтом, ни без
    expect(w.diag().filter(function (s) { return s.indexOf('qwen-') !== -1; })).toEqual([]);
  });

  test('S-пин D7: гейт — канонический utils/debug.js (sessionStorage aiCmDebug), не свой', () => {
    expect(DEBUG_SRC).toContain("sessionStorage.getItem('aiCmDebug') === '1'");
    expect(DEBUG_SRC).toContain('function aiCmDiagOn()');
    expect(DEBUG_SRC).toContain('if (!aiCmDiagOn()) return false;');
  });
});
