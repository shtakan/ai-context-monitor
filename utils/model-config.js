// utils/model-config.js  (рабочая версия + авто-генерация Gemini-ключей из данных сети = пункт b)
// В этом шаге меняется ТОЛЬКО этот файл. content.js / gemini-intercept.js / background.js /
// manifest / адаптеры — НЕ ТРОГАТЬ. Правка аддитивна: цикл в конце только ДОБАВЛЯЕТ ключи
// (проверка "если ключа нет"), существующие не меняет → поведение для уже замаппленных slug
// не меняется, цифра не трогается (окно/порог те же), меняется только подпись имени в кружке.
const ModelConfig = {
  EFFECTIVE_CAP_DEFAULT: 128000,
  models: {
    'gpt-5.5': {
      name: 'GPT-5.5',
      provider: 'OpenAI',
      contextLimit: 1000000,
      description: 'Флагман OpenAI 2026 (формальное окно 1M; порог деградации см. EFFECTIVE_CAP)'
    },
    'gpt-5': {
      name: 'GPT-5',
      provider: 'OpenAI',
      contextLimit: 1000000,
      description: 'Линейка GPT-5'
    },
    'gpt-4.1': {
      name: 'GPT-4.1',
      provider: 'OpenAI',
      contextLimit: 1000000,
      description: 'GPT-4.1, окно 1M'
    },
    'gpt-4o': {
      name: 'GPT-4o',
      provider: 'OpenAI',
      contextLimit: 128000,
      description: 'Флагманская модель OpenAI'
    },
    'gpt-4o-mini': {
      name: 'GPT-4o Mini',
      provider: 'OpenAI',
      contextLimit: 128000,
      description: 'Облегчённая версия GPT-4o'
    },
    'gpt-4-turbo': {
      name: 'GPT-4 Turbo',
      provider: 'OpenAI',
      contextLimit: 128000,
      description: 'Предыдущая флагманская модель'
    },
    'gpt-4': {
      name: 'GPT-4',
      provider: 'OpenAI',
      contextLimit: 8192,
      description: 'Базовая GPT-4'
    },
    'gpt-3.5-turbo': {
      name: 'GPT-3.5 Turbo',
      provider: 'OpenAI',
      contextLimit: 16385,
      description: 'Предыдущее поколение'
    },
    // ---- Gemini: канонические ключи (дефолты/шапка) ----
    'gemini-2.5-pro': {
      name: 'Gemini 2.5 Pro',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Флагманская модель Google'
    },
    'gemini-2.5-flash': {
      name: 'Gemini 2.5 Flash',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Быстрая модель Google'
    },
    'gemini-1.5-pro': {
      name: 'Gemini 1.5 Pro',
      provider: 'Google',
      contextLimit: 2097152,
      description: 'Предыдущая флагманская модель'
    },
    // v1.26: дефолт GSA, когда slug из сети не определён. «1.5 Pro» не выдумываем:
    // окно/порог прежние (2 097 152 / 128 000 через EFFECTIVE_CAP_DEFAULT).
    'gemini-search-default': {
      name: 'Gemini (Search AI)',
      provider: 'Google',
      contextLimit: 2097152,
      description: 'Google Search AI: slug из сети не определён'
    },
    // ---- DeepSeek ----
    'deepseek-v3': {
      name: 'DeepSeek V3',
      provider: 'DeepSeek',
      contextLimit: 131072,
      description: 'Флагманская модель DeepSeek'
    },
    'deepseek-r1': {
      name: 'DeepSeek R1',
      provider: 'DeepSeek',
      contextLimit: 131072,
      description: 'Модель с усиленным reasoning'
    },
    // ---- Claude (200K для всех актуальных моделей) ----
    'claude-sonnet-5': {
      name: 'Claude Sonnet 5',
      provider: 'Anthropic',
      contextLimit: 200000,
      effectiveLimit: 128000,
      description: 'Claude Sonnet 5 (окно 200K, Sonnet 4.6 Max)'
    },
    'claude-sonnet-4-6': {
      name: 'Claude Sonnet 4.6',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude Sonnet 4.6 (окно 200K)'
    },
    'claude-sonnet-4-5': {
      name: 'Claude Sonnet 4.5',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude Sonnet 4.5 (окно 200K)'
    },
    'claude-opus-4-6': {
      name: 'Claude Opus 4.6',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude Opus 4.6 (окно 200K)'
    },
    'claude-opus-4-5': {
      name: 'Claude Opus 4.5',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude Opus 4.5 (окно 200K)'
    },
    'claude-haiku-4-5': {
      name: 'Claude Haiku 4.5',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude Haiku 4.5 (окно 200K)'
    },
    'claude-3-5-sonnet': {
      name: 'Claude 3.5 Sonnet',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude 3.5 Sonnet (окно 200K)'
    },
    'claude-3-5-haiku': {
      name: 'Claude 3.5 Haiku',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude 3.5 Haiku (окно 200K)'
    },
    'claude-3-opus': {
      name: 'Claude 3 Opus',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude 3 Opus (окно 200K)'
    },
    'claude-3-haiku': {
      name: 'Claude 3 Haiku',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude 3 Haiku (окно 200K)'
    },
    'claude-3-sonnet': {
      name: 'Claude 3 Sonnet',
      provider: 'Anthropic',
      contextLimit: 200000,
      description: 'Claude 3 Sonnet (окно 200K)'
    },
    // ---- Perplexity ----
    'turbo': {
      name: 'Perplexity Sonar (turbo)',
      provider: 'Perplexity',
      contextLimit: 128000,
      description: 'Perplexity Sonar (turbo), окно 128K'
    },
    'sonar': {
      name: 'Perplexity Sonar',
      provider: 'Perplexity',
      contextLimit: 128000,
      description: 'Perplexity Sonar, окно 128K'
    },
    'sonar-pro': {
      name: 'Perplexity Sonar Pro',
      provider: 'Perplexity',
      contextLimit: 200000,
      description: 'Perplexity Sonar Pro, окно 200K'
    },
    'sonar-reasoning': {
      name: 'Perplexity Sonar Reasoning',
      provider: 'Perplexity',
      contextLimit: 128000,
      description: 'Perplexity Sonar Reasoning, окно 128K'
    },
    'sonar-deep-research': {
      name: 'Perplexity Sonar Deep Research',
      provider: 'Perplexity',
      contextLimit: 200000,
      description: 'Perplexity Sonar Deep Research, окно 200K'
    },
    // ---- Qwen (O-35) ----
    // HYPOTHESIS: окно 128K взято как рабочая гипотеза (живой лимит из UI Qwen не снимался).
    // Если живая проверка покажет меньше (например 32K) — откатить contextLimit здесь:
    // цифра влияет только на лимит/порог бейджа, тексты и токены не трогает.
    'qwen3.8-max': {
      name: 'Qwen3.8-Max',
      provider: 'Qwen',
      contextLimit: 128000,
      description: 'Флагманская модель Qwen (chat.qwen.ai), окно 128K — HYPOTHESIS'
    },
    // ---- Gemini: строковые ключи (на случай, если детектор даст имя с префиксом/капсом) ----
    'Gemini 2.5 Pro': {
      name: 'Gemini 2.5 Pro',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Флагманская модель Google'
    },
    'Gemini 2.5 Flash': {
      name: 'Gemini 2.5 Flash',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Быстрая модель Google'
    }
  },
  siteDefaults: {
    'chatgpt': 'gpt-5.5',
    'gemini': 'gemini-2.5-flash',
    'aistudio': 'gemini-2.5-pro',
    'google_search': 'gemini-search-default',
    'deepseek': 'deepseek-v3',
    'claude': 'claude-sonnet-4-6',
    'perplexity': 'turbo',
    'qwen': 'qwen3.8-max'
  },
  // v49: реальные семейные дефолты веб-UI Gemini (кнопка button.input-area-switch
  // не несёт номера версии). Пункт (c) приоритета DOM-сигнала — когда ни кэш меню,
  // ни сетевая версия с совпадающей семьёй не дали точной версии.
  // Окна сверены с записями таблицы: Pro=128_000, Flash/Flash-Lite=1_048_576.
  familyDefaults: {
    'pro': { modelId: '3.1 Pro', contextLimit: 128000 },
    'pro-lite': { modelId: '3.1 Pro', contextLimit: 128000 },
    'flash': { modelId: '3.6 Flash', contextLimit: 1048576 },
    'flash-lite': { modelId: '3.5 Flash Lite', contextLimit: 1048576 },
    'ultra': { modelId: '3.1 Ultra', contextLimit: 1048576 }
  },
  getModel(modelId) {
    return this.models[modelId] || null;
  },
  getDefaultModel(site) {
    return this.siteDefaults[site] || 'gpt-5.5';
  },
  getContextLimit(modelId) {
    const model = this.getModel(modelId);
    return model ? model.contextLimit : 128000;
  },
  getEffectiveLimit(modelId) {
    const model = this.getModel(modelId);
    if (!model) return this.EFFECTIVE_CAP_DEFAULT;
    if (typeof model.effectiveLimit === 'number') return model.effectiveLimit;
    return Math.min(model.contextLimit, this.EFFECTIVE_CAP_DEFAULT);
  },
  // ---- H19: оверрайды попапа (chrome.storage.sync: selectedModel / customLimit) ----
  // Явный выбор модели в дропдауне авторитетен для лимита и токенизации.
  // 'auto'/пусто/неизвестный id → null = «Автоопределение» (прежний путь: сетевой slug →
  // DOM-сигнал → дефолт сайта), поведение байтово прежнее.
  resolvePopupModelId(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s || s.toLowerCase() === 'auto') return null;
    const id = this.resolveModelId(s);
    return (id && this.models[id]) ? id : null;
  },
  // Поле «Лимит контекста» = % от Авто-порога. Пусто/null → null (Авто).
  // Вне 1–100 (2000, 0, мусор) → фолбэк 100 = как Авто.
  resolveLimitPct(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const n = Number(s);
    if (!isFinite(n) || n < 1 || n > 100) return 100;
    return n;
  },
  // displayLimit = Авто-порог × pct/100 (округление 1:1 с прежним виджетом).
  // pct не задан → Авто-порог байтово.
  applyLimitPct(effectiveLimit, pct) {
    if (typeof pct !== 'number' || !(pct > 0)) return effectiveLimit;
    return Math.max(1, Math.round(pct / 100 * effectiveLimit));
  },
  computeDisplayLimit(modelId, pct) {
    return this.applyLimitPct(this.getEffectiveLimit(modelId), pct);
  },
  // v49: канонический ключ по семье(±варианту) без номера версии (DOM-сигнал v48).
  // variant нормируется: «Расширенный»/«Расширенная»/«Расширенн…» → «pro/…-расширенный»? нет:
  // вариант влияет только при выборе подходящего семейного дефолта (flash-lite vs flash).
  // Окно возвращаемой модели уже лежит в записи таблицы (см. переопределения ниже).
  getFamilyDefaultModelId(fam, variant) {
    const famK = String(fam || '').toLowerCase().replace(/[^a-z]/g, '');
    const varK = String(variant || '').toLowerCase();
    const isLite = /lite/.test(varK);
    const isExtension = /расширенн|extended|fast/.test(varK);
    const group = famK + (isLite ? '-lite' : '');
    const d = this.familyDefaults[group];
    if (!d) return null;
    return d.modelId;
  },
  // Привести сырое имя/slug к каноническому ключу. Нормализация схлопывает пробелы,
  // подчёркивания И ТОЧКИ в дефис (gpt-5-5 из сети == gpt-5.5; 3.6 Flash Расширенная == ключу).
  resolveModelId(raw) {
    if (!raw) return null;
    const norm = function (s) {
      return String(s).toLowerCase().replace(/[\s_./]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    };
    const nRaw = norm(raw);
    if (!nRaw) return null;
    const keys = Object.keys(this.models);
    // 1) точное по нормализованному
    for (let i = 0; i < keys.length; i++) {
      if (norm(keys[i]) === nRaw) return keys[i];
    }
    // 2) префикс (длинные раньше)
    const byLen = keys.map(function (k) { return { k: k, n: norm(k) }; })
      .sort(function (a, b) { return b.n.length - a.n.length; });
    for (let i = 0; i < byLen.length; i++) {
      if (byLen[i].n && nRaw.indexOf(byLen[i].n) === 0) return byLen[i].k;
    }
    // 3) подстрока (запас)
    for (let i = 0; i < byLen.length; i++) {
      if (byLen[i].n && nRaw.indexOf(byLen[i].n) !== -1) return byLen[i].k;
    }
    return null;
  },
  calculatePercentage(usedTokens, contextLimit) {
    if (contextLimit <= 0) return 0;
    const percentage = (usedTokens / contextLimit) * 100;
    return Math.min(100, Math.round(percentage * 10) / 10);
  },
  // Возвращает API-id модели для Google countTokens API.
  // Принимает канонический ключ (gemini-2.5-flash) или необработанный slug.
  // Токенизатор у Gemini общий, поэтому дефолт — стабильная общедоступная модель.
  // 09.2026: семейства 1.5/2.0 целиком 404 в v1beta → дефолт/фолбэк 'gemini-flash-latest'.
  getGeminiApiModelId(modelId) {
    // Детект-слаги, которые уже являются валидными API-id — пропускать как есть (passthrough)
    var passthrough = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash'];
    if (passthrough.indexOf(modelId) !== -1) return modelId;
    if (!modelId) return 'gemini-flash-latest';
    // Прямые известные ключи -> API id
    var map = {
      'gemini-2.5-pro': 'gemini-2.5-pro',
      'gemini-2.5-flash': 'gemini-2.5-flash',
      'gemini-search-default': 'gemini-flash-latest', // токенизатор общий, дефолт GSA → стабильная модель
      'gemini-2.5-ultra': 'gemini-2.5-ultra'
    };
    if (map[modelId]) return map[modelId];
    // Если modelId уже выглядит как API-id (содержит точку/дефис как в gemini-*) — вернуть как есть
    if (/^[a-zA-Z0-9.-]+$/.test(modelId) && modelId.indexOf('gemini') !== -1) return modelId;
    // Дефолт: стабильная модель, токенизатор общий
    return 'gemini-flash-latest';
  }
};

