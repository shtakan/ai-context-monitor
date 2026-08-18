/**
 * Чистая логика принятия решений перехватчика Gemini (core/gemini-intercept.js),
 * вынесенная для юнит-тестирования. Не зависит от DOM/fetch/браузерного API,
 * работает в браузере (window.GeminiInterceptLogic) и в Node (module.exports).
 *
 * Покрывает два класса багов:
 *   1) пол (floor) из localStorage: ключ включает PARSER_VERSION, сохранённое
 *      игнорируется при несовпадении версии; пол применяется ТОЛЬКО как защита
 *      от просадки при НЕполной загрузке (baseComplete=false), а при
 *      baseComplete=true effectiveLen = фактический textLen базы (пол НЕ применяется);
 *      пол обновляется ТОЛЬКО когда база полная и тихая пагинация дошла до начала
 *      (курсора больше нет).
 *   2) полная пересборка turnsMap из vf5: допустима ТОЛЬКО если пейлоад НЕ содержит
 *      курсора продолжения (действительно полная история); при наличии курсора —
 *      merge по id без сброса.
 */

(function () {
  var FLOOR_KEY_PREFIX = 'ai-cm-gemini-floor';

  function floorStorageKey(convId, parserVersion) {
    return FLOOR_KEY_PREFIX + '-' + (parserVersion || '') + '-' + convId;
  }

  // ---- v4x: версионирование restored-ленты (ключ + версия внутри записи) ----
  var TAPE_KEY_PREFIX = 'ai-cm-gemini-tape';

  function tapeStorageKey(convId, parserVersion) {
    return TAPE_KEY_PREFIX + '-' + (parserVersion || '') + '-' + convId;
  }

  // Версия записи ленты (meta.version). Пустая строка — старая запись без версии.
  function tapeVersionOf(entry) {
    if (entry && entry.meta && typeof entry.meta.version === 'string') return entry.meta.version;
    return '';
  }

  // Лента принимается ТОЛЬКО при точном совпадении версии записи с текущей версией парсера.
  function shouldAcceptTape(entry, parserVersion) {
    if (!parserVersion) return false;
    return tapeVersionOf(entry) === parserVersion;
  }

  // turnId = id без суффикса "_user"/"_assistant" (id = "<turnId>_<role>").
  function restoredTurnKeyOf(id) {
    return String(id == null ? '' : id).replace(/_(user|assistant)$/, '');
  }

  function restoredRoleOf(m) {
    if (m && m.role) return (m.role === 'user') ? 'user' : 'assistant';
    var id = (m && m.id) || '';
    if (/_user$/.test(id)) return 'user';
    if (/_assistant$/.test(id)) return 'assistant';
    return '';
  }

  function parseFloor(raw, parserVersion) {
    try {
      var f = JSON.parse(raw);
      if (!f || typeof f.count !== 'number' || typeof f.effectiveLen !== 'number') return null;
      // версия пола обязана совпадать с текущей версией парсера,
      // иначе сохранённое считается «грязным» из старой эпохи и игнорируется.
      if (parserVersion && f.version !== parserVersion) return null;
      return f;
    } catch (e) { return null; }
  }

  function loadFloor(convId, parserVersion, storage) {
    if (!storage || !convId) return null;
    try {
      var raw = storage.getItem(floorStorageKey(convId, parserVersion));
      if (!raw) return null;
      return parseFloor(raw, parserVersion);
    } catch (e) { return null; }
  }

  function saveFloor(convId, parserVersion, count, effectiveLen, storage) {
    if (!storage || !convId) return;
    var key = floorStorageKey(convId, parserVersion);
    var existing = loadFloor(convId, parserVersion, storage);
    // обновляем только если новый «пол» выше (больше ходов или больше символов при том же числе ходов);
    // при несовпадении версии existing = null → запись перезаписывается.
    if (!existing || count > existing.count || (count === existing.count && effectiveLen > existing.effectiveLen)) {
      var val = JSON.stringify({ count: count, effectiveLen: effectiveLen, ts: Date.now(), version: parserVersion });
      try { storage.setItem(key, val); } catch (e) { }
    }
  }

  // Применение пола: только как защита от просадки при НЕполной загрузке (baseComplete=false).
  // При baseComplete=true возвращаем фактический textLen — пол НЕ применяется.
  function resolveFloor(textLen, count, savedFloor, baseComplete) {
    if (!savedFloor || baseComplete) {
      return { effectiveLen: textLen, floorApplied: false, floorValue: 0 };
    }
    if (savedFloor.count > count) {
      return {
        effectiveLen: Math.max(textLen, savedFloor.effectiveLen),
        floorApplied: true,
        floorValue: savedFloor.effectiveLen
      };
    }
    return { effectiveLen: textLen, floorApplied: false, floorValue: 0 };
  }

  // Пол обновляем только когда база полная и тихая пагинация дошла до начала (курсора нет).
  function shouldSaveFloor(baseComplete, reachedStart) {
    return !!(baseComplete && reachedStart);
  }

  // Полная пересборка vf5 допустима только для действительно полной истории (без курсора продолжения).
  function shouldFullRebuild(opts) {
    opts = opts || {};
    return !!(opts.fromVirtualF5 && opts.wasFull && !opts.hasCursor);
  }

  // ---- v33: глобальный порядок страниц пагинации ----
  // Страницы приходят «новые сверху»; старшие страницы (pag) — последними.
  // Итог: старшие — в начало (отрицательный order), свежие — в конец.

  // Назначение order для одной страницы. mode = 'older' (более старая страница, prepend)
  // или 'fresh' (passive/vf5, append). state = { orderCounter, prependCursor }.
  function assignPageOrders(pageLen, mode, state) {
    state = state || { orderCounter: 0, prependCursor: -1 };
    var orders = [];
    for (var i = 0; i < pageLen; i++) {
      if (mode === 'older') orders.push(state.prependCursor - (pageLen - i));
      else orders.push(state.orderCounter++);
    }
    if (mode === 'older') state.prependCursor -= pageLen;
    return orders;
  }

  // Модель итогового порядка: страницы в порядке прибытия, дедуп по id
  // (первая встреча id побеждает), затем сортировка по order.
  // r1 (указатель на более старый ход) сохраняется для самопроверки в тестах.
  function orderPages(pages) {
    var seen = {};
    var state = { orderCounter: 0, prependCursor: -1 };
    var ordered = [];
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var turns = (page && page.turns) || [];
      var mode = (page && page.mode === 'older') ? 'older' : 'fresh';
      var pageLen = turns.length;
      for (var j = 0; j < pageLen; j++) {
        var t = turns[j];
        if (!t || !t.id) continue;
        if (seen[t.id]) continue;
        seen[t.id] = true;
        var order;
        if (mode === 'older') order = state.prependCursor - (pageLen - j);
        else order = state.orderCounter++;
        ordered.push({ id: t.id, text: t.text, role: t.role, r1: t.r1 || null, order: order });
      }
      if (mode === 'older') state.prependCursor -= pageLen;
    }
    ordered.sort(function (a, b) { return a.order - b.order; });
    return ordered.map(function (x) { return { id: x.id, text: x.text, role: x.role, r1: x.r1 }; });
  }

  // ---- v37: основной порядок по прибытию страниц ----
  // order уже закодирован порядком прибытия (старшие страницы — prepend, свежие — append).
  // Функция стабильно раскрывает turn'ы по order (внутри хода user перед assistant).
  // items = [{ id, turnId, r1, order, role }]. Возвращает { ok, ids }.
  // ok=false когда у РАЗНЫХ turn'ов одинаковый order (недетерминированное прибытие) —
  // тогда вызывающий пробует r1-цепочку как fallback.
  function orderByArrival(items) {
    var turns = {};   // turnId -> { order, msgs }
    var i, it, tk;

    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (!it || !it.id) continue;
      tk = it.turnId || it.id; // без turnId — сам себе turn
      var ord = (it.order != null) ? it.order : 0;
      if (!turns[tk]) {
        turns[tk] = { order: ord, msgs: [] };
      } else if (ord < turns[tk].order) {
        turns[tk].order = ord;
      }
      turns[tk].msgs.push(it);
    }

    var turnIds = Object.keys(turns);
    if (!turnIds.length) return { ok: true, ids: [] };

    // детерминированность: разным turn'ам недопустим одинаковый order.
    var orderOwner = {};
    for (i = 0; i < turnIds.length; i++) {
      var o = turns[turnIds[i]].order;
      if (orderOwner[o] !== undefined && orderOwner[o] !== turnIds[i]) {
        return { ok: false, ids: [] };
      }
      orderOwner[o] = turnIds[i];
    }

    // сортировка turn'ов по order (порядок прибытия).
    turnIds.sort(function (a, b) { return turns[a].order - turns[b].order; });

    // раскрываем turn'ы: внутри хода user перед assistant.
    var ids = [];
    for (i = 0; i < turnIds.length; i++) {
      var msgs = turns[turnIds[i]].msgs.slice();
      msgs.sort(function (a, b) {
        var ra = (a.role === 'user') ? 0 : 1;
        var rb = (b.role === 'user') ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return (a.order || 0) - (b.order || 0);
      });
      for (var m = 0; m < msgs.length; m++) ids.push(msgs[m].id);
    }
    return { ok: true, ids: ids };
  }

  // ---- v39: внутристраничный порядок по r1-цепочке ----
  // r1 = сосед СТАРШЕ (обход newest→oldest). Самая новая страницы = ход, чей id НЕ
  // встречается как r1 среди ходов ЭТОЙ страницы. Обход newest→oldest, затем разворот
  // → old→new (самый старый получает минимальный порядок). Внутри хода user перед assistant.
  // pageMsgs = [{ id, turnId, r1, role }]. Возвращает { ok, ids }: ok=false/цепочка рвётся —
  // ids = текущий порядок страницы (фолбэк).
  function orderPageByR1(pageMsgs) {
    var turns = {};
    var r1Targets = {};
    var i, it, tk;

    for (i = 0; i < pageMsgs.length; i++) {
      it = pageMsgs[i];
      if (!it || !it.id) continue;
      tk = it.turnId || it.id;
      if (!turns[tk]) turns[tk] = { next: it.r1 || null, msgs: [] };
      else if (!turns[tk].next && it.r1) turns[tk].next = it.r1;
      turns[tk].msgs.push(it);
      if (it.r1) r1Targets[it.r1] = true;
    }

    var turnIds = Object.keys(turns);
    if (!turnIds.length) return { ok: true, ids: [] };

    function expand(chainTurnIds) {
      var ids = [];
      for (var c = 0; c < chainTurnIds.length; c++) {
        var msgs = turns[chainTurnIds[c]].msgs.slice();
        msgs.sort(function (a, b) {
          var ra = (a.role === 'user') ? 0 : 1;
          var rb = (b.role === 'user') ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return 0;
        });
        for (var m = 0; m < msgs.length; m++) ids.push(msgs[m].id);
      }
      return ids;
    }

    // фолбэк: текущий порядок страницы (первое появление turn'а), user перед assistant
    function fallbackIds() {
      var seq = [];
      var seen = {};
      for (var a = 0; a < pageMsgs.length; a++) {
        var mm = pageMsgs[a];
        var mk = (mm && mm.turnId) || (mm && mm.id);
        if (mk && !seen[mk]) { seen[mk] = true; seq.push(mk); }
      }
      return expand(seq);
    }

    var heads = [];
    for (i = 0; i < turnIds.length; i++) {
      if (!r1Targets[turnIds[i]]) heads.push(turnIds[i]);
    }
    if (heads.length !== 1) return { ok: false, ids: fallbackIds() };

    var chain = [];
    var seen = {};
    var cur = heads[0];
    var guard = turnIds.length + 1;
    while (cur && turns[cur] && !seen[cur] && chain.length < guard) {
      seen[cur] = true;
      chain.push(cur);
      cur = turns[cur].next;
    }
    if (chain.length !== turnIds.length) return { ok: false, ids: fallbackIds() };

    chain.reverse(); // newest→oldest → old→new
    return { ok: true, ids: expand(chain) };
  }

  // Restored-лента сообщениями id вида "<turnId>_<role>". Порядок строится по r1:
  //   - r1 = id ПРЕДЫДУЩЕГО (более старого) хода; у корня r1=null (первая пара user+assistant
  //     оба имеют r1=null).
  //   - head-кандидаты = turnId, не встречающиеся ни в одном r1 (самые новые).
  //   - цепочка от head по r1 (new→old), затем reverse → old→new.
  //   - внутри turnId user ПЕРЕД assistant.
  // Если r1 в ленте нет — fallback: разворот порядка появления turn'ов (лента new→old).
  function orderRestoredTape(tapeMsgs) {
    function turnKeyOf(id) {
      return String(id == null ? '' : id).replace(/_(user|assistant)$/, '');
    }
    function roleOf(m) {
      if (m && m.role) return (m.role === 'user') ? 'user' : 'assistant';
      var id = (m && m.id) || '';
      if (/_user$/.test(id)) return 'user';
      if (/_assistant$/.test(id)) return 'assistant';
      return '';
    }
    function expand(turnIds) {
      var out = [];
      for (var i = 0; i < turnIds.length; i++) {
        var msgs = turns[turnIds[i]].msgs.slice();
        msgs.sort(function (a, b) {
          var ra = (a.role === 'user') ? 0 : 1;
          var rb = (b.role === 'user') ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return 0;
        });
        for (var k = 0; k < msgs.length; k++) out.push(msgs[k].id);
      }
      return out;
    }

    var turns = {};   // turnKey -> { r1: turnKey|null, msgs: [] }
    var order = [];   // порядок первого появления turn (new→old)
    var i, m, tk;
    for (i = 0; i < tapeMsgs.length; i++) {
      m = tapeMsgs[i];
      if (!m || !m.id) continue;
      tk = turnKeyOf(m.id);
      if (!turns[tk]) {
        turns[tk] = { r1: m.r1 ? turnKeyOf(m.r1) : null, msgs: [] };
        order.push(tk);
      } else if (!turns[tk].r1 && m.r1) {
        turns[tk].r1 = turnKeyOf(m.r1);
      }
      turns[tk].msgs.push({ id: m.id, role: roleOf(m) });
    }

    var turnIds = Object.keys(turns);
    if (!turnIds.length) return [];

    var hasR1 = false;
    for (i = 0; i < turnIds.length; i++) { if (turns[turnIds[i]].r1) { hasR1 = true; break; } }

    if (!hasR1) {
      // fallback: лента без r1 — разворот порядка появления (new→old → old→new).
      var fb = [];
      for (i = order.length - 1; i >= 0; i--) fb.push(order[i]);
      return expand(fb);
    }

    // head-кандидаты: turnId, не встречающийся как r1 (самый новый).
    var r1Targets = {};
    for (i = 0; i < turnIds.length; i++) {
      var rt = turns[turnIds[i]].r1;
      if (rt) r1Targets[rt] = true;
    }
    var heads = [];
    for (i = 0; i < turnIds.length; i++) {
      if (!r1Targets[turnIds[i]]) heads.push(turnIds[i]);
    }
    if (!heads.length) {
      var fbc = [];
      for (i = order.length - 1; i >= 0; i--) fbc.push(order[i]);
      return expand(fbc);
    }

    // цепочки от head по r1 (new→old)
    var chains = [];
    var seen = {};
    for (i = 0; i < heads.length; i++) {
      var cur = heads[i];
      var chain = [];
      var guard = turnIds.length + 1;
      while (cur && turns[cur] && !seen[cur] && chain.length < guard) {
        seen[cur] = true;
        chain.push(cur);
        if (!turns[cur].r1) break;
        if (seen[turns[cur].r1]) { cur = null; break; } // цикл
        cur = turns[cur].r1;
      }
      if (chain.length) chains.push(chain);
    }

    // хвосты вне цепочек (по порядку появления, new→old)
    var extra = [];
    for (i = 0; i < turnIds.length; i++) { if (!seen[turnIds[i]]) extra.push(turnIds[i]); }

    // reverse каждой цепочки → old→new; extra — с конца (old→new)
    var final = [];
    for (i = 0; i < chains.length; i++) {
      for (var g = chains[i].length - 1; g >= 0; g--) final.push(chains[i][g]);
    }
    for (i = extra.length - 1; i >= 0; i--) final.push(extra[i]);

    return expand(final);
  }

  // Подсчёт r1-инверсий в финальном порядке среди сетевых ходов.
  // finalItems = [{ id, turnId, r1 }] в порядке old→new. r1 = сосед СТАРШЕ.
  // Инверсия: ход с r1=R стоит РАНЬШЕ R (старший R должен идти раньше).
  function countR1Inversions(finalItems) {
    var pos = {};
    var i, it, tk;
    for (i = 0; i < finalItems.length; i++) {
      it = finalItems[i];
      if (!it) continue;
      tk = it.turnId || it.id;
      if (tk && pos[tk] === undefined) pos[tk] = i;
    }
    var inv = 0;
    for (i = 0; i < finalItems.length; i++) {
      it = finalItems[i];
      if (!it || !it.r1) continue;
      tk = it.turnId || it.id;
      var rp = pos[it.r1];
      if (rp !== undefined && pos[tk] !== undefined && pos[tk] < rp) inv++;
    }
    return inv;
  }

  // ---- v38: разворот сырой страницы (new→old) в хронологический порядок (old→new) ----
  // Эквивалент обхода с конца в handleOuter (core/gemini-intercept.js). Внутри одного хода
  // user перед assistant. Не мутирует вход; возвращает новый массив сообщений [{id,turnId,role,...}].
  function reverseRawTurnPage(rawMsgs) {
    var arr = [];
    for (var i = 0; i < rawMsgs.length; i++) arr.push(rawMsgs[i]);
    arr.reverse();
    // внутри хода user перед assistant (остальные — устойчиво)
    arr.sort(function (a, b) {
      var at = (a && a.turnId) || (a && a.id) || '';
      var bt = (b && b.turnId) || (b && b.id) || '';
      if (at === bt) {
        var ra = (a && a.role === 'user') ? 0 : 1;
        var rb = (b && b.role === 'user') ? 0 : 1;
        return ra - rb;
      }
      return 0;
    });
    return arr;
  }

  // ---- v36: детерминированный порядок по связному списку r1 ----
  // r1 = id СТАРШЕГО соседа (обход newest→oldest). head = turn, чей id НЕ встречается
  // ни в одном значении r1 (самый НОВЫЙ). W = обход head → r1(head) → ... (newest→oldest).
  // M = turn'ы, не попавшие в W, отсортированы по order по возрастанию (старшие страницы).
  // final = M + reverse(W). Внутри хода user перед assistant.
  // items = [{ id, turnId, r1, order, role }]. Возвращает { ok, ids }.
  // ok=false только когда head-кандидатов 0 (цикл); иначе ok=true.
  function orderByR1Chain(items) {
    var turns = {};      // turnId -> { next, msgs: [messages], order }
    var r1Targets = {};  // значения r1 (id СТАРШИХ соседей)
    var i, it, tk;

    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (!it || !it.id) continue;
      tk = it.turnId || it.id; // без turnId — сам себе turn
      var ord = (it.order != null) ? it.order : 0;
      if (!turns[tk]) {
        turns[tk] = { next: it.r1 || null, msgs: [], order: ord };
      } else {
        if (!turns[tk].next && it.r1) turns[tk].next = it.r1;
        if (ord < turns[tk].order) turns[tk].order = ord;
      }
      turns[tk].msgs.push(it);
      if (it.r1) r1Targets[it.r1] = true;
    }

    var turnIds = Object.keys(turns);
    if (!turnIds.length) return { ok: true, ids: [] };

    // head: turn, чей id не является ничьим r1 (самый НОВЫЙ).
    var heads = [];
    for (i = 0; i < turnIds.length; i++) {
      if (!r1Targets[turnIds[i]]) heads.push(turnIds[i]);
    }
    if (!heads.length) return { ok: false, ids: [] }; // 0 кандидатов — фолбэк

    // 1 кандидат — он; несколько — максимальный order (самый новый, старт обхода).
    var head = heads[0];
    if (heads.length > 1) {
      for (i = 1; i < heads.length; i++) {
        if (turns[heads[i]].order > turns[head].order) head = heads[i];
      }
    }

    // W: обход от head по r1 (newest→oldest), с гардом цикла.
    var W = [];
    var seen = {};
    var cur = head;
    var guard = turnIds.length + 1;
    while (cur && turns[cur] && !seen[cur] && W.length < guard) {
      seen[cur] = true;
      W.push(cur);
      cur = turns[cur].next;
    }

    // M: ходы не из W, по возрастанию order (старшие страницы).
    var M = [];
    for (i = 0; i < turnIds.length; i++) {
      if (!seen[turnIds[i]]) M.push(turnIds[i]);
    }
    M.sort(function (a, b) { return turns[a].order - turns[b].order; });

    // final = reverse(W) (r1-цепочка old→new) + M (несвязанный остаток по arrival).
    // Приоритет: r1-цепочка задаёт хронологию; несвязанные ходы докладываются ПОСЛЕ неё.
    var chain = [];
    for (i = W.length - 1; i >= 0; i--) chain.push(W[i]);
    for (i = 0; i < M.length; i++) chain.push(M[i]);

    // раскрываем turn'ы в сообщения (user перед assistant внутри хода)
    var ids = [];
    for (i = 0; i < chain.length; i++) {
      var msgs = turns[chain[i]].msgs.slice();
      msgs.sort(function (a, b) {
        var ra = (a.role === 'user') ? 0 : 1;
        var rb = (b.role === 'user') ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return (a.order || 0) - (b.order || 0);
      });
      for (var m = 0; m < msgs.length; m++) ids.push(msgs[m].id);
    }
    return { ok: true, ids: ids };
  }

  // ---- v4x: авторитет по id + объединение restored-ленты с сетью ----
  // Сетевой ход ПЕРЕЗАПИСЫВАЕТ restored-ход того же id; restored остаётся только для
  // отсутствующих в сети id. Сетевым ходам сохраняются их order/r1/turnId; недостающим
  // restored-ходам назначается order по прибытию (после сети), чтобы несвязанный остаток
  // докладывался по arrival. Возвращает { items, missingCount }.
  function mergeRestoredTurns(networkItems, restoredTurns) {
    var netIds = {};
    var i, it, rt;
    for (i = 0; i < networkItems.length; i++) {
      it = networkItems[i];
      if (it && it.id != null) netIds[String(it.id)] = true;
    }
    var maxOrder = 0;
    for (i = 0; i < networkItems.length; i++) {
      it = networkItems[i];
      if (it && it.order != null && it.order > maxOrder) maxOrder = it.order;
    }
    var items = networkItems.slice();
    var missingCount = 0;
    for (i = 0; i < restoredTurns.length; i++) {
      rt = restoredTurns[i];
      if (!rt || rt.id == null) continue;
      if (Object.prototype.hasOwnProperty.call(netIds, String(rt.id))) continue; // сеть авторитетна
      items.push({
        id: String(rt.id),
        turnId: restoredTurnKeyOf(rt.id),
        r1: rt.r1 ? restoredTurnKeyOf(rt.r1) : null,
        order: maxOrder + 1 + i, // прибытие (после сети) для докладывания по arrival
        role: restoredRoleOf(rt),
        text: (rt.text == null) ? '' : String(rt.text)
      });
      missingCount++;
    }
    return { items: items, missingCount: missingCount };
  }

  // ---- v4x: protobuf-страница (тихая пагинация упёрлась в 0 ходов) ----
  // buildJsonSkeleton (core/gemini-intercept.js) сериализует непарсящуюся страницу
  // как {arr:N, items:[числа/массивы/строки]}. protobuf-страница (inner не строка)
  // содержит только числа/массивы и НЕ содержит ни одной строки-текста хода.
  function isProtobufSkeleton(skel) {
    if (!skel || typeof skel !== 'object') return false;
    var hasString = false;
    var hasArray = false;
    (function walk(n) {
      if (hasString && hasArray) return;
      if (typeof n === 'string') { hasString = true; return; }
      if (Array.isArray(n)) { hasArray = true; for (var i = 0; i < n.length; i++) walk(n[i]); return; }
      if (n && typeof n === 'object' && 'arr' in n) { hasArray = true; if (n.items) walk(n.items); }
    })(skel);
    return hasArray && !hasString;
  }

  // Эффективный reachedStart: пагинация дошла до начала ТОЛЬКО если флаг взведён,
  // последний шаг добавил ходов И не упёрся в protobuf-страницу (0 ходов).
  function effectiveReachedStart(reachedStart, added, failedSkeleton) {
    if (!reachedStart) return false;
    if (!added || added <= 0) return false;
    if (isProtobufSkeleton(failedSkeleton)) return false;
    return true;
  }

  // Мерджим restored-ленту, пока пагинация НЕ дошла до начала (reachedStart=false),
  // НЕЗАВИСИМО от baseComplete/historyFullByQuiet.
  function shouldMergeRestoredTurns(reachedStart) {
    return reachedStart !== true;
  }

  // ---- v4x: санация и дедуп финального списка сообщений ----
  // Применяется к messages ПЕРЕД сохранением/эмиссией:
  //   - чистый английский thinking-assistant удаляется целиком (isThinkingAssistant);
  //   - смешанный блок срезается до первого кириллического символа (stripLeadingThinking);
  //   - строгий дедуп: подряд идущие assistant с одинаковым text (или id) схлопываются.
  function sanitizeFinalMessages(messages, helpers) {
    helpers = helpers || {};
    var isTA = (typeof helpers.isThinkingAssistant === 'function') ? helpers.isThinkingAssistant : function () { return false; };
    var strip = (typeof helpers.stripLeadingThinking === 'function') ? helpers.stripLeadingThinking : function (s) { return s; };
    var out = [];
    var prev = null;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (!m) continue;
      var role = (m.role === 'user') ? 'user' : 'assistant';
      var id = (m.id != null) ? String(m.id) : null;
      var text = (m.text == null) ? '' : String(m.text);
      if (role === 'assistant') {
        if (isTA(text)) { prev = null; continue; } // чистый thinking → удаляем целиком
        text = strip(text);
        if (!text || !text.trim()) { prev = null; continue; }
      }
      // строгий дедуп: подряд два assistant с идентичным text или id
      if (prev && prev.role === 'assistant' && role === 'assistant') {
        if (id !== null && prev.id !== null && id === prev.id) continue;
        if (text === prev.text) continue;
      }
      var rec = { role: role, text: text };
      if (id !== null) rec.id = id;
      out.push(rec);
      prev = rec;
    }
    return out;
  }

  var api = {
    floorStorageKey: floorStorageKey,
    tapeStorageKey: tapeStorageKey,
    tapeVersionOf: tapeVersionOf,
    shouldAcceptTape: shouldAcceptTape,
    loadFloor: loadFloor,
    saveFloor: saveFloor,
    resolveFloor: resolveFloor,
    shouldSaveFloor: shouldSaveFloor,
    shouldFullRebuild: shouldFullRebuild,
    assignPageOrders: assignPageOrders,
    orderPages: orderPages,
    reverseRawTurnPage: reverseRawTurnPage,
    orderPageByR1: orderPageByR1,
    orderRestoredTape: orderRestoredTape,
    countR1Inversions: countR1Inversions,
    orderByArrival: orderByArrival,
    orderByR1Chain: orderByR1Chain,
    mergeRestoredTurns: mergeRestoredTurns,
    isProtobufSkeleton: isProtobufSkeleton,
    effectiveReachedStart: effectiveReachedStart,
    shouldMergeRestoredTurns: shouldMergeRestoredTurns,
    sanitizeFinalMessages: sanitizeFinalMessages
  };

  if (typeof window !== 'undefined') {
    window.GeminiInterceptLogic = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();