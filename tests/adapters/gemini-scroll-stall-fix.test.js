/**
 * v1.17 (hot-path: stall + scroll) — пины правок коммита; v1.17a — откат капа до 90.
 *
 * ПРЕДМЕТ. Живой снимок DOM от 2026-10-18 показал: `<main class="chat-app">` есть, но сам
 * НЕ скроллится (scrollHeight == clientHeight, overflow-y: visible), единственный реальный
 * скролл-контейнер — `infinite-scroller.chat-history` внутри main, а HINT-регулярка его
 * class не матчит (`chat-history` — ни одного слова из HINT). Из-за этого старая эвристика
 * findScrollContainer() обходила ВЕСЬ document, не находила hinted-кандидата, падала в
 * best-fallback и отдавала самый высокий скроллер страницы — сайдбар. Плюс LOADER_STALL_CAP=90
 * держал оверлей заблокированным до ~108с. Три правки:
 *
 *   1) LOADER_STALL_CAP 90 → 20 (60+ итераций прироста не дают — дальше timeout);
 *   2) независимый wall-clock предел прогона LOADER_RUN_WALL_CLOCK_MS = 90000, проверка —
 *      ПЕРВАЯ строка тела while, поэтому срабатывает и при живом pendingCursor;
 *   3) findScrollContainer() — структурный обход только поддерева main, без document-фолбэка.
 *
 * ОТКАТ (v1.17a, 2026-10-18). Пункт 1 откатан: кап снова 90 и исторический комментарий v53
 * восстановлен дословно — истинный холодный старт (простой >12ч) на капе 20 не проверялся,
 * а приёмка показала живой курсор при ещё недогруженной истории (лог 0362260d: pct=56.2).
 * Вместо сокращения капа добавлен отдельный UI-таймаут 30с: он снимает только оверлей,
 * а фоновый цикл продолжается до wall-clock (90с) или doneReason — пины в
 * `gemini-overlay-ui-timeout.test.js`. Пункты 2 и 3 сохранены без изменений.
 *
 * ПИНЫ.
 *   D1  источник: `LOADER_STALL_CAP = 90` ровно один раз, `= 20` — ноль; исторический
 *       комментарий v53 (0362260d / pct=56.2) и комментарий про wall-clock на месте —
 *       обоснование не потеряется при будущих подъёмах/снижениях капа.
 *   D2  источник: константа 90000 объявлена один раз; `doneReason = 'wall-clock-timeout'`
 *       ровно один раз; guard — первая строка тела while; `runStartAt` объявлен ДО цикла
 *       ровно один раз (никто не сбрасывает отсчёт внутри итерации); строка guard'а не
 *       упоминает pendingCursor — независимость от курсорной логики видна в самом коде.
 *   D3  источник: литерал `document.querySelectorAll('*')` в модуле отсутствует ПОЛНОСТЬЮ
 *       (findScrollContainer + рентген), `querySelector('main')` присутствует, ветка `!root`
 *       возвращает null и пишет громкий лог; `makeScroller(null)` (window/document-фолбэк)
 *       удалён; HINT и фильтры overflow/50px сохранены дословно.
 *   D4  поведение: модуль грузится в vm (как в gemini-overlay-module.test.js). Мок document
 *       отдаёт main с двумя дочерними скроллерами: hinted (`chat-history`, МЕНЬШИЙ по высоте)
 *       и без hint (больший). findScrollContainer() обязан вернуть именно hinted-узел, т.е.
 *       HINT важнее max scrollHeight. Контроль (v88): если HINT нет ни у кого, generic
 *       `best` удалён — findScrollContainer() возвращает null, а не самый высокий узел.
 *   D5  поведение (v88): main содержит скелет-обёртку (`DIV`, className '', sh=884, ch=0)
 *       и реальную ленту (`INFINITE-SCROLLER`, className `chat-history`, ch=900).
 *       findScrollContainer() обязан вернуть ленту, а не скелет; скелет с ch=0 отсекается
 *       даже когда он ВЫШЕ ленты по scrollHeight (сильнейший случай холодного старта).
 *   D6  поведение: мок document без main; findScrollContainer() возвращает null, не бросает,
 *       и НЕ обходит document — мок querySelectorAll('*') кидает исключение, поэтому любой
 *       глобальный обход уронил бы тест.
 *   R2  модуль грузится в vm без бросаний; публичные экспорты triggerUp / settleBottom /
 *       findScrollContainer не переименованы и остаются функциями.
 *
 * ПОЧЕМУ ПРАВКИ ЛИНЕЙНО-НЕЙТРАЛЬНЫ. `tests/catch-hygiene.test.js` пинит НОМЕРА строк
 * catch'ей из `tests/fixtures/catch-whitelist.json`. В gemini-hidden-scroll.js это строки
 * 76 и 81, в gemini-loader-scroll.js — шесть групп. Тела обоих файлов сохранены
 * постинно: новые строки вставлены только за счёт сжатия соседних комментариев, поэтому
 * ни один whitelisted catch не сдвинулся и сам whitelist не правился.
 *
 * ПОСЛЕ ОТКАТА (v1.17a) линейная нейтральность в loader-scroll НАМЕРЕННО нарушена:
 * восстановлен 4-строчный комментарий v53 и добавлены UI-таймаут с латчем (+5/+6 строк),
 * поэтому номера catch'ей в `catch-whitelist.json` для `core/gemini-loader-scroll.js`
 * пересчитаны и записаны заново. Ни один catch не добавлен/удалён — изменились только
 * их номера; `tests/catch-hygiene.test.js` (R1) подтверждает совпадение записей.
 *
 * Логика waitImPossibility, _wasVis, seq-гарда оверлея и intercept не затрагивалась —
 * это подтверждают соседние пин-сьюты (R1), остающиеся зелёными без правок.
 *
 * ОБНОВЛЕНИЕ v88 (2026-10-20, PLAN-отчёт). Холодный старт: best-fallback выбирал обёртку
 * `sh=884, ch=0` (она проходит фильтр `sh > ch+50`), пока реальный
 * `infinite-scroller.chat-history` ещё не набрал высоту. Правки в источнике:
 *   1) `if (!(ch > 0)) continue;` — невидимые скелеты (clientHeight=0) отсекаются;
 *   2) структурный якорь `el.closest('infinite-scroller.chat-history, [class*="chat-history"]')`;
 *   3) в HINT-хай добавлен `el.tagName` (тег `INFINITE-SCROLLER` матчит HINT, класс — нет);
 *   4) generic `best`-фолбэк удалён: без hinted-кандидата возвращается null.
 * Правки линейно-нейтральны: catch'и 76/81 не сдвинулись, whitelist не менялся.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Число непересекающихся вхождений подстроки. */
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const LOADER_REL = 'core/gemini-loader-scroll.js';
const HIDDEN_REL = 'core/gemini-hidden-scroll.js';
const LOADER = readFile(LOADER_REL);
const HIDDEN = readFile(HIDDEN_REL);

