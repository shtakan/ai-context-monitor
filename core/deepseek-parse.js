// =============================================================================
// core/deepseek-parse.js — Step D.4 (декомпозиция core/deepseek-intercept.js).
// K3+K4: ЦЕПОЧКА + ТЕКСТ ХОДА + MODEL-ХЕЛПЕР — СЕКЦИЯ 5 (getModelSlug: slug модели хода
// по сетевым сигналам K0 с фолбэком по thinking_enabled), СЕКЦИЯ 6 (buildActiveChain:
// walk по parent_id, ловушка №1), СЕКЦИЯ 7 (collectTurnText / collectTurnReasoning /
// composeTurnText: сборка текста хода по type фрагментов, а не по их порядку) и
// hidden-пометки базы (DS_PP_VISIBLE_MARKER + hasInjectedUserPrompt, v13/O-7).
//
// Кластер вынесен по образцу шагов D.1 (core/deepseek-diag.js), D.2
// (core/deepseek-netsync.js) и D.3 (core/deepseek-refetch.js). Раньше все части жили в
// ОДНОМ IIFE, поэтому кластер обращался к состоянию ядра по именам. Теперь у модуля свой
// IIFE, и зависимости ядра приходят через __bind(deps).
//
// РАЗДЕЛЕНИЕ ПО SCOPE. Тела перенесены БАЙТ-В-БАЙТ и без префиксов D., но лежат в
// ДВУХ зонах:
//   • PURE-зона (этот IIFE, до __bind) — тела, которым ядро НЕ нужно: buildActiveChain
//     (обход parent_id по переданным аргументам), collectTurnText и collectTurnReasoning
//     (проход по фрагментам хода) и hasInjectedUserPrompt (поиск маркера в строке) —
//     плюс константы кластера REASONING_TAG/ANSWER_TAG, переехавшие из СЕКЦИИ 1 ядра.
//   • BIND-зона ('with (D) { … }' внутри __bind) — тела, читающие ядро: getModelSlug
//     (зовёт K0-резолвер __aiCmDeepseekResolveModelSlug) и composeTurnText (гейт
//     REASONING_ENABLED).
// ПОЧЕМУ ТАК: внутри with каждый свободный идентификатор резолвится ДИНАМИЧЕСКИ
// (ES3 Annex B) — урок D.1: горячий цикл FNV-хеша в with деградирует ~ в 40 раз
// (200×200 КБ: 81 мс вне with против 3309 мс в with). В K3/K4 критерий тот же, что и в
// D.1: три тела работают в ГОРЯЧИХ циклах (buildActiveChain — обход всех ходов чата на
// каждом ingest истории, collectTurnText/collectTurnReasoning — проход по всем фрагментам
// хода на каждой финализации потока), поэтому они лежат В PURE, вне with. В BIND остались
// ровно два тела, которые действительно читают ядро, и оба зовутся один раз на ход
// (композиция текста хода), а не на фрагмент. Байтовая идентичность тел сохранена в
// обеих зонах.
//
// КОНСТАНТЫ. REASONING_TAG/ANSWER_TAG уехали В МОДУЛЬ целиком: их читает только
// composeTurnText, и после выноса в ядре не осталось ни одного обращения к ним (пин
// tests/adapters/deepseek-o17-spa-chat.test.js ищет литералы в КОНКАТЕНАЦИИ js[] —
// tests/helpers/deepseek-intercept-source.js — и видит их здесь). REASONING_ENABLED
// ОСТАЛСЯ В ЯДРЕ: его читают оставшиеся секции (приём снимка истории и SSE-финализация —
// K5/K7) и он входит в контракт диагностики D.1 ro-геттером; модуль получает его
// ro-геттером и видит ТУ ЖЕ переменную ядра, а не копию значения. DS_PP_VISIBLE_MARKER
// переехал вместе с hasInjectedUserPrompt — других читателей у маркера нет.
//
// СОСТОЯНИЕ: у кластера его нет вовсе (K3/K4 — чистые функции: аргументы на входе,
// значение на выходе), поэтому в контракте нет ни fn-передач, ни rw-пар: только два
// ro-геттера (REASONING_ENABLED и __aiCmDeepseekResolveModelSlug — K0, чистый резолвер
// slug, объявленный ВНЕ IIFE ядра и остающийся там). Ни одного rw-пересечения с ядром у
// модуля нет: писать ему нечего.
//
// Порядок подключения (core/background.js, registerSafe 'ai-cm-deepseek-intercept-v6',
// document_start, world MAIN): utils/debug.js -> core/deepseek-diag.js ->
// core/deepseek-netsync.js -> core/deepseek-refetch.js -> ЭТОТ ФАЙЛ ->
// core/deepseek-intercept.js. До связки на window.AiCmDeepseekParse лежит только __bind;
// после связки ядро раздаёт ВСЕ 6 тел форвардерами по прежним именам (buildActiveChain,
// collectTurnText, collectTurnReasoning, composeTurnText, hasInjectedUserPrompt,
// getModelSlug — function declaration, хойстятся: вызовы в ingestHistory, композиции ходов
// и SSE-финализации выше по файлу не тронуты).
// Экспорт: window.AiCmDeepseekParse + module.exports.
// =============================================================================

