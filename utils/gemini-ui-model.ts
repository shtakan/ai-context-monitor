/**
 * utils/gemini-ui-model.ts
 * Определение модели Gemini, ВЫБРАННОЙ в веб-UI (T1: вынесено из core/content.ts).
 *
 * Зачем отдельный модуль. Логика v47–v50 (checked-пункт меню моделей + текст кнопки
 * композера) жила внутри core/content.ts без единого unit-теста (аудит T1 в
 * docs/QUALITY_AUDIT.md). Здесь она становится чистым ES-модулем с внедрением
 * зависимостей: `document`, реестр моделей и кэш «последнее точное имя по семейству»
 * приходят аргументами (GeminiUiModelDeps), поэтому функции исполняются в jsdom-
 * фикстурах (tests/adapters/gemini-ui-model.test.js) без загрузки всего контент-
 * бандла, без глобалов и без chrome.*.
 *
 * Слои сигналов по убыванию точности (перенесено из content.ts без изменения логики):
 *   (1) checked-пункт открытого меню ([aria-checked="true"]) — точная версия;
 *   (2) текст кнопки выбора модели в композере (button.input-area-switch) — версия+
 *       семейство или только семейство (тогда берётся последняя известная точная
 *       версия этого семейства: кэш → снимок сети → семейный дефолт ModelConfig);
 *   (3) нет сигнала / не распознан → фолбэк вызывающего кода на снимок сети и
 *       DOM-адаптер. Эта лестница осталась в core/content.ts:resolveCurrentModel —
 *       модуль отвечает ТОЛЬКО за UI-слой.
 *
 * Инварианты, унаследованные от прежней реализации (пинятся тестами):
 *   - длина кандидата текста > 60 символов отбрасывается;
 *   - без номера версии нужен префикс/слово gemini (страховка от ложных срабатываний);
 *   - кэш обновляется ТОЛЬКО точным именем (когда версия есть в UI или в меню);
 *   - «род варианта» не важен: «Расширенный» и «Расширенная» — один вариант.
 */

/** Запись реестра моделей, нужная резолверу (полная форма — types/model.d.ts:ModelRecord). */
export interface GeminiUiModelRecord {
  /** Отображаемое имя модели ('3.6 Flash', …). */
  name?: string;
}

/**
 * Порт реестра моделей (utils/model-config.ts:ModelConfig) — только три метода,
 * которые реально нужны UI-детектору. В расширении приходит настоящий ModelConfig,
 * в тестах — он же (tests/helpers/load-esm.js) или минимальная заглушка.
 */
export interface GeminiUiModelConfigPort {
  /** Канонический id по сырому имени/слагу (null — не распознан). */
  resolveModelId(raw: string | null | undefined): string | null;
  /** Запись каталога по id (null — id вне каталога). */
  getModel(modelId: string): GeminiUiModelRecord | null;
  /** Семейный дефолт веб-UI: ('flash', '') → 'gemini-3.6-flash' и т.п. */
  getFamilyDefaultModelId(fam: string, variant?: string): string | null;
}

/**
 * Зависимости детектора. Передаются объектом, чтобы тест мог подставить
 * jsdom-document, заглушку реестра и собственный кэш.
 */
export interface GeminiUiModelDeps {
  /** Документ, из которого читается UI (в расширении — глобальный document). */
  document: Document;
  /** Реестр моделей (в расширении — ModelConfig). */
  modelConfig: GeminiUiModelConfigPort;
  /**
   * Кэш «последнее точное имя по семейству»: ключ 'pro'|'flash'|'ultra' → имя
   * ('3.1 Pro'). Живёт у вызывающего кода (core/content.ts:geminiUiModelByFamily),
   * потому что переживает вызовы и общий для меню и кнопки.
   */
  cache: Record<string, string>;
}

/**
 * Регэксп модели в тексте UI: необязательный префикс gemini, необязательная версия
 * (`3.6`, `3,6`), семейство (ultra|pro|flash), необязательный вариант (lite /
 * расширенн* / extended / fast).
 */
export const GEMINI_UI_MODEL_RE: RegExp =
  /(?:gemini\s*)?(\d+(?:[.,]\d+)?)?\s*(ultra|pro|flash)(?:\s+(?:lite|расширенн[аяый]|extended|fast))?/i;

/** Семейство модели по имени: 'ultra'|'pro'|'flash' ('' — не найдено). */
function modelFamilyOf(name: string): string {
  const m = String(name || '').match(/ultra|pro|flash/i);
  return m ? m[0].toLowerCase() : '';
}

/**
 * v48: нормализация слитного текста кнопки («ProРасширенный» → «Pro Расширенный»).
 * Вставляет пробел на границе строчная→заглавная (латиница и кириллица) и сжимает
 * пробельные серии. На входе — сырой textContent, на выходе — текст для регэкспа.
 */
