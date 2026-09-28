import { beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { createServices, type Services } from '../../src/domain/services.js';
import { TriliumClient } from '../../src/etapi/client.js';
import { FakeTrilium } from '../helpers/fakeTrilium.js';

/** Typed wrapper so asymmetric matchers can sit inside toMatchObject without `any` leaks. */
const matching = (re: RegExp): string => expect.stringMatching(re) as string;

const limits = {
  maxWriteContentBytes: 100_000,
  defaultReadContentBytes: 10_000,
  maxReadContentBytes: 50_000,
  maxSearchLimit: 100,
  maxChildren: 100,
};

let fake: FakeTrilium;
let services: Services;

beforeEach(() => {
  fake = new FakeTrilium({ token: 'tok' });
  const client = new TriliumClient({
    baseUrl: 'http://fake/etapi',
    token: 'tok',
    fetch: fake.fetch,
    sleep: () => Promise.resolve(),
  });
  services = createServices({ client, limits, idempotency: new IdempotencyStore() });
  fake.addNote({ noteId: 'a', title: 'A', type: 'book', parentNoteId: 'root' });
  fake.addNote({ noteId: 'b', title: 'B', type: 'book', parentNoteId: 'root' });
  fake.addNote({ noteId: 'a1', title: 'A1', parentNoteId: 'a', content: '<p>one</p>' });
  fake.addNote({ noteId: 'a2', title: 'A2', parentNoteId: 'a' });
  fake.addNote({ noteId: 'deep', title: 'Deep', parentNoteId: 'a1' });
  fake.addNote({ noteId: 'srch', title: 'Saved search', type: 'search', parentNoteId: 'root' });
});

describe('HierarchyService.move', () => {
  it('moves a note by creating the new branch before removing the old one', async () => {
    const before = fake.blobId('a1');
    const result = await services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'b' });
    expect(result.mode).toBe('move');
    expect(result.noop).toBe(false);
    expect(result.branch.parentNoteId).toBe('b');
    expect(result.removedBranch?.parentNoteId).toBe('a');
    expect(result.note.parentNoteIds).toEqual(['b']);
    expect(result.note.contentHash).toBe(before);
    expect(fake.childrenOf('a')).toEqual(['a2']);
    expect(fake.childrenOf('b')).toEqual(['a1']);
    expect(fake.childrenOf('a1')).toEqual(['deep']);
    const order = fake.calls.filter((c) => /branches/.test(c.path)).map((c) => c.method);
    expect(order.indexOf('POST')).toBeLessThan(order.indexOf('DELETE'));
    expect(fake.deleted.size).toBe(0);
  });

  it('keeps the prefix and honours position and an explicit prefix', async () => {
    fake.branches.get('a_a1')!.prefix = 'Ch.1';
    const kept = await services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'b' });
    expect(kept.branch.prefix).toBe('Ch.1');
    const first = await services.hierarchy.move({
      noteId: 'a2',
      targetParentNoteId: 'b',
      position: 'first',
      prefix: 'Intro',
    });
    expect(first.branch.notePosition).toBe(0);
    expect(first.branch.prefix).toBe('Intro');
    expect(fake.childrenOf('b')).toEqual(['a2', 'a1']);
    const cleared = await services.hierarchy.move({
      noteId: 'a1',
      targetParentNoteId: 'a',
      prefix: null,
      position: 25,
    });
    expect(cleared.branch.prefix).toBeNull();
    expect(cleared.branch.notePosition).toBe(25);
  });

  it('clones without removing the original placement', async () => {
    const result = await services.hierarchy.move({
      noteId: 'a1',
      targetParentNoteId: 'b',
      mode: 'clone',
    });
    expect(result.mode).toBe('clone');
    expect(result.removedBranch).toBeUndefined();
    expect(result.note.parentNoteIds.sort()).toEqual(['a', 'b']);
    const again = await services.hierarchy.move({
      noteId: 'a1',
      targetParentNoteId: 'b',
      mode: 'clone',
    });
    expect(again.noop).toBe(true);
  });

  it('needs fromParentNoteId when several placements could move', async () => {
    await services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'b', mode: 'clone' });
    fake.addNote({ noteId: 'c', title: 'C', type: 'book', parentNoteId: 'root' });
    await expect(
      services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'c' }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS' });
    const moved = await services.hierarchy.move({
      noteId: 'a1',
      targetParentNoteId: 'c',
      fromParentNoteId: 'a',
    });
    expect(moved.removedBranch?.parentNoteId).toBe('a');
    expect(moved.warnings[0]).toMatch(/keeps its other 1 placement/);
    expect(fake.parentsOf('a1').sort()).toEqual(['b', 'c']);
    await expect(
      services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'a', fromParentNoteId: 'zzz' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is a no-op when the only placement is already the target', async () => {
    const result = await services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'a' });
    expect(result.noop).toBe(true);
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('refuses cycles, self, root, system notes and search-note targets', async () => {
    await expect(
      services.hierarchy.move({ noteId: 'a', targetParentNoteId: 'deep' }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: matching(/subtree/) });
    await expect(
      services.hierarchy.move({ noteId: 'a', targetParentNoteId: 'a' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.hierarchy.move({ noteId: 'root', targetParentNoteId: 'a' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.hierarchy.move({ noteId: '_templates', targetParentNoteId: 'a' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'srch' }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: matching(/search/) });
    await expect(
      services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Nothing was touched by any refused call.
    expect(fake.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('leaves the note in both places when removing the old branch fails', async () => {
    fake.intercept = (call) =>
      call.method === 'DELETE' && call.path.startsWith('/branches/')
        ? new Response(JSON.stringify({ status: 500, code: 'GENERIC', message: 'boom' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : undefined;
    await expect(
      services.hierarchy.move({ noteId: 'a1', targetParentNoteId: 'b' }),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: matching(/now also under/),
    });
    expect(fake.parentsOf('a1').sort()).toEqual(['a', 'b']);
  });
});
