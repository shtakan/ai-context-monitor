# Changelog

## [2.0.10] - 2026-09-19
### Fixed
- O-14 (попап не держит старый снимок после сброса чата, RESET): `resetConversationState` удаляет `aiCmState` и `aiCmState` с ключом хоста из `chrome.storage.local`, `storage.onChanged` попапа обрабатывает удаление ключей per-host и показывает «Нет данных» до нового снимка.
- O-22 (DeepSeek): payload-точный гард повторного диспатча `ai-cm-full-history` в `emitBaseSnapshot` — тройной диспатч идентичного снимка больше не даёт тройной эмит и обновление бейджа, запись в storage остаётся одиночной.

## [2.0.9] - 2026-09-18
### Fixed
- O-7 (зачистка экспорта DeepSeek, OFF-путь, спецификация S1–S5): дефолтный OFF-экспорт DeepSeek теперь содержит только вопросы и ответы — санация инъекций O-20 (`deepseek-pp-visible-user-prompt`) остаётся (S1); секции `[REASONING]…[ANSWER]…` обрезаются до части после `[ANSWER]` (S2); user-ходы, целиком состоящие из `[TOOL_RESULTS]…[/TOOL_RESULTS]` с необязательным хвостом «Continue answering based on the tool results above.», удаляются (S3); в текстах ассистента вырезаются XML-блоки тул-коллов DeepSeek++ (18 browser-call-тегов + memory/web/shell/python/skill) (S4); сообщения, опустевшие после S3/S4, отсеваются (S5). ON-путь байтово прежний; база/метрики/бейдж от тумблера не зависят. 12 пинов O-7 S3/S4/S5 + регресс-контур O-11/O-31/O-27/O-33/O-15…O-20; live-приёмка 2026-09-18 09:37–09:54: txt-файлы OFF — 0 совпадений findstr по 5 маркерам, ON — совпадения есть; md-шапки OFF=ON по tokens/limit/percent (61414/128000 (48%); 149224/128000 (116.6%)).
### Changed
- Тумблер «Включать reasoning-цепочки и инъекции DeepSeek++ в экспорт» (default OFF): OFF-путь относительно v2.0.8 изменил поведение — дефолтный экспорт DeepSeek больше не содержит секций размышлений и инъекций (только вопросы и ответы), тогда как в v2.0.8 секции были в обоих путях. База, метрики и бейдж от тумблера не зависят (защита только на выходе экспорта).
- Версия 2.0.9 во всех точках вывода: `manifest.json`, `package.json`, `package-lock.json`, футер `docs/index.html`, метаданные листинга Edge; версионные пины тестов переведены 2.0.8 → 2.0.9 (логика тестов не изменялась, кроме R-1: литерал перенесён на 2.0.9, добавлены проверки 2.0.9 > 2.0.8 > 2.0.7 и «2.0.8 не осталось в манифесте/пакете/локе»). `package-lock.json` gitignored (конвенция уточнена в PROJECT_HANDOFF.md 2026-09-18).

## [2.0.8] - 2026-09-17
### Fixed
- O-33 (блок автоэкспорта по DOM-базе до сетевого снимка): экспорт не стартует, пока база ещё не пришла из сети — при DOM-оценке выше порога фиксируется `reason base-pending` (после пороговой проверки, а не вместо неё); лог пишется только на смене состояния. Live-приёмка 15:33–15:42; 24 пина R-D (`tests/o33-autoexport-base-pending.test.js`).

## [2.0.7] - 2026-09-17
### Fixed
- O-1 (щит бейджа ChatGPT): щит взводится на старте документа независимо от `convId` — индикатор не показывает занижённую DOM-оценку при перезагрузке; отпускание по первой записи базы (`baseSeen`) или фолбэк 10 c; до первого значения отображается плейсхолдер «—». Live-приёмка 10:21–10:22; 16 пинов R-D (`tests/chatgpt-o1-badge-hold.test.js`).
### Changed
- Версия 2.0.7 во всех точках вывода: `manifest.json`, `package.json`, `package-lock.json`, футер `docs/index.html`, метаданные листинга Edge; версионные пины тестов переведены 2.0.6 → 2.0.7 (логика тестов не изменялась).

## [2.0.6] - 2026-09-16
### Fixed
- O-27 (защитный гард от мусорного экспорта GSA): сужение валидатора базы до формы XSSI-мусора (`)]}'` + 0 непустых ходов) + пост-гард в точке скачивания (блокировка при пустом имени или XSSI-префиксе в первых байтах). Live-приёмка: здоровый чат экспортируется байтово как прежде; юнит-пины по правилу R-D на каждом пути записи базы.
### Note
- O-32 (индикатор 0.8%) переведён в низкий приоритет (механизм не воспроизведён в 5+ прогонах); правило R-D добавлено в конвенции проекта.

## [2.0.5] - 2026-09-16
### Fixed
- O-11 (гард коллизии имён автоэкспорта): два файра в одну минуту дают разные имена с суффиксом `-2`, а не chrome-овское ` (1)`; унификация маски имён через единую функцию `buildAutoExportFileName` + синхронный реестр имён до старта скачивания.
- O-31 (сегментация сетевой базы Google Search AI по разговору): смена треда сбрасывает накопитель, экспорт и процент считаются только по ходам текущего разговора; live-приёмка: файлы 15:58 чистые per-conversation, pct стабилен 1.4%/3.5%.
### Note
- O-30 объяснён путём записи базы (network vs adapter/dom), O-28 закрыт как поведение по дизайну (гейт `baseComplete`, оценка event-driven).

## [2.0.4] - 2026-09-16
### Fixed
- O-9-подпись: `snapshot-at-manual` на Perplexity печатает реальные ходы и тексты из канонической базы (`buildHistoryMessages`); приоритет MAIN-моста (Gemini/DeepSeek O-17) и семантика дефолтов не тронуты.

