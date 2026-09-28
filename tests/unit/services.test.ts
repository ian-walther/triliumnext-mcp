import { beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { applyEdit, createServices, type Services } from '../../src/domain/services.js';
import { TriliumClient } from '../../src/etapi/client.js';
import { FakeTrilium } from '../helpers/fakeTrilium.js';

const limits = {
  maxWriteContentBytes: 100_000,
  defaultReadContentBytes: 10_000,
  maxReadContentBytes: 50_000,
  maxSearchLimit: 100,
  maxChildren: 100,
};

function setup() {
  const fake = new FakeTrilium({ token: 'tok' });
  const client = new TriliumClient({
    baseUrl: 'http://fake/etapi',
    token: 'tok',
    fetch: fake.fetch,
    sleep: () => Promise.resolve(),
  });
  const services = createServices({ client, limits, idempotency: new IdempotencyStore() });
  return { fake, client, services };
}

let fake: FakeTrilium;
let services: Services;

beforeEach(() => {
  ({ fake, services } = setup());
  fake.addNote({ noteId: 'projects', title: 'Projects', type: 'book', parentNoteId: 'root' });
  fake.addNote({
    noteId: 'home',
    title: 'Home',
    type: 'book',
    parentNoteId: 'projects',
    labels: { project: 'home' },
  });
  fake.addNote({
    noteId: 'plumb',
    title: 'Plumbing',
    type: 'text',
    parentNoteId: 'home',
    content: '<p>Fix the sink</p>',
    labels: { status: 'todo' },
  });
  fake.addNote({
    noteId: 'garden',
    title: 'Garden',
    type: 'text',
    parentNoteId: 'home',
    content: '<p>Plant tomatoes</p>',
  });
  fake.addNote({ noteId: 'work', title: 'Work', type: 'book', parentNoteId: 'projects' });
  fake.addNote({
    noteId: 'plumb2',
    title: 'Plumbing',
    type: 'text',
    parentNoteId: 'work',
    content: '<p>Office sink</p>',
  });
  fake.addNote({
    noteId: 'script',
    title: 'Script',
    type: 'code',
    mime: 'text/x-python',
    parentNoteId: 'work',
    content: 'print(1)\nprint(2)\n',
  });
});

describe('SearchService.search', () => {
  it('runs full text with pagination', async () => {
    const page1 = await services.search.search({ text: 'sink', limit: 1 });
    expect(page1.items.map((n) => n.noteId)).toEqual(['plumb']);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await services.search.search({
      text: 'sink',
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((n) => n.noteId)).toEqual(['plumb2']);
    expect(page2.nextCursor).toBeUndefined();
    expect(page2.query).toBe('sink');
  });
  it('translates criteria and sends etapi params', async () => {
    const res = await services.search.search({
      criteria: [{ type: 'label', property: 'status', op: '=', value: 'todo' }],
      ancestorNoteId: 'home',
    });
    expect(res.items.map((n) => n.noteId)).toEqual(['plumb']);
    const call = fake.calls.at(-1)!;
    expect(call.query['ancestorNoteId']).toBe('home');
    expect(call.query['includeArchivedNotes']).toBe('false');
    expect(call.query['fastSearch']).toBe('false');
  });
  it('rejects empty input as validation', async () => {
    await expect(services.search.search({})).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('SearchService.resolve', () => {
  it('resolves ids, exact titles, ambiguous titles and paths', async () => {
    expect((await services.search.resolve({ noteId: 'garden' })).status).toBe('resolved');
    expect((await services.search.resolve({ noteId: 'nope' })).status).toBe('not_found');
    const one = await services.search.resolve({ title: 'garden' });
    expect(one.status).toBe('resolved');
    expect(one.note?.noteId).toBe('garden');
    const amb = await services.search.resolve({ title: 'Plumbing' });
    expect(amb.status).toBe('ambiguous');
    expect(amb.candidates).toHaveLength(2);
    const scoped = await services.search.resolve({ title: 'Plumbing', parentNoteId: 'work' });
    expect(scoped.note?.noteId).toBe('plumb2');
    const path = await services.search.resolve({ path: 'Projects/Home/Plumbing' });
    expect(path.status).toBe('resolved');
    expect(path.note?.noteId).toBe('plumb');
    expect((await services.search.resolve({ path: 'Projects/Nowhere' })).status).toBe('not_found');
    const partial = await services.search.resolve({ title: 'Plumb', exact: true });
    expect(partial.status).toBe('not_found');
  });
});

describe('NotesService.get / context / listChildren', () => {
  it('returns content, hash and truncation info', async () => {
    const res = await services.notes.get({ noteId: 'plumb' });
    expect(res.note.contentHash).toBe(fake.blobId('plumb'));
    expect(res.content).toBe('<p>Fix the sink</p>');
    expect(res.contentTruncated).toBe(false);
    const plain = await services.notes.get({
      noteId: 'plumb',
      format: 'plain',
      find: { pattern: 'sink' },
    });
    expect(plain.content).toBe('Fix the sink');
    expect(plain.totalMatches).toBe(1);
    const small = await services.notes.get({ noteId: 'plumb', maxContentBytes: 1024 });
    expect(small.contentTruncated).toBe(false);
  });
  it('omits content for protected and binary notes', async () => {
    fake.addNote({ noteId: 'secret', title: 'Secret', parentNoteId: 'root', isProtected: true });
    fake.addNote({
      noteId: 'img',
      title: 'Img',
      type: 'image',
      mime: 'image/png',
      parentNoteId: 'root',
    });
    expect((await services.notes.get({ noteId: 'secret' })).contentOmittedReason).toMatch(
      /protected/,
    );
    expect((await services.notes.get({ noteId: 'img' })).contentOmittedReason).toMatch(/Binary/);
  });
  it('maps 404 to NOT_FOUND', async () => {
    await expect(services.notes.get({ noteId: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('builds context with parents and children previews', async () => {
    const ctx = await services.notes.context({ noteId: 'home', includeChildContent: true });
    expect(ctx.parents.map((p) => p.noteId)).toEqual(['projects']);
    expect(ctx.children.map((c) => c.noteId)).toEqual(['plumb', 'garden']);
    expect(ctx.children[0]?.contentPreview).toBe('Fix the sink');
    expect(ctx.totalChildren).toBe(2);
  });
  it('lists children in tree order and by title', async () => {
    const tree = await services.notes.listChildren({ noteId: 'home' });
    expect(tree.items.map((c) => c.noteId)).toEqual(['plumb', 'garden']);
    const byTitle = await services.notes.listChildren({ noteId: 'home', orderBy: 'title' });
    expect(byTitle.items.map((c) => c.title)).toEqual(['Garden', 'Plumbing']);
    const paged = await services.notes.listChildren({ noteId: 'home', limit: 1 });
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(2);
    expect(paged.nextCursor).toBeDefined();
  });
});

describe('NotesService.create', () => {
  it('creates a text note from markdown with attributes and resolves template by title', async () => {
    const res = await services.notes.create({
      principal: 'p',
      parentNoteId: 'home',
      title: 'Tasks',
      type: 'book',
      attributes: [
        { type: 'relation', name: 'template', value: 'Board' },
        { type: 'label', name: 'area', value: 'kitchen' },
      ],
    });
    expect(res.created).toBe(true);
    expect(res.attributeResults.every((r) => r.ok)).toBe(true);
    const rel = fake.attributesOf(res.note.noteId).find((a) => a.type === 'relation');
    expect(rel?.value).toBe('_template_board');
    const md = await services.notes.create({
      principal: 'p',
      parentNoteId: 'home',
      title: 'Notes',
      content: '# Hi\n\ntext',
    });
    expect(fake.notes.get(md.note.noteId)?.content).toContain('<h1>Hi</h1>');
    expect(md.contentFormat).toBe('markdown');
  });
  it('detects duplicate titles and supports return_existing / create', async () => {
    await expect(
      services.notes.create({ principal: 'p', parentNoteId: 'home', title: 'Plumbing' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
    const existing = await services.notes.create({
      principal: 'p',
      parentNoteId: 'home',
      title: 'Plumbing',
      ifTitleExists: 'return_existing',
    });
    expect(existing.created).toBe(false);
    expect(existing.note.noteId).toBe('plumb');
    const dup = await services.notes.create({
      principal: 'p',
      parentNoteId: 'home',
      title: 'Plumbing',
      ifTitleExists: 'create',
    });
    expect(dup.created).toBe(true);
    expect(dup.note.noteId).not.toBe('plumb');
  });
  it('replays idempotent creates', async () => {
    const first = await services.notes.create({
      principal: 'p',
      title: 'Once',
      idempotencyKey: 'key-12345678',
    });
    const again = await services.notes.create({
      principal: 'p',
      title: 'Once',
      idempotencyKey: 'key-12345678',
      ifTitleExists: 'create',
    });
    expect(again.idempotentReplay).toBe(true);
    expect(again.note.noteId).toBe(first.note.noteId);
    expect([...fake.notes.values()].filter((n) => n.title === 'Once')).toHaveLength(1);
    const other = await services.notes.create({
      principal: 'q',
      title: 'Once',
      idempotencyKey: 'key-12345678',
      ifTitleExists: 'create',
    });
    expect(other.idempotentReplay).toBe(false);
  });
  it('validates type, mime and relation targets', async () => {
    await expect(
      services.notes.create({ principal: 'p', title: 'x', type: 'code' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.notes.create({ principal: 'p', title: 'x', type: 'image' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(
      services.notes.create({
        principal: 'p',
        title: 'x',
        attributes: [{ type: 'relation', name: 'author', value: 'Nobody' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      services.notes.create({
        principal: 'p',
        title: 'x',
        attributes: [{ type: 'relation', name: 'see', value: 'Plumbing' }],
      }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS' });
    await expect(
      services.notes.create({ principal: 'p', parentNoteId: 'nope', title: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('NotesService.patch', () => {
  it('replaces, appends, prepends and edits with hash protection and revisions', async () => {
    const hash = fake.blobId('plumb');
    const r1 = await services.notes.patch({
      noteId: 'plumb',
      expectedHash: hash,
      operation: 'append',
      content: 'Also the tap',
    });
    expect(fake.notes.get('plumb')?.content).toBe('<p>Fix the sink</p>\n<p>Also the tap</p>');
    expect(r1.revisionCreated).toBe(true);
    expect(r1.previousHash).toBe(hash);
    expect(r1.contentHash).toBe(fake.blobId('plumb'));
    expect(fake.revisions.filter((r) => r.noteId === 'plumb')).toHaveLength(1);
    await expect(
      services.notes.patch({
        noteId: 'plumb',
        expectedHash: hash,
        operation: 'replace',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const r2 = await services.notes.patch({
      noteId: 'plumb',
      expectedHash: r1.contentHash,
      operation: 'edit',
      edits: [{ find: 'tap', replace: 'faucet' }],
      createRevision: false,
    });
    expect(fake.notes.get('plumb')?.content).toContain('faucet');
    expect(r2.editsApplied).toBe(1);
    expect(r2.revisionCreated).toBe(false);
    const r3 = await services.notes.patch({
      noteId: 'plumb',
      expectedHash: r2.contentHash,
      operation: 'replace',
      content: '# New',
      contentFormat: 'markdown',
    });
    expect(fake.notes.get('plumb')?.content).toBe('<h1>New</h1>');
    await services.notes.patch({
      noteId: 'plumb',
      expectedHash: r3.contentHash,
      operation: 'prepend',
      content: '<p>Top</p>',
    });
    expect(fake.notes.get('plumb')?.content).toBe('<p>Top</p>\n<h1>New</h1>');
  });
  it('edits code notes verbatim and reports ambiguity', async () => {
    const hash = fake.blobId('script');
    await expect(
      services.notes.patch({
        noteId: 'script',
        expectedHash: hash,
        operation: 'edit',
        edits: [{ find: 'print', replace: 'log' }],
      }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS' });
    await services.notes.patch({
      noteId: 'script',
      expectedHash: hash,
      operation: 'edit',
      edits: [{ find: 'print', replace: 'log', all: true }],
    });
    expect(fake.notes.get('script')?.content).toBe('log(1)\nlog(2)\n');
    const h2 = fake.blobId('script');
    await services.notes.patch({
      noteId: 'script',
      expectedHash: h2,
      operation: 'edit',
      edits: [{ find: 'log\\((\\d)\\)', replace: 'say($1)', regex: true, occurrence: 2 }],
    });
    expect(fake.notes.get('script')?.content).toBe('log(1)\nsay(2)\n');
  });
  it('rejects binary and protected notes and missing edits', async () => {
    fake.addNote({ noteId: 'secret', title: 'Secret', parentNoteId: 'root', isProtected: true });
    await expect(
      services.notes.patch({
        noteId: 'secret',
        expectedHash: 'x',
        operation: 'replace',
        content: 'a',
      }),
    ).rejects.toMatchObject({ code: 'PROTECTED' });
    await expect(
      services.notes.patch({
        noteId: 'plumb',
        expectedHash: fake.blobId('plumb'),
        operation: 'edit',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.notes.patch({
        noteId: 'plumb',
        expectedHash: fake.blobId('plumb'),
        operation: 'edit',
        edits: [{ find: 'zzz', replace: '' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('applyEdit', () => {
  it('handles literal, regex, all and occurrence', () => {
    expect(applyEdit('a.b a.b', { find: 'a.b', replace: 'x', occurrence: 2 }, 'e')).toBe('a.b x');
    expect(
      applyEdit('a1 a2', { find: 'a(\\d)', replace: 'b$1', regex: true, all: true }, 'e'),
    ).toBe('b1 b2');
    expect(() => applyEdit('aaa', { find: 'a*', replace: 'x', regex: true }, 'e')).toThrow(
      DomainError,
    );
  });
});

describe('NotesService.updateMetadata', () => {
  it('renames and rejects empty updates', async () => {
    const res = await services.notes.updateMetadata({ noteId: 'garden', title: 'Garden 2' });
    expect(res.note.title).toBe('Garden 2');
    expect(res.changed).toEqual(['title']);
    await expect(services.notes.updateMetadata({ noteId: 'garden' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('AttributesService', () => {
  it('reads owned vs inherited attributes with filters', async () => {
    fake.addAttribute({
      noteId: 'projects',
      type: 'label',
      name: 'inh',
      value: 'v',
      isInheritable: true,
    });
    const owned = await services.attributes.read({ noteId: 'plumb' });
    expect(owned.attributes.map((a) => a.name)).toEqual(['status']);
    const all = await services.attributes.read({ noteId: 'plumb', includeInherited: true });
    expect(all.attributes.map((a) => a.name).sort()).toEqual(['inh', 'status']);
    expect(all.attributes.find((a) => a.name === 'inh')?.inherited).toBe(true);
    expect((await services.attributes.read({ noteId: 'plumb', name: 'nope' })).attributes).toEqual(
      [],
    );
  });
  it('adds, updates and removes with per-op results', async () => {
    const res = await services.attributes.manage('plumb', [
      { action: 'add', type: 'label', name: 'priority', value: 'high' },
      { action: 'update', name: 'status', value: 'done' },
      { action: 'add', type: 'relation', name: 'template', value: 'Board' },
      { action: 'update', name: 'template', value: 'Other' },
      { action: 'remove', name: 'missing' },
    ]);
    expect(res.results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
    expect(res.results[3]?.error).toMatch(/retarget/);
    expect(res.results[4]?.error).toMatch(/not found/);
    expect(res.note.attributes.find((a) => a.name === 'status')?.value).toBe('done');
    const removed = await services.attributes.manage('plumb', [
      { action: 'remove', name: 'priority' },
    ]);
    expect(removed.results[0]?.ok).toBe(true);
    expect(removed.note.attributes.some((a) => a.name === 'priority')).toBe(false);
  });
});

describe('search ordering', () => {
  it('uses the orderBy parameter, computes ascending client-side, and validates names', async () => {
    const desc = await services.search.search({
      criteria: [{ type: 'noteProperty', property: 'parents.noteId', value: 'home' }],
      orderBy: 'title',
      orderDirection: 'desc',
    });
    expect(fake.calls.at(-1)?.query['orderBy']).toBe('title');
    expect(desc.items.map((n) => n.title)).toEqual(['Plumbing', 'Garden']);
    const asc = await services.search.search({
      criteria: [{ type: 'noteProperty', property: 'parents.noteId', value: 'home' }],
      orderBy: 'note.title',
      orderDirection: 'asc',
      limit: 1,
    });
    expect(asc.items.map((n) => n.title)).toEqual(['Garden']);
    expect(asc.nextCursor).toBeDefined();
    const page2 = await services.search.search({
      criteria: [{ type: 'noteProperty', property: 'parents.noteId', value: 'home' }],
      orderBy: 'note.title',
      orderDirection: 'asc',
      limit: 1,
      cursor: asc.nextCursor,
    });
    expect(page2.items.map((n) => n.title)).toEqual(['Plumbing']);
    await expect(
      services.search.search({ text: 'x', orderBy: 'note.title; drop' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
