# UI/UX аудит расширения AI Context Monitor (Qwen Studio)

**Дата:** 2026-09-28  
**Аудитор:** Qwen3.8-Omni-Flash (Qwen Studio), по видео и скриншотам  
**Верификация:** DSH, сверка по коду репозитория (`core/widget.js`, `core/content.js`, `tests/thresholds.test.js`)  
**Статус:** вход в работу; скоуп фиксов определяет владелец

---

## Что проверялось

Три поверхности UI расширения:

1. **Плавающий круглый индикатор** — fixed, правый нижний угол viewport.
2. **Тултип при наведении** — появляется по hover, скрывается при уходе курсора.
3. **Панель по клику** — открывается/закрывается левым кликом.

Материалы: 3 коротких видео (idle→hover→leave; click→panel→click; resize wide→narrow) и 5 скриншотов (индикатор light, тултип light, панель top/bottom light, панель dark).

---

## Верификация по коду — что Qwen не мог знать

Qwen оценивал только визуальные материалы и не имел доступа к исходникам. Три его находки проверены по коду и **сняты или переформулированы**.

### Снято: ложный Critical про перехват кликов корневым оверлеем

Qwen предположил, что корневой контейнер расширения — full-screen оверлей, способный перехватывать клики по всей странице. Проверка: `core/widget.js:463-466` — контейнер `#ai-context-widget` создаётся как `div` с `position: fixed; bottom: 24px; right: 24px;` и не имеет ни full-screen размеров, ни фоновой заливки. Оверлея поверх страницы нет. Находка **снята**.

### Снято: tooltip и panel одновременно видимы

Qwen отметил конфликт видимости тултипа и панели. Проверка: `core/widget.js:465` содержит правило `#ai-context-widget.ai-panel-open .ai-widget-tooltip { visibility: hidden !important; opacity: 0 !important; }`, а `core/widget.js:484` при открытии панели вешает класс `ai-panel-open`. Конфликт **уже закрыт в коде**, находка снята.

### Переформулировано: цвет кольца vs пороги 70/85/95

Qwen написал: «77.5% не должно быть красным, если danger-порог 85%». Факт неверен: при 77.5% кольцо жёлтое (`zoneColor`, `core/widget.js:23`: `p < 50 → #22c55e`, `p < 80 → #eab308`, иначе `#ef4444`).

Но проверка вскрыла **реальную проблему объяснимости**, которую Qwen нащупал косвенно:

- `zoneColor` (`core/widget.js:23`) — «зоны здоровья» кольца, границы **50 / 80**.
- Пороги **70 / 85 / 95** (`tests/thresholds.test.js`) — это `pickProactiveThreshold`, латч «один раз на разговор» для проактивных уведомлений и автоэкспорта.

Это две разные сущности с разным назначением, но пользователь видит в настройках 70/85/95 и рядом кольцо, желтеющее на 50%. Он не может понять связь. Фикс — не в коде цвета, а в UI: подписать, что цвет = зоны 50/80, а пороги 70/85/95 = уведомления.

### Снято: z-index конфликт

Qwen предложил развести z-index индикатора, тултипа и панели. Проверка: `core/widget.js:465` — контейнер `z-index: 999999`, панель `z-index: 1000000`. Слои уже разведены, находка снята.

---

## Приведённая таблица находок

Severity пересчитаны по результатам сверки: где код уже закрывает пункт — снято; где назначение перепутано — переформулировано; остальное сохранено с понижением, где Qwen завышал.