## [2.0.3] - 2026-09-15
### Fixed
- O-20: санация маркеров сторонних расширений в экспорте DeepSeek — user-текст обрезается до видимого между парой маркеров `deepseek-pp-visible-user-prompt`; tokens/percent не пересчитываются (f71f7d1).
### Added
- O-26: диагностика походового usage DeepSeek и счётчиков netMsgs/domMsgs в svc-emit-trace под гейтом `aiCmDebug` — измерение без изменения поведения (1e0bb14).
### Docs
- Актуализация `PROJECT_HANDOFF.md`: вердикты O-19/O-20/O-26, продуктовые решения (инъекции соседа и его тул-коллы остаются в серверной истории), отклонение O-25, очередь low.

## [2.0.2] - 2026-09-14
### Fixed
- O-15: DeepSeek-экспорт — парность ходов и целостность фрагментов reasoning/answer (c77fb90).
- O-16: усечение ответа при автоэкспорте во время активного стрима — debounce + flush (a094920).
- O-17: полнота базы и turnsMap в SPA-созданном чате, экспорт без F5 (07f45ce).
- O-18: ресинхронизация SSE-парсера фрагментов (белый список типов + resync из сырого кольца)
  и сетевой дозапрос истории в момент экспорта (072ae6a).

## [2.0.1] - 2026-09-14

### Fixed
- O-1 (ChatGPT, бейдж после F5): индикатор больше не мигает при перезагрузке страницы —
  контейнер виджета снят с отрисовки, пока не пришёл первый валидный расчёт. Показ выполняет
  `updateWidget` (значение уже разложено по circle/text/tooltip) либо таймаут-страховка, если
  сеть молчит: пользователь не видит ни placeholder «0.0%» из разметки, ни заниженную
  DOM-оценку. Новые точки: `aiCmRevealWidget()` в `core/widget.js`, гейт `aiCmBadgeHoldActive()`
  в `core/content.js`.

### Changed
- Ручная установка без магазина: в `README.md`, `docs/index.html` и локалях (`_locales/ru`,
  `_locales/en`) добавлена секция со ссылкой на GitHub Releases.
- Версия 2.0.1 во всех точках вывода: `manifest.json`, `package.json`, `package-lock.json`,
  футер `docs/index.html`, метаданные листинга Edge; восемь версионных сьютов перепинованы
  2.0.0 → 2.0.1 (skip-логика CI-хотфикса не тронута).

## [2.0.0] - 2026-09-14
### Changed
- v2.0, этап 1/3 (commit `370a217`): декомпозиция `core/content.js` (3622 → 1897 строк) на пять
  модулей — `core/state.js`, `core/widget.js`, `core/base-handler.js`, `core/hybrid-tail.js`,
  `core/export-manager.js`; 153 элемента перенесены байтово. Логика, сигнатуры и порядок вызовов
  не изменены, тесты обновлены только в строках резолва источника (23 файла).
- v2.0, этап 2/3 — частичная декомпозиция (commit `994ae26`): `core/gemini-intercept.js`
  5064 → 4800 строк, вынесен `core/gemini-hidden-scroll.js` (356 строк: 13 функций + 10 констант,
  своя IIFE и UMD-экспорт `window.AiCmGeminiHiddenScroll`; живое состояние ядра — через `__bind`
  с геттерами/сеттерами, не копии). Кластеры network/parser/pagination/loader неотделимы по AST
  (замыкание 84–95%, 218 общих имён из 259) — оставлены до этапа 3/3.
- v2.0, этап 3/3 (commit `be1a4a6`): миграция id регистрации перехватчика Gemini —
  `ai-cm-gemini-intercept` → `ai-cm-gemini-intercept-v2` + `unregisterContentScripts` старого id
  в `core/background.js` (`world:'MAIN'`, `runAt:'document_start'` сохранены). Там же зафиксировано
  отложение ES modules для content scripts до введения бандлера: `"type":"module"` Chrome
  игнорирует («Cannot use import statement outside a module»), а `registerContentScripts`
  отвергает поле `type` и в `ISOLATED`, и в `MAIN` (пробы Chrome 153.0.8010.36 / Edge 153.0.4234.32).
  Решение — `ARCHITECTURE_STANDARDS.md`, раздел «ES modules в content scripts».
- CI-хотфикс (commit `322fd7e`): зелёный Lint на чистом чекауте — `.gitattributes` (`eol=lf`) и
  условный skip версионных сьютов, зависящих от gitignored `tools/edge-listing-metadata.txt`;
  ассерты не ослаблены, пропуск печатается явно.
- Версия 2.0.0 во всех точках вывода: `manifest.json`, `package.json`, `package-lock.json`,
  футер `docs/index.html`, метаданные листинга Edge; восемь версионных сьютов перепинованы
  1.19.3 → 2.0.0 (skip-логика CI-хотфикса не тронута).

### Fixed
- Убран ключ-комментарий `//ESM` из `manifest.json`: Chrome функционально игнорирует неизвестные
  ключи, но выводит manifest-warning «Unrecognized manifest key '//ESM'» на плитке расширения —
  для публикации в Edge Add-ons манифест должен быть чистым. Решение по ES modules уже
  зафиксировано в `ARCHITECTURE_STANDARDS.md` («ES modules в content scripts — отложено
  до бандлера»). `tests/manifest-smoke.test.js`: `//ESM` удалён из allow-листа — строгость
  проверки возвращена (верхний уровень манифеста снова содержит только Chromium-MV3 ключи).

