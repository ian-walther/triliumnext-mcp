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
  fake.addNote({ noteId: 'a1', title: 'A1', parentNoteId: 'a', labels: { k: 'v' } });
  fake.addNote({ noteId: 'deep', title: 'Deep', parentNoteId: 'a1' });
  fake.addNote({ noteId: 'leaf', title: 'Leaf', parentNoteId: 'b', content: '<p>x</p>' });
  fake.addAttachment({ ownerId: 'leaf', title: 'f.txt', content: 'hi' });
});

describe('DeletionService', () => {
  it('requires confirm and the exact title, and refuses root/system notes', async () => {
    await expect(
      services.deletion.deleteNote({ noteId: 'leaf', expectedTitle: 'Leaf', confirm: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: matching(/confirm/) });
    await expect(
      services.deletion.deleteNote({ noteId: 'leaf', expectedTitle: 'leaf', confirm: true }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { currentTitle: 'Leaf', expectedTitle: 'leaf' },
    });
    for (const noteId of ['root', '_templates', '_hidden']) {
      await expect(
        services.deletion.deleteNote({ noteId, expectedTitle: 'x', confirm: true }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(fake.notes.has('leaf')).toBe(true);
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('refuses subtrees unless deleteDescendants is set, and dry runs report the plan', async () => {
    const refused = await services.deletion
      .deleteNote({ noteId: 'a', expectedTitle: 'A', confirm: true })
      .catch((e: unknown) => e as { code: string; details: Record<string, unknown> });
    expect(refused).toMatchObject({ code: 'VALIDATION', details: { descendantCount: 2 } });
    const dry = await services.deletion.deleteNote({
      noteId: 'a',
      expectedTitle: 'A',
      confirm: true,
      deleteDescendants: true,
      dryRun: true,
    });
    expect(dry).toMatchObject({ deleted: false, dryRun: true, descendantCount: 2 });
    expect(dry.sampleDescendants.map((n) => n.noteId).sort()).toEqual(['a1', 'deep']);
    expect(fake.notes.has('a')).toBe(true);
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('deletes a subtree, verifies it is gone, and undeletes it with attributes and attachments', async () => {
    const result = await services.deletion.deleteNote({
      noteId: 'a',
      expectedTitle: 'A',
      confirm: true,
      deleteDescendants: true,
    });
    expect(result).toMatchObject({ deleted: true, undeletable: true, descendantCount: 2 });
    expect(result.warnings.some((w) => /another parent/.test(w))).toBe(true);
    expect(fake.notes.has('a')).toBe(false);
    expect(fake.notes.has('deep')).toBe(false);
    await expect(services.notes.get({ noteId: 'a1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const restored = await services.deletion.undeleteNote('a');
    expect(restored.note.noteId).toBe('a');
    expect(fake.notes.has('a1')).toBe(true);
    expect(fake.notes.has('deep')).toBe(true);
    expect(fake.childrenOf('a')).toEqual(['a1']);
    const attrs = await services.attributes.read({ noteId: 'a1' });
    expect(attrs.attributes.map((a) => a.name)).toEqual(['k']);
  });

  it('deleting a leaf takes its attachments along and undelete brings them back', async () => {
    await services.deletion.deleteNote({ noteId: 'leaf', expectedTitle: 'Leaf', confirm: true });
    expect(fake.attachments.size).toBe(0);
    await services.deletion.undeleteNote('leaf');
    const list = await services.attachments.list('leaf');
    expect(list.attachments.map((a) => a.title)).toEqual(['f.txt']);
  });

  it('undelete explains live notes, unknown notes, and missing parents', async () => {
    await expect(services.deletion.undeleteNote('leaf')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: matching(/not deleted/),
    });
    await expect(services.deletion.undeleteNote('ghost')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await services.deletion.deleteNote({
      noteId: 'a',
      expectedTitle: 'A',
      confirm: true,
      deleteDescendants: true,
    });
    // 'deep' was deleted with its parent; it cannot come back on its own.
    await expect(services.deletion.undeleteNote('deep')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: matching(/undeleted parent/),
    });
  });

  it('reports an upstream that pretends to delete', async () => {
    fake.intercept = (call) =>
      call.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined;
    await expect(
      services.deletion.deleteNote({ noteId: 'leaf', expectedTitle: 'Leaf', confirm: true }),
    ).rejects.toMatchObject({ code: 'UPSTREAM', message: matching(/still readable/) });
  });
});
