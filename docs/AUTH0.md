# Auth0 as the authorization server

Auth0 is a hosted service; you create a tenant at https://auth0.com (free tier is
ample for one person). This server is only the _resource server_: it verifies
tokens Auth0 issues and never mints any.

## Tenant checklist

1. **API**: Applications → APIs → Create.
   - Identifier (audience): `https://mcp.ianwalther.com/trilium/mcp` (must equal `MCP_PUBLIC_URL`).
   - Signing algorithm: RS256.
   - Enable RBAC and "Add Permissions in the Access Token".
   - Permissions: `trilium.read`, `trilium.write`, `trilium.admin`.
   - Token expiration: 3600 s (or shorter); enable offline access if clients need refresh tokens.
2. **Default audience**: Settings → General → API Authorization Settings →
   Default Audience = the identifier above. MCP clients do not send `audience`;
   without a default, Auth0 issues opaque tokens this server cannot verify.
3. **Dynamic Client Registration** (needed by Claude and ChatGPT connectors
   unless you pre-register clients): Settings → Advanced → enable
   "OIDC Dynamic Application Registration". DCR-created apps are third-party:
   also enable "Promote connections to domain level" for the database
   connection so those apps can log users in, and expect a consent screen on
   first use.
4. **Users**: one user (you). Assign the API permissions to the user (User →
   Permissions) so RBAC puts them in the `permissions` claim.
5. **Grok / clients without DCR**: create a Regular Web Application manually,
   note client id/secret, allow the client's callback URL, and paste the
   credentials into the connector UI.

## Server settings

```
MCP_AUTH_MODE=oidc
MCP_OIDC_ISSUER=https://<tenant>.us.auth0.com/
MCP_PUBLIC_URL=https://mcp.ianwalther.com/trilium/mcp
MCP_OIDC_AUDIENCE=https://mcp.ianwalther.com/trilium/mcp
MCP_OIDC_SCOPE_CLAIMS=scope,permissions
```

The server publishes `/.well-known/oauth-protected-resource/trilium/mcp` with
`authorization_servers: ["https://<tenant>.us.auth0.com/"]`; clients discover
Auth0's endpoints from `https://<tenant>.us.auth0.com/.well-known/openid-configuration`.

## Scripted setup

`scripts/auth0-setup.mjs` creates the API and permissions through the
Management API. It needs a Management API token with `create:resource_servers`
and `update:tenant_settings`:

```bash
AUTH0_DOMAIN=<tenant>.us.auth0.com AUTH0_MGMT_TOKEN=... \
node scripts/auth0-setup.mjs https://mcp.ianwalther.com/trilium/mcp
```

It is idempotent (re-running updates in place) and prints the env values to
paste into the server configuration.

## Verifying a token by hand

```bash
TOKEN=...   # from a client's debug view or a test client
curl -s https://mcp.ianwalther.com/trilium/mcp -X POST \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A `403 insufficient_scope` means the token verified but carries none of the
`trilium.*` scopes: check the RBAC and default-audience settings.