## [1.19.3] - 2026-09-13
### Fixed
- M-14 (Perplexity, SPA домашняя→тред без F5): bootstrap больше не учит голый `/rest/thread/{slug}` —
  адрес истории строится с полным набором query-параметров (`with_parent_info`,
  `supported_block_use_cases`), как у сниффинг-URL страницы.
  Дефект: после SPA-перехода домашняя→тред bootstrap отдавал урезанный снимок (textLen 5764, 1.4%),
  тогда как собственный запрос страницы с полным набором параметров даёт textLen 11164, 2.6%.
  Причина: гейт M-12 отбрасывает чужие снимки ДО выучивания шаблона, полный адрес с домашней
  больше не приезжает, а SPA-клик переиспользует кэш — нового сниффинга нет до F5.
  Фикс: в обеих ветках отклонения гейта M-12 («нет slug страницы» и «чужой снимок») у отклонённого
  снимка выучивается только АДРЕС (`historyUrlTemplate`, id-сегмент → `{slug}`), и лишь если URL
  несёт параметры полного набора; данные отклонённого снимка по-прежнему не эмитятся, состояние
  (`snapshotReceived`/`lastHistoryUrl`) не трогается, уже выученный шаблон не перетирается.
  REST-fallback bootstrap использует ту же константу полного набора. Гейт-логика M-12,
  settings-путь M-13, латчи/backoff и прочие адаптеры не тронуты. `core/perplexity-intercept.js`;
  пин `tests/perplexity-spa-bootstrap-m14.test.js` (SPA home→thread: base/textLen === сниффинг-эталон,
  textLen полного набора ≠ textLen голого REST, чужой снимок не эмитится).

## [1.19.2] - 2026-09-13
### Fixed
- M-12 (Perplexity, пассивный сниффинг): снимок истории эмитится в бейдж/историю ТОЛЬКО когда
  его slug доказуемо совпал со slug страницы (`/search/<id>` или `/thread/<id>`).
  Дефект 13.09 17:24: гейт «нет slug — не тред» стоял только на bootstrap, поэтому на домашней
  странице perplexity.ai (URL без slug) сниффинг ловил снимки ЧУЖИХ тредов (e2ffa178, 193399cd,
  bf464421…) и каждый перерисовывал бейдж (2.7→0.8→0.4→…), а также уходил в запись истории.
  Теперь на странице без slug сниффинга-эмита нет вовсе (виджет держит «—»); пропущенный чужой
  снимок не трогает и состояние (`snapshotReceived`/`lastHistoryUrl`/шаблон) — виртуальный F5
  не уводится на чужой адрес. `core/perplexity-intercept.js`; bootstrap и виртуальный F5 не тронуты.
- M-13 (настройки автоэкспорта): попап пишет настройки ТОЛЬКО полным объектом
  `{enabled, pct, fmt}` из текущих значений формы — частичная запись исключена.
  Дефект 13.09 17:33 (тред `/search/5fe65fcb`, галка включена, порог 20, baseComplete=true,
  convId непустой): сохранение порога из попапа (~17:12) теряло флаг `enabled` в storage, и
  `maybeAutoExport()` молча выходил на `if (!s || s.enabled !== true) return;` — ни одной строки
  модуля автоэкспорта. Инициализация формы — строго из `chrome.storage` (при отсутствии/битом
  значении нормализованное значение сразу фиксируется полным объектом, форма и хранилище не
  расходятся). `options/options.js`.
- M-13 (content.js): `loadAutoExportSettings()` нормализует флаг — нет БУЛЕВА `enabled` в
  загруженном объекте → `enabled=false` И обязательная строка
  `[AI CM][auto-export] настройки: флаг enabled отсутствует — автоэкспорт выключен`
  (тихий путь закрыт, антиспам — одна строка на эпизод).

## [1.19.1] - 2026-09-13
### Fixed
- M-11 (автоэкспорт Perplexity): `utils/export-emit-pipeline.js` — `extractConvIdFromUrl()`
  распознаёт живой URL диалога `perplexity.ai/search/<id>` наравне с `/thread/<id>`.
  Прежде ветки `/search/` не было: `aiCmAutoExportConvId()` возвращал '', и `maybeAutoExport()`
  (core/content.js) молча выходил на `if (!cid) return;` при зелёных гейтах — автоэкспорт
  на Perplexity не стрелял вовсе (контрольный прогон 13.09 16:31: порог 2%, факт 2.6%,
  baseComplete=true, fired=false, ни строки модуля автоэкспорта, файла нет).
  Путь `/search` без id-сегмента (`google.com/search` → GSA) по-прежнему не матчится:
  у GSA идентификатор даёт threadId снапшота. Гейты, латчи, GSA- и gemini-пути не тронуты.
### Changed
- Подпись секции автоэкспорта: «Автоэкспорт чатов (все поддерживаемые платформы)» /
  «Chat auto-export (all supported platforms)» (ru/en и фолбэк разметки настроек).

## [1.19.0] - 2026-09-13
### Added
- Полная локализация ru/en: страница настроек (включая футер, подсказки, статусы ключа, метку кэша),
  попап, печать, футер руководства, карточка расширения, политика конфиденциальности и docs.
- Дедупликация Deep Research в Gemini (intra/cross/coreText) и честный бейдж по схлопнутой базе.
- Потолок чтения архива 50 МБ: понятное сообщение вместо молчаливого отказа.
- Passive scroll при прокрутке списка архивов; метаданные листинга Edge Add-ons в tools/.
### Changed
- BYOK-ключ Google AI Studio — только в session-памяти; прежний plaintext переносится и удаляется.
- История: TTL storage 30 дней (автоочистка при старте/обновлении).
- Гигиена подсчёта токенов: таймаут 10 с, debounce 800 мс, кэш 200 FIFO, лог cache-hit.
- Футер настроек берёт версию из `chrome.runtime.getManifest()`; руководство входит в пакет.
### Fixed
- Бейдж и полнота больше не считают задвоенные ходы Deep Research (ложное «complete» на дубль-базе).
- a11y/WCAG: доступные имена и группы, live-region, focus-visible, контраст пар ≥ 4.5:1.
### Verified
- Пины версии: `manifest.version` === верхняя запись CHANGELOG; jsdom — футер настроек рендерит
  версию из манифеста; обновлены версии руководства и метаданных листинга.

