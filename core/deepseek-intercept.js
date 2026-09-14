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
// Модель определяется ПОХОДОВО по thinking_enabled: true → r1, иначе → v3.
// model_type (expert/default) не влияет на выбор модели, а передаётся как modelMode в detail.
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
  var REASONING_TAG = '[REASONING]';
  var ANSWER_TAG = '[ANSWER]';
  var MODEL_WINDOW_DEFAULT = 131072;  // совпадает с model-config deepseek-v3/r1

  // ===== СЕКЦИЯ 2: НАКОПИТЕЛИ =====
  var turnsMap = {};          // ключ = String(message_id)
  var orderCounter = 0;
  var attachTokens = 0;
  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
  var loggedOk = false;
  var loggedHistory = false;
  var loggedRealtime = false;

  // ===== СЕКЦИЯ 3: CONV ID + ДЕТЕКТОР СМЕНЫ ЧАТА (образец: gemini v17 + page-intercept v11) =====
  function getConvId() {
    try {
      var m = location.pathname.match(/\/a\/chat\/s\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
      m = location.pathname.match(/\/a\/chat\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  var currentConvId = getConvId();
  var lastAuthHeaders = {};
  var lastLoadedConvId = '';
  var historyRefetchTimer = null;
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

  function resetForNewConversation() {
    turnsMap = {};
    orderCounter = 0;
    attachTokens = 0;
    attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
    loggedOk = false;
    loggedHistory = false;
    loggedRealtime = false;
    lastLoadedConvId = '';
    lastHistoryUrl = '';          // v6
    historyRefetchDone = false;   // v6
    histCompletion.historyComplete = false;  // v7: новая база ещё не подтверждена
    histCompletion.reachedRoot = false;      // v7
    histCompletion.baseEmpty = false;        // v11 (O-17)
    lastBaseServerTokens = 0;                // v11 (O-17)
    lastBaseChatMode = '';                   // v11 (O-17)
    resetStreamState();
    console.log('[deepseek-intercept] смена чата → состояние перехватчика сброшено (convId=' + (currentConvId || '(не чат)') + ')');
    try { window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed')); } catch (e) { }
    scheduleHistoryRefetch();
  }

  function checkConvChange() {
    var newId = getConvId();
    if (newId !== currentConvId) {
      currentConvId = newId;
      resetForNewConversation();
    }
  }

  try {
    var origPush = history.pushState;
    if (origPush) {
      history.pushState = function () {
        var r = origPush.apply(this, arguments);
        try { checkConvChange(); } catch (e) { }
        return r;
      };
    }
    var origReplace = history.replaceState;
    if (origReplace) {
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        try { checkConvChange(); } catch (e) { }
        return r;
      };
    }
    window.addEventListener('popstate', function () { try { checkConvChange(); } catch (e) { } });
  } catch (e) { }

  // ===== СЕКЦИЯ 4: EMIT (контракт как в gemini v21, + serverTokens, + modelMode) =====
  function emitBaseSnapshot(serverTokens, chatMode) {
    serverTokens = (typeof serverTokens === 'number' && serverTokens > 0) ? serverTokens : 0;
    chatMode = chatMode || '';
    lastBaseServerTokens = serverTokens;   // v11 (O-17): для ре-эмита при полноте 0→1
    lastBaseChatMode = chatMode;           // v11 (O-17)
    var ids = Object.keys(turnsMap).sort(function (a, b) {
      return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
    });
    var pieces = [];
    var messages = [];
    var reasonings = [];              // v8: reasoning по ходам (пустая строка — reasoning нет)
    var reasoningTurns = 0;           // v8: сколько ходов реально несут reasoning
    var lastModel = '';
    for (var j = 0; j < ids.length; j++) {
      var t = turnsMap[ids[j]];
      pieces.push(t.text);
      // v7: роль unknown сохраняется КАК ЕСТЬ (не маппится в assistant) — разрешение
      // на уровне отображения (content.js buildHistoryMessages: не-user → assistant).
      // Факт нестандартной роли логируем только под debug-флагом (isDebugEnabled).
      // v8: reasoning хода едет и в messages[], и отдельным массивом reasoningTexts.
      var turnReasoning = t.reasoning || '';
      messages.push({ role: t.role || 'unknown', text: t.text, reasoning: turnReasoning });
      reasonings.push(turnReasoning);
      if (turnReasoning) reasoningTurns++;
      if (!(t.role === 'user' || t.role === 'assistant') && isDebugEnabled()) {
        console.log('[deepseek-intercept] роль "' + (t.role || 'unknown') + '" оставлена как есть (не маппится в assistant)');
      }
      if (t.modelSlug) lastModel = t.modelSlug;
    }
    var text = pieces.join('\n');
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: {
          convId: getConvId() || currentConvId,   // v7: зеркально gemini — stale-conv гард в content.js работает и для DeepSeek
          text: text,
          count: ids.length,
          lastMessageText: pieces.length ? pieces[pieces.length - 1] : '',
          modelSlug: lastModel || '',
          modelMode: chatMode,
          messageTexts: pieces,
          messageIds: ids,
          messages: messages,
          reasoningTexts: reasonings,        // v8: reasoning по ходам ([REASONING]/[ANSWER] уже в messageTexts)
          reasoningTurns: reasoningTurns,    // v8: ходов с непустым reasoning
          attachTokens: attachTokens,
          attachBreak: {
            imgTokens: attachBreak.imgTokens,
            docTokens: attachBreak.docTokens,
            imgCount: attachBreak.imgCount,
            docCount: attachBreak.docCount
          },
          historyComplete: histCompletion.historyComplete,   // v7: честно — true только если обход дошёл до корня
          reachedRoot: histCompletion.reachedRoot,           // v7: доказан ли корень (узел без parent_id)
          baseEmpty: histCompletion.baseEmpty === true,      // v11 (O-17): полнота вынесена по авторитетно пустой базе (наследуется live-эмитами)
          serverTokens: serverTokens
        }
      }));
    } catch (e) { }
    return { count: ids.length, textLen: text.length, lastModel: lastModel, serverTokens: serverTokens, reasoningTurns: reasoningTurns };
  }

  // v11 (O-17): сводка turnsMap для дампов в момент экспорта (aiCmDumpTurnsSnapshot,
  // core/base-handler.js). DeepSeek раньше на мост не отвечал (мост Gemini), поэтому в живом
  // логе «snapshot-at-manual msgs=0 firstText=""» читалось как ПУСТОЙ turnsMap, хотя база была
  // собрана: фолбэк дампа подставляет msgs только когда передан массив, а ручной путь
  // (content.js) передаёт null. Теперь msgs — реальное число ходов перехватчика.
  function clipTurnText(t) {
    try { return String((t && t.text) || '').slice(0, 80).replace(/\s+/g, ' '); } catch (e) { return ''; }
  }
  function turnsSnapshot() {
    var ids = Object.keys(turnsMap).sort(function (a, b) {
      return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
    });
    var first = ids.length ? turnsMap[ids[0]] : null;
    var last = ids.length ? turnsMap[ids[ids.length - 1]] : null;
    return {
      convId: currentConvId || getConvId() || '',
      msgs: ids.length,
      firstText: clipTurnText(first),
      lastText: clipTurnText(last),
      baseComplete: histCompletion.historyComplete === true,
      // v11 (O-17): начало истории на DeepSeek не требует скролла — вердикт полноты тот же,
      // что и у базы; скролл-подтверждений у сервиса нет вовсе.
      reachedStart: histCompletion.historyComplete === true,
      confirmedByScroll: false,
      scrollEngaged: false,
      baseMsgs: ids.length,
      liveCount: ids.length,
      archiveCount: 0
    };
  }
  try {
    window.addEventListener('ai-cm-turns-snap-request', function () {
      try {
        window.dispatchEvent(new CustomEvent('ai-cm-turns-snap-response', { detail: turnsSnapshot() }));
      } catch (eTurnsResp) { }
    });
  } catch (eTurnsBridge) { }

  // ===== СЕКЦИЯ 5: МОДЕЛЬ (походово по thinking_enabled, без DOM) =====
  function getModelSlug(thinkingEnabled) {
    return thinkingEnabled === true ? 'deepseek-r1' : 'deepseek-v3';
  }

  // ===== СЕКЦИЯ 6: АКТИВНАЯ ЦЕПОЧКА (walk по parent_id, ловушка №1) =====
  // v6: возвращает { chain, truncated }
  //   - truncated = false: дошли до корня (parent_id === null/undefined) — норма
  //   - truncated = true: walk остановился, потому что следующий parent_id не null,
  //     но сообщения с таким id нет в messagesById — цепочка оборвана (усечение)
  function buildActiveChain(chatSession, messagesById) {
    var chain = [];
    var currentId = chatSession.current_message_id;
    var visited = {};
    var truncated = false;
    // v7: reachedRoot — true, когда обход довёл цепочку до корня (узел без parent_id),
    // т.е. цикл завершился по исчерпанию parent_id, а не по обрыву/циклу/пустой цепочке
    var reachedRoot = false;
    while (currentId != null && currentId !== undefined) {
      var msg = messagesById[currentId];
      if (!msg) {
        // parent_id не null, но сообщение отсутствует в полученном chat_messages → усечение
        truncated = true;
        break;
      }
      if (visited[currentId]) break;   // защита от циклов
      visited[currentId] = true;
      chain.push(msg);
      currentId = msg.parent_id;
    }
    reachedRoot = !truncated && chain.length > 0 && (currentId == null || currentId === undefined);
    chain.reverse();
    // v7: sort по inserted_at УБРАН. WHY:
    //  (1) inserted_at — ISO-строка ('2026-08-29T..Z'), вычитание строк даёт NaN →
    //      компаратор недетерминирован, порядок зависит от реализации sort;
    //  (2) внутри пары (user,assistant одного хода) серверный inserted_at ставит
    //      assistant РАНЬШЕ user → сортировка ИНВЕРТИРУЕТ пару (a,u,a,u вместо u,a,u,a).
    //  Единственный источник хронологии — обход parent_id + chain.reverse() выше.
    return { chain: chain, truncated: truncated, reachedRoot: reachedRoot };
  }

  // ===== СЕКЦИЯ 7: СБОР ТЕКСТА ХОДА (по type, не по порядку фрагментов) =====
  // v8: ответ хода — ТОЛЬКО фрагменты RESPONSE; THINK собирается отдельно (collectTurnReasoning).
  function collectTurnText(fragments, role) {
    var types = (role === 'USER') ? ['REQUEST'] : ['RESPONSE'];
    var parts = [];
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (types.indexOf(f.type) !== -1 && typeof f.content === 'string') {
        parts.push(f.content);
      }
      // TIP — всегда игнорируем
    }
    return parts.join('').trim();
  }

  // v8 (O-7): reasoning хода — фрагменты type === 'THINK' (цепочка рассуждений DeepSeek).
  // У USER-хода reasoning нет по определению. TIP/TEMPLATE_RESPONSE игнорируем.
  function collectTurnReasoning(fragments, role) {
    if (role === 'USER') return '';
    var parts = [];
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (f && f.type === 'THINK' && typeof f.content === 'string') {
        parts.push(f.content);
      }
    }
    return parts.join('').trim();
  }

  // v8 (O-7): формат экспортного текста хода с reasoning:
  //   [REASONING]\n<рассуждение>\n\n[ANSWER]\n<ответ>
  // Нет reasoning (или фича выключена) → текст хода байтово прежний (только ответ).
  function composeTurnText(answer, reasoning) {
    if (!REASONING_ENABLED || !reasoning) return answer;
    return REASONING_TAG + '\n' + reasoning + '\n\n' + ANSWER_TAG + '\n' + answer;
  }

  // ===== СЕКЦИЯ 8: ПАРСИНГ history_messages =====
  // v6: детектор усечения активной цепочки + однократный тихий дозапрос полной истории
  function ingestHistory(jsonBody) {
    try {
      if (jsonBody.code !== 0) return;
      var bizData = jsonBody.data && jsonBody.data.biz_data;
      if (!bizData) return;
      var chatSession = bizData.chat_session;
      var chatMessages = bizData.chat_messages;
      if (!chatSession || !Array.isArray(chatMessages)) return;

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
      if (!chain.length && chatMessages.length === 0 && !baseEmptyAuthoritative && !historyRefetchDone) {
        historyRefetchDone = true;
        console.log('[deepseek-intercept] пустой кеш (MERGE) без авторитетной пустоты → тихий дозапрос полной истории (без cache_version)');
        refetchFullHistory(lastHistoryUrl, lastAuthHeaders, currentConvId);
        return;
      }

      if (!chain.length) {
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
            emitBaseSnapshot(lastBaseServerTokens, lastBaseChatMode);
          }
        }
        // turnsMap НЕ трогаем: авторитетно пустой ответ не повод стирать live-ходы
        // (иначе следующий realtime-финал публикует СХЛОПНУВШУЮСЯ базу — живой лог: msgs=1..2
        // в записи истории при 4 ходах в чате).
        return;
      }

      // v6: ДЕТЕКТОР УСЕЧЕНИЯ — если цепочка оборвана и дозапрос ещё не делался
      if (truncated && !historyRefetchDone) {
        historyRefetchDone = true;
        // НЕ помечаем loggedHistory = true — лог и диагностический дамп сработают на полной истории
        console.log('[deepseek-intercept] кеш усечён (цепочка оборвана) → тихий дозапрос полной истории (без cache_version)');
        refetchFullHistory(lastHistoryUrl, lastAuthHeaders, currentConvId);
        return; // не обрабатываем усечённый ответ — ждём полный (собранные live-ходы сохранены)
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
            modelSlug: getModelSlug(ch.thinking_enabled === true),
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
          modelSlug: getModelSlug(ch.thinking_enabled === true),
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

      // УСЛОВИЕ 1: accumulated_token_usage — максимум по всем сообщениям цепочки (накопительное, монотонно растёт)
      var lastAccumulated = 0;
      for (var ci = 0; ci < chain.length; ci++) {
        var at = chain[ci].accumulated_token_usage;
        if (typeof at === 'number' && at > lastAccumulated) {
          lastAccumulated = at;
        }
      }

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

  // v10 (O-16): снимок состояния потока наружу (ISOLATED-мир). convId — тот же, что в
  // detail ai-cm-full-history (stale-conv гард экспортёра работает и здесь).
  function streamStateSnapshot() {
    return {
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
  }
  // v10 (O-16): тело ответа дочитано (или оборвано) — стрима больше нет.
  function endSseStream() {
    if (!sseStreamActive) return;
    sseStreamActive = false;
    dispatchStreamState('end');
  }

  function resetStreamState() {
    sseStreamActive = false;   // v10 (O-16)
    sseTurnFinished = false;   // v10 (O-16)
    sseLastPath = null;
    sseLastOp = null;
    sseRealtimeEntryTokens = 0;
    sseRealtimeFinalTokens = 0;
    sseRequestMessageId = null;
    sseResponseMessageId = null;
    sseModelType = null;
    sseUserPrompt = '';
    sseParentMessageId = null;
    sseThinkingEnabled = null;
    sseFragments = [];       // v9
    sseFragmentTypes = [];   // v9
    sseCurrentEvent = '';    // v9
  }

  // v9 (O-15): последний фрагмент потока — цель пути response/fragments/-1/content.
  function streamLastFragment() {
    return sseFragments.length ? sseFragments[sseFragments.length - 1] : null;
  }
  function streamPushFragment(type, content) {
    if (typeof type !== 'string' || !type) return null;
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
  function streamOtherText() {
    var parts = [];
    for (var i = 0; i < sseFragments.length; i++) {
      var f = sseFragments[i];
      if (f && f.type !== 'THINK' && f.type !== 'RESPONSE' && typeof f.content === 'string') parts.push(f.content);
    }
    return parts.join('').trim();
  }

  function processChunk(path, op, val) {
    // v9 (O-15): сокращённый чанк может прийти и после чанка массива фрагментов. Строка —
    // это либо объявление типа ('THINK'), либо порция КОНТЕНТА последнего фрагмента
    // (иначе текст молча терялся). Различаем по форме: типы — ВЕРХНИЙ_РЕГИСТР.
    if (typeof val === 'string' && (path === 'response/fragments' || path === 'fragments')) {
      if (/^[A-Z][A-Z_]{2,}$/.test(val)) { streamPushFragment(val, ''); return; }
      var fStr = streamLastFragment();
      if (!fStr) return;
      if (op === 'SET') streamSetContent(fStr, val); else streamAppendContent(fStr, val);
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
    if (path === 'response/fragments/-1/content') {
      var f = streamLastFragment();
      if (!f) return;
      if (op === 'APPEND') { streamAppendContent(f, val); return; }
      if (op === 'SET') { streamSetContent(f, val); return; }
    }
  }

  function finalizeRealtimeTurn() {
    if (!sseRequestMessageId || !sseResponseMessageId) return;

    // v9 (O-15): ответ и reasoning — из ОДНОГО массива фрагментов потока, теми же
    // правилами, что и history_messages.
    var answerText = streamFragmentText('RESPONSE');
    if (!answerText) answerText = streamOtherText();   // аварийный фолбэк (незнакомый тип)
    var sseReasoning = REASONING_ENABLED ? streamFragmentText('THINK') : '';

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
        modelSlug: getModelSlug(sseThinkingEnabled === true),
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
        ex.answer = nextAnswer;
        ex.reasoning = nextReasoning;
        ex.text = composeTurnText(nextAnswer, nextReasoning);
      }
    }

    // Числитель = финальный accumulated_token_usage из BATCH (фолбэк — entry из первого response)
    var serverTokens = sseRealtimeFinalTokens || sseRealtimeEntryTokens || 0;

    // chatMode для realtime = sseModelType (expert/default/null)
    var chatMode = sseModelType || '';

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

      // === update_session (игнорируем, только updated_at) ===
      if (sseCurrentEvent === 'update_session') {
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

  // ===== СЕКЦИЯ 10: ГАРД ПЕРЕКРЁСТА (chat_session_id vs currentConvId) =====
  function convIdFromHistoryUrl(url) {
    try {
      var m = url.match(/[?&]chat_session_id=([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function convIdFromCompletionBody(bodyStr) {
    try {
      if (typeof bodyStr !== 'string' || !bodyStr) return '';
      var obj = JSON.parse(bodyStr);
      return obj.chat_session_id || '';
    } catch (e) { return ''; }
  }

  function guardCheck(reqConvId) {
    if (!reqConvId) return true;   // не удалось извлечь — пропускаем (не блокируем)
    if (reqConvId !== currentConvId) {
      console.log('[deepseek-intercept] пропущен ответ (convId запроса ' + reqConvId + ' != текущий ' + currentConvId + ')');
      return false;
    }
    return true;
  }

  // ===== СЕКЦИЯ 10B: ХЕЛПЕРЫ ДЛЯ MERGE-ДОЗАПРОСА =====

  // Сбор заголовков из fetch-запроса в plain object (поддержка Headers, Array, Object)
  function collectHeaders(input, init) {
    var h = {};
    try {
      var src = (init && init.headers) || (input && input.headers ? input.headers : null);
      if (!src) return h;
      // Headers-объект (forEach существует)
      if (typeof src.forEach === 'function') {
        src.forEach(function (v, k) { h[k] = v; });
      } else if (Array.isArray(src)) {
        for (var i = 0; i < src.length; i++) {
          if (Array.isArray(src[i]) && src[i].length >= 2) h[src[i][0]] = src[i][1];
        }
      } else if (typeof src === 'object') {
        var keys = Object.keys(src);
        for (var i = 0; i < keys.length; i++) {
          h[keys[i]] = src[keys[i]];
        }
      }
    } catch (e) { }
    return h;
  }

  // Удаление cache_version и cache_reset_at из URL (оставляем chat_session_id и всё остальное)
  function stripCacheParams(url) {
    try {
      var u = new URL(url, location.origin);
      u.searchParams.delete('cache_version');
      u.searchParams.delete('cache_reset_at');
      return u.toString();
    } catch (e) {
      return url.replace(/[?&]cache_(version|reset_at)=[^&]*/g, '').replace(/\?$/, '');
    }
  }

  // v11 (O-17): КАНОНИЧЕСКИЙ URL полной истории текущего чата (без cache-параметров).
  // Единственный источник для обоих дозапросов (таймер после SPA-смены чата и детектор
  // усечения/MERGE) — чужой URL в базу попасть не может по построению.
  function historyRefetchUrl() {
    return location.origin + '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(currentConvId);
  }

  // URL пригоден для дозапроса, только если он про историю И про ЭТОТ чат.
  // v11 (O-17): после SPA-перехода lastHistoryUrl хранит запрос ПРЕДЫДУЩЕГО чата —
  // его использование вливало в базу текущего чата чужую историю (ingestHistory идёт
  // без conv-гарда: гард стоит на вызывающей стороне).
  function historyUrlForConv(url, convId) {
    try {
      if (typeof url !== 'string' || url.indexOf('history_messages') === -1) return '';
      var urlConv = convIdFromHistoryUrl(url);
      if (!urlConv) return '';                    // чат в URL не назван — берём канонический
      if (convId && urlConv !== convId) return '';
      return stripCacheParams(url);
    } catch (e) { return ''; }
  }

  // Тихий повторный запрос полной истории БЕЗ cache_version/cache_reset_at
  // Использует originalFetch (нативный fetch ДО нашей обёртки) — рекурсия исключена по построению
  function refetchFullHistory(originalUrl, authHeaders, convId) {
    if (!convId || convId !== currentConvId) { return; }
    // v11 (O-17): берём переданный URL ТОЛЬКО если он про этот же чат, иначе — канонический
    var cleanUrl = historyUrlForConv(originalUrl, convId) || historyRefetchUrl();
    originalFetch(cleanUrl, {
      method: 'GET',
      headers: authHeaders || {}
    }).then(function (r) {
      if (r && r.ok) return r.json();
      return null;
    }).then(function (json) {
      if (json && convId === currentConvId) {
        ingestHistory(json);
      }
    }).catch(function (e) {
      console.warn('[deepseek-intercept] refetchFullHistory ошибка:', e);
    });
  }

  // Таймер-дозапрос после смены чата (если сайт не прислал историю сам)
  function scheduleHistoryRefetch() {
    try { clearTimeout(historyRefetchTimer); } catch (e) { }
    historyRefetchTimer = setTimeout(function () {
      try {
        if (currentConvId && currentConvId !== lastLoadedConvId && lastAuthHeaders && (lastAuthHeaders.Authorization || lastAuthHeaders.authorization)) {
          console.log('[deepseek-intercept] история не пришла после смены чата → тихий дозапрос по таймеру (convId=' + currentConvId + ')');
          refetchFullHistory(historyRefetchUrl(), lastAuthHeaders, currentConvId);   // v11 (O-17): канонический URL
        }
      } catch (e) { }
    }, 1000);
  }

  // ===== СЕКЦИЯ 11: ПЕРЕХВАТ FETCH (v5: тихий catch + устранение висячих Promise.reject) =====
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { }
      var method = (init && init.method) ? String(init.method).toUpperCase() : 'GET';

      // Сбор заголовков ВСЕХ запросов (для сохранения auth)
      var allH = collectHeaders(input, init);
      if (allH.Authorization || allH.authorization) lastAuthHeaders = allH;

      // --- история: URL содержит "history_messages" ---
      var isHistory = (url.indexOf('history_messages') !== -1);
      var historyConvId = '';
      var historyAuthHeaders = null;
      if (isHistory) {
        historyConvId = convIdFromHistoryUrl(url);
        historyAuthHeaders = allH;
        lastHistoryUrl = url;   // v6: сохраняем URL для возможного дозапроса при усечении
      }

      // --- отправка: URL содержит "completion", метод POST ---
      var isCompletion = (url.indexOf('completion') !== -1 && method === 'POST');
      var completionConvId = '';
      if (isCompletion) {
        var bodyStr = '';
        try {
          if (init && typeof init.body === 'string') {
            bodyStr = init.body;
            var payload = JSON.parse(bodyStr);
            sseUserPrompt = payload.prompt || '';
            sseParentMessageId = payload.parent_message_id || null;
            sseThinkingEnabled = payload.thinking_enabled;        // сохраняем для getModelSlug
            completionConvId = payload.chat_session_id || '';
          }
        } catch (e) { }
      }

      var promise;
      try { promise = originalFetch.apply(this, arguments); } catch (e) { return Promise.reject(e); }

      // v5: тихий catch — снимает ложный unhandled rejection для чужих прерванных запросов
      // (Failed to fetch при навигации/переключении/обрыве стрима), не меняя поведения страницы
      promise.catch(function () { /* тихо: снимаем ложный unhandled для чужих прерванных запросов */ });

      // обработка ответа истории
      if (isHistory) {
        promise.then(function (resp) {
          try {
            if (resp && resp.ok && guardCheck(historyConvId)) {
              resp.clone().json().then(function (json) {
                // Проверка «пусто+MERGE»: сервер вернул пустой chat_messages при is_empty!==true
                var bd = json && json.data && json.data.biz_data;
                if (bd) {
                  var cs = bd.chat_session;
                  var emptyMERGE = cs && cs.is_empty !== true && (!Array.isArray(bd.chat_messages) || bd.chat_messages.length === 0);
                  if (emptyMERGE && guardCheck(historyConvId)) {
                    console.log('[deepseek-intercept] кеш MERGE → тихий дозапрос полной истории (без cache_version)');
                    lastLoadedConvId = currentConvId;
                    refetchFullHistory(url, historyAuthHeaders, historyConvId);
                    return;
                  }
                }
                ingestHistory(json);
              }).catch(function () { });
            }
          } catch (e) { }
          return resp;
        }, function () { /* v5: тихо — не создаём висячий Promise.reject */ });
      }

      // обработка ответа стрима (v9: инкрементально — терминальный чанк закрывает ход
      // сразу, не дожидаясь конца тела ответа)
      if (isCompletion) {
        promise.then(function (resp) {
          try {
            if (resp && resp.ok && guardCheck(completionConvId)) {
              consumeSseResponse(resp, completionConvId);
            }
          } catch (e) { }
          return resp;
        }, function () { /* v5: тихо — не создаём висячий Promise.reject */ });
      }

      return promise;
    };
  }

  // ===== СЕКЦИЯ 12: ПЕРЕХВАТ XHR (зеркалит fetch, +setRequestHeader-копилка) =====
  if (originalXHROpen && originalXHRSend) {
    // Обёртка setRequestHeader — копим заголовки для повторного запроса при MERGE
    var originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
    if (originalSetRequestHeader) {
      OriginalXHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (this.__aiCmDs && this.__aiCmDs.headers) {
            this.__aiCmDs.headers[name] = value;
          }
        } catch (e) { }
        return originalSetRequestHeader.apply(this, arguments);
      };
    }

    OriginalXHR.prototype.open = function (method, url) {
      try {
        this.__aiCmDs = {
          method: String(method).toUpperCase(),
          url: String(url),
          completionBody: null,
          completionConvId: '',
          historyConvId: '',
          headers: {}
        };
      } catch (e) { }
      return originalXHROpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function (body) {
      var info = this.__aiCmDs;
      if (!info) return originalXHRSend.apply(this, arguments);

      // Сохраняем auth-заголовки при наличии Authorization
      if (info.headers && (info.headers.Authorization || info.headers.authorization)) lastAuthHeaders = info.headers;

      var url = info.url || '';
      var method = info.method || 'GET';

      // --- история ---
      if (url.indexOf('history_messages') !== -1) {
        info.historyConvId = convIdFromHistoryUrl(url);
        lastHistoryUrl = url;   // v6: сохраняем URL для возможного дозапроса при усечении
      }

      // --- отправка ---
      if (url.indexOf('completion') !== -1 && method === 'POST') {
        var bodyStr = (typeof body === 'string') ? body : '';
        info.completionBody = bodyStr;
        info.completionConvId = convIdFromCompletionBody(bodyStr);
        try {
          if (bodyStr) {
            var payload = JSON.parse(bodyStr);
            sseUserPrompt = payload.prompt || '';
            sseParentMessageId = payload.parent_message_id || null;
            sseThinkingEnabled = payload.thinking_enabled;
          }
        } catch (e) { }
      }

      var self = this;

      // обработка ответа (load)
      this.addEventListener('load', function () {
        var info2 = self.__aiCmDs;
        if (!info2) return;
        try {
          if (self.status < 200 || self.status >= 300) return;
          if (!self.responseText) return;

          var loadUrl = info2.url || '';

          // история
          if (loadUrl.indexOf('history_messages') !== -1) {
            if (guardCheck(info2.historyConvId)) {
              try {
                var jsonH = JSON.parse(self.responseText);
                // Проверка «пусто+MERGE»: сервер вернул пустой chat_messages при is_empty!==true
                var bdH = jsonH && jsonH.data && jsonH.data.biz_data;
                if (bdH) {
                  var csH = bdH.chat_session;
                  var emptyMERGE = csH && csH.is_empty !== true && (!Array.isArray(bdH.chat_messages) || bdH.chat_messages.length === 0);
                  if (emptyMERGE && guardCheck(info2.historyConvId)) {
                    console.log('[deepseek-intercept] кеш MERGE → тихий дозапрос полной истории (без cache_version)');
                    lastLoadedConvId = currentConvId;
                    refetchFullHistory(loadUrl, info2.headers || {}, info2.historyConvId);
                    return;
                  }
                }
                ingestHistory(jsonH);
              } catch (e) { }
            }
          }

          // стрим
          if (loadUrl.indexOf('completion') !== -1 && info2.method === 'POST') {
            if (guardCheck(info2.completionConvId)) {
              parseSSE(self.responseText);
            }
          }
        } catch (e) { }
      });

      return originalXHRSend.apply(this, arguments);
    };
  }

  // ===== СЕКЦИЯ 13: ДИАГНОСТИЧЕСКИЙ ДАМП (только при sessionStorage aiCmDebug === '1') =====

  function isDebugEnabled() {
    try {
      return sessionStorage.getItem('aiCmDebug') === '1';
    } catch (e) { return false; }
  }

  function getNavigationType() {
    try {
      var entries = performance.getEntriesByType('navigation');
      if (entries && entries.length > 0) {
        return entries[0].type || '';
      }
    } catch (e) { }
    return '';
  }

  function determineState() {
    var navType = getNavigationType();
    var convPrefix = '';
    try { convPrefix = (currentConvId || '').slice(0, 8); } catch (e) { }
    var visitedKey = '';
    var wasVisited = false;
    if (convPrefix) {
      visitedKey = 'aiCmVisited:' + convPrefix;
      try { wasVisited = sessionStorage.getItem(visitedKey) === '1'; } catch (e) { }
    }

    if (navType === 'reload' || navType === 'back_forward') {
      return { state: 'after_f5', reason: 'navigationType=' + navType + ', convId=' + convPrefix, navType: navType };
    }
    if (wasVisited) {
      return { state: 'after_f5', reason: 'sessionStorage marker found for ' + convPrefix, navType: navType };
    }
    if (convPrefix) {
      try { sessionStorage.setItem(visitedKey, '1'); } catch (e) { }
    }
    return { state: 'open', reason: 'first visit (nav=' + (navType || 'unknown') + ', convId=' + convPrefix + ')', navType: navType };
  }

  // Нормализация роли: USER→user, ASSISTANT→assistant, иначе→unknown
  function normalizeRole(rawRole) {
    if (!rawRole) return 'unknown';
    if (rawRole === 'USER') return 'user';
    if (rawRole === 'ASSISTANT') return 'assistant';
    return 'unknown';
  }

  function buildMessagesFromRaw(chatMessages, chain) {
    var chainIds = {};
    for (var ci = 0; ci < chain.length; ci++) {
      chainIds[String(chain[ci].message_id)] = true;
    }

    var messages = [];
    for (var i = 0; i < chatMessages.length; i++) {
      var msg = chatMessages[i];
      var mid = String(msg.message_id || '');
      var totalLen = 0;
      var thinkLen = 0;   // v8 (O-7): длина reasoning-фрагментов (type === 'THINK')
      var hasContent = false;
      var frags = Array.isArray(msg.fragments) ? msg.fragments : [];
      for (var fi = 0; fi < frags.length; fi++) {
        if (typeof frags[fi].content === 'string') {
          totalLen += frags[fi].content.length;
        }
        if (frags[fi] && frags[fi].type === 'THINK' && typeof frags[fi].content === 'string') {
          thinkLen += frags[fi].content.length;
        }
      }
      if (totalLen > 0) hasContent = true;

      var atts = Array.isArray(msg.attachments) ? msg.attachments : [];
      var attCount = atts.length;
      var attTokens = null;
      if (attCount > 0) {
        attTokens = 0;
        for (var ai = 0; ai < atts.length; ai++) {
          var a = atts[ai];
          if (a && typeof a.token_count === 'number') attTokens += a.token_count;
        }
        if (attTokens === 0) attTokens = null;
      }

      messages.push({
        index: i,
        messageIdPrefix: mid.slice(0, 8),
        role: normalizeRole(msg.role),
        hasContent: hasContent,
        contentLength: totalLen,
        reasoningLength: thinkLen,        // v8 (O-7): символов reasoning (THINK) в сообщении
        hasReasoning: thinkLen > 0,       // v8
        inActiveChain: !!chainIds[mid],
        hasTokenField: typeof msg.accumulated_token_usage === 'number',
        tokenFieldName: 'accumulated_token_usage',
        tokenValue: typeof msg.accumulated_token_usage === 'number' ? msg.accumulated_token_usage : null,
        hasParentId: !!msg.parent_id,
        parentIdPrefix: msg.parent_id ? String(msg.parent_id).slice(0, 8) : null,
        hasAttachments: attCount > 0,
        attachmentCount: attCount,
        attachmentTokens: attTokens,
        hasThinkingEnabled: typeof msg.thinking_enabled === 'boolean',
        thinkingEnabled: typeof msg.thinking_enabled === 'boolean' ? msg.thinking_enabled : null
      });
    }
    return messages;
  }

  function buildMessagesFromTurnsMap() {
    var ids = Object.keys(turnsMap);
    // Сортируем по order, при одинаковом — по ts
    var orderSource = 'order';
    var hasOrder = true;
    var hasTs = true;
    for (var k = 0; k < ids.length; k++) {
      var t = turnsMap[ids[k]];
      if (typeof t.order !== 'number') { hasOrder = false; }
      if (typeof t.ts !== 'number') { hasTs = false; }
    }
    if (!hasOrder) orderSource = 'keys_unknown';

    ids.sort(function (a, b) {
      var oa = turnsMap[a].order;
      var ob = turnsMap[b].order;
      if (typeof oa === 'number' && typeof ob === 'number') {
        if (oa !== ob) return oa - ob;
        // при одинаковом order — по ts
        var tsa = turnsMap[a].ts;
        var tsb = turnsMap[b].ts;
        if (typeof tsa === 'number' && typeof tsb === 'number') return tsa - tsb;
        return 0;
      }
      if (typeof oa === 'number') return -1;
      if (typeof ob === 'number') return 1;
      // оба без order — по ts если доступно
      var tsa2 = turnsMap[a].ts;
      var tsb2 = turnsMap[b].ts;
      if (typeof tsa2 === 'number' && typeof tsb2 === 'number') return tsa2 - tsb2;
      return 0;
    });

    var messages = [];
    for (var i = 0; i < ids.length; i++) {
      var ti = turnsMap[ids[i]];
      var role = (ti.role === 'user' || ti.role === 'assistant') ? ti.role : 'unknown';

      messages.push({
        index: i,
        messageIdPrefix: ids[i].slice(0, 8),
        role: role,
        hasContent: !!ti.text && ti.text.length > 0,
        contentLength: ti.text ? ti.text.length : 0,
        inActiveChain: null,
        hasTokenField: false,
        tokenFieldName: null,
        tokenValue: null,
        hasParentId: null,
        parentIdPrefix: null,
        hasAttachments: null,
        attachmentCount: null,
        attachmentTokens: null,
        hasThinkingEnabled: null,
        thinkingEnabled: null,
        modelSlug: ti.modelSlug || null,
        hasReasoning: !!ti.reasoning,               // v8 (O-7)
        reasoningLength: ti.reasoning ? ti.reasoning.length : 0   // v8
      });
    }

    return { messages: messages, orderSource: orderSource };
  }

  function dumpHistorySnapshot(state, stateReason, ctx) {
    // Вызывается ТОЛЬКО после проверки isDebugEnabled() в точках вызова
    try {
      ctx = ctx || {};
      var nowTs = Date.now();
      var convPrefix = '';
      try { convPrefix = (currentConvId || '').slice(0, 8); } catch (e) { }

      // Виджет-процент из DOM
      var widgetPercent = null;
      var widgetPercentRaw = null;
      var widgetPercentSource = 'none';
      try {
        var widgetEl = document.querySelector('.ai-widget-text');
        if (widgetEl) {
          widgetPercentRaw = widgetEl.textContent || '';
          var pctMatch = widgetPercentRaw.match(/([0-9]+(?:\.[0-9]+)?)/);
          if (pctMatch) {
            widgetPercent = parseFloat(pctMatch[1]);
            widgetPercentSource = 'dom';
          }
        }
      } catch (e) { }

      // Модель — по последнему ходу по order (упорядоченный turnsMap)
      var lastModel = '';
      var tmIds = Object.keys(turnsMap).sort(function (a, b) {
        return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
      });
      for (var j = 0; j < tmIds.length; j++) {
        var t = turnsMap[tmIds[j]];
        if (t.modelSlug) lastModel = t.modelSlug;
      }

      var modelMode = '';
      if (typeof ctx.chatMode === 'string') modelMode = ctx.chatMode;
      if (typeof ctx.modelType === 'string' && ctx.modelType) modelMode = ctx.modelType;

      // serverTokens
      var stUsed = null;
      var stSource = 'none';
      var stAccumulated = null;
      var stSseEntry = null;
      var stSseFinal = null;

      if (ctx.lastAccumulated !== undefined) {
        stAccumulated = (typeof ctx.lastAccumulated === 'number' && ctx.lastAccumulated > 0) ? ctx.lastAccumulated : null;
        stUsed = stAccumulated;
        stSource = 'accumulated_last_message';
      }
      if (ctx.sseEntry !== undefined) {
        stSseEntry = (typeof ctx.sseEntry === 'number' && ctx.sseEntry > 0) ? ctx.sseEntry : null;
      }
      if (ctx.sseFinal !== undefined) {
        stSseFinal = (typeof ctx.sseFinal === 'number' && ctx.sseFinal > 0) ? ctx.sseFinal : null;
      }
      // SSE приоритетнее — перезаписывает used/source
      if (stSseFinal !== null) {
        stUsed = stSseFinal;
        stSource = 'sse_final_batch';
      } else if (stSseEntry !== null) {
        stUsed = stSseEntry;
        stSource = 'sse_entry_response';
      }

      // Сообщения
      var messages;
      var messagesSource;
      var messagesOrderSource = null;
      var rawMessagesCount = null;
      var activeChainCount = null;
      if (Array.isArray(ctx.chatMessages)) {
        var chain = Array.isArray(ctx.chain) ? ctx.chain : [];
        messages = buildMessagesFromRaw(ctx.chatMessages, chain);
        messagesSource = 'chat_messages_raw';
        messagesOrderSource = 'raw_array_order';
        rawMessagesCount = ctx.chatMessages.length;
        activeChainCount = chain.length;
      } else {
        var tmResult = buildMessagesFromTurnsMap();
        messages = tmResult.messages;
        messagesSource = 'turns_map';
        messagesOrderSource = tmResult.orderSource;
      }

      var turnsMapSize = Object.keys(turnsMap).length;

      // Статистика
      var userCount = 0;
      var assistantCount = 0;
      var unknownCount = 0;
      var totalContentLength = 0;
      var reasoningMessages = 0;        // v8 (O-7)
      var totalReasoningLength = 0;     // v8
      var maxTokenValue = null;
      var lastTokenValue = null;
      for (var mi = 0; mi < messages.length; mi++) {
        var m = messages[mi];
        if (m.role === 'user') userCount++;
        else if (m.role === 'assistant') assistantCount++;
        else unknownCount++;
        if (typeof m.contentLength === 'number') totalContentLength += m.contentLength;
        if (m.hasReasoning) { reasoningMessages++; totalReasoningLength += (m.reasoningLength || 0); }   // v8
        if (typeof m.tokenValue === 'number') {
          lastTokenValue = m.tokenValue;
          if (maxTokenValue === null || m.tokenValue > maxTokenValue) {
            maxTokenValue = m.tokenValue;
          }
        }
      }

      // historyFullByNetwork: только для ingestHistory и только если реально дошли до корня
      var capPoint = ctx.capturePoint || 'unknown';
      var hfbn = null;
      if (capPoint === 'ingestHistory') {
        hfbn = histCompletion.historyComplete;
      }

      var dump = {
        ai: 'deepseek',
        state: state,
        stateReason: stateReason || '',
        navigationType: ctx.navType || '',
        capturedAt: nowTs,
        capturePoint: capPoint,
        convIdPrefix: convPrefix || null,
        widgetPercent: widgetPercent,
        widgetPercentRaw: widgetPercentRaw,
        widgetPercentSource: widgetPercentSource,
        model: lastModel || null,
        modelMode: modelMode || null,
        flags: {
          historyFullByNetwork: hfbn,
          historyComplete: histCompletion.historyComplete,   // v7: честная полнота
          reachedRoot: histCompletion.reachedRoot,           // v7: доказан ли корень
          loggedHistory: loggedHistory,
          loggedRealtime: loggedRealtime,
          reasoningEnabled: REASONING_ENABLED    // v8 (O-7)
        },
        serverTokens: {
          used: stUsed,
          source: stSource,
          accumulatedFromLastMessage: stAccumulated,
          sseEntryTokens: stSseEntry,
          sseFinalTokens: stSseFinal
        },
        messages: messages,
        summary: {
          totalMessages: messages.length,
          userMessages: userCount,
          assistantMessages: assistantCount,
          unknownMessages: unknownCount,
          totalContentLength: totalContentLength,
          reasoningMessages: reasoningMessages,           // v8 (O-7): сообщений с непустым reasoning
          totalReasoningLength: totalReasoningLength,     // v8 (O-7)
          sumTokenFields: null,
          maxTokenValue: maxTokenValue,
          lastTokenValue: lastTokenValue,
          tokenFieldPolicy: 'cumulative_not_summable',
          rawMessagesCount: rawMessagesCount,
          activeChainCount: activeChainCount,
          turnsMapSize: turnsMapSize,
          historyLoadedTurns: turnsMapSize,
          messagesSource: messagesSource,
          messagesOrderSource: messagesOrderSource
        }
      };

      try {
        console.log('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP\n' + JSON.stringify(dump, null, 2));
      } catch (jsonErr) {
        console.warn('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP ошибка сериализации:', jsonErr);
      }
    } catch (e) {
      console.warn('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP ошибка дампа:', e);
    }
  }

  // ===== СЕКЦИЯ 14: ФИНАЛ =====
  console.log('[deepseek-intercept] перехватчик DeepSeek v11 установлен (server-first, walk parent_id, SSE инкрементально И постфактум, USER+ASSISTANT оба хода, ход = user + assistant(reasoning+answer), фрагменты потока как fragments[] истории (без потери контента чанков), терминал хода по BATCH/close/концу тела, historyComplete по reachedRoot ИЛИ авторитетно пустой базе (O-17: единый критерий для первичной загрузки и тихого дозапроса после SPA-смены чата), turnsMap сбрасывается только принятым снимком (O-17), serverTokens из accumulated_token_usage, +self-fetch при MERGE, +per-turn model по thinking_enabled, +modelMode в detail, +timer-refetch on switch, +подавление чужих unhandled fetch, +детектор усечения цепочки с дозапросом, +convId в detail, +unknown-роль без маппинга, +reasoning THINK секциями [REASONING]/[ANSWER], +O-16 живой поток не замораживает ход: повторный финал обогащает текст, probe/flush-мост для экспортёра, +O-17 мост turnsMap для дампов экспорта)');

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
})();