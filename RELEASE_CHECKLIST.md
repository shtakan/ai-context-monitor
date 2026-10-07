# RELEASE_CHECKLIST.md (Стадия: Приёмка)

## Ядро и инфраструктура
1.1 Service Worker стартует; на chrome://extensions нет ошибок («Extension context invalidated» отсутствует)
1.2 Popup: сайт/модель/токены/лимит/заполнение отображаются; выбор модели и «Авто» работают
1.3 Виджет: галочка скрытия/показа работает; тема адаптируется под сервис

## Адаптеры сервисов (токенизация и индикатор)
2.1 ChatGPT: индикатор жив, роли верные, % растёт в реальном времени
2.2 Gemini: индикатор жив; холодное открытие даёт полную историю; % растёт
2.3 DeepSeek: индикатор жив; DeepThink→R1; комбинации Expert/Vision
2.4 Claude: индикатор жив, % растёт (адаптер + claude.ai в manifest)
2.5 Perplexity: индикатор жив, % растёт (адаптер + perplexity.ai в manifest)
2.6 Google Search AI: индикатор жив, % растёт

## История и экспорт
3.1 Gemini холодное открытие: автоэкспорт с полной историей (первое сообщение = первое сообщение чата)
3.2 DeepSeek экспорт: порядок хронологический (u,a,u,a), совпадает с эталоном
3.3 Префикс [LOW CONFIDENCE]_ только при baseComplete=0; при proof отсутствует
3.4 Автоэкспорт (Gemini): триггеры порога и base-complete, один раз на чат (latch)

## Релизная гигиена
4.1 npm test зелёный, node --check всех файлов
4.2 manifest: content_scripts/host_permissions соответствуют всем шести сервисам
4.3 version bump + CHANGELOG
4.4 §0: в docs/QUALITY_AUDIT.md нет открытых находок P0/P1; соответствие принципу проверено в рецензии релиза

## Публикация (Edge Add-ons)
5.1 **TODO:** заменить `homepage_url` в `manifest.json` (`https://github.com/user/ai-context-monitor`) на реальный URL репозитория; заменить `support@example.com` в `privacy/privacy.html` на реальный email поддержки.

> Провенанс: хэши записей до 09.09.2026 относятся к архивной линии истории; новая линия начата initial commit v1.15.3 (clean) после privacy-scrub H26.

## v75 (O2/D-head) — верификация (коммит ba5e9c0)
- Цель: guard full-rebuild-vf5-no-cursor при использованном тейпе (защита головы HWM).
- Цитаты-доказательства (живой лог Gemini, convId=0362260dfd6b7882):
  - [AI CM][tape-restore] convId=0362260dfd6b7882 action=used cachedMsgs=124 firstMsgHash=05e8ff lastMsgHash=14983a
  - [gemini-intercept] пол применён: count=20 (сохранённый=124), effectiveLen=216714 (сохранённый=216714), floorApplied=true
  - [gemini-base-diag] count=124 textLen=216714 baseComplete=true floorCount=124
  - [AI CM][merge-decision] incomingSrc=vf5 ... reason=vf5-cursor-continue (full-rebuild-vf5-no-cursor после tape-restore НЕ сработал)
- Статус: голова HWM (05e8ff) сохранена при холодном F5 и SPA-возврате; guard v75 активен.
- jest: 19 suites / 322 tests green (tests/adapters/gemini-tape-protect.test.js).
## 03.09.2026 — закрытые пункты O1–O5 + гигиена
- O1 (белый экран): v81 overlay-гарды при tape (overlay-suppressed reason=tape-present); live — холодный с тейпом без белого экрана, SPA чисто.
- O2 (HWM/голова): v82 floor-confirmed (base≥floor + тишина 5с, debounce 5.5с), live-цитата oracle=complete reason=floor-confirmed; collapse-guard (scrollH<max(3000,maxSeen/2) && base<floor → doneReason='collapse', ретрай ≤2).
- O3 (кросс-таб латч): autoExportFired в chrome.storage.session (aiCmFired:service|convId); live key=1, дубль блокирован.
- O4 ([LOW CONFIDENCE]_): живой флаг isLowConfidenceBase=(baseComplete!==true); live — ранний ручной с префиксом, автоэкспорт без.
- H3 (баннер): версия из chrome.runtime.getManifest().version; попап v1.14.1.
- v83 (flush-пробел): flush deferred при 0→1 (reason=base-complete); live без 60s-таймаута.
- O5 (Claude/Perplexity): Claude — виджет жив, % растёт, /new 5/5 чисто; Perplexity — freeze пустого треда 5/5 → REST-fallback bootstrapRestSnapshot() (a7430d2), live «снимок (bootstrap-rest): 1 сообщений, model=turbo» → badge-update; jest 27/409.
- Коммиты: a4a9309 (v1.14.1), 8a6a709, e27c005 (collapse-guard+O4+v83+H3), a7430d2 (O5), 3d813aa (chore).

## 03.09.2026 — H4 (перекалибровка эвристики tokenEstimate)
- Корень: эвристика завышала кириллицу в 1.81× (90.1% vs server 49.8% на чате 0362260d, 147 811 симв).
- Фикс: utils/tokenizer.js countTokens — кириллица Math.ceil(n/1.8) → Math.ceil(n/4) (0.25 ток/симв вместо 0.56); добавлен CJK-класс (Math.ceil(n/1.8), 0.55 ток/симв); пунктуация 0.5 → 0.43.
- Отклонение от ТЗ: делитель 4 вместо 2.33 обоснован per-run ceil на 26 312 словах (при 2.33 живой прогон дал бы 75% из-за округления вверх коротких слов).
- Живой прогон (Gemini 3.6 Flash, чат 0362260d, 216 881 симв): BYOK off → 50.0% (63 942 ток), BYOK on → 49.8% (63 713 ток), расхождение 0.4%.
- Коммит: d732371.
- jest: 29 suites / 421 tests green (tests/tokenizer-cyrillic-calibration.test.js).