## [1.18.0] - 2026-09-12
### Added
- GSA (Google Search AI): автоэкспорт по порогу (convId=threadId, latch site+convId, форматы txt/md/json).
- GSA: модель снапшота в имени файла автоэкспорта (например, `ai-context-monitor-google_search-Gemini-Search-AI-<дата>.txt`).
- Privacy Policy: страница `privacy/privacy.html` (9 разделов, ред. 2), ссылка в футере настроек, `homepage_url` в манифесте.

## [1.17.0] - 2026-09-12
### Fixed
- GSA: диагностика пагинации folwr + классификатор страницы продолжения (`classifyFolwrContinuation`: kind=cursor-repeat|no-new-turns при ok=200 → complete=true). Устранён цикл перезагрузок при `data-mstk` (сессионный токен, не курсор пагинации).

## [1.16.0] - 2026-09-12
### Added
- Импорт архивов истории (Gemini Takeout, ChatGPT Export, Perplexity, Claude) как первый ярус.
- Механизм self-heal пола (auto-lower при доказанном чистом конце истории).
- Гейт archive-pending-live (блокировка экспорта, пока база = только архив).
- Правильный порядок: архив = голова (старшая история), live = хвост.
- Объединённый экспорт (архив + live) без префикса `[LOW CONFIDENCE]` при полной базе.
### Fixed
- Циклические перезагрузки страницы при завышенном поле (floor > msgs).
- Преждевременный автоэкспорт на архивных сообщениях (4 вместо 110).
- Потеря live-истории при экспорте (брался только архив).

## [1.15.3] - 2026-09-09
### Fixed
- Gemini (H12 A5b): scroll-top-proof удалён — циркулярный оракул полноты; complete только из
  серверно-авторитетных точек (utils/gemini-intercept-logic.js, core/gemini-intercept.js).
- Gemini (H13 inner-cursor): курсор глубоких окон ищется в inner (turns[1]); потолок
  classifyOpaque 600→2000, зоны wide — inner затем rest, приоритет длиннейшему (utils/
  gemini-intercept-logic.js, core/gemini-intercept.js).
- Gemini (H14/H15 hex-marker): короткие hex-маркеры ([0-9a-fA-F] <40) НЕ opaque — ложный
  cursorFound устранён (utils/gemini-intercept-logic.js).
- Gemini (H16/H17 mime-garbage): MIME-префиксы и b64-мусор 8..15 НЕ opaque, нижняя граница
  wide 8→16 (utils/gemini-intercept-logic.js).
- Popup (H19): оверрайды selectedModel/customLimit попапа теперь читаются и применяются к
  лимиту и токенизации (core/content.js, options/options.js).
- Options (H20): поле «Лимит контекста» пишется по дебаунсу ~500мс, а не на каждый keystroke
  (options/options.js).
- Autexport (H21): инвариант порядка логов — «fired» ДО (цитата первой строки санитизирована — см. локальный леджер)
  (core/content.js).
- Theme (H22): виджет/оверлей следуют in-app тёмной теме Gemini (core/content.js,
  core/gemini-intercept.js).
- Claude (H23): ретейн последнего emit-детейла + ре-эмит по handshake — потеря снимка из-за
  гонки (цитата первой строки санитизирована — см. локальный леджер) устранена (core/claude-intercept.js, core/content.js).
- Theme (H24): адаптация палитры на in-app тёмные темы ВСЕХ сервисов (проб [body,
  documentElement]; правило паритета H22 сохранено) (core/content.js).
- Theme (H25): живой перекрас виджета при смене темы без reload — страховочный опрос
  isDarkMode()≠применённая палитра (core/content.js).
### Verified
- Полный jest: 47 suites / 722 tests green. Детали, live-цитаты и осознанные остатки —
  RELEASE_CHECKLIST, секция (цитата первой строки санитизирована — см. локальный леджер).

## [1.15.2] - 2026-09-05
### Fixed
- Gemini (H10 PROBE-TERMINAL GATE): контрольный probe полноты (v73) объявлял complete строго по
  ответу — `newOlder=0` + широкий курсор не найден — но в классе e292 (floor=108, база усеклась
  до 80) probe попадал на ОКНО-ДУБЛЬ хвоста: сервер отдаёт уже имеющееся в базе окно 1..80,
  контент глубины 81..108 живёт вне hNvQHb-канала, а курсор продолжения лежит В turns (не в rest),
  поэтому `extractCursorWide` (сканирует только rest) давал `cursorFound=no` → ложный
  `oracle=complete reason=probe-terminal` на усечённой базе 80 (fired при floor=108). Теперь пол
  (HWM из localStorage) авторитетнее ответа probe: чистый предикат
  `GeminiInterceptLogic.probeTerminalGate({floorCount,baseCount,pbError})` вызывается ПЕРЕД
  взводом `historyFullByQuiet`/`reachedStart` в терминальной ветке; `base < floor` →
  block (`reason=below-floor-probe-terminal`) → `probeIncomplete(reason)` → loader-restart
  (утренний путь докрутки: нативный скрытый скролл добирает глубину как src=passive →
  `oracle=complete reason=loader-stable-stop msgs=108 floor=108` → fired по полной базе).
- Gemini (H10 PB-ERROR): pb-ответ-ошибка (error-страница Bard, `lastHnvPageError=true`, битый
  парс-путь) тоже блокирует probe-terminal (`reason=pb-error-page`) — complete по не-данным
  запрещён. e292 это НЕ лечит (там данные-дубль), гейт закрывает сломанный парс отдельно.
### Added
- Чистая функция `GeminiInterceptLogic.probeTerminalGate` + интеграция в core (терминальная ветка
  probe-terminal, ~3189) с логом `[AI CM][completeness] probe-terminal blocked reason=…` и
  inline-дублём правила на случай недоступного логика-скрипта.
- Тесты: 8 unit-тестов H10 (gemini-intercept-logic.test.js) + 4 пина-теста core (гейт до взвода
  complete, литералы reason, pbError=lastHnvPageError, block → probeIncomplete).
