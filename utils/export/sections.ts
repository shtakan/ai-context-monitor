/**
 * utils/export/sections.ts — чистый сбор секций сообщения (фаза 4).
 *
 * ARCHITECTURE-2.2 §3.4/§4: источники Perplexity, артефакты Claude и
 * вложения ChatGPT должны ехать ОТДЕЛЬНЫМИ секциями, а не тонуть в
 * assistant.text. Модуль только собирает данные из полей сообщения; рендер
 * секций в MD/JSON/TXT — следующий шаг (export-text-builders).
 *
 * Вход — сообщения файла (ExportMessage-совместимые объекты), выход — данные.
 * Никакого DOM/storage: сборщик вызывается на уже канонизированном массиве.
 */

/** Артефакт (Claude artifacts, сгенерированные файлы). */
export interface ExportArtifact {
  name: string;
  mime?: string;
  content?: string;
  turnId?: string;
}

/** Источник (Perplexity sources/snippets, ссылки ответа). */
export interface ExportSourceRef {
  title: string;
  url?: string;
  snippet?: string;
  turnId?: string;
}

/** Секции одного сообщения. */
export interface MessageSections {
  reasoning?: string;
  artifacts: ExportArtifact[];
  sources: ExportSourceRef[];
}

/** Сводка по треду: секции всех сообщений + счётчики. */
export interface ThreadSections {
  artifacts: ExportArtifact[];
  sources: ExportSourceRef[];
  reasoningCount: number;
}

function cleanText(value: unknown): string {
  return (typeof value === 'string') ? value.trim() : '';
}

function asArtifact(value: unknown, turnId?: string): ExportArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const name = cleanText(rec.name);
  if (!name) return null;
  const artifact: ExportArtifact = { name: name };
  const mime = cleanText(rec.mime);
  if (mime) artifact.mime = mime;
  const content = (typeof rec.content === 'string') ? rec.content : '';
  if (content) artifact.content = content;
  const tid = cleanText(rec.turnId) || turnId || '';
  if (tid) artifact.turnId = tid;
  return artifact;
}

function asSource(value: unknown, turnId?: string): ExportSourceRef | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const title = cleanText(rec.title);
  const url = cleanText(rec.url);
  if (!title && !url) return null;
  const source: ExportSourceRef = { title: title || url };
  if (url) source.url = url;
  const snippet = cleanText(rec.snippet);
  if (snippet) source.snippet = snippet;
  const tid = cleanText(rec.turnId) || turnId || '';
  if (tid) source.turnId = tid;
  return source;
}

/**
 * Секции одного сообщения. Поля читаются только если они есть; мусор
 * игнорируется, вход не мутируется.
 */
export function messageSections(msg: unknown): MessageSections {
  const out: MessageSections = { artifacts: [], sources: [] };
  if (!msg || typeof msg !== 'object') return out;
  const rec = msg as Record<string, unknown>;
  const reasoning = cleanText(rec.reasoning);
  if (reasoning) out.reasoning = reasoning;

  const turnId = cleanText(rec.turnId);
  const one = asArtifact(rec.artifact, turnId);
  if (one) out.artifacts.push(one);
  if (Array.isArray(rec.artifacts)) {
    for (let i = 0; i < rec.artifacts.length; i++) {
      const a = asArtifact(rec.artifacts[i], turnId);
      if (a) out.artifacts.push(a);
    }
  }
  if (Array.isArray(rec.sources)) {
    for (let s = 0; s < rec.sources.length; s++) {
      const src = asSource(rec.sources[s], turnId);
      if (src) out.sources.push(src);
    }
  }
  return out;
}

function artifactKey(a: ExportArtifact): string {
  return a.name + '\u0000' + (a.mime || '') + '\u0000' + (a.content || '') + '\u0000' + (a.turnId || '');
}

function sourceKey(s: ExportSourceRef): string {
  return s.title + '\u0000' + (s.url || '') + '\u0000' + (s.snippet || '') + '\u0000' + (s.turnId || '');
}

/**
 * Секции всего треда в порядке сообщений. Дубли (одинаковое имя/url и
 * содержимое) схлопываются: один артефакт не должен ехать дважды.
 */
export function threadSections(messages: Array<unknown> | null | undefined): ThreadSections {
  const out: ThreadSections = { artifacts: [], sources: [], reasoningCount: 0 };
  const seenA: Record<string, boolean> = {};
  const seenS: Record<string, boolean> = {};
  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length; i++) {
    const sec = messageSections(list[i]);
    if (sec.reasoning) out.reasoningCount++;
    for (let a = 0; a < sec.artifacts.length; a++) {
      const key = artifactKey(sec.artifacts[a]);
      if (seenA[key]) continue;
      seenA[key] = true;
      out.artifacts.push(sec.artifacts[a]);
    }
    for (let s = 0; s < sec.sources.length; s++) {
      const key = sourceKey(sec.sources[s]);
      if (seenS[key]) continue;
      seenS[key] = true;
      out.sources.push(sec.sources[s]);
    }
  }
  return out;
}