## 04.09.2026 — H7 (Perplexity: потеря assistant-ходов)
- Корень: парсер читал assistant только из entry.blocks, которого в живом REST /rest/thread/{slug} нет; ответ лежит в entries[i].text (JSON-строка) → шаг step_type:"FINAL" → content.answer (JSON-строка) → поле answer.
- Фикс: utils/perplexity-parser.js — fallback при отсутствии blocks: entry.text → JSON.parse → FINAL-шаг → content.answer → JSON.parse → поле answer; blocks-приоритет сохранён.
- Живой прогон (тред 9b64b5a4, F5): 📥 полный снимок (fetch): 4 сообщений (было 2), textLen=4466 (было 89), roles:[user,assistant,user,assistant], assistant-тексты 902+3473 симв извлечены.
- Новый тред (bootstrap-rest): 1 сообщений → virtual F5: 2 сообщений (ответ подхвачен, зависания нет).
- Коммит: 30d2274.
- jest: 29 suites / 425 tests green (tests/fixtures/perplexity-thread-rest.json + 4 новых теста).

## 04.09.2026 — S2 (настраиваемые пороги)
- Корень: автоэкспорт глобальный (aiCmAutoExportPct), проактивные пороги [70,85,95] захардкожены в PROACTIVE_THRESHOLDS (gemini-intercept-logic.js:1012) и background.js:237.
- Фикс: options.html/js — три поля (low/medium/high) + валидация (возрастание, 1–100, фолбэк [70,85,95]); content.js — per-site порог 'aiCmAutoExportPct_<site>' с фолбэком на глобальный; background.js — чтение порогов через getProactiveThresholds().
- Живой прогон: Gemini кастом [60,80,90] → бейдж жёлтый при 80% (было 85%); ChatGPT per-site=50 (глобальный 90) → автоэкспорт fired при pct=52.7%.
- Коммит: 850182c.
- jest: 31 suites / 446 tests green (+21 новых: tests/options-thresholds.test.js, tests/content-autexport-persite.test.js).

## 04.09.2026 — H8 (ложный аларм попапа на home)
- Корень: попап показывал «Интеграция могла устареть» на home-страницах (ChatGPT `/`, Gemini без `/app/`, и т.д.). stale-флаг взводился в content.js через 12с при `isInitialized && !baseSeen && extractMessages()>0` (DOM-эвристика давала «сообщения» из сайдбара), сетевого EMIT на home нет → флаг липнет.
- Фикс: options.js — чистая функция `isChatHome(hostname, pathname)` (паттерны «диалог открыт»: chatgpt `/(c|g|share)/`, gemini `/app/`, claude `/chat/`, perplexity `/(search|follow)/`, deepseek `/a/`); `updateStaleWarning` показывает предупреждение ТОЛЬКО при `stale===true && isChatHome(...)` — на home `display:none`.
- Живой прогон: ChatGPT home `/` F5 → виджет `—` (stale-прекондиция `baseComplete=false baseSeen=false`), аларма нет; SPA в `/c/...` → `badge-update pct=37.1% tokens=47526 model=GPT-5`, stale не взводится (сетевой EMIT → `baseSeen=true`).
- Коммит: acf9a6c.
- jest: 32 suites / 458 tests green (tests/options-stale-home.test.js: 7 unit + 5 integration).
- Замечание: имя `isChatHome` инвертировано (возвращает `true` для диалога, не для home); переименование в `hasChatDialog` — отдельный H8-cosmetic.

## 04.09.2026 — H9 (ложная полнота первого визита)
- Корень: при floor=0 памятные гейты (floor-confirmed / stable-stop на полу) «вакуумные», DOM-top на схлопнутом скроллере ложно взводил doneReason='top', а scroll-top-proof из serverFirstHash последней «живой» страницы был циркулярен → high-confidence complete на неполной базе первого визита.
- Фикс: 2 additive-гейта (не отключают прежние пути) — чистые функции в utils/gemini-intercept-logic.js: `untrustedTopVerdict` (floor=0 + hadCursor + нет роста скроллера → doneReason='top' недостоверен → collapse, ретрай collapse-guard) и `pagStepBroken` (added=0 + курсора нет + скелет/0 кандидатов → scroll-top-proof подавлен, уходим в probe/loader-restart).
- Живой прогон: SPA (чат 1984298f) — untrusted-top→collapse, экспорт не стреляет; cold/F5 — реальный рост скроллера→top→экспорт fired textLen=86318.
- Коммит: d795033.
- jest: 35 suites / 489 tests green (tests/adapters/gemini-untrusted-top.test.js).

### Матрица классов чатов (live, обязательна на релиз)
- (а) первый визит SPA — тихая пагинация/проба, полнота только из серверной точки (probe-terminal); DOM-top при floor=0 не даёт high-confidence.
- (б) первый визит cold/F5 — реальный рост скроллера → top → экспорт fired с полной историей; untrusted-top при схлопнутом скроллере → collapse-ретрай.
- (в) знакомый чат с полом (floor>0) — stable-stop/floor-confirmed на достигнутом полу; ниже пола не опускаться (high-water-mark).
- (г) знакомый чат без тейпа — пересбор без tape-restore; фолбэк-real-scroll страховка при отсутствии старшей истории.
## 05.09.2026 — 1177-bypass/clean-end
- Корень: сервер Gemini (hNvQHb) отвечает ошибкой Bard (code 1177 «повторите позже») на запросы
  глубоких/старых окон при серийном докачивании; после исчерпания ретраев окна цепочка
  трактовалась как конец → база неполная. Плюс класс «короткие, но высокие» (de4b9f5f: 22 хода,
  scrollH≈26k): msgs < порога → hide не применялся, видимый скролл запрещён → not-hidden-wait-cap
  ~60с → [LOW CONFIDENCE]_ навсегда.
