// core/deepseek-intercept.js (v11 = v10 + полнота базы и turnsMap в SPA-созданном чате: O-17)
// Перехватчик DeepSeek в МИРЕ САЙТА (world: "MAIN"), document_start. Регистрация — background.js.
// В этом шаге меняются ТОЛЬКО этот файл и adapters/deepseek-adapter.js (v9: DOM-ветка
// live-режима — роли ходов и панель reasoning). content.js / page-intercept.js /
// gemini-intercept.js / background.js / manifest / model-config — НЕ ТРОГАТЬ.
//
// Источник данных: перехват fetch/XHR в МИРЕ САЙТА (world:"MAIN", document_start).
// Тихая пагинация: НЕ НУЖНА (вся история в одном ответе history_messages).
// Числитель процента: accumulated_token_usage с сервера (без токенизатора).
// Гард перекрёста: chat_session_id из URL/тела vs currentConvId из location.pathname.
//
// ВНИМАНИЕ: ModelConfig НЕ доступен в world:MAIN (инжектится в ISOLATED мире контент-скрипта).
// Модель определяется ПОХОДОВО: сначала по сетевым сигналам нового контракта (v13),
// затем прежним фолбэком по thinking_enabled: true → r1, иначе → v3.
// model_type (expert/default) передаётся как modelMode в detail и участвует в детекции v13.
//
// v13 (2026-10-03): новый сетевой контракт DeepSeek. Имя модели в сети не передаётся
//   (SSE ready: model_type:"default"; SSE update_session: model:"", conversation_mode:"DEFAULT";
//   /client/settings: name:"Instant", model_type:"default"). Прежняя эвристика по
//   thinking_enabled давала устаревший slug (deepseek-r1/v3) и занижала лимит бейджа до
//   65536/128000 вместо 1 000 000. Теперь сигналы контракта маппятся в 'deepseek-v4.1-flash'
//   (см. __aiCmDeepseekResolveModelSlug ниже). Числитель (accumulated_token_usage) не тронут.
//
// v5: подавление ложной кнопки «Ошибки» на плитке расширения (chrome://extensions).
//   Причина: обёртка window.fetch подменяет оригинал, поэтому ЛЮБОЙ fetch страницы создаёт
//   промис внутри нашей обёртки. Когда чужой запрос страницы отклоняется без обработчика
//   (Failed to fetch при навигации/переключении/обрыве стрима), браузер видит unhandled
//   rejection и, поскольку промис создан в обёртке, приписывает ошибку расширению.
//   Решение: (1) тихий .catch на промисе originalFetch — снимает unhandled-сигнал для
//   чужих прерванных запросов, не меняя поведения страницы; (2) устранение висячих
//   Promise.reject(err) в onRejected цепочек истории и стрима (замена на пустую функцию).
//
// v6: детектор усечения истории после F5.
//   Проблема: при перезагрузке сервер иногда возвращает усечённый history_messages —
//   не полную цепочку, а «хвост». Существующий MERGE-дозапрос срабатывает только
//   при полностью пустом chat_messages.
//   Решение: buildActiveChain возвращает флаг truncated (цепочка оборвана — первый
//   parent_id не null, но сообщение отсутствует в chat_messages). При усечении —
//   однократный тихий дозапрос полной истории без cache_version/cache_reset_at.
//   Флаг дозапроса сбрасывается в resetForNewConversation для защиты от зацикливания.
//
// v7: (1) убран sort по inserted_at в buildActiveChain — NaN по ISO-строкам + инверсия
//     пары (assistant ранее user); хронология ТОЛЬКО parent_id + reverse.
//     (2) reachedRoot (корень = узел без parent_id) и честный historyComplete
//     пробрасываются в detail события и в диагностический дамп.
//     (3) в detail добавлен convId (зеркально gemini) — stale-conv гард в content.js
//     работает и для DeepSeek.
//     (4) роль unknown сохраняется как есть (не маппится в assistant), лог только
//     под debug-флагом.
//
// v8 (O-7): reasoning-цепочки (фрагменты type:"THINK") попадают в текст хода.
//   ФАКТ: DeepSeek ОТДАЁТ reasoning — и в history_messages (fragments[].type === 'THINK'),
//   и в SSE-потоке completion (тот же тип THINK; порядок фрагментов задаёт, куда идёт
//   порция content по пути response/fragments/-1/content). Это НЕ ограничение платформы:
//   в v7 и раньше константа INCLUDE_THINKING=false просто выбрасывала THINK из текста хода.
//   Решение: ответ (RESPONSE) и рассуждение (THINK) собираются раздельно; текст хода
//   получает секции [REASONING]…[ANSWER]… (только если reasoning непустой — ходы без
//   reasoning байтово прежние). В detail добавлены reasoningTexts и messages[].reasoning.
//   Подсчёт токенов НЕ тронут (числитель для DeepSeek — серверный accumulated_token_usage).
//
// v9 (O-15): парность ходов live-режима и целостность фрагментов reasoning/answer.
//   ПРИЧИНА 1 (потеря 2 символов и головы [ANSWER], «точка-паразит»): чанк
//   {p:"response/fragments", o:"APPEND", v:[{type,content}]} — это не только ОБЪЯВЛЕНИЕ
//   типа нового фрагмента, но и ПЕРВАЯ ПОРЦИЯ ЕГО КОНТЕНТА. v8 регистрировал только тип
//   (val[i].type), а content выбрасывал → у каждого нового фрагмента терялось начало:
//   2 символа ("Ре"→зультаты, "Те"→перь, "По"→хоже) там, где сервер прислал в этом чанке
//   ровно 2 символа, и вся порция целиком там, где он прислал больше (в т.ч. ведущий "\n\n").
//   Тот же выброс головы ответа давал [ANSWER], начинающийся с точки (выпал "Итог: берите
//   модель B", осталось ". Она дешевле").
//   РЕШЕНИЕ: поток фрагментов собирается как В HISTORY — массив {type, content} в порядке
//   прихода; APPEND = дельта, SET = замена (без среза с фиксированным смещением: только
//   проверка префикса indexOf === 0), контент чанков fragments[] больше не выбрасывается.
//   ПРИЧИНА 2 (потеря ходов live): (а) ход ассистента создавался только при НЕПУСТОМ
//   sseCollectedText — если ответ пришёл в чанке fragments[], хода не было вовсе
//   («ответы 1–2 отсутствуют»); (б) терминал хода обрабатывался только на BATCH
//   quasi_status FINISHED / close, поэтому последний ход сессии не попадал в live-экспорт
//   (у него не было ни close, ни quasi_status). РЕШЕНИЕ: ход создаётся при непустом ответе
//   ИЛИ reasoning; поток читается инкрементально (полные строки — сразу в разбор), а конец
//   тела ответа закрывает ход (finishSseStream) — терминальный чанк больше не обязателен.
//   ПРИЧИНА 3 (пара assi+assi, «reasoning — отдельное сообщение»): в history_messages
//   reasoning может прийти ОТДЕЛЬНЫМ assistant-сообщением (только THINK). v8 пропускал
//   такой узел (`if (!text) continue`) — reasoning терялся. РЕШЕНИЕ: ход = user +
//   assistant(reasoning+answer): узел-assistant без ответа не становится ходом, его
//   рассуждение приклеивается к следующему (или предыдущему) assistant-узлу.
//   ИНВАРИАНТ: для одного чата live-экспорт и экспорт из истории совпадают по составу ходов
//   и по байтам текста (проверяется tools/_o7-reasoning-verify.js и tests/adapters/
//   deepseek-o15-pairing.test.js). Формат [REASONING]/[ANSWER], токены и прочие сервисы
//   не тронуты.
//
// v10 (O-16): ход ассистента больше не «замерзает» усечённым на живом стриме.
//   СИМПТОМ (живой прогон): файл автоэкспорта (histSource=memory) обрывался на полуслове
//   в последнем ответе ассистента, хотя в сети полный текст уже был.
//   ПРИЧИНА: терминальный чанк (quasi_status FINISHED / event: close / конец тела)
//   может прийти ДО того, как сервер дослал остаток ответа. finalizeRealtimeTurn в этот
//   момент (а) создавал assistant-ход с ЧАСТИЧНЫМ текстом и (б) вызывал resetStreamState(),
//   который обнулял sseRequestMessageId/sseResponseMessageId. Досланные после этого
//   фрагменты копились в новом буфере, но закрыть ход было уже нечем (finishSseStream
//   требует непустые id) — а гард `!turnsMap[assistantId]` запрещал обогатить уже
//   созданный ход. Итог: в memory-базе (lastBaseTexts) навсегда оставался усечённый ход,
//   и автоэкспорт/ручной экспорт писали файл «по полуслово».
//   РЕШЕНИЕ: (1) полный сброс потока — ТОЛЬКО на старте НОВОГО потока (beginSseStream)
//   и при смене чата; (2) повторный финал того же потока обогащает существующий ход
//   более полным текстом (merge «длиннее побеждает», без потери уже собранного);
//   (3) наружу отдаётся состояние потока: синхронный probe
//   'ai-cm-deepseek-stream-probe' → 'ai-cm-deepseek-stream-probe-response'
//   ({convId, active, turnFinished}) и принудительный сброс буфера
//   'ai-cm-deepseek-stream-flush' — ISOLATED-мир (core/export-manager.js) по ним
//   откладывает автоэкспорт на время стрима и флашит буфер для ручного экспорта.
//   Формат [REASONING]/[ANSWER], токены, парность ходов (O-15) и прочие сервисы не тронуты.
//
// v11 (O-17): полнота базы и turnsMap в чате, созданном через SPA (без F5).
//   СИМПТОМ (живой прогон, чат создан SPA-переходом, страница не перезагружалась):
//   EMIT идут с baseComplete=false (baseCount=2 → 4, pct=6%), автоэкспорт висит в
//   deferred до 60s-таймаута и пишет as-is с префиксом [LOW CONFIDENCE]_, ручной экспорт
//   отдаёт неполную базу. После F5 тот же чат даёт «история ПОЛНАЯ по сети» и полный файл.
//   ПРИЧИНА 1 (полнота): вердикт полноты выносился ТОЛЬКО по обходу цепочки
//   (buildActiveChain → reachedRoot) и требовал НЕПУСТОЙ цепочки, дошедшей до корня.
//   В ветке первичной загрузки страницы (ответ на запрос самой страницы) база непустая —
//   вердикт есть; в ветке «тихий дозапрос по таймеру» после SPA-смены чата
//   (scheduleHistoryRefetch → refetchFullHistory → ingestHistory) единственный ответ —
//   авторитетно ПУСТАЯ база нового чата (is_empty=true, chat_messages=[], current_message_id=null):
//   ранний `if (!chain.length) return;` оставлял histCompletion.historyComplete=false
//   НАВСЕГДА, realtime-эмиты наследовали false, гейт O-16 «defer до base-complete» не
//   разрешался, и файл уходил по аварийному пути. РЕШЕНИЕ: единый критерий полноты для
//   ОБЕИХ веток — DeepSeek отдаёт историю ОДНИМ ответом без курсора пагинации, поэтому
//   полнота ставится по САМОМУ ответу (скролл/лоадер/подтверждение начала не нужны):
//   цепочка дошла до корня ИЛИ база авторитетно пуста (0 ходов = вся история).
//   MERGE-ответ (пусто при is_empty!==true) полнотой НЕ признаётся — только дозапрос
//   без cache-параметров (тот же детектор v6, теперь и в ветке дозапроса).
//   ПРИЧИНА 2 (turnsMap/база): сброс turnsMap стоял ДО проверок снимка, поэтому
//   пустой/MERGE/усечённый ответ СТИРАЛ уже собранные live-ходы, а следующий realtime-финал
//   публиковал СХЛОПНУВШУЮСЯ базу (в живом логе: в записи истории msgs=1..2 при 4 ходах в
//   чате) — авто- и ручной экспорт получали обрезанный состав. РЕШЕНИЕ: turnsMap
//   сбрасывается ТОЛЬКО для снимка, принятого как авторитетный; пустой/чужой/MERGE-ответ
//   базу не трогает. Плюс: дозапрос больше не может уйти по URL ПРЕДЫДУЩЕГО чата
//   (lastHistoryUrl после SPA-перехода) — иначе в базу вливалась чужая история.
//   ДИАГНОСТИКА: DeepSeek теперь отвечает на мост ai-cm-turns-snap-request/response, поэтому
//   '[AI CM][turnsMap] snapshot-at-manual msgs=N' показывает РЕАЛЬНОЕ число ходов (раньше
//   snap=null → msgs=0 firstText="" — выглядело как пустой turnsMap).
//   Поведение O-15/O-16 сохранено: defer до base-complete остаётся, аварийный путь
//   deferred-timeout(60s)/as-is с [LOW CONFIDENCE]_ — только для реально неполной базы.
//
// v12 (O-18, фаза 2): ресинхронизация парсера фрагментов + сетевой дозапрос в момент экспорта.
//   ПЕРВОПРИЧИНА (измерено фазой 1, дамп прогона 19-12): строка-дельта пути response/fragments
//   классифицировалась по ФОРМЕ (`/^[A-Z][A-Z_]{2,}$/`), а не по белому списку. Любой
//   контент-чанк, целиком состоящий из заглавных латинских букв и '_' (длина ≥ 3), принимался
//   за ОБЪЯВЛЕНИЕ ТИПА нового фрагмента: «…|| DEFAULT_SU» | «BSCRIPT» | «ION» → тип «BSCRIPT»
//   (и «ION»), а весь дальнейший текст ответа уходил в мусорные фрагменты, которые
//   streamFragmentText('RESPONSE') не читает. Отсюда обрыв файла на «…DEFAULT_SU» при полном
//   ответе на странице (frags sse-finish: BSCRIPT/ION/OFF/REEN/UMENT/URL/DOM/ARS, live=5942
//   против полного ответа, verdicts ONE-SIDE×4 — сеть в тот прогон не опрашивалась вовсе).
//   РЕШЕНИЕ: (1) имя фрагмента принимается ТОЛЬКО из белого списка SSE_FRAGMENT_TYPES
//   (THINK/RESPONSE/… — типы протокола DeepSeek); (2) типоподобный токен вне белого списка —
//   признак ДЕСИНХРОНА: он (и всё, что уже ушло за последнюю валидную границу) возвращается
//   в контент последнего валидного фрагмента пересборкой из СЫРОГО кольца дельт
//   (sseResyncRing), а не заводится новый «тип»; (3) байты контента никогда не пишутся в
//   невалидный фрагмент (позиционное переиспользование исключено); (4) имена типов из
//   массивов response/fragments валидируются тем же белым списком — мусорных фрагментов в
//   буфере не остаётся вовсе. Кандидаты K4 («длиннее побеждает») и K7 (финал/flush) не тронуты:
//   дамп не показывает их вины.
//   СЕТЕВОЙ ДОЗАПРОС: перед композицией файла (авто и ручной экспорт) ISOLATED-мир спрашивает
//   MAIN по мосту ai-cm-deepseek-net-sync; если сетевого снимка нет или он старше последнего
//   завершённого хода — history_messages текущего convId запрашивается заново (таймаут 3 с),
//   per-turn выбирается текст (EQUAL → live, MIDDLE-HOLE/TAIL-CUT → сеть, ONE-SIDE → live +
//   маркер в логе), затем снимок публикуется обычным EMIT. Сеть недоступна/пуста — файл
//   собирается прежним live-путём. Латчи/пороги O-16, гейты полноты O-17 и формат
//   [REASONING]/[ANSWER] не тронуты.

