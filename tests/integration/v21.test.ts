/** Live Trilium behaviour the v2.1 tools depend on: branches, soft delete, attachments, binary notes. */
import { beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { createServices } from '../../src/domain/services.js';
import { TriliumClient } from '../../src/etapi/client.js';
import { EtapiError } from '../../src/etapi/errors.js';
import { connectLive, unique, type LiveTrilium } from './helpers.js';

let live: LiveTrilium;
let rootId: string;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  live = connectLive();
  const created = await live.services.notes.create({
    principal: 'itest',
    title: unique('itest-v21'),
    type: 'book',
  });
  rootId = created.note.noteId;
});

describe('hierarchy on live Trilium', () => {
  it('moves with prefix preserved, positions honoured, clones kept, cycles refused', async () => {
    const a = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'A',
      type: 'book',
    });
    const b = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'B',
      type: 'book',
    });
    const child = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: a.note.noteId,
      title: 'Child',
      content: 'body',
    });
    await live.client.patchBranch(child.branchId, { prefix: 'Ch.1' });
    const moved = await live.services.hierarchy.move({
      noteId: child.note.noteId,
      targetParentNoteId: b.note.noteId,
    });
    expect(moved.branch.parentNoteId).toBe(b.note.noteId);
    expect(moved.branch.prefix).toBe('Ch.1');
    expect(moved.note.parentNoteIds).toEqual([b.note.noteId]);
    expect(moved.note.contentHash).toBe(child.note.contentHash);
    expect((await live.client.getNote(a.note.noteId)).childNoteIds).toEqual([]);

    const sibling = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: a.note.noteId,
      title: 'Sibling',
    });
    const first = await live.services.hierarchy.move({
      noteId: sibling.note.noteId,
      targetParentNoteId: b.note.noteId,
      position: 'first',
    });
    expect(first.branch.notePosition).toBe(0);
    expect((await live.client.getNote(b.note.noteId)).childNoteIds).toEqual([
      sibling.note.noteId,
      child.note.noteId,
    ]);
    // A branch created without notePosition lands last.
    const last = await live.services.hierarchy.move({
      noteId: sibling.note.noteId,
      targetParentNoteId: a.note.noteId,
      mode: 'clone',
    });
    expect(last.branch.parentNoteId).toBe(a.note.noteId);
    expect(last.note.parentNoteIds.sort()).toEqual([a.note.noteId, b.note.noteId].sort());
    // 'sibling' is (also) a child of A, so placing A under it would be a cycle.
    await expect(
      live.services.hierarchy.move({
        noteId: a.note.noteId,
        targetParentNoteId: sibling.note.noteId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await live.client.getNote(a.note.noteId)).parentNoteIds).toEqual([rootId]);
  });
});

