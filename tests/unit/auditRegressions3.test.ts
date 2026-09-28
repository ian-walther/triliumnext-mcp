/** Regressions for audit findings R9–R14 (v2.1 hierarchy, deletion, attachments). */
import { beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { createServices, type Services } from '../../src/domain/services.js';
import { TriliumClient } from '../../src/etapi/client.js';
import { FakeTrilium, type RecordedCall } from '../helpers/fakeTrilium.js';

const limits = {
  maxWriteContentBytes: 100_000,
  defaultReadContentBytes: 1024,
  maxReadContentBytes: 50_000,
  maxSearchLimit: 100,
  maxChildren: 100,
};

let fake: FakeTrilium;
let services: Services;

function mutations(): RecordedCall[] {
  return fake.calls.filter((c) => c.method !== 'GET');
}

beforeEach(() => {
  fake = new FakeTrilium({ token: 'tok' });
  const client = new TriliumClient({
    baseUrl: 'http://fake/etapi',
    token: 'tok',
    fetch: fake.fetch,
    sleep: () => Promise.resolve(),
  });
  services = createServices({ client, limits, idempotency: new IdempotencyStore() });
  fake.addNote({ noteId: 'p', title: 'P', type: 'book', parentNoteId: 'root' });
  fake.addNote({ noteId: 'q', title: 'Q', type: 'book', parentNoteId: 'root' });
  fake.addNote({ noteId: 'n', title: 'N', parentNoteId: 'p', content: '<p>n</p>' });
  fake.addNote({ noteId: 'child', title: 'Child', parentNoteId: 'n' });
  fake.addNote({ noteId: 'late', title: 'Late', parentNoteId: 'p' });
});

describe('R9 a same-parent move never removes the destination placement', () => {
  it('treats fromParentNoteId === targetParentNoteId as an in-place edit', async () => {
    const result = await services.hierarchy.move({
      noteId: 'n',
      targetParentNoteId: 'p',
      fromParentNoteId: 'p',
    });
    expect(result.noop).toBe(true);
    expect(result.removedBranch).toBeUndefined();
    expect(fake.notes.has('n')).toBe(true);
    expect(fake.notes.has('child')).toBe(true);
    expect(fake.childrenOf('p')).toEqual(['n', 'late']);
    expect(mutations()).toEqual([]);
    // Repeating it and adding a prefix edit are equally safe.
    const edited = await services.hierarchy.move({
      noteId: 'n',
      targetParentNoteId: 'p',
      fromParentNoteId: 'p',
      prefix: 'Ch.1',
    });
    expect(edited.noop).toBe(false);
    expect(edited.branch.prefix).toBe('Ch.1');
    expect(mutations().map((c) => c.method)).toEqual(['PATCH']);
    expect(fake.deleted.size).toBe(0);
  });

  it('keeps the destination when a multi-parent note names it as the source', async () => {
    await services.hierarchy.move({ noteId: 'n', targetParentNoteId: 'q', mode: 'clone' });
    fake.calls.length = 0;
    const result = await services.hierarchy.move({
      noteId: 'n',
      targetParentNoteId: 'q',
      fromParentNoteId: 'q',
    });
    expect(result.noop).toBe(true);
    expect(fake.parentsOf('n').sort()).toEqual(['p', 'q']);
    expect(mutations()).toEqual([]);
  });
});

describe('R10 tree changes cannot slip between deletion checks and the DELETE', () => {
  /** Pause the outgoing DELETE until the test releases it. */
  function barrier(): { release: () => void; hit: Promise<void> } {
    let release!: () => void;
    let hit!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hitPromise = new Promise<void>((r) => (hit = r));
    fake.intercept = async (call) => {
      if (call.method === 'DELETE' && /^\/notes\//.test(call.path)) {
        hit();
        await gate;
      }
      return undefined;
    };
    return { release, hit: hitPromise };
  }

  it('a child created during a leaf delete waits and then fails; nothing is silently deleted', async () => {
    fake.addNote({ noteId: 'race', title: 'Race', type: 'book', parentNoteId: 'root' });
    const gate = barrier();
    const deletion = services.deletion.deleteNote({
      noteId: 'race',
      expectedTitle: 'Race',
      confirm: true,
    });
    await gate.hit;
    let created: 'pending' | 'done' | 'failed' = 'pending';
    const creation = services.notes
      .create({ principal: 'p', parentNoteId: 'race', title: 'Kid' })
      .then(
        () => (created = 'done'),
        () => (created = 'failed'),
      );
    await new Promise((r) => setTimeout(r, 20));
    expect(created).toBe('pending'); // blocked behind the hierarchy lock
    gate.release();
    const result = await deletion;
    expect(result).toMatchObject({ deleted: true, descendantCount: 0 });
    await creation;
    expect(created).toBe('failed'); // parent is gone: NOT_FOUND, not a vanished child
    expect([...fake.notes.values()].some((n) => n.title === 'Kid')).toBe(false);
    expect(fake.deleted.size).toBe(1);
  });

  it('a move into the deleting parent and a rename wait as well', async () => {
    fake.addNote({ noteId: 'race', title: 'Race', type: 'book', parentNoteId: 'root' });
    const gate = barrier();
    const deletion = services.deletion.deleteNote({
      noteId: 'race',
      expectedTitle: 'Race',
      confirm: true,
    });
    await gate.hit;
    const outcomes: string[] = [];
    const move = services.hierarchy.move({ noteId: 'late', targetParentNoteId: 'race' }).then(
      () => outcomes.push('move:ok'),
      (e: { code: string }) => outcomes.push(`move:${e.code}`),
    );
    const rename = services.notes.updateMetadata({ noteId: 'race', title: 'Renamed' }).then(
      () => outcomes.push('rename:ok'),
      (e: { code: string }) => outcomes.push(`rename:${e.code}`),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(outcomes).toEqual([]);
    gate.release();
    await deletion;
    await Promise.all([move, rename]);
    expect(outcomes.sort()).toEqual(['move:NOT_FOUND', 'rename:NOT_FOUND']);
    expect(fake.notes.has('late')).toBe(true);
    expect(fake.parentsOf('late')).toEqual(['p']);
  });

  it('a rename that lands first makes the delete refuse on expectedTitle', async () => {
    fake.addNote({ noteId: 'race', title: 'Race', type: 'book', parentNoteId: 'root' });
    await services.notes.updateMetadata({ noteId: 'race', title: 'Renamed' });
    await expect(
      services.deletion.deleteNote({ noteId: 'race', expectedTitle: 'Race', confirm: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fake.notes.has('race')).toBe(true);
  });
});

describe('R11 blank attachment metadata is rejected before any mutation', () => {
  it('refuses empty or whitespace mime/role/title with no PUT or PATCH', async () => {
    const created = await services.attachments.create({
      noteId: 'n',
      title: 'a.txt',
      mime: 'text/plain',
      content: 'v1',
    });
    const id = created.attachment.attachmentId;
    fake.calls.length = 0;
    for (const bad of [
      { mime: '' },
      { mime: '   ' },
      { role: '' },
      { role: '   ' },
      { title: '  ' },
      { mime: ' ', content: 'v2', expectedHash: created.attachment.contentHash },
    ]) {
      await expect(services.attachments.update({ attachmentId: id, ...bad })).rejects.toMatchObject(
        { code: 'VALIDATION' },
      );
    }
    expect(mutations()).toEqual([]);
    const read = await services.attachments.get({ attachmentId: id });
    expect(read.content).toBe('v1');
    expect(read.attachment.mime).toBe('text/plain');
    expect(read.attachment.contentHash).toBe(created.attachment.contentHash);
  });
});

describe('R13 first/last reposition an existing placement', () => {
  it("moves an existing placement to last, and 'first' back, with real sibling order", async () => {
    const toLast = await services.hierarchy.move({
      noteId: 'n',
      targetParentNoteId: 'p',
      position: 'last',
    });
    expect(toLast.noop).toBe(false);
    expect(fake.childrenOf('p')).toEqual(['late', 'n']);
    const again = await services.hierarchy.move({
      noteId: 'n',
      targetParentNoteId: 'p',
      position: 'last',
    });
    expect(again.noop).toBe(true);
    const toFirst = await services.hierarchy.move({
      noteId: 'n',
      targetParentNoteId: 'p',
      position: 'first',
    });
    expect(toFirst.noop).toBe(false);
    expect(fake.childrenOf('p')).toEqual(['n', 'late']);
    const numeric = await services.hierarchy.move({
      noteId: 'n',
      targetParentNoteId: 'p',
      position: 25,
    });
    expect(numeric.branch.notePosition).toBe(25);
    expect(fake.childrenOf('p')).toEqual(['late', 'n']);
    // clone mode onto an existing placement honours position too
    const cloneLast = await services.hierarchy.move({
      noteId: 'late',
      targetParentNoteId: 'p',
      mode: 'clone',
      position: 'last',
    });
    expect(cloneLast.noop).toBe(false);
    expect(fake.childrenOf('p')).toEqual(['n', 'late']);
    expect(fake.deleted.size).toBe(0);
  });
});

describe('R14 truncated text attachments never split a code point', () => {
  it('returns an exact prefix for 2-, 3- and 4-byte characters and exact boundaries', async () => {
    const cases: Array<[string, number]> = [
      ['a'.repeat(1023) + '😀end', 4],
      ['a'.repeat(1023) + 'é' + 'x', 2],
      ['a'.repeat(1022) + '€' + 'x', 3],
      ['a'.repeat(1024) + 'z', 1],
    ];
    for (const [text, width] of cases) {
      const a = fake.addAttachment({
        ownerId: 'n',
        title: 't.txt',
        mime: 'text/plain',
        content: text,
      });
      const read = await services.attachments.get({ attachmentId: a.attachmentId });
      expect(read.contentTruncated).toBe(true);
      expect(read.content).not.toContain('�');
      expect(text.startsWith(read.content!)).toBe(true);
      expect(Buffer.byteLength(read.content!, 'utf8')).toBeLessThanOrEqual(1024);
      expect(Buffer.byteLength(read.content!, 'utf8')).toBeGreaterThan(1024 - width);
      expect(read.contentBytes).toBe(Buffer.byteLength(text, 'utf8'));
    }
    const whole = fake.addAttachment({
      ownerId: 'n',
      title: 'w.txt',
      mime: 'text/plain',
      content: 'héllo',
    });
    const full = await services.attachments.get({ attachmentId: whole.attachmentId });
    expect(full).toMatchObject({ content: 'héllo', contentTruncated: false });
  });
});
