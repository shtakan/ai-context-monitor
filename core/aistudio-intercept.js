/**
 * core/aistudio-intercept.js — сетевой перехватчик истории Google AI Studio.
 *
 * МИР: MAIN (page world). Регистрируется из core/background.js через
 * chrome.scripting.registerContentScripts({ world: 'MAIN' }) для aistudio.google.com,
 * рядом с core/gemini-intercept.js (тот подключается к AI Studio ради счётчика
 * https://aistudio.google.com/generate_204, но историю диалога не разбирает).
 *
 * ЗАЧЕМ. Бейдж AI Studio считался по DOM (adapters/aistudio-adapter.js,
 * ms-cmark-node.v3-font-body): длинные ответы виртуализированы, часть реплик в DOM
 * отсутствует, а счётчик токенов был всегда эвристическим. AI Studio грузит историю
 * диалога и токены запросами `$rpc` (UpdatePrompt / CreatePrompt / GenerateContent) —
 * ответ и тело запроса это JSON-массив протобуфера. Точные пути взяты из живого
 * захвата (октябрь 2026, чат /prompts/1sLNDy3E1UDKpOyYVg1kcWCk6PvB70rOS, 3 хода):
 *
 *   • UpdatePrompt/CreatePrompt/ResolveDriveResource, ОТВЕТ — `data[13][0]`: массив
 *     сообщений, где текст хода лежит в `msg[0]`, роль — в `msg[8]` ('user' / 'model'),
 *     а `msg[19] === 1` помечает «мысль» модели (reasoning). ResolveDriveResource —
 *     тот же Prompt-ресурс, который AI Studio читает при холодном открытии
 *     /prompts/<id>; без него после F5 в бейдже было «2 узла» из виртуализированного
 *     DOM, а полная история появлялась только после первого UpdatePrompt. Мысль — не реплика диалога: в захвате
 *     каждая пара «мысль/ответ» лежит ДВУМЯ соседними сообщениями с ролью 'model'
 *     (9 сообщений на 3 хода), поэтому reasoning отфильтровывается — иначе история
 *     удваивалась бы и в счётчик попадал текст размышлений.
 *   • GenerateContent, ТЕЛО ЗАПРОСА — `data[1]`: массив ходов вида `[[part, ...],
 *     role]`, текст каждой части — `turn[0][j][1]`, роль — `turn[1]`. У ответа
 *     модели первая часть — reasoning (последний элемент части равен 1), остальные
 *     части — куски одного текста, поэтому склеиваются БЕЗ разделителя: фрагменты
 *     «Тест 1 пройден успешно! Связь работает отлично» + «. \n\nЧем могу помочь?»
 *     дают ровно ту же строку, что и сохранённое сообщение в ответе UpdatePrompt.
 *     Это самый свежий снимок: в теле уже есть только что отправленная реплика.
 *   • GenerateContent, ОТВЕТ — токены контекста. Тело — `[ [chunk, ...] ]`, каждый
 *     chunk это `[content, null, usage, null, id]`, а usage = `[promptTokens,
 *     candidateTokens, totalTokens, ...]`. Число токенов контекста — `chunk[2][0]`;
 *     значение накапливается по потоку (219 → 486), поэтому берётся максимум —
 *     это финальный promptTokenCount (486 в захвате; 634 total = 486 + 38 ответа +
 *     110 «мыслей», в контекст бейджа total не идёт).
 *
 * ПОЧЕМУ НЕ CountTokens. `$rpc/.../CountTokens` вызывается на каждый ввод и
 * возвращает только ВХОД (в захвате 9 или 5632 токена), без ответов модели: для
 * размера контекста диалога это неверное число. Ветка удалена — серверный счётчик
 * берётся из GenerateContent (как у Gemini/Qwen/Claude берётся из ответа модели).
 *
 * КАК. Патчим fetch и XMLHttpRequest (как core/gemini-sse.js: снимок оргиналов на
 * старте ДО кода страницы, цепочка вызовов не рвётся). У fetch читаем `init.body`
 * (только строка) и `clone().text()` ответа; у XHR — аргумент `send(body)` и
 * `responseText`/`response` по событию `load`. Тело разбирается терпимо: JSON-массив
 * протобуфера, XSSI-префикс `)]}'`, ответ без массива/SSE — молча пропускаем.
 *
 * БИНАРНЫЕ ТЕЛА (v2.0.30). Живой AI Studio отдаёт GenerateContent XHR'ом с
 * `responseType='arraybuffer'` — строки `responseText` там нет, а прежний код на
 * arraybuffer/blob просто выходил из обработчика, и usage-токены не доезжали до
 * бейджа. Теперь байты декодируются TextDecoder (UTF-8) в тот же JSON-протобуфер.
 * SSE-гард остался только у не-generate URL: стрим GenerateContent — источник usage
 * (кадры `data:...`), его тело обязано читаться.
 *
 * ГДЕ ЕЩЁ ЖИВЁТ usageMetadata (v2.0.31). Кроме нативного `$rpc`/GenerateContent тот
 * же вызов приходит REST-формой: `generativelanguage.googleapis.com/v1beta/models/
 * <model>:generateContent` и `:streamGenerateContent?alt=sse`. У REST-ответа нет
 * протобуферного `chunk[2][0]` — токены лежат в `usageMetadata.promptTokenCount`
 * (у SSE — в кадрах `data:`). Прежний `isGenerateRpc` требовал `$rpc` и отсекал
 * оба варианта: счётчик оставался эвристическим, хотя серверное число приходило.
 * Теперь признак — метод `:generateContent`/`:streamGenerateContent` в любой из трёх
 * форм, а `parseUsageTokens` понимает и протобуфер (массивы), и объект `usageMetadata`.
 *
 * МОСТ. Наружу (в ISOLATED, core/content.js) уходят два события, detail — СТРОКОЙ
 * JSON (Xray/Firefox, v2.0.29; приём — aiCmBridgeDetail в core/content.js):
 *   'ai-cm-aistudio-net' { kind: 'history', msgs: [{role, text}], count, url, ts }
 *   'ai-cm-aistudio-net' { kind: 'count',   serverTokens, url, ts }
 * Обратный канал (ISOLATED→MAIN) — 'ai-cm-aistudio-net-settings' { verbose: true }:
 * включает подробные строки в консоли (разбирается тем же aiCmBridgeDetail).
 *
 * CONTRACT: никаких сетевых запросов отсюда не инициируется, данные не сохраняются —
 * только чтение уже полученных/отправленных тел и передача их в ISOLATED.
 */