- Фикс: (1) распознавание ошибки-страницы `isBardErrorPage` + ретрай окна 2/4/6с ≤3
  (`paginateErrorRetryDecision`); (2) `paginateErrorEscalation` — после исчерпания ретраев
  эскалация на нативный скрытый скролл лоадера (1 раз на чат, nativeEscalationUsedMap), старшие
  окна добирает сам сайт (src=passive); (3) `paginatePaceDelayMs` — пауза после серии 1177
  (штатный путь без пауз); (4) hide-гейт — reason=older-unstarted/1177-bypass при msgs < порога;
  (5) `clean-end-unscrollable` — недоступный скрытый скролл + чистый конец сети + base ≥ floor →
  ранний стоп (clean-end-stable), без 30 пустых итераций.
- Инварианты: (3а) quietEndedClean=true только при НЕоборванном финальном шаге
  (lastPagStepBroken=false) — добавлено при переносе; (3б) H9-гейты авторитетны:
  untrustedTopVerdict перед 'top', lastPagStepBroken подавляет scroll-top-proof — было в базе,
  не ослаблено; (3в) класс первого визита: floor=0 не подтверждается clean-end ни в одной из
  точек — clean-end-unscrollable (__floorNh>0), oracle clean-end-stable (floorCount78>0),
  collapse-самоизлечение пола (__floorOkCg>0); добавлено при переносе. Live (SPA 1984298f,
  floor/tape очищены): COPY-код давал ложный fired msgs=80 done=collapse floor=0; после гейта —
  fired только после done reason=top msgs=90 lowConf=false, голова верная.
- jest: 38 suites / 522 tests green (493 базовых без регрессий + 29 новых).
- Коммит: dd5afd6

## 05.09.2026 — H9b (retain last-good wide-курсора/probe-meta)
- Корень: wide-курсор контрольного probe читался из единственного волатильного слота
  lastPaginateOuter (запись на каждом успешном парсе hNvQHb, core ~1012), а оборванный
  финальный pag-шаг перезаписывал его битой/терминальной страницей (без opaque-строк) →
  wideCursor=no → probe умирал ровно когда нужен: probeIncomplete('no-wide-cursor')
  (oracle ~3063) и fallback-top 'probe-unavailable' (~2295). Живой контроль на 1984298f
  уточнил механизм: континуационный курсор этого чата живёт В turns (не в rest), поэтому
  rest-широкая экстракция пуста на всех шагах — retained обязан брать «живой» курсор шага
  (next/lastHeadToken), а не только rest-кандидата.
- Фикс: retained last-good — поля lastGoodWideCur/lastGoodProbeMeta рядом с serverFirstHash;
  обновление ТОЛЬКО на здоровом шаге тихой пагинации (added>0 ИЛИ живой курсор, шаг не
  сломан !lastPagStepBroken, src='pag'; probe-парсы не проходят); источник курсора —
  extractCursorWide(lastPaginateOuter) → next → lastHeadToken (монотонно: сломанный шаг
  НЕ перезаписывает); чистое правило updateProbeMetaRetain(prev, incoming, stepOk) по
  образцу saveFloor (stepOk=false → keep prev; stepOk=true → replace; мусор не принимается).
  Подача ВХОДОМ запроса probe в обеих точках: oracle (b) wideCur =
  extractCursorWide(lastPaginateOuter) || lastGoodWideCur; fallback-top fbWideCur/fbMeta
  аналогично (same-convId гард; isStaleReqTag по ответу сохранён). Retained — НЕ источник
  complete: complete только probe-terminal. Сбросы: resetForNewConversation, disjoint-reset,
  после probe-terminal. H9-гейты (untrustedTopVerdict/lastPagStepBroken), floor-гейты,
  quietEndedClean, no-older-history, circular-mismatch, безprobe-путь fallback-top — не
  тронуты.
- Живой прогон (Chrome, unpacked из MAIN, порт 9222; автоэкспорт pct=20):
  - (а) первый визит SPA 1984298f (floor/tape очищены): [gemini-paginate] шаг 2: +ходов=20
    всего=80, курсора нет → нециркулярный оракул; контроль БЕЗ фикса давал no-wide-cursor →
    collapse (untrusted-top no-floor-no-growth) без fired; С фиксом:
    `[AI CM][completeness] retained-wide-cur fed reason=oracle-b convId=1984298ffe185ef1` →
    `oracle=complete reason=probe-terminal firstHash=0d61ca newOlder=0 cursorFound=no` →
    `[AI CM][auto-export] fired … msgs=80 … firstMsgHash=0d61ca` — complete БЕЗ ручного
    скролла, голова верная (первая строка файла «В контекстном меню нет опции запуск от
    имени администратора…» = 0d61ca); ложного fired из слабой точки нет;
  - (б) холодный рестарт Chrome: SW-консоль `[AI CM][COLD_START] Service Worker стартовал
    ts=1788615465872 iso=2026-09-05T13:37:45.872Z ext=1.15.1`, chrome.storage.local
    aiCmLastSwStart=COLD_START@1788615465872 (SW_RESTARTED: до рестарта @1788615283000);
    открытие чата с полом → `[AI CM][tape-restore] … action=used cachedMsgs=80
    firstMsgHash=0d61ca` → досбор → fired msgs=80 с полной головой;
  - (в) знакомый чат с полом: повторный вход 1984298f → tape-restore action=used →
    fired msgs=80=floor; дополнительно e292103e: пол 108 устарел (сервер отдаёт 80) →
    «пол применён: count=80 (сохранённый=108), floorApplied=true, floorValue=150238» —
    pct/бейдж не просели, в файл призрачные ходы не попали (fired по фактической базе);
  - (г) знакомый без тейпа (удалён ТОЛЬКО ai-cm-gemini-tape-g3-u0-1984298ffe185ef1 из
    chrome.storage.local, floor=80 остался): `[AI CM][tape-restore] … action=empty` →
    досбор vf5+pag 20→40→60→80 с «пол применён: count=… floorApplied=true
    floorValue=93967» на каждом шаге → retained-wide-cur fed reason=oracle-b →
    probe-terminal → fired msgs=80 textLen=79442 без просадки.
