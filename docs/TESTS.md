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
npm test        # Jest — as of v2.0.4 (2026-09-16): 83 suites / 1405 tests
```

CI (`.github/workflows/lint.yml`) additionally runs `node --check` over all JS files and validates `manifest.json` before executing the test suite.

| `google-folwr-open.html` | Google AI Search folwr-open HTML stream |
