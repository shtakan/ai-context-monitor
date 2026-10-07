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

  // ===== СЕКЦИЯ 8: ПАРСИНГ history_messages =====
  // v6: детектор усечения активной цепочки + однократный тихий дозапрос полной истории
  // v12 (O-18, фаза 2): ingestMode === 'export-sync' — приёмка снимка, запрошенного ПЕРЕД
  // композицией файла: рекурсивные дозапросы не запускаются (таймаут экспорта уже идёт),
  // а вердикт полноты не понижается. Обычный путь (ingestMode === '') не меняется —
  // сигнатура функции прежняя, режим передаётся состоянием, а не аргументом.
  var ingestMode = '';
  var exportSyncTruncated = false;   // v12 (O-18): снимок экспортного дозапроса оказался усечён
  function ingestHistory(jsonBody) {
    var exportSync = (ingestMode === 'export-sync');
    try {
      if (jsonBody.code !== 0) return;
      var bizData = jsonBody.data && jsonBody.data.biz_data;
      if (!bizData) return;
      var chatSession = bizData.chat_session;
      var chatMessages = bizData.chat_messages;
      if (!chatSession || !Array.isArray(chatMessages)) return;

      // O-18 (ИЗМЕРЕНИЕ): вход в ingestHistory + сырьё ответа history_messages (кольцо).
      diagMark('ingest-enter', {
        chatMessages: chatMessages.length,
        is_empty: chatSession.is_empty === true,
        currentMessageId: chatSession.current_message_id != null
      });
      diagHistRecord(jsonBody, 'ingestHistory');

      // Помечаем «ответ для текущего чата обработан» — ДО buildActiveChain и ДО return по пустой цепочке
      lastLoadedConvId = currentConvId;

      // Строим Map<message_id, msg>
      var messagesById = {};
      for (var i = 0; i < chatMessages.length; i++) {
        var msg = chatMessages[i];
        if (msg && msg.message_id != null) {
          messagesById[msg.message_id] = msg;
        }
      }

      // Восстанавливаем активную цепочку (ловушка №1)
      // v6: получаем { chain, truncated } вместо просто массива
      var chainResult = buildActiveChain(chatSession, messagesById);
      var chain = chainResult.chain;
      var truncated = chainResult.truncated;

      // v11 (O-17): авторитетно ПУСТАЯ база — сервер явно говорит, что чат пуст
      // (is_empty=true), либо не отдал ни одного сообщения и не назвал активный узел.
      // Это ЧАСТЬ протокола (новый чат, созданный SPA-переходом), а не «полнота не доказана»:
      // вся история такого чата = 0 ходов, курсора пагинации у DeepSeek нет вовсе.
      var baseEmptyAuthoritative = (chatMessages.length === 0) &&
        (chatSession.is_empty === true || chatSession.current_message_id == null);

      // v11 (O-17): MERGE/cache-ответ (пустой chat_messages при is_empty!==true) —
      // снимок НЕ авторитетен. В ветках fetch/XHR этот случай ловит обёртка, но путь тихого
      // дозапроса после SPA-смены чата (scheduleHistoryRefetch → refetchFullHistory) приходит
      // сюда напрямую: раньше он стирал turnsMap и молча выходил. Теперь — тот же тихий
      // дозапрос полной истории без cache_version/cache_reset_at, база не трогается.
      if (!chain.length && chatMessages.length === 0 && !baseEmptyAuthoritative && !historyRefetchDone && !exportSync) {
        historyRefetchDone = true;
        diagMark('ingest-branch-MERGE-refetch', { chainLen: 0, chatMessages: 0 });   // O-18 (ИЗМЕРЕНИЕ)
        console.log('[deepseek-intercept] пустой кеш (MERGE) без авторитетной пустоты → тихий дозапрос полной истории (без cache_version)');
        refetchFullHistory(lastHistoryUrl, lastAuthHeaders, currentConvId);
        return;
      }

      if (!chain.length) {
        // O-18 (ИЗМЕРЕНИЕ): какая именно ветка пустой цепочки сработала.
        diagMark(baseEmptyAuthoritative ? 'ingest-branch-EMPTY-AUTH' : 'ingest-branch-EMPTY-NONAUTH', {
          chatMessages: chatMessages.length,
          is_empty: chatSession.is_empty === true,
          currentMessageId: chatSession.current_message_id != null
        });
        // v11 (O-17): ЕДИНЫЙ критерий полноты для обеих веток. Пустая цепочка больше не
        // означает «полнота не доказана»: авторитетно пустая база — полная база (0 ходов).
        // Вердикт обязателен именно здесь: realtime-эмиты наследуют histCompletion, и без
        // него на SPA-созданном чате baseComplete не наступал НИКОГДА → гейт O-16 «defer до
        // base-complete» разрешался только 60s-таймаутом (as-is + [LOW CONFIDENCE]_).
        if (baseEmptyAuthoritative) {
          histCompletion.reachedRoot = false;
          histCompletion.historyComplete = true;
          histCompletion.baseEmpty = true;
          console.log('[deepseek-intercept] ✓ база пустая и авторитетная (чат без ходов): история ПОЛНАЯ по сети (0 ходов)');
          // Поверх уже собранных live-ходов (дозапрос пришёл после первого обмена) полноту
          // 0→1 надо отдать content.js СРАЗУ: пустой снимок он игнорирует (`!detail.text`),
          // а следующий непустой EMIT может прийти нескоро — и экспорт ушёл бы по 60s-таймауту.
          if (Object.keys(turnsMap).length > 0) {
            // O-22 (ИЗМЕРЕНИЕ-2): маркер ТОЧКИ диспатча ai-cm-full-history (site=S560).
            try {
              if (typeof diagMark === 'function' && typeof diagOn === 'function' && diagOn()) {
                diagMark('o22-dispatch-site', {
                  site: 'S560', ts: Date.now(),
                  count: Object.keys(turnsMap).length, textLen: '(вне области)'
                });
              }
            } catch (eO22s560) { }
            emitBaseSnapshot(lastBaseServerTokens, lastBaseChatMode);
          }
        }
        // turnsMap НЕ трогаем: авторитетно пустой ответ не повод стирать live-ходы
        // (иначе следующий realtime-финал публикует СХЛОПНУВШУЮСЯ базу — живой лог: msgs=1..2
        // в записи истории при 4 ходах в чате).
        return;
      }

      // v6: ДЕТЕКТОР УСЕЧЕНИЯ — если цепочка оборвана и дозапрос ещё не делался
      if (truncated && !historyRefetchDone && !exportSync) {
        historyRefetchDone = true;
        // O-18 (ИЗМЕРЕНИЕ): ветка «цепочка оборвана → дозапрос».
        diagMark('ingest-branch-TRUNCATED-refetch', { chainLen: chain.length, chatMessages: chatMessages.length });
        // НЕ помечаем loggedHistory = true — лог и диагностический дамп сработают на полной истории
        console.log('[deepseek-intercept] кеш усечён (цепочка оборвана) → тихий дозапрос полной истории (без cache_version)');
        refetchFullHistory(lastHistoryUrl, lastAuthHeaders, currentConvId);
        return; // не обрабатываем усечённый ответ — ждём полный (собранные live-ходы сохранены)
      }
      // v12 (O-18, фаза 2): в режиме экспортного дозапроса усечённый снимок НЕ принимается.
      // Экспорт не имеет права стать ХУЖЕ live-базы: сброс turnsMap по обрезанной цепочке
      // потерял бы ранние ходы. Такой ответ — как «сети нет»: база не тронута, live-путь.
      if (truncated && exportSync) {
        exportSyncTruncated = true;
        diagMark('ingest-branch-TRUNCATED-export-sync', { chainLen: chain.length, chatMessages: chatMessages.length });
        console.log('[deepseek-intercept] экспорт: сетевой снимок усечён (цепочка оборвана) → база не тронута, прежний live-путь');
        return;
      }

      // v11 (O-17): снимок ПРИНЯТ как авторитетный — только теперь СБРОС и пересборка
      // (история = полный авторитетный снимок, условие 3 из рецензии).
      turnsMap = {};
      orderCounter = 0;
      // (attachTokens/attachBreak на 1-м этапе не трогаем — всегда 0)

      // v7: честная полнота — true, только если цепочка реально дошла до корня.
      // Дозапрос уже либо выполнен (путь выше), либо не нужен (truncated=false).
      histCompletion.reachedRoot = chainResult.reachedRoot;
      histCompletion.historyComplete = chainResult.reachedRoot && !chainResult.truncated;
      histCompletion.baseEmpty = false;   // v11 (O-17): база непустая

      // chatMode — модель чата (expert/default/null), не влияет на выбор модели
      var chatMode = chatSession.model_type || '';
      // v13: сигналы нового контракта из chat_session (model/model_type/conversation_mode)
      // + активная конфигурация из /client/settings (name:"Instant"), если уже захвачена.
      var chatModelSignals = {
        modelPresent: Object.prototype.hasOwnProperty.call(chatSession, 'model'),
        model: chatSession.model,
        modelType: chatSession.model_type,
        conversationMode: chatSession.conversation_mode,
        configName: sseConfigName
      };

      // Заполняем turnsMap: модель ПОХОДОВО по thinking_enabled.
      // v9 (O-15): ход = user + assistant(reasoning+answer). Узел-assistant БЕЗ ответа
      // (фрагменты только THINK — «пара assi+assi» из живого лога) отдельным ходом не
      // становится: его рассуждение приклеивается к следующему assistant-узлу, а если
      // следующего нет — к предыдущему (у которого ответ уже есть). В v8 такой узел
      // отбрасывался (`if (!text) continue`) — reasoning терялся, а пара сбивалась.
      var pendingReasoning = '';
      var lastAssistantId = null;
      for (var c = 0; c < chain.length; c++) {
        var ch = chain[c];
        var chId = String(ch.message_id);
        if (turnsMap[chId]) continue;          // дедуп
        var fragments = Array.isArray(ch.fragments) ? ch.fragments : [];
        var text = collectTurnText(fragments, ch.role);
        var chRole = (!ch.role) ? 'unknown' : (ch.role === 'USER' ? 'user' : (ch.role === 'ASSISTANT' ? 'assistant' : 'unknown'));
        // v8 (O-7): reasoning хода — фрагменты THINK; в текст уходит секциями [REASONING]/[ANSWER]
        var chReasoning = REASONING_ENABLED ? collectTurnReasoning(fragments, ch.role) : '';
        if (chRole === 'assistant') {
          if (!text) {
            // reasoning без ответа: НЕ отдельное сообщение и не потеря
            if (chReasoning) {
              if (lastAssistantId && turnsMap[lastAssistantId]) {
                var prevTurn = turnsMap[lastAssistantId];
                prevTurn.reasoning = (prevTurn.reasoning || '') + chReasoning;
                prevTurn.text = composeTurnText(prevTurn.answer || '', prevTurn.reasoning);
              } else {
                pendingReasoning += chReasoning;   // ждём ответ следующего assistant-узла
              }
            }
            continue;
          }
          var mergedReasoning = pendingReasoning + chReasoning;
          pendingReasoning = '';
          turnsMap[chId] = {
            text: composeTurnText(text, mergedReasoning),
            answer: text,                        // v9: ответ хода (для пересборки при хвостовом reasoning)
            reasoning: mergedReasoning,
            modelSlug: getModelSlug(ch.thinking_enabled === true, chatModelSignals),
            order: orderCounter++,
            ts: ch.inserted_at || 0,
            role: chRole
          };
          lastAssistantId = chId;
          continue;
        }
        if (!text) continue;
        turnsMap[chId] = {
          text: composeTurnText(text, chReasoning),
          answer: text,
          reasoning: chReasoning,
          modelSlug: getModelSlug(ch.thinking_enabled === true, chatModelSignals),
          order: orderCounter++,
          ts: ch.inserted_at || 0,
          role: chRole
        };
      }
      // v9 (O-15): «висячий» reasoning в конце цепочки (assistant-узел без ответа и без
      // последующего ответа) доливаем в последний assistant-ход — отдельного хода нет.
      if (pendingReasoning && lastAssistantId && turnsMap[lastAssistantId]) {
        var tailTurn = turnsMap[lastAssistantId];
        tailTurn.reasoning = (tailTurn.reasoning || '') + pendingReasoning;
        tailTurn.text = composeTurnText(tailTurn.answer || '', tailTurn.reasoning);
      }

      // O-18 (ИЗМЕРЕНИЕ): снимок ПРИНЯТ как авторитетный — фиксируем ветку и per-turn
      // NETWORK-текст (ровно тот, что сейчас лежит в turnsMap и уйдёт в экспорт).
      diagMark('ingest-branch-ACCEPT', {
        chainLen: chain.length, chatMessages: chatMessages.length,
        reachedRoot: chainResult.reachedRoot === true, truncated: chainResult.truncated === true
      });
      diagSnapshotNetTurns('ingestHistory');
      // v12 (O-18, фаза 2): снимок сети ПРИНЯТ — фиксируем его время и состав ходов.
      // По этим данным экспорт решает, нужен ли дозапрос («снимок старше последнего хода»).
      netSnapshotAt = Date.now();
      netTurnIds = {};
      for (var nk in turnsMap) {
        if (Object.prototype.hasOwnProperty.call(turnsMap, nk)) netTurnIds[nk] = 1;
      }

      // УСЛОВИЕ 1: accumulated_token_usage — максимум по всем сообщениям цепочки (накопительное, монотонно растёт)
      var lastAccumulated = 0;
      for (var ci = 0; ci < chain.length; ci++) {
        var at = chain[ci].accumulated_token_usage;
        if (typeof at === 'number' && at > lastAccumulated) {
          lastAccumulated = at;
        }
      }

      // O-22 (ИЗМЕРЕНИЕ-2): маркер ТОЧКИ диспатча ai-cm-full-history (site=S692).
      try {
        if (typeof diagMark === 'function' && typeof diagOn === 'function' && diagOn()) {
          diagMark('o22-dispatch-site', {
            site: 'S692', ts: Date.now(),
            count: Object.keys(turnsMap).length, textLen: '(вне области)'
          });
        }
      } catch (eO22s692) { }
      var em = emitBaseSnapshot(lastAccumulated, chatMode);
      if (!loggedHistory) {
        loggedHistory = true;
        console.log('[deepseek-intercept] ✓ история загружена: ходов=' + em.count +
          ', символов=' + em.textLen + ', модель=' + (em.lastModel || '?') +
          ', serverTokens=' + lastAccumulated +
          (lastAccumulated > 0 ? ' (' + Math.round(lastAccumulated / MODEL_WINDOW_DEFAULT * 1000) / 10 + '%)' : '') +
          ', modelMode=' + (chatMode || '(default)') +
          ', reasoning-ходов=' + em.reasoningTurns);   // v8 (O-7)

        // ДИАГНОСТИЧЕСКИЙ ДАМП — только при включённом флаге aiCmDebug
        if (isDebugEnabled()) {
          var diagState = determineState();
          dumpHistorySnapshot(diagState.state, diagState.reason, {
            capturePoint: 'ingestHistory',
            navType: diagState.navType,
            chatMessages: chatMessages,
            chatSession: chatSession,
            chain: chain,
            lastAccumulated: lastAccumulated,
            chatMode: chatMode
          });
          // O-26: однократный вербатим-дамп usage по ходам (точка — загрузка истории).
          // Ничего не пишет в turnsMap/состояние, на pct/serverTokens/экспорт не влияет.
          dumpTurnUsageAtHistoryLoad(chain, chatMessages, chatSession);
        }
      }
    } catch (e) {
      console.warn('[deepseek-intercept] ошибка парсинга history_messages:', e);
    }
  }

  // ===== СЕКЦИЯ 9: ПАРСЕР SSE (постфактум и ИНКРЕМЕНТАЛЬНО, ловушка №2) =====
  var sseLastPath = null;
  var sseLastOp = null;
  var sseRealtimeEntryTokens = 0;
  var sseRealtimeFinalTokens = 0;
  var sseRequestMessageId = null;
  var sseResponseMessageId = null;
  var sseModelType = null;
  // v13: сигналы нового контракта из SSE. model/modelPresent приходят в update_session
  // (в контракте 2026-10-03 — model:""), conversation_mode — там же ("DEFAULT").
  // sseConfigName — сессионный факт из /client/settings (name:"Instant"), НЕ сбрасывается
  // при смене потока (см. ingestModelSettings).
  var sseModel = null;
  var sseModelPresent = false;
  var sseConversationMode = null;
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
  var sseCurrentEvent = '';    // v9: текущее SSE-событие (разбор по строкам, в т.ч. инкрементальный)
  // v10 (O-16): состояние ЖИВОГО потока. active=true от старта чтения тела ответа
  // completion до его конца; turnFinished=true, если терминальный чанк уже пришёл
  // (ход зафиксирован), но тело ответа ещё может досылать фрагменты.
  var sseStreamActive = false;
  var sseTurnFinished = false;

  /**
   * v13: сигналы модели текущего/последнего потока для __aiCmDeepseekResolveModelSlug.
   * @returns {AiCmDeepSeekModelSignals}
   */
  function sseModelSignals() {
    return {
      modelPresent: sseModelPresent === true,
      model: sseModel,
      modelType: sseModelType,
      conversationMode: sseConversationMode,
      configName: sseConfigName
    };
  }

  /**
   * v13: запоминает активную конфигурацию модели из /api/v0/client/settings?scope=model.
   * Новый контракт: активная запись имеет model_type:"default" и name:"Instant" — имя модели
   * в сети отсутствует. Резолвер использует её как резервный сигнал (см. configName).
   * @param {any} json распарсенное тело ответа settings
   * @returns {void}
   */
  function ingestModelSettings(json) {
    try {
      var settings = json && json.data && json.data.biz_data && json.data.biz_data.settings;
      var list = settings && settings.model_configs && settings.model_configs.value;
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || c.enabled === false) continue;
        if (c.is_default === true || c.model_type === 'default' || i === 0) {
          if (c.name) sseConfigName = c.name;
          break;
        }
      }
    } catch (eSettings) { }
  }

  // v10 (O-16): снимок состояния потока наружу (ISOLATED-мир). convId — тот же, что в
  // detail ai-cm-full-history (stale-conv гард экспортёра работает и здесь).
  function streamStateSnapshot() {    return {
      convId: currentConvId || getConvId() || '',
      active: sseStreamActive === true,
      turnFinished: sseTurnFinished === true
    };
  }
  function dispatchStreamState(reason) {
    try {
      var snap = streamStateSnapshot();
      snap.reason = reason || '';
      window.dispatchEvent(new CustomEvent('ai-cm-deepseek-stream-state', { detail: snap }));
    } catch (e) { }
  }
  // v10 (O-16): НОВЫЙ поток начинается здесь — только тут буфер обнуляется целиком.
  // Поля ЗАПРОСА (prompt/parent_message_id/thinking_enabled) выставлены обёрткой fetch
  // ДО старта чтения ответа — их сброс обнулил бы USER-ход каждого live-ответа
  // (проверено harness'ом: live-экспорт начинался с assistant). Сохраняем и возвращаем.
  function beginSseStream() {
    var keepPrompt = sseUserPrompt;
    var keepParentId = sseParentMessageId;
    var keepThinking = sseThinkingEnabled;
    resetStreamState();
    sseUserPrompt = keepPrompt;
    sseParentMessageId = keepParentId;
    sseThinkingEnabled = keepThinking;
    sseStreamActive = true;
    dispatchStreamState('begin');
    diagMark('sse-begin', { promptLen: (keepPrompt || '').length });   // O-18 (ИЗМЕРЕНИЕ)
  }
  // v10 (O-16): тело ответа дочитано (или оборвано) — стрима больше нет.
  function endSseStream() {
    if (!sseStreamActive) return;
    sseStreamActive = false;
    dispatchStreamState('end');
    diagMark('sse-end', { turnFinished: sseTurnFinished === true });   // O-18 (ИЗМЕРЕНИЕ)
  }

  function resetStreamState() {
    // O-18 (ИЗМЕРЕНИЕ): срез буфера ПЕРЕД обнулением — если сброс случится посреди ответа,
    // здесь видно, какие фрагменты были выброшены (кандидат «потеря середины»).
    diagMark('stream-reset', {});
    sseStreamActive = false;   // v10 (O-16)
    sseTurnFinished = false;   // v10 (O-16)
    sseLastPath = null;
    sseLastOp = null;
    sseRealtimeEntryTokens = 0;
    sseRealtimeFinalTokens = 0;
    sseRequestMessageId = null;
    sseResponseMessageId = null;
    sseModelType = null;
    sseModel = null;             // v13
    sseModelPresent = false;     // v13
    sseConversationMode = null;  // v13
    sseUserPrompt = '';
    sseParentMessageId = null;
    sseThinkingEnabled = null;
    sseFragments = [];       // v9
    sseFragmentTypes = [];   // v9
    sseCurrentEvent = '';    // v9
    // v12 (O-18): сырое кольцо ресинка и аварийный бакет неизвестных типов относятся к
    // ТЕКУЩЕМУ потоку — новый поток/смена чата их не наследует (иначе байты прошлого хода
    // могли бы попасть в аварийный ответ следующего).
    sseResyncRing = [];
    sseResyncChars = 0;
    sseUnknownParts = [];
    sseUnknownChars = 0;
  }

  // v9 (O-15): последний фрагмент потока — цель пути response/fragments/-1/content.
  function streamLastFragment() {
    return sseFragments.length ? sseFragments[sseFragments.length - 1] : null;
  }
  // ===== v12 (O-18, фаза 2): БЕЛЫЙ СПИСОК ТИПОВ + РЕСИНХРОН ПАРСЕРА ФРАГМЕНТОВ =====
  // Имя типа фрагмента — это ВСЕГДА одно из имён протокола DeepSeek. Любая другая строка
  // (в т.ч. типоподобная «BSCRIPT»/«ION»/«URL»/«DOM» — куски текста ответа) типом НЕ является.
  // Набор собран по самому протоколу: fragments[].type в history_messages (REQUEST/RESPONSE/
  // THINK/TIP/SEARCH — см. collectTurnText/collectTurnReasoning) и в SSE-потоке completion
  // (BEGIN/… не встречаются, но TEMPLATE_RESPONSE упоминается в комментариях v8).
  var SSE_FRAGMENT_TYPES = {
    THINK: 1, RESPONSE: 1, REQUEST: 1, TIP: 1, SEARCH: 1, TEMPLATE_RESPONSE: 1
  };
  function streamKnownType(t) {
    return (typeof t === 'string') && SSE_FRAGMENT_TYPES[t] === 1;
  }
  // Форма «объявления типа» — тот же признак, по которому парсер до фикса заводил новый тип.
  function streamTypeShape(v) {
    return (typeof v === 'string') && /^[A-Z][A-Z_]{2,}$/.test(v);
  }
  // Сырое кольцо дельт, ушедших ЗА последнюю валидную границу (в невалидный фрагмент) либо
  // отвергнутых как мусорный «тип». В здоровом потоке ПУСТО (нулевая цена по памяти и времени);
  // наполняется только в момент десинхрона — из него контент пересобирается, а не теряется.
  var SSE_RESYNC_MAX_ENTRIES = 512;
  var SSE_RESYNC_MAX_CHARS = 65536;
  var sseResyncRing = [];
  var sseResyncChars = 0;
  var sseResyncCount = 0;
  var sseResyncBytes = 0;
  var sseUnknownCount = 0;   // отказов «имя типа вне белого списка» (строка или элемент массива)
  // Контент фрагментов, чьё имя типа вне белого списка (незнакомый протокол): в буфер
  // фрагментов такой «тип» не попадает, но байты сохраняются для аварийного streamOtherText.
  var SSE_UNKNOWN_MAX_CHARS = 262144;
  var sseUnknownParts = [];
  var sseUnknownChars = 0;

  function streamNoteMisroute(op, val) {
    try {
      if (typeof val !== 'string' || !val) return;
      sseResyncRing.push({ op: (op === 'SET') ? 'SET' : 'APPEND', v: val });
      sseResyncChars += val.length;
      while (sseResyncRing.length > SSE_RESYNC_MAX_ENTRIES || sseResyncChars > SSE_RESYNC_MAX_CHARS) {
        var drop = sseResyncRing.shift();
        if (!drop) break;
        sseResyncChars -= (drop.v || '').length;
      }
    } catch (e) { }
  }
  function streamUnknownPush(type, content) {
    try {
      var val = (typeof content === 'string') ? content : '';
      sseUnknownCount++;
      console.warn('[deepseek-intercept] имя фрагмента вне белого списка ("' + String(type || '').slice(0, 32) +
        '") — тип не заводится; контент ' + val.length + ' симв. сохранён аварийным (логу/фолбэку)');
      if (val) {
        sseUnknownParts.push(val);
        sseUnknownChars += val.length;
        while (sseUnknownChars > SSE_UNKNOWN_MAX_CHARS && sseUnknownParts.length > 1) {
          var d = sseUnknownParts.shift();
          sseUnknownChars -= (d || '').length;
        }
      }
      diagMark('frag-unknown-type', { type: String(type || '').slice(0, 32), len: val.length });
    } catch (e) { }
    return null;
  }
  // Последняя ВАЛИДНАЯ граница — последний фрагмент, чьё имя типа из белого списка.
  function streamLastValidFragment() {
    for (var i = sseFragments.length - 1; i >= 0; i--) {
      if (sseFragments[i] && streamKnownType(sseFragments[i].type)) return sseFragments[i];
    }
    return null;
  }
  // РЕСИНХРОН: буфер приведён в невалидное состояние (мусорный «тип» или наследство старого
  // буфера) → выбрасываем невалидные фрагменты и ПЕРЕСОБИРАЕМ содержимое последнего валидного
  // фрагмента из сырого кольца дельт с последней валидной границы (порядок и op сохранены).
  function streamResync(reason) {
    try {
      var keep = [];
      for (var i = 0; i < sseFragments.length; i++) {
        if (sseFragments[i] && streamKnownType(sseFragments[i].type)) keep.push(sseFragments[i]);
      }
      sseFragments = keep;
      var bf = streamLastValidFragment();
      if (!bf) {
        // валидной границы не было вовсе (поток начался с мусора): ответ — единственный
        // осмысленный приёмник байтов, их тип в тексте хода читается.
        bf = { type: 'RESPONSE', content: '' };
        sseFragments.push(bf);
      }
      sseFragmentTypes = [];
      for (var k = 0; k < sseFragments.length; k++) sseFragmentTypes.push(sseFragments[k].type);
      var bytes = 0;
      for (var r = 0; r < sseResyncRing.length; r++) {
        var e = sseResyncRing[r];
        if (!e) continue;
        if (e.op === 'SET') streamSetContent(bf, e.v); else streamAppendContent(bf, e.v);
        bytes += (e.v || '').length;
      }
      sseResyncRing = [];
      sseResyncChars = 0;
      sseResyncCount++;
      sseResyncBytes += bytes;
      console.warn('[deepseek-intercept] десинхрон парсера фрагментов (' + reason + ') → ресинк: ' +
        'восстановлено ' + bytes + ' симв. из сырого кольца, фрагментов=' + sseFragments.length + ', ' +
        'типы=' + sseFragmentTypes.join(','));
      diagMark('frag-resync', {
        reason: String(reason || ''), recovered: bytes, frags: sseFragmentTypes.length,
        types: sseFragmentTypes.join(',')
      });
    } catch (e) { }
  }
  // Единая точка «куда положить БАЙТЫ контента»: только в ВАЛИДНЫЙ фрагмент. Байты в
  // невалидный фрагмент не пишутся никогда — сначала ресинк (это и есть механика K1:
  // позиционное переиспользование не должно уводить контент в мусорный «тип»).
  function streamContentInto(op, val) {
    var f = streamLastFragment();
    if (!f) return;
    if (!streamKnownType(f.type)) {
      streamNoteMisroute(op, val);
      streamResync('content-into-invalid-fragment');
      return;
    }
    if (op === 'SET') streamSetContent(f, val); else streamAppendContent(f, val);
  }
  function streamPushFragment(type, content) {
    if (typeof type !== 'string' || !type) return null;
    if (!streamKnownType(type)) return streamUnknownPush(type, content);   // v12 (O-18): белый список
    var f = { type: type, content: (typeof content === 'string') ? content : '' };
    sseFragments.push(f);
    sseFragmentTypes.push(type);
    return f;
  }
  // v9 (O-15): APPEND — дельта, НО сервер иногда перевыдаёт фрагмент целиком (значение
  // начинается с уже собранного). Тогда это замена, а не дубль. Среза с фиксированным
  // смещением НЕТ: только проверка префикса (indexOf === 0) — байты не теряются никогда.
  function streamAppendContent(f, val) {
    if (!f || typeof val !== 'string' || !val) return;
    var cur = f.content || '';
    if (cur && val.indexOf(cur) === 0) { f.content = val; return; }
    f.content = cur + val;
  }
  // v9 (O-15): SET — замена контента фрагмента. Укорачивать уже собранное нельзя: SET
  // приходит и как «полный текст на данный момент». Значение-префикс уже собранного — игнор.
  function streamSetContent(f, val) {
    if (!f || typeof val !== 'string' || !val) return;
    var cur = f.content || '';
    if (!cur) { f.content = val; return; }
    if (val === cur) return;
    if (cur.indexOf(val) === 0) return;
    f.content = val;
  }
  // v9 (O-15): текст всех фрагментов одного типа в порядке потока (та же склейка, что в
  // history_messages: join('') + trim) — live и история дают ОДИН И ТОТ ЖЕ текст.
  function streamFragmentText(type) {
    var parts = [];
    for (var i = 0; i < sseFragments.length; i++) {
      var f = sseFragments[i];
      if (f && f.type === type && typeof f.content === 'string') parts.push(f.content);
    }
    return parts.join('').trim();
  }
  // v9 (O-15): контент фрагментов «прочих» типов (TIP/SEARCH/…) — в текст хода не идёт,
  // но служит аварийным ответом, если RESPONSE-фрагментов в потоке не было вовсе
  // (незнакомый протокол): лучше показать текст, чем пустой ход.
  // v12 (O-18): сюда же добавлен контент фрагментов, чьё имя типа вне белого списка —
  // раньше такой «тип» заводился в буфере, теперь байты живут в аварийном бакете (тот же
  // текст на выходе, но мусорных типов в буфере нет).
  function streamOtherText() {
    var parts = [];
    for (var i = 0; i < sseFragments.length; i++) {
      var f = sseFragments[i];
      if (f && f.type !== 'THINK' && f.type !== 'RESPONSE' && typeof f.content === 'string') parts.push(f.content);
    }
    for (var u = 0; u < sseUnknownParts.length; u++) parts.push(sseUnknownParts[u]);
    return parts.join('').trim();
  }

  // O-18 (ИЗМЕРЕНИЕ): тонкая обёртка — снимает срез буфера фрагментов ДО и ПОСЛЕ обработки
  // чанка и кладёт сырьё в diag-кольцо. Тело вынесено в processChunkCore БЕЗ правок: при
  // выключенном флаге обёртка не делает ничего, кроме кэшированной проверки diagOn(), и
  // управление/результат обработки — ровно те же (в т.ч. все ранние return).
  function processChunk(path, op, val) {
    var dOn = diagOn();
    var dBefore = dOn ? diagFragState() : null;
    processChunkCore(path, op, val);
    if (dOn) diagChunkRecord(path, op, val, dBefore, diagFragState());
  }

  function processChunkCore(path, op, val) {
    // v9 (O-15): сокращённый чанк может прийти и после чанка массива фрагментов. Строка —
    // это либо объявление типа ('THINK'), либо порция КОНТЕНТА последнего фрагмента
    // (иначе текст молча терялся). Различаем по форме: типы — ВЕРХНИЙ_РЕГИСТР.
    // v12 (O-18): форма — ТОЛЬКО предварительный признак; имя типа обязано быть в белом
    // списке. Типоподобный токен вне списка — это БАЙТЫ КОНТЕНТА (десинхрон парсера):
    // он не заводит новый «тип», а возвращается в последний валидный фрагмент.
    if (typeof val === 'string' && (path === 'response/fragments' || path === 'fragments')) {
      if (streamTypeShape(val)) {
        if (streamKnownType(val)) { streamPushFragment(val, ''); return; }
        streamNoteMisroute(op, val);
        streamResync('type-out-of-whitelist:' + val.slice(0, 24));
        return;
      }
      streamContentInto(op, val);
      return;
    }
    // v9 (O-15): чанк массива фрагментов — это И объявление типа нового фрагмента,
    // И ПЕРВАЯ ПОРЦИЯ ЕГО КОНТЕНТА. Регистрируем тип и НЕ ТЕРЯЕМ content.
    if (Array.isArray(val) && (path === 'response/fragments' || path === 'fragments')) {
      var i, item, itemType;
      if (op === 'SET') {
        // SET авторитетен для СОСТАВА массива; контент совпадающих по позиции фрагментов
        // сливаем (streamSetContent не укорачивает уже собранное).
        var next = [];
        for (i = 0; i < val.length; i++) {
          item = val[i];
          itemType = (typeof item === 'string') ? item : ((item && typeof item.type === 'string') ? item.type : '');
          if (!itemType) continue;
          // v12 (O-18): имя типа из массива — тоже ТОЛЬКО из белого списка. Незнакомое имя
          // фрагментом не становится (иначе в буфере живёт мусорный «тип», который не читает
          // ни текст хода, ни диагностика); контент сохраняется аварийным бакетом.
          if (!streamKnownType(itemType)) { streamUnknownPush(itemType, (item && typeof item === 'object') ? item.content : ''); continue; }
          var prevF = sseFragments[i];
          var fS = (prevF && prevF.type === itemType) ? prevF : { type: itemType, content: '' };
          if (item && typeof item === 'object') streamSetContent(fS, item.content);
          next.push(fS);
        }
        if (!next.length && sseFragments.length) return;   // пустой SET не стирает собранное
        sseFragments = next;
        sseFragmentTypes = [];
        for (i = 0; i < next.length; i++) sseFragmentTypes.push(next[i].type);
        return;
      }
      // APPEND: строки — только объявление типа (['THINK']), объекты — тип + первая порция
      for (i = 0; i < val.length; i++) {
        item = val[i];
        if (typeof item === 'string') { streamPushFragment(item, ''); continue; }
        if (!item || typeof item.type !== 'string') continue;
        if (!streamKnownType(item.type)) { streamUnknownPush(item.type, item.content); continue; }   // v12 (O-18)
        // Перевыдача последнего фрагмента целиком (тот же тип + значение начинается с
        // уже собранного) — это продолжение/замена, а не новый фрагмент: не дублируем.
        var lastF = streamLastFragment();
        if (lastF && lastF.type === item.type && typeof item.content === 'string' && item.content &&
            (lastF.content || '').length > 0 && item.content.indexOf(lastF.content) === 0) {
          streamAppendContent(lastF, item.content);
          continue;
        }
        streamPushFragment(item.type, item.content);
      }
      return;
    }
    // Путь к контенту ПОСЛЕДНЕГО фрагмента: APPEND — дельта, SET — замена.
    // v12 (O-18): пишем только в валидный фрагмент (streamContentInto) — байты контента
    // в мусорный «тип» не уходят никогда.
    if (path === 'response/fragments/-1/content') {
      if (op === 'APPEND' || op === 'SET') streamContentInto(op, val);
    }
  }

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

  // v9 (O-15): разбор идёт ПО СТРОКАМ — один и тот же код обслуживает полный текст
  // (XHR/фолбэк: parseSSE) и инкрементальное чтение потока (consumeSseResponse).
  function parseSSELines(lines) {
    if (!Array.isArray(lines)) return;

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];

      // event: ... (v9: состояние события живёт в sseCurrentEvent — разбор идёт по строкам,
      // в т.ч. инкрементально, поэтому локальная переменная не годится)
      if (ln.indexOf('event:') === 0) {
        sseCurrentEvent = ln.slice(6).trim();
        continue;
      }

      // data: ...
      if (ln.indexOf('data:') !== 0) continue;
      var jsonStr = ln.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      var obj;
      try { obj = JSON.parse(jsonStr); } catch (e) { continue; }

      // === ready ===
      if (sseCurrentEvent === 'ready' && obj.request_message_id) {
        // v10 (O-16): новый ход внутри ТОГО ЖЕ тела ответа (другой response_message_id) —
        // буфер предыдущего хода уже закрыт финалом, начинаем чистый: иначе фрагменты
        // двух ходов склеились бы в один. Раньше границей служил reset внутри финала.
        if (sseResponseMessageId && obj.response_message_id &&
            String(obj.response_message_id) !== String(sseResponseMessageId)) {
          beginSseStream();
        }
        sseRequestMessageId = obj.request_message_id;
        sseResponseMessageId = obj.response_message_id;
        sseModelType = obj.model_type || null;
        sseCurrentEvent = '';
        continue;
      }

      // === update_session (v13: model/conversation_mode нового контракта; updated_at не нужен) ===
      if (sseCurrentEvent === 'update_session') {
        var usResp = obj && obj.v && obj.v.response;
        if (usResp) {
          if (Object.prototype.hasOwnProperty.call(usResp, 'model')) {
            sseModelPresent = true;
            if (typeof usResp.model === 'string') sseModel = usResp.model;
          }
          if (usResp.conversation_mode) sseConversationMode = usResp.conversation_mode;
          if (usResp.model_type && !sseModelType) sseModelType = usResp.model_type;
        }
        sseCurrentEvent = '';
        continue;
      }

      // === close ===
      if (sseCurrentEvent === 'close') {
        if (sseRequestMessageId && sseResponseMessageId) {
          finalizeRealtimeTurn();
        }
        sseCurrentEvent = '';
        continue;
      }

      // === первый response-объект: {v:{response:{...}}} ===
      // Извлекаем accumulated_token_usage, model_type И начальный контент из fragments
      // (первый символ ответа приходит здесь, а не в APPEND-чанках — без этого теряется символ)
      if (obj.v && obj.v.response && typeof obj.v.response.accumulated_token_usage === 'number') {
        sseRealtimeEntryTokens = obj.v.response.accumulated_token_usage;
        sseModelType = sseModelType || obj.v.response.model_type || null;
        // v13: те же сигналы контракта могут прийти и в первом response-объекте
        if (Object.prototype.hasOwnProperty.call(obj.v.response, 'model')) {
          sseModelPresent = true;
          if (typeof obj.v.response.model === 'string') sseModel = obj.v.response.model;
        }
        if (obj.v.response.conversation_mode) sseConversationMode = obj.v.response.conversation_mode;

        // v9 (O-15): начальные фрагменты разбирает ТОТ ЖЕ код, что и APPEND/SET-чанки
        // (тип + контент). Первый envelope — SET состава, повторный — APPEND новых.
        var initFrags = obj.v.response.fragments;
        if (Array.isArray(initFrags)) {
          processChunk('response/fragments', sseFragments.length ? 'APPEND' : 'SET', initFrags);
        }
        continue;
      }

      // === финальный BATCH: {p:"response", o:"BATCH", v:[...]} ===
      if (obj.p === 'response' && obj.o === 'BATCH' && Array.isArray(obj.v)) {
        for (var b = 0; b < obj.v.length; b++) {
          var batchItem = obj.v[b];
          if (batchItem.p === 'accumulated_token_usage' && typeof batchItem.v === 'number') {
            sseRealtimeFinalTokens = batchItem.v;
          }
          if (batchItem.p === 'quasi_status' && batchItem.v === 'FINISHED') {
            if (sseRequestMessageId && sseResponseMessageId) {
              finalizeRealtimeTurn();
            }
          }
        }
        continue;
      }

      // === status FINISHED (страховка, если BATCH не сработал) ===
      if (obj.p === 'response/status' && obj.o === 'SET' && obj.v === 'FINISHED') {
        if (!sseRealtimeFinalTokens && sseRequestMessageId && sseResponseMessageId) {
          finalizeRealtimeTurn();
        }
        continue;
      }

      // === чанк с путём (запоминаем lastPath/lastOp для сокращённых чанков — ловушка №2) ===
      if (obj.p && obj.o) {
        sseLastPath = obj.p;
        sseLastOp = obj.o;
        processChunk(obj.p, obj.o, obj.v);
        continue;
      }

      // === сокращённый чанк (только v, без p и o) — используем запомненный путь ===
      if (obj.v !== undefined && sseLastPath && sseLastOp) {
        processChunk(sseLastPath, sseLastOp, obj.v);
        continue;
      }
    }
  }

  // v9 (O-15): конец тела ответа = ход завершён. Раньше терминалом были ТОЛЬКО
  // BATCH quasi_status FINISHED и event: close; если сервер не прислал ни того, ни другого,
  // последний ход сессии вообще не попадал в live-экспорт. v10 (O-16): повторный финал
  // БЕЗОПАСЕН и не теряет текст — finalizeRealtimeTurn обогащает существующий ход
  // (буфер потока живёт до конца тела ответа), а не отбрасывает более полный текст.
  function finishSseStream() {
    if (sseRequestMessageId && sseResponseMessageId) finalizeRealtimeTurn();
    diagMark('sse-finish', {});   // O-18 (ИЗМЕРЕНИЕ)
  }

  // v10 (O-16): синхронный мост ISOLATED → MAIN (тот же приём, что у Gemini-моста
  // aiCmGeminiTurnsSnapshotSync): экспортёр спрашивает состояние потока перед записью
  // файла и может принудительно закрыть незавершённый буфер.
  try {
    window.addEventListener('ai-cm-deepseek-stream-probe', function () {
      try {
        window.dispatchEvent(new CustomEvent('ai-cm-deepseek-stream-probe-response', {
          detail: streamStateSnapshot()
        }));
      } catch (eProbe) { }
    });
    window.addEventListener('ai-cm-deepseek-stream-flush', function () {
      try {
        if (sseStreamActive === true) {
          finishSseStream();
          dispatchStreamState('flush');
        }
      } catch (eFlush) { }
    });
  } catch (eStreamBridge) { }

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

  function parseSSE(text) {
    if (typeof text !== 'string' || !text) return;
    beginSseStream();   // v10 (O-16): новый поток (XHR/фолбэк полного текста)
    parseSSELines(text.split('\n'));
    finishSseStream();
    endSseStream();
  }

  // v9 (O-15): инкрементальное чтение потока: полные строки уходят в разбор СРАЗУ, поэтому
  // терминальный чанк закрывает ход, не дожидаясь конца тела ответа (live-экспорт «сразу
  // после диалога» видел только предыдущие ходы). Клон tee-ится — чтение страницы не
  // затрагивается; если body/reader/TextDecoder недоступны (или это XHR-путь) — прежний
  // фолбэк на clone().text() (полный текст).
  // Чат может смениться ПОКА поток читается (SPA-переход по сайдбару): ходы старого чата
  // в новый turnsMap не подмешиваем — тихая проверка convId на каждом шаге чтения.
  function consumeSseResponse(resp, convId) {
    var sameConv = function () { return !convId || convId === currentConvId; };
    var clone = null;
    try { clone = resp.clone(); } catch (e) { clone = null; }
    if (!clone) return;
    // v10 (O-16): старт нового потока — буфер прошлого хода обнуляется ЗДЕСЬ, а не в финале.
    beginSseStream();
    var body = clone.body;
    var Dec = (typeof TextDecoder !== 'undefined') ? TextDecoder : null;
    if (!body || typeof body.getReader !== 'function' || !Dec) {
      if (typeof clone.text === 'function') {
        clone.text().then(function (txt) {
          if (sameConv()) { parseSSE(txt); endSseStream(); }
        }).catch(function () { if (sameConv()) endSseStream(); });
      } else {
        endSseStream();
      }
      return;
    }
    var reader = null;
    var dec = null;
    try {
      reader = body.getReader();
      dec = new Dec('utf-8');
    } catch (eR) {
      endSseStream();
      return;
    }
    var buf = '';
    function pump() {
      if (!sameConv()) {
        try { reader.cancel(); } catch (eC) { }
        endSseStream();
        return Promise.resolve();
      }
      return reader.read().then(function (r) {
        if (!r || r.done) {
          if (buf) { parseSSELines([buf.replace(/\r$/, '')]); buf = ''; }
          if (sameConv()) finishSseStream();
          endSseStream();
          return;
        }
        var chunk = '';
        try { chunk = dec.decode(r.value, { stream: true }); } catch (eD) { chunk = ''; }
        buf += chunk;
        var idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          var line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          parseSSELines([line.replace(/\r$/, '')]);
        }
        return pump();
      });
    }
    pump().catch(function () { if (sameConv()) finishSseStream(); endSseStream(); });
  }

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
        var reason = 'manual:' + state;
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
})();

// v13: экспорт чистого резолвера для контрактного теста (jest/jsdom). В браузере module нет —
// блок не выполняется и на страницу не влияет.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resolveNetworkModelSlug: __aiCmDeepseekResolveModelSlug,
    DEEPSEEK_V4_FLASH_SLUG: AI_CM_DEEPSEEK_V4_FLASH_SLUG
  };
}