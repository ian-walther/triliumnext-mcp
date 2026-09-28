/**
 * Hierarchy operations on Trilium branches. A note can live in several places
 * (each placement is a branch); moving is "add the new branch, then remove the
 * old one", in that order, so the note never loses its last branch (Trilium
 * deletes a note with its last branch).
 */
import type { TriliumClient } from '../etapi/client.js';
import { NOTE_ID_PATTERN } from '../etapi/client.js';
import type { EtapiBranch, EtapiNote } from '../etapi/types.js';
import { DomainError } from './errors.js';
import { KeyedMutex } from './keyedMutex.js';
import { toNoteDetail, type NoteDetail } from './model.js';
import { fetchNote, isSystemNoteId } from './shared.js';

export interface BranchView {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  prefix: string | null;
  notePosition: number;
  isExpanded: boolean;
}

export interface MoveNoteInput {
  noteId: string;
  targetParentNoteId: string;
  /** Which existing placement to move, when the note has several parents. */
  fromParentNoteId?: string | undefined;
  /** 'move' (default) relocates one placement; 'clone' adds a placement and keeps the others. */
  mode?: 'move' | 'clone' | undefined;
  /** 'first', 'last' (default), or an explicit Trilium notePosition. */
  position?: 'first' | 'last' | number | undefined;
  /** Branch prefix for the new placement; omitted keeps the moved branch's prefix, null clears it. */
  prefix?: string | null | undefined;
}

export interface MoveNoteResult {
  note: NoteDetail;
  mode: 'move' | 'clone';
  /** The placement under targetParentNoteId after the call. */
  branch: BranchView;
  /** The placement that was removed (move only). */
  removedBranch?: BranchView;
  /** True when the note was already placed under the target and nothing changed. */
  noop: boolean;
  warnings: string[];
}

/** Upper bound on ancestors visited when checking for cycles; Trilium trees are far shallower. */
export const MAX_ANCESTOR_WALK = 5000;
/** Sibling placements read to resolve 'first'/'last' for an existing placement. */
export const MAX_SIBLING_BRANCHES = 1000;
/** Key of the process-wide lock shared by every operation that changes the tree (AUDIT R10). */
export const HIERARCHY_LOCK = 'hierarchy';

export function toBranchView(branch: EtapiBranch): BranchView {
  return {
    branchId: branch.branchId,
    noteId: branch.noteId,
    parentNoteId: branch.parentNoteId,
    prefix: branch.prefix ?? null,
    notePosition: branch.notePosition,
    isExpanded: Boolean(branch.isExpanded),
  };
}

export class HierarchyService {
  private readonly mutex: KeyedMutex;

  constructor(
    private readonly client: TriliumClient,
    mutex?: KeyedMutex,
  ) {
    this.mutex = mutex ?? new KeyedMutex();
  }

  move(input: MoveNoteInput): Promise<MoveNoteResult> {
    // Tree changes are serialized process-wide so deletion's checks cannot be
    // invalidated by a concurrent move (AUDIT R10); the per-note lock keeps the
    // usual ordering with content writes (hierarchy first, then note).
    return this.mutex.run(HIERARCHY_LOCK, () =>
      this.mutex.run(`note:${input.noteId}`, () => this.moveUnlocked(input)),
    );
  }

