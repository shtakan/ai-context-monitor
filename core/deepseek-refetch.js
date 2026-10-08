// =============================================================================
// core/deepseek-refetch.js — Step D.3 (декомпозиция core/deepseek-intercept.js).
// K8: REFETCH/URL-ГИГИЕНА — СЕКЦИЯ 10 (гард перекрёста chat_session_id vs currentConvId:
// convIdFromHistoryUrl, convIdFromCompletionBody, guardCheck) и СЕКЦИЯ 10B (хелперы
// MERGE-дозапроса: collectHeaders, stripCacheParams, historyRefetchUrl, historyUrlForConv,
// refetchFullHistory, scheduleHistoryRefetch) + таймер historyRefetchTimer.
//
// Кластер вынесен по образцу шагов D.1 (core/deepseek-diag.js) и D.2
// (core/deepseek-netsync.js). Раньше обе части жили в ОДНОМ IIFE, поэтому кластер
// обращался к состоянию ядра по именам. Теперь у модуля свой IIFE, и состояние ядра
// приходит через __bind(deps).
//
// РАЗДЕЛЕНИЕ ПО SCOPE. Тела перенесены БАЙТ-В-БАЙТ и без префиксов D., но лежат в
// ДВУХ зонах:
//   • PURE-зона (этот IIFE, до __bind) — тела, которым ядро НЕ нужно:
//     convIdFromHistoryUrl и convIdFromCompletionBody (извлечение convId из URL/тела),
//     collectHeaders (сбор заголовков запроса), stripCacheParams (URL-гигиена) и
//     historyUrlForConv (зовёт первые два) — плюс собственное состояние модуля
//     historyRefetchTimer, ядру не видимое.
//   • BIND-зона ('with (D) { … }' внутри __bind) — тела, читающие живое состояние и
//     функции ядра: guardCheck (currentConvId), historyRefetchUrl (currentConvId),
//     refetchFullHistory (diagMark, originalFetch, ingestHistory, currentConvId) и
//     scheduleHistoryRefetch (lastLoadedConvId, lastAuthHeaders).
// ПОЧЕМУ ТАК: внутри with каждый свободный идентификатор резолвится ДИНАМИЧЕСКИ
// (ES3 Annex B) — урок D.1: горячий цикл FNV-хеша в with деградирует ~в 40 раз
// (200×200 КБ: 81 мс вне with против 3309 мс в with). В K8 перебайтовых циклов нет
// (проходы идут по заголовкам и ключам — единицы элементов), поэтому критерий зоны
// здесь — ЗАВИСИМОСТЬ ОТ ЯДРА, а не скорость: пять тел, которым ядро не нужно,
// вынесены в PURE. Байтовая идентичность тел сохранена в обеих зонах.
//
// Состояние refetch-гигиены (lastAuthHeaders, lastHistoryUrl, historyRefetchDone) и
// lastLoadedConvId ОСТАЛИСЬ В ЯДРЕ: их пишут оставшиеся секции (resetForNewConversation —
// сброс на смену чата; fetch-хук и XHR-копилка K9/K11 — lastAuthHeaders/lastHistoryUrl;
// приём снимка истории и детекторы усечения — lastLoadedConvId/historyRefetchDone).
// Ядро отдаёт lastAuthHeaders/lastHistoryUrl/historyRefetchDone rw-парами: модуль —
// владелец семантики refetch-состояния и пишет их наравне с ядром, поэтому без сеттера
// запись из модуля молча терялась бы (sloppy), а «длиннее побеждает» на этих полях
// расходилось бы между копиями. lastLoadedConvId — ro: модуль его только читает.
// historyRefetchTimer переехал в модуль целиком — его не читает и не пишет ни одна
// оставшаяся секция ядра.
//
// Порядок подключения (core/background.js, registerSafe 'ai-cm-deepseek-intercept-v5',
// document_start, world MAIN): utils/debug.js -> core/deepseek-diag.js ->
// core/deepseek-netsync.js -> ЭТОТ ФАЙЛ -> core/deepseek-intercept.js. До связки на
// window.AiCmDeepseekRefetch лежит только __bind; после связки ядро раздаёт 7 из 9
// функций форвардерами по прежним именам (convIdFromHistoryUrl, convIdFromCompletionBody,
// guardCheck, collectHeaders, historyRefetchUrl, refetchFullHistory, scheduleHistoryRefetch —
// function declaration, хойстятся). stripCacheParams и historyUrlForConv наружу не
// выдаются: их зовут только тела этого модуля (historyUrlForConv — из BIND-зоны
// refetchFullHistory, через PURE-зону).
// Экспорт: window.AiCmDeepseekRefetch + module.exports.
// =============================================================================

(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekRefetch) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ---- PURE-зона: тела без зависимости от ядра; состояние модуля, ядру не видимое ----
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

  // ---- PURE-состояние модуля: таймер дозапроса после смены чата ----
  // Переехал из ядра (K8): тела scheduleHistoryRefetch единственные, кто его читает
  // и пишет; ни одна оставшаяся секция ядра к нему не обращается.
  var historyRefetchTimer = null;

  function __bind(d) {
    D = d;
    with (D) {
      // ---- BIND-зона: тела, читающие живое состояние/функции ядра через with (D) ----

  function guardCheck(reqConvId) {
    if (!reqConvId) return true;   // не удалось извлечь — пропускаем (не блокируем)
    if (reqConvId !== currentConvId) {
      console.log('[deepseek-intercept] пропущен ответ (convId запроса ' + reqConvId + ' != текущий ' + currentConvId + ')');
      return false;
    }
    return true;
  }

  // v11 (O-17): КАНОНИЧЕСКИЙ URL полной истории текущего чата (без cache-параметров).
  // Единственный источник для обоих дозапросов (таймер после SPA-смены чата и детектор
  // усечения/MERGE) — чужой URL в базу попасть не может по построению.
  function historyRefetchUrl() {
    return location.origin + '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(currentConvId);
  }

  // Тихий повторный запрос полной истории БЕЗ cache_version/cache_reset_at
  // Использует originalFetch (нативный fetch ДО нашей обёртки) — рекурсия исключена по построению
  function refetchFullHistory(originalUrl, authHeaders, convId) {
    if (!convId || convId !== currentConvId) { return; }
    // v11 (O-17): берём переданный URL ТОЛЬКО если он про этот же чат, иначе — канонический
    var cleanUrl = historyUrlForConv(originalUrl, convId) || historyRefetchUrl();
    diagMark('refetch-full-history', { conv: String(convId).slice(0, 8) });   // O-18 (ИЗМЕРЕНИЕ)
    originalFetch.call(window, cleanUrl, {
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
      } catch (e) { swallow(e, 'deepseek:scheduleHistoryRefetch'); }
    }, 1000);
  }

      Fn.convIdFromHistoryUrl = convIdFromHistoryUrl;
      Fn.convIdFromCompletionBody = convIdFromCompletionBody;
      Fn.guardCheck = guardCheck;
      Fn.collectHeaders = collectHeaders;
      Fn.stripCacheParams = stripCacheParams;
      Fn.historyRefetchUrl = historyRefetchUrl;
      Fn.historyUrlForConv = historyUrlForConv;
      Fn.refetchFullHistory = refetchFullHistory;
      Fn.scheduleHistoryRefetch = scheduleHistoryRefetch;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekRefetch = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
