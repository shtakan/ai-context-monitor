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
'DeepSeek-V3': {
name: 'DeepSeek V3',
provider: 'DeepSeek',
contextLimit: 131072,
description: 'Флагманская модель DeepSeek'
},
    'DeepSeek-R1': {
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
    'google_search': 'gemini-2.5-flash',
    'deepseek': 'deepseek-v3',
    'claude': 'claude-sonnet-4-6'
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
  getGeminiApiModelId(modelId) {
    if (!modelId) return 'gemini-1.5-pro';
    // Прямые известные ключи -> API id
    var map = {
      'gemini-2.5-pro': 'gemini-2.5-pro',
      'gemini-2.5-flash': 'gemini-2.5-flash',
      'gemini-1.5-pro': 'gemini-1.5-pro',
      'gemini-1.5-flash': 'gemini-1.5-flash',
      'gemini-2.0-flash': 'gemini-2.0-flash',
      'gemini-2.0-pro': 'gemini-2.0-pro',
      'gemini-2.5-ultra': 'gemini-2.5-ultra'
    };
    if (map[modelId]) return map[modelId];
    // Если modelId уже выглядит как API-id (содержит точку/дефис как в gemini-*) — вернуть как есть
    if (/^[a-zA-Z0-9.-]+$/.test(modelId) && modelId.indexOf('gemini') !== -1) return modelId;
    // Дефолт: стабильная модель, токенизатор общий
    return 'gemini-1.5-pro';
  }
};

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