/** Write tools (scope trilium.write). All content writes are hash-protected. */
import * as z from 'zod/v4';
import type { Services } from '../../domain/services.js';
import { ok, withAudit } from '../results.js';
import {
  attachmentSchema,
  attributeInputSchema,
  attributeOpResultSchema,
  attributeViewSchema,
  base64Schema,
  branchSchema,
  contentFormatSchema,
  noteDetailSchema,
  noteIdSchema,
  noteSummarySchema,
  noteTypeSchema,
} from '../schemas.js';

const attachmentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,64}$/, 'attachmentId must be 1-64 characters of [A-Za-z0-9_]')
  .describe('From list_attachments or get_attachment');
import { defineTool, type AnyToolDefinition } from './types.js';

const editSchema = z.object({
  find: z.string().min(1).max(20000).describe('Text (or regex when regex=true) to locate'),
  replace: z
    .string()
    .max(200000)
    .describe('Replacement text. With regex=true, $1-style backreferences work.'),
  regex: z.boolean().optional(),
  flags: z.string().max(6).optional().describe("Regex flags such as 'i' or 'm'"),
  all: z
    .boolean()
    .optional()
    .describe(
      'Replace every occurrence (default false: exactly one must match, or set occurrence)',
    ),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based occurrence to replace when find matches several times'),
});

