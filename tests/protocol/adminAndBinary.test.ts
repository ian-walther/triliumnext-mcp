/** Admin-scope gating, binary content blocks, and audit ids for the v2.1 tools over HTTP. */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';

const URL_ = 'http://127.0.0.1:3939/mcp';
let harness: Harness | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await harness?.close();
  harness = undefined;
});

function connect(h: Harness): Promise<Client> {
  const client = new Client(
    { name: 'test', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: (url, init) => h.fetch(url, init),
  });
  clients.push(client);
  return client.connect(transport).then(() => client);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('admin scope', () => {
  it('lists destructive tools only with trilium.admin and audits dry runs and deletes', async () => {
    harness = createHarness({ MCP_ANONYMOUS_SCOPES: 'trilium.read trilium.write' });
    const rw = await connect(harness);
    const rwTools = (await rw.listTools()).tools.map((t) => t.name);
    expect(rwTools).not.toContain('delete_note');
    expect(rwTools).not.toContain('undelete_note');
    expect(rwTools).not.toContain('delete_attachment');
    await rw.close();
    await harness.close();

    harness = createHarness({ MCP_ANONYMOUS_SCOPES: 'trilium.read trilium.write trilium.admin' });
    const admin = await connect(harness);
    const tools = (await admin.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names.slice(-3)).toEqual(['delete_note', 'undelete_note', 'delete_attachment']);
    const del = tools.find((t) => t.name === 'delete_note')!;
    expect(del.annotations?.destructiveHint).toBe(true);

    const dry = await admin.callTool({
      name: 'delete_note',
      arguments: { noteId: 'plumb', expectedTitle: 'Plumbing', confirm: true, dryRun: true },
    });
    expect(dry.isError).toBeFalsy();
    expect(dry.structuredContent).toMatchObject({ deleted: false, dryRun: true });
    expect(harness.fake.notes.has('plumb')).toBe(true);

    const wrongTitle = await admin.callTool({
      name: 'delete_note',
      arguments: { noteId: 'plumb', expectedTitle: 'Plumbing!', confirm: true },
    });
    expect(wrongTitle.isError).toBe(true);
    expect(wrongTitle.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });

    const deleted = await admin.callTool({
      name: 'delete_note',
      arguments: { noteId: 'plumb', expectedTitle: 'Plumbing', confirm: true },
    });
    expect(deleted.structuredContent).toMatchObject({ deleted: true, undeletable: true });
    expect(harness.fake.notes.has('plumb')).toBe(false);

    const restored = await admin.callTool({
      name: 'undelete_note',
      arguments: { noteId: 'plumb' },
    });
    expect(restored.structuredContent).toMatchObject({ note: { noteId: 'plumb' } });
    expect(harness.fake.notes.has('plumb')).toBe(true);

    const codes = harness.audit
      .filter((e) => e.tool === 'delete_note' || e.tool === 'undelete_note')
      .map((e) => [e.tool, e.ok, e.code ?? null]);
    expect(codes).toEqual([
      ['delete_note', false, 'DRY_RUN'],
      ['delete_note', false, 'CONFLICT'],
      ['delete_note', true, null],
      ['undelete_note', true, null],
    ]);
  });
});

describe('binary content over the wire', () => {
  it('returns image attachments as an image block and audits the owning note', async () => {
    harness = createHarness();
    const client = await connect(harness);
    const created = await client.callTool({
      name: 'create_attachment',
      arguments: {
        noteId: 'plumb',
        title: 'sink.png',
        mime: 'image/png',
        contentBase64: PNG.toString('base64'),
      },
    });
    expect(created.isError).toBeFalsy();
    const attachmentId = (created.structuredContent as { attachment: { attachmentId: string } })
      .attachment.attachmentId;

    const read = await client.callTool({ name: 'get_attachment', arguments: { attachmentId } });
    expect(read.isError).toBeFalsy();
    const blocks = read.content as Array<{ type: string; mimeType?: string; data?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(blocks[1]).toMatchObject({ mimeType: 'image/png', data: PNG.toString('base64') });
    expect(read.structuredContent).toMatchObject({ isImage: true, contentBytes: PNG.length });

    const listed = await client.callTool({
      name: 'list_attachments',
      arguments: { noteId: 'plumb' },
    });
    expect(listed.structuredContent).toMatchObject({
      attachments: [{ title: 'sink.png', role: 'image' }],
    });

    const audit = harness.audit.filter((e) => /attachment/.test(e.tool));
    expect(audit.map((e) => [e.tool, e.noteIds])).toEqual([
      ['create_attachment', ['plumb']],
      ['get_attachment', ['plumb']],
      ['list_attachments', ['plumb']],
    ]);
  });

  it('creates image notes from base64 and get_note adds an image block', async () => {
    harness = createHarness();
    const client = await connect(harness);
    const created = await client.callTool({
      name: 'create_note',
      arguments: {
        parentNoteId: 'projects',
        title: 'Photo',
        type: 'image',
        mime: 'image/png',
        contentBase64: PNG.toString('base64'),
      },
    });
    expect(created.isError).toBeFalsy();
    const noteId = (created.structuredContent as { note: { noteId: string } }).note.noteId;
    const read = await client.callTool({ name: 'get_note', arguments: { noteId } });
    const blocks = read.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(read.structuredContent).toMatchObject({ contentBase64: PNG.toString('base64') });

    const rejected = await client.callTool({
      name: 'create_note',
      arguments: { parentNoteId: 'projects', title: 'Bad', type: 'image', contentBase64: '***' },
    });
    expect(rejected.isError).toBe(true);
    expect(harness.audit.at(-1)).toMatchObject({ tool: 'create_note', code: 'INVALID_ARGUMENTS' });
  });

  it('moves notes and records both parents in the audit trail', async () => {
    harness = createHarness();
    const client = await connect(harness);
    harness.fake.addNote({
      noteId: 'archive',
      title: 'Archive',
      type: 'book',
      parentNoteId: 'root',
    });
    const moved = await client.callTool({
      name: 'move_note',
      arguments: { noteId: 'plumb', targetParentNoteId: 'archive' },
    });
    expect(moved.isError).toBeFalsy();
    expect(moved.structuredContent).toMatchObject({
      mode: 'move',
      branch: { parentNoteId: 'archive' },
      removedBranch: { parentNoteId: 'projects' },
    });
    expect(harness.audit.at(-1)).toMatchObject({
      tool: 'move_note',
      ok: true,
      noteIds: ['plumb', 'archive', 'projects'],
    });
  });
});
