# Test Map & Smoke Matrix

This document maps the automated test suite to the modules and adapters it covers, lists the fixtures, and provides the manual smoke matrix used before releases.

Run everything with:

```bash
npm test
```

CI runs the same suite (plus syntax checks and `manifest.json` validation) in [.github/workflows/lint.yml](../.github/workflows/lint.yml) on every push to `main` and on pull requests.

## Test map

| Test file | Covers | Key scenarios |
|---|---|---|
| `tests/adapters/chatgpt.test.js` | ChatGPT conversation parser (`parseChatGPTConversation`) | result shape `{ messages, model, tokens }`; empty/invalid input; fixture parsing (`chatgpt-conversation.json`) |
| `tests/adapters/chatgpt-conversation-parser.test.js` | ChatGPT `/c/<id>` navigation + mapping linearization | chat-id extraction from path (reset only on a new non-empty id); chronological ordering of `mapping` (root = first user turn, no lost first exchange); live snapshot with system-root chain of 91 nodes; sanitization of `[entity]`/`[cite]` markers and PUA tokens (U+E000–U+F8FF), entity replaced by visible text |
| `tests/adapters/gemini.test.js` | Gemini batchexecute parser (`parseBatchExecute`) | result shape; empty input; fixture parsing (`gemini-batchexecute.json`) |
| `tests/adapters/gemini-batchexecute-parser.test.js` | Gemini history parser (`parseGeminiHistory`), thinking-run cleanup | attachment token stripping ($AXzLiR…); chronology inversion (newest→oldest raw); role separation; markdown tables kept in assistant messages; thinking-run skip (bare titles, English-only blocks dropped, mixed blocks stripped via `stripLeadingThinking`, canonical 3-segment turns collapsed to one answer); live-path run on synthetic min-fixture `gemini-head-sample.min.txt` |
| `tests/adapters/gemini-dom-parser.test.js` | Gemini DOM response extractor (`extractGeminiResponse`) | thinking text excluded; table rows as markdown; visible paragraph preserved with count > 0 |
| `tests/adapters/gemini-intercept-logic.test.js` | Gemini floor / vf5 rebuild / autoscroll logic | floor versioning by `PARSER_VERSION`; floor applied only when history incomplete; vf5 continuation-cursor vs full rebuild decision; global pagination ordering; scroll-stabilization heuristics; zero-floor diagnostics (`diagnoseFloorAbsence`); vf5 poller silence when complete+idle (`shouldPollVf5`); autoscroll retry policy (`shouldRetryAutoscroll`) |
| `tests/adapters/deepseek.test.js` | DeepSeek server-tokens parser (`parseDeepSeekResponse`) | result shape; empty/invalid input; server tokens from `accumulated_token_usage`; R1 model detection via `thinking_enabled`; fixture parsing (`deepseek-serverTokens.json`) |
| `tests/adapters/claude.test.js` | Claude conversation + SSE parsers | roles alternate human/assistant from `chat_messages`; assistant text includes thinking + text + tool blocks; empty `chat_messages` → 0 messages; SSE: model from `message_start`, chunk concatenation, `stopped` flag from `message_stop`, rate-limit field |
| `tests/adapters/perplexity.test.js` | Perplexity thread parser (`parsePerplexityThread`) | model/tokens/messages extraction; user text = `query_str`, assistant includes snippets; empty entries → 0 messages; whitespace-key tolerance (trim-equivalence) |
| `tests/adapters/google-folwr-open.test.js` | Google AI Search folwr-open HTML parser (`parseGoogleFolwrOpen`) | roles/texts in dialog order; tables & lists as markdown; `threadId` from `data-session-thread-id`; concatenated text/count; empty/invalid input; no web-search chip or foreign user reply leaking into assistant answer; folwr continuation cursor (`extractContinuationToken`), dedup merge (`mergeTurnsById`), completeness vs DOM (`mergeTurnsByKey`, `extractTurnsFromDocument`) |
| `tests/print/markdown.test.js` | `MarkdownRenderer.render` (PDF/print form) | tables; fenced code blocks with escaping; ul/ol lists; HTML escaping (&, quotes); H1–H2; inline code; safe link protocols (no `javascript:`); Cyrillic intact |
| `tests/print/options-export-txt.test.js` | popup/options txt-export button | click downloads same messages as reference export; disabled when no history for active tab |
| `tests/print/reference-text.test.js` | `buildReferenceText` | strict message order; markdown stripping (headings, bullets, bold/italic, quotes, rules, links, backticks); combined regression; single blank-line separators; LF endings, no BOM |
| `tests/messages-canonicalize-aistudio.test.js` | `utils/messages/canonicalize.ts` + `reconcile.ts` | AI Studio golden (6/7 ходов, first/last hash, `bodyHash`); склейка 9→7; role/tool/reasoning/ordinal; dedupe; reconcile net>dom, text-divergence, filled, turn-mismatch |
| `tests/big4-gemini-merge.test.js` | `utils/messages/turns.ts` + `core/gemini-ingest.js` | BIG-04: сегменты одного хода склеиваются; Deep Research с разными turnId — нет; пустые/не-массив; pair-dedupe хвоста в ingest |
| `tests/qwen-messages-dualrun.test.js` | `adapters/qwen-adapter.ts` (`capture`) + `core/qwen-dualrun.ts` | Qwen dual-run: состав/роли старого `extractMessages` vs `canonicalizeBatch`; same/diff, roleHash; без флага capture не вызывается; с флагом результат не меняется, рекурсии нет |
| `tests/messages-reconcile-qwen.test.js` | `utils/messages/reconcile.ts` + `canonicalize.ts` | I5 Qwen: live(dom)/reload(net) 10 ходов/20 сообщений; text-divergence не смешивается; пустой user добирается (filled); messageHash |
| `tests/inv-i3-export-projection.test.js` | `utils/export/projection.ts` + `core/export-manager.ts:aiCmProjectFileMessages` + `utils/export-text-builders.ts` | S5.1/I3: ON/OFF reasoning, скрытые поля, идемпотентность, 4 точки применения, MD/JSON/TXT паритет; канонический массив/bodyHash не меняются; шов вызывается через `aiCmExportProjectFileMessages` |
| `tests/export-sections.test.js` | `utils/export/sections.ts` | Фаза 4: artifact/artifacts Claude, sources Perplexity, reasoning-счётчик; дедуп артефактов/источников; мусор/пустой вход не создают секций; вход не мутируется |
| `tests/export-completeness.test.js` | `utils/export/completeness.ts` + мост content.ts | Фаза 4: все причины partial проходят; true без причины → incomplete; false/null → ключей нет; неизвестная причина сохраняется; мост в manual/auto/current-history |
| `tests/export-sections-builders.test.js` | `utils/export-text-builders.ts` + `utils/export/sections.ts` | Фаза 4: JSON artifacts/sources только при непустых секциях, в `messages` транспортных копий нет; MD `## ARTIFACTS`/`## SOURCES`; TXT `[ARTIFACTS]`/`[SOURCES]`; пустые секции не меняют байты |
| `tests/perplexity-sources-e2e.test.js` | `perplexity-parser.ts` + `export-emit-pipeline.ts` + `base-handler.ts` + builders | BUG-08: parser отдаёт sources, в text нет `[source]`; normalize/dedupe сохраняют sources; JSON/MD печатают секции, per-message `sources` в JSON отсутствуют |
| `tests/perplexity-sources-content-stage.test.js` | срез `core/content.ts` + `core/export-manager.ts` + `core/base-handler.ts` | PP-SOURCES-MISSING: sources доезжают до `aiCmBasePrepared`/`lastDetailMessages` и `aiCmCollectExportSource` (network); сообщения без секций новых ключей не получают |
| `tests/gsa-echo-clean.test.js` | `google-search-folwr-parser.ts` + `export/projection.ts` + `export-manager.ts` + builders | BUG-08: «Вы отправили … запрос "Q"» → Q, «Ответ в режиме ИИ … "Q"\n\nA» → A; чистое эхо → ''; хук только для `google_search`, прочие сайты без изменений; MD/JSON без обёрток |
| `tests/claude-artifact-capture.test.js` | срез `core/claude-intercept.js` (`parseHistory`) + `content.ts`/`export-manager.ts`/`base-handler.ts` + builders | BUG-09: `tool_use(Artifact).structured_content` + `create_file.input.file_text` → per-message `artifacts`; дубль метаданных склеен; artifact-only ход сохранён; content-стадия/collect не теряют; JSON top-level `artifacts`, MD/TXT-блоки, per-message копий в JSON нет |
| `tests/aistudio-messages-dualrun.test.js` | `core/aistudio-dualrun.ts` + `AistudioAdapter.capture()` | old merge vs canonicalize: verdict `same` на всех фикстурах; `roleHash`/`role-sequence`; diff на сыром 9A; флаг sessionStorage не включает capture при off; установщик идемпотентен |
| `tests/accept-compare.test.js` | `tools/accept-compare.js` | K1 (каноническое равенство с игнором `exportedAt`), K2 (`roleHash` + счётчики), stable stringify, first diff path |
| `tests/aistudio-export-roles.test.js` | `core/aistudio-dualrun.ts` + срезы `content.ts` | BUG-12: `aistudioDetailMessages` сохраняет роли/порядок/sections; `aiCmApplyAistudioNetBase` синхронизирует `lastDetailMessages`; `aiCmCollectExportSource` берёт роли из детали, не по индексу |
| `tests/aistudio-export-boundaries.test.js` | `core/base-handler.ts` | BUG-13: merge assistant-сегментов идёт **до** dedupe; дубли user не склеивают разные ответы; настоящие подряд идущие сегменты склеиваются |
| `tests/aistudio-export-dedupe.test.js` | `exportDedupeInfo` + `buildJsonFromHistory` + `aiCmExportDedupeInfoAuto` | BUG-13: `removedUsers`/`foldedAssistants`; ключ `dedupe` только при изменении счёта; авто-JSON получает тот же маркер, гейт платформы — в `content.ts`, не в export-manager |
| `tests/aistudio-autoexport-schedule.test.js` | `core/content.ts` (`aiCmAfterAistudioNetKick`) | BUG-14: сетевой путь AI Studio планирует автоэкспорт после `processAndSend` со свежим `lastPercentage`; база применяется до kick |
| `tests/metrics-seam.test.js` | `utils/metrics/{sources,limits,readiness,snapshot}.ts` + `core/metrics-dualrun.ts` | 2.2/фаза 2: native→server→base→dom→estimate; окно 1M ≠ порог 128k; `derived`/`floor` никогда не settled (F1: 683 при complete → provisional); `compare` называет поля; dual-run только AI Studio и только по флагу `aiCmV2Metrics` |
| `tests/metrics-badge-provisional.test.js` | `core/widget.ts` + `aiCmWidgetDataFromSnapshot` | пункт 4: provisional/derived/floor/collecting → `~N%`; exact/settled и legacy без полей → прежний `N%`; решение из `lastWidgetData`, не из платформы |
| `tests/aistudio-messages-default.test.js` | `aiCmV2AistudioExportSource` + `capture()`/`canonicalizeBatch` + `aiCmDedupeExportSource` | messages default: канон первым в `aiCmCollectExportSource`; дубли user сняты, три ответа не склеены (BUG-13); opt-out `aiCmV2Messages='0'`; прочие сайты → null |
| `tests/adapters/aistudio-network.test.js` | AI Studio network interceptor | history/usage parsing, file rows, model slug, dedupe, ResolveDriveResource; BUG-18: `pushState`/`replaceState`/`popstate` → `ai-cm-conversation-changed` на смену pathname, повтор пути — ноль событий |
| `tests/widget-reset-a11y.test.js` | `core/widget.ts` (`resetConversationState`) | BUG-19: сброс в «—» возвращает `aria-label` к `content_a11y_circle_initial`, не держит процент прошлого треда; локализованный ключ; source-пин |
| `tests/export-model-name-snapshot.test.js` | `core/content.ts` (manual) + `core/export-manager.ts` (auto) + `buildJsonFromHistory` | BUG-20: `model` ручного JSON и авто-файла берётся из `modelName` того же снимка, что бейдж; каталог/`lastSnapshotModelName` — фолбэк; JSON не пересчитывает model |

