/**
 * core/deepseek-files.js — Step D.10 (Вариант B + A-лайт): асинхронная догрузка ТЕКСТА
 * вложений DeepSeek в MAIN-мире.
 *
 * Зачем: фрагмент типа FILE в history_messages/completion несёт только МЕТАДАННЫЕ файла
 * (file_id/имя), а тело лежит на ОТДЕЛЬНОМ файловом хосте:
 *   GET https://files.deepseeksvc.com/file?file_id=<id>[&state=<signed_path>]
 * Без текста вложения ход в экспорте состоит из одной метки, то есть файл (PDF/док)
 * теряет содержимое.
 *
 * Что делает модуль (Вариант B — асинхронная догрузка):
 *   • при ПРИЁМКЕ авторитетного снимка (D.8, ветка ACCEPT) ядро отдаёт цепочку ходов сюда —
 *     enqueueChainFiles(chain, chatModelSignals): из каждого хода вынимаются ссылки на файлы
 *     (fragment.type === 'FILE', fragment.files[], msg.files[], msg.attachments[]), в turnsMap
 *     заводится ход-заглушка, если сообщение состоит ТОЛЬКО из вложений;
 *   • файлы ставятся в FIFO-очередь (concurrency 2, дедуп по `convId|fileId`: один файл,
 *     приложенный к нескольким ходам, качается ОДИН раз);
 *   • fetchFileContent(fileId, signedPath) идёт ЧЕРЕЗ originalFetch (снят ядром до хука D.7)
 *     на files.deepseeksvc.com, БЕЗ заголовков и БЕЗ кук (credentials:'omit': файловый хост
 *     авторизует запрос подписью в signed_path, а credentialed CORS-запрос ломает ответ), таймаут
 *     10 с и кап 500 000 символов;
 *   • при получении текста обновляется fileTextsByMsg (msgId → текст) и ПЕРЕСОБИРАЕТСЯ текст
 *     хода: composeTurnText(answer, reasoning) + секция
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
 *   модуль -> ядро: enqueueChainFiles / applyPendingFileTexts (форвардеры ядра).
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
  var FILES_TEXT_CAP = 500000;        // символов текста на файл (жёсткий кап)
  var FILES_FETCH_TIMEOUT_MS = 10000; // запрос тела файла
  var FILES_EMIT_DEBOUNCE_MS = 250;   // ре-эмит базы после прихода текста
  var FILES_DRAIN_TIMEOUT_MS = 2000;  // A-лайт: ожидание опустошения очереди у экспорта
  // Файловый хост DeepSeek (проверено по бандлу сайта и трафику): тело вложения отдаёт
  // files.deepseeksvc.com, а не chat.deepseek.com. Параметр файла — `file_id` (не `id`),
  // `ty=r` не передаём; ty=p — превью картинки (его не качаем, см. extractFileRefs).
  // Путь — `/file`, БЕЗ префикса `/api` (живой 404 при `/api/...`).
  var FILES_HOST = 'https://files.deepseeksvc.com';
  var FILES_FILE_URL = 'https://files.deepseeksvc.com/file';

  // Очередь: FIFO-массив элементов + карта дедупа по `convId|fileId` + счётчик активных.
  // Элемент: { key, convId, fileId, signedPath, name, msgIds:{}, status, startedAt, doneAt }.
  var fileQueue = [];
  var fileQueueByKey = {};
  var fileQueueActive = 0;
  // Результат: msgId -> { fileId, name, text, truncated, at }. Живёт до конца жизни страницы:
  // ход может пережить несколько ingest'ов (SPA-навигация, дозапрос), и текст должен
  // примениться к ПЕРЕСОБРАННОМУ turnsMap без повторного запроса.
  var fileTextsByMsg = {};
  // Отложенный ре-эмит базы (дебаунс 250 мс) и ожидающие A-лайт-запросы экспорта.
  var filesEmitTimer = null;
  var filesDrainWaiters = [];

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
    return {
      fileId: id,
      signedPath: signed || '',
      name: name || '',
      isImage: (o.is_image === true || o.isImage === true || ty === 'p')
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
    return { fileId: m[1], signedPath: '', name: '', isImage: false };
  }

  function filesPushRef(out, seen, ref) {
    if (!ref || !ref.fileId || seen[ref.fileId] || ref.isImage) return;
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
  // Готовый signed_path — уже подписанный сайтом путь `/file?file_id=...`: склеиваем его с
  // хостом БАЙТ-В-БАЙТ (URL-кодировать нельзя — сломает подпись) и НЕ дописываем ничего:
  // `ty=r` сайт не требует, а его добавление ломало запрос.
  function resolveFileUrl(fileId, signedPath) {
    var id = (fileId === undefined || fileId === null) ? '' : String(fileId);
    var signed = fileStr(signedPath);
    if (signed.indexOf('/file?') === 0) return FILES_HOST + signed;
    if (signed) return FILES_FILE_URL + '?file_id=' + encodeURIComponent(id) + '&state=' + signed;
    return FILES_FILE_URL + '?file_id=' + encodeURIComponent(id.replace(/^file-/, ''));
  }

  // Секция вложения в тексте хода. Метка файла видна в экспорте (заголовок [FILE: имя]).
  function filesSection(rec) {
    var name = (rec && rec.name) ? rec.name : ((rec && rec.fileId) ? rec.fileId : 'attachment');
    var text = (rec && rec.text) ? rec.text : '';
    return '\n\n[FILE: ' + name + ']\n' + text;
  }

  function filesPendingCount() {
    // Отложенный ре-эмит считается «в полёте»: экспорт не имеет права снять базу РАНЬШЕ,
    // чем ISOLATED-мир получит текст вложения (иначе файл уйдёт без содержимого).
    return fileQueue.length + fileQueueActive + (filesEmitTimer !== null ? 1 : 0);
  }

  function filesTextCount() {
    return Object.keys(fileTextsByMsg).length;
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
    window.addEventListener('ai-cm-deepseek-files-drain', function (ev) { filesDrainHandle(ev && ev.detail); });
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
            if (msgId) fileQueueByKey[key].msgIds[msgId] = 1;
            continue;
          }
          var item = {
            key: key,
            convId: cid,
            fileId: ref.fileId,
            signedPath: ref.signedPath,
            name: ref.name,
            msgIds: {},
            status: 'queued',
            startedAt: 0,
            doneAt: 0
          };
          if (msgId) item.msgIds[msgId] = 1;
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
        fetchFileContent(item.fileId, item.signedPath).then(function (res) {
          fileQueueActive--;
          if (fileQueueActive < 0) fileQueueActive = 0;
          filesOnFetched(item, res);
          filesDrainKick('drained');
          pumpFileQueue();
        }, function (eFetch) {
          fileQueueActive--;
          if (fileQueueActive < 0) fileQueueActive = 0;
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
      function fetchFileContent(fileId, signedPath) {
        var url = resolveFileUrl(fileId, signedPath);
        var fetchImpl = (typeof originalFetch === 'function') ? originalFetch
          : ((typeof window !== 'undefined' && typeof window.fetch === 'function') ? window.fetch : null);
        if (!fetchImpl) return Promise.resolve({ ok: false, reason: 'no-fetch', text: '' });
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
                done({ ok: false, reason: 'no-text', text: '' });
                return;
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

      // Пересобрать текст хода: база (answer + reasoning, как в D.8) + секция файла.
      function applyFileTextToTurn(msgId, rec) {
        if (!turnsMap || !rec || !rec.text) return false;
        var t = turnsMap[msgId];
        if (!t) return false;
        if (t.fileText === rec.text && t.fileName === (rec.name || '')) return false;
        var base = (typeof t.answer === 'string') ? t.answer : '';
        var reasoning = (typeof t.reasoning === 'string') ? t.reasoning : '';
        var core = base;
        if (typeof composeTurnText === 'function') core = composeTurnText(base, reasoning);
        t.fileText = rec.text;
        t.fileName = rec.name || '';
        t.text = core + filesSection(rec);
        filesDiag('deepseek-files-apply', {
          msgId: msgId,
          fileId: rec.fileId,
          chars: rec.text.length,
          name: rec.name || ''
        });
        return true;
      }

      // Применить уже скачанные тексты к СВЕЖЕМУ turnsMap (D.8 только что его пересобрал).
      function applyPendingFileTexts() {
        if (!turnsMap) return 0;
        var ids = Object.keys(fileTextsByMsg);
        var applied = 0;
        for (var i = 0; i < ids.length; i++) {
          if (!turnsMap[ids[i]]) continue;
          if (applyFileTextToTurn(ids[i], fileTextsByMsg[ids[i]])) applied++;
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

      // Пришёл ответ по файлу: разложить текст по всем msgId элемента, пересобрать ходы,
      // переопубликовать базу. Ошибка — только лог: очередь идёт дальше.
      function filesOnFetched(item, res) {
        item.doneAt = Date.now();
        if (!res || res.ok !== true || !res.text) {
          item.status = 'failed';
          // Провал не должен «залипать» в дедупе: следующий ingest обязан попробовать снова.
          if (fileQueueByKey[item.key] === item) delete fileQueueByKey[item.key];
          filesDiag('deepseek-files-error', {
            fileId: item.fileId,
            reason: (res && res.reason) || 'empty',
            ms: item.doneAt - item.startedAt
          });
          filesWarn('deepseek:files:fetch', '[deepseek-intercept] текст вложения не получен: fileId=' +
            item.fileId + ' reason=' + ((res && res.reason) || '-'));
          return;
        }
        item.status = 'done';
        var rec = {
          fileId: item.fileId,
          name: res.name || item.name || '',
          text: res.text,
          truncated: res.truncated === true,
          at: item.doneAt
        };
        var ids = Object.keys(item.msgIds);
        var applied = 0;
        for (var i = 0; i < ids.length; i++) {
          fileTextsByMsg[ids[i]] = rec;
          if (applyFileTextToTurn(ids[i], rec)) applied++;
        }
        filesDiag('deepseek-files-fetch-done', {
          fileId: item.fileId,
          chars: res.text.length,
          truncated: rec.truncated,
          ms: item.doneAt - item.startedAt,
          turns: ids.length,
          applied: applied
        });
        console.log('[deepseek-intercept] ✓ текст вложения: fileId=' + item.fileId +
          ', символов=' + res.text.length + (rec.truncated ? ' (обрезан)' : '') +
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
      Fn.fetchFileContent = fetchFileContent;
      Fn.fileQueueStats = fileQueueStats;
      Fn.fileTextsByMsg = fileTextsByMsg;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekFiles = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
