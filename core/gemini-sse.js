// core/gemini-sse.js — Phase 3 шаг 9: SSE-кластер (перехват сети Gemini) вынесен из
// core/gemini-intercept.js (строки 4308–4528 на момент выноса) в отдельный модуль.
//
// ЧТО ЗДЕСЬ: ТОЛЬКО установка сетевых врапперов.
//   (1) подмена window.fetch — для batchexecute-истории снимает заголовки/тело запроса
//       (captureHeadersFromInit/rememberSiteMeta), для ingest-RPC считает convId тела и тег
//       выпуска (issuedAtConvId/issuedAtEpoch), на ответе держит гард stale-conv по
//       convId/эпохе, снимает блокировку автоскролла и зовёт ingest; отдельно —
//       stream-ingest (I4z33b/Bsxleb, v52), DIAG_TOKENS-скан всех ответов (v28) и тихий
//       catch против ложных unhandled rejection (v24);
//   (2) подмена OriginalXHR.prototype.open/setRequestHeader/send — те же ветви (v20/v21/v28/
//       v44/v52/v59).
// Логика ингеста, оркестрация пагинации и парсинг кадров в модуль НЕ переехали: это разные
// темы (ядро и core/gemini-parse.js), и состояние у них общее с ядром.
//
// СВЯЗКА (паттерн core/gemini-diag.js / gemini-rpc.js / gemini-parse.js): ядро зовёт __bind(...)
// и передаёт
//   - ingest / getConvId — функции ядра;
//   - isHistoryRpc / isIngestRpc / convIdFromBody / captureHeadersFromInit / rememberSiteMeta /
//     isStreamIngestRpc / streamRpcidOf / provisionalStreamIngest — алиасы ядра (модуль rpc);
//   - diagCanScan / diagIsStream / diagScanResponse — алиасы ядра (модуль diag);
//   - originalFetch / OriginalXHR / originalXHROpen / originalXHRSend / originalSetHeader —
//     оригиналы, снятые ядром в начале его IIFE;
//   - currentConvId / convEpoch / autoScrollBlocked / autoScrollUnblockTimer /
//     diagScannedCount и константу DIAG_MAX_SCANNED — геттеры/сеттеры, НЕ копии значений:
//     эти переменные живут в ядре и меняются из ядра (pushState-сброс, лоадер, ingest), копия
//     разошлась бы с оригиналом.
//
// Установка НЕ выполняется на этапе bind: ядро зовёт installNetworkHooks() ровно там, где
// раньше стояли сами врапперы, поэтому и относительный порядок патчей, и момент установки
// сохранены. Если модуль не подключён, ядро ставит мягкую заглушку: перехват сети выключен
// (история собирается активными путями — vf5/пагинация/лоадер), падений нет.
//
// ПОРЯДОК ПОДКЛЮЧЕНИЯ: core/background.js, js[] — сразу после core/gemini-parse.js и ПЕРЕД
// core/gemini-intercept.js (модуль обязан существовать к моменту bind в ядре).
//
// PUBLIC API: window.AiCmGeminiSse = { __bind, installNetworkHooks }. Врапперы анонимны и
// наружу не отдаются: ядру нужна только установка.
//
// debugLog остаётся «голым» глобалом из utils/debug.js — как в остальных модулях кластера.

