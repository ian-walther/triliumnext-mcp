/** HTTP-level regressions for the second audit pass (R1, R6). */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createOidcVerifier, scopesFromClaims } from '../../src/auth/verifier.js';
import { loadConfig } from '../../src/config.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await harness?.close();
  harness = undefined;
});

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
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer('https://tenant.auth0.com/')
      .setAudience('https://mcp.example.net/trilium/mcp')
      .setSubject('auth0|ian')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
  return { h, sign };
}

function connect(h: Harness, token?: string, modern = true): Promise<Client> {
  const client = new Client(
    { name: 't', version: '1' },
    modern ? { versionNegotiation: { mode: 'auto' } } : {},
  );
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

describe('R1 no fallback to user-wide permissions', () => {
  it('default claim list is delegated scopes only', () => {
    expect(
      loadConfig({
        TRILIUM_API_TOKEN: 'x',
        MCP_AUTH_MODE: 'oidc',
        MCP_OIDC_ISSUER: 'https://t.auth0.com/',
        MCP_PUBLIC_URL: 'https://m.example/mcp',
      }).auth.oidc?.scopeClaims,
    ).toEqual(['scope', 'scp']);
    const defaults = ['scope', 'scp'];
    expect(scopesFromClaims({ permissions: ['trilium.read', 'trilium.write'] }, defaults)).toEqual(
      [],
    );
    expect(scopesFromClaims({ scope: null, permissions: ['trilium.write'] }, defaults)).toEqual([]);
    expect(scopesFromClaims({ scope: '', permissions: ['trilium.write'] }, defaults)).toEqual([]);
    expect(scopesFromClaims({ scope: 42, permissions: ['trilium.write'] }, defaults)).toEqual([]);
    expect(scopesFromClaims({ scope: 'trilium.write' }, defaults)).toEqual(['trilium.write']);
  });

  it('tokens without a delegated-scope claim get no tools even with write permissions', async () => {
    const { h, sign } = await oidcHarness();
    harness = h;
    for (const claims of [
      { permissions: ['trilium.read', 'trilium.write'] },
      { scope: null, permissions: ['trilium.write'] },
      { scope: '', permissions: ['trilium.write'] },
    ]) {
      const client = await connect(h, await sign(claims));
      expect((await client.listTools()).tools).toEqual([]);
      const direct = await client
        .callTool({
          name: 'patch_note',
          arguments: { noteId: 'plumb', expectedHash: 'x', operation: 'replace', content: 'x' },
        })
        .catch((e: unknown) => e);
      expect(direct).toBeInstanceOf(Error);
    }
    expect(h.fake.notes.get('plumb')?.content).toBe('<p>Fix the sink</p>');
  });

  it('read-only delegation stays read-only; delegated write works; custom claims need explicit config', async () => {
    const { h, sign } = await oidcHarness();
    harness = h;
    expect(
      (
        await (
          await connect(h, await sign({ scope: 'trilium.read', permissions: ['trilium.write'] }))
        ).listTools()
      ).tools.map((t) => t.name),
    ).not.toContain('patch_note');
    expect(
      (
        await (await connect(h, await sign({ scope: 'trilium.read trilium.write' }))).listTools()
      ).tools.map((t) => t.name),
    ).toContain('patch_note');
    await h.close();
    const custom = await oidcHarness({ MCP_OIDC_SCOPE_CLAIMS: 'scope,permissions' });
    harness = custom.h;
    expect(
      (
        await (
          await connect(custom.h, await custom.sign({ permissions: ['trilium.write'] }))
        ).listTools()
      ).tools.map((t) => t.name),
    ).toContain('patch_note');
  });
});

describe('R6 schema-rejected calls are audited', () => {
  for (const modern of [true, false]) {
    it(`records INVALID_ARGUMENTS with principal and safe metadata (${modern ? 'modern' : 'legacy'} era)`, async () => {
      harness = createHarness({
        MCP_AUTH_MODE: 'static',
        MCP_STATIC_TOKENS: 'dev@0123456789abcdef:trilium.read+trilium.write',
      });
      const client = await connect(harness, '0123456789abcdef', modern);
      const res = await client.callTool({
        name: 'get_note',
        arguments: { noteId: 'SECRET-PAYLOAD/../x', maxContentBytes: 1 },
      });
      expect(res.isError).toBe(true);
      const rejected = harness.audit.filter((e) => e.code === 'INVALID_ARGUMENTS');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        tool: 'get_note',
        principal: 'dev',
        client: 'dev',
        ok: false,
        transport: 'http',
        era: modern ? 'modern' : 'legacy',
      });
      expect(rejected[0]!.details).toEqual({
        invalidFields: ['maxContentBytes', 'noteId'],
        issueCount: 2,
      });
      expect(JSON.stringify(harness.audit)).not.toContain('SECRET-PAYLOAD');
      const valid = await client.callTool({ name: 'get_note', arguments: { noteId: 'plumb' } });
      expect(valid.isError).toBeFalsy();
      expect(harness.audit.filter((e) => e.tool === 'get_note')).toHaveLength(2);
      const tools = (await client.listTools()).tools;
      expect(tools.find((t) => t.name === 'get_note')?.inputSchema).toMatchObject({
        type: 'object',
        required: ['noteId'],
      });
    });
  }
});
