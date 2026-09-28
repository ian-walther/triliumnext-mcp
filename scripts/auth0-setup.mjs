#!/usr/bin/env node
/**
 * Idempotently configure an Auth0 tenant as the authorization server for
 * trilium-mcp:
 *   1. the API (resource server) with the trilium.* permissions, RBAC on,
 *      permissions in the access token, refresh tokens allowed;
 *   2. tenant default audience = that API, and OIDC dynamic client
 *      registration enabled (needed by Claude/ChatGPT connectors);
 *   3. every enabled connection promoted to domain level (DCR-created apps are
 *      third-party and can only use domain-level connections), and public
 *      sign-up disabled on the database connection (single-person tenant);
 *   4. a user-type client grant to the API for every third-party (DCR-created)
 *      client. New tenants run third-party clients in Auth0's "strict" mode,
 *      which refuses /authorize with "Client ... is not authorized to access
 *      resource server" until such a grant exists. Auth0 cannot create it
 *      automatically, so rerun this script whenever a connector re-registers;
 *   5. optionally, grant the trilium.* permissions to one user by email
 *      (AUTH0_USER_EMAIL / AUTH0_USER_PERMISSIONS).
 *
 *   AUTH0_DOMAIN=tenant.us.auth0.com AUTH0_MGMT_TOKEN=... \
 *   [AUTH0_USER_EMAIL=you@example.com] [AUTH0_USER_PERMISSIONS=trilium.read,trilium.write] \
 *   node scripts/auth0-setup.mjs https://mcp.example.net/mcp
 */
import { setTimeout as sleep } from 'node:timers/promises';

const [, , audience] = process.argv;
const domain = process.env.AUTH0_DOMAIN;
const token = process.env.AUTH0_MGMT_TOKEN;
if (!audience || !domain || !token) {
  console.error(
    'usage: AUTH0_DOMAIN=<tenant>.auth0.com AUTH0_MGMT_TOKEN=<token> node scripts/auth0-setup.mjs <audience-url>',
  );
  process.exit(2);
}

const api = async (method, path, body, attempt = 0) => {
  const res = await fetch(`https://${domain}/api/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 429 && attempt < 5) {
    // Free tenants have a small global Management API budget; back off and retry.
    const wait = 2000 * 2 ** attempt;
    console.log(`rate limited on ${method} ${path}; retrying in ${wait / 1000}s`);
    await sleep(wait);
    return api(method, path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
};

const scopes = [
  { value: 'trilium.read', description: 'Search and read Trilium notes' },
  { value: 'trilium.write', description: 'Create and modify Trilium notes and attributes' },
  { value: 'trilium.admin', description: 'Reserved for destructive operations' },
];

// 1. API / resource server
const existing = (await api('GET', '/resource-servers?per_page=100')).find(
  (r) => r.identifier === audience,
);
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

// 2. Tenant settings
await api('PATCH', '/tenants/settings', {
  default_audience: audience,
  flags: { enable_dynamic_client_registration: true },
});
const tenant = await api('GET', '/tenants/settings?fields=default_audience,flags');
console.log(
  `tenant: default_audience=${tenant.default_audience} dynamic_client_registration=${tenant.flags?.enable_dynamic_client_registration}`,
);

// 3. Connections
const connections = await api('GET', '/connections?per_page=100');
for (const c of connections) {
  const patch = { is_domain_connection: true };
  if (c.strategy === 'auth0') patch.options = { ...c.options, disable_signup: true };
  await api('PATCH', `/connections/${c.id}`, patch);
  console.log(
    `connection ${c.name} (${c.strategy}): domain-level${c.strategy === 'auth0' ? ', public sign-up disabled' : ''}`,
  );
}

// 4. Client grants for dynamically registered (third-party) clients
const clients = await api(
  'GET',
  '/clients?per_page=100&fields=client_id,name,is_first_party&include_fields=true',
);
const grants = await api(
  'GET',
  `/client-grants?audience=${encodeURIComponent(audience)}&per_page=100`,
);
for (const c of clients.filter((c) => c.is_first_party === false)) {
  const has = grants.some((g) => g.client_id === c.client_id && g.subject_type === 'user');
  if (!has) {
    await api('POST', '/client-grants', {
      client_id: c.client_id,
      audience,
      subject_type: 'user',
      scope: scopes.map((s) => s.value),
    });
  }
  console.log(
    `third-party client ${c.client_id} (${c.name}): user grant ${has ? 'present' : 'created'}`,
  );
}

// 5. User permissions
const email = process.env.AUTH0_USER_EMAIL;
const users = await api('GET', '/users?per_page=50&fields=user_id,email,name');
console.log(
  `users in tenant: ${users.length ? users.map((u) => u.email ?? u.user_id).join(', ') : '(none yet)'}`,
);
if (email) {
  const user = users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
  if (!user) {
    console.log(
      `user ${email} not found; log in once (or create the user), then rerun with AUTH0_USER_EMAIL`,
    );
  } else {
    const wanted = (process.env.AUTH0_USER_PERMISSIONS ?? 'trilium.read')
      .split(',')
      .map((s) => s.trim());
    await api('POST', `/users/${encodeURIComponent(user.user_id)}/permissions`, {
      permissions: wanted.map((p) => ({
        permission_name: p,
        resource_server_identifier: audience,
      })),
    });
    console.log(`granted ${wanted.join(', ')} to ${email}`);
  }
}

console.log('\nServer configuration:');
console.log(`MCP_AUTH_MODE=oidc`);
console.log(`MCP_OIDC_ISSUER=https://${domain}/`);
console.log(`MCP_PUBLIC_URL=${audience}`);