export function normalizeUiModelText(text: string): string {
  return String(text || '')
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Извлекает короткое имя модели из произвольного текста узла.
 *
 * Возврат: имя (match[0]) либо '' — если текст пуст, длиннее 60 символов, не
 * содержит семью модели или не содержит ни версии, ни слова gemini.
 */
export function extractUiModelText(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return '';
  const m = t.match(GEMINI_UI_MODEL_RE);
  if (!m) return '';
  // страховка от ложных срабатываний: нужна версия ИЛИ слово gemini
  if (!m[1] && !/gemini/i.test(t)) return '';
  return m[0].trim();
}

/**
 * Слой (1): имя модели из checked-пункта открытого меню.
 *
 * Ищем среди [role="menuitemradio"|"menuitem"|"option"] элемент, у которого
 * aria-checked="true" стоит сам или на потомке (галочка внутри пункта), и берём
 * первый распознанный текст. Возврат: имя либо ''.
 */
export function probeGeminiUiMenuChecked(doc: Document): string {
  const items = doc.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.getAttribute('aria-checked') !== 'true' && !it.querySelector('[aria-checked="true"]')) continue;
    const name = extractUiModelText(it.textContent);
    if (name) return name;
  }
  return '';
}

/**
 * v49: семья (+вариант без версии) → канонический id. Приоритет точной версии:
 *  (a) кэш точного имени из открытого меню (deps.cache);
 *  (b) точная версия из сетевого снимка (snapModelId), если семья совпадает с DOM-семьёй;
 *  (c) семейный дефолт ModelConfig (реальная линейка веб-UI, не анонс).
 * Род варианта не важен («Расширенный» == «Расширенная»).
 */
export function resolveFamilyVariantId(
  deps: GeminiUiModelDeps,
  fam: string,
  variant: string,
  snapModelId: string | null
): string | null {
  const modelConfig = deps.modelConfig;
  // (a)
  const cached = deps.cache[fam];
  if (cached) {
    const cachedId = modelConfig.resolveModelId(cached);
    if (cachedId) return cachedId;
  }
  // (b) сетевой снимок честен («3.6 Flash» / «3.1 Pro») — берём, если семья совпадает
  if (snapModelId) {
    const snap = modelConfig.getModel(snapModelId);
    const snapName = (snap && snap.name) || '';
    const snapFam = snapName.match(/ultra|pro|flash/i);
    if (snapFam && snapFam[0].toLowerCase() === fam) return snapModelId;
  }
  // (c) реальный семейный дефолт веб-UI («3.6 Flash», «3.1 Pro», «3.5 Flash Lite»)
  const defId = modelConfig.getFamilyDefaultModelId(fam, variant);
  if (defId) return defId;
  // страховочный фолбэк — всё же сетевая версия
  return snapModelId || '';
}

/**
 * Слой (2): модель из текста кнопки композера.
 *
 * v48: реальный DOM Gemini — BUTTON.input-area-switch, текст слитный
 * («ProРасширенный», «FlashРасширенный», «Flash»). Кнопки нет → ''.
 * Версия прямо в кнопке → точное имя (и обновление кэша семьи); только семья
 * (+вариант) → resolveFamilyVariantId (кэш → снимок → семейный дефолт).
 */
export function probeGeminiUiButton(deps: GeminiUiModelDeps, snapModelId: string | null): string | null {
  const btn = deps.document.querySelector('button.input-area-switch');
  if (!btn || !btn.textContent) return '';
  const text = normalizeUiModelText(btn.textContent);
  const m = text.match(GEMINI_UI_MODEL_RE);
  if (!m) return '';
  const fam = modelFamilyOf(m[0]);
  if (!fam) return '';
  if (m[1]) { // версия есть прямо в кнопке — точное имя, обновляем кэш
    deps.cache[fam] = m[0].trim();
    return m[0].trim();
  }
  // только семья (+вариант): приоритеты v49 (кэш меню → снимок → семейный дефолт)
  const varM = m[0].match(/lite|расширенн[а-яё]*|extended|fast/i);
  const variant = varM ? varM[0] : '';
  return resolveFamilyVariantId(deps, fam, variant, snapModelId);
}

/**
 * Точка входа: имя модели, выбранной в UI Gemini ('' — UI-сигнала нет).
 *
 * Меню открыто → это самый точный сигнал, кэш «последняя по семейству» обновляется;
 * иначе — кнопка композера. Решение о фолбэке на сеть/DOM-адаптер принимает
 * вызывающий код (core/content.ts:resolveCurrentModel), а не этот модуль.
 */
export function detectSelectedModelFromDom(deps: GeminiUiModelDeps, snapModelId: string | null): string {
  const fromMenu = probeGeminiUiMenuChecked(deps.document);
  if (fromMenu) {
    const fam = modelFamilyOf(fromMenu);
    if (fam) deps.cache[fam] = fromMenu;
    return fromMenu;
  }
  return probeGeminiUiButton(deps, snapModelId) || '';
}
