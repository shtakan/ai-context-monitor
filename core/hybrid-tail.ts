// =============================================================================
// core/hybrid-tail.js — v2.0 (этап 1/3): декомпозиция core/content.js.
// ГИБРИДНЫЙ ХВОСТ DOM (нормализация, поиск узлов, tail, effective-текст).
//
// Кластер DOM-хвоста гибрида: нормализация текста, селекторы сообщений, поиск узлов
// и проверка принадлежности базе, выбор Gemini DOM-парсера, вычисление длины хвоста
// и эффективного текста/счётчика (при baseComplete база приоритетнее DOM).
// Тела функций перенесены байтово — правила выбора источника не менялись.
//
// Порядок подключения (manifest.json, content_scripts[0].js):
//   utils/* → adapters/* → core/state.js → core/widget.js → core/base-handler.js
//   → core/hybrid-tail.js → core/export-manager.js → core/content.js
// Перенос БЕЗ изменения логики: тела функций, сигнатуры, имена и строковые
// литералы байтово прежние (декомпозиция, а не переписывание).
// =============================================================================

// Ph2: парсер ответа Gemini — ES-модуль; esbuild втягивает его статическим import'ом.
import { extractGeminiResponse } from '../utils/gemini-dom-parser.ts';

function normalize(s: string): string { return (s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/g, ''); }
function stripMd(s: string): string {
  if (!s) return '';
  return s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`+/g, '');
}
var MSG_SELECTORS: string[] = [
  '[data-message-author-role]',
  '[data-message-id]',
  '.user-query, .model-response, .query-text, .response-content, [data-role="user"], [data-role="model"]'
];
function findMessageNodes(): AiCmTailNodeSet {
  for (var i = 0; i < MSG_SELECTORS.length; i++) {
    var nodes = document.querySelectorAll(MSG_SELECTORS[i]);
    if (nodes && nodes.length > 0) return { nodes: Array.prototype.slice.call(nodes), sel: MSG_SELECTORS[i] };
  }
  return { nodes: [], sel: '(none)' };
}
function nodeIsBase(node: Element, skel: string): boolean {
  if (baseIdSet && baseIdSet.size > 0) {
    var id = '';
    try { id = (node.getAttribute && node.getAttribute('data-message-id')) || ''; } catch (e) { }
    if (id && baseIdSet.has(String(id).trim())) return true;
  }
  if (!skel) return false;
  if (baseSkelSet && baseSkelSet.has(skel)) return true;
  if (baseAnchors) {
    for (var i = 0; i < baseAnchors.length; i++) {
      if (skel.indexOf(baseAnchors[i]) !== -1) return true;
    }
  }
  return false;
}
// Gemini: DOM-хвост собираем через чистый парсер utils/gemini-dom-parser.ts,
// чтобы исключить блоки мышления и включить HTML-таблицы как markdown.
function shouldUseGeminiDomParser(): boolean {
  try {
    if (currentAdapter && currentAdapter.siteName === 'gemini') return true;
  } catch (e) { }
  return false;
}
// ---- BUG-C (A): двусторонний скелет хвоста ----
// Ход базы и его узел в DOM приходят в РАЗНОЙ форме: секции вложений
// ('\n\n[FILE: …]' / '\n\n[IMAGE: …]') дописываются к тексту базы при эмиссии, а лента
// рендерит то же вложение своей карточкой. Сравнение «как есть» расходится, граница базы
// не находится, и ход, уже лежащий в базе, попадает в хвост (двойной счёт).
// Источник формы — core/gemini-ingest.js:908-920 (stripAttachmentSections, байтово тот же
// алгоритм: идём с конца и отрезаем последнюю секцию, пока они есть). Копия, а не вызов:
// скелет должен считаться в одной форме и для базы, и для DOM в этом же модуле.
function aiCmStripAttachmentSections(text: string): string {
  var s = (text == null) ? '' : String(text);
  var at = s.length;
  while (at > 0) {
    var f = s.lastIndexOf('\n\n[FILE: ', at - 1);
    var im = s.lastIndexOf('\n\n[IMAGE: ', at - 1);
    var cut = (f > im) ? f : im;
    if (cut === -1) break;
    s = s.slice(0, cut);
    at = cut;
  }
  return s;
}
// UI-хром ленты: превью вложения отдельной строкой ('image_x.png Ещё 2/1') — в базе такой
// строки нет, поэтому она ломала скелет узла. Снимается ЦЕЛАЯ строка и только при полном
// совпадении с шаблоном: обычный текст, где имя файла стоит внутри фразы, не режется.
// BUG-C-2 (B): кроме статического шаблона, хром снимается по ИМЕНАМ вложений базы: лента
// печатает карточку файла строкой 'report.pdf 1.2 MB', которой в базе нет (там секция
// '[FILE: report.pdf (1.2 МБ)]'). Строка снимается, только если она НАЧИНАЕТСЯ с имени из
// names и весь остаток — размер и/или «Ещё N»; строка, равная имени, остаётся (без цифр это
// обычный текст). Префикс сравнивается строкой, а не regexp по имени.
function aiCmStripChromeLines(text: string, names?: string[]): string {
  var RE_CHROME = /^\s*image_[^\s]+\.(png|jpe?g|webp|gif)(\s+Ещё\s+\d+(?:\/\d+)?)?\s*$/;
  var RE_REST = /^(?:\s*(?:\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|КБ|МБ|ГБ|байт[а-яё]*)|Ещё\s+\d+(?:\/\d+)?))+\s*$/i;
  var s = (text == null) ? '' : String(text);
  if (!s) return '';
  var lines = s.split('\n');
  var kept: string[] = [];
  for (var i = 0; i < lines.length; i++) {
    var drop = RE_CHROME.test(lines[i]);
    if (!drop && names && names.length > 0) {
      for (var n = 0; n < names.length; n++) {
        var nm = names[n];
        if (!nm || lines[i].indexOf(nm) !== 0) continue;
        var rest = lines[i].slice(nm.length);
        if (rest && RE_REST.test(rest)) { drop = true; break; }
      }
    }
    if (!drop) kept.push(lines[i]);
  }
  if (kept.length === lines.length) return s;
  return kept.join('\n').trim();
}
// BUG-C-2 (A): имена вложений, дописанных к текстам базы ('\n\n[FILE: report.pdf (1.2 МБ)]',
// '\n\n[IMAGE: image_x.png] …'). Из имени снимается размер в скобках и размер без скобок;
// дубли не повторяются. Имена применяются только к скелету: тело настоящего нового хода
// не меняется (см. computeTailFromDom).
function aiCmAttachmentNames(text: string): string[] {
  var s = (text == null) ? '' : String(text);
  var out: string[] = [];
  var re = /\[(?:FILE|IMAGE):\s*([^\]\n]+)\]/g;
  var m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    var name = String((m && m[1]) || '').trim();
    name = name.replace(/\s*\([^)]*\)\s*$/, '');
    name = name.replace(/\s+\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|КБ|МБ|ГБ|байт[а-яё]*)$/i, '');
    name = name.trim();
    if (name && out.indexOf(name) === -1) out.push(name);
  }
  return out;
}
// Скелет хвоста: ОДНА форма сравнения для базы и для DOM (A + E + прежние normalize/stripMd).
function aiCmTailSkel(text: string, names?: string[]): string {
  return normalize(stripMd(aiCmStripChromeLines(aiCmStripAttachmentSections(text), names)));
}
function computeTailFromDom(): AiCmTail {
  var found = findMessageNodes();
  var nodes = found.nodes;
  if (!baseSeen || !baseText) return { text: '', count: 0, bounded: false, sel: found.sel, messages: [], diag: 'нет базы' };
  if (nodes.length === 0) return { text: '', count: 0, bounded: false, sel: found.sel, messages: [], diag: 'селектор не дал узлов: ' + found.sel };
  if ((!baseIdSet || baseIdSet.size === 0) && (!baseSkelSet || baseSkelSet.size === 0)) {
    return { text: '', count: 0, bounded: false, sel: found.sel, messages: [], diag: 'кэш базы пуст → фолбэк по базе' };
  }

  // BUG-C-2 (D): база и её имена вложений считаются ОДИН раз до обхода узлов: имена нужны
  // скелету каждого узла, иначе карточка файла ленты ('report.pdf 1.2 MB') расходится с базой,
  // где та же строка записана секцией ('\n\n[FILE: report.pdf (1.2 МБ)]').
  var baseMsgs: AiCmExportMessage[] | null = (typeof aiCmBasePrepared !== 'undefined' &&
    Array.isArray(aiCmBasePrepared) && aiCmBasePrepared.length > 0) ? aiCmBasePrepared : null;
  var baseNames: string[] = [];
  if (baseMsgs) {
    var baseTextsAll: string[] = [];
    for (var bm = 0; bm < baseMsgs.length; bm++) {
      baseTextsAll.push(String((baseMsgs[bm] && baseMsgs[bm].text) || ''));
    }
    baseNames = aiCmAttachmentNames(baseTextsAll.join('\n'));
  }

  var tailNodes = [];
  var stopAt = -1;
  var stopFound = false;
  for (var k = nodes.length - 1; k >= 0; k--) {
    var raw = nodes[k].innerText || nodes[k].textContent || '';
    var skel = aiCmTailSkel(raw, baseNames);
    if (nodeIsBase(nodes[k], skel)) { stopFound = true; stopAt = k; break; }
    if (skel.length > 0) tailNodes.unshift(nodes[k]);
  }

  var tailMessages: AiCmExportMessage[] = [];
  for (var j = 0; j < tailNodes.length; j++) {
    var txt = '';
    if (shouldUseGeminiDomParser()) {
      try {
        txt = (typeof extractGeminiResponse !== 'undefined' && extractGeminiResponse)
          ? extractGeminiResponse(tailNodes[j]).text
          : '';
      } catch (e) {
        txt = (tailNodes[j].innerText || tailNodes[j].textContent || '').trim();
      }
    } else {
      txt = (tailNodes[j].innerText || tailNodes[j].textContent || '').trim();
    }
    // BUG-C (E): UI-хром ленты снимается с узла ДО сравнения с базой и до склейки —
    // строка-превью вложения иначе протекала и в метрики, и в тело снимка.
    txt = aiCmStripChromeLines(txt);
    if (txt) {
      // S1.2: роль хвоста для канонического тела. Приоритет — явный атрибут
      // (Claude/Gemini-разметка), иначе класс узла запроса; всё прочее — ответ.
      var tailRole = '';
      try {
        tailRole = (tailNodes[j].getAttribute && tailNodes[j].getAttribute('data-message-author-role')) || '';
      } catch (eRole) { tailRole = ''; }
      if (!tailRole) {
        var tailIsUser = false;
        try {
          tailIsUser = !!(tailNodes[j].matches && tailNodes[j].matches('.user-query,.query-text')) ||
            !!(tailNodes[j].querySelector && tailNodes[j].querySelector('.user-query,.query-text'));
        } catch (eUser) { tailIsUser = false; }
        tailRole = tailIsUser ? 'user' : 'assistant';
      }
      tailMessages.push({ role: tailRole, text: txt });
    }
  }
  // BUG-C-2 (D): отбрасывание совпавшего хвоста ПОЗИЦИОННО.
  //   Граница базы в DOM может быть найдена не на последнем её ходе (перерисовка ленты теряет
  //   data-message-id, кэш скелетов отстаёт) — тогда за границей оказываются ходы, которые в
  //   базе УЖЕ есть, и getEffectiveText()/getEffectiveMessages() считают их дважды.
  //   Совпавший участок — это КОНЕЦ базы, а не «любой префикс хвоста»: повторная отправка
  //   того же длинного текста, которого в базе ещё нет (новый ход), не вычёркивается —
  //   прежний поиск по множеству скелетов вычёркивал и её.
  //   Позиционно: для cand = maxCand…1 сверяем первые cand ходов хвоста с ПОСЛЕДНИМИ cand
  //   ходами базы — роль, скелет и длина ≥ ANCHOR_MIN у каждого элемента. Короткие реплики
  //   не участвуют: «да»/«спасибо» совпали бы с чем угодно и вычеркнули настоящий новый ход
  //   (принятое ограничение: участок с короткой репликой не сворачивается).
  if (baseMsgs) {
    var minSkel = (typeof ANCHOR_MIN === 'number') ? ANCHOR_MIN : 40;
    var maxCand = Math.min(baseMsgs.length, tailMessages.length);
    var tailSkels: string[] = [];
    for (var ts = 0; ts < maxCand; ts++) {
      tailSkels.push(aiCmTailSkel(tailMessages[ts].text || '', baseNames));
    }
    var baseSkels: string[] = [];
    var baseFrom = baseMsgs.length - maxCand;
    for (var bs = 0; bs < maxCand; bs++) {
      var bMsg = baseMsgs[baseFrom + bs];
      baseSkels.push(aiCmTailSkel(String((bMsg && bMsg.text) || ''), baseNames));
    }
    var drop = 0;
    for (var cand = maxCand; cand >= 1; cand--) {
      var aligned = true;
      for (var ci = 0; ci < cand; ci++) {
        var bAligned = baseMsgs[baseFrom + (maxCand - cand) + ci];
        var bRole = (bAligned && bAligned.role === 'user') ? 'user' : 'assistant';
        var tRole = (tailMessages[ci].role === 'user') ? 'user' : 'assistant';
        var tailSkel = tailSkels[ci];
        if (tRole !== bRole || tailSkel !== baseSkels[maxCand - cand + ci] ||
            tailSkel.length < minSkel) { aligned = false; break; }
      }
      if (aligned) { drop = cand; break; }
    }
    if (drop > 0) tailMessages = tailMessages.slice(drop);
  }
  // Текст хвоста строится ИЗ тех же сообщений, что уходят в messages: тело снимка
  // (canonicalBodyText) и getEffectiveText() остаются побайтово равны.
  var tailTexts: string[] = [];
  for (var q = 0; q < tailMessages.length; q++) tailTexts.push(tailMessages[q].text || '');
  return {
    text: tailTexts.join('\n'),
    count: tailMessages.length,
    bounded: stopFound,
    sel: found.sel,
    messages: tailMessages,
    diag: 'sel=' + found.sel + ' узлов=' + nodes.length +
      ' стоп=' + (stopFound ? ('@' + stopAt) : 'нет(все в окне — новые)') +
      ' хвост=' + tailMessages.length + ' bdd=' + (stopFound ? 'да' : 'нет')
  };
}
// Если сеть дала полную историю (baseComplete) — индикатор берёт число ИЗ БАЗЫ (baseText), а НЕ из DOM.
//   Это и есть фикс расхождения 20.3% vs 34.8%: при тихой пагинации DOM не дорендеривается (в этом её
//   смысл), поэтому в нём только видимый кусок; база же держит всю историю детерминированно. Раньше строка,
//   взводящая baseComplete из события, была потеряна при переписывании под сброс чата → виджет всегда считал
//   по DOM. Теперь при baseComplete=true возвращаем baseText, и скролл вверх число не меняет (сеть от скролла
//   не зависит). Иначе (база неполная) — прежняя логика: bounded ? база+хвост : только DOM.
//
// O-32: неполная база — это КАНОНИЧЕСКИЙ пол базы, а не «сеть победила / DOM победил».
//   Живой дефект (16:47:48): «частичная» DOM-выборка (bounded=false — границы базы в DOM уже
//   нет, сервис вытеснил старые сообщения) отдавалась как ВЕСЬ текст метрик, и база в 6
//   сообщений подменялась куском в 2 сообщения (бейдж 4.4% → 0.6% на том же треде).
//   Правило: при неполной базе берётся ОБЪЕДИНЕНИЕ (канонический выбор): база ∧ DOM —
//   граница базы видна → база + хвост; DOM неполон → остаётся БАЗА (пол базы неизменен),
//   а не более слабый DOM-кусок. Полная база (baseComplete) — по-прежнему ровно база.
// O-32: канонический текст метрик неполной базы — ровно схлопнутая база (aiCmMetricBaseText,
// core/base-handler.js). Хелпер объявлен в общем лексическом скоупе контент-скриптов; в
// срез-песочницах тестов его может не быть — typeof-гард, значение то же (baseText).
function aiCmTailMetricBase(fallback: string): string {
  return (typeof aiCmMetricBaseText === 'function') ? aiCmMetricBaseText(fallback) : fallback;
}
// ФИКС РЕГРЕССИИ «бейдж Gemini замирает после обмена репликами».
//   `baseComplete` (state.js: baseComplete ← detail.historyComplete ← historyFullByQuiet) — это
// вердикт о ПОЛНОТЕ ЗАГРУЖЕННОЙ ИСТОРИИ (тихая пагинация + oracle на момент загрузки), а НЕ о
// текущем состоянии разговора. Новый ход после отправки сообщения приходит ТОЛЬКО в DOM:
// Gemini стримит ответ вне перехваченных batchexecute-RPC, а активный vf5-дозапрос в
// core/gemini-active-refresh.js падал с Illegal invocation (починен там же) → `turnsMap`
// до перезагрузки новых ходов не получает.
//   Пока при baseComplete здесь возвращалась РОВНО база, каждый dom-emit после ответа отдавал
// прежние цифры → `o22-histkey-dedup histKey=<count>|<len> verdict=dedup-skip` → бейдж держал
// значение загрузки (живой лог 2026-11-08: 44.8% / 57 387 токенов) до F5.
//   Теперь ОГРАНИЧЕННЫЙ (bounded) DOM-хвост — сообщения НОВЕЕ последнего сообщения базы —
// учитывается и при полной базе. Двойного счёта нет по построению: хвост начинается там, где
// найдена граница базы (`stopFound` в computeTailFromDom), т.е. это ровно новые ходы.
// Инварианты O-32 сохранены: неполный (unbounded) DOM базу не подменяет, пустой хвост не
// добавляет ничего, `baseSeen=false` по-прежнему отдаёт пустую строку.
/**
 * Последний assistant в DOM может быть ДОПИСАННЫМ продолжением последнего assistant
 * в сети: серверный снимок взят в момент стрима (или до финализации canvas/textdoc),
 * а финальный абзац пришёл позже. При `baseComplete=true` и виртуализированной ленте
 * `tail.bounded=false`, поэтому обычный tail не применяется; при этом сам узел хода уже
 * лежит в базе, т.е. в tail.messages его тоже нет. Берём последний assistant прямо из DOM.
 *
 * Совпадение проверяется по «сравнительной» форме (без markdown/пробелов/регистра):
 * сеть отдаёт markdown, лента — уже отрендеренный текст. Для продолжения дописываем к
 * СЕТЕВОМУ тексту только новый хвост DOM — прежняя часть сохраняет разметку.
 */
function aiCmWordNorm(w: string): string {
  return String(w || '').toLowerCase()
    .replace(/[*_`#>|]/g, '')
    .replace(/^[()\[\]{}"'«».,;:!?—–-]+/, '')
    .replace(/[()\[\]{}"'«».,;:!?—–-]+$/, '');
}
function aiCmWordSpans(s: string): { w: string; start: number; end: number }[] {
  var re = /\S+/g;
  var m: RegExpExecArray | null;
  var out: { w: string; start: number; end: number }[] = [];
  while ((m = re.exec(String(s || ''))) !== null) {
    out.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}
/** Сколько символов слова DOM покрывают `needNorm` нормализованных символов (без разметки). */
function aiCmPrefixCharCut(tok: string, needNorm: number): number {
  var kept = 0;
  var p = 0;
  for (; p < tok.length; p++) {
    if (!/[*_`#>|]/.test(tok.charAt(p))) kept++;
    if (kept >= needNorm) { p++; break; }
  }
  return p;
}
/**
 * Конец сетевого префикса в DOM по ЯКОРЮ из последних слов базы.
 * Полное сравнение «весь текст — префикс» не годится: сеть отдаёт markdown и служебные
 * маркеры (`:::writing{...}` для canvas), а лента рендерит их без разметки. Последние
 * слова текста при этом совпадают буквально. Последнее слово может быть обрезано сетью
 * посреди слова — тогда режем DOM внутри соответствующего слова.
 * @returns индекс в raw DOM или -1, если якорь не найден (DOM — не тот же ход).
 */
function aiCmDomAnchorCut(before: string, after: string): number {
  var bw = aiCmWordSpans(before);
  var dw = aiCmWordSpans(after);
  if (bw.length < 4 || dw.length < 4) return -1;
  var maxL = Math.min(10, bw.length, dw.length);
  for (var L = maxL; L >= 4; L--) {
    var baseStart = bw.length - L;
    var need: string[] = [];
    for (var t = 0; t < L; t++) need.push(aiCmWordNorm(bw[baseStart + t].w));
    if (!need[L - 1]) continue;
    for (var j = dw.length - 1; j >= L - 1; j--) {
      var ok = true;
      for (var q = 0; q < L - 1; q++) {
        if (aiCmWordNorm(dw[j - (L - 1) + q].w) !== need[q]) { ok = false; break; }
      }
      if (!ok) continue;
      var lastNorm = aiCmWordNorm(dw[j].w);
      if (!lastNorm) continue;
      var full = need[L - 1];
      if (lastNorm === full) return dw[j].end;
      if (lastNorm.indexOf(full) === 0) {
        var p = aiCmPrefixCharCut(dw[j].w, full.length);
        if (p > 0) return dw[j].start + p;
      }
    }
  }
  return -1;
}
/** Последний assistant-узел ленты: { text, id }. Пустой text — узла нет. */
function aiCmDomLastAssistant(): { text: string; id: string } {
  // Живая разметка ChatGPT (2026-10) — [data-turn-key]; селекторы знает только адаптер.
  try {
    var adapterAny: any = currentAdapter;
    if (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName === 'chatgpt' &&
        adapterAny && typeof adapterAny.getLastAssistantText === 'function') {
      var advText = String(adapterAny.getLastAssistantText() || '').trim();
      if (advText) return { text: aiCmStripChromeLines(advText), id: '' };
    }
  } catch (eAdv) {
    if (typeof swallowSoft === 'function') swallowSoft(eAdv, 'hybrid-tail:adapter-last-assistant');
  }
  var found = findMessageNodes();
  var nodes = found.nodes || [];
  for (var k = nodes.length - 1; k >= 0; k--) {
    var role = '';
    try { role = (nodes[k].getAttribute && nodes[k].getAttribute('data-message-author-role')) || ''; } catch (eRole) { role = ''; }
    if (!role) {
      var isUser = false;
      try {
        isUser = !!(nodes[k].matches && nodes[k].matches('.user-query,.query-text')) ||
          !!(nodes[k].querySelector && nodes[k].querySelector('.user-query,.query-text'));
      } catch (eUser) { isUser = false; }
      role = isUser ? 'user' : 'assistant';
    }
    if (role !== 'assistant') continue;
    var txt = '';
    try { txt = (nodes[k].innerText || nodes[k].textContent || '').trim(); } catch (eTxt) { txt = ''; }
    txt = aiCmStripChromeLines(txt);
    var id = '';
    try { id = (nodes[k].getAttribute && nodes[k].getAttribute('data-message-id')) || ''; } catch (eId) { id = ''; }
    return { text: txt, id: String(id || '').trim() };
  }
  return { text: '', id: '' };
}
var lastOverlayDiagSig = '';
function aiCmDiagFinalOverlay(index: number, before: string, text: string): void {
  try {
    if (typeof aiCmDiagLine !== 'function') return;
    var sig = index + '|' + before.length + '|' + text.length;
    if (sig === lastOverlayDiagSig) return;
    lastOverlayDiagSig = sig;
    aiCmDiagLine('chatgpt-final-overlay', {
      index: index,
      baseLen: before.length,
      domLen: text.length,
      delta: text.length - before.length
    });
  } catch (eOD) {
    if (typeof swallowSoft === 'function') swallowSoft(eOD, 'hybrid-tail:final-overlay-diag');
  }
}
/**
 * Перекрытие последнего assistant: сетевой текст — префикс видимого DOM-текста,
 * DOM длиннее и относится к тому же ходу (id из baseIdSet, когда id-кэш есть).
 * @returns { index, before, text } — индекс в базе, сетевой текст и итоговый текст хода.
 */
function aiCmFinalAssistantOverlay(
  baseMsgs: AiCmExportMessage[] | null
): { index: number; before: string; text: string } | null {
  try {
    if (typeof currentAdapter === 'undefined' || !currentAdapter || currentAdapter.siteName !== 'chatgpt') return null;
  } catch (eAd) { return null; }
  if (!Array.isArray(baseMsgs) || !baseMsgs.length) return null;
  var bi = baseMsgs.length - 1;
  while (bi >= 0 && baseMsgs[bi] && baseMsgs[bi].role !== 'assistant') bi--;
  if (bi < 0) return null;
  var before = String((baseMsgs[bi] && baseMsgs[bi].text) || '');
  if (!before) return null;
  var dom = aiCmDomLastAssistant();
  var after = dom.text;
  if (!after || after.length <= before.length) return null;
  // Чужой (более новый) ход не подменяет базу: id есть в кэше id базы → это тот же ход.
  if (dom.id && baseIdSet && baseIdSet.size > 0 && !baseIdSet.has(dom.id)) return null;
  if (after.indexOf(before) === 0) {
    aiCmDiagFinalOverlay(bi, before, after);
    return { index: bi, before: before, text: after };
  }
  // Canvas-документ в сети закрыт маркером ':::'. Якорь считаем по телу: сам маркер
  // в ленте не рендерится, а финальный абзац может быть дописан ПЕРЕД ним.
  var anchorText = before;
  var trailer = '';
  var tm = before.match(/(?:\s*:::\s*)+$/);
  if (tm && tm.index && tm.index > 0) {
    anchorText = before.slice(0, tm.index).replace(/\s+$/, '');
    trailer = before.slice(tm.index);
  }
  var cut = aiCmDomAnchorCut(anchorText, after);
  if (cut > 0 && cut < after.length) {
    var appended = after.slice(cut);
    var text = anchorText + appended;
    // Один закрывающий маркер: если DOM его не отдал — возвращаем сетевой.
    if (trailer && !/(?:\s*:::\s*)+$/.test(appended)) text += trailer;
    aiCmDiagFinalOverlay(bi, before, text);
    return { index: bi, before: before, text: text };
  }
  // Якорь не найден: не подменяем ход угадыванием (canvas мог быть переписан целиком).
  return null;
}
/** Копия массива с заменой последнего assistant; при отсутствии перекрытия — тот же массив. */
function aiCmApplyFinalAssistantOverlay(messages: AiCmExportMessage[] | null): AiCmExportMessage[] | null {
  var ov = aiCmFinalAssistantOverlay(messages);
  if (!ov) return messages;
  var out = (messages || []).slice();
  out[ov.index] = Object.assign({}, out[ov.index], { text: ov.text });
  return out;
}

function getEffectiveText(): string {
  if (baseSeen && baseText) {
    var tail = computeTailFromDom();
    var sig = (tail.sel || '') + '|' + (tail.bounded ? '1' : '0');
    if (sig !== lastTailSig) {
      lastTailSig = sig;
      // Антиспам: печатаем hybrid-tail только если текст изменился относительно последней печати.
      if (tail.diag !== lastHybridTailSig) {
        lastHybridTailSig = tail.diag;
        debugLog('log', '[hybrid-tail] ' + tail.diag);
      }
    }
    // источник базы = сеть, он стабилен → монотонный максимум безвреден (прежнее значение).
    lastBounded = baseComplete ? true : tail.bounded;
    if (tail.bounded && tail.text) return aiCmTailMetricBase(baseText) + '\n' + tail.text;
    // DOM неполон (или хвоста нет), но последний assistant может быть продолжением
    // сетевого: стрим/canvas финализировался позже снимка. Это тот же ход — заменяем
    // текст, счётчик сообщений не меняется.
    var basePrepared = (typeof aiCmBasePrepared !== 'undefined' && Array.isArray(aiCmBasePrepared))
      ? aiCmBasePrepared : null;
    var ov = (typeof aiCmFinalAssistantOverlay === 'function') ? aiCmFinalAssistantOverlay(basePrepared) : null;
    if (ov) {
      var baseEff = aiCmTailMetricBase(baseText);
      var before = ov.before;
      if (baseEff.length >= before.length && baseEff.slice(baseEff.length - before.length) === before) {
        return baseEff.slice(0, baseEff.length - before.length) + ov.text;
      }
    }
    return aiCmTailMetricBase(baseText); // хвоста нет — метрики по канонической базе
  }
  return '';
}
function getEffectiveCount(fallbackCount: number): number {
  if (baseSeen && baseText) {
    // Счётчик меряется тем же правилом, что и текст (см. комментарий выше) —
    // bounded-хвост новее базы это новые ходы разговора, а не дрейф DOM.
    var tail = computeTailFromDom();
    if (!tail.count) return baseCount;
    if (tail.bounded) return baseCount + tail.count;
    return baseCount; // O-32: неполный DOM не сокращает счётчик канонической базы
  }
  return fallbackCount;
}
// S1.2 (ADR-001): сообщения, из которых строится РОВНО getEffectiveText().
//   База — подготовленный схлопнутый массив (aiCmBasePrepared, core/base-handler.ts),
//   тот же, чей текст печатает aiCmMetricBaseText. Хвост добавляется только когда
//   getEffectiveText его учитывает (непустой и bounded); иначе — ровно база.
//   null — канонического тела нет: baseText без подготовленного массива или пустая база.
//   Тело снимка (content.js) публикуется только если canonicalBodyText(result) совпал
//   с getEffectiveText() побайтово; это проверяет tests/inv-s1-2-snapshot-body.test.js.
// S1.3 (inv-i3): мемоизация по (baseRef, tailText, bounded). Возвращается ТОТ ЖЕ массив,
//   а не новый base.concat(tail): иначе WeakMap-кэш canonicalBody промахивается каждый
//   проход и тело пересчитывается даже при неизменном DOM (~650 КБ на Qwen).
var lastEffMsgsBaseRef: AiCmExportMessage[] | null = null;
var lastEffMsgsTailText = '';
var lastEffMsgsBounded = false;
var lastEffMsgsOverlayText = '';
var lastEffMsgsOverlayIndex = -1;
var lastEffMsgsResult: AiCmExportMessage[] | null = null;

function getEffectiveMessages(): AiCmExportMessage[] | null {
  if (!baseSeen || !baseText) return null;
  var base: AiCmExportMessage[] | null = (typeof aiCmBasePrepared !== 'undefined' &&
    Array.isArray(aiCmBasePrepared) && aiCmBasePrepared.length > 0) ? aiCmBasePrepared : null;
  if (!base) return null;
  var tail = computeTailFromDom();
  var tailText = (tail.text && tail.bounded) ? tail.text : '';
  var ov = tailText
    ? null
    : ((typeof aiCmFinalAssistantOverlay === 'function') ? aiCmFinalAssistantOverlay(base) : null);
  var ovText = ov ? ov.text : '';
  var ovIndex = ov ? ov.index : -1;
  if (lastEffMsgsBaseRef === base && lastEffMsgsTailText === tailText &&
      lastEffMsgsBounded === !!tail.bounded &&
      lastEffMsgsOverlayText === ovText && lastEffMsgsOverlayIndex === ovIndex) {
    return lastEffMsgsResult;
  }
  var result: AiCmExportMessage[];
  if (tailText) {
    result = base.concat(tail.messages);
  } else if (ov) {
    result = base.slice();
    result[ov.index] = Object.assign({}, base[ov.index], { text: ov.text });
  } else {
    result = base;
  }
  lastEffMsgsBaseRef = base;
  lastEffMsgsTailText = tailText;
  lastEffMsgsBounded = !!tail.bounded;
  lastEffMsgsOverlayText = ovText;
  lastEffMsgsOverlayIndex = ovIndex;
  lastEffMsgsResult = result;
  return result;
}

// ========== v2.0 (этап 1/3): UMD-экспорт модуля ==========
// Паттерн как у utils/export-emit-pipeline.ts: window.<Api> + module.exports.
// Рабочий путь ничего не импортирует: content-скрипты манифеста делят один
// глобальный лексический скоуп, поэтому объявления выше видны всем модулям и
// content.js по прежним именам. Api — для инструментов, отладки и тестов.
(function () {
  var Api: any = {};
  Api.normalize = normalize;
  Api.stripMd = stripMd;
  Api.MSG_SELECTORS = MSG_SELECTORS;
  Api.findMessageNodes = findMessageNodes;
  Api.nodeIsBase = nodeIsBase;
  Api.shouldUseGeminiDomParser = shouldUseGeminiDomParser;
  Api.aiCmStripAttachmentSections = aiCmStripAttachmentSections;
  Api.aiCmAttachmentNames = aiCmAttachmentNames;
  Api.aiCmStripChromeLines = aiCmStripChromeLines;
  Api.aiCmTailSkel = aiCmTailSkel;
  Api.computeTailFromDom = computeTailFromDom;
  Api.aiCmTailMetricBase = aiCmTailMetricBase;
  Api.getEffectiveText = getEffectiveText;
  Api.getEffectiveCount = getEffectiveCount;
  Api.getEffectiveMessages = getEffectiveMessages;
  Api.aiCmFinalAssistantOverlay = aiCmFinalAssistantOverlay;
  Api.aiCmApplyFinalAssistantOverlay = aiCmApplyFinalAssistantOverlay;
  Api.aiCmDomLastAssistant = aiCmDomLastAssistant;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmHybridTail = Api;
})();

// ========== Core Wave 2: типы модуля (EOF-блок) ==========
// Хвост DOM-хвоста гибрида. Возвращаемые структуры `findMessageNodes`/`computeTailFromDom`
// объявлены здесь, чтобы аннотации не сдвигали строки выше: line-числа catch-whitelist
// (tests/fixtures/catch-whitelist.json) и source-пины тестов остаются прежними.
interface AiCmTailNodeSet {
  nodes: any[];
  sel: string;
}

/** Результат computeTailFromDom: текст хвоста, число узлов, граница базы и диагностика. */
interface AiCmTail {
  text: string;
  count: number;
  bounded: boolean;
  sel: string;
  diag: string;
  /** S1.2: сообщения хвоста (только для непустого txt); роль — user/assistant. */
  messages: AiCmExportMessage[];
}
