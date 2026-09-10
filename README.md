# AI Context Monitor

A Chrome extension (Manifest V3) that shows in real time how full the AI context window of your conversation is, across six platforms. When a chat grows too long, models start losing details — AI Context Monitor warns you before that happens and can save the whole conversation automatically.

## Features

- **6 supported platforms**: Google Gemini, ChatGPT, DeepSeek, Claude, Perplexity, Google AI Search.
- **Real-time fill badge**: a live widget in the corner of the screen showing context fill (%, tokens / limit, model name), updated as you chat.
- **Auto-export at threshold**: when the configured fill threshold is reached, the full chat history is downloaded automatically as `txt`/`md` — once per chat, only after the complete history has been loaded.
- **Invisible full-history loader**: fetches the entire conversation in the background — no manual scrolling needed.
- **100% client-side**: no accounts, no servers, no telemetry. Everything runs locally in your browser.
- **Optional exact token counting** via the official Gemini `countTokens` API with your own key (BYOK).

## Install

1. Download the ZIP from the [Releases](../../releases) page.
2. Unpack it into any folder.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode** (toggle in the top-right corner).
5. Click **Load unpacked** and select the unpacked folder.

## Quick start

1. Click the extension icon to open the popup.
2. Set the **auto-export threshold** (50–99% of the context window) and the export format (`txt` or `md`).
3. Toggle **Detailed logs** if you need verbose console output for troubleshooting.
4. *(Optional)* Paste your **Gemini API key** (BYOK) to switch from local estimation to exact token counting via `countTokens`.

## Architecture

Hybrid capture pipeline:

```
MAIN world interceptors (fetch/XHR)
        |  CustomEvents
        v
ISOLATED content script  -->  badge / auto-export / invisible loader
        |
        v
service worker (core/background.js)
```

- Platform adapters (`adapters/*`) intercept network responses in the MAIN world and forward full network snapshots via CustomEvents to the ISOLATED content script (`core/content.js`), which maintains state, renders the badge, triggers auto-export and runs the invisible history loader; the service worker handles background tasks.
- Export text assembly lives in `utils/export-text-builders.js`; reference/context text building in `utils/buildReferenceText.js`.

## Tests

```bash
npm test
```

Runs Jest: **14 suites / 159 tests**, green in CI. Sanitized fixtures are bundled in `tests/fixtures`. Personal ("live") captured samples are gitignored — tests that require them are skipped automatically when those files are absent.

## Privacy

Everything stays local: no telemetry, no analytics, no data collection. The only outbound requests go to the chat sites themselves and, optionally, to the Gemini API with your own key. Your BYOK key is stored only in `chrome.storage` on your machine.

## Screenshots

(скриншоты изъяты из репозитория по приватности, см. RELEASE_CHECKLIST, запись 09.09.2026)

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Google, OpenAI, Anthropic, DeepSeek, Perplexity, or any other company mentioned. All product names and trademarks are the property of their respective owners.

## License

[MIT](LICENSE)
