/**
 * core/gemini-oracle.js — кластер оракула полноты Gemini (Phase 3 step 13.3).
 *
 * ЧТО ЗДЕСЬ. Пять функций и один слушатель, которые решают ОДИН вопрос: доказана ли
 * полнота базы, и если да — по какому основанию:
 *   • stableFloorConfirm (v82) — независимый источник floor-confirmed: база стабильна
 *     >=5с и не ниже пола → полнота без лоадера;
 *   • noteBaseCountChange (v74) — метка изменения счётчика базы и debounce-триггер
 *     (5500мс) floor-confirmed;
 *   • notifyLoaderState (v42/v53/v78) — состояние лоадера наружу ПО convId (событие
 *     ai-cm-loader-state) и вложенный stableCheck74 (loader-stable-stop, O-48 parse-fail,
 *     clean-end-подтверждение, самоунижение устаревшего пола);
 *   • aiCmDiagHash6 / aiCmDiagTurnEdge / aiCmOrderedTurns (v61diag) — отпечатки краёв базы;
 *     их питают H9-гейт полноты (serverFirstHash / dbFirstHash), а не только логи;
 *   • window.__aiCmGeminiTurnsSnapshot + мост ai-cm-turns-snap-request/response —
 *     синхронный снимок базы для дампов экспорта из ISOLATED-мира.
 *
 * ПОЧЕМУ ВЫНЕСЕНО. Это единственный кластер ядра, который ПОДТВЕРЖДАЕТ полноту, а не
 * собирает базу: он читает вердикты и счётчики (13 имён только на чтение), пишет четыре
 * вердикта полноты и таймер, зовёт десять функций ядра и отдаёт наружу пять имён.
 * Логика полноты перестала быть размазанной по ядру: её видно целиком в одном файле.
 *
 * ПРАВКА ПРИ ПЕРЕНОСЕ. Тела перенесены БАЙТ-В-БАЙТ и лежат ВНУТРИ `with (D)`: свободные
 * имена (getConvId, historyFullByQuiet, pendingCursor, lastBaseTextLen и пр.) резолвятся
 * объектом связи, поэтому префикс D. НЕ добавлен. Это не стилистика: шесть существующих
 * пинов (gemini-floor-confirmed, gemini-floor-self-heal, gemini-floor-monotonic-h11,
 * gemini-collapse-guard, o48-gemini-parse-fail-salvage, gemini-dr-report) режут эти тела из
 * конкатенации и исполняют их в песочнице `with (ctx)` БЕЗ ключа D — при D.-стиле свободное
 * имя перестало бы разрешаться. Тот же механизм — в core/pagination/pagination.js и
 * core/gemini-ingest.js. Единственные добавления: гард `if (!D)` в начале слушателя и
 * два имени контракта (lastHnvPageError, lastBaseTextLen — см. ниже).
 *
 * СОСТОЯНИЕ ОСТАЁТСЯ В ЯДРЕ. floorConfirmDebounceTimer, история полноты (historyFullByQuiet,
 * reachedStart, quietIncompleteNoStart, lastCycleEndedHidden, quietEndedClean,
 * oracleIncompleteSeen, lastLoaderDoneReason), счётчики базы (lastBaseCount,
 * lastBaseCountChangeAt) и входы оракула (pendingCursor, lastIngestParseFail,
 * lastOlderNonPagAddAt, turnsMap, lastOrderedIds, parserVersion, loaderRunningFor,
 * quietActive, reachedStartByScroll, loaderState, lastHnvPageError, lastBaseTextLen)
 * объявлены в ядре и НЕ перенесены: их пишут и читают ingest, лоадер, пагинация, сброс при
 * смене чата и сетевые хуки. Модуль получает их ЖИВЫМИ геттерами (и сеттерами там, где
 * пишет), поэтому присваивание вердикта доходит до той же переменной IIFE, а не до копии.
 *
 * ДВА ИМЕНИ СВЕРХ ПЛАНА. lastHnvPageError и lastBaseTextLen читаются в stableCheck74 под
 * typeof-гардом. Гард спасает песочницу пина (там имён нет), но в бою он обязан видеть
 * ЖИВОЕ значение: без привязки typeof дал бы 'undefined' → pageError навсегда false
 * (самоунижение пола разрешалось бы при ошибке страницы — ослабление H10) и provenLen=0
 * (понижение пола записало бы устаревшую длину вместо реальной — ровно то, что запрещает
 * selfHealFloorVerdict). Поэтому оба имени переданы геттерами — как в контракте пагинации.
 *
 * ПОРЯДОК ПОДКЛЮЧЕНИЯ. utils/debug.js, utils/gemini-batchexecute-parser.js,
 * utils/gemini-intercept-logic.js, core/gemini-hidden-scroll.js, core/gemini-diag.js,
 * core/gemini-rpc.js, core/gemini-parse.js, core/gemini-sse.js,
 * core/pagination/pagination.js, core/gemini-loader-scroll.js, core/gemini-ingest.js,
 * core/gemini-overlay.js, core/gemini-archive.js, ЭТОТ ФАЙЛ, core/gemini-intercept.js —
 * см. js[] в core/background.js (id -v11: MV3 не перечитывает js[] под уже зарегистрированным
 * id, поэтому при добавлении файла id обязан смениться). Без модуля оракул недоступен
 * целиком: floor-confirmed и loader-stable-stop не взводятся, снапшот ходов пуст, а
 * форвардеры ядра возвращают undefined — база молча остаётся «неполной».
 *
 * ВНИМАНИЕ. Слушатель регистрируется на ВЫЗОВЕ __bind (то есть при загрузке ядра), а не на
 * загрузке модуля: до связки объекта D нет, и гард `if (!D)` в начале слушателя закрывает
 * этот случай внятным логом, а не ReferenceError. По той же причине Fn наполняется ТОЛЬКО
 * связкой (тела объявлены внутри with (D)): на window до __bind лежит один __bind. Форвардеры
 * ядра объявлены выше связки и до неё НЕ зовутся — они лишь раздаются значениями чужим
 * __bind-блокам; первый реальный вызов (notifyLoaderState из checkConvChange) приходит
 * событием SPA-перехода, то есть заведомо после связки. Файл намеренно без директивы
 * строгого режима и без D.-префиксов — как модуль пагинации и ingest.
 *
 * PUBLIC API: window.AiCmGeminiOracle = { __bind, noteBaseCountChange, notifyLoaderState,
 *   aiCmDiagHash6, aiCmDiagTurnEdge, aiCmOrderedTurns }.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiOracle) return;
  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  var Fn = {};
  function __bind(d) {
    D = d;
    with (D) {

      // ---- floor-confirm: независимый источник полноты (v82) ----
  function stableFloorConfirm() {
    try {
      var convIdFc = getConvId();
      if (!convIdFc || historyFullByQuiet || loaderRunningFor || quietActive) return;
      if (!(lastBaseCount > 0)) return;
      var floorFc = null;
      try { floorFc = loadFloor(convIdFc); } catch (eFcL) { swallowSoft(eFcL, 'gemini:stableFloorConfirm-floor-read'); }
      if (!floorFc || !(floorFc.count > 0)) return;
      if (lastBaseCount < floorFc.count) return;
      // T1-fix#2 (v1.16.2): пол этого чата поднят АРХИВОМ (его count), поэтому «база не
      // ниже пола» доказывает ровно вклад архива, а не догруженную живую историю.
      // Live-прогон: архив 4 хода → floor=4 → через 5.5с тишины confirm → автоэкспорт
      // уходил с одной архивной частью (живой хвост ещё не успел прийти).
      // typeof-гард: helper объявлен всегда; в извлечённых sandbox-телах его нет —
      // поведение прежнее (байтово), как и для чатов без архива.
      if (typeof aiCmArchiveLiveProven === 'function' && !aiCmArchiveLiveProven(convIdFc)) {
        debugLog('log', '[AI CM][completeness] oracle=incomplete reason=archive-live-pending(floor-confirm) convId=' + convIdFc +
          ' msgs=' + lastBaseCount + ' floor=' + floorFc.count +
          ' archiveMsgs=' + (((aiCmArchiveFor(convIdFc) || {}).count) || 0) +
          ' liveMsgs=' + aiCmLiveTurnCount());
        return;
      }
      var nowFc = Date.now();
      if ((nowFc - lastBaseCountChangeAt) < 5000) return;
      if ((nowFc - lastOlderNonPagAddAt) < 5000) return;
      historyFullByQuiet = true;
      reachedStart = true;
      quietIncompleteNoStart = false;
      try { delete oracleIncompleteSeen[convIdFc]; } catch (eFcO) { }
      debugLog('log', '[AI CM][completeness] oracle=complete reason=floor-confirmed convId=' + convIdFc +
        ' msgs=' + lastBaseCount + ' floor=' + floorFc.count);
      try { emitBaseSnapshot(); } catch (eFcE) { swallowSoft(eFcE, 'gemini:stableFloorConfirm-emit'); }
    } catch (eFcX) { swallowSoft(eFcX, 'gemini:stableFloorConfirm'); }
  }
  function noteBaseCountChange() {
    var n74 = baseSize();
    if (n74 !== lastBaseCount) { lastBaseCount = n74; lastBaseCountChangeAt = Date.now(); }
    // v82: debounce-триггер floor-confirmed — после 5.5с тишины по базе перепроверяем полноту
    // по полу. clearTimeout отменяет предыдущий; stableCheck74 и его setTimeout(5000) не меняются.
    try {
      if (floorConfirmDebounceTimer) { clearTimeout(floorConfirmDebounceTimer); floorConfirmDebounceTimer = null; }
      floorConfirmDebounceTimer = setTimeout(stableFloorConfirm, 5500);
    } catch (eFcT) { }
  }

      // ---- loader-state + loader-stable-stop (v42/v53/v74/v78) ----
  // v42: состояние лоадера наружу ПО convId. content.js живёт в ISOLATED-мире и не видит
  // MAIN-глобалы, поэтому канал — window-CustomEvent (тот же механизм, что ai-cm-loader-freeze).
  function notifyLoaderState(convId, running) {
    try {
      if (!running) {
        lastCycleEndedHidden = (document.visibilityState !== 'visible'); // v1.13.1
        // T1-fix (v1.16.1): живой ярус остановился — переоцениваем оракул архива ДО
        // dispatch ниже, чтобы свежая полнота уехала в том же ai-cm-loader-state
        // (иначе после стопа лоадера emit может не прийти и экспорт не триггернётся).
        try { aiCmArchiveTierApply(); } catch (eArcLs) { swallowSoft(eArcLs, 'gemini:notifyLoaderState-archive-reapply'); }
        // v74 (баг A): стабильный loader-stop — независимое подтверждение полноты.
        // pendingCursor нет И счётчик базы не менялся ≥5с И старших добавлений вне
        // пагинации ≥5с → полнота сразу (вместо 60с-задержки и [LOW CONFIDENCE]_).
        var stableCheck74 = function () {
          try {
            var now74 = Date.now();
            if (!convId || pendingCursor || historyFullByQuiet) return;
            if (!(lastBaseCount > 0)) return;
            // O-48: база, в которую НЕ долился оборванный JSON-кадр, полной не объявляется.
            // «Курсора нет» на обрезанном ответе — не доказательство терминальной страницы;
            // отдельный reason='parse-fail' в прогрессе лоадера (бюджет полноты не тратится,
            // рестарта нет) — итог честный: неполная база + [LOW CONFIDENCE].
            var __pf74 = (typeof lastIngestParseFail === 'undefined') ? null : lastIngestParseFail;
            if (__pf74 && __pf74.convId === convId && (now74 - (__pf74.ts || 0)) < 120000) {
              debugLog('log', '[AI CM][completeness] oracle=incomplete reason=parse-fail convId=' + convId +
                ' src=' + __pf74.src + ' declaredN=' + __pf74.declaredN +
                ' availableBytes=' + __pf74.availableBytes + ' clamped=' + (__pf74.clamped ? '1' : '0') +
                ' salvagedTurns=' + __pf74.salvaged + ' msgs=' + lastBaseCount +
                ' (обрыв кадра: stable-stop НЕ подтверждает полноту)');
              return;
            }
            var sf78 = null;
            try { sf78 = loadFloor(convId); } catch (eSf78) { swallowSoft(eSf78, 'gemini:stableCheck74-floor-read'); }
            var floorCount78 = (sf78 && sf78.count) || 0;
            // v1.15 (BUG «холодное открытие без полной истории»): сеть ЧИСТО завершила
            // пагинацию (quietEndedClean: без ошибки-страницы и без живого курсора), но
            // скролл-лоадер не дошёл до done reason=top (маленький/схлопнутый скроллер,
            // напр. холодный старт с восстановленной лентой: h=864, hide не применяется,
            // visible-scroll запрещён → done reason=not-hidden-wait-cap). Если база при этом
            // не ниже пола — подтверждаем полноту (top не достижим, а догонять нечего).
            // Инвариант 3в: clean-end-подтверждение ТОЛЬКО при floor>0 — при floor=0 (класс
            // первого визита) пол не задан, «не ниже пола» тривиально и ранний confirm без
            // физического верха был бы ложной полнотой (см. SPA-прогон 1984298f: done=collapse
            // msgs=80 floor=0 до ручного скролла). Первый визит подтверждается ТОЛЬКО top.
            var cleanEnd78 = false;
            try {
              cleanEnd78 = (typeof quietEndedClean !== 'undefined' && quietEndedClean === true &&
                floorCount78 > 0 &&
                (typeof pendingCursor === 'undefined' ? true : !pendingCursor));
            } catch (e78q) { cleanEnd78 = false; }
            // v1.16.5 (T1-fix#5): САМОУНИЖЕНИЕ УСТАРЕВШЕГО ПОЛА. cleanEnd78 — доказательство
            // того, что сеть отдала всю историю (quietEndedClean, курсора продолжения нет),
            // а reachedStart при этом может оставаться 0: физического верха лоадер не нашёл.
            // Если база НИЖЕ пола, пол снят с УЖЕ УКОРОЧЕННОЙ на сервере истории — держать его
            // нельзя: base < floor вечно уводит оракул в incomplete (loader-max-not-top /
            // below-floor) → полнота не подтверждается, экспорт остаётся в deferred, а
            // completeness-оракул гоняет loader-restart по кругу, хотя окно вырасти не может.
            // Решение — ТОЛЬКО через формальный вердикт (selfHealFloorVerdict), запись — через
            // единственную точку понижения (selfHealFloor → writeSelfHealedFloor).
            // HWM saveFloor/archiveFloorRecord и H9/H10-гейты не тронуты: понижение возможно
            // лишь при доказанном чистом конце + подтверждающем повторе (база стабильна ≥5с),
            // а при архиве без доказанного живого яруса оно запрещено (archive-pending-live).
            // Блок стоит ДО ветки lastLoaderDoneReason !== 'top': иначе deadlock-ветка
            // loader-max-not-top вернулась бы раньше, чем пол успел самоунизиться.
            if (cleanEnd78 && floorCount78 > 0 && lastBaseCount > 0 && lastBaseCount < floorCount78) {
              var __shv74 = null;
              try {
                if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                    typeof window.GeminiInterceptLogic.selfHealFloorVerdict === 'function') {
                  __shv74 = window.GeminiInterceptLogic.selfHealFloorVerdict({
                    cleanEnd: true,
                    pendingCursor: (typeof pendingCursor === 'undefined') ? null : pendingCursor,
                    quietActive: (typeof quietActive === 'undefined') ? false : (quietActive === true),
                    pageError: (typeof lastHnvPageError === 'undefined') ? false : (lastHnvPageError === true),
                    loaderRunning: (typeof loaderRunningFor === 'undefined') ? false : !!loaderRunningFor,
                    archivePending: !!(typeof aiCmArchiveFor === 'function' && aiCmArchiveFor(convId) &&
                      typeof aiCmArchiveLiveProven === 'function' && !aiCmArchiveLiveProven(convId)),
                    baseCount: lastBaseCount,
                    floorCount: floorCount78,
                    floorLen: (sf78 && sf78.effectiveLen) || 0,
                    provenLen: (typeof lastBaseTextLen === 'undefined') ? 0 : lastBaseTextLen,
                    reachedStart: reachedStart === true,
                    confirmations: (lastBaseCountChangeAt && (now74 - lastBaseCountChangeAt) >= 5000) ? 1 : 0
                  });
                }
              } catch (eShv74) { __shv74 = null; }
              if (__shv74 && __shv74.lower === true) {
                var __shW74 = null;
                try { __shW74 = selfHealFloor(convId, __shv74.count, __shv74.effectiveLen, __shv74.source); } catch (eShW74) { __shW74 = null; }
                floorCount78 = __shv74.count; // ветки ниже читают САМОИЗЛЕЧЕННЫЙ пол
                debugLog('log', '[AI CM][completeness] floor self-healed (clean-end) convId=' + convId +
                  ' floorWas=' + __shv74.floorWas + ' floorNow=' + floorCount78 +
                  ' msgs=' + lastBaseCount + ' reachedStart=' + (reachedStart === true ? '1' : '0') +
                  ' source=' + __shv74.source + (__shW74 ? '' : ' (write skipped)'));
              }
            }
            // v78: loader-stable-stop подтверждает полноту ТОЛЬКО когда скролл-лоадер дошёл до
            // физического верха (done reason=top) И база не ниже пола. Иначе — incomplete,
            // baseComplete остаётся 0 и экспорт остаётся deferred (гейт в content.js).
            // v1.15: исключение — чистый конец сети при базе >= пола (см. cleanEnd78 выше).
            if (lastLoaderDoneReason !== 'top') {
              // T1-fix#2 (v1.16.2): clean-end-подтверждение опирается на ПОЛ, а пол мог быть
              // поднят самим архивом (floorCount78 > 0 выполняется его вкладом) — без
              // доказанного живого роста это доказательство архива, а не живого яруса.
              // Ветка done reason=top (реальный live-доказательство) НЕ трогается.
              if (cleanEnd78 && lastBaseCount >= floorCount78 &&
                  typeof aiCmArchiveLiveProven === 'function' && !aiCmArchiveLiveProven(convId)) {
                debugLog('log', '[AI CM][completeness] oracle=incomplete reason=archive-live-pending(clean-end) convId=' + convId +
                  ' msgs=' + lastBaseCount + ' floor=' + floorCount78 +
                  ' archiveMsgs=' + (((aiCmArchiveFor(convId) || {}).count) || 0) +
                  ' liveMsgs=' + aiCmLiveTurnCount());
                return;
              }
              if (!(cleanEnd78 && lastBaseCount >= floorCount78)) {
                debugLog('log', '[AI CM][completeness] oracle=incomplete reason=loader-max-not-top convId=' + convId +
                  ' done=' + lastLoaderDoneReason + ' msgs=' + lastBaseCount + ' floor=' + floorCount78 +
                  (cleanEnd78 ? ' cleanEnd=1' : ''));
                return;
              }
              debugLog('log', '[AI CM][completeness] oracle=clean-end-stable convId=' + convId +
                ' done=' + lastLoaderDoneReason + ' msgs=' + lastBaseCount + ' floor=' + floorCount78 +
                ' (чистый конец сети, top не достижим — подтверждаю полноту)');
            }
            if (lastBaseCount < floorCount78) {
              debugLog('log', '[AI CM][completeness] oracle=incomplete reason=below-floor convId=' + convId +
                ' msgs=' + lastBaseCount + ' floor=' + floorCount78);
              return;
            }
            if (lastBaseCountChangeAt && (now74 - lastBaseCountChangeAt) < 5000) return;
            if ((now74 - lastOlderNonPagAddAt) < 5000) return;
            historyFullByQuiet = true;
            reachedStart = true;
            quietIncompleteNoStart = false;
            try { delete oracleIncompleteSeen[convId]; } catch (eD15s) { } // v1.6 (D15): успешный stable-stop — флаг снят
            debugLog('log', '[AI CM][completeness] oracle=complete reason=loader-stable-stop convId=' + convId +
              ' msgs=' + lastBaseCount + ' floor=' + floorCount78);
            try { emitBaseSnapshot(); } catch (eEs74) { swallowSoft(eEs74, 'gemini:stableCheck74-emit'); }
          } catch (e74b) { swallowSoft(e74b, 'gemini:stableCheck74'); }
        };
        stableCheck74();
        setTimeout(stableCheck74, 5000); // повторная проверка через 5с тишины
      }
      // v53: наружу также курсор и полноту базы — гейт автоэкспорта (content.js) по ним
      // решает, можно ли стрелять при стопе лоадера (живой курсор/неполная база → нельзя).
      // v1.13.1: наружу также reachedStart — content.js отличает подтверждённую полноту
      // (baseComplete при reachedStart=true) от ложной (курсор пропал без начала).
      window.dispatchEvent(new CustomEvent('ai-cm-loader-state', { detail: {
        convId: convId,
        running: !!running,
        pendingCursor: !!pendingCursor,
        baseComplete: historyFullByQuiet === true,
        reachedStart: reachedStart === true
      } }));
    } catch (e) { swallowSoft(e, 'gemini:notifyLoaderState'); }
  }

      // ---- v61diag: отпечатки краёв базы ----
  // ================= v61diag: диагностика холодного старта (ТОЛЬКО добавление логов, стейт-машина не тронута) =================
  // FNV-1a 32-bit от id||text → первые 6 hex-символов как отпечаток хода.
  function aiCmDiagHash6(id, text) {
    try {
      var s = String(id || '') + '\u0000' + String(text || '');
      var h = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return ('000000' + h.toString(16)).slice(-6);
    } catch (e) { return '000000'; }
  }
  function aiCmDiagTurnEdge(turns, which) {
    if (!turns || !turns.length) return { hash: '-', text: '' };
    var t = turns[which === 'last' ? turns.length - 1 : 0];
    return {
      hash: aiCmDiagHash6(t && t.id, t && t.text),
      text: String((t && t.text) || '').slice(0, 80).replace(/\s+/g, ' ')
    };
  }
  // Диагностический срез ходов по v33-глобальному order (на эмит не влияет).
  function aiCmOrderedTurns() {
    var ids = Object.keys(turnsMap);
    ids.sort(function (a, b) { return (turnsMap[a].order || 0) - (turnsMap[b].order || 0); });
    return ids.map(function (id) { return { id: id, text: turnsMap[id].text || '' }; });
  }

      // ---- v61diag: сводка turnsMap для дампов экспорта ----
      // Сводка строится из живых хелперов ВЫШЕ (aiCmOrderedTurns / aiCmDiagTurnEdge) и
      // ОБЪЕДИНЁННОЙ базы (aiCmBaseExportInfo из core/gemini-archive.js). content.js
      // (ISOLATED) получает её синхронно через CustomEvent-мост
      // ai-cm-turns-snap-request/response; из консоли MAIN-мира доступна как
      // window.__aiCmGeminiTurnsSnapshot().
  try {
    if (!window.__aiCmGeminiTurnsSnapshot) {
      window.__aiCmGeminiTurnsSnapshot = function () {
        var turns = aiCmOrderedTurns();
        var fe = aiCmDiagTurnEdge(turns, 'first');
        var le = aiCmDiagTurnEdge(turns, 'last');
        // T1-fix#3 (v1.16.3): плюс ОБЪЕДИНЁННАЯ база (архив + live) — источник файла
        // автоэкспорта; content.js берёт её, если последний EMIT отстал от базы.
        var baseInfo = (typeof aiCmBaseExportInfo === 'function') ? aiCmBaseExportInfo() : null;
        return {
          convId: getConvId(),
          msgs: turns.length,
          firstMsgHash: fe.hash,
          lastMsgHash: le.hash,
          firstText: fe.text,
          lastText: le.text,
          baseComplete: historyFullByQuiet === true,
          reachedStart: reachedStart === true,
          confirmedByScroll: reachedStartByScroll === true,
          scrollEngaged: loaderState.scrollEngaged === true, // v66: скрытый скролл вовлечён?
          baseMsgs: baseInfo ? baseInfo.baseMsgs : turns.length,
          liveCount: baseInfo ? baseInfo.liveCount : null,
          archiveCount: baseInfo ? baseInfo.archiveCount : 0,
          liveProven: baseInfo ? baseInfo.liveProven : true,
          messages: (baseInfo && Array.isArray(baseInfo.messages)) ? baseInfo.messages : []
        };
      };
    }
  } catch (e) { }

      // ---- v61diag: синхронный мост к content.js (ISOLATED) ----
  // v61diag: синхронный мост — content.js (ISOLATED) запрашивает сводку turnsMap
  // для дампов в момент экспорта (snapshot-at-fired / snapshot-at-manual).
  try {
    window.addEventListener('ai-cm-turns-snap-request', function () {
      if (!D) { debugLog('error', '[gemini-oracle] D is null, event ignored'); return; }
      try {
        var diagSnap = (typeof window.__aiCmGeminiTurnsSnapshot === 'function') ? window.__aiCmGeminiTurnsSnapshot() : null;
        window.dispatchEvent(new CustomEvent('ai-cm-turns-snap-response', { detail: diagSnap }));
      } catch (e) { }
    });
  } catch (e) { }

      Fn.noteBaseCountChange = noteBaseCountChange;
      Fn.notifyLoaderState = notifyLoaderState;
      Fn.aiCmDiagHash6 = aiCmDiagHash6;
      Fn.aiCmDiagTurnEdge = aiCmDiagTurnEdge;
      Fn.aiCmOrderedTurns = aiCmOrderedTurns;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmGeminiOracle = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
