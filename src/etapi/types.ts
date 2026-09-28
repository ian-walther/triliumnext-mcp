/** Wire types for the subset of the TriliumNext ETAPI this server uses (docs/reference/etapi.openapi.yaml). */

export const NOTE_TYPES = [
  'text',
  'code',
  'render',
  'file',
  'image',
  'search',
  'relationMap',
  'book',
  'noteMap',
  'mermaid',
  'webView',
  'shortcut',
  'doc',
  'contentWidget',
  'launcher',
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export type AttributeType = 'label' | 'relation';

export interface EtapiAttribute {
  attributeId: string;
  noteId: string;
  type: AttributeType;
  name: string;
  value: string;
  position: number;
  isInheritable: boolean;
  utcDateModified?: string;
}

export interface EtapiNote {
  noteId: string;
  title: string;
  /** One of NOTE_TYPES in practice; typed loosely because Trilium may add types. */
  type: string;
  mime: string;
  isProtected: boolean;
  blobId: string;
  attributes: EtapiAttribute[];
  parentNoteIds: string[];
  childNoteIds: string[];
  parentBranchIds: string[];
  childBranchIds: string[];
  dateCreated: string;
  dateModified: string;
  utcDateCreated: string;
  utcDateModified: string;
}

export interface EtapiBranch {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  prefix: string | null;
  notePosition: number;
  isExpanded: boolean;
  utcDateModified?: string;
}

export interface EtapiSearchResponse {
  results: EtapiNote[];
  debugInfo?: unknown;
}

export interface EtapiSearchParams {
  search: string;
  fastSearch?: boolean;
  includeArchivedNotes?: boolean;
  ancestorNoteId?: string;
  ancestorDepth?: string;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  debug?: boolean;
}

export interface EtapiCreateNoteDef {
  parentNoteId: string;
  title: string;
  type: string;
  mime?: string;
  content: string;
  notePosition?: number;
  prefix?: string;
  isExpanded?: boolean;
  noteId?: string;
  dateCreated?: string;
  utcDateCreated?: string;
}

export interface EtapiNoteWithBranch {
  note: EtapiNote;
  branch: EtapiBranch;
}

export interface EtapiNotePatch {
  title?: string;
  type?: string;
  mime?: string;
}

export interface EtapiCreateAttributeDef {
  noteId: string;
  type: AttributeType;
  name: string;
  value?: string;
  position?: number;
  isInheritable?: boolean;
  attributeId?: string;
}

export interface EtapiAttributePatch {
  value?: string;
  position?: number;
}

export interface EtapiCreateBranchDef {
  noteId: string;
  parentNoteId: string;
  notePosition?: number;
  prefix?: string;
  isExpanded?: boolean;
}

export interface EtapiAppInfo {
  appVersion: string;
  dbVersion: number;
  syncVersion: number;
  buildDate: string;
  buildRevision: string;
  dataDirectory: string;
  clipperProtocolVersion: string;
  utcDateTime: string;
}

export interface EtapiErrorBody {
  status: number;
  code: string;
  message: string;
}

export interface EtapiAttachment {
  attachmentId: string;
  /** noteId (or revisionId) that owns the attachment. */
  ownerId: string;
  role: string;
  mime: string;
  title: string;
  position: number;
  /** Content hash, like a note's blobId. */
  blobId: string;
  dateModified?: string;
  utcDateModified?: string;
  utcDateScheduledForErasureSince?: string | null;
  contentLength?: number;
}

export interface EtapiCreateAttachmentDef {
  ownerId: string;
  role: string;
  mime: string;
  title: string;
  /** Text content stored as-is; binary content is uploaded afterwards. */
  content?: string;
  position?: number;
}

export interface EtapiAttachmentPatch {
  role?: string;
  mime?: string;
  title?: string;
  position?: number;
}
