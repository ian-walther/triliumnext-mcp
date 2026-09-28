import { beforeEach, describe, expect, it } from 'vitest';
import { decodeBinaryInput, isTextMime } from '../../src/domain/binary.js';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { createServices, type Services } from '../../src/domain/services.js';
import { TriliumClient } from '../../src/etapi/client.js';
import { FakeTrilium } from '../helpers/fakeTrilium.js';

/** Typed wrapper so asymmetric matchers can sit inside toMatchObject without `any` leaks. */
const matching = (re: RegExp): string => expect.stringMatching(re) as string;

const limits = {
  maxWriteContentBytes: 10_000,
  defaultReadContentBytes: 4096,
  maxReadContentBytes: 8192,
  maxSearchLimit: 100,
  maxChildren: 100,
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

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
  fake.addNote({ noteId: 'doc', title: 'Doc', parentNoteId: 'root', content: '<p>hi</p>' });
});

describe('decodeBinaryInput', () => {
  it('accepts base64 and data URIs, rejects junk and oversize before decoding', () => {
    expect(decodeBinaryInput('aGVsbG8=', 100, 'x').bytes.toString()).toBe('hello');
    expect(decodeBinaryInput('aGVs\nbG8=', 100, 'x').bytes.toString()).toBe('hello');
    const uri = decodeBinaryInput('data:image/png;base64,' + PNG.toString('base64'), 100, 'x');
    expect(uri.mime).toBe('image/png');
    expect(uri.bytes.equals(PNG)).toBe(true);
    expect(() => decodeBinaryInput('not base64!', 100, 'x')).toThrow(/valid base64/);
    expect(() => decodeBinaryInput('data:text/plain,hello', 100, 'x')).toThrow(/base64/);
    expect(() => decodeBinaryInput('aGVsbG8=', 4, 'x')).toThrow(/limit is 4 bytes/);
    expect(() => decodeBinaryInput('', 4, 'x')).toThrow(/empty/);
  });
  it('classifies text mimes', () => {
    expect(isTextMime('text/csv')).toBe(true);
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('image/svg+xml')).toBe(true);
    expect(isTextMime('image/png')).toBe(false);
    expect(isTextMime('application/pdf')).toBe(false);
  });
});