### Verified
- Полный jest: 38 suites / 542 tests green (530 базовых без регрессий + 12 новых H10; байтово-зелёные
  gemini-fallback-probe / gemini-untrusted-top / gemini-err1177-bypass).
- Живой прогон (Chrome 152, unpacked из MAIN, порт 9222, ext=1.15.2): conv-A холодный F5 без
  тейпа — `probe-terminal blocked reason=below-floor-probe-terminal msgs=80 floor=108 pbError=0` →
  `oracle=incomplete reason=below-floor-probe-terminal` → `loader-restart reason=incomplete-oracle`
  → fired по фактической базе (пол самоизлечен clean-end-путём после ужатия чата на сервере);
  с тейпом — fired msgs=108, файл e292 начинается (цитата первой строки санитизирована — см. локальный леджер); conv-B первый визит (floor=0) — probe-terminal НЕ блокирован, fired msgs=80,
  файл начинается (цитата первой строки санитизирована — см. локальный леджер); повторный вход
  (floor=80=base) — гейт пропускает, fired msgs=80 без регресса. Детали и цитаты — RELEASE_CHECKLIST,
  секция H10.

## [1.15.1] - 2026-09-05
### Fixed
- Gemini (H9b RETAIN): wide-курсор контрольного probe читался из единственного волатильного
  слота `lastPaginateOuter` (перезаписывается каждым успешным парсом hNvQHb), и ОБОРВАННЫЙ
  финальный шаг тихой пагинации (битая/терминальная страница без opaque-строк) затирал его
  ровно тогда, когда нужен probe → `probeIncomplete('no-wide-cursor')` (oracle (b)) /
  fallback-top `probe-unavailable` → полнота первого визита зависала в консервативной
  неполноте. Теперь last-good (широкий курсор + метаданные запроса) фиксируется на ЗДОРОВОМ
  шаге пагинации (added>0 ИЛИ живой курсор, шаг не сломан, src='pag'; монотонное правило
  `updateProbeMetaRetain` по образцу saveFloor: сломанный шаг НЕ перезаписывает) и подаётся
  ВХОДОМ запроса probe в обеих точках (oracle (b): `extractCursorWide(lastPaginateOuter) ||
  lastGoodWideCur`; fallback-top fbWideCur/fbMeta аналогично, same-convId гард). Источником
  complete retained НЕ является: complete по-прежнему только серверный probe-terminal
  (0 новых старших ходов + курсора нет); сбросы — resetForNewConversation, disjoint-reset,
  после probe-terminal; probe-парс состояние пагинации не мутирует.
- Убран риск повторного «застревания»: retained не перетекает между чатами (convId-обвязка)
  и между циклами полноты (сброс после терминального ответа).
### Added
- Чистая функция `GeminiInterceptLogic.updateProbeMetaRetain(prev, incoming, stepOk)` +
  интеграция в core (поля `lastGoodWideCur`/`lastGoodProbeMeta` рядом с serverFirstHash).
- Тесты: 6 unit-тестов H9b (gemini-intercept-logic.test.js) + 2 пина-теста core
  (gemini-fallback-probe.test.js: retained держится/сбрасывается, подача в обе точки,
  безprobe-путь не возвращён).
### Verified
- Полный jest: 38 suites / 530 tests green (522 базовых без регрессий + 8 новых H9b).
- Живой прогон (Chrome, unpacked из MAIN, порт 9222): чат conv-B — первый визит SPA
  (floor/tape очищены): тихая пагинация 3 окна (20+20+20), финальный шаг здоровый, но
  lastPaginateOuter без opaque-строк → БЕЗ H9b здесь был no-wide-cursor (прогон-контроль),
  С H9b: `retained-wide-cur fed reason=oracle-b` → `oracle=complete reason=probe-terminal
  firstHash=0d61ca newOlder=0 cursorFound=no` → fired msgs=80 с верной головой, ложного
  fired из слабой точки нет; холодный рестарт: `[AI CM][COLD_START] … ext=1.15.1` +
  aiCmLastSwStart=COLD_START@1788615465872 (до рестарта @1788615283000); знакомый вход с
  полом — tape-restore action=used → fired msgs=80=floor; без тейпа (удалён только tape) —
  досбор vf5+pag при floorApplied=true на каждом шаге → fired msgs=80 без просадки.
  Детали и цитаты — RELEASE_CHECKLIST, секция H9b.

## [1.15.0] - 2026-09-05
### Fixed
- Gemini (1177-BYPASS): сервер отвечает ошибкой Bard (code 1177 «повторите позже») на запросы
  глубоких/старых окон hNvQHb при серийном докачивании истории. Ретраи того же окна (до 3,
  backoff 2/4/6с, `paginateErrorRetryDecision`) исчерпаны → цепочка НЕ объявляется «концом»:
  `paginateErrorEscalation` поднимает эскалацию на нативный скрытый скролл лоадера (сайт сам
  запрашивает старшие окна своими токенами в своём темпе, src=passive сливается в базу),
  один раз на чат (`nativeEscalationUsedMap`); между окнами после серии 1177 — пауза
  (`paginatePaceDelayMs`, анти-троттлинг), в штатном режиме паузы нет.
- Gemini (OLDER-UNSTARTED / CLEAN-END-UNSCROLLABLE): (цитата первой строки санитизирована — см. локальный леджер)
  чаты (msgs < порога скрытия, scrollH > 8000; чат conv-D: 22 хода, h≈26k) с чисто
  завершённой пагинацией и базой ≥ пола зависали в not-hidden-wait-cap (~60с пустых итераций)
  и не подтверждали полноту → экспорт уходил с [LOW CONFIDENCE]_. Теперь hide применяется при
  старшей истории и недостигнутом начале независимо от msgs (reason=older-unstarted); при
  недоступном скрытом скролле и чистом конце сети лоадер останавливается сразу
  (reason=clean-end-unscrollable → clean-end-stable).
- Убран опасный fbb-фолбэк курсора в тихой пагинации (fbb-строки — префиксы ID ходов, а не
  континуационный курсор): подстановка такого токена стабильно возвращала 1177 и обрывала
  цикл. Продолжение — только по настоящему opaque-курсору (extractCursor).
