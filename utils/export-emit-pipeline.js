/**
 * Общий EMIT-пайплайн экспорта (v81, Задача A).
 * Чистые функции для 6 адаптеров (chatgpt, gemini, deepseek, google_search, claude, perplexity):
 *   - buildAutoExportFileName(spec) — O-11: ЕДИНСТВЕННЫЙ источник имён автоэкспорта
 *     (маски 'convId' и 'manual') + гард коллизии имён (дисамбигуатор -2, -3, … по
 *     набору занятых имён spec.taken)
 *   - buildExportFileName(service, convId, reason, isLowConfidence, fmt) — обёртка O-11
 *   - buildGsaExportFileName(site, model, isLowConfidence, fmt) — v1.18 (F4): имя файла
 *     автоэкспорта GSA по шаблону ручного экспорта (ai-context-monitor-<site>-<model>-<stamp>);
 *     O-11: обёртка над единственным источником, 5-й аргумент — набор занятых имён
 *   - resolveAutoExportConvId(site, urlConvId, threadId) — v1.18 (F2): convId автоэкспорта
 *     (GSA: threadId вместо отсутствующего URL-id)
 *   - notCompleteReason(state) — v1.18 (F5): ярлык причины skip (probe-running у GSA)
 *   - shouldSkipAutoExport(state) — чистый гейт автоэкспорта
 *   - resolveExportSource(state) — T1-fix#3: источник файла (объединённая база архив+live /
 *     локальный снимок EMIT / запрет при базе «только архив»)
 *   - markAutoExportFired / getAutoExportFired / resetAutoExportFired — латч per service+convId
 *   - extractConvIdFromUrl(pathname) — идентификатор диалога из URL (без выдумывания);
 *     v1.19.1 (M-11): perplexity /search/<id> наравне с /thread/<slug>
 *   - normalizeExportMessages(raw) — нормализация к {role, text}
 *   - dedupeMessages(messages) — E-2: схлопывание дублей (роль + нормализованный текст,
 *     первое вхождение побеждает) для истории Gemini Deep Research
 *   - dedupeIntraMessage(message) — E-2.1: дедупликация ВНУТРИ одного сообщения
 *     (отрендеренный текст против сырого markdown-блока '### …' в том же ходе);
 *     E-2.2: стык копий НЕ обязан быть пустой строкой — separateRawBlocks разводит
 *     склеенный вариант ('…копированию.### ROLE'), а сырой блок с несколькими секциями
 *     чистится посекционно (вырезается только копия отрендеренного текста)
 *     склейки заголовка к непробельному символу, NBSP и пробельные различия (coreText,
 *     stripMarkerResidue) — форматная разметка НЕ влияет на вердикт дедупа
 *   - prepareExportMessages(raw, onMessageDedupe) — E-2.1: единая точка подготовки
 *     нормализация → внутри-сообщенческая → меж-сообщенческая дедупликация
 *     → cross-raw копии → гигиена остатков разметки
 *   - sanitizeInjectedUserText(text) — O-20: санация user-текста от инъекций сторонних
 *     расширений (DeepSeek++): ровно одна пара маркеров видимого промпта → trim текста
 *     между ними, иначе строка байтово; injectedUserTextSkipReason — причина пропуска;
 *     sanitizeEmitMessages — то же по массиву (трогается ТОЛЬКО role=user)
 * Паттерн как у export-text-builders.js: window.AiCmExportEmitPipeline + module.exports.
 * Логика оракула полноты, ленты, пола, виджета и Gemini-гейтов НЕ тронута.
 */
