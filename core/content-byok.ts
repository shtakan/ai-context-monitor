/**
 * core/content-byok.ts — 2.3 Stage 6: BYOK и точный countTokens.
 *
 * Classic-скрипт в manifest.content_scripts[0].js ПЕРЕД core/content.ts:
 * общий лексический скоуп. Здесь запрос точного счёта, загрузка/инвалидация
 * ключа, кэш ответа и латч aiCmExactTokensFor / aiCmHeuristicHoldForByok.
 * Точки вызова (processAndSend, options, initialize) остаются в content.ts.
 */

type AiCmSwCountTokensRequest = import('../types/messages').AiCmSwCountTokensRequest;
type AiCmSwCountTokensResponse = import('../types/messages').AiCmSwCountTokensResponse;

function requestExactTokens(fullText: string, modelId: string | null): void {
  if (!isExtensionValid()) return;
  // Firefox: BYOK выключен в SW (AMO) — точный счёт недоступен. Движок определяется по
  // схеме URL расширения (utils/platform.ts), а не по `typeof browser`: Chrome 148+ его
  // тоже выставляет, и прежняя проверка молча выключала точный подсчёт на Chrome.
  if (aiCmIsFirefox() || !exactCountEnabled || !geminiApiKey) { netServerTokens = 0; return; }
  if (!fullText) { netServerTokens = 0; return; }

  console.log('[byok-src] baseComplete=' + baseComplete +
    ' baseSeen=' + baseSeen +
    ' fullIsBase=' + (fullText === baseText) +
    ' baseLen=' + baseText.length +
    ' fullLen=' + fullText.length +
    ' baseCount=' + baseCount);

  // Кэш: текст не изменился — не дёргаем API
  if (fullText === lastCountTokensText) {
    netServerTokens = lastCountTokensCache;
    return;
  }

  // Шаг 3 (фикс «заполнителя»): подстановки прошлого значения в ОБЩИЙ счётчик здесь больше нет.
  // Прежний блок `if (lastCountTokensCache > 0) netServerTokens = lastCountTokensCache;` отдавал
  // число ПРЕДЫДУЩЕГО текста (после смены чата — предыдущего чата) как «текущее» на время запроса.
  // Авторитет последнего ответа API для этого же convId держит латч aiCmExactTokensFor (Шаг 2),
  // а netServerTokens пишется только реальными ответами (ingest / COUNT_TOKENS).

  // Сбрасываем любой pending дебаунс
  clearTimeout(countTokensTimer ?? undefined);

  // Защита от дублирования: если запрос уже в полёте — не отправляем повторно
  if (countTokensPending) return;

  countTokensPending = /** @type {boolean|Map<unknown, unknown>} */ (true);
  var apiModelId = ModelConfig.getGeminiApiModelId(modelId);

  logTextProbe('pre-send', fullText);

  chrome.runtime.sendMessage({
    type: 'COUNT_TOKENS',
    text: fullText,
    model: apiModelId
  } as AiCmSwCountTokensRequest, function (response: AiCmSwCountTokensResponse) {
    countTokensPending = /** @type {boolean|Map<unknown, unknown>} */ (false);
    if (response && typeof response.totalTokens === 'number') {
      lastCountTokensText = fullText;
      lastCountTokensCache = response.totalTokens;
      // Шаг 2: чат, для которого получен точный ответ, — признак авторитета для метрики
      // (aiCmExactTokensFor). Пишется тем же успешным ответом, что и пара text/cache.
      lastCountTokensConvId = getCurrentConvId() || '';
      // Шаг 4: успешный ответ снимает отметку отказа — держание эвристики для этого текста кончилось.
      lastCountTokensErrorText = '';
      // O-23 (калибровка 3.0): одна строка на каждый точный ответ API — тот же fullText,
      // что ушёл в countTokens, и production-оценка Tokenizer (линейная v3) по нему.
      // По этим строкам можно пересчитать константы без догадок по баннерам платформы.
      try {
        if (typeof aiCmDiagLine === 'function' && typeof Tokenizer !== 'undefined' && Tokenizer &&
            typeof Tokenizer.countTokens === 'function' &&
            typeof Tokenizer.countTokenizerFeatures === 'function') {
          // Общая классификация для лога и оценки: если фит и production
          // разойдутся по корзинам, строка снова станет бесполезной.
          var calFeat = Tokenizer.countTokenizerFeatures(fullText);
          var calCyr = calFeat.cyr;
          var calCjk = calFeat.cjk;
          var calLatin = calFeat.latin;
          var calDigit = calFeat.digit;
          var calPunct = calFeat.punct;
          var calOther = calFeat.other;
          var calSpace = (fullText.match(/\s/g) || []).length;
          var calEstimate = Tokenizer.countTokens(fullText);
          var calExact = response.totalTokens;
          aiCmDiagLine('o23-calibration', {
            model: apiModelId,
            convId: (typeof getCurrentConvId === 'function') ? (getCurrentConvId() || '') : '',
            chars: fullText.length,
            cyr: calCyr,
            latin: calLatin,
            digit: calDigit,
            cjk: calCjk,
            punct: calPunct,
            other: calOther,
            space: calSpace,
            img: (typeof netAttachBreak !== 'undefined' && netAttachBreak && netAttachBreak.imgCount) ? netAttachBreak.imgCount : 0,
            doc: (typeof netAttachBreak !== 'undefined' && netAttachBreak && netAttachBreak.docCount) ? netAttachBreak.docCount : 0,
            attach: (typeof netAttachTokens !== 'undefined' && netAttachTokens > 0) ? netAttachTokens : 0,
            estimate: calEstimate,
            exact: calExact,
            ratio: calExact > 0 ? (calEstimate / calExact).toFixed(4) : '(n/a)'
          });
        }
      } catch (eCal) { swallowSoft(eCal, 'content:o23-calibration'); }
      netServerTokens = response.totalTokens;
      console.log('[exact-tokens] countTokens вернул ' + response.totalTokens + ' токенов для модели ' + apiModelId);
      logTextProbe('post-ok:' + response.totalTokens, fullText);
      // Сохраняем точное значение в chrome.storage.local для восстановления после перезагрузки
      if (isExtensionValid()) {
        var convId = getCurrentConvId();
        try {
          chrome.storage.local.set({
            'ai-cm-byok-cache': { convId: convId, text: fullText, count: response.totalTokens, ts: Date.now() }
          });
          console.log('[byok-cache] точное значение сохранено в хранилище: ' + response.totalTokens);
        } catch (e) { swallowSoft(e, 'content:requestExactTokens'); }
      }
      // Пересчитываем виджет с точным числом (кэш lastCountTokensText не даст повторному вызову уйти в API)
      processAndSend();
    } else {
      var err = (response && response.error) ? response.error : 'unknown';
      aiCmDiagWarn('content:requestExactTokens', '[exact-tokens] ошибка countTokens: ' + err + ' — фолбэк на эвристику');
      // Шаг 2: API отказал — авторитет прошлого ответа по convId снимаем, иначе бейдж «замёрз»
      // бы на последнем точном числе до смены чата (квота исчерпана, ключ отозван, сеть).
      lastCountTokensConvId = '';
      // Шаг 4: отказ запоминаем по ТЕКСТУ — держание эвристики (aiCmHeuristicHoldForByok) снимается
      // для него же, и метрика снова считается эвристикой, вместо «замёрзшего» бейджа. Успешный
      // ответ ниже/выше по коду отметку стирает, а новый текст её и так не совпадает.
      lastCountTokensErrorText = fullText;
      // Если для этого же текста уже есть точное значение — не затираем его
      if (fullText === lastCountTokensText && lastCountTokensCache > 0) {
        netServerTokens = lastCountTokensCache;
      } else {
        netServerTokens = 0;
      }
    }
  });
}

