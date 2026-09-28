/**
 * Streamable HTTP transport: one Hono app exposing
 *   POST/GET/DELETE <path>          the MCP endpoint (both protocol eras)
 *   GET /healthz                    liveness + Trilium reachability, no content
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
import { buildServer } from '../mcp/server.js';
import { createVerifier } from '../auth/verifier.js';
import { createRateLimiter } from './rateLimit.js';

export interface HttpTransport {
  app: Hono;
  close(): Promise<void>;
}

export function createHttpTransport(
  ctx: AppContext,
  options: { verifier?: OAuthTokenVerifier } = {},
): HttpTransport {
  const { config, logger, audit, services, client } = ctx;
  const http = config.http;
  const publicUrl = http.publicUrl ? new URL(http.publicUrl) : undefined;
  const resourceMetadataUrl = publicUrl
    ? getOAuthProtectedResourceMetadataUrl(publicUrl)
    : undefined;
  const verifier = options.verifier ?? createVerifier(config.auth);
  const gate = verifier
    ? requireBearerAuth({ verifier, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}) })
    : undefined;
  const limiter = createRateLimiter(http.rateLimit);

  const handler = createMcpHandler(
    ({ era, authInfo }) => {
      const scopes = (authInfo?.scopes ?? []).filter((s): s is Scope =>
        (SCOPES as readonly string[]).includes(s),
      );
      return buildServer({
        name: config.serverName,
        version: config.serverVersion,
        services,
        principal: { id: authInfo?.clientId ?? 'anonymous', scopes, transport: 'http' },
        era,
        audit,
        logger,
      });
    },
    { legacy: http.legacy },
  );

  // Host validation: the SDK app validates automatically on loopback binds; off
  // loopback it validates only when an allow-list is given. `allowAnyHost` passes
  // no list on a non-loopback bind, which disables the check.
  const app = createMcpHonoApp({
    host: http.host,
    maxRequestBodySize: http.maxBodyBytes,
    ...(http.allowAnyHost ? {} : { allowedHosts: http.allowedHosts }),
    ...(http.allowedOrigins.length ? { allowedOrigins: http.allowedOrigins } : {}),
  });

  app.get('/healthz', async (c: Context) => {
    let reachable = false;
    try {
      await client.getAppInfo();
      reachable = true;
    } catch (err) {
      logger.warn('health check: Trilium unreachable', { err });
    }
    return c.json(
      {
        status: reachable ? 'ok' : 'degraded',
        trilium: { reachable },
        version: config.serverVersion,
      },
      reachable ? 200 : 503,
    );
  });

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

  const clientAddress = (c: Context): string => {
    if (http.trustProxy) {
      const fwd = c.req.header('x-forwarded-for');
      if (fwd) return fwd.split(',')[0]!.trim();
    }
    return c.req.header('x-real-ip') ?? 'unknown';
  };

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
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    }
    const rate = limiter.take(
      authInfo.clientId === 'anonymous' ? `ip:${clientAddress(c)}` : `client:${authInfo.clientId}`,
    );
    if (!rate.allowed) {
      return c.json({ error: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds }, 429, {
        'retry-after': String(rate.retryAfterSeconds),
      });
    }
    return handler.fetch(c.req.raw, { authInfo, parsedBody: c.get('parsedBody') });
  });

  return {
    app,
    close: () => handler.close(),
  };
}
