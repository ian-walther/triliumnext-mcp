/** Helpers shared by the domain services. Nothing here knows about MCP. */
import type { TriliumClient } from '../etapi/client.js';
import { EtapiError } from '../etapi/errors.js';
import type { EtapiNote } from '../etapi/types.js';
import { DomainError } from './errors.js';

export async function fetchNote(client: TriliumClient, noteId: string): Promise<EtapiNote> {
  try {
    return await client.getNote(noteId);
  } catch (err) {
    if (err instanceof EtapiError && err.isNotFound) throw DomainError.notFound('Note', noteId);
    throw DomainError.from(err, `get note ${noteId}`);
  }
}

/**
 * Fetch several notes. Vanished notes (404) are reported in `missing`; any other
 * failure (timeout, outage, auth) is raised, because silently dropping a child
 * would make a partial hierarchy look complete.
 */
export async function fetchNotesById(
  client: TriliumClient,
  ids: string[],
  context: string,
): Promise<{ notes: Map<string, EtapiNote>; missing: string[] }> {
  const notes = new Map<string, EtapiNote>();
  const missing: string[] = [];
  const results = await Promise.allSettled(ids.map((id) => client.getNote(id)));
  let failure: unknown;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') notes.set(ids[i]!, r.value);
    else if (r.reason instanceof EtapiError && r.reason.isNotFound) missing.push(ids[i]!);
    else failure ??= r.reason;
  });
  if (failure !== undefined) throw DomainError.from(failure, context);
  return { notes, missing };
}

export function assertHash(note: EtapiNote, expectedHash: string): void {
  if (note.blobId !== expectedHash) {
    throw new DomainError(
      'CONFLICT',
      `Note '${note.noteId}' has changed since it was read (current hash ${note.blobId}, expected ${expectedHash}). Call get_note again and retry with the new contentHash.`,
      {
        noteId: note.noteId,
        currentHash: note.blobId,
        expectedHash,
      },
    );
  }
}

/** Trilium's system notes (hidden subtree, templates, launchers) all carry a leading underscore. */
export function isSystemNoteId(noteId: string): boolean {
  return noteId === 'root' || noteId.startsWith('_');
}
