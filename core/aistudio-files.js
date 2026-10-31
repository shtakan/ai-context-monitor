/* ================================================================== *
 * AI Studio: текст вложений в экспорт (MAIN-мир)
 *
 * ЗАЧЕМ. История AI Studio (ResolveDriveResource / UpdatePrompt) приносит
 * вложение отдельной строкой-«prompt chunk»: m[0] === null, а в m[3] лежит
 * только Drive file id — ни имени, ни mimeType, ни текста. Без этого модуля
 * ход-вложение исчезает из экспорта целиком (см. plan-aistudio-files.md §1-§2).
 *
 * КАК. Перехватчик (core/aistudio-intercept.js) отдаёт id файлов и спрашивает
 * секции через afSectionsFor(); модуль догружает метаданные и тело файла
 * запросами Drive API v3 с OAuth-токеном страницы (GenerateAccessToken),
 * кладёт готовую секцию `[FILE: <имя>]` в кэш и просит перехватчик
 * пересобрать снимок (emitSnapshot → emitHistory → мост ai-cm-aistudio-net).
 *
 * ПРИВАТНОСТЬ. Токен `ya29…` и alt=media-URL не покидают модуль: в лог идут
 * только длина токена и id файла, в storage/bridge они не попадают.
 * Запросы идут БЕЗ `key=` — с публичным ключом Google отдаёт 403 referer,
 * с одним `Authorization: Bearer` — 200 (plan-aistudio-files.md §3.3).
 *
 * Контракт с ядром: __bind({ emitSnapshot, diagLine, currentChatId,
 * originalFetch }). Привязка ленивая — по плану core/aistudio-files.js
 * грузится ПОСЛЕ перехватчика.
 * ================================================================== */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.AiCmAistudioFiles) return;

  var D = null;
  var Fn = {};

  var AF_CONCURRENCY = 2;
  var AF_TEXT_CAP = 200000;          // символов на файл
  var AF_TOTAL_CAP = 2000000;        // символов на чат
  var AF_TIMEOUT_MS = 15000;
  var AF_EMIT_DEBOUNCE_MS = 250;
  var AF_DRAIN_TIMEOUT_MS = 5000;    // ожидание догрузки при экспорте
  var AF_BODY_MAX = 8 * 1024 * 1024; // не тянем тело больше 8 МБ
  var AF_DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files/';
  var AF_META_FIELDS = 'id,name,mimeType,size';
  // v2.0.37 (PDF): тело PDF (в пределах 10 МиБ) тянет MAIN-хелпер core/pdf-bytes.js,
  // текст достаёт pdf.js в offscreen-документе (Chrome) или event page (Firefox).
  var AF_PDF_MAX = 10 * 1024 * 1024;
  var AF_PDF_TIMEOUT_MS = 15000;

  var AF_TEXT_MIME_RE = /^text\/[a-z0-9.+-]*$/i;
  var AF_TEXT_APP_RE = /^application\/(json|xml|x-yaml)$/i;

  // ===== СЕКЦИЯ 1: СОСТОЯНИЕ =====

  var afToken = '';            // 'ya29…', только в памяти
  var afText = {};             // '<chatId>|<fileId>' -> запись файла
  var afQueue = [];            // FIFO {chatId,fileId,key,epoch,state}
  var afQueueByKey = {};       // дубль очереди по ключу
  var afKnown = {};            // дедуп уже поставленных в очередь
  var afActive = 0;            // сколько fetch'ей в полёте
  var afCharsByChat = {};      // израсходованный лимит символов на чат
  var afEmitTimer = null;      // дебаунс ре-эмита
  var afEmitChat = '';
  var afEpoch = 0;             // сброс SPA: результаты старых fetch'ей в мусор
  var afDrainWaiters = [];     // ожидающие экспорта
  var afStatsObj = { queued: 0, done: 0, failed: 0, chars: 0 };

  function afStr(v) {
    return typeof v === 'string' ? v : '';
  }

  function afNum(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function afKey(chatId, fileId) {
    return afStr(chatId) + '|' + afStr(fileId);
  }

  function afCurrentChatId() {
    try {
      if (D) {
        if (typeof D.currentChatId === 'function') return afStr(D.currentChatId());
        if (typeof D.currentChatId === 'string') return D.currentChatId;
      }
      if (typeof window === 'undefined' || !window.location) return '';
      var m = /\/prompts\/([A-Za-z0-9_-]+)/.exec(afStr(window.location.pathname));
      return m ? m[1] : '';
    } catch (eCh) {
      return '';
    }
  }

  function afChatIdFrom(chatId) {
    var cid = afStr(chatId);
    return cid || afCurrentChatId();
  }

  function afBridgeDetail(ev) {
    try {
      var d = ev && ev.detail;
      if (typeof d === 'string') return JSON.parse(d);
      if (d && typeof d === 'object') return d;
    } catch (eBd) {
      afWarn('bridge', '[aistudio-files] detail не разобрался', eBd);
    }
    return null;
  }

  function afDiag(tag, fields) {
    try {
      if (typeof aiCmDiagLine === 'function') { aiCmDiagLine('aistudio-files-' + tag, fields); return; }
      if (D && typeof D.diagLine === 'function') D.diagLine('files-' + tag, fields);
    } catch (eD) { }
  }

  function afWarn(tag, msg, e) {
    if (typeof aiCmDiagWarn === 'function') aiCmDiagWarn('aistudio-files:' + tag, msg, e);
  }

  function afDispatch(name, detail) {
    try {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      if (typeof CustomEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (eDs) {
      afWarn('dispatch', '[aistudio-files] событие ' + name, eDs);
    }
  }

  // ===== СЕКЦИЯ 2: MIME, РАЗМЕР, СЕКЦИЯ =====

  function afIsTextual(mime) {
    var m = afStr(mime).toLowerCase();
    if (!m) return false;
    if (AF_TEXT_MIME_RE.test(m)) return true;
    if (AF_TEXT_APP_RE.test(m)) return true;
    return /(\+json|\+xml)$/.test(m);
  }

  function afBytes(n) {
    var v = afNum(n);
    return v > 0 ? String(v) + ' Б' : 'размер неизвестен';
  }

  // v2.0.37: PDF опознаём и по mime, и по расширению (Drive иногда отдаёт
  // octet-stream). Текст достаёт pdf.js; без хелпера остаётся прежняя заглушка.
  function afIsPdf(mime, name) {
    var m = afStr(mime).toLowerCase();
    if (/application\/pdf/.test(m)) return true;
    return /\.pdf$/i.test(afStr(name));
  }

  function afPdfAvailable() {
    return typeof window !== 'undefined' && !!window.AiCmPdf &&
      typeof window.AiCmPdf.fromUrl === 'function';
  }

  function afNoteText(rec) {
    if (!rec) return '';
    var mime = afStr(rec.mime);
    if (mime && !afIsTextual(mime)) {
      return mime + ', ' + afBytes(rec.size) + '; текст не извлекается';
    }
    return '';
  }

  function afFallbackName(rec) {
    return afStr(rec && rec.name) || ('файл ' + afStr(rec && rec.fileId));
  }

  function afSection(rec) {
    if (!rec) return '';
    var name = afFallbackName(rec);
    if (afStr(rec.text) !== '') return '\n\n[FILE: ' + name + ']\n' + rec.text;
    var note = afNoteText(rec);
    if (note) return '\n\n[FILE: ' + name + ' — ' + note + ']';
    if (rec.reason) return '\n\n[FILE: ' + name + ' — текст не получен: ' + rec.reason + ']';
    return '';
  }

  function afSectionsFor(ids, chatId) {
    var list = Array.isArray(ids) ? ids : [];
    if (!list.length) return '';
    var cid = afChatIdFrom(chatId);
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var fid = afStr(list[i]);
      if (!fid) continue;
      var rec = afEnsureEntry(cid, fid);
      if (rec) out += afSection(rec);
    }
    return out;
  }

  // ===== СЕКЦИЯ 3: ТОКЕН =====

  function afSetToken(tok) {
    var t = afStr(tok).trim();
    if (!t || t.length < 20) return false;
    if (t === afToken) return false;
    afToken = t;
    var dropped = 0;
    for (var k in afText) {
      if (!Object.prototype.hasOwnProperty.call(afText, k)) continue;
      if (afText[k] && afText[k].noToken) {
        delete afText[k];
        delete afKnown[k];
        dropped++;
      }
    }
    afDiag('auth-token', { len: t.length, retry: dropped });
    if (dropped) afScheduleEmit();
    return true;
  }

  // ===== СЕКЦИЯ 4: ОЧЕРЕДЬ =====

  function afEnsureEntry(cid, fid) {
    var key = afKey(cid, fid);
    var rec = afText[key];
    if (rec) {
      if (rec.noToken && afToken) {
        delete afText[key];
        delete afKnown[key];
        rec = null;
      } else {
        return rec;
      }
    }
    if (!afToken) {
      rec = {
        chatId: cid,
        fileId: fid,
        name: afFallbackName({ fileId: fid }),
        mime: '',
        size: 0,
        reason: 'no-token',
        noToken: true
      };
      afText[key] = rec;
      afDiag('no-token', { file: fid });
      return rec;
    }
    afQueueFile(cid, fid);
    return null;
  }

  function afNote(chatId, ids) {
    var cid = afChatIdFrom(chatId);
    var list = Array.isArray(ids) ? ids : [];
    if (!cid) return 0;
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var fid = afStr(list[i]);
      if (!fid) continue;
      var key = afKey(cid, fid);
      if (afText[key] || afKnown[key]) continue;
      if (!afToken) { afDiag('note-no-token', { file: fid }); continue; }
      afQueueFile(cid, fid);
      n++;
    }
    return n;
  }

  function afQueueFile(cid, fid) {
    var key = afKey(cid, fid);
    if (afKnown[key] || afText[key]) return;
    afKnown[key] = true;
    var item = { chatId: cid, fileId: fid, key: key, epoch: afEpoch, state: 'queued', startedAt: 0 };
    afQueue.push(item);
    afQueueByKey[key] = item;
    afStatsObj.queued++;
    afPumpQueue();
  }

  function afPumpQueue() {
    while (afActive < AF_CONCURRENCY) {
      var item = null;
      for (var i = 0; i < afQueue.length; i++) {
        if (afQueue[i].state === 'queued') { item = afQueue[i]; break; }
      }
      if (!item) return;
      item.state = 'active';
      item.startedAt = Date.now();
      afActive++;
      afStartFetch(item);
    }
  }

  function afFinishItem(item) {
    var idx = afQueue.indexOf(item);
    if (idx !== -1) afQueue.splice(idx, 1);
    if (afQueueByKey[item.key] === item) delete afQueueByKey[item.key];
    if (afActive > 0) afActive--;
  }

  // ===== СЕКЦИЯ 5: DRIVE API =====

  function afFetchImpl() {
    if (D && typeof D.originalFetch === 'function') return D.originalFetch;
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch;
    return null;
  }

  function afAuthHeaders() {
    return { 'Authorization': 'Bearer ' + afToken };
  }

  /**
   * Один GET с Bearer. Возвращает {ok, reason, body} — без URL и токена
   * в причинах/диагностике: наружу уходят только коды.
   */
  function afFetchRaw(url, headers) {
    var impl = afFetchImpl();
    if (typeof impl !== 'function') return Promise.resolve({ ok: false, reason: 'no-fetch' });
    var opts = { method: 'GET', credentials: 'omit', headers: headers || {} };
    var ctrl = null;
    var timer = null;
    var done = false;

    return new Promise(function (resolve) {
      function finish(res) {
        if (done) return;
        done = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        resolve(res);
      }
      try {
        if (typeof AbortController === 'function') {
          ctrl = new AbortController();
          opts.signal = ctrl.signal;
        }
      } catch (eAc) { ctrl = null; }
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        finish({ ok: false, reason: 'timeout' });
      }, AF_TIMEOUT_MS);

      var p;
      try {
        p = impl(url, opts);
      } catch (eCall) {
        finish({ ok: false, reason: 'fetch-throw' });
        return;
      }
      Promise.resolve(p).then(function (res) {
        if (!res || typeof res !== 'object') { finish({ ok: false, reason: 'empty-response' }); return; }
        if (!res.ok) { finish({ ok: false, reason: 'http-' + afNum(res.status) }); return; }
        var len = 0;
        try {
          if (res.headers && typeof res.headers.get === 'function') len = afNum(res.headers.get('content-length'));
        } catch (eCl) { len = 0; }
        if (len > AF_BODY_MAX) { finish({ ok: false, reason: 'too-large' }); return; }
        var tp;
        try {
          tp = res.text();
        } catch (eTx) {
          finish({ ok: false, reason: 'body-error' });
          return;
        }
        Promise.resolve(tp).then(function (body) {
          finish({ ok: true, body: typeof body === 'string' ? body : '' });
        }, function () {
          finish({ ok: false, reason: 'body-error' });
        });
      }, function () {
        finish({ ok: false, reason: 'network' });
      });
    });
  }

  function afParseJson(text) {
    var s = afStr(text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    s = s.replace(/^\s*\)\]\}'\s*/, '');
    try { return JSON.parse(s); } catch (ePj) { return null; }
  }

  function afFetchMeta(item) {
    var url = AF_DRIVE_BASE + encodeURIComponent(item.fileId) +
      '?fields=' + AF_META_FIELDS + '&supportsAllDrives=true';
    return afFetchRaw(url, afAuthHeaders()).then(function (r) {
      if (!r.ok) return { ok: false, reason: r.reason, name: afFallbackName({ fileId: item.fileId }) };
      var o = afParseJson(r.body);
      if (!o || typeof o !== 'object') {
        return { ok: false, reason: 'meta-json', name: afFallbackName({ fileId: item.fileId }) };
      }
      return {
        ok: true,
        name: afStr(o.name) || afFallbackName({ fileId: item.fileId }),
        mime: afStr(o.mimeType),
        size: afNum(o.size)
      };
    });
  }

  function afFetchText(item, meta) {
    var url = AF_DRIVE_BASE + encodeURIComponent(item.fileId) +
      '?alt=media&supportsAllDrives=true';
    return afFetchRaw(url, afAuthHeaders()).then(function (r) {
      var base = {
        ok: false,
        reason: r.reason || 'fetch-fail',
        meta: meta
      };
      if (!r.ok) return base;
      if (!r.body) { base.reason = 'empty-body'; return base; }
      return { ok: true, text: r.body, meta: meta };
    });
  }

  // v2.0.37: PDF идёт мимо afFetchRaw — тот читает текст и режет тело по
  // AF_BODY_MAX. Байты отдаёт pdf-bytes.js (тот же originalFetch + Bearer),
  // а текст возвращается обычной записью, поэтому afOnFetched не меняется.
  function afFetchPdf(item, meta) {
    var pdf = (typeof window !== 'undefined') ? window.AiCmPdf : null;
    var url = AF_DRIVE_BASE + encodeURIComponent(item.fileId) +
      '?alt=media&supportsAllDrives=true';
    return Promise.resolve(pdf.fromUrl(url, {
      fetch: afFetchImpl(),
      credentials: 'omit',
      headers: afAuthHeaders(),
      name: afStr(meta && meta.name),
      maxBytes: AF_PDF_MAX,
      maxChars: AF_TEXT_CAP,
      timeoutMs: AF_PDF_TIMEOUT_MS
    })).then(function (r) {
      var res = r || {};
      var text = afStr(res.text);
      return {
        ok: res.ok === true && text !== '',
        pdf: true,
        text: text,
        truncated: res.truncated === true,
        reason: afStr(res.reason) || (res.ok === true ? '' : 'pdf-no-text'),
        meta: meta
      };
    }, function (ePdf) {
      afWarn('pdf', '[aistudio-files] pdf.js не разобрал PDF', ePdf);
      return { ok: false, note: true, pdf: true, reason: 'pdf-host-error', meta: meta };
    });
  }

  function afCapText(text, limitChars) {
    var limit = afNum(limitChars) || AF_TEXT_CAP;
    var s = afStr(text);
    if (s.length <= limit) return { text: s, truncated: false };
    var marker = '\n…[обрезано ' + (s.length - limit) + ']';
    var keep = limit - marker.length;
    if (keep < 0) keep = 0;
    return { text: s.slice(0, keep) + marker, truncated: true };
  }

  function afStartFetch(item) {
    var epoch = item.epoch;
    afFetchMeta(item).then(function (meta) {
      if (epoch !== afEpoch) return null;
      if (!meta || !meta.ok) {
        return { ok: false, reason: (meta && meta.reason) || 'meta-fail', meta: meta || {} };
      }
      if (!afIsTextual(meta.mime)) {
        // v2.0.37: PDF разбираем pdf.js'ом, если MAIN-хелпер жив; иначе прежняя
        // заметка «имя и mime есть, тело не тянем».
        if (afIsPdf(meta.mime, meta.name) && afPdfAvailable()) return afFetchPdf(item, meta);
        return { ok: false, note: true, meta: meta };
      }
      return afFetchText(item, meta);
    }).then(function (res) {
      if (res && epoch === afEpoch) afOnFetched(item, res);
    }, function (eFetch) {
      if (epoch === afEpoch) afOnFetched(item, { ok: false, reason: 'fetch-throw' });
      afWarn('fetch', '[aistudio-files] ошибка загрузки вложения', eFetch);
    }).then(function () {
      var stale = epoch !== afEpoch;
      afFinishItem(item);
      if (!stale) {
        afPumpQueue();
        afDrainKick('drained');
      }
    });
  }

  function afOnFetched(item, res) {
    var cid = item.chatId;
    var meta = (res && res.meta) || {};
    var rec = {
      chatId: cid,
      fileId: item.fileId,
      name: afStr(meta.name) || afFallbackName({ fileId: item.fileId }),
      mime: afStr(meta.mime),
      size: afNum(meta.size)
    };

    if (res && res.ok && typeof res.text === 'string') {
      var used = afCharsByChat[cid] || 0;
      var room = AF_TOTAL_CAP - used;
      if (room <= 0) {
        rec.reason = 'chat-cap';
      } else {
        var capped = afCapText(res.text, Math.min(AF_TEXT_CAP, room));
        if (!capped.text) {
          rec.reason = 'chat-cap';
        } else {
          rec.text = capped.text;
          rec.truncated = capped.truncated;
          afCharsByChat[cid] = used + capped.text.length;
        }
      }
    } else if (res && res.note) {
      // Изображения/бинарь: имя и mime есть, тело не тянем (§10.4). PDF попадает
      // сюда только без живого core/pdf-bytes.js — с ним текст уже в rec.text.
    } else {
      rec.reason = (res && res.reason) || 'fetch-fail';
    }

    afText[item.key] = rec;
    if (afStr(rec.text) !== '') {
      afStatsObj.done++;
      afStatsObj.chars += rec.text.length;
    } else {
      afStatsObj.failed++;
    }
    afDiag(afStr(rec.text) !== '' ? 'fetch-done' : 'fetch-fail', {
      file: item.fileId,
      len: afStr(rec.text).length,
      reason: rec.reason || ''
    });
    afScheduleEmit();
  }

  // ===== СЕКЦИЯ 6: РЕ-ЭМИТ =====

  function afEmitNow() {
    if (afEmitTimer !== null) { clearTimeout(afEmitTimer); afEmitTimer = null; }
    afEmitChat = '';
    try {
      if (D && typeof D.emitSnapshot === 'function') D.emitSnapshot();
    } catch (eEm) {
      afWarn('emit', '[aistudio-files] ре-эмит снимка', eEm);
    }
  }

  function afScheduleEmit() {
    if (afEmitTimer !== null) return;
    afEmitChat = afCurrentChatId();
    afEmitTimer = setTimeout(function () {
      afEmitNow();
      afDrainKick('drained');
    }, AF_EMIT_DEBOUNCE_MS);
  }

  // ===== СЕКЦИЯ 7: ПРОТОКОЛ ОЖИДАНИЯ ОЧЕРЕДИ (A-лайт) =====

  function afPendingCount(chatId) {
    var cid = afStr(chatId);
    var n = 0;
    for (var i = 0; i < afQueue.length; i++) {
      if (!cid || afQueue[i].chatId === cid) n++;
    }
    // Отложенный ре-эмит тоже «в полёте»: экспорт не должен снять снимок
    // раньше, чем в нём появится текст вложения.
    if (afEmitTimer !== null && (!cid || !afEmitChat || afEmitChat === cid)) n++;
    return n;
  }

  function afPending(chatId) {
    return afPendingCount(chatId);
  }

  function afStateRespond() {
    afDispatch('ai-cm-deepseek-files-state-response', {
      pending: afPendingCount(''),
      active: afActive,
      queued: afQueue.length,
      texts: Object.keys(afText).length
    });
  }

  function afDrainRespond(requestId, detail) {
    var payload = { requestId: requestId };
    var keys = Object.keys(detail || {});
    for (var i = 0; i < keys.length; i++) payload[keys[i]] = detail[keys[i]];
    afDispatch('ai-cm-deepseek-files-drain-done', payload);
  }

  function afDrainSettle(w, reason) {
    var idx = afDrainWaiters.indexOf(w);
    if (idx === -1) return;
    afDrainWaiters.splice(idx, 1);
    if (w.timer !== null) { clearTimeout(w.timer); w.timer = null; }
    afDrainRespond(w.requestId, {
      ok: reason === 'drained',
      drained: reason === 'drained',
      reason: reason,
      pending: afPendingCount(''),
      waitedMs: Date.now() - w.at
    });
  }

  function afDrainKick(reason) {
    if (!afDrainWaiters.length || afPendingCount('') > 0) return;
    var waiters = afDrainWaiters.slice();
    for (var i = 0; i < waiters.length; i++) afDrainSettle(waiters[i], reason || 'drained');
  }

  /**
   * По таймауту ожидания файлы, которые ещё не догрузились, получают причину
   * `timeout`: экспорт уходит с валидными заглушками, а не с пустым USER:.
   * Загрузка при этом не отменяется — поздний ответ заменит заглушку и
   * вызовет ре-эмит (текст появится в следующем экспорте).
   */
  function afMarkTimeout(chatId) {
    var cid = afStr(chatId);
    for (var i = 0; i < afQueue.length; i++) {
      var item = afQueue[i];
      if (cid && item.chatId !== cid) continue;
      var rec = afText[item.key];
      if (rec && (afStr(rec.text) !== '' || rec.reason || afNoteText(rec))) continue;
      if (!rec) {
        rec = {
          chatId: item.chatId,
          fileId: item.fileId,
          name: afFallbackName({ fileId: item.fileId }),
          mime: '',
          size: 0
        };
        afText[item.key] = rec;
      }
      rec.reason = 'timeout';
    }
  }

  function afDrainHandle(detail) {
    var d = detail || {};
    var reqId = d.requestId;
    if (!reqId) return;
    var cap = afNum(d.timeoutMs) || AF_DRAIN_TIMEOUT_MS;
    if (afPendingCount('') === 0) {
      afDrainRespond(reqId, { ok: true, drained: true, reason: 'idle', pending: 0, waitedMs: 0 });
      return;
    }
    var w = { requestId: String(reqId), at: Date.now(), timer: null };
    w.timer = setTimeout(function () {
      afMarkTimeout('');
      // Синхронно, ДО drain-done: экспорт сразу после ответа обязан увидеть
      // снимок с заглушками reason=timeout (план §7), а не пустой USER:.
      afEmitNow();
      afDrainSettle(w, 'timeout');
    }, cap);
    afDrainWaiters.push(w);
  }

  // Слушатели ставятся на загрузке (до __bind): A-лайт спрашивает состояние
  // синхронно, CustomEvent в DOM доставляется в оба мира.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('ai-cm-deepseek-files-state-request', function () { afStateRespond(); });
    window.addEventListener('ai-cm-deepseek-files-drain', function (ev) { afDrainHandle(afBridgeDetail(ev)); });
  }

  // ===== СЕКЦИЯ 8: СБРОС И СТАТИСТИКА =====

  function afReset(chatId) {
    var cid = afStr(chatId);
    afEpoch++;
    afQueue = [];
    afQueueByKey = {};
    afKnown = {};
    afText = {};
    afCharsByChat = {};
    afActive = 0;
    if (afEmitTimer !== null) { clearTimeout(afEmitTimer); afEmitTimer = null; }
    afEmitChat = '';
    var waiters = afDrainWaiters.slice();
    afDrainWaiters = [];
    for (var i = 0; i < waiters.length; i++) {
      var w = waiters[i];
      if (w.timer !== null) { clearTimeout(w.timer); w.timer = null; }
      afDrainRespond(w.requestId, {
        ok: false,
        drained: false,
        reason: 'reset',
        pending: 0,
        waitedMs: Date.now() - w.at
      });
    }
    afDiag('reset', { chat: cid || '(все)', epoch: afEpoch });
  }

  function afStats() {
    return {
      token: afToken ? 'set' : 'absent',
      queued: afQueue.length,
      active: afActive,
      texts: Object.keys(afText).length,
      known: Object.keys(afKnown).length,
      charsByChat: afCharsByChat,
      stats: { queued: afStatsObj.queued, done: afStatsObj.done, failed: afStatsObj.failed, chars: afStatsObj.chars }
    };
  }

  // ===== СЕКЦИЯ 9: СВЯЗКА С ЯДРОМ =====

  function __bind(d) {
    D = d || null;
    return Fn;
  }

  Fn.afSetToken = afSetToken;
  Fn.afNote = afNote;
  Fn.afSectionsFor = afSectionsFor;
  Fn.afPending = afPending;
  Fn.afReset = afReset;

  // Короткие алиасы и юниты для тестов/диагностики (боевой путь — af-имена).
  Fn.setToken = afSetToken;
  Fn.note = afNote;
  Fn.sectionsFor = afSectionsFor;
  Fn.pending = afPending;
  Fn.reset = afReset;
  Fn.stats = afStats;
  Fn.sectionOf = afSection;
  Fn.isTextual = afIsTextual;
  Fn.isPdf = afIsPdf;
  Fn.fetchPdf = afFetchPdf;
  Fn.constants = {
    concurrency: AF_CONCURRENCY,
    textCap: AF_TEXT_CAP,
    totalCap: AF_TOTAL_CAP,
    timeoutMs: AF_TIMEOUT_MS,
    emitDebounceMs: AF_EMIT_DEBOUNCE_MS,
    drainTimeoutMs: AF_DRAIN_TIMEOUT_MS,
    bodyMax: AF_BODY_MAX
  };
  Fn.__bind = __bind;

  if (typeof window !== 'undefined') window.AiCmAistudioFiles = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
})();
