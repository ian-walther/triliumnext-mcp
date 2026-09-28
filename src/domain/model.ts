/** Agent-facing shapes shared by services and tools. Kept small and stable. */
import type { EtapiAttribute, EtapiNote } from '../etapi/types.js';

export interface AttributeView {
  attributeId: string;
  type: 'label' | 'relation';
  name: string;
  value: string;
  position: number;
  isInheritable: boolean;
  /** True when the attribute is owned by another note (inherited or from a template). */
  inherited: boolean;
}

export interface NoteSummary {
  noteId: string;
  title: string;
  type: string;
  mime: string;
  isProtected: boolean;
  dateCreated: string;
  dateModified: string;
  utcDateModified: string;
  parentNoteIds: string[];
  childCount: number;
  /** Owned labels rendered as `#name` or `#name=value`, for cheap orientation. */
  labels: string[];
}

export interface NoteDetail extends NoteSummary {
  childNoteIds: string[];
  attributes: AttributeView[];
  contentHash: string;
}

export function toAttributeView(attr: EtapiAttribute, ownerNoteId: string): AttributeView {
  return {
    attributeId: attr.attributeId,
    type: attr.type,
    name: attr.name,
    value: attr.value ?? '',
    position: attr.position ?? 0,
    isInheritable: Boolean(attr.isInheritable),
    inherited: attr.noteId !== ownerNoteId,
  };
}

export function toNoteSummary(note: EtapiNote): NoteSummary {
  const labels = (note.attributes ?? [])
    .filter((a) => a.type === 'label' && a.noteId === note.noteId)
    .map((a) => (a.value ? `#${a.name}=${a.value}` : `#${a.name}`));
  return {
    noteId: note.noteId,
    title: note.title,
    type: note.type,
    mime: note.mime ?? '',
    isProtected: Boolean(note.isProtected),
    dateCreated: note.dateCreated,
    dateModified: note.dateModified,
    utcDateModified: note.utcDateModified,
    parentNoteIds: note.parentNoteIds ?? [],
    childCount: (note.childNoteIds ?? []).length,
    labels,
  };
}

export function toNoteDetail(note: EtapiNote): NoteDetail {
  return {
    ...toNoteSummary(note),
    childNoteIds: note.childNoteIds ?? [],
    attributes: (note.attributes ?? []).map((a) => toAttributeView(a, note.noteId)),
    contentHash: note.blobId,
  };
}
