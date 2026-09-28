/**
 * Domain services: transport-agnostic operations over the typed ETAPI client.
 * Tool handlers call these; nothing here knows about MCP.
 */
import type { TriliumClient } from '../etapi/client.js';
import { NOTE_ID_PATTERN } from '../etapi/client.js';
import { EtapiError } from '../etapi/errors.js';
import type { EtapiAttribute, EtapiNote, EtapiSearchParams } from '../etapi/types.js';
import { NOTE_TYPES } from '../etapi/types.js';
import {
  BINARY_TYPES,
  htmlToPlainText,
  normalizeContentForWrite,
  truncateContent,
  type ContentFormat,
} from './content.js';
import { DomainError } from './errors.js';
import type { IdempotencyStore } from './idempotency.js';
import {
  toAttributeView,
  toNoteDetail,
  toNoteSummary,
  type AttributeView,
  type NoteDetail,
  type NoteSummary,
} from './model.js';
import { buildSearchQuery, quote, type Criterion } from './query/builder.js';

export interface ServiceLimits {
  maxWriteContentBytes: number;
  defaultReadContentBytes: number;
  maxReadContentBytes: number;
  maxSearchLimit: number;
  maxChildren: number;
}

export interface ServiceDeps {
  client: TriliumClient;
  limits: ServiceLimits;
  idempotency: IdempotencyStore;
}

// ---------------------------------------------------------------------------
// helpers

async function fetchNote(client: TriliumClient, noteId: string): Promise<EtapiNote> {
  try {
    return await client.getNote(noteId);
  } catch (err) {
    if (err instanceof EtapiError && err.isNotFound) throw DomainError.notFound('Note', noteId);
    throw DomainError.from(err, `get note ${noteId}`);
  }
}

async function fetchNotesById(
  client: TriliumClient,
  ids: string[],
): Promise<Map<string, EtapiNote>> {
  const out = new Map<string, EtapiNote>();
  const results = await Promise.allSettled(ids.map((id) => client.getNote(id)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.set(ids[i]!, r.value);
  });
  return out;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^o:(\d+)$/.exec(decoded);
  if (!match) throw DomainError.validation('Invalid cursor');
  return Number(match[1]);
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  /** Number of items known to exist (equals items when the whole result fit). */
  total: number;
}

function paginate<T>(all: T[], offset: number, limit: number): Page<T> {
  const items = all.slice(offset, offset + limit);
  const next = offset + limit;
  return {
    items,
    total: all.length,
    ...(next < all.length ? { nextCursor: encodeCursor(next) } : {}),
  };
}

// ---------------------------------------------------------------------------
// search

export interface SearchInput {
  text?: string | undefined;
  criteria?: Criterion[] | undefined;
  query?: string | undefined;
  ancestorNoteId?: string | undefined;
  ancestorDepth?: number | undefined;
  includeArchived?: boolean | undefined;
  fastSearch?: boolean | undefined;
  orderBy?: string | undefined;
  orderDirection?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface SearchResult extends Page<NoteSummary> {
  query: string;
}

export interface ResolveInput {
  noteId?: string | undefined;
  title?: string | undefined;
  path?: string | undefined;
  exact?: boolean | undefined;
  parentNoteId?: string | undefined;
  maxCandidates?: number | undefined;
}

export interface ResolveResult {
  status: 'resolved' | 'ambiguous' | 'not_found';
  note?: NoteSummary;
  candidates: NoteSummary[];
  message: string;
}

export class SearchService {
  constructor(private readonly deps: ServiceDeps) {}

  async search(input: SearchInput): Promise<SearchResult> {
    const { client, limits } = this.deps;
    const query = buildSearchQuery({
      text: input.text,
      criteria: input.criteria,
      query: input.query,
    });
    const limit = Math.min(input.limit ?? 50, limits.maxSearchLimit);
    const offset = decodeCursor(input.cursor);
    if (input.ancestorNoteId !== undefined && !NOTE_ID_PATTERN.test(input.ancestorNoteId)) {
      throw DomainError.validation(`Invalid ancestorNoteId '${input.ancestorNoteId}'`);
    }
    // Trilium's fastSearch skips note bodies and ignores ordering/limit clauses;
    // only use it when the caller asks for it and nothing else is in play.
    const fastSearch =
      input.fastSearch === true && !input.orderBy && !input.criteria?.length && !input.query;
    const params: EtapiSearchParams = {
      search: query,
      fastSearch,
      includeArchivedNotes: input.includeArchived ?? false,
      // Fetch one page past the requested window so we know whether more exist.
      limit: offset + limit + 1,
      ...(input.ancestorNoteId !== undefined ? { ancestorNoteId: input.ancestorNoteId } : {}),
      ...(input.ancestorDepth !== undefined
        ? { ancestorDepth: `lt${input.ancestorDepth + 1}` }
        : {}),
      ...(input.orderBy !== undefined ? { orderBy: input.orderBy } : {}),
      ...(input.orderDirection !== undefined ? { orderDirection: input.orderDirection } : {}),
    };
    let response;
    try {
      response = await client.searchNotes(params);
    } catch (err) {
      throw DomainError.from(err, `search '${query}'`);
    }
    const all = (response.results ?? []).map(toNoteSummary);
    const page = paginate(all, offset, limit);
    return { ...page, query };
  }