describe('deletion on live Trilium', () => {
  it('soft-deletes a subtree and undeletes it', async () => {
    const folder = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Doomed',
      type: 'book',
    });
    const inner = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: folder.note.noteId,
      title: 'Inner',
      content: 'keep me',
      attributes: [{ type: 'label', name: 'marker', value: '1' }],
    });
    await expect(
      live.services.deletion.deleteNote({
        noteId: folder.note.noteId,
        expectedTitle: 'Doomed',
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { descendantCount: 1 } });
    const result = await live.services.deletion.deleteNote({
      noteId: folder.note.noteId,
      expectedTitle: 'Doomed',
      confirm: true,
      deleteDescendants: true,
    });
    expect(result.deleted).toBe(true);
    const gone = await live.client.getNote(inner.note.noteId).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(EtapiError);
    expect((gone as EtapiError).isNotFound).toBe(true);
    const restored = await live.services.deletion.undeleteNote(folder.note.noteId);
    expect(restored.note.noteId).toBe(folder.note.noteId);
    const back = await live.services.notes.get({ noteId: inner.note.noteId, format: 'plain' });
    expect(back.content).toContain('keep me');
    expect(back.note.labels).toContain('#marker=1');
    await expect(live.services.deletion.undeleteNote(folder.note.noteId)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('attachments and binary notes on live Trilium', () => {
  it('round-trips text and binary attachments with hash-protected replacement', async () => {
    const owner = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Owner',
      content: 'has files',
    });
    const csv = await live.services.attachments.create({
      noteId: owner.note.noteId,
      title: 'data.csv',
      mime: 'text/csv',
      content: 'a,b\n1,2',
    });
    const png = await live.services.attachments.create({
      noteId: owner.note.noteId,
      title: 'dot.png',
      mime: 'image/png',
      contentBase64: PNG.toString('base64'),
    });
    expect(png.attachment.role).toBe('image');
    const list = await live.services.attachments.list(owner.note.noteId);
    expect(list.attachments.map((a) => a.title).sort()).toEqual(['data.csv', 'dot.png']);
    const readCsv = await live.services.attachments.get({
      attachmentId: csv.attachment.attachmentId,
    });
    expect(readCsv.content).toBe('a,b\n1,2');
    const readPng = await live.services.attachments.get({
      attachmentId: png.attachment.attachmentId,
    });
    expect(readPng.contentBase64).toBe(PNG.toString('base64'));
    expect(readPng.contentBytes).toBe(PNG.length);
    await expect(
      live.services.attachments.update({
        attachmentId: csv.attachment.attachmentId,
        content: 'x',
        expectedHash: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const replaced = await live.services.attachments.update({
      attachmentId: csv.attachment.attachmentId,
      title: 'data2.csv',
      content: 'a,b\n3,4',
      expectedHash: csv.attachment.contentHash,
    });
    expect(replaced.changed.sort()).toEqual(['content', 'title']);
    expect(replaced.attachment.contentHash).not.toBe(csv.attachment.contentHash);
    const deleted = await live.services.attachments.delete(png.attachment.attachmentId);
    expect(deleted.deleted).toBe(true);
    const after = await live.services.attachments.list(owner.note.noteId);
    expect(after.attachments.map((a) => a.title)).toEqual(['data2.csv']);
  });

  it('creates image notes from base64, reads them back, and replaces them with a revision', async () => {
    const created = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Dot',
      type: 'image',
      mime: 'image/png',
      contentBase64: PNG.toString('base64'),
    });
    const read = await live.services.notes.get({ noteId: created.note.noteId });
    expect(read.contentBase64).toBe(PNG.toString('base64'));
    expect(read.contentBytes).toBe(PNG.length);
    expect(read.note.contentHash).toBe(created.note.contentHash);
    const flipped = Buffer.from(PNG);
    flipped[flipped.length - 1] = 0;
    const patched = await live.services.notes.patch({
      noteId: created.note.noteId,
      expectedHash: created.note.contentHash,
      operation: 'replace',
      contentBase64: flipped.toString('base64'),
    });
    expect(patched.revisionCreated).toBe(true);
    expect(patched.contentHash).not.toBe(created.note.contentHash);
    const again = await live.services.notes.get({ noteId: created.note.noteId });
    expect(again.contentBase64).toBe(flipped.toString('base64'));
    const pdf = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Blank.pdf',
      type: 'file',
      contentBase64: 'data:application/pdf;base64,JVBERi0xLjQK',
    });
    expect(pdf.note.mime).toBe('application/pdf');
    expect((await live.services.notes.get({ noteId: pdf.note.noteId })).contentBase64).toBe(
      'JVBERi0xLjQK',
    );
  });
});

