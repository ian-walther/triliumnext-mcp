/**
 * Destructive tools (scope trilium.admin). Every one of them is annotated
 * destructive, requires an explicit confirm, and is reversible where Trilium
 * allows it (note deletion is a soft delete until Trilium's erasure job runs).
 */
import * as z from 'zod/v4';
import { DomainError } from '../../domain/errors.js';
import type { Services } from '../../domain/services.js';
import { ok, withAudit } from '../results.js';
import { attachmentSchema, noteDetailSchema, noteIdSchema, noteSummarySchema } from '../schemas.js';
import { defineTool, type AnyToolDefinition } from './types.js';

const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const deletePlanShape = {
  note: noteSummarySchema,
  descendantCount: z
    .number()
    .describe('Notes below this one (counted up to 1000); those with another parent survive there'),
  descendantCountTruncated: z.boolean(),
  sampleDescendants: z.array(noteSummarySchema).describe('Up to 10 of them'),
  parentCount: z.number(),
};

export function adminTools(services: Services): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'delete_note',
      scope: 'trilium.admin',
      config: {
        title: 'Delete note',
        description:
          "Delete a note (and, only with deleteDescendants=true, its subtree). Requires confirm=true and expectedTitle equal to the note's current title, which forces a read first. Use dryRun=true to see what would go. Trilium soft-deletes: undelete_note restores the note until Trilium's erasure job runs (7 days by default). Never deletes root or system notes.",
        inputSchema: z.object({
          noteId: noteIdSchema,
          expectedTitle: z
            .string()
            .max(1000)
            .describe("The note's exact current title (from get_note or resolve_note)"),
          confirm: z.boolean().describe('Must be true'),
          deleteDescendants: z
            .boolean()
            .optional()
            .describe('Required when the note has children (default false: refuse)'),
          dryRun: z
            .boolean()
            .optional()
            .describe('Report the plan without deleting (default false)'),
        }),
        outputSchema: z.object({
          ...deletePlanShape,
          deleted: z.boolean(),
          dryRun: z.boolean(),
          undeletable: z.boolean().describe('True: undelete_note can restore it for now'),
          warnings: z.array(z.string()),
        }),
        annotations: { ...DESTRUCTIVE, title: 'Delete note', idempotentHint: true },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => {
        const result = await services.deletion.deleteNote(args);
        return withAudit(ok(result), {
          noteIds: [args.noteId, ...result.sampleDescendants.map((n) => n.noteId)],
          ...(result.dryRun ? { code: 'DRY_RUN' } : {}),
        });
      },
    }),
    defineTool({
      name: 'undelete_note',
      scope: 'trilium.admin',
      config: {
        title: 'Undelete note',
        description:
          'Restore a note deleted with delete_note (or in Trilium) that has not been erased yet. The note needs at least one parent that still exists.',
        inputSchema: z.object({ noteId: noteIdSchema }),
        outputSchema: z.object({ note: noteDetailSchema }),
        annotations: {
          title: 'Undelete note',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      noteIds: (args) => [args.noteId],
      handler: async (args) => ok(await services.deletion.undeleteNote(args.noteId)),
    }),
    defineTool({
      name: 'delete_attachment',
      scope: 'trilium.admin',
      config: {
        title: 'Delete attachment',
        description:
          'Delete one attachment of a note. Requires confirm=true. Not reversible through this server.',
        inputSchema: z.object({
          attachmentId: z
            .string()
            .regex(/^[A-Za-z0-9_]{1,64}$/, 'attachmentId must be 1-64 characters of [A-Za-z0-9_]'),
          confirm: z.boolean().describe('Must be true'),
        }),
        outputSchema: z.object({ attachment: attachmentSchema, deleted: z.boolean() }),
        annotations: { ...DESTRUCTIVE, title: 'Delete attachment', idempotentHint: true },
      },
      noteIds: () => [],
      handler: async (args) => {
        if (args.confirm !== true) {
          throw DomainError.validation('delete_attachment requires confirm=true');
        }
        const result = await services.attachments.delete(args.attachmentId);
        return withAudit(ok(result), { noteIds: [result.attachment.ownerNoteId] });
      },
    }),
  ];
}