### Added
- Чистые функции `GeminiInterceptLogic.isBardErrorPage` / `paginateErrorRetryDecision` /
  `paginateErrorEscalation` / `paginatePaceDelayMs` + интеграция в тихий цикл и лоадер;
  инварианты полноты: (3а) `quietEndedClean=true` только при НЕоборванном финальном шаге
  (`lastPagStepBroken=false`), (3в) `clean-end-unscrollable` не стреляет при floor=0 (класс
  первого визита). H9-гейты (untrusted-top, last-step-broken) остаются авторитетными.
- COLD-START маркер Service Worker (aiCmSwBootTs / aiCmLastSwStart + лог [AI CM][COLD_START]).
- Тесты: tests/adapters/gemini-err1177-bypass.test.js (17), gemini-error-page-retry.test.js (9),
  +3 additive-кейса (д/е/ж) в gemini-collapse-guard.test.js.
### Removed
- Dead-code обработчик `UPDATE_CONTEXT_INFO` в background.js (SW эти данные не использует).
### Verified
- Полный jest: 38 suites / 522 tests green (493 базовых без регрессий + 29 новых).
- Живой прогон (Chrome 152, unpacked из MAIN, порт 9222): conv-A F5 — oracle=complete
  loader-stable-stop msgs=108 floor=108, fired lowConf=false count=108; SPA первый визит
  conv-B (floor/tape очищены) — ложного fired до физического верха нет (COPY-код давал
  fired msgs=80 done=collapse floor=0), после done reason=top — fired count=90 lowConf=false.

## [1.14.1] - 2026-09-03
### Fixed
- Gemini: неполный автоэкспорт старых чатов — устранены две причины (баг чата conv-A, 2026-09-02):
  - FB-PROBE: fallback-top объявлял полноту по круговой проверке `base >= floor` (floor мог быть сохранён из такой же ложной полноты при прерванной загрузке). Теперь полнота только после серверного подтверждения v73-probe (0 новых старших ходов, курсор исчерпан); без метаданных сети/курсора полнота не объявляется — экспорт по усечённой базе не стреляет.
  - SHRINK-GUARD: обрезанные сетевые копии ходов ((цитата первой строки санитизирована — см. локальный леджер)) больше не затирают полные restored-тексты ленты — сжатие базы (textLen 147811→124495 при том же числе ходов) устранено; дозаполняются только r1/turnId.
### Added
- Чистые хелперы `GeminiInterceptLogic.fallbackProbeReady` / `decideRestoredMerge` + 14 unit-тестов (gemini-fallback-probe, gemini-shrink-guard).
- O3: кросс-табовый латч already-fired в `chrome.storage.session` — двойной экспорт одного чата из двух окон (…22-12.txt + …22-12(1).txt, 2026-09-02) больше невозможен: `firedSessionKey/isFiredInSession/sessionFiredPatch` в export-emit-pipeline.js, кэш + `storage.onChanged`-синхронизация в content.js, `setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` в background.js; +6 unit-тестов. Латч живёт в рамках сессии браузера (по дизайну storage.session очищается при перезагрузке расширения — это соответствует сценарию гонки вкладок).
### Verified
- Живая проверка: три последовательных экспорта чата conv-A байт-идентичны (MD5 794f7995…), 100% покрытие ручной копии; полный jest 23 сюиты / 365 тестов зелёные; запись session-латча подтверждена в живом браузере.

## [1.14.0] - 2026-08-31
### Added
- Gemini: нециркулярный оракул полноты: probe-terminal, no-older-history (короткие чаты), loader-stable-stop (только при done reason=top и base >= floor).
- Gemini: high-water-mark (tape) держится после F5; бейдж сразу на полу.
### Fixed
- Gemini: зависание «белого экрана» — overlay вместо скрытия контейнера; fallback-скрытый скролл только как страховка тихой пагинации.
- Gemini: тайминг-дыра автоэкспорта при запоздалом base-complete (re-check на переходе 0→1).
- Gemini: ложный [LOW CONFIDENCE]_ и усечённые экспорты — гейты loader-max-not-top / below-floor.
### Changed
- Автоэкспорт явно обозначен как фича Gemini в popup.

## v1.13.1 — 2026-08-28
- Gemini: scroll-confirmed base completeness — лоадер подтверждает полноту базы по скролл-доказательству (hide-applied + stable/no-growth + pendingCursor=0), устраняет «ложную неполноту» когда сервер не отдаёт reachedStart (v59).
- Gemini: stale-conv isolation — тегирование запросов convId+epoch и дроп ответов от старых разговоров после SPA-перехода; ручные и авто-экспорты всегда по текущему convId (v59).
- Gemini: отмена висящего deferred-таймера после успешного экспорта (v54-косметика).


## v1.13.0 — 2026-08-27
- Gemini: realtime DOM catch-up — процент виджета обновляется сразу после завершения стриминга ответа (дебаунс DOM-мутаций, локальный пересчёт токенов, эмит без сетевого запроса); устраняет «лаг в одну реплику» (v57).
- Stream-ingest (I4z33b/Bsxleb): запасной источник ходов из финального кадра стримингового ответа с alias-маппингом rc_* → r_* при поступлении снапшота; не заменяет основной пайплайн, а дополняет его (v58).

## v1.12.0 — 2026-08-27
- Gemini: детектор обрезки истории — suspect→confirmed только при historyComplete; спасательный экспорт до потери данных: reason=pre-trim, суффикс файла -pretrim, независимый латч preTrimExportFired (v54).
- Проактивные пороги 70/85/95%: бейдж на иконке (зелёный/жёлтый/красный), каждый порог один раз за разговор, латчи в storage.session; opt-in Chrome-уведомления с кнопкой «Открыть чат»; блок «Проактивные пороги» в попапе (v55).
- SPA-фиксы: при смене разговора отменяется отложенный экспорт старого разговора (guard reason=stale-conv) и сбрасывается бейдж вкладки (v56).
- CI: фикс сборки Release ZIP — фильтр трекаемых файлов до zip вместо -x после (исправляет exit 123).
- Permissions: добавлено "notifications" (для opt-in уведомлений).



