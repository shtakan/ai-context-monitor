/**
 * Сквозной символ контент-скриптов: базовый класс адаптеров сайтов.
 *
 * ИСТОРИЯ: до шага 2 миграции TypeScript (adapters/*.js → adapters/*.ts) здесь жили
 * ambient-объявления `declare class BaseAdapter` и `declare class AistudioAdapter`.
 * Они были нужны, потому что адаптеры — НЕ модули: они грузятся отдельными файлами
 * manifest.json (классические content_scripts MV3) и склеиваются исходником в
 * new Function()/eval песочницами тестов, поэтому общей области видимости на уровне
 * модуля у них нет и `class XAdapter extends BaseAdapter` без объявления давал TS2304.
 *
 * ПОСЛЕ ПЕРЕВОДА НА TypeScript надобность отпала: файлы остались скриптами (без
 * верхнеуровневых import/export — иначе `import type` вынес бы класс из общего
 * лексического скоупа), и `class BaseAdapter`/`class AistudioAdapter` в
 * adapters/base-adapter.ts и adapters/aistudio-adapter.ts САМИ стали глобальными
 * объявлениями. Ambient-копии при этом давали TS2300 (duplicate identifier), поэтому
 * удалены; форма публичного контракта по-прежнему живёт в types/adapter.d.ts (Adapter),
 * а интерфейсы Message/Adapter/ExtractOptions объявлены в adapters/base-adapter.ts.
 *
 * Файл сохранён как маркер фазы: сюда вернётся объявление, если какой-то адаптер
 * придётся сделать модулем.
 */