  private async moveUnlocked(input: MoveNoteInput): Promise<MoveNoteResult> {
    const { client } = this;
    const mode = input.mode ?? 'move';
    const { noteId, targetParentNoteId } = input;
    for (const [name, value] of [
      ['noteId', noteId],
      ['targetParentNoteId', targetParentNoteId],
      ['fromParentNoteId', input.fromParentNoteId],
    ] as const) {
      if (value !== undefined && !NOTE_ID_PATTERN.test(value))
        throw DomainError.validation(`Invalid ${name} '${value}'`);
    }
    if (noteId === 'root') throw DomainError.validation('The root note cannot be moved or cloned');
    if (
      isSystemNoteId(noteId) ||
      (isSystemNoteId(targetParentNoteId) && targetParentNoteId !== 'root')
    ) {
      throw DomainError.validation(
        "Trilium system notes (ids starting with '_') cannot be moved, cloned, or used as a target",
      );
    }
    if (targetParentNoteId === noteId)
      throw DomainError.validation('A note cannot be placed under itself');
    if (
      input.position !== undefined &&
      typeof input.position === 'number' &&
      (!Number.isInteger(input.position) || input.position < 0)
    ) {
      throw DomainError.validation('position must be "first", "last", or a non-negative integer');
    }

    const note = await fetchNote(client, noteId);
    const target = await fetchNote(client, targetParentNoteId);
    if (target.type === 'search') {
      throw DomainError.validation(`'${target.title}' is a search note and cannot hold children`);
    }
    await this.assertNoCycle(noteId, target);

    const warnings: string[] = [];
    const parents = note.parentNoteIds ?? [];
    const alreadyThere = parents.includes(targetParentNoteId);

    // Which placement leaves (move only). A placement under the target itself is
    // never a source: the destination branch must survive (AUDIT R9).
    let source: EtapiBranch | undefined;
    if (mode === 'move') {
      const branches = await this.parentBranches(note);
      if (input.fromParentNoteId !== undefined) {
        source = branches.find((b) => b.parentNoteId === input.fromParentNoteId);
        if (!source)
          throw DomainError.notFound(
            `Placement of '${note.title}' under parent`,
            input.fromParentNoteId,
          );
        if (source.parentNoteId === targetParentNoteId) source = undefined; // in-place edit
      } else {
        const candidates = branches.filter((b) => b.parentNoteId !== targetParentNoteId);
        if (candidates.length === 0 && alreadyThere) {
          source = undefined; // only placement is already the target
        } else if (candidates.length === 1) {
          source = candidates[0];
        } else if (candidates.length === 0) {
          throw DomainError.notFound('Placement of note', noteId);
        } else {
          throw new DomainError(
            'AMBIGUOUS',
            `'${note.title}' is placed under ${branches.length} parents; pass fromParentNoteId to say which placement moves, or mode='clone' to add one`,
            { parents: branches.map((b) => ({ parentNoteId: b.parentNoteId, prefix: b.prefix })) },
          );
        }
      }
    }

    // Position and prefix for the new placement. On a fresh branch Trilium puts an
    // omitted position last and 0 first; an existing placement is repositioned
    // against its current siblings instead (AUDIT R13).
    const notePosition =
      input.position === 'first'
        ? 0
        : typeof input.position === 'number'
          ? input.position
          : undefined;
    const prefix =
      input.prefix === undefined ? (source?.prefix ?? undefined) : (input.prefix ?? undefined);

    let branch: EtapiBranch;
    if (alreadyThere) {
      const existing = (await this.parentBranches(note)).find(
        (b) => b.parentNoteId === targetParentNoteId,
      )!;
      const patch: { notePosition?: number; prefix?: string } = {};
      if (input.position === 'first' || input.position === 'last') {
        const wanted = await this.edgePosition(target, existing, input.position);
        if (wanted !== existing.notePosition) patch.notePosition = wanted;
      } else if (notePosition !== undefined && notePosition !== existing.notePosition) {
        patch.notePosition = notePosition;
      }
      if (input.prefix !== undefined && (input.prefix ?? '') !== (existing.prefix ?? ''))
        patch.prefix = input.prefix ?? '';
      branch =
        Object.keys(patch).length > 0
          ? await client.patchBranch(existing.branchId, patch).catch((err: unknown) => {
              throw DomainError.from(err, 'update existing placement');
            })
          : existing;
      if (source === undefined) {
        return {
          note: toNoteDetail(await fetchNote(client, noteId)),
          mode,
          branch: toBranchView(branch),
          noop: Object.keys(patch).length === 0,
          warnings,
        };
      }
    } else {
      try {
        branch = await client.createBranch({
          noteId,
          parentNoteId: targetParentNoteId,
          ...(notePosition !== undefined ? { notePosition } : {}),
          ...(prefix !== undefined && prefix !== '' ? { prefix } : {}),
          ...(source ? { isExpanded: source.isExpanded } : {}),
        });
      } catch (err) {
        throw DomainError.from(err, `place '${note.title}' under '${target.title}'`);
      }
    }

    let removedBranch: BranchView | undefined;
    if (source) {
      // The destination placement exists and is a different branch, so removing
      // the old one can never delete the note.
      if (source.branchId === branch.branchId || source.parentNoteId === targetParentNoteId) {
        throw new DomainError('INTERNAL', 'refusing to remove the destination placement', {
          branchId: source.branchId,
        });
      }
      try {
        await client.deleteBranch(source.branchId);
        removedBranch = toBranchView(source);
      } catch (err) {
        throw DomainError.from(
          err,
          `remove the old placement of '${note.title}' (the note is now also under '${target.title}')`,
        );
      }
      if (parents.length > 1) {
        warnings.push(
          `The note keeps its other ${parents.length - 1} placement(s); only the one under '${source.parentNoteId}' moved.`,
        );
      }
    }
    return {
      note: toNoteDetail(await fetchNote(client, noteId)),
      mode,
      branch: toBranchView(branch),
      ...(removedBranch ? { removedBranch } : {}),
      noop: false,
      warnings,
    };
  }

