// =============================================================================
// core/deepseek-ingest.js — Step D.8 (декомпозиция core/deepseek-intercept.js).
// K5: INGEST (СЕКЦИЯ 8 ядра, строки 340-614 HEAD 2623b3a, 275 строк) — приёмка
// авторитетного сетевого снимка history_messages: Map<message_id,msg>, восстановление
// активной цепочки (buildActiveChain, ловушка №1), v6-детектор усечения цепочки с
// однократным тихим дозапросом полной истории, v11/O-17 авторитетно пустая база
// (чат, созданный SPA-переходом) и MERGE-ветка пустого кеша, v12/O-18 режим экспортного
// дозапроса (ingestMode === 'export-sync': усечённый снимок НЕ принимается), сборка
// turnsMap ПОХОДОВО по thinking_enabled (v9/O-15: ход = user + assistant, «висячий»
// reasoning приклеивается к соседнему ходу), per-turn modelSlug по сетевым сигналам,
// фиксация снимка сети (netSnapshotAt/netTurnIds), вердикт полноты histCompletion,
// единая публикация базы (emitBaseSnapshot) и однократный диагностический дамп.
//
// Кластер вынесен по образцу шагов D.1 (core/deepseek-diag.js), D.2
// (core/deepseek-netsync.js), D.3 (core/deepseek-refetch.js), D.4 (core/deepseek-parse.js),
// D.5 (core/deepseek-conv.js), D.6 (core/deepseek-emit.js) и D.7 (core/deepseek-net.js).
// Раньше все части жили в ОДНОМ IIFE, поэтому кластер обращался к состоянию ядра по
// именам. Теперь у модуля свой IIFE, и зависимости ядра приходят через __bind(deps).
//
// РАЗДЕЛЕНИЕ ПО SCOPE. Тело перенесено БАЙТ-В-БАЙТ и без префиксов D.
//   • PURE-зона держит ровно байтовый заголовок СЕКЦИИ 8 (6 строк): это комментарии,
//     ядру они не нужны.
//   • BIND-зона (внутри `with (D) { … }`) держит тело K5, и причина здесь ЛЕКСИЧЕСКАЯ,
//     а не скоростная (урок D.5): функция, объявленная ВНЕ with, НЕ видит bind-имена —
//     её замыкание не включает with-окружение, созданное в __bind, и зов из with-обёртки
//     не спасает (резолв идёт по замыканию объявления, а не по месту вызова). Репро —
//     tools/_repro-with.js: тело вне with падает на первом же свободном имени
//     (ingestHistory читает ingestMode → ReferenceError: ingestMode is not defined).
//   • ЦЕНА with ЗДЕСЬ НЕ ГОРЯЧАЯ (урок D.1). Перебайтовых циклов у K5 нет вовсе: вся
//     перебайтовая работа O-18 — кольцо сырых ответов и FNV-хеш — живёт в PURE-зоне
//     core/deepseek-diag.js (шаг D.1) и вызывается отсюда форвардером diagHistRecord,
//     то есть динамический резолв приходится на ВЫЗОВ, а не на байт тела ответа.
//     Собственные циклы K5 идут ПО ХОДАМ истории (единицы-десятки итераций): сборка
//     messagesById (371-376), обход активной цепочки (495-542), netTurnIds (562-564) и
//     максимум accumulated_token_usage (568-573). Три из четырёх читают/пишут bind-имена
//     (turnsMap/orderCounter/netTurnIds) или зовут bind-функции (collectTurnText/
//     composeTurnText/getModelSlug), поэтому обязаны лежать в BIND; вынести их в PURE
//     можно было бы только разрезом тела на хелперы, а это нарушило бы байтовую
//     идентичность — первое требование шага.
// Байтовая идентичность тела сохранена.
//
// СОСТОЯНИЕ. Собственного состояния у кластера нет: все var внутри тела — локальные
// (exportSync/bizData/chatSession/chatMessages/messagesById/i/msg/chainResult/chain/
// truncated/baseEmptyAuthoritative/chatMode/chatModelSignals/pendingReasoning/
// lastAssistantId/c/ch/chId/fragments/text/chRole/chReasoning/prevTurn/mergedReasoning/
// tailTurn/nk/lastAccumulated/ci/at/em/diagState). Состояние кластера ОСТАЛОСЬ В ЯДРЕ и
// отдано rw-парами: turnsMap/orderCounter/histCompletion/netSnapshotAt/netTurnIds/
// loggedHistory/lastLoadedConvId/historyRefetchDone (тело их ПЕРЕЗАПИСЫВАЕТ: turnsMap = {},
// orderCounter = 0 и orderCounter++, установка полей histCompletion, netSnapshotAt =
// Date.now(), netTurnIds = {}, loggedHistory = true, lastLoadedConvId = currentConvId,
// historyRefetchDone = true) и ingestMode/exportSyncTruncated (режим экспортного ingest:
// тело читает ingestMode и поднимает exportSyncTruncated). Без сеттеров запись в
// sloppy-режиме молча терялась бы: база не пересобиралась бы, вердикт полноты не
// поднимался бы, а экспорт принял бы усечённый снимок за авторитетный.
//   Объявления ingestMode/exportSyncTruncated остались var в ЯДРЕ (строки 346-347
//   HEAD 2623b3a — сразу под надгробием D.8): их ставит и снимает ещё и контракт D.2
//   (applyExportNetSnapshot: `ingestMode = 'export-sync'` и `ingestMode = ''`), поэтому
//   вынос var в модуль заставил бы ядро читать НЕЯВНЫЕ ГЛОБАЛЫ (в браузере это
//   работало бы, в изолированном vm/jsdom-скоупе дало бы ReferenceError — урок D.5 на
//   lastDispatchSig). Остальные восемь rw-имён объявлены в СЕКЦИЯХ 1-3 ядра и
//   обслуживают ещё K6 (SSE), K7 (сетевой дозапрос), K9/K11 (сетевой слой).
//   ro-геттеры — 8 имён: currentConvId/lastHistoryUrl/lastAuthHeaders (ядро владеет ими
//   вместе с D.2/D.3/D.7 — тело K5 только читает), sseConfigName (сессионный факт из
//   /client/settings; K6 ещё НЕ вынесен, поэтому переменная остаётся в ядре до D.9),
//   REASONING_ENABLED (гейт v8/O-7) и MODEL_WINDOW_DEFAULT (окно модели для лога),
//   lastBaseServerTokens/lastBaseChatMode (параметры последнего эмита — ре-эмит полноты
//   0→1). histCompletion отдан rw-парой, хотя тело мутирует только ПОЛЯ объекта: так
//   контракт D.8 не зависит от того, переприсвоит ли тело имя в будущем (в D.5/D.6 то же
//   имя отдано ro-геттером — сеттер строгость не понижает).
//
// ЧТО НЕ УЕХАЛО: объявления ingestMode/exportSyncTruncated и все восемь rw-имён
// состояния ОСТАЛИСЬ в ядре — их ведут K6/K7/K9/K11 и контракты D.1-D.7. Функции ядра,
// которые зовёт тело, переданы ЗНАЧЕНИЕМ (function declaration ядра хойстятся, поэтому
// значения доступны на момент связки): diagOn/diagMark/diagHistRecord/
// diagSnapshotNetTurns/isDebugEnabled/determineState/dumpHistorySnapshot/
// dumpTurnUsageAtHistoryLoad — форвардеры D.1, refetchFullHistory — форвардер D.3,
// buildActiveChain/collectTurnText/collectTurnReasoning/composeTurnText/getModelSlug —
// форвардеры D.4, emitBaseSnapshot — форвардер D.6. Итого 15 fn.
//
// Порядок подключения (core/background.js, registerSafe 'ai-cm-deepseek-intercept-v10',
// document_start, world MAIN): utils/debug.js -> core/deepseek-diag.js ->
// core/deepseek-netsync.js -> core/deepseek-refetch.js -> core/deepseek-parse.js ->
// core/deepseek-conv.js -> core/deepseek-emit.js -> core/deepseek-net.js -> ЭТОТ ФАЙЛ ->
// core/deepseek-intercept.js. До связки на window.AiCmDeepseekIngest лежит только __bind;
// после связки Fn заполнен ровно одним телом (ingestHistory), а ядро раздаёт его
// форвардером по прежнему имени (function declaration, хойстится: fn-передачи
// `ingestHistory: ingestHistory` в контрактах D.2 (приёмка экспортного снимка),
// D.3 (приёмка ответа тихого дозапроса) и D.7 (копилка XHR) не тронуты — прямых
// вызовов K5 в ядре не осталось вовсе).
// Экспорт: window.AiCmDeepseekIngest + module.exports.
// =============================================================================
(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekIngest) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ---- PURE-зона: байтовый заголовок СЕКЦИИ 8 (тело K5 читает состояние ядра) ----
  // ===== СЕКЦИЯ 8: ПАРСИНГ history_messages =====
  // v6: детектор усечения активной цепочки + однократный тихий дозапрос полной истории
  // v12 (O-18, фаза 2): ingestMode === 'export-sync' — приёмка снимка, запрошенного ПЕРЕД
  // композицией файла: рекурсивные дозапросы не запускаются (таймаут экспорта уже идёт),
  // а вердикт полноты не понижается. Обычный путь (ingestMode === '') не меняется —
  // сигнатура функции прежняя, режим передаётся состоянием, а не аргументом.

  function __bind(d) {
    D = d;
    with (D) {
  // ---- BIND-зона: тело K5 — свободные имена резолвятся в with (D) ----

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
      aiCmDiagWarn('deepseek:ingestHistory', '[deepseek-intercept] ошибка парсинга history_messages:', e);
    }
  }

      Fn.ingestHistory = ingestHistory;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekIngest = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