function loadByokSettings(): void {
  if (!isExtensionValid()) return;
  // M-7: флаг точного подсчёта остаётся в chrome.storage.local, ключ — в session за SW.
  chrome.storage.local.get(['ai_cm_exact_token_count'], function (data: Record<string, any>) {
    exactCountEnabled = !!data.ai_cm_exact_token_count;
    // Residual-security: у SW спрашиваем только НАЛИЧИЕ ключа (boolean), не значение.
    aiCmSwByokHasKey().then(function (hasKey) {
      geminiApiKey = aiCmByokFlag(hasKey);
      console.log('[byok] настройки загружены: exactCount=' + exactCountEnabled + ', key=' + (geminiApiKey ? '***' : '(пусто)'));
    });
  });
}

// Шаг A.1 (R4): ключ спрашиваем у SW асинхронно, а initialize() раньше вызывал
// loadByokSettings() без ожидания — первый расчёт с exactCount=true мог уйти в
// COUNT_TOKENS без ключа (лишний сетевой путь/фолбэк). Держим модульный промис
// загрузки ключа и ДОЖИДАЕМСЯ его в initialize() до tryInit(); повторные вызовы
// внутри одной загрузки переиспользуют готовый промис.
var aiCmByokKeyPromise: Promise<boolean> | null = null;
function loadByokSettingsAsync() {
  if (aiCmByokKeyPromise) return aiCmByokKeyPromise;
  aiCmByokKeyPromise = new Promise(function (resolve) {
    try {
      if (!isExtensionValid()) { resolve(false); return; }
      aiCmSwByokHasKey().then(function (hasKey) {
        geminiApiKey = aiCmByokFlag(hasKey);
        console.log('[byok] ключ получен от SW: ' + (hasKey ? '***' : '(пусто)'));
        resolve(hasKey);
      });
    } catch (eByokP) { resolve(false); }
  });
  return aiCmByokKeyPromise;
}

