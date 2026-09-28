/**
 * In-memory stand-in for the TriliumNext ETAPI, good enough to exercise every
 * endpoint this server uses. Serves as a fetch function (unit/protocol tests)
 * or as a real HTTP listener (stdio child-process tests).
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeNote {
  noteId: string;
  title: string;
  type: string;
  mime: string;
  isProtected: boolean;
  content: string;
  dateCreated: string;
  dateModified: string;
  utcDateCreated: string;
  utcDateModified: string;
  isArchived?: boolean;
  /** Set for file/image notes whose body was uploaded as application/octet-stream. */
  binary?: Buffer;
}

export interface FakeAttachment {
  attachmentId: string;
  ownerId: string;
  role: string;
  mime: string;
  title: string;
  position: number;
  content: Buffer;
  utcDateModified: string;
  utcDateScheduledForErasureSince: string | null;
}

/** A soft-deleted note with everything needed to undelete it (like Trilium's deleted rows). */
export interface DeletedNote {
  note: FakeNote;
  branches: FakeBranch[];
  attributes: FakeAttribute[];
  attachments: FakeAttachment[];
  deleteId: string;
}

export interface FakeBranch {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  prefix: string | null;
  notePosition: number;
  isExpanded: boolean;
  utcDateModified: string;
}

export interface FakeAttribute {
  attributeId: string;
  noteId: string;
  type: 'label' | 'relation';
  name: string;
  value: string;
  position: number;
  isInheritable: boolean;
  utcDateModified: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Request body as UTF-8 text; binary uploads are recorded as `[binary N bytes]`. */
  body?: string;
  contentType?: string;
}

export interface FakeTriliumOptions {
  token?: string;
  noAuth?: boolean;
  now?: () => Date;
}

export const BUILT_IN_TEMPLATES: Record<string, string> = {
  _template_board: 'Kanban Board',
  _template_calendar: 'Calendar',
  _template_text_snippet: 'Text Snippet',
  _template_grid_view: 'Grid View',
  _template_list_view: 'List View',
  _template_table: 'Table',
  _template_geo_map: 'Geo Map',
};