Helpers in `tests/helpers/*` wrap production parsers so tests exercise the exact shipped code.

## Fixtures

Sanitized, committed fixtures (`tests/fixtures/`):

| Fixture | Purpose |
|---|---|
| `chatgpt-conversation.json` | sanitized ChatGPT conversation with `mapping` structure |
| `gemini-batchexecute.json` | sanitized Gemini batchexecute history payload |
| `gemini-head-sample.min.txt` | synthetic minimal Gemini head-of-chain sample (built in-repo, always present) |
| `claude-conversation.json` | sanitized Claude conversation JSON |
| `claude-completion-sse.txt` | sanitized Claude SSE completion stream |
| `deepseek-serverTokens.json` | DeepSeek response with `accumulated_token_usage` |
| `perplexity-thread.json` | Perplexity thread payload |
| `searchai-folwr.json` | Google AI Search folwr JSON |
| `aistudio/*.json` | AI Studio 2.1.4 snapshots (back/settled/fast/retest-merge/export-s1/export-s3) + `expected.json` — эталон канона 2.2 (ходы, first/last hash, `bodyHash`); `aistudio/metric4.log`, `metric5.log` — метрические последовательности |

**Live personal samples pattern:** larger "live" captures from real personal accounts are gitignored (`google-folwr-sample.txt`, `gemini-network-sample.txt`, `chatgpt-conversation-sample.json`, `gemini-head-sample.txt`). Test suites that need them skip automatically when the file is absent, so CI stays green without private data while the same tests run locally when samples exist.