  /** Resolve a human reference (id, exact title, or path) to one note; never guesses on ambiguity. */
  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const { client } = this.deps;
    const maxCandidates = Math.min(input.maxCandidates ?? 5, 20);

    if (input.noteId) {
      try {
        const note = await client.getNote(input.noteId);
        return {
          status: 'resolved',
          note: toNoteSummary(note),
          candidates: [],
          message: `Resolved noteId '${input.noteId}'`,
        };
      } catch (err) {
        if (!(err instanceof EtapiError && err.isNotFound))
          throw DomainError.from(err, `get note ${input.noteId}`);
        if (!input.title && !input.path) {
          return {
            status: 'not_found',
            candidates: [],
            message: `No note with id '${input.noteId}'`,
          };
        }
      }
    }

    if (input.path) {
      return this.resolvePath(input.path, maxCandidates);
    }

    const title = input.title?.trim();
    if (!title) throw DomainError.validation('Provide noteId, title, or path');
    const exact = input.exact ?? false;
    const criteria: Criterion[] = [
      {
        type: 'noteProperty',
        property: 'title',
        op: exact ? '=' : 'contains',
        value: title,
        logic: 'AND',
      },
    ];
    if (input.parentNoteId) {
      criteria.push({
        type: 'noteProperty',
        property: 'parents.noteId',
        op: '=',
        value: input.parentNoteId,
      });
    }
    const query = buildSearchQuery({ criteria });
    let results: EtapiNote[];
    try {
      results =
        (
          await client.searchNotes({
            search: query,
            fastSearch: false,
            includeArchivedNotes: true,
            limit: 100,
          })
        ).results ?? [];
    } catch (err) {
      throw DomainError.from(err, `resolve '${title}'`);
    }
    const ranked = rankByTitle(results, title).map(toNoteSummary);
    if (ranked.length === 0) {
      return {
        status: 'not_found',
        candidates: [],
        message: `No note titled ${exact ? 'exactly' : 'like'} '${title}'. Try search_notes with text for content-based matching.`,
      };
    }
    const exactMatches = ranked.filter((n) => n.title.toLowerCase() === title.toLowerCase());
    if (exactMatches.length === 1) {
      return {
        status: 'resolved',
        note: exactMatches[0]!,
        candidates: ranked.slice(0, maxCandidates),
        message: `Resolved '${title}' to ${exactMatches[0]!.noteId}`,
      };
    }
    if (ranked.length === 1) {
      return {
        status: 'resolved',
        note: ranked[0]!,
        candidates: ranked,
        message: `Resolved '${title}' to ${ranked[0]!.noteId} (single partial match)`,
      };
    }
    return {
      status: 'ambiguous',
      candidates: ranked.slice(0, maxCandidates),
      message: `${ranked.length} notes match '${title}'. Pick one by noteId, add parentNoteId, or use path.`,
    };
  }

  private async resolvePath(path: string, maxCandidates: number): Promise<ResolveResult> {
    const segments = path
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (segments.length === 0)
      throw DomainError.validation('path must contain at least one segment');
    let parents: string[] = ['root'];
    let current: NoteSummary[] = [];
    for (const [i, segment] of segments.entries()) {
      const next: NoteSummary[] = [];
      for (const parent of parents) {
        const query = `note.title = ${quote(segment)} note.parents.noteId = ${quote(parent)}`;
        const res = await this.deps.client
          .searchNotes({ search: query, fastSearch: false, includeArchivedNotes: true, limit: 50 })
          .catch((err: unknown) => {
            throw DomainError.from(err, `resolve path segment '${segment}'`);
          });
        next.push(...(res.results ?? []).map(toNoteSummary));
      }
      if (next.length === 0) {
        return {
          status: 'not_found',
          candidates: current.slice(0, maxCandidates),
          message: `Path segment ${i + 1} '${segment}' not found under ${parents.join(', ')}`,
        };
      }
      current = next;
      parents = next.map((n) => n.noteId);
    }
    if (current.length === 1) {
      return {
        status: 'resolved',
        note: current[0]!,
        candidates: current,
        message: `Resolved path '${path}' to ${current[0]!.noteId}`,
      };
    }
    return {
      status: 'ambiguous',
      candidates: current.slice(0, maxCandidates),
      message: `Path '${path}' matches ${current.length} notes`,
    };
  }
}

/** Exact title (case-insensitive) first, then folders, then most recently modified. */
export function rankByTitle(notes: EtapiNote[], title: string): EtapiNote[] {
  const wanted = title.toLowerCase();
  return [...notes].sort((a, b) => {
    const ea = a.title.toLowerCase() === wanted ? 0 : 1;
    const eb = b.title.toLowerCase() === wanted ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const fa = a.type === 'book' ? 0 : 1;
    const fb = b.type === 'book' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return (b.utcDateModified ?? '').localeCompare(a.utcDateModified ?? '');
  });
}

