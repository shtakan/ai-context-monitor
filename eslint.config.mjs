// ESLint v9 flat config (Step E.2b.2).
//
// Назначение: editor-time + CI-сигнал для класса дефектов «почти наверняка ошибка,
// но не ломает сборку». Это ДОПОЛНЕНИЕ к Jest-гейту E.2b.1
// (tests/catch-hygiene.test.js, 452 whitelist-записи), а не его дубль:
// gate ловит НОВЫЕ молчаливые catch в core//utils//adapters/ на каждом прогоне
// сьюта и падает; ESLint показывает те же и соседние классы прямо в редакторе,
// но ничего не блокирует (см. severity ниже).
//
// Жёсткие контракты этого шага:
//   1. ВСЕ правила — 'warn'. Ни одного 'error'. Поэтому `eslint .` завершается
//      кодом 0 при любом количестве замечаний, и CI-шаг остаётся non-blocking.
//   2. Запуск не пишет в рабочее дерево: в npm-скриптах нет `--fix`.
//   3. Никаких `.eslintrc*`/`.eslintignore` — только flat config (v9).

import globals from 'globals';
// esbuild уже devDep сборки; здесь он нужен, чтобы линт видел JS в .ts-файлах
// (см. блок для `**/*.ts` в конце конфига).
import * as esbuild from 'esbuild';

// Единый набор правил для всех линтуемых исходников.
//
// Почему `globals` (devDep) вместо рукописных списков: это ~30 КБ dev-only пакет
// с каноничными наборами browser/webextensions/serviceworker/jest/node, который
// обновляется вместе с платформой. Рукописный список из ~120 имён пришлось бы
// поддерживать вручную и он бы тихо устаревал (новые WebExtension API).
//
// Почему все правила в 'warn', а не в 'error': baseline легаси даёт сотни
// замечаний (см. отчёт шага), включение их как error превратило бы CI в красный
// и потребовало бы либо массовой правки кода вне scope, либо inline-глушения.
// Ужесточение — предмет последующих шагов (E.2b.3+), не этого.
const hygieneRules = {
  // --- Пустые конструкции -----------------------------------------------------
  // Дополняет gate E.2b.1: там молчаливый catch уже enforced в Jest-контуре,
  // здесь — мгновенная подсветка в редакторе + остальные пустые блоки
  // (if/for/while), которые gate не смотрит.
  'no-empty': 'warn',

  // --- Заведомо мёртвые/ошибочные условия -------------------------------------
  'no-constant-condition': 'warn',
  // `except-parens` (дефолт) осознанно оставлен: идиома
  // `while ((m = re.exec(s)) !== null)` в легаси легитимна, а голая
  // `if (x = y)` — нет. Это и есть формулировка «no-cond-assign, кроме while».
  'no-cond-assign': ['warn', 'except-parens'],

  // --- Дубликаты (почти всегда copy-paste-баг) --------------------------------
  'no-dupe-args': 'warn',
  'no-dupe-keys': 'warn',
  'no-dupe-else-if': 'warn',
  // `builtinGlobals: false` — осознанная суженная настройка. Дефолт (true) давал
  // 12 ложных срабатываний вида `var crypto = require('crypto')` в tools/*.js:
  // это штатное затенение node-глобала, а не дефект. Реальные переобъявления
  // внутри файла (`var i` дважды, `pasteQueue`) правило при этом ловит как прежде.
  'no-redeclare': ['warn', { builtinGlobals: false }],

  // --- Присваивание/перезапись там, где ожидалось чтение ----------------------
  'no-func-assign': 'warn',
  'no-self-assign': 'warn',

  // --- Структурный мусор ------------------------------------------------------
  'no-sparse-arrays': 'warn',
  'no-unreachable': 'warn',
  'no-fallthrough': 'warn',

  // --- Типовые ошибки сравнения ----------------------------------------------
  'no-unsafe-negation': 'warn',
  'use-isnan': 'warn',
  'valid-typeof': 'warn',
  'no-compare-neg-zero': 'warn',

  // ---------------------------------------------------------------------------
  // ЯВНО ВЫКЛЮЧЕНО — шум на легаси-архитектуре, ноль сигнала на этом шаге.
  // Каждое выключение — решение, а не забывчивость.
  // ---------------------------------------------------------------------------

  // Классические content-скрипты делят ОДИН лексический скоуп: core/state.js
  // объявляет `aiCm*`-состояние, а widget/base-handler/hybrid-tail/export-manager/
  // content читают соседей по имени (`var`/функция из другого файла). ESLint
  // анализирует каждый файл изолированно и не видит кросс-файловые объявления,
  // поэтому no-undef дал бы сотни ложных positive'ов на полностью рабочем коде.
  // Реальный риск «забытой переменной» на этих файлах ловится сьютом.
  'no-undef': 'off',

  // Легаси-остатки (неиспользуемые аргументы-плейсхолдеры, точки расширения,
  // совместимость сигнатур). ЗАМЕР: 1 043 срабатывания — не дефект.
  'no-unused-vars': 'off',

  // Гигиена прототипа — вне-scope класс для этого шага (обращения
  // `obj.hasOwnProperty(k)` в парсерах/адаптерах намеренно оставлены).
  // ЗАМЕР: 0 срабатываний сегодня, т.е. правило молчит — включение дало бы
  // нулевой сигнал при риске ложных срабатываний на легаси-объектах.
  'no-prototype-builtins': 'off',

  // Боль легаси-регулярок и строк-селекторов. ЗАМЕР: 20 срабатываний, из них
  // практически все — легитимные экранирования в регулярках/селекторах.
  'no-useless-escape': 'off',

  // Пустые ТЕЛА ФУНКЦИЙ — осознанный паттерн (опциональные хуки адаптеров,
  // no-op teardown, точки расширения). ЗАМЕР: 552 срабатывания.
  // Блочный случай (в т.ч. пустой catch) закрыт `no-empty`.
  'no-empty-function': 'off',
};

