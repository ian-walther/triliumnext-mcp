import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createOidcVerifier } from '../../src/auth/verifier.js';
import { createHarness, type Harness } from '../helpers/harness.js';

const URL_ = 'http://127.0.0.1:3939/mcp';
let harness: Harness | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await harness?.close();
  harness = undefined;
});

function connect(h: Harness, options: { modern?: boolean; token?: string } = {}): Promise<Client> {
  const client = new Client(
    { name: 'test', version: '1' },
    options.modern ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (options.token) headers.set('authorization', `Bearer ${options.token}`);
      return h.fetch(url, { ...init, headers });
    },
  });
  clients.push(client);
  return client.connect(transport).then(() => client);
}

describe('HTTP transport (auth none, loopback)', () => {
  for (const modern of [false, true]) {
    it(`serves the ${modern ? 'modern' : 'legacy'} era: list, call, error shapes, audit`, async () => {
      harness = createHarness();
      const client = await connect(harness, { modern });
      expect(client.getProtocolEra()).toBe(modern ? 'modern' : 'legacy');
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual([
        'search_notes',
        'resolve_note',
        'get_note',
        'get_note_context',
        'list_children',
        'read_attributes',
        'create_note',
        'patch_note',
        'update_note_metadata',
        'manage_attributes',
      ]);
      const search = tools.tools.find((t) => t.name === 'search_notes')!;
      expect(search.annotations?.readOnlyHint).toBe(true);
      expect(search.outputSchema).toBeDefined();

      const res = await client.callTool({ name: 'get_note', arguments: { noteId: 'plumb' } });
      expect(res.isError).toBeFalsy();
      const structured = res.structuredContent as {
        note: { noteId: string; contentHash: string };
        content: string;
      };
      expect(structured.note.noteId).toBe('plumb');
      expect(structured.content).toBe('<p>Fix the sink</p>');
      expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toEqual(structured);

      const missing = await client.callTool({ name: 'get_note', arguments: { noteId: 'nope' } });
      expect(missing.isError).toBe(true);
      expect((missing.structuredContent as { error: { code: string } }).error.code).toBe(
        'NOT_FOUND',
      );

      const invalid = await client.callTool({ name: 'get_note', arguments: { noteId: '../x' } });
      expect(invalid.isError).toBe(true);

      const patched = await client.callTool({
        name: 'patch_note',
        arguments: {
          noteId: 'plumb',
          expectedHash: structured.note.contentHash,
          operation: 'append',
          content: 'more',
        },
      });
      expect(patched.isError).toBeFalsy();
      expect(harness.fake.notes.get('plumb')?.content).toContain('more');

      const stale = await client.callTool({
        name: 'patch_note',
        arguments: {
          noteId: 'plumb',
          expectedHash: structured.note.contentHash,
          operation: 'replace',
          content: 'x',
        },
      });
      expect(
        (stale.structuredContent as { error: { code: string; details: { currentHash: string } } })
          .error.code,
      ).toBe('CONFLICT');

      expect(harness.audit.map((a) => [a.tool, a.ok, a.principal, a.transport])).toEqual([
        ['get_note', true, 'anonymous', 'http'],
        ['get_note', false, 'anonymous', 'http'],
        ['patch_note', true, 'anonymous', 'http'],
        ['patch_note', false, 'anonymous', 'http'],
      ]);
      expect(harness.audit[0]?.noteIds).toEqual(['plumb']);
      expect(harness.audit[0]?.era).toBe(modern ? 'modern' : 'legacy');
    });
  }

  it('registers only tools the anonymous scopes allow', async () => {
    harness = createHarness({ MCP_ANONYMOUS_SCOPES: 'trilium.read' });
    const client = await connect(harness);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('create_note');
    expect(names).toContain('search_notes');
  });

  it('exposes a health endpoint without note content', async () => {
    harness = createHarness({}, { healthCacheMs: 0 });
    const res = await harness.fetch('http://127.0.0.1:3939/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', trilium: { reachable: true } });
    harness.fake.intercept = () => new Response('down', { status: 503 });
    const down = await harness.fetch('http://127.0.0.1:3939/healthz');
    expect(down.status).toBe(503);
  });

  it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
    harness = createHarness();
    const res = await harness.fetch('http://evil.example/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('accepts the public hostname and loopback on a non-loopback bind', async () => {
    harness = createHarness({
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_PUBLIC_URL: 'https://mcp.example.net/trilium/mcp',
      MCP_AUTH_MODE: 'static',
      MCP_STATIC_TOKENS: 'x@0123456789abcdef:trilium.read',
    });
    const body = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    } as const;
    expect((await harness.fetch('https://mcp.example.net/mcp', body)).status).toBe(401);
    expect((await harness.fetch('http://127.0.0.1:3939/healthz')).status).toBe(200);
    expect((await harness.fetch('http://evil.example/mcp', body)).status).toBe(403);
  });

  it('rate limits per client', async () => {
    harness = createHarness({ MCP_RATE_LIMIT_PER_MINUTE: '60', MCP_RATE_LIMIT_BURST: '2' });
    const client = await connect(harness); // consumes budget during the handshake
    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await harness.fetch(URL_, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }),
      });
      results.push(res.status);
    }
    expect(results).toContain(429);
    await client.close();
  });
});