// ---------------------------------------------------------------------------
// notes

export type ReadFormat = 'raw' | 'plain';

export interface GetNoteInput {
  noteId: string;
  includeContent?: boolean | undefined;
  maxContentBytes?: number | undefined;
  format?: ReadFormat | undefined;
  find?:
    | {
        pattern: string;
        regex?: boolean | undefined;
        flags?: string | undefined;
        maxMatches?: number | undefined;
      }
    | undefined;
}

export interface ContentMatch {
  index: number;
  match: string;
  context: string;
}

export interface GetNoteResult {
  note: NoteDetail;
  content?: string;
  contentFormat?: ReadFormat;
  contentTruncated?: boolean;
  contentBytes?: number;
  contentOmittedReason?: string;
  matches?: ContentMatch[];
  totalMatches?: number;
}

export interface NoteContextInput {
  noteId: string;
  includeContent?: boolean | undefined;
  maxContentBytes?: number | undefined;
  format?: ReadFormat | undefined;
  childrenLimit?: number | undefined;
  includeChildContent?: boolean | undefined;
  childContentBytes?: number | undefined;
  includeParents?: boolean | undefined;
}

export interface ChildEntry extends NoteSummary {
  contentPreview?: string;
  contentTruncated?: boolean;
}

export interface NoteContextResult extends GetNoteResult {
  parents: NoteSummary[];
  children: ChildEntry[];
  childrenTruncated: boolean;
  totalChildren: number;
}

export interface ListChildrenInput {
  noteId: string;
  limit?: number | undefined;
  cursor?: string | undefined;
  orderBy?: 'position' | 'title' | 'dateCreated' | 'dateModified' | undefined;
  orderDirection?: 'asc' | 'desc' | undefined;
}

export interface AttributeInput {
  type: 'label' | 'relation';
  name: string;
  value?: string | undefined;
  position?: number | undefined;
  isInheritable?: boolean | undefined;
}

export interface CreateNoteInput {
  principal: string;
  parentNoteId?: string | undefined;
  title: string;
  type?: string | undefined;
  mime?: string | undefined;
  content?: string | undefined;
  contentFormat?: ContentFormat | undefined;
  attributes?: AttributeInput[] | undefined;
  ifTitleExists?: 'error' | 'create' | 'return_existing' | undefined;
  idempotencyKey?: string | undefined;
  position?: 'first' | 'last' | undefined;
}

export interface AttributeOpResult {
  ok: boolean;
  action: 'add' | 'update' | 'remove';
  attribute?: AttributeView;
  error?: string;
}

export interface CreateNoteResult {
  note: NoteDetail;
  branchId: string;
  created: boolean;
  /** Set when the note was not created because an equally titled sibling exists. */
  existing?: NoteSummary[];
  contentFormat?: string;
  attributeResults: AttributeOpResult[];
  warnings: string[];
  idempotentReplay: boolean;
}

export interface TextEdit {
  find: string;
  replace: string;
  regex?: boolean | undefined;
  flags?: string | undefined;
  all?: boolean | undefined;
  occurrence?: number | undefined;
}

export interface PatchNoteInput {
  noteId: string;
  expectedHash: string;
  operation: 'replace' | 'append' | 'prepend' | 'edit';
  content?: string | undefined;
  contentFormat?: ContentFormat | undefined;
  edits?: TextEdit[] | undefined;
  separator?: string | undefined;
  createRevision?: boolean | undefined;
}

export interface PatchNoteResult {
  note: NoteDetail;
  previousHash: string;
  contentHash: string;
  revisionCreated: boolean;
  editsApplied: number;
  contentBytes: number;
  warnings: string[];
}

export interface UpdateMetadataInput {
  noteId: string;
  title?: string | undefined;
  type?: string | undefined;
  mime?: string | undefined;
}

export class NotesService {
  constructor(private readonly deps: ServiceDeps) {}

  async get(input: GetNoteInput): Promise<GetNoteResult> {
    const { client, limits } = this.deps;
    const raw = await fetchNote(client, input.noteId);
    const note = toNoteDetail(raw);
    const result: GetNoteResult = { note };
    if (input.includeContent === false) return result;
    if (raw.isProtected) {
      result.contentOmittedReason = 'Note is protected; ETAPI cannot read protected content';
      return result;
    }
    if (BINARY_TYPES.has(raw.type)) {
      result.contentOmittedReason = `Binary '${raw.type}' content is not returned; use Trilium directly for attachments`;
      return result;
    }
    let content: string;
    try {
      content = await client.getNoteContent(input.noteId);
    } catch (err) {
      throw DomainError.from(err, `get content of ${input.noteId}`);
    }
    const format = input.format ?? 'raw';
    const rendered = format === 'plain' && raw.type === 'text' ? htmlToPlainText(content) : content;
    if (input.find) {
      const found = findInContent(rendered, input.find);
      result.matches = found.matches;
      result.totalMatches = found.total;
    }
    const maxBytes = Math.min(
      input.maxContentBytes ?? limits.defaultReadContentBytes,
      limits.maxReadContentBytes,
    );
    const truncated = truncateContent(rendered, maxBytes);
    result.content = truncated.content;
    result.contentFormat = format;
    result.contentTruncated = truncated.truncated;
    result.contentBytes = truncated.totalBytes;
    return result;
  }

