/**
 * core/gemini-overlay.js — кластер оверлея загрузки истории Gemini (Phase 3 step 13.1).
 *
 * ЧТО ЗДЕСЬ. Непрозрачный оверлей «Загрузка истории…» на body и всё, что его окружает:
 * определение хоста Gemini (aiCmIsGeminiHost), палитра под in-app тему сервиса
 * (aiCmOverlayTheme) с живым наблюдателем темы (aiCmOverlayThemeWatcher,
 * aiCmApplyOverlayTheme, aiCmWatchOverlayTheme), постановка и seq-гвардированное снятие
 * оверлея (aiCmSetScrollOverlay), страховка видимости (forceRestoreVisibility) и её
 * безусловные триггеры — слушатели pagehide и visibilitychange.
 *
 * ПОЧЕМУ ВЫНЕСЕНО. Кластер самодостаточен: из восьми перенесённых функций семь
 * связаны друг с другом ВНУТРИ модуля, а наружу торчат ровно три имени (getConvId,
 * aiCmScrollOverlay, aiCmOverlaySeq). Ядро перехватчика разрослось, и оверлей —
 * естественная граница разреза: им пользуются лоадер, скрытый скролл и пагинация,
 * но владеет им только этот модуль.
 *
 * СВЯЗКА. Ядро зовёт window.AiCmGeminiOverlay.__bind({...}) из core/gemini-intercept.js;
 * состав объекта связи — tools/overlay-bind-contract.js: 1 функция значением и 2 живых
 * состояния с геттером и сеттером. Обратно модуль отдаёт 2 функции
 * (см. Api в конце файла).
 *
 * СОСТОЯНИЕ ОСТАЁТСЯ В ЯДРЕ. aiCmScrollOverlay, aiCmOverlaySeq и aiCmRerunOverlayTimer
 * объявлены в ядре и НЕ перенесены: их читают и пишут вне кластера (лоадер, скрытый
 * скролл, пагинация — seq-гвард и разоружение pre-applied оверлея). Первые два модуль
 * получает ЖИВЫМИ геттерами/сеттерами, поэтому запись отсюда видна ядру: снятие оверлея
 * обнуляет ту же переменную, а не копию. aiCmRerunOverlayTimer модулю не нужен вовсе —
 * им распоряжается пагинация.
 *
 * ПРАВКА ПРИ ПЕРЕНОСЕ. Тела перенесены байт-в-байт; единственное изменение — ссылки на
 * имена ядра получили префикс D (иначе свободное имя не разрешится: модуль — отдельный
 * файл, общего лексического скоупа с ядром у него нет). Свойства объектов, ключи
 * литералов, локальные имена и вызовы ВНУТРИ кластера (aiCmIsGeminiHost,
 * aiCmOverlayTheme, aiCmApplyOverlayTheme, aiCmWatchOverlayTheme, aiCmSetScrollOverlay,
 * forceRestoreVisibility) не тронуты — они резолвятся внутри модуля. Именно поэтому пины
 * снятия оверлея (forceRestoreVisibility и слушатели pagehide/visibilitychange) остались
 * байтово-идентичными и не потребовали правок; изменились только два литерала логов
 * overlay-on/overlay-off, где участвует getConvId.
 *
 * ПОРЯДОК ПОДКЛЮЧЕНИЯ. utils/debug.js, utils/gemini-batchexecute-parser.js,
 * utils/gemini-intercept-logic.js, core/gemini-hidden-scroll.js, core/gemini-diag.js,
 * core/gemini-rpc.js, core/gemini-parse.js, core/gemini-sse.js,
 * core/pagination/pagination.js, core/gemini-loader-scroll.js, core/gemini-ingest.js,
 * ЭТОТ ФАЙЛ, core/gemini-intercept.js — см. js[] в core/background.js (id -v9: MV3 не
 * перечитывает js[] под уже зарегистрированным id, поэтому при добавлении файла id
 * обязан смениться, иначе модуль не доедет до профилей с прежним id, а без модуля
 * оверлей загрузки истории недоступен целиком).
 *
 * ВНИМАНИЕ. Слушатели pagehide/visibilitychange регистрируются на загрузке модуля, то
 * есть до вызова __bind из ядра. Это безопасно: до первого реального события ядро уже
 * загружено (файлы идут одним пакетом content script без разрывов), а тело слушателя
 * обращается к зависимостям только при срабатывании. Файл намеренно без директивы
 * строгого режима и без with — как остальные модули MAIN-мира.
 *
 * PUBLIC API: window.AiCmGeminiOverlay = { __bind, aiCmSetScrollOverlay, forceRestoreVisibility }.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiOverlay) return;
  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  function __bind(d) { D = d; }

  // H22: тема оверлея следует in-app теме Gemini («Настройки → Тема»), а не только
  // prefers-color-scheme. Признак 1 — класс-токены theme-host.dark-theme / .light-theme на
  // html/body (CSS страницы: gemini-dom-sample.html:75 `:where(.theme-host):where(.dark-theme)`);
  // признак 2 — computed-яркость НЕПРОЗРАЧНОГО фона (lum<100 → dark). Хосты кроме Gemini и
  // светлый фон сохраняют прежнюю цепочку байтово (светлый фон не понижает до light).
  function aiCmIsGeminiHost() {
    try { return /(^|\.)gemini\.google\.com$/i.test(location.hostname); } catch (eH0) { return false; }
  }
  function aiCmOverlayTheme() {
    var dark = null;
    if (aiCmIsGeminiHost()) {
      try {
        var cls = ((document.documentElement && document.documentElement.className) || '') + ' ' +
                  ((document.body && document.body.className) || '');
        if (/(^|\s)dark-theme(\s|$)/.test(cls)) dark = true;
        else if (/(^|\s)light-theme(\s|$)/.test(cls)) dark = false;
      } catch (eTh0) { }
      if (dark === null) {
        try {
          var hostElG = document.querySelector('.theme-host.dark-theme, .theme-host.light-theme');
          if (hostElG) dark = hostElG.classList.contains('dark-theme');
        } catch (eTh0b) { }
      }
      if (dark === null) {
        try {
          var probes = [document.body, document.documentElement];
          for (var pi = 0; pi < probes.length; pi++) {
            var probeG = probes[pi];
            var cG = probeG ? (getComputedStyle(probeG).backgroundColor || '') : '';
            var mG = cG.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/);
            if (!mG) continue;
            var isTransparentG = (mG[4] !== undefined && parseFloat(mG[4]) === 0);
            if (!isTransparentG && (0.2126 * (+mG[1]) + 0.7152 * (+mG[2]) + 0.0722 * (+mG[3])) < 100) { dark = true; break; }
          }
        } catch (eTh1) { }
      }
    } else {
      try {
        var probe = document.documentElement || document.body;
        var c = probe ? (getComputedStyle(probe).backgroundColor || '') : '';
        var m = c.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/);
        if (m) {
          var isTransparent = (m[4] !== undefined && parseFloat(m[4]) === 0);
          if (!isTransparent) dark = (0.2126 * (+m[1]) + 0.7152 * (+m[2]) + 0.0722 * (+m[3])) < 100;
        }
      } catch (eTh1b) { }
    }
    if (dark === null) {
      try { dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (eTh2) { dark = false; }
    }
    return dark ? { name: 'dark', bg: '#1e1f20', fg: '#e3e3e3', ring: '#37393b' }
                : { name: 'light', bg: '#f0f4f9', fg: '#1f1f1f', ring: '#c4c7c5' };
  }
  // H22: живой пересчёт палитры поднятого оверлея при смене темы (класс/style/data-theme на
  // html/body ИЛИ prefers-color-scheme). Наблюдатель живёт только пока оверлей поднят.
  var aiCmOverlayThemeWatcher = null;
  function aiCmApplyOverlayTheme() {
    if (!D.aiCmScrollOverlay) return;
    try {
      var th = aiCmOverlayTheme();
      D.aiCmScrollOverlay.style.background = th.bg;
      var sp = D.aiCmScrollOverlay.querySelector('.ai-cm-loader-spinner');
      if (sp) { sp.style.borderColor = th.ring; sp.style.borderTopColor = th.fg; }
      var lb = D.aiCmScrollOverlay.querySelector('.ai-cm-loader-label');
      if (lb) lb.style.color = th.fg;
    } catch (eAt) { }
  }
  function aiCmWatchOverlayTheme(on) {
    try {
      if (on) {
        if (aiCmOverlayThemeWatcher) return;
        var reapply = function () { aiCmApplyOverlayTheme(); };
        var obs = new MutationObserver(reapply);
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        // H22: тема сервиса может жить на элементе-хосте .theme-host — следим и за ним
        var hostElW = null;
        try { hostElW = document.querySelector('.theme-host'); } catch (eQw) { }
        if (hostElW && hostElW !== document.documentElement && hostElW !== document.body) {
          obs.observe(hostElW, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        }
        var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        if (mql && mql.addEventListener) mql.addEventListener('change', reapply);
        aiCmOverlayThemeWatcher = { obs: obs, mql: mql, reapply: reapply };
      } else if (aiCmOverlayThemeWatcher) {
        aiCmOverlayThemeWatcher.obs.disconnect();
        if (aiCmOverlayThemeWatcher.mql && aiCmOverlayThemeWatcher.mql.removeEventListener) {
          aiCmOverlayThemeWatcher.mql.removeEventListener('change', aiCmOverlayThemeWatcher.reapply);
        }
        aiCmOverlayThemeWatcher = null;
      }
    } catch (eWt) { }
  }
  function aiCmSetScrollOverlay(on, reason, expectSeq) {
    try {
      if (on) {
        if (!D.aiCmScrollOverlay && typeof document !== 'undefined' && document.body) {
          var th = aiCmOverlayTheme();
          D.aiCmScrollOverlay = document.createElement('div');
          D.aiCmScrollOverlay.id = 'ai-cm-scroll-overlay';
          D.aiCmScrollOverlay.className = 'ai-cm-loader-overlay';
          D.aiCmScrollOverlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;background:' + th.bg + ';display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
          var sp = document.createElement('div');
          sp.className = 'ai-cm-loader-spinner';
          sp.style.cssText = 'width:36px;height:36px;border-radius:50%;border:3px solid ' + th.ring + ';border-top-color:' + th.fg + ';animation:aiCmOverlaySpin 0.9s linear infinite;';
          var lb = document.createElement('div');
          lb.className = 'ai-cm-loader-label';
          lb.style.cssText = 'font:400 14px "Google Sans",Roboto,Arial,sans-serif;color:' + th.fg + ';user-select:none;';
          lb.textContent = 'Загрузка истории…';
          var st = document.createElement('style');
          st.className = 'ai-cm-loader-style';
          st.textContent = '@keyframes aiCmOverlaySpin{to{transform:rotate(360deg)}}';
          D.aiCmScrollOverlay.appendChild(st);
          D.aiCmScrollOverlay.appendChild(sp);
          D.aiCmScrollOverlay.appendChild(lb);
          document.body.appendChild(D.aiCmScrollOverlay);
          D.aiCmOverlaySeq++;
          debugLog('log', '[AI CM][visibility] overlay-on reason=' + reason + ' theme=' + th.name + ' convId=' + (D.getConvId() || '(none)'));
          aiCmWatchOverlayTheme(true); // H22: следить за сменой темы, пока оверлей поднят
        }
      } else if (D.aiCmScrollOverlay) {
        // v80: seq-гвард — не снимаем оверлей, если его уже пересоздал более новый прогон
        if (typeof expectSeq === 'number' && expectSeq !== D.aiCmOverlaySeq) return;
        if (D.aiCmScrollOverlay.parentNode) D.aiCmScrollOverlay.parentNode.removeChild(D.aiCmScrollOverlay);
        D.aiCmScrollOverlay = null;
        aiCmWatchOverlayTheme(false); // H22: наблюдатель темы больше не нужен
        debugLog('log', '[AI CM][visibility] overlay-off reason=' + reason + ' convId=' + (D.getConvId() || '(none)'));
      }
    } catch (e) { }
  }
  // v70-совместимость: страховка видимости теперь только снимает оверлей
  // (SPA conv-switch, pagehide, visibilitychange). Скрытия DOM больше нет — таймер не нужен.
  function forceRestoreVisibility(reason) {
    aiCmSetScrollOverlay(false, 'force-' + reason);
  }
  try {
    window.addEventListener('pagehide', function () { forceRestoreVisibility('pagehide'); });
  } catch (ePh) { }
  try {
    // v80 (O1): безусловное снятие оверлея при любом изменении видимости вкладки —
    // оверлей не должен переживать уход со страницы/блокировку экрана.
    document.addEventListener('visibilitychange', function () { forceRestoreVisibility('visibilitychange'); });
  } catch (eVc80) { }

  var Api = {
    __bind: __bind,
    aiCmSetScrollOverlay: aiCmSetScrollOverlay,
    forceRestoreVisibility: forceRestoreVisibility
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmGeminiOverlay = Api;
})();
