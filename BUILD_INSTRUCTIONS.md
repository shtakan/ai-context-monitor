# Build instructions — AI Context Monitor 2.0.36

Один и тот же исходник собирается в две цели:

| Каталог | Браузер | Что это |
| --- | --- | --- |
| `dist/` | Chrome, Edge (Chromium, MV3) | распакованное расширение: «Загрузить распакованное» → `dist/` |
| `dist-firefox/` | Firefox 140+ (AMO) | тот же код с Firefox-манифестом (`browser_specific_settings`, без хоста `generativelanguage.googleapis.com`) |

Обе цели создаёт один скрипт `build.mjs` (esbuild, без обфускации). Артефакт для AMO собран
из `dist-firefox/` в режиме по умолчанию (без `--minify`, sourcemaps включены).

## For AMO reviewers (English)

Requirements: Node.js 20.x LTS or 24.x (verified on 24.18.0), npm 10.x or newer (verified on
12.2.0). Dependencies are installed from the committed `package-lock.json`; no network access is
needed beyond the npm registry, and no build step downloads or generates code.

```
npm ci
node build.mjs
```

`node build.mjs` writes `dist/` (Chromium) and `dist-firefox/` (Firefox). The submitted package
is built from `dist-firefox/`. To reproduce the submitted ZIP from `dist-firefox/`:

```
cd dist-firefox
tar -a -c -f ../ai-context-monitor-firefox.zip *
```

(`tar -a` picks ZIP by extension on Windows 10+; on macOS/Linux use `zip -r ../ai-context-monitor-firefox.zip .`)

Optional checks: `npx jest` (test suite) and `npx tsc --noEmit` (type check, JavaScript checked
with `checkJs`). Neither is required to build.

## Требования

- **Node.js**: 20.x LTS или 24.x. Проверено на Node **24.18.0**.
- **npm**: 10.x или новее. Проверено на npm **12.2.0**.
- `package-lock.json` закоммичен и используется как единственный источник версий
  (`npm ci` ставит ровно зафиксированное дерево; `npm install` не нужен).
- Внешних CLI-инструментов (zip-утилит, make, python) сборка не требует: `esbuild` — локальная
  devDependency из `node_modules`.

## Команды

```bash
npm ci            # установка зависимостей строго по package-lock.json
node build.mjs    # сборка: dist/ + dist-firefox/
```

Режимы `build.mjs`:

```bash
node build.mjs --minify        # прод-режим (без sourcemaps)
node build.mjs --no-sourcemap  # без .map при dev-сборке
node build.mjs --clean         # удалить dist/ и dist-firefox/ и выйти
```

Для Chrome/Edge используется `dist/`, для Firefox (AMO) — `dist-firefox/`. Обе папки
самодостаточны: `dist/` содержит `manifest.json` Chromium, `dist-firefox/` — Firefox-манифест.

## ZIP для AMO (готовый пакет расширения)

```bash
cd dist-firefox && tar -a -c -f ../ai-context-monitor-firefox.zip *
```

## Пакет исходников для AMO (source code submission)

Пакет собирается из закоммиченных файлов HEAD, без `node_modules/`, без медиа и без служебных
документов (`docs/videos/`, `docs/screenshots/`, `PROJECT_HANDOFF.md`, `CHANGELOG.md`,
`plan-*.md`, `step-*`), без логов и посторонних `.zip`/`.diff`/`.txt`.

PowerShell из корня репозитория (команда проверена на этом дереве: 88 файлов, посторонних нет):

```powershell
$inc = '^(build\.mjs|package\.json|package-lock\.json|manifest\.json|tsconfig\.json|eslint\.config\.mjs|LICENSE|README\.md|README\.en\.md|BUILD_INSTRUCTIONS\.md)$|^(core|utils|adapters|options|print|types|icons|_locales|privacy)/'
$files = git ls-files | Where-Object {
  $_ -match $inc -and $_ -notmatch '^(docs/)' -and $_ -notmatch '^tests/'
}
# список путей пишется с LF: CRLF ломает имена файлов в bsdtar -T
[System.IO.File]::WriteAllText("$PWD\source-files.txt", (($files -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
tar -a -c -f source-code-2.0.36.zip -T source-files.txt
Remove-Item source-files.txt
tar -tf source-code-2.0.36.zip | Select-String -Pattern 'videos|screenshots|PROJECT_HANDOFF|node_modules|\.zip$'
```

Последняя строка должна не напечатать ничего: она проверяет, что в пакет не попали видео,
скриншоты, `PROJECT_HANDOFF.md`, `node_modules/` и посторонние архивы.

Проверка воспроизводимости: распаковать пакет в пустой каталог, выполнить `npm ci` и
`node build.mjs` — полученный `dist-firefox/` должен совпасть с `ai-context-monitor-firefox.zip`
(пустой diff по содержимому файлов).

## Проверки (опционально, но так проверялся пакет)

```bash
npx jest                 # 204 suites / 3671 passed / 7 skipped
npx tsc --noEmit         # exit 0 (JavaScript под checkJs)
```

## Что НЕ входит в пакет исходников и почему

- `docs/videos/` (31 МБ), `docs/screenshots/` (2,7 МБ) — медиа для README/GitHub Pages, к сборке
  отношения не имеют.
- `PROJECT_HANDOFF.md` (1 МБ) — журнал состояния проекта, не исходник.
- `tests/` (5 МБ) — тестовый набор; ревьюеру для сборки не нужен, но он есть в публичном
  репозитории (`homepage_url` в манифесте).
- `node_modules/` — ставится из `package-lock.json` командой `npm ci`.