export function writeTools(services: Services): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'create_note',
      scope: 'trilium.write',
      config: {
        title: 'Create note',
        description:
          "Create a note under a parent. Text notes accept Markdown, HTML or plain text (auto-detected). File and image notes take contentBase64 plus mime instead of content. Refuses to create a same-titled sibling unless ifTitleExists is 'create' or 'return_existing'. Optional attributes (labels, relations such as template=Board) are applied in the same call. Supply idempotencyKey when a retry must not create a second note.",
        inputSchema: z.object({
          parentNoteId: noteIdSchema.optional().describe("Default 'root'"),
          title: z.string().min(1).max(1000),
          type: noteTypeSchema
            .optional()
            .describe(
              "Default 'text'. Common: text, code (needs mime), book (folder), mermaid, search, render, webView, relationMap, noteMap, file/image (need contentBase64 + mime).",
            ),
          mime: z
            .string()
            .max(200)
            .optional()
            .describe(
              "Required for code notes, e.g. 'text/x-python', 'application/json', 'text/plain', and for file/image notes, e.g. 'image/png', 'application/pdf'",
            ),
          content: z
            .string()
            .max(4_000_000)
            .optional()
            .describe('Initial content (optional). Markdown is converted to HTML for text notes.'),
          contentBase64: base64Schema.max(6_000_000).optional(),
          contentFormat: contentFormatSchema,
          attributes: z.array(attributeInputSchema).max(50).optional(),
          ifTitleExists: z
            .enum(['error', 'create', 'return_existing'])
            .optional()
            .describe("Default 'error'"),
          idempotencyKey: z
            .string()
            .min(8)
            .max(200)
            .optional()
            .describe(
              'Caller-chosen key; a retry with the same key returns the original note instead of creating another',
            ),
          position: z
            .enum(['first', 'last'])
            .optional()
            .describe("Where to place the note among siblings (default 'last')"),
        }),
        outputSchema: z.object({
          note: noteDetailSchema,
          branchId: z.string(),
          created: z.boolean(),
          existing: z.array(noteSummarySchema).optional(),
          contentFormat: z.string().optional(),
          attributeResults: z.array(attributeOpResultSchema),
          warnings: z.array(z.string()),
          idempotentReplay: z.boolean(),
          incomplete: z
            .boolean()
            .optional()
            .describe('Replay of a request that failed after the note was created; see warnings'),
        }),
        annotations: {
          title: 'Create note',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      noteIds: (args) => [args.parentNoteId ?? 'root'],
      handler: async (args, ctx) => {
        const created = await services.notes.create({ ...args, principal: ctx.principal.id });
        return withAudit(ok(created), {
          noteIds: [args.parentNoteId ?? 'root', created.note.noteId],
          ...(created.incomplete
            ? { code: 'INCOMPLETE' }
            : created.attributeResults.some((r) => !r.ok)
              ? { code: 'PARTIAL' }
              : {}),
        });
      },
    }),
    defineTool({
      name: 'patch_note',
      scope: 'trilium.write',
      config: {
        title: 'Patch note content',
        description:
          "Write note content safely. Requires expectedHash from get_note; the write is refused (code CONFLICT) if the note changed in between. operation: 'replace' whole content, 'append' / 'prepend' with a separator, or 'edit' with find/replace edits applied in order (each must match exactly once unless occurrence or all is set). File/image notes only support 'replace' with contentBase64. A revision is saved first unless createRevision=false. Returns the new contentHash.",
        inputSchema: z.object({
          noteId: noteIdSchema,
          expectedHash: z
            .string()
            .min(1)
            .max(100)
            .describe('contentHash from the get_note call you based this change on'),
          operation: z.enum(['replace', 'append', 'prepend', 'edit']),
          content: z
            .string()
            .max(4_000_000)
            .optional()
            .describe('New content for replace/append/prepend'),
          contentBase64: base64Schema
            .max(6_000_000)
            .optional()
            .describe("Replacement body for file/image notes (operation 'replace')"),
          contentFormat: contentFormatSchema,
          edits: z.array(editSchema).max(100).optional().describe("For operation 'edit'"),
          separator: z
            .string()
            .max(100)
            .optional()
            .describe(
              'Inserted between existing and new content for append/prepend (default newline)',
            ),
          createRevision: z.boolean().optional().describe('Default true'),
        }),
        outputSchema: z.object({
          note: noteDetailSchema,
          previousHash: z.string(),
          contentHash: z.string(),
          revisionCreated: z.boolean(),
          editsApplied: z.number(),
          contentBytes: z.number(),
          warnings: z.array(z.string()),
        }),
        annotations: {
          title: 'Patch note content',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => ok(await services.notes.patch(args)),
    }),
    defineTool({
      name: 'update_note_metadata',
      scope: 'trilium.write',
      config: {
        title: 'Update note metadata',
        description:
          'Rename a note or change its type/mime without touching content. Content hash is unaffected by a title change.',
        inputSchema: z.object({
          noteId: noteIdSchema,
          title: z.string().min(1).max(1000).optional(),
          type: noteTypeSchema.optional(),
          mime: z.string().max(200).optional(),
        }),
        outputSchema: z.object({ note: noteDetailSchema, changed: z.array(z.string()) }),
        annotations: {
          title: 'Update note metadata',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => ok(await services.notes.updateMetadata(args)),
    }),
    defineTool({
      name: 'manage_attributes',
      scope: 'trilium.write',
      config: {
        title: 'Manage attributes',
        description:
          "Add, update or remove labels and relations on a note. Operations run in order and each reports ok/error individually. 'update' and 'remove' identify the attribute by attributeId or by name (must be unique). Relation values may be a noteId or an exact note title; ETAPI cannot retarget relations or change isInheritable, so remove and re-add for those.",
        inputSchema: z.object({
          noteId: noteIdSchema,
          operations: z
            .array(
              z.object({
                action: z.enum(['add', 'update', 'remove']),
                attributeId: z.string().max(64).optional(),
                type: z.enum(['label', 'relation']).optional(),
                name: z.string().max(200).optional(),
                value: z.string().max(4000).optional(),
                position: z.number().int().min(0).optional(),
                isInheritable: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(50),
        }),
        outputSchema: z.object({
          note: noteDetailSchema,
          results: z.array(attributeOpResultSchema),
          attributes: z.array(attributeViewSchema),
        }),
        annotations: {
          title: 'Manage attributes',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => {
        const result = await services.attributes.manage(args.noteId, args.operations);
        const failed = result.results.filter((r) => !r.ok).length;
        return withAudit(ok({ ...result, attributes: result.note.attributes }), {
          ...(failed > 0
            ? { code: failed === result.results.length ? 'ALL_FAILED' : 'PARTIAL' }
            : {}),
        });
      },
    }),
    defineTool({
      name: 'move_note',
      scope: 'trilium.write',
      config: {
        title: 'Move or clone note',
        description:
          "Move a note to another parent, or clone it there (Trilium notes can live in several places). mode 'move' (default) relocates one placement: the new placement is created before the old one is removed, so the note is never without a parent. When the note already has several parents, say which one leaves with fromParentNoteId. Refuses cycles (a target inside the note's own subtree). Content, attributes and contentHash are unaffected.",
        inputSchema: z.object({
          noteId: noteIdSchema,
          targetParentNoteId: noteIdSchema.describe('The new parent'),
          fromParentNoteId: noteIdSchema
            .optional()
            .describe('Which existing placement moves, when the note has several parents'),
          mode: z.enum(['move', 'clone']).optional().describe("Default 'move'"),
          position: z
            .union([z.enum(['first', 'last']), z.number().int().min(0)])
            .optional()
            .describe("'first', 'last' (default), or an explicit Trilium notePosition"),
          prefix: z
            .string()
            .max(200)
            .nullable()
            .optional()
            .describe(
              'Branch prefix for the new placement; omitted keeps the old one, null clears',
            ),
        }),
        outputSchema: z.object({
          note: noteDetailSchema,
          mode: z.enum(['move', 'clone']),
          branch: branchSchema.describe('The placement under targetParentNoteId'),
          removedBranch: branchSchema.optional(),
          noop: z.boolean().describe('True when the note was already there and nothing changed'),
          warnings: z.array(z.string()),
        }),
        annotations: {
          title: 'Move or clone note',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      noteIds: (args) => [args.noteId, args.targetParentNoteId],
      handler: async (args) => {
        const result = await services.hierarchy.move(args);
        return withAudit(ok(result), {
          noteIds: [
            args.noteId,
            args.targetParentNoteId,
            ...(result.removedBranch ? [result.removedBranch.parentNoteId] : []),
          ],
          ...(result.noop ? { code: 'NOOP' } : {}),
        });
      },
    }),
    defineTool({
      name: 'create_attachment',
      scope: 'trilium.write',
      config: {
        title: 'Create attachment',
        description:
          "Attach a file to a note. Text goes in content, binary data in contentBase64 (base64 or a data: URI). role defaults to 'image' for image/* mime types (shown inline by Trilium) and 'file' otherwise. Returns the attachment with its contentHash.",
        inputSchema: z.object({
          noteId: noteIdSchema.describe('The note that will own the attachment'),
          title: z.string().min(1).max(500).describe('File name as shown in Trilium'),
          mime: z.string().max(200).describe("e.g. 'image/png', 'application/pdf', 'text/csv'"),
          role: z.string().max(50).optional().describe("Trilium role: 'image' or 'file'"),
          content: z.string().max(4_000_000).optional().describe('Text content'),
          contentBase64: base64Schema.max(6_000_000).optional(),
          position: z.number().int().min(0).optional(),
        }),
        outputSchema: z.object({ attachment: attachmentSchema, note: noteSummarySchema }),
        annotations: {
          title: 'Create attachment',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => ok(await services.attachments.create(args)),
    }),
    defineTool({
      name: 'update_attachment',
      scope: 'trilium.write',
      config: {
        title: 'Update attachment',
        description:
          "Rename an attachment, change its mime/role/position, or replace its content. Replacing content requires expectedHash (the attachment's contentHash) and is refused with CONFLICT if it changed in between.",
        inputSchema: z.object({
          attachmentId: attachmentIdSchema,
          title: z.string().min(1).max(500).optional(),
          mime: z.string().max(200).optional(),
          role: z.string().max(50).optional(),
          position: z.number().int().min(0).optional(),
          content: z.string().max(4_000_000).optional().describe('New text content'),
          contentBase64: base64Schema.max(6_000_000).optional().describe('New binary content'),
          expectedHash: z
            .string()
            .max(100)
            .optional()
            .describe('Required when replacing content: contentHash from get_attachment'),
        }),
        outputSchema: z.object({
          attachment: attachmentSchema,
          changed: z.array(z.string()),
          previousHash: z.string().optional(),
        }),
        annotations: {
          title: 'Update attachment',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      noteIds: () => [],
      handler: async (args) => {
        const result = await services.attachments.update(args);
        return withAudit(ok(result), { noteIds: [result.attachment.ownerNoteId] });
      },
    }),
  ];
}