  async context(input: NoteContextInput): Promise<NoteContextResult> {
    const { client, limits } = this.deps;
    const base = await this.get({
      noteId: input.noteId,
      includeContent: input.includeContent ?? true,
      maxContentBytes: input.maxContentBytes,
      format: input.format,
    });
    const childLimit = Math.min(input.childrenLimit ?? 50, limits.maxChildren);
    const childIds = base.note.childNoteIds;
    const [childMap, parentMap] = await Promise.all([
      fetchNotesById(client, childIds.slice(0, childLimit)),
      input.includeParents === false
        ? Promise.resolve(new Map<string, EtapiNote>())
        : fetchNotesById(client, base.note.parentNoteIds),
    ]);
    const children: ChildEntry[] = [];
    for (const id of childIds.slice(0, childLimit)) {
      const child = childMap.get(id);
      if (!child) continue;
      const entry: ChildEntry = toNoteSummary(child);
      if (input.includeChildContent && !child.isProtected && !BINARY_TYPES.has(child.type)) {
        try {
          const text = await client.getNoteContent(id);
          const preview = truncateContent(
            child.type === 'text' ? htmlToPlainText(text) : text,
            input.childContentBytes ?? 2048,
          );
          entry.contentPreview = preview.content;
          entry.contentTruncated = preview.truncated;
        } catch {
          /* previews are best-effort */
        }
      }
      children.push(entry);
    }
    const parents = base.note.parentNoteIds
      .map((id) => parentMap.get(id))
      .filter((n): n is EtapiNote => Boolean(n))
      .map(toNoteSummary);
    return {
      ...base,
      parents,
      children,
      childrenTruncated: childIds.length > childLimit,
      totalChildren: childIds.length,
    };
  }

  async listChildren(input: ListChildrenInput): Promise<Page<NoteSummary>> {
    const { client, limits } = this.deps;
    const parent = await fetchNote(client, input.noteId);
    const limit = Math.min(input.limit ?? 100, limits.maxChildren);
    const offset = decodeCursor(input.cursor);
    const orderBy = input.orderBy ?? 'position';
    const direction = input.orderDirection ?? 'asc';
    const ids = parent.childNoteIds ?? [];
    if (ids.length === 0) return { items: [], total: 0 };
    let all: NoteSummary[];
    if (orderBy === 'position') {
      // One search call for the bodies, tree order from the parent's childNoteIds.
      const res = await client
        .searchNotes({
          search: `note.parents.noteId = ${quote(input.noteId)}`,
          fastSearch: false,
          includeArchivedNotes: true,
          limit: ids.length + 1,
        })
        .catch((err: unknown) => {
          throw DomainError.from(err, `list children of ${input.noteId}`);
        });
      const byId = new Map((res.results ?? []).map((n) => [n.noteId, n] as const));
      all = ids
        .map((id) => byId.get(id))
        .filter((n): n is EtapiNote => Boolean(n))
        .map(toNoteSummary);
      if (direction === 'desc') all.reverse();
    } else {
      const res = await client
        .searchNotes({
          search: `note.parents.noteId = ${quote(input.noteId)}`,
          fastSearch: false,
          includeArchivedNotes: true,
          orderBy,
          orderDirection: direction,
          limit: ids.length + 1,
        })
        .catch((err: unknown) => {
          throw DomainError.from(err, `list children of ${input.noteId}`);
        });
      all = (res.results ?? []).map(toNoteSummary);
    }
    return paginate(all, offset, limit);
  }

