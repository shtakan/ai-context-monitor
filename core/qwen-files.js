/**
 * core/qwen-files.js — R2: экспорт вложений Qwen с ТЕКСТОМ (MAIN-мир).
 *
 * Зачем: сообщение Qwen с вложением несёт в истории только МЕТАДАННЫЕ файла
 * (node.files[]: id, name, file_type, size, status, url), а тело лежит на CDN
 * `cdn.qwenlm.ai` по ПРЕДПОДПИСАННОЙ ссылке вида
 *   https://cdn.qwenlm.ai/<userId>/<fileId>_<имя>?key=<JWT>
 * (в JWT нет `exp` — ссылка живёт, пока жив чат). Без текста вложение в экспорте
 * остаётся пустой меткой, и содержимое файла теряется.
 *
 * Что делает модуль:
 *   • перехватчик (core/qwen-intercept.js) на каждом ходе истории отдаёт сюда
 *     вложения ВОПРОСА — qfEnqueueUserFiles(chatId, userKey, files[]);
 *   • метаданные нормализуются (url/id/name/mime/size/isImage/status), мусорные
 *     записи отсекаются, картинки и нетекстовые файлы в очередь НЕ попадают
 *     (у них нет извлекаемого текста — в экспорт едет метка с типом и размером);
 *   • текстовые файлы идут в FIFO-очередь (concurrency 2, дедуп `chatId|fileKey`:
 *     один файл, приложенный к двум сообщениям, качается ОДИН раз);
 *   • тело качается через originalFetch (нативный fetch, снятый перехватчиком до
 *     собственного хука), credentials:'omit' и БЕЗ заголовков: CDN отдаёт
 *     `access-control-allow-origin: https://chat.qwen.ai` и не принимает
 *     credentialed-запрос; таймаут 10 с, кап 200 000 символов на файл и
 *     2 000 000 на чат (жёсткие лимиты задачи R2);
 *   • готовый текст складывается в карту `<chatId>\u0000<userKey>` и секцией
 *     «\n\n[FILE: <имя>]\n<текст>» дописывается к тексту ПОЛЬЗОВАТЕЛЬСКОГО хода
 *     (emitSnapshot перехватчика: userText + qfSectionsFor); после прихода текста
 *     с дебаунсом 250 мс просим ядро переопубликовать базу;
 *   • протокол ожидания очереди перед композицией файла — тот же, что у DeepSeek
 *     (core/base-handler.js): события `ai-cm-deepseek-files-state-request`,
 *     `-state-response`, `-drain`, `-drain-done`. Имена исторические (протокол
 *     общий), поэтому ISOLATED-стороне не нужен второй набор обработчиков.
 *
 * Контракт связки (как у core/deepseek-files.js): перехватчик -> модуль ТОЛЬКО
 * через __bind(deps). Имена:
 *   fn (2): emitSnapshot — форвардер снимка (ре-эмит после прихода текста);
 *           diagLine — строка диагностики под гейтом aiCmDebug.
 *   ro (3): get currentChatId — ключ карты и граница чата;
 *           get originalFetch — нативный fetch для тела файла;
 *           get lastEmitMeta  — serverTokens/complete последнего снимка: ре-эмит
 *           повторяет их как есть (токены не пересчитываются, незавершённая
 *           пагинация не объявляется полной).
 *   Сброс: перехватчик зовёт qfReset(chatId) на SPA-переходе — очередь и тексты
 *   вложений принадлежат ОДНОМУ чату и не переезжают в следующий.
 *
 * Приватность: URL файла (в нём JWT-подпись) НЕ уходит ни в экспорт, ни в
 * диагностику. В секцию попадают только имя, mime и размер.
 *
 * Жизненный цикл: документ-скоуп MAIN-мира, живёт столько же, сколько ядро.
 * Повторная загрузка гардится (window.AiCmQwenFiles).
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmQwenFiles) return;

  // Зависимости ядра. Заполняется ровно один раз через __bind(...) из core/qwen-intercept.js.
  var D = null;
  var Fn = {};

  // ===== СЕКЦИЯ 1: КОНСТАНТЫ И СОСТОЯНИЕ =====
  // Лимиты R2: одно вложение не имеет права раздуть память (200 000 символов),
  // чат — 2 000 000, запрос — 10 с; тело больше 8 МБ не читаем вовсе.
  var QF_CONCURRENCY = 2;          // одновременно в полёте (FIFO, остальное ждёт)
  var QF_TEXT_CAP = 200000;        // символов текста на файл (ЖЁСТКИЙ кап задачи)
  var QF_TOTAL_CAP = 2000000;      // символов текста на чат (сумма по всем файлам)
  var QF_TIMEOUT_MS = 10000;       // запрос тела файла
  var QF_EMIT_DEBOUNCE_MS = 250;   // ре-эмит базы после прихода текста
  var QF_DRAIN_TIMEOUT_MS = 6000;  // ожидание опустошения очереди у экспорта
  var QF_BODY_MAX = 8 * 1024 * 1024; // body-max (content-length): больше — не читаем
  // v2.0.37 (PDF): файл PDF (в пределах 10 МиБ) скачивает и разбирает pdf.js —
  // байты идут через MAIN-хелпер core/pdf-bytes.js, текст возвращается как текст.
  var QF_PDF_MAX = 10 * 1024 * 1024;
  var QF_PDF_TIMEOUT_MS = 15000;

  // Карта сообщений: `<chatId>\u0000<userKey>` -> { chatId, userKey, refs:[], recs:{} }.
  // Ключ включает chatId: одинаковый userKey из другого чата не подмешивает чужие файлы.
  var qfMsgs = {};
  // Израсходованный кап чата: chatId -> символов уже отдано в текст.
  var qfCharsByChat = {};
  // Очередь: FIFO-массив элементов + карта дедупа `chatId|fileKey` + счётчик активных.
  // Элемент: { dedupeKey, chatId, fileKey, url, name, mime, size, targets:{}, result, state, epoch }.
  var qfQueue = [];
  var qfQueueByKey = {};
  var qfActive = 0;
  // Поколение файлового состояния: qfReset() инкрементит его, и fetch, поставленный
  // ДО смены чата, не имеет права записать результат в карту нового разговора.
  var qfEpoch = 0;
  var qfEmitTimer = null;
  var qfDrainWaiters = [];

  // ===== СЕКЦИЯ 2: ХЕЛПЕРЫ (PURE-зона) =====

  function qfStr(v) {
    return (typeof v === 'string') ? v : '';
  }

  function qfNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    return 0;
  }

  // Ключ карты: разговор + пользовательский ход. NUL-разделитель не встречается
  // ни в chatId, ни в userKey, поэтому склейка однозначна.
  function qfKey(chatId, userKey) {
    return qfStr(chatId) + '\u0000' + qfStr(userKey);
  }

  function qfCurrentChatId() {
    try {
      return (D && typeof D.currentChatId === 'string') ? D.currentChatId : '';
    } catch (eChat) { return ''; }
  }

  function qfBridgeDetail(ev) {
    // v2.0.29 (Xray/Firefox): detail моста приходит СТРОКОЙ (JSON.stringify в
    // core/base-handler.js). Объект чужого компартмента Firefox отдаёт MAIN-миру
    // под Xray-обёрткой, и чтение его полей падает «Permission denied». Разбираем
    // строку; объект принимаем как есть (старые отправители, фикстуры jsdom).
    var raw = (ev && ev.detail !== undefined) ? ev.detail : null;
    if (typeof raw !== 'string') return raw || null;
    try { return JSON.parse(raw); } catch (eBd) { return null; }
  }

  // Диагностика: канал B (utils/debug.js) — bare console.warn запрещён стражем
  // tests/no-bare-console-warn.test.js. Тег получает префикс qwen-files-.
  function qfDiag(tag, fields) {
    try {
      if (typeof aiCmDiagLine === 'function') { aiCmDiagLine('qwen-files-' + tag, fields); return; }
      if (D && typeof D.diagLine === 'function') D.diagLine('files-' + tag, fields);
    } catch (eDiag) { }
  }

  function qfWarn(tag, msg, e) {
    if (typeof aiCmDiagWarn === 'function') aiCmDiagWarn(tag, msg, e);
  }

  // ===== СЕКЦИЯ 3: НОРМАЛИЗАЦИЯ ВЛОЖЕНИЙ =====
  // Живая форма (измерено на trafic chat.qwen.ai): { id, name, url, file_type, size,
  // status:'uploaded', type:'file'|'image', file_class:'vision' }. Формы ниже
  // защитные: id бывает в o.file.id, имя — в o.file.filename, mime — в o.file.meta.
  function qfRefFromEntry(o) {
    if (!o || typeof o !== 'object') return null;
    var fileObj = (o.file && typeof o.file === 'object') ? o.file : null;
    var meta = (fileObj && fileObj.meta && typeof fileObj.meta === 'object') ? fileObj.meta : null;
    var id = o.id || (fileObj && fileObj.id) || o.file_id || '';
    if (typeof id === 'number') id = String(id);
    id = qfStr(id);
    var url = qfStr(o.url) || qfStr(o.download_url) || (fileObj && qfStr(fileObj.url)) || '';
    var name = qfStr(o.name) || (fileObj && (qfStr(fileObj.filename) || qfStr(fileObj.name))) || id;
    var mime = qfStr(o.file_type) || (fileObj && qfStr(fileObj.file_type)) ||
      (meta && qfStr(meta.content_type)) || '';
    var size = qfNum(o.size);
    if (!size && fileObj) size = qfNum(fileObj.size);
    if (!size && meta) size = qfNum(meta.size);
    var isImg = (o.type === 'image') || (o.file_class === 'vision') || /^image\//i.test(mime);
    var status = qfStr(o.status);
    if (!name && !id && !url) return null;
    return {
      url: url,
      id: id,
      name: name || 'attachment',
      mime: mime,
      size: size,
      isImage: isImg,
      status: status,
      // Ключ дедупа внутри чата: id, а при его отсутствии — имя+размер.
      fileKey: id || (name + '|' + size)
    };
  }

  // Текстовое ли содержимое. MIME — первый признак, расширение — второй (CDN отдаёт
  // application/octet-stream на .md и .txt, живой кейс 2026-10-28).
  var QF_TEXT_MIME_RE = /^text\/[a-z0-9.+-]*$/i;
  var QF_TEXT_APP_RE = /^application\/(json|jsonl|xml|xhtml\+xml|javascript|ecmascript|x-yaml|yaml|rtf|graphql|sql|x-sh|x-httpd-php|x-python|x-typescript|x-csh)$/i;
  var QF_TEXT_EXT_RE = /\.(txt|text|md|markdown|json|jsonl|csv|tsv|log|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|ps1|bat|cmd|html|htm|css|scss|less|yml|yaml|toml|ini|cfg|conf|env|sql|xml|xsd|diff|patch|srt|vtt)$/i;

  function qfIsTextual(ref) {
    var mime = qfStr(ref && ref.mime);
    if (mime && QF_TEXT_MIME_RE.test(mime)) return true;
    if (mime && QF_TEXT_APP_RE.test(mime)) return true;
    return QF_TEXT_EXT_RE.test(qfStr(ref && ref.name));
  }

  // v2.0.37: PDF — отдельный источник текста (pdf.js), а не «неизвлекаемое».
  function qfIsPdf(ref) {
    if (/application\/pdf/i.test(qfStr(ref && ref.mime))) return true;
    return /\.pdf$/i.test(qfStr(ref && ref.name));
  }

  function qfPdfAvailable() {
    return typeof window !== 'undefined' && !!window.AiCmPdf &&
      typeof window.AiCmPdf.fromUrl === 'function';
  }

  function qfBytes(n) {
    var v = qfNum(n);
    return (v > 0) ? (String(v) + ' Б') : 'размер неизвестен';
  }

  // Метка «текст не извлекается»: файл ВИДЕН в экспорте (имя, тип, размер), но
  // его содержимое не может стать текстом без стороннего парсера.
  function qfNote(ref) {
    var mime = qfStr(ref && ref.mime) || 'binary/octet-stream';
    if (ref && ref.isImage) return mime + ', ' + qfBytes(ref.size) + '; изображение не выгружается';
    return mime + ', ' + qfBytes(ref.size) + '; текст не извлекается';
  }

  // Секция вложения в тексте хода. Провал догрузки НЕ прячет файл: в экспорт едет
  // метка с причиной, иначе по файлу нельзя понять, что вложение вообще было.
  // ВНИМАНИЕ: url/подпись сюда не попадают ни при каком исходе.
  function qfSection(rec) {
    var name = qfStr(rec && rec.name) || 'attachment';
    if (rec && rec.ok === true && qfStr(rec.text)) {
      return '\n\n[FILE: ' + name + ']\n' + rec.text;
    }
    if (rec && qfStr(rec.note)) {
      return '\n\n[FILE: ' + name + ' — ' + rec.note + ']';
    }
    var reason = qfStr(rec && rec.reason);
    return '\n\n[FILE: ' + name + ' — текст не получен' + (reason ? ': ' + reason : '') + ']';
  }

  // ===== СЕКЦИЯ 4: КАРТА СООБЩЕНИЙ (чтение для экспорта) =====

  function qfMsgEntry(chatId, userKey) {
    var key = qfKey(chatId, userKey);
    var m = qfMsgs[key];
    if (!m) {
      m = { chatId: qfStr(chatId), userKey: qfStr(userKey), refs: [], recs: {} };
      qfMsgs[key] = m;
    }
    return m;
  }

  // Секции файлов хода — ровно в порядке вложений сообщения. Пустая строка, если
  // вложений нет (или они ещё в очереди: незавершённый файл не пишется в базу,
  // экспорт ждёт очередь через протокол drain).
  function qfSectionsFor(chatId, userKey) {
    var m = qfMsgs[qfKey(chatId, userKey)];
    if (!m || !m.refs.length) return '';
    var out = '';
    for (var i = 0; i < m.refs.length; i++) {
      var rec = m.recs[m.refs[i].fileKey];
      if (rec) out += qfSection(rec);
    }
    return out;
  }

  // Длина тех же секций БЕЗ сборки строки наружу — часть подписи снимка
  // (buildSignature перехватчика): иначе приход текста файла не меняет сигнатуру
  // (turns не тронуты), и ре-эмит глушится дедупом same-signature.
  function qfSectionLength(chatId, userKey) {
    var m = qfMsgs[qfKey(chatId, userKey)];
    if (!m || !m.refs.length) return 0;
    var n = 0;
    for (var i = 0; i < m.refs.length; i++) {
      var rec = m.recs[m.refs[i].fileKey];
      if (rec) n += qfSection(rec).length;
    }
    return n;
  }

  function qfTextsCount() {
    var keys = Object.keys(qfMsgs);
    var n = 0;
    for (var i = 0; i < keys.length; i++) {
      var m = qfMsgs[keys[i]];
      if (!m) continue;
      var fk = Object.keys(m.recs);
      for (var j = 0; j < fk.length; j++) {
        if (m.recs[fk[j]] && qfStr(m.recs[fk[j]].text)) { n++; break; }
      }
    }
    return n;
  }

  function qfPendingCount() {
    // Отложенный ре-эмит считается «в полёте»: экспорт не имеет права снять базу
    // РАНЬШЕ, чем ISOLATED-мир получит текст вложения.
    return qfQueue.length + qfActive + (qfEmitTimer !== null ? 1 : 0);
  }

  // ===== СЕКЦИЯ 5: ПРОТОКОЛ ОЖИДАНИЯ ОЧЕРЕДИ (A-лайт) =====
  function qfStateRespond() {
    try {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent('ai-cm-deepseek-files-state-response', {
        detail: {
          pending: qfPendingCount(),
          active: qfActive,
          queued: qfQueue.length,
          texts: qfTextsCount()
        }
      }));
    } catch (eState) {
      qfWarn('qwen:files:state', '[qwen-files] состояние очереди вложений:', eState);
    }
  }

  function qfDrainRespond(requestId, detail) {
    try {
      var payload = { requestId: requestId };
      var keys = Object.keys(detail || {});
      for (var i = 0; i < keys.length; i++) payload[keys[i]] = detail[keys[i]];
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent('ai-cm-deepseek-files-drain-done', { detail: payload }));
    } catch (eDone) {
      qfWarn('qwen:files:drain', '[qwen-files] ответ на ожидание очереди:', eDone);
    }
  }

  function qfDrainSettle(w, reason) {
    var idx = qfDrainWaiters.indexOf(w);
    if (idx === -1) return;
    qfDrainWaiters.splice(idx, 1);
    if (w.timer !== null) { clearTimeout(w.timer); w.timer = null; }
    qfDrainRespond(w.requestId, {
      ok: reason === 'drained',
      drained: reason === 'drained',
      reason: reason,
      pending: qfPendingCount(),
      waitedMs: Date.now() - w.at
    });
  }

  // Вызывается после каждого завершённого элемента очереди и после ре-эмита:
  // очередь опустела — будим ожидающий экспорт.
  function qfDrainKick(reason) {
    if (!qfDrainWaiters.length || qfPendingCount() > 0) return;
    var waiters = qfDrainWaiters.slice();
    for (var i = 0; i < waiters.length; i++) qfDrainSettle(waiters[i], reason || 'drained');
  }

  function qfDrainHandle(detail) {
    var reqId = detail && detail.requestId;
    if (!reqId) return;
    var cap = (detail && typeof detail.timeoutMs === 'number' && detail.timeoutMs > 0)
      ? detail.timeoutMs : QF_DRAIN_TIMEOUT_MS;
    if (qfPendingCount() === 0) {
      qfDrainRespond(reqId, { ok: true, drained: true, reason: 'idle', pending: 0, waitedMs: 0 });
      return;
    }
    var w = { requestId: String(reqId), at: Date.now(), timer: null };
    w.timer = setTimeout(function () { qfDrainSettle(w, 'file-queue-timeout'); }, cap);
    qfDrainWaiters.push(w);
  }

  // Слушатели ставятся на загрузке модуля (до __bind): A-лайт спрашивает состояние
  // СИНХРОННО, потому что CustomEvent в DOM доставляется синхронно в оба мира.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('ai-cm-deepseek-files-state-request', function () { qfStateRespond(); });
    window.addEventListener('ai-cm-deepseek-files-drain', function (ev) { qfDrainHandle(qfBridgeDetail(ev)); });
  }

  // ===== СЕКЦИЯ 6: ЗАГРУЗКА ТЕЛА ФАЙЛА =====

  function qfFetchImpl() {
    var f = null;
    try { f = D ? D.originalFetch : null; } catch (eF) { f = null; }
    if (typeof f === 'function') return f;
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch;
    return null;
  }

  function qfHeader(res, name) {
    try {
      if (res && res.headers && typeof res.headers.get === 'function') return qfStr(res.headers.get(name));
    } catch (eH) { }
    return '';
  }

  // Страница логина/ошибки вместо файла: CDN или прокси отдал HTML. Файл, который
  // САМ является HTML, не путаем — его текст и есть содержимое.
  function qfLooksLoginHtml(text, ctype, ref) {
    var mime = qfStr(ref && ref.mime).toLowerCase();
    var name = qfStr(ref && ref.name).toLowerCase();
    if (mime === 'text/html' || mime === 'application/xhtml+xml' || /\.(html?|xhtml)$/.test(name)) return false;
    if (/text\/html/i.test(qfStr(ctype))) return true;
    return /^\s*<(!doctype\s+html|html|head|body|meta)/i.test(text.slice(0, 400));
  }

  // Текстовые поля ответа-обёртки (сервис иногда отдаёт {"code":0,"data":{...}}).
  function qfPayloadText(p, depth) {
    if (!p || typeof p !== 'object' || depth > 3) return '';
    var keys = ['content', 'text', 'body', 'data'];
    for (var i = 0; i < keys.length; i++) {
      var v = p[keys[i]];
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object') {
        var nested = qfPayloadText(v, depth + 1);
        if (nested) return nested;
      }
    }
    return '';
  }

  function qfTextFromBody(raw, ctype, ref) {
    var text = qfStr(raw);
    if (!text) return { ok: false, reason: 'empty-body', text: '' };
    if (qfLooksLoginHtml(text, ctype, ref)) {
      return { ok: false, reason: 'html-instead-of-file', text: '' };
    }
    var c0 = text.charAt(0);
    if (c0 === '{' || c0 === '[') {
      var payload = null;
      try { payload = JSON.parse(text); } catch (eJson) { payload = null; }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        if (typeof payload.code === 'number' && payload.code !== 0) {
          return { ok: false, reason: 'api-' + payload.code, text: '' };
        }
        var inner = qfPayloadText(payload, 0);
        if (inner) return { ok: true, text: inner, truncated: false };
      }
    }
    return { ok: true, text: text, truncated: false };
  }

  // Жёсткий кап файла: итоговая длина текста НЕ превышает QF_TEXT_CAP вместе с
  // пометкой об обрезке (кап задачи — на символы содержимого файла).
  function qfCapText(text) {
    var s = qfStr(text);
    if (s.length <= QF_TEXT_CAP) return { text: s, truncated: false, cut: 0 };
    var cut = s.length - QF_TEXT_CAP;
    var suffix = '\n…[обрезано ' + cut + ']';
    var keep = QF_TEXT_CAP - suffix.length;
    if (keep < 0) keep = 0;
    return { text: s.slice(0, keep) + suffix, truncated: true, cut: cut };
  }

  // v2.0.37: PDF-ветка. Ссылки R2 предподписанные, cookie не нужны — отсюда
  // credentials:'omit', как и у обычной загрузки вложений Qwen.
  function qfFetchPdf(item, ref) {
    var pdf = (typeof window !== 'undefined') ? window.AiCmPdf : null;
    if (!pdf || typeof pdf.fromUrl !== 'function') {
      return Promise.resolve({ ok: false, reason: 'pdf-unavailable', text: '' });
    }
    return Promise.resolve(pdf.fromUrl(qfStr(item && item.url), {
      fetch: qfFetchImpl(),
      credentials: 'omit',
      name: qfStr(ref && ref.name) || qfStr(item && item.name),
      maxBytes: QF_PDF_MAX,
      maxChars: QF_TEXT_CAP,
      timeoutMs: QF_PDF_TIMEOUT_MS
    })).then(function (r) {
      var res = r || {};
      var text = qfStr(res.text);
      return {
        ok: res.ok === true && text !== '',
        pdf: true,
        text: text,
        truncated: res.truncated === true,
        reason: qfStr(res.reason) || (res.ok === true ? '' : 'pdf-no-text')
      };
    }, function (ePdf) {
      qfWarn('qwen:files:pdf', '[qwen-files] pdf.js не разобрал PDF:', ePdf);
      return { ok: false, reason: 'pdf-host-error', text: '' };
    });
  }

  function qfFetchText(item) {
    var fetchImpl = qfFetchImpl();
    if (!fetchImpl) return Promise.resolve({ ok: false, reason: 'no-fetch', text: '' });
    var url = qfStr(item && item.url);
    if (!url) return Promise.resolve({ ok: false, reason: 'no-url', text: '' });
    var ref = { name: qfStr(item.name), mime: qfStr(item.mime) };
    // v2.0.37: PDF нельзя читать как текст (битый UTF-8 и гигантская строка) —
    // байты скачивает и разбирает pdf-bytes.js, сюда приходит готовый текст.
    if (qfIsPdf(ref) && qfPdfAvailable()) return qfFetchPdf(item, ref);
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var opts = { method: 'GET', credentials: 'omit' };
    if (ctrl && ctrl.signal) opts.signal = ctrl.signal;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      function done(res) {
        if (settled) return;
        settled = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        resolve(res || { ok: false, reason: 'empty', text: '' });
      }
      timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (eAbort) { qfWarn('qwen:files:abort', '[qwen-files] abort вложения:', eAbort); } }
        done({ ok: false, reason: 'timeout', text: '' });
      }, QF_TIMEOUT_MS);
      var p;
      try { p = fetchImpl(url, opts); } catch (eFetch) {
        qfWarn('qwen:files:fetch', '[qwen-files] fetch вложения упал:', eFetch);
        done({ ok: false, reason: 'fetch-throw', text: '' });
        return;
      }
      Promise.resolve(p).then(function (res) {
        if (!res || res.ok !== true) {
          done({ ok: false, reason: 'http-' + ((res && res.status) || '?'), text: '' });
          return;
        }
        var clen = qfNum(qfHeader(res, 'content-length'));
        if (clen > QF_BODY_MAX) { done({ ok: false, reason: 'too-large', text: '' }); return; }
        var ctype = qfHeader(res, 'content-type').toLowerCase();
        return Promise.resolve(res.text()).then(function (raw) {
          done(qfTextFromBody(raw, ctype, ref));
        }, function (eBody) {
          qfWarn('qwen:files:body', '[qwen-files] тело вложения не прочитано:', eBody);
          done({ ok: false, reason: 'body-error', text: '' });
        });
      }, function (eNet) {
        qfWarn('qwen:files:net', '[qwen-files] сеть вложения:', eNet);
        done({ ok: false, reason: 'network', text: '' });
      });
    });
  }

  // ===== СЕКЦИЯ 7: ОЧЕРЕДЬ, ЗАПИСЬ РЕЗУЛЬТАТА, РЕ-ЭМИТ =====

  function qfRecFromResult(item, ref) {
    var res = item.result || {};
    var ok = res.ok === true && qfStr(res.text) !== '';
    return {
      fileKey: ref.fileKey,
      name: ref.name || qfStr(item.name) || 'attachment',
      ok: ok,
      text: ok ? qfStr(res.text) : '',
      note: '',
      reason: ok ? '' : (qfStr(res.reason) || 'empty'),
      truncated: ok ? (res.truncated === true) : false,
      chars: ok ? qfStr(res.text).length : 0,
      at: item.doneAt || 0
    };
  }

  // Разложить готовый ответ по всем сообщениям, к которым приложен файл.
  function qfApplyByKey(msgKey, item) {
    var m = qfMsgs[msgKey];
    if (!m) return false;
    var ref = null;
    for (var i = 0; i < m.refs.length; i++) {
      if (m.refs[i].fileKey === item.fileKey) { ref = m.refs[i]; break; }
    }
    if (!ref) return false;
    m.recs[item.fileKey] = qfRecFromResult(item, ref);
    return true;
  }

  function qfOnFetched(item, res) {
    item.doneAt = Date.now();
    item.result = (res && typeof res === 'object') ? res : { ok: false, reason: 'empty', text: '' };
    var ok = item.result.ok === true && qfStr(item.result.text) !== '';
    if (ok) {
      // Кап ЧАТА: суммарный текст вложений одного разговора не больше QF_TOTAL_CAP.
      var cid = qfStr(item.chatId);
      var used = qfCharsByChat[cid] || 0;
      var room = QF_TOTAL_CAP - used;
      if (room <= 0) {
        item.result = { ok: false, reason: 'chat-cap', text: '' };
        ok = false;
      } else {
        var capped = qfCapText(item.result.text);
        var text = capped.text;
        var truncated = capped.truncated === true;
        if (text.length > room) { text = text.slice(0, room); truncated = true; }
        qfCharsByChat[cid] = used + text.length;
        item.result.text = text;
        item.result.truncated = truncated;
        item.result.ok = true;
      }
    }
    if (!ok) {
      item.state = 'failed';
      // Провал не должен «залипать» в дедупе: следующий снимок обязан попробовать снова.
      if (qfQueueByKey[item.dedupeKey] === item) delete qfQueueByKey[item.dedupeKey];
    } else {
      item.state = 'done';
    }
    var keys = Object.keys(item.targets || {});
    var applied = 0;
    for (var i = 0; i < keys.length; i++) {
      if (qfApplyByKey(keys[i], item)) applied++;
    }
    if (!ok) {
      qfDiag('fetch-fail', {
        file: qfStr(item.name),
        mime: qfStr(item.mime),
        reason: qfStr(item.result.reason) || 'empty',
        ms: item.doneAt - item.startedAt,
        applied: applied
      });
      qfWarn('qwen:files:fetch', '[qwen-files] текст вложения не получен: ' +
        qfStr(item.name) + ' reason=' + (qfStr(item.result.reason) || '-'));
    } else {
      qfDiag('fetch-done', {
        file: qfStr(item.name),
        chars: qfStr(item.result.text).length,
        truncated: item.result.truncated === true,
        ms: item.doneAt - item.startedAt,
        turns: keys.length,
        applied: applied
      });
    }
    scheduleEmit();
  }

  function qfStartFetch(item) {
    item.startedAt = Date.now();
    item.state = 'active';
    qfFetchText(item).then(function (res) {
      qfActive--;
      if (qfActive < 0) qfActive = 0;
      // Разговор сменился, пока файл был в полёте: результат принадлежит прежнему чату
      // и после qfReset() в карту не пишется (иначе сброс «воскресал» бы ответом).
      if (item.epoch !== qfEpoch) { pumpQueue(); return; }
      qfOnFetched(item, res);
      qfDrainKick('drained');
      pumpQueue();
    }, function (eFetch) {
      qfActive--;
      if (qfActive < 0) qfActive = 0;
      if (item.epoch !== qfEpoch) { pumpQueue(); return; }
      qfOnFetched(item, { ok: false, reason: 'reject', text: '' });
      qfDrainKick('drained');
      pumpQueue();
    });
  }

  // FIFO с concurrency 2: берём из головы, пока в полёте меньше двух.
  function pumpQueue() {
    while (qfActive < QF_CONCURRENCY && qfQueue.length > 0) {
      var item = qfQueue.shift();
      if (!item || item.state !== 'queued') continue;
      qfActive++;
      qfStartFetch(item);
    }
  }

  function qfQueueFile(chatId, msgKey, ref) {
    var cid = qfStr(chatId);
    var dk = cid + '|' + ref.fileKey;
    var known = qfQueueByKey[dk];
    if (known) {
      known.targets[msgKey] = 1;
      // Ответ уже пришёл (файл приложен к НОВОМУ сообщению): из очереди элемент уже
      // вышел, qfOnFetched больше не вызовется — раскладываем сохранённый результат сразу.
      if (known.result) qfApplyByKey(msgKey, known);
      return;
    }
    var item = {
      dedupeKey: dk,
      chatId: cid,
      fileKey: ref.fileKey,
      url: ref.url,
      name: ref.name,
      mime: ref.mime,
      size: ref.size,
      targets: {},
      result: null,
      state: 'queued',
      epoch: qfEpoch,
      startedAt: 0,
      doneAt: 0
    };
    item.targets[msgKey] = 1;
    qfQueueByKey[dk] = item;
    qfQueue.push(item);
    pumpQueue();
  }

  // Точка входа перехватчика: вложения пользовательского хода.
  // Возвращает число файлов, поставленных в очередь (0 — очередь не тронута).
  function qfEnqueueUserFiles(chatId, userKey, files) {
    try {
      if (!Array.isArray(files) || !files.length) return 0;
      var uk = qfStr(userKey);
      if (!uk) return 0;
      var cid = qfStr(chatId) || qfCurrentChatId();
      var cur = qfCurrentChatId();
      if (cur && cid && cur !== cid) {
        // Ход чужого чата (поздняя страница пагинации после SPA-перехода).
        qfDiag('enqueue-skip', { reason: 'other-chat' });
        return 0;
      }
      var m = qfMsgEntry(cid, uk);
      var oldRecs = m.recs || {};
      var refs = [];
      var seen = {};
      for (var i = 0; i < files.length; i++) {
        var ref = qfRefFromEntry(files[i]);
        if (!ref) continue;
        if (seen[ref.fileKey]) continue;
        seen[ref.fileKey] = 1;
        refs.push(ref);
      }
      if (!refs.length) return 0;
      // Снимок вложений сообщения. Уже добытый текст сохраняем: повторное применение
      // той же страницы истории не должно заново ставить файлы в очередь.
      m.refs = refs;
      m.recs = {};
      var msgKey = qfKey(cid, uk);
      var queued = 0;
      for (var j = 0; j < refs.length; j++) {
        var r = refs[j];
        if (oldRecs[r.fileKey]) { m.recs[r.fileKey] = oldRecs[r.fileKey]; continue; }
        if (r.isImage || (!qfIsTextual(r) && !(qfIsPdf(r) && qfPdfAvailable()))) {
          m.recs[r.fileKey] = { fileKey: r.fileKey, name: r.name, ok: false, text: '', note: qfNote(r), reason: '', truncated: false, chars: 0, at: 0 };
          continue;
        }
        if (!r.url) {
          m.recs[r.fileKey] = { fileKey: r.fileKey, name: r.name, ok: false, text: '', note: '', reason: 'no-url', truncated: false, chars: 0, at: 0 };
          continue;
        }
        if (r.status && r.status !== 'uploaded') {
          m.recs[r.fileKey] = { fileKey: r.fileKey, name: r.name, ok: false, text: '', note: '', reason: 'status-' + r.status, truncated: false, chars: 0, at: 0 };
          continue;
        }
        qfQueueFile(cid, msgKey, r);
        queued++;
      }
      if (queued) {
        qfDiag('enqueue', {
          chat: cid.slice(0, 8),
          files: refs.length,
          queued: queued,
          pending: qfPendingCount()
        });
      }
      return queued;
    } catch (eEnq) {
      qfWarn('qwen:files:enqueue', '[qwen-files] постановка вложений в очередь:', eEnq);
      return 0;
    }
  }

  function scheduleEmit() {
    if (typeof setTimeout !== 'function') return;
    if (qfEmitTimer !== null) { clearTimeout(qfEmitTimer); qfEmitTimer = null; }
    qfEmitTimer = setTimeout(qfEmitNow, QF_EMIT_DEBOUNCE_MS);
  }

  // Ре-эмит базы: serverTokens/complete берём из метаданных ПОСЛЕДНЕГО снимка ядра —
  // токены не пересчитываются, а незавершённая пагинация не объявляется полной.
  function qfEmitNow() {
    if (qfEmitTimer !== null) { clearTimeout(qfEmitTimer); qfEmitTimer = null; }
    if (D && typeof D.emitSnapshot === 'function') {
      var meta = null;
      try { meta = D.lastEmitMeta || null; } catch (eMeta) { meta = null; }
      var tokens = (meta && typeof meta.tokens === 'number') ? meta.tokens : 0;
      var complete = !(meta && meta.complete === false);
      var s = {
        usage: { input: tokens },
        complete: complete,
        chatId: (meta && qfStr(meta.chatId)) || '',
        responseId: (meta && qfStr(meta.responseId)) || ''
      };
      if (!complete) s.partial = { pages: 0, reason: 'files-in-progress' };
      try { D.emitSnapshot(s); } catch (eEmit) {
        qfWarn('qwen:files:emit', '[qwen-files] ре-эмит после вложения:', eEmit);
      }
    }
    qfDrainKick('drained');
  }

  // Полный сброс файлового состояния на смену разговора. Очередь общая (не по чатам),
  // поэтому прежние запросы обязаны умереть: их результаты отбрасываются по epoch.
  function qfReset(chatId) {
    qfEpoch++;
    qfMsgs = {};
    qfCharsByChat = {};
    qfQueue = [];
    qfQueueByKey = {};
    qfActive = 0;
    qfDrainWaiters.length = 0;
    if (qfEmitTimer !== null) { clearTimeout(qfEmitTimer); qfEmitTimer = null; }
    qfDiag('reset', { chat: qfStr(chatId).slice(0, 8) });
    return true;
  }

  // Снимок состояния для отладки/тестов (не влияет на протокол).
  function qfStats() {
    return {
      queued: qfQueue.length,
      active: qfActive,
      pending: qfPendingCount(),
      texts: qfTextsCount(),
      messages: Object.keys(qfMsgs),
      chats: Object.keys(qfCharsByChat)
    };
  }

  // ===== СЕКЦИЯ 8: СВЯЗКА С ЯДРОМ =====
  function __bind(d) {
    D = d || null;
    return Fn;
  }

  Fn.qfEnqueueUserFiles = qfEnqueueUserFiles;
  Fn.qfSectionsFor = qfSectionsFor;
  Fn.qfSectionLength = qfSectionLength;
  Fn.qfPendingCount = qfPendingCount;
  Fn.qfReset = qfReset;
  Fn.qfStats = qfStats;
  // Короткие алиасы и юниты для тестов/диагностики (боевой путь пользуется qf-именами).
  Fn.enqueueUserFiles = qfEnqueueUserFiles;
  Fn.sectionsFor = qfSectionsFor;
  Fn.sectionLength = qfSectionLength;
  Fn.pendingCount = qfPendingCount;
  Fn.reset = qfReset;
  Fn.stats = qfStats;
  Fn.refFromEntry = qfRefFromEntry;
  Fn.isTextual = qfIsTextual;
  Fn.sectionOf = qfSection;
  Fn.fetchText = qfFetchText;
  Fn.stateRespond = qfStateRespond;
  Fn.messages = function () { return qfMsgs; };
  Fn.constants = {
    concurrency: QF_CONCURRENCY,
    textCap: QF_TEXT_CAP,
    totalCap: QF_TOTAL_CAP,
    timeoutMs: QF_TIMEOUT_MS,
    emitDebounceMs: QF_EMIT_DEBOUNCE_MS,
    drainTimeoutMs: QF_DRAIN_TIMEOUT_MS,
    bodyMax: QF_BODY_MAX
  };
  Fn.__bind = __bind;

  if (typeof window !== 'undefined') window.AiCmQwenFiles = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
})();