// Шаг A.1 (security, R6): смена ключа приходит из SW/options сообщением
// 'aiCm-byok-key-changed' — session-хранилище из вкладки больше не наблюдается
// (storage.onChanged по session недоступен), а кэш ключа надо перечитать,
// иначе страница будет считать токены стёртым/старым ключом до перезагрузки.
function aiCmByokKeyInvalidate(): void {
  aiCmByokKeyPromise = null;
  try {
    if (!isExtensionValid()) return;
    aiCmSwByokHasKey().then(function (hasKey) {
      geminiApiKey = aiCmByokFlag(hasKey);
      lastCountTokensText = '';
      lastCountTokensCache = 0;
      lastCountTokensConvId = ''; // Шаг 2: чужой/отозванный ключ не оставляет авторитета
      lastCountTokensErrorText = ''; // Шаг 4: отметка отказа прошлого ключа не действует
      netServerTokens = 0; // при отключении BYOK сразу эвристика
      console.log('[byok] ключ обновлён сообщением SW: ' + (geminiApiKey ? '***' : '(пусто)'));
      if (isInitialized) processAndSend();
    });
  } catch (eByokInv) { swallowSoft(eByokInv, 'content:aiCmByokKeyInvalidate'); }
}

function loadByokCache(): void {
  if (!isExtensionValid()) return;
  var currentConvId = getCurrentConvId();
  if (!currentConvId) return;
  chrome.storage.local.get(['ai-cm-byok-cache'], function (data: Record<string, { convId?: string | null; text?: string; count?: number } | undefined>) {
    var entry = data['ai-cm-byok-cache'];
    if (!entry || entry.convId !== currentConvId) return;
    if (!entry.text || typeof entry.count !== 'number' || entry.count <= 0) return;
    lastCountTokensText = entry.text;
    lastCountTokensCache = entry.count;
    // Шаг 2: восстановленное значение принадлежит ТЕКУЩЕМУ чату (проверка entry.convId выше) —
    // без этой строки после перезагрузки страницы эвристика перебивала бы валидный кэш.
    lastCountTokensConvId = currentConvId!;
    console.log('[byok-cache] восстановлено точное значение из хранилища: ' + entry.count + ' токенов');
  });
}

// ===== Шаг 3: точное значение API (BYOK countTokens) приоритетнее эвристики tokens~ =====
// Корень дефекта: `netServerTokens` — ОБЩИЙ сетевой счётчик, и приём ЛЮБОГО снимка пишет его
// безусловно (`netServerTokens = detail.serverTokens || 0;` в ingest). У Gemini/AI Studio
// серверного поля нет вовсе → ingest обнуляет счётчик, в котором лежало точное число BYOK.
// Восстанавливает его в том же проходе только requestExactTokens, а он под гейтом
// `baseComplete` (processAndSend): на НЕПОЛНОМ снимке (пагинация, переэмит
// historyComplete=false) точное значение уже стёрто, API не спрашивается — и метрика
// откатывалась на эвристику Tokenizer.estimateDialogTokens, то есть бейдж и попап
// ПЕРЕЗАПИСЫВАЛИ ответ API оценкой tokens~. Отсюда и «прыжок» числа после верного счёта.
// Гейт `baseComplete` снят в Шаге 1 (см. processAndSend) — countTokens спрашивается на любую
// смену текста, поэтому «дыра» между текстом и ответом API сократилась до дебаунса SW.
//
// Латч (Шаг 2): countTokens зависит ТОЛЬКО от текста, значит точное число верно для того
// текста, для которого получено; НО авторитет привязан к ЧАТУ: ответ API уже получен для
// текущего convId → эвристика не имеет права перезаписывать maxTokenCount/percentage, пока
// не придёт свой ответ для нового текста. Иначе гонка «эвристика vs API» решалась в пользу
// эвристики на каждом проходе с изменившимся (хвост DOM, неполный снимок) текстом.
//
// Тройка состояния пишется ТОЛЬКО успешным ответом API либо восстановлением из
// chrome.storage.local, чистится сменой чата (core/widget.js resetConversationState) и сменой
// ключа (aiCmByokKeyInvalidate):
//   lastCountTokensText   — текст, для которого получено точное число;
//   lastCountTokensCache  — само число;
//   lastCountTokensConvId — convId, в котором число получено (Шаг 2). Снимается ошибкой
//                           countTokens (см. ветку else в requestExactTokens): если API
//                           отказал (квота/сеть), «замёрзшего» числа быть не должно —
//                           метрика снова считается эвристикой до следующего успеха.
//
// @param {string} [text] — текст, для которого запрошена метрика (processAndSend/GET_STATS).
// @returns {number} точные токены API для этого текста; 0 — точного значения нет.
function aiCmExactTokensFor(text: string): number {
  if (!exactCountEnabled || !geminiApiKey) return 0;
  if (!text) return 0;
  var cached = (typeof lastCountTokensCache === 'number' && lastCountTokensCache > 0) ? lastCountTokensCache : 0;
  if (cached <= 0) return 0;
  // (1) Ответ ровно для ЭТОГО текста — авторитетен всегда.
  if (text === lastCountTokensText) return cached;
  // (2) Шаг 2: ответ API получен для ТЕКУЩЕГО convId — эвристика не перезаписывает метрику,
  // пока для нового текста не пришёл свой ответ (текст меняется на каждом проходе: DOM-хвост,
  // неполный снимок, переэмит истории). Все внешние имена — typeof-гарды: срез-песочницы
  // тестов (new Function) не содержат соседних объявлений контура, а getCurrentConvId там
  // отсутствует вовсе (пины S1-S6).
  var convSame = false;
  try {
    var curConv = (typeof getCurrentConvId === 'function') ? getCurrentConvId() : '';
    convSame = !!(curConv && typeof lastCountTokensConvId === 'string' && lastCountTokensConvId === curConv);
  } catch (eConv) { convSame = false; }
  return convSame ? cached : 0;
}