  async create(input: CreateNoteInput): Promise<CreateNoteResult> {
    const { client, limits, idempotency } = this.deps;
    const parentNoteId = input.parentNoteId ?? 'root';
    const type = input.type ?? 'text';
    const title = input.title.trim();
    if (!title) throw DomainError.validation('title must not be empty');
    if (!(NOTE_TYPES as readonly string[]).includes(type)) {
      throw DomainError.validation(`Unknown note type '${type}'`, { allowed: NOTE_TYPES });
    }
    if (BINARY_TYPES.has(type)) {
      throw new DomainError(
        'UNSUPPORTED',
        `Creating '${type}' notes (binary attachments) is not supported by this server`,
      );
    }
    if (type === 'code' && input.mime === undefined) {
      throw DomainError.validation(
        "Code notes require a mime type, e.g. 'text/x-python' or 'text/plain'",
      );
    }
    const warnings: string[] = [];

    if (input.idempotencyKey) {
      const replay = idempotency.get(input.principal, input.idempotencyKey);
      if (replay) {
        const note = await fetchNote(client, replay.noteId);
        return {
          note: toNoteDetail(note),
          branchId: note.parentBranchIds[0] ?? '',
          created: false,
          attributeResults: [],
          warnings,
          idempotentReplay: true,
        };
      }
    }

    const parent = await fetchNote(client, parentNoteId);
    const ifTitleExists = input.ifTitleExists ?? 'error';
    if (ifTitleExists !== 'create') {
      const siblings = await client
        .searchNotes({
          search: `note.title = ${quote(title)} note.parents.noteId = ${quote(parentNoteId)}`,
          fastSearch: false,
          includeArchivedNotes: true,
          limit: 20,
        })
        .catch((err: unknown) => {
          throw DomainError.from(err, 'duplicate title check');
        });
      const existing = (siblings.results ?? []).filter((n) => n.title === title);
      if (existing.length > 0) {
        if (ifTitleExists === 'return_existing') {
          const first = existing[0]!;
          return {
            note: toNoteDetail(first),
            branchId: first.parentBranchIds[0] ?? '',
            created: false,
            existing: existing.map(toNoteSummary),
            attributeResults: [],
            warnings,
            idempotentReplay: false,
          };
        }
        throw new DomainError(
          'DUPLICATE',
          `A note titled '${title}' already exists under '${parent.title}' (${parentNoteId}). Pass ifTitleExists='create' to add another or 'return_existing' to reuse it.`,
          {
            existing: existing.map((n) => ({ noteId: n.noteId, title: n.title, type: n.type })),
          },
        );
      }
    }

    const normalized = normalizeContentForWrite({
      noteType: type,
      content: input.content ?? '',
      format: input.contentFormat,
      maxBytes: limits.maxWriteContentBytes,
    });
    warnings.push(...normalized.warnings);

    let attributeDefs: Array<AttributeInput & { targetNoteId?: string }> = [];
    if (input.attributes?.length) {
      attributeDefs = await Promise.all(
        input.attributes.map((a, i) => this.prepareAttribute(a, `attributes[${i}]`)),
      );
    }

    let createdNote: EtapiNote;
    let branchId: string;
    try {
      const resp = await client.createNote({
        parentNoteId,
        title,
        type,
        content: normalized.content,
        ...(input.mime !== undefined ? { mime: input.mime } : {}),
        ...(input.position === 'first' ? { notePosition: 0 } : {}),
      });
      createdNote = resp.note;
      branchId = resp.branch.branchId;
    } catch (err) {
      throw DomainError.from(err, 'create note');
    }

    const attributeResults: AttributeOpResult[] = [];
    for (const def of attributeDefs) {
      attributeResults.push(await this.addAttribute(createdNote.noteId, def));
    }
    const finalNote = attributeDefs.length
      ? await fetchNote(client, createdNote.noteId)
      : createdNote;
    if (input.idempotencyKey)
      idempotency.set(input.principal, input.idempotencyKey, {
        noteId: finalNote.noteId,
        contentHash: finalNote.blobId,
      });
    return {
      note: toNoteDetail(finalNote),
      branchId,
      created: true,
      contentFormat: normalized.inputFormat,
      attributeResults,
      warnings,
      idempotentReplay: false,
    };
  }

  async patch(input: PatchNoteInput): Promise<PatchNoteResult> {
    const { client, limits } = this.deps;
    const current = await fetchNote(client, input.noteId);
    if (current.isProtected)
      throw new DomainError(
        'PROTECTED',
        `Note '${input.noteId}' is protected and cannot be modified through ETAPI`,
      );
    if (BINARY_TYPES.has(current.type))
      throw new DomainError(
        'UNSUPPORTED',
        `Note '${input.noteId}' is a '${current.type}' note; binary content is not writable through this server`,
      );
    assertHash(current, input.expectedHash);

    let existing: string;
    try {
      existing = await client.getNoteContent(input.noteId);
    } catch (err) {
      throw DomainError.from(err, `get content of ${input.noteId}`);
    }

    const warnings: string[] = [];
    let next: string;
    let editsApplied = 0;
    const separator = input.separator ?? (current.type === 'text' ? '\n' : '\n');
    switch (input.operation) {
      case 'replace': {
        const normalized = normalizeContentForWrite({
          noteType: current.type,
          content: requireContent(input),
          format: input.contentFormat,
          maxBytes: limits.maxWriteContentBytes,
        });
        warnings.push(...normalized.warnings);
        next = normalized.content;
        break;
      }
      case 'append':
      case 'prepend': {
        const normalized = normalizeContentForWrite({
          noteType: current.type,
          content: requireContent(input),
          format: input.contentFormat,
          maxBytes: limits.maxWriteContentBytes,
        });
        warnings.push(...normalized.warnings);
        const joiner = existing.trim() === '' ? '' : separator;
        next =
          input.operation === 'append'
            ? `${existing}${joiner}${normalized.content}`
            : `${normalized.content}${joiner}${existing}`;
        break;
      }
      case 'edit': {
        if (!input.edits?.length)
          throw DomainError.validation("operation 'edit' requires a non-empty edits array");
        next = existing;
        input.edits.forEach((edit, i) => {
          next = applyEdit(next, edit, `edits[${i}]`);
          editsApplied += 1;
        });
        break;
      }
      default:
        throw DomainError.validation(`Unknown operation '${String(input.operation)}'`);
    }
    const bytes = Buffer.byteLength(next, 'utf8');
    if (bytes > limits.maxWriteContentBytes) {
      throw new DomainError(
        'TOO_LARGE',
        `Resulting content is ${bytes} bytes; the limit is ${limits.maxWriteContentBytes} bytes`,
      );
    }

    // Re-check the hash right before writing to shrink the read-modify-write window.
    const recheck = await fetchNote(client, input.noteId);
    assertHash(recheck, input.expectedHash);

    let revisionCreated = false;
    if (input.createRevision !== false) {
      try {
        await client.createRevision(input.noteId, 'trilium-mcp patch_note');
        revisionCreated = true;
      } catch (err) {
        warnings.push(`revision not created: ${(err as Error).message}`);
      }
    }
    try {
      await client.putNoteContent(
        input.noteId,
        next,
        current.type === 'text' ? 'text/html' : 'text/plain',
      );
    } catch (err) {
      throw DomainError.from(err, `write content of ${input.noteId}`);
    }
    const after = await fetchNote(client, input.noteId);
    return {
      note: toNoteDetail(after),
      previousHash: current.blobId,
      contentHash: after.blobId,
      revisionCreated,
      editsApplied,
      contentBytes: bytes,
      warnings,
    };
  }

