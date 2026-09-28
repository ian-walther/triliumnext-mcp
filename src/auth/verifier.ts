/**
 * Token verification behind one interface so the HTTP transport does not care
 * whether tokens are static dev tokens or JWTs from an OIDC provider.
 */
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig, OidcConfig, Scope, StaticToken } from '../config.js';
import { SCOPES } from '../config.js';

function invalidToken(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Dev tokens from MCP_STATIC_TOKENS. Never expire, but AuthInfo needs expiresAt, so use a far-future stamp. */
export function createStaticVerifier(tokens: StaticToken[]): OAuthTokenVerifier {
  return {
    verifyAccessToken(token: string): Promise<AuthInfo> {
      const match = tokens.find((t) => safeEqual(t.token, token));
      if (!match) return Promise.reject(invalidToken('Unknown token'));
      return Promise.resolve({
        token,
        clientId: match.clientId,
        scopes: match.scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      });
    },
  };
}

/** Extract scopes from the claims an OIDC provider may use (Auth0: `scope` string + `permissions` array). */
export function scopesFromClaims(payload: JWTPayload, claimNames: string[]): Scope[] {
  const found = new Set<Scope>();
  for (const claim of claimNames) {
    const raw = payload[claim];
    const values: string[] =
      typeof raw === 'string' ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw.map(String) : [];
    for (const v of values) {
      if ((SCOPES as readonly string[]).includes(v)) found.add(v as Scope);
    }
  }
  return SCOPES.filter((s) => found.has(s));
}

export interface OidcVerifierOptions {
  /** Override key resolution (tests inject a local key set). */
  getKey?: JWTVerifyGetKey;
  now?: () => number;
}

export function createOidcVerifier(
  oidc: OidcConfig,
  options: OidcVerifierOptions = {},
): OAuthTokenVerifier {
  const jwksUrl = oidc.jwksUrl ?? `${oidc.issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
  const getKey =
    options.getKey ??
    createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, timeoutDuration: 10_000 });
  // Accept the issuer with and without a trailing slash; providers differ.
  const issuers = [oidc.issuer.replace(/\/+$/, ''), `${oidc.issuer.replace(/\/+$/, '')}/`];
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, getKey, {
          issuer: issuers,
          audience: oidc.audience,
          algorithms: oidc.algorithms,
          clockTolerance: oidc.clockToleranceSeconds,
          ...(options.now ? { currentDate: new Date(options.now()) } : {}),
        });
        payload = result.payload;
      } catch (err) {
        throw invalidToken(`Token rejected: ${(err as Error).message}`);
      }
      if (payload.exp === undefined) throw invalidToken('Token has no expiry');
      const subject =
        payload.sub ??
        (typeof payload['client_id'] === 'string' ? payload['client_id'] : undefined) ??
        (typeof payload['azp'] === 'string' ? payload['azp'] : undefined);
      if (!subject) throw invalidToken('Token has no subject');
      const scopes = scopesFromClaims(payload, oidc.scopeClaims);
      return {
        token,
        clientId: subject,
        scopes,
        expiresAt: payload.exp,
        resource: new URL(oidc.audience),
        extra: { azp: payload['azp'], iss: payload.iss },
      };
    },
  };
}

export function createVerifier(
  config: AppConfig['auth'],
  options: OidcVerifierOptions = {},
): OAuthTokenVerifier | undefined {
  switch (config.mode) {
    case 'none':
      return undefined;
    case 'static':
      return createStaticVerifier(config.staticTokens);
    case 'oidc':
      if (!config.oidc) throw new Error('oidc config missing');
      return createOidcVerifier(config.oidc, options);
    default:
      return undefined;
  }
}
