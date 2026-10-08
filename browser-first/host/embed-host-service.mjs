import http from 'node:http';
import { lstatSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEFAULT_EXTENSION_ID = 'cdpdmmalhmokbfcfgogoepnjplaakgnl';
const BODY_LIMIT = 1024 * 1024;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const SESSION_LIMIT = 64;
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

const disabledService = () => ({ enabled: false, embedRoutes: [], matches: () => false, setPublicOrigin() {}, close() {} });

export function createEmbedHostService({ env = process.env, now = Date.now } = {}) {
  const config = readEmbedHostConfig(env);
  if (!config.enabled) return disabledService();
  try {
    const stat = lstatSync(config.tokenFile);
    if (!stat.isFile() || typeof process.getuid !== 'function' ||
        stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error('Unsafe embed credential file');
    }
  } catch {
    process.stderr.write('Embed service disabled: credential file must be a private regular file owned by the current user.\n');
    return disabledService();
  }
  let token;
  try { token = readFileSync(config.tokenFile, 'utf8').trim(); }
  catch { throw new Error('Invalid embed credential'); }
  if (!token || /[\r\n\x00-\x1f\x7f]/.test(token)) throw new Error('Invalid embed credential');
  const upstream = new URL(config.upstreamUrl);
  const extensionOrigin = `chrome-extension://${config.extensionId}`;
  const prefix = `/embed/${config.profile}/`;
  const tickets = new Map();
  const sessions = new Map();
  const active = new Set();
  let publicOrigin;
  let closed = false;
  const track = resource => {
    active.add(resource);
    resource.once('close', () => active.delete(resource));
    return resource;
  };
  function parseTarget(url) {
    const rawPath = String(url).split('?')[0];
    try {
      const parsed = new URL(url, 'http://embed.invalid');
      const pathname = decodeURIComponent(parsed.pathname);
      const safe = rawPath.startsWith('/') && !rawPath.startsWith('//') &&
        !rawPath.includes('\\') && !/(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c/i.test(rawPath) &&
        !String(url).includes('#');
      return { rawPath, pathname, parsed, safe };
    } catch { return { rawPath, safe: false }; }
  }
  const matches = url => {
    const target = parseTarget(url);
    // The bootstrap route remains capability-gated by the bridge. Everything
    // else in the embed namespace must reach our validation, including paths
    // whose raw spelling or decoded profile prefix is invalid.
    if (target.rawPath === '/embed/session') return false;
    const inNamespace = pathname => /^\/embed(?:[\/\\]|$)/.test(pathname ?? '');
    return !closed && (target.rawPath === '/embed-host/' ||
      inNamespace(target.rawPath) || inNamespace(target.pathname));
  };
  function reject(request, response, status = 403) {
    response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Connection': 'close' });
    // Drain unread bytes while Node flushes the refusal and closes the connection.
    request.resume();
    response.end(status === 413 ? 'Embed request too large' : 'Embed request unavailable');
  }
  function pruneSessions() {
    const time = now();
    for (const [id, expiry] of sessions) if (expiry <= time) sessions.delete(id);
  }
  function authorized(request, upgrade = false) {
    pruneSessions();
    if (!publicOrigin || request.headers.host !== new URL(publicOrigin).host) return false;
    const origin = request.headers.origin;
    if ((upgrade || origin !== undefined) && origin !== publicOrigin) return false;
    const fetchSite = request.headers['sec-fetch-site'];
    if ((!upgrade || fetchSite !== undefined) && fetchSite !== 'same-origin') return false;
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
    if (!result['content-security-policy']) result['content-security-policy'] = `frame-ancestors ${publicOrigin} ${extensionOrigin}`;
    if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
    return result;
  }
  function hostPage(request, response, ticket) {
    const expiry = tickets.get(ticket);
    tickets.delete(ticket);
    if (expiry === undefined || expiry <= now() || !publicOrigin) { reject(request, response); return; }
    const id = opaqueId();
    pruneSessions();
    sessions.set(id, now() + SESSION_TTL);
    if (sessions.size > SESSION_LIMIT) sessions.delete(sessions.keys().next().value);
    const nonce = opaqueId();
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      // WebSocket handshakes from a frame under a chrome-extension:// top level
      // omit SameSite=Strict cookies (observed live); Origin checks still apply.
      'Set-Cookie': `ros_embed=${id}; HttpOnly; Secure; SameSite=None; Path=/embed/`,
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
    if (!publicOrigin) { reject(request, response); return; }
    const target = parseTarget(request.url);
    if (target.rawPath === '/embed-host/') {
      if (request.method !== 'GET' || request.headers.host !== new URL(publicOrigin).host) { reject(request, response); return; }
      hostPage(request, response, new URL(request.url, publicOrigin).searchParams.get('ticket'));
      return;
    }
    if (!target.safe || !target.pathname.startsWith(prefix)) { reject(request, response); return; }
    if (!authorized(request)) { reject(request, response); return; }
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) { reject(request, response, 405); return; }
    const chunks = [];
    let size = 0;
    if (request.method === 'POST') {
      // Buffer at most 1 MiB before opening any upstream connection.
      if (Number(request.headers['content-length']) > BODY_LIMIT) { reject(request, response, 413); return; }
      try {
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > BODY_LIMIT) { reject(request, response, 413); return; }
          chunks.push(chunk);
        }
      } catch { if (!response.destroyed) reject(request, response, 400); return; }
    }
    if (closed) { reject(request, response, 503); return; }
    const headers = requestHeaders(request);
    if (request.method === 'POST') headers['content-length'] = size;
    const outgoing = track(http.request({ hostname: '127.0.0.1', port: upstream.port, path: request.url, method: request.method, headers }, incoming => {
      response.writeHead(incoming.statusCode, responseHeaders(incoming.headers));
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    }));
    outgoing.on('error', () => { if (!response.headersSent && !response.destroyed) reject(request, response, 502); else response.destroy(); });
    response.once('close', () => outgoing.destroy());
    outgoing.end(request.method === 'POST' ? Buffer.concat(chunks) : undefined);
  }
  function handleUpgrade(request, socket, head) {
    pruneSessions();
    if (env.RESONANTOS_EMBED_DEBUG === '1') {
      // Spike diagnostics: booleans and fetch metadata only, never cookie or token values.
      const cookieNames = String(request.headers.cookie ?? '').split(';').map(p => p.trim().split('=')[0]).filter(Boolean);
      const sid = String(request.headers.cookie ?? '').split(';').map(p => p.trim()).find(p => p.startsWith('ros_embed='));
      process.stderr.write(`[embed-debug] upgrade path=${String(request.url).split('?')[0]} hostOk=${request.headers.host === new URL(publicOrigin ?? 'http://x').host} origin=${request.headers.origin} sfs=${request.headers['sec-fetch-site']} cookieNames=${cookieNames.join(',')} sessionKnown=${Boolean(sid && sessions.has(sid.slice(10)))}\n`);
    }
    const target = parseTarget(request.url);
    if (!target.safe || !target.pathname.startsWith(prefix) || !authorized(request, true) || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
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
    outgoing.on('response', response => { if (env.RESONANTOS_EMBED_DEBUG === '1') process.stderr.write(`[embed-debug] upstream refused upgrade status=${response.statusCode}\n`); response.resume(); close(); });
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