  async updateMetadata(
    input: UpdateMetadataInput,
  ): Promise<{ note: NoteDetail; changed: string[] }> {
    const { client } = this.deps;
    const patch: { title?: string; type?: string; mime?: string } = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw DomainError.validation('title must not be empty');
      patch.title = title;
    }
    if (input.type !== undefined) {
      if (!(NOTE_TYPES as readonly string[]).includes(input.type))
        throw DomainError.validation(`Unknown note type '${input.type}'`, { allowed: NOTE_TYPES });
      if (BINARY_TYPES.has(input.type))
        throw new DomainError('UNSUPPORTED', `Changing a note to '${input.type}' is not supported`);
      patch.type = input.type;
    }
    if (input.mime !== undefined) patch.mime = input.mime;
    if (Object.keys(patch).length === 0)
      throw DomainError.validation('Provide at least one of title, type, mime');
    const current = await fetchNote(client, input.noteId);
    if (BINARY_TYPES.has(current.type) && (patch.type !== undefined || patch.mime !== undefined)) {
      throw new DomainError(
        'UNSUPPORTED',
        `Type and mime of '${current.type}' notes cannot be changed through this server`,
      );
    }
    try {
      const note = await client.patchNote(input.noteId, patch);
      return { note: toNoteDetail(note), changed: Object.keys(patch) };
    } catch (err) {
      throw DomainError.from(err, `update metadata of ${input.noteId}`);
    }
  }

  // ---- attributes ----------------------------------------------------------

  /** Validate an attribute and resolve relation targets to note ids. */
  async prepareAttribute(
    attr: AttributeInput,
    where: string,
  ): Promise<AttributeInput & { targetNoteId?: string }> {
    const name = attr.name.trim();
    if (!name || /\s/.test(name))
      throw DomainError.validation(
        `${where}: attribute name must be non-empty and contain no whitespace`,
      );
    if (attr.type !== 'label' && attr.type !== 'relation')
      throw DomainError.validation(`${where}: type must be 'label' or 'relation'`);
    if (attr.position !== undefined && (!Number.isInteger(attr.position) || attr.position < 0)) {
      throw DomainError.validation(`${where}: position must be a non-negative integer`);
    }
    if (attr.type === 'relation') {
      const target = (attr.value ?? '').trim();
      if (!target)
        throw DomainError.validation(
          `${where}: relations need a value naming the target note (noteId or exact title)`,
        );
      const targetNoteId = await this.resolveRelationTarget(target, name, where);
      return { ...attr, name, value: targetNoteId, targetNoteId };
    }
    return { ...attr, name, value: attr.value ?? '' };
  }

  private async resolveRelationTarget(
    value: string,
    relationName: string,
    where: string,
  ): Promise<string> {
    const { client } = this.deps;
    if (NOTE_ID_PATTERN.test(value)) {
      try {
        await client.getNote(value);
        return value;
      } catch (err) {
        if (!(err instanceof EtapiError && err.isNotFound))
          throw DomainError.from(err, `${where}: check relation target`);
      }
    }
    const res = await client
      .searchNotes({
        search: `note.title = ${quote(value)}`,
        fastSearch: false,
        includeArchivedNotes: true,
        limit: 50,
      })
      .catch((err: unknown) => {
        throw DomainError.from(err, `${where}: resolve relation target`);
      });
    let matches = (res.results ?? []).filter((n) => n.title === value);
    if (matches.length > 1 && relationName === 'template') {
      const templates = matches.filter((n) =>
        n.attributes?.some(
          (a) => a.type === 'label' && (a.name === 'template' || a.name === 'workspaceTemplate'),
        ),
      );
      if (templates.length >= 1) matches = templates;
    }
    if (matches.length === 1) return matches[0]!.noteId;
    if (matches.length === 0) throw DomainError.notFound(`${where}: relation target note`, value);
    throw new DomainError(
      'AMBIGUOUS',
      `${where}: ${matches.length} notes are titled '${value}'; pass the target noteId instead`,
      {
        candidates: matches
          .slice(0, 10)
          .map((n) => ({ noteId: n.noteId, title: n.title, type: n.type })),
      },
    );
  }

  async addAttribute(noteId: string, def: AttributeInput): Promise<AttributeOpResult> {
    try {
      const created = await this.deps.client.createAttribute({
        noteId,
        type: def.type,
        name: def.name,
        value: def.value ?? '',
        position: def.position ?? 10,
        isInheritable: def.isInheritable ?? false,
      });
      return { ok: true, action: 'add', attribute: toAttributeView(created, noteId) };
    } catch (err) {
      return {
        ok: false,
        action: 'add',
        error: DomainError.from(err, `add ${def.type} '${def.name}'`).message,
      };
    }
  }
}

