import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEFAULT_EXTENSION_ID = 'cdpdmmalhmokbfcfgogoepnjplaakgnl';
const BODY_LIMIT = 1024 * 1024;
const opaqueId = () => randomBytes(32).toString('base64url');

// Configuration contains only the credential file location, never its contents.
export function readEmbedHostConfig(env = process.env) {
  if (env.RESONANTOS_EMBED_POC !== '1') return { enabled: false };
  const upstreamUrl = env.RESONANTOS_EMBED_UPSTREAM_URL ?? '';
  const profile = env.RESONANTOS_EMBED_PROFILE ?? '';
  const tokenFile = env.RESONANTOS_EMBED_TOKEN_FILE;
  const extensionId = env.RESONANTOS_EMBED_EXTENSION_ID ?? DEFAULT_EXTENSION_ID;
  const match = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(upstreamUrl);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile) ||
      !/^[a-p]{32}$/.test(extensionId) || typeof tokenFile !== 'string' || !tokenFile.trim()) {
    throw new Error('Invalid embed configuration');
  }
  return { enabled: true, upstreamUrl, profile, tokenFile, extensionId };
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function cleanHeaders(headers) {
  const blocked = new Set([...HOP_HEADERS, ...String(headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

export function createEmbedHostService({ env = process.env, now = Date.now } = {}) {
  const config = readEmbedHostConfig(env);
  if (!config.enabled) return { enabled: false, embedRoutes: [], matches: () => false, setPublicOrigin() {}, close() {} };
  let token;
  try { token = readFileSync(config.tokenFile, 'utf8').trim(); }
  catch { throw new Error('Invalid embed credential'); }
  if (!token || /[\r\n\x00-\x1f\x7f]/.test(token)) throw new Error('Invalid embed credential');
  const upstream = new URL(config.upstreamUrl);
  const extensionOrigin = `chrome-extension://${config.extensionId}`;
  const prefix = `/embed/${config.profile}/`;
  const tickets = new Map();
  const sessions = new Set();
  const active = new Set();
  let publicOrigin;
  let closed = false;
  const track = resource => {
    active.add(resource);
    resource.once('close', () => active.delete(resource));
    return resource;
  };
  const matches = url => !closed && (String(url).split('?')[0] === '/embed-host/' || String(url).startsWith(prefix));
  function reject(response, status = 403) {
    response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.end(status === 413 ? 'Embed request too large' : 'Embed request unavailable');
  }
  function authorized(request, upgrade = false) {
    if (!publicOrigin || request.headers.host !== new URL(publicOrigin).host) return false;
    const origin = request.headers.origin;
    if ((upgrade || origin !== undefined) && origin !== publicOrigin) return false;
    if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) return false;
    const cookies = String(request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('ros_embed='));
    return cookies.length === 1 && sessions.has(cookies[0].slice('ros_embed='.length));
  }
  function requestHeaders(request, upgrade = false) {
    const headers = cleanHeaders(request.headers);
    for (const key of Object.keys(headers)) {
      if (key === 'authorization' || key === 'cookie' || key.startsWith('x-resonantos-') || key.startsWith('proxy-') || key.startsWith('x-forwarded-') || key === 'forwarded') delete headers[key];
    }
    headers.authorization = `Bearer ${token}`;
    headers.host = upstream.host;
    // Validate the browser-facing Origin first; upstream POSTs require it even
    // when the browser omitted it on an otherwise authorized same-origin request.
    headers.origin = publicOrigin;
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }
  function responseHeaders(headers, upgrade = false) {
    const result = cleanHeaders(headers);
    delete result['set-cookie'];
    if (result['content-security-policy']) {
      const rewrite = policy => {
        const directives = String(policy).split(';').map(s => s.trim()).filter(Boolean);
        const ancestor = `frame-ancestors ${publicOrigin} ${extensionOrigin}`;
        let replaced = false;
        const rewritten = directives.map(d => {
          if (!/^frame-ancestors(?:\s|$)/i.test(d)) return d;
          replaced = true;
          return ancestor;
        });
        if (!replaced) rewritten.push(ancestor);
        return rewritten.join('; ');
      };
      result['content-security-policy'] = Array.isArray(result['content-security-policy'])
        ? result['content-security-policy'].map(rewrite) : rewrite(result['content-security-policy']);
    }
    if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
    return result;
  }
  function hostPage(response, ticket) {
    const expiry = tickets.get(ticket);
    tickets.delete(ticket);
    if (expiry === undefined || expiry <= now() || !publicOrigin) { reject(response); return; }
    const id = opaqueId();
    sessions.add(id);
    const nonce = opaqueId();
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Set-Cookie': `ros_embed=${id}; HttpOnly; SameSite=Strict; Path=/`,
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors ${extensionOrigin}`,
    });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Augmentor</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block;overflow:hidden}</style></head><body><iframe title="Augmentor" allow="clipboard-write"></iframe><script nonce="${nonce}">
const iframe = document.querySelector('iframe');
const extensionOrigin = ${JSON.stringify(extensionOrigin)};
const commands = new Set(['augmentor-prompt','augmentor-new-chat','augmentor-focus','augmentor-context']);
window.addEventListener('message', event => {
  if (event.source === iframe.contentWindow && event.origin === location.origin) {
    parent.postMessage(event.data, extensionOrigin);
  } else if (event.source === parent && event.origin === extensionOrigin && commands.has(event.data?.type)) {
    iframe.contentWindow.postMessage(event.data, location.origin);
  }
});
iframe.src = ${JSON.stringify(prefix)};
</script></body></html>`);
  }
  async function handleHttp(request, response) {
    if (String(request.url).split('?')[0] === '/embed-host/') {
      if (request.method !== 'GET' || request.headers.host !== new URL(publicOrigin).host) { reject(response); return; }
      hostPage(response, new URL(request.url, publicOrigin).searchParams.get('ticket'));
      return;
    }
    if (!authorized(request)) { request.resume(); reject(response); return; }
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) { request.resume(); reject(response, 405); return; }
    const chunks = [];
    let size = 0;
    if (request.method === 'POST') {
      // Buffer at most 1 MiB before opening any upstream connection.
      if (Number(request.headers['content-length']) > BODY_LIMIT) { request.resume(); reject(response, 413); return; }
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > BODY_LIMIT) { reject(response, 413); return; }
          chunks.push(chunk);
        }
      } catch { if (!response.destroyed) reject(response, 400); return; }
    }
    if (closed) { reject(response, 503); return; }
    const headers = requestHeaders(request);
    if (request.method === 'POST') headers['content-length'] = size;
    const outgoing = track(http.request({ hostname: '127.0.0.1', port: upstream.port, path: request.url, method: request.method, headers }, incoming => {
      response.writeHead(incoming.statusCode, responseHeaders(incoming.headers));
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    }));
    outgoing.on('error', () => { if (!response.headersSent && !response.destroyed) reject(response, 502); else response.destroy(); });
    response.once('close', () => outgoing.destroy());
    outgoing.end(request.method === 'POST' ? Buffer.concat(chunks) : undefined);
  }
  function handleUpgrade(request, socket, head) {
    if (!String(request.url).startsWith(prefix) || !authorized(request, true) || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    track(socket);
    const outgoing = track(http.request({ hostname: '127.0.0.1', port: upstream.port, path: request.url, headers: requestHeaders(request, true) }));
    let peer;
    const close = () => { socket.destroy(); peer?.destroy(); outgoing.destroy(); };
    socket.on('error', close);
    socket.once('close', close);
    outgoing.on('error', close);
    outgoing.on('response', response => { response.resume(); close(); });
    outgoing.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      peer = track(upstreamSocket);
      if (closed || socket.destroyed) { close(); return; }
      peer.on('error', close);
      peer.once('close', close);
      const headers = responseHeaders(response.headers, true);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(v => `${key}: ${v}\r\n`)).join('')}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
    });
    outgoing.end();
  }
  return {
    enabled: true,
    embedRoutes: [{ method: 'POST', path: '/embed/session', requiredCapability: 'addon-runtime-control', handler: async () => {
      if (closed) throw new Error('Embed service unavailable');
      for (const [ticket, expiry] of tickets) if (expiry <= now()) tickets.delete(ticket);
      const ticket = opaqueId();
      tickets.set(ticket, now() + 60_000);
      return { hostPath: `/embed-host/?ticket=${ticket}` };
    } }],
    matches, handleHttp, handleUpgrade,
    setPublicOrigin(value) { publicOrigin = new URL(value).origin; },
    close() {
      closed = true;
      tickets.clear(); sessions.clear();
      for (const resource of active) resource.destroy();
      active.clear(); token = '';
    },
  };
}