export default [
  // ---------------------------------------------------------------------------
  // 1. Игноры. Список из задания шага + `**/*.min.js` (в репозитории таких
  //    файлов вне dist/ сейчас нет, но суффикс — маркер машинной генерации).
  //    `tools/_*` и `tools/_*/**` покрывают рабочие каталоги серии E.2a
  //    (_e2a2b1-backup, _e2a2b4cd-backup, _baseline, …) — они не источники.
  //    `dist-firefox/**` — артефакт `node build.mjs` (MINIFY=false, code-split
  //    прогон). В нём esbuild переписывает глобалы через `with`, и eslint в
  //    strict-режиме падал с 13 `Parsing error: 'with' in strict mode` на
  //    локальной машине, где dist-firefox уже собран (Lint #266).
  //    `.build/**` — промежуточные entry-файлы build.mjs (шаг 0): с миграцией
  //    adapters/ на TypeScript они конкатенируют `.ts` и содержат `interface`,
  //    то есть это уже не валидный JS-текст, а вход esbuild (в .gitignore).
  // ---------------------------------------------------------------------------
  {
    ignores: [
      'dist/**',
      'dist-firefox/**',
      '.build/**',
      'node_modules/**',
      'coverage/**',
      'tools/_*',
      'tools/_*/**',
      '*.min.js',
      '**/*.min.js',
    ],
  },

  // ---------------------------------------------------------------------------
  // 2. Исходники расширения: core/ (включая core/pagination/), utils/,
  //    adapters/, options/, print/. Классические content-скрипты и страницы
  //    расширения → browser + webextensions; `sourceType: 'script'` фиксирует,
  //    что это не ESM (в этих каталогах нет import/export).
  // ---------------------------------------------------------------------------
  {
    files: [
      'core/**/*.js',
      'core/**/*.ts',
      'utils/**/*.js',
      'adapters/**/*.ts',
      'options/**/*.js',
      'print/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: hygieneRules,
  },

  // ---------------------------------------------------------------------------
  // 3. MV3 service worker — ОТДЕЛЬНЫЙ контекст: нет DOM, есть self/importScripts,
  //    chrome.* как в webextensions, плюс serviceworker-глобали.
  // ---------------------------------------------------------------------------
  {
    files: ['core/background.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.serviceworker,
        ...globals.webextensions,
      },
    },
    rules: hygieneRules,
  },

  // ---------------------------------------------------------------------------
  // 4. Jest-тесты: describe/it/expect/beforeEach/jest/… + node (require, process,
  //    __dirname, fs — тесты пишут во временные деревья и требуют модули).
  // ---------------------------------------------------------------------------
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
    rules: hygieneRules,
  },

  // ---------------------------------------------------------------------------
  // 5. Инструменты и сборка вне tests/: tools/*.js (трекнутые скрипты серии
  //    bind-contract) и build.mjs (esbuild-обёртка, ESM).
  // ---------------------------------------------------------------------------
  {
    files: ['tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.node },
    },
    rules: hygieneRules,
  },
  {
    files: ['build.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: hygieneRules,
  },

  // ---------------------------------------------------------------------------
  // 6. ESM-пилот (commit 0ca3434, Roadmap Ph2). `utils/markdown.ts` и
  //    `print/print.js` переведены на import/export, но секции 2 описывают
  //    utils/**/*.js и print/**/*.js как `sourceType: 'script'` — без этого
  //    override парсер падал: «'import' and 'export' may appear only with
  //    'sourceType: module'» (Lint #353). `print/print.js` включён в тот же
  //    override, потому что CI-шаг — `npm run lint` (= `eslint .`), и один
  //    оставленный ESM-файл держал бы job «Lint» красным.
  //    Блок идёт ПОСЛЕ секций 2/5 намеренно: в flat config побеждает
  //    последний матч, поэтому sourceType переопределяется, а
  //    browser/webextensions-глобали из секции 2 продолжают действовать
  //    (languageOptions.globals мержатся, только sourceType заменяется).
  //    Список точечный: по мере расширения пилота сюда добавляются файлы.
  //    Ph2, шаг 3: utils/platform.ts переведён на export, его потребители —
  //    core/background.js, core/content.js, options/options.js — на статический
  //    import, поэтому все четыре файла здесь.
  //    Ph2, шаг 4: utils/intercept-common.ts переведён на export, а четыре
  //    MAIN-перехватчика импортируют setIntervalVisible статически; их сборка —
  //    отдельные IIFE-бандлы (build.mjs, mainInterceptOptions).
  //    Ph2, шаг stream-frames: utils/stream-frames.ts — ESM (frames/normalizeUsage/
  //    mergeUsage + эталонные framesManual/splitJsonObjects), его единственный
  //    потребитель core/qwen-intercept.js тоже переведён на статический import и
  //    собирается отдельным IIFE-бандлом.
  //    Ph2, шаг debug.js: utils/debug.js — настоящий ESM (R1 закрыт), поэтому его
  //    импортируют core/background.js, core/content.js и utils/intercept-common.ts.
  //    Для 8 MAIN-регистраций сборка выводит classic-артефакт dist/utils/debug.js.
  // ---------------------------------------------------------------------------
  {
    files: [
      'utils/markdown.ts',
      'utils/buildReferenceText.ts',
      'utils/export-text-builders.ts',
      'utils/platform.ts',
      'utils/intercept-common.ts',
      'utils/stream-frames.ts',
      // R1 (Ph2): utils/debug.js переведён на ESM — его импортируют
      // core/background.js, core/content.js и utils/intercept-common.ts.
      'utils/debug.ts',
      // Ph2, шаг tokenizer.js: модуль переведён на ESM (UMD-хвост снят) и
      // втягивается import'ом из core/content.js.
      'utils/tokenizer.ts',
      // Ph2, шаг model-config.ts: модуль переведён на ESM (UMD-хвост снят) и
      // втягивается import'ом из core/content.js.
      'utils/model-config.ts',
      // Ph2, шаг archive-import.ts: модуль переведён на ESM (UMD-хвост снят) и
      // втягивается import'ом из options/options.js.
      'utils/archive-import.ts',
      // Ph2, шаг perplexity-parser.ts: модуль переведён на ESM (UMD-хвост снят) и
      // втягивается import'ами из core/perplexity-intercept.js и options/options.js.
      'utils/perplexity-parser.ts',
      // Ph2, шаг chatgpt-conversation-parser.ts: модуль переведён на ESM (UMD-хвост
      // снят) и втягивается import'ами из core/page-intercept.js и options/options.js.
      'utils/chatgpt-conversation-parser.ts',
      // Ph2, шаг gemini-batchexecute-parser.js: модуль переведён на ESM (UMD-хвост
      // снят) и втягивается side-effect import'ом из core/content.js; для MAIN-мира
      // build.mjs выводит classic-артефакт dist/utils/gemini-batchexecute-parser.js.
      'utils/gemini-batchexecute-parser.ts',
      // Ph2, шаг gemini-dom-parser.ts: модуль переведён на ESM (UMD-хвост снят) и
      // втягивается import'ом из core/hybrid-tail.ts.
      'utils/gemini-dom-parser.ts',
      // Ph2, шаг gemini-intercept-logic.js: модуль переведён на ESM (UMD-хвост снят) и
      // втягивается статическим import'ом из core/background.js; для MAIN-регистрации
      // v12 build.mjs выводит classic-артефакт dist/utils/gemini-intercept-logic.js.
      'utils/gemini-intercept-logic.ts',
      // Ph2, шаг google-search-folwr-parser.js: модуль переведён на ESM (UMD-хвост
      // снят) и втягивается side-effect import'ом из core/content.js; для MAIN-мира
      // build.mjs выводит classic-артефакт dist/utils/google-search-folwr-parser.js.
      'utils/google-search-folwr-parser.ts',
      // Ph2, шаг export-emit-pipeline.js: модуль переведён на ESM (UMD-хвост снят)
      // и втягивается в content-бандл статическим import'ом из core/content.js;
      // MAIN-регистрации у него нет, classic-артефакт не выводится.
      'utils/export-emit-pipeline.ts',
      // Потребитель core/hybrid-tail.ts получает top-level import, поэтому тоже
      // разбирается как module. Файл остаётся частью конкатенации content-бандла.
      'core/hybrid-tail.ts',
      'print/print.js',
      'core/background.js',
      'core/content.ts',
      'core/page-intercept.js',
      'core/claude-intercept.js',
      'core/perplexity-intercept.js',
      'core/google-search-intercept.js',
      'core/qwen-intercept.js',
      'options/options.js',
    ],
    languageOptions: {
      sourceType: 'module',
    },
  },
  // ---------------------------------------------------------------------------
  // Шаг 1 TS-миграции: `.ts`/`.tsx`-исходники.
  //
  // Отдельного TS-парсера в зависимостях нет (`@typescript-eslint/parser` не
  // ставился): AST для правил даёт предпроцессор на esbuild — тот же инструмент,
  // что собирает бандлы, поэтому новый слой не появляется. Предпроцессор стирает
  // типы, и дальше файл разбирается обычным espree.
  //
  // Сдвиг колонок после стирания типов безопасен: `--fix` в проекте не
  // используется (контракт №2 выше), а сообщения и так non-blocking.
  //
  // Глобалы — объединение browser/webextensions/node: декларации в `types/`
  // описывают и контент-скрипт, и service worker.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.ts', '**/*.tsx'],
    processor: {
      preprocess(text, filename) {
        const { code } = esbuild.transformSync(text, {
          loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
          format: 'esm',
          target: 'es2020',
          sourcefile: filename,
        });
        return [code];
      },
      postprocess(messageLists) {
        return messageLists.flat();
      },
    },
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.node,
      },
    },
    rules: {},
  },
];
