/** HTTP-level regression tests for AUDIT.md findings F01, F09, F10, F11, F12, F15. */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createOidcVerifier } from '../../src/auth/verifier.js';
import { createLogger } from '../../src/logging/logger.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await harness?.close();
  harness = undefined;
});

const jsonPost = (body: unknown, headers: Record<string, string> = {}) =>
  ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  }) as const;
const ping = (id = 1) => ({ jsonrpc: '2.0', id, method: 'ping' });

async function oidcHarness(env: Record<string, string> = {}) {
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  const getKey = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k', alg: 'RS256' }] });
  const base = {
    MCP_AUTH_MODE: 'oidc',
    MCP_OIDC_ISSUER: 'https://tenant.auth0.com/',
    MCP_PUBLIC_URL: 'https://mcp.example.net/trilium/mcp',
    ...env,
  };
  const probe = createHarness(base);
  const verifier = createOidcVerifier(probe.ctx.config.auth.oidc!, { getKey });
  await probe.close();
  const h = createHarness(base, { verifier });
  const sign = (claims: Record<string, unknown>, sub = 'auth0|ian') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer('https://tenant.auth0.com/')
      .setAudience('https://mcp.example.net/trilium/mcp')
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
  return { h, sign };
}

function connect(h: Harness, token?: string): Promise<Client> {
  const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3939/mcp'), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return h.fetch(url, { ...init, headers });
    },
  });
  clients.push(client);
  return client.connect(transport).then(() => client);
}

describe('F01 delegated scopes', () => {
  it('a read-only scope claim cannot see or call write tools even when permissions list write', async () => {
    const { h, sign } = await oidcHarness();
    harness = h;
    const token = await sign({
      scope: 'openid trilium.read',
      permissions: ['trilium.read', 'trilium.write'],
    });
    const client = await connect(h, token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_note');
    expect(names).not.toContain('patch_note');
    const direct = await client
      .callTool({
        name: 'patch_note',
        arguments: { noteId: 'plumb', expectedHash: 'x', operation: 'replace', content: 'x' },
      })
      .catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(Error);
    expect(h.fake.notes.get('plumb')?.content).toBe('<p>Fix the sink</p>');
  });

  it('grants nothing when no delegated-scope claim is present (see R1)', async () => {
    const { h, sign } = await oidcHarness();
    harness = h;
    const client = await connect(h, await sign({ permissions: ['trilium.write'] }));
    expect((await client.listTools()).tools).toEqual([]);
  });
});

describe('F09 audit identity and outcomes', () => {
  it('separates client and subject and keys rate limits by principal', async () => {
    const { h, sign } = await oidcHarness({
      MCP_RATE_LIMIT_PER_MINUTE: '600',
      MCP_RATE_LIMIT_BURST: '3',
    });
    harness = h;
    const a = await connect(h, await sign({ scope: 'trilium.read', azp: 'client-A' }));
    const b = await connect(h, await sign({ scope: 'trilium.read', azp: 'client-B' }));
    await a.callTool({ name: 'get_note', arguments: { noteId: 'plumb' } });
    await b.callTool({ name: 'get_note', arguments: { noteId: 'plumb' } });
    expect(h.audit.map((e) => [e.principal, e.client, e.subject])).toEqual([
      ['client-A:auth0|ian', 'client-A', 'auth0|ian'],
      ['client-B:auth0|ian', 'client-B', 'auth0|ian'],
    ]);
    // Budget was spent by A's handshake+calls; B still has its own bucket.
    const tokenA = await sign({ scope: 'trilium.read', azp: 'client-A' });
    const tokenB = await sign({ scope: 'trilium.read', azp: 'client-B' });
    const codesA: number[] = [];
    for (let i = 0; i < 4; i++)
      codesA.push(
        (
          await h.fetch(
            'http://127.0.0.1:3939/mcp',
            jsonPost(ping(i), { authorization: `Bearer ${tokenA}` }),
          )
        ).status,
      );
    expect(codesA).toContain(429);
    const okB = await h.fetch(
      'http://127.0.0.1:3939/mcp',
      jsonPost(ping(9), { authorization: `Bearer ${tokenB}` }),
    );
    expect(okB.status).not.toBe(429);
  });

  it('records partial and total attribute failures and created note ids', async () => {
    harness = createHarness();
    const client = await connect(harness);
    await client.callTool({
      name: 'manage_attributes',
      arguments: { noteId: 'plumb', operations: [{ action: 'remove', name: 'nope' }] },
    });
    expect(harness.audit.at(-1)).toMatchObject({
      tool: 'manage_attributes',
      ok: false,
      code: 'ALL_FAILED',
    });
    await client.callTool({
      name: 'manage_attributes',
      arguments: {
        noteId: 'plumb',
        operations: [
          { action: 'add', type: 'label', name: 'x' },
          { action: 'remove', name: 'nope' },
        ],
      },
    });
    expect(harness.audit.at(-1)).toMatchObject({ ok: false, code: 'PARTIAL' });
    const created = await client.callTool({
      name: 'create_note',
      arguments: { parentNoteId: 'projects', title: 'Audit me' },
    });
    const id = (created.structuredContent as { note: { noteId: string } }).note.noteId;
    expect(harness.audit.at(-1)).toMatchObject({
      tool: 'create_note',
      ok: true,
      noteIds: ['projects', id],
    });
  });
});

describe('F10 no payloads in logs', () => {
  it('keeps search text out of default-level logs when Trilium fails', async () => {
    const lines: string[] = [];
    harness = createHarness(
      {},
      { logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) },
    );
    harness.fake.intercept = (call) =>
      call.path === '/notes'
        ? new Response(
            JSON.stringify({
              status: 503,
              code: 'GENERIC',
              message: 'failed for PRIVATE_SEARCH_CANARY',
            }),
            { status: 503 },
          )
        : undefined;
    const client = await connect(harness);
    const res = await client.callTool({
      name: 'search_notes',
      arguments: { text: 'PRIVATE_SEARCH_CANARY' },
    });
    expect(res.isError).toBe(true);
    expect(lines.join('\n')).not.toContain('PRIVATE_SEARCH_CANARY');
    expect(lines.some((l) => l.includes('UPSTREAM_UNAVAILABLE'))).toBe(true);
  });
});