describe('AttachmentsService', () => {
  it('creates text and binary attachments, lists and reads them back', async () => {
    const text = await services.attachments.create({
      noteId: 'doc',
      title: 'notes.csv',
      mime: 'text/csv',
      content: 'a,b\n1,2',
    });
    expect(text.attachment.role).toBe('file');
    const image = await services.attachments.create({
      noteId: 'doc',
      title: 'pic.png',
      mime: 'image/png',
      contentBase64: PNG.toString('base64'),
    });
    expect(image.attachment.role).toBe('image');
    expect(image.attachment.contentLength).toBe(PNG.length);
    const upload = fake.calls.find((c) => c.method === 'PUT' && /attachments/.test(c.path));
    expect(upload?.contentType).toBe('application/octet-stream');
    const list = await services.attachments.list('doc');
    expect(list.attachments.map((a) => a.title)).toEqual(['notes.csv', 'pic.png']);
    const readText = await services.attachments.get({ attachmentId: text.attachment.attachmentId });
    expect(readText.content).toBe('a,b\n1,2');
    expect(readText.contentBase64).toBeUndefined();
    const readImage = await services.attachments.get({
      attachmentId: image.attachment.attachmentId,
    });
    expect(readImage.isImage).toBe(true);
    expect(readImage.contentBase64).toBe(PNG.toString('base64'));
    expect(readImage.contentBytes).toBe(PNG.length);
  });

  it('takes the mime from a data URI and refuses ambiguous bodies', async () => {
    const created = await services.attachments.create({
      noteId: 'doc',
      title: 'pic.png',
      mime: '',
      contentBase64: 'data:image/png;base64,' + PNG.toString('base64'),
    });
    expect(created.attachment.mime).toBe('image/png');
    await expect(
      services.attachments.create({
        noteId: 'doc',
        title: 'x',
        mime: 'text/plain',
        content: 'a',
        contentBase64: 'YQ==',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.attachments.create({ noteId: 'nope', title: 'x', mime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('omits oversized binary bodies but truncates text', async () => {
    const big = fake.addAttachment({
      ownerId: 'doc',
      title: 'big.bin',
      mime: 'application/octet-stream',
      content: Buffer.alloc(5000, 7),
    });
    const read = await services.attachments.get({ attachmentId: big.attachmentId });
    expect(read.contentBase64).toBeUndefined();
    expect(read.contentOmittedReason).toMatch(/exceeds/);
    expect(read.contentBytes).toBe(5000);
    const whole = await services.attachments.get({
      attachmentId: big.attachmentId,
      maxContentBytes: 8192,
    });
    expect(whole.contentBase64).toHaveLength(Math.ceil(5000 / 3) * 4);
    const text = fake.addAttachment({
      ownerId: 'doc',
      title: 'big.txt',
      mime: 'text/plain',
      content: 'x'.repeat(5000),
    });
    const cut = await services.attachments.get({ attachmentId: text.attachmentId });
    expect(cut.contentTruncated).toBe(true);
    expect(cut.content).toHaveLength(4096);
  });

  it('updates metadata, and replaces content only with the right hash', async () => {
    const created = await services.attachments.create({
      noteId: 'doc',
      title: 'a.txt',
      mime: 'text/plain',
      content: 'v1',
    });
    const id = created.attachment.attachmentId;
    const renamed = await services.attachments.update({ attachmentId: id, title: 'b.txt' });
    expect(renamed.changed).toEqual(['title']);
    expect(renamed.attachment.title).toBe('b.txt');
    await expect(
      services.attachments.update({ attachmentId: id, content: 'v2' }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: matching(/expectedHash/) });
    await expect(
      services.attachments.update({ attachmentId: id, content: 'v2', expectedHash: 'stale' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const replaced = await services.attachments.update({
      attachmentId: id,
      content: 'v2',
      expectedHash: created.attachment.contentHash,
    });
    expect(replaced.changed).toEqual(['content']);
    expect(replaced.previousHash).toBe(created.attachment.contentHash);
    expect(replaced.attachment.contentHash).not.toBe(created.attachment.contentHash);
    expect((await services.attachments.get({ attachmentId: id })).content).toBe('v2');
    await expect(services.attachments.update({ attachmentId: id })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('deletes attachments', async () => {
    const created = await services.attachments.create({
      noteId: 'doc',
      title: 'a.txt',
      mime: 'text/plain',
      content: 'v1',
    });
    const gone = await services.attachments.delete(created.attachment.attachmentId);
    expect(gone.deleted).toBe(true);
    expect((await services.attachments.list('doc')).attachments).toEqual([]);
    await expect(
      services.attachments.delete(created.attachment.attachmentId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('binary notes', () => {
  it('creates an image note from base64, reads it back, and replaces it hash-safely', async () => {
    const created = await services.notes.create({
      principal: 'p',
      parentNoteId: 'root',
      title: 'Photo',
      type: 'image',
      mime: 'image/png',
      contentBase64: PNG.toString('base64'),
    });
    expect(created.contentFormat).toBe('binary');
    const read = await services.notes.get({ noteId: created.note.noteId });
    expect(read.contentBase64).toBe(PNG.toString('base64'));
    expect(read.note.contentHash).toBe(created.note.contentHash);
    const upload = fake.calls.find((c) => c.method === 'PUT' && /notes/.test(c.path));
    expect(upload?.contentType).toBe('application/octet-stream');
    await expect(
      services.notes.patch({
        noteId: created.note.noteId,
        expectedHash: created.note.contentHash,
        operation: 'append',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const next = Buffer.from('new bytes');
    const patched = await services.notes.patch({
      noteId: created.note.noteId,
      expectedHash: created.note.contentHash,
      operation: 'replace',
      contentBase64: next.toString('base64'),
    });
    expect(patched.revisionCreated).toBe(true);
    expect(patched.contentBytes).toBe(next.length);
    expect(patched.contentHash).not.toBe(created.note.contentHash);
    await expect(
      services.notes.patch({
        noteId: created.note.noteId,
        expectedHash: created.note.contentHash,
        operation: 'replace',
        contentBase64: 'AAAA',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // A data: URI can supply the mime for a file note.
    const pdf = await services.notes.create({
      principal: 'p',
      parentNoteId: 'root',
      title: 'Doc.pdf',
      type: 'file',
      contentBase64: 'data:application/pdf;base64,JVBERi0=',
    });
    expect(pdf.note.mime).toBe('application/pdf');
    await expect(
      services.notes.create({
        principal: 'p',
        parentNoteId: 'root',
        title: 'Nope',
        type: 'file',
        contentBase64: 'JVBERi0=',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: matching(/mime/) });
  });

  it('records a checkpoint so a failed upload replays honestly', async () => {
    fake.intercept = (call) =>
      call.method === 'PUT' && /\/content$/.test(call.path)
        ? new Response(JSON.stringify({ status: 500, code: 'GENERIC', message: 'disk full' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : undefined;
    const input = {
      principal: 'p',
      parentNoteId: 'root',
      title: 'Photo',
      type: 'image',
      mime: 'image/png',
      contentBase64: PNG.toString('base64'),
      idempotencyKey: 'photo-upload-1',
    };
    await expect(services.notes.create(input)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: matching(/note exists but is empty/),
    });
    fake.intercept = undefined;
    const replay = await services.notes.create(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.incomplete).toBe(true);
    expect([...fake.notes.values()].filter((n) => n.title === 'Photo')).toHaveLength(1);
  });
});
