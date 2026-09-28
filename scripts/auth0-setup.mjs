#!/usr/bin/env node
/**
 * Idempotently configure an Auth0 tenant as the authorization server for
 * trilium-mcp: creates/updates the API (resource server) with the trilium.*
 * permissions and sets it as the tenant default audience.
 *
 *   AUTH0_DOMAIN=tenant.us.auth0.com AUTH0_MGMT_TOKEN=... \
 *   node scripts/auth0-setup.mjs https://mcp.example.net/trilium/mcp
 */
const [, , audience] = process.argv;
const domain = process.env.AUTH0_DOMAIN;
const token = process.env.AUTH0_MGMT_TOKEN;
if (!audience || !domain || !token) {
  console.error('usage: AUTH0_DOMAIN=<tenant>.auth0.com AUTH0_MGMT_TOKEN=<token> node scripts/auth0-setup.mjs <audience-url>');
  process.exit(2);
}

const api = async (method, path, body) => {
  const res = await fetch(`https://${domain}/api/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
};

const scopes = [
  { value: 'trilium.read', description: 'Search and read Trilium notes' },
  { value: 'trilium.write', description: 'Create and modify Trilium notes and attributes' },
  { value: 'trilium.admin', description: 'Reserved for destructive operations' },
];

const existing = (await api('GET', '/resource-servers?per_page=100')).find((r) => r.identifier === audience);
const definition = {
  name: 'Trilium MCP',
  scopes,
  signing_alg: 'RS256',
  token_lifetime: 3600,
  allow_offline_access: true,
  enforce_policies: true,
  token_dialect: 'access_token_authz',
  skip_consent_for_verifiable_first_party_clients: true,
};
const resourceServer = existing
  ? await api('PATCH', `/resource-servers/${existing.id}`, definition)
  : await api('POST', '/resource-servers', { identifier: audience, ...definition });
console.log(`resource server ${existing ? 'updated' : 'created'}: ${resourceServer.identifier}`);

await api('PATCH', '/tenants/settings', { default_audience: audience });
console.log('tenant default audience set');

console.log('\nServer configuration:');
console.log(`MCP_AUTH_MODE=oidc`);
console.log(`MCP_OIDC_ISSUER=https://${domain}/`);
console.log(`MCP_PUBLIC_URL=${audience}`);
console.log(`MCP_OIDC_AUDIENCE=${audience}`);
console.log('\nRemaining manual steps: enable OIDC Dynamic Application Registration (Settings → Advanced),');
console.log('promote the database connection to domain level, and assign trilium.* permissions to your user.');
