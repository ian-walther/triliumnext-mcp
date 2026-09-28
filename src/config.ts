/**
 * Configuration loading and validation.
 *
 * Every knob comes from the environment so the same build runs as a stdio
 * child process, a loopback HTTP dev server, or a container behind a reverse
 * proxy. Validation happens once at startup; a bad value fails fast with a
 * message naming the variable.
 */
import * as z from 'zod/v4';

export const SCOPES = ['trilium.read', 'trilium.write', 'trilium.admin'] as const;
export type Scope = (typeof SCOPES)[number];

export type AuthMode = 'none' | 'static' | 'oidc';

export interface StaticToken {
  token: string;
  clientId: string;
  scopes: Scope[];
}

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  scopeClaims: string[];
  algorithms: string[];
  /** Authorization server metadata URL advertised in protected-resource metadata. */
  authorizationServerUrl: string;
  clockToleranceSeconds: number;
}

export interface AppConfig {
  serverName: string;
  serverVersion: string;
  trilium: {
    baseUrl: string;
    token: string | undefined;
    timeoutMs: number;
    retries: number;
  };
  stdio: {
    scopes: Scope[];
    legacy: 'serve' | 'reject';
  };
  http: {
    host: string;
    port: number;
    path: string;
    publicUrl: string | undefined;
    /** Hostnames accepted in the Host header (always includes loopback names). Empty when allowAnyHost. */
    allowedHosts: string[];
    allowAnyHost: boolean;
    allowedOrigins: string[];
    maxBodyBytes: number;
    rateLimit: { perMinute: number; burst: number };
    legacy: 'stateless' | 'reject';
    trustProxy: boolean;
  };
  auth: {
    mode: AuthMode;
    staticTokens: StaticToken[];
    oidc: OidcConfig | undefined;
    /** Scopes granted to anonymous callers when auth mode is `none`. */
    anonymousScopes: Scope[];
  };
  limits: {
    maxWriteContentBytes: number;
    defaultReadContentBytes: number;
    maxReadContentBytes: number;
    maxSearchLimit: number;
    maxChildren: number;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'pretty';
    auditEnabled: boolean;
    auditPath: string | undefined;
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new ConfigError(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return parsed;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;
  if (/^(true|1|yes|on)$/i.test(raw)) return true;
  if (/^(false|0|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`${name} must be a boolean, got "${raw}"`);
}

function envEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;
  if ((values as readonly string[]).includes(raw)) return raw as T;
  throw new ConfigError(`${name} must be one of ${values.join(', ')}, got "${raw}"`);
}

function envList(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = envString(env, name);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Parse a scope list; accepts space or comma separation and the legacy PERMISSIONS syntax. */
export function parseScopes(raw: string, source: string): Scope[] {
  const tokens = raw
    .split(/[\s,;+]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
  const scopes = new Set<Scope>();
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === 'READ') scopes.add('trilium.read');
    else if (upper === 'WRITE') scopes.add('trilium.write');
    else if (upper === 'ADMIN') scopes.add('trilium.admin');
    else if ((SCOPES as readonly string[]).includes(token)) scopes.add(token as Scope);
    else
      throw new ConfigError(`${source}: unknown scope "${token}" (expected ${SCOPES.join(', ')})`);
  }
  return [...scopes];
}

/**
 * Static token syntax: `token:scope+scope,token2:scope`. Scopes may also be
 * separated by spaces when the whole value is quoted. Client id defaults to
 * `static-<n>`; an explicit id can be given as `id@token:scopes`.
 */
export function parseStaticTokens(raw: string): StaticToken[] {
  const entries = raw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  return entries.map((entry, index) => {
    const colon = entry.indexOf(':');
    if (colon <= 0) {
      throw new ConfigError(
        `MCP_STATIC_TOKENS entry ${index + 1} must look like token:scope+scope (got "${entry.slice(0, 8)}…")`,
      );
    }
    let token = entry.slice(0, colon);
    let clientId = `static-${index + 1}`;
    const at = token.indexOf('@');
    if (at > 0) {
      clientId = token.slice(0, at);
      token = token.slice(at + 1);
    }
    if (token.length < 16) {
      throw new ConfigError(
        `MCP_STATIC_TOKENS entry ${index + 1}: tokens must be at least 16 characters`,
      );
    }
    const scopes = parseScopes(entry.slice(colon + 1), `MCP_STATIC_TOKENS entry ${index + 1}`);
    if (scopes.length === 0) {
      throw new ConfigError(`MCP_STATIC_TOKENS entry ${index + 1} grants no scopes`);
    }
    return { token, clientId, scopes };
  });
}

export function normalizeEtapiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`TRILIUM_API_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`TRILIUM_API_URL must use http or https, got "${url.protocol}"`);
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/etapi')) path = `${path}/etapi`;
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

const urlSchema = z.url();

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  meta: { version?: string } = {},
): AppConfig {
  const triliumUrl = normalizeEtapiUrl(
    envString(env, 'TRILIUM_API_URL') ?? 'http://localhost:8080/etapi',
  );
  const triliumToken = envString(env, 'TRILIUM_API_TOKEN');
  const triliumNoAuth = envBool(env, 'TRILIUM_API_NO_AUTH', false);
  if (!triliumToken && !triliumNoAuth) {
    throw new ConfigError(
      'TRILIUM_API_TOKEN is required (create one in Trilium: Options → ETAPI). Set TRILIUM_API_NO_AUTH=true only for a test instance started with TRILIUM_GENERAL_NOAUTHENTICATION.',
    );
  }

  const scopesRaw =
    envString(env, 'TRILIUM_MCP_SCOPES') ??
    envString(env, 'PERMISSIONS') ??
    'trilium.read trilium.write';
  const stdioScopes = parseScopes(scopesRaw, 'TRILIUM_MCP_SCOPES');

  const host = envString(env, 'MCP_HTTP_HOST') ?? '127.0.0.1';
  const publicUrlRaw = envString(env, 'MCP_PUBLIC_URL');
  if (publicUrlRaw !== undefined && !urlSchema.safeParse(publicUrlRaw).success) {
    throw new ConfigError(`MCP_PUBLIC_URL is not a valid URL: "${publicUrlRaw}"`);
  }
  const path = envString(env, 'MCP_HTTP_PATH') ?? '/mcp';
  if (!path.startsWith('/')) throw new ConfigError('MCP_HTTP_PATH must start with "/"');

  const defaultAuthMode: AuthMode = isLoopbackHost(host) ? 'none' : 'oidc';
  const authMode = envEnum(
    env,
    'MCP_AUTH_MODE',
    ['none', 'static', 'oidc'] as const,
    defaultAuthMode,
  );
  if (
    authMode === 'none' &&
    !isLoopbackHost(host) &&
    !envBool(env, 'MCP_DANGEROUSLY_ALLOW_UNAUTHENTICATED', false)
  ) {
    throw new ConfigError(
      `MCP_AUTH_MODE=none is only allowed when MCP_HTTP_HOST is a loopback address (got "${host}"). Set MCP_AUTH_MODE=oidc or static, or MCP_DANGEROUSLY_ALLOW_UNAUTHENTICATED=true behind an authenticating proxy.`,
    );
  }
  // Host-header allow-list: configured names, the public URL's hostname, and the
  // loopback names (so container health checks work). Off loopback, something
  // beyond loopback must be allowed or nothing behind a proxy would get through.
  const allowAnyHost = envBool(env, 'MCP_ALLOW_ANY_HOST', false);
  const allowedHosts = new Set<string>(envList(env, 'MCP_ALLOWED_HOSTS'));
  if (publicUrlRaw) allowedHosts.add(new URL(publicUrlRaw).hostname);
  if (!isLoopbackHost(host) && allowedHosts.size === 0 && !allowAnyHost) {
    throw new ConfigError(
      `MCP_HTTP_HOST=${host} is not loopback: set MCP_ALLOWED_HOSTS (or MCP_PUBLIC_URL) to the hostname(s) clients use, or MCP_ALLOW_ANY_HOST=true to disable Host validation.`,
    );
  }
  for (const name of LOOPBACK_HOSTS) allowedHosts.add(name);
  // Origin policy: the SDK only validates Origin automatically on loopback binds.
  // Off loopback, default to the same hostnames as the Host allow-list so a page
  // on a foreign origin cannot drive an authenticated session from a browser.
  // Non-browser MCP clients send no Origin and always pass.
  const allowedOrigins = envList(env, 'MCP_ALLOWED_ORIGINS');
  const originsEffective =
    allowedOrigins.length || isLoopbackHost(host) || allowAnyHost
      ? allowedOrigins
      : [...allowedHosts];

  const staticTokensRaw = envString(env, 'MCP_STATIC_TOKENS');
  const staticTokens = staticTokensRaw ? parseStaticTokens(staticTokensRaw) : [];
  if (authMode === 'static' && staticTokens.length === 0) {
    throw new ConfigError('MCP_AUTH_MODE=static requires MCP_STATIC_TOKENS');
  }

  let oidc: OidcConfig | undefined;
  if (authMode === 'oidc') {
    const issuer = envString(env, 'MCP_OIDC_ISSUER');
    const audience = envString(env, 'MCP_OIDC_AUDIENCE') ?? publicUrlRaw;
    if (!issuer)
      throw new ConfigError(
        'MCP_AUTH_MODE=oidc requires MCP_OIDC_ISSUER (e.g. https://your-tenant.us.auth0.com/)',
      );
    if (!urlSchema.safeParse(issuer).success)
      throw new ConfigError(`MCP_OIDC_ISSUER is not a valid URL: "${issuer}"`);
    if (!audience)
      throw new ConfigError('MCP_AUTH_MODE=oidc requires MCP_OIDC_AUDIENCE or MCP_PUBLIC_URL');
    if (!publicUrlRaw)
      throw new ConfigError(
        'MCP_AUTH_MODE=oidc requires MCP_PUBLIC_URL (the externally visible MCP endpoint URL)',
      );
    const jwksUrl = envString(env, 'MCP_OIDC_JWKS_URL');
    if (jwksUrl !== undefined && !urlSchema.safeParse(jwksUrl).success) {
      throw new ConfigError(`MCP_OIDC_JWKS_URL is not a valid URL: "${jwksUrl}"`);
    }
    oidc = {
      issuer,
      audience,
      ...(jwksUrl !== undefined ? { jwksUrl } : {}),
      scopeClaims: envList(env, 'MCP_OIDC_SCOPE_CLAIMS').length
        ? envList(env, 'MCP_OIDC_SCOPE_CLAIMS')
        : ['scope', 'scp', 'permissions'],
      algorithms: envList(env, 'MCP_OIDC_ALGORITHMS').length
        ? envList(env, 'MCP_OIDC_ALGORITHMS')
        : [
            'RS256',
            'RS384',
            'RS512',
            'ES256',
            'ES384',
            'ES512',
            'PS256',
            'PS384',
            'PS512',
            'EdDSA',
          ],
      authorizationServerUrl: envString(env, 'MCP_OIDC_AUTHORIZATION_SERVER') ?? issuer,
      clockToleranceSeconds: envInt(env, 'MCP_OIDC_CLOCK_TOLERANCE_SECONDS', 60),
    };
  }

  const anonymousScopes = parseScopes(
    envString(env, 'MCP_ANONYMOUS_SCOPES') ?? scopesRaw,
    'MCP_ANONYMOUS_SCOPES',
  );

  const isTty = Boolean(process.stderr.isTTY);
  return {
    serverName: envString(env, 'MCP_SERVER_NAME') ?? 'trilium-mcp',
    serverVersion: meta.version ?? '0.0.0',
    trilium: {
      baseUrl: triliumUrl,
      token: triliumToken,
      timeoutMs: envInt(env, 'TRILIUM_API_TIMEOUT_MS', 30_000, 100),
      retries: envInt(env, 'TRILIUM_API_RETRIES', 2),
    },
    stdio: {
      scopes: stdioScopes,
      legacy: envEnum(env, 'MCP_STDIO_LEGACY', ['serve', 'reject'] as const, 'serve'),
    },
    http: {
      host,
      port: envInt(env, 'MCP_HTTP_PORT', 3939, 0),
      path,
      publicUrl: publicUrlRaw,
      allowedHosts: allowAnyHost ? [] : [...allowedHosts],
      allowAnyHost,
      allowedOrigins: originsEffective,
      maxBodyBytes: envInt(env, 'MCP_MAX_BODY_BYTES', 4 * 1024 * 1024, 1024),
      rateLimit: {
        perMinute: envInt(env, 'MCP_RATE_LIMIT_PER_MINUTE', 120, 0),
        burst: envInt(env, 'MCP_RATE_LIMIT_BURST', 30, 1),
      },
      legacy: envEnum(env, 'MCP_HTTP_LEGACY', ['stateless', 'reject'] as const, 'stateless'),
      trustProxy: envBool(env, 'MCP_TRUST_PROXY', false),
    },
    auth: { mode: authMode, staticTokens, oidc, anonymousScopes },
    limits: {
      maxWriteContentBytes: envInt(env, 'MCP_MAX_WRITE_CONTENT_BYTES', 2 * 1024 * 1024, 1024),
      defaultReadContentBytes: envInt(env, 'MCP_DEFAULT_READ_CONTENT_BYTES', 256 * 1024, 1024),
      maxReadContentBytes: envInt(env, 'MCP_MAX_READ_CONTENT_BYTES', 4 * 1024 * 1024, 1024),
      maxSearchLimit: envInt(env, 'MCP_MAX_SEARCH_LIMIT', 200, 1),
      maxChildren: envInt(env, 'MCP_MAX_CHILDREN', 500, 1),
    },
    logging: {
      level: envEnum(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
      format: envEnum(env, 'LOG_FORMAT', ['json', 'pretty'] as const, isTty ? 'pretty' : 'json'),
      auditEnabled: envBool(env, 'MCP_AUDIT_ENABLED', true),
      auditPath: envString(env, 'MCP_AUDIT_LOG_PATH'),
    },
  };
}
