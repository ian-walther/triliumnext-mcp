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
   Permissions). With RBAC on, Auth0 puts the _requested_ permissions the user
   holds into the token's `scope` claim; that delegated `scope` is what this
   server authorizes on. The user-wide `permissions` claim is ignored by
   default, so a client only ever gets the scopes it asked for.
5. **Grok / clients without DCR**: create a Regular Web Application manually,
   note client id/secret, allow the client's callback URL, and paste the
   credentials into the connector UI.

## Server settings

```
MCP_AUTH_MODE=oidc
MCP_OIDC_ISSUER=https://<tenant>.us.auth0.com/
MCP_PUBLIC_URL=https://mcp.ianwalther.com/trilium/mcp
MCP_OIDC_AUDIENCE=https://mcp.ianwalther.com/trilium/mcp
# MCP_OIDC_SCOPE_CLAIMS=scope,scp   # default; do not add `permissions` (user-wide, not delegated)
```

The server publishes `/.well-known/oauth-protected-resource/trilium/mcp` with
`authorization_servers: ["https://<tenant>.us.auth0.com/"]`; clients discover
Auth0's endpoints from `https://<tenant>.us.auth0.com/.well-known/openid-configuration`.

## Scripted setup

`scripts/auth0-setup.mjs` does steps 1–3 (and 4 for a user that already
exists) through the Management API. The quickest token: Applications → APIs →
Auth0 Management API → API Explorer → Create & Authorize Test Application,
then copy the token (24 h, all scopes). Delete the "API Explorer Application"
afterwards if you do not want it around:

```bash
AUTH0_DOMAIN=<tenant>.us.auth0.com AUTH0_MGMT_TOKEN=... \
node scripts/auth0-setup.mjs https://mcp.ianwalther.com/trilium/mcp
```

It is idempotent (re-running updates in place), also enables dynamic client
registration, promotes every connection to domain level, disables public
sign-up on the database connection, and prints the env values to paste into
the server configuration. It also adds a user-type client grant to the API
for every dynamically registered client: new tenants put such clients in
Auth0's locked "strict" third-party mode, where `/authorize` fails with
"Oops!, something went wrong" (log: `Client ... is not authorized to access
resource server`) until that grant exists. Connectors register a new client
each time they are added, so rerun the script after adding one. Claude registers a
new client on every Connect attempt, so the workable setup is a first-party
Regular Web Application (created 2026-09-28 as "Claude (trilium-mcp)", client
id `5UOhH9ybinbErvmSTcRZUtCIhRVgYemp`, callback
`https://claude.ai/api/mcp/auth_callback`, `client_secret_post`) whose client
id and secret are entered in the connector's advanced settings. First-party
clients need no grant. The secret lives only in the Auth0 dashboard and in
the connector settings of each client. The same app serves ChatGPT: add the
per-plugin callback ChatGPT shows in its "New Plugin" form
(`https://chatgpt.com/connector/oauth/<id>`) to the app's Allowed Callback
URLs, choose "User-Defined OAuth Client", `client_secret_post`, and note that
a deleted plugin's name stays reserved in ChatGPT.

Grok (grok.com custom connectors) does not work with this tenant as of
2026-09-28: it offers no client id/secret fields, registers a fresh client on
every connect attempt (so a user-type client grant never catches up), and
requests only OIDC profile scopes, never `trilium.*`, so even a granted client
would get a token without tool scopes. Pass `AUTH0_USER_EMAIL` (and
`AUTH0_USER_PERMISSIONS`, default `trilium.read`) to grant permissions to a
user once that user exists. `trilium.admin` unlocks the destructive tools
(`delete_note`, `undelete_note`, `delete_attachment`); grant it to your own
user only, and reconnect the client afterwards so a fresh token carries it.

Tenant as configured on 2026-09-28: `dev-edyrjulnnb8tuhvu.us.auth0.com`, API
identifier `https://trilium-mcp.ianwalther.com/mcp`. The Google connection
uses its own OAuth client ("Auth0 trilium-mcp" in Google Cloud project
`lunar-clone-315216`, consent screen published, redirect URI
`https://dev-edyrjulnnb8tuhvu.us.auth0.com/login/callback`) rather than
Auth0's shared developer keys.

## Verifying a token by hand

```bash
TOKEN=...   # from a client's debug view or a test client
curl -s https://mcp.ianwalther.com/trilium/mcp -X POST \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A `403 insufficient_scope` means the token verified but carries none of the
`trilium.*` scopes in its `scope` claim: the client must request them (they are
advertised in the protected-resource metadata's `scopes_supported`), the user
must hold the matching permissions, and RBAC must be enabled on the API.