describe('F11 health probes and peer identity', () => {
  it('caches the upstream probe and rate limits the health route', async () => {
    let t = 1_000_000;
    harness = createHarness(
      { MCP_RATE_LIMIT_PER_MINUTE: '60', MCP_RATE_LIMIT_BURST: '3' },
      { now: () => t, healthCacheMs: 15_000 },
    );
    const before = harness.fake.calls.length;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await harness.fetch('http://127.0.0.1:3939/healthz')).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses).toContain(429);
    expect(harness.fake.calls.filter((c, i) => i >= before && c.path === '/app-info')).toHaveLength(
      1,
    );
    t += 20_000;
    await harness.fetch('http://127.0.0.1:3939/healthz');
    expect(harness.fake.calls.filter((c, i) => i >= before && c.path === '/app-info')).toHaveLength(
      2,
    );
  });

  it('ignores X-Real-IP / X-Forwarded-For unless the proxy is trusted', async () => {
    harness = createHarness({ MCP_RATE_LIMIT_PER_MINUTE: '60', MCP_RATE_LIMIT_BURST: '1' });
    const first = await harness.fetch(
      'http://127.0.0.1:3939/mcp',
      jsonPost(ping(1), { 'x-real-ip': '1.1.1.1' }),
    );
    const second = await harness.fetch(
      'http://127.0.0.1:3939/mcp',
      jsonPost(ping(2), { 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }),
    );
    expect(first.status).not.toBe(429);
    expect(second.status).toBe(429);
    await harness.close();
    harness = createHarness({
      MCP_RATE_LIMIT_PER_MINUTE: '60',
      MCP_RATE_LIMIT_BURST: '1',
      MCP_TRUST_PROXY: 'true',
    });
    expect(
      (
        await harness.fetch(
          'http://127.0.0.1:3939/mcp',
          jsonPost(ping(1), { 'x-forwarded-for': '1.1.1.1' }),
        )
      ).status,
    ).not.toBe(429);
    expect(
      (
        await harness.fetch(
          'http://127.0.0.1:3939/mcp',
          jsonPost(ping(2), { 'x-forwarded-for': '2.2.2.2' }),
        )
      ).status,
    ).not.toBe(429);
    expect(
      (
        await harness.fetch(
          'http://127.0.0.1:3939/mcp',
          jsonPost(ping(3), { 'x-forwarded-for': '2.2.2.2' }),
        )
      ).status,
    ).toBe(429);
  });
});

describe('F12 Origin policy off loopback', () => {
  const env = {
    MCP_HTTP_HOST: '0.0.0.0',
    MCP_PUBLIC_URL: 'https://mcp.example.net/trilium/mcp',
    MCP_HTTP_PATH: '/trilium/mcp',
    MCP_AUTH_MODE: 'static',
    MCP_STATIC_TOKENS: 'x@0123456789abcdef:trilium.read',
  };
  it('rejects foreign origins, accepts the public origin, and passes requests without Origin', async () => {
    harness = createHarness(env);
    const url = 'https://mcp.example.net/trilium/mcp';
    const auth = { authorization: 'Bearer 0123456789abcdef' };
    expect(
      (await harness.fetch(url, jsonPost(ping(), { ...auth, origin: 'https://untrusted.example' })))
        .status,
    ).toBe(403);
    expect(
      (await harness.fetch(url, jsonPost(ping(), { ...auth, origin: 'https://mcp.example.net' })))
        .status,
    ).not.toBe(403);
    expect((await harness.fetch(url, jsonPost(ping(), auth))).status).not.toBe(403);
    expect(
      (await harness.fetch(url, jsonPost(ping(), { ...auth, origin: 'not a url' }))).status,
    ).toBe(403);
  });
});

describe('F15 health under the proxied prefix', () => {
  it('serves /healthz and <prefix>/healthz', async () => {
    harness = createHarness({ MCP_HTTP_PATH: '/trilium/mcp' });
    expect((await harness.fetch('http://127.0.0.1:3939/trilium/healthz')).status).toBe(200);
    expect((await harness.fetch('http://127.0.0.1:3939/healthz')).status).toBe(200);
  });
});