describe('audit regressions R9–R13 on live Trilium', () => {
  it('R9: a same-parent move with fromParentNoteId keeps the note and its child', async () => {
    const p = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'R9P',
      type: 'book',
    });
    const n = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: p.note.noteId,
      title: 'R9N',
    });
    const c = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: n.note.noteId,
      title: 'R9C',
    });
    const result = await live.services.hierarchy.move({
      noteId: n.note.noteId,
      targetParentNoteId: p.note.noteId,
      fromParentNoteId: p.note.noteId,
    });
    expect(result.noop).toBe(true);
    expect((await live.client.getNote(n.note.noteId)).parentNoteIds).toEqual([p.note.noteId]);
    expect((await live.client.getNote(c.note.noteId)).parentNoteIds).toEqual([n.note.noteId]);
  });

  it('R10: a child created while a leaf delete is in flight is not silently deleted', async () => {
    let release!: () => void;
    let hit!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hitPromise = new Promise<void>((r) => (hit = r));
    const client = new TriliumClient({
      baseUrl: live.url,
      token: live.token,
      timeoutMs: 20_000,
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (init?.method === 'DELETE' && /\/notes\/[^/]+$/.test(url)) {
          hit();
          await gate;
        }
        return fetch(input, init);
      },
    });
    const services = createServices({
      client,
      limits: {
        maxWriteContentBytes: 2_000_000,
        defaultReadContentBytes: 256_000,
        maxReadContentBytes: 4_000_000,
        maxSearchLimit: 200,
        maxChildren: 500,
      },
      idempotency: new IdempotencyStore(),
    });
    const race = await services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'Race',
      type: 'book',
    });
    const deletion = services.deletion.deleteNote({
      noteId: race.note.noteId,
      expectedTitle: 'Race',
      confirm: true,
    });
    await hitPromise;
    let created: 'pending' | 'done' | 'failed' = 'pending';
    const creation = services.notes
      .create({ principal: 'itest', parentNoteId: race.note.noteId, title: 'Kid' })
      .then(
        () => (created = 'done'),
        () => (created = 'failed'),
      );
    await new Promise((r) => setTimeout(r, 50));
    expect(created).toBe('pending');
    release();
    expect((await deletion).deleted).toBe(true);
    await creation;
    expect(created).toBe('failed');
    const kids = await live.client.searchNotes({ search: "note.title = 'Kid'" });
    expect(kids.results).toEqual([]);
  });

  it('R11: blank mime/role are refused and the attachment stays readable', async () => {
    const owner = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'R11',
    });
    const att = await live.services.attachments.create({
      noteId: owner.note.noteId,
      title: 'r11.txt',
      mime: 'text/plain',
      content: 'ok',
    });
    for (const bad of [{ mime: '' }, { role: '   ' }]) {
      await expect(
        live.services.attachments.update({ attachmentId: att.attachment.attachmentId, ...bad }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    const read = await live.services.attachments.get({
      attachmentId: att.attachment.attachmentId,
    });
    expect(read.content).toBe('ok');
    expect((await live.services.attachments.list(owner.note.noteId)).attachments).toHaveLength(1);
  });

  it("R13: position 'last' reorders an existing placement", async () => {
    const p = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: rootId,
      title: 'R13P',
      type: 'book',
    });
    const early = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: p.note.noteId,
      title: 'Early',
    });
    const late = await live.services.notes.create({
      principal: 'itest',
      parentNoteId: p.note.noteId,
      title: 'Late',
    });
    const moved = await live.services.hierarchy.move({
      noteId: early.note.noteId,
      targetParentNoteId: p.note.noteId,
      position: 'last',
    });
    expect(moved.noop).toBe(false);
    expect((await live.client.getNote(p.note.noteId)).childNoteIds).toEqual([
      late.note.noteId,
      early.note.noteId,
    ]);
    const back = await live.services.hierarchy.move({
      noteId: early.note.noteId,
      targetParentNoteId: p.note.noteId,
      position: 'first',
    });
    expect(back.noop).toBe(false);
    expect((await live.client.getNote(p.note.noteId)).childNoteIds).toEqual([
      early.note.noteId,
      late.note.noteId,
    ]);
  });
});
