// =============================================================================
// core/deepseek-emit.js — Step D.6 (декомпозиция core/deepseek-intercept.js).
// K2: EMIT (СЕКЦИЯ 4 ядра, строки 307-489 HEAD d6a74c2, 183 строки) —
// buildDispatchSignature (O-22, ФИКС F4: payload-точная сигнатура снимка),
// emitBaseSnapshot (единая точка публикации события ai-cm-full-history: 3 сайта
// вызова в ядре — приём снимка истории и два realtime-финала, плюс ре-эмит полноты
// 0→1), clipTurnText и turnsSnapshot (сводка turnsMap для дампов экспорта, v11/O-17)
// и мост ai-cm-turns-snap-request → ai-cm-turns-snap-response (ответ DeepSeek на
// запрос экспортёра, которого у сервиса раньше не было).
//
// Кластер вынесен по образцу шагов D.1 (core/deepseek-diag.js), D.2
// (core/deepseek-netsync.js), D.3 (core/deepseek-refetch.js), D.4
// (core/deepseek-parse.js) и D.5 (core/deepseek-conv.js). Раньше все части жили
// в ОДНОМ IIFE, поэтому кластер обращался к состоянию ядра по именам. Теперь у
// модуля свой IIFE, и зависимости ядра приходят через __bind(deps).
//
// РАЗДЕЛЕНИЕ ПО SCOPE. Тела перенесены БАЙТ-В-БАЙТ и без префиксов D.
//   • PURE-зона держит ровно байтовый заголовок СЕКЦИИ 4 (7 строк): это
//     комментарий, ядру он не нужен.
//   • BIND-зона (внутри `with (D) { … }`) держит ВСЕ тела кластера, и причина
//     здесь ЛЕКСИЧЕСКАЯ, а не скоростная: функция, объявленная ВНЕ with, НЕ видит
//     bind-имена — её замыкание не включает with-окружение, созданное в __bind,
//     и зов из with-обёртки не спасает (резолв идёт по замыканию объявления, а не
//     по месту вызова). Репро — tools/_repro-with.js (урок D.5/D.1): тело вне with
//     падает на первом же свободном имени ядра (buildDispatchSignature читает
//     turnsMap → ReferenceError: turnsMap is not defined).
//   • ЦЕНА with ЗДЕСЬ НЕ ГОРЯЧАЯ. Урок D.1 (81 мс вне with против 3309 мс в with на
//     200×200 КБ) касается ПЕРЕБАЙТОВЫХ циклов с резолвом имени на символ. В K2
//     перебайтовый цикл ровно один — FNV-1a в diagHash6 — и он лежит в PURE-зоне
//     своего модуля (core/deepseek-diag.js, шаг D.1): buildDispatchSignature зовёт
//     diagHash6 ОДИН раз на текст хода, то есть динамический резолв имени приходится
//     на ВЫЗОВ функции, а не на символ текста. Собственные циклы K2 — по ходам
//     (Object.keys(turnsMap)) и по фрагментам строки, без перебайтового резолва.
// Байтовая идентичность тел сохранена.
//
// СОСТОЯНИЕ. turnsMap / attachTokens / attachBreak / histCompletion / currentConvId
// ОСТАЛИСЬ В ЯДРЕ: их ведут оставшиеся секции (K5 ingest, K6 SSE, K9 XHR-копилка,
// K11 fetch-хук) и контракты D.1-D.5, а K2 их только ЧИТАЕТ — поэтому здесь
// ro-геттеры (запись в поля turnsMap и мутация полей histCompletion идут по ссылке
// и видны ядру без сеттера). lastBaseServerTokens / lastBaseChatMode /
// lastDispatchSig / lastDispatchResult — rw-пары: это состояние ПЕРЕЗАПИСЫВАЕТ само
// тело emitBaseSnapshot (запоминание реально опубликованного снимка и параметров
// последнего эмита), а читают его K2 (гард повторного диспатча + вход в ре-эмит),
// ре-эмит полноты 0→1 в ingestHistory (K5) и O-22-слушатель смены разговора в ядре
// (он же обнуляет lastDispatchSig). Без сеттера запись в sloppy-режиме молча
// терялась бы — гард O-22 перестал бы глушить повторные снимки. Объявления этих
// четырёх переменных — в ЯДРЕ (строки 292-297): при выносе var из IIFE ядро читало бы
// НЕЯВНЫЕ ГЛОБАЛЫ (в браузере это работало бы, в изолированном vm/jsdom-скоупе дало
// бы ReferenceError — урок D.5 на lastDispatchSig). Собственного состояния у кластера
// нет: все var внутри тел — локальные (ids/pieces/messages/reasonings/turns/parts…).
//
// ЧТО НЕ УЕХАЛО: заголовок СЕКЦИИ 4 уехал (PURE). O-22-слушатель
// 'ai-cm-conversation-changed' (строки 299-304 ядра) ОСТАЛСЯ в ядре: он пишет
// lastDispatchSig, объявленный в ядре. Функции ядра, которые зовут тела (diagHash6 /
// diagMark / diagOn / diagExportHook / isDebugEnabled — форвардеры D.1, getConvId —
// форвардер D.5, hasInjectedUserPrompt — форвардер D.4), переданы ЗНАЧЕНИЕМ: function
// declaration ядра хойстятся, поэтому значения доступны на момент связки.
//
// Порядок подключения (core/background.js, registerSafe 'ai-cm-deepseek-intercept-v8',
// document_start, world MAIN): utils/debug.js -> core/deepseek-diag.js ->
// core/deepseek-netsync.js -> core/deepseek-refetch.js -> core/deepseek-parse.js ->
// core/deepseek-conv.js -> ЭТОТ ФАЙЛ -> core/deepseek-intercept.js. До связки на
// window.AiCmDeepseekEmit лежит только __bind; после связки ядро раздаёт 1 из 4 тел
// форвардером по прежнему имени (emitBaseSnapshot — function declaration, хойстится:
// 3 сайта вызова выше по файлу и fn-передача в контракт D.2 не тронуты).
// buildDispatchSignature / clipTurnText / turnsSnapshot наружу не выдаются: их зовут
// только тела этого же модуля (мост turns-snap — тот же модуль).
// Экспорт: window.AiCmDeepseekEmit + module.exports.
// =============================================================================
(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekEmit) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ---- PURE-зона: байтовый заголовок СЕКЦИИ 4 (тела K2 читают состояние ядра) ----
  // ===== СЕКЦИЯ 4: EMIT (контракт как в gemini v21, + serverTokens, + modelMode) =====
  // O-22 (ФИКС F4): payload-точная сигнатура диспатча. Берутся ВСЕ поля области видимости, из
  // которых собирается detail события ai-cm-full-history: convId, состав и тексты ходов
  // (id, order, role, modelSlug, текст и reasoning — длиной и отпечатком FNV-1a), serverTokens,
  // chatMode, вложения и вердикт полноты (historyComplete/reachedRoot/baseEmpty). Равенство
  // сигнатур означает побайтово тот же снимок, поэтому второй диспатч не несёт новой информации.
  // Сбой сборки → null: гард не действует, диспатч идёт как прежде.
  function __bind(d) {
    D = d;
    with (D) {
  // ---- BIND-зона: тела K2, читающие живое состояние ядра через with (D) ----

  function buildDispatchSignature(convId, serverTokens, chatMode) {
    try {
      var parts = [
        String(convId || ''),
        String(Object.keys(turnsMap).length),
        String(serverTokens || 0),
        String(chatMode || ''),
        String(attachTokens || 0),
        (attachBreak.imgTokens || 0) + ',' + (attachBreak.docTokens || 0) + ',' +
          (attachBreak.imgCount || 0) + ',' + (attachBreak.docCount || 0),
        (histCompletion.historyComplete === true ? '1' : '0') +
          (histCompletion.reachedRoot === true ? '1' : '0') +
          (histCompletion.baseEmpty === true ? '1' : '0')
      ];
      var keys = Object.keys(turnsMap);
      var turns = [];
      for (var i = 0; i < keys.length; i++) {
        var k = String(keys[i]);
        var t = turnsMap[k] || {};
        var tx = (typeof t.text === 'string') ? t.text : '';
        var rs = (typeof t.reasoning === 'string') ? t.reasoning : '';
        turns.push(k + ':' + (t.order || 0) + ':' + (t.role || '') + ':' + (t.modelSlug || '') + ':' +
          tx.length + ':' + diagHash6(tx) + ':' + rs.length + ':' + diagHash6(rs));
      }
      turns.sort();   // снимок — это состав, а не порядок ключей turnsMap (порядок detail задаёт t.order)
      parts.push(turns.join(';'));
      return parts.join('|');
    } catch (e) { return null; }
  }
  function emitBaseSnapshot(serverTokens, chatMode) {
    // O-22 (ИЗМЕРЕНИЕ-2): маркер входа в функцию диспатча ai-cm-full-history.
    // count — из turnsMap (в области видимости), текст на входе тела ещё не собран →
    // литерал «(вне области)»; convId — из области видимости. Только диагностика под гейтом.
    try {
      if (typeof diagMark === 'function' && typeof diagOn === 'function' && diagOn()) {
        diagMark('o22-dispatch-fn', {
          ts: Date.now(),
          count: Object.keys(turnsMap).length,
          textLen: '(вне области)',
          convId: (typeof getConvId === 'function') ? (getConvId() || currentConvId || '') : (currentConvId || '')
        });
      }
    } catch (eO22fn) { }
    serverTokens = (typeof serverTokens === 'number' && serverTokens > 0) ? serverTokens : 0;
    chatMode = chatMode || '';
    // O-22 (ФИКС F4): payload-точный гард ПОВТОРНОГО диспатча — единая точка для ВСЕХ сайтов
    // (S560/S692/S1172/S1467). Живой лог 2026-09-18 21:31:12: один и тот же снимок
    // (convId 2d0090f5, count=10, ops APPEND:1765/SET:2, frags THINK 5437#809dbd +
    // RESPONSE 1592#c40b57) ушёл 3 раза за 10 мс. Сигнатура совпала с последней
    // ОПУБЛИКОВАННОЙ → снимок не изменился, событие ai-cm-full-history не публикуем.
    // Гард не зависит от aiCmDebug: под гейтом только строка o22-dispatch-skip.
    var dispatchSig = buildDispatchSignature(
      (typeof getConvId === 'function') ? (getConvId() || currentConvId) : currentConvId,
      serverTokens, chatMode);
    if (dispatchSig !== null && lastDispatchSig !== null && dispatchSig === lastDispatchSig) {
      try {
        if (typeof diagMark === 'function' && typeof diagOn === 'function' && diagOn()) {
          diagMark('o22-dispatch-skip', {
            site: 'emitBaseSnapshot', ts: Date.now(),
            count: Object.keys(turnsMap).length, textLen: '(вне области)',
            convId: (typeof getConvId === 'function') ? (getConvId() || currentConvId || '') : (currentConvId || ''),
            sig: (typeof diagHash6 === 'function') ? diagHash6(dispatchSig) : '',
            sigLen: dispatchSig.length
          });
        }
      } catch (eO22skip) { }
      return lastDispatchResult;
    }
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
      // v13 (O-7): hidden-пометки базы — текст хода не меняется (см. hasInjectedUserPrompt).
      var turnMsg = { role: t.role || 'unknown', text: t.text, reasoning: turnReasoning };
      if (turnReasoning) turnMsg.hiddenReasoning = turnReasoning;
      if (t.role === 'user' && hasInjectedUserPrompt(t.text)) turnMsg.hiddenInjection = true;
      messages.push(turnMsg);
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
    var result = { count: ids.length, textLen: text.length, lastModel: lastModel, serverTokens: serverTokens, reasoningTurns: reasoningTurns };
    // O-22 (ФИКС F4): запоминаем ТОЛЬКО реально опубликованный снимок — по этой сигнатуре
    // следующий диспатч того же снимка будет остановлен до события.
    lastDispatchSig = dispatchSig;
    lastDispatchResult = result;
    return result;
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
      // O-18 (ИЗМЕРЕНИЕ): этот мост экспортёр дёргает в ОБЕИХ точках записи файла
      // (snapshot-at-fired / snapshot-at-manual) — здесь снимаем per-turn сравнение
      // live vs network и дамп колец. Только чтение + console.log под флагом aiCmDebug.
      try { diagExportHook('turns-snap-request'); } catch (eDiagExp) { }
    });
  } catch (eTurnsBridge) { }

      Fn.buildDispatchSignature = buildDispatchSignature;
      Fn.emitBaseSnapshot = emitBaseSnapshot;
      Fn.clipTurnText = clipTurnText;
      Fn.turnsSnapshot = turnsSnapshot;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekEmit = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
