// parser/pdf-host.js — единственный файл, который грузит pdf.js.
//
// Контекст: offscreen-документ Chrome (parser/offscreen.html) или event page
// Firefox (manifest background.scripts). Оба — документы расширения, поэтому
// dynamic import() из classic-скрипта работает без module-типа background.
//
// Безопасность: isEvalSupported:false и disableFontFace:true — pdf.js не вызывает
// eval/Function и не строит FontFace из встроенных шрифтов (CVE-2024-4367 для 3.x;
// на 4.8.69 eval тоже не нужен, но флаг держим как контракт плана).
//
// Контракт: AiCmPdfHost.parsePdf(bytes, {maxChars, maxPages}) → Promise<result>,
// где result = { ok, text, pages, truncated, reason }. Причина — только код
// (pdf-password / pdf-invalid / pdf-host-error), без текста исключения наружу.
(function (root) {
  'use strict';

  var LIB_PATH = 'lib/pdf.min.mjs';
  var WORKER_PATH = 'pdf.worker.js';
  var DEFAULT_MAX_CHARS = 200000;
  var DEFAULT_MAX_PAGES = 500;

  var libPromise = null;
  var activeTask = null;

  function warn(tag, e) {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[ai-cm-pdf-host] ' + tag + ':', e);
    }
  }

  function num(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  function extUrl(relPath) {
    try {
      if (root.chrome && root.chrome.runtime && typeof root.chrome.runtime.getURL === 'function') {
        return root.chrome.runtime.getURL(relPath);
      }
    } catch (eUrl) { warn('getURL', eUrl); }
    return relPath;
  }

  // Загрузка библиотеки ровно один раз на контекст: повторный import() стоит
  // мегабайт разбора и на второй PDF не нужен.
  function loadLib() {
    if (libPromise) return libPromise;
    var url = extUrl(LIB_PATH);
    libPromise = import(url).then(function (mod) {
      var pdfjs = mod && (mod.default || mod);
      if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
        throw new Error('pdfjs: getDocument missing');
      }
      try {
        pdfjs.GlobalWorkerOptions.workerSrc = extUrl(WORKER_PATH);
      } catch (eWorker) { warn('workerSrc', eWorker); }
      return pdfjs;
    });
    return libPromise;
  }

  function mapError(err) {
    var name = String((err && err.name) || '');
    if (name === 'PasswordException') return 'pdf-password';
    if (name === 'InvalidPDFException' || name === 'FormatError') return 'pdf-invalid';
    if (name === 'MissingPDFException' || name === 'UnexpectedResponseException') return 'pdf-invalid';
    warn('parse', err);
    return 'pdf-host-error';
  }

  function textHelper() {
    var helper = root.AiCmPdfText;
    return (helper && typeof helper.collectPages === 'function') ? helper : null;
  }

  // Последовательный обход страниц: pdf.js не любит параллельный getPage на одном
  // документе, а память страницы освобождается сразу после выгрузки items.
  function readPages(doc, maxPages) {
    var total = num(doc.numPages);
    var limit = Math.min(total, maxPages);
    var pages = [];
    var index = 0;
    function step() {
      if (index >= limit) return Promise.resolve(pages);
      var pageNo = index + 1;
      index++;
      return Promise.resolve(doc.getPage(pageNo)).then(function (page) {
        return Promise.resolve(page.getTextContent({
          includeMarkedContent: false,
          disableNormalization: false
        })).then(function (content) {
          pages.push({ items: (content && content.items) || [] });
          try { page.cleanup(); } catch (eClean) { warn('cleanup', eClean); }
          return step();
        });
      });
    }
    return step();
  }

  function fallbackCollect(pages, maxChars, maxPages) {
    var text = '';
    for (var i = 0; i < pages.length; i++) {
      if (text) text += '\n';
      text += pages[i].items.map(function (it) { return (it && it.str) || ''; }).join('');
    }
    var cut = text.length > maxChars;
    return {
      text: cut ? text.slice(0, maxChars) : text,
      pages: pages.length,
      truncated: cut || pages.length >= maxPages
    };
  }

  function done(result) {
    return result;
  }

  function parsePdf(bytes, opts) {
    var o = opts || {};
    var maxChars = num(o.maxChars) || DEFAULT_MAX_CHARS;
    var maxPages = num(o.maxPages) || DEFAULT_MAX_PAGES;
    var len = (bytes && typeof bytes.byteLength === 'number') ? bytes.byteLength : 0;
    if (len <= 0) {
      return Promise.resolve(done({ ok: false, text: '', pages: 0, truncated: false, reason: 'pdf-invalid' }));
    }
    return loadLib().then(function (pdfjs) {
      var task = pdfjs.getDocument({
        data: bytes,
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        disableAutoFetch: true,
        disableStream: true
      });
      activeTask = task;
      return task.promise.then(function (doc) {
        return readPages(doc, maxPages).then(function (pages) {
          var helper = textHelper();
          var collected = helper
            ? helper.collectPages(pages, { maxChars: maxChars, maxPages: maxPages })
            : fallbackCollect(pages, maxChars, maxPages);
          return {
            ok: true,
            text: collected.text,
            pages: collected.pages,
            truncated: collected.truncated === true,
            reason: ''
          };
        });
      }).then(function (res) {
        activeTask = null;
        destroyTask(task);
        return res;
      }, function (err) {
        activeTask = null;
        destroyTask(task);
        return { ok: false, text: '', pages: 0, truncated: false, reason: mapError(err) };
      });
    }, function (err) {
      warn('import', err);
      return { ok: false, text: '', pages: 0, truncated: false, reason: 'pdf-host-error' };
    });
  }

  // destroy() убивает и документ, и воркер: иначе воркер живёт до закрытия
  // offscreen-документа и держит память распакованного PDF.
  function destroyTask(task) {
    try {
      if (task && typeof task.destroy === 'function') {
        var p = task.destroy();
        if (p && typeof p.catch === 'function') p.catch(function (eDestroy) { warn('destroy', eDestroy); });
      }
    } catch (eDestroy) { warn('destroy-throw', eDestroy); }
  }

  // Отмена по сценарию провайдера (закрытие вкладки, смена чата): результат уже
  // никому не нужен, но воркер должен остановиться.
  function stop() {
    var task = activeTask;
    activeTask = null;
    destroyTask(task);
    return true;
  }

  root.AiCmPdfHost = {
    parsePdf: parsePdf,
    loadLib: loadLib,
    stop: stop
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AiCmPdfHost;
}(typeof self !== 'undefined' ? self : globalThis));
