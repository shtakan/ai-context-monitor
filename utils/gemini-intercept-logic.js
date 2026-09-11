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

  // v1.6 (D15a-2/D17): версия порядка ленты. orderVersion=2 продолжаем ПИСАТЬ, но НЕ
  // гейтим чтение: порядок тейпа больше НЕ наследуется (mergeRestoredTurns ставит
  // restored-ходам r1=null — хронологию пересчитывает chain-r1 + фикс B старшего
  // сегмента). Отклонение g3-тейпа по orderVersion теряло контент (сеть отдаёт только
  // хвостовое окно, старшие ходы есть только в тейпе) → неверная голова экспорта.
  var TAPE_ORDER_VERSION = 2;

  // Лента принимается при точном совпадении версии записи с текущей версией парсера.
  // meta.orderVersion НЕ проверяется — контент тейпа сливается по id, порядок
  // пересчитывается из r1-графа (старые повёрнутые тейпы безопасны).
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
  // Причина отсутствия/нулевого пола (для лога «ожидаемых=0» в expectedTurnsFromStorage).
  function diagnoseFloorAbsence(convId, parserVersion, storage) {
    if (!storage) return 'no-storage';
    if (!convId) return 'no-conv';
    var raw = null;
    try { raw = storage.getItem(floorStorageKey(convId, parserVersion)); } catch (e) { raw = null; }
    if (typeof raw !== 'string' || !raw) return 'no-floor-saved';
    var f = parseFloor(raw, parserVersion);
    if (!f) return 'version-mismatch-or-invalid';
    if (!f.count) return 'floor-count-zero';
    return 'ok';
  }

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

  // ---- v1.16.5 (T1-fix#5): САМОУНИЖЕНИЕ УСТАРЕВШЕГО ПОЛА (clean-end self-heal) ----
  // HWM НЕ ТРОНУТ: saveFloor по-прежнему двигает пол только ВВЕРХ, archiveFloorRecord —
  // только ВВЕРХ. Понижение — ОТДЕЛЬНЫЙ механизм с собственным доказательством
  // (selfHealFloorVerdict) и единственной точкой записи (writeSelfHealedFloor).
  //
  // ЗАЧЕМ. Пол — снимок прошлой ПОЛНОЙ сборки. Если чат с тех пор укорочен на сервере
  // (или пол был поднят уже удалённым архивом), база остаётся ниже пола НАВСЕГДА:
  //   • гейт below-floor вечно возвращает oracle=incomplete → baseComplete/reachedStart
  //     не взводятся → автоэкспорт остаётся в deferred (не блокируется, но и не выходит);
  //   • completeness-оракул запускает loader-restart по кругу (циклические перезагрузки),
  //     хотя окно вырасти не может — сервер больше страниц не отдаёт.
  // Поэтому при ДОКАЗАННОМ чистом конце истории (сеть отдала всё: quietEndedClean,
  // курсора продолжения нет, тихий цикл не активен, ошибок страницы нет) и
  // подтверждении повтором (база не растёт ≥5с) устаревший пол понижается до реального
  // значения базы (msgs). reachedStart при этом может оставаться 0 — именно этот случай
  // лоадер и не может закрыть сам (физического верха нет).
  //
  // ПОЧЕМУ H10 НЕ ОСЛАБЛЕН. Понижение невозможно без доказательства «сервер больше
  // ничего не отдаёт»: живой курсор, активный тихий цикл, ошибка страницы, незавершённый
  // прогон лоадера, неподтверждённый живой ярус архива, пустая база, отсутствующий пол,
  // база >= пола и отсутствие подтверждающего повтора — каждый случай запрещает
  // понижение со своим reason. Только связка «чистый конец + повтор» его разрешает.
  //
  // o = { cleanEnd, pendingCursor, quietActive, pageError, loaderRunning, archivePending,
  //       baseCount, floorCount, floorLen, provenLen, reachedStart, confirmations }.
  function selfHealFloorVerdict(opts) {
    var o = opts || {};
    var baseCount = (typeof o.baseCount === 'number' && o.baseCount > 0) ? o.baseCount : 0;
    var floorCount = (typeof o.floorCount === 'number' && o.floorCount > 0) ? o.floorCount : 0;
    var floorLen = (typeof o.floorLen === 'number' && o.floorLen > 0) ? o.floorLen : 0;
    var provenLen = (typeof o.provenLen === 'number' && o.provenLen > 0) ? o.provenLen : 0;
    var confirmations = (typeof o.confirmations === 'number' && o.confirmations > 0) ? o.confirmations : 0;
    if (o.cleanEnd !== true) return { lower: false, reason: 'no-clean-end' };
    if (o.pendingCursor) return { lower: false, reason: 'cursor-alive' };
    if (o.quietActive === true) return { lower: false, reason: 'quiet-active' };
    if (o.pageError === true) return { lower: false, reason: 'page-error' };
    if (o.loaderRunning === true) return { lower: false, reason: 'loader-running' };
    if (o.archivePending === true) return { lower: false, reason: 'archive-pending-live' };
    if (!baseCount) return { lower: false, reason: 'base-empty' };
    if (!floorCount) return { lower: false, reason: 'no-floor' };
    if (baseCount >= floorCount) return { lower: false, reason: 'floor-not-stale' };
    if (confirmations < 1) return { lower: false, reason: 'unconfirmed' };
    // effectiveLen понижаем до РЕАЛЬНОЙ длины базы: прежняя (фантомная) длина задирала бы
    // бейдж/токены (v78-хард-пол). provenLen неизвестен (0) → оставляем прежнюю длину:
    // count уже равен базе, поэтому пол в resolveFloor/v78 не применяется.
    return {
      lower: true, count: baseCount, effectiveLen: (provenLen || floorLen),
      floorWas: floorCount, source: 'clean-end-self-heal',
      reachedStart: o.reachedStart === true, reason: 'stale-floor'
    };
  }

  // ЕДИНСТВЕННАЯ точка ПОНИЖЕНИЯ пола. Вызывается только по вердикту
  // selfHealFloorVerdict (или из уже доказанной clean-end ветки лоадера, где повтор
  // зафиксирован collapse-ретраем) — то есть понижение всегда опирается на доказанный
  // чистый конец истории. saveFloor этим путём НЕ подменяется и не меняется.
  function writeSelfHealedFloor(convId, parserVersion, count, effectiveLen, source, storage) {
    if (!storage || !convId) return null;
    if (typeof count !== 'number' || !(count > 0)) return null;
    var len = (typeof effectiveLen === 'number' && effectiveLen > 0) ? effectiveLen : 0;
    var rec = {
      count: count, effectiveLen: len, ts: Date.now(), version: parserVersion,
      source: source || 'clean-end-self-heal'
    };
    try {
      storage.setItem(floorStorageKey(convId, parserVersion), JSON.stringify(rec));
      return rec;
    } catch (e) { return null; }
  }

  // Полная пересборка vf5 допустима только для действительно полной истории (без курсора продолжения).
  function shouldFullRebuild(opts) {
    opts = opts || {};
    return !!(opts.fromVirtualF5 && opts.wasFull && !opts.hasCursor);
  }

  // ---- v60: disjoint-reset — контентный критерий смены сеанса/аккаунта ----
  // Гард применяется ТОЛЬКО к путям vf5 и passive-снапшотов. pag/тихая пагинация
  // легитимно не пересекается с базой (её страницы СТАРШЕ) — гард на неё не действует.
  // Смена сеанса/аккаунта: turnsMap непуст и входящий снапшот имеет НОЛЬ пересечений
  // id с базой → полный сброс перед merge (иначе merge-by-id подмешает чужие ходы:
  // convId при смене аккаунта не меняется, stale-conv слеп).
  // opts = { src, existingIds, incomingIds, incomingConvId, currentConvId }.
  function shouldDisjointReset(opts) {
    opts = opts || {};
    var src = opts.src || '';
    if (src !== 'vf5' && src !== 'passive') return false;
    // v64: тот же чат (incomingConvId === currentConvId) — disjoint-reset ЗАПРЕЩЁН.
    // passive-снимки виртуализированного DOM одного чата дают непересекающиеся окна
    // ОДНОЙ истории → всегда union по id (same-conv-union), а не сброс базы.
    if (opts.incomingConvId && opts.currentConvId && opts.incomingConvId === opts.currentConvId) return false;
    var existing = Array.isArray(opts.existingIds) ? opts.existingIds : [];
    var incoming = Array.isArray(opts.incomingIds) ? opts.incomingIds : [];
    if (!existing.length || !incoming.length) return false;
    var seen = {};
    for (var i = 0; i < existing.length; i++) seen[existing[i]] = true;
    for (var j = 0; j < incoming.length; j++) {
      if (incoming[j] && seen[incoming[j]]) return false;
    }
    return true;
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

  // ---- v1.6 (D15a-2): единый порядок экспорта (авто == ручной) ----
  // Авто и ручная выгрузка строят файл ОДНОЙ функцией порядка. Голова = первое
  // сообщение серверного/ручного порядка (истинный первый user-ход).
  // 1) r1-цепочка (chain-r1) — ВСЕГДА, когда r1-граф покрывает все ходы карты:
  //    голова = реальный ход с null/неизвестным r1, старший несвязный сегмент
  //    (r1-перемычка) докладывается ПЕРЕД головой (фикс B в orderByR1Chain).
  //    Сравнение с серверной головой УБРАНО: тейп мог повернуть order, а r1 — источник
  //    хронологии; arrival-сравнение лишь повторяло повёрнутый порядок.
  // 2) arrival — ТОЛЬКО фолбэк при отсутствии r1-графа (!r1.ok / не покрывает).
  // 3) сортировка по order (серверный, деградация).
  // T1-fix#4 (v1.16.4): АРХИВНЫЕ ходы (item.archive === true — метка archiveAdded из
  // core/gemini-intercept.js) — ВСЕГДА голова файла: архив T1 = СТАРШАЯ история того же
  // чата, она обязана идти ПЕРЕД живым окном. Раньше признака «это архив» в порядке не
  // было, и ходы, влитые архивом (order = maxOrder+1+i, САМЫЙ БОЛЬШОЙ в базе), уезжали
  // в хвост (live-баг: база 114, а последние строки файла — архивные, «Страницы памяти
  // помечаются read-only»). Порядок ВНУТРИ архива — собственный (order вливания), затем
  // идёт прежний порядок остальной базы (mode сохраняется: chain-r1/arrival/order-sort).
  // Чаты без архива: ни одного item.archive → прежний результат байтово.
  function orderExportMessages(orderItems) {
    try {
      var archItems = [];
      var restItems = [];
      for (var q = 0; q < orderItems.length; q++) {
        var qi = orderItems[q];
        if (!qi || !qi.id) continue;
        if (qi.archive === true) archItems.push(qi);
        else restItems.push(qi);
      }
      var res = orderExportMessagesBase(restItems);
      if (!archItems.length) return res;
      archItems.sort(function (a, b) {
        var ao = (a.order != null) ? a.order : 0;
        var bo = (b.order != null) ? b.order : 0;
        if (ao !== bo) return ao - bo;
        return 0; // при равных order порядок вливания архива сохраняется (stable sort)
      });
      var ids = [];
      for (var am = 0; am < archItems.length; am++) ids.push(archItems[am].id);
      for (var rm = 0; rm < res.ids.length; rm++) ids.push(res.ids[rm]);
      return { ids: ids, mode: res.mode };
    } catch (e) {
      return { ids: orderItems.filter(function (x) { return x && x.id; }).map(function (x) { return x.id; }), mode: 'order-sort' };
    }
  }

  // Прежнее (до T1-fix#4) тело порядка: r1-цепочка → arrival → сортировка по order.
  // Вынесено без изменений — вызывается ТОЛЬКО из orderExportMessages.
  function orderExportMessagesBase(orderItems) {
    try {
      var r1 = orderByR1Chain(orderItems);
      if (r1.ok && r1.ids.length) return { ids: r1.ids, mode: 'chain-r1' };
      var arr = orderByArrival(orderItems);
      if (arr.ok) return { ids: arr.ids, mode: 'arrival' };
      var byOrder = [];
      for (var j = 0; j < orderItems.length; j++) {
        if (orderItems[j] && orderItems[j].id) byOrder.push(orderItems[j]);
      }
      byOrder.sort(function (a, b) {
        var ao = (a.order != null) ? a.order : 0;
        var bo = (b.order != null) ? b.order : 0;
        if (ao !== bo) return ao - bo;
        return String(a.id).localeCompare(String(b.id));
      });
      return { ids: byOrder.map(function (x) { return x.id; }), mode: 'order-sort' };
    } catch (e) {
      return { ids: orderItems.filter(function (x) { return x && x.id; }).map(function (x) { return x.id; }), mode: 'order-sort' };
    }
  }

  // ---- v1.6 (D15): обход cache-complete при oracle=incomplete (ровно один раз) ----
  // При восстановленной ленте (cacheRestoredMap) maybeStartLoader всегда скипается
  // cache-complete, страховочный v78-скролл недостижим → авто-fired не стреляет и
  // уходит deferred-timeout as-is с [LOW CONFIDENCE]_. Если оракул полноты сказал
  // incomplete (oracleIncompleteSeen[convId]) и ре-ран ещё не использован (rerunUsed
  // не задан) — разрешаем ОДИН повторный прогон лоадера. После ре-рана флаг снят →
  // повторных обходов нет (цикла нет). Холодное открытие без incomplete — как прежде.
  function shouldBypassCacheComplete(seenFlags, rerunUsed, convId) {
    if (!convId) return false;
    if (!(seenFlags && seenFlags[convId])) return false; // incomplete не было — байтово как прежде
    if (rerunUsed && rerunUsed[convId]) return false;    // ре-ран уже использован — не циклиться
    return true;
  }

  // ---- v1.6 (D16): hide-скролл лоадера (bootstrap короткого контейнера) ----
  // При старшей истории + oracle incomplete + начало не достигнуто — скрываем и
  // скроллим НЕЗАВИСИМО от порога scrollH (оверлей маскирует UI). Порог остаётся
  // для коротких чатов БЕЗ признаков старшей истории (все ходы в экране).
  // state = { scrollH, minHideH, olderHistorySeen, reachedStart, oracleIncomplete }.
  // Возвращает { hide, bootstrapShort }.
  function shouldHideScroller(state) {
    var h = (state && typeof state.scrollH === 'number') ? state.scrollH : 0;
    var minH = (state && typeof state.minHideH === 'number') ? state.minHideH : 8000;
    var older = !!(state && state.olderHistorySeen);
    var reachedStart = !!(state && state.reachedStart);
    var oracleIncomplete = !!(state && state.oracleIncomplete);
    if (h > minH) return { hide: true, bootstrapShort: false };
    var bootstrapShort = older && !reachedStart && oracleIncomplete;
    if (bootstrapShort) return { hide: true, bootstrapShort: true };
    return { hide: false, bootstrapShort: false };
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

    // v1.6 (D15/D19): старший несвязный сегмент — ПЕРЕД головой основной цепи.
    // Рваная r1-перемычка отрывает старшую предысторию от основной цепи (W). D19:
    // критерий по ОТДЕЛЬНЫМ ходам (order < minOrderW) ломался, когда у старшего сегмента
    // часть ходов имела order >= minOrderW (циклический сдвиг — сегмент распадался в
    // M_rest/конец). Теперь M разбивается на СВЯЗНЫЕ r1-компоненты; сегмент, чей
    // минимальный order < minOrderW, целиком помещается ПЕРЕД W (голова = его первый ход).
    var minOrderW = Infinity;
    for (i = 0; i < W.length; i++) {
      if (turns[W[i]].order < minOrderW) minOrderW = turns[W[i]].order;
    }
    // обратные r1-ребра внутри M (кто ссылается на ход как на r1)
    var childrenM = {};
    for (i = 0; i < M.length; i++) {
      var tkM = M[i];
      var nxM = turns[tkM].next;
      if (nxM && turns[nxM] && !seen[nxM]) { (childrenM[nxM] = childrenM[nxM] || []).push(tkM); }
    }
    // связные компоненты M по r1
    var seenSeg = {};
    var segments = [];
    for (i = 0; i < M.length; i++) {
      if (seenSeg[M[i]]) continue;
      var comp = [];
      var stack = [M[i]];
      seenSeg[M[i]] = true;
      while (stack.length) {
        var nd = stack.pop();
        comp.push(nd);
        var fw = turns[nd].next;
        if (fw && turns[fw] && !seenSeg[fw]) { seenSeg[fw] = true; stack.push(fw); }
        var ch = childrenM[nd];
        if (ch) {
          for (var c2 = 0; c2 < ch.length; c2++) {
            if (!seenSeg[ch[c2]]) { seenSeg[ch[c2]] = true; stack.push(ch[c2]); }
          }
        }
      }
      segments.push(comp);
    }
    var M_older = []; var M_rest = [];
    for (i = 0; i < segments.length; i++) {
      var segMin = Infinity;
      for (var s2 = 0; s2 < segments[i].length; s2++) {
        if (turns[segments[i][s2]].order < segMin) segMin = turns[segments[i][s2]].order;
      }
      var target = (segMin < minOrderW) ? M_older : M_rest;
      for (var a2 = 0; a2 < segments[i].length; a2++) target.push(segments[i][a2]);
    }
    M_older.sort(function (a, b) { return turns[a].order - turns[b].order; });
    M_rest.sort(function (a, b) { return turns[a].order - turns[b].order; });

    // final = старший сегмент (old→new по arrival) + reverse(W) (основная цепь old→new)
    // + M_rest (свежий несвязанный остаток).
    var chain = [];
    for (i = 0; i < M_older.length; i++) chain.push(M_older[i]);
    for (i = W.length - 1; i >= 0; i--) chain.push(W[i]);
    for (i = 0; i < M_rest.length; i++) chain.push(M_rest[i]);

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
  // restored-ходам назначается order по прибытию (после сети), а r1=null — порядок
  // НЕ наследуется из тейпа (v1.6 D15a-2: старые тейпы могли хранить повёрнутый r1,
  // который воспроизводил повёрнутую голову экспорта). Хронология после merge
  // пересчитывается из r1-графа (orderExportMessages → chain-r1); restored-узлы с
  // r1=null — головы своих сегментов, старший сегмент докладывается ПЕРЕД основной
  // цепью (правило старшего сегмента, orderByR1Chain).
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
    // v1.6 (D17): restored-ходам присваивается order ДО сети (i - (maxOrder+1) — отрицательный),
    // чтобы фикс B (старший сегмент с order < minOrderW) помещал их ПЕРЕД хвостовым окном сети.
    // Сеть отдаёт хвостовое окно; старшие ходы есть только в тейпе — их место в начале экспорта.
    for (i = 0; i < restoredTurns.length; i++) {
      rt = restoredTurns[i];
      if (!rt || rt.id == null) continue;
      if (Object.prototype.hasOwnProperty.call(netIds, String(rt.id))) continue; // сеть авторитетна
      items.push({
        id: String(rt.id),
        turnId: restoredTurnKeyOf(rt.id),
        r1: null, // v1.6 (D15a-2/D17): r1 тейпа НЕ наследуется (повёрнутый порядок) — порядок пересчитает chain-r1
        order: i - (maxOrder + 1), // до сети: старший сегмент уходит в начало (фикс B)
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

  // v63: пороги sanity-чека для Low Confidence Fallback — без proof (tape/vf5-overlap),
  // но с достаточно большой базой, экспорт разрешается с флагом lowConfidence=true.
  var MIN_MSGS_FOR_FALLBACK = 5;
  var MIN_TEXT_LEN_FOR_FALLBACK = 500;

  // v62/v63/v65/v66/v67: гард confirmed-by-scroll — подтверждение полноты лоадером.
  // Сигнатура: один объект state = { topReached, scrollEngaged, tapeWasUsedInThisColdStart,
  // vf5OverlapSinceLoaderStart, msgCount, textLength } — сводное состояние прогона лоадера
  // (loaderState в core/gemini-intercept.js) + метрики базы. Отдельные аргументы не используются.
  //   0) v65: ОБЯЗАТЕЛЬНЫЙ физический верх (topReached=true, scrollTop <= 8px):
  //      allowed=false при topReached=false — height-stable среди истории не признак конца;
  //   0b) v66: ОБЯЗАТЕЛЬНОЕ вовлечение скрытого скролла (scrollEngaged=true — hide-applied
  //      ИЛИ рост scrollH ИЛИ смена scrollTop): allowed=false при scrollEngaged=false
  //      (reason=scroll-not-engaged) — на невовлечённом скроллере scrollTop=0 тривиален;
  //   1) proof: лента из кэша (tape-restore action=used) ИЛИ после старта лоадера был
  //      ingest src=vf5 с overlapCount>0 → allowed=true, lowConfidence=false;
  //   2) sanity-фолбэк: proof нет, но база достаточно велика (msgCount >= MIN_MSGS_FOR_FALLBACK
  //      ИЛИ textLength >= MIN_TEXT_LEN_FOR_FALLBACK) → allowed=true, lowConfidence=true
  //      (экспорт разрешён, имя файла получает префикс [LOW CONFIDENCE]_);
  //   3) иначе — allowed=false (холодный старт с мусорной passive-базой: не подтверждать).
  function canConfirmByScroll(state) {
    var top = !!(state && state.topReached === true); // v65: физический верх обязателен
    var engaged = !!(state && state.scrollEngaged === true); // v66: скрытый скролл вовлечён
    var tape = !!(state && state.tapeWasUsedInThisColdStart);
    var vf5 = !!(state && state.vf5OverlapSinceLoaderStart);
    var msgCount = (state && typeof state.msgCount === 'number') ? state.msgCount : 0;
    var textLength = (state && typeof state.textLength === 'number') ? state.textLength : 0;
    if (!top) return { allowed: false, lowConfidence: false, reason: 'top-not-reached' }; // v65
    if (!engaged) return { allowed: false, lowConfidence: false, reason: 'scroll-not-engaged' }; // v66
    if (tape) return { allowed: true, lowConfidence: false, reason: 'tape-used' };
    if (vf5) return { allowed: true, lowConfidence: false, reason: 'vf5-overlap' };
    if (msgCount >= MIN_MSGS_FOR_FALLBACK || textLength >= MIN_TEXT_LEN_FOR_FALLBACK) {
      return { allowed: true, lowConfidence: true, reason: 'fallback-sanity-check' };
    }
    return { allowed: false, lowConfidence: false, reason: 'no-tape-no-vf5-overlap-and-failed-sanity' };
  }

  // ---- v68: сервер-авторитетная пагинация (курсор — единственный источник полноты) ----
  // Страховочные потолки одного прогона: не более 25 страниц ИЛИ 60 секунд.
  // При достижении потолка цикл завершается как НЕполный (warn), baseComplete/reachedStart
  // НЕ взводятся: полнота определяется ТОЛЬКО исчерпанием серверного continuation-курсора.
  var DEFAULT_PAGINATE_PAGE_CAP = 25;
  var DEFAULT_PAGINATE_TIME_CAP_MS = 60000;

  // Решение о следующем шаге пагинации. state = {
  //   hasCursor: bool,     // в последнем ответе есть continuation-курсор
  //   pages: number,       // сколько страниц уже запрошено в этом прогоне
  //   elapsedMs: number,   // сколько прошло с начала прогона
  //   added: number,       // сколько ходов добавил последний шаг
  //   failedSkeleton: any  // скелет непарсящейся страницы (protobuf-страница)
  // }
  // caps = { pageCap, timeCapMs } (опционально, по умолчанию DEFAULT_*).
  // Возвращает { action: 'continue'|'complete'|'cap', reason, reachedStart, baseComplete, warn }.
  function paginateStepDecision(state, caps) {
    caps = caps || {};
    var pageCap = (typeof caps.pageCap === 'number' && caps.pageCap > 0) ? caps.pageCap : DEFAULT_PAGINATE_PAGE_CAP;
    var timeCapMs = (typeof caps.timeCapMs === 'number' && caps.timeCapMs > 0) ? caps.timeCapMs : DEFAULT_PAGINATE_TIME_CAP_MS;
    var hasCursor = !!(state && state.hasCursor);
    var pages = (state && typeof state.pages === 'number') ? state.pages : 0;
    var elapsedMs = (state && typeof state.elapsedMs === 'number') ? state.elapsedMs : 0;
    var added = (state && typeof state.added === 'number') ? state.added : 0;
    var failedSkeleton = state && state.failedSkeleton;

    // страховочный потолок по числу страниц — база НЕ полная (warn-причина)
    if (pages >= pageCap) {
      return { action: 'cap', reason: 'page-cap', reachedStart: false, baseComplete: false, warn: 'страховочный потолок страниц достигнут (' + pageCap + ')' };
    }
    // страховочный потолок по времени — база НЕ полная (warn-причина)
    if (elapsedMs >= timeCapMs) {
      return { action: 'cap', reason: 'time-cap', reachedStart: false, baseComplete: false, warn: 'страховочный потолок времени достигнут (' + timeCapMs + 'мс)' };
    }
    // курсор ещё жив — «старшие страницы есть»: продолжаем тянуть вверх
    if (hasCursor) {
      return { action: 'continue', reason: 'cursor-alive', reachedStart: false, baseComplete: false, warn: '' };
    }
    // курсора больше нет — «старших страниц больше нет»: истинное начало.
    // reachedStart только если последний шаг реально добавил ходы и не упёрся в protobuf-страницу.
    var rs = effectiveReachedStart(true, added, failedSkeleton);
    return { action: 'complete', reason: (rs ? 'end' : 'no-start'), reachedStart: rs, baseComplete: rs, warn: '' };
  }

  // v68: счётчики прогона пагинации, сбрасываемые при смене чата (conv-changed → перезапуск
  // лоадера). prev не обязателен; возвращает нулевое состояние прогона.
  function resetPaginationCounters(prev) {
    return { pageCount: 0, startTs: 0 };
  }

  // ---- v69: completeness oracle — единый источник правды полноты базы ----
  // Полнота = (серверный курсор пагинации исчерпан, подтверждён явным probe-запросом)
  //           И (firstMsgHash базы == firstMsgHash первой страницы сервера).
  // DOM-эвристики (scrollEngaged/topReached/hide-applied) НЕ участвуют в решении — только
  // диагностические логи. state = { cursorExhausted, dbFirstHash, serverFirstHash }.
  // Возвращает { complete, reason, retry }; retry=true → дозапуск лоадера (≤3 ретраев).
  function completenessOracle(state) {
    var cursorExhausted = !!(state && state.cursorExhausted === true);
    var dbFirstHash = (state && typeof state.dbFirstHash === 'string') ? state.dbFirstHash : '';
    var serverFirstHash = (state && typeof state.serverFirstHash === 'string') ? state.serverFirstHash : '';
    if (!cursorExhausted) {
      return { complete: false, reason: 'cursor-alive', retry: false };
    }
    if (!serverFirstHash) {
      return { complete: false, reason: 'no-server-probe', retry: false };
    }
    if (dbFirstHash && serverFirstHash && dbFirstHash === serverFirstHash) {
      return { complete: true, reason: 'first-hash-match', retry: false };
    }
    return { complete: false, reason: 'first-hash-mismatch', retry: true };
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

  // ---- v4x: детектор готовности DOM перед автоскроллом ----
  // Создаёт чистое состояние замера. state.samples — последние (до 3) значения scrollHeight.
  function newDomReadiness() {
    return { samples: [], readyByElements: false };
  }

  // Подаём очередной замер scrollHeight и текущее число элементов истории в DOM.
  // Возвращает { ready, reason, samples }. ready=true когда:
  //   - элементов истории > 10 (появление минимального числа элементов), ИЛИ
  //   - 3 последних замера scrollHeight различаются меньше чем на 100px (стабилизация).
  function advanceReadiness(state, scrollHeight, elementCount, expected) {
    state = state || newDomReadiness();
    if (elementCount > 10 && elementCount === expected) {
      state.readyByElements = true;
      return { ready: true, reason: 'elements:' + elementCount, samples: state.samples.slice() };
    }
    state.samples.push(scrollHeight);
    if (state.samples.length > 3) {
      state.samples = state.samples.slice(state.samples.length - 3);
    }
    if (state.samples.length >= 2) {
      var a = state.samples[state.samples.length - 2];
      var b = state.samples[state.samples.length - 1];
      if (Math.abs(b - a) < 100) {
        var lo = Math.min(a, b);
        var hi = Math.max(a, b);
        return { ready: true, reason: 'stable:' + lo + '-' + hi, samples: state.samples.slice() };
      }
    }
    return { ready: false, reason: 'pending', samples: state.samples.slice() };
  }

  // ---- v4x: retry-логика автоскролла ----
  // actualTurns — ходов видно после скролла (из DOM или storage/сети);
  // expectedTurns — ожидаемое число ходов (из сети или прошлого замера/пола);
  // retryCount/maxRetry — счётчик и лимит ретраев.
  function shouldRetryAutoscroll(actualTurns, expectedTurns, retryCount, maxRetry) {
    if (!expectedTurns || expectedTurns <= 0) return false;
    if (retryCount >= maxRetry) return false;
    return actualTurns < expectedTurns;
  }

  // ---- v54: детектор обрезки истории (Gemini, спасательный pre-trim экспорт) ----
  // Сравниваем ПОЛНЫЙ новый снимок с эталоном последнего ПОЛНОГО снимка (prevProbe):
  //   prevProbe = { maxCount, firstIds, suspectPending }; snapshot = { count, messageIds,
  //   historyComplete }. Обновление probe и вызов детектора делает только частичная-
  //   загрузка-мимо (historyComplete=false вообще игнорируется — это норма тихой
  //   пагинации, не обрезка). Обрезка (lostHead): count < maxCount И среди первых
  //   TRIM_HEAD_IDS_N id нового снимка НЕТ НИ ОДНОГО сохранённого firstId (голова
  //   реально отрезана сервером). suspect — впервые увиденная обрезка; confirmed —
  //   два последовательных срабатывания подряд (suspectPending ставит вызывающий код).
  var TRIM_HEAD_IDS_N = 10;
  function detectTrimState(prevProbe, snapshot) {
    var res = { suspect: false, confirmed: false, lostHead: false };
    try {
      if (!snapshot || !Array.isArray(snapshot.messageIds)) return res;
      if (snapshot.historyComplete === false) return res;
      var curCount = (typeof snapshot.count === 'number') ? snapshot.count : snapshot.messageIds.length;
      if (!prevProbe || !(typeof prevProbe.maxCount === 'number') || !(prevProbe.maxCount > 0)) return res;
      if (!(curCount < prevProbe.maxCount)) return res;
      var prevFirst = Array.isArray(prevProbe.firstIds) ? prevProbe.firstIds : [];
      if (prevFirst.length === 0) return res;
      var head = [];
      var lim = Math.min(TRIM_HEAD_IDS_N, snapshot.messageIds.length);
      for (var i = 0; i < lim; i++) head.push(String(snapshot.messageIds[i]));
      for (var j = 0; j < prevFirst.length; j++) {
        if (head.indexOf(String(prevFirst[j])) !== -1) return res; // хотя бы один старый первый id ещё виден — голова на месте
      }
      res.lostHead = true;
      res.suspect = true;
      res.confirmed = !!prevProbe.suspectPending;
    } catch (e) { }
    return res;
  }

  // ---- v40: тишина vf5-поллера при полной истории ----
  // ---- v40: тишина vf5-поллера при полной истории ----
  // vf5-поллер (MutationObserver → debounce → activeRefresh) не должен планировать
  // следующий активный запрос, когда история уже полная (baseComplete=true) и тихая
  // пагинация дошла до начала (reachedStart=true), а активности не было последние 60с.
  // Активностью считаются: DOM-мутации, пассивный batchexecute-снимок, смена чата.
  // Любое такое событие обновляет lastActivityAt и немедленно возобновляет поллинг.
  // state = { baseComplete, reachedStart, lastActivityAt }; nowMs — текущее время (мс).
  function shouldPollVf5(state, nowMs) {
    state = state || {};
    var baseComplete = !!state.baseComplete;
    var reachedStart = !!state.reachedStart;
    var lastActivityAt = (typeof state.lastActivityAt === 'number') ? state.lastActivityAt : 0;
    var idleMs = nowMs - lastActivityAt;
    if (baseComplete && reachedStart && idleMs >= 60000) return false;
    return true;
  }

  // ---- v55 / S2 (Фаза B): проактивные пороги (настраиваемые) ----
  // Дефолт [70,85,95]. Чистая функция выбора порога: максимальный T из порогов, такой
  // что pct >= T и T ещё не исполнен в этом разговоре (firedSet). Анти-спам латч ведёт
  // вызывающий код (SW, ключ 'aiCmThr:'+convId); здесь никакой мутируемой стейт не
  // хранится. thresholds — опциональный кастомный список (low<medium<high);
  // по умолчанию PROACTIVE_THRESHOLDS.
  var PROACTIVE_THRESHOLDS = [70, 85, 95];

  // S2: валидация настроенных порогов (options 'aiCmProactiveThresholds').
  // Требования: ровно три числа 1–100 в строго возрастающем порядке (low<medium<high).
  // Возвращает нормализованный массив чисел или null (битое значение).
  function normalizeProactiveThresholds(v) {
    try {
      if (!Array.isArray(v) || v.length < 3) return null;
      var out = [];
      for (var i = 0; i < 3; i++) {
        var n = parseInt(v[i], 10);
        if (isNaN(n) || n < 1 || n > 100) return null;
        out.push(n);
      }
      if (!(out[0] < out[1] && out[1] < out[2])) return null;
      return out;
    } catch (e) { return null; }
  }

  // S2: чтение настраиваемых порогов из chrome.storage.local ('aiCmProactiveThresholds').
  // Возвращает Promise<массив>: валидное значение — как есть; битое/отсутствующее или
  // недоступный storage — дефолт [70,85,95] (SW получает синхронный фолбэк на дефолт).
  function getProactiveThresholds() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local ||
        typeof chrome.storage.local.get !== 'function') {
      return Promise.resolve(PROACTIVE_THRESHOLDS);
    }
    try {
      return new Promise(function (resolve) {
        chrome.storage.local.get(['aiCmProactiveThresholds'], function (data) {
          try {
            var raw = (data && typeof data === 'object') ? data.aiCmProactiveThresholds : undefined;
            var t = normalizeProactiveThresholds(raw);
            if (!t && raw !== undefined) {
              try { console.warn('[AI CM][thresholds] битые aiCmProactiveThresholds → дефолт [70,85,95]', raw); } catch (eW) { }
            }
            resolve(t || PROACTIVE_THRESHOLDS);
          } catch (eInner) { resolve(PROACTIVE_THRESHOLDS); }
        });
      });
    } catch (e) { return Promise.resolve(PROACTIVE_THRESHOLDS); }
  }

  function pickProactiveThreshold(pct, firedSet, thresholds) {
    if (typeof pct !== 'number' || !isFinite(pct)) return null;
    var list = (thresholds && thresholds.length === 3) ? thresholds : PROACTIVE_THRESHOLDS;
    var t = null;
    for (var i = 0; i < list.length; i++) {
      var cand = list[i];
      if (pct >= cand && !(firedSet && typeof firedSet.has === 'function' && firedSet.has(cand))) {
        t = cand;
      }
    }
    return t;
  }

  // ---- v52: stream-ingest walkers (ходы из batchexecute генерации) ----
  // Источник — реальные фреймы wrb.fr из probe-логов:
  //   I4z33b — user turn:  [[[["me",1,["12345678901234567890", ...]]]]]  (id числовой, «постоянный»)
  //   Bsxleb — model turn: [null,null,[["c_example000000000002", ..., "rc_example000000000001"]]]
  //            (вариант с r_*: [null,null,[["c_example000000000001", ..., "r_example000000000001"...]]])
  // Alias: стрим сначала несёт rc_* (временный id), снапшот приносит r_* (постоянный).
  var STREAM_MSGID_RE = /^(rc_[0-9a-f]+|r_[0-9a-f]+)$/;
  var STREAM_TURNID_RE = /^c_[0-9a-f]+$/;
  var STREAM_NUMID_RE = /^[0-9]{10,}$/;
  var STREAM_ROLE_TOKENS = { me: 1, model: 1, user: 1, assistant: 1 };

  // Разбор batchexecute-сырца: строки, начинающиеся с '[', содержат фреймы wrb.fr.
  function streamParseFrames(raw) {
    var frames = [];
    try {
      var lines = String(raw).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (!ln || ln.charAt(0) !== '[') continue;
        var parsedLine;
        try { parsedLine = JSON.parse(ln); } catch (e) { continue; }
        if (!Array.isArray(parsedLine)) continue;
        for (var j = 0; j < parsedLine.length; j++) {
          var fr = parsedLine[j];
          if (!Array.isArray(fr) || fr[0] !== 'wrb.fr') continue;
          var rpcid = (typeof fr[1] === 'string') ? fr[1] : '';
          // innerJSON: классический расклад — fr[2]; допускаем длинную JSON-строку в fr[1]
          var inner = (fr[2] != null) ? fr[2] :
            ((typeof fr[1] === 'string' && fr[1].length > 1 && fr[1].charAt(0) === '[') ? fr[1] : null);
          var obj = null;
          if (typeof inner === 'string') { try { obj = JSON.parse(inner); } catch (e2) { obj = null; } }
          else obj = inner;
          frames.push({ rpcid: rpcid, obj: obj });
        }
      }
    } catch (e) { }
    return frames;
  }

  function streamLastFrame(raw, rpcids) {
    var frames = streamParseFrames(raw);
    for (var i = frames.length - 1; i >= 0; i--) {
      if (frames[i].obj != null && rpcids[frames[i].rpcid]) return frames[i];
    }
    return null;
  }

  function streamIsJunkStr(s) {
    if (typeof s !== 'string' || s.length === 0) return true;
    if (s.charAt(0) === '$') return true;                      // внутренние токены ($AVuibg и пр.)
    if (/^[0-9]+$/.test(s)) return true;                        // числа/таймстампы
    if (STREAM_MSGID_RE.test(s) || STREAM_TURNID_RE.test(s)) return true; // rc_/r_/c_-id
    if (/^(https?:\/\/|image\/|application\/|video\/|audio\/|text\/)/i.test(s)) return true;
    if (/\.(pdf|png|jpe?g|gif|docx?|txt|webp|csv|xlsx?)($|\?)/i.test(s)) return true;
    if (STREAM_ROLE_TOKENS[s]) return true;
    return false;
  }

  function streamCollectText(node, seen, out) {
    if (out.length > 80) return;
    if (typeof node === 'string') {
      if (!streamIsJunkStr(node) && node.length > 1 && !seen[node]) { seen[node] = 1; out.push(node); }
      return;
    }
    if (!Array.isArray(node)) return;
    for (var i = 0; i < node.length; i++) streamCollectText(node[i], seen, out);
  }

  // I4z33b: ход пользователя. Ищем узел-тройку с ролью 'me', id — первая строка-идентификатор
  // (числовой «постоянный» или c_/r_), текст — все не-junk строки в поддереве тройки.
  function extractStreamUserTurn(raw) {
    try {
      var fr = streamLastFrame(raw, { I4z33b: 1 });
      if (!fr) return null;
      var meNode = null;
      (function walk(n) {
        if (meNode || !Array.isArray(n)) return;
        if (n.length > 0 && n[0] === 'me') { meNode = n; return; }
        for (var i = 0; i < n.length; i++) { walk(n[i]); if (meNode) return; }
      })(fr.obj);
      if (!meNode) return null;
      var id = null;
      (function walkId(n) {
        if (id || Array.isArray(n)) {
          if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walkId(n[i]); if (id) return; } }
          return;
        }
        if (typeof n === 'string' && (STREAM_NUMID_RE.test(n) || STREAM_MSGID_RE.test(n) || STREAM_TURNID_RE.test(n))) id = n;
      })(meNode);
      if (!id) return null;
      var pieces = [];
      streamCollectText(meNode, {}, pieces);
      var text = pieces.join('\n').trim();
      if (!text) return null;
      return { role: 'me', id: id, turnId: null, text: text };
    } catch (e) { return null; }
  }

  // Bsxleb (и подобные): ход модели. Entry = массив с E[0]='c_<hex>'; id хода — последний
  // rc_*/r_* в поддереве entry, текст — не-junk строки entry.
  function extractStreamModelTurn(raw) {
    try {
      var fr = streamLastFrame(raw, { Bsxleb: 1 });
      if (!fr) return null;
      var entry = null;
      (function walk(n) {
        if (entry || !Array.isArray(n)) return;
        if (n.length > 0 && typeof n[0] === 'string' && STREAM_TURNID_RE.test(n[0])) { entry = n; return; }
        for (var i = 0; i < n.length; i++) { walk(n[i]); if (entry) return; }
      })(fr.obj);
      if (!entry) return null;
      var turnId = entry[0];
      var msgId = null;
      (function walkMsg(n) {
        if (!Array.isArray(n)) {
          if (typeof n === 'string' && STREAM_MSGID_RE.test(n)) msgId = n;
          return;
        }
        for (var i = 0; i < n.length; i++) walkMsg(n[i]);
      })(entry);
      if (!msgId) return null;
      var pieces = [];
      streamCollectText(entry, {}, pieces);
      var text = pieces.join('\n').trim();
      if (!text) return null;
      return { role: 'model', id: msgId, turnId: turnId, text: text };
    } catch (e) { return null; }
  }

  // v1.14.1 (FB-PROBE): fallback-top может объявлять полноту ТОЛЬКО при доступности
  // серверного probe (v73): нужны метаданные последнего history-запроса (at/baseUrl/headers)
  // И широкая экстракция курсора из последнего ответа. Без любого из них — false.
  function fallbackProbeReady(meta, wideCur) {
    return Boolean(meta && meta.atEncoded && meta.baseUrl && meta.headers && wideCur);
  }

  // ---- H9b (probe-retain): retained last-good метаданных probe (монотонное правило) ----
  // Единственный волатильный слот wide-курсора (lastPaginateOuter в core) перезаписывается
  // ОБОРВАННЫМ финальным шагом тихой пагинации (битая/терминальная страница без opaque-строк)
  // ровно тогда, когда нужен контрольный probe → wideCursor=no → probe умирает
  // (probeIncomplete 'no-wide-cursor' / fallback-top 'probe-unavailable'). Фикс: retained —
  // last-good (широкий курсор + метаданные запроса) фиксируется на ЗДОРОВОМ шаге и
  // подаётся ВХОДОМ в probe; источником complete retained НЕ является (решение — только
  // по ответу probe: probe-terminal). Правило — монотонное по образцу saveFloor:
  //   stepOk=false (сломанный шаг: added=0 без курсора) → keep prev (не перезаписывать);
  //   stepOk=true  (added>0 ИЛИ живой курсор)            → replace входящим снапшотом;
  // входящий снапшот без обязательных полей (atEncoded/baseUrl/headers) не принимается —
  // мусор не может опустить retained. prev/incoming — объекты { atEncoded, baseUrl, headers }
  // (core добавляет conv/ts-обвязку; функция их не читает и не трогает).
  function updateProbeMetaRetain(prev, incoming, stepOk) {
    if (!stepOk) return prev;
    if (!incoming || !incoming.atEncoded || !incoming.baseUrl || !incoming.headers) return prev;
    return incoming;
  }

  // ---- H10 (probe-terminal gate): пол авторитетнее ответа probe; pb-ошибка ≠ complete ----
  // probe-terminal (v73) объявляет complete строго по ответу контрольного probe:
  // newOlder=0 И широкий курсор не найден. e292 (floor=108, база усеклась до 80): probe
  // на ОКНЕ-ДУБЛЕ хвоста — сервер отдаёт то же окно 1..80, что уже в базе; новый контент
  // глубины 81..108 живёт ВНЕ hNvQHb-канала, а курсор продолжения лежит в turns (не в rest),
  // поэтому extractCursorWide (сканирует только rest) даёт cursorFound=no → ложный complete
  // на 80 при истинных 108. Пол (HWM из localStorage) авторитетнее ответа probe: база ниже
  // сохранённого пола → терминальный ответ недостоверен → block (лоадер-рестарт докрутит).
  // Отдельно: pb-ответ-ОШИБКА (error-страница Bard, битый-парс-путь) → complete по
  // не-данным запрещён (e292 это НЕ лечит — там данные; гейт закрывает сломанный парс).
  // state = { floorCount, baseCount, pbError }. Возвращает { block:true, reason } | null.
  function probeTerminalGate(state) {
    var floorCount = (state && typeof state.floorCount === 'number') ? state.floorCount : 0;
    var baseCount = (state && typeof state.baseCount === 'number') ? state.baseCount : 0;
    if (floorCount > 0 && baseCount < floorCount) {
      return { block: true, reason: 'below-floor-probe-terminal' };
    }
    if (state && state.pbError === true) {
      return { block: true, reason: 'pb-error-page' };
    }
    return null;
  }

  // ---- v1.14.2 (COLLAPSE-GUARD): коллапс скроллера ≠ физический верх ----
  // Баг 03.09 11:35: во время скрытого прогона Gemini схлопнул скроллер
  // (scrollHeight 100933→744), scrollTop стал ≤8px тривиально → done reason='top'
  // при base=80 < floor=124 → stable-stop оракул взвёл baseComplete на УСЕЧЁННОЙ базе.
  // Признак коллапса: высота упала значительно ниже максимума прогона (floor порог
  // 3000px отсекает фоновые перерисовки), при этом база не добрала сохранённый пол.
  function collapseGuardVerdict(state) {
    var h = (state && typeof state.scrollH === 'number') ? state.scrollH : 0;
    var maxSeen = (state && typeof state.maxScrollHSeen === 'number') ? state.maxScrollHSeen : 0;
    var baseCount = (state && typeof state.baseCount === 'number') ? state.baseCount : 0;
    var floorCount = (state && typeof state.floorCount === 'number') ? state.floorCount : 0;
    if (h < Math.max(3000, maxSeen * 0.5) && baseCount < floorCount) {
      return { collapsed: true };
    }
    return { collapsed: false };
  }

  // ---- H9 (untrusted-top): первый визит без пола (floor=0), тихая пагинация оборвалась ----
  // Лоадер на схлопнутом/пустом скроллере (высота не росла) при наличии курсора в истории
  // даёт doneReason='top' ложно: scrollTop<=8 тривиален, реального верха нет, а collapse-guard
  // при floor=0 молчит (он требует baseCount<floorCount, floor=0 => никогда). Признак:
  // floor=0 И курсор в истории был (hadCursor) И скроллер за прогон не вырос (no-growth,
  // maxScrollHSeen не превысил вьюпорт+400) => физический верх НЕ подтверждён.
  // state = { floorCount, hadCursor, anyGrowth, maxScrollHSeen, viewportH }.
  // Возвращает { untrusted: true, reason } при недостоверном top, иначе null.
  function untrustedTopVerdict(state) {
    var floorCount = (state && typeof state.floorCount === 'number') ? state.floorCount : 0;
    var hadCursor = !!(state && state.hadCursor);
    var anyGrowth = !!(state && state.anyGrowth);
    var maxSeen = (state && typeof state.maxScrollHSeen === 'number') ? state.maxScrollHSeen : 0;
    var viewportH = (state && typeof state.viewportH === 'number') ? state.viewportH : 0;
    if (floorCount === 0 && hadCursor && !anyGrowth &&
        maxSeen <= ((viewportH || 700) + 400)) {
      return { untrusted: true, reason: 'no-floor-no-growth' };
    }
    return null;
  }

  // ---- H9 (last-step-broken): оборвавшийся ФИНАЛЬНЫЙ шаг тихой пагинации ----
  // added=0, курсора продолжения нет, но при этом страница либо НЕ распарсилась (скелет),
  // либо в её хвосте/ходах НЕТ ни одного opaque-кандидата (курсор не найден). Такой шаг —
  // циркулярная последняя «живая» страница: её serverFirstHash нельзя использовать как
  // независимое подтверждение scroll-top-proof. state = { added, nextCursor,
  // failedSkeleton, opaqueCandidates }. Возвращает true при «шаг сломан».
  function pagStepBroken(state) {
    // state обязан быть измеренным шагом (added — число). null/{} — не шаг → false.
    if (!state || typeof state.added !== 'number') return false;
    var added = state.added;
    var nextCursor = !!(state.nextCursor);
    var failedSkeleton = !!(state.failedSkeleton);
    var opaqueCandidates = (state && typeof state.opaqueCandidates === 'number') ? state.opaqueCandidates : 0;
    if (added === 0 && !nextCursor && (failedSkeleton || opaqueCandidates === 0)) {
      return true;
    }
    return false;
  }

  // v1.14.1 (SHRINK-GUARD): решение о замещении restored-хода сетевым ходом того же id.
  // Ответы сервера для старых чатов бывают обрезанными («РЕНТГЕН ОБОРВАВШЕГО ШАГА»),
  // и безгардовое замещение сжимало базу (textLen 147811→124495 при том же числе ходов).
  // Входящий текст короче → restored-текст сохраняется, дозаполняются только r1/turnId.
  function decideRestoredMerge(prev, incoming) {
    var oldLen = ((prev && prev.text) || '').length;
    var newLen = ((incoming && incoming.text) || '').length;
    if (newLen >= oldLen) return { replace: true, r1: null, turnId: null };
    return {
      replace: false,
      r1: prev && !prev.r1 && incoming && incoming.r1 ? incoming.r1 : null,
      turnId: prev && !prev.turnId && incoming && incoming.turnId ? incoming.turnId : null
    };
  }

  // ---- v1.15 (BUG «холодное открытие без полной истории»): распознавание ОШИБКИ-страницы ----
  // Gemini (batchexecute hNvQHb) иногда отвечает на запрос окна истории НЕ данными, а
  // ошибкой: inner (outer[0][2]) не является строкой, а в метаданных wrb-блока лежит
  // протобуф `type.googleapis.com/assistant.boq.bard.application.BardErrorInfo` (наблюдался
  // code 1177 — «повторите позже»). Легитимная страница ВСЕГДА несёт inner-строку с
  // JSON-массивом ходов (в т.ч. терминальная «[[],[],[],[]]»). Ошибку НЕЛЬЗЯ трактовать
  // как «старших страниц больше нет»: континуационный курсор прошлого окна жив, и шаг
  // пагинации нужно повторить (см. paginateErrorRetryDecision / paginateLoop в core).
  // outer — первый массив ответа [[["wrb.fr","hNvQHb",<inner>,...],...],...].
  function isBardErrorPage(outer) {
    try {
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return false;
      var inner = outer[0][2];
      if (typeof inner === 'string') {
        // inner-строка есть — страница данных. Маркеры ошибки могли остаться в метаданных
        // (индексы != 2), но такие страницы парсер всё равно обрабатывает как данные.
        // Для защиты от «ошибки со строковым inner» дополнительно проверяем метаданные.
        try {
          var metaS = '';
          var a0m = outer[0];
          for (var mi = 3; mi < a0m.length && metaS.length < 4000; mi++) {
            try { metaS += JSON.stringify(a0m[mi]); } catch (e) { }
          }
          if (metaS.indexOf('type.googleapis.com') !== -1 ||
              metaS.indexOf('BardErrorInfo') !== -1) return true;
        } catch (e) { }
        return false;
      }
      // inner не строка (null/объект/число): wrb вернул не-данные. Считаем ошибкой-страницей
      // всегда — это согласуется с наблюдаемыми ответами (inner=null при BardErrorInfo).
      return true;
    } catch (e) { return false; }
  }

  // v1.15: решение о повторном запросе окна после ошибки-страницы. state = {
  //   errPage: boolean,  // последняя страница — ошибка Bard (не данные)
  //   hasCursor: bool,   // в ответе найден курсор продолжения (тогда ошибки нет смысла)
  //   added: number,     // ходов добавил ответ (ошибка => 0)
  //   retries: number    // сколько ретраев этого окна уже выполнено (0..N)
  // }. Возвращает { retry, backoffMs } — ретраить окно с растущей паузой, не более 3 раз.
  function paginateErrorRetryDecision(state) {
    var cap = 3;
    var errPage = !!(state && state.errPage === true);
    var hasCursor = !!(state && state.hasCursor);
    var added = (state && typeof state.added === 'number') ? state.added : 0;
    var retries = (state && typeof state.retries === 'number') ? state.retries : 0;
    if (errPage && !hasCursor && added === 0 && retries < cap) {
      return { retry: true, backoffMs: 2000 * (retries + 1) };
    }
    return { retry: false, backoffMs: 0 };
  }

  // ---- v1.16 (1177-BYPASS): эскалация на нативный скрытый скролл после исчерпания ретраев ----
  // Сервер Gemini отвечает на запросы СТАРЫХ окон ошибкой Bard (code 1177 «повторите позже»),
  // когда тихий цикл тянет глубокие окна слишком быстро/серийно (троттлинг) либо токен окна
  // перестал приниматься в этом контексте. Ретрай того же окна (paginateErrorRetryDecision)
  // ограничен; после исчерпания НЕЛЬЗЯ трактовать шаг как «старших страниц больше нет»:
  // вместо продолжения сломанной цепочки — эскалация на НАТИВНЫЙ скрытый скролл лоадера
  // (loadFullHistoryInvisibly): сам сайт Gemini запрашивает старшие окна своими токенами и в
  // человеческом темпе (scrollTop=0 + синтетический scroll под оверлеем), их ответы приходят
  // как src=passive и сливаются в базу. Это «обход 1177» без знания внутреннего формата окна.
  // state = { errPage, hasCursor, added, retries, cap, loaderRunning, nativeEscalationUsed }.
  // Возвращает { escalate, reason }:
  //   - escalate=true, reason='err1177-exhausted' → немедленный рестарт лоадера;
  //   - escalate=false — причиной (not-ready / loader-running / native-escalation-used) →
  //     тихий цикл завершается as-is (никаких вечных циклов: на один чат эскалация 1 раз).
  function paginateErrorEscalation(state) {
    state = state || {};
    var cap = (state && typeof state.cap === 'number' && state.cap > 0) ? state.cap : 3;
    var errPage = !!(state && state.errPage === true);
    var hasCursor = !!(state && state.hasCursor);
    var added = (state && typeof state.added === 'number') ? state.added : 0;
    var retries = (state && typeof state.retries === 'number') ? state.retries : 0;
    if (!errPage || hasCursor || added > 0) return { escalate: false, reason: 'not-ready' };
    if (retries < cap) return { escalate: false, reason: 'retry-budget-alive' };
    if (state && state.loaderRunning) return { escalate: false, reason: 'loader-running' };
    if (state && state.nativeEscalationUsed) return { escalate: false, reason: 'native-escalation-used' };
    return { escalate: true, reason: 'err1177-exhausted' };
  }

  // ---- v1.16 (1177-PACE): пауза между окнами после серии ошибок-страниц ----
  // 1177-ошибки наблюдались при серийных запросах старых окон встык (троттлинг). В штатном
  // режиме (errSeen=false) пауза НЕ вводится — поведение рабочей цепочки не меняется; после
  // ошибки-страницы темп снижается (1200мс + глубина), чтобы не раздражать сервер дальше.
  // depth — номер окна от хвоста (0 = первое продолжение), errSeen — была ли в этом прогоне
  // ошибка-страница. Возвращает задержку в мс перед следующим запросом окна (0 = без паузы).
  function paginatePaceDelayMs(depth, errSeen) {
    if (!errSeen) return 0;
    var d = (typeof depth === 'number' && depth > 0) ? depth : 0;
    return 1200 + Math.min(d, 8) * 75;
  }

  // ---- H13 (inner-cursor): opaque-экстракция континуационного курсора глубоких окон ----
  // e292 (контрольный probe на окне-ДУБЛЕ хвоста): курсор продолжения глубины 81..108 живёт
  // ВНУТРИ inner (outer[0][2] → JSON.parse → turns[1]) и имеет длину 705 (окно 81..100) /
  // 849 (окно 101..108). Старый потолок classifyOpaque 600 давал ложный negative
  // (extractCursor=null — узкий путь не видел токен), а extractCursorWide сканировала только
  // rest (outer[0].slice(3)) и inner не читала вовсе → probe получал «0 новых ходов + курсора
  // нет» по ответу, НЁСШЕМУ живой курсор продолжения, и объявлял терминальный complete на
  // усечённой базе (80 при истинных 108, floor=0 → гейт probeTerminalGate молчит).
  // Фикс: потолок 600→2000 (токены 705/849 реальны; фильтры мусора — image/png-строки,
  // не-b64 — сохранены); extractCursorWide читает inner-зону ПЕРВОЙ, затем rest, и берёт
  // ДЛИННЕЙШИЙ b64-кандидат (при равенстве — первый в порядке зон inner→rest).

  // ---- H15 (hex-marker): короткие hex-маркеры НЕ opaque ----
  // e292: probe-ответ несёт в inner (turns[1]) служебный hex-маркер 16 символов
  // (только [0-9a-fA-F]), который НЕ является континуационным токеном. Реальные токены
  // (705/849) несут полный b64-алфавит (A-Za-z0-9+/=); hex-подмножество [0-9a-fA-F] ⊂
  // b64-алфавита, поэтому regex-проверка b64 их ПРОПУСКАЛА, и classifyOpaqueWide
  // (8..2000 → true) классифицировал 16-символьный hex-маркер как opaque → ложный
  // cursorFound=yes → бесконечный цикл probe-non-terminal. Правило: строка из ТОЛЬКО
  // hex-символов длиной < 40 → false. Длинные hex-строки (>= 40) — вне маркерного
  // диапазона, классифицируются как прежде.
  function isShortHexMarker(s) {
    if (typeof s !== 'string') return false;
    if (s.length >= 40) return false;
    return /^[0-9a-fA-F]+$/.test(s);
  }
  function classifyOpaque(s) {
    if (typeof s !== 'string') return false;
    if (s.length < 40 || s.length > 2000) return false;
    if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(s)) return false;
    if (isShortHexMarker(s)) return false; // H15: страж <40 уже покрыт порогом, правило документировано
    if (s.indexOf('$AVuibg') === 0) return false;
    return true;
  }
  // ---- H17 (mime-garbage): MIME-типы вложений НЕ opaque; нижняя граница wide 8→16 ----
  // H16-диагностика (e292, терминальный шаг тихой пагинации): inner-зона (turns)
  // probe-ответа несёт MIME-тип вложений ("image/png", len=9): '/' допустим в
  // b64-алфавите, длина попадала в старый диапазон 8..2000 → classifyOpaqueWide давал
  // true → wide-курсор = MIME-мусор, cursorFound=yes на ответе БЕЗ курсора
  // продолжения (lastPaginateOuter не обновлялся) → бесконечный цикл
  // probe-non-terminal. Реальные токены (705/849) MIME-префиксов не несут. Правила:
  // (1) строка с MIME-префиксом (image|video|audio|application|text + '/') → false —
  //     "application/json" (len=16) ДЛИННЕЕ новой нижней границы, префикс обязателен;
  // (2) нижняя граница 8→16: короткий b64-подобный мусор 8..15 (MIME len=9..15,
  //     обрывки) → false. Реальные токены 705/849 и hex-маркеры 16..39 (H15) не задеты.
  function startsWithMimeType(s) {
    return s.indexOf('image/') === 0 || s.indexOf('video/') === 0 ||
      s.indexOf('audio/') === 0 || s.indexOf('application/') === 0 ||
      s.indexOf('text/') === 0;
  }
  // Широкий классификатор (16..2000, '=' допустим в любой позиции) — для rest-метаданных
  // и для строк inner-зоны при wide-экстракции.
  function classifyOpaqueWide(s) {
    if (typeof s !== 'string') return false;
    if (s.length < 16 || s.length > 2000) return false; // H17: 8→16 (MIME len=9..15 → false)
    if (!/^[A-Za-z0-9+/=]+$/.test(s)) return false;
    if (isShortHexMarker(s)) return false; // H15: hex-маркеры 16..39 → false
    if (s.indexOf('$AVuibg') === 0) return false;
    if (startsWithMimeType(s)) return false; // H17: MIME-мусор (image/… text/…) → false
    return true;
  }
  // Узкая экстракция из parsed-inner (turns): opaque-кандидаты по всему поддереву turns
  // (включая turns[1] — слот континуационного токена), приоритет — длиннейший; при
  // равенстве длин — последний в порядке обхода (как было до H13).
  function extractCursor(turns) {
    var c = [];
    (function collect(n) {
      if (c.length > 8) return;
      if (typeof n === 'string') { if (classifyOpaque(n)) c.push(n); return; }
      if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) collect(n[i]); }
    })(turns);
    if (!c.length) return null;
    var best = c[c.length - 1];
    for (var j = 0; j < c.length; j++) { if (c[j].length > best.length) best = c[j]; }
    return best;
  }
  // Широкая экстракция из outer hNvQHb-ответа. Зона 1 — inner: outer[0][2] строка →
  // JSON.parse → массив (turns; слот курсора turns[1]). Зона 2 — rest: outer[0].slice(3).
  // Приоритет — длиннейший кандидат, прошедший classifyOpaqueWide; зоны обходятся
  // inner→rest (при равенстве длин выигрывает найденный раньше — из inner).
  function extractCursorWide(outer) {
    var best = null;
    function scanWideZone(zone) {
      (function walkW(n) {
        if (typeof n === 'string') {
          if (classifyOpaqueWide(n) && (!best || n.length > best.length)) best = n;
          return;
        }
        if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) walkW(n[i]); }
      })(zone);
    }
    try {
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return null;
      var innerParsed = null;
      try {
        var innerStr = outer[0][2];
        if (typeof innerStr === 'string') {
          var parsedInner = JSON.parse(innerStr);
          if (Array.isArray(parsedInner)) innerParsed = parsedInner;
        }
      } catch (eH13In) { innerParsed = null; }
      if (innerParsed) scanWideZone(innerParsed);
      scanWideZone(outer[0].slice(3));
      return best;
    } catch (eH13) { return null; }
  }

  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (импорт) ============
  // Архив — независимо полученная (вне сессии/вне сети) полная история чата.
  // Он даёт: (1) same-conv-union ходов по id/контенту, (2) авторитетный для пола
  // count, (3) ЛЕГИТИМНЫЙ терминальный источник полноты archive-complete.
  //
  // ИНВАРИАНТЫ (H9/H10 НЕ ослабляются):
  //   - archive-complete НЕ обходит H9-гейты (untrustedTopVerdict / pagStepBroken)
  //     и H10-гейт пола: они остаются авторитетными для СВОИХ путей. Вердикт
  //     архива — ДОПОЛНИТЕЛЬНАЯ точка complete со своими гейтами (convId, count,
  //     пол), а не замена существующих.
  //   - Пол монотонен вверх: архив поднимает пол, но НИКОГДА не опускает его
  //     (high-water-mark). Архив меньше сохранённого пола → пол остаётся прежним.
  //   - Принимается только архив СВОЕГО convId (чужой чат — reason=conv-mismatch).

  // Ключ контента хода: роль + схлопнутый текст. Нужен как вторичный ключ
  // дедупа (id архива и id живого хода одного и того же сообщения не совпадают).
  function archiveContentKey(m) {
    var role = (m && m.role === 'user') ? 'user' : 'assistant';
    var text = String((m && (m.text != null ? m.text : m.content)) || '').replace(/\s+/g, ' ').trim();
    return role + '\u0000' + text;
  }

  // Детерминированный id архивного хода (фолбэк, если архив не дал id).
  function archiveTurnId(m, index) {
    if (m && m.id != null && String(m.id)) return String(m.id);
    var s = archiveContentKey(m);
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    var hex = (h >>> 0).toString(16);
    while (hex.length < 6) hex = '0' + hex;
    return 'a:' + index + ':' + hex.slice(-6);
  }

  /**
   * same-conv-union архивных ходов с текущей базой.
   * Возвращает ТОЛЬКО добавляемые ходы (в формате turnsMap-элементов) с
   * отрицательным order —所以他们 встают ПЕРЕД хвостовым окном сети (архив =
   * старшая история). r1=null: порядок пересчитает chain-r1 (как у tape-restore),
   * повёрнутый порядок архива не наследуется.
   *
   * @param {Array} networkItems — текущие элементы базы
   * @param {Array} archiveMessages — нормализованные архивные ходы ({id,role,text})
   * @returns {{items:Array, addedCount:number, duplicateCount:number}}
   */
  function archiveMergeTurns(networkItems, archiveMessages) {
    var net = Array.isArray(networkItems) ? networkItems : [];
    var arch = Array.isArray(archiveMessages) ? archiveMessages : [];
    var seenIds = {};
    var seenKeys = {};
    var i, it;
    for (i = 0; i < net.length; i++) {
      it = net[i];
      if (!it) continue;
      if (it.id != null) seenIds[String(it.id)] = true;
      var kNet = archiveContentKey(it);
      if (kNet !== 'assistant\u0000' && kNet !== 'user\u0000') seenKeys[kNet] = true;
    }
    var items = [];
    var duplicateCount = 0;
    for (i = 0; i < arch.length; i++) {
      var m = arch[i];
      if (!m) continue;
      var key = archiveContentKey(m);
      if (key === 'assistant\u0000' || key === 'user\u0000') continue; // пустой текст — не ход
      var id = archiveTurnId(m, i);
      if (seenIds[id] || seenKeys[key]) { duplicateCount++; continue; }
      seenIds[id] = true;
      seenKeys[key] = true;
      items.push({
        id: id,
        turnId: id,
        r1: null,                                   // порядок архива не наследуем
        order: i - (arch.length + 1),               // старший сегмент → в начало экспорта
        role: (m.role === 'user') ? 'user' : 'assistant',
        text: String(m.text == null ? '' : m.text)
      });
    }
    return { items: items, addedCount: items.length, duplicateCount: duplicateCount };
  }

  /**
   * Архивный count АВТОРИТЕТЕН для пола: пол поднимается до max(прежний, архивный),
   * понижение запрещено (HWM). Возвращает запись для записи пола или null, когда
   * менять нечего (архив не выше прежнего пола / оба пусты).
   */
  function archiveFloorRecord(existingFloor, archiveCount, archiveTextLen) {
    var prevCount = (existingFloor && typeof existingFloor.count === 'number' && existingFloor.count > 0) ? existingFloor.count : 0;
    var prevLen = (existingFloor && typeof existingFloor.effectiveLen === 'number' && existingFloor.effectiveLen > 0) ? existingFloor.effectiveLen : 0;
    var archCount = (typeof archiveCount === 'number' && archiveCount > 0) ? archiveCount : 0;
    var archLen = (typeof archiveTextLen === 'number' && archiveTextLen > 0) ? archiveTextLen : 0;
    var count = Math.max(prevCount, archCount);
    var len = Math.max(prevLen, archLen);
    if (!count && !len) return null;
    if (count <= prevCount && len <= prevLen) return null; // монотонность: понижать нельзя
    return { count: count, effectiveLen: len, source: 'archive' };
  }

  /**
   * Терминальный вердикт первого яруса. complete=true ТОЛЬКО при:
   *   - архиве ИМЕННО текущего convId,
   *   - непустом архиве,
   *   - базе, доросшей до архивного count (архив = независимое доказательство
   *     полноты; недоросшая база — below-archive-count),
   *   - базе не ниже пола (H10-инвариант «пол авторитетнее ответа»),
   *   - T1-fix (v1.16.1, снимок o.live): ЖИВОЙ ярус предъявил доказательства —
   *     прогон лоадера отработал (loaderDone) либо база подтверждённо выросла
   *     сверх архива (grewBeyondArchive), И живая загрузка не идёт сейчас
   *     (loaderRunning / active).
   *
   * ПОЧЕМУ ЭТОТ ГЕЙТ НУЖЕН. Архивные ходы вливаются в ТУ ЖЕ базу (same-conv-union),
   * поэтому baseCount включает вклад самого архива: «база доросла до архивного count»
   * на пустом ещё живом ярусе выполняется АВТОМАТИЧЕСКИ (baseCount === archiveCount —
   * это ровно архивные ходы). Полнота в этот момент была бы объявлена по вкладу
   * архива, а не по догруженной живой истории → автоэкспорт ушёл бы с одной лишь
   * архивной частью (живой хвост ещё не пришёл). Отсюда: база считается доросшей
   * ТОЛЬКО на доказательствах живого яруса.
   *
   * o.live НЕ передан → вердикт работает в прежнем (T1) режиме — совместимость
   * вызовов, которые снимок живого яруса не передают.
   * Иначе — { complete:false, reason } и путь остаётся за существующими гейтами.
   */
  function archiveCompleteVerdict(opts) {
    var o = opts || {};
    var archConv = String(o.archiveConvId || '');
    var curConv = String(o.currentConvId || '');
    var archiveCount = (typeof o.archiveCount === 'number' && o.archiveCount > 0) ? o.archiveCount : 0;
    var baseCount = (typeof o.baseCount === 'number' && o.baseCount > 0) ? o.baseCount : 0;
    var floorCount = (typeof o.floorCount === 'number' && o.floorCount > 0) ? o.floorCount : 0;
    var live = (o.live && typeof o.live === 'object') ? o.live : null;
    if (!archConv) return { complete: false, reason: 'no-archive' };
    if (!curConv) return { complete: false, reason: 'no-conv' };
    if (archConv !== curConv) return { complete: false, reason: 'conv-mismatch' };
    if (!archiveCount) return { complete: false, reason: 'archive-empty' };
    // (1) живой лоадер бежит ПРЯМО СЕЙЧАС по этому чату — полноту за него не объявляем.
    if (live && live.loaderRunning === true) return { complete: false, reason: 'loader-running' };
    if (baseCount < archiveCount) return { complete: false, reason: 'below-archive-count' };
    if (live) {
      // (2) база не выросла сверх архива И прогон лоадера ещё не отработал:
      //     baseCount === archiveCount здесь — вклад САМОГО архива, а не доказательство
      //     догруженной живой истории. Ждём loaderDoneMap либо реального роста базы.
      if (live.loaderDone !== true && live.grewBeyondArchive !== true) {
        return { complete: false, reason: 'live-loader-pending' };
      }
      // (4) живая история ещё догружается (тихий цикл/пагинация) — ждём её конца,
      //     иначе объявленная полнота оборвала бы живую догрузку на середине.
      if (live.active === true) return { complete: false, reason: 'live-loading' };
    }
    if (floorCount > 0 && baseCount < floorCount) return { complete: false, reason: 'below-floor' };
    return { complete: true, reason: 'archive-complete' };
  }

  var api = {
    floorStorageKey: floorStorageKey,
    archiveContentKey: archiveContentKey,
    archiveMergeTurns: archiveMergeTurns,
    archiveFloorRecord: archiveFloorRecord,
    archiveCompleteVerdict: archiveCompleteVerdict,
    PROACTIVE_THRESHOLDS: PROACTIVE_THRESHOLDS,
    normalizeProactiveThresholds: normalizeProactiveThresholds,
    getProactiveThresholds: getProactiveThresholds,
    pickProactiveThreshold: pickProactiveThreshold,
    tapeStorageKey: tapeStorageKey,
    tapeVersionOf: tapeVersionOf,
    shouldAcceptTape: shouldAcceptTape,
    loadFloor: loadFloor,
    saveFloor: saveFloor,
    resolveFloor: resolveFloor,
    diagnoseFloorAbsence: diagnoseFloorAbsence,
    shouldSaveFloor: shouldSaveFloor,
    selfHealFloorVerdict: selfHealFloorVerdict,
    writeSelfHealedFloor: writeSelfHealedFloor,
    shouldFullRebuild: shouldFullRebuild,
    shouldDisjointReset: shouldDisjointReset,
    assignPageOrders: assignPageOrders,
    orderPages: orderPages,
    reverseRawTurnPage: reverseRawTurnPage,
    orderPageByR1: orderPageByR1,
    orderRestoredTape: orderRestoredTape,
    countR1Inversions: countR1Inversions,
    orderByArrival: orderByArrival,
    orderByR1Chain: orderByR1Chain,
    orderExportMessages: orderExportMessages,
    shouldBypassCacheComplete: shouldBypassCacheComplete,
    shouldHideScroller: shouldHideScroller,
    mergeRestoredTurns: mergeRestoredTurns,
    isProtobufSkeleton: isProtobufSkeleton,
    effectiveReachedStart: effectiveReachedStart,
    shouldMergeRestoredTurns: shouldMergeRestoredTurns,
    canConfirmByScroll: canConfirmByScroll,
    paginateStepDecision: paginateStepDecision,
    resetPaginationCounters: resetPaginationCounters,
    completenessOracle: completenessOracle,
    DEFAULT_PAGINATE_PAGE_CAP: DEFAULT_PAGINATE_PAGE_CAP,
    DEFAULT_PAGINATE_TIME_CAP_MS: DEFAULT_PAGINATE_TIME_CAP_MS,
    sanitizeFinalMessages: sanitizeFinalMessages,
    newDomReadiness: newDomReadiness,
    advanceReadiness: advanceReadiness,
    shouldRetryAutoscroll: shouldRetryAutoscroll,
    shouldPollVf5: shouldPollVf5,
    detectTrimState: detectTrimState,
    extractStreamUserTurn: extractStreamUserTurn,
    extractStreamModelTurn: extractStreamModelTurn,
    fallbackProbeReady: fallbackProbeReady,
    updateProbeMetaRetain: updateProbeMetaRetain,
    probeTerminalGate: probeTerminalGate,
    collapseGuardVerdict: collapseGuardVerdict,
    untrustedTopVerdict: untrustedTopVerdict,
    pagStepBroken: pagStepBroken,
    isBardErrorPage: isBardErrorPage,
    paginateErrorRetryDecision: paginateErrorRetryDecision,
    paginateErrorEscalation: paginateErrorEscalation,
    paginatePaceDelayMs: paginatePaceDelayMs,
    classifyOpaque: classifyOpaque,
    classifyOpaqueWide: classifyOpaqueWide,
    extractCursor: extractCursor,
    extractCursorWide: extractCursorWide,
    decideRestoredMerge: decideRestoredMerge
  };

  if (typeof window !== 'undefined') {
    window.GeminiInterceptLogic = api;
  }
  // MV3 Service Worker / воркеры: глобальный объект — self (window отсутствует).
  if (typeof self !== 'undefined') {
    self.GeminiInterceptLogic = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();