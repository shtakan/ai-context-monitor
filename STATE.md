# STATE — ai-context-monitor

Правило: только проверяемые значения. Неизвестно → `?`.
Обновлено 2026-11-28.

## 1. Репозиторий

- workspace: `ai-context-monitor-clean`
- branch: `feature/2.2`; HEAD — `git log -1`; `origin/feature/2.2`
  синхронизирован; ahead 0; behind 0
- version: `2.4.1` (`manifest.json`, `package.json`, `package-lock.json`);
  релиз `v2.4.1` готовится; `v2.4.0` опубликован 2026-11-27, AMO 2.4.0
  одобрена
- теги: `v2.4.0` → `f8c2a33`; `v2.4.0-bug25` → `e85e063`; `v2.2.1` →
  `231a3fb`; `v2.2.0` → `ab9e7b7`
- `main` синхронизирован с `feature/2.2`

## 2. Метрики (2026-11-28)

- `content.ts`: **3 005** строк (цель ≤3 200)
- `processAndSend`: **397** строк (цель ≤400)
- tests: **311 suites / 4762 passed / 7 skipped / 0 failed**
- eslint: **0 errors / 0 warnings** (`lint:baseline`)
- catch-hygiene: **13/13**, 422 записи
- architecture-lint: **0** (222 файла)
- `build` / `build:prod`: exit 0
- `tsc --noEmit`: **0**

## 3. Текущая задача

Подготовка релиза 2.4.1: бамп и CHANGELOG сделаны; осталось решение
владельца по тегу/Release/AMO/desktop. Независимо: dependabot PR и
live-хвосты Firefox/Chrome opt-out.

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

- Qwen history timing: финальный assistant после F5 приходит `done=false`;
  закрыто pending-assistant + live-tail журналом (BUG-25, CLOSED).
- PDF Firefox: temporary add-on; профиль-копия `C:\Temp\firefox-aicm`.
- Firefox: автоматический live-tail restore и opt-out live ещё не проверены
  (unit-тесты и Chrome live есть).
- Dependabot: 5 PR (eslint 10, globals 17.14, TS 7, jsdom 30, pdfjs 6) ждут
  rebase/проверки; мажорные требуют отдельного решения.