- Коммит: da12bff
- jest: 38 suites / 530 tests green (522 базовых без регрессий + 8 новых H9b).

## 05.09.2026 — H10 (probe-terminal floor/error gate)
- Корень: probe-terminal (v73) объявлял complete строго по ответу контрольного probe
  (newOlder=0 + курсор не найден), но в классе e292 (floor=108) база усеклась до 80: сервер
  отдаёт на запрос probe ОКНО-ДУБЛЬ хвоста (то же окно 1..80, что уже в базе), контент глубины
  81..108 живёт ВНЕ hNvQHb-канала, а континуационный курсор лежит В turns (не в rest) →
  extractCursorWide (сканирует только rest) даёт cursorFound=no → ложный
  `oracle=complete reason=probe-terminal` → fired msgs=80 при floor=108 (усечённый экспорт).
- Фикс: пол авторитетнее ответа probe. Чистый предикат
  `GeminiInterceptLogic.probeTerminalGate({floorCount,baseCount,pbError})` вызывается в core
  (~3189) ПЕРЕД взводом historyFullByQuiet/reachedStart терминальной ветки:
  floorCount>0 && baseCount<floorCount → block reason=below-floor-probe-terminal; pbError
  (lastHnvPageError=true, error-страница pb — битый-парс-путь) → block reason=pb-error-page;
  иначе null. block → probeIncomplete(reason) → loader-restart (утренний путь докрутки);
  лог `[AI CM][completeness] probe-terminal blocked reason=… msgs=… floor=… pbError=…`.
  НЕ тронуто: retained-вход H9b (wideCur||lastGoodWideCur), класс (а) floor=0, H9-гейты
  untrustedTopVerdict/lastPagStepBroken, FB-PROBE, no-older-history, floor-confirmed/
  stable-stop, extractCursorWide, scroll-top-proof — байтово.
- Живой прогон (Chrome 152, unpacked из MAIN, порт 9222, ext=1.15.2; автоэкспорт pct=20):
  - (1) e292103e холодный F5 без тейпа (floor=108 сохранён):
    тихая пагинация 20→40→60→80, затем
    `[AI CM][completeness] probe-terminal blocked reason=below-floor-probe-terminal msgs=80 floor=108 pbError=0 convId=e292103e4b521dae` →
    `oracle=incomplete reason=below-floor-probe-terminal firstHash=d3212e retries=0` →
    `loader-restart reason=incomplete-oracle` → collapse-guard/clean-end →
    `oracle=complete reason=loader-stable-stop … msgs=80 floor=80` (пол самоизлечен clean-end-путём,
    чат на сервере ужат до 80: head 0d61ca «Ответь на тестовое сообщение длинным текстом.») →
    fired msgs=80 textLen=108321 (gemini-e292103e-2026-09-05_19-37-base-complete.txt).
    С тейпом (полная история 108): `loader] done reason=data-complete … msgs=108` → fired msgs=108
    textLen=126612 → файл gemini-e292103e-2026-09-05_19-35.txt, ПЕРВАЯ строка =
    «Как называется квадратное/прямоугольное окошко, когда кликаю правой кнопкой мыши после
    наведения курсора на свободную область рабочего стола в windows 10?»;
  - (2) 1984298f первый визит (floor/tape/session-латч очищены): floorCount=- / floor=0,
    tape action=empty → тихая пагинация 20→40→60→80 →
    `oracle=complete reason=probe-terminal firstHash=0d61ca newOlder=0 cursorFound=no` — НЕ
    блокирован (floor=0) → fired msgs=80 textLen=79442 →
    файл gemini-1984298f-2026-09-05_19-42-base-complete.txt, первая строка «В контекстном меню
    нет опции запуск от имени администратора при попытке запустить .reg файл. Как исправить?»;
  - (3) 1984298f повторный вход (floor=80=base, tape action=used cachedMsgs=80): гейт пропускает
    (base=floor) → `oracle=complete reason=probe-terminal firstHash=0d61ca` → fired msgs=80
    textLen=79442 без регресса → файл gemini-1984298f-2026-09-05_19-43.txt (первая строка та же).
- Коммит: 4cec8f2
- jest: 38 suites / 542 tests green (530 базовых без регрессий + 12 новых H10; байтово-зелёные
  gemini-fallback-probe / gemini-untrusted-top / gemini-err1177-bypass).

## 09.09.2026 — H12–H25 (приёмка)
- Коммит: 4cec8f2 (код+тесты H10–H25; документы/версия — v1.15.3).
- H12 (A5b): корень — scroll-top-proof был циркулярным оракулом полноты (top+scrollEngaged →
  complete, DOM-top ложно взводился на схлопнутом скроллере); фикс — ветка удалена, полнота
  только из серверно-авторитетных точек (probe-terminal / loader-restart); live — SPA 1984298f
  уходит в (b) probe вместо complete, cold/F5 → probe-terminal fired msgs=80; jest —
  tests/adapters/gemini-untrusted-top.test.js + gemini-intercept-logic.test.js (H12-сьют).
- H13 (inner-cursor): корень — континуационный курсор глубоких окон живёт ВНУТРИ inner
  (outer[0][2]→turns[1]) и длиннее потолка 600 (e292: len=705 для окна 81..100, len=849 для
  окна 101..108); узкий extractCursor (40..600) давал ложный negative, extractCursorWide
  сканировала только rest; фикс — потолок classifyOpaque 600→2000, wide-зоны inner ПЕРВОЙ затем
  rest, приоритет длиннейшему b64-кандидату; live — probe-terminal на усечённой базе (несёт
  живой курсор) больше не объявляется; jest — tests/adapters/gemini-h13-inner-cursor.test.js.
