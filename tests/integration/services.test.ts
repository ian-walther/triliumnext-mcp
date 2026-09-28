/** End-to-end domain service behaviour against a real Trilium. */
import { beforeAll, describe, expect, it } from 'vitest';
import { connectLive, unique, type LiveTrilium } from './helpers.js';

let live: LiveTrilium;
let rootId: string;

beforeAll(async () => {
  live = connectLive();
  const created = await live.services.notes.create({
    principal: 'itest',
    title: unique('itest-services'),
    type: 'book',
  });
  rootId = created.note.noteId;
});

describe('services on live Trilium', () => {
  it('creates markdown notes with attributes, reads them back, and lists children', async () => {
    const created = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Plan',
      content: '# Plan\n\n- one\n- two',
      attributes: [{ type: 'label', name: 'kind', value: 'plan' }],
    });
    expect(created.created).toBe(true);
    expect(created.attributeResults[0]?.ok).toBe(true);
    const read = await live.services.notes.get({ noteId: created.note.noteId, format: 'plain' });
    expect(read.content).toContain('Plan');
    expect(read.content).toContain('one');
    expect(read.note.contentHash).toBe(created.note.contentHash);
    const children = await live.services.notes.listChildren({ noteId: rootId });
    expect(children.items.map((c) => c.title)).toEqual(['Plan']);
    const ctx = await live.services.notes.context({ noteId: rootId, includeChildContent: true });
    expect(ctx.children[0]?.contentPreview).toContain('one');
  });

  it('refuses duplicate titles and honours idempotency keys', async () => {
    await expect(
      live.services.notes.create({ principal: 'itest', parentNoteId: rootId, title: 'Plan' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
    const key = unique('key');
    const a = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Idem',
      idempotencyKey: key,
    });
    const b = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Idem',
      idempotencyKey: key,
    });
    expect(b.idempotentReplay).toBe(true);
    expect(b.note.noteId).toBe(a.note.noteId);
  });

  it('patches with hash protection, revisions, and detects stale writes', async () => {
    const created = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Patchable',
      content: 'first line',
    });
    const hash = created.note.contentHash;
    const appended = await live.services.notes.patch({
      noteId: created.note.noteId,
      expectedHash: hash,
      operation: 'append',
      content: 'second line',
    });
    expect(appended.revisionCreated).toBe(true);
    expect(appended.contentHash).not.toBe(hash);
    await expect(
      live.services.notes.patch({
        noteId: created.note.noteId,
        expectedHash: hash,
        operation: 'replace',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const edited = await live.services.notes.patch({
      noteId: created.note.noteId,
      expectedHash: appended.contentHash,
      operation: 'edit',
      edits: [{ find: 'second', replace: '2nd' }],
    });
    const read = await live.services.notes.get({ noteId: created.note.noteId, format: 'plain' });
    expect(read.content).toContain('2nd line');
    expect(read.note.contentHash).toBe(edited.contentHash);
  });

  it('resolves titles, paths and ambiguity', async () => {
    const parent = await live.services.notes.get({ noteId: rootId });
    const byPath = await live.services.search.resolve({ path: `${parent.note.title}/Plan` });
    expect(byPath.status).toBe('resolved');
    await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Plan',
      ifTitleExists: 'create',
    });
    const amb = await live.services.search.resolve({ title: 'Plan', parentNoteId: rootId });
    expect(amb.status).toBe('ambiguous');
    expect(amb.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('manages attributes and resolves built-in template relations', async () => {
    const board = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Tasks',
      type: 'book',
      attributes: [{ type: 'relation', name: 'template', value: 'Board' }],
    });
    expect(board.attributeResults[0]?.ok).toBe(true);
    const attrs = await live.services.attributes.read({
      noteId: board.note.noteId,
      type: 'relation',
    });
    expect(attrs.attributes[0]?.name).toBe('template');
    const managed = await live.services.attributes.manage(board.note.noteId, [
      { action: 'add', type: 'label', name: 'area', value: 'home' },
      { action: 'update', name: 'area', value: 'office' },
      { action: 'remove', name: 'area' },
    ]);
    expect(managed.results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(managed.note.attributes.some((a) => a.name === 'area')).toBe(false);
  });

  it('searches with criteria and pagination', async () => {
    const page = await live.services.search.search({
      criteria: [{ type: 'noteProperty', property: 'parents.noteId', value: rootId }],
      limit: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
    const rest = await live.services.search.search({
      criteria: [{ type: 'noteProperty', property: 'parents.noteId', value: rootId }],
      limit: 2,
      cursor: page.nextCursor,
    });
    expect(rest.items.length).toBeGreaterThanOrEqual(1);
  });
});