describe('HTTP transport (static tokens)', () => {
  const RO = 'readonly-token-0123456789';
  const RW = 'readwrite-token-0123456789';
  const env = {
    MCP_AUTH_MODE: 'static',
    MCP_STATIC_TOKENS: `ro@${RO}:trilium.read,rw@${RW}:trilium.read+trilium.write`,
  };

  it('challenges missing/invalid tokens and scopes tool lists per token', async () => {
    harness = createHarness(env);
    const anon = await harness.fetch(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toMatch(/Bearer/);
    const bad = await harness.fetch(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer nope',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(bad.status).toBe(401);

    const ro = await connect(harness, { token: RO });
    expect((await ro.listTools()).tools.map((t) => t.name)).not.toContain('patch_note');
    const rw = await connect(harness, { token: RW, modern: true });
    expect((await rw.listTools()).tools.map((t) => t.name)).toContain('patch_note');
    const res = await rw.callTool({
      name: 'create_note',
      arguments: { parentNoteId: 'projects', title: 'New' },
    });
    expect(res.isError).toBeFalsy();
    expect(harness.audit.at(-1)?.principal).toBe('rw');
  });
});

describe('HTTP transport (oidc)', () => {
  it('verifies JWTs, publishes protected-resource metadata, and maps scopes', async () => {
    const pair = await generateKeyPair('RS256');
    const jwk = await exportJWK(pair.publicKey);
    const getKey = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k', alg: 'RS256' }] });
    const env = {
      MCP_AUTH_MODE: 'oidc',
      MCP_OIDC_ISSUER: 'https://tenant.auth0.com/',
      MCP_PUBLIC_URL: 'https://mcp.example.net/trilium/mcp',
      MCP_OIDC_AUDIENCE: 'https://mcp.example.net/trilium/mcp',
    };
    harness = createHarness(env);
    const verifier = createOidcVerifier(harness.ctx.config.auth.oidc!, { getKey });
    await harness.close();
    harness = createHarness(env, { verifier });

    const prm = await harness.fetch(
      'http://127.0.0.1:3939/.well-known/oauth-protected-resource/trilium/mcp',
    );
    expect(prm.status).toBe(200);
    expect(await prm.json()).toMatchObject({
      resource: 'https://mcp.example.net/trilium/mcp',
      authorization_servers: ['https://tenant.auth0.com/'],
      scopes_supported: ['trilium.read', 'trilium.write', 'trilium.admin'],
    });

    const challenge = await harness.fetch(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.example.net/.well-known/oauth-protected-resource/trilium/mcp"',
    );

    const token = await new SignJWT({ scope: 'trilium.read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer('https://tenant.auth0.com/')
      .setAudience('https://mcp.example.net/trilium/mcp')
      .setSubject('auth0|ian')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
    const client = await connect(harness, { token, modern: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_note');
    expect(names).not.toContain('create_note');
    const res = await client.callTool({ name: 'resolve_note', arguments: { title: 'Garden' } });
    expect((res.structuredContent as { status: string }).status).toBe('resolved');
    expect(harness.audit.at(-1)?.principal).toBe('auth0|ian');
  });
});