| # | Проблема | Стандарт | Severity | Конкретный фикс | Верификация |
|---|---|---|---|---|---|
| 1 | Индикатор перекрывает поле ввода и кнопку отправки при узкой ширине окна | WCAG 2.2 AA 1.4.10 Reflow; HIG: don't obscure controls | **Critical** | Collision-safe positioning: вычислять `--acm-safe-bottom` до верхней границы нижнего хост-контрола (`textarea, [contenteditable], button[type=submit]`) + 12px; `bottom: max(12px, var(--acm-safe-bottom))`. При большом значении — edge-режим (28×44, `border-radius: 8px 0 0 8px`), полный круг на hover/focus | ✅ подтверждено владельцем |
| 2 | Индикатор недоступен с клавиатуры, нет видимого фокуса | WCAG 2.2 AA 2.1.1 Keyboard; 2.4.7 Focus Visible; 4.1.2 Name, Role, Value | **Critical** | `tabindex="0"`, `role="button"`, `aria-expanded`, `aria-controls="ai-widget-panel"`; обработка Enter/Space; `.ai-widget-circle:focus-visible { outline: 2px solid; outline-offset: 2px; }`; перенос фокуса на первый элемент панели при открытии | ✅ grep: ARIA-атрибутов в `widget.js` нет |
| 3 | Иконка-индикатор не имеет доступного имени, screen reader объявит «button» | WCAG 2.2 AA 4.1.2; 2.5.3 Label in Name | **Major** | Динамический `aria-label`: `AI Context Monitor: 77.5% context used, warning. Open settings.` Обновлять при смене процента | ✅ подтверждено |
| 4 | Tooltip исчезает сразу при уходе курсора, его нельзя прочитать | WCAG 2.2 AA 1.4.13 Content on Hover or Focus | **Major** | `pointer-events: auto` на тултипе; показ через 150ms, скрытие через 300ms после `mouseleave`; закрытие по Escape | ✅ подтверждено |
| 5 | Текст процента внутри кольца может плохо читаться на жёлтом фоне | WCAG 2.2 AA 1.4.3 Contrast; 1.4.11 Non-text Contrast | **Major** | Подложка под текст: `background: color-mix(in srgb, var(--w-tooltip-bg) 88%, transparent); border-radius: 999px; padding: 1px 4px;`. Для жёлтого статуса запрещён белый текст | ✅ подтверждено |
| 6 | Hit-area индикатора меньше 44×44 при уменьшении | WCAG 2.2 AA 2.5.8 Target Size; HIG 44×44 pt | **Major** | Круг 64×64 уже ≥ 44 (ок); в edge-режиме сохранить `block-size: 44px` | ⚠️ текущий круг 64px — ок, требование актуально для edge-режима |
| 7 | Статус передаётся только цветом; при дальтонизме green/yellow/red неразличимы | WCAG 2.2 AA 1.4.1 Use of Color | **Major** | Нецветовой индикатор: glyph/text `✓ OK` / `! Warning` / `× Critical` рядом с процентом; в тултипе строка `Status: Warning (zone 80%)` | ✅ подтверждено |
| 8 | Tooltip при узком окне выходит за viewport или закрывает input хост-страницы | WCAG 2.2 AA 1.4.13; 1.4.10 Reflow | **Major** | `position: fixed; inline-size: min(320px, calc(100vw - 24px)); max-block-size: 40vh; overflow: auto;`. Flip: если `tooltip.top < 8px` — позиционировать ниже индикатора | ✅ подтверждено |
| 9 | Панель при узкой ширине/низком окне выходит за viewport | WCAG 2.2 AA 1.4.10 Reflow | **Major** | `.ai-widget-panel { inline-size: min(360px, calc(100vw - 24px)); max-block-size: calc(100vh - 88px); overflow-y: auto; overscroll-behavior: contain; }`. Flip по вертикали | ✅ подтверждено |
| 10 | Панель настроек перегружена: API key, diagnostics, archives видны наравне с базовыми | Nielsen #8 Aesthetic and minimalist design; M3 hierarchy | **Major** | Секции `Display`, `Notifications`, `Export`, `Advanced`; API key / diagnostic export / archives import — в `<details>` закрытый по умолчанию | ✅ подтверждено |
| 11 | Тёмная тема хост-страницы может давать низкий контраст, если цвета наследуются | WCAG 1.4.3 Contrast; M3 dark theme | **Major** | Не наследовать цвета хоста; собственные токены светлой/тёмной темы; проверка secondary text ≥ 4.5:1 | ⚠️ тема поддерживается (`applyNativeStyles`), но собственные токены стоит зафиксировать |
| 12 | Поле API key без видимого label и toggle visibility | WCAG 3.3.2 Labels or Instructions; 4.1.2 | **Major** | `<label for="...">API key (BYOK)</label>`; `type="password"`, `autocomplete="off"`; кнопка-глаз с `aria-pressed` | ✅ подтверждено |
| 13 | Цвет кольца (зоны 50/80) не объяснён в UI рядом с порогами 70/85/95 | Nielsen #2 Match between system and real world | **Major** | Подпись в панели: «Цвет кольца: зоны 50% / 80%. Пороги 70/85/95 — уведомления и автоэкспорт». **Это переформулировка находки Qwen про несоответствие цвета порогам** | ⚠️ переформулировано (см. выше) |
| 14 | Индикатор может перекрывать скроллбар или fixed-элементы справа внизу | HIG: defer to user content; WCAG 1.4.10 | **Minor** | `right: calc(12px + var(--acm-scrollbar-width, 0px) + env(safe-area-inset-right, 0px))`; ширину скроллбара считать как `innerWidth - documentElement.clientWidth` | ✅ подтверждено |
| 15 | Панель закрывается только повторным кликом по индикатору; нет Escape и клика вне | WCAG 2.1.2 No Keyboard Trap; Nielsen #1 | **Minor** | Закрытие по Escape и по клику вне `.ai-widget-panel`/`.ai-widget-circle`; возврат фокуса на индикатор; `aria-modal="false"` | ✅ подтверждено |
| 16 | Типографика, отступы, радиусы различаются между тремя поверхностями | M3 tokens; HIG consistency; Nielsen #4 | **Minor** | Ввести CSS-токены `--w-font`, `--w-radius-s`, `--w-space-*` и применить ко всем трём поверхностям | ✅ подтверждено |
| 17 | Кнопки панели без явных hover/active/focus/disabled/loading состояний | M3 state layers; WCAG 2.4.7 | **Minor** | `:hover::before`, `:active::before`, `:focus-visible` outline, `[disabled] { opacity: .38 }`, `[data-loading] { cursor: progress }` + spinner | ✅ подтверждено |
| 18 | В длинной панели нет индикации скролла; кнопки экспорта уходят за край | Nielsen #1; M3 scroll affordance | **Minor** | Fade-маски сверху/снизу; sticky footer с кнопками экспорта | ✅ подтверждено |
| 19 | Русские/английские строки разной длины обрезаются или дают layout shift | WCAG 1.4.10; 2.5.3; i18n heuristic | **Minor** | Убрать фиксированные `width`; `flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere`; числовые поля `inline-size: 5ch`; проверка RU/EN на 320/768/1024/1280 px | ✅ подтверждено |
| 20 | Кнопки экспорта md/json/pdf/txt непонятны без контекста, неровно переносятся | Nielsen #6 Recognition rather than recall; 2.5.3 | **Minor** | Grid 2×2 `repeat(2, minmax(72px, 1fr))`; подписи `MD/JSON/PDF/TXT` + `aria-label="Export history as Markdown"`; MD — primary, остальные tonal | ✅ подтверждено |
| 21 | Поля порогов 70/85/95 без единицы измерения и визуальной валидации | WCAG 3.3.2; 3.3.3 Error Suggestion | **Minor** | Суффикс `%` в wrapper; `inputmode="numeric" min="1" max="100"`; при invalid — `aria-invalid="true"` + сообщение | ✅ подтверждено |
| 22 | В тултипе много технических данных без иерархии | M3 hierarchy; Nielsen #8 | **Minor** | Primary: `Model — tokens / limit` (13px/600); Secondary: `Site`, `Window`, `Source` (11px, variant color); разделитель между блоками; максимум 5 строк до скролла | ✅ подтверждено |
| 23 | Резкая смена цвета кольца без transition | M3 motion; Nielsen #1 | **Minor** | `.ai-widget-fill { transition: stroke .18s ease, stroke-dashoffset .18s ease; }` | ⚠️ `stroke-dashoffset 0.4s ease` уже есть; добавить `stroke` в transition |
| 24 | ~~Корневой оверлей перехватывает клики по всей странице~~ | — | ~~Critical~~ | ~~`pointer-events: none` на корне~~ | ❌ **снято:** оверлея нет (`widget.js:463`) |
| 25 | ~~Tooltip и panel видны одновременно~~ | — | ~~Major~~ | ~~скрывать tooltip при открытой панели~~ | ❌ **снято:** уже реализовано (`widget.js:465,484`) |
| 26 | ~~z-index конфликт трёх поверхностей~~ | — | ~~Major~~ | ~~развести z-index~~ | ❌ **снято:** 999999 / 1000000 (`widget.js:465`) |