const V53_COMMENT_LINES = [
  '// v53: кап ретраев скролла при живом continuation-курсоре (h не растёт, курсор есть).',
  '// Холодный старт (простой >12ч) медленный — поднят до 90 (шаг ~1с → до ~90с).',
  '// Исчерпание капа → done reason=timeout. Раньше (30) лоадер стопился преждевременно',
  '// при ещё живой истории (логи 0362260d: pct=56.2 терялись до ручного скролла).'
];

/**
 * Загрузка core/gemini-hidden-scroll.js в отдельный vm-контекст — как это делает реальный
 * content script (IIFE, зависимости через __bind, debugLog — глобальная функция utils/debug.js).
 * document и getComputedStyle подменяются моком конкретного теста.
 */
function loadHidden(doc, log) {
  const pageWindow = {};
  const ctx = vm.createContext({
    window: pageWindow,
    document: doc,
    console,
    getComputedStyle: (el) => ({ overflowY: el.overflowY }),
    debugLog(level, line) { log.push({ level, line }); }
  });
  vm.runInContext(HIDDEN, ctx, { filename: HIDDEN_REL });
  return pageWindow.AiCmGeminiHiddenScroll;
}

/**
 * Фейковый узел-скроллер: ровно те поля, которые читает findScrollContainer/makeScroller.
 * `anchored` (v88) — узел лежит под `infinite-scroller.chat-history`; false — сайдбар/панель.
 */
