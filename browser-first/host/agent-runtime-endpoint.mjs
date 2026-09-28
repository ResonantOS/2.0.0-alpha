// Shared outbound harness boundary, extracting the DNS/socket guard concepts
// attributed to #444. No adapter protocol, credential, or grant policy lives here.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicHarnessError } from './harness-adapter-contract.mjs';

const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });
const loopback = address => typeof address === 'string' &&
  (address === '::1' || (isIP(address) === 4 && address.startsWith('127.')));
function check(signal) {
  if (signal?.aborted) throw fail(signal.reason?.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'runtime-unavailable');
}

/**
 * Create a host-only connector from an already authorized binding endpoint.
 * The origin/port are snapshotted; request paths cannot replace that authority.
 * Dependencies are trusted host injections, never manifest/request fields.
 *
 * connectHttp(path, {method, headers, body, signal}, acceptRedirect?) returns a
 * fetch Response. Redirects are manual and rejected by default. The optional
 * host predicate may accept a redirect RESPONSE for protocol inspection; it
 * never follows it. DSH supplies its 303 exchange predicate in its transport.
 *
 * connectWebSocket(path, {headers, signal}, handleSocket) resolves DNS afresh,
 * constructs a redirect-refusing socket, then calls handleSocket synchronously
 * so the caller can install handshake/message/close listeners before any event.
 * The caller owns the socket lifetime and handshake deadline (including abort).
 * Neither method caches DNS; both connect to the validated numeric address.
 */
export function createAgentRuntimeEndpoint({ endpoint, lookup = dnsLookup,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  let origin;
  try { origin = new URL(endpoint); } catch { throw fail('permission-denied'); }
  if (!['http:', 'https:'].includes(origin.protocol) || !origin.port || Number(origin.port) === 0 ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw fail('permission-denied');

  async function resolveEndpoint(path, signal, websocket = false) {
    check(signal);
    // Only origin-relative paths are accepted, including bounded adapter queries.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw fail('permission-denied');
    const url = new URL(path, origin);
    if (url.origin !== origin.origin || url.username || url.password || url.hash) throw fail('permission-denied');
    const host = origin.hostname.replace(/^\[|\]$/g, '');
    const answers = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    check(signal);
    if (!Array.isArray(answers) || !answers.length || answers.some(answer => !loopback(answer?.address))) throw fail('permission-denied');
    // Never send the hostname to a connector: that would permit a second,
    // unvalidated lookup after this check. Scheme and port remain host-approved.
    url.hostname = isIP(answers[0].address) === 6 ? `[${answers[0].address}]` : answers[0].address;
    if (websocket) url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    return url;
  }

  return Object.freeze({
    origin: origin.origin,
    async connectHttp(path, { method = 'GET', headers = {}, body, signal } = {}, acceptRedirect) {
      const url = await resolveEndpoint(path, signal);
      check(signal);
      const response = await fetchImpl(url, { method, headers, body, signal, redirect: 'manual' });
      check(signal);
      if (response.status >= 300 && response.status < 400 && !acceptRedirect?.(response)) {
        await response.body?.cancel();
        throw fail('runtime-unavailable');
      }
      return response;
    },
    async connectWebSocket(path, { headers = {}, signal } = {}, handleSocket) {
      const url = await resolveEndpoint(path, signal, true);
      check(signal);
      // Node's native WebSocket refuses redirects; this explicit option also
      // preserves that policy for a trusted ws-compatible host implementation.
      const socket = new WebSocketImpl(url, { headers, followRedirects: false });
      // Awaited so an asynchronous handler rejection also closes the socket here,
      // not only a synchronous throw (review round 1).
      try { return await handleSocket(socket); }
      catch (error) { socket.close(); throw error; }
    },
  });
}
