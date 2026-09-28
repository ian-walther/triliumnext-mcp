import { OAuthError } from '@modelcontextprotocol/server';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOidcVerifier,
  createStaticVerifier,
  scopesFromClaims,
} from '../../src/auth/verifier.js';
import type { OidcConfig } from '../../src/config.js';

describe('static verifier', () => {
  const verifier = createStaticVerifier([
    { token: 'abcdefghijklmnop', clientId: 'dev', scopes: ['trilium.read'] },
  ]);
  it('accepts known tokens and rejects others', async () => {
    const info = await verifier.verifyAccessToken('abcdefghijklmnop');
    expect(info.clientId).toBe('dev');
    expect(info.scopes).toEqual(['trilium.read']);
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
    await expect(verifier.verifyAccessToken('abcdefghijklmnoq')).rejects.toBeInstanceOf(OAuthError);
  });
});

describe('oidc verifier', () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let getKey: ReturnType<typeof createLocalJWKSet>;
  const oidc: OidcConfig = {
    issuer: 'https://tenant.auth0.com/',
    audience: 'https://mcp.example.net/trilium/mcp',
    scopeClaims: ['scope', 'permissions'],
    algorithms: ['RS256'],
    authorizationServerUrl: 'https://tenant.auth0.com/',
    clockToleranceSeconds: 5,
  };
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    getKey = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
  });
  const sign = (
    claims: Record<string, unknown>,
    opts: { iss?: string; aud?: string; exp?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.iss ?? oidc.issuer)
      .setAudience(opts.aud ?? oidc.audience)
      .setSubject('user|1')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);

  it('accepts a valid token and maps scopes from scope and permissions claims', async () => {
    const verifier = createOidcVerifier(oidc, { getKey });
    const token = await sign({
      scope: 'openid trilium.read',
      permissions: ['trilium.write', 'other'],
    });
    const info = await verifier.verifyAccessToken(token);
    expect(info.clientId).toBe('user|1');
    expect(info.scopes).toEqual(['trilium.read', 'trilium.write']);
    expect(info.resource?.href).toBe(oidc.audience);
  });
  it('accepts issuer without trailing slash', async () => {
    const verifier = createOidcVerifier(oidc, { getKey });
    const token = await sign({ scope: 'trilium.read' }, { iss: 'https://tenant.auth0.com' });
    await expect(verifier.verifyAccessToken(token)).resolves.toBeTruthy();
  });
  it('rejects wrong audience, wrong issuer and expired tokens', async () => {
    const verifier = createOidcVerifier(oidc, { getKey });
    await expect(
      verifier.verifyAccessToken(await sign({}, { aud: 'https://other' })),
    ).rejects.toBeInstanceOf(OAuthError);
    await expect(
      verifier.verifyAccessToken(await sign({}, { iss: 'https://evil.example/' })),
    ).rejects.toBeInstanceOf(OAuthError);
    await expect(verifier.verifyAccessToken(await sign({}, { exp: '-1m' }))).rejects.toBeInstanceOf(
      OAuthError,
    );
    await expect(verifier.verifyAccessToken('not-a-jwt')).rejects.toBeInstanceOf(OAuthError);
  });
  it('ignores unknown scope values', () => {
    expect(
      scopesFromClaims({ scope: 'openid profile', scp: ['trilium.admin'] }, ['scope', 'scp']),
    ).toEqual(['trilium.admin']);
  });
});
