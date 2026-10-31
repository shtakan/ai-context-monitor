/**
 * core/deepseek-files.js — Step D.10 (Вариант B + A-лайт): асинхронная догрузка ТЕКСТА
 * вложений DeepSeek в MAIN-мире.
 *
 * Зачем: фрагмент типа FILE в history_messages/completion несёт только МЕТАДАННЫЕ файла
 * (file_id/имя), а тело лежит на ОТДЕЛЬНОМ файловом хосте:
 *   GET https://files.deepseeksvc.com/api/file?file_id=<id>[&state=<signed_path>]
 * Без текста вложения ход в экспорте состоит из одной метки, то есть файл (PDF/док)
 * теряет содержимое. JSON-вложения (дампы вида {"code":0,"data":{…}}) не имеют текстовых
 * полей — для них содержимым файла считается СЫРОЕ тело ответа.
 *
 * Что делает модуль (Вариант B — асинхронная догрузка):
 *   • при ПРИЁМКЕ авторитетного снимка (D.8, ветка ACCEPT) ядро отдаёт цепочку ходов сюда —
 *     enqueueChainFiles(chain, chatModelSignals): из каждого хода вынимаются ссылки на файлы
 *     (fragment.type === 'FILE', fragment.files[], msg.files[], msg.attachments[]). Ход из
 *     ОДНИХ вложений создаёт сам ingest на его месте в цепочке (предикат messageHasRefs),
 *     а filesEnsureTurn остаётся страховкой для путей, где turnsMap собран не D.8;
 *   • файлы ставятся в FIFO-очередь (concurrency 2, дедуп по `convId|fileId`: один файл,
 *     приложенный к нескольким ходам, качается ОДИН раз);
 *   • fetchFileContent(fileId, signedPath) идёт ЧЕРЕЗ originalFetch (снят ядром до хука D.7)
 *     на files.deepseeksvc.com, БЕЗ заголовков и БЕЗ кук (credentials:'omit': файловый хост
 *     авторизует запрос подписью в signed_path, а credentialed CORS-запрос ломает ответ), таймаут
 *     10 с и кап 2 000 000 символов (файл на 1 МБ не теряет хвост);
 *   • при получении текста обновляется fileTextsByMsg (`<convId>\u0000<msgId>` → СПИСОК файлов
 *     сообщения: ключ включает разговор, чтобы одинаковый message_id из другого чата не подмешал
 *     чужой файл); затем текст хода ПЕРЕСОБИРАЕТСЯ: composeTurnText(answer, reasoning) + по секции
 *     на КАЖДЫЙ файл (порядок — как во вложениях сообщения), формат секции
 *     «\n\n[FILE: <имя>]\n<текст>»; затем с дебаунсом 250 мс вызывается emitBaseSnapshot —
 *     база уезжает в ISOLATED-мир и попадает в history_messages экспорта;
 *   • A-лайт (core/base-handler.js): перед композицией файла проверяется, ПУСТА ли очередь;
 *     если нет — ждём до 2000 мс (протокол ai-cm-deepseek-files-drain/-done), затем пишем
 *     файл и в лог уходит `reason=file-queue-timeout`.
 *
 * Контракт связки (как у D.1-D.9): ядро -> модуль ТОЛЬКО через __bind(deps). Имена:
 *   fn (3): emitBaseSnapshot — форвардер D.6 (ре-эмит после прихода текста);
 *           composeTurnText/getModelSlug — форвардеры D.4 (пересборка текста хода).
 *   rw (2): turnsMap/orderCounter — тело ДОБАВЛЯЕТ ход-заглушку для вложений без текста
 *           и перезаписывает text уже собранного хода (set — чтобы запись не терялась).
 *   ro (4): currentConvId (ключ дедупа), originalFetch (запрос тела),
 *           lastBaseServerTokens/lastBaseChatMode (аргументы ре-эмита).
 *   Итого 9 имён (3 fn + 2 rw + 4 ro).
 *   связка: ядро форвардит в модуль enqueueChainFiles/applyPendingFileTexts (форвардеры D.10),
 *   а модуль отдаёт ядру предикат filesMessageHasRefs — его ingest зовёт, чтобы завести ход из
 *   одних вложений на своём месте (D.11).
 *   Сброс: ядро (resetForNewConversation) зовёт Fn.resetFiles() при смене разговора — очередь,
 *   карта текстов и ожидания прежнего чата не переезжают в следующий (фикс утечки между чатами).
 *
 * Метрики serverTokens/tokens~ НЕ ТРОГАЮТСЯ: модуль не считает токены, он лишь дописывает
 * текст хода и просит ядро переопубликовать базу тем же emitBaseSnapshot; счётчик токенов
 * и подпись диспатча считаются там же, где и раньше.
 *
 * Жизненный цикл: документ-скоуп MAIN-мира, живёт столько же, сколько ядро. Повторная
 * загрузка гардится (window.AiCmDeepseekFiles), как у D.1-D.9.
 *
 * Зоны (стандарт D.x): PURE-зона — состояние очереди/чистые хелперы без состояния ядра;
 * BIND-зона — тела внутри `with (D)`, которым нужны turnsMap/emitBaseSnapshot/fetch.
 * Прямых обращений вида `D.` в файле нет — только свободные имена в `with (D)`.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekFiles) return;

  // Зависимости ядра. Заполняется ровно один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ===== СЕКЦИЯ 14: ОЧЕРЕДЬ ТЕКСТА ВЛОЖЕНИЙ (PURE-зона) =====
  // Константы протокола догрузки. Кап/таймаут — требование задачи (Вариант B): одно
  // вложение не имеет права ни раздуть память (500k символов), ни подвесить очередь (10 с).
  var FILES_CONCURRENCY = 2;          // одновременно в полёте (FIFO, остальное ждёт)
  var FILES_TEXT_CAP = 2000000;       // символов текста на файл (жёсткий кап; 1 МБ файла целиком)
  var FILES_FETCH_TIMEOUT_MS = 10000; // запрос тела файла
  // v2.0.37 (PDF): файл-PDF (в пределах 10 МиБ) скачивает и разбирает pdf.js —
  // байты идут через MAIN-хелпер core/pdf-bytes.js, текст возвращается как текст.
  var FILES_PDF_MAX = 10 * 1024 * 1024;
  var FILES_PDF_TIMEOUT_MS = 15000;
  var FILES_EMIT_DEBOUNCE_MS = 250;   // ре-эмит базы после прихода текста
  var FILES_DRAIN_TIMEOUT_MS = 2000;  // A-лайт: ожидание опустошения очереди у экспорта
  // Файловый хост DeepSeek (проверено по бандлу сайта и трафику): тело вложения отдаёт
  // files.deepseeksvc.com, а не chat.deepseek.com. Параметр файла — `file_id` (не `id`),
  // `ty=r` (raw) — дописываем, если типа в URL ещё нет; ty=p — превью картинки.
  // Путь — `/api/file`: префикс версии API `/api` ОБЯЗАТЕЛЕН (без него тело не отдаётся;
  // живой трафик сайта идёт на `files.deepseeksvc.com/api/file?file_id=…`, см. docs).
  var FILES_HOST = 'https://files.deepseeksvc.com';
  var FILES_FILE_URL = 'https://files.deepseeksvc.com/api/file';

  // v2.0.29 (Xray/Firefox): detail моста ISOLATED→MAIN приходит СТРОКОЙ (JSON.stringify в
  // core/base-handler.js). Объект чужого компартмента Firefox отдаёт MAIN-миру под
  // Xray-обёрткой, и чтение его полей падает «Permission denied to access property».
  // Разбираем строку; объект принимаем как есть (старые отправители, фикстуры jsdom).
  function aiCmBridgeDetail(ev) {
    var raw = (ev && ev.detail !== undefined) ? ev.detail : null;
    if (typeof raw !== 'string') return raw || null;
    try { return JSON.parse(raw); } catch (eBd) { return null; }
  }

  // Очередь: FIFO-массив элементов + карта дедупа по `convId|fileId` + счётчик активных.
  // Элемент: { key, convId, fileId, signedPath, name, msgIds:{}, status, startedAt, doneAt }.
  var fileQueue = [];
  var fileQueueByKey = {};
  var fileQueueActive = 0;
  // Результат: `<convId>\u0000<msgId>` -> [ { convId, fileId, name, text, truncated, failed, order, at }, ... ].
  // СПИСОК, а не одна запись: в одном сообщении бывает 3–4 вложения (живой кейс 2026-10-24: из
  // четырёх файлов в экспорт попадал РОВНО ОДИН — последний по времени прихода, остальные
  // затирались). Ключ включает convId: одинаковый message_id в ДВУХ чатах (у DeepSeek он
  // приходит из history_messages) раньше перетирал чужой текст и подмешивал файл старого чата
  // в новый. Живёт до конца разговора (или до явного resetFiles при смене чата):
  // ход может пережить несколько ingest'ов (SPA-навигация, дозапрос), и текст должен
  // примениться к ПЕРЕСОБРАННОМУ turnsMap без повторного запроса.
  var fileTextsByMsg = {};
  // Поколение файлового состояния. resetFiles() инкрементит его: fetch, поставленный ДО
  // смены чата, не имеет права воскресить запись уже после сброса (его завершение
  // отбрасывается по epoch, а не пишет в пустую карту нового разговора).
  var filesEpoch = 0;
  // Отложенный ре-эмит базы (дебаунс 250 мс) и ожидающие A-лайт-запросы экспорта.
  var filesEmitTimer = null;
  var filesDrainWaiters = [];

  // Ключ карты текстов: разговор + сообщение. NUL — разделитель, которого не бывает в
  // convId/message_id, поэтому склейка однозначна.
  function fileTextKey(convId, msgId) {
    return fileStr(convId) + '\u0000' + ((msgId === undefined || msgId === null) ? '' : String(msgId));
  }

  // Полный сброс файлового состояния на смену разговора. Зовётся ядром через контракт
  // __bind (resetFiles) из resetForNewConversation (core/deepseek-conv.js): текст и очередь
  // вложений принадлежат ОДНОМУ чату и не переезжают в следующий. Заодно гасим отложенный
  // ре-эмит и ожидания экспорта — они относятся к прежнему разговору.
  function resetFiles() {
    filesEpoch++;
    fileTextsByMsg = {};
    fileQueue = [];
    fileQueueByKey = {};
    fileQueueActive = 0;
    filesDrainWaiters.length = 0;
    if (filesEmitTimer !== null) { clearTimeout(filesEmitTimer); filesEmitTimer = null; }
    Fn.fileTextsByMsg = fileTextsByMsg;   // экспорт смотрит на АКТУАЛЬНУЮ карту, а не на старую
    return true;
  }

  // Канал диагностики: aiCmDiagWarn — глобал utils/debug.js (канал B); в модульных
  // песочницах без него падаем на console.warn, но НИКОГДА не молчим в catch.
  function filesWarn(tag, msg, e) {
    // Канал B: bare console.warn запрещён стражем tests/no-bare-console-warn.test.js.
    // Нет aiCmDiagWarn (срез-песочница) — молчим, кольцо диагностики ведёт debug.js.
    if (typeof aiCmDiagWarn === 'function') aiCmDiagWarn(tag, msg, e);
  }

  function fileStr(v) {
    return (typeof v === 'string') ? v : '';
  }

  // Строка диагностики под гейтом aiCmDebug (utils/debug.js сам решает, печатать ли).
  // В срез-песочницах без хелпера молчим: диагностика не имеет права ломать догрузку.
  function filesDiag(tag, fields) {
    if (typeof aiCmDiagLine === 'function') aiCmDiagLine(tag, fields);
  }

  // Тело ответа может прийти JSON-ом, JSON-строкой или сырым текстом — пробуем оба слоя.
  function fileMaybeJson(raw) {
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s) return null;
    var c = s.charAt(0);
    if (c !== '{' && c !== '[') return null;
    try { return JSON.parse(s); } catch (eParse) {
      filesWarn('deepseek:files:parse', '[deepseek-intercept] тело вложения не JSON:', eParse);
      return null;
    }
  }

  // Первая непустая строка по списку ключей (в т.ч. вложенный объект — на один уровень).
  function fileFirstText(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object') {
        for (var j = 0; j < keys.length; j++) {
          var v2 = v[keys[j]];
          if (typeof v2 === 'string' && v2) return v2;
        }
      }
    }
    return '';
  }

  // Ссылка на файл из объекта метаданных (fragment/files/attachments): id + подписанный путь.
  // Картинки (is_image:true или ty=p в готовом URL) в очередь ТЕКСТА не попадают: у них нет
  // текстового содержимого, а ty=p отдаёт превью, а не тело документа.
  function fileRefFromObject(o) {
    if (!o || typeof o !== 'object') return null;
    var id = o.file_id || o.fileId || o.id || o.fid || '';
    if (typeof id === 'number') id = String(id);
    id = fileStr(id);
    if (!id) return null;
    var signed = fileFirstText(o, ['signed_path', 'signedPath', 'path', 'url', 'download_url', 'file_path']);
    var name = fileFirstText(o, ['file_name', 'filename', 'name', 'title']);
    var ty = fileStr(o.ty).toLowerCase();
    if (!ty && signed) {
      var mTy = /[?&]ty=([a-z])/i.exec(signed);
      if (mTy) ty = mTy[1].toLowerCase();
    }
    // v2.0.37: тип и размер нужны, чтобы отличить PDF от прочих «нечитаемых» файлов
    // и уехать в pdf.js-ветку (сайт кладёт тип в file_type/content_type).
    var mime = fileFirstText(o, ['file_type', 'fileType', 'content_type', 'contentType', 'mime', 'mime_type', 'mimeType']);
    var sizeRaw = (o.size !== undefined && o.size !== null) ? o.size : ((o.file_size !== undefined) ? o.file_size : o.fileSize);
    var size = parseInt(sizeRaw, 10);
    if (!isFinite(size) || size < 0) size = 0;
    return {
      fileId: id,
      signedPath: signed || '',
      name: name || '',
      mime: fileStr(mime),
      size: size,
      isImage: (o.is_image === true || o.isImage === true || ty === 'p'),
      isPdf: /application\/pdf/i.test(fileStr(mime)) || /\.pdf$/i.test(name || '')
    };
  }

  // Метка-строка (фрагмент FILE иногда приходит текстом или JSON-строкой) — мягкий разбор.
  function fileRefFromText(text) {
    var s = fileStr(text);
    if (!s) return null;
    var obj = null;
    if (s.charAt(0) === '{' || s.charAt(0) === '[') obj = fileMaybeJson(s);
    if (obj && typeof obj === 'object') return fileRefFromObject(obj);
    var m = s.match(/(?:file[_-]?id|fileId)["'\s:=]+([A-Za-z0-9_-]{6,})/);
    if (!m) return null;
    return { fileId: m[1], signedPath: '', name: '', mime: '', size: 0, isImage: false, isPdf: false };
  }

  // Настоящий id файла сайт раздаёт как UUID (36 символов) или `file-…`; числовой «id»
  // вида `1` приезжает из попутных JSON-полей фрагмента и файлом не является: по нему нет
  // ни подписи, ни имени, сервер отвечает 400 без access-control-allow-origin → в текст
  // хода уезжала пустая метка `[FILE: 1 — текст не получен: network]` на каждом сообщении.
  var FILES_JUNK_ID_RE = /^\d{1,7}$/;

  // Ссылка осмысленна, если её можно скачать (есть подпись), либо у неё есть имя —
  // тогда даже неудача полезна: в экспорте видно, ЧТО не дочиталось.
  function filesRefUsable(ref) {
    if (fileStr(ref.signedPath)) return true;
    if (fileStr(ref.name)) return true;
    return !FILES_JUNK_ID_RE.test(fileStr(ref.fileId));
  }

  function filesPushRef(out, seen, ref) {
    if (!ref || !ref.fileId || seen[ref.fileId] || ref.isImage) return;
    if (!filesRefUsable(ref)) {
      filesDiag('deepseek-files-ref-skip', { fileId: ref.fileId, name: ref.name || '' });
      return;
    }
    seen[ref.fileId] = 1;
    out.push(ref);
  }

  // Все ссылки на файлы одного сообщения. Формы протокола (проверяются все):
  // fragments[].type === 'FILE' (объект или строка), fragments[].files[], msg.files[],
  // msg.attachments[] (иногда attachments лежат внутри fragments[] — тоже смотрим).
  function extractFileRefs(msg) {
    var out = [];
    var seen = {};
    if (!msg || typeof msg !== 'object') return out;
    var frags = Array.isArray(msg.fragments) ? msg.fragments : [];
    for (var i = 0; i < frags.length; i++) {
      var f = frags[i];
      if (!f || typeof f !== 'object') continue;
      if (f.type === 'FILE') {
        var own = fileRefFromObject(f);
        if (!own && typeof f.content === 'string') own = fileRefFromText(f.content);
        filesPushRef(out, seen, own);
      }
      if (Array.isArray(f.files)) {
        for (var j = 0; j < f.files.length; j++) filesPushRef(out, seen, fileRefFromObject(f.files[j]));
      }
      if (Array.isArray(f.attachments)) {
        for (var k = 0; k < f.attachments.length; k++) filesPushRef(out, seen, fileRefFromObject(f.attachments[k]));
      }
    }
    if (Array.isArray(msg.files)) {
      for (var m = 0; m < msg.files.length; m++) filesPushRef(out, seen, fileRefFromObject(msg.files[m]));
    }
    if (Array.isArray(msg.attachments)) {
      for (var n = 0; n < msg.attachments.length; n++) filesPushRef(out, seen, fileRefFromObject(msg.attachments[n]));
    }
    return out;
  }

  // Есть ли у сообщения хоть одно вложение. Нужно ingest-модулю (D.8): ход из ОДНИХ
  // вложений (у пользовательского сообщения нет REQUEST-текста) обязан родиться на своём
  // месте в turnsMap — со своим order, а не хвостовой заглушкой после всего цикла.
  function messageHasRefs(msg) {
    return extractFileRefs(msg).length > 0;
  }

  // Текст файла из ответа files.deepseeksvc.com: {ok, reason, text, name, truncated}.
  function filesTextFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.code === 'number' && payload.code !== 0) {
      return { ok: false, reason: 'api-' + payload.code, text: '' };
    }
    var inner = (payload.data && typeof payload.data === 'object') ? payload.data : payload;
    var text = fileFirstText(inner, ['content', 'text', 'file_content', 'body', 'content_text']);
    if (!text && typeof payload === 'object') text = fileFirstText(payload, ['content', 'text', 'file_content']);
    if (!text) return null;
    var name = fileFirstText(inner, ['file_name', 'filename', 'name', 'title']);
    var truncated = false;
    if (text.length > FILES_TEXT_CAP) {
      text = text.slice(0, FILES_TEXT_CAP);
      truncated = true;
    }
    return { ok: true, text: text, name: name || '', truncated: truncated };
  }

  // URL тела файла: параметр называется `file_id` (не `id`) — так его ждёт файловый хост.
  // Префикс версии API `/api` — обязательная часть пути: тело отдаётся только по
  // `/api/file?...`, без префикса — 404. Готовый signed_path уже подписан сайтом:
  //   `/api/file?...` — уходит как есть (нормализуем только имя параметра `id=`);
  //   `/file?...`     — префикс `/api` дописываем принудительно;
  //   пусто/иное      — фолбэк `/api/file?file_id=<id>[&state=<подпись>]`.
  // Склейка с хостом — БАЙТ-В-БАЙТ (остальное URL-кодировать нельзя: сломает подпись).
  // `ty=r` — сырое тело файла (raw), единственное значение, которое отдаёт содержимое;
  // дописываем, если типа в URL ещё нет (`ty=p` — превью картинки, его не качаем).
  // ЛОВУШКА: `ty=t` (тип «текст») сервер отвергает с 400, а у 400-ответа НЕТ заголовка
  // `access-control-allow-origin` → браузер режет ответ как CORS-ошибку (`net::ERR_FAILED`).
  // Именно на этом три предыдущих захода («вернуть /api», «id= → file_id=», «ty=t») и умирали.
  // Сайт подписывает путь со старым именем параметра (`id=`), поэтому нормализуем ТОЛЬКО имя
  // первого параметра: `id=` в начале строки параметров либо сразу после `&` → `file_id=`;
  // прочие вхождения (значения, `file_id=`, `&xid=`) не трогаем.
  var FILES_API_PREFIX = '/api';
  function fileUrlWithTy(url) {
    return (/[?&]ty=/i).test(url) ? url : url + '&ty=r';
  }
  function resolveFileUrl(fileId, signedPath) {
    var id = (fileId === undefined || fileId === null) ? '' : String(fileId);
    var signed = fileStr(signedPath);
    var apiFilePath = FILES_API_PREFIX + '/file?';
    if (signed.indexOf(apiFilePath) === 0) {
      return fileUrlWithTy(FILES_HOST + signed.replace(/([?&])id=/, '$1file_id='));
    }
    if (signed.indexOf('/file?') === 0) {
      return fileUrlWithTy(FILES_HOST + FILES_API_PREFIX + signed.replace(/([?&])id=/, '$1file_id='));
    }
    if (signed) return fileUrlWithTy(FILES_FILE_URL + '?file_id=' + encodeURIComponent(id) + '&state=' + signed);
    return fileUrlWithTy(FILES_FILE_URL + '?file_id=' + encodeURIComponent(id.replace(/^file-/, '')));
  }

  // Секция вложения в тексте хода. Метка файла видна в экспорте (заголовок [FILE: имя]).
  // Провал догрузки НЕ прячет файл: в экспорт едет метка с причиной — иначе по экспорту
  // нельзя понять, что вложение вообще было (раньше такие файлы исчезали бесследно).
  function filesSection(rec) {
    var name = (rec && rec.name) ? rec.name : ((rec && rec.fileId) ? rec.fileId : 'attachment');
    if (rec && rec.failed) {
      return '\n\n[FILE: ' + name + ' — текст не получен' + (rec.reason ? ': ' + rec.reason : '') + ']';
    }
    var text = (rec && rec.text) ? rec.text : '';
    return '\n\n[FILE: ' + name + ']\n' + text;
  }

  function filesPendingCount() {
    // Отложенный ре-эмит считается «в полёте»: экспорт не имеет права снять базу РАНЬШЕ,
    // чем ISOLATED-мир получит текст вложения (иначе файл уйдёт без содержимого).
    return fileQueue.length + fileQueueActive + (filesEmitTimer !== null ? 1 : 0);
  }

  function filesTextCount() {
    var ids = Object.keys(fileTextsByMsg);
    var n = 0;
    for (var i = 0; i < ids.length; i++) {
      var recs = fileTextsByMsg[ids[i]] || [];
      for (var j = 0; j < recs.length; j++) {
        if (recs[j] && recs[j].text) { n++; break; }
      }
    }
    return n;
  }

  // --- протокол A-лайт: синхронный опрос состояния и асинхронное ожидание опустошения ---
  function filesStateRespond() {
    try {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent('ai-cm-deepseek-files-state-response', {
        detail: { pending: filesPendingCount(), active: fileQueueActive, queued: fileQueue.length, texts: filesTextCount() }
      }));
    } catch (eState) {
      filesWarn('deepseek:files:state', '[deepseek-intercept] состояние очереди вложений:', eState);
    }
  }

  function filesDrainRespond(requestId, detail) {
    try {
      var payload = { requestId: requestId };
      var keys = Object.keys(detail || {});
      for (var i = 0; i < keys.length; i++) payload[keys[i]] = detail[keys[i]];
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent('ai-cm-deepseek-files-drain-done', { detail: payload }));
    } catch (eDone) {
      filesWarn('deepseek:files:drain', '[deepseek-intercept] ответ на ожидание очереди:', eDone);
    }
  }

  function filesDrainSettle(w, reason) {
    var idx = filesDrainWaiters.indexOf(w);
    if (idx === -1) return;
    filesDrainWaiters.splice(idx, 1);
    if (w.timer !== null) { clearTimeout(w.timer); w.timer = null; }
    filesDrainRespond(w.requestId, {
      ok: reason === 'drained',
      drained: reason === 'drained',
      reason: reason,
      pending: filesPendingCount(),
      waitedMs: Date.now() - w.at
    });
  }

  // Вызывается после каждого завершённого элемента очереди: очередь опустела — будим экспорт.
  function filesDrainKick(reason) {
    if (!filesDrainWaiters.length || filesPendingCount() > 0) return;
    var waiters = filesDrainWaiters.slice();
    for (var i = 0; i < waiters.length; i++) filesDrainSettle(waiters[i], reason || 'drained');
  }

  function filesDrainHandle(detail) {
    var reqId = detail && detail.requestId;
    if (!reqId) return;
    var cap = (detail && typeof detail.timeoutMs === 'number' && detail.timeoutMs > 0)
      ? detail.timeoutMs : FILES_DRAIN_TIMEOUT_MS;
    if (filesPendingCount() === 0) {
      filesDrainRespond(reqId, { ok: true, drained: true, reason: 'idle', pending: 0, waitedMs: 0 });
      return;
    }
    var w = { requestId: String(reqId), at: Date.now(), timer: null };
    w.timer = setTimeout(function () { filesDrainSettle(w, 'file-queue-timeout'); }, cap);
    filesDrainWaiters.push(w);
  }

  // Слушатели ставятся на загрузке модуля (до __bind): A-лайт спрашивает состояние
  // СИНХРОННО, потому что CustomEvent в DOM доставляется синхронно в оба мира.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('ai-cm-deepseek-files-state-request', function () { filesStateRespond(); });
    window.addEventListener('ai-cm-deepseek-files-drain', function (ev) { filesDrainHandle(aiCmBridgeDetail(ev)); });
  }

  // ===== СЕКЦИЯ 15: ТЕЛА, КОТОРЫМ НУЖНО СОСТОЯНИЕ ЯДРА (BIND-зона) =====
  function __bind(d) {
    D = d;

    with (D) {
      // Роль хода для заглушки: тем же правилом, что D.8 (USER -> user, ASSISTANT -> assistant).
      function filesRole(role) {
        if (role === 'USER') return 'user';
        if (role === 'ASSISTANT') return 'assistant';
        return 'unknown';
      }

      function filesModelSlug(msg, modelSignals) {
        if (typeof getModelSlug !== 'function') return '';
        return getModelSlug(msg && msg.thinking_enabled === true, modelSignals || {});
      }

      // Следующий order для заглушки. orderCounter принадлежит ядру (rw): инкремент обязан
      // дойти до ЖИВОЙ переменной, иначе D.8 построит ходы в другом порядке.
      function filesNextOrder() {
        if (typeof orderCounter !== 'number') return 0;
        var n = orderCounter;
        orderCounter = n + 1;
        return n;
      }

      // Ход, состоящий ТОЛЬКО из вложений: D.8 его не создаст (у пользовательского хода нет
      // текста REQUEST, у ответа — RESPONSE), а экспорт обязан видеть сообщение. Заглушка
      // заводится сразу, текст приедет позже и пересоберёт t.text.
      function filesEnsureTurn(msg, modelSignals) {
        var id = String(msg.message_id);
        if (!turnsMap) return id;
        if (turnsMap[id]) return id;
        turnsMap[id] = {
          text: '',
          answer: '',
          reasoning: '',
          modelSlug: filesModelSlug(msg, modelSignals),
          order: filesNextOrder(),
          ts: msg.inserted_at || 0,
          role: filesRole(msg.role)
        };
        return id;
      }

      // Поставить все файлы сообщения в очередь. Дедуп: один convId|fileId — один запрос,
      // даже если файл приложен к нескольким ходам; msgId добавляется в карту элемента,
      // поэтому текст доедет до КАЖДОГО хода.
      function enqueueMessageFiles(convId, msg) {
        var refs = extractFileRefs(msg);
        if (!refs.length) return 0;
        var cid = fileStr(convId);
        if (!cid && typeof currentConvId === 'string') cid = currentConvId;
        var msgId = (msg && msg.message_id != null) ? String(msg.message_id) : '';
        var added = 0;
        for (var i = 0; i < refs.length; i++) {
          var ref = refs[i];
          var key = cid + '|' + ref.fileId;
          if (fileQueueByKey[key]) {
            var known = fileQueueByKey[key];
            if (msgId) {
              known.msgIds[msgId] = 1;
              known.orderByMsg[msgId] = i;
              // Ответ уже пришёл (файл приложен к НОВОМУ сообщению): из очереди элемент уже
              // вышел, filesOnFetched больше не вызовется — раскладываем сохранённый результат
              // сразу, иначе текст не доедет до нового хода никогда.
              if (known.result && typeof known.result === 'object') {
                filesPutRec(cid, msgId, filesRecFor(known, msgId));
                applyFileTextToTurn(cid, msgId);
              }
            }
            continue;
          }
          var item = {
            key: key,
            convId: cid,
            fileId: ref.fileId,
            signedPath: ref.signedPath,
            name: ref.name,
            msgIds: {},
            orderByMsg: {},
            status: 'queued',
            result: null,
            epoch: filesEpoch,
            startedAt: 0,
            doneAt: 0
          };
          if (msgId) {
            item.msgIds[msgId] = 1;
            item.orderByMsg[msgId] = i;
          }
          fileQueueByKey[key] = item;
          fileQueue.push(item);
          added++;
        }
        if (added) pumpFileQueue();
        return added;
      }

      // Точка входа из D.8 (ACCEPT-ветка): завести заглушки и поставить файлы в очередь.
      // Возвращает число поставленных в очередь файлов (0 — вложений нет).
      function enqueueChainFiles(chain, modelSignals) {
        if (!Array.isArray(chain)) return 0;
        var added = 0;
        for (var i = 0; i < chain.length; i++) {
          var msg = chain[i];
          if (!msg || msg.message_id == null) continue;
          if (!extractFileRefs(msg).length) continue;
          filesEnsureTurn(msg, modelSignals);
          added += enqueueMessageFiles(currentConvId, msg);
        }
        if (added) {
          filesDiag('deepseek-files-enqueue', {
            convId: currentConvId,
            files: added,
            queued: fileQueue.length,
            active: fileQueueActive
          });
        }
        return added;
      }

      function startFileFetch(item) {
        item.startedAt = Date.now();
        fetchFileContent(item.fileId, item.signedPath, item).then(function (res) {
          fileQueueActive--;
          if (fileQueueActive < 0) fileQueueActive = 0;
          // Разговор сменился, пока файл был в полёте: результат принадлежит прежнему чату и
          // после resetFiles() в карту не пишется (иначе сброс «воскресал» бы ответом).
          if (item.epoch !== filesEpoch) { pumpFileQueue(); return; }
          filesOnFetched(item, res);
          filesDrainKick('drained');
          pumpFileQueue();
        }, function (eFetch) {
          fileQueueActive--;
          if (fileQueueActive < 0) fileQueueActive = 0;
          if (item.epoch !== filesEpoch) { pumpFileQueue(); return; }
          item.status = 'failed';
          if (fileQueueByKey[item.key] === item) delete fileQueueByKey[item.key];
          filesDiag('deepseek-files-error', {
            fileId: item.fileId,
            reason: 'reject',
            error: (eFetch && eFetch.message) ? eFetch.message : String(eFetch)
          });
          filesWarn('deepseek:files:fetch', '[deepseek-intercept] вложение ' + item.fileId + ' не догружено:', eFetch);
          filesDrainKick('drained');
          pumpFileQueue();
        });
      }

      // FIFO с concurrency 2: берём из головы, пока в полёте меньше двух.
      function pumpFileQueue() {
        while (fileQueueActive < FILES_CONCURRENCY && fileQueue.length > 0) {
          var item = fileQueue.shift();
          if (!item || item.status !== 'queued') continue;
          item.status = 'active';
          fileQueueActive++;
          startFileFetch(item);
        }
      }

      // Запрос тела файла. originalFetch — НАТИВНЫЙ fetch, снятый ядром до хука D.7:
      // иначе собственный перехватчик перехватил бы свой же запрос вложения.
      // Ни заголовков, ни кук: файловый хост авторизует запрос подписью в signed_path, а
      // auth-заголовки чата/credentials:'include' превратили бы simple CORS-запрос в
      // credentialed и ответ без Access-Control-Allow-Credentials не прошёл бы вовсе.
      // v2.0.37: PDF опознаём по типу/имени — fileRefFromObject кладёт mime и isPdf.
      function filesPdfRef(ref) {
        if (!ref) return false;
        if (ref.isPdf === true) return true;
        if (/application\/pdf/i.test(fileStr(ref.mime))) return true;
        return /\.pdf$/i.test(fileStr(ref.name));
      }

      function filesPdfAvailable() {
        return typeof window !== 'undefined' && !!window.AiCmPdf &&
          typeof window.AiCmPdf.fromUrl === 'function';
      }

      // Байты тянет pdf-bytes.js тем же нативным fetch (подпись в URL, без кук), разбор —
      // pdf.js в offscreen-документе/event page. В очередь возвращается обычный {ok,text},
      // поэтому filesOnFetched/filesSection менять не нужно.
      function filesFetchPdf(url, ref, fetchImpl) {
        var pdf = (typeof window !== 'undefined') ? window.AiCmPdf : null;
        if (!pdf || typeof pdf.fromUrl !== 'function') {
          return Promise.resolve({ ok: false, reason: 'pdf-unavailable', text: '' });
        }
        return Promise.resolve(pdf.fromUrl(url, {
          fetch: fetchImpl,
          credentials: 'omit',
          name: fileStr(ref && ref.name),
          maxBytes: FILES_PDF_MAX,
          maxChars: FILES_TEXT_CAP,
          timeoutMs: FILES_PDF_TIMEOUT_MS
        })).then(function (r) {
          var res = r || {};
          var text = fileStr(res.text);
          return {
            ok: res.ok === true && text !== '',
            pdf: true,
            text: text,
            truncated: res.truncated === true,
            reason: fileStr(res.reason) || (res.ok === true ? '' : 'pdf-no-text')
          };
        }, function (ePdf) {
          filesWarn('deepseek:files:pdf', '[deepseek-intercept] pdf.js не разобрал PDF:', ePdf);
          return { ok: false, reason: 'pdf-host-error', text: '' };
        });
      }

      function fetchFileContent(fileId, signedPath, ref) {
        var url = resolveFileUrl(fileId, signedPath);
        var fetchImpl = (typeof originalFetch === 'function') ? originalFetch
          : ((typeof window !== 'undefined' && typeof window.fetch === 'function') ? window.fetch : null);
        if (!fetchImpl) return Promise.resolve({ ok: false, reason: 'no-fetch', text: '' });
        // v2.0.37: PDF не читаем как текст — байты и разбор отдаём pdf.js.
        if (filesPdfRef(ref) && filesPdfAvailable()) return filesFetchPdf(url, ref, fetchImpl);
        filesDiag('deepseek-files-fetch-start', {
          fileId: fileId,
          url: url,
          timeoutMs: FILES_FETCH_TIMEOUT_MS
        });
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var opts = { method: 'GET', credentials: 'omit' };
        if (ctrl && ctrl.signal) opts.signal = ctrl.signal;
        return new Promise(function (resolve) {
          var settled = false;
          var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            if (ctrl) { try { ctrl.abort(); } catch (eAbort) { filesWarn('deepseek:files:abort', '[deepseek-intercept] abort вложения:', eAbort); } }
            resolve({ ok: false, reason: 'timeout', text: '' });
          }, FILES_FETCH_TIMEOUT_MS);
          function done(res) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(res || { ok: false, reason: 'empty', text: '' });
          }
          var p;
          try { p = fetchImpl(url, opts); } catch (eFetch) {
            filesWarn('deepseek:files:fetch', '[deepseek-intercept] fetch вложения упал:', eFetch);
            done({ ok: false, reason: 'fetch-throw', text: '' });
            return;
          }
          Promise.resolve(p).then(function (res) {
            if (!res || res.ok !== true) {
              done({ ok: false, reason: 'http-' + ((res && res.status) || '?'), text: '' });
              return;
            }
            return Promise.resolve(res.text()).then(function (raw) {
              var payload = fileMaybeJson(raw);
              if (payload && typeof payload === 'object') {
                var parsed = filesTextFromPayload(payload);
                if (parsed) { done(parsed); return; }
                // JSON разобрался, но текстовых полей в нём нет — это и есть СОДЕРЖИМОЕ
                // файла (дамп API вида {"code":0,"data":{…}}). Раньше здесь стоял 'no-text',
                // и JSON-вложения уходили в экспорт пустой меткой; идём в общий фолбэк
                // ниже и отдаём сырое тело. Ошибку сервера отдал filesTextFromPayload выше.
              }
              var rawText = fileStr(raw);
              if (!rawText) { done({ ok: false, reason: 'empty-body', text: '' }); return; }
              if (rawText.length > FILES_TEXT_CAP) rawText = rawText.slice(0, FILES_TEXT_CAP);
              done({ ok: true, text: rawText, name: '', truncated: rawText.length >= FILES_TEXT_CAP });
            }, function (eBody) {
              filesWarn('deepseek:files:body', '[deepseek-intercept] тело вложения не прочитано:', eBody);
              done({ ok: false, reason: 'body-error', text: '' });
            });
          }, function (eNet) {
            filesWarn('deepseek:files:net', '[deepseek-intercept] сеть вложения:', eNet);
            done({ ok: false, reason: 'network', text: '' });
          });
        });
      }

      // Пересобрать текст хода: база (answer + reasoning, как в D.8) + секция на КАЖДЫЙ файл
      // сообщения. Раньше запоминались ОДИН fileText/fileName — второе вложение затирало первое,
      // и из четырёх файлов в экспорт попадал только последний пришедший.
      // convId обязателен: текст чужого разговора не применяется даже при совпадении message_id.
      function applyFileTextToTurn(convId, msgId) {
        if (!turnsMap || !msgId) return false;
        var cid = fileStr(convId);
        if (cid !== fileStr(currentConvId)) return false;
        var recs = fileTextsByMsg[fileTextKey(cid, msgId)];
        if (!recs || !recs.length) return false;
        var t = turnsMap[msgId];
        if (!t) return false;
        var base = (typeof t.answer === 'string') ? t.answer : '';
        var reasoning = (typeof t.reasoning === 'string') ? t.reasoning : '';
        var core = base;
        if (typeof composeTurnText === 'function') core = composeTurnText(base, reasoning);
        var text = core;
        for (var i = 0; i < recs.length; i++) text += filesSection(recs[i]);
        if (t.text === text) return false;
        t.fileTexts = recs;   // ссылка на список — для дампов/диагностики; решение по тексту ниже
        t.text = text;
        filesDiag('deepseek-files-apply', {
          msgId: msgId,
          fileId: recs[0].fileId,
          name: recs[0].name || '',
          files: recs.length,
          chars: text.length - core.length
        });
        return true;
      }

      // Применить уже скачанные тексты к СВЕЖЕМУ turnsMap (D.8 только что его пересобрал).
      // Только текущий разговор: ключ карты — `<convId>\u0000<msgId>`, чужие записи не трогаем.
      function applyPendingFileTexts() {
        if (!turnsMap) return 0;
        var cid = fileStr(currentConvId);
        var ids = Object.keys(fileTextsByMsg);
        var applied = 0;
        for (var i = 0; i < ids.length; i++) {
          var sep = ids[i].indexOf('\u0000');
          if (sep === -1 || ids[i].slice(0, sep) !== cid) continue;
          var msgId = ids[i].slice(sep + 1);
          if (!turnsMap[msgId]) continue;
          if (applyFileTextToTurn(cid, msgId)) applied++;
        }
        if (applied) scheduleFilesEmit();
        return applied;
      }

      // Ре-эмит базы с дебаунсом 250 мс. Аргументы — те же, что у прошлого эмита ядра
      // (serverTokens/chatMode): токены не пересчитываются, подпись диспатча — по turnsMap.
      // filesEmitNow — тот же эмит без ожидания дебаунса: нужен, если A-лайт уже держит
      // экспорт и ждать 250 мс нельзя (иначе файл снимается раньше, чем текст доедет
      // до ISOLATED-мира). После эмита будим ожидающий экспорт: очередь могла опустеть.
      function filesEmitNow() {
        if (filesEmitTimer !== null) { clearTimeout(filesEmitTimer); filesEmitTimer = null; }
        if (typeof emitBaseSnapshot === 'function') {
          var tokens = (typeof lastBaseServerTokens === 'number') ? lastBaseServerTokens : 0;
          var mode = (typeof lastBaseChatMode === 'string') ? lastBaseChatMode : '';
          try { emitBaseSnapshot(tokens, mode); } catch (eEmit) {
            filesWarn('deepseek:files:emit', '[deepseek-intercept] ре-эмит после вложения:', eEmit);
          }
        }
        filesDrainKick('drained');
      }

      function scheduleFilesEmit() {
        if (filesEmitTimer !== null) { clearTimeout(filesEmitTimer); filesEmitTimer = null; }
        filesEmitTimer = setTimeout(filesEmitNow, FILES_EMIT_DEBOUNCE_MS);
      }

      // Положить запись файла в список сообщения: замена по fileId (повторный ingest) или
      // вставка на позицию order, чтобы секции шли как вложения в чате, а не как пришли ответы.
      // Ключ карты — `<convId>\u0000<msgId>`: одинаковые message_id из разных чатов не смешиваются.
      function filesPutRec(convId, msgId, rec) {
        var key = fileTextKey(convId, msgId);
        var recs = fileTextsByMsg[key];
        if (!recs) { recs = []; fileTextsByMsg[key] = recs; }
        for (var i = 0; i < recs.length; i++) {
          if (recs[i] && recs[i].fileId === rec.fileId) { recs[i] = rec; return; }
        }
        var pos = recs.length;
        for (var j = 0; j < recs.length; j++) {
          if ((recs[j].order || 0) > (rec.order || 0)) { pos = j; break; }
        }
        recs.splice(pos, 0, rec);
      }

      // Запись файла для конкретного хода из уже полученного ответа (item.result). Один и тот
      // же ответ раскладывается и по msgId первого снимка, и по msgId, который приехал позже
      // (файл приложен повторно к новому сообщению): тело второй раз не качаем.
      function filesRecFor(item, msgId) {
        var res = item.result || {};
        var ok = res.ok === true && !!res.text;
        return {
          convId: fileStr(item.convId),
          fileId: item.fileId,
          name: res.name || item.name || '',
          text: ok ? res.text : '',
          truncated: ok ? (res.truncated === true) : false,
          failed: !ok,
          reason: ok ? '' : (res.reason || 'empty'),
          order: item.orderByMsg[msgId] || 0,
          at: item.doneAt || Date.now()
        };
      }

      // Пришёл ответ по файлу: разложить текст по всем msgId элемента, пересобрать ходы,
      // переопубликовать базу. Ошибка — метка-заглушка в тексте хода + лог: очередь идёт дальше.
      function filesOnFetched(item, res) {
        item.doneAt = Date.now();
        item.result = (res && typeof res === 'object') ? res : { ok: false, reason: 'empty', text: '' };
        var ids = Object.keys(item.msgIds);
        var ok = item.result.ok === true && !!item.result.text;
        if (!ok) {
          item.status = 'failed';
          // Провал не должен «залипать» в дедупе: следующий ingest обязан попробовать снова.
          if (fileQueueByKey[item.key] === item) delete fileQueueByKey[item.key];
        } else {
          item.status = 'done';
        }
        var applied = 0;
        for (var i = 0; i < ids.length; i++) {
          // Метка с причиной и на провале: файл остаётся виден в экспорте, даже если тело не пришло.
          filesPutRec(item.convId, ids[i], filesRecFor(item, ids[i]));
          if (applyFileTextToTurn(item.convId, ids[i])) applied++;
        }
        if (!ok) {
          filesDiag('deepseek-files-error', {
            fileId: item.fileId,
            reason: item.result.reason || 'empty',
            ms: item.doneAt - item.startedAt
          });
          filesWarn('deepseek:files:fetch', '[deepseek-intercept] текст вложения не получен: fileId=' +
            item.fileId + ' reason=' + (item.result.reason || '-'));
          scheduleFilesEmit();
          return;
        }
        filesDiag('deepseek-files-fetch-done', {
          fileId: item.fileId,
          chars: item.result.text.length,
          truncated: item.result.truncated === true,
          ms: item.doneAt - item.startedAt,
          turns: ids.length,
          applied: applied
        });
        console.log('[deepseek-intercept] ✓ текст вложения: fileId=' + item.fileId +
          ', символов=' + item.result.text.length + (item.result.truncated === true ? ' (обрезан)' : '') +
          ', ходов=' + ids.length + ', применено=' + applied);
        scheduleFilesEmit();
      }

      // Снимок очереди для отладки/тестов (не влияет на протокол).
      function fileQueueStats() {
        return {
          queued: fileQueue.length,
          active: fileQueueActive,
          pending: filesPendingCount(),
          texts: filesTextCount(),
          keys: Object.keys(fileTextsByMsg)
        };
      }

      Fn.enqueueChainFiles = enqueueChainFiles;
      Fn.applyPendingFileTexts = applyPendingFileTexts;
      Fn.extractFileRefs = extractFileRefs;
      Fn.filesMessageHasRefs = messageHasRefs;
      Fn.fetchFileContent = fetchFileContent;
      Fn.fileQueueStats = fileQueueStats;
      Fn.fileTextsByMsg = fileTextsByMsg;
      Fn.resetFiles = resetFiles;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekFiles = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
