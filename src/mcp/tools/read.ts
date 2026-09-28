/** Read-only tools (scope trilium.read). */
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { isImageMime } from '../../domain/binary.js';
import type { Services } from '../../domain/services.js';
import { ok, okWith, withAudit } from '../results.js';
import {
  attachmentSchema,
  attributeViewSchema,
  contentMatchSchema,
  criterionSchema,
  cursorSchema,
  noteDetailSchema,
  noteIdSchema,
  noteSummarySchema,
  pageMetaSchema,
} from '../schemas.js';
import { defineTool, type AnyToolDefinition } from './types.js';

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const findSchema = z
  .object({
    pattern: z.string().min(1).max(500),
    regex: z
      .boolean()
      .optional()
      .describe('Treat pattern as a JavaScript regex (default false = literal)'),
    flags: z.string().max(6).optional().describe("Regex flags (default 'i')"),
    maxMatches: z.number().int().min(1).max(200).optional(),
  })
  .optional()
  .describe(
    'Locate text inside the returned content window (raise maxContentBytes to search further); returns matches with surrounding context.',
  );

export function readTools(services: Services): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'search_notes',
      scope: 'trilium.read',
      config: {
        title: 'Search notes',
        description:
          'Search Trilium notes. Use `text` for full-text keywords (space = AND, quote phrases), `criteria` for structured filters on labels (#tag), relations (~rel) and note properties (title, type, dates, hierarchy), or `query` for raw Trilium search syntax. Results are summaries; call get_note for content. Paginated via cursor.',
        inputSchema: z.object({
          text: z
            .string()
            .max(1000)
            .optional()
            .describe(
              "Full-text terms, e.g. 'docker compose' or '\"exact phrase\"'. No boolean operators here; use criteria or query.",
            ),
          criteria: z.array(criterionSchema).max(20).optional(),
          query: z
            .string()
            .max(2000)
            .optional()
            .describe(
              'Raw Trilium search DSL appended verbatim, e.g. "#project = \'Home\' note.dateModified >= MONTH-1"',
            ),
          ancestorNoteId: noteIdSchema
            .optional()
            .describe('Restrict to the subtree under this note'),
          ancestorDepth: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('With ancestorNoteId: maximum depth below the ancestor'),
          includeArchived: z
            .boolean()
            .optional()
            .describe('Include archived notes (default false)'),
          fastSearch: z
            .boolean()
            .optional()
            .describe('Match titles/attributes only, skipping note bodies (faster, less complete)'),
          orderBy: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Sort by a note property or label, e.g. 'dateModified', 'title', 'labelCount'. Ascending order is computed over the first 1000 matches.",
            ),
          orderDirection: z.enum(['asc', 'desc']).optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe('Page size (default 50, max 200)'),
          cursor: cursorSchema,
        }),
        outputSchema: z.object({
          query: z.string().describe('The Trilium search string that was executed'),
          items: z.array(noteSummarySchema),
          ...pageMetaSchema,
        }),
        annotations: { ...READ_ANNOTATIONS, title: 'Search notes' },
      },
      noteIds: (args) => (args.ancestorNoteId ? [args.ancestorNoteId] : []),
      handler: async (args) => ok(await services.search.search(args)),
    }),
    defineTool({
      name: 'resolve_note',
      scope: 'trilium.read',
      config: {
        title: 'Resolve note reference',
        description:
          "Turn a human reference into a note id. Give a `noteId` to verify it exists, a `title` (exact or partial), or a `path` like 'Projects/Home/Plumbing' (titles from the root, / separated). Never guesses: status is 'resolved', 'ambiguous' (choose from candidates) or 'not_found'.",
        inputSchema: z.object({
          noteId: noteIdSchema.optional(),
          title: z.string().max(500).optional(),
          path: z.string().max(2000).optional(),
          exact: z
            .boolean()
            .optional()
            .describe(
              'Require an exact title match (default false: partial matches allowed, exact ones ranked first)',
            ),
          parentNoteId: noteIdSchema
            .optional()
            .describe('Only consider direct children of this note'),
          maxCandidates: z.number().int().min(1).max(20).optional(),
        }),
        outputSchema: z.object({
          status: z.enum(['resolved', 'ambiguous', 'not_found']),
          note: noteSummarySchema.optional(),
          candidates: z.array(noteSummarySchema),
          message: z.string(),
        }),
        annotations: { ...READ_ANNOTATIONS, title: 'Resolve note reference' },
      },
      noteIds: (args) => (args.noteId ? [args.noteId] : []),
      handler: async (args) => ok(await services.search.resolve(args)),
    }),
    defineTool({
      name: 'get_note',
      scope: 'trilium.read',
      config: {
        title: 'Get note',
        description:
          'Read one note: metadata, attributes, parents/children ids, and content. Returns contentHash, which patch_note requires. Content is truncated at maxContentBytes (default 256 KiB); contentTruncated tells you. Use format=plain to strip HTML from text notes. File/image notes return contentBase64 (images also as an image content block) or, when larger than maxContentBytes, only their size.',
        inputSchema: z.object({
          noteId: noteIdSchema,
          includeContent: z.boolean().optional().describe('Default true'),
          maxContentBytes: z.number().int().min(1024).optional(),
          format: z
            .enum(['raw', 'plain'])
            .optional()
            .describe(
              "'raw' (default) returns stored HTML/text; 'plain' strips HTML tags for text notes",
            ),
          find: findSchema,
        }),
        outputSchema: z.object({
          note: noteDetailSchema,
          content: z.string().optional(),
          contentBase64: z
            .string()
            .optional()
            .describe('Body of file/image notes, base64 (never truncated; omitted with a reason)'),
          contentFormat: z.enum(['raw', 'plain']).optional(),
          contentTruncated: z.boolean().optional(),
          contentBytes: z.number().optional(),
          contentOmittedReason: z.string().optional(),
          matches: z.array(contentMatchSchema).optional(),
          totalMatches: z.number().optional(),
        }),
        annotations: { ...READ_ANNOTATIONS, title: 'Get note' },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => {
        const result = await services.notes.get(args);
        return result.contentBase64 !== undefined && isImageMime(result.note.mime)
          ? okWith(result, [
              { type: 'image', data: result.contentBase64, mimeType: result.note.mime },
            ])
          : ok(result);
      },
    }),
    defineTool({
      name: 'get_note_context',
      scope: 'trilium.read',
      config: {
        title: 'Get note with context',
        description:
          'One call for a note plus its surroundings: content, attributes, parent summaries, and child summaries (optionally with short content previews). Prefer this over get_note + list_children when orienting inside a subtree.',
        inputSchema: z.object({
          noteId: noteIdSchema,
          includeContent: z.boolean().optional().describe('Default true'),
          maxContentBytes: z.number().int().min(1024).optional(),
          format: z.enum(['raw', 'plain']).optional(),
          childrenLimit: z.number().int().min(0).max(500).optional().describe('Default 50'),
          includeChildContent: z
            .boolean()
            .optional()
            .describe(
              'Include a short plain-text preview of each child (default false; costs one request per child)',
            ),
          childContentBytes: z
            .number()
            .int()
            .min(100)
            .max(20000)
            .optional()
            .describe('Preview size per child (default 2048)'),
          includeParents: z.boolean().optional().describe('Default true'),
        }),
        outputSchema: z.object({
          note: noteDetailSchema,
          content: z.string().optional(),
          contentFormat: z.enum(['raw', 'plain']).optional(),
          contentTruncated: z.boolean().optional(),
          contentBytes: z.number().optional(),
          contentOmittedReason: z.string().optional(),
          parents: z.array(noteSummarySchema),
          children: z.array(
            noteSummarySchema.extend({
              contentPreview: z.string().optional(),
              contentTruncated: z.boolean().optional(),
              previewOmittedReason: z.string().optional(),
            }),
          ),
          childrenTruncated: z.boolean(),
          totalChildren: z.number(),
          unavailableNoteIds: z
            .array(z.string())
            .describe('Child or parent ids Trilium lists that no longer resolve to a note'),
        }),
        annotations: { ...READ_ANNOTATIONS, title: 'Get note with context' },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => ok(await services.notes.context(args)),
    }),
    defineTool({
      name: 'list_children',
      scope: 'trilium.read',
      config: {
        title: 'List child notes',
        description:
          'List the direct children of a note as summaries, in tree order by default. Paginated. Cheap: no content is fetched.',
        inputSchema: z.object({
          noteId: noteIdSchema,
          limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
          cursor: cursorSchema,
          orderBy: z
            .enum(['position', 'title', 'dateCreated', 'dateModified'])
            .optional()
            .describe("Default 'position' (tree order)"),
          orderDirection: z.enum(['asc', 'desc']).optional(),
        }),
        outputSchema: z.object({ items: z.array(noteSummarySchema), ...pageMetaSchema }),
        annotations: { ...READ_ANNOTATIONS, title: 'List child notes' },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => ok(await services.notes.listChildren(args)),
    }),
    defineTool({
      name: 'read_attributes',
      scope: 'trilium.read',
      config: {
        title: 'Read attributes',
        description:
          "Read a note's labels (#tags) and relations (~links), with optional filtering by type or name. Owned attributes only unless includeInherited is true.",
        inputSchema: z.object({
          noteId: noteIdSchema,
          type: z.enum(['label', 'relation']).optional(),
          name: z.string().max(200).optional(),
          includeInherited: z
            .boolean()
            .optional()
            .describe('Also return attributes inherited from ancestors/templates (default false)'),
        }),
        outputSchema: z.object({
          note: noteSummarySchema,
          attributes: z.array(attributeViewSchema),
        }),
        annotations: { ...READ_ANNOTATIONS, title: 'Read attributes' },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => ok(await services.attributes.read(args)),
    }),
    defineTool({
      name: 'list_attachments',
      scope: 'trilium.read',
      config: {
        title: 'List attachments',
        description:
          "List a note's attachments (images pasted into it, files attached to it): id, title, mime, role, size and contentHash. No content is fetched; use get_attachment.",
        inputSchema: z.object({ noteId: noteIdSchema }),
        outputSchema: z.object({
          note: noteSummarySchema,
          attachments: z.array(attachmentSchema),
        }),
        annotations: { ...READ_ANNOTATIONS, title: 'List attachments' },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => ok(await services.attachments.list(args.noteId)),
    }),
    defineTool({
      name: 'get_attachment',
      scope: 'trilium.read',
      config: {
        title: 'Get attachment',
        description:
          'Read one attachment: metadata plus content. Text-like mime types come back as content (UTF-8, truncated at maxContentBytes); everything else as contentBase64, and images additionally as an image content block. Binary bodies larger than maxContentBytes are omitted with their size; raise the limit to fetch them.',
        inputSchema: z.object({
          attachmentId: z
            .string()
            .regex(/^[A-Za-z0-9_]{1,64}$/, 'attachmentId must be 1-64 characters of [A-Za-z0-9_]')
            .describe('From list_attachments'),
          includeContent: z.boolean().optional().describe('Default true'),
          maxContentBytes: z.number().int().min(1024).optional(),
        }),
        outputSchema: z.object({
          attachment: attachmentSchema,
          content: z.string().optional(),
          contentBase64: z.string().optional(),
          contentBytes: z.number().optional(),
          contentTruncated: z.boolean().optional(),
          contentOmittedReason: z.string().optional(),
          isImage: z.boolean(),
        }),
        annotations: { ...READ_ANNOTATIONS, title: 'Get attachment' },
      },
      noteIds: () => [],
      handler: async (args) => {
        const result = await services.attachments.get(args);
        return withAttachmentNote(
          result.contentBase64 !== undefined && result.isImage
            ? okWith(result, [
                {
                  type: 'image',
                  data: result.contentBase64,
                  mimeType: result.attachment.mime,
                },
              ])
            : ok(result),
          result.attachment.ownerNoteId,
        );
      },
    }),
  ];
}

/** Attachments are addressed by their own id; record the owning note for the audit trail. */
function withAttachmentNote(result: CallToolResult, ownerNoteId: string): CallToolResult {
  return withAudit(result, { noteIds: [ownerNoteId] });
}
