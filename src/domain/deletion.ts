/**
 * Destructive operations (scope trilium.admin). Deleting a note in Trilium is a
 * soft delete: the note and the descendants that lose their last parent are
 * marked deleted and erased later by Trilium's housekeeping (7 days by
 * default), and `undelete` reverses it until then.
 */
import type { TriliumClient } from '../etapi/client.js';
import { EtapiError } from '../etapi/errors.js';
import { DomainError } from './errors.js';
import { toNoteDetail, toNoteSummary, type NoteDetail, type NoteSummary } from './model.js';
import { quote } from './query/builder.js';
import { fetchNote, isSystemNoteId } from './shared.js';

export interface DeleteNoteInput {
  noteId: string;
  /** Must equal the note's current title exactly; proves the caller read the note it is deleting. */
  expectedTitle: string;
  /** Must be true. */
  confirm: boolean;
  /** Required when the note has descendants. */
  deleteDescendants?: boolean | undefined;
  /** Report what would be deleted without deleting. */
  dryRun?: boolean | undefined;
}

export interface DeletePlan {
  note: NoteSummary;
  /** Notes reachable below this one (those with another parent survive as that parent's child). */
  descendantCount: number;
  descendantCountTruncated: boolean;
  sampleDescendants: NoteSummary[];
  parentCount: number;
}

export interface DeleteNoteResult extends DeletePlan {
  deleted: boolean;
  dryRun: boolean;
  /** Trilium keeps deleted notes until its erasure job runs; undelete_note reverses until then. */
  undeletable: boolean;
  warnings: string[];
}

export interface UndeleteNoteResult {
  note: NoteDetail;
}

/** Descendants are counted up to this many; larger subtrees are reported as truncated. */
export const MAX_DESCENDANT_COUNT = 1000;

export class DeletionService {
  constructor(private readonly client: TriliumClient) {}

  async plan(noteId: string): Promise<DeletePlan> {
    const note = await fetchNote(this.client, noteId);
    const res = await this.client
      .searchNotes({
        search: `note.ancestors.noteId = ${quote(noteId)}`,
        fastSearch: false,
        includeArchivedNotes: true,
        limit: MAX_DESCENDANT_COUNT + 1,
      })
      .catch((err: unknown) => {
        throw DomainError.from(err, `count descendants of ${noteId}`);
      });
    const found = (res.results ?? []).filter((n) => n.noteId !== noteId);
    const truncated = found.length > MAX_DESCENDANT_COUNT;
    return {
      note: toNoteSummary(note),
      descendantCount: Math.min(found.length, MAX_DESCENDANT_COUNT),
      descendantCountTruncated: truncated,
      sampleDescendants: found.slice(0, 10).map(toNoteSummary),
      parentCount: (note.parentNoteIds ?? []).length,
    };
  }

  async deleteNote(input: DeleteNoteInput): Promise<DeleteNoteResult> {
    if (isSystemNoteId(input.noteId)) {
      throw DomainError.validation(
        "The root note and Trilium system notes (ids starting with '_') cannot be deleted",
      );
    }
    if (input.confirm !== true) {
      throw DomainError.validation(
        'delete_note requires confirm=true; this permanently removes the note after Trilium’s erasure window',
      );
    }
    const plan = await this.plan(input.noteId);
    if (plan.note.title !== input.expectedTitle) {
      throw new DomainError(
        'CONFLICT',
        `expectedTitle does not match: the note is titled '${plan.note.title}'. Re-read the note and pass its exact title.`,
        { noteId: input.noteId, currentTitle: plan.note.title, expectedTitle: input.expectedTitle },
      );
    }
    const warnings: string[] = [];
    if (plan.descendantCount > 0 && input.deleteDescendants !== true) {
      throw DomainError.validation(
        `'${plan.note.title}' has ${plan.descendantCountTruncated ? 'more than ' : ''}${plan.descendantCount} descendant note(s). Pass deleteDescendants=true to delete the whole subtree, or move the children first.`,
        {
          descendantCount: plan.descendantCount,
          descendantCountTruncated: plan.descendantCountTruncated,
          sampleDescendants: plan.sampleDescendants.map((n) => ({
            noteId: n.noteId,
            title: n.title,
          })),
        },
      );
    }
    if (plan.parentCount > 1) {
      warnings.push(
        `The note is placed under ${plan.parentCount} parents; deleting removes it from all of them. To remove one placement only, use move_note or Trilium.`,
      );
    }
    if (plan.descendantCount > 0) {
      warnings.push(
        'Descendants that also have another parent survive under that parent; the count above includes them.',
      );
    }
    if (input.dryRun) {
      return { ...plan, deleted: false, dryRun: true, undeletable: true, warnings };
    }
    try {
      await this.client.deleteNote(input.noteId);
    } catch (err) {
      throw DomainError.from(err, `delete note ${input.noteId}`);
    }
    // Confirm the upstream really removed it; a 2xx with the note still readable would be a lie.
    const stillThere = await this.client.getNote(input.noteId).then(
      () => true,
      (err: unknown) => {
        if (err instanceof EtapiError && err.isNotFound) return false;
        throw DomainError.from(err, `verify deletion of ${input.noteId}`);
      },
    );
    if (stillThere) {
      throw new DomainError(
        'UPSTREAM',
        `Trilium accepted the delete but note '${input.noteId}' is still readable`,
        { noteId: input.noteId },
      );
    }
    return { ...plan, deleted: true, dryRun: false, undeletable: true, warnings };
  }

  async undeleteNote(noteId: string): Promise<UndeleteNoteResult> {
    if (isSystemNoteId(noteId)) throw DomainError.validation('Invalid noteId');
    const live = await this.client.getNote(noteId).then(
      (note) => note,
      (err: unknown) => {
        if (err instanceof EtapiError && err.isNotFound) return undefined;
        throw DomainError.from(err, `check note ${noteId}`);
      },
    );
    if (live) {
      throw DomainError.validation(`Note '${noteId}' is not deleted`, { noteId });
    }
    try {
      await this.client.undeleteNote(noteId);
    } catch (err) {
      if (err instanceof EtapiError && err.isNotFound) {
        throw new DomainError(
          'NOT_FOUND',
          `Note '${noteId}' is not known to Trilium as a deleted note (never existed, or already erased)`,
          { noteId },
        );
      }
      throw DomainError.from(err, `undelete note ${noteId}`);
    }
    return { note: toNoteDetail(await fetchNote(this.client, noteId)) };
  }
}
