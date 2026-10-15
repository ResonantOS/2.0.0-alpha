// Host-only custody. A binding is operator configuration, never manifest authority.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { sanitizeOpenCodePayload } from './opencode-boundary.mjs';
import { publicHarnessError } from './harness-adapter-contract.mjs';

const MAX_SECRET_BYTES = 8192;
const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });

async function readSecret(source, env) {
  if (!source || Object.keys(source).length !== 1) throw fail('runtime-unavailable');
  let value;
  if (typeof source.env === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(source.env)) value = env[source.env];
  else if (typeof source.file === 'string' && isAbsolute(source.file)) {
    // O_NONBLOCK prevents a substituted FIFO from blocking before fstat.
    const file = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_SECRET_BYTES || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail('runtime-unavailable');
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_SECRET_BYTES) throw fail('runtime-unavailable');
      value = buffer.subarray(0, size).toString('utf8');
    } finally { buffer.fill(0); await file.close(); }
  }
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_SECRET_BYTES) throw fail('runtime-unavailable');
  value = value.trim();
  if (!value || !/^[\x21-\x7e]+$/.test(value)) throw fail('runtime-unavailable');
  return value;
}

function createNativeCustody(nativeRuntime, refreshPolicy) {
  const records = new Map();
  return async function acquireNative(binding, signal) {
    if (!nativeRuntime || !signal || signal.aborted) throw fail('runtime-unavailable');
    const owned = await nativeRuntime.acquire({ signal });
    let record = records.get(owned.epoch);
    if (!record) {
      record = { endpoint: binding.endpoint, token: '', cookie: '', generation: 0, pending: null, forbidden: new Set(), clients: new Set(), signal: owned.signal, alive: true };
      records.set(owned.epoch, record);
      record.remember = value => {
        if (typeof value !== 'string' || !value) return;
        for (const item of [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]) record.forbidden.add(item);
      };
      record.initialized = owned.use(value => {
        if (owned.signal.aborted) throw fail('runtime-unavailable');
        record.token = value.loginToken;
        record.remember(value.loginToken);
        record.remember(`${value.endpoint}/?token=${encodeURIComponent(value.loginToken)}`);
        record.remember(value.providerKey);
      });
      // The stop clock gives an already-owned session one second to cancel.
      // Keep only the shared cookie for that phase; normal lease access is
      // fenced immediately and redaction registrations remain afterward.
      record.clearAfterCleanup = () => {
        if (record.cleanupDeadline) return;
        record.cleanupDeadline = Date.now() + 1000;
        const timer = setTimeout(() => { record.cookie = ''; }, 1000);
        timer.unref?.();
      };
      owned.signal.addEventListener('abort', () => {
        record.alive = false; record.token = ''; records.delete(owned.epoch); record.clearAfterCleanup();
      }, { once: true });
    }
    const client = {}; record.clients.add(client);
    const live = () => { if (!record.alive || record.signal.aborted || !record.clients.size) throw fail('runtime-unavailable'); };
    function makeLease(shared = false) {
      let disposed = false, cleanupUntil = 0;
      const accessSignal = shared ? record.signal : signal;
      const check = () => { live(); if (disposed || accessSignal.aborted) throw fail('runtime-unavailable'); };
      async function waitFor(promise, waiterSignal) {
        const combined = AbortSignal.any([accessSignal, record.signal, ...(waiterSignal ? [waiterSignal] : [])]);
        let abort;
        try {
          check();
          if (combined.aborted) throw fail('runtime-unavailable');
          await Promise.race([promise, new Promise((_, reject) => { abort = () => reject(fail('runtime-unavailable')); combined.addEventListener('abort', abort, { once: true }); })]);
          check();
          if (combined.aborted) throw fail('runtime-unavailable');
        } finally { combined.removeEventListener('abort', abort); }
      }
      const lease = Object.freeze({
        epoch: owned.epoch, signal: owned.signal, deadline: owned.deadline, version: owned.version,
        ready: () => { check(); return owned.ready(); },
        fail: code => { check(); return owned.fail(code); },
        readinessLease() { check(); return makeLease(true); },
        async use(callback) {
          check(); await record.initialized; if (record.pending) await waitFor(record.pending);
          check(); return callback({ endpoint: record.endpoint, authScheme: 'dsh-native-cookie', loginToken: record.token, cookie: record.cookie, generation: record.generation });
        },
        async authenticate(exchange, { signal: waiterSignal, generation, refresh = false } = {}) {
          check(); await record.initialized; check();
          if (refresh && !refreshPolicy(owned.version)) { await owned.fail('runtime-unavailable'); throw fail('runtime-unavailable'); }
          if (record.pending) { await waitFor(record.pending, waiterSignal); return; }
          if ((!refresh && record.cookie) || (refresh && generation < record.generation)) return;
          const operation = Promise.resolve().then(async () => {
            live(); const pair = await exchange({ endpoint: record.endpoint, loginToken: record.token, signal: record.signal }); live();
            record.remember(pair); record.remember(pair.slice(pair.indexOf('=') + 1)); record.cookie = pair; record.generation++;
          });
          record.pending = operation;
          void operation.finally(() => { if (record.pending === operation) record.pending = null; }).catch(() => {});
          await waitFor(operation, waiterSignal);
        },
        remember(value) { check(); record.remember(value); },
        cleanupUse(callback, signal) {
          if (shared || typeof callback !== 'function' || signal?.aborted || !record.cookie ||
              (disposed && Date.now() >= cleanupUntil) ||
              (record.cleanupDeadline && Date.now() >= record.cleanupDeadline)) throw fail('runtime-unavailable');
          return callback(record.cookie);
        },
        sanitize(value) { try { return sanitizeOpenCodePayload(value, [...record.forbidden]); } catch { throw fail('runtime-unavailable'); } },
        async dispose() {
          if (disposed) return; disposed = true;
          if (shared) return;
          cleanupUntil = Date.now() + 1000;
          signal.removeEventListener('abort', disposeOnAbort); record.clients.delete(client);
          if (!record.clients.size) {
            record.alive = false; record.token = ''; records.delete(owned.epoch); record.clearAfterCleanup();
          }
          await owned.release();
        },
      });
      const disposeOnAbort = () => { void lease.dispose(); };
      if (!shared) signal.addEventListener('abort', disposeOnAbort, { once: true });
      return lease;
    }
    const lease = makeLease();
    try { await record.initialized; if (signal.aborted || owned.signal.aborted) throw fail('runtime-unavailable'); return lease; }
    catch (error) { await lease.dispose(); throw error; }
  };
}