function makeEl(tagName, className, scrollHeight, clientHeight, anchored = true) {
  return {
    tagName, className, id: '', scrollTop: 0,
    scrollHeight, clientHeight, overflowY: 'auto', style: {},
    closest() { return anchored ? { tagName: 'INFINITE-SCROLLER', className: 'chat-history' } : null; },
    dispatchEvent() { }
  };
}

/** Мок document, у которого main есть и содержит заданных потомков. */
function docWithMain(children) {
  const main = { querySelectorAll: (sel) => (sel === '*' ? children : []) };
  return {
    querySelector: (sel) => (sel === 'main' ? main : null),
    querySelectorAll: () => { throw new Error('глобальный обход document запрещён (v1.17)'); },
    body: {}, documentElement: {}, scrollingElement: null,
    visibilityState: 'visible', addEventListener() { }
  };
}

describe('gemini-scroll-stall-fix (v1.17)', () => {
  describe('D1: кап сталла 90 (историческое значение v53, откат v1.17a)', () => {
    test('LOADER_STALL_CAP = 90 ровно один раз, = 20 отсутствует', () => {
      expect(countOf(LOADER, 'LOADER_STALL_CAP = 90')).toBe(1);
      expect(countOf(LOADER, 'LOADER_STALL_CAP = 20')).toBe(0);
    });

    test('исторический комментарий v53 восстановлен дословно и стоит перед константой', () => {
      for (const l of V53_COMMENT_LINES) expect(countOf(LOADER, l)).toBe(1);
      const lines = LOADER.split('\n');
      const capIdx = lines.findIndex((l) => l.includes('LOADER_STALL_CAP = 90'));
      expect(capIdx).toBeGreaterThan(V53_COMMENT_LINES.length);
      V53_COMMENT_LINES.forEach((c, i) => {
        expect(lines[capIdx - V53_COMMENT_LINES.length - 1 + i].trim()).toBe(c);
      });
    });

    test('комментарий про wall-clock сохранён между v53 и константой', () => {
      const lines = LOADER.split('\n');
      const capIdx = lines.findIndex((l) => l.includes('LOADER_STALL_CAP = 90'));
      expect(lines[capIdx - 1]).toContain('// v1.17 (wall-clock)');
    });
  });

  describe('D2: независимый wall-clock предел прогона', () => {
    test('константа 90000 объявлена ровно один раз и в блоке констант', () => {
      expect(countOf(LOADER, 'LOADER_RUN_WALL_CLOCK_MS = 90000')).toBe(1);
      const line = LOADER.split('\n').find((l) => l.includes('LOADER_RUN_WALL_CLOCK_MS = 90000'));
      expect(line).toMatch(/^ {2}var LOADER_RUN_WALL_CLOCK_MS = 90000;$/);
    });

    test("doneReason = 'wall-clock-timeout' встречается ровно один раз", () => {
      expect(countOf(LOADER, "doneReason = 'wall-clock-timeout'")).toBe(1);
    });

    test('runStartAt объявлен до цикла, один раз (нет сброса внутри итерации)', () => {
      expect(countOf(LOADER, 'var runStartAt = Date.now();')).toBe(1);
      // между отсчётом и циклом стоит только сброс UI-латча (v1.17a) — сам отсчёт не сбрасывается
      expect(LOADER).toMatch(/var runStartAt = Date\.now\(\);[^\n]*\n\s*D\.aiCmUiOverlayTimedOut = false;[^\n]*\n\s*while \(true\) \{/);
      expect(countOf(LOADER, 'runStartAt = Date.now()')).toBe(1);
    });

    test('guard — ПЕРВАЯ строка тела while (срабатывает до любой курсорной логики)', () => {
      expect(LOADER).toMatch(
        /while \(true\) \{\n\s*if \(Date\.now\(\) - runStartAt > LOADER_RUN_WALL_CLOCK_MS\) \{ doneReason = 'wall-clock-timeout'; break; \}/
      );
    });

    test('guard не зависит от pendingCursor (fail-safe при живом курсоре)', () => {
      const guard = LOADER.split('\n').find((l) => l.includes('LOADER_RUN_WALL_CLOCK_MS) {'));
      expect(guard).toBeTruthy();
      // в комментарии-обосновании pendingCursor упомянут намеренно; проверяем сам КОД строки
      const code = guard.replace(/\/\/.*$/, '');
      expect(code).not.toContain('pendingCursor');
      expect(code).not.toContain('D.');
      expect(code).toContain('break;');
    });

    test('курсорная логика обхода не тронута (LOADER_MAX_ITER/pendingCursor на месте)', () => {
      expect(LOADER).toContain('LOADER_MAX_ITER');
      expect(LOADER).toContain('pendingCursor');
      expect(countOf(LOADER, 'var LOADER_MAX_ITER')).toBe(1);
    });
  });

  describe('D3: findScrollContainer обходит только поддерево main', () => {
    test("литерал document.querySelectorAll('*') в модуле отсутствует", () => {
      expect(countOf(HIDDEN, "document.querySelectorAll('*')")).toBe(0);
    });

    test("document.querySelector('main') присутствует (findScrollContainer + рентген)", () => {
      expect(countOf(HIDDEN, "document.querySelector('main')")).toBeGreaterThanOrEqual(1);
      // рентген тоже переведён на поддерево main — иначе глобальный обход вернулся бы через него
      expect(HIDDEN).toContain("var root = document.querySelector('main'); var all = root ? root.querySelectorAll('*') : [];");
    });

    test('ветка !root: громкий лог + return null, без поиска по document', () => {
      const guards = HIDDEN.split('\n').filter((l) => l.includes('if (!root)'));
      expect(guards).toHaveLength(1);
      expect(guards[0]).toContain("debugLog('log', '[AI CM][scroll] findScrollContainer: main отсутствует — null')");
      expect(guards[0]).toContain('return null;');
    });

    test('document/window-фолбэк makeScroller(null) удалён', () => {
      expect(countOf(HIDDEN, 'makeScroller(null)')).toBe(0);
    });

    test('HINT и фильтры сохранены; добавлены v88-якорь и clientHeight>0', () => {
      expect(HIDDEN).toContain('var HINT = /conversation|message|chat-turn|response|scroll|turn-list|infinite|virtual/i;');
      expect(HIDDEN).toContain("if (st !== 'auto' && st !== 'scroll' && st !== 'overlay') continue;");
      expect(HIDDEN).toContain('if (sh <= ch + 50) continue;');
      expect(HIDDEN).toContain('if (!(ch > 0)) continue;');
      expect(HIDDEN).toContain("el.closest('infinite-scroller.chat-history, [class*=\"chat-history\"]')");
      expect(HIDDEN).toContain("try { hay = el.tagName + ' ' + el.className + ' ' + el.id; } catch (e) { }");
      // v88: generic best-fallback удалён, а не просто переставлен
      expect(HIDDEN).not.toContain('bestH');
      expect(HIDDEN).not.toContain('if (best) return best;');
    });
  });

  describe('D4: поведение — hint важнее максимальной высоты', () => {
    test('findScrollContainer() возвращает hinted узел, хотя он НИЖЕ второго', () => {
      const hintedEl = makeEl('INFINITE-SCROLLER', 'chat-history', 5000, 900);
      const plainEl = makeEl('DIV', 'side-panel', 20000, 900, false);
      const log = [];
      const api = loadHidden(docWithMain([plainEl, hintedEl]), log);

      const sc = api.findScrollContainer();
      expect(sc).toBeTruthy();
      expect(sc.mode).toBe('el');
      expect(sc.el).toBe(hintedEl);
      expect(sc.height()).toBe(5000);
      expect(sc.tag).toBe('infinite-scroller.chat-history');
      expect(log.filter((l) => l.level === 'error')).toHaveLength(0);
    });

    test('без HINT под якорем generic best удалён → null (скроллить нечего)', () => {
      const big = makeEl('DIV', 'side-panel', 20000, 900, false);
      const small = makeEl('DIV', 'chat-body', 5000, 900);
      const log = [];
      const api = loadHidden(docWithMain([small, big]), log);

      expect(api.findScrollContainer()).toBeNull();
      expect(log.filter((l) => l.level === 'error')).toHaveLength(0);
    });

    test('main без скроллеров → null (скроллить нечего)', () => {
      const api = loadHidden(docWithMain([]), []);
      expect(api.findScrollContainer()).toBeNull();
    });
  });

  describe('D5 (v88): скелет-обёртка не побеждает реальную ленту', () => {
    test('sh=884/ch=0 проходит фильтр 50px, но отсекается clientHeight>0', () => {
      const skeleton = makeEl('DIV', '', 884, 0);
      const real = makeEl('INFINITE-SCROLLER', 'chat-history', 5000, 900);
      const log = [];
      const api = loadHidden(docWithMain([skeleton, real]), log);

      const sc = api.findScrollContainer();
      expect(sc).toBeTruthy();
      expect(sc.el).toBe(real);
      expect(sc.tag).toBe('infinite-scroller.chat-history');
      expect(log.filter((l) => l.level === 'error')).toHaveLength(0);
    });

    test('скелет под якорем и с HINT, но ch=0 и ВЫШЕ ленты — всё равно отсечён', () => {
      const skeleton = makeEl('DIV', 'infinite-scroller chat-history', 9000, 0);
      const real = makeEl('INFINITE-SCROLLER', 'chat-history', 5000, 900);
      const api = loadHidden(docWithMain([skeleton, real]), []);

      expect(api.findScrollContainer().el).toBe(real);
    });
  });

  describe('D6: поведение — main отсутствует', () => {
    test('возвращает null, не бросает и не обходит document', () => {
      const log = [];
      const doc = {
        querySelector: () => null,
        querySelectorAll: () => { throw new Error('обход document запрещён (v1.17)'); },
        body: {}, documentElement: {}, scrollingElement: null,
        visibilityState: 'visible', addEventListener() { }
      };
      const api = loadHidden(doc, log);

      let out;
      expect(() => { out = api.findScrollContainer(); }).not.toThrow();
      expect(out).toBeNull();

      const hit = log.find((l) => l.level === 'log' && l.line.includes('findScrollContainer: main отсутствует'));
      expect(hit).toBeTruthy();
      expect(hit.line).toContain('[AI CM][scroll]');
    });
  });

  describe('R2: модуль грузится и экспорты не переименованы', () => {
    test('загрузка в vm без бросаний; triggerUp/settleBottom/findScrollContainer на месте', () => {
      const api = loadHidden(docWithMain([]), []);
      expect(api).toBeTruthy();
      for (const name of ['triggerUp', 'settleBottom', 'findScrollContainer']) {
        expect(typeof api[name]).toBe('function');
      }
      expect(typeof api.__bind).toBe('function');
      expect(typeof api.rontgenScroll).toBe('function');
    });
  });
});
