/**
 * Content normalization for note writes and reads.
 *
 * Text notes store HTML. Agents usually think in Markdown, so `auto` detects
 * HTML vs Markdown vs plain text and converts; explicit formats skip detection.
 * Code, mermaid and other plain-text types pass through untouched.
 */
import { marked } from 'marked';
import { DomainError } from './errors.js';

export const CONTENT_FORMATS = ['auto', 'html', 'markdown', 'plain'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export type DetectedFormat = Exclude<ContentFormat, 'auto'>;

export const BINARY_TYPES = new Set(['file', 'image']);
export const HTML_TYPES = new Set(['text']);
export const PLAIN_TYPES = new Set([
  'code',
  'mermaid',
  'render',
  'relationMap',
  'search',
  'canvas',
  'noteMap',
  'webView',
]);
/** Types whose content is normally empty; writing content to them is allowed but flagged. */
export const CONTAINER_TYPES = new Set([
  'book',
  'search',
  'relationMap',
  'noteMap',
  'webView',
  'render',
]);

const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?>/;
const MARKDOWN_HINTS: RegExp[] = [
  /^#{1,6}\s+\S/m,
  /^\s*[-*+]\s+\S/m,
  /^\s*\d+\.\s+\S/m,
  /^>\s+\S/m,
  /```/,
  /\[[^\]]+\]\([^)]+\)/,
  /(^|[^*])\*\*[^*\n]+\*\*/,
  /(^|\s)_[^_\n]+_(\s|$)/,
  /(^|\s)`[^`\n]+`/,
  /^\s*[-*_]{3,}\s*$/m,
  /^\|.+\|\s*$/m,
];

export function looksLikeHtml(content: string): boolean {
  return HTML_TAG.test(content);
}

export function looksLikeMarkdown(content: string): boolean {
  return MARKDOWN_HINTS.some((re) => re.test(content));
}

export function detectFormat(content: string): DetectedFormat {
  if (looksLikeHtml(content)) return 'html';
  if (looksLikeMarkdown(content)) return 'markdown';
  return 'plain';
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function plainToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (paragraphs.length === 0) return '';
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true, breaks: false }).trim();
}

export interface NormalizedContent {
  content: string;
  /** Format the input was interpreted as. */
  inputFormat: DetectedFormat;
  /** Whether a conversion changed the bytes. */
  converted: boolean;
  warnings: string[];
}

export function normalizeContentForWrite(input: {
  noteType: string;
  content: string;
  format?: ContentFormat | undefined;
  maxBytes: number;
}): NormalizedContent {
  const { noteType, content } = input;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > input.maxBytes) {
    throw new DomainError(
      'TOO_LARGE',
      `Content is ${bytes} bytes; the limit is ${input.maxBytes} bytes`,
      { bytes, maxBytes: input.maxBytes },
    );
  }
  if (BINARY_TYPES.has(noteType)) {
    throw new DomainError(
      'UNSUPPORTED',
      `Writing content to '${noteType}' notes is not supported by this server`,
      { noteType },
    );
  }
  const warnings: string[] = [];
  const requested = input.format ?? 'auto';

  if (!HTML_TYPES.has(noteType)) {
    if (requested === 'markdown' || requested === 'html') {
      warnings.push(
        `format '${requested}' is ignored for '${noteType}' notes; content is stored verbatim`,
      );
    }
    if (CONTAINER_TYPES.has(noteType) && content.trim() !== '') {
      warnings.push(`'${noteType}' notes normally have empty content; Trilium may ignore it`);
    }
    return { content, inputFormat: 'plain', converted: false, warnings };
  }

  const format: DetectedFormat = requested === 'auto' ? detectFormat(content) : requested;
  if (content.trim() === '')
    return { content: '', inputFormat: format, converted: false, warnings };
  switch (format) {
    case 'html':
      return { content, inputFormat: 'html', converted: false, warnings };
    case 'markdown':
      return {
        content: markdownToHtml(content),
        inputFormat: 'markdown',
        converted: true,
        warnings,
      };
    default:
      return { content: plainToHtml(content), inputFormat: 'plain', converted: true, warnings };
  }
}

const BLOCK_BREAK =
  /<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|table|ul|ol|figure|figcaption)>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X'))
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Cheap HTML → readable plain text for agents that do not need markup. */
export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(LINE_BREAK, '\n')
    .replace(BLOCK_BREAK, '$&\n')
    .replace(/<\/?(td|th)[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface TruncatedContent {
  content: string;
  truncated: boolean;
  totalBytes: number;
}

export function truncateContent(content: string, maxBytes: number): TruncatedContent {
  const totalBytes = Buffer.byteLength(content, 'utf8');
  if (totalBytes <= maxBytes) return { content, truncated: false, totalBytes };
  const buf = Buffer.from(content, 'utf8').subarray(0, maxBytes);
  // Avoid cutting a UTF-8 sequence in half.
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0 && (buf[end - 1]! & 0x80) !== 0) {
    /* last byte is a lead byte of a multi-byte sequence */
    end--;
  }
  return { content: buf.subarray(0, end).toString('utf8'), truncated: true, totalBytes };
}
