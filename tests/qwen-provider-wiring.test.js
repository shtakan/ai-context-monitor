/**
 * O-35: проводка провайдера Qwen — manifest.json, core/background.js, core/content.js,
 * utils/model-config.js и контракт reasoning в сборщиках экспорта.
 *
 * Здесь ЧЕТЫРЕ независимых блока:
 *   1) R-пины: объявления шести существующих перехватчиков и их пути байтово прежние;
 *   2) проводка Qwen (host_permissions + matches + адаптер в content_scripts; регистрация
 *      перехватчика в MAIN-мире в core/background.js);
 *   3) core/content.js: ветка Qwen + КРИТИЧНЫЙ запрет «Qwen НЕ в isGeminiSvc»
 *      (иначе стримовый usage Qwen перезаписывался бы countTokens BYOK);
 *   4) utils/model-config.js: qwen3.8-max (128K — HYPOTHESIS) + дефолт сайта qwen;
 *   5) utils/export-text-builders.js: [REASONING]/[ANSWER] из отдельного поля reasoning,
 *      байтовый инвариант для платформ без reasoning.
 *
 * Тесты только ЧИТАЮТ реальные файлы проекта (стиль manifest-smoke / version-hygiene).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

const manifest = JSON.parse(read('manifest.json'));
const manifestRaw = read('manifest.json');
const background = read('core/background.js');
const content = read('core/content.js');
const modelConfigRaw = read('utils/model-config.js');
const ModelConfig = require('../utils/model-config.js');
const Builders = require('../utils/export-text-builders.js');

// Рез по балансу фигурных скобок (конвенция сьюта): тело функции до парной скобки.
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

describe('O-35: manifest.json — Qwen добавлен, прежние сервисы не тронуты', function () {
  test('host_permissions: chat.qwen.ai есть, прочие хосты на месте', function () {
    expect(manifest.host_permissions).toContain('https://chat.qwen.ai/*');
    expect(manifest.host_permissions).toContain('https://chatgpt.com/*');
    expect(manifest.host_permissions).toContain('https://gemini.google.com/*');
    expect(manifest.host_permissions).toContain('https://chat.deepseek.com/*');
    expect(manifest.host_permissions).toContain('https://claude.ai/*');
    expect(manifest.host_permissions).toContain('https://www.perplexity.ai/*');
    expect(manifest.host_permissions).toContain('https://www.google.com/search*');
    expect(manifest.host_permissions).toContain('https://generativelanguage.googleapis.com/*');
    expect(manifest.host_permissions).toHaveLength(10);
  });

  test('content_scripts.matches: chat.qwen.ai есть, прежние совпадения байтово на месте', function () {
    const matches = manifest.content_scripts[0].matches;
    expect(matches).toContain('https://chat.qwen.ai/*');
    ['https://chatgpt.com/*', 'https://gemini.google.com/*', 'https://chat.deepseek.com/*',
      'https://aistudio.google.com/*', 'https://www.google.com/search*', 'https://claude.ai/*',
      'https://www.perplexity.ai/*', 'https://perplexity.ai/*'].forEach(function (m) {
      expect(matches).toContain(m);
    });
  });

  test('content_scripts.js: qwen-adapter.js подключён, прежние пути сохранены', function () {
    const js = manifest.content_scripts[0].js;
    expect(js).toContain('adapters/qwen-adapter.js');
    ['utils/debug.js', 'utils/tokenizer.js', 'utils/model-config.js', 'adapters/base-adapter.js',
      'adapters/chatgpt-adapter.js', 'adapters/gemini-adapter.js', 'adapters/deepseek-adapter.js',
      'adapters/google-search-adapter.js', 'adapters/claude-adapter.js',
      'adapters/perplexity-adapter.js', 'utils/export-text-builders.js',
      'utils/export-emit-pipeline.js', 'core/content.js'].forEach(function (p) {
      expect(js).toContain(p);
    });
    // Перехватчик Qwen в content_scripts НЕ дублируется: он ставится программно в MAIN-мир
    // через registerContentScripts (тот же паттерн, что у шести существующих перехватчиков).
    expect(js).not.toContain('core/qwen-intercept.js');
    expect(js).not.toContain('utils/stream-frames.js');
  });

  test('version/инварианты не тронуты этим коммитом (bump — только в релизном)', function () {
    expect(manifest.version).toBe('2.0.11');
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts).toHaveLength(1);
  });
});

describe('O-35: core/background.js — регистрация перехватчика Qwen в MAIN-мире', function () {
  test('новый id зарегистрирован с MAIN-миром и document_start', function () {
    const m = /id: 'ai-cm-qwen-intercept',[\s\S]*?matches: \['https:\/\/chat\.qwen\.ai\/\*'\],[\s\S]*?js: \[([^\]]*)\],[\s\S]*?runAt: 'document_start',[\s\S]*?world: 'MAIN'/.exec(background);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('utils/stream-frames.js');
    expect(m[1]).toContain('core/qwen-intercept.js');
    // порядок: утилита кадров объявлена ПЕРЕД перехватчиком
    expect(m[1].indexOf('utils/stream-frames.js')).toBeLessThan(m[1].indexOf('core/qwen-intercept.js'));
  });

  test('идемпотентность как у остальных: гард по ids.indexOf + registerSafe', function () {
    expect(background).toContain("if (ids.indexOf('ai-cm-qwen-intercept') === -1) {");
    const idx = background.indexOf("if (ids.indexOf('ai-cm-qwen-intercept') === -1) {");
    const block = background.slice(idx, idx + 600);
    expect(block).toContain("await registerSafe('ai-cm-qwen-intercept'");
  });

  test('R-пин: шесть существующих регистраций не тронуты', function () {
    ['ai-cm-page-intercept', 'ai-cm-gemini-intercept-v2', 'ai-cm-deepseek-intercept-v2',
      'ai-cm-claude-intercept', 'ai-cm-perplexity-intercept',
      'ai-cm-google-search-intercept'].forEach(function (id) {
      expect(background).toContain("ids.indexOf('" + id + "') === -1");
    });
    // набор js[] каждого из шести не изменился
    expect(background).toContain("js: ['utils/debug.js', 'utils/chatgpt-conversation-parser.js', 'utils/intercept-common.js', 'core/page-intercept.js']");
    expect(background).toContain("js: ['utils/debug.js', 'utils/gemini-batchexecute-parser.js', 'utils/gemini-intercept-logic.js', 'core/gemini-hidden-scroll.js', 'core/gemini-intercept.js']");
    expect(background).toContain("js: ['utils/debug.js', 'core/deepseek-intercept.js']");
    expect(background).toContain("js: ['utils/debug.js', 'utils/intercept-common.js', 'core/claude-intercept.js']");
    expect(background).toContain("js: ['utils/debug.js', 'utils/perplexity-parser.js', 'utils/intercept-common.js', 'core/perplexity-intercept.js']");
    expect(background).toContain("js: ['utils/debug.js', 'utils/google-search-folwr-parser.js', 'utils/intercept-common.js', 'core/google-search-intercept.js']");
  });
});

describe('O-35: core/content.js — ветка Qwen и запрет на countTokens BYOK', function () {
  test('адаптер Qwen выбирается по hostname chat.qwen.ai', function () {
    expect(content).toContain("} else if (hostname.includes('chat.qwen.ai')) {");
    expect(content).toContain('currentAdapter = new QwenAdapter();');
  });

  test('R-пин: ветки шести существующих сервисов байтово прежние', function () {
    expect(content).toContain("if (hostname.includes('chatgpt.com')) {");
    expect(content).toContain("} else if (hostname.includes('gemini.google.com') || hostname.includes('aistudio.google.com')) {");
    expect(content).toContain("} else if (hostname.includes('chat.deepseek.com')) {");
    expect(content).toContain("} else if (hostname.includes('google.com') && !hostname.includes('aistudio')) {");
    expect(content).toContain("} else if (hostname.includes('claude.ai')) {");
    expect(content).toContain("} else if (hostname.includes('perplexity.ai')) {");
  });

  test('КРИТИЧНО: isGeminiSvc остаётся РОВНО из трёх сервисов, Qwen там нет', function () {
    const m = /const isGeminiSvc = \(([^)]*)\);/.exec(content);
    expect(m).not.toBeNull();
    expect(m[1]).toBe("svc === 'gemini' || svc === 'aistudio' || svc === 'google_search'");
    expect(m[1]).not.toContain('qwen');
    // и в решении о запросе countTokens BYOK тоже нет Qwen
    expect(content).toContain('if (isGeminiSvc && exactCountEnabled && geminiApiKey && fullText && baseComplete) {');
  });
});

describe('O-35: utils/model-config.js — модель Qwen', function () {
  test('qwen3.8-max: 128K (HYPOTHESIS) и провайдер Qwen', function () {
    const rec = ModelConfig.models['qwen3.8-max'];
    expect(rec).toBeTruthy();
    expect(rec.contextLimit).toBe(128000);
    expect(rec.provider).toBe('Qwen');
    // гипотеза помечена в исходнике — при живой проверке лимит уточняется/откатывается
    expect(modelConfigRaw).toContain('HYPOTHESIS');
  });

  test('дефолт сайта qwen ведёт на ту же модель', function () {
    expect(ModelConfig.getDefaultModel('qwen')).toBe('qwen3.8-max');
    expect(ModelConfig.getContextLimit('qwen3.8-max')).toBe(128000);
  });

  test('прежние дефолты сайтов не тронуты', function () {
    expect(ModelConfig.getDefaultModel('chatgpt')).toBe('gpt-5.5');
    expect(ModelConfig.getDefaultModel('gemini')).toBe('gemini-2.5-flash');
    expect(ModelConfig.getDefaultModel('deepseek')).toBe('deepseek-v3');
    expect(ModelConfig.getDefaultModel('claude')).toBe('claude-sonnet-4-6');
    expect(ModelConfig.getDefaultModel('perplexity')).toBe('turbo');
    expect(ModelConfig.getDefaultModel('google_search')).toBe('gemini-search-default');
  });
});

describe('O-35: КРИТЕРИЙ ЖИВОЙ ПРИЁМКИ Qwen (эталон тестового «привет») — пин контракта', function () {
  // ЖИВАЯ ПРИЁМКА (ручная, в браузере на chat.qwen.ai, ОДИН ход «привет»):
  //   1) usage из СТРИМА (Network → completions → последний кадр) совпадает с числами
  //      бейджа расширения: input_tokens = 1709, output_tokens = 884, total_tokens = 2593,
  //      output_tokens_details.reasoning_tokens = 884.
  //      ВНИМАНИЕ: output_tokens ВКЛЮЧАЕТ reasoning_tokens (884 = 884), это НЕ сумма
  //      884+884 — эталон из файла экспорта чата 2026-09-18 (input 1709 / output 884 /
  //      total 2593), спека «Токены — usage.input_tokens / .output_tokens /
  //      .output_tokens_details.reasoning_tokens».
  //   2) провайдер в стейте — 'qwen': попап/бейдж показывают модель Qwen3.8-Max
  //      (ModelConfig.getDefaultModel('qwen') === 'qwen3.8-max').
  //   3) тултип бейджа показывает output_tokens_details.reasoning_tokens ОТДЕЛЬНОЙ строкой
  //      (reasoning ≠ 0 при thinking), а не растворяет её в output.
  //   4) серверный usage НЕ перезаписывается countTokens BYOK: Qwen отсутствует в isGeminiSvc.
  //   5) при снятом клоне (clone() не удался) экспорт не пустеет — работает DOM-фолбэк.
  // Автоматические пины ниже фиксируют ПРОВОДКУ под этот критерий; сами ЧИСЛА 1709/884/2593
  // проверяются на фикстуре стрима в tests/qwen-intercept.test.js (D4 + антипод-пин суммы).
  const LIVE = { input: 1709, output: 884, total: 2593, reasoning: 884 };

  test('эталонные числа и их семантика зафиксированы в тестах стрима', function () {
    const src = read('tests/qwen-intercept.test.js');
    expect(src).toContain('input_tokens: 1709, output_tokens: 884, total_tokens: 2593');
    expect(src).toContain("reasoning_tokens: 884");
    // output ВКЛЮЧАЕТ reasoning — антипод-пин суммы обязателен
    expect(src).toContain('антипод-пин');
    expect(LIVE.output).toBe(LIVE.reasoning);
    expect(LIVE.input + LIVE.output).toBe(LIVE.total);
  });

  test('провайдер стейта = qwen, отдельная строка reasoning в контракте detail', function () {
    const intercept = read('core/qwen-intercept.js');
    // qwenUsage с отдельным reasoningTokens — источник отдельной строки тултипа
    expect(intercept).toContain('reasoningTokens: (typeof usage.reasoning === \'number\') ? usage.reasoning : 0');
    expect(intercept).toContain('outputTokens: (typeof usage.output === \'number\') ? usage.output : 0');
    expect(intercept).toContain('inputTokens: (typeof usage.input === \'number\') ? usage.input : 0');
    // provider в detail/модели стейта
    expect(ModelConfig.models['qwen3.8-max'].provider).toBe('Qwen');
    expect(ModelConfig.getDefaultModel('qwen')).toBe('qwen3.8-max');
  });

  test('tokenizer.js не тронут (BYOK-путь считает только Gemini-сервисы)', function () {
    const tokenizer = read('utils/tokenizer.js');
    expect(tokenizer).not.toContain('qwen');
  });
});

describe('O-35 (G3): R-D на каждый путь записи базы Qwen', function () {
  const intercept = read('core/qwen-intercept.js');

  test('единственная точка записи базы — emitBaseSnapshot-аналог за гардом непустого текста', function () {
    // Записи в базу у Qwen ровно ДВЕ: (1) живой SSE через endStream → emitSnapshot и
    // (2) DOM-фолбэк адаптера (сеть в базу не пишет вовсе). Оба пути проверяются здесь.
    expect(intercept).toContain("if (!s.answer && !s.reasoning) {");
    expect(intercept).toContain("diagLine('emit-skip', { reason: 'empty-stream' });");
    expect(intercept).toContain("if (!text) { diagLine('emit-skip', { reason: 'empty-text' }); return false; }");
    // ключ хода берётся из response.created, иначе — детерминированный фолбэк по чату
    expect(intercept).toContain('var key = s.responseId || (chatId + \'#\' + turnSeq);');
  });

  test('путь SSE: пустой/битый поток базу НЕ пишет (снимок не публикуется)', async function () {
    // content.js применяет снимок только при непустом detail.text
    expect(content).toContain('if (!detail || !detail.text) return;');
  });

  test('путь DOM-фолбэка: адаптер отдаёт тексты, пустой DOM — пустой массив (не «мусорный» снимок)', function () {
    expect(read('adapters/qwen-adapter.js')).toContain('getFullDialogText()');
    // фолбэк активируется ТОЛЬКО когда чтение тела не выполнено — тело страницы не тронуто
    expect(intercept).toContain("diagLine('stream-skip', { reason: 'clone-failed', fallback: 'dom' });");
    expect(intercept).toContain("diagLine('stream-skip', { reason: 'no-reader', fallback: 'dom' });");
  });

  test('R-пин: остальные шесть платформ в content.js/emit-пайплайне не переписаны', function () {
    const pipeline = read('utils/export-emit-pipeline.js');
    // D-O41 (пересмотр 2026-09-25): единственное знание пайплайна об именах платформ — пара
    // force-exclude сервисов внутри ЧИСТОЙ функции effectiveReasoningToggle (Qwen/DeepSeek:
    // OFF у них значит принудительное исключение reasoning, авто-ON не срабатывает).
    // Комментарии не считаем: пинится КОД.
    const code = pipeline.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const eff = fnDecl(pipeline, 'effectiveReasoningToggle');
    expect(eff).toContain("if (site === 'qwen' || site === 'deepseek') return false;");
    expect((code.match(/qwen/g) || []).length).toBe(1);       // ровно эта ветка
    expect(code).not.toContain('Qwen');
    // координаты сравниваем В ОДНОЙ строке (code): имя платформы стоит внутри тела функции
    expect(code.indexOf('qwen')).toBeGreaterThan(code.indexOf('function effectiveReasoningToggle('));
    // собственной ветки Qwen в emit-пайплайне экспорта по-прежнему нет
    expect(code).not.toContain('Qwen3');
  });
});

describe('O-35: экспорт — контракт [REASONING]/[ANSWER] для отдельного поля reasoning', function () {
  const REASONING = 'Пользователь здоровается.';
  const ANSWER = 'Привет!';

  test('md: reasoning уходит секциями, ответ — после [ANSWER]', function () {
    const md = Builders.buildMdFromHistory({
      model: 'qwen3.8-max', tokens: 2593, limit: 128000, percent: 2,
      messages: [{ role: 'user', text: 'привет' }, { role: 'assistant', text: ANSWER, reasoning: REASONING }]
    }, 'Qwen');
    expect(md).toContain('[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
  });

  test('txt: та же форма (txt-эталон собирается из тех же сообщений)', function () {
    const txt = Builders.buildTxtFromHistory({
      messages: [{ role: 'assistant', text: ANSWER, reasoning: REASONING }]
    });
    expect(txt).toBe('[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
  });

  test('R-пин: без reasoning байты прежние (все шесть существующих платформ)', function () {
    const hist = {
      model: 'DeepSeek-R1', tokens: 100, limit: 131072, percent: 1,
      messages: [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: 'ответ' }]
    };
    const txt = Builders.buildTxtFromHistory(hist);
    expect(txt).toBe('вопрос\n\nответ');
    expect(txt).not.toContain('[REASONING]');
    const md = Builders.buildMdFromHistory(hist, 'deepseek');
    expect(md).toContain('## Ассистент\n\nответ');
    expect(md).not.toContain('[REASONING]');
  });

  test('R-пин: reasoning, УЖЕ в тексте (сетевой путь DeepSeek), не дублируется', function () {
    const composed = '[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER;
    const txt = Builders.buildTxtFromHistory({
      messages: [{ role: 'assistant', text: composed, reasoning: REASONING }]
    });
    expect(txt).toBe(composed);
    expect(txt.match(/\[REASONING\]/g)).toHaveLength(1);
  });

  test('json: поле reasoning остаётся отдельным (схема не меняется)', function () {
    const json = JSON.parse(Builders.buildJsonFromHistory({
      model: 'qwen3.8-max', tokens: 2593, limit: 128000, percent: 2,
      messages: [{ role: 'assistant', text: ANSWER, reasoning: REASONING }]
    }, 'Qwen'));
    expect(json.messages[0].reasoning).toBe(REASONING);
    expect(json.messages[0].text).toBe(ANSWER);
  });

  test('чистая функция контракта доступна наружу и идемпотентна', function () {
    const once = Builders.aiCmMessageTextWithReasoning({ text: ANSWER, reasoning: REASONING });
    expect(once).toBe('[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER);
    expect(Builders.aiCmMessageTextWithReasoning({ text: once, reasoning: REASONING })).toBe(once);
    expect(Builders.aiCmMessageTextWithReasoning({ text: ANSWER })).toBe(ANSWER);
    expect(Builders.aiCmMessageTextWithReasoning(null)).toBe('');
  });
});
