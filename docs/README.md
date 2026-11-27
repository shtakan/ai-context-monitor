# Документация проекта

**Состояние:** 2026-11-27, ветка `feature/2.2`, версия 2.4.0
(релиз готовится).

## Точка входа

- `../PROJECT_HANDOFF.md` — актуальный handoff: состояние, метрики, коммиты,
  открытые вопросы.
- `../STATE.md` — короткий проверяемый срез репозитория.
- `../CHANGELOG.md` — `[2.4.0] - Unreleased` и предыдущие релизы.

## Браузерные задачи

| Документ | Содержание |
|---|---|
| `BROWSER-MEDIATORS.md` | `bsk` vs CDP, safety-правила, глобальная инструкция |
| `BROWSER-TASK-PROTOCOL.md` | бюджет, пре-флайт, порядок сбора данных |
| `BSK-CHEATSHEET.md` | команды/лимиты bsk, специфика площадок |
| `SITE-RECIPES.md` | рецепты конкретных сайтов |

## Архитектура и качество

| Документ | Содержание |
|---|---|
| `../ARCHITECTURE_STANDARDS.md` | архитектурные правила и границы модулей |
| `../CLINE_PROMPT_RULES.md` | правила промптов/сессий |
| `COORDINATION-RULES.md` | роли и порядок задач (DSH/act/review) |
| `STANDARDS-MATRIX.md` | матрица стандартов и регистрация отклонений |
| `TESTS.md` | тестовый контур и гейты |
| `QUALITY_AUDIT.md` | исторический аудит качества (legacy) |
| `HANDOFF_ARCHIVE.md` | архив handoff-записей и residual-точек |

## Приёмка 2.4

Вне репозитория, в `acceptance/BIG-2026-11/2.4/`:

- `PLAN-2.4.md` — этапы и целевые метрики;
- `RELEASE-2.4.md` — релизный чек-лист и решение по Qwen JSON;
- `STAGE9-CONTENT-3200.md` — Stage 9 + live smoke;
- `QWEN-JSON-FILES.md` — `id`/`files` и безопасный манифест;
- `mini/` — PDF Chrome/Firefox, диагностика, BYOK, Qwen JSON.

## Правила

- Коммиты/теги/push — по команде владельца; релиз — в самом конце.
- `dist/`, `dist-firefox/`, `coverage/`, `artifacts/`, `tools/_*` — вне git;
  тяжёлые артефакты не коммитятся.
- Живая приёмка — только на актуальном `dist`/`dist-firefox`.
