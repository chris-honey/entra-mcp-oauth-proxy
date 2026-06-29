// Local OAuth-stripping reverse proxy for the remote Power BI MCP server.
//
// Why this exists: the Fabric remote MCP server follows the MCP spec and sends
// an RFC 8707 `resource` parameter on the OAuth authorize/token requests. Since
// a March 2026 Entra enforcement change, the Entra v2.0 endpoint rejects any
// request carrying both `resource` and `scope` with AADSTS9010010. Entra never
// implemented RFC 8707, so there is no client-side flag to fix it. This proxy
// fronts the MCP server, points OAuth discovery at itself, and deletes the
// `resource` parameter before forwarding the auth requests to Entra. The scope
// (".../.default") already encodes the target resource, so dropping it is safe.
//
// No dependencies. Node 18+ (uses global fetch). Bind localhost only.
//
//   node proxy.mjs
//
// Then point mcp-remote at http://localhost:8788/v1/mcp/powerbi (see README).

import http from 'node:http';

// Defaults target the remote Power BI MCP server. Override via env to point at
// any other Entra-protected remote MCP server (Azure DevOps, Business Central, ...).
//   UPSTREAM   origin of the remote MCP server
//   MCP_PATH   path of the MCP endpoint on that origin
//   PORT       local port for this proxy
const UPSTREAM = process.env.UPSTREAM || 'https://api.fabric.microsoft.com';
const MCP_PATH = process.env.MCP_PATH || '/v1/mcp/powerbi';
const PORT = Number(process.env.PORT || 8788);
const SELF = `http://localhost:${PORT}`;

// Hop-by-hop headers we must not forward.
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

let realAS = null; // cached real Entra AS metadata (authorize/token endpoints)

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Find the upstream Protected Resource Metadata (RFC 9728), trying the
// path-aware location first, then the root.
async function getUpstreamPRM() {
  const candidates = [
    `${UPSTREAM}/.well-known/oauth-protected-resource${MCP_PATH}`,
    `${UPSTREAM}/.well-known/oauth-protected-resource`,
  ];
  let last;
  for (const u of candidates) {
    try { return await fetchJson(u); } catch (e) { last = e; }
  }
  throw last;
}

// From the PRM, discover the real Entra authorization-server metadata
// (authorization_endpoint, token_endpoint, ...).
async function loadRealAS() {
  if (realAS) return realAS;
  const prm = await getUpstreamPRM();
  const issuer = prm.authorization_servers?.[0];
  if (!issuer) throw new Error('PRM has no authorization_servers');
  const base = issuer.replace(/\/$/, '');
  const candidates = [
    `${base}/.well-known/openid-configuration`,
    `${base}/.well-known/oauth-authorization-server`,
  ];
  let last;
  for (const u of candidates) {
    try { realAS = await fetchJson(u); log('discovered real AS:', u); return realAS; }
    catch (e) { last = e; }
  }
  throw last;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

// Serve our rewritten Protected Resource Metadata: same as upstream but the
// authorization server points at this proxy.
async function handlePRM(res) {
  const prm = await getUpstreamPRM();
  prm.authorization_servers = [SELF];
  // The client requires the PRM resource to equal the URL it connected to (this
  // proxy). The resource value only feeds the RFC 8707 `resource` param, which we
  // strip before Entra anyway, so pointing it at the proxy is safe.
  prm.resource = `${SELF}${MCP_PATH}`;
  sendJson(res, 200, prm);
}

// Serve our rewritten Authorization Server metadata: real Entra doc with the
// issuer + authorize/token endpoints swapped to this proxy. registration_endpoint
// is dropped (Entra has no DCR; mcp-remote supplies a static client id instead).
async function handleASMetadata(res) {
  const as = await loadRealAS();
  const meta = { ...as };
  meta.issuer = SELF;
  meta.authorization_endpoint = `${SELF}/authorize`;
  meta.token_endpoint = `${SELF}/token`;
  delete meta.registration_endpoint;
  sendJson(res, 200, meta);
}

// /authorize -> strip `resource`, 302 to the real Entra authorize endpoint.
async function handleAuthorize(req, res) {
  const as = await loadRealAS();
  const incoming = new URL(req.url, SELF);
  incoming.searchParams.delete('resource');
  const target = new URL(as.authorization_endpoint);
  for (const [k, v] of incoming.searchParams) target.searchParams.set(k, v);
  log('authorize -> Entra (resource stripped)');
  res.writeHead(302, { location: target.toString() });
  res.end();
}

// /token -> strip `resource`, forward to the real Entra token endpoint.
async function handleToken(req, res) {
  const as = await loadRealAS();
  const raw = (await readBody(req)).toString('utf8');
  const params = new URLSearchParams(raw);
  params.delete('resource');
  const r = await fetch(as.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: params.toString(),
  });
  const text = await r.text();
  log('token -> Entra (resource stripped):', r.status);
  res.writeHead(r.status, {
    'content-type': r.headers.get('content-type') || 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

// Everything else (the actual MCP traffic) is reverse-proxied to upstream,
// streaming the response so SSE works.
async function handleProxy(req, res) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = new URL(UPSTREAM).host;
  const upstreamUrl = UPSTREAM + req.url;
  const r = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: body && body.length ? body : undefined,
  });
  const respHeaders = {};
  r.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) respHeaders[k] = v; });
  // The upstream 401 advertises its own PRM URL in WWW-Authenticate. Point it at
  // this proxy so the client discovers our rewritten metadata (which sends auth
  // through the proxy), not Entra directly.
  if (respHeaders['www-authenticate']) {
    respHeaders['www-authenticate'] = respHeaders['www-authenticate'].split(UPSTREAM).join(SELF);
  }
  res.writeHead(r.status, respHeaders);
  if (r.body) {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, SELF).pathname;
    if (path.startsWith('/.well-known/oauth-protected-resource')) return await handlePRM(res);
    if (path.startsWith('/.well-known/oauth-authorization-server')
      || path.startsWith('/.well-known/openid-configuration')) return await handleASMetadata(res);
    if (path === '/authorize') return await handleAuthorize(req, res);
    if (path === '/token') return await handleToken(req, res);
    return await handleProxy(req, res);
  } catch (e) {
    log('ERROR', req.method, req.url, '-', e.message);
    if (!res.headersSent) sendJson(res, 502, { error: 'proxy_error', detail: e.message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Power BI MCP OAuth-stripping proxy on ${SELF}`);
  log(`MCP endpoint: ${SELF}${MCP_PATH}`);
});