  /**
   * notePosition that puts `existing` first or last among the target's current
   * children: below the lowest sibling (never above 0 unless a sibling is) or
   * 10 past the highest, matching Trilium's own spacing.
   */
  private async edgePosition(
    target: EtapiNote,
    existing: EtapiBranch,
    edge: 'first' | 'last',
  ): Promise<number> {
    const ids = (target.childBranchIds ?? []).filter((id) => id !== existing.branchId);
    if (ids.length > MAX_SIBLING_BRANCHES) {
      throw DomainError.validation(
        `'${target.title}' has more than ${MAX_SIBLING_BRANCHES} children; pass an explicit numeric position instead of '${edge}'`,
      );
    }
    let siblings: EtapiBranch[];
    try {
      siblings = await Promise.all(ids.map((id) => this.client.getBranch(id)));
    } catch (err) {
      throw DomainError.from(err, `read sibling placements under ${target.noteId}`);
    }
    if (siblings.length === 0) return existing.notePosition;
    const positions = siblings.map((b) => b.notePosition);
    if (edge === 'last') {
      const max = Math.max(...positions);
      return existing.notePosition > max ? existing.notePosition : max + 10;
    }
    const min = Math.min(...positions);
    return existing.notePosition < min ? existing.notePosition : Math.min(0, min - 10);
  }

  private async parentBranches(note: EtapiNote): Promise<EtapiBranch[]> {
    const ids = note.parentBranchIds ?? [];
    try {
      return await Promise.all(ids.map((id) => this.client.getBranch(id)));
    } catch (err) {
      throw DomainError.from(err, `read placements of ${note.noteId}`);
    }
  }

  /** Refuse when `noteId` is the target or one of its ancestors: the new branch would form a cycle. */
  private async assertNoCycle(noteId: string, target: EtapiNote): Promise<void> {
    const seen = new Set<string>([target.noteId]);
    const queue: string[] = [...(target.parentNoteIds ?? [])];
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === noteId) {
        throw DomainError.validation(
          `Cannot place '${noteId}' under '${target.noteId}': the target is inside that note's subtree`,
          { noteId, targetParentNoteId: target.noteId },
        );
      }
      if (seen.has(id) || id === 'root') continue;
      seen.add(id);
      if (++visited > MAX_ANCESTOR_WALK)
        throw new DomainError('TOO_LARGE', 'Ancestor chain too long to verify');
      const ancestor = await fetchNote(this.client, id).catch((err: unknown) => {
        if (err instanceof DomainError && err.code === 'NOT_FOUND') return undefined;
        throw err;
      });
      if (ancestor) queue.push(...(ancestor.parentNoteIds ?? []));
    }
  }
}