// ===== v13 (2026-10-03): чистый резолвер slug модели по сетевым сигналам =====
// Определён ВНЕ IIFE: контрактный тест импортирует его через module.exports, не поднимая
// весь перехватчик (fetch/XHR-обёртки, состояние потока).
var AI_CM_DEEPSEEK_V4_FLASH_SLUG = 'deepseek-v4.1-flash';

/**
 * Сетевые сигналы модели DeepSeek (SSE ready/update_session, history chat_session, settings).
 * @typedef {Object} AiCmDeepSeekModelSignals
 * @property {string} [model]            значение поля model (в контракте 2026-10-03 — "")
 * @property {boolean} [modelPresent]    присутствовало ли поле model в payload
 * @property {string} [modelType]        model_type (default|expert|null)
 * @property {string} [conversationMode] conversation_mode (DEFAULT|...)
 * @property {string} [configName]       name активной конфигурации из /client/settings (Instant)
 */

/**
 * Slug модели по сетевым сигналам. Приоритет:
 *   (a) явный непустой model из сети → он же (обратная совместимость);
 *   (b) сигналы unified Intelligent Mode → 'deepseek-v4.1-flash';
 *   (c) иначе '' — вызывающий применяет прежний фолбэк по thinking_enabled.
 * @param {AiCmDeepSeekModelSignals} [signals]
 * @returns {string}
 */
function __aiCmDeepseekResolveModelSlug(signals) {
  var s = signals || {};
  var raw = (typeof s.model === 'string') ? s.model.trim() : '';
  if (raw) return raw;   // (a)
  var modelType = String(s.modelType || '').toLowerCase();
  var convMode = String(s.conversationMode || '').toUpperCase();
  var configName = String(s.configName || '').toLowerCase();
  var isDefaultType = modelType === 'default';
  var isDefaultConv = convMode === 'DEFAULT';
  // model:"" присутствует и разговор в DEFAULT-режиме — та же новая ветка без model_type
  var emptyModelNewContract = (s.modelPresent === true) && raw === '' && isDefaultConv;
  // Контракт сети от 2026-10-03: имя модели не передаётся, unified Intelligent Mode = V4.1-Flash (захват координатора, chat.deepseek.com)
  if ((isDefaultType && isDefaultConv) || emptyModelNewContract ||
      (isDefaultType && configName === 'instant')) {
    return AI_CM_DEEPSEEK_V4_FLASH_SLUG;   // (b)
  }
  return '';   // (c)
}

if (typeof window !== 'undefined') {
  try { window.__aiCmDeepseekResolveModelSlug = __aiCmDeepseekResolveModelSlug; } catch (eWin) { }
}

