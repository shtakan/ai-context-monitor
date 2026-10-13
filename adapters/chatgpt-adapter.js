/**
 * Адаптер для ChatGPT (chatgpt.com).
 *
 * Типизация (шаг 4 Фазы 1): формы — из types/adapter.d.ts. Литеральный `import type`
 * невозможен (файл — классический скрипт контента плюс склейка исходника в
 * new Function()/eval песочницами тестов), поэтому типы подключены JSDoc-ссылкой import().
 */

/**
 * Сообщение в форме адаптера (types/adapter.d.ts).
 *
 * Имя с префиксом — по необходимости: файлы адаптеров не являются модулями, поэтому
 * при allowJs все typedef-имена попадают в одну общую область (одноимённые → TS2300).
 * @typedef {import('../types/adapter').ExtractedMessage} ChatGPTExtractedMessage
 */

class ChatGPTAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'chatgpt';

    // ===== TURN-BASED ОТБОР (диагностика 2026-10-13, 3 раунда, живой DOM chatgpt.com) =====
    // Снимок 2026-10-13 (длинный чат, ровно 5 пар): [data-turn-key] — 5 узлов, стабильный
    // UUID НА ХОД (не хеш содержимого). Внутри каждого хода:
    //   [class*="bg-user-message"] — реплика пользователя (5/5);
    //   [class*="block-"] (конкретно block-BQZwFn) — ответ (5/5; длины 2213/1372/1022/756/487).
    // Прежние селекторы (.markdown, assistant-message, model-response,
    // data-message-author-role, data-virtualized-turn-content) на том же DOM дали 0
    // совпадений — поэтому отбор идёт ОТ ХОДА, а не от класса содержимого.
    // Класс block-BQZwFn — Tailwind JIT и сменится при пересборке сайта: буквально он НЕ
    // пинится. Уровни отбора по приоритету: 1) [class*="block-"]/[class*="content-"] внутри
    // хода; 2) структурный (самый длинный текстовый узел хода после реплики); 3) хвост/
    // виртуализация (bg-user-message БЕЗ data-turn-key); 4) легаси (.markdown/pre-wrap).
    this._turnSelectors = ['[data-turn-key]'];
    this._userSelectors = ['[class*="bg-user-message"]', '[class*="text-user-message"]'];
    this._assistantSelectors = ['[class*="block-"]', '[class*="content-"]'];

    // Те же маркеры реплики пользователя, но без обёртки атрибута: нужны для проверки
    // className узла и его предков (живой снимок 2026-10-13).
    this._userRoleMarkers = ['bg-user-message', 'text-user-message'];
    // Наследие старых сборок: маркер пузыря пользователя из исходной версии и признаки
    // контейнера ответа. Нужны ТОЛЬКО легаси-слою (_detectRole), отбор хода их не знает.
    this._legacyUserRoleMarkers = ['user-message-bubble-color'];
    this._assistantRoleMarkers = ['markdown', 'assistant-message', 'model-response'];

    // Легаси-селекторы содержимого (уровень 4, «старые сборки»). Имя поля прежнее: оно
    // читается снаружи адаптера, переименование сломало бы внешние ссылки.
    this.allContentSelectors = '.whitespace-pre-wrap, .markdown';

    // Счётчики последнего отбора. Наружу не торчат и считаются ВСЕГДА (они — часть
    // возврата _findMessageElements), а печатает их extractMessages только под гейтом.
    /** @type {{turns: number, users: number, assistants: number, skippedUnknown: number, looseUsers: number}} */
    this._lastTurnStats = { turns: 0, users: 0, assistants: 0, skippedUnknown: 0, looseUsers: 0 };
  }

  /**
   * Есть ли в className узла хоть один из маркеров (подстрока — как в исходной версии:
   * хеш-суффиксы Tailwind являются частью того же класса-токена).
   * @param {string} className
   * @param {string[]} markers
   * @returns {boolean}
   */
  _markerHit(className, markers) {
    const cls = String(className || '');
    if (!cls) return false;
    for (let i = 0; i < markers.length; i++) {
      if (cls.indexOf(markers[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * Несёт ли узел маркер реплики пользователя — сам, на предке до 5 уровней вверх
   * (в исходной версии маркер жил именно на предке) или внутри своего поддерева.
   * Служит и определению роли, и ИСКЛЮЧЕНИЮ обёрток: узел, внутри которого лежит
   * реплика пользователя, ответом быть не может (иначе в ответ попал бы и вопрос).
   * @param {Element} element
   * @returns {boolean}
   */
  _hasUserMarker(element) {
    if (!element) return false;
    if (this._markerHit(element.className, this._userRoleMarkers)) return true;
    if (this._markerHit(element.className, this._legacyUserRoleMarkers)) return true;
    let parent = element.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      if (this._markerHit(parent.className, this._userRoleMarkers)) return true;
      if (this._markerHit(parent.className, this._legacyUserRoleMarkers)) return true;
      parent = parent.parentElement;
    }
    if (element.querySelector && element.querySelector(this._userSelectors.join(', '))) return true;
    return false;
  }

  /**
   * Первая непустая реплика пользователя внутри узла. Кандидаты — по порядку
   * `_userSelectors`: первый непустой набор выигрывает (форма донора qwen-adapter.js).
   * @param {Document|Element} scope
   * @returns {Element|null}
   */
  _firstUserNode(scope) {
    for (let i = 0; i < this._userSelectors.length; i++) {
      const found = scope.querySelectorAll(this._userSelectors[i]);
      for (let j = 0; j < found.length; j++) {
        if (String(found[j].textContent || '').trim()) return found[j];
      }
    }
    return null;
  }

  /**
   * Структурный фолбэк: самый длинный текстовый узел поддерева, не являющийся репликой
   * пользователя и не содержащий её.
   * @param {Element} scope
   * @param {Element|null} userEl
   * @returns {Element|null}
   */
  _longestTextNode(scope, userEl) {
    const nodes = scope.querySelectorAll('*');
    let best = null;
    let bestLen = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node === userEl) continue;
      if (userEl && node.contains(userEl)) continue;
      if (this._hasUserMarker(node)) continue;
      // Дешёвый предфильтр по сырому textContent: _extractText (клон + обход) зовём
      // только для кандидата, который реально может выиграть.
      if (String(node.textContent || '').trim().length <= bestLen) continue;
      const text = this._extractText(node);
      if (text.length > bestLen) { best = node; bestLen = text.length; }
    }
    return best;
  }

  /**
   * Узел ответа внутри хода. Уровень 1 — класс-контейнер ответа ([class*="block-"] /
   * [class*="content-"]) вне реплики пользователя; выигрывает самый ДЛИННЫЙ текст (у
   * Tailwind-классов длина хеш-суффикса меняется, поэтому «первый» кандидат нестабилен).
   * Уровень 2 (структурный) — самый длинный текстовый узел хода ПОСЛЕ реплики; он
   * включается, только если реплика пользователя найдена (иначе роль ответа угадывалась
   * бы длиной, а это тот же дефект, что и нормализация 'unknown' → 'user').
   * @param {Element} turn
   * @param {Element|null} userEl
   * @returns {Element|null}
   */
  _assistantInTurn(turn, userEl) {
    let best = null;
    let bestLen = 0;
    for (let i = 0; i < this._assistantSelectors.length; i++) {
      const found = turn.querySelectorAll(this._assistantSelectors[i]);
      for (let j = 0; j < found.length; j++) {
        const node = found[j];
        if (node === userEl) continue;
        if (this._hasUserMarker(node)) continue;
        if (String(node.textContent || '').trim().length <= bestLen) continue;
        const text = this._extractText(node);
        if (text.length > bestLen) { best = node; bestLen = text.length; }
      }
    }
    if (best) return best;
    if (!userEl) return null;
    return this._longestTextNode(turn, userEl);
  }

  /**
   * Узлы сообщений в порядке чтения — по ОДНОЙ записи с ролью на реплику.
   * Уровни 1-2: для каждого хода [data-turn-key] — user (первая непустая) и assistant.
   * Уровень 3: реплики пользователя БЕЗ хода (хвост/виртуализация), ответ — следующий
   * sibling с непустым текстом. Уровень 4 (легаси, .markdown/pre-wrap) — ПОСЛЕДНИМ и
   * только если живой отбор не дал ничего: на новых сборках он дал бы дубли.
   * Роль 'unknown' в результат НЕ попадает — исходная нормализация 'unknown' → 'user'
   * и была корнем дефекта (ответ записывался в базу как реплика пользователя).
   * @returns {{role: string, element: Element}[]}
   */
  _findMessageElements() {
    /** @type {{role: string, element: Element}[]} */
    const found = [];
    const stats = { turns: 0, users: 0, assistants: 0, skippedUnknown: 0, looseUsers: 0 };

    const turnNodes = document.querySelectorAll(this._turnSelectors[0]);
    for (let i = 0; i < turnNodes.length; i++) {
      const turn = turnNodes[i];
      stats.turns++;
      const userEl = this._firstUserNode(turn);
      if (userEl) {
        found.push({ role: 'user', element: userEl });
        stats.users++;
      }
      const assistantEl = this._assistantInTurn(turn, userEl);
      if (assistantEl) {
        found.push({ role: 'assistant', element: assistantEl });
        stats.assistants++;
      }
    }

    const userSel = this._userSelectors.join(', ');
    const loose = document.querySelectorAll(userSel);
    for (let i = 0; i < loose.length; i++) {
      const el = loose[i];
      if (el.closest(this._turnSelectors[0])) continue; // уже разобрано уровнями 1-2
      if (el.parentElement && el.parentElement.closest(userSel)) continue; // вложенный маркер
      found.push({ role: 'user', element: el });
      stats.users++;
      stats.looseUsers++;
      let sib = el.nextElementSibling;
      while (sib) {
        if (String(sib.textContent || '').trim()) {
          found.push({ role: 'assistant', element: sib });
          stats.assistants++;
          break;
        }
        sib = sib.nextElementSibling;
      }
    }

    if (found.length === 0) {
      const legacy = document.querySelectorAll(this.allContentSelectors);
      for (let i = 0; i < legacy.length; i++) {
        const role = this._detectRole(legacy[i]);
        if (role === 'unknown') { stats.skippedUnknown++; continue; }
        found.push({ role: role, element: legacy[i] });
        if (role === 'user') stats.users++; else stats.assistants++;
      }
    }

    this._lastTurnStats = stats;
    return found;
  }

  /**
   * Роль узла по классу самого узла и класса предков (до 5 уровней вверх) — ЛЕГАСИ-слой
   * (уровень 4), на живой разметке 2026-10-13 не используется.
   *
   * Возвращаем string, а не литеральный union 'user'|'assistant': пока тип узкий, tsc
   * (TS2367) счёл бы сверку `role === 'unknown'` в extractMessages заведомо ложной, а она —
   * живой детектор дрейфа разметки. TODO: уточнить тип в шаге 5 (контракт ролей адаптера).
   * @param {Element} element
   * @returns {string}
   */
  _detectRole(element) {
    const classAttr = String(element.className || '');
    // Порядок исходной версии сохранён: markdown-рендер — ответ ассистента.
    if (classAttr.indexOf('markdown') !== -1) return 'assistant';
    // Живой маркер реплики пользователя (снимок 2026-10-13) — на узле или на предке.
    if (this._hasUserMarker(element)) return 'user';
    if (this._markerHit(classAttr, this._assistantRoleMarkers)) return 'assistant';
    // Роль НЕ определена. Это НЕ 'user': нормализация 'unknown' → 'user' в исходной версии
    // записывала ответ ассистента в базу как реплику пользователя. Узел пропускается.
    return 'unknown';
  }

  /**
   * Текст блочного узла с сохранением переводов строк: границы блочных элементов
   * (p/div/li/…, <br>) становятся `\n`, серии пустых строк схлопываются до одной пары.
   * Заменяет `clone.textContent`, который склеивал абзацы БЕЗ разделителя («первыйвторой»)
   * и тем самым ломал формат многострочного ответа. trim — только на краях результата:
   * значимые переводы строк ВНУТРИ текста сохраняются.
   * @param {Element} root
   * @returns {string}
   */
  _blockText(root) {
    let out = '';
    const BLOCK = {
      P: 1, DIV: 1, LI: 1, TR: 1, SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1, MAIN: 1,
      H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, PRE: 1, BLOCKQUOTE: 1, TABLE: 1, UL: 1, OL: 1
    };
    const walk = (node) => {
      if (node.nodeType === 3) { out += String(node.nodeValue || ''); return; }
      if (node.nodeType !== 1) return; // комментарии и прочее в текст не входят
      const tag = node.tagName;
      if (tag === 'BR') { out += '\n'; return; }
      const isBlock = BLOCK[tag] === 1;
      if (isBlock && out && out.charAt(out.length - 1) !== '\n') out += '\n';
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
      if (isBlock && out && out.charAt(out.length - 1) !== '\n') out += '\n';
    };
    walk(root);
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Текст хода. markdown-рендер (легаси-разметка) — абзацы построчно. Иначе — клон без
   * кнопок/svg (как в исходной версии) и структурная нормализация блочных границ.
   * @param {Element} element
   * @returns {string}
   */
  _extractText(element) {
    const classAttr = String(element.className || '');
    if (classAttr.indexOf('markdown') !== -1) {
      const paragraphs = element.querySelectorAll('p');
      if (paragraphs.length > 0) {
        const lines = [];
        for (let i = 0; i < paragraphs.length; i++) {
          // Внутренний trim абзаца значим: он и есть «построчность» markdown-рендера.
          lines.push(String(paragraphs[i].textContent || '').trim());
        }
        return lines.join('\n').trim();
      }
    }
    const clone = /** @type {Element} */ (element.cloneNode(true));
    clone.querySelectorAll('button, [role="button"], svg').forEach(el => el.remove());
    return this._blockText(clone);
  }

  /**
   * Ходы диалога из DOM. Роли берутся из структуры хода (turn-based), пустые тексты
   * отбрасываются, а роль 'unknown' (легаси-узел не опознан) ПРОПУСКАЕТСЯ: нормализации
   * 'unknown' → 'user' больше нет — это и был корень дефекта. Диагностика — ТОЛЬКО под
   * гейтом (typeof-гард: в срез-песочницах тестов хелперов гейта может не быть).
   * @returns {ChatGPTExtractedMessage[]}
   */
  extractMessages() {
    const diagOn = (typeof aiCmDiagOn === 'function') ? aiCmDiagOn() : false;
    const elements = this._findMessageElements();
    /** @type {ChatGPTExtractedMessage[]} */
    const messages = [];
    for (let i = 0; i < elements.length; i++) {
      const role = elements[i].role;
      const content = this._extractText(elements[i].element);
      if (!content || content.length === 0) continue;
      // Зеркало предиката _findMessageElements — детектор дрейфа разметки: сейчас 'unknown'
      // сюда не доходит (узел отсечён в легаси-слое), но конъюнкт не должен «умереть».
      if (role === 'unknown') continue;
      messages.push({ role: role, content: content });
    }
    if (diagOn && typeof aiCmDiagLine === 'function') {
      const stats = this._lastTurnStats;
      aiCmDiagLine('chatgpt-adapter-turn', {
        turns: stats.turns,
        users: stats.users,
        assistants: stats.assistants,
        msgs: messages.length,
        loose: stats.looseUsers,
        skippedUnknown: stats.skippedUnknown
      });
      // Ходы есть, а ответа нет — самый дорогой случай: разметку ответа пересобрали и все
      // уровни отбора мимо. Печатается один раз на вызов extractMessages (антиспам не нужен:
      // вызов идёт по циклу оценки токенов, но под гейтом строки и должны быть видны).
      if (stats.turns > 0 && stats.assistants === 0) {
        aiCmDiagLine('chatgpt-roles-miss', {
          turns: stats.turns,
          users: stats.users,
          turnSel: this._turnSelectors.join(', '),
          userSel: this._userSelectors.join(', '),
          assistantSel: this._assistantSelectors.join(', ')
        });
      }
    }
    return messages;
  }

  /**
   * Полный текст диалога: содержимое ходов, склеенное переводом строки.
   * Явное переопределение базового (у ChatGPT свой путь отбора узлов).
   * @returns {string}
   */
  getFullDialogText() {
    const messages = this.extractMessages();
    return messages.map(msg => msg.content).join('\n');
  }

  /**
   * Находимся ли мы на странице диалога: есть ход ([data-turn-key]) либо реплика
   * пользователя (в т.ч. хвост без атрибута) либо легаси-узел содержимого.
   * @returns {boolean}
   */
  isOnDialogPage() {
    if (document.querySelector(this._turnSelectors.join(', '))) return true;
    if (document.querySelector(this._userSelectors.join(', '))) return true;
    return document.querySelector(this.allContentSelectors) !== null;
  }

  // Честный детектор модели из DOM (второй слой; первый — model_slug из сети в content.js).
  // Ищет имя модели в шапке/селекторе. Если шапка показывает только бренд ("ChatGPT")
  // без версии — возвращает null (НЕ захардкоженное 'gpt-4o'), чтобы content.js взял
  // дефолт/сеть. Лог один раз, без спама. Безопасно (try/catch).
  /**
   * Имя модели из шапки/селектора; если шапка показывает только бренд — null
   * (не захардкоженное имя), иначе модель возьмётся из сети/дефолта.
   * @returns {string|null}
   */
  detectModel() {
    if (this._modelDetectLogged === undefined) this._modelDetectLogged = false;
    let found = null;
    try {
      const re = /(GPT-[\w.\-]+|Gemini[\s\d.\-A-Za-z]*|DeepSeek[\s\-A-Za-z0-9]*|Claude[\s\d.\-A-Za-z]*|o[134]-[\w.\-]*)/i;
      const selectors = [
        '[data-testid="model-switcher-dropdown-button"]',
        '[data-testid="model-switcher"]',
        'button[aria-label*="model" i]',
        'button[aria-label*="модель" i]',
        'nav button',
        'header button'
      ];
      for (let i = 0; i < selectors.length && !found; i++) {
        // innerText есть только у HTMLElement, а querySelectorAll по строке даёт Element
        // (TS2339). Уточняем форму узла: селекторы здесь кнопки/ссылки шапки.
        const els = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(selectors[i]));
        for (let j = 0; j < els.length; j++) {
          const txt = (els[j].innerText || els[j].textContent || '').trim();
          const m = txt.match(re);
          if (m) { found = m[1]; break; }
        }
      }
      if (!found) {
        const labeled = document.querySelectorAll('[aria-label],[title]');
        for (let k = 0; k < labeled.length; k++) {
          const s = (labeled[k].getAttribute('aria-label') || '') + ' ' + (labeled[k].getAttribute('title') || '');
          const m2 = s.match(re);
          if (m2) { found = m2[1]; break; }
        }
      }
    } catch (e) { swallowSoft(e, 'adapter:chatgpt:detectModel'); /* никогда не ломаем сайт */ }
    if (!this._modelDetectLogged) {
      this._modelDetectLogged = true;
      debugLog('log', '[model-detect][DOM] ' + (found ? ('найдено в шапке: "' + found + '"') : 'имя модели в шапке не найдено (шапка показывает бренд — модель возьмётся из сети/дефолта)'));
    }
    return found; // null, если не нашли — это нормально
  }
}
