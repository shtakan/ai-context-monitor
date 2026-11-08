/**
 * core/gemini-diag-dump.js — дамп диагностики E2E-моста Gemini (Phase 3, шаг 2).
 *
 * ЧТО ЗДЕСЬ. Бывший «Кластер 2» ядра (строки 1628-1663 core/gemini-intercept.js):
 * слушатель 'ai-cm-diag-request' и ответ 'ai-cm-diag-response'. content.js (ISOLATED-мир)
 * просит дамп — сводку ходов (id/order/pageMode/r1/role/preview), порядок lastOrderedIds,
 * ring логов перехватчика (__aiCmGetLogRing из utils/debug.ts) и скелет страницы, которая
 * не распарсилась (lastFailedSkeleton). Это чистая диагностика: дамп ничего не пишет в
 * ядро и не участвует в сборе базы.
 *
 * ПРАВКА ПРИ ПЕРЕНОСЕ. Тело перенесено БАЙТ-В-БАЙТ и лежит ВНУТРИ `with (D)` — как в
 * core/gemini-oracle.js, core/gemini-ingest.js и core/pagination/pagination.js: свободные
 * имена turnsMap / lastOrderedIds / lastFailedSkeleton резолвятся объектом связи, префикс
 * D. НЕ добавлен. Единственное добавление — гард `if (!D)` в начале слушателя: до связки
 * объекта D нет, и событие игнорируется с внятным логом, а не бросает ReferenceError.
 *
 * СОСТОЯНИЕ ОСТАЁТСЯ В ЯДРЕ. turnsMap, lastOrderedIds и lastFailedSkeleton объявлены в
 * core/gemini-intercept.js и переприсваиваются (сброс при смене чата, новый порядок из
 * emitBaseSnapshot, каждая непарсящаяся страница), поэтому ядро отдаёт их ЖИВЫМИ
 * геттерами: копия по значению устарела бы на первом же сбросе.
 *
 * ПОРЯДОК ПОДКЛЮЧЕНИЯ. js[] регистрации id -v14 в core/background.js грузит этот файл
 * ПЕРЕД core/gemini-intercept.js: ядро связывает модуль при своей загрузке. Без модуля
 * дамп недоступен — 'ai-cm-diag-request' остаётся без ответа, остальной перехват работает
 * как прежде (диагностика — не гейт полноты). Файл намеренно без директивы строгого
 * режима и без D.-префиксов — как модуль оракула и ingest.
 *
 * PUBLIC API: window.AiCmGeminiDiagDump = { __bind }.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiDiagDump) return;
  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  var Fn = {};
  function __bind(d) {
    D = d;
    with (D) {

  // ================= ДАМП ДИАГНОСТИКИ =================
  // content.js (ISOLATED-мир) диспатчит 'ai-cm-diag-request'; перехватчик (MAIN-мир)
  // отвечает 'ai-cm-diag-response' с полным состоянием порядка/логов.
  try {
    window.addEventListener('ai-cm-diag-request', function () {
      if (!D) { debugLog('error', '[gemini-diag-dump] D is null, event ignored'); return; }
      try {
        var turnDump = [];
        var mapKeys = Object.keys(turnsMap);
        for (var di = 0; di < mapKeys.length; di++) {
          var dk = mapKeys[di];
          var dRec = turnsMap[dk];
          turnDump.push({
            id: dk,
            order: dRec.order,
            pageMode: dRec.pageMode || '',
            r1: dRec.r1 || null,
            role: dRec.role,
            preview: String(dRec.text || '').slice(0, 60).replace(/\s+/g, ' ')
          });
        }
        var orderedPreviews = [];
        for (var op = 0; op < lastOrderedIds.length; op++) {
          var oid = lastOrderedIds[op];
          var oRec = turnsMap[oid];
          orderedPreviews.push((oRec ? (oRec.role + '|') : '?|') + (oRec ? String(oRec.text || '').slice(0, 60).replace(/\s+/g, ' ') : oid));
        }
        var response = {
          logsIntercept: (typeof __aiCmGetLogRing === 'function') ? __aiCmGetLogRing() : [],
          turns: turnDump,
          orderedPreviews: orderedPreviews,
          failedPageSkeleton: lastFailedSkeleton || null
        };
        window.dispatchEvent(new CustomEvent('ai-cm-diag-response', { detail: response }));
      } catch (e) { }
    });
  } catch (e) { }

    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmGeminiDiagDump = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
