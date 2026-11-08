# REGRESSION-LEDGER

Живые баги, дошедшие до приёмки. Каждая строка = урок для будущих сессий.

| Дата | Симптом | Корень | Пин (файл) | Статус |
|---|---|---|---|---|
| 2026-11-05 | Gemini: 102 картинки вместо 19 | Кумулятивный пул turn[2] без дельты | tests/adapters/gemini-files-module.test.js | Закрыт (v2.0.39) |
| 2026-11-06 | GSA: рост pct на SPA | Ключ ответа не совпадал при стриме | tests/o32-gsa-spa-inflation.test.js | Закрыт (v2.0.40) |
| 2026-11-07 | GSA Badge Inflation | Рост бейджа при SPA-возврате из-за перестановки абзацев в тексте. Дедупликатор видел ход как новый. | `utils/google-search-folwr-parser.js` (bodiesParagraphPermutation) | `tests/o46-gsa-paragraph-permutation-dedupe.test.js` | Закрыт (O-46) |
| 2026-11-08 | Perplexity: неверное позиционирование меток [Image] в экспорте | DOM-парсер экспорта собирает текст в кучу, игнорируя структуру | - (в бэклоге) | Открыт |