function requireContent(input: PatchNoteInput): string {
  if (input.content === undefined)
    throw DomainError.validation(`operation '${input.operation}' requires content`);
  return input.content;
}

function assertHash(note: EtapiNote, expectedHash: string): void {
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

const SAFE_FLAGS = /^[gimsuy]*$/;

export function applyEdit(content: string, edit: TextEdit, where: string): string {
  if (edit.find === '') throw DomainError.validation(`${where}: find must not be empty`);
  const flags = edit.flags ?? '';
  if (!SAFE_FLAGS.test(flags))
    throw DomainError.validation(`${where}: invalid regex flags '${flags}'`);
  let re: RegExp;
  try {
    const source = edit.regex ? edit.find : edit.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(source, flags.replace('g', '') + 'g');
  } catch (err) {
    throw DomainError.validation(`${where}: invalid pattern: ${(err as Error).message}`);
  }
  const matches: Array<{ index: number; length: number; match: RegExpExecArray }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length === 0)
      throw DomainError.validation(`${where}: pattern matches an empty string`);
    matches.push({ index: m.index, length: m[0].length, match: m });
    if (matches.length > 10_000) throw DomainError.validation(`${where}: too many matches`);
  }
  if (matches.length === 0)
    throw DomainError.validation(`${where}: '${edit.find}' was not found in the note content`);
  const replacer = (mt: RegExpExecArray): string =>
    edit.regex
      ? mt[0].replace(new RegExp(edit.regex ? edit.find : '', flags.replace('g', '')), edit.replace)
      : edit.replace;
  if (edit.all) {
    let out = '';
    let last = 0;
    for (const mt of matches) {
      out += content.slice(last, mt.index) + replacer(mt.match);
      last = mt.index + mt.length;
    }
    return out + content.slice(last);
  }
  const occurrence = edit.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1)
    throw DomainError.validation(`${where}: occurrence must be a positive integer`);
  if (matches.length > 1 && edit.occurrence === undefined) {
    throw new DomainError(
      'AMBIGUOUS',
      `${where}: '${edit.find}' occurs ${matches.length} times; set occurrence (1-based) or all=true`,
      { occurrences: matches.length },
    );
  }
  const target = matches[occurrence - 1];
  if (!target)
    throw DomainError.validation(
      `${where}: occurrence ${occurrence} exceeds the ${matches.length} matches`,
    );
  return (
    content.slice(0, target.index) +
    replacer(target.match) +
    content.slice(target.index + target.length)
  );
}

export function findInContent(
  content: string,
  find: NonNullable<GetNoteInput['find']>,
): { matches: ContentMatch[]; total: number } {
  const flags = (find.flags ?? 'i').replace('g', '');
  if (!SAFE_FLAGS.test(flags)) throw DomainError.validation(`find.flags '${flags}' is invalid`);
  let re: RegExp;
  try {
    const source = find.regex ? find.pattern : find.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(source, `${flags}g`);
  } catch (err) {
    throw DomainError.validation(`find.pattern is not a valid regex: ${(err as Error).message}`);
  }
  const max = Math.min(find.maxMatches ?? 20, 200);
  const matches: ContentMatch[] = [];
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    total += 1;
    if (matches.length < max) {
      const start = Math.max(0, m.index - 80);
      const end = Math.min(content.length, m.index + m[0].length + 80);
      matches.push({ index: m.index, match: m[0], context: content.slice(start, end) });
    }
    if (total > 100_000) break;
  }
  return { matches, total };
}

// ---------------------------------------------------------------------------
// attributes

export interface ReadAttributesInput {
  noteId: string;
  type?: 'label' | 'relation' | undefined;
  name?: string | undefined;
  includeInherited?: boolean | undefined;
}