## Smoke matrix

Automated cell = representative test name; `manual (Chrome)` = verified by hand in the browser during release smoke-testing.

| Platform | Fixture parsing | Empty / invalid input | Live sample | SPA / convId switch |
|---|---|---|---|---|
| **Gemini** | «должен корректно обрабатывать данные из fixtures/gemini-batchexecute.json» + min-fixture live path | «должен корректно обрабатывать пустой ввод» | min-fixture live-path suite (`gemini-head-sample.min.txt`) | floor versioning by `PARSER_VERSION`; badge-from-cache <1s on SPA transitions — manual (Chrome) |
| **ChatGPT** | «должен корректно обрабатывать данные из fixtures/chatgpt-conversation.json» | «должен корректно обрабатывать пустой/невалидный ввод» | «живой снимок (system-корень первым…)» (committed sanitized snapshot) | «извлекает id чата из пути» + «сброс только при смене на новый непустой id» |
| **DeepSeek** | «должен корректно обрабатывать данные из fixtures/deepseek-serverTokens.json» | «должен корректно обрабатывать пустой/невалидный ввод» | manual (Chrome) | interceptor re-registration under new id — manual (Chrome) |
| **Claude** | «model === claude-sonnet-4-6…» fixture test | «пустой chat_messages → messages.length === 0» | manual (Chrome) | tape-restore ignores foreign convId cache (`snapshotConvIdOf` guard) — manual (Chrome) |
| **Perplexity** | «model === "turbo"…» fixture test | «пустые entries → messages.length === 0» | manual (Chrome) | SPA thread-switch detector — manual (Chrome) |
| **Google AI Search** | «должен корректно обрабатывать данные из fixtures/searchai-folwr.json» + `google-folwr-open.html` suite | «пустой/невалидный ввод → пустые messages и count 0» | manual (Chrome) | handshake adapter↔interceptor at F5 (early snapshots not lost) — manual (Chrome) |

## How to run

```bash
npm install
npm test        # Jest - as of v2.1.5 (2026-11-19): 270 suites / 4388 tests
```

CI (`.github/workflows/lint.yml`) additionally runs `node --check` over all JS files and validates `manifest.json` before executing the test suite.

| `google-folwr-open.html` | Google AI Search folwr-open HTML stream |
