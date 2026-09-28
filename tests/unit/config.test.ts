import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  normalizeEtapiUrl,
  parseScopes,
  parseStaticTokens,
} from '../../src/config.js';

const base = { TRILIUM_API_TOKEN: 'abc' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base, { version: '9.9.9' });
    expect(cfg.trilium.baseUrl).toBe('http://localhost:8080/etapi');
    expect(cfg.stdio.scopes).toEqual(['trilium.read', 'trilium.write']);
    expect(cfg.http.host).toBe('127.0.0.1');
    expect(cfg.auth.mode).toBe('none');
    expect(cfg.serverVersion).toBe('9.9.9');
  });
  it('requires a token unless no-auth is set', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(loadConfig({ TRILIUM_API_NO_AUTH: 'true' }).trilium.token).toBeUndefined();
  });
  it('honours the legacy PERMISSIONS syntax', () => {
    expect(loadConfig({ ...base, PERMISSIONS: 'READ' }).stdio.scopes).toEqual(['trilium.read']);
    expect(loadConfig({ ...base, PERMISSIONS: 'READ;WRITE' }).stdio.scopes).toEqual([
      'trilium.read',
      'trilium.write',
    ]);
    expect(loadConfig({ ...base, TRILIUM_MCP_SCOPES: 'trilium.read' }).stdio.scopes).toEqual([
      'trilium.read',
    ]);
    expect(() => parseScopes('bogus', 'X')).toThrow(/unknown scope/);
  });
  it('refuses unauthenticated non-loopback binds', () => {
    expect(() => loadConfig({ ...base, MCP_HTTP_HOST: '0.0.0.0', MCP_AUTH_MODE: 'none' })).toThrow(
      /loopback/,
    );
    expect(
      loadConfig({
        ...base,
        MCP_HTTP_HOST: '0.0.0.0',
        MCP_AUTH_MODE: 'none',
        MCP_DANGEROUSLY_ALLOW_UNAUTHENTICATED: 'true',
        MCP_ALLOWED_HOSTS: 'mcp.example.net',
      }).auth.mode,
    ).toBe('none');
  });
  it('derives the host allow-list', () => {
    expect(loadConfig(base).http.allowedHosts).toEqual(
      expect.arrayContaining(['127.0.0.1', 'localhost', '::1']),
    );
    expect(() =>
      loadConfig({
        ...base,
        MCP_HTTP_HOST: '0.0.0.0',
        MCP_AUTH_MODE: 'static',
        MCP_STATIC_TOKENS: 'x@0123456789abcdef:trilium.read',
      }),
    ).toThrow(/MCP_ALLOWED_HOSTS/);
    const cfg = loadConfig({
      ...base,
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_AUTH_MODE: 'static',
      MCP_STATIC_TOKENS: 'x@0123456789abcdef:trilium.read',
      MCP_PUBLIC_URL: 'https://mcp.example.net/trilium/mcp',
      MCP_ALLOWED_HOSTS: 'alt.example.net',
    });
    expect(cfg.http.allowedHosts).toEqual(
      expect.arrayContaining(['alt.example.net', 'mcp.example.net', '127.0.0.1']),
    );
    const any = loadConfig({
      ...base,
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_AUTH_MODE: 'static',
      MCP_STATIC_TOKENS: 'x@0123456789abcdef:trilium.read',
      MCP_ALLOW_ANY_HOST: 'true',
    });
    expect(any.http.allowAnyHost).toBe(true);
    expect(any.http.allowedHosts).toEqual([]);
  });
  it('validates oidc settings', () => {
    expect(() => loadConfig({ ...base, MCP_AUTH_MODE: 'oidc' })).toThrow(/MCP_OIDC_ISSUER/);
    const cfg = loadConfig({
      ...base,
      MCP_AUTH_MODE: 'oidc',
      MCP_OIDC_ISSUER: 'https://t.auth0.com/',
      MCP_PUBLIC_URL: 'https://mcp.example.net/trilium/mcp',
    });
    expect(cfg.auth.oidc?.audience).toBe('https://mcp.example.net/trilium/mcp');
    expect(cfg.auth.oidc?.scopeClaims).toEqual(['scope', 'scp']);
  });
  it('parses static tokens', () => {
    expect(() => loadConfig({ ...base, MCP_AUTH_MODE: 'static' })).toThrow(/MCP_STATIC_TOKENS/);
    const tokens = parseStaticTokens(
      'dev@0123456789abcdef:trilium.read+trilium.write,fedcba9876543210x:READ',
    );
    expect(tokens).toEqual([
      { token: '0123456789abcdef', clientId: 'dev', scopes: ['trilium.read', 'trilium.write'] },
      { token: 'fedcba9876543210x', clientId: 'static-2', scopes: ['trilium.read'] },
    ]);
    expect(() => parseStaticTokens('short:trilium.read')).toThrow(/16 characters/);
  });
  it('normalizes the etapi url', () => {
    expect(normalizeEtapiUrl('https://trilium.example.com')).toBe(
      'https://trilium.example.com/etapi',
    );
    expect(normalizeEtapiUrl('https://trilium.example.com/etapi/')).toBe(
      'https://trilium.example.com/etapi',
    );
    expect(() => normalizeEtapiUrl('ftp://x')).toThrow(ConfigError);
  });
});