const nativeRefreshByVersion = Object.freeze({ '0.1.5-rc.1': false, '0.1.7-rc.2': false, '0.2.0-rc.2': true });
export function createHarnessCredentials({ bindings = [], env = process.env, nativeRuntime, refreshPolicy = version => nativeRefreshByVersion[version] === true } = {}) {
  const acquireNative = createNativeCustody(nativeRuntime, refreshPolicy);
  const approved = new Map();
  for (const binding of structuredClone(bindings)) {
    if (!binding || typeof binding.name !== 'string' || approved.has(binding.name) ||
        !['addonId', 'adapterId', 'authScheme', 'endpoint'].every(key => typeof binding[key] === 'string' && binding[key])) throw fail('permission-denied');
    approved.set(binding.name, binding);
  }
  return Object.freeze({
    async acquire({ addonId, runtime, signal } = {}) {
      const binding = approved.get(runtime?.credentialBinding);
      if (!binding || addonId !== binding.addonId ||
          ['adapterId', 'authScheme', 'endpoint'].some(key => runtime?.[key] !== binding[key])) throw fail('permission-denied');
      if (binding.authScheme === 'dsh-native-cookie') return acquireNative(binding, signal);
      let actionToken;
      try { actionToken = await readSecret(binding.source, env); }
      catch { throw fail('runtime-unavailable'); }
      let disposed = false;
      const forbidden = new Set();
      function remember(value) {
        if (disposed || typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_SECRET_BYTES) throw fail('runtime-unavailable');
        // Reuse #447's recursive key/value sanitizer, including URL/JSON/unicode
        // encodings. Include base64 encodings used by credential headers too.
        forbidden.add(value);
        forbidden.add(Buffer.from(value).toString('base64'));
        forbidden.add(Buffer.from(value).toString('base64url'));
      }
      remember(actionToken);
      return Object.freeze({
        async use(callback) {
          if (disposed) throw fail('runtime-unavailable');
          return callback({ endpoint: binding.endpoint, actionToken });
        },
        remember,
        sanitize(value) {
          try { return sanitizeOpenCodePayload(value, [...forbidden]); }
          catch { throw fail('runtime-unavailable'); }
        },
        // Keep redaction patterns until this lease is collected: late output
        // after revocation must still be safe. Never persist the lease.
        dispose() { disposed = true; actionToken = ''; },
      });
    },
  });
}
