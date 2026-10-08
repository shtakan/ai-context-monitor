// =============================================================================
// core/deepseek-net.js — Step D.7 (декомпозиция core/deepseek-intercept.js).
// K9: NETWORK (СЕКЦИИ 11-12 ядра, строки 1411-1628 HEAD 9aca03a, 218 строк) —
// сетевой слой сайта: обёртка window.fetch (СЕКЦИЯ 11: v5-тихий catch против ложного
// unhandled rejection, копилка auth-заголовков lastAuthHeaders, история + MERGE-дозапрос,
// разбор тела completion в параметры потока, настройки модели /client/settings) и
// обёртки XMLHttpRequest.prototype.open/send/setRequestHeader (СЕКЦИЯ 12: зеркало
// fetch плюс setRequestHeader-копилка заголовков авторизации).
//
// Кластер вынесен по образцу шагов D.1 (core/deepseek-diag.js), D.2
// (core/deepseek-netsync.js), D.3 (core/deepseek-refetch.js), D.4
// (core/deepseek-parse.js), D.5 (core/deepseek-conv.js) и D.6 (core/deepseek-emit.js).
// Раньше все части жили в ОДНОМ IIFE, поэтому кластер обращался к состоянию ядра по
// именам. Теперь у модуля свой IIFE, и зависимости ядра приходят через __bind(deps).
//
// РАЗДЕЛЕНИЕ ПО SCOPE. Тела перенесены БАЙТ-В-БАЙТ и без префиксов D.
//   • PURE-зона держит ровно байтовые заголовки СЕКЦИЙ 11 и 12 (2 строки): это
//     комментарии, ядру они не нужны.
//   • BIND-зона (внутри `with (D) { … }`) держит ОБА тела кластера, и причина здесь
//     ЛЕКСИЧЕСКАЯ, а не скоростная (урок D.5): функция, объявленная ВНЕ with, НЕ видит
//     bind-имена — её замыкание не включает with-окружение, созданное в __bind, и зов из
//     with-обёртки не спасает (резолв идёт по замыканию объявления, а не по месту вызова).
//     Репро — tools/_repro-with.js: тело вне with падает на первом же свободном имени
//     ядра (fetch-хук читает originalFetch → ReferenceError: originalFetch is not defined).
//   • ЦЕНА with ЗДЕСЬ НЕ ГОРЯЧАЯ. Урок D.1 (81 мс вне with против 3309 мс в with на
//     200×200 КБ) касается ПЕРЕБАЙТОВЫХ циклов с динамическим резолвом имени на символ.
//     У K9 таких циклов нет: тела резолвят имена на ЗАПРОС страницы (десятки резолвов
//     на fetch/XHR), а не на байт тела ответа.
// Байтовая идентичность тел сохранена.
//
// СОСТОЯНИЕ. Собственного состояния у кластера нет: все var внутри тел — локальные
// (url/method/allH/isHistory/promise/info/…), а var originalSetRequestHeader —
// __bind-локальная. Копилки и параметры потока остались В ЯДРЕ и отданы rw-парами:
// lastAuthHeaders/lastHistoryUrl/lastLoadedConvId (строки 279-283) и sseUserPrompt/
// sseParentMessageId/sseThinkingEnabled (строки 632-634). Тела K9 их ПЕРЕЗАПИСЫВАЮТ,
// поэтому без сеттера запись в sloppy-режиме молча терялась бы: копилка авторизации
// и URL осталась бы прежней (MERGE-дозапрос ушёл бы по чужому URL — v6/v11/O-17), а
// разбор тела completion не доехал бы до SSE-финализации K6. Читают это состояние,
// кроме K9: K8 (модуль D.3 — refetchFullHistory/scheduleHistoryRefetch) и K6 (SSE).
// Объявления всех шести переменных — в ЯДРЕ: при выносе var из IIFE ядро читало бы
// НЕЯВНЫЕ ГЛОБАЛЫ (в браузере это работало бы, в изолированном vm/jsdom-скоупе дало бы
// ReferenceError — урок D.5 на lastDispatchSig). originalFetch / OriginalXHR /
// originalXHROpen / originalXHRSend / currentConvId — ro-геттеры: тела их только читают,
// а мутация идёт по ссылке (прототип XHR) или через сам объект.
//
// ЧТО НЕ УЕХАЛО: объявления originalFetch/OriginalXHR/originalXHROpen/originalXHRSend
// (строки 222-225 ядра) ОСТАЛИСЬ в ядре: originalFetch отдан ro-геттером ещё и
// контрактам D.2/D.3, а XHR-оригиналы ядро передаёт этому модулю. Связка модуля
// вызывается в КОНЦЕ IIFE ядра — ПОСЛЕ захвата originalFetch, поэтому обёртка fetch
// никогда не замыкается сама на себя (иначе бесконечная рекурсия). Функции ядра,
// которые зовут тела, переданы ЗНАЧЕНИЕМ (function declaration ядра хойстятся и
// доступны на момент связки): collectHeaders/convIdFromHistoryUrl/
// convIdFromCompletionBody/guardCheck/refetchFullHistory — форвардеры D.3,
// diagOn/diagHistRecord — форвардеры D.1, ingestHistory — K5 (СЕКЦИЯ 8),
// parseSSE/consumeSseResponse/ingestModelSettings — K6 (СЕКЦИЯ 9).
//
// Порядок подключения (core/background.js, registerSafe 'ai-cm-deepseek-intercept-v9',
// document_start, world MAIN): utils/debug.js -> core/deepseek-diag.js ->
// core/deepseek-netsync.js -> core/deepseek-refetch.js -> core/deepseek-parse.js ->
// core/deepseek-conv.js -> core/deepseek-emit.js -> ЭТОТ ФАЙЛ ->
// core/deepseek-intercept.js. До связки на window.AiCmDeepseekNet лежит только __bind.
// Fn наружу не отдаёт ни одного тела: прежние имена кластера — window.fetch и
// OriginalXHR.prototype.open/send/setRequestHeader — читает САЙТ, а не ядро, поэтому
// форвардеров у D.7 нет вовсе (в отличие от D.1-D.6).
// Экспорт: window.AiCmDeepseekNet + module.exports.
// =============================================================================
(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekNet) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ---- PURE-зона: байтовые заголовки СЕКЦИЙ 11 и 12 (тела K9 читают состояние ядра) ----
  // ===== СЕКЦИЯ 11: ПЕРЕХВАТ FETCH (v5: тихий catch + устранение висячих Promise.reject) =====
  // ===== СЕКЦИЯ 12: ПЕРЕХВАТ XHR (зеркалит fetch, +setRequestHeader-копилка) =====
  function __bind(d) {
    D = d;
    with (D) {
  // ---- BIND-зона: тела K9 (fetch-хук и XHR-хук) — свободные имена резолвятся в with (D) ----

  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { swallow(e, 'deepseek:fetch-url'); }
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
        } catch (e) { swallow(e, 'deepseek:fetch-completion-body'); }
      }

      // --- настройки модели: URL содержит "client/settings" (v13, scope=model) ---
      var isModelSettings = (url.indexOf('client/settings') !== -1);

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
                    if (diagOn()) diagHistRecord(json, 'fetch-history:emptyMERGE');   // O-18 (ИЗМЕРЕНИЕ)
                    console.log('[deepseek-intercept] кеш MERGE → тихий дозапрос полной истории (без cache_version)');
                    lastLoadedConvId = currentConvId;
                    refetchFullHistory(url, historyAuthHeaders, historyConvId);
                    return;
                  }
                }
                ingestHistory(json);
              }).catch(function () { });
            }
          } catch (e) { swallow(e, 'deepseek:fetch-history'); }
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
          } catch (e) { swallow(e, 'deepseek:fetch-completion'); }
          return resp;
        }, function () { /* v5: тихо — не создаём висячий Promise.reject */ });
      }

      // обработка ответа настроек модели (v13): тихий разбор, только чтение
      if (isModelSettings) {
        promise.then(function (resp) {
          try {
            if (resp && resp.ok) {
              resp.clone().json().then(function (json) {
                ingestModelSettings(json);
              }).catch(function () { });
            }
          } catch (e) { swallow(e, 'deepseek:fetch-settings'); }
          return resp;
        }, function () { /* тихо */ });
      }

      return promise;
    };
  }

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
      } catch (e) { swallow(e, 'deepseek:xhr-open'); }
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
        } catch (e) { swallow(e, 'deepseek:xhr-send'); }
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
                    if (diagOn()) diagHistRecord(jsonH, 'xhr-history:emptyMERGE');   // O-18 (ИЗМЕРЕНИЕ)
                    console.log('[deepseek-intercept] кеш MERGE → тихий дозапрос полной истории (без cache_version)');
                    lastLoadedConvId = currentConvId;
                    refetchFullHistory(loadUrl, info2.headers || {}, info2.historyConvId);
                    return;
                  }
                }
                ingestHistory(jsonH);
              } catch (e) { swallow(e, 'deepseek:xhr-load-history'); }
            }
          }

          // стрим
          if (loadUrl.indexOf('completion') !== -1 && info2.method === 'POST') {
            if (guardCheck(info2.completionConvId)) {
              parseSSE(self.responseText);
            }
          }

          // настройки модели (v13): name активной конфигурации (Instant)
          if (loadUrl.indexOf('client/settings') !== -1) {
            try { ingestModelSettings(JSON.parse(self.responseText)); } catch (eSet) { swallow(eSet, 'deepseek:xhr-load-settings'); }
          }
        } catch (e) { swallow(e, 'deepseek:xhr-load'); }
      });

      return originalXHRSend.apply(this, arguments);
    };
  }
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekNet = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
