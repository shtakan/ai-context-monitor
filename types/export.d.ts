/**
 * Типы экспортного конвейера (utils/export-text-builders.js,
 * utils/export-emit-pipeline.ts, core/export-manager.js).
 *
 * Модуль самодостаточен: импортов нет — по прецеденту types/message.d.ts каждый
 * тип читается независимо. Это ДЕКЛАРАЦИИ предметной области, а не рантайм:
 * JS-файлы не меняются, формы выведены из фактического кода HEAD 0f194f9.
 */

/**
 * Формат файла экспорта. Ровно три значения, которые понимает селектор
 * автоэкспорта (core/export-manager.js:882-883) и нормализатор
 * normExportFmt (utils/export-emit-pipeline.ts:159-161:
 * 'md' | 'json', всё остальное → 'txt').
 */
export type ExportFormat = 'txt' | 'md' | 'json';

/**
 * Метка достоверности источника файла (Two-Tier, v89).
 * Классификатор sourceTierOf (utils/export-emit-pipeline.ts:368-375)
 * возвращает РОВНО эти три латинских литерала:
 *   архив > 0 и live > 0 → '[MERGED: ARCHIVE+LIVE]';
 *   архив > 0, live = 0  → '[ARCHIVE]';
 *   иначе                → '[BEST-EFFORT: LIVE CAPTURE]'.
 * undefined (метки нет) — отдельное состояние читателей: файл печатается без
 * первой строки (utils/export-text-builders.js:276,300), поэтому union
 * намеренно не включает undefined — его добавляет поле ExportHistory.sourceTier.
 */
export type ExportSourceTier =
  | '[MERGED: ARCHIVE+LIVE]'
  | '[ARCHIVE]'
  | '[BEST-EFFORT: LIVE CAPTURE]';

/**
 * Сообщение в экспортной форме.
 *
 * Нормализованная форма (normalizeExportMessages,
 * utils/export-emit-pipeline.ts:609-630): role 'user' | 'assistant' после
 * приведения 'human' → 'user', text берётся из text || content, пустые
 * отбрасываются. Поля id/reasoning/hiddenReasoning едут рядом с text и в сам
 * текст не входят (O-7); hiddenReasoning попадает в файл только при включённом
 * тумблере includeHiddenExportBlocks.
 *
 * Сборщики (utils/export-text-builders.js:239-352) читают role, text,
 * reasoning и hiddenReasoning; прочие поля захвата они переносят байтово,
 * поэтому добавлен index-signature-фолбэк.
 */
export interface ExportMessage {
  /** Роль хода: 'user' | 'assistant' (на входе также допускается 'human'). */
  role: string;

  /** Текст сообщения (входные text || content). */
  text: string;

  /** Идентификатор хода, если он есть в источнике. */
  id?: string | number;

  /** Размышление отдельным полем → секции [REASONING]/[ANSWER] (O-35/O-37). */
  reasoning?: string;

  /** Размышление скрытого DOM-захвата (O-7); в text не входит. */
  hiddenReasoning?: string;

  /** Сырой алиас текста: normalizeExportMessages читает content, если нет text. */
  content?: string;

  /** Прочие поля захвата/адаптера, переносимые байтово. */
  [key: string]: unknown;
}

/**
 * Настройки автоэкспорта (core/state.js:163, загрузка —
 * core/export-manager.js:855-899).
 *
 * pct — порог срабатывания 1..100 (невалидное значение нормализуется в 90);
 * fmt — формат из селектора, общий для всех сайтов. perSitePct — per-site
 * пороги (core/state.js, autoExportPctBySite), includeHidden — отдельный
 * тумблер O-7 (aiCmIncludeHiddenInExport).
 */
export interface ExportConfig {
  /** Флаг автоэкспорта (aiCmAutoExport); отсутствие булева = false. */
  enabled: boolean;

  /** Порог срабатывания в процентах, 1..100 (по умолчанию 90). */
  pct: number;

  /** Формат файла (aiCmAutoExportFmt; неизвестное → 'txt'). */
  fmt: ExportFormat;

  /** O-7: включать reasoning/инъекции скрытого захвата в экспорт. */
  includeHidden?: boolean;

  /** S2: per-site порог автоэкспорта (siteName → 1..100). */
  perSitePct?: Record<string, number>;
}

/**
 * Снимок истории, который принимают сборщики
 * buildTxtFromHistory / buildMdFromHistory / buildJsonFromHistory
 * (utils/export-text-builders.js:239-352).
 * Все поля опциональны: сборщики подставляют прежние дефолты (0, '—', []).
 */
export interface ExportHistory {
  /** Идентификатор сервиса ('gemini', 'chatgpt', 'qwen', …). */
  site?: string;

  /** Человекочитаемое имя модели для шапки md/json. */
  model?: string;

  /** Число токенов снимка. */
  tokens?: number;

  /** Эффективный лимит снимка. */
  limit?: number;

  /** Процент заполнения. */
  percent?: number;

  /** v1.9 (qwen): источник числа (dom|net|max|server|hold) — печатается в md/json. */
  src?: string;

  /** Two-Tier-метка; печатается только для site === 'gemini'. */
  sourceTier?: string;

  /** Сообщения снимка. */
  messages?: ExportMessage[];
}

/**
 * Публичный API utils/export-text-builders.js (window.AiCmExportBuilders).
 * Формы методов — по фактическим функциям файла: три сборщика, точка
 * скачивания downloadBlob и чистые хелперы reasoning/маркеров.
 */
export interface ExportBuildersApi {
  buildTxtFromHistory(history: ExportHistory): string;
  buildMdFromHistory(history: ExportHistory, platform?: string): string;
  buildJsonFromHistory(history: ExportHistory, platform?: string): string;

  /**
   * Точка выдачи файла. Возвращает false, если сработал пост-гард формы
   * мусора/пустого имени (O-27/O-32), иначе true.
   */
  downloadBlob(
    content: string,
    fileName: string,
    mimeType: string,
    trigger?: string,
    extra?: Record<string, unknown>
  ): boolean;

  /** O-35: рендер reasoning контрактом DeepSeek. */
  aiCmMessageTextWithReasoning(msg: unknown): string;

  /** O-35: композиция [REASONING]/[ANSWER] вокруг текста. */
  aiCmWithReasoningSections(text: unknown, reasoning: unknown): string;

  /** Прочие публичные хелперы модуля (см. Api в конце файла). */
  [key: string]: any;
}

/**
 * Публичный API utils/export-emit-pipeline.ts (window.AiCmExportEmitPipeline)
 * в объёме, который читают вызывающие: генерация имён файлов и классификатор
 * яруса источника. Остальные методы доступны через index-signature, пока
 * типизация пайплайна не входит в scope Фазы 1.
 */
export interface ExportPipelineApi {
  buildExportFileName(
    service: string,
    convId: string,
    reason?: string,
    isLowConfidence?: boolean,
    fmt?: string,
    taken?: unknown
  ): string;

  buildGsaExportFileName(
    site: string,
    model: string,
    isLowConfidence?: boolean,
    fmt?: string,
    taken?: unknown
  ): string;

  /** sourceTierOf (utils/export-emit-pipeline.ts:368) возвращает один из трёх литералов. */
  sourceTierOf(state?: unknown): string;

  [key: string]: any;
}