**Итого:** 23 подтверждённые находки (2 Critical, 11 Major, 10 Minor), 1 переформулирована, 3 сняты как ложные.

---

## Top 3 фикса по ожидаемому эффекту

1. **Collision-safe positioning индикатора** (находка #1, Critical).  
   Сейчас расширение физически ломает основной workflow хост-страницы при узком окне: клик по полю ввода и кнопке отправки попадает в индикатор. Фикс: вычисление safe-bottom до нижнего хост-контрола или edge-режим «язычка» 28×44.

2. **Доступность индикатора** (находки #2, #3, #7, Critical + Major).  
   `tabindex`, `role="button"`, `aria-expanded`, `aria-controls`, `aria-label` с процентом и статусом, видимый `focus-visible`, нецветовой индикатор статуса. Закрывает сразу несколько WCAG AA пунктов.

3. **Разведение поверхностей и упрощение панели** (находки #4, #9, #10, Major).  
   Tooltip — hoverable с задержкой 300ms и flip; панель — `min(360px, 100vw - 24px)` и `calc(100vh - 88px)`; API key / diagnostics / archives — в `Advanced` details. Снижает визуальный шум, предотвращает overflow.

---

## Границы аудита

- Только UI/UX. Архитектурные и функциональные изменения не предлагались.
- Расширение — content script в сторонних страницах; не должно ломать, перестилизовывать или визуально менять хост-страницу за пределами своего оверлея.
- Без фреймворков, сборщиков и переписываний. Предложения — CSS / positioning / behavior в рамках существующего vanilla-JS MV3 расширения.

---

## Открытый вопрос владельцу

Скоуп фиксов не определён. Из 23 подтверждённых находок нужно решить, что идёт в работу сейчас, что — в backlog. Критичные (#1, #2) стоит брать первыми: #1 ломает клики на хост-странице, #2 — базовое WCAG-требование.

---

*Артефакт создан DSH по результатам аудита Qwen Studio. Severity верифицированы по коду репозитория на 2026-09-28.*

## Статус на 2026-09-28 (после решения владельца)

- Порядок работ согласован: **Critical (2) → Major (11, по поверхностям: panel / tooltip / options) → Minor (10)**.
- ✅ **Critical-батч закрыт коммитом `deab423`** (Critical #1 collision-safe positioning + Critical #2 доступность индикатора); доксинк хендоффа — `67d4e90`.
- Отклонение от рекомендации аудита по #1: edge-режим («язычок» 28×44) в эту итерацию **не вошёл** — 28px ширины меньше 44px (HIG), SVG 88% от 28px ≈ 24.6px, процент внутри кольца нечитаем; выбран вертикальный сдвиг, закрывающий корень (перекрытие кликов по полю ввода и кнопке отправки). Edge-режим — кандидат в отдельную итерацию визуального редизайна.
- Пункт «Скоуп фиксов не определён» выше **более не актуален** — решение принято и исполнено; исходная формулировка сохранена как след на дату аудита.
- Открыто: живая браузерная приёмка узкого окна (позиция доказана jsdom-пинами, не глазами); контрол выше потолка `min(40vh, 320px)` остаётся частично перекрыт — known limit.