(function () {
  'use strict';

  // Санация сегмента имени файла (как в options.js)
  function safeSeg(s) {
    return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Идентификатор диалога из pathname. Возвращает '' если надёжного id нет —
  // идентификаторы НЕ выдумываем.
  // v1.19.1 (M-11): Perplexity живёт по ДВУМ формам URL — живой диалог /search/<id>
  // и старые/шаблонные ссылки /thread/<slug> (см. шапку core/perplexity-intercept.js).
  // Долго была распознана только вторая: на живом /search/<id> convId был '' и
  // maybeAutoExport() молча выходил на «if (!cid) return;» при зелёных гейтах.
  // /search матчится ТОЛЬКО с id-сегментом ([A-Za-z0-9_-]{8,}) — путь
  // google.com/search без id (GSA) остаётся '' (по-прежнему не выдумываем).
  function extractConvIdFromUrl(pathname) {
    try {
      var p = String(pathname || '');
      // Gemini (и AI Studio): /app/<id>
      var mApp = p.match(/\/app\/([A-Za-z0-9_-]+)/);
      if (mApp) return mApp[1];
      // chat.deepseek.com: /a/chat/s/<id> — ДО общего /chat/ (иначе вернётся 's')
      var mDs = p.match(/\/a\/chat\/s\/([A-Za-z0-9_-]+)/);
      if (mDs) return mDs[1];
      // claude.ai: /chat/<uuid> (или /project/<pid>/chat/<uuid>)
      var parts = p.split('/');
      var chatIdx = parts.indexOf('chat');
      if (chatIdx !== -1 && chatIdx + 1 < parts.length && parts[chatIdx + 1]) return parts[chatIdx + 1];
      // chatgpt.com: /c/<uuid>
      var mC = p.match(/\/c\/([A-Za-z0-9_-]+)/);
      if (mC) return mC[1];
      // perplexity.ai: /search/<id> — живой URL диалога (v1.19.1, M-11). Только
      // id-подобный сегмент 8+ символов: короткий хвост /search/... не id.
      var mPs = p.match(/\/search\/([A-Za-z0-9_-]{8,})/);
      if (mPs) return mPs[1];
      // perplexity.ai: /thread/<slug> — прежняя ветка (байтово не изменена)
      var mP = p.match(/\/thread\/([A-Za-z0-9_-]+)/);
      if (mP) return mP[1];
      // google.com (Search AI) и прочие — надёжного идентификатора в URL нет
      return '';
    } catch (e) { return ''; }
  }

  // =====================================================================================
  // O-11: ЕДИНСТВЕННЫЙ источник имён автоэкспорта + гард коллизии имён.
  //
  // До фикса имя автоэкспорта строили ДВЕ независимые маски (две точки генерации):
  //   1) buildExportFileName     — <service>-<convId slice 8|noconv>-<YYYY-MM-DD_HH-MM>[-reason].<fmt>;
  //   2) buildGsaExportFileName  — шаблон РУЧНОГО экспорта GSA:
  //      ai-context-monitor-<site>-<model>-<YYYY-MM-DD-HH-MM>.<fmt>.
  // У GSA надёжного convId в URL нет (threadId живёт только внутри сессии/перехватчика),
  // а маска ручного экспорта имеет МИНУТНУЮ гранулярность: два автоэкспорта в одну минуту
  // давали ОДНО имя файла — вторая копия терялась (оставался первый файл). Репро до фикса:
  //   point1(buildExportFileName, convId='') → google_search-noconv-<stamp>.txt
  //   point2(buildGsaExportFileName) #1 == #2 → ai-context-monitor-google_search-<model>-<stamp>.txt
  //
  // Теперь маска РОВНО ОДНА — buildAutoExportFileName(spec); обе прежние функции стали
  // тонкими обёртками с прежними сигнатурами (.length не изменён). Имена прочих платформ
  // и шаблон ручного экспорта GSA остаются байтово прежними (пин M-10/F4).
  //
  // Гард коллизии: spec.taken — набор уже занятых имён (массив, объект-карта или Set):
  // имя файла уже выдан расширением (файл существует) или второй экспорт в ту же минуту.
  // Занятое имя получает дисамбигуатор -2, -3, … перед расширением; первая копия НЕ
  // переименовывается. Уникальность даёт дисамбигуатор — convId по-прежнему НЕ выдумываем.
  // =====================================================================================

  /** Формат файла: txt | md | json (неизвестное → txt) — как в обеих прежних масках. */
  function normExportFmt(fmt) {
    return (fmt === 'md') ? 'md' : ((fmt === 'json') ? 'json' : 'txt');
  }

  function exportPad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Метка времени маски convId: YYYY-MM-DD_HH-MM (байтово прежняя). */
  function convIdStamp(d) {
    return d.getFullYear() + '-' + exportPad2(d.getMonth() + 1) + '-' + exportPad2(d.getDate()) +
      '_' + exportPad2(d.getHours()) + '-' + exportPad2(d.getMinutes());
  }

  /** Метка времени шаблона ручного экспорта: YYYY-MM-DD-HH-MM (как options.js buildFileName). */
  function manualExportStamp(d) {
    return d.getFullYear() + '-' + exportPad2(d.getMonth() + 1) + '-' + exportPad2(d.getDate()) +
      '-' + exportPad2(d.getHours()) + '-' + exportPad2(d.getMinutes());
  }

  /** Сегмент модели ручного шаблона: та же санация, что в options.js (точки сохраняются). */
  function safeModelSeg(model) {
    return String(model == null ? '' : model)
      .replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  }

  /** Имя занято? taken: массив имён | объект-карта (имя → что угодно) | Set. */
  function isFileNameTaken(taken, name) {
    try {
      if (!taken || !name) return false;
      if (typeof Set !== 'undefined' && taken instanceof Set) return taken.has(name);
      if (Array.isArray(taken)) return taken.indexOf(name) !== -1;
      if (typeof taken === 'object') return Object.prototype.hasOwnProperty.call(taken, name);
      return false;
    } catch (e) { return false; }
  }

  /** O-11: дисамбигуатор -2, -3, … перед расширением, пока имя занято. */
  function disambiguateFileName(name, taken) {
    var base = String(name == null ? '' : name);
    try {
      if (!isFileNameTaken(taken, base)) return base;
      var m = base.match(/^(.*)\.([A-Za-z0-9]+)$/);
      var stem = m ? m[1] : base;
      var ext = m ? ('.' + m[2]) : '';
      for (var i = 2; i <= 999; i++) {
        var cand = stem + '-' + i + ext;
        if (!isFileNameTaken(taken, cand)) return cand;
      }
      return stem + '-' + Date.now() + ext;
    } catch (e) { return base; }
  }

  /**
   * O-11: ЕДИНСТВЕННАЯ точка генерации имени автоэкспорта (обе прежние маски — здесь).
   * spec:
   *   mask: 'convId' (прочие сервисы) | 'manual' (GSA — шаблон ручного экспорта);
   *   маска 'convId': service, convId, reason, isLowConfidence, fmt;
   *   маска 'manual': site, model, isLowConfidence, fmt;
   *   taken: необязательный набор занятых имён — гард коллизии (дисамбигуатор -2, -3, …).
   * Префикс [LOW CONFIDENCE]_ — ТОЛЬКО при isLowConfidence=true (baseComplete=0).
   * reason: 'threshold' (без суффикса) | 'pre-trim' → -pretrim | 'base-complete' → -base-complete.
   */
  function buildAutoExportFileName(spec) {
    var s = spec || {};
    var lowConfPrefix = (s.isLowConfidence === true) ? '[LOW CONFIDENCE]_' : '';
    var d = new Date();
    var base;
    if (s.mask === 'manual') {
      // Шаблон ручного экспорта (M-10/F4): ai-context-monitor-<site>-<model>-<YYYY-MM-DD-HH-MM>
      var siteSeg = safeSeg(s.site) || 'google_search';
      base = 'ai-context-monitor-' + siteSeg + '-' + safeModelSeg(s.model) + '-' + manualExportStamp(d);
    } else {
      var cidSeg = safeSeg(String(s.convId || '').slice(0, 8)) || 'noconv';
      var svcSeg = safeSeg(s.service) || 'chat';
      var suffix = '';
      if (s.reason === 'pre-trim') suffix = '-pretrim';
      else if (s.reason === 'base-complete') suffix = '-base-complete';
      base = svcSeg + '-' + cidSeg + '-' + convIdStamp(d) + suffix;
    }
    return disambiguateFileName(lowConfPrefix + base + '.' + normExportFmt(s.fmt), s.taken);
  }

  /**
   * Имя файла автоэкспорта прочих сервисов (обёртка O-11 над единственным источником):
   *   [LOW CONFIDENCE]_<service>-<convId slice 0,8 | 'noconv'>-<YYYY-MM-DD_HH-MM>[-pretrim|-base-complete].<fmt>
   * Префикс [LOW CONFIDENCE]_ — ТОЛЬКО при isLowConfidence=true (baseComplete=0).
   * reason: 'threshold' (без суффикса) | 'pre-trim' → -pretrim | 'base-complete' → -base-complete.
   * O-11: необязательный 6-й аргумент (arguments[5]) — набор занятых имён (гард коллизии);
   * сигнатура .length = 5 сохранена (пин tests/low-confidence-prefix.test.js).
   */
  function buildExportFileName(service, convId, reason, isLowConfidence, fmt) {
    return buildAutoExportFileName({
      mask: 'convId',
      service: service,
      convId: convId,
      reason: reason,
      isLowConfidence: isLowConfidence,
      fmt: fmt,
      taken: (arguments.length > 5) ? arguments[5] : null
    });
  }

  /**
   * v1.18 (F4): имя файла автоэкспорта Google Search AI (site=google_search) —
   * ТОТ ЖЕ шаблон, что у РУЧНОГО экспорта этого сайта (options/options.js buildFileName):
   *   [LOW CONFIDENCE]_ai-context-monitor-<site>-<model>-<YYYY-MM-DD-HH-MM>.<txt|md|json>
   * Почему не общий buildExportFileName: у GSA в URL нет convId (threadId живёт только
   * внутри сессии/перехватчика), поэтому файл, как и при ручном сохранении, именуется
   * парой сервис+модель+метка времени. Префикс [LOW CONFIDENCE]_ — ТОЛЬКО при
   * isLowConfidence=true (baseComplete=0), как в ручном пути.
   * Остальные сервисы (в т.ч. Gemini — байтово) идут прежним buildExportFileName.
   * O-11: необязательный 5-й аргумент (arguments[4]) — набор занятых имён (гард коллизии):
   * два автоэкспорта GSA в одну минуту больше не дают одно имя (дисамбигуатор -2).
   */
  function buildGsaExportFileName(site, model, isLowConfidence, fmt) {
    return buildAutoExportFileName({
      mask: 'manual',
      site: site,
      model: model,
      isLowConfidence: isLowConfidence,
      fmt: fmt,
      taken: (arguments.length > 4) ? arguments[4] : null
    });
  }

  /**
   * v1.18 (F2): convId автоэкспорта. Приоритет — идентификатор из URL (5 сервисов);
   * для google_search надёжного id в URL нет (extractConvIdFromUrl → ''), поэтому
   * идентификатором разговора служит threadId снапшота (detail.threadId) — тот же id,
   * что ведёт сетевой перехватчик GSA. Прочие сервисы без URL-id → '' (не выдумываем).
   * v1.19.1 (M-11): perplexity — обычный не-GSA сайт: отдельной ветки в сайтовом
   * свитче нет и не требуется, urlConvId (/search/<id> или /thread/<id>) возвращает
   * первый return. Логика GSA (threadId) и Gemini не тронута.
   * Ключ латча = site + этот convId (см. latchKey), поэтому GSA-разговоры изолированы
   * друг от друга, а не делят один пустой ключ.
   */
  function resolveAutoExportConvId(site, urlConvId, threadId) {
    var cid = String(urlConvId == null ? '' : urlConvId);
    if (cid) return cid;
    if (String(site == null ? '' : site) === 'google_search') {
      return String(threadId == null ? '' : threadId);
    }
    return '';
  }

  /**
   * v1.18 (F5): уточнение причины skip=not-complete для логов. Вердикт полноты ОДИН
   * (shouldSkipAutoExport.baseComplete); здесь только ярлык: у GSA полноту взводит
   * probe-классификатор страницы продолжения, и пока probe в полёте, полноты нет по
   * определению — это 'probe-running', а не общий 'not-complete'.
   * state: { site, probeRunning }.
   */
  function notCompleteReason(state) {
    var s = state || {};
    if (s.site === 'google_search' && s.probeRunning === true) return 'probe-running';
    return 'not-complete';
  }

  /**
   * v82 (D2): выбор источника экспорта. baseSeen=true → 'network' (ЕДИНСТВЕННЫЙ
   * источник; пустые сетевые тексты дают [] — потребители skip), baseSeen=false →
   * 'adapter'. hasNetworkTexts нужен только для читаемости/диагностики.
   */
  function pickExportSource(hasBaseSeen, hasNetworkTexts) {
    return (hasBaseSeen === true) ? 'network' : 'adapter';
  }

  /**
   * T1-fix#3 (v1.16.3): ОТКУДА экспорт берёт сообщения.
   * Последний EMIT (lastBaseTexts в content.js) может не совпадать с ОБЪЕДИНЁННОЙ базой
   * (архив + live): архив вливается в turnsMap первым (читается из chrome.storage сразу
   * при page-load), а живая история приходит позже — файл уходил одной архивной частью
   * (live-прогон: 4 архивных хода в файле при базе 114).
   * Решение (чистая функция — вызывается из doAutoExportDownload, единственной точки
   * записи файла, поэтому покрывает и порог, и триггер base-complete, и pre-trim):
   *   { action:'block', reason:'archive-only-base' } — в базе ТОЛЬКО архив (живых ходов 0):
   *       пол/полнота первого яруса права на файл не даёт, латч fired НЕ ставится;
   *   { action:'union', reason:'stale-local-source' } — объединённая база (архив + live)
   *       больше локального снимка → источником файла становится она;
   *   { action:'local', reason } — прежнее поведение 1:1 (не Gemini / моста нет /
   *       архив не импортирован / объединённая база не больше локального снимка).
   * state: { isGemini, bridge, archiveCount, liveCount, baseCount, localCount }.
   * Обратная совместимость: без архива (archiveCount=0) всегда 'local'.
   */
  function resolveExportSource(state) {
    var s = state || {};
    if (s.isGemini !== true) return { action: 'local', reason: 'non-gemini' };
    if (s.bridge !== true) return { action: 'local', reason: 'no-bridge' };
    var arch = (typeof s.archiveCount === 'number' && s.archiveCount > 0) ? s.archiveCount : 0;
    if (arch <= 0) return { action: 'local', reason: 'no-archive' };
    var live = (typeof s.liveCount === 'number') ? s.liveCount : null;
    if (live === 0) return { action: 'block', reason: 'archive-only-base' };
    var base = (typeof s.baseCount === 'number') ? s.baseCount : 0;
    var local = (typeof s.localCount === 'number') ? s.localCount : 0;
    if (live !== null && live > 0 && base > local) return { action: 'union', reason: 'stale-local-source' };
    return { action: 'local', reason: 'in-sync' };
  }

  /**
   * Чистый гейт автоэкспорта. state:
   *   { enabled, percentage, threshold, baseComplete, baseSeen, loaderRunning, fired, isGemini,
   *     archiveCount, baseCount }
   * archiveCount/baseCount (T1-fix#2, v1.16.2) опциональны: не переданы — прежнее поведение.
   * Возвращает { skip, reason, resetFired }. Порядок гейтов повторяет
   * существующий maybeAutoExport (v30.5/v42/гистерезис −10 п.п.).
   */
  function shouldSkipAutoExport(state) {
    var s = state || {};
    if (s.enabled !== true) return { skip: true, reason: 'not-enabled', resetFired: false };
    if (typeof s.percentage !== 'number' || !(s.percentage >= 0)) return { skip: true, reason: 'no-pct', resetFired: false };
    var threshold = (typeof s.threshold === 'number' && s.threshold >= 1 && s.threshold <= 100) ? s.threshold : 90;
    // Гейт полноты: для Gemini — только по сети (baseComplete); для не-Gemini
    // неполная сетевая база тоже блокирует, но полный DOM-адаптер (baseSeen=false)
    // сигнала полноты не требует.
    var completeOk = (s.isGemini === true)
      ? (s.baseComplete === true)
      : (!s.baseSeen || s.baseComplete === true);
    if (!completeOk) return { skip: true, reason: 'not-complete', resetFired: false };
    // T1-fix#2 (v1.16.2): пол первого яруса (архив) не даёт права на автоэкспорт, пока
    // живая история не влилась. Архивные ходы лежат в ТОЙ ЖЕ базе (same-conv-union),
    // поэтому «count дорос до архива» выполняется вкладом самого архива — база из одного
    // архива (baseCount <= archiveCount) полнотой живого яруса НЕ является.
    // Латч fired не ставится (resetFired=false): поздний честный экспорт остаётся возможен.
    // Гейт включается только при переданных archiveCount/baseCount (обратная совместимость).
    if (s.isGemini === true && typeof s.archiveCount === 'number' && s.archiveCount > 0 &&
        typeof s.baseCount === 'number' && s.baseCount <= s.archiveCount) {
      return { skip: true, reason: 'archive-pending-live', resetFired: false };
    }
    if (s.isGemini === true && s.loaderRunning) return { skip: true, reason: 'loader-running', resetFired: false };
    // Гистерезис: ниже порога на 10 п.п. — сброс латча ТОЛЬКО по достоверному pct.
    // v82 (D5): для не-Gemini при baseSeen=false pct — транзиентное DOM-окно (виртуализация),
    // латч НЕ трогаем (иначе повторный fired на том же convId); Gemini — прежнее поведение 1:1.
    if (s.percentage < threshold - 10) {
      if (s.isGemini === true || s.baseSeen === true) return { skip: true, reason: 'below-threshold-hysteresis', resetFired: true };
      return { skip: true, reason: 'below-threshold-unreliable', resetFired: false };
    }
    if (s.percentage < threshold) return { skip: true, reason: 'below-threshold', resetFired: false };
    if (s.fired) return { skip: true, reason: 'already-fired', resetFired: false };
    return { skip: false, reason: null, resetFired: false };
  }

  /**
   * S2: эффективный порог автоэкспорта с учётом per-site оверрайда.
   * Приоритет: per-site ('aiCmAutoExportPct_<site>') → глобальный → 90.
   * per-site значение клампится в [1,100]; нечисловой/пустой per-site — фолбэк на
   * глобальный; невалидный глобальный — дефолт 90 (поведение глобального пути 1:1).
   */
  function effectiveAutoExportThreshold(globalPct, perSitePct) {
    function clampPerSite(v) {
      var n = parseInt(v, 10);
      if (isNaN(n)) return null;
      if (n < 1) return 1;
      if (n > 100) return 100;
      return n;
    }
    if (perSitePct !== undefined && perSitePct !== null && String(perSitePct).trim() !== '') {
      var per = clampPerSite(perSitePct);
      if (per != null) return per;
    }
    var g = (typeof globalPct === 'number' && globalPct >= 1 && globalPct <= 100) ? globalPct : null;
    return (g == null) ? 90 : g;
  }

  // Латч «один раз на чат» — per service+convId (изоляция по сервису: одинаковый
  // формальный идентификатор у разных сервисов НЕ блокирует друг друга).
  function latchKey(service, convId) {
    return safeSeg(service) + '|' + String(convId || '');
  }
  function markAutoExportFired(store, service, convId) {
    try { store[latchKey(service, convId)] = 1; } catch (e) { }
  }
  function getAutoExportFired(store, service, convId) {
    try { return store[latchKey(service, convId)] === 1; } catch (e) { return false; }
  }
  function resetAutoExportFired(store, service, convId) {
    try { delete store[latchKey(service, convId)]; } catch (e) { }
  }

  // v1.14.1 (O3): кросс-табовый латч already-fired поверх in-memory autoExportFired.
  // chrome.storage.session общий для всех вкладок профиля — двойной экспорт одного
  // чата из двух окон (наблюдался 2026-09-02, файлы …22-12.txt и …22-12(1).txt)
  // становится невозможным: вторая вкладка видит session-латч первой.
  var FIRED_SESSION_PREFIX = 'aiCmFired:';
  function firedSessionKey(service, convId) {
    return FIRED_SESSION_PREFIX + latchKey(service, convId);
  }
  function isFiredInSession(sessionMap, service, convId) {
    try {
      return !!sessionMap && sessionMap[firedSessionKey(service, convId)] === 1;
    } catch (e) { return false; }
  }
  function sessionFiredPatch(service, convId) {
    var patch = {};
    try { patch[firedSessionKey(service, convId)] = 1; } catch (e) { }
    return patch;
  }

  /**
   * Нормализация источника сообщений к [{role, text}]:
   *   - роли: raw[i].role ('user' → user, иначе assistant);
   *   - текст: raw[i].text || raw[i].content; пустые отбрасываются.
   */
  function normalizeExportMessages(raw) {
    var out = [];
    try {
      if (!Array.isArray(raw)) return out;
      for (var i = 0; i < raw.length; i++) {
        var m = raw[i] || {};
        var text = (typeof m.text === 'string') ? m.text : (typeof m.content === 'string' ? m.content : '');
        if (!text) continue;
        out.push({ role: (m.role === 'user') ? 'user' : 'assistant', text: text });
      }
    } catch (e) { }
    return out;
  }

  // =====================================================================================
  // v1.18 (E-2.3): marker-insensitive «ядро» контента. Форматная разметка НЕ влияет на
  // работу расширения: ВСЕ сравнения дедупа (внутри- и меж-сообщенческие) ведутся по
  // coreText — тексту после снятия ЛЮБОЙ markdown/спец-разметки:
  //   - любое количество '#' (заголовок любого уровня: в начале строки, после маркеров
  //     списка/цитаты и в СКЛЕЙКЕ с непробельным символом: '…копированию.### ROLE');
  //   - '*', '_', '`', '~' (выделение/код) и code-fences (``` / ~~~);
  //   - '>' (цитата) и маркеры списков ('-', '*', '+', '1.', '1)');
  //   - NBSP и прочие неразрывные пробелы, любые пробельные/переводы строк.
  // Пороги существенности (INTRA_CORE_MIN_LEN, CROSS_RAW_MIN_LINES/CHARS) СОХРАНЕНЫ:
  // разные сообщения не схлопываются ложно.
  // =====================================================================================
  /** Строка-заголовок ЛЮБОГО уровня: с начала строки, с точностью до ведущих маркеров
   *  списка/цитаты ('- ### ', '> ## ', '1. # '), за которыми идёт один и более '#'. */
  var RE_RAW_HEADING_LINE = /^[\s>*+\-\d.)\]]*#{1,}(?=\s|$)/;
  /** Строка-ОСТАТОК разметки: одни '#' (маркер вырезанного/осиротевшего заголовка). */
  var RE_MARKER_RESIDUE_LINE = /^[\s>*+\-\d.)\]]*#{1,}[\s]*$/;
  /** Строка code-fence — служебная разметка (её содержимое остаётся). */
  var RE_CODE_FENCE_LINE = /^[\s>*+\-\d.)\]]*(`{3,}|~{3,})/;
  /** Маркер списка: '- ', '* ', '+ ', '1. ', '1) '. */
  var RE_LIST_MARK = /^(?:[-*+]|\d+[.)])[ \t]+/;
  var RE_ANY_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/g;

  /** NBSP и прочие неразрывные пробелы → обычный пробел (сравнение по «ядру»). */
  function deSpaceAny(s) {
    return String(s == null ? '' : s).replace(RE_ANY_SPACE, ' ');
  }

  /** Ядро ОДНОЙ строки: снять ведущие маркеры (заголовок/список/цитата) и inline-разметку. */
  function coreOfLine(line) {
    try {
      var s = deSpaceAny(line);
      if (RE_CODE_FENCE_LINE.test(s)) return '';
      var prev;
      do {
        prev = s;
        s = s.replace(/^[ \t]+/, '');
        if (/^>[ \t]?/.test(s)) s = s.replace(/^>[ \t]?/, '');
        else if (RE_LIST_MARK.test(s)) s = s.replace(RE_LIST_MARK, '');
        else if (RE_RAW_HEADING_LINE.test(s)) s = s.replace(/^#{1,}[ \t]*/, '');
      } while (s !== prev);
      return s.replace(/[*_`~#>]+/g, ' ').replace(/\s+/g, ' ').trim();
    } catch (e) { return ''; }
  }

  /** Ядро текста: каждая строка → ядро строки, пустые ядра (маркеры/фенсы) отбрасываются,
   *  результат схлопывается в один пробел. */
  function coreText(text) {
    try {
      var lines = deSpaceAny(text).split('\n');
      var kept = [];
      for (var i = 0; i < lines.length; i++) {
        var c = coreOfLine(lines[i]);
        if (c) kept.push(c);
      }
      return kept.join(' ');
    } catch (e) { return ''; }
  }

  /** E-2.3: убрать из текста строки-остатки разметки (одни '#') — маркер вырезанного
   *  raw-заголовка удаляется ЦЕЛИКОМ, включая оставшиеся символы решётки. Сообщение без
   *  таких строк возвращается БАЙТОВО тем же (чужие форматы не трогаем). */
  function stripMarkerResidue(text) {
    try {
      var s = String(text == null ? '' : text);
      if (s.indexOf('#') === -1) return s;
      var lines = s.split('\n');
      var kept = [];
      var dropped = false;
      for (var i = 0; i < lines.length; i++) {
        if (RE_MARKER_RESIDUE_LINE.test(lines[i])) { dropped = true; continue; }
        kept.push(lines[i]);
      }
      return dropped ? kept.join('\n') : s;
    } catch (e) { return String(text == null ? '' : text); }
  }

  /**
   * E-2 (Gemini Deep Research): схлопывание дублей истории.
   * Один и тот же текст пользователя попадает в собранную историю НЕСКОЛЬКО раз:
   * пузырь реплики + карточка плана + узлы шагов исследования (разные id/узлы —
   * подряд идущий строгий дедуп их не видит). Результат: раздутые токены/бейдж,
   * повтор промпта в .txt/.md/print (live: 4 повтора при одном реальном промпте).
   * Правило: сообщения с ОДИНАКОВОЙ ролью и идентичным «ядром» текста (E-2.3: coreText —
   * снята любая форматная разметка, схлопнуты пробелы/NBSP/переводы строк) схлопываются,
   * остаётся ПЕРВОЕ вхождение. Роли
   * сравниваются независимо: user-реплика не съедает assistant, даже если текст совпал.
   * Карточка плана («Вот план исследования…» + цитата цели) — другой текст → остаётся
   * ОДНИМ assistant-сообщением, её текст не режется.
   * Чистая функция: возвращает { messages, removed } — без логов и побочных эффектов.
   */
  function dedupeMessages(messages) {
    var out = [];
    var seen = {};
    var removed = 0;
    try {
      if (!Array.isArray(messages)) return { messages: out, removed: 0 };
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i] || {};
        var role = (m.role === 'user') ? 'user' : 'assistant';
        var text = (typeof m.text === 'string') ? m.text : '';
        // E-2.3: ключ — «ядро» контента (без форматной разметки), а не сырой текст:
        // копии одного промпта с разным количеством '#', '*', '`', '>' и разной
        // нумерацией схлопываются, а РАЗНЫЙ контент не схлопывается.
        var key = role + '\u0000' + coreText(text);
        // hasOwnProperty (а не truthy-проверка): обычный {} наследует Object.prototype,
        // и текст вида 'toString' ложно считался бы уже виденным.
        if (Object.prototype.hasOwnProperty.call(seen, key)) { removed++; continue; }
        seen[key] = true;
        var keep = { role: role, text: text };
        // v1.18 (E-2.1): id ходов переносится — иначе набор id базы (baseIdSet) и запись
        // ленты рвутся после схлопывания. Потребители без id получают прежний {role,text}.
        if (m.id != null) keep.id = m.id;
        out.push(keep);
      }
    } catch (e) { }
    return { messages: out, removed: removed };
  }

  // E-2.1: минимальная длина «ядра» сырого markdown-блока (текст без строк '### …'), при
  // которой он считается дублем отрендеренного текста. Ниже порога блок из одних
  // заголовков ('### ROLE') ничьей копией не признаётся — короткие служебные блоки
  // («Да.», «Готово.») не вырезаются из ответа.
  var INTRA_CORE_MIN_LEN = 20;

  /** Блок — сырой markdown Gemini (в нём есть строка-заголовок ЛЮБОГО уровня '#'+;
   *  E-2.3: и одинокая '#'-строка — тоже маркер заголовка, а не контент). */
  function isRawMarkdownBlock(block) {
    try {
      var lines = String(block == null ? '' : block).split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (RE_RAW_HEADING_LINE.test(lines[i])) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  /**
   * E-2.2: нормализация СТЫКА копий перед разбиением на блоки.
   * Живой экспорт Gemini (convId 72c88213f2e812e1) клеит отрендеренную копию с сырым
   * markdown-блоком БЕЗ переноса строки на стыке:
   *   «…готовы к прямому копированию.### ROLE & OBJECTIVE…»
   * Разбиение по /\n{2,}/ такой текст блоками не видит (split даёт ОДИН блок), поэтому
   * внутри-сообщенческий дедуп молча не срабатывал и промпт оставался в экспорте дважды
   * внутри одного хода. Здесь перед заголовком '### ', приклеенным к непробельному
   * символу, вставляется пустая строка:
   *   '…копированию.### ROLE'  → '…копированию.\n\n### ROLE';
   *   '…копированию. ### ROLE' → '…копированию.\n\n### ROLE'.
   * Инварианты:
   *   - заголовок в начале текста не трогается (нечего разделять);
   *   - заголовок, уже стоящий после пустой строки, не трогается — замена ИДЕМПОТЕНТНА;
   *   - внутренние пустые строки сырого блока НЕ схлопываются: сырой блок с несколькими
   *     секциями ('### ROLE…\n### CONSTRAINTS…') остаётся ОДНИМ блоком, а его секции
   *     чистит pass 2 (E-2.2) — E-2.1 (ядро целиком) не ломается;
   *   - текст без заголовков '#'+ не меняется БАЙТОВО (обычные ходы всех сервисов);
   *   - E-2.3: разметка — ЛЮБОЕ количество '#'; одиночный '#' склеивается только после
   *     знака конца фразы, иначе 'C# и Java' в обычном чате ложно распался бы на блоки.
   * Одиночный перенос перед заголовком ('…копированию.\n### ROLE') сюда НЕ входит: его
   * нормализация схлопывала бы пустые строки ВНУТРИ сырого блока и ломала E-2.1, поэтому
   * такой стык разбирается посекционно (splitRawSections + cutLeadingCopy).
   */
  function separateRawBlocks(text) {
    // Предыдущий символ — НЕ '#' (иначе '### ' распалось бы само на '#' + '## '); пробелы
    // перед заголовком поглощаются, поэтому замена ИДЕМПОТЕНТНА и для '… . ### ROLE'.
    return String(text).replace(/([^#\n])[ \t]*(#{1,6})(?=[ \t])/g, function (all, prev, hashes) {
      if (hashes.length < 2 && !/[.!?;:»")\]]$/.test(prev)) return all;
      return prev + '\n\n' + hashes;
    });
  }

  /**
   * E-2.2: сырой блок → секции по строкам-заголовкам ('#'+, E-2.3). Каждая секция
   * начинается своим заголовком; текст до первого заголовка идёт первой секцией без
   * заголовка. Обычный блок (без '#'-заголовков) даёт РОВНО одну секцию — весь блок.
   * Нужно, чтобы у сырого блока, где за копией промпта идут ещё секции
   * ('### CONSTRAINTS' и т.п.), дублирующая копия вырезалась посекционно: раньше
   * «ядро» считалось по всему блоку, не совпадало с отрендеренным текстом и блок
   * выживал ЦЕЛИКОМ (копия промпта оставалась в экспорте/бейдже).
   */
  function splitRawSections(block) {
    try {
      var lines = String(block == null ? '' : block).split('\n');
      var out = [];
      var cur = null;
      for (var i = 0; i < lines.length; i++) {
        if (RE_RAW_HEADING_LINE.test(lines[i])) {
          if (cur) out.push(cur.join('\n'));
          cur = [lines[i]];
        } else if (cur) {
          cur.push(lines[i]);
        } else {
          cur = [lines[i]];
        }
      }
      if (cur) out.push(cur.join('\n'));
      return out.length ? out : [String(block == null ? '' : block)];
    } catch (e) { return [String(block == null ? '' : block)]; }
  }

  /** Разделитель при пересборке секций сырого блока: сохраняем форму исходного блока
   *  (пустая строка между секциями, если она там была; иначе — один перевод строки). */
  function sepForSections(block) {
    return /\n{2,}/.test(String(block == null ? '' : block)) ? '\n\n' : '\n';
  }

  /** E-2.2: убрать из сырой секции ведущую копию отрендеренного текста.
   *  Живой экспорт кладёт копию промпта ПЕРВОЙ строкой секции ('### ROLE & OBJECTIVE' +
   *  промпт + собственные ограничения), поэтому секция начинается с копии, а не равна ей.
   *  E-2.3: копия может отличаться от тела только РАЗМЕТКОЙ (уровень заголовков, '*'/'_'/
   *  '`', '>', NBSP) — тогда граница ищется по «ядрам» (corePrefixCutIndex).
   *  Возвращает остаток ({ text, trimmed }) или null, если вся секция — копия. */
  function cutLeadingCopy(section, folded) {
    var lines = String(section).split('\n');
    if (lines.length < 2) return { text: String(section), trimmed: false };
    var head = lines[0];
    var body = lines.slice(1).join('\n');
    var bodyNorm = normalizeIntraBlock(body);
    var copyNorm = normalizeIntraBlock(folded);
    if (!bodyNorm || !copyNorm) return { text: String(section), trimmed: false };
    if (bodyNorm === copyNorm) return null;                       // тело целиком — копия
    if (bodyNorm.indexOf(copyNorm) === 0) {
      // Тело начинается с копии: границу (конец копии) ищем по её последнему слову.
      var tail = bodyNorm.slice(copyNorm.length).replace(/^\s+/, '');
      if (!tail) return null;
      var lastWord = copyNorm.split(' ').pop();
      var at = body.lastIndexOf(lastWord);
      if (at < 0) return null;
      var rest = body.slice(at + lastWord.length).replace(/^\s+/, '');
      if (!rest) return null;
      return { text: head + '\n' + rest, trimmed: true };
    }
    // E-2.3: та же копия, но с другой разметкой — границу даёт накопление слов по «ядрам».
    var cutIdx = corePrefixCutIndex(body, coreText(folded));
    if (cutIdx < 0) return { text: String(section), trimmed: false };
    var restCore = body.slice(cutIdx).replace(/^\s+/, '');
    if (!restCore) return null;
    return { text: head + '\n' + restCore, trimmed: true };
  }

  /** E-2.3: индекс конца ведущей копии в теле по «ядрам» (тело может отличаться от копии
   *  только разметкой). Возвращает длину префикса тела, чей coreText равен copyCore, или -1. */
  function corePrefixCutIndex(body, copyCore) {
    try {
      if (!copyCore) return -1;
      // Дешёвый предфильтр: ядро тела обязано НАЧИНАТЬСЯ с ядра копии.
      if (coreText(body).indexOf(copyCore) !== 0) return -1;
      var re = /(\S+)/g;
      var m;
      while ((m = re.exec(body)) !== null) {
        var end = m.index + m[0].length;
        var probe = coreText(body.slice(0, end));
        if (probe === copyCore) return end;
        if (probe.length > copyCore.length) return -1;
      }
      return -1;
    } catch (e) { return -1; }
  }

  /** E-2.2: отрендеренная копия, к которой относится сырой блок blocks[i] — ближайший
   *  НЕсырой блок (как правило непосредственно перед сырым). Возвращает текст копии или
   *  null, если её нет: тогда сырой блок не пересобираем, чтобы не потерять содержимое. */
  function renderedBeforeRaw(blocks, i, raw) {
    for (var b = i - 1; b >= 0; b--) {
      if (b === i || raw[b]) continue;
      if (!coreText(blocks[b])) continue;
      return String(blocks[b]);
    }
    return null;
  }

  /** Нормализация блока для поиска ГРАНИЦЫ копии: trim + схлоп пробелов. Сами сравнения
   *  дедупа (E-2.3) идут по coreText/coreOfBlock, а здесь сохраняется точное соответствие
   *  нормализованного текста исходному (по нему находится конец копии в теле секции). */
  function normalizeIntraBlock(block) {
    return String(block == null ? '' : block).replace(/\s+/g, ' ').trim();
  }

  /**
   * «Ядро» и отрендеренный текст — это одна и та же реплика, если «ядра» совпадают ИЛИ
   * одно содержится в другом. E-2.3: сравнение идёт по coreText (разметка снята).
   * Порог длины отсекает короткие служебные блоки.
   */
  function intraBlocksSimilar(a, b) {
    var x = coreText(a);
    var y = coreText(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var minLen = (x.length < y.length) ? x.length : y.length;
    if (minLen < INTRA_CORE_MIN_LEN) return false;
    return (x.length >= y.length) ? (x.indexOf(y) !== -1) : (y.indexOf(x) !== -1);
  }

  /**
   * E-2.1 (Gemini Deep Research с вложениями): дедупликация ВНУТРИ одного сообщения.
   * Deep Research кладёт в ОДИН ход и отрендеренный текст, и сырой markdown-блок
   * (начинается с '### ROLE& OBJECTIVE' / '### ROLE'), который модель хранит для
   * внутреннего рендеринга. Меж-сообщенческий dedupeMessages такие повторы не видит —
   * они внутри одной строки истории, поэтому промпт попадал в .txt дважды.
   *
   * Логика:
   *   - текст режется на блоки по пустым строкам (\n\n);
   *   - дубликат = нормализованные тексты блоков идентичны (trim + схлоп пробелов),
   *     ИЛИ сырой markdown-блок (есть '### ' в начале строки) своим «ядром» (текст без
   *     строк-заголовков) совпадает с отрендеренным блоком — ядро при этом не короче
   *     INTRA_CORE_MIN_LEN, чтобы не вырезать короткие служебные блоки;
   *   - побеждает ПЕРВОЕ вхождение (в DOM отрендеренный текст идёт раньше сырого);
   *   - если отрендеренный дубль идёт ПОСЛЕ сырого блока — выживает всё равно
   *     отрендеренный (приоритет отрендеренного текста), сырой отбрасывается.
   * Возвращает { text, removedBlocks } — чистая функция, без логов и побочных эффектов.
   */
  function dedupeIntraMessage(message) {
    var text = (message && typeof message.text === 'string') ? message.text : '';
    var removedBlocks = 0;
    try {
      if (!text) return { text: text, removedBlocks: 0 };
      // E-2.2: сначала разводим СТЫКИ (glued/scrolled-copy) на канонические блоки, иначе
      // склеенная копия остаётся одним блоком и дублем не признаётся (см. separateRawBlocks).
      var seam = separateRawBlocks(text);
      var blocks = seam.split(/\n{2,}/);
      if (blocks.length < 2) return { text: text, removedBlocks: 0 };
      var norm = [];
      var raw = [];
      var i;
      for (i = 0; i < blocks.length; i++) {
        // E-2.3: «ядро» блока (coreText) — разметка не влияет на сравнение.
        norm.push(coreText(blocks[i]));
        raw.push(isRawMarkdownBlock(blocks[i]));
      }
      var drop = {};
      // ВАЖНО: карты «уже видели» без прототипа. Обычный {} наследует Object.prototype,
      // поэтому блок с текстом 'constructor'/'toString' ложно считался дублем (и наоборот,
      // ключ терялся) — история портилась.
      var seen = Object.create(null);
      // Проход 1: внешне идентичные блоки — побеждает первое вхождение.
      // Порог длины здесь НЕ применяется: точный повтор блока — это дубль при любой
      // длине (короткие блоки «Да.» дважды подряд не совпадают случайно).
      for (i = 0; i < blocks.length; i++) {
        // Пустой блок (лишние переводы строк) — не дубль и ничьим дублем быть не может:
        // он вообще не регистрируется в карте «виденных».
        if (!norm[i]) continue;
        if (seen[norm[i]]) { drop[i] = true; removedBlocks++; continue; }
        seen[norm[i]] = true;
      }
      // Проход 2: сырой markdown, дублирующий отрендеренный текст (другая разметка —
      // «ядра» блоков не совпадают, сравнение идёт по coreOfBlock: блок без строк-
      // заголовков, marker-insensitive). Совпадение = ядро равно отрендеренному блоку,
      // содержится в нём или содержит его (сырой блок бывает длиннее — UI показывает не
      // все секции).
      // Порог INTRA_CORE_MIN_LEN отсекает короткие служебные блоки при сравнении ПО
      // ВХОЖДЕНИЮ (короткое ядро случайно «содержится» в чужом тексте). Точные совпадения
      // и посекционная чистка (E-2.2) идут ДО этого порога: там сравниваются ядра целиком,
      // и короткие секции-копии — такие же дубли.
      var seenCore = Object.create(null);
      var cores = [];
      for (i = 0; i < blocks.length; i++) {
        cores.push(coreOfBlock(blocks[i]));
        if (drop[i] || raw[i] || !norm[i]) continue;
        // Ключом служит ЯДРО блока (E-2.3): маркерная копия отрендеренного текста
        // ('### ROLE…' + текст) тоже попадает сюда по своему ядру.
        if (cores[i]) seenCore[cores[i]] = true;
      }
      // Ядро сырого блока дублирует отрендеренный текст? Сравнение по ядру с порогом
      // длины; при minLen=0 порог не применяется (посекционная чистка).
      function coreDup(core, selfIdx, minLen) {
        if (!core) return false;
        if (seenCore[core]) return true;
        if (core.length < minLen) return false;
        for (var q = 0; q < blocks.length; q++) {
          if (q === selfIdx || drop[q] || raw[q] || !norm[q]) continue;
          if (intraBlocksSimilar(core, blocks[q])) return true;
        }
        return false;
      }
      for (i = 0; i < blocks.length; i++) {
        if (drop[i] || !raw[i]) continue;
        if (coreDup(cores[i], i, INTRA_CORE_MIN_LEN)) { drop[i] = true; removedBlocks++; continue; }
        // E-2.2: ядро по ВСЕМУ блоку не совпало. В живом экспорте сырой блок склеен из
        // НЕСКОЛЬКИХ секций ('### ROLE & OBJECTIVE', '### CONSTRAINTS', …), и одна из них
        // (обычно первая) несёт копию отрендеренного текста, а остальные — собственное
        // содержимое. Поэтому чистим ПОСЕКЦИОННО: ведущая копия вырезается из тела секции,
        // остаток секции остаётся со своим заголовком (markdown цел); секция, целиком
        // состоящая из копии, удаляется. Если копий не нашлось — блок не трогаем.
        var secs = splitRawSections(blocks[i]);
        var folded = renderedBeforeRaw(blocks, i, raw);
        if (folded === null) continue; // отрендеренной копии нет — не пересобираем
        var cutSecs = 0;
        var keptSecs = [];
        for (var s = 0; s < secs.length; s++) {
          if (coreDup(coreOfBlock(secs[s]), i, 0)) { cutSecs++; continue; }
          var cut = cutLeadingCopy(secs[s], folded);
          if (cut === null) { cutSecs++; continue; }   // вся секция — копия промпта
          if (cut.trimmed) cutSecs++;
          keptSecs.push(cut.text);
        }
        if (cutSecs === 0) continue;
        removedBlocks += cutSecs;
        if (keptSecs.length === 0) { drop[i] = true; continue; }
        // Копия отрендеренного текста остаётся РОВНО ОДНА — та, что уже стоит отдельным
        // блоком перед сырым; пересобираем блок только из выживших секций.
        blocks[i] = keptSecs.join(sepForSections(blocks[i])).replace(/^\n+/, '');
        norm[i] = coreText(blocks[i]);
        cores[i] = coreOfBlock(blocks[i]);
        raw[i] = isRawMarkdownBlock(blocks[i]);
      }
      // Проход 3: приоритет отрендеренного текста. Если отрендеренный дубль идёт ПОСЛЕ
      // сырого блока, сырой выживает первым — снимаем его и оставляем отрендеренный ниже.
      for (i = 0; i < blocks.length; i++) {
        if (drop[i] || !raw[i]) continue;
        var coreRaw = cores[i];
        if (coreRaw.length < INTRA_CORE_MIN_LEN) continue;
        for (var j = i + 1; j < blocks.length; j++) {
          if (drop[j] || raw[j]) continue;
          if (intraBlocksSimilar(coreRaw, blocks[j])) {
            drop[i] = true;
            removedBlocks++;
            break;
          }
        }
      }
      if (removedBlocks === 0) return { text: text, removedBlocks: 0 };
      var kept = [];
      for (i = 0; i < blocks.length; i++) { if (!drop[i]) kept.push(blocks[i]); }
      return { text: kept.join('\n\n'), removedBlocks: removedBlocks };
    } catch (e) { }
    return { text: text, removedBlocks: 0 };
  }

  /** Ядро блока — текст без строк-заголовков '#'+ (E-2.3: заголовок любого уровня):
   *  по нему сырой markdown-блок сопоставляется с его отрендеренной копией. */
  function coreOfBlock(block) {
    try {
      var lines = String(block == null ? '' : block).split('\n');
      var kept = [];
      for (var i = 0; i < lines.length; i++) {
        if (RE_RAW_HEADING_LINE.test(lines[i])) continue;
        kept.push(lines[i]);
      }
      return coreText(kept.join('\n'));
    } catch (e) { return coreText(block); }
  }

  // ===================== v1.18 (E-2.2): сырые копии промпта МЕЖДУ сообщениями =====================
  // Живой Deep Research (conv 72c88213f2e812e1) раскладывает ОДИН И ТОТ ЖЕ сырой
  // markdown-промпт по РАЗНЫМ сообщениям истории: пузырь реплики (user) и карточка плана
  // (assistant), причём внутри карточки он лежит ещё и вторым блоком. Внутри-сообщенческий
  // этап (dedupeIntraMessage) такие копии не видит в принципе: он сравнивает «сырой блок
  // против ОТРЕНДЕРЕННОГО» внутри одного хода, а здесь сырой блок дублирует сырой блок из
  // ДРУГОГО сообщения — и ВСЕ блоки обоих сообщений сырые (в самом промпте есть '### '),
  // поэтому ни один его проход (seenCore/coreDup/renderedBeforeRaw/pass 3) не срабатывает.
  // Правило: сырой markdown-блок, чьи «ядра» строк (E-2.3: coreOfLine — без разметки)
  // уже целиком встречались в ранее оставленном сыром блоке (равенство, суффикс или
  // префикс), — копия. Копия вырезается, а собственный остаток блока остаётся: у карточки
  // плана это её текст («Вот план исследования…»), у промпта — первое вхождение (пузырь).
  // Пороги не дают случайному совпадению одной короткой строки («Готово.») резать блок:
  // копия — это минимум 2 непустые строки (заголовок + тело) И не меньше 80 символов.
  var CROSS_RAW_MIN_LINES = 2;
  var CROSS_RAW_MIN_CHARS = 80;

  /** E-2.3: строки блока двумя параллельными массивами — «ядра» (сравнение копий НЕ
   *  зависит от разметки) и ИСХОДНЫЕ строки (именно они попадают в пересобранный блок,
   *  поэтому markdown выжившего остатка не деградирует). Пустые ядра по краям снимаются.
   *  NBSP-разделитель абзацев живого экспорта обрабатывает coreOfLine (deSpaceAny). */
  function blockLinePair(block) {
    var raw = deSpaceAny(block).split('\n');
    var core = [];
    for (var i = 0; i < raw.length; i++) core.push(coreOfLine(raw[i]));
    return trimPairEdges(raw, core);
  }
  function trimPairEdges(raw, core) {
    var a = 0, b = raw.length;
    while (a < b && !core[a]) a++;
    while (b > a && !core[b - 1]) b--;
    return { raw: raw.slice(a, b), core: core.slice(a, b) };
  }
  function cutPairHead(pair, n) {
    return trimPairEdges(pair.raw.slice(n), pair.core.slice(n));
  }
  function cutPairTail(pair, n) {
    var k = pair.raw.length - n;
    return trimPairEdges(pair.raw.slice(0, k), pair.core.slice(0, k));
  }
  /** Убрать пустые строки по краям (внутренние сохраняются). */
  function trimEdgeEmpty(lines) {
    var a = lines.slice();
    while (a.length && !a[0]) a.shift();
    while (a.length && !a[a.length - 1]) a.pop();
    return a;
  }
  function seqEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
    return true;
  }
  function seqIsPrefix(shortArr, longArr) {
    if (!shortArr.length || shortArr.length >= longArr.length) return false;
    for (var i = 0; i < shortArr.length; i++) { if (shortArr[i] !== longArr[i]) return false; }
    return true;
  }
  function seqIsSuffix(shortArr, longArr) {
    if (!shortArr.length || shortArr.length >= longArr.length) return false;
    var off = longArr.length - shortArr.length;
    for (var i = 0; i < shortArr.length; i++) { if (shortArr[i] !== longArr[off + i]) return false; }
    return true;
  }
  /** Копия «существенна»: минимум CROSS_RAW_MIN_LINES непустых строк И CROSS_RAW_MIN_CHARS
   *  символов — иначе это случайное совпадение короткой строки, а не размноженный промпт. */
  function crossCopyIsSubstantial(lines) {
    var ls = trimEdgeEmpty(lines);
    var nonEmpty = 0;
    var chars = 0;
    for (var i = 0; i < ls.length; i++) {
      if (!ls[i]) continue;
      nonEmpty++;
      chars += ls[i].length;
    }
    return nonEmpty >= CROSS_RAW_MIN_LINES && chars >= CROSS_RAW_MIN_CHARS;
  }

  /**
   * E-2.2: снять сырые markdown-копии промпта, разложенные по РАЗНЫМ сообщениям истории.
   * Сообщения не удаляются и порядок не меняется (индексы id у потребителя сохраняются):
   * режется только текст-копия внутри блока. Блок, из которого вырезана копия, остаётся
   * своим остатком; блок, целиком состоящий из копии, удаляется.
   * Чистая функция: возвращает { messages, removed } — без логов и побочных эффектов.
   */
  function dedupeCrossRawCopies(messages) {
    var out = [];
    var removed = 0;
    var refs = [];   // нормализованные строки уже оставленных СЫРЫХ блоков (эталоны копий)
    try {
      var src = Array.isArray(messages) ? messages : [];
      for (var i = 0; i < src.length; i++) {
        var m = src[i] || {};
        var text = (typeof m.text === 'string') ? m.text : '';
        if (!text) { out.push(m); continue; }
        var blocks = separateRawBlocks(text).split(/\n{2,}/);
        var keptBlocks = [];
        var touched = false;
        for (var b = 0; b < blocks.length; b++) {
          // Кандидат — только СЫРОЙ markdown-блок: обычный текст чатов не трогаем вовсе.
          if (!isRawMarkdownBlock(blocks[b])) { keptBlocks.push(blocks[b]); continue; }
          var pair = blockLinePair(blocks[b]);
          var origJoin = pair.raw.join('\n');
          var dropped = false;
          var changed = true;
          while (changed && !dropped) {
            changed = false;
            for (var r = 0; r < refs.length; r++) {
              var ref = refs[r];
              if (seqEqual(ref, pair.core)) {
                // точный повтор блока: копия — только если она «существенна»
                if (!crossCopyIsSubstantial(ref)) continue;
                dropped = true;
                removed++;
                break;
              }
              if (seqIsSuffix(ref, pair.core) && crossCopyIsSubstantial(ref)) {
                pair = cutPairTail(pair, ref.length);
                changed = true;
                break;
              }
              if (seqIsPrefix(ref, pair.core) && crossCopyIsSubstantial(ref)) {
                pair = cutPairHead(pair, ref.length);
                changed = true;
                break;
              }
            }
            if (!dropped && !pair.raw.length) { dropped = true; removed++; }
          }
          if (dropped || !pair.raw.length) { touched = true; continue; }
          var rebuilt = pair.raw.join('\n');
          if (rebuilt !== origJoin) touched = true;
          keptBlocks.push(rebuilt);
          if (isRawMarkdownBlock(rebuilt)) refs.push(pair.core);
        }
        // Ничего не резали — отдаём ИСХОДНЫЙ текст сообщения байт-в-байт (никакой
        // нормализации переводов строк и разделителей блоков для чужих путей).
        var keep = { role: (m.role === 'user') ? 'user' : 'assistant', text: touched ? keptBlocks.join('\n\n') : text };
        if (m.id != null) keep.id = m.id;
        out.push(keep);
      }
    } catch (e) {
      return { messages: Array.isArray(messages) ? messages : [], removed: 0 };
    }
    return { messages: out, removed: removed };
  }

  /**
   * E-2.1: единая точка подготовки массива сообщений к экспорту. Порядок жёсткий:
   *   1) normalizeExportMessages — нормализация к [{role, text}] (если массив ещё сырой);
   *   2) dedupeIntraMessage — ВНУТРИ-сообщенческая дедупликация (отрендеренный текст
   *      против сырого markdown-блока в ОДНОМ сообщении);
   *   3) dedupeMessages — меж-сообщенческая дедупликация (дубли по разным узлам/ходам);
   *   4) dedupeCrossRawCopies — E-2.2: сырые markdown-копии промпта, разложенные по РАЗНЫМ
   *      сообщениям (пузырь реплики + карточка плана), — остаётся первое вхождение, а
   *      собственный текст блока («Вот план исследования…») сохраняется;
   *   5) E-2.3: stripMarkerResidue — в выходе не остаётся строк-остатков из одних '#'.
   * Все сравнения этапов 2–4 идут по «ядру» контента (coreText/coreOfBlock): форматная
   * разметка (любое количество '#', '*', '_', '`', '>', маркеры списков, code-fences, NBSP)
   * не влияет на вердикт дедупа.
   * Логирование вынесено наружу (onMessageDedupe callback): чистая функция остаётся
   * чистой, а гейт сервиса и антиспам-подпись живут в вызывающем коде (core/content.js).
   * Возвращает { messages, intraRemoved, removed, crossRemoved }.
   */
  function prepareExportMessages(raw, onMessageDedupe) {
    var intraRemoved = 0;
    var out = [];
    try {
      var src = Array.isArray(raw) ? raw : [];
      for (var i = 0; i < src.length; i++) {
        var m = src[i] || {};
        var role = (m.role === 'user') ? 'user' : 'assistant';
        var text = (typeof m.text === 'string') ? m.text : '';
        var res = dedupeIntraMessage({ role: role, text: text });
        var next = { role: role, text: res.text };
        if (m.id != null) next.id = m.id;
        out.push(next);
        if (res.removedBlocks > 0) {
          intraRemoved += res.removedBlocks;
          if (typeof onMessageDedupe === 'function') {
            try { onMessageDedupe(role, res.removedBlocks); } catch (eCb) { }
          }
        }
      }
    } catch (e) { out = Array.isArray(raw) ? raw : []; intraRemoved = 0; }
    var inter = dedupeMessages(out);
    // E-2.2: третий этап — сырые копии промпта МЕЖДУ сообщениями (пузырь реплики + карточка
    // плана Deep Research). Счётчик вырезанных копий суммируется в removed: потребитель
    // (core/content.js: aiCmLogDedupeRemoved) логирует именно его.
    var cross = dedupeCrossRawCopies(inter.messages);
    // E-2.3: финальная гигиена ВЫХОДА — в тексте экспорта не должно остаться строк-остатков
    // разметки (одни '#', '##', '###'): маркер вырезанного raw-заголовка удаляется целиком,
    // включая оставшиеся символы решётки. Сообщения без таких строк сохраняются БАЙТОВО,
    // порядок/роли/id и счётчики removed не меняются.
    var cleaned = [];
    for (var k = 0; k < cross.messages.length; k++) {
      var mk = cross.messages[k] || {};
      var clean = {
        role: (mk.role === 'user') ? 'user' : 'assistant',
        text: stripMarkerResidue(typeof mk.text === 'string' ? mk.text : '')
      };
      if (mk.id != null) clean.id = mk.id;
      cleaned.push(clean);
    }
    return {
      messages: cleaned,
      intraRemoved: intraRemoved,
      removed: inter.removed + cross.removed,
      crossRemoved: cross.removed
    };
  }

  // =====================================================================================
  // O-20: САНАЦИЯ ИНЪЕКЦИЙ СТОРОННИХ РАСШИРЕНИЙ В ТЕКСТЕ ЭКСПОРТА (DeepSeek++).
  // Соседнее расширение DeepSeek++ дописывает в user-промпт memory-преамбулу и тул-схему
  // («Tool call format reminder:» / «Available tool tag names:»), а ВИДИМЫЙ пользователю
  // текст оборачивает парой HTML-комментариев:
  //   <!-- deepseek-pp-visible-user-prompt:start -->
  //   <видимый текст>
  //   <!-- deepseek-pp-visible-user-prompt:end -->
  // Локальный снимок серверной истории тянет эти инъекции в файл экспорта. Санация —
  // ТОЛЬКО на выходе экспорта: база/метрики (lastBaseTexts, aiCmBasePrepared, baseText),
  // serverTokens, turnsMap, бейдж и поля tokens/percent/limit НЕ пересчитываются
  // (серверная правда контекста).
  // Правило одно и жёсткое: РОВНО ОДНА пара маркеров → trim текста между ними; любое
  // отклонение (маркеров нет / пар больше одной / пара неполная или перевёрнутая / только
  // value-форма) → строка возвращается БАЙТОВО без изменений.
  // =====================================================================================
  var VISIBLE_USER_PROMPT_START = '<!-- deepseek-pp-visible-user-prompt:start -->';
  var VISIBLE_USER_PROMPT_END = '<!-- deepseek-pp-visible-user-prompt:end -->';
  var VISIBLE_USER_PROMPT_VALUE = '<!-- deepseek-pp-visible-user-prompt:value=';

  /** Сколько раз маркер встречается в строке (без регулярок — только чтение). */
  function countMarker(text, marker) {
    var n = 0;
    var at = text.indexOf(marker);
    while (at !== -1) { n++; at = text.indexOf(marker, at + marker.length); }
    return n;
  }

  /**
   * O-20: причина пропуска санации (в строке НЕ ровно одна пара маркеров) или null,
   * если санация применима. Причины — для одной диагностической строки вызывающего кода:
   *   'no-markers'       — маркеров нет вовсе (обычный текст чата);
   *   'unpaired-markers' — маркер есть, пары нет (start без end, end без start, end раньше start);
   *   'multiple-pairs'   — пар больше одной (пользователь сам написал маркеры);
   *   'value-only'       — только value-форма <!-- …:value=… -->, пары start/end нет.
   * Чистая функция: строку не меняет.
   */
  function injectedUserTextSkipReason(text) {
    var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
    var starts = countMarker(s, VISIBLE_USER_PROMPT_START);
    var ends = countMarker(s, VISIBLE_USER_PROMPT_END);
    if (starts === 0 && ends === 0) {
      return (s.indexOf(VISIBLE_USER_PROMPT_VALUE) !== -1) ? 'value-only' : 'no-markers';
    }
    if (starts === 1 && ends === 1) {
      return (s.indexOf(VISIBLE_USER_PROMPT_END) < s.indexOf(VISIBLE_USER_PROMPT_START))
        ? 'unpaired-markers' : null;
    }
    if (starts > 1 || ends > 1) return 'multiple-pairs';
    return 'unpaired-markers';
  }

  /**
   * O-20: санация user-текста. РОВНО одна пара маркеров start/end → trim(текст между ними);
   * иначе — исходная строка БАЙТОВО. Чистая функция: без логов и побочных эффектов.
   */
  function sanitizeInjectedUserText(text) {
    var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
    if (injectedUserTextSkipReason(s) !== null) return s;
    var from = s.indexOf(VISIBLE_USER_PROMPT_START) + VISIBLE_USER_PROMPT_START.length;
    var to = s.indexOf(VISIBLE_USER_PROMPT_END, from);
    return s.slice(from, to).trim();
  }

  /**
   * O-20: санация массива сообщений экспорта. Трогается ТОЛЬКО role=user: assistant и
   * user-сообщения без ровно одной пары маркеров возвращаются ТЕМИ ЖЕ объектами (байтово,
   * id и прочие поля сохранены). У изменённого сообщения текст заменён видимым текстом,
   * остальные поля скопированы.
   * Возвращает { messages, sanitized, skipped } (skipped — причины пропуска по порядку
   * сообщений). Логирование вынесено наружу: чистая функция остаётся чистой, а гейт
   * aiCmDebug и антиспам-подпись живут в вызывающем коде (core/export-manager.js).
   */
  function sanitizeEmitMessages(messages) {
    var out = [];
    var sanitized = 0;
    var skipped = [];
    try {
      var src = Array.isArray(messages) ? messages : [];
      for (var i = 0; i < src.length; i++) {
        var m = src[i];
        if (!m || typeof m !== 'object') { out.push(m); continue; }
        if (m.role !== 'user') { out.push(m); continue; }
        var text = (typeof m.text === 'string') ? m.text : '';
        var reason = injectedUserTextSkipReason(text);
        if (reason !== null) { skipped.push(reason); out.push(m); continue; }
        var keep = {};
        for (var k in m) {
          if (Object.prototype.hasOwnProperty.call(m, k)) keep[k] = m[k];
        }
        keep.role = 'user';
        keep.text = sanitizeInjectedUserText(text);
        out.push(keep);
        sanitized++;
      }
    } catch (e) {
      return { messages: Array.isArray(messages) ? messages : [], sanitized: 0, skipped: [] };
    }
    return { messages: out, sanitized: sanitized, skipped: skipped };
  }

  /**
   * v1.6 (D18): объединение ходов тейпа по id — union(existing, incoming) без дублей.
   * tape-save пишет ОБЪЕДИНЕНИЕ существующего тейпа и текущей базы: msgs никогда
   * не меньше прежнего (контент старших ходов не уничтожается при хвостовом окне).
   * Порядок: сначала существующие (порядок тейпа), затем новые из базы.
   */
  function unionTurnsById(existing, incoming) {
    var seen = {};
    var out = [];
    var i, t;
    for (i = 0; existing && i < existing.length; i++) {
      t = existing[i];
      if (!t || t.id == null || seen[t.id]) continue;
      seen[t.id] = true;
      out.push(t);
    }
    for (i = 0; incoming && i < incoming.length; i++) {
      t = incoming[i];
      if (!t || t.id == null || seen[t.id]) continue;
      seen[t.id] = true;
      out.push(t);
    }
    return out;
  }

  var Api = {
    buildAutoExportFileName: buildAutoExportFileName,
    disambiguateFileName: disambiguateFileName,
    isFileNameTaken: isFileNameTaken,
    buildExportFileName: buildExportFileName,
    buildGsaExportFileName: buildGsaExportFileName,
    resolveAutoExportConvId: resolveAutoExportConvId,
    notCompleteReason: notCompleteReason,
    shouldSkipAutoExport: shouldSkipAutoExport,
    effectiveAutoExportThreshold: effectiveAutoExportThreshold,
    pickExportSource: pickExportSource,
    resolveExportSource: resolveExportSource,
    markAutoExportFired: markAutoExportFired,
    getAutoExportFired: getAutoExportFired,
    resetAutoExportFired: resetAutoExportFired,
    firedSessionKey: firedSessionKey,
    isFiredInSession: isFiredInSession,
    sessionFiredPatch: sessionFiredPatch,
    extractConvIdFromUrl: extractConvIdFromUrl,
    normalizeExportMessages: normalizeExportMessages,
    coreText: coreText,
    stripMarkerResidue: stripMarkerResidue,
    dedupeMessages: dedupeMessages,
    dedupeIntraMessage: dedupeIntraMessage,
    dedupeCrossRawCopies: dedupeCrossRawCopies,
    separateRawBlocks: separateRawBlocks,
    prepareExportMessages: prepareExportMessages,
    sanitizeInjectedUserText: sanitizeInjectedUserText,
    injectedUserTextSkipReason: injectedUserTextSkipReason,
    sanitizeEmitMessages: sanitizeEmitMessages,
    unionTurnsById: unionTurnsById,
    latchKey: latchKey
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmExportEmitPipeline = Api;
})();