(function () {
  'use strict';

  // Идемпотентность: повторная инъекция (импорт ×2, повторный registerContentScripts)
  // не должна навешивать вторую обёртку на fetch/XHR.
  if (window.AiCmAistudioIntercept) return;

  var LOG_TAG = '[aistudio-intercept]';
  var RPC_MARK = '$rpc';
  // Роли протобуфера AI Studio: 'user' у хода пользователя, 'model' у ответа.
  // В контракт адаптеров модель уходит как 'assistant'.
  var ROLE_USER = 'user';
  var ROLE_AI = 'assistant';

  var verbose = false;     // 'ai-cm-aistudio-net-settings' { verbose: true }
  var lastTokens = 0;      // последний promptTokenCount (дедуп лога/события)
  var lastHistorySig = ''; // подпись последнего снимка истории (дедуп)
  // v2.0.34: причина последнего пустого разбора — для строки 'aistudio-history-skip'
  // (shape-miss | no-array | empty | not-json) и факта ResolveDriveResource.
  var lastHistoryReason = '';
  var lastSnapshotWarnSig = ''; // дедуп console.warn о промахе формы

  // Вложения (plan-aistudio-files.md): сырой снимок нужен для повторного
  // emitHistory после догрузки текста; nativeFetch — чтобы модуль вложений
  // не ходил через собственный патченный fetch.
  var lastHistoryMsgs = null;
  var lastHistoryUrl = '';
  var nativeFetch = null;
  var filesBound = false;
  var pendingFileToken = '';

  /* ================================================================== *
   * 0. Мост detail (Xray/Firefox): тело одинаковое во всех мирах
   *    (tests/firefox-xray-bridge.test.js: X3) — строка JSON разбирается,
   *    объект проходит как есть, мусор → null.
   * ================================================================== */

  function aiCmBridgeDetail(ev) {
    var raw = (ev && ev.detail !== undefined) ? ev.detail : null;
    if (typeof raw !== 'string') return raw || null;
    try { return JSON.parse(raw); } catch (eBd) { return null; }
  }

  function soft(e, tag) {
    if (typeof swallowSoft === 'function') { swallowSoft(e, tag); return; }
    // source-песочницы тестов грузят файл без utils/debug.js — тогда молчим:
    // консольный канал в MAIN-мире принадлежит aiCmDiagWarn (канал B, под гейтом).
    if (typeof aiCmDiagWarn !== 'function') return;
    // eslint-disable-next-line no-restricted-syntax
    aiCmDiagWarn('aistudio-intercept', tag + ': ' + ((e && e.message) ? e.message : String(e)));
  }

  // ISOLATED→MAIN: единственная настройка — подробные логи (по умолчанию молчим,
  // кроме обязательной строки 'history loaded msgs=N').
  window.addEventListener('ai-cm-aistudio-net-settings', function (ev) {
    var d = aiCmBridgeDetail(ev);
    if (d && typeof d.verbose === 'boolean') verbose = d.verbose;
  });

  /* ================================================================== *
   * 1. Классификация URL
   * ================================================================== */

  /**
   * GenerateContent под `$rpc`: тело запроса несёт историю (`data[1]`), ответ —
   * usage токенов (`[0][last][2][0]`). Оба потока разбираются в hooks.
   */
  /**
   * GenerateContent — источник токенов контекста. Один серверный метод в трёх формах URL:
   *   1) нативный веб-вызов AI Studio — `$rpc/…/GenerateContent` (JSON-протобуфер);
   *   2) REST того же метода — `generativelanguage.googleapis.com/v1beta/models/
   *      <model>:generateContent` (его зовёт API-плейграунд AI Studio);
   *   3) REST-стрим — `…:streamGenerateContent?alt=sse` (кадры `data:`).
   * Прежний признак (`$rpc` + /generatecontent/) отсекал 2 и 3: usageMetadata и
   * promptTokenCount из REST-тела не доезжали, счётчик оставался эвристикой.
   * Имя метода проверяется первым, поэтому «GenerateContent» вне $rpc и без REST-хоста
   * (страничный /api/GenerateContent, CountTokens) по-прежнему не наш вызов.
   */
  function isGenerateRpc(url) {
    if (!url) return false;
    var u = String(url);
    if (!/generatecontent/i.test(u)) return false;
    if (u.indexOf(RPC_MARK) !== -1) return true;                      // 1) нативный $rpc
    if (/streamgeneratecontent/i.test(u)) return true;                // 3) REST-стрим
    return u.indexOf('generativelanguage.googleapis.com') !== -1;     // 2) REST-хост
  }

  /**
   * История диалога под тем же `$rpc`: UpdatePrompt / CreatePrompt — ответ это
   * полный снимок `data[13][0]` после смены ходов; ResolveDriveResource — тот же
   * Prompt-ресурс, который AI Studio читает при холодном открытии /prompts/<id>
   * (до него в DOM лежат 1-2 виртуализированных узла, и бейдж показывал «2 узла»).
   *   ListPrompts сюда НЕ входит: это библиотека промптов, `data[13]` в её ответе нет
   *   (в живом захвате ответ ListPrompts — список карточек, не диалог).
   *   CountTokens сюда тоже не входит — счётчик берётся из GenerateContent.
   */
  function isHistoryRpc(url) {
    if (!url || url.indexOf(RPC_MARK) === -1) return false;
    return /updateprompt|createprompt|resolvedriveresource/i.test(url);
  }

  /* ================================================================== *
   * 1b. Диагностика формы тела (канал B, гейт aiCmDebug)
   *
   * ЗАЧЕМ. Пустой разбор истории на живом ResolveDriveResource — единственный класс
   * ошибки, который не виден снаружи: событие просто не уходит, в консоли ничего нет,
   * и приёмка «2 узла вместо 6» повторяется вслепую. Здесь печатается ФОРМА ответа
   * (какие поля root непусты, что лежит в root[13]), по ней путь данных виден без
   * повторного захвата DevTools.
   *
   * КОНТРАКТ. Только чтение уже полученного текста; ни одного нового события,
   * ни записи в storage. Строка идёт под гейтом: sessionStorage 'aiCmDebug' === '1'
   * (utils/debug.js подключён к этому скрипту — core/background.js:343), а в
   * source-песочницах тестов aiCmDiagLine нет — там гейт читается напрямую.
   * ================================================================== */

  function diagLine(tag, fields) {
    try {
      if (typeof aiCmDiagLine === 'function') { aiCmDiagLine(tag, fields); return; }
    } catch (eDg) {
      soft(eDg, 'aistudio-intercept:diag');
    }
    var gateOn = false;
    try {
      gateOn = (typeof sessionStorage !== 'undefined' && !!sessionStorage
        && sessionStorage.getItem('aiCmDebug') === '1');
    } catch (eDs) {
      soft(eDs, 'aistudio-intercept:diag-gate');
    }
    if (!gateOn) return;
    try {
      var parts = [];
      for (var k in fields) {
        if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
        var v = fields[k];
        parts.push(k + '=' + ((v === undefined || v === null) ? '(нет)' : String(v)));
      }
      console.log(LOG_TAG + ' ' + tag + ' ' + parts.join(' '));
    } catch (eDp) {
      soft(eDp, 'aistudio-intercept:diag-print');
    }
  }

  /** Гейт диагностики: sessionStorage 'aiCmDebug' === '1' (тот же, что у diagLine). */
  function debugGateOn() {
    try {
      return (typeof sessionStorage !== 'undefined' && !!sessionStorage
        && sessionStorage.getItem('aiCmDebug') === '1');
    } catch (eG) { return false; }
  }

  /**
   * Форма протобуферного значения одной строкой: длина массива + непустые индексы
   * (до 12). `len33[0,1,8,18,19,32]` сразу говорит, сообщение это или служебный кортеж.
   */
  function shapeOfArray(v) {
    if (!Array.isArray(v)) return (v === null || v === undefined) ? 'null' : typeof v;
    var idx = [];
    for (var i = 0; i < v.length && idx.length < 12; i++) {
      if (v[i] !== null && v[i] !== undefined) idx.push(i);
    }
    return 'len' + v.length + '[' + idx.join(',') + ']';
  }

  /** История не разобралась: печатаем форму ответа (не текст целиком — размер/голова). */
  function diagEmptyHistory(url, text, root) {
    try {
      var r13 = (Array.isArray(root) && Array.isArray(root[13])) ? root[13] : null;
      diagLine('aistudio-history-empty', {
        rpc: String(url || '').replace(/^.*\//, ''),
        rootKind: Array.isArray(root) ? 'array' : (root === null ? 'not-json' : typeof root),
        rootLen: Array.isArray(root) ? root.length : 'N/A',
        root13Len: r13 ? r13.length : 'N/A',
        firstItemKeys: (r13 && r13.length > 0) ? shapeOfArray(r13[0]) : 'N/A',
        bodyLen: (typeof text === 'string') ? text.length : 0,
        bodyHead: (typeof text === 'string') ? text.slice(0, 160).replace(/\s+/g, ' ') : ''
      });
    } catch (eDh) {
      soft(eDh, 'aistudio-intercept:diag-history');
    }
  }

  /* ================================================================== *
   * 2. Разбор тел (чистые функции — их пинует
   *    tests/adapters/aistudio-network.test.js)
   * ================================================================== */

  /** Тело ответа → значение JSON, либо null (не наш формат / SSE / мусор). */
  function parseJsonText(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    // XSSI-префикс Google: )]}' — и BOM на всякий случай.
    var s = text.replace(/^\uFEFF/, '').replace(/^\)\]\}'[^\n]*\n?/, '').trim();
    if (!s) return null;
    var c = s.charAt(0);
    if (c !== '[' && c !== '{') return null; // SSE-поток и text/plain
    try { return JSON.parse(s); } catch (ePj) { return null; }
  }

  /** Строка — известная роль протобуфера AI Studio (`msg[8]`, `turn[1]`). */
  function isRoleName(role) {
    return role === 'user' || role === 'model' || role === 'assistant' || role === 'human';
  }

  /** Роль хода протобуфера → контракт адаптеров ('user' | 'assistant'). */
  function normRole(role) {
    if (role === 'user' || role === 'human') return ROLE_USER;
    return ROLE_AI;
  }

  /** Строка похожа на сообщение снимка: текст `m[0]`, роль `m[8]`. */
  function looksLikeMessageRow(m) {
    return Array.isArray(m) && typeof m[0] === 'string' && isRoleName(m[8]);
  }

  /** Массив выглядит как снимок: непустой, все элементы-массивы, есть message-строки. */
  function isRowsArray(v) {
    if (!Array.isArray(v) || v.length === 0) return false;
    var hits = 0;
    for (var i = 0; i < v.length; i++) {
      if (v[i] === null || v[i] === undefined) continue;
      if (!Array.isArray(v[i])) return false;
      if (looksLikeMessageRow(v[i])) hits++;
    }
    return hits > 0;
  }

  /**
   * Drive file id из поля [3] строки-вложения. В живом чате это массив
   * строк (`['17NuA9Ex…']`); вложенный массив — защита от формы [0][0].
   */
  function fileIdsOfRow(m) {
    var out = [];
    var field = (Array.isArray(m) && Array.isArray(m[3])) ? m[3] : null;
    if (!field) return out;
    for (var i = 0; i < field.length; i++) {
      var v = field[i];
      if (typeof v === 'string' && v) { out.push(v); continue; }
      if (Array.isArray(v) && typeof v[0] === 'string' && v[0]) out.push(v[0]);
    }
    return out;
  }

  /**
   * Перенос fileId на СЛЕДУЮЩУЮ user-строку: в UI вложение и текст запроса —
   * один ход, но в сети это две строки (m[0]=null с m[3], затем текст).
   * Строка-вложение без текста после слияния удаляется; если следующей
   * user-строки нет — остаётся самостоятельный user-ход (адаптер покажет
   * его, когда появится непустая sections).
   */
  function mergeFileRows(msgs) {
    var out = [];
    var carry = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var files = (m && Array.isArray(m.files) && m.files.length) ? m.files : null;
      if (files) {
        carry = carry ? carry.concat(files) : files.slice();
        if (!m.text) continue;
      }
      if (carry) {
        if (m.role === ROLE_USER) {
          out.push({ role: ROLE_USER, text: m.text || '', files: carry });
          carry = null;
          continue;
        }
        out.push({ role: ROLE_USER, text: '', files: carry });
        carry = null;
      }
      out.push(m);
    }
    if (carry) out.push({ role: ROLE_USER, text: '', files: carry });
    return out;
  }

  /** Строки снимка → сообщения (reasoning `m[19] === 1` не реплика). */
  function msgsFromRows(rows) {
    var out = [];
    if (!Array.isArray(rows)) return out;
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i];
      if (!Array.isArray(m)) continue;
      if (m[19] === 1) continue;                       // reasoning, не реплика
      if (!isRoleName(m[8])) continue;
      var text = (typeof m[0] === 'string') ? m[0].replace(/\r\n?/g, '\n').trim() : '';
      var ids = fileIdsOfRow(m);
      // Служебные чанки (m[0]=null без m[3]) по-прежнему не реплики.
      if (ids.length === 0 && !text) continue;
      var rec = { role: normRole(m[8]), text: text };
      if (ids.length > 0) rec.files = ids;
      out.push(rec);
    }
    return mergeFileRows(out);
  }

  /**
   * Рекурсивный (BFS) поиск массива-снимка. Лимиты глубины/узлов — форма приватная,
   * тело большое; в найденный массив сообщений не спускаемся. При равенстве счётчика
   * побеждает первый (самый неглубокий) кандидат — стабильно и предсказуемо.
   */
  function findRowsArray(root) {
    var best = [];
    var bestPath = '';
    var bestCount = 0;
    var candidates = 0;
    var queue = [{ v: root, path: '', depth: 0 }];
    var head = 0;
    var visited = 0;
    while (head < queue.length && visited < 4000) {
      var cur = queue[head++];
      visited++;
      var v = cur.v;
      if (cur.path !== '' && isRowsArray(v)) {
        candidates++;
        var msgs = msgsFromRows(v);
        if (msgs.length > bestCount) {
          best = msgs;
          bestPath = cur.path;
          bestCount = msgs.length;
        }
        continue;
      }
      if (cur.depth >= 10) continue;
      for (var i = 0; i < v.length; i++) {
        if (!Array.isArray(v[i])) continue;
        queue.push({
          v: v[i],
          path: cur.path === '' ? String(i) : cur.path + '[' + i + ']',
          depth: cur.depth + 1
        });
      }
    }
    return { msgs: best, path: bestPath, candidates: candidates };
  }

  /**
   * Снимок из ОТВЕТА UpdatePrompt/CreatePrompt/ResolveDriveResource → сообщения.
   *
   * Известный путь: `root[13][0]` — массив сообщений, текст `msg[0]`, роль `msg[8]`,
   * `msg[19] === 1` — «мысль» модели (reasoning). Если форма не совпала (живой
   * ResolveDriveResource на холодном старте кладёт историю иначе), ищется ЛЮБОЙ
   * вложенный массив той же сигнатуры: элементы-массивы, среди них есть строки с
   * текстом и известной ролью. Сообщения без строкового текста/роли отбрасываются:
   * в `root[13]` рядом с историей встречаются служебные кортежи (в запросе
   * GenerateContent `root[13]` — таймзона, а не ходы).
   */
  function findSnapshotMessages(root) {
    if (!Array.isArray(root)) return { msgs: [], path: '', candidates: 0 };
    if (Array.isArray(root[13]) && Array.isArray(root[13][0])) {
      var known = msgsFromRows(root[13][0]);
      if (known.length > 0) return { msgs: known, path: '13[0]', candidates: 1 };
    }
    if (isRowsArray(root)) {
      var self = msgsFromRows(root);
      if (self.length > 0) return { msgs: self, path: 'root', candidates: 1 };
    }
    var found = findRowsArray(root);
    return { msgs: found.msgs, path: found.path, candidates: found.candidates };
  }

  function msgsFromSnapshot(root) {
    return findSnapshotMessages(root).msgs;
  }

  /**
   * Reasoning-часть в теле запроса GenerateContent: у «мысли» последний элемент
   * части равен 1 (`[null, "**Interpreting…**", null, …, 1]`), у обычного текста
   * часть короче (`[null, "текст"]`) либо несёт подпись мысли строкой.
   */
  function isReasoningPart(part) {
    return part.length > 2 && part[part.length - 1] === 1;
  }

  /**
   * Снимок из ТЕЛА ЗАПРОСА GenerateContent → сообщения.
   *
   * Точный путь: `root[1]` — массив ходов `[[part, ...], role]`, текст части
   * `turn[0][j][1]`, роль `turn[1]`. Части одного хода склеиваются БЕЗ разделителя
   * (модель стримит ответ кусками, а storage хранит уже склеенную строку), reasoning
   * пропускается. Снимок самый свежий: в теле запроса уже есть отправленная реплика,
   * которой ещё нет в сохранённой истории (UpdatePrompt приходит после ответа).
   */
  function msgsFromRequest(root) {
    var out = [];
    if (!Array.isArray(root) || !Array.isArray(root[1])) return out;
    var turns = root[1];
    for (var i = 0; i < turns.length; i++) {
      var turn = turns[i];
      if (!Array.isArray(turn) || !Array.isArray(turn[0]) || !isRoleName(turn[1])) continue;
      var parts = turn[0];
      var buf = [];
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (!Array.isArray(part) || isReasoningPart(part)) continue;
        if (typeof part[1] !== 'string' || part[1].length === 0) continue;
        buf.push(part[1]);
      }
      var text = buf.join('').replace(/\r\n?/g, '\n').trim();
      if (!text) continue;
      out.push({ role: normRole(turn[1]), text: text });
    }
    return out;
  }

  /**
   * Массив сообщений истории из разобранного JSON. Приоритет — известный снимок
   * (`data[13][0]`), затем рекурсивный поиск по сигнатуре, затем тело запроса
   * (`data[1]`). Возвращает путь (виден в тестах) и причину промаха для диагностики.
   */
  function findMessageArray(root, url) {
    var snap = findSnapshotMessages(root);
    if (snap.msgs.length > 0) return { msgs: snap.msgs, path: snap.path, reason: '' };
    var req = msgsFromRequest(root);
    if (req.length > 0) return { msgs: req, path: '1', reason: '' };
    var reason = snapshotMissReason(root, snap);
    if (typeof url === 'string' && isHistoryRpc(url)) warnSnapshotMiss(root, reason);
    return { msgs: [], path: '', reason: reason };
  }

  /** Сколько вложенных массивов в root (с лимитом — тело большое, форма приватная). */
  function countArrays(root, cap) {
    if (!Array.isArray(root)) return 0;
    var n = 1;
    var stack = [root];
    while (stack.length > 0 && n < cap) {
      var v = stack.pop();
      for (var i = 0; i < v.length && n < cap; i++) {
        if (Array.isArray(v[i])) { n++; stack.push(v[i]); }
      }
    }
    return n;
  }

  /** Причина промаха: shape-miss (массивы есть, сигнатуры нет) или no-array. */
  function snapshotMissReason(root, snap) {
    if (!Array.isArray(root)) return 'no-array';
    if (snap.candidates > 0) return 'shape-miss';
    return countArrays(root, 64) > 1 ? 'shape-miss' : 'no-array';
  }

  /** Один компактный console.warn на форму (без текста тела), дедуп по отпечатку. */
  function warnSnapshotMiss(root, reason) {
    try {
      var r13 = Array.isArray(root) ? root[13] : undefined;
      var rootLen = Array.isArray(root) ? root.length : 'N/A';
      var r13Desc = Array.isArray(r13) ? ('len' + r13.length) : ((r13 === null || r13 === undefined) ? 'null' : typeof r13);
      var arrays = countArrays(root, 2000);
      var sig = rootLen + '|' + r13Desc + '|' + arrays;
      if (sig === lastSnapshotWarnSig) return;
      lastSnapshotWarnSig = sig;
      console.warn(LOG_TAG + ' snapshot miss reason=' + reason + ' rootLen=' + rootLen +
        ' root13=' + r13Desc + ' arrays=' + arrays + ' rootShape=' + shapeOfArray(root));
    } catch (eW) {
      soft(eW, 'aistudio-intercept:warn-miss');
    }
  }

  /**
   * История из тела (ответа UpdatePrompt/CreatePrompt/ResolveDriveResource либо запроса
   * GenerateContent). `url` необязателен: с ним пустой разбор пишет диаг-строку о форме
   * (только для history-RPC и только под гейтом aiCmDebug), без него — молчание.
   */
  function parseHistory(text, url) {
    var root = parseJsonText(text);
    var isHistoryUrl = (typeof url === 'string') && isHistoryRpc(url);
    if (root === null) {
      lastHistoryReason = (typeof text === 'string' && text.length > 0) ? 'not-json' : 'empty';
      if (isHistoryUrl) diagEmptyHistory(url, text, null);
      return [];
    }
    var found = findMessageArray(root, url);
    if (found.msgs.length > 0) {
      lastHistoryReason = '';
      return found.msgs;
    }
    lastHistoryReason = found.reason || 'shape-miss';
    if (isHistoryUrl) diagEmptyHistory(url, text, root);
    return found.msgs;
  }

  /**
   * Токены из одного элемента ответа GenerateContent. Чанк потока —
   * `[content, null, usage, null, id]`, usage — `[prompt, candidates, total, …]`;
   * в бейдж идёт prompt (размер контекста), не total: total включает ответ и
   * «мысли», и на следующем ходе он был бы уже про другой контекст.
   */
  function tokensFromChunk(chunk) {
    if (!Array.isArray(chunk) || !Array.isArray(chunk[2])) return 0;
    var n = chunk[2][0];
    if (typeof n !== 'number' || !isFinite(n) || n <= 0 || n >= 1e9) return 0;
    return Math.floor(n);
  }

  /**
   * Токены из REST-формы ответа: `usageMetadata.promptTokenCount`.
   * У `generativelanguage.googleapis.com/v1beta/models/<m>:generateContent` (и у
   * `:streamGenerateContent?alt=sse`, где объект лежит в кадре `data:`) протобуферного
   * чанка нет — серверный счётчик приходит только здесь. Берётся promptTokenCount, а не
   * totalTokenCount: последний включает ответ и «мысли» (486 + 38 + 110 в захвате).
   */
  function tokensFromUsageMetadata(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
    var um = node.usageMetadata;
    if (!um || typeof um !== 'object') return 0;
    var n = um.promptTokenCount;
    if (typeof n === 'string') n = parseInt(n, 10);
    if (typeof n !== 'number' || !isFinite(n) || n <= 0 || n >= 1e9) return 0;
    return Math.floor(n);
  }

  /**
   * Разобранные корни тела ответа: один JSON-массив протобуфера либо кадры
   * `data:` генеративного стрима (AI Studio отдаёт GenerateContent и так).
   * Пустой массив — тело не нашего формата.
   */
  function jsonRoots(text) {
    var root = parseJsonText(text);
    if (root !== null) return [root];
    if (typeof text !== 'string' || text.length === 0) return [];
    var out = [];
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') !== 0) continue;
      var payload = parseJsonText(line.slice(5).trim());
      if (payload !== null) out.push(payload);
    }
    return out;
  }

  /**
   * Токены контекста из ответа GenerateContent → promptTokenCount (0 — нет данных).
   *
   * Две формы одного ответа:
   *   • нативный `$rpc`: массив протобуфера, путь `root[0][last][2][0]` (usage[0] = prompt);
   *   • REST/SSE: объект с `usageMetadata.promptTokenCount` (кадры `data:` — тоже объекты).
   * Значение накапливается по потоку (219 → 486 в захвате), поэтому берётся максимум —
   * это финальный счётчик. Обход ограничен (guard 200): форма с единственным чанком и
   * вариант без внешнего массива тоже разбираются, а чужие тела — нет.
   */
  function parseUsageTokens(text) {
    var roots = jsonRoots(text);
    if (roots.length === 0) return 0;
    var best = 0;
    var queue = roots.slice();
    var guard = 0;
    while (queue.length > 0 && guard < 200) {
      var node = queue.shift();
      guard++;
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        // Протобуфер нативного $rpc: `[content, null, usage, null, id]`, usage[0] = prompt.
        var n = tokensFromChunk(node);
        if (n > best) best = n;
        for (var i = 0; i < node.length; i++) {
          var child = node[i];
          if (child && typeof child === 'object' && queue.length < 200) queue.push(child);
        }
        continue;
      }
      // REST/SSE форма: `{candidates: [...], usageMetadata: {promptTokenCount: N}}`.
      var um = tokensFromUsageMetadata(node);
      if (um > best) best = um;
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var val = node[key];
        if (val && typeof val === 'object' && queue.length < 200) queue.push(val);
      }
    }
    return best;
  }

  /* ================================================================== *
   * 2b. Бинарные тела ответа (responseType = 'arraybuffer' | 'blob')
   *
   * ПОЧЕМУ. GenerateContent в живом AI Studio приходит XHR'ом с
   * `responseType='arraybuffer'` (в Playwright/Chrome тело лежит байтами, а не
   * строкой). Прежний код выходил из обработчика load на arraybuffer/blob/document —
   * usage-токены не доезжали до бейджа вообще. Декодирование в UTF-8 возвращает тот
   * же JSON-массив протобуфера, который дальше разбирают те же parse* функции.
   * ================================================================== */

  /** ArrayBuffer / view (Uint8Array, Buffer) → строка UTF-8; иначе '' (молча). */
  function decodeBinaryBody(raw) {
    if (!raw) return '';
    try {
      if (typeof raw === 'string') return raw;
      var bytes = null;
      if (typeof ArrayBuffer !== 'undefined' && raw instanceof ArrayBuffer) {
        bytes = new Uint8Array(raw);
      } else if (raw && typeof raw.byteLength === 'number' && typeof ArrayBuffer !== 'undefined'
        && raw.buffer instanceof ArrayBuffer) {
        // View с ненулевым смещением (Buffer из пула) — берём ровно свой диапазон.
        bytes = new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
      }
      if (!bytes || bytes.length === 0) return '';
      if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
      return '';
    } catch (eDec) {
      soft(eDec, 'aistudio-intercept:decode-body');
      return '';
    }
  }

  /** Blob → строка: blob.text() (браузер/Node) либо FileReader; иначе молчим. */
  function decodeBlobBody(blob, cb) {
    if (!blob || typeof cb !== 'function') return;
    try {
      if (typeof blob.text === 'function') {
        blob.text().then(cb, function () { /* тело недоступно — не ошибка перехватчика */ });
        return;
      }
    } catch (eBt) {
      soft(eBt, 'aistudio-intercept:blob-text');
      return;
    }
    if (typeof FileReader !== 'function') return;
    try {
      var fr = new FileReader();
      fr.onload = function () { cb(typeof fr.result === 'string' ? fr.result : ''); };
      fr.readAsText(blob);
    } catch (eFr) {
      soft(eFr, 'aistudio-intercept:blob-reader');
    }
  }

  /* ================================================================== *
   * 2c. Слаг модели (v2.0.32)
   *
   * ПОЧЕМУ. Бейдж показывал «Gemini 3.1 Pro» на ЛЮБОМ чате AI Studio: у адаптера
   * adapters/aistudio-adapter.js:detectModel() стоит заглушка с константой (комментарий
   * там же: «в DOM нет стабильного индикатора»), а сетевой слаг до ISOLATED-мира не
   * доезжал — событие 'ai-cm-model-slug' слал только Gemini-перехватчик. Между тем
   * ресурс промпта в теле $rpc несёт выбранную модель открытым текстом:
   * `["prompts/1wke…",null,null,[1,null,"models/gemini-3.8-flash",…]]`
   * (ResolveDriveResource на открытии чата, UpdatePrompt на каждом ходе).
   *
   * ПОЧЕМУ ПОЛЕ РЕСУРСА, А НЕ ЛЮБОЕ ВХОЖДЕНИЕ. В теле бывает ещё перечень доступных
   * моделей (fallbacks/листинг): «самая свежая» из них — не обязательно выбранная.
   * Форма `"models/<slug>"` — это ровно поле ресурса, поэтому она главнее; голый
   * слаг — фолбэк (REST-URL вида /v1beta/models/gemini-3.1-pro:generateContent).
   * ================================================================== */

  var MODEL_RESOURCE_RE = /"models\/(gemini-[\d.]+-(?:flash|pro|ultra)(?:-lite)?)"/i;
  var MODEL_ANY_RE = /\bgemini-[\d.]+-(?:flash|pro|ultra)(?:-lite)?\b/i;

  /** Слаг модели из тела ('' — нет данных). Чистое извлечение, без побочных эффектов. */
  function modelFromBody(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    try {
      var m = MODEL_RESOURCE_RE.exec(text);
      if (m && m[1]) return m[1];
      var any = MODEL_ANY_RE.exec(text);
      if (any && any[0]) return String(any[0]);
      return '';
    } catch (eModel) {
      soft(eModel, 'aistudio-intercept:model-slug');
      return '';
    }
  }

  var lastModelSlug = '';

  /**
   * Объявить модель в ISOLATED-мир тем же каналом, что у Gemini
   * (core/content.js:559 слушатель 'ai-cm-model-slug' → detectedModelSlug).
   * Повтор того же слага не эмитим: тело ответа приходит на каждый ход.
   */
  function announceModel(text) {
    var slug = modelFromBody(text);
    if (!slug || slug === lastModelSlug) return;
    lastModelSlug = slug;
    if (verbose) console.log(LOG_TAG + ' model=' + slug);
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-model-slug', { detail: { slug: slug } }));
    } catch (eAnn) {
      soft(eAnn, 'aistudio-intercept:model-emit');
    }
  }

  /* ================================================================== *
   * 3. Передача в ISOLATED (detail — строка JSON, Xray/Firefox)
   * ================================================================== */

  function emit(payload) {
    try {
      payload.site = 'aistudio';
      payload.ts = Date.now();
      window.dispatchEvent(new CustomEvent('ai-cm-aistudio-net', {
        detail: JSON.stringify(payload)
      }));
    } catch (eEm) {
      soft(eEm, 'aistudio-intercept:emit');
    }
  }

  /** djb2: подпись снимка, чтобы не гонять один и тот же массив в ISOLATED. */
  function hashText(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function historySig(msgs) {
    var parts = [];
    for (var i = 0; i < msgs.length; i++) {
      var text = (typeof msgs[i].text === 'string') ? msgs[i].text : '';
      var sections = (typeof msgs[i].sections === 'string') ? msgs[i].sections : '';
      var part = (msgs[i].role === ROLE_AI ? 'a' : 'u') + text.length + ':' + hashText(text);
      // Текст файла догружается асинхронно: без sections в подписи повторный
      // emitHistory после догрузки был бы проглочен дедупом.
      if (sections) part += '|s' + sections.length + ':' + hashText(sections);
      parts.push(part);
    }
    return parts.join('|');
  }

  function currentChatId() {
    try {
      var loc = (typeof window !== 'undefined' && window.location) ? window.location : null;
      var hit = /\/prompts\/([A-Za-z0-9_-]+)/.exec(String((loc && loc.pathname) || ''));
      return hit ? hit[1] : '';
    } catch (eCc) {
      return '';
    }
  }

  /**
   * Модуль вложений грузится ПОСЛЕ перехватчика (core/background.js: files
   * после intercept), поэтому __bind — ленивый: первый вызов в рантайме
   * гарантированно видит window.AiCmAistudioFiles уже определённым.
   */
  function filesApi() {
    var api = (typeof window !== 'undefined') ? window.AiCmAistudioFiles : null;
    if (!api) return null;
    if (!filesBound) {
      try {
        if (typeof api.__bind === 'function') {
          api.__bind({
            emitSnapshot: reemitHistory,
            diagLine: diagLine,
            currentChatId: currentChatId,
            originalFetch: nativeFetch
          });
          filesBound = true;
        }
      } catch (eFb) {
        soft(eFb, 'aistudio-intercept:files-bind');
      }
    }
    if (filesBound && pendingFileToken) {
      var tok = pendingFileToken;
      pendingFileToken = '';
      try {
        if (typeof api.afSetToken === 'function') api.afSetToken(tok);
      } catch (eFt) {
        soft(eFt, 'aistudio-intercept:files-token');
      }
    }
    return api;
  }

  /**
   * Секции файлов собираются в отдельное поле, а не в text: адаптер вызывает
   * _cleanText ПОСЛЕ и схлопнул бы переводы строк в телах markdown (§4 плана).
   */
  function annotateFileSections(msgs) {
    var api = filesApi();
    if (!api || typeof api.afSectionsFor !== 'function') return;
    var cid = currentChatId();
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || !Array.isArray(m.files) || m.files.length === 0) continue;
      var sec = '';
      try {
        sec = api.afSectionsFor(m.files, cid) || '';
      } catch (eSec) {
        soft(eSec, 'aistudio-intercept:files-sections');
      }
      if (sec) m.sections = sec;
      else if (m.sections) delete m.sections;
    }
  }

  function reemitHistory() {
    if (!lastHistoryMsgs || lastHistoryMsgs.length === 0) return;
    try {
      emitHistory(lastHistoryMsgs, lastHistoryUrl);
    } catch (eRe) {
      soft(eRe, 'aistudio-intercept:files-reemit');
    }
  }

  /** Отправка снимка истории в мост с дедупом по содержимому. */
  function emitHistory(msgs, url) {
    if (!msgs || msgs.length === 0) {
      // v2.0.34: раньше выход был молчаливым — «2 узла» в бейдже не оставляли следов.
      diagLine('aistudio-history-skip', {
        reason: lastHistoryReason || 'empty',
        rpc: String(url || '').replace(/^.*\//, ''),
        msgs: 0
      });
      return;
    }
    // Спрашиваем секции ДО дедупа: даже повторный снимок должен поставить
    // недогруженные файлы в очередь (иначе ре-эмит после догрузки не начнётся).
    annotateFileSections(msgs);
    lastHistoryMsgs = msgs;
    lastHistoryUrl = String(url || '');
    var sig = String(url || '') + '|' + historySig(msgs);
    if (sig === lastHistorySig) return;
    lastHistorySig = sig;
    // Критерий приёмки задачи: строка видна в консоли страницы при загрузке AI Studio.
    console.log(LOG_TAG + ' history loaded msgs=' + msgs.length);
    emit({ kind: 'history', msgs: msgs, count: msgs.length, url: url });
  }

  /** Тело ЗАПРОСА: у GenerateContent это свежий снимок диалога (`data[1]`). */
  function handleRequest(url, text) {
    if (!isGenerateRpc(url)) return;
    // Модель — только у СВОИХ RPC: тело GenerateContent подтверждает выбранную модель
    // текущего чата (листинг моделей/чужие $rpc её не доказывают).
    announceModel(text);
    try {
      emitHistory(parseHistory(text, url), url);
    } catch (eHQ) {
      soft(eHQ, 'aistudio-intercept:request-parse');
    }
  }

  /** GenerateAccessToken: тело `["ya29.…"]` — OAuth-токен для Drive API вложений. */
  function isTokenRpc(url) {
    return /generatetoken|GenerateAccessToken/i.test(String(url || ''));
  }

  function tokenFromBody(text) {
    var root = parseJsonText(text);
    var pick = function (v) {
      return (typeof v === 'string' && /^ya29\./.test(v)) ? v : '';
    };
    if (typeof root === 'string') return pick(root);
    if (Array.isArray(root)) {
      for (var i = 0; i < root.length; i++) {
        var got = pick(root[i]);
        if (got) return got;
      }
    }
    if (root && typeof root === 'object' && pick(root.token)) return root.token;
    return '';
  }

  /** Тело ОТВЕТА: GenerateContent — usage токенов, UpdatePrompt/CreatePrompt — история. */
  function handleResponse(url, text) {
    try {
      if (isTokenRpc(url)) {
        var tok = tokenFromBody(text);
        if (tok) {
          var api = filesApi();
          if (api && typeof api.afSetToken === 'function') {
            try { api.afSetToken(tok); } catch (eTk) { soft(eTk, 'aistudio-intercept:files-token'); }
          } else {
            // Модуль вложений ещё не загрузился (files после intercept) —
            // отдадим токен при первой ленивой привязке.
            pendingFileToken = tok;
          }
          // Приватность: в лог идёт только длина токена, никогда сам токен.
          diagLine('aistudio-auth-token', { len: tok.length });
        }
        return;
      }
      // ResolveDriveResource на открытии чата: ресурс промпта с выбранной моделью (v2.0.32).
      if (isGenerateRpc(url) || isHistoryRpc(url)) announceModel(text);
      if (isGenerateRpc(url)) {
        var tokens = parseUsageTokens(text);
        if (tokens <= 0 || tokens === lastTokens) return;
        lastTokens = tokens;
        if (verbose) console.log(LOG_TAG + ' serverTokens=' + tokens);
        emit({ kind: 'count', serverTokens: tokens, url: url });
        return;
      }
      if (!isHistoryRpc(url)) return;
      var historyMsgs = parseHistory(text, url);
      // v2.0.34: факт холодного ResolveDriveResource виден вместе с итогом разбора.
      if (/resolvedriveresource/i.test(url)) {
        diagLine('aistudio-drive-resource', {
          msgs: historyMsgs.length,
          reason: historyMsgs.length > 0 ? 'parsed' : (lastHistoryReason || 'shape-miss')
        });
      }
      emitHistory(historyMsgs, url);
    } catch (eHR) {
      soft(eHR, 'aistudio-intercept:response-parse');
    }
  }

  /* ================================================================== *
   * 4. Патчи fetch и XMLHttpRequest
   * ================================================================== */

  function urlOfFetchInput(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input == null ? '' : input);
    } catch (eU) {
      return '';
    }
  }

  function installFetchHook() {
    if (typeof window.fetch !== 'function') return;
    var prevFetch = window.fetch;
    // Нативный fetch нужен модулю вложений: он не должен проходить через
    // собственный патч (Drive API не $rpc, но так надёжнее и без лишних копий).
    if (nativeFetch === null) nativeFetch = prevFetch;
    if (!prevFetch || prevFetch.__aiCmAistudioWrapped) return;

    var wrapped = function fetch(input, init) {
      var url = urlOfFetchInput(input);
      var interesting = !!url && (isGenerateRpc(url) || isHistoryRpc(url) || isTokenRpc(url));
      var p = prevFetch.apply(this, arguments);
      if (!interesting) return p;

      // Тело запроса доступно только строкой (Request читается асинхронно, а
      // FormData/Blob/ArrayBuffer нам не нужны): живой ввод AI Studio — строка JSON.
      try {
        if (init && typeof init.body === 'string' && init.body) handleRequest(url, init.body);
      } catch (eQ) {
        soft(eQ, 'aistudio-intercept:fetch-request');
      }

      // Тело ответа читаем с КЛОНА: оригинальный Response уходит странице нетронутым.
      // SSE-гард — только для не-generate URL: у UpdatePrompt тело это повтор истории,
      // который читать незачем, а стрим GenerateContent несёт usage (кадры `data:`)
      // и обязан доехать до бейджа.
      return p.then(function (resp) {
        try {
          var ct = '';
          try { ct = String((resp.headers && resp.headers.get('content-type')) || ''); } catch (eH) { ct = ''; }
          var sse = ct.indexOf('event-stream') !== -1;
          if ((!sse || isGenerateRpc(url)) && typeof resp.clone === 'function') {
            resp.clone().text().then(function (txt) {
              handleResponse(url, txt);
            }, function () {
              // тело уже занято страницей — это не ошибка перехватчика
            });
          }
        } catch (eR) {
          soft(eR, 'aistudio-intercept:fetch-clone');
        }
        return resp;
      });
    };
    wrapped.__aiCmAistudioWrapped = true;
    window.fetch = wrapped;
  }

  function installXhrHook() {
    var Xhr = window.XMLHttpRequest;
    if (!Xhr || !Xhr.prototype) return;
    var proto = Xhr.prototype;
    var prevOpen = proto.open;
    var prevSend = proto.send;
    if (typeof prevOpen !== 'function' || typeof prevSend !== 'function') return;
    if (prevSend.__aiCmAistudioWrapped) return;

    proto.open = function (method, url) {
      try {
        this.__aiCmAistudioUrl = (url === undefined || url === null) ? '' : String(url);
      } catch (eO) {
        this.__aiCmAistudioUrl = '';
      }
      return prevOpen.apply(this, arguments);
    };

    var send = function (body) {
      // Тело запроса нужно раньше ответа: снимок истории отправляется сразу в send(),
      // ещё до того как придут чанки (в теле уже есть только что отправленная реплика).
      try {
        var urlNow = this.__aiCmAistudioUrl || '';
        if (typeof body === 'string' && body && urlNow && isGenerateRpc(urlNow)) {
          handleRequest(urlNow, body);
        }
      } catch (eQ) {
        soft(eQ, 'aistudio-intercept:xhr-request');
      }
      try {
        var self = this;
        self.addEventListener('load', function () {
          try {
            var url = self.__aiCmAistudioUrl || '';
            if (!url || (!isGenerateRpc(url) && !isHistoryRpc(url) && !isTokenRpc(url))) return;
            var ct = '';
            try { ct = String(self.getResponseHeader('content-type') || ''); } catch (eH) { ct = ''; }
            // Не-generate SSE — повтор истории/служебный стрим: тело не читаем.
            if (ct.indexOf('event-stream') !== -1 && !isGenerateRpc(url)) return;
            var rt = self.responseType || '';
            // GenerateContent в живом AI Studio: байты, а не строка (см. 2b).
            if (rt === 'arraybuffer') {
              var fromBuffer = decodeBinaryBody(self.response);
              if (fromBuffer) handleResponse(url, fromBuffer);
              return;
            }
            if (rt === 'blob') {
              decodeBlobBody(self.response, function (fromBlob) {
                if (fromBlob) handleResponse(url, fromBlob);
              });
              return;
            }
            if (rt === 'document') return;
            if (rt === 'json') handleResponse(url, JSON.stringify(self.response));
            else handleResponse(url, self.responseText);
          } catch (eL) {
            soft(eL, 'aistudio-intercept:xhr-load');
          }
        });
      } catch (eS) {
        soft(eS, 'aistudio-intercept:xhr-send');
      }
      return prevSend.apply(this, arguments);
    };
    send.__aiCmAistudioWrapped = true;
    proto.send = send;
  }

  installFetchHook();
  installXhrHook();

  // v2.0.34: без строки установки «нет history loaded» не отличить от «хук не встал».
  // Гейт тот же, что у канала B: по умолчанию консоль страницы остаётся чистой.
  if (debugGateOn()) {
    console.log(LOG_TAG + ' hooks installed fetch=' + (typeof window.fetch === 'function' ? 'wrapped' : 'absent') +
      ' xhr=' + (typeof window.XMLHttpRequest === 'function' ? 'wrapped' : 'absent'));
  }

  window.AiCmAistudioIntercept = {
    version: 5,
    __handlers: {
      parseJsonText: parseJsonText,
      jsonRoots: jsonRoots,
      decodeBinaryBody: decodeBinaryBody,
      msgsFromSnapshot: msgsFromSnapshot,
      msgsFromRequest: msgsFromRequest,
      findMessageArray: findMessageArray,
      parseHistory: parseHistory,
      parseUsageTokens: parseUsageTokens,
      tokensFromChunk: tokensFromChunk,
      tokensFromUsageMetadata: tokensFromUsageMetadata,
      shapeOfArray: shapeOfArray,
      modelFromBody: modelFromBody,
      isGenerateRpc: isGenerateRpc,
      isHistoryRpc: isHistoryRpc,
      isTokenRpc: isTokenRpc,
      tokenFromBody: tokenFromBody,
      fileIdsOfRow: fileIdsOfRow,
      mergeFileRows: mergeFileRows,
      currentChatId: currentChatId,
      handleRequest: handleRequest,
      handleResponse: handleResponse
    },
    reset: function () {
      lastTokens = 0;
      lastHistorySig = '';
      lastModelSlug = '';
      lastHistoryMsgs = null;
      lastHistoryUrl = '';
      try {
        var api = (typeof window !== 'undefined') ? window.AiCmAistudioFiles : null;
        if (api && typeof api.afReset === 'function') api.afReset('');
      } catch (eRf) {
        soft(eRf, 'aistudio-intercept:reset-files');
      }
    },
    stats: function () {
      return { lastTokens: lastTokens, lastHistorySig: lastHistorySig, verbose: verbose };
    }
  };
})();
