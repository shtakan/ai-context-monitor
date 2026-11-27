# STATE — ai-context-monitor

Правило: только проверяемые значения. Неизвестно → `?`.
Обновлено 2026-11-27.

## 1. Репозиторий

- workspace: `ai-context-monitor-clean`
- branch: `feature/2.2`; HEAD `a48d3e5`; `origin/feature/2.2` = `a48d3e5`;
  ahead 0; behind 0
- version: `2.2.0` (`manifest.json`, `package.json`); релиз 2.4.0 не выпущен
- теги: `v2.2.1` → `231a3fb`; `v2.2.0` → `ab9e7b7`
- `main` = `a17cd1c` (не синхронизирован с docs by design)

## 2. Метрики 2.4 (2026-11-27)

- `content.ts`: **3 005** строк (цель ≤3 200)
- `processAndSend`: **397** строк (цель ≤400)
- tests: **309 suites / 4743 passed / 7 skipped / 0 failed**
- eslint: **0 errors**, 11 warnings
- catch-hygiene: **13/13**, 422 записи
- architecture-lint: **0** (344 файла)
- `build` / `build:prod`: exit 0
- `tsc --noEmit`: 7 прежних ошибок Stages 1–5 (без новых)

## 3. Текущая задача

Подготовка релиза 2.4.0 (по команде владельца):
bump, CHANGELOG, финальный smoke, тег/Release/ZIP.

## 4. Живая приёмка

- 2.3: 8 площадок PASS.
- 2.4 smoke: Gemini, ChatGPT, Qwen, AI Studio, Claude, Perplexity, GSA — PASS.
- PDF Chrome: PASS; PDF Firefox: PASS (pdf.js local fallback на Qwen после F5).
- BYOK exact-off AI Studio / exact-on Gemini: PASS.
- Диагностика AI Studio: PASS.

## 5. Инфраструктура

- Browser: `bsk` по умолчанию; CDP — `C:\Users\oleg\browser-mediators`
  (`start-chrome.ps1`, `cdp-eval.mjs`, `cdp-shot.mjs`); глобальная инструкция
  `browser-mediators/GLOBAL.md` подключена.
- Документация: `docs/README.md`, `PROJECT_HANDOFF.md`.
- Acceptance 2.4: `acceptance/BIG-2026-11/2.4/`.

## 6. Известные ограничения

- Qwen history timing: финальный assistant после F5 может быть `done=false`.
- PDF Firefox: temporary add-on; профиль-копия `C:\Temp\firefox-aicm`.
- `tsc` ошибки Stages 1–5 — известные, не блокируют build.
