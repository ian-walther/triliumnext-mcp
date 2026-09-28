import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTrilium } from '../helpers/fakeTrilium.js';
import { seed } from '../helpers/harness.js';

const DIST = new URL('../../dist/stdio.js', import.meta.url).pathname;

describe.skipIf(!existsSync(DIST))('stdio transport (spawned dist/stdio.js)', () => {
  const fake = new FakeTrilium({ token: 'tok' });
  let baseUrl = '';
  beforeAll(async () => {
    seed(fake);
    baseUrl = await fake.listen();
  });
  afterAll(() => fake.close());

  function spawnClient(env: Record<string, string>, modern: boolean) {
    const client = new Client(
      { name: 'stdio-test', version: '1' },
      modern ? { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } } : {},
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST],
      env: {
        ...process.env,
        TRILIUM_API_URL: baseUrl,
        TRILIUM_API_TOKEN: 'tok',
        LOG_LEVEL: 'error',
        ...env,
      },
      stderr: 'pipe',
    });
    return client.connect(transport).then(() => client);
  }

  it('serves legacy clients (the Claude Code / Codex path today)', async () => {
    const client = await spawnClient({}, false);
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(client.getServerVersion()?.name).toBe('trilium-mcp');
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(15);
      const res = await client.callTool({
        name: 'list_children',
        arguments: { noteId: 'projects' },
      });
      expect(
        (res.structuredContent as { items: Array<{ noteId: string }> }).items.map((i) => i.noteId),
      ).toEqual(['plumb', 'garden']);
    } finally {
      await client.close();
    }
  });

  it('serves modern clients from the same binary', async () => {
    const client = await spawnClient({}, true);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const res = await client.callTool({ name: 'search_notes', arguments: { text: 'tomatoes' } });
      expect(
        (res.structuredContent as { items: Array<{ noteId: string }> }).items.map((i) => i.noteId),
      ).toEqual(['garden']);
    } finally {
      await client.close();
    }
  });

  it('honours read-only scopes via the legacy PERMISSIONS variable', async () => {
    const client = await spawnClient({ PERMISSIONS: 'READ' }, false);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('get_note');
      expect(names).not.toContain('patch_note');
    } finally {
      await client.close();
    }
  });
});
