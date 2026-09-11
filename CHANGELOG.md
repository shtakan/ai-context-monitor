# Changelog

## [1.15.3] — 2026-09-09
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

## [1.15.2] — 2026-09-05
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

## [1.15.1] — 2026-09-05
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

## [1.15.0] — 2026-09-05
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

## [1.14.1] — 2026-09-03
### Fixed
- Gemini: неполный автоэкспорт старых чатов — устранены две причины (баг чата conv-A, 2026-09-02):
  - FB-PROBE: fallback-top объявлял полноту по круговой проверке `base >= floor` (floor мог быть сохранён из такой же ложной полноты при прерванной загрузке). Теперь полнота только после серверного подтверждения v73-probe (0 новых старших ходов, курсор исчерпан); без метаданных сети/курсора полнота не объявляется — экспорт по усечённой базе не стреляет.
  - SHRINK-GUARD: обрезанные сетевые копии ходов ((цитата первой строки санитизирована — см. локальный леджер)) больше не затирают полные restored-тексты ленты — сжатие базы (textLen 147811→124495 при том же числе ходов) устранено; дозаполняются только r1/turnId.
### Added
- Чистые хелперы `GeminiInterceptLogic.fallbackProbeReady` / `decideRestoredMerge` + 14 unit-тестов (gemini-fallback-probe, gemini-shrink-guard).
- O3: кросс-табовый латч already-fired в `chrome.storage.session` — двойной экспорт одного чата из двух окон (…22-12.txt + …22-12(1).txt, 2026-09-02) больше невозможен: `firedSessionKey/isFiredInSession/sessionFiredPatch` в export-emit-pipeline.js, кэш + `storage.onChanged`-синхронизация в content.js, `setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` в background.js; +6 unit-тестов. Латч живёт в рамках сессии браузера (по дизайну storage.session очищается при перезагрузке расширения — это соответствует сценарию гонки вкладок).
### Verified
- Живая проверка: три последовательных экспорта чата conv-A байт-идентичны (MD5 794f7995…), 100% покрытие ручной копии; полный jest 23 сюиты / 365 тестов зелёные; запись session-латча подтверждена в живом браузере.

## [1.14.0] — 2026-08-31
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
