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
 *   - shouldSkipGsaPageGuard(state) — O-27 (b/c): признак чат-страницы GSA + непустая база
 *     для гейта (страница captcha/«подозрительный трафик» права на файл не даёт)
 *   - shouldSkipAutoExport(state) — чистый гейт автоэкспорта
 *   - shouldSkipBaseCompleteTrigger(state) — O-36 (D3): порог для ВТОРОГО триггера
 *     автоэкспорта (base-complete от loader-state) — тот же порог, что у порогового пути
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
 *   - sanitizeBetterDeepSeekText(text) — O-40: инъекции СОСЕДНЕГО расширения Better
 *     DeepSeek прочь из экспорта. Таблица измеренных форм (BDS_INJECTION_FORMS: id, опорная
 *     строка, основание — номера строк артефакта владельца): блок '<BetterDeepSeek>' +
 *     измеренная опорная строка снимается целиком — до строки '</BetterDeepSeek>' либо (у
 *     усечённого эха задачи) до маркера '...[truncated]'; обёртка без измеренной формы
 *     (реальный текст пользователя) теряет ТОЛЬКО строки тегов. Текст без измеренных форм
 *     возвращается БАЙТОВО; целое сообщение-инжекция после вырезки пусто → снимается S5
 *   - sanitizeToolContinuationText(text) — O-42: агентный конверт СОСЕДНЕГО расширения
 *     Better DeepSeek (tool-continuation) прочь из экспорта. Таблица измеренных дескрипторов
 *     конверта (TC_ENVELOPE_FORMS: id, опорные строки, правило границы, основание — номера
 *     строк артефакта владельца): запрос тула '<local_file_read>…</local_file_read>'
 *     (самостоятельный машинный ход), проза-якорь «These are the tool results just executed
 *     for the tool-continuation task.», эхо '<original_task>…</original_task>' (включая пустую
 *     пару) и блок '<tool_results>…</tool_results>' — конверт-ход распознаётся по строке-якорю
 *     и снимается ЦЕЛИКОМ (от якоря до закрывающего тега результатов); конверт-спан внутри
 *     сообщения теряет только свои строки, окружающий текст — байтово. Текст без измеренных
 *     форм возвращается БАЙТОВО; целое сообщение-конверт после вырезки пусто → снимается S5
 *   - stripReasoningSections(text) — O-7 (OFF): урезание сетевых секций
 *     [REASONING]…[ANSWER]… до части [ANSWER] (маркеры убираются). Трогает ТОЛЬКО тексты
 *     с парой маркеров, идемпотентна; в БАЗЕ секции остаются — урезание только на выходе
 *     экспорта (sanitizeEmitMessages, OFF-путь тумблера aiCmIncludeHiddenInExport)
 *   - splitReasoningSections(text) — O-37 (C): ОБРАТНОЕ преобразование той же пары в
 *     отдельные поля { reasoning, answer } (без пары — { reasoning:'', answer: текст }
 *     байтово). Нужно точке сбора экспорта: размышление сервиса БЕЗ сети (живой источник —
 *     DOM-адаптер) уходит рендеру отдельным полем ДО OFF-урезания секций
 *   - isToolResultsOnlyText(text) / stripToolCallBlocks(text) — O-7 (OFF, S3/S4):
 *     служебный тул-мусор DeepSeek++ прочь из экспорта. S3: user-ход, ЦЕЛИКОМ состоящий
 *     из [TOOL_RESULTS]…[/TOOL_RESULTS] (+ необязательный хвост 'Continue answering based
 *     on the tool results above.'), из массива удаляется; S4: в текстах ассистента
 *     вырезаются парные XML-блоки вызовов тулов (18 browser_*, 3 memory_*, web_search,
 *     web_fetch, семейства shell_, python_, skill_; нежадно, с атрибутами); S5: сообщение
 *     без текста после S3/S4 в экспорт не идёт (см. sanitizeEmitMessages)
 *   - includeHiddenExportBlocks(messages) — O-7: СЫРОЙ режим экспорта (тумблер ON):
 *     hidden-reasoning DeepSeek (поле захвата hiddenReasoning, в text НЕ входит) уходит
 *     в текст сообщения ОТДЕЛЬНЫМ блоком с пометкой [REASONING]…[ANSWER]…; уже
 *     присутствующий в тексте reasoning не дублируется. stripHiddenFields — снятие
 *     служебных полей захвата в OFF-пути (в экспорт они не идут)
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
   * O-27 (b/c): признак ЧАТ-страницы GSA для гейта автоэкспорта. Сервисная страница Google
   * (captcha / «подозрительный трафик», /sorry) чатом не является: threadId в DOM не
   * снаффнут и чат-контейнера нет. Если на такой странице осталось состояние ПРОШЛОГО
   * документа (база/pct), права на файл оно не даёт.
   * state: { site, chatPageMarker, msgCount, baseTextLen } — поля опциональны:
   *   - site !== 'google_search' → гейт не применяется (прочие сервисы 1:1);
   *   - поле не передано (undefined) → вердикта не меняет (обратная совместимость
   *     с прежними вызовами и песочницами);
   *   - chatPageMarker === false → страница без чата (threadId НЕ снаффнут и
   *     чат-контейнера в DOM нет) → 'not-chat-page';
   *   - msgCount < 1 → 'no-messages' (база пуста: файл писать не из чего);
   *   - baseTextLen < 1 → 'empty-base' (текст базы пуст).
   * Возврат: { skip, reason }.
   */
  function shouldSkipGsaPageGuard(state) {
    var s = state || {};
    if (s.site !== 'google_search') return { skip: false, reason: null };
    if (s.chatPageMarker === false) return { skip: true, reason: 'not-chat-page' };
    if (typeof s.msgCount === 'number' && s.msgCount < 1) return { skip: true, reason: 'no-messages' };
    if (typeof s.baseTextLen === 'number' && s.baseTextLen < 1) return { skip: true, reason: 'empty-base' };
    return { skip: false, reason: null };
  }

  /**
   * Чистый гейт автоэкспорта. state:
   *   { enabled, percentage, threshold, baseComplete, baseSeen, loaderRunning, fired, isGemini,
   *     archiveCount, baseCount, domBaseTrusted }
   * archiveCount/baseCount (T1-fix#2, v1.16.2) опциональны: не переданы — прежнее поведение.
   * O-37 (A): domBaseTrusted — база, объявленная ДОСТОВЕРНОЙ своим единственным источником
   * (сервис без сети: единственный DESIGN-источник — DOM-адаптер, O-35/v54). Поле опционально и
   * по умолчанию отсутствует: решение «чей это сайт» принимает ВЫЗЫВАЮЩИЙ (content.js-предикат
   * aiCmAutoExportTrustedBase), поэтому порядок причин и вердикты шести платформ байтово
   * прежние. domBaseTrusted === true → база считается полной наравне с baseComplete И причиной
   * base-pending не блокируется (у такого сервиса сетевого снимка не будет никогда).
   * O-27 (b/c): site + chatPageMarker/msgCount/baseTextLen — тот же принцип (см.
   * shouldSkipGsaPageGuard): не переданы — вердикта не меняют.
   * O-33: не-Gemini без сетевого снимка (baseSeen=false) — причина base-pending
   * (частичная DOM-база права на файл не даёт); латч fired при ней не ставится и не
   * сбрасывается (resetFired:false), см. таблицу причин ниже.
   * O-43: gsaNetworkCompleteLatch — МОНОТОННЫЙ латч сетевой полноты GSA (поле опционально,
   * по умолчанию отсутствует). baseComplete — транзиентная переменная: сетевой эмит с
   * historyComplete=true (probe-классификатор folwr) перекрывается последующими эмитами
   * ТОГО ЖЕ треда с historyComplete=0, и файл либо не пишется вовсе, либо (до O-33) уходил по
   * memory-базе на 262–504 мс раньше сети. Латч взводится приёмом полного снимка и НЕ снимается
   * регрессией вердикта, поэтому gsaNetworkCompleteLatch === true → база считается полной
   * наравне с baseComplete. Поле передаёт ВЫЗЫВАЮЩИЙ (export-manager.js — только для
   * site === 'google_search'); не передано → вердикты шести платформ байтово прежние.
   * Возвращает { skip, reason, resetFired }. Порядок гейтов повторяет
   * существующий maybeAutoExport (v30.5/v42/гистерезис −10 п.п.).
   * Причины (условие → reason):
   *   enabled !== true                       → not-enabled;
   *   pct не число / < 0                     → no-pct;
   *   GSA-страница без чата/базы (O-27)      → not-chat-page | no-messages | empty-base;
   *   Gemini baseComplete !== true           → not-complete;
   *   не-Gemini baseComplete !== true И
   *     baseSeen === true (частичная сеть)   → not-complete;
   *   не-Gemini baseComplete !== true И
   *     baseSeen === false И
   *     domBaseTrusted !== true (DOM-база)   → base-pending (O-33, ПОСЛЕ пороговых гейтов:
   *                                            при pct ниже порога причина прежняя);
   *   не-Gemini domBaseTrusted === true      → база готова по дизайну (O-37/A): base-pending
   *                                            НЕ возвращается, дальше решают порог и латч;
   *   pct < threshold − 10 (достоверный pct) → below-threshold-hysteresis (resetFired:true);
   *   pct < threshold − 10 (DOM-pct)         → below-threshold-unreliable;
   *   pct < threshold                        → below-threshold;
   *   fired                                  → already-fired.
   */
  function shouldSkipAutoExport(state) {
    var s = state || {};
    if (s.enabled !== true) return { skip: true, reason: 'not-enabled', resetFired: false };
    if (typeof s.percentage !== 'number' || !(s.percentage >= 0)) return { skip: true, reason: 'no-pct', resetFired: false };
    // O-27 (b/c): на не-чат странице GSA (captcha/«подозрительный трафик») база/pct прошлого
    // документа вердикта не дают: файл не пишется и латч fired не ставится (поздний честный
    // экспорт на настоящей чат-странице остаётся возможен). Прочие сайты — 1:1.
    var gsaPage = shouldSkipGsaPageGuard(s);
    if (gsaPage.skip) return { skip: true, reason: gsaPage.reason, resetFired: false };
    var threshold = (typeof s.threshold === 'number' && s.threshold >= 1 && s.threshold <= 100) ? s.threshold : 90;
    // Гейт полноты: полнота — ТОЛЬКО сетевой признак baseComplete (Gemini — как было).
    // O-33: дизъюнкт `!baseSeen ||` убран — DOM-база не-Gemini (baseSeen=false) до
    // сетевого снимка полнотой больше НЕ считается (файл уходил по частичной DOM-оценке).
    // O-37 (A): у сервиса БЕЗ сети единственный DESIGN-источник — DOM-адаптер (O-35):
    // база, объявленная достоверной вызывающим (domBaseTrusted), полнотой считается наравне
    // с сетевым baseComplete. Поле не передано → вердикты шести платформ байтово прежние.
    var domBaseTrusted = (s.domBaseTrusted === true);
    // O-43: монотонный латч сетевой полноты GSA. Поле опционально: отсутствует → false →
    // baseReady/basePending ровно прежние (вердикты прочих платформ не меняются).
    var networkCompleteLatch = (s.gsaNetworkCompleteLatch === true);
    var completeOk = (s.baseComplete === true) || networkCompleteLatch;
    // «База готова» — либо сетевая полнота (в т.ч. латч O-43), либо доверенная база адаптера (O-37/A).
    var baseReady = completeOk || domBaseTrusted;
    // O-33: не-Gemini без сетевого снимка — отдельная причина base-pending. Вердикт
    // откладывается ДО пороговых гейтов (ниже): при pct ниже порога причина прежняя
    // (below-threshold / below-threshold-unreliable) — новых строк лога не прибавляется.
    // O-37 (A): доверенная база адаптера (domBaseTrusted) причиной base-pending не блокируется.
    // O-43: взведённый латч полноты GSA — тоже (сеть по этому разговору базу уже отдала).
    var basePending = (s.isGemini !== true && s.baseSeen !== true && !domBaseTrusted && !networkCompleteLatch);
    if (!baseReady && !basePending) return { skip: true, reason: 'not-complete', resetFired: false };
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
    // O-33: все прочие гейты пройдены — файла нет ТОЛЬКО из-за DOM-базы до сетевого
    // снимка (pct — транзиентная DOM-оценка). Латч fired не ставится и не сбрасывается
    // (resetFired:false): поздний честный экспорт по полной сетевой базе состоится.
    // O-37 (A): доверенная база адаптера (domBaseTrusted) сюда не доходит — basePending
    // для неё false, поэтому гейт отдаёт already-fired/файл, а не base-pending.
    if (!baseReady && basePending) return { skip: true, reason: 'base-pending', resetFired: false };
    if (s.fired) return { skip: true, reason: 'already-fired', resetFired: false };
    return { skip: false, reason: null, resetFired: false };
  }

  /**
   * O-36 (D3): порог для ВТОРОГО триггера автоэкспорта — base-complete (loader-state, v64).
   *
   * Живой дефект (сообщение владельца 2026-09-19): при включённом автоэкспорте чат
   * выгружался при значении индикатора НИЖЕ установленного порога. Пороговый путь
   * (maybeAutoExport → shouldSkipAutoExport) порог проверял всегда, а второй триггер
   * (loader done + baseComplete=1 + pendingCursor=0 + msgs>0) уходил в
   * doAutoExportDownload МИМО порога: файл писался на каждом дозавершённом чате, в т.ч.
   * при pct=5 и пороге 90. Здесь — РОВНО та же ось порога, что у shouldSkipAutoExport
   * (per-site → глобальный → 90; сам shouldSkipAutoExport не тронут — его порядок причин и
   * вердикты запинованы), но причина называет срезанный триггер.
   *
   * state: { percentage, threshold } — percentage того же происхождения, что уходит в файл
   * (для второго триггера это последний достоверный pct индикатора). Возврат:
   * { skip, reason, threshold }:
   *   percentage не число / < 0 → no-pct (файла нет);
   *   percentage < threshold   → below-threshold-base-complete;
   *   иначе                    → skip:false.
   * Чистая функция: без логов и побочных эффектов, латч fired не ставит и не снимает.
   */
  function shouldSkipBaseCompleteTrigger(state) {
    var s = state || {};
    var threshold = (typeof s.threshold === 'number' && s.threshold >= 1 && s.threshold <= 100) ? s.threshold : 90;
    if (typeof s.percentage !== 'number' || !(s.percentage >= 0)) {
      return { skip: true, reason: 'no-pct', threshold: threshold };
    }
    if (s.percentage < threshold) {
      return { skip: true, reason: 'below-threshold-base-complete', threshold: threshold };
    }
    return { skip: false, reason: null, threshold: threshold };
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
   *   - роли: raw[i].role ('user' | 'human' → user, иначе assistant);
   *   - текст: raw[i].text || raw[i].content; пустые отбрасываются.
   * O-7: hidden-захват DOM-адаптера (hiddenReasoning — панель размышлений DeepSeek,
   * которую базовый текст НЕ несёт) едет РЯДОМ с текстом и в text НЕ входит: метрики
   * его не видят, а в экспорт он попадает только при включённом тумблере (см.
   * includeHiddenExportBlocks). Нет захвата — поле не появляется вовсе (байты прежние).
   */
  function normalizeExportMessages(raw) {
    var out = [];
    try {
      if (!Array.isArray(raw)) return out;
      for (var i = 0; i < raw.length; i++) {
        var m = raw[i] || {};
        var text = (typeof m.text === 'string') ? m.text : (typeof m.content === 'string' ? m.content : '');
        if (!text) continue;
        // FIX (Claude md): 'human' (парсер Claude) — та же роль пользователя, что 'user'.
        var norm = { role: (m.role === 'user' || m.role === 'human') ? 'user' : 'assistant', text: text };
        // Claude md (ДИАГНОСТИКА — только измерение под гейтом aiCmDebug): роль на входе
        // нормализации и роль на выходе. Канонический хелпер utils/debug.js:aiCmDiagLine;
        // хелпера нет (Node/срез-песочницы) или гейт выключен → ни одной строки.
        if (typeof aiCmDiagLine === 'function') {
          aiCmDiagLine('claude-role-normalize', { inputRole: m.role, outputRole: norm.role });
        }
        if (typeof m.hiddenReasoning === 'string' && m.hiddenReasoning) norm.hiddenReasoning = m.hiddenReasoning;
        out.push(norm);
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

  // =====================================================================================
  // O-40: ИНЖЕКЦИИ СОСЕДНЕГО РАСШИРЕНИЯ BETTER DEEPSEEK — ПРОЧЬ ИЗ ЭКСПОРТА.
  //
  // Живой дефект — артефакт владельца deepseek-565a7cd8-2026-09-20_11-40.txt (335 325 байт):
  // соседнее расширение Better DeepSeek шлёт свой системный промпт и служебные блоки в саму
  // переписку (user-сообщениями) и оборачивает их парой тегов <BetterDeepSeek>…</BetterDeepSeek>;
  // локальный снимок серверной истории тянет их в файл экспорта. Санация O-20 знает только
  // маркеры DeepSeek++ (deepseek-pp-visible-user-prompt) — блоки Better DeepSeek шли насквозь.
  //
  // ИЗМЕРЕННЫЕ формы (номера строк артефакта; «целое сообщение» / «спан внутри сообщения»):
  //   F1 bds-deep-code-prompt   1-257    ЦЕЛОЕ сообщение: <BetterDeepSeek> + '[DEEP_CODE_MODE_ACTIVE]'
  //      (тот же блок вложен СПАНОМ в эхо задачи: строки 999-1191 и 1223-1415; в эхе он усечён
  //       маркером '...[truncated]' — закрывающей строки тега там нет);
  //   F2 bds-tool-system-prompt 259-947  ЦЕЛОЕ сообщение: <BetterDeepSeek> + 'You are Better
  //      DeepSeek. You have access to specialized tools.' (тул-схема; хвост 'The system prompt
  //      has ended. User prompt:');
  //   F3 bds-prompt-wrapper     949-978  СПАН-ОБЁРТКА вокруг РЕАЛЬНОГО текста пользователя
  //      ('ИНСТРУКЦИЯ ДЛЯ ИИ-АРХИТЕКТОРА…'): снимаются РОВНО две строки тегов, текст
  //      пользователя между ними — байтово неизменен;
  //   F4 bds-system-datetime    980-982  ЦЕЛОЕ сообщение: <BetterDeepSeek> + "User's System
  //      Date & Time: …" (метка времени переменная — опора измерена как литеральный ПРЕФИКС
  //      строки 981).
  // Форма '[BDS:…](BDS:…)' (ссылка) в артефакте НЕ встречается — 0 вхождений, паттерн НЕ
  // заводится (никаких «разумных» обобщений по тегам <BDS:…>: они в артефакте есть ТОЛЬКО
  // внутри снятых форм F1/F2/F5/F6).
  //
  // Правило (одно, табличное): элемент Better DeepSeek = строка '<BetterDeepSeek>' (строка 0
  // файла — с BOM, артефакт начинается с U+FEFF), СЛЕДУЮЩАЯ строка которой совпадает с
  // опорной строкой одной из измеренных форм BDS_INJECTION_FORMS; блок снимается целиком — до
  // первой строки '</BetterDeepSeek>' либо до строки '...[truncated]'. Тег БЕЗ измеренной
  // формы снимается как ПАРА строк тегов; пара — измеренная форма F3 (обёртка вокруг реального
  // текста пользователя), и она снимается В ЛЮБОМ месте сообщения: и когда обёртывает целое
  // сообщение (F3 артефакта 949-978), и когда лежит внутри более длинного сообщения — текст до
  // открывающего тега (если есть) и хвост после закрывающего (живой симптом: k=1166,
  // firstLine=0, pair=1195, lastLine=1212) сохраняются БАЙТОВО, снимаются РОВНО две строки
  // тегов. Ничего не совпало (нет пары вовсе) → текст возвращается ТЕМ ЖЕ значением (байтово);
  // текст между снятыми строками тегов и вокруг пары — байтово.
  // Целое сообщение-инжекция после вырезки пусто → в экспорт не идёт по существующему S5
  // (isEmptyExportText), отдельного правила удаления сообщения не заводится.
  //
  // Паритет O-20: та же точка (sanitizeEmitMessages, OFF-путь тумблера aiCmIncludeHiddenInExport;
  // ON-путь — сырой режим, обходит и O-20, и O-40), новый тумблер НЕ добавляется; база
  // (lastBaseTexts/baseText/turnsMap), serverTokens, tokens/percent/limit, бейдж и метрики НЕ
  // пересчитываются. Локализация по сайту: теги Better DeepSeek существуют только на
  // chat.deepseek.com, а опоры — точные байтовые строки (не регулярки-обобщения), поэтому
  // прочие пять платформ не задеваются по построению (пин R: их байты прежние).
  // =====================================================================================
  var BDS_OPEN_TAG = '<BetterDeepSeek>';
  var BDS_CLOSE_TAG = '</BetterDeepSeek>';
  var BDS_TRUNCATION_MARK = '...[truncated]';
  var BDS_BOM = '\ufeff';

  // -------------------------------------------------------------------------------------
  // O-40 (ДИАГНОСТИКА — только ИЗМЕРЕНИЕ; поведение и байты не меняются): на живой симптом
  // «в txt-экспорте пара F3 жива, а модульный прогон на messages[i].text её снимает»
  // печатаются ровно две строки-наблюдения:
  //   o40-emit-msg — на КАЖДОЕ сообщение sanitizeEmitMessages: i, len текста на входе O-40,
  //                  head/tail по 40 символов (JSON-escaped), called (факт вызова
  //                  sanitizeBetterDeepSeekText) и её removed;
  //   o40-bds-line — на КАЖДУЮ строку-кандидат с открывающим тегом: k, firstLine, pair,
  //                  lastLine, распознанная форма и итог removed ЛИБО ТОЧНАЯ причина пропуска
  //                  (no-boundary | unpaired-tag). Пара тегов без измеренной формы (F3)
  //                  снимается в любом месте сообщения, поэтому причины пропуска
  //                  'pair-not-whole-message' у неё больше нет — она распознана как обёртка.
  // Печать — ТОЛЬКО существующим гейтом: каноническим хелпером utils/debug.js:aiCmDiagLine
  // (своего вывода в консоль и своего формата здесь нет). Хелпера нет (Node/срез-песочницы
  // тестов) или гейт aiCmDebug выключен → НИ ОДНОЙ строки; читаются только посчитанные
  // значения.
  // -------------------------------------------------------------------------------------
  function bdsDiagLine(tag, fields) {
    try {
      if (typeof aiCmDiagLine !== 'function') return false;
      return aiCmDiagLine(tag, fields) !== false;
    } catch (eDiag) { return false; }
  }

  /** JSON-escaped срез текста: from=0 — head (первые n символов), иначе tail (последние n). */
  function bdsDiagSlice(text, from, n) {
    try {
      var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
      return JSON.stringify((from === 0) ? s.slice(0, n) : s.slice(Math.max(0, s.length - n)));
    } catch (eSlice) { return '""'; }
  }

  // Таблица измеренных форм: id | опорная строка (match: 'exact' — строка целиком,
  // 'prefix' — литеральный префикс строки с переменным хвостом) | основание из артефакта.
  var BDS_INJECTION_FORMS = [
    {
      id: 'bds-deep-code-prompt',
      match: 'exact',
      head: '[DEEP_CODE_MODE_ACTIVE]',
      basis: 'artifact 1-257 (message), 999-1191 / 1223-1415 (span in <original_task>)'
    },
    {
      id: 'bds-tool-system-prompt',
      match: 'exact',
      head: 'You are Better DeepSeek. You have access to specialized tools.',
      basis: 'artifact 259-947 (message)'
    },
    {
      id: 'bds-system-datetime',
      match: 'prefix',
      head: "User's System Date & Time: ",
      basis: 'artifact 980-982 (message; line 981)'
    }
  ];
  // Обёртка без измеренной формы (реальный текст пользователя внутри) — F3.
  var BDS_WRAPPER_ID = 'bds-prompt-wrapper';

  /** Строка — ровно строка открывающего тега? (строка 0 артефакта несёт BOM файла). */
  function isBdsOpenTagLine(line, at) {
    if (line === BDS_OPEN_TAG) return true;
    return (at === 0 && line === BDS_BOM + BDS_OPEN_TAG);
  }

  /** Опорная строка измеренной формы (или null — форма не распознана). */
  function bdsFormOfHeadLine(line) {
    var s = (typeof line === 'string') ? line : '';
    for (var i = 0; i < BDS_INJECTION_FORMS.length; i++) {
      var f = BDS_INJECTION_FORMS[i];
      if (f.match === 'prefix') { if (s.slice(0, f.head.length) === f.head) return f; }
      else if (s === f.head) return f;
    }
    return null;
  }

  /** Индекс первой непустой строки текста (-1 — текста нет). */
  function bdsFirstContentLine(lines) {
    for (var i = 0; i < lines.length; i++) { if (String(lines[i]).trim() !== '') return i; }
    return -1;
  }

  /** Индекс последней непустой строки текста (-1 — текста нет). */
  function bdsLastContentLine(lines) {
    for (var i = lines.length - 1; i >= 0; i--) { if (String(lines[i]).trim() !== '') return i; }
    return -1;
  }

  /**
   * O-40: вырезать из текста измеренные элементы Better DeepSeek.
   * Возврат { text, removed, forms }: removed — число снятых элементов (измеренный блок — 1,
   * обёртка F3 — 1), forms — id снятых форм по порядку. Ничего не снято → тот же текст.
   * Значения не меняются: diag (o40-bds-line) только ЧИТАЕТ уже посчитанные k/firstLine/
   * pair/lastLine/форму/removed и печатается каноническим хелпером гейта aiCmDebug; без
   * хелпера или без гейта — ни одной строки. DOM и chrome функция не трогает; идемпотентна.
   */
  function sanitizeBetterDeepSeekText(text) {
    var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
    if (s.indexOf(BDS_OPEN_TAG) === -1) return { text: s, removed: 0, forms: [] };
    var lines = s.split('\n');
    var drop = {};
    var forms = [];
    // O-40 (диагностика): строки-кандидаты копятся и печатаются ОДНИМ залпом в конце —
    // только тогда в каждой строке есть ИТОГ removed. Хелпера гейта нет — массив не ведётся.
    var diagRows = (typeof aiCmDiagLine === 'function') ? [] : null;
    var firstLine = bdsFirstContentLine(lines);
    var lastLine = bdsLastContentLine(lines);
    for (var k = 0; k < lines.length; k++) {
      if (!isBdsOpenTagLine(lines[k], k)) continue;
      var form = (k + 1 < lines.length) ? bdsFormOfHeadLine(lines[k + 1]) : null;
      if (form) {
        // Границы блока: первая строка закрывающего тега ЛИБО маркер усечения эха.
        var end = -1;
        for (var j = k + 2; j < lines.length; j++) {
          if (isBdsOpenTagLine(lines[j], j)) break;   // вложенный/чужой открывающий тег — границы нет
          if (lines[j] === BDS_CLOSE_TAG || lines[j] === BDS_TRUNCATION_MARK) { end = j; break; }
        }
        if (end === -1) {                             // границы нет — текст не трогаем (байтово)
          if (diagRows) diagRows.push({ k: k, first: firstLine, pair: -1, last: lastLine, form: form.id, skip: 'no-boundary' });
          continue;
        }
        if (diagRows) diagRows.push({ k: k, first: firstLine, pair: end, last: lastLine, form: form.id, skip: '(нет)' });
        for (var d = k; d <= end; d++) drop[d] = true;
        forms.push(form.id);
        k = end;
        continue;
      }
      // Тег без измеренной формы: пара «открывающий … закрывающий» без вложенных тегов →
      // снимаются ТОЛЬКО строки тегов (F3: обёртка вокруг реального текста пользователя).
      // Паттерн — РОВНО измеренная форма: пара обёртывает текст пользователя. Срабатывает и
      // когда пара обёртывает ЦЕЛОЕ сообщение, и когда лежит ВНУТРИ более длинного сообщения
      // (текст до открывающего тега и/или хвост после закрывающего остаются байтово) —
      // живой симптом O-40: k=1166, firstLine=0, pair=1195, lastLine=1212.
      var pair = -1;
      for (var p = k + 1; p < lines.length; p++) {
        if (isBdsOpenTagLine(lines[p], p)) break;
        if (lines[p] === BDS_CLOSE_TAG) { pair = p; break; }
      }
      if (pair === -1) {                              // непарный тег — текст не трогаем (как O-20)
        if (diagRows) diagRows.push({ k: k, first: firstLine, pair: -1, last: lastLine, form: '(нет)', skip: 'unpaired-tag' });
        continue;
      }
      // Условия ветки: (а) открывающий тег распознан (условие цикла isBdsOpenTagLine);
      // (б) форма head-строки НЕ в таблице BDS_INJECTION_FORMS (form === null); (в) пара
      // найдена (pair !== -1); (г) пара НЕ обёртывает целое сообщение
      // (k !== firstLine || pair !== lastLine) — либо есть хвост после закрывающего тега,
      // либо текст до открывающего. Логика одна на оба случая: drop ТОЛЬКО строк тегов;
      // текст между ними и хвост не трогаются (байтово).
      if (diagRows) diagRows.push({ k: k, first: firstLine, pair: pair, last: lastLine, form: BDS_WRAPPER_ID, skip: '(нет)' });
      drop[k] = true;
      drop[pair] = true;
      forms.push(BDS_WRAPPER_ID);
      k = pair;
    }
    var removedTotal = forms.length;
    if (diagRows) {
      for (var r = 0; r < diagRows.length; r++) {
        bdsDiagLine('o40-bds-line', {
          k: diagRows[r].k, firstLine: diagRows[r].first, pair: diagRows[r].pair,
          lastLine: diagRows[r].last, form: diagRows[r].form, skip: diagRows[r].skip,
          removed: removedTotal
        });
      }
    }
    if (!forms.length) return { text: s, removed: 0, forms: [] };
    var kept = [];
    for (var m = 0; m < lines.length; m++) { if (!drop[m]) kept.push(lines[m]); }
    return { text: kept.join('\n'), removed: forms.length, forms: forms };
  }

  // =====================================================================================
  // O-42: АГЕНТНЫЙ КОНВЕРТ Better DeepSeek (tool-continuation) — ПРОЧЬ ИЗ ЭКСПОРТА (OFF).
  //
  // Живой дефект — артефакт владельца ai-context-monitor-deepseek-DeepSeek-R1-2026-09-21-10-19.json
  // (per-message границы; тот же конверт в txt-экспорте deepseek-565a7cd8-2026-09-21_15-40.txt:
  // 5 блоков <local_file_read>, 7 проза-блоков, 7 пар <original_task>, 14 тегов <tool_results> =
  // 7 пар): соседнее расширение Better DeepSeek гоняет агентный цикл через саму переписку, и в
  // файл экспорта уезжают МАШИННЫЕ ходы — (1) запрос тула <local_file_read>…</local_file_read>
  // (целое сообщение ассистента) и (2) ход-продолжение: проза-приглашение + эхо <original_task> +
  // результаты <tool_results>…</tool_results> (целое user-сообщение).
  //
  // ИЗМЕРЕННЫЕ формы (артефакт 10-19; номера строк ВНУТРИ сообщения; все 12 вхождений — ЦЕЛЫЕ
  // сообщения, спанов внутри сообщения в артефакте 0; усечений нет, незакрытых пар нет):
  //   A tc-local-file-read      msg 1/3/9/11/13 строки 1-3, role=assistant — 5 вхождений;
  //   B tc-prose-continuation   msg 2/4/7/8/10/12/14 строки 1-9 — 7 вхождений;
  //   C tc-original-task        msg 2/4 строки 11-12 (ПУСТАЯ пара), msg 7/8/10/12/14 строки
  //                             11-17 (эхо задачи) — 7 вхождений;
  //   D tc-tool-results         msg 2/4 строки 14-26 и 14-35, msg 7/8/10/12/14 строки 19-конец
  //                             (31/40/49/58/66 сообщения): закрывающий тег '…</tool_results>' —
  //                             последняя строка сообщения (7/7); незакрытых (конец сообщения без
  //                             закрывающего тега) — 0. Таблица дескрипторов — TC_ENVELOPE_FORMS.
  //
  // Правило (табличное; id | опорные строки | правило границы | основание): конверт-ход
  // распознаётся по измеренной строке-якорю (B), внутри распознанного хода снимается ЦЕЛЫЙ спан
  // конверта — от строки-якоря до конца последней распознанной измеренной формы (закрывающий тег
  // D). Целое сообщение-конверт после вырезки пусто → в экспорт не идёт по существующему S5;
  // конверт-спан внутри сообщения теряет ТОЛЬКО строки конверта, окружающий текст — БАЙТОВО.
  // Форма A (запрос тула) — самостоятельный машинный ход: пара снимается, когда она — ЦЕЛОЕ
  // сообщение (измеренная граница формы, 5/5). Спан пары внутри сообщения НЕ снимается: своего
  // измерения спана в артефакте нет (0 вхождений), а живые байты такого спана (F3-обёртка +
  // хвост-запрос в ОДНОМ сообщении) заморожены как сохраняемый текст — tests/deepseek-o40-…:1747
  // (D-F7), :2008 (R-F7-4, роль assistant) и tests/o40-f3-diag-…:474; по правилу «у формы нет
  // измеримой границы — не угадывать» спан остаётся байтово (старые ожидания не редактируются).
  // Незакрытая пара — границы нет: текст не трогаем (не угадываем).
  // Ничего не совпало → текст возвращается ТЕМ ЖЕ значением (байтово). Своего вывода у O-42 нет
  // вовсе (ни строки ни под гейтом aiCmDebug, ни без) — пины o40-emit-msg/o40-bds-line не сдвинуты.
  // Паритет O-20/O-40: та же точка (sanitizeEmitMessages, OFF-путь тумблера
  // aiCmIncludeHiddenInExport) и тот же OFF-путь; ON-путь (includeHiddenExportBlocks) конверт не
  // трогает вовсе; база (lastBaseTexts/baseText/turnsMap), serverTokens, tokens/percent/limit,
  // бейдж и метрики НЕ пересчитываются. Опоры — точные байтовые строки (не регулярки-обобщения),
  // поэтому прочие пять платформ по построению не задеваются (пин R: их байты прежние).
  // =====================================================================================
  var TC_LFR_OPEN = '<local_file_read>';
  var TC_LFR_CLOSE = '</local_file_read>';
  var TC_TASK_OPEN = '<original_task>';
  var TC_TASK_CLOSE = '</original_task>';
  var TC_RESULTS_OPEN = '<tool_results>';
  var TC_RESULTS_CLOSE = '</tool_results>';
  var TC_PROSE_ANCHOR = 'These are the tool results just executed for the tool-continuation task.';

  // Таблица измеренных дескрипторов конверта: id | опорные строки | правило границы | основание.
  var TC_ENVELOPE_FORMS = [
    {
      id: 'tc-local-file-read', rule: 'pair', open: TC_LFR_OPEN, close: TC_LFR_CLOSE,
      boundary: 'от строки открывающего тега до строки закрывающего; снимается, когда пара — целое сообщение (спан внутри сообщения — байтово: измерения спана в артефакте нет)',
      scope: 'tool-request',
      basis: 'artifact 10-19 msg 1/3/9/11/13 lines 1-3 (whole message, role=assistant)'
    },
    {
      id: 'tc-prose-continuation', rule: 'run', openPrefix: TC_PROSE_ANCHOR,
      boundary: 'от строки-якоря до последней непустой строки прозы (перед пустой строкой)',
      scope: 'envelope',
      basis: 'artifact 10-19 msg 2/4/7/8/10/12/14 lines 1-9'
    },
    {
      id: 'tc-original-task', rule: 'pair', open: TC_TASK_OPEN, close: TC_TASK_CLOSE,
      boundary: 'от <original_task> до </original_task>; пустая пара 11-12 — та же граница',
      scope: 'envelope',
      basis: 'artifact 10-19 msg 2/4 lines 11-12 (empty), msg 7/8/10/12/14 lines 11-17'
    },
    {
      id: 'tc-tool-results', rule: 'pair', open: TC_RESULTS_OPEN, close: TC_RESULTS_CLOSE,
      boundary: 'от <tool_results> до </tool_results>; в артефакте закрывающий тег — последняя строка сообщения (7/7)',
      scope: 'envelope',
      basis: 'artifact 10-19 msg 2/4 lines 14-26 / 14-35, msg 7/8/10/12/14 lines 19-66'
    }
  ];

  /** Первая пара 'open … close' начиная со строки from; незакрытая пара → null (границы нет). */
  function tcPairAfter(lines, from, open, close) {
    for (var i = Math.max(0, from); i < lines.length; i++) {
      if (lines[i] !== open) continue;
      for (var j = i + 1; j < lines.length; j++) { if (lines[j] === close) return { open: i, close: j }; }
      return null;
    }
    return null;
  }

  /** Пара — целое сообщение? (до открывающего и после закрывающего нет непробельных строк) */
  function tcIsWholeMessagePair(lines, pair) {
    var i;
    for (i = 0; i < pair.open; i++) { if (String(lines[i]).trim() !== '') return false; }
    for (i = pair.close + 1; i < lines.length; i++) { if (String(lines[i]).trim() !== '') return false; }
    return true;
  }

  /** Индекс строки-якоря проза-блока конверта (-1 — конверта нет). */
  function tcProseAnchorLine(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (String(lines[i]).slice(0, TC_PROSE_ANCHOR.length) === TC_PROSE_ANCHOR) return i;
    }
    return -1;
  }

  /**
   * O-42: вырезать из текста измеренные формы агентного конверта Better DeepSeek.
   * Возврат { text, removed, forms }: removed — число снятых измеренных форм (конверт-ход —
   * три формы: проза/эхо задачи/результаты — или меньше, если часть форм не распознана;
   * запрос тула — одна), forms — id снятых форм по порядку. Ничего не снято → тот же текст.
   * Запрос тула снимается только как ЦЕЛОЕ сообщение (измеренная граница формы); спан пары
   * внутри сообщения — байтово (см. комментарий ветки (2): измерения спана нет). Чистая
   * функция: без логов, DOM и chrome; идемпотентна (на своём же выходе повторный вызов
   * ничего не меняет).
   */
  function sanitizeToolContinuationText(text) {
    var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
    if (s.indexOf(TC_LFR_OPEN) === -1 && s.indexOf(TC_TASK_OPEN) === -1 &&
        s.indexOf(TC_RESULTS_OPEN) === -1 && s.indexOf(TC_PROSE_ANCHOR) === -1) {
      return { text: s, removed: 0, forms: [] };
    }
    var lines = s.split('\n');
    var drop = {};
    var forms = [];
    // (1) конверт-ход: распознаётся по измеренной строке-якорю (B); спан — от якоря до конца
    // последней распознанной формы (D), т.е. до закрывающего тега результатов.
    var anchor = tcProseAnchorLine(lines);
    if (anchor !== -1) {
      var runEnd = anchor;
      for (var p = anchor + 1; p < lines.length; p++) {
        if (String(lines[p]).trim() === '') break;
        runEnd = p;
      }
      var spanEnd = runEnd;
      var afterRun = runEnd + 1;
      var task = tcPairAfter(lines, afterRun, TC_TASK_OPEN, TC_TASK_CLOSE);
      if (task) { spanEnd = task.close; afterRun = task.close + 1; }
      var results = tcPairAfter(lines, afterRun, TC_RESULTS_OPEN, TC_RESULTS_CLOSE);
      if (results) { spanEnd = results.close; }
      for (var d = anchor; d <= spanEnd; d++) drop[d] = true;
      forms.push('tc-prose-continuation');
      if (task) forms.push('tc-original-task');
      if (results) forms.push('tc-tool-results');
    }
    // (2) запрос тула <local_file_read>…</local_file_read> — самостоятельный машинный ход.
    // Измеренная граница формы — ЦЕЛОЕ сообщение (артефакт 10-19: 5/5). Спан пары ВНУТРИ
    // сообщения не снимается: своего измерения спана в артефакте НЕТ (0 вхождений), а живые
    // байты такого спана (F3-обёртка + хвост-запрос в ОДНОМ сообщении) заморожены как
    // СОХРАНЯЕМЫЙ текст — tests/deepseek-o40-…:1747, :2008 и tests/o40-f3-diag-…:474
    // (не закрываются, т.к. закрывать нечего: спан не измерен) → по правилу «нет измеримой
    // границы — не угадывать» спан не трогаем (байтово).
    for (var k = 0; k < lines.length; k++) {
      if (drop[k] || lines[k] !== TC_LFR_OPEN) continue;
      var lfr = tcPairAfter(lines, k, TC_LFR_OPEN, TC_LFR_CLOSE);
      if (!lfr) continue;                            // незакрытая пара — границы нет
      if (!tcIsWholeMessagePair(lines, lfr)) { k = lfr.close; continue; }  // спан — байтово
      for (var d2 = lfr.open; d2 <= lfr.close; d2++) drop[d2] = true;
      forms.push('tc-local-file-read');
      k = lfr.close;
    }
    if (!forms.length) return { text: s, removed: 0, forms: [] };
    var kept = [];
    for (var m = 0; m < lines.length; m++) { if (!drop[m]) kept.push(lines[m]); }
    return { text: kept.join('\n'), removed: forms.length, forms: forms };
  }

  // =====================================================================================
  // O-7 (OFF): УРЕЗАНИЕ СЕКЦИЙ REASONING НА ВЫХОДЕ ЭКСПОРТА.
  //
  // Решение владельца (P1=a, P2=OFF): при выключенном тумблере aiCmIncludeHiddenInExport
  // (default) в файл попадают ТОЛЬКО вопросы и ответы. Сетевой путь DeepSeek собирает текст
  // хода секциями (core/deepseek-intercept.js, v8):
  //   [REASONING]\n<рассуждение>\n\n[ANSWER]\n<ответ>
  // В БАЗЕ (lastBaseTexts/turnsMap/baseText) секции остаются КАК ЕСТЬ — менять базу нельзя
  // (метрики, пороги, бейдж, пины O-15/O-17/O-18). Урезание — ТОЛЬКО на выходе экспорта
  // (единая точка aiCmCollectExportSource → sanitizeEmitMessages): от текста остаётся часть
  // после [ANSWER], сами маркеры убираются. Тексты прочих платформ (ChatGPT/Gemini/GSA/
  // Claude/Perplexity) пары маркеров не несут → байтово прежние. Симметрично ON-путь
  // (сырой режим, includeHiddenExportBlocks) не урезает ничего.
  //
  // Инварианты чистой функции stripReasoningSections:
  //   - текст без пары [REASONING]/[ANSWER] возвращается ТЕМ ЖЕ значением (байтово);
  //   - [ANSWER] без ПРЕДШЕСТВУЮЩЕГО [REASONING] текст не меняет;
  //   - вырезается ровно пара — от [REASONING] до [ANSWER] включительно плюс ОДИН
  //     форматный перевод строки сразу после [ANSWER] (форма записи '[ANSWER]\n<ответ>');
  //     текст до пары сохраняется байтово;
  //   - несколько пар в одном тексте обрабатываются ВСЕ (все ответы остаются);
  //   - идемпотентна: на своём же выходе повторный вызов ничего не меняет;
  //   - чистая: без логов, DOM, chrome и побочных эффектов.
  // =====================================================================================
  var SECTION_REASONING_TAG = '[REASONING]';
  var SECTION_ANSWER_TAG = '[ANSWER]';

  function stripReasoningSections(text) {
    var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
    // Нет пары — байтово прежний текст (все прочие платформы, обычные ответы).
    if (s.indexOf(SECTION_REASONING_TAG) === -1 || s.indexOf(SECTION_ANSWER_TAG) === -1) return s;
    var out = '';
    var i = 0;
    var changed = false;
    while (i < s.length) {
      var a = s.indexOf(SECTION_ANSWER_TAG, i);
      if (a === -1) { out += s.slice(i); break; }
      var r = (a > 0) ? s.lastIndexOf(SECTION_REASONING_TAG, a - 1) : -1;
      if (r === -1 || r < i) {
        // [ANSWER] без пары (в т.ч. уже пройденный маркер) — не трогаем.
        out += s.slice(i, a + SECTION_ANSWER_TAG.length);
        i = a + SECTION_ANSWER_TAG.length;
        continue;
      }
      out += s.slice(i, r);                       // текст до пары сохраняется байтово
      i = a + SECTION_ANSWER_TAG.length;
      // Форматная склейка '[ANSWER]\n<ответ>': перевод строки — часть маркера, не ответа.
      if (s.charAt(i) === '\r' && s.charAt(i + 1) === '\n') i += 2;
      else if (s.charAt(i) === '\n') i += 1;
      changed = true;
    }
    return changed ? out : s;
  }

  // =====================================================================================
  // O-37 (C): РАЗДЕЛЕНИЕ ПАРЫ СЕКЦИЙ [REASONING]/[ANSWER] НА ПОЛЯ.
  //
  // Сетевой путь сервиса БЕЗ сети укладывает размышление в текст хода ровно так же, как
  // DeepSeek (composeTurnText): '[REASONING]\n<рассуждение>\n\n[ANSWER]\n<ответ>'.
  // OFF-путь O-7 на выходе экспорта урезает такие секции до части [ANSWER] — и размышление
  // до рендера не доезжает (живой факт 21:59 chat=4cf29053: стрим дал reasoningLen=214,
  // в txt/md секции [REASONING] нет).
  // Здесь — чистое ОБРАТНОЕ преобразование той же пары: пара → отдельные поля, чтобы
  // вызывающий мог отдать размышление рендеру отдельным полем (контракт O-35) ДО урезания.
  //
  // Инварианты (симметричны stripReasoningSections):
  //   - пары нет ([REASONING] без [ANSWER], нет маркеров вовсе) → { reasoning:'', answer: текст }
  //     БАЙТОВО прежний в answer (текст не меняется);
  //   - берётся ПЕРВАЯ пара: reasoning — текст между маркерами (без форматного перевода строки
  //     сразу после [REASONING] и без пробельного хвоста перед [ANSWER]), answer — всё после
  //     [ANSWER] плюс снятый ОДИН форматный перевод строки (как в stripReasoningSections);
  //   - round-trip: '[REASONING]\n<r>\n\n[ANSWER]\n<a>' → { reasoning:<r>, answer:<a> };
  //   - идемпотентна на своём выходе: у answer пары уже нет → answer возвращается как есть;
  //   - чистая: без логов, DOM и chrome. Маркеры — формат ДАННЫХ (прецедент O-35/O-36).
  // =====================================================================================
  function splitReasoningSections(text) {
    var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
    var r = s.indexOf(SECTION_REASONING_TAG);
    if (r === -1) return { reasoning: '', answer: s };
    var a = s.indexOf(SECTION_ANSWER_TAG, r + SECTION_REASONING_TAG.length);
    if (a === -1) return { reasoning: '', answer: s };
    var reasoning = s.slice(r + SECTION_REASONING_TAG.length, a).replace(/^\r?\n/, '').replace(/\s+$/, '');
    var i = a + SECTION_ANSWER_TAG.length;
    if (s.charAt(i) === '\r' && s.charAt(i + 1) === '\n') i += 2;
    else if (s.charAt(i) === '\n') i += 1;
    return { reasoning: reasoning, answer: s.slice(i) };
  }

  // =====================================================================================
  // O-37 (C): НОРМАЛИЗАЦИЯ РАЗМЫШЛЕНИЯ НА ВЫХОДЕ ТОЧКИ СБОРА ЭКСПОРТА.
  //
  // Живой факт 21:59 (chat=4cf29053): стрим дал reasoningLen=214, строка reasoning есть в
  // попапе, а в txt/md секции [REASONING] нет. Корень — ДВА поля и один порядок:
  //   (1) сообщение сервиса без сети приносит размышление либо полем захвата hiddenReasoning
  //       (DOM-адаптер, O-35), либо ПАРОЙ СЕКЦИЙ прямо в тексте хода (сетевая база);
  //   (2) OFF-путь O-7 (sanitizeEmitMessages → stripReasoningSections) урезает секции до части
  //       [ANSWER] и снимает поле захвата — то есть ДО рендера, который читает поле reasoning.
  // Здесь — единая нормализация ДО санации: найденное размышление переезжает в отдельное поле
  // reasoning, текст остаётся без секций (answer), служебное поле захвата снимается. Тогда
  // OFF/ON-пути обработки hidden-полей ничего не теряют (для них работа уже сделана), а рендер
  // сборщиков получает размышление как ДАННЫЕ — контракт [REASONING]/[ANSWER] (O-35).
  //
  // Гейт — ФЛАГ САЙТА (заполняет вызывающий: сервис, чей DESIGN-источник — DOM-адаптер, то есть
  // сервис БЕЗ сети): enabled !== true → массив НЕ трогается вовсе, объекты те же, байты шести
  // платформ прежние. Нормализация идёт ПО МЕСТУ (элементы массива заменяются копиями): у
  // вызывающего остаётся ровно одна точка санации, в прежнем виде (source-пин O-20).
  // Нет размышления — сообщение не меняется (нет секции — норма). Чистая: без логов и DOM.
  // Возврат { changed } — только измерение (пины), на байты не влияет.
  // =====================================================================================
  function applyReasoningExportFields(messages, enabled) {
    var changed = 0;
    try {
      if (enabled !== true || !Array.isArray(messages)) return { changed: 0 };
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (!m || typeof m !== 'object') continue;
        var text = (typeof m.text === 'string') ? m.text : '';
        var reasoning = (typeof m.reasoning === 'string') ? m.reasoning : '';
        var captured = (typeof m.hiddenReasoning === 'string') ? m.hiddenReasoning : '';
        if (!reasoning) reasoning = captured;
        // Разбор пары секций — только у ХОДА АССИСТЕНТА (размышление — часть его ответа):
        // текст роли user не переупаковываем, его судьбу по-прежнему решает OFF/ON-путь O-7.
        if (!reasoning && text && m.role !== 'user') {
          var pair = splitReasoningSections(text);
          if (pair && pair.reasoning) { reasoning = pair.reasoning; text = pair.answer; }
        }
        if (!reasoning) continue;
        // Нечего менять (reasoning уже полем, поле захвата пусто, текст не резался) — объект прежний.
        if (!captured && text === m.text) continue;
        var next = {};
        for (var k in m) {
          if (Object.prototype.hasOwnProperty.call(m, k)) next[k] = m[k];
        }
        next.text = text;
        next.reasoning = reasoning;
        if (next.hiddenReasoning) delete next.hiddenReasoning;
        messages[i] = next;
        changed++;
      }
    } catch (eApply) { return { changed: changed }; }
    return { changed: changed };
  }

  // =====================================================================================
  // O-7 (OFF, S3/S4/S5): СЛУЖЕБНЫЙ ТУЛ-МУСОР DeepSeek++ — ПРОЧЬ ИЗ ЭКСПОРТА.
  //
  // В agent-режиме DeepSeek++ гоняет тул-коллы через саму переписку:
  //   - РЕЗУЛЬТАТЫ тулов приходят ОТДЕЛЬНЫМ user-сообщением, ЦЕЛИКОМ состоящим из блока
  //     [TOOL_RESULTS]…[/TOOL_RESULTS] с необязательным хвостом-приглашением
  //     'Continue answering based on the tool results above.' (своего текста пользователя
  //     в таком сообщении нет — это машинный ход);
  //   - ВЫЗОВЫ тулов модель пишет XML-блоками прямо в текст хода ассистента:
  //     <browser_navigate …>…</browser_navigate>, <memory_save>…</memory_save>,
  //     <shell_exec>…</shell_exec>, <web_search>…</web_search>, <skill_…>…</skill_…> и др.
  // В файле экспорта этого быть не должно: OFF = ТОЛЬКО вопросы и ответы. Поэтому:
  //   S3 — user-сообщение, ЦЕЛИКОМ состоящее из блока результатов (+ хвост), из экспорта
  //        удаляется (роль user, но контента пользователя в нём нет);
  //   S4 — в текстах АССИСТЕНТА (роль значения не имеет для прочих платформ — там таких
  //        тегов нет; user-тексты не трогаются) вырезаются ПАРНЫЕ XML-блоки вызовов по
  //        списку тегов: открывающий с необязательными атрибутами, тело, закрывающий;
  //        нежадно, с обратной ссылкой на имя тега (чужой закрывающий не подойдёт);
  //   S5 — сообщение, у которого после S3/S4 не осталось текста ('' или одни пробелы),
  //        в экспорт не попадает (ход ассистента из одних тул-коллов пуст для читателя).
  // Тексты, в которых тул-мусора нет, возвращаются БАЙТОВО тем же значением (пины прочих
  // платформ и обычных ходов DeepSeek целы). Трогается ТОЛЬКО OFF-путь: ON
  // (includeHiddenExportBlocks) отдаёт всё как есть.
  // =====================================================================================
  var TOOL_RESULTS_OPEN = '[TOOL_RESULTS]';
  var TOOL_RESULTS_CLOSE = '[/TOOL_RESULTS]';
  var TOOL_RESULTS_TAIL = 'Continue answering based on the tool results above.';

  /**
   * S3: текст — ЦЕЛИКОМ блок результатов тулов DeepSeek++ (+ необязательный хвост)?
   * Пустое/чужое/многосоставное (два блока, текст вокруг) → false: удаляем только
   * машинный ход целиком, ничего пользовательского не выбрасываем.
   */
  function isToolResultsOnlyText(text) {
    try {
      var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
      var t = s.trim();
      if (t.indexOf(TOOL_RESULTS_OPEN) !== 0) return false;
      var close = t.indexOf(TOOL_RESULTS_CLOSE);
      if (close === -1) return false;
      var rest = t.slice(close + TOOL_RESULTS_CLOSE.length).trim();
      if (rest === TOOL_RESULTS_TAIL) rest = '';
      return rest === '';
    } catch (e) { return false; }
  }

  // S4: список тегов вызовов DeepSeek++ (18 browser_* + 3 memory_* + web_search/web_fetch)
  // и три префиксных семейства (shell_*, python_*, skill_*). Пары ищутся по имени тега
  // (обратная ссылка), поэтому 'browser_key' не съедает 'browser_key_result'.
  var TOOL_CALL_TAG_NAMES = [
    'browser_navigate', 'browser_go_back', 'browser_go_forward', 'browser_refresh',
    'browser_list_tabs', 'browser_select_tab', 'browser_close_tab', 'browser_snapshot',
    'browser_click', 'browser_hover', 'browser_fill', 'browser_fill_form', 'browser_key',
    'browser_type', 'browser_attach_file', 'browser_wait_for', 'browser_handle_dialog',
    'browser_evaluate_script', 'memory_save', 'memory_update', 'memory_delete',
    'web_search', 'web_fetch'
  ];
  var TOOL_CALL_TAG_ALT = '(?:' + TOOL_CALL_TAG_NAMES.join('|') + '|shell_\\w+|python_\\w+|skill_\\w+)';
  var RE_TOOL_CALL_BLOCK = new RegExp(
    '<(' + TOOL_CALL_TAG_ALT + ')(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>\\s*', 'g');

  /**
   * S4: вырезать из текста парные XML-блоки вызовов тулов DeepSeek++.
   *   - тело нежадное: несколько блоков подряд обрабатываются ВСЕ;
   *   - атрибуты открывающего тега допускаются ('<browser_click selector="…">');
   *   - вместе с блоком снимается его пробельная отбивка (пробельный хвост сразу за
   *     закрывающим тегом): на месте вызова не остаётся лишней пустой строки
   *     ('…текст\n\n<block>\n\nдальше' → '…текст\n\nдальше'); ОСТАЛЬНАЯ разметка хода
   *     байтово прежняя — двойные пустые строки прозы, отступы и т.п. не трогаются;
   *   - ход, ЗАКАНЧИВАВШИЙСЯ блоком (в артефакте после последнего вызова идут пустые
   *     строки), не оставляет хвостовых пустых строк: они снимаются (только если блоки
   *     реально вырезаны);
   *   - текст без таких блоков возвращается БАЙТОВО тем же (обычные ходы всех сервисов);
   *   - чистая: без логов, DOM и chrome. Идемпотентна на своём же выходе.
   */
  function stripToolCallBlocks(text) {
    var s = (typeof text === 'string') ? text : String(text == null ? '' : text);
    if (s.indexOf('<') === -1) return s;                 // быстрый выход: блоков нет
    RE_TOOL_CALL_BLOCK.lastIndex = 0;                    // глобальная регулярка — без утечки состояния
    var out = s.replace(RE_TOOL_CALL_BLOCK, '');
    if (out === s) return s;                             // ничего не вырезано → байтово прежний
    return out.replace(/\s+$/, '');
  }

  /** S5: текст экспорта пуст ('' или одни пробелы) → сообщения в файле нет. */
  function isEmptyExportText(text) {
    try { return String(text == null ? '' : text).trim() === ''; } catch (e) { return false; }
  }

  /** Копия собственных полей сообщения с ЗАМЕНЁННЫМ текстом (вход не мутируется). */
  function copyMessageWithText(message, text) {
    var keep = {};
    for (var k in message) {
      if (Object.prototype.hasOwnProperty.call(message, k)) keep[k] = message[k];
    }
    keep.text = text;
    return keep;
  }

  /**
   * O-20: санация массива сообщений экспорта. Трогается ТОЛЬКО role=user: assistant и
   * user-сообщения без ровно одной пары маркеров возвращаются ТЕМИ ЖЕ объектами (байтово,
   * id и прочие поля сохранены). У изменённого сообщения текст заменён видимым текстом,
   * остальные поля скопированы.
   * Возвращает { messages, sanitized, skipped } (skipped — причины пропуска по порядку
   * сообщений). Логирование вынесено наружу: чистая функция остаётся чистой, а гейт
   * aiCmDebug и антиспам-подпись живут в вызывающем коде (core/export-manager.js).
   * Исключение — O-40-диагностика (строки o40-emit-msg): функция только ЧИТАЕТ уже
   * посчитанные значения и отдаёт их каноническому хелперу гейта aiCmDiagLine; своего
   * вывода в консоль и своего гейта здесь нет, без хелпера/гейта — ни одной строки.
   * O-7 (OFF): служебные поля hidden-захвата снимаются (в экспорт не идут), сетевые
   * секции [REASONING]…[ANSWER]… урезаются до части [ANSWER] (stripReasoningSections) —
   * роль значения не имеет: секции несёт ход ассистента. Сообщение, у которого не
   * изменилось НИ поле захвата, НИ текст, возвращается ТЕМ ЖЕ объектом.
   * O-7 (OFF, S3/S4/S5): из экспорта уходит служебный тул-мусор DeepSeek++ —
   * user-ход из одних [TOOL_RESULTS] (S3) и XML-блоки вызовов тулов в тексте ассистента
   * (S4); сообщение, у которого после этого текста не осталось, не попадает в массив (S5).
   * O-40: инъекции соседнего расширения Better DeepSeek (измеренные формы — таблица
   * BDS_INJECTION_FORMS) снимаются ЗДЕСЬ ЖЕ, до S4/O-20; целое сообщение-инжекция после
   * вырезки пусто и снимается тем же S5. Роль значения не имеет: правило привязано к точным
   * байтовым опорам артефакта, а не к роли (в артефакте все инъекции — user-ходы).
   * O-42: агентный конверт Better DeepSeek (tool-continuation) — измеренные дескрипторы
   * TC_ENVELOPE_FORMS — снимается ЗДЕСЬ ЖЕ, ПОСЛЕ O-40 и ДО S4/O-20; целое сообщение-конверт
   * после вырезки пусто и снимается тем же S5; спан-хвост запроса тула внутри user/assistant
   * сообщения (живой симптом F3) не трогается — измеренная граница формы A только «целое
   * сообщение». Диагностики у O-42 нет вовсе — строки o40-emit-msg/o40-bds-line не сдвинуты.
   * Порядок: stripHiddenFields → stripReasoningSections → O-40 → O-42 → S4 → S5 → O-20 (user).
   * skipped — причины НЕприменённой санации O-20 (как было); dropped — счётчик
   * сообщений, не поехавших в экспорт по S3/S5 (в т.ч. опустевших после O-40);
   * bdsRemoved/bdsForms — измерение O-40 (снятые элементы и их формы), на байты не влияет.
   */
  function sanitizeEmitMessages(messages) {
    var out = [];
    var sanitized = 0;
    var skipped = [];
    var dropped = 0;
    var bdsRemoved = 0;
    var bdsForms = [];
    // O-42: измерение конверта tool-continuation (снятые формы), на байты не влияет.
    var tcRemoved = 0;
    var tcForms = [];
    try {
      var src = Array.isArray(messages) ? messages : [];
      for (var i = 0; i < src.length; i++) {
        var m = stripHiddenFields(src[i]);
        if (!m || typeof m !== 'object') {
          // O-40 (диагностика): сообщение без объекта — O-40 не вызывается.
          bdsDiagLine('o40-emit-msg', { i: i, len: 0, head: bdsDiagSlice('', 0, 40), tail: bdsDiagSlice('', 1, 40), called: 0, removed: 0 });
          out.push(m); continue;
        }
        var raw = (typeof m.text === 'string') ? m.text : '';
        // O-40 (диагностика): строка на КАЖДОЕ сообщение. Здесь — ветка S3 (user-ход
        // целиком из [TOOL_RESULTS]): в O-40 он не доходит → called=0, removed=0. Предикат
        // S3 чистый и переиспользуется ТОЛЬКО под гейтом aiCmDebug (aiCmDiagOn), поэтому
        // вне диагностики число вызовов прежнее 1:1; сам гейт S3 ниже оставлен байтово.
        if ((typeof aiCmDiagOn === 'function') && aiCmDiagOn() &&
            m.role === 'user' && isToolResultsOnlyText(raw)) {
          bdsDiagLine('o40-emit-msg', { i: i, len: raw.length, head: bdsDiagSlice(raw, 0, 40), tail: bdsDiagSlice(raw, 1, 40), called: 0, removed: 0 });
        }
        // S3: user-ход целиком из результатов тулов (+ необязательный хвост) — машинный
        // ход, своего текста пользователя в нём нет: в экспорт не идёт вовсе.
        if (m.role === 'user' && isToolResultsOnlyText(raw)) { dropped++; continue; }
        // O-7 (OFF): только часть [ANSWER] — урезание ДО санации O-20 (на выходе экспорта).
        var bare = stripReasoningSections(raw);
        if (bare !== raw) m = copyMessageWithText(m, bare);
        // O-40: инъекции Better DeepSeek — та же точка и тот же OFF-путь, что у O-20;
        // текст без измеренных форм возвращается тем же значением (m не копируется).
        // O-40 (диагностика): bdsIn — РОВНО тот текст, что получает O-40 (после урезания
        // секций); факт вызова и removed уходят строкой o40-emit-msg.
        var bdsIn = (typeof m.text === 'string') ? m.text : '';
        var bds = sanitizeBetterDeepSeekText(bdsIn);
        bdsDiagLine('o40-emit-msg', { i: i, len: bdsIn.length, head: bdsDiagSlice(bdsIn, 0, 40), tail: bdsDiagSlice(bdsIn, 1, 40), called: 1, removed: bds.removed });
        if (bds.removed > 0) {
          m = copyMessageWithText(m, bds.text);
          bdsRemoved += bds.removed;
          for (var bf = 0; bf < bds.forms.length; bf++) bdsForms.push(bds.forms[bf]);
        }
        // O-42: агентный конверт Better DeepSeek (tool-continuation) — та же точка и тот же
        // OFF-путь, что у O-40/O-20; текст без измеренных форм возвращается тем же значением
        // (m не копируется). Идёт ДО S4/S5 — целое сообщение-конверт после вырезки пусто и
        // снимается существующим S5.
        var tc = sanitizeToolContinuationText((typeof m.text === 'string') ? m.text : '');
        if (tc.removed > 0) {
          m = copyMessageWithText(m, tc.text);
          tcRemoved += tc.removed;
          for (var tf = 0; tf < tc.forms.length; tf++) tcForms.push(tc.forms[tf]);
        }
        if (m.role !== 'user') {
          // S4: XML-блоки вызовов тулов DeepSeek++ вырезаются из текста ассистента.
          var cut = stripToolCallBlocks((typeof m.text === 'string') ? m.text : '');
          if (cut !== m.text) m = copyMessageWithText(m, cut);
        } else {
          var text = (typeof m.text === 'string') ? m.text : '';
          var reason = injectedUserTextSkipReason(text);
          if (reason !== null) { skipped.push(reason); }
          else { m = copyMessageWithText(m, sanitizeInjectedUserText(text)); sanitized++; }
        }
        // S5: после S3/S4 текста не осталось — сообщения в экспорте нет.
        if (isEmptyExportText((typeof m.text === 'string') ? m.text : '')) { dropped++; continue; }
        out.push(m);
      }
    } catch (e) {
      return {
        messages: Array.isArray(messages) ? messages : [],
        sanitized: 0, skipped: [], dropped: 0, bdsRemoved: 0, bdsForms: [],
        tcRemoved: 0, tcForms: []
      };
    }
    return {
      messages: out, sanitized: sanitized, skipped: skipped, dropped: dropped,
      bdsRemoved: bdsRemoved, bdsForms: bdsForms,
      tcRemoved: tcRemoved, tcForms: tcForms
    };
  }

  // =====================================================================================
  // O-7: HIDDEN-БЛОКИ DEEPSEEK — СЫРОЙ РЕЖИМ ЭКСПОРТА (тумблер aiCmIncludeHiddenInExport).
  //
  // Продуктовое решение владельца (P1=a, P2=OFF): OFF = в файл идут ТОЛЬКО вопросы и
  // ответы, а тумблер «Включать reasoning и инъекции DeepSeek++ в экспорт»
  // (chrome.storage.local, default OFF) добавляет РОВНО ОДИН сырой режим:
  //   OFF — секции [REASONING]…[ANSWER]… сетевого пути урезаются до части [ANSWER]
  //         (stripReasoningSections), санация O-20 активна, hidden-поля захвата снимаются;
  //   ON  — текст как есть (секции на месте), hidden-reasoning идёт в текст ОТДЕЛЬНЫМ
  //         блоком с пометкой [REASONING], инъекции DeepSeek++ остаются КАК ЕСТЬ
  //         (санация O-20 не применяется).
  // Метрики (tokens/pct/модель/бейдж) считаются БЕЗ hidden-блоков при ЛЮБОМ положении
  // тумблера: hidden живёт ОТДЕЛЬНЫМ полем сообщения (hiddenReasoning) и в text не входит —
  // его не видят ни aiCmBasePrepared, ни aiCmMetricBaseText.
  // Точка включения — ЕДИНАЯ (выход aiCmCollectExportSource, ровно как у O-20): отсюда
  // сообщения берут ВСЕ четыре формата (md/json/txt + print-pdf) и запись aiCmHistory.
  // =====================================================================================
  // Маркеры секций — ОДНА пара констант на оба пути O-7: OFF их вырезает вместе с
  // reasoning (stripReasoningSections), ON — восстанавливает формат '[REASONING]…[ANSWER]…'.
  var HIDDEN_REASONING_TAG = SECTION_REASONING_TAG;
  var HIDDEN_ANSWER_TAG = SECTION_ANSWER_TAG;

  /** Есть ли у сообщения служебные поля hidden-захвата (любое, даже пустое). */
  function hasHiddenFields(message) {
    try {
      if (!message || typeof message !== 'object') return false;
      return Object.prototype.hasOwnProperty.call(message, 'hiddenReasoning') ||
        Object.prototype.hasOwnProperty.call(message, 'hiddenInjection');
    } catch (e) { return false; }
  }

  /** Reasoning скрытого захвата сообщения (поле hiddenReasoning) или '' (нет/не строка). */
  function hiddenReasoningOf(message) {
    try {
      var r = (message && typeof message.hiddenReasoning === 'string') ? message.hiddenReasoning : '';
      return r.trim();
    } catch (e) { return ''; }
  }

  /** Копия собственных полей сообщения БЕЗ служебных hidden-полей захвата. */
  function withoutHiddenFields(message) {
    var keep = {};
    for (var k in message) {
      if (!Object.prototype.hasOwnProperty.call(message, k)) continue;
      if (k === 'hiddenReasoning' || k === 'hiddenInjection') continue;
      keep[k] = message[k];
    }
    return keep;
  }

  /**
   * O-7 (OFF-путь): тот же объект, если hidden-полей нет; иначе копия без них.
   * Пины идентичности O-20 (assistant и текст без маркеров — те же объекты) сохранены.
   */
  function stripHiddenFields(message) {
    if (!message || typeof message !== 'object') return message;
    return hasHiddenFields(message) ? withoutHiddenFields(message) : message;
  }

  /**
   * O-7 (тумблер ON): развернуть hidden-захват в ТЕКСТ экспорта.
   *   - reasoning → ОТДЕЛЬНЫЙ блок с пометкой: '[REASONING]\n…\n\n[ANSWER]\n<текст>';
   *   - рассуждение, УЖЕ присутствующее в тексте (сетевой путь DeepSeek: секции
   *     [REASONING]/[ANSWER] собирает сам перехватчик, v8), повторно НЕ дописывается —
   *     дубля нет;
   *   - сообщения без hidden-захвата возвращаются ТЕМИ ЖЕ объектами (байтово);
   *   - служебные поля захвата в результат НЕ переносятся (они уже в тексте).
   * Чистая функция: без логов, DOM и chrome. Идемпотентна — на своём же выходе
   * повторный вызов ничего не меняет.
   */
  function includeHiddenExportBlocks(messages) {
    var src = Array.isArray(messages) ? messages : [];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var m = src[i];
      if (!m || typeof m !== 'object' || !hasHiddenFields(m)) { out.push(m); continue; }
      var keep = withoutHiddenFields(m);
      var reasoning = hiddenReasoningOf(m);
      var text = (typeof keep.text === 'string') ? keep.text : '';
      if (reasoning && text.indexOf(reasoning) === -1) {
        keep.text = HIDDEN_REASONING_TAG + '\n' + reasoning + '\n\n' + HIDDEN_ANSWER_TAG + '\n' + text;
      }
      out.push(keep);
    }
    return out;
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
    shouldSkipGsaPageGuard: shouldSkipGsaPageGuard,
    shouldSkipAutoExport: shouldSkipAutoExport,
    shouldSkipBaseCompleteTrigger: shouldSkipBaseCompleteTrigger,
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
    // O-40: инъекции соседнего расширения Better DeepSeek — чистые функции и таблица
    // измеренных форм наружу (пины D/R нового тест-файла читают формы из таблицы).
    sanitizeBetterDeepSeekText: sanitizeBetterDeepSeekText,
    betterDeepSeekForms: BDS_INJECTION_FORMS,
    bdsWrapperFormId: BDS_WRAPPER_ID,
    // O-42: агентный конверт Better DeepSeek (tool-continuation) — чистая функция и таблица
    // измеренных дескрипторов конверта наружу (пины D/R нового тест-файла читают таблицу).
    sanitizeToolContinuationText: sanitizeToolContinuationText,
    toolContinuationForms: TC_ENVELOPE_FORMS,
    // O-7 (OFF): урезание секций reasoning на выходе экспорта — чистая функция наружу.
    stripReasoningSections: stripReasoningSections,
    // O-37 (C): обратное преобразование пары [REASONING]/[ANSWER] в отдельные поля
    // (reasoning/answer) — чистая функция наружу (переиспользуется точкой сбора экспорта).
    splitReasoningSections: splitReasoningSections,
    // O-37 (C): нормализация размышления на выходе точки сбора экспорта (по месту, по флагу
    // сайта) — чистая функция наружу; на боевом пути её зовёт core/export-manager.js.
    applyReasoningExportFields: applyReasoningExportFields,
    // O-7 (OFF, S3/S4): служебный тул-мусор DeepSeek++ — чистые функции наружу.
    isToolResultsOnlyText: isToolResultsOnlyText,
    stripToolCallBlocks: stripToolCallBlocks,
    // O-7: hidden-блоки DeepSeek (сырой режим экспорта) — чистые функции наружу.
    includeHiddenExportBlocks: includeHiddenExportBlocks,
    stripHiddenFields: stripHiddenFields,
    hiddenReasoningOf: hiddenReasoningOf,
    unionTurnsById: unionTurnsById,
    latchKey: latchKey
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmExportEmitPipeline = Api;
})();
