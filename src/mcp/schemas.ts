/** Zod schemas shared across tools: inputs the model sees and outputs it can rely on. */
import * as z from 'zod/v4';
import { CONTENT_FORMATS } from '../domain/content.js';
import { CRITERION_TYPES, OPERATORS } from '../domain/query/builder.js';
import { NOTE_TYPES } from '../etapi/types.js';

export const noteIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,64}$/, 'noteId must be 1-64 characters of letters, digits or underscore')
  .describe(
    "Trilium note id, e.g. 'root' or 'BWf42IBwfgM6'. Use resolve_note to turn a title into an id.",
  );

export const cursorSchema = z
  .string()
  .max(200)
  .optional()
  .describe('Opaque cursor from a previous page (nextCursor).');

export const criterionSchema = z
  .object({
    type: z
      .enum(CRITERION_TYPES)
      .describe(
        "'label' (#tag), 'relation' (~rel), or 'noteProperty' (note.* built-ins and hierarchy paths)",
      ),
    property: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Label/relation name (e.g. 'project', 'template', 'author.title') or note property: title, content, type, mime, isArchived, isProtected, dateCreated, dateModified, labelCount, childrenCount, parents.noteId, parents.title, ancestors.noteId, children.title",
      ),
    op: z
      .enum(OPERATORS)
      .optional()
      .describe(
        "Default: 'exists' for label/relation, '=' for noteProperty. Text ops: contains, starts_with, ends_with, regex. Dates accept ISO or smart dates like TODAY-7, MONTH-1.",
      ),
    value: z
      .string()
      .max(2000)
      .optional()
      .describe('Comparison value. Omit for exists/not_exists.'),
    logic: z
      .enum(['AND', 'OR'])
      .optional()
      .describe(
        "How this item joins the NEXT item (default AND). OR binds tighter: 'A OR B AND C' = (A OR B) AND C.",
      ),
  })
  .describe('One search criterion');

export const noteSummarySchema = z.object({
  noteId: z.string(),
  title: z.string(),
  type: z.string(),
  mime: z.string(),
  isProtected: z.boolean(),
  dateCreated: z.string(),
  dateModified: z.string(),
  utcDateModified: z.string(),
  parentNoteIds: z.array(z.string()),
  childCount: z.number(),
  labels: z.array(z.string()),
});

export const attributeViewSchema = z.object({
  attributeId: z.string(),
  type: z.enum(['label', 'relation']),
  name: z.string(),
  value: z.string(),
  position: z.number(),
  isInheritable: z.boolean(),
  inherited: z.boolean(),
});

export const noteDetailSchema = noteSummarySchema.extend({
  childNoteIds: z.array(z.string()),
  attributes: z.array(attributeViewSchema),
  contentHash: z
    .string()
    .describe('Trilium blobId of the current content. Pass as expectedHash when writing.'),
});

export const contentMatchSchema = z.object({
  index: z.number(),
  length: z.number().describe('Length of the full match in the content'),
  match: z.string().describe('Matched text, cut to 500 characters when longer'),
  matchTruncated: z.boolean().optional(),
  context: z.string().describe('Up to 80 characters before and after the match'),
});

export const noteTypeSchema = z.enum(NOTE_TYPES);
export const contentFormatSchema = z
  .enum(CONTENT_FORMATS)
  .optional()
  .describe(
    "For text notes: 'auto' (default) detects HTML vs Markdown vs plain and converts to HTML; 'html' stores verbatim; 'markdown' converts; 'plain' escapes and wraps in <p>. Ignored for code/mermaid notes.",
  );

export const attributeInputSchema = z.object({
  type: z.enum(['label', 'relation']),
  name: z.string().min(1).max(200).describe('Attribute name without # or ~ prefix'),
  value: z
    .string()
    .max(4000)
    .optional()
    .describe(
      'Label value (optional) or relation target: a noteId or an exact note title (e.g. Board, Calendar for built-in templates)',
    ),
  position: z.number().int().min(0).optional(),
  isInheritable: z.boolean().optional(),
});

export const attributeOpResultSchema = z.object({
  ok: z.boolean(),
  action: z.enum(['add', 'update', 'remove']),
  attribute: attributeViewSchema.optional(),
  error: z.string().optional(),
});

export const pageMetaSchema = {
  total: z.number().describe('Number of matching items known to the server'),
  nextCursor: z.string().optional().describe('Present when more items exist; pass back as cursor'),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when more items exist than pagination can reach (ascending order covers the first 1000 matches)',
    ),
};

export const attachmentSchema = z.object({
  attachmentId: z.string(),
  ownerNoteId: z.string().describe('The note that owns the attachment'),
  role: z.string().describe("Trilium role, usually 'file' or 'image'"),
  mime: z.string(),
  title: z.string(),
  position: z.number(),
  contentHash: z
    .string()
    .describe('Trilium blobId of the current content. Pass as expectedHash when replacing it.'),
  contentLength: z.number().optional().describe('Size in bytes when Trilium reports it'),
  utcDateModified: z.string().optional(),
  scheduledForErasure: z
    .boolean()
    .describe('True once the attachment has been deleted and awaits erasure'),
});

export const branchSchema = z.object({
  branchId: z.string(),
  noteId: z.string(),
  parentNoteId: z.string(),
  prefix: z.string().nullable(),
  notePosition: z.number(),
  isExpanded: z.boolean(),
});

/**
 * Linear-time shape check for base64 / data: URI input (AUDIT R15). The
 * payload class excludes '=', and each '=' may only be followed by whitespace,
 * so no two quantifiers can claim the same characters and a failing input
 * backtracks once per position. Padding correctness is checked by the decoder.
 */
export const BASE64_INPUT_PATTERN = /^(?:data:[^,]{0,200},)?[A-Za-z0-9+/\s]*(?:=\s*){0,2}$/;

export const base64Schema = z
  .string()
  .regex(
    BASE64_INPUT_PATTERN,
    'contentBase64 must be standard base64, optionally as a data:<mime>;base64, URI',
  )
  .describe(
    'Binary content as standard base64 (a data: URI is also accepted). Decoded size is limited by MCP_MAX_WRITE_CONTENT_BYTES.',
  );