// ===== Шаг 4 (фикс «скачка» бейджа при BYOK): эвристика молчит до точного ответа API =====
// КОРЕНЬ ДЕФЕКТА (живой замер 18:51:40, лог gemini.google.com): ключ и exactCount уже включены,
// но кэш countTokens для чата ещё НЕ восстановлен (loadByokCache выходит рано при пустом
// convId), а requestExactTokens только ушёл в сеть. Метрика этого прохода считалась эвристикой
// Tokenizer.estimateDialogTokens — 33162 токена (25.9%), а через 1.4 с приходил ответ API
// 29517 (23.1%) и бейдж на глазах «падал». Второй сценарий — новый чат: латч Шага 2 принадлежит
// ПРОШЛОМУ convId, эвристика рисует завышенное число, точное приходит позже.
// ПРАВИЛО: если точный счёт включён и ключ есть, а точного числа ДЛЯ ЭТОГО текста нет —
// эвристика не двигает maxTokenCount/percentage и не зовёт updateWidget: бейдж держит
// предыдущее значение (на свежей странице это штатный плейсхолдер «—» из createWidget),
// а точное значение придёт ответом countTokens (requestExactTokens → processAndSend).
// Эвристика отключается НЕ навсегда — она возвращается, когда:
//   (а) BYOK выключен или ключа нет  → работа без API-ключа не меняется вовсе;
//   (б) сервис не спрашивает countTokens (qwen/chatgpt/deepseek/...) — список ровно тот же,
//       что у вызова requestExactTokens в processAndSend (O-35: qwen исключён осознанно);
//   (в) точное число для текста уже есть (aiCmExactTokensFor > 0) — его авторитет сильнее;
//   (г) API отказал именно для этого текста (lastCountTokensErrorText) — иначе при квоте/сети
//       бейдж «замёрз» бы на держании, что противоречит ветке ошибки requestExactTokens.
// Внешние имена — typeof-гарды: срез-песочницы тестов (new Function) не содержат соседних
// объявлений контура (конвенция aiCmExactTokensFor/aiCmMetricServerTokens).
//
// @param {string} svc — сервис (getServiceKey/currentAdapter.siteName).
// @param {string} text — текст, для которого считается метрика (полный текст диалога).
// @returns {boolean} true — эвристике запрещено писать бейдж в этом проходе.
function aiCmHeuristicHoldForByok(svc: string | null, text: string): boolean {
  if (!exactCountEnabled || !geminiApiKey) return false;
  if (svc !== 'gemini' && svc !== 'aistudio' && svc !== 'google_search') return false;
  if (!text) return false;
  // Контекст расширения недействителен (обновление расширения): запрос уйти не сможет,
  // держать нечего — пусть работает эвристика, как до включения BYOK.
  if (typeof isExtensionValid === 'function' && !isExtensionValid()) return false;
  var exact = (typeof aiCmExactTokensFor === 'function') ? aiCmExactTokensFor(text) : 0;
  if (exact > 0) return false;
  var errText = (typeof lastCountTokensErrorText === 'string') ? lastCountTokensErrorText : '';
  if (errText && errText === text) return false;
  return true;
}