(function () {
  if (window.__aiCmDeepseekInterceptInstalled) return;
  window.__aiCmDeepseekInterceptInstalled = true;

  // v31: флаг «Подробные логи» транслируется из content.js (ISOLATED) через CustomEvent
  try { window.addEventListener('ai-cm-debug-logs', function (ev) { __aiCmSetDebugLogs(!!(ev && ev.detail)); }); } catch (e) {}

  var originalFetch = window.fetch;
  var OriginalXHR = window.XMLHttpRequest;
  var originalXHROpen = OriginalXHR ? OriginalXHR.prototype.open : null;
  var originalXHRSend = OriginalXHR ? OriginalXHR.prototype.send : null;

  // ===== СЕКЦИЯ 1: КОНСТАНТЫ =====
  // v8 (O-7): reasoning-фрагменты THINK разбираются отдельно от ответа.
  //   REASONING_ENABLED=false возвращает поведение v7 (THINK не попадает в текст).
  var REASONING_ENABLED = true;
  // REASONING_TAG/ANSWER_TAG переехали в core/deepseek-parse.js (Step D.4): их читает
  // только composeTurnText, тело которого живёт в модуле.
  var MODEL_WINDOW_DEFAULT = 131072;  // совпадает с model-config deepseek-v3/r1

  // ===== СЕКЦИЯ 2: НАКОПИТЕЛИ =====
  var turnsMap = {};          // ключ = String(message_id)
  var orderCounter = 0;
  var attachTokens = 0;
  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
  var loggedOk = false;
  var loggedHistory = false;
  var loggedRealtime = false;

  // ===== Step D.5: K1 (CONV ID + ДЕТЕКТОР СМЕНЫ ЧАТА) вынесен в core/deepseek-conv.js =====
  // Здесь были getConvId (парсер convId из location.pathname), resetForNewConversation
  // (полный сброс состояния на смену разговора), checkConvChange и патчи
  // history.pushState / history.replaceState / window.popstate, которые взводят детектор.
  // Тела живут в модуле (PURE-зона и BIND-зона внутри `with (D)` — см. шапку
  // core/deepseek-conv.js) и обращаются к состоянию ядра через контракт __bind; связка —
  // в конце этого IIFE, форвардеры (getConvId, resetForNewConversation) хойстятся.
  // Модуль подключён в core/background.js строго перед этим файлом (js[] одного
  // registration, id -v7) и ИСПОЛНЯЕТСЯ раньше ядра: патчи pushState/replaceState ставятся
  // на загрузке модуля — иначе первый SPA-переход страницы не сбросил бы состояние.
  // Объявления ниже и O-22-слушатель ОСТАЛИСЬ ЗДЕСЬ: их читают/пишут оставшиеся секции
  // (fetch-хук K11, XHR-копилка K9, приём снимка K5, emit-гард O-22) — вынос означал бы
  // правку K3-K11. currentConvId тоже остался: его читают те же секции и контракты D.1/D.2,
  // а модуль получает переменную rw-парой и видит ТУ ЖЕ переменную (иначе перезапись при
  // смене чата молча терялась бы в sloppy-режиме).
  var aiCmDeepseekConv = (typeof window !== 'undefined' && window.AiCmDeepseekConv) || null;
  // РАННЯЯ связка модуля (пустые зависимости). Почему она нужна: Fn.getConvId/Fn.checkConvChange
  // появляются на объекте модуля ТОЛЬКО в __bind, а строка ниже ЧИТАЕТ НАЧАЛЬНЫЙ convId
  // НА ЗАГРУЗКЕ ядра — без ранней связки это был бы TypeError. Ранней связки достаточно ровно
  // потому, что getConvId не читает НИ ОДНОГО имени из D (смотрит в location), а
  // checkConvChange зовётся позже, уже после ПОЛНОЙ связки в конце этого IIFE (там же, где
  // связки D.1-D.4: к её моменту все переменные ядра объявлены). Тело resetForNewConversation
  // (оно читает состояние) дополнительно защищено guard-строкой полноты связки в модуле.
  if (aiCmDeepseekConv) aiCmDeepseekConv.__bind({});
  // Начальный convId: читаем модуль напрямую, а не через форвардер — Fn.getConvId пуст до связки.
  var currentConvId = aiCmDeepseekConv ? aiCmDeepseekConv.getConvId() : '';
  // O-22 (ФИКС F4): сигнатура последнего РЕАЛЬНО опубликованного снимка и его возвращаемое
  // значение (для раннего возврата вызывающим). null — гард пуст, первый диспатч не глушится.
  // ВАЖНО (Step D.5): lastBaseServerTokens/lastBaseChatMode/lastDispatchSig/lastDispatchResult
  // жили в СЕКЦИИ 3 среди объявлений вынесенного кластера. Объявления перенесены СЮДА, в ядро:
  // их читают emit-гард O-22 (последние два — ещё и слушатель смены разговора ниже) и
  // emitBaseSnapshot (с D.6 живёт в core/deepseek-emit.js, читает их rw-парой). Если
  // оставить их в модуле, ядро читало бы НЕЯВНЫЕ глобалы —
  // в браузере (window) это работало бы, но в стендах с изолированным vm/jsdom-скоупом дало бы
  // ReferenceError (поймано сьютом D.5 на lastDispatchSig).
  var lastAuthHeaders = {};
  var lastLoadedConvId = '';
  // historyRefetchTimer (таймер дозапроса) переехал в core/deepseek-refetch.js (Step D.3)
  var lastHistoryUrl = '';          // v6: URL последнего history-запроса для дозапроса при усечении
  var historyRefetchDone = false;   // v6: флаг «один дозапрос за загрузку чата»
  // v7: честная полнота базы — проставляется из reachedRoot после ingest (realtime-эмит
  // наследует последнее подтверждённое состояние). Сброс — при смене чата.
  // v11 (O-17): baseEmpty — база авторитетно пуста (новый чат создан через SPA): 0 ходов
  // тоже ПОЛНАЯ история; такие снимки не публикуются (content.js игнорирует пустой text),
  // но вердикт полноты наследуется следующим непустым эмитом.
  var histCompletion = { historyComplete: false, reachedRoot: false, baseEmpty: false };
  // v11 (O-17): параметры последнего эмита — нужны для ре-эмита базы в момент, когда
  // вердикт полноты меняется 0→1 без изменения текста (пустой ответ дозапроса поверх
  // уже собранных live-ходов): content.js узнаёт о полноте только из непустого EMIT.
  var lastBaseServerTokens = 0;
  var lastBaseChatMode = '';
  // O-22 (ФИКС F4): сигнатура последнего РЕАЛЬНО опубликованного снимка и его возвращаемое
  // значение (для раннего возврата вызывающим). null — гард пуст, первый диспатч не глушится.
  var lastDispatchSig = null;
  var lastDispatchResult = null;

  // O-22 (ФИКС F4): сброс последней сигнатуры на событии смены разговора. Событие диспатчит
  // resetForNewConversation (выше) и ISOLATED-сторона при SPA-переходе: первый диспатч новой
  // базы не глушится, даже если convId в URL не изменился.
  try {
    window.addEventListener('ai-cm-conversation-changed', function () { lastDispatchSig = null; });
  } catch (eO22rs) { }


  // ===== Step D.6: K2 (EMIT) вынесен в core/deepseek-emit.js =====
  // Здесь были СЕКЦИЯ 4 целиком: buildDispatchSignature (payload-точная сигнатура
  // снимка, O-22/ФИКС F4), emitBaseSnapshot (единая точка публикации события
  // ai-cm-full-history + гард повторного диспатча; 3 сайта вызова остались в ядре —
  // приём снимка истории и два realtime-финала, плюс ре-эмит полноты 0→1),
  // clipTurnText и turnsSnapshot (сводка turnsMap для дампов экспорта, v11/O-17)
  // и мост ai-cm-turns-snap-request → ai-cm-turns-snap-response.
  // Тела живут в модуле (PURE-зона и BIND-зона внутри `with (D)` — см. шапку
  // core/deepseek-emit.js) и обращаются к состоянию ядра через контракт __bind:
  // 7 fn + 4 rw + 5 ro = 16 имён; связка — в конце этого IIFE, форвардер
  // emitBaseSnapshot (function declaration — хойстится) в блоке связки D.6.
  // Объявления lastBaseServerTokens/lastBaseChatMode/lastDispatchSig/lastDispatchResult
  // (строки 292-297 выше) и O-22-слушатель (299-304) ОСТАЛИСЬ: их читают ре-эмит
  // полноты 0→1 в ingestHistory и слушатель смены разговора; turnsMap/attachTokens/
  // attachBreak/histCompletion/currentConvId ведут K5/K6/K9/K11 — модуль получает их
  // ro-геттерами. Модуль подключён в core/background.js строго перед этим файлом
  // (js[] одного registration, id -v8): к связке в конце этого IIFE
  // window.AiCmDeepseekEmit уже есть.

  // ===== Step D.4: K3+K4 (MODEL-хелпер, цепочка, текст хода) вынесены в core/deepseek-parse.js =====
  // Здесь были СЕКЦИЯ 5 (getModelSlug — slug модели хода: сетевые сигналы K0, затем
  // фолбэк по thinking_enabled), СЕКЦИЯ 6 (buildActiveChain — walk по parent_id, ловушка
  // №1), СЕКЦИЯ 7 (collectTurnText/collectTurnReasoning/composeTurnText — сборка текста
  // хода по type фрагментов) и hidden-пометки базы (DS_PP_VISIBLE_MARKER +
  // hasInjectedUserPrompt, v13/O-7). Тела живут в модуле (PURE-зона и BIND-зона внутри
  // `with (D)` — см. шапку core/deepseek-parse.js) и читают ядро через контракт __bind;
  // связка — в конце этого IIFE. Модуль подключён в core/background.js строго перед этим
  // файлом (js[] одного registration, id -v6): на момент связки window.AiCmDeepseekParse
  // уже есть. Константы REASONING_TAG/ANSWER_TAG уехали вместе с composeTurnText (СЕКЦИЯ 1
  // выше), REASONING_ENABLED ОСТАЛСЯ: его читают K5/K7 и контракт диагностики D.1.
  // Форвардеры ядра (хойстятся, вызовы выше по файлу не тронуты) — в конце этого IIFE.

  // ===== Step D.8: K5 (INGEST) вынесен в core/deepseek-ingest.js =====
  // Здесь были СЕКЦИЯ 8 целиком: ingestHistory — приёмка авторитетного сетевого снимка
  // history_messages (v6-детектор усечения цепочки с однократным тихим дозапросом,
  // v11/O-17 авторитетно пустая база и MERGE-ветка пустого кеша, v12/O-18 режим
  // экспортного дозапроса, сборка turnsMap по ходам, снимок сети и вердикт полноты) —
  // 275 строк (340-614). Тело живёт в модуле (PURE-зона заголовка и BIND-зона внутри
  // `with (D)` — см. шапку core/deepseek-ingest.js) и читает состояние ядра через
  // контракт __bind: 15 fn + 10 rw + 8 ro = 33 имени; связка — в конце этого IIFE,
  // форвардер ingestHistory (function declaration — хойстится) раздаёт тело по прежнему
  // имени. Прямых вызовов K5 в ядре не осталось вовсе: значением форвардера пользуются
  // контракты D.2 (приёмка экспортного снимка), D.3 (приёмка ответа тихого дозапроса
  // в refetchFullHistory) и D.7 (копилка XHR: история → ingest). Объявления
  // ingestMode/exportSyncTruncated — НИЖЕ: их ставит и снимает applyExportNetSnapshot
  // модуля D.2, а читает тело K5 (rw-пары D.2/D.8); при выносе var в модуль ядро
  // читало бы НЕЯВНЫЕ ГЛОБАЛЫ (урок D.5 на lastDispatchSig).
  var ingestMode = '';
  var exportSyncTruncated = false;   // v12 (O-18): снимок экспортного дозапроса оказался усечён

  // ===== Step D.9: K6 (SSE) вынесен в core/deepseek-sse.js =====
  // Здесь была СЕКЦИЯ 9 целиком (ДВЕ области: 358-1046 и 1066-1136 HEAD 6e65e73;
  // parseSSE/consumeSseResponse стояли НИЖЕ надгробия D.2 — их сдвинула вставка состояния
  // netsync, 1048-1064): сигналы модели v13, снимок/диспатч состояния живого потока O-16,
  // beginSseStream/endSseStream/resetStreamState, белый список типов и ресинк парсера из
  // сырого кольца v12/O-18, processChunk/processChunkCore, parseSSELines (постфактум и
  // инкрементально), finishSseStream, parseSSE/consumeSseResponse и мост
  // ai-cm-deepseek-stream-probe/-flush — 760 строк.
  // Тела живут в модуле (PURE-зона заголовка/module-owned состояния и BIND-зона внутри
  // `with (D)` — см. шапку core/deepseek-sse.js) и читают состояние ядра через контракт
  // __bind: 6 fn + 18 rw + 2 ro = 26 имён; связка — в конце этого IIFE, форвардеры (9 штук,
  // function declaration — хойстятся) раздают тела по прежним именам.
  // Объявления 19 var состояния ОСТАЛИСЬ в ядре (ниже, а также SSE_FRAGMENT_TYPES/
  // sseResyncRing/sseResyncCount/sseResyncBytes/sseUnknownCount/sseUnknownChars в блоке v12):
  // их читают K7 и контракты D.1/D.2/D.7/D.8 живыми аксессорами D.9 — вынос var заставил бы
  // ядро читать НЕЯВНЫЕ ГЛОБАЛЫ (урок D.5 на lastDispatchSig). sseConfigName тоже осталась:
  // её читает ro-геттер ingest-связки D.8. Одиннадцать module-owned объявлений (sseLastPath/
  // sseLastOp/sseModel/sseModelPresent/sseConversationMode/sseCurrentEvent/SSE_RESYNC_MAX_*/
  // sseResyncChars/sseUnknownParts) уехали вместе с телами — внешних ссылок у них нет.
  // finalizeRealtimeTurn (K7: turnsMap/orderCounter/emitBaseSnapshot, сайт O-22 S1172)
  // остался ЗДЕСЬ и получает тела модуля форвардерами. Модуль подключён в core/background.js
  // строго перед этим файлом (js[] одного registration, id -v11): на момент связки
  // window.AiCmDeepseekSse уже есть.
  var sseRealtimeEntryTokens = 0;
  var sseRealtimeFinalTokens = 0;
  var sseRequestMessageId = null;
  var sseResponseMessageId = null;
  var sseModelType = null;
  var sseConfigName = null;
  var sseUserPrompt = '';
  var sseParentMessageId = null;
  var sseThinkingEnabled = null;
  // v9 (O-15): фрагменты потока — ОДИН массив в порядке прихода: { type, content }.
  // Это ровно та же форма, что fragments[] в history_messages, поэтому live-текст хода
  // собирается ТЕМИ ЖЕ правилами, что и экспорт из истории: RESPONSE → ответ,
  // THINK → reasoning (секции [REASONING]/[ANSWER]), прочие типы (TIP/SEARCH/…) в текст
  // хода не идут — как и в collectTurnText/collectTurnReasoning.
  // v8 держал только sseFragmentTypes (типы) и выбрасывал content чанков
  // {p:"response/fragments", o:"APPEND", v:[{type,content}]} — отсюда потеря начала
  // каждого нового фрагмента (2 символа и «точка-паразит» в начале [ANSWER]).
  var sseFragments = [];
  var sseFragmentTypes = [];   // производная (диагностика порядка типов)
  // v10 (O-16): состояние ЖИВОГО потока. active=true от старта чтения тела ответа
  // completion до его конца; turnFinished=true, если терминальный чанк уже пришёл
  // (ход зафиксирован), но тело ответа ещё может досылать фрагменты.
  var sseStreamActive = false;
  var sseTurnFinished = false;
  // ===== v12 (O-18, фаза 2): БЕЛЫЙ СПИСОК ТИПОВ + РЕСИНХРОН ПАРСЕРА ФРАГМЕНТОВ =====
  // Имя типа фрагмента — это ВСЕГДА одно из имён протокола DeepSeek. Любая другая строка
  // (в т.ч. типоподобная «BSCRIPT»/«ION»/«URL»/«DOM» — куски текста ответа) типом НЕ является.
  // Набор собран по самому протоколу: fragments[].type в history_messages (REQUEST/RESPONSE/
  // THINK/TIP/SEARCH — см. collectTurnText/collectTurnReasoning) и в SSE-потоке completion
  // (BEGIN/… не встречаются, но TEMPLATE_RESPONSE упоминается в комментариях v8).
  var SSE_FRAGMENT_TYPES = {
    THINK: 1, RESPONSE: 1, REQUEST: 1, TIP: 1, SEARCH: 1, TEMPLATE_RESPONSE: 1
  };
  var sseResyncRing = [];
  var sseResyncCount = 0;
  var sseResyncBytes = 0;
  var sseUnknownCount = 0;   // отказов «имя типа вне белого списка» (строка или элемент массива)
  var sseUnknownChars = 0;

  function finalizeRealtimeTurn() {
    if (!sseRequestMessageId || !sseResponseMessageId) return;

    // v9 (O-15): ответ и reasoning — из ОДНОГО массива фрагментов потока, теми же
    // правилами, что и history_messages.
    var answerText = streamFragmentText('RESPONSE');
    if (!answerText) answerText = streamOtherText();   // аварийный фолбэк (незнакомый тип)
    var sseReasoning = REASONING_ENABLED ? streamFragmentText('THINK') : '';

    // O-18 (ИЗМЕРЕНИЕ): per-turn LIVE-текст (ровно тот, что уйдёт в ход) + ревизия.
    if (diagOn()) {
      if (sseRequestMessageId && sseUserPrompt) {
        diagLiveTurnRecord(String(sseRequestMessageId), 'user', sseUserPrompt, 'finalize');
      }
      diagLiveTurnRecord(String(sseResponseMessageId), 'assistant', composeTurnText(answerText, sseReasoning), 'finalize');
    }

    // v12 (O-18, фаза 2): LIVE-текст хода — в собственный кэш. Нужен потому, что приёмка
    // сетевого снимка ПЕРЕСТРАИВАЕТ turnsMap: без кэша ход, которого в сети нет (или её
    // текст хуже), было бы нечем восстановить при экспортном дозапросе.
    var liveText = composeTurnText(answerText, sseReasoning);
    liveTurnRecord(String(sseRequestMessageId), 'user', sseUserPrompt, sseUserPrompt, '', '');
    if (answerText || sseReasoning) {
      liveTurnRecord(String(sseResponseMessageId), 'assistant', liveText, answerText, sseReasoning,
        getModelSlug(sseThinkingEnabled === true, sseModelSignals()));
    }
    lastTurnDoneAt = Date.now();

    // УСЛОВИЕ 2: добавляем ОБА хода — USER и ASSISTANT
    // USER-ход
    var userId = String(sseRequestMessageId);
    if (!turnsMap[userId] && sseUserPrompt) {
      turnsMap[userId] = {
        text: sseUserPrompt,
        answer: sseUserPrompt,
        reasoning: '',
        modelSlug: '',
        order: orderCounter++,
        ts: Date.now() / 1000,
        role: 'user'
      };
    }

    // ASSISTANT-ход: модель по thinking_enabled (sseModelType не влияет на выбор).
    // v9 (O-15): ход создаётся при непустом ответе ИЛИ reasoning — v8 требовал ответ и
    // терял ход целиком, когда ответ приходил внутри чанка fragments[] («ответы 1–2
    // отсутствуют» в live-экспорте).
    var assistantId = String(sseResponseMessageId);
    if (!turnsMap[assistantId] && (answerText || sseReasoning)) {
      turnsMap[assistantId] = {
        text: composeTurnText(answerText, sseReasoning),
        answer: answerText,
        reasoning: sseReasoning,
        modelSlug: getModelSlug(sseThinkingEnabled === true, sseModelSignals()),
        order: orderCounter++,
        ts: Date.now() / 1000,
        role: 'assistant'
      };
    } else if (turnsMap[assistantId]) {
      // v10 (O-16): ход уже создан РАННИМ (промежуточным) финалом того же потока —
      // обогащаем его более полным текстом. Прежний гард `!turnsMap[assistantId]`
      // отбрасывал финальный (полный) текст, и усечённый ход оставался в memory-базе
      // навсегда — именно это и писал автоэкспорт. Merge безопасен: укорачивание
      // уже собранного невозможно (streamSetContent/streamAppendContent не укорачивают),
      // поэтому сравнение по длине монотонно.
      var ex = turnsMap[assistantId];
      var exAnswer = ex.answer || '';
      var exReasoning = ex.reasoning || '';
      var nextAnswer = (answerText && answerText.length >= exAnswer.length) ? answerText : exAnswer;
      var nextReasoning = (sseReasoning && sseReasoning.length >= exReasoning.length) ? sseReasoning : exReasoning;
      if (nextAnswer !== exAnswer || nextReasoning !== exReasoning) {
        // O-18 (ИЗМЕРЕНИЕ): «длиннее побеждает» — фиксируем факт замены текста хода,
        // её вердикт и шов (кандидат: более длинный, но ДЫРЯВЫЙ текст вытесняет полный).
        if (diagOn()) {
          var dEnr = diagVerdict(exAnswer, nextAnswer);
          diagMark('enrich-replace', {
            id: String(assistantId).slice(0, 8), prevLen: exAnswer.length, nextLen: nextAnswer.length,
            prevHash: diagHash6(exAnswer), nextHash: diagHash6(nextAnswer),
            firstDiff: dEnr.firstDiff, verdict: dEnr.verdict, lost: dEnr.lost, resync: dEnr.resync
          });
        }
        ex.answer = nextAnswer;
        ex.reasoning = nextReasoning;
        ex.text = composeTurnText(nextAnswer, nextReasoning);
      }
    }

    // Числитель = финальный accumulated_token_usage из BATCH (фолбэк — entry из первого response)
    var serverTokens = sseRealtimeFinalTokens || sseRealtimeEntryTokens || 0;

    // chatMode для realtime = sseModelType (expert/default/null)
    var chatMode = sseModelType || '';

    // O-22 (ИЗМЕРЕНИЕ-2): маркер ТОЧКИ диспатча ai-cm-full-history (site=S1172).
    try {
      if (typeof diagMark === 'function' && typeof diagOn === 'function' && diagOn()) {
        diagMark('o22-dispatch-site', {
          site: 'S1172', ts: Date.now(),
          count: Object.keys(turnsMap).length, textLen: '(вне области)'
        });
      }
    } catch (eO22s1172) { }
    var em = emitBaseSnapshot(serverTokens, chatMode);
    if (!loggedRealtime) {
      loggedRealtime = true;
      console.log('[deepseek-intercept] ✓ realtime обновление: ходов=' + em.count +
        ', serverTokens=' + serverTokens +
        (serverTokens > 0 ? ' (' + Math.round(serverTokens / MODEL_WINDOW_DEFAULT * 1000) / 10 + '%)' : '') +
        ', модель=' + (em.lastModel || '?') +
        ', modelMode=' + (chatMode || '(default)') +
        ', reasoning-ходов=' + em.reasoningTurns);   // v8 (O-7)

      // ДИАГНОСТИЧЕСКИЙ ДАМП — только при включённом флаге aiCmDebug
      if (isDebugEnabled()) {
        dumpHistorySnapshot('after_reply', 'realtime turn finalized', {
          capturePoint: 'finalizeRealtimeTurn',
          navType: '',
          sseEntry: sseRealtimeEntryTokens,
          sseFinal: sseRealtimeFinalTokens,
          modelType: sseModelType
        });
      }
    }

    // v10 (O-16): повторный финал того же потока — норма (терминальный чанк может прийти
    // до конца тела ответа, а конец тела — ещё раз закрыть ход). Буфер НЕ обнуляем:
    // досланные фрагменты обязаны долиться в тот же ход. Полный сброс — beginSseStream()
    // (старт нового потока) и resetForNewConversation() (смена чата).
    sseTurnFinished = true;
    dispatchStreamState('finalize');
  }

  // ===== Step D.2: сетевой дозапрос истории вынесен в core/deepseek-netsync.js =====
  // Здесь была СЕКЦИЯ 9C (O-18, фаза 2): liveTurnRecord, netSyncNeeded, exportComposeTurns,
  // applyExportNetSnapshot, exportNetSync и мост window 'ai-cm-deepseek-net-sync'. Тела
  // живут в модуле (BIND-зона внутри `with (D)`, см. шапку core/deepseek-netsync.js) и
  // обращаются к состоянию ядра через контракт __bind; связка — в конце этого IIFE.
  // Модуль подключён в core/background.js строго перед этим файлом (js[] одного
  // registration, id -v4): на момент связки window.AiCmDeepseekNetsync уже есть.
  // Состояние дозапроса ОСТАЛОСЬ ЗДЕСЬ: его читают и пишут оставшиеся секции
  // (resetForNewConversation — сброс на смену чата, ingestHistory — приёмка сетевого
  // снимка, finishSseStream — lastTurnDoneAt), а модуль получает ТЕ ЖЕ переменные
  // rw-парами контракта, поэтому объекты общие, а не копии.
  var liveTurns = {};          // v12: LIVE-текст ходов (SSE) — переживает приёмку сети
  var liveTurnOrder = [];
  var netSnapshotAt = 0;       // время приёмки авторитетного сетевого снимка
  var netTurnIds = {};         // какие ходы пришли ИЗ СЕТИ (последний принятый снимок)
  var lastTurnDoneAt = 0;      // время последнего завершённого хода (финализация потока)
  var netSyncStats = { calls: 0, fetched: 0, ok: 0, fresh: 0, empty: 0, failed: 0, timeout: 0, oneSide: 0 };

  // ===== Step D.3: K8 (REFETCH/URL-гигиена) вынесен в core/deepseek-refetch.js =====
  // Здесь были СЕКЦИЯ 10 (гард перекрёста chat_session_id vs currentConvId:
  // convIdFromHistoryUrl, convIdFromCompletionBody, guardCheck) и СЕКЦИЯ 10B (хелперы
  // MERGE-дозапроса: collectHeaders, stripCacheParams, historyRefetchUrl,
  // historyUrlForConv, refetchFullHistory, scheduleHistoryRefetch). Тела живут в модуле
  // (PURE-зона и BIND-зона внутри `with (D)` — см. шапку core/deepseek-refetch.js) и
  // обращаются к состоянию ядра через контракт __bind; связка — в конце этого IIFE.
  // Модуль подключён в core/background.js строго перед этим файлом (js[] одного
  // registration, id -v5): на момент связки window.AiCmDeepseekRefetch уже есть.
  // Состояние refetch-гигиены ОСТАЛОСЬ ЗДЕСЬ: lastAuthHeaders/lastHistoryUrl пишут
  // fetch-хук (K11) и XHR-копилка (K9), historyRefetchDone — детекторы усечения (K5),
  // lastLoadedConvId — приём снимка истории; модуль получает эти переменные rw/ro-парами
  // контракта и видит ТЕ ЖЕ переменные, а не копии. historyRefetchTimer переехал в модуль.
  // Форвардеры ядра (хойстятся, вызовы выше по файлу не тронуты) — в конце этого IIFE.

  // ===== Step D.7: K9 (NETWORK) вынесен в core/deepseek-net.js =====
  // Здесь были СЕКЦИЯ 11 (перехват fetch: v5-тихий catch, копилка auth-заголовков,
  // история + MERGE-дозапрос, разбор тела completion, настройки модели) и СЕКЦИЯ 12
  // (перехват XHR: зеркало fetch + setRequestHeader-копилка) — 218 строк.
  // Тела живут в модуле (PURE-зона и BIND-зона внутри `with (D)` — см. шапку
  // core/deepseek-net.js) и обращаются к состоянию ядра через контракт __bind:
  // 11 fn + 6 rw + 5 ro = 22 имени; связка — в конце этого IIFE. Форвардеров нет:
  // модуль не отдаёт ядру ни одного тела — он публикует себя САЙТУ (window.fetch и
  // OriginalXHR.prototype.open/send/setRequestHeader), а ядро лишь снабжает его
  // зависимостями. Объявления originalFetch/OriginalXHR/originalXHROpen/
  // originalXHRSend (строки 222-225) и состояние копилок (lastAuthHeaders/
  // lastHistoryUrl/lastLoadedConvId/sseUserPrompt/sseParentMessageId/
  // sseThinkingEnabled) ОСТАЛИСЬ: их читают K6/K8 и контракты D.2/D.3. Модуль
  // подключён в core/background.js строго перед этим файлом (js[] одного
  // registration, id -v9), а связка стоит ПОСЛЕ захвата originalFetch — иначе
  // обёртка fetch замкнулась бы сама на себя.


  // ===== СЕКЦИЯ 14: ФИНАЛ =====
  console.log('[deepseek-intercept] перехватчик DeepSeek v11 установлен (server-first, walk parent_id, SSE инкрементально И постфактум, USER+ASSISTANT оба хода, ход = user + assistant(reasoning+answer), фрагменты потока как fragments[] истории (без потери контента чанков), терминал хода по BATCH/close/концу тела, historyComplete по reachedRoot ИЛИ авторитетно пустой базе (O-17: единый критерий для первичной загрузки и тихого дозапроса после SPA-смены чата), turnsMap сбрасывается только принятым снимком (O-17), serverTokens из accumulated_token_usage, +self-fetch при MERGE, +per-turn model по thinking_enabled, +modelMode в detail, +timer-refetch on switch, +подавление чужих unhandled fetch, +детектор усечения цепочки с дозапросом, +convId в detail, +unknown-роль без маппинга, +reasoning THINK секциями [REASONING]/[ANSWER], +O-16 живой поток не замораживает ход: повторный финал обогащает текст, probe/flush-мост для экспортёра, +O-17 мост turnsMap для дампов экспорта, +O-18 белый список типов фрагментов с ресинком из сырого кольца (контент больше не становится «типом»), +O-18 сетевой дозапрос history_messages в момент экспорта с per-turn выбором live/сеть)');

  // Экспорт для ручного вызова диагностического дампа
  try {
    if (!window.__aiCmDebug) window.__aiCmDebug = {};
    window.__aiCmDebug.dumpDeepSeekHistory = function (state) {
      if (!isDebugEnabled()) return;
      if (!state) {
        var ds = determineState();
        state = ds.state;
        var reason = 'manual:' + state + ' (nav=' + (ds.navType || 'unknown') + ', convId=' + (currentConvId || '').slice(0, 8) + ')';
      } else {
        reason = 'manual:' + state;
      }
      dumpHistorySnapshot(state, reason, {
        capturePoint: 'manual_call',
        navType: getNavigationType()
      });
    };
  } catch (e) { }
  // ===== Step D.1: кластер диагностики вынесен в core/deepseek-diag.js =====
  // Здесь были СЕКЦИИ 13/13D/13B: диагностический дамп снапшота (isDebugEnabled /
  // getNavigationType / determineState / dumpHistorySnapshot с маркерами o22-dispatch),
  // вербатим-дамп usage по ходам при загрузке истории (O-26) и измерение live vs network
  // с кольцами сырья (O-18: diagSseRing/diagHistRing/diagMarks/diagLiveTurns/diagNetTurns).
  // Тела живут в модуле (PURE-зона и with (D)-зона — см. шапку core/deepseek-diag.js).
  // Модуль подключён в core/background.js ПЕРЕД этим файлом (js[] одного registration,
  // id -v3), на момент связки window.AiCmDeepseekDiag уже есть; no-op заглушек здесь нет
  // намеренно — registration атомарный, а песочницы тестов получают конкатенацию через
  // tests/helpers/deepseek-intercept-source.js.
  var lastDiagConvId = currentConvId;   // O-18: кольца живут в пределах одного convId
  var aiCmDeepseekDiag = (typeof window !== 'undefined' && window.AiCmDeepseekDiag) || null;
  if (aiCmDeepseekDiag) {
    aiCmDeepseekDiag.__bind({
      // fn: функции ядра, которые зовут тела модуля — передаются значением.
      collectTurnText: collectTurnText,
      collectTurnReasoning: collectTurnReasoning,
      netSyncNeeded: netSyncNeeded,
      streamKnownType: streamKnownType,
      // rw: живое состояние, которое модуль ПЕРЕЗАПИСЫВАЕТ (get + set).
      // sseFragments/sseFragmentTypes — seed-мост O-18 (seedDeepSeekFragmentsO18) подменяет
      // буфер фрагментов: ядро обязано видеть ТОТ ЖЕ буфер, а не копию.
      get sseFragments() { return sseFragments; },
      set sseFragments(v) { sseFragments = v; },
      get sseFragmentTypes() { return sseFragmentTypes; },
      set sseFragmentTypes(v) { sseFragmentTypes = v; },
      // lastDiagConvId — переменная ЯДРА: resetForNewConversation читает её как prevConv и
      // перезаписывает текущим convId после сброса колец модуля.
      get lastDiagConvId() { return lastDiagConvId; },
      set lastDiagConvId(v) { lastDiagConvId = v; },
      // ro: только чтение — модуль эти имена не перезаписывает (мутации объектов по
      // ссылке — turnsMap, histCompletion, netSyncStats — видны ядру и без сеттера).
      get turnsMap() { return turnsMap; },
      get currentConvId() { return currentConvId; },
      get histCompletion() { return histCompletion; },
      get historyRefetchDone() { return historyRefetchDone; },
      get lastHistoryUrl() { return lastHistoryUrl; },
      get loggedHistory() { return loggedHistory; },
      get loggedRealtime() { return loggedRealtime; },
      get REASONING_ENABLED() { return REASONING_ENABLED; },
      get liveTurnOrder() { return liveTurnOrder; },
      get netTurnIds() { return netTurnIds; },
      get netSnapshotAt() { return netSnapshotAt; },
      get lastTurnDoneAt() { return lastTurnDoneAt; },
      get netSyncStats() { return netSyncStats; },
      get sseStreamActive() { return sseStreamActive; },
      get sseTurnFinished() { return sseTurnFinished; },
      get sseRequestMessageId() { return sseRequestMessageId; },
      get sseResponseMessageId() { return sseResponseMessageId; },
      get sseResyncRing() { return sseResyncRing; },
      get sseResyncCount() { return sseResyncCount; },
      get sseResyncBytes() { return sseResyncBytes; },
      get sseUnknownCount() { return sseUnknownCount; },
      get sseUnknownChars() { return sseUnknownChars; },
      get SSE_FRAGMENT_TYPES() { return SSE_FRAGMENT_TYPES; }
    });
  }
  // Ядро продолжает вызывать диагностику по ПРЕЖНИМ именам (o22-гарды
  // typeof diagMark === 'function' и прямые вызовы маркеров в горячих путях).
  // Форвардеры — ИМЕННО function declaration: хойстятся, поэтому вызовы в любом месте
  // ядра (emitBaseSnapshot/ingestHistory/processChunk выше по файлу) видят имя, а тело
  // живёт в модуле. Набор — ровно те 16 функций, что зовёт ядро; остальные 10 тел
  // модуля (normalizeRole, buildMessagesFromTurnsMap, collectUsageFieldsVerbatim,
  // fragContentLength, diagClip, diagPushRing, diagStat, diagFirstDiff, diagDumpRings,
  // buildMessagesFromRaw) ядру не нужны и наружу не выдаются.
  function isDebugEnabled() { return aiCmDeepseekDiag.isDebugEnabled(); }
  function getNavigationType() { return aiCmDeepseekDiag.getNavigationType(); }
  function determineState() { return aiCmDeepseekDiag.determineState(); }
  function dumpTurnUsageAtHistoryLoad(chain, chatMessages, chatSession) { aiCmDeepseekDiag.dumpTurnUsageAtHistoryLoad(chain, chatMessages, chatSession); }
  function dumpHistorySnapshot(state, stateReason, ctx) { aiCmDeepseekDiag.dumpHistorySnapshot(state, stateReason, ctx); }
  function diagOn() { return aiCmDeepseekDiag.diagOn(); }
  function diagHash6(s) { return aiCmDeepseekDiag.diagHash6(s); }
  function diagVerdict(lt, nt) { return aiCmDeepseekDiag.diagVerdict(lt, nt); }
  function diagFragState() { return aiCmDeepseekDiag.diagFragState(); }
  function diagMark(kind, data) { aiCmDeepseekDiag.diagMark(kind, data); }
  function diagChunkRecord(path, op, val, before, after) { aiCmDeepseekDiag.diagChunkRecord(path, op, val, before, after); }
  function diagHistRecord(json, src) { aiCmDeepseekDiag.diagHistRecord(json, src); }
  function diagSnapshotNetTurns(reason) { aiCmDeepseekDiag.diagSnapshotNetTurns(reason); }
  function diagLiveTurnRecord(id, role, text, reason) { aiCmDeepseekDiag.diagLiveTurnRecord(id, role, text, reason); }
  function diagExportHook(trigger) { aiCmDeepseekDiag.diagExportHook(trigger); }
  function diagResetForConv(reason, prevConv) { aiCmDeepseekDiag.diagResetForConv(reason, prevConv); }

  // ===== Step D.2: связка модуля сетевого дозапроса (core/deepseek-netsync.js) =====
  // Контракт: 8 fn (форвардеры диагностики D.1 и функции ядра — значением), 9 rw
  // (состояние дозапроса + orderCounter/ingestMode/exportSyncTruncated — тела их
  // перезаписывают) и 9 ro. Живое состояние отдаётся аксессорами, поэтому модуль и
  // ядро работают с ОДНИМИ И ТЕМИ ЖЕ переменными IIFE, а не с копиями значений.
  var aiCmDeepseekNetsync = (typeof window !== 'undefined' && window.AiCmDeepseekNetsync) || null;
  if (aiCmDeepseekNetsync) {
    aiCmDeepseekNetsync.__bind({
      // fn: функции ядра, которые зовут тела модуля — передаются значением.
      diagMark: diagMark,
      diagOn: diagOn,
      diagHistRecord: diagHistRecord,
      diagVerdict: diagVerdict,
      emitBaseSnapshot: emitBaseSnapshot,
      ingestHistory: ingestHistory,
      historyRefetchUrl: historyRefetchUrl,
      getConvId: getConvId,
      // rw: живое состояние сетевого дозапроса. liveTurns/liveTurnOrder/netSnapshotAt/
      // netTurnIds/lastTurnDoneAt/netSyncStats пишут и оставшиеся секции ядра
      // (resetForNewConversation, ingestHistory, finishSseStream) — модуль обязан
      // видеть ТЕ ЖЕ объекты. orderCounter — порядок хода в файле (`orderCounter++`
      // в exportComposeTurns); ingestMode/exportSyncTruncated — режим экспортного
      // ingest, который ставит и снимает applyExportNetSnapshot. Без сеттеров эти
      // три записи молча терялись бы (sloppy): порядок ходов в файле замер бы.
      get liveTurns() { return liveTurns; },
      set liveTurns(v) { liveTurns = v; },
      get liveTurnOrder() { return liveTurnOrder; },
      set liveTurnOrder(v) { liveTurnOrder = v; },
      get netSnapshotAt() { return netSnapshotAt; },
      set netSnapshotAt(v) { netSnapshotAt = v; },
      get netTurnIds() { return netTurnIds; },
      set netTurnIds(v) { netTurnIds = v; },
      get lastTurnDoneAt() { return lastTurnDoneAt; },
      set lastTurnDoneAt(v) { lastTurnDoneAt = v; },
      get netSyncStats() { return netSyncStats; },
      set netSyncStats(v) { netSyncStats = v; },
      get orderCounter() { return orderCounter; },
      set orderCounter(v) { orderCounter = v; },
      get ingestMode() { return ingestMode; },
      set ingestMode(v) { ingestMode = v; },
      get exportSyncTruncated() { return exportSyncTruncated; },
      set exportSyncTruncated(v) { exportSyncTruncated = v; },
      // ro: только чтение — модуль эти имена не перезаписывает (мутации объектов по
      // ссылке — turnsMap, histCompletion, lastAuthHeaders — видны ядру и без сеттера).
      get currentConvId() { return currentConvId; },
      get turnsMap() { return turnsMap; },
      get histCompletion() { return histCompletion; },
      get lastAuthHeaders() { return lastAuthHeaders; },
      get lastBaseServerTokens() { return lastBaseServerTokens; },
      get sseRealtimeFinalTokens() { return sseRealtimeFinalTokens; },
      get sseModelType() { return sseModelType; },
      get lastBaseChatMode() { return lastBaseChatMode; },
      get originalFetch() { return originalFetch; }
    });
  }
  // Ядро продолжает звать сетевой дозапрос по ПРЕЖНИМ именам: liveTurnRecord — на
  // каждой финализации потока (finishSseStream), netSyncNeeded — из связки
  // диагностики выше. Форвардеры — ИМЕННО function declaration: хойстятся, поэтому
  // вызовы выше по файлу видят имя. Заглушек нет намеренно: js[] регистрируется
  // атомарно, а песочницы тестов получают конкатенацию через хелпер deepseek-source.
  function liveTurnRecord(id, role, text, answer, reasoning, modelSlug) { return aiCmDeepseekNetsync.liveTurnRecord(id, role, text, answer, reasoning, modelSlug); }
  function netSyncNeeded() { return aiCmDeepseekNetsync.netSyncNeeded(); }

  // ===== Step D.3: связка модуля REFETCH/URL-гигиены (core/deepseek-refetch.js) =====
  // Контракт: 2 fn (функции ядра, которые зовут тела модуля — значением), 3 rw
  // (состояние refetch-гигиены: его пишут и ядро, и модуль — get+set обязателен) и
  // 3 ro. Живое состояние отдаётся аксессорами, поэтому модуль и ядро работают с
  // ОДНИМИ И ТЕМИ ЖЕ переменными IIFE, а не с копиями значений.
  var aiCmDeepseekRefetch = (typeof window !== 'undefined' && window.AiCmDeepseekRefetch) || null;
  if (aiCmDeepseekRefetch) {
    aiCmDeepseekRefetch.__bind({
      // fn: функции ядра, которые зовут тела модуля — передаются значением.
      diagMark: diagMark,
      ingestHistory: ingestHistory,
      // rw: состояние refetch-гигиены. lastAuthHeaders пишут fetch-хук (K11) и XHR-копилка
      // (K9); lastHistoryUrl — fetch-хук (K11), XHR-копилка (K9) и сброс чата (K5);
      // historyRefetchDone — сброс чата и детекторы усечения (K5). Сеттеры обязательны:
      // владелец семантики — модуль.
      get lastAuthHeaders() { return lastAuthHeaders; },
      set lastAuthHeaders(v) { lastAuthHeaders = v; },
      get lastHistoryUrl() { return lastHistoryUrl; },
      set lastHistoryUrl(v) { lastHistoryUrl = v; },
      get historyRefetchDone() { return historyRefetchDone; },
      set historyRefetchDone(v) { historyRefetchDone = v; },
      // ro: только чтение — модуль эти имена не перезаписывает.
      get currentConvId() { return currentConvId; },
      get lastLoadedConvId() { return lastLoadedConvId; },
      get originalFetch() { return originalFetch; }
    });
  }
  // Ядро продолжает звать REFETCH-хелперы по ПРЕЖНИМ именам (перехватчики fetch/XHR —
  // K9/K11, ingestHistory, resetForNewConversation). Форвардеры — ИМЕННО function
  // declaration: хойстятся, поэтому вызовы выше по файлу видят имя. Контракт — 7 из 9
  // тел: stripCacheParams и historyUrlForConv ядру не нужны (их зовут только тела
  // модуля). Заглушек нет намеренно: js[] регистрируется атомарно, а песочницы тестов
  // получают конкатенацию через tests/helpers/deepseek-intercept-source.js.
  function convIdFromHistoryUrl(url) { return aiCmDeepseekRefetch.convIdFromHistoryUrl(url); }
  function convIdFromCompletionBody(bodyStr) { return aiCmDeepseekRefetch.convIdFromCompletionBody(bodyStr); }
  function guardCheck(reqConvId) { return aiCmDeepseekRefetch.guardCheck(reqConvId); }
  function collectHeaders(input, init) { return aiCmDeepseekRefetch.collectHeaders(input, init); }
  function historyRefetchUrl() { return aiCmDeepseekRefetch.historyRefetchUrl(); }
  function refetchFullHistory(originalUrl, authHeaders, convId) { return aiCmDeepseekRefetch.refetchFullHistory(originalUrl, authHeaders, convId); }
  function scheduleHistoryRefetch() { return aiCmDeepseekRefetch.scheduleHistoryRefetch(); }

  // ===== Step D.4: связка модуля цепочки/текста хода (core/deepseek-parse.js) =====
  // Контракт: 2 ro-геттера — имена ядра, которые читают тела модуля
  // (REASONING_ENABLED — гейт v8 (O-7) в composeTurnText; __aiCmDeepseekResolveModelSlug —
  // K0, чистый резолвер slug по сетевым сигналам, объявлен ВНЕ этого IIFE). fn-передач и
  // rw-пар нет: состояние кластера модуль не ведёт вовсе (K3/K4 — чистые функции), а
  // REASONING_TAG/ANSWER_TAG/DS_PP_VISIBLE_MARKER уехали в модуль вместе с телами.
  // Живые имена отдаются геттерами, поэтому модуль и ядро работают с ОДНИМИ И ТЕМИ ЖЕ
  // переменными IIFE, а не с копиями значений.
  var aiCmDeepseekParse = (typeof window !== 'undefined' && window.AiCmDeepseekParse) || null;
  if (aiCmDeepseekParse) {
    aiCmDeepseekParse.__bind({
      // ro: только чтение — модуль эти имена не перезаписывает.
      get REASONING_ENABLED() { return REASONING_ENABLED; },
      get __aiCmDeepseekResolveModelSlug() { return __aiCmDeepseekResolveModelSlug; }
    });
  }
  // Ядро продолжает звать K3/K4 по ПРЕЖНИМ именам (hidden-пометки базы и композиция
  // ходов в ingestHistory, сборка текста хода в SSE-финализации, slug модели хода).
  // Форвардеры — ИМЕННО function declaration: хойстятся, поэтому вызовы в любом месте
  // ядра выше по файлу видят имя, а тело живёт в модуле. Контракт — все 6 тел кластера;
  // константы тегов ядру больше не нужны. Заглушек нет намеренно: js[] регистрируется
  // атомарно, а песочницы тестов получают конкатенацию через
  // tests/helpers/deepseek-intercept-source.js.
  function buildActiveChain(chatSession, messagesById) { return aiCmDeepseekParse.buildActiveChain(chatSession, messagesById); }
  function collectTurnText(fragments, role) { return aiCmDeepseekParse.collectTurnText(fragments, role); }
  function collectTurnReasoning(fragments, role) { return aiCmDeepseekParse.collectTurnReasoning(fragments, role); }
  function composeTurnText(answer, reasoning) { return aiCmDeepseekParse.composeTurnText(answer, reasoning); }
  function hasInjectedUserPrompt(text) { return aiCmDeepseekParse.hasInjectedUserPrompt(text); }
  function getModelSlug(thinkingEnabled, signals) { return aiCmDeepseekParse.getModelSlug(thinkingEnabled, signals); }

  // ===== Step D.5: связка модуля CONV ID (core/deepseek-conv.js) =====
  // Контракт: 3 fn (diagResetForConv, resetStreamState, scheduleHistoryRefetch) + 19 rw
  // (состояние, которое тело сброса ПЕРЕЗАПИСЫВАЕТ: без сеттера запись в sloppy-
  // режиме молча терялась бы, и сброс на смену чата перестал бы работать) + 1 ro
  // (histCompletion: тело мутирует ПОЛЯ объекта, а не переприсваивает имя — мутация
  // по ссылке видна ядру без сеттера). Итого 23 имени контракта: 3 fn + 19 rw + 1 ro.
  if (aiCmDeepseekConv) {
    aiCmDeepseekConv.__bind({
      // fn: функции ядра, которые зовут тела модуля — передаются значением.
      diagResetForConv: diagResetForConv,
      resetStreamState: resetStreamState,
      scheduleHistoryRefetch: scheduleHistoryRefetch,
      // rw: живое состояние, которое модуль ПЕРЕЗАПИСЫВАЕТ (get + set).
      get currentConvId() { return currentConvId; },
      set currentConvId(v) { currentConvId = v; },
      get lastDiagConvId() { return lastDiagConvId; },
      set lastDiagConvId(v) { lastDiagConvId = v; },
      get turnsMap() { return turnsMap; },
      set turnsMap(v) { turnsMap = v; },
      get orderCounter() { return orderCounter; },
      set orderCounter(v) { orderCounter = v; },
      get attachTokens() { return attachTokens; },
      set attachTokens(v) { attachTokens = v; },
      get attachBreak() { return attachBreak; },
      set attachBreak(v) { attachBreak = v; },
      get loggedOk() { return loggedOk; },
      set loggedOk(v) { loggedOk = v; },
      get loggedHistory() { return loggedHistory; },
      set loggedHistory(v) { loggedHistory = v; },
      get loggedRealtime() { return loggedRealtime; },
      set loggedRealtime(v) { loggedRealtime = v; },
      get lastLoadedConvId() { return lastLoadedConvId; },
      set lastLoadedConvId(v) { lastLoadedConvId = v; },
      get lastHistoryUrl() { return lastHistoryUrl; },
      set lastHistoryUrl(v) { lastHistoryUrl = v; },
      get historyRefetchDone() { return historyRefetchDone; },
      set historyRefetchDone(v) { historyRefetchDone = v; },
      get lastBaseServerTokens() { return lastBaseServerTokens; },
      set lastBaseServerTokens(v) { lastBaseServerTokens = v; },
      get lastBaseChatMode() { return lastBaseChatMode; },
      set lastBaseChatMode(v) { lastBaseChatMode = v; },
      get liveTurns() { return liveTurns; },
      set liveTurns(v) { liveTurns = v; },
      get liveTurnOrder() { return liveTurnOrder; },
      set liveTurnOrder(v) { liveTurnOrder = v; },
      get netSnapshotAt() { return netSnapshotAt; },
      set netSnapshotAt(v) { netSnapshotAt = v; },
      get netTurnIds() { return netTurnIds; },
      set netTurnIds(v) { netTurnIds = v; },
      get lastTurnDoneAt() { return lastTurnDoneAt; },
      set lastTurnDoneAt(v) { lastTurnDoneAt = v; },
      // ro: только чтение — модуль эти имена не перезаписывает.
      get histCompletion() { return histCompletion; }
    });
  }
  // Ядро продолжает звать K1 по ПРЕЖНИМ именам (emit-композиция, guard-хуки K9/K11,
  // сброс чата из ingestHistory). Форвардеры — ИМЕННО function declaration: хойстятся,
  // поэтому вызовы в любом месте ядра выше по файлу видят имя, а тело живёт в модуле.
  // checkConvChange наружу не выдаётся: его зовут только патчи pushState/replaceState и
  // popstate-слушатель самого модуля. Гард `aiCmDeepseekConv &&` — не заглушка, а требование
  // стандарта: ядро грузится и БЕЗ модуля (контрактные тесты K0/слагов, одиночный require),
  // и обёртка не имеет права бросать на загрузке. В браузере js[] регистрируется атомарно,
  // и песочницы тестов получают конкатенацию через tests/helpers/deepseek-intercept-source.js.
  function getConvId() { return (aiCmDeepseekConv && aiCmDeepseekConv.getConvId()) || ''; }
  function resetForNewConversation() { if (aiCmDeepseekConv) return aiCmDeepseekConv.resetForNewConversation(); }

  // ===== Step D.6: связка модуля EMIT (core/deepseek-emit.js) =====
  // Контракт: 7 fn (функции ядра, которые зовут тела модуля — передаются значением:
  // форвардеры D.1 diagHash6/diagMark/diagOn/diagExportHook/isDebugEnabled, форвардер
  // D.5 getConvId и форвардер D.4 hasInjectedUserPrompt; все — function declaration,
  // хойстятся), 4 rw (состояние emit-гарда O-22: его ПЕРЕЗАПИСЫВАЕТ тело
  // emitBaseSnapshot — без сеттера запись в sloppy-режиме молча терялась бы, и гард
  // повторного диспатча перестал бы глушить одинаковые снимки) и 5 ro (turnsMap/
  // attachTokens/attachBreak/histCompletion/currentConvId: модуль их только читает,
  // а поля histCompletion и записи turnsMap мутируются по ссылке). Итого 16 имён
  // контракта: 7 fn + 4 rw + 5 ro.
  var aiCmDeepseekEmit = (typeof window !== 'undefined' && window.AiCmDeepseekEmit) || null;
  if (aiCmDeepseekEmit) {
    aiCmDeepseekEmit.__bind({
      // fn: функции ядра, которые зовут тела модуля — передаются значением.
      diagHash6: diagHash6,
      diagMark: diagMark,
      diagOn: diagOn,
      diagExportHook: diagExportHook,
      isDebugEnabled: isDebugEnabled,
      getConvId: getConvId,
      hasInjectedUserPrompt: hasInjectedUserPrompt,
      // rw: живое состояние emit-гарда, которое модуль ПЕРЕЗАПИСЫВАЕТ (get + set).
      get lastBaseServerTokens() { return lastBaseServerTokens; },
      set lastBaseServerTokens(v) { lastBaseServerTokens = v; },
      get lastBaseChatMode() { return lastBaseChatMode; },
      set lastBaseChatMode(v) { lastBaseChatMode = v; },
      get lastDispatchSig() { return lastDispatchSig; },
      set lastDispatchSig(v) { lastDispatchSig = v; },
      get lastDispatchResult() { return lastDispatchResult; },
      set lastDispatchResult(v) { lastDispatchResult = v; },
      // ro: только чтение — модуль эти имена не перезаписывает.
      get turnsMap() { return turnsMap; },
      get attachTokens() { return attachTokens; },
      get attachBreak() { return attachBreak; },
      get histCompletion() { return histCompletion; },
      get currentConvId() { return currentConvId; }
    });
  }
  // Ядро продолжает звать EMIT по ПРЕЖНЕМУ имени (K5 ingest при ре-эмите полноты 0→1,
  // realtime-финалы K6/K7 и fn-передача в контракт D.2). Форвардер — ИМЕННО function
  // declaration: хойстится, поэтому вызовы выше по файлу видят имя, а тело живёт
  // в модуле. Остальные три тела кластера (buildDispatchSignature/clipTurnText/
  // turnsSnapshot) наружу не выдаются: их зовут только тела модуля. Заглушек нет
  // намеренно: js[] регистрируется атомарно, а песочницы тестов получают конкатенацию
  // через tests/helpers/deepseek-intercept-source.js.
  function emitBaseSnapshot(serverTokens, chatMode) { return aiCmDeepseekEmit.emitBaseSnapshot(serverTokens, chatMode); }

  // ===== Step D.7: связка модуля NETWORK (core/deepseek-net.js) =====
  // Контракт: 11 fn (функции ядра, которые зовут тела модуля — передаются значением:
  // форвардеры D.1 diagOn/diagHistRecord, форвардеры D.3 collectHeaders/
  // convIdFromHistoryUrl/convIdFromCompletionBody/guardCheck/refetchFullHistory и тела
  // ядра ingestHistory (K5), parseSSE/consumeSseResponse/ingestModelSettings (K6, СЕКЦИЯ 9);
  // все — function declaration, хойстятся), 6 rw (копилки и параметры потока, которые
  // тела K9 ПЕРЕЗАПИСЫВАЮТ: без сеттера запись в sloppy-режиме молча терялась бы, и
  // копилка авторизации/URL, признак «ответ текущего чата обработан» и параметры
  // нового потока остались бы прежними) и 5 ro (originalFetch/OriginalXHR/
  // originalXHROpen/originalXHRSend/currentConvId: модуль их только читает, мутация
  // прототипа XHR идёт по ссылке). Итого 22 имени контракта: 11 fn + 6 rw + 5 ro.
  // Связка — ПОСЛЕДНЯЯ и стоит после захвата originalFetch (строка 222): иначе обёртка
  // fetch замкнулась бы сама на себя. Форвардеров у D.7 нет: ядро тела кластера не зовёт.
  var aiCmDeepseekNet = (typeof window !== 'undefined' && window.AiCmDeepseekNet) || null;
  if (aiCmDeepseekNet) {
    aiCmDeepseekNet.__bind({
      // fn: функции ядра, которые зовут тела модуля — передаются значением.
      collectHeaders: collectHeaders,
      convIdFromHistoryUrl: convIdFromHistoryUrl,
      convIdFromCompletionBody: convIdFromCompletionBody,
      guardCheck: guardCheck,
      refetchFullHistory: refetchFullHistory,
      diagOn: diagOn,
      diagHistRecord: diagHistRecord,
      ingestHistory: ingestHistory,
      parseSSE: parseSSE,
      consumeSseResponse: consumeSseResponse,
      ingestModelSettings: ingestModelSettings,
      // rw: живое состояние копилок и потока, которое модуль ПЕРЕЗАПИСЫВАЕТ (get + set).
      get lastAuthHeaders() { return lastAuthHeaders; },
      set lastAuthHeaders(v) { lastAuthHeaders = v; },
      get lastHistoryUrl() { return lastHistoryUrl; },
      set lastHistoryUrl(v) { lastHistoryUrl = v; },
      get lastLoadedConvId() { return lastLoadedConvId; },
      set lastLoadedConvId(v) { lastLoadedConvId = v; },
      get sseUserPrompt() { return sseUserPrompt; },
      set sseUserPrompt(v) { sseUserPrompt = v; },
      get sseParentMessageId() { return sseParentMessageId; },
      set sseParentMessageId(v) { sseParentMessageId = v; },
      get sseThinkingEnabled() { return sseThinkingEnabled; },
      set sseThinkingEnabled(v) { sseThinkingEnabled = v; },
      // ro: только чтение — модуль эти имена не перезаписывает.
      get originalFetch() { return originalFetch; },
      get OriginalXHR() { return OriginalXHR; },
      get originalXHROpen() { return originalXHROpen; },
      get originalXHRSend() { return originalXHRSend; },
      get currentConvId() { return currentConvId; }
    });
  }

  // ===== Step D.8: связка модуля INGEST (core/deepseek-ingest.js) =====
  // Контракт: 15 fn (функции ядра, которые зовёт тело модуля — передаются значением:
  // форвардеры D.1 diagOn/diagMark/diagHistRecord/diagSnapshotNetTurns/isDebugEnabled/
  // determineState/dumpHistorySnapshot/dumpTurnUsageAtHistoryLoad, форвардер D.3
  // refetchFullHistory, форвардеры D.4 buildActiveChain/collectTurnText/
  // collectTurnReasoning/composeTurnText/getModelSlug и форвардер D.6 emitBaseSnapshot;
  // все — function declaration, хойстятся), 10 rw (состояние кластера, которое тело
  // ПЕРЕЗАПИСЫВАЕТ: turnsMap/orderCounter/histCompletion/netSnapshotAt/netTurnIds/
  // loggedHistory/lastLoadedConvId/historyRefetchDone, плюс режим экспортного ingest
  // ingestMode/exportSyncTruncated, которым владеет ещё и контракт D.2; без сеттера
  // запись в sloppy-режиме молча терялась бы — база не пересобиралась бы, вердикт
  // полноты не поднимался бы, а экспорт принял бы усечённый снимок за авторитетный)
  // и 8 ro (currentConvId/lastHistoryUrl/lastAuthHeaders/sseConfigName/REASONING_ENABLED/
  // MODEL_WINDOW_DEFAULT/lastBaseServerTokens/lastBaseChatMode: тело их только читает,
  // мутации объектов turnsMap/netTurnIds/histCompletion идут по ссылке). Итого 33 имени.
  var aiCmDeepseekIngest = (typeof window !== 'undefined' && window.AiCmDeepseekIngest) || null;
  if (aiCmDeepseekIngest) {
    aiCmDeepseekIngest.__bind({
      // fn: функции ядра, которые зовёт тело модуля — передаются значением.
      diagOn: diagOn,
      diagMark: diagMark,
      diagHistRecord: diagHistRecord,
      diagSnapshotNetTurns: diagSnapshotNetTurns,
      isDebugEnabled: isDebugEnabled,
      determineState: determineState,
      dumpHistorySnapshot: dumpHistorySnapshot,
      dumpTurnUsageAtHistoryLoad: dumpTurnUsageAtHistoryLoad,
      refetchFullHistory: refetchFullHistory,
      buildActiveChain: buildActiveChain,
      collectTurnText: collectTurnText,
      collectTurnReasoning: collectTurnReasoning,
      composeTurnText: composeTurnText,
      getModelSlug: getModelSlug,
      emitBaseSnapshot: emitBaseSnapshot,
      // rw: живое состояние кластера, которое тело ПЕРЕЗАПИСЫВАЕТ (get + set).
      get turnsMap() { return turnsMap; },
      set turnsMap(v) { turnsMap = v; },
      get orderCounter() { return orderCounter; },
      set orderCounter(v) { orderCounter = v; },
      get histCompletion() { return histCompletion; },
      set histCompletion(v) { histCompletion = v; },
      get netSnapshotAt() { return netSnapshotAt; },
      set netSnapshotAt(v) { netSnapshotAt = v; },
      get netTurnIds() { return netTurnIds; },
      set netTurnIds(v) { netTurnIds = v; },
      get loggedHistory() { return loggedHistory; },
      set loggedHistory(v) { loggedHistory = v; },
      get lastLoadedConvId() { return lastLoadedConvId; },
      set lastLoadedConvId(v) { lastLoadedConvId = v; },
      get historyRefetchDone() { return historyRefetchDone; },
      set historyRefetchDone(v) { historyRefetchDone = v; },
      get ingestMode() { return ingestMode; },
      set ingestMode(v) { ingestMode = v; },
      get exportSyncTruncated() { return exportSyncTruncated; },
      set exportSyncTruncated(v) { exportSyncTruncated = v; },
      // ro: только чтение — тело K5 эти имена не перезаписывает.
      get currentConvId() { return currentConvId; },
      get lastHistoryUrl() { return lastHistoryUrl; },
      get lastAuthHeaders() { return lastAuthHeaders; },
      get sseConfigName() { return sseConfigName; },
      get REASONING_ENABLED() { return REASONING_ENABLED; },
      get MODEL_WINDOW_DEFAULT() { return MODEL_WINDOW_DEFAULT; },
      get lastBaseServerTokens() { return lastBaseServerTokens; },
      get lastBaseChatMode() { return lastBaseChatMode; }
    });
  }
  // Ядро продолжает звать K5 по ПРЕЖНЕМУ имени: форвардер раздаёт тело контрактам D.2
  // (приёмка сетевого снимка в момент экспорта), D.3 (приёмка ответа тихого дозапроса
  // в refetchFullHistory) и D.7 (копилка XHR: история → ingest). Форвардер — ИМЕННО
  // function declaration: хойстится, поэтому fn-передачи ВЫШЕ по файлу (D.2/D.3/D.7)
  // видят значение. Гард `if (aiCmDeepseekIngest)` — не заглушка, а требование
  // стандарта: ядро грузится и БЕЗ модуля (контрактные тесты K0/слагов, одиночный
  // require), и обёртка не имеет права бросать на загрузке; невалидный ответ и отсутствие
  // модуля дают undefined одинаково (все выходы тела — голый `return;`). Заглушек нет
  // намеренно: js[] регистрируется атомарно, а песочницы тестов получают конкатенацию
  // через tests/helpers/deepseek-intercept-source.js.
  function ingestHistory(jsonBody) { if (aiCmDeepseekIngest) return aiCmDeepseekIngest.ingestHistory(jsonBody); }

  // ===== Step D.9: связка модуля SSE (core/deepseek-sse.js) =====
  // Контракт: 6 fn (функции ядра, которые зовут тела модуля — передаются значением:
  // форвардеры D.1 diagOn/diagMark/diagFragState/diagChunkRecord, форвардер D.5 getConvId
  // и тело K7 finalizeRealtimeTurn — оно ОСТАЛОСЬ в ядре, пишет turnsMap и зовёт
  // emitBaseSnapshot), 18 rw (состояние потока, которое тела K6 ПЕРЕЗАПИСЫВАЮТ: без
  // сеттера запись в sloppy-режиме молча терялась бы — буфер фрагментов не наполнялся бы,
  // сброс потока не чистил бы копилки, а USER-ход live-ответа терялся бы на старте
  // следующего потока) и 2 ro (SSE_FRAGMENT_TYPES и currentConvId: тела только читают).
  // Итого 26 имён. Живое состояние отдаётся аксессорами, поэтому модуль и ядро работают с
  // ОДНИМИ И ТЕМИ ЖЕ переменными IIFE, а не с копиями значений.
  var aiCmDeepseekSse = (typeof window !== 'undefined' && window.AiCmDeepseekSse) || null;
  if (aiCmDeepseekSse) {
    aiCmDeepseekSse.__bind({
      // fn: функции ядра, которые зовут тела модуля — передаются значением.
      diagOn: diagOn,
      diagMark: diagMark,
      diagFragState: diagFragState,
      diagChunkRecord: diagChunkRecord,
      getConvId: getConvId,
      finalizeRealtimeTurn: finalizeRealtimeTurn,
      get sseRealtimeEntryTokens() { return sseRealtimeEntryTokens; },
      set sseRealtimeEntryTokens(v) { sseRealtimeEntryTokens = v; },
      get sseRealtimeFinalTokens() { return sseRealtimeFinalTokens; },
      set sseRealtimeFinalTokens(v) { sseRealtimeFinalTokens = v; },
      get sseRequestMessageId() { return sseRequestMessageId; },
      set sseRequestMessageId(v) { sseRequestMessageId = v; },
      get sseResponseMessageId() { return sseResponseMessageId; },
      set sseResponseMessageId(v) { sseResponseMessageId = v; },
      get sseModelType() { return sseModelType; },
      set sseModelType(v) { sseModelType = v; },
      get sseConfigName() { return sseConfigName; },
      set sseConfigName(v) { sseConfigName = v; },
      get sseUserPrompt() { return sseUserPrompt; },
      set sseUserPrompt(v) { sseUserPrompt = v; },
      get sseParentMessageId() { return sseParentMessageId; },
      set sseParentMessageId(v) { sseParentMessageId = v; },
      get sseThinkingEnabled() { return sseThinkingEnabled; },
      set sseThinkingEnabled(v) { sseThinkingEnabled = v; },
      get sseFragments() { return sseFragments; },
      set sseFragments(v) { sseFragments = v; },
      get sseFragmentTypes() { return sseFragmentTypes; },
      set sseFragmentTypes(v) { sseFragmentTypes = v; },
      get sseStreamActive() { return sseStreamActive; },
      set sseStreamActive(v) { sseStreamActive = v; },
      get sseTurnFinished() { return sseTurnFinished; },
      set sseTurnFinished(v) { sseTurnFinished = v; },
      get sseResyncRing() { return sseResyncRing; },
      set sseResyncRing(v) { sseResyncRing = v; },
      get sseResyncCount() { return sseResyncCount; },
      set sseResyncCount(v) { sseResyncCount = v; },
      get sseResyncBytes() { return sseResyncBytes; },
      set sseResyncBytes(v) { sseResyncBytes = v; },
      get sseUnknownCount() { return sseUnknownCount; },
      set sseUnknownCount(v) { sseUnknownCount = v; },
      get sseUnknownChars() { return sseUnknownChars; },
      set sseUnknownChars(v) { sseUnknownChars = v; },
      get SSE_FRAGMENT_TYPES() { return SSE_FRAGMENT_TYPES; },
      // ro: только чтение — тела K6 это имя не перезаписывают.
      get currentConvId() { return currentConvId; }
    });
  }
  // Ядро продолжает звать K6 по ПРЕЖНИМ именам: sseModelSignals/streamFragmentText/
  // streamOtherText/dispatchStreamState — из K7 (finalizeRealtimeTurn) и обработчика смены
  // чата; resetStreamState/streamKnownType/parseSSE/consumeSseResponse/ingestModelSettings —
  // ЗНАЧЕНИЕМ в контракты D.5/D.1/D.7 (их связки стоят ВЫШЕ по файлу, поэтому форвардеры —
  // ИМЕННО function declaration: хойстятся, и fn-передачи видят значение на момент связки).
  // Гард `if (aiCmDeepseekSse)` — требование стандарта: ядро грузится и БЕЗ модуля
  // (контрактные тесты K0/слагов, одиночный require), и обёртка не имеет права бросать.
  // Заглушек нет намеренно: js[] регистрируется атомарно, а песочницы тестов получают
  // конкатенацию через tests/helpers/deepseek-intercept-source.js.
  function sseModelSignals() { if (aiCmDeepseekSse) return aiCmDeepseekSse.sseModelSignals(); }
  function ingestModelSettings(json) { if (aiCmDeepseekSse) return aiCmDeepseekSse.ingestModelSettings(json); }
  function dispatchStreamState(reason) { if (aiCmDeepseekSse) return aiCmDeepseekSse.dispatchStreamState(reason); }
  function resetStreamState() { if (aiCmDeepseekSse) return aiCmDeepseekSse.resetStreamState(); }
  function streamKnownType(t) { if (aiCmDeepseekSse) return aiCmDeepseekSse.streamKnownType(t); }
  function streamFragmentText(type) { if (aiCmDeepseekSse) return aiCmDeepseekSse.streamFragmentText(type); }
  function streamOtherText() { if (aiCmDeepseekSse) return aiCmDeepseekSse.streamOtherText(); }
  function parseSSE(text) { if (aiCmDeepseekSse) return aiCmDeepseekSse.parseSSE(text); }
  function consumeSseResponse(resp, convId) { if (aiCmDeepseekSse) return aiCmDeepseekSse.consumeSseResponse(resp, convId); }
})();

// v13: экспорт чистого резолвера для контрактного теста (jest/jsdom). В браузере module нет —
// блок не выполняется и на страницу не влияет.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug,
    DEEPSEEK_V4_FLASH_SLUG: AI_CM_DEEPSEEK_V4_FLASH_SLUG
  };
}