export interface ManageAttributeOp {
  action: 'add' | 'update' | 'remove';
  attributeId?: string | undefined;
  type?: 'label' | 'relation' | undefined;
  name?: string | undefined;
  value?: string | undefined;
  position?: number | undefined;
  isInheritable?: boolean | undefined;
}

export class AttributesService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly notes: NotesService,
  ) {}

  async read(
    input: ReadAttributesInput,
  ): Promise<{ note: NoteSummary; attributes: AttributeView[] }> {
    const raw = await fetchNote(this.deps.client, input.noteId);
    let attributes = (raw.attributes ?? []).map((a) => toAttributeView(a, raw.noteId));
    if (!input.includeInherited) attributes = attributes.filter((a) => !a.inherited);
    if (input.type) attributes = attributes.filter((a) => a.type === input.type);
    if (input.name) attributes = attributes.filter((a) => a.name === input.name);
    return { note: toNoteSummary(raw), attributes };
  }

  async manage(
    noteId: string,
    ops: ManageAttributeOp[],
  ): Promise<{ note: NoteDetail; results: AttributeOpResult[] }> {
    const { client } = this.deps;
    let note = await fetchNote(client, noteId);
    const results: AttributeOpResult[] = [];
    for (const [i, op] of ops.entries()) {
      const where = `operations[${i}]`;
      try {
        if (i > 0 && op.action !== 'add') note = await fetchNote(client, noteId);
        results.push(await this.applyOp(note, op, where));
      } catch (err) {
        const domain = DomainError.from(err, where);
        results.push({ ok: false, action: op.action, error: domain.message });
      }
    }
    const after = await fetchNote(client, noteId);
    return { note: toNoteDetail(after), results };
  }

  private findOwned(note: EtapiNote, op: ManageAttributeOp, where: string): EtapiAttribute {
    const owned = (note.attributes ?? []).filter((a) => a.noteId === note.noteId);
    if (op.attributeId) {
      const byId = owned.find((a) => a.attributeId === op.attributeId);
      if (!byId) throw DomainError.notFound(`${where}: owned attribute`, op.attributeId);
      return byId;
    }
    if (!op.name) throw DomainError.validation(`${where}: provide attributeId or name`);
    const matches = owned.filter(
      (a) => a.name === op.name && (op.type === undefined || a.type === op.type),
    );
    if (matches.length === 0) throw DomainError.notFound(`${where}: attribute named`, op.name);
    if (matches.length > 1) {
      throw new DomainError(
        'AMBIGUOUS',
        `${where}: ${matches.length} attributes named '${op.name}' exist; pass attributeId`,
        {
          candidates: matches.map((a) => ({
            attributeId: a.attributeId,
            type: a.type,
            value: a.value,
          })),
        },
      );
    }
    return matches[0]!;
  }

  private async applyOp(
    note: EtapiNote,
    op: ManageAttributeOp,
    where: string,
  ): Promise<AttributeOpResult> {
    const { client } = this.deps;
    switch (op.action) {
      case 'add': {
        if (!op.type || !op.name)
          throw DomainError.validation(`${where}: add requires type and name`);
        const prepared = await this.notes.prepareAttribute(
          {
            type: op.type,
            name: op.name,
            value: op.value,
            position: op.position,
            isInheritable: op.isInheritable,
          },
          where,
        );
        const result = await this.notes.addAttribute(note.noteId, prepared);
        if (!result.ok) throw new DomainError('UPSTREAM', result.error ?? 'add failed');
        return result;
      }
      case 'update': {
        const existing = this.findOwned(note, op, where);
        if (op.isInheritable !== undefined && op.isInheritable !== existing.isInheritable) {
          throw new DomainError(
            'UNSUPPORTED',
            `${where}: ETAPI cannot change isInheritable; remove and re-add the attribute`,
          );
        }
        const patch: { value?: string; position?: number } = {};
        if (op.position !== undefined) patch.position = op.position;
        if (op.value !== undefined) {
          if (existing.type === 'relation') {
            throw new DomainError(
              'UNSUPPORTED',
              `${where}: ETAPI cannot retarget a relation; remove and re-add it`,
            );
          }
          patch.value = op.value;
        }
        if (Object.keys(patch).length === 0)
          throw DomainError.validation(`${where}: update needs value or position`);
        const updated = await client.patchAttribute(existing.attributeId, patch);
        return { ok: true, action: 'update', attribute: toAttributeView(updated, note.noteId) };
      }
      case 'remove': {
        const existing = this.findOwned(note, op, where);
        await client.deleteAttribute(existing.attributeId);
        return { ok: true, action: 'remove', attribute: toAttributeView(existing, note.noteId) };
      }
      default:
        throw DomainError.validation(`${where}: unknown action '${String(op.action)}'`);
    }
  }
}

export interface Services {
  search: SearchService;
  notes: NotesService;
  attributes: AttributesService;
}

export function createServices(deps: ServiceDeps): Services {
  const search = new SearchService(deps);
  const notes = new NotesService(deps);
  const attributes = new AttributesService(deps, notes);
  return { search, notes, attributes };
}