let idCounter = 0;
export function fakeId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36).padStart(11, '0')}`;
}

function blobIdFor(content: string | Buffer): string {
  return createHash('sha1').update(content).digest('base64url').slice(0, 20);
}

function noteBlobId(note: FakeNote): string {
  return blobIdFor(note.binary ?? note.content);
}

function local(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '+0000');
}

type Value = string | number | boolean | undefined;

export class FakeTrilium {
  readonly notes = new Map<string, FakeNote>();
  readonly branches = new Map<string, FakeBranch>();
  readonly attributes = new Map<string, FakeAttribute>();
  readonly attachments = new Map<string, FakeAttachment>();
  /** Soft-deleted notes keyed by noteId; `undelete` restores from here. */
  readonly deleted = new Map<string, DeletedNote>();
  readonly revisions: Array<{ noteId: string; description: string; content: string }> = [];
  readonly calls: RecordedCall[] = [];
  /** Inject failures: return a response for a matching call, or undefined to proceed. */
  intercept:
    ((call: RecordedCall) => Response | undefined | Promise<Response | undefined>) | undefined;
  private readonly token: string;
  private readonly noAuth: boolean;
  private readonly now: () => Date;
  private server: Server | undefined;

  constructor(options: FakeTriliumOptions = {}) {
    this.token = options.token ?? 'test-token';
    this.noAuth = options.noAuth ?? false;
    this.now = options.now ?? (() => new Date());
    this.addNote({ noteId: 'root', title: 'root', type: 'book', parentNoteId: null });
    this.addNote({ noteId: '_hidden', title: 'Hidden Notes', type: 'doc', parentNoteId: 'root' });
    this.addNote({
      noteId: '_templates',
      title: 'Built-in templates',
      type: 'book',
      parentNoteId: '_hidden',
    });
    for (const [id, title] of Object.entries(BUILT_IN_TEMPLATES)) {
      this.addNote({
        noteId: id,
        title,
        type: id === '_template_text_snippet' ? 'text' : 'book',
        parentNoteId: '_templates',
        labels: { template: '' },
      });
    }
  }

  private isHidden(noteId: string): boolean {
    return noteId === '_hidden' || this.ancestorsOf(noteId).includes('_hidden');
  }

  // ---- seeding ------------------------------------------------------------

  addNote(init: {
    noteId?: string;
    title: string;
    type?: string;
    mime?: string;
    content?: string;
    parentNoteId: string | null;
    isProtected?: boolean;
    isArchived?: boolean;
    labels?: Record<string, string>;
    relations?: Record<string, string>;
    dateModified?: Date;
  }): FakeNote {
    const noteId = init.noteId ?? fakeId();
    const when = init.dateModified ?? this.now();
    const note: FakeNote = {
      noteId,
      title: init.title,
      type: init.type ?? 'text',
      mime:
        init.mime ??
        (init.type === 'code' ? 'text/plain' : init.type === 'book' ? '' : 'text/html'),
      isProtected: init.isProtected ?? false,
      content: init.content ?? '',
      dateCreated: local(when),
      dateModified: local(when),
      utcDateCreated: when.toISOString(),
      utcDateModified: when.toISOString(),
      ...(init.isArchived !== undefined ? { isArchived: init.isArchived } : {}),
    };
    this.notes.set(noteId, note);
    if (init.parentNoteId) this.addBranch(noteId, init.parentNoteId);
    for (const [name, value] of Object.entries(init.labels ?? {}))
      this.addAttribute({ noteId, type: 'label', name, value });
    for (const [name, value] of Object.entries(init.relations ?? {}))
      this.addAttribute({ noteId, type: 'relation', name, value });
    if (init.isArchived) this.addAttribute({ noteId, type: 'label', name: 'archived', value: '' });
    return note;
  }

  addBranch(noteId: string, parentNoteId: string, position?: number): FakeBranch {
    const siblings = [...this.branches.values()].filter((b) => b.parentNoteId === parentNoteId);
    const branch: FakeBranch = {
      branchId: `${parentNoteId}_${noteId}`,
      noteId,
      parentNoteId,
      prefix: null,
      notePosition: position ?? (siblings.length + 1) * 10,
      isExpanded: false,
      utcDateModified: this.now().toISOString(),
    };
    this.branches.set(branch.branchId, branch);
    return branch;
  }

  addAttachment(init: {
    ownerId: string;
    title: string;
    mime?: string;
    role?: string;
    content?: string | Buffer;
    position?: number;
  }): FakeAttachment {
    const attachment: FakeAttachment = {
      attachmentId: fakeId('t'),
      ownerId: init.ownerId,
      role: init.role ?? 'file',
      mime: init.mime ?? 'text/plain',
      title: init.title,
      position: init.position ?? 10,
      content: Buffer.isBuffer(init.content)
        ? init.content
        : Buffer.from(init.content ?? '', 'utf8'),
      utcDateModified: this.now().toISOString(),
      utcDateScheduledForErasureSince: null,
    };
    this.attachments.set(attachment.attachmentId, attachment);
    return attachment;
  }

  attachmentPojo(a: FakeAttachment): Record<string, unknown> {
    return {
      attachmentId: a.attachmentId,
      ownerId: a.ownerId,
      role: a.role,
      mime: a.mime,
      title: a.title,
      position: a.position,
      blobId: blobIdFor(a.content),
      dateModified: local(new Date(a.utcDateModified)),
      utcDateModified: a.utcDateModified,
      utcDateScheduledForErasureSince: a.utcDateScheduledForErasureSince,
      contentLength: a.content.length,
    };
  }

  /**
   * Soft-delete like Trilium: the note, its branches, owned attributes and
   * attachments move to `deleted`; children that lose their last live parent
   * go with it (same deleteId, so undelete can bring them back together).
   */
  deleteNoteCascade(noteId: string, deleteId = fakeId('d')): void {
    const note = this.notes.get(noteId);
    if (!note) return;
    const branches = [...this.branches.values()].filter(
      (b) => b.noteId === noteId || b.parentNoteId === noteId,
    );
    const childIds = branches.filter((b) => b.parentNoteId === noteId).map((b) => b.noteId);
    for (const b of branches) this.branches.delete(b.branchId);
    const attributes = [...this.attributes.values()].filter((a) => a.noteId === noteId);
    for (const a of attributes) this.attributes.delete(a.attributeId);
    const attachments = [...this.attachments.values()].filter((a) => a.ownerId === noteId);
    for (const a of attachments) this.attachments.delete(a.attachmentId);
    this.notes.delete(noteId);
    this.deleted.set(noteId, { note, branches, attributes, attachments, deleteId });
    for (const childId of childIds) {
      if (this.parentsOf(childId).length === 0) this.deleteNoteCascade(childId, deleteId);
    }
  }

  undeleteNoteCascade(noteId: string): boolean {
    const entry = this.deleted.get(noteId);
    if (!entry) return false;
    // A child's own parent branch was recorded with the parent it was deleted
    // through, and the caller re-adds it before recursing; count those too.
    const parentBranches = entry.branches.filter(
      (b) => b.noteId === noteId && this.notes.has(b.parentNoteId),
    );
    if (parentBranches.length === 0 && this.parentsOf(noteId).length === 0) return false;
    this.deleted.delete(noteId);
    this.notes.set(noteId, entry.note);
    for (const b of parentBranches) this.branches.set(b.branchId, b);
    for (const a of entry.attributes) this.attributes.set(a.attributeId, a);
    for (const a of entry.attachments) this.attachments.set(a.attachmentId, a);
    // Children deleted in the same cascade come back with their branches.
    for (const b of entry.branches.filter((b) => b.parentNoteId === noteId)) {
      const child = this.deleted.get(b.noteId);
      if (child && child.deleteId === entry.deleteId) {
        this.branches.set(b.branchId, b);
        this.undeleteNoteCascade(b.noteId);
      } else if (this.notes.has(b.noteId)) {
        this.branches.set(b.branchId, b);
      }
    }
    return true;
  }

  private isDescendant(noteId: string, ancestorId: string): boolean {
    return this.ancestorsOf(noteId).includes(ancestorId);
  }

  addAttribute(init: {
    noteId: string;
    type: 'label' | 'relation';
    name: string;
    value?: string;
    position?: number;
    isInheritable?: boolean;
  }): FakeAttribute {
    const attr: FakeAttribute = {
      attributeId: fakeId('a'),
      noteId: init.noteId,
      type: init.type,
      name: init.name,
      value: init.value ?? '',
      position: init.position ?? 10,
      isInheritable: init.isInheritable ?? false,
      utcDateModified: this.now().toISOString(),
    };
    this.attributes.set(attr.attributeId, attr);
    return attr;
  }

  // ---- views --------------------------------------------------------------

  parentsOf(noteId: string): string[] {
    return [...this.branches.values()]
      .filter((b) => b.noteId === noteId)
      .map((b) => b.parentNoteId);
  }

  childrenOf(noteId: string): string[] {
    return [...this.branches.values()]
      .filter((b) => b.parentNoteId === noteId)
      .sort((a, b) => a.notePosition - b.notePosition)
      .map((b) => b.noteId);
  }

  ancestorsOf(noteId: string, seen = new Set<string>()): string[] {
    const out: string[] = [];
    for (const p of this.parentsOf(noteId)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p, ...this.ancestorsOf(p, seen));
    }
    return out;
  }

  /** Owned attributes plus inheritable ones from ancestors and ~template targets (approximation of becca). */
  attributesOf(noteId: string): FakeAttribute[] {
    const owned = [...this.attributes.values()].filter((a) => a.noteId === noteId);
    const inherited: FakeAttribute[] = [];
    for (const anc of this.ancestorsOf(noteId)) {
      inherited.push(
        ...[...this.attributes.values()].filter((a) => a.noteId === anc && a.isInheritable),
      );
    }
    for (const rel of owned.filter((a) => a.type === 'relation' && a.name === 'template')) {
      inherited.push(
        ...[...this.attributes.values()].filter(
          (a) => a.noteId === rel.value && a.name !== 'template',
        ),
      );
    }
    return [...owned, ...inherited];
  }

  notePojo(note: FakeNote): Record<string, unknown> {
    const childBranches = [...this.branches.values()]
      .filter((b) => b.parentNoteId === note.noteId)
      .sort((a, b) => a.notePosition - b.notePosition);
    const parentBranches = [...this.branches.values()].filter((b) => b.noteId === note.noteId);
    return {
      noteId: note.noteId,
      isProtected: note.isProtected,
      title: note.isProtected ? '[protected]' : note.title,
      type: note.type,
      mime: note.mime,
      blobId: noteBlobId(note),
      dateCreated: note.dateCreated,
      dateModified: note.dateModified,
      utcDateCreated: note.utcDateCreated,
      utcDateModified: note.utcDateModified,
      parentNoteIds: parentBranches.map((b) => b.parentNoteId),
      childNoteIds: childBranches.map((b) => b.noteId),
      parentBranchIds: parentBranches.map((b) => b.branchId),
      childBranchIds: childBranches.map((b) => b.branchId),
      attributes: this.attributesOf(note.noteId).map((a) => ({ ...a })),
    };
  }

  blobId(noteId: string): string {
    return noteBlobId(this.notes.get(noteId)!);
  }

  // ---- search DSL subset ---------------------------------------------------

  private isArchived(noteId: string): boolean {
    return this.attributesOf(noteId).some((a) => a.type === 'label' && a.name === 'archived');
  }

  search(rawQuery: string, params: Record<string, string>): FakeNote[] {
    // Trilium tokenizes an in-query orderBy clause but does not apply it via ETAPI.
    const query = rawQuery.replace(/\s+orderBy\s+\S+(?:\s+(?:asc|desc))?\s*$/i, '');
    const predicate = parseQuery(query);
    // Like Trilium, search never returns the hidden subtree.
    let candidates = [...this.notes.values()].filter(
      (n) => !this.isHidden(n.noteId) && (n.noteId !== 'root' || /noteId/.test(query)),
    );
    if (params['includeArchivedNotes'] !== 'true')
      candidates = candidates.filter((n) => !this.isArchived(n.noteId));
    if (params['ancestorNoteId']) {
      const anc = params['ancestorNoteId'];
      candidates = candidates.filter((n) => this.ancestorsOf(n.noteId).includes(anc));
    }
    const fast = params['fastSearch'] === 'true';
    let results = candidates.filter((n) => predicate(this.evalContext(n, fast)));
    const orderBy = params['orderBy'];
    if (orderBy) {
      // Like Trilium 0.103: sorts by the property, always descending (orderDirection is ignored).
      results.sort((a, b) =>
        String(this.property(b, orderBy) ?? '').localeCompare(
          String(this.property(a, orderBy) ?? ''),
        ),
      );
    } else {
      results.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    }
    if (params['limit']) results = results.slice(0, Number(params['limit']));
    return results;
  }

  private property(note: FakeNote, name: string): Value {
    switch (name) {
      case 'title':
        return note.title;
      case 'content':
        return note.content;
      case 'text':
        return `${note.title} ${note.content}`;
      case 'type':
        return note.type;
      case 'mime':
        return note.mime;
      case 'noteId':
        return note.noteId;
      case 'isArchived':
        return this.isArchived(note.noteId);
      case 'isProtected':
        return note.isProtected;
      case 'dateCreated':
        return note.dateCreated;
      case 'dateModified':
        return note.dateModified;
      case 'utcDateCreated':
        return note.utcDateCreated;
      case 'utcDateModified':
        return note.utcDateModified;
      case 'labelCount':
        return this.attributesOf(note.noteId).filter((a) => a.type === 'label').length;
      case 'childrenCount':
        return this.childrenOf(note.noteId).length;
      case 'parentCount':
        return this.parentsOf(note.noteId).length;
      default:
        return undefined;
    }
  }

  private evalContext(note: FakeNote, fast: boolean): EvalContext {
    return {
      fulltext: (term) => {
        const hay = fast ? note.title : `${note.title}\n${note.content}`;
        return hay.toLowerCase().includes(term.toLowerCase());
      },
      label: (name) =>
        this.attributesOf(note.noteId)
          .filter((a) => a.type === 'label' && a.name === name)
          .map((a) => a.value),
      relationTarget: (name, prop) =>
        this.attributesOf(note.noteId)
          .filter((a) => a.type === 'relation' && a.name === name)
          .map((a) => {
            const target = this.notes.get(a.value);
            if (!target) return undefined;
            return prop === 'noteId' ? target.noteId : this.property(target, prop);
          }),
      property: (path) => {
        const parts = path.split('.');
        let ids = [note.noteId];
        while (parts.length > 1) {
          const step = parts.shift()!;
          const next: string[] = [];
          for (const id of ids) {
            if (step === 'parents') next.push(...this.parentsOf(id));
            else if (step === 'children') next.push(...this.childrenOf(id));
            else if (step === 'ancestors') next.push(...this.ancestorsOf(id));
            else return [];
          }
          ids = next;
        }
        const leaf = parts[0]!;
        return ids.map((id) => this.property(this.notes.get(id)!, leaf));
      },
    };
  }

  // ---- HTTP ---------------------------------------------------------------

  get fetch(): (input: string | URL, init?: RequestInit) => Promise<Response> {
    return (input, init) =>
      this.handle(new Request(typeof input === 'string' ? input : input.toString(), init));
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*?\/etapi/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    const contentType = request.headers.get('content-type') ?? '';
    const raw =
      request.method === 'GET' || request.method === 'DELETE'
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    const binary = contentType.startsWith('application/octet-stream');
    const call: RecordedCall = {
      method: request.method,
      path,
      query,
      ...(raw !== undefined
        ? { body: binary ? `[binary ${raw.length} bytes]` : raw.toString('utf8') }
        : {}),
      ...(contentType ? { contentType } : {}),
    };
    this.calls.push(call);
    const intercepted = await this.intercept?.(call);
    if (intercepted) return intercepted;
    if (!this.noAuth && request.headers.get('authorization') !== this.token) {
      return err(401, 'NOT_AUTHENTICATED', 'Not authenticated');
    }
    try {
      return this.route(request.method, path, query, raw ?? Buffer.alloc(0), contentType);
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.code, e.message);
      return err(500, 'GENERIC', (e as Error).message);
    }
  }

  private route(
    method: string,
    path: string,
    query: Record<string, string>,
    raw: Buffer,
    contentType: string,
  ): Response {
    const body = raw.toString('utf8');
    const m = (re: RegExp) => re.exec(path);
    let match: RegExpExecArray | null;
    if (method === 'GET' && path === '/app-info') {
      return json({
        appVersion: '0.103.0-fake',
        dbVersion: 238,
        syncVersion: 39,
        buildDate: '',
        buildRevision: 'fake',
        dataDirectory: '/tmp',
        clipperProtocolVersion: '1.0',
        utcDateTime: this.now().toISOString(),
      });
    }
    if (method === 'GET' && path === '/notes') {
      if (!query['search']?.trim())
        throw new HttpError(
          400,
          'SEARCH_QUERY_PARAM_MANDATORY',
          "'search' query parameter is mandatory.",
        );
      const results = this.search(query['search'], query).map((n) => this.notePojo(n));
      return json({ results });
    }
    if (method === 'POST' && path === '/create-note') {
      const def = JSON.parse(body) as Record<string, unknown>;
      for (const key of ['parentNoteId', 'title', 'type'])
        if (typeof def[key] !== 'string')
          throw new HttpError(
            400,
            'PROPERTY_VALIDATION_ERROR',
            `Validation failed on property '${key}'`,
          );
      if (!this.notes.has(def['parentNoteId'] as string))
        throw new HttpError(
          404,
          'NOTE_NOT_FOUND',
          `Note '${String(def['parentNoteId'])}' not found.`,
        );
      const note = this.addNote({
        title: def['title'] as string,
        type: def['type'] as string,
        ...(typeof def['mime'] === 'string' ? { mime: def['mime'] } : {}),
        content: typeof def['content'] === 'string' ? def['content'] : '',
        parentNoteId: def['parentNoteId'] as string,
      });
      const branch = [...this.branches.values()].find((b) => b.noteId === note.noteId)!;
      if (typeof def['notePosition'] === 'number') branch.notePosition = def['notePosition'];
      return json({ note: this.notePojo(note), branch }, 201);
    }
    if ((match = m(/^\/notes\/([^/]+)$/))) {
      const note = this.notes.get(match[1]!);
      if (method === 'GET') {
        if (!note) throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${match[1]}' not found.`);
        return json(this.notePojo(note));
      }
      if (method === 'PATCH') {
        if (!note) throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${match[1]}' not found.`);
        if (note.isProtected)
          throw new HttpError(
            400,
            'NOTE_IS_PROTECTED',
            `Note '${note.noteId}' is protected and cannot be modified through ETAPI.`,
          );
        const patch = JSON.parse(body) as Record<string, unknown>;
        for (const key of Object.keys(patch)) {
          if (
            !['title', 'type', 'mime', 'dateCreated', 'utcDateCreated', 'utcDateModified'].includes(
              key,
            )
          )
            throw new HttpError(
              400,
              'PROPERTY_NOT_ALLOWED',
              `Property '${key}' is not allowed for this method.`,
            );
        }
        this.revisions.push({ noteId: note.noteId, description: 'auto', content: note.content });
        if (typeof patch['title'] === 'string') note.title = patch['title'];
        if (typeof patch['type'] === 'string') note.type = patch['type'];
        if (typeof patch['mime'] === 'string') note.mime = patch['mime'];
        note.utcDateModified = this.now().toISOString();
        note.dateModified = local(this.now());
        return json(this.notePojo(note));
      }
      if (method === 'DELETE') {
        if (note) this.deleteNoteCascade(note.noteId);
        return new Response(null, { status: 204 });
      }
    }
    if ((match = m(/^\/notes\/([^/]+)\/undelete$/)) && method === 'POST') {
      const id = match[1]!;
      if (this.notes.has(id))
        throw new HttpError(400, 'NOTE_NOT_DELETED', `Note '${id}' is not deleted.`);
      if (!this.deleted.has(id))
        throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${id}' not found.`);
      if (!this.undeleteNoteCascade(id))
        throw new HttpError(
          400,
          'NOTE_HAS_NO_UNDELETED_PARENT',
          `Note '${id}' has no undeleted parent; undelete a parent first.`,
        );
      return json({ success: true });
    }
    if ((match = m(/^\/notes\/([^/]+)\/attachments$/)) && method === 'GET') {
      const note = this.notes.get(match[1]!);
      if (!note) throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${match[1]}' not found.`);
      const list = [...this.attachments.values()]
        .filter((a) => a.ownerId === note.noteId)
        .sort((a, b) => a.position - b.position)
        .map((a) => this.attachmentPojo(a));
      return json(list);
    }
    if ((match = m(/^\/notes\/([^/]+)\/content$/))) {
      const note = this.notes.get(match[1]!);
      if (!note) throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${match[1]}' not found.`);
      if (note.isProtected)
        throw new HttpError(
          400,
          'NOTE_IS_PROTECTED',
          `Note '${note.noteId}' is protected and content cannot be read through ETAPI.`,
        );
      if (method === 'GET') {
        // Like express: whole bodies with a Content-Length.
        const bytes = note.binary ?? Buffer.from(note.content, 'utf8');
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': note.mime || 'text/plain',
            'content-length': String(bytes.length),
          },
        });
      }
      if (method === 'PUT') {
        if (contentType.startsWith('application/octet-stream')) {
          note.binary = Buffer.from(raw);
          note.content = '';
        } else if (contentType.startsWith('text/plain')) {
          note.content = body;
          delete note.binary;
        } else {
          throw new HttpError(500, 'GENERIC', `Cannot set null content to noteId '${note.noteId}'`);
        }
        note.utcDateModified = this.now().toISOString();
        note.dateModified = local(this.now());
        return new Response(null, { status: 204 });
      }
    }
    if ((match = m(/^\/notes\/([^/]+)\/revision$/)) && method === 'POST') {
      const note = this.notes.get(match[1]!);
      if (!note) throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${match[1]}' not found.`);
      const description =
        contentType.includes('json') && body
          ? String((JSON.parse(body) as { description?: string }).description ?? '')
          : '';
      this.revisions.push({ noteId: note.noteId, description, content: note.content });
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && path === '/branches') {
      const def = JSON.parse(body) as {
        noteId: string;
        parentNoteId: string;
        notePosition?: number;
        prefix?: string | null;
        isExpanded?: boolean;
      };
      if (!this.notes.has(def.noteId))
        throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${def.noteId}' not found.`);
      if (!this.notes.has(def.parentNoteId))
        throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${def.parentNoteId}' not found.`);
      if (def.noteId === def.parentNoteId || this.isDescendant(def.parentNoteId, def.noteId))
        throw new HttpError(
          400,
          'GENERIC',
          `Cannot clone note '${def.noteId}' under '${def.parentNoteId}': it would create a cycle.`,
        );
      const existing = [...this.branches.values()].find(
        (b) => b.noteId === def.noteId && b.parentNoteId === def.parentNoteId,
      );
      const branch = existing ?? this.addBranch(def.noteId, def.parentNoteId, def.notePosition);
      if (existing && typeof def.notePosition === 'number') branch.notePosition = def.notePosition;
      if (def.prefix !== undefined) branch.prefix = def.prefix;
      if (typeof def.isExpanded === 'boolean') branch.isExpanded = def.isExpanded;
      return json(branch, existing ? 200 : 201);
    }
    if ((match = m(/^\/branches\/([^/]+)$/))) {
      const branch = this.branches.get(match[1]!);
      if (method === 'GET') {
        if (!branch)
          throw new HttpError(404, 'BRANCH_NOT_FOUND', `Branch '${match[1]}' not found.`);
        return json(branch);
      }
      if (method === 'PATCH') {
        if (!branch)
          throw new HttpError(404, 'BRANCH_NOT_FOUND', `Branch '${match[1]}' not found.`);
        const patch = JSON.parse(body) as Record<string, unknown>;
        for (const key of Object.keys(patch))
          if (!['prefix', 'notePosition', 'isExpanded'].includes(key))
            throw new HttpError(
              400,
              'PROPERTY_NOT_ALLOWED',
              `Property '${key}' is not allowed for this method.`,
            );
        Object.assign(branch, patch);
        return json(branch);
      }
      if (method === 'DELETE') {
        if (branch) {
          this.branches.delete(branch.branchId);
          // Like Trilium: the last branch takes the note with it.
          if (this.parentsOf(branch.noteId).length === 0) this.deleteNoteCascade(branch.noteId);
        }
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'POST' && path === '/attachments') {
      const def = JSON.parse(body) as {
        ownerId: string;
        role: string;
        mime: string;
        title: string;
        content?: string;
        position?: number;
      };
      if (!this.notes.has(def.ownerId))
        throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${def.ownerId}' not found.`);
      for (const key of ['role', 'mime', 'title'])
        if (typeof (def as Record<string, unknown>)[key] !== 'string')
          throw new HttpError(
            400,
            'PROPERTY_VALIDATION_ERROR',
            `Validation failed on property '${key}'`,
          );
      const attachment = this.addAttachment({
        ownerId: def.ownerId,
        role: def.role,
        mime: def.mime,
        title: def.title,
        content: def.content ?? '',
        ...(def.position !== undefined ? { position: def.position } : {}),
      });
      return json(this.attachmentPojo(attachment), 201);
    }
    if ((match = m(/^\/attachments\/([^/]+)$/))) {
      const attachment = this.attachments.get(match[1]!);
      if (!attachment)
        throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', `Attachment '${match[1]}' not found.`);
      if (method === 'GET') return json(this.attachmentPojo(attachment));
      if (method === 'PATCH') {
        const patch = JSON.parse(body) as Record<string, unknown>;
        for (const key of Object.keys(patch))
          if (!['role', 'mime', 'title', 'position'].includes(key))
            throw new HttpError(
              400,
              'PROPERTY_NOT_ALLOWED',
              `Property '${key}' is not allowed for this method.`,
            );
        if (typeof patch['role'] === 'string') attachment.role = patch['role'];
        if (typeof patch['mime'] === 'string') attachment.mime = patch['mime'];
        if (typeof patch['title'] === 'string') attachment.title = patch['title'];
        if (typeof patch['position'] === 'number') attachment.position = patch['position'];
        attachment.utcDateModified = this.now().toISOString();
        return json(this.attachmentPojo(attachment));
      }
      if (method === 'DELETE') {
        this.attachments.delete(attachment.attachmentId);
        return new Response(null, { status: 204 });
      }
    }
    if ((match = m(/^\/attachments\/([^/]+)\/content$/))) {
      const attachment = this.attachments.get(match[1]!);
      if (!attachment)
        throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', `Attachment '${match[1]}' not found.`);
      if (method === 'GET')
        return new Response(attachment.content, {
          status: 200,
          headers: {
            'content-type': attachment.mime || 'application/octet-stream',
            'content-length': String(attachment.content.length),
          },
        });
      if (method === 'PUT') {
        if (
          !contentType.startsWith('text/plain') &&
          !contentType.startsWith('application/octet-stream')
        )
          throw new HttpError(400, 'GENERIC', 'Unsupported content type');
        attachment.content = Buffer.from(raw);
        attachment.utcDateModified = this.now().toISOString();
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'POST' && path === '/attributes') {
      const def = JSON.parse(body) as {
        noteId: string;
        type: 'label' | 'relation';
        name: string;
        value?: string;
        position?: number;
        isInheritable?: boolean;
      };
      if (def.type === 'relation' && !this.notes.has(def.value ?? ''))
        throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${def.value ?? ''}' not found.`);
      if (!this.notes.has(def.noteId))
        throw new HttpError(404, 'NOTE_NOT_FOUND', `Note '${def.noteId}' not found.`);
      if (!def.name || /\s/.test(def.name))
        throw new HttpError(
          400,
          'PROPERTY_VALIDATION_ERROR',
          "Validation failed on property 'name'",
        );
      return json(this.addAttribute(def), 201);
    }
    if ((match = m(/^\/attributes\/([^/]+)$/))) {
      const attr = this.attributes.get(match[1]!);
      if (method === 'GET') {
        if (!attr)
          throw new HttpError(404, 'ATTRIBUTE_NOT_FOUND', `Attribute '${match[1]}' not found.`);
        return json(attr);
      }
      if (method === 'PATCH') {
        if (!attr)
          throw new HttpError(404, 'ATTRIBUTE_NOT_FOUND', `Attribute '${match[1]}' not found.`);
        const patch = JSON.parse(body) as Record<string, unknown>;
        const allowed = attr.type === 'label' ? ['value', 'position'] : ['position'];
        for (const key of Object.keys(patch))
          if (!allowed.includes(key))
            throw new HttpError(
              400,
              'PROPERTY_NOT_ALLOWED',
              `Property '${key}' is not allowed for this method.`,
            );
        if (typeof patch['value'] === 'string') attr.value = patch['value'];
        if (typeof patch['position'] === 'number') attr.position = patch['position'];
        return json(attr);
      }
      if (method === 'DELETE') {
        if (attr) this.attributes.delete(attr.attributeId);
        return new Response(null, { status: 204 });
      }
    }
    throw new HttpError(404, 'NOT_FOUND', `Route ${method} ${path} not found`);
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.serveNode(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/etapi`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async serveNode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await this.handle(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function err(status: number, code: string, message: string): Response {
  return json({ status, code, message }, status);
}

// ---- tiny search DSL evaluator ----------------------------------------------

interface EvalContext {
  fulltext(term: string): boolean;
  label(name: string): string[];
  relationTarget(name: string, prop: string): Value[];
  property(path: string): Value[];
}

type Predicate = (ctx: EvalContext) => boolean;

function compare(actual: Value, op: string, expected: string): boolean {
  if (actual === undefined) return false;
  const a = typeof actual === 'string' ? actual : String(actual);
  const e = expected;
  const numeric =
    typeof actual === 'number' || (/^-?\d+(\.\d+)?$/.test(a) && /^-?\d+(\.\d+)?$/.test(e));
  switch (op) {
    case '=':
      return numeric ? Number(a) === Number(e) : a.toLowerCase() === e.toLowerCase();
    case '!=':
      return numeric ? Number(a) !== Number(e) : a.toLowerCase() !== e.toLowerCase();
    case '>':
      return numeric ? Number(a) > Number(e) : a > e;
    case '>=':
      return numeric ? Number(a) >= Number(e) : a >= e;
    case '<':
      return numeric ? Number(a) < Number(e) : a < e;
    case '<=':
      return numeric ? Number(a) <= Number(e) : a <= e;
    case '*=*':
      return a.toLowerCase().includes(e.toLowerCase());
    case '!*=*':
      return !a.toLowerCase().includes(e.toLowerCase());
    case '=*':
      return a.toLowerCase().startsWith(e.toLowerCase());
    case '*=':
      return a.toLowerCase().endsWith(e.toLowerCase());
    case '%=':
      return new RegExp(e).test(a);
    default:
      throw new Error(`unsupported operator ${op}`);
  }
}

const OPS = ['!*=*', '*=*', '=*', '*=', '%=', '>=', '<=', '!=', '=', '>', '<'];

function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < query.length && query[j] !== ch) {
        if (query[j] === '\\' && j + 1 < query.length) {
          value += query[j + 1];
          j += 2;
        } else {
          value += query[j];
          j++;
        }
      }
      tokens.push(`'${value}`);
      i = j + 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '~' && query[i + 1] === '(') {
      tokens.push('(');
      i += 2;
      continue;
    }
    const op = OPS.find((o) => query.startsWith(o, i));
    if (op && !/^[#~]/.test(query.slice(i))) {
      tokens.push(`op:${op}`);
      i += op.length;
      continue;
    }
    let j = i;
    while (
      j < query.length &&
      !/[\s()]/.test(query[j]!) &&
      !OPS.some((o) => query.startsWith(o, j) && j > i)
    )
      j++;
    tokens.push(query.slice(i, j));
    i = j;
  }
  return tokens;
}

export function parseQuery(query: string): Predicate {
  const tokens = tokenize(query);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++]!;

  function parseOr(): Predicate {
    const terms = [parseAnd()];
    while (peek() === 'OR') {
      next();
      terms.push(parseAnd());
    }
    return terms.length === 1 ? terms[0]! : (ctx) => terms.some((t) => t(ctx));
  }
  function parseAnd(): Predicate {
    const terms: Predicate[] = [];
    while (pos < tokens.length && peek() !== ')' && peek() !== 'OR') {
      if (peek() === 'AND') {
        next();
        continue;
      }
      terms.push(parseTerm());
    }
    return (ctx) => terms.every((t) => t(ctx));
  }
  function readValue(): string {
    const v = next();
    return v.startsWith("'") ? v.slice(1) : v;
  }
  function parseTerm(): Predicate {
    const tok = next();
    if (tok === '(') {
      const inner = parseOr();
      if (next() !== ')') throw new Error('expected )');
      return inner;
    }
    if (tok.startsWith('#')) {
      const negated = tok.startsWith('#!');
      const name = tok.slice(negated ? 2 : 1);
      if (peek()?.startsWith('op:')) {
        const op = next().slice(3);
        const value = readValue();
        return (ctx) => ctx.label(name).some((v) => compare(v, op, value));
      }
      return (ctx) => ctx.label(name).length > 0 !== negated;
    }
    if (tok.startsWith('~')) {
      const negated = tok.startsWith('~!');
      const spec = tok.slice(negated ? 2 : 1);
      const [name, prop = 'title'] = spec.split('.', 2) as [string, string?];
      if (peek()?.startsWith('op:')) {
        const op = next().slice(3);
        const value = readValue();
        return (ctx) => ctx.relationTarget(name, prop).some((v) => compare(v, op, value));
      }
      return (ctx) => ctx.relationTarget(name, 'noteId').length > 0 !== negated;
    }
    if (tok.startsWith('note.')) {
      const path = tok.slice(5);
      const opTok = next();
      if (!opTok.startsWith('op:')) throw new Error(`expected operator after note.${path}`);
      const value = readValue();
      return (ctx) => ctx.property(path).some((v) => compare(v, opTok.slice(3), value));
    }
    const term = tok.startsWith("'") ? tok.slice(1) : tok;
    return (ctx) => ctx.fulltext(term);
  }
  const predicate = parseOr();
  if (pos < tokens.length) throw new Error(`unexpected token ${tokens[pos]}`);
  return predicate;
}
