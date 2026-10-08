/**
 * core/gemini-loader-scroll.js
 * v2.0 (Phase 3 step 11): кластер «лоадер полной истории + автозапуск» вынесен из
 * core/gemini-intercept.js.
 *
 * ЧТО ЗДЕСЬ: константы окна и капа скролла (LOADER_*), порог вовлечения скрытого скролла
 * и пороги скрытия/паузы, асинхронная функция скрытого доскролла до начала истории со
 * всеми вложенными помощниками (подмена/восстановление позиции, кик-бэк, фолбэк полной
 * остановки), ожидание сигнала «старшая история», автозапуск по открытию чата, слушатель
 * возврата видимости вкладки (resume-on-visible) и консольный хэндл ручного запуска.
 *
 * ПОЧЕМУ ВЫНЕСЕНО: ядро перехватчика разрослось; лоадер — самодостаточный кластер с
 * одиночным владельцем прогона и своими константами, живущий поверх ядра.
 *
 * СВЯЗКА: ядро отдаёт зависимости один раз через __bind при своей загрузке. Функции —
 * значениями, состояние — ЖИВЫМИ геттерами/сеттерами: копия разошлась бы с ядром ровно
 * там, где ошибается полнота. Состояние прогона НЕ перенесено: его читают и пишут вне
 * кластера (ingest, stable-stop оракул, сброс бюджета при смене чата, активный vf5-путь).
 *
 * ПРАВКА ПРИ ПЕРЕНОСЕ: тела перенесены байт-в-байт; единственное изменение — ссылки на
 * имена ядра получили префикс D. (иначе свободное имя не разрешится: модуль — отдельный
 * файл, общего лексического скоупа с ядром у него нет). Свойства объектов, ключи
 * литералов и локальные имена не тронуты.
 *
 * ПОРЯДОК ПОДКЛЮЧЕНИЯ: utils/debug.js, utils/gemini-batchexecute-parser.js,
 * utils/gemini-intercept-logic.js, core/gemini-hidden-scroll.js, core/gemini-diag.js,
 * core/gemini-rpc.js, core/gemini-parse.js, core/gemini-sse.js,
 * core/pagination/pagination.js, ЭТОТ ФАЙЛ, core/gemini-intercept.js — см. js[] в
 * core/background.js (id -v7: MV3 не перечитывает js[] под уже зарегистрированным id,
 * поэтому при добавлении файла id обязан смениться, иначе модуль не доедет до профилей
 * с прежним id, а без модуля скрытый доскролл полной истории выключен целиком).
 *
 * ВНИМАНИЕ: слушатель visibilitychange регистрируется на загрузке модуля, то есть до
 * вызова __bind из ядра. Это безопасно: до первого реального события возврата видимости
 * ядро уже загружено (файлы идут одним пакетом content script без разрывов), а тело
 * слушателя обращается к зависимостям только при срабатывании.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiLoaderScroll) return;
  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  function __bind(d) { D = d; }

  // ---------- A: константы лоадера (LOADER_* / MIN_SCROLL_H_FOR_ENGAGEMENT) ----------
  var LOADER_MAX_ITER = 30;
  var LOADER_STEP_MS = 1200;    // v4z: окно пагинации медленное — 800мс давало ложную стабилизацию
  var LOADER_FIND_TRIES = 20;   // poll появления скроллера до 10с
  var LOADER_FIND_WAIT = 500;
  var LOADER_STABLE_NEED = 3;   // v30.7: три негро-стящих чтения до контрольного замера
  var LOADER_RECHECK_MS = 2000; // v4z: контрольный перемер после «стабилизации»
  var LOADER_RESUME_DELTA = 200; // v4z: вырос больше — возобновить цикл
  // v53: кап ретраев скролла при живом continuation-курсоре (h не растёт, курсор есть).
  // Холодный старт (простой >12ч) медленный — поднят до 90 (шаг ~1с → до ~90с).
  // Исчерпание капа → done reason=timeout. Раньше (30) лоадер стопился преждевременно
  // при ещё живой истории (логи 0362260d: pct=56.2 терялись до ручного скролла).
  var LOADER_STALL_CAP = 90;
  var LOADER_HIDE_MIN_H = 8000;
  // v66: доказательство вовлечения скрытого скролла. scrollEngaged=true при ЛЮБОМ из:
  //   1) hide-applied (скроллер прятался — значит лента реально прокручивалась);
  //   2) scrollH вырос за прогон на >= MIN_SCROLL_H_FOR_ENGAGEMENT пикселей;
  //   3) scrollTop менялся (были не у верха / положение сдвигалось).
  // data-complete / reachedStart / topReached доверять ТОЛЬКО при scrollEngaged:
  // холодный старт с невовлечённым скроллом (iter h=864 без роста, scrollTop=0)
  // давал ложный data-complete и high-confidence фрагмент (лог 15:40).
  // v67: порог роста scrollH за прогон для признания скрытого скролла вовлечённым —
  // отсеивает фоновые сдвиги верстки Gemini при холодной загрузке (мелкие перерисовки
  // дают сдвиги в десятки px; реальная подгрузка старших окон истории — в тысячи px).
  var MIN_SCROLL_H_FOR_ENGAGEMENT = 2000;

  // ---------- B: порог LOADER_HIDE_MIN_MSGS + SCROLL_PAUSE_HIDDEN_MS ----------
  // v45: минимальный число известных ходов по текущему convId для скрытия скроллера.
  // Обоснование: порог 50 ходов надёжно отделяет «короткий, но высокий» чат (мало msgs,
  // большая scrollHeight — пример f47e2edd h=11893) от реально длинной истории; у длинных
  // чатов после частичной подгрузки msgs обычно уже >50, поэтому скрытие не блокируется.
  var LOADER_HIDE_MIN_MSGS = 50;
  var SCROLL_PAUSE_HIDDEN_MS = 800; // v30.9: пауза между итерациями ПОСЛЕ скрытия скроллера // v30.7: скрытие ТОЛЬКО при scrollHeight>8000 — короткие чаты не прячем

  // ---------- C: loadFullHistoryInvisibly и все вложенные помощники ----------
  async function loadFullHistoryInvisibly() {
    var convId = D.getConvId();
    D.vf5OverlapSinceLoaderStart = false; // v62: vf5-overlap отсчитывается от старта лоадера
    D.isLowConfidenceBase = false; // v63: low-confidence отсчитывается от старта лоадера
    try {
      var sc = null;
      for (var t = 0; t < LOADER_FIND_TRIES; t++) {
        sc = D.findScrollContainer();
        if (sc) break;
        await D.sleep(LOADER_FIND_WAIT);
      }
      if (!sc) {
        debugLog('log', '[AI CM][Gemini][loader] skip reason=no-scroller convId=' + (convId || '(none)'));
        return;
      }

      debugLog('log', '[AI CM][Gemini][loader] start convId=' + convId + ' scrollH=' + sc.height());
      var prevSmooth = '';
      if (sc.mode === 'el') { try { prevSmooth = sc.el.style.scrollBehavior; sc.el.style.scrollBehavior = 'auto'; } catch (e) { } }
      var hiddenEl = null;
      var savedTop = sc.top();
      // v80 (O1): расстояние-до-низа ВЬЮПОРТА на момент ПЕРВОГО скролла (захват в
      // __applyHide, атомарно с height/client/top): префикс-догрузка истории растит
      // scrollHeight сверху, абсолютный scrollTop после неё указал бы в середину.
      // Якорь «прокрутка от низа» устойчив к дрейфу clientH при раннем hide (раскладка
      // ещё не устоялась): позиция «внизу» (0) восстанавливается ровно в 0.
      // -1 = скролла не было.
      var distBottom80 = -1;
      // v66/v67: сброс сводного состояния прогона (трекинг вовлечения скрытого скролла)
      D.loaderState.scrollEngaged = false;
      D.loaderState.hideApplied = false;
      D.loaderState.topReached = false;
      D.loaderState.startH = sc.height();
      D.loaderState.maxHSeen = D.loaderState.startH;
      D.loaderState.prevTopRead = -1;

      // v30.4: скрытие НЕ выставляем заранее — только по решению в цикле (__applyHide).
      // v80: DOM контейнера НЕ трогаем — непрозрачный оверлей на body (см. шапку v75/v80).
      function __applyHide() {
        if (hiddenEl || sc.mode !== 'el' || !sc.el) return;
        hiddenEl = true; // v75: маркер «оверлей применён» (скрытия DOM больше нет)
        // v80 (O1): атомарный захват позиции ДО первого скролла (прокрутка от низа вьюпорта)
        try { distBottom80 = Math.max(0, sc.height() - sc.client() - sc.top()); } catch (eD80) { distBottom80 = 0; }
        // v81 (O1 white-screen, вариант A): в этом холодном старте восстановлена лента
        // (tapeWasUsedInThisColdStart=true) — оверлей НЕ показываем: тейп уже отрисовал
        // полную историю, непрозрачный экран поверх ленты давал «белый экран».
        if (D.tapeWasUsedInThisColdStart === true) {
          debugLog('log', '[AI CM][visibility] overlay-suppressed reason=tape-present convId=' + (D.getConvId() || '(none)'));
        } else {
          D.aiCmSetScrollOverlay(true, 'loader');
          debugLog('log', '[AI CM][visibility] hide reason=loader-overlay h=' + (sc.height ? sc.height() : '?') + ' convId=' + (D.getConvId() || '(none)'));
        }
        // v66: hide-applied — доказательство вовлечения скрытого скролла
        D.loaderState.scrollEngaged = true;
        D.loaderState.hideApplied = true;
        // v30.8: сообщаем content.js — бейдж замораживается на время скрытой загрузки
        try { window.dispatchEvent(new CustomEvent('ai-cm-loader-freeze', { detail: { on: true } })); } catch (e2) { }
      }
      function __restoreLoader() {
        // v30.8: разморозка бейджа при любом выходе из лоадера (включая finally)
        try { window.dispatchEvent(new CustomEvent('ai-cm-loader-freeze', { detail: { on: false } })); } catch (eF) { }
        // v80 (O1): позиция сохраняется как «прокрутка от низа вьюпорта», захваченная в
        // __applyHide (перед первым скроллом). Для холодного открытия/F5/SPA-входа
        // (старт в низу) восстановление = ровно низ чата, независимо от дрейфа clientH;
        // если скролла не было — тоже низ (как в v79).
        var distBottomRest80 = (distBottom80 >= 0) ? distBottom80 : 0;
        function applyRestoreTop80() {
          try {
            var sn = (sc && sc.height() > 0) ? sc : D.findScrollContainer();
            if (sn && sn.height() > 0) sn.setTop(Math.max(0, sn.height() - sn.client() - distBottomRest80));
          } catch (eR80) { }
        }
        if (hiddenEl) {
          // v79/v80: возврат позиции ДО снятия оверлея — убирает «мгновение начала чата».
          applyRestoreTop80();
        }
        // v80 (O1-B): оверлей снимаем строго после ДВУХ rAF — кадр с восстановленной
        // позицией уже отрисован. seq-гвард: не снимаем оверлей более нового прогона.
        // Снимаем ВСЕГДА (не только при hiddenEl): оверлей мог быть pre-applied
        // (loader-restart) без hide — иначе протечка непрозрачного экрана.
        var seqAtEnd80 = D.aiCmOverlaySeq;
        var __overlayOff80 = function () {
          D.aiCmSetScrollOverlay(false, 'loader-done', seqAtEnd80);
          debugLog('log', '[AI CM][visibility] restore reason=loader-done convId=' + (D.getConvId() || '(none)'));
        };
        try {
          requestAnimationFrame(function () { requestAnimationFrame(__overlayOff80); });
        } catch (eRaf80) { __overlayOff80(); }
        if (sc.mode === 'el') { try { sc.el.style.scrollBehavior = prevSmooth; } catch (e) { } }
        // v30.4: возврат позиции на свеже-запрошенном скроллере; повтор через 250мс —
        // после пере-якорения списка Gemini. v80: к сохранённой позиции, не жёстко в низ.
        function kickBack() {
          applyRestoreTop80();
        }
        try {
          requestAnimationFrame(function () {
            setTimeout(function () { kickBack(); setTimeout(kickBack, 250); }, 250);
          });
        } catch (e) { kickBack(); }
      }

      try {
        var lastH = -1;
        var noGrowth = 0;
        var anyGrowth = false;
        var doneReason = 'max';
        var stallRetry = 0; // v52: ретраи скролла при неполном снимке
        var usedFallbackScroll = false; // v1.6 (D14): в прогоне был v78 fallback-real-scroll
        var notHiddenWait = 0; // v71: итераций ожидания hide (видимый скролл запрещён)
        var lastEpoch = -1;  // v53: последнее виденное поколение курсора
        var iter = 0;
        var maxScrollHSeen = sc.height(); // v1.14.2 (COLLAPSE-GUARD): пер-ран максимум scrollHeight — сброс в старте прогона
        // H9 (untrusted-top): снапшот поколения курсора на старте прогона. Если за время
        // прогона пришёл history-write с continuation-курсором (cursorEpoch вырос), значит
        // старшая история существует и есть (hadCursor=true). При floor=0 и no-growth такой
        // «вершок» на схлопнутом скроллере недостоверен (см. untrustedTopVerdict ниже).
        var cursorEpochAtRunStart = D.cursorEpoch;
        while (true) {
          iter++;
          // v53: любой history-write с continuation-курсором сбрасывает счётчики
          // стабилизации и столла — «новое поколение» курсора оживляет цикл.
          if (D.cursorEpoch !== lastEpoch) {
            lastEpoch = D.cursorEpoch;
            noGrowth = 0;
            stallRetry = 0;
            anyGrowth = false;
            lastH = -1;
            debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' cursor-epoch=' + lastEpoch + ' → счётчики сброшены (курсор жив) convId=' + convId);
          }
          // v30.7 / v52/v53: data-complete ТОЛЬКО при реальной полноте снимка (нет курсора
          // продолжения); при живом курсоре путь ЗАПРЕЩЁН (инвариант — только stall-retry).
          // v1.13.1: полнота подтверждена ТОЛЬКО при reachedStart=true — baseComplete от
          // тихой пагинации без начала (курсор пропал на скрытой вкладке) недостоверен.
          // v68: полнота — ТОЛЬКО по серверному курсору (старших страниц больше нет),
          // НЕ по DOM-скроллу: data-complete независимо от scrollEngaged/скрытого скроллера.
          if (D.historyFullByQuiet === true && D.reachedStart === true && !D.pendingCursor) {
            doneReason = 'data-complete';
            break;
          }
          // v30: SPA может заменить scroller между итерациями — старая ссылка мертва,
          // height() читается как 0. Перезапрашиваем элемент КАЖДУЮ итерацию; если
          // элемент null или scrollHeight=0 — итерация не засчитывается (lastH/noGrowth
          // не трогаем), ждём появления в рамках общего лимита итераций.
          var scNow = D.findScrollContainer();
          if (!scNow || !(scNow.height() > 0)) {
            debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' скроллер недоступен (null/scrollH=0) — ожидание в рамках лимита');
            await D.sleep(LOADER_STEP_MS);
            continue;
          }
          sc = scNow;
          // v1.14.2 (COLLAPSE-GUARD): per-run максимум scrollHeight (сброс — в старте
          // прогона, на каждой итерации max) — эталон высоты для детекта коллапса
          // скроллера: текущая высота стала значительно ниже виденного максимума.
          var __hCg0 = sc.height();
          if (__hCg0 > maxScrollHSeen) maxScrollHSeen = __hCg0;
          // v66/v67: трекинг вовлечения скрытого скролла (рост высоты / смена scrollTop)
          var __hNow0 = sc.height();
          if (__hNow0 > D.loaderState.maxHSeen) {
            D.loaderState.maxHSeen = __hNow0;
            if (!D.loaderState.scrollEngaged && (D.loaderState.maxHSeen - D.loaderState.startH) >= MIN_SCROLL_H_FOR_ENGAGEMENT) {
              D.loaderState.scrollEngaged = true;
            }
          }
          var __tNow66 = sc.top();
          if (!D.loaderState.scrollEngaged && (__tNow66 > 8 || (D.loaderState.prevTopRead !== -1 && __tNow66 !== D.loaderState.prevTopRead))) {
            D.loaderState.scrollEngaged = true; // были не у верха / scrollTop сдвинулся — скроллер реально прокручивается
          }
          D.loaderState.prevTopRead = __tNow66;
          // v30.7: скрытие ТОЛЬКО при h>8000 (длинный чат); короткие не прячем и не прыгаем
          // v45: И msgs>=LOADER_HIDE_MIN_MSGS — «короткие, но высокие» чаты (f47e2edd h=11893,
          // мало ходов) не прячем → нет белого мгновения при быстрой загрузке.
          // v1.6 (D16): bootstrap короткого контейнера — при старшей истории (olderHistorySeen)
          // + оракул incomplete + начало не достигнуто (reachedStart=false) скрываем/скроллим
          // НЕЗАВИСИМО от порога 8000 (оверлей уже маскирует UI). Без этого hide не включается
          // при scrollH=1140 → not-hidden-wait-cap → база неполная (80), старший сегмент остаётся
          // на сервере, oracle=incomplete, deferred as-is [LOW CONFIDENCE]_. Порог 8000 остаётся
          // для коротких чатов БЕЗ признаков старшей истории (все ходы в экране — лоадер не нужен).
          var __hNow = sc.height();
          var __msgsNow = D.baseSize(); // тот же источник, что кормит badge/history-write
          // v1.6 (D16): hide-bootstrap — чистая функция; короткий контейнер (h<=8000) скрываем
          // при старшей истории + oracle incomplete + начало не достигнуто (см. shouldHideScroller).
          var hideVerdict = { hide: false, bootstrapShort: false };
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
              typeof window.GeminiInterceptLogic.shouldHideScroller === 'function') {
            hideVerdict = window.GeminiInterceptLogic.shouldHideScroller({
              scrollH: __hNow,
              minHideH: LOADER_HIDE_MIN_H,
              olderHistorySeen: !!D.olderHistorySeen,
              reachedStart: D.reachedStart === true,
              oracleIncomplete: !!D.oracleIncompleteSeen[convId]
            });
          } else {
            hideVerdict = { hide: __hNow > LOADER_HIDE_MIN_H, bootstrapShort: false };
          }
          if (!hiddenEl && hideVerdict.hide) {
            // v1.16 (1177-BYPASS): лоадер по эскалации (nativeEscalationFor===convId) скрывает
            // и скроллит ДАЖЕ при msgs < LOADER_HIDE_MIN_MSGS — это обход 1177, тихий цикл
            // уже не может продолжать, и старшие окна доберёт только нативный скролл сайта.
            var escRun116 = !!(convId && D.nativeEscalationFor === convId);
            // v1.16 (OLDER-UNSTARTED): «короткая по числу ходов, но высокая» история (msgs<порог,
            // scrollH>8000) с подтверждённой старшей историей и недостигнутым началом — скрываем
            // и скроллим тоже (иначе not-hidden-wait-cap ~60с пустого ожидания, см. de4b9f5f:
            // 22 хода, h=26384, quiet-clean-end, hide-skipped few-msgs навсегда).
            var olderUnstarted116 = !!(hideVerdict.hide && D.olderHistorySeen === true && D.reachedStart !== true);
            if (__msgsNow >= LOADER_HIDE_MIN_MSGS || hideVerdict.bootstrapShort || escRun116 || olderUnstarted116) {
              __applyHide();
              debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' hide-applied h=' + __hNow + ' msgs=' + __msgsNow +
                (hideVerdict.bootstrapShort ? ' reason=bootstrap-short' : (escRun116 ? ' reason=1177-bypass' : (olderUnstarted116 ? ' reason=older-unstarted' : ''))));
            } else {
              debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' hide-skipped reason=few-msgs h=' + __hNow + ' msgs=' + __msgsNow);
            }
          }
          // v71: скролл (setTop(0) + синтетический scroll) выполняем ТОЛЬКО если контейнер
          // скрыт (hiddenEl). Видимый скролл вверх — источник дёргания/беления чата при
          // холодном открытии (hide-skipped reason=few-msgs h=14938 msgs=20): ждём, пока
          // база доберёт LOADER_HIDE_MIN_MSGS и hide применится; кап ожидания — LOADER_MAX_ITER.
          if (!hiddenEl) {
            notHiddenWait++;
            // v1.16 (CLEAN-END-UNSCROLLABLE): hide так и не применился (msgs<порога при
            // коротком контейнере, скролл видимым запрещён), но тихая пагинация завершилась
            // ЧИСТО (quietEndedClean: серверный курсор исчерпан без ошибок-страниц) и база не
            // ниже пола — догонять нечего, окно не вырастет. Завершаем прогон сразу, чтобы
            // оракул clean-end-stable подтвердил полноту на стопе, а не крутить LOADER_MAX_ITER
            // итераций «visible-scroll-skipped» (~60с пустого ожидания + [LOW CONFIDENCE]_).
            // Инвариант 3в: ТОЛЬКО при floor>0 (класс первого визита floor=0 НЕ подтверждается —
            // ранний стоп без физического верха был бы ложной полнотой на первом визите).
            var __nhClean = false;
            var __floorNh = 0;
            try {
              try { __floorNh = (D.loadFloor(convId) || {}).count || 0; } catch (eNhF) { swallowSoft(eNhF, 'gemini:loader-clean-end-floor-read'); }
              var __qcNh = (typeof D.quietEndedClean === 'undefined') ? false : (D.quietEndedClean === true);
              var __pcNh = (typeof D.pendingCursor === 'undefined') ? null : D.pendingCursor;
              __nhClean = __qcNh && !__pcNh && !D.reachedStart && __floorNh > 0 && D.baseSize() > 0 && D.baseSize() >= __floorNh;
            } catch (eNh) { __nhClean = false; }
            if (__nhClean) {
              doneReason = 'clean-end-unscrollable'; // ≠ 'top' → стабильный стоп подтвердит clean-end-stable
              debugLog('log', '[AI CM][Gemini][loader] early-stop reason=clean-end-unscrollable convId=' + convId +
                ' msgs=' + D.baseSize() + ' floor=' + __floorNh + ' wait=' + notHiddenWait + '/' + LOADER_MAX_ITER);
              break;
            }
            if (notHiddenWait >= LOADER_MAX_ITER) {
              doneReason = 'not-hidden-wait-cap';
              break;
            }
            debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' visible-scroll-skipped reason=not-hidden' +
              ' h=' + __hNow + ' msgs=' + __msgsNow + ' wait=' + notHiddenWait + '/' + LOADER_MAX_ITER + ' convId=' + convId);
            await D.sleep(LOADER_STEP_MS);
            continue;
          }
          // v75: программный скролл БЕЗ изменения CSS-видимости: в одном кадре (rAF)
          // scrollTop=0 → синтетический scroll → мгновенный возврат вниз. Пользователь
          // скачка не видит (промежуточное состояние не отрисовывается), DOM-видимость
          // контейнера не трогается — виртуализация Gemini продолжает рендерить.
          // v78: rAF-возврат в том же кадре НЕ триггерил пагинацию Gemini → лоадер доходил
          // до max, не собрав историю. Теперь rAF-режим ТОЛЬКО когда база уже полная;
          // иначе — страховочный реальный скрытый скролл (v80: БЕЗ opacity на скроллере,
          // экран закрыт непрозрачным overlay): scrollTop=0 + dispatch('scroll') + пауза —
          // старшие окна реально рендерятся, пагинация Gemini срабатывает.
          if (D.historyFullByQuiet === true) {
            (function (el75) {
              try {
                requestAnimationFrame(function () {
                  try { el75.scrollTop = 0; } catch (eS1) { }
                  // v4z: синтетический scroll — подталкиваем IntersectionObserver-пагинацию
                  try { el75.dispatchEvent(new Event('scroll')); } catch (eS2) { }
                  try { el75.scrollTop = el75.scrollHeight; } catch (eS3) { } // возврат вниз ДО отрисовки кадра
                });
              } catch (eRaf) { }
            })(sc.el);
            await D.sleep(SCROLL_PAUSE_HIDDEN_MS);
          } else {
            // v78→v80: страховочный лоадер (фолбэк после loader-restart / неполная база):
            // реальный скрытый скролл к верху. v80 (O1-A): САМ СКРОЛЛЕР НЕ СКРЫВАЕМ
            // (opacity/pointerEvents удалены — они и давали чисто-белый экран и «начало
            // чата» на unhide); экран закрыт непрозрачным overlay на body, виртуализация
            // списка продолжает рендерить старшие окна.
            usedFallbackScroll = true; // v1.6 (D14): прогон использовал страховочный скролл
            // v80: оверлей мог быть снят force-restore (visibilitychange/conv-switch) —
            // возвращаем, пока страховочный скролл активен. v81 (O1 white-screen A):
            // при восстановленной ленте оверлей НЕ поднимаем (тейп уже виден).
            if (D.tapeWasUsedInThisColdStart === true) {
              if (!D.aiCmScrollOverlay) {
                debugLog('log', '[AI CM][visibility] overlay-suppressed reason=tape-present convId=' + (D.getConvId() || '(none)'));
              }
            } else if (!D.aiCmScrollOverlay) {
              D.aiCmSetScrollOverlay(true, 'loader-fallback');
            }
            debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' fallback-real-scroll (база неполная, rAF-возврат не триггерит пагинацию) convId=' + convId);
            try { sc.setTop(0); } catch (eSt1) { }
            try { sc.el.dispatchEvent(new Event('scroll')); } catch (eSt2) { }
            await D.sleep(SCROLL_PAUSE_HIDDEN_MS);
          }
          var h = sc.height();
          if (!(h > 0)) continue; // v30.7: нулевое чтение не засчитываем
          debugLog('log', '[AI CM][Gemini][loader] iter ' + iter + ' h=' + h +
            ' scrollEngaged=' + (D.loaderState.scrollEngaged ? '1' : '0') +
            ' hide=' + (D.loaderState.hideApplied ? 'applied' : 'not-applied') +
            ' latch=' + (D.loaderDoneMap[convId] ? 'done' : 'reset') + (D.loaderRetryUsedMap[convId] ? '-retry-used' : ''));
          if (lastH !== -1 && !(h > lastH + LOADER_RESUME_DELTA)) {
            noGrowth++;
            if (noGrowth >= LOADER_STABLE_NEED) {
              // v4z: контрольный перемер через 2с — две no-growth могли попасть в летящий запрос
              await D.sleep(LOADER_RECHECK_MS);
              // v53: за время перемера мог прийти новый history-write с курсором — сброс счётчиков
              if (D.cursorEpoch !== lastEpoch) {
                lastEpoch = D.cursorEpoch;
                noGrowth = 0;
                stallRetry = 0;
                anyGrowth = false;
                lastH = -1;
                await D.sleep(LOADER_STEP_MS);
                continue;
              }
              // v1.13.1: требуем reachedStart=true — baseComplete без подтверждённого
              // начала (тихая пагинация оборвалась на скрытой вкладке) недостоверен.
              // v68: полнота — ТОЛЬКО по серверному курсору, не по DOM-скроллу
              if (D.historyFullByQuiet === true && D.reachedStart === true && !D.pendingCursor) {
                doneReason = 'data-complete';
                break;
              }
              var hc = sc.height();
              if (hc > lastH + LOADER_RESUME_DELTA) {
                debugLog('log', '[AI CM][Gemini][loader] reason=resume h=' + lastH + '→' + hc);
                noGrowth = 0;
                lastH = hc;
                anyGrowth = true;
                continue;
              }
              // v53: ИНВАРИАНТ — пока в последнем history-ответе есть continuation-курсор,
              // ЗАПРЕЩЕНО завершаться по stable / no-growth / data-complete. Только stall-retry
              // (скролл к верху, шаг ~1с) до LOADER_STALL_CAP; исчерпание капа → done reason=timeout.
              if (D.pendingCursor) {
                stallRetry++;
                if (stallRetry < LOADER_STALL_CAP) {
                  debugLog('log', '[AI CM][Gemini][loader] stall-retry ' + stallRetry + '/' + LOADER_STALL_CAP +
                    ' (курсор жив — продолжаю скроллить) convId=' + convId +
                    ' pendingCursor=1 baseComplete=' + (D.historyFullByQuiet === true ? '1' : '0'));
                  noGrowth = 0;
                  await D.sleep(LOADER_STEP_MS);
                  continue;
                }
                doneReason = 'timeout';
                break;
              }
              // v65: «железное условие» физического верха. Стабильность высоты среди
              // истории (height-stable + pendingCursor=0) НЕ признак конца: старшие окна
              // истории могли ещё не отрендериться. Остановка раньше max-iter допустима
              // ТОЛЬКО при topReached (scrollTop <= 8px). Пока не наверху — продолжаем
              // скролл и сбрасываем счётчики no-growth.
              // v66: topReached доверяем ТОЛЬКО при scrollEngaged — на невовлечённом
              // скроллере scrollTop=0 тривиален (ложный «верх» на холодном старте).
              D.loaderState.topReached = D.loaderState.scrollEngaged && sc.top() <= 8;
              if (!D.loaderState.topReached) {
                debugLog('log', '[AI CM][Gemini][loader] v65 top-not-reached scrollTop=' + sc.top() +
                  ' (height-stable среди истории — не конец, продолжаю скролл) convId=' + convId);
                noGrowth = 0;
                lastH = -1;
                anyGrowth = false;
                await D.sleep(LOADER_STEP_MS);
                continue;
              }
              // v1.14.2 (COLLAPSE-GUARD): collapse ≠ top. Если Gemini схлопнул скроллер
              // во время скрытого прогона (03.09 11:35: 100933→744), scrollTop≤8px
              // тривиален — физического верха НЕТ. doneReason='top' присваиваем только
              // когда высота не коллапсировала: h < max(3000, 0.5*maxScrollHSeen)
              // при базе ниже сохранённого пола → doneReason='collapse' + перезапуск.
              var __floorCg = 0;
              try { __floorCg = (D.loadFloor(convId) || {}).count || 0; } catch (eCg0) { swallowSoft(eCg0, 'gemini:loader-collapse-guard-floor-read'); }
              var __cvCollapsed = false;
              if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                  typeof window.GeminiInterceptLogic.collapseGuardVerdict === 'function') {
                __cvCollapsed = window.GeminiInterceptLogic.collapseGuardVerdict({
                  scrollH: sc.height(),
                  maxScrollHSeen: maxScrollHSeen,
                  baseCount: D.baseSize(),
                  floorCount: __floorCg
                }).collapsed;
              } else {
                __cvCollapsed = (sc.height() < Math.max(3000, maxScrollHSeen * 0.5) && D.baseSize() < __floorCg);
              }
              if (__cvCollapsed) {
                // v1.15 (BUG «холодное открытие без полной истории»): если тихая пагинация
                // ЗАВЕРШИЛАСЬ ЧИСТО (сеть: «старших страниц больше нет», ошибки не было),
                // а скроллер схлопнут на физическом верхе — это НЕ «collapsed, ждём больше»,
                // а устаревший пол (чат ужат/укорочен на сервере с прошлой полной сборки).
                // Крутить collapse-ретраи против пола бессмысленно: окно не вырастет. Один
                // подтверждающий повтор (8с, вдруг подъедет поздний нативный fetch) — и если
                // база не выросла, подтверждаем верх как done reason=top и переписываем пол.
                // typeof-защита: collapse-guard runTopPoint исполняет фрагмент в песочнице
                // без модульных глобалов v1.15 (quietEndedClean/pendingCursor/quietActive/...).
                var __cleanEndCg = false;
                try {
                  if (typeof D.quietEndedClean !== 'undefined' && D.quietEndedClean === true) {
                    var __pcCg = (typeof D.pendingCursor === 'undefined') ? null : D.pendingCursor;
                    var __cqCg = (typeof D.quietActive === 'undefined') ? false : !!D.quietActive;
                    var __heCg = (typeof D.lastHnvPageError === 'undefined') ? false : !!D.lastHnvPageError;
                    // v1.16: чистое завершение сети само по себе не лечит «устаревший пол» на
                    // первом визите (floor=0): самоизлечение пола осмысленно только когда есть
                    // пол от прошлой полной сборки (инвариант 3в, класс первого визита).
                    var __floorOkCg = (typeof __floorCg === 'number' && __floorCg > 0);
                    if (!__pcCg && !__cqCg && !__heCg && __floorOkCg && D.baseSize() > 0) __cleanEndCg = true;
                  }
                } catch (eCgClean) { __cleanEndCg = false; }
                if (__cleanEndCg && D.collapseRetries >= 1 &&
                    typeof D.lastCleanEndBaseCount !== 'undefined' && D.baseSize() === D.lastCleanEndBaseCount) {
                  try {
                    if (__floorCg > D.baseSize() && convId && typeof D.parserVersion !== 'undefined' && D.parserVersion &&
                        typeof localStorage !== 'undefined' && typeof D.lastBaseTextLen !== 'undefined') {
                      // v1.16.5 (T1-fix#5): понижение пола идёт ТОЛЬКО через формальный механизм
                      // самоунижения (вердикт selfHealFloorVerdict + единственная точка записи
                      // selfHealFloor → writeSelfHealedFloor). Прямого localStorage.setItem пола
                      // здесь больше нет: подтверждающий повтор уже состоялся (collapseRetries>=1
                      // + база не изменилась), поэтому confirmations=1.
                      // typeof-защита: runTopPoint исполняет фрагмент в песочнице без модульных
                      // глобалов (selfHealFloor там не объявлен).
                      if (typeof D.selfHealFloor === 'function') {
                        var __shvCg = null;
                        try {
                          if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                              typeof window.GeminiInterceptLogic.selfHealFloorVerdict === 'function') {
                            __shvCg = window.GeminiInterceptLogic.selfHealFloorVerdict({
                              cleanEnd: true,
                              pendingCursor: (typeof __pcCg === 'undefined') ? null : __pcCg,
                              quietActive: (typeof __cqCg === 'undefined') ? false : __cqCg,
                              pageError: (typeof __heCg === 'undefined') ? false : __heCg,
                              loaderRunning: (typeof D.loaderRunningFor === 'undefined') ? false : !!D.loaderRunningFor,
                              archivePending: !!(typeof D.aiCmArchiveFor === 'function' && D.aiCmArchiveFor(convId) &&
                                typeof D.aiCmArchiveLiveProven === 'function' && !D.aiCmArchiveLiveProven(convId)),
                              baseCount: D.baseSize(),
                              floorCount: __floorCg,
                              floorLen: (D.loadFloor(convId) || {}).effectiveLen || 0,
                              provenLen: D.lastBaseTextLen,
                              reachedStart: D.reachedStart === true,
                              confirmations: 1
                            });
                          }
                        } catch (eShvCg) { __shvCg = null; }
                        if (__shvCg && __shvCg.lower === true) {
                          D.selfHealFloor(convId, __shvCg.count, __shvCg.effectiveLen, __shvCg.source);
                        }
                      }
                    }
                  } catch (eCgF) { swallowSoft(eCgF, 'gemini:loader-floor-self-heal'); }
                  debugLog('log', '[AI CM][Gemini][loader] clean-end top confirmed (устаревший пол самоизлечен) convId=' + convId +
                    ' msgs=' + D.baseSize() + ' floorWas=' + __floorCg + ' scrollH=' + sc.height() +
                    ' selfHeal=' + ((__shvCg && __shvCg.source) || 'skipped'));
                  doneReason = 'top'; // v1.15: чистый конец сети + физический верх → stable-stop оракул
                  break;
                }
                if (__cleanEndCg && D.collapseRetries === 0) {
                  if (typeof D.lastCleanEndBaseCount !== 'undefined') D.lastCleanEndBaseCount = D.baseSize();
                  debugLog('log', '[AI CM][Gemini][loader] clean-end collapse candidate convId=' + convId +
                    ' msgs=' + D.baseSize() + ' floor=' + __floorCg + ' — подтверждающий повтор через 8с');
                }
                doneReason = 'collapse'; // v1.14.2: НЕ 'top' — stable-stop оракул и fallback-top остаются закрытыми
                if (D.collapseRetries < 2) {
                  D.collapseRetries++;
                  debugLog('log', '[AI CM][Gemini][loader] collapse-guard: скроллер схлопнут scrollH=' + sc.height() +
                    ' maxSeen=' + maxScrollHSeen + ' msgs=' + D.baseSize() + ' floor=' + __floorCg +
                    ' — перезапуск лоадера через 8с retry=' + D.collapseRetries + '/2 convId=' + convId);
                  var __convIdAtCollapse = convId;
                  setTimeout(function () {
                    try {
                      if (D.getConvId() !== __convIdAtCollapse) return; // смена чата — ретрай не нужен
                      D.loaderDoneMap[__convIdAtCollapse] = false; // снятие латча — разрешаем перезапуск
                      maybeStartLoader();
                    } catch (eCg1) { swallowSoft(eCg1, 'gemini:loader-collapse-retry'); }
                  }, 8000);
                } else {
                  if (__cleanEndCg && typeof D.lastCleanEndBaseCount !== 'undefined' && D.baseSize() === D.lastCleanEndBaseCount) {
                    try {
                      if (__floorCg > D.baseSize() && convId && typeof D.parserVersion !== 'undefined' && D.parserVersion &&
                          typeof localStorage !== 'undefined' && typeof D.lastBaseTextLen !== 'undefined') {
                        debugLog('log', '[AI CM][Gemini][loader] clean-end floor-write via saveFloor (H11) convId=' + convId + ' proposed=' + D.baseSize() + ' floorWas=' + __floorCg);
                        D.saveFloor(convId, D.baseSize(), D.lastBaseTextLen);
                      }
                    } catch (eCgF2) { swallowSoft(eCgF2, 'gemini:loader-h11-floor-write'); }
                    debugLog('log', '[AI CM][Gemini][loader] clean-end top confirmed (exhausted retries) convId=' + convId +
                      ' msgs=' + D.baseSize() + ' floorWas=' + __floorCg);
                    doneReason = 'top';
                  } else {
                    debugLog('log', '[AI CM][Gemini][loader] collapse-guard: ретраи исчерпаны 2/2 — incomplete as-is convId=' + convId);
                  }
                }
                break;
              }
              // H9 (untrusted-top): первый визит floor=0 — collapse-guard при floor=0 молчит
              // (baseCount < 0 никогда), но тихая пагинация оборвалась и курсор в истории был
              // (hadCursor), а скроллер за прогон НЕ вырос (no-growth, схлопнутая высота).
              // Такой doneReason='top' ложный (физического верха нет). → 'collapse' тем же
              // ретрай-путём (≤2), иначе incomplete as-is (stable-stop/fallback-top закрыты).
              // typeof-защита: collapse-guard runTopPoint исполняет этот фрагмент в песочнице
              // без модульных глобалов (serverFirstHash/olderHistorySeen/cursorEpoch).
              var __hadCursorH9 = false;
              try {
                __hadCursorH9 = !!((typeof D.serverFirstHash !== 'undefined' && D.serverFirstHash) ||
                  (typeof D.olderHistorySeen !== 'undefined' && D.olderHistorySeen) ||
                  (typeof D.cursorEpoch !== 'undefined' && typeof cursorEpochAtRunStart !== 'undefined' &&
                   D.cursorEpoch !== cursorEpochAtRunStart));
              } catch (eH90) { __hadCursorH9 = false; }
              var __anyGrowthH9 = false;
              try { __anyGrowthH9 = (typeof anyGrowth !== 'undefined') ? !!anyGrowth : false; } catch (eH9g) { __anyGrowthH9 = false; }
              var __untTop = null;
              if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                  typeof window.GeminiInterceptLogic.untrustedTopVerdict === 'function') {
                __untTop = window.GeminiInterceptLogic.untrustedTopVerdict({
                  floorCount: __floorCg,
                  hadCursor: __hadCursorH9,
                  anyGrowth: __anyGrowthH9,
                  maxScrollHSeen: maxScrollHSeen,
                  viewportH: (typeof sc !== 'undefined' && sc && typeof sc.client === 'function') ? sc.client() : 0
                });
              }
              if (__untTop && __untTop.untrusted === true) {
                doneReason = 'collapse'; // H9: НЕ 'top'
                if (D.collapseRetries < 2) {
                  D.collapseRetries++;
                  debugLog('log', '[AI CM][Gemini][loader] untrusted-top ' + (__untTop.reason || '') +
                    ' scrollH=' + (sc && sc.height ? sc.height() : '?') + ' maxSeen=' + maxScrollHSeen + ' msgs=' + D.baseSize() +
                    ' floor=' + __floorCg + ' hadCursor=' + (__hadCursorH9 ? '1' : '0') +
                    ' — перезапуск лоадера через 8с retry=' + D.collapseRetries + '/2 convId=' + convId);
                  var __convIdAtUntrust = convId;
                  setTimeout(function () {
                    try {
                      if (D.getConvId() !== __convIdAtUntrust) return; // смена чата — ретрай не нужен
                      D.loaderDoneMap[__convIdAtUntrust] = false; // снятие латча — разрешаем перезапуск
                      maybeStartLoader();
                    } catch (eH91) { swallowSoft(eH91, 'gemini:loader-untrusted-top-retry'); }
                  }, 8000);
                } else {
                  debugLog('log', '[AI CM][Gemini][loader] untrusted-top: ретраи исчерпаны 2/2 — incomplete as-is convId=' + convId);
                }
                break;
              }
              doneReason = 'top'; // v78: физический верх подтверждён (topReached+scrollEngaged) — единственный done-reason, который взводит stable-stop оракул
              break;
            }
          } else {
            noGrowth = 0;
            if (lastH !== -1) anyGrowth = true;
          }
          lastH = h;
          // v53: лимит итераций НЕ прерывает активный курсор-скролл на холодном старте —
          // иначе лоадер стопнулся бы раньше, чем сервер отдал полный снапшот.
          if (iter >= LOADER_MAX_ITER && !D.pendingCursor) {
            doneReason = 'max';
            break;
          }
        }
        // v68: полнота определяется ТОЛЬКО серверной пагинацией (paginateLoop по курсору);
        // DOM-скролл больше НЕ взводит и НЕ сбрасывает baseComplete/reachedStart.
        D.lastLoaderDoneReason = doneReason; // v78: гейт stable-stop оракула
        // v1.6 (D14): SPA-вход в известный чат — страховочный v78-скролл дошёл до верха
        // (topReached при empty*3). Выставляем состояния, которые stableCheck74 ждёт от
        // main-loader done reason=top: reachedStart=true; historyFullByQuiet=true при
        // base>=floor; диспатч ai-cm-loader-state с baseComplete=true — deferred-экспорт
        // (content.js) не висит бесконечно, латч автоэкспорта стреляет один раз.
        // v1.6 (D15): гейт — baseComplete через fallback-top ТОЛЬКО при pendingCursor==null
        // И лоадер не в итерациях (loaderRunningFor===null) И база стабильна ≥5с.
        // Иначе ждём: повторная проверка через 5с. fired не может произойти, пока
        // лоадер продолжает итерации (вторая проходка догружает историю до 124).
        if (doneReason === 'top' && usedFallbackScroll) { // v1.14.2: 'collapse' сюда не попадает — fallback-top объявляет полноту только при настоящем верхе
          function applyFallbackComplete() {
            try {
              var baseNowD14 = D.baseSize();
              var floorD14b = D.loadFloor(convId);
              var floorCountD14b = (floorD14b && floorD14b.count) || 0;
              // v1.6 (D15-C): гейт below-floor применяется и к done=top фолбэка —
              // base < сохранённого пола НЕ даёт loader-stable-stop (ложный верх).
              if (baseNowD14 < floorCountD14b) {
                debugLog('log', '[AI CM][completeness] fallback-top skip reason=below-floor convId=' + convId +
                  ' msgs=' + baseNowD14 + ' floor=' + floorCountD14b);
                return;
              }
              // v1.14.1 (FB-PROBE): base>=floor — круговая проверка (floor мог быть сохранён
              // из такой же ложной полноты), поэтому fallback-top объявляет полноту ТОЛЬКО
              // после серверного подтверждения (v73-probe: 0 новых старших ходов, курсор
              // исчерпан). Без метаданных сети/курсора полнота НЕ объявляется — экспорт
              // не стреляет по усечённой базе; состояние бейджа не трогаем (v78-пол
              // по-прежнему защищает от просадки).
              var fbHash = '';
              try { fbHash = D.aiCmDiagTurnEdge(D.aiCmOrderedTurns(), 'first').hash; } catch (eFbH) { swallowSoft(eFbH, 'gemini:loader-fallback-probe-hash'); }
              var fbWideCur = null;
              try { fbWideCur = D.extractCursorWide(D.lastPaginateOuter); } catch (eFbC) { swallowSoft(eFbC, 'gemini:loader-fallback-wide-cursor'); }
              // H9b (retain-last-good): живой wide-курсор пуст (оборванный шаг перезаписал
              // lastPaginateOuter) → retained last-good того же convId (вход probe, не complete).
              if (!fbWideCur && D.lastGoodWideCur && D.lastGoodWideCur.conv &&
                  D.lastGoodWideCur.conv === (D.getConvId() || '')) {
                fbWideCur = D.lastGoodWideCur.cur;
                debugLog('log', '[AI CM][completeness] retained-wide-cur fed reason=fallback-top' +
                  ' convId=' + (D.getConvId() || '(none)') + ' msgs=' + baseNowD14);
              }
              var fbMeta = { atEncoded: D.lastAtEncoded, baseUrl: D.lastBaseUrl, headers: D.lastHeaders };
              // H9b: живой слот метаданных пуст — добираем из retained (same-convId); гарды
              // isStaleReqTag по ответу probe остаются — чужой conv ответ не примет.
              if ((!fbMeta.atEncoded || !fbMeta.baseUrl || !fbMeta.headers) &&
                  D.lastGoodProbeMeta && D.lastGoodProbeMeta.conv &&
                  D.lastGoodProbeMeta.conv === (D.getConvId() || '')) {
                if (!fbMeta.atEncoded) fbMeta.atEncoded = D.lastGoodProbeMeta.atEncoded;
                if (!fbMeta.baseUrl) fbMeta.baseUrl = D.lastGoodProbeMeta.baseUrl;
                if (!fbMeta.headers) fbMeta.headers = D.lastGoodProbeMeta.headers;
                debugLog('log', '[AI CM][completeness] retained-meta fed reason=fallback-top' +
                  ' convId=' + (D.getConvId() || '(none)') + ' msgs=' + baseNowD14);
              }
              var fbProbeReady = true;
              if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.fallbackProbeReady) {
                fbProbeReady = window.GeminiInterceptLogic.fallbackProbeReady(fbMeta, fbWideCur);
              } else {
                fbProbeReady = Boolean(fbMeta.atEncoded && fbMeta.baseUrl && fbMeta.headers && fbWideCur);
              }
              if (!fbProbeReady) {
                debugLog('log', '[AI CM][completeness] fallback-top wait reason=probe-unavailable' +
                  ' meta=' + ((D.lastAtEncoded && D.lastBaseUrl && D.lastHeaders) ? 'yes' : 'no') +
                  ' wideCursor=' + (fbWideCur ? 'yes' : 'no') +
                  ' convId=' + convId + ' msgs=' + baseNowD14 + ' floor=' + floorCountD14b);
                return;
              }
              debugLog('log', '[AI CM][completeness] fallback-top probe-start' +
                ' convId=' + convId + ' msgs=' + baseNowD14 + ' floor=' + floorCountD14b);
              D.runCompletenessProbe(fbHash, fbWideCur, { onTerminal: function () {
                try { delete D.oracleIncompleteSeen[convId]; } catch (eFbO) { }
                try {
                  window.dispatchEvent(new CustomEvent('ai-cm-loader-state', { detail: {
                    convId: convId,
                    running: false,
                    pendingCursor: false,
                    baseComplete: true,
                    reachedStart: true
                  } }));
                } catch (eFbD) { }
              } });
            } catch (eD14x) { swallowSoft(eD14x, 'gemini:loader-fallback-complete'); }
          }
          function fallbackStableNow() {
            var nowD15 = Date.now();
            if (D.pendingCursor) return false; // живой pag-курсор — история ещё не вся
            if (D.loaderRunningFor) return false; // активный прогон лоадера — не в итерациях нельзя судить
            if (D.lastBaseCountChangeAt && (nowD15 - D.lastBaseCountChangeAt) < 5000) return false; // база менялась <5с
            if (D.lastOlderNonPagAddAt && (nowD15 - D.lastOlderNonPagAddAt) < 5000) return false;
            return true;
          }
          try {
            if (fallbackStableNow()) {
              applyFallbackComplete();
            } else {
              debugLog('log', '[AI CM][completeness] fallback-top wait reason=' +
                (D.pendingCursor ? 'pending-cursor' : (D.loaderRunningFor ? 'loader-running' : 'base-unstable')) +
                ' convId=' + convId + ' msgs=' + D.baseSize());
              setTimeout(function () {
                try {
                  if (D.getConvId() !== convId) return;
                  if (!fallbackStableNow()) return; // всё ещё ждём — stableCheck74/повторы решат
                  applyFallbackComplete();
                } catch (eD15t) { swallowSoft(eD15t, 'gemini:loader-fallback-retry'); }
              }, 5000);
            }
          } catch (eD14y) { swallowSoft(eD14y, 'gemini:loader-fallback-schedule'); }
        }
        debugLog('log', '[AI CM][Gemini][loader] done reason=' + doneReason +
          ' scrollH=' + sc.height() + ' convId=' + convId +
          ' baseComplete=' + (D.historyFullByQuiet === true ? '1' : '0') +
          ' pendingCursor=' + (D.pendingCursor ? '1' : '0') +
          ' msgs=' + D.baseSize() +
          ' scrollEngaged=' + (D.loaderState.scrollEngaged ? '1' : '0') +
          ' latch=' + (D.loaderDoneMap[D.getConvId() || convId] ? 'done' : 'reset') +
          (D.loaderRetryUsedMap[D.getConvId() || convId] ? '-retry-used' : ''));
      } finally {
        __restoreLoader();
      }
    } catch (e) {
      debugLog('error', '[AI CM][Gemini][loader] ошибка лоадера:', e);
    }
  }

  // ---------- D: LOADER_SIGNAL_WAIT_* + maybeStartLoader ----------
  // Точка автозапуска: каждое открытие чата (холодный F5 и SPA-переход на /app/<id>),
  // после появления скроллера. Один раз на convId за сессию; холодное открытие
  // (флага в loaderDoneMap нет) — всегда.
  // v30.6: единственные читаемые флаги полноты — cacheRestoredMap[convId] (принята кэш-лента)
  // и historyFullByQuiet (сеть дала полную историю): при них лоадер пропускается целиком.
  // v46: ожидание сигнала «старшая история» до решения о старте.
  var LOADER_SIGNAL_WAIT_TRIES = 20; // v46: до 20 попыток по 1с — дождаться первого history-RPC
  var LOADER_SIGNAL_WAIT_MS = 1000;
  function maybeStartLoader() {
    var tries = 0;
    function tick() {
      var convId = D.getConvId();
      if (!convId) {
        if (++tries < 10) { setTimeout(tick, 1000); }
        return;
      }
      if (D.loaderDoneMap[convId]) {
        debugLog('log', '[AI CM][Gemini][loader] skip reason=already-done convId=' + convId +
          (D.loaderRetryUsedMap[convId] ? ' retry-used=1' : ' retry-used=0')); // v66: состояние латча
        return;
      }
      // v1.14.2 (COLLAPSE-GUARD): база добрала сохранённый пол — бюджет коллапс-ретраев больше не нужен
      var __floorMs = 0;
      try { __floorMs = (D.loadFloor(convId) || {}).count || 0; } catch (eCg2) { swallowSoft(eCg2, 'gemini:maybeStartLoader-collapse-budget'); }
      if (D.baseSize() >= __floorMs) D.collapseRetries = 0;
      // v30.6: история уже полная — лоадер не нужен (иначе прячет скроллер на 8–10с).
      // v1.6 (D15): при oracle=incomplete (восстановленная лента + неполная сеть) обходим
      // cache-complete РОВНО ОДИН раз на вход — страховочный v78-скролл доведёт базу до
      // done=top+base>=floor → baseComplete=true (D14-fallback) → авто-fired без [LOW CONFIDENCE]_.
      if (D.cacheRestoredMap.has(convId)) {
        var bypassD15 = false;
        if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
            typeof window.GeminiInterceptLogic.shouldBypassCacheComplete === 'function') {
          bypassD15 = window.GeminiInterceptLogic.shouldBypassCacheComplete(D.oracleIncompleteSeen, D.oracleRerunUsedMap, convId);
        }
        if (bypassD15) {
          try { delete D.oracleIncompleteSeen[convId]; } catch (eB1) { } // флаг снят — повторных обходов нет
          try { D.oracleRerunUsedMap[convId] = true; } catch (eB2) { }   // маркер «один ре-ран использован»
          debugLog('log', '[AI CM][Gemini][loader] cache-complete bypass reason=oracle-incomplete convId=' + convId);
          // продолжаем к запуску лоадера ниже (не return)
        } else {
          D.loaderDoneMap[convId] = true;
          debugLog('log', '[AI CM][Gemini][loader] skip reason=cache-complete convId=' + convId);
          return;
        }
      }
      // v52: skip data-complete только при реальной полноте (курсора продолжения нет) —
      // иначе лоадер должен доскроллить историю (холодный открытие, частичный снимок).
      // v1.13.1: требуется reachedStart=true — baseComplete без начала недостоверен
      // (тихая пагинация могла оборваться при блокировке экрана).
      if (D.historyFullByQuiet === true && D.reachedStart === true && !D.pendingCursor) {
        D.loaderDoneMap[convId] = true;
        debugLog('log', '[AI CM][Gemini][loader] skip reason=data-complete convId=' + convId);
        return;
      }
      // v46: ждём первый распарсенный history-RPC (сигнал «есть старшая история»),
      // чтобы не решить преждевременно — ответ мог ещё не прийти.
      // T1-fix#2 (v1.16.2): «база непустая» ≠ «живой RPC распарсен» — архив вливает свои
      // ходы в ту же базу ДО прихода живого снапшота. Ждём сигнал по ЖИВЫМ ходам
      // (для чата без архива aiCmLiveTurnCount() === baseSize() — прежнее поведение).
      var liveMsgs = D.aiCmLiveTurnCount();
      if (!D.olderHistorySeen && liveMsgs === 0) {
        if (++tries < LOADER_SIGNAL_WAIT_TRIES) {
          // cold-debug: редкие отметки ожидания первого history-RPC (старт мог опередить сеть)
          if (tries === 1 || tries === 10 || tries === 19) {
            debugLog('log', '[AI CM][cold-debug] loader-wait-signal convId=' + convId +
              ' msgs=' + D.baseSize() + ' liveMsgs=' + liveMsgs + ' olderHistorySeen=0 try=' + tries + '/' + LOADER_SIGNAL_WAIT_TRIES +
              ' loaderRunning=' + (D.loaderRunningFor || 'none'));
          }
          setTimeout(tick, LOADER_SIGNAL_WAIT_MS); return;
        }
      }
      // v46: курсора продолжения в начальном ответе нет → старшей истории нет,
      // догружать нечего. Скроллинг лоадера на коротких чатах белил экран (f47e2edd).
      // v1.6 (D15): при единственном ре-ране (oracle-incomplete bypass) гейт пропускается.
      if (!D.olderHistorySeen && !D.oracleRerunUsedMap[convId]) {
        if (D.aiCmArchiveFor(convId) && liveMsgs === 0) {
          // T1-fix#2 (v1.16.2): «нет старшей истории» здесь выведено из НЕПУСТОЙ базы, а база
          // непуста ТОЛЬКО вкладом архива (живой RPC ещё не распарсен) — решение недостоверно.
          // Латч done НЕ ставим: ниже запускаем лоадер, чтобы догрузить живой ярус.
          debugLog('log', '[AI CM][Gemini][loader] no-older-history отложен: база = только архив convId=' + convId +
            ' msgs=' + D.baseSize() + ' liveMsgs=0');
        } else {
          D.loaderDoneMap[convId] = true;
          debugLog('log', '[AI CM][Gemini][loader] loader-skipped reason=no-older-history convId=' + convId + ' msgs=' + D.baseSize());
          return;
        }
      }
      if (D.loaderRunningFor === convId) return;
      // cold-debug: фактический старт прогона лоадера — решение и состояние на этот момент
      try {
        debugLog('log', '[AI CM][cold-debug] loader-run-start convId=' + convId +
          ' msgs=' + D.baseSize() +
          ' olderHistorySeen=' + (D.olderHistorySeen ? '1' : '0') +
          ' historyFullByQuiet=' + (D.historyFullByQuiet ? '1' : '0') +
          ' reachedStart=' + (D.reachedStart ? '1' : '0') +
          ' pendingCursor=' + (D.pendingCursor ? '1' : '0') +
          ' cacheRestored=' + (D.cacheRestoredMap.has(convId) ? '1' : '0') +
          ' floor=' + __floorMs + ' tries=' + tries);
      } catch (eRs) { }
      D.loaderDoneMap[convId] = true;
      D.loaderRunningFor = convId;
      D.notifyLoaderState(convId, true); // v42: наружу «лоадер бежит по convId»
      loadFullHistoryInvisibly().then(function () {
        if (D.loaderRunningFor === convId) D.loaderRunningFor = null;
        D.notifyLoaderState(convId, false); // v42: наружу «лоадер остановлен» — триггер re-check экспорта
      }).catch(function (e) {
        // v43: reject внешнего промиса — финализируем флаг, чтобы не завис «бегущий» лоадер;
        // внутренние ошибки лоадер уже залогировал сам — тихо и без дублей.
        if (D.loaderRunningFor === convId) D.loaderRunningFor = null;
        D.notifyLoaderState(convId, false);
        try { debugLog('log', '[AI CM][Gemini][loader] promise rejected convId=' + convId + ' err=' + (e && e.message || e)); } catch (eL) { }
      });
    }
    tick();
  }

  // ---------- E: слушатель 'visibilitychange' (resume-on-visible) ----------
  // v1.13.1: возврат видимости вкладки (Win+L → разблокировка). Если база была помечена
  // полной без подтверждённого начала (reachedStart=false) ИЛИ последний цикл
  // пагинации/лоадера завершился во время hidden — сбрасываем доверие к baseComplete
  // и перезапускаем тихую пагинацию/лоадер, чтобы докрутить остаток до реального начала.
  document.addEventListener('visibilitychange', function () {
    try {
      if (document.visibilityState !== 'visible') return;
      var convIdVis = D.getConvId();
      if (!convIdVis) return;
      var distrust = (D.historyFullByQuiet === true && D.reachedStart !== true) ||
        D.quietIncompleteNoStart || D.lastCycleEndedHidden;
      if (!distrust) return;
      D.historyFullByQuiet = false;      // сброс доверия к baseComplete
      D.quietIncompleteNoStart = false;
      D.lastCycleEndedHidden = false;
      D.quietDecisionMade = false;       // разрешаем повторное решение о старте тихого цикла
      delete D.loaderDoneMap[convIdVis]; // лоадер обязан перезапуститься
      console.log('[AI CM][loader] resume-on-visible convId=' + convIdVis +
        ' msgs=' + D.baseSize() + ' pendingCursor=' + (D.pendingCursor ? '1' : '0'));
      if (!D.quietActive) {
        if (D.pendingCursor) {
          D.quietActive = true;
          D.quietDecisionMade = true;
          D.paginateLoop(D.pendingCursor, 0);
        } else {
          maybeStartLoader();
        }
      }
    } catch (eVis) {
      try { debugLog('error', '[AI CM][loader] resume-on-visible error:', eVis); } catch (e2) { }
    }
  });

  // ---------- F: консольный хэндл ручного запуска ----------
  // Ручной запуск из консоли — тот же код, что и автозапуск.
  try { window.__aiCmGeminiLoadFullHistory = loadFullHistoryInvisibly; } catch (e) { }

  var Api = {
    __bind: __bind,
    loadFullHistoryInvisibly: loadFullHistoryInvisibly,
    maybeStartLoader: maybeStartLoader
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmGeminiLoaderScroll = Api;
})();
