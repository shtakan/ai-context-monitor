/**
 * core/gemini-diag-dump.ts — дамп диагностики E2E-моста Gemini (Phase 3, шаг 2).
 *
 * ЧТО ЗДЕСЬ. Бывший «Кластер 2» ядра (строки 1628-1663 core/gemini-intercept.js):
 * слушатель 'ai-cm-diag-request' и ответ 'ai-cm-diag-response'. content.js (ISOLATED-мир)
 * просит дамп — сводку ходов (id/order/pageMode/r1/role/preview), порядок lastOrderedIds,
 * ring логов перехватчика (__aiCmGetLogRing из utils/debug.ts) и скелет страницы, которая
 * не распарсилась (lastFailedSkeleton). Это чистая диагностика: дамп ничего не пишет в
 * ядро и не участвует в сборе базы.
 *
 * СПАЙК ПЕРЕНОСА (Вариант А): `with` снят. Свободные имена объекта связи — turnsMap /
 * lastOrderedIds / lastFailedSkeleton — больше не резолвятся через `with (D)`, каждый
 * получил ЯВНЫЙ префикс: D.turnsMap, D.lastOrderedIds, D.lastFailedSkeleton. Поэтому файл
 * компилируется как TypeScript (в ES-модулях и strict-режиме `with` запрещён), оставаясь
 * при этом ровно тем же classic-скриптом. Гард `if (!D)` в начале слушателя оставлен: до
 * связки объекта D нет, и событие игнорируется с внятным логом, а не бросает ReferenceError.
 *
 * ЧТО ПРЕФИКСА НЕ ПОЛУЧАЕТ. debugLog и __aiCmGetLogRing — функции MAIN-мира, их в объекте
 * связи НЕТ (D отдаёт ровно три геттера, см. bind-узел в core/gemini-intercept.js), они
 * резолвятся из глобальной области классического скрипта (dist/utils/debug.js публикует их
 * в globalThis). D.debugLog был бы undefined. window/Object/String/CustomEvent — системные.
 *
 * СОСТОЯНИЕ ОСТАЁТСЯ В ЯДРЕ. turnsMap, lastOrderedIds и lastFailedSkeleton объявлены в
 * core/gemini-intercept.js и переприсваиваются (сброс при смене чата, новый порядок из
 * emitBaseSnapshot, каждая непарсящаяся страница), поэтому ядро отдаёт их ЖИВЫМИ
 * геттерами: копия по значению устарела бы на первом же сбросе.
 *
 * ПОРЯДОК ПОДКЛЮЧЕНИЯ. js[] регистрации id -v14 в core/background.ts грузит этот файл
 * ПЕРЕД core/gemini-intercept.js: ядро связывает модуль при своей загрузке. Без модуля
 * дамп недоступен — 'ai-cm-diag-request' остаётся без ответа, остальной перехват работает
 * как прежде (диагностика — не гейт полноты).
 *
 * ИМЯ НА ДИСКЕ И В РАНТАЙМЕ. Источник — .ts (включён в tsconfig), но chrome.scripting
 * грузит classic-скрипт по пути из js[] (core/gemini-diag-dump.js): build.mjs находит
 * .ts-сосед через scriptSourcePath() и пишет его в dist/core/gemini-diag-dump.js
 * (type-strip, format не меняется). Файл намеренно без директивы строгого режима: спайк
 * меняет только способ доступа к объекту связи, ничего больше.
 *
 * PUBLIC API: window.AiCmGeminiDiagDump = { __bind }.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiDiagDump) return;
  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  // Форма публичного API объявлена сразу, чтобы tsc видел поле __bind: значение
  // выдаётся только после связки (Fn.__bind = __bind ниже), до неё наружу не уходит.
  var Fn = { __bind: null };
  function __bind(d) {
    D = d;

  // ================= ДАМП ДИАГНОСТИКИ =================
  // content.js (ISOLATED-мир) диспатчит 'ai-cm-diag-request'; перехватчик (MAIN-мир)
  // отвечает 'ai-cm-diag-response' с полным состоянием порядка/логов.
  try {
    window.addEventListener('ai-cm-diag-request', function () {
      if (!D) { debugLog('error', '[gemini-diag-dump] D is null, event ignored'); return; }
      try {
        var turnDump = [];
        var mapKeys = Object.keys(D.turnsMap);
        for (var di = 0; di < mapKeys.length; di++) {
          var dk = mapKeys[di];
          var dRec = D.turnsMap[dk];
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
        for (var op = 0; op < D.lastOrderedIds.length; op++) {
          var oid = D.lastOrderedIds[op];
          var oRec = D.turnsMap[oid];
          orderedPreviews.push((oRec ? (oRec.role + '|') : '?|') + (oRec ? String(oRec.text || '').slice(0, 60).replace(/\s+/g, ' ') : oid));
        }
        var response = {
          logsIntercept: (typeof __aiCmGetLogRing === 'function') ? __aiCmGetLogRing() : [],
          turns: turnDump,
          orderedPreviews: orderedPreviews,
          failedPageSkeleton: D.lastFailedSkeleton || null
        };
        window.dispatchEvent(new CustomEvent('ai-cm-diag-response', { detail: response }));
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmGeminiDiagDump = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
