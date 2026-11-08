/**
 * core/gemini-payload.js — структурные предикаты и хелперы payload Gemini (Phase 3, шаг 1).
 *
 * ЧТО ЗДЕСЬ. Двенадцать чистых функций, отвечающих на один вопрос: что в кадре Gemini
 * является ДАННЫМИ, а что — обвязкой интерфейса, и как эти данные вытащить из дерева.
 *   • isIdLike / isFileLike / isUrlLike / isTokenLike / isMimeLike и таблица UI_BLACKLIST —
 *     признаки мусора: id ходов, имена файлов, ссылки, opaque-токены, MIME-строки и подписи
 *     переключателей языка;
 *   • isJunk — сводный фильтр по всем признакам; isThinking — отсев англоязычного
 *     «размышления» модели (markdown-жирный, >= 30 латинских букв, ни одной кириллической);
 *   • collectAttachmentUrls / collectAttachments — структурный сбор вложений: имя, MIME,
 *     type, токен, CDN-ссылка и download-URL; блок вложения — лист, глубже не идём;
 *   • collectContent — рекурсивный сбор чистого текста хода;
 *   • structureMap — карта структуры кадра (глубина:длина:вид) для диагностики, не более
 *     40 строк;
 *   • buildJsonSkeleton — компактный скелет непарсящейся страницы до глубины 6.
 *
 * ПОЧЕМУ ВЫНЕСЕНО. Это единственный слой перехватчика, у которого НЕТ состояния ядра:
 * каждый вызов зависит только от аргументов и возвращает значение. Функции были размазаны
 * по ядру между сетевыми кластерами, хотя обязаны быть общими для ingest (сбор хода) и
 * диагностики (скелет страницы). Модуль — самая дешёвая точка повторного использования:
 * подключить и звать, ничего не связывая.
 *
 * СВЯЗКА. Модулю объект связи НЕ НУЖЕН: здесь нет ни __bind, ни with (D) — только экспорт.
 * Ядро берёт window.AiCmGeminiPayload при загрузке и передаёт четыре сборщика
 * (buildJsonSkeleton, structureMap, collectAttachments, collectContent) в
 * aiCmGeminiIngest.__bind({...}). Предикаты наружу не передаются: их единственный
 * потребитель — collectContent/structureMap внутри этого же файла.
 *
 * ПОЧЕМУ ЭКСПОРТ ПОЛНЫЙ. Все двенадцать имён лежат на Fn, хотя ingest нужны четыре:
 * API описывает СЛОЙ целиком, а не текущего клиента. Иначе следующее обращение к isJunk
 * из ядра потребовало бы второго контракта связи.
 *
 * ПРАВКА ПРИ ПЕРЕНОСЕ. Тела перенесены БАЙТ-В-БАЙТ, включая ведущие отступы: часть
 * пин-тестов режет функции из конкатенации исходников по имени, поэтому пробелы и порядок
 * строк внутри тел менять нельзя. Единственное изменение — сами тела теперь лежат в
 * IIFE-каркасе модуля, а в ядре на их месте остался баннер-указатель.
 *
 * ПОРЯДОК ПОДКЛЮЧЕНИЯ. js[] в core/background.js: модуль идёт ПЕРЕД
 * core/gemini-ingest.js (его связка использует эти функции) и, разумеется, перед ядром.
 * При добавлении сюда файла id регистрации обязан смениться: MV3 не перечитывает js[]
 * под уже зарегистрированным id (шаг поднял -v12 → -v13).
 *
 * PUBLIC API: window.AiCmGeminiPayload = { isIdLike, isFileLike, isUrlLike, isTokenLike,
 *   isMimeLike, isJunk, isThinking, collectAttachmentUrls, collectAttachments,
 *   collectContent, structureMap, buildJsonSkeleton }.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiPayload) return;

  var Fn = {};

  // ---- фильтры мусора ----
  function isIdLike(s) { return typeof s === 'string' && /^(c_|r_|rc_|fbb[0-9a-f]|[0-9a-f]{16})/.test(s); }
  function isFileLike(s) { return typeof s === 'string' && /\.(pdf|png|jpe?g|gif|docx?|txt|webp|csv|xlsx?)(\b|$)/i.test(s); }
  function isUrlLike(s) { return typeof s === 'string' && /^https?:\/\//i.test(s); }
  function isTokenLike(s) { return typeof s === 'string' && /^\$?AVuib/.test(s); }
  function isMimeLike(s) { return typeof s === 'string' && /^(image|application|video|audio)\//i.test(s); }
  var UI_BLACKLIST = {
    'DE': 1, 'ru': 1, 'mk': 1, 'generic': 1, 'personal_context': 1, 'google': 1,
    'Ищу в интернете': 1, 'Персональный контекст': 1, 'Google Search': 1, 'true': 1, 'false': 1
  };
  function isJunk(s) {
    if (typeof s !== 'string') return true;
    if (s.length === 0) return true;
    if (UI_BLACKLIST[s]) return true;
    return isIdLike(s) || isFileLike(s) || isUrlLike(s) || isTokenLike(s) || isMimeLike(s);
  }
  function isThinking(s) {
    if (typeof s !== 'string' || s.length < 30) return false;
    var cyr = 0, lat = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x0400 && c <= 0x04FF) cyr++;
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) lat++;
    }
    if (cyr > 0) return false;
    if (lat < 30) return false;
    return s.indexOf('**') !== -1;
  }

  // ---- v2.0: структурный сбор вложений Gemini (сигнатура из снятого payload) ----
  // Узел: [null, type, name, imgCdn, null, token, null, [thumb, download, upload],
  //        1, [sec, nanos], null, mime, ...], type: 1=image, 10=docx, 11=pdf.
  // В отличие от старой эвристики НЕ требуем node[3] и префикс "$AVuibg":
  // у документов node[3]=null, а opaque-токен теперь "$AfW07I…". MIME — главный
  // признак; type держим справочно и как допуск для документов без MIME.
  // Рекурсивно обходим дерево — не привязываемся к жёсткому пути.
  function collectAttachmentUrls(v, out) {
    if (typeof v === 'string') { if (v) out.push(v); return; }
    if (!Array.isArray(v)) return;
    for (var i = 0; i < v.length; i++) collectAttachmentUrls(v[i], out);
  }
  function collectAttachments(node, localSeen, items) {
    if (!Array.isArray(node)) return;
    var name = (typeof node[2] === 'string') ? node[2] : '';
    var mime = (typeof node[11] === 'string') ? node[11] : '';
    var type = (typeof node[1] === 'number') ? node[1] : 0;
    var token = (typeof node[5] === 'string') ? node[5] : '';
    var img = (typeof node[3] === 'string') ? node[3] : '';
    // проверяем: является ли этот массив блоком вложения?
    if (name && mime && /^(image|application|video|audio)\//.test(mime) &&
      (type === 1 || type === 10 || type === 11) &&
      (!token || /^\$?A[Vf]/.test(token))) {
      var urls = [];
      collectAttachmentUrls(node[7], urls);
      var dl = '';
      for (var u = 0; u < urls.length; u++) {
        if (urls[u].indexOf('contribution.usercontent.google.com/download') !== -1) { dl = urls[u]; break; }
      }
      var seenKey = token || name;
      if (!localSeen.has(seenKey)) {
        localSeen.add(seenKey);
        items.push({ name: name, mime: mime, type: type, token: token, img: img, dl: dl, urls: urls });
      }
      return; // блок вложения — лист, не идём глубже
    }
    // иначе рекурсивно обходим детей
    for (var i = 0; i < node.length; i++) {
      if (Array.isArray(node[i])) collectAttachments(node[i], localSeen, items);
    }
  }

  // ---- рекурсивный сбор текста хода ----
  function collectContent(node, out) {
    if (typeof node === 'string') {
      if (!isJunk(node) && !isThinking(node) && !isMimeLike(node)) out.push(node);
      return;
    }
    if (!Array.isArray(node)) return;
    for (var k = 0; k < node.length; k++) collectContent(node[k], out);
  }
  function structureMap(node, depth, out, counter) {
    if (counter.n >= 40) return;
    if (typeof node === 'string') {
      var kind = isJunk(node) ? 'junk' : (isThinking(node) ? 'think' : 'TEXT');
      out.push(depth + ':' + node.length + ':' + kind); counter.n++; return;
    }
    if (!Array.isArray(node)) return;
    for (var i = 0; i < node.length; i++) structureMap(node[i], depth + 1, out, counter);
  }

  // Скелет непарсящейся страницы: рекурсивно до глубины 6.
  // массив → {"arr": <len>, "items": [...]}; строка → "s<len>: <до 30 символов>";
  // число/булевы/null — как есть. items ограничены 8 элементами для компактности.
  function buildJsonSkeleton(node, depth) {
    if (node === null || node === undefined) return null;
    var t = typeof node;
    if (t === 'string') return 's' + node.length + ': ' + node.slice(0, 30);
    if (t === 'number' || t === 'boolean') return node;
    if (Array.isArray(node)) {
      var items = [];
      if (depth < 6) {
        var cap = Math.min(node.length, 8);
        for (var i = 0; i < cap; i++) {
          items.push(buildJsonSkeleton(node[i], depth + 1));
        }
      }
      return { arr: node.length, items: items };
    }
    return null;
  }

  // ===== ЭКСПОРТ: слой целиком, а не текущий клиент =====
  Fn.isIdLike = isIdLike;
  Fn.isFileLike = isFileLike;
  Fn.isUrlLike = isUrlLike;
  Fn.isTokenLike = isTokenLike;
  Fn.isMimeLike = isMimeLike;
  Fn.isJunk = isJunk;
  Fn.isThinking = isThinking;
  Fn.collectAttachmentUrls = collectAttachmentUrls;
  Fn.collectAttachments = collectAttachments;
  Fn.collectContent = collectContent;
  Fn.structureMap = structureMap;
  Fn.buildJsonSkeleton = buildJsonSkeleton;

  if (typeof window !== 'undefined') { window.AiCmGeminiPayload = Fn; }
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
})();