(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekParse) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ---- PURE-зона: тела без зависимости от ядра; состояние модуля отсутствует ----
  // ---- Константы кластера: переехали из СЕКЦИИ 1 ядра (K4, Step D.4) ----
  // Их читает только composeTurnText (BIND-зона): внутри with имя, которого нет в D,
  // резолвится в скоуп этого IIFE. REASONING_ENABLED остался в ядре и приходит ro-геттером.
  var REASONING_TAG = '[REASONING]';
  var ANSWER_TAG = '[ANSWER]';

  // ===== СЕКЦИЯ 6: АКТИВНАЯ ЦЕПОЧКА (walk по parent_id, ловушка №1) =====
  // v6: возвращает { chain, truncated }
  //   - truncated = false: дошли до корня (parent_id === null/undefined) — норма
  //   - truncated = true: walk остановился, потому что следующий parent_id не null,
  //     но сообщения с таким id нет в messagesById — цепочка оборвана (усечение)
  function buildActiveChain(chatSession, messagesById) {
    var chain = [];
    var currentId = chatSession.current_message_id;
    var visited = {};
    var truncated = false;
    // v7: reachedRoot — true, когда обход довёл цепочку до корня (узел без parent_id),
    // т.е. цикл завершился по исчерпанию parent_id, а не по обрыву/циклу/пустой цепочке
    var reachedRoot = false;
    while (currentId != null && currentId !== undefined) {
      var msg = messagesById[currentId];
      if (!msg) {
        // parent_id не null, но сообщение отсутствует в полученном chat_messages → усечение
        truncated = true;
        break;
      }
      if (visited[currentId]) break;   // защита от циклов
      visited[currentId] = true;
      chain.push(msg);
      currentId = msg.parent_id;
    }
    reachedRoot = !truncated && chain.length > 0 && (currentId == null || currentId === undefined);
    chain.reverse();
    // v7: sort по inserted_at УБРАН. WHY:
    //  (1) inserted_at — ISO-строка ('2026-08-29T..Z'), вычитание строк даёт NaN →
    //      компаратор недетерминирован, порядок зависит от реализации sort;
    //  (2) внутри пары (user,assistant одного хода) серверный inserted_at ставит
    //      assistant РАНЬШЕ user → сортировка ИНВЕРТИРУЕТ пару (a,u,a,u вместо u,a,u,a).
    //  Единственный источник хронологии — обход parent_id + chain.reverse() выше.
    return { chain: chain, truncated: truncated, reachedRoot: reachedRoot };
  }

  // ===== СЕКЦИЯ 7: СБОР ТЕКСТА ХОДА (по type, не по порядку фрагментов) =====
  // v8: ответ хода — ТОЛЬКО фрагменты RESPONSE; THINK собирается отдельно (collectTurnReasoning).
  function collectTurnText(fragments, role) {
    var types = (role === 'USER') ? ['REQUEST'] : ['RESPONSE'];
    var parts = [];
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (types.indexOf(f.type) !== -1 && typeof f.content === 'string') {
        parts.push(f.content);
      }
      // TIP — всегда игнорируем
    }
    return parts.join('').trim();
  }

  // v8 (O-7): reasoning хода — фрагменты type === 'THINK' (цепочка рассуждений DeepSeek).
  // У USER-хода reasoning нет по определению. TIP/TEMPLATE_RESPONSE игнорируем.
  function collectTurnReasoning(fragments, role) {
    if (role === 'USER') return '';
    var parts = [];
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (f && f.type === 'THINK' && typeof f.content === 'string') {
        parts.push(f.content);
      }
    }
    return parts.join('').trim();
  }

  // v13 (O-7): HIDDEN-ПОМЕТКИ БАЗЫ (текст хода при этом НЕ меняется ни байтом).
  // reasoning хода уже лежит в тексте секциями [REASONING]/[ANSWER] (v8) — здесь он
  // ДОПОЛНИТЕЛЬНО помечается полем hiddenReasoning: одно имя поля для ОБОИХ путей захвата
  // (сеть + DOM-адаптер), которое читает сырой режим экспорта
  // (utils/export-emit-pipeline.js:includeHiddenExportBlocks) при включённом тумблере
  // aiCmIncludeHiddenInExport. Метрики/токены hidden-поля не видят: они считаются по
  // тексту хода (messageTexts), а не по пометкам.
  // Инъекции DeepSeek++ в user-ходе помечаются флагом hiddenInjection: текст остаётся
  // КАК ЕСТЬ, а вырезает инъекции санация O-20 на выходе экспорта (при выключенном тумблере).
  var DS_PP_VISIBLE_MARKER = 'deepseek-pp-visible-user-prompt:start';
  function hasInjectedUserPrompt(text) {
    return typeof text === 'string' && text.indexOf(DS_PP_VISIBLE_MARKER) !== -1;
  }

  function __bind(d) {
    D = d;
    with (D) {
      // ---- BIND-зона: тела, читающие ядро через with (D) ----

  // ===== СЕКЦИЯ 5: МОДЕЛЬ (v13: сетевые сигналы контракта, затем фолбэк по thinking_enabled) =====
  /**
   * Slug модели хода: сначала сигналы нового сетевого контракта, затем прежний фолбэк.
   * @param {boolean} thinkingEnabled
   * @param {AiCmDeepSeekModelSignals} [signals]
   * @returns {string}
   */
  function getModelSlug(thinkingEnabled, signals) {
    var networkSlug = __aiCmDeepseekResolveModelSlug(signals);
    if (networkSlug) return networkSlug;
    return thinkingEnabled === true ? 'deepseek-r1' : 'deepseek-v3';
  }

  // v8 (O-7): формат экспортного текста хода с reasoning:
  //   [REASONING]\n<рассуждение>\n\n[ANSWER]\n<ответ>
  // Нет reasoning (или фича выключена) → текст хода байтово прежний (только ответ).
  function composeTurnText(answer, reasoning) {
    if (!REASONING_ENABLED || !reasoning) return answer;
    return REASONING_TAG + '\n' + reasoning + '\n\n' + ANSWER_TAG + '\n' + answer;
  }

      Fn.buildActiveChain = buildActiveChain;
      Fn.collectTurnText = collectTurnText;
      Fn.collectTurnReasoning = collectTurnReasoning;
      Fn.composeTurnText = composeTurnText;
      Fn.hasInjectedUserPrompt = hasInjectedUserPrompt;
      Fn.getModelSlug = getModelSlug;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekParse = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
