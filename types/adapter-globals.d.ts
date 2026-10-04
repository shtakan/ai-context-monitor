/**
 * Сквозной символ контент-скриптов: базовый класс адаптеров сайтов.
 *
 * Объявлен как ambient-класс, потому что адаптеры — НЕ модули: они грузятся как
 * отдельные файлы из manifest.json:51-58 (классические content_scripts MV3) и
 * склеиваются исходником в new Function()/eval песочницами тестов
 * (tests/deepseek-o7-hidden-export.test.js:468, tests/qwen-container-drop-o37.test.js:48).
 * Общей области видимости на уровне модуля у них нет, поэтому каждый
 * `class XAdapter extends BaseAdapter` (6 файлов) без этого объявления даёт TS2304.
 *
 * Тело класса НЕ дублируем: публичный контракт живёт в types/adapter.d.ts (Adapter),
 * а сами методы типизируются JSDoc прямо в adapters/*.js. Здесь нужна лишь форма,
 * по которой наследники видят базовые методы.
 *
 * ВАЖНО: список методов обязан быть ИСЧЕРПЫВАЮЩИМ. Наследники (qwen-adapter.js:141,403)
 * вызывают и внутренние хелперы базы — _safeQuerySelectorAll/_safeQuerySelector, —
 * а без них в ambient-форме tsc даёт TS2339. Underscore-хелперы в контракт
 * types/adapter.d.ts сознательно НЕ входят (они не часть публичного API адаптера),
 * поэтому объявлены здесь.
 */
declare class BaseAdapter {
  constructor();
  siteName: string;
  dialogContainerSelector: string;
  userMessageSelector: string;
  modelMessageSelector: string;
  isOnDialogPage(): boolean;
  extractMessages(): import('./adapter').ExtractedMessage[];
  getFullDialogText(): string;
  getMessageCount(): number;
  detectModel(): string | null;
  /** Внутренний хелпер базы; вне контракта Adapter, но наследники его зовут. */
  _getTextContent(element: Element | null): string;
  /** Внутренний хелпер базы; вне контракта Adapter, но наследники его зовут. */
  _safeQuerySelector(selector: string, parent?: Document | Element): Element | null;
  /** Внутренний хелпер базы; вне контракта Adapter, но наследники его зовут. */
  _safeQuerySelectorAll(selector: string, parent?: Document | Element): NodeList | Element[];
}