## v1.11.0 — 2026-08-27
- Gemini: гейты полноты экспорта — запись aiCmHistory отложена до (baseComplete && !loaderRunning), flush по loader-stop, таймаут 60с фиксирует «как есть» (v52).
- Gemini: курсор-авторитетный лоадер — data-complete только при !pendingCursor; stall-retry до 90×1с при живом курсоре; cursorEpoch сбрасывает noGrowth/stall на каждый history-write с курсором; по капу done reason=timeout (v53).
- Автоэкспорт: гейт лоадера + SPA already-fired + атрибуция issuedAtConvId + .catch (v51).
- Харденинг: manifest (убран activeTab, google.com/* → /search*), release.yml (zip через git ls-files -z с исключениями -x), background.js (DEBUG=false, лог message.data под флаг), page-intercept.js (try/catch преамбулы fetch/XHR), model-config.js (дедуп ключей), claude-intercept.js (LRU fileTextCache, лимит 50).
- Docs: добавлен docs/QUALITY_AUDIT.md.


## v1.10.0 — 2026-08-26
- Fixed:
  - Автоэкспорт не стреляет до финиша лоадера Gemini: гейт loader-running + re-check после стопа.
  - already-fired переживает SPA-переключения в сессии — без дублей экспорта.
  - Сетевые ответы привязаны к чату в момент отправки (issuedAtConvId) — нет межчатного загрязнения после SPA.
  - Reject промиса лоадера финализирует состояние (нет зависшего «loader-running»).
  - Критерий скрытия невидимого лоадера — height+msgs; лоадер не стартует без старшей истории.
- CI: live-sample тест скипается при отсутствии образца.
- Docs: новый английский README со скриншотами; MIT LICENSE; docs/TESTS.md (карта тестов, фикстуры, смоук-матрица 6×4); docs/AUDIT.md (аудит по классам багов с v1.9.0).

## v1.9.0 — 2026-08-26
- Gemini: пересобран невидимый лоадер полной истории — скролл с первой итерации, при скрытом скроллере стоп только по стабилизации скролла (noGrowth≥3 + контрольные 2с), data-стоп для видимых, порог скрытия 8000px, пауза 800мс в скрытой фазе, возврат в низ.
- Gemini: бейдж из кэша <1с при SPA-переходах; (цитата первой строки санитизирована — см. локальный леджер) на каждый вход в чат; виджет заморожен во время скрытой догрузки и перерисовывается после.
- Gemini: тихая консоль без флага «Подробные логи».
- Автоэкспорт: срабатывает только при полной истории (baseComplete), один раз на чат, skip-логи not-complete/already-fired/below-threshold.
- Тесты: синтетическая min-фикстура парсера Gemini (tests/fixtures), 159 passed / 0 skipped; в CI добавлен шаг npm test.
- Инфраструктура: сброс cacheRefreshPlanned при смене чата; восстановлен синтаксис content.js после внешнего прерывания сессии.


## v1.8.0 — 2026-08-25
- Новое: автоэкспорт чата при достижении порога заполнения контекста (порог 50–99% в options, формат txt/md, один раз на чат с гистерезисом).
- Автоэкспорт скачивает ту же полную историю, что ручной экспорт; пустой снапшот не скачивается.
- Claude: исправлен рост процента при долгом простое — токены вложений пересчитываются с нуля на каждом парсе; полный сетевой снапшот заменяет базу вместо max-merge.
- Claude: диагностический emit-stat под флагом «Подробные логи».
- Исправлены кракозябры (двойная кодировка) в manifest.json и core/claude-intercept.js; manifest сохранён без BOM.
- Options: поле порога удобно в работе (ширина, стрелки, clamp 50–99, синхронизация с storage).
- Инфраструктура: тесты зелёные (156 passed + 1 skipped), jest не сканирует .kilo worktrees.

## v1.7.0 — 2026-08-25
- Claude: экспорт PASTED-вложений — текст из attachments[].extracted_content; фолбэки gzip-кэш completion и paste-очередь; блоки [File …] без дублей
- Claude: защита от кросс-чатной грязи — снапшоты только по convId из ответа (snapshotConvIdOf), tape-restore игнорирует чужой кэш, пропуск устаревших снимков
- Claude: идемпотентность парса (нет умножения блоков), SPA-гарды бейджа, post-send refetch
- Экспорт txt: BOM + префикс [File …] (ASCII) — читаемо в Windows
- Gemini: независимый лоадер полной истории (старт по convId, идемпотентность, ранний выход no-growth), инвалидация done при уходе, фолбэк-рефреш бейджа; лента с учётом аккаунта /u/N
- Надёжность: retry с backoff вместо вечного latch (Perplexity/Claude); DeepSeek-перехватчик перерегистрирован под новым id
- Вежливость/гигиена: cooldown и лимиты страниц в Google Search AI; флаг «Подробные логи» (консоль тихая без флага); попап per-host
- Инфраструктура: зелёные тесты (null-гарды options.js, мок DOM), jest игнорирует .kilo, фикс с fixture — skip при отсутствии файла


## v1.6.0 — 2026-08-19
- Экспорт истории в PDF через печатную форму (кнопка «Сохранить .pdf»), markdown-оформление: таблицы, код, списки
- Gemini: тишина vf5-поллера при полной истории (baseComplete + reachedStart), поллинг возобновляется мгновенно при DOM-мутациях, пассивных batchexecute-снимках и смене чата
- Печать: автозакрытие вкладки после сохранения PDF (afterprint + фолбэк-таймаут 2с)

## v1.5.2 — 2026-08-19
- ChatGPT: начало диалога из истинного корня, включая голосовые сообщения (audio_transcription); entity-токены заменяются видимым текстом, cite/PUA вырезаются; сброс базы/индикатора при смене чата, без спама 404, токены по видимой ветке
- Google Search AI: полные тексты ответов (фикс отсечения по чипу веб-поиска), списки в markdown; активная загрузка истории, модель из сети без ложного 2.5-flash, честная полнота по курсору, защита базы от сжатия, сериализация запросов по threadId/authuser
- Gemini: ожидание готовности DOM перед автоскроллом и retry; защита англоязычных ответов (эвристики только в fallback)

## v1.5.1 — 2026-08-18
- Gemini: хронологический порядок истории по r1-цепочке, начало диалога из сети, версионирование restored-ленты (g3)
- Gemini: вырезание «мышления» и дублей, канонический markdown-ответ без plain-копии
- Попап: кнопка «Экспорт диагностики»
- Экспорт: ограждения блоков кода сохраняются
- README: описание ручного лимита без упоминания GPT

## v1.5.0 — 2026-08-15
- Самодиагностика интеграций: если в DOM есть диалог с сообщениями, но сетевой снимок не пришёл за 12 секунд — попап показывает (цитата первой строки санитизирована — см. локальный леджер), виджет показывает «—» вместо 0.0%; на пустых чатах не срабатывает
- Google Search AI: таблицы и подзаголовки ответов учитываются в расчёте и экспорте (markdown-таблицы); исправлен разбор живого HTML — контент ответа собирается глобально, а не только внутри turn-контейнеров
- Google Search AI: корректный процент при SPA-переключении тредов — кэш полных снимков по threadId и сброс базы при смене треда (возврат на тред без F5 показывает его процент)
- Попап: версия читается из манифеста, а не хардкодом

## v1.4.0 — 2026-08-15
- Экспорт истории из попапа: кнопки «Сохранить .md» и «Сохранить .json» с метаданными (платформа, модель, дата экспорта, токены X / Y (Z%)) — сохраняет диалог до того, как модель начнёт терять контекст
- Перехватчики всех платформ передают роли сообщений в событии (поле messages); при отсутствии поля content.js использует фолбэк-чередование user/assistant

## v1.3.0 — 2026-08-15
- Google Search AI: полная история треда при открытии — разбор большого HTML-потока /async/folwr (ходы по data-scope-id="turn", вопросы из h2.iMqumd, ответы из чанков n6owBd с фолбэками aimfl/TgQPHd); процент виден сразу без F5
- Google Search AI: handshake адаптера и перехватчика — ранние снимки больше не теряются при F5; слияние стрим-обновлений с полной базой — baseCount не уменьшается после обмена репликами
- Автотесты парсера folwr-open на санитизированной фикстуре — всего 27 тестов

## v1.2.2 — 2026-08-14
- ChatGPT: процент появляется сразу при открытии чата, в том числе кликом по сайдбару без F5 (historyComplete в событии + восстановление DOM-инициализации при SPA-переходе)
- ChatGPT: realtime учитывает ответ ассистента — cache-buster активного снимка и серия ретраев до 16 секунд (для аккаунтов, где сервер отдаёт историю с задержкой)
- ChatGPT: активный запрос истории при открытии стал отложенным фолбэком для аккаунтов, где сайт не грузит историю сам; красные 404 в консоли устранены (bootFetch удалён)
- Нейтральный стартовый баннер в консоли вместо слогана про DeepSeek

## v1.2.1 — 2026-08-13
- Исправлен регресс Perplexity после рефакторинга парсера: emitSnapshot больше не обрывается молча (пустые catch заменены логами ошибок), контракт window.parsePerplexityThread и emitSnapshot приведён к единому формату { model, messages, text, count }
- Лендинг и README: Claude и Perplexity добавлены в список поддерживаемых платформ, скриншоты docs/screenshots/claude.png и docs/screenshots/perplexity.png

## v1.2.0 — 2026-08-12
- Добавлена поддержка Perplexity (perplexity.ai и www.perplexity.ai): перехват истории /rest/thread/{slug}, стрим perplexity_ask с виртуальным F5, bootstrap по выученному шаблону URL, SPA-детектор переключения тредов
- Trim-устойчивый парсер Perplexity (сервер отдаёт JSON с пробелами в ключах) вынесен в utils/perplexity-parser.js — единый источник для боевого кода и тестов
- Модели Perplexity в конфиге: turbo (Perplexity Sonar), sonar, sonar-pro, sonar-reasoning, sonar-deep-research
- Автотесты парсера Perplexity с фикстурой пробельных ключей — всего 24 теста
- README: новый раздел «Порог» и пункт в «Как это работает» — документация пользовательского порога заполнения

## v1.1.0 — 2026-08-12
- Добавлена поддержка Claude.ai: перехват GET истории чата, SSE-стрима completion, активный bootstrap-снимок при загрузке страницы, виртуальный F5 после ответа
- Попап показывает живые данные активной вкладки: сайт, модель, токены, лимит, заполнение (live-обновление без перезакрытия)
- Автотесты парсеров всех пяти платформ (Claude, ChatGPT, Gemini, DeepSeek, Search AI) — 20 тестов
- GitHub Actions: автоматическая сборка ZIP при публикации релиза
- ChatGPT: убрана красная ошибка 404 от bootFetch при открытии чата (пропуск, если пассивный снимок уже получен или нет auth-заголовков)
- model-config: добавлен claude-sonnet-5 (Claude Sonnet 5), окно 200 000

## [1.0.0] - 2026-08-11

### Первый публичный релиз

- Поддержка 4 платформ: Google Gemini, ChatGPT, DeepSeek, Google AI Search
- Индикатор заполнения контекстного окна в углу экрана
- Автоматическое подтягивание полной истории без прокрутки
- Realtime-обновление при обмене репликами
- Определение модели из сетевого ответа
- Опциональный точный подсчёт через Gemini API (с ключом пользователя)
- Учёт прикреплённых изображений (оценочно)
