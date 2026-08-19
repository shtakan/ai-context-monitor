/**
 * Чистые функции для перехватчика ChatGPT (core/page-intercept.js).
 * Работают в браузере (window.ChatGPTConversationParser) и в Node (module.exports).
 *
 * Задачи:
 *  1. Навигация /c/<id>: getConvIdFromPath + shouldResetChatConversation —
 *     определение смены чата в SPA (нужно, чтобы индикатор/экспорт не «перетекали»
 *     из прошлого чата в новый).
 *  2. Потеря первого обмена: orderChatGPTMapping линеаризует mapping по parent/children
 *     (не по порядку ключей объекта и не по create_time), поэтому голова диалога —
 *     первый user-ход — не теряется.
 *  3. Санация сырых маркеров: sanitizeChatGPTText вырезает [entity][…] и [cite:…]
 *     (включая [cite:turn0searchN]).
 */

(function () {
  var CHATGPT_DEFAULT_MODEL = 'gpt-4o';

  // ---- 1. Навигация /c/<id> ----
  function getConvIdFromPath(pathname) {
    try {
      var m = String(pathname || '').match(/\/c\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  // Сброс нужен только когда появился НОВЫЙ непустой id чата, отличный от предыдущего.
  function shouldResetChatConversation(prevId, newId) {
    if (!newId) return false;
    return prevId !== newId;
  }

  // ---- 3. Санация маркеров ----
  // Живые ChatGPT-маркеры обёрнуты в PUA-символы Unicode (U+E200/U+E202/U+E201),
  // регулярки по брекетам их не видят. Вырезаем PUA-токен целиком
  // ( cite/entity/image_group + полезная нагрузка ), затем добиваем одиночные PUA.
  function sanitizeChatGPTText(s) {
    if (typeof s !== 'string') return s;
    return String(s)
      // PUA entity: заменяем токен на «видимый» текст (2-й элемент массива ["тип","видимый","описание"]).
      .replace(/\uE200entity\uE202([^\uE200\uE201]*?)\uE201/g, function (m, payload) {
        try {
          var arr = JSON.parse(payload);
          if (Array.isArray(arr) && arr.length > 1 && typeof arr[1] === 'string' && arr[1]) return arr[1];
        } catch (e) { }
        // фолбэк: второй quoted-фрагмент, если payload не валидный JSON-массив
        try {
          var mt = String(payload).match(/"([^"]+)"/g);
          if (mt && mt.length > 1) {
            var v = mt[1].replace(/^"|"$/g, '');
            if (v) return v;
          }
        } catch (e2) { }
        return '';
      })
      .replace(/\uE200(?:cite|image_group)\uE202[^\uE200\uE201]*?\uE201/g, '') // PUA cite/image_group целиком
      .replace(/[\uE000-\uF8FF]/g, '')        // остаточные PUA-символы
      .replace(/\[entity\](?:\[[^\]]*\])+/g, '') // legacy [entity][...]
      .replace(/\[entity\]/g, '')              // одиночный legacy [entity]
      .replace(/\[cite:[^\]]*\]/g, '')         // legacy [cite:...], в т.ч. [cite:turn0searchN]
      .replace(/[ \t]{2,}/g, ' ');
  }

  // ---- 2. Линеаризация mapping по parent/children ----
  // ChatGPT mapping: каждый узел { id, parent, children, message }.
  // Корень — узел с parent === null/undefined. Обход DFS от корня по children
  // (порядок children из mapping). При отсутствии parent/children — фолбэк на
  // create_time, затем на порядок ключей. Возвращает массив ключей mapping
  // в хронологическом порядке (голова = первый user).
  function orderChatGPTMapping(mapping) {
    var keys = Object.keys(mapping || {});
    if (!keys.length) return [];

    var byId = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var n = mapping[k];
      var nid = (n && n.id != null) ? String(n.id) : k;
      byId[nid] = k;
    }

    var hasParent = false;
    var hasChildren = false;
    for (var p = 0; p < keys.length; p++) {
      var np = mapping[keys[p]];
      if (np && np.parent !== undefined) hasParent = true;
      if (np && Array.isArray(np.children) && np.children.length) hasChildren = true;
    }

    // children по указателю parent (универсально для ChatGPT)
    var childrenOf = {};
    for (var c0 = 0; c0 < keys.length; c0++) childrenOf[keys[c0]] = [];
    var roots = [];
    for (var m = 0; m < keys.length; m++) {
      var kk = keys[m];
      var nn = mapping[kk];
      var pid = (nn && nn.parent != null) ? String(nn.parent) : null;
      var pk = pid ? (byId[pid] || pid) : null;
      if (pk) {
        if (childrenOf[pk]) childrenOf[pk].push(kk);
      } else if (hasParent) {
        roots.push(kk);
      }
    }

    if (!hasParent) {
      // Нет поля parent: либо children, либо create_time, либо порядок ключей.
      if (hasChildren) {
        var isChild = {};
        for (var c1 = 0; c1 < keys.length; c1++) {
          var n1 = mapping[keys[c1]];
          if (n1 && Array.isArray(n1.children)) {
            for (var c2 = 0; c2 < n1.children.length; c2++) {
              var cid = String(n1.children[c2]);
              isChild[byId[cid] || cid] = true;
            }
          }
        }
        roots = keys.filter(function (k) { return !isChild[k]; });
        if (!roots.length) roots = [keys[0]];
      } else {
        return keys.slice().sort(function (a, b) {
          var ca = (mapping[a] && mapping[a].message && mapping[a].message.create_time) || 0;
          var cb = (mapping[b] && mapping[b].message && mapping[b].message.create_time) || 0;
          return ca - cb;
        });
      }
    }

    // Голова = корень с минимальным create_time. При висячих parent (несколько
    // корней) это гарантирует, что истинная голова диалога идёт первой.
    roots.sort(function (a, b) {
      var ca = (mapping[a] && mapping[a].message && mapping[a].message.create_time) || 0;
      var cb = (mapping[b] && mapping[b].message && mapping[b].message.create_time) || 0;
      return ca - cb;
    });

    var out = [];
    var visited = {};
    function walk(k) {
      if (!k || visited[k] || mapping[k] === undefined) return;
      visited[k] = true;
      out.push(k);
      var ch = childrenOf[k] || [];
      if (mapping[k] && Array.isArray(mapping[k].children) && mapping[k].children.length) {
        // порядок из mapping.children авторитетен, когда он есть
        ch = mapping[k].children.map(function (cid) { return byId[String(cid)] || String(cid); });
      }
      for (var w = 0; w < ch.length; w++) walk(ch[w]);
    }
    for (var r = 0; r < roots.length; r++) walk(roots[r]);
    for (var u = 0; u < keys.length; u++) if (!visited[keys[u]]) out.push(keys[u]);
    return out;
  }

  // Полный парсер (для тестов и потенциального переиспользования): messages в
  // хронологическом порядке, голова = первый user, с санацией маркеров.
  function parseChatGPTConversation(json) {
    var messages = [];
    var model = '';
    var tokens = 0;

    try {
      if (!json || typeof json !== 'object') {
        return { messages: [], model: CHATGPT_DEFAULT_MODEL, tokens: 0 };
      }
      if (json.model_slug) model = json.model_slug;
      if (typeof json.tokens === 'number') tokens = json.tokens;

      var mapping = json.mapping || {};
      var keys = orderChatGPTMapping(mapping);
      for (var i = 0; i < keys.length; i++) {
        var node = mapping[keys[i]];
        var msg = node && node.message;
        if (!msg || !msg.content) continue;
        var role = msg.author && msg.author.role;
        if (role === 'system' || role === 'tool') continue;
        var parts = msg.content.parts || [];
        var contentPieces = [];
        for (var j = 0; j < parts.length; j++) {
          if (typeof parts[j] === 'string') {
            contentPieces.push(sanitizeChatGPTText(parts[j]));
          } else if (parts[j] && typeof parts[j] === 'object' && typeof parts[j].text === 'string') {
            // Текст в объектных part (напр. audio_transcription "Привет.").
            contentPieces.push(sanitizeChatGPTText(parts[j].text));
          }
        }
        var content = contentPieces.join('\n').trim();
        if (content) {
          messages.push({
            role: role === 'assistant' ? 'assistant' : 'user',
            content: content
          });
        }
      }
    } catch (e) {
      // пустой результат при ошибке
    }

    if (!model) model = CHATGPT_DEFAULT_MODEL;
    return { messages: messages, model: model, tokens: tokens };
  }

  var api = {
    getConvIdFromPath: getConvIdFromPath,
    shouldResetChatConversation: shouldResetChatConversation,
    orderChatGPTMapping: orderChatGPTMapping,
    sanitizeChatGPTText: sanitizeChatGPTText,
    parseChatGPTConversation: parseChatGPTConversation
  };

  if (typeof window !== 'undefined') {
    window.ChatGPTConversationParser = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();