- H14: корень — hex-маркер 16 симв ([0-9a-fA-F] ⊂ b64) классифицировался opaque → ложный
  cursorFound=yes → цикл probe-non-terminal; фикс — isShortHexMarker (<40 → false) в обоих
  классификаторах (канон utils, core не тронут); live — e292-ответ с hex-маркером больше не
  терминальный; jest — gemini-h13-inner-cursor.test.js (H15-сьют).
- H15 (hex-marker): корень — служебный hex-маркер 16 симв в inner (turns[1]) probe-ответа
  (e292) НЕ континуационный токен, но [0-9a-fA-F] ⊂ b64 → ложный cursorFound; фикс —
  isShortHexMarker (16..39) → false в classifyOpaque/classifyOpaqueWide; live — бесконечный
  probe-non-terminal прекращён; jest — gemini-h13-inner-cursor.test.js.
- H16: корень — e292-диагностика inner-зоны терминального шага: inner несёт MIME-тип вложения
  (image/png, len=9) и служебные обрывки; фикс — классификация мусора + границы (см. H17);
  live — активный токен 705/849 не задеты; jest — gemini-h13-inner-cursor.test.js (H17-сьют).
- H17 (mime-garbage): корень — MIME image/png len=9 ('/' ∈ b64, 9 в wide 8..2000 → true) → ложный
  cursorFound=yes → цикл probe-non-terminal; фикс — MIME-префиксы (image/ video/ audio/
  application/ text/) → false + нижняя граница wide 8→16 (канон utils, core не тронут);
  live — e292 inner не даёт ложного курсора; jest — gemini-h13-inner-cursor.test.js.
- H19 (popup-override): корень — selectedModel/customLimit из попапа писались в sync, но НЕ
  читались (лимит/токенизация шли от «Авто»); фикс — core/content.js + options.js применяют
  оверрайды попапа (displayLimit, model лимита, % от Авто) с валидацией и фолбэком; live —
  попап 50% → лимит 50% от Авто-порога, badge-EMIT несёт displayLimit; jest —
  tests/popup-overrides-display.test.js.
- H20 (custom-limit debounce): корень — ввод «50» писал в sync каждый keystroke, промежуточное
  «5» на миг становилось лимитом 5% от Авто (gemini-2.5-flash 128 000×5%=6 400) → ложное
  «Заполнение 400.4%» (25 624/6 400); фикс — запись только после ~500мс тишины (clearTimeout+
  setTimeout, пустое поле → null, кнопка «Авто»/change — мгновенно с гашением таймера);
  live — ввод «50» даёт ровно одну запись; jest — tests/options-custom-limit-debounce-h20.test.js.
- H21 (порядок логов): корень — «skip reason=already-fired» стоял РАНЬШЕ «base-complete trigger»/
  «fired» (кросс-таб session-латч пишет already-fired до блока base-complete); фикс — инвариант
  закреплён: в канонической сессии fired ДО already-fired, в session-latched — инверсия
  задокументирована, fired ровно один; live — вместо двух «shoot» один файл, порядок строк
  исправлен; jest — tests/autoexport-log-order-h21.test.js.
- H22 (in-app theme Gemini): корень — Gemini выражает тёмную тему классом body.theme-host.
  dark-theme (`:where(.theme-host):where(.dark-theme)`), а isDarkMode/aiCmOverlayTheme знали только
  prefers-color-scheme; фикс — aiCmInAppTheme (класс/стиль/data-theme, гейт Gemini) + наблюдатель
  MutationObserver и matchMedia; live — страница чёрная, а виджет был белым (цифры 35.0%);
  сейчас следует теме сервиса; jest — tests/gemini-widget-theme-h22.test.js.
- H23 (claude emit-гонка): корень — MAIN-перехватчик распарсил снимок 120 сообщений в
  13:08:51.404, content.js зарегистрировал слушателя в 13:08:52.506 → fire-once emit потерян
  (svc-emit-trace msgs=0, виджет 0.0%, «Откройте поддерживаемый сайт» до F5 13:11:24); фикс —
  ретейн последнего emit-детейла + ре-эмит по handshake/request-emit, SPA-смена чата обнуляет
  ретейн (чужой снимок не ре-эмитится); jest — tests/claude-emit-handshake-h23.test.js.
- H24 (in-app theme all services): корень — фикс H22 был ограничен Gemini (гейт getServiceKey
  !== 'gemini' → null), у claude.ai тёмный фон на body/обёртке (documentElement прозрачен) → null
  → фолбэк prefers-color-scheme; фикс — luminance-проб computed-фона [body, documentElement]
  обобщён на все сервисы, правило паритета H22 (светлый фон не понижает до light) сохранено,
  токены dark-theme/light-theme остаются гейтнутыми на Gemini; live — тёмный Claude, виджет был
  белым (53.7%) → сейчас тёмный; jest — tests/widget-inapp-theme-h24.test.js.
- H25 (live-перекрас темы): корень — тема Claude приходит ТОЛЬКО сменой CSS-переменных
  (htmlCls/bodyCls не мутируют), themeObserver H22 молчит, matchMedia молчит → перекрас только
  после reload; фикс — aiCmRefreshThemeIfNeeded(): isDarkMode() ≠ применённая палитра →
  applyNativeStyles, вызовы — каждая отрисовка + интервал 5000мс (виджет создан и не скрыт),
  тихий гард (при неизменной теме ни одной style-записи); live — переключатель темы Claude без
  F5 перекрашивает виджет; jest — tests/widget-live-theme-h25.test.js.

### Осознанные остатки (принято пользователем 09.09.2026)
- Красная зона >75%: предупреждение/диагностика при заполнении выше 75% не тестировалась на
  живом прогоне — остаётся риск ложного срабатывания (не блокируется, но не подтверждено).