// Экспорт для тестов (jest); в браузере не влияет
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ModelConfig;
}

// ---- пункт b: авто-генерация Gemini-ключей из данных сети ----
// Покрывает ВСЕ сочетания версия×семейство×суффикс, чтобы имя вроде "3.5 Flash Lite" /
// "3.1 Pro Extended" маппилось точно, а не падало на дефолт. Только ДОБАВЛЯЕТ отсутствующие
// ключи (проверка ниже) → существующие явные ключи не трогает, риск слома ≈ 0.
// Окно: 1.5 Pro = 2M, остальные = 1M (на цифру не влияет — она от порога 128000).
(function () {
  var V = ['1.5', '2.0', '2.5', '3.1', '3.5', '3.6', '3.7'];
  var F = ['Flash', 'Pro', 'Ultra'];
  var S = ['', ' Lite', ' Расширенная', ' Extended'];
  function win(v, f) { return (v === '1.5' && f === 'Pro') ? 2097152 : 1048576; }
  V.forEach(function (v) {
    F.forEach(function (f) {
      S.forEach(function (s) {
        var key = v + ' ' + f + s;
        if (!ModelConfig.models[key]) {
          ModelConfig.models[key] = {
            name: 'Gemini ' + key,
            provider: 'Google',
            contextLimit: win(v, f),
            description: 'Gemini (имя из данных сети, авто-ключ)'
          };
        }
      });
    });
  });
})();

// v49: переопределение окон под реальную линейку веб-UI (а не линейку 3.7-анонса).
// Авто-генерация выше даёт 1.5 Pro=2M, остальные=1M — но в веб-UI у Pro окно 128K.
// Flash/Flash-Lite оставляем 1M (совпадает с авто). Записи 3.7-family НЕ становятся
// семейными дефолтами (см. familyDefaults выше) и оставлены только для распознавания
// версий, пришедших из сети.
(function () {
  // сверить: Pro-семейство (3.1..3.7) → 128K в веб; Flash/Flash-Lite → 1M (уже так).
  ['3.1 Pro', '3.5 Pro', '3.6 Pro', '3.7 Pro'].forEach(function (k) {
    var r = ModelConfig.models[k];
    if (r) r.contextLimit = 128000;
  });
  // гарантируем, что Flash/Flash-Lite остаются 1M (как авто-генерацией)
  ['3.6 Flash', '3.5 Flash Lite'].forEach(function (k) {
    var r = ModelConfig.models[k];
    if (r && r.contextLimit !== 1048576) r.contextLimit = 1048576;
  });
})();