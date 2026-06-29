# entra-mcp-oauth-proxy

A tiny local proxy that lets MCP clients (Claude Code, Claude Desktop, others)
connect to **Microsoft Entra-protected remote MCP servers** that are currently
broken by Entra's OAuth handling. Default config targets the **remote Power BI
MCP server**; it works for any Entra-protected remote MCP server via env vars.

Zero dependencies. One file. Node 18+.

## The problem

Microsoft's remote MCP servers (Power BI, Azure DevOps, Business Central, ...)
follow the MCP spec and send an [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707)
`resource` parameter on their OAuth authorize/token requests. Since a Microsoft
Entra enforcement change around **March 7 2026**, the Entra v2.0 endpoint rejects
any request that carries both `resource` and `scope`:

```
AADSTS9010010: The resource parameter provided in the request doesn't match
with the requested scopes.
```

Entra never implemented RFC 8707, so there is no MCP-client flag that fixes this.
The fix has to happen between the client and Entra: strip the `resource`
parameter. The `scope` (`.../.default`) already encodes the target resource, so
dropping `resource` is safe.

A second, older problem also blocks these servers: Entra does not support OAuth
Dynamic Client Registration (DCR), which Claude's MCP client expects. This setup
sidesteps that by using `mcp-remote` with a pre-registered (static) client ID.

Tracking issue: https://github.com/microsoft/powerbi-modeling-mcp/issues/68
When Microsoft ships a server-side fix, retire this proxy and connect directly.

## How it works

The proxy sits in front of the remote MCP server and:

1. Reverse-proxies all MCP traffic to the upstream server (streaming, so SSE works).
2. Rewrites OAuth discovery so the client talks to the proxy, not Entra directly:
   - serves Protected Resource Metadata (`/.well-known/oauth-protected-resource`)
     with `authorization_servers` and `resource` pointed at the proxy,
   - serves Authorization Server metadata
     (`/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`)
     with `authorization_endpoint`/`token_endpoint` pointed at the proxy,
   - rewrites the `WWW-Authenticate` header on the upstream 401 to advertise the
     proxy's metadata URL.
3. On `/authorize` and `/token`, **deletes the `resource` parameter**, then
   forwards to the real Entra endpoints (discovered from the upstream metadata).

```
Claude  ──>  mcp-remote  ──>  this proxy  ──>  Fabric MCP server
                                  │
                                  └── /authorize, /token (resource stripped) ──> Entra
```

`mcp-remote` runs the client-side OAuth (PKCE + browser sign-in) and supplies the
static client ID.

## Prerequisites

- **Node 18+** (uses the global `fetch`).
- **An Entra app registration** you control (for the static client ID).
- **Tenant admin** must enable the server's feature. For Power BI:
  Power BI Admin Portal → Tenant settings →
  *"Users can use the Power BI Model Context Protocol server endpoint (preview)"*.
  Without it the server returns `-32003 FeatureNotAvailable` (HTTP 403) even after
  a successful login.

### Register the Entra app (one-time)

1. [entra.microsoft.com](https://entra.microsoft.com) → **App registrations** →
   **New registration**. Single tenant. Copy the **Application (client) ID**.
2. **Authentication** → **Add a platform** → **Mobile and desktop applications**
   → add redirect URI: `http://localhost:16661/oauth/callback`
   (must match the `--callback-port` you pass to `mcp-remote`).
3. **API permissions** → **Add a permission** → **Power BI Service** (delegated):
   `Dataset.Read.All`, `Workspace.Read.All`, `Report.Read.All`, `MLModel.Execute.All`.
   Grant admin consent if your tenant requires it.
   (For other servers, add that server's API instead.)

## Run

```bash
node proxy.mjs
```

Listens on `http://localhost:8788`. Leave it running while you use the MCP server.

Config via env:

| var      | default                            | meaning                         |
|----------|------------------------------------|---------------------------------|
| `PORT`   | `8788`                             | local port for this proxy       |
| `UPSTREAM` | `https://api.fabric.microsoft.com` | remote MCP server origin      |
| `MCP_PATH` | `/v1/mcp/powerbi`                | MCP endpoint path on that origin |

Example, Azure DevOps remote MCP:

```bash
UPSTREAM=https://mcp.azure.com MCP_PATH=/the/mcp/path node proxy.mjs
```

## Connect a client

### Claude Code

```bash
claude mcp add powerbi -- npx -y mcp-remote@latest \
  http://localhost:8788/v1/mcp/powerbi \
  --static-oauth-client-info '{"client_id":"YOUR_ENTRA_APP_CLIENT_ID"}' \
  --callback-port 16661
```

Then `/mcp` → `powerbi` → **Authenticate** → sign in. Test:
"What tables are in semantic model <id>?"

### Claude Desktop

Settings → Connectors → Add custom connector:
- URL: `http://localhost:8788/v1/mcp/powerbi`
- (Desktop has its own OAuth client-ID field; the proxy still strips `resource`.)

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `AADSTS9010010` | `resource` reached Entra | client bypassed the proxy — point it at `http://localhost:8788/...`, confirm proxy is running |
| `AADSTS650057 Invalid resource` | Entra app lacks the API permission | add the server's delegated API permission (e.g. Power BI Service) |
| `AADSTS50011` redirect mismatch | callback port not registered | add `http://localhost:<port>/oauth/callback` to the app; keep `--callback-port` matching |
| `-32003 FeatureNotAvailable` (403) | tenant setting disabled | admin enables the server's tenant setting |
| `-32000` / reconnect fails | auth not completed, or stale `mcp-remote` | `pkill -f mcp-remote`, clear `~/.mcp-auth/`, re-auth |
| callback opens on the wrong port | a stale `mcp-remote` holds the port | `pkill -f mcp-remote`, retry |

Proxy logs each `authorize`/`token` (with "resource stripped") and discovery to
stdout. A full success shows `authorize` then `token -> Entra: 200`.

## Security notes

- Binds to `127.0.0.1` only.
- Never stores tokens; it only forwards OAuth requests after deleting `resource`.
  Tokens are minted by Entra and cached by `mcp-remote` under `~/.mcp-auth/`.
- It's a stopgap for a Microsoft-side bug. Remove it once the upstream is fixed.

## License

MIT. See [LICENSE](LICENSE).