- Thinking bar N/A: для моделей с thinking/размышлениями индикатор не считается (нет live-эталона).
- Диагностический шум под флаг: часть [AI CM][...]-логов выводится без строгого гейта — шум остаётся
  до отдельной задачи «диагностика под флаг».
- ✅ ВЫЛЕЧЕН хотфиксом F5 (Аппендикс v38, 2026-10-07): гейт base-complete проверяет три латча (in-memory + session + once), дубль при F5 устранён.
- H25-obs телеметрия: H25 подтверждён живым наблюдением телеподобного переключения темы Claude; массовый
  наблюдатель за всеми сервисами (без F5) остаётся за рамками (интервал 5000мс как компромисс).
- DeepSeek/GSA без свежих live: адаптеры DeepSeek и Google Search AI не покрыты свежим live-прогоном
  этой приёмки (регрессионные тесты зелёные, живой прогон не проводился).
- Бейдж-круг только %: бейдж показывает только процент заполнения; интегрально-цветовая/иной
  индикатор не добавлен (сознательное ограничение).
- H26: персональные артефакты (docs/order-bug/*, docs/screenshots/*, perplexity-thread-rest.json)
  не включены в новую историю (clean-перезаливка, вариант Б); архивная история осталась в
  локальной archive-папке; текстовые цитаты первых строк промптов сохранены как доказательная
  база; репозиторий private.

10.09.2026 — H26 privacy-scrub + clean-перезаливка (публичный репозиторий)

Корень: старый репозиторий (shtakan/ai-context-monitor) содержал персональные артефакты в истории:
docs/order-bug/*.txt (1.6 МБ реальных экспортов чатов), docs/screenshots/*.png (7 файлов, ~1.2 МБ),
tests/fixtures/perplexity-thread-rest.json (70 КБ живого треда), живой gemini-head-sample.txt в корне,
реальные convId в комментариях utils/gemini-intercept-logic.js (c_0362260dfd6b7882, c_f47e2edd3b51953a,
rc_c9396ed660e63e2a, r_a45b970914710bd8), цитаты первых строк чатов в CHANGELOG/RELEASE_CHECKLIST.

Фикс:
(1) Удаление старого приватного репозитория (Settings → Danger Zone → Delete)
(2) Создание clean-папки через robocopy с исключениями (docs/order-bug, docs/screenshots,
    perplexity-thread-rest.json, живой gemini-head-sample.txt, тулинг корня)
(3) Санация CHANGELOG: convId-срезы → плейсхолдеры conv-A..conv-F, длинные цитаты в «…» (≥20 симв) →
    «(цитата первой строки санитизирована — см. локальный леджер)»
(4) Санация комментария utils/gemini-intercept-logic.js:1064-1065: реальные convId → example000000000001..4
(5) .gitignore дополнен списком B (процесс-доки: RELEASE_CHECKLIST, INSTRUCTIONS, DHS_RULES,
    CLINE_PROMPT_RULES, CLINE_TEMPLATE, docs/AUDIT, docs/QUALITY_AUDIT, .clineignore)
(6) README.md: секция Privacy (локальная обработка данных, BYOK-разъяснение, chrome.storage.local)
(7) Initial commit 3200001 (114 файлов, 31614 строк): v1.15.3 (clean): initial public release
(8) Создание публичного репозитория shtakan/ai-context-monitor (Public, без инициализации)
(9) Push main + tag v1.15.3
(10) GitHub Release v1.15.3 с санитизированным zip-артефактом (306 KB, sha256:5a639fffd997...)

Верификация публичного артефакта (скачивание + grep):
- Select-String utils/gemini-intercept-logic.js: только example0000, реальных convId нет
- Test-Path docs/order-bug: False
- Test-Path docs/screenshots: False
- Test-Path tests/fixtures/perplexity-thread-rest.json: False

Архивирование: старая папка переименована в ai-context-monitor-archive-v1.15.3 (история с персональными
данными осталась локально, вне git, для справки).

Осознанные остатки:
(а) RAR-бэкапы ai-context-monitor-v1.0_25.07.26* (4 файла, 28–31 МБ, даты 03.09–06.09) содержат
    персональные данные в архивах старого дерева; в публичное поле не попадали; удаление — на усмотрение.
(б) Локальный RELEASE_CHECKLIST (список B) содержит цитаты первых строк чатов и convId как доказательную
    базу приёмки; остаётся в рабочей папке clean под .gitignore; не публикуется.

Коммит: 3200001 (root-commit, initial public release).
Релиз: v1.15.3 (GitHub Release, sha256:5a639fffd99791755a46054a915bdb...).
jest: 47 suites / 722 tests (6 skipped, 716 passed, 0 FAIL).

## T1 (v1.16) — ПЕРВЫЙ ЯРУС: ИМПОРТ АРХИВОВ (стадия: разработка; live-прогон НЕ выполнен)
Объём:
- utils/archive-import.js (новый): детекция 4 форматов, парсеры Gemini Takeout /
  ChatGPT conversations.json / Claude conversations.json / Perplexity threads,
  нормализация ролей и ходов, ключи хранилища, ярлык источника, бюджеты импорта.
- utils/gemini-intercept-logic.js (аддитивно): archiveMergeTurns / archiveFloorRecord /
  archiveCompleteVerdict.
- core/gemini-intercept.js (MAIN, аддитивно): слушатель ai-cm-archive-restore,
  same-conv-union, архивный пол, терминальный archive-complete с переоценкой в emitBaseSnapshot.
- core/content.js (ISOLATED, аддитивно): чтение aiCmArchive:/aiCmConvSource: из
  chrome.storage.local, dispatch в MAIN, индикатор источника (попап + виджет + тултип).
- options/options.html, options/options.js, options/options.css (аддитивно): секция «Архивы»,
  импорт через FileReader, список архивов с удалением, строка «Источник» в попапе.
- manifest.json НЕ изменён (version 1.15.3, host_permissions 9, content_scripts без архива).

Регрессия (цитата лога, `npx jest --runInBand`):
  Test Suites: 51 passed, 51 total
  Tests:       6 skipped, 817 passed, 823 total
Существующие 47 сьютов / 722 теста (6 skipped, 716 passed) не изменялись: git status по tests/**
показывает только новые tests/archive/ и tests/fixtures/archive/. Базовые прогоны до и после:
до —"47 suites / 722 tests, 6 skipped, 716 passed"; после — те же 47 сьютов зелёные
(суммарно 51 сьют / 823 теста с новыми).
Новые сьюиты: tests/archive/format-detection.test.js, parsers.test.js, merge-tier.test.js,
oracle-archive-complete.test.js (100 тестов); фикстуры tests/fixtures/archive/*.json (4 шт.).

Инварианты, закреплённые тестами:
- same-conv-union по id И контенту (role+text); идемпотентность повторного импорта;
- архивный count авторитетен ВВЕРХ и НЕ опускает пол (HWM, saveFloor-монотонность);
- archive-complete только при: архив своего convId + непустой архив + base >= архивного count
  + base >= пола; иначе below-archive-count / conv-mismatch / below-floor / no-archive;
- H9/H10 не ослаблены: probeTerminalGate (below-floor, pb-error), untrustedTopVerdict,
  pagStepBroken — поведенческие и source-level пины (тела гейтов не знают про архив);
- мировая изоляция: в КОДЕ core/gemini-intercept.js нет chrome.* (проверка по коду без комментариев);
- запрет внешних запросов: в options/options.js нет fetch(, файлы читает FileReader;
- manifest.json не изменён.

НЕ ЗАКРЫТО (требует live-прогона на Chrome по протоколу приёмки п.2/п.3 — «должно работать» не принимается):
- (а) архив + холодный F5: пол применён от архива, экспорт содержит голову архива;
- (б) архив + SPA-возврат: ре-мерж и повторный archive-complete (сброс дедупа яруса);
- (в) архив меньше серверной истории: пол не опускается, вердикт withheld;
- (г) удаление архива: источник переключается на live, пол остаётся (HWM);
- (д) индикатор источника в попапе и виджете на живом сервисе.

T1-fix (v1.16.1) — ЖИВОЙ ЯРУС ГЕЙТИТ archive-complete (баг live-прогона: архив 4 хода в чате
на 80 сообщений → полнота по вкладу архива сразу после импорта → автоэкспорт одной архивной части):
- archiveCompleteVerdict гейтится снимком o.live: loaderRunning=false, (loaderDone ИЛИ
  grewBeyondArchive: живых ходов > архива И живое окно стыкуется с архивом), active=false;
  baselineCount === archiveCount без этих доказательств → withheld reason=live-loader-pending.
- Оракул переоценивается дополнительно на стопе живого лоадера (до dispatch ai-cm-loader-state)
  и на конце тихого цикла — решение не зависит от прихода следующего EMIT.
- Пол/HWM (saveFloor, archiveFloorRecord), H9/H10-гейты и resetForNewConversation НЕ изменялись
  (git diff по gemini-intercept-logic.js — чисто аддитивные хунки; в tests/** изменённых файлов нет).
Регрессия после фикса (`npm test -- --runInBand`):
  Test Suites: 52 passed, 52 total
  Tests:       6 skipped, 841 passed, 847 total
Новые пины: tests/archive/archive-oracle.test.js (24 теста) — включая эмуляцию догрузки 4 → 80.
Live-приёмка (а)–(д) по-прежнему НЕ выполнена этим изменением.

T1-fix#2 (v1.16.2) — ФИКС #1 НЕ СРАБОТАЛ: полнота взводилась В ОБХОД archiveCompleteVerdict
(live-прогон: автоэкспорт уходил с одной архивной частью, console baseComplete=true msgs=114):
- (а) stableFloorConfirm (v82): архив поднял пол своим count (4) и его же ходы этот пол закрыли
  (base=4) → через 5.5с тишины historyFullByQuiet=true → baseComplete → автоэкспорт архивной части;
- (б) loader-скип no-older-history: решение выводилось из НЕПУСТОЙ базы, а база была непуста
  ТОЛЬКО архивом (живой RPC ещё не распарсен) → латч loaderDoneMap=true БЕЗ прогона → гейт
  live-loader-pending обходился.
Фикс: aiCmLiveTurnCount / aiCmArchiveOnlyBase / aiCmArchiveLiveProven (MAIN) — «база из одного
архива» не является доказательством живого яруса; floor-confirm и clean-end требуют роста сверх
архива (ветка done=top не тронута); loaderDone при базе «только архив» доказательством не считается;
лоадер ждёт живой сигнал по ЖИВЫМ ходам (скип no-older-history отложен, латч не ставится);
независимый гейт автоэкспорта archive-pending-live (baseCount <= archiveMsgs → skip, латч fired
НЕ ставится — поздний честный экспорт возможен). Пол/HWM, H9/H10 и resetForNewConversation НЕ
изменялись.
Регрессия после фикса (`npm test -- --runInBand`):
  Test Suites: 53 passed, 53 total
  Tests:       6 skipped, 865 passed, 871 total
Новые пины: tests/archive/archive-export-gate.test.js (24 теста) — эмуляция 4 → 114, ложная
полнота на 4 не даёт экспорт, экспорт только на догруженной живой истории.
Live-приёмка (а)–(д) по-прежнему НЕ выполнена этим изменением (нужен прогон на Chrome).

T1-fix#3 (v1.16.3) — ФИКС #2 НЕ СРАБОТАЛ: файл собирался не из объединённой базы
(live-прогон: console baseSize=114, msgs=114, overlapCount=20, а в файле — только архивные
ходы: «Как называется квадратное…» … «Страницы памяти помечаются read-only…»):
- диагностика по коду: прямого чтения aiCmArchive:<convId> в экспорте НЕТ — архив попадает в
  файл через ОБЩУЮ базу (same-conv-union: тот же turnsMap), но:
  (а) источником файла служил последний EMIT (lastBaseTexts), а архив вливается в базу ПЕРВЫМ
      (content.js читает aiCmArchive: сразу при page-load, до живого RPC) → файл уходил одной
      архивной частью;
  (б) гейт fix#2 стоял только в maybeAutoExport, а триггер base-complete (v64) и pre-trim (v54)
      вызывают doAutoExportDownload НАПРЯМУЮ — база «только архив» могла выгрузиться ими.
Фикс: MAIN отдаёт ОБЪЕДИНЁННЫЕ ходы (aiCmBuildBaseMessages — тот же порядок orderExportMessages
и та же санитация, что у EMIT; plus liveCount/archiveCount/baseMsgs) в существующем синхронном
мосте turns-snap; ISOLATED (aiCmExportBaseSource) берёт объединённую базу, если она больше
локального снимка, и ЗАПРЕЩАЕТ файл при живых ходах 0. Решение — чистая функция
resolveExportSource (utils/export-emit-pipeline.js); гейт стоит в ЕДИНСТВЕННОЙ точке записи
файла (doAutoExportDownload), поэтому покрывает порог, base-complete (v64), pre-trim (v54) и
поздний re-check; латч fired при гейте НЕ ставится. Архив не импортирован → поведение 1:1.
Проверено и закреплено: buildArchiveStoragePatch/aiCmImportArchiveFiles пишут ТОЛЬКО два ключа T1
(aiCmArchive:<convId>, aiCmConvSource:<convId>) и объединённую базу (aiCmHistory / лента
ai-cm-gemini-tape-) не перезаписывают. Пол/HWM, H9/H10, resetForNewConversation НЕ изменялись;
ручной экспорт попапа и запись aiCmHistory не тронуты (отдельный контур).
Регрессия после фикса (`npm test -- --runInBand`):
  Test Suites: 54 passed, 54 total
  Tests:       6 skipped, 894 passed, 900 total
Новые пины: tests/archive/archive-export-union.test.js (29 тестов) — эмуляция archiveMsgs=20 /
liveMsgs=114 / overlap=20 (файл = union 114, не архив 20), база «только архив» не выгружается ни
одним из трёх триггеров, реальный doAutoExportDownload исполняется из исходника.
Осознанный остаток того же класса, что и fix#2: чат, где живой истории нет вовсе (архив импортирован
в пустой чат), автоэкспорта не получает — файл пишется только по живому доказательству (ручной
экспорт попапа работает как раньше).
Live-приёмка (а)–(д) по-прежнему НЕ выполнена этим изменением (нужен прогон на Chrome).


## 29.09.2026 - v2.0.13 - Кольцо индикатора: цвет по настроенным порогам
Стадия: разработка -> приёмка (живой прогон НЕ выполнен этим изменением).
Корень: core/widget.js:zoneColor был жёстким 50/80 и не зависел от настроек. При порогах
20/28/54 и pct=60.1% (76892 ток / 128000) кольцо оставалось жёлтым вместо красного.
Фикс:
- aiCmRingBounds() -> [low, high] из chrome.storage.local aiCmProactiveThresholds ;
  битые/отсутствующие пороги -> дефолт [70,85,95] => 70/95 (прежнее поведение из коробки).
- zoneColor(p): p < low зелёный, low <= p < high жёлтый, p >= high красный.
- aiCmLoadRingThresholds(): chrome.storage.local.get([aiCmProactiveThresholds]) +
  chrome.storage.onChanged -> aiCmRepaintRing() — перекрас кольца и доступного имени БЕЗ
  перезагрузки страницы. Звать getProactiveThresholds нельзя: gemini-intercept-logic.js не в
  manifest content_scripts. Флаг подписки живёт на самой функции (изоляция песочниц).
- aiCmSetWidgetA11yLabel(): те же границы, что у цвета (имя не противоречит цвету).
- options_ring_zones_hint (RU+EN, options.html): кольцо и пороги больше не разные настройки.
- ARCHITECTURE_STANDARDS.md, раздел Оси порогов: инвариант не унифицировать заменён
  решением владельца (m00001) — палитра виджета сведена к настраиваемым порогам.
DO-NOT-TOUCH (проверено пинами): core/background.js:aiCmZoneColorFor и
utils/gemini-intercept-logic.js:PROACTIVE_THRESHOLDS/pickProactiveThreshold байтово прежние;
автоэкспорт pct 1-100; options/options.js:percentColor (шкала страницы настроек, 50/80);
transition: stroke 0.18s ease сохранён.
Цитата-доказательство (jest, полный прогон):
  Test Suites: 144 passed, 144 total
  Tests:       6 skipped, 2769 passed, 2775 total
Новые пины: tests/ring-color-thresholds-v2013.test.js (15 тестов)
  - D20: пороги 20/28/54 -> 60.1% красный (до фикса жёлтый); D20b дефолт 70/95;
    D20c битые пороги -> 70/95; R9 живой перекрас из storage и onChanged;
    do-not-touch: литерал circle.style.stroke = zoneColor(percentage);, transition,
    body aiCmZoneColorFor, PROACTIVE_THRESHOLDS, отсутствие chrome.storage.local.set.
Обновлены пины прежних границ: tests/popup-overrides-display.test.js:234/260,
tests/widget-collision-a11y-uiaudit.test.js D19 (70/95 вместо 50/80), D19b.
Живая приёмка (>=2 чата: порог low/high в options -> цвет кольца меняется сразу, без F5;
бейдж/уведомления/автоэкспорт не изменились) — НЕ выполнена, нужен прогон на Chrome.
Коммит: один коммит v2.0.13 (hash — git log --oneline -1).
