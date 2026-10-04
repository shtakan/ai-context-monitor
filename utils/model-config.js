// utils/model-config.js  (рабочая версия + авто-генерация Gemini-ключей из данных сети = пункт b)
// В этом шаге меняется ТОЛЬКО этот файл. content.js / gemini-intercept.js / background.js /
// manifest / адаптеры — НЕ ТРОГАТЬ. Правка аддитивна: цикл в конце только ДОБАВЛЯЕТ ключи
// (проверка "если ключа нет"), существующие не меняет → поведение для уже замаппленных slug
// не меняется, цифра не трогается (окно/порог те же), меняется только подпись имени в кружке.
const ModelConfig = {
  EFFECTIVE_CAP_DEFAULT: 128000,
  models: {
    // ---- OpenAI: текущая линейка 2026-10 ----
    // Окна взяты с официальной страницы моделей OpenAI (platform.openai.com/docs/models).
    // ВАЖНО: ChatGPT ВЕБ не документирует своё окно отдельной строкой — порог бейджа
    // для ChatGPT остаётся общим (128000), capExempt не выставляем: лимит 1 050 000
    // подтверждён для API, но веб-продукт его не заявляет (см. описание gpt-5.5).
    'gpt-5.6-sol': {
      name: 'GPT-5.6 Sol',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'GPT-5.6 Sol — актуальная ветка GPT-5.6, окно 1 050 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-5.6-luna': {
      name: 'GPT-5.6 Luna',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'GPT-5.6 Luna — окно 1 050 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-5.6-terra': {
      name: 'GPT-5.6 Terra',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'GPT-5.6 Terra — окно 1 050 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-6-astra': {
      name: 'GPT-6 Astra',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'GPT-6 Astra — флагман GPT-6, окно 1 050 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-6.1-sol': {
      name: 'GPT-6.1 Sol',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'GPT-6.1 Sol — окно 1 050 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-6-sol': {
      name: 'GPT-6 Sol',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'GPT-6 Sol — окно 1 050 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-5.5': {
      name: 'GPT-5.5',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'Флагман OpenAI 2026 (окно 1 050 000 в API; порог бейджа в ChatGPT — 128000, capExempt не выставляем: веб-продукт окно не заявляет)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-5.5-pro': {
      name: 'GPT-5.5 Pro',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'GPT-5.5 Pro — окно 1 050 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    // ЖИВАЯ ПРИЁМКА 2026-10-04 (chatgpt.com, бесплатный аккаунт): сеть отдаёт
    // raw="gpt-5-6" → resolveModelId даёт префиксное совпадение с 'gpt-5'
    // (см. [model-detect] в консоли). Поэтому у GPT-5.6 нужен ОТДЕЛЬНЫЙ ключ 'gpt-5-6'.
    'gpt-5-6': {
      name: 'GPT-5.6',
      provider: 'OpenAI',
      contextLimit: 1050000,
      description: 'GPT-5.6 — slug из сети ChatGPT (gpt-5-6), окно 1 050 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-5': {
      name: 'GPT-5',
      provider: 'OpenAI',
      contextLimit: 400000,
      description: 'Линейка GPT-5, окно 400 000 (API)',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
    },
    'gpt-4.1': {
      name: 'GPT-4.1',
      provider: 'OpenAI',
      contextLimit: 1047576,
      description: 'GPT-4.1, окно 1 047 576',
      // Источник: https://platform.openai.com/docs/models (снят 2026-10-04)
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
    // gemini-1.5-pro: официальная страница модели снята с docs (404, модель выведена из
    // эксплуатации) — цифру 2 097 152 подтвердить нечем, оставлена как есть (её пинят
    // tests/popup-overrides-display.test.js:106,241). Порог бейджа от неё не зависит.
    'gemini-1.5-pro': {
      name: 'Gemini 1.5 Pro',
      provider: 'Google',
      contextLimit: 2097152,
      description: 'Предыдущая флагманская модель. ВНИМАНИЕ: официальная страница модели снята (404), значение 2 097 152 не подтверждается — это остаток прежней конфигурации',
      // Источник (снят 2026-10-04): https://ai.google.dev/gemini-api/docs/models → 404 для gemini-1.5-pro
    },
    // ---- Gemini 3.x: канонические ключи живой линейки веб-UI ----
    // ЖИВАЯ ПРИЁМКА 2026-10-04 (gemini.google.com, меню режимов): в вебе есть ровно
    // 3.5 Flash-Lite, 3.6 Flash, 3.1 Pro — никакого «Ultra». API-окно у всех 1 048 576.
    // Окно ВЕБА у Gemini зависит от ТАРИФА, а не от модели: 32K Free / 128K AI Plus /
    // 1M AI Pro и Ultra. Тариф расширение не видит, поэтому порог бейджа для
    // Pro-семейства оставлен 128000 (окно тарифа AI Plus), capExempt НЕ выставляем:
    // на младших тарифах веб режет, послабление было бы враньём.
    'gemini-3.1-pro': {
      name: 'Gemini 3.1 Pro',
      provider: 'Google',
      contextLimit: 128000,
      description: 'Gemini 3.1 Pro. API-окно 1 048 576; веб-окно зависит от тарифа (32K Free / 128K AI Plus / 1M AI Pro), в конфиге 128000 = тариф AI Plus',
      // Источник API: https://ai.google.dev/gemini-api/docs/models (снят 2026-10-04)
      // Источник тарифов веба: https://support.google.com/gemini/answer/16275805 (снят 2026-10-04)
    },
    'gemini-3.6-flash': {
      name: 'Gemini 3.6 Flash',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Gemini 3.6 Flash — API-окно 1 048 576 (веб-окно по тарифу)',
      // Источник: https://ai.google.dev/gemini-api/docs/models (снят 2026-10-04)
      // Источник тарифов веба: https://support.google.com/gemini/answer/16275805 (снят 2026-10-04)
    },
    'gemini-3.5-flash': {
      name: 'Gemini 3.5 Flash',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Gemini 3.5 Flash — API-окно 1 048 576 (веб-окно по тарифу)',
      // Источник: https://ai.google.dev/gemini-api/docs/models (снят 2026-10-04)
      // Источник тарифов веба: https://support.google.com/gemini/answer/16275805 (снят 2026-10-04)
    },
    'gemini-3.5-flash-lite': {
      name: 'Gemini 3.5 Flash Lite',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Gemini 3.5 Flash Lite — API-окно 1 048 576 (веб-окно по тарифу)',
      // Источник: https://ai.google.dev/gemini-api/docs/models (снят 2026-10-04)
      // Источник тарифов веба: https://support.google.com/gemini/answer/16275805 (снят 2026-10-04)
    },
    'gemini-3-flash': {
      name: 'Gemini 3 Flash',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Gemini 3 Flash — API-окно 1 048 576 (веб-окно по тарифу)',
      // Источник: https://ai.google.dev/gemini-api/docs/models (снят 2026-10-04)
      // Источник тарифов веба: https://support.google.com/gemini/answer/16275805 (снят 2026-10-04)
    },
    // v1.26: дефолт GSA, когда slug из сети не определён. «1.5 Pro» не выдумываем.
    // 2026-10: дефолтная модель AI Mode — Gemini 3.5 Flash (официальный блог 2026-05-19),
    // поэтому 2 097 152 (остаток от 1.5 Pro) заменено на её реальное окно 1 048 576.
    // Порог бейджа НЕ меняется: min(1048576, EFFECTIVE_CAP_DEFAULT) = 128000, как и было.
    'gemini-search-default': {
      name: 'Gemini (Search AI)',
      provider: 'Google',
      contextLimit: 1048576,
      description: 'Google Search AI: slug из сети не определён → дефолтная модель AI Mode. Собственное окно AI Mode официально НЕ опубликовано, стоит окно Gemini 3.5 Flash как прокси',
      // Источник дефолтной модели: https://blog.google/products/search/ai-mode/ (снят 2026-10-04)
      // Источник окна: https://ai.google.dev/gemini-api/docs/models (снят 2026-10-04)
    },
    // ---- DeepSeek ----
    // Источник окон — таблица API https://api-docs.deepseek.com/quick_start/pricing
    // (колонка CONTEXT LENGTH). Актуальная V4-линейка: 1M токенов.
    // V3/R1: 128K — V3 подняли с 64K до 128K ещё в ветке V3
    // (https://api-docs.deepseek.com/zh-cn/news/news250325/), поэтому прежние 65536
    // были устаревшим полом, а не реальным окном.
    // Порог деградации при этом НЕ меняется: EFFECTIVE_CAP_DEFAULT = 128000, и
    // getEffectiveLimit() для V4 вернёт min(1000000, 128000) = 128000. contextLimit
    // двигает только формальное окно, бейдж по-прежнему считает от порога.
    'deepseek-v4-pro': {
      name: 'DeepSeek V4 Pro',
      provider: 'DeepSeek',
      contextLimit: 1000000,
      description: 'Флагман DeepSeek V4, окно 1M (API)'
    },
    'deepseek-flash': {
      name: 'DeepSeek Flash',
      provider: 'DeepSeek',
      contextLimit: 1000000,
      description: 'Быстрая модель DeepSeek V4, окно 1M (API)'
    },
    // v13 (2026-10-03): unified Intelligent Mode веб-версии DeepSeek. Имя модели в сети не
    // передаётся (model:"", model_type:"default", settings name:"Instant") — см.
    // core/deepseek-intercept.js resolveNetworkModelSlug(). Бейдж обязан считать от РЕАЛЬНОГО
    // окна 1M, поэтому ключ помечен capExempt: общий порог EFFECTIVE_CAP_DEFAULT = 128000
    // к нему не применяется (для остальных ключей поведение неизменно).
    'deepseek-v4.1-flash': {
      name: 'DeepSeek V4.1 Flash',
      provider: 'DeepSeek',
      contextLimit: 1000000,
      capExempt: true,
      description: 'DeepSeek V4.1 Flash (unified Intelligent Mode), окно 1M'
    },
    'deepseek-v3': {
      name: 'DeepSeek V3',
      provider: 'DeepSeek',
      contextLimit: 128000,
      description: 'DeepSeek V3, окно 128K (API)'
    },
    'deepseek-r1': {
      name: 'DeepSeek R1',
      provider: 'DeepSeek',
      contextLimit: 128000,
      description: 'DeepSeek R1, усиленный reasoning, окно 128K (API)'
    },
    // ---- Claude: окна веб-продукта по официальной таблице support.claude.com ----
    // Источники (оба сняты 2026-10-04):
    //   API-окна:  https://platform.claude.com/docs/en/models/overview
    //   Окна веб-продукта (таблица по тарифам): https://support.claude.com/en/articles/8606394
    // В вебе 1M у Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5.5 / Sonnet 5; 500K у
    // Fable 5 / Opus 4.8 / 4.7 / 4.6 / Sonnet 4.6; 200K у всего остального (в т.ч. Haiku 4.5).
    // capExempt — только там, где веб реально отдаёт 1M: в чате можно загрузить 500K+,
    // иначе (500K — меньше 500K+? нет: 500K = 500 000, но порог бейджа 128000) —
    // у 500K-моделей веб-окно заявлено, значит capExempt:true; у 200K — потолок EFFECTIVE_CAP_DEFAULT.
    // РЕШЕНИЕ: capExempt:true у всех моделей с веб-окном > 128000 — веб-версия не режет.
    'claude-sonnet-5-5': {
      name: 'Claude Sonnet 5.5',
      provider: 'Anthropic',
      contextLimit: 1000000,
      capExempt: true,
      description: 'Claude Sonnet 5.5 (claude-sonnet-5-5) — окно 1M в API и в веб-чате',
      // Источник: https://platform.claude.com/docs/en/models/overview (снят 2026-10-04)
      // Источник веб-окна: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
    },
    'claude-opus-5-5': {
      name: 'Claude Opus 5.5',
      provider: 'Anthropic',
      contextLimit: 1000000,
      capExempt: true,
      description: 'Claude Opus 5.5 (claude-opus-5-5) — окно 1M в API и в веб-чате',
      // Источник: https://platform.claude.com/docs/en/models/overview (снят 2026-10-04)
      // Источник веб-окна: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
    },
    'claude-fable-5-1': {
      name: 'Claude Fable 5.1',
      provider: 'Anthropic',
      contextLimit: 1000000,
      capExempt: true,
      description: 'Claude Fable 5.1 (claude-fable-5-1) — окно 1M в API и в веб-чате',
      // Источник: https://platform.claude.com/docs/en/models/overview (снят 2026-10-04)
      // Источник веб-окна: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
    },
    'claude-opus-5': {
      name: 'Claude Opus 5',
      provider: 'Anthropic',
      contextLimit: 1000000,
      capExempt: true,
      description: 'Claude Opus 5 (без минорной версии) — веб-окно 1M',
      // Источник: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
    },
    'claude-opus-4-8': {
      name: 'Claude Opus 4.8',
      provider: 'Anthropic',
      contextLimit: 500000,
      capExempt: true,
      description: 'Claude Opus 4.8 — веб-окно 500K',
      // Источник: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
    },
    'claude-opus-4-7': {
      name: 'Claude Opus 4.7',
      provider: 'Anthropic',
      contextLimit: 500000,
      capExempt: true,
      description: 'Claude Opus 4.7 — веб-окно 500K',
      // Источник: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
    },
    // ЖИВАЯ ПРИЁМКА 2026-10-04 (claude.ai): сеть отдаёт raw="claude-sonnet-5-5".
    // Без этого ключа resolveModelId даёт префиксное совпадение с 'claude-sonnet-5'.
    'claude-sonnet-5': {
      name: 'Claude Sonnet 5',
      provider: 'Anthropic',
      contextLimit: 1000000,
      capExempt: true,
      description: 'Claude Sonnet 5 (окно 1M в API и в веб-чате)',
      // Источник: https://platform.claude.com/docs/en/models/overview (снят 2026-10-04)
      // Источник веб-окна: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
    },
    'claude-sonnet-4-6': {
      name: 'Claude Sonnet 4.6',
      provider: 'Anthropic',
      contextLimit: 500000,
      capExempt: true,
      description: 'Claude Sonnet 4.6 — веб-окно 500K',
      // Источник: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
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
      contextLimit: 500000,
      capExempt: true,
      description: 'Claude Opus 4.6 — веб-окно 500K',
      // Источник: https://support.claude.com/en/articles/8606394 (снят 2026-10-04)
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
      description: 'Claude Haiku 4.5 — веб-окно и API-окно 200K',
      // Источник: https://platform.claude.com/docs/en/models/overview (снят 2026-10-04)
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
    // ЖИВАЯ ПРИЁМКА 2026-10-04 (perplexity.ai, аккаунт «Бесплатный план»): в меню моделей
    // НИ ОДНОЙ Sonar-модели нет, все 10 позиций — сторонние модели под paywall
    // «Получите доступ к лучшим моделям ИИ». Официального окна Perplexity для веба
    // найти НЕ удалось (help-center не публикует числа) → contextLimit оставлены прежними.
    'turbo': {
      name: 'Perplexity Sonar (turbo)',
      provider: 'Perplexity',
      contextLimit: 128000,
      description: 'Perplexity Sonar (turbo), окно 128K. УСТАРЕЛО: модели нет в веб-UI с 2026-09 (Sonar Chat Completions закрыт 2026-09-27); ключ оставлен для старых тредов и парсинга',
      // Источник: https://docs.perplexity.ai/getting-started/models (снят 2026-10-04)
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
    // ГИПОТЕЗА ЗАКРЫТА ЖИВОЙ ПРИЁМКОЙ 2026-10-04 (chat.qwen.ai, GET /api/models, первый источник):
    //   qwen3.7-plus 1000000 · qwen3.8-max 1000000 · qwen3.8-omni-flash 1000000 ·
    //   qwen3.7-max 1000000 · qwen3.6-plus 1000000 · qwen3.5-plus 1000000 ·
    //   qwen3.5-omni-plus 262144  (поле info.meta.max_context_length — это контракт САМОГО ВЕБА,
    //   не API; значит порог 128000 резал реальный лимит, capExempt обоснован).
    // Раньше стоял «128K — HYPOTHESIS» (тесты qwen-provider-wiring.test.js:152-163 закрепляли
    // именно гипотезу) — расхождение зафиксировано в PROJECT_HANDOFF.md, тесты не правились.
    'qwen3.8-max': {
      name: 'Qwen3.8-Max',
      provider: 'Qwen',
      contextLimit: 1000000,
      capExempt: true,
      description: 'Флагманская модель Qwen (chat.qwen.ai), веб-окно 1M — ПОДТВЕРЖДЕНО ЖИВЫМ /api/models 2026-10-04 (было: 128K HYPOTHESIS)',
      // Источник: https://chat.qwen.ai/api/models (снят 2026-10-04)
      // Источник API-стороны: https://help.aliyun.com/en/model-studio/qwen3-8-max (снят 2026-10-04)
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
    // 'ultra': ЖИВАЯ ПРИЁМКА 2026-10-04 (gemini.google.com, меню режимов) — в веб-UI
    // никакой «3.1 Ultra» НЕТ (только 3.5 Flash-Lite / 3.6 Flash / 3.1 Pro), запись была
    // выдумана прежней авто-генерацией. Запись оставлена как страховка: ветка (c) в
    // core/content.js вызывается только когда ни кэш меню, ни снимок сети не дали версии,
    // и на текущем UI не срабатывает. Окно 1 048 576 = API-окно Gemini 3.x.
    // Источник: https://ai.google.dev/gemini-api/docs/models (снят 2026-10-04)
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
  /**
   * Действующий порог деградации бейджа для модели.
   * Приоритет: `capExempt` (реальное окно без общего потолка) →
   * `min(contextLimit, EFFECTIVE_CAP_DEFAULT)`.
   * Ветка явного `model.effectiveLimit` удалена в v20: поле было публичным, но не
   * носило ни одного ключа модели, ни одного теста, ни одного конфига и не могло
   * прийти извне (см. аппендикс v20 — инвентаризация).
   * @param {string} modelId
   * @returns {number}
   */
  getEffectiveLimit(modelId) {
    const model = this.getModel(modelId);
    if (!model) return this.EFFECTIVE_CAP_DEFAULT;
    // v13: opt-out из общего потолка — только для ключей с реальным окном > EFFECTIVE_CAP_DEFAULT
    if (model.capExempt === true) return model.contextLimit;
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