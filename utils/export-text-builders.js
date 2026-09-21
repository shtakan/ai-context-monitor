/**
 * Общие сборщики экспорта истории чата (v1.8).
 * Используются и ручными кнопками попапа (options/options.js),
 * и автоэкспортом по порогу (core/content.js).
 * Паттерн как у buildReferenceText.js: работает в браузере
 * (window.AiCmExportBuilders) и в Node (module.exports).
 * Поведение функций НЕ менялось — перенесено из options/options.js.
 */
(function () {
  'use strict';

  // M-4.2: пользовательские строки рендеримого md-документа (шапка и роли) берутся из
  // _locales через chrome.i18n.getMessage (ключи export_md_*). chrome.i18n недоступен
  // (Node/jest, отладочный контекст) → прежний русский литерал: md без локали байтово
  // прежний. Ключи json-схемы (platform/model/...) — формат данных, их НЕ переводим.
  function aiCmI18nMessage(key, fallback, substitutions) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
        var message = substitutions ? chrome.i18n.getMessage(key, substitutions) : chrome.i18n.getMessage(key);
        if (message) return message;
      }
    } catch (eMessage) { }
    return fallback;
  }

  // ===========================================================================
  // O-35: РЕНДЕР REASONING В ЭКСПОРТЕ — контракт DeepSeek, вынесенный в сборщики.
  //   [REASONING]\n<рассуждение>\n\n[ANSWER]\n<ответ>
  // Тот же формат, что собирает сетевой перехватчик (core/deepseek-intercept.js:543,
  // composeTurnText) и что разворачивает сырой режим export-emit-pipeline
  // (includeHiddenExportBlocks). Зачем здесь: путь РУЧНОГО экспорта (попап/options →
  // эти сборщики) до сих пор брал reasoning только из уже склеенного текста; при
  // отдельном поле reasoning (сетевой снимок Qwen: detail.messages[].reasoning +
  // hiddenReasoning) он терялся.
  // Байтовый инвариант для шести существующих платформ (R-пины) держится ДВУМЯ гардами:
  //   1) рассуждения нет вовсе (поля нет / пусто) → возвращается ТОТ ЖЕ текст;
  //   2) рассуждение УЖЕ в тексте (сетевой путь DeepSeek/Claude: секции собраны
  //      перехватчиком) → повторно НЕ дописывается, дубля нет.
  // Функция чистая: не логирует, не читает DOM/chrome, не меняет токены.
  // ===========================================================================
  var REASONING_SECTION_TAG = '[REASONING]';
  var ANSWER_SECTION_TAG = '[ANSWER]';
  function reasoningOfMessage(msg) {
    if (!msg || typeof msg !== 'object') return '';
    var r = msg.reasoning;
    return (typeof r === 'string') ? r : '';
  }
  function withReasoningSections(text, reasoning) {
    var t = (typeof text === 'string') ? text : '';
    var r = (typeof reasoning === 'string') ? reasoning : '';
    if (!r) return t;
    if (t.indexOf(r) !== -1) return t;                 // уже в тексте — не дублируем
    return REASONING_SECTION_TAG + '\n' + r + '\n\n' + ANSWER_SECTION_TAG + '\n' + t;
  }
  function messageTextWithReasoning(msg) {
    if (!msg || typeof msg !== 'object') return '';
    return withReasoningSections(msg.text, reasoningOfMessage(msg));
  }

  // ===========================================================================
  // O-37 (C): ИСТОЧНИК РАЗМЫШЛЕНИЯ ДЛЯ РЕНДЕРА СЕРВИСА БЕЗ СЕТИ (qwen).
  //
  // Живой факт 21:59 (chat=4cf29053): стрим дал размышление (reasoningLen=214), строка reasoning
  // есть в попапе, а в txt/md секции [REASONING] нет. Корень: рендер (messageTextWithReasoning
  // выше) читает ТОЛЬКО поле reasoning, а сообщение сервиса без сети приносит размышление полем
  // ЗАХВАТА hiddenReasoning (O-35: DOM-адаптер складывает туда панель «Завершено размышление»;
  // сетевая ветка точки сбора отдаёт то же размышление полем reasoning). Текст сообщения у
  // сырого объекта адаптера лежит в .content, а не в .text — поэтому композиция маркерного пути
  // берёт базу через messageTextForMarkers (иначе ответ терялся бы).
  //
  // Гейт — тот же маркерный путь (site=qwen): для прочих платформ функция возвращает ровно
  // прежний «эталон» (только поле reasoning), байты не меняются (R1). Нет размышления — нет
  // секции (норма): withReasoningSections возвращает текст байтово.
  // ===========================================================================
  function reasoningOfMessageForExport(msg, useHidden) {
    var r = reasoningOfMessage(msg);
    if (r) return r;
    if (useHidden !== true || !msg || typeof msg !== 'object') return '';
    return (typeof msg.hiddenReasoning === 'string') ? msg.hiddenReasoning : '';
  }
  /** Текст сообщения для маркерного пути + секции [REASONING]/[ANSWER] (текст — как у рендера). */
  function markersMessageTextWithReasoning(msg, useHidden) {
    return withReasoningSections(messageTextForMarkers(msg),
      reasoningOfMessageForExport(msg, useHidden));
  }

  // ===========================================================================
  // O-36 (D2): МАРКЕРЫ РОЛЕЙ В txt ДЛЯ СЕРВИСОВ БЕЗ СЕТИ (qwen).
  // До фикса .txt — «эталон» без ролей ВООБЩЕ: buildReferenceText склеивает тексты
  // сообщений пустой строкой. Там, где история приходит из сети, реплики ещё как-то
  // различимы по разметке самих ответов, а у qwen единственный живой источник —
  // DOM-адаптер (O-35/D2): в файл уходил сплошной поток текста, и вопрос невозможно
  // было отличить от ответа (живой артефакт: скрин 5, txt-экспорт qwen).
  // Формат: перед КАЖДЫМ сообщением строка-маркер роли 'USER:' / 'ASSISTANT:'.
  // Байтовый инвариант шести прежних платформ (R1) держит гард по history.site:
  // сайт не из TXT_ROLE_MARKER_SITES → прежний buildReferenceText 1:1 (ни одного
  // нового байта). Маркеры — формат ДАННЫХ, а не UI-строка (прецедент:
  // [REASONING]/[ANSWER] ниже), поэтому _locales не трогаются.
  // ===========================================================================
  var TXT_ROLE_MARKER_SITES = ['qwen'];
  /** Роли-маркеры включает РОВНО тот сайт, чей живой источник — DOM-адаптер (qwen). */
  function isTxtRoleMarkerHistory(history) {
    try {
      var site = String((history && history.site) || '').toLowerCase();
      return TXT_ROLE_MARKER_SITES.indexOf(site) !== -1;
    } catch (e) { return false; }
  }
  /** Метка роли в txt-экспорте: 'USER:' у user, 'ASSISTANT:' у всех прочих (бинарно, как в проекте). */
  function txtRoleMarker(role) {
    return (role === 'user') ? 'USER:' : 'ASSISTANT:';
  }
  /** O-36 (R2): метка роли в md-экспорте qwen — как в нативном экспорте Qwen Studio
   *  ('### USER' / '### ASSISTANT'). Формат ДАННЫХ, поэтому вне _locales (прецедент:
   *  [REASONING]/[ANSWER]). Прочие платформы держат прежние локализованные заголовки 1:1. */
  function mdRoleMarker(role) {
    return (role === 'user') ? '### USER' : '### ASSISTANT';
  }

  // ===========================================================================
  // O-36 (D2.1, ФИКС по живому артефакту 2026-09-19 20:50): КОНТЕЙНЕР-СКЛЕЙКА.
  //
  // Симптом владельца: txt начинается 'ASSISTANT:', дальше — «сплошняком» без разделения
  // и без 'USER:'. Замер артефакта ai-context-monitor-qwen-Qwen3.8-Max-...-20-50.txt
  // (275 613 знаков, 75 маркеров ролей): сообщения №1 и №2 — ДВА РАВНЫХ блока по 91 595
  // знаков, и каждый содержит текст ВСЕХ остальных 73 реплик (cover=0.9999, длина в 11.6
  // раза больше самой длинной реплики). Это не реплики, а узлы-КОНТЕЙНЕРЫ всего чата:
  // DOM-адаптер qwen (adapters/qwen-adapter.js: первый непустой набор селекторов-кандидатов)
  // отдал контейнерные узлы рядом с настоящими сообщениями. Роль у них 'assistant', поэтому
  // первые 183 КБ файла — «стена» до первого 'USER:'.
  //
  // Правило (чистое, без DOM и без знания селекторов): сообщение, в тексте которого целиком
  // лежат тексты ДВУХ И БОЛЕЕ других сообщений, а сумма этих текстов покрывает почти весь
  // его объём (>= 0.8) и он вдвое длиннее самого длинного из вложенных, — контейнер, а не
  // реплика: в файл не идёт. Порог в 2 вложенных (а не 1) и порог покрытия защищают ЖИВУЮ
  // реплику: ответ, процитировавший один короткий вопрос целиком, контейнером не считается.
  // Гейт — только сайт с маркерами ролей (qwen): прочие платформы байтово прежние (R1).
  // ===========================================================================
  var CONTAINER_MIN_CONTAINED = 2;
  var CONTAINER_COVER_MIN = 0.8;
  /** Текст сообщения для маркерного пути: .text, иначе .content (сырой объект адаптера).
   *  Пустая строка в .text (след reasoning-нормализации) значением не считается: иначе
   *  реплика из одного .content дала бы пустой блок и висячий маркер. */
  function messageTextForMarkers(msg) {
    if (!msg || typeof msg !== 'object') return '';
    if (typeof msg.text === 'string' && msg.text) return msg.text;
    if (typeof msg.content === 'string') return msg.content;
    return (typeof msg.text === 'string') ? msg.text : '';
  }
  /** Сообщения без узлов-контейнеров (см. блок выше). Чистая функция: порядок и объекты
   *  оставшихся сообщений не меняются, поле роли не переписывается. */
  function dropContainerMessages(list) {
    var src = Array.isArray(list) ? list : [];
    var texts = [];
    for (var t = 0; t < src.length; t++) texts.push(messageTextForMarkers(src[t]));
    var keep = [];
    for (var c = 0; c < src.length; c++) {
      var candidate = texts[c];
      var contained = 0;
      var covered = 0;
      var longest = 0;
      if (candidate) {
        for (var j = 0; j < texts.length; j++) {
          var other = texts[j];
          if (j === c || !other || other.length >= candidate.length) continue;
          if (candidate.indexOf(other) === -1) continue;
          contained++;
          covered += other.length;
          if (other.length > longest) longest = other.length;
        }
      }
      var isContainer = (contained >= CONTAINER_MIN_CONTAINED) &&
        (covered >= CONTAINER_COVER_MIN * candidate.length) &&
        (candidate.length >= 2 * longest);
      if (!isContainer) keep.push(src[c]);
    }
    return keep;
  }
  // O-36 (D2.1, ДИАГНОСТИКА, только измерение): структура массива forTxt на маркерном
  // пути — под тем же гейтом aiCmDebug, что и точка скачивания (см. блок O-27/O-32 ниже).
  // Печатается ПЕРВОЕ сообщение (role, тип и длина текста, голова), сколько сообщений
  // дошло до рендера, сколько было до контейнер-чистки и сколько отброшено. Байты файла
  // не меняются: функция только читает уже собранный список. Гейт выключен → тишина.
  function diagTxtRoleStructure(list, totalCount) {
    if (!diagOn()) return false;
    try {
      var kept = Array.isArray(list) ? list.length : -1;
      var total = (typeof totalCount === 'number') ? totalCount : kept;
      var first = (Array.isArray(list) && list.length > 0) ? list[0] : null;
      var text = messageTextForMarkers(first);
      var kind = 'нет';
      if (first && typeof first === 'object') {
        if (typeof first.text === 'string') kind = 'text';
        else if (typeof first.content === 'string') kind = 'content';
      }
      console.log(DIAG_PREFIX + ' txt-roles site=qwen' +
        ' isArray=' + Array.isArray(list) +
        ' msgs=' + total +
        ' kept=' + kept +
        ' dropped-containers=' + ((kept >= 0 && total >= kept) ? (total - kept) : 0) +
        ' first.role=' + ((first && first.role !== undefined && first.role !== null) ? String(first.role) : '(нет)') +
        ' first.kind=' + kind +
        ' first.len=' + text.length +
        ' first.head=' + (diagHead(text, 60) || 'пусто'));
    } catch (eLogRoles) { }
    return true;
  }
  // Рендер «эталона» (окно или Node-модуль). null — рендерер недоступен (отладочный
  // контекст): вызывающий отдаёт прежний пустой результат.
  function renderReferenceText(list) {
    if (typeof window !== 'undefined' && typeof window.buildReferenceText === 'function') {
      return window.buildReferenceText(list);
    }
    if (typeof require === 'function') {
      try { return require('./buildReferenceText.js')(list); } catch (e) { /* fallthrough */ }
    }
    return null;
  }
  /** O-36 (D2/D2.1): тот же «эталон», но с маркером роли перед КАЖДЫМ сообщением;
   *  null — рендерер недоступен. Контракт D2.1: маркер — отдельной строкой, между
   *  блоками ровно одна пустая строка. Вход — только массив (не массив → пустой файл,
   *  а не мусор из посимвольного обхода строки); текст берётся через messageTextForMarkers,
   *  поэтому сырой объект адаптера с .content тоже даёт блок, а не висячий маркер. */
  function renderReferenceTextWithRoleMarkers(list) {
    var src = Array.isArray(list) ? list : [];
    var parts = [];
    for (var i = 0; i < src.length; i++) {
      var m = src[i] || {};
      var text = renderReferenceText([{ role: m.role, text: messageTextForMarkers(m) }]);
      if (text === null) return null;
      if (!String(text).trim()) continue;   // пустой реплике маркер не положен (висячих нет)
      parts.push(txtRoleMarker(m.role) + '\n' + text);
    }
    return parts.join('\n\n');
  }

  // txt «эталон»: тот же buildReferenceText, что использует кнопка «Сохранить .txt»
  // (O-36/D2: для qwen — с маркерами ролей; O-36/D2.1: у qwen дополнительно снимается
  // контейнер-склейка DOM-адаптера, см. блок выше).
  function buildTxtFromHistory(history) {
    var messages = (history && Array.isArray(history.messages)) ? history.messages : [];
    // O-36 (D2.1): чистка идёт по СЫРЫМ текстам и ДО композиции reasoning — иначе
    // контейнер (склейка соседей без рассуждений) перестал бы быть надмножеством
    // реплик, у которых reasoning уже приклеен секциями. Прочие платформы — прежний
    // массив 1:1: ни одного нового байта (R1).
    var marked = isTxtRoleMarkerHistory(history);
    var kept = marked ? dropContainerMessages(messages) : messages;
    // O-35: reasoning приходит отдельным полем → уходит секциями контракта ДО сборки.
    // Сообщения без reasoning возвращаются теми же объектами (байтово).
    // O-37 (C): у маркерного пути (qwen) источник размышления — reasoning, иначе поле захвата
    // hiddenReasoning, а базой текста служит messageTextForMarkers (.text, иначе .content) —
    // ровно то, что рендерит renderReferenceTextWithRoleMarkers.
    var forTxt = kept.map(function (m) {
      var text = marked ? markersMessageTextWithReasoning(m, true) : messageTextWithReasoning(m);
      if (!m || typeof m !== 'object' || text === m.text) return m;
      var copy = {};
      for (var k in m) {
        if (Object.prototype.hasOwnProperty.call(m, k)) copy[k] = m[k];
      }
      copy.text = text;
      return copy;
    });
    var out;
    if (marked) {
      diagTxtRoleStructure(forTxt, messages.length);   // гейт aiCmDebug, только измерение
      out = renderReferenceTextWithRoleMarkers(forTxt);
    } else {
      out = renderReferenceText(forTxt);
    }
    return (out === null) ? '' : out;   // рендерер недоступен → прежний пустой файл
  }

  // md: та же разметка, что использовала кнопка «Сохранить .md» в попапе
  // (M-4.2: шапка и роли — из _locales, ключи export_md_*)
  function buildMdFromHistory(history, platform) {
    var h = history || {};
    var lines = [];
    lines.push(aiCmI18nMessage('export_md_title', '# AI Context Monitor — экспорт истории'));
    lines.push('');
    lines.push(aiCmI18nMessage('export_md_platform', 'Платформа: ' + (platform || 'AI Chat'), [platform || 'AI Chat']));
    lines.push(aiCmI18nMessage('export_md_model', 'Модель: ' + (h.model || '—'), [h.model || '—']));
    var exportedAt = new Date().toISOString();
    lines.push(aiCmI18nMessage('export_md_date', 'Дата экспорта: ' + exportedAt, [exportedAt]));
    var tokens = (typeof h.tokens === 'number') ? h.tokens : 0;
    var limit = (typeof h.limit === 'number') ? h.limit : 0;
    var percent = (typeof h.percent === 'number') ? h.percent : 0;
    lines.push(aiCmI18nMessage('export_md_tokens', 'Токены: ' + tokens + ' / ' + limit + ' (' + percent + '%)', [String(tokens), String(limit), String(percent)]));
    lines.push('');

    // O-36 (R2, D2.1): у qwen роли — маркерами '### USER'/'### ASSISTANT' (формат нативного
    // экспорта Qwen Studio) и та же контейнер-чистка, что у txt: узлы-контейнеры всего чата
    // в md давали ту же «стену» (живой артефакт 21:03). Прочие платформы: прежние
    // локализованные заголовки и прежний массив сообщений 1:1 (R1) — ни одного нового байта.
    var mdMarked = isTxtRoleMarkerHistory(h);
    var messages = Array.isArray(h.messages) ? h.messages : [];
    if (mdMarked) messages = dropContainerMessages(messages);
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i] || {};
      // Claude md (ДИАГНОСТИКА — только измерение под гейтом aiCmDebug): роль хода и вердикт
      // маркерного пути ПЕРЕД выбором заголовка (## Пользователь / ## Ассистент / ### USER…).
      // Канонический хелпер utils/debug.js:aiCmDiagLine; в popup/options его нет, гейт выключен
      // → ни одной строки. Читаются только msg.role и mdMarked: байты md не меняются.
      if (typeof aiCmDiagLine === 'function') {
        aiCmDiagLine('claude-role-builder', { msgRole: msg.role, mdMarked: mdMarked });
      }
      var title = mdMarked
        ? mdRoleMarker(msg.role)
        : ((msg.role === 'user' || msg.role === 'human')
          ? aiCmI18nMessage('export_md_role_user', '## Пользователь')
          : aiCmI18nMessage('export_md_role_assistant', '## Ассистент'));
      lines.push(title);
      lines.push('');
      // O-35: reasoning отдельным полем → секции [REASONING]/[ANSWER] (контракт DeepSeek).
      // Нет рассуждения или оно уже в тексте → байты прежние.
      // O-37 (C): маркерный путь qwen читает ещё и поле захвата hiddenReasoning (см. выше),
      // а базой текста берёт messageTextForMarkers — как txt-путь.
      lines.push(mdMarked ? markersMessageTextWithReasoning(msg, true) : messageTextWithReasoning(msg));
      lines.push('');
    }
    return lines.join('\n');
  }

  // v1.18 (F4): json — та же схема, что у ручной кнопки «Сохранить .json»
  // (options/options.js buildJsonText): platform/model/exportedAt/tokens/limit/percent/messages.
  // Добавлен в общий сборщик, чтобы автоэкспорт по порогу умел json-формат селектора.
  function buildJsonFromHistory(history, platform) {
    var h = history || {};
    return JSON.stringify({
      platform: (platform || 'AI Chat'),
      model: h.model || '',
      exportedAt: new Date().toISOString(),
      tokens: (typeof h.tokens === 'number') ? h.tokens : 0,
      limit: (typeof h.limit === 'number') ? h.limit : 0,
      percent: (typeof h.percent === 'number') ? h.percent : 0,
      messages: Array.isArray(h.messages) ? h.messages : []
    }, null, 2);
  }

  // ===========================================================================
  // O-27/O-32 (ДИАГНОСТИКА, только измерение): лог точки скачивания файла.
  // Гейт — aiCmDebug: sessionStorage 'aiCmDebug' === '1' ИЛИ чекбокс «Подробные логи»
  // (window.__aiCmDebugLogs). В контент-скрипте канонические хелперы даёт utils/debug.js
  // (aiCmDiagDownload); в popup/options этот файл подключён БЕЗ debug.js, поэтому здесь
  // та же семантика реализована локально. Гейт выключен → ни одной строки; функция
  // только читает уже собранные content/fileName и НЕ меняет байты экспорта.
  // ===========================================================================
  // Единый префикс диагностических строк этого файла (ровно одно место — литерал ниже):
  // и обычная строка скачивания, и строка отказа печатаются через DIAG_PREFIX.
  var DIAG_PREFIX = '[AI CM][diag]';
  function diagOn() {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage &&
        sessionStorage.getItem('aiCmDebug') === '1') return true;
    } catch (eSess) { }
    try {
      if (typeof window !== 'undefined' && window && window.__aiCmDebugLogs === true) return true;
    } catch (eWin) { }
    return false;
  }
  function diagHead(v, n) {
    try {
      var lim = (typeof n === 'number' && n > 0) ? n : 100;
      if (v === undefined || v === null) return '';
      var s = String(v);
      if (!s) return '';
      var flat = s.replace(/\s+/g, ' ').trim();
      if (!flat) return '';
      return (flat.length > lim) ? (flat.slice(0, lim) + '…') : flat;
    } catch (eHead) { return ''; }
  }
  function diagStack() {
    try {
      var lines = String((new Error()).stack || '').split('\n');
      var out = [];
      for (var i = 1; i < lines.length && out.length < 4; i++) {
        var s = String(lines[i] || '').replace(/\s+/g, ' ').trim();
        if (!s || s.indexOf('diag') !== -1) continue;
        out.push(s);
      }
      return out.join(' <- ');
    } catch (eStack) { return ''; }
  }
  // Единая точка: триггер, имя файла (пустое — словом «пустое»), первые 100 символов
  // базы, её длина, URL документа, threadId, источник вызова (dev-режим).
  function diagDownload(trigger, content, fileName, extra) {
    try {
      if (typeof aiCmDiagDownload === 'function') return aiCmDiagDownload(trigger, content, fileName, extra);
    } catch (eGlobal) { }
    if (!diagOn()) return false;
    try {
      var e = extra || {};
      var url = '';
      try { url = String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eUrl) { }
      console.log(DIAG_PREFIX + ' download trigger=' + (trigger || '(нет)') +
        ' file=' + ((fileName === undefined || fileName === null || String(fileName) === '') ? 'пустое' : String(fileName)) +
        ' bytes100=' + (diagHead(content, 100) || 'пусто') +
        ' len=' + ((content === undefined || content === null) ? 0 : String(content).length) +
        ' mime=' + (e.mime === undefined ? '(нет)' : e.mime) +
        ' url=' + url +
        ' threadId=' + (e.threadId === undefined || e.threadId === '' ? '(нет)' : e.threadId) +
        ' site=' + (e.site === undefined ? '' : e.site) +
        ' reason=' + (e.reason === undefined ? '' : e.reason) +
        ' src=' + diagStack());
    } catch (eLog) { }
    return true;
  }

  // ===========================================================================
  // O-27 (защитный фикс, пост-гард ЕДИНСТВЕННОЙ точки скачивания): файл НЕ выдаётся,
  // если контент — форма мусора (первые байты — XSSI-префикс Google `)]}'`; живой артефакт
  // `f.txt` с captcha-страницы) ИЛИ имя файла пустое/не задано (живой путь: автоэкспорт на
  // captcha-странице скачал мусор с ПУСТЫМ именем). Отказ — поведение точки (ловится любой
  // триггер: автоэкспорт, попап/options, печать); сама строка отказа (download-blocked,
  // reason=xssi-prefix|empty-name) печатается только под гейтом aiCmDebug. Content/fileName
  // только читаются: байты легитимного экспорта не меняются.
  // ===========================================================================
  var XSSI_PREFIX_LEN = 4;
  // Первые байты контента — четырёхсимвольный XSSI-префикс Google (`)]}'`)? Сравнение по
  // кодам символов: в литерале нет фигурной скобки (source-пин-тесты режут функции по
  // балансу скобок).
  function startsWithXssiPrefix(content) {
    try {
      if (content === undefined || content === null) return false;
      var s = String(content);
      if (s.length < XSSI_PREFIX_LEN) return false;
      return s.charCodeAt(0) === 41 && s.charCodeAt(1) === 93 &&
        s.charCodeAt(2) === 125 && s.charCodeAt(3) === 39;
    } catch (eXssi) { return false; }
  }
  // Причина отказа точки скачивания или null. Контент проверяется ПЕРВЫМ: живой `f.txt`
  // подходит под оба условия (XSSI-тело + пустое имя), и решающая причина там — форма мусора.
  function downloadBlockReason(content, fileName) {
    if (startsWithXssiPrefix(content)) return 'xssi-prefix';
    if (fileName === undefined || fileName === null || String(fileName).trim() === '') return 'empty-name';
    return null;
  }
  // Строка отказа: `download-blocked reason=<причина> …` с общим префиксом DIAG_PREFIX.
  // В контент-скрипте приоритет у канонического хелпера utils/debug.js (тот же гейт
  // aiCmDebug и та же строка).
  function diagDownloadBlocked(trigger, content, fileName, reason, extra) {
    try {
      if (typeof aiCmDiagDownloadBlocked === 'function') {
        return aiCmDiagDownloadBlocked(trigger, content, fileName, reason, extra);
      }
    } catch (eGlobalBlocked) { }
    if (!diagOn()) return false;
    try {
      var e = extra || {};
      var url = '';
      try { url = String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eUrlB) { }
      console.log(DIAG_PREFIX + ' download-blocked reason=' + (reason || '(нет)') +
        ' trigger=' + (trigger || '(нет)') +
        ' file=' + ((fileName === undefined || fileName === null || String(fileName) === '') ? 'пустое' : String(fileName)) +
        ' bytes100=' + (diagHead(content, 100) || 'пусто') +
        ' len=' + ((content === undefined || content === null) ? 0 : String(content).length) +
        ' mime=' + (e.mime === undefined ? '(нет)' : e.mime) +
        ' url=' + url +
        ' threadId=' + (e.threadId === undefined || e.threadId === '' ? '(нет)' : e.threadId) +
        ' site=' + (e.site === undefined ? '' : e.site) +
        ' src=' + diagStack());
    } catch (eLogBlocked) { }
    return true;
  }

  // Скачивание через blob + временную ссылку (как раньше в options.js)
  // O-27/O-32: 4-й аргумент trigger и 5-й extra — ТОЛЬКО для диагностической строки;
  // поведение, байты (content), mime и имя файла не меняются.
  // O-27 (защитный фикс): перед выдачей файла — пост-гард формы мусора/пустого имени.
  function downloadBlob(content, fileName, mimeType, trigger, extra) {
    var ex = extra || {};
    var blockReason = downloadBlockReason(content, fileName);
    if (blockReason) {
      try {
        diagDownloadBlocked(trigger || 'builder-download', content, fileName, blockReason,
          { mime: mimeType, threadId: ex.threadId, site: ex.site });
      } catch (eDiagBlocked) { }
      return false; // файл не выдан: форма мусора либо имя не задано
    }
    try {
      diagDownload(trigger || 'builder-download', content, fileName,
        { mime: mimeType, threadId: ex.threadId, site: ex.site, reason: ex.reason });
    } catch (eDiag) { }
    try {
      var blob = new Blob([content], { type: mimeType });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      console.warn('[export] не удалось скачать файл:', e);
    }
    return true;
  }

  var Api = {
    buildTxtFromHistory: buildTxtFromHistory,
    buildMdFromHistory: buildMdFromHistory,
    buildJsonFromHistory: buildJsonFromHistory,
    downloadBlob: downloadBlob,
    // O-27 (защитный фикс): причина отказа точки скачивания (null — выдача разрешена) и
    // сама точка отказа наружу — для пинов тестов и переиспользования вызывающим кодом.
    aiCmDownloadBlockReason: downloadBlockReason,
    aiCmDiagDownloadBlocked: diagDownloadBlocked,
    // O-27/O-32: диагностические хелперы наружу (content.js/export-manager.js зовут их
    // через window.AiCmExportBuilders, если глобальный utils/debug.js не подключён).
    aiCmDiagOn: diagOn,
    aiCmDiagHead: diagHead,
    aiCmDiagDownload: diagDownload,
    // O-35: рендер reasoning контрактом DeepSeek — чистая функция наружу (пины тестов
    // и переиспользование; на боевом пути вызывается только двумя сборщиками выше).
    aiCmMessageTextWithReasoning: messageTextWithReasoning,
    aiCmWithReasoningSections: withReasoningSections,
    // O-37 (C): источник размышления для маркерного пути (reasoning, иначе поле захвата
    // hiddenReasoning) и композиция «текст сообщения + секции» — чистые функции наружу;
    // на боевом пути их зовут только buildTxtFromHistory/buildMdFromHistory выше.
    aiCmReasoningOfMessageForExport: reasoningOfMessageForExport,
    aiCmMarkersMessageTextWithReasoning: markersMessageTextWithReasoning,
    // O-36 (D2): маркеры ролей txt-экспорта — чистые предикаты наружу (пины тестов;
    // на боевом пути вызываются только сборщиком buildTxtFromHistory выше).
    aiCmTxtRoleMarker: txtRoleMarker,
    aiCmIsTxtRoleMarkerHistory: isTxtRoleMarkerHistory,
    aiCmTxtRoleMarkerSites: TXT_ROLE_MARKER_SITES,
    // O-36 (D2.1): маркер роли md (Qwen Studio), текст сообщения для маркерного пути
    // (с фолбэком на .content) и контейнер-чистка — чистые функции наружу для пинов
    // и переиспользования; на боевом пути их зовут только два сборщика выше.
    aiCmMdRoleMarker: mdRoleMarker,
    aiCmMessageTextForMarkers: messageTextForMarkers,
    aiCmDropContainerMessages: dropContainerMessages,
    aiCmDiagTxtRoleStructure: diagTxtRoleStructure,
    aiCmContainerRules: { minContained: CONTAINER_MIN_CONTAINED, coverMin: CONTAINER_COVER_MIN }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmExportBuilders = Api;
})();
