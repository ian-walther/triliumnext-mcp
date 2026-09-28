/**
 * Streamable HTTP transport: one Hono app exposing
 *   POST/GET/DELETE <path>          the MCP endpoint (both protocol eras)
 *   GET /healthz, GET <prefix>/healthz   liveness + cached Trilium reachability, no content
 *   GET /.well-known/oauth-protected-resource[<path>]   RFC 9728 metadata (oidc mode)
 *
 * Auth is a resource-server gate in front of the SDK handler; the handler
 * itself never sees a token, only the verified AuthInfo.
 */
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Context, Hono } from 'hono';
import type { AppContext } from '../app.js';
import { SCOPES, type Scope } from '../config.js';
import { DomainError } from '../domain/errors.js';
import { buildServer } from '../mcp/server.js';
import { principalId, type Principal } from '../mcp/policy.js';
import { createVerifier } from '../auth/verifier.js';
import { createRateLimiter } from './rateLimit.js';

export interface HttpTransport {
  app: Hono;
  close(): Promise<void>;
}

export interface HttpTransportOptions {
  verifier?: OAuthTokenVerifier;
  /** How long one Trilium reachability probe is reused by /healthz. */
  healthCacheMs?: number;
  now?: () => number;
}

/** Health probes are cheap and cannot be used to hammer Trilium: one upstream call per window. */
export const DEFAULT_HEALTH_CACHE_MS = 15_000;

export function createHttpTransport(
  ctx: AppContext,
  options: HttpTransportOptions = {},
): HttpTransport {
  const { config, logger, audit, services, client } = ctx;
  const http = config.http;
  const now = options.now ?? (() => Date.now());
  const publicUrl = http.publicUrl ? new URL(http.publicUrl) : undefined;
  const resourceMetadataUrl = publicUrl
    ? getOAuthProtectedResourceMetadataUrl(publicUrl)
    : undefined;
  const verifier = options.verifier ?? createVerifier(config.auth);
  const gate = verifier
    ? requireBearerAuth({ verifier, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}) })
    : undefined;
  const limiter = createRateLimiter({ ...http.rateLimit, now });

  const handler = createMcpHandler(
    ({ era, authInfo }) => {
      return buildServer({
        name: config.serverName,
        version: config.serverVersion,
        services,
        principal: principalFrom(authInfo),
        era,
        audit,
        logger,
      });
    },
    { legacy: http.legacy, responseMode: http.responseMode },
  );

  // Host validation: the SDK app validates automatically on loopback binds; off
  // loopback it validates only when an allow-list is given. `allowAnyHost` passes
  // no list on a non-loopback bind, which disables the check. Origin validation
  // follows the allow-list derived in config (defaults to the Host allow-list).
  const app = createMcpHonoApp({
    host: http.host,
    maxRequestBodySize: http.maxBodyBytes,
    ...(http.allowAnyHost ? {} : { allowedHosts: http.allowedHosts }),
    ...(http.allowedOrigins.length ? { allowedOrigins: http.allowedOrigins } : {}),
  });

  // Peer address for anonymous rate-limit keys. Forwarding headers are only
  // believed when MCP_TRUST_PROXY is set; otherwise the socket address is used.
  const clientAddress = (c: Context): string => {
    if (http.trustProxy) {
      const fwd = c.req.header('x-forwarded-for');
      if (fwd) return fwd.split(',')[0]!.trim();
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? 'unknown';
  };

  const healthCacheMs = options.healthCacheMs ?? DEFAULT_HEALTH_CACHE_MS;
  let health: { reachable: boolean; checkedAt: number } | undefined;
  let healthProbe: Promise<boolean> | undefined;
  const probeTrilium = async (): Promise<boolean> => {
    if (health && now() - health.checkedAt < healthCacheMs) return health.reachable;
    healthProbe ??= client
      .getAppInfo()
      .then(() => true)
      .catch((err: unknown) => {
        const facts = DomainError.from(err).details;
        logger.warn('health check: Trilium unreachable', {
          etapiCode: facts['etapiCode'],
          upstreamStatus: facts['upstreamStatus'],
        });
        return false;
      })
      .then((reachable) => {
        health = { reachable, checkedAt: now() };
        healthProbe = undefined;
        return reachable;
      });
    return healthProbe;
  };
  const healthz = async (c: Context) => {
    const rate = limiter.take(`health:${clientAddress(c)}`);
    if (!rate.allowed) return rateLimited(c, rate.retryAfterSeconds);
    const reachable = await probeTrilium();
    return c.json(
      {
        status: reachable ? 'ok' : 'degraded',
        trilium: { reachable },
        version: config.serverVersion,
      },
      reachable ? 200 : 503,
    );
  };
  app.get('/healthz', healthz);
  const prefix = http.path.replace(/\/[^/]*$/, '');
  if (prefix && prefix !== '/') app.get(`${prefix}/healthz`, healthz);

  if (config.auth.mode === 'oidc' && config.auth.oidc && publicUrl) {
    const oidc = config.auth.oidc;
    const metadata = {
      resource: publicUrl.href,
      authorization_servers: [oidc.authorizationServerUrl],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: config.serverName,
    };
    const serve = (c: Context) =>
      c.json(metadata, 200, {
        'cache-control': 'public, max-age=300',
        'access-control-allow-origin': '*',
      });
    app.get('/.well-known/oauth-protected-resource', serve);
    app.get(
      `/.well-known/oauth-protected-resource${publicUrl.pathname.replace(/\/+$/, '')}`,
      serve,
    );
  }

  app.all(http.path, async (c: Context) => {
    let authInfo: AuthInfo | undefined;
    if (gate) {
      const verdict = await gate(c.req.raw);
      if (verdict instanceof Response) return verdict;
      authInfo = verdict;
    } else {
      authInfo = {
        token: '',
        clientId: 'anonymous',
        scopes: config.auth.anonymousScopes,
        expiresAt: Math.floor(now() / 1000) + 3600,
      };
    }
    const principal = principalFrom(authInfo);
    const rate = limiter.take(
      principal.clientId === 'anonymous' ? `ip:${clientAddress(c)}` : `principal:${principal.id}`,
    );
    if (!rate.allowed) return rateLimited(c, rate.retryAfterSeconds);
    return handler.fetch(c.req.raw, { authInfo, parsedBody: c.get('parsedBody') });
  });

  return {
    app,
    close: () => handler.close(),
  };
}

function rateLimited(c: Context, retryAfterSeconds: number): Response {
  return c.json({ error: 'rate_limited', retryAfterSeconds }, 429, {
    'retry-after': String(retryAfterSeconds),
  });
}

/** Map verified auth info to a principal: client id plus (when known) the user it acts for. */
export function principalFrom(authInfo: AuthInfo | undefined): Principal {
  const clientId = authInfo?.clientId ?? 'anonymous';
  const subjectRaw = authInfo?.extra?.['subject'];
  const subject = typeof subjectRaw === 'string' ? subjectRaw : undefined;
  const scopes = (authInfo?.scopes ?? []).filter((s): s is Scope =>
    (SCOPES as readonly string[]).includes(s),
  );
  return {
    id: principalId(clientId, subject),
    clientId,
    ...(subject !== undefined ? { subject } : {}),
    scopes,
    transport: 'http',
  };
}