(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiSse) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  function __bind(d) { D = d; }

  // ---- установка врапперов fetch/XHR. Вызывается ядром из прежнего места установки ----
  // (там, где до выноса стояли сами врапперы), поэтому порядок сетевых патчей Gemini не изменился.
  function installNetworkHooks() {
    // ---- подмена fetch (v24: тихий catch на промисе originalFetch + устранение висячего Promise.reject) ----
    if (typeof D.originalFetch === 'function') {
      window.fetch = function (input, init) {
        var url = '';
        try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { }

        // v21: диагностические метки для лога «гард слеп»
        var diagInputType = (typeof input === 'string') ? 'url-string' : ((typeof Request !== 'undefined' && input instanceof Request) ? 'Request' : 'other');
        var diagInitBody = (init && init.body) ? (typeof init.body === 'string' ? 'string' : 'other') : 'absent';

        if (D.isHistoryRpc(url)) {
          var hdrs = D.captureHeadersFromInit(input, init);
          var bodyStr = '';
          try {
            if (typeof Request !== 'undefined' && input instanceof Request) {
              input.clone().text().then(function (t) { D.rememberSiteMeta(url, hdrs, t); }).catch(function () { });
            } else if (init && typeof init.body === 'string') { bodyStr = init.body; }
          } catch (e) { }
          D.rememberSiteMeta(url, hdrs, bodyStr);
        }

        // v21: строим reqConvIdPromise — всегда резолвится строкой, никогда не реджектится
        var reqConvIdPromise = Promise.resolve('');
        // v44: convId чата В МОМЕНТ ОТПРАВКИ запроса — синхронная привязка ответа к чату,
        // не зависящая от парсинга тела (закрывает дыру «гард слеп» на SPA-навигации).
        // v50: применяем и к инкрементальному фиду (isIngestRpc), а не только к истории.
        var issuedAtConvId = '';
        var issuedAtEpoch = -1; // v59: эпоха на момент отправки
        if (D.isIngestRpc(url)) {
          issuedAtConvId = D.getConvId();
          issuedAtEpoch = D.convEpoch; // v59
          if (init && typeof init.body === 'string') {
            // строковое тело — синхронно
            reqConvIdPromise = Promise.resolve(D.convIdFromBody(init.body));
          } else if (typeof Request !== 'undefined' && input instanceof Request) {
            // Request-объект — клонируем и читаем тело параллельно originalFetch
            try {
              var cloned = input.clone();
              reqConvIdPromise = cloned.text().then(function (t) {
                return D.convIdFromBody(t);
              }).catch(function () { return ''; });
            } catch (e) {
              reqConvIdPromise = Promise.resolve('');
            }
          }
        }

        var promise;
        try { promise = D.originalFetch.apply(this, arguments); } catch (e) { return Promise.reject(e); }

        // v24: тихий catch — снимает ложный unhandled rejection для чужих прерванных запросов
        // (Failed to fetch при навигации/переключении/обрыве стрима), не меняя поведения страницы
        promise.catch(function () { /* тихо: снимаем ложный unhandled для чужих прерванных запросов */ });

        // v52: stream-ingest — ветка ДО isIngestRpc: ответы генерации (I4z33b/Bsxleb), clone, не мешаем странице
        if (D.isStreamIngestRpc(url)) {
          promise.then(function (resp) {
            try {
              if (resp && resp.ok) {
                resp.clone().text().then(function (t) {
                  D.provisionalStreamIngest(t, D.streamRpcidOf(url));
                }).catch(function () { });
              }
            } catch (e) { }
            return resp;
          }, function () { /* тихо */ });
        }
        if (D.isIngestRpc(url)) {
          promise.then(function (resp) {
            try {
              if (resp && resp.ok) {
                resp.clone().text().then(function (txt) {
                  // v21: гард ждёт reqConvIdPromise (обычно уже разрешён)
                  reqConvIdPromise.then(function (reqConvId) {
                    // v44/v59: чужой снимок — convId запроса ≠ текущий, ИЛИ «гард слеп» (reqConvId
                    // пуст), но запрос уходил для другого чата/эпохи (SPA-навигация до прибытия ответа).
                    var staleShot = (reqConvId && reqConvId !== D.currentConvId) ||
                      (!reqConvId && issuedAtConvId !== '' && issuedAtConvId !== D.currentConvId) ||
                      (!reqConvId && issuedAtEpoch !== D.convEpoch); // v59
                    if (staleShot) {
                      debugLog('log', '[AI CM][ingest] drop stale-conv reqConv=' + (reqConvId || issuedAtConvId || '(none)') + ' curConv=' + (D.currentConvId || '(none)') + ' src=passive');
                      return;
                    }
                    if (!reqConvId) {
                      // v21: точный диагностический лог при слепоте
                      debugLog('log', '[gemini-intercept] гард слеп (reqConvId пуст) путь=fetch input=' + diagInputType +
                        ' init.body=' + diagInitBody + ' — пропускаем только чужие (выпуск для ' + issuedAtConvId + ')');
                    }
                    // первый валидный ответ нового чата снимает блокировку автоскролла
                    if (D.autoScrollBlocked) {
                      D.autoScrollBlocked = false;
                      if (D.autoScrollUnblockTimer) { clearTimeout(D.autoScrollUnblockTimer); D.autoScrollUnblockTimer = null; }
                      debugLog('log', '[gemini-intercept] автоскролл разблокирован — получен первый валидный снимок чата ' + D.currentConvId);
                    }
                    D.ingest(txt, {});
                  });
                }).catch(function () { });
              }
            } catch (e) { }
            return resp;
          }, function () { /* v24: тихо — не создаём висячий Promise.reject */ });
        }
        // v28: DIAG_TOKENS — диагностический перехват ВСЕХ ответов Gemini (не только history RPC)
        promise.then(function (resp) {
          try {
            if (!resp || !resp.ok) return;
            var ct = '';
            try { ct = resp.headers.get('content-type') || ''; } catch (e) { }
            if (!D.diagCanScan(url, ct)) return;
            if (D.diagScannedCount < D.DIAG_MAX_SCANNED) {
              D.diagScannedCount++;
              debugLog('log', '[gemini-token-diag-scan] url=' + url +
                ' ct=' + ct + ' stream=' + (D.diagIsStream(url, ct) ? 'true' : 'false'));
            }
            var isStream = D.diagIsStream(url, ct);
            resp.clone().text().then(function (txt) {
              D.diagScanResponse(txt, url, isStream);
            }).catch(function () { });
          } catch (e) { }
          return resp;
        }, function () { });
        return promise;
      };
    }

    // ---- подмена XHR (v21: гард по convId, без изменений относительно v20) ----
    if (D.originalXHROpen && D.originalXHRSend) {
      D.OriginalXHR.prototype.open = function (method, url) {
        try { this.__aiCm = { method: String(method).toUpperCase(), url: String(url), headers: {} }; } catch (e) { }
        return D.originalXHROpen.apply(this, arguments);
      };
      if (D.originalSetHeader) {
        D.OriginalXHR.prototype.setRequestHeader = function (k, v) {
          try { if (this.__aiCm) this.__aiCm.headers[k] = v; } catch (e) { }
          return D.originalSetHeader.apply(this, arguments);
        };
      }
      D.OriginalXHR.prototype.send = function (body) {
        var info = this.__aiCm || {}; var url = info.url || '';
        if (D.isHistoryRpc(url)) {
          D.rememberSiteMeta(url, info.headers || {}, typeof body === 'string' ? body : '');
        }
        // v20: сохраняем reqConvId в this.__aiCm для использования в load-обработчике
        if (D.isIngestRpc(url) && typeof body === 'string') {
          info.reqConvId = D.convIdFromBody(body);
        }
        // v44: convId чата В МОМЕНТ ОТПРАВКИ — фолбэк атрибуции, когда тело не распарсилось
        if (D.isIngestRpc(url)) {
          info.issuedAtConvId = D.getConvId();
          info.issuedAtEpoch = D.convEpoch; // v59: эпоха на момент отправки
        }
        // v52: stream-ingest (XHR) — ветка ДО isIngestRpc: ответы генерации (I4z33b/Bsxleb)
        if (D.isStreamIngestRpc(url)) {
          var selfStream = this;
          this.addEventListener('load', function () {
            try {
              if (selfStream.status >= 200 && selfStream.status < 300 && selfStream.responseText) {
                D.provisionalStreamIngest(selfStream.responseText, D.streamRpcidOf(url));
              }
            } catch (e) { swallowSoft(e, 'gemini:xhr-load-listener-stream'); }
          });
        }
        if (D.isIngestRpc(url)) {
          var self = this;
          this.addEventListener('load', function () {
            try {
              if (self.status >= 200 && self.status < 300 && self.responseText) {
                // v20: гард — ответ от старого чата игнорируем
                var rcv = self.__aiCm && self.__aiCm.reqConvId;
                var icv = self.__aiCm && self.__aiCm.issuedAtConvId; // v44: выпуск запроса (фолбэк атрибуции)
                var iep = (self.__aiCm && typeof self.__aiCm.issuedAtEpoch === 'number') ? self.__aiCm.issuedAtEpoch : -1; // v59
                // v44/v59: чужой снимок — convId запроса ≠ текущий, ИЛИ «гард слеп», но запрос
                // уходил для другого чата/эпохи (SPA-навигация до прибытия ответа).
                var staleShot = (rcv && rcv !== D.currentConvId) ||
                  (!rcv && icv && icv !== D.currentConvId) ||
                  (!rcv && iep !== D.convEpoch); // v59
                if (staleShot) {
                  debugLog('log', '[AI CM][ingest] drop stale-conv reqConv=' + (rcv || icv || '(none)') + ' curConv=' + (D.currentConvId || '(none)') + ' src=passive');
                  return;
                }
                if (!rcv) {
                  // v21: точный диагностический лог при слепоте (XHR)
                  debugLog('log', '[gemini-intercept] гард слеп (reqConvId пуст) путь=xhr input=send body=' +
                    (typeof body === 'string' ? 'string len=' + body.length : (body ? typeof body : 'absent')) +
                    ' — пропускаем только чужие (выпуск для ' + icv + ')');
                }
                // первый валидный ответ нового чата снимает блокировку автоскролла
                if (D.autoScrollBlocked) {
                  D.autoScrollBlocked = false;
                  if (D.autoScrollUnblockTimer) { clearTimeout(D.autoScrollUnblockTimer); D.autoScrollUnblockTimer = null; }
                  debugLog('log', '[gemini-intercept] автоскролл разблокирован — получен первый валидный XHR-снимок чата ' + D.currentConvId);
                }
                D.ingest(self.responseText, {});
              }
            } catch (e) { swallowSoft(e, 'gemini:xhr-load-listener-ingest'); }
          });
        }
        // v28: DIAG_TOKENS — диагностический перехват ВСЕХ XHR-ответов (не только history RPC)
        try {
          var self2 = this;
          this.addEventListener('load', function () {
            try {
              if (self2.status >= 200 && self2.status < 300 && self2.responseText) {
                var ct2 = '';
                try { ct2 = self2.getResponseHeader('content-type') || ''; } catch (e) { }
                if (D.diagCanScan(url, ct2)) {
                  if (D.diagScannedCount < D.DIAG_MAX_SCANNED) {
                    D.diagScannedCount++;
                    debugLog('log', '[gemini-token-diag-scan] url=' + url +
                      ' ct=' + ct2 + ' stream=' + (D.diagIsStream(url, ct2) ? 'true' : 'false'));
                  }
                  var isStream2 = D.diagIsStream(url, ct2);
                  D.diagScanResponse(self2.responseText, url, isStream2);
                }
              }
            } catch (e) { }
          });
        } catch (e) { }
        return D.originalXHRSend.apply(this, arguments);
      };
    }
  }

  // ---- API модуля (фасад для ядра и тестов) ----
  var Api = {
    __bind: __bind,
    installNetworkHooks: installNetworkHooks
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmGeminiSse = Api;
})();
